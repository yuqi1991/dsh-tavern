// Foreground compaction that keeps the latest rounds as REAL surface nodes
// (docs/design/compaction-retention.md): the compaction is the host's own
// transaction (compaction/start, summary, checkpoint replace, end) over a range
// that ends before the retained rounds; select-based operations keep working on
// those rounds, and a variant saved before the compaction is rebased (§4.4).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlayHarness, withHostPatch } from './locate-harness.mjs'
import { compactIdleRegion } from '../../lib/domain/idle-compaction.js'
import { planRetention, surfaceCutBalance } from '../../lib/domain/compaction-retention.js'
import { COMPACTED_FLOOR_REASON, compactedFloorTest, latestFloorCompacted } from '../../lib/domain/floor-projection.js'
import { createSessionStateView } from '../../lib/domain/chat-session-state.js'
import { isCompactionCheckpoint } from '../../lib/domain/compaction-checkpoint.js'

const dependencies = text => ({
  meter: { measure: session => ({ nodes: [...session.surface.nodes].map(seq => ({ seq, tokens: 50, heuristicTokens: 50 })) }), estimateMessage: () => 5 },
  summarize: async () => ({ summary: [{ type: 'text', text }], provider: 'fixture', model: 'fixture' }),
  recover: () => false
})

async function compact(h, rounds, text = '摘要') {
  const nodes = [...h.session.surface.nodes]
  const plan = planRetention({ events: h.events, nodes, rounds, tokenOf: () => 50, balancedBefore: surfaceCutBalance(h.events, nodes).balancedBefore })
  assert.equal(plan.kind, 'range')
  const result = await compactIdleRegion({ dependencies: dependencies(text), agent: h.agent, start: plan.start, end: plan.end })
  return { plan, result }
}
const view = h => createSessionStateView({ activity: () => ({}), evidence: () => ({ session: h.session, events: h.events }) }).rollback(h.chat)
const checkpointOnSurface = h => h.session.surface.nodes.some(seq => isCompactionCheckpoint(h.events.find(event => event.seq === seq)))

test('after keeping 2 rounds: rollback, undo, regenerate and variant switch work on the latest round', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a'); await h.play('b'); await h.play('c'); await h.play('d') // floors 2..5
  const { plan } = await compact(h, 2)
  assert.equal(plan.kept, 2); assert.equal(plan.through, 3)
  assert.deepEqual(h.surfaceInputs(), ['c', 'd'])
  assert.deepEqual(h.surfaceBodies(), ['正文4', '正文5'])
  assert.deepEqual(h.floors().floors.map(floor => [floor.turn, floor.compacted]), [[1, true], [2, true], [3, true], [4, false], [5, false]])
  assert.equal(latestFloorCompacted(h.chat, h.events, h.session.surface.nodes), false)
  assert.equal(h.availability().canRollback, true)

  await h.rollback()
  assert.deepEqual(h.surfaceInputs(), ['c']); assert.ok(checkpointOnSurface(h))
  const test = compactedFloorTest(h.events, [...h.session.surface.nodes])
  assert.deepEqual([test(3), test(5)], [true, false], 'a rolled-back floor is absent, not compacted')
  await h.undo()
  assert.deepEqual(h.surfaceInputs(), ['c', 'd']); assert.deepEqual(h.surfaceBodies(), ['正文4', '正文5'])

  await h.regenerate()
  assert.deepEqual(h.surfaceBodies(), ['正文4', '正文6'])
  await h.switchVariant(0)
  assert.deepEqual(h.surfaceBodies(), ['正文4', '正文5']); assert.ok(checkpointOnSurface(h))
  await h.switchVariant(1)
  assert.deepEqual(h.surfaceBodies(), ['正文4', '正文6']); assert.ok(checkpointOnSurface(h))
}))

test('rolling back to the retention boundary stops at the first compacted floor', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a'); await h.play('b'); await h.play('c')
  await compact(h, 1)
  assert.deepEqual(h.floors().floors.map(floor => floor.compacted), [true, true, true, false])
  assert.deepEqual([view(h).canRollback, view(h).canRegenerate, view(h).canEditBody, view(h).latestFloorCompacted], [true, true, true, false])
  await h.rollback()
  assert.deepEqual(h.surfaceInputs(), [])
  // The latest Chat floor (b) is now folded into the summary.
  assert.equal(latestFloorCompacted(h.chat, h.events, h.session.surface.nodes), true)
  assert.equal(h.availability().canRollback, false)
  const disabled = view(h)
  assert.deepEqual([disabled.canRollback, disabled.canRegenerate, disabled.canEditBody, disabled.latestFloorCompacted], [false, false, false, true])
  assert.equal(disabled.rollbackUnavailableReason, COMPACTED_FLOOR_REASON)
  await assert.rejects(h.rollback())
  await h.undo()
  assert.deepEqual(h.surfaceInputs(), ['c'])
}))

test('a variant saved before the compaction is rebased on the compacted surface', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a'); await h.play('b'); await h.play('c') // floors 2,3,4
  await h.regenerate()                                    // floor 4: 正文4 saved, 正文5 live
  await compact(h, 2)                                     // folds floor 2, keeps b and c
  assert.deepEqual(h.surfaceBodies(), ['正文3', '正文5'])
  await h.switchVariant(0)
  assert.deepEqual(h.surfaceInputs(), ['b', 'c'])
  assert.deepEqual(h.surfaceBodies(), ['正文3', '正文4'], 'the saved variant does not bring the compacted history back')
  assert.ok(checkpointOnSurface(h))
  await h.switchVariant(1)
  assert.deepEqual(h.surfaceBodies(), ['正文3', '正文5']); assert.ok(checkpointOnSurface(h))
}))

test('a variant whose floor was folded into the summary cannot be switched to', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a'); await h.regenerate()   // floor 2: 正文2 saved, 正文3 live
  await h.play('b')                          // floor 4
  await compact(h, 1)                        // folds floor 2
  await h.rollback()                         // the latest floor is the compacted floor 2 again
  const surface = [...h.session.surface.nodes]
  await assert.rejects(h.switchVariant(0), /已被压缩/)
  assert.deepEqual([...h.session.surface.nodes], surface, 'the compacted history is not brought back')
}))
