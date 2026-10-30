import assert from 'node:assert/strict'
import test from 'node:test'

import { createStoryCompactionRequest, usesStoryCompaction } from '../tavern-plugin/lib/domain/story-compaction.js'

function compactionRequest() {
  return Object.freeze({
    purpose: 'compaction',
    sessionId: 'session-1',
    messages: Object.freeze([
      Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: '旧对话' })]) }),
      Object.freeze({
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text: 'DSH 默认工程摘要指令' })]),
        source: Object.freeze({ kind: 'plugin', plugin: 'dsh-compaction-basic' })
      })
    ])
  })
}

test('只有剧情和剧本游玩会话使用剧情压缩', () => {
  assert.equal(usesStoryCompaction({ mode: 'story' }), true)
  assert.equal(usesStoryCompaction({ mode: 'script' }), true)
  assert.equal(usesStoryCompaction({ mode: 'card' }), false)
  assert.equal(usesStoryCompaction(undefined), false)
})

test('剧情压缩只替换 DSH 压缩请求最后一条指令且不修改原请求', () => {
  const original = compactionRequest()
  const request = createStoryCompactionRequest(original, '剧情专用摘要指令')

  assert.notEqual(request, original)
  assert.equal(original.messages[1].content[0].text, 'DSH 默认工程摘要指令')
  assert.equal(request.messages[0], original.messages[0])
  assert.equal(request.messages[1].content[0].text, '剧情专用摘要指令')
  assert.deepEqual(request.messages[1].source, original.messages[1].source)
  assert.equal(Object.isFrozen(request), true)
  assert.equal(Object.isFrozen(request.messages), true)
  assert.equal(Object.isFrozen(request.messages[1].content), true)
})

test('普通请求和来源不明的压缩请求保持原样', () => {
  const ordinary = Object.freeze({ purpose: undefined, messages: Object.freeze([]) })
  const unknown = Object.freeze({
    purpose: 'compaction',
    messages: Object.freeze([Object.freeze({ role: 'user', content: Object.freeze([]), source: Object.freeze({ plugin: 'other' }) })])
  })

  assert.equal(createStoryCompactionRequest(ordinary, '剧情摘要'), ordinary)
  assert.equal(createStoryCompactionRequest(unknown, '剧情摘要'), unknown)
})

import { STORY_SUMMARY_NOTE, storySummaryVolumes, storyVolumeMerge, storyVolumePlan, withVolumeHeader } from '../tavern-plugin/lib/domain/story-compaction.js'
import { frameSummary } from '../tavern-plugin/lib/domain/idle-compaction.js'

// The checkpoint the host writes from the summary blocks Tavern produced.
const checkpoint = blocks => ({ role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'c' }, content: frameSummary(blocks.map(text => ({ type: 'text', text }))) })
const summaryRequest = history => ({ purpose: 'compaction', messages: [{ role: 'system', content: [{ type: 'text', text: '系统' }] }, ...history,
  { role: 'user', content: [{ type: 'text', text: '指令' }] }] })
const story = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

test('第一卷：程序给出卷号与轮次范围，没有旧卷，只有摘要说明作前缀', () => {
  const plan = storyVolumePlan(summaryRequest([story('剧情')]), { from: 2, through: 9, retainRounds: 10 })
  assert.equal(plan.header, '第 1 卷 · 第 2–9 轮')
  assert.deepEqual(plan.prefix, [STORY_SUMMARY_NOTE])
  assert.match(plan.instruction, /第一行单独写「第 1 卷 · 第 2–9 轮」/)
  assert.doesNotMatch(plan.instruction, /当前情况/)
  assert.doesNotMatch(plan.instruction + STORY_SUMMARY_NOTE, /tavern_recall_history|回查|查询原文/)
  assert.equal(plan.merge, undefined)
})

