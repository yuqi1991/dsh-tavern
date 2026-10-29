import { producerSource, isProducerSource, isPluginSource, sourceProducerName } from './message-source.js'
import { isCompactionCheckpoint } from './compaction-checkpoint.js'
import { inputAttachments } from './player-input-content.js'
import { isRescuedHistoryMessage } from './chat-history-rescue.js'
import { writeSurfaceEvent } from './surface-transaction.js'
import { sessionEvents, surfaceReplacementRange } from './session-events.js'
import { floorHostTurn, floorNativeTurns, latestSurfaceTurn, projectChatFloors } from './floor-projection.js'
import { createSurfaceOwnership, planSurfaceRecovery, refSeqsOf, SurfaceRecoveryError, OWNED } from './surface-recovery.js'
import { randomUUID } from 'node:crypto'
import { committedOperationIds } from './conversation-algebra/index.js'
import { storyEventTurn } from './story-turn.js'

function object(value) {
  return value !== null && typeof value === 'object' ? value : null
}

function eventAt(events, seq) {
  const direct = events[seq]
  if (direct && Number(direct.seq) === Number(seq)) return direct
  return events.find(event => event && Number(event.seq) === Number(seq)) || null
}

function contentText(value) {
  const message = object(value)
  const content = message && message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => object(block) && block.type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

// Inputs that failed-turn replay may resend as the player's own message.
// Native user messages and legacy replay attempts qualify; regeneration inputs
// do not — they carry synthetic guidance text and belong to regenerate recovery.
function isReplayableInputSource(source) {
  const value = object(source)
  if (!value) return false
  if (value.kind === 'user') return true
  return isProducerSource(value, 'dsh-tavern-replay')
}

// The host chat UI turns a user/message into an input row only when its source
// kind is 'user'; every other kind is classified as a context node. A replay
// therefore has to resend the input as the player's own message, otherwise the
// text disappears from the transcript while the suppressed failure keeps it
// hidden. The original request identity is kept so provider prefix reuse and
// failure diagnostics stay continuous.
function replayInputSource(source) {
  const value = object(source) || {}
  const next = { kind: 'user' }
  if (typeof value.rpcId === 'string' && value.rpcId.trim() !== '') next.rpcId = value.rpcId.trim()
  if (typeof value.clientTimeZone === 'string' && value.clientTimeZone.trim() !== '') next.clientTimeZone = value.clientTimeZone
  return next
}

function modelSourceOf(event) {
  const data = object(event && event.data)
  const message = object(data && data.message)
  const source = object(message && message.source)
  return source && source.kind === 'model' ? source : null
}

// 插件注入的行几乎都是伴随轮次的上下文帧（前台帧、世界书快照、card-memory、
// model-selection 换模型提示、repeat-tool-reminder、compact 检查点等），绝不是玩家输入；
// 只有真正参与轮次语义的插件合成行例外。此前按 form 白名单逐一枚举，漏掉了
// model-selection 等来源：蓝天市会话的多轮回退把折叠起点定在换模型提示行 112 上，
// 玩家输入 109 与帧 110/111 被孤儿化留在 surface，轨迹页多出一条输入行。
const ROUND_PARTICIPATING_PLUGINS = new Set([
  'dsh-tavern-regen',
  'dsh-tavern-regeneration-abort',
  'dsh-tavern-failed-turn-cleanup',
  'dsh-tavern-context-window'
])
function isForegroundContext(event) {
  const source = event?.type === 'user/message' && event.data?.source
  // skill-catalog reminders ride along after the player input inside the
  // same turn; they are context frames. Treating any of these as input
  // would let rollback tombstone from the frame down and orphan the real
  // player message in the surface forever.
  if (source?.kind === 'skill-catalog') return true
  if (!source || (!isPluginSource(source) && source.kind !== 'runtime-context')) return false
  // Host-side notices (e.g. model-selection "[model changed]") ride after the
  // input in the same turn; they are context, not the player message.
  if (String(source.form) === 'notice') return true
  return !ROUND_PARTICIPATING_PLUGINS.has(String(sourceProducerName(source)))
}

function isRollbackUserTombstone(event) {
  const source = event && event.type === 'user/message' && event.data && event.data.source
  const producer = sourceProducerName(source)
  return producer !== '' && (
    producer === 'dsh-tavern-failed-turn-cleanup' ||
    producer === 'dsh-tavern-regeneration-abort' ||
    producer === 'dsh-tavern-context-window'
  )
}

// New branch transactions keep empty administrative rows on the native
// surface. They carry no message content and may lie between a saved body and
// a later reroll. Recognize only our exact encoding with a matching commit.
function committedHistoryControls(events) {
  const completed = committedOperationIds(events)
  return new Set(events.filter(event => {
    if (event.type !== 'user/message' || !event.surfaceOp || event.data?.role !== 'user' ||
        !Array.isArray(event.data.content) || event.data.content.length !== 0) return false
    const { source, id } = event.data
    if (!isProducerSource(source, 'dsh-tavern')) return false
    const tag = source.conversationTransaction
    if (!tag || typeof tag.operationId !== 'string' || !['begin', 'continue', 'commit', 'begin-commit'].includes(tag.phase) || !completed.has(tag.operationId)) return false
    return source.form === 'conversation-metadata' && String(id).startsWith('conversation-metadata:') ||
      source.form === 'checkout' && event.surfaceOp?.op === 'replace' && String(id).startsWith('conversation-checkout:')
  }).map(event => event.seq))
}

function isRollbackAssistantTombstone(event, events) {
  if (!event || event.type !== 'assistant/message' || modelSourceOf(event) === null) return false
  const content = event.data && event.data.message && event.data.message.content
  const op = event.surfaceOp
  if (!Array.isArray(content) || content.length !== 0 || !op || op.op !== 'replace') return false
  const sources = refSeqsOf(event)
  return sources.some(function (seq) {
    const sourceEvent = eventAt(events, seq)
    return sourceEvent && sourceEvent.type === 'user/message'
  })
}

function modelTurns(events, seqs) {
  const turns = new Set()
  for (const seq of seqs) {
    const event = eventAt(events, seq)
    const turn = storyEventTurn(event)
    if (event && event.type === 'assistant/message' && modelSourceOf(event) !== null && Number.isSafeInteger(turn) && turn > 0) turns.add(turn)
  }
  return [...turns].sort(function (left, right) { return left - right })
}

export function locateRegenerationSurface(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  const turn = Number(input && input.turn)
  if (!Number.isSafeInteger(turn) || turn < 1) return null
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventAt(events, nodes[index])
    if (!event || event.type !== 'assistant/message' || storyEventTurn(event) !== turn) continue
    const source = modelSourceOf(event)
    if (source === null) continue
    // Current swipes leave a non-empty replacement; legacy swipes can be empty.
    // Plugin cleanup markers and messages from other turns are not the saved story body.
    return Object.freeze({ assistantSeq: Number(nodes[index]), turn, source })
  }
  return null
}

