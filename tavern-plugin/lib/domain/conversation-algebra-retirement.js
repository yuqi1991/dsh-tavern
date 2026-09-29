import { computeFold, dropTagged, runTransaction, recoverTransaction, assertTransactionReady } from './conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter } from './conversation-algebra-host-adapter.js'

/** Select policy targets; shape/pair/source validation stays in the algebra. */
export function planForegroundRetirement(events, keepTurn) {
  if (!Number.isSafeInteger(keepTurn)) return { state: computeFold(events), ops: [] }
  const state = computeFold(events)
  const snapshots = state.steps.filter(step => step.tag === 'worldbook-snapshot')
  const latest = snapshots.at(-1)
  const reminderSeen = events.some(event => event.type === 'user/message' &&
    event.data?.source?.kind === 'plugin' && event.data.source.plugin === 'dsh-tavern' &&
    event.data.source.form === 'writing-skill-reminder' && event.data.content?.length)
  const targets = state.steps.filter(step => {
    if (!step.tag) return false
    const source = step.rows[0].data?.source
    const turn = step.turn ?? source?.trace?.turn
    if (Number.isSafeInteger(turn) && turn >= keepTurn) return false
    if (step.tag === 'skill') return Number.isSafeInteger(turn) && turn < keepTurn
    if (source?.kind === 'skill-catalog' || step.tag === 'writing-skill-state') return reminderSeen
    if (step.tag === 'worldbook-snapshot') {
      return step !== latest || source?.worldbookSnapshot?.text === ''
    }
    return true
  })
  const selected = { ...state, steps: targets }
  const ops = [...new Set(targets.map(step => step.tag))].flatMap(tag => dropTagged(selected, tag))
  return {state, ops}
}

/** Stage 1 opt-in entry; not wired to the running installation yet. */
export async function retireForegroundWithAlgebra(session, {keepTurn, flush, operationId}) {
  const adapter = createConversationAlgebraHostAdapter(session, {flush})
  await recoverTransaction(adapter)
  assertTransactionReady(adapter)
  const {state, ops} = planForegroundRetirement(adapter.snapshotEvents(), keepTurn)
  if (!ops.length) return 0
  await runTransaction(adapter,{expectedHead:state.headSeq,ops,operationId})
  return ops.length
}