test('多次压缩：旧卷逐字节原样保留，新卷只写旧卷之后，卷首行接着上一卷的范围', () => {
  const vol1 = '第 1 卷 · 第 2–9 轮\n剧情脉络\n- 甲与乙结盟，约定三日后在 \"北门\" 会合。'
  const second = storyVolumePlan(summaryRequest([checkpoint([STORY_SUMMARY_NOTE, vol1]), story('新剧情')]), { from: 10, through: 15, retainRounds: 10 })
  assert.equal(second.header, '第 2 卷 · 第 10–15 轮')
  assert.deepEqual(second.prefix, [STORY_SUMMARY_NOTE, vol1])
  assert.equal(second.prefix[1], vol1, 'byte for byte')
  assert.match(second.instruction, /已有 1 卷旧摘要（截至第 9 轮）/)
  assert.match(second.instruction, /更正：/)
  // The model wrote a wrong header: the program's replaces it.
  const vol2 = withVolumeHeader('第 7 卷 · 第 1–99 轮\n剧情脉络\n- 会合。', second.header)
  assert.equal(vol2, '第 2 卷 · 第 10–15 轮\n剧情脉络\n- 会合。')
  assert.equal(withVolumeHeader('剧情脉络\n- 会合。', second.header), '第 2 卷 · 第 10–15 轮\n剧情脉络\n- 会合。')
  const third = storyVolumePlan(summaryRequest([checkpoint([STORY_SUMMARY_NOTE, vol1, vol2]), story('更多')]), { from: 16, through: 20 })
  assert.equal(third.header, '第 3 卷 · 第 16–20 轮')
  assert.deepEqual(third.prefix, [STORY_SUMMARY_NOTE, vol1, vol2])
  assert.deepEqual(storySummaryVolumes([checkpoint([STORY_SUMMARY_NOTE, vol1, vol2])]).map(volume => [volume.number, volume.from, volume.through]), [[1, 2, 9], [2, 10, 15]])
})

test('分卷之前的整段摘要视为一卷前情总览', () => {
  const plan = storyVolumePlan(summaryRequest([checkpoint(['旧式整段摘要。']), story('新')]), { from: 30, through: 35 })
  assert.equal(plan.prefix[1], '前情总览（分卷之前的摘要）\n旧式整段摘要。')
  assert.equal(plan.header, '第 2 卷 · 第 30–35 轮')
})

test('只有设置为压缩后不保留原文（0 轮）时才追加「当前情况」', () => {
  assert.match(storyVolumePlan(summaryRequest([story('x')]), { retainRounds: 0 }).instruction, /「当前情况」：时间、地点、在场人物、正在进行的动作，最多三行/)
  assert.doesNotMatch(storyVolumePlan(summaryRequest([story('x')]), { retainRounds: 1 }).instruction, /当前情况/)
})

test('旧卷超预算时只合并最老的几卷，较新的卷原样保留', () => {
  const vols = [1, 2, 3, 4].map(n => `第 ${n} 卷 · 第 ${n * 10}–${n * 10 + 9} 轮\n` + '事'.repeat(100))
  const plan = storyVolumePlan(summaryRequest([checkpoint([STORY_SUMMARY_NOTE, ...vols]), story('新')]), { from: 50, through: 55, budget: 300 })
  // 4 × ~117 > 300; the newest volumes kept within half the budget (150): only volume 4.
  assert.deepEqual(plan.merge.volumes.map(volume => volume.number), [1, 2, 3])
  assert.deepEqual(plan.prefix, [STORY_SUMMARY_NOTE, vols[3]])
  assert.equal(plan.header, '第 5 卷 · 第 50–55 轮')
  const merge = storyVolumeMerge(plan.merge)
  assert.equal(merge.header, '前情总览 · 第 10–39 轮')
  assert.match(merge.prompt, /第一行单独写「前情总览 · 第 10–39 轮」/)
  assert.ok(merge.prompt.includes(vols[0]) && merge.prompt.includes(vols[2]) && !merge.prompt.includes(vols[3]))
  // Within budget nothing is merged.
  assert.equal(storyVolumePlan(summaryRequest([checkpoint([STORY_SUMMARY_NOTE, ...vols])]), { budget: 10000 }).merge, undefined)
  // After a merge the next volume number still follows the highest one.
  const after = storyVolumePlan(summaryRequest([checkpoint([STORY_SUMMARY_NOTE, merge.header + '\n总览', vols[3], '第 5 卷 · 第 50–55 轮\n新']), story('x')]), { from: 56, through: 60 })
  assert.equal(after.header, '第 6 卷 · 第 56–60 轮')
})
