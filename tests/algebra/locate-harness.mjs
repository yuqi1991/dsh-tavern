// Multi-floor product harness for "operations are never refused for failing to
// locate" tests. It drives the REAL createRoundHistory / createBodyEditor with a
// real host Session (patched with surface selection) and a Story Timeline Chat,
// so a scenario is a sequence of product calls over realistic logs: turn/step
// lifecycle, user rows inside the turn, edit steps with their own turn number.
import { Session } from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import { createRoundHistory } from '../../lib/domain/round-history.js'
import { createBodyEditor } from '../../lib/domain/body-editor.js'
import { createStoryTimeline } from '../../lib/domain/story-timeline.js'
import { createConversationHistory } from '../../lib/domain/conversation-algebra-history.js'
import { computeFold } from '../../lib/domain/conversation-algebra/index.js'
import { appendSessionEvent, sessionEvents } from '../../lib/domain/session-events.js'
import { producerSource } from '../../lib/domain/message-source.js'
import { projectReplyLayers } from '../../lib/domain/reply-presentation.js'
import { rollbackAvailability } from '../../lib/domain/rollback-surface.js'
import { projectChatFloors } from '../../lib/domain/floor-projection.js'

export const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }

export async function withHostPatch(run) {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try { return await run() } finally { patch.dispose() }
}

