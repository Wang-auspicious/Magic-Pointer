# Claude Code 2026-04 泄露版 `src/query.ts` 主循环研究笔记

- 日期：2026-08-12
- 目标文件：`C:\Users\zjz65\PycharmProjects\claude-code-main\src\query.ts`（1729 行，含空行；泄露版声明约 1600 行）
- 性质：只读研究，未修改任何代码
- 对照基线：Magic Pointer `app/fabric/engine.py`（837 行）、`app/fabric/model_plan.py`（297 行）、`app/fabric/workflow.py`、`app/fabric/executors.py`

---

## 0. 文件总览

`query.ts` 是"一次用户提问 = 一个 agentic turn"的主循环。入口 `query()`（219-239）是一个 AsyncGenerator，委托给内部生成器 `queryLoop()`（241-1729）。结构：

- `query(params)`：包装层，`yield* queryLoop(...)`，正常结束后给所有被消费的排队命令发 `completed` 生命周期事件（235-237）。
- `queryLoop(params)`：`while (true)` 无限循环（307），每轮 = 一次模型调用 + 工具执行 + 收尾检查；所有"还需要继续"的路径通过 `continue` 回到循环头；所有"结束"的路径通过 `return { reason: ... }` 返回 `Terminal`。
- 支持库：`src/query/config.ts`（不可变快照）、`src/query/deps.ts`（IO 依赖注入）、`src/query/tokenBudget.ts`（+500k 预算）、`src/query/stopHooks.ts`（Stop 钩子）、`src/services/compact/autoCompact.ts`。

---

## 1. `State` 对象：字段与生命周期

定义在 **query.ts:204-217**，初始化在 **268-279**。

| 字段 | 类型 | 生命周期 / 赋值点 |
|---|---|---|
| `messages` | `Message[]` | 全量对话历史。初始 = `params.messages`（269）。每轮末尾重建为 `[...messagesForQuery, ...assistantMessages, ...toolResults]`（1716）；恢复路径注入额外消息（1232-1236、1284-1288、1322-1329）。 |
| `toolUseContext` | `ToolUseContext` | 可变上下文（工具列表、abortController、queryTracking、agentId）。初始 = `params.toolUseContext`（270）。每轮头部**单独**解构为 `let`（311）并在轮内多次更新（360-363 加 queryTracking、546-549 挂 messages、1403-1407 工具执行的新 context、1660-1671 刷新 MCP 工具），因此它是唯一"continue 之间也会变"的字段。 |
| `autoCompactTracking` | `AutoCompactTrackingState \| undefined` | 即 `{ compacted, turnCounter, turnId, consecutiveFailures? }`（autoCompact.ts:51-60）。每轮传给 autocompact（465）；成功时重建（521-526：新 turnId、turnCounter=0、consecutiveFailures=0）；失败时只传播失败计数（539-542）；正常 next turn 原样携带（1718）。 |
| `maxOutputTokensRecoveryCount` | `number` | 0 起（274）。只在 max_output_tokens 恢复路径 +1（1239）；其他所有 continue/next turn 都重置为 0（1291、1332、1720）。**每轮生命周期**，不跨轮累计。 |
| `hasAttemptedReactiveCompact` | `boolean` | false 起（275）。reactive compact 跑过一次置 true（1157），防止"compact → 仍超长 → 再 compact"死循环（见 1292-1297 注释）；正常 next turn 重置 false（1721）；stop-hook blocking 后**保留**（1297）。 |
| `maxOutputTokensOverride` | `number \| undefined` | 初始 = `params.maxOutputTokensOverride`（271）。escalate 时置 `ESCALATED_MAX_TOKENS`（1213，单轮一次性，见 §5）；其余所有 continue/next turn 清为 `undefined`。 |
| `pendingToolUseSummary` | `Promise<ToolUseSummaryMessage \| null> \| undefined` | 上一轮在工具执行完后**异步**启动的摘要生成 promise（1469-1482），本轮轮末 await 后 yield（1055-1060），掩盖 Haiku 摘要的 ~1s 延迟在 5-30s 流式之后。所有 continue 点清空为 undefined（已消费）。 |
| `stopHookActive` | `boolean \| undefined` | 防 stop-hook 重入。stop hook 产生 blocking error 重试时置 true（1300）；其余路径 undefined。传给 `handleStopHooks`（1275）。 |
| `turnCount` | `number` | 从 1 起（276），每轮 +1（1679、1719）。maxTurns 检查用（1507-1513、1705-1712）；内存预取 consume 迭代标记用（1613 `turnCount - 1`）。 |
| `transition` | `Continue \| undefined` | 上一次 continue 的**原因**。首轮 undefined；供测试断言恢复路径是否触发（215-216 注释），并在运行时被读取一次：collapse drain 检查 `state.transition?.reason !== 'collapse_drain_retry'`（1092）。 |

