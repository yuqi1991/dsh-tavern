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
    data: { turn, step, message: { id, role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'loaded' }] }] } }
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
  let metadata = { version: 1, branches: [], activeBranchId: null, activeHeadSeq: null }
  let writes = 0
  let checkedOut = null
  return {
    events,
    get writes() { return writes },
    snapshotEvents() { return structuredClone(events) },
    async append(type, data, intent) {
      writes++
      events.push({ type, data: structuredClone(data), seq: events.length, time: 1, ...structuredClone(intent) })
      return events.at(-1)
    },
    async readMetadata() { return structuredClone(metadata) },
    async writeMetadata(value) { metadata = structuredClone(value) },
    async preflightCheckout(nodes) { if (!Array.isArray(nodes)) throw new TypeError('target nodes') },
    async checkout(nodes) { checkedOut = [...nodes] },
    async planCheckout(nodes) { checkedOut = [...nodes]; return [] },
    checkedOut() { return checkedOut === null ? null : [...checkedOut] },
    metadata() { return structuredClone(metadata) }
  }
}
