import { conversionInputError } from './mvu-conversion-guidance.js'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'

const hash = text => createHash('sha256').update(text).digest('hex')
const capturePattern = /\$([1-9]\d?)/g
const protocolPlaceholder = /\{\{\s*(\/[^{}]*?)\s*\}\}/g
// A state view renders captured state ($1, $2…). Decoration without captures (an
// opening page, a banner) shows no state: it stays untouched and is no status skin.
export function appearanceSources(data) {
  return (data.extensions?.regex_scripts || []).flatMap((rule, index) => {
    const html = String(rule.replaceString || '')
    if (!/<(?:html|style|div|details|table|section|main|script|iframe|p|span|h[1-6]|ul|ol|dl|svg)\b/i.test(html)) return []
    const captures = [...new Set([...html.matchAll(capturePattern)].map(m => Number(m[1])))].sort((a,b)=>a-b)
    if (!captures.length) return []
    return [{ path: `/extensions/regex_scripts/${index}/replaceString`, name: rule.scriptName || rule.id || String(index), enabled: rule.disabled !== true && rule.enabled !== false,
      digest: hash(html), captures, scripted: /<script\b|\son[a-z]+\s*=/i.test(html) }]
  })
}
export function protocolPaths(template) {
  return [...String(template).matchAll(protocolPlaceholder)].map(match => match[1])
}
// Every variable path an appearance plan displays, whatever its mode.
export function appearancePaths(plan) {
  if (!plan) return []
  if (plan.protocol) return protocolPaths(plan.protocol.template)
  return (plan.bindings || []).map(binding => binding.path)
}

