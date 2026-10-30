import test from 'node:test'
import assert from 'node:assert/strict'
import { foldedRounds, planRetention, surfaceCutBalance } from '../tavern-plugin/lib/domain/compaction-retention.js'

// A synthetic story log: system head, an opening reply, then `rounds` floors of
// player input + model reply (optionally with a tool call before the reply).
function storyLog(rounds, { tools = [], checkpoint = false } = {}) {
  const events = []
  const push = (type, data, extra = {}) => { const event = { seq: events.length, type, data, ...extra }; events.push(event); return event.seq }
  const nodes = [push('system/message', { content: 'system' })]
  if (checkpoint) nodes.push(push('user/message', { role: 'user', content: [{ type: 'text', text: '旧摘要' }], source: { kind: 'compact-checkpoint', compactionId: 'old' } }))
  else nodes.push(push('assistant/message', { turn: 0, message: { role: 'assistant', content: [{ type: 'text', text: '开场' }], source: { kind: 'model' } } }))
  for (let turn = 1; turn <= rounds; turn += 1) {
    push('turn/start', { turn })
    nodes.push(push('user/message', { role: 'user', content: [{ type: 'text', text: '输入' + turn }], source: { kind: 'user' } }))
    if (tools.includes(turn)) {
      nodes.push(push('assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c' + turn }], source: { kind: 'model' } } }))
      nodes.push(push('tool/result', { turn, callId: 'c' + turn }))
    }
    nodes.push(push('assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'text', text: '回复' + turn }], source: { kind: 'model' } } }))
    push('turn/end', { turn })
  }
  return { events, nodes }
}
const inputOf = (events, turn) => events.find(event => event.type === 'user/message' && event.data.content[0].text === '输入' + turn).seq

test('retention 0 keeps the host range', () => {
  const { events, nodes } = storyLog(5)
  assert.deepEqual(planRetention({ events, nodes, rounds: 0 }), { kind: 'none', reason: 'disabled' })
})

test('retention 1 ends the range right before the latest round', () => {
  const { events, nodes } = storyLog(5)
  const plan = planRetention({ events, nodes, rounds: 1, tokenOf: () => 10, budget: 1000 })
  assert.equal(plan.kind, 'range')
  assert.equal(plan.start, nodes[1])
  assert.equal(plan.keepFromSeq, inputOf(events, 5))
  assert.equal(plan.end, nodes[nodes.indexOf(inputOf(events, 5)) - 1])
  assert.equal(plan.kept, 1)
  assert.equal(plan.from, 1); assert.equal(plan.through, 4)
})

test('retention 10 over 20 rounds keeps rounds 11-20 as real nodes', () => {
  const { events, nodes } = storyLog(20)
  const plan = planRetention({ events, nodes, rounds: 10, tokenOf: () => 10, budget: 10000 })
  assert.equal(plan.kind, 'range'); assert.equal(plan.kept, 10)
  assert.equal(plan.keepFromSeq, inputOf(events, 11))
  assert.equal(plan.from, 1); assert.equal(plan.through, 10)
  // Every retained node stays after the range.
  assert.ok(nodes.slice(nodes.indexOf(plan.keepFromSeq)).every(seq => seq > plan.end))
})

test('idle: rounds within the quota have nothing to summarize; forced recovery still leaves one round to summarize', () => {
  const { events, nodes } = storyLog(3)
  assert.deepEqual(planRetention({ events, nodes, rounds: 10, tokenOf: () => 1, budget: 1000 }), { kind: 'retained', kept: 3 })
  const forced = planRetention({ events, nodes, rounds: 10, tokenOf: () => 1, budget: 1000, force: true })
  assert.equal(forced.kind, 'range'); assert.equal(forced.kept, 2)
  assert.equal(forced.keepFromSeq, inputOf(events, 2)); assert.equal(forced.through, 1)
})

test('the window budget shrinks the retained rounds', () => {
  const { events, nodes } = storyLog(10)
  // Each round is two nodes of 10 tokens: 3 rounds fit 60.
  const plan = planRetention({ events, nodes, rounds: 10, tokenOf: () => 10, budget: 60 })
  assert.equal(plan.kind, 'range'); assert.equal(plan.kept, 3)
  assert.equal(plan.through, 7)
  // Idle with all rounds in the quota but over budget compacts instead of reporting "retained".
  const small = storyLog(4)
  const idle = planRetention({ events: small.events, nodes: small.nodes, rounds: 10, tokenOf: () => 10, budget: 40 })
  assert.equal(idle.kind, 'range'); assert.equal(idle.kept, 2)
  // Not even one round fits: retention does not apply.
  assert.deepEqual(planRetention({ events, nodes, rounds: 10, tokenOf: () => 10, budget: 5 }), { kind: 'none', reason: 'no-fit' })
})

test('the retained start lands on a balanced tool-pairing cut', () => {
  const { events, nodes } = storyLog(4, { tools: [3] })
  const balance = surfaceCutBalance(events, nodes)
  const call = events.find(event => event.data?.message?.content?.[0]?.type === 'tool-call').seq
  const result = events.find(event => event.type === 'tool/result').seq
  assert.equal(balance.balancedBefore(result), false)
  assert.equal(balance.balancedAfter(call), false)
  assert.equal(balance.balancedBefore(inputOf(events, 3)), true)
  // A cut before an unbalanced position moves to an earlier floor.
  const unbalancedAt = new Set([inputOf(events, 4)])
  const plan = planRetention({ events, nodes, rounds: 1, tokenOf: () => 1, balancedBefore: seq => !unbalancedAt.has(seq) })
  assert.equal(plan.kind, 'none')
  const two = planRetention({ events, nodes, rounds: 2, tokenOf: () => 1, balancedBefore: seq => !unbalancedAt.has(seq) })
  assert.equal(two.keepFromSeq, inputOf(events, 3)); assert.equal(two.kept, 2)
})

test('a range holding only the previous checkpoint is not compacted again', () => {
  const { events, nodes } = storyLog(2, { checkpoint: true })
  // Keep 2 of 2 rounds forced -> kept 1: range = checkpoint + round 1, so it compacts.
  const forced = planRetention({ events, nodes, rounds: 10, force: true, tokenOf: () => 1 })
  assert.equal(forced.kind, 'range'); assert.equal(forced.folded, 2)
  // With one round only, the range would be just the checkpoint.
  const one = storyLog(1, { checkpoint: true })
  assert.deepEqual(planRetention({ events: one.events, nodes: one.nodes, rounds: 10, force: true }), { kind: 'none', reason: 'no-fit' })
})

test('folded rounds count only floors whose reply is inside the range', () => {
  const { events, nodes } = storyLog(4)
  const end = inputOf(events, 3) // round 3's input is folded, its reply is not
  assert.deepEqual(foldedRounds(events, nodes, nodes[1], end), { from: 1, through: 2 })
  assert.deepEqual(foldedRounds(events, nodes, nodes[1], nodes.at(-1)), { from: 1, through: 4 })
})
