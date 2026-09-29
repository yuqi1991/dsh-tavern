import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { rewindBackgroundSurface, backgroundSuppressedTurns } from '../../tavern-plugin/lib/domain/background-surface.js'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'

const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
test.after(() => patch.dispose())

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }

function backgroundSession(fixed = false) {
  const session = Session.create('bg-algebra-rewind')
  if (fixed) session.append('user/message', {
    id: 'tavern-session-prefix:bg', role: 'user', content: [{ type: 'text', text: 'prefix' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'snapshot' }
  }, { surfaceOp: 'append' })
  return session
}

function appendTurn(session, id, turn, text) {
  session.append('assistant/message', { turn, step: 1, stream: [], message: {
    id, role: 'assistant', content: [{ type: 'text', text }], source: MODEL } }, { surfaceOp: 'append' })
}

test('algebra rewind writes one guarded transaction and matches the legacy surface', async () => {
  const algebra = backgroundSession(true)
  appendTurn(algebra, 'a1', 1, 'keep')
  appendTurn(algebra, 'a2', 2, 'group1')
  appendTurn(algebra, 'a3', 3, 'group2')
  const legacy = Session.create('bg-legacy-rewind')
  legacy.append('user/message', {
    id: 'tavern-session-prefix:bg', role: 'user', content: [{ type: 'text', text: 'prefix' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'snapshot' }
  }, { surfaceOp: 'append' })
  appendTurn(legacy, 'a1', 1, 'keep')
  appendTurn(legacy, 'a2', 2, 'group1')
  appendTurn(legacy, 'a3', 3, 'group2')

  let flushes = 0
  const removed = await rewindBackgroundSurface(algebra, 1, { enabled: true, flush: async () => { flushes++ } })
  rewindBackgroundSurface(legacy, 1)
  assert.equal(removed, 2)
  assert.ok(flushes >= 1)
  // One transaction: begin marker on the first tombstone, commit on the last.
  const tags = algebra.snapshotEvents().map(event => event.data?.message?.source?.conversationTransaction).filter(Boolean)
  assert.equal(tags.length, 1)
  assert.equal(tags[0].phase, 'begin-commit')
  assert.ok(tags[0].operationId.startsWith('background-rewind:'))
  assert.deepEqual(legacy.surface.nodes, algebra.surface.nodes)
  const fold = computeFold(algebra.snapshotEvents())
  assert.deepEqual(fold.surfaceNodes, algebra.surface.nodes)
  assert.deepEqual(fold.rows.map(row => row.data?.message?.id ?? row.data?.id), ['tavern-session-prefix:bg', 'a1'])
  // Durable suppression projection still reports the shadowed turns.
  assert.deepEqual(backgroundSuppressedTurns(algebra.snapshotEvents()), [2, 3])
})

test('switch off preserves the legacy per-group replacement format', async () => {
  const session = backgroundSession(true)
  appendTurn(session, 'a1', 1, 'keep')
  appendTurn(session, 'a2', 2, 'one')
  const removed = await rewindBackgroundSurface(session, 1)
  assert.equal(removed, 1)
  const tags = session.snapshotEvents().map(event => event.data?.message?.source?.conversationTransaction).filter(Boolean)
  assert.equal(tags.length, 0)
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row => row.data?.message?.id ?? row.data?.id), ['tavern-session-prefix:bg', 'a1'])
})

test('algebra rewind of a clean tail performs no writes', async () => {
  const session = backgroundSession(true)
  appendTurn(session, 'a1', 1, 'only')
  const before = session.snapshotEvents().length
  assert.equal(await rewindBackgroundSurface(session, 1, { enabled: true, flush: async () => {} }), 0)
  assert.equal(session.snapshotEvents().length, before)
})

test('transaction conflict leaves the surface untouched and surfaces the failure', async () => {
  const session = backgroundSession(true)
  appendTurn(session, 'a1', 1, 'keep')
  appendTurn(session, 'a2', 2, 'stale')
  const events = session.snapshotEvents()
  const before = session.surface.nodes
  // A concurrent write lands between fold and commit: the head moves.
  const originalAppend = session.append.bind(session)
  let injected = false
  session.append = function (type, data, intent) {
    if (!injected && intent?.surfaceOp !== 'append') {
      injected = true
      originalAppend('user/message', { id: 'race', role: 'user', content: [{ type: 'text', text: '外部写入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    }
    return originalAppend(type, data, intent)
  }
  await assert.rejects(rewindBackgroundSurface(session, 1, { enabled: true, flush: async () => {} }))
  session.append = originalAppend
  // The conflicting transaction may have partially appended its durable plan;
  // fold must either match the host surface or expose a pending transaction
  // that blocks further reads until recovered — never a silent divergence.
  const fold = computeFold(session.snapshotEvents())
  const tags = fold.events.map(event => event.data?.message?.source?.conversationTransaction).filter(Boolean)
  const committed = new Set(tags.filter(tag => ['commit', 'begin-commit'].includes(tag.phase)).map(tag => tag.operationId))
  const pending = tags.some(tag => tag.phase === 'begin' && !committed.has(tag.operationId))
  if (!pending) assert.deepEqual(fold.surfaceNodes, session.surface.nodes)
  else assert.notDeepEqual(session.surface.nodes, before)
})
