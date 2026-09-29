import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GuardError, TransactionConflict, appendStep, branch, checkout, computeFold,
  dropTagged, editStep, guardDropTagged, guardEdit, guardShape,
  guardStepComplete, guardTombstoneSource, runTransaction
} from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { appendRaw, assistant, memoryAdapter, toolResult, user } from './helpers.mjs'

test('G1 rejects an invalid assistant source and transaction writes nothing', async () => {
  const adapter = memoryAdapter()
  const bad = assistant('a1', 'text', 1, 1, { kind: 'model', provider: '', model: 'x' })
  await assert.rejects(runTransaction(adapter, {
    expectedHead: -1,
    operationId: 'bad-shape',
    ops: [{ kind: 'surface-write', event: bad, intent: { surfaceOp: 'append' } }]
  }), error => error instanceof GuardError && error.rule === 'G1')
  assert.equal(adapter.writes, 0)
})

test('G2 rejects incomplete tool steps before producing operations', () => {
  const call = assistant('a1', [{ type: 'tool-call', id: 'c1', name: 'skill', arguments: '{}' }], 1)
  assert.throws(() => appendStep({}, { rows: [call] }), error => error instanceof GuardError && error.rule === 'G2')
  assert.throws(() => guardStepComplete({ rows: [toolResult('r1', 'orphan', 1)] }), error => error instanceof GuardError && error.rule === 'G2')
})

test('G3/G7 permit only registered, complete tagged steps', () => {
  assert.throws(() => dropTagged({ steps: [] }, 'story-body'), error => error instanceof GuardError && error.rule === 'G7')
  const call = assistant('a1', [{ type: 'tool-call', id: 'c1', name: 'skill', arguments: '{}' }], 1)
  assert.throws(() => guardDropTagged({ rows: [call] }, 'skill'), error => error instanceof GuardError && error.rule === 'G2')
  assert.throws(() => guardDropTagged({ rows: [user('u1', '正文')] }, 'foreground-frame'), error => error instanceof GuardError && error.rule === 'G7')
  const result = toolResult('r1', 'c1', 1)
  assert.doesNotThrow(() => guardDropTagged({ rows: [call, result] }, 'skill'))
})

test('G4 rejects tool-bearing edits and preserves message identity for prose edits', () => {
  const toolStep = { rows: [assistant('a1', [{ type: 'tool-call', id: 'c1', name: 'skill', arguments: '{}' }], 1)] }
  assert.throws(() => guardEdit(toolStep), error => error instanceof GuardError && error.rule === 'G4')
  const events = []
  appendRaw(events, [user('u1', 'before')])
  const state = computeFold(events)
  const [write] = editStep(state, 'seq:0', 'after')
  assert.equal(write.event.data.id, 'u1')
  assert.equal(write.event.data.content[0].text, 'after')
})

test('G5 rejects an assistant tombstone without original provider/model', () => {
  const bad = assistant('a1', 'x', 1, 1, { kind: 'model', provider: '', model: '' })
  assert.throws(() => guardTombstoneSource(bad), error => error instanceof GuardError && error.rule === 'G5')
})

test('guards are pure and do not invoke an available writer', () => {
  let writes = 0
  const value = assistant('a1', 'x', 1)
  value.write = () => { writes++ }
  guardShape(value)
  assert.equal(writes, 0)
})

test('transaction rejects stale expected head without writes', async () => {
  const adapter = memoryAdapter([{ ...user('u1', 'one'), seq: 0, time: 1, surfaceOp: 'append' }])
  await assert.rejects(runTransaction(adapter, { expectedHead: -1, ops: [] }), TransactionConflict)
  assert.equal(adapter.writes, 0)
})

test('fold ignores a torn transaction tail until its commit marker exists', async () => {
  const adapter = memoryAdapter()
  const originalAppend = adapter.append
  let calls = 0
  adapter.append = async function (...args) {
    calls++
    if (calls === 2) throw new Error('injected crash')
    return originalAppend.apply(adapter, args)
  }
  const ops = [
    ...appendStep({}, { rows: [user('u1', 'one')] }),
    ...appendStep({}, { rows: [user('u2', 'two')] })
  ]
  await assert.rejects(runTransaction(adapter, { expectedHead: -1, operationId: 'torn', ops }), /injected crash/)
  assert.equal(adapter.events.length, 1)
  assert.deepEqual(computeFold(adapter.events).surfaceNodes, [])
})

test('branch and checkout update metadata without model or surface writes', async () => {
  const initial = [{ ...user('u1', 'one'), seq: 0, time: 1, surfaceOp: 'append' }]
  const adapter = memoryAdapter(initial)
  const state = { ...computeFold(initial), branchRegistry: adapter.metadata() }
  const first = await runTransaction(adapter, { expectedHead: 0, operationId: 'branch', ops: branch(state, '主线') })
  const branchId = first.metadata.branches[0].branchId
  const nextState = { ...computeFold(adapter.events), branchRegistry: first.metadata }
  await runTransaction(adapter, { expectedHead: nextState.headSeq, operationId: 'checkout', ops: checkout(nextState, branchId) })
  assert.equal(adapter.writes, 2)
  assert.equal(adapter.metadata().activeBranchId, branchId)
  assert.deepEqual(adapter.checkedOut(), [0])
})

test('checkout derives the historical surface at an immutable seq anchor', async () => {
  const events = []
  appendRaw(events, [user('u1', 'one'), assistant('a1', 'answer', 1), user('u2', 'two')])
  const adapter = memoryAdapter(events)
  const state = { ...computeFold(events), branchRegistry: adapter.metadata() }
  await runTransaction(adapter, { expectedHead: 2, operationId: 'anchor-checkout', ops: checkout(state, { seq: 1 }) })
  assert.deepEqual(adapter.checkedOut(), [0, 1])
})
