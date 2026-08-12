# Pi Agent 循环源码精读笔记（agent-loop / agent / agent-harness）

> 日期：2026-08-12 · 任务：只读研究，不改任何代码
> 输入：`D:\AI_Agents\pi\packages\agent\src\agent-loop.ts`、`agent.ts`、`harness\agent-harness.ts` + `harness\{types,messages,prompt-templates,system-prompt,skills}.ts`
> 对照面：Magic Pointer `app/fabric/engine.py`（单 tool call）、`app/fabric/agent_gateway.py`（外部网关）；CC 循环对照 `C:\Users\zjz65\PycharmProjects\claude-code-main\src\query.ts`

## 0. 诚实勘误（先说不舒服的）

1. **行数与任务描述不符**：`agent-loop.ts` 实际 **792 行**（任务写 714）、`agent.ts` 实际 **577 行**（任务写 514）、`agent-harness.ts` 实际 **1185 行**（任务写 1109）。研究按实际文件为准。
2. **本地没有 "multi-lane" 版本，也没有 `HarnessNotImplemented`**。全仓 grep 零命中（`D:\AI_Agents\pi` 下无任何 `lane` 概念）。本地 `agent-harness.ts` 是**完整可用的稳定版**（prompt/steer/followUp/nextTurn/skill/promptFromTemplate/compact/navigateTree/hook/compaction 全有），与设计文档 §10.1 对本地 HEAD `a116523`（2026-08-01）"完整实现"的描述一致。`HarnessNotImplemented` 只出现在 Magic Pointer 设计文档 §10.1 对**上游 `origin/main` 75c7fd6（2026-08-11，未检出到本地）** 的转述里。结论：**任务和 08-12 计划中"上游实验版"的标签，对本地这份源码不成立**；本地即稳定版，反而正是 §10.1 建议复用的对象。
3. 研究过程未运行任何 git 命令、未改任何文件、未跑测试（遵守约束）。

---

## 1. agent-loop.ts：循环结构（792 行）

### 1.1 入口（31–150）

| 函数 | 行号 | 职责 |
|---|---|---|
| `agentLoop(prompts, context, config, signal, streamFn)` | 31–54 | 带新 prompt 开一轮；内部 `runAgentLoop` |
| `agentLoopContinue(context, config, signal, streamFn)` | 64–93 | 无新消息继续（retry/续跑）；**前置校验**：context 非空、末条消息 role 不得是 assistant（74–76、131–133），否则抛错 |
| `runAgentLoop` / `runAgentLoopContinue` | 95–143 | 事件驱动的 async 版；先发 `agent_start` → `turn_start` → 对每个 prompt 发 `message_start`/`message_end` |
| `createAgentStream` | 145–150 | `EventStream<AgentEvent, AgentMessage[]>`：以 `agent_end` 为结束信号，返回值即 `agent_end.messages` |

对照：**照搬（整块可移植）**。这个"函数式入口 + EventStream 收尾"的形态对 Magic Pointer 很合适——事件流即进度流，UI 不需要轮询。

### 1.2 runLoop 主循环（155–275）——双层循环

```
outer while(true) {                    // 跟进队列把 agent 从"即将停止"拉回来
  inner while(hasMoreToolCalls || pendingMessages.length > 0) {
    if (!firstTurn) emit turn_start
    注入 pendingMessages（steering，逐条 message_start/end 后入 context）
    message = streamAssistantResponse(...)          // LLM 一轮
    if stopReason ∈ {error, aborted} → turn_end + agent_end 直接 return
    toolCalls = message 里全部 toolCall 块
    if toolCalls: 执行（见 1.4），结果全部 push 进 context 与 newMessages
    emit turn_end(message, toolResults)
    nextTurnSnapshot = config.prepareNextTurn?.(...)   // 可换 context/model/thinkingLevel（226–245）
    if config.shouldStopAfterTurn?.(...) → agent_end 并 return（247–257）
    pendingMessages = getSteeringMessages()           // 每轮结束再取一次 steering（259）
  }
  followUpMessages = getFollowUpMessages()            // 内层退出后取 follow-up（263–268）
  if followUpMessages: pendingMessages = followUpMessages; continue
  break
}
emit agent_end
```

