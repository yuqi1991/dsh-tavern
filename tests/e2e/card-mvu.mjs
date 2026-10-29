import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateCardText } from '../../tavern-plugin/lib/domain/card-validation.js'

// Fixed-model e2e for the card workbench MVU route: the model's tool calls are scripted
// (tests/e2e/model.mjs), the tools, saves and format checks run for real.
const card = data => ({ spec: 'chara_card_v2', spec_version: '2.0', data })
const legacyStatus = (place, gold) => '\n\n<状态>\n地点：' + place + '\n金币：' + gold + '\n</状态>'

export async function writeCardMvuFixtures(data) {
  const directory = join(data, 'resources/cards')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'e2e-legacy.json'), JSON.stringify(card({
    name: '旧书店', description: '旧书店老板', first_mes: '欢迎来到旧书店。' + legacyStatus('旧书店', 10),
    alternate_greetings: ['清晨的集市。' + legacyStatus('集市', 5)], mes_example: '', scenario: '', personality: '',
    character_book: { name: '旧书店书', entries: [
      { id: 1, keys: [], comment: '状态栏输出格式', content: '每轮回复末尾输出 <状态>…</状态> 状态块，写明地点与金币。', enabled: true, constant: true, insertion_order: 1 },
      { id: 2, keys: ['书'], comment: '旧书店', content: '店里有很多书。', enabled: true, constant: false, insertion_order: 2 }] },
    extensions: { regex_scripts: [
      { id: 'old-status', scriptName: '旧状态栏', findRegex: '/<状态>[\\s\\S]*?<\\/状态>/g', replaceString: '```html\n<div class="old">旧状态</div>\n```', placement: [2], markdownOnly: true, disabled: false },
      { id: 'phone-skin', scriptName: '手机美化', findRegex: '/<phone>/g', replaceString: '<div class="phone">phone</div>', placement: [2], disabled: false }] }
  })))
  await writeFile(join(directory, 'e2e-new.json'), JSON.stringify(card({
    name: '新卡', description: '新建的卡', first_mes: '清晨，你在林间小屋醒来。', alternate_greetings: [], mes_example: '', scenario: '', personality: ''
  })))
  await writeFile(join(directory, 'e2e-managed.json'), JSON.stringify(card({
    name: '托管卡', description: '草稿转换产物', first_mes: '开场。', alternate_greetings: [], mes_example: '', scenario: '', personality: '',
    extensions: { dsh_mvu_conversion: { version: 1, sourcePath: 'cards/e2e-managed.json', selfSourced: true } }
  })))
}

