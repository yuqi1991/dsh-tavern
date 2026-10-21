import test from 'node:test'
import assert from 'node:assert/strict'
import { createForegroundWorldbook } from '../tavern-plugin/lib/domain/foreground-worldbook.js'
import { createWorldbookFilter } from '../tavern-plugin/lib/domain/worldbook-filter.js'
import { UpstreamTemplateRuntime } from './fixtures/upstream-template-runtime.mjs'

const runtime = await UpstreamTemplateRuntime.create()
const long = 'x'.repeat(4400)
const entries = ['漕帮', '剑宗', '药王谷', '铁骨', '商会', '皇女'].map((name, i) => ({ ref: 'e' + i, enabled: true, primaryKeys: [name], content: name + '设定' + long }))

function setup() {
  const worldBook = { view: { entries: structuredClone(entries) } }
  const screened = []
  const filterCandidates = createWorldbookFilter({ selection: () => ({}),
    beginTask: async () => ({ participantRequest: {}, bindSession() {}, participant: () => ({}), commit: async () => ({ status: 'committed' }), fail: async () => {} }),
    runAgent: async input => {
      const refs = JSON.parse(input.messages[0].content[0].text).candidates.map(item => item.ref)
      screened.push(refs)
      input.onToolCall({ name: 'worldbook_filter_submit', arguments: { selected: refs.slice(0, 1) } })
      return {}
    } })
  const project = createForegroundWorldbook({ bound: async () => worldBook, runtime: async () => runtime, globalVariables: async () => ({}), filterCandidates })
  const chat = { messages: [{ role: 'assistant', turn: 1, text: '漕帮 剑宗 药王谷 铁骨 商会 皇女' }] }
  async function turn(userText) {
    const result = await project({ chat, card: {}, userText })
    assert.equal(result.error, null)
    chat.worldBookReads = result.reads
    const next = chat.messages.at(-1).turn + 1
    chat.messages.push({ role: 'assistant', turn: next, text: chat.messages[0].text })
    return result
  }
  return { worldBook, screened, chat, turn }
}

test('模型排除的条目十轮内直接排除，不再询问模型；第十一轮重新判断', async () => {
  const h = setup()
  await h.turn('继续')
  assert.equal(h.screened.length, 1)
  assert.equal(h.screened[0].length, 6)
  for (let i = 0; i < 10; i++) await h.turn('继续')
  assert.equal(h.screened.length, 1, '其余五条在冷却中，候选不足以触发筛选')
  await h.turn('继续')
  assert.equal(h.screened.length, 2)
})

test('玩家本轮输入直接提到被排除条目时不受冷却限制；条目正文改变后冷却失效', async () => {
  const h = setup()
  await h.turn('继续')
  const named = await h.turn('我去找剑宗的人')
  assert.ok(named.refs.includes('e1'))
  assert.ok(!named.refs.includes('e2'))
  h.worldBook.view.entries[2].content = '药王谷新设定' + long
  const edited = await h.turn('继续')
  assert.ok(edited.refs.includes('e2'))
})
