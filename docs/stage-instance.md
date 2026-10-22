# Stage 实例（直接从 fork 运行，与生产隔离）

用 `bin/stage.sh` 在不碰生产的前提下测试 fork 的最新代码。

| | 生产 | stage |
| --- | --- | --- |
| 家目录 | `/home/claw/workspace/dsh-tarvern` | `/home/claw/dsh-stage`（`STAGE_HOME` 可改），由生产克隆而来 |
| 代码 | `apps/dsh-tavern`（复制部署） | fork 源码目录本身（符号链接） |
| 数据 | `profile-data/tavern` | `dsh-stage/profile-data/tavern`（独立，不含聊天） |
| 端口 | 3081（另有 3082 为 Pocket 代理） | 3091，仅监听 127.0.0.1 |
| 运行时与依赖包 | 自己的 | 克隆时复制一份，之后独立 |

## 常用命令
- `bin/stage.sh clone`：把生产的配置与资源克隆到 stage（只读生产）。`--force` 把已有 stage 改名留底后重做。
- `bin/stage.sh start [--mock]`：重建客户端并启动；`--mock` 改用 e2e 的固定回复模型，不调用真实模型。
- `bin/stage.sh stop | status | logs`。
- 改完 fork 代码后只需 `stop` 再 `start`，不需要备份或复制。

## 克隆内容
- 带：profile（含 settings.yaml）、运行时与依赖包、人物卡/资源/预设/世界书/技能/工具、各项设置。
- 不带：聊天与会话、模型请求日志（生产里最大的一项，1.4G）、诊断、召回记录、草稿与索引、备份、日志、dsh-pocket。
- 克隆里指回生产路径的符号链接和配置全部改写为 stage 路径（783 个链接、3 个配置文件）。

## 刻意的隔离
- stage 不含 `dsh-pocket`：它是对外隧道/代理插件，默认盯着生产端口 3081，在 stage 里会误连生产。
- 脚本拒绝把 stage 放进生产目录、拒绝使用 3081/3082。
- 模型密钥：脚本只按名字转发调用者环境里已有的 `CPA_API_KEY`/`DEEPSEEK_API_KEY`，不读取、不保存。克隆带来的 settings.yaml 只含 provider 配置；密钥能否被 stage 取到，要在真实对话时确认。

## 注意
- stage 与生产是两份独立数据：在 stage 里玩出来的聊天不会出现在生产，反之亦然。
- 要试旧会话兼容性，需另行复制所需会话（本脚本默认不带）。
- 做内核升级试验时，用 `STAGE_RUNTIME` 指向另一份运行时。
