import assert from 'node:assert/strict'
import test from 'node:test'

import { createMvuBackgroundTaskFrame, createMvuSettlementModule, formatMvuUpdateCommand, normalizeMvuToolSubmission, projectMvuBackgroundRequest } from '../tavern-plugin/lib/domain/mvu-background-settlement.js'

test('深模块强制一次工具调用并以官方 Runtime 的实际差异生成回执', async function () {
  const modelCalls = []
  const runtimeCalls = []
  const module = createMvuSettlementModule({
    model: {
      async run(input) {
        modelCalls.push(structuredClone({ messages: input.messages, turnContext: input.turnContext, rewindTo: input.rewindTo, webSearchEnabled: input.webSearchEnabled }))
        await input.onToolCall({ name: 'posture_submit', arguments: { posture: '扶墙站立' } })
        await input.onToolCall({
          name: 'mvu_submit_update',
          arguments: { operations: [{ op: 'delta', path: '/stat_data/体力', value: -1 }] }
        })
        return { text: '', traceSessionId: 'background-1', traceBoundary: 12 }
      }
    },
    runtime: {
      async settleMvuUpdate(input) {
        runtimeCalls.push(input)
        return {
          updated: true,
          context: { messages: [{ variables: {} }, { variables: { stat_data: { 体力: 9 }, schema: { type: 'object' } } }] }
        }
      }
    }
  })

  const result = await module.settleVariables({
    operationId: 'operation-1', chatId: 'chat-1', branchId: 'branch-1', basedOnRevision: 5,
    sessionId: 'session-1', turn: 2, messageId: 1, swipeId: 0, expectedLifecycleRevision: 3,
    storyText: '她受伤后扶墙站立。', selection: { provider: 'test', model: 'test' }, webSearchEnabled: true,
    currentVariables: { stat_data: { 体力: 10 }, schema: { type: 'object' } }
  })

  assert.equal(modelCalls[0].rewindTo, -1)
  assert.equal(modelCalls[0].webSearchEnabled, true)
  assert.equal(modelCalls[0].messages.length, 1)
  assert.equal(runtimeCalls.length, 1)
  assert.match(runtimeCalls[0].command, /"op": "delta"/)
  assert.equal(result.receipt.status, 'updated')
  assert.equal(result.posture, '扶墙站立')
  assert.equal(result.receipt.summary, '')
  assert.deepEqual(result.receipt.changes, [{ operation: 'set', path: '/stat_data/体力', before: '10', after: '9' }])
})

test('MVU 后台拒绝人物设计调用，仅完成姿势和变量结算', async function () {
  const designCalls = []
  const module = createMvuSettlementModule({
    characterDesign: {
      async execute(chatId, call) {
        designCalls.push({ chatId, name: call.name })
        return JSON.stringify({ ok: true })
      }
    },
    model: { async run(input) {
      assert.deepEqual(input.tools.map(tool => tool.name), ['posture_submit', 'mvu_submit_update'])
      await input.onToolCall({ name: 'character_design_read', arguments: {} })
      assert.equal(JSON.parse(await input.onToolCall({ name: 'character_design_save', arguments: completeDesignFixture() })).ok, false)
      await input.onToolCall({ name: 'posture_submit', arguments: { posture: '站在门边' } })
      await input.onToolCall({ name: 'mvu_submit_update', arguments: { operations: [] } })
      return { text: '' }
    } },
    runtime: { async settleMvuUpdate() { return { context: { messages: [{ variables: { hp: 10 } }] } } } }
  })
  const result = await module.settleVariables({
    backgroundTasks: { characterDesign: true },
    operationId: 'operation-design', chatId: 'chat-design', branchId: 'branch-1', basedOnRevision: 1,
    sessionId: 'session-1', messageId: 0, swipeId: 0, storyText: '她走进门内。', currentVariables: { hp: 10 }
  })
  assert.deepEqual(designCalls, [])
  assert.equal(result.posture, '站在门边')
  assert.equal(result.receipt.status, 'unchanged')
})

