import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
import { retireForegroundWithAlgebra } from '../../tavern-plugin/lib/domain/conversation-algebra-retirement.js'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { assistant, toolResult, user } from './helpers.mjs'

test('host retirement removes a complete skill pair, preserves prose, and is idempotent', async () => {
  const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib', {version:'0.1.5-rc.2'})
  try {
    const session=Session.create('algebra-skill-retirement')
    const rows=[user('player','story'),assistant('load',[{type:'tool-call',id:'skill',name:'skill',arguments:'{}'}],1),toolResult('loaded','skill',1),assistant('body','keep story',1,2)]
    for(const row of rows) session.append(row.type,row.data,{surfaceOp:'append'})
    const count=await retireForegroundWithAlgebra(session,{keepTurn:2,flush:async()=>{},operationId:'retire'})
    assert.equal(count,2)
    assert.deepEqual(computeFold(session.snapshotEvents()).rows.map(row=>row.type==='user/message'?row.data.id:row.data.message.id),['player','body'])
    assert.equal(await retireForegroundWithAlgebra(session,{keepTurn:2,flush:async()=>{},operationId:'again'}),0)
  } finally { patch.dispose() }
})
