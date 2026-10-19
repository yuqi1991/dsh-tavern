import { randomUUID } from 'node:crypto'
import { sessionEvents } from './session-events.js'
import { createConversationAlgebraHostAdapter, preflightTransaction } from './conversation-algebra-host-adapter.js'
import { branch, checkout, committedMetadata, computeFold, operationCommitted, runTransaction, waitForTransactionReady } from './conversation-algebra/index.js'

/** Branch metadata lives only in the Session log, committed with each
 * selection (ADR-0009). This module never writes Chat or session files. */
export function createConversationBranches(session, { flush }) {
  const adapter = createConversationAlgebraHostAdapter(session, { flush })
  function state() {
    const events = sessionEvents(session)
    return { ...computeFold(events), branchRegistry: committedMetadata(events) }
  }
  async function ready() {
    await waitForTransactionReady(adapter)
  }
  async function plan(ref, label = '回退前 ' + new Date().toISOString(), meta = null) {
    await ready()
    const before = state()
    const saved = branch(before, label, meta)
    const ops = [...saved, ...checkout(before, ref)]
    // Exact native admission, including tool pairing, before a caller publishes
    // its durable Story Timeline intent.
    await preflightTransaction(session, { ops })
    return { version: 1, expectedHead: before.headSeq, operationId: 'checkout:' + randomUUID(), branchId: saved[0].branch.branchId, ops }
  }
  /** Checkout-only intent for pointer moves that must NOT archive the current
   * line (variant switching). The caller's registry projection keeps every
   * existing branch; only activeHeadSeq moves. */
  async function move(ref) {
    await ready()
    const before = state()
    const ops = checkout(before, ref)
    await preflightTransaction(session, { ops })
    return { version: 1, expectedHead: before.headSeq, operationId: 'checkout:' + randomUUID(), branchId: null, ops }
  }
  async function commit(intent) {
    await ready()
    if (operationCommitted(sessionEvents(session), intent.operationId)) return state()
    return (await runTransaction(adapter, intent)).fold
  }
  return Object.freeze({ state, ready, plan, move, commit })
}
