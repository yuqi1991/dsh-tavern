import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as cordis from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/cordis/lib/index.js'

const runtime='/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/'
function client() {
  const modules=new Map([['@deepseek-ai/cordis',cordis],['@deepseek-ai/dsh-client-store',{}]])
  const context=vm.createContext({window:{__ModuleLoader__:{load(descriptor){modules.set(descriptor.id+'/client',descriptor.factory(name=>modules.get(name)))}}},console,AbortController,queueMicrotask,setTimeout,clearTimeout})
  for(const name of ['dsh-api-gateway','dsh-api-session-controller']) vm.runInContext(readFileSync(runtime+name+'/lib/client.js','utf8'),context)
  vm.runInContext(readFileSync(new URL('../../tavern-plugin/src/client/modules/host-session-patch.js',import.meta.url),'utf8'),context)
  const published=[]
  const Stream=modules.get('@deepseek-ai/dsh-api-session-controller/client').SessionEventStream
  const stream=new Stream({$stream:()=>({})},{kind:'session',sessionId:'s'},{publish:change=>published.push(change),failed:error=>{throw error}})
  context.installConversationPublicationGate(stream)
  return {stream,published}
}
const entry=(seq,phase)=>({type:'event',event:{seq,time:1,type:'user/message',surfaceOp:'append',data:{id:String(seq),role:'user',content:[],source:{kind:'plugin',plugin:'dsh-tavern',...(phase?{conversationTransaction:{operationId:'op',phase}}:{})}}}})

test('actual host SessionEventStream publishes one window for a complete transaction',async()=>{
  const {stream,published}=client()
  const first=entry(0)
  stream.replaceFromOpening({records:[first],hasMore:false,assistantStream:{revision:0}},0)
  for(const record of [entry(1,'begin'),entry(2,'continue')]) await stream.acceptEntry(record,{},null)
  assert.equal(published.length,1)
  await stream.acceptEntry(entry(3,'commit'),{},null)
  assert.equal(published.length,2)
  assert.equal(published[1].type,'replace')
  assert.deepEqual(Array.from(published[1].entries,item=>item.event.seq),[0,1,2,3])
  assert.equal(stream.lastCursor,3)
})

test('reconnect replaces an unfinished buffered window without duplicates',async()=>{
  const {stream,published}=client()
  stream.replaceFromOpening({records:[entry(0)],hasMore:false},0)
  await stream.acceptEntry(entry(1,'begin'),{},null)
  stream.replaceFromOpening({records:[entry(0),entry(1,'begin'),entry(2,'commit')],hasMore:false},2)
  assert.equal(published.length,2)
  assert.equal(published[1].entries.length,3)
  await stream.acceptEntry(entry(3),{},null)
  assert.equal(published.at(-1).type,'append')
})

test('uncommitted snapshot is never published',()=>{
  const {stream,published}=client()
  assert.throws(()=>stream.replaceFromOpening({records:[entry(0,'begin')],hasMore:false},0),/未提交/)
  assert.equal(published.length,0)
})

test('page loaded during a transaction is included in atomic commit publication',async()=>{
  const {stream,published}=client()
  stream.replaceFromOpening({records:[entry(2)],hasMore:true},2)
  await stream.acceptEntry(entry(3,'begin'),{},null)
  stream.options.publish({type:'prepend',entries:[entry(0),entry(1)],page:{records:[entry(0),entry(1)],hasMore:false},hasMore:false})
  assert.equal(published.length,1)
  await stream.acceptEntry(entry(4,'commit'),{},null)
  assert.deepEqual(Array.from(published.at(-1).entries,item=>item.event.seq),[0,1,2,3,4])
  assert.equal(published.at(-1).hasMore,false)
})
