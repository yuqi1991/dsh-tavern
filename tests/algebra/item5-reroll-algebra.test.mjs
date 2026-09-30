// Item-5 slice 1 harness: product reroll under algebra — checkout(anchor)+generate().
// These tests run the REAL product entry (createRoundHistory().regenerate) with
// algebraHistory enabled, and assert the surface outcome that the checkout
// composition must produce. Legacy-today baseline: they must pass BOTH before
// and after the migration (behavior-preserving cutover).
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { createRoundHistory } from '../../tavern-plugin/lib/domain/round-history.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { createConversationHistory } from '../../tavern-plugin/lib/domain/conversation-algebra-history.js'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { appendSessionEvent } from '../../tavern-plugin/lib/domain/session-events.js'

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }

function harness() {
  const calls = [], revisions = new Map()
  let counter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++counter) })
  let chat = { id: 'chat', sessionId: 'session', mode: 'story', _storageRevision: 1,
    messages: [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }],
    posture: '门外', scriptState: { cursor: 0 }, settleStatus: 'done' }
  const pair = [{ role: 'user', text: '推门', sourceText: '推门' },
    { role: 'assistant', turn: 2, text: '旧正文', sourceText: '旧正文', swipes: ['旧正文'], swipeId: 0 }]
  revisions.set(1, structuredClone(chat))
  const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 2, userText: '推门' } })
  chat = timeline.complete({ chat: begun.chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn,
    outcome: { status: 'success' }, apply(draft) { draft.messages.push(...pair) } }).chat
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
  const sessions = { get: () => agent, getSession: () => session, flush: async () => {} }
  const options = { chats, sessions, timeline, scripts: {
    read: async () => ({ chunks: ['一'] }), continuity: { transition: () => ({ state: { cursor: 0 } }) }, dispatchEvent: async () => {} },
    queueSettlement: async () => { calls.push('settlement') }, cancelSettlement: async () => {},
    present: async value => structuredClone(value),
    algebraHistory: { ...createConversationHistory({ chats, flush: sessions.flush }), enabled: () => true } }
  return { create: () => createRoundHistory(options), calls, session, agent,
    get chat() { return chat },
    setGeneration(value) { generation = value } }
}

function foldOf(h) { return computeFold(h.session.snapshotEvents()) }

test('algebra reroll keeps one visible round and a saved variant branch', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    const result = await h.create().regenerate('chat', '', 'session')
    assert.equal(result.adopted.hiddenTurn, 2)
    // Chat outcome: the old pair was replaced by the new pair, one round.
    const msgs = h.chat.messages
    assert.equal(msgs.length, 3)
    assert.equal(msgs[2].text.startsWith('新正文'), true)
    assert.equal(h.chat.regenRecovery, undefined)
    // Surface outcome: exactly one user row and one assistant body row for the round.
    const fold = foldOf(h)
    const userRows = fold.rows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user')
    assert.equal(userRows.length, 1)
    const bodyRows = fold.rows.filter(row => row.type === 'assistant/message')
    assert.equal(bodyRows.length, 1)
    assert.equal(bodyRows[0].data.message.content[0].text.startsWith('新正文'), true)
    assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
  } finally { patch.dispose() }
})

test('algebra reroll failure restores the original round and archives the attempt', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    h.setGeneration('throw')
    await assert.rejects(h.create().regenerate('chat', '', 'session'), /fixture generation failed/)
    const fold = foldOf(h)
    const userRows = fold.rows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user')
    assert.equal(userRows.length, 1)
    assert.equal(userRows[0].data.content[0].text, '推门')
    const bodyRows = fold.rows.filter(row => row.type === 'assistant/message')
    assert.equal(bodyRows.length, 1)
    assert.equal(bodyRows[0].data.message.content[0].text, '旧正文')
    assert.equal(h.chat.regenInProgress, undefined)
    assert.equal(h.chat.regenRecovery, undefined)
    assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
  } finally { patch.dispose() }
})

test('algebra reroll with edited input rewrites the original input node', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session', '改成敲窗')
    const fold = foldOf(h)
    const userRows = fold.rows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user')
    assert.equal(userRows.length, 1)
    assert.equal(userRows[0].data.content[0].text, '改成敲窗')
    assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
    assert.equal(h.chat.messages[1].text, '改成敲窗')
  } finally { patch.dispose() }
})

test('rollback remains available after an algebra reroll', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    // Slice-A pin: rollback after a pre-checkout reroll targets the CURRENT
    // native round (turn 3) and clears the whole round from the surface —
    // input and body — while the timeline restore keeps the chat pair
    // (synthetic-checkpoint quirk on the chat mirror; surface is clean).
    const result = await h.create().rollback('session', 'chat', 2)
    assert.equal(result.rolledBack.hiddenTurn, 3)
    const msgs = h.chat.messages
    assert.equal(msgs.length, 3)
    assert.equal(msgs[2].text, '新正文3')
    const fold = foldOf(h)
    assert.equal(fold.rows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user').length, 0)
    assert.equal(fold.rows.filter(row => row.type === 'assistant/message').length, 0)
    assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
    // The pre-reroll variant and this rollback both left named branches.
    assert.ok((h.chat.branchRegistry?.branches || []).length >= 2)
  } finally { patch.dispose() }
})

test('a second reroll finds the native turn left by the first', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    const msgs = h.chat.messages
    assert.equal(msgs.length, 3)
    assert.equal(msgs[2].text, '新正文4')
    const fold = foldOf(h)
    const userRows = fold.rows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user')
    assert.equal(userRows.length, 1)
    const bodyRows = fold.rows.filter(row => row.type === 'assistant/message')
    assert.equal(bodyRows.length, 1)
    assert.equal(bodyRows[0].data.message.content[0].text, '新正文4')
    assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
    assert.equal(h.chat.regenRecovery, undefined)
  } finally { patch.dispose() }
})
