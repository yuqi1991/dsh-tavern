import { recoveryBlocks } from './recovery-model.mjs'
import { compactionStream, modelCapacity } from './compaction-model.mjs'
// The only substituted boundary: fixed provider output. Tools execute normally.
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { LlmAdapter } = await import(pathToFileURL(process.env.TAVERN_E2E_LLM_MODULE))
export const inject = ['llm']
// DSH V4 hands the provider tool results as role 'tool' messages; V3 as tool-result content blocks.
const toolResultIds = messages => new Set(messages.flatMap(message => message.role === 'tool' && message.toolCallId
  ? [message.toolCallId]
  : (message.content || []).filter(block => block.type === 'tool-result').map(block => block.toolCallId)))

export function apply(ctx) {
  class Model extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: 'E2E fixed model', ...(process.env.TAVERN_E2E_COMPACTION_DIR ? { defaultMaxTokens: 8192 } : {}), context: { contextWindow: process.env.TAVERN_E2E_COMPACTION_DIR ? await modelCapacity() : 64000 } }
    }
    async *stream(input) {
      if (process.env.TAVERN_E2E_COMPACTION_DIR) { yield* compactionStream(input); return }
      const tools = new Set((input.tools || []).map(tool => tool.name))
      if (process.env.TAVERN_E2E_CARD_MVU && tools.has('tavern_apply_mvu')) {
        // Card workbench script: overview, then apply, with fixed arguments. The tools run for real.
        await appendFile(process.env.TAVERN_E2E_CARD_MVU, JSON.stringify({ tools: [...tools], messages: input.messages }) + '\n')
        const done = toolResultIds(input.messages)
        const names = ['E2E_MVU_CONVERT', 'E2E_MVU_NEW', 'E2E_MVU_MANAGED']
        // Plugin-injected user messages follow the player's, so take the latest message that names a stage.
        const stage = [...input.messages].reverse().map(message => names.find(name => message.role === 'user' && JSON.stringify(message).includes(name))).find(Boolean)
        const calls = {
          E2E_MVU_CONVERT: [
            ['mvu-convert-overview', 'tavern_mvu_overview', { path: 'cards/e2e-legacy.json' }],
            ['mvu-convert-apply', 'tavern_apply_mvu', { path: 'cards/e2e-legacy.json',
              variables: { 地点: { 名称: '旧书店' }, 状态: { 金币: 10 }, 线索: [] }, openings: [null, { 地点: { 名称: '集市' }, 状态: { 金币: 5 } }],
              rules: '金币：获得奖励或花费时按实际数额增减。\n地点名称：玩家抵达新地点时更新。',
              remove: { fromOpenings: '\\n*<状态>[\\s\\S]*?</状态>', entries: ['entry:0'], regex: ['old-status'] },
              panel: { html: '<!doctype html><html><body><div id="legacy-panel">地点：<span data-mvu="/地点/名称"></span> 金币：<span data-mvu="/状态/金币"></span></div></body></html>' } }]],
          E2E_MVU_NEW: [
            ['mvu-new-overview', 'tavern_mvu_overview', { path: 'cards/e2e-new.json' }],
            ['mvu-new-apply', 'tavern_apply_mvu', { path: 'cards/e2e-new.json',
              variables: { 时间: { 时段: '晨' }, 状态: { 体力: 80 }, 线索: [] }, rules: '体力：受伤或劳累时下降，休息时回升。',
              panel: { title: '状态', accent: '#2f6f5e', sections: [{ title: '时间', fields: [{ path: '/时间/时段', label: '时段' }] }, { title: '体力', fields: [{ path: '/状态/体力', kind: 'bar' }, { path: '/线索', kind: 'list' }] }] } }]],
          E2E_MVU_MANAGED: [['mvu-managed-apply', 'tavern_apply_mvu', { path: 'cards/e2e-managed.json', variables: { 地点: { 名称: '甲' } } }]]
        }[stage] || []
        const next = calls.find(([id]) => !done.has(id))
        const block = next ? { type: 'tool-call', id: next[0], name: next[1], arguments: JSON.stringify(next[2]) } : { type: 'text', text: stage ? stage + ' 完成。' : '卡片工作台就绪。' }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
        return
      }
      if (process.env.TAVERN_E2E_MEMORY_AUDIT) {
        await appendFile(process.env.TAVERN_E2E_MEMORY_AUDIT, JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools }) + '\n')
        if (tools.has('tavern_memory_search')) {
          const text = JSON.stringify(input.messages)
          const done = toolResultIds(input.messages).has('memory-preference-save')
          const block = text.includes('E2E_MEMORY_NEXT') ? { type: 'text', text: '已读取改卡偏好。' }
            : text.includes('E2E_MEMORY_SAVE') && !done ? { type: 'tool-call', id: 'memory-preference-save', name: 'tavern_memory_preference', arguments: JSON.stringify({ action: 'add', content: '保留原卡结构，不重写开场白' }) }
            : { type: 'text', text: done ? '改卡偏好已保存。' : '卡片工作台就绪。' }
          yield { type: 'block-start', index: 0, blockType: block.type }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
          return
        }
      }
      const recovery = await recoveryBlocks(input, tools)
      if (recovery) {
        for (const [index, block] of recovery.entries()) {
          yield { type: 'block-start', index, blockType: block.type }
          yield { type: 'block-end', index, block }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      let heldAttempt
      if (process.env.TAVERN_E2E_BACKGROUND_DIR && tools.has('mvu_submit_update')) {
        const file = process.env.TAVERN_E2E_BACKGROUND_DIR + '/background-control.json'
        const control = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
        if (control.mode === 'hold') {
          heldAttempt = control.attempt
          await appendFile(process.env.TAVERN_E2E_BACKGROUND_DIR + '/background-attempts.jsonl', JSON.stringify({attempt:control.attempt})+'\n')
          // Deliberately ignore cancellation: the host must reject any late tool call.
          const deadline=Date.now()+60000
          while(Date.now()<deadline && JSON.parse(await readFile(file,'utf8')).mode==='hold') await new Promise(resolve=>setTimeout(resolve,50))
        }
      }
      const done = toolResultIds(input.messages)
      const text = JSON.stringify(input.messages)
      const presetRound = [70, 60, 50].find(value => text.includes(`E2E 预设验收 ${value}`) || text.includes(`预设切换后继续游玩，金币 ${value}。`))
      const cardUpdate = (text.includes('E2E 更新后继续') || text.includes('更新后的世界中，你又获得十枚金币'))
      const gold = cardUpdate ? 20 : presetRound || (text.includes('E2E 修正金币为四十') ? 40 : (text.includes('雨夜重写') || text.includes('雨夜里')) ? 30 : (text.includes('再次领取奖励') || text.includes('金币累计二十枚')) ? 20 : 10)
      const goldId = 'e2e-gold-' + gold, postureId = 'e2e-posture-' + gold
      const blocks = []
      if (tools.has('candidate_submit_choices')) blocks.push({ type: 'tool-call', id: 'e2e-choices', name: 'candidate_submit_choices', arguments: JSON.stringify({ actions: ['再次领取奖励', '向店主道谢', '查看任务告示', '清点背包'], scene: '夜幕降临酒馆' }) })
      if (tools.has('mvu_submit_update') && !done.has(goldId)) blocks.push({
        type: 'tool-call', id: goldId, name: 'mvu_submit_update',
        arguments: JSON.stringify({ operations: [{ op: 'replace', path: cardUpdate ? '/stat_data/coins' : '/stat_data/gold',
          valueJson: process.env.TAVERN_E2E_WRONG_GOLD === '1' ? '9' : String(gold) }] })
      })
      if (tools.has('posture_submit') && !done.has(postureId)) blocks.push({
        type: 'tool-call', id: postureId, name: 'posture_submit',
        arguments: JSON.stringify({ posture: '站在柜台前，收下奖励。' })
      })
      const openingRegen = text.includes('游戏刚开始，玩家尚未行动')
      if (!blocks.length) blocks.push({ type: 'text', text: (openingRegen ? '重新生成的开场：雨夜的柜台前。' : cardUpdate ? '更新后的世界中，你又获得十枚金币。' : presetRound ? `预设切换后继续游玩，金币 ${gold}。` : gold === 30 ? '雨夜里，你重新领取了奖励。' : gold === 20 ? '你再次领取了奖励，金币累计二十枚。' : '你获得了十枚金币。') + '\n\n<StatusPlaceHolderImpl/>' })
      if (cardUpdate && process.env.TAVERN_E2E_REQUEST_AUDIT) await appendFile(process.env.TAVERN_E2E_REQUEST_AUDIT, JSON.stringify({cardUpdate:true,newWorldbook:text.includes(tools.has('mvu_submit_update') ? 'E2E_LIVE_MVU_RULES_V2' : 'E2E_LIVE_WORLDBOOK_V2'),settlement:tools.has('mvu_submit_update') || tools.has('posture_submit')})+'\n')
      if (presetRound && blocks.some(block => block.type === 'text') && process.env.TAVERN_E2E_REQUEST_AUDIT) {
        await appendFile(process.env.TAVERN_E2E_REQUEST_AUDIT, JSON.stringify({ gold,
          presetA: text.includes('E2E_PRESET_A_ACTIVE'), presetB: text.includes('E2E_PRESET_B_ACTIVE'),
          settlement: tools.has('mvu_submit_update') || tools.has('posture_submit') }) + '\n')
      }
      // Put the state-changing call first so cancellation is tested against an MVU write.
      if (heldAttempt !== undefined) blocks.sort((a, b) => Number(b.name === 'mvu_submit_update') - Number(a.name === 'mvu_submit_update'))
      // Hold the main reply open so a test can observe the page mid-generation.
      const holdFile = process.env.TAVERN_E2E_REGEN_HOLD && !tools.has('mvu_submit_update') && !tools.has('posture_submit') && !tools.has('candidate_submit_choices') && input.purpose !== 'session-title' && blocks.some(block => block.type === 'text')
        ? process.env.TAVERN_E2E_REGEN_HOLD + '/regen-hold.json' : null
      if (holdFile) {
        const control = JSON.parse(await readFile(holdFile, 'utf8').catch(() => '{}'))
        if (control.mode === 'hold') {
          await appendFile(process.env.TAVERN_E2E_REGEN_HOLD + '/regen-hold-requests.jsonl', JSON.stringify({ held: true }) + '\n')
          yield { type: 'block-start', index: 0, blockType: 'text' }
          const deadline = Date.now() + 60000
          while (Date.now() < deadline && !input.signal?.aborted && JSON.parse(await readFile(holdFile, 'utf8').catch(() => '{}')).mode === 'hold') await new Promise(resolve => setTimeout(resolve, 50))
          if (input.signal?.aborted || JSON.parse(await readFile(holdFile, 'utf8').catch(() => '{}')).mode === 'fail') throw new Error('E2E 模型故障：重新生成被中断')
          yield { type: 'block-end', index: 0, block: blocks.find(block => block.type === 'text') }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
      for (const [index, block] of blocks.entries()) {
        if (heldAttempt !== undefined && block.type === 'tool-call') await appendFile(process.env.TAVERN_E2E_BACKGROUND_DIR + '/background-late.jsonl', JSON.stringify({attempt:heldAttempt, tool:block.name})+'\n')
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['tavern-e2e'], new Model())
}
