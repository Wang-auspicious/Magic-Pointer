# MPAgentRuntime：循环 Harness 实施计划（评审批次 1）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。每个 Batch 独立 swarm，Batch 内 agent 严格文件隔离，禁止越界改文件。
>
> **依赖计划**：`docs/superpowers/plans/2026-08-11-frame-lease-foundation.md`（已完成，Phase A）。
> **评审依据**：`docs/harness-gap-review-20260812.md` L1（Agent Loop）+ L2（感知即工具）。
> **移植笔记**（B1 已产出，先读再动手）：
> - `docs/harness-port-notes/2026-08-12-cc-query-loop.md`（queryLoop 状态机）
> - `docs/harness-port-notes/2026-08-12-cc-tool-execution.md`（工具编排/执行管线）
> - `docs/harness-port-notes/2026-08-12-cc-budget-stop.md`（预算与停止）
> - `docs/harness-port-notes/2026-08-12-pi-agent-loop.md`（Pi 循环对比）
> - `docs/harness-port-notes/2026-08-12-kimi-cu-tools.md`（Kimi CU 工具契约）
>
> **源码依据**：`C:\Users\zjz65\PycharmProjects\claude-code-main\src`（2026-04 泄露版）+ `D:\AI_Agents\pi\packages\agent\src`。

## Goal

把 `app/fabric/engine.py` 的单 tool call 分类器执行替换为真正的 agent 循环（L1），感知开成模型可调用的工具（L2），recipe 从"路由目的地"重定位为"循环的预编译缓存"（JIT：recipe 是缓存，循环是解释器）。

## Architecture 决策（已冻结）

1. 循环语言 Python（`app/agent_runtime/`）：工具/模型/感知全在 Python，零桥接；Electron 只做 UI/手势。
2. 循环结构照搬 CC `query.ts` queryLoop：不可变 params + 可变 State 单对象 + 每轮 destructure + continue 整体赋值 + `transition` 记录 + turnCount + maxTurns。
3. 工具注册表照搬 CC：name / description / inputSchema / effect / execute / isConcurrencySafe；取代 executors 巨型 if/elif。
4. recipe = 预编译轨迹：L0 命中 → 构造首轮消息+工具清单 → 仍走循环（带轨迹）；未命中 → 空轨迹自由循环。L0/L1/L2 路由器退役为轨迹编译器。
5. 感知即工具（L2）：read_around / dump_subtree / find_in_window / list_windows / get_focused / look / describe_capabilities。look 是显式视觉逃生舱。
6. 失败类型一等公民：stale_anchor / focus_lost / content_changed / blocked_by_modal / permission_denied / timeout / tool_error，结构化回灌（is_error tool_result）。
7. 预算/取消/证据契约接入：每轮检查 `app/governance/latency_budget.py`；CancellationScope 代际淘汰；感知工具返回走 `app/evidence/` 契约。
8. 从移植笔记提取的关键机制全部落地：State 整体重建+transition（CC）、withhold-until-recover（CC）、恢复防死循环三件套（CC）、工具失败 is_error 回灌（CC）、固定执行管线 PreToolUse→canUseTool→call→PostToolUse（CC）、并发按 isConcurrencySafe 分区（CC）、token 软预算+收益递减（CC）、stopHooks 回合网关（CC）、steering/follow-up 双层队列（Pi）、prepareNextTurn 换档（Pi）、截断消息 tool call 作废（Pi）、used_backend 诚实上报（Kimi CU）。

## Non-goals

WGC/D3D、常驻 UIA 宿主、L3-L7 安全批次、UI 改动、ai_client.py 协议层改造（只包适配）。

---

## Batch 1：源码移植研究（只读）——✅ 已完成 2026-08-12