/**
 * The body a Chat floor shows on the surface now, found by POSITION: the floor
 * projection names the live rows from the player input that opened the floor,
 * so a body rewritten in an edit step (own turn number, tavernStoryTurn lost or
 * wrong), a switched variant, or a reroll hosted on another native turn is
 * still found. Turn arithmetic (`locateRegenerationSurface`) is the fallback
 * for logs the projection cannot map.
 */
export function locateFloorBody(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  const floor = input && input.projection && input.projection.floors.find(item => item.turn === Number(input.turn))
  if (!floor || floor.bodySeq === null || !nodes.includes(floor.bodySeq)) return null
  const source = modelSourceOf(eventAt(events, floor.bodySeq))
  if (source === null) return null
  return Object.freeze({ assistantSeq: floor.bodySeq, userSeq: floor.inputSeq, turn: floor.bodyTurn || floor.turn, source })
}

// Failed turns have already left the model surface, but remain visible until
// the user explicitly clears them. Never consume a committed story to do that.
export function pendingFailedSurfaceTurns({ events = [], nodes = [], suppressed = [] }) {
  const hidden = new Set(suppressed.map(Number))
  let ownership, failures
  const turns = new Set()
  for (let index = nodes.length - 1; index >= 0; index--) {
    const event = eventAt(events, nodes[index])
    // A later successful turn may already have been rolled back. Its empty
    // marker and legacy context snapshots do not end the pending failure tail.
    if (isRollbackAssistantTombstone(event, events) || isForegroundContext(event)) continue
    if (!isRollbackUserTombstone(event)) break
    if (!isProducerSource(event.data.source, 'dsh-tavern-failed-turn-cleanup')) continue
    ownership ??= createSurfaceOwnership(events)
    failures ??= turnIntervals(events).filter(interval => interval.failed && !hidden.has(interval.turn))
    const sources = refSeqsOf(event)
    const failed = new Set(modelTurns(events, sources))
    // A provider can fail before emitting any assistant message. Recover the
    // turn from the cleaned nodes' enclosing lifecycle, including old records.
    const origin = ownership.firstOrigin(event.seq)
    const interval = failures.find(item => origin > item.start && origin < item.end)
    if (interval && ownership.classify(candidate => candidate.seq > interval.start && candidate.seq < interval.end)(event.seq) === OWNED) {
      failed.add(interval.turn)
    }
    for (const turn of failed) {
      if (Number.isSafeInteger(turn) && turn > 0 && !hidden.has(turn)) turns.add(turn)
    }
  }
  return [...turns].sort((a, b) => a - b)
}

