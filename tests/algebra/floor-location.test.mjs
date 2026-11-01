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

test('a reroll interrupted before its settlement does not strand the Chat when its nodes have left the surface', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a')
  h.crashBefore('foreground.regen-projected')
  // edited input: the commit phase is saved, then the process dies before the
  // input rewrite and the retirement of the attempt's input row are settled
  await assert.rejects(h.regenerate('', '改写的输入'), /simulated crash/)
  assert.equal(h.chat.regenInProgress, true)
  assert.equal(h.chat.regenRecovery.phase, 'committed')
  // meanwhile the player switches to the saved variant: those nodes leave the surface
  await h.switchVariant(0)
  assert.equal(h.surfaceBodies().at(-1), '正文2')
  // the next operation recovers first; recovery must complete, not throw
  const rolled = await h.rollback()
  assert.equal(rolled.rolledBack.removedUserText, '改写的输入', 'the Chat committed the edited input')
  assert.equal(Boolean(h.chat.regenInProgress), false)
  assert.equal(h.chat.regenRecovery, undefined)
  assert.deepEqual(h.surfaceInputs(), [])
}))

test('editing the body first finishes an unsettled reroll instead of asking the player to wait', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a')
  h.crashBefore('foreground.regen-projected')
  await assert.rejects(h.regenerate(), /simulated crash/)
  assert.equal(h.chat.regenInProgress, true)
  h.chat = { ...h.chat, settleStatus: 'done' }   // the settlement queue is not what this test is about
  await h.editBody('接着改')
  assert.equal(h.chat.regenRecovery, undefined)
  assert.equal(h.surfaceBodies().at(-1), '接着改')
}))

test('refusals that remain carry structural evidence in the diagnostics store', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a'); await h.play('b')
  const nodes = h.session.surface.nodes
  const inputB = h.events.find(event => event.data?.id === 'input-3').seq
  const summary = h.session.append('user/message', { id: 'summary', role: 'user', content: [{ type: 'text', text: '摘要' }], source: { kind: 'compact-checkpoint' } }, { surfaceOp: 'append' })
  h.selectNodes([...nodes.slice(0, nodes.indexOf(inputB)), typeof summary === 'number' ? summary : summary.seq])
  await assert.rejects(h.rollback(), /不在可回退的消息流中/)
  await assert.rejects(h.editBody('改'), /已不在当前上下文中/)
  await assert.rejects(h.regenerate(), /找不到与当前剧情轮次对应的正文/)
  const stages = h.diagnosticRecords.map(record => [record.stage, record.reason])
  assert.deepEqual(stages, [['rollback-target', 'compaction-boundary'], ['body-edit-target', 'floor-body-not-on-surface'], ['regeneration-target', 'native-target-missing']])
  assert.doesNotMatch(JSON.stringify(h.diagnosticRecords), /正文2|正文3|摘要/, 'structure only, never text')
}))

for (const operation of ['rollback', 'regenerate', 'edit']) {
  test(`a reroll whose pre-checkout never reached the log is dropped, not retried, before ${operation}`, () => withHostPatch(async () => {
    const h = createPlayHarness()
    await h.play('a'); await h.play('b')
    h.crashBefore('conversation-algebra.history-recover')   // the checkout intent is durable, the selection never landed
    await assert.rejects(h.regenerate(), /simulated crash/)
    assert.ok(h.chat.conversationHistoryIntent)
    h.chat = { ...h.chat, settleStatus: 'done' }
    const nodes = [...h.session.surface.nodes]
    if (operation === 'rollback') { await h.rollback(); assert.deepEqual(h.surfaceInputs(), ['a']) }
    if (operation === 'regenerate') { await h.regenerate(); assert.deepEqual(h.surfaceInputs(), ['a', 'b']); assert.equal(h.surfaceBodies().at(-1), '正文4') }
    if (operation === 'edit') { await h.editBody('x'); assert.equal(h.surfaceBodies().at(-1), 'x'); assert.deepEqual([...h.session.surface.nodes].slice(0, nodes.length - 1), nodes.slice(0, -1)) }
    assert.equal(Boolean(h.chat.regenInProgress), false)
    assert.equal(h.chat.regenRecovery, undefined)
    assert.equal(h.chat.conversationHistoryIntent, undefined, 'the abandoned pre-checkout cannot land later')
  }))
}

test('a log that lost its unflushed tail does not strand the reroll recovery point', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a')
  h.crashBefore('conversation-algebra.history-recover')
  await assert.rejects(h.regenerate(), /simulated crash/)
  const start = h.chat.regenRecovery.eventStart
  h.rewriteLog(events => events.slice(0, -2))             // step/end and turn/end never reached the disk
  assert.ok(h.events.length < start)
  h.chat = { ...h.chat, settleStatus: 'done' }
  await h.rollback()
  assert.equal(Boolean(h.chat.regenInProgress), false)
  assert.equal(h.chat.regenRecovery, undefined)
}))

test('a torn two-write settlement is finished from its saved plan before the rollback that follows', () => withHostPatch(async () => {
  const h = createPlayHarness()
  await h.play('a')
  h.tearNextTransaction()                              // regen-complete: input rewrite written, retirement not
  await assert.rejects(h.regenerate('', '改写'), /simulated crash after the first write/)
  const phases = h.events.map(event => (event.data?.message ?? event.data)?.source?.conversationTransaction?.phase).filter(Boolean)
  assert.equal(phases.at(-1), 'begin', 'the log ends in a begin without its commit')
  h.chat = { ...h.chat, settleStatus: 'done' }
  await h.rollback()
  assert.deepEqual(h.surfaceInputs(), [])
  assert.equal(Boolean(h.chat.regenInProgress), false)
  const tail = h.events.map(event => (event.data?.message ?? event.data)?.source?.conversationTransaction).filter(Boolean).filter(tag => tag.operationId.startsWith('regen-complete:'))
  assert.deepEqual(tail.map(tag => tag.phase), ['begin', 'commit'])
}))

test('开局正文在第一条用户输入之前和别的助手层一样可编辑', () => withHostPatch(async () => {
  const h = createPlayHarness()
  assert.deepEqual(h.surfaceBodies(), ['开场'])
  const before = structuredClone(h.events)
  await h.editBody('改过的开场')
  assert.deepEqual(h.surfaceBodies(), ['改过的开场'])
  assert.equal(h.chat.messages[0].text, '改过的开场')
  assert.equal(h.chat.messages[0].greeting, true, '仍是开场消息')
  assert.deepEqual(h.events.slice(0, before.length), before, '只追加编辑步骤，不改旧事件')
  assert.equal(hasBookkeeping(h), false)
  await h.editBody('再改一次')
  assert.deepEqual(h.surfaceBodies(), ['再改一次'])
  // 开始对话后，编辑入口改的是最后一轮，开场保持不动。
  await h.play('开始')
  await h.editBody('第一轮改过')
  assert.deepEqual(h.surfaceBodies(), ['再改一次', '第一轮改过'])
  assert.equal(h.chat.messages[0].text, '再改一次')
  // 回退这一轮后又回到只剩开场：改过的开场保留，且还能再改。
  await h.rollback()
  assert.deepEqual(h.surfaceBodies(), ['再改一次'])
  await h.editBody('回退后再改')
  assert.deepEqual(h.surfaceBodies(), ['回退后再改'])
}))
