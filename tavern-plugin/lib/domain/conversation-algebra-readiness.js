import { waitForTransactionReady, hasPendingTransaction } from './conversation-algebra/index.js'
import { createConversationAlgebraHostAdapter } from './conversation-algebra-host-adapter.js'


/** Lazy cold-session inspection. All writes remain in the host-owned Session;
 * observing a clean cold session does not activate an Agent. */
export function createConversationReadiness({getSession, observe, resume, flush, hasHistoryIntent = async () => false, recoverHistory = async () => {}}) {
  const cold = new Map()
  async function live(session) {
    await recoverHistory(session)
    await waitForTransactionReady(createConversationAlgebraHostAdapter(session,{flush}))
  }
  async function ready(id,signal) {
    signal?.throwIfAborted()
    const session=getSession(id)
    if (session) return live(session)
    if (cold.has(id)) return cold.get(id)
    const pending=(async()=>{
      const observation=await observe(id,signal)
      let needsRecovery
      try { needsRecovery=hasPendingTransaction(observation.events) }
      finally { observation[Symbol.dispose]?.() }
      needsRecovery ||= await hasHistoryIntent(id)
      if (!needsRecovery) return
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
