import {JSDOM} from 'jsdom'
import {isDeepStrictEqual} from 'node:util'
import {pointerKeys,isObject} from './mvu-conversion-artifacts.js'

export function draftError(code,message,details={}) { const error=Error(message);error.code=code;error.details=details;throw error }
export const DRAFT_FIELD_CHANGES = Symbol('draftFieldChanges')
const escape = key => key.replace(/~/g,'~0').replace(/\//g,'~1')
const type = value => value===null?'null':Array.isArray(value)?'array':typeof value
const under = (path,root) => path===root||path.startsWith(root+'/')
export function fieldPaths(value,path='') {
  if(isObject(value)&&Object.keys(value).length)return Object.entries(value).flatMap(([key,child])=>fieldPaths(child,path+'/'+escape(key)))
  return path?[{path,type:type(value)}]:[]
}
function safe(path) {
  if(typeof path!=='string'||!path.startsWith('/')||/~(?![01])/.test(path)||path.slice(1).split('/').map(key=>key.replace(/~1/g,'/').replace(/~0/g,'~')).some(key=>['__proto__','prototype','constructor'].includes(key)))draftError('DRAFT_PATH_INVALID','需要安全的非空 JSON Pointer',{path})
  return pointerKeys(path)
}
export function hasPath(value,path) {
  for(const key of pointerKeys(path)){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return false;value=value[key]}
  return true
}
const get = (value,path) => pointerKeys(path).reduce((node,key)=>node[key],value)
function put(target,path,value) {
  const keys=safe(path);let parent=target
  for(const key of keys.slice(0,-1)){
    if(!Object.hasOwn(parent,key))parent[key]={}
    if(!isObject(parent[key]))draftError('DRAFT_PATH_INVALID','父路径不是对象；数组请整组提交',{path})
    parent=parent[key]
  }
  parent[keys.at(-1)]=structuredClone(value)
}
function remove(target,path) {
  const keys=safe(path);if(!hasPath(target,path))return
  const parents=[target];for(const key of keys.slice(0,-1))parents.push(parents.at(-1)[key])
  delete parents.at(-1)[keys.at(-1)]
  for(let i=parents.length-1;i>0;i--){if(Object.keys(parents[i]).length)break;delete parents[i-1][keys[i-1]]}
}
function merge(old,value) {
  if(!isObject(old)||!isObject(value))return structuredClone(value)
  const result=structuredClone(old)
  for(const [key,child] of Object.entries(value))result[key]=merge(result[key],child)
  return result
}
export function setValues(target,values,operation='set') {
  if(!isObject(values)||!Object.keys(values).length)draftError('DRAFT_VALUES_INVALID','values 必须是非空的 JSON Pointer 到值的对象')
  // The map already denotes root paths. A missing leading slash is an
  // unambiguous spelling correction, including MVU's legitimate $meta key.
  const normalized={}
  for(const [key,value] of Object.entries(values)){
    const path=key&&!key.startsWith('/')?'/'+key:key
    safe(path)
    if(Object.hasOwn(normalized,path))draftError('DRAFT_PATH_COLLISION','多个输入键对应同一路径；保留一个明确值',{path})
    normalized[path]=value
  }
  values=normalized
  const paths=Object.keys(values)
  for(const path of paths){safe(path);if(paths.some(other=>other!==path&&under(path,other)))draftError('DRAFT_PATH_OVERLAP','一批修改不能同时包含父字段与子字段',{path})}
  // Validate nested keys too: an object payload must not bypass pointer guards.
  for(const [path,value] of Object.entries(values))for(const field of fieldPaths(value,path))safe(field.path)
  for(const path of paths)put(target,path,operation==='merge'?merge(hasPath(target,path)?get(target,path):undefined,values[path]):values[path])
  return paths
}
export function ensureFieldSchema(draft) {
  draft.fieldSchema ||= {revision:1,fields:fieldPaths(draft.definition.initialState)}
}
export function openingIssues(draft,state,index) {
  if(state===null)return [{section:'opening',openingId:'opening-'+index,code:'DRAFT_OPENING_MISSING',message:'尚未填写此开场'}]
  const issues=[],fields=draft.fieldSchema.fields,actual=fieldPaths(state)
  const add=(code,path,message,extra={})=>issues.push({section:'opening',openingId:'opening-'+index,code,path,message,...extra})
  for(const field of fields){
    if(!hasPath(state,field.path))add('DRAFT_FIELD_MISSING',field.path,'此开场缺少已声明字段')
    else {const actualType=type(get(state,field.path));if(actualType!==field.type)add('DRAFT_FIELD_TYPE',field.path,'开场值类型与字段目录不一致',{expectedType:field.type,actualType})}
  }
  for(const field of actual)if(!fields.some(known=>known.path===field.path))add('DRAFT_FIELD_UNKNOWN',field.path,'开场不能创建字段；使用 fields 声明或移动到已有路径',{suggestedPaths:fields.filter(known=>known.path.split('/').at(-1)===field.path.split('/').at(-1)).map(known=>known.path)})
  return issues
}
export function patchOpening(draft,args) {
  const index=draft.definition.openingStates.findIndex((_,i)=>args.openingId==='opening-'+i)
  if(index<0)draftError('DRAFT_OPENING_INVALID','openingId 不存在')
  const state=structuredClone(draft.definition.openingStates[index]||{})
  const previous=structuredClone(state)
  if(args.inheritInitialState===true){
    // Explicit inheritance only fills missing paths. Existing scene values survive.
    for(const field of draft.fieldSchema.fields)if(!hasPath(state,field.path))put(state,field.path,get(draft.definition.initialState,field.path))
  }
  let changedPaths=[]
  if(args.values!==undefined)changedPaths=setValues(state,args.values,args.operation)
  else if(args.inheritInitialState!==true)draftError('DRAFT_VALUES_INVALID','请提交本开场初值或明确继承底稿')
  const issues=openingIssues(draft,state,index).filter(issue=>{
    if(issue.code==='DRAFT_FIELD_MISSING')return false
    // Legacy drafts can be repaired incrementally. Unchanged old defects remain
    // visible in progress/validate, but cannot block correcting another field.
    const touched=changedPaths.some(path=>under(issue.path,path)||under(path,issue.path))
    return touched||!hasPath(previous,issue.path)||!hasPath(state,issue.path)||!isDeepStrictEqual(get(previous,issue.path),get(state,issue.path))
  })
  if(issues.length)draftError(issues[0].code,issues[0].message,{issues})
  draft.definition.openingStates[index]=state
}
// Only structured references are migrated. Natural-language rules are reviewed by
// the author; never rewrite arbitrary text or source-card cleanup paths.
function references(definition,visit) {
  for(const item of [...(definition.fieldMappings||[]),...(definition.displayFields||[])])item.path=visit(item.path)
  const appearance=definition.appearance
  if(!appearance)return
  if(appearance.collectionPath){
    const before=appearance.collectionPath,after=visit(before)
    if(before!==after)appearance.collectionPath=after
    // Relative bindings inside collections require per-item semantic decisions.
  }else for(const item of appearance.bindings||[])item.path=visit(item.path)
  if(typeof appearance.protocol?.template==='string')appearance.protocol.template=appearance.protocol.template.replace(/\{\{\s*(\/[^{}]*?)\s*\}\}/g,(match,path)=>{const after=visit(path);return after===path?match:'{{'+after+'}}'})
  for(const item of appearance.fields||[])item.path=visit(item.path)
  if(typeof appearance.html==='string'&&/<mvu-field\b/i.test(appearance.html)){
    const dom=new JSDOM(appearance.html)
    try {let changed=false;for(const node of dom.window.document.querySelectorAll('mvu-field[path]')){const before=node.getAttribute('path'),after=visit(before);if(before!==after){node.setAttribute('path',after);changed=true}}if(changed)appearance.html=dom.serialize()}finally{dom.window.close()}
  }
}
export function appearanceIssues(draft) {
  const appearance=draft.definition.appearance
  // Collection bindings are relative to each member; their full semantic checks
  // remain in the conversion preflight. Generated basic fields cover the catalog.
  if(!appearance||appearance.collectionPath||Array.isArray(appearance.fields))return []
  try {
  const paths=[]
  references({appearance:structuredClone(appearance)},path=>{if(typeof path==='string')paths.push(path);return path})
  const visible=draft.fieldSchema.fields.filter(field=>!pointerKeys(field.path).some(key=>key.startsWith('$')||key.startsWith('__')))
  const missingPaths=visible.filter(field=>!paths.some(path=>under(field.path,path))).map(field=>field.path)
  const unknownPaths=paths.filter(path=>!hasPath(draft.definition.initialState,path))
  return [...(missingPaths.length?[{section:'appearance',code:'DRAFT_APPEARANCE_FIELDS',missingPaths,message:'美化尚未覆盖字段目录；补充对应组件或绑定'}]:[]),
    ...(unknownPaths.length?[{section:'appearance',code:'DRAFT_APPEARANCE_UNKNOWN',unknownPaths,message:'美化引用了目录外路径'}]:[])]
  }catch(error){return [{section:'appearance',code:'DRAFT_APPEARANCE_INVALID',message:error.message}]}
}
export function patchFields(draft,args) {
  const {definition}=draft,operation=args.operation||'set'
  if(operation==='move'||operation==='remove'){
    const from=args.path;safe(from)
    const roots=[definition.initialState,...definition.openingStates.filter(Boolean)]
    for(const root of roots){let parent=root;for(const key of pointerKeys(from)){if(Array.isArray(parent))draftError('DRAFT_PATH_INVALID','数组是完整字段，不能逐下标移动或删除',{path:from});if(parent===null||typeof parent!=='object'||!Object.hasOwn(parent,key))break;parent=parent[key]}}
    if(!roots.some(root=>hasPath(root,from)))draftError('DRAFT_FIELD_NOT_FOUND','字段不存在',{path:from})
    if(definition.appearance?.collectionPath&&under(from,definition.appearance.collectionPath)&&from!==definition.appearance.collectionPath)draftError('DRAFT_FIELD_REFERENCED','集合内部路径需先调整 collectionPath/bindings 方案',{path:from})
    if(operation==='move'){
      const to=args.toPath;safe(to)
      if(under(to,from)||under(from,to)||roots.some(root=>hasPath(root,to)))draftError('DRAFT_FIELD_COLLISION','移动目标已存在或与来源重叠；先核对冲突值',{path:from,toPath:to})
      // A stray legacy opening key may only move into a declared target through
      // an explicit value patch plus remove; moving never overwrites scene data.
      for(const root of roots)if(hasPath(root,from)){const value=get(root,from);remove(root,from);put(root,to,value)}
      references(definition,path=>typeof path==='string'&&under(path,from)?to+path.slice(from.length):path)
    }else{
      references(definition,path=>{if(typeof path==='string'&&(under(path,from)||under(from,path)))draftError('DRAFT_FIELD_REFERENCED','字段仍有展示或来源映射引用；先调整引用再删除',{path:from,reference:path});return path})
      for(const root of roots)remove(root,from)
    }
    draft.fieldChanges ||= []
    draft.fieldChanges.push({operation,path:from,...(operation==='move'?{toPath:args.toPath}:{})})
    draft.ruleReviewRequired=true
  }else{
    setValues(definition.initialState,args.values,operation)
    const removed=draft.fieldSchema.fields.filter(field=>!hasPath(definition.initialState,field.path))
    if(removed.length)draftError('DRAFT_FIELD_REMOVAL_REQUIRED','此次替换会丢失已声明字段；合并用 merge，删除用 remove，改名用 move',{paths:removed.map(field=>field.path)})
  }
  const fields=fieldPaths(definition.initialState)
  if(!isDeepStrictEqual(fields,draft.fieldSchema.fields))draft.fieldSchema={revision:draft.fieldSchema.revision+1,fields}
}
