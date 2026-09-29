import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { computeFold, runTransaction, waitForTransactionReady } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter } from '../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'
import { sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'

const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' })
test.after(() => patch.dispose())

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }

function sessionWithTurn() {
  const session = Session.create('reply-projection-' + randomUUID().slice(0, 8))
  session.append('user/message', { id: 'input', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, stream: [], message: {
    id: 'raw-reply', role: 'assistant', content: [{ type: 'text', text: '原始正文（未投影）' }], source: MODEL } }, { surfaceOp: 'append' })
  return session
}

/** The exact op shape replaceAssistantReply now stages under the algebra flag. */
function replyProjectionOp(session, index, bodyText, previous) {
  return {
    kind: 'surface-write',
    event: { type: 'assistant/message', data: {
      turn: Number(session.snapshotEvents()[index].data?.turn) || 0,
      step: Number(session.snapshotEvents()[index].data?.step) || 1,
      message: Object.assign({}, previous, {
        id: randomUUID(),
        source: { kind: 'model', provider: 'dsh-tavern', model: 'reply-projection' },
        content: [{ type: 'text', text: bodyText }]
      }),
      stream: [...(session.snapshotEvents()[index].data?.stream || [])]
    } },
    intent: { surfaceOp: { op: 'replace', start: index, end: index }, sourceEventSeqs: [index] }
  }
}

test('reply projection replacement commits as one guarded transaction and keeps the fold consistent', async () => {
  const session = sessionWithTurn()
  let flushes = 0
  const adapter = createConversationAlgebraHostAdapter(session, { flush: async () => { flushes++ } })
  await waitForTransactionReady(adapter)
  const index = session.surface.nodes.at(-1)
  const previous = session.snapshotEvents()[index].data.message
  await runTransaction(adapter, {
    expectedHead: computeFold(sessionEvents(session)).headSeq,
    operationId: 'reply-projection:' + randomUUID(),
    ops: [replyProjectionOp(session, index, '投影后的正文', previous)]
  })
  assert.ok(flushes >= 1)
  const fold = computeFold(session.snapshotEvents())
  assert.deepEqual(fold.surfaceNodes, session.surface.nodes)
  const projected = fold.rows.at(-1)
  assert.equal(projected.data.message.source.provider, 'dsh-tavern')
  assert.equal(projected.data.message.source.model, 'reply-projection')
  assert.equal(projected.data.message.content[0].text, '投影后的正文')
  const tags = session.snapshotEvents().map(event => event.data?.message?.source?.conversationTransaction).filter(Boolean)
  assert.equal(tags.length, 1)
  assert.equal(tags[0].phase, 'begin-commit')
  assert.ok(tags[0].operationId.startsWith('reply-projection:'))
})

test('a concurrent write between fold and commit is rejected instead of silently merging', async () => {
  const session = sessionWithTurn()
  const adapter = createConversationAlgebraHostAdapter(session, { flush: async () => {} })
  await waitForTransactionReady(adapter)
  const index = session.surface.nodes.at(-1)
  const previous = session.snapshotEvents()[index].data.message
  const staleHead = computeFold(sessionEvents(session)).headSeq
  session.append('user/message', { id: 'race', role: 'user', content: [{ type: 'text', text: '并发' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  await assert.rejects(runTransaction(adapter, {
    expectedHead: staleHead,
    operationId: 'reply-projection:' + randomUUID(),
    ops: [replyProjectionOp(session, index, '过期投影', previous)]
  }), /期望头/)
  // No tombstone or projection row survived the rejection.
  const rows = computeFold(session.snapshotEvents()).rows
  assert.ok(!rows.some(row => row.data?.message?.source?.model === 'reply-projection'))
  assert.deepEqual(computeFold(session.snapshotEvents()).surfaceNodes, session.surface.nodes)
})
