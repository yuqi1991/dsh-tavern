import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import vm from 'node:vm'
import {parse} from 'acorn'

const boot=process.env.DSH_BOOT_MODULE
async function runtime() {
 const root=pathToFileURL(boot)
 const chat=await readFile(new URL('../../dsh-client-ui-chat/lib/client.js',root),'utf8')
 const core=await readFile(new URL('../../dsh-client-ui-conversation/lib/client.js',root),'utf8')
 function declaration(source,name) {
  let found
  function visit(node) {
   if(!node||typeof node!=='object')return
   if((node.type==='VariableDeclarator'||node.type==='FunctionDeclaration')&&node.id?.name===name)found=node
   for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value)
  }
  visit(parse(source,{ecmaVersion:'latest'}));assert.ok(found,name)
  return found.type==='VariableDeclarator'?'var '+source.slice(found.start,found.end)+';':source.slice(found.start,found.end)
 }
 const scope=vm.createContext({console,window:{}})
 const start=chat.indexOf('function contextLocation('),end=chat.indexOf('//#region lib/types/client/contract/chat-nodes.js',start)
 assert.ok(start>0&&end>start)
 vm.runInContext(chat.slice(start,end)+declaration(core,'contextSnapshot')+declaration(core,'ConversationNodeAssembler'),scope)
 return {scope,assembler:vm.runInContext('Object.create(ConversationNodeAssembler.prototype)',scope),definition:vm.runInContext('assistantDefinition',scope)}
}
async function replay(t,patched) {
 const {scope,assembler,definition}=await runtime()
 if(patched) {
  let descriptor
  scope.window.__ModuleLoader__={load:value=>{descriptor=value}}
  vm.runInContext(await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8'),scope)
  const core=vm.runInContext('({ConversationNodeAssembler})',scope)
  const require=name=>name==='@deepseek-ai/dsh-client-ui-conversation/client'?core:{}
  descriptor.factory(require)
  const installed=core.ConversationNodeAssembler.prototype.buildNode
  descriptor.factory(require)
  assert.equal(core.ConversationNodeAssembler.prototype.buildNode,installed,'installation is idempotent')
 }
 const location={kind:'step',turn:{status:'running'},step:{status:'running',data:new Map()}}
 const start={event:{type:'step/start',seq:1,time:1,data:{turn:1,step:1}},location}
 const context={key:'assistant-step:1:1',kind:'assistant-step',id:'1:1',matches:[start],start,current:new Map(),definition}
 context.state=definition.start(context,start)
 function publish(chunk,seq) {
  const match={event:{type:'assistant/live-chunk',seq,time:seq,data:{turn:1,step:1,chunk}},location}
  context.matches.push(match);context.state=definition.update(context,match)
  location.step.data.set('assistant-step',definition.buildLocationData(context,'step').value)
  return assembler.buildTargetUpserts('chat',[context])
 }
 if(patched) {
  location.step.data.set('assistant-step',definition.buildLocationData(context,'step').value)
  assert.equal(assembler.buildTargetUpserts('chat',[context]).length,0,'empty first state has no phantom node')
 }
 const visible=publish({type:'text-delta',index:0,text:'正在结算'},2)[0]
 assert.equal(visible.visibility,'visible')
 const reset=()=>publish({type:'block-end',index:0,block:{type:'text',text:''}},3)
 if(!patched) {assert.throws(reset,/withdrew materialized target "chat"/);return}
 const hidden=reset()[0]
 assert.equal(hidden.key,visible.key);assert.equal(hidden.visibility,'hidden')
 const resumed=publish({type:'text-delta',index:0,text:'结算完成'},4)[0]
 assert.equal(resumed.visibility,'visible');assert.equal(resumed.data.blocks[0].text,'结算完成')
 for(const id of ['tavern-seed-trajectory:v1:background-test:2','normal-final']) {
  const match={event:{type:'assistant/message',surfaceOp:'append',seq:5,time:5,data:{turn:1,step:1,message:{id,content:[{type:'text',text:'保留模型内容'}]}}},location}
  context.state=definition.update(context,match)
  location.step.data.set('assistant-step',definition.buildLocationData(context,'step').value)
  const node=assembler.buildTargetUpserts('chat',[context])[0]
  assert.equal(node.key,visible.key)
  assert.equal(node.visibility,id==='normal-final'?'visible':'hidden')
  assert.equal(node.data.blocks[0].text,'保留模型内容')
 }
 const other={...context,kind:'other',definition:{target:'chat',buildViewNode:()=>null}}
 assert.throws(()=>assembler.buildTargetUpserts('chat',[other]),/withdrew materialized/, 'other definitions keep core guard')
}
test('已物化 assistant 节点改为 hidden 后仍能继续处理后续事件',{skip:!boot},t=>replay(t,true))
