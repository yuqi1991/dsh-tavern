import { producerSource, isProducerSource } from './message-source.js'
import { projectPlayerContent } from './player-input-content.js'
import { assertRescueHistoryEditable } from './chat-history-rescue.js'
import { canUndoRollback, selectSurface, preflightSelectSurface, unchangedSinceRollback } from './surface-restoration.js'
import { rewindBackgroundSurface } from './background-surface.js'
import { releaseOpeningTurn, sessionEvents, appendSessionEvent } from './session-events.js'
import { randomUUID } from 'node:crypto'
import { createRegenerationRecovery } from './regeneration-recovery.js'
import { isDeepStrictEqual } from 'node:util'
import { rollbackAvailability, clearFailedTurnSurface, locateFloorBody, locateRegenerationSurface, failedTurnReplayAvailability } from './rollback-surface.js'
import { assertRegenerationSourceCurrent, replaceLastRound } from './last-round-replacement.js'
import { restoreVariantState, saveVariantState, withoutVariantSettlement } from './variant-state.js'
import { diagnosticIdentity, regenerationTargetDiagnostic } from './regeneration-diagnostics.js'
import { computeFold } from './conversation-algebra/index.js'
import { branchRegistryOf, distinctFloorVariants, floorHostTurn, projectChatFloors } from './floor-projection.js'
import { storyEventTurn } from './story-turn.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

/** Edited input text, or null when unchanged. Empty text never clears input. */
/**
 * The input of a regeneration attempt. The provider never sees the replaced body
 * (the request projection drops it), so without guidance this is a fresh sample
 * of the round. Guidance ("写得更长", "加快节奏") is relative to the current body,
 * so it comes with that body as the draft to revise.
 */
export function regenerationInputText(userText, guidance, rewriteBody) {
  const input = str(userText).trim(), guide = str(guidance).trim(), draft = str(rewriteBody).trim()
  if (draft !== '' && guide !== '') return input + '\n\n【当前正文】\n' + draft + '\n\n【改写要求】\n在当前正文基础上改写本轮正文：' + guide
  return input + (guide !== '' ? '\n\n【本轮补充要求】\n' + guide : '')
}

// What the model saw of a stored reply (same precedence as the body editor).
function replyTextOf(message) { return str(message && (message.projectionText ?? message.sourceText ?? message.text)) }

export function normalizeEditedInput(value, originalUserText) {
  const text = str(value).trim()
  if (text === '' || text === str(originalUserText).trim()) return null
  return text
}

/** Plan the surface replacement that rewrites this round's player-input node
 * with the edited text. The node keeps its original kind-user source, so
 * rollback, replay and suppression logic all keep treating it as the input. */
export function planUserInputSurface(session, oldAssistantSeq, editedText) {
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
  const events = sessionEvents(session)
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const assistantIndex = nodes.indexOf(Number(oldAssistantSeq))
  if (assistantIndex < 0) return null
  for (let index = assistantIndex - 1; index >= 0; index--) {
    const seq = Number(nodes[index])
    const event = bySeq.get(seq)
    const source = event && event.data && event.data.source
    if (!event || event.type !== 'user/message' || !source || source.kind !== 'user') continue
    return {
      data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text: str(editedText) }], source: structuredClone(source) },
      range: { start: seq, end: seq, sourceEventSeqs: [seq] }
    }
  }
  return null
}

export function selectRegenerationTarget(chat, session, observe) {
  const nodes = (session.surface !== undefined && Array.isArray(session.surface.nodes)) ? session.surface.nodes : []
  const eventStart = sessionEvents(session).length
  const msgs0 = chat.messages || []
  let oldAssistantIndex = -1
  for (let i = msgs0.length - 1; i >= 0; i--) {
    const m = msgs0[i]
    if (m !== null && typeof m === 'object' && m.role === 'assistant' && m.greeting !== true) {
      oldAssistantIndex = i
      break
    }
  }
  function report(reason, target) {
    if (typeof observe !== 'function') return
    try { observe(regenerationTargetDiagnostic(chat, session, { reason, assistantIndex: oldAssistantIndex, target })) } catch { /* Diagnostics never change selection. */ }
  }
  if (oldAssistantIndex < 1 || msgs0[oldAssistantIndex - 1] === null || typeof msgs0[oldAssistantIndex - 1] !== 'object' || msgs0[oldAssistantIndex - 1].role !== 'user') {
    report(oldAssistantIndex < 0 ? 'no-non-greeting-assistant' : oldAssistantIndex === 0 ? 'assistant-at-start'
      : msgs0[oldAssistantIndex - 1] === null || typeof msgs0[oldAssistantIndex - 1] !== 'object' ? 'previous-message-invalid' : 'previous-message-not-user')
    throw new Error('没有可重新生成的玩家输入与正文组合')
  }
  // The floor projection names the live body by position: a rerolled floor
  // keeps its chat turn while its body lives on the native turn that generated
  // it, a switched variant is neither, and a body rewritten in an edit step has
  // its own turn number. Native turn arithmetic is only the fallback for logs
  // the projection cannot map.
  const visibleTurn = Number(msgs0[oldAssistantIndex].turn) || msgs0[oldAssistantIndex].turn
  const projection = projectChatFloors(chat, sessionEvents(session), nodes)
  let target = locateFloorBody({ events: sessionEvents(session), nodes, projection, turn: Number(visibleTurn) })
  if (target === null) {
    // The live body is the one on the surface: after switching to a middle
    // variant that is neither the newest generation (host turn) nor the floor's
    // own turn. Legacy reroll copies carry the floor's own turn on the live row.
    const nativeTurn = floorHostTurn(projection, visibleTurn)
    const liveTurn = projection.floors.find(floor => floor.turn === Number(visibleTurn))?.bodyTurn
    for (const turn of new Set([liveTurn, nativeTurn, visibleTurn])) {
      if (!turn) continue
      target = locateRegenerationSurface({ events: sessionEvents(session), nodes, turn })
      if (target !== null) break
    }
  }
  if (target === null) { report('native-target-missing'); throw new Error('原生消息流中找不到与当前剧情轮次对应的正文消息') }
  report('selected', target)
  const oldSeq = target.assistantSeq
  const oldTurn = msgs0[oldAssistantIndex].turn
  const oldSource = target.source
  return { nodes, eventStart, msgs0, oldAssistantIndex, oldSeq, oldTurn, oldSource, userSeq: target.userSeq }
}

