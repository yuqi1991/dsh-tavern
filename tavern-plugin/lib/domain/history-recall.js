import { createHash } from 'node:crypto'

// History recall (tavern_recall_history): the model looks up the original words of a floor, by keyword
// or by floor number. The floors come from the Session log through Floor Projection
// (projectFloorTexts): the player's input and the current variant's body of every committed floor,
// including floors a compaction folded into a summary. This module holds no copy of the story and
// never writes the log or the surface; the only state it touches is the Chat's cooldown record.

/** Most characters of floor text one read returns; the rest is left out with a notice. */
export const HISTORY_RECALL_READ_CHARS = 12000
/** Most characters one keyword hit returns per message (input or body). */
export const HISTORY_RECALL_HIT_CHARS = 420
/** Keywords whose floor spread is listed (the search itself uses all of them). */
const SPREAD_TERMS = 8
const MAX_QUERY_CHARS = 200

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function searchable(value) {
  return str(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function termsOf(query) {
  return Array.from(new Set(str(query).toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) || []))
}

function excerpt(text, terms, maximum = 240) {
  const source = str(text).replace(/\s+/g, ' ').trim()
  if (source.length <= maximum) return source
  const lower = source.toLocaleLowerCase()
  let found = -1
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index >= 0 && (found < 0 || index < found)) found = index
  }
  const start = Math.max(0, (found < 0 ? 0 : found) - Math.floor(maximum / 3))
  const end = Math.min(source.length, start + maximum)
  return (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '')
}

// Like grep's context lines: a short window around every hit, nearby hits merged, at most `count` windows.
function hitExcerpts(text, terms, radius = 60, count = 3) {
  const source = str(text).replace(/\s+/g, ' ').trim()
  const lower = source.toLocaleLowerCase()
  const windows = []
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) windows.push([Math.max(0, at - radius), Math.min(source.length, at + term.length + radius)])
  }
  if (!windows.length) return ''
  windows.sort((left, right) => left[0] - right[0])
  const merged = []
  for (const window of windows) {
    const last = merged.at(-1)
    if (last && window[0] <= last[1] && window[1] - last[0] <= radius * 4) last[1] = Math.max(last[1], window[1])
    else if (last && window[0] < last[1]) continue
    else merged.push(window.slice())
  }
  const shown = merged.slice(0, count).map(([start, end]) => (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '')).join(' ')
  return excerpt(shown, terms, HISTORY_RECALL_HIT_CHARS) + (merged.length > count ? ` （另有 ${merged.length - count} 处命中）` : '')
}

// Which floors mention each keyword, so a narrow query still shows where else the story touched it.
function termTurns(rounds, terms) {
  const texts = rounds.map(round => ({ turn: round.turn, text: searchable(round.messages.map(message => message.text).join('\n')) }))
  return terms.slice(0, SPREAD_TERMS).map(term => ({ term, turns: texts.filter(item => item.text.includes(searchable(term))).map(item => item.turn) }))
}

// A floor as one or two messages: the player's input (not the opening's) and the current body.
function roundsOfFloors(floors) {
  return floors.map(floor => ({
    turn: Number(floor.turn),
    messages: (str(floor.input).trim() !== '' ? [{ role: 'user', text: str(floor.input).trim() }] : [])
      .concat([{ role: 'assistant', text: str(floor.body).trim() }])
  })).filter(round => Number.isSafeInteger(round.turn) && round.turn > 0 && round.messages.at(-1).text !== '')
    .sort((left, right) => left.turn - right.turn)
}

function scoreRound(round, query, terms) {
  const text = round.messages.map(function (message) { return message.text }).join('\n')
  const normalized = searchable(text)
  const full = searchable(query)
  let score = full !== '' && normalized.includes(full) ? 1000 : 0
  let matched = 0
  for (const term of terms) {
    if (normalized.includes(searchable(term))) matched++
  }
  if (matched === 0 && score === 0) return null
  score += matched * 100 + Math.round(matched / Math.max(1, terms.length) * 10)
  return score
}

