import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function clientExports(react = {}) {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console }
  vm.runInNewContext(source, sandbox)
  return descriptor.factory(function (name) { return name === 'react' ? react : {} })
}

const browser = await clientExports()

test('游玩控制不注册或覆盖原生子代理目录，也不显示后台身份栏', () => {
  const lineage = 'conversation.session.header.lineage'
  const nativeEntry = { name: lineage, id: 'native-subagent', priority: 0 }
  const entries = [nativeEntry]
  const slots = {
    inject(_name, activate) { return activate() },
    register(options) {
      if (options.name === lineage && entries.some(entry => entry.name === lineage && (entry.priority ?? 0) === (options.priority ?? 0))) {
        throw new Error('single slot "' + lineage + '" already has a registration at priority ' + (options.priority ?? 0))
      }
      entries.push(options)
      return () => entries.splice(entries.indexOf(options), 1)
    }
  }
  browser.createPlayControlsFeatureModule().register({ slots, ctx: {
    sessions: { list: { getSnapshot() { return { byId: {} } }, subscribe() { return () => {} } } }, get() { return {} }, effect(activate) { return activate() },
    betterSidebar: { registerTab() { return () => {} } }
  } })
  assert.deepEqual(entries.filter(entry => entry.name === lineage), [nativeEntry], '即使换 priority，也不能抢占原生子代理目录')
  const identity = entries.find(entry => entry.id === 'dsh-tavern-background-identity')
  assert.equal(identity, undefined)
})