/** Last story-body text from the CURRENT fold (post-checkout). `turns` is the
 * set of native turns this floor may occupy (visible turn + its regenerated
 * mapping); an empty set accepts the fold's last body row. */
function variantBodyFromSession(session, turns) {
  const fold = computeFold(sessionEvents(session))
  const rows = fold.views.conversation || []
  const accepted = turns instanceof Set && turns.size > 0 ? turns : null
  let body = null
  for (const row of rows) {
    if (row?.type !== 'assistant/message') continue
    const message = (row.data || {}).message || {}
    if ((message.source || {}).kind !== 'model') continue
    const text = (message.content || []).filter(block => block?.type === 'text').map(block => String(block.text || '')).join('')
    if (text.trim() === '') continue
    if (accepted === null || accepted.has(storyEventTurn(row) || 0)) body = { text, nativeTurn: storyEventTurn(row) || 0 }
  }
  // A checked-out variant whose native turn is outside the mapping (archival
  // edge) still owns the surface: the fold's last body is its body.
  if (body === null) {
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]
      if (row?.type !== 'assistant/message') continue
      const message = (row.data || {}).message || {}
      if ((message.source || {}).kind !== 'model') continue
      const text = (message.content || []).filter(block => block?.type === 'text').map(block => String(block.text || '')).join('')
      if (text.trim() !== '') return { text, nativeTurn: storyEventTurn(row) || 0 }
    }
  }
  return body
}

/**
 * Own replacement/rollback ordering across stored story, DSH surface and scripts.
 * Timeline owns revisions; this module owns the workflow, including aborts.
 * Callers supply host adapters, never intermediate rollback or swipe state.
 */