// The hit windows of a floor, labelled by who said it: the input and the body can both match.
function matchExcerpt(round, terms) {
  const parts = round.messages.map(message => ({ message, hit: hitExcerpts(message.text, terms) })).filter(part => part.hit !== '')
  // Only the joined text of both messages matched (a phrase spanning the two): show the start.
  if (!parts.length) return excerpt(round.messages.map(message => message.text).join(' '), terms)
  return parts.map(part => (part.message.role === 'user' ? '[玩家] ' : '[正文] ') + part.hit).join('\n')
}

const sizeOf = round => round.messages.reduce((total, message) => total + message.text.length, 0)

// One floor cut to `budget` characters in all; the body (after the short input) takes the cut.
function truncateRound(round, budget) {
  let left = Math.max(0, budget)
  const messages = round.messages.map(message => {
    if (message.text.length <= left) { left -= message.text.length; return message }
    const kept = message.text.slice(0, left)
    left = 0
    return { role: message.role, text: kept + '…（已截断）' }
  })
  return { turn: round.turn, messages }
}

export const HISTORY_RECALL_TOOL = Object.freeze({
  name: 'tavern_recall_history',
  description: '按关键词或楼层号（轮次，与界面上的「第 N 轮」同号）查回当前对话已经正式发生的原文。剧情摘要只是索引，省略了大部分数字、原话和次要情节；用到摘要里没有原文的细节、需要确认某件事、或想引用原话时先查，不要凭摘要推断；已被压缩进摘要的楼层同样查得到。query 用要找的人物、物品、事件本身的词，不要用摘要里已有的结论或数字当关键词（那只会查回你已知的内容）；问「第一次」「最早」时留意轮次靠前的结果。query 与 turn 必须且只能提供一个。返回的正文有总字数上限，超出的部分会注明，可改用更小的 radius 单独读。每次生成最多召回 6 次；完整正文召回后冷却 10 个剧情轮次，冷却期间不可重复读取。已有信息足够时直接继续任务，不要重复读取同一轮。检索结果不是当前场景，不得重复演绎、照搬旧台词或让已经发生的事件再次发生。',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, description: '要回忆的人物、地点、物品、承诺或事件关键词；多个关键词用空格分隔。' },
      turn: { type: 'integer', minimum: 1, description: '读取指定剧情轮次及其附近原文。' },
      radius: { type: 'integer', minimum: 0, maximum: 3, description: '按轮读取时包含前后多少轮，默认 1。' },
      limit: { type: 'integer', minimum: 1, maximum: 8, description: '关键词检索最多返回多少条命中，默认 5。' }
    }
  })
})

export const HISTORY_RECALL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    notice: { type: 'string', required: true },
    found: { type: 'boolean', required: true },
    chatId: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    mode: { type: 'string', required: true },
    query: { type: 'string', required: true },
    requestedTurn: { type: 'integer', required: true },
    terms: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          term: { type: 'string', required: true },
          turns: { type: 'array', required: true, items: { type: 'integer' } }
        }
      }
    },
    matches: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          turn: { type: 'integer', required: true },
          excerpt: { type: 'string', required: true }
        }
      }
    },
    rounds: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          turn: { type: 'integer', required: true },
          messages: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                text: { type: 'string', required: true }
              }
            }
          }
        }
      }
    }
  }
})

/**
 * Whether the tool is in a session's foreground tool list: a story/script chat in the native play
 * strategy (compatibility mode only carries web search). `visibleTools` is the foreground
 * orchestrator's own list, so this cannot disagree with what the model is actually given.
 */
export function historyRecallAvailable(chat, visibleTools) {
  return chat !== null && typeof chat === 'object' && (chat.mode === 'story' || chat.mode === 'script') &&
    chat.requestMode !== 'sillytavern' && Array.isArray(visibleTools) && visibleTools.includes(HISTORY_RECALL_TOOL.name)
}

