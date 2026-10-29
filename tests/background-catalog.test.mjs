import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundCatalogBackfill } from '../tavern-plugin/lib/domain/background-catalog.js'

test('打开一局时把还没登记的后台 Agent 补进子智能体列表，只补一次，已登记和别局的不动', async () => {
  const events = [{ type: 'subagent/catalog', data: { childId: 'background-old' } }]
  const parent = { session: { events, append(type, data) { events.push({ type, data }) } } }
  let open = false
  const records = [
    { header: { id: 'background-old', parentSession: 'game', origin: 'subagent', createdAt: 1 } },
    { header: { id: 'background-new', parentSession: 'game', origin: 'subagent', createdAt: 2 } },
    { header: { id: 'background-other', parentSession: 'elsewhere', origin: 'subagent', createdAt: 3 } },
    { header: { id: 'game', origin: 'user', createdAt: 0 } }
  ]
  const descriptor = { type: 'subagent/descriptor', data: { mode: 'continuable', label: '酒馆后台 Agent' } }
  let lists = 0
  const listed = []
  const ensure = createBackgroundCatalogBackfill({
    agents: { get: id => open && id === 'game' ? parent : undefined },
    sessionQuery: { async listSessions() { lists++; return records }, async readSession() { return { events: [descriptor] } } },
    onListed: (id, count) => listed.push([id, count])
  })
  assert.equal(await ensure('game'), 0, '这局还没打开时不补，下次再试')
  open = true
  assert.equal(await ensure('game'), 1)
  assert.deepEqual(events.slice(1), [{ type: 'subagent/catalog', data: { version: 0, childId: 'background-new', childCreatedAt: 2, mode: 'continuable', label: '酒馆后台 Agent' } }])
  assert.deepEqual(listed, [['game', 1]])
  assert.equal(await ensure('game'), 0)
  assert.equal(lists, 1, '每局只扫一次')
})
