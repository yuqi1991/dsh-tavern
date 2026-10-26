import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createFileResourceStore} from '../tavern-plugin/lib/domain/file-resources.js'
import {createMvuConversion,cardData} from '../tavern-plugin/lib/domain/mvu-conversion.js'
import {registerMvuConversionTools} from '../tavern-plugin/lib/domain/mvu-conversion-tools.js'

async function fixture(t,options={}) {
 const root=await mkdtemp(join(tmpdir(),'mvu-draft-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const resources=createFileResourceStore({dataRoot:root}),conversion=createMvuConversion({resources})
 await resources.ensure()
 const card={name:'草稿测试',description:'保留设定',first_mes:'大厅开场',alternate_greetings:['车站开场'],...options.card}
 const sourcePath=await resources.importCard({name:'草稿测试.json',text:JSON.stringify(card)},card)
 let current=await conversion.draft({action:'begin',sourcePath,requestId:'begin',...options.begin})
 let sequence=0
 const patch=async(section,values,extra={})=>current=await conversion.draft({action:'patch',draftId:current.draftId,draftRevision:current.draftRevision,requestId:'patch-'+(++sequence),section,values,...extra})
 const read=()=>conversion.draft({action:'read',draftId:current.draftId})
 const commitArgs=()=>({action:'commit',draftId:current.draftId,draftRevision:current.draftRevision,requestId:'commit'})
 const complete=async()=>{
  await patch('fields',{'/时间/时段':'白天','/地点/名称':'大厅'})
  await patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
  await patch('opening',{'/时间/时段':'夜晚','/地点/名称':'车站'},{openingId:'opening-1'})
  await patch('rules',{场景:'依据正文更新时间地点'})
  await patch('appearance',{html:'<section><h2>场景</h2><mvu-field path="/时间/时段"></mvu-field><mvu-field path="/地点/名称"></mvu-field></section>'})
  await patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 }
 return {root,resources,conversion,sourcePath,patch,read,commitArgs,complete,get current(){return current}}
}
test('分组草稿跨重启恢复，逐开场保存，原卡不变，重复提交只生成一个副本',async t=>{
 const f=await fixture(t),source=await f.resources.readText(f.sourcePath)
 await f.complete()
 const restored=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const read=await restored.draft({action:'read',draftId:f.current.draftId,path:'/definition/openingStates/1/地点/名称'})
 assert.equal(read.reading.text,'车站');assert.equal(read.missingCount,0)
 const result=await restored.draft(f.commitArgs())
 assert.equal(result.receipt.validation.valid,true,JSON.stringify(result))
 assert.equal(result.phase,'committed')
 const card=cardData(await f.resources.readCard(result.targetPath))
 assert.equal(JSON.parse(card.first_mes.match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/)[1]).地点.名称,'大厅')
 assert.equal(JSON.parse(card.alternate_greetings[0].match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/)[1]).地点.名称,'车站')
 const bytes=await f.resources.readText(result.targetPath)
 assert.deepEqual(await restored.draft(f.commitArgs()),result)
 assert.equal(await f.resources.readText(result.targetPath),bytes)
 assert.equal(await f.resources.readText(f.sourcePath),source)
 assert.equal((await f.resources.list('card')).length,2)
})
test('不自动共用开场，定制美化不能用 fields 冒充，未完成草稿不生成成品',async t=>{
 const f=await fixture(t)
 await f.patch('fields',{'/位置':'大厅'})
 await f.patch('rules',{位置:'按正文更新'})
 await f.patch('appearance',{fields:[]})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 await assert.rejects(f.conversion.draft(f.commitArgs()),error=>error.code==='DRAFT_INCOMPLETE'&&error.details.issues.some(x=>x.openingId==='opening-1')&&error.details.issues.some(x=>x.section==='appearance'))
 assert.equal((await f.resources.list('card')).length,1)
 assert.equal((await f.read()).saved,true)
})
test('规则和单开场修改保留美化，新增字段后重新要求补齐所有开场',async t=>{
 const f=await fixture(t);await f.complete()
 const original=(await f.conversion.draft({action:'read',draftId:f.current.draftId,path:'/definition/appearance/html'})).reading.text
 await f.patch('rules',{场景:'仅根据已发生事实更新'})
 assert.equal((await f.conversion.draft({action:'read',draftId:f.current.draftId,path:'/definition/appearance/html'})).reading.text,original)
 await f.patch('fields',{'/天气':'晴'})
 const state=await f.read()
 assert.ok(state.missing.some(x=>x.openingId==='opening-0'&&x.path==='/天气'))
 assert.ok(state.missing.some(x=>x.openingId==='opening-1'&&x.path==='/天气'))
 assert.ok(state.missing.some(x=>x.section==='review'))
 assert.ok(state.missing.some(x=>x.section==='appearance'&&x.missingPaths?.includes('/天气')))
})
test('版本冲突不覆盖草稿，相同请求幂等，复用请求 ID 改参数被拒绝',async t=>{
 const f=await fixture(t),base=f.current
 const args={action:'patch',draftId:base.draftId,draftRevision:base.draftRevision,requestId:'stable',section:'fields',values:{'/位置':'大厅'}}
 const first=await f.conversion.draft(args)
 assert.deepEqual(await f.conversion.draft(args),first)
 await assert.rejects(f.conversion.draft({...args,values:{'/位置':'车站'}}),e=>e.code==='DRAFT_REQUEST_REUSED')
 await assert.rejects(f.conversion.draft({...args,requestId:'new'}),e=>e.code==='DRAFT_REVISION_CONFLICT')
 const other=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const attempts=await Promise.allSettled([f.conversion,other].map((c,i)=>c.draft({...args,draftRevision:first.draftRevision,requestId:'parallel-'+i})))
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1)
})
test('源卡变化、重叠字段和危险路径均不覆盖资源',async t=>{
 const f=await fixture(t);await f.complete()
 await assert.rejects(f.patch('fields',{'/__proto__/polluted':true}))
 await assert.rejects(f.patch('fields',{'/地点':{},'/地点/名称':'车站'}),e=>e.code==='DRAFT_PATH_OVERLAP')
 const doc=await f.resources.readCard(f.sourcePath);cardData(doc).description='外部更新'
 await f.resources.writeWorking(f.sourcePath,JSON.stringify(doc))
 await assert.rejects(f.conversion.draft(f.commitArgs()),e=>e.code==='DRAFT_SOURCE_CHANGED')
 assert.equal((await f.resources.list('card')).length,1)
})
test('明确选择基础面板才可提交，工具 JSON 回执与角色限制可用',async t=>{
 const f=await fixture(t,{begin:{appearanceRequirement:'basic',basicReason:'用户明确要求基础面板'}})
 await f.patch('fields',{'/位置':'大厅'})
 for(const openingId of ['opening-0','opening-1'])await f.patch('opening',undefined,{openingId,inheritInitialState:true})
 await f.patch('rules',{位置:'按正文更新'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const tools=new Map();let mode='story'
 registerMvuConversionTools({tools:{register:x=>tools.set(x.name,x)},defineTool:x=>x,conversion:f.conversion,chatForSession:async()=>({mode})})
 const tool=tools.get('tavern_card_draft')
 await assert.rejects(tool.execute(f.commitArgs(),{}),/工作台/)
 mode='card'
 const {report}=await tool.execute(f.commitArgs(),{})
 assert.equal(report.receipt.validation.valid,true)
 assert.deepEqual(JSON.parse(JSON.stringify(report)),report)
})
test('成品写入后回执失败可恢复，提交中禁止修改草稿，重试不丢结果',async t=>{
 const f=await fixture(t);await f.complete()
 let failOnce=true
 const failing=createMvuConversion({resources:{...f.resources,saveMvuCard:async args=>{
  const result=await f.resources.saveMvuCard(args)
  if(failOnce){failOnce=false;throw Error('模拟提交后连接中断')}
  return result
 }}})
 await assert.rejects(failing.draft(f.commitArgs()),e=>e.details.commitState==='unknown'&&e.details.saved===true)
 const pending=await f.read()
 assert.equal(pending.phase,'committing');assert.equal(pending.pendingCommit.requestId,'commit')
 const bytes=await f.resources.readText(pending.targetPath);assert.ok(bytes)
 await assert.rejects(f.patch('rules',{场景:'不应写入'}),e=>e.code==='DRAFT_COMMIT_PENDING')
 const resumed=await createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})}).draft(f.commitArgs())
 assert.equal(resumed.phase,'committed');assert.equal(resumed.receipt.validation.valid,true)
 assert.equal(await f.resources.readText(pending.targetPath),bytes)
})
test('更新现有副本只改选定开场，保留既有美化及另一个开场',async t=>{
 const f=await fixture(t);await f.complete()
 const first=await f.conversion.draft(f.commitArgs()),before=cardData(await f.resources.readCard(first.targetPath)).extensions.dsh_mvu_conversion
 let d=await f.conversion.draft({action:'begin',sourcePath:f.sourcePath,requestId:'second'})
 d=await f.conversion.draft({action:'patch',draftId:d.draftId,draftRevision:d.draftRevision,requestId:'opening',section:'opening',openingId:'opening-1',values:{'/地点/名称':'码头'}})
 d=await f.conversion.draft({action:'patch',draftId:d.draftId,draftRevision:d.draftRevision,requestId:'review',section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}})
 const result=await f.conversion.draft({action:'commit',draftId:d.draftId,draftRevision:d.draftRevision,requestId:'finish'})
 assert.equal(result.receipt.validation.valid,true)
 const after=cardData(await f.resources.readCard(result.targetPath)).extensions.dsh_mvu_conversion
 assert.equal(after.updateRules,before.updateRules)
 assert.deepEqual(after.appearance,before.appearance)
 assert.deepEqual(after.openingStates[0],before.openingStates[0]);assert.equal(after.openingStates[1].地点.名称,'码头')
})
test('目标被抢占时拒绝提交，保存的草稿仍可读取',async t=>{
 const f=await fixture(t);await f.complete()
 const card={name:'他人资源',first_mes:'保留'}
 await f.resources.writeWorking(f.current.targetPath,JSON.stringify(card))
 await assert.rejects(f.conversion.draft(f.commitArgs()),e=>e.code==='DRAFT_INCOMPLETE'&&e.details.issues.some(x=>x.code==='DRAFT_TARGET_CHANGED'))
 assert.equal(await f.resources.readText(f.current.targetPath),JSON.stringify(card))
 assert.equal((await f.read()).phase,'editing')
})
test('工具真实 DSH 参数定义和无损 JSON 回执覆盖草稿、错误与最终提交',{skip:!process.env.DSH_BOOT_MODULE},async t=>{
 const {pathToFileURL}=await import('node:url'),root=pathToFileURL(process.env.DSH_BOOT_MODULE)
 const {defineTool,validateJsonSchemaValue}=await import(new URL('../../dsh-tools/lib/index.js',root))
 const {snapshotJsonValue}=await import(new URL('../../dsh-util-values/lib/index.js',root))
 const f=await fixture(t),registered=new Map()
 registerMvuConversionTools({tools:{register:x=>registered.set(x.name,x)},defineTool,conversion:f.conversion,chatForSession:async()=>({mode:'card'})})
 const tool=registered.get('tavern_card_draft')
 async function invoke(args) {
  const result=await tool.execute(args,{})
  assert.notEqual(snapshotJsonValue(result),undefined)
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema,result),[])
  assert.notEqual(snapshotJsonValue(tool.output.render(args,result)),undefined)
  return result.report
 }
 await invoke({action:'read',draft:f.current.draft})
 assert.equal((await invoke({action:'commit',draft:f.current.draft})).error.code,'DRAFT_INCOMPLETE')
 await f.complete()
 assert.equal((await invoke({action:'commit',draft:f.current.draft})).receipt.validation.valid,true)
})
test('显式调整美化要求保留已填写内容，降级必须有依据',async t=>{
 const f=await fixture(t);await f.complete()
 await assert.rejects(f.patch('requirements',{appearanceRequirement:'basic'}),e=>e.code==='DRAFT_REQUIREMENT_INVALID')
 await f.patch('requirements',{appearanceRequirement:'basic',basicReason:'用户更改要求为基础面板'})
 assert.equal(f.current.progress.appearanceRequirement,'basic')
 assert.equal(f.current.progress.appearanceSaved,true)
 assert.ok(f.current.progress.openings.every(x=>x.filled))
 assert.ok(f.current.missing.some(x=>x.section==='review'))
})
test('草稿保留原美化，按来源映射复制不同开场值，清理仅作用于副本',async t=>{
 const f=await fixture(t,{card:{first_mes:'开场甲<位置>大厅</位置>',alternate_greetings:['开场乙<位置>车站</位置>'],extensions:{regex_scripts:[{id:'old',findRegex:'/<位置>(.*?)<\\/位置>/g',replaceString:'<section class="original-skin"><strong>位置</strong><span>$1</span></section>',placement:[2],markdownOnly:true}]}}})
 assert.equal(f.current.progress.appearanceRequirement,'preserve')
 const mappings=f.current.stateInventory.map(item=>({sourceId:item.id,path:'/位置'}))
 await f.patch('fields',{'/位置':''})
 for(const openingId of ['opening-0','opening-1'])await f.patch('opening',undefined,{openingId,inheritInitialState:true})
 await f.patch('rules',{位置:'只根据正文移动更新'})
 await f.patch('mapping',{fieldMappings:mappings})
 await f.patch('appearance',{sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:[{capture:1,path:'/位置'}]})
 await f.patch('fields',undefined,{operation:'move',path:'/位置',toPath:'/场景/位置'})
 assert.ok((await draftValue(f,['definition','fieldMappings'])).every(x=>x.path==='/场景/位置'))
 await f.patch('cleanup',[{op:'remove',path:'/extensions/regex_scripts/0'},...['/first_mes','/alternate_greetings/0'].map(path=>({op:'replaceBlock',path,start:'<位置>',end:'</位置>',value:''}))])
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const result=await f.conversion.draft(f.commitArgs())
 assert.equal(result.receipt.validation.valid,true)
 const meta=cardData(await f.resources.readCard(result.targetPath)).extensions.dsh_mvu_conversion
 assert.equal(meta.openingStates[0].场景.位置,'大厅');assert.equal(meta.openingStates[1].场景.位置,'车站')
 assert.match(meta.frozenAppearance.html,/original-skin/)
 assert.equal(cardData(await f.resources.readCard(f.sourcePath)).extensions.regex_scripts.length,1)
})

