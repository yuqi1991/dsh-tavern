import test from 'node:test'
import assert from 'node:assert/strict'
import { openTavernSettings } from './fixtures/tavern-settings-browser.mjs'

function fixture() {
  let fail = false
  let settings = { defaultForegroundModel: null, defaultBackgroundModel: null, hideContextAndReasoning: true }
  return {
    setFail(value) { fail = value },
    respond(method, args) {
      if (method === 'getTavernSettings') return { settings, modelCatalog: [{ provider: 'p', models: [{ id: 'm' }] }], releaseCapabilities: { sceneImages: false } }
      if (method === 'getBackgroundModelReasoning') return { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
      if (method === 'getDisplayPreferences') return { hideContextAndReasoning: settings.hideContextAndReasoning, renderDepth: 3, autoOpenStatusPanel: true, headerItems: { display: 'icon-text', items: [] } }
      if (method === 'updateTavernSettings') {
        if (fail) throw Error('保存失败测试')
        settings = { ...settings, ...args.patch }
        return { settings }
      }
    }
  }
}

test('registered settings preserves model selection after rejected saves', async t => {
  const backend = fixture()
  const { page, calls } = await openTavernSettings(t, { sceneImages: false, respond: backend.respond })
  const model = page.getByLabel('默认前台模型', { exact: true })
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  const choice = JSON.stringify({ provider: 'p', model: 'm' })
  await model.selectOption(choice)
  await page.getByText('已保存，下次新游戏生效', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型推理强度"]')?.disabled === false)
  await page.getByLabel('默认前台模型推理强度', { exact: true }).selectOption('low')
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  assert.deepEqual(calls.filter(c => c.method === 'updateTavernSettings').at(-1).args.patch.defaultForegroundModel, { provider: 'p', model: 'm', reasoningEffort: 'low' })
  backend.setFail(true)
  await model.selectOption('')
  await page.getByRole('alert').filter({ hasText: '保存失败测试' }).waitFor()
  assert.equal(await model.inputValue(), choice)
  backend.setFail(false)
  await model.selectOption('')
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  assert.equal(await model.inputValue(), '')
})

test('全局设置按「默认模型 / 新游戏默认 / 显示与交互 / 高级」分区，默认模型各行带用途说明', async t => {
  const backend = fixture()
  const { page } = await openTavernSettings(t, { sceneImages: false, respond: backend.respond })
  await page.waitForFunction(() => document.querySelector('[aria-label="默认前台模型"]')?.disabled === false)
  const groups = await page.locator('section.dsh-tavern-gs-group').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
  assert.deepEqual(groups, ['默认模型', '新游戏默认', '显示与交互', '高级'])
  await page.getByText('写正文、扮演角色，直接决定剧情质量', { exact: true }).waitFor()
})
