import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { clearFailedTurnSurface } from '../../tavern-plugin/lib/domain/rollback-surface.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoundHistory } from '../../tavern-plugin/lib/domain/round-history.js'
import { createStoryTimeline } from '../../tavern-plugin/lib/domain/story-timeline.js'
import { createChatPersistence } from '../../tavern-plugin/lib/domain/chat-persistence.js'
import { createChatJournalStore } from '../../tavern-plugin/lib/domain/chat-journal-store.js'
import { createMvuDiagnosticStore, createMvuDiagnosticExport } from '../../tavern-plugin/lib/domain/mvu-diagnostics.js'
import { Session } from '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createConversationHistory } from '../../tavern-plugin/lib/domain/conversation-algebra-history.js'
import { computeFold } from '../../tavern-plugin/lib/domain/conversation-algebra/index.js'
import { appendSessionEvent, sessionEvents } from '../../tavern-plugin/lib/domain/session-events.js'

function harness({ checkpoint = false, mode = 'story', journal = false } = {}) {
  const calls = [], revisions = new Map()
  let counter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++counter) })
  let chat = { id: 'chat', sessionId: 'session', mode, _storageRevision: 1, messages: [{ role: 'assistant', greeting: true, text: '开场', turn: 1 }], posture: '门外', scriptState: { cursor: 0 }, settleStatus: 'done' }
  const pair = [{ role: 'user', text: '推门' }, { role: 'assistant', turn: 2, text: '旧正文', sourceText: '旧正文', swipes: ['旧正文'], swipeId: 0, variables: [{ hp: 8 }] }]
  if (checkpoint) {
    revisions.set(1, structuredClone(chat))
    const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 2, userText: '推门' } })
    chat = timeline.complete({ chat: begun.chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' }, apply(draft) { draft.messages.push(...pair); draft.posture = '门内' } }).chat
    const settlement = timeline.apply({ chat, intent: { kind: 'agent.begin', role: 'settlement' } })
    chat = timeline.complete({ chat: settlement.chat, operationId: settlement.value.operationId, basedOn: settlement.value.basedOn, outcome: { status: 'success' } }).chat
    if (journal) chat._storageRevision = 2
  } else chat.messages.push(...pair)
  const model = { kind: 'model', provider: 'fixture', model: 'fixture' }
  const events = [
    { seq: 0, type: 'user/message', data: { turn: 2, role: 'user', content: [{ type: 'text', text: '推门' }] } },
    { seq: 1, type: 'assistant/message', data: { turn: 2, step: 1, message: { role: 'assistant', source: model, content: [{ type: 'text', text: '旧正文' }] } } }
  ]
  const session=Session.create('session')
  appendSessionEvent(session,'user/message',{id:'input',role:'user',source:{kind:'user'},content:[{type:'text',text:'推门'}]},{surfaceOp:'append'})
  appendSessionEvent(session,'assistant/message',{turn:2,step:1,message:{id:'reply',role:'assistant',source:model,content:[{type:'text',text:'旧正文'}]}},{surfaceOp:'append'})
  let generation = 'success', settlementOutcome = 'success', beforeGenerate = () => {}
  const agent = { session, phase: { lastTurn: 2 }, followup(message) { calls.push('followup'); agent.input = message }, async whenIdle() {
    await beforeGenerate()
    if (generation === 'throw') throw new Error('fixture generation failed')
    const turn = ++agent.phase.lastTurn
    if (generation === 'missing') return
    const text = generation === 'empty' ? '' : '新正文' + turn
    const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText: agent.input.content[0].text } })
    revisions.set(chat._storageRevision, structuredClone(chat))
    chat = timeline.complete({ chat: begun.chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' }, apply(draft) {
      draft.messages.push({ role: 'user', text: agent.input.content[0].text }, { role: 'assistant', turn, text, sourceText: text, variables: [{ hp: 7 }] })
    } }).chat
    session.append('user/message', { ...agent.input, turn }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn, step: 1, message: { role: 'assistant', source: model, content: [{ type: 'text', text }] } }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  } }
  const chats = {
    read: async () => structuredClone(chat), forSession: async () => structuredClone(chat), readCard: async () => ({ name: '角色' }),
    readRevision: async (_id, revision) => { calls.push('readRevision'); return revisions.get(revision) },
    write: async (value, metadata) => { calls.push(metadata.source); chat = structuredClone(value); return structuredClone(chat) },
    update: async (_id, mutate, metadata) => { calls.push(metadata.source); const revision = chat._storageRevision; if (journal) revisions.set(revision, structuredClone(chat)); chat = await mutate(structuredClone(chat)) ?? chat; if (journal) chat._storageRevision = revision + 1; return structuredClone(chat) }
  }
  const options = { chats, sessions: { get: () => agent }, timeline, scripts: {
    read: async () => ({ chunks: ['一', '二'] }), continuity: { transition: () => { calls.push('script.restore'); return { state: { cursor: 0 } } } },
    dispatchEvent: async event => { calls.push(event.name) }
  }, queueSettlement: async () => {
    calls.push('settlement')
    const settlement = timeline.apply({ chat, intent: { kind: 'agent.begin', role: 'settlement' } })
    chat = timeline.complete({
      chat: settlement.chat,
      operationId: settlement.value.operationId,
      basedOn: settlement.value.basedOn,
      outcome: { status: settlementOutcome === 'failure' ? 'failure' : 'success' },
      apply(draft) { draft.settleStatus = 'done' }
    }).chat
    if (settlementOutcome === 'failure') {
      chat.settleStatus = 'failed'
      chat.settleError = '后台结算尚未完成'
    }
  }, present: async value => structuredClone(value) }
  options.sessions.flush=async()=>{}
  options.algebraHistory={...createConversationHistory({chats,flush:options.sessions.flush}),enabled:()=>true}
  return { create: () => createRoundHistory(options), options, calls, session, agent, timeline, get chat() { return chat },
    setGeneration(value) { generation = value }, setSettlement(value) { settlementOutcome = value }, beforeGenerate(fn) { beforeGenerate = fn }, revisions }
}




