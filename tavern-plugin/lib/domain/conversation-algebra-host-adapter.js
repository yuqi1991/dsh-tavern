import { appendSessionEvent, sessionEvents } from './session-events.js'
import { createSessionSurfaceMutator } from './session-surface-mutations.js'
import { SURFACE_SELECT_TYPE } from './surface-selection.js'
import { randomUUID } from 'node:crypto'
import { runTransaction } from './conversation-algebra/index.js'

/** An isolated native copy for admission checks; writes to it never reach disk. */
export function detachedSession(session) {
  if (typeof session?.constructor?.fromRestore !== 'function') throw new TypeError('宿主 Session 缺少 detached 预检能力')
  return session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')
}

/** Run a transaction on a detached copy: native admission, tool pairing and
 * selection effect are checked before a caller publishes a durable intent. */
export function preflightTransaction(session, { ops, expectedHead } = {}) {
  const adapter = createConversationAlgebraHostAdapter(detachedSession(session), { flush: async () => {}, write: async () => {} })
  return runTransaction(adapter, { ops, expectedHead, operationId: 'preflight:' + randomUUID() })
}

/**
 * Production-side adapter for the conversation-algebra seam. It deliberately
 * lives outside the independently importable algebra directory: all durable
 * writes continue through Tavern's existing Session append/replace helpers.
 */
export function createConversationAlgebraHostAdapter(session, metadata = {}) {
  if (!session || typeof session.append !== 'function') throw new TypeError('conversation algebra 缺少宿主 Session')
  return Object.freeze({
    sessionKey: session,
    snapshotEvents() {
      return sessionEvents(session)
    },
    preflight(writes) {
      const preview = detachedSession(session)
      const adapter = createConversationAlgebraHostAdapter(preview)
      const head = sessionEvents(session).at(-1)?.seq ?? -1
      const delta = (sessionEvents(preview).at(-1)?.seq ?? -1) - head
      const translate = seq => seq > head ? seq + delta : seq
      for (const write of writes) {
        const intent = structuredClone(write.intent)
        if (intent?.surfaceOp?.op === 'replace') {
          intent.surfaceOp = { op: 'replace', startSeq: translate(intent.surfaceOp.startSeq ?? intent.surfaceOp.start), endSeq: translate(intent.surfaceOp.endSeq ?? intent.surfaceOp.end) }
          intent.sourceEventSeqs = intent.sourceEventSeqs.map(translate)
        }
        adapter.append(write.event.type, write.event.data, intent)
        // An unpatched host would log the selection without applying it.
        if (write.event.type === SURFACE_SELECT_TYPE && JSON.stringify([...preview.surface.nodes]) !== JSON.stringify(write.event.data.nodes)) {
          throw new Error('宿主会话补丁未生效，不能写入上下文选择')
        }
      }
      return [...preview.surface.nodes]
    },
    surfaceNodes() { return [...session.surface.nodes] },
    flush() {
      if (typeof metadata.flush !== 'function') throw new TypeError('宿主事务必须配置 flush')
      return metadata.flush(session)
    },
    append(type, data, intent) {
      // ADR-0009: a selection is log-only; the patched host fold applies it.
      if (type === SURFACE_SELECT_TYPE) return appendSessionEvent(session, type, data)
      if (intent?.surfaceOp?.op === 'replace') {
        const op = intent.surfaceOp
        return createSessionSurfaceMutator(session).replace(type, data, {
          start: op.startSeq ?? op.start,
          end: op.endSeq ?? op.end,
          sourceEventSeqs: intent.sourceEventSeqs
        })
      }
      return createSessionSurfaceMutator(session).append(type, data, { surfaceOp: 'append' })
    },
    ...(typeof metadata.bump === 'function' ? { bump: metadata.bump } : {})
  })
}