function completeDesignFixture() {
  return {
    name: '林岚', identity: '镇上的邮差', narrativeRole: '持续传递线索的人物', coreMotivation: '找到失踪的同伴',
    innerConflict: '职责与私人追寻彼此冲突', personality: '谨慎而执着', appearance: '高挑，短黑发，左眉有浅疤',
    behaviorStyle: '先观察出口再交谈', speechStyle: '措辞简短而准确', relationships: '与镇民保持克制友善',
    defaultPresentation: '深蓝邮差制服和旧皮靴', plotPotential: '失踪同伴留下的信件可牵出后续冲突'
  }
}

test('深模块逐项核验提交结果并把人物卡脚本联动与失败操作分开记录', async function () {
  const module = createMvuSettlementModule({
    maxAttempts: 1,
    model: {
      async run(input) {
        await input.onToolCall({ name: 'posture_submit', arguments: { posture: '走向石门' } })
        await input.onToolCall({
          name: 'mvu_submit_update',
          arguments: {
            operations: [
              { op: 'replace', path: '/本尊/行踪/当前区域', value: '古殿·幽暗长廊' },
              { op: 'replace', path: '/当前处境', value: '正走向石门' }
            ]
          }
        })
        return { text: '' }
      }
    },
    runtime: {
      async settleMvuUpdate() {
        return {
          updated: true,
          context: {
            messages: [{
              variables: {
                stat_data: {
                  本尊: { 行踪: { 当前区域: '古殿·幽暗长廊' } },
                  当前处境: '',
                  $宗门推断: { 当前域: '归墟' }
                }
              }
            }]
          }
        }
      }
    }
  })
  const result = await module.settleVariables({
    operationId: 'operation-partial', chatId: 'chat-1', branchId: 'branch-1', basedOnRevision: 5,
    sessionId: 'session-1', messageId: 0, swipeId: 0, storyText: '他走入长廊，望见石门。',
    currentVariables: {
      stat_data: {
        本尊: { 行踪: { 当前区域: '未知之地' } },
        当前处境: '',
        $宗门推断: { 当前域: '' }
      }
    }
  })

  assert.equal(result.receipt.status, 'partial')
  assert.deepEqual(result.receipt.changes, [{
    operation: 'set', path: '/stat_data/本尊/行踪/当前区域', before: '未知之地', after: '古殿·幽暗长廊'
  }])
  assert.deepEqual(result.receipt.failures, [{
    operation: 'replace', path: '/当前处境', message: '未观察到对应变量变化；请通过“日志”导出执行记录'
  }])
  assert.deepEqual(result.receipt.sideEffects, [{
    operation: 'set', path: '/stat_data/$宗门推断/当前域', before: '', after: '归墟'
  }])
})

test('深模块把有效空 Patch 记录为 unchanged，把漏调用工具记录为失败', async function () {
  const unchanged = createMvuSettlementModule({
    maxAttempts: 1,
    model: {
      async run(input) {
        await input.onToolCall({ name: 'posture_submit', arguments: { posture: '原地站立' } })
        await input.onToolCall({ name: 'mvu_submit_update', arguments: { operations: [] } })
        return { text: '' }
      }
    },
    runtime: {
      async settleMvuUpdate() { return { updated: true, context: { messages: [{ variables: { hp: 10 } }] } } }
    }
  })
  const input = {
    operationId: 'operation-2', chatId: 'chat-1', branchId: 'branch-1', basedOnRevision: 5,
    sessionId: 'session-1', messageId: 0, swipeId: 0, storyText: '他仍站在原地。', currentVariables: { hp: 10 }
  }
  assert.equal((await unchanged.settleVariables(input)).receipt.status, 'unchanged')

  const missing = createMvuSettlementModule({
    maxAttempts: 1,
    model: { async run() { return { text: '{}' } } },
    runtime: { async settleMvuUpdate() { throw new Error('不应执行') } }
  })
  await assert.rejects(function () { return missing.settleVariables(input) }, /未调用 mvu_submit_update/)
})

