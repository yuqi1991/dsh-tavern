import test from 'node:test'
import assert from 'node:assert/strict'
import {Session} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import {createConversationBranches} from '../../tavern-plugin/lib/domain/conversation-algebra-branches.js'
import {user} from './helpers.mjs'
test('branch seam saves old line, retries idempotently, and reconstructs lost registry projection',async()=>{
 const s=Session.create('branches-seam')
 for(const id of ['a','b'])s.append('user/message',user(id,id).data,{surfaceOp:'append'})
 let registry
 const options={flush:async()=>{},writeRegistry:async value=>{registry=value}}
 const branches=createConversationBranches(s,options),intent=await branches.plan(0)
 assert.equal(s.snapshotEvents().length,2)
 await branches.commit(intent);assert.equal(registry.branches.length,1)
 const count=s.snapshotEvents().length
 await branches.commit(intent);assert.equal(s.snapshotEvents().length,count)
 registry=null;await branches.ready();assert.equal(registry.branches[0].branchId,intent.branchId)
 const back=await branches.plan(intent.branchId);await branches.commit(back)
 assert.deepEqual(branches.state().rows.map(r=>r.data.id),['a','b'])
 assert.equal(registry.branches.length,2)
})

test('branch recovery remains gated until the persistent registry writer succeeds',async()=>{
 const {createConversationReadiness}=await import('../../tavern-plugin/lib/domain/conversation-algebra-readiness.js')
 const s=Session.create('branch-registry-recovery');for(const id of ['a','b'])s.append('user/message',user(id,id).data,{surfaceOp:'append'})
 let broken=true,registry
 const writer=async value=>{if(broken)throw new Error('registry write failed');registry=value}
 const branches=createConversationBranches(s,{flush:async()=>{},writeRegistry:writer}),intent=await branches.plan(0)
 await assert.rejects(branches.commit(intent),/registry write failed/)
 const restored=Session.fromRestore(s.id,structuredClone(s.snapshotEvents()),structuredClone(s.header),s.inheritedEventCount,'detached')
 const gate=createConversationReadiness({getSession:()=>restored,flush:async()=>{},writeRegistry:async(id,value)=>{assert.equal(id,s.id);await writer(value)}})
 // Explicit recovery after committed metadata write failure; a fresh object has
 // no in-memory quarantine, so branch ready must also reconcile committed refs.
 const restarted=createConversationBranches(restored,{flush:async()=>{},writeRegistry:writer})
 await assert.rejects(restarted.ready(),/registry write failed/)
 broken=false;await restarted.ready();await gate.ready(s.id)
 assert.equal(registry.branches[0].branchId,intent.branchId)
})
