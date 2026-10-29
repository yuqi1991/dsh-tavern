// "An operation is never refused for failing to locate" (rollback, reroll, body
// edit). Every test builds a log shape that used to be refused because the
// target was found by native turn arithmetic or range ownership, and asserts
// the operation now completes with the meaning an exact location would give.
// The log stays the only authority: no bookkeeping rows are written for
// location, and every write is a normal transaction (select / edit).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlayHarness, withHostPatch } from './locate-harness.mjs'

const hasBookkeeping = h => h.events.some(event => ['conversation-metadata', 'surface-restore'].includes(event.data?.source?.form))

test('edit the body after switching to an older variant', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a')
  await h.regenerate()                 // floor 2: 正文2 saved, 正文3 live
  await h.switchVariant(0)             // the older variant is on the surface; the floor is hosted on turn 3
  assert.deepEqual(h.surfaceBodies().at(-1), '正文2')
  await h.editBody('改过的旧变体')
  assert.equal(h.surfaceBodies().at(-1), '改过的旧变体')
  assert.equal(h.chat.messages.at(-1).text, '改过的旧变体')
  assert.equal(hasBookkeeping(h), false)
  // The edit is a first-class floor body: rollback still finds it.
  await h.rollback()
  assert.deepEqual(h.surfaceInputs(), [])
}))

for (const frames of [false, true]) {
  test(`edit-step bodies without tavernStoryTurn stay locatable (frames=${frames})`, () => withHostPatch(async () => {
    const h = createPlayHarness({ frames })
    await h.play('a'); await h.play('b', '带工具的正文', { tools: true })
    await h.editBody('改过')
    h.stripStoryTurns()                // the edit now only carries the edit step's own turn number
    const availability = h.availability()
    assert.equal(availability.canRollback, true, availability.reason)
    // reroll first: it needs the live body of the last floor
    await h.regenerate()
    assert.match(h.surfaceBodies().at(-1), /^正文/)
    h.stripStoryTurns()
    await h.editBody('再改')
    h.stripStoryTurns()
    await h.rollback()
    assert.deepEqual(h.surfaceInputs(), ['a'])
    assert.equal(hasBookkeeping(h), false)
  }))
}

test('rollback is not refused by a mixed-turn tail', () => withHostPatch(async () => {
  // A tool step keeps its own turn while the edited body sits in an edit step
  // without tavernStoryTurn: no single turn owns the whole tail any more.
  const h = createPlayHarness({ frames: true })
  await h.play('a'); await h.play('b', '终稿', { tools: true })
  await h.editBody('改过')
  h.stripStoryTurns()
  await h.rollback()
  assert.deepEqual(h.surfaceInputs(), ['a'])
  assert.deepEqual(h.chat.messages.filter(message => message.role === 'user').map(message => message.text), ['a'])
}))

test('a completed round the Chat never recorded leaves with the rollback of the Chat floor', () => withHostPatch(async () => {
  // Crash between the log's turn end and the Chat commit: the log is one round
  // ahead. The Chat's last floor decides the target, by its input's position.
  const h = createPlayHarness()
  await h.play('a'); await h.play('b')
  await h.playLogOnly('孤儿输入', '孤儿正文')
  const availability = h.availability()
  assert.equal(availability.canRollback, true, availability.reason)
  const result = await h.rollback()
  assert.equal(result.rolledBack.removedUserText, 'b')
  assert.deepEqual(h.surfaceInputs(), ['a'])
  assert.deepEqual(h.chat.messages.filter(message => message.role === 'user').map(message => message.text), ['a'])
  assert.equal(hasBookkeeping(h), false)
  // undo returns to exactly the line that was left, orphan included
  await h.undo()
  assert.deepEqual(h.surfaceInputs(), ['a', 'b', '孤儿输入'])
}))

test('a Chat floor the log already left only steps the Chat back, leaving an undo point', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a'); await h.play('b')
  // Someone selected the surface back to before b's input; the Chat still shows b.
  const inputB = h.events.find(event => event.data?.id === 'input-3').seq
  h.selectNodes(h.session.surface.nodes.slice(0, h.session.surface.nodes.indexOf(inputB)))
  assert.deepEqual(h.surfaceInputs(), ['a'])
  const availability = h.availability()
  assert.equal(availability.canRollback, true, availability.reason)
  const nodes = [...h.session.surface.nodes]
  await h.rollback()
  assert.deepEqual([...h.session.surface.nodes], nodes, 'the surface already excluded the floor')
  assert.deepEqual(h.chat.messages.filter(message => message.role === 'user').map(message => message.text), ['a'])
  assert.ok(h.chat.rollbackUndo?.foreground?.algebraBranchId, 'the step back is undoable')
  assert.equal(hasBookkeeping(h), false)
}))

test('a compaction summary on the surface keeps the Chat-only rollback refused', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a'); await h.play('b')
  const inputB = h.events.find(event => event.data?.id === 'input-3').seq
  const nodes = h.session.surface.nodes
  const summary = h.session.append('user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '摘要' }], source: { kind: 'compact-checkpoint' } }, { surfaceOp: 'append' })
  h.selectNodes([...nodes.slice(0, nodes.indexOf(inputB)), typeof summary === 'number' ? summary : summary.seq])
  assert.equal(h.availability().canRollback, false)
  await assert.rejects(h.rollback(), /不在可回退的消息流中/)
}))

test('re-editing a body whose earlier edit lost tavernStoryTurn stamps the floor\'s real story turn', () => withHostPatch(async () => {
  const { storyEventTurn } = await import('../../lib/domain/story-turn.js')
  const h = createPlayHarness()
  await h.play('a'); await h.play('b')                // floor turn 3
  await h.editBody('一改')
  h.stripStoryTurns()                                  // the edit row only knows its edit step's turn (4)
  const stripped = h.fold.rows.findLast(row => row.type === 'assistant/message')
  assert.equal(storyEventTurn(stripped), 4)
  await h.editBody('二改')
  const edited = h.fold.rows.findLast(row => row.type === 'assistant/message')
  assert.equal(edited.data.message.content[0].text, '二改')
  assert.equal(storyEventTurn(edited), 3, 'the replaced chain leads back to the reply of story turn 3')
}))

test('rollback anchors on a node that an edit on another line once shadowed', () => withHostPatch(async () => {
  // The edit R of body X lives on the line that was switched away from; coming
  // back selects X again. The checkout anchor X is live, so it is the anchor:
  // following the replacement chain would leave the surface.
  const h = createPlayHarness()
  await h.play('a')
  await h.regenerate()          // floor 2 now has two variants
  await h.switchVariant(0)      // 正文2 live
  await h.editBody('另一条线上的编辑')
  await h.switchVariant(1)      // away from the edit...
  await h.switchVariant(0)      // ...and back to the unedited 正文2
  assert.equal(h.surfaceBodies().at(-1), '正文2')
  await h.play('c')
  await h.rollback()
  assert.deepEqual(h.surfaceInputs(), ['a'])
  assert.equal(h.surfaceBodies().at(-1), '正文2')
}))
