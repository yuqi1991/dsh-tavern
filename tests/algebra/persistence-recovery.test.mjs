import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { Context } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/cordis/lib/index.js'
import Persistence from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createConversationAlgebraHostAdapter } from '../../tavern-plugin/lib/domain/conversation-algebra-host-adapter.js'
import { appendStep, runTransaction, recoverTransaction } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { user } from './helpers.mjs'

for (const cut of [1,2]) test(`host persistence reopens durable prefix after write ${cut}`, async () => {
  const root=await mkdtemp('/home/claw/dsh-tavern-dev/algebra-persistence-')
  const ctx=new Context()
  const persistence=new Persistence(ctx,{root,compression:'zstd'})
  let handle
  try {
    const session=Session.create('algebra-persistence-test')
    handle=await persistence.create(session.header)
    let durable=0
    const flush=async live=>{
      const events=live.snapshotEvents()
      await handle.append(events.slice(durable))
      durable=events.length
      await handle.flush()
    }
    const base=createConversationAlgebraHostAdapter(session,{flush})
    let calls=0
    const adapter={...base,async append(...args){if(calls++===cut)throw new Error('cut');const event=base.append(...args);await flush(session);return event}}
    const ops=['a','b','c'].flatMap(id=>appendStep({}, {rows:[user(id,id)]}))
    await assert.rejects(runTransaction(adapter,{expectedHead:-1,operationId:'persist',ops}),/cut/)
    await handle.close()
    handle=await persistence.open(session.id,'write')
    const read=await handle.read()
    assert.equal(read.events.length,cut)
    const restored=Session.fromRestore(session.id,structuredClone(read.events),structuredClone(handle.header),handle.inheritedEventCount,'detached')
    durable=read.events.length
    const fold=await recoverTransaction(createConversationAlgebraHostAdapter(restored,{flush}))
    assert.deepEqual(fold.rows.map(row=>row.data.id),['a','b','c'])
    await handle.close()
    handle=await persistence.open(session.id,'read')
    assert.equal((await handle.read()).events.length,restored.snapshotEvents().length)
  } finally {
    await handle?.close()
    await persistence.flush()
  }
})
