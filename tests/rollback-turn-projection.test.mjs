import { clearFailedTurnSurface, locateRollbackSurface } from '../tavern-plugin/lib/domain/rollback-surface.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import assert from 'node:assert/strict'
import test from 'node:test'

test('中断残留正文随回退消失，重载后不复现', async () => {
  let session = Session.create('interrupted-rollback')
  const model = { kind: 'model', provider: 'fixture', model: 'fixture' }
  for (const turn of [1, 2, 3]) {
    session.append('turn/start', { turn })
    session.append('user/message', { id: 'u' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'input' + turn }] }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn, step: 1, stream: [], message: { id: 'a' + turn, role: 'assistant', source: model, content: [{ type: 'text', text: turn === 3 ? '中断时已流出的半截正文' : 'reply' + turn }] } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: turn === 3 ? 'aborted' : 'completed' } })
  }
  // Same event sequence as the report: aborted reply -> failed-turn cleanup -> rollback.
  await clearFailedTurnSurface({ session, turn: 3, flush: async () => {} })
  const rollback = locateRollbackSurface({ events: sessionEvents(session), nodes: session.surface.nodes })
  assert.equal(rollback.turn, 2)
  session.append('assistant/message', { turn: 2, step: 1, stream: [], message: { id: 'rollback', role: 'assistant', source: model, content: [] } }, {
    surfaceOp: { op: 'replace', startSeq: rollback.userSeq, endSeq: rollback.endSeq }, sourceEventSeqs: rollback.shadowedSeqs
  })
  for (const reload of [false, true]) {
    if (reload) session = Session.create(session.id, sessionEvents(session), session.header)
    const visible = JSON.stringify(session.deriveMessages())
    assert.ok(!visible.includes('中断时已流出的半截正文'), '模型上下文已清理')
    assert.ok(!visible.includes('input2') && !visible.includes('reply2'), '已提交回合已回退')
    assert.ok(visible.includes('input1') && visible.includes('reply1'), '保留回合不受影响')
  }
})
