import { guardDropTagged, guardEdit, guardStepComplete, guardTombstoneSource, messageOf, SCAFFOLD_TAGS } from './guards.js'
import { computeFold } from './fold.js'

function clone(value) {
  return structuredClone(value)
}

function content(value) {
  return Array.isArray(value) ? clone(value) : [{ type: 'text', text: String(value ?? '') }]
}

function findStep(state, ref) {
  const value = typeof ref === 'object' && ref !== null ? ref.seq ?? ref.anchorSeq ?? ref.ref : ref
  return state?.steps?.find(step => step.ref === value || step.anchorSeq === value || step.ref === `seq:${value}`)
}

function replacement(event, data) {
  return {
    kind: 'surface-write',
    event: { type: event.type, data },
    intent: { surfaceOp: { op: 'replace', start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] }
  }
}

function tombstone(event, tag) {
  guardTombstoneSource(event)
  const original = messageOf(event)
  const id = `conversation-tombstone:${tag}:${event.seq}`
  if (event.type === 'assistant/message') {
    return replacement(event, { ...clone(event.data), stream: [], message: { ...clone(original), id, content: [] } })
  }
  if (event.type === 'system/message') {
    return replacement(event, { ...clone(event.data), message: { ...clone(original), id, content: [] } })
  }
  return replacement(event, {
    id, role: 'user', content: [],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: tag, retiredSeq: event.seq }
  })
}

export function appendStep(state, step) {
  const rows = Array.isArray(step?.rows) ? step.rows : Array.isArray(step) ? step : []
  guardStepComplete({ rows })
  return rows.filter(row => ['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(row.type)).map(row => ({
    kind: 'surface-write', event: { type: row.type, data: clone(row.data) }, intent: { surfaceOp: 'append' }
  }))
}

export function editStep(state, ref, nextContent) {
  const step = findStep(state, ref)
  guardEdit(step)
  const event = step.rows[0]
  const message = messageOf(event)
  const nextMessage = { ...clone(message), content: content(nextContent) }
  const data = event.type === 'user/message' ? nextMessage : { ...clone(event.data), message: nextMessage }
  return [replacement(event, data)]
}

export function dropTagged(state, tag) {
  if (!SCAFFOLD_TAGS.has(tag)) guardDropTagged({ rows: [] }, tag)
  const targets = (state?.steps || []).filter(step => step.tag === tag)
  for (const step of targets) guardDropTagged(step, tag)
  return targets.flatMap(step => step.rows.map(row => tombstone(row, tag)))
}

export function branch(state, label) {
  const existing = Array.isArray(state?.branchRegistry?.branches) ? state.branchRegistry.branches : []
  const id = `branch-${Math.max(-1, state?.headSeq ?? -1)}-${existing.length + 1}`
  return [{ kind: 'branch', branch: {
    branchId: id,
    label: String(label || id),
    anchorSeq: state?.surfaceNodes?.at(-1) ?? null,
    headSeq: state?.headSeq ?? -1,
    createdAt: Date.now(),
    active: false
  } }]
}

export function checkout(state, ref) {
  const registry = state?.branchRegistry
  const branches = Array.isArray(registry?.branches) ? registry.branches : []
  const target = typeof ref === 'string' ? branches.find(item => item.branchId === ref) : null
  const headSeq = target ? target.headSeq : (typeof ref === 'object' && ref !== null ? ref.seq ?? ref.anchorSeq : ref)
  if (!Number.isSafeInteger(headSeq) || headSeq < -1 || headSeq > state.headSeq) throw new TypeError('checkout ref 无效')
  const events = Array.isArray(state?.events) ? state.events : []
  const targetNodes = headSeq < 0 ? [] : computeFold(events.filter(event => event.seq <= headSeq)).surfaceNodes
  return [{ kind: 'checkout', branchId: target?.branchId ?? null, headSeq, targetNodes }]
}