export function createHistoryRecall() {
  const scopes = new WeakMap()
  function stateFor(scope) {
    if (!scope || typeof scope !== 'object') return null
    if (!scopes.has(scope)) scopes.set(scope, { calls: 0, rounds: new Set(), searches: new Set() })
    return scopes.get(scope)
  }
  /**
   * @param input.chat - the Tavern Chat: identity, revision, branch and the cooldown record only.
   * @param input.floors - `projectFloorTexts(...)`: the committed floors read from the Session log.
   */
  function recall(input = {}) {
    const chat = input.chat
    if (chat === null || typeof chat !== 'object') throw new Error('历史正文检索缺少 Tavern Chat')
    if (!Array.isArray(input.floors)) throw new Error('历史正文检索缺少楼层投影')
    if (input.query !== undefined && input.query !== null && typeof input.query !== 'string') throw new Error('历史正文检索关键词必须是文字')
    const query = str(input.query).trim()
    const hasQuery = query !== ''
    const hasTurn = input.turn !== undefined && input.turn !== null
    if (Number(hasQuery) + Number(hasTurn) !== 1) throw new Error('历史正文检索必须且只能提供 query 或 turn')
    if (query.length > MAX_QUERY_CHARS) throw new Error('历史正文检索关键词最多 ' + MAX_QUERY_CHARS + ' 个字')
    const rounds = roundsOfFloors(input.floors)
    const currentTurn = rounds.reduce((maximum, round) => Math.max(maximum, round.turn), 0)
    const branch = str(chat.timeline?.branchId)
    const signature = round => createHash('sha256').update(JSON.stringify(round.messages)).digest('hex')
    const audience = input.audience === 'background' ? 'background' : 'foreground'
    const cooldowns = input.trackCooldown && Array.isArray(chat.historyRecallCooldowns)
      ? chat.historyRecallCooldowns.filter(item => item && (item.audience === 'foreground' || item.audience === 'background') && item.branch === branch && currentTurn >= item.at && currentTurn - item.at <= 10)
      : []
    const cooling = round => cooldowns.some(item => item.audience === audience && item.turn === round.turn && item.hash === signature(round))
    const base = {
      notice: '',
      found: false,
      chatId: str(chat.id),
      revision: Math.max(0, Number(chat._storageRevision) || 0),
      mode: hasQuery ? 'search' : 'read',
      query: hasQuery ? query : '',
      requestedTurn: hasTurn ? Number(input.turn) : 0,
      terms: [],
      matches: [],
      rounds: []
    }
    const state = stateFor(input.scope)
    if (state && state.calls++ >= 6) {
      return Object.assign(base, { notice: '本次生成的历史召回预算已用尽。请使用已经返回的资料继续当前任务，不要再调用历史召回。' })
    }
    if (hasQuery) {
      const terms = termsOf(query)
      if (terms.length === 0) throw new Error('历史正文检索关键词不能为空')
      const limit = clampInteger(input.limit, 5, 1, 8)
      const searchKey = JSON.stringify([str(chat.id), [...terms].sort(), limit])
      if (state?.searches.has(searchKey)) return Object.assign(base, { notice: '相同关键词已检索，请使用之前的结果；仅在缺少必要细节时读取对应轮次。' })
      state?.searches.add(searchKey)
      const matches = rounds.filter(round => !cooling(round)).map(function (round) {
        const score = scoreRound(round, query, terms)
        return score === null ? null : { round, score }
      }).filter(Boolean).sort(function (left, right) {
        return right.score - left.score || right.round.turn - left.round.turn
      }).slice(0, limit).map(function (match) {
        return { turn: match.round.turn, excerpt: matchExcerpt(match.round, terms) }
      })
      return Object.assign(base, { found: matches.length > 0, matches, terms: termTurns(rounds, terms), notice: cooldowns.some(item => item.audience === audience) ? '已召回的完整正文处于 10 轮冷却期，检索已跳过这些轮次。' : '' })
    }
    const requested = Number(input.turn)
    if (!Number.isInteger(requested) || requested < 1) throw new Error('历史正文轮次必须是大于 0 的整数')
    const radius = clampInteger(input.radius, 1, 0, 3)
    const key = round => JSON.stringify([str(chat.id), round.turn, round.messages])
    const selected = rounds.filter(function (round) { return Math.abs(round.turn - requested) <= radius })
    const cooled = selected.filter(cooling)
    const candidates = selected.filter(round => !cooling(round) && !state?.rounds.has(key(round)))
    // The requested floor first, then outward. A floor that does not fit the remaining budget is left
    // out (a lone floor longer than the whole budget is cut) and stays readable by a narrower call.
    let left = HISTORY_RECALL_READ_CHARS
    const delivered = [], skipped = [], cut = []
    for (const round of [...candidates].sort((a, b) => Math.abs(a.turn - requested) - Math.abs(b.turn - requested) || a.turn - b.turn)) {
      const size = sizeOf(round)
      if (size <= left) { delivered.push({ round, shown: round }); left -= size }
      else if (!delivered.length) { delivered.push({ round, shown: truncateRound(round, left) }); cut.push(round.turn); left = 0 }
      else skipped.push(round.turn)
    }
    delivered.sort((a, b) => a.round.turn - b.round.turn)
    const fresh = delivered.map(item => item.round)
    for (const round of fresh) state?.rounds.add(key(round))
    if (input.trackCooldown && fresh.length) {
      chat.historyRecallCooldowns = cooldowns.filter(item => item.audience !== audience || !fresh.some(round => round.turn === item.turn))
        .concat(fresh.map(round => ({ turn: round.turn, hash: signature(round), at: currentTurn, branch, audience })))
    }
    const notices = []
    if (!selected.length) notices.push(rounds.length ? `没有第 ${requested} 轮附近的正文（现有第 ${rounds[0].turn}–${currentTurn} 轮）。` : '当前对话还没有可检索的正文。')
    if (cooled.length) notices.push('第 ' + cooled.map(round => round.turn).join('、') + ' 轮已召回，处于 10 轮冷却期；请使用已有资料继续任务。')
    else if (candidates.length < selected.length) notices.push('重叠轮次已读取，本次只补充未返回的正文。请使用之前的资料，不要重复召回。')
    if (cut.length) notices.push('第 ' + cut.join('、') + ' 轮正文过长，只返回了前 ' + HISTORY_RECALL_READ_CHARS + ' 字。')
    if (skipped.length) notices.push('受总字数上限限制，第 ' + skipped.sort((a, b) => a - b).join('、') + ' 轮没有返回；需要时把 radius 调小后单独读取。')
    return Object.assign(base, {
      found: fresh.length > 0, rounds: delivered.map(item => item.shown),
      notice: notices.join('')
    })
  }

  return Object.freeze({ recall })
}

