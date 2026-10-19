import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createConversationAlgebraHostAdapter } from '../../lib/domain/conversation-algebra-host-adapter.js'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import { appendStep, branch, checkout, committedMetadata, computeFold, runTransaction, recoverTransaction } from '../../lib/domain/conversation-algebra/index.js'
import { user } from './helpers.mjs'

test('detached host round trip preserves intent and recovers an interrupted batch', async () => {
  const session = Session.create('algebra-detached-recovery')
  const base = createConversationAlgebraHostAdapter(session, { flush: async () => {} })
  let calls = 0
  const adapter = { ...base, append(...args) {
    if (calls++ === 1) throw new Error('interrupted')
    return base.append(...args)
  } }
  const ops = ['a', 'b'].flatMap(id => appendStep({}, { rows: [user(id,id)] }))
  await assert.rejects(runTransaction(adapter, {expectedHead:-1,operationId:'host-recovery',ops}), /interrupted/)
  const restored = Session.fromRestore(session.id, structuredClone(session.snapshotEvents()), structuredClone(session.header), session.inheritedEventCount, 'detached')
  const recovery = createConversationAlgebraHostAdapter(restored, { flush: async () => {} })
  const result = await recoverTransaction(recovery)
  assert.deepEqual(result.rows.map(event => event.data.id), ['a','b'])
  assert.deepEqual(result.surfaceNodes, restored.surface.nodes)
  const count = restored.snapshotEvents().length
  await recoverTransaction(recovery)
  assert.equal(restored.snapshotEvents().length, count)
})

test('host rejects an invalid replacement during preflight with zero live writes', async () => {
  const session = Session.create('algebra-detached-preflight')
  const adapter = createConversationAlgebraHostAdapter(session, { flush: async () => {} })
  const invalid = { kind:'surface-write', event:user('edit','text'), intent:{ surfaceOp:{op:'replace',start:100,end:100},sourceEventSeqs:[100] } }
  await assert.rejects(runTransaction(adapter, {expectedHead:-1,operationId:'invalid',ops:[invalid]}))
  assert.equal(session.snapshotEvents().length, 0)
  assert.equal(computeFold(session.snapshotEvents()).rows.length, 0)
})

test('real host checkout shortens a prefix and returns to the archived branch', async () => {
  const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
  try {
  const session = Session.create('algebra-checkout')
  for (const id of ['a','b','c']) session.append('user/message', user(id,id).data, {surfaceOp:'append'})
  const adapter = createConversationAlgebraHostAdapter(session, {flush:async()=>{}})
  await runTransaction(adapter,{expectedHead:2,operationId:'save',ops:branch(computeFold(session.snapshotEvents()),'original')})
  let state = computeFold(session.snapshotEvents())
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'rewind',ops:checkout(state,0)})
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>row.data.id),['a'])
  const metadata = committedMetadata(session.snapshotEvents())
  state = {...computeFold(session.snapshotEvents()),branchRegistry:metadata}
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'return',ops:checkout(state,metadata.branches[0].branchId)})
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>row.data.id),['a','b','c'])
  assert.deepEqual([...session.surface.nodes],[0,1,2])
  assert.equal(session.snapshotEvents().filter(event=>event.surfaceOp!==undefined).length,3,'checkouts add no message rows')
  } finally { patch.dispose() }
})

test('checkout crash before its selection lands leaves the log unchanged', async () => {
  const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
  try {
  const session = Session.create('algebra-checkout-cut')
  for (const id of ['a','b']) session.append('user/message',user(id,id).data,{surfaceOp:'append'})
  const base=createConversationAlgebraHostAdapter(session,{flush:async()=>{}})
  const interrupted={...base,append(){throw new Error('crash')}}
  await assert.rejects(runTransaction(interrupted,{expectedHead:1,operationId:'cut',ops:checkout(computeFold(session.snapshotEvents()),0)}),/crash/)
  assert.equal(session.snapshotEvents().length,2)
  const restored=Session.fromRestore(session.id,structuredClone(session.snapshotEvents()),structuredClone(session.header),session.inheritedEventCount,'detached')
  const adapter=createConversationAlgebraHostAdapter(restored,{flush:async()=>{}})
  const reopened=restored.snapshotEvents().length
  await recoverTransaction(adapter)
  assert.equal(restored.snapshotEvents().length,reopened)
  const state=computeFold(restored.snapshotEvents())
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'cut',ops:checkout(state,0)})
  assert.deepEqual(computeFold(restored.snapshotEvents()).rows.map(row=>row.data.id),['a'])
  assert.equal(committedMetadata(restored.snapshotEvents()).activeHeadSeq,0)
  assert.equal(restored.snapshotEvents().length,reopened+1)
  } finally { patch.dispose() }
})

test('an unpatched host refuses a selection before writing', async () => {
  const session = Session.create('algebra-select-unpatched')
  for (const id of ['a','b']) session.append('user/message',user(id,id).data,{surfaceOp:'append'})
  const adapter=createConversationAlgebraHostAdapter(session,{flush:async()=>{}})
  await assert.rejects(runTransaction(adapter,{expectedHead:1,operationId:'unpatched',ops:checkout(computeFold(session.snapshotEvents()),0)}),/补丁未生效/)
  assert.equal(session.snapshotEvents().length,2)
})