**对照**：这是一棵"每轮整体重建"的状态树 —— 与 Magic Pointer 的 `ModelPlan`/`OperationPlan`（frozen dataclass，一次性产物，model_plan.py:120-141）完全不同：CC 的 State 是**循环运行时的可变续跑结构**，MP 的计划对象是**执行前定稿的契约**。移植时两者互补：MP 需要一个新的"turn 状态"dataclass（可变、非 frozen），而计划仍保持 frozen。

---

## 2. 循环的 "continue 点" 模式

核心注释在 **267 行**：*"Continue sites write `state = { ... }` instead of 9 separate assignments."*，并在 310 行注释 *"the rest are read-only between continue sites"*。

模式：

1. 每轮循环头整体解构 `state`（311-321），迭代体内所有代码用裸名读取。
2. 迭代中**只有** `toolUseContext` 会被重新赋值（360、546、1403、1664、1673 等）；其余字段只读。
3. 任何"继续下一轮"的位置**整体重建** `state = { ... }`，9 个字段一次写全 —— 这样：(a) 编译器强制每个 continue 点不漏字段；(b) 不需要区分"哪个字段被谁改过"；(c) `transition` 字段顺便记录本次 continue 的原因。

全部 continue 点（共 7 处，与 289 行注释"7 continue sites"一致）：

| 行号 | continue 原因 | transition.reason | 特殊状态操作 |
|---|---|---|---|
| 950 | 模型 fallback 重试（`FallbackTriggeredError`） | ——（裸 continue，只改 `currentModel`/`messagesForQuery`，不重建 state） | 清空 assistantMessages/toolResults/toolUseBlocks；stripSignatureBlocks；yield 警告系统消息（945-948） |
| 1114-1115 | context-collapse drain 后重试 | `collapse_drain_retry` + `committed` | 消息换为 drained.messages |
| 1164-1165 | reactive compact 成功后重试 | `reactive_compact_retry` | `hasAttemptedReactiveCompact: true` |
| 1219-1220 | max_output_tokens 升级到 64k 重试 | `max_output_tokens_escalate` | `maxOutputTokensOverride = ESCALATED_MAX_TOKENS` |
| 1250-1251 | max_output_tokens 恢复消息后重试 | `max_output_tokens_recovery` + `attempt` | `maxOutputTokensRecoveryCount + 1` |
| 1304-1305 | stop hook blocking error 后重试 | `stop_hook_blocking` | `stopHookActive: true`；重置 recovery count |
| 1339-1340 | token budget 续跑（+500k 特性） | `token_budget_continuation` | 注入 nudge meta 消息 |

另外**非 continue** 的正常"下一轮"也在 1727 整体赋值（`transition: { reason: 'next_turn' }`）—— 它是循环尾部的状态推进，不是 continue，但用同一模式。

**为什么"continue 处整体赋值"而不是逐字段更新**：迭代内读的是解构副本（裸名），任何逐字段更新在 continue 前都不可见；整体重建保证 continue 边界上状态完整、单一赋值点、测试可断言 `transition`。这是本文件最重要的结构性经验。

**对照**：照搬。MP 目前没有任何多轮循环（`engine.execute()` 是一次性 plan→execute→verify，engine.py:716-837）。若 MP 要支持"模型多轮工具调用/恢复重试"，这个"State 整体重建 + transition 原因记录"模式直接可迁移。

---

## 3. maxTurns / 终止条件：`Terminal`、stop 条件、budgetTracker

### 3.1 `Terminal` 类型

`Terminal` 与 `Continue` 从 `./query/transitions.js` 导入（**104 行**），但**该文件不在泄露版里**（`src/query/` 目录只有 config.ts / deps.ts / stopHooks.ts / tokenBudget.ts 四个文件；全仓 grep 不到 `type Terminal` 定义）。这是本笔记的诚实缺口之一 —— 只能从使用处推断：

- `Terminal` ≈ 带 `reason` 字段的判别联合，`query()` 的 return 值（227-228、238）。
- `Continue` 至少有 `reason` 字段（1092 读取），部分 reason 携带附加数据：`{ reason: 'collapse_drain_retry', committed: number }`（1109-1112）、`{ reason: 'max_output_tokens_recovery', attempt: number }`（1245-1248）。

### 3.2 全部终止（return）点

