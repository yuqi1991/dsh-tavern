import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSkillReminder } from '../tavern-plugin/lib/domain/skill-reminder.js'
import { retireForegroundFrames } from '../tavern-plugin/lib/domain/foreground-frame-retirement.js'

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

test('技能纯装载与旧目录退役，混合调用和故事消息保留', () => {
  const session = sessionFixture()
  const model = { kind: 'model', provider: 'test', model: 'test' }
  const catalog = session.append('user/message', { id: 'catalog', role: 'user', content: [{ type: 'text', text: '技能目录' }], source: { kind: 'skill-catalog' } }, { surfaceOp: 'append' })
  const reminder = session.append('user/message', { id: 'reminder', role: 'user', content: [{ type: 'text', text: '技能提醒' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'writing-skill-reminder', trace: { turn: 1 } } }, { surfaceOp: 'append' })
  session.append('tool/call', { callId: 'load', name: 'skill', turn: 1 })
  const pure = session.append('assistant/message', { turn: 1, step: 1, message: { id: 'pure', role: 'assistant', content: [{ type: 'tool-call', name: 'skill', id: 'load' }], source: model } }, { surfaceOp: 'append' })
  const result = session.append('tool/result', { turn: 1, message: { id: 'result', role: 'tool', content: [{ type: 'text', text: '长篇技能正文' }], source: { callId: 'load' } } }, { surfaceOp: 'append' })
  const mixed = session.append('assistant/message', { turn: 1, step: 1, message: { id: 'mixed', role: 'assistant', content: [{ type: 'tool-call', name: 'skill', id: 'load' }, { type: 'tool-call', name: 'other', id: 'other' }], source: model } }, { surfaceOp: 'append' })
  const story = session.append('user/message', { id: 'story', role: 'user', content: [{ type: 'text', text: '玩家剧情' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  assert.equal(retireForegroundFrames(session, { keepTurn: 2 }), 4)
  assert.equal(retireForegroundFrames(session, { keepTurn: 2 }), 0)
  assert.ok(session.surface.nodes.includes(mixed.seq))
  assert.ok(session.surface.nodes.includes(story.seq))
  for (const old of [catalog, reminder, pure, result]) assert.equal(session.surface.nodes.includes(old.seq), false)
  assert.equal(session.events.slice(0, 6).some(event => event.data?.content?.[0]?.text === '技能目录'), true)
})
