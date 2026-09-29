import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import {createConversationHistory} from '../../tavern-plugin/lib/domain/conversation-algebra-history.js'
import {user} from './helpers.mjs'
for(const fail of ['before-native','after-native'])test('durable history intent recovers '+fail,async()=>{
 let session=Session.create('history-intent');for(const id of ['a','b'])session.append('user/message',user(id,id).data,{surfaceOp:'append'})
 let chat={id:'chat'},broken=false
 const api=createConversationHistory({flush:async()=>{if(broken)throw new Error('flush failed')},chats:{update:async(id,work)=>{const next=await work(structuredClone(chat));if(next)chat=next;return structuredClone(chat)}}})
 const transaction=await api.prepare(session,chat,0)
 chat.conversationHistoryIntent={sessionId:session.id,transaction}
 if(fail==='after-native'){broken=true;await assert.rejects(api.recover(session,chat.id),/flush failed/);broken=false}
 session=Session.fromRestore(session.id,structuredClone(session.snapshotEvents()),structuredClone(session.header),session.inheritedEventCount,'detached')
 await api.recover(session,chat.id)
 assert.equal(chat.conversationHistoryIntent,undefined);assert.equal(chat.branchRegistry.branches.length,1)
 const count=session.snapshotEvents().length;await api.recover(session,chat.id);assert.equal(session.snapshotEvents().length,count)
})

test('cold history barrier recovers a durable intent even before its first Session write',async()=>{
 const {createConversationReadiness}=await import('../../tavern-plugin/lib/domain/conversation-algebra-readiness.js')
 const s=Session.create('cold-history-intent');for(const id of ['a','b'])s.append('user/message',user(id,id).data,{surfaceOp:'append'})
 let chat={id:'chat'},released=0
 const api=createConversationHistory({flush:async()=>{},chats:{update:async(id,work)=>{chat=await work(structuredClone(chat))??chat;return structuredClone(chat)}}})
 chat.conversationHistoryIntent={sessionId:s.id,transaction:await api.prepare(s,chat,0)}
 const gate=createConversationReadiness({getSession:()=>null,observe:async()=>({events:s.snapshotEvents(),[Symbol.dispose](){}}),resume:async()=>({agent:{session:s},dispose:async()=>{released++}}),flush:async()=>{},hasHistoryIntent:async()=>!!chat.conversationHistoryIntent,recoverHistory:session=>api.recover(session,chat.id),writeRegistry:async(id,value)=>{chat.branchRegistry=value}})
 await gate.ready(s.id)
 assert.equal(chat.conversationHistoryIntent,undefined);assert.equal(released,1);assert.equal(chat.branchRegistry.branches.length,1)
})
