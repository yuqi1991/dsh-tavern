// Story floors: the Tavern conversation view reads the story one floor at a
// time from Chat. A floor is the opening, or one player input with the reply
// it produced; native turns, bookkeeping rows and history windows never reach
// the view, so paging counts floors and the opening is always reachable.

const str = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))

export const STORY_FLOOR_PAGE = 20

function floorTurn(message) {
  return Math.max(0, Number(message?.turn) || (message?.greeting === true ? 1 : 0))
}

function inputOf(message) {
  const text = str(message.sourceText ?? message.text)
  const display = message.tavernPluginData?.template_display
  return {
    text,
    ...(display && display.source === text && display.swipe === (message.swipeId || 0) && str(display.html) !== '' ? { templateDisplay: display.html } : {}),
    ...(Array.isArray(message.inputAttachments) && message.inputAttachments.length ? { attachments: structuredClone(message.inputAttachments) } : {})
  }
}

/** The input a regenerated floor keeps showing while its body is rewritten: the
 * player's original input, or the revised text when the player edited it. */
export function regenerationFloorInput(message, editedText) {
  return inputOf(editedText === null || editedText === undefined ? message : { ...message, text: editedText, sourceText: editedText })
}

function bodyOf(message, projection) {
  if (projection) {
    return {
      mode: str(projection.mode) || 'markdown',
      text: str(projection.text),
      ...(Array.isArray(projection.parts) ? { parts: projection.parts } : {}),
      warnings: Array.isArray(projection.warnings) ? projection.warnings : []
    }
  }
  // Without a projection the reply is plain markdown of its session text.
  return { mode: 'markdown', text: str(message.text), warnings: [] }
}

/** Every floor of the chat in story order; a trailing input without a reply
 * is an open floor (generating or failed) with a null body. */
export function storyFloorsOf(chat, { projections = [], receipts = [] } = {}) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : []
  const projectionByTurn = new Map(projections.map(projection => [Number(projection.turn), projection]))
  const receiptByTurn = new Map(receipts.map(receipt => [Number(receipt.turn), receipt]))
  const floors = []
  let pendingInput = null
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'user') { pendingInput = inputOf(message); continue }
    if (message.role !== 'assistant') continue
    const turn = floorTurn(message)
    if (turn === 0) continue
    floors.push({
      turn,
      ...(message.greeting === true ? { greeting: true } : {}),
      input: message.greeting === true ? null : pendingInput,
      body: bodyOf(message, projectionByTurn.get(turn)),
      receipt: receiptByTurn.get(turn) || null
    })
    pendingInput = null
  }
  // The floor being regenerated is rolled out of Chat until its new body is
  // committed; its input stays visible as an open floor in its own position.
  const regenerating = chat?.regenInProgress === true && chat.regenRecovery?.phase !== 'committed' ? chat.regenRecovery?.floor : null
  if (regenerating && Number.isSafeInteger(regenerating.turn) && regenerating.turn > (floors.at(-1)?.turn || 0) && regenerating.input) {
    floors.push({ turn: regenerating.turn, input: structuredClone(regenerating.input), body: null, receipt: null, open: true, regenerating: true })
  } else if (pendingInput) {
    const turn = (floors.at(-1)?.turn || 0) + 1
    floors.push({ turn, input: pendingInput, body: null, receipt: null, open: true })
  }
  return floors
}

/** One page of floors, newest last. `before` is an exclusive floor turn; the
 * first page is the newest `limit` floors. `from` instead refreshes every
 * floor from that turn to the end, so a view keeps what it already loaded. */
export function pageStoryFloors(floors, { before, from, limit = STORY_FLOOR_PAGE } = {}) {
  if (Number.isSafeInteger(Number(from)) && from !== null && from !== undefined) {
    const start = floors.findIndex(floor => floor.turn >= Number(from))
    const begin = start < 0 ? floors.length : start
    return { floors: floors.slice(begin), hasMore: begin > 0, total: floors.length }
  }
  const size = Math.max(1, Math.min(200, Number(limit) || STORY_FLOOR_PAGE))
  const end = Number.isSafeInteger(Number(before)) && before !== null && before !== undefined
    ? floors.findIndex(floor => floor.turn >= Number(before))
    : -1
  const stop = end < 0 ? floors.length : end
  const start = Math.max(0, stop - size)
  return { floors: floors.slice(start, stop), hasMore: start > 0, total: floors.length }
}
