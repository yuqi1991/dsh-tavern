// Every plugin write to the model surface outside the algebra's own operations
// goes through writeSurfaceEvent: one guarded, durable transaction.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import { appendSessionEvent, sessionEvents } from '../../lib/domain/session-events.js'
import { clearFailedTurnSurface } from '../../lib/domain/rollback-surface.js'
import { createImportContextPreparation } from '../../lib/domain/import-context-preparation.js'
import { computeFold, hasPendingTransaction } from '../../lib/domain/conversation-algebra/index.js'

const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
test.after(() => patch.dispose())

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }
const text = value => [{ type: 'text', text: value }]
const transactionsOf = session => sessionEvents(session)
  .map(event => event.data?.source?.conversationTransaction ?? event.data?.message?.source?.conversationTransaction).filter(Boolean)

test('failed-turn cleanup shadows the failed input in one transaction and is idempotent', async () => {
  const session = Session.create('failed-turn-cleanup')
  appendSessionEvent(session, 'user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: text('第一轮') }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: MODEL, content: text('回复') } }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const failedInput = appendSessionEvent(session, 'user/message', { id: 'u2', role: 'user', turn: 2, source: { kind: 'user' }, content: text('失败的一轮') }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'error' } })
  let flushes = 0
  const flush = async () => { flushes++ }

  assert.equal(await clearFailedTurnSurface({ session, turn: 2, flush }), 1)
  assert.equal(session.surface.nodes.includes(failedInput.seq), false)
  assert.ok(flushes >= 1)
  const tags = transactionsOf(session)
  assert.equal(tags.length, 1)
  assert.equal(tags[0].phase, 'begin-commit')
  assert.ok(tags[0].operationId.startsWith('failed-turn-cleanup:'))
  assert.equal(hasPendingTransaction(sessionEvents(session)), false)
  assert.deepEqual(computeFold(sessionEvents(session)).surfaceNodes, [...session.surface.nodes])
  // The completed round is untouched; a second call finds nothing to clear.
  assert.ok(session.surface.nodes.length >= 2)
  const count = sessionEvents(session).length
  assert.equal(await clearFailedTurnSurface({ session, turn: 2, flush }), 0)
  assert.equal(sessionEvents(session).length, count)
  // A turn that did not fail has nothing to clear either.
  assert.equal(await clearFailedTurnSurface({ session, turn: 1, flush }), 0)
})

test('failed-turn cleanup refuses to write without a session flush', async () => {
  const session = Session.create('failed-turn-cleanup-flush')
  session.append('turn/start', { turn: 1 })
  appendSessionEvent(session, 'user/message', { id: 'u', role: 'user', turn: 1, source: { kind: 'user' }, content: text('x') }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'error' } })
  const before = sessionEvents(session).length
  await assert.rejects(clearFailedTurnSurface({ session, turn: 1 }), /flush/)
  assert.equal(sessionEvents(session).length, before)
})

function importedSession() {
  const session = Session.create('import-trim')
  const source = (base, id) => ({ ...base, importSource: { operationId: 'op', id } })
  const seqs = []
  for (let round = 1; round <= 4; round++) {
    const user = appendSessionEvent(session, 'user/message', { id: 'u' + round, role: 'user', source: source({ kind: 'user' }, round), content: text('输入' + round) }, { surfaceOp: 'append' })
    const reply = appendSessionEvent(session, 'assistant/message', { turn: round, step: 1, message: { id: 'a' + round, role: 'assistant', source: source(MODEL, round), content: text('回复' + round) } }, { surfaceOp: 'append' })
    seqs.push([user.seq, reply.seq])
  }
  return { session, seqs }
}

function preparation(session) {
  const flushes = []
  const chat = { id: 'chat', sessionId: session.id, messages: [], importHistory: { operationId: 'op' } }
  const api = createImportContextPreparation({
    readChat: async () => chat, updateChat: async (_id, mutate) => mutate(chat), getSession: () => session,
    flush: async () => { flushes.push(sessionEvents(session).length) },
    modelInfo: async () => ({ context: { contextWindow: 800 }, defaultMaxTokens: 100 }),
    estimateMessage: () => 100
  })
  const request = { sessionId: session.id, provider: 'p', model: 'm', system: '', tools: [],
    messages: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4'].map(id => ({ id, role: id[0] === 'u' ? 'user' : 'assistant', content: text(id) })) }
  return { api, chat, request, flushes }
}

test('import context trim replaces the middle rounds in one guarded transaction', async () => {
  const { session, seqs } = importedSession()
  const { api, chat, request, flushes } = preparation(session)
  const projected = await api.prepare(request)
  assert.equal(chat.importHistory.contextPreparation.status, 'trimmed')
  assert.equal(chat.importHistory.contextPreparation.droppedRounds, 2)
  assert.deepEqual(projected.messages.map(message => message.id), ['u1', 'a1', 'u4', 'a4'])
  const surface = [...session.surface.nodes]
  for (const seq of seqs.slice(1, 3).flat()) assert.equal(surface.includes(seq), false, 'removed ' + seq)
  for (const seq of [seqs[0], seqs[3]].flat()) assert.equal(surface.includes(seq), true, 'kept ' + seq)
  const tags = transactionsOf(session)
  assert.equal(tags.length, 1)
  assert.equal(tags[0].phase, 'begin-commit')
  assert.ok(tags[0].operationId.startsWith('import-context:'))
  assert.ok(flushes.length >= 1)
  assert.deepEqual(computeFold(sessionEvents(session)).surfaceNodes, surface)
  // The marker makes the trim idempotent: preparing again writes nothing.
  const count = sessionEvents(session).length
  chat.importHistory.contextPreparation = undefined
  const again = await api.prepare({ ...request })
  assert.equal(sessionEvents(session).length, count)
  assert.deepEqual(again.messages.map(message => message.id), ['u1', 'a1', 'u4', 'a4'])
})

test('import context within capacity records an unchanged receipt through the same gate', async () => {
  const { session } = importedSession()
  const { api, chat, request } = preparation(session)
  const small = { ...request, messages: request.messages.slice(0, 2) }
  const projected = await api.prepare(small)
  assert.equal(chat.importHistory.contextPreparation.status, 'unchanged')
  assert.equal(projected.messages.length, 2)
  const tags = transactionsOf(session)
  assert.equal(tags.length, 1)
  assert.ok(tags[0].operationId.startsWith('import-context:'))
})
