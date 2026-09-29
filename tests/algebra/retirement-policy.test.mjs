import assert from 'node:assert/strict'
import test from 'node:test'
import { planForegroundRetirement } from '../../tavern-plugin/lib/domain/conversation-algebra-retirement.js'
import { appendRaw, user, assistant, toolResult } from './helpers.mjs'

const frame = (id,form,turn,text='rules', extra={}) => user(id,text,{kind:'plugin',plugin:'dsh-tavern',form,trace:{turn},...extra})

test('retirement preserves current frames and latest nonempty worldbook',()=>{
  const events=appendRaw([], [user('player','story'),frame('old','foreground-frame',1),frame('current','foreground-frame',2),
    frame('wb-old','worldbook-snapshot',1),frame('wb-latest','worldbook-snapshot',1)])
  const {ops}=planForegroundRetirement(events,2)
  assert.deepEqual(ops.map(op=>op.intent.sourceEventSeqs[0]).sort(),[1,3])
  assert.deepEqual(planForegroundRetirement(events,undefined).ops,[])
})

test('skill loads retire as closed pairs and prose remains visible',()=>{
  const call=assistant('call',[{type:'tool-call',id:'skill',name:'skill',arguments:'{}'}],1)
  const events=appendRaw([], [call,toolResult('result','skill',1),assistant('prose','story',1,2)])
  assert.deepEqual(planForegroundRetirement(events,2).ops.map(op=>op.intent.sourceEventSeqs[0]),[0,1])
  assert.deepEqual(planForegroundRetirement(events,1).ops,[])
})

test('legacy catalog requires historical reminder evidence',()=>{
  const events=appendRaw([], [user('catalog','skills',{kind:'skill-catalog'})])
  assert.deepEqual(planForegroundRetirement(events,2).ops,[])
  appendRaw(events,[frame('reminder','writing-skill-reminder',2)])
  assert.deepEqual(planForegroundRetirement(events,2).ops.map(op=>op.intent.sourceEventSeqs[0]),[0])
})
