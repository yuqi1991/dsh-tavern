import { projectCardSummary } from '../tavern-plugin/lib/domain/card-preparation.js'
import { createCardSummaryCache } from '../tavern-plugin/lib/domain/card-summary-cache.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileResourceStore } from '../tavern-plugin/lib/domain/file-resources.js'

const server = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const listing = server.slice(server.indexOf('  const cardSummaries ='), server.indexOf('  async function resourceBindingProjection()'))

test('one non-JSON card remains visible without hiding healthy cards or modifying either file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-bad-card-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileResourceStore({ dataRoot: root })
  await store.ensure()
  const bad = '<开局>\n必看\n私人正文'
  await writeFile(store.absolute('cards/损坏.json'), bad)
  await writeFile(store.absolute('cards/正常.json'), JSON.stringify({ name: '正常人物卡' }))
  const list = new Function('fileResources', 'readCardWorkspace', 'cardPreparation', 'orderCardsByNewestImport', 'cardOrganization', 'createCardSummaryCache', 'projectCardSummary', listing + '; return listCards')(
    store, path => store.readCard(path), { project: value => value }, cards => cards, { project: async cards => cards }, createCardSummaryCache, projectCardSummary)
  const cards = await list()
  assert.equal(cards.length, 2)
  assert.equal(cards.find(c => c.path === 'cards/正常.json').name, '正常人物卡')
  const broken = cards.find(c => c.path === 'cards/损坏.json')
  assert.match(broken.readError, /cards\/损坏.json/)
  assert.doesNotMatch(broken.readError, /私人正文|<开局>/)
  assert.equal(await store.readText(broken.path), bad)
  await writeFile(store.absolute(broken.path), JSON.stringify({ name: '修复后' }))
  const recovered = (await list()).find(c => c.path === broken.path)
  assert.equal(recovered.name, '修复后')
  assert.equal(recovered.readError, undefined)
})

const client = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const sidebar = client.slice(client.indexOf('function TavernSidebar'))
const refreshSource = sidebar.slice(sidebar.indexOf('function refresh(kinds)'), sidebar.indexOf('\t\t\tReact.useEffect', sidebar.indexOf('function refresh(kinds)')))
for (const failed of ['listCards', 'listSessions']) {
  test('sidebar independently refreshes surviving data when ' + failed + ' fails', async () => {
    const state = { cards: ['previous-card'], history: ['previous-session'], errors: [] }
    const refresh = new Function('call', 'setCards', 'setHistory', 'setTrustedCardMode', 'publishSessionModes', 'current', 'isPlayMode', 'setRequestMode', 'window', 'tavernErrorHub', 'return (' + refreshSource + ')')(
      async method => {
        if (method === failed) throw new Error('unreadable file')
        return { cards: ['healthy-card'], sessions: [{ sessionId: 'current', mode: 'story' }] }
      }, value => { state.cards = value }, value => { state.history = value }, () => {}, () => {}, 'current', () => true, () => {}, {},
      { resolve() {}, report(source) { state.errors.push(source) } })
    await refresh()
    assert.deepEqual(state.cards, failed === 'listCards' ? ['previous-card'] : ['healthy-card'])
    assert.deepEqual(state.history, failed === 'listSessions' ? ['previous-session'] : [{ sessionId: 'current', mode: 'story' }])
    assert.equal(state.errors.length, 1)
  })
}

test('opening a session skips the unrelated card catalog but updates session history', async () => {
  const methods = []
  const refresh = new Function('call', 'setCards', 'setHistory', 'setTrustedCardMode', 'publishSessionModes', 'current', 'isPlayMode', 'setRequestMode', 'window', 'tavernErrorHub', 'return (' + refreshSource + ')')(
    async method => { methods.push(method); return { sessions: [{ sessionId: 'current' }] } },
    () => assert.fail('must not replace cards'), () => {}, () => {}, () => {}, 'current', () => true, () => {}, {}, { resolve() {}, report() {} })
  const openingSource = sidebar.slice(sidebar.indexOf('async function openSessionWhenReady('), sidebar.indexOf('async function finishPendingOpen('))
  const open = new Function('sessionListRecoveryRef', 'call', 'refresh', 'setError', 'return (' + openingSource + ')')(
    { current: { open: async () => {} } }, async method => { methods.push(method) }, refresh, () => {})
  await open('current')
  assert.deepEqual(methods, ['markConversationOpened', 'listSessions'])
})

test('production catalog reuses summaries and still discovers newly imported cards', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-catalog-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileResourceStore({ dataRoot: root })
  await store.ensure()
  await writeFile(store.absolute('cards/one.json'), JSON.stringify({ name: 'One' }))
  let reads = 0
  const list = new Function('fileResources', 'readCardWorkspace', 'orderCardsByNewestImport', 'cardOrganization', 'createCardSummaryCache', 'projectCardSummary', listing + '; return listCards')(
    store, path => { reads++; return store.readCard(path) }, cards => cards, { project: async cards => cards }, createCardSummaryCache, projectCardSummary)
  assert.equal((await list()).length, 1)
  assert.equal((await list()).length, 1)
  assert.equal(reads, 1)
  await writeFile(store.absolute('cards/two.json'), JSON.stringify({ name: 'Two' }))
  assert.equal((await list()).length, 2)
  assert.equal(reads, 2)
})
