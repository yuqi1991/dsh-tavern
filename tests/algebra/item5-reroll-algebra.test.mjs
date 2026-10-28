// Item-5 slice 1 harness: product reroll under algebra — checkout(anchor)+generate().
// These tests run the REAL product entry (createRoundHistory().regenerate) with
// algebraHistory enabled, and assert the surface outcome that the checkout
// composition must produce. Legacy-today baseline: they must pass BOTH before
// and after the migration (behavior-preserving cutover).
import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import { createRoundHistory } from '../../lib/domain/round-history.js'
import { createStoryTimeline } from '../../lib/domain/story-timeline.js'
import { createConversationHistory } from '../../lib/domain/conversation-algebra-history.js'
import { computeFold } from '../../lib/domain/conversation-algebra/index.js'
import { appendSessionEvent } from '../../lib/domain/session-events.js'
import { createSessionStateView } from '../../lib/domain/chat-session-state.js'
import { projectChatFloors } from '../../lib/domain/floor-projection.js'
import { branchRegistryOf } from '../../lib/domain/floor-projection.js'
import { projectReplyHistory } from '../../lib/domain/reply-presentation.js'
import { pageStoryFloors, storyFloorsOf } from '../../lib/domain/story-floors.js'
import { createBodyEditor } from '../../lib/domain/body-editor.js'
import { projectReplyLayers } from '../../lib/domain/reply-presentation.js'
import { sessionEvents } from '../../lib/domain/session-events.js'

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }

function harness({ mvu = false } = {}) {
  const calls = [], revisions = new Map()
  let counter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++counter) })
  let chat = { id: 'chat', sessionId: 'session', mode: 'story', _storageRevision: 1,
    messages: [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }],
    posture: '门外', scriptState: { cursor: 0 }, settleStatus: 'done' }
  const pair = [{ role: 'user', text: '推门', sourceText: '推门' },
    { role: 'assistant', turn: 2, text: '旧正文', sourceText: '旧正文', projectionText: '旧正文', sessionText: '旧正文', displayText: '旧正文', swipes: ['旧正文'], swipeId: 0,
      ...(mvu ? { variables: [{ hp: 2 }], mvu: { receipt: 'r2' } } : {}) }]
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
        { role: 'assistant', turn, text, sourceText: text, projectionText: text, sessionText: text, displayText: text, swipes: [text], swipeId: 0,
          ...(mvu ? { variables: [{ hp: turn }], mvu: { receipt: 'r' + turn } } : {}) })
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
    algebraHistory: { ...createConversationHistory({ chats, flush: sessions.flush }), assertReady: () => {} } }
  return { create: () => createRoundHistory(options), calls, session, agent,
    get chat() { return chat },
    setGeneration(value) { generation = value } }
}

function foldOf(h) { return computeFold(h.session.snapshotEvents()) }

test('algebra reroll tags the saved variant branch with the replaced turn', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    // The reroll pre-checkout must reach prepare's 4th (meta) parameter, not a
    // dropped 5th one (regression: turn tag silently lost at the call site).
    const registry = branchRegistryOf(h.session)
    const tagged = (registry?.branches || []).filter(branch => Number.isSafeInteger(branch.turn) && branch.turn > 0)
    assert.equal(tagged.length, 1)
    assert.equal(tagged[0].turn, 2)
  } finally { patch.dispose() }
})