test('变量结算 Frame 明确隔离用户输入、旧轮正文和隐藏思考', function () {
  const frame = createMvuBackgroundTaskFrame({
    operationId: 'agent-1', chatId: 'chat-1', branchId: 'branch-1', basedOnRevision: 9,
    messageId: 4, swipeId: 0, storyDigest: 'story-hash', storyText: '突破失败，他跌回原地。',
    currentVariables: { stat_data: { 修为: 10 }, schema: { type: 'object' } },
    updateRules: ['只记录正文已经发生的变化。']
  })
  const request = projectMvuBackgroundRequest(frame)
  const suppliedContext = JSON.stringify({ messages: request.messages, turnContext: request.turnContext })

  assert.equal(frame.trigger.messageId, 4)
  assert.equal(frame.outputContract.singleCommit, true)
  assert.equal(frame.outputContract.maxToolCalls, 3)
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].role, 'assistant')
  assert.match(suppliedContext, /突破失败/)
  assert.doesNotMatch(suppliedContext, /尝试突破|隐藏思考|旧轮正文/)
  assert.deepEqual(request.tools.map(function (tool) { return tool.name }), [
    'posture_submit', 'mvu_submit_update'
  ])
  const mvuTool = request.tools.find(function (tool) { return tool.name === 'mvu_submit_update' })
  assert.deepEqual(mvuTool.parameters.required, ['operations'])
  assert.equal(Object.hasOwn(mvuTool.parameters.properties, 'analysis'), false)
})

test('空 operations 是有效的明确结算结果，旧 analysis 输入被兼容忽略', function () {
  const value = normalizeMvuToolSubmission({ analysis: '旧格式说明', operations: [] })
  assert.deepEqual(value.operations, [])
  assert.equal(Object.hasOwn(value, 'analysis'), false)
  assert.match(formatMvuUpdateCommand(value), /<JSONPatch>\n\[\]\n<\/JSONPatch>/)
  assert.doesNotMatch(formatMvuUpdateCommand(value), /<Analyze>/)
})

test('发给官方 MVU 前把 DSH 绝对变量路径转为 stat_data 内的相对路径', function () {
  const command = formatMvuUpdateCommand({ operations: [
    { op: 'delta', path: '/stat_data/祝南枝/对主角的好感度', value: 1 },
    { op: 'move', from: '/stat_data/祝南枝/旧位置', path: '/stat_data/祝南枝/当前位置' },
    { op: 'replace', path: '/世界/当前时间', value: '10时38分' }
  ] })
  const patch = JSON.parse(command.match(/<JSONPatch>\n([\s\S]*?)\n<\/JSONPatch>/)[1])

  assert.deepEqual(patch, [
    { op: 'delta', path: '/祝南枝/对主角的好感度', value: 1 },
    { op: 'move', from: '/祝南枝/旧位置', path: '/祝南枝/当前位置' },
    { op: 'replace', path: '/世界/当前时间', value: '10时38分' }
  ])
})

test('工具拒绝任意 JavaScript、非法路径和无效 delta', function () {
  assert.throws(function () {
    normalizeMvuToolSubmission({ operations: [{ op: 'eval', path: '/hp', value: 'process.exit()' }] })
  }, /不受支持/)
  assert.throws(function () {
    normalizeMvuToolSubmission({ operations: [{ op: 'replace', path: 'hp', value: 9 }] })
  }, /JSON Pointer/)
  assert.throws(function () {
    normalizeMvuToolSubmission({ operations: [{ op: 'delta', path: '/hp', value: '1' }] })
  }, /有限数字/)
})

test('关闭姿势和设计后直接结算 MVU，关闭的工具不能写入状态', async () => {
  let applied = 0
  const module = createMvuSettlementModule({
    characterDesign: { execute() { throw new Error('不应执行设计') } },
    model: { async run(input) {
      assert.deepEqual(input.tools.map(tool => tool.name), ['mvu_submit_update'])
      assert.doesNotMatch(input.system, /必须调用 posture_submit/)
      assert.equal(JSON.parse(await input.onToolCall({ name: 'posture_submit', arguments: { posture: '错误姿势' } })).ok, false)
      assert.equal(JSON.parse(await input.onToolCall({ name: 'character_design_save', arguments: {} })).ok, false)
      assert.equal(JSON.parse(await input.onToolCall({ name: 'mvu_submit_update', arguments: { operations: [] } })).ok, true)
      return { text: '' }
    } },
    runtime: { async settleMvuUpdate() { applied++; return { context: { messages: [{ variables: { hp: 10 } }] } } } }
  })
  const result = await module.settleVariables({
    backgroundTasks: { posture: false, characterDesign: false },
    operationId: 'tasks-off', branchId: 'branch', basedOnRevision: 1, chatId: 'chat', sessionId: 'session', messageId: 0, swipeId: 0,
    storyText: '没有变化。', currentVariables: { hp: 10 }
  })
  assert.equal(applied, 1)
  assert.equal(result.posture, undefined)
  assert.equal(result.receipt.status, 'unchanged')
})

