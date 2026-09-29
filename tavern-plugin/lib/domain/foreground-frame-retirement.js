import { replaceSessionSurface } from './session-surface-mutations.js'
import { randomUUID } from 'node:crypto'
import { appendSessionEvent, sessionEvents } from './session-events.js'
import { SKILL_REMINDER_FORM } from './skill-reminder.js'

// 「替代此前所有」类的通知（世界书快照、写作 Skill 开关）只在内容变化时追加，
// 但旧条目从不退役会永久留在 surface 里逐轮重发：变化一次累积一条，越聊越长
// 且互相矛盾。这里统一按「只保留最新一条」退役；内容未变化时的快照就是现行
// 世界书状态，跨轮有效。空文本快照是失效声明，只在旧快照仍可见时才有意义——
// 旧快照退役后它失去指涉对象，一并退役。
const LATEST_ONLY_FORMS = new Set(['worldbook-snapshot'])

// 按需装载的技能：调用与结果当前轮有效，跨轮并入空墓碑（模型下轮按场景重新判断
// 是否装载）。技能正文动辄数千字，留在 history 里既占上下文又让模型误以为仍处
// 于「已装载」状态。仅退役纯调用行（无正文），带正文的调用行整行退役会丢剧情。
const RETIRABLE_TOOL_NAMES = new Set(['skill'])
const RETIREMENT_SOURCE = { kind: 'plugin', plugin: 'dsh-tavern', form: 'tool-load-retirement' }

function carriesCurrentState(form, event) {
  if (form !== 'worldbook-snapshot') return true
  const record = event?.data?.source?.worldbookSnapshot
  if (record && typeof record.text === 'string') return record.text.trim() !== ''
  return true // 无记录的旧快照按有内容保守处理
}

function callNamesOf(events) {
  const names = new Map()
  for (const event of events) {
    if (event?.type !== 'tool/call' || !event.data) continue
    names.set(String(event.data.callId || ''), String(event.data.name || ''))
  }
  return names
}

function isPureToolCallRow(event) {
  if (event?.type !== 'assistant/message') return false
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks) || blocks.length === 0) return false
  let calls = 0
  for (const block of blocks) {
    if (!block || typeof block !== 'object') return false
    if (block.type === 'tool-call') {
      // A mixed row may contain another tool call that must stay visible.
      if (!RETIRABLE_TOOL_NAMES.has(String(block.name || ''))) return false
      calls += 1
      continue
    }
    if (block.type === 'text' && String(block.text || '').trim() !== '') return false
    if (block.type !== 'reasoning') return false
  }
  return calls > 0
}

function retireToolLoads(session, { events, bySeq, live, keepTurn }) {
  // 未带当前轮号时保守跳过：宁可多留一轮，也不能把正在使用的装载退役掉。
  if (!Number.isSafeInteger(keepTurn)) return 0
  const names = callNamesOf(events)
  if (names.size === 0) return 0
  let count = 0
  for (const seq of live) {
    const event = bySeq.get(seq)
    if (!event || !Number.isSafeInteger(event.data?.turn) || event.data.turn >= keepTurn) continue
    if (isPureToolCallRow(event)) {
      // 宿主 seed/load 校验要求 assistant/message 的 source 必须是 model（含 provider/model），
      // 所以墓碑沿用原行的模型来源；来源不完整的旧记录保守跳过，不写出非法事件。
      const original = event.data?.message?.source
      if (original === null || typeof original !== 'object' || typeof original.provider !== 'string' || original.provider === '' ||
        typeof original.model !== 'string' || original.model === '') continue
      replaceSessionSurface(session, 'assistant/message', {
        turn: Number(event.data.turn) || 0, step: Number(event.data.step) || 0,
        message: { id: randomUUID(), role: 'assistant', content: [], source: { kind: 'model', provider: original.provider, model: original.model } }
      }, { start: seq, end: seq, sourceEventSeqs: [seq] })
      count++
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = String(event.data?.message?.source?.callId || '')
    if (!RETIRABLE_TOOL_NAMES.has(names.get(callId) || '')) continue
    if (!Array.isArray(event.data.message.content) || event.data.message.content.length === 0) continue
    replaceSessionSurface(session, 'user/message', {
      id: randomUUID(), role: 'user', content: [], source: RETIREMENT_SOURCE
    }, { start: seq, end: seq, sourceEventSeqs: [seq] })
    count++
  }
  return count
}

// 技能目录（宿主注入）原本一直停在历史中段。现在每轮的技能提醒随输入携带目录，
// 因此只要提醒机制已经生效（存在存活的提醒行），常驻旧目录行即可退役；原文仍留在
// append-only 事件日志里，下一轮的提醒照样读得到。历史遗留的写作 Skill 开关行
// （writing-skill-state，机制已移除）随目录一起退役，不再进模型请求。
function retireAbsorbedParkedRows(session, { bySeq, live, reminderCount }) {
  if (reminderCount === 0) return 0
  let count = 0
  for (const seq of live) {
    const event = bySeq.get(seq), data = event?.data, source = data?.source
    if (event?.type !== 'user/message' || !Array.isArray(data.content) || !data.content.length) continue
    const catalog = source?.kind === 'skill-catalog'
    const legacySwitches = source?.kind === 'plugin' && source.plugin === 'dsh-tavern' && source.form === 'writing-skill-state'
    if (!catalog && !legacySwitches) continue
    replaceSessionSurface(session, 'user/message', {
      id: randomUUID(), role: 'user', content: [],
      source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'skill-catalog-retirement' }
    }, { start: seq, end: seq, sourceEventSeqs: [seq] })
    count++
  }
  return count
}

