import assert from 'node:assert/strict'
import test from 'node:test'

import { parameterSchemaSpecToJsonSchema } from '../tavern-plugin/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { dshParameterFields } from '../tavern-plugin/lib/domain/dsh-tool-schema.js'
import { HISTORY_RECALL_HIT_CHARS, HISTORY_RECALL_READ_CHARS, createHistoryRecall, historyRecallAvailable, renderHistoryRecall } from '../tavern-plugin/lib/domain/history-recall.js'
import { HISTORY_RECALL_TOOL } from '../tavern-plugin/lib/domain/history-recall.js'

// The Chat only identifies the conversation and keeps the cooldown record; the floors are what
// Floor Projection reads from the Session log (tests/algebra/history-recall.test.mjs drives the log).
function chat() {
  return { id: 'chat-memory', _storageRevision: 7 }
}
function floors() {
  return [
    { turn: 1, input: null, body: '雨夜里，林遥第一次抵达白塔。' },
    { turn: 2, input: '我把银钥匙交给守门人。', body: '守门人收下银钥匙，承诺在钟响三次后打开北门。' },
    { turn: 3, input: '', body: '林遥和玩家离开白塔，前往河港。' }
  ]
}

test('历史检索的标准 JSON Schema 可适配为 DSH 工具参数字段', () => {
  const fields = dshParameterFields(HISTORY_RECALL_TOOL.parameters)
  const schema = parameterSchemaSpecToJsonSchema(fields)

  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.properties), ['query', 'turn', 'radius', 'limit'])
  assert.equal('minLength' in schema.properties.query, false)
  assert.equal('minimum' in schema.properties.turn, false)
})

test('按关键词检索楼层原文，命中带楼层号并区分玩家输入与正文', () => {
  const recall = createHistoryRecall()
  const result = recall.recall({ chat: chat(), floors: floors(), query: '银钥匙 北门' })

  assert.equal(result.found, true)
  assert.equal(result.revision, 7)
  assert.deepEqual(result.matches.map(item => item.turn), [2])
  assert.match(result.matches[0].excerpt, /\[玩家\][^\n]*银钥匙/)
  assert.match(result.matches[0].excerpt, /\[正文\][^\n]*北门/)
  assert.deepEqual(result.terms.map(item => [item.term, item.turns]), [['银钥匙', [2]], ['北门', [2]]])
  assert.doesNotMatch(JSON.stringify(result), /河港/)
})

test('按轮次读取相邻完整楼层，包含开场白（无玩家输入）', () => {
  const result = createHistoryRecall().recall({ chat: chat(), floors: floors(), turn: 2, radius: 1 })

  assert.equal(result.found, true)
  assert.deepEqual(result.rounds.map(round => round.turn), [1, 2, 3])
  assert.deepEqual(result.rounds[0].messages.map(message => message.role), ['assistant'])
  assert.deepEqual(result.rounds[1].messages.map(message => message.role), ['user', 'assistant'])
  assert.match(result.rounds[1].messages[0].text, /银钥匙/)
})

test('空结果：关键词无命中、楼层号超出范围、没有任何楼层', () => {
  const recall = createHistoryRecall()
  const miss = recall.recall({ chat: chat(), floors: floors(), query: '不存在的词' })
  assert.equal(miss.found, false)
  assert.match(renderHistoryRecall(miss), /没有找到相关历史正文/)

  const beyond = recall.recall({ chat: chat(), floors: floors(), turn: 40 })
  assert.equal(beyond.found, false)
  assert.deepEqual(beyond.rounds, [])
  assert.match(renderHistoryRecall(beyond), /没有第 40 轮附近的正文（现有第 1–3 轮）/)

  const none = recall.recall({ chat: chat(), floors: [], turn: 1 })
  assert.match(renderHistoryRecall(none), /还没有可检索的正文/)
  assert.equal(recall.recall({ chat: chat(), floors: [], query: '白塔' }).found, false)
})

test('参数非法：query 与 turn 必须且只能一个，类型、长度、轮次与楼层投影缺失', () => {
  const recall = createHistoryRecall()
  const base = { chat: chat(), floors: floors() }
  assert.throws(() => recall.recall(base), /必须且只能提供/)
  assert.throws(() => recall.recall({ ...base, query: '白塔', turn: 2 }), /必须且只能提供/)
  assert.throws(() => recall.recall({ ...base, query: 42 }), /必须是文字/)
  assert.throws(() => recall.recall({ ...base, query: '字'.repeat(201) }), /最多 200/)
  assert.throws(() => recall.recall({ ...base, query: '！！！' }), /不能为空/)
  assert.throws(() => recall.recall({ ...base, turn: 0 }), /大于 0/)
  assert.throws(() => recall.recall({ ...base, turn: 1.5 }), /大于 0/)
  assert.throws(() => recall.recall({ ...base, turn: 'x' }), /大于 0/)
  assert.throws(() => recall.recall({ chat: chat(), turn: 1 }), /缺少楼层投影/)
  assert.throws(() => recall.recall({ floors: floors(), turn: 1 }), /缺少 Tavern Chat/)
  // radius and limit are clamped, not refused.
  assert.deepEqual(recall.recall({ ...base, turn: 2, radius: 99 }).rounds.map(round => round.turn), [1, 2, 3])
  assert.equal(recall.recall({ ...base, query: '白塔', limit: 0 }).matches.length, 1)
})