// A failed tail never reached the stored story, so recovering it is not a
// rollback: drop the interrupted native residue and replay its original input.
// The input survives in the append-only log even after the cleanup tombstone.
export function replayableFailedTurn(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  let lastEnd = null
  for (const event of events) {
    if (!event || event.type !== 'turn/end' || !Number.isSafeInteger(Number(event.seq))) continue
    const turn = Number(event.data && event.data.turn)
    if (!Number.isSafeInteger(turn) || turn < 1) continue
    if (lastEnd === null || Number(event.seq) > Number(lastEnd.seq)) lastEnd = event
  }
  if (lastEnd === null) return null
  const reason = lastEnd.data && lastEnd.data.reason ? lastEnd.data.reason.kind : ''
  if (reason !== 'error' && reason !== 'aborted') return null
  const turn = Number(lastEnd.data.turn)
  const endSeq = Number(lastEnd.seq)
  // A turn that already started after this failure owns the tail now; replaying
  // would insert an older input behind newer story.
  for (const event of events) {
    if (!event || event.type !== 'turn/start' || !Number.isSafeInteger(Number(event.seq))) continue
    if (Number(event.seq) > endSeq) return null
  }
  let startSeq = -1
  for (const event of events) {
    if (!event || event.type !== 'turn/start' || Number(event.data && event.data.turn) !== turn) continue
    startSeq = Math.max(startSeq, Number(event.seq) || 0)
  }
  if (startSeq < 0) return null
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const seq = Number(event.seq)
    if (!Number.isSafeInteger(seq) || seq <= startSeq || seq >= endSeq) continue
    if (!isReplayableInputSource(event.data && event.data.source)) continue
    const userText = contentText(event.data)
    const attachments = inputAttachments(event.data?.content)
    if (userText === '' && !attachments.length) continue
    return Object.freeze({ turn, startSeq, endSeq, userText, ...(attachments.length ? { inputAttachments: attachments } : {}), source: replayInputSource(event.data && event.data.source) })
  }
  return null
}

// The player input that opens the last round on the surface, by position.
function lastRoundInput(events, nodes) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = eventAt(events, nodes[index])
    if (isCompactionCheckpoint(event)) return { compacted: true, index: -1 }
    if (event && event.type === 'user/message' && !isForegroundContext(event) && !isRollbackUserTombstone(event)) return { compacted: false, index }
  }
  return { compacted: false, index: -1 }
}

