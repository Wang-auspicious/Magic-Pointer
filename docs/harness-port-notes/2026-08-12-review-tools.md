# 工具注册表移植审查（2026-08-12）

- 日期：2026-08-12
- 审查方式：只读对抗审查（未运行任何测试，未修改任何文件）。行号以磁盘实际为准。
- 对照材料：
  - 实现：`app/agent_runtime/tool_registry.py`（320 行）、`app/agent_runtime/loop.py` 工具执行段
  - 移植笔记：`docs/harness-port-notes/2026-08-12-cc-tool-execution.md`
  - CC 原始：`claude-code-main/src/services/tools/toolExecution.ts`（1745 行，笔记 §0 已诚实声明与任务描述不符）、`toolOrchestration.ts`（188 行）
  - 测试：`tests/agent_runtime_tool_registry_test.py`、`tests/executors_tool_registry_migration_test.py`
- 诚实声明：本次为纯静态审查。并发线程池行为、`Effect` 无执行点等结论基于代码路径遍历，未运行验证。

---

## 1. 固定执行管线：钩子位覆盖审查

**结论：部分移植，缺 3 类钩子 + 2 个旁路；缺钩子对本批次可接受，记 P2 建议。**

CC 固定管线（toolExecution.ts）：zod safeParse（:614-680）→ validateInput（:683-733）→ 投机分类器/剥字段/backfill（:740-793）→ PreToolUse hooks（:800-862）→ 权限决议 canUseTool（:921-929，拒绝路径 :995-1104）→ call（:1206-1222）→ 结果映射（:1292-1295）→ PostToolUse hooks（:1483-1538）→ 异常 → PostToolUseFailure hooks（:1700-1713）→ is_error 收尾。

我们的覆盖（对照 mapToolResult 与移植笔记 §7 的九步）：
| CC 步骤 | 我们的落点 | 状态 |
|---|---|---|
| 查工具（含 alias 兜底） | `loop._execute_one` KeyError → 结构化 TOOL_ERROR（loop.py:677-686）；**无 alias 兼容**（tool_registry.py 无 aliases 字段） | 通过（alias 可裁剪） |
| zod 解析 | `validate_input`（tool_registry.py:203-231，loop.py:687-696） | 通过（差距见第 5 项） |
| validateInput 语义校验 | **无 per-tool 语义校验钩子**（ToolSpec 无该字段） | 缺位 → P2 |
| backfill / 剥字段 | 无（fabric 工具无此需求） | 可裁剪 |
| PreToolUse hooks | **无**（loop 只有回合级 stop_hooks，非工具级） | 缺位 → P2 |
| 权限决议 canUseTool | **无**（见第 3 项，P1） | 缺位 → **P1** |
| call + 超时 | `execute_tool`（tool_registry.py:250-293）；timeout_ms 字段**声明但从未实施**（ToolSpec:97，任何地方未读） | 部分 |
| 结果映射 | `_normalize_result`（loop.py:706-729，evidence_to_text） | 通过；**无 maxResultSizeChars/落盘**（CC toolResultStorage，移植笔记 §6.4）→ P2 |
| PostToolUse / PostToolUseFailure hooks | **无** | 缺位 → P2 |

判定：对当前批次（无工具级 hook 系统、执行器均为短同步方法），缺 Pre/Post hooks 可接受，**记 P2 建议**（后续批次在 `_execute_one` 前后插入钩子位即可，接口已隔离）。但 `timeout_ms` 完全无效是诚实的失败：声明了 CC per-tool timeout（移植笔记 §7 第 6 步）却没有实施者——工具跑死时 loop 只能靠外层 CancellationScope 中断，且 `_execute_one` 中 cancellation 检查是**执行后**（loop.py:701-702），超时工具无法按时报 TOOL_ERROR。

## 2. 错误回灌语义

**结论：核心通过（is_error + error_message 完整到模型），但信息"干巴巴"，3 处丢失。**

