import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectWorldBookDocument, updateWorldBookDocument } from '../tavern-plugin/lib/domain/worldbook-resource.js'
import { projectTavernHelperWorldbook, replaceTavernHelperWorldbookOperations } from '../tavern-plugin/lib/domain/tavern-helper-worldbook.js'

// 「私立闪耀之星女学园」的内嵌世界书里有两条条目用 UUID 字符串当 id（SillyTavern 允许）。
// 卡片的模式选择界面用 updateWorldbookWith 切换条目启用状态，原样写回这些编号。
function cardBook() {
  return {
    name: '学园',
    entries: [
      { id: 0, keys: ['理事长'], content: 'S 模式设定', comment: 'S模式', enabled: false, insertion_order: 100, position: 'after_char', extensions: {} },
      { id: '91e53766-d647-4dea-a442-b29926f38ad9', keys: [], content: '初始变量', comment: '[InitVar]请勿打开', enabled: false, insertion_order: 100, position: 'after_char', extensions: {} },
      { id: 'b97eb7b1-075c-495b-9840-40fdedadac48', keys: [], content: '变量列表', comment: '变量列表', enabled: true, insertion_order: 100, position: 'after_char', extensions: {} }
    ]
  }
}

test('内嵌世界书条目用字符串编号时，卡片脚本改启用状态后能原样写回', () => {
  const document = cardBook()
  const view = inspectWorldBookDocument(document)
  const entries = projectTavernHelperWorldbook(view).entries
  assert.equal(entries[1].uid, '91e53766-d647-4dea-a442-b29926f38ad9')
  const requested = entries.map(entry => entry.name === 'S模式' ? { ...entry, enabled: true } : entry)
  const operations = replaceTavernHelperWorldbookOperations(view, requested)
  assert.deepEqual(operations.map(operation => operation.op), ['update'])
  const saved = updateWorldBookDocument(document, { operations }).document
  assert.deepEqual(saved.entries.map(entry => entry.enabled), [true, false, true])
  assert.deepEqual(saved.entries.map(entry => entry.id), [0, '91e53766-d647-4dea-a442-b29926f38ad9', 'b97eb7b1-075c-495b-9840-40fdedadac48'])
})

test('新增条目仍需整数编号，重复编号仍被拒绝', () => {
  const view = inspectWorldBookDocument(cardBook())
  const entries = projectTavernHelperWorldbook(view).entries
  assert.throws(() => replaceTavernHelperWorldbookOperations(view, [...entries, { uid: 'new-uuid', name: '新条目' }]), /世界书条目编号无效或重复/)
  assert.throws(() => replaceTavernHelperWorldbookOperations(view, [...entries, entries[1]]), /世界书条目编号无效或重复/)
  const added = replaceTavernHelperWorldbookOperations(view, [...entries, { name: '新条目' }])
  assert.deepEqual(added.map(operation => [operation.op, operation.uid]), [['add', 1]])
})
