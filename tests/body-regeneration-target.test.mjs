import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from './fixtures/dsh-session-host.mjs'
import * as surface from '../tavern-plugin/lib/domain/rollback-surface.js'

import { selectRegenerationTarget } from '../tavern-plugin/lib/domain/round-history.js'
const model = { kind: 'model', provider: 'test', model: 'test-model' }
const assistant = (seq, turn, source = model, content = [{ type: 'text', text: '正文' }]) => ({ seq, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', source, content } } })
const cleanup = (seq, turn) => assistant(seq, turn, { kind: 'plugin', plugin: 'dsh-tavern-failed-turn-cleanup' }, [])
const chat = { messages: [{ role: 'assistant', greeting: true, turn: 1 }, { role: 'user', text: '继续' }, { role: 'assistant', turn: 6, text: '已保存正文' }] }
test('同一句配对错误记录不同结构原因，不修改消息或暴露文本', () => {
  const cases = [
    [[{ role: 'assistant', greeting: true }], 'no-non-greeting-assistant'],
    [[{ role: 'assistant', turn: 2 }], 'assistant-at-start'],
    [[null, { role: 'assistant', turn: 2 }], 'previous-message-invalid'],
    [[{ role: 'user' }, { role: 'system' }, { role: 'assistant', turn: 2 }], 'previous-message-not-user']
  ]
  for (const [messages, reason] of cases) {
    for (const msg of messages) if (msg) msg.text = 'private-user-story-and-key'
    const before = structuredClone(messages)
    let evidence
    assert.throws(() => selectRegenerationTarget({messages}, {events:[],surface:{nodes:[]}}, value => { evidence = value }), /没有可重新生成/)
    assert.equal(evidence.reason, reason)
    assert.equal(evidence.chat.messageCount, messages.length)
    assert.doesNotMatch(JSON.stringify(evidence), /private-user-story-and-key/)
    assert.deepEqual(messages, before)
  }
})

test('原生轮次匹配失败和成功有独立记录，诊断观察者异常不改变结果', () => {
  let evidence
  assert.throws(() => selectRegenerationTarget(chat, {events: [assistant(0, 5)], surface:{nodes:[0]}}, value => {evidence=value}), /找不到/)
  assert.equal(evidence.reason, 'native-target-missing')
  assert.equal(evidence.selection.requestedTurn, 6)
  const session = {events:[assistant(0,6)], surface:{nodes:[0]}}
  selectRegenerationTarget(chat, session, value => {evidence=value})
  assert.equal(evidence.reason, 'selected')
  assert.equal(evidence.native.matchingSurfaceCount, 1)
  assert.equal(evidence.selection.nativeSeq, 0)
  assert.equal(selectRegenerationTarget(chat, session, () => {throw new Error('diagnostic failure')}).oldSeq, 0)
})

test('大量历史仅记录有限结构尾部，不收集内容或任意属性', () => {
  const messages = Array.from({length: 10000}, () => ({ role: 'assistant', greeting: true, text: 'secret', privateField: 'private' }))
  const session = {events: Array.from({length:1000}, (_, seq) => assistant(seq, 6)), surface:{nodes:Array.from({length:1000}, (_, i) => i)}}
  let evidence
  assert.throws(() => selectRegenerationTarget({messages}, session, value => {evidence=value}))
  assert.ok(evidence.chat.messages.length <= 17)
  assert.ok(evidence.native.surfaceTail.length <= 12)
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 16000)
  assert.doesNotMatch(JSON.stringify(evidence), /secret|privateField/)
})
function select(events, nodes) {
  const { oldSeq, oldTurn, oldSource, oldAssistantIndex } = selectRegenerationTarget(chat, { events, surface: { nodes } })
  return { oldSeq, oldTurn, oldSource, oldAssistantIndex }
}

test('失败清理后再次失败，重新生成目标仍是同一剧情轮次的已保存正文', async () => {
  const session = Session.create('failed-turn-target')
  const reply = (turn, id) => ({ turn, step: 1, stream: [], message: { id, role: 'assistant', source: model, content: [{ type: 'text', text: '正文' }] } })
  const body = session.append('assistant/message', reply(6, 'saved'), { surfaceOp: 'append' })
  const target = () => select(session.snapshotEvents(), [...session.surface.nodes])
  for (const failedTurn of [7, 9]) {
    session.append('turn/start', { turn: failedTurn })
    session.append('assistant/message', reply(failedTurn, 'failed-' + failedTurn), { surfaceOp: 'append' })
    session.append('turn/end', { turn: failedTurn })
    assert.equal(await surface.clearFailedTurnSurface({ session, turn: failedTurn, flush: async () => {} }), 1)
    assert.equal(target().oldSeq, body.seq)
    assert.equal(target().oldTurn, 6)
  }
})

test('不完整的轮次不能退回到任意旧正文，事件序号可以不连续', () => {
  for (const turn of [undefined, null, 0, -1, 1.5, 'bad']) {
    assert.equal(surface.locateRegenerationSurface({ events: [assistant(0, 6)], nodes: [0], turn }), null)
  }
  assert.equal(select([assistant(42, 6), cleanup(50, 7)], [42, 50]).oldSeq, 42)
})