test('product rollback saves a branch and clears only the last round via checkout',async()=>{
 const h=harness({checkpoint:true,journal:true});await h.create().rollback('session','chat',2)
 assert.equal(h.chat.messages.length,1)
 assert.equal(h.chat.branchRegistry.branches.length,1)
 assert.ok(h.chat.rollbackUndo.foreground.algebraBranchId)
 assert.equal(h.chat.conversationHistoryIntent,undefined)
 assert.equal(computeFold(h.session.snapshotEvents()).rows.length,0)
})

test('product undo returns to the saved branch without appending duplicate player input',async()=>{
 const {prepareExpandedPatch}=await import('../../tavern-plugin/lib/domain/host-session-patch.js')
 const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
 try{
  const h=harness({checkpoint:true,journal:true}),history=h.create()
  await history.rollback('session','chat',2)
  await history.undoRollback('session','chat')
  assert.equal(h.chat.messages.length,3)
  assert.equal(h.chat.branchRegistry.branches.length,2)
  assert.deepEqual(computeFold(h.session.snapshotEvents()).rows.map(e=>(e.data.message??e.data).id),['input','reply'])
  assert.equal(h.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id==='input'&&e.surfaceOp==='append').length,1)
 }finally{patch.dispose()}
})

test('rollback native flush failure keeps durable intent and recovers rather than reverting Chat',async()=>{
 const h=harness({checkpoint:true,journal:true});let broken=true
 const flush=async()=>{if(broken)throw new Error('disk unavailable')}
 h.options.algebraHistory={...createConversationHistory({chats:h.options.chats,flush}),enabled:()=>true}
 const history=h.create()
 await assert.rejects(history.rollback('session','chat',2),/恢复意图已保留/)
 assert.equal(h.chat.messages.length,1);assert.ok(h.chat.conversationHistoryIntent)
 broken=false;await h.options.algebraHistory.recover(h.session,'chat')
 assert.equal(h.chat.conversationHistoryIntent,undefined);assert.equal(h.chat.branchRegistry.branches.length,1)
})

test('rollback preflight rejection leaves Chat and Session untouched',async()=>{
 const h=harness({checkpoint:true,journal:true}),before=structuredClone(h.chat),events=structuredClone(h.session.snapshotEvents())
 h.options.algebraHistory.prepare=async()=>{throw new Error('preflight denied')}
 await assert.rejects(h.create().rollback('session','chat',2),/preflight denied/)
 assert.deepEqual(h.chat,before);assert.deepEqual(h.session.snapshotEvents(),events)
})

test('foreground rollback recovered after flush failure still provides a usable undo branch',async()=>{
 const {prepareExpandedPatch}=await import('../../tavern-plugin/lib/domain/host-session-patch.js')
 const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
 try {
  const h=harness({checkpoint:true,journal:true});let broken=true
  const flush=async()=>{if(broken)throw new Error('disk unavailable')}
  h.options.algebraHistory={...createConversationHistory({chats:h.options.chats,flush}),enabled:()=>true}
  await assert.rejects(h.create().rollback('session','chat',2),/恢复意图已保留/)
  broken=false;await h.options.algebraHistory.recover(h.session,'chat')
  await h.create().undoRollback('session','chat')
  assert.equal(h.chat.messages.length,3);assert.equal(h.chat.conversationHistoryIntent,undefined)
 }finally{patch.dispose()}
})

test('product failed regenerate restores edited prose and archives the aborted attempt',async()=>{
 const {prepareExpandedPatch}=await import('../../tavern-plugin/lib/domain/host-session-patch.js')
 const patch=await prepareExpandedPatch('/home/claw/workspace/dsh-tarvern/runtime/lib',{version:'0.1.5-rc.2'})
 try{
  const h=harness({checkpoint:true,journal:true}),before=structuredClone(h.chat)
  h.beforeGenerate(()=>{
    const turn=3
    h.session.append('turn/start',{turn})
    appendSessionEvent(h.session,'user/message',h.agent.input,{surfaceOp:'append'})
    appendSessionEvent(h.session,'assistant/message',{turn,step:1,message:{id:'failed-partial',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'半截新正文'}]}},{surfaceOp:'append'})
    h.session.append('turn/end',{turn,reason:{kind:'aborted'}})
  })
  h.setGeneration('throw')
  const history=h.create()
  await assert.rejects(history.regenerate('chat','意见','session'),/fixture generation failed/)
  assert.deepEqual(h.chat.messages,before.messages)
  assert.equal(h.chat.regenRecovery,undefined)
  assert.equal(h.chat.branchRegistry.branches.length,1)
  assert.deepEqual(computeFold(h.session.snapshotEvents()).rows.map(e=>(e.data.message??e.data).content[0].text),['推门','旧正文'])
 }finally{patch.dispose()}
})
