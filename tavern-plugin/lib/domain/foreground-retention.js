import { compactIdleRegion } from './idle-compaction.js'
import { foldedRounds, planRetention, RETAINED_ROUNDS_WINDOW_SHARE, surfaceCutBalance } from './compaction-retention.js'
import { sessionEvents } from './session-events.js'

/**
 * What the next summary request needs to know about the compaction in flight: the
 * story turns it folds (`from`, `through`, for the volume header), how many rounds
 * stay verbatim (`kept`) and the configured quota (`retainRounds`). One entry per session.
 */
export function createCompactionPlans() {
  const plans = new Map()
  return Object.freeze({
    /** Hold `plan` for `sessionId` until the returned release runs. */
    hold(sessionId, plan) {
      const entry = Object.freeze({ ...plan })
      plans.set(sessionId, entry)
      return () => { if (plans.get(sessionId) === entry) plans.delete(sessionId) }
    },
    current(sessionId) { return plans.get(sessionId) ?? null }
  })
}

function nativeIdleRange(events, nodes) {
  // The host's idle range: everything but the last node, extended back to a balanced cut.
  const balance = surfaceCutBalance(events, nodes)
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const firstIdx = bySeq.get(nodes[0])?.type === 'system/message' ? 1 : 0
  let keep = nodes.length - 1
  while (keep > firstIdx && !balance.balancedBefore(nodes[keep])) keep -= 1
  return keep > firstIdx ? { start: nodes[firstIdx], end: nodes[keep - 1] } : null
}

function manualError(code, message, cause) {
  const error = new Error(message, { cause })
  error.name = 'ManualCompactionError'; error.code = code
  return error
}

/**
 * Foreground story compaction that keeps the latest rounds as real nodes
 * (docs/design/compaction-retention.md §4). Installed on the compaction engine by
 * `installCompactionPolicy`; background and non-story sessions keep the host behavior.
 * @param input.retainRounds - () => configured rounds to keep (0 disables).
 * @param input.isForeground - (sessionId) => whether it is a Tavern story/script foreground.
 * @param input.meter - () => the host token meter.
 * @param input.contextWindow - (agent, signal) => the routed model's context window, or null.
 * @param input.flush - (session) => durability checkpoint after an idle transaction.
 * @param input.plans - `createCompactionPlans()` shared with the summary request hook.
 */
export function createForegroundRetention({ retainRounds, isForeground, meter, contextWindow, flush, plans }) {
  async function plan(agent, signal, { force, rounds, events, nodes }) {
    const window = await contextWindow(agent, signal)
    // Without a known window the share cannot be enforced: keep the host's own tail.
    if (!Number.isFinite(window) || window <= 0) return null
    const prices = new Map(meter().measure(agent.session).nodes.map(node => [node.seq, node.tokens]))
    const balance = surfaceCutBalance(events, nodes)
    return planRetention({ events, nodes, rounds, tokenOf: seq => prices.get(seq), budget: Math.floor(window * RETAINED_ROUNDS_WINDOW_SHARE),
      balancedBefore: balance.balancedBefore, force })
  }

  /**
   * Inside an open turn the host picked `[start, end]`; move `end` before the retained
   * rounds. Provider-confirmed overflow and a later attempt of the same pressure check
   * keep the host range, so capacity recovery always makes progress.
   * @returns `{ end?, done }` - the replacement end (when moved) and the plan release.
   */
  async function region({ start, end, agent, signal, trigger, attempt = 0 }) {
    const session = agent.session
    if (!(await isForeground(session.id))) return { done: () => {} }
    const rounds = await retainRounds()
    const events = sessionEvents(session), nodes = [...session.surface.nodes]
    if (rounds > 0 && trigger !== 'context-overflow' && !(attempt > 0)) {
      const found = await plan(agent, signal, { force: true, rounds, events, nodes })
      if (found?.kind === 'range' && found.start === start) {
        const planned = nodes.indexOf(found.end), native = nodes.indexOf(end)
        // The host's own recent tail may already keep more than the quota.
        if (planned >= nodes.indexOf(start) && planned < native) {
          return { end: found.end, done: plans.hold(session.id, { from: found.from, through: found.through, kept: found.kept, retainRounds: rounds }) }
        }
      }
    }
    return { done: plans.hold(session.id, { ...foldedRounds(events, nodes, start, end), kept: 0, retainRounds: rounds }) }
  }

  /** Idle compaction (manual button, scheduled policy, the host's /compact). */
  async function idle({ agent, signal, sourceCommandId, native, engine }) {
    const session = agent.session
    if (!(await isForeground(session.id))) return native()
    const rounds = await retainRounds()
    const events = sessionEvents(session), nodes = [...session.surface.nodes]
    const found = rounds > 0 ? await plan(agent, signal, { force: false, rounds, events, nodes }) : null
    if (found?.kind === 'retained') {
      // The host's /compact reports `null` as "nothing to compact"; Tavern shows the reason.
      if (sourceCommandId !== undefined) return null
      return { message: `最近 ${found.kept} 轮剧情保留原文，暂无更早的历史需要压缩（可在设置里调低保留轮数）`, shadowedSeqs: [], shadowedTokenCount: 0, retained: found.kept }
    }
    if (found?.kind !== 'range') {
      const range = nativeIdleRange(events, nodes)
      const release = plans.hold(session.id, { ...(range ? foldedRounds(events, nodes, range.start, range.end) : { from: null, through: null }), kept: 0, retainRounds: rounds })
      try { return await native() } finally { release() }
    }
    signal?.throwIfAborted()
    let running
    try {
      running = agent.runMaintenance(async agentSignal => {
        const operationSignal = AbortSignal.any([agentSignal, ...(signal ? [signal] : [])])
        const release = plans.hold(session.id, { from: found.from, through: found.through, kept: found.kept, retainRounds: rounds })
        try {
          operationSignal.throwIfAborted()
          return await compactIdleRegion({
            dependencies: engine.regionDependencies(), agent, start: found.start, end: found.end, signal: operationSignal, sourceCommandId,
            flush: () => flush(session)
          })
        } catch (error) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) throw manualError('cancelled', 'manual compaction was cancelled', error)
          operationSignal.throwIfAborted()
          throw error
        } finally { release() }
      })
    } catch (error) {
      throw manualError('busy', 'manual compaction requires an idle agent with no waking queued work', error)
    }
    const result = await running
    const span = found.through === null ? '' : found.from !== null && found.from <= found.through ? `第 ${found.from}–${found.through} 轮` : `第 ${found.through} 轮及之前`
    return { ...result, retained: found.kept,
      message: `已压缩${span ? span + '的' : '更早的'}剧情，保留最近 ${found.kept} 轮原文（${result.shadowedSeqs.length} 条记录，约 ${result.shadowedTokenCount} tokens）` }
  }

  return Object.freeze({ region, idle })
}
