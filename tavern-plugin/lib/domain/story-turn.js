// V4 only accepts an assistant event inside an open turn and step, so a body that is
// rewritten after its round closed (edit, projection) lands in an edit step with a new
// turn number. The rewrite records the story turn it replaced in the message source;
// every reader that matches a body to its round goes through here.
export function storyEventTurn(event) {
  const original = event?.type === 'assistant/message' ? event.data?.message?.source?.tavernStoryTurn : undefined
  return Number.isSafeInteger(original) && original > 0 ? original : Number(event?.data?.turn)
}

/** The data of a replacement written in a different turn than the reply it replaces. */
export function withStoryTurn(data, replaced) {
  const turn = storyEventTurn(replaced)
  if (!Number.isSafeInteger(turn) || turn < 1 || data?.message?.source === undefined) return data
  return { ...data, message: { ...data.message, source: { ...data.message.source, tavernStoryTurn: turn } } }
}
