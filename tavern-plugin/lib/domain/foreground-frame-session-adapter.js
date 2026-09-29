import { foregroundFrameText } from './agent-input-frame.js'
import { buildSkillReminder } from './skill-reminder.js'
import { worldbookSnapshot } from './worldbook-snapshot.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function frameIdOf(message) {
  const source = message && message.source
  return str(source && source.trace && source.trace.frameId)
}

/** Adapt one ForegroundFrame to the current DSH agent/pre-step message seam. */
export function createForegroundFrameSessionAdapter(options = {}) {
  const makeId = typeof options.id === 'function' ? options.id : function () { return crypto.randomUUID() }

  function append(input = {}) {
    const messages = Array.isArray(input.messages) ? input.messages : []
    const frame = input.frame
    if (!frame || frame.kind !== 'foreground') throw new Error('Session Adapter 只接受 ForegroundFrame')
    if (Number(input.step) !== 1) return { messages, receipt: { appended: false, reason: 'not-first-step', frameId: frame.frameId } }
    if (messages.some(function (message) { return frameIdOf(message) === frame.frameId })) {
      return { messages, receipt: { appended: false, reason: 'duplicate', frameId: frame.frameId } }
    }
    const snapshot = worldbookSnapshot(input.session, frame.contributions
      .filter(item => item.slot === 'activeWorldbook').map(item => item.text).join('\n\n'), input.historyMessages || messages)
    const contributions = frame.contributions.filter(item => item.slot !== 'activeWorldbook')
    const snapshots = snapshot ? [{
      id: makeId() + ':worldbook', role: 'user',
      content: [{ type: 'text', text: snapshot.rendered }],
      source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'worldbook-snapshot',
        worldbookSnapshot: snapshot, trace: { frameId: frame.frameId, turn: frame.turn, operationId: frame.operationId } }
    }] : []
    // 写作技能提醒随本轮输入下发（目录 + 停用清单 + 按需装载指令），下一轮由按轮退役
    // 清理。skill 目录从事件日志读取，停用清单由调用方从 chat 状态传入。
    const reminder = buildSkillReminder(input.session, {
      messages,
      disabledWritingSkills: input.disabledWritingSkills,
      trace: { frameId: frame.frameId, chatId: frame.chatId, branchId: frame.branchId, operationId: frame.operationId, turn: frame.turn }
    })
    const contextRows = snapshots.concat(reminder === null ? [] : [{
      id: makeId() + ':skill-reminder', role: 'user',
      content: [{ type: 'text', text: reminder.text }],
      source: reminder.source
    }])
    const text = foregroundFrameText({ contributions })
    if (text === '') return { messages: messages.concat(contextRows), receipt: { appended: contextRows.length > 0, reason: contextRows.length ? 'appended' : 'empty', frameId: frame.frameId } }
    const sections = contributions.map(function (item, index) {
      return {
        name: 'tavern:foreground:' + str(item.slot) + ':' + (index + 1),
        text: str(item.text),
        source: item.source
      }
    })
    return {
      messages: messages.concat(contextRows, [{
        id: makeId(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-tavern',
          form: 'foreground-frame',
          sections,
          trace: {
            frameId: frame.frameId,
            chatId: frame.chatId,
            branchId: frame.branchId,
            basedOnRevision: frame.basedOnRevision,
            operationId: frame.operationId,
            turn: frame.turn
          }
        }
      }]),
      receipt: { appended: true, reason: 'appended', frameId: frame.frameId }
    }
  }

  return Object.freeze({ append })
}