- [x] B1.1 `query.ts` 全文 → queryLoop 状态机笔记
- [x] B1.2 `QueryEngine.ts` + `toolExecution.ts` + `StreamingToolExecutor.ts` + `toolOrchestration.ts` → 工具编排笔记
- [x] B1.3 `tokenBudget.ts` + `stopHooks.ts` + `config.ts` + `deps.ts` → 预算与停止笔记
- [x] B1.4 Pi `agent-loop.ts` + `agent.ts` + `harness/agent-harness.ts` → Pi 循环对比笔记
- [x] B1.5 Kimi CU `kimiCu.ts` + 插件包 → Kimi CU 工具契约笔记
- [ ] **T1.0 提交 B1 成果**：`git add docs/harness-port-notes/ && git commit -m "docs: port notes from claude-code and pi harness sources"`

## Batch 2：循环内核（swarm：B2.1/B2.2 并行 → B2.3 → B2.4）

### Task 2.1：契约先行（types.py + errors.py）

**Files:** 创建 `app/agent_runtime/__init__.py`、`app/agent_runtime/types.py`、`app/agent_runtime/errors.py`；创建 `tests/agent_runtime_types_test.py`

- [ ] **Step 1** 读移植笔记 cc-query-loop.md §State/transition + cc-tool-execution.md 错误词汇表；写失败测试：`AgentMessage`（user/assistant/tool）、`ToolCall`（id/name/arguments dict）、`ToolResult`（tool_call_id/is_error/value）、`TurnResult`、`TransitionReason`（枚举：tool_result/tool_error/max_output_tokens_recovered/compact_triggered/stop_hook/user_interrupt/budget_exhausted）、`TurnState` dataclass 字段集（对齐 CC State 9 字段：messages/tool_use_context/auto_compact_tracking/max_output_tokens_recovery_count/has_attempted_reactive_compact/max_output_tokens_override/pending_tool_use_summary/stop_hook_active/turn_count/transition）
- [ ] **Step 2** 运行测试观察失败（`python -m pytest tests/agent_runtime_types_test.py -q --basetemp .pytest-swarm-b21`）
- [ ] **Step 3** 实现 types.py（frozen dataclass + from_dict/to_dict 往返）+ errors.py（`ActionFailure` 带 failure_type 枚举 + message + recovery_hint；失败类型：stale_anchor/focus_lost/content_changed/blocked_by_modal/permission_denied/timeout/tool_error；`is_retryable()` 判定）
- [ ] **Step 4** 测试转绿；`TransitionReason` 语义对齐 CC transition（注：CC 未泄露 transitions.js，按使用点反推语义，笔记已标注）
- [ ] **Step 5** 提交：`git commit -m "feat: define agent loop contracts"`

### Task 2.2：工具注册表（tool_registry.py）

**Files:** 创建 `app/agent_runtime/tool_registry.py`；创建 `tests/agent_runtime_tool_registry_test.py`

- [ ] **Step 1** 读 cc-tool-execution.md 固定执行管线 + 注册契约 + kimi-cu-tools.md 工具契约；写失败测试：`ToolSpec`（name/description/input_schema/effect[read|reversible_write|local_irreversible|external_send|destructive|purchase]/is_concurrency_safe/used_backend/execute）、`ToolRegistry.register/get/list/schemas_for_model()`、schema 校验（缺 name/schema 非 dict 拒绝）、重复注册拒绝、effect 与 execute 存在性校验、`validate_input(spec, args)` 严格报错
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现（参考 CC zod→JSON Schema 思路，用纯 dict schema + 自写校验器，不引第三方）
- [ ] **Step 4** 转绿；`schemas_for_model()` 输出对齐 CC API tools 参数格式（name+description+input_schema）
- [ ] **Step 5** 提交：`git commit -m "feat: add tool registry with schema and effect contracts"`

### Task 2.3：循环模型客户端（model_client.py）

**Files:** 创建 `app/agent_runtime/model_client.py`；创建 `tests/agent_runtime_model_client_test.py`

