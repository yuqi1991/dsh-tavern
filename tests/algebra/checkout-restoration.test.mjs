import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import {prepareExpandedPatch} from '../../tavern-plugin/lib/domain/host-session-patch.js'
import {createConversationAlgebraHostAdapter} from '../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'
import {branch,checkout,computeFold,runTransaction,recoverTransaction} from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import {user,assistant,toolResult} from './helpers.mjs'

for (const cut of [1,2,3,4,5,6,7]) test('restoration preserves transcript and recovers cut '+cut,async()=>{
 const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
 try {
  const s=Session.create('restore-tool-step');let metadata
  const rows=[user('prefix','prefix'),user('player','input'),assistant('call',[{type:'tool-call',id:'c',name:'skill',arguments:'{}'}],1),toolResult('tool','c',1),assistant('body','body',1,2)]
  for(const row of rows)s.append(row.type,row.data,{surfaceOp:'append'})
  const base=createConversationAlgebraHostAdapter(s,{flush:async()=>{},write:async v=>{metadata=v}})
  let state=computeFold(s.snapshotEvents()),saved=branch(state,'original')
  await runTransaction(base,{expectedHead:state.headSeq,operationId:'rewind',ops:[...saved,...checkout(state,0)]})
  state={...computeFold(s.snapshotEvents()),branchRegistry:metadata};let n=0
  const interrupted={...base,append(...args){if(n++===cut)throw new Error('cut');return base.append(...args)}}
  await assert.rejects(runTransaction(interrupted,{expectedHead:state.headSeq,operationId:'return',ops:checkout(state,saved[0].branch.branchId)}),/cut/)
  const restored=Session.fromRestore(s.id,structuredClone(s.snapshotEvents()),structuredClone(s.header),s.inheritedEventCount,'detached')
  const resumed=createConversationAlgebraHostAdapter(restored,{flush:async()=>{},write:async v=>{metadata=v}})
  let recoveryWrites=0
  if(cut<7) {
    await assert.rejects(recoverTransaction({...resumed,append(...args){if(recoveryWrites++===1)throw new Error('second cut');return resumed.append(...args)}}),/second cut/)
  }
  await recoverTransaction(createConversationAlgebraHostAdapter(restored,{flush:async()=>{},write:async v=>{metadata=v}}))
  const fold=computeFold(restored.snapshotEvents())
  assert.deepEqual(fold.rows.map(r=>(r.data.message??r.data).id),['prefix','player','call','tool','body'])
  assert.equal(restored.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id==='player'&&e.surfaceOp==='append').length,1)
 }finally{patch.dispose()}
})
