---
name: card-to-mvu
description: "把人物卡转换为独立 MVU 副本，或调整转换后的变量定义与各开场初值。通过唯一字段目录、逐开场填值与持久草稿保留美化，最后统一校验提交；模型负责理解原卡、设计状态语义和精确清理。"
---

# 人物卡转 MVU

目标：前台写剧情，后台更新变量，面板读取状态。模型负责语义和设计；工具负责持久化、绑定编号、成品生成及一致性校验。默认保留无关字段，原卡和共享资源保持不变，保留内容由工具复制。转换只增加必要的动态状态、更新规则与面板，并精确清理冲突入口；正文、固定人设和已有机制沿用原文，不重新创作。

已有 MVU 卡仅调整变量结构或初值时，加载 `edit-card` 并按其变量修改配方执行；直接用目标卡 path 建立编辑草稿，保留现有方案。

## 1. 建立草稿并读取来源

用 `tavern_card_draft.begin`，传原卡 `sourcePath`，目标 `name` 可省略。目标是已有 MVU 副本时仍使用原卡路径与相同副本名，工具自动载入已有字段、各开场、规则、美化和清理。不得把副本再次当成来源转换。

无原美化默认要求 `custom`，需要设计 HTML；有原美化默认 `preserve`，直接绑定原视图。只有用户明确要求简单面板，或设计失败且已说明回退时，才选择 `appearanceRequirement=basic` 并提供 `basicReason`。基础字段面板不等于定制美化完成。进行中确需改变要求时，patch requirements 明确新要求与依据，保留已填写内容。

begin 会选中当前草稿，后续省略 draft，工具按会话记住已读版本并管理重试。需要切换多份草稿时传返回的短编号，例如 `draft="d2"`；read 不带 path 可查看当前草稿和列表。按返回的阅读片段、目录和 `stateInventory` 核对原文；缺失内容用 `tavern_card_draft.source` 传 path 读取，或传 query 搜索。补充 sourceFields 后用 `tavern_card_draft.inspect` 更新来源清单。只读目标卡与其绑定资源；标准转换无需搜索其他卡、磁盘包装或工具源码。

先使用 begin 已返回的原文和目录，只有被截断或尚未提供的非空内容才 source 补读。检查 description、personality、scenario、系统提示、所有开场、mes_example 以及实际存在的世界书、正则和 Helper 脚本；空目录直接跳过，不用 shell、raw 镜像或另一套读取工具重复证明其为空。定位原文中实际存在的状态与候选生成协议，缺失的协议无需清理。稳定事实沿用原卡，变化依据来自原文；未知值明确留空，不编造数值或拿另一个开场的场景补齐。

## 2. 声明字段目录，再逐开场填值

每次 `patch` 默认操作当前草稿。小卡的必要字段一次提交即可，内容较长或需独立修正时再按组拆分；固定事实留在原文，不为了凑齐字段组搬进变量。字段路径与类型由 `section=fields` 声明，返回的 `fieldSchema` 是唯一目录；`initialState` 是可显式继承的初值底稿。先确定各开场共同使用的结构，再填值。

- `section=fields`：JSON Pointer 到值的对象，如 `{ "/时间/时段":"白天", "/地点/名称":"大厅" }`。同批使用互不重叠的路径；省略根斜杠时工具会补齐，例如 `$meta` 规范化为 `/$meta`，只有实际需要可扩展结构时才设置它。默认替换所选路径，递归合并对象用 `operation=merge`；null 是空值，删除与改名用专门操作。
- `section=opening`：按工具给出的 openingId 填写已声明字段，各开场使用相同路径与类型，值可以不同。`inheritInitialState=true` 仅补缺失字段并保留已有值，随后应用本次 values；只有底稿符合该场景时才继承。查看返回的 missingFields，按需补齐，未知值采用明确且一致的表示方式。
- `section=rules`：按组保存变化依据，修改同名组保留其余组。
- `section=mapping`：按 stateInventory 提交 fieldMappings，每个来源字段对应唯一状态路径；未识别的内容用 sourceFields 登记原文范围，再通过 inspect 取得 ID。工具复制来源值。

错层级、错类型会在开场保存时返回具体位置。优先使用 suggestedPaths 中符合语义的目录路径；意外多写的字段应修正，不能通过扩大所有开场和面板来消除报错。确需改名或清除错误字段，使用 fields 的 move/remove，同步处理各开场；操作语义、引用依赖和旧草稿修复见 [草稿工具配方](references/draft-workflow.md)。

`read` 默认返回目录、进度和缺失项，传 path 分页读取局部；连续读完同一部分后再修改草稿。无需每次重读完整底稿与所有开场。草稿是否保存以草稿回执为准，不用成品的 scope=plan 判断。

## 3. 保存美化和清理

