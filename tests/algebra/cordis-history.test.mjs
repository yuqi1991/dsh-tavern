import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/cordis/lib/index.js'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { SessionHistoryController } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/history.js'
import { installConversationHistoryGate } from '../../tavern-plugin/lib/domain/conversation-algebra-isolation.js'
import { createConversationReadiness } from '../../tavern-plugin/lib/domain/conversation-algebra-readiness.js'
import { createConversationAlgebraHostAdapter } from '../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'
import { appendStep, runTransaction } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { user } from './helpers.mjs'

test('actual Cordis history follows no partial transaction before durable flush',async()=>{
  const ctx=new Context()
  const session=Session.create('history-assembled',undefined,{...Session.create('history-assembled').header,cwd:'/tmp'})
  let release
  const barrier=new Promise(resolve=>{release=resolve})
  let flushing=false, observations=0
  const query={async observeSession(){observations++;return {header:session.header,events:session.snapshotEvents(),cursor:session.seq-1,inheritedEventCount:0,source:'live',[Symbol.dispose](){}}}}
  ctx.provide('sessionQuery',query)
  const history=new SessionHistoryController(ctx,()=>{})
  const readiness=createConversationReadiness({getSession:()=>session,observe:id=>query.observeSession(id),resume:async()=>{throw new Error('not cold')},flush:async()=>{flushing=true;await barrier}})
  const dispose=installConversationHistoryGate(history,()=>readiness.ready(session.id))
  const abort=new AbortController()
  const request={address:{kind:'session',sessionId:session.id},assistantStream:true,conversationAlgebra:1}
  const follow=history.follow(request,abort.signal)
  assert.equal((await follow.next()).value.type,'snapshot')
  let published=false
  const next=follow.next().then(result=>{published=true;return result})
  const base=createConversationAlgebraHostAdapter(session,{flush:async()=>{flushing=true;await barrier}})
  const adapter={...base,append(...args){const event=base.append(...args);ctx.emit('session/event',session,event);return event}}
  const ops=['a','b'].flatMap(id=>appendStep({}, {rows:[user(id,id)]}))
  const transaction=runTransaction(adapter,{expectedHead:-1,operationId:'history',ops})
  while(!flushing)await new Promise(resolve=>setImmediate(resolve))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(published,false)
  release()
  await transaction
  assert.equal((await next).value.event.data.id,'a')
  assert.equal((await follow.next()).value.event.data.id,'b')
  const page=await history.page({...request,throughSeq:session.seq-1},abort.signal)
  assert.equal(page.records.length,2)
  assert.ok(observations>=2)
  abort.abort()
  await follow.return()
  dispose()
  assert.equal(history.closeFollowers.size,0)
})
