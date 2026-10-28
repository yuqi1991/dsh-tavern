import { compactionPolicy } from './auto-compaction.js'
import { normalizeBackgroundModel } from './background-model-selection.js'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function promptOverride(document, name) {
  const value = object(document.promptOverrides)[name]
  return typeof value === 'string' && (value.trim() !== '' || name === 'system-append') ? value : null
}

// System prompt sets: the active set's content stays in the top-level
// promptOverrides/systemAppendEnabled fields (what every reader uses, and what
// older versions read); promptSets only stores names plus inactive sets' content.
const DEFAULT_PROMPT_SET = Object.freeze({ id: 'default', name: '默认方案' })

function promptSetName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '' || name.length > 80) throw new Error('方案名称需为 1–80 字')
  return name
}

export function uniqueName(names, base) {
  const taken = new Set(names)
  if (!taken.has(base)) return base
  for (let index = 2; ; index += 1) if (!taken.has(base + ' (' + index + ')')) return base + ' (' + index + ')'
}

export function promptSetLibrary(document) {
  const source = Array.isArray(object(document).promptSets) ? document.promptSets : []
  const sets = []
  for (const item of source) {
    const entry = object(item)
    if (typeof entry.id !== 'string' || entry.id === '' || typeof entry.name !== 'string' || sets.some(set => set.id === entry.id)) continue
    sets.push(entry)
  }
  if (sets.length === 0) sets.push({ ...DEFAULT_PROMPT_SET })
  const activeId = sets.some(set => set.id === object(document).activePromptSetId) ? document.activePromptSetId : sets[0].id
  return { activeId, sets }
}

function storedPromptSetContent(value) {
  const overrides = {}
  for (const [name, text] of Object.entries(object(value))) if (typeof text === 'string' && text.length <= 100000) overrides[name] = text.trim()
  return overrides
}

function writeActivePromptContent(next, overrides, systemAppendEnabled) {
  if (Object.keys(overrides).length === 0) delete next.promptOverrides
  else next.promptOverrides = overrides
  next.systemAppendEnabled = systemAppendEnabled !== false
}

function applyPromptSetChange(next, change) {
  const { activeId, sets } = promptSetLibrary(next)
  const action = change.action
  const nameOf = id => sets.find(set => set.id === id)
  const names = sets.map(set => set.name)
  const newId = () => 'set-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  // Snapshot the live content into its entry before any switch.
  const stash = list => list.map(set => set.id === activeId ? { id: set.id, name: set.name, promptOverrides: storedPromptSetContent(next.promptOverrides), systemAppendEnabled: next.systemAppendEnabled !== false } : set)
  const activate = (list, id) => {
    const target = list.find(set => set.id === id)
    writeActivePromptContent(next, storedPromptSetContent(target.promptOverrides), target.systemAppendEnabled)
    next.promptSets = list.map(set => set.id === id ? { id: set.id, name: set.name } : set)
    next.activePromptSetId = id
  }
  if (action === 'select') {
    if (!nameOf(change.id)) throw new Error('系统提示词方案不存在')
    if (change.id !== activeId) activate(stash(sets), change.id)
    return
  }
  if (action === 'rename') {
    if (!nameOf(change.id)) throw new Error('系统提示词方案不存在')
    const name = uniqueName(names.filter((value, index) => sets[index].id !== change.id), promptSetName(change.name))
    next.promptSets = sets.map(set => set.id === change.id ? { ...set, name } : set)
    next.activePromptSetId = activeId
    return
  }
  if (action === 'delete') {
    if (!nameOf(change.id)) throw new Error('系统提示词方案不存在')
    if (change.id === activeId) throw new Error('不能删除正在使用的方案，请先切换到其他方案')
    next.promptSets = sets.filter(set => set.id !== change.id)
    next.activePromptSetId = activeId
    return
  }
  if (action === 'create' || action === 'duplicate' || action === 'add') {
    const id = newId()
    const name = uniqueName(names, promptSetName(change.name))
    let content
    if (action === 'duplicate') content = { promptOverrides: storedPromptSetContent(next.promptOverrides), systemAppendEnabled: next.systemAppendEnabled !== false }
    else if (action === 'add') content = { promptOverrides: storedPromptSetContent(change.promptOverrides), systemAppendEnabled: change.systemAppendEnabled !== false }
    else content = { promptOverrides: {}, systemAppendEnabled: true }
    activate([...stash(sets), { id, name, ...content }], id)
    return
  }
  throw new Error('未知的系统提示词方案操作')
}