async function draftValue(f,path) {
 const draft=await f.resources.readMvuDraft(f.current.draftId)
 return path.reduce((node,key)=>node[key],draft)
}
test('字段目录隔离开场值，错层级及类型在保存前拒绝，失败不改变版本',async t=>{
 const f=await fixture(t);await f.complete();const before=await f.read()
 await assert.rejects(f.patch('opening',{'/时段':'夜晚'},{openingId:'opening-1'}),e=>e.code==='DRAFT_FIELD_UNKNOWN'&&e.details.issues.some(x=>x.suggestedPaths?.includes('/时间/时段')))
 await assert.rejects(f.patch('opening',{'/时间/时段':3},{openingId:'opening-1'}),e=>e.code==='DRAFT_FIELD_TYPE')
 assert.deepEqual(await f.read(),before)
 assert.equal(before.fieldSchema.fields.find(x=>x.path==='/时间/时段').type,'string')
})
test('反复继承只补缺失字段，新增目录字段不覆盖场景值，目录版本只跟随结构变化',async t=>{
 const f=await fixture(t);await f.complete();const revision=f.current.fieldSchema.revision
 await f.patch('fields',{'/天气':'晴'})
 assert.equal(f.current.fieldSchema.revision,revision+1)
 await f.patch('fields',{'/天气':'阴'})
 assert.equal(f.current.fieldSchema.revision,revision+1)
 await f.patch('opening',undefined,{openingId:'opening-1',inheritInitialState:true})
 const state=await draftValue(f,['definition','openingStates',1])
 assert.deepEqual(state,{时间:{时段:'夜晚'},地点:{名称:'车站'},天气:'阴'})
 await f.patch('opening',undefined,{openingId:'opening-1',inheritInitialState:true})
 assert.deepEqual(await draftValue(f,['definition','openingStates',1]),state)
})
test('对象合并保留兄弟键，null 是值，删除需明确操作并保护绑定依赖',async t=>{
 const f=await fixture(t)
 await f.patch('fields',{'/场景':{日期:'今天',时段:'白天',备注:null}})
 await assert.rejects(f.patch('fields',{'/场景':{日期:'明天'}}),e=>e.code==='DRAFT_FIELD_REMOVAL_REQUIRED')
 await f.patch('fields',{'/场景':{日期:'明天'}},{operation:'merge'})
 assert.deepEqual(await draftValue(f,['definition','initialState','场景']),{日期:'明天',时段:'白天',备注:null})
 await f.patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
 await f.patch('fields',undefined,{operation:'remove',path:'/场景/备注'})
 assert.equal(Object.hasOwn(await draftValue(f,['definition','openingStates',0,'场景']),'备注'),false)
 await f.patch('appearance',{html:'<mvu-field path="/场景/日期"></mvu-field>'})
 await assert.rejects(f.patch('fields',undefined,{operation:'remove',path:'/场景/日期'}),e=>e.code==='DRAFT_FIELD_REFERENCED')
 const malicious=JSON.parse('{"/场景":{"__proto__":{"polluted":true}}}')
 await assert.rejects(f.patch('fields',malicious,{operation:'merge'}),e=>e.code==='DRAFT_PATH_INVALID')
 assert.equal({}.polluted,undefined)
})
test('字段移动同步全部开场与组件路径，碰撞保持草稿不变，可提交',async t=>{
 const f=await fixture(t);await f.complete()
 await f.patch('fields',undefined,{operation:'move',path:'/时间/时段',toPath:'/场景/时段'})
 assert.equal(f.current.ruleReviewRequired,true)
 const definition=await draftValue(f,['definition'])
 assert.equal(definition.openingStates[1].场景.时段,'夜晚')
 assert.equal(Object.hasOwn(definition.openingStates[1],'时间'),false)
 assert.match(definition.appearance.html,/path="\/场景\/时段"/)
 assert.ok(f.current.fieldSchema.fields.some(x=>x.path==='/场景/时段'))
 const before=await f.read()
 await assert.rejects(f.patch('fields',undefined,{operation:'move',path:'/场景/时段',toPath:'/地点/名称'}),e=>e.code==='DRAFT_FIELD_COLLISION')
 assert.deepEqual(await f.read(),before)
 await f.patch('rules',{场景:'按正文更新场景中的时段与地点名称'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 assert.equal((await f.conversion.draft(f.commitArgs())).receipt.validation.valid,true)
})
test('已有成品字段改名同步编译后的绑定并允许明确迁移，兼容接口仍保护未声明删字段',async t=>{
 const f=await fixture(t);await f.complete();await f.conversion.draft(f.commitArgs())
 let draft=await f.conversion.draft({action:'begin',sourcePath:f.sourcePath,requestId:'rename-existing'})
 const patch=async(section,values,extra={})=>draft=await f.conversion.draft({action:'patch',draftId:draft.draftId,draftRevision:draft.draftRevision,requestId:String(draft.draftRevision),section,values,...extra})
 await patch('fields',undefined,{operation:'move',path:'/时间',toPath:'/场景'})
 const saved=await f.resources.readMvuDraft(draft.draftId)
 assert.equal(saved.definition.appearance.bindings[0].path,'/场景/时段')
 await patch('rules',{场景:'按正文更新场景时段'})
 await patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const result=await f.conversion.draft({action:'commit',draftId:draft.draftId,draftRevision:draft.draftRevision,requestId:'commit-renamed'})
 assert.equal(result.receipt.validation.valid,true)
 const meta=cardData(await f.resources.readCard(result.targetPath)).extensions.dsh_mvu_conversion
 assert.equal(meta.openingStates[1].场景.时段,'夜晚')
 const info=await f.conversion.convert({action:'inspect',sourcePath:f.sourcePath})
 const reduced=await f.conversion.convert({action:'saveDefinition',sourcePath:f.sourcePath,sourceRevision:info.sourceRevision,initialState:{地点:{名称:'大厅'}},openingStates:[{地点:{名称:'大厅'}},{地点:{名称:'车站'}}],updateRules:'按正文更新'})
 await assert.rejects(f.conversion.convert({action:'preview',sourcePath:f.sourcePath,sourceRevision:info.sourceRevision,targetRevision:info.targetRevision,definitionRevision:reduced.definitionRevision,planMode:'replace'}),/不能减少已保存字段/)
})
test('孤立入口清理设置持久保留，同一路径正文修改不阻止清理，验证给出实际操作',async t=>{
 const f=await fixture(t,{card:{first_mes:'大厅开场\n<mvu-status/>'}});await f.complete()
 await f.patch('cleanup',[],{cleanupOrphanEntrances:true})
 await f.patch('cleanup',[{op:'replaceText',path:'/first_mes',expected:'大厅开场',value:'大厅开始'}])
 const validation=(await f.conversion.draft({action:'validate',draftId:f.current.draftId,draftRevision:f.current.draftRevision})).validation
 assert.equal(validation.effectiveCleanup.length,2)
 assert.ok(validation.issues.some(x=>x.section==='review'))
 assert.ok(!validation.issues.some(x=>x.code==='MVU_ORPHAN_ENTRANCE'))
 await assert.rejects(f.conversion.draft({...f.commitArgs(),cleanupOrphanEntrances:true}),e=>e.code==='DRAFT_ARGUMENT_INVALID')
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const result=await f.conversion.draft(f.commitArgs())
 assert.equal(result.receipt.validation.valid,true)
 const card=cardData(await f.resources.readCard(result.targetPath))
 assert.match(card.first_mes,/大厅开始/)
 assert.equal(card.first_mes.split('<mvu-status/>').length-1,1)
 assert.equal(cardData(await f.resources.readCard(f.sourcePath)).first_mes,'大厅开场\n<mvu-status/>')
})
test('未做 review 也汇总独立的清理问题，不把参数错位当成无效果',async t=>{
 const f=await fixture(t,{card:{first_mes:'大厅开场\n<mvu-status/>'}})
 const result=await f.conversion.draft({action:'validate',draftId:f.current.draftId,draftRevision:f.current.draftRevision})
 assert.ok(result.validation.issues.some(x=>x.code==='MVU_ORPHAN_ENTRANCE'))
 assert.ok(result.validation.issues.some(x=>x.section==='review'))
 await assert.rejects(f.patch('rules',{规则:'正文'},{inheritInitialState:true}),e=>e.code==='DRAFT_ARGUMENT_INVALID')
})
test('无目录旧草稿读取可诊断多余字段，显式删除可恢复而无需扩大面板',async t=>{
 const f=await fixture(t);await f.complete()
 await f.resources.updateMvuDraft(f.current.draftId,draft=>{delete draft.fieldSchema;draft.definition.openingStates[1].时段='多余';return draft})
 const report=await f.read()
 assert.ok(report.missing.some(x=>x.code==='DRAFT_FIELD_UNKNOWN'&&x.path==='/时段'))
 await f.patch('opening',{'/时间/时段':'凌晨'},{openingId:'opening-1'})
 assert.ok(f.current.missing.some(x=>x.code==='DRAFT_FIELD_UNKNOWN'))
 await f.patch('fields',undefined,{operation:'remove',path:'/时段'})
 assert.equal((await draftValue(f,['definition','openingStates',1])).时间.时段,'凌晨')
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 assert.equal((await f.conversion.draft(f.commitArgs())).receipt.validation.valid,true)
})
test('数组作为完整字段允许各开场不同长度，不把首个开场下标当成必填字段',async t=>{
 const f=await fixture(t,{begin:{appearanceRequirement:'basic',basicReason:'用户要求基础面板'}})
 await f.patch('fields',{'/记录':['入口','大厅'],'/位置':'大厅'})
 await assert.rejects(f.patch('fields',undefined,{operation:'remove',path:'/记录/0'}),e=>e.code==='DRAFT_PATH_INVALID')
 await f.patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
 await f.patch('opening',{'/记录':[],'/位置':'车站'},{openingId:'opening-1'})
 await f.patch('rules',{记录:'按发生事件追加'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 assert.equal((await f.conversion.draft(f.commitArgs())).receipt.validation.valid,true)
 let next=await f.conversion.draft({action:'begin',sourcePath:f.sourcePath,requestId:'shorter-array',appearanceRequirement:'basic',basicReason:'用户继续使用基础面板'})
 next=await f.conversion.draft({action:'patch',draftId:next.draftId,draftRevision:next.draftRevision,requestId:'shorten',section:'opening',openingId:'opening-0',values:{'/记录':[]}})
 next=await f.conversion.draft({action:'patch',draftId:next.draftId,draftRevision:next.draftRevision,requestId:'review-shorter',section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}})
 assert.equal((await f.conversion.draft({action:'commit',draftId:next.draftId,draftRevision:next.draftRevision,requestId:'commit-shorter'})).receipt.validation.valid,true)
})

test('美化非法路径以可修复诊断返回，不在草稿已保存后抛出读取异常',async t=>{
 const f=await fixture(t);await f.patch('fields',{'/位置':'大厅'})
 const result=await f.patch('appearance',{html:'<mvu-field path="not-a-pointer"></mvu-field>'})
 assert.ok(result.missing.some(x=>x.code==='DRAFT_APPEARANCE_INVALID'))
 assert.equal((await f.read()).draftRevision,result.draftRevision)
})

test('简化凭据自动管理版本与重试，JSON 键顺序不同仍幂等，旧凭据不能覆盖',async t=>{
 const f=await fixture(t)
 const begin={action:'begin',sourcePath:f.sourcePath}
 const a=await f.conversion.draft(begin)
 assert.equal((await f.conversion.draft(begin)).draft,a.draft)
 const patch={action:'patch',draft:a.draft,section:'fields',values:{'/位置':'大厅','/日期':'今天'}}
 const b=await f.conversion.draft(patch)
 assert.equal((await f.conversion.draft({values:{'/日期':'今天','/位置':'大厅'},section:'fields',draft:a.draft,action:'patch'})).draft,b.draft)
 const reopened=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 assert.equal((await reopened.draft(patch)).draft,b.draft)
 await assert.rejects(reopened.draft({...patch,values:{'/位置':'外部覆盖'}}),e=>e.code==='DRAFT_REVISION_CONFLICT')
 assert.equal((await reopened.draft({action:'read',draft:a.draft})).draft,b.draft)
 await assert.rejects(reopened.draft({action:'read',draft:a.draft,path:'/definition'}),e=>e.code==='DRAFT_REVISION_CONFLICT')
 await assert.rejects(reopened.draft({action:'read',draft:'broken'}),e=>e.code==='DRAFT_TOKEN_INVALID')
 await assert.rejects(reopened.draft({action:'read',draft:b.draft,draftRevision:2}),e=>e.code==='DRAFT_ARGUMENT_INVALID')
})
test('简化凭据读取来源与清单，检查与提交只传 action 和 draft，丢失提交回执仍恢复',async t=>{
 const f=await fixture(t);await f.complete()
 const source=await f.conversion.draft({action:'source',draft:f.current.draft,path:'/first_mes'})
 assert.equal(source.source.text,'大厅开场')
 const inventory=await f.conversion.draft({action:'inspect',draft:f.current.draft})
 assert.ok(Array.isArray(inventory.stateInventory))
 assert.equal((await f.conversion.draft({action:'validate',draft:f.current.draft})).validation.valid,true)
 const save=f.resources.saveMvuCard;let lost=false
 const failing=createMvuConversion({resources:{...f.resources,saveMvuCard:async args=>{const result=await save(args);if(!lost){lost=true;throw Error('模拟丢失回执')}return result}}})
 const commit={action:'commit',draft:f.current.draft}
 await assert.rejects(failing.draft(commit),e=>e.details.commitState==='unknown')
 const restored=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const result=await restored.draft(commit)
 assert.equal(result.receipt.validation.valid,true)
 assert.deepEqual(await restored.draft(commit),result)
 const begin=await restored.draft({action:'begin',sourcePath:f.sourcePath})
 assert.equal(begin.phase,'editing')
 assert.notEqual(begin.draft,result.draft)
})
test('简化工具 schema 不暴露版本和请求参数，回执保留同名用户字段',async t=>{
 const f=await fixture(t),registered=new Map()
 registerMvuConversionTools({tools:{register:x=>registered.set(x.name,x)},defineTool:x=>x,conversion:f.conversion,chatForSession:async()=>({mode:'card'})})
 const tool=registered.get('tavern_card_draft')
 for(const key of ['requestId','draftId','draftRevision','sourceRevision','definitionRevision'])assert.equal(Object.hasOwn(tool.parameters,key),false)
 let result=(await tool.execute({action:'begin',sourcePath:f.sourcePath},{})).report
 assert.equal(Object.hasOwn(result,'sourceRevision'),false)
 assert.ok(result.draft)
 result=(await tool.execute({action:'patch',draft:result.draft,section:'rules',values:{requestId:'保留用户规则'}},{})).report
 const read=(await tool.execute({action:'read',draft:result.draft,path:'/rules/requestId'},{})).report
 assert.equal(read.reading.text,'保留用户规则')
})

test('自动 begin 在无改动提交后仍可建立新草稿，来源改变不会隐式替换旧草稿快照',async t=>{
 const f=await fixture(t);await f.complete();await f.conversion.draft(f.commitArgs())
 const args={action:'begin',sourcePath:f.sourcePath}
 let next=await f.conversion.draft(args)
 next=await f.conversion.draft({action:'patch',draft:next.draft,section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}})
 const done=await f.conversion.draft({action:'commit',draft:next.draft})
 const reopened=await f.conversion.draft(args)
 assert.equal(reopened.phase,'editing');assert.notEqual(reopened.draft,done.draft)
 const card=await f.resources.readCard(f.sourcePath);cardData(card).description='来源被外部修改'
 await f.resources.writeWorking(f.sourcePath,JSON.stringify(card))
 await assert.rejects(f.conversion.draft({action:'source',draft:reopened.draft,path:'/description'}),e=>e.code==='DRAFT_SOURCE_CHANGED')
})

test('简单卡转换接受日志中的省略根斜杠路径，保留正文和无关扩展，九步完成提交',async t=>{
 const f=await fixture(t,{card:{description:'作者设定保持原样。',personality:'沉稳',scenario:'旅途中',first_mes:'大厅开场\n<mvu-status/>',extensions:{author_note:{keep:true}}}})
 const original=await f.resources.readText(f.sourcePath)
 let calls=1;const run=f.conversion.draft
 f.conversion.draft=(...args)=>{calls++;return run(...args)}
 // Same argument shape as the repeated diagnostic failures; neutral values.
 await f.patch('fields',{'时间/时段':'白天','地点/名称':'大厅','$meta':{extensible:true}})
 await f.patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
 await f.patch('opening',{'时间/时段':'夜晚','地点/名称':'车站'},{openingId:'opening-1',inheritInitialState:true})
 await f.patch('rules',{场景:'按正文已经发生的移动更新时间地点'})
 await f.patch('appearance',{html:'<section><h2>旅途</h2><mvu-field path="/时间/时段"></mvu-field><mvu-field path="/地点/名称"></mvu-field></section>'})
 await f.patch('cleanup',[],{cleanupOrphanEntrances:true})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 const result=await f.conversion.draft(f.commitArgs())
 assert.equal(result.receipt.validation.valid,true)
 const output=cardData(await f.resources.readCard(result.targetPath)),source=cardData(await f.resources.readCard(f.sourcePath))
 for(const key of ['description','personality','scenario'])assert.equal(output[key],source[key])
 assert.deepEqual(output.extensions.author_note,source.extensions.author_note)
 assert.ok(output.first_mes.startsWith('大厅开场'))
 assert.ok(output.alternate_greetings[0].startsWith('车站开场'))
 assert.equal(await f.resources.readText(f.sourcePath),original)
 assert.equal(output.extensions.dsh_mvu_conversion.openingStates[1].地点.名称,'车站')
 assert.equal(calls,9)
})
test('根斜杠规范化仍拒绝冲突、父子重叠与危险路径，不保存半次修改',async t=>{
 const f=await fixture(t),before=await f.read()
 await assert.rejects(f.patch('fields',{'位置':'大厅','/位置':'车站'}),e=>e.code==='DRAFT_PATH_COLLISION')
 await assert.rejects(f.patch('fields',{'时间':{},'/时间/时段':'白天'}),e=>e.code==='DRAFT_PATH_OVERLAP')
 await assert.rejects(f.patch('fields',{'__proto__/polluted':true}),e=>e.code==='DRAFT_PATH_INVALID')
 assert.equal({}.polluted,undefined)
 assert.deepEqual(await f.read(),before)
})

test('会话默认草稿省略凭据，短编号持久化且隔离其他会话',async t=>{
 const f=await fixture(t),context={sessionId:'short-session'}
 const begin=await f.conversion.draft({action:'begin',sourcePath:f.sourcePath},context)
 assert.equal(begin.draft,'d1')
 await f.conversion.draft({action:'patch',section:'fields',values:{'/地点':'大厅'}},context)
 const next=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 assert.equal((await next.draft({action:'read',path:'/definition/initialState/地点'},context)).reading.text,'大厅')
 assert.equal((await next.draft({action:'source',path:'/first_mes'},context)).source.text,'大厅开场')
 await assert.rejects(next.draft({action:'read'},{sessionId:'other-session'}),e=>e.code==='DRAFT_NOT_SELECTED')
 await assert.rejects(next.draft({action:'read',draft:'d9'},context),e=>e.code==='DRAFT_NOT_SELECTED')
 const other=await next.draft({action:'begin',sourcePath:f.sourcePath},{sessionId:'other-session'})
 assert.equal(other.draft,'d1');assert.notEqual(other.draftId,begin.draftId)
})
test('短编号显式切换草稿，迟到的工具调用重放不会切换当前草稿',async t=>{
 const f=await fixture(t),context={sessionId:'multiple'}
 await f.conversion.draft({action:'begin',sourcePath:f.sourcePath,name:'A'},{...context,callId:'begin-a'})
 const args={action:'begin',sourcePath:f.sourcePath,name:'B'}
 assert.equal((await f.conversion.draft(args,{...context,callId:'begin-b'})).draft,'d2')
 await f.conversion.draft({action:'read',draft:'d1'},context)
 assert.equal((await f.conversion.draft(args,{...context,callId:'begin-b'})).draft,'d2')
 const current=await f.conversion.draft({action:'read'},context)
 assert.equal(current.draft,'d1');assert.equal(current.drafts.length,2)
})
test('会话只使用已读版本，冲突不自动刷新，read 后才允许继续',async t=>{
 const f=await fixture(t),context={sessionId:'conflict'}
 const begin=await f.conversion.draft({action:'begin',sourcePath:f.sourcePath},context)
 await f.conversion.draft({action:'patch',draftId:begin.draftId,draftRevision:begin.draftRevision,requestId:'external',section:'fields',values:{'/地点':'外部修改'}})
 const patch={action:'patch',section:'fields',values:{'/地点':'新值'}}
 for(let i=0;i<2;i++)await assert.rejects(f.conversion.draft(patch,context),e=>e.code==='DRAFT_REVISION_CONFLICT'&&e.details.draft==='d1')
 await f.conversion.draft({action:'read'},context)
 await f.conversion.draft(patch,context)
 assert.equal((await f.conversion.draft({action:'read',path:'/definition/initialState/地点'},context)).reading.text,'新值')
})
test('无凭据写入跨重启去重，迟到重放不吞掉之后的正常修改',async t=>{
 const f=await fixture(t),context={sessionId:'retry'}
 await f.conversion.draft({action:'begin',sourcePath:f.sourcePath},context)
 const patch={action:'patch',section:'fields',values:{'/地点':'大厅'}}
 const a=await f.conversion.draft(patch,{...context,callId:'a'})
 const restarted=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const repeat=await restarted.draft(patch,context)
 assert.equal(repeat.draftRevision,a.draftRevision)
 await restarted.draft({...patch,values:{'/地点':'车站'}},{...context,callId:'b'})
 await restarted.draft(patch,{...context,callId:'a'})
 await restarted.draft(patch,{...context,callId:'c'})
 assert.equal((await restarted.draft({action:'read',path:'/definition/initialState/地点'},context)).reading.text,'大厅')
 const move={action:'patch',section:'fields',operation:'move',path:'/地点',toPath:'/位置'}
 const moved=await restarted.draft(move,context)
 assert.equal((await restarted.draft(move,context)).draftRevision,moved.draftRevision)
})
test('无凭据提交回执丢失后恢复，重复提交不重新改写成品',async t=>{
 const f=await fixture(t);await f.complete();await f.conversion.draft(f.commitArgs())
 const context={sessionId:'recover-commit'}
 await f.conversion.draft({action:'begin',sourcePath:f.sourcePath},context)
 await f.conversion.draft({action:'patch',section:'opening',openingId:'opening-1',values:{'/地点/名称':'码头'}},context)
 await f.conversion.draft({action:'patch',section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}},context)
 let failed=false
 const interrupted=createMvuConversion({resources:{...f.resources,saveMvuCard:async args=>{const result=await f.resources.saveMvuCard(args);if(!failed){failed=true;throw Error('模拟回执丢失')}return result}}})
 await assert.rejects(interrupted.draft({action:'commit'},context),e=>e.details.commitState==='unknown')
 const restarted=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const result=await restarted.draft({action:'commit'},context)
 assert.equal(result.receipt.validation.valid,true)
 const bytes=await f.resources.readText(result.targetPath)
 await restarted.draft({action:'commit'},context)
 assert.equal(await f.resources.readText(result.targetPath),bytes)
})
test('同会话并发修改不会用另一次调用推进的版本静默覆盖',async t=>{
 const f=await fixture(t),context={sessionId:'parallel-short'}
 await f.conversion.draft({action:'begin',sourcePath:f.sourcePath},context)
 const other=createMvuConversion({resources:createFileResourceStore({dataRoot:f.root})})
 const results=await Promise.allSettled([f.conversion,other].map((conversion,index)=>conversion.draft({action:'patch',section:'fields',values:{'/地点':String(index)}},context)))
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
 assert.equal(results.find(x=>x.status==='rejected').reason.code,'DRAFT_SESSION_CHANGED')
})

test('工具入口自动注入会话及调用标识，输入省略 draft，输出仅有短编号',async t=>{
 const f=await fixture(t,{card:{extensions:{author_note:'保留'}}}),tools=new Map()
 registerMvuConversionTools({tools:{register:tool=>tools.set(tool.name,tool)},defineTool:x=>x,conversion:f.conversion,chatForSession:async id=>({mode:id==='tool-session'?'card':'story'})})
 const tool=tools.get('tavern_card_draft'),exec={agent:{session:{id:'tool-session'}}}
 const begin=await tool.execute({action:'begin',sourcePath:f.sourcePath},{...exec,callId:'begin'})
 assert.equal(begin.report.draft,'d1');assert.equal(Object.hasOwn(begin.report,'draftId'),false)
 assert.equal((await tool.execute({action:'begin',sourcePath:f.sourcePath},{...exec,callId:'begin-again'})).report.draft,'d1')
 const patch={action:'patch',section:'fields',values:{'/位置':'大厅'}}
 await tool.execute(patch,{...exec,callId:'patch'})
 await tool.execute(patch,{...exec,callId:'patch'})
 const read=await tool.execute({action:'source',path:'/extensions'},{...exec,callId:'source'})
 assert.equal(read.report.draft,'d1')
 const stored=await f.resources.readMvuDraftSession('tool-session')
 assert.equal((await f.resources.readMvuDraft(stored.drafts.d1.id)).revision,2)
 assert.equal(Object.hasOwn(stored.calls[Object.keys(stored.calls)[1]],'args'),false)
})

test('从目标路径编辑已保存 MVU 卡，局部初值修改保留其他开场、外观与来源',async t=>{
 const f=await fixture(t);await f.complete()
 const first=await f.conversion.draft(f.commitArgs())
 const before=cardData(await f.resources.readCard(first.targetPath)),source=await f.resources.readText(f.sourcePath)
 const context={sessionId:'edit-existing'}
 await f.conversion.draft({action:'begin',path:first.targetPath},context)
 await f.conversion.draft({action:'patch',section:'opening',openingId:'opening-1',values:{'/地点/名称':'公园'}},context)
 await f.conversion.draft({action:'patch',section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}},context)
 const edited=await f.conversion.draft({action:'commit'},context)
 assert.equal(edited.receipt.validation.valid,true)
 assert.equal(edited.targetPath,first.targetPath)
 const after=cardData(await f.resources.readCard(first.targetPath))
 assert.equal(after.description,before.description)
 assert.equal(after.first_mes,before.first_mes)
 assert.match(after.alternate_greetings[0],/公园/)
 assert.equal(await f.resources.readText(f.sourcePath),source)
 assert.equal((await f.resources.list('card')).length,2)
 await assert.rejects(f.conversion.draft({action:'begin',path:first.targetPath,sourcePath:f.sourcePath},context),e=>e.code==='DRAFT_ARGUMENT_INVALID')
 await assert.rejects(f.conversion.draft({action:'begin',path:f.sourcePath},context),/托管 MVU/)
})

