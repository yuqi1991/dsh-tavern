import { computeFold } from './conversation-algebra/index.js'
import { sessionEvents } from './session-events.js'

const variantCache = new WeakMap()

/** Materialize per-floor variant bodies for the helper surface and the variant
 * switcher (P2-B). Variants are branch heads that record the chat-visible turn
 * they replaced; their body text replays the fold up to each branch head.
 * Reads are cached per (session, registry identity, log head) triple. */
export function projectVariantBodies(session, registry) {
  if (!session || !Array.isArray(registry?.branches)) return {}
  const usable = registry.branches.filter(branch => branch && Number.isSafeInteger(Number(branch.turn)) && Number(branch.turn) > 0)
  if (!usable.length) return {}
  const events = sessionEvents(session)
  const headSeq = events.reduce((max, event) => Number.isSafeInteger(event?.seq) ? Math.max(max, event.seq) : max, -1)
  const registryKey = JSON.stringify(usable.map(branch => [branch.branchId, branch.headSeq, branch.turn, branch.active]))
  let entry = variantCache.get(session)
  if (entry && entry.headSeq === headSeq && entry.registryKey === registryKey) return entry.bodies
  const bodies = {}
  for (const branch of usable) {
    const turn = String(branch.turn)
    try {
      const fold = computeFold(events.filter(event => event.seq <= branch.headSeq))
      const rows = fold.views.conversation
      const body = rows.length ? rows[rows.length - 1] : null
      const text = body && body.type === 'assistant/message'
        ? (body.data?.message?.content || []).filter(block => block?.type === 'text').map(block => String(block.text || '')).join('') : ''
      if (text.trim() === '') continue
      // Repeated archives of one body fold to the same text; keep one slot.
      const list = bodies[turn] = bodies[turn] || []
      if (!list.includes(text)) list.push(text)
    } catch { /* A branch head that no longer folds (archival edge) is skipped. */ }
  }
  entry = { headSeq, registryKey, bodies }
  variantCache.set(session, entry)
  return bodies
}

/** Distinct variants of one floor, newest first (P2 switcher enumeration).
 * Branches folding to identical text are the same variant; the newest branch
 * carrying that text is its address. The live line is NOT included — callers
 * add it while it is active. */
export function distinctFloorVariants(session, registry, turn) {
  if (!session || !Number.isSafeInteger(Number(turn)) || turn <= 0) return {}
  if (!Array.isArray(registry?.branches)) return {}
  const branches = registry.branches
    .filter(branch => branch && Number(branch.turn) === Number(turn))
    .sort((left, right) => Number(right.headSeq) - Number(left.headSeq))
  if (!branches.length) return {}
  const events = sessionEvents(session)
  const variants = []
  const seen = new Set()
  for (const branch of branches) {
    let text = ''
    try {
      const rows = computeFold(events.filter(event => event.seq <= branch.headSeq)).views.conversation
      const body = rows.length ? rows[rows.length - 1] : null
      text = body && body.type === 'assistant/message'
        ? (body.data?.message?.content || []).filter(block => block?.type === 'text').map(block => String(block.text || '')).join('') : ''
    } catch { text = '' }
    if (text.trim() === '' || seen.has(text)) continue
    seen.add(text)
    variants.push({ text, branchId: branch.branchId, headSeq: Number(branch.headSeq) })
  }
  return variants
}
