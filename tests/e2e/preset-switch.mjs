import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Exercise the actual conversation preset UI; only the model output is fixed.
export async function presetSwitch({ page, step, savedChat, inspectRound, output, report }) {
  const identity = await savedChat()
  let rounds = identity.messages.filter(message => message.role === 'user').length
  for (const [key, gold] of [['A', 50], ['B', 60], ['', 70]]) {
    await step(`本局预设切换至 ${key || '内置'}，继续游玩并刷新`, async () => {
      const before = await savedChat()
      // A restarted/mobile layout may retain only the active status tab.
      if (!await page.locator('[data-dockkit-tab-title]').filter({ hasText: /^本局设置$/ }).count()) {
        await page.getByRole('button', { name: /^(新建标签页|New tab)$/ }).filter({ visible: true }).first().click()
        await page.getByText('本局设置', { exact: true }).filter({ visible: true }).first().click()
      }
      await page.locator('[data-dockkit-tab-title]').filter({ hasText: /^本局设置$/ }).filter({ visible: true }).first().click()
      const selector = page.getByRole('combobox', { name: '本局预设', exact: true })
      const path = key ? `presets/E2E-${key}.json` : ''
      await selector.selectOption(path)
      await page.getByRole('complementary', { name: '本局设置', exact: true })
        .locator('.dsh-local-field').filter({ has: selector }).getByRole('status').filter({ hasText: /^已保存$/ }).waitFor()
      const switched = await savedChat()
      assert.equal(switched.id, identity.id)
      assert.equal(switched.sessionId, identity.sessionId)
      assert.deepEqual(switched.messages, before.messages, '切换预设不能改动历史正文、变量或结算回执')
      assert.equal(switched.runtimePresetSnapshot?.presetPath || '', path)
      const composer = page.getByRole('textbox', { name: /发消息|Message/ })
      await composer.fill(`E2E 预设验收 ${gold}`)
      await composer.press('Enter')
      const body = `预设切换后继续游玩，金币 ${gold}。`
      await page.getByText(body, { exact: true }).filter({ visible: true }).first().waitFor()
      await page.getByText('酒馆状态', { exact: true }).filter({ visible: true }).first().click()
      const status = page.frameLocator('.dsh-tavern-status-runtime iframe').locator('#e2e-gold')
      await status.filter({ hasText: new RegExp(`^金币：${gold}$`) }).waitFor()
      await inspectRound(`preset-${key || 'builtin'}`, gold, body, ++rounds)
      const requests = (await readFile(join(output, 'preset-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
        .filter(request => request.gold === gold && !request.settlement)
      assert.ok(requests.length, '必须记录真实正文模型请求')
      for (const request of requests) {
        assert.equal(request.presetA, key === 'A', '模型请求中 A 预设必须与本局选择一致')
        assert.equal(request.presetB, key === 'B', '切换后不得残留旧预设')
      }
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByText(body, { exact: true }).filter({ visible: true }).first().waitFor()
      await status.filter({ hasText: new RegExp(`^金币：${gold}$`) }).waitFor()
      // A restarted/mobile layout may retain only the active status tab.
      if (!await page.locator('[data-dockkit-tab-title]').filter({ hasText: /^本局设置$/ }).count()) {
        await page.getByRole('button', { name: /^(新建标签页|New tab)$/ }).filter({ visible: true }).first().click()
        await page.getByText('本局设置', { exact: true }).filter({ visible: true }).first().click()
      }
      await page.locator('[data-dockkit-tab-title]').filter({ hasText: /^本局设置$/ }).filter({ visible: true }).first().click()
      await selector.locator(`option[value="${path}"]`).waitFor({ state: 'attached' })
      assert.equal(await selector.inputValue(), path, '刷新后保留本局预设')
      const restored = await savedChat()
      assert.equal(restored.id, identity.id)
      assert.equal(restored.sessionId, identity.sessionId)
      assert.equal(restored.runtimePresetSnapshot?.presetPath || '', path)
      await inspectRound(`preset-${key || 'builtin'}-reloaded`, gold, body, rounds)
      report[`preset-request-${key || 'builtin'}`] = requests
    })
  }
}
