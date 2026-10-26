export function conversionInputError(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

export function appearanceCoverageError(missingPaths, collectionPath) {
  const outside = collectionPath && missingPaths.find(path => path !== collectionPath && !path.startsWith(collectionPath + '/'))
  return conversionInputError(outside ? 'MVU_APPEARANCE_SCOPE_MISMATCH' : 'MVU_APPEARANCE_MISSING_FIELDS',
    '生成美化遗漏已定义字段: ' + (outside || missingPaths[0]), {
      field: 'bindings', path: outside || missingPaths[0], missingPaths, collectionPath: collectionPath || null,
      hint: outside
        ? 'collectionPath 模式的所有 bindings.path 都相对于一个集合成员，不能同时绑定全局字段。需要全局字段时，省略 collectionPath，改用根路径（如 /时间、/人物/角色名/姓名）；整个集合可绑定为 JSON 文本。需要自动重复人物卡片时，当前接口需专门适配混合作用域。不要删除原字段或改变其归属来通过校验。'
        : '保留完整变量定义，为 missingPaths 补齐 mvu-field 命名组件，或 bindings 和 HTML 文本中的 $1/$2 占位；简单面板可用 fields: [] 自动补齐全部字段。集合模式使用成员相对路径，根模式使用完整路径；不要删除字段来通过校验。'
    })
}

export const mvuStructureGuide = Object.freeze({
  responsibility: '模型只定义状态语义、来源映射、美化和清理；工具负责成品 MVU 结构。标准转换只读目标卡及 Skill 配方，无需扫描其他卡、磁盘 raw/data 包装或工具源码。',
  definition: '使用 tavern_card_draft：begin 传 sourcePath，后续默认当前草稿，仅传动作与改动；多草稿用 d1/d2 等短编号切换。source 读原文，patch 分组填写，validate/commit 自动管理版本与定义；旧完整定义接口仅用于兼容。',
  bindings: {
    root: '省略 collectionPath：所有路径相对于 initialState，可同时绑定 /时间 与 /人物/角色名/姓名；绑定整个集合显示 JSON 文本。',
    collection: '指定 collectionPath=/人物：所有路径相对于每个成员，如 /姓名；自动重复面板，但不能混入 /时间 等集合外字段。'
  },
  preflight: 'action=preflight 只读汇总定义、外观和旧入口问题；可传 definitionRevision 或尚未保存的完整定义。孤立入口按 suggestedCleanup 处理，apply 可显式启用 cleanupOrphanEntrances。',
  html: '无原美化时可用 fields: [] 自动生成完整面板，或 HTML 中的 mvu-field path 组件，数组用 display=list；组件由工具生成编号与绑定；自定义 HTML 中未设置 label 的组件只显示值，显式 label 才附带标签，外层已有字段名时省略 label。旧式动态值用 $1/$2 文本占位。不支持 {{user}}/{{char}}、EJS、自定义脚本或动态属性；原卡已有的单捕获脚本型视图用 sourcePath + protocol 适配。标签用“玩家”等静态文字；状态值通过 bindings 读取。'
})

export const mvuDeliveryGuide = '工具有意保留每个开场的 <initvar>…</initvar>（供官方 MVU 初始化，展示时隐藏）和 <mvu-status/>（由显示正则替换为状态面板），并生成初值条目、后台规则及显示/历史隔离正则。它们不是旧内容残留；不要因搜索命中而删除或调查其他卡。validation.valid=true 且无具体异常时，直接报告转换完成、成品路径和实际差异。limitations 仅说明自动检查范围，不是待办或交付门槛；真实游玩仅在用户明确要求时另行执行，默认不列待验收清单。'
