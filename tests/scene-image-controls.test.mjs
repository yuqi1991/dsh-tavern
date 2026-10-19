import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const extract = (name, next) => {
  const start = source.indexOf((name === 'sceneImagePurchaseConfirmation' ? 'async ' : '') + 'function ' + name + '(')
  return source.slice(start, source.indexOf('function ' + next + '(', start))
}

test('one repaint entry opens optional feedback; blank repaints and feedback adjusts without replacing old images', async () => {
  const slots = [], calls = []
  let cursor = 0, failure = false, requestId = 0
  const record = { key: 'turn-key', status: 'succeeded', enabled: true, versions: [{ id: 'old-picture' }] }
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {},
    React: {
      Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {},
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = v }] },
      useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } }
    },
    URLSearchParams, useSceneImageRecord: () => record,
    sceneImagePurchaseConfirmation: () => undefined, sceneImageRequestId: () => 'request-' + (++requestId),
    window: { dispatchEvent() {} }, CustomEvent: class {},
    rpc: async (method, args) => { calls.push({ method, args }); if (failure) throw new Error('connection lost') }
  })
  const Component = vm.runInContext(extract('SceneIllustration', 'register') + ';SceneIllustration', context)
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : []
  const render = () => { cursor = 0; return nodes(Component({ sessionId: 'session', turn: 1 })) }
  const button = label => render().find(n => n.type === 'button' && n.children.includes(label))
  assert.equal(button('调整'), undefined)
  await button('重画').props.onClick()
  assert.equal(calls.length, 0, 'opening the form must not generate')
  assert.equal(button('开始重画').props.disabled, false)
  render().find(n => n.type === 'textarea').props.onChange({ target: { value: '  ' } })
  await button('开始重画').props.onClick()
  assert.equal(calls[0].args.kind, 'repaint')
  assert.equal(calls[0].args.instruction, '')
  assert.equal(calls[0].args.versionId, 'old-picture')
  assert.equal(button('开始重画'), undefined)
  await button('重画').props.onClick()
  render().find(n => n.type === 'textarea').props.onChange({ target: { value: '改成雨夜' } })
  failure = true
  await button('开始重画').props.onClick()
  assert.equal(render().find(n => n.type === 'textarea').props.value, '改成雨夜', 'keep feedback after errors')
  failure = false
  await button('开始重画').props.onClick()
  assert.equal(calls[1].args.kind, 'adjust')
  assert.equal(calls[1].args.instruction, '改成雨夜')
  assert.equal(calls[1].args.requestId, calls[2].args.requestId, 'transport retry keeps its request identity')
  assert.deepEqual(record.versions, [{ id: 'old-picture' }])
  await button('重画').props.onClick()
  await button('取消').props.onClick()
  assert.equal(button('开始重画'), undefined)
  assert.equal(calls.length, 3)
})

test('image action is hidden until explicitly enabled, including loading and legacy settings', async () => {
  const slots = [], calls = []
  let cursor = 0
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {},
    React: {
      Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }),
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] },
      useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } }, useEffect() {}
    },
    sceneImageRequestId: () => "blocked-click",
    useSceneImageRecord: () => ({ key: 'turn', status: 'idle', versions: [] }),
    rpc: async (...args) => calls.push(args)
  })
  const Component = vm.runInContext(extract('SceneImageAction', 'SceneImageSettings') + ';SceneImageAction', context)
  const render = () => { cursor = 0; return Component({ sessionId: 'session', turn: 1 }) }
  render()
  for (const settings of [null, {}, { enabled: false, ready: false, migrationPending: true }, { enabled: false, ready: true }]) {
    slots[0] = settings
    assert.equal(render(), null, 'disabled or unknown settings leave no button or explanation')
  }
  for (const [settings, reason] of [
    [{ enabled: true, ready: false, migrationPending: true }, /迁移.*保存生图 API 配置/],
    [{ enabled: true, ready: false }, /配置未完成/]
  ]) {
    slots[0] = settings
    const view = render()
    assert.ok(view, 'enabled but incomplete configuration remains explainable')
    assert.equal(view.children[0].props.disabled, true)
    assert.match(view.children[1].children.join(''), reason)
    await view.children[0].props.onClick()
  }
  assert.equal(calls.length, 0)
  slots[0] = { enabled: true, ready: true }
  assert.equal(Boolean(render().children[0].props.disabled), false)
  slots[0] = { enabled: false, ready: true }
  assert.equal(render(), null, 'disabling again hides the entry')
})

