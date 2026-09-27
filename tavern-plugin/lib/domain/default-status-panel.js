// Built-in default status panel: gives every imported card a managed MVU panel
// without per-card conversion. A card that ships its own MVU status machinery
// (enabled mvu resources, <initvar> openings, or dsh-mvu rules) always wins.
export const DEFAULT_STATUS_VIEW_RULE_ID = 'dsh-default-status-view'
export const DEFAULT_STATUS_HIDE_RULE_ID = 'dsh-default-status-hide'
const MARKER = '<mvu-status/>'

export const DEFAULT_STATUS_INITIAL_STATE = {
  环境: { 时间: '未知', 地点: '未知', 天气: '未知', 温度: '未知' },
  玩家: { 穿着: '未知', 姿势: '未知', 阳具: '' },
  在场NPC: []
}

export const DEFAULT_STATUS_UPDATE_RULES = [
  '【内置默认状态栏】每轮后台维护以下状态变量，为下一轮提供参考信息。',
  '- 生效优先级：本规则为默认规则；若同时存在人物卡自带或更具体的状态更新规则，冲突处以更具体的规则为准。',
  '- 变量结构（路径相对于 stat_data）：',
  '  /环境/时间（「YYYY年M月D日 - 星期X - H:MM AM/PM」）、/环境/地点、/环境/天气、/环境/温度（如「22°C」）',
  '  /玩家/穿着、/玩家/姿势（<user>当前状态）',
  '  /玩家/阳具（可选，仅NSFW场景记录<user>的性器状态，其余场景保持空字符串）',
  '  /在场NPC（字符串数组，每位在场NPC一条，无人在场时为空数组），条目格式（可选项按场景省略）：',
  '    「#名字｜💄表情:…｜🧠想法:…｜🙋动作与体位:…｜👗上身:…｜👖下身:…｜👠丝袜/鞋子:…｜🩲内衣:…｜🥥乳房:…｜🦵美腿:…｜➕补充:…」',
  '- 更新纪律：',
  '  1. 依据本轮正文事实更新；描述客观、合理、简洁直白，每段不超过50字。',
  '  2. 合理估算剧情时间流逝并更新 /环境/时间。',
  '  3. 仅记录在场NPC，优先女性NPC；NPC退场后从 /在场NPC 移除对应条目，新NPC入场时追加。',
  '  4. 内心想法可记录任何好的或坏的想法（只有角色自己才知道，即使可能与当前剧情无关）。',
  '  5. NSFW场景中动作段记录性爱体位；丝袜/鞋子、内衣、乳房、美腿等可选段仅相应场景填写，每段<20字。',
  '  6. 角色不知晓这些数值记录，不得在正文中提及或直接引用。',
  '依据本轮已经发生的正文事实和当前变量快照，用 mvu_submit_update 提交。路径相对于 stat_data；无变化提交空 operations。'
].join('\n')

