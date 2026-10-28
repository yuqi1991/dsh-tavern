import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { rewindBackgroundSurface } from '../tavern-plugin/lib/domain/background-surface.js'

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }
const PREFIX = { id: 'tavern-session-prefix:bg', role: 'user', content: [{ type: 'text', text: 'prefix' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'snapshot' } }
const system = id => ({ turn: 1, step: 1, message: { id, role: 'system', content: [{ type: 'text', text: id }], source: { kind: 'plugin', plugin: 'fixture' } } })
const assistant = (id, turn) => ({ turn, step: 1, stream: [], message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: MODEL } })
const ids = session => session.deriveMessages().map(message => message.id)

test('reset reuses the session and retains its fixed prefix while removing task context', async () => {
  const session = Session.create('bg-projection-prefix')
  session.append('user/message', PREFIX, { surfaceOp: 'append' })
  session.append('user/message', { id: 'task', role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', assistant('a1', 1), { surfaceOp: 'append' })
  assert.equal(await rewindBackgroundSurface(session, -1, { flush: async () => {} }), 2)
  assert.deepEqual(ids(session), ['tavern-session-prefix:bg'])
})

test('V3 reset preserves replaced system head and fixed prefix in surface order', async () => {
  const session = Session.create('bg-projection-v3-head')
  session.append('system/message', system('system'), { surfaceOp: 'append' })
  session.append('user/message', PREFIX, { surfaceOp: 'append' })
  session.append('assistant/message', assistant('a0', 1), { surfaceOp: 'append' })
  // Replacing the system head gives it a new seq but keeps surface position zero.
  session.append('system/message', system('system-v2'), { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] })
  session.append('assistant/message', assistant('a1', 2), { surfaceOp: 'append' })
  session.append('assistant/message', assistant('a2', 3), { surfaceOp: 'append' })
  const boundary = session.surface.nodes[2]
  assert.deepEqual(ids(session), ['system-v2', 'tavern-session-prefix:bg', 'a0', 'a1', 'a2'])
  assert.equal(await rewindBackgroundSurface(session, boundary, { flush: async () => {} }), 2)
  assert.deepEqual(ids(session), ['system-v2', 'tavern-session-prefix:bg', 'a0'])
})
