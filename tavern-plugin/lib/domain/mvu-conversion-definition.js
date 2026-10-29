import { compileMvuComponents } from './mvu-conversion-components.js'
import { appearanceCoverageError, conversionInputError } from './mvu-conversion-guidance.js'
import { appearanceSources, appearancePaths } from './mvu-conversion-appearance.js'
import { createHash } from 'node:crypto'
import {fieldPaths} from './mvu-draft-fields.js'
import { isDeepStrictEqual } from 'node:util'
import { pointerKeys, isObject } from './mvu-conversion-artifacts.js'

export const definitionKeys = ['initialState','openingStates','updateRules','displayFields','appearance']
export const definitionDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const escapePointer = key => key.replace(/~/g,'~0').replace(/\//g,'~1')
export function atPath(value,path) {
  for (const key of pointerKeys(path)) {
    if (value == null || !Object.hasOwn(value,key)) throw Error('字段路径不存在: '+path)
    value=value[key]
  }
  return value
}
// Inspect literal tag protocols without executing an imported regular expression.
// Other formats are supplied as exact source ranges by the semantic extraction step.
export function stateInventory(data, sourceFields = []) {
  const rules = appearanceSources(data).map(skin=>data.extensions.regex_scripts[Number(skin.path.split('/')[3])])
  const tags = new Set(rules.flatMap(rule => [...String(rule.findRegex || '').matchAll(/<([\p{L}_][\p{L}\p{N}_-]*)>/gu)].map(m=>m[1])))
  const fields=[]
  const add=(path,offset,length,field,opening)=>{
    const text=atPath(data,path)
    if (typeof text !== 'string' || !Number.isInteger(offset) || !Number.isInteger(length) || offset<0 || length<0 || offset+length>text.length) throw Error('状态字段来源范围无效: '+path)
    const value=text.slice(offset,offset+length)
    const id=definitionDigest([path,offset,length])
    if (!fields.some(x=>x.id===id)) fields.push({id,sourcePath:path,offset,length,field,opening,value})
  }
  for (const [opening,text] of [data.first_mes,...(data.alternate_greetings || [])].entries()) {
    const path=opening===0?'/first_mes':'/alternate_greetings/'+(opening-1)
    for (const match of String(text || '').matchAll(/<([\p{L}_][\p{L}\p{N}_-]*)>([^]*?)<\/\1>/gu)) {
      if(tags.has(match[1])) add(path,match.index+match[1].length+2,match[2].length,match[1],opening)
    }
  }
  if (!Array.isArray(sourceFields)) throw Error('sourceFields 必须为数组')
  for (const field of sourceFields) {
    const opening=field.path==='/first_mes'?0:/^\/alternate_greetings\/(\d+)$/.test(field.path)?Number(field.path.split('/').at(-1))+1:null
    add(field.path,field.offset,field.length,field.label || field.path,opening)
  }
  return fields
}
export function leaves(value,path='') {
  if (value && typeof value==='object' && Object.keys(value).length) return Object.entries(value).flatMap(([key,child])=>leaves(child,path+'/'+escapePointer(key)))
  return [{path,type:value===null?'null':Array.isArray(value)?'array':typeof value,value:structuredClone(value)}]
}
export function normalizeOpeningStates(input,initialState,count) {
  let states=input
  if (states===undefined) states=Array.from({length:count},()=>structuredClone(initialState))
  else if (isObject(states) && Object.keys(states).length===count && Array.from({length:count},(_,i)=>String(i)).every(key=>Object.hasOwn(states,key))) states=Array.from({length:count},(_,i)=>states[String(i)])
  if (!Array.isArray(states)||states.length!==count||Array.from({length:count},(_,i)=>!isObject(states[i])).some(Boolean)) {
    throw conversionInputError('MVU_OPENING_STATES_INVALID','openingStates 必须逐项对应全部开场',{expectedCount:count,missingIndices:Array.from({length:count},(_,i)=>i).filter(i=>!isObject(states?.[i])),hint:'传 first_mes 在前、alternate_greetings 按序的完整对象数组；可省略，工具用 initialState 建立底稿后按来源映射填值。'})
  }
  return structuredClone(states)
}
export function withStrictSet(state) {
  if (isObject(state) && state.$meta?.strictSet === undefined) state.$meta={...(isObject(state.$meta)?state.$meta:{}),strictSet:true}
  return state
}
export function createDefinition(source,args) {
  if (!isObject(args.initialState) || !Object.keys(args.initialState).length) throw Error('initialState 必须是非空变量对象')
  const inventory=stateInventory(source.data,args.sourceFields)
  const mappings=args.fieldMappings || []
  if (!Array.isArray(mappings)) throw Error('fieldMappings 必须为数组')
  const openingCount=1+(source.data.alternate_greetings?.length || 0)
  const states=normalizeOpeningStates(args.openingStates,args.initialState,openingCount)
  // Official MVU treats any [value, "text"] pair as value-with-description and a
  // replace then only rewrites element 0, nesting a submitted list inside it.
  // Converted cards submit literal JSON Patch, so opt out of that convention.
  for (const state of states) withStrictSet(state)
  args={...args,appearance:compileMvuComponents(args.appearance,states)}
  // Every declared field exists in every opening. Unknown values belong in the
  // definition explicitly, rather than borrowing another opening's facts.
  const declared=fieldPaths(args.initialState)
  for (const state of states) for(const field of declared) atPath(state,field.path)
  const occupied=new Set()
  for (const item of inventory) {
    const matches=mappings.filter(m=>m.sourceId===item.id)
    if (matches.length!==1) throw Error('原状态字段未迁移或重复映射: '+item.sourcePath+' '+item.field+' @'+item.offset)
    const {path}=matches[0], keys=pointerKeys(path)
    const openings=item.opening===null?states.map((_,i)=>i):[item.opening]
    for (const index of openings) {
      const address=index+':'+path
      if (occupied.has(address)) throw Error('多个来源字段合并到同一路径: '+path)
      occupied.add(address)
      atPath(states[index],path)
      let parent=states[index];for(const key of keys.slice(0,-1))parent=parent[key]
      // Source bytes are copied by the tool, never transcribed by the model.
      const previous=parent[keys.at(-1)]
      let value=item.value
      if(typeof previous!=='string') {
        try { value=JSON.parse(item.value) } catch { throw Error('来源值无法按声明类型解析，需专门适配: '+path) }
        if(typeof value!==typeof previous || Array.isArray(value)!==Array.isArray(previous) || (value===null)!==(previous===null)) throw Error('来源值与声明类型不一致: '+path)
      }
      parent[keys.at(-1)]=value
    }
  }
  for (const mapping of mappings) {
    let visible
    if (args.appearance?.protocol) visible=appearancePaths(args.appearance).some(path=>mapping.path===path||mapping.path.startsWith(path+'/'))
    else if (args.appearance) {
      const prefix=args.appearance.collectionPath
      visible=args.appearance.bindings.some(binding=>{
        if(!prefix)return binding.path===mapping.path
        const keys=pointerKeys(mapping.path), base=pointerKeys(prefix)
        return base.every((key,i)=>keys[i]===key) && keys.length>base.length &&
          isDeepStrictEqual(keys.slice(base.length+1),pointerKeys(binding.path))
      })
    } else visible=!args.displayFields?.length || args.displayFields.some(field=>mapping.path===field.path || mapping.path.startsWith(field.path+'/'))
    if(!visible) throw Error('原状态字段没有展示映射: '+mapping.path)
  }
  if (args.appearance?.html !== undefined) {
    const missingPaths = new Set()
    for (const state of states) for (const field of leaves(state)) {
      const keys=pointerKeys(field.path)
      const prefix=args.appearance.collectionPath ? pointerKeys(args.appearance.collectionPath) : null
      const template=prefix && prefix.every((key,i)=>keys[i]===key) && keys[prefix.length]==='$meta' && keys[prefix.length+1]==='template'
      if(!template && keys.some(key=>key.startsWith('$') || key.startsWith('__'))) continue
      const relative=template ? keys.slice(prefix.length+2) : prefix && prefix.every((key,i)=>keys[i]===key) && keys.length>prefix.length ? keys.slice(prefix.length+1) : prefix ? null : keys
      if(!relative || !args.appearance.bindings.some(binding=>{
        const bound=pointerKeys(binding.path)
        return bound.length<=relative.length && bound.every((key,i)=>relative[i]===key)
      })) missingPaths.add(field.path)
    }
    if (missingPaths.size) throw appearanceCoverageError([...missingPaths],args.appearance.collectionPath)
  }
  if (args.appearance?.protocol) {
    // The original view only sees what the protocol text carries.
    const shown=appearancePaths(args.appearance).map(pointerKeys)
    const missingPaths=new Set()
    for (const state of states) for (const field of leaves(state)) {
      const keys=pointerKeys(field.path)
      if(keys.some(key=>key.startsWith('$') || key.startsWith('__'))) continue
      if(!shown.some(bound=>bound.length<=keys.length && bound.every((key,i)=>keys[i]===key))) missingPaths.add(field.path)
    }
    for (const path of appearancePaths(args.appearance)) for (const state of states) atPath(state,path)
    if (missingPaths.size) throw conversionInputError('MVU_APPEARANCE_MISSING_FIELDS','协议文本遗漏已定义字段: '+[...missingPaths][0],{field:'protocol.template',missingPaths:[...missingPaths],hint:'在 protocol.template 中按原卡状态协议的位置补上 {{/路径}}；不要删除字段来通过校验。'})
  }
  if (mappings.some(m=>!inventory.some(i=>i.id===m.sourceId))) throw Error('fieldMappings 包含未知来源字段')
  return {version:1,sourcePath:source.sourcePath,sourceRevision:source.revision,
    initialState:states[0],openingStates:states,updateRules:args.updateRules,displayFields:args.displayFields || [],
    ...(args.appearance?{appearance:structuredClone(args.appearance)}:{}),sourceFields:args.sourceFields || [],inventory,mappings,
    fields:states.map(state=>leaves(state))}
}
export function assertDefinition(definition,meta,source) {
  if (definition.version!==1) throw Error('字段定义版本不支持')
  // Self-sourced cards keep editing their story; legacy-field inventory only guided the first mapping.
  if(source && (definition.sourceRevision!==source.revision || !source.self && !isDeepStrictEqual(definition.inventory,stateInventory(source.data,definition.sourceFields)))) throw Error('字段来源发生变化')
  for(const key of definitionKeys) if(!isDeepStrictEqual(meta[key],definition[key])) throw Error('成品缺少或改动已保存定义: '+key)
  for(const [index,fields] of definition.fields.entries()) for(const field of fields) {
    if(!isDeepStrictEqual(atPath(meta.openingStates[index],field.path),field.value)) throw Error('成品字段值丢失: '+field.path)
  }
}
