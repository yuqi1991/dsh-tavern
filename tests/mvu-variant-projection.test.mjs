// MVU state follows the selected variant (ADR-0008/0009). The Chat keeps the
// variables of its own body only; every projection handed to scripts must align
// them with the branch-derived swipe, including the fork's fast paths.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTavernScriptHostAdapter } from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'
import { projectMvuReceipt } from '../tavern-plugin/lib/domain/mvu-working-copy.js'
import { projectTavernHelperMessage } from '../tavern-plugin/lib/domain/tavern-helper-context.js'

const VARIANTS = ['旧正文', '新正文']

function chat() {
  return {
    id: 'chat-1', sessionId: 'session-1', cardPath: 'cards/test.json', mode: 'story', mvu: { enabled: true },
    tavernHelperLifecycleRevision: 1, variables: {},
    messages: [
      { role: 'assistant', greeting: true, turn: 1, text: '开场', sourceText: '开场', swipes: ['开场'], swipeId: 0, variables: [{ hp: 1 }] },
      // The live body is the newest variant; the Chat stores one swipe only.
      { role: 'assistant', turn: 2, text: '新正文', sourceText: '新正文', swipes: ['新正文'], swipeId: 0, variables: [{ hp: 7 }] }
    ]
  }
}

function adapterWith(value, variantBodiesOf) {
  return createTavernScriptHostAdapter({
    resolveChat: async () => value, writeChat: async () => {}, readCard: async () => ({ name: '测试卡' }),
    worldBooks: { bound: async () => null },
    scriptDispatch: { dispatch: async () => ({ handled: true }), poll: () => ({ active: true, event: null }), complete: () => true, dispose: () => true },
    isPlayChat: row => row.mode === 'story',
    ...(variantBodiesOf ? { variantBodiesOf } : {})
  })
}

const expectAligned = row => {
  assert.deepEqual(row.swipes, VARIANTS)
  assert.equal(row.swipe_id, 1)
  assert.deepEqual(row.variables, { hp: 7 })
}

test('the full Helper context aligns the selected variant with its own variables', async () => {
  const adapter = adapterWith(chat(), () => ({ 2: VARIANTS }))
  expectAligned((await adapter.context('session-1')).messages[1])
})

test('without branch variants the stored swipes and variables stay as they were', async () => {
  const adapter = adapterWith(chat(), () => ({}))
  const row = (await adapter.context('session-1')).messages[1]
  assert.deepEqual(row.swipes, ['新正文'])
  assert.equal(row.swipe_id, 0)
  assert.deepEqual(row.variables, { hp: 7 })
})

test('the indexed projection used by incremental dispatch is aligned too', async () => {
  const adapter = adapterWith(chat(), () => ({ 2: VARIANTS }))
  const projected = await adapter.context('session-1', chat(), '', [1])
  assert.equal(projected.messages.length, 1)
  expectAligned(projected.messages[0])
})

test('a compact receipt carries the aligned message, not the stored mirror', () => {
  const work = { chat: chat(), eventId: 'event', sequence: 0 }
  const receipt = projectMvuReceipt(work, [{ messageId: 1 }], { 2: VARIANTS })
  expectAligned(receipt.messages[0])
  // Callers that pass no variants keep the previous behaviour.
  const plain = projectMvuReceipt({ chat: chat(), eventId: 'event', sequence: 0 }, [{ messageId: 1 }])
  assert.deepEqual(plain.messages[0].swipes, ['新正文'])
})

test('settlement may read the stored variables directly: they equal the aligned projection', () => {
  for (const variants of [null, VARIANTS, ['新正文', '更新的正文']]) {
    const message = chat().messages[1]
    const projected = projectTavernHelperMessage(message, 1, variants)
    assert.deepEqual(projected.variables, message.variables[message.swipeId], JSON.stringify(variants))
  }
})