| 行号 | reason | 触发 |
|---|---|---|
| 646 | `blocking_limit` | 硬性上下文阻塞（autocompact 关闭时，为手动 /compact 留空间） |
| 977 | `image_error` | ImageSize/ImageResize 异常 |
| 996 | `model_error` + `error` | 流式调用抛出未知异常 |
| 1051 | `aborted_streaming` | 流式期间 abort |
| 1175 | `image_error` / `prompt_too_long` | 恢复失败后表面化被 withhold 的错误 |
| 1182 | `prompt_too_long` | contextCollapse 分支兜底 |
| 1264 | `completed` | 最后消息是 API 错误消息（rate limit 等）——不跑 stop hooks |
| 1279 | `stop_hook_prevented` | Stop 钩子阻止继续 |
| 1357 | `completed` | 正常完成（无工具调用需跟进） |
| 1515 | `aborted_tools` | 工具执行期间 abort |
| 1520 | `hook_stopped` | 钩子 attachment 标记 `hook_stopped_continuation` |
| 1711 | `max_turns` + `turnCount` | 超过 maxTurns |

### 3.3 maxTurns

`maxTurns` 只在两个位置检查：

- 工具执行后、abort 时（1506-1513）：yield `max_turns_reached` attachment 后返回 `aborted_tools`。
- 每轮循环尾（1704-1712）：`if (maxTurns && nextTurnCount > maxTurns)` → yield attachment + `return { reason: 'max_turns', turnCount: nextTurnCount }`。

注意 maxTurns 是**客户端轮数**（每轮 = 一次模型调用 + 工具批），不是 token 数。REPL 主线程通常不传（undefined）。

### 3.4 budgetTracker（+500k 续跑，非 task_budget）

- 创建：`feature('TOKEN_BUDGET') ? createBudgetTracker() : null`（280）。`BudgetTracker = { continuationCount, lastDeltaTokens, lastGlobalTurnTokens, startedAt }`（tokenBudget.ts:8-18）。
- 使用位置：只在 `!needsFollowUp`（本轮无工具调用、即将结束）时检查（1308-1355），即**结束时才问"要不要再续一轮"**。
- `checkTokenBudget`（tokenBudget.ts:28-69）：`agentId` 存在或预算无效 → stop；`turnTokens < budget * 0.9` 且非收益递减 → continue（nudge 消息）；`continuationCount >= 3 && delta < 500 && lastDelta < 500` → diminishing returns → stop（带 completionEvent）。token 数来自全局模块快照：`snapshotOutputTokensForTurn(budget)` 在 REPL 轮开始时调用（bootstrap/state.ts:733-737、REPL.tsx:2893-2895），`getTurnOutputTokens()` = 总输出 - 轮起始快照（726-728）。
- continue 时 `incrementBudgetContinuationCount()`（1317）并注入 `decision.nudgeMessage` 作为 meta 用户消息（1325-1328）。

**对照**：借鉴。MP 的 `engine.execute()`（engine.py:716）没有轮数/预算概念，一次执行即止。CC 的"turn 级 token 预算 + 结束时判断续跑 + 收益递减熔断"适合移植到 MP 的 agent 类任务（`agent.task` provider）上。

---

## 4. 紧凑（compact）触发与恢复逻辑

### 4.1 每轮入口的上下文缩减链（按顺序，全部条件触发）

1. `applyToolResultBudget`（379-394）：按工具 `maxResultSizeChars` 裁剪聚合工具结果，缓存编辑对 MC 不可见（注释 369-372）。
2. snip（401-410，`HISTORY_SNIP` feature）：截断历史，`snipTokensFreed` 传给 autocompact 校正阈值判断。
3. microcompact（414-426）：`deps.microcompact`，可能产生 deferred cache 编辑（`CACHED_MICROCOMPACT`），边界消息等 API 返回真实 `cache_deleted_input_tokens` 后才 yield（870-892）。
4. context collapse（440-447，`CONTEXT_COLLAPSE` feature）：**只读投影**，不 yield、不修改 REPL 历史，跨轮持久（注释 428-439）。
5. **autocompact**（454-467）：`deps.autocompact(messages, toolUseContext, cacheSafeParams, querySource, tracking, snipTokensFreed)`，返回 `{ compactionResult, consecutiveFailures }`。

### 4.2 触发后的处理