test('已有卡增删变量复用草稿检查，所有开场同步且原文保留',async t=>{
 const f=await fixture(t);await f.complete()
 const first=await f.conversion.draft(f.commitArgs()),context={sessionId:'edit-fields'}
 await f.conversion.draft({action:'begin',path:first.targetPath},context)
 await assert.rejects(f.conversion.draft({action:'patch',section:'fields',operation:'remove',path:'/地点'},context),e=>e.code==='DRAFT_FIELD_REFERENCED')
 await f.conversion.draft({action:'patch',section:'fields',values:{'/体力':100}},context)
 for(const openingId of ['opening-0','opening-1'])await f.conversion.draft({action:'patch',section:'opening',openingId,inheritInitialState:true},context)
 await f.conversion.draft({action:'patch',section:'appearance',values:{html:'<section><h2>场景</h2><mvu-field path="/时间/时段"></mvu-field><mvu-field path="/体力"></mvu-field></section>'}},context)
 await f.conversion.draft({action:'patch',section:'fields',operation:'remove',path:'/地点'},context)
 await f.conversion.draft({action:'patch',section:'rules',values:{既有规则:'依据正文更新时间与体力'}},context)
 await f.conversion.draft({action:'patch',section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}},context)
 const result=await f.conversion.draft({action:'commit'},context)
 assert.equal(result.receipt.validation.valid,true)
 const card=cardData(await f.resources.readCard(first.targetPath))
 for(const [index,opening] of [card.first_mes,...card.alternate_greetings].entries()){
  const state=JSON.parse(opening.match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/)[1])
  assert.deepEqual(state,{时间:{时段:index?'夜晚':'白天'},体力:100})
  assert.ok(opening.includes(index?'车站开场':'大厅开场'))
 }
 assert.equal(card.description,'保留设定')
})

