import { producerSource } from '../message-source.js'
import { computeFold } from './fold.js'
import { GuardError, committedOperationIds, guardShape, hasPendingTransaction, transactionOf } from './guards.js'
import { SURFACE_SELECT_TYPE } from '../surface-selection.js'

const transactionQueues = new WeakMap()
const quarantined = new WeakSet()

/** Join any writer before recovery; a rejected writer remains quarantined until
 * its durable intent has been inspected. Callers must not swallow recovery errors. */
export async function waitForTransactionReady(adapter) {
  const key = adapter.sessionKey || adapter
  for (;;) {
    const pending = transactionQueues.get(key)
    if (!pending) break
    await pending.catch(() => {})
  }
  if (quarantined.has(key) || hasPendingTransaction(snapshot(adapter))) await recoverTransaction(adapter)
  assertTransactionReady(adapter)
}

function isHostMarker(event) {
  return event?.type === 'dsh-tavern/required-session-patch-v1' && event.surfaceOp === undefined && event.data?.version === 1
}

function isRecoveryLifecycle(event) {
  return event.surfaceOp === undefined && ['session/end-seed','turn/start','turn/end','step/start','step/end','assistant/attempt'].includes(event.type)
}

// Released V4 only accepts an assistant or tool event inside an open step, so the
// host writer may place a write in a step of its own (turn/start ... turn/end around
// it, turn and step numbers adjusted). Those lifecycle events and the turn/step
// numbers are placement, not content.
const PLACED_TYPES = new Set(['assistant/message', 'tool/result'])
const placementLifecycle = event => event.surfaceOp === undefined && ['turn/start', 'step/start', 'step/end', 'turn/end'].includes(event.type)
function withoutPlacement(type, data) {
  if (!PLACED_TYPES.has(type) || data === null || typeof data !== 'object') return data
  const { turn: _turn, step: _step, ...rest } = data
  const source = rest.message?.source
  if (source?.tavernStoryTurn === undefined) return rest
  const { tavernStoryTurn: _story, ...plain } = source
  return { ...rest, message: { ...rest.message, source: plain } }
}
const sameData = (type, left, right) => JSON.stringify(withoutPlacement(type, left)) === JSON.stringify(withoutPlacement(type, right))

function cursorAfterWrite(adapter, cursor, write) {
  const added = snapshot(adapter).filter(event => event.seq > cursor)
  const written = added.filter(event => event.type === write.event.type && sameData(event.type, event.data, write.event.data))
  const event = written.at(-1)
  if (!event || written.length !== 1 || added.some(item => item !== event && !isHostMarker(item) && !placementLifecycle(item)) ||
      added.filter(isHostMarker).length > 1) throw new Error('事务写入数量或内容异常')
  if (write.plannedSeq !== undefined && event.seq !== write.plannedSeq) throw new Error('恢复计划事件位置与宿主不一致')
  return added.at(-1).seq
}

export function assertTransactionReady(adapter) {
  const key = adapter.sessionKey || adapter
  const events = snapshot(adapter)
  const begins = events.filter(event => transactionOf(event)?.phase === 'begin')
  const commits = committedOperationIds(events)
  if (quarantined.has(key) || transactionQueues.has(key) || begins.some(event => !commits.has(transactionOf(event).operationId))) throw new Error('会话事务未恢复，暂不可生成或发布视图')
}