关键语义：
- **steering ≠ follow-up**：steering 在"当前 turn 之后、下一轮 LLM 之前"注入（174–190），用户等不及可以中途插话；follow-up 只在 agent **本来会停**的时候续命（262–268）。语义上 steering 是打断、follow-up 是排队。
- **turn 定义**：一次 assistant 响应 + 随后的所有工具执行 = 一个 turn；`turn_end` 携带该 turn 的 assistant 消息和全部 toolResult（224）。
- **abort 是二等公民而非异常**：`streamAssistantResponse` 流内 `error`/`aborted` 都走"正常事件序列"收尾（196–200），`Agent.handleRunFailure` 再补事件。abort 不会抛。
- `prepareNextTurn` 可**整体替换 context + 换模型 + 换思考档位**（232–245），这是 harness 级能力（session 重载/模型切换）的注入点。

对照：**借鉴结构、改写为 MP 形态**。MP 短任务不需要双层队列的完整版，但 steering/follow-up 的区分（打断 vs 排队）和 `prepareNextTurn` 的"轮间换档"正是 MP 要的。差距：MP 现状 `engine.py:665-714` `plan_from_model` **显式拒绝多 tool call**（`multi_tool_plan_not_supported`，684–689），`execute()` 一次直线执行 39 个 recipe，没有任何"循环"。

### 1.3 streamAssistantResponse（281–372）——LLM 边界

- 每轮：`transformContext`（可选，AgentMessage→AgentMessage，可剪枝/注入）→ `convertToLlm`（AgentMessage→Message）→ 组 `Context{systemPrompt, messages, tools}` → `getApiKey`（**每轮动态取 key**，适配短命 OAuth token，305–306）→ `streamFn(model, context, opts)`。
- 流式事件：`start` 时把 partial 消息**先 push 进 context**（321），后续 `text_/thinking_/toolcall_` delta 用 `message_update` 事件 + 原地替换最后一条消息（335–343）；`done`/`error` 用 `response.result()` 收尾并替换/追加（346–359）。
- **错误编码进消息**：LLM 失败不抛，而是返回 `stopReason:"error"|"aborted"` + `errorMessage` 的 assistant 消息（`StreamFn` 契约，见 types.ts:23–27：**必须不抛、失败必须编码进流**）。
- "length" stopReason：输出被 token 上限截断 → **该消息所有 tool call 全部作废**（`failToolCallsFromTruncatedMessage`，381–406），逐条回灌 `"未执行：参数可能被截断，请重新发起"` 的 error result，让模型重发，而不是执行坏参数。

对照：**照搬（含 StreamFn 契约）**。MP 若自建循环，模型客户端适配层照这个契约写：失败编码成消息而不是异常。`length` 截断守卫是便宜又关键的安全网。差距：MP `ai_client.py` 是 request/response，无流式事件、无 `stopReason` 语义。

### 1.4 工具执行：并行/串行、preflight、hooks（411–787）

