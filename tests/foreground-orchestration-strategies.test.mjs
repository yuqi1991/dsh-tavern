import assert from 'node:assert/strict'
import test from 'node:test'

import { Session } from './fixtures/dsh-session-host.mjs'
import { sessionEvents } from '../tavern-plugin/lib/domain/session-events.js'
import { createForegroundOrchestrationStrategies, createNativePlayOrchestrationStrategy, createCompatibilityOrchestrationStrategy, projectRegenerationRequestMessages, projectContextSystemRoles } from '../tavern-plugin/lib/domain/foreground-orchestration-strategies.js'
import { ensureSessionStablePrefix, sessionStablePrefixSections } from '../tavern-plugin/lib/domain/session-stable-prefix.js'
import { ensureSessionSeedTrajectory } from '../tavern-plugin/lib/domain/session-seed-trajectory.js'

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function pluginMessage(role, text, plugin, form) {
  return { role, content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, ...(form ? { form } : {}) } }
}

function strategies(overrides = {}) {
  const calls = []
  const chats = new Map([['native', { id: 'native', requestMode: 'dsh', mode: 'story' }], ['compat', { id: 'compat', requestMode: 'sillytavern', mode: 'story' }]])
  const options = {
    compatibility: {
      async beforeTurn(input) { calls.push(['compat.before', input.userText]) },
      async beginTurn(input) { calls.push(['compat.begin', input.turn, input.requestId]) },
      async chatForSession(sessionId) { return chats.get(sessionId) },
      async compileTurn(_chat, userText) { calls.push(['compat.compile', userText]); return { messages: [{ role: 'system', content: 'compat' }] } },
      async persistCompiled(input) { calls.push(['compat.persist', input.turn]) },
      projectMessages(compiled) { return compiled.messages.map(function (message) { return { role: message.role, content: [{ type: 'text', text: message.content }] } }) }
    },
    nativePlay: {
      async modeFor() { return 'story' },
      filterMessages(messages) { return messages },
      async resolvePreset() { return { front: { text: 'preset' } } },
      async synchronizeTail(input) { calls.push(['native.sync', input.sessionId]) },
      async prepareTurn(input) {
        calls.push(['native.prepare', input.userText, input.requestId])
        return { frame: { frameId: 'frame-1', branchId: 'b', basedOnRevision: 1, source: {}, userInput: { projectedText: 'projected' } } }
      },
      appendFrame(input) { return { messages: input.messages.concat([{ role: 'user', content: [{ type: 'text', text: 'frame' }] }]), receipt: { appended: true } } },
      recordFrame(_sessionId, frame) { calls.push(['native.frame', frame.frameId]) },
      async visibleTools() { return [] },
      modePrompt() { return 'play' },
      workspaceContext() { return '' },
      async ensureSessionPrefix() {},
      controlledToolNames: new Set(['bash'])
    },
    ...overrides
  }
  return { value: createForegroundOrchestrationStrategies(options), compatibility: createCompatibilityOrchestrationStrategy(options.compatibility), calls, chats }
}

test('正式编排为兼容对话选择 SillyTavern 编译策略', async () => {
  const run = strategies()
  const chat = run.chats.get('compat')
  const payload = { turn: 3, step: 1, messages: [userMessage('继续')] }
  const prepared = await run.value.prepareStep({ chat, sessionId: 'compat', payload, decision: { kind: 'enter', messages: payload.messages }, requestId: 'compat-request' })
  assert.equal(prepared.messages, payload.messages)
  const projected = run.value.projectRequest({ sessionId: 'compat', messages: [] }, { turn: 3, step: 1 })
  assert.equal(projected.messages[0].content[0].text, 'compat')
  const assembly = await run.value.assembleSystemPrompt({ sections: [{}], contexts: [{}], tools: [] }, { chat, sessionId: 'compat' })
  assert.deepEqual(assembly.sections, [])
  assert.deepEqual(run.calls, [
    ['compat.before', '继续'], ['compat.begin', 3, 'compat-request'], ['compat.compile', '继续'], ['compat.persist', 3]
  ])
})

