import assert from 'node:assert/strict'
import test from 'node:test'
import { installConversationHistoryGate } from '../../tavern-plugin/lib/domain/conversation-algebra-isolation.js'
import { appendStep, runTransaction, waitForTransactionReady } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { memoryAdapter, user } from './helpers.mjs'

function deferred() { let resolve; const promise = new Promise(done => {resolve=done}); return {promise, resolve} }

test('readiness waits for durable completion before returning to a reader', async () => {
  const adapter=memoryAdapter()
  const barrier=deferred()
  let flushing=false
  adapter.flush=async()=>{flushing=true;await barrier.promise}
  const write=runTransaction(adapter,{expectedHead:-1,operationId:'gate',ops:appendStep({}, {rows:[user('a','a')]})})
  while(!flushing) await new Promise(resolve=>setImmediate(resolve))
  let published=false
  const read=waitForTransactionReady(adapter).then(()=>{published=true})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(published,false)
  barrier.resolve()
  await Promise.all([write,read])
  assert.equal(published,true)
})

test('history pages and follow records fail closed when recovery fails', async () => {
  let reads=0
  const history={async page(){reads++;return {}}, async sourceFor(){return {}}, async *follow(){yield {type:'event'}}}
  const original=history.page
  const dispose=installConversationHistoryGate(history,async()=>{throw new Error('recovery failed')})
  await assert.rejects(history.page({address:{kind:'session',sessionId:'s'}}),/recovery failed/)
  await assert.rejects(history.follow({address:{kind:'session',sessionId:'s'}}).next(),/recovery failed/)
  assert.equal(reads,0)
  dispose()
  assert.equal(history.page,original)
})

test('follow gates each event and releases the underlying iterator on cancellation',async()=>{
  let gates=0,closed=false
  const history={async page(){},async sourceFor(){},async *follow(){try{yield 1;yield 2}finally{closed=true}}}
  const dispose=installConversationHistoryGate(history,async()=>{gates++})
  const follow=history.follow({address:{kind:'session',sessionId:'s'}},new AbortController().signal)
  assert.equal((await follow.next()).value,1)
  await follow.return()
  assert.equal(closed,true)
  assert.equal(gates,2)
  dispose()
})

test('source raced by a transaction is disposed and reread after the barrier',async()=>{
  let reads=0,disposed=0
  const entry=phase=>({type:'user/message',data:{source:{conversationTransaction:{operationId:'a',phase}}}})
  const history={async page(){},async *follow(){},async sourceFor(){
    reads++
    return {events:reads===1?[entry('begin')]:[entry('begin'),entry('commit')],[Symbol.dispose](){disposed++}}
  }}
  const dispose=installConversationHistoryGate(history,async()=>{})
  const source=await history.sourceFor({kind:'session',sessionId:'s'},new AbortController().signal)
  assert.equal(reads,2)
  assert.equal(disposed,1)
  source[Symbol.dispose]()
  assert.equal(disposed,2)
  dispose()
})