- 调度（411–426）：`config.toolExecution === "sequential"` **或批内任一工具声明 `executionMode:"sequential"`**（按名查 `currentContext.tools`）→ 串行；否则并行。**单工具声明串行即可把整批降级为串行**——这是给"必须独占的桌面动作"（如点击/写回）留的逃生口，对 MP 极有价值。
- 串行（433–487）：逐条 prepare → execute → finalize → `tool_execution_end` → toolResult 消息；每条之间检查 `signal?.aborted`。
- 并行（489–554）：**prepare 全部串行**（preflight 完成 schema 校验 + beforeToolCall 拦截，见 507–520），**execute 用 `Promise.all` 并发**（540–542），`tool_execution_end` 按完成顺序发，toolResult 消息**按 assistant 源顺序**发（544–548）。这个"预检串行、执行并发、结果按序"的模式是事件一致性的关键。
- `prepareToolCall`（600–664）：查工具（缺失 → error result `Tool xxx not found`）→ `prepareArguments` 兼容垫片（586–598，老工具参数形态适配）→ `validateToolArguments`（typebox schema）→ `beforeToolCall` hook（`{block:true}` 拦截 → 回灌错误，636–642）→ abort 检查。任何异常都变成 **immediate error result**（657–663），不炸循环。
- `executePreparedToolCall`（666–707）：工具 `execute(id, args, signal, onUpdate)`；`onUpdate` 发 `tool_execution_update` 流式进度（679–692，带 `acceptingUpdates` 防停后更新）；抛错 → error result。
- `finalizeExecutedToolCall`（709–754）：`afterToolCall` hook 可**按字段覆盖** result 的 content/details/isError/usage/terminate（无 deep merge）；hook 抛错 → error result。
- 批终止语义（582–584）：**只有批内全部 result 的 `terminate===true` 才提前停**，单个工具不能劫持整批。
- 消息归一化（773–787）：无 content 的 result 补空数组，保证 toolResult 消息永不带 null 进上下文。

对照：**照搬（这是 §10.1 点名要复用的核心）**。MP 的 ActionLease/权限/验证可以挂 `beforeToolCall`，验证/Undo 信息挂 `afterToolCall`，`terminate` 语义对齐"做完这步就收工"。差距：MP `executors.py` 是巨型 if/elif 分派、无 schema 校验、无 hook、无并行。

### 1.5 事件契约（见 §4）

---

## 2. agent.ts：Agent 类职责（577 行）

- **定位**：对无状态循环的**有状态门面**。注释自述（166–170）："owns the current transcript, emits lifecycle events, executes tools, exposes queueing APIs"。
- 状态（67–94 `createMutableAgentState`）：systemPrompt / model / thinkingLevel / tools / messages（getter/setter 均**拷贝数组**防外部篡改，77–88）/ isStreaming / streamingMessage / pendingToolCalls(Set) / errorMessage。
- **PendingMessageQueue**（123–157）：`QueueMode = "all" | "one-at-a-time"`（types.ts:45–50）——drain 时全吐或只吐最老一条，**剩余的留在队里等下一个 drain 点**。steering 默认 one-at-a-time，即一轮最多插一句。
- 公开 API（171–334）：`subscribe(listener)`（返回退订函数；**listener 按订阅顺序 await，纳入 run 结算**，243–246，注释 525–528 明确 agent_end ≠ idle）、`steer()`/`followUp()`/`clearSteeringQueue`/`clearFollowUpQueue`/`hasQueuedMessages`、`steeringMode`/`followUpMode`、`signal`/`abort()`/`waitForIdle()`/`reset()`、`prompt()`/`continue()`。
- **单 run 互斥**：`prompt()` 时若 `activeRun` 存在直接抛错，要求用 steer/followUp（340–344）；`continue()` 遇末条 assistant 先尝试 drain steering/follow-up 队列（360–374）。
- **run 生命周期**（471–520）：`runWithLifecycle` 建 AbortController + ActiveRun；失败走 `handleRunFailure`（496–512）**合成一条 `stopReason:"error"|"aborted"` 的空 assistant 消息并补齐 message_start/message_end/turn_end/agent_end 全套事件**——UI 永远不会面对"没头没尾的失败"；`finishRun` 清 runtime 态并 resolve `waitForIdle`。
- **事件归约**（529–576）：`processEvents` 把循环事件落进 state（message_end 追加 transcript、tool_execution_start/end 维护 pendingToolCalls 集合、turn_end 记 errorMessage），再扇出给 listeners（带当前 abort signal）。

