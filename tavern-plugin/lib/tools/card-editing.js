import { defineTool } from '@deepseek-ai/dsh-tools'
import { planCardTextReplace } from '../domain/card-text-replace.js'
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
}
