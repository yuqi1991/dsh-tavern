import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import { ensureSessionStablePrefix, readSessionStablePrefix } from '../../lib/domain/session-stable-prefix.js'
import { appendSessionEvent, sessionEvents } from '../../lib/domain/session-events.js'
import { computeFold } from '../../lib/domain/conversation-algebra/index.js'

const patch = await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib', { version: '0.2.1-rc.2' })
test.after(() => patch.dispose())

test('fixed background migration uses one guarded transaction and remains idempotent', async () => {
  const session = Session.create('stable-prefix-algebra')
  const original = appendSessionEvent(session, 'user/message', {
    id: 'tavern-session-prefix:' + session.id, role: 'user',
    content: [{ type: 'text', text: '旧固定背景' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'snapshot' }
  }, { surfaceOp: 'append' })
  let flushes = 0
  const flush = async () => { flushes++ }
  const migrated = await ensureSessionStablePrefix(session, '新内容不覆盖旧背景', null, 0, flush)
  assert.equal(migrated.text, '旧固定背景')
  assert.equal(migrated.message.source.form, 'snapshot')
  assert.equal(migrated.message.source.conversationTransaction.phase, 'begin-commit')
  assert.ok(migrated.message.source.conversationTransaction.operationId.startsWith('prefix:'))
  assert.equal(session.surface.nodes.includes(original.seq), false)
  assert.deepEqual(session.surface.nodes, computeFold(sessionEvents(session)).surfaceNodes)
  assert.ok(flushes >= 1)
  const count = sessionEvents(session).length
  await ensureSessionStablePrefix(session, '仍不覆盖', null, 0, flush)
  assert.equal(sessionEvents(session).length, count)
  assert.equal(readSessionStablePrefix(session).text, '旧固定背景')
})

test('new fixed background snapshot and approved revision append through transactions', async () => {
  const session = Session.create('stable-prefix-new')
  const flush = async () => {}
  const first = await ensureSessionStablePrefix(session, '第一版固定背景', null, 0, flush)
  assert.equal(first.message.source.conversationTransaction.phase, 'begin-commit')
  assert.equal(first.text, '第一版固定背景')
  const second = await ensureSessionStablePrefix(session, '第二版固定背景', null, 1, flush)
  assert.equal(second.message.source.conversationTransaction.phase, 'begin-commit')
  assert.equal(second.revision, 1)
  assert.equal(second.text, '第二版固定背景')
  assert.equal(readSessionStablePrefix(session).text, '第二版固定背景')
  assert.deepEqual(session.surface.nodes, computeFold(sessionEvents(session)).surfaceNodes)
  const count = sessionEvents(session).length
  await ensureSessionStablePrefix(session, '第二版固定背景', null, 1, flush)
  assert.equal(sessionEvents(session).length, count)
})
