import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { helperClient } from './fixtures/helper-host-harness.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('trusted host composer reads the draft on focus and fills on input', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const doc = dom.window.document
  const draft = '已有内容'
  const fills = [], errors = []
  const release = helperClient.installFrameHostComposer(doc, () => true,
    () => Promise.resolve(), error => errors.push(error),
    text => { fills.push(text); return Promise.resolve() },
    () => draft)
  try {
    const area = doc.getElementById('send_textarea')
    assert.ok(area)
    assert.ok(doc.getElementById('send_but'))
    const controls = area.parentElement
    assert.equal(controls.hasAttribute('hidden'), false)
    assert.match(controls.getAttribute('style'), /left:-10000px/)
    assert.equal(area.getAttribute('inputmode'), 'none', '屏幕外输入框被聚焦时不弹出手机键盘')
    area.focus()
    assert.equal(area.value, '已有内容')
    // Native regex sequence: focus, read, append, fire input.
    const current = area.value
    area.value = current + (current.trim() ? '\n' : '') + '选项文字'
    area.dispatchEvent(new dom.window.Event('input'))
    await tick()
    assert.deepEqual(fills, ['已有内容\n选项文字'])
    assert.deepEqual(errors, [])
  } finally {
    release()
  }
  assert.equal(doc.getElementById('send_textarea'), null)
})

test('multiple mounted cards still fill the shared draft from a native option click', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const doc = dom.window.document
  const first = [], second = [], errors = []
  const releaseFirst = helperClient.installFrameHostComposer(doc, () => false,
    () => Promise.resolve(), error => errors.push(error),
    text => { first.push(text); return Promise.resolve() },
    () => '')
  const releaseSecond = helperClient.installFrameHostComposer(doc, () => false,
    () => Promise.resolve(), error => errors.push(error),
    text => { second.push(text); return Promise.resolve() },
    () => '')
  try {
    // The native script focuses the offscreen textarea before the host sees the
    // iframe focus, so no owner is focused when the input event arrives.
    const area = doc.getElementById('send_textarea')
    area.value = '选项文字'
    area.dispatchEvent(new dom.window.Event('input'))
    await tick()
    assert.deepEqual([...first, ...second], ['选项文字'])
    assert.deepEqual(errors, [])
  } finally {
    releaseFirst()
    releaseSecond()
  }
  assert.equal(doc.getElementById('send_textarea'), null)
})

test('click on #send_but after the card script focused the offscreen textarea still sends for the last focused card', async () => {
  const dom = new JSDOM('<!doctype html><html><body><iframe id="a"></iframe><iframe id="b"></iframe></body></html>')
  const doc = dom.window.document
  const a = doc.getElementById('a'), b = doc.getElementById('b')
  const sent = [], errors = []
  const releaseA = helperClient.installFrameHostComposer(doc, node => node === a,
    text => { sent.push(['A', text]); return Promise.resolve() }, error => errors.push(error.message), () => Promise.resolve(), () => '')
  const releaseB = helperClient.installFrameHostComposer(doc, node => node === b,
    text => { sent.push(['B', text]); return Promise.resolve() }, error => errors.push(error.message), () => Promise.resolve(), () => '')
  try {
    // The player taps inside card B, then the card script moves focus to the offscreen textarea.
    b.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
    const area = doc.getElementById('send_textarea'), button = doc.getElementById('send_but')
    area.focus()
    area.value = '选项文字'
    button.click()
    await tick()
    assert.deepEqual(sent, [['B', '选项文字']])
    assert.deepEqual(errors, [])
  } finally {
    releaseA(); releaseB()
  }
})

test('opening preview ignores #send_textarea input instead of reporting a missing conversation', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const doc = dom.window.document
  const errors = []
  const release = helperClient.installFrameHostComposer(doc, () => true,
    () => Promise.resolve(), error => errors.push(error), () => undefined, () => '')
  try {
    const area = doc.getElementById('send_textarea')
    area.value = '开场选项'
    area.dispatchEvent(new dom.window.Event('input'))
    await tick()
    assert.deepEqual(errors, [])
  } finally { release() }
})

test('trusted card lifecycle routes #send_textarea through the session draft', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const win = dom.window
  const lines = []
  const executeSlash = (line, sessionId) => { lines.push([line, sessionId]); return Promise.resolve({ drafted: true }) }
  executeSlash.readInput = sessionId => '玩家草稿@' + sessionId
  const lifecycle = helperClient.createTavernMessageFrameLifecycle({
    sessionId: 's1', content: '<button>option</button>', turn: 1, partIndex: 0, trustedCardMode: true,
    helperContext: { lifecycleRevision: 1, messages: [] }, eager: true, executeSlash
  }, { window: {
    document: win.document, crypto: { randomUUID() { return 'bridge-token' } },
    sessionStorage: { getItem() { return null }, setItem() {} }, setTimeout, clearTimeout,
    addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win)
  } })
  const stop = lifecycle.start(() => {})
  try {
    const area = win.document.getElementById('send_textarea')
    assert.ok(area, '可信卡片模式下宿主文档有 #send_textarea')
    area.focus()
    assert.equal(area.value, '玩家草稿@s1')
    area.value = area.value + '\n选项文字'
    area.dispatchEvent(new win.Event('input'))
    await tick()
    assert.deepEqual(lines, [['/setinput 玩家草稿@s1\n选项文字', 's1']])
  } finally { stop() }
  assert.equal(win.document.getElementById('send_textarea'), null)
})

test('jQuery .val().trigger("input") 不派发原生事件，也要进入宿主输入框草稿', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' })
  const win = dom.window
  win.eval(readFileSync(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url), 'utf8'))
  const fills = []
  const release = helperClient.installFrameHostComposer(win.document, () => true,
    () => Promise.resolve(), error => assert.fail(error.message),
    text => { fills.push(text); return Promise.resolve() }, () => '')
  try {
    const $ = win.jQuery
    $('#send_textarea').val('选项丁').trigger('input')
    $('#send_textarea').val('选项戊').trigger('change')
    await tick()
    assert.deepEqual(fills, ['选项丁', '选项戊'])
    // 原生事件只提交一次，不会被 jQuery 与属性处理器各算一次。
    fills.length = 0
    const area = win.document.getElementById('send_textarea')
    area.value = '选项己'
    area.dispatchEvent(new win.Event('input', { bubbles: true }))
    await tick()
    assert.deepEqual(fills, ['选项己'])
  } finally { release() }
})
