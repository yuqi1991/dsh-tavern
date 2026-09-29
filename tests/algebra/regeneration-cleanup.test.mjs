import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { createRegenerationRecovery } from '../../tavern-plugin/lib/domain/regeneration-recovery.js'
import { createConversationHistory } from '../../tavern-plugin/lib/domain/conversation-algebra-history.js'
import { createConversationBranches } from '../../tavern-plugin/lib/domain/conversation-algebra-branches.js'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { user, assistant } from './helpers.mjs'

function fixture() {
 let session=Session.create('regen-cleanup-algebra'),enabled=true,failChat=false,flushHook=async()=>{}
 for(const row of [user('input','继续'),assistant('old','已编辑旧正文',2)])session.append(row.type,row.data,{surfaceOp:'append'})
 const original={id:'chat',sessionId:session.id,messages:[{role:'user',text:'继续'},{role:'assistant',text:'已编辑旧正文'}],variables:{hp:9}}
 session.append('turn/start',{turn:3})
 session.append('user/message',user('synthetic','重掷',{kind:'plugin',plugin:'dsh-tavern-regen'}).data,{surfaceOp:'append'})
 session.append('assistant/message',assistant('partial','半截',3).data,{surfaceOp:'append'})
 session.append('turn/end',{turn:3,reason:{kind:'aborted'}})
 let chat={...structuredClone(original),regenInProgress:true,regenRecovery:{id:'op',sessionId:session.id,eventStart:2,before:structuredClone(original)}}
 const chats={read:async()=>structuredClone(chat),update:async(id,fn,metadata)=>{
  const next=await fn(structuredClone(chat))
  if(failChat&&metadata.source==='foreground.regen-abort')throw new Error('chat commit cut')
  if(next)chat=structuredClone(next)
  return structuredClone(chat)
 }}
 const flush=async s=>flushHook(s)
 const history={...createConversationHistory({chats,flush}),enabled:()=>enabled}
 const api=()=>createRegenerationRecovery({chats,sessions:{get:()=>({session,phase:{kind:'idle'}}),flush},timeline:{apply:({intent})=>({chat:structuredClone(intent.restoreChat)})},isActive:()=>false,algebraHistory:history})
 return {api,original,get session(){return session},get chat(){return chat},flush,enable:v=>enabled=v,chatCut:v=>failChat=v,setFlush:fn=>flushHook=fn,
  restore(){session=Session.fromRestore(session.id,structuredClone(session.snapshotEvents()),structuredClone(session.header),session.inheritedEventCount,'detached')},
  abort(){return api().abort({chatId:'chat',originalChat:original,session,eventStart:2,operationId:'op'})}}
}

for(const point of ['before-first','after-first','after-commit','flush','chat'])test('production abort recovers '+point+' with writes disabled',async()=>{
 const h=fixture(),append=Session.prototype.append;let n=0,broken=true
 if(point==='flush')h.setFlush(async()=>{if(broken)throw new Error('flush cut')})
 if(point==='chat')h.chatCut(true)
 const counts={'before-first':0,'after-first':1,'after-commit':2}
 Session.prototype.append=function(...args){
  if(this===h.session&&broken&&point in counts&&n++===counts[point])throw new Error('append cut')
  return append.apply(this,args)
 }
 try{
  // Clear+metadata are two writes. after-commit fails the outer flush after
  // both writes, so it tests a committed native transaction + pending Chat.
  if(point==='after-commit')h.setFlush(async()=>{if(broken&&n>=2)throw new Error('commit flush cut')})
  await assert.rejects(h.abort(),/cut/)
 }finally{Session.prototype.append=append}
 assert.ok(h.chat.regenRecovery.abortTransaction)
 broken=false;h.chatCut(false);h.enable(false);h.restore()
 await h.api().recover('chat')
 assert.equal(h.chat.regenInProgress,undefined)
 assert.equal(h.chat.regenRecovery,undefined)
 assert.deepEqual(h.chat.messages,h.original.messages);assert.deepEqual(h.chat.variables,h.original.variables)
 assert.deepEqual(computeFold(h.session.snapshotEvents()).rows.map(row=>(row.data.message??row.data).id),['input','old'])
 assert.equal(h.chat.branchRegistry.branches.length,1)
 const count=h.session.snapshotEvents().length
 await h.api().recover('chat');assert.equal(h.session.snapshotEvents().length,count)
 const branchId=h.chat.branchRegistry.branches[0].branchId
 const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
 try{
  const branches=createConversationBranches(h.session,{flush:h.flush,writeRegistry:async()=>{}})
  await branches.commit(await branches.plan(branchId))
  assert.deepEqual(branches.state().rows.map(row=>(row.data.message??row.data).id),['input','old','synthetic','partial'])
 }finally{patch.dispose()}
})