- 通过：`execute_tool` 错误路径永远返回 ToolResult 而非抛异常（tool_registry.py:279-292），格式 `Error calling tool ({name}): {exc}` 对齐 CC :473/:480；`loop._normalize_result` 把 error_message 并入 value（loop.py:716-719），`AgentMessage.is_error` 置位（loop.py:481/498），模型能读到"这次为什么失败"。ActionFailure 的 failure_type 透传到 types 层（loop.py:726）。
- 问题 1（P2）：`ActionFailure.recovery_hint`（errors.py:36）在 `execute_tool` 的 error_message 构造里被丢弃（tool_registry.py:284/291 只拼 `str(exc)`），`failure_type` 也不进消息文本——"能教会模型怎么办"的部分只剩裸异常串。建议：`f"Error calling tool ({name}): {exc} (type={failure_type}{', hint: ' + hint if hint})"`。
- 问题 2（P2）：未采用移植笔记 §2.2/§7 的错误词汇表——消息无 `<tool_use_error>` 包装、validate 失败无 `InputValidationError:` 前缀（loop.py:691 是裸 "; ".join(errors)）、未知工具是 `unknown tool 'x'` 而非 CC `No such tool available: x`。模型自愈能力不受阻，但忠实度打折。
- 问题 3（P2）：模型参数 JSON 损坏时 `_normalize_call` 记入 `last_errors` 并丢弃该调用（model_client.py:294-323），**loop 从不读 `last_errors`**（loop.py 全文无引用）——调用静默消失，模型无任何反馈（CC 会回 InputValidationError tool_result 让模型自愈），可能浪费回合重发同样坏参数。

## 3. 权限语义

**结论：不通过——Effect 分级从未被执行。P1。**

- `Effect` 枚举（tool_registry.py:68-76）只在注册时校验存在（:143-146）。全仓 grep：`.effect` 除注册外**零消费点**；loop 的执行路径（loop.py:454-500）不查 effect，`execute_tool`（tool_registry.py:250-293）不查 effect。模型直接调用 `agent_handoff`/`background_task`/`map_route`/`task_route`（全部 EXTERNAL_SEND）时**没有任何门禁**。
- CC 的对应机制：`resolveHookPermissionDecision` + `canUseTool`（toolExecution.ts:921-929），hook allow 不绕过 settings deny（移植笔记 §3.3 第 7 步）——我们没有 canUseTool 的任何等价物。引擎旧路径的 HMAC/租约门禁（移植笔记 §1.5）是 plan/execute 外部 Agent 路径，`run_agent_turn`→`run_agent_loop` 自由循环路径不经过它。
- 判定：**P1（当前 batch 范围外但必须点名）**。建议一句话：在 `_execute_one` 与 `execute_tool` 之间插入 effect→permission 决议层（头 3 回合可先落地"EXTERNAL_SEND/DESTRUCTIVE/PURCHASE 需要显式 allow 白名单"的最小门禁），Effect 字段才有存在意义。

## 4. 并发分区

**结论：问题——[safe, unsafe, safe] 交错时丢失 CC 的批次顺序语义；并发与保序本身通过。**

- CC（toolOrchestration.ts:91-116）：连续 safe 合并一批，unsafe 单独成批，**批序列保持调用顺序**——输入 [safe1, unsafe, safe2] 执行序为 safe1→unsafe→safe2；移植笔记 §5.1 明确"关键约束是保持调用顺序（不重排）"。
- 我们（tool_registry.py:233-248 + loop.py:454-463）：拆成 `(parallel, sequential)` 双列表，loop **先跑完全部 parallel 再跑 sequential**（loop.py:465-500）。同输入下执行序变成 safe1→safe2→unsafe——unsafe 工具被挪到 safe2 **之后**。副作用顺序与模型可见的 tool_result 消息顺序（loop.py:475-483/492-500 按此追加）都偏离 CC。对本批工具（写=unsafe、参数回合内固定）无实际数据依赖，故记 **P2**；一旦出现跨调用依赖（后调用的参数依赖先调用结果）升 P1。
- 通过项：执行是真并发（ThreadPoolExecutor，loop.py:606-614，workers=min(n,4)，CC 默认 10）且结果按 submit 顺序读回（:614），批内消息保序；未知工具名 fail-closed 退回全串行（loop.py:456-459）。分区粒度：CC 的 `isConcurrencySafe(input)` 是输入相关谓词（:99-107，解析失败保守非并发），我们的是静态 bool——`clipboard_history` 这类"默认读、带 digest 即写"的工具无法表达（见第 7 项 P1）。
- 修复建议（P2）：把分区改成 CC 式连续批序列 `list[Batch(is_safe, names)]` 并按批顺序执行，或至少在 loop 里按"safe 批→unsafe→safe 批"逐批交替。

