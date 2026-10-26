# 美化绑定与清理边界

本页的参数片段用于 `tavern_card_draft.patch` 对应分组。读取来源使用 source，更新来源清单使用 inspect，验证与提交使用 validate/commit；这些动作默认操作当前草稿，不传凭据或版本；多草稿时可加 draft 短编号选择。

## 保留原美化

从 begin/inspect 的 appearanceSources 选择路径，外观内容由工具直接从原卡固化。

```json
{"action":"patch","section":"appearance","values":{"sourcePath":"/extensions/regex_scripts/0/replaceString","bindings":[{"capture":1,"path":"/玩家/位置"}]}}
```

在 cleanup 分组中明确清理对应旧入口；其他美化保持原样。无法固化时报告具体缺口，不能用基础面板掩盖设计缺失。

脚本型原视图（整页 HTML 带 `<script>`/onclick，只有一个捕获，脚本读取该捕获文本再填充面板）用协议适配：

```json
{"action":"patch","section":"appearance","values":{"sourcePath":"/extensions/regex_scripts/4/replaceString","protocol":{"capture":1,"template":"[BasicInfo|{{/基本信息/日期}}|{{/基本信息/时间}}]\n[ToDo|{{/待办}}]"}}}
```

- template 照抄原协议的标签顺序、分隔符和全部段落，只把值换成 `{{/路径}}`；原脚本按相邻标签定位，漏写或乱序会让后续栏目为空。
- 数组按顺序以 `|` 连接；对象按键顺序把值以 `|` 连接（如粉丝留言数组的每项 `{emoji,网名,留言,回复}`），因此结构化字段的键顺序要与协议一致。
- 每个已定义字段都要出现在 template 中。原视图的 HTML、CSS、脚本和交互原样保留，变量变化时整块重新渲染。
- 原状态正则和协议输出要求（世界书状态栏条目、提示模型输出 `<gu_status>` 之类的规则）照常列入 cleanup。

没有捕获（`$1`）的美化（如开场主页、横幅）不显示状态，不算 appearanceSources，原样保留，不需清理。

多人物美化示例：`appearance: {sourcePath: "/extensions/regex_scripts/0/replaceString", collectionPath: "/人物", bindings: [{capture: 1, path: "/姓名"}, {capture: 2, path: "/位置"}]}`。每个人物的来源字段分别映射到 `/人物/人物名/姓名` 和 `/人物/人物名/位置`，外观绑定相对于集合成员。

`cleanup` 路径相对于 source 底稿，不带 `/data` 或 `/raw`。删除数组元素时用 inspect 时的原始下标，工具处理下标移动。修改后的文本保持剧情语义；不留下迁移说明。同字段多处清理分别提交小操作；所有操作按修改前底稿定位，工具拒绝重叠范围。

清理长内容的示例（仅用于原卡确有对应内容时）：

```json
[
  {"op":"remove","path":"/character_book/entries/3"},
  {"op":"remove","path":"/extensions/regex_scripts/1"},
  {"op":"replaceBlock","path":"/first_mes","start":"<旧状态栏>","end":"</旧状态栏>","value":""},
  {"op":"replaceText","path":"/description","expected":"每轮输出三个候选行动。","value":""}
]
```

`remove` / `replace` 由来源版本号保护，省略 `expected`。`replaceBlock` 包含首尾标记，两者必须各自唯一、前后有序；边界有歧义时选择更长但仍简短的标记。无需转录区块内部代码或保留的剧情。

展示路径使用 JSON Pointer，键中的 `~` 和 `/` 分别写作 `~0`、`~1`。基础面板展示全部非内部字段；选择集合时，新成员会自动展示。原美化通过 appearance 固化，保留原生 details 交互；单捕获的脚本型视图用 protocol 适配，多个捕获上的脚本按钮、动态属性和嵌入文档需专门适配。

## 绑定模式与常见错误

根绑定（省略 collectionPath）：

```json
{"html":"<section><p>时间：$1</p><p>姓名：$2</p></section>","bindings":[{"capture":1,"path":"/时间"},{"capture":2,"path":"/人物/甲/姓名"}]}
```

集合绑定（只展示集合成员）：

```json
{"collectionPath":"/人物","html":"<article><h3>$1</h3><p>位置：$2</p></article>","bindings":[{"capture":1,"path":"/姓名"},{"capture":2,"path":"/位置"}]}
```

这两段直接用作 appearance 分组的 values，初值在 fields/opening 分组中单独填写。集合模式不会回退到根对象取值：`/时间` 指的是每个人物的时间，不是全局时间。目前一套模板不能同时拥有全局区和重复人物区。保留完整字段，选择根模式或报告需要专门适配；不通过删字段绕过覆盖检查。

