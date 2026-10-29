import { openHostSettings } from './host-ui.mjs'
import assert from 'node:assert/strict'
import { join } from 'node:path'

// 上游移植批 3（场景生图）的界面冒烟：设置里的「场景生图」标签、对话区的「画廊」标签、本局的生图模型选择，
// 在真实浏览器里能打开、不报错。不调用任何真实生图服务。
export async function batch3ImageChecks({ page, step, output, errors }) {
  const shot = name => page.screenshot({ path: join(output, name + '.png'), fullPage: true })
  await step('设置里有独立的「场景生图」标签，未配置时不能开启', async () => {
    await openHostSettings(page)
    await page.getByRole('button', { name: '场景生图', exact: true }).or(page.getByText('场景生图', { exact: true }).last()).first().click()
    await page.getByLabel(/^提供商/).waitFor()
    const toggle = page.getByRole('switch', { name: '开启场景生图' })
    await toggle.waitFor()
    assert.equal(await toggle.isDisabled(), true, '配置不完整时开关不可开')
    await shot('image-settings')
    await page.keyboard.press('Escape')
  })
  await step('对话区有「画廊」标签，当前局没有图片时为空', async () => {
    await page.getByRole('tab', { name: '画廊', exact: true }).or(page.getByText('画廊', { exact: true })).filter({ visible: true }).first().click()
    await page.locator('.dsh-tavern-gallery, .dsh-tavern-full-context').filter({ visible: true }).first().waitFor()
    await shot('gallery-empty')
    await page.getByText(/^(Chat|对话)$/).filter({ visible: true }).first().click()
  })
  await step('本局设置里有「生图 Agent 模型」选择', async () => {
    await page.locator('[data-dockkit-tab-title]').filter({ hasText: /^本局设置$/ }).filter({ visible: true }).first().click()
    await page.getByLabel('本局生图 Agent 模型').waitFor()
    assert.equal(await page.getByRole('switch', { name: '开启场景生图' }).count(), 0, '每局的场景生图开关已取消，改为全局开关')
    await shot('local-settings')
  })
  assert.deepEqual(errors, [], '浏览器不得出现未捕获异常')
}