// Read source bytes ourselves. Model input is a source pointer plus data bindings,
// never a rewritten template. Unknown executable views must not silently lose skin.
export function freezeMvuAppearance(data, plan) {
  if (plan && Object.hasOwn(plan,'html')) {
    if (appearanceSources(data).length) throw Error('原卡已有美化，不能用生成样式覆盖；请固化原视图，不接受模型重写 HTML')
    if (Object.keys(plan).some(key=>!['html','bindings','collectionPath'].includes(key)) || typeof plan.html!=='string' || !plan.html.trim()) throw Error('生成美化只接受 html、bindings 和 collectionPath')
    const frozen = freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:plan.html}]}}, {
      sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:plan.bindings,...(plan.collectionPath?{collectionPath:plan.collectionPath}:{})
    })
    return {...frozen,sourcePath:null,generated:true}
  }

  if (plan && typeof plan === 'object' && Object.hasOwn(plan, 'protocol')) return freezeProtocolAppearance(data, plan)
  if (!plan || typeof plan !== 'object' || Object.keys(plan).some(k => !['sourcePath','bindings','collectionPath'].includes(k))) throw Error('美化方案只接受 sourcePath 和 bindings，不接受模型重写 HTML')
  const entry = appearanceSources(data).find(x => x.path === plan.sourcePath)
  if (!entry) throw Error('美化来源不存在，请从 inspect.appearanceSources 选择')
  const source = data.extensions.regex_scripts[Number(plan.sourcePath.split('/')[3])].replaceString
  const fenced = source.trim().match(/^```html\s*\n([\s\S]*?)\n```$/i)
  const html = fenced ? fenced[1] : source
  const unsupported = /```|<%|&lt;%|\{\{[^}]*\}\}|\{\{|\$[&`']|\$<|\$\$/.exec(html)
  if (unsupported) throw conversionInputError('MVU_APPEARANCE_UNSUPPORTED_SYNTAX', '美化包含动态模板或特殊替换语法: ' + unsupported[0], {
    field:'html',token:unsupported[0],offset:unsupported.index,
    hint:'HTML 动态值只支持文本节点的 $1、$2 等 bindings 占位；标签中的 {{user}}/{{char}} 改为“玩家”/“角色”等静态文字，状态值通过字段绑定读取。移除 EJS 或特殊替换语法后重新提交设计。原卡复杂模板须专门适配，不用默认面板覆盖原美化。'
  })
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    if (doc.querySelector('script,iframe,object,embed,base,meta[http-equiv]')) throw Error('美化包含自定义脚本或嵌入文档，需专门适配；原视图保留，不自动删除')
    for (const element of doc.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        if (/^on/i.test(attr.name) || /javascript\s*:/i.test(attr.value) || /\$[1-9]\d?/.test(attr.value)) throw Error('美化含事件处理或属性中的动态取值，需专门适配: ' + attr.name)
      }
    }
    if ([...doc.querySelectorAll('style,title,textarea')].some(el => /\$[1-9]\d?/.test(el.textContent))) throw Error('美化的样式或特殊文本区域含动态捕获，需专门适配')
    const captures = [...new Set([...html.matchAll(capturePattern)].map(m=>Number(m[1])))].sort((a,b)=>a-b)
    const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT)
    const visible = new Set(); let node
    while ((node=walker.nextNode())) if (!['STYLE','SCRIPT'].includes(node.parentElement?.tagName)) for (const m of node.textContent.matchAll(capturePattern)) visible.add(Number(m[1]))
    if (captures.some(n=>!visible.has(n))) throw Error('美化捕获不在可更新的正文文本节点中')
    if (!captures.length) throw Error('美化没有可映射的 $1、$2 状态字段，需专门适配')
    if (!Array.isArray(plan.bindings) || plan.bindings.length !== captures.length || new Set(plan.bindings.map(b=>b.capture)).size !== captures.length || plan.bindings.some(b=>!captures.includes(b.capture) || typeof b.path !== 'string' || Object.keys(b).some(k=>!['capture','path','display'].includes(k) || k==='display' && !['text','list'].includes(b[k])))) throw Error('必须为原美化的每个捕获字段提供唯一变量映射')
    for (const binding of plan.bindings.filter(binding=>binding.display==='list')) {
      const texts=doc.createTreeWalker(doc.body,dom.window.NodeFilter.SHOW_TEXT)
      let text
      while ((text=texts.nextNode())) {
        if (![...text.nodeValue.matchAll(capturePattern)].some(match=>Number(match[1])===binding.capture)) continue
        const item=text.parentElement,list=item?.parentElement
        if (text.nodeValue!=='$'+binding.capture || item?.tagName!=='LI' || item.childNodes.length!==1 || !['UL','OL'].includes(list?.tagName) || list.children.length!==1) throw Error('列表绑定需要独立 ul/ol 内的单个 li 文本占位')
      }
    }
    return { version:1, ...(plan.collectionPath ? {collectionPath:plan.collectionPath} : {}), sourcePath:entry.path, sourceDigest:entry.digest, html, htmlDigest:hash(html), bindings:structuredClone(plan.bindings) }
  } finally { dom.window.close() }
}

