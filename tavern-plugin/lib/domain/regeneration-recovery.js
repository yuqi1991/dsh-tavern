import { replaceSessionSurface } from './session-surface-mutations.js'
import { sessionEvents } from './session-events.js'
import { clearRegenerationAttemptSurface, planRegenerationAttemptCleanup, regenerationAttemptTurns, locateRegenerationSurface } from './rollback-surface.js'
import { commitConversationHistoryTransaction } from './conversation-algebra-history.js'
import { computeFold, runTransaction, waitForTransactionReady } from './conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter } from './conversation-algebra-host-adapter.js'

function committedTransaction(events, operationId) {
  return events.some(event => {
    const tx = (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction
    return tx?.operationId === operationId && ['commit', 'begin-commit'].includes(tx.phase)
  })
}

/** Recover an uncommitted replacement from its durable pre-rollback revision. */
export function createRegenerationRecovery({ chats, sessions, timeline, isActive, algebraHistory }) {
  const recovering = new Map()
  const aborting = new Map()

  async function originalState(chat) {
    const saved = chat.regenRecovery
    if (saved) {
      const before = saved.before || await chats.readRevision(chat.id, saved.beforeRevision)
      if (!before || before.id !== chat.id || before.regenInProgress) throw new Error('找不到重新生成前的存档恢复点')
      return before
    }
    // Old releases wrote only the flag. Walk backwards to the last state before
    // this uninterrupted run of flagged revisions; never guess from message count.
    for (let revision = Number(chat._storageRevision) - 1; revision >= 0; revision--) {
      const before = await chats.readRevision(chat.id, revision)
      if (!before || before.id !== chat.id) break
      if (before.regenInProgress !== true) return before
    }
    throw new Error('找不到旧版重新生成前的历史存档，未修改当前对话')
  }

  function legacyEventStart(before, session) {
    const events = sessionEvents(session)
    const assistant = before.messages?.findLast(message => message.role === 'assistant' && !message.greeting)
    const target = locateRegenerationSurface({ events, nodes: session.surface?.nodes || [], turn: assistant?.turn })
    if (!target) throw new Error('找不到原正文的原生消息，未修改当前对话')
    const attempt = events.find(event => event.seq > target.assistantSeq && event.type === 'user/message' &&
      event.data?.source?.plugin === 'dsh-tavern-regen')
    return attempt ? attempt.seq : events.length
  }

  function canAbort(current, originalChat, operationId) {
    return current && current.regenRecovery?.phase !== 'committed' && current.regenInProgress === true &&
      (!operationId || current.regenRecovery?.id === operationId) &&
      Number(current.tavernHelperLifecycleRevision || 0) <= Number(originalChat.tavernHelperLifecycleRevision || 0) + 1
  }
  function assertNoPlayerInput(events, eventStart) {
    if (events.some(event => event.seq >= eventStart && event.type === 'user/message' && event.data?.source?.kind === 'user')) {
      throw new Error('重新生成后已有新的玩家输入，未清理或覆盖后续对话')
    }
  }

  function abort(input) {
    if (aborting.has(input.chatId)) return aborting.get(input.chatId)
    const pending = abortWork(input).finally(() => { if (aborting.get(input.chatId) === pending) aborting.delete(input.chatId) })
    aborting.set(input.chatId, pending)
    return pending
  }
  async function abortWork({ chatId, originalChat, session, eventStart, operationId }) {
    // Persist the exact branch+checkout intent before the first native write.
    // Retries use this decision even after the new-write switch is disabled.
    await chats.update(chatId, async current => {
      if (!canAbort(current, originalChat, operationId) || current.regenRecovery?.abortTransaction) return
      if (!algebraHistory?.enabled(session.id)) return
      const events = sessionEvents(session)
      assertNoPlayerInput(events, eventStart)
      const nodes = [...session.surface.nodes]
      const cleanup = planRegenerationAttemptCleanup({ events, nodes, eventStart })
      if (!cleanup) return
      if (nodes.at(-1) !== cleanup.end) throw new Error('失败恢复只能移走当前后缀，未修改会话')
      const start = nodes.indexOf(cleanup.start)
      const transaction = await algebraHistory.prepare(session, current, start > 0 ? nodes[start - 1] : -1)
      current.regenRecovery = { ...(current.regenRecovery || {
        sessionId: session.id, eventStart, before: structuredClone(originalChat),
        ...(operationId ? { id: operationId } : {})
      }), abortTransaction: transaction }
      return current
    }, { source: 'foreground.regen-abort-intent' })
    // Hold the Chat transaction across native recovery and restoration.
    return await chats.update(chatId, async current => {
      if (!canAbort(current, originalChat, operationId)) return
      const events = sessionEvents(session)
      assertNoPlayerInput(events, eventStart)
      const abortedTurns = regenerationAttemptTurns({ events, eventStart })
      // Retain the durable recovery point if the native flush fails.
      const transaction = current.regenRecovery?.abortTransaction
      if (transaction) await commitConversationHistoryTransaction(session, current, transaction, sessions.flush)
      else clearRegenerationAttemptSurface({ session, eventStart })
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      const next = timeline.apply({ chat: current, intent: { kind: 'replacement.abort', restoreChat: originalChat } }).chat
      if (transaction) next.branchRegistry = structuredClone(current.branchRegistry)
      delete next.regenInProgress
      delete next.regenRecovery
      next.tavernHelperLifecycleRevision = Number(current.tavernHelperLifecycleRevision || 0) + 1
      next.suppressedDshTurns = [...new Set([...(next.suppressedDshTurns || []), ...abortedTurns])].sort((a, b) => a - b)
      return next
    }, { source: 'foreground.regen-abort' })
  }

  // Chat is already authoritative here. Never roll it back if projecting or
  // flushing the native replacement fails; keep a durable, idempotent intent.
  async function complete({ chatId, session, operationId }) {
    return await chats.update(chatId, async current => {
      const saved = current?.regenRecovery
      if (!saved || saved.phase !== 'committed' || (operationId && saved.id !== operationId)) return
      if (saved.sessionId !== session.id) throw new Error('重新生成恢复会话不匹配')
      const projection = saved.projection
      if (!projection) throw new Error('重新生成缺少已提交正文的投影记录')
      const algebra = algebraHistory?.enabled(session.id) === true
      const intent = 'regen-complete:' + saved.id
      if (algebra && !committedTransaction(sessionEvents(session), intent)) {
        // One transaction owns both writes: an edited player input and its new
        // body commit together, so a crash never shows the superseded pair.
        // Recovery of an interrupted attempt may republish committed branch
        // metadata; route that into the Chat row this mutation already owns.
        const adapter = createConversationAlgebraHostAdapter(session, { flush: sessions.flush, write: registry => { current.branchRegistry = registry } })
        await waitForTransactionReady(adapter)
        if (!committedTransaction(sessionEvents(session), intent)) {
          const state = computeFold(sessionEvents(session))
          const ops = []
          if (saved.userProjection) ops.push({ kind: 'surface-write',
            event: { type: 'user/message', data: saved.userProjection.data },
            intent: { surfaceOp: { op: 'replace', start: saved.userProjection.range.start, end: saved.userProjection.range.end }, sourceEventSeqs: saved.userProjection.range.sourceEventSeqs } })
          ops.push({ kind: 'surface-write',
            event: { type: 'assistant/message', data: { stream: [], ...projection.data } },
            intent: { surfaceOp: { op: 'replace', start: projection.range.start, end: projection.range.end }, sourceEventSeqs: projection.range.sourceEventSeqs } })
          await runTransaction(adapter, { expectedHead: state.headSeq, operationId: intent, ops })
        }
      } else if (!algebra) {
        // An edited player input is committed together with the new body so a
        // crash never leaves the surface showing the superseded input text.
        if (saved.userProjection) replaceSessionSurface(session, 'user/message', saved.userProjection.data, saved.userProjection.range)
        replaceSessionSurface(session, 'assistant/message', projection.data, projection.range)
      }
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      delete current.regenRecovery
      delete current.regenInProgress
      return current
    }, { source: 'foreground.regen-projected' })
  }

  function recover(chatId) {
    if (aborting.has(chatId)) return aborting.get(chatId)
    if (recovering.has(chatId)) return recovering.get(chatId)
    if (isActive(chatId)) return Promise.resolve()
    const pending = recoverWork(chatId).finally(() => { if (recovering.get(chatId) === pending) recovering.delete(chatId) })
    recovering.set(chatId, pending)
    return pending
  }
  async function recoverWork(chatId) {
    let handle
    try {
      if (chats.readState && !(await chats.readState(chatId))?.regenInProgress) return
      const chat = await chats.read(chatId)
      if (!chat || chat.regenInProgress !== true) return
      const sessionId = chat.regenRecovery?.sessionId || chat.sessionId
      let agent = sessions.get(sessionId)
      if (agent?.phase?.kind === 'running') return
      let session = agent?.session || sessions.getSession?.(sessionId)
      if (!session && typeof sessions.resume === 'function') {
        handle = await sessions.resume(sessionId)
        agent = handle.agent
        session = agent?.session
      }
      if (agent?.phase?.kind === 'running') return
      if (!session) throw new Error('无法加载重新生成的原生会话，恢复点已保留')
      if (chat.regenRecovery?.phase === 'committed') return await complete({ chatId, session, operationId: chat.regenRecovery.id })
      const before = await originalState(chat)
      const eventStart = chat.regenRecovery?.eventStart ?? legacyEventStart(before, session)
      if (!Number.isSafeInteger(eventStart) || eventStart < 0 || eventStart > sessionEvents(session).length) {
        throw new Error('重新生成的原生历史边界不匹配，恢复点已保留')
      }
      return await abort({ chatId, originalChat: before, session, eventStart, operationId: chat.regenRecovery?.id })
    } finally {
      if (handle) await handle.dispose()
    }
  }

  return Object.freeze({ recover, abort, complete })
}
