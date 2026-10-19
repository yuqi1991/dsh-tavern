import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { createConversationHistory } from '../tavern-plugin/lib/domain/conversation-algebra-history.js'
import { createRegenerationRecovery } from '../tavern-plugin/lib/domain/regeneration-recovery.js'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'

const replaceSessionSurface = (session, type, data, range) => createSessionSurfaceMutator(session).replace(type, data, range)
const algebraHistory = (chats, flush) => ({ ...createConversationHistory({ chats, flush }), assertReady: () => {} })

function fixture({ ended = true } = {}) {
 const session=Session.create('regen-safety')
 const user=(id,source={kind:'user'},content=[{type:'text',text:id}])=>appendSessionEvent(session,'user/message',{id,role:'user',content,source},{surfaceOp:'append'})
 user('original-input')
 const frame=user('frame',{kind:'plugin',plugin:'dsh-tavern',form:'foreground-frame'})
 const body=appendSessionEvent(session,'assistant/message',{turn:1,step:1,message:{id:'body',role:'assistant',content:[{type:'text',text:'original-body'}],source:{kind:'model',provider:'fixture',model:'fixture'}}},{surfaceOp:'append'})
 const eventStart=sessionEvents(session).length
 appendSessionEvent(session,'turn/start',{turn:2})
 const retired=replaceSessionSurface(session,'user/message',{id:'retired',role:'user',content:[],source:{kind:'plugin',plugin:'dsh-tavern',form:'foreground-frame'}},{start:frame.seq,end:frame.seq,sourceEventSeqs:[frame.seq]})
 const attempt=user('attempt',{kind:'plugin',plugin:'dsh-tavern-regen'})
 if (ended) appendSessionEvent(session,'turn/end',{turn:2,reason:{kind:'error',error:{message:'Provider stopped with: SAFETY'}}})
 const cleaned=replaceSessionSurface(session,'user/message',{id:'failed',role:'user',content:[],source:{kind:'plugin',plugin:'dsh-tavern-failed-turn-cleanup'}},{start:attempt.seq,end:attempt.seq,sourceEventSeqs:[attempt.seq]})
 return {session,eventStart,body,retired,cleaned,user}
}
test('abort serializes native cleanup with chat restoration and competing writers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'regen-safety-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const chats=createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 const before=await chats.write({id:'chat',messages:[{role:'user',text:'input'},{role:'assistant',text:'original-body'}]})
 await chats.update('chat',c=>({...c,regenInProgress:true,regenRecovery:{id:'op'},messages:[]}))
 const f=fixture(); let concurrent
 const flush=async()=>{
  concurrent=chats.update('chat',c=>({...c,observation:'new'}))
  await new Promise(resolve=>setTimeout(resolve,10))
 }
 const recovery=createRegenerationRecovery({chats,timeline:createStoryTimeline(),isActive:()=>false,sessions:{flush},algebraHistory:algebraHistory(chats,flush)})
 await recovery.abort({chatId:'chat',originalChat:before,session:f.session,eventStart:f.eventStart,operationId:'op'})
 await concurrent
 const after=await chats.read('chat')
 assert.equal(after.regenInProgress,undefined)
 assert.equal(after.messages.at(-1).text,'original-body')
 assert.equal(after.observation,'new')
})

test('failed native flush keeps recovery point and retry restores the original story',async t=>{
 const root=await mkdtemp(join(tmpdir(),'regen-flush-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const chats=createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 const before=await chats.write({id:'chat',messages:[{role:'user',text:'input'},{role:'assistant',text:'original-body'}]})
 await chats.update('chat',c=>({...c,regenInProgress:true,regenRecovery:{id:'op'},messages:[]}))
 const f=fixture(); let fail=true
 const flush=async()=>{if(fail)throw Error('flush failed')}
 const recovery=createRegenerationRecovery({chats,timeline:createStoryTimeline(),isActive:()=>false,sessions:{flush},algebraHistory:algebraHistory(chats,flush)})
 const input={chatId:'chat',originalChat:before,session:f.session,eventStart:f.eventStart,operationId:'op'}
 await assert.rejects(recovery.abort(input),/flush failed/)
 assert.equal((await chats.read('chat')).regenInProgress,true)
 fail=false
 await recovery.abort(input)
 assert.equal((await chats.read('chat')).regenInProgress,undefined)
 assert.ok(f.session.surface.nodes.includes(f.body.seq))
})

test('stale recovery refuses to overwrite a later normal input before mutating either store',async t=>{
 const root=await mkdtemp(join(tmpdir(),'regen-later-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const chats=createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 const before=await chats.write({id:'chat',messages:[{role:'user',text:'input'},{role:'assistant',text:'original-body'}]})
 await chats.update('chat',c=>({...c,regenInProgress:true,regenRecovery:{id:'op'},messages:[{role:'user',text:'later'}]}))
 const f=fixture();f.user('later');const nodes=[...f.session.surface.nodes];const saved=await chats.read('chat')
 const recovery=createRegenerationRecovery({chats,timeline:createStoryTimeline(),isActive:()=>false,sessions:{},algebraHistory:algebraHistory(chats,async()=>{})})
 await assert.rejects(recovery.abort({chatId:'chat',originalChat:before,session:f.session,eventStart:f.eventStart,operationId:'op'}),/已有新的玩家输入/)
 assert.deepEqual(f.session.surface.nodes,nodes)
 assert.deepEqual(await chats.read('chat'),saved)
})
