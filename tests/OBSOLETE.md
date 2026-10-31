# 过期测试与改写记录（OBSOLETE）

本文件记录「测试被删除或断言被改写」的每一处：删了什么或改了什么、为什么、被什么取代。
被跳过（skip）的用例不在这里，见 `tests/KNOWN-FAILURES.md`。

## 一、删除

本轮清理没有删除任何测试用例文件或用例。

曾在工作区里整文件删除 `tests/scoped-view-refresh-cost.test.mjs`，复核后恢复：它断言的是
楼层级订阅的性能目标，产品里路径订阅接口仍在、客户端未接线，属于功能缺口而非过期断言。
现为 10 个带原因的 skip，见 `tests/KNOWN-FAILURES.md#client-path-subscriptions`。

## 二、断言改写（用例保留，过期断言按当前设计替换）

| 文件 | 用例 | 旧断言 | 新断言 | 被什么取代 |
| --- | --- | --- | --- | --- |
| tests/tavern-swipe-regeneration.test.mjs | 编辑重生成输入时同步消息与滑动文本，并清除旧展示投影 | 正文、源文本、输入源、`swipes[0]` 都等于新输入 | 前三者等于新输入；`swipes` 仍为 `['旧输入']`，不被重生成写入 | P2-A：`docs/design/conversation-algebra-phase2-de-mirror.md`；`tavern-plugin/lib/domain/last-round-replacement.js` |
| tests/tavern-swipe-regeneration.test.mjs | 没有 MVU 的重新生成也只保留唯一正文 | `swipes` 为 `['新正文']`，`swipeId` 为 0 | 正文与 turn 正确；无镜像时不凭空创建 `swipes` / `swipeId` | 同上（P2-A） |
| tests/writing-skill-cache-native.test.mjs | writing skill switches append effective policy… | 原生编排下策略通知形态 `writing-skill-state`，文案「停止遵循…已加载」；经 `appendWritingSkillState` 过滤；重新启用时断言“不重复通知” | 原生编排下形态为 `writing-skill-reminder`，文案「本局停用…不要装载或遵循」；重新启用后不再列为停用 | conversation-algebra 的 `writing-skill-reminder`（`tavern-plugin/lib/domain/conversation-algebra/guards.js`）；旧形态仍由 `skill-visibility.js` 生成，且 `conversation-algebra-retirement.js` 把它转换为 reminder。`appendWritingSkillState` 本身仍被 `tests/skill-visibility.test.mjs` 覆盖，未删除 |
| tests/extract-flow.test.mjs | 创建对话失败时服务端记录请求边界… | 切片 `async function dispatch` → `const webServer` | 切片 `case 'startChat': {` → `case 'getImageAgentUndo'`，断言内容不变 | `tavern-plugin/lib/index.js` 中 dispatch 之后的 startChat 分支 |
| tests/issue87-rollback-view.test.mjs | cached rollback controls follow the stored Session surface… | 切片终点 `const readBackgroundSuppression`（已不存在） | 切片终点 `// Rollback needs the live Session`，切片仍为完整的 `sessionDebugEvidence` | `tavern-plugin/lib/index.js` 重构后的源码位置 |
| tests/conversation-initialization.test.mjs | creation / mode selection / opening binds… / missing cards… | 开场白为纯文本 | 夹具显式关闭 `defaultStatusPanel`（默认已开启）；新增用例「默认状态栏面板开启时…追加托管 `<initvar>`，关闭后保持原文」 | 默认状态栏面板的产品行为（`lib/domain` 中的 defaultStatusPanel） |

## 三、夹具改写

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| tests/fixtures/conversation-initialization.mjs | `settings.defaultStatusPanel: false` | 默认开启后开场白会追加 `<initvar>`，旧断言需要显式关闭 |
| tests/fixtures/plugin-host.mjs | 注入 `sessionQuery.observeSession` 桩 | 产品通过 `services.sessionQuery` 读取 Session；缺失时 rpc 抛 TypeError |
| tests/body-editor-native.test.mjs | 注入 `assertAlgebraReady() {}` | `createBodyEditor` 保存前无条件调用它 |
| tests/writing-skill-cache-native.test.mjs | 包列表加入 `dsh-working-directory`；提供 `workingDirectory` 服务；前台帧补 `chatId/branchId/operationId/turn`；去掉 `filterMessages` | DSH 0.2.1 的 skill 工具依赖 workingDirectory；前台编排的帧结构已变 |
| tests/server-template-runtime.test.mjs | 看门狗用例 `timeoutMs` 1500 → 5000 | 时序预算过紧，预热 worker 在整套件负载下即超时；详见 `tests/KNOWN-FAILURES.md` 偶发一节 |

## 四、产品代码修复（测试未改断言）

- `tests/frame-variable-storage.test.mjs` 的 script 作用域用例原先失败，原因是 iframe 内联 helper shim 不认识
  `{type:'script'}`。产品侧已修复（`tavern-plugin/src/client/runtime/frame-document.js`，提交 `4cf806a4`），
  断言未改。
