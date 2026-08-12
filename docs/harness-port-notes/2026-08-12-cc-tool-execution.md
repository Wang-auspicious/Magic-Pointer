# CC 工具执行链路研究笔记（2026-04 泄露版）

- 日期：2026-08-12
- 来源：`C:\Users\zjz65\PycharmProjects\claude-code-main\src\`（Claude Code 2026-04 泄露版）
- 方式：只读精读，未修改任何源码
- 诚实声明：磁盘上文件行数与任务描述不一致（QueryEngine.ts 实为 1295 行，任务称 1231；toolExecution.ts 实为 1745，任务称 1651；StreamingToolExecutor.ts 实为 530，任务称 481；toolOrchestration.ts 实为 188，任务称 179）。Magic Pointer `app/fabric/executors.py` 实为 1000 行（任务称 932 行 if/elif）。本笔记行号以磁盘实际为准。

---

## 1. QueryEngine 的职责（`src/QueryEngine.ts`）

### 1.1 类与生命周期
- `QueryEngineConfig`（:130-173）：一个对话一个 QueryEngine（:180-182 注释），`submitMessage()` 每次开启新一轮；`messages`（`mutableMessages`）、文件缓存、usage 跨轮保留。
- 构造（:200-207）：初始 messages、`abortController`、`permissionDenials: SDKPermissionDenial[]`、`readFileState`、`totalUsage`。

### 1.2 `submitMessage()` 主流程（AsyncGenerator，:209-1156）
1. **wrap canUseTool 追踪权限拒绝**（:244-271）：SDK 需要把每次 deny 记录成 `permissionDenials[]`（含 `tool_name`/`tool_use_id`/`tool_input`），随 result 消息上报。
2. **取 system prompt 三件套**（:284-300）：`fetchSystemPromptParts({tools, mainLoopModel, ...})` → `defaultSystemPrompt` / `userContext` / `systemContext`；SDK 自定义 prompt 时跳过默认 prompt（queryContext.ts:44-74）。
3. **组装 systemPrompt**（:321-325）：`customSystemPrompt ?? defaultSystemPrompt` + memoryMechanicsPrompt + `appendSystemPrompt`。
4. **结构化输出工具注册**（:327-333）：`jsonSchema && tools 里有 SyntheticOutput 工具` 时注册结构化输出强制（hook）。
5. **构造 `ProcessUserInputContext`（即 ToolUseContext 的超集）**（:335-395）：`messages`、`options`（commands/tools/verbose/mainLoopModel/thinkingConfig/mcpClients/mcpResources/isNonInteractiveSession/agentDefinitions/maxBudgetUsd…）、`getAppState/setAppState`、`abortController`、`readFileState`、`updateFileHistoryState`、`updateAttributionState`、`setSDKStatus`。
6. **孤儿权限处理**（:398-408）：一次会话只处理一次；`handleOrphanedPermission` 产出消息。
7. **`processUserInput`**（:410-428）：把 prompt 加工成 messages（slash 命令、attachment），返回 `{messages, shouldQuery, allowedTools, model, resultText}`；**allowedTools 被写回 `alwaysAllowRules.command`**（:476-486）。
8. **持久化 transcript**（:436-463）：进 query 循环**前**先把用户消息落盘（保证 kill 后可 resume）；bare 模式 fire-and-forget。
9. **重新构造 context**（:492-527）：slash 命令可能改了 model。
10. **yield `system_init` 消息**（:540-551）：SDK 侧先收到系统初始化。
11. **query 循环**（:675-1049）：`for await (const message of query({...}))`，对每类消息做 SDK 转换再 yield：
    - assistant/user/compact_boundary：push + 落盘 + ack（:688-751）
    - `stream_event`：usage 累计（message_start 重置、message_delta 累加、message_stop 入总账），**stop_reason 从 message_delta 捕获**（:788-816）
    - `attachment`：`structured_output` 提取（:838-840）、`max_turns_reached` 提前结束（:842-874）、`queued_command` 重放（:876-892）
    - `system`：compact_boundary 裁剪旧消息（:897-942）、`api_error` → `api_retry` 重试通知（:943-955）
    - **预算/上限检查**：`maxBudgetUsd`（:972-1002）、结构化输出重试上限（:1005-1048）
12. **结果判定与产出**（:1058-1155）：
    - `isResultSuccessful(result, lastStopReason)` 失败 → `error_during_execution`（:1082-1118），`errors[]` 带 `[ede_diagnostic] result_type=… last_content_type=… stop_reason=…` 前缀 + 本回合内存错误（watermark 实现回合作用域 :665-669）。
    - 成功 → `result` 消息：`result`（最后一段非合成 text）、`stop_reason`、`usage`、`total_cost_usd`、`permission_denials`、`structured_output`（:1135-1155）。

### 1.3 控制面方法
- `interrupt()`（:1158-1160）：`abortController.abort()` —— 整个 QueryEngine 只靠这一个信号。
- `getMessages()`（:1162-1164）：读 `mutableMessages`（会话内所有消息，含本轮）。
- `setModel(model)`（:1174-1176）：写 `config.userSpecifiedModel`，下一轮生效（下一轮 `parseUserSpecifiedModel`）。
- `ask()`（:1186-1294）：一次性便捷封装 —— 构造 QueryEngine，`yield* submitMessage()`，`finally` 里回写 readFileCache。snip 特性（HISTORY_SNIP）通过注入的 `snipReplay` 回调保持 QueryEngine 纯净（:1276-1284）。

### 1.4 `toolUseContext` 结构（`src/Tool.ts:158-300`）
关键字段：`options.tools/commands/mainLoopModel/mcpClients/isNonInteractiveSession`、`abortController`、`getAppState/setAppState`、`messages`、`readFileState`、`setInProgressToolUseIDs`（并发工具在途 ID，UI 用）、`setHasInterruptibleToolInProgress`、`toolDecisions: Map<toolUseID, {source, decision, timestamp}>`、`queryTracking: {chainId, depth}`、`agentId`、`requireCanUseTool`、`requestPrompt`、`updateFileHistoryState/updateAttributionState`、`preserveToolUseResults`、`contentReplacementState`（工具结果预算）。

### 1.5 对照与差距（MP）
| 项 | CC | Magic Pointer |
|---|---|---|
| 循环控制器 | QueryEngine 类 + async generator，SDK 逐消息 yield | `engine.py` 的 `plan()/execute()` 是请求-响应式，无逐消息流 |
| 权限追踪 | wrappedCanUseTool 累积 `permissionDenials` 随 result 上报 | `engine.py:720-721` HMAC 签名 + `:722-729` 确认 + `:730-756` TargetLease 实时校验（机制不同但同为执行前门禁） |
| 会话状态 | 类实例持有 mutableMessages/usage | MP 用 `AgentContextHandoffStore`/`ArtifactRegistry`/磁盘持久化 |
| 结论 | **借鉴**：MP 的 FabricEngine 已有 plan→execute 分离与签名/租约门禁；缺的是 CC 的"单轮消息流 + 权限拒绝结构化上报 + 预算/回合上限的软中断"模型。MP 若做 Harness 运行时，可仿 submitMessage 的生成器契约。 |

---

## 2. 工具执行全链路（model tool_use → 权限 → 执行 → tool_result 回灌）

### 2.1 主循环（`src/query.ts`）
1. **回合设置**（:545-568）：刷新 `toolUseContext.messages`；按 feature gate `tengu_streaming_tool_execution2` 决定用 `StreamingToolExecutor` 还是经典 `runTools`（toolOrchestration.ts）。
2. **调用模型**（:659-708）：`callModel({messages, systemPrompt, tools, …})` —— **工具 schema 是 API 的 `tools` 参数，不是 system prompt 文本**。
3. **流式消费 assistant 消息**（:826-845）：每收到含 `tool_use` 块的 assistant 消息：
   - 收集进 `toolUseBlocks`，置 `needsFollowUp = true`；
   - 若流式执行开启：立刻 `streamingToolExecutor.addTool(toolBlock, message)` —— **工具在模型还在吐字时就开始执行**（prefetch）。
4. **流式期间收割已完成结果**（:847-862）：`getCompletedResults()` 产出的 user 消息即时 yield 并 `normalizeMessagesForAPI` 后进 `toolResults`（:853-860）。
5. **流中断/降级清理**（:712-740, :893-953）：fallback 发生时把旧 assistant 消息 **tombstone**（无效签名会 400），重建 executor 防孤儿 tool_result。
6. **无 tool_use → 收尾**（:1062-1358）：stop hooks、token budget、max_output_tokens 恢复、reactive compact 等。
7. **有 tool_use → 执行**（:1380-1408）：`toolUpdates = streamingToolExecutor.getRemainingResults() ?? runTools(...)`；每条 update 的 message yield 给 UI/SDK 并 push 进 `toolResults`（API 格式）；`update.newContext` 更新回合上下文（contextModifier 生效点）。
8. **递归下一轮**（:1715-1727）：`state.messages = [...messagesForQuery, ...assistantMessages, ...toolResults]` —— **tool_result 以 user 消息形式回灌**；`while(true)` 直到不再有 tool_use（:1728）。
9. 大结果由 `toolResultStorage.ts` 持久化（见 §6.4）。

### 2.2 错误的结构化返回（模型可见层）
所有失败都变成 **`user` 消息里的 `{type:'tool_result', content, is_error:true, tool_use_id}`** 块，而不是抛异常中断回合：
- 工具不存在：`<tool_use_error>Error: No such tool available: X</tool_use_error>`（toolExecution.ts:396-409）
- 输入校验失败：`<tool_use_error>InputValidationError: …</tool_use_error>`（:664-679）
- `validateInput` 失败：`<tool_use_error>${message}</tool_use_error>`（:717-732）
- 权限拒绝：`content: errorMessage` + `is_error:true`，可附带图片块（:1029-1071）
- 执行异常：`<tool_use_error>Error calling tool (name): msg</tool_use_error>`（:469-489）
- 中断：`createToolResultStopMessage` + `CANCEL_MESSAGE`（:443-452）
- 模型侧看到的就是「这次调用失败的原因」，可自主重试/换法。

### 2.3 对照与差距（MP）
MP 的 `FabricExecutors.execute()`（executors.py:146-209）返回 `ExecutionReceipt`（status/output/verified/verification/undo/error），**不面向模型**；它服务于外部 Agent（handoff 场景），由 Agent 自己的运行时决定如何呈现。差距：MP 没有"模型调用工具"这条链路，也没有结构化 tool_result 词汇表 —— Harness 内建 Agent 时需新增 §7 的注册表与错误契约。

---

## 3. toolExecution.ts：`runToolUse` 的逐级细化

### 3.1 入口 `runToolUse`（:337-490）
1. 查工具：先查 `toolUseContext.options.tools`，未命中再查 `getAllBaseTools()` 按 **alias** 兼容旧名（如 KillShell→TaskStop）（:345-356）。
2. **不存在**：记日志/遥测 → yield `<tool_use_error>` user 消息（:369-411）。
3. 已 abort：yield cancel 消息（:415-453）。
4. 主体委托 `streamedCheckPermissionsAndCallTool`（:455-468）。
5. **外层 catch**（:469-489）：任何漏网异常 → `Error calling tool${toolInfo}: ${errorMessage}`。

### 3.2 `streamedCheckPermissionsAndCallTool`（:492-570）
`Stream<T>` 桥接：progress 回调实时 `stream.enqueue(progress 消息)`，Promise 结果 `.then(全部 enqueue)` / `.catch(stream.error)` / `.finally(stream.done)` —— 把"异步执行 + 进度回调"统一成 async iterable。

### 3.3 `checkPermissionsAndCallTool`（:599-1745）—— 固定的执行管线
1. **zod 解析**（:614-680）：`tool.inputSchema.safeParse(input)`；失败 → `formatZodValidationError`，若该工具是 deferred（ToolSearch 体系）且 schema 没发给过模型，追加 `buildSchemaNotSentHint`（:578-597，提示模型先 `ToolSearch "select:name"` 再重试）。
2. **`tool.validateInput(input, ctx)`**（:683-733）：工具自身的语义校验（如文件路径规则）。
3. **Bash 投机性分类器**（:740-752）：命令在 hooks/权限询问期间**并行**跑 allow 分类器。
4. **防御性剥字段**（:761-773）：Bash 的 `_simulatedSedEdit` 只允许权限系统注入。
5. **backfillObservableInput**（:784-793）：克隆输入回填派生字段给 hooks/权限看，**不污染**传给 `call()` 的原始输入（保 transcript 哈希稳定；:1189-1205 再收敛回模型原始值）。
6. **PreToolUse hooks**（:800-862，实现在 toolHooks.ts:435-650）：
   - `message`（progress/附件）、`hookPermissionResult`（allow/ask/deny）、`hookUpdatedInput`（透传改输入）、`preventContinuation`、`stopReason`、`additionalContext`、`stop`（中止本工具并产出 stop 消息）。
   - 慢 hook（>2s）记日志（:863-870）。
7. **权限决议 `resolveHookPermissionDecision`**（:921-929；toolHooks.ts:332-433）：
   - hook allow **不能绕过** settings.json 的 deny/ask 规则（checkRuleBasedPermissions 仍执行）；hook deny 直接拒绝；否则走 `canUseTool`（交互式弹窗/auto 分类器/规则表）。
   - headless 模式补发 `tool_decision` OTel 事件与 code-edit 计数器（:952-977）。
8. **拒绝路径**（:995-1104）：
   - `tool_result`(is_error) + 可选图片块（`permissionDecision.contentBlocks`，:1029-1062）；
   - auto 模式分类器拒绝时跑 **PermissionDenied hooks**，返回 retry=true 时给模型补一句"已获批准，可重试"（:1075-1101）。
9. **放行**（:1105+）：采用 `permissionDecision.updatedInput`（:1130-1132）。
10. **执行 `tool.call(callInput, {...toolUseContext, toolUseId, userModified}, canUseTool, assistantMessage, onProgress)`**（:1206-1222）：
    - 结果 `ToolResult<T> = {data, newMessages?, contextModifier?, mcpMeta?}`（Tool.ts:321-336）；
    - `structured_output` 结果转 attachment（:1272-1280）。
11. **结果映射**（:1292-1301）：`tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)` → `ToolResultBlockParam`（**缓存一次供 addToolResult 复用**，避免 hooks 改输出时重映射）。
12. **`addToolResult`**（:1403-1474）：组装 `[tool_result] + acceptFeedback + contentBlocks(图片)` → `createUserMessage({content, toolUseResult, mcpMeta, sourceToolAssistantUUID})`，并携带 `contextModifier`（仅非并发工具生效，Tool.ts:329 注释）。
13. **PostToolUse hooks**（:1483-1538；toolHooks.ts:39-191）：
    - **非 MCP 工具：tool_result 先进消息队列再跑 hooks**（:1477-1479）——hooks 改不了内置工具输出，只追加消息；
    - **MCP 工具：hooks 可以 `updatedMCPToolOutput` 替换输出，跑完才 addToolResult**（:1494-1497, :1540-1542）；
    - `preventContinuation` → `hook_stopped_continuation` 附件（:1572-1582）。
14. **成功收尾**（:1566-1588）：`result.newMessages` 追加；返回 `resultingMessages[]`。
15. **异常路径**（:1589-1737）：
    - `McpAuthError` → 把 MCP client 状态改 `needs-auth`（:1601-1629）；
    - `AbortError` 跳过日志（:1631）；
    - 跑 **PostToolUseFailure hooks**（:1700-1713）；
    - 最终 `createUserMessage({tool_result, is_error:true, content: formatError(error)})` + hook 消息（:1715-1737）；
    - `finally` 清理 session activity 与 toolDecisions（:1738-1744）。
16. **错误分类**（`classifyToolError` :150-171）：TelemetrySafeError / errno 码（ENOENT）/ 稳定 `.name` / `Error` / `UnknownError` —— 遥测安全。

### 3.4 hooks 插入点小结
| 钩子 | 位置 | 语义 |
|---|---|---|
| PreToolUse | 权限决议**前**（:800-862） | 可 deny/allow/ask/改输入/附加上下文/阻止继续 |
| PermissionRequest | 交互式权限弹窗 | hook 替用户回答 |
| PostToolUse | 工具成功**后**（:1483） | 追加消息；MCP 工具可改输出 |
| PostToolUseFailure | 工具抛异常**后**（:1700） | 追加消息 |
| PermissionDenied | auto 分类器拒绝后（:1081） | 可标记"已批准可重试" |
| Stop | 回合末（query.ts:1267） | 可阻止继续/注入阻塞错误 |

### 3.5 对照与差距（MP）
MP `hooks.py:build_hook_response`（:131-209）是对**外部 Agent**（Claude Code/Codex）的 adapter：只产出 `hookSpecificOutput.additionalContext` + `suppressOutput`（:203-208），本质是"上下文注入钩子"，没有工具级 Pre/Post 钩子。差距：MP 没有工具级 hook 模型；若 Harness 要跑内建 Agent，需把 `hooks.py` 的注入式 hook 扩展为 CC 的**决策式 hook**（能 deny/改输入/阻止继续）。

---

## 4. StreamingToolExecutor（`src/services/tools/StreamingToolExecutor.ts`）

### 4.1 核心状态机（:21-32, :40-62）
`TrackedTool {id, block, assistantMessage, status: queued|executing|completed|yielded, isConcurrencySafe, promise?, results?, pendingProgress[], contextModifiers?}`。构造时建 **siblingAbortController**（父 abort 的子控制器，:59-62）。

### 4.2 与普通执行（runTools）的差别
| 维度 | runTools（toolOrchestration） | StreamingToolExecutor |
|---|---|---|
| 触发时机 | 模型流式结束后，一次性拿全部 tool_use | 模型**流式过程中** `addTool()` 即排队（query.ts:842） |
| 未知工具 | 执行期发现 | addTool 时立即合成错误结果并标记 completed（:78-102） |
| 并行判定 | 输入解析失败 → 不并行（partitionToolCalls :98-108） | 同（:104-113） |
| 中断语义 | 无逐工具中断 | `interruptBehavior()`：`cancel`/`block`（:233-241）；用户新消息打断时只取消 cancel 类（:210-231） |
| 兄弟工具失败 | 无级联 | **Bash 工具出错 → siblingAbortController.abort('sibling_error')，其余并行工具收到合成错误**（:354-364, :189-205）——因为 Bash 命令常有隐式依赖链；Read/WebFetch 互不牵连 |
| 产出顺序 | 批内按完成顺序 | 保持**接收顺序**：completed 才 yield，且 non-safe 工具执行中时在它前面**停住**（:436-438）；progress 则立即 yield（:418-422） |
| contextModifier | 每步应用 | 仅 non-safe 工具支持，完成后应用（:388-395） |

### 4.3 关键机制
- `processQueue`（:140-151）：并发条件 `canExecuteTool`（:129-135）= 无执行中 或 自己并发安全且执行中全是并发安全 → 排队扫描。
- 每个工具一个 **child abort controller**（:301-318）：sibling error 级联杀子进程；权限弹窗拒绝会 bubble 回主 controller（保证回合终止）。
- `getRemainingResults`（:453-490）：`Promise.race(执行中 promise + progress 信号)` 等待，progress 到达即唤醒。
- `discard()`（:69-71）：streaming fallback 时废弃全部在途工具。

### 4.4 对照与差距（MP）
MP 无任何并行工具执行（所有 executor 是同步单发）。差距：CC 的"**流式到达即执行 + 并发安全分组 + Bash 级联失败**"模型对 Harness 意义重大 —— MP 的 `_agent`/`_model_text` 等长任务执行器未来可复用同一套排队/中断语义。

---

## 5. toolOrchestration.ts：并行/串行策略

### 5.1 分区（partitionToolCalls :91-116）
- 对每个 tool_use：`tool.inputSchema.safeParse(input)` 成功 且 `tool.isConcurrencySafe(parsedInput.data)` 为真 → 并发安全；解析抛异常则**保守按非并发**（:102-107）。
- **连续**的并发安全工具合并为一个批（:109-113），非并发工具单独成批 —— 关键约束是**保持调用顺序**（不重排）。
- 结果：`[{isConcurrencySafe, blocks}]` 序列，如 `[safe×3, unsafe, safe×2]`。

### 5.2 执行（runTools :19-82）
- 并发批：`runToolsConcurrently`（:152-177）用 `all(generators, getMaxToolUseConcurrency())`，默认并发上限 **10**（env `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，:8-12）；
  - 每个工具的 `contextModifier` 先**暂存**（:42-48），批完成后按 block 顺序应用到 `currentContext`（:54-62）—— 并发工具间不得依赖彼此修改的上下文。
