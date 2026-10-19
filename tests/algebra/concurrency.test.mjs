import assert from 'node:assert/strict'
import test from 'node:test'
import { appendStep, runTransaction, TransactionConflict } from '../../lib/domain/conversation-algebra/index.js'
import { memoryAdapter, user } from './helpers.mjs'

test('two writers at one expected head admit only one transaction', async () => {
  const adapter = memoryAdapter()
  const outcomes = await Promise.allSettled(['a', 'b'].map(id => runTransaction(adapter, {
    expectedHead: -1, operationId: id, ops: appendStep({}, { rows: [user(id, id)] })
  })))
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(outcomes.find(result => result.status === 'rejected').reason instanceof TransactionConflict)
  assert.equal(adapter.writes, 1)
})

test('adapter wrappers share the same session lock', async () => {
  const adapter = memoryAdapter()
  const sessionKey = {}
  const wrappers = [{ ...adapter, sessionKey }, { ...adapter, sessionKey }]
  const outcomes = await Promise.allSettled(wrappers.map((wrapper, i) => runTransaction(wrapper, {
    expectedHead: -1, operationId: String(i), ops: appendStep({}, { rows: [user(String(i), 'text')] })
  })))
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(adapter.writes, 1)
})

test('external change while awaiting preflight is rejected before transaction writes', async () => {
  const adapter = memoryAdapter()
  adapter.preflight = async () => {
    await adapter.append('user/message', user('external', 'text').data, { surfaceOp: 'append' })
  }
  await assert.rejects(runTransaction(adapter, {
    expectedHead: -1, operationId: 'racing', ops: appendStep({}, { rows: [user('planned', 'text')] })
  }), TransactionConflict)
  assert.equal(adapter.events.length, 1)
  assert.equal(adapter.events[0].data.id, 'external')
})
