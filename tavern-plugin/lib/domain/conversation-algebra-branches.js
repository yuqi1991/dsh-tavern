import { randomUUID } from 'node:crypto'
import { sessionEvents } from './session-events.js'
import { createConversationAlgebraHostAdapter } from './conversation-algebra-host-adapter.js'
import { branch, checkout, committedMetadata, computeFold, runTransaction, waitForTransactionReady } from './conversation-algebra/index.js'

/** Saved references are projected from committed Session metadata. Callers own
 * the Chat storage transaction; this module never writes Chat or session files. */
export function createConversationBranches(session, { flush, writeRegistry }) {
  if (typeof writeRegistry !== 'function') throw new TypeError('分支操作缺少持久注册表投影')
  const adapter = createConversationAlgebraHostAdapter(session, { flush, write: writeRegistry })
  function state() {
    const events = sessionEvents(session)
    return { ...computeFold(events), branchRegistry: committedMetadata(events) }
  }
  async function ready() {
    await waitForTransactionReady(adapter)
    // A crash after commit can lose only the derived registry write. Replay it
    // even when there is no physically incomplete transaction to recover.
    const registry = committedMetadata(sessionEvents(session))
    if (registry) await writeRegistry(structuredClone(registry))
  }
  async function plan(ref, label = '回退前 ' + new Date().toISOString(), meta = null) {
    await ready()
    const before = state()
    const saved = branch(before, label, meta)
    const ops = [...saved, ...checkout(before, ref)]
    // Exact native admission, including tool pairing, before a caller publishes
    // its durable Story Timeline intent.
    const preview = session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')
    const previewAdapter = createConversationAlgebraHostAdapter(preview, { flush: async () => {}, write: async () => {} })
    await runTransaction(previewAdapter, { ops, operationId: 'preflight:' + randomUUID() })
    return { version: 1, expectedHead: before.headSeq, operationId: 'checkout:' + randomUUID(), branchId: saved[0].branch.branchId, ops }
  }
  /** Checkout-only intent for pointer moves that must NOT archive the current
   * line (variant switching). The caller's registry projection keeps every
   * existing branch; only activeHeadSeq moves. */
  async function move(ref) {
    await ready()
    const before = state()
    const ops = checkout(before, ref)
    const preview = session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')
    const previewAdapter = createConversationAlgebraHostAdapter(preview, { flush: async () => {}, write: async () => {} })
    await runTransaction(previewAdapter, { ops, operationId: 'preflight:' + randomUUID() })
    return { version: 1, expectedHead: before.headSeq, operationId: 'checkout:' + randomUUID(), branchId: null, ops }
  }
  async function commit(intent) {
    await ready()
    const events = sessionEvents(session)
    if (events.some(event => {
      const tx = (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction
      return tx?.operationId === intent.operationId && ['commit','begin-commit'].includes(tx.phase)
    })) return state()
    return (await runTransaction(adapter, intent)).fold
  }
  return Object.freeze({ state, ready, plan, move, commit })
}