test('新增字段通过草稿局部 HTML 组件自动扩展捕获，成品仅在 commit 改变',async t=>{
 const f=await fixture(t);await f.complete()
 const first=await f.conversion.draft(f.commitArgs()),context={sessionId:'appearance-extension'}
 const before=await f.resources.readText(first.targetPath)
 await f.conversion.draft({action:'begin',path:first.targetPath},context)
 await f.conversion.draft({action:'patch',section:'fields',values:{'/体力':100}},context)
 for(const openingId of ['opening-0','opening-1'])await f.conversion.draft({action:'patch',section:'opening',openingId,inheritInitialState:true},context)
 await assert.rejects(f.conversion.draft({action:'patch',section:'appearance',values:{replacements:[{expected:'</section>',value:'$10</section>'}]}},context),/不要手写新的/)
 await assert.rejects(f.conversion.draft({action:'patch',section:'appearance',values:{html:{text:'bad'}}},context),/html 必须是字符串/)
 await assert.rejects(f.conversion.draft({action:'patch',section:'appearance',values:{replacements:[{expected:'missing',value:''}]}},context),/恰好出现一次/)
 const result=await f.conversion.draft({action:'patch',section:'appearance',values:{replacements:[{expected:'</section>',value:'<div>体力<mvu-field path="/体力"></mvu-field></div></section>'}]}},context)
 assert.equal(result.missing.some(issue=>issue.section==='appearance'),false)
 assert.equal(await f.resources.readText(first.targetPath),before)
 await f.conversion.draft({action:'patch',section:'rules',values:{体力:'根据行动消耗体力'}},context)
 await f.conversion.draft({action:'patch',section:'review',values:{sourceCoverage:true,cleanup:true,appearance:true}},context)
 const committed=await f.conversion.draft({action:'commit'},context)
 assert.equal(committed.receipt.validation.valid,true)
 const card=cardData(await f.resources.readCard(first.targetPath))
 const appearance=card.extensions.dsh_mvu_conversion.appearance
 assert.deepEqual(appearance.bindings.map(({capture,path})=>({capture,path})),[{capture:1,path:'/时间/时段'},{capture:2,path:'/地点/名称'},{capture:3,path:'/体力'}])
 assert.equal((appearance.html.match(/体力/g)||[]).length,1)
})

