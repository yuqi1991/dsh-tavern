import test from 'node:test'
import assert from 'node:assert/strict'
import { planFailedTurnSurface, rollbackAvailability, clearFailedTurnSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { selectSurface } from '../tavern-plugin/lib/domain/surface-restoration.js'

const replaceSessionSurface = (session, type, data, range) => createSessionSurfaceMutator(session).replace(type, data, range)
const flush = async () => {}

const user = (id, plugin) => ({ id, role: 'user', content: [{ type: 'text', text: id }], source: plugin ? { kind: 'plugin', plugin } : { kind: 'user' } })
const body = (id, turn) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'test', model: 'test' } } })
function fixture() {
  const session = Session.create('surface-recovery')
  const context = appendSessionEvent(session, 'user/message', user('historical-context', 'context-provider'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', body('old-body', 1), { surfaceOp: 'append' })
  const start = appendSessionEvent(session, 'turn/start', { turn: 2 })
  const refreshed = replaceSessionSurface(session, 'user/message', user('refreshed-context', 'context-provider'), { start: context.seq, end: context.seq, sourceEventSeqs: [context.seq] })
  const input = appendSessionEvent(session, 'user/message', user('attempt', 'dsh-tavern-regen'), { surfaceOp: 'append' })
  const reply = appendSessionEvent(session, 'assistant/message', body('partial', 2), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'error' } })
  return { session, eventStart: start.seq, refreshed, input, reply }
}

test('失败清理按来源保留任意历史上下文更新', async () => {
  const f = fixture()
  const plan = planFailedTurnSurface({ events: sessionEvents(f.session), nodes: f.session.surface.nodes, turn: 2 })
  assert.deepEqual(plan.shadowedSeqs, [f.input.seq, f.reply.seq])
  assert.equal(await clearFailedTurnSurface({ session: f.session, turn: 2, flush }), 2)
  const count = sessionEvents(f.session).length
  assert.equal(await clearFailedTurnSurface({ session: f.session, turn: 2, flush }), 0)
  assert.equal(sessionEvents(f.session).length, count)
  assert.ok(f.session.surface.nodes.includes(f.refreshed.seq))
})

test('失败结束后多次替换残留仍属于失败轮，后续正文不受影响', () => {
  const f = fixture()
  const edited = replaceSessionSurface(f.session, 'assistant/message', body('edited-partial', 2), { start: f.reply.seq, end: f.reply.seq, sourceEventSeqs: [f.reply.seq] })
  const editedAgain = replaceSessionSurface(f.session, 'assistant/message', body('edited-again', 2), { start: edited.seq, end: edited.seq, sourceEventSeqs: [edited.seq] })
  appendSessionEvent(f.session, 'turn/start', { turn: 3 })
  appendSessionEvent(f.session, 'assistant/message', body('later-body', 3), { surfaceOp: 'append' })
  const plan = planFailedTurnSurface({ events: sessionEvents(f.session), nodes: f.session.surface.nodes, turn: 2 })
  assert.deepEqual(plan.shadowedSeqs, [f.input.seq, editedAgain.seq])
})

test('跨回合污染使恢复不可用，但不让状态查询抛错', () => {
  const f = fixture()
  const nodes = [f.refreshed.seq, f.input.seq, 1, f.reply.seq]
  assert.throws(() => planFailedTurnSurface({ events: sessionEvents(f.session), nodes, turn: 2 }), /无法安全清理/)
  const state = rollbackAvailability({ messages: [{ role: 'assistant', turn: 1 }] }, { events: sessionEvents(f.session), nodes })
  assert.equal(state.canRollback, false)
  assert.equal(state.canClearIncompleteReply, false)
  assert.match(state.reason, /无法安全清理/)
})

test('归属跨回合混合或来源残缺时，清理拒绝写入', async () => {
  for (const corrupt of ['mixed', 'missing', 'missing-all', 'forward']) {
    const f = fixture()
    const events = sessionEvents(f.session).map(event => structuredClone(event))
    const replacement = { seq: events.at(-1).seq + 1, type: 'assistant/message', data: body('replacement', 2),
      surfaceOp: { op: 'replace', start: f.reply.seq, end: f.reply.seq },
      sourceEventSeqs: corrupt === 'missing-all' ? [] : corrupt === 'mixed' ? [f.reply.seq, 1] : corrupt === 'missing' ? [f.reply.seq, 999] : [f.reply.seq, events.at(-1).seq + 1] }
    events.push(replacement)
    const nodes = f.session.surface.nodes.map(seq => seq === f.reply.seq ? replacement.seq : seq)
    const session = { events, surface: { nodes }, append() { assert.fail('unsafe recovery must not write') } }
    await assert.rejects(() => clearFailedTurnSurface({ session, turn: 2, flush }), /无法安全清理/)
    assert.throws(() => planFailedTurnSurface({ events, nodes, turn: 2 }), /无法安全清理/)
    const state = rollbackAvailability({ messages: [{ role: 'assistant', turn: 1 }] }, { events, nodes })
    assert.equal(state.canRollback, false)
  }
})

