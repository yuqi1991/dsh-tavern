import { assertDefinition, definitionDigest } from './mvu-conversion-definition.js'
import { Script } from 'node:vm'
import { JSDOM } from 'jsdom'
import { isDeepStrictEqual } from 'node:util'
import { buildMvuArtifacts, MVU_CONVERSION_KEY, MVU_MARKER, MVU_RULE_IDS, pointerKeys } from './mvu-conversion-artifacts.js'
import { projectReplyLayers } from './reply-presentation.js'
import { projectPersistentStatusView } from './persistent-status-view.js'
import { inspectCardExtensions } from './card-extension-reading.js'
import { inspectWorldBookDocument } from './worldbook-resource.js'
import { liveSelfSourcedMeta } from './mvu-self-source.js'
import { constantWorldBookContext, mvuUpdateRulesFromWorldBook } from './worldbook-recall.js'

// Only the exact host-owned template is executed. Imported card JS/EJS never runs
// in this process. These are DOM/data simulations, not a model or MVU settlement.
async function simulatePanel(html, initialState, frozen = false) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  const handlers = new Map(), w = dom.window
  let state = structuredClone(initialState)
  Object.assign(w, {
    Mvu: { getMvuData: () => ({ stat_data: state }), events: { VARIABLE_INITIALIZED: 'initialized', VARIABLE_UPDATE_ENDED: 'updated' } },
    tavern_events: { CHAT_CHANGED: 'restored' }, waitGlobalInitialized: async () => {},
    eventOn: (name, callback) => handlers.set(name, callback)
  })
  const text = () => {
    if (!frozen) return w.document.querySelector('#values').textContent
    // Protocol views hand the filled original document to a child frame; the
    // card's own scripts are not executed here, only the host-filled input.
    if (frozen.protocol) { const frame = [...w.document.querySelectorAll('iframe[data-dsh-mvu-protocol]')].at(-1); return frame ? String(frame.srcdoc ?? frame.getAttribute('srcdoc') ?? '') : '' }
    const walker = w.document.createTreeWalker(w.document.body,w.NodeFilter.SHOW_TEXT)
    let node, result = ''
    while ((node=walker.nextNode())) if (!['SCRIPT','STYLE'].includes(node.parentElement?.tagName)) result += node.nodeValue
    return result
  }
  try {
    for (const element of w.document.querySelectorAll('script')) new Script(element.textContent).runInContext(dom.getInternalVMContext(), { timeout: 1000 })
    await new Promise(resolve => setImmediate(resolve))
    if (!handlers.has('updated') || !handlers.has('initialized') || !handlers.has('restored')) throw Error('缺少初始化、更新或恢复订阅')
    const before = text()
    if (!(frozen ? before.length : w.document.querySelector('#values').children.length)) throw Error('模板未显示初值')
    // Change all visible leaves, including selected fields and nested collections.
    const mutate = value => value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key.startsWith('$') || key.startsWith('__') ? child : mutate(child)]))
      : 'DSH_MVU_VALIDATION_UPDATED'
    const details = w.document.querySelector('details'); if (details) details.open = true
    state = mutate(initialState); handlers.get('updated')()
    if (details && (!details.open || details !== w.document.querySelector('details'))) throw Error('变量更新丢失原视图折叠状态')
    if (!text().includes('DSH_MVU_VALIDATION_UPDATED') || text() === before) throw Error('更新事件后未重读最新变量')
    state = structuredClone(initialState); handlers.get('restored')()
    if (text() !== before) throw Error('恢复事件后显示未还原')
    if (frozen?.collectionPath) {
      const keys=pointerKeys(frozen.collectionPath)
      const collection=()=>keys.reduce((value,key)=>value[key],state)
      const members=Object.keys(collection()).filter(key=>!key.startsWith('$')&&!key.startsWith('__'))
      if(members.length) {
        // Mutating every field at once only proves that at least one is visible.
        // Probe each member/capture independently, then exercise insertion/removal.
        for(const member of members) for(const binding of frozen.bindings) {
          state=structuredClone(initialState)
          const path=pointerKeys(binding.path);let parent=collection()[member]
          for(const key of path.slice(0,-1))parent=parent[key]
          parent[path.at(-1)]='DSH_MVU_ONE_FIELD_PROBE'
          handlers.get('updated')()
          if(!text().includes('DSH_MVU_ONE_FIELD_PROBE')) throw Error('人物字段未显示: '+member+binding.path)
        }
        state=structuredClone(initialState)
        const name='DSH_MVU_ADDED_MEMBER'
        collection()[name]=structuredClone(collection()[members[0]])
        const path=pointerKeys(frozen.bindings[0].path);let parent=collection()[name]
        for(const key of path.slice(0,-1))parent=parent[key]
        parent[path.at(-1)]=name;handlers.get('updated')()
        if(!text().includes(name)) throw Error('新增人物未显示')
        state=structuredClone(initialState);handlers.get('restored')()
        if(text()!==before) throw Error('回退后新增人物未移除')
      }
    }
  } finally { w.close() }
}

