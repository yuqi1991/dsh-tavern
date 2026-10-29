import { MVU_CONVERSION_KEY, MVU_MARKER, MVU_RULE_IDS, MVU_RULE_TAIL, isObject } from './mvu-conversion-artifacts.js'
import { definitionDigest, leaves } from './mvu-conversion-definition.js'

// A self-sourced MVU card is its own story source: the conversion owns only the
// generated parts (initvar/update entries, status regexes, opening suffixes and
// metadata). Stripping those parts yields the base the conversion regenerates from,
// so story fields can be edited in place without a separate base card.
const INITVAR_OPEN = '\n\n<initvar>\n', INITVAR_CLOSE = '\n</initvar>'

export function isManagedMvuEntry(entry) {
  return /^\s*\[(?:initvar|mvu_update)\]/i.test(String(entry?.comment || entry?.name || ''))
}

export function splitMvuGreeting(text) {
  if (typeof text !== 'string') return { body: text, suffix: '' }
  const marker = text.lastIndexOf(MVU_MARKER)
  if (marker < 0 || text.slice(marker + MVU_MARKER.length).trim()) return { body: text, suffix: '' }
  let start = text.slice(0, marker).replace(/\n*$/, '').length
  const before = text.slice(0, start)
  if (before.endsWith(INITVAR_CLOSE)) {
    const open = before.lastIndexOf(INITVAR_OPEN)
    if (open >= 0) start = open
  }
  return { body: text.slice(0, start), suffix: text.slice(start) }
}

export function selfSourcedMeta(data, path) {
  const meta = data?.extensions?.[MVU_CONVERSION_KEY]
  return isObject(meta) && meta.selfSourced === true && (path === undefined || meta.sourcePath === path) ? meta : null
}

export function stripManagedMvu(data) {
  const base = structuredClone(data)
  base.first_mes = splitMvuGreeting(base.first_mes).body
  if (Array.isArray(base.alternate_greetings)) base.alternate_greetings = base.alternate_greetings.map(text => splitMvuGreeting(text).body)
  if (Array.isArray(base.character_book?.entries)) base.character_book.entries = base.character_book.entries.filter(entry => !isManagedMvuEntry(entry))
  if (Array.isArray(base.extensions?.regex_scripts)) base.extensions.regex_scripts = base.extensions.regex_scripts.filter(rule => !MVU_RULE_IDS.includes(rule?.id))
  if (isObject(base.extensions)) delete base.extensions[MVU_CONVERSION_KEY]
  return base
}

// The file is the only truth: opening values, the initial template and update
// rules are read back from the card text itself, so hand edits are honoured.
// Only the panel design (meta.appearance) lives solely in metadata.
export function liveSelfSourcedMeta(data) {
  const meta = selfSourcedMeta(data)
  if (!meta) return null
  const greetings = [data.first_mes, ...(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [])]
  const openingStates = greetings.map((text, index) => {
    const suffix = splitMvuGreeting(text).suffix
    const open = suffix.indexOf('<initvar>'), close = suffix.lastIndexOf('</initvar>')
    if (open < 0 || close < open) throw Error('开场 ' + index + ' 缺少 <initvar> 初值块')
    let state
    try { state = JSON.parse(suffix.slice(open + 9, close)) } catch (error) { throw Error('开场 ' + index + ' 的 <initvar> 不是有效 JSON: ' + error.message) }
    if (!isObject(state)) throw Error('开场 ' + index + ' 的 <initvar> 必须是对象')
    return state
  })
  const entries = Array.isArray(data.character_book?.entries) ? data.character_book.entries : []
  const init = entries.filter(entry => /^\s*\[initvar\]/i.test(String(entry?.comment || '')))
  const rule = entries.filter(entry => /^\s*\[mvu_update\]/i.test(String(entry?.comment || '')))
  let initialState = openingStates[0]
  if (init.length === 1) {
    try { initialState = JSON.parse(init[0].content) } catch (error) { throw Error('[initvar] 条目不是有效 JSON: ' + error.message) }
  }
  const ruleText = rule.length === 1 ? String(rule[0].content || '') : String(meta.updateRules || '')
  const updateRules = ruleText.endsWith(MVU_RULE_TAIL) ? ruleText.slice(0, -MVU_RULE_TAIL.length) : ruleText
  const live = { ...structuredClone(meta), initialState, openingStates, updateRules }
  if (isObject(meta.definition)) {
    live.definition = { ...structuredClone(meta.definition), initialState, openingStates, updateRules, fields: openingStates.map(state => leaves(state)) }
    live.definitionRevision = definitionDigest(live.definition)
  }
  return live
}

// Ordinary card saves may rewrite opening text; keep each opening's generated
// suffix so its variables and status entrance survive. Opening count belongs to
// the variable definition and changes only through the MVU draft.
export function preserveSelfSourcedGreetings(data, patch) {
  if (!selfSourcedMeta(data) || !isObject(patch)) return patch
  const next = { ...patch }
  const keep = (text, current) => typeof text === 'string' && !splitMvuGreeting(text).suffix ? text.trimEnd() + splitMvuGreeting(current).suffix : text
  if (Object.hasOwn(next, 'first_mes')) next.first_mes = keep(next.first_mes, data.first_mes)
  if (Object.hasOwn(next, 'alternate_greetings')) {
    const current = Array.isArray(data.alternate_greetings) ? data.alternate_greetings : []
    if (!Array.isArray(next.alternate_greetings) || next.alternate_greetings.length !== current.length) throw new Error('MVU 卡的开场数量由变量定义管理；增删开场请用 tavern_card_draft（begin 传 path）同步各开场初值')
    next.alternate_greetings = next.alternate_greetings.map((text, index) => keep(text, current[index]))
  }
  return next
}
