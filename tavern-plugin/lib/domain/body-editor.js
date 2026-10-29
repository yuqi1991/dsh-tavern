import { createHash, randomUUID } from 'node:crypto'
import { editableReplyParts } from './reply-presentation.js'
import { locateFloorBody, locateRegenerationSurface } from './rollback-surface.js'
import { floorHostTurn, projectChatFloors } from './floor-projection.js'
import { recordTargetDiagnostic } from './regeneration-diagnostics.js'
import { sessionEvents } from './session-events.js'
import { computeFold, editStep, operationCommitted, runTransaction, waitForTransactionReady } from './conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter, detachedSession } from './conversation-algebra-host-adapter.js'

function latest(chat) {
  const message = chat.messages?.at(-1)
  if (!['story', 'script'].includes(chat.mode || 'story') || message?.role !== 'assistant' || message.greeting) throw new Error('只能编辑最后一轮正文')
  return message
}
function source(message) { return message.projectionText ?? message.sourceText ?? message.text ?? '' }
function token(chat, message) {
  // Template display bookkeeping is not an edit to the authoritative prose.
  const { displayRuntime: _capture, tavernPluginData: _templateCache, ...body } = message
  return createHash('sha256').update(JSON.stringify([chat.id, chat.timeline?.branchId, chat.timeline?.revision, chat.messages.length, body])).digest('hex')
}

/** Reconcile a durable Chat edit to native Surface; retries never duplicate history. */
export async function synchronizeBodyEdits(session, chat, flush, persistChat) {
  const adapter = createConversationAlgebraHostAdapter(session, { flush })
  await waitForTransactionReady(adapter)
  const cleared = []
  for (const message of chat.messages || []) {
    if (!message.bodyEdit) continue
    const { id, seq } = message.bodyEdit
    // Identity is preserved by editStep, so deduplicate by operation.
    if (operationCommitted(sessionEvents(session), id)) continue
    if (!session.surface?.nodes.includes(seq)) {
      // The target left the surface; Chat already holds the edited text.
      cleared.push(id)
      delete message.bodyEdit
      continue
    }
    const state = computeFold(sessionEvents(session))
    await runTransaction(adapter, { expectedHead: state.headSeq, ops: editStep(state, seq, message.text), operationId: id })
  }
  if (cleared.length && typeof persistChat === 'function') await persistChat(chat, cleared)
  return cleared
}

