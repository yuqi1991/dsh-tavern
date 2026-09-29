// Item-5 preflight harness: pin the CURRENT edited-input reroll behavior before
// migrating it to editStep+checkout+generate(). These tests describe legacy
// semantics — when the migration lands they are rewritten to the algebra
// composition, not deleted silently.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { createRoundHistory } from '../../tavern-plugin/lib/domain/round-history.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { createConversationHistory } from '../../tavern-plugin/lib/domain/conversation-algebra-history.js'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { appendSessionEvent } from '../../tavern-plugin/lib/domain/session-events.js'

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }

/** Minimal product-shaped fixture: one committed round, agent generates on followup. */
function harness({ algebra = true, editedText = null } = {}) {
  const calls = [], revisions = new Map()
  let counter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++counter) })
  let chat = { id: 'chat', sessionId: 'session', mode: 'story', _storageRevision: 1,
    messages: [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }],
    posture: '门外', scriptState: { cursor: 0 }, settleStatus: 'done' }
  const pair = [{ role: 'user', text: '推门', sourceText: '推门' }, { role: 'assistant', turn: 2, text: '旧正文', sourceText: '旧正文', swipes: ['旧正文'], swipeId: 0 }]
  revisions.set(1, structuredClone(chat))
  const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 2, userText: '推门' } })
  chat = timeline.complete({ chat: begun.chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' }, apply(draft) { draft.messages.push(...pair) } }).chat
  const settlement = timeline.apply({ chat, intent: { kind: 'agent.begin', role: 'settlement' } })
  chat = timeline.complete({ chat: settlement.chat, operationId: settlement.value.operationId, basedOn: settlement.value.basedOn, outcome: { status: 'success' } }).chat
  chat._storageRevision = 2
  revisions.set(2, structuredClone(chat))

  const session = Session.create('session')
  appendSessionEvent(session, 'user/message', { id: 'input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '推门' }] }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 2, step: 1, message: { id: 'reply', role: 'assistant', source: MODEL, content: [{ type: 'text', text: '旧正文' }] } }, { surfaceOp: 'append' })

  let generation = 'success'
  const agent = { session, phase: { lastTurn: 2 }, followup(message) { calls.push('followup'); agent.input = message }, async whenIdle() {
    const turn = ++agent.phase.lastTurn
    if (generation === 'throw') throw new Error('fixture generation failed')
    const text = '新正文' + turn
    const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText: agent.input.content[0].text } })
    revisions.set(chat._storageRevision, structuredClone(chat))
    chat = timeline.complete({ chat: begun.chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' }, apply(draft) {
      draft.messages.push({ role: 'user', text: agent.input.content[0].text, sourceText: agent.input.content[0].text },
        { role: 'assistant', turn, text, sourceText: text, swipes: [text], swipeId: 0 })
    } }).chat
    appendSessionEvent(session, 'user/message', { ...agent.input, turn }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', { turn, step: 1, message: { id: 'gen-' + turn, role: 'assistant', source: MODEL, content: [{ type: 'text', text }] } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  } }
  const chats = {
    read: async () => structuredClone(chat), forSession: async () => structuredClone(chat), readCard: async () => ({ name: '角色' }),
    readRevision: async (_id, revision) => revisions.get(revision),
    write: async (value, metadata) => { calls.push(metadata.source); chat = structuredClone(value); return structuredClone(chat) },
    update: async (_id, mutate, metadata) => { calls.push(metadata.source); const revision = chat._storageRevision; revisions.set(revision, structuredClone(chat)); chat = await mutate(structuredClone(chat)) ?? chat; chat._storageRevision = revision + 1; return structuredClone(chat) }
  }
  const options = { chats, sessions: { get: () => agent, getSession: () => session, flush: async () => {} }, timeline, scripts: {
    read: async () => ({ chunks: ['一'] }), continuity: { transition: () => ({ state: { cursor: 0 } }) }, dispatchEvent: async () => {} },
    queueSettlement: async () => { calls.push('settlement') }, cancelSettlement: async () => {},
    present: async value => structuredClone(value) }
  options.algebraHistory = { ...createConversationHistory({ chats, flush: options.sessions.flush }), enabled: () => algebra }
  return { create: () => createRoundHistory(options), options, calls, session, agent, timeline,
    get chat() { return chat },
    setGeneration(value) { generation = value } }
}

test('edited-input reroll rewrites the player bubble and session input in place', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    const result = await h.create().regenerate('chat', '', 'session', '改成敲窗')
    const msgs = h.chat.messages
    assert.equal(msgs.length, 3)
    assert.equal(msgs[1].role, 'user')
    assert.equal(msgs[1].text, '改成敲窗')
    assert.equal(msgs[1].sourceText, '改成敲窗')
    // swipes mirror sync is conditional: only when the user message already
    // carries the field (legacy behavior pinned for item-5 cutover).
    if (msgs[1].swipes !== undefined) assert.equal(msgs[1].swipes[0], '改成敲窗')
    assert.equal(result.adopted.inputEdited, true)
    assert.equal(result.adopted.inputText, '改成敲窗')
    // Session surface: the ORIGINAL input node position now carries the edited
    // text (single user row), plus the new body row.
    const fold = computeFold(h.session.snapshotEvents())
    const userRows = fold.rows.filter(row => row.type === 'user/message')
    assert.equal(userRows.length, 1)
    assert.equal(userRows[0].data.content[0].text, '改成敲窗')
    const bodyRows = fold.rows.filter(row => row.type === 'assistant/message')
    // The synthetic turn is folded back into the original position: exactly one
    // body row survives, carrying the regenerated text.
    assert.equal(bodyRows.length, 1)
    assert.equal(bodyRows[0].data.message.content[0].text.startsWith('新正文'), true)
    assert.equal(h.chat.regenInProgress, undefined)
    assert.equal(h.chat.regenRecovery, undefined)
  } finally { patch.dispose() }
})

test('edited-input reroll failure restores the original round including the input', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    h.setGeneration('throw')
    await assert.rejects(h.create().regenerate('chat', '', 'session', '改成敲窗'), /fixture generation failed/)
    const msgs = h.chat.messages
    assert.equal(msgs.length, 3)
    assert.equal(msgs[1].text, '推门')
    assert.equal(msgs[2].text, '旧正文')
    const fold = computeFold(h.session.snapshotEvents())
    const userRows = fold.rows.filter(row => row.type === 'user/message')
    assert.equal(userRows.length, 1)
    assert.equal(userRows[0].data.content[0].text, '推门')
    assert.equal(fold.rows.filter(row => row.type === 'assistant/message').at(-1).data.message.content[0].text, '旧正文')
    assert.equal(h.chat.regenInProgress, undefined)
  } finally { patch.dispose() }
})

test('same-text reroll without edit skips input rewrite', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    const result = await h.create().regenerate('chat', '', 'session', '推门')
    assert.equal(result.adopted.inputEdited, undefined)
    assert.equal(h.chat.messages[1].text, '推门')
  } finally { patch.dispose() }
})

test('edited-input reroll keeps nativeCommits userText in sync for future rollbacks', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    h.chat.nativeCommits = { '2': { turn: 2, userText: '推门', before: structuredClone(h.chat) } }
    await h.create().regenerate('chat', '', 'session', '改成敲窗')
    assert.equal(h.chat.nativeCommits['2'].userText, '改成敲窗')
  } finally { patch.dispose() }
})
