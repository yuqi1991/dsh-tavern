import { randomUUID } from 'node:crypto'
import { computeFold, runTransaction, waitForTransactionReady } from './conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter } from './conversation-algebra-host-adapter.js'
import { sessionEvents } from './session-events.js'

/** Write one model-surface event as a guarded, durable transaction: the only
 * way plugin code changes the surface outside the algebra's own operations.
 *
 * `plan(events, nodes)` runs after pending transactions drain and against the
 * head the transaction is guarded by, so what it saw is what it replaces. It
 * returns `{ type, data, intent }`, or null when there is nothing to write.
 * The committed event is returned, or null.
 */
export async function writeSurfaceEvent(session, { operation, flush, plan }) {
  if (typeof flush !== 'function') throw new TypeError('Session surface 写入缺少会话 flush')
  const adapter = createConversationAlgebraHostAdapter(session, { flush })
  await waitForTransactionReady(adapter)
  const events = sessionEvents(session)
  const planned = plan(events, session.surface?.nodes || [])
  if (planned === null || planned === undefined) return null
  const operationId = operation + ':' + randomUUID()
  await runTransaction(adapter, { expectedHead: computeFold(events).headSeq, operationId, ops: [{
    kind: 'surface-write', event: { type: planned.type, data: planned.data }, intent: planned.intent
  }] })
  return sessionEvents(session).findLast(event => event.data?.source?.conversationTransaction?.operationId === operationId
    || event.data?.message?.source?.conversationTransaction?.operationId === operationId) ?? null
}