test('游玩固定背景来自原生系统装配，预设前后段保持顺序，快照不重复发送', async () => {
  const session = Session.create('native')
  const savedPrefixes = new Map()
  const storage = { async read(id) { return savedPrefixes.get(id) }, async write(id, value) { savedPrefixes.set(id, value) } }
  let cardText = '人物卡固定基本信息\n常驻世界书'
  await ensureSessionStablePrefix(session, cardText, storage)
  await ensureSessionSeedTrajectory(session)
  const run = strategies({ nativePlay: {
    async modeFor() { return 'story' },
    filterMessages(messages) { return messages },
    async resolvePreset() { return {
      front: { entries: [{ role: 'user', content: '预设前置指令' }] },
      back: { entries: [{ role: 'system', content: '预设后置指令' }] }
    } },
    async ensureSessionPrefix() { return await ensureSessionStablePrefix(session, cardText, storage) },
    async prepareTurn() { return { frame: { userInput: { projectedText: '本轮玩家输入' } } } },
    appendFrame(input) { return { messages: input.messages.concat([pluginMessage('user', '本轮动态指令', 'dsh-tavern', 'foreground-frame')]), receipt: {} } },
    recordFrame() {}, async visibleTools() { return [] },
    modePrompt() { return '正文任务' }, controlledToolNames: new Set()
  } })
  for (const turn of [2, 3]) {
    const incoming = [userMessage('新输入')]
    const prepared = await run.value.prepareStep({ sessionId: 'native', payload: { turn, step: 1, messages: incoming }, decision: { kind: 'enter', messages: incoming }, chat: run.chats.get('native') })
    const assembly = await run.value.assembleSystemPrompt({ sections: [], tools: [] }, { sessionId: 'native', chat: run.chats.get('native'), fixedSystemSections: sessionStablePrefixSections(session) })
    const system = assembly.sections.map(section => section.text).join('\n')
    assert.match(system, /人物卡固定基本信息/ )
    assert.deepEqual(prepared.messages.map(message => message.content[0].text), ['本轮玩家输入', '本轮动态指令'])
    assert.equal(prepared.messages.some(message => message.id === 'tavern-session-prefix:native'), false)
    const modelMessages = session.deriveMessages().concat(prepared.messages)
    assert.equal(modelMessages.filter(message => message.id === 'tavern-session-prefix:native').length, 1)
    assert.equal(modelMessages[0].source.form, 'snapshot')
    assert.equal(modelMessages[0].role, 'user', 'Session 权威历史保持原样')
    const request = run.value.projectRequest({ sessionId: 'native', system, messages: modelMessages })
    assert.deepEqual(request.messages.map(message => message.role), ['system', 'user', 'assistant', 'user'])
    assert.equal(request.messages[0].role, 'system', '预设前段与固定系统上下文按原顺序合并')
    assert.match(request.messages[0].content[0].text, /^预设前置指令\n\n人物卡固定基本信息/)
    assert.equal(request.messages.at(-1).role, 'user', '本轮指令和预设后段保持 user 语义')
    assert.match(request.messages.at(-1).content[0].text, /本轮动态指令\n\n预设后置指令$/)
    assert.notEqual(request.messages[0], modelMessages[0])
    assert.equal(modelMessages[0].role, 'user', '请求投影不得回写 Session 消息')
    assert.equal(modelMessages.at(-1).role, 'user', '本轮 Frame 在 Session 中仍保持原角色')
    assert.equal(run.value.projectRequest(request), null)
    cardText = '后续轮次不重新覆盖最初背景'
  }
  assert.equal(sessionEvents(session).filter(event => event.type === 'user/message' && event.data.id === 'tavern-session-prefix:native').length, 1)
  assert.equal(savedPrefixes.size, 0)
})

