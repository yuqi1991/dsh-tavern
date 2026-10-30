import { isProducerSource } from './message-source.js'
export function usesStoryCompaction(chat) {
  return chat !== null && typeof chat === 'object' && (chat.mode === 'story' || chat.mode === 'script')
}

export function createStoryCompactionRequest(options, instruction) {
  if (options === null || typeof options !== 'object' || options.purpose !== 'compaction') return options
  if (!Array.isArray(options.messages) || options.messages.length === 0) return options
  if (typeof instruction !== 'string' || instruction.trim() === '') throw new TypeError('剧情压缩提示词不能为空')

  const lastIndex = options.messages.length - 1
  const message = options.messages[lastIndex]
  const source = message && message.source
  // The summarization directive is the final user message DSH appends. DSH 0.1.x tagged it
  // with its producer; DSH 0.2.x sends it with no source at all.
  if (message === null || typeof message !== 'object' || message.role !== 'user' ||
    (source !== undefined && source !== null && !isProducerSource(source, 'dsh-compaction-basic'))) return options

  const messages = options.messages.slice()
  messages[lastIndex] = Object.freeze(Object.assign({}, message, {
    content: Object.freeze([Object.freeze({ type: 'text', text: instruction })])
  }))
  return Object.freeze(Object.assign({}, options, { messages: Object.freeze(messages) }))
}

// Story summaries are kept as volumes (分卷, docs/design/compaction-retention.md §4.5, §6).
// Each compaction writes ONE new volume for the rounds it folds; the earlier volumes are
// carried byte for byte as their own text blocks, so what was summarized once is not
// summarized (and worn down) again. Volume number, round range, carrying and the size
// budget are decided here, not by the summarizer: the model's first line is replaced by
// the header this module computes.
export const STORY_SUMMARY_NOTE = '【剧情摘要说明】以下按卷记录更早的剧情，是续写用的工作记忆，不是完整档案：旧卷在前、新卷在后，后写的卷和其中的「更正」优先；角色卡、世界书和状态变量仍是基准。最近几轮的原文（如有）在摘要之后照常保留。'
// Carried volumes may use at most this share of the model's context window.
export const STORY_VOLUMES_WINDOW_SHARE = 0.15