export async function validateMvuConversion(data) {
  const checks = []
  const check = async (name, run) => {
    try { checks.push({ name, status: 'passed', detail: await run() }) }
    catch (error) { checks.push({ name, status: 'failed', detail: error.message }) }
  }
  let meta = data.extensions?.[MVU_CONVERSION_KEY]
  // Self-sourced cards are validated against what the card text says now.
  if (meta?.selfSourced === true) {
    try { meta = liveSelfSourcedMeta(data) }
    catch (error) { return { valid: false, checks: [{ name: 'cardText', status: 'failed', detail: error.message }], limitations: [] } }
  }
  if (meta?.version !== 1) return { valid: false, checks: [{ name: 'managedConversion', status: 'failed', detail: '不是专用工具生成的 MVU 副本；未执行未知卡片代码' }] }
  let expected
  await check('definition', () => { expected = buildMvuArtifacts(meta); return '初值与展示路径有效' })
  if (!expected) return { valid: false, checks }
  const entries = data.character_book?.entries || [], regexScripts = data.extensions?.regex_scripts || []
  if (meta.definition) await check('fieldCoverage', () => {
    if (definitionDigest(meta.definition)!==meta.definitionRevision) throw Error('字段定义指纹不一致')
    assertDefinition(meta.definition,meta)
    const greetings=[data.first_mes,...(data.alternate_greetings || [])]
    if(greetings.length!==meta.openingStates.length) throw Error('开场数量与字段定义不一致')
    for (const [index,greeting] of greetings.entries()) {
      const blocks=[...greeting.matchAll(/<initvar>([\s\S]*?)<\/initvar>/g)]
      if(blocks.length!==1 || !isDeepStrictEqual(JSON.parse(blocks[0][1]),meta.openingStates[index])) throw Error('开场字段缺少或初值改变: '+index)
    }
    return '全部已登记字段、来源值及各开场初值与保存定义一致'
  })
  await check('initializationDefinition', () => {
    const init = entries.filter(entry => /^\s*\[initvar\]/i.test(entry.comment || ''))
    if (init.length !== 1 || init[0].enabled !== false || !isDeepStrictEqual(JSON.parse(init[0].content), meta.initialState)) throw Error('初值条目重复、被改动或进入普通正文注入')
    return '唯一初值条目可解析且与定义一致；尚未运行官方 MVU 初始化'
  })
  await check('backgroundRouting', () => {
    const worldBook = { view: inspectWorldBookDocument(data.character_book) }
    const rules = mvuUpdateRulesFromWorldBook(worldBook)
    if (rules.length !== 1 || rules[0] !== expected.entries[1].content) throw Error('后台规则缺失、重复或与定义不一致')
    const foreground = constantWorldBookContext({ worldBook }).context
    if (foreground.includes(expected.entries[1].content) || foreground.includes(expected.entries[0].content)) throw Error('MVU 专用条目进入前台注入')
    return '状态更新规则只进入后台'
  })
  let trusted = false
  await check('managedPanel', () => {
    for (const rule of expected.regexScripts) {
      const found = regexScripts.filter(candidate => candidate.id === rule.id)
      if (found.length !== 1 || !isDeepStrictEqual(found[0], rule)) throw Error('托管状态规则被改动或重复: ' + rule.id)
    }
    if (regexScripts.some(rule => !MVU_RULE_IDS.includes(rule.id) && /StatusPlaceHolderImpl|<[a-z0-9-]*-status\b/i.test(rule.findRegex || ''))) throw Error('仍有另一套状态面板规则')
    trusted = true; return '唯一的宿主管理视图与显示规则'
  })
  await check('greetingsAndHistory', () => {
    const displayRules = inspectCardExtensions(data).regexScripts
    for (const [index, greeting] of [data.first_mes, ...(data.alternate_greetings || [])].entries()) {
      if (typeof greeting !== 'string' || greeting.split(MVU_MARKER).length !== 2) throw Error('开场 ' + index + ' 的入口缺失或重复')
      const layers = projectReplyLayers(greeting, { regexScripts: displayRules, placement: 2, depth: 0 })
      if (layers.sessionText.includes(MVU_MARKER) || layers.sessionText.includes('Mvu.getMvuData')) throw Error('状态入口或 HTML 泄漏到模型历史')
      const view = projectPersistentStatusView([{ role: 'assistant', turn: 1, text: greeting }], [{turn:1,parts:layers.displayParts}], {regexScripts:displayRules})
      if (view.statusViews.length !== 1 || view.projections.some(p => p.parts.some(part => part.kind === 'html' && /Mvu\.getMvuData|<mvu-status/.test(part.content)))) throw Error('开场 ' + index + ' 状态面板缺失或重复')
      if (view.statusView.content.trim() !== expected.statusHtml.trim()) throw Error('显示替换改变了固化视图，请检查其他正则冲突')
    }
    return '所有开场入口唯一，显示提升到右侧，模型历史不含入口'
  })
  if (trusted) await check('templateSimulation', async () => {
    for (const state of meta.openingStates || [meta.initialState]) await simulatePanel(expected.statusHtml, state, meta.frozenAppearance)
    if (meta.frozenAppearance?.protocol) return '原视图按卡片状态协议填入变量文本，模拟初值、更新及恢复后重新生成；原卡脚本未在此执行'
    return meta.frozenAppearance ? (meta.frozenAppearance.generated ? '生成视图' : '原视图') + '在 DOM 中显示初值、更新及恢复，保留折叠交互状态' : '固定 HTML 在 DOM 中显示初值，模拟更新及恢复事件后重读最新变量'
  })
  const limitations = ['真实模型后台提交与官方 MVU 结算', '浏览器布局、字号与实际会话切换', '原卡复杂脚本、活动预设/全局正则及剧情语义']
  return { valid: checks.every(item => item.status === 'passed'), checks, limitations, scope: '自动结构/投影检查及托管视图 DOM 模拟；不代表真实游玩验收' }
}