test('variant switcher checks out the archived body and back to the live line', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    // After one reroll the saved original is first and the active body is last.
    // Enumeration is oldest-first: [旧正文(0), 新正文(1, live)].
    const round = h.create()
    const switched = await round.switchVariant('session', 'chat', 0)
    assert.equal(switched.switchedVariant.index, 0)
    const fold = foldOf(h)
    const bodyRows = fold.rows.filter(row => row.type === 'assistant/message')
    assert.equal(bodyRows.length, 1)
    assert.equal(bodyRows[0].data.message.content[0].text, '旧正文')
    // The chat floor must follow the pointer, not keep the last reroll's merge.
    const chatFloor = [...h.chat.messages].findLast(message => message && message.role === 'assistant' && message.greeting !== true)
    assert.equal(chatFloor.text, '旧正文')
    assert.equal(chatFloor.projectionText, chatFloor.text)
    assert.equal(chatFloor.sessionText, chatFloor.text)
    assert.equal(chatFloor.displayText, chatFloor.text)
    // Returning to the active body uses the final slot.
    const back = await round.switchVariant('session', 'chat', 1)
    assert.equal(back.switchedVariant.index, 1)
    const foldBack = foldOf(h)
    const bodyRowsBack = foldBack.rows.filter(row => row.type === 'assistant/message')
    assert.equal(bodyRowsBack.length, 1)
    assert.equal(bodyRowsBack[0].data.message.content[0].text.startsWith('新正文'), true)
    const chatFloorBack = [...h.chat.messages].findLast(message => message && message.role === 'assistant' && message.greeting !== true)
    assert.equal(chatFloorBack.text.startsWith('新正文'), true)
    assert.equal(chatFloorBack.projectionText, chatFloorBack.text)
    assert.equal(chatFloorBack.sessionText, chatFloorBack.text)
    assert.equal(chatFloorBack.displayText, chatFloorBack.text)
    // Out-of-range index is rejected without moving the surface.
    await assert.rejects(round.switchVariant('session', 'chat', 5), /超出范围/)
    const foldAfter = foldOf(h)
    assert.equal(foldAfter.rows.filter(row => row.type === 'assistant/message')[0].data.message.content[0].text.startsWith('新正文'), true)
    // Re-clicking the already-active variant is a no-op: no new branch, no
    // revision-bumping checkout transaction (regression: minted 4 dead checkouts).
    const beforeRevision = h.chat._storageRevision
    const beforeBranches = branchRegistryOf(h.session).branches.length
    const noop = await round.switchVariant('session', 'chat', 1)
    assert.equal(noop.switchedVariant.index, 1)
    assert.equal(h.chat._storageRevision, beforeRevision)
    assert.equal(branchRegistryOf(h.session).branches.length, beforeBranches)
  } finally { patch.dispose() }
})

test('algebra reroll keeps one visible round and a saved variant branch', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
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
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
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
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
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
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
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
    assert.ok((branchRegistryOf(h.session)?.branches || []).length >= 2)
  } finally { patch.dispose() }
})

test('a second reroll finds the native turn left by the first', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
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

test('rollback remains available after switching to the middle of three variants', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    // Creation order is [旧正文, 新正文3, 新正文4]. The live body is the
    // final slot, so index 1 selects the middle native turn 3 variant.
    const switched = await h.create().switchVariant('session', 'chat', 1)
    assert.equal(switched.switchedVariant.index, 1)
    assert.equal(h.chat.messages[2].text, '新正文3')
    // The transcript only renders append-origin rows: the floor stays hosted
    // on its newest reroll (turn 4), whose row shows the switched body.
    assert.equal(floorViews(h).floors.find(floor => floor.turn === 2).hostTurn, 4)
    const result = await h.create().rollback('session', 'chat', 2)
    assert.equal(result.rolledBack.hiddenTurn, 3)
    // This fixture's generator overwrites its stored Chat revisions, so the
    // Chat after a rerolled rollback is not meaningful; floors after rollback
    // are covered by the reroll-free harness in the floor projection test.
    const fold = foldOf(h)
    assert.equal(fold.rows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user').length, 0)
    assert.equal(fold.rows.filter(row => row.type === 'assistant/message').length, 0)
  } finally { patch.dispose() }
})
test('each variant switch is one selection event and rollback still follows it', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    const bodyOf = () => h.session.deriveMessages().filter(message => message.role === 'assistant').at(-1).content[0].text
    // Creation order [旧正文, 新正文3, 新正文4]; the first switch archives the live line.
    for (const [index, text] of [[0, '旧正文'], [1, '新正文3'], [2, '新正文4'], [0, '旧正文'], [1, '新正文3']]) {
      const before = h.session.snapshotEvents().length
      const switched = await h.create().switchVariant('session', 'chat', index)
      const added = h.session.snapshotEvents().slice(before)
      assert.deepEqual(added.map(event => event.type), ['dsh-tavern/surface-select'], 'switch to ' + index)
      assert.equal(added[0].surfaceOp, undefined)
      assert.equal(bodyOf(), text)
      assert.equal(h.chat.messages[2].text, text)
      assert.equal(switched.switchedVariant.index, index)
    }
    const result = await h.create().rollback('session', 'chat', 2)
    assert.equal(result.rolledBack.hiddenTurn, 3)
    assert.equal(foldOf(h).rows.filter(row => row.type === 'assistant/message').length, 0)
    assert.equal(h.session.snapshotEvents().filter(event => event.data?.source?.form === 'conversation-metadata' || event.data?.source?.form === 'surface-restore').length, 0)
  } finally { patch.dispose() }
})