- [ ] **Step 1** 读 cc-tool-execution.md（流式/错误）+ 现有 `app/ai_client.py` 的调用方式（`ask_text_model` 签名、usage 返回）；写失败测试：`AgentModelClient` 协议（`generate(messages, tools, budget) -> ModelTurnEvent` 生成器：on_message_delta/on_tool_call/on_usage/on_done）、注入假模型后端（返回预置 tool_calls 序列）、解析 `function_calls` 风格的 arguments JSON、malformed tool_calls 不炸、usage 透传、`max_output_tokens` 截断信号→ `withheld` 事件（对齐 CC withhold-until-recover）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现：包 `ai_client`（只读使用，不改它）；工具以 `tools=[{name,description,parameters}]` 传入；对不支持 tools 参数的后端（纯文本模型）→ 返回 `unsupported` 事件（诚实，不发假请求）
- [ ] **Step 4** 转绿
- [ ] **Step 5** 提交：`git commit -m "feat: add loop model client adapter"`

### Task 2.4：循环本体（loop.py）——本批核心

**Files:** 创建 `app/agent_runtime/loop.py`；创建 `tests/agent_runtime_loop_test.py`

- [ ] **Step 1** 写失败测试（对齐 CC queryLoop 语义，全部注入假模型+假工具，不碰网络）：
  1. 多 tool call：模型一轮返回 2 个 tool call → 串行执行 → 结果回灌 → 模型再答 → 结束
  2. 工具失败（ActionFailure time out）→ is_error=True 回灌 → 模型可见错误原因
  3. 并行执行：两个 is_concurrency_safe=True 的工具并发；False 的串行保序
  4. maxTurns 达到 → `TurnResult.reason=max_turns`，已产生结果不丢
  5. transition 记录：每轮 State 的 transition.reason 正确（tool_result / tool_error）
  6. 取消：循环中 cancel_all_in_flight() → 生成器抛 CancelledError（代际淘汰）
  7. 预算：elapsed 超 FULL_ANSWER 预算 → 返回 budget_exhausted 且不再调用模型
  8. 恢复防死循环：max_output_tokens withheld 连续 3 次 → 终止；compact 后不再重试同原因
  9. 截断消息的 tool call 作废（Pi StreamFn 守卫）：不执行、重发
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现 `run_agent_loop()` 异步生成器（照 query.ts:219-345 结构：params 冻结 → State 初始化 → while True → destructure → yield stream_request_start → 模型调用 → tool 执行 → state 整体重建 + continue；Terminal 用 return 值）；接入 `app/governance/cancellation.py` + `latency_budget.py`；接入 stopHooks 网关（回合结束统一出口：blocking_errors / prevent_continuation）
- [ ] **Step 4** 转绿；跑 `python -m pytest tests/agent_runtime_loop_test.py -q --basetemp .pytest-swarm-b24`
- [ ] **Step 5** 提交：`git commit -m "feat: add agent loop interpreter"`

## Batch 3：感知即工具（L2，swarm：B3.1 与 B3.2 并行 → B3.3）

### Task 3.1：结构化感知工具

**Files:** 创建 `app/agent_runtime/perception_tools.py`；创建 `tests/agent_runtime_perception_tools_test.py`

- [ ] **Step 1** 写失败测试（注入假 grounding 后端，不碰真实桌面）：
  - `read_around(anchor, radius)`：anchor 上下文扩展读，返回多段文本+来源（走 Evidence 契约）
  - `dump_subtree(anchor, depth)`：结构化子树，深度限制，循环防深
  - `find_in_window(pattern)`：窗内查找，返回位置列表（无命中 → empty_confirmed，不是空值）
  - `list_windows()` / `get_focused()`：环境自省
  - 工具描述与 schema 注册进 ToolRegistry（可被 schemas_for_model 列出）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现：复用 `app/grounding/`（只读引用，不重构）；返回值统一 `Evidence`（status/confidence/source/container_hint）；busy/timeout 与 empty_confirmed 严格区分（L6 契约）
- [ ] **Step 4** 转绿
- [ ] **Step 5** 提交：`git commit -m "feat: expose structured perception tools"`

### Task 3.2：视觉逃生舱 look + describe_capabilities

**Files:** 修改 `app/agent_runtime/perception_tools.py`（B3.1 之后合并）；创建 `tests/agent_runtime_look_tool_test.py`

