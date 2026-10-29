import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

function loadClient() {
  let descriptor
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console }
  vm.runInNewContext(source, sandbox)
  return descriptor.factory(function () { return {} })
}

const client = loadClient()

function host2020() {
  const rows = {
    'session-main': { id: 'session-main', blank: false, retainedBy: Object.freeze(Object.assign(Object.create(null), { mainView: 1 })) },
    'session-blank': { id: 'session-blank', blank: true, retainedBy: Object.freeze(Object.create(null)) },
  }
  const bindings = new Map()
  const retained = []
  const opened = []
  let cleared = 0
  return {
    opened,
    rows,
    retained,
    get cleared() { return cleared },
    sessions: {
      list: {
        getSnapshot() {
          return { phase: 'ready', ids: Object.keys(rows), byId: rows, projectionsBySession: {} }
        },
      },
      binding(id) { return bindings.get(id) },
      scope(id) { return { id } },
      create() { return Promise.resolve({ ok: true, value: { sessionId: 'session-created' } }) },
      fork() { return Promise.resolve({ ok: true, value: { sessionId: 'session-forked' } }) },
      retain(target, options) {
        retained.push([target, options && options.source])
        if (rows[target] === undefined) throw new Error('sessions.retain: unknown session ' + target)
        bindings.set(target, { sessionId: target, session: {} })
        return { sessionId: target, release() { bindings.delete(target) } }
      },
      subagentAddress() { return undefined },
    },
    uiWorkspace: {
      openSession(id) { opened.push(id) },
      clearMain() { cleared += 1 },
    },
  }
}

test('0.2.0 主会话由 mainView retain 推导，而不是已删除的 current 字段', function () {
  const host = host2020()
  const compat = client.createSessionCompat(host.sessions, host.uiWorkspace)
  assert.equal(compat.current, 'session-main')
  assert.equal('current' in compat, true)
})

test('open() 走 uiWorkspace.openSession，并让 recovery 的 summary+binding 就绪', function () {
  const host = host2020()
  const compat = client.createSessionCompat(host.sessions, host.uiWorkspace)
  compat.open('session-blank')
  assert.deepEqual(host.opened, ['session-blank'])
  // 宿主侧 replaceMain 会 retain；这里手动复现 retain 后 ready 条件成立。
  host.sessions.retain('session-blank', { source: 'mainView' })
  const summary = compat.list.getSnapshot().byId['session-blank']
  const binding = compat.binding('session-blank')
  assert.ok(summary && binding)
})

test('uiWorkspace 缺失时 open() 退化为 retain，未知会话错误冒泡给 recovery 判定', async function () {
  const host = host2020()
  const compat = client.createSessionCompat(host.sessions, null)
  await compat.open('session-blank')
  assert.deepEqual(host.retained, [['session-blank', 'tavern']])
  assert.equal(compat.binding('session-blank').sessionId, 'session-blank')
  // 0.2.0 的 sessions.retain 对未列清单 id 抛错；recovery 的 isUnknownSession 据此走 wait 重试。
  assert.throws(function () { compat.open('session-ghost') }, /sessions\.retain: unknown session session-ghost/)
  assert.equal(host.retained.length, 2)
})

test('clear() 走 uiWorkspace.clearMain，空参数等价于 clear', async function () {
  const host = host2020()
  const compat = client.createSessionCompat(host.sessions, host.uiWorkspace)
  compat.clear()
  assert.equal(host.cleared, 1)
  await compat.open('')
  assert.equal(host.cleared, 2)
})

test('0.1.5 快照的 current 字段仍然被识别', function () {
  const legacy = {
    list: { getSnapshot() { return { phase: 'ready', current: 'session-legacy', byId: { 'session-legacy': { id: 'session-legacy' } } } } },
    binding() { return undefined },
    scope() { return {} },
  }
  const compat = client.createSessionCompat(legacy, null)
  assert.equal(compat.current, 'session-legacy')
})

test('0.2.0 快照没有 current 时不会误判旧会话', function () {
  const host = host2020()
  const compat = client.createSessionCompat(host.sessions, host.uiWorkspace)
  delete host.rows['session-main']
  assert.equal(compat.current, '')
})

test('recovery 在 0.2.0 下能靠 retain 满足就绪条件，不再超时', async function () {
  const host = host2020()
  const compat = client.createSessionCompat(host.sessions, host.uiWorkspace)
  const recovery = client.createSessionListRecoveryModule({
    summary(id) { return compat.list.getSnapshot().byId[id] },
    binding(id) { return compat.binding(id) },
    refresh() { return Promise.resolve() },
    open(id) { compat.open(id) },
    isUnknownSession(error) { return /sessions\.(select|retain): unknown session/i.test(String(error && error.message || error || '')) },
  })
  assert.equal(recovery.ready('session-blank'), false)
  // 0.2.0 的 replaceMain 会同步 retain；这里直接 retain 模拟宿主行为。
  host.sessions.retain('session-blank', { source: 'mainView' })
  await recovery.wait('session-blank')
  assert.equal(recovery.ready('session-blank'), true)
})

// 真实故障：点「开始新游戏」→ create() 只写入 placeholder 行，scope 尚未 retain。
// 旧适配器只读 scope，wait() 必然 8 秒超时（session-110820bb-... 即此路径）。
test('sessionListAdapters：新建但未 retain 的会话立即就绪（修复列表同步超时）', async function () {
  const host = host2020()
  // 模拟 create 之后：会话已进列表，但没有 scope。
  host.rows['session-fresh'] = {
    id: 'session-fresh', blank: true, updatedAt: 1,
    retainedBy: Object.freeze(Object.create(null)),
  }
  const compat = client.createSessionCompat(host.sessions, host.uiWorkspace)
  const adapters = client.sessionListAdapters(compat)
  const recovery = client.createSessionListRecoveryModule(adapters)

  assert.ok(adapters.summary('session-fresh'), 'placeholder 行应可读')
  assert.equal(adapters.binding('session-fresh').id, 'session-fresh', '未 retain 时 binding 以列表行兜底')
  assert.equal(recovery.ready('session-fresh'), true)
  await recovery.wait('session-fresh')

  // 真正打开时才 materialize scope，并保留真实 binding 语义。
  await recovery.open('session-fresh')
  assert.deepEqual(host.opened, ['session-fresh'])
  assert.equal(typeof compat.binding('session-fresh'), 'undefined', '未 retain 时真 binding 仍为空')
})

test('sessionListAdapters：会话还没进列表时 wait 会靠 refresh 重试', async function () {
  const host = host2020()
  const compat = client.createSessionCompat(host.sessions, host.uiWorkspace)
  const adapters = client.sessionListAdapters(compat)
  let refreshes = 0
  const recovery = client.createSessionListRecoveryModule(Object.assign({}, adapters, {
    refresh() {
      refreshes += 1
      host.rows['session-late'] = { id: 'session-late', blank: true, retainedBy: Object.freeze(Object.create(null)) }
      return Promise.resolve()
    },
  }))
  assert.equal(recovery.ready('session-late'), false)
  await recovery.wait('session-late')
  assert.ok(refreshes >= 1)
})