test('DeepSeek thinking 续传为旧 Session 的 reasoning 补齐可回放元数据', async () => {
  const run = strategies()
  const incoming = [userMessage('继续')]
  await run.value.prepareStep({
    sessionId: 'native', payload: { turn: 8, step: 1, messages: incoming },
    decision: { kind: 'enter', messages: incoming }, chat: run.chats.get('native')
  })
  const legacyAssistant = {
    role: 'assistant',
    content: [{ type: 'reasoning', text: '旧思考' }, { type: 'text', text: '旧正文' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  }
  const oldPresetBoundary = {
    role: 'system', content: [{ type: 'text', text: '旧预设边界' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', sections: [{ name: 'tavern:runtime-preset-front', text: '旧预设边界' }] }
  }
  const original = Object.freeze({
    sessionId: 'native', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
    messages: Object.freeze([oldPresetBoundary, legacyAssistant, userMessage('下一轮')])
  })

  const projected = run.value.projectRequest(original)
  const replay = projected.messages[0].source.replayState

  assert.equal(replay.response.kind, 'pi-ai')
  assert.equal(replay.response.provider, 'deepseek-official')
  assert.equal(replay.response.model, 'deepseek-v4-flash')
  assert.deepEqual(replay.blocks, [
    { type: 'reasoning', thinkingSignature: 'reasoning_content' },
    { type: 'text' }
  ])
  assert.equal(original.messages[0].source.replayState, undefined)
})

test('旧 Session 的 Tavern 开场白在请求边界恢复为合成模型来源，不触发 DeepSeek reasoning 续传校验', async () => {
  const run = strategies()
  const incoming = [userMessage('继续')]
  await run.value.prepareStep({
    sessionId: 'native', payload: { turn: 2, step: 1, messages: incoming },
    decision: { kind: 'enter', messages: incoming }, chat: run.chats.get('native')
  })
  const opening = {
    id: 'tavern-opening:legacy-chat', role: 'assistant',
    content: [{ type: 'text', text: '旧开场白' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  }
  const oldPresetBoundary = {
    role: 'system', content: [{ type: 'text', text: '旧预设边界' }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', sections: [{ name: 'tavern:runtime-preset-front', text: '旧预设边界' }] }
  }
  const original = Object.freeze({
    sessionId: 'native', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
    messages: Object.freeze([oldPresetBoundary, opening, userMessage('下一轮')])
  })

  const projected = run.value.projectRequest(original)
  const restored = projected.messages.find(message => message.id === opening.id)

  assert.deepEqual(restored.source, { kind: 'model', provider: 'dsh-tavern', model: 'character-card' })
  assert.equal(opening.source.kind, 'model')
})

test('DeepSeek thinking 请求为没有原始思考的合成 assistant 上下文补齐 reasoning_content 载体', async () => {
  const run = strategies()
  const incoming = [userMessage('继续')]
  await run.value.prepareStep({
    sessionId: 'native', payload: { turn: 2, step: 1, messages: incoming },
    decision: { kind: 'enter', messages: incoming }, chat: run.chats.get('native')
  })
  const preset = pluginMessage('assistant', '预置助手示例', 'dsh-tavern', 'snapshot')
  const opening = {
    id: 'tavern-opening:current', role: 'assistant', content: [{ type: 'text', text: '开场白' }],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  }
  const original = {
    sessionId: 'native', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
    messages: [{
      role: 'system', content: [{ type: 'text', text: '旧预设边界' }],
      source: { kind: 'plugin', plugin: 'dsh-tavern', sections: [{ name: 'tavern:runtime-preset-front', text: '旧预设边界' }] }
    }, preset, opening, userMessage('下一轮')]
  }

  const projected = run.value.projectRequest(original)
  const assistants = projected.messages.filter(message => message.role === 'assistant')

  // Runtime preset projection replaces stale preset-boundary messages. The
  // surviving opening is enough to prove the final DeepSeek serialization
  // boundary repairs every assistant message that will actually be sent.
  assert.equal(projected.messages.some(message => message.source?.form === 'snapshot' && message.role === 'system'), true)
  for (const message of assistants) {
    assert.equal(message.content.some(block => block.type === 'reasoning' && block.text.length > 0), true)
  }
  assert.equal(preset.content.some(block => block.type === 'reasoning'), false)
  assert.equal(opening.content.some(block => block.type === 'reasoning'), false)
})

test('插件上下文只在请求投影中升为 system，玩家输入保持 user', () => {
  const original = [userMessage('继续'), pluginMessage('user', '快照', 'dsh-tavern', 'worldbook-snapshot'),
    pluginMessage('user', '帧', 'dsh-tavern', 'foreground-frame')]
  const projected = projectContextSystemRoles(original)
  assert.deepEqual(projected.map(message => message.role), ['user', 'system', 'system'])
  assert.deepEqual(original.map(message => message.role), ['user', 'user', 'user'])
  assert.equal(projectContextSystemRoles(projected), projected)
})

test('带意见重生成只投影为本轮补充要求', () => {
  const messages = [
    userMessage('推门'),
    pluginMessage('user', '旧本轮规则', 'dsh-tavern', 'foreground-frame'),
    { role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: { kind: 'model' } },
    pluginMessage('user', '推门\n\n【本轮补充要求】\n写得短一些', 'dsh-tavern-regen'),
    pluginMessage('user', '新本轮规则', 'dsh-tavern', 'foreground-frame')
  ]

  const projected = projectRegenerationRequestMessages(messages)

  assert.equal(projected[0].content[0].text, '推门\n\n【本轮补充要求】\n写得短一些')
  assert.doesNotMatch(JSON.stringify(projected), /旧正文|重新生成|dsh-tavern-regen/)
})

test('兼容与普通游玩均清空独立系统提示，工具过滤不受影响', async () => {
  const run = strategies()
  const compatAssembly = await run.compatibility.assembleSystemPrompt({ sections: [{}], contexts: [{}], tools: [{ name: 'bash' }] }, { sessionId: 'compat', chat: run.chats.get('compat') })
  assert.deepEqual(compatAssembly, { sections: [], contexts: [], tools: [] })

  const nativeAssembly = await run.value.assembleSystemPrompt({ sections: [], contexts: [], tools: [{ name: 'bash' }, { name: 'read' }] }, { sessionId: 'native', chat: run.chats.get('native') })
  assert.deepEqual(nativeAssembly.sections, [])
  assert.deepEqual(nativeAssembly.tools.map(function (tool) { return tool.name }), ['read'])
})

test('兼容前台仅在游戏快照开启时保留联网搜索工具', async () => {
  const run = strategies()
  const chat = run.chats.get('compat')
  const tools = [{ name: 'bash' }, { name: 'web_search' }]
  const disabled = await run.compatibility.assembleSystemPrompt({ sections: [{ name: 'old' }], contexts: [{}], tools: tools.slice() }, { sessionId: 'compat', chat })
  assert.deepEqual(disabled.tools, [])

  chat.webSearchEnabled = true
  const enabled = await run.compatibility.assembleSystemPrompt({ sections: [{ name: 'old' }], contexts: [{}], tools: tools.slice() }, { sessionId: 'compat', chat })
  assert.deepEqual(enabled.tools.map(function (tool) { return tool.name }), ['web_search'])
})

test('卡片策略保留 Shell 与未知的通用基础工具，不要求先走 Tavern 专用工具', async () => {
  const run = strategies({
    nativePlay: {
      async modeFor() { return 'card' },
      filterMessages(messages) { return messages },
      async resolvePreset() { return null },
      async prepareTurn() { return { text: '' } },
      appendFrame(input) { return { messages: input.messages, receipt: {} } },
      recordFrame() {},
      async visibleTools() { return ['bash', 'tavern_read_card'] },
      modePrompt() { return 'card' },
      workspaceContext() { return '/resources' },
      async ensureSessionPrefix() {},
      controlledToolNames: new Set(['bash', 'tavern_read_card', 'tavern_update_card'])
    }
  })
  const assembly = await run.value.assembleSystemPrompt({
    sections: [],
    contexts: [],
    tools: [
      { name: 'bash' },
      { name: 'read_file' },
      { name: 'write_file' },
      { name: 'tavern_read_card' },
      { name: 'tavern_update_card' }
    ]
  }, { sessionId: 'native', chat: run.chats.get('native'), cwd: '/workspace' })

  assert.deepEqual(assembly.tools.map(function (tool) { return tool.name }), [
    'bash', 'read_file', 'write_file', 'tavern_read_card'
  ])
})

test('新版 DSH 文件工具只向卡片 Agent 开放，不泄漏给正文 Agent', async () => {
  async function assembledToolNames(mode) {
    const fileTools = ['read', 'write', 'edit', 'read_image']
    const run = strategies({
      nativePlay: {
        async modeFor() { return mode },
        filterMessages(messages) { return messages },
        async resolvePreset() { return null },
        async prepareTurn() { return { text: '' } },
        appendFrame(input) { return { messages: input.messages, receipt: {} } },
        recordFrame() {},
        async visibleTools() { return mode === 'card' ? fileTools : ['tavern_recall_history'] },
        modePrompt() { return mode },
        workspaceContext() { return '/resources' },
        async ensureSessionPrefix() {},
        controlledToolNames: new Set([...fileTools, 'tavern_recall_history'])
      }
    })
    const assembly = await run.value.assembleSystemPrompt({
      sections: [],
      contexts: [],
      tools: [...fileTools, 'tavern_recall_history'].map(function (name) { return { name } })
    }, { sessionId: 'native', chat: run.chats.get('native'), cwd: '/workspace' })
    return assembly.tools.map(function (tool) { return tool.name })
  }

  assert.deepEqual(await assembledToolNames('card'), ['read', 'write', 'edit', 'read_image'])
  assert.deepEqual(await assembledToolNames('story'), ['tavern_recall_history'])
})

test('失败清理与回退留下的空占位不进入提供商请求，工具消息保留', async () => {
  const run = strategies(), chat = run.chats.get('native')
  const payload = { turn: 8, step: 1, messages: [userMessage('继续')] }
  await run.value.prepareStep({ chat, sessionId: 'native', payload, decision: { kind: 'enter', messages: payload.messages }, requestId: 'retry' })
  const tool = { role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'lookup', arguments: {} }] }
  const input = [userMessage('上一轮'), { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-tavern-failed-turn-cleanup' } }, { role: 'assistant', content: [] }, userMessage('  '), tool, userMessage('继续')]
  const result = run.value.projectRequest({ sessionId: 'native', messages: input }, { turn: 8, step: 1 })
  assert.ok(result.messages.every(m => m.content.length && m.content.some(b => b.type !== 'text' || b.text.trim())))
  assert.ok(result.messages.includes(tool))
  assert.equal(input.length, 6)
  assert.equal(input[1].content.length, 0)
})

test('native preset macros render across phases before projection without rewriting snapshots or history', async () => {
  const raw = {
    front: { entries: [{ role: 'system', content: '{{setvar::style::温和}}{{//不发送}}{{trim}}风格：{{getvar::style}}；{{user}}与{{char}}' }] },
    middle: { entries: [{ role: 'system', content: '{{setvar::rule::慢慢来}}中段：{{getvar::style}}' }] },
    back: { entries: [{ role: 'user', content: '末尾：{{getvar::style}}，{{getvar::rule}}' }] }
  }
  const original = structuredClone(raw)
  let received
  const strategy = createNativePlayOrchestrationStrategy({
    modeFor: async () => 'story', filterMessages: x => x, resolvePreset: async () => raw,
    prepareTurn: async input => { received = input.runtimePresetSnapshot; return { frame: { userInput: { projectedText: input.userText } } } },
    appendFrame: ({ messages }) => ({ messages: messages.concat([userMessage(received.middle.entries[0].content)]), receipt: {} }),
    recordFrame() {}
  })
  const history = [pluginMessage('assistant', '历史里的 {{getvar::old}} 保持原样', 'history'), userMessage('继续')]
  const historyBefore = structuredClone(history)
  const input = { sessionId: 'macro-test', chat: { cardName: '掌柜', macroState: { userName: '游客', local: {}, global: {} } }, payload: { turn: 2, step: 1 }, decision: { messages: history } }
  const prepared = await strategy.prepareStep(input)
  const request = strategy.projectRequest({ sessionId: input.sessionId, messages: prepared.messages, tools: [] })
  const texts = request.messages.map(m => m.content.map(b => b.text).join(''))
  assert.match(texts[0], /风格：温和；游客与掌柜/)
  assert.equal(received.middle.entries[0].content, '中段：温和')
  assert.match(texts.at(-1), /末尾：温和，慢慢来/)
  assert.equal(texts[1], history[0].content[0].text)
  assert.deepEqual(raw, original)
  assert.deepEqual(history, historyBefore)
  assert.deepEqual(input.chat.macroState.local, {})
  const next = await strategy.prepareStep({ ...input, payload: { turn: 2, step: 2 } })
  const followup = strategy.projectRequest({ sessionId: input.sessionId, messages: next.messages })
  assert.equal(followup.messages[0].content[0].text, request.messages[0].content[0].text)
})

for (const sessionId of ['native', 'compat']) test('regeneration gates ordinary and stale inputs before preparation: '+sessionId,async()=>{
  const run=strategies();const chat=run.chats.get(sessionId)
  chat.regenInProgress=true;chat.regenRecovery={id:'current'}
  const input=message=>({chat,sessionId,payload:{turn:3,step:1,messages:[message]},decision:{kind:'enter',messages:[message]},requestId:'request'})
  await assert.rejects(run.value.prepareStep(input(userMessage('normal'))),/重新生成尚未完成/)
  const message=pluginMessage('user','retry','dsh-tavern-regen')
  message.source.regenerationId='stale'
  await assert.rejects(run.value.prepareStep(input(message)),/重新生成尚未完成/)
  assert.equal(run.calls.length,0)
  message.source.regenerationId='current'
  chat.regenRecovery.phase='committed'
  await assert.rejects(run.value.prepareStep(input(message)),/重新生成尚未完成/)
  delete chat.regenRecovery.phase
  await run.value.prepareStep(input(message))
  assert.ok(run.calls.length>0)
})

for (const text of ['', '请根据图片继续']) test(`前台投影保留图片：${text || '纯图片'}`, async () => {
  const image = { type: 'image', attachment: { id: 'image-test', mimeType: 'image/png' } }
  const messages = [{ ...userMessage(text), content: [...(text ? [{ type: 'text', text }] : []), image] }]
  const original = structuredClone(messages)
  const strategy = createNativePlayOrchestrationStrategy({
    modeFor: async () => 'story', filterMessages: value => value, resolvePreset: async () => null,
    prepareTurn: async ({ userText }) => ({ frame: { userInput: { projectedText: userText ? '处理后的文字' : '' } } }),
    appendFrame: ({ messages }) => ({ messages, receipt: {} }), recordFrame() {},
  })
  const result = await strategy.prepareStep({ sessionId: 'native', chat: {}, payload: { turn: 1, step: 1, messages }, decision: { messages } })
  assert.deepEqual(result.messages[0].content.filter(block => block.type === 'image'), [image])
  assert.equal(result.messages[0].content.some(block => block.text === '（玩家已更新酒馆运行状态）'), false)
  assert.deepEqual(messages, original)
})