- 成功（470-535）：重置 `tracking = { compacted: true, turnId: uuid, turnCounter: 0, consecutiveFailures: 0 }`（521-526）；`buildPostCompactMessages`（compact.ts:330-338）= `boundaryMarker + summaryMessages + messagesToKeep + attachments + hookResults`，**逐条 yield**（530-532），然后 `messagesForQuery = postCompactMessages` 继续本轮 API 调用。
- 失败（536-543）：`consecutiveFailures` 传播到 tracking，熔断器在 autoCompact.ts:70（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，防止 413 死循环烧 API 钱）。
- 阻塞限制 preempt（628-648）：`!compactionResult && querySource !== 'compact' && querySource !== 'session_memory' && !(RC && autoCompact) && !collapseOwnsIt` 时计算 `isAtBlockingLimit`（阈值 = 上下文窗口 - 3k 缓冲，autoCompact.ts:123-136），命中即 `return blocking_limit`。跳过条件保证恢复机制（RC/collapse）能看到真实 413 而不是被合成错误饿死（604-614 注释）。

### 4.3 恢复路径（被 withhold 的 413 在轮末处理，见 §5/§6）

1. **collapse drain**（1090-1117）：`state.transition?.reason !== 'collapse_drain_retry'` 才跑（避免已 drain 还 413 时循环），drain > 0 则 continue。
2. **reactive compact**（1119-1166）：`tryReactiveCompact({ hasAttempted, ... })`，成功则同 autocompact 一样重建消息 + `hasAttemptedReactiveCompact: true` + continue。
3. **都失败** → yield 被 withhold 的错误，`executeStopFailureHooks`，`return prompt_too_long / image_error`（1173-1175）。**不落入 stop hooks**（注释 1168-1172：error → hook 阻塞 → retry → error 死循环）。

**对照**：改写。MP 有"上下文包"（`context_packet.py`、`runtime_snapshot.py`）但无 token 计数/压缩概念；`capture_policy.py` 的拒绝逻辑（deniedObjectIds）是"事前门禁"，不是"事后恢复"。CC 的"多级缩减链 + 熔断 + 恢复路径分层（便宜的先试）"思想值得借鉴，但 MP 的上下文（截图证据、DraftArtifact）是**本地对象引用**而非 API token，压缩的触发信号应从 token 换成证据包体积/历史轮数。

---

## 5. maxOutputTokens 超限恢复

### 5.1 常量与判定

- `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`（**164 行**）。
- `isWithheldMaxOutputTokens(msg)`（**175-179 行**）：`msg.type === 'assistant' && msg.apiError === 'max_output_tokens'`。注释（166-174）说明核心动机：**SDK 调用方（cowork/desktop）看到任何 error 字段就会终止会话**，所以可恢复错误必须先 withhold，恢复成功就永远不 yield。

### 5.2 流式内 withhold

`message.apiError === 'max_output_tokens'` 时设 `withheld = true`（820-822），**不 yield**，但仍 push 进 `assistantMessages`（826-827）供轮末检查。

### 5.3 轮末恢复（1188-1256），三层：

1. **单次 64k 升级**（1195-1221）：条件 `capEnabled（statsig tengu_otk_slot_v1）&& maxOutputTokensOverride === undefined && !env CLAUDE_CODE_MAX_OUTPUT_TOKENS`。命中 → `state.maxOutputTokensOverride = ESCALATED_MAX_TOKENS` + `transition: max_output_tokens_escalate` + continue。同请求原样重发，无 meta 消息、无多轮舞蹈（注释 1189-1193）。
2. **多轮恢复消息**（1223-1252）：`maxOutputTokensRecoveryCount < 3` 时注入 meta 用户消息 *"Output token limit hit. Resume directly — no apology…Break remaining work into smaller pieces."*（1224-1229），消息历史 = `[...messagesForQuery, ...assistantMessages, recoveryMessage]`，`maxOutputTokensRecoveryCount + 1`，continue。
3. **耗尽**（1254-1256）：`yield lastMessage`（此时才 surface 错误），随后落入 `lastMessage.isApiErrorMessage` 分支 → `executeStopFailureHooks` + `return completed`（1262-1265）。

### 5.4 兜底一致性

`yieldMissingToolResultBlocks`（**123-149 行**）：对每个 assistant 消息中的每个 tool_use block 生成 `{ type: 'tool_result', is_error: true, tool_use_id }` 用户消息。调用点：fallback 重试时（900-903）、流式异常时（984）、abort 且无 streaming executor 时（1025-1029）。保证"发了 tool_use 但没发 tool_result"不会污染后续 API 调用。

**对照**：照搬（概念）。MP 的 `model_plan.py` 用 `MAX_TOOL_CALLS=16`、`MAX_PLAN_BYTES=64KB` 等**输入侧**硬限制（model_plan.py:23-30），是"解析期拒绝"；CC 的 max_output_tokens 是**输出侧运行时恢复**。两者正交：MP 若接入真实模型流式输出，需要后者的"withhold → 分级重试 → 熔断 surface"模式。

---

## 6. 事件流：yield 的类型与 UI 驱动

