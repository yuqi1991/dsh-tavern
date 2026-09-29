import { contentOf, messageOf, tagOfEvent } from './guards.js'

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

function transactionOf(event) {
  const transaction = messageOf(event)?.source?.conversationTransaction
  return transaction && typeof transaction.operationId === 'string' ? transaction : null
}

function committedEvents(events) {
  const committed = new Set()
  for (const event of events) {
    const transaction = transactionOf(event)
    if (transaction && ['commit', 'begin-commit'].includes(transaction.phase)) committed.add(transaction.operationId)
  }
  return events.filter(event => {
    const transaction = transactionOf(event)
    return transaction === null || committed.has(transaction.operationId)
  })
}

function replacementOf(event) {
  const op = event?.surfaceOp
  if (!op || op === 'append') return null
  if (op.op !== 'replace') return null
  const start = op.startSeq ?? op.start
  const end = op.endSeq ?? op.end
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) ? { start, end } : null
}

function visibleContent(event) {
  const blocks = contentOf(event)
  if (blocks.length === 0) return false
  return blocks.some(block => {
    if (!block || typeof block !== 'object') return false
    if (block.type === 'text' || block.type === 'reasoning') return String(block.text || '').trim() !== ''
    if (block.type === 'tool-result') return Array.isArray(block.content) && block.content.length > 0
    return true
  })
}

function stepRole(event) {
  if (event.type === 'tool/result') return 'tool'
  return messageOf(event)?.role || 'unknown'
}

function groupSteps(rows) {
  const steps = []
  for (const event of rows) {
    const role = stepRole(event)
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : null
    const step = Number.isSafeInteger(event.data?.step) ? event.data.step : null
    const previous = steps.at(-1)
    if (role === 'tool' && previous?.role === 'assistant' && previous.turn === turn && previous.step === step) {
      previous.rows.push(event)
      previous.seqs.push(event.seq)
      continue
    }
    const grouped = { ref: `seq:${event.seq}`, anchorSeq: event.seq, role, turn, step, rows: [event], seqs: [event.seq], tag: null }
    grouped.tag = tagOfEvent(event, grouped.rows)
    steps.push(grouped)
  }
  for (const item of steps) {
    const shared = item.rows.map(row => tagOfEvent(row, item.rows)).filter(Boolean)
    item.tag = shared.length && shared.every(tag => tag === shared[0]) ? shared[0] : item.tag
  }
  return steps
}

export function computeFold(events, { fromCache } = {}) {
  const source = Array.isArray(events) ? events : []
  const accepted = committedEvents(source)
  const bySeq = new Map(source.map(event => [event.seq, event]))
  const nodes = []
  const replacements = []
  for (const event of accepted) {
    if (!SURFACE_TYPES.has(event?.type)) continue
    const replacement = replacementOf(event)
    if (replacement === null) {
      nodes.push(event.seq)
      continue
    }
    const startIndex = nodes.indexOf(replacement.start)
    const endIndex = nodes.indexOf(replacement.end)
    if (startIndex < 0 || endIndex < startIndex) throw new Error(`surface replace range missing at seq ${event.seq}`)
    const shadowedSeqs = nodes.slice(startIndex, endIndex + 1)
    nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
    replacements.push({ seq: event.seq, ...replacement, shadowedSeqs })
  }
  const surface = nodes.map(seq => bySeq.get(seq)).filter(Boolean)
  const rows = surface.filter(visibleContent)
  const steps = groupSteps(rows)
  const scaffolding = new Set(steps.filter(step => step.tag !== null).flatMap(step => step.seqs))
  const conversation = rows.filter(event => !scaffolding.has(event.seq) && ['user/message', 'assistant/message'].includes(event.type))
  const headSeq = source.reduce((head, event) => Number.isSafeInteger(event?.seq) ? Math.max(head, event.seq) : head, -1)
  const unchanged = fromCache && fromCache.headSeq === headSeq
  const version = unchanged ? fromCache.version : Math.max(0, Number(fromCache?.version) || 0) + 1
  return {
    events: source, steps, rows, surface, surfaceNodes: nodes, replacements, headSeq, version,
    views: { conversation, trajectory: rows.slice(), request: rows.slice() }
  }
}

export function assertViewConsistency(fold) {
  const request = new Map(fold.views.request.map(event => [event.seq, event]))
  const trajectory = new Map(fold.views.trajectory.map(event => [event.seq, event]))
  for (const event of fold.views.conversation) {
    if (request.get(event.seq) !== event || trajectory.get(event.seq) !== event) throw new Error(`view mismatch at seq ${event.seq}`)
  }
  return true
}
