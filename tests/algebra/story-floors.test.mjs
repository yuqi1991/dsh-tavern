import test from 'node:test'
import assert from 'node:assert/strict'
import { pageStoryFloors, storyFloorsOf } from '../../lib/domain/story-floors.js'

function chatWith(rounds, { open = false } = {}) {
  const messages = [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }]
  for (let turn = 2; turn < rounds + 2; turn++) {
    messages.push({ role: 'user', text: '输入' + turn }, { role: 'assistant', text: '正文' + turn, turn })
  }
  if (open) messages.push({ role: 'user', text: '还没回' })
  return { id: 'chat', messages }
}

test('story floors are the opening plus one floor per input and reply', () => {
  const chat = chatWith(2)
  chat.messages[1].tavernPluginData = { template_display: { source: '输入2', swipe: 0, html: '<b>输入2</b>' } }
  const floors = storyFloorsOf(chat, {
    projections: [{ turn: 3, mode: 'html', text: '<p>正文3</p>', parts: [{ kind: 'html', content: '<p>正文3</p>' }] }],
    receipts: [{ turn: 2, receipt: { status: 'updated' } }]
  })
  assert.deepEqual(floors.map(floor => floor.turn), [1, 2, 3])
  assert.equal(floors[0].greeting, true)
  assert.equal(floors[0].input, null)
  assert.deepEqual(floors[0].body, { mode: 'markdown', text: '开场', warnings: [] })
  assert.equal(floors[1].input.text, '输入2')
  assert.equal(floors[1].input.templateDisplay, '<b>输入2</b>')
  assert.equal(floors[1].receipt.receipt.status, 'updated')
  assert.equal(floors[2].body.mode, 'html')
  assert.equal(floors[2].body.parts[0].content, '<p>正文3</p>')
})

test('a trailing input without a reply is an open floor', () => {
  const floors = storyFloorsOf(chatWith(1, { open: true }))
  assert.deepEqual(floors.at(-1), { turn: 3, input: { text: '还没回' }, body: null, receipt: null, open: true })
})

test('pages count floors, newest first page, and reach the opening', () => {
  const floors = storyFloorsOf(chatWith(44))
  assert.equal(floors.length, 45)
  const first = pageStoryFloors(floors)
  assert.deepEqual([first.floors[0].turn, first.floors.at(-1).turn, first.hasMore, first.total], [26, 45, true, 45])
  const second = pageStoryFloors(floors, { before: 26 })
  assert.deepEqual([second.floors[0].turn, second.floors.at(-1).turn, second.hasMore], [6, 25, true])
  const last = pageStoryFloors(floors, { before: 6 })
  assert.deepEqual([last.floors[0].turn, last.floors.at(-1).turn, last.hasMore], [1, 5, false])
  // A short story fits one page, opening included.
  const short = pageStoryFloors(storyFloorsOf(chatWith(2)))
  assert.deepEqual([short.floors[0].turn, short.hasMore], [1, false])
})

test('refresh from a loaded floor returns everything after it', () => {
  const floors = storyFloorsOf(chatWith(30))
  const refreshed = pageStoryFloors(floors, { from: 10 })
  assert.deepEqual([refreshed.floors[0].turn, refreshed.floors.at(-1).turn, refreshed.hasMore], [10, 31, true])
  assert.deepEqual(pageStoryFloors(floors, { from: 1 }).hasMore, false)
})