export function recoverTransaction(adapter) {
  return serialize(adapter, async () => {
    const key = adapter.sessionKey || adapter
    quarantined.add(key)
    const events = snapshot(adapter)
    const begin = events.findLast(event => transactionOf(event)?.phase === 'begin')
    if (begin) {
      const saved = transactionOf(begin)
      const committed = events.some(event => transactionOf(event)?.operationId === saved.operationId && transactionOf(event)?.phase === 'commit')
      if (!committed) {
        if (!Array.isArray(saved.plan)) throw new Error('旧事务缺少恢复计划，保持隔离')
        const applied = events.filter(event => transactionOf(event)?.operationId === saved.operationId)
        if (applied.length > saved.plan.length) throw new Error('事务记录多于恢复计划')
        // Only plans written before ADR-0009 carry placeholder positions
        // (plannedSeq); new transactions never stage them.
        const positions = new Map()
        const mappedIntent = write => {
          const intent = normalizeIntent(write.intent)
          const map = seq => positions.get(seq) ?? seq
          if (intent.surfaceOp?.op === 'replace') {
            intent.surfaceOp.startSeq = map(intent.surfaceOp.startSeq)
            intent.surfaceOp.endSeq = map(intent.surfaceOp.endSeq)
            intent.sourceEventSeqs = intent.sourceEventSeqs.map(map)
          }
          return intent
        }
        for (let i = 0; i < applied.length; i++) {
          const actual = structuredClone(applied[i])
          const tag = transactionOf(actual)
          delete tag.plan
          const expected = saved.plan[i]
          if (actual.type !== expected.event.type || !sameData(actual.type, actual.data, expected.event.data) ||
              JSON.stringify(actual.surfaceOp) !== JSON.stringify(mappedIntent(expected).surfaceOp) ||
              JSON.stringify(actual.sourceEventSeqs) !== JSON.stringify(mappedIntent(expected).sourceEventSeqs)) throw new Error('事务记录与恢复计划不匹配')
          if (expected.plannedSeq !== undefined) positions.set(expected.plannedSeq, actual.seq)
        }
        if (events.slice(events.indexOf(begin)).some(event => !isRecoveryLifecycle(event) && !isHostMarker(event) && transactionOf(event)?.operationId !== saved.operationId)) throw new Error('未提交事务后存在外部写入，保持隔离')
        // A restored Session appends lifecycle events. Rebase future generated
        // placeholders, while references to already applied writes follow their
        // actual positions. The immutable saved plan stays the recovery oracle.
        const previousPlanned = saved.plan[applied.length - 1]?.plannedSeq
        const delta = previousPlanned === undefined ? 0 : (events.at(-1)?.seq ?? -1) - previousPlanned
        for (const write of saved.plan.slice(applied.length)) {
          if (write.plannedSeq !== undefined) positions.set(write.plannedSeq, write.plannedSeq + delta)
        }
        const remaining = saved.plan.slice(applied.length).map(write => ({ ...structuredClone(write),
          ...(write.plannedSeq === undefined ? {} : { plannedSeq: positions.get(write.plannedSeq) }), intent: mappedIntent(write) }))
        remaining.forEach(write => guardShape(write.event))
        if (typeof adapter.preflight !== 'function') throw new Error('恢复必须进行宿主预检')
        let cursor = snapshot(adapter).at(-1)?.seq ?? -1
        await adapter.preflight(remaining)
        for (const write of remaining) {
          if ((snapshot(adapter).at(-1)?.seq ?? -1) !== cursor) throw new TransactionConflict(cursor, snapshot(adapter).at(-1)?.seq ?? -1)
          await adapter.append(write.event.type, write.event.data, normalizeIntent(write.intent))
          cursor = cursorAfterWrite(adapter, cursor, write)
        }
      }
    }
    if (typeof adapter.flush !== 'function') throw new Error('恢复必须 flush')
    await adapter.flush()
    const fold = computeFold(snapshot(adapter))
    if (adapter.surfaceNodes && JSON.stringify(adapter.surfaceNodes()) !== JSON.stringify(fold.surfaceNodes)) throw new Error('宿主 surface 与 fold 不一致')
    quarantined.delete(key)
    return fold
  })
}

function serialize(adapter, work) {
  const key = adapter.sessionKey || adapter
  const previous = transactionQueues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(work)
  transactionQueues.set(key, next)
  return next.finally(() => {
    if (transactionQueues.get(key) === next) transactionQueues.delete(key)
  })
}

export class TransactionConflict extends Error {
  constructor(expectedHead, actualHead) {
    super(`期望头 ${expectedHead}，实际头 ${actualHead}`)
    this.name = 'TransactionConflict'
    this.expectedHead = expectedHead
    this.actualHead = actualHead
  }
}

function snapshot(adapter) {
  const events = typeof adapter?.snapshotEvents === 'function' ? adapter.snapshotEvents() : adapter?.events
  return Array.isArray(events) ? events : []
}

/** The record a staged write carries its transaction tag on. */
function carrierOfWrite(write) {
  if (write.event.type === SURFACE_SELECT_TYPE) return write.event.data
  return write.event.type === 'user/message' ? write.event.data : write.event.data.message
}

function withTransaction(write, operationId, phase) {
  const next = structuredClone(write)
  const message = carrierOfWrite(next)
  message.source = { ...message.source, conversationTransaction: { operationId, phase } }
  return next
}

function normalizeIntent(intent) {
  // A selection is log-only: it carries no surface intent.
  if (intent === undefined) return {}
  const surfaceOp = intent?.surfaceOp
  if (surfaceOp === 'append') return { surfaceOp: 'append' }
  if (surfaceOp?.op !== 'replace') throw new GuardError('G1', 'surface intent 无效')
  return {
    surfaceOp: { op: 'replace', startSeq: surfaceOp.startSeq ?? surfaceOp.start, endSeq: surfaceOp.endSeq ?? surfaceOp.end },
    sourceEventSeqs: [...intent.sourceEventSeqs]
  }
}

export function committedMetadata(events) {
  const completed = committedOperationIds(events)
  return events.findLast(event => completed.has(transactionOf(event)?.operationId) && transactionOf(event)?.metadata !== undefined)
    ?.data?.source?.conversationTransaction?.metadata
}

/** ADR-0009: a checkout or branch-only transaction is one selection event
 * naming the complete surface by reference; branch metadata rides on it. */
