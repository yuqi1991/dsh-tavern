import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { Context } from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/cordis/lib/index.js'
import * as JsonlModule from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
const Jsonl = typeof JsonlModule.apply === 'function' ? JsonlModule : JsonlModule.default
async function openPersistence(ctx, options) { await ctx.plugin(Jsonl, options).await(); return ctx.sessionPersistence }
import { Session } from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import { SURFACE_SELECT_TYPE } from '../../lib/domain/surface-selection.js'
import { TokenMeter } from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js'
import { installTavernTokenMeter } from '../../lib/domain/tavern-token-meter.js'
import { computeFold, committedMetadata } from '../../lib/domain/conversation-algebra/index.js'
import { user, assistant, toolResult } from './helpers.mjs'

const RUNTIME = '/home/claw/dsh-stage-021/runtime/lib'
const system = { turn: 1, step: 1, message: { id: 'system', role: 'system', content: [{ type: 'text', text: 'rules' }], source: { kind: 'system-prompt' } } }

function withPatch(run) {
  return async () => {
    const patch = await prepareExpandedPatch(RUNTIME, { version: '0.2.1-rc.2' })
    try { await run(patch) } finally { patch.dispose() }
  }
}

/** Two variants of floor 1: A (with a tool call) and B (plain). */
function twoVariants(id) {
  const s = Session.create(id)
  const seq = {}
  const put = (name, type, data) => { s.append(type, data, { surfaceOp: 'append' }); seq[name] = s.seq - 1 }
  const mark = (type, data) => s.append(type, data)
  mark('turn/start', { turn: 1 })
  mark('step/start', { turn: 1, step: 1 })
  put('system', 'system/message', system)
  put('input', 'user/message', user('input', 'hello').data)
  put('callA', 'assistant/message', assistant('callA', [{ type: 'tool-call', id: 'c1', name: 'skill', arguments: '{}' }], 1).data)
  mark('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'skill', arguments: '{}' })
  put('toolA', 'tool/result', toolResult('toolA', 'c1', 1).data)
  mark('step/end', { turn: 1, step: 1 })
  mark('step/start', { turn: 1, step: 2 })
  put('bodyA', 'assistant/message', assistant('bodyA', 'variant A', 1, 2).data)
  mark('step/end', { turn: 1, step: 2 })
  mark('turn/end', { turn: 1, reason: { kind: 'completed' } })
  mark('turn/start', { turn: 2 })
  mark('step/start', { turn: 2, step: 1 })
  put('bodyB', 'assistant/message', assistant('bodyB', 'variant B', 2).data)
  mark('step/end', { turn: 2, step: 1 })
  mark('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { s, seq }
}

const select = nodes => ({ version: 1, nodes })
const texts = s => s.deriveMessages().map(message => message.content.map(block => block.text ?? block.type).join(''))

test('selection switches the live surface by reference', withPatch(() => {
  const { s, seq } = twoVariants('select-live')
  const before = s.surface.replaceGeneration
  s.append(SURFACE_SELECT_TYPE, select([seq.system, seq.input, seq.callA, seq.toolA, seq.bodyA]))
  assert.deepEqual([...s.surface.nodes], [seq.system, seq.input, seq.callA, seq.toolA, seq.bodyA])
  assert.equal(s.surface.replaceGeneration, before + 1)
  assert.deepEqual(texts(s), ['rules', 'hello', 'tool-call', 'loaded', 'variant A'])
  s.append(SURFACE_SELECT_TYPE, select([seq.system, seq.input, seq.bodyB]))
  assert.deepEqual(texts(s), ['rules', 'hello', 'variant B'])
  // Later native operations keep working on the selected surface.
  s.append('user/message', user('next', 'continue').data, { surfaceOp: 'append' })
  const next = s.seq - 1
  s.append('user/message', user('edited', 'continue!').data, { surfaceOp: { op: 'replace', startSeq: next, endSeq: next }, sourceEventSeqs: [next] })
  assert.deepEqual(texts(s), ['rules', 'hello', 'variant B', 'continue!'])
}))

test('selection guards reject without writing', withPatch(() => {
  const { s, seq } = twoVariants('select-guards')
  const cases = [
    [select([]), /system prompt/],
    [select([seq.system, seq.input, 999]), /earlier events/],
    [select([seq.system, seq.input, seq.input]), /must not repeat/],
    [select([seq.input, seq.bodyB]), /system prompt/],
    [select([seq.system, seq.input, seq.toolA]), /no selected tool call/],
    [select([seq.system, seq.input, seq.callA]), /lack their results/],
  ]
  for (const [data, pattern] of cases) {
    const head = s.seq
    assert.throws(() => s.append(SURFACE_SELECT_TYPE, data), pattern)
    assert.equal(s.seq, head, 'a rejected selection writes nothing')
  }
  s.append('step/start', { turn: 3, step: 1 })
  const lifecycle = s.seq - 1
  assert.throws(() => s.append(SURFACE_SELECT_TYPE, select([seq.system, lifecycle])), /not a surface message/)
}))

test('selection survives persistence and reload', withPatch(async patch => {
  const root = await mkdtemp('/home/claw/dsh-tavern-dev/surface-select-')
  const persistence = await openPersistence(new Context(), { root, compression: 'zstd' })
  patch.patchPersistence(persistence)
  let handle
  try {
    const { s, seq } = twoVariants('select-persist')
    s.append(SURFACE_SELECT_TYPE, select([seq.system, seq.input, seq.bodyB]))
    handle = await persistence.create(s.header)
    await handle.append(s.snapshotEvents())
    await handle.flush()
    await handle.close()
    handle = await persistence.open(s.id, 'read')
    const read = await handle.read()
    assert.equal(read.events.at(-1).type, SURFACE_SELECT_TYPE)
    const restored = Session.fromRestore(s.id, structuredClone(read.events), structuredClone(handle.header), handle.inheritedEventCount, 'detached')
    assert.deepEqual([...restored.surface.nodes], [seq.system, seq.input, seq.bodyB])
    assert.deepEqual(texts(restored), ['rules', 'hello', 'variant B'])
  } finally {
    await handle?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}))

test('a host without the patch refuses to load a selection log', async () => {
  const root = await mkdtemp('/home/claw/dsh-tavern-dev/surface-select-')
  try {
    const patch = await prepareExpandedPatch(RUNTIME, { version: '0.2.1-rc.2' })
    const s = Session.create('select-unpatched')
    try {
      const writer = await openPersistence(new Context(), { root, compression: 'zstd' })
      patch.patchPersistence(writer)
      s.append('user/message', user('input', 'hello').data, { surfaceOp: 'append' })
      s.append(SURFACE_SELECT_TYPE, select([0]))
      const handle = await writer.create(s.header)
      await handle.append(s.snapshotEvents())
      await handle.flush()
      await handle.close()
    } finally { patch.dispose() }
    const reader = await openPersistence(new Context(), { root, compression: 'zstd' })
    await assert.rejects(async () => { const handle = await reader.open(s.id, 'read'); await handle.read() }, /surface-select.*not marked ignorable/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Tavern fold and branch metadata read a committed selection', withPatch(() => {
  const { s, seq } = twoVariants('select-fold')
  const metadata = { version: 1, branches: [{ branchId: 'b1', headSeq: seq.bodyA, turn: 1 }], activeBranchId: 'b1', activeHeadSeq: seq.bodyA }
  s.append(SURFACE_SELECT_TYPE, { ...select([seq.system, seq.input, seq.callA, seq.toolA, seq.bodyA]),
    source: { kind: 'plugin:dsh-tavern', form: 'surface-select', conversationTransaction: { operationId: 'op-1', phase: 'commit', metadata } } })
  const fold = computeFold(s.snapshotEvents())
  assert.deepEqual(fold.surfaceNodes, [...s.surface.nodes])
  assert.deepEqual(fold.views.conversation.map(event => event.seq), [seq.input, seq.bodyA])
  assert.deepEqual(committedMetadata(s.snapshotEvents()), metadata)
  // An uncommitted selection (begin without commit) is ignored by the fold.
  s.append(SURFACE_SELECT_TYPE, { ...select([seq.system, seq.input, seq.bodyB]),
    source: { kind: 'plugin:dsh-tavern', form: 'surface-select', conversationTransaction: { operationId: 'op-2', phase: 'begin' } } })
  assert.deepEqual(computeFold(s.snapshotEvents()).surfaceNodes, [seq.system, seq.input, seq.callA, seq.toolA, seq.bodyA])
}))

test('token meter and compaction-style ranges follow the selected surface', withPatch(() => {
  // The native meter requires every model reply inside its step.
  const s = Session.create('select-meter')
  const seq = {}
  const put = (name, type, data, op = { surfaceOp: 'append' }) => { s.append(type, data, op); seq[name] = s.seq - 1 }
  put('system', 'system/message', system)
  put('input', 'user/message', user('input', 'hello').data)
  s.append('step/start', { turn: 1, step: 1 })
  put('bodyA', 'assistant/message', assistant('bodyA', 'variant A', 1).data)
  s.append('step/end', { turn: 1, step: 1 })
  s.append('step/start', { turn: 2, step: 1 })
  put('bodyB', 'assistant/message', assistant('bodyB', 'variant B', 2).data)
  s.append('step/end', { turn: 2, step: 1 })
  s.append(SURFACE_SELECT_TYPE, select([seq.system, seq.input, seq.bodyA]))
  s.append(SURFACE_SELECT_TYPE, select([seq.system, seq.input, seq.bodyB]))
  const meter = Object.create(TokenMeter.prototype)
  meter.states = new WeakMap()
  const dispose = installTavernTokenMeter(meter)
  try {
    const state = meter._sync(s)
    assert.deepEqual(state.surface.map(node => node.seq), [seq.system, seq.input, seq.bodyB])
    assert.ok(state.surface.every(node => node.heuristicTokens > 0))
    // A compaction summary replaces a multi-node range of the selected surface.
    s.append('user/message', user('summary', 'summary').data, { surfaceOp: { op: 'replace', startSeq: seq.input, endSeq: seq.bodyB }, sourceEventSeqs: [seq.input, seq.bodyB] })
    assert.deepEqual(texts(s), ['rules', 'summary'])
    assert.deepEqual(meter._sync(s).surface.map(node => node.seq), [seq.system, s.seq - 1])
  } finally { dispose() }
}))

test('the full-context page flags a request older than the current context', async () => {
  const { requestContextStale } = await import('../../lib/domain/model-request-log.js')
  const record = { id: (1000).toString(36) + '-x', createdAt: 1000 }
  const reply = { type: 'assistant/message', time: 1500, surfaceOp: 'append' }
  assert.equal(requestContextStale([{ type: 'user/message', time: 900, surfaceOp: 'append' }, reply], record), false)
  assert.equal(requestContextStale([reply, { type: SURFACE_SELECT_TYPE, time: 1600 }], record), true)
  assert.equal(requestContextStale([reply, { type: 'user/message', time: 1600, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }], record), true)
  // An unchanged poll carries only the id; its prefix holds the creation time.
  assert.equal(requestContextStale([{ type: SURFACE_SELECT_TYPE, time: 1600 }], { id: record.id, unchanged: true }), true)
  assert.equal(requestContextStale([{ type: SURFACE_SELECT_TYPE, time: 900 }], record), false)
})