export function renderHistoryRecall(value) {
  let warning = '【历史回忆资料】\n以下是已经发生的历史，只用于确认和回忆；不得当作当前场景继续输出，不得重复演绎。'
  if (value?.notice) warning += '\n\n' + value.notice
  if (value?.notice && !value.rounds?.length && !value.matches?.length) return warning
  if (!value || value.found !== true) return warning + '\n\n没有找到相关历史正文。'
  if (value.mode === 'search') {
    const spread = (value.terms || []).map(function (item) {
      const turns = item.turns.length > 40 ? item.turns.slice(0, 20).join('、') + '……' + item.turns.slice(-20).join('、') : item.turns.join('、')
      return '「' + item.term + '」' + (item.turns.length ? '出现在第 ' + turns + ' 轮（共 ' + item.turns.length + ' 轮）' : '没有出现')
    }).join('\n')
    return warning + (spread ? '\n\n关键词分布：\n' + spread : '') + '\n\n命中最多的轮次：\n\n' + value.matches.map(function (match) {
      return '[第 ' + match.turn + ' 轮]\n' + match.excerpt
    }).join('\n\n') + '\n\n只列出了命中最多的几轮；关键词分布里的其他轮次可用 turn 读取原文。信息足够就继续当前任务。'
  }
  return warning + '\n\n' + value.rounds.map(function (round) {
    return '【第 ' + round.turn + ' 轮】\n' + round.messages.map(function (message) {
      return (message.role === 'user' ? '[玩家]' : '[正文]') + '\n' + message.text
    }).join('\n\n')
  }).join('\n\n')
}
