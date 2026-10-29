// V4 only accepts an assistant event inside an open turn and step, so a body that is
// rewritten after its round closed (edit, projection) lands in an edit step with a new
// turn number. The rewrite records the story turn it replaced in the message source;
// every reader that matches a body to its round goes through here.
export function storyEventTurn(event) {
  const original = event?.type === 'assistant/message' ? event.data?.message?.source?.tavernStoryTurn : undefined
  return Number.isSafeInteger(original) && original > 0 ? original : Number(event?.data?.turn)
}

/** The story turn of a body that may be a chain of in-place rewrites. An edit
 * written before `tavernStoryTurn` existed only knows its own edit step's turn;
 * the reply that opened the story turn is the first ancestor of the chain.
 * `lookup(seq)` resolves an earlier event of the same log. */
export function originStoryTurn(event, lookup) {
  let current = event
  const seen = new Set()
  while (current?.type === 'assistant/message' && current.surfaceOp?.op === 'replace' && current.data?.message?.source?.tavernStoryTurn === undefined && !seen.has(current.seq)) {
    seen.add(current.seq)
    const refs = Array.isArray(current.sourceEventSeqs) ? current.sourceEventSeqs.flat(Infinity) : []
    const ancestor = refs.map(seq => lookup(seq)).find(candidate => candidate?.type === 'assistant/message')
    if (!ancestor) break
    current = ancestor
  }
  return storyEventTurn(current)
}

/** The data of a replacement written in a different turn than the reply it replaces. */
export function withStoryTurn(data, replaced, lookup) {
  const turn = typeof lookup === 'function' ? originStoryTurn(replaced, lookup) : storyEventTurn(replaced)
  if (!Number.isSafeInteger(turn) || turn < 1 || data?.message?.source === undefined) return data
  return { ...data, message: { ...data.message, source: { ...data.message.source, tavernStoryTurn: turn } } }
}