export function createRoundHistory({ chats, sessions, scripts, timeline, queueSettlement, cancelSettlement, present, diagnostics, sessionPatch, algebraHistory }) {
  const { read: readChat, forSession: chatForSession, readCard: readChatCard,
    readRevision: readChatRevision, write: writeChat, update: updateChat } = chats
  const { read: readScript, continuity: scriptContinuity } = scripts
  const tavernScriptHostAdapter = scripts
  const storyTimeline = timeline
  const view = present
  const pendingRollbacks = new Set()
  const pendingRegenerations = new Set()
  const pendingReplays = new Set()
  const regenerationRecovery = createRegenerationRecovery({ chats, sessions, timeline, isActive: id => pendingRegenerations.has(id), algebraHistory })

  async function regenerate(chatId, guidance, sessionId, inputOverride) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    const chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (!chat) throw new Error('聊天不存在: ' + chatId)
    if (pendingReplays.has(chat.id)) throw new Error('正在重放失败回合，请等待完成')
    if (pendingRegenerations.has(chat.id) || pendingRollbacks.has(chat.id)) throw new Error('正文正在重新生成，请等待完成')
    await regenerationRecovery.recover(chat.id)
    if (pendingReplays.has(chat.id)) throw new Error('正在重放失败回合，请等待完成')
    if (pendingRegenerations.has(chat.id) || pendingRollbacks.has(chat.id)) throw new Error('正文正在重新生成，请等待完成')
    pendingRegenerations.add(chat.id)
    try { return await regenBody(chat.id, guidance, sessionId, inputOverride) }
    finally { pendingRegenerations.delete(chat.id) }
  }

  async function stopRollbackGeneration(chat) {
    const agent = sessions.get(chat.sessionId)
    if (agent?.phase?.kind !== 'running') return
    if (typeof agent.cancel !== 'function') throw new Error('当前宿主不支持停止生成，请先停止后再回退')
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
  }

  function rollbackBodyMessages(chat) {
    return (chat.messages || []).map(({ role, turn, text, sourceText, content, inputAttachments, greeting, swipes, swipeId }) => ({ role, turn, text, sourceText, content, inputAttachments, greeting, swipes, swipeId }))
  }

  function assertRollbackSnapshot(current, expected) {
    if (!isDeepStrictEqual(current, expected)) throw new Error('回退期间聊天已被其他操作修改，请刷新后重试')
  }

  async function prepareRollbackIntent(chat, intent) {
    const target = storyTimeline.rollbackTarget({ chat })
    if (target === null) return intent
    const beforeChat = await readChatRevision(chat.id, target.beforeRevision)
    if (beforeChat === undefined) throw new Error('找不到剧情 checkpoint 对应的历史 Chat revision: ' + target.beforeRevision)
    return Object.assign({}, intent, { beforeChat })
  }
  async function regenBody(chatId, guidance, sessionId, inputOverride) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    let chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (chat === undefined) throw new Error('聊天不存在: ' + chatId)
    assertRescueHistoryEditable(chat)
    const activeRound = Object.values(storyTimeline.inspect({ chat }).operations || {}).find(function (operation) {
      return operation && operation.kind === 'body' && operation.status === 'completed' &&
        operation.background && ['pending', 'running'].includes(str(operation.background.phase))
    })
    if (chat.regenInProgress === true) throw new Error('正文正在重新生成，请等待完成')
    const card = await readChatCard(chat)
    const storedSessionId = chat.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') chat.sessionId = sessionId
    if (typeof chat.sessionId !== 'string' || chat.sessionId === '') throw new Error('会话未绑定 DSH 会话')
    const agent = sessions.get(chat.sessionId)
    if (agent === undefined || agent.session === undefined) throw new Error('无法访问 DSH 会话: ' + chat.sessionId)
    if (agent.phase?.kind === 'running') throw new Error('前台正在生成，请完成或停止后再重新生成')
    const session = agent.session
    let selection, evidence
    try { selection = selectRegenerationTarget(chat, session, diagnostics ? value => { evidence = value } : undefined) }
    finally {
      if (evidence) {
        try { await diagnostics.record(chat.sessionId, { stage: 'regeneration-target', diagnosticId: randomUUID(),
          outcome: evidence.reason === 'selected' ? 'selected' : 'rejected', ...evidence,
          guidanceProvided: typeof guidance === 'string' && guidance.trim().length > 0,
          binding: { requested: diagnosticIdentity(sessionId), stored: diagnosticIdentity(storedSessionId), effective: diagnosticIdentity(chat.sessionId),
            overridden: Boolean(sessionId && sessionId !== storedSessionId) },
          agent: { phase: ['running', 'idle'].includes(agent.phase?.kind) ? agent.phase.kind : 'other', lastTurn: Number.isFinite(agent.phase?.lastTurn) ? agent.phase.lastTurn : null } }) }
        catch { /* Recording failure must not affect regeneration or replace its error. */ }
      }
    }
    const { eventStart, msgs0, oldAssistantIndex, oldSeq, oldTurn } = selection
    const originalUserText = str(msgs0[oldAssistantIndex - 1].text).trim()
    const editedInput = normalizeEditedInput(inputOverride, originalUserText)
    algebraHistory.assertReady()
    // The old body becomes a sibling variant BEFORE the generation — branch +
    // checkout(anchor = the original input node). The synthetic turn then
    // appends onto a clean tail; no fold-back range exists.
    let checkoutIntent
    {
      const nodes = session.surface?.nodes || []
      const bySeq = new Map(sessionEvents(session).map(event => [event.seq, event]))
      let userSeq = null
      for (let index = nodes.indexOf(oldSeq) - 1; index >= 0; index--) {
        const event = bySeq.get(nodes[index])
        const source = event?.data?.source
        if (event?.type === 'user/message' && source?.kind === 'user') { userSeq = nodes[index]; break }
      }
      if (userSeq === null) throw new Error('重新生成的输入锚点不在当前分支')
      // P2-B: tag the saved variant with the chat-visible turn it replaces so
      // the helper surface can enumerate this floor's variants.
      checkoutIntent = await algebraHistory.prepare(session, chat, userSeq, { turn: Number(oldTurn) || undefined })
    }
    if (editedInput !== null && planUserInputSurface(session, oldSeq, editedInput) === null) {
      throw new Error('找不到本轮输入对应的原生消息，无法修改输入')
    }
    let originalChat = structuredClone(chat)
    const operationId = randomUUID()
    async function restoreFailedRegen() {
      await regenerationRecovery.abort({ chatId: chat.id, originalChat, session, eventStart, operationId })
    }
    let legacyBefore = null
    if (storyTimeline.inspect({ chat }).checkpointCount === 0) {
      let rollbackCommit = null
      if (chat.nativeCommits !== null && typeof chat.nativeCommits === 'object') {
        const keys = Object.keys(chat.nativeCommits).map(Number).filter(Number.isFinite).sort(function (a, b) { return b - a })
        for (const key of keys) {
          const value = chat.nativeCommits[String(key)]
          if (value && str(value.userText).trim() === originalUserText) { rollbackCommit = value; break }
        }
      }
      const before = rollbackCommit && rollbackCommit.before && typeof rollbackCommit.before === 'object' ? rollbackCommit.before : {}
      legacyBefore = {
        messages: msgs0.slice(0, oldAssistantIndex - 1), posture: str(before.posture), ledger: before.ledger || null, scriptState: chat.scriptState,
        candidates: null, settleStatus: 'idle', settleError: null, lastSettle: null,
        preparedWorldBookContext: str(before.preparedWorldBookContext),
        preparedWorldBook: before.preparedWorldBook || null,
        participants: {}
      }
      if ((chat.mode || 'story') === 'script') {
        const script = await readScript(chat.cardPath)
        if (script === undefined || !Array.isArray(script.chunks)) throw new Error('剧本文件不存在，无法重新生成正文')
        const revision = before.scriptRevision && typeof before.scriptRevision === 'object' ? before.scriptRevision : null
        const reference = rollbackCommit && rollbackCommit.scriptReference && typeof rollbackCommit.scriptReference === 'object' ? rollbackCommit.scriptReference : null
        legacyBefore.scriptState = scriptContinuity.transition({ script, state: chat.scriptState, event: { kind: 'restore', revision, reference } }).state
      }
    }
    const rollbackIntent = await prepareRollbackIntent(chat, { kind: 'turn.rollback', turn: oldTurn, legacyBefore })
    const lifecycleRevision = Math.max(0, Number(originalChat.tavernHelperLifecycleRevision) || 0) + 1
    chat = await updateChat(chat.id, function (current) {
      if (agent.phase?.kind === 'running' || current.regenInProgress) throw new Error('前台正在生成，请完成或停止后再重新生成')
      assertRegenerationSourceCurrent({ originalChat, currentChat: current, assistantIndex: oldAssistantIndex })
      originalChat = structuredClone(current)
      const next = storyTimeline.apply({ chat: current, intent: rollbackIntent }).chat
      next.regenRecovery = { id: operationId, beforeRevision: Number(current._storageRevision || 0),
        ...(Number(current._storageRevision || 0) ? {} : { before: structuredClone(current) }),
        sessionId: chat.sessionId, eventStart }
      // The pre-planned branch+checkout owns the native surface from here
      // on; a failed native commit keeps this durable intent for recovery.
      next.conversationHistoryIntent = { sessionId: session.id, transaction: checkoutIntent }
      next.regenRecovery.preCheckoutBranchId = checkoutIntent.branchId
      next.tavernHelperLifecycleRevision = lifecycleRevision
      next.regenInProgress = true
      return next
    }, { source: 'rollback.regen' })
    // Commit the checkout before any generation spends a model call:
    // the model must not see the old body.
    chat = await algebraHistory.recover(session, chat.id)
    const rolledMessageCount = (chat.messages || []).length
    const guide = str(guidance).trim()
    // Edited input replaces the original text; guidance still appends as a supplement.
    const syntheticText = regenerationInputText(editedInput !== null ? editedInput : originalUserText, guide, replyTextOf(msgs0[oldAssistantIndex]))
    releaseOpeningTurn(agent.session, agent)
    const beforeLastTurn = agent.phase !== undefined && agent.phase !== null && Number.isFinite(Number(agent.phase.lastTurn)) ? Number(agent.phase.lastTurn) : 0
    let committedChat, body, syntheticTurn
    try {
      if (activeRound !== undefined && typeof cancelSettlement === 'function') await cancelSettlement(chat.id)
      if (agent.phase?.kind === 'running') throw new Error('前台正在生成，未启动重新生成')
      const ready = await readChat(chat.id)
      if (ready?.regenRecovery?.id !== operationId || agent.phase?.kind === 'running') throw new Error('重新生成操作已失效或前台正在生成')
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: projectPlayerContent(msgs0[oldAssistantIndex - 1].inputAttachments, syntheticText),
        source: producerSource('dsh-tavern-regen', { regenerationId: operationId })
      })
      await agent.whenIdle()
      syntheticTurn = agent.phase !== undefined && agent.phase !== null && Number.isFinite(Number(agent.phase.lastTurn)) ? Number(agent.phase.lastTurn) : (beforeLastTurn + 1)
      const latest = await readChat(chat.id)
      if (latest === undefined) {
        throw new Error('聊天不存在: ' + chat.id)
      }
      const latestMsgs = latest.messages || []
      if (latestMsgs.length < rolledMessageCount + 2) {
        throw new Error('重新生成流程未产生新的用户/助手回合')
      }
      const regeneratedUser = latestMsgs[latestMsgs.length - 2]
      const newAssistant = latestMsgs[latestMsgs.length - 1]
      if (regeneratedUser === null || typeof regeneratedUser !== 'object' || regeneratedUser.role !== 'user' ||
          newAssistant === null || typeof newAssistant !== 'object' || newAssistant.role !== 'assistant' || Number(newAssistant.turn) !== syntheticTurn) {
        throw new Error('重新生成流程未产生正文')
      }
      body = str(newAssistant.text).trim()
      if (body === '') {
        throw new Error('重新生成失败：模型返回空文本')
      }
      // After the pre-checkout the generated tail IS the surface; only an
      // edited input rewrites the original node.
      let userProjection = null
      if (editedInput !== null) {
        // Post-checkout the old body is gone from the surface; the original
        // input node is the last kind-user row and keeps its identity/position.
        const nodes = session.surface?.nodes || []
        const bySeq = new Map(sessionEvents(session).map(event => [event.seq, event]))
        const inputEvent = [...nodes].reverse().map(seq => bySeq.get(seq)).find(event =>
          event?.type === 'user/message' && event.data?.source?.kind === 'user' && !event.data?.source?.regenerationId)
        if (inputEvent === undefined) {
          throw new Error('重新生成期间本轮输入的原生消息已变化，未修改输入')
        }
        const inputSource = structuredClone(inputEvent.data.source)
        userProjection = {
          data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text: editedInput }], source: inputSource },
          range: { start: inputEvent.seq, end: inputEvent.seq, sourceEventSeqs: [inputEvent.seq] }
        }
      }
      // The persisted intent must only reference events already on disk.
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      committedChat = await updateChat(latest.id, function (current) {
        if (current?.regenRecovery?.id !== operationId) throw new Error('重新生成操作已失效')
        const currentMessages = Array.isArray(current && current.messages) ? current.messages : []
        const currentUser = currentMessages[currentMessages.length - 2]
        const currentAssistant = currentMessages[currentMessages.length - 1]
        if (currentMessages.length < rolledMessageCount + 2 || currentUser === null || typeof currentUser !== 'object' || currentUser.role !== 'user' ||
            currentAssistant === null || typeof currentAssistant !== 'object' || currentAssistant.role !== 'assistant' || Number(currentAssistant.turn) !== syntheticTurn ||
            str(currentAssistant.text).trim() !== body) throw new Error('重新生成流程的正文已被另一项操作修改')
        const merged = replaceLastRound({ originalChat, regeneratedChat: current, assistantIndex: oldAssistantIndex, inputText: editedInput })
        const next = merged.chat
        // The pre-checkout branch keeps the old body; file its Chat state there.
        const filed = saveVariantState(originalChat.messages[oldAssistantIndex], current.regenRecovery.preCheckoutBranchId)
        if (filed?.variantStates) next.messages[next.messages.length - 1].variantStates = filed.variantStates
        if (next.nativeCommits !== null && typeof next.nativeCommits === 'object') delete next.nativeCommits[String(syntheticTurn)]
        next.nativeCommits = next.nativeCommits && typeof next.nativeCommits === 'object' ? structuredClone(next.nativeCommits) : {}
        if (originalChat.nativeCommits && originalChat.nativeCommits[String(oldTurn)]) {
          const restoredCommit = structuredClone(originalChat.nativeCommits[String(oldTurn)])
          // Future rollbacks match commits by user text; keep it in step with the edit.
          if (editedInput !== null) restoredCommit.userText = editedInput
          next.nativeCommits[String(oldTurn)] = restoredCommit
        }
        // The chat bubble reads this turn's text from runtimeInputs before the
        // merged message; an edited input must rewrite it there too or the
        // surface keeps showing the pre-edit text while the story updates.
        if (editedInput !== null && next.runtimeInputs && typeof next.runtimeInputs === 'object' && !Array.isArray(next.runtimeInputs)
          && next.runtimeInputs[String(oldTurn)] && typeof next.runtimeInputs[String(oldTurn)] === 'object') {
          next.runtimeInputs = structuredClone(next.runtimeInputs)
          next.runtimeInputs[String(oldTurn)] = { ...next.runtimeInputs[String(oldTurn)], source: editedInput, text: editedInput }
        }
        next.regenInProgress = true
        // The synthetic attempt's plugin-input row: retired by complete() so the
        // round keeps exactly one player input (the edited original node).
        const syntheticInputSeq = (() => {
          const nodes = session.surface?.nodes || []
          for (let index = nodes.length - 1; index >= 0; index--) {
            const event = sessionEvents(session).find(item => item.seq === nodes[index])
            if (event?.type === 'user/message' && isProducerSource(event.data?.source, 'dsh-tavern-regen')) return event.seq
          }
          return undefined
        })()
        next.regenRecovery = { ...current.regenRecovery, phase: 'committed',
          ...(Number.isSafeInteger(syntheticInputSeq) ? { syntheticInputSeq } : {}),
          ...(userProjection !== null ? { userProjection } : {}) }
        next.settleStatus = 'pending'
        next.settleError = null
        next.tavernHelperLifecycleRevision = lifecycleRevision + 1
        return next
      }, { source: 'foreground.regen-commit' })
    } catch (error) {
      await restoreFailedRegen()
      throw error
    }
    committedChat = await regenerationRecovery.complete({ chatId: chat.id, session, operationId }) || committedChat
    let settledChat = committedChat
    try {
      await queueSettlement(committedChat.id)
      settledChat = await readChat(committedChat.id) || committedChat
    } catch (error) {
      const message = str(error?.message || error) || '后台结算失败'
      settledChat = await updateChat(committedChat.id, function (current) {
        if (!current || typeof current !== 'object') return current
        current.settleStatus = 'failed'
        current.settleError = message
        return current
      }, { source: 'settlement.regen-failed' })
    }
    const result = await view(settledChat, card)
    result.adopted = { text: body, guidance: guide, hiddenTurn: oldTurn, syntheticTurn: syntheticTurn,
      ...(editedInput !== null ? { inputEdited: true, inputText: editedInput } : {}) }
    return result
  }

  // ---------- 重放失败回合（移除被中断的回复，原样重发本轮输入） ----------
  // A failed turn never commits to the story, so there is nothing to roll back
  // and nothing to replace. Clearing its residue restores the exact request
  // prefix the provider already cached; replaying the same input then only pays
  // for the completion that was interrupted.
  async function replayFailedTurn(chatId, sessionId) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    const chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (chat === undefined || chat === null) throw new Error('聊天不存在: ' + chatId)
    if (pendingReplays.has(chat.id)) throw new Error('正在重放失败回合，请等待完成')
    if (pendingRegenerations.has(chat.id) || chat.regenInProgress === true) throw new Error('正文正在重新生成，请等待完成')
    if (pendingRollbacks.has(chat.id)) throw new Error('正在回退本轮，请等待完成')
    const agent = sessions.get(chat.sessionId)
    if (agent === undefined || agent.session === undefined) throw new Error('无法访问 DSH 会话: ' + chat.sessionId)
    if (agent.phase !== undefined && agent.phase !== null && agent.phase.kind === 'running') throw new Error('正在生成，请先停止后再重新生成')
    const session = agent.session
    const events = sessionEvents(session)
    const replay = failedTurnReplayAvailability({ events, nodes: session.surface?.nodes || [] })
    const target = replay.target
    if (target === null) throw new Error(replay.reason)
    // Read the card before spending a generation: a broken card must fail here,
    // not after the new turn has already committed.
    const card = await readChatCard(chat)
    pendingReplays.add(chat.id)
    try {
      // 1) 移除被中断的内容：清掉失败回合留在原生消息面上的节点。清理钩子
      // 正常已在失败时执行过，此处重复调用对已清理的回合是无操作。
      const cleared = await clearFailedTurnSurface({ session, turn: target.turn, flush: sessions.flush })
      // 2) 同步隐藏该回合残留的正文与错误提示，再原样重发本轮输入。
      await updateChat(chat.id, function (current) {
        if (current === null || typeof current !== 'object') return current
        return {
          ...current,
          acknowledgedFailedTurns: Array.from(new Set([...(Array.isArray(current.acknowledgedFailedTurns) ? current.acknowledgedFailedTurns : []), target.turn]))
            .sort(function (left, right) { return left - right }),
          updatedAt: Date.now()
        }
      }, { source: 'replay.failed-turn' })
      // The replay input is a first-class turn input so the normal foreground
      // prepare/finalize pipeline commits it exactly like a typed message. Its
      // source must stay kind 'user': hosts render anything else as a context
      // node, which would hide the player's text instead of resending it.
      releaseOpeningTurn(agent.session, agent)
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: projectPlayerContent(target.inputAttachments, target.userText),
        source: target.source
      })
      await agent.whenIdle()
      const latest = await readChat(chat.id) || chat
      const result = await view(latest, card)
      result.replayed = { turn: target.turn, userText: target.userText, cleared }
      return result
    } finally {
      pendingReplays.delete(chat.id)
    }
  }

  // ---------- 回退本轮（删除最近一次用户输入 + LLM 输出） ----------
  async function rollbackTurn(sessionId, chatId, expectedTurn) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    const chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (chat === undefined) throw new Error('聊天不存在: ' + chatId)
    if (pendingReplays.has(chat.id)) throw new Error('正在重放失败回合，请等待完成')
    if (pendingRegenerations.has(chat.id) || chat.regenInProgress) throw new Error('正文正在重新生成，请先完成恢复或生成')
    if (pendingRollbacks.has(chat.id)) throw new Error('正在回退本轮，请等待完成')
    pendingRollbacks.add(chat.id)
    let restoredHandle
    try {
      if (!sessions.get(chat.sessionId)?.session && !sessions.getSession?.(chat.sessionId) && typeof sessions.resume === 'function') {
        restoredHandle = await sessions.resume(chat.sessionId)
      }
      return await rollbackChat(chat, expectedTurn, restoredHandle?.agent)
    } finally {
      try { await restoredHandle?.dispose?.() }
      finally { pendingRollbacks.delete(chat.id) }
    }
  }

  async function rollbackChat(chat, requestedTurn, restoredAgent) {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    await stopRollbackGeneration(chat)
    chat = await readChat(chat.id)
    const originalChat = structuredClone(chat)
    const mode = chat.mode || 'story'
    if (mode !== 'story' && mode !== 'script') throw new Error('仅游玩模式支持回退本轮')
    const card = await readChatCard(chat)
    const agent = sessions.get(chat.sessionId) || (restoredAgent?.session?.id === chat.sessionId ? restoredAgent : undefined)
    const session = agent?.session || sessions.getSession?.(chat.sessionId)
    if (!session) throw new Error('无法访问 DSH 会话: ' + chat.sessionId)
    const events = sessionEvents(session)
    const nodes = session.surface !== undefined && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
    const availability = rollbackAvailability(chat, { events, nodes })
    const failedTurns = availability.failedTurns
    if (failedTurns.length) {
      for (const turn of availability.unclearedTurns) await clearFailedTurnSurface({ session, turn, flush: sessions.flush })
      chat = await updateChat(chat.id, current => {
        assertRollbackSnapshot(rollbackBodyMessages(current), rollbackBodyMessages(originalChat))
        assertRollbackSnapshot(current.timeline, originalChat.timeline)
        return { ...current, acknowledgedFailedTurns: [...new Set([...(current.acknowledgedFailedTurns || []), ...failedTurns])].sort((a, b) => a - b), updatedAt: Date.now() }
      }, { source: 'rollback.interrupted' })
      const result = await view(chat, card)
      result.clearedIncompleteTurns = failedTurns
      return result
    }
    const rollbackSurface = availability.target
    if (rollbackSurface === null) throw new Error(availability.reason)
    const hiddenTurn = rollbackSurface.turn
    algebraHistory.assertReady()
    // The availability result came from this same surface: the floor's input is
    // on it, or the surface provably ends before the floor (nothing to clear).
    const start = rollbackSurface.surfaceMissing === true ? nodes.length : nodes.indexOf(rollbackSurface.userSeq)
    if (start < 0) throw new Error('回退输入锚点不在当前分支')
    const algebraIntent = await algebraHistory.prepare(session, chat, start > 0 ? nodes[start - 1] : -1)
    // 1) 定位要回退的最后一组 user + assistant
    const msgs = chat.messages || []
    let assistantIndex = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m !== null && typeof m === 'object' && m.role === 'assistant' && m.greeting !== true) {
        assistantIndex = i
        break
      }
    }
    if (assistantIndex < 0 || assistantIndex - 1 < 0) throw new Error('没有可回退的用户输入与正文组合')
    if (msgs[assistantIndex - 1] === null || typeof msgs[assistantIndex - 1] !== 'object' || msgs[assistantIndex - 1].role !== 'user') throw new Error('最后一组消息不是用户输入 + 正文')
    const expectedTurn = Number(msgs[assistantIndex].turn)
    if (Number(requestedTurn) > 0 && Number(requestedTurn) !== expectedTurn) throw new Error('回退目标已经变化，请刷新后确认实际轮次')
    const removedUserText = str(msgs[assistantIndex - 1].text).trim()
    const removedAssistantText = str(msgs[assistantIndex].text).trim()
    // 2) 旧对话从 native commit 生成一次性迁移 checkpoint；新对话直接使用权威 checkpoint
    let rollbackCommit = null
    let rollbackCommitKey = ''
    if (chat.nativeCommits !== null && typeof chat.nativeCommits === 'object') {
      const keys = Object.keys(chat.nativeCommits).map(Number).filter(Number.isFinite).sort(function (a, b) { return b - a })
      for (const key of keys) {
        const commit = chat.nativeCommits[String(key)]
        if (commit !== null && typeof commit === 'object' && str(commit.userText).trim() === removedUserText) {
          rollbackCommit = commit
          rollbackCommitKey = String(key)
          break
        }
      }
    }
    const before = rollbackCommit !== null && rollbackCommit.before !== null && typeof rollbackCommit.before === 'object' ? rollbackCommit.before : null
    const legacyBefore = {
      messages: msgs.slice(0, assistantIndex - 1),
      posture: before !== null && typeof before.posture === 'string' ? before.posture : '',
      ledger: before?.ledger || null,
      scriptState: chat.scriptState,
      candidates: null,
      settleStatus: 'idle',
      settleError: null,
      lastSettle: null,
      participants: {}
    }
    if (mode === 'script' && storyTimeline.inspect({ chat }).checkpointCount === 0) {
      const script = await readScript(chat.cardPath)
      if (script === undefined || !Array.isArray(script.chunks)) throw new Error('剧本文件不存在，无法回退剧本状态')
      const revision = before !== null && before.scriptRevision !== null && typeof before.scriptRevision === 'object'
        ? before.scriptRevision
        : (before !== null && before.scriptState !== null && typeof before.scriptState === 'object' ? before.scriptState : null)
      const reference = rollbackCommit !== null && rollbackCommit.scriptReference !== null && typeof rollbackCommit.scriptReference === 'object' ? rollbackCommit.scriptReference : null
      legacyBefore.scriptState = scriptContinuity.transition({ script: script, state: chat.scriptState, event: { kind: 'restore', revision: revision, reference: reference } }).state
    }
    let rollbackWarning = ''
    let rollbackIntent
    try {
      rollbackIntent = await prepareRollbackIntent(chat, { kind: 'turn.rollback', turn: hiddenTurn, legacyBefore })
    } catch (error) {
      rollbackWarning = '正文已回退，后台历史快照不可用，保留当前状态：' + str(error?.message || error)
      rollbackIntent = { kind: 'turn.rollback', turn: hiddenTurn, legacyBefore: { ...chat, messages: msgs.slice(0, assistantIndex - 1), candidates: null, settleStatus: 'idle', settleError: null }, allowMissingHistory: true }
    }
    await stopRollbackGeneration(chat)
    if (typeof cancelSettlement === 'function') {
      try { await cancelSettlement(chat.id, { wait: false }) }
      catch (error) { rollbackWarning = '正文已回退，后台停止请求失败：' + str(error?.message || error) }
    }
    for (const participant of Object.values(storyTimeline.inspect({ chat }).participants || {})) {
      const worker = sessions.get(participant.sessionId)
      if (worker && worker !== agent && typeof worker.cancel === 'function') {
        try { worker.cancel({ kind: 'parent' }) } catch { /* Old results are rejected by the new branch. */ }
      }
    }
    const undo = {
      version: 1, id: randomUUID(), ready: false, turn: expectedTurn || hiddenTurn,
      beforeRevision: Number(originalChat._storageRevision || 0),
      ...(Number(originalChat._storageRevision || 0) ? {} : { before: structuredClone(originalChat) }),
      foreground: { sessionId: session.id || chat.sessionId, nodes: [...nodes] }, background: []
    }
    undo.foreground.algebraBranchId = algebraIntent.branchId
    if (undo.before) delete undo.before.rollbackUndo
    const rolled = storyTimeline.apply({ chat, intent: rollbackIntent })
    chat = rolled.chat
    chat.rollbackUndo = undo
    chat.regenInProgress = false
    delete chat.regenRecovery
    if (rollbackCommitKey !== '') delete chat.nativeCommits[rollbackCommitKey]
    chat.tavernHelperLifecycleRevision = Math.max(0, Number(chat.tavernHelperLifecycleRevision) || 0) + 1
    chat.updatedAt = Date.now()
    chat.conversationHistoryIntent = { sessionId: session.id, transaction: algebraIntent }
    chat = await updateChat(chat.id, current => {
      if (!isDeepStrictEqual(rollbackBodyMessages(current), rollbackBodyMessages(originalChat)) || current.timeline?.branchId !== originalChat.timeline?.branchId) throw new Error('回退期间正文已被其他操作修改，请刷新后重试')
      return chat
    }, { source: 'rollback' })

    // 3) 原生消息面：用空消息替换最近一轮的所有 surface 节点（模型不再看到），UI 由客户端隐藏对应 turn tail
    try {
      chat = await algebraHistory.recover(session, chat.id)
    } catch (error) {
      throw new Error('回退尚未完成，恢复意图已保留：' + str(error?.message || error), { cause: error })
    }
    // Rewind immediately after the foreground commit; retain the timeline's retry
    // boundary so the next task can safely retry if this best-effort step fails.
    for (const participant of Object.values(storyTimeline.inspect({ chat }).participants || {})) {
      if (participant.status !== 'needs-rewind' || !participant.sessionId) continue
      let restoredHandle
      try {
        let worker = sessions.get(participant.sessionId)
        let background = worker?.session || sessions.getSession?.(participant.sessionId)
        if (!background && typeof sessions.resume === 'function') {
          restoredHandle = await sessions.resume(participant.sessionId)
          worker = restoredHandle.agent
          background = worker?.session
        }
        if (!background) throw new Error('后台会话尚未加载，将在下次后台任务启动时重试')
        if (worker?.phase?.kind === 'running') {
          worker.cancel({ kind: 'parent' })
        }
        if (typeof worker?.whenIdle === 'function') {
          let timeout
          try {
            await Promise.race([worker.whenIdle(), new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('后台尚未停止，将在下次任务启动时重试')), 3000)
            })])
          } finally { clearTimeout(timeout) }
        }
        if (typeof sessions.flush !== 'function') throw new Error('当前宿主未提供后台会话保存接口')
        const checkpoint = { sessionId: participant.sessionId, nodes: [...background.surface.nodes] }
        await rewindBackgroundSurface(background, participant.rewindTo, { flush: sessions.flush })
        checkpoint.afterCount = sessionEvents(background).length
        undo.background.push(checkpoint)
        await sessions.flush(background)
      } catch (error) {
        rollbackWarning = [rollbackWarning, '正文已回退，后台上下文回退未完成：' + str(error?.message || error)].filter(Boolean).join('；')
      } finally {
        if (restoredHandle) {
          try { await restoredHandle.dispose() }
          catch (error) { rollbackWarning = [rollbackWarning, '后台回退临时会话释放失败：' + str(error?.message || error)].filter(Boolean).join('；') }
        }
      }
    }
    // Notify scripts only after both authoritative story and native surface have committed.
    try {
      await tavernScriptHostAdapter.dispatchEvent({ sessionId: chat.sessionId, chat, name: 'MESSAGE_DELETED', args: [(chat.messages || []).length] })
    } catch (error) { rollbackWarning = '回退已完成，但脚本联动失败：' + str(error?.message || error) }
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      chat = await updateChat(chat.id, current => {
        if (current.timeline?.branchId !== chat.timeline?.branchId || current.timeline?.revision !== chat.timeline?.revision) return current
        current.rollbackUndo = { ...undo, ready: true, branchId: current.timeline.branchId, revision: current.timeline.revision,
          lifecycleRevision: Number(current.tavernHelperLifecycleRevision || 0),
          storageRevision: Number(current._storageRevision || 0) + 1,
          foreground: { ...undo.foreground, afterCount: sessionEvents(session).length } }
        return current
      }, { source: 'rollback.undo-point' })
    } catch (error) { rollbackWarning = [rollbackWarning, '回退已完成，但撤销恢复点保存失败：' + str(error?.message || error)].filter(Boolean).join('；') }
    const result = await view(chat, card)
    if (rollbackWarning !== '') result.rollbackWarning = rollbackWarning
    result.rolledBack = { hiddenTurn: hiddenTurn, removedUserText: removedUserText, removedAssistantText: removedAssistantText }
    return result
  }

  async function undoRollback(sessionId, chatId) {
    const chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (!chat || pendingRollbacks.has(chat.id)) throw new Error('没有可撤销的回退，或正在处理回退')
    pendingRollbacks.add(chat.id)
    const handles = []
    const changed = []
    let committed = false
    try {
      let agent = sessions.get(chat.sessionId)
      let session = agent?.session || sessions.getSession?.(chat.sessionId)
      if (!session && typeof sessions.resume === 'function') {
        const handle = await sessions.resume(chat.sessionId)
        handles.push(handle)
        agent = handle.agent
        session = agent?.session
      }
      if (agent?.phase?.kind === 'running' || !canUndoRollback(chat, session)) throw new Error('撤销回退已失效：对话已有新操作，请刷新页面')
      const saved = chat.rollbackUndo
      const before = saved.before || await readChatRevision(chat.id, saved.beforeRevision)
      if (!before || before.id !== chat.id) throw new Error('找不到回退前的恢复点')
      if (!saved.foreground.algebraBranchId) throw new Error('撤销点缺少保存的分支，不能撤销回退')
      const foregroundIntent = await algebraHistory.prepare(session, chat, saved.foreground.algebraBranchId)
      // Background participants return to their saved surfaces by selection.
      const targets = []
      for (const checkpoint of saved.background) {
        let worker = sessions.get(checkpoint.sessionId)
        let background = worker?.session || sessions.getSession?.(checkpoint.sessionId)
        if (!background && sessions.resume) {
          const handle = await sessions.resume(checkpoint.sessionId)
          handles.push(handle); worker = handle.agent; background = worker?.session
        }
        if (!background || worker?.phase?.kind === 'running' || !unchangedSinceRollback(background, checkpoint.afterCount)) throw new Error('后台上下文已有变化，不能撤销回退')
        targets.push({ session: background, saved: checkpoint })
      }
      for (const target of targets) preflightSelectSurface(target.session, target.saved.nodes)
      for (const target of targets) {
        changed.push({ session: target.session, nodes: [...target.session.surface.nodes] })
        selectSurface(target.session, target.saved.nodes)
        if (sessions.flush) await sessions.flush(target.session)
      }
      let restored = await updateChat(chat.id, current => {
        assertRollbackSnapshot(current, chat)
        const result = storyTimeline.apply({ chat: current, intent: { kind: 'replacement.abort', restoreChat: before } }).chat
        delete result.rollbackUndo
        result.conversationHistoryIntent = { sessionId: session.id, transaction: foregroundIntent }
        result.tavernHelperLifecycleRevision = Number(current.tavernHelperLifecycleRevision || 0) + 1
        for (const participant of Object.values(result.timeline.participants)) {
          const target = targets.find(item => item.saved.sessionId === participant.sessionId)
          if (target) Object.assign(participant, { status: 'current', syncedRevision: result.timeline.revision,
            boundary: target.session.surface.nodes.at(-1) ?? -1, rewindTo: null })
        }
        return result
      }, { source: 'rollback.undo' })
      committed = true
      restored = await algebraHistory.recover(session, chat.id)
      const result = await view(restored, await readChatCard(restored))
      result.undoneRollback = { turn: saved.turn }
      return result
    } catch (error) {
      if (committed) throw new Error('已撤销回退，但界面刷新失败：' + str(error?.message || error), { cause: error })
      // A rejected Chat write must not leave the model on the restored branch.
      for (const target of changed.reverse()) {
        selectSurface(target.session, target.nodes)
        if (sessions.flush) await sessions.flush(target.session)
      }
      throw error
    } finally {
      pendingRollbacks.delete(chat.id)
      for (const handle of handles) await handle.dispose()
    }
  }

  /** Variant switcher (spec §9.2, D4): move the live pointer among the sibling
   * variants of the LAST assistant floor. Variants are branch records tagged
   * with this floor's turn (P2-B); the live generation line is archived as a
   * branch the first time the user leaves it, so every variant — including the
   * current body — is addressable by branchId and the selection persists in
   * the registry's activeBranchId. */
  async function switchVariant(sessionId, chatId, targetIndex) {
    const chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (!chat) throw new Error('聊天不存在: ' + chatId)
    let agent = sessions.get(chat.sessionId)
    // Cold sessions fold read-only variants only; the checkout must reach the
    // writable host Session, so resume it the same way rollback does.
    let restoredHandle
    if (!agent?.session && !sessions.getSession?.(chat.sessionId) && typeof sessions.resume === 'function') {
      restoredHandle = await sessions.resume(chat.sessionId)
      agent = restoredHandle?.agent
    }
    try {
    const session = agent?.session || sessions.getSession?.(chat.sessionId)
    if (!session) throw new Error('无法访问 DSH 会话: ' + chat.sessionId)
    if (agent?.phase?.kind === 'running') throw new Error('前台正在生成，请完成或停止后再切换变体')
    algebraHistory.assertReady()
    const index = Number(targetIndex)
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('变体序号无效: ' + targetIndex)
    const lastAssistant = [...(chat.messages || [])].findLast(message => message && message.role === 'assistant' && message.greeting !== true)
    const turn = Number(lastAssistant?.turn) || 0
    if (turn <= 0) throw new Error('没有可切换的剧情楼层')
    const stored = branchRegistryOf(session)
    const registry = Array.isArray(stored?.branches) ? stored : { branches: [], activeBranchId: null, activeHeadSeq: null }
    // Distinct variants follow creation order. The unregistered live line is
    // the final slot until it is archived by the first switch away from it.
    const variants = distinctFloorVariants(session, turn, registry)
    const liveHead = registry.activeHeadSeq === null || registry.activeHeadSeq === undefined ? null : Number(registry.activeHeadSeq)
    const selectedNow = liveHead === null ? -1 : variants.findIndex(variant => variant.headSeq === liveHead)
    const count = selectedNow >= 0 ? variants.length : 1 + variants.length
    if (index >= count) throw new Error('变体序号超出范围: ' + index + '/' + count)
    let intent
    let leftBranchId = selectedNow >= 0 ? variants[selectedNow].branchId : null
    if (selectedNow < 0 && index === count - 1) {
      // The active, unregistered line is already selected.
      const result = await view(chat, await readChatCard(chat))
      result.switchedVariant = { turn, index }
      return result
    }
    // A click that resolves to the branch already active is a no-op: minting a
    // checkout transaction anyway burns a revision and causes re-render churn.
    if (selectedNow >= 0 && index === selectedNow) {
      const result = await view(chat, await readChatCard(chat))
      result.switchedVariant = { turn, index }
      return result
    }
    const target = variants[index]
    if (!target) throw new Error('变体序号超出范围: ' + index + '/' + count)
    if (selectedNow < 0) {
      // Archive the live line before checking out a saved sibling. The new
      // branch has the greatest headSeq and therefore remains the final slot.
      const liveTip = sessionEvents(session).at(-1)?.seq ?? -1
      const recorded = variants.some(variant => variant.headSeq === liveTip)
      intent = recorded
        ? await algebraHistory.move(session, chat, target.branchId)
        : await algebraHistory.prepare(session, chat, target.branchId, { turn })
      // The live line is kept by its recorded twin or by the archive just planned.
      leftBranchId = recorded ? variants.find(variant => variant.headSeq === liveTip).branchId : intent.branchId
    } else {
      intent = await algebraHistory.move(session, chat, target.branchId)
    }
    const updated = await updateChat(chat.id, current => {
      const next = structuredClone(current)
      next.conversationHistoryIntent = { sessionId: session.id, transaction: intent }
      next.tavernHelperLifecycleRevision = Number(current.tavernHelperLifecycleRevision || 0) + 1
      return next
    }, { source: 'variant.switch' })
    const switched = await algebraHistory.recover(session, chat.id)
    // The checked-out fold now ends with the target variant's body; rewrite the
    // chat's last round so the bubble, helper floors and later reads follow the
    // pointer instead of keeping whatever the last reroll merged.
    const turns = new Set([turn, floorHostTurn(projectChatFloors(switched, sessionEvents(session), session.surface?.nodes || []), turn)].filter(value => value > 0))
    const body = variantBodyFromSession(session, turns)
    if (body !== null) {
      await updateChat(chat.id, current => {
        const messages = Array.isArray(current?.messages) ? [...current.messages] : []
        // Which native row hosts the floor is the floor projection's answer;
        // only the Chat content mirror (ticket 16) still needs the body text.
        const assistantIndex = messages.findLastIndex(message => message && typeof message === 'object' && message.role === 'assistant' && message.greeting !== true)
        if (assistantIndex < 1 || messages[assistantIndex - 1]?.role !== 'user') return current
        // File the variant being left, then bring back the target's own state;
        // a variant generated before filing existed falls back to the baseline.
        const left = saveVariantState(messages[assistantIndex], leftBranchId)
        const restored = restoreVariantState(left, target.branchId, body.text)
        if (restored?.sourceText === body.text) {
          // The visible native row stays the floor's first; the flag makes the
          // presentation publish this variant's body over it.
          messages[assistantIndex] = { ...restored, variantBodyProjection: true }
          return { ...current, messages, updatedAt: Date.now() }
        }
        const assistant = {
          ...(restored || withoutVariantSettlement(left)),
          text: body.text,
          sourceText: body.text,
          projectionText: body.text,
          sessionText: body.text,
          displayText: body.text,
          displayMode: 'markdown',
          displayParts: [{ kind: 'markdown', text: body.text }],
          projectionVersion: 2,
          projectionWarnings: [],
          variantBodyProjection: true,
          turn
        }
        delete assistant.bodyEdit
        delete assistant.displayRuntime
        messages[assistantIndex] = assistant
        return { ...current, messages, updatedAt: Date.now() }
      }, { source: 'variant.switch-body' })
    }
    // Re-read the chat: the body rewrite above landed in a newer revision than
    // `switched`, and the client renders this response directly.
    const latest = await readChat(chat.id)
    const result = await view(latest ?? switched, await readChatCard(latest ?? switched))
    result.switchedVariant = { turn, index }
    return result
    } finally {
      await restoredHandle?.dispose?.()
    }
  }

  return Object.freeze({ regenerate, replayFailed: replayFailedTurn, recover: regenerationRecovery.recover, rollback: rollbackTurn, undoRollback, switchVariant })
}
