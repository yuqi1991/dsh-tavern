# Stage 实例（直接从 fork 运行，与生产隔离）

用 `bin/stage.sh` 在不碰生产的前提下测试 fork 的最新代码。

| | 生产 | stage |
| --- | --- | --- |
| 家目录 | `/home/claw/workspace/dsh-tarvern` | `/home/claw/dsh-stage`（`STAGE_HOME` 可改） |
| 代码 | `apps/dsh-tavern`（复制部署） | fork 源码目录本身（符号链接） |
| 数据 | `profile-data/tavern` | `dsh-stage/profile-data/tavern`（独立） |
| 端口 | 3081（另有 3082 为 Pocket 代理） | 3091，仅监听 127.0.0.1 |
| 运行时与依赖包 | 自己的 | 只读共享生产的 `runtime/` 与已装依赖（含已打补丁的侧栏） |

## 常用命令
- `bin/stage.sh start --mock`：重建客户端并启动；`--mock` 用 e2e 的固定回复模型，不需要模型密钥。
- `bin/stage.sh stop | status | logs`。
- `bin/stage.sh seed`：把生产的人物卡/资源/设置复制进 stage（只读生产）；`seed --full` 连会话一起复制（stage 须已停止）。
- `bin/stage.sh reset`：清空 stage 数据。
- 改完 fork 代码后只需 `stop` 再 `start`，不需要备份或复制。

## 刻意的隔离
- stage 不含 `dsh-pocket`：它是对外隧道/代理插件，默认盯着生产端口 3081，在 stage 里会误连生产。
- 脚本拒绝把 stage 放进生产目录、拒绝使用 3081/3082。
- 模型密钥：脚本只按名字转发调用者环境里已有的 `CPA_API_KEY`/`DEEPSEEK_API_KEY`，不读取、不保存。真实模型模式（不加 `--mock`）尚未配置 provider 设置，见下。

## 未决
- 真实模型模式需要决定如何给 stage 提供 provider 设置与密钥（目前只验证了 mock 模式）。
- stage 与生产共用同一份 DSH 运行时；做内核升级试验时用 `STAGE_RUNTIME` 指向另一份运行时。
