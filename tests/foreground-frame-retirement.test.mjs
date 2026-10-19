import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { retireForegroundWithAlgebra } from '../tavern-plugin/lib/domain/conversation-algebra-retirement.js'
import { randomUUID } from 'node:crypto'

import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
const helper = source.slice(source.indexOf('  async function retireOldForegroundFrames('), source.indexOf('  autoCompaction = createAutoCompaction('))
function frames() {
  const session = Session.create('frame-entry')
  for (const turn of [1, 2]) session.append('user/message', { id: 'f-' + turn, role: 'user', content: [{ type: 'text', text: 'frame-' + turn }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame', trace: { turn } } }, { surfaceOp: 'append' })
  return session
}

test('生产 pre-step 在自动压缩及生成之前清理旧指引，多步工具调用保留当前指引', async () => {
  const session = frames(), calls = []
  let hook
  const context = {
    checkedCompactionPressure: new WeakSet(), ctx: { on: (_name, fn) => { hook = fn } },
    retireForegroundWithAlgebra, randomUUID, algebraReadiness: { live: async () => {} }, assertAlgebraReady: () => {}, sessionStore: { flush: async () => calls.push('flush') },
    backgroundAgentRunner: { requestContext: () => null },
    sessionStateForSession: async () => ({ mode: 'story' }), pendingCompactionMessages: new WeakMap(),
    configureAgentCompaction: async () => ({ compactIfNeeded: async () => {
      const text = JSON.stringify(session.deriveMessages().map(message => message.content))
      assert.doesNotMatch(text, /frame-1/); assert.match(text, /frame-2/)
      calls.push('compact')
    } })
  }
  const start = source.indexOf("  ctx.on('agent/pre-step', async (payload, next) => {")
  vm.runInNewContext(helper + source.slice(start, source.indexOf("  ctx.on('agent/status'", start)), context)
  const agent = { session }
  for (const step of [1, 2]) await hook({ agent, turn: 2, step, messages: [] }, async () => calls.push('generate'))
  assert.deepEqual(calls.filter((call, index) => call !== 'flush' || calls[index - 1] !== 'flush'), ['flush', 'compact', 'generate', 'flush', 'compact', 'generate'])
})

test('旧存档无 trace 的指引可清理，其他插件内容不受影响', async () => {
  const session = Session.create('legacy-frames')
  for (const [id, plugin, form] of [['legacy', 'dsh-tavern', 'foreground-frame'], ['foreign', 'other', 'foreground-frame'], ['snapshot', 'dsh-tavern', 'snapshot']]) {
    session.append('user/message', { id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'plugin', plugin, form } }, { surfaceOp: 'append' })
  }
  assert.equal(await retireForegroundWithAlgebra(session, { keepTurn: 3, flush: async () => {}, operationId: 'legacy-retire' }), 1)
  const text = JSON.stringify(session.deriveMessages().map(message => message.content))
  assert.doesNotMatch(text, /legacy/)
  assert.match(text, /foreign/); assert.match(text, /snapshot/)
})
