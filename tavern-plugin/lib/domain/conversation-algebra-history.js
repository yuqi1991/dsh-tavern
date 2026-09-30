import { createConversationBranches } from './conversation-algebra-branches.js'
import { sessionEvents } from './session-events.js'

export async function commitConversationHistoryTransaction(session, current, intent, flush) {
  const manager = createConversationBranches(session, { flush, writeRegistry: async registry => { current.branchRegistry = registry } })
  const events = sessionEvents(session)
  const started = events.some(event => (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction?.operationId === intent.operationId)
  const transaction = structuredClone(intent)
  if (!started) {
    const tail = events.filter(event => event.seq > transaction.expectedHead)
    if (tail.some(event => event.type !== 'session/end-seed' || event.surfaceOp !== undefined)) throw new Error('回退意图之后出现其他写入，保持隔离')
    transaction.expectedHead = events.at(-1)?.seq ?? -1
  }
  return manager.commit(transaction)
}

/** Journal-first bridge while Chat content mirrors still exist. The durable
 * intent precedes any native writes; the same intent completes on reopening. */
export function createConversationHistory({ chats, flush }) {
  function branches(session, current) {
    return createConversationBranches(session, { flush, writeRegistry: async registry => {
      current.branchRegistry = registry
    } })
  }
  async function prepare(session, current, anchor, meta = null) {
    return branches(session, structuredClone(current)).plan(anchor, undefined, meta)
  }
  /** Checkout-only pointer move (variant switching); never archives a branch. */
  async function move(session, current, ref) {
    return branches(session, structuredClone(current)).move(ref)
  }

  /** Commit a prepared intent immediately, updating the Chat row's registry. */
  async function commit(session, current, intent) {
    return await commitConversationHistoryTransaction(session, structuredClone(current), structuredClone(intent), flush)
  }
  async function recover(session, chatId) {
    return chats.update(chatId, async current => {
      const intent = current?.conversationHistoryIntent
      if (!intent) return undefined
      if (intent.sessionId !== session.id) throw new Error('回退恢复会话不匹配')
      // Lifecycle markers from reopening are unrelated to a logical head. Only
      // permit those markers when no part of this intent has yet been written.
      await commitConversationHistoryTransaction(session, current, intent.transaction, flush)
      delete current.conversationHistoryIntent
      if (current.rollbackUndo?.foreground?.algebraBranchId && current.rollbackUndo.ready !== true) {
        // If the process died before optional background rewind, leave those
        // participants marked needs-rewind; the foreground branch still has an
        // exact, independently recoverable undo point.
        current.rollbackUndo = { ...current.rollbackUndo, ready: true,
          branchId: current.timeline?.branchId, revision: current.timeline?.revision,
          lifecycleRevision: Number(current.tavernHelperLifecycleRevision || 0),
          storageRevision: Number(current._storageRevision || 0) + 1,
          foreground: { ...current.rollbackUndo.foreground, afterCount: sessionEvents(session).length } }
      }
      return current
    }, { source: 'conversation-algebra.history-recover' })
  }
  return Object.freeze({ prepare, move, commit, recover })
}
