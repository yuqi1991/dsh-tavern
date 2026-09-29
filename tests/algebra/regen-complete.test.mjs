import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { createRegenerationRecovery } from '../../tavern-plugin/lib/domain/regeneration-recovery.js'
import { createConversationHistory } from '../../tavern-plugin/lib/domain/conversation-algebra-history.js'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }
const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
test.after(() => patch.dispose())

function fixture({ edited = false } = {}) {
  const session = Session.create('regen-complete-' + randomUUID().slice(0, 8))
  const oldSource = { kind: 'model', provider: 'fixture', model: 'fixture' }
  session.append('user/message', { id: 'old-input', role: 'user', content: [{ type: 'text', text: edited ? '改后输入' : '原输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, stream: [], message: { id: 'old-body', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: oldSource } }, { surfaceOp: 'append' })
  const userSeq = 0, assistantSeq = 1
  const operationId = randomUUID()
  const userProjection = edited ? {
    data: { id: 'edited-input', role: 'user', content: [{ type: 'text', text: '改后输入' }], source: { kind: 'user' } },
    range: { start: userSeq, end: userSeq, sourceEventSeqs: [userSeq] }
  } : null
  const projection = {
    data: { turn: 2, step: 1, message: { id: 'tavern-regen:' + operationId, role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: oldSource } },
    range: { start: assistantSeq, end: assistantSeq, sourceEventSeqs: [assistantSeq] }
  }
  let chat = { id: 'chat', sessionId: session.id, regenInProgress: true,
    regenRecovery: { id: operationId, phase: 'committed', sessionId: session.id, projection, ...(userProjection ? { userProjection } : {}) } }
  const chats = {
    read: async () => structuredClone(chat),
    update: async (_id, fn) => { const next = await fn(structuredClone(chat)); if (next) chat = structuredClone(next); return structuredClone(chat) }
  }
  const flush = async () => {}
  const flushCalls = []
  const sessions = { get: () => ({ session, phase: { kind: 'idle' } }), flush: async target => { flushCalls.push(target) } }
  const timeline = { apply: ({ intent }) => ({ chat: structuredClone(intent.restoreChat) }) }
  const api = enabled => createRegenerationRecovery({ chats, sessions, timeline, isActive: () => false,
    algebraHistory: { ...createConversationHistory({ chats, flush }), enabled: () => enabled } })
  return { api, get session() { return session }, get chat() { return chat }, flushCalls, operationId }
}

test('algebra complete commits edited input and new body as one transaction', async () => {
  const h = fixture({ edited: true })
  await h.api(true).complete({ chatId: 'chat', session: h.session, operationId: h.operationId })
  const events = h.session.snapshotEvents()
  const tags = events.map(event => (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction).filter(Boolean)
  assert.equal(tags.length, 2)
  assert.equal(tags[0].operationId, 'regen-complete:' + h.operationId)
  assert.equal(tags[0].phase, 'begin')
  assert.equal(tags[1].phase, 'commit')
  const fold = computeFold(events)
  assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
  assert.deepEqual(fold.rows.map(row => (row.data?.message ?? row.data)?.content?.[0]?.text), ['改后输入', '新正文'])
  assert.equal(h.chat.regenRecovery, undefined)
  assert.equal(h.chat.regenInProgress, undefined)
  assert.ok(h.flushCalls.length >= 1)
})

test('complete is idempotent after a committed transaction', async () => {
  const h = fixture({ edited: true })
  await h.api(true).complete({ chatId: 'chat', session: h.session, operationId: h.operationId })
  const count = h.session.snapshotEvents().length
  const chatAfter = structuredClone(h.chat)
  // Replay (e.g. recovery racing a retry) must not append or replace anything.
  await h.api(true).complete({ chatId: 'chat', session: h.session, operationId: h.operationId })
  assert.equal(h.session.snapshotEvents().length, count)
  assert.deepEqual(h.chat, chatAfter)
})

test('legacy path preserves direct replacement format when disabled', async () => {
  const h = fixture({ edited: true })
  await h.api(false).complete({ chatId: 'chat', session: h.session, operationId: h.operationId })
  const events = h.session.snapshotEvents()
  const tags = events.map(event => (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction).filter(Boolean)
  assert.equal(tags.length, 0)
  const fold = computeFold(events)
  assert.deepEqual(fold.rows.map(row => (row.data?.message ?? row.data)?.content?.[0]?.text), ['改后输入', '新正文'])
  assert.deepEqual(fold.surfaceNodes, h.session.surface.nodes)
})

test('flush failure keeps the durable intent and retry completes without duplicates', async () => {
  const h = fixture({ edited: true })
  const chatState = { current: structuredClone(h.chat) }
  let broken = true
  const flush = async () => { if (broken) throw new Error('flush cut') }
  const chats = { read: async () => structuredClone(chatState.current), update: async (_id, fn) => { const next = await fn(structuredClone(chatState.current)); if (next) chatState.current = structuredClone(next); return structuredClone(next ?? chatState.current) } }
  const recovery = createRegenerationRecovery({ chats, sessions: { get: () => ({ session: h.session, phase: { kind: 'idle' } }), flush }, timeline: { apply: ({ intent }) => ({ chat: structuredClone(intent.restoreChat) }) }, isActive: () => false,
    algebraHistory: { ...createConversationHistory({ chats, flush }), enabled: () => true } })
  await assert.rejects(recovery.complete({ chatId: 'chat', session: h.session, operationId: h.operationId }), /flush cut/)
  assert.ok(chatState.current.regenRecovery)
  broken = false
  await recovery.complete({ chatId: 'chat', session: h.session, operationId: h.operationId })
  assert.equal(chatState.current.regenRecovery, undefined)
  const tags = h.session.snapshotEvents().map(event => (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction).filter(Boolean)
  // The interrupted first attempt held only its begin marker; WAL recovery
  // completed the original plan, so exactly one begin+commit pair exists.
  assert.deepEqual(tags.filter(tag => tag.operationId === 'regen-complete:' + h.operationId).map(tag => tag.phase), ['begin', 'commit'])
  assert.deepEqual(computeFold(h.session.snapshotEvents()).surfaceNodes, h.session.surface.nodes)
})