`patch section=appearance` 保存完整外观方案，不重传状态、开场和规则。之后修改其他分组会保留这份设计。

有原美化时传 `sourcePath` 与 `bindings`，路径来自 begin 的 appearanceSources；工具从来源固化 HTML/CSS。原视图带脚本、只有一个捕获文本（如隐藏 textarea 里的 `$1` 由脚本解析 `[标签|值|…]`）时，改传 `protocol`：按原卡状态协议（通常在【状态栏】类世界书条目或规则里）原样写出全部标签，值换成 `{{/路径}}`，工具保留原视图全部字节并用变量生成这段文本。不得删除原美化、另做不含美化的来源副本或改用重设计面板来绕过；确实无法适配时报告具体缺口。无原美化时按题材、时代和氛围设计 HTML/CSS，使用 `<mvu-field path="/地点/名称"></mvu-field>` 自动编号，数组用 `display="list"`；外层已有标签时省略组件 label。字段覆盖完整，兼顾窄屏与长文本。仅基础面板使用 `fields`。

多人重复面板、原视图捕获绑定或复杂清理参数需要时读取 [转换参数与边界](references/mvu-recipe.md)。标签使用静态文本，状态通过绑定读取；不接受自定义 JavaScript、事件属性、EJS 或动态属性。

`patch section=cleanup` 提交当前完整清理清单，原文和路径均以来源版本为准。整项删除用 remove；短片段用 replaceText；长区块用唯一 start/end 的 replaceBlock；范围不可重叠。从原位置直接删除已迁移内容及空标题、空容器，保留剧情事实、视角、文风、作者署名、无关美化和交互。清理旧状态生成与显示协议，以及候选行动的生成协议、示例、正则与脚本；剧情分支本身保留，无法确认的脚本明确报告。

明确的独立末尾旧入口可在 `patch section=cleanup` 设置 `cleanupOrphanEntrances=true`；设置会保留，validate 返回实际清理清单。真实初值或渲染逻辑需显式清理。以上修改仅进入草稿，成品尚未改变。

## 4. 检查需求并统一提交

完成源字段覆盖、清理范围与外观核对后，`patch section=review` 设置 `sourceCoverage`、`cleanup`、`appearance` 为 true。这是 Agent 基于原文的需求确认，不要求用户额外审批。字段迁移返回 ruleReviewRequired 时，一并核对规则文本中的旧路径或称呼，再确认 sourceCoverage。后续修改会清除确认，需重新核对受影响内容。

查看 missing；必要时 `validate` 一次汇总结构问题。定位错误按返回的 section、openingId、path、missingPaths 或清理锚点修正对应部分，不从头重写。结构校验不能替代语义核对；保留原卡所需状态，误建字段则通过明确迁移或删除修正。

`commit` 内部保存定义、预检、原子生成成品并校验；只需传 action=commit，无需再次调用 saveDefinition/design/apply。`receipt.committed=true` 且 `receipt.validation.valid=true` 才表示成品提交成功。此时结束转换，不再重复 validate、遍历磁盘包装、统计脚本/标签或另起美化流程；只有明确的新问题才做定点检查。报告副本路径、实际改动与校验结果即可，真实游玩仅在用户明确要求时执行；limitations 是覆盖范围，不是待验收清单。成品中的 `<initvar>` 和 `<mvu-status/>` 是预期生成结构，不应当作残留再删。

## 失败恢复与进度

- 响应丢失时原样重试；程序保留本次使用的版本并去重。版本冲突时 read（不带 path）获取最新进度，核对后再修改；工具不会擅自采用未读的新版本。
- `saved=true` 只说明草稿保存。`phase=committing` / `commitState=unknown` 表示提交结果尚未完整记录，使用原 commit 请求重试，工具恢复提交凭据。已提交草稿继续修改时 begin 新草稿，沿用同一来源和副本名。
- 同一错误码与路径再次出现时，停止盲目重试，按回执中的实际参数位置修正；不通过新建草稿、变换无关字段或 shell 临时文件猜测缓存问题。无法修正时报告具体阻塞，保留草稿。
- 来源或目标冲突时保留草稿并核对变化，不使用普通文件写入绕过保护。整个副本的删除或重命名走资源库操作，不能只改工作版而留下 originals 占名。
- 阶段变化时简短说明正在读哪个分组、已填写几个开场、是否正在提交；进度依据工具返回值，不编造百分比。
- 报错经验通过 `tavern_memory_search` 查重，再用 `tavern_memory_experience` 记录。未验证原因标记 unverified；回执错误不能直接推断参数不支持或文件未保存，不把降级方案写成正确流程。

旧的完整定义接口保留底层兼容，退出默认工具列表；本流程统一使用 tavern_card_draft。仅编辑本 Skill 不触发人物卡转换或模型游玩。
