import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'

// 生产事故：失败轮次之外有一条正文的 tavernStoryTurn 指向该失败区间时，
// unclearedFailedTail 的循环清不掉这个节点，永远转下去（主线程 100% CPU，服务无响应，内存持续增长）。
// 死循环无法在本线程里超时，所以放进 Worker 里跑并设期限。
if (!isMainThread) {
  const { rollbackAvailability } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const M = { kind: 'model', provider: 'x', model: 'x' }
  const ev = (seq, type, data, surfaceOp) => ({ seq, type, data, ...(surfaceOp ? { surfaceOp: { op: surfaceOp } } : {}) })
  const events = [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' }, turn: 1 }, 'append'),
    ev(2, 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', source: M, content: [{ type: 'text', text: '正文1' }] } }, 'append'),
    ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(4, 'turn/start', { turn: 2 }),
    ev(5, 'user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: 'b' }], source: { kind: 'user' }, turn: 2 }, 'append'),
    ev(6, 'turn/end', { turn: 2, reason: { kind: 'error' } }),
    ev(7, 'assistant/message', { turn: 9, step: 1, message: { id: 'a2', role: 'assistant', source: { ...M, tavernStoryTurn: 2 }, content: [{ type: 'text', text: '正文2' }] } }, 'append'),
  ]
  const chat = { messages: [{ role: 'assistant', greeting: true, turn: 1 }, { role: 'user', text: 'a' }, { role: 'assistant', turn: 1, text: '正文1' }] }
  const result = rollbackAvailability(chat, { events, nodes: [1, 2, 5, 7] })
  parentPort.postMessage({ failedTurns: result.failedTurns, canRollback: result.canRollback })
} else {
  test('回退可用性计算必须终止：失败区间之外的正文不能让清理循环空转', async () => {
    const worker = new Worker(new URL(import.meta.url))
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => { worker.terminate(); resolve('hang') }, 5000)
      worker.once('message', value => { clearTimeout(timer); worker.terminate(); resolve(value) })
      worker.once('error', error => { clearTimeout(timer); resolve({ error: String(error) }) })
    })
    assert.notEqual(outcome, 'hang', 'rollbackAvailability 没有在 5 秒内返回')
    assert.equal(outcome.error, undefined)
    assert.deepEqual(outcome.failedTurns, [], '这条正文不属于失败区间，不算待清理的失败轮次')
    assert.equal(outcome.canRollback, true)
  })
}
