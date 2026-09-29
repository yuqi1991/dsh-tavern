import { computeFold } from './fold.js'
import { guardShape } from './guards.js'

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

function messageOfWrite(write) {
  return write.event.type === 'user/message' ? write.event.data : write.event.data.message
}

function withTransaction(write, operationId, phase) {
  const next = structuredClone(write)
  const message = messageOfWrite(next)
  message.source = { ...message.source, conversationTransaction: { operationId, phase } }
  return next
}

function normalizeIntent(intent) {
  const surfaceOp = intent?.surfaceOp
  if (surfaceOp?.op !== 'replace') return { surfaceOp: 'append' }
  return {
    surfaceOp: { op: 'replace', startSeq: surfaceOp.startSeq ?? surfaceOp.start, endSeq: surfaceOp.endSeq ?? surfaceOp.end },
    sourceEventSeqs: [...intent.sourceEventSeqs]
  }
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

export async function runTransaction(adapter, { expectedHead, ops = [], operationId, converge } = {}) {
  if (!adapter || typeof adapter.append !== 'function') throw new TypeError('事务缺少 append adapter')
  const before = snapshot(adapter)
  const current = computeFold(before)
  if (expectedHead !== undefined && expectedHead !== current.headSeq) throw new TransactionConflict(expectedHead, current.headSeq)
  const writes = ops.filter(op => op?.kind === 'surface-write')
  const checkouts = ops.filter(op => op?.kind === 'checkout')
  if (checkouts.length > 1 || (checkouts.length > 0 && writes.length > 0)) throw new TypeError('checkout 必须作为事务内唯一的 surface 操作')
  const id = String(operationId || `conversation-${current.headSeq + 1}`)
  const staged = writes.map((write, index) => withTransaction(write, id,
    writes.length === 1 ? 'begin-commit' : index === 0 ? 'begin' : index === writes.length - 1 ? 'commit' : 'continue'))

  // Preflight the complete transaction against a detached event list. No adapter
  // method is called until every operation folds successfully.
  const preview = before.map(event => structuredClone(event))
  for (const write of staged) {
    guardShape(write.event)
    const seq = preview.length === 0 ? 0 : Math.max(...preview.map(event => event.seq)) + 1
    preview.push({ type: write.event.type, data: structuredClone(write.event.data), ...normalizeIntent(write.intent), seq, time: 0 })
  }
  const previewFold = computeFold(preview)

  if (checkouts.length > 0) {
    if (typeof adapter.preflightCheckout === 'function') await adapter.preflightCheckout(checkouts[0].targetNodes)
    if (typeof adapter.checkout !== 'function') throw new TypeError('事务 adapter 不支持 checkout')
  }

  const metadata = metadataAfter(typeof adapter.readMetadata === 'function' ? await adapter.readMetadata() : null, ops)
  for (const write of staged) await adapter.append(write.event.type, write.event.data, normalizeIntent(write.intent))
  if (checkouts.length > 0) await adapter.checkout(checkouts[0].targetNodes)
  if (typeof adapter.writeMetadata === 'function' && ops.some(op => op.kind === 'branch' || op.kind === 'checkout')) await adapter.writeMetadata(metadata)
  const fold = computeFold(snapshot(adapter), { fromCache: { headSeq: current.headSeq, version: current.version } })
  if (typeof adapter.bump === 'function') await adapter.bump(fold.version)
  if (typeof converge === 'function') await converge(fold)
  return { committedSeq: fold.headSeq, foldVersion: fold.version, operationId: id, preview: previewFold, fold, metadata }
}