test('undo rollback makes the restored round a floor again', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    const result = await h.create().rollback('session', 'chat', 2)
    const hidden = Number(result.rolledBack.hiddenTurn)
    assert.equal(floorViews(h).floors.some(floor => floor.turn === 2 && floor.bodySeq !== null), false, 'rolled-back floor has no live body')
    await h.create().undoRollback('session', 'chat')
    const restored = floorViews(h)
    // The restored floor is a floor again and hosted on its reroll.
    assert.deepEqual(restored.floors.map(floor => floor.turn), [1, 2])
    assert.equal(restored.floors.find(floor => floor.turn === 2).hostTurn, hidden)
  } finally { patch.dispose() }
})

test('reroll after rollback+undo finds the restored original row', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')      // round now native turn 3
    await h.create().rollback('session', 'chat', 2)          // clears the round
    await h.create().undoRollback('session', 'chat')         // restores ORIGINAL rows (turn 2)
    const result = await h.create().regenerate('chat', '', 'session')  // must find restored row
    assert.equal(result.adopted.hiddenTurn, 2)
    const fold = foldOf(h)
    assert.equal(fold.rows.filter(row => row.type === 'user/message' && row.data?.source?.kind === 'user').length, 1)
    assert.equal(fold.rows.filter(row => row.type === 'assistant/message').length, 1)
    assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
  } finally { patch.dispose() }
})

test('interleaved reroll, switch, rollback and undo grow the log only by generated content', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const seen = new Set()
    for (const seed of [1, 7, 42]) {
      let state = seed
      const random = n => { state = (state * 1103515245 + 12345) % 2147483648; return state % n }
      const h = harness()
      const bodyOnSurface = () => h.session.deriveMessages().filter(message => message.role === 'assistant').at(-1)?.content[0]?.text
      let rolledBack = null, variants = 1
      for (let step = 0; step < 14; step++) {
        const before = h.session.snapshotEvents().length
        let op
        if (rolledBack !== null) {
          op = 'undo'
          await h.create().undoRollback('session', 'chat')
        } else {
          op = ['regenerate', 'switch', 'switch', 'rollback'][random(variants >= 4 ? 3 : 4) + (variants >= 4 ? 1 : 0)]
          if (op === 'regenerate') { await h.create().regenerate('chat', '', 'session'); variants++ }
          if (op === 'switch') await h.create().switchVariant('session', 'chat', random(variants))
          if (op === 'rollback') { rolledBack = bodyOnSurface(); await h.create().rollback('session', 'chat', 2) }
        }
        seen.add(op)
        const where = `seed ${seed} step ${step} ${op}`
        const added = h.session.snapshotEvents().slice(before)
        if (op !== 'regenerate') assert.ok(added.every(event => event.surfaceOp === undefined), where + ': history operations write no message rows')
        assert.ok(h.session.snapshotEvents().every(event => !['conversation-metadata', 'checkout'].includes(event.data?.source?.form) && event.data?.source?.plugin !== 'dsh-tavern-surface-restore'), where + ': no bookkeeping rows')
        assert.deepEqual(computeFold(h.session.snapshotEvents()).surfaceNodes, [...h.session.surface.nodes], where)
        if (op === 'rollback') {
          assert.equal(computeFold(h.session.snapshotEvents()).rows.filter(row => row.type === 'assistant/message').length, 0, where)
          continue
        }
        if (op === 'undo') { assert.equal(bodyOnSurface(), rolledBack, where); rolledBack = null }
        assert.equal(bodyOnSurface(), h.chat.messages[2].text, where + ': model context matches the visible floor')
      }
    }
    assert.deepEqual([...seen].sort(), ['regenerate', 'rollback', 'switch', 'undo'])
  } finally { patch.dispose() }
})

