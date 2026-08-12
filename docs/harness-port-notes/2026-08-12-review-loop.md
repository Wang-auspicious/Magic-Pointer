# 循环实现对抗审查：loop.py vs Claude Code query.ts 状态机

- 日期：2026-08-12
- 审查者：只读对抗审查 agent（未改任何文件）
- 对照：`app/agent_runtime/loop.py`（736 行）、`types.py`、`errors.py`、`model_client.py`、`tests/agent_runtime_loop_test.py` vs `claude-code-main/src/query.ts`（1729 行）+ `src/services/tools/toolOrchestration.ts`（188 行，分区实现的实际来源）
- 诚实声明（读过的行）：query.ts 118-149、160-359、640-839、960-1084、1085-1305、1420-1539、1695-1729；**未直接读** 360-639（tool result budget/snip/microcompact/autocompact/blocking preempt）、840-959（streaming executor 接线）、1540-1694（attachment/prefetch/skills）——这些区域依赖移植笔记转述，审查结论不依赖它们。toolOrchestration.ts 全文读过。

---

## 1. State 整体重建 —— 通过（附一个结构性偏差）

- CC：`state = { ... }` 9 字段一次写全（query.ts:267-279 初始化、1099-1113/1152-1164/1207-1249/1283-1305/1321-1340/1715-1727 各 continue 点），注释明说"Continue sites write `state = { ... }` instead of 9 separate assignments"（267）。
- MP：所有状态变更都走 `with_transition`（loop.py:263/333/377/401/438/544），`with_transition` 用 `dataclasses.replace`（types.py:147-157），frozen dataclass，无一处直接 mutate。循环内 `messages = list(state.messages)` + append（loop.py:310/367/390/419/533）都是副本，原始 state.messages 不被触碰；`tool_calls_pending` 永远整覆写为 `[]`；`results`/`hook_notes` 是循环外局部变量（对应 CC taskBudgetRemaining 的"不进 State"技巧，query.ts:289-291）。初始构造 237-240 合法。
- 偏差（P2）：CC 编译器强制每个 continue 点写全 9 字段（漏字段 = 编译错）；MP 的 `dataclasses.replace` 只写被 override 的字段，其余静默携带。任何**未来新增的 TurnState 字段**都会自动跨 continue 携带，而 CC 会强制每个站点显式决策。目前无 bug（逐点核对过每个 continue 的字段集合），但这是结构性防错能力的退化。
- 修复建议：给 `with_transition` 加一个"必须显式列出全部 9 字段"的检查（或 lint 规则），恢复 CC 的编译期强制。

## 2. transition 语义 —— 问题（两个 continue 点原因缺失/错标，P1+P2）

MP 枚举（types.py:23-33）：TOOL_RESULT / TOOL_ERROR / MAX_OUTPUT_TOKENS_RECOVERED / COMPACT_TRIGGERED / STOP_HOOK / USER_INTERRUPT / BUDGET_EXHAUSTED / MAX_TURNS。CC 的 continue reason：collapse_drain_retry（1092）、reactive_compact_retry（1162）、max_output_tokens_escalate（1217）、max_output_tokens_recovery（1246）、stop_hook_blocking（1302）、token_budget_continuation（1338）、next_turn（1725）。

逐点核对 MP 的 6 个状态推进点：

| MP 站点 | 记录 reason | 对照 CC | 判定 |
|---|---|---|---|
| 333（withheld 恢复 continue） | MAX_OUTPUT_TOKENS_RECOVERED | max_output_tokens_recovery（1246） | ✓ 等价（CC 额外带 attempt 计数，MP 在 state 里 ✓） |
| 377（hook 出错后 continue） | `last_transition or TOOL_RESULT`（379） | stop_hook_blocking（1302） | **✗ 错标 P1**：继续的真正原因是 hook 异常，却记为上一轮的 tool 结果 |
| 438（截断 continue） | TOOL_RESULT | （Pi 特性，CC 无对应） | 可接受，但"没执行任何工具却记 tool_result"语义不实（P3） |
| 544（post-tool continue） | TOOL_ERROR/TOOL_RESULT（530-531） | next_turn（1725） | ✓ 等价 |
| 263（轮头） | 上一轮 reason 原样携带 | state.transition 读取（1092） | ✓ |

