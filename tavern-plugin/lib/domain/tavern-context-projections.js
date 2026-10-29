import { SURFACE_SELECT_TYPE } from './surface-selection.js'

/**
 * 0.2.1 token meter registers two session projections that fold the model
 * surface into bounded scalars: contextPressure (surface total, drives the
 * context percentage) and contextBreakdown (system/tools/message split). Both
 * fold only events that carry a surfaceOp. Our by-reference selection
 * (ADR-0009) has none, so rollback / variant switch / undo-rollback were
 * ignored, and a replacement written without an adjacent compaction
 * shadow-price event folds with zero delta. The totals then drift away from
 * what deriveMessages() would price.
 *
 * Projections are pure folds over (state, event): they are also driven without
 * a Session (cold restore from the projection cache), so a selection cannot
 * look its nodes up in a session. The wrapper therefore carries one extra
 * `tavern` field in the state: the heuristic price of every surface event seen
 * so far plus the current surface order. A selection re-bases the total on its
 * nodes, a replacement subtracts exactly the nodes it displaces. Prices come
 * from the host's own fold, run on an append-shaped copy of the event, so both
 * surfaces keep pricing identically. The wrapped definition carries its own
 * stateVersion, so cached rows written by the stock definition refold.
 *
 * Deliberately bound to the state shape of the upstream versions below. Any
 * other version fails loudly instead of being silently misread.
 */
export const SUPPORTED_PROJECTION_VERSIONS = Object.freeze({ contextPressure: 5, contextBreakdown: 6 })
const WRAPPED = Symbol.for('dsh-tavern.context-projection.v1')
const installations = new WeakMap()
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** Cached rows of the stock definition must not be read as ours, and vice versa. */
export const tavernStateVersion = upstream => upstream * 1000 + 1

// Chunked lists. A state is immutable (a projection cache may serialize it
// after later events were folded), so an append has to copy; copying one
// 256-entry chunk plus the chunk index keeps a long session's fold near linear,
// where copying a flat list per event is quadratic. Every chunk but the last is
// full, so an index is plain arithmetic.
const CHUNK = 256
const chunkLength = chunks => chunks.length === 0 ? 0 : (chunks.length - 1) * CHUNK + chunks[chunks.length - 1].length
const chunkAt = (chunks, index) => chunks[(index / CHUNK) | 0][index % CHUNK]
function chunkPush(chunks, value) {
  const last = chunks[chunks.length - 1]
  if (last === undefined || last.length >= CHUNK) return chunks.concat([[value]])
  const next = chunks.slice()
  const grown = last.slice()
  grown.push(value)
  next[next.length - 1] = grown
  return next
}
function chunkFrom(list) {
  const chunks = []
  for (let index = 0; index < list.length; index += CHUNK) chunks.push(list.slice(index, index + CHUNK))
  return chunks
}
const chunkFlat = chunks => chunks.flat()

function emptyTavern() { return { seqs: [], tokens: [], systems: [], nodes: [], total: 0, broken: false } }

function priceOf(tavern, seq) {
  let low = 0
  let high = chunkLength(tavern.seqs) - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = chunkAt(tavern.seqs, mid)
    if (value === seq) return chunkAt(tavern.tokens, mid)
    if (value < seq) low = mid + 1
    else high = mid - 1
  }
  return undefined
}

/** Next `tavern` for one surface event or selection. A shape it cannot follow marks itself broken. */
function foldTavern(tavern, event, price) {
  if (event.type === SURFACE_SELECT_TYPE) {
    const list = event.data?.nodes
    if (!Array.isArray(list)) return { ...tavern, broken: true }
    let total = 0
    for (const seq of list) {
      const known = priceOf(tavern, seq)
      if (known === undefined) return { ...tavern, broken: true }
      total += known
    }
    return { ...tavern, nodes: chunkFrom(list), total, broken: false }
  }
  const last = chunkLength(tavern.seqs) - 1
  const fresh = last < 0 || chunkAt(tavern.seqs, last) < event.seq
  const seqs = fresh ? chunkPush(tavern.seqs, event.seq) : tavern.seqs
  const tokens = fresh ? chunkPush(tavern.tokens, price) : tavern.tokens
  const systems = fresh && event.type === 'system/message' ? [...tavern.systems, event.seq] : tavern.systems
  const op = event.surfaceOp
  if (op === 'append') return { seqs, tokens, systems, nodes: chunkPush(tavern.nodes, event.seq), total: tavern.total + price, broken: tavern.broken }
  const current = chunkFlat(tavern.nodes)
  const start = current.indexOf(op.startSeq)
  const end = current.indexOf(op.endSeq)
  if (start === -1 || end < start) return { ...tavern, seqs, tokens, systems, broken: true }
  let removed = 0
  for (let index = start; index <= end; index++) {
    const known = priceOf(tavern, current[index])
    if (known === undefined) return { ...tavern, seqs, tokens, systems, broken: true }
    removed += known
  }
  current.splice(start, end - start + 1, event.seq)
  return { seqs, tokens, systems, nodes: chunkFrom(current), total: tavern.total - removed + price, broken: tavern.broken }
}