// Hand-written view script: parses the NPC entry format into per-field rows and
// keeps one collapsible block per character. The display rule substitutes $N
// captures, so this template must not contain a dollar sign.
const DEFAULT_STATUS_STYLE = [
  '.mds{--mds-line:rgba(148,163,184,.22);--mds-dim:#93a1b5;--mds-accent:#8fd0ff;box-sizing:border-box;margin:10px 0;color:#e6ecf5;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:13px;line-height:1.55}',
  '.mds *{box-sizing:border-box}',
  '.mds-panel{border:1px solid var(--mds-line);border-radius:14px;background:linear-gradient(158deg,rgba(21,25,35,.97),rgba(30,36,50,.97));box-shadow:0 6px 22px rgba(0,0,0,.34);overflow:hidden}',
  '.mds-head{display:flex;align-items:center;gap:8px;padding:11px 14px;cursor:pointer;user-select:none;list-style:none;background:linear-gradient(180deg,rgba(148,163,184,.10),rgba(148,163,184,.02))}',
  '.mds-head::-webkit-details-marker{display:none}',
  '.mds-head:hover{background:rgba(148,163,184,.14)}',
  '.mds-chev{width:10px;height:10px;border-right:1.6px solid var(--mds-dim);border-bottom:1.6px solid var(--mds-dim);transform:rotate(45deg);transition:transform .18s ease;flex:none}',
  '.mds-panel:not([open]) .mds-chev{transform:rotate(-45deg)}',
  '.mds-title{font-size:13.5px;font-weight:700;letter-spacing:.4px;color:#cfdae8}',
  '.mds-count{margin-left:auto;font-size:11.5px;color:var(--mds-dim);flex:none}',
  '.mds-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px}',
  '.mds-grid{display:grid;gap:8px}',
  '.mds-env{grid-template-columns:repeat(auto-fit,minmax(132px,1fr))}',
  '.mds-chip{display:flex;align-items:baseline;gap:6px;min-width:0;padding:6px 10px;border-radius:9px;background:rgba(148,163,184,.07);border:1px solid rgba(148,163,184,.13)}',
  '.mds-chip b{font-weight:500;font-size:11.5px;color:var(--mds-dim);flex:none}',
  '.mds-chip span{font-weight:600;font-size:12.5px;color:#eef3fa;overflow-wrap:anywhere}',
  '.mds-sec{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:600;letter-spacing:.6px;color:var(--mds-dim)}',
  '.mds-sec::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--mds-line),transparent)}',
  '.mds-row{display:grid;grid-template-columns:58px 1fr;gap:10px;align-items:baseline;padding:5px 2px}',
  '.mds-row+.mds-row{border-top:1px dashed rgba(148,163,184,.14)}',
  '.mds-row b{font-weight:500;font-size:11.5px;color:var(--mds-dim)}',
  '.mds-row span{overflow-wrap:anywhere;white-space:pre-wrap}',
  '.mds-empty{font-size:12px;color:var(--mds-dim);padding:2px}',
  '.mds-dim{color:#7c8798;font-weight:400}',
  '.mds-npcs{display:flex;flex-direction:column;gap:7px}',
  '.mds-npc{border:1px solid rgba(148,163,184,.17);border-radius:10px;background:rgba(148,163,184,.05);overflow:hidden}',
  '.mds-npc-head{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none;list-style:none;min-width:0}',
  '.mds-npc-head::-webkit-details-marker{display:none}',
  '.mds-npc-head:hover{background:rgba(148,163,184,.10)}',
  '.mds-npc[open] .mds-npc-head{background:rgba(148,163,184,.09);border-bottom:1px solid rgba(148,163,184,.14)}',
  '.mds-npc-name{font-weight:700;font-size:12.5px;color:var(--mds-accent);flex:none}',
  '.mds-mini{font-size:11.5px;color:#b9c5d6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
  '.mds-mini i{color:var(--mds-dim);font-style:normal}',
  '.mds-npc-body{padding:7px 10px 9px;display:flex;flex-direction:column}',
  '.mds-npc-body .mds-row{grid-template-columns:86px 1fr;padding:4px 0}',
  '.mds-npc-body .mds-row:first-child{border-top:none}',
  '.mds-npc-body .mds-row b{color:#9fb0c4}'
].join('\n')

