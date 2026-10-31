import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTavernSkillProvider } from '../tavern-plugin/lib/domain/tavern-skill-provider.js'
import { createNativePlayOrchestrationStrategy } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { createForegroundFrameSessionAdapter } from '../tavern-plugin/lib/domain/foreground-frame-session-adapter.js'

// The native registry, catalog publisher, session history, tool executor and
// request assembly are real. Only skill storage and the model are fixtures.
test('writing skill switches append effective policy without changing cached messages or tools', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  const bootUrl = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(bootUrl.href)
  const { LlmAdapter } = await import(new URL('../../dsh-llm/lib/index.js', bootUrl))
  const root = await mkdtemp(join(tmpdir(), 'tavern-skill-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = ['dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-token-meter', 'dsh-commands', 'dsh-agent-loop', 'dsh-skill', 'dsh-working-directory', 'dsh-tool-skill']
  const config = join(root, 'host.yml')
  await writeFile(config, packages.map(name => '- id: ' + name + '\n  name: ' + new URL('../../' + name + '/lib/index.js', bootUrl).href + '\n').join(''))
  const ctx = await boot('tavern-skill-cache', config)
  t.after(() => ctx.fiber.dispose())
  ctx.baseUrl = bootUrl.href
  // DSH 0.2.1 的 skill 工具依赖 workingDirectory 服务；技能存储本身是夹具，只需固定工作目录。
  ctx.provide('workingDirectory', { ensure: async () => root })
  const skill = { name: 'scene-writing', source: '/fixture/scene-writing/SKILL.md', path: '/fixture/scene-writing/SKILL.md', rank: 1, description: 'Write a scene', content: 'WRITING_BODY: use short sentences.', agents: ['foreground'], modelInvocable: true, userInvocable: true }
  const disabled = new Set()
  let invalidate, pendingBlock, afterRequest
  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    return createTavernSkillProvider({
      providers: [{ list: async () => [skill], get: async () => skill }],
      library: { read: async () => skill }, roleFor: async () => 'foreground',
      enabledFor: async (_skill, scope) => !disabled.has(scope.session.id)
    })
  })
  const frameAdapter = createForegroundFrameSessionAdapter()
  const strategy = createNativePlayOrchestrationStrategy({
    modeFor: async () => 'story',
    resolvePreset: async () => null,
    prepareTurn: async ({ userText }) => ({ frame: { kind: 'foreground', frameId: 'fixture', chatId: 'chat', branchId: 'branch', operationId: 'operation', turn: 1, userInput: { projectedText: userText }, contributions: [] } }),
    appendFrame: frameAdapter.append, recordFrame() {}
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    return decision.kind === 'reject' ? decision : strategy.prepareStep({
      payload, decision, sessionId: payload.agent.session.id,
      chat: { disabledWritingSkills: disabled.has(payload.agent.session.id) ? ['scene-writing'] : [] }
    })
  }, { prepend: true })
  const requests = []
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 32000 } } }
    async *stream(input) {
      requests.push(structuredClone({ messages: input.messages, tools: input.tools, system: input.system }))
      const block = pendingBlock || { type: 'text', text: '故事继续。' }
      pendingBlock = undefined
      const action = afterRequest; afterRequest = undefined
      await action?.()
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Model())
  const handle = await ctx.agents.create({ sessionId: 'story', agentOptions: { provider: 'fixture', model: 'text' } })
  t.after(() => handle.dispose())
  let call = 0
  const load = () => ({ type: 'tool-call', id: 'load-' + (++call), name: 'skill', arguments: '{"name":"scene-writing"}' })
  const switchSkill = enabled => { if (enabled) disabled.delete('story'); else disabled.add('story'); invalidate() }
  async function send(block) {
    pendingBlock = block
    handle.agent.followup({ id: 'user-' + requests.length, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续故事。' }] })
    await handle.agent.whenIdle()
    assert.deepEqual(errors, [])
  }
  await send(load())
  assert.equal(requests.length, 2)
  assert.match(JSON.stringify(requests.at(-1).messages), /WRITING_BODY/)
  const before = structuredClone(handle.agent.session.deriveMessages())
  switchSkill(false)
  await send(load()) // A stale model call must be denied, too.
  assert.equal(requests.length, 4)
  const off = requests[2]
  assert.deepEqual(off.messages.slice(0, requests[1].messages.length), requests[1].messages)
  assert.deepEqual(handle.agent.session.deriveMessages().slice(0, before.length), before)
  const catalog = off.messages.filter(message => message.source?.kind === 'skill-catalog').at(-1)
  assert.deepEqual(catalog.source.entries, [])
  const policy = off.messages.filter(message => message.source?.form === 'writing-skill-reminder').at(-1)
  assert.deepEqual(policy?.source.disabledWritingSkills, ['scene-writing'])
  assert.match(JSON.stringify(policy.content), /本局停用.*scene-writing.*不要装载或遵循/)
  assert.match(JSON.stringify(requests[3].messages.slice(off.messages.length)), /unknown or no longer available/)
  switchSkill(true)
  await send(load())
  assert.equal(requests.length, 6)
  assert.deepEqual(requests[4].messages.filter(message => message.source?.kind === 'skill-catalog').at(-1).source.entries.map(entry => entry.name), ['scene-writing'])
  assert.match(JSON.stringify(requests[5].messages.slice(requests[4].messages.length)), /WRITING_BODY/)
  await send()
  assert.equal(requests[6].messages.filter(message => message.source?.kind === 'skill-catalog').length, 3, 'unchanged settings do not republish the catalog')
  const lastReminder = requests[6].messages.filter(message => message.source?.form === 'writing-skill-reminder').at(-1)
  assert.equal(lastReminder.source.disabledWritingSkills, undefined, 're-enabled skills are no longer listed as disabled')
  assert.doesNotMatch(JSON.stringify(lastReminder.content), /本局停用/)
  // Switching while a request is in flight must gate its stale tool call and
  // publish the new catalog before the next model request in the same turn.
  afterRequest = () => switchSkill(false)
  await send(load())
  assert.equal(requests.length, 9)
  assert.deepEqual(requests[8].messages.filter(message => message.source?.kind === 'skill-catalog').at(-1).source.entries, [])
  assert.match(JSON.stringify(requests[8].messages.slice(requests[7].messages.length)), /unknown or no longer available/)
  for (let i = 1; i < requests.length; i++) {
    assert.deepEqual(requests[i].tools, requests[0].tools, 'tool schemas stay fixed, including when all skills are off')
    assert.equal(requests[i].system, requests[0].system)
    assert.deepEqual(requests[i].messages.slice(0, requests[i - 1].messages.length), requests[i - 1].messages, 'every model request preserves the preceding request prefix')
  }
})