**分工总结**：`agent-loop.ts` = 纯函数式循环（输入 context+config，产出事件与 newMessages，**不持有任何会话**）；`agent.ts` = transcript 所有者 + 队列 + 订阅 + abort/生命周期 + hook 接线（`createLoopConfig`，434–469，把 `prepareNextTurn`/`getSteeringMessages`/`getFollowUpMessages` 桥到类上，含 `skipInitialSteeringPoll` 一次性跳过技巧 460–464）。循环里没有任何"会话"概念，会话在 harness 层。

对照：**照搬（类结构可直接当 MP 的 Python/TS runtime 模板）**。MP 差距：`agent_gateway.py` 是**外部** agent 的启动/恢复/任务台账（`start()` 拼 CLI 命令、`task_store.start`、`resume_token`、jsonl-rpc 协议判断 163–176），它刻意"不持有 worker 状态"（agent_gateway.py:30–32），被评审 §L1 点名"被误当内部 runtime 用"——MP 缺的正是 agent.ts 这个"自己的、持状态的 runtime 壳"。

---

## 3. agent-harness.ts：AgentHarness（1185 行）

### 3.1 定位与 multi-lane 勘误

本地文件是 **turn 级单操作 harness**：`phase: "idle" | "turn" | "compaction" | "branch_summary" | "retry"`（types.ts:575），`prompt()/skill()/promptFromTemplate()/compact()/navigateTree()` 都先 `if (this.phase !== "idle") throw AgentHarnessError("busy", ...)`（694、710、732、785、847）。**没有 multi-lane（多并行泳道）概念**——multi-lane 是上游 75c7fd6 的未完成重写，本地未检出。

### 3.2 与稳定版 agent-loop 的协作方式（这是移植重点）

- `executeTurn`（623–690）：组 user 消息 →（可插入 `nextTurnQueue` 排队的消息，632–641）→ `before_agent_start` hook 可追加消息/换 systemPrompt（642–650）→ 调 `runAgentLoop`，事件交给 `handleAgentEvent`，streamFn 用 `createStreamFn` 包装 → 最后**从 newMessages 倒找最后一条 assistant 消息返回**（679–686）。
- **每轮快照**（395–429 `createTurnState`）：`session.buildContext()` 重建消息、`getResources()`、`resolveToolContext()`（**每 turn 重新解析工具上下文**，381–386）、按 `activeToolNames` 过滤出 activeTools、systemPrompt 可为回调（传 session/model/thinkingLevel/activeTools/resources）。
- `createLoopConfig`（484–540）把 harness 语义塞进循环配置：
  - `transformContext` → `context` hook（493–496，可改写整份上下文）；
  - `beforeToolCall` → `tool_call` hook（可 block + reason，497–505）；
  - `afterToolCall` → `tool_result` hook（可 patch content/details/isError/usage/terminate，506–526）；
  - **`prepareNextTurn` → flush 未落盘写入 → 重建 turnState → 整体换 context/model/thinkingLevel**（527–536）——模型/工具/上下文在轮间可全部刷新；
  - `getSteeringMessages`/`getFollowUpMessages` → drain 队列并先发 `queue_update` 事件（472–482）。
- **session 持久化**（554–578 `flushPendingSessionWrites`、580–607 `handleAgentEvent`）：`message_end` → 立即 `session.appendMessage`；`turn_end` → flush 所有 pending 写入（含 message/model_change/thinking_level_change/active_tools_change/custom/label/leaf，557–575）+ 发 `save_point`；`agent_end` → flush + `settled`。运行中外部改动（`appendMessage`/`setModel`/`setThinkingLevel`/`setActiveTools`）**不直接写库**，而是进 `pendingSessionWrites` 排队（768–781、946–962 等），在安全点批量落盘。
- 失败路径（609–621 `emitRunFailure`）：同 agent.ts，合成 failure 消息走完整事件序列。
- abort（1123–1151）：清 steer/followUp 队列 → abort 活动请求 → 等 idle → 发 `abort` 事件（带 cleared 队列），返回 `AbortResult`；`requestShutdown`/`waitForShutdown`（1104–1121）永久停。