- **P1**：`COMPACT_TRIGGERED` 枚举成员（types.py:29）**从未被赋值**——compact_callback 触发完全不可在 transition 流中断言（CC 的 reactive_compact_retry 是独立 reason，1162）。测试 21 只能断言回调次数，断言不了 reason。
- **P1**：hook 出错 continue（377-389）记录的 transition 说谎——测试若断言"hook 出错轮"的 transition 会看到 TOOL_RESULT/TOOL_ERROR 而不是 stop-hook 原因。
- 未移植的 CC continue reason 里，collapse_drain_retry / token_budget_continuation / max_output_tokens_escalate 是明确的功能裁剪（笔记 §3.4/§5.3 声明；escalate 是 feature-gated，3P 默认 false），诚实 ✓。
- 修复建议：新增 STOP_HOOK_BLOCKING（hook 出错 continue 使用）并在 compact_callback 触发时赋值 COMPACT_TRIGGERED。

## 3. withhold-until-recover —— 问题（reason 被忽略 P1；delta 泄漏 P2；错误从不 surface P2）

- CC：流式内 `isWithheldMaxOutputTokens` 命中 → withheld=true **整个消息不 yield**（query.ts:820-825），仍 push 进 assistantMessages（826-827）；轮末 3 层恢复（escalate 1195-1221 → 恢复消息 1223-1252 → surface 1254-1255）；surface 后落入 `isApiErrorMessage` 分支**跳过 stop hooks** 返回 completed（1258-1265）。withheld 只针对 max_output_tokens / prompt_too_long / 媒体错误（799-822）。
- MP 客户层：TurnWithheld 透传 + 计数，永不 raise（model_client.py:167-171）✓；loop 层在 299 用 isinstance 检测，走恢复（300-345）✓。错误**不会提前 surface** ✓——但反过来也**从不 surface**：耗尽时（302-309）terminal 消息是合成文案，被扣住的原始错误内容永远丢失（CC 在 1255 会 yield lastMessage）。
- **P1**：loop.py 只按 `isinstance(TurnWithheld)` 检测，**从不读 `TurnWithheld.reason`**。而 AiClientBackend 把**一切**后端错误（auth/网络/超时）都映射成 `TurnWithheld(reason="backend_error:…")`（model_client.py:271-274）。结果：真实后端故障会被当作 max_output_tokens，注入 3 轮"Output token limit hit"恢复消息（语义错误），最多烧 3 次额外调用，最后以 `MAX_OUTPUT_TOKENS_RECOVERED` 终止——把网络错误误报成 token 耗尽。CC 对 API 错误是**直接** return completed / model_error，不进入恢复。
- **P2**：withheld 轮在检测（299）之前已经把 MessageDelta 逐段 yield 成 ModelChunk（292-297）——被扣住轮次的半截文本泄漏给了 UI。CC 整条消息扣住（823-825）。
- **P2**：客户层 `withheld_count` 累计但 loop 从不读它（loop 自己从 events 数，300）——死状态。
- 修复建议：loop 检查 `TurnWithheld.reason`——仅 `max_output_tokens`（或空）走 token 恢复；其余 reason 立即以独立 terminal（如 MODEL_ERROR）surface；恢复路径把扣住的文本并入 terminal.message。

## 4. 防死循环三件套 —— 通过（2/4 完整，2/4 等价但方式不同）

