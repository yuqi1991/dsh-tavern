import { computeFold } from './conversation-algebra/index.js'

/** Expand an opening window to include current prose and its replacement
 * provenance. Host pagination counts empty append placeholders toward its
 * budget; those placeholders must not crowd every human message off the page.
 * Keep a contiguous event suffix and the original stream cursor/baselines.
 */
function openingStart(events, initialStart, budget) {
  if (!events.some(event => (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction)) return initialStart
  const fold = computeFold(events)
  const selected = fold.views.conversation.slice(-budget)
  if (!selected.length) return initialStart
  let cut = Math.min(initialStart, ...selected.map(event => event.seq))
  // Replacements are positioned at their ancestors. Include every referenced
  // endpoint, including archival origins used by the append-only chat renderer.
  for (;;) {
    let next = cut
    for (const event of events) {
      if (event.seq < cut) continue
      for (const seq of (event.sourceEventSeqs || []).flat(Infinity)) {
        if (Number.isSafeInteger(seq) && seq >= 0) next = Math.min(next, seq)
      }
      if (event.type === 'assistant/message') {
        const start = events.find(item => item.type === 'step/start' && item.data.turn === event.data.turn && item.data.step === event.data.step)
        if (start) next = Math.min(next, start.seq)
      }
    }
    if (next === cut) return cut
    cut = next
  }
}

/** Install a reversible gate at the host's history transport, not at its event
 * emitter: persistence must still receive every append while readers wait.
 * `ready(address, signal)` must also inspect cold stored sessions before serving.
 * This adapter intentionally refuses unknown host shapes.
 */
export function installConversationHistoryGate(history, ready) {
  if (!history || typeof history.page !== 'function' || typeof history.follow !== 'function' || typeof history.sourceFor !== 'function') {
    throw new TypeError('宿主 history 接口不匹配，不能启用 conversationAlgebra')
  }
  const originals = { page: history.page, follow: history.follow, sourceFor: history.sourceFor }
  const page = async function (request, signal) {
    await ready(request.address, signal)
    const value = await originals.page.call(this, request, signal)
    // An append may race the asynchronous page read. Its result is not released
    // until that transaction is durable, even if the page is a historic prefix.
    await ready(request.address, signal)
    return value
  }
  const sourceFor = async function (address, signal, withProjections) {
    for (;;) {
      await ready(address, signal)
      const source = await originals.sourceFor.call(this, address, signal, withProjections)
      try {
        await ready(address, signal)
        signal?.throwIfAborted()
        const tags = source.events.map(event => (event.type === 'user/message' ? event.data : event.data?.message)?.source?.conversationTransaction).filter(Boolean)
        const committed = new Set(tags.filter(tag => ['commit', 'begin-commit'].includes(tag.phase)).map(tag => tag.operationId))
        if (!tags.some(tag => tag.phase === 'begin' && !committed.has(tag.operationId))) return source
      } catch (error) { source[Symbol.dispose]?.(); throw error }
      // The observation raced an append. Discard its partial snapshot and read
      // again after the transaction barrier; never publish the old observation.
      source[Symbol.dispose]?.()
    }
  }
  const follow = async function* (request, signal) {
    await ready(request.address, signal)
    for await (const item of originals.follow.call(this, request, signal)) {
      await ready(request.address, signal)
      signal?.throwIfAborted()
      if (item.type === 'snapshot' && item.hasMore && item.records.length) {
        const source = await this.sourceFor(request.address, signal, false)
        try {
          // A newer append is delivered later by the existing follower. Never
          // mix its future events into this opening cursor.
          const events = source.events.filter(event => event.seq <= item.cursor)
          const start = openingStart(events, item.records[0].event.seq, request.maxMessages ?? 50)
          if (start < item.records[0].event.seq) {
            yield { ...item, records: events.filter(event => event.seq >= start).map(event => ({ type: 'event', event })), hasMore: start > 0 }
            continue
          }
        } finally { source[Symbol.dispose]?.() }
      }
      yield item
    }
  }
  history.page = page
  history.sourceFor = sourceFor
  history.follow = follow
  return () => {
    // A later plugin's wrapper must not be overwritten on disposal.
    if (history.page === page) history.page = originals.page
    if (history.sourceFor === sourceFor) history.sourceFor = originals.sourceFor
    if (history.follow === follow) history.follow = originals.follow
  }
}
