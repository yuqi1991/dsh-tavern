import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createConversationAlgebraHostAdapter } from '../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'
import { appendStep, branch, checkout, computeFold, runTransaction, recoverTransaction } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
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
  const session = Session.create('algebra-checkout')
  for (const id of ['a','b','c']) session.append('user/message', user(id,id).data, {surfaceOp:'append'})
  let metadata
  const adapter = createConversationAlgebraHostAdapter(session, {flush:async()=>{},write:async value=>{metadata=value}})
  await runTransaction(adapter,{expectedHead:2,operationId:'save',ops:branch(computeFold(session.snapshotEvents()),'original')})
  let state = computeFold(session.snapshotEvents())
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'rewind',ops:checkout(state,0)})
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>row.data.id),['a'])
  state = {...computeFold(session.snapshotEvents()),branchRegistry:metadata}
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'return',ops:checkout(state,metadata.branches[0].branchId)})
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>row.data.id),['a','b','c'])
})

test('metadata publication failure recovers from committed log after restart', async () => {
  const session = Session.create('algebra-metadata')
  const adapter = createConversationAlgebraHostAdapter(session,{flush:async()=>{},write:async()=>{throw new Error('metadata offline')}})
  await assert.rejects(runTransaction(adapter,{expectedHead:-1,operationId:'branch',ops:branch(computeFold([]),'saved')}), /metadata offline/)
  const restored = Session.fromRestore(session.id,structuredClone(session.snapshotEvents()),structuredClone(session.header),session.inheritedEventCount,'detached')
  let metadata
  await recoverTransaction(createConversationAlgebraHostAdapter(restored,{flush:async()=>{},write:async value=>{metadata=value}}))
  assert.equal(metadata.branches[0].label,'saved')
})

test('checkout crash after clearing suffix recovers metadata and content once', async () => {
  const session = Session.create('algebra-checkout-cut')
  for (const id of ['a','b']) session.append('user/message',user(id,id).data,{surfaceOp:'append'})
  const base=createConversationAlgebraHostAdapter(session,{flush:async()=>{},write:async()=>{}})
  let calls=0
  const interrupted={...base,append(...args){if(calls++===1)throw new Error('crash');return base.append(...args)}}
  await assert.rejects(runTransaction(interrupted,{expectedHead:1,operationId:'cut',ops:checkout(computeFold(session.snapshotEvents()),0)}),/crash/)
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>row.data.id),['a','b'])
  const restored=Session.fromRestore(session.id,structuredClone(session.snapshotEvents()),structuredClone(session.header),session.inheritedEventCount,'detached')
  let metadata
  const adapter=createConversationAlgebraHostAdapter(restored,{flush:async()=>{},write:async value=>{metadata=value}})
  await recoverTransaction(adapter)
  assert.deepEqual(computeFold(restored.snapshotEvents()).rows.map(row=>row.data.id),['a'])
  assert.equal(metadata.activeHeadSeq,0)
  const count=restored.snapshotEvents().length
  await recoverTransaction(adapter)
  assert.equal(restored.snapshotEvents().length,count)
})