const DEFAULT_STATUS_SCRIPT = [
  '(function(){',
  'var root=document.getElementById("dsh-default-status");',
  'if(!root)return;',
  'var envBox=root.querySelector("[data-role=env]"),userBox=root.querySelector("[data-role=user]");',
  'var npcList=root.querySelector("[data-role=npc-list]"),npcBox=root.querySelector("[data-role=npc]"),countBox=root.querySelector("[data-role=count]");',
  'var ENV=[["时间","时间"],["地点","地点"],["天气","天气"],["温度","温度"]];',
  'var USER=[["穿着","穿着"],["姿势","姿势"],["状态","阳具"]];',
  'var META=["💄表情","🙋动作与体位"];',
  'var members={},opens={};',
  'function text(value){return value===undefined||value===null?"":String(value)}',
  'function write(box,value){box.textContent=value;if(!value||value==="未知")box.className="mds-dim";else box.className="";}',
  'function segs(raw){return text(raw).split(/[｜|]/).map(function(part){return part.trim()}).filter(function(part){return part!==""})}',
  'function parse(raw){',
  '  var out={name:"",fields:[]};',
  '  var source=text(raw).trim().replace(/^#\\s*([^｜|:：]*?)\\s*[:：]\\s*/,function(all,name){return "#"+name+"｜";});',
  '  var list=segs(source);',
  '  if(!list.length)return out;',
  '  var head=list[0],headMatch=/^#?\\s*([^:：]+?)\\s*[:：]\\s*([\\s\\S]*)$/.exec(head);',
  '  if(headMatch){out.name=headMatch[1].trim();if(headMatch[2].trim())out.fields.push({label:"",value:headMatch[2].trim()});}',
  '  else{out.name=head.replace(/^#\\s*/,"").trim();}',
  '  for(var i=1;i<list.length;i++){',
  '    var part=list[i],match=/^([^:：]+?)\\s*[:：]\\s*([\\s\\S]*)$/.exec(part);',
  '    if(match)out.fields.push({label:match[1].trim(),value:match[2].trim()});',
  '    else out.fields.push({label:"",value:part});',
  '  }',
  '  return out;',
  '}',
  'function row(label,value){',
  '  var line=document.createElement("div");line.className="mds-row";',
  '  var name=document.createElement("b");name.textContent=label;line.appendChild(name);',
  '  var span=document.createElement("span");write(span,value);line.appendChild(span);',
  '  return line;',
  '}',
  'function fields(parent,list,npcMode){',
  '  parent.textContent="";',
  '  if(!list.length){var empty=document.createElement("div");empty.className="mds-empty";empty.textContent="（暂无）";parent.appendChild(empty);return;}',
  '  for(var i=0;i<list.length;i++){',
  '    var item=list[i];',
  '    if(!item.value){continue;}',
  '    parent.appendChild(row(item.label||"备注",item.value));',
  '  }',
  '  if(!parent.childNodes.length){var none=document.createElement("div");none.className="mds-empty";none.textContent="（暂无）";parent.appendChild(none);}',
  '}',
  'function renderEnv(state){',
  '  envBox.textContent="";',
  '  var env=(state&&state["环境"])||{};',
  '  for(var i=0;i<ENV.length;i++){',
  '    var chip=document.createElement("div");chip.className="mds-chip";',
  '    var label=document.createElement("b");label.textContent=ENV[i][0];chip.appendChild(label);',
  '    var value=document.createElement("span");write(value,text(env[ENV[i][1]]).trim());chip.appendChild(value);',
  '    envBox.appendChild(chip);',
  '  }',
  '}',
  'function renderUser(state){',
  '  userBox.textContent="";',
  '  var who=(state&&state["玩家"])||{};',
  '  var list=[];',
  '  for(var i=0;i<USER.length;i++)list.push({label:USER[i][0],value:text(who[USER[i][1]]).trim()});',
  '  fields(userBox,list);',
  '}',
  'function npcBody(parsed){',
  '  var body=document.createElement("div");body.className="mds-npc-body";',
  '  fields(body,parsed.fields,true);',
  '  return body;',
  '}',
  'function npcHead(parsed,index,item){',
  '  var head=document.createElement("summary");head.className="mds-npc-head";',
  '  var chev=document.createElement("span");chev.className="mds-chev";head.appendChild(chev);',
  '  var name=document.createElement("span");name.className="mds-npc-name";name.textContent=parsed.name||("角色"+(index+1));head.appendChild(name);',
  '  head.appendChild(headMeta(parsed));',
  '  return head;',
  '}',
  'function headMeta(parsed){',
  '  var wrap=document.createElement("span");wrap.className="mds-mini";',
  '  var parts=[];',
  '  for(var i=0;i<META.length;i++){',
  '    for(var j=0;j<parsed.fields.length;j++){',
  '      if(parsed.fields[j].label.indexOf(META[i].slice(2))<0)continue;',
  '      parts.push(META[i].slice(0,2)+parsed.fields[j].value);break;',
  '    }',
  '  }',
  '  if(!parts.length&&parsed.fields.length)parts.push(parsed.fields[0].value);',
  '  wrap.textContent=parts.join("  ");',
  '  return wrap;',
  '}',
  'function renderNpc(state){',
  '  var list=(state&&state["在场NPC"])||[];',
  '  if(!Array.isArray(list))list=[text(list)];',
  '  var items=list.map(function(entry){return parse(entry)}).filter(function(entry){return entry.name||entry.fields.length});',
  '  if(npcBox)npcBox.style.display=items.length?"":"none";',
  '  if(countBox)countBox.textContent=items.length?("共 "+items.length+" 人"):"";',
  '  var live={};',
  '  for(var i=0;i<items.length;i++){',
  '    var parsed=items[i],base=parsed.name||("角色"+(i+1)),key=base+"#"+i,node=members[key];',
  '    if(!node){',
  '      node=document.createElement("details");node.className="mds-npc";',
  '      node.appendChild(npcHead(parsed,i,node));',
  '      node.appendChild(npcBody(parsed));',
  '      members[key]=node;',
  '      opens[key]=items.length===1;',
  '      node.open=opens[key]===true;',
  '      (function(entry,key){entry.addEventListener("toggle",function(){opens[key]=entry.open;});})(node,key);',
  '    }else{',
  '      var head=node.querySelector(".mds-npc-head");',
  '      if(head){node.replaceChild(npcHead(parsed,i,node),head);}',
  '      var body=node.querySelector(".mds-npc-body");',
  '      if(body)node.replaceChild(npcBody(parsed),body);',
  '    }',
  '    live[key]=node;',
  '  }',
  '  for(var key in members){if(!live[key]&&members[key]&&members[key].parentNode)members[key].parentNode.removeChild(members[key]);}',
  '  members=live;',
  '  npcList.textContent="";',
  '  for(var name in members)if(members[name])npcList.appendChild(members[name]);',
  '}',
  'function render(){',
  '  var data=Mvu.getMvuData({type:"message",message_id:"latest"});',
  '  var state=(data&&data.stat_data)||{};',
  '  renderEnv(state);renderUser(state);renderNpc(state);',
  '}',
  'var events=[];',
  'try{events.push(Mvu.events.VARIABLE_INITIALIZED,Mvu.events.VARIABLE_UPDATE_ENDED);}catch(error){}',
  'try{if(typeof tavern_events==="object"&&tavern_events)for(var key in tavern_events){var value=tavern_events[key];if(typeof value==="string")events.push(value);}}catch(error){}',
  'for(var i=0;i<events.length;i++){if(events[i])eventOn(events[i],render);}',
  'function start(){try{render();}catch(error){console.debug("默认状态栏渲染失败",error);}}',
  'if(typeof waitGlobalInitialized==="function")waitGlobalInitialized("Mvu").then(start,function(){start();});',
  'else start();',
  '})();'
].join('\n')

