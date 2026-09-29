import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
const root='/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/'
function region(source,name){const start=source.indexOf('//#region '+name);assert.ok(start>=0);return source.slice(start,source.indexOf('//#endregion',start))}
function fixture(){
 const conversation=readFileSync(root+'dsh-client-ui-conversation/lib/client.js','utf8'),chat=readFileSync(root+'dsh-client-ui-chat/lib/client.js','utf8')
 const context=vm.createContext({require:()=>({ConversationNodeAssembler:context.ConversationNodeAssembler}),_deepseek_ai_dsh_client_store:{notifySubscribers(){}}})
 for(const name of ['lib/types/client/contract/conversation.js','lib/types/client/conversation/location-index.js','lib/types/client/conversation/assembler.js'])vm.runInContext(region(conversation,name),context)
 for(const name of ['../../core/session/src/surface.ts','lib/types/client/conversation-nodes/common.js','lib/types/client/conversation-nodes/message.js'])vm.runInContext(region(chat,name),context)
 const patch=new URL('../../tavern-plugin/src/client/modules/user-surface-view.js',import.meta.url)
 if(existsSync(patch)){vm.runInContext(readFileSync(patch,'utf8'),context);vm.runInContext('installTavernUserSurfaceView(() => ({ConversationNodeAssembler}))',context)}
 return vm.runInContext(`new ConversationNodeAssembler({entries:()=>[messageDefinition],fallbackEntry:()=>undefined},{entries:()=>[{target:'chat',create(){let nodes=new Map();return {replace(input){nodes=new Map(input.nodes.map(n=>[n.key,n]));return [...nodes.values()]},apply(input){for(const n of input.upserts)nodes.set(n.key,n);return [...nodes.values()]}}}}]})`,context)
}
const entry=(seq,text,op='append')=>({type:'event',event:{type:'user/message',seq,time:1,surfaceOp:op,data:{id:'u'+seq,role:'user',source:{kind:'user'},content:[{type:'text',text}]}}})
const replace=(seq,text,target)=>entry(seq,text,{op:'replace',startSeq:target,endSeq:target})
for(const mode of ['live','reopen'])test(`edited-input replacement updates original user bubble (${mode})`,()=>{
 const assembler=fixture(),first=entry(0,'原输入'),edit=replace(1,'修改后的输入',0)
 assembler.replaceWindow([first],false);assembler.activateTarget('chat');const key=assembler.snapshot('chat')[0].key
 if(mode==='live')assembler.append(edit);else assembler.replaceWindow([first,edit],false)
 assembler.flush();const nodes=assembler.snapshot('chat');assert.equal(nodes.length,1);assert.equal(nodes[0].key,key);assert.equal(nodes[0].data.content[0].text,'修改后的输入')
})
test('successive edits retain one bubble and do not change a neighbouring input',()=>{
 const a=fixture();a.replaceWindow([entry(0,'第一轮'),entry(1,'原输入')],false);a.activateTarget('chat')
 for(const event of [replace(2,'第一次修改',1),replace(3,'第二次修改',2)]){a.append(event);a.flush()}
 assert.deepEqual(Array.from(a.snapshot('chat'),n=>n.data.content[0].text),['第一轮','第二次修改'])
 a.replaceWindow([entry(0,'第一轮'),entry(1,'原输入')],false);a.flush()
 assert.equal(a.snapshot('chat')[1].data.content[0].text,'原输入')
})
test('unrelated retirement tombstone does not overwrite the user bubble',()=>{
 const a=fixture();a.replaceWindow([entry(0,'原输入')],false);a.activateTarget('chat')
 const tombstone=replace(1,'',0);tombstone.event.data.content=[];tombstone.event.data.source={kind:'plugin',plugin:'dsh-tavern'}
 a.append(tombstone);a.flush();assert.equal(a.snapshot('chat')[0].data.content[0].text,'原输入')
})
test('prepend resolves an edit whose original input was outside the loaded window',()=>{
 const a=fixture();a.replaceWindow([replace(2,'新输入',0)],true);a.activateTarget('chat')
 assert.equal(a.snapshot('chat').length,0)
 a.prepend([entry(0,'原输入'),{type:'event',event:{type:'session/end-seed',seq:1,time:1,data:{}}}],false);a.flush()
 assert.equal(a.snapshot('chat')[0].data.content[0].text,'新输入')
})
