import { appendSessionEvent, sessionEvents } from './session-events.js'
import { createSessionSurfaceMutator } from './session-surface-mutations.js'
import { preflightSurfaceRestore, restoreSurface } from './surface-restoration.js'
import { guardStepComplete } from './conversation-algebra/index.js'

/**
 * Production-side adapter for the conversation-algebra seam. It deliberately
 * lives outside the independently importable algebra directory: all durable
 * writes continue through Tavern's existing Session append/replace helpers.
 * Stage 0 does not wire this adapter into any product path.
 */
export function createConversationAlgebraHostAdapter(session, metadata = {}) {
  if (!session || typeof session.append !== 'function') throw new TypeError('conversation algebra 缺少宿主 Session')
  return Object.freeze({
    sessionKey: session,
    snapshotEvents() {
      return sessionEvents(session)
    },
    preflight(writes) {
      if (typeof session.constructor?.fromRestore !== 'function') throw new TypeError('宿主 Session 缺少 detached 预检能力')
      const preview = session.constructor.fromRestore(session.id, structuredClone(sessionEvents(session)), structuredClone(session.header), session.inheritedEventCount, 'detached')
      const adapter = createConversationAlgebraHostAdapter(preview)
      for (const write of writes) adapter.append(write.event.type, write.event.data, write.intent)
      return [...preview.surface.nodes]
    },
    surfaceNodes() { return [...session.surface.nodes] },
    planCheckout(targetNodes) {
      const events = sessionEvents(session)
      const nodes = [...session.surface.nodes]
      const targets = targetNodes.map(seq => events.find(event => event.seq === seq))
      if (targets.some(event => !event)) throw new Error('checkout 引用不存在')
      // Only a closed assistant/tool interaction is a legal checkpoint.
      let group = []
      for (const event of targets) {
        if (event.type === 'assistant/message') {
          if (group.length) guardStepComplete({ rows: group })
          group = [event]
        } else if (event.type === 'tool/result') group.push(event)
        else if (group.length) { guardStepComplete({ rows: group }); group = [] }
      }
      if (group.length) guardStepComplete({ rows: group })
      let prefix = 0
      while (prefix < nodes.length && prefix < targetNodes.length && nodes[prefix] === targetNodes[prefix]) prefix++
      if (prefix === nodes.length && prefix === targetNodes.length) return []
      while (prefix > 0 && targets[prefix]?.type === 'tool/result') prefix--
      const writes = []
      const suffix = nodes.slice(prefix)
      if (suffix.length) {
        if (prefix === 0 && events.find(event => event.seq === nodes[0])?.type === 'system/message') throw new Error('checkout 不得覆盖受保护的 system head')
        writes.push({ kind: 'surface-write', event: { type: 'user/message', data: {
          id: `conversation-checkout:${events.at(-1)?.seq}:clear`, role: 'user', content: [],
          source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'checkout' }
        } }, intent: { surfaceOp: {op:'replace',start:suffix[0],end:suffix.at(-1)}, sourceEventSeqs:suffix } })
      }
      for (const event of targets.slice(prefix)) writes.push({kind:'surface-write',event:{type:event.type,data:structuredClone(event.data)},intent:{surfaceOp:'append'}})
      return writes
    },
    flush() {
      if (typeof metadata.flush !== 'function') throw new TypeError('宿主事务必须配置 flush')
      return metadata.flush(session)
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