/** Retire request scaffolding only; story and append-only evidence stay intact. */
export function retireForegroundFrames(session, { keepTurn } = {}) {
  const events = sessionEvents(session)
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const live = [...(session.surface?.nodes || [])]
  const latestOf = new Map()
  // 提醒机制只要生效过（事件日志里出现过存活的提醒行）即可吸收退役目录行；稳态下
  // 提醒为 null 不发新行，但目录仍须每轮退役，宿主才会在当前轮指令附近重发一份，
  // 否则目录永远停在首次发布的历史位置，模型看不到当前轮的装载指引。
  let reminderSeen = false
  for (const seq of live) {
    const event = bySeq.get(seq), source = event?.data?.source
    if (event?.type !== 'user/message' || source?.kind !== 'plugin' || source.plugin !== 'dsh-tavern') continue
    if (source.form === SKILL_REMINDER_FORM && Array.isArray(event.data.content) && event.data.content.length) reminderSeen = true
    if (!LATEST_ONLY_FORMS.has(source.form)) continue
    if (Array.isArray(event.data.content) && event.data.content.length) latestOf.set(source.form, seq)
  }
  if (!reminderSeen) {
    for (const event of events) {
      const source = event?.data?.source
      if (event?.type === 'user/message' && source?.kind === 'plugin' && source.plugin === 'dsh-tavern' &&
        source.form === SKILL_REMINDER_FORM && Array.isArray(event.data.content) && event.data.content.length) {
        reminderSeen = true
        break
      }
    }
  }
  let count = retireToolLoads(session, { events, bySeq, live, keepTurn })
  count += retireAbsorbedParkedRows(session, { bySeq, live, reminderCount: reminderSeen ? 1 : 0 })
  for (const seq of live) {
    const event = bySeq.get(seq), data = event?.data, source = data?.source
    if (event?.type !== 'user/message' || source?.kind !== 'plugin' || source.plugin !== 'dsh-tavern') continue
    // 当前轮的内容一律保留：多步回合的 pre-step 会重复触发退役。
    if (Number.isSafeInteger(keepTurn) && Number(source.trace?.turn) === keepTurn) continue
    if (source.form === 'foreground-frame' || source.form === SKILL_REMINDER_FORM) {
      // 帧与技能提醒每轮随输入重发，旧的一律按轮退役。
    } else if (LATEST_ONLY_FORMS.has(source.form)) {
      if (latestOf.get(source.form) === seq && carriesCurrentState(source.form, event)) continue
    } else continue
    if (!Array.isArray(data.content) || !data.content.length) continue
    replaceSessionSurface(session, 'user/message', {
      id: randomUUID(), role: 'user', content: [],
      source: { kind: 'plugin', plugin: 'dsh-tavern', form: source.form, ...(source.trace === undefined ? {} : { trace: source.trace }) }
    }, { start: seq, end: seq, sourceEventSeqs: [seq] })
    count++
  }
  return count
}
