import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Story View while "重新生成正文" is running: every other floor stays, the
// regenerated floor shows its (possibly revised) input and the new body.
// The fixed model holds its reply open (regen-hold.json) so the page can be
// sampled mid-generation; everything else is the real runtime and UI.
export async function regenViewChecks({ page, step, savedChat, output, report }) {
  const first = '你获得了十枚金币。'
  const second = '你再次领取了奖励，金币累计二十枚。'
  const regenerated = '雨夜里，你重新领取了奖励。'
  const revised = '修订后的输入：再次领取奖励'
  const hold = mode => writeFile(join(output, 'regen-hold.json'), JSON.stringify({ mode }))
  const frames = []
  // RPC evidence: what the server returned for the story floors / the view while the page was sampled.
  page.on('response', async response => {
    const name = response.url().split('/api/dsh-tavern/')[1]
    if (!['getStoryFloors', 'getSession'].includes(name)) return
    try {
      const body = await response.json()
      if (name === 'getStoryFloors') frames.push({ rpc: name, at: Date.now(), floors: (body.floors || []).map(floor => ({ turn: floor.turn, input: floor.input?.text ?? null, body: floor.body ? String(floor.body.text).slice(0, 24) : null, open: floor.open === true, regenerating: floor.regenerating === true })) })
      else if (body.view) frames.push({ rpc: name, at: Date.now(), regenerating: body.view.regenerating, latestInput: body.view.latestInput?.text })
    } catch { /* streaming or non-JSON response */ }
  })
  const snapshot = () => page.evaluate(() => [...document.querySelectorAll('[data-story-turn]')].map(floor => ({
    turn: floor.getAttribute('data-story-turn'),
    users: [...floor.querySelectorAll('.dsh-tavern-user-bubble')].map(node => node.innerText.trim()),
    body: [...floor.querySelectorAll('.dsh-tavern-assistant')].map(node => node.innerText.trim().slice(0, 60)),
    streaming: Boolean(floor.querySelector('[data-streaming]')),
    status: floor.querySelector('.dsh-tavern-story-status')?.innerText || '',
    variant: floor.querySelector('[role=group][aria-label="正文变体"]')?.innerText.trim() || ''
  })))
  const timeline = []
  async function sample(label) {
    const floors = await snapshot()
    timeline.push({ label, floors })
    return floors
  }
  const visible = text => page.getByText(text, { exact: true }).filter({ visible: true })
  const gold = value => page.frameLocator('.dsh-tavern-status-runtime iframe').locator('#e2e-gold').filter({ hasText: new RegExp('^金币：' + value + '$') }).waitFor()
  async function openRegenForm(input, guidance) {
    await page.getByRole('button', { name: '重新生成正文', exact: true }).click()
    const inputBox = page.locator('textarea.dsh-tavern-regen-input').first()
    await page.waitForFunction(() => document.querySelector('textarea.dsh-tavern-regen-input')?.value)
    if (input !== null) await inputBox.fill(input)
    await page.getByPlaceholder('指导意见（可选）：例如“写得更长，侧重心理描写”').fill(guidance)
    await page.getByRole('button', { name: '生成并替换正文', exact: true }).click()
  }
  async function heldRegen(label, input, guidance) {
    await hold('hold')
    await openRegenForm(input, guidance)
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(150)
      await sample(label + ':early')
    }
    await page.waitForTimeout(1200)
    const mid = await sample(label + ':held')
    await page.screenshot({ path: join(output, label + '-held.png'), fullPage: true })
    return mid
  }
  function expectKept(floors, { input, bodyOfFloor1 }) {
    const real = floors.filter(floor => floor.turn !== 'live')
    assert.equal(floors.filter(floor => floor.users.some(text => text.includes('领取任务奖励'))).length, 1, '第 1 层的输入必须保留')
    assert.ok(floors.some(floor => floor.body.some(text => text.includes(bodyOfFloor1))), '第 1 层的正文必须保留')
    assert.ok(floors.some(floor => floor.users.some(text => text.includes(input))), '被重新生成的楼层必须显示输入：' + input)
    assert.ok(real.length >= 3, '重新生成期间开场白与两个楼层都在')
  }

  await step('开局之后再玩一轮，得到两个楼层', async () => {
    const composer = page.getByRole('textbox', { name: /发消息|Message/ })
    await composer.fill('再次领取奖励')
    await composer.press('Enter')
    await visible(second).first().waitFor()
    await gold(20)
    await page.getByRole('button', { name: '重新生成正文', exact: true }).waitFor()
    const floors = await sample('two-floors')
    assert.equal(floors.filter(floor => floor.turn !== 'live').length, 3, '开场白 + 两轮')
  })

  await step('重新生成进行中：两个楼层都在，被重生成楼层显示修订后的输入', async () => {
    const mid = await heldRegen('regen-revised', revised, '雨夜重写')
    report.regenViewHeld = { frames: frames.slice(-6), mid }
    await writeFile(join(output, 'regen-view-timeline.json'), JSON.stringify({ timeline, frames }, null, 2))
    expectKept(mid, { input: revised, bodyOfFloor1: first })
    assert.equal(mid.filter(floor => floor.body.some(text => text.includes(second))).length, 0, '旧正文不再作为本层正文显示（正在生成）')
    await hold('release')
    await visible(regenerated).first().waitFor()
    await gold(30)
    const done = await sample('regen-revised:done')
    assert.equal(done.filter(floor => floor.turn !== 'live').length, 3, '完成后仍是开场白加两个楼层')
    assert.ok(done.some(floor => floor.users.some(text => text.includes(revised))))
    assert.match(done.at(-1).variant, /2\s*\/\s*2/, '变体计数 2/2：' + done.at(-1).variant)
    await writeFile(join(output, 'regen-view-timeline.json'), JSON.stringify({ timeline, frames }, null, 2))
  })

  await step('重新生成进行中点停止：所有楼层原样恢复，原正文还在', async () => {
    const mid = await heldRegen('regen-stopped', null, '再写一版')
    // The unchanged input is still shown on the floor being regenerated.
    expectKept(mid, { input: revised, bodyOfFloor1: first })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await hold('release')
    await visible(regenerated).first().waitFor()
    await page.waitForTimeout(1500)
    const after = await sample('regen-stopped:after')
    await page.screenshot({ path: join(output, 'regen-stopped-after.png'), fullPage: true })
    assert.equal(after.filter(floor => floor.turn !== 'live').length, 3, '停止后仍是开场白加两个楼层')
    assert.ok(after.some(floor => floor.users.some(text => text.includes(revised)) && floor.body.some(text => text.includes(regenerated))), '被停止的楼层恢复为原输入与原正文')
    assert.equal(after.filter(floor => floor.status).length, 0)
    const chat = await savedChat()
    assert.ok(!chat.regenInProgress)
    await writeFile(join(output, 'regen-view-timeline.json'), JSON.stringify({ timeline, frames }, null, 2))
  })
}