### 3.3 工具上下文绑定（388–393）

harness 工具是 `AgentHarnessTool`（types.ts:99–112）：execute 签名多一个 `context` 参数（第 5 参）。`bindToolContext` 每轮把当前 turnState 的工具上下文闭包进 `AgentTool.execute`。**这是"桌面工具需要活的目标上下文（目标应用/租约/窗口）"的现成解法**——MP 的 TargetLease/RunEnvelope 完全可以走这个通道。

### 3.4 稳定层判定（对照设计文档 §10.1）

§10.1 列出可复用的：agent.ts / agent-loop.ts / 事件契约 / 并行串行工具 / before·after tool hooks / steering / follow-up / abort / prepareNextTurn——**在本地方言（稳定版）里全部存在且完整**，且已被 harness 自身消化（无遗留半成品）。不复用/不照搬的：`AgentSession`（大项目级会话树，§10.1 明确不复制）、compaction/branch-summary（MP 短任务不需要，且依赖 pi-ai 的 token 估算）、skill/prompt-template 加载（MP 有自己的 recipe/技能体系，可借鉴 `formatSkillInvocation` 的 XML 块形态：skills.ts:38–41）。

---

## 4. 事件契约（流式事件名全集）

### 4.1 低层 AgentEvent（types.ts:422–437）

```
agent_start                     // run 开始
agent_end(messages)             // run 结束，唯一带返回值的事件；agent_end 之后不再有循环事件
turn_start / turn_end(message, toolResults)   // 一次 assistant 响应 + 其工具执行
message_start(message)          // user/assistant/toolResult 消息开始（toolResult 也走 message 事件）
message_update(message, assistantMessageEvent) // 仅流式 assistant 消息的增量
message_end(message)            // 消息落定
tool_execution_start(toolCallId, toolName, args)
tool_execution_update(toolCallId, toolName, args, partialResult)
tool_execution_end(toolCallId, toolName, result, isError)
```

顺序保证：`agent_start → (turn_start → message_start/update/end* → tool_execution_start/update/end* → turn_end)* → agent_end`。`agent_end.messages` = 本次 run 的全部新消息（`newMessages`，即 prompt/continue 之后新增的部分）。

### 4.2 harness 层 AgentHarnessEvent（types.ts:737–766）= AgentEvent ∪ AgentHarnessOwnEvent

```
queue_update(steer[], followUp[], nextTurn[])     // 队列变化（含 drain 前，472–482）
save_point(hadPendingMutations)                   // turn_end 后安全落盘点
abort(clearedSteer[], clearedFollowUp[])
settled(nextTurnCount)                            // agent_end 之后
before_agent_start(prompt, images, systemPrompt, resources)   // hook，可回 messages/systemPrompt
context(messages)                                 // hook，可回改写后的 messages
before_provider_request(model, sessionId, streamOptions)      // hook，可 patch 请求参数
before_provider_payload(model, payload)           // hook，可改写 payload
after_provider_response(status, headers)
tool_call(toolCallId, toolName, input)            // hook，可 block
tool_result(toolCallId, toolName, input, content, details, isError, usage)  // hook，可 patch
session_before_compact / session_compact
session_before_tree / session_tree
retry_scheduled / retry_attempt_start / retry_finished
model_update / thinking_level_update / tools_update / resources_update
```

订阅双通道：`subscribe(listener)` 收全部（含低层 AgentEvent，只读）；`on(type, handler)` 收**带返回值**的 hook（`AgentHarnessEventResultMap`，types.ts:816–839）。

对照：**照搬事件契约**。MP 若自建循环，第一版只需要低层 9 个 AgentEvent + `agent_end.messages` 收尾；harness 层的 `queue_update/save_point/abort` 值得偷。差距：MP 现在 Electron ↔ Python 桥的事件面是进度/结果两类消息，没有 turn/tool 粒度；评审 L8 的"渐进式回答"（300ms 反馈/800ms 草稿/2s 终稿）恰好可以挂在 `message_update`/`tool_execution_update` 上。

