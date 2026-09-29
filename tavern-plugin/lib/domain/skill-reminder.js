import { sessionEvents } from './session-events.js'

export const SKILL_REMINDER_FORM = 'writing-skill-reminder'

function messageText(data) {
  return (Array.isArray(data && data.content) ? data.content : [])
    .map(block => block && typeof block === 'object' && block.type === 'text' ? String(block.text || '') : '')
    .join('')
}

// 目录从 append-only 事件日志读取：行被按轮退役后原文仍留在日志里，宿主的技能目录
// 更新也能被下一轮吸收。停用清单由调用方从 chat 状态直接传入，不再回读历史事件。
export function readSkillContext(session) {
  let catalog = ''
  for (const event of sessionEvents(session)) {
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source === null || typeof source !== 'object') continue
    if (source.kind === 'skill-catalog') {
      const text = messageText(event.data).trim()
      if (text !== '') catalog = text
    }
  }
  return { catalog }
}

/**
 * 本轮随玩家输入下发的写作技能提醒：目录兜底 + 本局停用清单。
 * 宿主每轮自行维护技能目录（旧行退役后它会重新发布），所以本轮请求里已有
 * 目录时不再重复携带；只有目录缺失（宿主未发布，如退役后的下一轮）才附上。
 * 没有目录需要携带、也没有停用项时返回 null——稳态零注入，模型按目录的
 * 常驻指令自行决定装载；装载痕迹按轮退役，上下文里不会残留「已装载」状态。
 */
export function buildSkillReminder(session, { trace, messages, disabledWritingSkills = [] } = {}) {
  const { catalog } = readSkillContext(session)
  const disabled = [...new Set((Array.isArray(disabledWritingSkills) ? disabledWritingSkills : []).map(String))].sort()
  const catalogPresent = Array.isArray(messages) &&
    messages.some(message => message?.source?.kind === 'skill-catalog' && messageText(message).trim() !== '')
  const carried = catalogPresent ? '' : catalog
  if (carried === '' && disabled.length === 0) return null
  const lines = ['【本局写作 Skill · 按需装载】']
  if (carried !== '') lines.push(carried)
  if (disabled.length > 0) lines.push('本局停用：' + disabled.map(name => '`' + name + '`').join('、') + '，不要装载或遵循其内容。')
  return {
    text: lines.join('\n'),
    source: {
      kind: 'plugin',
      plugin: 'dsh-tavern',
      form: SKILL_REMINDER_FORM,
      catalog: carried,
      ...(disabled.length === 0 ? {} : { disabledWritingSkills: [...disabled] }),
      ...(trace === undefined ? {} : { trace })
    }
  }
}