### 6.1 生成器签名（219-228、244-250）

`AsyncGenerator<StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal>` —— **事件是流，返回值是 Terminal**（异步生成器的双通道）。注意 `Terminal` 永远不是 yield 的元素，是 return 值，消费方在 `for await` 结束后拿到。

`types/message.ts` 在泄露版中**缺失**（`src/types/` 只有 command/hooks/ids/logs/permissions/plugin/textInputTypes，无 message.ts），所以 `Message/TombstoneMessage/ToolUseSummaryMessage` 的精确定义不可读，以下来自使用点推断。

### 6.2 事件清单（yield 点）

| 行号 | 事件 | 含义 |
|---|---|---|
| 337 | `{ type: 'stream_request_start' }` | 每轮开头广播，UI 清空流式缓冲 |
| 407 | snip boundary message | HISTORY_SNIP 边界 |
| 530-532 | post-compact 消息（boundaryMarker/summary/attachments/hookResults） | 压缩产物直接进 UI 时间线 |
| 717 | `{ type: 'tombstone', message }` | 流式 fallback 时，为孤儿消息（无效签名的 thinking 块等）发墓碑，UI/transcript 删除 |
| 747-787 | assistant 消息（含 backfill 克隆） | 模型输出；`backfillObservableInput` 只对**新增字段**克隆（775-778），避免破坏 transcript VCR 哈希 |
| 823-825 | （非 withheld）assistant 消息 | 正常路径 |
| 851-861 | streaming tool result 消息 | StreamingToolExecutor 完成结果边流边发 |
| 884-891 | microcompact 边界消息 | 用真实 cache_deleted_input_tokens |
| 945-948 | fallback 系统消息（warning） | 用户可见通知 |
| 984 / 990-992 | 缺失 tool_result 补发 / API 错误消息 | 异常兜底 |
| 1021-1023 | abort 时剩余 tool result | 合成 tool_result 防孤儿 |
| 1047-1049 | `createUserInterruptionMessage` | abort 告知用户 |
| 1058 | `ToolUseSummaryMessage` | 上一轮 promise 的摘要（本轮轮末才 yield，隐藏延迟） |
| 1173 / 1180 / 1255 | 被 withhold 的错误最终 surface | 恢复耗尽 |
| 1384-1393 | 工具执行更新（消息 + 新 context） | 含 `hook_stopped_continuation` attachment |
| 1509-1513 / 1706-1710 | `max_turns_reached` attachment | 轮数终止 |
| 1580-1590 | 排队命令/文件变更 attachment | 轮末注入 |
| 1604-1614 | 内存预取 attachment | settled 且未消费时 |
| 1621-1628 | skill 发现 attachment | 预取 |

### 6.3 消费方（UI 驱动）

- **REPL.tsx:2793-2803**：`for await (const event of query({...})) { onQueryEvent(event) }` —— 事件直接驱动 React UI（streaming text、tool uses、attachments）；`onQuery` 用 `queryGuard.tryStart()` 做并发防护（2869），轮开始前 `snapshotOutputTokensForTurn`（2893-2895），结束后 `onTurnComplete`（2853）。
- 其他消费方：`QueryEngine.ts:675`、`tools/AgentTool/runAgent.ts:748`（子 agent）、`tasks/LocalMainSessionTask.ts:383`、`utils/forkedAgent.ts:545`、`utils/hooks/execAgentHook.ts:167`（钩子内跑 query）。

**对照**：照搬（模式）。MP 目前 `engine.execute()` 返回一个 `ExecutionReceipt` dict（engine.py:716-837）——**拉模式**；CC 是**推模式**（事件流）。MP 的 `workflow.py:25-64` `operation_graph()` 产出静态 DAG（ground→route→approval?→execute→verify）但没有任何运行时事件广播。若 MP 要做卡片 UI 的渐进渲染，应把 execute 改成 async 生成器：yield `stream_request_start` → 证据包构建进度 → 执行结果 → 验证进度，最后 return receipt。

---

## 7. stopHooks 如何影响循环

入口：`handleStopHooks`（query.ts:1267-1276，实现于 stopHooks.ts:65-473），**只在 `!needsFollowUp`（本轮无工具调用）且最后消息不是 API 错误时运行**。

### 7.1 前置防护（1258-1265）

`lastMessage?.isApiErrorMessage` → **跳过** Stop hooks，只跑 `executeStopFailureHooks`，`return { reason: 'completed' }`。注释（1258-1261）：错误消息上跑 Stop 钩子 = death spiral（error → hook 阻塞 → retry → error → …）。同样，413/媒体错误恢复失败路径也显式不落入 stop hooks（1168-1172、1176-1182）。