- 非并发批：`runToolsSerially`（:118-150）逐个执行，每个 contextModifier 立即生效（:140-142）。
- `setInProgressToolUseIDs` 进入时 add、`markToolUseAsComplete` 结束删除（:127-129, :179-188）。

### 5.3 对照与差距（MP）
MP 的 CapabilityRegistry（capabilities.py:89+）只做能力匹配打分，没有任何并发调度。差距：MP 若引入多工具并行，应直接照搬"**isConcurrencySafe(input) 谓词 + 顺序保持 + 并发上限 + contextModifier 批后合并**"这四件套；同时把 `isConcurrencySafe` 做成工具契约字段而非隐式 if/elif。

---

## 6. 工具 schema 与 system prompt 注入

### 6.1 工具契约（Tool.ts:362-695）
每个工具是**对象字面量 + buildTool 默认值**（Tool.ts:707-792）：
- 必填：`name`、`description(input, options): Promise<string>`（**模型可见的长描述，动态生成**，:386-393）、`inputSchema`（zod，:394）、`call(args, ctx, canUseTool, parentMsg, onProgress)`（:379-385）、`isEnabled()`、`isConcurrencySafe(input)`、`isReadOnly(input)`、`prompt(options): Promise<string>`（工具在提示中的说明段）、`userFacingName`、`toAutoClassifierInput`、`mapToolResultToToolResultBlockParam(output, toolUseID)`（:557-560）、`maxResultSizeChars`。
- 可选：`aliases`（旧名兼容，:371）、`inputJSONSchema`（MCP 直供 JSON Schema，:397）、`validateInput`（:489-492）、`checkPermissions`（工具特定权限，:500-503）、`interruptBehavior(): 'cancel'|'block'`（:416）、`isDestructive`（:406）、`backfillObservableInput`（:481）、`getToolUseSummary`/`getActivityDescription`、`shouldDefer`/`alwaysLoad`（ToolSearch 体系，:442-449）、`strict`（:472）、`requiresUserInteraction`、`isMcp/isLsp`、渲染族方法（renderToolUseMessage 等，UI 用）。
- **默认值 fail-closed**：`isConcurrencySafe → false`、`isReadOnly → false`（Tool.ts:757-769）。

