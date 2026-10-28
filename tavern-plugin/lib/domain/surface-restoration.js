import { producerSource } from './message-source.js'
import { appendSessionEvent, sessionEvents } from './session-events.js'
import { SURFACE_SELECT_TYPE } from './surface-selection.js'
import { detachedSession } from './conversation-algebra-host-adapter.js'

/**
 * Seqs of surface replacements that a later restoration undid. Legacy logs
 * mark them on the restored copy; since ADR-0009 a selection that brings back
 * rows a replacement shadowed, without the replacement itself, undoes it.
 */
export function restoredSurfaceSeqs(events) {
  const restored = new Set(events.flatMap(event => Array.isArray(event.data?.tavernRestoredSurfaceSeqs) ? event.data.tavernRestoredSurfaceSeqs : []))
  const replacements = []
  for (const event of events) {
    if (event.surfaceOp?.op === 'replace' && Array.isArray(event.sourceEventSeqs)) replacements.push(event)
    if (event.type !== SURFACE_SELECT_TYPE || !Array.isArray(event.data?.nodes)) continue
    const selected = new Set(event.data.nodes)
    for (const replacement of replacements) {
      if (!selected.has(replacement.seq) && replacement.sourceEventSeqs.some(seq => selected.has(seq))) restored.add(replacement.seq)
    }
  }
  return restored
}

function selection(nodes) {
  return { version: 1, nodes: [...nodes], source: producerSource('dsh-tavern', { form: 'surface-select' }) }
}

/** Check a selection against a detached copy; throws before any write. */
export function preflightSelectSurface(session, nodes) {
  const preview = detachedSession(session)
  appendSessionEvent(preview, SURFACE_SELECT_TYPE, selection(nodes))
  // An unpatched host would log the selection without applying it.
  if (JSON.stringify([...preview.surface.nodes]) !== JSON.stringify([...nodes])) throw new Error('宿主会话补丁未生效，不能写入上下文选择')
}

/** Switch a session's model context to saved nodes by reference (ADR-0009). */
export function selectSurface(session, nodes) {
  if (JSON.stringify([...session.surface.nodes]) === JSON.stringify([...nodes])) return
  preflightSelectSurface(session, nodes)
  appendSessionEvent(session, SURFACE_SELECT_TYPE, selection(nodes))
}

/** Resuming a persisted session appends a seed marker, not a context edit. */
export function unchangedSinceRollback(session, afterCount) {
  const events = sessionEvents(session)
  return Number.isSafeInteger(afterCount) && afterCount >= 0 && afterCount <= events.length
    && events.slice(afterCount).every(event => event.type === 'session/end-seed' && event.surfaceOp === undefined)
}

export function canUndoRollback(chat, session) {
  const saved = chat?.rollbackUndo
  return Boolean(saved?.version === 1 && saved.ready === true && session
    && saved.branchId === chat.timeline?.branchId && saved.revision === chat.timeline?.revision
    && saved.lifecycleRevision === Number(chat.tavernHelperLifecycleRevision || 0)
    && saved.storageRevision === Number(chat._storageRevision || 0)
    && unchangedSinceRollback(session, saved.foreground.afterCount))
}