test('scene request identifiers also work on LAN HTTP without crypto.randomUUID', () => {
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {}, window: {} })
  const make = vm.runInContext(extract('sceneImageRequestId', 'sceneImageStageLabel') + ';sceneImageRequestId', context)
  const ids = Array.from({ length: 1000 }, make)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every(id => /^[a-zA-Z0-9_-]{8,100}$/.test(id)))
})

test('main image action preserves request ID on ambiguous transport errors and cannot regenerate over existing versions', async () => {
  const slots = [], calls = []
  let cursor = 0, fail = true
  const record = { key: 'target-key', status: 'idle', versions: [] }
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {},
    React: {
      Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }),
      useState: initial => { const n = cursor++; if (!(n in slots)) slots[n] = initial; return [slots[n], value => { slots[n] = value }] },
      useRef: initial => { const n = cursor++; return slots[n] ||= { current: initial } },
      useEffect: () => {}
    },
    useSceneImageRecord: () => record, sceneImageStageLabel: () => 'working', sceneImagePurchaseConfirmation: () => undefined,
    window: { dispatchEvent() {} }, CustomEvent: class {},
    rpc: async (method, args) => { calls.push({ method, args }); if (fail) throw new Error('connection lost') }
  })
  const Component = vm.runInContext(extract('sceneImageRequestId', 'sceneImageStageLabel') + extract('SceneImageAction', 'SceneImageSettings') + ';SceneImageAction', context)
  function render() { cursor = 0; return Component({ sessionId: 'session', turn: 1, running: false }) }
  render(); slots[0] = { enabled: true, ready: true }
  await render().children[0].props.onClick()
  fail = false
  await render().children[0].props.onClick()
  assert.equal(calls[0].args.requestId, calls[1].args.requestId)
  assert.equal(calls[0].args.key, record.key)
  record.status = 'failed'; record.versions = [{ id: 'old-image' }]
  const button = render().children[0]
  assert.equal(button.props.disabled, true)
  await button.props.onClick()
  assert.equal(calls.length, 2)
  record.versions = []; record.recovery = 'save'
  const pending = render().children[0]
  assert.equal(pending.props.disabled, true)
  assert.ok(pending.children.includes('图片待保存'))
  await pending.props.onClick()
  assert.equal(calls.length, 2, 'must not send generation while bytes await saving')
  delete record.recovery; record.status = 'idle'
  fail = true; await render().children[0].props.onClick()
  const oldRequest = calls.at(-1).args.requestId
  // The request succeeded remotely, then its last picture was deleted elsewhere.
  record.requestId = oldRequest; record.hasDeletedImages = true
  fail = false; await render().children[0].props.onClick()
  assert.notEqual(calls.at(-1).args.requestId, oldRequest, 'deletion must not reuse the completed request')
})

test('received image can be saved from the renderer while generation is disabled', async () => {
  const slots = [], calls = []
  let cursor = 0
  const record = { key: 'frozen-key', requestId: 'original-image', status: 'failed', recovery: 'save', versions: [], enabled: false }
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {},
    React: { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {},
      useState(initial) { const n = cursor++; if (!(n in slots)) slots[n] = initial; return [slots[n], value => { slots[n] = value }] },
      useRef(initial) { const n = cursor++; return slots[n] ||= { current: initial } }
    },
    useSceneImageRecord: () => record, sceneImageStageLabel: () => 'working', window: { dispatchEvent() {} }, CustomEvent: class {},
    rpc: async (method, args) => { calls.push({ method, args }) }
  })
  const Component = vm.runInContext(extract('SceneIllustration', 'register') + ';SceneIllustration', context)
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : []
  const render = () => { cursor = 0; return nodes(Component({ sessionId: 'session', turn: 1 })) }
  const controls = render()
  assert.equal(controls.filter(node => node.type === 'button').length, 1)
  await controls.find(node => node.type === 'button' && node.children.includes('重试保存')).props.onClick()
  assert.equal(calls[0].method, 'retrySceneImageSave')
  assert.equal(calls[0].args.requestId, record.requestId)
  assert.equal(calls[0].args.key, record.key)
  record.status = 'running'; record.recovery = undefined
  const cancel = render().find(node => node.type === 'button' && node.children.includes('取消生图'))
  assert.ok(cancel, 'cancellation remains available with generation disabled')
  await cancel.props.onClick()
  assert.equal(calls[1].method, 'cancelSceneImage')
  assert.equal(calls[1].args.requestId, record.requestId)
})

