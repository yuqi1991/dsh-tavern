import { isCompactionCheckpoint } from './compaction-checkpoint.js'
import { liveFloors } from './floor-projection.js'

// Foreground story compaction keeps the latest rounds as REAL surface nodes: the
// compaction range simply ends before the first retained round, so select-based
// operations (rollback, reroll, variant switch) keep working on those rounds.
// (docs/design/compaction-retention.md.) This module only decides where the
// range ends; the host (or idle-compaction.js) performs the replacement.

/** Retained rounds may use at most this share of the model's context window. */
export const RETAINED_ROUNDS_WINDOW_SHARE = 0.25
export const DEFAULT_RETAINED_ROUNDS = 10

/**
 * @param input.events - the complete Session log.
 * @param input.nodes - the current surface, oldest first.
 * @param input.rounds - requested number of rounds to keep verbatim (0 disables).
 * @param input.tokenOf - (seq) => token price of a surface node on the current route.
 * @param input.budget - most tokens the retained rounds may occupy.
 * @param input.balancedBefore - (seq) => whether the cut before `seq` splits no tool step.
 * @param input.force - capacity recovery: always leave at least one round to summarize.
 * @returns
 *   `{ kind: 'range', start, end, keepFromSeq, kept, folded, from, through }` - compact `[start, end]`;
 *   `{ kind: 'retained', kept }` - the retained rounds cover the whole history, nothing to summarize;
 *   `{ kind: 'none', reason }` - retention does not apply; use the host's own range.
 */
export function planRetention({ events, nodes, rounds, tokenOf = () => 0, budget = Infinity, balancedBefore = () => true, force = false }) {
  if (!(rounds > 0)) return { kind: 'none', reason: 'disabled' }
  const surface = Array.isArray(nodes) ? nodes.map(Number) : []
  if (!surface.length) return { kind: 'none', reason: 'empty-surface' }
  const bySeq = new Map((Array.isArray(events) ? events : []).map(event => [event.seq, event]))
  const floors = [...liveFloors([...bySeq.values()], surface).values()]
  if (!floors.length) return { kind: 'none', reason: 'no-floors' }
  // The host never rewrites node 0 when it holds the system prompt.
  const firstIdx = bySeq.get(surface[0])?.type === 'system/message' ? 1 : 0
  const prices = surface.map(seq => Math.max(0, Number(tokenOf(seq)) || 0))
  const suffix = new Array(surface.length + 1).fill(0)
  for (let index = surface.length - 1; index >= 0; index -= 1) suffix[index] = suffix[index + 1] + prices[index]

  // Every round fits the quota and the budget: an idle compaction has nothing to summarize.
  const firstFloor = surface.indexOf(floors[0].inputSeq)
  if (!force && floors.length <= rounds && suffix[Math.max(0, firstFloor)] <= budget) return { kind: 'retained', kept: floors.length }

  // At least one round is always left to summarize, so a capacity recovery makes progress.
  for (let kept = Math.min(rounds, floors.length - 1); kept >= 1; kept -= 1) {
    const keepFromSeq = floors[floors.length - kept].inputSeq
    const keepIdx = surface.indexOf(keepFromSeq)
    if (keepIdx <= firstIdx) continue
    if (suffix[keepIdx] > budget) continue
    if (!balancedBefore(keepFromSeq)) continue
    // Something older than the retained rounds must exist beyond a previous summary.
    const folded = surface.slice(firstIdx, keepIdx).filter(seq => !isCompactionCheckpoint(bySeq.get(seq)))
    if (!folded.length) continue
    return { kind: 'range', start: surface[firstIdx], end: surface[keepIdx - 1], keepFromSeq, kept, folded: folded.length,
      ...foldedRounds(events, surface, surface[firstIdx], surface[keepIdx - 1]) }
  }
  return { kind: 'none', reason: 'no-fit' }
}

/**
 * The last story turn a compaction ending at `endSeq` folds completely, or null.
 * A round the cut falls inside of (its input folded, its reply kept) does not count.
 */
export function foldedThrough(events, nodes, endSeq) {
  const surface = Array.isArray(nodes) ? nodes.map(Number) : []
  const endIdx = surface.indexOf(Number(endSeq))
  if (endIdx < 0) return null
  const floors = [...liveFloors(Array.isArray(events) ? events : [], surface).values()]
  let through = null
  floors.forEach((floor, index) => {
    const nextIdx = index + 1 < floors.length ? surface.indexOf(floors[index + 1].inputSeq) : surface.length
    if (nextIdx <= endIdx + 1 && Number.isSafeInteger(floor.turn) && floor.turn > 0) through = floor.turn
  })
  return through
}

/**
 * Story turns a compaction of `[startSeq, endSeq]` folds: `from` is the first live floor
 * whose input lies in the range, `through` the last one folded completely (null when none).
 */
export function foldedRounds(events, nodes, startSeq, endSeq) {
  const surface = Array.isArray(nodes) ? nodes.map(Number) : []
  const startIdx = surface.indexOf(Number(startSeq)), endIdx = surface.indexOf(Number(endSeq))
  const floors = [...liveFloors(Array.isArray(events) ? events : [], surface).values()]
  const first = floors.find(floor => {
    const index = surface.indexOf(floor.inputSeq)
    return index >= startIdx && index <= endIdx && Number.isSafeInteger(floor.turn) && floor.turn > 0
  })
  return { from: startIdx < 0 || endIdx < 0 ? null : first?.turn ?? null, through: foldedThrough(events, surface, endSeq) }
}

/** Tool-pairing balance of every cut over a surface: `balanced[i]` is the state before node i. */
export function surfaceCutBalance(events, nodes) {
  const bySeq = new Map((Array.isArray(events) ? events : []).map(event => [event.seq, event]))
  const before = new Map()
  let open = 0
  for (const seq of nodes) {
    before.set(Number(seq), open === 0)
    const event = bySeq.get(Number(seq))
    if (event?.type === 'assistant/message') open += (event.data?.message?.content || []).filter(block => block?.type === 'tool-call').length
    else if (event?.type === 'tool/result') open -= 1
  }
  return { balancedBefore: seq => before.get(Number(seq)) === true, balancedAfter: seq => {
    const index = nodes.map(Number).indexOf(Number(seq))
    return index >= 0 && (index + 1 < nodes.length ? before.get(Number(nodes[index + 1])) === true : open === 0)
  } }
}
