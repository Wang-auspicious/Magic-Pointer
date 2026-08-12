# Claude Code 2026-04 泄露版：tokenBudget / stopHooks / config / deps 研读笔记

日期：2026-08-12
来源：`C:\Users\zjz65\PycharmProjects\claude-code-main\src\query\` 下四个文件（只读研读，未改任何代码）
对照目标：Magic Pointer `app/governance/latency_budget.py`（126 行）、`app/governance/cancellation.py`（150 行）

---

## 1. tokenBudget.ts（93 行）— 回合级输出 token 预算

### 机制（逐段）

- **L3-4 常量**：`COMPLETION_THRESHOLD = 0.9`（90% 预算即触发完成判定）、`DIMINISHING_THRESHOLD = 500`（连续续推收益递减阈值，token 数）。
- **L6-11 BudgetTracker 结构**：`continuationCount`（已续推次数）、`lastDeltaTokens`（上一次检查的增量 token）、`lastGlobalTurnTokens`（上次检查时的回合总输出 token）、`startedAt`（毫秒时间戳，用于 durationMs 统计）。
- **L13-20 createBudgetTracker()**：`Date.now()` 打起点；这是一个**纯数据结构 + 一个调用点做快照**的模式，没有类、没有内部时钟注入。
- **L22-43 决策类型**：
  - `ContinueDecision { action:'continue', nudgeMessage, continuationCount, pct, turnTokens, budget }` —— nudge 消息来自 `../utils/tokenBudget.js` 的 `getBudgetContinuationMessage`（prompt 层面的"续推"提示，以 `isMeta` user message 追加进消息流）。
  - `StopDecision { action:'stop', completionEvent: {continuationCount, pct, turnTokens, budget, diminishingReturns, durationMs} | null }` —— **stop 也区分"有完整统计事件的 stop"和"空 stop"（feature 关闭/子代理时的静默 stop）**。
- **L45-53 checkTokenBudget 入口**：
  - 传入 `tracker, agentId, budget, globalTurnTokens`。
  - **agentId 存在（子代理/teammate）→ 直接 stop + null 事件**：预算只作用于主线程。
  - **budget === null || budget <= 0 → 同样静默 stop**：未配置预算即等效于功能关闭。
- **L55-62 计算**：
  - `turnTokens = globalTurnTokens`（**调用方已把"回合内增量"算好**，见 query.ts:1313 的 `getTurnOutputTokens()`，其内部 = 总输出 token − 回合起点快照，state.ts:726-728）。
  - `pct = round(turnTokens / budget * 100)`。
  - `deltaSinceLastCheck = globalTurnTokens - lastGlobalTurnTokens`（与上次检查的差）。
  - `isDiminishing = continuationCount >= 3 && deltaSinceLastCheck < 500 && lastDeltaTokens < 500`：**连续 3 次续推后，最近两次增量都 < 500 token → 判为收益递减，提前止损**。
- **L64-76 continue 分支**：`!isDiminishing && turnTokens < 0.9*budget` → 更新 tracker（continuationCount++、lastDeltaTokens、lastGlobalTurnTokens）并返回 continue + nudge 消息。
- **L78-90 stop 分支**：`isDiminishing || continuationCount > 0` → stop **带 completionEvent**（上报 pct、token、diminishingReturns、durationMs）；否则（首查即超限，无续推史）→ stop + null 事件。
- **扣减时机**：**不"扣减"，而是每轮查一次当前累计值并比较**。预算本身（`currentTurnTokenBudget`）由 CLI 参数在回合起点经 `snapshotOutputTokensForTurn(budget)` 设置（state.ts:724-743），`getTurnOutputTokens()` 以回合起点为基准做差。**回合结束预算即作废，不跨回合累计**。

### 与查询循环的交互（query.ts:1308-1357，补充证据）

- 循环位于"模型已产生最终回复（无工具调用）且 stop hooks 已通过"之后：`feature('TOKEN_BUDGET')` 门内调用 `checkTokenBudget(budgetTracker!, agentId, getCurrentTurnTokenBudget(), getTurnOutputTokens())`。
- `continue` → 追加 `isMeta` nudge user message，`transition.reason = 'token_budget_continuation'`，**重新走一遍循环**（再次调用模型）；并调 `incrementBudgetContinuationCount()`（state.ts:741）。
- `stop` → 有 completionEvent 则 `logEvent('tengu_token_budget_completed', ...)`，然后 `return { reason: 'completed' }`。
- 所以"超限"不是硬中断：**先续推提示（90% 前），到 90% 就停；收益递减提前停**。预算是一个"软上限 + 收益递减感知"的机制，硬上限由模型 API 层（maxOutputTokens 等）另行处理。

### 对照

| 维度 | CC tokenBudget | Magic Pointer latency_budget.py |
|---|---|---|
| 预算类型 | 回合输出 **token** 软预算 | 单阶段 **墙钟毫秒** 硬预算 |
| 判定 | 累计百分比 + 增量收益递减 | elapsed <= budget_ms |
| 超限行为 | nudge 续推 / stop（带统计事件） | TimeoutAction 枚举（ABANDON / USE_PREVIOUS_FRAME / MARK_TIMEOUT_CONTINUE / SHOW_PROGRESS / STASH_BACKGROUND） |
| 状态 | BudgetTracker（可变，4 字段） | 无状态纯函数 check_budget() + frozen BudgetResult |
| 上报 | completionEvent（pct/tokens/durationMs/diminishingReturns）→ analytics | BudgetResult（within_budget/action/overrun_ms）→ 调用方自行处置 |

- **照搬**：`pct` 计算、`budget<=0/null` 即停的语义、返回结构化结果对象（BudgetResult ↔ completionEvent）的纯函数风格——MP 的 check_budget 已是此风格。
- **借鉴（要补）**：CC 的"**续推-停止两段式**"（90% 前 continue+nudge，90% 停）对应 MP 只有 `MARK_TIMEOUT_CONTINUE` 这个单点动作，没有"nudge 消息回流进循环输入"的语义；收益递减检测（3 次后增量 <500 即止损）MP 完全没有——对"重复检索仍无进展"的任务很有价值。
- **改写（不照搬）**：CC 用 `Date.now()` 直接内联时钟、budget 存在模块级可变 state（state.ts:724-743）——MP 规则要求"确定性状态/时钟外置"，应把时钟与预算快照做成注入参数（见 deps 一节）。

---

## 2. stopHooks.ts（473 行）— 回合结束钩子网关

### 机制（逐段）

- **L60-63 StopHookResult**：`{ blockingErrors: Message[], preventContinuation: boolean }` —— 两个独立出口。
- **L65-81 handleStopHooks 签名**：`async generator`，输入 messagesForQuery + assistantMessages + systemPrompt + 双 context + toolUseContext + querySource + stopHookActive；产出 StreamEvent/Message 流，最终返回 StopHookResult。**所有"回合结束副作用"都集中在这个网关里**。
- **L84-98 快照与缓存**：构造 `REPLHookContext`；仅 `repl_main_thread` / `sdk` 两个 querySource 保存 cache-safe params（子代理不得覆盖）。
- **L108-132 模板任务分类**：`feature('TEMPLATES') && CLAUDE_JOB_DIR && repl_main_thread && !agentId` 时，回合末对 assistant 消息跑 job classifier 写 state.json，60s 兜底超时（不阻塞退出）。
- **L136-157 后台书签（非 bare 模式）**：prompt suggestion、extract-memories（`EXTRACT_MEMORIES` feature 门 + 非子代理 + extract 模式激活）、autoDream —— 全部 fire-and-forget（`void`）。
- **L164-173 chicago MCP 回合末清理**：`CHICAGO_MCP` feature 门 + 主线程，静默失败。
- **L175-189 核心：executeStopHooks**（外部钩子执行器，来自 utils/hooks.ts）：传入 permissionMode、**abortController.signal**、`stopHookActive ?? false`、agentId、agentType 等。
- **L200-295 消费生成器**：
  - 收集 progress 消息（toolUseID、hook 命令、prompt 文本）→ hookInfos；attachment 解析三类结果（hook_non_blocking_error / hook_error_during_execution / hook_success）+ 每条 hook 的 durationMs（按 command + 首个未分配项匹配）。
  - **blockingError → 转成 isMeta user message（getStopHookMessage）**，压入 blockingErrors 并 yield（隐藏于 UI，summary 中展示）。
  - **preventContinuation → 置位 + 记录 stopReason（默认 'Stop hook prevented continuation'）**，并 yield `attachment { type:'hook_stopped_continuation', hookName:'Stop', ... }` —— 这是给查询循环的结构化信号。
  - **L283-294 abort 检查**：hook 执行期间若 `abortController.signal.aborted`（用户中断）→ logEvent + yield `createUserInterruptionMessage({toolUse:false})` + **return { blockingErrors:[], preventContinuation:true }**。即：**用户中断也以 preventContinuation 形态通知循环**。
- **L297-323 汇总**：hookCount>0 时 yield `createStopHookSummaryMessage(...)`（含 suggestion 语义）；有错误时 addNotification（ctrl+o 展开）。
- **L325-332 出口顺序**：preventContinuation → return；blockingErrors → return（**注意 preventContinuation:false**）。
- **L334-453 teammate 分支**：isTeammate() 时对 in-progress 且 owner=self 的任务逐个跑 `executeTaskCompletedHooks`，再跑 `executeTeammateIdleHooks`，同样支持 blockingError / preventContinuation / abort 检查。
- **L456-472 兜底**：任何异常 → logEvent('tengu_stop_hook_error') + yield 警告 system message + **return 不阻止**（钩子失败绝不杀死循环）。

### 与查询循环的交互（query.ts:1267-1306，补充证据）

- `yield* handleStopHooks(...)` 在"模型无工具调用、回合将完成"处被调用。
- `preventContinuation` → `return { reason: 'stop_hook_prevented' }`，**循环直接终止**（不重询模型）。
- `blockingErrors.length > 0` → 追加错误消息重建 state，`stopHookActive: true`，`transition.reason='stop_hook_blocking'`，`continue` **重跑一轮**。`stopHookActive` 是防死循环门（钩子错误→重试→再错误→再钩子）；且注释明确：**保留 hasAttemptedReactiveCompact 以防 compact 死循环**（query.ts:1292-1297）。
- 也见 query.ts:1384-1393：工具更新流中的 `hook_stopped_continuation` attachment 同样置 shouldPreventContinuation —— **preventContinuation 是贯穿"工具执行"和"回合末"的统一停止信号**。

### 对照

**注意：CC 的 "Stop hooks" 不是成本/时间预算**。它是用户可配置的外部命令钩子（settings 中 Stop / SubagentStop / TaskCompleted / TeammateIdle 事件），可输出两种行为：blockingError（= 让循环带着错误重试，有 stopHookActive 门）与 preventContinuation（= 终止循环）。成本上限（budget_usd）与时间上限不在本文件内（成本在 attachments.ts:627-636 'budget_usd' / 模型计费路径；时间上限没有找到专门的 stop hook，靠 AbortController 中断实现）。

| 概念 | CC | Magic Pointer 现状 |
|---|---|---|
| 回合末检查点 | handleStopHooks 网关（唯一入口，全部副作用集中） | 无回合/任务级结束网关 |
| 停止语义 | preventContinuation + stopReason + attachment | 无（CancellationScope 只有 cancel 布尔 + 异常抛出） |
| 错误回流 | blockingErrors → 重询一轮，stopHookActive 门防死循环 | 无 |
| 用户中断 | abortController.signal 在钩子边界检查 → interruption message → preventContinuation | CancellationToken.is_cancelled() 已有，但无"中断消息 + 结构化停止原因" |
| 防死循环 | stopHookActive flag + hasAttemptedReactiveCompact 保留 | 无对应物 |

- **照搬**：abort 检查点模式（把 `cancellation.py` 的 token 检查插到每个 hook/阶段边界，对应 CC 的 signal.aborted 检查）；结构化结果出口（StopHookResult ↔ BudgetResult 风格一致）。
- **借鉴（要补）**：preventContinuation + reason + attachment 三元组；blockingErrors 回流 + stopHookActive 防死循环门；hook 失败绝不终止循环的兜底；回合末汇总/通知。
- **改写**：teammate/TaskCompleted/Idle 分支、fire-and-forget 后台任务（autoDream/memories）与 MP 无关，不移植。

---

## 3. config.ts（46 行）— 查询级不可变快照

### 机制

- **L8-14 设计意图（注释即文档）**：QueryConfig 是 query() 入口一次性快照的不可变值，与 per-iteration State、可变 ToolUseContext 分离——为未来 `step()`（纯 reducer 取 (state, event, config)）铺路。**明确排除 `feature()` 门**（那是 tree-shaking 边界，必须内联在守卫点以支持死代码消除）。
- **L15-27 QueryConfig 内容**：`sessionId` + `gates` 四个运行时门：
  - `streamingToolExecution`：statsig 远程开关（`tengu_streaming_tool_execution2`，`CACHED_MAY_BE_STALE` 名字已自陈可接受陈旧值）。
  - `emitToolUseSummaries`：环境变量 `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`。
  - `isAnt`：`USER_TYPE === 'ant'`（内部用户区分）。
  - `fastModeEnabled`：`!CLAUDE_CODE_DISABLE_FAST_MODE`（注释：内联以避免引入 fastMode.ts 的重模块图，保护测试初始化顺序）。
- **L29-45 buildQueryConfig()**：一次读齐，返回 frozen 结构。

### 对照与差距

- **模型不在冻结范围内**：模型选择不在这里（query.ts 内部按请求解析）。**token 预算也不在**：预算经 `snapshotOutputTokensForTurn(budget)` 存模块级 state（state.ts:724-743），按"回合"而非按"查询"快照。任务要求问"buildQueryConfig 冻结什么（模型/预算/feature 门）"——诚实回答：**冻结 sessionId + 4 个运行时门；模型与预算均不冻结**（预算每回合从 state 读）。
- MP 差距：没有等价物。MP 的每任务循环应该有一个**任务级不可变 QueryConfig**（任务 id / 会话 id / 预算上限 / 门开关），一次快照，循环内只读——这正好落进 MP"确定性状态外置"规则。
- **照搬**：快照-一次、纯数据、与可变状态分离的形态。**改写**：MP 无 statsig/环境门体系，门集合应换成 MP 自己的（如 UIA 深度、OCR 后端、feature 门），且 MP 无 tree-shaking 需求，feature 门可并入 config 而不必内联。

---

## 4. deps.ts（40 行）— 依赖注入种子

### 机制

- **L8-20 设计意图**：query() 的 I/O 依赖（callModel、microcompact、autocompact 是最常被 mock 的模块，各在 6-8 个测试文件里被 spy）集中为 `QueryDeps`，测试通过 QueryParams 注入 fake，代替逐个模块 spy。用 `typeof fn` 让类型与真实实现自动同步；**范围刻意窄（4 个）**，注释明示后续可加 runTools、handleStopHooks、logEvent、queue ops。
- **L21-31 QueryDeps**：`callModel`（模型流式调用）、`microcompact` / `autocompact`（两级紧凑）、`uuid: () => string`。
- **L33-39 productionDeps()**：生产工厂返回真实实现（crypto.randomUUID 等）。
- **诚实补充**：**时钟没有注入**——tokenBudget.ts:18/87、stopHooks.ts:82/457 都直接 `Date.now()`；deps 里只有 uuid，无 clock。这是 CC 自身的确定性问题，移植时应改进。

### 对照与差距

- MP 现状：模块直接 import，无 DI 容器、无测试注入缝（latency_budget.py / cancellation.py 都是纯函数/类 + 单例 registry）。
- **借鉴（要补）**：为 MP 的回合循环定义窄范围 `TaskLoopDeps`（模型调用、紧凑/摘要、uuid、时钟、OCR 后端句柄），`productionDeps()` 工厂 + 测试 fake 注入。尤其**时钟注入**是 MP 规则（确定性时钟外置）直接要求的，CC 反而没做。
- **不照搬**：`typeof fn` 类型同步技巧是 TS 专属，Python 用 Protocol/TypedDict 等价。

---

## 5. 与 Magic Pointer 已有实现的差距总结

**已有（无需补）**：
- 阶段级墙钟预算表 + 超时降级动作（latency_budget.py：Stage/TimeoutAction/BudgetPolicy/check_budget/remaining_ms）——纯函数、frozen、无 I/O，风格已对齐 CC 的纯函数判定。
- 线程安全取消：CancellationToken/CancellationScope/CancellationRegistry/cancel_all_in_flight（cancellation.py）——语义上覆盖 CC 的 abortController.signal 检查点（CC 检查点是显式插桩，MP 靠 raise_if_cancelled 在 await 点抛出）。

**要补（按优先级）**：
1. **回合/任务结束网关**（对标 handleStopHooks）：唯一结束检查点，统一执行"停止判定 + 副作用 + 汇总"；出口三元组 `{prevented, reason, blocking_errors}`。
2. **preventContinuation 语义**：结构化停止原因 + attachment（审计轨迹），区分"用户中断/预算耗尽/钩子阻止"三类原因；MP 目前 CancelledError 无原因分类。
3. **token 软预算 + 续推-停止两段式**：pct 报告、90% 阈值、nudge 消息回流循环输入、completionEvent（含 durationMs）。
4. **收益递减止损**：连续 N 次续推且增量 < 阈值 → 提前停（对标 3 次/500 token）。
5. **blockingErrors 回流 + stopHookActive 防死循环门**（对标 query.ts:1300）+ 紧凑重试保护（对标 hasAttemptedReactiveCompact 保留，query.ts:1292-1297）。
6. **任务级 QueryConfig 冻结**（sessionId/任务 id/预算/门）+ **TaskLoopDeps 注入缝**（含**时钟**，CC 自己都没做）。
7. **hook 失败兜底**：结束网关异常只告警、绝不终止循环（CC stopHooks.ts:456-472）。

**关于"task budget remaining 跨紧凑"的诚实结论**：在这 4 个文件 + 其直接调用点（query.ts、state.ts）中，预算语义是**回合级**（每回合 `snapshotOutputTokensForTurn` 重置，state.ts:733-737），**没有发现跨紧凑保留 remaining 预算的机制**；跨回合/跨紧凑的累计只存在于全局 `getTotalOutputTokens`（state.ts:708-710，供成本预算使用）。若 Magic Pointer 需要"任务预算跨紧凑保留"，**无现成 CC 机制可抄，需自行设计**（建议：任务级预算表存于任务状态，紧凑仅重写消息历史、不动预算字段）。

---

## 6. 循环停止条件设计建议清单（供 Magic Pointer 回合循环采纳）

1. **三类停止出口**，出口即结构化结果：`(a) 完成`（模型给出最终答复且无工具调用）、`(b) 阻止续推`（preventContinuation，带 reason 枚举：user_interrupt / budget_exhausted / diminishing_returns / hook_blocked）、`(c) 错误回流重试`（blocking_errors，受 stopHookActive 门限制，最多连续 N 次）。
2. **预算判定纯函数化**：`check_budget(stage, elapsed)` 已有；新增 `decide_token_continuation(tracker, budget, turn_tokens) -> ContinueDecision | StopDecision`，与 CC 同构，但时钟/快照由注入提供。
3. **两段式软预算**：`turn_tokens < 0.9 * budget` → continue + nudge（nudge 作为 isMeta 消息回流输入）；`>= 0.9` → stop + completionEvent；budget null/<=0 或子代理 → 静默 stop。
4. **收益递减止损**：`continuation_count >= 3 && 最近两次增量 < 500 token` → 立即 stop 并标记 diminishingReturns（防"检索死循环烧 token"）。
5. **用户中断 = 第一优先级停止**：在结束网关每个钩子/阶段边界检查 CancellationToken（对标 CC 的 signal.aborted 检查），中断时产出"中断消息 + reason=user_interrupt"，并 `cancel_all_in_flight()` 联动现有 registry。
6. **钩子/副作用失败不杀循环**：结束网关整体 try/except，失败仅告警 + 记日志，返回不阻止（对标 stopHooks.ts:456-472）。
7. **任务级预算表跨紧凑保留**：预算 remaining 存任务状态（非回合状态），紧凑只重写消息历史；每回合从任务预算扣除回合消耗。
8. **任务级 QueryConfig 冻结 + deps 注入**：每任务一次快照（任务 id、预算、门、时钟），循环内只读；模型调用/紧凑/uuid/时钟走注入缝以便测试。
9. **停止原因全量审计**：每次 stop 写结构化记录（reason、pct、turn_tokens、budget、duration_ms、diminishing），供 STATUS/诊断复现——对齐 CC 的 completionEvent + analytics 事件。

---

## 7. 结论（诚实报告）

- 研读范围：4 个目标文件全文 + 交叉验证 query.ts（1267-1393）、bootstrap/state.ts（724-749）、attachments.ts 的 budget_usd 提及。未读 stopHooks 所调用的 utils/hooks.ts 全文（约 2750+ 行），其 preventContinuation 内部判定细节（hooks.ts:2747-2753）仅知入口语义。
- CC 这四个文件暴露的架构顺序值得借鉴：**回合结束网关（stopHooks）→ 预算判定（tokenBudget）→ 纯数据 config → 依赖注入**；其中只有 stopHooks 是真正的"停止机制"，tokenBudget 是"软预算 + 收益递减"，config/deps 是工程结构。
- MP 的 latency_budget/cancellation 已覆盖"墙钟阶段预算"与"取消基建"，缺的是**回合级网关、结构化停止原因、token 软预算、防死循环门**；"跨紧凑保留预算"CC 也没有，需自研。
