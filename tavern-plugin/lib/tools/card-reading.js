import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchCardRaw } from '../domain/card-reading.js'
import { normalizeResourcePath, resourceKind } from '../domain/file-resources.js'
import { validatePresetText, validateWorldBookText } from '../domain/resource-validation.js'
import { VALIDATION_SCHEMA } from './card-validation-check.js'

// Read-only card workbench tools: format check and whole-card text search.
export function registerCardReadingTools({ cardPreparation, checkCard, chatForSession, fileResources, readCardWorkspace, str, tools }) {
  tools.register(defineTool({
    name: 'tavern_validate_card',
    description: '检查人物卡、预设或世界书文件格式，报告错误位置和修法。人物卡：JSON 语法、字段类型、世界书条目；MVU 卡还检查各开场 <initvar> 能否解析、开场间字段是否一致、[mvu_update] 规则、<mvu-status/> 入口与面板正则、面板脚本语法与引用的变量路径、正则能否编译。预设：JSON 语法、prompts 与 prompt_order 结构、正则能否编译。世界书：JSON 语法、能否识别为世界书、条目字段类型、正则触发词。只读，不执行脚本，不改文件。Tavern 保存工具的结果已附带校验，无需再调用；用文件编辑器或脚本直接改这些文件后必须调用，按 errors 修正；warnings 视情况处理。',
    parameters: { path: { type: 'string', description: '可选的 cards/...、presets/... 或 worldbooks/... 相对路径；省略时检查当前已保存人物卡' } },
    output: {
      schema: VALIDATION_SCHEMA,
      render: function (_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
    },
    isConcurrencySafe: function () { return true },
    async execute(args, exec) {
      const chat = await chatForSession(exec.agent.session.id)
      if (!chat || chat.mode !== 'card') throw new Error('格式校验只能在卡片工作台使用')
      const requested = str(args.path).trim()
      const kind = requested ? resourceKind(requested) : 'card'
      if (kind === 'card') return await checkCard(chat, requested || str(chat.cardPath))
      if (kind !== 'preset' && kind !== 'worldbook') throw new Error('只能校验 cards/、presets/ 或 worldbooks/ 下的文件')
      const path = normalizeResourcePath(requested, kind)
      const text = await fileResources.readText(path)
      if (text === undefined) return { valid: false, errors: [{ path, message: '文件不存在' }], warnings: [] }
      return kind === 'preset' ? validatePresetText(text) : validateWorldBookText(text)
    }
  }))

  tools.register(defineTool({
    name: 'tavern_search_card',
    description: '在整张人物卡里定位文字：一次搜遍标准字段、开场、内置世界书条目（标题、关键词、正文）、正则和脚本，返回 JSON Pointer、所属条目与上下文片段。要改的内容不确定在哪、或要改多处时先用它定位，再按位置读取或修改：内置世界书条目用 tavern_update_worldbook（entry:N），标准字段用 tavern_update_card 的 fields，其他用 rawOperations。不搜索绑定的独立世界书。',
    parameters: {
      path: { type: 'string', description: '可选的人物卡相对路径；省略时搜索当前人物卡' },
      query: { type: 'string', required: true, description: '要找的文字；默认按字面匹配，不区分大小写' },
      regex: { type: 'boolean', description: '为 true 时把 query 当作 JavaScript 正则' },
      limit: { type: 'integer', description: '最多返回的命中位置数，默认 30，最大 100' }
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          occurrences: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            pointer: { type: 'string', required: true }, label: { type: 'string', required: true }, count: { type: 'integer', required: true },
            chars: { type: 'integer', required: true }, snippets: { type: 'array', required: true, items: { type: 'string' } }
          } } }
        }
      },
      render: function (_args, value) {
        if (value.total === 0) return [{ type: 'text', text: '人物卡中没有找到「' + value.query + '」。' }]
        const lines = ['「' + value.query + '」共 ' + value.occurrences + ' 处，分布在 ' + value.total + ' 个位置' + (value.truncated ? '，仅列出前 ' + value.hits.length + ' 个' : '') + '：']
        for (const hit of value.hits) {
          lines.push('', hit.pointer + (hit.label ? ' · ' + hit.label : '') + ' · ' + hit.count + ' 处 / 全文 ' + hit.chars + ' 字')
          for (const snippet of hit.snippets) lines.push('  ' + snippet.replace(/\n/g, '⏎'))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      }
    },
    isConcurrencySafe: function () { return true },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
      const chat = await chatForSession(sessionId)
      if (chat === undefined || (chat.mode || 'story') !== 'card') throw new Error('人物卡搜索只能在卡片工作台中使用')
      const resourcePath = str(args.path).trim() || str(chat.cardPath)
      if (resourcePath === '') throw new Error('空白工作台还没有正式人物卡')
      const workspace = await readCardWorkspace(resourcePath)
      if (workspace === undefined) throw new Error('人物卡资源不存在: ' + resourcePath)
      return searchCardRaw(cardPreparation.raw(workspace), args)
    }
  }))
}
