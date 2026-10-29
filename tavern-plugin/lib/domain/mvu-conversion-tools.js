// Revision and request bookkeeping stays inside the draft service. Compatibility
// callers still receive the full domain report; the model sees a session-local short name.
function compactDraftReport(value) {
  const {draftId,draftRevision,sourceRevision,requestId,...report}=value
  if(report.report)report.report=compactDraftReport(report.report)
  if(report.error)report.error=compactDraftReport(report.error)
  if(report.source)report.source=compactDraftReport(report.source)
  if(report.pendingCommit)report.pendingCommit={action:'commit',instruction:'原样重试上一次 commit 调用'}
  return report
}
// Keep the conversion contract separate from generic card editing. JSON values
// carry story-specific state; the tool owns all executable/template scaffolding.
export function registerMvuConversionTools({ tools, defineTool, conversion, chatForSession }) {
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'json', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.report, null, 2) }]
  }
  const failure = error => {
    if (!error.code || !error.details) throw error
    return {report:{ok:false,error:{code:error.code,message:error.message,...error.details}}}
  }
  const requireWorkbench = async exec => {
    const chat = await chatForSession(exec?.agent?.session?.id || '')
    if (chat?.mode !== 'card') throw Error('MVU 转换工具只能在卡片工作台使用')
  }
  tools.register(defineTool({
    name:'tavern_card_draft',
    description:'MVU 转换与变量修改统一入口。修改已有托管 MVU 卡：begin 传 path，自动载入原定义；转换普通卡为独立副本：begin 传 sourcePath；给刚新建的卡直接加 MVU：begin 传 sourcePath 与 inPlace=true，写回同一张卡；后续默认操作本会话当前草稿，不传 draft；多草稿时用 d1/d2 等短编号选择。patch 分组修改，source 读或搜索来源，inspect 更新来源清单，read 看进度，validate 检查，commit 提交。仅卡片工作台可用。响应丢失时原样重试，程序自动去重；冲突时 read 后核对再修改。',
    parameters:{
      action:{type:'string',required:true,enum:['begin','read','source','inspect','patch','validate','commit']},
      sourcePath:{type:'string',description:'begin 转换普通卡的原卡路径；修改已有 MVU 卡直接传 path'},
      name:{type:'string',description:'begin 的目标副本名；已有副本自动载入其定义、各开场和美化'},
      inPlace:{type:'boolean',description:'begin：true 表示把 MVU 直接加到 sourcePath 这张卡上，不另建副本，之后可直接改这张卡的剧情字段。用于新建卡或没有旧状态栏、只用自身内置世界书的卡；不传 name，不做 cleanup'},
      draft:{type:'string',description:'可省略，默认当前草稿；多草稿时传本会话返回的 d1/d2 等短编号。read 不带 path 刷新已读版本与草稿列表'},
      appearanceRequirement:{type:'string',enum:['custom','preserve','basic'],description:'begin：无原美化默认 custom（需 HTML 设计）；有原美化默认 preserve。basic 仅用户要求简单面板或已说明的设计回退'},
      basicReason:{type:'string',description:'选择 basic 时必填的依据'},
      section:{type:'string',enum:['fields','opening','rules','appearance','mapping','cleanup','requirements','review']},
      values:{type:'json',description:'fields/opening：JSON Pointer 到值的对象，如 {"/时间":{"时段":"白天"}}；rules：分组名到规则文本，空文本删除该组；appearance：可传 {replacements:[{expected,value}]} 局部修改草稿 HTML；新增字段用 mvu-field 组件，工具自动分配捕获与绑定；也可提交完整 HTML/fields 或 sourcePath/bindings 方案；脚本型原视图（单个 $1 文本由原脚本解析）提交 {sourcePath,protocol:{capture:1,template:"原协议文本，值写 {{/路径}}"}}；mapping：sourceFields/fieldMappings 数组；cleanup：完整清理数组；requirements：appearanceRequirement/basicReason，仅明确改变美化要求时使用；review：sourceCoverage/cleanup/appearance 布尔确认。未提交的分组保留'},
      openingId:{type:'string',description:'opening-0 对应 first_mes，后续按 alternate_greetings 顺序；以工具返回 ID 为准'},
      inheritInitialState:{type:'boolean',description:'opening 显式从底稿仅补缺失字段，保留已有开场值，再应用 values；新增字段也可用此操作同步'},
      operation:{type:'string',enum:['set','merge','replace','move','remove'],description:'fields/opening 默认 set：替换所选路径的值；merge：递归合并对象，null 是值；replace 同 set。fields 专用 move/remove：传 path（move 另传 toPath），同步各开场与结构化绑定；删除仍有引用的字段会拦截'},
      toPath:{type:'string',description:'fields move 的目标 JSON Pointer；有值冲突时拒绝覆盖'},
      cleanupOrphanEntrances:{type:'boolean',description:'patch cleanup 时可启用安全孤立入口清理'},
      path:{type:'string',description:'begin 的现有 MVU 卡路径（与 sourcePath/name 二选一）；read 的草稿 JSON Pointer，如 /fieldSchema、/definition/initialState；或 patch fields move/remove 的状态字段路径'},
      query:{type:'string',description:'source 可选：按文字搜索来源；省略则读取 path'},
      offset:{type:'number'},limit:{type:'number'}
    },
    output,isConcurrencySafe:()=>false,
    async execute(args,exec) { await requireWorkbench(exec); try {return {report:compactDraftReport(await conversion.draft(args,{sessionId:exec?.agent?.session?.id,callId:exec?.callId}))}} catch(error) {return compactDraftReport(failure(error))} }
  }))
  tools.register(defineTool({
    name:'tavern_read_mvu_appearance',
    description:'读取已有 MVU 副本的托管美化 HTML、绑定和编辑版本。修改标签、布局、样式时先用本工具，无需读取整卡、初值或生成脚本。返回 editable=false 时按说明检查目标卡；长 HTML 按 nextOffset 续读并携带 revision。',
    parameters:{path:{type:'string',required:true},revision:{type:'string'},offset:{type:'number'},limit:{type:'number'}},
    output,isConcurrencySafe:()=>true,
    async execute(args,exec) { await requireWorkbench(exec); return {report:await conversion.readAppearance(args)} }
  }))
  tools.register(defineTool({
    name:'tavern_update_mvu_appearance',
    description:'仅修改现有绑定的文案和样式，直接保存目标卡；新增变量或已有进行中草稿时，统一使用 tavern_card_draft patch appearance 的 replacements，避免目标版本冲突。局部修改已有 MVU 副本的托管 HTML 美化。传读取时的 revision 和唯一原文替换片段；全部片段对应同一读取版本，不可重叠。自动保留字段、各开场初值和规则，同步持久化定义、生成面板和摘要，原子保存并校验。保留 $N 占位及绑定；不支持改变量定义、来源固化美化或覆盖方案外修改。成功且 validation.valid=true 即完成，无需再转换或真实游玩验收。',
    parameters:{path:{type:'string',required:true},revision:{type:'string',required:true},replacements:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{expected:{type:'string',required:true},value:{type:'string',required:true}}}}},
    output,isConcurrencySafe:()=>false,
    async execute(args,exec) { await requireWorkbench(exec); try { return {report:await conversion.updateAppearance(args)} } catch(error) { return failure(error) } }
  }))
  tools.register(defineTool({
    name: 'tavern_convert_to_mvu',
    description: 'MVU 完整定义兼容接口及来源读取工具。新任务优先 tavern_card_draft 分批保存与提交，inspect/read/search 仍用于来源读取。将人物卡转换为独立 MVU 副本。先 inspect 获取原文、版本和 stateInventory；preflight 只读汇总开场格式、字段覆盖、美化语法与旧入口问题，返回开场模板和建议清理；完整提取后 saveDefinition 持久化字段结构及各开场已有值，再以 definitionRevision 装配，仅缺失长字段用 read.paths 批量补读。apply 已内置预检、原子保存和磁盘验收；仅有定位疑问时额外 preview。已有副本默认合并已保存方案，省略的定义与清理保留。工具从磁盘复制整卡后清理并追加 MVU；参数仅提交改动和变量定义，不回传原卡或保留内容。工具根据保存的字段定义直接生成初值/后台规则、固化原美化、每个开场入口、模型历史隔离与绑定，有原美化时必须指定 appearance，先 freezeAppearance 核验；工具直接复制来源 HTML/CSS，只绑定变量，不接受模型重写外观。无原美化优先用 tavern_design_mvu_appearance，设计失败再用默认模板。标准转换只需目标卡和 Skill 配方，不需要查其他卡或工具源码。同一来源和名称可重复调用；更新现有副本须提供 inspect 返回的 targetRevision。',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'read', 'search', 'freezeAppearance', 'saveDefinition', 'preflight', 'preview', 'apply'] },
      sourcePath: { type: 'string', required: true, description: '原卡 cards/... 路径；始终保留原卡' },
      detail: { type: 'string', enum: ['reading','summary','full'], description: 'inspect 默认 reading 一次返回有预算的原文；summary 仅目录，full 为完整原卡及副本' },
      scope: { type: 'string', enum: ['source','target','plan','definition','preservedWorldbook'], description: 'read/search 默认 source；definition 需 definitionRevision；target/plan 仅在 inspect.target 非 null 时可读，并需 targetRevision；plan 还需 target.hasSavedPlan=true。targetPath 只是拟保存位置，不代表已存在。路径均相对于该对象' },
      path: { type: 'string', description: 'read/search 的 JSON Pointer；空串为根目录，read 对象返回子目录，字符串分页返回 text' },
      paths: { type:'array', items:{type:'string'}, description:'read 可批量读取 1–20 个字段，省去逐项往返；总原文预算 12000 字符' },
      query: { type: 'string', description: 'search 必填：原文片段，非正则，最多 1000 字符' },
      offset: { type: 'number', description: 'read 的字符/目录起点，search 的匹配结果起点；使用返回的 nextOffset 续读' },
      limit: { type: 'number', description: '每页上限：字符串 8000 字符、目录 100 项、搜索 40 项' },
      planMode: { type: 'string', enum: ['merge','replace'], description: 'apply/preview 默认 merge：保留已保存定义和清理，追加去重；replace 显式替换完整方案，需要重新提交全部定义和清理' },
      cleanupResetPaths: { type: 'array', items: { type: 'string' }, description: 'merge 时先移除这些原卡路径的全部旧清理操作，再追加 cleanup；纠正同字段操作时使用' },
      name: { type: 'string', description: '副本名称，默认原卡名加 MVU版本；重复调用保持相同名称' },
      sourceRevision: { type: 'string', description: 'read/search/saveDefinition/preflight/preview/apply 必填，inspect 返回的来源版本' },
      targetRevision: { type: 'string', description: '更新副本时填 inspect 返回的目标版本' },
      definitionRevision: {type:'string',description:'saveDefinition 返回的持久化定义版本。apply/preview 直接读取该定义，不重新提交初值、规则和展示配置。'},
      openingStates: {type:'json',description:'saveDefinition 可选：按开场顺序排列的完整初值对象数组（first_mes 在前）；完整连续数字键对象也会规范化为数组；省略则复制 initialState 为每个开场底稿，再由工具按来源映射写入各自已有值。未知值须明确为空。'},
      sourceFields: {type:'array',description:'saveDefinition 补充自动清单未识别的字段：使用 read/search 的原文字符范围；值由工具直接复制。',items:{type:'object',additionalProperties:false,properties:{
        path:{type:'string',required:true},offset:{type:'number',required:true},length:{type:'number',required:true},label:{type:'string'}
      }}},
      fieldMappings: {type:'array',description:'saveDefinition 为 stateInventory 每项提供唯一目标路径；含所有人物和开场。补充 sourceFields 可先 inspect 同参数取得 ID。',items:{type:'object',additionalProperties:false,properties:{
        sourceId:{type:'string',required:true},path:{type:'string',required:true}
      }}},
      initialState: { type: 'json', description: 'saveDefinition 必填：变量初值对象，不包裹 stat_data；可扩展集合保留 $meta' },
      updateRules: { type: 'string', description: 'saveDefinition 必填：路径、类型及依据剧情事实更新的规则' },
      displayFields: { type: 'array', description: '可选展示字段；首次省略则展示全部非内部字段，增量省略沿用已保存配置', items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true, description: '相对于初值的 JSON Pointer，如 /玩家/位置；可选择整个集合' },
        label: { type: 'string', description: '显示名称' }
      } } },
      appearance: { type: 'object', additionalProperties: false, description: '已有美化传 sourcePath 和 bindings 固化。无原美化时 preflight/saveDefinition 可传 fields 或 html 组件。已有方案省略则保留。', properties: {
        sourcePath: { type:'string', description:'inspect.appearanceSources 返回的 replaceString 路径' },
        collectionPath: {type:'string',description:'多人面板集合路径，如 /人物；所有 bindings.path 相对于成员（如 /姓名），不能混入顶层 /时间。省略时所有路径相对于整个初值。'},
        html:{type:'string',description:'无原美化时使用的 HTML，可含命名 mvu-field 组件。'},
        protocol:{type:'object',additionalProperties:false,description:'脚本型原视图：保留原视图全部字节，用变量按原状态协议生成捕获文本。',properties:{capture:{type:'number',required:true},template:{type:'string',required:true,description:'原协议文本，字段值写 {{/路径}}'}}},
        fields:{type:'array',items:{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},label:{type:'string'},display:{type:'string',enum:['text','list']}}}},
        bindings: { type:'array', items:{type:'object',additionalProperties:false,properties:{
          capture:{type:'number',required:true,description:'原视图 $1/$2 的捕获编号'},
          path:{type:'string',required:true,description:'MVU 初值的 JSON Pointer'},
          display:{type:'string',enum:['text','list'],description:'list 仅用于独立 ul/ol 内单个 li 文本占位；推荐让字段组件自动生成。'}
        }}}
      } },
      cleanupOrphanEntrances:{type:'boolean',description:'preflight/apply/preview 可选：只自动删除预检认定的独立末尾旧入口；有效初值/渲染逻辑不动。'},
      cleanup: { type: 'array', description: '相对于 source 底稿的小改动；版本号校验整个底稿。整项删除只传路径，短改文只传片段，长区块只传首尾标记；同字段支持多处不重叠编辑。无需回传原卡。', items: { type: 'object', additionalProperties: false, properties: {
        op: { type: 'string', required: true, enum: ['replaceText', 'replaceBlock', 'replace', 'remove'] },
        path: { type: 'string', required: true, description: '如 /description 或 /character_book/entries/0；数组下标按 inspect 底稿' },
        reason: { type: 'string', description: '简短说明本项为何属于旧状态/候选项实现；保留到验收删除清单' },
        expected: { type: 'json', description: '仅 replaceText 必填：恰好出现一次的短原文；remove/replace 省略，无需回传完整原值' },
        start: { type: 'string', description: 'replaceBlock 必填：在字段内唯一的起始标记，包含在替换范围中' },
        end: { type: 'string', description: 'replaceBlock 必填：在字段内唯一且位于 start 后的结束标记，同样包含在替换范围中' },
        value: { type: 'json', description: '替换值；replaceText/replaceBlock 必须是字符串，删除片段或区块用空字符串；replace 仅提交新值，remove 省略' }
      } } }
    },
    output, isConcurrencySafe: () => false,
    async execute(args, exec) {
      await requireWorkbench(exec)
      try {
        if (['apply','preview'].includes(args.action) && !args.definitionRevision && ['initialState','openingStates','updateRules','displayFields','appearance'].some(key=>Object.hasOwn(args,key))) throw Error('先 saveDefinition 保存字段结构，再以 definitionRevision 装配；apply 不接收重新转录的定义')
        return { report: await conversion.convert(args) }
      }
      catch (error) {
        return failure(error)
      }
    }
  }))
  tools.register(defineTool({
    name: 'tavern_design_mvu_appearance',
    description: '完整定义兼容接口；已使用草稿时请 patch appearance，无需另调本工具。原卡没有美化时，为完整 MVU 定义设计人物卡风格的 HTML/CSS 面板并持久化。优先传 fields 组件（path、label、display=text/list），工具自动编号并补齐字段；自定义 html 可用 <mvu-field path="/字段" display="list"></mvu-field> 自动编译，勿再传 bindings。旧式 html 使用 $1/$2 文本占位，bindings 映射字段；多人指定 collectionPath 并使用相对成员路径。工具校验全部定义字段的展示覆盖，注入统一更新/新增/回退逻辑，返回 definitionRevision 供转换 apply 直接使用。有原美化时拒绝覆盖；不接受自定义 JavaScript、事件属性或嵌入文档。失败可修改设计重试，或用 saveDefinition 保存默认面板并报告原因。',
    parameters: {
      sourcePath:{type:'string',required:true},sourceRevision:{type:'string',required:true},
      initialState:{type:'json',required:true},openingStates:{type:'json'},updateRules:{type:'string',required:true},
      fields:{type:'array',description:'推荐：字段组件，工具自动编号并补齐遗漏业务字段。可传空数组自动生成全部字段；与 html 二选一。',items:{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},label:{type:'string'},display:{type:'string',enum:['text','list']}}}},
      html:{type:'string',description:'与人物卡风格相符的 HTML/CSS，推荐用 mvu-field 的 path 指定完整根路径，display=list 展示数组；组件默认只显示值，显式 label 才附带标签，外层已有字段名时省略 label；此时省略 bindings 和 collectionPath。旧式动态值放在文本节点的 $1、$2 等占位中；使用原生 details 折叠。HTML 不支持 {{user}}/{{char}}、EJS、动态属性；标签写“玩家”等静态文字。'},
      collectionPath:{type:'string',description:'指定后全部 bindings 相对于每个成员，不支持混入集合外全局字段。需要同时显示全局字段时省略本参数，使用完整根路径；不要删除字段来适应模式。'},
      bindings:{type:'array',items:{type:'object',additionalProperties:false,properties:{capture:{type:'number',required:true},path:{type:'string',required:true}}}},
      sourceFields:{type:'array',items:{type:'object',additionalProperties:false,properties:{path:{type:'string',required:true},offset:{type:'number',required:true},length:{type:'number',required:true},label:{type:'string'}}}},
      fieldMappings:{type:'array',items:{type:'object',additionalProperties:false,properties:{sourceId:{type:'string',required:true},path:{type:'string',required:true}}}}
    },
    output,isConcurrencySafe:()=>false,
    async execute(args,exec) {
      await requireWorkbench(exec)
      const {html,fields,bindings,collectionPath,...definition}=args
      try { return {report:await conversion.convert({...definition,action:'saveDefinition',appearance:{...(html!==undefined?{html}:{}),...(fields!==undefined?{fields}:{}),...(bindings?{bindings}:{}),...(collectionPath?{collectionPath}:{})}})} }
      catch (error) { return failure(error) }
    }
  }))
  tools.register(defineTool({
    name: 'tavern_validate_mvu_conversion',
    description: '只读验收专用工具生成的 MVU 副本：报告实际删除/保留条目、已识别旧渲染残留与方案外修改，从磁盘检查绑定、初值、后台分流、所有开场、面板唯一性与模型历史隔离，并在隔离 DOM 中模拟托管视图的变量更新/恢复。不会调用模型或执行原卡自定义脚本；limitations 仅说明自动检查未覆盖真实结算和浏览器，不代表待办；保存成功且自动校验通过即可完成转换，真实游玩仅在用户明确要求时另行执行。',
    parameters: { path: { type: 'string', required: true, description: '转换后的 cards/... 副本路径' } },
    output, isConcurrencySafe: () => true,
    async execute(args, exec) { await requireWorkbench(exec); return { report: await conversion.verify(args) } }
  }))
}