const HEADER_LINE = /^[【[]?\s*(?:第\s*\d+\s*卷|前情总览)[^\n]*$/gm
const isCheckpointMessage = message => message?.role === 'user' && message.source !== null && typeof message.source === 'object' &&
  (message.source.kind === 'compact-checkpoint' || 'compactionId' in message.source)
const textBlocks = message => (Array.isArray(message?.content) ? message.content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text)

/** CJK-aware size estimate (the host's four characters per token underprices Chinese). */
export function estimateStoryText(text) {
  const value = String(text || '')
  const wide = [...value].filter(char => char.codePointAt(0) > 127).length
  return wide + Math.ceil((value.length - wide) / 4)
}

function headerFacts(line) {
  const number = line.match(/第\s*(\d+)\s*卷/)
  const range = line.match(/第\s*(\d+)\s*[–—\-~至]\s*(\d+)\s*轮/)
  const until = line.match(/截至第\s*(\d+)\s*轮/)
  return {
    number: number ? Number(number[1]) : null,
    from: range ? Number(range[1]) : null,
    through: range ? Number(range[2]) : until ? Number(until[1]) : null
  }
}

/**
 * The volumes the latest summary in `history` holds, oldest first. A block holding one
 * volume is returned byte for byte. A summary written before volumes existed (no header)
 * counts as one 前情总览 without a range.
 */
export function storySummaryVolumes(history) {
  const checkpoint = (Array.isArray(history) ? history : []).findLast(isCheckpointMessage)
  // The native framing (preamble and tags) and the note are not volumes.
  const texts = textBlocks(checkpoint).filter(text => text.trim() && !text.includes('compacted-summary>') && !text.startsWith('【剧情摘要说明】'))
  const volumes = []
  for (const text of texts) {
    const starts = [...text.matchAll(HEADER_LINE)].map(match => match.index)
    if (!starts.length || text.slice(0, starts[0]).trim()) {
      const legacy = (starts.length ? text.slice(0, starts[0]) : text).trim()
      volumes.push({ text: '前情总览（分卷之前的摘要）\n' + legacy, number: null, from: null, through: null })
    }
    starts.forEach((start, index) => {
      const end = starts[index + 1]
      const piece = end === undefined ? text.slice(start) : text.slice(start, end).replace(/\s+$/, '')
      volumes.push({ text: piece, ...headerFacts(piece.split('\n', 1)[0]) })
    })
  }
  return volumes
}

function rangeHeader(prefix, from, through) {
  if (Number.isSafeInteger(through) && through > 0) {
    if (Number.isSafeInteger(from) && from > 0 && from <= through) return `${prefix} · 第 ${from}–${through} 轮`
    return `${prefix} · 截至第 ${through} 轮`
  }
  return prefix
}

/**
 * How this compaction writes its summary.
 * @param request - the summary request; its history may hold the previous checkpoint.
 * @param input.from - first story turn this compaction folds (used when no earlier volume has a range).
 * @param input.through - last story turn this compaction folds completely, or null.
 * @param input.retainRounds - the configured number of verbatim rounds; 0 asks for 「当前情况」.
 * @returns `{ header, instruction, prefix, merge? }`: the program-written first line, the
 *   instruction tail, the blocks placed before the model's output (note and carried volumes).
 */
export function storyVolumePlan(request, { from = null, through = null, retainRounds = null, budget = Infinity, estimate = estimateStoryText } = {}) {
  const volumes = storySummaryVolumes(Array.isArray(request?.messages) ? request.messages.slice(0, -1) : [])
  const number = Math.max(volumes.length, ...volumes.map(volume => volume.number || 0)) + 1
  const last = volumes.at(-1)
  const start = Number.isSafeInteger(last?.through) ? last.through + 1 : Number.isSafeInteger(from) ? from : volumes.length ? null : 1
  const header = rangeHeader(`第 ${number} 卷`, start, through)
  const lines = ['【本次摘要的写法】', `本卷是第 ${number} 卷。第一行单独写「${header}」（由系统给出，照写），之后按上面的分段写。`]
  if (volumes.length) {
    const carried = Number.isSafeInteger(last?.through) ? `（截至第 ${last.through} 轮）` : ''
    lines.push(`<compacted-summary> 里已有 ${volumes.length} 卷旧摘要${carried}，它们会原样保留在本卷之前，不要复述、不要改写。本卷只写旧卷之后的新剧情；旧卷里记过的人物、关系、设定只在有变化时写；与旧卷冲突时以本卷为准，并写「更正：……」。`)
  }
  if (retainRounds === 0) {
    lines.push('压缩后不保留最近几轮原文，所以在本卷最后加一段「当前情况」：时间、地点、在场人物、正在进行的动作，最多三行。')
  }
  // Over budget, only the oldest volumes are merged (by a separate call, see storyVolumeMerge):
  // as few as leave the newer ones within half the budget, so recent volumes stay word for word.
  const size = list => estimate(list.map(volume => volume.text).join('\n\n'))
  let count = 0
  if (volumes.length && size(volumes) > budget) while (count < volumes.length && (count === 0 || size(volumes.slice(count)) > budget / 2)) count++
  return {
    header,
    instruction: lines.join('\n'),
    prefix: [STORY_SUMMARY_NOTE, ...volumes.slice(count).map(volume => volume.text)],
    ...(count ? { merge: { volumes: volumes.slice(0, count) } } : {})
  }
}

/** The request that merges the oldest volumes into one 前情总览 of about half their length. */
export function storyVolumeMerge(merge) {
  const volumes = merge.volumes
  const text = volumes.map(volume => volume.text).join('\n\n')
  const through = volumes.findLast(volume => Number.isSafeInteger(volume.through))?.through ?? null
  const header = rangeHeader('前情总览', volumes[0].from ?? 1, through)
  return {
    header,
    prompt: [
      '以下是按时间顺序排列的旧剧情摘要卷。把它们合并成一份前情总览，供后续续写使用。',
      `第一行单独写「${header}」，之后沿用原来的分段（剧情脉络、人物变化、关系变化、新设定与物品、伏笔与约定、玩家意志），某段没有内容就省略。`,
      '保留：所有专名、称谓、数字、日期和约定；玩家意志逐条照录；未兑现的约定与伏笔、仍然有效的设定；同一指标的变化轨迹。各卷里的「更正」以更正后的内容为准。',
      '删去：各卷之间的重复、已彻底解决且无余波的冲突、过渡闲笔、只出现一次的路人。',
      `不续写、不推测、不评价。篇幅约为原文的一半（约 ${Math.round(text.length / 2)} 字），不要压得更短。不使用加粗等强调格式。只输出总览本身。`,
      '', text
    ].join('\n')
  }
}

/** Put the program-written header on the first line of a summary, replacing a model-written one. */
export function withVolumeHeader(text, header) {
  if (typeof header !== 'string' || header === '') return text
  const body = String(text || '').replace(/^\s+/, '')
  const first = body.split('\n', 1)[0]
  if (/^[【[]?\s*(?:第\s*\d+\s*卷|前情总览)/.test(first)) return header + body.slice(first.length)
  return header + '\n' + body
}

/**
 * The story part of a summary request (the `prepare` of installCompactionRequestProjection):
 * story/script chats get the story prompt (the user's override when set, see
 * resolveSystemPrompt) followed by this compaction's volume plan; other sessions keep
 * DSH's prompt.
 * @param deps.isStory - (sessionId) => whether the session is a story/script chat.
 * @param deps.plan - (sessionId) => the compaction plan registered by the entry, or null.
 * @param deps.retainRounds - () => the configured verbatim rounds (when no plan is registered).
 * @param deps.prompt - () => the story compaction prompt in effect.
 * @param deps.contextWindow - (request) => the summarizer's context window, or null.
 * @param deps.stream - (request) => an llm/stream event iterator for the volume merge call.
 * @param deps.warn - (message) => record a merge failure.
 */
export function createStorySummaryPreparation({ isStory, plan: planOf, retainRounds, prompt, contextWindow, stream, warn = () => {} }) {
  async function merge(volumesToMerge, request) {
    const { header, prompt: text } = storyVolumeMerge(volumesToMerge)
    let output = ''
    // No sessionId: the merge is a private call, not a summary of this Session's surface.
    for await (const event of stream({ provider: request.provider, model: request.model, purpose: 'compaction', signal: request.signal,
      ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
      messages: [{ id: 'tavern-story-volume-merge', role: 'user', content: [{ type: 'text', text }] }] })) {
      if (event?.type === 'block-end' && event.block?.type === 'text') output += event.block.text
      if (event?.type === 'finish' && event.reason?.kind !== 'stop') throw new Error('合并未完成：' + (event.reason?.failure?.message || event.reason?.kind))
    }
    if (!output.trim()) throw new Error('合并没有返回文字')
    const merged = withVolumeHeader(output.trim(), header)
    // A merge that does not shrink the carried volumes is not worth keeping.
    if (estimateStoryText(merged) >= estimateStoryText(volumesToMerge.volumes.map(volume => volume.text).join('\n\n'))) throw new Error('合并结果没有变短')
    return merged
  }
  return async function prepare(request) {
    if (!(await isStory(String(request?.sessionId ?? '')))) return { request }
    const plan = (await planOf(request.sessionId)) || {}
    let window = null
    try { window = await contextWindow(request) }
    catch (error) { if (request.signal?.aborted) throw error }
    const volumes = storyVolumePlan(request, {
      from: plan.from ?? null, through: plan.through ?? null, retainRounds: plan.retainRounds ?? await retainRounds(),
      budget: Number.isFinite(window) && window > 0 ? Math.floor(window * STORY_VOLUMES_WINDOW_SHARE) : Infinity
    })
    // An imported game compacts right away: an oversized history is summarized in segments
    // (bounded-compaction.js), so the first-play capacity check is not a precondition.
    const story = createStoryCompactionRequest(request, String(await prompt()).trimEnd() + '\n\n' + volumes.instruction)
    if (story === request) return { request }
    let prefix = volumes.prefix
    if (volumes.merge) {
      // Only the oldest volumes are rewritten, in their own call; a failed merge keeps them all.
      try { prefix = [prefix[0], await merge(volumes.merge, request), ...prefix.slice(1)] }
      catch (error) {
        if (request.signal?.aborted) throw error
        warn('合并旧卷失败，本次原样保留全部旧卷：' + (error?.message || error))
        prefix = [prefix[0], ...volumes.merge.volumes.map(volume => volume.text), ...prefix.slice(1)]
      }
    }
    return { request: story, prefix, header: volumes.header }
  }
}