test('基础面板 fields 可直接写根路径字符串；删字段与提交不因字符串项崩溃',async t=>{
 const f=await fixture(t,{begin:{appearanceRequirement:'basic',basicReason:'用户要求基础面板'}})
 await f.patch('fields',{'/位置':'大厅','/日期':'今天','/临时':''})
 await f.patch('opening',undefined,{openingId:'opening-0',inheritInitialState:true})
 await f.patch('opening',{'/位置':'车站','/日期':'明天','/临时':''},{openingId:'opening-1'})
 await assert.rejects(f.patch('appearance',{fields:true}),e=>e.code==='DRAFT_APPEARANCE_EDIT_INVALID'&&/fields 必须是数组/.test(e.message))
 await assert.rejects(f.patch('appearance',{fields:[{label:'位置'}]}),e=>e.code==='DRAFT_APPEARANCE_EDIT_INVALID')
 await f.patch('appearance',{fields:['/位置','/日期','/临时']})
 await assert.rejects(f.patch('fields',undefined,{operation:'remove',path:'/临时'}),e=>e.code==='DRAFT_FIELD_REFERENCED')
 await f.patch('appearance',{fields:['/位置','/日期']})
 await f.patch('fields',undefined,{operation:'remove',path:'/临时'})
 await f.patch('rules',{场景:'依据正文更新'})
 await f.patch('review',{sourceCoverage:true,cleanup:true,appearance:true})
 assert.equal((await f.conversion.draft(f.commitArgs())).receipt.validation.valid,true)
})
