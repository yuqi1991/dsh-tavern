import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

// The client patch wraps the host assembler's buildNode; drive it with the
// node shapes the host chat Definition builds for user/message context rows.
function patched(build) {
  class ConversationNodeAssembler { buildNode(context, target) { return build(context, target) } }
  const ctx = vm.createContext({ require: () => ({ ConversationNodeAssembler }) })
  vm.runInContext(readFileSync(new URL('../../tavern-plugin/src/client/modules/assistant-visibility.js', import.meta.url), 'utf8') + '\ninstallTavernAssistantVisibilityPatch(require)', ctx)
  return (data, target = 'chat') => new ConversationNodeAssembler().buildNode({ kind: 'input-message' }, target)?.visibility
}
const context = (source, content = []) => ({ kind: 'context', content, source })

test('legacy bookkeeping rows are hidden at the assembler, real context stays', () => {
  let data
  const visibility = patched(() => ({ kind: data.kind, visibility: 'visible', data }))
  const check = (value, expected, target) => { data = value; assert.equal(visibility(value, target), expected, JSON.stringify(value.source)) }
  check(context({ kind: 'plugin', plugin: 'dsh-tavern', form: 'conversation-metadata' }), 'hidden')
  check(context({ kind: 'plugin', plugin: 'dsh-tavern', form: 'checkout' }), 'hidden')
  check(context({ kind: 'plugin', plugin: 'dsh-tavern-surface-restore' }), 'hidden')
  // Seeds, frames and catalogs carry content and stay visible.
  check(context({ kind: 'plugin', plugin: 'dsh-tavern', form: 'conversation-metadata' }, [{ type: 'text', text: 'x' }]), 'visible')
  check(context({ kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame' }), 'visible')
  check(context({ kind: 'skill-catalog', form: 'catalog' }), 'visible')
  check({ kind: 'user', content: [], source: { kind: 'user' } }, 'visible')
  // Other views (trajectory) keep every row.
  check(context({ kind: 'plugin', plugin: 'dsh-tavern', form: 'conversation-metadata' }), 'visible', 'trajectory')
})
