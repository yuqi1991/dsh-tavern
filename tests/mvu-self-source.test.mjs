import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFileResourceStore} from '../tavern-plugin/lib/domain/file-resources.js'
import {createMvuConversion,cardData} from '../tavern-plugin/lib/domain/mvu-conversion.js'
import {preserveSelfSourcedGreetings,splitMvuGreeting,stripManagedMvu} from '../tavern-plugin/lib/domain/mvu-self-source.js'

async function fixture(t,wrap=x=>x) {
 const root=await mkdtemp(join(tmpdir(),'mvu-self-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const resources=createFileResourceStore({dataRoot:root}),conversion=createMvuConversion({resources:wrap(resources)})
 await resources.ensure()
 const card={name:'沈清岚',description:'民国侦探',first_mes:'雨夜事务所。',alternate_greetings:['老闸区现场。']}
 const path=await resources.importCard({name:'沈清岚.json',text:JSON.stringify(card)},card)
 let current,sequence=0
 const draft=args=>conversion.draft(args)
 const patch=async(section,values,extra={})=>current=await draft({action:'patch',draftId:current.draftId,draftRevision:current.draftRevision,requestId:'p'+(++sequence),section,values,...extra})
 const commit=()=>draft({action:'commit',draftId:current.draftId,draftRevision:current.draftRevision,requestId:'c'+(++sequence)})
 const begin=async args=>current=await draft({action:'begin',requestId:'b'+(++sequence),...args})
 const edit=async mutate=>{const doc=await resources.readCard(path);mutate(cardData(doc));await resources.writeWorking(path,JSON.stringify(doc))}
 return {root,resources,conversion,path,patch,commit,begin,edit,read:async()=>cardData(await resources.readCard(path)),get current(){return current}}
}
async function convertInPlace(f) {
 await f.begin({sourcePath:f.path,inPlace:true})
 await f.patch('fields',{'/地点':'事务所','/线索':[]})
 await f.patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
 await f.patch('opening',{'/地点':'老闸区'},{openingId:'opening-1',inheritInitialState:true})
 await f.patch('rules',{场景:'依据正文更新地点与线索'})
 await f.patch('appearance',{html:'<section><mvu-field path="/地点"></mvu-field><mvu-field path="/线索" display="list"></mvu-field></section>'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 return f.commit()
}

test('新卡原地加 MVU：只有一张卡，剧情字段可直接修改且校验仍通过',async t=>{
 const f=await fixture(t)
 const result=await convertInPlace(f)
 assert.equal(result.receipt.validation.valid,true,JSON.stringify(result.receipt.validation))
 assert.equal(result.targetPath,f.path)
 assert.equal((await f.resources.list('card')).length,1)
 const card=await f.read()
 assert.equal(card.name,'沈清岚')
 assert.equal(card.extensions.dsh_mvu_conversion.selfSourced,true)
 assert.match(card.first_mes,/^雨夜事务所。\n\n<initvar>[\s\S]*"地点": "事务所"[\s\S]*<mvu-status\/>$/)
 await f.edit(data=>{data.description='民国侦探，追查父亲旧案'})
 const greeting=preserveSelfSourcedGreetings(await f.read(),{first_mes:'雨夜，霞飞路事务所。'})
 await f.edit(data=>{data.first_mes=greeting.first_mes})
 assert.equal((await f.conversion.verify({path:f.path})).valid,true)
 const edited=await f.read()
 assert.equal(splitMvuGreeting(edited.first_mes).body,'雨夜，霞飞路事务所。')
 assert.equal(stripManagedMvu(edited).description,'民国侦探，追查父亲旧案')
})

test('原地 MVU 卡用 path 继续改变量，保留期间的剧情修改，仍是同一张卡',async t=>{
 const f=await fixture(t)
 await convertInPlace(f)
 await f.edit(data=>{data.description='改过的设定'})
 await f.begin({path:f.path})
 await f.patch('fields',{'/时段':'夜'})
 await f.patch('opening',{'/时段':'夜'},{openingId:'opening-0'})
 await f.patch('opening',{'/时段':'凌晨'},{openingId:'opening-1'})
 await f.patch('appearance',{replacements:[{expected:'</section>',value:'<mvu-field path="/时段"></mvu-field></section>'}]})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const result=await f.commit().catch(error=>{throw Error(JSON.stringify(error.details))})
 assert.equal(result.receipt.validation.valid,true,JSON.stringify(result.receipt.validation))
 const card=await f.read()
 assert.equal(card.description,'改过的设定')
 assert.match(card.alternate_greetings[0],/"时段": "凌晨"/)
 assert.equal((await f.resources.list('card')).length,1)
})

test('原地 MVU 拒绝副本名、清理和改变开场数量',async t=>{
 const f=await fixture(t)
 await assert.rejects(f.begin({sourcePath:f.path,inPlace:true,name:'别名'}),/不传副本名/)
 await f.begin({sourcePath:f.path,inPlace:true})
 await assert.rejects(f.patch('cleanup',[{op:'remove',path:'/description'}]),/不清理旧协议/)
 await convertInPlace(f)
 assert.throws(()=>preserveSelfSourcedGreetings({...(stripManagedMvu({}) ),extensions:{dsh_mvu_conversion:{selfSourced:true}},alternate_greetings:['a']},{alternate_greetings:['a','b']}),/开场数量/)
})

test('以文件为准：手改开场初值与更新规则后仍校验通过，继续改变量时沿用手改内容',async t=>{
 const f=await fixture(t)
 await convertInPlace(f)
 await f.edit(data=>{
  data.first_mes=data.first_mes.replace('"地点": "事务所"','"地点": "码头"')
  const rule=data.character_book.entries.find(entry=>/\[mvu_update\]/.test(entry.comment))
  rule.content=rule.content.replace('依据正文更新地点与线索','依据正文更新地点、线索与天气')
 })
 const report=await f.conversion.verify({path:f.path})
 assert.equal(report.valid,true,JSON.stringify(report.checks.filter(x=>x.status==='failed')))
 await f.begin({path:f.path})
 const draft=await f.conversion.draft({action:'read',draftId:f.current.draftId,path:'/definition/openingStates/0/地点'})
 assert.equal(draft.reading.text,'码头')
 await f.patch('opening',{'/线索':['旧烟盒']},{openingId:'opening-1'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const result=await f.commit().catch(error=>{throw Error(JSON.stringify(error.details))})
 assert.equal(result.receipt.validation.valid,true)
 const card=await f.read()
 assert.match(card.first_mes,/"地点": "码头"/)
 assert.match(card.alternate_greetings[0],/旧烟盒/)
 assert.match(card.character_book.entries.find(entry=>/\[mvu_update\]/.test(entry.comment)).content,/地点、线索与天气/)
 assert.equal(card.extensions.dsh_mvu_conversion.outputDigest,undefined)
})

test('卡片文本写坏时校验直接指出位置',async t=>{
 const f=await fixture(t)
 await convertInPlace(f)
 await f.edit(data=>{data.first_mes=data.first_mes.replace('"地点": "事务所"','"地点": 事务所')})
 const report=await f.conversion.verify({path:f.path})
 assert.equal(report.valid,false)
 assert.match(report.checks.find(x=>x.name==='cardText').detail,/开场 0 的 <initvar> 不是有效 JSON/)
})

test('原地提交写盘后回执丢失，重试不报冲突也不重复写',async t=>{
 let failOnce=false
 const f=await fixture(t,resources=>({...resources,saveMvuCard:async args=>{const result=await resources.saveMvuCard(args);if(failOnce){failOnce=false;throw Error('模拟中断')}return result}}))
 await f.begin({sourcePath:f.path,inPlace:true})
 await f.patch('fields',{'/地点':'事务所'})
 await f.patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
 await f.patch('opening',undefined,{openingId:'opening-1',inheritInitialState:true})
 await f.patch('rules',{场景:'依据正文更新地点'})
 await f.patch('appearance',{html:'<section><mvu-field path="/地点"></mvu-field></section>'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 failOnce=true
 const args={action:'commit',draftId:f.current.draftId,draftRevision:f.current.draftRevision,requestId:'final'}
 await assert.rejects(f.conversion.draft(args),e=>e.details.commitState==='unknown')
 const bytes=await f.resources.readText(f.path)
 const resumed=await f.conversion.draft(args)
 assert.equal(resumed.phase,'committed');assert.equal(resumed.receipt.validation.valid,true)
 assert.equal(await f.resources.readText(f.path),bytes)
})

test('原地 MVU 卡可直接局部改面板，保留手改的剧情文字',async t=>{
 const f=await fixture(t)
 await convertInPlace(f)
 await f.edit(data=>{data.description='手改设定'})
 const read=await f.conversion.readAppearance({path:f.path})
 assert.equal(read.editable,true)
 const result=await f.conversion.updateAppearance({path:f.path,revision:read.revision,replacements:[{expected:'<section>',value:'<section class="paper">'}]})
 assert.equal(result.validation.valid,true,JSON.stringify(result.validation.checks.filter(x=>x.status==='failed')))
 const card=await f.read()
 assert.equal(card.description,'手改设定')
 assert.match(card.extensions.dsh_mvu_conversion.appearance.html,/class="paper"/)
})