test('uncertain purchase requires user confirmation, while original provider task queries do not', async () => {
  let accepts = false, prompts = 0
  const context = vm.createContext({})
  const purchase = vm.runInContext(extract('sceneImagePurchaseConfirmation', 'useSceneImageRecord') + ';sceneImagePurchaseConfirmation', context)
  const confirm = record => purchase(record, async text => { assert.match(text, /可能已经计费.*再次产生费用/); prompts++; return accepts })
  assert.equal(await confirm({ outcome: 'not_requested' }), undefined)
  assert.equal(await confirm({ outcome: 'rejected' }), undefined)
  assert.equal(await confirm({ outcome: 'unconfirmed', providerTask: { promptId: 'existing' } }), undefined)
  assert.equal(prompts, 0)
  assert.equal(await confirm({ outcome: 'unconfirmed', requestId: 'uncertain-original' }), false)
  accepts = true
  assert.equal(await confirm({ outcome: 'unconfirmed', requestId: 'uncertain-original' }), 'uncertain-original')
  assert.equal(prompts, 2)
})

test('reference chooser never preselects a group member, freezes consent and permits per-person revocation while disabled', async () => {
  const slots = [], calls = []
  let cursor = 0
  const record = { key: 'body', status: 'succeeded', enabled: true,
    reference: { supported: true, service: 'Gemini local test', gateway: 'gateway-a', bindings: [] },
    versions: [{ id: 'picture', referencePeople: [{ id: 'left-id', name: '同名', description: '左侧黑发' }, { id: 'right-id', name: '同名', description: '右侧红发' }] }] }
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {},
    React: { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {},
      useState(initial) { const n = cursor++; if (!(n in slots)) slots[n] = initial; return [slots[n], value => { slots[n] = value }] },
      useRef(initial) { const n = cursor++; return slots[n] ||= { current: initial } }
    },
    URLSearchParams, useSceneImageRecord: () => record, sceneImageStageLabel: () => '', window: { dispatchEvent() {}, confirm() { assert.fail('reference consent must be visible with the person chooser') } }, CustomEvent: class {},
    rpc: async (method, args) => { calls.push({ method, args }); record.reference.bindings = args.enabled ? [{ versionId: 'picture', personId: args.personId, name: '同名' }] : [] }
  })
  const Component = vm.runInContext(extract('SceneIllustration', 'register') + ';SceneIllustration', context)
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : []
  const render = () => { cursor = 0; return nodes(Component({ sessionId: 'session', turn: 1 })) }
  const button = name => render().find(node => node.type === 'button' && node.children.includes(name))
  const more = render().find(node => node.type === 'summary' && node.props?.['aria-label'] === '更多插图操作')
  assert.equal(more, undefined)
  assert.ok(!render().some(node => node.children?.some(text => ['⋯', '下载', '查看说明', '删除'].includes(text))))
  await button('用作造型参考').props.onClick()
  assert.equal(calls.length, 0)
  assert.equal(render().find(node => node.type === 'select').props.value, '')
  assert.equal(button('确认使用').props.disabled, true)
  assert.ok(render().some(node => node.type === 'p' && node.children[0].includes('整张图会发送给：Gemini local test')))
  assert.ok(render().some(node => node.type === 'option' && node.children[0].includes('右侧红发 · right-id')))
  render().find(node => node.type === 'select').props.onChange({ target: { value: 'right-id' } })
  assert.equal(button('确认使用').props.disabled, false)
  await button('确认使用').props.onClick()
  assert.equal(calls[0].method, 'setSceneImageReference')
  assert.equal(calls[0].args.personId, 'right-id')
  assert.equal(calls[0].args.consent, 'gateway-a')
  record.enabled = false; record.reference.supported = false
  await button('管理造型参考').props.onClick()
  assert.equal(button('确认使用'), undefined)
  await button('取消「同名」的参考').props.onClick()
  assert.equal(calls[1].args.personId, 'right-id')
  assert.equal(calls[1].args.enabled, false)
  assert.equal(button('用作造型参考'), undefined)
  record.enabled = true; record.reference.supported = true
  await button('用作造型参考').props.onClick()
  render().find(node => node.type === 'select').props.onChange({ target: { value: 'left-id' } })
  record.reference.gateway = 'gateway-b'; record.reference.service = 'another service'
  assert.equal(button('确认使用').props.disabled, true)
  assert.ok(render().some(node => node.type === 'p' && node.children[0].includes('渠道配置已变化')))
  await button('关闭参考设置').props.onClick()
  assert.equal(calls.length, 2)
  record.versions[0].referencePeople = [{ id: 'single-id', name: '单人' }]
  await button('用作造型参考').props.onClick()
  assert.equal(render().find(node => node.type === 'select').props.value, '', 'one identified candidate does not make a group image single-person')
  await button('关闭参考设置').props.onClick()
  record.versions[0].referenceSingle = true
  await button('用作造型参考').props.onClick()
  assert.equal(render().find(node => node.type === 'select').props.value, 'single-id')
  assert.equal(calls.length, 2, 'even a single person needs explicit confirmation')
  record.key = 'changed-body'
  assert.equal(button('确认使用'), undefined, 'a changed body cannot inherit an open consent draft')
})