export function presentPromptSets(document) {
  const { activeId, sets } = promptSetLibrary(document)
  return { activeId, sets: sets.map(set => ({ id: set.id, name: set.name, active: set.id === activeId })) }
}

export function normalizeBackgroundTasks(value) {
  const tasks = object(value)
  // variableFeedback: hand the last round's changed variables back to the foreground.
  return { posture: tasks.posture !== false, characterDesign: false, variables: tasks.variables !== false, ledger: false, variableFeedback: tasks.variableFeedback !== false }
}

export const DEFAULT_RENDER_DEPTH = 3
function renderDepthOf(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_RENDER_DEPTH }

export function applyTavernSettingsPatch(current, patch) {
  const next = Object.assign({}, object(current))
  const input = object(patch)
  if (Object.hasOwn(input, 'defaultWritingSkill')) {
    const { name, enabled } = object(input.defaultWritingSkill)
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || typeof enabled !== 'boolean') throw new Error('无效的写作 Skill 配置')
    const disabled = Array.isArray(next.defaultDisabledWritingSkills) ? next.defaultDisabledWritingSkills : []
    next.defaultDisabledWritingSkills = enabled ? disabled.filter(value => value !== name) : [...new Set([...disabled, name])]
  }
  for (const name of ['defaultForegroundModel', 'defaultBackgroundModel', 'defaultImageModel']) {
    if (!Object.hasOwn(input, name)) continue
    const selection = normalizeBackgroundModel(input[name])
    if (input[name] !== null && !selection) throw new Error('默认模型配置无效')
    next[name] = selection
  }
  if (Object.hasOwn(input, 'renderDepth')) {
    if (!Number.isSafeInteger(input.renderDepth) || input.renderDepth < 0 || input.renderDepth > 100) throw new Error('渲染深度必须是 0 到 100 的整数')
    next.renderDepth = input.renderDepth
  }
  if (Object.hasOwn(input, 'candidateDismissMode')) {
    if (!['after-fill', 'after-send'].includes(input.candidateDismissMode)) throw new Error('无效的候选项收起方式')
    next.candidateDismissMode = input.candidateDismissMode
  }
  if (Object.hasOwn(input, 'contextCompaction')) next.contextCompaction = { ...compactionPolicy(input.contextCompaction), revision: Date.now() }
  if (Object.prototype.hasOwnProperty.call(input, 'backgroundTasks')) {
    next.backgroundTasks = normalizeBackgroundTasks({ ...normalizeBackgroundTasks(next.backgroundTasks), ...object(input.backgroundTasks) })
  }
  if (Object.prototype.hasOwnProperty.call(input, 'compatibilityMode')) next.compatibilityMode = input.compatibilityMode === true
  if (Object.hasOwn(input, 'defaultStatusPanel')) next.defaultStatusPanel = input.defaultStatusPanel === true
  if (Object.hasOwn(input, 'promptSet')) applyPromptSetChange(next, object(input.promptSet))
  if (Object.hasOwn(input, 'systemAppendEnabled')) next.systemAppendEnabled = input.systemAppendEnabled === true
  if (Object.prototype.hasOwnProperty.call(input, 'webSearchEnabled')) next.webSearchEnabled = input.webSearchEnabled === true
  if (Object.prototype.hasOwnProperty.call(input, 'backgroundModel')) {
    next.backgroundModelRevision = (Number.isSafeInteger(next.backgroundModelRevision) ? next.backgroundModelRevision : 0) + 1
    if (input.backgroundModel === null) delete next.backgroundModel
    else {
      const backgroundModel = normalizeBackgroundModel(input.backgroundModel)
      if (backgroundModel === null) throw new Error('后台模型配置无效')
      next.backgroundModel = backgroundModel
    }
  }
  const legacyStory = Object.prototype.hasOwnProperty.call(input, 'storyPrompt') ? { name: 'story', text: input.storyPrompt } : null
  const promptChange = Object.prototype.hasOwnProperty.call(input, 'systemPrompt') ? object(input.systemPrompt) : legacyStory
  if (promptChange !== null) {
    const name = typeof promptChange.name === 'string' ? promptChange.name : ''
    if (name === '') throw new Error('系统提示词名称不能为空')
    const overrides = Object.assign({}, object(next.promptOverrides))
    if (promptChange.text === null) {
      delete overrides[name]
    } else {
      if (typeof promptChange.text !== 'string' || (promptChange.text.trim() === '' && name !== 'system-append')) throw new Error('系统提示词不能为空')
      if (promptChange.text.length > 100000) throw new Error('系统提示词不能超过 100000 字符')
      overrides[name] = promptChange.text.trim()
    }
    if (Object.keys(overrides).length === 0) delete next.promptOverrides
    else next.promptOverrides = overrides
  }
  if (Object.prototype.hasOwnProperty.call(input, 'systemPrompts')) {
    const values = object(input.systemPrompts)
    const overrides = Object.assign({}, object(next.promptOverrides))
    for (const [name, value] of Object.entries(values)) {
      if (typeof value !== 'string' || (value.trim() === '' && name !== 'system-append' && name !== 'card-system')) throw new Error('系统提示词不能为空: ' + name)
      if (value.length > 100000) throw new Error('系统提示词不能超过 100000 字符: ' + name)
      overrides[name] = value.trim()
    }
    if (Object.keys(overrides).length === 0) delete next.promptOverrides
    else next.promptOverrides = overrides
  }
  if (Array.isArray(input.resetSystemPrompts)) {
    const overrides = Object.assign({}, object(next.promptOverrides))
    for (const name of input.resetSystemPrompts) delete overrides[name]
    if (Object.keys(overrides).length === 0) delete next.promptOverrides
    else next.promptOverrides = overrides
  } else if (input.resetSystemPrompts === true) delete next.promptOverrides
  return next
}

