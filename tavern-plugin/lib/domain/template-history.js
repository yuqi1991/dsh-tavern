import { randomUUID } from 'node:crypto'
import { sessionEvents } from './session-events.js'
import { computeFold, editStep, operationCommitted, runTransaction, waitForTransactionReady } from './conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter, detachedSession } from './conversation-algebra-host-adapter.js'

const body = message => String(message?.text ?? '')
const textOf = message => (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')

function editedContent(original, text) {
  let replaced = false
  const content = original.content.flatMap(block => {
    if (block.type !== 'text') return [block]
    if (replaced) return []
    replaced = true
    return [{ type: 'text', text }]
  })
  if (!replaced) content.push({ type: 'text', text })
  return content
}

function templateEdit(state, seq, text) {
  const target = state.events.find(event => event.seq === seq)
  const original = target?.type === 'assistant/message' ? target.data.message : target?.data
  if (!original) throw new Error('模板历史目标消息不存在')
  return editStep(state, seq, editedContent(original, text))
}

/** Journal a template rewrite against its exact existing native message; never edit old events. */
export async function prepareTemplateHistory(session, before, after) {
  const events = sessionEvents(session), bySeq = new Map(events.map(event => [event.seq, event]))
  const fold = computeFold(events)
  let preview, previewAdapter
  const nodes = (session.surface?.nodes || []).map(seq => bySeq.get(seq)).filter(Boolean)
  // Index each active message once. Archived/unmatched chat rows must not
  // repeatedly rescan the entire remaining surface either.
  const positions = new Map()
  const messageTypes = new Set(before.messages.map(message => message.role + '/message'))
  nodes.forEach((event, offset) => {
    if (!messageTypes.has(event.type)) return
    const key = event.type + '\0' + textOf(event.type === 'assistant/message' ? event.data.message : event.data)
    if (!positions.has(key)) positions.set(key, [])
    positions.get(key).push(offset)
  })
  function firstAtOrAfter(offsets, cursor) {
    if (!offsets) return -1
    let lo = 0, hi = offsets.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (offsets[mid] < cursor) lo = mid + 1
      else hi = mid
    }
    return offsets[lo] ?? -1
  }
  let cursor = 0
  for (let index = 0; index < before.messages.length; index++) {
    const old = before.messages[index], next = after.messages[index]
    const texts = new Set([body(old), old.sourceText, old.sessionText, old.templateInputSource].filter(value => typeof value === 'string'))
    let at = -1
    for (const text of texts) {
      const candidate = firstAtOrAfter(positions.get(old.role + '/message\0' + text), cursor)
      if (candidate >= 0 && (at < 0 || candidate < at)) at = candidate
    }
    if (at >= 0) cursor = at + 1
    const inputRewrite = old.templateInputSource && at >= 0 && textOf(nodes[at].data) !== body(next)
    if (body(old) === body(next) && !inputRewrite) continue
    // A retry must keep the durable operationId already published to Chat.
    // A fresh prepare still replaces the marker when the text really changed.
    if (old === next && next.templateHistoryEdit) continue
    // Archived messages outside the active surface have no native message to replace.
    if (at < 0) continue
    const target = nodes[at]
    const id = 'tavern-template-edit:' + randomUUID()
    const ops = templateEdit(fold, target.seq, body(next))
    // Check the exact transaction, including its source metadata, before
    // publishing the recoverable Chat intent.
    if (!preview) {
      preview = detachedSession(session)
      previewAdapter = createConversationAlgebraHostAdapter(preview, { flush: async () => {} })
    }
    await runTransaction(previewAdapter, { expectedHead: sessionEvents(preview).at(-1)?.seq ?? -1,
      ops, operationId: 'preflight:' + id })
    next.templateHistoryEdit = { id, seq: target.seq, role: old.role, turn: target.data.turn || next.turn || 1 }
  }
  return after
}

export async function synchronizeTemplateHistory(session, chat, flush) {
  await prepareTemplateHistory(session, chat, chat)
  const edits = (chat.messages || []).map(message => [message, message.templateHistoryEdit]).filter(([, edit]) => edit)
  if (!edits.length) return
  const adapter = createConversationAlgebraHostAdapter(session, { flush })
  await waitForTransactionReady(adapter)
  for (const [message, edit] of edits) {
    if (operationCommitted(sessionEvents(session), edit.id) || !session.surface?.nodes.includes(edit.seq)) continue
    const state = computeFold(sessionEvents(session))
    await runTransaction(adapter, { expectedHead: state.headSeq,
      ops: templateEdit(state, edit.seq, body(message)), operationId: edit.id })
  }
}