test('回退只需要最后一个输入的位置：其后跨回合的正文属于同一次选择清理的尾部，而不是拒绝', async () => {
  const { locateRollbackSurface } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const f = fixture()
  appendSessionEvent(f.session, 'turn/start', { turn: 3 })
  appendSessionEvent(f.session, 'assistant/message', body('new-turn', 3), { surfaceOp: 'append' })
  appendSessionEvent(f.session, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
  const evidence = { events: sessionEvents(f.session), nodes: f.session.surface.nodes }
  // Rollback is a selection before the last input: no owned range has to be
  // proven, and the later turn's body is part of the tail it clears.
  const located = locateRollbackSurface(evidence)
  assert.equal(located.assistantSeq, evidence.nodes.at(-1))
  assert.ok(located.shadowedSeqs.includes(located.assistantSeq))
})

test('历史用户或正文编辑、非数字顺序的替换链和重载共用清理规则', async () => {
    for (const replaceOldBody of [false, true]) {
    const f = fixture()
    const target = replaceOldBody ? 1 : f.refreshed.seq
    const historical = replaceSessionSurface(f.session, replaceOldBody ? 'assistant/message' : 'user/message', replaceOldBody ? body('edited-history', 1) : user('edited-context', 'another-plugin'), { start: target, end: target, sourceEventSeqs: [target] })
    let latest = f.reply.seq
    for (let i = 0; i < 12; i++) {
      latest = replaceSessionSurface(f.session, 'assistant/message', body('edit-' + i, 2), { start: latest, end: latest, sourceEventSeqs: [latest] }).seq
    }
    const session = Session.create(f.session.id, JSON.parse(JSON.stringify(sessionEvents(f.session))), f.session.header)
    assert.equal(await clearFailedTurnSurface({ session, turn: 2, flush }), 2)
    assert.ok(session.surface.nodes.includes(historical.seq))
    assert.ok(!session.surface.nodes.includes(latest))
    const after = sessionEvents(session).length
    assert.equal(await clearFailedTurnSurface({ session, turn: 2, flush }), 0)
    assert.equal(sessionEvents(session).length, after)
  }
})

test('连续失败清理共用计划，清理后仍能回退、撤销回退并继续失败恢复', async () => {
  const { locateRollbackSurface } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  let session = Session.create('recovery-sequence')
  appendSessionEvent(session, 'user/message', user('original'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', body('original', 1), { surfaceOp: 'append' })
  for (const turn of [2, 3]) {
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'user/message', user('input-' + turn), { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', body('partial-' + turn, turn), { surfaceOp: 'append' })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'error' } })
  }
  const chat = { messages: [{ role: 'user' }, { role: 'assistant', turn: 1 }] }
  const available = rollbackAvailability(chat, { events: sessionEvents(session), nodes: session.surface.nodes })
  assert.deepEqual(available.unclearedTurns, [3, 2])
  for (const turn of available.unclearedTurns) await clearFailedTurnSurface({ session, turn, flush })
  const saved = [...session.surface.nodes]
  const plan = locateRollbackSurface({ events: sessionEvents(session), nodes: saved })
  replaceSessionSurface(session, 'assistant/message', { ...body('rollback', 1), message: { ...body('rollback', 1).message, content: [] } }, { start: plan.userSeq, end: plan.endSeq, sourceEventSeqs: plan.shadowedSeqs })
  selectSurface(session, saved)
  session = Session.create(session.id, JSON.parse(JSON.stringify(sessionEvents(session))), session.header)
  assert.equal(locateRollbackSurface({ events: sessionEvents(session), nodes: session.surface.nodes }).turn, 1)
  appendSessionEvent(session, 'turn/start', { turn: 4 })
  appendSessionEvent(session, 'user/message', user('input-4'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 4, reason: { kind: 'error' } })
  assert.equal(await clearFailedTurnSurface({ session, turn: 4, flush }), 1)
  assert.match(JSON.stringify(session.deriveMessages()), /original/)
})

test('失败重试按钮和执行入口都拒绝不安全范围', async () => {
  const { failedTurnReplayAvailability } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const f = fixture()
  const events = sessionEvents(f.session).map(event => event.seq === f.input.seq ? { ...event, data: user('real-input') } : event)
  const nodes = [f.refreshed.seq, f.input.seq, 1, f.reply.seq]
  const result = failedTurnReplayAvailability({ events, nodes })
  assert.equal(result.target, null)
  assert.match(result.reason, /无法安全清理/)
  assert.equal(failedTurnReplayAvailability({ events, nodes: f.session.surface.nodes }).target.turn, 2)
})
