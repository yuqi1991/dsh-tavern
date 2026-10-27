import { boundedCompaction } from './bounded-compaction.js'
import { markRequestHandled, requestHandledBy } from './request-lineage.js'

// Internal metadata-only events are persisted on the Session surface but are
// not user utterances. Native compaction replays that surface independently of
// the normal request projection, so omit them at this request boundary too.
export function projectCompactionRequest(request) {
  if (request?.purpose !== 'compaction' || !Array.isArray(request.messages)) return request
  const messages = request.messages.filter(message => !(message?.role === 'user' &&
    Array.isArray(message.content) && message.content.length === 0 &&
    message.source?.kind === 'plugin' &&
    ['dsh-tavern', 'dsh-tavern-failed-turn-cleanup'].includes(message.source.plugin)))
  return messages.length === request.messages.length ? request : { ...request, messages }
}

export function installCompactionRequestProjection(ctx, ownsSession) {
  // Segment requests re-enter llm/stream; copies other hooks make of them stay internal.
  const stream = request => ctx.llm.stream(markRequestHandled(request, 'compaction-projection'))
  ctx.on('llm/stream', (request, next) => {
    if (requestHandledBy(request, 'compaction-projection') || request?.purpose !== 'compaction' || !request.sessionId) return next()
    return (async function * () {
      if (!(await ownsSession(request.sessionId))) { yield* next(); return }
      const projected = projectCompactionRequest(request)
      yield* withTextFallback(ctx, projected, stream)
    })()
  })
}

// Agents trained to answer through tools (the background Agent above all) can
// reply to the summary request with a tool call or nothing visible, and DSH then
// fails with "no text summary content". Retry once with the history quoted as
// plain data and no tools offered; the cache-friendly first attempt stays first.
async function* withTextFallback(ctx, request, stream) {
  const chunks = []
  for await (const chunk of boundedCompaction(ctx, request, stream)) chunks.push(chunk)
  const finish = chunks.find(chunk => chunk?.type === 'finish')?.reason?.kind
  const text = chunks.some(chunk => chunk?.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text.trim())
  if (text || !['stop', 'tool'].includes(finish)) { yield* chunks; return }
  ctx.logger?.info?.('Tavern compaction: summary had no text (' + finish + '), retrying as plain text without tools')
  yield* boundedCompaction(ctx, request, stream, { quoted: true })
}
