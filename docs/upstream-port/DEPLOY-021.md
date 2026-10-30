# 生产部署清单：DSH 0.1.5-rc.2 → 0.2.1-rc.2（含上游移植批 1–5）

状态：**草案，未执行。** 没有使用者明确同意之前不动生产（3081 / 3082）。
分支：`upgrade/dsh-0.2.1`（只有本地提交，未推送）。验收实例：`bin/stage-021.sh`（端口 3092）。

## 0. 先说清楚的三个风险

1. **内核升级是单向的。** 0.2.1 写出的会话日志是 v4，0.1.5 读不了。回退只能靠备份整体恢复，部署后新产生的游戏会丢。
2. **旧游戏能不能打开，还没有验证过。** 验收实例（3092）是空数据，没有任何旧聊天。生产里的 1.7G 数据包含 v3 格式的原生会话；我们没有移植上游的存档升级器（f8222828），也没有拿生产数据的拷贝在 0.2.1 上打开过。用户此前表示“旧会话可以删，只要新会话正常”，但在删之前应先看一眼实际表现（见 §2 步骤 A）。
3. **手机访问路径（3082 的 Pocket 代理）没有在 0.2.1 上验证过。** 生产现在用 `dsh-pocket` 2.10.6，升级目标是 2.12.0 加补丁（`patches/dsh-pocket@2.12.0.patch`），验收实例没有装 Pocket。手机布局的真机效果也没验证。

## 1. 需要使用者决定的事

| # | 决定 | 建议 |
|---|---|---|
| D1 | 旧游戏怎么处理 | **已定（2026-10-30）：放弃**，旧游戏都是测试用的，不做试开 |
| D2 | 部署方式：A 原地升级生产目录；B 建新家目录并行，验证后切换端口 | B（见 §3），原地只在 B 不可行时用 |
| D3 | 场景生图的全局开关现在默认**关** | **已定：默认关**，部署后在 设置→场景生图 手动打开一次 |
| D4 | “删除游戏”的行为变了：现在真删原生会话和日志（DSH 仍加载的会话延后到下次启动删除） | 知悉即可 |
| D5 | dream-skin 9.23.0 与 0.2.1-rc.2 不兼容，部署后会被跳过（皮肤不生效） | **已定：先不处理**，之后再改（需另行移植上游 `bin/vendor-dream-skin.mjs`） |
| D6 | 后台共享工具表里的 `tavern_recall_history` 要不要撤掉（用户曾说“后台不加”，但原本就有） | 保持现状 |
| D7 | 查原文冷却是否保留（写聊天记录里的 `historyRecallCooldowns`） | 保持现状 |

## 2. 部署前的验证（不碰生产）

A. ~~试开旧游戏~~：已取消（D1：旧游戏放弃）。
B. **Pocket / 手机访问**：验收实例已装 `dsh-pocket@2.12.0`（带补丁，专用端口 3093，只代理 3092，见 `docs/stage-021.md`）。待使用者用手机连同一 WiFi 访问 `http://<电脑局域网IP>:3093`，PIN 自己从 `/home/claw/dsh-stage-021/home/dsh-pocket/token-lan` 取。验证：登录后 DSH 页面正常、设置页有“手机访问”、页脚提交号是 fork 的而不是生产的、对话与输入框可用。手机布局本身使用者已测过。已做的运行时事实：监听端口只多一个 0.0.0.0:3093，登录页可渲染无报错；**登录后的转发尚未验证**。
   - **Pocket 与 dsh-web-mobile 不能同时挂手机适配（已在隔离 e2e 复现，无头 Chromium，非真机）**：dsh-pocket 2.12.0 的客户端内置了一份 dsh-web-mobile 的移植（`mobileApply`），与 profile 里的 dsh-web-mobile 3.x 注册相同的槽位 id（`mobile-nav-toggle`、`mobile-nav-session-log`），0.2.1 的列表槽位拒绝重复 id 并抛 `already has an entry with id`，表现为页面卡在 Loading plugins、右上文件入口缺失。与 bundles 顺序、软链/realpath、服务控制补丁无关，只要两者同装就出现，不需要经过 Pocket 代理。处理：安装 Pocket 时再打 `patches/dsh-pocket@2.12.0-no-mobile.patch`（`bin/stage-021.sh` 的 `install_pocket` 已自动应用；生产部署 Pocket 2.12.0 时同样必须打，或不装 dsh-web-mobile 改用 Pocket 内置的那份，二选一）。
C. **用真实模型走一局长对话**：包含重新生成、切换变体、回退、撤销回退、编辑正文、存档导出导入、后台结算、连续压缩 2–3 次（按 `docs/design/compaction-retention.md` §8 清单核对摘要质量）。
D. **设置与预设页**：按各移植报告里的浏览器验证清单过一遍（本局设置四分区、全局设置分组、预设页导入导出、隐藏上下文注入开关）。
E. **原地 MVU**：对一张真实旧卡试“加 MVU”，开新局看状态栏。

