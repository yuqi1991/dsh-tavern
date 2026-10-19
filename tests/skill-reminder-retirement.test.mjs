import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSkillReminder } from '../tavern-plugin/lib/domain/skill-reminder.js'

function sessionFixture() {
  const events = [], surface = { nodes: [] }
  return { events, surface, append(type, data, options = {}) {
    const event = { seq: events.length, type, data, ...options }
    events.push(event)
    if (options.surfaceOp === 'append') surface.nodes.push(event.seq)
    else if (options.surfaceOp?.op === 'replace') {
      const start = surface.nodes.indexOf(options.surfaceOp.start)
      const end = surface.nodes.indexOf(options.surfaceOp.end)
      assert.ok(start >= 0 && end >= start)
      surface.nodes.splice(start, end - start + 1, event.seq)
    }
    return event
  } }
}

test('技能目录从追加历史读取，当前请求已有目录时不重复注入', () => {
  const session = sessionFixture()
  const catalog = { id: 'catalog', role: 'user', content: [{ type: 'text', text: '可用技能：story' }], source: { kind: 'skill-catalog' } }
  session.append('user/message', catalog, { surfaceOp: 'append' })
  const reminder = buildSkillReminder(session, { messages: [], disabledWritingSkills: ['z', 'z'], trace: { turn: 2 } })
  assert.match(reminder.text, /可用技能：story/)
  assert.deepEqual(reminder.source.disabledWritingSkills, ['z'])
  assert.doesNotMatch(buildSkillReminder(session, { messages: [catalog], disabledWritingSkills: ['z'] }).text, /可用技能：story/)
})
