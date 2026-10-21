import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadClient() {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console, AbortController }
  vm.runInNewContext(source, sandbox)
  return descriptor.factory(function () { return {} })
}

async function loadFactory() {
  return (await loadClient()).createWorldBookLibraryRefreshModule
}

function deferred() {
  let resolve
  const promise = new Promise(function (done) { resolve = done })
  return { promise, resolve }
}

test('世界书库刷新进行中时把多次通知合并为一次补充刷新', async () => {
  const createRefresh = await loadFactory()
  assert.equal(typeof createRefresh, 'function')
  const pending = []
  let loads = 0
  const values = []
  const refresh = createRefresh({
    load() {
      loads += 1
      const item = deferred()
      pending.push(item)
      return item.promise
    },
    onValue(value) { values.push(value) }
  })

  const first = refresh.request()
  refresh.request()
  refresh.request()
  assert.equal(loads, 1)

  pending[0].resolve('first')
  await first
  await new Promise(function (resolve) { setImmediate(resolve) })
  assert.equal(loads, 2)

  pending[1].resolve('latest')
  await refresh.whenIdle()
  assert.deepEqual(values, ['first', 'latest'])
  assert.equal(loads, 2)
})

test('世界书库只按导入时间最新、最旧排序，旧排序方式回落为最新', async () => {
  const order = (await loadClient()).orderWorldBookCatalogItems
  const items = [
    { name: '白塔', path: 'worldbooks/b.json', importedAt: 30, updatedAt: 10 },
    { name: '阿芙拉', path: 'worldbooks/a.json', importedAt: 10, updatedAt: 40 },
    { name: '王都', path: 'worldbooks/c.json', importedAt: 20, updatedAt: 20 }
  ]

  assert.deepEqual(Array.from(order(items, 'newest'), function (item) { return item.name }), ['白塔', '王都', '阿芙拉'])
  assert.deepEqual(Array.from(order(items, 'oldest'), function (item) { return item.name }), ['阿芙拉', '王都', '白塔'])
  for (const retired of ['recent', 'az', 'za', 'imported', undefined]) {
    assert.deepEqual(Array.from(order(items, retired), function (item) { return item.name }), ['白塔', '王都', '阿芙拉'])
  }
  assert.deepEqual(items.map(function (item) { return item.name }), ['白塔', '阿芙拉', '王都'])
})

test('世界书库搜索按书名或所属人物卡忽略大小写匹配', async () => {
  const filter = (await loadClient()).filterWorldBookCatalogItems
  const items = [
    { name: 'Dragon Lore', path: 'a.json' },
    { name: '王都', cardPath: 'cards/x.png', cardName: '骑士团长' },
    { name: '白塔', path: 'b.json' }
  ]
  assert.deepEqual(Array.from(filter(items, 'dragon'), function (item) { return item.name }), ['Dragon Lore'])
  assert.deepEqual(Array.from(filter(items, ' 骑士 '), function (item) { return item.name }), ['王都'])
  assert.equal(filter(items, '').length, 3)
  assert.equal(filter(items, '不存在').length, 0)
})
