import test from 'node:test'
import assert from 'node:assert/strict'
import { runDetachedWrite } from '../../lib/domain/detached-write.js'
import { TransactionConflict } from '../../lib/domain/conversation-algebra/index.js'

const quiet = () => { const lines = []; return { lines, logger: { error: (...args) => lines.push(args.join(' ')) } } }

test('a head conflict is retried against the new head and then succeeds', async () => {
  const { lines, logger } = quiet()
  let calls = 0
  const result = await runDetachedWrite(async () => { if (++calls < 3) throw new TransactionConflict(42, 43); return 'written' }, { label: 'x', logger })
  assert.equal(result, 'written')
  assert.equal(calls, 3)
  assert.deepEqual(lines, [])
})

test('running out of attempts logs and resolves instead of rejecting', async () => {
  const { lines, logger } = quiet()
  let calls = 0
  const result = await runDetachedWrite(async () => { calls++; throw new TransactionConflict(42, 43) }, { label: '回复写回', logger })
  assert.equal(result, undefined)
  assert.equal(calls, 3)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /回复写回失败.*期望头 42，实际头 43/)
})

test('other errors are not retried and never escape', async () => {
  const { lines, logger } = quiet()
  let calls = 0
  await assert.doesNotReject(runDetachedWrite(async () => { calls++; throw new Error('磁盘已满') }, { label: 'y', logger }))
  assert.equal(calls, 1)
  assert.match(lines[0], /磁盘已满/)
})