test('旧配置开启台账时仍不注入台账任务或工具，变量无需等待台账', async () => {
  let calls = 0
  const module = createMvuSettlementModule({
    model: { async run(input) {
      calls++
      assert.ok(!input.turnContext.includes('当前台账'))
      assert.ok(!input.system.includes('台账维护'))
      assert.ok(!input.tools.some(tool => tool.name === 'ledger_submit'))
      assert.equal(JSON.parse(await input.onToolCall({ name: 'mvu_submit_update', arguments: { operations: [] } })).ok, true)
      return { traceSessionId: 'same-background', traceBoundary: 5 }
    } },
    runtime: { async settleMvuUpdate(input) {
      assert.ok(!input.command.includes('林岚'))
      return { updated: false, context: { messages: [{ variables: {} }, { variables: { stat_data: { hp: 10 } } }] } }
    } }
  })
  const result = await module.settleVariables({ operationId: 'ledger-test', chatId: 'chat', branchId: 'branch', basedOnRevision: 1, sessionId: 's', messageId: 1, swipeId: 0, turn: 2, currentVariables: { stat_data: { hp: 10 } }, storyText: '林岚与你同行', backgroundTasks: { posture: false, characterDesign: false, ledger: true } })
  assert.equal(calls, 1)
  assert.equal(result.ledger, undefined)
  assert.equal(result.traceSessionId, 'same-background')
})

test('independent posture and variable tools can finish in one response in either order', async () => {
  for (const reversed of [false, true]) {
    let runs = 0, writes = 0
    const module = createMvuSettlementModule({
      model: { async run(input) {
        runs++
        assert.match(input.system, /同一次回复中同时调用/)
        const calls = [{ name: 'posture_submit', arguments: { posture: '站立' } }, { name: 'mvu_submit_update', arguments: { operations: [] } }]
        if (reversed) calls.reverse()
        const results = await Promise.all(calls.map(call => input.onToolCall(call)))
        assert.ok(results.every(result => JSON.parse(result).ok))
        assert.equal(input.stopToolsWhen(), true)
        assert.equal(input.acceptWithoutText(), true)
        await input.onToolCall({ name: 'posture_submit', arguments: { posture: '重复修改' } })
        await input.onToolCall(calls.find(call => call.name === 'mvu_submit_update'))
        return {}
      } },
      runtime: { async settleMvuUpdate() { writes++; return { updated: false, context: { messages: [{ variables: {} }, { variables: { stat_data: { hp: 10 } } }] } } } }
    })
    const result = await module.settleVariables({ operationId: 'batch', chatId: 'chat', branchId: 'branch', basedOnRevision: 1, turn: 2, swipeId: 0, sessionId: 's', messageId: 1, storyText: '她站在门边。', currentVariables: { stat_data: { hp: 10 } }, backgroundTasks: { posture: true, variables: true } })
    assert.equal(runs, 1)
    assert.equal(writes, 1)
    assert.equal(result.posture, '站立')
  }
})