// Script-driven views parse one captured text block (e.g. "[Stats|80|35]") with
// their own JS. Keep every original byte and feed that capture with text the tool
// renders from MVU variables in the card's own protocol.
function freezeProtocolAppearance(data, plan) {
  if (Object.keys(plan).some(key => !['sourcePath','protocol'].includes(key))) throw Error('协议适配只接受 sourcePath 和 protocol')
  const protocol = plan.protocol
  if (!protocol || typeof protocol !== 'object' || Object.keys(protocol).some(key => !['capture','template'].includes(key))) throw Error('protocol 只接受 capture 和 template')
  const entry = appearanceSources(data).find(x => x.path === plan.sourcePath)
  if (!entry) throw Error('美化来源不存在，请从 inspect.appearanceSources 选择')
  const source = data.extensions.regex_scripts[Number(plan.sourcePath.split('/')[3])].replaceString
  const fenced = source.trim().match(/^```html\s*\n([\s\S]*?)\n```$/i)
  const html = fenced ? fenced[1] : source
  if (!Number.isInteger(protocol.capture) || !entry.captures.includes(protocol.capture)) throw Error('protocol.capture 必须是原视图中的捕获编号: ' + entry.captures.map(n => '$' + n).join('、'))
  if (entry.captures.length !== 1) throw Error('协议适配要求原视图只有一个捕获文本；多个捕获请用 bindings 固化')
  const outside = outsideScripts(html)
  if (!new RegExp('\\$' + protocol.capture + '(?!\\d)').test(outside)) throw Error('原视图的捕获只出现在脚本内，无法作为面板文本输入')
  if (typeof protocol.template !== 'string' || !protocol.template.trim()) throw Error('protocol.template 必须是原卡状态协议文本，字段写作 {{/路径}}')
  const paths = protocolPaths(protocol.template)
  if (!paths.length) throw Error('protocol.template 没有 {{/路径}} 字段占位')
  const dom = new JSDOM(html)
  try {
    if (dom.window.document.querySelector('iframe,object,embed,base,meta[http-equiv]')) throw Error('美化包含嵌入文档，需专门适配；原视图保留，不自动删除')
  } finally { dom.window.close() }
  return { version:1, sourcePath:entry.path, sourceDigest:entry.digest, html, htmlDigest:hash(html), protocol:{ capture:protocol.capture, template:protocol.template } }
}
function outsideScripts(html) {
  return html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
}

