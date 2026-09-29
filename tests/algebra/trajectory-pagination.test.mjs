import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
const root='/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/'
function region(s,name){const start=s.indexOf('//#region '+name);assert.ok(start>=0,name);return s.slice(start,s.indexOf('//#endregion',start))}
function fixture(){
 const c=readFileSync(root+'dsh-client-ui-conversation/lib/client.js','utf8'),t=readFileSync(root+'dsh-client-ui-trajectory/lib/client.js','utf8')
 const ctx=vm.createContext({_deepseek_ai_dsh_client_store:{notifySubscribers(){}},require:()=>({ConversationNodeAssembler:ctx.ConversationNodeAssembler})})
 for(const name of ['lib/types/client/contract/request-inspection.js','../../core/session/src/surface.ts','lib/types/client/contract/system-prompt.js','lib/types/client/contract/conversation.js','lib/types/client/conversation/location-index.js','lib/types/client/conversation/assembler.js'])vm.runInContext(region(c,name),ctx)
 for(const name of ['lib/types/client/trajectory-definition-common.js','lib/types/client/trajectory-request-header-definition.js'])vm.runInContext(region(t,name),ctx)
 vm.runInContext(readFileSync(new URL('../../tavern-plugin/src/client/modules/trajectory-surface-view.js',import.meta.url),'utf8'),ctx)
 return vm.runInContext(`new ConversationNodeAssembler({entries:()=>[trajectorySystemMessageDefinition(inspectSystemPrompt),trajectoryRequestHeaderDefinition(inspectRequestPrompt)],fallbackEntry:()=>undefined},{entries:()=>[{target:'trajectory',create(){return {nodes:new Map(),rebuildContributions(){},snapshot(){return {eventNodes:[]}},replace({nodes}){this.nodes=new Map(nodes.map(n=>[n.key,n]));return this.snapshot()},apply({upserts}){for(const n of upserts)this.nodes.set(n.key,n);return this.snapshot()}}}}]})`,ctx)
}
const event=(seq,type,data,surfaceOp)=>({type:'event',event:{seq,time:1,type,data,...(surfaceOp?{surfaceOp}:{})}})
const messages=[event(0,'system/message',{turn:1,step:1,message:{id:'sys',role:'system',source:{kind:'plugin',plugin:'system'},content:[{type:'text',text:'system'}]}},'append'),event(1,'user/message',{id:'user',role:'user',source:{kind:'user'},content:[{type:'text',text:'opening'}]},'append'),event(2,'request/header',{turn:1,step:1,reason:'initial',header:{config:{},tools:[]}}),event(3,'user/message',{id:'edit',role:'user',source:{kind:'user'},content:[{type:'text',text:'edited'}]},{op:'replace',startSeq:1,endSeq:1})]
test('loading earliest page resolves provisional system contribution without freezing trajectory',()=>{
 const a=fixture();a.replaceWindow(messages.slice(2),true);a.activateTarget('trajectory')
 a.prepend(messages.slice(0,2),false)
 assert.doesNotThrow(()=>a.flush())
 assert.equal(a.inputs.size,4);assert.equal(a.hasMore,false)
 assert.ok([...a.views.get('trajectory').builder.nodes.values()].some(n=>n.data.kind==='system-prompt'&&n.anchorSeq===0))
})