function survivingSystems(tavern) {
  const systems = new Set(tavern.systems)
  return chunkFlat(tavern.nodes).filter(seq => systems.has(seq)).map(seq => ({ seq, tokens: priceOf(tavern, seq) ?? 0 }))
}

const overlays = {
  contextPressure(base, tavern) {
    return base.surfaceTokens === tavern.total ? base : { ...base, surfaceTokens: tavern.total }
  },
  // Same publication rule as the stock withTotals: the last non-empty system
  // prompt is system tokens, everything else on the surface is messages.
  contextBreakdown(base, tavern, appended) {
    // An append never reorders or removes system prompts: the stock list is right.
    const systems = appended ? base.systems : survivingSystems(tavern)
    const surfaceTokens = Math.max(0, tavern.total)
    const systemTokens = systems.findLast(system => system.tokens > 0)?.tokens ?? 0
    const messageTokens = Math.max(0, surfaceTokens - systemTokens)
    const same = systemTokens === base.breakdown.systemTokens && messageTokens === base.breakdown.messageTokens
    return { ...base, systems, surfaceTokens, breakdown: same ? base.breakdown : { systemTokens, toolsTokens: base.breakdown.toolsTokens, messageTokens } }
  },
}

function tavernSchema(value) {
  const numbers = list => Array.isArray(list) && list.every(item => Number.isSafeInteger(item) && item >= 0)
  const chunked = chunks => Array.isArray(chunks) && chunks.every((chunk, index) => numbers(chunk)
    && chunk.length > 0 && chunk.length <= CHUNK && (index === chunks.length - 1 || chunk.length === CHUNK))
  if (!value || typeof value !== 'object' || !chunked(value.seqs) || !chunked(value.tokens) || !chunked(value.nodes) || !numbers(value.systems)
    || chunkLength(value.seqs) !== chunkLength(value.tokens) || !Number.isSafeInteger(value.total) || typeof value.broken !== 'boolean') {
    throw new Error('context projection: malformed tavern surface state')
  }
  return value
}

/** Wrap one stock projection definition. Exported for tests and the startup self-test. */
export function wrapContextProjection(definition) {
  const key = definition?.key
  const overlay = overlays[key]
  if (!overlay) throw new Error('context projection: no Tavern fold for ' + String(key))
  if (definition[WRAPPED]) return definition
  const supported = SUPPORTED_PROJECTION_VERSIONS[key]
  if (definition.stateVersion !== supported) {
    throw new Error(`当前 DSH 的 ${key} 会话投影状态版本为 ${definition.stateVersion}，酒馆只适配 ${supported}；请使用允许清单内的 DSH 版本`)
  }
  for (const member of ['init', 'apply']) {
    if (typeof definition[member] !== 'function') throw new Error(`当前 DSH 的 ${key} 会话投影缺少 ${member}，酒馆无法适配`)
  }
  if (typeof definition.stateSchema?.parse !== 'function') throw new Error(`当前 DSH 的 ${key} 会话投影缺少 stateSchema，酒馆无法适配`)
  // Price an event the way the stock fold does, as a plain append.
  function price(event) {
    const { sourceEventSeqs: _sources, ...rest } = event
    return definition.apply(definition.init(undefined, 0), { ...rest, surfaceOp: 'append' }).surfaceTokens
  }
  const wrapped = {
    ...definition,
    [WRAPPED]: true,
    stock: definition,
    stateVersion: tavernStateVersion(supported),
    stateSchema: {
      parse(value) {
        if (!value || typeof value !== 'object') throw new Error('context projection: state must be an object')
        const { tavern, ...stock } = value
        return { ...definition.stateSchema.parse(stock), tavern: tavernSchema(tavern) }
      },
    },
    init: (...args) => ({ ...definition.init(...args), tavern: emptyTavern() }),
    apply(state, event) {
      let next = definition.apply(state, event)
      if (next.tavern !== state.tavern) next = { ...next, tavern: state.tavern }
      const selection = event.type === SURFACE_SELECT_TYPE
      // Same test as the stock isSurfaceEvent: only message types with a surfaceOp.
      if (!selection && !(SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined)) return next
      const tavern = foldTavern(state.tavern, event, selection ? 0 : price(event))
      return tavern.broken ? { ...next, tavern } : { ...overlay(next, tavern, event.surfaceOp === 'append'), tavern }
    },
  }
  return wrapped
}

