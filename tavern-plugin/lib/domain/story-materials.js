// 故事固定背景（人物卡信息 + 常驻世界书）的 StoryMaterials 投影。
// 固定背景不再占据顶部 system，而是在种子轨迹（CoreTask + 确认回复）之后
// 以独立 system 消息注入：<StoryMaterials> 包裹人物卡各段，常驻世界书置于
// 末尾的 <ExtraInfo>。快照格式与持久化事件保持不变，仅改请求投影。

const CARD_MARKERS = Object.freeze([
  { match: /^【故事设定 · 人物卡】/, kind: 'header' },
  { match: /^名字:[ \t]*/, kind: 'name' },
  { match: /^设定:[ \t]*/, kind: 'description' },
  { match: /^主要人物性格:[ \t]*/, kind: 'personality' },
  { match: /^开场情境:[ \t]*/, kind: 'scenario' },
  { match: /^【文风示例】/, kind: 'style' }
])

const SEED_FIRST = /^tavern-seed-trajectory:v\d+:.+:1$/
const SEED_SECOND = /^tavern-seed-trajectory:v\d+:.+:2$/

const STATUS_BLOCK_PATTERN = /<StatusBlock>[\s\S]*?<\/StatusBlock>/g
const UPDATE_VARIABLE_PATTERN = /<UpdateVariable(?:variable)?>[\s\S]*?<\/UpdateVariable(?:variable)?>/g

/** 默认历史裁剪：各标签独立计数，从最新消息向前各保留最新 keep 个块。 */
const DEFAULT_HISTORY_BLOCK_TRIMS = Object.freeze([
  { pattern: STATUS_BLOCK_PATTERN, keep: 3 },
  { pattern: UPDATE_VARIABLE_PATTERN, keep: 3 }
])

function countPatternMatches(text, pattern) {
  const matches = str(text).match(pattern)
  return matches === null ? 0 : matches.length
}

function tidyTrimmedText(text) {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

/**
 * 历史助手回复中的标签块按规则裁剪：每条规则（pattern + keep）独立从最新消息
 * 向前计数，超出额度的块在请求投影中移除，仅发送正文。
 * 仅处理 assistant 消息：种子轨迹、StoryMaterials 指令和每轮规则包不受影响。
 */
export function projectHistoryBlockTrim(messages, specs = DEFAULT_HISTORY_BLOCK_TRIMS) {
  const source = Array.isArray(messages) ? messages : []
  const rules = (Array.isArray(specs) ? specs : []).map(function (spec) {
    return {
      pattern: spec && spec.pattern instanceof RegExp ? spec.pattern : null,
      remaining: Math.max(0, Math.floor(Number(spec && spec.keep) || 0))
    }
  }).filter(function (rule) { return rule.pattern !== null })
  if (rules.length === 0) return source
  const out = new Array(source.length)
  let changed = false
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index]
    out[index] = message
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const budgets = []
    let needsTrim = false
    for (const rule of rules) {
      let blocks = 0
      for (const block of message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') blocks += countPatternMatches(block.text, rule.pattern)
      }
      const kept = Math.min(blocks, rule.remaining)
      rule.remaining -= kept
      budgets.push({ pattern: rule.pattern, kept })
      if (kept < blocks) needsTrim = true
    }
    if (!needsTrim) continue
    changed = true
    out[index] = Object.assign({}, message, {
      content: message.content.map(function (block) {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') return block
        let text = block.text
        for (const budget of budgets) {
          if (budget.kept === 0 && countPatternMatches(text, budget.pattern) === 0) continue
          let allowance = budget.kept
          const next = text.replace(budget.pattern, function (match) {
            if (allowance > 0) {
              allowance -= 1
              return match
            }
            return ''
          })
          if (next !== text) text = tidyTrimmedText(next)
        }
        if (text === block.text) return block
        return Object.assign({}, block, { text })
      })
    })
  }
  return changed ? out : source
}

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function markerOf(line) {
  for (const marker of CARD_MARKERS) {
    if (marker.match.test(line)) return marker
  }
  return null
}

