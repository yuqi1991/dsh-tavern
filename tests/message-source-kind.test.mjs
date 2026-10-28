import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  isPluginSource, isProducerSource, isSystemPromptSource, producerKind, producerSource, sourceProducerName,
} from '../tavern-plugin/lib/domain/message-source.js'
import { ensureSessionSystemHead } from '../tavern-plugin/lib/domain/session-events.js'

const root = fileURLToPath(new URL('../tavern-plugin', import.meta.url))

test('producerKind 与 DSH v3→v4 迁移推导一致', function () {
  assert.equal(producerKind('dsh-tavern'), 'plugin:dsh-tavern')
  assert.equal(producerKind('dsh-tavern-regen'), 'plugin:dsh-tavern-regen')
  assert.equal(producerKind('@deepseek-ai/dsh-system-prompt', 'system'), 'system-prompt')
  assert.equal(producerKind('@deepseek-ai/dsh-system-prompt'), 'runtime-context')
  assert.equal(producerSource('dsh-tavern', { form: 'snapshot' }).kind, 'plugin:dsh-tavern')
  assert.deepEqual(producerSource('dsh-tavern'), { kind: 'plugin:dsh-tavern' })
})

test('读取侧同时认生产者自有 kind 与迁移前的裸 plugin 包装', function () {
  assert.equal(sourceProducerName({ kind: 'plugin:dsh-tavern' }), 'dsh-tavern')
  assert.equal(sourceProducerName({ kind: 'plugin', plugin: 'dsh-tavern' }), 'dsh-tavern')
  assert.equal(sourceProducerName({ kind: 'user' }), '')
  assert.equal(sourceProducerName({ kind: 'model', provider: 'x' }), '')
  assert.equal(sourceProducerName(undefined), '')
  assert.equal(sourceProducerName({ kind: 'plugin' }), '')
  assert.equal(isPluginSource({ kind: 'plugin:dsh-tavern' }), true)
  assert.equal(isPluginSource({ kind: 'plugin', plugin: 'dsh-tavern' }), true)
  // 迁移前也可能不带 plugin 名字：仍须算作插件注入，否则会被当成玩家输入。
  assert.equal(isPluginSource({ kind: 'plugin' }), true)
  assert.equal(isPluginSource({ kind: 'user' }), false)
  assert.equal(isProducerSource({ kind: 'plugin:dsh-tavern' }, 'dsh-tavern'), true)
  assert.equal(isProducerSource({ kind: 'plugin', plugin: 'dsh-tavern' }, 'dsh-tavern'), true)
  assert.equal(isProducerSource({ kind: 'plugin:dsh-tavern' }, 'dsh-tavern-phone'), false)
})

test('原生 system-prompt 行两种形态都识别', function () {
  assert.equal(isSystemPromptSource({ kind: 'system-prompt' }), true)
  assert.equal(isSystemPromptSource({ kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }), true)
  assert.equal(isSystemPromptSource({ kind: 'plugin:dsh-tavern' }), false)
  assert.equal(isSystemPromptSource({ kind: 'runtime-context' }), false)
})

test('合成的 system 头使用 v4 的 producer-owned kind', function () {
  const appended = []
  const session = {
    id: 'session-head', header: { version: 4 }, surface: { nodes: [] },
    append(type, data, intent) { appended.push({ type, data, intent }) },
  }
  ensureSessionSystemHead(session)
  // Released V4 rejects a surface event outside an open turn, so the head is
  // reserved together with the opening turn it belongs to.
  assert.deepEqual(appended.map(event => event.type), ['turn/start', 'step/start', 'system/message'])
  const head = appended[2]
  assert.equal(head.data.message.source.kind, 'system-prompt')
})

// 会话格式 v4 的 source() 校验拒收裸 kind:'plugin'（报
// 「format v4 message requires a producer-owned source kind」），
// 所以 Tavern 任何写入点都不该再出现「kind: 'plugin', plugin: '…'」这一对。
test('Tavern 源码里不再有退役的裸 plugin 消息源', async function () {
  const retires = []
  const pairs = /kind:\s*(['"])plugin\1\s*,\s*plugin:/g
  const solo = /source:\s*\{\s*kind:\s*(['"])plugin\1\s*,?\s*\}/g
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.name.endsWith('.js')) continue
      // 兼容垫层本身要按定义写这两种形态，故排除。
      if (full.endsWith(join('domain', 'message-source.js'))) continue
      // plugin-worldbook.js 的 record.source 是 Tavern 自己的世界书记录来源标记
      // （plugin / card），不进入 Session，不是 DSH 的 message source。
      if (full.endsWith(join('domain', 'plugin-worldbook.js'))) continue
      const relative = full.slice(full.indexOf('tavern-plugin'))
      const text = await readFile(full, 'utf8')
      for (const match of text.matchAll(pairs)) retires.push(relative + ': ' + match[0])
      for (const match of text.matchAll(solo)) retires.push(relative + ': ' + match[0])
    }
  }
  await walk(join(root, 'lib'))
  await walk(join(root, 'packages', 'dsh-tavern-card-memory'))
  assert.deepEqual(retires, [])
})
