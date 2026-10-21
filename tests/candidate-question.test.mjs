import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function CandidateQuestion(props)'), source.indexOf('function CandidateGuidePanel(props)'))
function harness(initial = '', mode = 'after-send') {
  let draft = initial, cursor, running = false
  const states = [[], true], refs = [], effects = []
  let panel = { sessionId: 's', messageId: 'm', phase: 'ready', expanded: true, choices: [{ type: 'action', text: '走近窗边' }, { type: 'scene', text: '雨停了' }] }
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), useRef: () => refs[0] ||= {}, useState: () => { const i = cursor++; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }] }, useEffect: (fn, deps) => effects.push({ fn, deps }) }
  const Component = new Function('React', 'useCandidatePanel', 'useTavernSessionMode', 'latestTavernAssistantMessageId', 'isPlayMode', 'useCandidatePreferences', 'setCandidatePanel', code + ';return CandidateQuestion')(React, () => panel, () => 'story', () => 'm', () => true, () => mode, value => { panel = value })
  const props = { sessionId: 's', useInput: fn => fn({ draft }), useSession: fn => fn({ running }), useChat: () => 'm', inputActions: { setDraft: value => { draft = value } } }
  const render = () => { cursor = 0; effects.length = 0; return Component(props) }
  function buttons(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(buttons); return [...(node.type === 'button' ? [node] : []), ...buttons(node.children)] }
  return { remount: () => { states[0] = []; states[1] = false; render(); effects.forEach(effect => effect.fn()); }, render, buttons, draft: () => draft, panel: () => panel, states, effects, run: () => { running = true } }
}
test('点选候选追加到输入框，再点一次移除，连续点选保留草稿及完整候选列表', () => {
  const h = harness('手动写的内容')
  const options = () => h.buttons(h.render()).filter(node => node.props.className?.includes('question-option'))
  assert.equal(options().length, 2)
  options()[0].props.onClick()
  assert.equal(h.draft(), '手动写的内容\n走近窗边')
  assert.deepEqual(h.states[0], [0])
  assert.equal(h.panel().expanded, true)
  assert.equal(options().length, 2)
  assert.equal(options()[0].props['aria-pressed'], true)
  options()[1].props.onClick()
  assert.equal(h.draft(), '手动写的内容\n走近窗边\n【场景变化】雨停了')
  options()[0].props.onClick()
  assert.equal(h.draft(), '手动写的内容\n【场景变化】雨停了')
  assert.deepEqual(h.states[0], [1])
})

test('选择“填入后隐藏”时点选候选会关闭面板', () => {
  const h = harness('', 'after-fill')
  h.buttons(h.render()).find(node => node.props.className?.includes('question-option')).props.onClick()
  assert.equal(h.draft(), '走近窗边')
  assert.equal(h.panel(), null)
})

test('保存设置立即通知已挂载的候选列表，旧读取结果不会覆盖新设置', async () => {
  const hook = source.slice(source.indexOf('function useCandidatePreferences()'), source.indexOf('function CandidatePreferencesSettings()'))
  const window = new EventTarget()
  let mode, effect, resolve
  const React = { useState: initial => { mode = initial; return [mode, value => { mode = value }] }, useEffect: fn => { effect = fn } }
  const usePreferences = new Function('React', 'window', 'rpc', hook + '; return useCandidatePreferences')(React, window, () => new Promise(done => { resolve = done }))
  usePreferences()
  const cleanup = effect()
  const event = new Event('dsh-tavern-candidate-preferences'); event.detail = 'after-send'
  window.dispatchEvent(event)
  assert.equal(mode, 'after-send')
  resolve({ candidateDismissMode: 'after-fill' }); await Promise.resolve()
  assert.equal(mode, 'after-send')
  cleanup()
  const late = new Event('dsh-tavern-candidate-preferences'); late.detail = 'after-fill'
  window.dispatchEvent(late)
  assert.equal(mode, 'after-send')
})