// Rolling back is a selection of the surface before the round's input, so it
// needs only that input's position. Everything after it is the round by
// definition (the log keeps it as a saved branch); no range of "owned"
// rows has to be proven, and a tail whose rows carry other turn numbers or
// origins is not a reason to refuse.
function rollbackTargetAt(events, nodes, userIndex, assistantIndex) {
  const assistantEvent = assistantIndex >= 0 ? eventAt(events, nodes[assistantIndex]) : null
  const shadowedSeqs = nodes.slice(userIndex).map(Number)
  return Object.freeze({
    userSeq: Number(nodes[userIndex]),
    assistantSeq: assistantIndex >= 0 ? Number(nodes[assistantIndex]) : Number(shadowedSeqs.at(-1)),
    endSeq: Number(shadowedSeqs.at(-1)),
    turn: Math.max(0, storyEventTurn(assistantEvent) || 0),
    step: Math.max(1, Number(assistantEvent && assistantEvent.data && assistantEvent.data.step) || 1),
    source: assistantEvent ? modelSourceOf(assistantEvent) : null,
    shadowedSeqs: Object.freeze(shadowedSeqs)
  })
}

export function locateRollbackSurface(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  const { index: userIndex } = lastRoundInput(events, nodes)
  if (userIndex < 0) return null

  let assistantIndex = -1
  for (let index = nodes.length - 1; index > userIndex; index -= 1) {
    const event = eventAt(events, nodes[index])
    // A previous rollback leaves an empty, model-sourced replacement because
    // native DSH restore rejects plugin-owned assistant messages. It is a
    // projection tombstone, not the assistant reply paired with this user.
    if (event && event.type === 'assistant/message' && modelSourceOf(event) !== null && !isRollbackAssistantTombstone(event, events)) {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return null
  return rollbackTargetAt(events, nodes, userIndex, assistantIndex)
}

function turnIntervals(events) {
  const starts = new Map(), intervals = []
  for (const event of events) {
    if (!event) continue
    const turn = Number(event.data?.turn)
    if (event.type === 'turn/start') starts.set(turn, event.seq)
    if (event.type === 'turn/end' && starts.has(turn)) {
      intervals.push({ turn, start: starts.get(turn), end: event.seq, failed: ['error', 'aborted'].includes(event.data?.reason?.kind) })
      starts.delete(turn)
    }
  }
  return intervals
}

export function planFailedTurnSurface(input) {
  const events = Array.isArray(input && input.events) ? input.events : []
  const nodes = Array.isArray(input && input.nodes) ? input.nodes : []
  const turn = Math.max(0, Number(input && input.turn) || 0)
  const interval = turnIntervals(events).findLast(interval => interval.turn === turn)
  if (!interval) return null
  const { start: startSeq, end: endSeq } = interval

  return planSurfaceRecovery({
    nodes,
    ownership: input.ownership || createSurfaceOwnership(events),
    selectOrigin: event => event.seq > startSeq && event.seq < endSeq,
    inScope: event => event.seq > startSeq,
    ignore: isRollbackUserTombstone,
    message: '失败回合的模型消息面不是连续区间，无法安全清理'
  })
}

/** Clear a failed turn's residue from the model surface, as one transaction.
 * Returns how many surface nodes were shadowed (0 when already clean). */
export async function clearFailedTurnSurface(input) {
  const session = input && input.session
  if (!session || typeof session.append !== 'function') return 0
  let shadowed = 0
  await writeSurfaceEvent(session, {
    operation: 'failed-turn-cleanup', flush: input.flush,
    plan: (events, nodes) => {
      const cleanup = planFailedTurnSurface({ events, nodes, turn: input.turn })
      if (cleanup === null) return null
      shadowed = cleanup.shadowedSeqs.length
      // DSH permits plugin-injected user messages, but assistant messages must be
      // model-sourced on restore. Keep this empty tombstone explicitly plugin-owned.
      return {
        type: 'user/message',
        data: { id: randomUUID(), role: 'user', content: [], source: producerSource('dsh-tavern-failed-turn-cleanup') },
        intent: { surfaceOp: { op: 'replace', start: cleanup.start, end: cleanup.end }, sourceEventSeqs: cleanup.shadowedSeqs }
      }
    }
  })
  return shadowed
}

export function hasRollbackMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = object(list[index])
    if (!message || message.role !== 'assistant' || message.greeting === true) continue
    const user = object(list[index - 1])
    return user !== null && user.role === 'user'
  }
  return false
}

