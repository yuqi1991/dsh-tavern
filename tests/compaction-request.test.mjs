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
  const instruction = Object.freeze({ role: 'user', content: [{ type: 'text', text: '摘要指令' }], source: { plugin: 'dsh-compaction-basic' } })
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