test('failed posture can be corrected after variables succeed without repeating variable execution', async () => {
  let writes = 0
  const module = createMvuSettlementModule({
    model: { async run(input) {
      assert.equal(JSON.parse(await input.onToolCall({ name: 'mvu_submit_update', arguments: { operations: [] } })).ok, true)
      assert.equal(input.stopToolsWhen(), false)
      assert.equal(input.acceptWithoutText(), false)
      assert.equal(JSON.parse(await input.onToolCall({ name: 'posture_submit', arguments: { posture: '' } })).retryable, true)
      assert.equal(input.stopToolsWhen(), false)
      assert.equal(JSON.parse(await input.onToolCall({ name: 'posture_submit', arguments: { posture: '坐下' } })).ok, true)
      assert.equal(input.stopToolsWhen(), true)
      return {}
    } },
    runtime: { async settleMvuUpdate() { writes++; return { updated: false, context: { messages: [{ variables: {} }, { variables: { stat_data: { hp: 10 } } }] } } } }
  })
  const result = await module.settleVariables({ operationId: 'batch', chatId: 'chat', branchId: 'branch', basedOnRevision: 1, turn: 2, swipeId: 0, sessionId: 's', messageId: 1, storyText: '她站在门边。', currentVariables: { stat_data: { hp: 10 } }, backgroundTasks: { posture: true } })
  assert.equal(result.posture, '坐下')
  assert.equal(writes, 1)
})

test('本轮 Helper 建角要求交给结算，后续回合不重放初始化', async () => {
  const { collectMvuHelperContext } = await import('../tavern-plugin/lib/domain/mvu-background-settlement.js')
  const setup = '已写入属性；第一轮补齐主角生命值、法力值、体力值。'
  const messages = [{ role: 'assistant', text: '选择开局' }, { role: 'tavern-helper', text: setup }, { role: 'user', text: '开始' }, { role: 'assistant', text: '你来到旅店。' }]
  const context = collectMvuHelperContext(messages, 3)
  assert.deepEqual(context, [setup])
  const request = projectMvuBackgroundRequest(createMvuBackgroundTaskFrame({ operationId: 'setup-1', chatId: 'chat-setup', branchId: 'main', basedOnRevision: 1, messageId: 3, swipeId: 0, helperContext: context, storyText: messages[3].text }))
  assert.match(request.turnContext, /第一轮补齐主角生命值/)
  assert.match(request.turnContext, /初始化/)
  messages.push({ role: 'user', text: '受伤后休息' }, { role: 'assistant', text: '伤口仍在流血。' })
  assert.deepEqual(collectMvuHelperContext(messages, 5), [])
  assert.deepEqual(collectMvuHelperContext(messages, 3), [setup], '重试旧轮仍取旧轮上下文')
  const next = projectMvuBackgroundRequest(createMvuBackgroundTaskFrame({ operationId: 'setup-1', chatId: 'chat-setup', branchId: 'main', basedOnRevision: 1, messageId: 5, swipeId: 0, helperContext: [], storyText: messages[5].text }))
  assert.doesNotMatch(next.turnContext, /第一轮补齐/)
  assert.equal(next.system, request.system, '稳定 system 前缀不随建角上下文变化')
  assert.deepEqual(collectMvuHelperContext([{role:'user',text:setup},{role:'assistant',text:'正文'}],1),[])
})

test('JSON wire values reach runtime decoded; malformed submissions never dispatch', async () => {
  const variables = { stat_data: { 金币: 1000000, 装备: {} } }
  const operations = [
    { op: 'replace', path: '/stat_data/金币', valueJson: '999995' },
    { op: 'add', path: '/stat_data/装备/长剑', valueJson: '{"名称":"长剑","等级":1}' }
  ]
  let dispatched = 0
  const module = createMvuSettlementModule({
    model: { async run(request) {
      await request.onToolCall({ name: 'posture_submit', arguments: { posture: '站立' } })
      const rejected = JSON.parse(await request.onToolCall({ name: 'mvu_submit_update', arguments: {
        operations: [{ ...operations[0], valueJson: false }]
      } }))
      assert.equal(rejected.ok, false)
      assert.equal(rejected.rolledBack, true)
      assert.equal(dispatched, 0)
      const accepted = JSON.parse(await request.onToolCall({ name: 'mvu_submit_update', arguments: { operations } }))
      assert.equal(accepted.ok, true)
      return {}
    } },
    runtime: { async settleMvuUpdate(request) {
      dispatched++
      const patch = JSON.parse(request.command.match(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/)[1])
      assert.deepEqual(patch, [
        { op: 'replace', path: '/金币', value: 999995 },
        { op: 'add', path: '/装备/长剑', value: { 名称: '长剑', 等级: 1 } }
      ])
      return { context: { messages: [{ variables: { stat_data: { 金币: 999995, 装备: { 长剑: { 名称: '长剑', 等级: 1 } } } } }] } }
    } }
  })
  const result = await module.settleVariables({ operationId: 'json-wire', chatId: 'c', branchId: 'b', basedOnRevision: 1,
    sessionId: 's', messageId: 0, swipeId: 0, storyText: '支付五枚金币，获得长剑。', currentVariables: variables })
  assert.equal(dispatched, 1)
  assert.equal(result.receipt.status, 'updated')
  assert.equal(result.variables.stat_data.金币, 999995)
  assert.equal(variables.stat_data.金币, 1000000)
})

