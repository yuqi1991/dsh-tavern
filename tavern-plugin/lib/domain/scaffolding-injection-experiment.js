const PROBES = Object.freeze([
  { name: 'worldbook-snapshot', text: '[DSH Tavern B-1 probe: worldbook-snapshot]' },
  { name: 'skill-catalog', text: '[DSH Tavern B-1 probe: skill-catalog]' },
  { name: 'writing-skill-reminder', text: '[DSH Tavern B-1 probe: writing-skill-reminder]' }
])

function shape(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

export function inspectPromptAssembly(assembly) {
  return Object.freeze(Object.fromEntries(Object.keys(assembly || {}).sort().map(key => [key, shape(assembly[key])])))
}

/**
 * B-1 transport probe. The stable markers are appended to runtime contexts,
 * which is the latest position exposed by PromptAssembly. The host decides
 * whether that context becomes a durable surface message; the live experiment
 * compares the resulting Session and model-request evidence.
 */
export function injectScaffoldingProbe(assembly) {
  if (!assembly || typeof assembly !== 'object') throw new TypeError('B-1 assembly 无效')
  const before = inspectPromptAssembly(assembly)
  const contexts = Array.isArray(assembly.contexts) ? assembly.contexts.slice() : []
  const entries = PROBES.map(probe => ({
    name: 'tavern:scaffolding-experiment:' + probe.name,
    text: probe.text
  }))
  assembly.contexts = contexts.concat(entries)
  return Object.freeze({
    version: 1,
    assemblyBefore: before,
    assemblyAfter: inspectPromptAssembly(assembly),
    position: 'contexts-tail',
    entries
  })
}

export function renderScaffoldingProbe(record) {
  const body = (record?.entries || []).map(entry => entry.text).join('\n\n')
  return body === '' ? '' : 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n' + body
}

export function inspectScaffoldingRequest(messages, record) {
  const expected = renderScaffoldingProbe(record)
  const rows = (Array.isArray(messages) ? messages : []).filter(message => {
    const text = (message?.content || []).filter(block => block?.type === 'text').map(block => String(block.text || '')).join('')
    return expected !== '' && text.includes(record.entries[0].text) && record.entries.every(entry => text.includes(entry.text))
  })
  return { expected, matches: rows.length, positions: rows.map(row => messages.indexOf(row)), exact: rows.some(row => row.content?.[0]?.text === expected) }
}