/** One Chat + one Session. `play()` adds a floor; every other method is a product entry. */
export function createPlayHarness({ frames = false } = {}) {
  const calls = [], revisions = new Map()
  let counter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++counter) })
  let chat = { id: 'chat', sessionId: 'session', mode: 'story', _storageRevision: 1,
    messages: [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }],
    posture: '门外', scriptState: { cursor: 0 }, settleStatus: 'done' }
  revisions.set(1, structuredClone(chat))
  let session = Session.create('session')
  // The reserved system head and the greeting live in the opening turn.
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  appendSessionEvent(session, 'system/message', { turn: 1, step: 1, message: { id: 'head', role: 'system', content: [], source: producerSource('@deepseek-ai/dsh-system-prompt', undefined, 'system') } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'greeting', role: 'assistant', source: MODEL, content: [{ type: 'text', text: '开场' }] } }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const agent = { get session() { return session }, phase: { kind: 'idle', lastTurn: 1 }, followup(message) { calls.push('followup'); agent.input = message }, async whenIdle() {
    if (harness.generation === 'throw') throw new Error('fixture generation failed')
    const input = agent.input
    await generate(input.content[0].text, { source: input.source, id: input.id })
  } }
  const bodyOf = turn => '正文' + turn
  /** Append one round to the Session log (user row, optional tool step, body).
   * `chatToo: false` leaves the Chat behind, as after a crash between the two writes. */
  function appendRound(turn, userText, text, { source = { kind: 'user' }, id, tools = false } = {}) {
    session.append('turn/start', { turn })
    appendSessionEvent(session, 'user/message', { id: id ?? 'input-' + turn, role: 'user', content: [{ type: 'text', text: userText }], source, turn }, { surfaceOp: 'append' })
    if (frames) appendSessionEvent(session, 'user/message', { id: 'frame-' + turn, role: 'user', content: [{ type: 'text', text: '[帧]' }], source: producerSource('dsh-tavern', { form: 'foreground-frame' }) }, { surfaceOp: 'append' })
    let step = 1
    if (tools) {
      session.append('step/start', { turn, step })
      appendSessionEvent(session, 'assistant/message', { turn, step, message: { id: 'call-' + turn, role: 'assistant', source: MODEL, content: [{ type: 'tool-call', id: 'c' + turn, name: 'lookup', input: {} }] } }, { surfaceOp: 'append' })
      appendSessionEvent(session, 'tool/result', { turn, step, message: { id: 'result-' + turn, role: 'tool', toolCallId: 'c' + turn, source: { kind: 'tool', callId: 'c' + turn }, content: [{ type: 'tool-result', toolCallId: 'c' + turn, content: [{ type: 'text', text: '查到了' }] }] } }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step })
      step++
    }
    session.append('step/start', { turn, step })
    appendSessionEvent(session, 'assistant/message', { turn, step, message: { id: 'reply-' + turn, role: 'assistant', source: MODEL, content: [{ type: 'text', text }] } }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  async function generate(userText, { source = { kind: 'user' }, id, body, tools = false, chatToo = true } = {}) {
    const turn = ++agent.phase.lastTurn
    const text = body ?? (harness.bodyFor ? harness.bodyFor(turn) : bodyOf(turn))
    if (chatToo) {
      const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText } })
      const before = chat._storageRevision
      revisions.set(before, structuredClone(chat))
      chat = timeline.complete({ chat: begun.chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' }, apply(draft) {
        draft.messages.push({ role: 'user', text: userText, sourceText: userText },
          { role: 'assistant', turn, text, sourceText: text, projectionText: text, sessionText: text, displayText: text })
      } }).chat
      chat._storageRevision = before + 1
    }
    appendRound(turn, userText, text, { source, id, tools })
    return turn
  }
  const crashes = new Set()
  const diagnosticRecords = []
  const diagnostics = { record: async (sessionId, value) => { diagnosticRecords.push({ sessionId, ...value }) } }
  const chats = {
    read: async () => structuredClone(chat), forSession: async () => structuredClone(chat), readCard: async () => ({ name: '角色' }),
    readRevision: async (_id, revision) => revisions.get(revision),
    write: async (value, metadata) => { calls.push(metadata.source); chat = structuredClone(value); return structuredClone(chat) },
    update: async (_id, mutate, metadata) => {
      if (crashes.delete(metadata.source)) throw new Error('simulated crash before ' + metadata.source)
      calls.push(metadata.source)
      const revision = chat._storageRevision
      revisions.set(revision, structuredClone(chat))
      const next = await mutate(structuredClone(chat))
      chat = next ?? chat
      chat._storageRevision = revision + 1
      return structuredClone(chat)
    }
  }
  let tornTransaction = false
  const sessions = { get: () => agent, getSession: () => session, flush: async () => {
    // A multi-write transaction whose first write reached the log but not the rest.
    const last = sessionEvents(session).at(-1)
    const tag = (last?.type === 'user/message' ? last.data : last?.data?.message)?.source?.conversationTransaction
    if (tornTransaction && tag?.phase === 'begin') { tornTransaction = false; throw new Error('simulated crash after the first write of ' + tag.operationId) }
  } }
  const options = { chats, sessions, timeline,
    scripts: { read: async () => ({ chunks: ['一'] }), continuity: { transition: () => ({ state: { cursor: 0 } }) }, dispatchEvent: async () => {} },
    queueSettlement: async () => { calls.push('settlement'); chat = { ...chat, settleStatus: 'done' } }, cancelSettlement: async () => {},
    present: async value => structuredClone(value), diagnostics,
    algebraHistory: { ...createConversationHistory({ chats, flush: sessions.flush }), assertReady: () => {} } }
  const editor = createBodyEditor({
    assertAlgebraReady: () => {}, diagnostics, recoverRegeneration: chatId => createRoundHistory(options).recover(chatId), chats, sessions, timeline, activity: () => ({ busy: false }),
    project: async text => projectReplyLayers(text), present: async value => value })
  const harness = {
    calls, agent, timeline, diagnosticRecords,
    /** The next Chat write with this `source` never happens (process death before it). */
    crashBefore(source) { crashes.add(source) },
    /** The next multi-write transaction dies after its first write (torn log tail). */
    tearNextTransaction() { tornTransaction = true },
    get session() { return session },
    /** Sessions edited by builds before tavernStoryTurn existed: edit-step bodies keep only their own turn. */
    stripStoryTurns() { harness.rewriteLog(events => { for (const event of events) { const source = event.data?.message?.source; if (source && source.tavernStoryTurn !== undefined) delete source.tavernStoryTurn } return events }) },
    /** Reopen the Session from a rewritten copy of its log (legacy shapes, crash tails). */
    rewriteLog(mutate) { const events = mutate(structuredClone(sessionEvents(session))); session = Session.create(session.id, events, session.header) }, generation: 'success', bodyFor: null,
    get chat() { return chat }, set chat(value) { chat = value },
    get events() { return sessionEvents(session) },
    get fold() { return computeFold(sessionEvents(session)) },
    async play(userText = '输入', body, options = {}) { return generate(userText, { body, ...options }) },
    /** A completed round in the log that the Chat never recorded. */
    async playLogOnly(userText = '孤儿输入', body) { return generate(userText, { body, chatToo: false }) },
    /** A bare surface selection, as left by an interrupted or foreign writer. */
    selectNodes(nodes) { appendSessionEvent(session, 'dsh-tavern/surface-select', { version: 1, nodes: [...nodes], source: producerSource('dsh-tavern', { form: 'surface-select' }) }) },
    history: () => createRoundHistory(options),
    editor,
    async rollback(expectedTurn) { return harness.history().rollback('session', 'chat', expectedTurn) },
    async undo() { return harness.history().undoRollback('session', 'chat') },
    async regenerate(guidance = '', input) { return harness.history().regenerate('chat', guidance, 'session', input) },
    async switchVariant(index) { return harness.history().switchVariant('session', 'chat', index) },
    async editBody(text) {
      const edit = await editor.read('session')
      const texts = edit.parts.filter(part => part.kind === 'text').map((_, i) => i === 0 ? text : '')
      return editor.save('session', { token: edit.token, texts })
    },
    availability() { return rollbackAvailability(chat, { events: sessionEvents(session), nodes: session.surface.nodes }) },
    floors() { return projectChatFloors(chat, sessionEvents(session), session.surface.nodes) },
    /** Visible conversation texts, oldest first, from the host's own derivation. */
    transcript() { return session.deriveMessages().filter(message => ['user', 'assistant'].includes(message.role) && message.content?.some?.(block => block.type === 'text' && block.text)).map(message => message.content.map(block => block.text ?? '').join('')) },
    surfaceBodies() { return harness.fold.rows.filter(row => row.type === 'assistant/message').map(row => row.data.message.content.map(block => block.text ?? '').join('')) },
    surfaceInputs() { return harness.fold.rows.filter(row => row.type === 'user/message' && row.data.source?.kind === 'user').map(row => row.data.content.map(block => block.text ?? '').join('')) }
  }
  return harness
}
