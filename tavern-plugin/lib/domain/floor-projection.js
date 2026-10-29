import { committedMetadata, computeFold } from './conversation-algebra/index.js'
import { sessionEvents } from './session-events.js'
import { storyEventTurn } from './story-turn.js'

// Floor Projection (ADR-0009): one read-only module that answers, from the
// Session log, the committed branch registry and the Story Timeline floors,
// what every floor shows and which native turns host it. Display, rollback,
// reroll, fork and handoff read it; there are no per-turn hiding tables.

function eventsOf(source) {
  return Array.isArray(source) ? source : sessionEvents(source)
}

/** The branch registry's single authority: metadata committed with the
 * session's last branch transaction (ADR-0009). Chat holds no copy. */
export function branchRegistryOf(source) {
  if (!source) return null
  return committedMetadata(eventsOf(source)) ?? null
}

function branchBody(events, branch) {
  const fold = computeFold(events.filter(event => event.seq <= branch.headSeq))
  const rows = fold.views.conversation
  const body = rows.length ? rows[rows.length - 1] : null
  if (!body || body.type !== 'assistant/message') return null
  const text = (body.data?.message?.content || []).filter(block => block?.type === 'text').map(block => String(block.text || '')).join('')
  return text.trim() === '' ? null : { text, nativeTurn: storyEventTurn(body) || 0 }
}

const variantCache = new WeakMap()

/** Materialize per-floor variant bodies for the helper surface and the variant
 * switcher (P2-B). Variants are branch heads that record the chat-visible turn
 * they replaced; their body text replays the fold up to each branch head.
 * Reads are cached per (session, registry identity, log head) triple. */
export function projectVariantBodies(session, registry = branchRegistryOf(session)) {
  if (!session || !Array.isArray(registry?.branches)) return {}
  const usable = registry.branches
    .filter(branch => branch && Number.isSafeInteger(Number(branch.turn)) && Number(branch.turn) > 0)
    // Sibling variants follow branch creation order. Branch heads are
    // monotonic, so ascending headSeq is the durable creation order.
    .sort((left, right) => Number(left.headSeq) - Number(right.headSeq))
  if (!usable.length) return {}
  const events = sessionEvents(session)
  const headSeq = events.reduce((max, event) => Number.isSafeInteger(event?.seq) ? Math.max(max, event.seq) : max, -1)
  const registryKey = JSON.stringify(usable.map(branch => [branch.branchId, branch.headSeq, branch.turn, branch.active]))
  let entry = variantCache.get(session)
  if (entry && entry.headSeq === headSeq && entry.registryKey === registryKey) return entry.bodies
  const bodies = {}
  for (const branch of usable) {
    const turn = String(branch.turn)
    try {
      const materialized = branchBody(events, branch)
      if (!materialized) continue
      const text = materialized.text
      // Repeated archives of one body fold to the same text; keep one slot.
      const list = bodies[turn] = bodies[turn] || []
      if (!list.includes(text)) list.push(text)
    } catch { /* A branch head that no longer folds (archival edge) is skipped. */ }
  }
  entry = { headSeq, registryKey, bodies }
  variantCache.set(session, entry)
  return bodies
}

/** Distinct saved variants of one floor, in creation order (P2-B).
 * Branches folding to identical text are the same variant; the first branch
 * carrying that text remains its address. The unregistered live line is NOT
 * included — callers add it after saved siblings when it is active. */
export function distinctFloorVariants(session, turn, registry = branchRegistryOf(session)) {
  if (!session || !Number.isSafeInteger(Number(turn)) || turn <= 0) return []
  if (!Array.isArray(registry?.branches)) return []
  const branches = registry.branches
    .filter(branch => branch && Number(branch.turn) === Number(turn))
    // Sibling variants follow branch creation order, matching the swipe order.
    .sort((left, right) => Number(left.headSeq) - Number(right.headSeq))
  if (!branches.length) return []
  const events = eventsOf(session)
  const variants = []
  const seen = new Set()
  for (const branch of branches) {
    try {
      const materialized = branchBody(events, branch)
      if (!materialized || seen.has(materialized.text)) continue
      seen.add(materialized.text)
      variants.push({ text: materialized.text, branchId: branch.branchId, headSeq: Number(branch.headSeq), nativeTurn: materialized.nativeTurn })
    } catch { /* A branch head that no longer folds (archival edge) is skipped. */ }
  }
  return variants
}

