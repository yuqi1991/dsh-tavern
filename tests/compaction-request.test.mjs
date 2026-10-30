import test from 'node:test'
import assert from 'node:assert/strict'
import { projectCompactionRequest, installCompactionRequestProjection } from '../tavern-plugin/lib/domain/compaction-request.js'

const empty = plugin => Object.freeze({ role: 'user', content: Object.freeze([]), source: Object.freeze({ kind: 'plugin', plugin }) })
const metadata = empty('dsh-tavern')

test('only removes Tavern metadata placeholders; preserves valid request prefix and envelope', () => {
  const story = Object.freeze({ role: 'user', content: [{ type: 'text', text: '故事' }], source: { kind: 'user' } })
  const image = Object.freeze({ role: 'user', content: [{ type: 'image', url: 'fixture' }] })
  const tool = Object.freeze({ role: 'assistant', content: [{ type: 'tool-call', id: 'call' }] })
  const unknown = empty('another-plugin')
  const instruction = Object.freeze({ role: 'user', content: [{ type: 'text', text: '摘要指令' }], source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } })
  const kept = [story, image, tool, unknown, instruction]
  const messages = Object.freeze([metadata, story, empty('dsh-tavern-failed-turn-cleanup'), image, tool, unknown, metadata, instruction])
  const request = Object.freeze({ purpose: 'compaction', sessionId: 's', system: '固定系统前缀', tools: Object.freeze([{ name: 'fixture' }]), provider: 'fixture', model: 'text', maxTokens: 1024, signal: new AbortController().signal, messages })
  const projected = projectCompactionRequest(request)
  assert.deepEqual(projected.messages, kept)
  projected.messages.forEach((message, i) => assert.equal(message, kept[i]))
  for (const key of Object.keys(request).filter(k => k !== 'messages')) assert.equal(projected[key], request[key])
  assert.equal(request.messages, messages)
  assert.equal(projectCompactionRequest(projected), projected, 'projection is idempotent')
})

test('ordinary requests and summaries without placeholders retain object identity', () => {
  for (const request of [undefined, {}, { messages: [metadata] }, { purpose: 'compaction', messages: [] }]) {
    assert.equal(projectCompactionRequest(request), request)
  }
})

test('middleware forwards only owned compaction requests and terminates redispatch', async () => {
  let handler, lookups = 0, forwarded = 0, fallback = 0
  const ctx = { on: (_event, callback) => { handler = callback }, llm: { stream: request => { forwarded++; return handler(request, next) } } }
  async function *next() { fallback++; yield 'result' }
  installCompactionRequestProjection(ctx, async id => { lookups++; return id === 'owned' })
  for (const request of [
    { purpose: 'compaction', sessionId: 'owned', messages: [metadata] },
    { purpose: 'compaction', sessionId: 'other', messages: [metadata] },
    { sessionId: 'owned', messages: [metadata] }
  ]) {
    const result = []
    for await (const chunk of handler(request, next)) result.push(chunk)
    assert.deepEqual(result, ['result'])
  }
  assert.equal(lookups, 2)
  assert.equal(forwarded, 1)
  assert.equal(fallback, 3)
})

test('a summary answered with a tool call or no text is retried once as plain text without tools', async () => {
  const { installCompactionRequestProjection } = await import('../tavern-plugin/lib/domain/compaction-request.js')
  for (const first of [[{ type: 'block-end', index: 0, block: { type: 'tool-call', name: 'submit', arguments: {} } }, { type: 'finish', reason: { kind: 'tool' } }],
    [{ type: 'finish', reason: { kind: 'stop' } }]]) {
    const hooks = [], sent = []
    const dispatch = (request, index = 0) => index < hooks.length
      ? hooks[index](request, () => dispatch(request, index + 1))
      : (async function * () { sent.push(request); if (sent.length === 1) { yield* first; return } yield { type: 'block-end', index: 0, block: { type: 'text', text: '后台摘要' } }; yield { type: 'finish', reason: { kind: 'stop' } } })()
    const ctx = { on: (_, hook) => hooks.push(hook), llm: { stream: request => dispatch(request), resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) } }
    installCompactionRequestProjection(ctx, async () => true)
    const say = (role, text) => ({ role, content: [{ type: 'text', text }], source: { kind: 'human' } })
    const request = { purpose: 'compaction', sessionId: 'background', provider: 'p', model: 'm', tools: [{ name: 'submit' }],
      messages: [say('system', '后台规则'), say('user', '任务'), say('assistant', '结果'), { ...say('user', '总结指令'), source: { kind: 'plugin', plugin: 'dsh-compaction-basic' } }] }
    const out = []
    for await (const chunk of ctx.llm.stream(request)) out.push(chunk)
    assert.equal(sent.length, 2)
    assert.equal(sent[1].tools, undefined)
    assert.match(sent[1].messages.at(-2).content[0].text, /任务/)
    assert.equal(sent[1].messages.at(-1).content[0].text, '总结指令')
    assert.deepEqual(out.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text), ['后台摘要'])
  }
})