- `MVU_APPEARANCE_SCOPE_MISMATCH`：path 位于 collectionPath 外；按 hint 调整绑定模式，保留原字段归属。
- `MVU_APPEARANCE_MISSING_FIELDS`：核对 missingPaths 是否是应保留的目录字段；正确字段补绑定，误建路径用 fields move/remove 修正。
- `MVU_APPEARANCE_UNSUPPORTED_SYNTAX`：field、token、offset 指出语法位置。例如 `<small>对{{user}}</small>` 改为 `<small>对玩家</small>`；动态状态另设 $1/$2 字段绑定。不用其他卡或源码推测格式。

## 工具生成的成品结构

工具安装世界书 `[initvar]` 初值条目、`[mvu_update]` 后台规则、各开场完整 `<initvar>` 数据，以及 `<mvu-status/>` 的显示和历史隔离正则。原始开场末尾存在这两个标记是正常结果；初始化数据在展示中隐藏，入口由正则变成面板。以 commit 返回的 receipt.validation 为准，不把对成品搜索命中标记当作清理失败。

## 需要额外判断的卡

- **已有 MVU**：先识别原有初值、Schema、脚本和面板。转换工具遇到残留初值、后台规则或旧状态声明会停止，要求明确合并/清理；它不是通用的已有 MVU 卡升级器。已有复杂 MVU 正常工作时可保留现状，不必强行重装。
- **多开场**：工具按 openingStates 和来源映射生成每个开场完整的 initvar；检查人物归属和已有值，不能用第一个开场替代其余开场。
- **外部世界书**：工具复制实际绑定内容到副本，处理合并编号并保留触发条件；原卡未生效的内置书作为保留数据，不因转换而启用。inspect 返回的世界书内容是清理操作的依据。
- **增量修订**：begin 同一来源和副本名会载入已保存方案；patch 只改指定分组。cleanup 是完整清单，替换时保留仍需要的旧操作；底稿始终是原卡，不是副本。
- **来源或副本变化**：旧草稿不能覆盖新版本；先核对变化。begin 拒绝载入方案外修改时，使用人物卡读取工具检查实际副本并报告冲突，不能绕过保护直接覆盖。
- **定位失败**：error.anchor 指明 expected/start/end，matches 是出现次数，candidates 是最多 5 个短上下文。0 次先读原卡字段，检查是否误用了副本附加换行；2 次以上选择更长的唯一标记。不要模糊匹配、盲目改编码或直接写资源文件。
- **验收清单**：changes 是实际执行的清理操作，removedEntries/preservedEntries 分别列实际删除与原样保留的世界书条目，带条目名与 enabled；禁用不等于可删除。planIntegrity 检查是否有方案外修改，legacyResidue 只检查被修改来源渲染正则中可识别的标签；它们不能替代剧情语义判断。
- **真实结算**：初值定义通过不代表官方初始化已成功；模板 DOM 模拟使用测试快照，不运行原卡脚本，也不调用模型。真实游玩仅在用户明确要求时另行执行，结果以实际结算回执、持久变量和 UI 为准，不影响静态转换任务完成。

保持一套清晰的变量约束。可扩展集合需要完整模板；已有 Zod 脚本的约束仍需单独核对。后台操作路径相对于 stat_data，例如 `/玩家/位置`，不是 `/stat_data/玩家/位置`。原卡不存在的数值、公式和状态机制不新增。

收尾以 commit 返回的 receipt.validation 为准，保存成功且自动校验通过后，报告副本路径、实际差异和校验结果即可交付。limitations 是检查范围说明，不是待办；不默认列出真实验收清单，不重复 validate。source/target 是生效字段，磁盘包装里的旧镜像不作为转换失败依据。


## 无原美化：设计并保存

使用 patch section=appearance 保存 HTML 方案。初值和规则已保存在草稿中，此处只提交外观。

```json
{"action":"patch","section":"appearance","values":{"html":"<style>.status{padding:16px;background:#142338;color:#f4f7fb;border-radius:12px;overflow-wrap:anywhere}</style><section class=\"status\"><h3>航行日志</h3><p>位置：<mvu-field path=\"/玩家/位置\"></mvu-field></p><p>体力：<mvu-field path=\"/玩家/体力\"></mvu-field></p></section>"}}
```

字段必须来自草稿目录，命名组件自动生成绑定编号。多人重复面板使用 collectionPath，bindings.path 为成员相对路径。整集合可绑定为一个值，以 JSON 文本展示；正式设计优先逐字段排版。后续修改样式仍 patch appearance，状态和规则保留，最后统一 commit。