// Recover only ended, uncommitted failures still present at the surface tail.
// A missing cleanup hook must not turn an interrupted input into a dead end.
function unclearedFailedTail(chat, events, nodes) {
  const tail = nodes.findLast(seq => {
    const event = eventAt(events, seq)
    return !isRollbackAssistantTombstone(event, events) && !isRollbackUserTombstone(event) && !isForegroundContext(event)
  })
  if (tail === undefined) return []
  const latest = (chat.messages || []).findLast(message => message?.role === 'assistant')
  const lastEvent = eventAt(events, tail)
  const floors = projectChatFloors(chat, events, nodes)
  if (lastEvent?.type === 'assistant/message' && (storyEventTurn(lastEvent) === Number(latest?.turn) || storyEventTurn(lastEvent) === floorHostTurn(floors, latest?.turn))) return []
  const committed = new Set((chat.messages || []).filter(message => message?.role === 'assistant').map(message => Number(message.turn)))
  for (const floor of floors.floors) committed.add(floor.hostTurn)
  const intervals = turnIntervals(events)
  const ownership = createSurfaceOwnership(events)
  let remaining = [...nodes]
  const result = []
  while (remaining.length) {
    const event = eventAt(events, remaining.at(-1))
    if (isRollbackAssistantTombstone(event, events) || isRollbackUserTombstone(event) || isForegroundContext(event)) { remaining.pop(); continue }
    const origin = ownership.firstOrigin(event?.seq)
    const interval = intervals.findLast(item =>
      (event?.type === 'assistant/message' && storyEventTurn(event) === item.turn) ||
      (origin > item.start && origin < item.end))
    if (!interval?.failed || committed.has(interval.turn)) break
    const plan = planFailedTurnSurface({ events, nodes, turn: interval.turn, ownership })
    if (!plan) break
    result.push(interval.turn)
    const removed = new Set(plan.shadowedSeqs)
    remaining = remaining.filter(seq => !removed.has(seq))
  }
  return result
}

export function rollbackNativeTurns(chat, events, visibleTurn, nodes) {
  return floorNativeTurns(projectChatFloors(chat, events, nodes), visibleTurn)
}

/**
 * The surface rows a rollback of the Chat's latest floor clears, from the
 * floor projection (position), not from native turn numbers. The log decides:
 * - the floor is live on the surface: its player input is the anchor, whatever
 *   follows it (an orphan completed round the Chat never recorded, rows with
 *   other turn numbers) is cleared by the same selection;
 * - the floor is absent from a surface that provably ends before it (no row of
 *   that turn or later, no compaction summary): the surface already excludes it, so only the Chat
 *   steps back (`surfaceMissing`), and the usual branch + checkout still
 *   leaves a saved line to undo to;
 * - anything else cannot be mapped and stays refused.
 */
