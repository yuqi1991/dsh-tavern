import assert from 'node:assert/strict'
import test from 'node:test'
import {
  injectScaffoldingProbe, inspectPromptAssembly,
  inspectScaffoldingRequest, renderScaffoldingProbe
} from '../../tavern-plugin/lib/domain/scaffolding-injection-experiment.js'
import {
  createCompatibilityOrchestrationStrategy,
  createForegroundOrchestrationStrategies,
  createNativePlayOrchestrationStrategy
} from '../../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { presentTavernSettings } from '../../tavern-plugin/lib/domain/tavern-settings.js'

test('B-1 enumerates the complete PromptAssembly face and injects at contexts tail', () => {
  const assembly = { sections: [], contexts: [{ name: 'existing', text: 'existing' }], tools: [], variables: {} }
  assert.deepEqual(inspectPromptAssembly(assembly), { contexts: 'array', sections: 'array', tools: 'array', variables: 'object' })
  const record = injectScaffoldingProbe(assembly)
  assert.equal(record.position, 'contexts-tail')
  assert.equal(assembly.contexts[0].name, 'existing')
  assert.deepEqual(assembly.contexts.slice(1).map(entry => entry.name), [
    'tavern:scaffolding-experiment:worldbook-snapshot',
    'tavern:scaffolding-experiment:skill-catalog',
    'tavern:scaffolding-experiment:writing-skill-reminder'
  ])
})

test('B-2 injection record identifies the exact host runtime-context request row', () => {
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const record = injectScaffoldingProbe(assembly)
  const request = [{ id: 'context', role: 'user', content: [{ type: 'text', text: renderScaffoldingProbe(record) }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }]
  assert.deepEqual(inspectScaffoldingRequest(request, record), { expected: request[0].content[0].text, matches: 1, positions: [0], exact: true })
})

function strategy(enabled) {
  return createForegroundOrchestrationStrategies({
    scaffoldingInjectionExperiment: () => enabled,
    compatibility: {},
    nativePlay: {
      modeFor: async () => 'story',
      visibleTools: async () => [],
      controlledToolNames: new Set(),
      workspaceContext: () => ''
    }
  })
}

test('experiment flag defaults off and leaves the existing assembly path unchanged', async () => {
  assert.equal(presentTavernSettings({}, {}).scaffoldingInjectionExperiment, false)
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  await strategy(false).assembleSystemPrompt(assembly, { sessionId: 's', chat: {}, fixedSystemSections: [] })
  assert.deepEqual(assembly.contexts, [])
})

test('enabled native strategy appends only the isolated B probe contexts', async () => {
  const assembly = { sections: [], contexts: [{ name: 'existing', text: 'existing' }], tools: [], variables: {} }
  await strategy(true).assembleSystemPrompt(assembly, { sessionId: 's', chat: {}, fixedSystemSections: [] })
  assert.equal(assembly.contexts.length, 4)
  assert.equal(assembly.contexts[0].name, 'existing')
})

test('enabled compatibility strategy uses the same isolated B probe', async () => {
  const assembly = { sections: [{ name: 'host', text: 'host' }], contexts: [{ name: 'host', text: 'host' }], tools: [], variables: {} }
  await strategy(true).assembleSystemPrompt(assembly, { sessionId: 's', chat: { requestMode: 'sillytavern' } })
  assert.equal(assembly.sections.length, 0)
  assert.equal(assembly.contexts.length, 3)
  assert.ok(assembly.contexts.every(entry => entry.name.startsWith('tavern:scaffolding-experiment:')))
})

test('B-1 fails: compatibility preparation discards the host runtime-context message', async () => {
  const player = { id: 'player', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }
  const runtimeContext = { id: 'context', role: 'user', content: [{ type: 'text', text: '[DSH Tavern B-1 probe: worldbook-snapshot]' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }
  const compatibility = createCompatibilityOrchestrationStrategy({
    beforeTurn: async () => {},
    beginTurn: async () => ({}),
    chatForSession: async () => ({ runtimeInputs: {} }),
    compileTurn: async () => ({ messages: [] }),
    persistCompiled: async () => {},
    projectMessages: () => []
  })
  const decision = await compatibility.prepareStep({
    sessionId: 's', chat: {}, requestId: 'r',
    payload: { turn: 1, step: 1, messages: [player] },
    decision: { kind: 'enter', messages: [player, runtimeContext] }
  })
  assert.deepEqual(decision.messages, [player])
})

test('B-1 fails: native preparation retains context, which the host commits as a session row', async () => {
  const runtimeContext = { id: 'context', role: 'user', content: [{ type: 'text', text: '[DSH Tavern B-1 probe: worldbook-snapshot]' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }
  const native = createNativePlayOrchestrationStrategy({
    modeFor: async () => 'story',
    resolvePreset: async () => null,
    visibleTools: async () => [],
    controlledToolNames: new Set(),
    workspaceContext: () => ''
  })
  const decision = await native.prepareStep({
    sessionId: 's', chat: {}, requestId: 'r',
    payload: { turn: 1, step: 2, messages: [], agent: {} },
    decision: { kind: 'enter', messages: [runtimeContext] }
  })
  assert.deepEqual(decision.messages, [runtimeContext])
})
