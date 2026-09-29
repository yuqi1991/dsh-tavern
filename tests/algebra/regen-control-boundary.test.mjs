import test from 'node:test'
import assert from 'node:assert/strict'
import {planRegenerationSurface} from '../../tavern-plugin/lib/domain/rollback-surface.js'
import {assistant,user,appendRaw} from './helpers.mjs'
function fixture(control){const events=[];appendRaw(events,[user('player','input'),assistant('old','edited old body',2,2),control,user('attempt','input',{kind:'plugin',plugin:'dsh-tavern-regen'}),assistant('new','new body',3,1)]);return {events,nodes:[0,1,2,3,4],oldAssistantSeq:1,eventStart:3}}
const carrier=()=>user('conversation-metadata:checkout:1',null,{kind:'plugin',plugin:'dsh-tavern',form:'conversation-metadata',conversationTransaction:{operationId:'checkout:1',phase:'begin-commit',metadata:{version:1,branches:[]}}})
test('reroll after branch checkout accepts committed empty registry carrier between old and new body',()=>{
 const range=planRegenerationSurface(fixture(carrier()))
 assert.deepEqual(range.shadowedSeqs,[1,2,3,4])
})
test('foreign player input and nonempty metadata-shaped rows still refuse cleanup',()=>{
 for(const row of [user('foreign','new player input'),{...carrier(),data:{...carrier().data,content:[{type:'text',text:'must not consume'}]}}]){
  assert.throws(()=>planRegenerationSurface(fixture(row)),/归属不一致/)
 }
})

test('completed checkout tombstone is accepted while uncommitted or malformed control is refused',()=>{
 const tombstone=user('conversation-checkout:9:clear',null,{kind:'plugin',plugin:'dsh-tavern',form:'checkout',conversationTransaction:{operationId:'checkout:9',phase:'begin'}})
 const events=[];appendRaw(events,[user('prefix','earlier'),assistant('old','old body',2),user('removed','future'),assistant('removedBody','future body',3)])
 events.push({...tombstone,seq:4,time:1,surfaceOp:{op:'replace',startSeq:2,endSeq:3},sourceEventSeqs:[2,3]})
 const committed=carrier();committed.data.id='conversation-metadata:checkout:9';committed.data.source.conversationTransaction={operationId:'checkout:9',phase:'commit'}
 appendRaw(events,[committed,user('attempt','input',{kind:'plugin',plugin:'dsh-tavern-regen'}),assistant('new','new body',4)])
 const input={events,nodes:[0,1,4,5,6,7],oldAssistantSeq:1,eventStart:6}
 assert.deepEqual(planRegenerationSurface(input).shadowedSeqs,[1,4,5,6,7])
 const uncommitted=structuredClone(input);uncommitted.events[5].data.source.conversationTransaction.operationId='other'
 assert.throws(()=>planRegenerationSurface(uncommitted),/归属不一致/)
 const malformed=structuredClone(input);malformed.events[4].data.id='foreign-empty'
 assert.throws(()=>planRegenerationSurface(malformed),/归属不一致/)
})