test('story summaries: prompt then volume plan; carried volumes and the program header wrap a successful summary only', async () => {
  const { createStorySummaryPreparation, STORY_SUMMARY_NOTE } = await import('../tavern-plugin/lib/domain/story-compaction.js')
  const { frameSummary } = await import('../tavern-plugin/lib/domain/idle-compaction.js')
  const vol1 = '第 1 卷 · 第 2–9 轮\n剧情脉络\n- 结盟。'
  for (const [prompt, outcome] of [['默认剧情压缩提示词', 'stop'], ['用户自定义的压缩提示词', 'stop'], ['默认剧情压缩提示词', 'error']]) {
    const hooks = [], sent = []
    const dispatch = (request, index = 0) => index < hooks.length ? hooks[index](request, () => dispatch(request, index + 1)) : (async function * () {
      sent.push(request)
      if (outcome === 'error') { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }; return }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '第 9 卷 · 乱写\n剧情脉络\n- 会合。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
    const ctx = { on: (_, hook) => hooks.push(hook), llm: { stream: request => dispatch(request), resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }) } }
    const prepare = createStorySummaryPreparation({ isStory: async () => true, plan: () => ({ from: 10, through: 15, retainRounds: 0 }), retainRounds: async () => 10,
      prompt: () => prompt, contextWindow: async () => 100000, stream: request => ctx.llm.stream(request) })
    installCompactionRequestProjection(ctx, async () => true, prepare)
    const checkpoint = { role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'c' }, content: frameSummary([{ type: 'text', text: STORY_SUMMARY_NOTE }, { type: 'text', text: vol1 }]) }
    const request = { purpose: 'compaction', sessionId: 'story', provider: 'p', model: 'm',
      messages: [{ role: 'system', content: [{ type: 'text', text: '系统' }] }, checkpoint, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '新剧情' }] },
        { role: 'user', content: [{ type: 'text', text: 'DSH 指令' }] }] }
    const out = []
    for await (const chunk of ctx.llm.stream(request)) out.push(chunk)
    const instruction = sent[0].messages.at(-1).content[0].text
    assert.ok(instruction.startsWith(prompt + '\n\n【本次摘要的写法】'), 'the prompt in effect is kept and the plan follows it')
    assert.match(instruction, /第 2 卷 · 第 10–15 轮/); assert.match(instruction, /「当前情况」/)
    const texts = out.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block.text)
    if (outcome === 'error') { assert.deepEqual(texts, []); continue }
    assert.deepEqual(texts, [STORY_SUMMARY_NOTE, vol1, '第 2 卷 · 第 10–15 轮\n剧情脉络\n- 会合。'])
    assert.deepEqual(out.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.index), [0, 1, 2])
  }
})

test('story summaries: non-story sessions keep the request; a failed merge keeps every old volume', async () => {
  const { createStorySummaryPreparation, STORY_SUMMARY_NOTE } = await import('../tavern-plugin/lib/domain/story-compaction.js')
  const { frameSummary } = await import('../tavern-plugin/lib/domain/idle-compaction.js')
  const request = { purpose: 'compaction', sessionId: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }
  const plain = createStorySummaryPreparation({ isStory: async () => false, plan: () => null, retainRounds: async () => 10, prompt: () => 'p', contextWindow: async () => null, stream: () => { throw Error('no') } })
  assert.deepEqual(await plain(request), { request })
  const vols = [1, 2, 3].map(n => `第 ${n} 卷 · 第 ${n}–${n} 轮\n` + '事'.repeat(200))
  const warnings = []
  const merging = createStorySummaryPreparation({ isStory: async () => true, plan: () => null, retainRounds: async () => 10, prompt: () => 'p', contextWindow: async () => 1000,
    stream: async function * () { yield { type: 'finish', reason: { kind: 'error', failure: { message: '限流' } } } }, warn: message => warnings.push(message) })
  const big = { purpose: 'compaction', sessionId: 's', messages: [{ role: 'user', source: { kind: 'compact-checkpoint' }, content: frameSummary([STORY_SUMMARY_NOTE, ...vols].map(text => ({ type: 'text', text }))) },
    { role: 'user', content: [{ type: 'text', text: '指令' }] }] }
  const prepared = await merging(big)
  assert.deepEqual(prepared.prefix, [STORY_SUMMARY_NOTE, ...vols])
  assert.match(warnings[0], /限流/)
  const merged = createStorySummaryPreparation({ isStory: async () => true, plan: () => null, retainRounds: async () => 10, prompt: () => 'p', contextWindow: async () => 3000,
    stream: async function * (call) { assert.equal(call.sessionId, undefined); yield { type: 'block-end', index: 0, block: { type: 'text', text: '前情总览\n合并后' } }; yield { type: 'finish', reason: { kind: 'stop' } } } })
  const result = await merged(big)
  assert.deepEqual(result.prefix, [STORY_SUMMARY_NOTE, '前情总览 · 第 1–2 轮\n合并后', vols[2]])
  // No plan registered (a path without a retention entry): the header carries no range.
  assert.equal(result.header, '第 4 卷')
})