---

## 5. 稳定可复用清单（供 08-12 计划取舍）

| 机制 | 出处 | 为什么稳 | MP 用法建议 |
|---|---|---|---|
| 双层队列：steering（打断）/ follow-up（排队） | agent-loop.ts:167,259,263–268; agent.ts:123–157,276–283 | 语义清晰、有 QueueMode、被 harness 实际使用 | 用户中途插话=steer；气泡后续问题=followUp |
| before/after tool hooks（可 block/patch 结果） | agent-loop.ts:600–664,709–754 | 拦截+改写都是纯函数、错误被规范化 | ActionLease 校验、权限、结果验证、Undo 信息 |
| 预检串行/执行并行/结果按源序 | agent-loop.ts:489–554 | 事件一致性有保证 | 多感知源并发（评审 L2 证据阶梯） |
| `terminate` 全批语义 | agent-loop.ts:582–584 | "做完就收"不劫持整批 | 短任务默认 N 轮内收工 |
| length 截断守卫 | agent-loop.ts:381–406 | 坏参数永不执行 | 任何 provider 都适用 |
| StreamFn 契约（失败编码进消息） | types.ts:23–27; agent-loop.ts:346–359 | 循环永不因 provider 抛 | `ai_client.py` 适配层照此写 |
| 失败消息合成 + 完整事件序列 | agent.ts:496–512; harness:609–621 | UI 总能收到头尾 | 取消/失败都走事件不走异常 |
| prepareNextTurn 轮间整体换档 | agent-loop.ts:226–245; harness:527–536 | context/model/thinking 全可换 | 换模型/重载 session/切租约 |
| 每轮快照 + 工具上下文绑定 | harness:395–429,388–393 | 桌面工具活上下文 | TargetLease/RunEnvelope 注入 |
| PendingSessionWrites 安全落盘 | harness:554–578 | 运行中不写库、安全点批量落 | 审计/Artifact 延迟写 |
| 事件契约全集 | types.ts:422–437,737–766 | 已定稿、可当协议 spec | 桥协议直接对齐 |

---

## 6. Pi 循环 vs CC query.ts 循环

CC 对照源：`C:\Users\zjz65\PycharmProjects\claude-code-main\src\query.ts`（1725 行，2026-04 泄露版，`queryLoop` 在 241 行起）。

