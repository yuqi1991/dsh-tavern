import { committedMetadata } from '../../lib/domain/conversation-algebra/index.js'

export function user(id, text, source = { kind: 'user' }) {
  return { type: 'user/message', data: { id, role: 'user', content: text === null ? [] : [{ type: 'text', text }], source } }
}

export function assistant(id, text, turn, step = 1, source = { kind: 'model', provider: 'fixture', model: 'fixture' }) {
  const content = Array.isArray(text) ? text : text === null ? [] : [{ type: 'text', text }]
  return { type: 'assistant/message', data: { turn, step, stream: [], message: { id, role: 'assistant', content, source } } }
}

export function toolResult(id, callId, turn, step = 1) {
  return {
    type: 'tool/result',
    data: { turn, step, message: { id, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'loaded' }] } }
  }
}

export function appendRaw(events, rows) {
  for (const row of rows) events.push({ ...structuredClone(row), seq: events.length, time: 1, surfaceOp: 'append' })
  return events
}

export function applyWrites(events, writes) {
  for (const write of writes) {
    const intent = write.intent || {}
    const op = intent.surfaceOp
    const surfaceOp = op?.op === 'replace'
      ? { op: 'replace', startSeq: op.startSeq ?? op.start, endSeq: op.endSeq ?? op.end }
      : 'append'
    events.push({ type: write.event.type, data: structuredClone(write.event.data), seq: events.length, time: 1, surfaceOp,
      ...(intent.sourceEventSeqs ? { sourceEventSeqs: [...intent.sourceEventSeqs] } : {}) })
  }
}

export function memoryAdapter(initial = []) {
  const events = structuredClone(initial)
  let writes = 0
  return {
    events,
    get writes() { return writes },
    snapshotEvents() { return structuredClone(events) },
    async append(type, data, intent) {
      writes++
      events.push({ type, data: structuredClone(data), seq: events.length, time: 1, ...structuredClone(intent) })
      return events.at(-1)
    },
    /** Nodes named by the latest surface selection, or null. */
    checkedOut() { return structuredClone(events.findLast(event => event.type === 'dsh-tavern/surface-select')?.data.nodes ?? null) },
    /** Branch metadata committed in the log (its only home). */
    metadata() { return committedMetadata(events) ?? { version: 1, branches: [], activeBranchId: null, activeHeadSeq: null } }
  }
}