test('工具结果把禁止重复演绎的提醒放在召回正文之前', () => {
  const result = createHistoryRecall().recall({ chat: chat(), floors: floors(), turn: 2, radius: 0 })
  const rendered = renderHistoryRecall(result)

  assert.ok(rendered.startsWith('【历史回忆资料】'))
  assert.match(rendered, /不得当作当前场景继续输出，不得重复演绎/)
  assert.match(rendered, /【第 2 轮】/)
})

test('检索结果直接服从传入的楼层：改写后的正文与回退掉的楼层立即生效', () => {
  const recall = createHistoryRecall()
  const regenerated = floors()
  regenerated[1].body = '守门人退还银钥匙，北门仍然关闭。'

  assert.equal(recall.recall({ chat: chat(), floors: floors(), query: '承诺' }).found, true)
  assert.equal(recall.recall({ chat: chat(), floors: regenerated, query: '承诺' }).found, false)
  assert.equal(recall.recall({ chat: chat(), floors: regenerated, query: '退还' }).found, true)
  assert.equal(recall.recall({ chat: chat(), floors: regenerated.slice(0, 1), query: '退还' }).found, false)
})

test('读取超过总字数上限时，请求的楼层优先，放不下的邻居注明未返回并保持可读', () => {
  const recall = createHistoryRecall()
  const long = n => ({ turn: n, input: '输入' + n, body: ('第' + n + '轮的正文。').repeat(500) })
  const many = [long(1), long(2), long(3), long(4), long(5)]
  const scope = {}
  const result = recall.recall({ chat: chat(), floors: many, turn: 3, radius: 2, scope })
  const returned = result.rounds.map(round => round.turn)
  assert.ok(returned.includes(3), '请求的楼层一定返回')
  assert.ok(returned.length < 5)
  const chars = result.rounds.reduce((total, round) => total + round.messages.reduce((sum, message) => sum + message.text.length, 0), 0)
  assert.ok(chars <= HISTORY_RECALL_READ_CHARS, '总字数 ' + chars)
  assert.match(result.notice, /受总字数上限限制，第 [\d、]+ 轮没有返回/)
  // The left-out floors were not marked read: a narrower call still gets them.
  const left = [1, 2, 3, 4, 5].filter(turn => !returned.includes(turn))
  assert.deepEqual(recall.recall({ chat: chat(), floors: many, turn: left[0], radius: 0, scope }).rounds.map(round => round.turn), [left[0]])
})

test('单个楼层本身超过总字数上限时截断并注明，且不抛错', () => {
  const huge = [{ turn: 1, input: null, body: '很长。'.repeat(8000) }]
  const result = createHistoryRecall().recall({ chat: chat(), floors: huge, turn: 1, radius: 0 })
  assert.equal(result.rounds.length, 1)
  assert.ok(result.rounds[0].messages[0].text.length <= HISTORY_RECALL_READ_CHARS + 10)
  assert.match(result.rounds[0].messages[0].text, /已截断/)
  assert.match(result.notice, /第 1 轮正文过长/)
})

test('关键词检索的返回量有上限：条数、每条片段长度、关键词分布', () => {
  const recall = createHistoryRecall()
  const dense = Array.from({ length: 30 }, (_, index) => ({ turn: index + 1, input: '银钥匙', body: ('银钥匙出现在这里，' + '填充'.repeat(60)).repeat(20) }))
  const result = recall.recall({ chat: chat(), floors: dense, query: '银钥匙' })
  assert.equal(result.matches.length, 5)
  assert.equal(recall.recall({ chat: chat(), floors: dense, query: '钥匙', limit: 99 }).matches.length, 8)
  for (const match of result.matches) for (const part of match.excerpt.split('\n')) assert.ok(part.length <= HISTORY_RECALL_HIT_CHARS + 60, part.length + '')
  const words = recall.recall({ chat: chat(), floors: dense, query: Array.from({ length: 20 }, (_, i) => '词' + i).join(' ') + ' 银钥匙' })
  assert.ok(words.terms.length <= 8)
  assert.ok(JSON.stringify(result).length < 6000, JSON.stringify(result).length + '')
})

