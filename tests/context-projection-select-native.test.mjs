import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installTavernTokenMeter } from '../tavern-plugin/lib/domain/tavern-token-meter.js'
import {
  installTavernContextProjections, wrapContextProjection, selfTestContextProjections,
  SUPPORTED_PROJECTION_VERSIONS, tavernStateVersion,
} from '../tavern-plugin/lib/domain/tavern-context-projections.js'
import { selectSurface } from '../tavern-plugin/lib/domain/surface-restoration.js'
import { createConversationAlgebraHostAdapter } from '../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'
import { createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { measureForegroundPressure } from '../tavern-plugin/lib/domain/foreground-context-pressure.js'
import { branch, checkout, committedMetadata, computeFold, runTransaction, editStep } from '../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { SURFACE_SELECT_TYPE } from '../tavern-plugin/lib/domain/surface-selection.js'

// 0.2.1 keeps the context-occupancy numbers in two session projections that fold
// only surfaceOp events. These tests run the real host (booted from
// DSH_BOOT_MODULE, with the Session patch preloaded) and compare every reading
// with the one reference that cannot drift: pricing deriveMessages() directly.
const native = { skip: !process.env.DSH_BOOT_MODULE }
const source = { kind: 'model', provider: 'fixture', model: 'text' }
const text = (n, c = 'x') => [{ type: 'text', text: c.repeat(n) }]

async function host(t, { install = true } = {}) {
  const url = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(url)
  const root = await mkdtemp(join(tmpdir(), 'tavern-projection-'))
  const config = join(root, 'host.yml')
  await writeFile(config, ['dsh-session', 'dsh-session-projection', 'dsh-token-meter'].map(n => '- name: ' + new URL('../../' + n + '/lib/index.js', url).href).join('\n'))
  const ctx = await boot('tavern-projection-test', config)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  t.after(installTavernTokenMeter(ctx.tokenMeter))
  if (install) t.after(installTavernContextProjections(ctx.sessionProjections))
  return ctx
}

/** A tavern-shaped log writer over one live session. */
function story(ctx, id) {
  const session = ctx.sessions.create(id, { meta: { agentPreset: 'tavern' } })
  const mark = (type, data) => session.append(type, data)
  const put = (type, data, surfaceOp = 'append') => {
    session.append(type, data, { surfaceOp, ...(surfaceOp === 'append' ? {} : { sourceEventSeqs: [surfaceOp.startSeq] }) })
    return session.seq - 1
  }
  const reply = (id, n, turn, usage) => ({ turn, step: 1, ...(usage ? { usage } : {}), stream: [], message: { id, role: 'assistant', content: text(n, 'a'), source } })
  const input = (id, n) => ({ id, role: 'user', content: text(n, 'u'), source: { kind: 'user' } })
  const price = () => session.deriveMessages().reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
  return { session, mark, put, reply, input, price }
}

/** Every reading against the direct estimate of what the model would see. */
function readings(ctx, session) {
  const meter = ctx.tokenMeter.measure(session)
  const breakdown = ctx.sessionProjections.stateOf(session, 'contextBreakdown')
  const pressure = ctx.sessionProjections.stateOf(session, 'contextPressure')
  return {
    meter: meter.surfaceTokens, breakdownSurface: breakdown.surfaceTokens, breakdown: breakdown.breakdown,
    pressureSurface: pressure.surfaceTokens,
    projected: pressure.pressureTokens === undefined ? undefined : pressure.pressureTokens + pressure.surfaceTokens - pressure.sampledSurfaceTokens,
  }
}

/** The six-step scenario: turns, regenerate (replace), rollback, rollback again, undo, variant switch. */
async function playScenario(s, check, { usage = true } = {}) {
  const { mark, put, reply, input, session } = s
  mark('turn/start', { turn: 1 }); mark('step/start', { turn: 1, step: 1 })
  const sys = put('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: text(400, 's'), source: { kind: 'system-prompt' } } })
  const u1 = put('user/message', input('u1', 400))
  mark('request/header', { header: { config: { provider: 'fixture', model: 'text' } }, reason: 'initial' })
  const a1 = put('assistant/message', reply('a1', 4000, 1, usage ? { inputTokens: 300, outputTokens: 1000 } : undefined))
  mark('step/end', { turn: 1, step: 1 }); mark('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await check('turn 1')
  mark('turn/start', { turn: 2 }); mark('step/start', { turn: 2, step: 1 })
  const u2 = put('user/message', input('u2', 800))
  const sampled = s.price()
  const a2 = put('assistant/message', reply('a2', 8000, 2, usage ? { inputTokens: 1500, outputTokens: 2000 } : undefined))
  mark('step/end', { turn: 2, step: 1 }); mark('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await check('turn 2', { pressure: 1500, sampled })
  const a2b = put('assistant/message', reply('a2b', 1200, 2), { op: 'replace', startSeq: a2, endSeq: a2 })
  await check('regenerate (replace)', { pressure: 1500, sampled })
  selectSurface(session, [sys, u1, a1])
  await check('rollback to turn 1', { pressure: 1500, sampled })
  selectSurface(session, [sys, u1])
  await check('rollback again, deeper', { pressure: 1500, sampled })
  selectSurface(session, [sys, u1, a1, u2, a2])
  await check('undo rollback (original reply)', { pressure: 1500, sampled })
  selectSurface(session, [sys, u1, a1, u2, a2b])
  await check('switch variant', { pressure: 1500, sampled })
  return { sys, u1, a1, u2, a2, a2b }
}

test('选择之后，上下文占用的各个读数都等于直接估算 deriveMessages()', native, async t => {
  const ctx = await host(t)
  const s = story(ctx, 'projection-select')
  const table = []
  await playScenario(s, (label, sample) => {
    const expected = s.price()
    const got = readings(ctx, s.session)
    table.push({ label, expected, ...got })
    assert.equal(got.meter, expected, label + ': token meter')
    assert.equal(got.pressureSurface, expected, label + ': contextPressure')
    assert.equal(got.breakdownSurface, expected, label + ': contextBreakdown 总量')
    assert.equal(got.breakdown.systemTokens + got.breakdown.messageTokens, expected, label + ': contextBreakdown 分项之和')
    assert.equal(got.breakdown.systemTokens, 104, label + ': 系统提示词只算系统')
    if (sample) assert.equal(got.projected, sample.pressure + expected - sample.sampled, label + ': 压力 = 采样 + 表面变化')
  })
  t.diagnostic(JSON.stringify(table))
})

test('对照：没装适配时，同一场景里两个投影确实漂移（选择与无价重放被忽略）', native, async t => {
  const ctx = await host(t, { install: false })
  const s = story(ctx, 'projection-stock')
  const drift = []
  await playScenario(s, label => {
    const expected = s.price()
    const got = readings(ctx, s.session)
    assert.equal(got.meter, expected, label + ': token meter 本来就对')
    drift.push({ label, expected, contextPressure: got.pressureSurface, contextBreakdown: got.breakdownSurface })
  })
  t.diagnostic(JSON.stringify(drift))
  // After the first rollback the stock projections still report both turns.
  const rollback = drift.find(row => row.label === 'rollback to turn 1')
  assert.equal(rollback.contextPressure, 3436)
  assert.equal(rollback.contextBreakdown, 3436)
  assert.equal(rollback.expected, 1220)
  // A replacement without a shadow-price event folds with zero delta, even without any selection.
  const regenerate = drift.find(row => row.label === 'regenerate (replace)')
  assert.notEqual(regenerate.contextPressure, regenerate.expected)
})

test('自动压缩读的是 token meter（不是这两个投影）：回退后触发读数随之下降，页面占用读数也同步下降', native, async t => {
  const ctx = await host(t)
  const s = story(ctx, 'projection-compaction')
  const capacity = 4000
  const llm = { resolveModelInfo: async () => ({ context: { contextWindow: capacity }, defaultMaxTokens: 0 }) }
  const rows = []
  await playScenario(s, async label => {
    const trigger = await measureForegroundPressure({ agent: { session: s.session }, signal: undefined, projections: ctx.sessionProjections, defaultModel: undefined, llm, meter: ctx.tokenMeter })
    const ui = ctx.sessionProjections.stateOf(s.session, 'contextPressure')
    const row = { label, expected: s.price(), triggerPercent: trigger.percent, uiSurfacePercent: 100 * ui.surfaceTokens / capacity }
    rows.push(row)
    assert.equal(trigger.percent, 100 * ctx.tokenMeter.measure(s.session).totalTokens / capacity, label + ': 触发读数就是 meter.measure().totalTokens')
    assert.equal(trigger.percent, 100 * row.expected / capacity, label + ': 没有服务商用量锚点时 = 直接估算')
    assert.equal(row.uiSurfacePercent, 100 * row.expected / capacity, label + ': 页面占用 = 直接估算')
  }, { usage: false })
  t.diagnostic(JSON.stringify(rows))
  assert.ok(rows.find(row => row.label === 'turn 2').triggerPercent > 80, '两轮之后超过 80%')
  assert.ok(rows.find(row => row.label === 'rollback to turn 1').triggerPercent < 80, '回退之后不再触发')
  assert.ok(rows.find(row => row.label === 'rollback to turn 1').uiSurfacePercent < 80, '页面也不再显示超限')
})

test('原生压缩（影子价格）之后，再回退到压缩前的节点，两个投影仍与直接估算一致', native, async t => {
  const ctx = await host(t)
  const { BasicCompactionEngine } = await import(new URL('../../dsh-compaction-basic/lib/index.js', pathToFileURL(process.env.DSH_BOOT_MODULE)))
  class FixtureCompaction extends BasicCompactionEngine {
    async summarize() { return { summary: [{ type: 'text', text: '剧情摘要。' }], provider: 'fixture', model: 'summary', maxTokens: 128 } }
  }
  const engine = new FixtureCompaction(ctx, { auto: false })
  const s = story(ctx, 'projection-compaction-native')
  const { session } = s
  const check = label => {
    const expected = s.price()
    const got = readings(ctx, session)
    assert.deepEqual([got.meter, got.pressureSurface, got.breakdownSurface], [expected, expected, expected], label)
    return expected
  }
  const sys = s.put('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: text(200, 's'), source: { kind: 'system-prompt' } } })
  const before = []
  for (let n = 0; n < 3; n++) {
    s.mark('turn/start', { turn: n + 2 }); s.mark('step/start', { turn: n + 2, step: 1 })
    before.push(s.put('user/message', s.input('history-' + n, 2000)), s.put('user/message', s.input('tail-' + n, 20)))
    s.mark('step/end', { turn: n + 2, step: 1 }); s.mark('turn/end', { turn: n + 2, reason: { kind: 'completed' } })
  }
  const uncompacted = [...session.surface.nodes]
  const full = check('压缩前')
  assert.ok(await engine.compactNow({ session, options: {}, runMaintenance: fn => fn(new AbortController().signal) }, new AbortController().signal))
  assert.ok(session.snapshotEvents().some(event => event.type === 'compaction/summary' || event.type === 'compaction/prune'))
  assert.ok(check('压缩后') < full)
  selectSurface(session, uncompacted)
  assert.equal(check('回退到压缩前的节点'), full)
  selectSurface(session, uncompacted.slice(0, 2))
  check('再回退到更早')
})

test('tokenUsage 是服务商用量累计，与表面无关：选择不改变它', native, async t => {
  const ctx = await host(t)
  const s = story(ctx, 'projection-usage')
  const totals = []
  await playScenario(s, label => totals.push({ label, ...ctx.sessionProjections.stateOf(s.session, 'tokenUsage').totals }))
  const afterTurn2 = totals.find(row => row.label === 'turn 2')
  for (const row of totals.slice(totals.indexOf(afterTurn2))) {
    const { label: _label, ...buckets } = row
    const { label: _l, ...expected } = afterTurn2
    assert.deepEqual(buckets, expected)
  }
  assert.equal(afterTurn2.uncachedInputTokens, 300 + 1500)
})

test('冷启动恢复：投影只靠检查点与日志尾重放，也得到同样的读数（不需要 Session）', native, async t => {
  const ctx = await host(t)
  const s = story(ctx, 'projection-cold')
  let midway
  await playScenario(s, label => { if (label === 'rollback to turn 1') midway = { checkpoint: ctx.sessionProjections.checkpoint(s.session), seq: s.session.seq } })
  const events = s.session.snapshotEvents()
  const live = ctx.sessionProjections.snapshot(s.session)
  const registry = ctx.sessionProjections
  // Full refold from nothing.
  const full = registry.restore({}, events, 0, s.session.header, 0)
  assert.deepEqual(full.snapshot.values, live.values)
  // Resume from a mid-log checkpoint that crossed a JSON round trip, then replay the tail.
  const stored = JSON.parse(JSON.stringify(midway.checkpoint))
  const floor = Number(registry.restoreFloor(stored))
  const resumed = registry.restore(stored, events.slice(floor), floor, s.session.header, 0)
  assert.deepEqual(resumed.snapshot.values, live.values)
  assert.deepEqual(resumed.checkpoint.contextPressure.val.tavern, full.checkpoint.contextPressure.val.tavern)
  // The cached rows carry our state version, so rows written by the stock definition are refolded, not trusted.
  assert.equal(resumed.checkpoint.contextPressure.ver, tavernStateVersion(SUPPORTED_PROJECTION_VERSIONS.contextPressure))
  const stockRow = { ...stored, contextPressure: { ...stored.contextPressure, ver: SUPPORTED_PROJECTION_VERSIONS.contextPressure } }
  assert.equal(registry.restoreFloor(stockRow), 0)
})

test('票 19：回退后再回退同一段，上下文读数不抛错、保持一致（真实代数事务）', native, async t => {
  const ctx = await host(t)
  const s = story(ctx, 'ticket-19')
  const { session } = s
  const adapter = createConversationAlgebraHostAdapter(session, { flush: async () => {} })
  const transact = async (name, build) => {
    const state = { ...computeFold(session.snapshotEvents()), branchRegistry: committedMetadata(session.snapshotEvents()) }
    await runTransaction(adapter, { expectedHead: state.headSeq, operationId: name, ops: build(state) })
  }
  const turn = (n, ulen, alen) => {
    s.mark('turn/start', { turn: n }); s.mark('step/start', { turn: n, step: 1 })
    const u = s.put('user/message', s.input('u' + n, ulen)); const a = s.put('assistant/message', s.reply('a' + n, alen, n))
    s.mark('step/end', { turn: n, step: 1 }); s.mark('turn/end', { turn: n, reason: { kind: 'completed' } })
    return { u, a }
  }
  const check = label => {
    const expected = s.price()
    const got = readings(ctx, session)
    assert.deepEqual([got.meter, got.pressureSurface, got.breakdownSurface], [expected, expected, expected], label)
  }
  s.mark('turn/start', { turn: 1 }); s.mark('step/start', { turn: 1, step: 1 })
  s.put('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: text(400, 's'), source: { kind: 'system-prompt' } } })
  s.mark('step/end', { turn: 1, step: 1 }); s.mark('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const t2 = turn(2, 400, 4000)
  const t3 = turn(3, 800, 8000)
  check('三轮')
  let saved
  await transact('rollback-1', state => { const b = branch(state, 'before-1'); saved = b[0].branch.branchId; return [...b, ...checkout(state, t3.u)] })
  check('回退一次')
  turn(4, 300, 2000)
  check('回退后新一轮')
  await transact('rollback-2', state => [...branch(state, 'before-2'), ...checkout(state, t3.u)])
  check('再回退同一段')
  await transact('rollback-3', state => checkout(state, t2.u))
  check('回退更深')
  await transact('undo', state => checkout(state, saved))
  check('撤销回退')
  await transact('edit', state => editStep(state, t3.a, { content: text(100, 'e') }))
  check('编辑后')
  await transact('rollback-4', state => [...branch(state, 'before-4'), ...checkout(state, t3.u)])
  check('编辑后再回退')
  // Native replacement over a displaced range, after selections moved the surface.
  const mutator = createSessionSurfaceMutator(session)
  const [first, second] = session.surface.nodes.slice(-2)
  mutator.replace('user/message', s.input('merged', 50), { start: first, end: second, sourceEventSeqs: [first, second] })
  check('选择之后对多节点范围做原生替换')
  selectSurface(session, [...session.surface.nodes])
  check('同一选择再来一次（空操作）')
})

test('冒烟：选择事件的形状出入不会让投影崩溃，只在无法跟随时交回库存行为', native, async t => {
  const ctx = await host(t)
  const s = story(ctx, 'projection-broken')
  s.mark('turn/start', { turn: 1 }); s.mark('step/start', { turn: 1, step: 1 })
  const sys = s.put('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: text(40, 's'), source: { kind: 'system-prompt' } } })
  const u1 = s.put('user/message', s.input('u1', 40))
  s.mark('step/end', { turn: 1, step: 1 }); s.mark('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Registry-level: feed a selection naming a seq the projection never priced.
  const registry = ctx.sessionProjections
  const registration = registry.registrations.get('contextPressure')
  let state = registration.def.init(s.session.header, 0)
  for (const event of s.session.snapshotEvents()) state = registration.def.apply(state, event)
  const priced = state.surfaceTokens
  const next = registration.def.apply(state, { type: SURFACE_SELECT_TYPE, seq: 99, time: 1, data: { version: 1, nodes: [sys, u1, 98] } })
  assert.equal(next.tavern.broken, true)
  assert.equal(next.surfaceTokens, priced, '无法跟随时不改读数')
  // A later well-formed selection re-bases it.
  const rebased = registration.def.apply(next, { type: SURFACE_SELECT_TYPE, seq: 100, time: 1, data: { version: 1, nodes: [sys] } })
  assert.equal(rebased.tavern.broken, false)
  assert.ok(rebased.surfaceTokens < priced)
})

test('安装与卸载：换成带 Tavern 状态版本的定义，卸载还原；重复注册同样被适配', native, async t => {
  const ctx = await host(t, { install: false })
  const registry = ctx.sessionProjections
  const stock = key => registry.registrations.get(key).def
  const stockPressure = stock('contextPressure')
  assert.equal(stockPressure.stateVersion, SUPPORTED_PROJECTION_VERSIONS.contextPressure)
  const had = Object.hasOwn(registry, 'register')
  const dispose = installTavernContextProjections(registry)
  const disposeAgain = installTavernContextProjections(registry)
  assert.equal(stock('contextPressure').stateVersion, tavernStateVersion(SUPPORTED_PROJECTION_VERSIONS.contextPressure))
  assert.equal(stock('contextBreakdown').stateVersion, tavernStateVersion(SUPPORTED_PROJECTION_VERSIONS.contextBreakdown))
  // A token meter reloading registers the stock definition again; it must be adapted too.
  const again = registry.register({ ...stockPressure })
  assert.equal(stock('contextPressure').stateVersion, tavernStateVersion(SUPPORTED_PROJECTION_VERSIONS.contextPressure))
  again()
  dispose()
  assert.equal(stock('contextPressure').stateVersion, tavernStateVersion(SUPPORTED_PROJECTION_VERSIONS.contextPressure), '仍有一个使用者，不还原')
  disposeAgain()
  assert.equal(stock('contextPressure'), stockPressure)
  assert.equal(Object.hasOwn(registry, 'register'), had)
})

test('宿主投影状态版本不符时明确报错，且不留半成品', native, async t => {
  const ctx = await host(t, { install: false })
  const registry = ctx.sessionProjections
  const registration = registry.registrations.get('contextBreakdown')
  const original = registration.def
  registration.def = { ...original, stateVersion: 7 }
  t.after(() => { registration.def = original })
  assert.throws(() => installTavernContextProjections(registry), /contextBreakdown.*状态版本为 7.*只适配 6/)
  assert.equal(registry.registrations.get('contextPressure').def.stateVersion, SUPPORTED_PROJECTION_VERSIONS.contextPressure, '先检查后替换：压力投影也没有被换掉')
  assert.equal(Object.hasOwn(registry, 'register'), false)
  assert.throws(() => wrapContextProjection({ ...original, key: 'tokenUsage' }), /no Tavern fold/)
  assert.throws(() => wrapContextProjection({ ...original, apply: undefined }), /缺少 apply/)
})

test('启动自检：在真实定义上证明「替换与选择之后 = 重新折叠」', native, async t => {
  const ctx = await host(t, { install: false })
  const defs = ['contextPressure', 'contextBreakdown'].map(key => wrapContextProjection(ctx.sessionProjections.registrations.get(key).def))
  assert.doesNotThrow(() => selfTestContextProjections(defs))
  // A wrapper whose bookkeeping disagrees with the stock fold is refused.
  const bent = defs.map(def => ({ ...def, apply: (state, event) => { const next = def.apply(state, event); return event.type === SURFACE_SELECT_TYPE ? { ...next, surfaceTokens: next.surfaceTokens + 1 } : next } }))
  assert.throws(() => selfTestContextProjections(bent), /会话投影补丁自检失败/)
})

test('长会话：折叠一万条消息的耗时（诊断用，宽松上限）', native, async t => {
  const ctx = await host(t)
  const s = story(ctx, 'projection-long')
  s.mark('turn/start', { turn: 1 }); s.mark('step/start', { turn: 1, step: 1 })
  s.put('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: text(400, 's'), source: { kind: 'system-prompt' } } })
  for (let n = 0; n < 5000; n++) { s.put('user/message', s.input('u' + n, 60)); s.put('assistant/message', s.reply('a' + n, 200, 1)) }
  s.mark('step/end', { turn: 1, step: 1 }); s.mark('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const registry = ctx.sessionProjections
  const events = s.session.snapshotEvents()
  const started = performance.now()
  const full = registry.restore({}, events, 0, s.session.header, 0)
  const elapsed = performance.now() - started
  const bytes = JSON.stringify(full.checkpoint).length
  t.diagnostic(`refold ${events.length} events: ${elapsed.toFixed(0)}ms, checkpoint ${(bytes / 1024).toFixed(0)}KB`)
  assert.equal(full.snapshot.values.contextBreakdown.messageTokens + full.snapshot.values.contextBreakdown.systemTokens, s.price())
  assert.ok(elapsed < 10000)
})
