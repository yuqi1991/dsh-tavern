import { defineTool } from '@deepseek-ai/dsh-tools'
import { planCardTextReplace } from '../domain/card-text-replace.js'
import { assertNotManagedMvu, planMvuApply, surveyMvuCard, surveyText } from '../domain/mvu-card-apply.js'
import { searchCardRaw } from '../domain/card-reading.js'
import { normalizeResourcePath } from '../domain/file-resources.js'
import { VALIDATION_SCHEMA, validationText } from './card-validation-check.js'

// Card workbench tools that change a card.
export function registerCardEditingTools({ activeTurnOf, cardPreparation, chatForSession, checkCard, readCardWorkspace, str, tools, turnOrchestrator, worldBooks }) {
  tools.register(defineTool({
    name: 'tavern_replace_card_text',
    description: '仅当用户明确要求修改时，在整张人物卡里批量替换文字并立即保存：标准字段、开场、内置世界书条目（标题、关键词、正文）、正则和脚本一次改完，保存后自动校验。结果列出每个位置替换了几处、全卡剩余几处，以此为准，无需再搜索或用脚本复核。只想改部分位置时用 pointers 限定（可填 tavern_search_card 返回的 pointer 或其上级，如 /data/character_book/entries/8）；填 expectedCount 时实际处数不符则不改。不处理绑定的独立世界书。',
    parameters: {
      path: { type: 'string', description: '可选的人物卡路径；省略时修改当前人物卡' },
      find: { type: 'string', required: true, description: '要替换的文字；默认按字面匹配，不区分大小写' },
      replace: { type: 'string', required: true, description: '替换成的文字；regex 为 true 时可用 $1 等引用分组' },
      regex: { type: 'boolean', description: '为 true 时把 find 当作 JavaScript 正则' },
      pointers: { type: 'array', items: { type: 'string' }, description: '可选，只替换这些 JSON Pointer 位置及其下级' },
      expectedCount: { type: 'integer', description: '可选，预期替换的总处数；不符时不保存并返回实际分布' }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          replaced: { type: 'integer', required: true },
          remaining: { type: 'integer', required: true },
          locations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            pointer: { type: 'string', required: true }, label: { type: 'string', required: true }, count: { type: 'integer', required: true } } } },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          validation: VALIDATION_SCHEMA
        }
      },
      render: function (_args, value) {
        const lines = ['已在 ' + value.path + ' 替换 ' + value.replaced + ' 处，全卡剩余 ' + value.remaining + ' 处：']
        for (const item of value.locations) lines.push('- ' + item.pointer + (item.label ? ' · ' + item.label : '') + ' · ' + item.count + ' 处')
        if (value.skipped.length) lines.push('未自动替换（请用对应工具单独处理）：' + value.skipped.join('、'))
        if (value.validation) lines.push(validationText(value.validation))
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
      const chat = await chatForSession(sessionId)
      if (chat === undefined || (chat.mode || 'story') !== 'card') throw new Error('人物卡替换只能在卡片工作台中使用')
      const requested = str(args.path).trim() || str(chat.cardPath)
      if (requested === '') throw new Error('空白工作台还没有正式人物卡')
      const cardPath = normalizeResourcePath(requested, 'card')
      const workspace = await readCardWorkspace(cardPath)
      if (workspace === undefined) throw new Error('人物卡资源不存在: ' + cardPath)
      const plan = planCardTextReplace(cardPreparation.raw(workspace), args)
      if (plan.occurrences === 0) throw new Error('人物卡中没有找到「' + str(args.find) + '」' + (plan.skipped.length ? '（仅在不支持自动替换的位置出现：' + plan.skipped.map(item => item.pointer).join('、') + '）' : ''))
      if (Number.isInteger(args.expectedCount) && args.expectedCount !== plan.occurrences) {
        throw new Error('预期 ' + args.expectedCount + ' 处，实际 ' + plan.occurrences + ' 处，未修改。分布：' + plan.locations.map(item => item.pointer + '×' + item.count).join('、'))
      }
      if (Object.keys(plan.fields).length || plan.rawOperations.length) {
        await turnOrchestrator.saveChanges({ sessionId, turn: activeTurnOf(exec), path: cardPath, fields: plan.fields, rawOperations: plan.rawOperations })
      }
      if (plan.worldbook.length) await worldBooks.update({ kind: 'card', cardPath }, { operations: plan.worldbook })
      const saved = await readCardWorkspace(cardPath)
      const left = searchCardRaw(cardPreparation.raw(saved), { query: args.find, regex: args.regex === true, limit: 1 })
      return {
        path: cardPath, replaced: plan.occurrences, remaining: left.occurrences,
        locations: plan.locations, skipped: plan.skipped.map(item => item.pointer), validation: await checkCard(chat, cardPath)
      }
    }
  }))

  tools.register(defineTool({
    name: 'tavern_mvu_overview',
    description: '只读：一次列出人物卡里与加 MVU 相关的全貌——设定字段长度、每个开场（位置、长度、开头、是否已有 <initvar>/<mvu-status/>）、现有变量、内置世界书每条（编号、标题、触发方式、长度）、正则和脚本，并按关键词标出可能的旧状态栏、变量、候选项协议。转 MVU 或改 MVU 卡时先调用它，再按需读具体内容，不必用命令行遍历卡片文件。',
    parameters: {
      path: { type: 'string', description: '可选的人物卡路径；省略时读当前人物卡' }
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, text: { type: 'string', required: true } } },
      render: function (_args, value) { return [{ type: 'text', text: value.path + '\n' + value.text }] }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
      const chat = await chatForSession(sessionId)
      const requested = str(args.path).trim() || str(chat && chat.cardPath)
      if (requested === '') throw new Error('空白工作台还没有正式人物卡')
      const cardPath = normalizeResourcePath(requested, 'card')
      const workspace = await readCardWorkspace(cardPath)
      if (workspace === undefined) throw new Error('人物卡资源不存在: ' + cardPath)
      return { path: cardPath, text: surveyText(surveyMvuCard(cardPreparation.raw(workspace))) }
    }
  }))

  tools.register(defineTool({
    name: 'tavern_apply_mvu',
    description: '把 MVU 结构一次写进人物卡并保存：你给出变量、各开场的不同值、更新规则和面板，工具负责机械部分——在每个开场末尾写入 <initvar>（自动加 $meta.strictSet，替换旧的）和 <mvu-status/>，新增或更新世界书 [mvu_update]（常驻，自动补提交说明）与 [initvar]（禁用）条目，新增或更新状态面板正则和隐藏入口正则；可用 remove 在同一次保存里删掉开场里的旧状态块、旧状态说明条目和旧正则；其他内容不动。省略的部分保持卡里现有内容，可反复调用只改其中一部分。保存后自动校验，结果就是已保存的内容，无需再读文件核对。之后仍可用其他工具细调。',
    parameters: {
      path: { type: 'string', description: '可选的人物卡路径；省略时改当前人物卡' },
      variables: { type: 'json', description: '变量默认初值对象（stat_data 结构），各开场共用；省略时保留各开场现有初值' },
      openings: { type: 'array', items: { type: 'json' }, description: '可选，按开场顺序（first_mes、alternate_greetings…）给出与默认值不同的字段，只写不同的部分，深合并到 variables；某个开场无差异写 null' },
      rules: { type: 'string', description: '[mvu_update] 规则正文：每个字段在什么剧情事实下怎么变；省略时保留现有规则' },
      remove: {
        type: 'object', additionalProperties: false,
        description: '可选，同一次保存里清理旧状态协议',
        properties: {
          fromOpenings: { type: 'string', description: 'JavaScript 正则源码，从每个开场删除匹配内容（如旧状态块 "\\n*<状态>[\\s\\S]*?</状态>"）；都不匹配时报错不保存' },
          entries: { type: 'array', items: { type: 'string' }, description: '要删除的内置世界书条目编号，如 entry:3' },
          regex: { type: 'array', items: { type: 'string' }, description: '要删除的正则：序号、JSON Pointer 或 id' }
        }
      },
      panel: {
        type: 'object', additionalProperties: false,
        description: '状态面板。给 html 用你写的完整 HTML（美元符号照常写，工具会转义）；不给 html 时按 title/sections/accent 生成标准面板；省略整个 panel 时保留已有面板，没有则按变量自动生成',
        properties: {
          html: { type: 'string' },
          title: { type: 'string' },
          accent: { type: 'string', description: '主色，如 #8b3a2e' },
          sections: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            title: { type: 'string' },
            fields: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
              path: { type: 'string', required: true, description: '变量路径，如 /状态/体力' },
              label: { type: 'string' },
              kind: { type: 'string', enum: ['text', 'bar', 'list'] },
              max: { type: 'number', description: 'bar 的满值，默认 100' }
            } } }
          } } }
        }
      }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          openings: { type: 'integer', required: true },
          variables: { type: 'array', required: true, items: { type: 'string' } },
          rules: { type: 'string', required: true },
          panel: { type: 'string', required: true },
          removed: { type: 'object', required: true, additionalProperties: false, properties: {
            openings: { type: 'integer', required: true }, entries: { type: 'integer', required: true }, regex: { type: 'integer', required: true } } },
          validation: VALIDATION_SCHEMA
        }
      },
      render: function (_args, value) {
        const words = { kept: '保留', updated: '已更新', added: '已新增', custom: '使用你写的 HTML', generated: '已生成标准面板' }
        const lines = ['已写入 MVU（' + value.path + '）：' + (value.openings ? value.openings + ' 个开场的初值' : '开场初值未改') + '；规则' + words[value.rules] + '；面板' + words[value.panel],
          '变量：' + value.variables.join('、')]
        const removed = value.removed
        if (removed.openings || removed.entries || removed.regex) lines.push('已清理旧协议：' + [removed.openings && removed.openings + ' 个开场', removed.entries && removed.entries + ' 条世界书', removed.regex && removed.regex + ' 条正则'].filter(Boolean).join('、'))
        if (value.validation) lines.push(validationText(value.validation))
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
      const chat = await chatForSession(sessionId)
      if (chat === undefined || (chat.mode || 'story') !== 'card') throw new Error('MVU 写入只能在卡片工作台中使用')
      const requested = str(args.path).trim() || str(chat.cardPath)
      if (requested === '') throw new Error('空白工作台还没有正式人物卡')
      const cardPath = normalizeResourcePath(requested, 'card')
      const workspace = await readCardWorkspace(cardPath)
      if (workspace === undefined) throw new Error('人物卡资源不存在: ' + cardPath)
      assertNotManagedMvu(cardPreparation.raw(workspace), cardPath)
      const plan = planMvuApply(cardPreparation.raw(workspace), args)
      if (Object.keys(plan.fields).length || plan.rawOperations.length) {
        await turnOrchestrator.saveChanges({ sessionId, turn: activeTurnOf(exec), path: cardPath, fields: plan.fields, rawOperations: plan.rawOperations })
      }
      if (plan.worldbook.length) await worldBooks.update({ kind: 'card', cardPath }, { operations: plan.worldbook })
      return { path: cardPath, ...plan.summary, validation: await checkCard(chat, cardPath) }
    }
  }))
}
