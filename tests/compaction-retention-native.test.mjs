import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createInitializationNative } from './fixtures/conversation-initialization-native.mjs'
import { installCompactionPolicy } from '../tavern-plugin/lib/domain/auto-compaction.js'
import { createCompactionPlans, createForegroundRetention } from '../tavern-plugin/lib/domain/foreground-retention.js'
import { compactIdleRegion } from '../tavern-plugin/lib/domain/idle-compaction.js'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { liveFloors } from '../tavern-plugin/lib/domain/floor-projection.js'

// Real DSH Session, token meter and BasicCompactionEngine; scripted model.
const native = { skip: !process.env.DSH_BOOT_MODULE, timeout: 60000 }

async function fixture(t, { rounds = 6, text = '剧情推进，人物关系变化。'.repeat(6), contextWindow = 100000, before } = {}) {
  const h = await createInitializationNative(process.env.DSH_BOOT_MODULE, { contextWindow })
  t.after(() => h.dispose())
  // Hooks registered first run first: the summary-request projection wraps the scripted model.
  if (before) before(h)
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  const summaries = [], observers = []
  h.ctx.on('llm/stream', (request, next) => {
    if (request.purpose !== 'compaction') return next()
    summaries.push(request)
    for (const observe of observers) observe(request)
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: h.summaryText ? h.summaryText(request) : '摘要。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
  const agent = h.target.agent
  for (let i = 1; i <= rounds; i++) {
    agent.followup({ id: 'input-' + i, role: 'user', content: [{ type: 'text', text: '第' + i + '轮：' + text }], source: { kind: 'user' } })
    await agent.whenIdle()
  }
  return { h, agent, session: agent.session, summaries, observers, BasicCompactionEngine }
}
const floorsOf = session => [...liveFloors(sessionEvents(session), [...session.surface.nodes]).values()]
const inputText = (session, floor) => sessionEvents(session).find(event => event.seq === floor.inputSeq).data.content[0].text.slice(0, 4)

test('real host: player inputs become floors', native, async t => {
  const { session } = await fixture(t, { rounds: 3 })
  assert.deepEqual(floorsOf(session).map(floor => inputText(session, floor)), ['第1轮：', '第2轮：', '第3轮：'])
})

function normalized(events) {
  const ids = new Map()
  const name = value => { if (!ids.has(value)) ids.set(value, 'id-' + ids.size); return ids.get(value) }
  return JSON.parse(JSON.stringify(events, (key, value) => (key === 'compactionId' || (key === 'id' && typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value))) ? name(value) : key === 'ts' || key === 'time' || key === 'timestamp' || key === 'at' ? 0 : value))
}

test('real host: the idle transaction over a range writes what the host compactNow writes', native, async t => {
  const host = await fixture(t, { rounds: 4 })
  const ours = await fixture(t, { rounds: 4 })
  assert.deepEqual(normalized(sessionEvents(ours.session)), normalized(sessionEvents(host.session)), 'identical scripted histories')
  const before = host.session.seq
  const engineA = new host.BasicCompactionEngine(host.h.ctx, { auto: false })
  const nativeResult = await engineA.compactNow(host.agent, new AbortController().signal)
  assert.ok(nativeResult)
  const engineB = new ours.BasicCompactionEngine(ours.h.ctx, { auto: false })
  let flushed = 0
  const result = await ours.agent.runMaintenance(signal => compactIdleRegion({
    dependencies: engineB.regionDependencies(), agent: ours.agent, start: nativeResult.shadowedRange.start, end: nativeResult.shadowedRange.end, signal,
    flush: async () => { flushed++; await ours.h.ctx.sessions.flush(ours.session) }
  }))
  assert.equal(flushed, 1)
  assert.deepEqual(normalized(sessionEvents(ours.session).slice(before)), normalized(sessionEvents(host.session).slice(before)))
  assert.deepEqual(normalized(result), normalized(nativeResult))
  assert.deepEqual([...ours.session.surface.nodes], [...host.session.surface.nodes])
  assert.deepEqual(normalized(ours.session.deriveMessages()), normalized(host.session.deriveMessages()))
})

function retentionFor(f, { rounds = 2, foreground = true, contextWindow = 100000 } = {}) {
  const plans = createCompactionPlans(), seen = []
  f.observers.push(request => seen.push(plans.current(request.sessionId)))
  const retention = createForegroundRetention({
    retainRounds: async () => rounds, isForeground: async () => foreground, meter: () => f.h.ctx.tokenMeter,
    contextWindow: async () => contextWindow, flush: session => f.h.ctx.sessions.flush(session), plans
  })
  return { plans, seen, retention }
}

test('real host: idle compaction keeps the latest rounds as real nodes, again and again', native, async t => {
  const f = await fixture(t, { rounds: 5 })
  const engine = new f.BasicCompactionEngine(f.h.ctx, { auto: false })
  const { plans, seen, retention } = retentionFor(f, { rounds: 2 })
  t.after(installCompactionPolicy(engine, (_agent, _trigger, _signal, native) => native(), { retention }))
  const result = await engine.compactNow(f.agent, new AbortController().signal)
  assert.equal(result.retained, 2)
  assert.match(result.message, /已压缩第 1–3 轮的剧情，保留最近 2 轮原文/)
  assert.deepEqual(floorsOf(f.session).map(floor => inputText(f.session, floor)), ['第4轮：', '第5轮：'])
  assert.deepEqual(seen, [{ from: 1, through: 3, kept: 2, retainRounds: 2 }])
  assert.equal(plans.current(f.session.id), null)
  // The retained replies are the original nodes, byte for byte.
  const kept = floorsOf(f.session).map(floor => floor.bodySeq)
  assert.ok(kept.every(seq => sessionEvents(f.session).find(event => event.seq === seq).surfaceOp === 'append' || sessionEvents(f.session).find(event => event.seq === seq).surfaceOp === undefined))

  for (let i = 6; i <= 8; i++) {
    f.agent.followup({ id: 'input-' + i, role: 'user', content: [{ type: 'text', text: '第' + i + '轮：后续。'.repeat(20) }], source: { kind: 'user' } })
    await f.agent.whenIdle()
  }
  const second = await engine.compactNow(f.agent, new AbortController().signal)
  assert.match(second.message, /保留最近 2 轮原文/)
  assert.deepEqual(floorsOf(f.session).map(floor => inputText(f.session, floor)), ['第7轮：', '第8轮：'])
  assert.deepEqual(seen.at(-1), { from: 4, through: 6, kept: 2, retainRounds: 2 })
  // The second summary request starts from the first checkpoint.
  const request = f.summaries.at(-1)
  const first = request.messages.find(message => message.role !== 'system')
  assert.equal(first.source?.kind, 'compact-checkpoint')
})

test('real host: idle rounds within the quota report nothing to compact; /compact gets null', native, async t => {
  const f = await fixture(t, { rounds: 3 })
  const engine = new f.BasicCompactionEngine(f.h.ctx, { auto: false })
  const { retention } = retentionFor(f, { rounds: 10 })
  t.after(installCompactionPolicy(engine, (_agent, _trigger, _signal, native) => native(), { retention }))
  const before = f.session.seq
  const result = await engine.compactNow(f.agent, new AbortController().signal)
  assert.equal(result.retained, 3); assert.deepEqual(result.shadowedSeqs, [])
  assert.match(result.message, /最近 3 轮剧情保留原文/)
  assert.equal(await engine.compactNow(f.agent, new AbortController().signal, 'command-1'), null)
  assert.equal(f.session.seq, before, 'nothing written')
  assert.equal(f.summaries.length, 0)
})

test('real host: non-story sessions and retention 0 keep the host compaction', native, async t => {
  for (const options of [{ foreground: false, rounds: 2 }, { foreground: true, rounds: 0 }]) {
    const f = await fixture(t, { rounds: 4 })
    const engine = new f.BasicCompactionEngine(f.h.ctx, { auto: false })
    const { seen, retention } = retentionFor(f, options)
    t.after(installCompactionPolicy(engine, (_agent, _trigger, _signal, native) => native(), { retention }))
    const result = await engine.compactNow(f.agent, new AbortController().signal)
    assert.equal(result.retained, undefined)
    // The host keeps only the last node: no player input survives.
    assert.deepEqual(floorsOf(f.session), [])
    if (options.foreground) assert.deepEqual(seen, [{ from: 1, through: 3, kept: 0, retainRounds: 0 }])
    else assert.deepEqual(seen, [null])
  }
})

test('real host: in-turn pressure moves the end before the retained rounds; provider overflow keeps the host range', native, async t => {
  for (const trigger of ['pressure', 'context-overflow']) {
    const f = await fixture(t, { rounds: 6, contextWindow: 8000, text: '剧情推进，人物关系变化。'.repeat(30) })
    const total = f.h.ctx.tokenMeter.measure(f.session).totalTokens
    const engine = new f.BasicCompactionEngine(f.h.ctx, { auto: false, headroomTokens: 0, maxTokens: 128, thresholdRatio: total * 0.75 / 8000, retainRatio: 0.01 })
    const { seen, retention } = retentionFor(f, { rounds: 3, contextWindow: 8000 })
    t.after(installCompactionPolicy(engine, (_agent, _trigger, _signal, native) => native(), { retention }))
    f.session.append('request/header', { header: { config: { provider: 'initialization-fixture', model: 'text' } }, reason: 'initial' })
    const turn = 100
    f.session.append('turn/start', { turn })
    let result
    try { result = await engine.compactIfNeeded(f.agent, trigger, new AbortController().signal) }
    finally { f.session.append('turn/end', { turn, reason: { kind: 'completed' } }) }
    assert.ok(result, trigger)
    const kept = floorsOf(f.session).map(floor => inputText(f.session, floor))
    if (trigger === 'pressure') {
      assert.deepEqual(kept, ['第4轮：', '第5轮：', '第6轮：'])
      assert.deepEqual(seen[0], { from: 1, through: 3, kept: 3, retainRounds: 3 })
    } else {
      assert.deepEqual(kept, [])
      assert.equal(seen[0].kept, 0)
    }
  }
})

test('real host: two story compactions write volume 1, then carry it byte for byte before volume 2', native, async t => {
  const { installCompactionRequestProjection } = await import('../tavern-plugin/lib/domain/compaction-request.js')
  const { createStorySummaryPreparation, STORY_SUMMARY_NOTE } = await import('../tavern-plugin/lib/domain/story-compaction.js')
  const plans = createCompactionPlans()
  const f = await fixture(t, { rounds: 5, text: '剧情推进，人物关系变化。'.repeat(40), before: h => {
    installCompactionRequestProjection(h.ctx, async () => true, createStorySummaryPreparation({
      isStory: async () => true, plan: sessionId => plans.current(sessionId), retainRounds: async () => 2, prompt: () => '剧情压缩提示词',
      contextWindow: async () => 100000, stream: request => h.ctx.llm.stream(request)
    }))
    // The model writes a wrong header; the program's replaces it.
    h.summaryText = request => request.messages.at(-1).content[0].text.includes('第 1 卷') ? '第 5 卷 · 错\n剧情脉络\n- 甲乙结盟。' : '剧情脉络\n- 北门会合。'
  } })
  const engine = new f.BasicCompactionEngine(f.h.ctx, { auto: false })
  const retention = createForegroundRetention({ retainRounds: async () => 2, isForeground: async () => true, meter: () => f.h.ctx.tokenMeter,
    contextWindow: async () => 100000, flush: session => f.h.ctx.sessions.flush(session), plans })
  t.after(installCompactionPolicy(engine, (_agent, _trigger, _signal, native) => native(), { retention }))
  const checkpointTexts = () => {
    const seq = [...f.session.surface.nodes].find(seq => sessionEvents(f.session).find(event => event.seq === seq)?.data?.source?.kind === 'compact-checkpoint')
    return sessionEvents(f.session).find(event => event.seq === seq).data.content.map(block => block.text)
  }
  await engine.compactNow(f.agent, new AbortController().signal)
  const first = checkpointTexts()
  assert.deepEqual(first.slice(1, -1), [STORY_SUMMARY_NOTE, '第 1 卷 · 第 1–3 轮\n剧情脉络\n- 甲乙结盟。'])
  assert.match(f.summaries[0].messages.at(-1).content[0].text, /^剧情压缩提示词\n\n【本次摘要的写法】/)
  for (let i = 6; i <= 8; i++) {
    f.agent.followup({ id: 'input-' + i, role: 'user', content: [{ type: 'text', text: '第' + i + '轮：后续。'.repeat(20) }], source: { kind: 'user' } })
    await f.agent.whenIdle()
  }
  await engine.compactNow(f.agent, new AbortController().signal)
  const second = checkpointTexts()
  assert.equal(second[2], first[2], 'volume 1 is carried byte for byte')
  assert.deepEqual(second.slice(1, -1), [STORY_SUMMARY_NOTE, first[2], '第 2 卷 · 第 4–6 轮\n剧情脉络\n- 北门会合。'])
  const instruction = f.summaries.at(-1).messages.at(-1).content[0].text
  assert.match(instruction, /已有 1 卷旧摘要（截至第 3 轮）/)
  assert.doesNotMatch(instruction, /当前情况/)
})