test('image dock targets latest story turn even without a display projection or after rollback', () => {
  const expression = source.match(/const imageTurn = ([^;]+);/)[1]
  for (const [latestAssistantTurn, replyProjections] of [[4, []], [4, [{ turn: 2 }]], [2, [{ turn: 4 }]]]) {
    assert.equal(vm.runInNewContext(expression, { live: { view: { latestAssistantTurn, replyProjections } } }), latestAssistantTurn)
  }
})

test('delete selected image, handle cancellation/errors, then regenerate the empty historical turn', async () => {
  const slots = [], calls = []
  let cursor = 0, confirmed = false, failure = false, serial = 0
  const record = { key: 'historical-turn', status: 'succeeded', enabled: false, versions: [{ id: 'first' }, { id: 'second' }] }
  const context = vm.createContext({
    useTavernConfirm: () => async () => true,
    recordImageInteraction() {}, URLSearchParams, sceneImageStageLabel: () => '生成中',
    React: { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {},
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value }] },
      useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } } },
    useSceneImageRecord: () => record, sceneImagePurchaseConfirmation: () => undefined, sceneImageRequestId: () => 'new-request-' + (++serial),
    useTavernConfirm: () => async () => confirmed,
    window: { dispatchEvent() {} }, CustomEvent: class {},
    rpc: async (method, args, sessionId) => {
      calls.push({ method, args, sessionId })
      if (failure) throw Error('删除失败')
      if (method === 'removeSceneImage') { record.versions = record.versions.filter(v => v.id !== args.versionId); record.hasDeletedImages = true; record.status = record.versions.length ? 'succeeded' : 'idle' }
    }
  })
  const Component = vm.runInContext(extract('SceneIllustration', 'register') + ';SceneIllustration', context)
  const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] : []
  const render = () => { cursor = 0; return nodes(Component({ sessionId: 'session', turn: 3 })) }
  const button = label => render().find(n => n.type === 'button' && n.children.includes(label))
  await button('删除图片').props.onClick(); assert.equal(calls.length, 0)
  confirmed = true; record.status = 'running'; assert.equal(button('删除图片').props.disabled, true)
  record.status = 'succeeded'; record.recovery = 'save'; assert.equal(button('删除图片').props.disabled, true); delete record.recovery
  failure = true; await button('删除图片').props.onClick()
  assert.equal(record.versions.length, 2); assert.ok(render().some(n => n.props?.role === 'alert' && n.children.includes('删除失败')))
  failure = false
  await render().find(n => n.props?.['aria-label'] === '上一张插图').props.onClick()
  await button('删除图片').props.onClick()
  assert.equal(calls.at(-1).args.versionId, 'first')
  assert.equal(record.versions[0].id, 'second')
  await button('删除图片').props.onClick()
  assert.equal(record.versions.length, 0)
  assert.equal(button('重新生图'), undefined, 'generation stays unavailable while image service is disabled')
  record.enabled = true
  await button('重新生图').props.onClick()
  assert.equal(calls.at(-1).method, 'generateSceneImage')
  assert.equal(calls.at(-1).args.kind, 'generate')
  assert.equal(calls.at(-1).args.turn, 3)
  assert.equal(calls.at(-1).args.versionId, undefined)
  assert.equal(calls.at(-1).sessionId, 'session')
})
