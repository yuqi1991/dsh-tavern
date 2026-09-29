import { createConversationBranches } from './conversation-algebra-branches.js'
import { sessionEvents } from './session-events.js'

/** Journal-first bridge while Chat content mirrors still exist. The durable
 * intent precedes any native writes; the same intent completes on reopening. */
export function createConversationHistory({ chats, flush }) {
  function branches(session, current) {
    return createConversationBranches(session, { flush, writeRegistry: async registry => {
      current.branchRegistry = registry
    } })
  }
  async function prepare(session, current, anchor) {
    return branches(session, structuredClone(current)).plan(anchor)
  }
  async function recover(session, chatId) {
    return chats.update(chatId, async current => {
      const intent = current?.conversationHistoryIntent
      if (!intent) return undefined
      if (intent.sessionId !== session.id) throw new Error('回退恢复会话不匹配')
      const manager = branches(session, current)
      // Lifecycle markers from reopening are unrelated to a logical head. Only
      // permit those markers when no part of this intent has yet been written.
      const events = sessionEvents(session)
      const started = events.some(event => (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction?.operationId === intent.transaction.operationId)
      const transaction = structuredClone(intent.transaction)
      if (!started) {
        const tail = events.filter(event => event.seq > transaction.expectedHead)
        if (tail.some(event => event.type !== 'session/end-seed' || event.surfaceOp !== undefined)) throw new Error('回退意图之后出现其他写入，保持隔离')
        transaction.expectedHead = events.at(-1)?.seq ?? -1
      }
      await manager.commit(transaction)
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
  return Object.freeze({ prepare, recover })
}
