import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// DSH 0.2.1 reserves 65536 output tokens for a summary request by default, so no 32K window fits one
// (docs/design/compaction-retention.md 7.1), so scenarios that run a real summary use a 256K window; the fixed
// model's 4-characters-per-token pricing is unchanged and the fill-the-window padding scales with the window.
// legacy never summarizes and keeps 32K.
const overflowWindow = 131072
export const scenarioWindow = scenario => scenario === 'legacy' ? 32768 : 262144

export async function compactionChecks({ page, step, savedChat, output, report, restartServer, installLegacyFixture, scenario }) {
  // Browser template bookkeeping may finish asynchronously; compare durable
  // business facts, not renderer cache metadata.
  const history = chat => chat.messages.map(({ role, turn, text, sourceText, swipes, swipeId, variables, mvu }) => ({ role, turn, text, sourceText, swipes, swipeId, variables, receipt: mvu?.receipt }))
  const initial = await savedChat(), sessionId = initial.sessionId
  let round = 1
  const requests = async () => (await readFile(join(output, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  async function until(read, check, label) {
    const end = Date.now() + 30000
    while (Date.now() < end) { const value = await read(); if (check(value)) return value; await delay(100) }
    throw Error('Timed out: ' + label)
  }
  // Every rewrite keeps the scenario's window (a missing window means 32K to the fixed model).
  const control = values => writeFile(join(output, 'model-control.json'), JSON.stringify({ foregroundPadding: 650, backgroundPadding: 0, window: scenarioWindow(scenario), ...values }))
  async function play(extra = '') {
    round++
    const composer = page.getByRole('textbox', { name: /发消息|Message/ })
    await composer.fill(`E2E_C_ROUND_${round} 继续领取任务奖励。${extra}`)
    await composer.press('Enter')
    await page.getByText(`压缩验收第 ${round} 轮，金币 ${round * 10}。`, { exact: false }).filter({ visible: true }).first().waitFor()
    await page.frameLocator('.dsh-tavern-status-runtime iframe').locator('#e2e-gold').filter({ hasText: new RegExp(`^金币：${round * 10}$`) }).waitFor()
    const chat = await until(savedChat, chat => chat.messages.at(-1)?.mvu?.receipt?.status === 'updated' && chat.posture === '站在柜台前，收下奖励。', 'settlement')
    assert.equal(chat.id, initial.id); assert.equal(chat.sessionId, sessionId)
    assert.equal(chat.messages.filter(m => m.role === 'user').length, round)
    assert.equal(chat.messages.filter(m => m.role === 'assistant' && !m.greeting).length, round)
    assert.equal(chat.messages.at(-1).variables[0].stat_data.gold, round * 10)
    return chat
  }
  async function compact(status = 'completed') {
    const previous = (await savedChat()).contextCompaction?.operation?.id
    await page.getByRole('button', { name: '更多 ▾', exact: true }).click()
    await page.getByRole('menuitem', { name: /压缩上下文|前台和后台已压缩|前台已压缩/ }).click()
    return (await until(savedChat, chat => chat.contextCompaction?.operation?.id !== previous && chat.contextCompaction?.operation?.status === status, `compaction ${status}`)).contextCompaction.operation
  }
  if (scenario === 'manual') {
    await step('积累三轮真实剧情，为摘要及保留尾部留出空间', async () => { await play(); await play() })
    let previous = await savedChat()
    for (let cycle = 1; cycle <= 2; cycle++) {
      await step(`第 ${cycle} 次手动联合压缩，随后继续游玩`, async () => {
        const before = await savedChat(), count = (await requests()).length
        const operation = await compact()
        assert.equal(operation.foreground.status, 'succeeded'); assert.equal(operation.background.status, 'succeeded')
        assert.equal(operation.backgroundSessionId, before.timeline.participants.background.sessionId)
        assert.deepEqual(history(await savedChat()), history(before), '压缩不能改变历史正文和变量')
        const compactions = (await requests()).slice(count).filter(row => row.purpose === 'compaction')
        assert.deepEqual(compactions.map(row => row.side).sort(), ['background', 'foreground'])
        if (cycle === 2) for (const row of compactions.filter(item => item.side === 'foreground')) {
          assert.ok(row.summaryPresent, '第二次压缩必须包含上一次摘要')
          assert.ok(!row.rawRounds.includes(1), '第二次压缩不能复活首轮旧正文')
        }
        const nextStart = (await requests()).length
        previous = await play()
        const next = (await requests()).slice(nextStart).filter(row => row.purpose === 'generation')
        for (const side of ['foreground', 'background']) {
          const row = next.find(item => item.side === side)
          assert.ok(row, '继续游玩必须调用 ' + side)
          // Settlement intentionally rewinds its previous task (rewindTo: -1)
          // and receives the current authoritative state, not past summaries.
          if (side === 'foreground') assert.ok(row.summaryPresent, '前台下一轮必须携带摘要')
          assert.ok(!row.rawRounds.includes(1), '压缩后的请求不得重新包含首轮旧正文')
        }
        report[`manual-${cycle}`] = operation
        previous = await play()
      })
    }
    await step('后台总结失败：前台成功保留，重试只处理后台', async () => {
      await control({ failSide: 'background' })
      const failed = await compact('partial')
      assert.equal(failed.foreground.status, 'succeeded'); assert.equal(failed.background.status, 'failed')
      assert.deepEqual(history(await savedChat()), history(previous))
      await page.reload()
      await page.getByText(/上下文压缩未全部完成/).filter({ visible: true }).first().waitFor()
      const start = (await requests()).length
      await control({})
      const recovered = await compact()
      assert.equal(recovered.foreground.after, failed.foreground.after, '成功侧不应重复压缩')
      assert.deepEqual((await requests()).slice(start).filter(row => row.purpose === 'compaction').map(row => row.side), ['background'])
      await play()
      report.partialRecovery = { failed, recovered }
    })
    await step('联合压缩期间提交下一轮，任务不丢失且不重复结算', async () => {
      await control({ delayMs: 1800 })
      const requestCount = (await requests()).length
      const pending = compact()
      // Attach rejection immediately while the UI submits another action.
      const completion = pending.then(value => ({ value }), error => ({ error }))
      // 'running' is persisted before native dispatch. Wait for the actual
      // summarizer request, so this tests an in-flight compaction rather than
      // a new message winning the pre-dispatch idle check.
      await until(requests, rows => rows.slice(requestCount).some(row => row.purpose === 'compaction' && row.side === 'foreground'), 'summarizer in progress')
      await play()
      const result = await completion
      if (result.error) throw result.error
      assert.equal(result.value.status, 'completed')
      await control({})
      report.queuedDuringCompaction = result.value
    })
  } else if (scenario === 'retain') {
    // Keep the latest 2 rounds as real nodes (docs/design/compaction-retention.md):
    // they stay operable after compaction, summaries are written as volumes.
    const prompt = (await readFile(new URL('../../tavern-plugin/prompts/story-compaction.md', import.meta.url), 'utf8')).trimEnd()
    const refusal = /已不在当前上下文|不在可回退的消息流|找不到与当前剧情轮次|checkout 锚点|归属不一致|已被压缩|操作失败/
    const users = chat => chat.messages.filter(m => m.role === 'user').length
    const lastBody = chat => { const m = chat.messages.findLast(m => m.role === 'assistant' && !m.greeting); return String(m.sourceText ?? m.text) }
    const visibleBody = text => page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor()
    async function settled(check, label) {
      return until(savedChat, chat => { if (chat.regenInProgress || ['pending', 'running'].includes(chat.settleStatus)) return false; try { return check(chat) !== false } catch { return false } }, label)
    }
    async function menu(name) {
      await page.getByRole('button', { name: '更多 ▾', exact: true }).click()
      await page.getByRole('menuitem', { name }).click()
    }
    async function regenerate(tag) {
      await page.getByRole('button', { name: '重新生成正文', exact: true }).click()
      await page.getByPlaceholder('指导意见（可选）：例如“写得更长，侧重心理描写”').fill('E2E_REROLL_' + tag)
      await page.getByRole('button', { name: '生成并替换正文', exact: true }).click()
      return settled(chat => lastBody(chat).includes(`（重写 ${tag}）`), 'regenerate ' + tag)
    }
    const noRefusal = async () => assert.equal(await page.getByText(refusal).filter({ visible: true }).count(), 0, '界面不能出现拒绝提示')
    const textsOf = message => (message.content || []).filter(block => block.type === 'text').map(block => block.text)
    const checkpointTexts = row => textsOf(row.messages.find(message => textsOf(message).some(text => text.includes('<compacted-summary>'))) || {})
    let volume1
    await step('保留 2 轮：玩到第 4 轮，在第 4 轮重新生成留下压缩前的变体', async () => {
      await play(); await play(); await play()
      await regenerate('A')
      await visibleBody('（重写 A）')
      await noRefusal()
    })
    await step('第 1 次手动压缩：只总结第 1–2 轮，提示词和卷首行由程序给出', async () => {
      const count = (await requests()).length
      const before = await savedChat()
      const operation = await compact()
      assert.equal(operation.foreground.status, 'succeeded')
      assert.match(operation.foreground.message, /保留最近 2 轮原文/)
      assert.deepEqual(history(await savedChat()), history(before), '压缩不能改变历史正文和变量')
      const summary = (await requests()).slice(count).find(row => row.purpose === 'compaction' && row.side === 'foreground')
      assert.deepEqual(summary.rawRounds.sort(), [1, 2], '摘要请求只含被压缩的轮次，保留的第 3–4 轮不在其中')
      const instruction = textsOf(summary.messages.at(-1)).join('')
      assert.ok(instruction.startsWith(prompt + '\n\n【本次摘要的写法】'), '默认剧情提示词在前，程序的写法要求在后')
      const header = instruction.match(/第一行单独写「(第 1 卷 · 第 \d+–\d+ 轮)」/)?.[1]
      assert.ok(header, '指令给出第 1 卷的卷首行')
      assert.doesNotMatch(instruction, /当前情况|tavern_recall_history/)
      report.retainFirst = { header, message: operation.foreground.message, rawRounds: summary.rawRounds }
    })
    await step('压缩后切换到压缩前存下的变体、再切回；回退第 4 轮并撤销；再次重新生成', async () => {
      await page.getByRole('group', { name: '正文变体' }).waitFor()
      await page.getByRole('button', { name: '上一个变体', exact: true }).click()
      await settled(chat => !lastBody(chat).includes('（重写'), 'switch to the older variant')
      await page.getByRole('button', { name: '下一个变体', exact: true }).click()
      await settled(chat => lastBody(chat).includes('（重写 A）'), 'switch back')
      const start = await savedChat()
      await menu(/回退第.*轮|回退本轮/)
      await settled(chat => users(chat) === users(start) - 1, 'rollback round 4')
      await menu(/撤销回退（恢复第/)
      await settled(chat => users(chat) === users(start) && lastBody(chat).includes('（重写 A）'), 'undo rollback')
      await regenerate('B')
      await noRefusal()
      report.retainOperations = { rounds: users(await savedChat()) }
    })
    await step('继续游玩：请求携带第 1 卷摘要和保留的原文，不复活已压缩的轮次', async () => {
      const start = (await requests()).length
      await play()
      const next = (await requests()).slice(start).find(row => row.purpose === 'generation' && row.side === 'foreground')
      assert.ok(next.summaryPresent)
      assert.ok(!next.rawRounds.includes(1) && !next.rawRounds.includes(2), '已压缩的第 1–2 轮不能复活')
      assert.ok(next.rawRounds.includes(3) && next.rawRounds.includes(4), '保留的第 3–4 轮仍是原文')
      const blocks = checkpointTexts(next)
      assert.ok(blocks[1].startsWith('【剧情摘要说明】'), '摘要说明在最前')
      assert.match(blocks[1], /用 tavern_recall_history 按关键词或轮次查原文/, '前台确有查原文工具，说明指向它')
      volume1 = blocks[2]
      assert.ok(volume1.startsWith(report.retainFirst.header + '\n'), '第 1 卷首行由程序写入')
      await play(); await play()
    })
    await step('第 2 次手动压缩：旧卷原样保留，新卷只写旧卷之后', async () => {
      const count = (await requests()).length
      const operation = await compact()
      assert.equal(operation.foreground.status, 'succeeded')
      const summary = (await requests()).slice(count).find(row => row.purpose === 'compaction' && row.side === 'foreground')
      assert.deepEqual(summary.rawRounds.sort(), [3, 4, 5])
      const instruction = textsOf(summary.messages.at(-1)).join('')
      assert.match(instruction, /已有 1 卷旧摘要/)
      const header = instruction.match(/第一行单独写「(第 2 卷 · 第 \d+–\d+ 轮)」/)?.[1]
      assert.ok(header)
      const through1 = Number(report.retainFirst.header.match(/–(\d+) 轮/)[1]), from2 = Number(header.match(/第 (\d+)–/)[1])
      assert.equal(from2, through1 + 1, '第 2 卷从第 1 卷之后一轮开始')
      const start = (await requests()).length
      await play()
      const next = (await requests()).slice(start).find(row => row.purpose === 'generation' && row.side === 'foreground')
      const blocks = checkpointTexts(next)
      assert.equal(blocks[2], volume1, '第 1 卷逐字节原样保留')
      assert.ok(blocks[3].startsWith(header + '\n'))
      assert.ok(!next.rawRounds.some(n => n <= 5), '已压缩的轮次不能复活')
      report.retainSecond = { header, volumes: blocks.length - 3 }
      // The retained rounds are still operable after the second compaction.
      const before = await savedChat()
      await menu(/回退第.*轮|回退本轮/)
      await settled(chat => users(chat) === users(before) - 1, 'rollback after second compaction')
      await menu(/撤销回退（恢复第/)
      await settled(chat => users(chat) === users(before), 'undo after second compaction')
      await noRefusal()
    })
  } else if (scenario === 'legacy') {
    await step('关闭宿主，放入已编辑且压缩的 v0 旧档，再通过启动迁移打开', async () => {
      const before = await savedChat()
      await installLegacyFixture()
      assert.deepEqual(history(await savedChat()), history(before))
    })
    await step('迁移后继续游玩，确认实际模型只读摘要、不复活已压缩原文', async () => {
      const start = (await requests()).length
      await play()
      const next = (await requests()).slice(start).find(row => row.purpose === 'generation' && row.side === 'foreground')
      assert.ok(next?.summaryPresent, '迁移后的真实请求必须携带旧摘要')
      assert.ok(!JSON.stringify(next.messages).includes('OLD_STORY_SHOULD_STAY_ARCHIVED'))
      report.legacyRecovery = { summaryPresent: next.summaryPresent, archivedTextInRequest: false }
    })
  } else if (scenario === 'overflow') {
    await step('在较大窗口真实游玩三轮，再切换到更小的 128K 窗口', async () => {
      await play(); await play()
      // 128K = 65536 summary output reserve (DSH 0.2.1) + room for one segment; the three rounds hold ~100K tokens.
      await control({ window: overflowWindow })
    })
    await step('从游玩菜单恢复超窗口历史，核对分段预算及原始剧情', async () => {
      const before = await savedChat(), start = (await requests()).length
      const operation = await compact()
      assert.equal(operation.foreground.status, 'succeeded')
      assert.equal(operation.background.status, 'succeeded')
      assert.deepEqual(history(await savedChat()), history(before))
      const chunks = (await requests()).slice(start).filter(row => row.purpose === 'compaction' && row.side === 'foreground')
      assert.ok(chunks.length > 1, '必须分段调用，不能只更改成功提示')
      assert.ok(chunks.every(row => row.inputTokens + row.outputReserve <= overflowWindow))
      const nextStart = (await requests()).length
      await play()
      const resumed = (await requests()).slice(nextStart).find(row => row.purpose === 'generation' && row.side === 'foreground')
      assert.ok(resumed?.summaryPresent)
      assert.ok(!resumed.rawRounds.includes(1))
      report.overflowRecovery = { operation, chunks: chunks.map(({ messages, ...row }) => row) }
    })
  } else {
    await step(`${scenario} 自动压缩，确认前后台仍能完成当前轮`, async () => {
      // The fill-the-window scenarios scale the padding with the window (the fixtures were written for 32K). The
      // background request has a fixed ~10K-token base, so its padding is chosen so the third reasoning step is the
      // one that crosses the 256K boundary, as the third step crossed 32K before (two steps must still fit).
      const scale = scenarioWindow(scenario) / 32768
      await control({ foregroundPadding: scenario === 'background' ? 0 : scenario === 'both' ? 24000 : 1700 * scale, backgroundPadding: ['foreground', 'rounds'].includes(scenario) ? 0 : 56000 })
      const start = (await requests()).length
      for (let n = 0; n < 6; n++) {
        await play()
        if ((await requests()).slice(start).some(row => row.purpose === 'compaction')) break
      }
      const compacted = (await requests()).slice(start).filter(row => row.purpose === 'compaction')
      assert.ok(compacted.length, '达到阈值必须真正调用总结模型')
      if (scenario === 'background') {
        assert.ok(compacted.some(row => row.side === 'background'), '后台容量保护必须触发')
        assert.ok(!compacted.some(row => row.side === 'foreground'), '仅后台压力不应压缩前台')
      }
      if (scenario === 'foreground') assert.equal(compacted[0].side, 'foreground')
      if (scenario === 'rounds') {
        const chat = await until(savedChat, chat => chat.contextCompaction?.operation?.status === 'completed', 'round policy completion')
        assert.equal(chat.contextCompaction.operation.reason, 'rounds')
        assert.equal(chat.contextCompaction.operation.foreground.status, 'succeeded')
        assert.equal(chat.contextCompaction.operation.background.status, 'succeeded')
      }
      await play()
      if (scenario === 'both') assert.deepEqual([...new Set((await requests()).slice(start).filter(row => row.purpose === 'compaction').map(row => row.side))].sort(), ['background', 'foreground'])
      if (['foreground', 'both'].includes(scenario)) {
        const chat = await until(savedChat, chat => chat.contextCompaction?.operation?.status === 'completed', 'percent policy completion')
        assert.equal(chat.contextCompaction.operation.reason, 'percent')
        assert.equal(chat.contextCompaction.operation.foreground.status, 'succeeded')
        assert.equal(chat.contextCompaction.operation.background.status, 'succeeded')
        report.autoOperation = chat.contextCompaction.operation
      }
      report.automatic = compacted.map(({ messages, ...row }) => row)
    })
  }
  await step('重启真实宿主后检查剧情、金币和会话绑定', async () => {
    const before = await savedChat()
    await restartServer()
    await page.getByText(`压缩验收第 ${round} 轮，金币 ${round * 10}。`, { exact: false }).filter({ visible: true }).first().waitFor()
    await page.frameLocator('.dsh-tavern-status-runtime iframe').locator('#e2e-gold').filter({ hasText: new RegExp(`^金币：${round * 10}$`) }).waitFor()
    const after = await savedChat()
    assert.deepEqual(history(after), history(before))
    assert.equal(after.timeline.participants.background.sessionId, before.timeline.participants.background.sessionId)
    const start = (await requests()).length
    await play()
    const resumed = (await requests()).slice(start).filter(row => row.purpose === 'generation')
    if (['manual', 'overflow', 'legacy', 'retain'].includes(scenario)) {
      const foreground = resumed.find(row => row.side === 'foreground')
      assert.ok(foreground?.summaryPresent, '重启后下一轮请求仍须携带摘要')
      assert.ok(!foreground.rawRounds.includes(1), '重启后不能复活已总结的首轮正文')
    }
    const bound = before.timeline.participants.background.sessionId
    // A rollback after a joint compaction retires the compacted background session
    // (requiresNewSessionOnRewind); the next round then binds a fresh one.
    if (scenario === 'retain' && !bound) assert.match((await savedChat()).timeline.participants.background.sessionId, /^background-/, '回退后的下一轮新建后台会话')
    else assert.equal((await savedChat()).timeline.participants.background.sessionId, bound, '重启后继续使用原后台绑定')
    await page.screenshot({ path: join(output, 'compaction-after-reload.png'), fullPage: true })
    report.compaction = { scenario, window: scenarioWindow(scenario), rounds: round, foregroundSessionId: sessionId, backgroundSessionId: after.timeline.participants.background.sessionId }
  })
  if (scenario === 'retain') {
    // The foreground model calls the real tavern_recall_history tool (compaction-model.mjs, on E2E_RECALL_*).
    // By now round 1 (floor 2) is folded into volume 1, so its words are only in the Session log.
    const flat = messages => messages.flatMap(message => message.content || []).flatMap(block => block.type === 'text' ? [block.text] : block.type === 'tool-result' ? (block.content || []).map(item => item.text || '') : []).join('\n')
    const isRecallResult = message => message.toolCallId === `e2e-recall-${round}` || (message.content || []).some(block => block.type === 'tool-result' && block.toolCallId === `e2e-recall-${round}`)
    async function recalled(mode) {
      const before = await savedChat(), start = (await requests()).length
      await play(' E2E_RECALL_' + mode)
      const rows = (await requests()).slice(start).filter(row => row.purpose === 'generation' && row.side === 'foreground')
      assert.equal(rows.length, 2, '先调用查原文工具，拿到结果后再写正文：前台两次请求')
      const resultMessages = rows[1].messages.filter(isRecallResult)
      assert.equal(resultMessages.length, 1, '第二次请求带有工具结果')
      const text = flat(resultMessages)
      assert.ok(text.startsWith('【历史回忆资料】'), '结果以禁止重复演绎的提醒开头')
      assert.ok(text.length < 14000, '返回量有上限：' + text.length)
      // Earlier recall results stay on the surface as tool rows; only they may still hold round 1's words.
      const rest = JSON.stringify(rows[1].messages.filter(message => message.role !== 'tool' && !(message.content || []).some(block => block.type === 'tool-call')))
      assert.ok(!/E2E_RAW_ROUND_1\b/.test(rest), '第 1 轮已压缩，请求里除了工具结果没有它的原文')
      assert.ok(rows[1].summaryPresent)
      const after = await savedChat()
      assert.deepEqual(history(after).slice(0, history(before).length), history(before), '查原文不改历史正文和变量')
      return { text, after }
    }
    await step('查原文：按关键词查回已压缩楼层的原文（只读，不写冷却）', async () => {
      const { text, after } = await recalled('SEARCH')
      assert.match(text, /\[第 2 轮\]/); assert.match(text, /十枚金币/); assert.match(text, /E2E_RAW_ROUND_1/)
      assert.match(text, /关键词分布：\n「十枚金币」出现在第 2 轮（共 1 轮）/)
      assert.ok(!(after.historyRecallCooldowns || []).length, '搜索不登记冷却')
      report.recallSearch = { chars: text.length }
    })
    await step('查原文：按楼层号读取已压缩楼层的玩家输入与正文', async () => {
      const { text, after } = await recalled('TURN')
      assert.match(text, /【第 2 轮】\n\[玩家\]\n/); assert.match(text, /\[正文\]\n你获得了十枚金币。/); assert.match(text, /E2E_RAW_ROUND_1/)
      assert.deepEqual((after.historyRecallCooldowns || []).map(item => item.turn), [2], '完整读取登记 10 轮冷却')
      assert.equal(await page.getByText(/没有找到相关历史正文|检索失败/).filter({ visible: true }).count(), 0)
      report.recallTurn = { chars: text.length }
    })
  }
  const all = await requests()
  assert.ok(all.every(row => row.outcome !== 'overflow'), '正常验收不得发送超窗口请求')
  report.requestSummary = all.map(({ messages, ...row }) => row)
}