/** The Floor Projection over the harness Session. The session view no
 * longer publishes floor tables; rollback stays unavailable until the page
 * resumes the Agent. */
function floorViews(h) {
  const events = h.session.snapshotEvents()
  const cold = createSessionStateView({ activity: () => ({}), evidence: () => ({ session: null, events: [] }) }).rollback(h.chat)
  assert.equal(cold.canRollback, false)
  return projectChatFloors(h.chat, events, h.session.surface.nodes)
}

test('floor projection follows the history operations', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    // Native turn hosting the last floor's body, per operation.
    const expected = {
      'first floor': 2, 'reroll 1': 3, 'reroll 2': 4, 'switch 0': 4, 'switch 1': 4, undo: 2, 'aborted reroll': 2
    }
    const check = (h, where) => {
      const projection = floorViews(h)
      assert.equal(projection.floors.at(-1).hostTurn, expected[where], where)
      return projection
    }
    // First floor.
    let h = harness()
    let projection = check(h, 'first floor')
    assert.deepEqual(projection.floors.map(floor => [floor.turn, floor.hostTurn]), [[1, 1], [2, 2]])
    // Repeated rerolls, then switches.
    await h.create().regenerate('chat', '', 'session'); check(h, 'reroll 1')
    await h.create().regenerate('chat', '', 'session')
    projection = check(h, 'reroll 2')
    assert.deepEqual(projection.floors.at(-1), { ...projection.floors.at(-1), turn: 2, hostTurn: 4, variantCount: 2 })
    await h.create().switchVariant('session', 'chat', 0); check(h, 'switch 0')
    await h.create().switchVariant('session', 'chat', 1); check(h, 'switch 1')
    // Rollback and undo. A fresh harness: the fixture's generator overwrites
    // its stored Chat revisions, which only a reroll-free rollback avoids.
    h = harness()
    await h.create().rollback('session', 'chat', 2)
    assert.equal(floorViews(h).floors.some(floor => floor.turn === 2), false, 'rollback')
    await h.create().undoRollback('session', 'chat')
    projection = check(h, 'undo')
    assert.deepEqual(projection.floors.at(-1).bodyTurn, 2)
    // An aborted reroll.
    h = harness(); h.setGeneration('throw')
    await assert.rejects(h.create().regenerate('chat', '', 'session'), /fixture generation failed/)
    check(h, 'aborted reroll')
  } finally { patch.dispose() }
})

test('switching variants brings back each variant own MVU state', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness({ mvu: true })
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    const floor = () => [...h.chat.messages].findLast(message => message.role === 'assistant' && message.greeting !== true)
    const expected = { 旧正文: 2, 新正文3: 3, 新正文4: 4 }
    assert.deepEqual(floor().variables, [{ hp: 4 }])
    for (const index of [0, 2, 1, 0, 1, 2]) {
      await h.create().switchVariant('session', 'chat', index)
      const message = floor()
      assert.deepEqual(message.variables, [{ hp: expected[message.text] }], 'switch ' + index)
      assert.equal(message.mvu.receipt, 'r' + expected[message.text])
      // The page shows the floor's first native row; only a published
      // projection puts the selected variant's body over it.
      const published = projectReplyHistory(h.chat.messages, {}).projections.find(projection => projection.turn === message.turn)
      assert.equal(published?.text, message.text, 'switch ' + index + ' must override the native row')
    }
  } finally { patch.dispose() }
})

