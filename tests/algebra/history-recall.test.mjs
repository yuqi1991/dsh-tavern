// tavern_recall_history reads floors from the Session log through Floor Projection
// (projectFloorTexts): current variant bodies of the live surface, including floors folded into a
// compaction summary; rolled-back floors and unselected variants are absent. The driver is the real
// product harness (real Session, real rollback / regenerate / variant switch / compaction).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlayHarness, withHostPatch } from './locate-harness.mjs'
import { compactIdleRegion } from '../../lib/domain/idle-compaction.js'
import { planRetention, surfaceCutBalance } from '../../lib/domain/compaction-retention.js'
import { projectFloorTexts, storyFloorTurns, uncompactedSurface } from '../../lib/domain/floor-projection.js'
import { createHistoryRecall, renderHistoryRecall } from '../../lib/domain/history-recall.js'

const floorsOf = h => projectFloorTexts({ events: h.events, nodes: [...h.session.surface.nodes], floorTurns: storyFloorTurns(h.chat) })
const recall = (h, args) => createHistoryRecall().recall({ chat: h.chat, floors: floorsOf(h), ...args })
const turnsOf = result => result.rounds.map(round => round.turn)

async function playStory(h) {
  await h.play('我拿出银钥匙', '守门人收下银钥匙，承诺钟响三次后开北门。')
  await h.play('我问起河港', '河港的船夫说，月圆之夜才有渡船。')
  await h.play('我跟着船夫上船', '船在雾里行了一夜，船夫哼着旧歌。')
  await h.play('我拆开信', '信上只有一行字：灯塔下见。')
}

async function compact(h, rounds) {
  const nodes = [...h.session.surface.nodes]
  const plan = planRetention({ events: h.events, nodes, rounds, tokenOf: () => 50, balancedBefore: surfaceCutBalance(h.events, nodes).balancedBefore })
  assert.equal(plan.kind, 'range')
  const dependencies = { meter: { measure: session => ({ nodes: [...session.surface.nodes].map(seq => ({ seq, tokens: 50, heuristicTokens: 50 })) }), estimateMessage: () => 5 },
    summarize: async () => ({ summary: [{ type: 'text', text: '摘要：只记得有位船夫。' }], provider: 'fixture', model: 'fixture' }), recover: () => false }
  await compactIdleRegion({ dependencies, agent: h.agent, start: plan.start, end: plan.end })
  return plan
}

test('按楼层号读取：开场是第 1 轮，玩家输入与当前正文同层，邻层随 radius', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  const one = recall(h, { turn: 1, radius: 0 })
  assert.deepEqual(one.rounds, [{ turn: 1, messages: [{ role: 'assistant', text: '开场' }] }])
  const read = recall(h, { turn: 3, radius: 1 })
  assert.deepEqual(turnsOf(read), [2, 3, 4])
  assert.deepEqual(read.rounds[1].messages, [{ role: 'user', text: '我问起河港' }, { role: 'assistant', text: '河港的船夫说，月圆之夜才有渡船。' }])
  assert.equal(recall(h, { turn: 99 }).found, false)
}))

test('按关键词检索：命中带楼层号，输入与正文分别给片段，关键词分布列出所有楼层', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  const result = recall(h, { query: '船夫' })
  assert.equal(result.found, true)
  assert.deepEqual(result.matches.map(match => match.turn).sort(), [3, 4])
  assert.match(result.matches.find(match => match.turn === 4).excerpt, /\[玩家\] 我跟着船夫上船\n\[正文\] 船在雾里行了一夜，船夫哼着旧歌/)
  assert.deepEqual(result.terms, [{ term: '船夫', turns: [3, 4] }])
  assert.deepEqual(recall(h, { query: '灯塔' }).matches.map(match => match.turn), [5])
}))

