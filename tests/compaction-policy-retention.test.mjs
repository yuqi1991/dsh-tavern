import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { installCompactionPolicy } from '../tavern-plugin/lib/domain/auto-compaction.js'

test('retained plugin teardown callbacks do not keep released compaction engines alive', async () => {
  await promisify(execFile)(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/compaction-policy-retention.mjs', import.meta.url))], { timeout: 15000 })
})

test('live engines still route and restore their original method at teardown', async () => {
  const calls = []
  const original = async function (...args) { calls.push([this, ...args]); return 'native' }
  const engine = { compactIfNeeded: original }
  const dispose = installCompactionPolicy(engine, async (_agent, _trigger, _signal, fallback) => fallback())
  assert.equal(await engine.compactIfNeeded('agent', 'pressure', 'signal'), 'native')
  assert.deepEqual(calls, [[engine, 'agent', 'pressure', 'signal']])
  dispose(); dispose()
  assert.equal(engine.compactIfNeeded, original)
})

test('teardown does not overwrite a later policy installed by another owner', () => {
  const engine = { compactIfNeeded() {} }
  const dispose = installCompactionPolicy(engine, async () => null)
  const replacement = () => 'replacement'
  engine.compactIfNeeded = replacement
  dispose()
  assert.equal(engine.compactIfNeeded, replacement)
})

test('region guard protects native and forced compaction without marking no-op checks', async () => {
  const calls = []
  const engine = {
    async compactIfNeeded(agent, trigger, signal) { return agent.needed ? this.compactRegion(1, 2, agent, signal) : null },
    async compactRegion(start, end, agent) { calls.push(['region', start, end, agent.id]); return 'summary' }
  }
  const originalRegion = engine.compactRegion
  const dispose = installCompactionPolicy(engine, (_agent, trigger, _signal, native, forced) => trigger === 'context-overflow' ? forced() : native(), {
    beforeRegion: async agent => { calls.push(['guard', agent.id]); if (agent.fail) throw Error('disk failure') }
  })
  await engine.compactIfNeeded({ id: 'noop' }, 'pressure')
  assert.deepEqual(calls, [])
  await engine.compactIfNeeded({ id: 'native', needed: true }, 'pressure')
  await engine.compactIfNeeded({ id: 'forced', needed: true }, 'context-overflow')
  await assert.rejects(engine.compactIfNeeded({ id: 'failed', needed: true, fail: true }, 'pressure'), /disk failure/)
  assert.deepEqual(calls, [['guard', 'native'], ['region', 1, 2, 'native'], ['guard', 'forced'], ['region', 1, 2, 'forced'], ['guard', 'failed']])
  dispose(); assert.equal(engine.compactRegion, originalRegion)
})

test('cancellation while saving the guard cannot start a summary afterwards', async () => {
  const controller = new AbortController()
  let compacted = false
  const engine = { compactIfNeeded() {}, compactRegion() { compacted = true } }
  const dispose = installCompactionPolicy(engine, () => null, { beforeRegion: async () => controller.abort() })
  await assert.rejects(engine.compactRegion(1, 2, {}, controller.signal), { name: 'AbortError' })
  assert.equal(compacted, false); dispose()
})

test('retention rewrites the end of in-turn regions per routed check and wraps compactNow; teardown restores both', async () => {
  const calls = [], released = []
  const engine = {
    async compactIfNeeded(agent, trigger, signal) { await this.compactRegion(1, 9, agent, signal); return this.compactRegion(1, 9, agent, signal) },
    async compactRegion(start, end) { calls.push(['region', start, end]); return 'summary' },
    async compactNow() { calls.push(['now']); return 'native-now' },
    regionDependencies() { return {} }
  }
  const { compactRegion, compactNow } = engine
  const retention = {
    async region({ start, end, trigger, attempt }) { calls.push(['plan', trigger, attempt]); return { end: attempt === 0 ? 5 : undefined, done: () => released.push(attempt) } },
    async idle({ native, engine: bound }) { calls.push(['idle', bound === engine]); return native() }
  }
  const dispose = installCompactionPolicy(engine, (_agent, _trigger, _signal, native) => native(), { retention })
  await engine.compactIfNeeded({ id: 'a' }, 'pressure')
  assert.deepEqual(calls.splice(0), [['plan', 'pressure', 0], ['region', 1, 5], ['plan', 'pressure', 1], ['region', 1, 9]])
  assert.deepEqual(released, [0, 1])
  assert.equal(await engine.compactNow({ id: 'a' }, new AbortController().signal), 'native-now')
  assert.deepEqual(calls.splice(0), [['idle', true], ['now']])
  dispose()
  assert.equal(engine.compactRegion, compactRegion); assert.equal(engine.compactNow, compactNow)
})

test('retention requires the host idle-compaction surface', () => {
  assert.throws(() => installCompactionPolicy({ compactIfNeeded() {}, compactRegion() {} }, () => null, { retention: {} }), /空闲压缩接口/)
})
