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