- [ ] **Step 1** 写失败测试：`look(anchor, box)`：裁剪框由 anchor 决定（不传全屏）；注入假视觉后端（成功/失败/超时三态）；失败 → `Evidence(status=timeout|error)` 而非抛异常；成本可归因（返回 latency_ms + used_backend）；`describe_capabilities(target)`：返回该目标类型可做的动作清单（来自轨迹缓存+工具目录，3-8 个）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现：包 `app/vision/` + `ai_client.ask_vision_model`（只读引用）；无视觉模型配置时 → `unsupported` 证据 + 恢复提示（对齐 CC 诚实失败）
- [ ] **Step 4** 转绿
- [ ] **Step 5** 提交：`git commit -m "feat: add look escape hatch and capability discovery tools"`

## Batch 4：recipe 重定位 + 执行器工具化（与 Batch 2/3 串行，最敏感）

### Task 4.1：recipe → 预编译轨迹（recipe_cache.py）

**Files:** 创建 `app/agent_runtime/recipe_cache.py`；创建 `tests/agent_runtime_recipe_cache_test.py`

- [ ] **Step 1** 读 `data/recipes/builtin.recipes.json` 结构 + `app/fabric/intent_router.py` 现状；写失败测试：`compile_trajectory(recipe_id)` → `Trajectory`（首轮 user 消息模板 + 推荐工具清单 + 约束 max_turns/min_objects + risk）；39 个 recipe 全部可编译（遍历内置文件断言）；未知 id → None（诚实失败，不是空轨迹）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现：recipe 数据只读；轨迹只描述"怎么起步"，不决定成败
- [ ] **Step 4** 转绿
- [ ] **Step 5** 提交：`git commit -m "feat: compile recipes into loop trajectories"`

### Task 4.2：intent_router 退役为轨迹编译器

**Files:** 修改 `app/fabric/intent_router.py`；修改 `tests/intent_router_test.py`（若存在）

- [ ] **Step 1** 读现有 L0/L1/L2 测试与调用方（`app/fabric/engine.py`、`agent_sessions.py`）；写失败测试：新入口 `route_to_trajectory(text, objects)` 返回候选轨迹列表（0..n 个，含置信度），关键词匹配逻辑保留但输出变为轨迹候选
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现：保留旧函数签名（兼容旧调用方），内部新增 `compile_trajectory` 路径；L2 兜底从"强行走 recipe"改为"返回 None → 循环自由发挥"
- [ ] **Step 4** 转绿（旧测试不得破坏）
- [ ] **Step 5** 提交：`git commit -m "refactor: demote intent router to trajectory compiler"`

### Task 4.3：executors 工具化迁移（一次 ≥10 个高流量动作）

**Files:** 修改 `app/fabric/executors.py`；创建 `tests/executors_tool_registry_migration_test.py`

- [ ] **Step 1** 读 executors.py 结构（约 1000 行 if/elif）；选 ≥10 个高流量动作（text.ocr_copy / text.rewrite_in_place / text.translate_in_place / text.summarize_route / selection.expand / selection.condense / table.to_spreadsheet / clipboard.history / screen.translate / image.to_prompt / agent.handoff 等）；写失败测试：每个动作注册为 ToolSpec 且 execute 行为与旧分派一致（对照旧函数调用）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现：把对应 if/elif 分支改写为 `ToolRegistry.register` 条目，内部仍调旧函数体；effect/used_backend 如实声明
- [ ] **Step 4** 转绿：迁移动作单测 + 旧路径单测（未迁移的 29 个 recipe 行为不变）
- [ ] **Step 5** 提交：`git commit -m "refactor: register high-traffic actions as tools"`

### Task 4.4：engine.py 改造（循环薄封装）

**Files:** 修改 `app/fabric/engine.py`；创建 `tests/engine_loop_backcompat_test.py`