function floorRollbackTarget(chat, events, nodes, turn, heuristic) {
  const projection = projectChatFloors(chat, events, nodes)
  const floor = projection.floors.find(item => item.turn === turn)
  if (!floor) return { target: heuristic, refusal: heuristic ? '' : 'no-round-on-surface' }
  if (floor.inputSeq === null && heuristic && floorNativeTurns(projection, turn).has(heuristic.turn)) return { target: heuristic, refusal: '' }
  if (floor.inputSeq !== null) {
    const index = nodes.indexOf(floor.inputSeq)
    if (nodes.slice(index).some(seq => isCompactionCheckpoint(eventAt(events, seq)))) return { target: null, refusal: 'compaction-boundary' }
    if (heuristic && heuristic.userSeq === floor.inputSeq) return { target: heuristic, refusal: '' }
    const body = floor.bodySeq === null ? -1 : nodes.indexOf(floor.bodySeq)
    return { target: { ...rollbackTargetAt(events, nodes, index, body), turn: floor.bodyTurn || floor.turn }, refusal: '' }
  }
  // Proof that the surface ends before the floor: it holds something, no
  // compaction summary that could still carry the floor's story, and no row of
  // this turn or later (a stray body, a renumbered round) that the Chat step
  // back would leave in the model's context.
  if (nodes.length === 0) return { target: null, refusal: 'surface-empty' }
  if (nodes.some(seq => isCompactionCheckpoint(eventAt(events, seq)))) return { target: null, refusal: 'compaction-boundary' }
  if (latestSurfaceTurn(events, nodes) >= turn) return { target: null, refusal: 'floor-not-mappable' }
  const shadowedSeqs = Object.freeze([])
  return { target: Object.freeze({ userSeq: null, assistantSeq: null, endSeq: null, turn, step: 1, source: null, shadowedSeqs, surfaceMissing: true }), refusal: '' }
}

// UI and mutation share the same native target and failed-tail precedence.
function planRollbackAvailability(chat, { events = [], nodes = [] } = {}) {
  const unclearedTurns = unclearedFailedTail(chat, events, nodes)
  const failedTurns = [...new Set([...pendingFailedSurfaceTurns({ events, nodes, suppressed: chat.acknowledgedFailedTurns || [] }), ...unclearedTurns])].sort((a, b) => a - b)
  if (failedTurns.length) return { canRollback: true, canClearIncompleteReply: true, failedTurns, unclearedTurns, target: null, reason: '' }
  const heuristic = locateRollbackSurface({ events, nodes })
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const latest = messages.findLast(message => message?.role === 'assistant' && message.greeting !== true)
  if (isRescuedHistoryMessage(chat, latest)) return { canRollback: false, canClearIncompleteReply: false, failedTurns, target: null, code: 'rescued-history', reason: '存档救援导入的历史不可回退，请发送新消息继续' }
  const turn = Number(latest?.turn)
  const located = turn > 0 ? floorRollbackTarget(chat, events, nodes, turn, heuristic) : { target: heuristic, refusal: heuristic ? '' : 'no-round-on-surface' }
  const hasMessages = hasRollbackMessages(messages)
  const canRollback = hasMessages && Boolean(located.target)
  return { canRollback, canClearIncompleteReply: false, failedTurns, target: canRollback ? located.target : null,
    code: canRollback ? '' : hasMessages ? located.refusal : 'no-committed-round',
    reason: canRollback ? '' : hasMessages ? '当前轮次已不在可回退的消息流中，请继续发送新消息；历史正文仍保留。' : '当前没有可回退的已提交轮次' }
}

// Unsafe recovery is a domain result in views, and the mutation consumes that
// same result. Never let a corrupt range take down the entire status query.
export function rollbackAvailability(chat, input = {}) {
  try {
    return planRollbackAvailability(chat, input)
  } catch (error) {
    if (!(error instanceof SurfaceRecoveryError)) throw error
    return { canRollback: false, canClearIncompleteReply: false, failedTurns: [], unclearedTurns: [], target: null, code: 'unsafe-failed-surface', reason: error.message }
  }
}

export function failedTurnReplayAvailability({ events = [], nodes = [] } = {}) {
  const target = replayableFailedTurn({ events })
  if (!target) return { target: null, reason: '当前没有可重新生成的失败回合' }
  try {
    planFailedTurnSurface({ events, nodes, turn: target.turn })
    return { target, reason: '' }
  } catch (error) {
    if (!(error instanceof SurfaceRecoveryError)) throw error
    return { target: null, reason: error.message }
  }
}
