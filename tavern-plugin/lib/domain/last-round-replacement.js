function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function selectedIndex(message) {
  const count = Math.max(Array.isArray(message && message.swipes) ? message.swipes.length : 0, 1)
  return Math.max(0, Math.min(count - 1, Number(message && message.swipeId) || 0))
}

function regenerationConflict(reason) {
  const error = new Error('重新生成期间正文已被另一项操作修改：' + reason)
  error.code = 'DSH_TAVERN_REGEN_CONFLICT'
  return error
}

export function assertRegenerationSourceCurrent(input = {}) {
  const originalChat = input.originalChat
  const currentChat = input.currentChat
  const assistantIndex = Number(input.assistantIndex)
  if (!originalChat || !currentChat || !Array.isArray(originalChat.messages) || !Array.isArray(currentChat.messages)) throw regenerationConflict('聊天状态不完整')
  const originalBranch = str(originalChat.timeline && originalChat.timeline.branchId)
  const currentBranch = str(currentChat.timeline && currentChat.timeline.branchId)
  if (originalBranch !== '' && currentBranch !== originalBranch) throw regenerationConflict('剧情分支已经切换')
  if (currentChat.messages.length !== originalChat.messages.length) throw regenerationConflict('对话轮次已经变化')
  const originalUser = originalChat.messages[assistantIndex - 1]
  const currentUser = currentChat.messages[assistantIndex - 1]
  const originalAssistant = originalChat.messages[assistantIndex]
  const currentAssistant = currentChat.messages[assistantIndex]
  if (!originalUser || !currentUser || originalUser.role !== 'user' || currentUser.role !== 'user' || str(currentUser.text) !== str(originalUser.text)) throw regenerationConflict('玩家输入已经变化')
  if (!originalAssistant || !currentAssistant || originalAssistant.role !== 'assistant' || currentAssistant.role !== 'assistant' || Number(currentAssistant.turn) !== Number(originalAssistant.turn)) throw regenerationConflict('正文楼层已经变化')
  if (str(currentAssistant.text) !== str(originalAssistant.text) || str(currentAssistant.sourceText) !== str(originalAssistant.sourceText)) throw regenerationConflict('正文内容已经变化')
  return currentChat
}

/** Replace the last committed user/body pair with exactly one generated version. */
export function replaceLastRound(input = {}) {
  const originalChat = clone(input.originalChat)
  const regeneratedChat = clone(input.regeneratedChat)
  const assistantIndex = Number(input.assistantIndex)
  if (!originalChat || !regeneratedChat || !Array.isArray(originalChat.messages) || !Array.isArray(regeneratedChat.messages)) throw new Error('重新生成缺少聊天状态')
  const originalAssistant = originalChat.messages[assistantIndex]
  const originalUser = originalChat.messages[assistantIndex - 1]
  const regeneratedAssistant = regeneratedChat.messages[regeneratedChat.messages.length - 1]
  if (!originalAssistant || originalAssistant.role !== 'assistant' || !originalUser || originalUser.role !== 'user') throw new Error('原正文不是玩家输入与助手回复组合')
  if (!regeneratedAssistant || regeneratedAssistant.role !== 'assistant') throw new Error('重新生成没有产生助手回复')

  const selected = selectedIndex(regeneratedAssistant)
  // Phase 2 (P2-A): swipes[]/swipeId stop being written — the helper surface
  // materializes a single-variant projection when the field is absent, and
  // multi-variant projection arrives with branch enumeration. Existing stored
  // arrays are preserved untouched for old-chat read compatibility.
  const replacement = Object.assign({}, clone(originalAssistant), clone(regeneratedAssistant), {
    turn: originalAssistant.turn
  })
  delete replacement.bodyEdit
  if (Array.isArray(originalAssistant.variables) || Array.isArray(regeneratedAssistant.variables)) {
    replacement.variables = [clone(Array.isArray(regeneratedAssistant.variables) ? regeneratedAssistant.variables[selected] || {} : {})]
  }
  // An edited input persists in place of the original text; attachments stay.
  // Every text-bearing field must move together: text drives the bubble, while
  // sourceText/templateInputSource drive template input. Stale display
  // projections drop for the same reason. swipes mirrors are intentionally
  // left at their original values (see P2-A note above).
  const editedInputText = typeof input.inputText === 'string' ? input.inputText : ''
  const userMessage = clone(originalUser)
  if (editedInputText.trim() !== '' && str(editedInputText) !== str(originalUser.text)) {
    const edited = str(editedInputText)
    userMessage.text = edited
    if (userMessage.sourceText !== undefined) userMessage.sourceText = edited
    if (userMessage.templateInputSource !== undefined) userMessage.templateInputSource = edited
    delete userMessage.displayText
    delete userMessage.projectionText
    delete userMessage.displayMode
  }
  regeneratedChat.messages = originalChat.messages.slice(0, assistantIndex - 1).concat([userMessage, replacement])
  return { chat: regeneratedChat, assistant: replacement }
}