function surfaceSelection(nodes) {
  return { kind: 'select', event: { type: SURFACE_SELECT_TYPE, data: {
    version: 1, nodes: [...nodes],
    source: producerSource('dsh-tavern', { form: 'surface-select' })
  } } }
}

function metadataAfter(current, ops) {
  const result = structuredClone(current || { version: 1, branches: [], activeBranchId: null, activeHeadSeq: null })
  if (!Array.isArray(result.branches)) result.branches = []
  for (const op of ops) {
    if (op.kind === 'branch') result.branches.push(structuredClone(op.branch))
    if (op.kind === 'checkout') {
      result.activeBranchId = op.branchId
      result.activeHeadSeq = op.headSeq
      for (const branch of result.branches) branch.active = branch.branchId === op.branchId
    }
  }
  return result
}

export function runTransaction(adapter, options = {}) {
  return serialize(adapter, () => commitTransaction(adapter, options))
}

async function commitTransaction(adapter, { expectedHead, ops = [], operationId, converge } = {}) {
  if (!adapter || typeof adapter.append !== 'function') throw new TypeError('事务缺少 append adapter')
  if (quarantined.has(adapter.sessionKey || adapter)) throw new Error('会话事务未恢复')
  const before = snapshot(adapter)
  if (hasPendingTransaction(before)) throw new Error('必须先恢复日志中未完成的事务')
  const current = computeFold(before)
  if (expectedHead !== undefined && expectedHead !== current.headSeq) throw new TransactionConflict(expectedHead, current.headSeq)
  if (ops.some(op => !['surface-write', 'branch', 'checkout'].includes(op?.kind))) throw new GuardError('G1', '未知事务原语')
  const writes = ops.filter(op => op?.kind === 'surface-write')
  const checkouts = ops.filter(op => op?.kind === 'checkout')
  if (checkouts.length > 1 || (checkouts.length > 0 && writes.length > 0)) throw new TypeError('checkout 必须作为事务内唯一的 surface 操作')
  const id = String(operationId || `conversation-${current.headSeq + 1}`)
  if (before.some(event => transactionOf(event)?.operationId === id)) throw new Error('operationId 已使用，请先核对事务结果')
  const changesMetadata = ops.some(op => op.kind === 'branch' || op.kind === 'checkout')
  const metadata = metadataAfter(committedMetadata(before), ops)
  if (changesMetadata && writes.length > 0) throw new TypeError('分支元数据只能随 select 写入，不能与 surface 写入混合')
  if (changesMetadata) writes.push(surfaceSelection(checkouts.length ? checkouts[0].targetNodes : current.surfaceNodes))
  const staged = writes.map((write, index) => withTransaction(write, id,
    writes.length === 1 ? 'begin-commit' : index === 0 ? 'begin' : index === writes.length - 1 ? 'commit' : 'continue'))
  if (changesMetadata) carrierOfWrite(staged.at(-1)).source.conversationTransaction.metadata = metadata
  if (staged.length > 1) {
    carrierOfWrite(staged[0]).source.conversationTransaction.plan = structuredClone(staged)
  }

  // Preflight the complete transaction against a detached event list. No adapter
  // method is called until every operation folds successfully.
  const preview = before.map(event => structuredClone(event))
  for (const write of staged) {
    guardShape(write.event)
    const seq = preview.length === 0 ? 0 : Math.max(...preview.map(event => event.seq)) + 1
    preview.push({ type: write.event.type, data: structuredClone(write.event.data), ...normalizeIntent(write.intent), seq, time: 0 })
  }
  const previewFold = computeFold(preview)
  if (typeof adapter.preflight === 'function') await adapter.preflight(staged)

  const commitHead = snapshot(adapter).reduce((max, event) => Math.max(max, event.seq), -1)
  if (commitHead !== current.headSeq) throw new TransactionConflict(current.headSeq, commitHead)
  const key = adapter.sessionKey || adapter
  quarantined.add(key)
  let expectedCursor = commitHead
  for (const write of staged) {
    const actualCursor = snapshot(adapter).at(-1)?.seq ?? -1
    if (actualCursor !== expectedCursor) throw new TransactionConflict(expectedCursor, actualCursor)
    await adapter.append(write.event.type, write.event.data, normalizeIntent(write.intent))
    expectedCursor = cursorAfterWrite(adapter, expectedCursor, write)
    if (write === staged[0] && typeof adapter.flush === 'function') await adapter.flush()
  }
  if (typeof adapter.flush === 'function') await adapter.flush()
  const fold = computeFold(snapshot(adapter), { fromCache: { headSeq: current.headSeq, version: current.version } })
  if (typeof adapter.bump === 'function') await adapter.bump(fold.version)
  if (typeof converge === 'function') await converge(fold)
  quarantined.delete(key)
  return { committedSeq: fold.headSeq, foldVersion: fold.version, operationId: id, preview: previewFold, fold, metadata }
}