export const DEFAULT_STATUS_HTML = [
  '<html><head></head><body><div class="mds" id="dsh-default-status">',
  '<style>' + DEFAULT_STATUS_STYLE + '</style>',
  '<details class="mds-panel" open>',
  '<summary class="mds-head"><span class="mds-chev"></span><span class="mds-title">📋 状态栏</span><span class="mds-count" data-role="count"></span></summary>',
  '<div class="mds-body">',
  '<div class="mds-grid mds-env" data-role="env"></div>',
  '<div class="mds-user" data-role="user"></div>',
  '<div class="mds-npc-sec" data-role="npc"><div class="mds-sec">在场NPC</div><div class="mds-npcs" data-role="npc-list"></div></div>',
  '</div>',
  '</details>',
  '<script data-dsh-default-status>',
  DEFAULT_STATUS_SCRIPT,
  '</script>',
  '</div></body></html>'
].join('\n')

let cachedRules = null

/** Host-installed regex rules for the built-in default panel. */
export function defaultStatusRegexScripts() {
  if (cachedRules !== null) return cachedRules
  cachedRules = [
    { id: DEFAULT_STATUS_VIEW_RULE_ID, scriptName: '默认状态栏', findRegex: '/<mvu-status\\s*\\/>/g', replaceString: '```html\n' + DEFAULT_STATUS_HTML + '\n```', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true },
    { id: DEFAULT_STATUS_HIDE_RULE_ID, scriptName: '隐藏模型历史中的默认状态栏入口', findRegex: '/\\n*<mvu-status\\s*\\/>/g', replaceString: '', placement: [2], disabled: false, markdownOnly: false, promptOnly: true, runOnEdit: true }
  ]
  return cachedRules
}

/** Default off-switch lives in Tavern settings; absent key means enabled. */
export function defaultStatusPanelEnabled(settings) {
  return !settings || settings.defaultStatusPanel !== false
}

export function defaultStatusVariables() {
  return {
    stat_data: structuredClone(DEFAULT_STATUS_INITIAL_STATE),
    schema: { type: 'object', properties: {} },
    initialized_lorebooks: {}
  }
}

/** Bake the same entrance a converted opening carries: initvar data + marker. */
export function appendDefaultStatusEntrance(text) {
  const body = String(text ?? '').trimEnd()
  const json = JSON.stringify(DEFAULT_STATUS_INITIAL_STATE, null, 2).replace(/</g, '\\u003c')
  return body + '\n\n<initvar>\n' + json + '\n</initvar>\n\n' + MARKER
}

/** Append host default status rules for chats flagged with the default panel. */
export function withDefaultStatusRegexScripts(chat, scripts) {
  if (!chat || chat.defaultStatusPanel !== true) return scripts
  const list = Array.isArray(scripts) ? scripts : []
  if (list.some(rule => rule && (rule.id === DEFAULT_STATUS_VIEW_RULE_ID || rule.id === 'dsh-mvu-status-view'))) return list
  return list.concat(defaultStatusRegexScripts())
}