| 维度 | Pi `agent-loop.ts`（+agent.ts/harness） | CC `query.ts` queryLoop | 更贴近 MP 短任务的一方 |
|---|---|---|---|
| 循环骨架 | 内层 steering/tool 循环 + 外层 follow-up 循环；turn 由事件划分 | 单 `while(true)`；**不可变 params + 可变 State 单对象**，迭代首部 destructure，continue 处整体 `state = {...}`（query.ts:268–279,1714–1725）；`transition` 记录继续原因（测试可断言） | Pi 事件流天然；CC 的 State 纪律值得借（08-12 计划已定照 CC） |
| 继续条件 | toolCalls>0 / steering / follow-up 队列 / prepareNextTurn / shouldStopAfterTurn | toolUse 结果回灌 → `transition:{reason:'next_turn'}`（1719）；maxTurns 上限（1704–1712）；stop hooks（`handleStopHooks`）；maxOutputTokens 恢复/升级（1217,1245）；reactive compact（1162） | Pi（队列驱动的继续条件） |
| 工具执行 | 循环内自带：schema 校验、hooks、串/并行、terminate | 循环外：`QueryEngine.ts` submitMessage + `services/tools/toolExecution.ts`（权限、hooks、错误结构化回灌）+ `toolOrchestration.ts`（179 行并行/串行） | Pi（内聚，事件与执行同文件，移植面小） |
| 上下文管理 | transformContext/convertToLlm 每轮可选；无压缩 | 内置 autoCompactTracking + 预算跟踪 + 记忆/skill 预取（301–304,323–331） | Pi（MP 短任务不需要压缩/预取） |
| 打断/排队 | steering（轮间插话）+ follow-up（将停时续命）一等公民 | 无队列概念；用户打断靠 interrupt 消息/REPL | **Pi（这正是 MP 的交互现实）** |
| 失败语义 | stopReason error/aborted + 合成失败消息走全事件序列 | 错误经 `yield*` 传播、工具错误结构化回灌 | Pi（事件面更干净） |
| abort | AbortSignal 贯穿 streamFn+工具；abort 事件+清队列 | interrupt/abort 在 QueryEngine 层，循环内无一等 abort 事件 | Pi（信号贯穿到工具 execute 签名，直接可用） |
| 输出形态 | 类型化 EventStream + agent_end 返回消息 | AsyncGenerator（StreamEvent \| Message \| ...）+ Terminal 返回值 | Pi（类型化事件 = 可写死的桥协议） |
| 事件契约 | 9 个 AgentEvent 定稿（types.ts:422–437） | 事件名随功能膨胀（StreamEvent 大联合类型） | Pi |
| 重量级依赖 | 仅依赖 pi-ai（模型流） | 依赖 statsig/feature 开关、内存预取、任务摘要、多 provider 客户端（claude.ts 3212 行）等 | Pi（无运营级依赖） |
| 会话/持久化 | 在 harness 层（session 树、pending 写入），循环本身无状态 | fork/memory/history 由外部模块管 | 平手（MP 自持 RunEnvelope） |
| 许可证/来源 | 本机开源仓库（@earendil-works/pi） | 2026-04 泄露版代码，**不可直接照抄**（只能借鉴模式） | Pi（可移植合法） |

**结论**：对"短任务、1–2 轮、分钟级、用户会中途插话、失败要可归因"的 Magic Pointer，**Pi 循环更接近**——队列驱动的继续条件、事件契约、AbortSignal 贯穿、无压缩/预取依赖，全是 MP 需要的；CC 的循环为长代码库会话优化（压缩、预取、stop hooks），且其源码不能直接复用。值得从 CC 借的只有两件：`State 单对象 + transition 原因记录`的测试可断言纪律（08-12 计划已采纳），以及 `maxTurns/turnCount` 硬上限（Pi 无内建 turn 上限，需 MP 的短任务 Governor 补，设计文档 §10.2）。

---

## 7. 与 Magic Pointer 现状的差距总结

- `engine.py:665–714`：`plan_from_model` 要求 **len(tool_calls)==1**，多工具直接 `multi_tool_plan_not_supported`；`execute()` 单次执行 recipe → 无 observe→decide→act 迭代、无 tool result 回灌、失败即整轮失败。Pi 循环的全部 9 个 AgentEvent 和 tool 回灌语义在这里都没有对应物。
- `agent_gateway.py`：是"外发边界"（发现 provider、选 session、起 CLI 任务、台账与租约执行），**不是运行时**；注释自述不持 worker 状态。评审 §L1 指认的"被误当内部 runtime"根因就是缺一个 agent.ts 式的有状态运行时壳。
- MP 已有可挂载点：`app/fabric/hooks.py`（内部 hook）、`executors.py`（工具分派）、`app/governance/latency_budget.py` + 取消令牌（评审批次 0 产物）、`app/evidence/`（证据契约）——Pi 的 beforeToolCall/afterToolCall 正好是这些模块的挂点；`agent_loop` 需要的 `transformContext` 可以接 `context_packet.py`。
- 移植风险提示：Pi 事件契约是 TS 类型；MP 循环已定 Python（08-12 计划），需把 9 个 AgentEvent + QueueMode + terminate 语义在 `app/agent_runtime/types.py` 里显式写成协议常量，并照 `StreamFn` 契约写 `model_client.py`（失败编码进消息、不抛）。
