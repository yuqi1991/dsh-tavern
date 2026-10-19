import test from 'node:test'
import assert from 'node:assert/strict'
import { projectFloors, projectChatFloors } from '../../lib/domain/floor-projection.js'

// Pure event fixtures in the shapes real logs carry (see the offline scan of
// every stored chat, .offline/scan-floors.mjs in the dev workspace).
function log() {
  const events = []
  const add = (type, data, extra = {}) => { const event = { seq: events.length, type, data, ...extra }; events.push(event); return event.seq }
  return {
    events,
    start: turn => add('turn/start', { turn }),
    end: turn => add('turn/end', { turn }),
    input: text => add('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    regen: () => add('user/message', { role: 'user', content: [{ type: 'text', text: 'again' }], source: { kind: 'plugin', plugin: 'dsh-tavern-regen' } }, { surfaceOp: 'append' }),
    reply: (turn, text) => add('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } }, { surfaceOp: 'append' }),
    copy: (turn, text, start, end, sources) => add('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: sources })
  }
}

/** Opening, floor 2, floor 3; floor 3 rerolled twice the legacy way. */
function legacyRerolls() {
  const l = log()
  l.start(1); const opening = l.reply(1, 'opening'); l.end(1)
  l.start(2); const in2 = l.input('a'); const body2 = l.reply(2, 'two'); l.end(2)
  l.start(3); const in3 = l.input('b'); const body3 = l.reply(3, 'three'); l.end(3)
  l.start(4); const regen4 = l.regen(); const body4 = l.reply(4, 'three again'); l.end(4)
  const copy4 = l.copy(3, 'three again', body3, body4, [body3, regen4, body4])
  l.start(5); const regen5 = l.regen(); const body5 = l.reply(5, 'three thrice'); l.end(5)
  const copy5 = l.copy(3, 'three thrice', copy4, body5, [copy4, regen5, body5])
  return { events: l.events, nodes: [opening, in2, body2, in3, copy5], log: l }
}

test('a legacy reroll copy is hosted on the turn its reply was appended in', () => {
  const { events, nodes } = legacyRerolls()
  const projection = projectFloors({ events, nodes, floorTurns: [1, 2, 3] })
  assert.equal(projection.floors.find(floor => floor.turn === 3).hostTurn, 5)
  assert.deepEqual(projection.floors.find(floor => floor.turn === 3).nativeTurns, [3, 5])
})

test('card workspaces have no story floors', () => {
  const { events, nodes } = legacyRerolls()
  const chat = { mode: 'card', messages: [{ role: 'assistant', greeting: true }, { role: 'user' }, { role: 'assistant' }] }
  assert.deepEqual(projectChatFloors(chat, events, nodes), { floors: [] })
})

test('the chat entry point reads floors from messages', () => {
  const { events, nodes, log: l } = legacyRerolls()
  l.start(6); l.regen(); l.end(6)
  const chat = { mode: 'story', acknowledgedFailedTurns: [6], messages: [
    { role: 'assistant', greeting: true }, { role: 'user' }, { role: 'assistant', turn: 2 }, { role: 'user' }, { role: 'assistant', turn: 3 }] }
  const projection = projectChatFloors(chat, events, nodes)
  assert.deepEqual(projection.floors.map(floor => floor.turn), [1, 2, 3])
})