/**
 * Prove, on the wrapped definitions, the invariant the whole wrapper exists
 * for: after replacements and selections the state equals a fresh fold of the
 * surviving nodes as plain appends. Throws before anything is installed.
 */
export function selfTestContextProjections(definitions) {
  const message = (role, length) => ({ id: role + length, role, content: [{ type: 'text', text: 'x'.repeat(length) }], source: { kind: 'user' } })
  const body = length => ({ turn: 1, step: 1, stream: [], message: { ...message('assistant', length), source: { kind: 'model', provider: 'probe', model: 'probe' } } })
  const system = length => ({ turn: 1, step: 1, message: { ...message('system', length), source: { kind: 'system-prompt' } } })
  const log = [
    { type: 'system/message', data: system(120), surfaceOp: 'append' },
    { type: 'user/message', data: message('user', 400), surfaceOp: 'append' },
    { type: 'assistant/message', data: body(2000), surfaceOp: 'append' },
    { type: 'user/message', data: message('user', 80), surfaceOp: 'append' },
    { type: 'assistant/message', data: body(60), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
    { type: SURFACE_SELECT_TYPE, data: { version: 1, nodes: [0, 1, 2] } },
    { type: SURFACE_SELECT_TYPE, data: { version: 1, nodes: [0, 1, 4, 3] } },
    { type: SURFACE_SELECT_TYPE, data: { version: 1, nodes: [0] } },
  ].map((event, seq) => ({ ...event, seq, time: seq }))
  for (const definition of definitions) {
    let state = definition.init(undefined, 0)
    for (const event of log) {
      state = definition.apply(state, event)
      const surface = chunkFlat(state.tavern.nodes)
      // The oracle: the stock fold over exactly those nodes, appended in order.
      const stock = definition.stock
      let expected = stock.init(undefined, 0)
      for (const seq of surface) expected = stock.apply(expected, { ...log[seq], seq, surfaceOp: 'append', sourceEventSeqs: undefined })
      const { tavern: _tavern, ...stockState } = state
      if (state.tavern.broken || essence(stockState) !== essence(expected)) {
        throw new Error(`会话投影补丁自检失败：${definition.key} 在 seq ${event.seq} 之后与重新折叠不一致`)
      }
    }
  }
}
// What both projections publish from the surface; absent fields drop out of the JSON.
function essence({ surfaceTokens, systems, breakdown }) { return JSON.stringify({ surfaceTokens, systems, breakdown }) }

/**
 * Teach the stock contextPressure / contextBreakdown projections the
 * selection and unpriced replacements. Returns the disposer.
 * @param registry - `ctx.sessionProjections`.
 */
export function installTavernContextProjections(registry) {
  // A host without the registry (or its internals) has no such projections to fix.
  if (!registry || !(registry.registrations instanceof Map) || typeof registry.register !== 'function') return () => {}
  let entry = installations.get(registry)
  if (!entry) {
    const targets = Object.keys(SUPPORTED_PROJECTION_VERSIONS)
    const originalRegister = registry.register
    const hadOwnRegister = Object.hasOwn(registry, 'register')
    const swapped = new Map()
    // Check everything first, so a refusal leaves the registry untouched.
    const wrappers = new Map()
    for (const key of targets) {
      const registration = registry.registrations.get(key)
      if (registration) wrappers.set(key, wrapContextProjection(registration.def))
    }
    selfTestContextProjections([...wrappers.values()])
    for (const [key, wrapper] of wrappers) {
      const registration = registry.registrations.get(key)
      swapped.set(registration, registration.def)
      registration.def = wrapper
      // Cells folded under the stock shape refold lazily from the log.
      registration.cells = new WeakMap()
    }
    registry.register = function (definition) {
      return originalRegister.call(this, targets.includes(definition?.key) ? wrapContextProjection(definition) : definition)
    }
    entry = { swapped, originalRegister, hadOwnRegister, users: 0 }
    installations.set(registry, entry)
  }
  entry.users++
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (--entry.users !== 0) return
    if (entry.hadOwnRegister) registry.register = entry.originalRegister
    else delete registry.register
    for (const [registration, definition] of entry.swapped) {
      if (registration.def[WRAPPED]) {
        registration.def = definition
        registration.cells = new WeakMap()
      }
    }
    installations.delete(registry)
  }
}
