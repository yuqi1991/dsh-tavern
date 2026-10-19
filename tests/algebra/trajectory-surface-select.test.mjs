import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

// Real host Trajectory Definitions and snapshot builder, plus Tavern's overlay.
const root = '/home/claw/workspace/dsh-tarvern/runtime/lib/node_modules/@deepseek-ai/'
function region(s, name) { const start = s.indexOf('//#region ' + name); assert.ok(start >= 0, name); return s.slice(start, s.indexOf('//#endregion', start)) }
function fixture() {
  const c = readFileSync(root + 'dsh-client-ui-conversation/lib/client.js', 'utf8'), t = readFileSync(root + 'dsh-client-ui-trajectory/lib/client.js', 'utf8')
  const ctx = vm.createContext({ _deepseek_ai_dsh_client_store: { notifySubscribers() {} }, require: () => ({ ConversationNodeAssembler: ctx.ConversationNodeAssembler }) })
  for (const name of ['lib/types/client/contract/request-inspection.js', '../../core/session/src/surface.ts', 'lib/types/client/contract/system-prompt.js', 'lib/types/client/contract/conversation.js', 'lib/types/client/conversation/location-index.js', 'lib/types/client/conversation/assembler.js']) vm.runInContext(region(c, name), ctx)
  for (const name of ['lib/types/client/locales.js', 'lib/types/client/trajectory-definition-common.js', 'lib/types/client/trajectory-event-projection.js', 'lib/types/client/trajectory-assistant-definition.js', 'lib/types/client/trajectory-message-definitions.js', 'lib/types/client/trajectory-snapshot-builder.js']) vm.runInContext(region(t, name), ctx)
  vm.runInContext(readFileSync(new URL('../../tavern-plugin/src/client/modules/trajectory-surface-view.js', import.meta.url), 'utf8'), ctx)
  return vm.runInContext(`new ConversationNodeAssembler({entries:()=>[trajectoryInboxDefinition,trajectoryMessageDefinition,trajectoryAssistantDefinition,tavernSurfaceSelectTrajectoryDefinition()],fallbackEntry:()=>undefined},{entries:()=>[trajectoryViewDefinition]})`, ctx)
}
const user = (seq, id, surfaceOp = 'append') => ({ type: 'event', event: { seq, time: 1, type: 'user/message', data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] }, surfaceOp } })
const select = (seq, nodes) => ({ type: 'event', event: { seq, time: 1, type: 'dsh-tavern/surface-select', data: { version: 1, nodes, source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'surface-select' } } } })
function visible(a) {
  const builder = a.views.get('trajectory').builder
  return [...builder.replace({ nodes: [...builder.nodes.values()] }).eventNodes].map(row => row.seq)
}

test('trajectory follows a surface selection back to an earlier variant', () => {
  const a = fixture()
  // input, variant A, then variant B replaces A; the selection returns to A.
  a.replaceWindow([user(0, 'input'), user(1, 'variantA'), user(2, 'variantB', { op: 'replace', startSeq: 1, endSeq: 1 })], false)
  a.activateTarget('trajectory'); a.flush()
  assert.deepEqual(visible(a), [0, 2])
  a.append(select(3, [0, 1])); a.flush()
  assert.deepEqual(visible(a), [0, 1], 'the selection row itself stays hidden')
  a.append(user(4, 'next')); a.flush()
  assert.deepEqual(visible(a), [0, 1, 4])
  a.append(select(5, [0, 2])); a.flush()
  assert.deepEqual(visible(a), [0, 2])
})

const MODEL = { kind: 'model', provider: 'fixture', model: 'fixture' }
const stepStart = (seq, turn) => ({ type: 'event', event: { seq, time: 1, type: 'step/start', data: { turn, step: 1 } } })
const reply = (seq, turn, text, surfaceOp = 'append', sourceEventSeqs) => ({ type: 'event', event: { seq, time: 1, type: 'assistant/message',
  data: { turn, step: 1, stream: [], message: { id: 'm' + seq, role: 'assistant', source: MODEL, content: [{ type: 'text', text }] } }, surfaceOp, ...(sourceEventSeqs ? { sourceEventSeqs } : {}) } })

test('a legacy verbatim copy shows the selected reply it duplicates', () => {
  const a = fixture()
  // The host keeps one row per turn:step showing the newest reply (the copy
  // at 5). The selection names the original at 2; their content is equal.
  a.replaceWindow([user(0, 'input'), stepStart(1, 1), reply(2, 1, 'variant A'), stepStart(3, 2), reply(4, 2, 'variant B'),
    reply(5, 1, 'variant A', { op: 'replace', startSeq: 4, endSeq: 4 }, [4, 2]), select(6, [0, 4])], false)
  a.activateTarget('trajectory'); a.flush()
  assert.deepEqual(visible(a), [0, 4])
  a.append(select(7, [0, 2])); a.flush()
  assert.deepEqual(visible(a), [0, 5], 'the copy row stands in for the selected original')
})