## 3. 部署步骤（方式 B：并行新家目录，验证后切换）

1. **备份**：对生产家目录再做一次只读完整拷贝（不含 logs、source-cache），写入 `/home/claw/backups/dsh-pre-deploy-<日期>/`，并记录 runtime、apps、profiles 的 sha256。保存 fork 与 dev 两个仓库的 git bundle。给 fork 打标签 `pre-deploy-<日期>`。
2. **准备 0.2.1 运行时**：沿用 `/home/claw/dsh-stage-021/runtime` 的方式（上游 `config/cli-runtime` 的 package.json + lock，`npm ci --prefix …/lib`），放到新目录，不覆盖旧 `runtime/`。
3. **建新家目录**：参考 `bin/stage-021.sh setup`，差异是：
   - 人物卡、预设、世界书、资源等配置从生产拷入（stage 脚本已排除的 `tavern-settings.json`、`tools.cordis.yml`、`tavern-extension-settings.json` 需要使用者自己决定放入）。
   - **模型配置 `settings.yaml` 由使用者自己放入**，我不读不拷。
   - 聊天与会话按 D1 的结论处理。
   - profile 的 bundles 包含 `dsh-pocket`（2.12.0 + 补丁）、`dsh-web-mobile`（3.1.0 + 补丁）、`dsh-better-sidebar`（0.28.0 + 补丁）。
4. **部署包清单**（部署用复制白名单，仓库外，需对照）：
   - 新增目录 `tavern-plugin/lib/tools/`、`tavern-plugin/lib/domain/` 下的新文件（不要靠“改了哪些复制哪些”，改为整树复制后逐字节核对）。
   - `tavern-plugin/lib/client.js`、`lib/client-assets/tavern.css`、`prompts/`、`presets/`（含新 Skill `references/mvu-format.md`）、`patches/`。
   - `@jsquash/{jpeg,png,webp}` 三个包：需在部署目录安装（存档图片压缩用；缺了自动回退原图，不影响功能）。**不要在 fork 里 `pnpm add/install`。**
   - 核对 `pnpm-lock.yaml` / `pnpm-workspace.yaml` 与补丁文件。
5. **部署后逐字节核对**安装树与源树（历史教训：曾出现源已修、装机残留旧代码）。
6. **起服务**：用完整 env 以 `setsid nohup … < /dev/null & disown` 脱离启动，端口先用非生产端口；确认日志里没有补丁自检失败（宿主补丁与上下文占用投影都有启动自检，失败会明确报错、不会半装）。
7. **冒烟**：只读 RPC 冒烟，再按 §2 的 C 过一局。
8. **切换**：停 3081/3082 旧服务（用 `ss` 确认全部停掉再起，避免 EADDRINUSE），新实例改用 3081（Pocket 3082）。
9. **观察**：第一周留意日志里“楼层投影与旧表不一致”、压缩失败、结算停在“推迟”等记录。

## 4. 回退方案

- 部署前备份的整体恢复（命令写进备份目录的 README）。
- 旧 `runtime/`、`apps/`、`profiles/` 保持不动（方式 B），切回只需把旧服务按旧脚本重启。
- 代码回退：`git reset --hard pre-deploy-<日期>`（fork）。
- 部署后在新内核上产生的游戏无法在 0.1.5 上打开；要保留的先用“导出存档”（`.dshsave`）导出。

## 5. 已知问题（部署后仍存在）

- 偶发：开局后变量结算长时间停在“结算等待中”（约六分之一的 e2e 概率，0.1.5 时代就有，原因未查清；自动重试间隔 10 秒）。
- 退休的后台 Agent 仍留在 0.2 的 Tasks 目录里（上游同样）。
- 旧测试过期，基线 42 个单测失败；e2e `--render-depth`、`--sidebar`、`--display-regression`、surface-recovery、mvu-incremental、legacy 失败。
- 已压缩楼层不能回退、重新生成、切换变体（保留的最近 N 轮不受影响）。
- 保留部分超过窗口 25% 时，退回只保留最后一条回复。
- 定位失败改造里待产品决定的 P1–P6（见 `docs/design/conversation-algebra-locate-audit.md`）。
- 内核 `worker.cjs` 里一份旧会话迁移校验的折叠副本未适配 select，只影响旧格式迁移。
- 文档仍有 Windows/Android/Desktop 旧版本安装说明，以及“用户画像”“外部预设”旧名称。
- 未移植：舞台、配音、头像、卡内插件、人物卡 CHARX/封面/PNG/宫格、服务端运行卡脚本、MVU 变量编辑器、iframe 只内联近 48 楼、插件接口层、历史正文以工具参数回放。
