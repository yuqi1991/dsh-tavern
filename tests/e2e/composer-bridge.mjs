import assert from 'node:assert/strict'
import { join } from 'node:path'

// 人物卡里的酒馆脚本把「选项」写进原生 #send_textarea：值要接到宿主输入框的草稿里，
// 屏幕外的 #send_textarea 被聚焦时不能抢走宿主输入框的焦点（手机上即软键盘）。
export async function composerBridgeChecks({ page, step, savedChat, output, report }) {
  const composer = page.getByRole('textbox', { name: /发消息|Message/ })
  async function cardFrame() {
    await page.frameLocator('.dsh-tavern-status-runtime iframe.dsh-tavern-message-frame').locator('#e2e-gold').waitFor()
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && await frame.locator('#e2e-gold').count().catch(() => 0)) return frame
    }
    throw new Error('找不到状态栏卡片 iframe')
  }
  // 与 SillyTavern 常见正则按钮相同的顺序：focus、读取旧值、追加选项、触发 input。
  const writeOption = (frame, text) => frame.evaluate(option => {
    const area = window.parent.document.getElementById('send_textarea')
    if (!area) throw new Error('宿主文档没有 #send_textarea')
    area.focus()
    area.value = area.value + (area.value.trim() ? '\n' : '') + option
    area.dispatchEvent(new window.parent.Event('input', { bubbles: true }))
  }, text)

  await step('卡片脚本写入 #send_textarea，选项出现在宿主输入框并保留已有草稿', async () => {
    const frame = await cardFrame()
    await composer.fill('先前的草稿')
    await writeOption(frame, '选项甲')
    await page.waitForFunction(() => /先前的草稿\s*选项甲/.test(document.querySelector('[role=textbox]')?.innerText || ''))
    assert.match(await composer.innerText(), /先前的草稿\s+选项甲/)
    assert.equal(await frame.evaluate(() => window.parent.document.getElementById('send_textarea').value), '先前的草稿\n选项甲')
    await page.screenshot({ path: join(output, 'composer-bridge-filled.png') })
    report.composerBridgeFill = true
  })

  await step('卡片脚本用 jQuery 的 .val().trigger("input") 写入时同样进入宿主输入框', async () => {
    const frame = await cardFrame()
    await composer.fill('')
    // 与真实人物卡一致：宿主页上已有 jQuery（可信卡片模式会加载它）。
    await frame.evaluate(async () => {
      const host = window.parent
      if (host.jQuery?.fn?.jquery) return
      await new Promise((resolve, reject) => {
        const script = host.document.createElement('script')
        script.src = '/api/dsh-tavern/vendor/runtime-assets/jquery/jquery.min.js'
        script.onload = resolve; script.onerror = () => reject(new Error('jQuery 加载失败'))
        host.document.head.append(script)
      })
    })
    await frame.evaluate(() => {
      const $ = window.parent.jQuery
      const area = $('#send_textarea')
      area.trigger('focus')
      area.val(area.val() + '选项丙').trigger('input')
    })
    await page.waitForFunction(() => /选项丙/.test(document.querySelector('[role=textbox]')?.innerText || ''))
    assert.match(await composer.innerText(), /选项丙/)
    report.composerBridgeJQuery = true
  })

  await step('手机宽度下聚焦屏幕外的 #send_textarea 不使宿主输入框获得焦点', async () => {
    await composer.fill('')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(500)
    const state = await page.evaluate(() => {
      const area = document.getElementById('send_textarea')
      const box = area.getBoundingClientRect()
      const host = document.querySelector('[role=textbox]')
      host.blur(); area.focus()
      return { inputmode: area.getAttribute('inputmode'), tabIndex: area.tabIndex, right: Math.round(box.right),
        focusedIsArea: document.activeElement === area, hostFocused: host.contains(document.activeElement) || document.activeElement === host }
    })
    assert.equal(state.inputmode, 'none')
    assert.ok(state.right <= 0, '#send_textarea 在屏幕外，右边缘 ' + state.right)
    assert.equal(state.hostFocused, false, '宿主输入框不得因此获得焦点')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.waitForTimeout(300)
    report.composerBridgeMobile = state
  })

  await step('卡片脚本点 #send_but 后，选项作为玩家消息发送', async () => {
    const frame = await cardFrame()
    await composer.fill('')
    await writeOption(frame, '选项乙')
    await page.waitForFunction(() => /选项乙/.test(document.querySelector('[role=textbox]')?.innerText || ''))
    // 脚本聚焦屏幕外输入框后点击 #send_but：发送方仍是最近操作的这张卡片。
    await frame.evaluate(() => { window.parent.document.getElementById('send_textarea').focus(); window.parent.document.getElementById('send_but').click() })
    await page.locator('.dsh-tavern-user-bubble').filter({ hasText: '选项乙' }).first().waitFor({ state: 'visible' })
    const chat = await savedChat()
    assert.ok(chat.messages.some(message => message.role === 'user' && /选项乙/.test(message.text ?? message.sourceText ?? '')), '落盘的玩家消息包含选项')
    await page.screenshot({ path: join(output, 'composer-bridge-sent.png') })
    report.composerBridgeSend = true
  })
}