### 7.2 返回结构（stopHooks.ts:60-63）

`StopHookResult = { blockingErrors: Message[]; preventContinuation: boolean }`。

### 7.3 三个影响分支

1. `preventContinuation` → `return { reason: 'stop_hook_prevented' }`（1278-1280）；stopHooks.ts 内部 yield `hook_stopped_continuation` attachment（273-279）。
2. `blockingErrors.length > 0` → 把错误作为 user 消息注入历史（1284-1288），`stopHookActive: true`（1300），**continue**（1305）。关键注释（1292-1297）：**保留 `hasAttemptedReactiveCompact` 不重置** —— 曾经 reset 导致无限循环（compact → 超长 → 错误 → hook 阻塞 → compact → …烧掉几千次 API 调用）。同时 `maxOutputTokensRecoveryCount: 0` 重置。
3. 都为空 → 继续走到 token budget 检查（1308）或 `return completed`（1357）。

### 7.4 stopHookActive 防重入

stopHooks.ts:184：`executeStopHooks(..., stopHookActive ?? false, ...)`。上一次 blocking 重试把 `stopHookActive` 置 true，下一轮进入时传给钩子执行器，钩子系统据此避免重复触发同一个 blocking hook。

### 7.5 其他：钩子期间 abort（stopHooks.ts:283-294）

abort → yield interruption 消息 + `return { blockingErrors: [], preventContinuation: true }`。

**对照**：改写。MP 的 `hooks.py` 是**不同的东西** —— 构建/展开模型提示词（`build_hook_response`、episode 上下文，hooks.py:32-131），不是执行期钩子。MP 真正接近 CC stop-hook 的是 `engine.execute()` 里的确认门（`confirmation_required`，engine.py:722-729）和 `capture_policy` 的拒绝（plan() 内 454-465）。CC 的经验：**门禁钩子必须带防死循环（transition 原因 + hasAttempted 守卫）和防重入（stopHookActive）**。

---

## 8. task budget remaining 跨紧凑跟踪

与 §3.4 的 tokenBudget（客户端 +500k 续跑）**不同**：这是 API 的 `output_config.task_budget`（beta task-budgets-2026-03-13，注释 193-196）。

### 8.1 数据结构

- `params.taskBudget?: { total: number }`（197）。
- `taskBudgetRemaining: number | undefined`（**291 行**）——刻意**放在 State 之外**的 loop-local 变量（289-290 注释：*"Loop-local (not on State) to avoid touching the 7 continue sites."*）。未 compact 时为 undefined：此时服务端能看到全量历史，自己从 total 倒计时（注释指向 `api/api/sampling/prompt/renderer.py:292`，该文件在泄露版缺失）。

### 8.2 跨 compact 扣减

两个扣减点（proactive 与 reactive 各一）：

- 508-515：autocompact 成功后、`messagesForQuery` 被替换前，`taskBudgetRemaining = max(0, (taskBudgetRemaining ?? total) - preCompactContext)`。
- 1138-1146：reactive compact 成功后同样计算。

`preCompactContext = finalContextTokensFromLastResponse(messagesForQuery)`（tokens.ts:79-109）：取最后一条带 usage 的消息，优先 `usage.iterations[-1].input_tokens + output_tokens`（服务端工具循环的最终窗口），退化为顶层 `input + output`，**都不含 cache 令牌**（对齐 #304930 公式）。

### 8.3 传递

每轮 `deps.callModel` 时（699-706）：`taskBudget: { total, ...(remaining !== undefined && { remaining }) }`。

### 8.4 语义

compact 后服务端只看到摘要会**少算**花费；`remaining` 告诉它"被摘要掉的那段最终窗口"。多次 compact 累计：每次减去该次 compact 触发点的最终上下文（注释 288-289）。

**对照**：借鉴（概念）。MP 的 agent 类任务（`agent.task`，executors.py）走外部 CLI（codex/pi/claude 等），预算由外部 agent 自己管；但如果 MP 未来做自己的模型采样（fabric 内联模型），这个"服务端预算 vs 客户端可见上下文的补偿"机制直接可用。它的实现技巧值得记：**跨轮跟踪但刻意不进 State 结构** —— 用闭包/循环外变量 + 只在特定站点更新，避免污染 7 个 continue 点。Python 里等价于生成器闭包内的普通局部变量。

---

## 对照总表：与 Magic Pointer 的差距

