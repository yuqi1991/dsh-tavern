import assert from 'node:assert/strict'
import test from 'node:test'
import { appendStep, computeFold, dropTagged, GuardError, guardShape } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { appendRaw, assistant, toolResult, user } from './helpers.mjs'

function skillRows(extra = []) {
  return [assistant('call', [{ type: 'tool-call', id: 'c', name: 'skill', arguments: '{}' }, ...extra], 1), toolResult('result', 'c', 1)]
}

test('G3 preserves prose accompanying a skill call', () => {
  const events = appendRaw([], skillRows([{ type: 'text', text: '正文必须保留' }]))
  const state = computeFold(events)
  assert.ok(state.views.conversation.some(row => row.seq === 0))
  assert.deepEqual(dropTagged(state, 'skill'), [])
})

test('G3 preserves a mixed skill and ordinary tool step', () => {
  const rows = skillRows([{ type: 'tool-call', id: 'other', name: 'bash', arguments: '{}' }])
  rows.push(toolResult('ordinary-result', 'other', 1))
  assert.deepEqual(dropTagged(computeFold(appendRaw([], rows)), 'skill'), [])
})

test('G2 rejects duplicate results for one call', () => {
  const rows = skillRows()
  rows.push(toolResult('duplicate', 'c', 1))
  assert.throws(() => appendStep({}, { rows }), error => error instanceof GuardError && error.rule === 'G2')
})

test('G2 rejects two user inputs presented as one step', () => {
  assert.throws(() => appendStep({}, { rows: [user('one', '1'), user('two', '2')] }), error => error instanceof GuardError && error.rule === 'G2')
})

test('skill retirement emits legal assistant and user tombstones', () => {
  const events = appendRaw([], skillRows())
  const ops = dropTagged(computeFold(events), 'skill')
  assert.equal(ops.length, 2)
  for (const op of ops) assert.doesNotThrow(() => guardShape(op.event))
  assert.deepEqual(ops.map(op => op.event.type), ['assistant/message', 'user/message'])
  assert.deepEqual(ops[0].event.data.message.source, events[0].data.message.source)
})