### 6.2 schema 如何变成 API 参数（api.ts:119-266）
- `toolToAPISchema(tool, options)` → `{name, description: await tool.prompt({...}), input_schema: zodToJsonSchema(tool.inputSchema) ?? tool.inputJSONSchema, strict?, eager_input_streaming?, defer_loading?, cache_control?}`（:157-230）。
- **会话级缓存**：base schema 按 `name`（或 `name:inputJSONSchema`）缓存，防止 GB 开关/描述漂移反复改字节（:147-152, :208）。
- 可选项：`strict`（模型支持时）、`eager_input_streaming`（fine-grained tool streaming，仅 firstParty API，:199-206）、`defer_loading`（ToolSearch 延迟加载）、`cache_control`（ephemeral）；`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 一刀切剥离非白名单字段（:243-260）。
- **工具列表不在 system prompt 里**：`callModel({tools: toolUseContext.options.tools, ...})`（query.ts:663）；system prompt 只有**用法说明**文本段（prompts.ts:569 `getUsingYourToolsSection(enabledTools)`，以及 :383 skill 用法、:522-526 结果摘要策略段）。
- 动态工具集：turn 间 `refreshTools()`（query.ts:1659-1671，MCP 新连接即刷新）。

### 6.3 MCP 工具
`mcp__server__tool` 命名（toolExecution.ts:283-301）、服务器类型 stdio/sse/http/ws/sdk 提取（:308-320）、`normalizeNameForMCP` 归一化比对；MCP 工具 schema 直供 `inputJSONSchema`。

### 6.4 大结果处理（toolResultStorage.ts:137-242）
超过 `getPersistenceThreshold(name, maxResultSizeChars)` 的结果**落盘**（`wx` 防重写，:162），模型收到 `<persisted-output>` 包装的路径 + 预览（:189-199）；Read 等工具设 `Infinity` 永不持久化（Tool.ts:462-466 注释）。顺带 `contentReplacementState` 做跨轮结果预算替换。

### 6.5 对照与差距（MP）
MP 的最近似物是 `RecipeDefinition`（schema.py:19-55：id/title/description/inputKinds/outputKind/providerStrategies/risk/verification/provider/minObjects/maxObjects/platforms）——**有描述、有 provider、有验证**，但没有：
- 参数级 input schema（zod/JSON Schema）—— 模型/调用方不知道要传什么参数；
- 工具对象契约（call/validate/权限/并发谓词/结果映射）；
- 动态描述（`prompt()` 可按权限模式/上下文生成）。
差距最大的一处。RecipeDefinition 应演进为 CC 式 ToolDef + Registry（见 §7）。

---

## 7. Python 工具注册表设计要点（从 CC 提取）

若 Magic Pointer 自建 Harness 工具执行层，把 `executors.py` 的字符串 if/elif 升级为注册表，建议契约（对齐 CC Tool.ts:362-695，但按 MP 现实裁剪）：

```python
@dataclass(frozen=True)
class ToolSpec:                       # 静态声明，一个模块一个
    name: str
    aliases: tuple[str, ...] = ()
    description: str | None = None    # 模型可见静态描述
    schema: type[BaseModel] | None    # pydantic input schema → JSON Schema
    provider: str | None = None       # MP 兼容：执行器归属（执行时仍按 provider 路由）
    max_result_chars: int = 200_000   # 超过落盘给预览
    concurrency_safe_default: bool = False   # fail-closed