1. **recovery 上限 3**：✓ errors.py:13 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3`；loop.py:301 `recovery > LIMIT` 终止（count 1/2/3 恢复、第 4 轮终止，与 CC 1240/1253-1256 行为逐轮对齐）。测试 15/16 覆盖 ✓。
2. **hasAttemptedReactiveCompact 单次守卫**：✓ loop.py:328-331 只触发一次 compact_callback；恢复 continue（333-342）和 hook 出错 continue（377，未 override）都保留该标志（对齐 CC 1292-1297 的"禁止重置"注释）。**P2 偏差**：CC 在正常 next_turn **重置** `hasAttemptedReactiveCompact: false`（1721）；MP 的 post-tool continue（544）不重置——同一 loop 内正常轮之后再次 withheld 时 MP 不再 compact，CC 会再试一次。语义差异是"MP 欠 compact"，不构成死循环。
3. **transition.reason 去重**：CC 用它 gate collapse drain 重试（1092 `state.transition?.reason !== 'collapse_drain_retry'`）。MP 没有 collapse drain，无对应站点——但**模式本身未移植**：loop.py 全文没有任何一处读取 state.transition 来 gate 重试（grep 确认）。MP 的所有重试路径由显式上限兜底（recovery cap / max_turns / stop_hook_active），逐路径推演后**未发现无界循环**。P2 观察项：未来新增重试路径时缺少 CC 的"transition 原因去重"惯用法。
4. **API 错误跳过 stop hooks**：✓ 行为等价——withheld 轮在 hook 检查（348）之前 continue（345），耗尽路径（302-309）也直接终止不进 hooks（对齐 CC 1168-1172 的 death-spiral 注释）。MP 无显式 `is_api_error` 谓词（CC 1258-1262），等价性**隐式**依赖 TurnWithheld 路由——这正是第 3 条 P1 的脆弱面：一旦有人把非 withheld 错误消息塞进正常路径，hook 防护不成立。

## 5. maxTurns 与 Terminal —— 通过（results 保留 ✓，turns 差一 P2）

- 终止检查位置：MP 429（截断路径）/502（post-tool 路径）`turn_number + 1 > max_turns`；CC 1704-1712（轮尾）+ 1506-1513（abort 时）。两处边界行为一致（第 N 轮执行完、若 N+1 超限则终止）。natural-answer 路径两方都**不查** max_turns（CC 1357 在轮尾检查之前 return；MP 347-416 同理）✓。withheld 恢复 continue 两方也都绕过 max_turns 检查 ✓（与 CC 一致）。
- **P2**：报告的轮数差一。CC 返回 `turnCount: nextTurnCount`（1709-1711，超限的下一个轮号）；MP `Terminal.turns = turn_number`（506-507，当前轮）。测试 19 行断言 `turns == 2`（max_turns=2）——CC 会报 3。仅影响展示/遥测，不影响控制流。
- results 保留：✓ 所有 7 个终止点都 `results=tuple(results)`（259/276/306/362/412/434/507），测试 5（max_turns）、6（budget）、13（cancel 前）覆盖。

## 6. 事件流完整性 —— 问题（reason 词汇混用 P1，这是本次审查最重的发现）

- 事件映射：LoopStart/TurnStarted↔stream_request_start（CC 337，MP 246/269 ✓）；ModelChunk↔assistant 消息（CC 823-825）；ToolCallStarted/Finished↔tool updates（CC 1384-1393）；LoopStopped 承载 Terminal（CC 的 return 值双通道，PEP 525 迫使改道，loop.py:209-216 已声明）✓。缺失的 CC 事件：max_turns_reached attachment（1509/1706）、aborted 中断消息（1047-1049）、post-compact 消息（530-532）、tool use summary（1058）——前两者 P2（UI 收不到"轮数到顶"通知，只有 LoopStopped），后两者是功能裁剪（诚实）。
- **P1：Terminal.reason 与"最后一次 continue 的原因"混用**。MP 的自然完成 `completion_reason = last_transition or TOOL_RESULT`（loop.py:400-410），而 CC 的自然完成永远是 `return { reason: 'completed' }`（1357）。后果（被我们自己的测试固化了）：
  - 测试 14（463 行）：三轮后自然完成，terminal.reason == **TOOL_ERROR**——成功结果被标成"工具错误终止"。
  - 测试 15（716 行）：恢复成功后自然完成，terminal.reason == **MAX_OUTPUT_TOKENS_RECOVERED**——这个名字读起来是"恢复耗尽=失败"，实际是成功恢复的完成。
  - 反方向：loop.py:33-39 文档指引"`reason not in {MAX_TURNS, BUDGET_EXHAUSTED}` 视为完成"会把真正的失败（恢复耗尽的 MAX_OUTPUT_TOKENS_RECOVERED、STOP_HOOK 否决、USER_INTERRUPT）误判为完成。
- 误判矩阵（消费方按 reason 判定时）：TOOL_ERROR → 把成功当失败；MAX_OUTPUT_TOKENS_RECOVERED → 成功/失败二义（区分不了"恢复后完成"与"恢复耗尽"）；STOP_HOOK / USER_INTERRUPT → 按文档指引被当完成，按直觉是终止。
- 修复建议：Terminal.reason 与 last_transition 解耦——新增 `TransitionReason.COMPLETED`（对齐 CC 'completed'），自然完成一律用它，last_transition 只活在 TurnState 上。

## 7. 并发语义 —— 问题（分区顺序与 CC 不等价 P2；输入相关安全判定缺失 P2）

- CC 真实实现（toolOrchestration.ts:91-116）：`partitionToolCalls` 按**连续游程**分批（isConcurrencySafe 相邻合并、不安全工具单独成批），批间保持输入交错；并发批跑 `all(..., 10)`（152-177，上限 env 可配）。例：`[safe1, seq1, safe2]` → safe1 单独并发批 → seq1 串行批 → safe2 并发批，**safe1 与 safe2 不重叠**。
- MP（loop.py:455-463 + tool_registry.py:233-248）：稳定分区——**所有** safe 工具进一个并发批、**所有** unsafe 进一个串行批，且并发批整体先跑（465-500）。`[safe1, seq1, safe2]` → (safe1 ∥ safe2) 然后 seq1：**结果消息顺序从 CC 的 c1,c2,c3 变成 c1,c3,c2**（模型可见的工具结果顺序不同），且 safe1/safe2 在 MP 重叠执行而 CC 不重叠。测试 13（614-664）只有 1 safe + 1 seq，测不出这个差异。
- **P2**：isConcurrencySafe 在 CC 是**输入相关谓词**（toolOrchestration.ts:97-108，解析失败/抛异常 → 保守 false）；MP 是 spec 上的静态 bool（tool_registry.py:95）——表达不了"按参数决定是否并发"。
- 错误传播 ✓：工具层永不抛（execute_tool 包装，tool_registry.py:274-293），ActionFailure 透传，仅 CancelledError 从 worker 冒泡（loop.py:697-702），`future.result()` 顺序读回（614）与串行路径一致 ✓。取消时已提交任务跑完（drain，对齐 CC 1019-1029 先消费剩余结果）✓——但 CC 边 drain 边 yield 合成 tool_result（1021-1023），MP 在 `shutdown(wait=True)` 里**静默阻塞**直到最慢工具结束，期间不产出任何事件（P2）。
- 修复建议：改成游程分区（保留输入交错）并让并发批与串行批按原调用顺序交错；drain 期间给每个完成的 future yield ToolCallFinished。

## 8. 资源 —— 通过（主资源 ✓，三处泄漏/阻塞 P2/P3）

- ThreadPoolExecutor：每批新建、`with` 保证所有出口（含异常）`shutdown(wait=True)`（loop.py:607-614）✓ 无泄漏。
- CancellationScope：loop_scope 包住整个 while（248），正常 return / CancelledError 传播 / 生成器 aclose 都会走 `__exit__` 注销 token（cancellation.py:128-135）✓。
- **P2 泄漏**：cancellation.py:133-134 对**已取消**的 token **不注销**（设计注释 100-101）——每次取消运行/取消的工具子 scope 都向 registry 永久留一条记录，长生命周期下 `active_count` 和内存无界增长。
- **P2 阻塞**：aclos e 或取消发生在并发批执行期间时，executor 的 `shutdown(wait=True)` 在事件循环线程同步阻塞到最慢工具结束。
- **P3**：backend 生成器在 `generate_turn` 中途抛异常时（model_client.py:164-172 无 try/finally）只靠 CPython 引用计数 GC 触发 close，无显式关闭。
- 修复建议：已取消 token 也在 `__exit__` 注销（保持 registry 设计的话至少加容量上限）；并发批取消路径把等待挪到 worker 线程。

---

## 汇总

**P0 数量：0**。未发现无界循环、状态被绕过 with_transition 直接篡改、或安全门禁完全失效的路径（hooks 仍在门位上、恢复上限在、错误不提前 surface）。

### 必须修（P1，4 项）

1. **Terminal.reason 与 last_transition 混用**（§6）：自然完成可能标成 TOOL_ERROR（测试 14 自证）或 MAX_OUTPUT_TOKENS_RECOVERED（测试 15 自证），失败也可能被文档指引误判为完成。→ 新增 COMPLETED reason，自然完成专用。
2. **TurnWithheld.reason 被忽略**（§3）：AiClientBackend 的 backend_error 会走 max_output_tokens 恢复路径，误报 token 耗尽、白烧 3 轮调用。→ 按 reason 路由，非 token 错误立即 surface 为独立 terminal。
3. **hook 出错 continue 的 transition 错标 + COMPACT_TRIGGERED 永不赋值**（§2）：transition 流对测试/消费方说谎。→ 加 STOP_HOOK_BLOCKING / COMPACT_TRIGGERED。
4. **stop hooks 拿到的是陈旧 state**（§2/§6 交叉）：MP 在追加本轮文本之前就跑 hooks（loop.py:348-389），hook 评估不到它本该把关的模型回答（CC 传 messagesForQuery+assistantMessages，1267-1276）；且 513 的 post-tool hook 调用是 CC 没有的（CC 只在 !needsFollowUp 评估）。→ 先拼消息再跑 hook；post-tool 钩子改到自然回答边界。

### 次修（P2，按重要性）

- 分区改为游程批、保持调用交错（§7）；取消后 drain 期间 yield 事件而不是静默阻塞（§7/§8）。
- 已取消 token 的 registry 注销/上限（§8）。
- max_turns 的 turns 报值对齐 CC 的 nextTurnCount（§5）。
- 取消时抛 CancelledError vs CC 返回 aborted_streaming/aborted_tools 终端的差异已文档化，但会打破"events[-1] 必为 LoopStopped"的消费约定（§6）。
- withheld 轮的 ModelChunk 泄漏与耗尽时错误内容丢失（§3）。
- stop_hook_active 粘性差异：MP 在 post-tool 路径自动复位，CC 永久粘住 → 失效 hook 每两轮重进一次（§1/§4 观察，已推演无死循环）。
- hasAttemptedReactiveCompact 在正常轮不重置 → 同一 loop 内二次 withheld 不再 compact（§4）。
- 测试缺口：无测试覆盖 hook 输入陈旧性、非 token TurnWithheld 路由、游程交错顺序；测试 14/15 反而把 reason 混用固化为预期。

### 附注

- loop.py:33-39 的文档指引本身有误（把 STOP_HOOK/USER_INTERRUPT/MAX_OUTPUT_TOKENS_RECOVERED 归为"完成"），随 P1-1 一起改。
- `with_transition` 的 replace 语义与 CC"每 continue 写全字段"的编译器强制的差距（§1）建议用 lint 规则补。
- 诚实缺口：query.ts 360-639 / 840-959 / 1540-1694 三区段未直接读，审查未依赖它们；transitions.js 不在泄露版（移植笔记已声明），Terminal 精确字段系推断。
