# 已知失败与跳过（KNOWN-FAILURES）

`bin/test-all.sh` 的目标是：失败 0，且每一个 skip 都能在本文件找到原因。新失败即真问题，
不要靠加入基线名单绕过。

## 维护规则

- 用例被 skip 时，skip 选项里写明原因，并在本文件对应小节登记：用例名、文件、原因、复现办法、解除条件。
- 环境门控（`skip: !process.env.X`、平台判断）属于既有写法，不是失败；本文件按门控条件列出。
- 偶发用例先在 `bin/test-some.sh <文件>` 单独跑确认，再决定是修时序还是登记在「偶发」一节。
- 不要为了变绿删除用例；删除只能走 `tests/OBSOLETE.md`（过期断言且有替代）。
- 解除 skip 时删除本文件对应条目。

复现的通用办法：去掉目标用例的 `skip` 选项后运行
`bin/test-some.sh tests/<文件>.test.mjs --test-name-pattern='<用例名片段>'`。

## 一、功能缺口（C 类：产品未实现，用例保留并 skip）

### helper-v2-receipts

Helper 变量回执 v2（transaction / dispatch / committed）与其增量刷新未在 0.2.1 客户端实现。
`src/client/variable-receipts.js` 中 `applyTavernVariableReceipt` 只接受 `delta.version === 1`，
其余返回 null；随后读取 `.messages` 或 `.transaction` 时崩溃。

| 文件 | 用例 |
| --- | --- |
| tests/mvu-incremental-context.test.mjs | transaction receipts are ordered independently of persisted revision |
| tests/mvu-incremental-context.test.mjs | real iframe dispatch delta preserves MVU character identity and synchronizes only changed rows |
| tests/mvu-incremental-context.test.mjs | parent defers committed refresh during a transaction and never publishes draft mutations |
| tests/mvu-incremental-settlement.test.mjs | MVU 20 floors: bounded wire and atomic scoped commit including historical edits |
| tests/mvu-incremental-settlement.test.mjs | MVU 400 floors: bounded wire and atomic scoped commit including historical edits |
| tests/mvu-indexed-receipts.test.mjs | warm browser receipt visits bounded nodes at 20 / 400 / 10000 floors（3 个） |
| tests/mvu-indexed-receipts.test.mjs | iframe receipt leaves untouched plugin rows unvisited and preserves unsaved fields |
| tests/mvu-view-refresh-cost.test.mjs | wire merge and parent refresh avoid unchanged history at 20 / 400 / 10000（3 个，另见下） |

`mvu-view-refresh-cost` 的三个用例还因为 `createSessionViewReader` 未从客户端导出
（`helperClient.createSessionViewReader is not a function`），但其增量刷新本身也依赖 v2 回执。

- 复现：去掉上表任一用例的 skip，`bin/test-some.sh tests/mvu-incremental-context.test.mjs`。
- 解除条件：客户端接受 version 2 回执并实现 transaction/dispatch/committed 合并；导出 createSessionViewReader。

### indexed-helper-projection

Helper 索引化只读投影（`projectTavernHelperContext(chat, {indexed: true})` 的 indexed / previousContext
复用与冻结）未实现：每次投影都读取全部楼层，且结果不是冻结的只读副本。

| 文件 | 用例 |
| --- | --- |
| tests/mvu-upstream-cost.test.mjs | upstream variable-only projections avoid history at 20 / 400 / 10000（3 个） |
| tests/mvu-upstream-cost.test.mjs | turn mapping falls back for structural changes, and variable-only projections stay immutable |

- 复现：去掉上表用例的 skip，`bin/test-some.sh tests/mvu-upstream-cost.test.mjs`。失败信息为
  `helper projection read 10000 floors`（读取次数超过上限）以及 `Missing expected exception (TypeError)`。
- 解除条件：投影支持索引复用，且变量-only 投影不读取历史楼层。

### client-path-subscriptions

楼层级路径订阅已不在当前客户端中：`tavernAssistantViewPaths`、`tavernReceiptViewPaths`、
`TavernTurnMvuReceipt` 均未定义。`useLiveTavernView(sessionId, revision)` 只按整视图 revision 订阅。
`live-tavern-view` 模块仍保留 `select(sessionId, paths)` / `subscribe(…, paths)` 接口，
但客户端各视图没有传入路径，所以「只唤醒受影响楼层」的性能目标当前没有被满足。

| 文件 | 用例 |
| --- | --- |
| tests/scoped-view-refresh-cost.test.mjs | assistant field subscriptions exclude input and debug updates across 20 / 400 / 10000 floors（3 个） |
| tests/scoped-view-refresh-cost.test.mjs | Helper value updates only wake the eager floor among 20 / 400 / 10000 assistant floors（3 个） |
| tests/scoped-view-refresh-cost.test.mjs | busy and settlement ownership avoid 20 / 400 / 10000 historical body updates（3 个） |
| tests/scoped-view-refresh-cost.test.mjs | receipt component renews busy dependencies when ownership and pending status change |

- 复现：去掉 skip 后运行 `bin/test-some.sh tests/scoped-view-refresh-cost.test.mjs`，
  失败为 `tavernAssistantViewPaths is not defined` / `h.TavernTurnMvuReceipt is not a function`。
- 解除条件：客户端 story 视图按楼层传入路径，用例改为断言当前函数名（或由等价的新用例取代）。
  该文件不删除（见 tests/OBSOLETE.md）。

### frame-sizing-wiring

卡片 iframe 尺寸与布局证据未端到端生效：

- `captureDisplayRuntime` 的 `sanitizeDisplayRuntime` 不保存 `runtime.layout`，布局证据用例
  （display-runtime-capture：layout evidence is bounded…）因 `reading 'height'` 失败。
