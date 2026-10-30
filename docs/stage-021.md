# DSH 0.2.1 验收实例里的 Pocket（dsh-pocket 2.12.0）

脚本：`bin/stage-021.sh`。验收实例端口 3092；Pocket 是可选项，默认关闭。

## Pocket 如何工作（读 2.12.0 源码得出，静态结论）

- **代理目标没有自动发现**。`lib/index.js` 里 `dshPort = ctx.webServer.port`，即宿主（加载它的那个 dsh 进程）自己的 web 端口；上游固定为 `127.0.0.1:<dshPort>`。Pocket 只会代理加载它的实例，不会去找别的 DSH。（旧 0.1.5 stage 里“要人工确认转发目标”的担心来自旧版本。）
- **监听端口**：优先级 `$DSH_HOME/dsh-pocket/settings.json` 的 `proxyPort` > cordis 补丁配置 `config.port` > 3081。没有环境变量入口。监听 `0.0.0.0`。
- **端口被占时会自动顺延**（`startProxy` 试 port..port+9）。所以必须先把 `proxyPort` 写进 settings.json，否则默认 3081 被生产占用后会顺延到 3082（也被占）、3083……
- **PIN**：局域网和公网各一个 8 位 PIN，默认开启，存在 `$DSH_HOME/dsh-pocket/`（`token-lan`、`token`，settings.json 里可有自定义 PIN）。手机输一次后 cookie 绑定进程级随机密钥，实例重启后需重新输入。同一 IP 连错 5 次锁 60 秒。
- **数据位置**：全在 `$DSH_HOME/dsh-pocket/` 下（settings.json、token、token-lan、tunnel-auto.json 等），验收实例即 `/home/claw/dsh-stage-021/home/dsh-pocket/`，与生产互不相干。
- **对 0.2.1 的要求**：peer `@deepseek-ai/cordis ^4.0.1`（运行时是 4.0.5，满足）；`dsh.client.inject` 列出 `client-connection`、`client-ui-slots`、`client-ui-layout`、`client-locale`、`session-log-export`。运行时 `@deepseek-ai/` 下前四个中 connection、ui-layout、locale、session-log-export 都存在；`dsh-client-ui-slots` 没有同名目录，但 tavern-plugin、better-sidebar、web-mobile 同样声明了它，应是 0.2.1 里由别的包提供的服务名，**是否真能解析要在登录后的客户端里确认**（见下）。
- 依赖 `qrcode` 用 `require` 按 Pocket 自己的目录解析，所以脚本把 dsh-pocket **拷贝**进 profile（和侧栏一样），不用软链。

## 补丁

`patches/dsh-pocket@2.12.0.patch` 只改 `client/client.js`（设置页加 `dsh-pocket.service-control` 槽位）。`root-nm/dsh-pocket` 里的那份已经打过补丁（`patch -R --dry-run` 通过，且补丁可逆可重放）。脚本每次安装都会检查标记 `PocketSettingsWithServiceControl`，没有就在 **profile 里的拷贝**上应用，不动 `root-nm` 和 fork 的 node_modules。

## 脚本用法

```
# 新家目录（setup 要求家目录不存在）
STAGE021_POCKET=1 bin/stage-021.sh setup
# 已有家目录：只改 profile/package.json 和 profile 里的 dsh-pocket 拷贝，写入 proxyPort；不动聊天等数据
bin/stage-021.sh enable-pocket
# 下次 start 才会加载（需重启 3092，见下）
bin/stage-021.sh stop && bin/stage-021.sh start
```

保护措施：
- Pocket 端口默认 3093（`STAGE021_POCKET_PORT`），拒绝 3080/3081/3082/3091/3092 和实例端口。
- `start` 时只要 profile 里启用了 Pocket 就按启用处理：3093 已被占用就拒绝启动（因为 Pocket 会顺延端口），settings.json 里的 `proxyPort` 不是该端口也拒绝。
- `enable-pocket` 合并写入 settings.json（保留已有字段，权限 600），脚本不打印其内容。

## 手机访问

启动后手机连同一 WiFi，访问 `http://<电脑局域网IP>:3093`，输入 **局域网 PIN**。PIN 由使用者自己取，不要贴到聊天里：

```
cat /home/claw/dsh-stage-021/home/dsh-pocket/token-lan
```

## 验证记录（用独立的临时实例做，端口 3094/3095，已删除；3092 没动）

运行时事实：
- 0.2.1 运行时加载 Pocket：进程只多监听 `0.0.0.0:3095`（该临时实例设定的 Pocket 端口），没有 3081/3082/3083；`ss -tnp` 在访问期间没有出现任何指向生产端口的连接。
- 日志里没有 Pocket 或补丁的错误/警告（该实例日志中的唯一警告是 dsh-dream-skin 与 0.2.1 不兼容被跳过，与 Pocket 无关，3092 上同样存在）。
- playwright 无头访问 `:3095/`：HTTP 200，标题“DSH Pocket · 访问验证”，渲染出 PIN 输入框，无 console 错误、无失败请求。

没有验证（需要 PIN，已按要求不碰）：
- 登录后转发到上游、DSH 页面经 Pocket 渲染、`client.js`（含补丁后的设置页）在 0.2.1 里是否加载无错、`dsh-client-ui-slots` 的解析。
- 上游只指向实例自己端口，目前依据是源码（`ctx.webServer.port`），没有运行时的 ESTAB 抓包；要抓包，登录后访问一次并执行 `ss -tnp | grep <实例pid>`。
- 曾想在临时实例里关闭局域网 PIN 来做无 PIN 全链路验证，被权限策略拦下，没有做。

## 已知风险

- Pocket 监听 `0.0.0.0`，PIN 是唯一门槛；DSH 能执行代码，别把 PIN 外发。
- 加载 Pocket 需要重启 3092（插件在进程启动时加载）。