test('一次生成去重重叠正文，搜索后仍能读全文，新生成重新开放', () => {
  const recall = createHistoryRecall()
  const scope = {}
  assert.equal(recall.recall({ chat: chat(), floors: floors(), query: '北门', scope }).matches.length, 1)
  assert.deepEqual(recall.recall({ chat: chat(), floors: floors(), turn: 2, radius: 0, scope }).rounds.map(r => r.turn), [2])
  const overlap = recall.recall({ chat: chat(), floors: floors(), turn: 2, radius: 1, scope })
  assert.deepEqual(overlap.rounds.map(r => r.turn), [1, 3])
  const duplicate = recall.recall({ chat: chat(), floors: floors(), turn: 2, scope })
  assert.equal(duplicate.rounds.length, 0)
  assert.match(renderHistoryRecall(duplicate), /已读取/)
  assert.equal(recall.recall({ chat: chat(), floors: floors(), turn: 2, scope: {} }).rounds.length, 3)
})

test('重复调用计入预算且耗尽后不再返回正文或搜索结果', () => {
  const recall = createHistoryRecall()
  const scope = {}
  for (let i = 0; i < 6; i++) recall.recall({ chat: chat(), floors: floors(), turn: 2, scope })
  const result = recall.recall({ chat: chat(), floors: floors(), query: '北门', scope })
  assert.equal(result.matches.length, 0)
  assert.match(renderHistoryRecall(result), /预算已用尽/)
})

test('完整正文冷却持续十轮并可从存档恢复，摘要不触发冷却', () => {
  const source = chat()
  const all = floors()
  const read = (current, args) => createHistoryRecall().recall({ chat: current, floors: all, trackCooldown: true, ...args })
  read(source, { query: '北门' })
  assert.equal(source.historyRecallCooldowns, undefined)
  assert.equal(read(source, { turn: 2, radius: 0 }).rounds.length, 1)
  const restored = JSON.parse(JSON.stringify(source))
  assert.equal(read(restored, { turn: 2, radius: 0 }).rounds.length, 0)
  assert.equal(read(restored, { query: '北门' }).matches.length, 0)
  all.push({ turn: 13, input: null, body: '十轮后' })
  assert.equal(read(restored, { turn: 2, radius: 0 }).rounds.length, 0)
  all.push({ turn: 14, input: null, body: '冷却结束' })
  assert.equal(read(restored, { turn: 2, radius: 0 }).rounds.length, 1)
})

test('历史正文修改或剧情分支回退后允许重新召回', () => {
  const source = chat()
  const all = floors()
  const read = () => createHistoryRecall().recall({ chat: source, floors: all, trackCooldown: true, turn: 2, radius: 0 })
  read()
  all[1].body = '修改后的正文'
  assert.equal(read().rounds.length, 1)
  source.timeline = { branchId: 'rollback-branch' }
  assert.equal(read().rounds.length, 1)
})

test('前后台独立冷却，后台不同任务共享冷却，存档恢复保留双方记录', () => {
  let source = chat()
  const read = (audience, args = {}) => createHistoryRecall().recall({
    chat: source, floors: floors(), trackCooldown: true, audience, turn: 2, radius: 0, ...args
  })
  assert.equal(read('foreground').rounds.length, 1)
  assert.equal(read('background', { turn: undefined, query: '北门' }).matches.length, 1)
  assert.equal(read('background').rounds.length, 1)
  source = JSON.parse(JSON.stringify(source))
  assert.equal(read('foreground').rounds.length, 0)
  assert.equal(read('background').rounds.length, 0)
  assert.equal(source.historyRecallCooldowns.length, 2)
  assert.equal(read('background', { turn: 3 }).rounds.length, 1)
  assert.equal(read('foreground', { turn: 3 }).rounds.length, 1)
})

test('旧共享冷却不推断归属，不阻止任一上下文首次读取', () => {
  const source = chat()
  const recall = createHistoryRecall()
  recall.recall({ chat: source, floors: floors(), turn: 2, radius: 0, trackCooldown: true })
  for (const entry of source.historyRecallCooldowns) delete entry.audience
  for (const audience of ['background', 'foreground']) {
    assert.equal(recall.recall({ chat: source, floors: floors(), turn: 2, radius: 0, trackCooldown: true, audience }).rounds.length, 1)
  }
})

test('工具只在前台故事会话的可见工具里可用：剧本/故事有，卡片、兼容模式、无工具名无', () => {
  const visible = ['tavern_read_variables', 'tavern_recall_history']
  assert.equal(historyRecallAvailable({ mode: 'story' }, visible), true)
  assert.equal(historyRecallAvailable({ mode: 'script' }, visible), true)
  assert.equal(historyRecallAvailable({ mode: 'card' }, visible), false)
  assert.equal(historyRecallAvailable({ mode: 'story', requestMode: 'sillytavern' }, visible), false)
  assert.equal(historyRecallAvailable({ mode: 'story' }, ['tavern_read_variables']), false)
  assert.equal(historyRecallAvailable(undefined, visible), false)
})
