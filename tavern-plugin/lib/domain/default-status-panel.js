import { freezeMvuAppearance, renderFrozenAppearance } from './mvu-conversion-appearance.js'
import { pointerKeys } from './mvu-conversion-artifacts.js'

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

const DEFAULT_STATUS_BINDINGS = [
  { capture: 1, path: '/环境/时间' },
  { capture: 2, path: '/环境/地点' },
  { capture: 3, path: '/环境/天气' },
  { capture: 4, path: '/环境/温度' },
  { capture: 5, path: '/玩家/穿着' },
  { capture: 6, path: '/玩家/姿势' },
  { capture: 7, path: '/玩家/阳具' },
  { capture: 8, path: '/在场NPC', display: 'list' }
]

const DEFAULT_STATUS_HTML = [
  '<html><head></head><body><div class="mvu-default-status">',
  '  <style>',
  '    .mvu-default-status{box-sizing:border-box;max-width:100%;margin:12px 0;padding:14px 16px;border-radius:12px;background:linear-gradient(150deg,#171b26,#1f2533);border:1px solid rgba(148,163,184,.25);box-shadow:0 4px 18px rgba(0,0,0,.35);color:#e2e8f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;font-size:13px;line-height:1.6}',
  '    .mvu-default-status *{box-sizing:border-box}',
  '    .mvu-ds-title{display:flex;align-items:center;gap:6px;font-weight:700;font-size:14px;letter-spacing:.5px;color:#cbd5e1;padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid rgba(148,163,184,.2)}',
  '    .mvu-ds-env{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}',
  '    .mvu-ds-chip{display:inline-flex;align-items:baseline;gap:5px;padding:3px 9px;border-radius:7px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.15);font-size:12px;min-width:0;max-width:100%}',
  '    .mvu-ds-chip b{color:#94a3b8;font-weight:500;white-space:nowrap}',
  '    .mvu-ds-chip span{color:#f1f5f9;font-weight:600;overflow-wrap:anywhere}',
  '    .mvu-ds-user{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-bottom:12px}',
  '    .mvu-ds-uitem{padding:6px 9px;border-radius:7px;background:rgba(148,163,184,.06);border:1px solid rgba(148,163,184,.12);font-size:12px;min-width:0}',
  '    .mvu-ds-uitem b{color:#94a3b8;font-weight:500;margin-right:5px;white-space:nowrap}',
  '    .mvu-ds-uitem span{color:#e2e8f0;overflow-wrap:anywhere}',
  '    .mvu-ds-npc-title{font-size:12px;color:#94a3b8;font-weight:600;margin:2px 0 6px}',
  '    .mvu-ds-npc-list{margin:0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:6px}',
  '    .mvu-ds-npc-list li{padding:6px 9px;border-radius:7px;background:rgba(148,163,184,.05);border-left:2px solid rgba(148,163,184,.45);color:#dbe3ee;font-size:12px;overflow-wrap:anywhere}',
  '  </style>',
  '  <div class="mvu-ds-title">📋 状态栏</div>',
  '  <div class="mvu-ds-env">',
  '    <span class="mvu-ds-chip"><b>时间</b><span>$1</span></span>',
  '    <span class="mvu-ds-chip"><b>地点</b><span>$2</span></span>',
  '    <span class="mvu-ds-chip"><b>天气</b><span>$3</span></span>',
  '    <span class="mvu-ds-chip"><b>温度</b><span>$4</span></span>',
  '  </div>',
  '  <div class="mvu-ds-user">',
  '    <span class="mvu-ds-uitem"><b>穿着</b><span>$5</span></span>',
  '    <span class="mvu-ds-uitem"><b>姿势</b><span>$6</span></span>',
  '    <span class="mvu-ds-uitem"><b>状态</b><span>$7</span></span>',
  '  </div>',
  '  <div class="mvu-ds-npc-title">在场NPC</div>',
  '  <ul class="mvu-ds-npc-list"><li>$8</li></ul>',
  '</div></body></html>'
].join('\n')

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

let cachedRules = null

/** Host-installed regex rules, mirroring the managed conversion artifacts. */
export function defaultStatusRegexScripts() {
  if (cachedRules !== null) return cachedRules
  const frozen = freezeMvuAppearance(
    { extensions: { regex_scripts: [{ replaceString: DEFAULT_STATUS_HTML }] } },
    { sourcePath: '/extensions/regex_scripts/0/replaceString', bindings: DEFAULT_STATUS_BINDINGS }
  )
  const statusHtml = renderFrozenAppearance(frozen, pointerKeys, DEFAULT_STATUS_INITIAL_STATE)
  cachedRules = [
    { id: DEFAULT_STATUS_VIEW_RULE_ID, scriptName: '默认状态栏', findRegex: '/<mvu-status\\s*\\/>/g', replaceString: '```html\n' + statusHtml + '\n```', placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true },
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
