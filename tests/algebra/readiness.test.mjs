import assert from 'node:assert/strict'
import test from 'node:test'
import { createConversationReadiness, hasPendingConversationTransaction } from '../../tavern-plugin/lib/domain/conversation-algebra-readiness.js'

test('clean cold session is observed and disposed without Agent activation',async()=>{
  let disposed=0,resumed=0
  const gate=createConversationReadiness({getSession:()=>null,observe:async()=>({events:[],[Symbol.dispose](){disposed++}}),resume:async()=>{resumed++;throw new Error('unexpected')},flush:async()=>{}})
  await gate.ready('s')
  assert.equal(disposed,1)
  assert.equal(resumed,0)
})

test('cold observation failure propagates instead of releasing a view',async()=>{
  const gate=createConversationReadiness({getSession:()=>null,observe:async()=>{throw new Error('unreadable')},resume:async()=>{},flush:async()=>{}})
  await assert.rejects(gate.ready('s'),/unreadable/)
})

test('pending detection requires a matching operation commit',()=>{
  const row=(operationId,phase)=>({type:'user/message',data:{source:{conversationTransaction:{operationId,phase}}}})
  assert.equal(hasPendingConversationTransaction([row('a','begin'),row('b','commit')]),true)
  assert.equal(hasPendingConversationTransaction([row('a','begin'),row('a','commit')]),false)
})
