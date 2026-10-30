import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { surfaceCutBalance } from './compaction-retention.js'
import { sessionEvents } from './session-events.js'

// Idle (manual or scheduled) compaction over an EXPLICIT range.
//
// DSH's `compactNow` picks its own range (everything but the last surface node)
// and runs the module-private `compactSurfaceRegion`; `compactRegion` is public
// but needs an open turn. To keep the latest rounds as real nodes while the
// session is idle, this module runs the same durable transaction for a range
// Tavern chose, using only the engine's public customization points
// (`regionDependencies()`: token meter, `summarize`, summary-error recovery).
// Event shapes mirror the host's (tests compare them with a real `compactNow`).

const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/** Same framing the host's engine puts around a summary. */
export function frameSummary(summary) {
  return [{ type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` }, ...summary, { type: 'text', text: SUMMARY_CLOSE_TAG }]
}

function failure(code, message, options) {
  const error = new Error(message, options)
  error.name = 'ManualCompactionError'
  error.code = code
  return error
}

function errorChain(value) {
  const parts = []
  for (let current = value, depth = 0; current && depth < 12; depth += 1, current = current.cause) {
    const message = String(current?.message ?? current)
    if (message && parts.at(-1) !== message) parts.push(message)
  }
  return parts.join(': ')
}

function inspectEntryState(session) {
  let openTurn = null, openTurnKnown = false, unmatchedStart, compactionKnown = false, latestEndSeed
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (latestEndSeed === undefined && event.type === 'session/end-seed') latestEndSeed = event.seq
    if (!compactionKnown) {
      if (event.type === 'compaction/start') { unmatchedStart = event; compactionKnown = true }
      else if (event.type === 'compaction/end') compactionKnown = true
    }
    if (!openTurnKnown) {
      if (event.type === 'turn/start') { openTurn = event.data.turn; openTurnKnown = true }
      else if (event.type === 'turn/end') openTurnKnown = true
    }
    if (openTurnKnown && compactionKnown && latestEndSeed !== undefined) break
  }
  return { openTurn, unmatchedStart, latestEndSeed }
}

function assertInactive(entry) {
  if (entry.unmatchedStart === undefined || (entry.latestEndSeed !== undefined && entry.latestEndSeed > entry.unmatchedStart.seq)) return
  throw failure('busy', 'compaction: compaction already in progress; the session compaction lock is already active')
}

function validateRegion(session, start, end) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start), endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) throw new Error(`compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`)
  const balance = surfaceCutBalance(sessionEvents(session), nodes)
  if (!balance.balancedBefore(nodes[startIdx])) throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  if (!balance.balancedAfter(nodes[endIdx])) throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

function prepare(dependencies, session, selection) {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new Error('compaction: selected surface changed before summarization began')
  }
  const header = session.requestHeader()
  const head = session.eventAt(session.surface.nodes[0])
  const system = head.type === 'system/message' ? session.deriveEventMessage(head) : null
  const region = selection.shadowedSeqs.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(message => message !== null)
  return {
    ...selection, measurement, selectedNodes,
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    input: { ...(header?.tools === undefined ? {} : { tools: header.tools }), messages: system === null ? region : [system, ...region] }
  }
}

function assertSelectedSpanStable(dependencies, session, prepared) {
  let current
  try { current = validateRegion(session, prepared.start, prepared.end) }
  catch (error) { throw new Error('compaction: the selected span is no longer a valid replacement target', { cause: error }) }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) throw new Error('compaction: the selected span changed during summarization')
  if (!isDeepStrictEqual(dependencies.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1), prepared.selectedNodes)) {
    throw new Error('compaction: the selected span was rewritten during summarization')
  }
}

/**
 * Compact `[start, end]` of an idle session's surface as one durable transaction.
 * @param input.dependencies - `engine.regionDependencies()`: `{ meter, summarize, recover }`.
 * @param input.flush - durability checkpoint awaited once the transaction closed.
 * @returns the host-shaped result (`shadowedSeqs`, `shadowedRange`, `shadowedTokenCount`, ...).
 */
export async function compactIdleRegion({ dependencies, agent, start, end, signal, sourceCommandId, flush }) {
  const session = agent.session
  signal?.throwIfAborted()
  const selection = validateRegion(session, start, end)
  const entry = inspectEntryState(session)
  assertInactive(entry)
  if (entry.openTurn !== null) throw failure('busy', 'manual compaction: the session already has an open turn')
  const compactionId = randomUUID()
  const lifecycle = { compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }), turn: null }
  const startEvent = session.append('compaction/start', lifecycle)
  let problem, flushProblem, result, closed = false, closing = false, stage = 'summary'
  try {
    let prepared = prepare(dependencies, session, selection)
    let summaryResult
    for (;;) {
      signal?.throwIfAborted()
      try { summaryResult = await dependencies.summarize(prepared.input, agent, signal); break }
      catch (error) {
        if (signal?.aborted === true) throw error
        assertSelectedSpanStable(dependencies, session, prepared)
        if (!dependencies.recover(error, agent, prepared.shadowedSeqs, signal)) throw error
        prepared = prepare(dependencies, session, validateRegion(session, prepared.start, prepared.end))
      }
    }
    // Same shape as the host's createUserMessage({ content, source }).
    const checkpoint = Object.freeze({
      content: frameSummary(summaryResult.summary),
      source: Object.freeze({ kind: 'compact-checkpoint', compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) }),
      role: 'user', id: randomUUID()
    })
    const framed = dependencies.meter.estimateMessage(checkpoint)
    if (framed >= prepared.shadowedRouteTokenCount) {
      throw new Error(`summary is not smaller than the shadowed content (${framed} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`)
    }
    signal?.throwIfAborted()
    assertSelectedSpanStable(dependencies, session, prepared)
    stage = 'commit'
    const summaryEvent = session.append('compaction/summary', {
      compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }), summary: summaryResult.summary,
      ...(summaryResult.llmStreamCall === true ? { rawOutput: summaryResult.rawOutput, llmStreamCall: true } : summaryResult.rawOutput === undefined ? {} : { rawOutput: summaryResult.rawOutput }),
      shadowedRange: { start: prepared.start, end: prepared.end }, shadowedSeqs: [...prepared.shadowedSeqs], shadowedTokenCount: prepared.shadowedTokenCount,
      provider: summaryResult.provider, model: summaryResult.model,
      ...(summaryResult.maxTokens === undefined ? {} : { maxTokens: summaryResult.maxTokens }),
      ...(summaryResult.usage === undefined ? {} : { usage: summaryResult.usage })
    })
    session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: prepared.start, endSeq: prepared.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...prepared.shadowedSeqs]
    })
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = {
      compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }), startSeq: startEvent.seq, summarySeq: summaryEvent.seq,
      summary: summaryResult.summary, shadowedRange: { start: prepared.start, end: prepared.end }, shadowedSeqs: [...prepared.shadowedSeqs],
      shadowedTokenCount: prepared.shadowedTokenCount, endSeq: endEvent.seq
    }
  } catch (error) {
    problem = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      closing = true
      try { session.append('compaction/end', { ...lifecycle, error: errorChain(error) }); closed = true }
      catch (closeError) { problem = { error: closeError, stage: 'commit' } }
    }
  }
  if (closed && flush) {
    try { await flush() } catch (error) { flushProblem = error }
  }
  signal?.throwIfAborted()
  if (problem) {
    if (problem.stage === 'commit') throw failure('commit', 'manual compaction did not commit cleanly', { cause: problem.error })
    if (/selected span|no longer a valid replacement|changed before summarization/.test(String(problem.error?.message))) {
      throw failure('changed', 'the compacted history changed during manual compaction', { cause: problem.error })
    }
    throw failure('summary', 'manual compaction could not produce a smaller summary', { cause: problem.error })
  }
  if (flushProblem) throw failure('persistence', 'manual compaction durability checkpoint failed', { cause: flushProblem })
  return result
}
