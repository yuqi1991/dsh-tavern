import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

test('开始页注册到原生 guide chain 并通过当前标签导航', async () => {
 const source=await readFile(new URL('../tavern-plugin/src/client/modules/sidebar-start.js',import.meta.url),'utf8')
 let options,component,navigation
 const entries=[{kind:'dsh-tavern:cards',title:()=> '人物卡库'}]
 const registry={subscribe:()=>()=>{},guide:()=>entries}
 const ctx={inject:(_deps,callback)=>callback({get:()=>registry,effect:fn=>fn()})}
 const slots={inject:(name,fn)=>{assert.equal(name,'sidebar.right.tab.guide');return fn()},register:(o,c)=>{options=o;component=c}}
 const React={useSyncExternalStore:(_s,get)=>get(),createElement:(type,props)=>({type,props})}
 vm.runInNewContext(source+'\nregisterTavernStartPage(ctx,slots)',{ctx,slots,React})
 assert.equal(options.select({}),true)
 const result=component({useTabInfo:()=>({tab:{actions:{openTab:(...args)=>navigation=args}}})})
 assert.equal(result.props.newTabOptions[0].label,'人物卡库')
 result.props.onNewTab('dsh-tavern:cards')
 assert.equal(navigation[0],'dsh-tavern:cards')
 assert.equal(navigation[1].replaceTab,true)
})

test('Guide 库显示在偏好分组，点击打开独立库标签', async () => {
 const source=await readFile(new URL('../tavern-plugin/src/client/modules/sidebar-start.js',import.meta.url),'utf8')
 const React={createElement:(type,props,...children)=>({type,props,children})}
 const context={React}
 vm.runInNewContext(source+'\nthis.render=TavernStartCards',context)
 let opened
 const tree=context.render({newTabOptions:[{id:'dsh-tavern:guide-library',label:'Guide 库'}],onNewTab:id=>opened=id})
 const sections=tree.children.flat(Infinity).filter(node=>node?.type==='section')
 assert.equal(sections.length,1)
 assert.equal(sections[0].props['aria-label'],'偏好')
 function visit(node){if(!node||typeof node!=='object')return; if(node.type==='button')node.props.onClick(); for(const child of (node.children||[]).flat(Infinity))visit(child)}
 visit(tree)
 assert.equal(opened,'dsh-tavern:guide-library')
})