/** Edit prose only; do not replay macros, scripts or settlement. */
export function createBodyEditor({ chats, sessions, timeline, activity, project, present, sessionPatch, assertAlgebraReady, recoverRegeneration, diagnostics }) {
  const pending = new Set()
  function refuseClosedPatch() {
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
  }
  function idle(chat, agent) {
    if (agent?.phase?.kind === 'running' || chat.regenInProgress || ['pending', 'running'].includes(chat.settleStatus) || activity(chat)?.busy) throw new Error('请等待当前生成或后台处理完成后再编辑')
  }
  async function context(sessionId) {
    refuseClosedPatch()
    let chat = await chats.forSession(sessionId)
    if (!chat) throw new Error('会话不存在')
    // An unsettled reroll is finished by its recovery point, not by the player.
    if (chat.regenInProgress && typeof recoverRegeneration === 'function') {
      await recoverRegeneration(chat.id)
      chat = await chats.forSession(sessionId) ?? chat
    }
    const agent = sessions.get(sessionId)
    if (!agent?.session) throw new Error('无法访问原生会话')
    idle(chat, agent)
    await synchronizeBodyEdits(agent.session, chat, sessions.flush, async (dirty, cleared) => {
      const drop = new Set(cleared)
      await chats.update(dirty.id, current => {
        let changed = false
        for (const message of current.messages || []) {
          if (message.bodyEdit && drop.has(message.bodyEdit.id)) {
            delete message.bodyEdit
            changed = true
          }
        }
        return changed ? current : undefined
      }, { source: 'body-edit.stale-clear' })
    })
    const message = latest(chat)
    // The floor projection names the body the surface shows for this floor by
    // position (a switched variant, a reroll hosted on another native turn and
    // a body rewritten in an edit step all stay found); native turn arithmetic
    // is only the fallback for logs the projection cannot map.
    const events = sessionEvents(agent.session), nodes = agent.session.surface?.nodes || []
    const projection = projectChatFloors(chat, events, nodes)
    const target = locateFloorBody({ events, nodes, projection, turn: message.turn })
      ?? locateRegenerationSurface({ events, nodes, turn: floorHostTurn(projection, message.turn) })
    if (!target) {
      await recordTargetDiagnostic(diagnostics, { stage: 'body-edit-target', chat, session: agent.session, reason: 'floor-body-not-on-surface', assistantIndex: chat.messages.length - 1 })
      throw new Error('最后一轮正文已不在当前上下文中，无法编辑；可先回退这一层再继续')
    }
    const parts = editableReplyParts(source(message))
    if (!parts.some(part => part.kind === 'text' && part.text.trim())) throw new Error('这轮只有 HTML，没有可编辑文本')
    return { chat, agent, message, target, parts }
  }
  async function read(sessionId) {
    const { chat, message, parts } = await context(sessionId)
    return { token: token(chat, message), turn: message.turn, parts: parts.map(part => part.kind === 'text' ? part : { kind: part.kind }) }
  }
  async function save(sessionId, input) {
    if (pending.has(sessionId)) throw new Error('正在保存正文，请稍候')
    pending.add(sessionId)
    try {
      const { chat, agent, message, target, parts } = await context(sessionId)
      if (input?.token !== token(chat, message)) throw new Error('正文或会话已变化，请重新打开编辑')
      const texts = input.texts
      if (!Array.isArray(texts) || texts.length !== parts.filter(part => part.kind === 'text').length || texts.some(text => typeof text !== 'string')) throw new Error('编辑文本格式无效')
      if (!texts.some(text => text.trim())) throw new Error('正文不能为空')
      if (texts.some(text => editableReplyParts(text).some(part => part.kind !== 'text'))) throw new Error('这里只能编辑文本，不能新增 HTML')
      let index = 0
      const text = parts.map(part => part.kind === 'text' ? texts[index++] : part.text).join('')
      if (text === source(message)) return present(chat)
      const expectedHead = sessionEvents(agent.session).at(-1)?.seq ?? -1
      const reply = await project(text, chat)
      const patch = {
        sourceText: text, projectionText: text, text: reply.sessionText,
        displayText: reply.displayText, displayMode: reply.displayMode,
        bodyEdit: { id: 'tavern-body-edit:' + randomUUID(), seq: target.assistantSeq, turn: target.turn }
      }
      assertAlgebraReady()
      // Run G4 before publishing the recoverable Chat intent.
      editStep(computeFold(sessionEvents(agent.session)), target.assistantSeq, reply.sessionText)
      if (Array.isArray(message.swipes)) {
        patch.swipes = structuredClone(message.swipes)
        const swipe = Number(message.swipeId) || 0
        if (typeof patch.swipes[swipe] === 'string') patch.swipes[swipe] = text
      }
      // Validate on an isolated native Session before the durable Chat intent.
      // A rejected host event must never publish an edit that future requests
      // will keep trying (and failing) to synchronize. Accepted writes retain
      // the existing journal-first recovery path for disk/flush failures.
      const preview = detachedSession(agent.session)
      await synchronizeBodyEdits(preview, { messages: [{ ...message, ...patch }] }, async () => {})
      const saved = await chats.update(chat.id, current => {
        idle(current, agent)
        if (token(current, latest(current)) !== input.token) throw new Error('正文或会话已变化，请重新打开编辑')
        if (!agent.session.surface?.nodes.includes(target.assistantSeq)) throw new Error('模型上下文已变化，请重新打开编辑')
        if ((sessionEvents(agent.session).at(-1)?.seq ?? -1) !== expectedHead) throw new Error('会话头已变化，请重新打开编辑')
        return timeline.apply({ chat: current, intent: { kind: 'body.edit', turn: message.turn, patch } }).chat
      }, { source: 'foreground.body-edit' })
      await synchronizeBodyEdits(agent.session, saved, sessions.flush)
      return present(saved)
    } finally { pending.delete(sessionId) }
  }
  return Object.freeze({ read, save })
}
