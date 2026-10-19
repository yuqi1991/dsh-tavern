// Per-variant Chat state for the latest story floor. The Session log owns each
// variant's body; the Chat message owns what was derived from it (MVU variables
// and receipt, display projection). Leaving a variant files its message under
// the branch that preserves its body, so returning restores it whole.

function messageText(message) {
  return [message?.sourceText, message?.text, message?.sessionText].filter(value => typeof value === 'string')
}

/** File the message's current state under the branch that keeps its body. */
export function saveVariantState(message, branchId) {
  if (!message || typeof message !== 'object' || typeof branchId !== 'string' || branchId === '') return message
  const { variantStates, ...state } = message
  return { ...message, variantStates: { ...(variantStates || {}), [branchId]: structuredClone(state) } }
}

/** The filed state for a branch, or for any branch whose body is the same text. */
export function restoreVariantState(message, branchId, bodyText) {
  const states = message?.variantStates
  if (!states || typeof states !== 'object') return null
  const state = states[branchId] ?? Object.values(states).find(saved => messageText(saved).includes(bodyText))
  if (!state) return null
  return { ...structuredClone(state), turn: message.turn, variantStates: states }
}

/** A variant without filed state shows the floor's pre-settlement variables. */
export function withoutVariantSettlement(message) {
  const next = { ...message }
  if (next.mvuBaseline && typeof next.mvuBaseline === 'object') {
    next.variables = [structuredClone(next.mvuBaseline.variables ?? {})]
    next.swipeId = 0
  }
  delete next.mvu
  return next
}
