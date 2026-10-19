import test, { before, after } from 'node:test'
import { prepareExpandedPatch } from '../../lib/domain/host-session-patch.js'
import assert from 'node:assert/strict'
import {Session} from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import {createConversationBranches} from '../../lib/domain/conversation-algebra-branches.js'
import {user} from './helpers.mjs'

// Checkouts write surface selections (ADR-0009); the host patch applies them.
let patch
before(async () => { patch = await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', { version: '0.1.5-rc.2' }) })
after(() => patch.dispose())
test('branch seam saves old line, retries idempotently, and keeps the registry in the log',async()=>{
 const s=Session.create('branches-seam')
 for(const id of ['a','b'])s.append('user/message',user(id,id).data,{surfaceOp:'append'})
 const branches=createConversationBranches(s,{flush:async()=>{}}),intent=await branches.plan(0)
 assert.equal(s.snapshotEvents().length,2)
 await branches.commit(intent);assert.equal(branches.state().branchRegistry.branches.length,1)
 const count=s.snapshotEvents().length
 await branches.commit(intent);assert.equal(s.snapshotEvents().length,count)
 // A restart reads the registry back from the log; no projection to rebuild.
 const restored=Session.fromRestore(s.id,structuredClone(s.snapshotEvents()),structuredClone(s.header),s.inheritedEventCount,'detached')
 const reopened=createConversationBranches(restored,{flush:async()=>{}})
 await reopened.ready();assert.equal(reopened.state().branchRegistry.branches[0].branchId,intent.branchId)
 const back=await reopened.plan(intent.branchId);await reopened.commit(back)
 assert.deepEqual(reopened.state().rows.map(r=>r.data.id),['a','b'])
 assert.equal(reopened.state().branchRegistry.branches.length,2)
})
