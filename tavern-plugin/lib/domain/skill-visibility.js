import { producerSource, isProducerSource } from './message-source.js'
import { randomUUID } from 'node:crypto'
import { canonicalTavernSkillName } from './tavern-skills.js'

function stateOf(message) {
  const source = message?.source
  return isProducerSource(source, 'dsh-tavern') && source.form === 'writing-skill-state'
    ? source.disabledWritingSkills : undefined
}

// Only append to the pending step. Never rewrite historical catalogs, loaded
// bodies, system instructions or tool schemas when the user changes a switch.
// The native catalog controls discovery; this state also revokes instructions
// already loaded, including user-invocable skills absent from that catalog.
export function appendWritingSkillState(messages, mode, { session, disabledWritingSkills = [] } = {}) {
  if (!['story', 'script'].includes(mode)) return messages
  const disabled = [...new Set(disabledWritingSkills.map(canonicalTavernSkillName))].sort()
  let previous
  for (let i = messages.length - 1; i >= 0; i--) {
    previous = stateOf(messages[i])
    if (previous !== undefined) break
  }
  if (previous === undefined) {
    const nodes = session?.surface?.nodes || []
    for (let i = nodes.length - 1; i >= 0; i--) {
      const event = session.eventAt(nodes[i])
      if (event?.type !== 'user/message') continue
      previous = stateOf(event.data)
      if (previous !== undefined) break
    }
  }
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(disabled)) return messages
  const text = [
    '【本局写作 Skill 开关】',
    '这是当前完整开关状态，替代此前所有写作 Skill 开关通知，从本次请求起生效。',
    disabled.length ? '当前停用：' + disabled.map(name => '`' + name + '`').join('、') + '。' : '当前没有被本局开关停用的写作 Skill。',
    '对当前停用的 Skill，停止遵循此前已加载的正文和参考资料，也不要再次调用；保留历史内容仅为对话记录，不表示仍然启用。',
    '此前停用、现在不再列出的 Skill 已解除本局禁用；仍需遵守当前可用目录与调用权限，按场景选用。开关不改变既有剧情事实。'
  ].join('\n')
  return [...messages, {
    id: randomUUID(), role: 'user', content: [{ type: 'text', text }],
    source: producerSource('dsh-tavern', { form: 'writing-skill-state', disabledWritingSkills: disabled })
  }]
}