test('silent card rejection reports submitted and observed values for a targeted correction', async () => {
  let feedback
  const module=createMvuSettlementModule({maxAttempts:1,
    model:{async run(input){
      await input.onToolCall({name:'posture_submit',arguments:{posture:'站在路旁'}})
      feedback=JSON.parse(await input.onToolCall({name:'mvu_submit_update',arguments:{operations:[{op:'replace',path:'/当前活动',valueJson:'["步行通勤"]'}]}}))
      return {text:''}
    }},
    runtime:{async settleMvuUpdate(){return {updated:true,context:{messages:[{variables:{stat_data:{当前活动:[]}}}]}}}}
  })
  await module.settleVariables({operationId:'rejected-activity',chatId:'c',branchId:'b',basedOnRevision:1,sessionId:'s',messageId:0,swipeId:0,storyText:'走到路旁。',currentVariables:{stat_data:{当前活动:[]}}})
  assert.equal(feedback.ok,false)
  assert.deepEqual(feedback.rejectedOperations,[{operation:'replace',path:'/当前活动',submittedJson:'["步行通勤"]',observedJson:'[]'}])
  assert.match(feedback.error,/不得原样重试/)
})

test('model timeout after a rejected patch remains an actionable task error',async()=>{
 const variables={stat_data:{hp:10}}
 const module=createMvuSettlementModule({
  model:{async run(input){
   await input.onToolCall({name:'posture_submit',arguments:{posture:'原地站立'}})
   await input.onToolCall({name:'mvu_submit_update',arguments:{operations:[{op:'replace',path:'/hp',valueJson:'9'}]}})
   throw new Error('后台模型没有有效输出，请重试',{cause:Object.assign(new Error('timeout'),{code:'BACKGROUND_MODEL_IDLE_TIMEOUT'})})
  }},
  runtime:{async settleMvuUpdate(){return {updated:true,context:{messages:[{variables}]}}}}
 })
 await assert.rejects(module.settleVariables({operationId:'timed-out',chatId:'c',branchId:'b',basedOnRevision:1,sessionId:'s',messageId:0,swipeId:0,storyText:'已经生成的正文。',currentVariables:variables}),/没有有效输出/)
 assert.deepEqual(variables,{stat_data:{hp:10}})
})

test('本局 Guide 进入变量结算上下文，空 Guide 不占位', function () {
  const base = { operationId: 'guide-1', chatId: 'chat', branchId: 'main', basedOnRevision: 1, messageId: 1, swipeId: 0, storyText: '正文' }
  const request = projectMvuBackgroundRequest(createMvuBackgroundTaskFrame({ ...base, guides: [{ id: 'a', text: ' 好感度涨得慢一点 ' }, { id: 'b', text: '' }] }))
  assert.match(request.turnContext, /【玩家 Guide · 持续生效】/)
  assert.match(request.turnContext, /1\. 好感度涨得慢一点\n/)
  assert.doesNotMatch(request.turnContext, /2\. /)
  assert.match(request.system, /只根据【正文】中已经确认发生的事实结算变量/)
  assert.doesNotMatch(projectMvuBackgroundRequest(createMvuBackgroundTaskFrame(base)).turnContext, /Guide/)
})
