import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/cordis/lib/index.js'
import {Session} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import {SessionHistoryController} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/history.js'
import {installConversationHistoryGate} from '../../tavern-plugin/lib/domain/conversation-algebra-isolation.js'
import {user,assistant} from './helpers.mjs'

function fixture(){
 const ctx=new Context(),session=Session.create('opening-tail',undefined,{...Session.create('opening-tail').header,cwd:'/tmp'})
 for(const row of [user('input','player'),assistant('body','current body',1)])session.append(row.type,row.data,{surfaceOp:'append'})
 // Retirement/control placeholders count as messages to the host pager, but
 // never produce a story bubble. Repeated operations exhaust its 50 row budget.
 for(let i=0;i<70;i++)session.append('user/message',user('conversation-metadata:'+i,null,{kind:'plugin',plugin:'dsh-tavern',form:'conversation-metadata',conversationTransaction:{operationId:'o'+i,phase:'begin-commit'}}).data,{surfaceOp:'append'})
 ctx.provide('sessionQuery',{async observeSession(){return {header:session.header,events:session.snapshotEvents(),cursor:session.seq-1,inheritedEventCount:0,source:'live',[Symbol.dispose](){}}}})
 const history=new SessionHistoryController(ctx,()=>{})
 installConversationHistoryGate(history,async()=>{})
 return {history,session}
}
test('first opening includes current story even when latest 50 append messages are empty controls',async()=>{
 const {history}=fixture(),abort=new AbortController()
 const follow=history.follow({address:{kind:'session',sessionId:'opening-tail'},assistantStream:true},abort.signal)
 try{
  const frame=(await follow.next()).value
  assert.equal(frame.type,'snapshot')
  assert.ok(frame.records.some(r=>r.event.type==='assistant/message'&&r.event.data.message.id==='body'),'current body must be available without clicking older history')
  assert.ok(frame.records.some(r=>r.event.type==='user/message'&&r.event.data.id==='input'))
  assert.equal(frame.cursor,71)
  for(let i=1;i<frame.records.length;i++)assert.equal(frame.records[i].event.seq,frame.records[i-1].event.seq+1)
 }finally{abort.abort();await follow.return()}
})

test('opening includes original input behind a restored replacement and retains stream metadata',async()=>{
 const {history,session}=fixture()
 session.append('user/message',user('edited-input','edited player',{kind:'user',conversationTransaction:{operationId:'edit',phase:'begin-commit'}}).data,{surfaceOp:{op:'replace',startSeq:0,endSeq:0},sourceEventSeqs:[0]})
 const abort=new AbortController(),stream=history.follow({address:{kind:'session',sessionId:session.id},maxMessages:2,assistantStream:true},abort.signal)
 try{
  const frame=(await stream.next()).value
  assert.equal(frame.cursor,72)
  assert.equal(frame.hasMore,false)
  assert.ok(frame.assistantStream)
  assert.equal(frame.projections.asOfSeq,72)
  assert.ok(frame.records.some(r=>r.event.data.id==='input'))
  assert.ok(frame.records.some(r=>r.event.data.id==='edited-input'))
  const seqs=frame.records.map(r=>r.event.seq);assert.deepEqual(seqs,Array.from({length:73},(_,i)=>i))
 }finally{abort.abort();await stream.return()}
})

test('opening for unmodified host sessions keeps its original page budget',async()=>{
 const ctx=new Context(),session=Session.create('plain-opening',undefined,{...Session.create('plain-opening').header,cwd:'/tmp'})
 for(let i=0;i<70;i++)session.append('user/message',user('u'+i,'plain '+i).data,{surfaceOp:'append'})
 let released=0
 ctx.provide('sessionQuery',{async observeSession(){return {header:session.header,events:session.snapshotEvents(),cursor:session.seq-1,inheritedEventCount:0,source:'live',[Symbol.dispose](){released++}}}})
 const history=new SessionHistoryController(ctx,()=>{});const dispose=installConversationHistoryGate(history,async()=>{})
 const abort=new AbortController(),stream=history.follow({address:{kind:'session',sessionId:session.id}},abort.signal)
 try{
  const frame=(await stream.next()).value;assert.equal(frame.records.length,50);assert.equal(frame.records[0].event.seq,20);assert.equal(frame.hasMore,true)
 }finally{abort.abort();await stream.return();dispose()}
 assert.ok(released>=2)
 assert.equal(history.closeFollowers.size,0)
})
