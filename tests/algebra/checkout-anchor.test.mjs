import test from 'node:test'
import assert from 'node:assert/strict'
import {computeFold,editStep,checkout,branch} from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import {appendRaw,applyWrites,user,assistant,toolResult} from './helpers.mjs'

test('rollback second round retains the edited first round at its original anchor',()=>{
 const events=[];appendRaw(events,[user('u1','input'),assistant('a1','old',1)])
 const anchor=1,saved=branch(computeFold(events),'before-edit')[0].branch
 applyWrites(events,editStep(computeFold(events),anchor,'edited'))
 applyWrites(events,editStep(computeFold(events),2,'edited again'))
 appendRaw(events,[user('u2','second'),assistant('a2','second reply',2)])
 const state={...computeFold(events),branchRegistry:{branches:[saved]}}
 assert.deepEqual(checkout(state,{anchorSeq:anchor})[0].targetNodes,[0,3])
 assert.deepEqual(checkout(state,saved.branchId)[0].targetNodes,[0,1])
})

test('anchor keeps edits to an earlier step even when those edits were logged later',()=>{
 const events=[];appendRaw(events,[user('u1','input'),assistant('a1','old',1),user('u2','second'),assistant('a2','body',2)])
 applyWrites(events,editStep(computeFold(events),0,'edited input'))
 assert.deepEqual(checkout(computeFold(events),{anchorSeq:1})[0].targetNodes,[4,1])
})

test('anchor refuses a range-collapsed position and a partial tool pair without writes',()=>{
 const events=[];appendRaw(events,[user('u1','input'),assistant('a1',[{type:'tool-call',id:'c',name:'skill',arguments:'{}'}],1),toolResult('result','c',1)])
 assert.throws(()=>checkout(computeFold(events),1),/工具步骤/)
 assert.deepEqual(checkout(computeFold(events),2)[0].targetNodes,[0,1,2])
 applyWrites(events,[{kind:'surface-write',event:user('clear',null),intent:{surfaceOp:{op:'replace',start:1,end:2},sourceEventSeqs:[1,2]}}])
 const before=structuredClone(events)
 assert.throws(()=>checkout(computeFold(events),1),/无法唯一定位/)
 assert.deepEqual(events,before)
})

test('real host branch plus checkout preserves edited prefix and can restore the saved full line',async()=>{
 const {Session}=await import('/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js')
 const {prepareExpandedPatch}=await import('../../tavern-plugin/lib/domain/host-session-patch.js')
 const {createConversationAlgebraHostAdapter}=await import('../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js')
 const {runTransaction}=await import('../../tavern-plugin/lib/domain/conversation-algebra/index.js')
 const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
 try {
  const session=Session.create('anchor-edit-rollback'),rows=[user('u1','input'),assistant('a1','old',1)]
  for(const row of rows)session.append(row.type,row.data,{surfaceOp:'append'})
  let metadata
  const adapter=createConversationAlgebraHostAdapter(session,{flush:async()=>{},write:async value=>{metadata=value}})
  let state=computeFold(session.snapshotEvents())
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'edit',ops:editStep(state,1,'edited')})
  for(const row of [user('u2','second'),assistant('a2','second reply',2)])session.append(row.type,row.data,{surfaceOp:'append'})
  state=computeFold(session.snapshotEvents());const save=branch(state,'before rollback')
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'rollback',ops:[...save,...checkout(state,{anchorSeq:1})]})
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>(row.data.message??row.data).content[0].text),['input','edited'])
  state={...computeFold(session.snapshotEvents()),branchRegistry:metadata}
  await runTransaction(adapter,{expectedHead:state.headSeq,operationId:'restore',ops:checkout(state,save[0].branch.branchId)})
  assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>(row.data.message??row.data).content[0].text),['input','edited','second','second reply'])
 }finally{patch.dispose()}
})
