import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendStep, assertViewConsistency, branch, checkout, computeFold,
  dropTagged, editStep, guardShape, guardStepComplete
} from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { applyWrites, assistant, user } from './helpers.mjs'

function random(seed) {
  let value = seed >>> 0
  return function () {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 0x100000000
  }
}

test('100000 random primitive sequences preserve algebra invariants', () => {
  const next = random(0x5eed1234)
  for (let sequence = 0; sequence < 100000; sequence++) {
    const events = []
    const turns = 1 + Math.floor(next() * 3)
    for (let turn = 1; turn <= turns; turn++) {
      let state = computeFold(events)
      applyWrites(events, appendStep(state, { rows: [user(`u-${sequence}-${turn}`, `user ${turn}`)] }))
      state = computeFold(events)
      applyWrites(events, appendStep(state, { rows: [assistant(`a-${sequence}-${turn}`, `assistant ${turn}`, turn)] }))
      state = computeFold(events)
      if (next() < 0.35) applyWrites(events, editStep(state, state.steps.at(-1).ref, `edited ${turn}`))
      if (next() < 0.2) {
        const frame = user(`f-${sequence}-${turn}`, 'frame', { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame' })
        applyWrites(events, appendStep(computeFold(events), { rows: [frame] }))
        state = computeFold(events)
        applyWrites(events, dropTagged(state, 'foreground-frame'))
      }
    }
    const folded = computeFold(events)
    folded.rows.forEach(guardShape)
    folded.steps.filter(step => step.role === 'assistant').forEach(guardStepComplete)
    assertViewConsistency(folded)
    assert.deepEqual(folded.views.conversation.map(event => event.type),
      Array.from({ length: turns }, () => ['user/message', 'assistant/message']).flat())
    const registry = { version: 1, branches: [], activeBranchId: null, activeHeadSeq: null }
    const branchOps = branch({ ...folded, branchRegistry: registry }, 'variant')
    registry.branches.push(branchOps[0].branch)
    assert.doesNotThrow(() => checkout({ ...folded, branchRegistry: registry }, branchOps[0].branch.branchId))
  }
})
