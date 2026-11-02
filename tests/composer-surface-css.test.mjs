import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../tavern-plugin/lib/client-assets/tavern.css', import.meta.url), 'utf8')
const rule = selector => css.split('\n').find(line => line.startsWith(selector))

test('输入框透明度同时管上方按钮、下方统计条与顶部标题栏，没有皮肤变量时回退原样', () => {
  const variable = rule('body.dsh-tavern-shell-active {\n') ?? css.match(/body\.dsh-tavern-shell-active \{\n  --dsh-tavern-composer-surface:[^\n]+/)?.[0]
  assert.match(variable, /var\(--dsh-dream-skin-composer-fill\)/, '填充比例直接取自皮肤的输入框透明度；变量不存在时整个值无效，各处走回退')
  assert.match(variable, /--dsh-dream-skin-glass-fill-scale/, '与输入框一样乘材质的填充系数')
  for (const [selector, fallback] of [
    ['body.dsh-tavern-shell-active .dsh-tavern-dock-actions .dsh-tavern-choice-trigger {', 'var(--dsw-alias-bg-base)'],
    ['body.dsh-tavern-shell-active [data-composer-dock] {', 'transparent'],
    ['body.dsh-tavern-shell-active [data-phase] header[data-window-drag] {', 'transparent'],
  ]) {
    const line = rule(selector)
    assert.ok(line, selector)
    assert.ok(line.includes(`background: var(--dsh-tavern-composer-surface, ${fallback})`), selector + ' 的回退底色')
  }
  assert.ok(rule('body.dsh-tavern-shell-active .dsh-tavern-dock-actions .dsh-tavern-choice-trigger:hover:not(:disabled) {'), '悬停仍用强调色底，不被透明度规则盖住')
  // 没有皮肤变量时，模糊变量必须无效（回退 none）：blur(0px) 也会生成包含块，让 fixed 定位的菜单错位。
  assert.match(css, /--dsh-tavern-composer-backdrop: blur\(var\(--dsh-dream-skin-glass-blur\)\)/, '模糊半径不能带回退值')
  // 标题栏里有导出等 fixed 定位的菜单：只换底色，不能加 backdrop-filter。
  assert.doesNotMatch(rule('body.dsh-tavern-shell-active [data-phase] header[data-window-drag] {'), /backdrop-filter/)
})
