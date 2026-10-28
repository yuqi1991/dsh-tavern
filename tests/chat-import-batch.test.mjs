import test from 'node:test'
import assert from 'node:assert/strict'
import { chatImportBatchRun, chatImportBatchSummary, chatImportMergedWarnings, chatImportMergedPreview } from '../tavern-plugin/lib/domain/chat-import-batch.js'

const entry = (fileName, preview) => ({ fileName, preview })

test('批量导入逐份顺序执行，单份失败不影响其余', async () => {
  const order = []
  const entries = [entry('a.jsonl', {}), entry('b.jsonl', {}), entry('c.jsonl', {})]
  const progress = []
  const result = await chatImportBatchRun(entries, async item => {
    order.push(item.fileName)
    if (item.fileName === 'b.jsonl') throw new Error('会话创建失败')
    return { sessionId: 'session:' + item.fileName }
  }, step => progress.push(step.index + '/' + step.total + ':' + step.entry.fileName))
  assert.deepEqual(order, ['a.jsonl', 'b.jsonl', 'c.jsonl'])
  assert.deepEqual(progress, ['0/3:a.jsonl', '1/3:b.jsonl', '2/3:c.jsonl'])
  assert.deepEqual(result.succeeded.map(item => item.result.sessionId), ['session:a.jsonl', 'session:c.jsonl'])
  assert.deepEqual(result.failed.map(item => [item.entry.fileName, item.message]), [['b.jsonl', '会话创建失败']])
})

test('全部成功时不打扰用户，有失败时逐个点名', () => {
  assert.equal(chatImportBatchSummary({ succeeded: [{}, {}], failed: [] }), '')
  assert.equal(chatImportBatchSummary({ succeeded: [{}], failed: [{ entry: { fileName: 'b.jsonl' }, message: '解析失败' }] }),
    '已导入 1 份，其余 1 份失败——b.jsonl：解析失败')
  assert.equal(chatImportBatchSummary({ succeeded: [], failed: [{ entry: { fileName: 'b.jsonl' }, message: '解析失败' }] }),
    '导入失败——b.jsonl：解析失败')
})

test('同一条警告只显示一次，并列出触发它的文件', () => {
  const entries = [entry('a.jsonl', { warnings: ['缺少快照', '顺序异常'] }), entry('b.jsonl', { warnings: ['缺少快照'] })]
  assert.deepEqual(chatImportMergedWarnings(entries), ['a.jsonl、b.jsonl：缺少快照', 'a.jsonl：顺序异常'])
  assert.deepEqual(chatImportMergedWarnings([entry('a.jsonl', { warnings: ['缺少快照'] })]), ['缺少快照'])
})

test('多份记录合并为一次确认：条数相加，不兼容与 MVU 任一命中即生效', () => {
  const merged = chatImportMergedPreview([
    entry('a.jsonl', { count: 3, warnings: [], userName: '', lastMessage: '甲' }),
    entry('b.jsonl', { count: 4, warnings: ['缺少快照'], hasMvu: true, incompatible: true, userName: '阿九', lastMessage: '乙' })
  ])
  assert.equal(merged.count, 7)
  assert.equal(merged.hasMvu, true)
  assert.equal(merged.incompatible, true)
  // 称呼不同：留空，导入时每份沿用自己的称呼
  assert.equal(merged.userName, '')
  assert.equal(chatImportMergedPreview([entry('a.jsonl', { userName: '阿九' }), entry('b.jsonl', { userName: '阿九' })]).userName, '阿九')
  assert.equal(merged.lastMessage, '')
  assert.deepEqual(merged.warnings, ['b.jsonl：缺少快照'])
})

test('单份记录的合并预览保留原来的最后一条消息', () => {
  const merged = chatImportMergedPreview([entry('a.jsonl', { count: 3, warnings: ['缺少快照'], userName: '阿九', lastMessage: '甲' })])
  assert.equal(merged.count, 3)
  assert.equal(merged.lastMessage, '甲')
  assert.deepEqual(merged.warnings, ['缺少快照'])
})