function parseCardSection(text) {
  const parts = { name: '', description: '', personality: '', scenario: '', others: [] }
  let current = null
  function flush() {
    if (current === null) return
    const body = current.lines.join('\n').trim()
    if (current.kind === 'name') parts.name = body
    else if (current.kind === 'description') parts.description = body
    else if (current.kind === 'personality') parts.personality = body
    else if (current.kind === 'scenario') parts.scenario = body
    else if (current.kind === 'other' && body !== '') parts.others.push(body)
    current = null
  }
  for (const line of str(text).split('\n')) {
    const marker = markerOf(line)
    if (marker === null) {
      if (current !== null) current.lines.push(line)
      else if (line.trim() !== '') current = { kind: 'other', lines: [line] }
      continue
    }
    flush()
    if (marker.kind === 'header') continue
    if (marker.kind === 'style') {
      current = { kind: 'other', lines: [line] }
      continue
    }
    current = { kind: marker.kind, lines: [line.replace(marker.match, '')] }
  }
  flush()
  return parts
}

/** Build the <StoryMaterials> system text from stable prefix sections and the current world book. */
export function storyMaterialsText(sections, worldBookContext) {
  const list = Array.isArray(sections) ? sections : []
  const blocks = []
  const card = list.find(function (section) { return section && section.name === 'tavern:character-card' })
  if (card && str(card.text).trim() !== '') {
    const parts = parseCardSection(card.text)
    if (parts.description !== '') blocks.push('<故事设定 · 背景>\n' + parts.description + '\n</故事设定 · 背景>')
    const roster = []
    if (parts.name !== '') roster.push('名字: ' + parts.name)
    if (parts.personality !== '') roster.push('主要人物性格: ' + parts.personality)
    if (roster.length > 0) blocks.push('<故事设定 · 人物卡>\n' + roster.join('\n') + '\n</故事设定 · 人物卡>')
    if (parts.scenario !== '') blocks.push('<故事设定 · Scenario>\n' + parts.scenario + '\n</故事设定 · Scenario>')
    for (const other of parts.others) blocks.push(other)
  }
  for (const section of list) {
    if (!section || str(section.text).trim() === '') continue
    if (section.name === 'tavern:character-card' || section.name === 'tavern:constant-worldbook') continue
    blocks.push(str(section.text).trim())
  }
  const worldBook = str(worldBookContext).trim()
  if (worldBook !== '') blocks.push('<常驻世界书>\n' + worldBook + '\n</常驻世界书>')
  if (blocks.length === 0) return null
  return '<StoryMaterials>\n' + blocks.join('\n\n') + '\n</StoryMaterials>'
}

function storyMaterialsMessage(text, sessionId) {
  return {
    id: 'tavern-story-materials:v1:' + str(sessionId),
    role: 'system',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin', plugin: 'dsh-tavern', form: 'story-materials',
      sections: [{ name: 'tavern:story-materials', text }]
    }
  }
}

/** Rewrite the CoreTask seed as system and insert the StoryMaterials system message after the seed confirmation. */
export function projectStoryMaterials(messages, text, sessionId) {
  const source = Array.isArray(messages) ? messages : []
  const projected = []
  let inserted = false
  for (const message of source) {
    const id = str(message && message.id)
    if (SEED_FIRST.test(id)) {
      projected.push(message && message.role === 'user' ? Object.assign({}, message, { role: 'system' }) : message)
    } else {
      projected.push(message)
    }
    if (SEED_SECOND.test(id)) {
      projected.push(storyMaterialsMessage(text, sessionId))
      inserted = true
    }
  }
  if (!inserted) {
    // 找不到种子确认消息（异常会话）时退回最前注入，避免固定背景整段丢失。
    projected.unshift(storyMaterialsMessage(text, sessionId))
  }
  return projected
}
