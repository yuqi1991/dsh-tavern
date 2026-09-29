import { appendSessionEvent, sessionEvents } from './session-events.js'
import { createSessionSurfaceMutator } from './session-surface-mutations.js'
import { preflightSurfaceRestore, restoreSurface } from './surface-restoration.js'

/**
 * Production-side adapter for the conversation-algebra seam. It deliberately
 * lives outside the independently importable algebra directory: all durable
 * writes continue through Tavern's existing Session append/replace helpers.
 * Stage 0 does not wire this adapter into any product path.
 */
export function createConversationAlgebraHostAdapter(session, metadata = {}) {
  if (!session || typeof session.append !== 'function') throw new TypeError('conversation algebra 缺少宿主 Session')
  return Object.freeze({
    snapshotEvents() {
      return sessionEvents(session)
    },
    append(type, data, intent) {
      if (intent?.surfaceOp?.op === 'replace') {
        const op = intent.surfaceOp
        return createSessionSurfaceMutator(session).replace(type, data, {
          start: op.startSeq ?? op.start,
          end: op.endSeq ?? op.end,
          sourceEventSeqs: intent.sourceEventSeqs
        })
      }
      return appendSessionEvent(session, type, data, { surfaceOp: 'append' })
    },
    preflightCheckout(targetNodes) {
      return preflightSurfaceRestore(session, targetNodes)
    },
    checkout(targetNodes) {
      return restoreSurface(session, targetNodes)
    },
    ...(typeof metadata.read === 'function' ? { readMetadata: metadata.read } : {}),
    ...(typeof metadata.write === 'function' ? { writeMetadata: metadata.write } : {}),
    ...(typeof metadata.bump === 'function' ? { bump: metadata.bump } : {})
  })
}