// The original view runs in a fresh child document per render: its scripts expect
// to run once, against a filled capture, in their own global scope.
function renderProtocolAppearance(frozen, pointerKeys, initialState) {
  const paths = protocolPaths(frozen.protocol.template).map(path => {
    const keys = pointerKeys(path)
    let value = initialState
    for (const key of keys) {
      if (value == null || !Object.hasOwn(value, key)) throw Error('美化变量路径不存在: ' + path)
      value = value[key]
    }
    return [path, keys]
  })
  const literal = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/\$/g,'\\u0024').replace(/`/g,'\\u0060').replace(/\{\{/g,'\\u007b\\u007b').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')
  return `<div data-dsh-mvu-protocol-host></div>
<script data-dsh-frozen-mvu>
(function(){
const source=${literal(frozen.html)};
const template=${literal(frozen.protocol.template)};
const capture=new RegExp(${literal('\\$' + frozen.protocol.capture + '(?!\\d)')},'g');
const paths=new Map(${literal(paths)});
const placeholder=new RegExp(${literal('\\{\\{\\s*(\\/[^{}]*?)\\s*\\}\\}')},'g');
function format(value){if(value==null)return'';if(Array.isArray(value))return value.map(format).join('|');if(typeof value==='object')return Object.keys(value).filter(key=>!key.startsWith('\\u0024')&&!key.startsWith('__')).map(key=>format(value[key])).join('|');return String(value);}
function protocolText(state){return template.replace(placeholder,(_,path)=>{let value=state;for(const key of paths.get(path)||[])value=value!=null&&Object.prototype.hasOwnProperty.call(value,key)?value[key]:undefined;return format(value);});}
function escapeHtml(text){return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fill(text){const filled=escapeHtml(text);return source.split(/(<script\\b[\\s\\S]*?<\\/script\\s*>)/i).map((part,index)=>index%2?part:part.replace(capture,()=>filled)).join('');}
const host=document.querySelector('[data-dsh-mvu-protocol-host]');let frame=null,last=null,observer=null,replaying=false;
// The view keeps UI state (tab, flipped cards, open sections) in its own JS. A new
// document starts fresh, so replay the player's clicks on it to land where they were.
const clicks=[];
function pathOf(node,root){const path=[];while(node&&node!==root){const parent=node.parentElement;if(!parent)return null;path.unshift([...parent.children].indexOf(node));node=parent;}return node===root?path:null;}
function nodeAt(root,path){let node=root;for(const index of path){node=node&&node.children[index];}return node||null;}
function record(doc){doc.addEventListener('click',event=>{if(replaying||!event.isTrusted)return;const path=pathOf(event.target,doc.body);if(path)clicks.push(path);if(clicks.length>200)clicks.splice(0,clicks.length-200);},true);}
// Let each click's queued effects (e.g. a details toggle handler) run before the next.
async function replay(doc){replaying=true;try{for(const path of clicks){const node=nodeAt(doc.body,path);if(node&&typeof node.click==='function')try{node.click();}catch(_){}await new Promise(resolve=>setTimeout(resolve,0));}}finally{replaying=false;}}
function size(){try{const doc=frame&&frame.contentDocument;if(!doc||!doc.documentElement)return;const body=doc.body;if(!body)return;const style=getComputedStyle(body);frame.style.height=Math.ceil(Math.max(body.scrollHeight,body.getBoundingClientRect().height)+parseFloat(style.marginTop||0)+parseFloat(style.marginBottom||0))+'px';}catch(_){}}
function render(){const state=Mvu.getMvuData({type:'message',message_id:'latest'}).stat_data;const text=protocolText(state);if(text===last)return;last=text;
const previous=frame,next=document.createElement('iframe');next.setAttribute('data-dsh-mvu-protocol','');
next.style.cssText='display:block;width:100%;border:0;overflow:hidden'+(previous?';position:absolute;left:0;top:0;visibility:hidden':'');
next.addEventListener('load',async()=>{if(frame!==next)return;
try{const doc=next.contentDocument;record(doc);if(previous)await replay(doc);}catch(_){}
if(frame!==next)return;
// Swap only once the new view is ready, so an update never flashes an empty panel.
for(const item of [...host.querySelectorAll('iframe[data-dsh-mvu-protocol]')])if(item!==next)item.remove();if(previous){next.style.position='';next.style.left='';next.style.top='';next.style.visibility='';}
if(observer)observer.disconnect();size();try{observer=new ResizeObserver(size);observer.observe(next.contentDocument.documentElement);}catch(_){}});
host.style.position='relative';next.srcdoc=fill(text);host.appendChild(next);frame=next;}
async function start(){await waitGlobalInitialized('Mvu');for(const event of new Set([Mvu.events.VARIABLE_INITIALIZED,Mvu.events.VARIABLE_UPDATE_ENDED,...Object.values(tavern_events)]))eventOn(event,render);render();}
start().catch(error=>{console.error('MVU 原样式状态更新失败',error);});
})();
</script>`
}

export function renderFrozenAppearance(frozen, pointerKeys, initialState) {
  if (frozen.version !== 1 || hash(frozen.html) !== frozen.htmlDigest) throw Error('固化美化内容指纹不匹配')
  if (frozen.protocol) {
    // Revalidate persisted metadata, then render without touching the original bytes.
    freezeProtocolAppearance({extensions:{regex_scripts:[{replaceString:frozen.html}]}}, {sourcePath:'/extensions/regex_scripts/0/replaceString',protocol:frozen.protocol})
    return renderProtocolAppearance(frozen, pointerKeys, initialState)
  }
  // Revalidate persisted metadata before the validator executes the host binder.
  freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:frozen.html}]}}, {sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:frozen.bindings,...(frozen.collectionPath?{collectionPath:frozen.collectionPath}:{})})
  let examples = [initialState]
  const collectionKeys = frozen.collectionPath ? pointerKeys(frozen.collectionPath) : null
  if (collectionKeys) {
    let collection = initialState
    for (const key of collectionKeys) collection = collection?.[key]
    if (!collection || typeof collection !== 'object') throw Error('美化集合路径不存在: '+frozen.collectionPath)
    examples = Object.entries(collection).filter(([key])=>!key.startsWith('$') && !key.startsWith('__')).map(([,value])=>value)
    if (!examples.length && collection.$meta?.template) examples = [collection.$meta.template]
  }
  const bindings = frozen.bindings.map(binding => {
    const keys = pointerKeys(binding.path)
    for (let value of examples) for (const key of keys) {
      if (value == null || !Object.hasOwn(value,key)) throw Error('美化变量路径不存在: '+binding.path)
      value=value[key]
    }
    return {capture:binding.capture,keys,display:binding.display}
  })
  const encoded=JSON.stringify(bindings).replace(/</g,'\\u003c')
  const script=`<script data-dsh-frozen-mvu>
(function(){
const bindings=${encoded};
const collectionKeys=${JSON.stringify(collectionKeys).replace(/</g,'\\u003c')};
const nodes=[];const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
while((node=walker.nextNode())){if(['SCRIPT','STYLE'].includes(node.parentElement?.tagName))continue;if(/[\\x24]([1-9]\\d?)/.test(node.nodeValue))nodes.push({node,source:node.nodeValue});}
function bind(items,state){const values={};for(const binding of bindings){let value=state;for(const key of binding.keys)value=value!=null&&Object.prototype.hasOwnProperty.call(value,key)?value[key]:undefined;values[binding.capture]=binding.display==='list'?(Array.isArray(value)?value:value==null?[]:[value]):value==null?'':typeof value==='object'?JSON.stringify(value):String(value);}for(const item of items){const match=item.source.match(/^[\\x24]([1-9]\\d?)/);const list=match&&match[0]===item.source&&bindings.find(binding=>binding.capture===Number(match[1])&&binding.display==='list');if(list){item.list??=item.node.parentElement?.parentElement;if(!item.list||!['UL','OL'].includes(item.list.tagName))throw Error('列表组件需要独立的 ul/ol 与 li 占位');item.list.replaceChildren(...values[list.capture].map(value=>{const li=document.createElement('li');li.textContent=typeof value==='object'?JSON.stringify(value):String(value);return li;}));continue;}item.node.nodeValue=item.source.replace(/[\\x24]([1-9]\\d?)/g,(_,id)=>values[id]??'');}}
let prototypeView,container;const members=new Map();
if(collectionKeys){prototypeView=document.createElement('template');for(const child of [...document.body.childNodes]){if(child.nodeName==='SCRIPT'||child.nodeName==='STYLE')continue;prototypeView.content.appendChild(child);}container=document.createElement('div');document.body.appendChild(container);}
function render(){const state=Mvu.getMvuData({type:'message',message_id:'latest'}).stat_data;if(!collectionKeys){bind(nodes,state);return;}let collection=state;for(const key of collectionKeys)collection=collection?.[key];const entries=Object.entries(collection||{}).filter(([key])=>!key.startsWith('$')&&!key.startsWith('__'));const active=new Set(entries.map(([key])=>key));for(const [key,item] of members)if(!active.has(key)){item.root.remove();members.delete(key);}for(const [key,value] of entries){let item=members.get(key);if(!item){const root=document.createElement('div');root.appendChild(prototypeView.content.cloneNode(true));const items=[],walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let text;while((text=walk.nextNode()))if(!['STYLE','SCRIPT'].includes(text.parentElement?.tagName))items.push({node:text,source:text.nodeValue});item={root,items};members.set(key,item);container.appendChild(root);}bind(item.items,value);}}
async function start(){await waitGlobalInitialized('Mvu');for(const event of new Set([Mvu.events.VARIABLE_INITIALIZED,Mvu.events.VARIABLE_UPDATE_ENDED,...Object.values(tavern_events)]))eventOn(event,render);render();}
start().catch(error=>{console.error('MVU 原样式状态更新失败',error);});
})();
</script>`
  // Original layout/CSS bytes are preserved. Only append host-owned data binding.
  const html=/<\/body\s*>/i.test(frozen.html) ? frozen.html.replace(/<\/body\s*>/i,match=>script+'\n'+match) : frozen.html+'\n'+script
  // Avoid regex replacement captures and identity macros in the outer display rule.
  return html.replace(/<script data-dsh-frozen-mvu>([\s\S]*?)<\/script>/,(_,body)=>'<script data-dsh-frozen-mvu>'+body.replace(/\$/g,'\\u0024')+'</script>').replace(capturePattern,(_,id)=>'&#36;'+id)
}
