import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { parseExpressionAt } from 'acorn'

const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
function functionSource(name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'Missing client function: ' + name)
  const node = parseExpressionAt(source, start, { ecmaVersion: 'latest' })
  return source.slice(start, node.end)
}
function dockWith(nodes, mode = 'story', releaseCapabilities = { sceneImages: true }, canClearIncompleteReply = false) {
  const selections = []
  const context = {
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useTavernSessionMode: () => mode,
    useLiveTavernView: () => ({ view: { canClearIncompleteReply, releaseCapabilities, latestAssistantTurn: nodes.some(node => node.kind === 'assistant') ? 2 : 0, replyProjections: nodes.some(node => node.kind === 'assistant') ? [{ turn: 1 }, { turn: 2 }] : [] } }),
    isPlayMode: value => ['story', 'free', 'script'].includes(value),
    CandidateAction: 'actions', TavernCompactionAction: 'compact', TavernMoreActions: 'more', SceneImageAction: 'scene-image',
    props: {
      sessionId: 'session1',
      useSession(selector) { selections.push('session'); return selector({ running: false, blank: false }) },
      useChat(selector) { selections.push('chat'); return selector({ legacy: { nodes } }) }
    }
  }
  // Execute the actual dock component, with alpha.2's split lifecycle/Chat props.
  const helper = source.includes('function latestTavernAssistantMessageId(')
    ? functionSource('latestTavernAssistantMessageId') : ''
  const dock = functionSource('CandidateDockActions')
  const rendered = vm.runInNewContext(helper + dock + '\nCandidateDockActions(props)', context)
  return { rendered, selections }
}

test('生图操作在每轮的操作栏里，不再出现在输入框上方', () => {
  const nodes = [{ kind: 'assistant', messageId: 'partial-reply' }]
  for (const pendingReply of [true, false]) {
    const dock = dockWith(nodes, 'story', { sceneImages: true }, pendingReply).rendered
    assert.equal(dock.children.some(child => child?.type === 'scene-image'), false)
    assert.equal(dock.children.some(child => child?.type === 'more'), true)
  }
})
