import { isTavernSurfaceEdit } from './session-surface-mutations.js'
import { SURFACE_SELECT_TYPE, planSurfaceSelection } from './surface-selection.js'
const installations = new WeakMap()


/**
 * rc.1's meter assumes every assistant/message belongs to an active model step.
 * Tavern seeds and surface edits have no provider request/usage. Account for them
 * as injected messages in the meter's fold only, preserving their assistant role,
 * surface operation and seq. Never mutate the Session or its outgoing messages.
 * This isolated private-API shim must be covered against the installed host and
 * can be removed when upstream supports out-of-step surface edits natively.
 */
export function installTavernTokenMeter(meter) {
  if (!meter || typeof meter._foldEvent !== 'function') throw new Error('当前 DSH Token Meter 不支持 Tavern 消息统计适配，请检查 DSH 版本')
  let entry = installations.get(meter)
  if (!entry) {
    const original = meter._foldEvent
    const hadOwn = Object.hasOwn(meter, '_foldEvent')
    const compactSignature = original.length === 2
    const originalSync = meter._sync
    const hadOwnSync = Object.hasOwn(meter, '_sync')
    if (compactSignature && typeof originalSync !== 'function') throw new Error('当前 DSH Token Meter 缺少同步入口')
    const presetCursors = new WeakMap()
    function presetBefore(session, state, seq) {
      let cursor = presetCursors.get(state)
      if (!cursor || cursor.session !== session || seq < cursor.nextSeq) {
        cursor = { session, nextSeq: 0, selected: undefined }
        presetCursors.set(state, cursor)
      }
      // Read only the unseen prefix, excluding the event being classified.
      // Reset with the host fold state, or when a replay moves backwards.
      while (cursor.nextSeq < seq) {
        const previous = session.eventAt(cursor.nextSeq)
        if (previous?.type === 'agent-preset/selected') cursor.selected = previous.data?.agentPreset
        cursor.nextSeq++
      }
      return cursor.selected ?? session.header?.agentPreset
    }
    let activeSession
    function sync(session, ...args) {
      const previous = activeSession
      activeSession = session
      try { return originalSync.call(this, session, ...args) }
      finally { activeSession = previous }
    }
    // ADR-0009: price a selection as the referenced nodes. Nodes already on
    // the meter's surface keep their prices; others are priced by folding a
    // detached append copy through the native meter.
    function select(meterThis, session, state, event) {
      const nodes = planSurfaceSelection(state.surface.map(node => node.seq), event, seq => session.eventAt(seq))
      const priced = new Map(state.surface.map(node => [node.seq, node]))
      const next = nodes.map(seq => {
        if (priced.has(seq)) return priced.get(seq)
        const target = session.eventAt(seq)
        const { surfaceOp: _op, sourceEventSeqs: _sources, ...rest } = target
        const copy = target.type === 'assistant/message'
          ? { ...rest, type: 'user/message', data: target.data.message, surfaceOp: 'append' }
          : { ...rest, surfaceOp: 'append' }
        const scratch = { consumedEvents: 0, header: undefined, surface: [], stepStart: undefined, anchor: undefined }
        if (compactSignature) original.call(meterThis, scratch, copy)
        else original.call(meterThis, session, scratch, copy)
        return scratch.surface[0]
      })
      state.surface.splice(0, state.surface.length, ...next)
    }
    function fold(...args) {
      const [session, state, event] = compactSignature ? [activeSession, ...args] : args
      if (event?.type === SURFACE_SELECT_TYPE) {
        if (!session) throw new Error('Tavern token meter: selection needs its session')
        return select(this, session, state, event)
      }
      const accountingEvent = session && isTavernSurfaceEdit(session, event, state.surface, () => presetBefore(session, state, event.seq))
        ? { ...event, type: 'user/message', data: event.data.message }
        : event
      return compactSignature ? original.call(this, state, accountingEvent) : original.call(this, session, state, accountingEvent)
    }
    meter._foldEvent = fold
    if (compactSignature) meter._sync = sync
    entry = { original, fold, hadOwn, originalSync, hadOwnSync, compactSignature, users: 0 }
    installations.set(meter, entry)
  }
  entry.users++
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (--entry.users !== 0) return
    if (entry.hadOwn) meter._foldEvent = entry.original
    else delete meter._foldEvent
    if (entry.compactSignature) {
      if (entry.hadOwnSync) meter._sync = entry.originalSync
      else delete meter._sync
    }
    installations.delete(meter)
  }
}
