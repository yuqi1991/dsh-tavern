export class GuardError extends Error {
  constructor(rule, message, details = {}) {
    super(`[${rule}] ${message}`)
    this.name = 'GuardError'
    this.rule = rule
    this.details = details
  }
}

export const SCAFFOLD_TAGS = Object.freeze(new Set([
  'worldbook-snapshot',
  'writing-skill-state',
  'writing-skill-reminder',
  'foreground-frame',
  'skill'
]))

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

function fail(rule, message, details) {
  throw new GuardError(rule, message, details)
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0
}

export function messageOf(event) {
  if (event?.type === 'user/message') return event.data
  return event?.data?.message
}

export function sourceOf(event) {
  return messageOf(event)?.source
}

export function contentOf(event) {
  const content = messageOf(event)?.content
  return Array.isArray(content) ? content : []
}

export function toolCallIdsOf(row) {
  const ids = []
  if (row?.type === 'tool/call' && nonempty(row.data?.callId)) ids.push(row.data.callId)
  for (const block of contentOf(row)) {
    if (block?.type === 'tool-call' && nonempty(block.id || block.toolCallId)) ids.push(block.id || block.toolCallId)
  }
  return ids
}

export function toolResultCallId(row) {
  if (row?.type !== 'tool/result') return ''
  return sourceOf(row)?.callId || contentOf(row)[0]?.toolCallId || ''
}

export function tagOfEvent(event, rows = [event]) {
  const source = sourceOf(event)
  const form = source?.kind === 'plugin' && source.plugin === 'dsh-tavern' ? source.form : ''
  if (SCAFFOLD_TAGS.has(form)) return form
  if (source?.kind === 'skill-catalog') return 'writing-skill-reminder'
  const callNames = new Map(rows.filter(row => row?.type === 'tool/call').map(row => [row.data?.callId, row.data?.name]))
  for (const row of rows) {
    for (const block of contentOf(row)) {
      if (block?.type === 'tool-call' && nonempty(block.id || block.toolCallId)) callNames.set(block.id || block.toolCallId, block.name)
    }
  }
  if (contentOf(event).some(block => block?.type === 'tool-call' && block.name === 'skill')) return 'skill'
  if (event?.type === 'tool/result' && callNames.get(toolResultCallId(event)) === 'skill') return 'skill'
  return null
}

export function guardShape(event) {
  if (!record(event) || !nonempty(event.type)) fail('G1', '事件必须带非空 type')
  if (!SURFACE_TYPES.has(event.type)) return true
  const message = messageOf(event)
  if (!record(message) || !nonempty(message.id)) fail('G1', `${event.type} 缺少 message.id`)
  const expectedRole = event.type === 'assistant/message' ? 'assistant'
    : event.type === 'system/message' ? 'system' : 'user'
  if (message.role !== expectedRole) fail('G1', `${event.type} role 必须为 ${expectedRole}`)
  if (!record(message.source) || !nonempty(message.source.kind)) fail('G1', `${event.type} source 无效`)
  if (!Array.isArray(message.content)) fail('G1', `${event.type} content 必须为数组`)
  if (event.type !== 'user/message') {
    if (!Number.isSafeInteger(event.data?.turn) || !Number.isSafeInteger(event.data?.step)) fail('G1', `${event.type} turn/step 必须为安全整数`)
  }
  if (event.type === 'system/message' && (message.source.kind !== 'plugin' || !nonempty(message.source.plugin))) fail('G1', 'system/message 必须带 plugin source')
  if (event.type === 'assistant/message') {
    if (message.source.kind !== 'model' || !nonempty(message.source.provider) || !nonempty(message.source.model)) fail('G1', 'assistant/message 必须带完整 model source')
    if (!Array.isArray(event.data.stream)) fail('G1', 'assistant/message stream 必须为数组')
  }
  if (event.type === 'tool/result') {
    const block = message.content[0]
    if (message.source.kind !== 'tool' || !nonempty(message.source.callId)) fail('G1', 'tool/result 必须带 tool source')
    if (message.content.length !== 1 || !record(block) || block.type !== 'tool-result' || !Array.isArray(block.content)) fail('G1', 'tool/result content 形状无效')
    if (block.toolCallId !== message.source.callId) fail('G1', 'tool/result callId 不匹配')
  }
  return true
}

export function guardStepComplete(step) {
  const rows = Array.isArray(step?.rows) ? step.rows : Array.isArray(step) ? step : []
  if (rows.length === 0) fail('G2', 'step 不得为空')
  rows.forEach(guardShape)
  const calls = new Set(rows.flatMap(toolCallIdsOf))
  const results = rows.filter(row => row?.type === 'tool/result').map(toolResultCallId)
  if (results.some(id => !calls.has(id))) fail('G2', 'tool_result 没有同 step 的 tool_call')
  if ([...calls].some(id => !results.includes(id))) fail('G2', 'assistant step 缺少全部 tool_result')
  const coordinates = rows.filter(row => row?.type !== 'user/message' && row?.data?.turn !== undefined)
    .map(row => `${row.data.turn}:${row.data.step}`)
  if (new Set(coordinates).size > 1) fail('G2', '一个 step 不得跨 turn/step')
  return true
}

export function guardDropTagged(step, tag) {
  if (!SCAFFOLD_TAGS.has(tag)) fail('G7', `未注册的脚手架标签: ${String(tag)}`)
  const rows = Array.isArray(step?.rows) ? step.rows : []
  if (rows.length === 0) fail('G3', '退役目标 step 为空')
  if (rows.some(row => tagOfEvent(row, rows) !== tag)) fail('G7', '退役目标含有其他标签或正文行')
  guardStepComplete({ rows })
  return true
}

export function guardEdit(step) {
  const rows = Array.isArray(step?.rows) ? step.rows : []
  if (rows.length !== 1 || !['user/message', 'assistant/message'].includes(rows[0]?.type)) fail('G4', '只能编辑单行 user/assistant step')
  if (toolCallIdsOf(rows[0]).length > 0 || rows.some(row => row.type === 'tool/result')) fail('G4', '含工具调用的 assistant step 必须走 reroll')
  return true
}

export function guardTombstoneSource(event) {
  if (event?.type !== 'assistant/message') return true
  const source = sourceOf(event)
  if (source?.kind !== 'model' || !nonempty(source.provider) || !nonempty(source.model)) fail('G5', 'assistant 墓碑缺少原始 model source')
  return true
}