- [ ] **Step 1** 写失败测试：旧入口（如 `plan_from_model` 调用方）行为兼容——单 tool call 快路径走轨迹直接执行（低延迟）；复合意图（测试样例："把这些材料写成回复，翻译成英文，填入微信"）走循环多轮完成；旧签名返回结构不变（fabric_bridge 无感）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现：engine 内部 `run_turn()` = 轨迹命中 → 循环跑轨迹约束；未命中 → 自由循环；预算/取消透传
- [ ] **Step 4** 转绿：`agent_runtime` 全测试 + `engine` 相关旧测试
- [ ] **Step 5** 提交：`git commit -m "refactor: route fabric engine through agent loop"`

## Batch 5：接线与验证（swarm）

### Task 5.1：预算/取消/证据契约真实接入

**Files:** 修改 `app/agent_runtime/loop.py`、`app/agent_runtime/perception_tools.py`；创建 `tests/agent_runtime_governance_test.py`

- [ ] **Step 1** 写失败测试：循环每轮检查 latency_budget（超预算轮不调模型）；CancellationScope 包裹模型调用与工具执行；取消后无新模型调用；感知工具返回值全部通过 Evidence 校验（非法状态拒绝）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现接线
- [ ] **Step 4** 转绿
- [ ] **Step 5** 提交：`git commit -m "feat: wire budgets, cancellation and evidence into loop"`

### Task 5.2：端到端集成测试

**Files:** 创建 `tests/agent_runtime_fabric_integration_test.py`

- [ ] **Step 1** 写失败测试：假模型驱动多轮循环完成复合任务"圈选段落 → 扩写 → 翻译 → 写回"（工具链 read→expand→translate→deliver，每步验证 tool_result 回灌顺序与 used_backend 记录）
- [ ] **Step 2** 运行观察失败
- [ ] **Step 3** 实现（若缺口来自产品代码则修复，否则证明测试写错）
- [ ] **Step 4** 转绿
- [ ] **Step 5** 提交：`git commit -m "test: end-to-end agent loop integration"`

### Task 5.3：全量回归与基准

**Files:** 创建 `scripts/benchmark_agent_loop.py`；修改 `docs/STATUS.md`、`docs/design/MAGIC_POINTER_HARNESS_20260811.md`

- [ ] **Step 1** 写基准脚本：N 轮假模型循环，报告每轮工具数/延迟 p50/p95/取消命中/预算超限次数/used_backend 分布
- [ ] **Step 2** 运行：`npm test` + `npm run typecheck` + `npm run lint` + 全量 pytest（basetemp 唯一）+ 基准脚本；记录真实数字，失败如实列
- [ ] **Step 3** 更新 STATUS.md（新能力行 + 全量数字）与设计账本（批次 1 完成记录 + 下批次 L3-L7 计划待写）
- [ ] **Step 4** 提交：`git commit -m "test: verify agent loop foundation"`

## Batch 6：对抗审查（swarm 只读审查 → 修复批）

- [ ] **T6.1** 审查 agent A：逐行对比 `loop.py` ↔ `query.ts`（状态机/transition/withhold/防死循环）
- [ ] **T6.2** 审查 agent B：逐行对比 `tool_registry.py` ↔ `toolExecution.ts`/`toolOrchestration.ts`（管线/错误/并发）
- [ ] **T6.3** 审查 agent C：39 个 recipe 轨迹 ↔ 原 L0/L1/L2 行为逐一对账
- [ ] **T6.4** 修复批：按审查意见修复 + 复跑全量回归
- [ ] **T6.5** 提交：`git commit -m "fix: address adversarial review of loop port"`

## Plan self-review checklist

- [ ] 每个生产行为有前置失败测试（TDD）。
- [ ] 循环与旧 engine 签名兼容，fabric_bridge 无感切换。
- [ ] recipe 快路径行为零回归（39 个 recipe 遍历断言）。
- [ ] 工具结果失败类型结构化回灌，循环可重试/换路径。
- [ ] 预算/取消/证据契约真实接入，非摆设。
- [ ] look 裁剪框由锚点决定；成本可归因。
- [ ] 移植笔记含行号引用；照搬/借鉴/改写标注清晰。
- [ ] 不启动 Electron UI；文档区分自动化/基准/真机验证。
- [ ] 每 Batch 结束及时提交；未验证不声称完成。
