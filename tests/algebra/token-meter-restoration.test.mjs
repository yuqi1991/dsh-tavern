import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import {TokenMeter} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js'
import {prepareExpandedPatch} from '../../lib/domain/host-session-patch.js'
import {installTavernTokenMeter} from '../../lib/domain/tavern-token-meter.js'
import {createConversationAlgebraHostAdapter} from '../../lib/domain/conversation-algebra-host-adapter.js'
import {branch,checkout,committedMetadata,computeFold,runTransaction} from '../../lib/domain/conversation-algebra/index.js'
import {user,assistant} from './helpers.mjs'

const usage = {inputTokens: 100, outputTokens: 20}

function playedSession(id) {
  const s = Session.create(id)
  s.append('agent-preset/selected', {agentPreset: 'tavern'})
  s.append('user/message', user('prefix', 'prefix').data, {surfaceOp: 'append'})
  s.append('user/message', user('player', 'input').data, {surfaceOp: 'append'})
  s.append('step/start', {turn: 1, step: 1})
  const reply = assistant('body', 'body', 1, 1, {kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash'})
  s.append('assistant/message', {...reply.data, usage}, {surfaceOp: 'append'})
  s.append('step/end', {turn: 1, step: 1})
  return s
}

function meterFor() {
  // The host constructor wires projections and events; replay needs only state.
  const meter = Object.create(TokenMeter.prototype)
  meter.states = new WeakMap()
  return {meter, dispose: installTavernTokenMeter(meter)}
}

async function leaveAndReturn(s) {
  const adapter = createConversationAlgebraHostAdapter(s, {flush: async () => {}})
  let state = computeFold(s.snapshotEvents())
  const saved = branch(state, 'original')
  await runTransaction(adapter, {expectedHead: state.headSeq, operationId: 'leave', ops: [...saved, ...checkout(state, s.snapshotEvents().find(e => e.data?.id === 'player').seq)]})
  state = {...computeFold(s.snapshotEvents()), branchRegistry: committedMetadata(s.snapshotEvents())}
  await runTransaction(adapter, {expectedHead: state.headSeq, operationId: 'return', ops: checkout(state, saved[0].branch.branchId)})
}

test('token meter accepts a legacy transaction-stamped restored model reply', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', {version: '0.1.5-rc.2'})
  const {meter, dispose} = meterFor()
  try {
    // Logs written before ADR-0009 restored a branch by copying each reply
    // verbatim, stamped with its transaction tag.
    const s = playedSession('meter-legacy-restore')
    const bodySeq = s.snapshotEvents().find(e => e.type === 'assistant/message').seq
    const copy = structuredClone(s.eventAt(bodySeq).data)
    copy.message.source = {...copy.message.source, conversationTransaction: {operationId: 'legacy', phase: 'begin-commit'}}
    // An empty placeholder displaced the reply; the copy then replaced the
    // placeholder, citing it and the archived original.
    s.append('user/message', {id: 'placeholder', role: 'user', content: [], source: {kind: 'plugin', plugin: 'dsh-tavern', form: 'surface-restore'}},
      {surfaceOp: {op: 'replace', startSeq: bodySeq, endSeq: bodySeq}, sourceEventSeqs: [bodySeq]})
    const placeholder = s.seq - 1
    s.append('assistant/message', copy, {surfaceOp: {op: 'replace', startSeq: placeholder, endSeq: placeholder}, sourceEventSeqs: [placeholder, bodySeq]})
    assert.ok(copy.usage, 'restoration keeps provider usage')
    assert.doesNotThrow(() => meter._sync(s))
  } finally { dispose(); patch.dispose() }
})

test('token meter follows a leave-and-return checkout by selection', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', {version: '0.1.5-rc.2'})
  const {meter, dispose} = meterFor()
  try {
    const s = playedSession('meter-restore')
    const nodes = [...s.surface.nodes]
    await leaveAndReturn(s)
    assert.deepEqual([...s.surface.nodes], nodes)
    assert.equal(s.snapshotEvents().filter(e => e.type === 'assistant/message' && typeof e.surfaceOp === 'object').length, 0)
    assert.deepEqual(meter._sync(s).surface.map(node => node.seq), nodes)
  } finally { dispose(); patch.dispose() }
})

test('token meter accepts in-place edits and tombstones that keep provider usage', async () => {
  const patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', {version: '0.1.5-rc.2'})
  try {
    // editStep (same id, new content) and dropTagged tombstones (tombstone id,
    // empty content and stream) replace a model reply with itself, carrying
    // every other field, provider usage included.
    const rewritten = (change, refs) => {
      const s = playedSession('meter-in-place')
      const body = s.snapshotEvents().find(e => e.type === 'assistant/message')
      const data = structuredClone(s.eventAt(body.seq).data)
      change(data, body.seq)
      data.message.source = {...data.message.source, conversationTransaction: {operationId: 'retire:test', phase: 'continue'}}
      s.append('assistant/message', data, {surfaceOp: {op: 'replace', startSeq: body.seq, endSeq: body.seq}, sourceEventSeqs: refs ? refs(body.seq) : [body.seq]})
      return s
    }
    const check = (name, run) => { const {meter, dispose} = meterFor(); try { run(meter) } finally { dispose() } }
    check('edit', meter => assert.doesNotThrow(() => meter._sync(rewritten(data => { data.message.content = [{type: 'text', text: 'edited'}] }))))
    check('tombstone', meter => assert.doesNotThrow(() => meter._sync(rewritten((data, seq) => {
      data.stream = []; data.message.id = 'conversation-tombstone:retire:' + seq; data.message.content = []
    }))))
    // Usage that differs from the original is not an edit of it.
    check('usage', meter => assert.throws(() => meter._sync(rewritten(data => { data.message.content = []; data.usage = {inputTokens: 1, outputTokens: 1} })), /no matching step\/start/))
    // A new id that is not a tombstone id is not an in-place edit.
    check('id', meter => assert.throws(() => meter._sync(rewritten(data => { data.message.id = 'some-other-reply'; data.message.content = [] })), /no matching step\/start/))
    // Neither is a replacement citing more than the node it replaces.
    check('refs', meter => assert.throws(() => meter._sync(rewritten(data => { data.message.content = [] }, seq => [seq, seq - 1])), /no matching step\/start/))
  } finally { patch.dispose() }
})
