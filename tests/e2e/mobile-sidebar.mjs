import assert from 'node:assert/strict'
import { join } from 'node:path'

// On phone-width layouts, opening a game must not pop the right column over the story (#213).
export async function mobileSidebarChecks({ page, step, output, report }) {
  await step('手机宽度下进入游戏不自动打开右侧栏，可手动打开', async () => {
    // DSH 0.2.x 会记住右栏的展开状态；前面的桌面步骤已按设置自动打开了它，先手动收起，
    // 这样刷新后看到的才是「窄屏下没有被自动展开」，而不是上次留下的展开状态。
    const collapse = page.locator('[data-sidebar-right-toggle]').filter({ visible: true })
    if (await collapse.count()) await collapse.first().click()
    await page.waitForTimeout(300)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('你获得了十枚金币。', { exact: false }).filter({ visible: true }).first().waitFor()
    await page.waitForTimeout(1500)
    const status = page.getByText('后台结算已完成', { exact: true }).filter({ visible: true })
    await page.screenshot({ path: join(output, 'mobile-open.png') })
    assert.equal(await status.count(), 0, '右侧栏不应自动展开')
    // The composer's + and attachment buttons keep the host's 28px round backdrop whatever the
    // UI language or WebView; a transparent ::after grows only the touch target (#215).
    // Measured before the right column opens, since it covers the composer at this width.
    const adds = await page.evaluate(() => [...document.querySelectorAll('[data-composer-card] button')]
      .filter(button => /(^|\s)\S+_add(\s|$)/.test(button.className))
      .map(button => {
        const box = button.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2
        // Just outside the visible circle, above and below: the neighbours sit left and right.
        const hits = [y - box.height / 2 - 4, y + box.height / 2 + 4].map(edge => document.elementFromPoint(x, edge))
        return { width: Math.round(box.width), height: Math.round(box.height), edge: hits.every(hit => hit === button || button.contains(hit)) }
      }))
    // DSH 0.2.1 的输入框只有 + 一个按钮（附件入口已并入 + 菜单）；以后宿主再加按钮时同样适用。
    assert.ok(adds.length >= 1, '输入框应有 + 按钮')
    assert.deepEqual(adds, adds.map(() => ({ width: 28, height: 28, edge: true })), '+ 按钮保持宿主尺寸，命中区向外扩出')
    await page.getByRole('button', { name: '酒馆状态', exact: true }).filter({ visible: true }).first().click()
    await status.first().waitFor()
    await page.screenshot({ path: join(output, 'mobile-status.png') })
    // Touch targets grow without growing the visuals (#215): the tab's × stays level with its title.
    const layout = await page.evaluate(() => {
      const close = document.querySelector('[data-dockkit-tab-close]')
      const tab = close?.closest('[data-dockkit-tab]')
      const box = el => el.getBoundingClientRect()
      const title = tab?.querySelector('[data-dockkit-tab-title]')
      return close && title ? { close: box(close), title: box(title) } : null
    })
    assert.ok(layout, '侧栏标签应有关闭按钮')
    const middle = rect => rect.top + rect.height / 2
    assert.ok(Math.abs(middle(layout.close) - middle(layout.title)) <= 2, '关闭按钮应与标签标题对齐')
    report.mobileSidebar = true
  })
  // The right column used to close the left drawer as a side effect; with it staying shut,
  // starting a game from the drawer must close the drawer itself.
  await step('手机宽度下从左侧栏开局后，左侧栏自动收起', async () => {
    const picker = page.getByRole('button', { name: /选择人物卡.*新开游玩/ }).filter({ visible: true })
    // 收起全屏的右栏；左抽屉的开关是侧栏插槽里的 toggle 按钮（窄屏下左侧留一条图标轨）。
    await page.locator('[data-sidebar-right-toggle]').filter({ visible: true }).first().click()
    await page.waitForTimeout(500)
    await page.locator('[data-slot="sidebar"] [class*="_toggle"]').filter({ visible: true }).first().click()
    await picker.first().waitFor()
    await page.screenshot({ path: join(output, 'mobile-drawer.png') })
    await picker.first().click()
    await page.locator('.dsh-tavern-card-pick').filter({ hasText: 'E2E 奖励验收' }).first().click()
    await page.getByRole('button', { name: '开始新游戏', exact: true }).click()
    await page.getByRole('textbox', { name: /发消息|Message/ }).filter({ visible: true }).first().waitFor()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: join(output, 'mobile-started.png') })
    assert.equal(await picker.count(), 0, '开局后左侧栏应收起')
  })
  // 真手机（触屏 + 窄屏）上 dsh-web-mobile 接管入口：左上目录开关打开抽屉并只出现它自带的遮罩，
  // 右上文件入口（=宿主右侧栏）始终可见可点。顶栏的窄屏规则曾把这两个按钮一并藏掉。
  await step('触屏窄屏下目录开关与右侧栏入口可见可点，抽屉遮罩随关闭撤掉', async () => {
    const state = await page.context().storageState()
    for (const [width, height] of [[360, 740], [390, 844], [412, 915], [430, 932]]) {
      const context = await page.context().browser().newContext({ storageState: state, viewport: { width, height }, deviceScaleFactor: 3, hasTouch: true, isMobile: true })
      try {
        const phone = await context.newPage()
        await phone.goto(page.url().split('?')[0], { waitUntil: 'domcontentloaded' })
        const toggle = phone.locator('[data-mobile-nav="toggle"]'), files = phone.locator('[data-mobile-nav="files"]')
        const collapse = phone.locator('[data-sidebar-right-toggle]').filter({ visible: true })
        const backdrop = phone.locator('[data-mobile-nav="backdrop"]')
        await toggle.waitFor({ state: 'visible' })
        await files.waitFor({ state: 'visible' })
        if (await collapse.count()) { await collapse.first().tap(); await phone.waitForTimeout(600) }
        assert.equal(await backdrop.count(), 0, `${width}: 抽屉未开时不应有变暗层`)
        await toggle.tap()
        await backdrop.waitFor({ state: 'visible' })
        await phone.screenshot({ path: join(output, `mobile-touch-${width}-drawer.png`) })
        await phone.touchscreen.tap(width - 8, height / 2)
        await backdrop.waitFor({ state: 'detached' })
        await files.waitFor({ state: 'visible' })
        await files.tap()
        await collapse.first().waitFor({ state: 'visible' })
        await phone.screenshot({ path: join(output, `mobile-touch-${width}-right.png`) })
      } finally { await context.close() }
    }
  })
  // 真机（iPhone Chrome，430 宽）：这一局有后台 Agent，顶栏标签行右端出现「N 个子智能体」；
  // 点进全屏再退出后，目录开关、文件入口必须都在，全屏按钮不留灰底（触屏 :hover 粘连）。
  await step('430 宽 iPhone 触屏：有后台子智能体时入口齐全，全屏进出后恢复且不留灰底', async () => {
    // 刚开的新局还没有后台 Agent：玩一轮，让固定模型触发后台结算。
    const input = page.getByRole('textbox', { name: /发消息|Message/ }).filter({ visible: true }).first()
    await input.fill('领取任务奖励')
    await input.press('Enter')
    await page.getByText('你获得了十枚金币。', { exact: false }).filter({ visible: true }).last().waitFor()
    await page.waitForTimeout(1500)
    const state = await page.context().storageState()
    const context = await page.context().browser().newContext({
      storageState: state, viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, locale: 'zh-CN',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
    })
    try {
      const phone = await context.newPage()
      await phone.goto(page.url().split('?')[0], { waitUntil: 'domcontentloaded' })
      const toggle = phone.locator('[data-mobile-nav="toggle"]'), files = phone.locator('[data-mobile-nav="files"]')
      const fullscreen = phone.locator('button.dsh-tavern-play-fullscreen')
      await toggle.waitFor({ state: 'visible' })
      const collapse = phone.locator('[data-sidebar-right-toggle]').filter({ visible: true })
      if (await collapse.count()) { await collapse.first().tap(); await phone.waitForTimeout(600) }
      await phone.locator('[class*="_trigger"][aria-haspopup="tree"]').filter({ visible: true }).waitFor()
      const entries = async label => {
        for (const [name, locator] of [['目录开关', toggle], ['文件入口', files], ['全屏按钮', fullscreen]]) {
          await locator.waitFor({ state: 'visible' })
          const info = await locator.evaluate(element => {
            const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            return { x: r.x, right: r.right, visibility: getComputedStyle(element).visibility, hit: element.contains(hit) }
          })
          assert.ok(info.visibility === 'visible' && info.x >= 0 && info.right <= 430 && info.hit, `${label}: ${name} 可见可点 ${JSON.stringify(info)}`)
        }
      }
      await entries('初始')
      await phone.screenshot({ path: join(output, 'mobile-430-subagent.png'), clip: { x: 0, y: 0, width: 430, height: 120 } })
      await fullscreen.tap()
      await phone.waitForFunction(() => document.documentElement.classList.contains('dsh-tavern-play-fullscreen'))
      await phone.screenshot({ path: join(output, 'mobile-430-immersive.png'), clip: { x: 0, y: 0, width: 430, height: 120 } })
      await fullscreen.tap()
      await phone.waitForFunction(() => !document.documentElement.classList.contains('dsh-tavern-play-fullscreen'))
      await phone.waitForTimeout(300)
      await entries('退出全屏后')
      const background = await fullscreen.evaluate(element => getComputedStyle(element).backgroundColor)
      assert.equal(background, 'rgba(0, 0, 0, 0)', '退出全屏后全屏按钮不留灰底')
      await phone.screenshot({ path: join(output, 'mobile-430-after-fullscreen.png'), clip: { x: 0, y: 0, width: 430, height: 120 } })
      await files.tap()
      await phone.locator('[data-sidebar-right-toggle]').filter({ visible: true }).first().waitFor()
    } finally { await context.close() }
  })
}
