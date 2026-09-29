import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { prepareTemplateHistory, synchronizeTemplateHistory } from '../../tavern-plugin/lib/domain/template-history.js'
import { appendSessionEvent, sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'

const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
test.after(() => patch.dispose())

function fixture() {
  const session = Session.create('template-history-test')
  appendSessionEvent(session, 'user/message', {
    id: 'input', role: 'user', content: [{ type: 'text', text: '原输入' }], source: { kind: 'user' }
  }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', {
    turn: 1, step: 1, stream: [], message: {
      id: 'reply', role: 'assistant', content: [{ type: 'text', text: '原回复' }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' }
    }
  }, { surfaceOp: 'append' })
  const chat = { messages: [{ role: 'user', text: '原输入' }, { role: 'assistant', text: '原回复', turn: 1 }] }
  return { session, chat }
}

test('enabled template edit keeps message identity and replays once after restart with the switch off', async () => {
  const { session, chat } = fixture()
  const original = structuredClone(sessionEvents(session))
  const next = structuredClone(chat)
  next.messages[0].text = '新输入'
  next.messages[1].text = '新回复'
  await prepareTemplateHistory(session, chat, next, true)
  assert.equal(next.messages[0].templateHistoryEdit.algebra, 1)
  assert.equal(next.messages[1].templateHistoryEdit.algebra, 1)
  assert.deepEqual(sessionEvents(session), original)
  await synchronizeTemplateHistory(session, next, async () => {}, false)
  const projected = session.deriveMessages()
  assert.equal(projected.find(message => message.role === 'user').content[0].text, '新输入')
  assert.equal(projected.find(message => message.role === 'assistant').content[0].text, '新回复')
  const writes = sessionEvents(session).slice(original.length).filter(event => ['user/message', 'assistant/message'].includes(event.type))
  assert.equal(writes.length, 2)
  assert.equal(writes[0].data.id, 'input')
  assert.equal(writes[1].data.message.id, 'reply')
  assert.equal(writes[0].data.source.conversationTransaction.operationId, next.messages[0].templateHistoryEdit.id)
  assert.equal(writes[1].data.message.source.conversationTransaction.operationId, next.messages[1].templateHistoryEdit.id)
  const length = sessionEvents(session).length
  await synchronizeTemplateHistory(session, next, async () => {}, false)
  assert.equal(sessionEvents(session).length, length)
})

test('G4 rejects a template rewrite of a tool-bearing assistant before changing Chat or Session', async () => {
  const { session, chat } = fixture()
  const events = structuredClone(sessionEvents(session))
  const reply = events.find(event => event.type === 'assistant/message')
  reply.data.message.content.push({ type: 'tool-call', id: 'call', name: 'skill', arguments: '{}' })
  const restored = Session.create(session.id, events, session.header)
  const before = structuredClone(sessionEvents(restored))
  const next = structuredClone(chat)
  next.messages[1].text = '不能覆盖工具调用'
  await assert.rejects(prepareTemplateHistory(restored, chat, next, true), error => error.name === 'GuardError' && error.rule === 'G4')
  assert.equal(next.messages[1].templateHistoryEdit, undefined)
  assert.deepEqual(sessionEvents(restored), before)
})

test('native preflight rejects before publishing a Chat edit marker', async () => {
  const { session, chat } = fixture()
  const next = structuredClone(chat)
  next.messages[1].text = '宿主拒绝'
  const before = structuredClone(sessionEvents(session))
  const originalConstructor = session.constructor
  Object.defineProperty(session, 'constructor', { value: { fromRestore(...args) {
    const detached = originalConstructor.fromRestore(...args)
    detached.append = () => { throw Error('host rejects replacement') }
    return detached
  } }, configurable: true })
  await assert.rejects(prepareTemplateHistory(session, chat, next, true), /host rejects replacement/)
  assert.equal(next.messages[1].templateHistoryEdit, undefined)
  assert.deepEqual(sessionEvents(session), before)
})

test('disabled template edit retains the existing replacement format', async () => {
  const { session, chat } = fixture()
  const next = structuredClone(chat)
  next.messages[1].text = '旧路径'
  await prepareTemplateHistory(session, chat, next, false)
  assert.equal(next.messages[1].templateHistoryEdit.algebra, undefined)
  await synchronizeTemplateHistory(session, next, async () => {}, false)
  const latest = sessionEvents(session).findLast(event => event.type === 'assistant/message')
  assert.equal(latest.data.message.id, next.messages[1].templateHistoryEdit.id)
  assert.equal(latest.data.message.content[0].text, '旧路径')
})

test('durable template intent replays after a native flush failure and restart', async () => {
  const { session, chat } = fixture()
  const before = structuredClone(sessionEvents(session))
  const next = structuredClone(chat)
  next.messages[1].text = '重启后正文'
  await prepareTemplateHistory(session, chat, next, true)
  await assert.rejects(synchronizeTemplateHistory(session, next, async () => { throw Error('flush failed') }, false), /flush failed/)
  const restored = Session.create(session.id, before, session.header)
  await synchronizeTemplateHistory(restored, next, async () => {}, false)
  assert.equal(restored.deriveMessages().findLast(message => message.role === 'assistant').content[0].text, '重启后正文')
  assert.equal(sessionEvents(restored).findLast(event => event.type === 'assistant/message').data.message.source.conversationTransaction.operationId,
    next.messages[1].templateHistoryEdit.id)
})
