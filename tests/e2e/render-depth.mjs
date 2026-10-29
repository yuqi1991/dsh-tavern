import { openHostSettings } from './host-ui.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'

// 渲染深度：超出深度的楼层只显示文字，卡片 HTML 换成「渲染此轮」按钮；点击后单独渲染；改设置立即生效。
export async function renderDepthChecks({ page, step, output, errors }) {
  const composer = () => page.getByRole('textbox', { name: /发消息|Message/ })
  const floors = () => page.locator('.dsh-tavern-story-floor[data-story-turn]').filter({ has: page.locator('.dsh-tavern-assistant') })
  const buttons = () => page.locator('.dsh-tavern-render-round')
  const settled = async n => { await page.waitForFunction(count => document.querySelectorAll('.dsh-tavern-story-floor[data-story-turn]:not([data-story-turn="live"]):not([data-story-turn="0"])').length >= count, n, { timeout: 60000 }) }
  await step('再玩 4 轮，共 5 轮', async () => {
    for (const [index, text] of ['再次领取奖励', '继续', '再来一次', '最后一次'].entries()) {
      await composer().fill(text)
      await composer().press('Enter')
      await settled(index + 2)
      await page.waitForFunction(() => !document.querySelector('[aria-label="Stop"], [aria-label="停止"]'), null, { timeout: 60000 }).catch(() => {})
    }
    await page.screenshot({ path: join(output, 'render-depth-default.png'), fullPage: true })
  })
  // 按输入内容找楼层（楼层编号与轮次数并不一一对应）。
  const floorOf = text => page.locator('.dsh-tavern-story-floor').filter({ hasText: text }).last()
  const turn = n => floorOf(['领取任务奖励', '再次领取奖励', '继续', '再来一次', '最后一次'][n - 1])
  async function setDepth(value) {
    await openHostSettings(page)
    await page.getByRole('button', { name: 'DSH Tavern' }).or(page.getByText('DSH Tavern', { exact: true }).last()).first().click()
    const select = page.getByLabel('渲染深度')
    await select.waitFor()
    await select.selectOption(value)
    await page.getByText('已保存，对所有对话立即生效').waitFor()
    await page.keyboard.press('Escape')
  }
  // 这套卡规则只给第 1 轮的正文带上卡片 HTML；其余轮次没有 HTML，也就没有可折叠的内容。
  await step('默认深度 3：第 1 轮（离最新 4 轮）折叠成按钮', async () => {
    await turn(1).locator('.dsh-tavern-render-round').waitFor()
    assert.equal(await buttons().count(), 1)
    assert.equal(await page.locator('.dsh-tavern-story-floor').filter({ hasText: '欢迎领取奖励' }).locator('.dsh-tavern-render-round').count(), 0, '开场白不折叠')
    assert.equal(await turn(1).locator('iframe').count(), 0, '折叠的楼层不挂 iframe')
    for (const n of [2, 3, 4, 5]) assert.equal(await turn(n).locator('.dsh-tavern-render-round').count(), 0)
  })
  await step('深度改成 5：第 1 轮恢复渲染卡片', async () => {
    await setDepth('5')
    await turn(1).locator('iframe').first().waitFor()
    assert.equal(await buttons().count(), 0)
  })
  await step('深度改回 3：再次折叠；点「渲染此轮」只渲染该轮', async () => {
    await setDepth('3')
    await turn(1).locator('.dsh-tavern-render-round').waitFor()
    assert.equal(await turn(1).locator('iframe').count(), 0)
    await turn(1).locator('.dsh-tavern-render-round').click()
    await turn(1).locator('iframe').first().waitFor()
    assert.equal(await buttons().count(), 0)
    await page.screenshot({ path: join(output, 'render-depth-clicked.png'), fullPage: true })
  })
  await step('深度「不限」：没有任何折叠', async () => {
    await setDepth('0')
    assert.equal(await buttons().count(), 0)
  })
  assert.deepEqual(errors, [], '浏览器不得出现未捕获异常')
}