class BaseTool:                       # 注册后由 registry 补默认值
    name: str
    aliases: tuple[str, ...]
    def prompt(self, ctx: ToolContext) -> str        # 动态长描述（可合并静态 description）
    def schema_json(self) -> dict                     # pydantic → JSON Schema（注册时缓存）
    def validate(self, input_: dict, ctx) -> None     # zod.parse 等价；失败抛 InputValidationError
    def validate_input(self, input_, ctx) -> None     # 工具级语义校验
    def check_permissions(self, input_, ctx) -> PermissionResult  # 工具特定
    def is_concurrency_safe(self, input_) -> bool
    def is_read_only(self, input_) -> bool
    def interrupt_behavior(self) -> str               # 'cancel' | 'block'
    async def call(self, input_, ctx, on_progress=None) -> ToolResult
    def map_result(self, output, tool_use_id) -> dict # → {type:'tool_result', tool_use_id, content, is_error}

class ToolRegistry:
    def find(self, name: str) -> BaseTool | None      # name + aliases
    def to_api_schemas(self, ctx) -> list[dict]       # 注入用 {name, description, input_schema}
```

**执行管线固定顺序**（对齐 toolExecution.ts:599-1745）：
1. `registry.find(name)` —— 未命中 → `{"is_error": True, "content": "<tool_use_error>Error: No such tool available: X</tool_use_error>"}`；
2. schema 校验失败 → `InputValidationError:` + 错误详情（含"schema 未发送给模型"提示）；
3. `validate_input` 失败 → 工具消息；
4. PreToolUse hooks（可 deny/改输入/附加上下文/阻止继续）；
5. 权限决议（hook allow 不绕过 deny 规则；headless 无 UI 时走规则表/分类器）→ 拒绝 → `is_error:true` + 拒绝原因；
6. `call()`（超时由工具实现，建议 per-tool timeout 字段）；
7. `map_result` → 超 `max_result_chars` 落盘 + 预览；
8. PostToolUse hooks（可追加消息；MCP 类可改输出）；异常 → PostToolUseFailure hooks → `is_error:true` 收尾。
9. **任何异常都返回结构化 tool_result，绝不把工具错误当成进程错误**。

**错误词汇表**（模型可消费，对齐 CC）：`No such tool available` / `InputValidationError` / 权限拒绝原因 / `Error calling tool (name): …` / 取消 `Cancelled: …`。

**并发调度**：照搬 partitionToolCalls —— 连续且 `is_concurrency_safe(input)` 的工具并批（上限默认 10），非并发工具独占串行；**保持模型调用顺序产出**；contextModifier 只支持非并发工具、批后按序应用。

**schema 注入**：工具 schema 走 API `tools` 参数（或等效协议字段），system prompt 只写用法说明；描述用 `prompt()` 动态生成、按会话缓存（防漂移）。

**与 MP 现状的映射**：
- `RecipeDefinition.provider` → 保留为"最终执行器"选择（MP 多 provider 策略仍有效），但**新增 schema 字段**（pydantic）补参数契约；
- `FabricExecutors.execute()` 的 if/elif（executors.py:146-209）→ 改 `ToolRegistry.find(provider).call(plan)`，分支语义（denied/unavailable/internal）保留为注册表内置工具；
- `ExecutionReceipt`（schema.py:125-149）→ 保留为**结果层**（verified/undo/audit 是 MP 特色，CC 没有），在它之上包一层模型可读的 `tool_result` 视图；
- `hooks.py:build_hook_response` → 保留外部 Agent 注入式 hook；内建 Agent 时新增 CC 式决策 hook（返回 deny/updatedInput/preventContinuation）。

**诚实的保留意见**：MP 的目标是"外部 Agent 汇聚 + 短任务"，不一定需要 CC 的完整 tool_use 回合协议（thinking 签名、ToolSearch defer、permission 弹窗、OTel 遥测、VCR 回放都是 CC 独有且可裁剪的）。建议最低移植面 = §7 注册表契约 + 固定管线 + 错误词汇表 + 并发批调度；流式执行（§4）与 SDK 消息流（§1）按 Harness 是否需要实时进度再决定。
