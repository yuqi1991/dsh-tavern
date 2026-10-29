import assert from 'node:assert/strict'

// Operations that used to be refused because the target was located by native
// turn arithmetic or by an edit's replacement chain instead of by position in
// the log. Everything runs through the real UI against the real runtime; only
// the model output is fixed. Earlier steps leave round 2 as the edited body,
// with the first reroll's body ("再次领取…") saved as its older variant.
export async function locateOperations({ page, step, savedChat, report }) {
  const older = '你再次领取了奖励，金币累计二十枚。'
  const editedOlder = '切回旧变体后编辑：你把奖励收进了口袋。'
  const visible = text => page.getByText(text, { exact: true }).filter({ visible: true })
  const lastBody = chat => chat.messages.findLast(message => message.role === 'assistant' && !message.greeting)
  const bodyText = chat => lastBody(chat).sourceText ?? lastBody(chat).text
  const users = chat => chat.messages.filter(message => message.role === 'user').length
  async function settled(predicate) {
    let error
    for (let attempt = 0; attempt < 300; attempt++) {
      const chat = await savedChat()
      try {
        assert.ok(!chat.regenInProgress && !['pending', 'running'].includes(chat.settleStatus), '后台结算尚未结束')
        predicate(chat)
        return chat
      } catch (failure) { error = failure }
      await page.waitForTimeout(100)
    }
    throw error
  }
  async function menu(name) {
    await page.getByRole('button', { name: '更多 ▾', exact: true }).click()
    await page.getByRole('menuitem', { name }).click()
  }
  // The failure these steps guard against is a rejected operation, surfaced as an error toast.
  const refusal = /已不在当前上下文|不在可回退的消息流|找不到与当前剧情轮次|checkout 锚点|归属不一致/

  await step('切回旧变体后编辑正文（此前报“最后一轮正文已不在当前上下文中”）', async () => {
    await page.getByRole('group', { name: '正文变体' }).waitFor()
    await page.getByRole('button', { name: '上一个变体', exact: true }).click()
    await visible(older).first().waitFor()
    await menu('编辑正文')
    const editor = page.getByRole('region', { name: '编辑正文' })
    await editor.getByRole('textbox', { name: '正文文本 1' }).fill(editedOlder)
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await visible(editedOlder).first().waitFor()
    assert.equal(await page.getByText(refusal).filter({ visible: true }).count(), 0)
    const chat = await settled(saved => assert.ok(bodyText(saved).includes(editedOlder)))
    report.locateEditAfterSwitch = { text: bodyText(chat) }
  })

  await step('在被编辑的变体上离开再回来，发一条新消息后回退（此前报“checkout 锚点不在当前分支”）', async () => {
    // Leaving a saved variant that was edited keeps the edit in the log (it
    // shadows the variant's body there) but not in the variant slot: coming
    // back selects the saved body again while the log still records the edit.
    await page.getByRole('button', { name: '下一个变体', exact: true }).click()
    await visible('手工编辑：你把奖励放进了背包。').first().waitFor()
    await page.getByRole('button', { name: '上一个变体', exact: true }).click()
    await visible(older).first().waitFor()
    const before = await settled(() => {})
    const composer = page.getByRole('textbox', { name: /发消息|Message/ })
    await composer.fill('E2E 定位验收新一轮')
    await composer.press('Enter')
    const grown = await settled(saved => assert.equal(users(saved), users(before) + 1))
    await menu(/回退第.*轮|回退本轮/)
    const rolled = await settled(saved => assert.equal(users(saved), users(before)))
    assert.ok(bodyText(rolled).includes(older), '回退只去掉新一轮，旧变体的正文留在原位')
    await visible(older).first().waitFor()
    assert.equal(await page.getByText(refusal).filter({ visible: true }).count(), 0)
    report.locateRollbackAfterEditedVariant = { rounds: users(grown), afterRollback: users(rolled) }
  })

  await step('连续两次回退同一段，再重新生成上一轮', async () => {
    const start = await settled(() => {})
    await menu(/回退第.*轮|回退本轮/)
    await settled(saved => assert.equal(users(saved), users(start) - 1))
    await menu(/撤销回退（恢复第/)
    await settled(saved => assert.equal(users(saved), users(start)))
    await menu(/回退第.*轮|回退本轮/)
    await settled(saved => assert.equal(users(saved), users(start) - 1))
    const remaining = await savedChat()
    await page.getByRole('button', { name: '重新生成正文', exact: true }).click()
    await page.getByPlaceholder('指导意见（可选）：例如“写得更长，侧重心理描写”').fill('雨夜重写')
    await page.getByRole('button', { name: '生成并替换正文', exact: true }).click()
    const done = await settled(saved => {
      assert.equal(users(saved), users(remaining))
      assert.ok(bodyText(saved).includes('雨夜里，你重新领取了奖励。'))
    })
    await visible('雨夜里，你重新领取了奖励。').first().waitFor()
    assert.equal(await page.getByText(refusal).filter({ visible: true }).count(), 0)
    report.locateDoubleRollbackThenRegenerate = { rounds: users(done) }
  })
}
