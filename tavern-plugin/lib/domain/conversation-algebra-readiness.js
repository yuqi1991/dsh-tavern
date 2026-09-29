import { waitForTransactionReady, committedMetadata } from './conversation-algebra/index.js'
import { sessionEvents } from './session-events.js'
import { createConversationAlgebraHostAdapter, setConversationRegistryWriter } from './conversation-algebra-host-adapter.js'

export function hasPendingConversationTransaction(events) {
  const tags=events.map(event=>(event.type==='user/message'?event.data:event.data?.message)?.source?.conversationTransaction).filter(Boolean)
  const commits=new Set(tags.filter(tag=>['commit','begin-commit'].includes(tag.phase)).map(tag=>tag.operationId))
  return tags.some(tag=>tag.phase==='begin'&&!commits.has(tag.operationId))
}

/** Lazy cold-session inspection. All writes remain in the host-owned Session;
 * observing a clean cold session does not activate an Agent. */
export function createConversationReadiness({getSession, observe, resume, flush, writeRegistry, hasHistoryIntent = async () => false, recoverHistory = async () => {}}) {
  const cold = new Map()
  async function live(session) {
    if (typeof writeRegistry === 'function') setConversationRegistryWriter(session, value => writeRegistry(session.id, value))
    await recoverHistory(session)
    const metadata = typeof writeRegistry === 'function' ? { write: value => writeRegistry(session.id, value) } : {}
    await waitForTransactionReady(createConversationAlgebraHostAdapter(session,{flush,...metadata}))
    const registry = committedMetadata(sessionEvents(session))
    if (registry && typeof writeRegistry === 'function') await writeRegistry(session.id, registry)
  }
  async function ready(id,signal) {
    signal?.throwIfAborted()
    const session=getSession(id)
    if (session) return live(session)
    if (cold.has(id)) return cold.get(id)
    const pending=(async()=>{
      const observation=await observe(id,signal)
      let needsRecovery, registry
      try { needsRecovery=hasPendingConversationTransaction(observation.events); registry=committedMetadata(observation.events) }
      finally { observation[Symbol.dispose]?.() }
      needsRecovery ||= await hasHistoryIntent(id)
      if (!needsRecovery) {
        if (registry && typeof writeRegistry === 'function') await writeRegistry(id, registry)
        return
      }
      const handle=await resume(id)
      try { await live(handle.agent.session) }
      finally { await handle.dispose() }
    })()
    cold.set(id,pending)
    try { await pending; signal?.throwIfAborted() }
    finally { if(cold.get(id)===pending)cold.delete(id) }
  }
  return {ready,live}
}
