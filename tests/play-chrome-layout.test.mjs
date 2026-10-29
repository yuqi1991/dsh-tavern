import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../tavern-plugin/src/client/ui/message-frame.js', import.meta.url), 'utf8')
const start = source.indexOf('function composerOffsetPx(')
const end = source.indexOf('// @include modules/mobile-layout.js')
assert.notEqual(start, -1)
assert.notEqual(end, -1)
const { composerOffsetPx, sheetMaxPx } = new Function(source.slice(start, end) + ';return { composerOffsetPx, sheetMaxPx }')()

test('没有键盘时，行动卡贴在输入条上沿', () => {
  assert.equal(composerOffsetPx(800, 0, 700), 100)
  assert.equal(composerOffsetPx(400, 0, 280), 120)
  assert.equal(sheetMaxPx(800, 700, 36), 480)
})

test('键盘不缩小布局视口时，行动卡底边含键盘高度，高度只占可视区剩余', () => {
  assert.equal(composerOffsetPx(800, 0, 420), 380)
  assert.equal(sheetMaxPx(500, 420, 36), 300)
  // DOMRect 已经处于布局视口坐标，不再重复叠加浏览器平移量。
  assert.equal(composerOffsetPx(800, 40, 400), 400)
  assert.equal(sheetMaxPx(480, 400, 36), 288)
  assert.equal(sheetMaxPx(500, 30, 36), 0)
})
