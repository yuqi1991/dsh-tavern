import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './fixtures/history-scan-session.mjs'
import { createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
test('大范围替换引用校验只线性读取来源', () => {
  const { session } = fixture(4000)
  let reads = 0
  const refs = new Proxy(Array.from({ length: 4000 }, (_, i) => i), { get(a, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(a,key) } })
  createSessionSurfaceMutator(session).replace('user/message', { id: 'edit', content: [] }, { start: 0, end: 3999, sourceEventSeqs: refs })
  assert.ok(reads <= 12000, `reference reads: ${reads}`)
})