test('story floors follow rerolls, switches, rollback and undo', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    // What getStoryFloors publishes is what the story view renders.
    const page = h => pageStoryFloors(storyFloorsOf(h.chat, { projections: projectReplyHistory(h.chat.messages, {}).projections }))
    const bodies = h => page(h).floors.map(floor => [floor.turn, floor.input && floor.input.text, floor.body && floor.body.text])
    let h = harness()
    assert.deepEqual(bodies(h), [[1, null, '开场'], [2, '推门', '旧正文']])
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    // One floor per input whatever the number of rerolls; the body is the live variant.
    assert.deepEqual(bodies(h), [[1, null, '开场'], [2, '推门', '新正文4']])
    for (const [index, text] of [[0, '旧正文'], [1, '新正文3'], [2, '新正文4']]) {
      await h.create().switchVariant('session', 'chat', index)
      assert.deepEqual(bodies(h).at(-1), [2, '推门', text], 'switch ' + index)
    }
    h = harness()
    await h.create().rollback('session', 'chat', 2)
    assert.deepEqual(bodies(h), [[1, null, '开场']])
    await h.create().undoRollback('session', 'chat')
    assert.deepEqual(bodies(h), [[1, null, '开场'], [2, '推门', '旧正文']])
  } finally { patch.dispose() }
})

test('regenerating from a non-last variant finds the body that variant put on the surface', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    // Creation order [旧正文, 新正文3, 新正文4, 新正文5]: index 1 and 2 are not the newest.
    for (const [index, text] of [[1, '新正文3'], [2, '新正文4']]) {
      await h.create().switchVariant('session', 'chat', index)
      assert.equal(h.chat.messages[2].text, text)
      await h.create().regenerate('chat', '', 'session')
      assert.equal(h.chat.messages[2].text.startsWith('新正文'), true)
      assert.equal(h.chat.messages.length, 3, 'one visible round after regenerating from variant ' + index)
      assert.equal(h.chat.regenRecovery, undefined)
      // The regenerated body is on the surface, and exactly one body is.
      const fold = foldOf(h)
      assert.deepEqual(fold.surfaceNodes, [...h.session.surface.nodes])
      const bodies = fold.rows.filter(row => row.type === 'assistant/message')
      assert.equal(bodies.length, 1)
      assert.equal(bodies[0].data.message.content[0].text, h.chat.messages[2].text)
      // Every earlier body stays reachable as a variant.
      const variants = projectChatFloors(h.chat, h.session.snapshotEvents(), h.session.surface.nodes).floors.at(-1).variantCount
      assert.ok(variants >= 4 + (index - 1), 'variants kept: ' + variants)
    }
  } finally { patch.dispose() }
})

test('the latest body stays editable after rerolls, whichever native turn hosts it', async () => {
  const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
  try {
    const h = harness()
    await h.create().regenerate('chat', '', 'session')
    await h.create().regenerate('chat', '', 'session')
    // The floor keeps its chat turn (2) while its body lives on native turn 4.
    assert.equal(h.chat.messages.at(-1).turn, 2)
    // Settlement has finished by the time a player edits.
    let saved = { ...structuredClone(h.chat), settleStatus: 'done', regenInProgress: undefined }
    const sessions = { get: () => h.agent, flush: async () => {} }
    const editor = createBodyEditor({
      assertAlgebraReady: () => {}, sessions, timeline: createStoryTimeline(), activity: () => ({ busy: false }),
      project: async text => projectReplyLayers(text), present: async chat => chat,
      chats: { forSession: async () => structuredClone(saved), update: async (_id, fn) => { saved = fn(structuredClone(saved)) ?? saved; saved._storageRevision = (saved._storageRevision || 0) + 1; return structuredClone(saved) } }
    })
    const edit = await editor.read('session')
    const view = await editor.save('session', { token: edit.token, texts: ['手工编辑后的正文'] })
    assert.equal(view.messages.at(-1).text, '手工编辑后的正文')
    assert.equal(h.session.deriveMessages().filter(message => message.role === 'assistant').at(-1).content[0].text, '手工编辑后的正文')
  } finally { patch.dispose() }
})
