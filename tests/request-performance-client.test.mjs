import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

test('HTTP RPC 拒因保留结构化错误码，兼容旧服务端的纯文本错误', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('\t\tfunction rpc(method,')
  let response = { ok: false, error: '事件不匹配', errorCode: 'MVU_SETTLEMENT_EVENT_MISMATCH' }
  const scope = vm.createContext({ window: {}, performance, Date,
    performanceReportAt: Date.now(), pagePerformanceStarted: Date.now(), pagePerformance: {},
    beginSessionViewRead: () => null, tavernRuntimeGenerationMonitor: { observe() {} },
    readTavernJsonResponse: res => res.json(), fetch: async () => ({ json: async () => response }) })
  vm.runInContext(source.slice(start, source.indexOf('\n\t\tfunction recordImageInteraction', start)), scope)
  await assert.rejects(scope.rpc('updateTavernHelperVariables', {}, 's'), error => error.message === '事件不匹配' && error.code === 'MVU_SETTLEMENT_EVENT_MISMATCH')
  response = { ok: false, error: '旧服务端错误' }
  await assert.rejects(scope.rpc('updateTavernHelperVariables', {}, 's'), error => error.message === '旧服务端错误' && error.code === undefined)
})

test('视图 HTTP 请求全部阻塞时，领取、续租和回执仍经独立控制通道完成', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('\t\tfunction rpc(method,')
  const held = [], control = []
  const scope = vm.createContext({
    window: {}, performance, Date, Math,
    performanceReportAt: Date.now(), pagePerformanceStarted: Date.now(), pagePerformance: {},
    performanceRequests: [], performanceActiveRequests: 0,
    beginSessionViewRead: () => null, tavernRuntimeGenerationMonitor: { observe() {} },
    readTavernJsonResponse: res => res.json(),
    fetch: (_url, request) => new Promise(resolve => held.push({ request, resolve })),
    tavernSessionSignals: { async control(method, args, signal) {
      control.push({ method, args, signal })
      return { ok: true, active: true }
    } }
  })
  vm.runInContext(source.slice(start, source.indexOf('\n\t\tfunction recordImageInteraction', start)), scope)
  const views = Array.from({ length: 6 }, () => scope.rpc('getSession', {}, 's'))
  const methods = ['claimTavernScriptWork', 'startTavernScriptWork', 'getTavernScriptWorkState',
    'heartbeatTavernScriptRuntime', 'completeTavernHelperEvent', 'releaseTavernHelperRuntime']
  const controller = new AbortController()
  const requests = methods.map(method => scope.rpc(method, { runtimeId: 'runtime' }, 's', { signal: controller.signal }))
  try {
    const completed = await Promise.race([
      Promise.all(requests).then(() => true),
      new Promise(resolve => setImmediate(() => resolve(false)))
    ])
    assert.equal(completed, true, 'control must not wait for any heavy HTTP response')
    assert.equal(held.length, 6)
    assert.deepEqual(control.map(call => call.method), methods)
    assert.ok(control.every(call => call.args.sessionId === 's' && call.signal === controller.signal))
    scope.tavernSessionSignals.control = async () => { throw new Error('control disconnected') }
    await assert.rejects(scope.rpc('claimTavernScriptWork', {}, 's'), /control disconnected/)
    assert.equal(held.length, 6, 'a control error must not retry through the saturated HTTP carrier')
  } finally {
    for (const request of held) request.resolve({ json: async () => ({ ok: true }) })
    await Promise.all([...views, ...requests])
  }
})
