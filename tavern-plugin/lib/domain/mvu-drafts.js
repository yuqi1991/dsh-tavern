import {patchDraftAppearance} from './mvu-draft-appearance.js'
import {createMvuDraftSession} from './mvu-draft-session.js'
import {createHash} from 'node:crypto'
import {normalizeResourcePath} from './file-resources.js'
import {isObject, MVU_CONVERSION_KEY} from './mvu-conversion-artifacts.js'
import {readConversionValue,conversionReading} from './mvu-conversion-inspection.js'
import {ensureFieldSchema,openingIssues,appearanceIssues,patchOpening,patchFields,DRAFT_FIELD_CHANGES} from './mvu-draft-fields.js'

const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value
const draftToken = (id,revision) => Buffer.from(id,'hex').toString('base64url')+'.'+revision.toString(36)
function expandToken(args) {
  if(args.draft===undefined)return args
  if(args.draftId!==undefined||args.draftRevision!==undefined||args.requestId!==undefined)fail('DRAFT_ARGUMENT_INVALID','draft 凭据不能与旧版本参数混用')
  const match=typeof args.draft==='string'&&args.draft.match(/^([A-Za-z0-9_-]{43})\.([0-9a-z]+)$/)
  if(!match)fail('DRAFT_TOKEN_INVALID','请原样使用工具返回的 draft 凭据')
  const draftId=Buffer.from(match[1],'base64url').toString('hex'),draftRevision=parseInt(match[2],36)
  if(!Number.isSafeInteger(draftRevision)||draftRevision<1||draftToken(draftId,draftRevision)!==args.draft)fail('DRAFT_TOKEN_INVALID','草稿凭据无效')
  const {draft,...rest}=args
  const expanded=canonical({...rest,draftId,draftRevision})
  if(['patch','commit'].includes(args.action))expanded.requestId='auto-'+hash(expanded)
  return expanded
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(code,message,details={}) { const error=Error(message);error.code=code;error.details=details;throw error }
function requestKey(args) {
  if(typeof args.requestId!=='string'||!args.requestId.trim()||args.requestId.length>160)fail('DRAFT_REQUEST_REQUIRED','写入需提供稳定的 requestId；响应丢失时原样重试')
  return hash(args.requestId)
}
function validateArguments(args) {
  const common=['action','draftId','draftRevision']
  const allowed={begin:['action','path','sourcePath','name','inPlace','requestId','appearanceRequirement','basicReason'],read:[...common,'path','offset','limit'],source:[...common,'path','query','offset','limit'],inspect:common,validate:common,commit:[...common,'requestId'],patch:[...common,'requestId','section','values']}
  const keys=allowed[args.action];if(!keys)fail('DRAFT_ACTION_INVALID','未知 action')
  if(args.action==='patch'){
    if(args.section==='fields')keys.push('operation','path','toPath')
    if(args.section==='opening')keys.push('openingId','inheritInitialState','operation')
    if(args.section==='cleanup')keys.push('cleanupOrphanEntrances')
    if(args.operation!==undefined&&!['set','merge','replace',...(args.section==='fields'?['move','remove']:[])].includes(args.operation))fail('DRAFT_OPERATION_INVALID','不支持的字段操作')
    if(['move','remove'].includes(args.operation)){
      if(args.values!==undefined)fail('DRAFT_ARGUMENT_INVALID','move/remove 使用 path，不接收 values')
      if(args.operation==='remove'&&args.toPath!==undefined)fail('DRAFT_ARGUMENT_INVALID','remove 不接收 toPath')
    }else if(args.path!==undefined||args.toPath!==undefined)fail('DRAFT_ARGUMENT_INVALID','path/toPath 仅用于字段 move/remove')
  }
  const ignored=Object.keys(args).filter(key=>args[key]!==undefined&&!keys.includes(key))
  if(ignored.length)fail('DRAFT_ARGUMENT_INVALID','这些参数不适用于当前 action/section',{parameters:ignored,hint:'cleanupOrphanEntrances 在 patch section=cleanup 保存，commit 使用已保存设置。'})
}

// Draft writes are durable, revision-checked and serialized across processes by
// the resource store. Final publication reuses the conversion transaction.
export function createMvuDrafts({resources,conversion}) {
  function missing(draft) {
    ensureFieldSchema(draft)
    const items=[],fields=draft.fieldSchema.fields
    if(!fields.length)items.push({section:'fields',message:'尚未定义状态字段'})
    for(const [index,state] of draft.definition.openingStates.entries())items.push(...openingIssues(draft,state,index))
    if(!Object.values(draft.rules).some(text=>text.trim()))items.push({section:'rules',message:'尚未填写更新规则'})
    items.push(...appearanceIssues(draft))
    const appearance=draft.definition.appearance
    if(draft.appearanceRequirement==='custom'&&!(typeof appearance?.html==='string'&&appearance.html.trim()))items.push({section:'appearance',message:'需要自定义 HTML 设计；fields 基础面板不满足定制要求'})
    if(draft.appearanceRequirement==='preserve'&&!appearance?.sourcePath)items.push({section:'appearance',message:'需要指定原美化 sourcePath 与 bindings'})
    if(draft.appearanceRequirement==='basic'&&!appearance&&!draft.basicReason)items.push({section:'appearance',message:'基础面板需说明选择依据'})
    for(const key of ['sourceCoverage','cleanup','appearance'])if(!draft.review[key])items.push({section:'review',field:key,message:'尚未确认需求：'+key})
    return items
  }
  function summary(draft) {
    const issues=missing(draft)
    return {draft:draftToken(draft.id,draft.revision),draftId:draft.id,draftRevision:draft.revision,saved:true,phase:draft.phase,sourcePath:draft.sourcePath,sourceRevision:draft.sourceRevision,targetPath:draft.targetPath,
      fieldSchema:draft.fieldSchema,ruleReviewRequired:draft.ruleReviewRequired===true,
      progress:{fields:draft.fieldSchema.fields.length,openings:draft.definition.openingStates.map((state,index)=>({openingId:'opening-'+index,sourcePath:index?'/alternate_greetings/'+(index-1):'/first_mes',filled:state!==null,missingFields:state===null?null:openingIssues(draft,state,index).filter(issue=>issue.code==='DRAFT_FIELD_MISSING').map(issue=>issue.path)})),appearanceRequirement:draft.appearanceRequirement,appearanceSaved:!!draft.definition.appearance},
      missing:issues.slice(0,40),missingCount:issues.length,
      ...(draft.intent?{pendingCommit:{requestId:draft.intent.requestId,definitionRevision:draft.intent.definitionRevision}}:{}),
      ...(draft.receipt?{receipt:draft.receipt}:{})}
  }
  async function fresh(draft) {
    const now=await conversion.convert({action:'inspect',sourcePath:draft.sourcePath,name:draft.name,inPlace:draft.inPlace,detail:'summary'})
    if(now.sourceRevision!==draft.sourceRevision)fail('DRAFT_SOURCE_CHANGED','来源或世界书已变化；草稿保留，重新核对来源后建立新草稿',{sourceRevision:now.sourceRevision})
    return now
  }
  function definitionInput(draft) {
    return {...draft.definition,updateRules:Object.entries(draft.rules).map(([group,text])=>group==='既有规则'?text:group+'\n'+text).join('\n\n'),sourcePath:draft.sourcePath,sourceRevision:draft.sourceRevision,inPlace:draft.inPlace}
  }
  async function check(draft) {
    const issues=missing(draft)
    const now=await fresh(draft)
    if(now.targetRevision!==draft.targetRevision)issues.push({section:'target',code:'DRAFT_TARGET_CHANGED',message:'目标已变化，不能覆盖；重新读取后建立新草稿'})
    const input=definitionInput(draft)
    const report=await conversion.convert({...input,action:'preflight',cleanup:draft.cleanup,cleanupOrphanEntrances:draft.cleanupOrphanEntrances})
    const blocking=report.issues
    return {valid:issues.length+blocking.length===0,issues:[...issues,...blocking],checks:report.checks,suggestedCleanup:report.suggestedCleanup,...(report.effectiveCleanup?{effectiveCleanup:report.effectiveCleanup}:{})}
  }
  async function begin(args,context) {
    let info
    if(args.path!==undefined){
      if(args.sourcePath!==undefined||args.name!==undefined||args.inPlace!==undefined)fail('DRAFT_ARGUMENT_INVALID','修改已有卡时只传 path，不同时传 sourcePath/name/inPlace')
      const target=await conversion.resolveDraftTarget(args.path)
      info=await conversion.convert({action:'inspect',sourcePath:target.sourcePath,name:target.name,inPlace:target.inPlace,detail:'full'})
      if(info.targetPath!==normalizeResourcePath(args.path,'card')||info.targetRevision!==target.revision)fail('DRAFT_TARGET_CHANGED','目标已变化，请重新读取')
      const {path,...rest}=args
      args=target.inPlace?{...rest,sourcePath:target.sourcePath,inPlace:true}:{...rest,sourcePath:target.sourcePath,name:target.name}
    }
    if(args.inPlace!==undefined&&args.inPlace!==true)fail('DRAFT_ARGUMENT_INVALID','inPlace 只能为 true；转换为独立副本时省略')
    if(args.inPlace&&args.name!==undefined)fail('DRAFT_ARGUMENT_INVALID','原地 MVU 写回原卡，不传副本名 name')
    if(args.requestId===undefined){
      info=await conversion.convert({action:'inspect',sourcePath:args.sourcePath,name:args.name,inPlace:args.inPlace,detail:'full'})
      const seed=canonical({...args,sourcePath:info.sourcePath,sourceRevision:info.sourceRevision,targetRevision:info.targetRevision,session:context?.sessionId||'local'})
      for(let generation=0;;generation++){
        const requestId='auto-'+hash([seed,generation])
        const previous=await resources.readMvuDraft(hash({sourcePath:info.sourcePath,name:args.name||null,requestId,...(args.inPlace?{inPlace:true}:{})}))
        if(previous?.phase==='committed')continue
        args=canonical({...args,sourcePath:info.sourcePath,requestId});break
      }
    }
    requestKey(args)
    const sourcePath=normalizeResourcePath(args.sourcePath,'card')
    const identity={sourcePath,name:args.name||null,requestId:args.requestId,...(args.inPlace?{inPlace:true}:{})}
    const id=hash(identity),requestHash=hash(args)
    // Replaying begin never discards an in-progress draft, even if its source changed.
    const previous=await resources.readMvuDraft(id)
    if(previous) {if(previous.beginHash!==requestHash)fail('DRAFT_REQUEST_REUSED','同一 requestId 不能用于不同参数');return summary(previous)}
    info ||= await conversion.convert({action:'inspect',sourcePath,name:args.name,inPlace:args.inPlace,detail:'full'})
    if(info.target?.externallyModified||info.target?.error)fail('DRAFT_TARGET_CHANGED','已有副本包含方案外修改；先核对，不能覆盖')
    const meta=info.existingTarget?.extensions?.[MVU_CONVERSION_KEY]
    if(info.existingTarget&&(meta||!args.inPlace)&&(!meta?.definitionRevision||meta.sourcePath!==sourcePath||meta.sourceRevision!==info.sourceRevision))fail('DRAFT_TARGET_UNSUPPORTED','已有副本缺少当前来源的完整定义；需先核对转换方案')
    const saved=meta?await resources.readMvuDefinition(meta.definitionRevision):null
    if(meta&&(!saved||hash(saved)!==meta.definitionRevision))fail('DRAFT_DEFINITION_INVALID','已保存定义缺失或被改动')
    const requirement=args.appearanceRequirement||(info.appearanceSources.some(x=>x.enabled)?'preserve':saved?.appearance?.sourcePath?'preserve':saved&&!saved.appearance?.html?'basic':'custom')
    if(!['custom','preserve','basic'].includes(requirement))fail('DRAFT_REQUIREMENT_INVALID','无效美化要求')
    const basicReason=args.basicReason||(saved&&requirement==='basic'?'保留已有基础面板':'')
    if(requirement==='basic'&&!(typeof basicReason==='string'&&basicReason.trim()))fail('DRAFT_REQUIREMENT_INVALID','选择基础面板需说明用户要求或设计回退依据')
    const initial={id,beginHash:requestHash,revision:1,phase:'editing',sourcePath,...(args.inPlace?{inPlace:true}:{}),sourceRevision:info.sourceRevision,targetPath:info.targetPath,targetRevision:info.targetRevision,name:info.targetPath.slice(6,-5),appearanceRequirement:requirement,basicReason,
      definition:{initialState:saved?.initialState||{},openingStates:saved?.openingStates||Array.from({length:info.capabilities.openingCount},()=>null),sourceFields:saved?.sourceFields||[],fieldMappings:saved?.mappings||[],...(saved?.appearance?{appearance:saved.appearance}:{}),displayFields:saved?.displayFields||[]},
      rules:saved?{既有规则:saved.updateRules}:{},cleanup:meta?.cleanup||[],cleanupOrphanEntrances:false,review:{},requests:{},intent:null,receipt:null}
    ensureFieldSchema(initial)
    const draft=await resources.updateMvuDraft(id,current=>{
      if(current&&current.beginHash!==requestHash)fail('DRAFT_REQUEST_REUSED','同一 requestId 不能用于不同参数')
      return current||initial
    })
    return {...summary(draft),sourceCatalog:info.catalog,reading:conversionReading(info.card),stateInventory:info.stateInventory,appearanceSources:info.appearanceSources,instruction:'先按组 patch fields，再逐个 opening 填初值；read 按需读草稿，来源原文用 source，补充来源清单用 inspect；后续默认当前草稿，多草稿时传返回的短编号。草稿保存不代表成品已提交。'}
  }
  function patch(draft,args) {
    if(draft.phase!=='editing')fail('DRAFT_NOT_EDITABLE','草稿正在提交或已提交；提交中请原样重试，已完成请 begin 新草稿')
    const section=args.section,values=args.values
    if(section==='fields')patchFields(draft,args)
    else if(section==='opening')patchOpening(draft,args)
    else if(section==='rules') {
      if(!isObject(values)||!Object.keys(values).length||Object.values(values).some(x=>typeof x!=='string'))fail('DRAFT_VALUES_INVALID','rules values 是分组名到规则文本的对象；空文本删除该组')
      for(const [key,value] of Object.entries(values)) {if(['__proto__','prototype','constructor'].includes(key))fail('DRAFT_PATH_INVALID','无效分组名');if(value.trim())draft.rules[key]=value;else delete draft.rules[key]}
    } else if(section==='appearance') {
      draft.definition.appearance=patchDraftAppearance(draft,values)
    } else if(section==='mapping') {
      if(!isObject(values)||Object.keys(values).some(key=>!['sourceFields','fieldMappings'].includes(key))||Object.values(values).some(x=>!Array.isArray(x)))fail('DRAFT_VALUES_INVALID','mapping 仅接收 sourceFields、fieldMappings 数组')
      Object.assign(draft.definition,structuredClone(values))
    } else if(section==='cleanup') {
      if(!Array.isArray(values))fail('DRAFT_VALUES_INVALID','cleanup values 必须是清理操作数组；替换草稿中完整清理清单')
      if(draft.inPlace&&(values.length||args.cleanupOrphanEntrances))fail('DRAFT_VALUES_INVALID','原地 MVU 不清理旧协议；带旧状态栏的卡请转换为独立副本')
      draft.cleanup=structuredClone(values)
      if(args.cleanupOrphanEntrances!==undefined)draft.cleanupOrphanEntrances=args.cleanupOrphanEntrances
    } else if(section==='requirements') {
      if(!isObject(values)||Object.keys(values).some(key=>!['appearanceRequirement','basicReason'].includes(key))||!['custom','preserve','basic'].includes(values.appearanceRequirement))fail('DRAFT_REQUIREMENT_INVALID','requirements 需明确 appearanceRequirement')
      if(values.appearanceRequirement==='basic'&&!(typeof values.basicReason==='string'&&values.basicReason.trim()))fail('DRAFT_REQUIREMENT_INVALID','选择基础面板需说明用户要求或设计回退依据')
      draft.appearanceRequirement=values.appearanceRequirement
      draft.basicReason=typeof values.basicReason==='string'?values.basicReason:''
    } else if(section==='review') {
      if(!isObject(values)||Object.keys(values).some(key=>!['sourceCoverage','cleanup','appearance'].includes(key))||Object.values(values).some(x=>typeof x!=='boolean'))fail('DRAFT_VALUES_INVALID','review 仅接收 sourceCoverage、cleanup、appearance 的布尔确认')
      Object.assign(draft.review,values)
      if(values.sourceCoverage===true)draft.ruleReviewRequired=false
    } else fail('DRAFT_SECTION_INVALID','未知草稿分组')
    if(section!=='review')draft.review={}
  }
  async function run(args,context) {
    validateArguments(args)
    if(args.action==='begin')return begin(args,context)
    let draft=await resources.readMvuDraft(args.draftId)
    if(!draft)fail('DRAFT_NOT_FOUND','草稿不存在，请 begin')
    ensureFieldSchema(draft)
    if(['source','inspect'].includes(args.action)){
      if(args.draftRevision!==draft.revision)fail('DRAFT_REVISION_CONFLICT','草稿已变化，请 read 获取最新凭据',{draftRevision:draft.revision})
      await fresh(draft)
      if(args.action==='source')return {...summary(draft),source:await conversion.convert({action:args.query===undefined?'read':'search',sourcePath:draft.sourcePath,sourceRevision:draft.sourceRevision,inPlace:draft.inPlace,path:args.path,query:args.query,offset:args.offset,limit:args.limit})}
      const info=await conversion.convert({action:'inspect',sourcePath:draft.sourcePath,name:draft.name,inPlace:draft.inPlace,sourceFields:draft.definition.sourceFields,detail:'summary'})
      return {...summary(draft),sourceCatalog:info.catalog,stateInventory:info.stateInventory,appearanceSources:info.appearanceSources}
    }
    if(args.action==='read') {
      if((args.path!==undefined||args.offset!==undefined)&&args.draftRevision!==undefined&&args.draftRevision!==draft.revision)fail('DRAFT_REVISION_CONFLICT','草稿版本已变化',{draftRevision:draft.revision})
      return {...summary(draft),...(args.path!==undefined?{reading:readConversionValue(draft,{path:args.path,offset:args.offset,limit:args.limit})}:{})}
    }
    if(args.action==='validate') {
      if(args.draftRevision!==draft.revision)fail('DRAFT_REVISION_CONFLICT','验证需携带当前草稿版本',{draftRevision:draft.revision})
      return {...summary(draft),validation:await check(draft)}
    }
    if(!['patch','commit'].includes(args.action))fail('DRAFT_ACTION_INVALID','action 必须为 begin/read/patch/validate/commit')
    const key=requestKey(args),requestHash=hash(args)
    // Persist commit intent before publication. A crash or lost response can be
    // resumed with the same request, using apply's content-addressed idempotency.
    draft=await resources.updateMvuDraft(args.draftId,async current=>{
      if(!current)fail('DRAFT_NOT_FOUND','草稿不存在')
      const replay=current.requests[key]
      if(replay) {if(replay.hash!==requestHash)fail('DRAFT_REQUEST_REUSED','同一 requestId 不能用于不同参数');return current}
      if(current.intent) {
        if(current.intent.hash!==requestHash)fail('DRAFT_COMMIT_PENDING','存在待完成提交；请原样重试上一次 commit 调用')
        return current
      }
      if(args.draftRevision!==current.revision)fail('DRAFT_REVISION_CONFLICT','草稿已变化，请 read 后提交局部修改',{draftRevision:current.revision})
      if(current.phase!=='editing')fail('DRAFT_NOT_EDITABLE','草稿已提交，请 begin 新草稿')
      ensureFieldSchema(current)
      await fresh(current)
      if(args.action==='patch') {patch(current,args);current.revision++;current.requests[key]={hash:requestHash,revision:current.revision};return current}
      const validation=await check(current)
      if(!validation.valid)fail('DRAFT_INCOMPLETE','草稿未通过检查；已保存内容保留，不写成品',{saved:true,committed:false,issues:validation.issues})
      const saved=await conversion.convert({...definitionInput(current),action:'saveDefinition'})
      const preview=await conversion.convert({action:'preview',sourcePath:current.sourcePath,sourceRevision:current.sourceRevision,name:current.name,inPlace:current.inPlace,
        ...(current.targetRevision?{targetRevision:current.targetRevision}:{}),definitionRevision:saved.definitionRevision,
        [DRAFT_FIELD_CHANGES]:current.fieldChanges||[],planMode:'replace',cleanup:current.cleanup,cleanupOrphanEntrances:current.cleanupOrphanEntrances})
      if(!preview.validation.valid)fail('DRAFT_INCOMPLETE','生成校验未通过；草稿保留，不写成品',{saved:true,committed:false,issues:preview.validation.checks.filter(x=>x.status==='failed')})
      current.intent={requestId:args.requestId,hash:requestHash,definitionRevision:saved.definitionRevision}
      current.phase='committing'
      return current
    })
    if(args.action==='patch'||draft.requests[key])return summary(draft)
    // The lock also protects simultaneous identical commit retries.
    draft=await resources.updateMvuDraft(args.draftId,async current=>{
      if(current.requests[key])return current
      if(current.intent?.hash!==requestHash)fail('DRAFT_COMMIT_PENDING','提交意图已变化')
      await fresh(current)
      const result=await conversion.convert({action:'apply',sourcePath:current.sourcePath,sourceRevision:current.sourceRevision,name:current.name,inPlace:current.inPlace,
        ...(current.targetRevision?{targetRevision:current.targetRevision}:{}),definitionRevision:current.intent.definitionRevision,
        [DRAFT_FIELD_CHANGES]:current.fieldChanges||[],planMode:'replace',cleanup:current.cleanup,cleanupOrphanEntrances:current.cleanupOrphanEntrances})
      current.receipt={committed:true,committedAt:new Date().toISOString(),definitionRevision:current.intent.definitionRevision,...result}
      current.phase='committed';current.revision++;current.intent=null
      current.requests[key]={hash:requestHash,revision:current.revision}
      return current
    })
    return summary(draft)
  }
  const execute=async (args,context)=>{
    try {args=expandToken(args);return await run(args,context)}
    catch(error) {
      const draft=args.draftId?await resources.readMvuDraft(args.draftId).catch(()=>undefined):undefined
      error.code ||= 'DRAFT_OPERATION_FAILED'
      error.details={saved:!!draft,commitState:draft?.receipt?'committed':draft?.intent?'unknown':'not-started',
        ...(draft?{draft:draftToken(draft.id,draft.revision),draftId:draft.id,draftRevision:draft.revision,phase:draft.phase}:{}),
        hint:draft?.intent?'成品提交结果可能尚未记录；请用原 commit 参数重试，不直接改写成品。':'草稿中已保存的部分保留；按错误位置修改后继续。',...error.details}
      throw error
    }
  }
  return {run:createMvuDraftSession({resources,run:execute})}
}