export function presentTavernSettings(document, defaults) {
  const prompts = Object.keys(object(defaults)).map(function (name) {
    const custom = promptOverride(object(document), name)
    return { name, text: custom === null ? String(defaults[name] || '') : custom, customized: custom !== null }
  })
  const story = prompts.find(function (item) { return item.name === 'story' }) || { text: '', customized: false }
  return {
    defaultDisabledWritingSkills: Array.isArray(object(document).defaultDisabledWritingSkills) ? object(document).defaultDisabledWritingSkills.filter(name => typeof name === 'string') : [],
    defaultForegroundModel: normalizeBackgroundModel(object(document).defaultForegroundModel),
    defaultBackgroundModel: normalizeBackgroundModel(object(document).defaultBackgroundModel),
    defaultImageModel: normalizeBackgroundModel(object(document).defaultImageModel),
    contextCompaction: compactionPolicy(object(document).contextCompaction),
    candidateDismissMode: object(document).candidateDismissMode === 'after-fill' ? 'after-fill' : 'after-send',
    // Only the latest floors run a card's HTML interface; 0 renders every floor.
    renderDepth: renderDepthOf(object(document).renderDepth),
    defaultStatusPanel: object(document).defaultStatusPanel !== false,
    compatibilityMode: true,
    webSearchEnabled: object(document).webSearchEnabled === true,
    systemAppendEnabled: object(document).systemAppendEnabled !== false,
    // Phase 0 transport experiment. It is intentionally file-only and defaults
    // off; no settings UI or ordinary patch path exposes it.
    scaffoldingInjectionExperiment: object(document).scaffoldingInjectionExperiment === true,
    backgroundModel: normalizeBackgroundModel(object(document).backgroundModel),
    backgroundTasks: normalizeBackgroundTasks(object(document).backgroundTasks),
    // Card rendering uses a fixed trusted policy; legacy preferences are no longer applied.
    trustedCardMode: true,
    systemPrompts: prompts,
    promptSets: presentPromptSets(object(document)),
    storyPrompt: story.text,
    storyPromptCustomized: story.customized
  }
}

export function resolveSystemPrompt(document, name, fallback) {
  const custom = promptOverride(object(document), name)
  if (custom !== null) return custom
  return fallback(name)
}
