import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { prepareTemplateHistory } from '../tavern-plugin/lib/domain/template-history.js'
test('大量已归档消息不反复扫描活动历史，并保持别名及重复文本的匹配顺序', async () => {
  const session = Session.create('template-history-performance')
  const events = []
  for (let seq = 0; seq < 1000; seq++) {
    session.append('user/message', { id: 'm' + seq, role: 'user', content: [{ type: 'text', text: 'text' + seq }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    events.push(session.snapshotEvents().at(-1))
  }
  let reads = 0
  const snapshot = session.snapshotEvents.bind(session)
  session.snapshotEvents = () => snapshot().map(event => {
    const content = event.data.content
    return { ...event, data: Object.defineProperty({ ...event.data }, 'content', { enumerable: true, get() { reads++; return content } }) }
  })
  const before = { messages: [...Array.from({ length: 1000 }, () => ({ role: 'user', text: 'archived' })), ...events.map(e => ({ role: 'user', text: e.data.content[0].text }))] }
  reads = 0
  const after = { messages: before.messages.map(m => ({ ...m, text: m.text+'changed' })) }
  await prepareTemplateHistory(session, before, after)
  // The native fold and preflight read each message a bounded number of times (about
  // 10 here), so reads stay linear in history size; a per-row rescan would be
  // about 2000 rows x 1000 messages.
  assert.ok(reads <= 15 * events.length, `content reads: ${reads}`)
  assert.equal(after.messages[999].templateHistoryEdit, undefined)
  assert.equal(after.messages[1000].templateHistoryEdit.seq, 0)
  assert.equal(after.messages.at(-1).templateHistoryEdit.seq, 999)
  const aliases = { messages: [{ role: 'user', text: 'different', sourceText: 'text1', sessionText: 'text0' }, { role: 'user', text: 'text0' }, { role: 'user', text: 'text1' }] }
  const changed = { messages: aliases.messages.map(m => ({ ...m, text: 'changed' })) }
  await prepareTemplateHistory(session, aliases, changed)
  assert.deepEqual(changed.messages.map(m => m.templateHistoryEdit?.seq), [0, undefined, 1])
})
