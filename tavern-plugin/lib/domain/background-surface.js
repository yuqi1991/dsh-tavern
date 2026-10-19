import { sessionEvents } from './session-events.js'
import { randomUUID } from 'node:crypto'
import { computeFold, runTransaction, waitForTransactionReady } from './conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter } from './conversation-algebra-host-adapter.js'

export async function rewindBackgroundSurface(session, boundary, { flush } = {}) {
  if (!Number.isSafeInteger(boundary)) return 0
  const events = sessionEvents(session)
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const bySeq = new Map(events.map(event => [event.seq, event]))
  // A replaced system message gets a new seq but stays at surface position zero.
  // Fixed seeds are not task history, regardless of their current event number.
  const groups = []
  let group = null
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    const id = event?.data?.message?.id || event?.data?.id || ''
    const fixed = event?.type === 'system/message' || String(id).startsWith('tavern-session-prefix:')
    if (fixed || !Number.isSafeInteger(seq) || seq <= boundary) { group = null; continue }
    if (group === null) { group = []; groups.push(group) }
    group.push(seq)
  }
  if (groups.length === 0) return 0
  let source = null
  let turn = 0
  let step = 1
  for (let index = nodes.length - 1; index >= 0; index--) {
    const event = bySeq.get(nodes[index])
    const candidate = event && event.data && event.data.message && event.data.message.source
    if (event && event.type === 'assistant/message' && candidate && candidate.kind === 'model') {
      source = candidate
      turn = Math.max(0, Number(event.data.turn) || 0)
      step = Math.max(1, Number(event.data.step) || 1)
      break
    }
  }
  if (source === null) throw new Error('后台 Agent checkpoint 之后存在消息，但找不到可用的模型来源')
  // One transaction owns every group: either the whole rewind is durable or
  // recovery replays the remainder. Tombstone shape is guarded by the
  // transaction itself (G1/G5), so only the grouping stays here.
  const adapter = createConversationAlgebraHostAdapter(session, { flush })
  await waitForTransactionReady(adapter)
  const state = computeFold(sessionEvents(session))
  const operationId = 'background-rewind:' + randomUUID()
  await runTransaction(adapter, { expectedHead: state.headSeq, operationId, ops: groups.map(shadowed => ({
    kind: 'surface-write',
    event: { type: 'assistant/message', data: { turn, step, stream: [], message: { id: randomUUID(), role: 'assistant', content: [], source } } },
    intent: { surfaceOp: { op: 'replace', start: shadowed[0], end: shadowed[shadowed.length - 1] }, sourceEventSeqs: shadowed }
  })) })
  return groups.reduce((count, group) => count + group.length, 0)
}