export async function cardMvuChecks({ page, step, data, output, report }) {
  const read = async name => {
    const document = JSON.parse(await readFile(join(data, 'resources/cards', name), 'utf8'))
    return document.raw?.data || document.data || document.raw
  }
  const requests = async () => (await readFile(join(output, 'card-mvu-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const composer = () => page.getByRole('textbox', { name: /发消息|Message/ })
  const initvar = text => JSON.parse(/<initvar>([\s\S]*?)<\/initvar>/.exec(text)[1])
  const diskReport = async name => validateCardText(await readFile(join(data, 'resources/cards', name), 'utf8'))
  async function say(text, done) {
    await composer().fill(text); await composer().press('Enter')
    await page.getByText(done, { exact: true }).filter({ visible: true }).first().waitFor()
  }
  await step('卡片工作台工具表含 tavern_mvu_overview / tavern_apply_mvu', async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('dsh-tavern-adjust-card-style', { detail: { card: { path: 'cards/e2e-legacy.json', name: '旧书店' } } })))
    await page.getByText('已创建：旧书店', { exact: true }).filter({ visible: true }).first().waitFor()
    await say('E2E_MVU_CONVERT 把这张旧卡转成 MVU', 'E2E_MVU_CONVERT 完成。')
    const tools = (await requests()).at(-1).tools
    for (const name of ['tavern_mvu_overview', 'tavern_apply_mvu', 'tavern_replace_card_text', 'tavern_read_card']) assert.ok(tools.includes(name), name)
  })
  await step('旧卡转换：概览→写入，开场末尾、条目、正则按约定落盘，旧状态协议被清理，无关美化保留', async () => {
    const data0 = await read('e2e-legacy.json')
    const greetings = [data0.first_mes, ...data0.alternate_greetings]
    assert.equal(greetings.length, 2)
    for (const text of greetings) {
      assert.match(text, /<\/initvar>\n\n<mvu-status\/>$/)
      assert.doesNotMatch(text, /<状态>/, '旧状态块已从开场删除')
    }
    assert.match(greetings[0], /^欢迎来到旧书店。\n\n<initvar>/)
    assert.deepEqual([initvar(greetings[0]).地点, initvar(greetings[1]).地点, initvar(greetings[1]).状态.金币], [{ 名称: '旧书店' }, { 名称: '集市' }, 5])
    assert.equal(initvar(greetings[0]).$meta.strictSet, true)
    const titles = data0.character_book.entries.map(entry => entry.comment)
    assert.deepEqual(titles.filter(title => !title.startsWith('[')), ['旧书店'], '旧状态说明条目被删除，普通条目保留')
    assert.ok(titles.some(title => /^\[mvu_update\]/.test(title)) && titles.some(title => /^\[initvar\]/.test(title)))
    const ids = data0.extensions.regex_scripts.map(rule => rule.id)
    assert.deepEqual(ids.filter(id => !id.startsWith('dsh-mvu-')), ['phone-skin'], '旧状态正则被删除，手机美化保留')
    assert.ok(ids.includes('dsh-mvu-status-view') && ids.includes('dsh-mvu-hide-marker'))
    const view = data0.extensions.regex_scripts.find(rule => rule.id === 'dsh-mvu-status-view')
    assert.match(view.replaceString, /legacy-panel/)
    const result = await diskReport('e2e-legacy.json')
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors))
    // The tool result the model saw carries the same format check.
    const last = JSON.stringify((await requests()).at(-1).messages)
    assert.match(last, /已写入 MVU/); assert.match(last, /已清理旧协议/)
    report.cardMvuConvert = { greetings: 2, validationErrors: result.errors.length, warnings: result.warnings.map(item => item.message) }
  })
  await step('新建卡直接启用 MVU：原卡上写入，生成标准面板，开场正文不动', async () => {
    await say('E2E_MVU_NEW 给新卡加 MVU', 'E2E_MVU_NEW 完成。')
    const data1 = await read('e2e-new.json')
    assert.match(data1.first_mes, /^清晨，你在林间小屋醒来。\n\n<initvar>/)
    assert.deepEqual(initvar(data1.first_mes).状态, { 体力: 80 })
    const panel = data1.extensions.regex_scripts.find(rule => rule.id === 'dsh-mvu-status-view').replaceString
    assert.match(panel, /data-mvu="\/时间\/时段"/); assert.match(panel, /data-mvu-width="\/状态\/体力"/); assert.match(panel, /data-mvu-list="\/线索"/)
    const result = await diskReport('e2e-new.json')
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors))
    report.cardMvuNew = { validationErrors: result.errors.length, warnings: result.warnings.map(item => item.message) }
  })
  await step('带草稿转换元数据的卡：tavern_apply_mvu 拒绝并指向 tavern_card_draft，卡文件不变', async () => {
    const before = await readFile(join(data, 'resources/cards/e2e-managed.json'), 'utf8')
    await say('E2E_MVU_MANAGED 试着改托管卡', 'E2E_MVU_MANAGED 完成。')
    assert.match(JSON.stringify((await requests()).at(-1).messages), /tavern_card_draft/)
    assert.equal(await readFile(join(data, 'resources/cards/e2e-managed.json'), 'utf8'), before)
  })
  await page.screenshot({ path: join(output, 'card-mvu.png') })
}