| 机制 | CC query.ts | MP 现状 | 差距 |
|---|---|---|---|
| 多轮循环 | `while(true)` + State 重建 + Terminal | 无：`engine.execute()` 单次（engine.py:716-837）；`operation_graph()` 静态 DAG（workflow.py:25-64） | MP 没有 turn 概念，无续跑/重试路径 |
| 状态管理 | State dataclass，continue 处整体赋值 + transition 原因 | `ModelPlan`/`OperationPlan` 是 frozen 一次性产物（model_plan.py:120-141） | 缺一个**可变** turn-state；frozen 计划可保留 |
| 事件流 | AsyncGenerator yield 事件 + return Terminal | execute 返回 receipt dict（拉模式） | 缺推模式事件流；workflow DAG 可升级为运行态 |
| 错误恢复 | withhold → 分级重试 → 熔断 surface | 解析期硬限制（model_plan.py:23-30） | 缺输出侧运行时恢复 |
| 上下文管理 | 5 级缩减链 + 熔断 + 恢复分层 | 证据包构建（context_packet.py）无压缩 | MP 的"压缩"信号是证据体积/轮数而非 token |
| 预算 | task_budget remaining + tokenBudget 续跑 | 无 | agent.task 走外部 CLI，暂无需求；内联采样时需要 |
| 钩子 | Stop 钩子带防重入/防死循环 | hooks.py 是提示词构建，非执行钩子 | 确认门（engine.py:722-729）可借鉴防死循环思路 |

---

## 移植到 Python 的注意点

1. **生成器语义差异**：
   - TS `yield*` 转发（query.ts:230）在 Python 等价 `yield from`；但 TS 的 `return` 值经 `yield*` 传播（`const terminal = yield* queryLoop(...)`）Python 中要用 `yield from gen` 后**手动取回 return** 或 `StopIteration.value`（PEP 380 的 `return value` 在 `StopIteration.value`）。注意 TS `yield*` 在子生成器 throw 时会传播异常、`.return()` 会关闭两个生成器（232-234 注释）——Python 中 `Generator.close()`/`throw()` 语义类似但不完全相同，外层要显式 try/finally。
   - TS 生成器在 `continue` 前 `state = next` 是同步赋值；Python 生成器同样在 `yield` 处挂起，赋值时机一致。**但 Python 里每轮头部 `messages, toolUseContext, ... = state` 解构后，迭代体内对局部变量的修改同样要整体重建** —— 可以直接用 `@dataclass` + `replace()` 或显式构造。
2. **dataclass 选择**：State 应是非 frozen `@dataclass`（可变）或 frozen + `dataclasses.replace`；MP 现有 `ModelPlan` 是 frozen（model_plan.py:120），不要混用。`transition` 原因用 `Literal` 枚举 + 附加字段（`attempt`/`committed`）可用 `@dataclass Transition(reason: str, **extra)` 或 dict；建议用枚举 + 可选字段，避免 TS 判别联合的脆弱替代。
3. **异常语义差异**：
   - TS 的 `FallbackTriggeredError instanceof` 检查（894）→ Python `except FallbackTriggeredError`；但要小心 Python 异常会**在 `for await` 消费点抛出**，TS 的 try 包裹了整个 `for await`（653-954）——Python 里要包 `for message in call_model(...)` 的完整循环，且异常后清空 accumulators 的代码要在 except 块重复（TS 900-949 就是这么干的）。
   - TS `async` 生成器抛错后生成器**关闭**；Python 生成器 except 后还可以继续 yield —— 移植时不要利用这个差异，保持一致"要么 continue 要么 return"。
   - `Promise` 字段（pendingToolUseSummary）：Python 用 `asyncio.Task`，注意 task 在 `await` 前就启动（fire-and-forget 语义，1469-1482），取消要 `task.cancel()` 而不是丢弃；`.catch(() => null)` → `try/except asyncio.CancelledError` 外还要 `except Exception`。