## 5. schema 契约

**结论：问题（P2）——坏参数能穿过 validate_input 进 execute；N 层校验缺失。**

- 通过：顶层 missing required / extra field / 类型检查齐全（tool_registry.py:215-231），extra field 拒绝对齐 CC strictObject（toolExecution.ts:757-759 注释）；bool 不算 int（:304-305）；未知 type 名 fail-open 返回 None 不检查（:316）——可接受。
- 问题 1（P2）：**无嵌套校验**——`"array"` 只查 `isinstance(list)`（:310-311），`items` 被忽略；`"object"` 只查 dict（:312-313），内层 properties 不校验。`objects=[{}]`、`objects=[{"id":123}]` 均通过 validate_input，随后 `_fabric_tool_plan` **静默丢弃非 dict 元素**（executors.py:1070-1073）——坏参数确实进到了 execute 层（以"数据被悄悄删掉"的方式），zod 会直接拒。修复：validate_input 递归检查 items/properties。
- 问题 2（P2）：`validate_input` 对非 dict args 抛 TypeError（tool_registry.py:210-211），而 `_execute_one` 只捕 KeyError（loop.py:677）——该异常若冒出会杀死整个 loop。当前不可达（`_normalize_call` 强制 dict，model_client.py:294-323），但作为公开 API 是脚枪。修复：改为返回错误列表而非抛异常。
- 问题 3（P2）：无 per-tool 语义校验钩子（同第 1 项）。

## 6. ToolResult 双类型转换

**结论：通过，无模型可见信息丢失；1 处结构性丢失（P2 备注）。**

- `_normalize_result`（loop.py:706-729）：error 时 value=error_message（模型唯一文本通道），`failure_type`（StrEnum→str，types.py:78）与 `used_backend`/`latency_ms` 原样保留；Evidence 经 `evidence_to_text` 渲染（:734-735）——对齐 CC mapToolResultToToolResultBlockParam 的一次映射语义。
- 丢失点：`recovery_hint` 在 tool_registry.py:284/291 就已不进 error_message（同第 2 项问题 1），双类型转换本身无额外丢失。registry 层 `value: Any` → types 层 `value: str` 的收窄由 `_result_value_text` 兜底（:732-736，None→""）——通过。

## 7. 注册质量（18 个动作逐个点名）

**结论：1 个 P1 级错误映射，2 个可疑项，其余诚实。**