function playerInput(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

function modelBody(event) {
  if (event?.type !== 'assistant/message' || event.data?.message?.source?.kind !== 'model') return false
  const content = event.data.message.content
  return Array.isArray(content) && content.some(block => block?.type === 'text' && String(block.text || '').trim() !== '')
}

/** The append-origin model reply a (possibly replaced) body descends from.
 * Legacy rerolls append the new reply in a synthetic turn, then copy it over
 * the floor with a range replacement that carries the floor's own turn. */
function originBody(bySeq, seq) {
  let origin = bySeq.get(seq)
  const seen = new Set()
  while (origin?.surfaceOp?.op === 'replace' && !seen.has(origin.seq)) {
    seen.add(origin.seq)
    const ancestor = (origin.sourceEventSeqs || []).map(ref => bySeq.get(ref)).filter(modelBody).sort((left, right) => right.seq - left.seq)[0]
    if (!ancestor) break
    origin = ancestor
  }
  return origin
}

/** Native turn of every event: assistant rows carry it, others follow turn/start. */
function nativeTurns(events) {
  const turns = new Map()
  let current = 0
  for (const event of events) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) current = event.data.turn
    const own = storyEventTurn(event)
    turns.set(event.seq, event.type === 'assistant/message' && Number.isSafeInteger(own) && own > 0 ? own : current)
  }
  return turns
}

/** Logs without turn markers (imports, fixtures): the turn of the first reply after an input. */
function firstReplyTurn(events, seq) {
  for (const event of events) if (event.seq > seq && event.type === 'assistant/message' && storyEventTurn(event) > 0) return storyEventTurn(event)
  return 0
}

/** The append-origin player input a (possibly edited) input row descends from. */
function originInput(bySeq, seq) {
  let origin = bySeq.get(seq)
  const seen = new Set()
  while (origin?.surfaceOp?.op === 'replace' && !seen.has(origin.seq)) {
    seen.add(origin.seq)
    const ancestor = (origin.sourceEventSeqs || []).map(ref => bySeq.get(ref)).filter(playerInput).sort((left, right) => left.seq - right.seq)[0]
    if (!ancestor) break
    origin = ancestor
  }
  return origin
}

/**
 * Project every floor of a Story Timeline onto its Session.
 * @param input.events - the complete Session log.
 * @param input.nodes - the live surface seqs.
 * @param input.registry - committed branch metadata, or null.
 * @param input.floorTurns - chat-visible turns of the Story Timeline floors, oldest first.
 * @param input.mode - Chat mode; card workspaces have no story floors.
 * @returns per-floor facts.
 */
export function projectFloors({ events = [], nodes = [], registry = null, floorTurns = [], mode = 'story' }) {
  if (mode === 'card') return { floors: [] }
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const turns = nativeTurns(events)
  // Live surface floors: each player input opens one; its body is the last
  // model text before the next player input.
  const live = new Map()
  let floor = null
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (playerInput(event)) {
      const origin = originInput(bySeq, seq)
      floor = { turn: turns.get(origin.seq) || firstReplyTurn(events, origin.seq), inputSeq: seq, bodySeq: null, bodyTurn: null }
      live.set(floor.turn, floor)
    } else if (floor && modelBody(event)) {
      floor.bodySeq = seq
      floor.bodyTurn = turns.get(originBody(bySeq, seq).seq) || 0
    }
  }
  const visible = [...new Set(floorTurns.map(Number).filter(turn => Number.isSafeInteger(turn) && turn > 0))]
  const floors = visible.map(turn => {
    const variants = registry ? distinctFloorVariants(events, turn, registry) : []
    const current = live.get(turn) || null
    const bodyTurns = new Set([turn, ...variants.map(variant => Number(variant.nativeTurn) || 0)])
    if (current?.bodyTurn) bodyTurns.add(current.bodyTurn)
    return {
      turn,
      inputSeq: current?.inputSeq ?? null,
      bodySeq: current?.bodySeq ?? null,
      bodyTurn: current?.bodyTurn ?? null,
      // The host transcript renders append-origin rows only; the floor's body
      // is displayed on the row of its newest generation.
      hostTurn: Math.max(...bodyTurns),
      // Every native turn that produced one of this floor's bodies.
      nativeTurns: [...bodyTurns].filter(value => value > 0).sort((left, right) => left - right),
      variantCount: variants.length
    }
  })
  return { floors }
}

/** Chat-visible story floors: assistant rows by turn; the opening is floor 1. */
export function storyFloorTurns(chat) {
  const turns = []
  for (const message of Array.isArray(chat?.messages) ? chat.messages : []) {
    if (!message || message.role !== 'assistant') continue
    const turn = Math.max(0, Number(message.turn) || (message.greeting === true ? 1 : 0))
    if (turn > 0) turns.push(turn)
  }
  return turns
}

/** The single entry point: project a Chat's floors onto its Session. */
export function projectChatFloors(chat, events = [], nodes = []) {
  return projectFloors({
    events, nodes: [...nodes],
    registry: committedMetadata(events) ?? null,
    floorTurns: storyFloorTurns(chat),
    mode: chat?.mode || 'story'
  })
}

/** The native turn whose row hosts a floor's body. */
export function floorHostTurn(projection, turn) {
  return projection.floors.find(floor => floor.turn === Number(turn))?.hostTurn ?? Number(turn)
}

/** Every native turn a floor's bodies came from; rollback owns all of them. */
export function floorNativeTurns(projection, turn) {
  const floor = projection.floors.find(item => item.turn === Number(turn))
  return new Set(floor ? floor.nativeTurns : Number(turn) > 0 ? [Number(turn)] : [])
}
