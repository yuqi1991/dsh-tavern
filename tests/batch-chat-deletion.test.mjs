import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const section = source.slice(source.indexOf('  async function stopChatForDeletion'), source.indexOf('  async function exportConversation'))
function setup({ liveSessions = [] } = {}) {
  const events = []
  const deletedChatIds = new Set()
  const workers = new Map(['a', 'background'].map(id => [id, { cancel: () => events.push('cancel:' + id), whenIdle: async () => events.push('idle:' + id) }]))
  const footprint = { foregroundSessionId: '', items: [] }
  const gameFootprint = {
    describe: async chat => { footprint.foregroundSessionId = chat.sessionId; footprint.items = [{ category: 'subsession', sessionId: 'sub-' + chat.id }, { category: 'subsession', sessionId: 'live-' + chat.id }]; return footprint },
    deferSessionDeletion: async items => { events.push('defer:' + items.map(item => item.sessionId).join(',')) },
    removeLeftovers: async value => { events.push('leftovers:' + value.items.map(item => item.sessionId).join(',')); return { failures: [] } }
  }
  const apiDiagnostics = { forget: async id => { events.push('forget:' + id) } }
  const backgroundAgentRunner = { releaseFor: async id => { events.push('release:' + id) } }
  for (const id of liveSessions) workers.set(id, { cancel() {}, whenIdle: async () => {} })
  const api = new Function('readChat', 'str', 'storyTimeline', 'agentRegistry', 'cancelSettlement', 'conversationRegistry', 'deletedChatIds', 'sceneWorldbooks', 'gameFootprint', 'apiDiagnostics', 'backgroundAgentRunner', 'readIndex', 'ctx', section + '; return { deleteChats };')(
    async id => ({ id, sessionId: id }), String,
    { inspect: () => ({ participants: { worker: { sessionId: 'background' } } }) }, workers,
    async id => { events.push('settlement:' + id) },
    { remove: async id => { events.push('remove:' + id); if (id === 'bad') throw new Error('disk error') } }, deletedChatIds, null,
    gameFootprint, apiDiagnostics, backgroundAgentRunner, async () => ({ chats: [] }), { get: () => ({ open: async () => ({ header: { parentSession: 'x' }, close: async () => {} }) }) })
  return { ...api, events, deletedChatIds }
}
test('batch deletion stops foreground and background before removing, deduplicates, and continues after a failure', async () => {
  const api = setup()
  const result = await api.deleteChats(['a', 'bad', 'a', 'c'])
  assert.deepEqual(result.results, [{ chatId: 'a', ok: true }, { chatId: 'bad', ok: false, error: 'disk error' }, { chatId: 'c', ok: true }])
  assert.ok(api.events.indexOf('idle:a') < api.events.indexOf('remove:a'))
  assert.ok(api.events.indexOf('idle:background') < api.events.indexOf('remove:a'))
  assert.deepEqual([...api.deletedChatIds], ['a', 'c'])
})
test('preparation only stops work without deleting, invalid selection cannot delete anything', async () => {
  const api = setup()
  await api.deleteChats(['a'], true)
  assert.ok(!api.events.some(event => event.startsWith('remove:')))
  await assert.rejects(api.deleteChats(['a', '']), /有效/)
  assert.deepEqual(await api.deleteChats([]), { results: [] })
})
test('deleting a game releases its background runners and removes the leftovers, deferring sessions DSH still holds', async () => {
  const api = setup({ liveSessions: ['live-a'] })
  await api.deleteChats(['a'])
  assert.ok(api.events.includes('forget:a'))
  assert.ok(api.events.includes('release:a'))
  assert.ok(api.events.includes('defer:live-a'))
  assert.ok(api.events.includes('leftovers:sub-a'))
  assert.ok(api.events.indexOf('remove:a') < api.events.indexOf('leftovers:sub-a'))
})