4. **withhold 模式**：Python 中"先不 yield，恢复失败才 surface"要小心 —— 如果恢复分支忘记 yield，消息就**永久丢失**（TS 靠类型 + 仔细的代码路径）；建议封装 `maybe_yield(event)` 辅助或把 withhold 决策做成纯函数（如 `is_withheld_max_output_tokens(msg)`）。
5. **`for await` 双循环嵌套**：`for await (const message of deps.callModel(...))`（659）内部又 `for await (const result of streamingToolExecutor.getCompletedResults())`（851）——Python 用异步生成器嵌套，注意内层生成器在外层迭代中消费是安全的（asyncio 单线程），但**不要**在迭代中 await 一个需要外层继续才会完成的协程（死锁风险；CC 用 `getCompletedResults()` 而非阻塞等待规避）。
6. **`abortController.signal`**：→ `asyncio.Event` 或 `trio.CancelScope`；CC 多处检查 `signal.aborted`（1015、1485）并在 abort 时**先消费剩余结果再 return**（1019-1029）——Python 用 `CancelledError` 时要区分"优雅退出路径"（yield 合成 tool_result）和"硬取消"（直接抛），推荐显式检查取消标志而不是靠取消异常。
7. **TypeScript 空值语义**：`undefined` 与 `null` 混用（`pendingToolUseSummary: Promise | undefined`、`autoCompactTracking: undefined`）——Python 统一 `None`；注意 `(taskBudgetRemaining ?? params.taskBudget.total)` 的 ?? 语义（**只有 None 才取默认**）对应 `x if x is not None else default`，不要写成 `or`。
8. **闭包与共享可变状态**：`budgetTracker`（280）和 `consumedCommandUuids`（229）在生成器作用域内自然持有 —— Python 生成器函数局部变量同样自然持有，无闭包陷阱；但 `bootstrap/state.ts` 的**模块级单例**（outputTokensAtTurnStart、budgetContinuationCount，726-743）移植时要么接受全局单例（asyncio 下注意并发 turn），要么作为显式参数传入。
9. **事件类型**：TS 判别联合（`msg.type === 'assistant'` 等）→ Python 用 `@dataclass` 多态 + `isinstance`，或 `typing.Literal['assistant']` 联合；MP 现状是 dict + `type` 键（receipt dict），建议先保持 dict 兼容再考虑 dataclass。
10. **测试可断言性**：`transition` 字段专门为测试存在（215-216）——Python 移植时保留，断言 `loop_state.transition.reason == 'reactive_compact_retry'` 而不是翻消息内容。

---

## 5 个最关键的可移植机制

1. **State 整体重建 + transition 原因记录**（query.ts:204-217, 267-279, 311-321, 1092）：所有 continue 点一次性写全 9 字段并记录原因，编译器强制不漏、测试可断言 —— MP 建多轮循环的第一块基石。
2. **事件流 = AsyncGenerator，Terminal = return 值**（219-228, 337, 717）：流式事件驱动 UI + 返回值承载终止原因，比现在 execute() 的单一 receipt dict 更适合渐进式卡片渲染。
3. **withhold-until-recover 错误模式**（166-179, 788-825, 1054-1056, 1173-1175, 1254-1256）：max_output_tokens/413/媒体错误先扣住不 yield，分级恢复（64k 升级 → 恢复消息 → 表面化），防止下游消费者看到 error 就杀会话。
4. **恢复防死循环三件套**：`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3`（164）、`hasAttemptedReactiveCompact`（1157, 1292-1297）、`transition.reason` 去重（1092）+ API 错误跳过 stop hooks（1258-1265）——MP 的确认门/重试路径必须带同样的守卫。
5. **task budget remaining 的"循环外变量"技巧**（291, 508-515, 699-706）：跨紧凑跟踪但刻意不进 State，避免污染 7 个 continue 点 —— 任何"跨轮但低频更新"的计数器（预算、配额、时间戳）都用这个模式。

---

## 诚实报告：读不全的地方

1. **`src/query/transitions.js`（Terminal/Continue 类型）不在泄露中** —— `src/query/` 目录只有 config.ts/deps.ts/stopHooks.ts/tokenBudget.ts 四文件，全仓 grep 不到 `type Terminal`；Terminal/Continue 的精确字段是**推断**的（从 1092、1109-1112、1245-1248、1711 的使用处反推）。
2. **`src/types/message.ts`（Message/TombstoneMessage/ToolUseSummaryMessage/StreamEvent 定义）不在泄露中** —— §6 的事件表是从 yield 点反推的，部分字段名（apiError、isMeta、toolUseResult）来自使用点。
3. **`reactiveCompact.js`/`contextCollapse/`/`snipCompact.js`/`prefetch.js` 等 feature-gated require 模块全部缺失**（15-20, 66-71, 115-120）—— 只读到 query.ts 内的调用签名与注释语义，未读实现。
4. **`autoCompact.ts` 只读了 40-159 行**（状态类型、阈值、熔断常量），触发细节（compactionResult 的构造、summary 生成）在缺失的实现部分；`compact.ts` 只读了 buildPostCompactMessages（330-338）。
5. **`bootstrap/state.ts` 只读了 715-754 行**（turn token 快照），模块级 STATE 结构未全读。
6. **服务端对照 `api/api/sampling/prompt/renderer.py:292`（task_budget 倒计时）不在泄露版** —— §8 的服务端语义依赖注释转述。
7. **`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` 的 ESCALATED_MAX_TOKENS 具体值**在 `utils/context.js`（未读，泄露版该文件未验证存在）；64k 是注释（1190）转述。
