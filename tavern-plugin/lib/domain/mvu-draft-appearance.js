import {compileMvuComponents} from './mvu-conversion-components.js'

function fail(message) {const error=Error(message);error.code='DRAFT_APPEARANCE_EDIT_INVALID';throw error}
export function patchDraftAppearance(draft,values) {
  if(!values || typeof values!=='object' || Array.isArray(values))fail('appearance values 必须是外观方案或 {replacements:[{expected,value}]}')
  if(!Object.hasOwn(values,'replacements')) {
    if(Object.hasOwn(values,'html')&&typeof values.html!=='string')fail('html 必须是字符串；读取回执的 text 才是 HTML 内容')
    const plan=structuredClone(values)
    // Path strings are the natural shorthand; normalize before anything reads item.path.
    if(Object.hasOwn(plan,'fields')) {
      if(!Array.isArray(plan.fields))fail('fields 必须是数组，例如 ["/地点"] 或 [{path:"/地点",label:"地点",display:"text"}]')
      plan.fields=plan.fields.map(item=>typeof item==='string'?{path:item}:item)
      for(const item of plan.fields)if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.path!=='string'||!item.path.startsWith('/')||Object.keys(item).some(key=>!['path','label','display'].includes(key)))fail('fields 每项是根路径字符串或 {path,label,display}')
    }
    return plan
  }
  if(Object.keys(values).some(key=>key!=='replacements'))fail('局部替换只传 replacements；绑定由已有方案与 mvu-field 组件生成')
  const plan=draft.definition.appearance
  if(typeof plan?.html!=='string'||plan.sourcePath||plan.collectionPath)fail('局部组件编辑仅支持根路径托管 HTML；来源固化或集合视图需提交适配后的完整方案')
  const replacements=values.replacements
  if(!Array.isArray(replacements)||!replacements.length||replacements.length>50)fail('replacements 需包含 1–50 项')
  const html=plan.html
  const edits=replacements.map(edit=>{
    if(typeof edit?.expected!=='string'||!edit.expected||typeof edit.value!=='string')fail('替换需要非空 expected 和字符串 value')
    const start=html.indexOf(edit.expected)
    if(start<0||html.indexOf(edit.expected,start+1)!==-1)fail('expected 必须在当前草稿 HTML 中恰好出现一次；请读取草稿并扩大唯一片段')
    return {start,end:start+edit.expected.length,value:edit.value}
  }).sort((a,b)=>a.start-b.start)
  for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)fail('替换范围重叠，请合并片段')
  let updated=html
  for(const edit of edits.reverse())updated=updated.slice(0,edit.start)+edit.value+updated.slice(edit.end)
  const captures=text=>[...text.matchAll(/\$(\d{1,2})(?!\d)/g)].map(match=>Number(match[1]))
  const existing=new Set(captures(html))
  if(captures(updated).some(capture=>!existing.has(capture)))fail('新增字段请使用 <mvu-field path="/字段"></mvu-field>，不要手写新的 $N 编号')
  return compileMvuComponents({...plan,html:updated},[draft.definition.initialState,...draft.definition.openingStates.filter(Boolean)],{extendBindings:true})
}
