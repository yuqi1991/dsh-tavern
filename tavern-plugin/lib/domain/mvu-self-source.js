import { createHash } from 'node:crypto'
import { MVU_CONVERSION_KEY, MVU_MARKER, MVU_RULE_IDS, isObject } from './mvu-conversion-artifacts.js'

// A self-sourced MVU card is its own story source: the conversion owns only the
// generated parts (initvar/update entries, status regexes, opening suffixes and
// metadata). Stripping those parts yields the base the conversion regenerates from,
// so story fields can be edited in place without a separate base card.
const INITVAR_OPEN = '\n\n<initvar>\n', INITVAR_CLOSE = '\n</initvar>'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

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

// Integrity covers only what the conversion generated; story edits stay legal.
export function managedMvuDigest(data) {
  const meta = structuredClone(data?.extensions?.[MVU_CONVERSION_KEY] || null)
  if (meta) delete meta.outputDigest
  return digest({
    meta,
    entries: (data?.character_book?.entries || []).filter(isManagedMvuEntry),
    regex: (data?.extensions?.regex_scripts || []).filter(rule => MVU_RULE_IDS.includes(rule?.id)),
    greetings: [data?.first_mes, ...(data?.alternate_greetings || [])].map(text => splitMvuGreeting(text).suffix)
  })
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
