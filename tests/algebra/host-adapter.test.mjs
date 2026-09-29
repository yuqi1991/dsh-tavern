import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationAlgebraHostAdapter } from '../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'

function sessionFixture() {
  const events = []
  const session = {
    header: { version: 3 },
    events,
    surface: { nodes: [] },
    snapshotEvents() { return events.slice() },
    eventAt(seq) { return events[seq] },
    append(type, data, intent) {
      const event = { type, data: structuredClone(data), seq: events.length, time: 1, ...structuredClone(intent) }
      events.push(event)
      if (intent.surfaceOp === 'append') session.surface.nodes.push(event.seq)
      else {
        const start = intent.surfaceOp.startSeq
        const end = intent.surfaceOp.endSeq
        const startIndex = session.surface.nodes.indexOf(start)
        const endIndex = session.surface.nodes.indexOf(end)
        session.surface.nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
      }
      return event
    }
  }
  return session
}

test('host adapter delegates append and replacement to existing mutation helpers', () => {
  const session = sessionFixture()
  const adapter = createConversationAlgebraHostAdapter(session)
  adapter.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  adapter.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }, {
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0]
  })
  assert.deepEqual(session.surface.nodes, [1])
  assert.deepEqual(adapter.snapshotEvents().map(event => event.surfaceOp), ['append', { op: 'replace', startSeq: 0, endSeq: 0 }])
})
