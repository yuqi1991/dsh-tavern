import './runtime-loader.mjs'
import assert from 'node:assert/strict'
import { Context } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SessionHistoryController } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/history.js'
import { createPluginHost } from './plugin-host.mjs'

const ctx=new Context()
const query={async observeSession(){throw new Error('test session absent')}}
ctx.provide('sessionQuery',query)
const history=new SessionHistoryController(ctx,()=>{})
const original=history.follow
const host=await createPluginHost([['sessionController',{history}],['sessionQuery',query]])
try {
  assert.ok(host.events.has('system-prompt/assemble'))
  assert.notEqual(history.follow,original)
  const status = await host.rpc('getConversationAlgebraStatus', {sessionId:'test-session'})
  assert.equal(status.conversationAlgebra.enabled, false)
  assert.equal(status.conversationAlgebra.historyReady, true)
  console.log('plugin apply and real history gate installed')
} finally {await host.dispose()}
assert.equal(history.follow,original)
console.log('history gate disposed')