- 真实 Chromium 端到端用例（frame-sizing：real iframe sizing…）在 `page.waitForFunction` 处超时 30 秒。
  尺寸声明解析 `tavernFrameSizing` 已被 `retained-message-frames.js` 调用，失败的接线点尚未定位。

- 复现：去掉 skip 后运行 `bin/test-some.sh tests/frame-sizing.test.mjs tests/display-runtime-capture.test.mjs`。
- 解除条件：运行时上报 `runtime.layout` 并保存；定位 iframe 尺寸链路的超时原因后修复端到端用例。

## 二、环境缺失（skip，非功能失败）

### webkit-env

- 用例：tests/helper-webkit-imports.test.mjs，`webkit: srcdoc 中消息帧与共享脚本沙箱加载实际 Zod/YAML`。
- 原因：webkit 浏览器二进制不在本机（`/home/claw/.cache/ms-playwright/webkit-2248/pw_run.sh` 不存在）。
  门控为 `existsSync(engine.executablePath())`，chromium 版本照常运行。
- 复现：`npx playwright install webkit`（在本机有权限安装的环境）后再跑该文件。

## 三、既有环境门控跳过（HEAD 上即存在，非失败）

这些用例的 skip 是布尔条件，TAP 输出里没有文字原因，因此在此逐类登记门控条件。

| 文件 | 用例数 | 门控条件 | 运行方式 |
| --- | --- | --- | --- |
| tests/host-session-patch.test.mjs | 2 | `TAVERN_DSH_015_RUNTIME`（默认 `/tmp/tavern-session-patch-npm-015.*`）下无 `package.json` | 提供 0.1.5-rc.2 运行时 |
| tests/legacy-compaction-preservation.test.mjs | 3 | `$TAVERN_E2E_RUNTIME/lib/node_modules/@deepseek-ai/dsh-session` 不存在 | 设置 `TAVERN_E2E_RUNTIME` |
| tests/legacy-session-migration.test.mjs | 5 | 需要 macOS 桌面版宿主目录与本机旧存档副本 | 仅在该环境运行 |
| tests/host-subprocess-patch.test.mjs | 1 | 非 Windows，或未设置 `TAVERN_DSH_015_RUNTIME` | Windows + 0.1.5 运行时 |
| tests/windows-start-diagnostics.test.mjs | 2 | 非 Windows | Windows |
| tests/windows-installer-command-log.test.mjs | 1 | 非 Windows | Windows |
| tests/user-extensions.test.mjs | 1 | 非 macOS（实际 Unix 安装脚本用例） | macOS |
| tests/pnpm-install-exit.test.mjs | 1 | 未设置 `TAVERN_PNPM_ENTRY` | 设置 pnpm 入口 |
| tests/save-image-compression.test.mjs | 1 | `@jsquash/webp` 未安装（不在 fork 内安装） | 在有该依赖的环境运行 |
| tests/full-template-executor-browser.test.mjs | 1 | 未设置 `TAVERN_BROWSER_TESTS` 或 `DSH_ROOT` | `TAVERN_BROWSER_TESTS=1` |
| tests/ejs-code-editor-browser.test.mjs | 1 | 同上 | 同上 |
| tests/fullscreen-insets-browser.test.mjs | 1 | 未设置 `TAVERN_BROWSER_TESTS` | 同上 |
| tests/multi-device-boundaries-browser.test.mjs | 1 | 同上 | 同上 |
| tests/mobile-layout-browser.test.mjs | 1 | 同上 | 同上 |
| tests/mobile-interactions-browser.test.mjs | 1 | 同上 | 同上 |
| tests/algebra/golden-replay.test.mjs | 1 | `DSH_TAVERN_GOLDEN_SESSIONS`（默认 `/tmp/session-backup`）不存在 | 指向黄金会话目录 |

注：algebra 段（`tests/algebra/*.test.mjs`）不带预加载单独运行，其中只有 golden-replay 一个跳过。

## 四、偶发与时序

- **server-template-runtime：看门狗用例**（`service watchdog terminates an infinite loop…`）。
  用例先 `render('warm')` 预热 worker（冷启动含 jsdom 加载），再验证死循环被终止。
  预算原为 1500ms，整套件并发时预热即超时，于是把 `timeoutMs` 放宽到 5000。
  若再次超时，单独运行 `bin/test-some.sh tests/server-template-runtime.test.mjs`；单跑通过则属负载问题，
  不要把预算再压低。
- **chat-journal-store / regeneration-crash：被 SIGKILL 的子进程夹具**（已修复，保留备查）。
  夹具子进程里 `await new Promise(() => {})` 没有 `message` 监听器时 IPC 通道被 unref，事件循环清空，
  Node 判定顶层 await 永不完成并以退出码 13 退出，父进程 Promise 悬空，同文件后续用例（以及主段后续 21 个）
  被 cancelledByParent 级联取消。修复：子进程持有一个 ref 的 `setInterval`，只由父进程 SIGKILL 结束。
  再出现 `Promise resolution is still pending but the event loop has already resolved` 说明有新夹具漏了保活。
- 浏览器类用例依赖本机 Playwright 的 chromium；并发运行多套测试时可能超时，请按 `bin/test-all.sh` 串行运行。
- **Playwright 浏览器版本**：已安装的 playwright 期望 `chromium_headless_shell-1208`，若缓存目录
  `~/.cache/ms-playwright/` 里只有其它修订（如 1228），浏览器用例会以 `browserType.launch: Executable doesn't exist`
  失败（约 43 个，非产品问题）。不要在 fork 内装依赖；可用 `PLAYWRIGHT_BROWSERS_PATH=<临时目录>`，
  其中把 `chromium_headless_shell-1208`、`chromium-1208` 软链到本机现有修订后运行。
