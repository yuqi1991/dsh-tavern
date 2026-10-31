import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createSessionStateView } from '../tavern-plugin/lib/domain/chat-session-state.js'

const clientSource = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

const serverSource = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')

const scriptHostAdapterSource = await readFile(new URL('../tavern-plugin/lib/domain/tavern-script-host-adapter.js', import.meta.url), 'utf8')

function between(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return source.slice(from, to)
}

test('开场白创建失败时在选择弹窗内持续显示具体阶段和错误', () => {
  const sidebar = between(clientSource, 'function TavernSidebar(', 'function TavernResourcesTab')
  const refresh = between(sidebar, 'function refresh(kinds)', 'React.useEffect(function ()')
  const playFlow = between(sidebar, 'async function newConversation', 'async function preparePlayConversation')
  const lifecycle = between(clientSource, 'function createConversationLifecycleModule', 'function isIgnoredTavernError')

  assert.match(sidebar, /const pickerError = error \? h\("div", \{ className: "dsh-tavern-picker-error", role: "alert" \}/)
  assert.match(sidebar, /重新连接已创建的 Session/)
  assert.match(sidebar, /const playPicker = h\("div",[^\n]+pickerError/)
  assert.match(sidebar, /!picking && error \? h\("div", \{ className: "dsh-tavern-dock-error", role: "alert" \}/)
  assert.doesNotMatch(refresh, /setError\(""\)/)
  assert.match(lifecycle, /let phase = "清理当前空白对话"/)
  assert.match(lifecycle, /phase = "创建 DSH Session"/)
  assert.match(lifecycle, /phase = request\.kind === "card" \? "创建卡片工作台对话" : "写入人物卡开场白"/)
  assert.match(lifecycle, /failure\.phase = phase/)
  assert.match(playFlow, /err && err\.phase/)
})

test('酒馆状态读取 MVU 回执时使用当前模块可用的复制能力', () => {
  const stored = { version: 1, status: 'updated', changes: [{ path: '/hp', after: 9 }] }
  const view = createSessionStateView({ activity: () => ({}), evidence: () => ({}) })
  const receipts = view.receipts({ messages: [{ role: 'assistant', turn: 2, mvu: { receipt: stored } }] })
  assert.deepEqual(receipts, [{ turn: 2, receipt: stored }])
  receipts[0].receipt.changes[0].after = 1
  assert.equal(stored.changes[0].after, 9, 'reading receipts must not expose persisted objects')
})

test('创建对话失败时服务端记录请求边界但不记录开场白正文', () => {
  const dispatch = between(serverSource, "case 'startChat': {", "case 'getImageAgentUndo'")

  assert.match(dispatch, /console\.error\('dsh-tavern: 创建对话失败'/)
  assert.match(dispatch, /cardPath: str\(args && args\.path\)/)
  assert.match(dispatch, /openingId: str\(args && args\.openingId\)/)
  assert.doesNotMatch(dispatch, /greeting|openingText/)
})

test('人物卡目录只读取卡片名称和剧本绑定，不加载或切分完整剧本', () => {
  const listing = between(serverSource, 'async function listCards()', 'async function getCardOpenings')
  const sidebar = between(clientSource, 'function TavernSidebar(', 'function TavernResourcesTab')

  assert.match(listing, /fileResources\.scriptBindingsForCards\(cardPaths\)/)
  assert.match(listing, /fileResources\.hasCardImage\(cardPath\)/)
  assert.match(listing, /card\.importedAt/)
  assert.match(listing, /orderCardsByNewestImport\(cards\)/)
  assert.match(listing, /hasImage/)
  assert.doesNotMatch(listing, /readScript|splitNovelText|sourceChars|chunkCount/)
  assert.match(sidebar, /"剧本：" \+ card\.script\.title/)
  assert.doesNotMatch(sidebar, /card\.script\.chunkCount/)
})

test('人物卡 Helper 的世界书写入按资源串行，避免生命周期事件并发覆盖', () => {
	assert.match(scriptHostAdapterSource, /serializeWorldbook\(worldbookKey\(initial\.record\)/)
	assert.match(scriptHostAdapterSource, /previous\.catch\(function \(\) \{\}\)\.then\(work\)/)
	assert.match(scriptHostAdapterSource, /await options\.worldBooks\.update/)
})

test('隔离 Helper iframe 可以只读加载已锁定的本机远程资源', () => {
	const handler = between(serverSource, "handler: async (req, res) => {", "function contentText(message)")
	assert.match(handler, /const readsCachedAsset = req\.method === 'GET' && cachedAssetMatch/)
	assert.match(handler, /const readsStaticAsset = req\.method === 'GET'/)
	assert.match(handler, /const localOrOpaqueOrigin =/)
	assert.match(handler, /if \(readsStaticAsset && !localOrOpaqueOrigin\)/)
	assert.match(handler, /if \(!readsCachedAsset && !readsStaticAsset && !readsOfficialMvu && !readsFullTemplate && !readsRuntimeAsset && !readsClientAsset && !sceneSameOrigin && typeof origin === 'string'/)
	assert.match(handler, /'Access-Control-Allow-Origin': '\*'/)
	assert.match(handler, /'Cross-Origin-Resource-Policy': 'cross-origin'/)
})

test('HTTP RPC 在启动恢复前注册，并等待运行时完成初始化', () => {
	const routeRegistration = serverSource.indexOf("ctx.effect(() => webServer.register({")
	const runtimeInitialization = serverSource.indexOf('await initializeRuntimeState()')
	const runtimeReady = serverSource.indexOf('settleRuntimeReadiness({ ok: true })')
	const historyRecovery = serverSource.indexOf('recoverRuntimeHistory(recoveredIndex).catch')
	const handler = between(serverSource, "handler: async (req, res) => {", "function contentText(message)")
	assert.notEqual(routeRegistration, -1)
	assert.notEqual(runtimeInitialization, -1)
	assert.notEqual(runtimeReady, -1)
	assert.notEqual(historyRecovery, -1)
	assert.ok(routeRegistration < runtimeInitialization)
	assert.ok(runtimeInitialization < runtimeReady)
	assert.ok(runtimeReady < historyRecovery)
	assert.match(handler, /const readiness = await runtimeReadiness/)
	assert.match(handler, /if \(!readiness\.ok\) throw readiness\.error/)
})