test('压缩之后被折进摘要的楼层仍可按楼层号和关键词查回原文，最近保留的楼层也在', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  const before = floorsOf(h)
  const plan = await compact(h, 2)
  assert.equal(plan.kept, 2)
  assert.deepEqual(h.surfaceInputs(), ['我跟着船夫上船', '我拆开信'], '楼层 2、3 已折进摘要')
  assert.deepEqual(floorsOf(h), before, '压缩只改 surface，查到的原文与压缩前逐字相同')
  assert.deepEqual(recall(h, { turn: 2, radius: 0 }).rounds[0].messages.map(message => message.text), ['我拿出银钥匙', '守门人收下银钥匙，承诺钟响三次后开北门。'])
  assert.deepEqual(recall(h, { query: '银钥匙 北门' }).matches.map(match => match.turn), [2])
  assert.deepEqual(recall(h, { query: '灯塔' }).matches.map(match => match.turn), [5])
  assert.deepEqual(turnsOf(recall(h, { turn: 1, radius: 3 })), [1, 2, 3, 4])
  // A second compaction folds the first summary in turn; every word is still in the log.
  await h.play('我登上灯塔', '塔顶的灯早已熄灭。')
  await compact(h, 1)
  assert.deepEqual(floorsOf(h).map(floor => floor.turn), [1, 2, 3, 4, 5, 6])
  assert.equal(recall(h, { query: '银钥匙' }).found, true)
  assert.ok(uncompactedSurface(h.events, [...h.session.surface.nodes]).length > h.session.surface.nodes.length)
}))

test('回退掉的楼层不再返回，撤销回退后回来', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  await h.rollback()
  assert.equal(recall(h, { query: '灯塔' }).found, false)
  assert.deepEqual(turnsOf(recall(h, { turn: 5, radius: 1 })), [4])
  await h.undo()
  assert.deepEqual(recall(h, { query: '灯塔' }).matches.map(match => match.turn), [5])
}))

test('重新生成与切换变体：只返回当前变体，旧变体的原话查不到', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  h.bodyFor = turn => '新版本：信上画着一座钟楼。'
  await h.regenerate()
  assert.equal(recall(h, { query: '钟楼' }).found, true)
  assert.equal(recall(h, { query: '灯塔' }).found, false)
  assert.deepEqual(recall(h, { turn: 5, radius: 0 }).rounds[0].messages.map(message => message.text), ['我拆开信', '新版本：信上画着一座钟楼。'])
  await h.switchVariant(0)
  assert.equal(recall(h, { query: '灯塔' }).found, true)
  assert.equal(recall(h, { query: '钟楼' }).found, false)
  await h.switchVariant(1)
  assert.equal(recall(h, { query: '钟楼' }).found, true)
  assert.equal(recall(h, { query: '灯塔' }).found, false)
}))

test('压缩后的最近楼层重新生成并切换变体，查到的仍是当前变体', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  await compact(h, 2)
  h.bodyFor = () => '新版本：信纸是空白的。'
  await h.regenerate()
  assert.equal(recall(h, { query: '空白' }).found, true)
  assert.equal(recall(h, { query: '灯塔' }).found, false)
  assert.equal(recall(h, { query: '银钥匙' }).found, true, '已压缩楼层不受影响')
  await h.switchVariant(0)
  assert.equal(recall(h, { query: '灯塔' }).found, true)
  assert.equal(recall(h, { query: '空白' }).found, false)
}))

test('编辑过的正文返回编辑后的版本', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  await h.editBody('信上其实什么也没写。')
  assert.equal(recall(h, { query: '什么也没写' }).found, true)
  assert.equal(recall(h, { query: '灯塔' }).found, false)
}))

test('只有日志里有、Chat 没有提交的楼层（生成中或崩溃残留）不返回', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  await h.playLogOnly('孤儿输入', '孤儿正文：潜伏者的名字')
  assert.equal(recall(h, { query: '潜伏者' }).found, false)
  assert.deepEqual(floorsOf(h).map(floor => floor.turn), [1, 2, 3, 4, 5])
}))

test('检索是只读的：不追加日志事件，不改 surface，不改 Chat（搜索不写冷却）', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  await compact(h, 2)
  const events = JSON.stringify(h.events), nodes = JSON.stringify([...h.session.surface.nodes]), chat = JSON.stringify(h.chat)
  recall(h, { query: '船夫' }); recall(h, { turn: 2, radius: 3 }); recall(h, { query: '银钥匙', trackCooldown: true })
  assert.equal(JSON.stringify(h.events), events)
  assert.equal(JSON.stringify([...h.session.surface.nodes]), nodes)
  assert.equal(JSON.stringify(h.chat), chat)
}))

test('渲染给模型的文本带楼层号和禁止重复演绎的提醒', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await playStory(h)
  const text = renderHistoryRecall(recall(h, { turn: 3, radius: 0 }))
  assert.match(text, /^【历史回忆资料】/)
  assert.match(text, /【第 3 轮】\n\[玩家\]\n我问起河港\n\n\[正文\]\n河港的船夫说/)
}))
