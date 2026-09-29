import assert from 'node:assert/strict'
import test from 'node:test'
import { appendStep, runTransaction, recoverTransaction, assertTransactionReady, computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { memoryAdapter, user } from './helpers.mjs'

for (const crashAt of [1, 2]) test(`restart recovers cut after write ${crashAt} once`, async () => {
  const adapter = memoryAdapter()
  const append = adapter.append.bind(adapter)
  let count = 0
  adapter.append = async (...args) => {
    if (count++ === crashAt) throw new Error('crash')
    return append(...args)
  }
  const ops = ['a', 'b', 'c'].flatMap(id => appendStep({}, { rows: [user(id, id)] }))
  await assert.rejects(runTransaction(adapter, { expectedHead: -1, operationId: 'recover', ops }), /crash/)
  assert.throws(() => assertTransactionReady(adapter))
  assert.equal(computeFold(adapter.events).rows.length, 0)
  const restored = memoryAdapter(adapter.events)
  restored.preflight = async () => {}
  restored.flush = async () => {}
  await recoverTransaction(restored)
  assert.deepEqual(computeFold(restored.events).rows.map(row => row.data.id), ['a', 'b', 'c'])
  const length = restored.events.length
  await recoverTransaction(restored)
  assert.equal(restored.events.length, length)
  assert.doesNotThrow(() => assertTransactionReady(restored))
})

test('failed flush leaves the session quarantined until successful recovery', async () => {
  const adapter = memoryAdapter()
  adapter.flush = async () => { throw new Error('disk unavailable') }
  await assert.rejects(runTransaction(adapter, { expectedHead: -1, operationId: 'flush', ops: appendStep({}, {rows:[user('a','a')]}) }), /disk unavailable/)
  assert.throws(() => assertTransactionReady(adapter))
  adapter.flush = async () => {}
  await recoverTransaction(adapter)
  assert.doesNotThrow(() => assertTransactionReady(adapter))
})