test('disabled fresh abort keeps compatibility cleanup without branch writes',async()=>{
 const h=fixture();h.enable(false);await h.abort()
 assert.equal(h.chat.branchRegistry,undefined)
 assert.equal(h.session.snapshotEvents().some(e=>e.data?.source?.conversationTransaction),false)
})

test('foreign later player input refuses abort before any writes',async()=>{
 const h=fixture();h.session.append('user/message',user('foreign','后来输入').data,{surfaceOp:'append'})
 const before=structuredClone(h.chat),events=h.session.snapshotEvents()
 await assert.rejects(h.abort(),/新的玩家输入/)
 assert.deepEqual(h.chat,before);assert.deepEqual(h.session.snapshotEvents(),events)
})

test('actual Chat journal and host zstd persistence reopen a partially written abort',async()=>{
 const {mkdtemp}=await import('node:fs/promises')
 const {Context}=await import('/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/cordis/lib/index.js')
 const {default:Persistence}=await import('/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')
 const {createChatPersistence}=await import('../../tavern-plugin/lib/domain/chat-persistence.js')
 const {createChatJournalStore}=await import('../../tavern-plugin/lib/domain/chat-journal-store.js')
 const root=await mkdtemp('/home/claw/dsh-tavern-dev/regen-abort-persistence-'),h=fixture()
 const persistence=new Persistence(new Context(),{root:root+'/sessions',compression:'zstd'})
 let handle=await persistence.create(h.session.header),durable=0,session=h.session
 const flush=async live=>{const events=live.snapshotEvents();await handle.append(events.slice(durable));durable=events.length;await handle.flush()}
 const store=()=>createChatPersistence({store:createChatJournalStore({dataRoot:root+'/chats'})})
 let chats=store();await chats.write(h.chat);await flush(session)
 const api=(enabled)=>createRegenerationRecovery({chats,sessions:{get:()=>({session,phase:{kind:'idle'}}),flush},timeline:{apply:({intent})=>({chat:structuredClone(intent.restoreChat)})},isActive:()=>false,algebraHistory:{...createConversationHistory({chats,flush}),enabled:()=>enabled}})
 const append=Session.prototype.append;let count=0
 try{
  Session.prototype.append=function(...args){if(this===session&&count++===1)throw new Error('persisted cut');return append.apply(this,args)}
  await assert.rejects(api(true).abort({chatId:'chat',session,originalChat:h.original,eventStart:2,operationId:'op'}),/persisted cut/)
 }finally{Session.prototype.append=append}
 try{
  assert.ok((await chats.read('chat')).regenRecovery.abortTransaction)
  await handle.close();handle=await persistence.open(session.id,'write')
  const read=await handle.read();assert.equal(read.events.length,h.session.snapshotEvents().length)
  session=Session.fromRestore(session.id,structuredClone(read.events),structuredClone(handle.header),handle.inheritedEventCount,'detached')
  durable=read.events.length;chats=store()
  await api(false).recover('chat')
  const result=await chats.read('chat')
  assert.equal(result.regenRecovery,undefined);assert.equal(result.branchRegistry.branches.length,1)
  assert.deepEqual(result.messages,h.original.messages)
  await handle.close();handle=await persistence.open(session.id,'read')
  const logged=await handle.read();assert.equal(logged.events.length,session.snapshotEvents().length)
  assert.deepEqual(computeFold(logged.events).rows.map(e=>(e.data.message??e.data).id),['input','old'])
 }finally{await handle.close();await persistence.flush()}
})

test('concurrent read recovery joins ongoing abort until the Chat restoration commits',async()=>{
 const h=fixture(),api=h.api();let release,started
 const barrier=new Promise(r=>{release=r}),enter=new Promise(r=>{started=r})
 h.setFlush(async()=>{started();await barrier})
 const abort=api.abort({chatId:'chat',session:h.session,originalChat:h.original,eventStart:2,operationId:'op'})
 await enter
 let readFinished=false
 const read=api.recover('chat').then(()=>{readFinished=true})
 await new Promise(r=>setImmediate(r));assert.equal(readFinished,false)
 release();await Promise.all([abort,read]);assert.equal(h.chat.regenRecovery,undefined)
})
