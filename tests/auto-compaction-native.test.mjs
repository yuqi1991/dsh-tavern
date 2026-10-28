import test from 'node:test'
import assert from 'node:assert/strict'

import { pathToFileURL } from 'node:url'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { createAutoCompaction, installCompactionPolicy } from '../tavern-plugin/lib/domain/auto-compaction.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
const native = { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }

// Exercise the shipped isolated preset group and the production service resolver.

test('real background loop recovers provider overflow and retains the pending candidate request', native, async t => {
  const { compactBackgroundIfNeeded } = await import('../tavern-plugin/lib/domain/background-compaction.js')
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
  t.after(() => h.dispose())
  const boot = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', boot))
  const engine = new BasicCompactionEngine(h.ctx, { auto: true })
  let protectedRewind = false, rejectNext = false, rejected = 0
  t.after(installCompactionPolicy(engine, (agent, trigger, signal, fallback, forced) => compactBackgroundIfNeeded({
    trigger, forced, native: async () => null, pressure: async () => null
  }), { beforeRegion: async () => { protectedRewind = true } }))
  h.ctx.on('llm/stream', (request, next) => {
    if (request.purpose === 'compaction') assert.equal(protectedRewind, true)
    if (rejectNext && request.purpose !== 'compaction') {
      rejectNext = false; rejected++
      return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'maximum context length 1048576; requested 1089015 (705015 messages, 384000 completion)', code: 'CONTEXT_WINDOW_EXCEEDED' } } } })()
    }
    return next()
  })
  const agent = h.target.agent
  agent.followup({ id: 'old-background', role: 'user', content: [{ type: 'text', text: '已有剧情与结算。'.repeat(800) }], source: { kind: 'human' } })
  await agent.whenIdle()
  rejectNext = true
  agent.followup({ id: 'candidate', role: 'user', content: [{ type: 'text', text: '请生成本轮候选项。' }], source: { kind: 'human' } })
  await agent.whenIdle()
  const events = sessionEvents(agent.session)
  assert.equal(rejected, 1)
  assert.ok(events.some(e => e.type === 'compaction/summary'))
  assert.equal(events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed')
  const request = h.requests.filter(r => r.purpose !== 'compaction').at(-1)
  assert.match(JSON.stringify(request.messages), /请生成本轮候选项/)
})

for (const policy of [{ mode: 'manual' }, { mode: 'rounds', rounds: 100 }]) {
  test(`real foreground: ${policy.mode} schedule cannot suppress provider overflow recovery`, native, async t => {
    const { compactForegroundIfNeeded } = await import('../tavern-plugin/lib/domain/foreground-compaction.js')
    const h = await createInitializationNative(process.env.DSH_BOOT_MODULE)
    t.after(() => h.dispose())
    const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
    const engine = new BasicCompactionEngine(h.ctx, { auto: true })
    const chat = { id: 'test', mode: 'story', sessionId: h.target.session.id, messages: [] }
    const service = createAutoCompaction({
      readChat: async () => chat, updateChat: async (_id, fn) => fn(chat), policy: async () => policy,
      activity: () => { throw Error('must not wait for background settlement') },
      compact: () => { throw Error('must not enter joint maintenance') }
    })
    let rejectNext = false, rejected = 0, recorded = 0
    t.after(installCompactionPolicy(engine, (agent, trigger, signal, fallback, forced) => compactForegroundIfNeeded({
      trigger, native: () => trigger === 'context-overflow' ? fallback() : null, forced,
      pressure: async () => null, record: async () => { recorded++ },
      scheduled: () => service.run(agent.session.id, { agent, signal, openTurnCompact: forced })
    })))
    h.ctx.on('llm/stream', (request, next) => {
      if (rejectNext && request.purpose !== 'compaction') {
        rejectNext = false; rejected++
        return (async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'context length exceeded', code: 'CONTEXT_WINDOW_EXCEEDED' } } } })()
      }
      return next()
    })
    const agent = h.target.agent
    agent.followup({ id: 'old', role: 'user', content: [{ type: 'text', text: '已有剧情。'.repeat(800) }], source: { kind: 'human' } })
    await agent.whenIdle()
    rejectNext = true
    agent.followup({ id: 'new', role: 'user', content: [{ type: 'text', text: '继续本轮剧情。' }], source: { kind: 'human' } })
    await agent.whenIdle()
    const events = sessionEvents(agent.session)
    assert.equal(rejected, 1); assert.equal(recorded, 1)
    assert.ok(events.some(event => event.type === 'compaction/summary'))
    assert.equal(events.filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
    assert.match(JSON.stringify(h.requests.filter(request => request.purpose !== 'compaction').at(-1).messages), /继续本轮剧情/)
  })
}
