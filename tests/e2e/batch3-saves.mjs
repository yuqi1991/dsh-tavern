import assert from 'node:assert/strict'
import { readdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createChatJournalStore } from '../../tavern-plugin/lib/domain/chat-journal-store.js'
import { parseSessionLog } from '../../tavern-plugin/lib/domain/legacy-session-migration.js'
import { readGameSave } from '../../tavern-plugin/lib/domain/game-save.js'

// 存档往返：真实 DSH + 酒馆 + 浏览器，固定模型。
// 打一局（含重新生成、切换变体、回退）→ 界面导出存档 → 界面导入为新游戏 → 继续/回退/重新生成/分叉 → 删除，并核对磁盘上没有残留。
export async function batch3SaveChecks({ page, step, data, root, output, report, errors, restartServer }) {
  const store = createChatJournalStore({ dataRoot: data })
  const gold = async value => {
    // A running background agent can bring its Tasks tab forward; the status card lives in the other tab.
    const frame = page.locator('.dsh-tavern-status-runtime iframe >> visible=true')
    if (!await frame.first().isVisible().catch(() => false)) await page.getByText('酒馆状态', { exact: true }).filter({ visible: true }).first().click()
    await page.frameLocator('.dsh-tavern-status-runtime iframe >> visible=true').locator('#e2e-gold').filter({ hasText: new RegExp('^金币：' + value + '$') }).waitFor()
  }
  const visibleText = text => page.getByText(text, { exact: true }).filter({ visible: true }).first()
  const games = async () => {
    const ids = await readdir(join(data, 'chats')).catch(() => [])
    const rows = await Promise.all(ids.map(id => store.read(id).catch(() => null)))
    return rows.filter(chat => chat && chat.mode !== 'card' && Array.isArray(chat.messages))
  }
  const replies = chat => chat.messages.filter(message => message.role === 'assistant' && !message.greeting)
  // Every native session file on disk, by the session id in its header.
  const nativeSessions = async () => {
    const base = join(root, 'profile-data/tavern/sessions')
    const files = (await readdir(base, { recursive: true }).catch(() => [])).filter(file => /session\.v[34]\.jsonl\.zstd$/.test(file))
    const ids = []
    for (const file of files) ids.push(parseSessionLog(await readFile(join(base, file))).header.id)
    return ids
  }
  const sceneDirs = () => readdir(join(data, 'scene-images')).catch(() => [])
  const until = async (describe, check, ms = 30000) => {
    const deadline = Date.now() + ms
    let last
    while (Date.now() < deadline) { last = await check(); if (last) return last; await new Promise(resolve => setTimeout(resolve, 300)) }
    assert.fail('等待超时：' + describe)
  }
  const importedReplies = async () => replies((await games()).find(chat => chat.id === imported.id) || { messages: [] })
  const composer = () => page.getByRole('textbox', { name: /发消息|Message/ })
  const moreMenu = async name => {
    await page.getByRole('button', { name: '更多 ▾', exact: true }).click()
    await page.getByRole('menuitem', { name }).click()
  }
  const downloadSave = async file => {
    await page.getByRole('button', { name: /^导出/ }).first().click()
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: '存档', exact: true }).click()])
    assert.match(download.suggestedFilename(), /\.dshsave$/)
    await download.saveAs(file)
    return readGameSave(await readFile(file))
  }
  const importSave = async file => {
    await page.getByRole('button', { name: /选择人物卡.*新开游玩/ }).click()
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '导入存档', exact: true }).click()])
    await chooser.setFiles(file)
    await page.getByRole('textbox', { name: /发消息|Message/ }).waitFor()
  }
  let original, saveA, saveB, imported
  const fileA = join(output, 'game-a.dshsave'), fileB = join(output, 'game-b.dshsave')

  await step('存档前：打第二轮、重新生成、切回上一变体', async () => {
    await composer().fill('再次领取奖励')
    await composer().press('Enter')
    await visibleText('你再次领取了奖励，金币累计二十枚。').waitFor()
    await gold(20)
    await page.getByRole('button', { name: '重新生成正文', exact: true }).click()
    await page.getByPlaceholder('指导意见（可选）：例如“写得更长，侧重心理描写”').fill('雨夜重写')
    await page.getByRole('button', { name: '生成并替换正文', exact: true }).click()
    await visibleText('雨夜里，你重新领取了奖励。').waitFor()
    await gold(30)
    await page.getByRole('button', { name: '上一个变体', exact: true }).click()
    await visibleText('你再次领取了奖励，金币累计二十枚。').waitFor()
    await gold(20)
    const [chat] = await games()
    original = chat
    assert.equal(replies(chat).length, 2)
  })

  await step('界面导出存档：下载 .dshsave，内容是这一局当前的状态', async () => {
    saveA = await downloadSave(fileA)
    assert.equal(saveA.chat.id, original.id)
    assert.equal(saveA.chat.messages.length, original.messages.length)
    assert.ok(saveA.session.events.some(event => event.type === 'turn/end'))
    assert.ok(saveA.card?.payload, '存档带着人物卡')
    report.saveA = { revisions: saveA.revisions.length, events: saveA.session.events.length, selects: saveA.session.events.filter(event => event.type === 'dsh-tavern/surface-select').length }
  })

  await step('回退一轮后再导出一份（含回退产生的历史）', async () => {
    await moreMenu(/回退第.*轮|回退本轮/)
    await gold(10)
    saveB = await downloadSave(fileB)
    assert.equal(replies(saveB.chat).length, 1)
    report.saveB = { revisions: saveB.revisions.length, events: saveB.session.events.length, selects: saveB.session.events.filter(event => event.type === 'dsh-tavern/surface-select').length }
  })

  await step('界面导入第一份存档：成为一局新游戏，原游戏不受影响', async () => {
    const sessionsBefore = await nativeSessions()
    await importSave(fileA)
    await visibleText('你再次领取了奖励，金币累计二十枚。').waitFor()
    await gold(20)
    const all = await games()
    assert.equal(all.length, 2, '导入产生新游戏，不覆盖原游戏')
    imported = all.find(chat => chat.id !== original.id)
    assert.notEqual(imported.sessionId, original.sessionId)
    assert.match(imported.title, /（导入）$/)
    assert.equal(replies(imported).length, 2)
    assert.equal(replies(imported).at(-1).swipes?.length, replies(saveA.chat).at(-1).swipes?.length, '变体数量与存档一致')
    assert.equal(replies(imported).at(-1).swipeId || 0, replies(saveA.chat).at(-1).swipeId || 0, '当前变体与存档一致')
    assert.equal(replies(imported).at(-1).variables[replies(imported).at(-1).swipeId || 0].stat_data.gold, 20)
    const originalNow = all.find(chat => chat.id === original.id)
    assert.equal(replies(originalNow).length, 1, '原游戏停在回退后的一轮')
    assert.equal((await nativeSessions()).length, sessionsBefore.length + 1, '只多出导入游戏自己的原生会话')
    const leaks = []
    const scan = (value, where) => {
      if (typeof value === 'string') { if (value.includes(original.id) || value.includes(original.sessionId)) leaks.push(where + ' = ' + value.slice(0, 120)) }
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) scan(child, where + '.' + key)
    }
    // importedSave is the deliberate provenance record.
    scan({ ...imported, importedSave: undefined }, 'chat')
    assert.deepEqual(leaks, [], '导入的游戏不留原编号')
  })

  await step('导入的游戏可以继续：切换变体、回退、重新生成都正常', async () => {
    // The save carries both variants of round 2; switching must work on the rebuilt native session.
    await page.getByLabel('正文变体').first().waitFor()
    await page.getByRole('button', { name: '下一个变体', exact: true }).click()
    await visibleText('雨夜里，你重新领取了奖励。').waitFor()
    await gold(30)
    await page.getByRole('button', { name: '上一个变体', exact: true }).click()
    await visibleText('你再次领取了奖励，金币累计二十枚。').waitFor()
    await gold(20)
    await composer().fill('向店主道谢')
    await composer().press('Enter')
    await page.locator('.dsh-tavern-user-bubble').filter({ hasText: '向店主道谢' }).first().waitFor()
    await until('第三轮正文落盘', async () => (await importedReplies()).length === 3)
    await moreMenu(/回退第.*轮|回退本轮/)
    await until('回退后剩两轮', async () => (await importedReplies()).length === 2)
    await visibleText('你再次领取了奖励，金币累计二十枚。').waitFor()
    await gold(20)
    await page.getByRole('button', { name: '重新生成正文', exact: true }).click()
    await page.getByPlaceholder('指导意见（可选）：例如“写得更长，侧重心理描写”').fill('雨夜重写')
    await page.getByRole('button', { name: '生成并替换正文', exact: true }).click()
    await visibleText('雨夜里，你重新领取了奖励。').waitFor()
    await gold(30)
    assert.equal((await importedReplies()).length, 2, '重新生成不新增轮次')
  })

  let fork, pendingDoomed = []
  const doomedKeys = []
  await step('从导入的游戏分叉出另一局', async () => {
    await page.getByRole('button', { name: '从这一轮分叉', exact: true }).last().click()
    await page.getByRole('dialog').getByRole('button', { name: /确定|分叉|确认|创建/ }).click().catch(() => {})
    for (let waited = 0; waited < 30000; waited += 500) { if ((await games()).length === 3) break; await new Promise(resolve => setTimeout(resolve, 500)) }
    const all = await games()
    assert.equal(all.length, 3, '分叉产生第三局')
    fork = all.find(chat => ![original.id, imported.id].includes(chat.id))
  })

  await step('导入第二份（回退后的）存档', async () => {
    await importSave(fileB)
    await gold(10)
    const all = await games()
    assert.equal(all.length, 4)
    const second = all.find(chat => ![original.id, imported.id, fork.id].includes(chat.id))
    assert.equal(replies(second).length, 1)
  })

  await step('本机没有这张人物卡时，导入存档会从存档里带回人物卡', async () => {
    // Like a save carried to another computer: the card is gone here, only the save has it.
    await rm(join(data, 'resources/cards/e2e.json'), { force: true })
    await rm(join(data, 'originals/cards/e2e.json'), { force: true })
    await importSave(fileA)
    await gold(20)
    await access(join(data, 'resources/cards/e2e.json'))
    assert.equal((await games()).length, 5, '同一份存档再导入一次也是新游戏，不与之前的冲突')
  })

  await step('删除导入和分叉的游戏：磁盘上没有残留，原游戏保持完好', async () => {
    const keepIds = new Set([original.id])
    const doomed = (await games()).filter(chat => !keepIds.has(chat.id))
    const doomedSessions = doomed.map(chat => chat.sessionId)
    // Every name a deleted game's files could carry: its ids and the hashes of them.
    const sha = value => createHash('sha256').update(value).digest('hex')
    for (const chat of doomed) {
      const ids = [chat.id, chat.sessionId, chat.timeline?.participants?.background?.sessionId, ...(chat.backgroundHistoryIds || []), chat.candidates?.traceSessionId, ...(chat.candidates?.traceSessionIds || [])].filter(Boolean)
      for (const id of ids) doomedKeys.push(id, sha(id))
    }
    // Rows are newest first, so the original game (opened longest ago) is the last row; delete from the top.
    for (let index = 0; index < doomed.length; index += 1) {
      const before = (await games()).length
      const group = page.locator('.dsh-tavern-history-group-toggle').filter({ hasText: 'E2E 奖励验收' })
      if (await group.count() && await group.first().getAttribute('aria-expanded') === 'false') await group.first().click()
      const target = page.locator('.dsh-tavern-side-row').first()
      await target.hover()
      await target.locator('.dsh-tavern-side-row-more').click()
      await target.getByRole('button', { name: '删除', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: /确定|删除|确认/ }).click()
      await until('游戏已删除', async () => (await games()).length === before - 1)
    }
    const left = await games()
    assert.deepEqual(left.map(chat => chat.id), [original.id], '只剩原游戏')
    report.deletedSessions = doomedSessions.length
    pendingDoomed = doomedSessions
    // Native session logs are removed at delete time; a session DSH still holds loaded is queued
    // and removed on the next start, before anything can load (and write back) it.
    const leftovers = (await nativeSessions()).filter(id => doomedSessions.includes(id))
    const queued = JSON.parse(await readFile(join(data, 'pending-session-deletions.json'), 'utf8').catch(() => '[]'))
    report.deletedLeftoversQueued = leftovers.length
    for (const id of leftovers) assert.ok(queued.some(target => target.includes(id)), '已删除游戏的原生会话既没删除也没排队：' + id)
    const dirs = await sceneDirs()
    report.sceneDirsLeft = dirs.length
    report.sceneDirNames = dirs
    const chatsDir = await readdir(join(data, 'chats'))
    assert.equal(chatsDir.length, 1, '对话目录只剩原游戏：' + chatsDir.join(','))
  })

  await step('重启后排队的会话被清掉，没有写回', async () => {
    const doomedSessions = pendingDoomed
    await restartServer()
    await until('排队的原生会话已删除', async () => !(await nativeSessions()).some(id => doomedSessions.includes(id)))
    const queued = JSON.parse(await readFile(join(data, 'pending-session-deletions.json'), 'utf8').catch(() => '[]'))
    assert.deepEqual(queued, [], '排队清单已清空')
    // Nothing named after a deleted game may remain anywhere under the Tavern data or sessions.
    const offenders = []
    for (const base of [data, join(root, 'profile-data/tavern/sessions')]) {
      for (const name of await readdir(base, { recursive: true }).catch(() => [])) {
        if (name.includes('pending-session-deletions')) continue
        if (doomedKeys.some(key => name.includes(key))) offenders.push(name)
      }
    }
    // Registrations and indexes must not keep naming them either.
    for (const name of (await readdir(data)).filter(name => name.endsWith('.json'))) {
      if (name === 'pending-session-deletions.json') continue
      const text = await readFile(join(data, name), 'utf8')
      if (doomedKeys.some(key => text.includes(key))) offenders.push(name + '（内容）')
    }
    assert.deepEqual(offenders, [], '已删除游戏在磁盘上留下了文件')
  })

  await step('原游戏重新打开仍然完整', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await gold(10)
    const [chat] = await games()
    assert.equal(chat.id, original.id)
    assert.equal(replies(chat).length, 1)
    await access(fileA)
  })
  assert.deepEqual(errors, [], '浏览器不得出现未捕获异常')
}