| 工具 | effect/并发 | 判定 |
|---|---|---|
| clipboard_history | **READ + concurrency_safe=True** | **P1**：`_clipboard_history` 自带写路径——带 `digest` 即恢复剪贴板（executors.py:373-378 自述 "Restoring is a write"，:382-399 实施）；静态 READ+safe 把一个能写全局剪贴板的工具标成只读可并行。CC 此场景由 `isReadOnly(input)`/`isConcurrencySafe(input)` 输入相关谓词表达。修复：加 input 相关判定或降为 REVERSIBLE_WRITE+sequential。 |
| screen_translate | READ + safe | 可疑（P2）：不落盘不改底层 app，但渲染 overlay 是用户可见副作用、且耗模型（backend="model", 60s）；CC 语义下 "read-only" 指不改变数据，勉强成立。建议注释确认或标 REVERSIBLE_WRITE。 |
| task_route | EXTERNAL_SEND | 可疑（P2）：写的是**本地**任务库（executors.py:1438-1441），标 EXTERNAL_SEND 是高估，但方向保守（宁高勿低）不构成风险；若按 honest 报告应改 LOCAL_IRREVERSIBLE。 |
| ocr_copy / ocr_clean | REVERSIBLE_WRITE | 通过（剪贴板覆盖丢失旧内容，但 clipboard_history 可恢复，reversible 可辩护；P2 备注即可）。 |
| rewrite/translate/expand/condense | REVERSIBLE_WRITE | 通过（描述诚实：write-back 需 action proposal，本步只产 artifact）。 |
| summarize_route / to_spreadsheet / merge_tables / evidence_card / image_to_prompt | REVERSIBLE_WRITE | 通过（落盘 artifact，可删，方向保守）。 |
| map_route | EXTERNAL_SEND | 通过（浏览器深链，15s）。 |
| agent_handoff / background_task | EXTERNAL_SEND | 通过（启动外部 Agent，120s 合理）。 |
| memory_recall | READ + safe | 通过（只读本地屏忆）。 |
| 并发标记总检 | 仅 3 个 READ 为 True，11 个写全 False | 通过（除 clipboard_history）。 |
| used_backend | ocr_clean 标 "ocr"（方法 `_clipboard`） | 通过（实际干活的是 OCR+剪贴板），诚实度可辩护。 |

## 8. 幂等与全局单例

**结论：注册幂等性通过；生产接线缺口 P1，静默跳过与无重置机制 P2。**

- 通过：`ToolRegistry.register` 拒绝重名（tool_registry.py:134-135）；`register_fabric_tools` 幂等——已存在则跳过（executors.py:1511-1515），测试覆盖（migration test:160-165）。
- **P1（生产接线缺口）**：全仓 `register_fabric_tools` 只在测试中调用；没有任何 app 模块向 `GLOBAL_REGISTRY` 注册。`run_agent_turn` 默认用 `GLOBAL_REGISTRY`（engine.py:877），生产自由循环实际以 **0 个工具**运行——模型只能纯文本回答，18 个工具从未进 loop。engine.py:897-898 注释说"本模块不注册"，但接线方不存在。修复：app 入口（或 engine 初始化）调一次 `register_fabric_tools(GLOBAL_REGISTRY)`。
- P2：`register_fabric_tools` 静默跳过会掩盖同名冲突——未来两条 recipe 撞同名工具名时第二条无声消失（无 warn）。建议 skip 时告警。
- P2：GLOBAL_REGISTRY 无 unregister/reset 且跨测试常驻——当前测试都自建 registry（迁移测试:127-136），污染未爆发，但任何后续往 GLOBAL_REGISTRY 注册的测试都会污染进程内其他测试。建议测试不碰单例（现状正确）+ 文档明示。

## 附：测试缺口（非审查项，顺带点名）

- 无 [safe, unsafe, safe] 交错顺序语义测试（第 4 项问题未被捕获）。
- 无 timeout_ms 无效性测试（第 1 项）。
- 无 GLOBAL_REGISTRY 污染/生产接线测试（第 8 项）。
- migration 测试断言了 effect 映射本身（test_effect_concurrency_backend_mapping），但测试数据与实现同源（同一个表），无法发现 clipboard_history 的语义错标。

---

## P0 / P1 清单

**P0：无。**

**P1：**
1. 权限门禁缺失（第 3 项）：`Effect` 分级声明但不执行，模型可直接调用 EXTERNAL_SEND 工具。修复：`_execute_one`/`execute_tool` 间插入 effect→allow 白名单决议层。
2. `clipboard_history` 映射错误（第 7 项）：能写剪贴板的工具标 READ + concurrency_safe=True（executors.py:1468-1486 vs :382-399）。修复：digest 存在时按写处理（输入相关谓词或降级标记）。
3. 生产接线缺口（第 8 项）：`GLOBAL_REGISTRY` 从未被 app 代码填充，默认 loop 0 工具（engine.py:877；register_fabric_tools 仅测试调用）。修复：app 入口注册一次。
