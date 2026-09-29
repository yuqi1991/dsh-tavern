import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { createConversationAlgebraHostAdapter } from '../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'
import { planRegenerationAttemptCleanup } from '../../tavern-plugin/lib/domain/rollback-surface.js'
import { runTransaction, computeFold, recoverTransaction } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { user, assistant } from './helpers.mjs'

test('failed regeneration cleanup is one guarded transaction and recovers after a cut', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
  try {
    const session = Session.create('regen-cleanup-algebra')
    for (const row of [user('input', '继续'), assistant('old', '旧正文', 2)]) session.append(row.type, row.data, { surfaceOp: 'append' })
    session.append('user/message', { id: 'synthetic', role: 'user', content: [{ type: 'text', text: '重掷' }], source: { kind: 'plugin', plugin: 'dsh-tavern-regen' } }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 3, step: 1, stream: [], message: { id: 'partial', role: 'assistant', content: [{ type: 'text', text: '半截' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append' })
    const events = session.snapshotEvents(), cleanup = planRegenerationAttemptCleanup({ events, nodes: session.surface.nodes, eventStart: 2 })
    assert.ok(cleanup)
    const write = { kind: 'surface-write', event: { type: 'user/message', data: { id: 'abort', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-tavern-regeneration-abort' } } }, intent: { surfaceOp: { op: 'replace', start: cleanup.start, end: cleanup.end }, sourceEventSeqs: cleanup.shadowedSeqs } }
    const base = createConversationAlgebraHostAdapter(session, { flush: async () => {} })
    await runTransaction(base, { expectedHead: events.at(-1).seq, operationId: 'regen-abort:op', ops: [write] })
    const restored = Session.fromRestore(session.id, structuredClone(session.snapshotEvents()), structuredClone(session.header), session.inheritedEventCount, 'detached')
    await recoverTransaction(createConversationAlgebraHostAdapter(restored, { flush: async () => {} }))
    assert.deepEqual(computeFold(restored.snapshotEvents()).rows.map(row => row.data.id ?? row.data.message.id), ['input', 'old'])
    const count = restored.snapshotEvents().length
    await recoverTransaction(createConversationAlgebraHostAdapter(restored, { flush: async () => {} }))
    assert.equal(restored.snapshotEvents().length, count)
  } finally { patch.dispose() }
})
