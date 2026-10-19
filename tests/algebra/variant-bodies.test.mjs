import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import { projectVariantBodies } from '../../lib/domain/floor-projection.js'
import { projectTavernHelperContext } from '../../lib/domain/tavern-helper-context.js'
import { appendSessionEvent } from '../../lib/domain/session-events.js'
import { createSessionSurfaceMutator } from '../../lib/domain/session-surface-mutations.js'

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }

test('variant bodies materialize from turn-tagged branches', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const session = Session.create('variant-bodies')
    appendSessionEvent(session, 'user/message', { id: 'input', role: 'user', content: [{ type: 'text', text: '推门' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', { turn: 2, step: 1, stream: [], message: { id: 'old', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: MODEL } }, { surfaceOp: 'append' })
    // Simulate a slice-A reroll: old body cleared, new body appended.
    createSessionSurfaceMutator(session).replace('user/message', { id: 't1', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'conversation-metadata' } }, { start: 1, end: 1, sourceEventSeqs: [1] })
    session.append('turn/start', { turn: 3 })
    appendSessionEvent(session, 'user/message', { id: 'synthetic', role: 'user', content: [{ type: 'text', text: '推门' }], source: { kind: 'plugin', plugin: 'dsh-tavern-regen' } }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', { turn: 3, step: 1, stream: [], message: { id: 'new', role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: MODEL } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const registry = { branches: [
      { branchId: 'b1', headSeq: 1, turn: 2, active: false },          // first reroll archive: old body was live
      { branchId: 'b2', headSeq: 5, turn: 2, active: false }           // second reroll archive: new body was live
    ] }
    // Each branch contributes the body live at its head; dedup against the
    // active floor is the helper projection's job (see the test below).
    const bodies = projectVariantBodies(session, registry)
    assert.deepEqual(bodies['2'], ['旧正文', '新正文'])
    // Uncached second read with identical inputs hits the cache entry.
    assert.deepEqual(projectVariantBodies(session, registry), bodies)
    assert.deepEqual(projectVariantBodies(session, { branches: [] }), {})
    assert.deepEqual(projectVariantBodies(session, { branches: [{ branchId: 'empty', headSeq: 5 }] }), {})
  } finally { patch.dispose() }
})

test('helper context surfaces variants for the regenerated floor', async () => {
  const chat = {
    id: 'chat',
    messages: [
      { role: 'assistant', greeting: true, text: '开场', turn: 1 },
      { role: 'user', text: '推门' },
      { role: 'assistant', text: '新正文', sourceText: '新正文', turn: 2 }
    ]
  }
  const withVariants = projectTavernHelperContext(chat, { variantBodies: { '2': ['旧正文'] } })
  const floor = withVariants.messages[2]
  assert.deepEqual(floor.swipes, ['旧正文', '新正文'])
  assert.equal(floor.swipe_id, 1)
  assert.equal(floor.message, '新正文')
  // Without variants, stored mirrors and single-body fallback stay intact.
  const without = projectTavernHelperContext(chat, {})
  assert.deepEqual(without.messages[2].swipes, ['新正文'])
})

test('helper context aligns the stored MVU snapshot with the selected variant', async () => {
  const state = { stat_data: { hp: 7 } }
  const chat = {
    id: 'chat',
    messages: [
      { role: 'assistant', greeting: true, text: '开场', turn: 1 },
      { role: 'user', text: '推门' },
      { role: 'assistant', text: '新正文', sourceText: '新正文', turn: 2, swipeId: 0, variables: [state] }
    ]
  }
  const floor = projectTavernHelperContext(chat, { variantBodies: { '2': ['旧正文', '次正文'] } }).messages[2]
  assert.equal(floor.swipe_id, 2)
  assert.deepEqual(floor.variables, state)
  assert.deepEqual(floor.swipes_data[2], state)
  assert.equal(floor.swipes_data.length, 3)
})
