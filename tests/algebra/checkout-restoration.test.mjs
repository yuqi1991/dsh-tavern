import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '/home/claw/dsh-stage-021/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import {prepareExpandedPatch} from '../../lib/domain/host-session-patch.js'
import {createConversationAlgebraHostAdapter} from '../../lib/domain/conversation-algebra-host-adapter.js'
import {branch,checkout,committedMetadata,computeFold,runTransaction,recoverTransaction} from '../../lib/domain/conversation-algebra/index.js'
import {user,assistant,toolResult} from './helpers.mjs'

// ADR-0009: a checkout is one selection event. A crash before it lands
// leaves the log untouched; there is no partial restoration to recover.
test('checkout returns to a saved tool-step branch atomically',async()=>{
 const patch=await prepareExpandedPatch('/home/claw/dsh-stage-021/runtime/lib',{version:'0.1.5-rc.2'})
 try {
  const s=Session.create('restore-tool-step')
  const rows=[user('prefix','prefix'),user('player','input'),assistant('call',[{type:'tool-call',id:'c',name:'skill',arguments:'{}'}],1),toolResult('tool','c',1),assistant('body','body',1,2)]
  for(const row of rows)s.append(row.type,row.data,{surfaceOp:'append'})
  const base=createConversationAlgebraHostAdapter(s,{flush:async()=>{}})
  let state=computeFold(s.snapshotEvents()),saved=branch(state,'original')
  await runTransaction(base,{expectedHead:state.headSeq,operationId:'rewind',ops:[...saved,...checkout(state,0)]})
  assert.deepEqual([...s.surface.nodes],[0])
  state={...computeFold(s.snapshotEvents()),branchRegistry:committedMetadata(s.snapshotEvents())}
  const head=s.seq
  const interrupted={...base,append(){throw new Error('cut')}}
  await assert.rejects(runTransaction(interrupted,{expectedHead:state.headSeq,operationId:'return',ops:checkout(state,saved[0].branch.branchId)}),/cut/)
  assert.equal(s.seq,head,'a crashed checkout writes nothing')
  const restored=Session.fromRestore(s.id,structuredClone(s.snapshotEvents()),structuredClone(s.header),s.inheritedEventCount,'detached')
  const resumed=createConversationAlgebraHostAdapter(restored,{flush:async()=>{}})
  await recoverTransaction(resumed)
  await runTransaction(resumed,{expectedHead:computeFold(restored.snapshotEvents()).headSeq,operationId:'return',ops:checkout(state,saved[0].branch.branchId)})
  const fold=computeFold(restored.snapshotEvents())
  assert.deepEqual(fold.rows.map(r=>(r.data.message??r.data).id),['prefix','player','call','tool','body'])
  assert.deepEqual([...restored.surface.nodes],[0,1,2,3,4])
  assert.equal(restored.snapshotEvents().filter(e=>e.surfaceOp!==undefined).length,rows.length,'checkouts add no message rows')
  assert.equal(committedMetadata(restored.snapshotEvents()).activeBranchId,saved[0].branch.branchId)
 }finally{patch.dispose()}
})
