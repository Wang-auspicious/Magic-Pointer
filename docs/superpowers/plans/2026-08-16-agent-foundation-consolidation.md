# Agent 地基融会贯通重构计划（2026-08-16）

> 目标：把 Pi / Claude Code / DSH / Hermes 四个优秀 agent 的地基能力，用最少代码融进
> `app/agent_runtime`，同时削掉本项目拼凑期留下的死代码。只动底层（Python 侧
> agent 核心），不动视觉前端。
> 执行方式：测试先行、每批独立可验证、及时 git 提交。

## 一、四源码审计结论（差距从哪来）

### Pi（external/pi，最干净的范本）
- `agent-loop.ts`（~790 行）：**纯 turn 状态机**。事件流（agent_start/turn_start/
  message_end/turn_end/agent_end）；**steerQueue + followUpQueue 两条输入队列**，轮间
  drain；`prepareNextTurn` 钩子在轮边界做 compaction/换模型；截断的工具调用整批
  失败（不执行残缺参数）。
- `agent-harness.ts`：单类编排 session + tools + 队列 + 类型化事件钩子（钩子可返回
  结果改写行为）；phase 机（idle/turn/compaction/branch_summary/retry）。
- session = **append-only JSONL 条目联合**（message / model-change / active-tools-change
  / compaction / branch-summary / leaf 指针）。折叠条目 → 上下文。树形分支导航。

### Claude Code（claude-code-main）
- `Tool` 契约按**调用**分级：`isReadOnly(input)` / `isDestructive(input)` /
  `isConcurrencySafe(input)` / `interruptBehavior()` / `inputsEquivalent`（幂等）/
  `searchHint`（ToolSearch 延迟加载的关键词）。
- `StreamingToolExecutor`：并发安全工具并行、独占工具成栅栏、结果按模型原序提交、
  bash 出错联动 abort 兄弟子进程。
- auto-compact 带 warning/error 双阈值与跨压缩预算账（taskBudgetRemaining）。

### DSH（deepseek-harness）
- `ReactLoopAgent`：**session 日志是唯一真值**（每个请求由日志派生，重放=重建）；
  `Inbox` 带 target（`next-step`=steer / `next-turn`=followup / inject），在
  turn/step 边界 claim；phase 机（idle/maintenance/running），maintenance 相位跑
  压缩等任务且 wake 可 latch；`dispatch.waterfall` 插件可在任意边界拦截。
- 权限=sandbox×approval 双旋钮+预设（已对齐，见 08-16 前批）。

### Hermes（HermesAgent）
- 反面教材：conversation_loop.py 5562 行巨石（MP 的 loop.py 1633 行正在走同一条路）。
- 正面语义：`iteration_budget`（线程安全 consume/refund + 一次 grace call）；
  `verification_stop`（**turn 结束验证门**：改了代码想直接收工、又没有新鲜验证
  证据时，注入一次有界 nudge，再想停才放行；纯 policy 不自己跑检查）；
  `/steer` 在 pre-API 边界注入到最后一个 tool 消息（保角色交替）。

### 社区调研（docs/research/2026-08-15-agent-community-real-needs.md）
P0 痛点里本项目缺的：**"用户在等待 Agent 时继续输入，输入被吞"**（option2ghost，
四家源码全都有 steer/follow-up，MP 只有 kill-only 的 interrupt_check）；**"结果不能
靠模型一句完成了"**（Hermes 验证门 + Receipt；MP 有动作级验证、无 turn 级停门）；
**"最少代码"**（无引用的认知核四模块 ~760 行是纯死重）。

## 二、MP 现状结构判定

- 已达标：tool scheduler（DSH rolling-pool 已移植）、ToolSpec 契约（缺按调用分级）、
  session 日志+turn 租约+崩溃修复、事件化 async-generator loop、find_capability
  延迟加载、效果表权限门（08-16 已接 DSH 预设）。
- **G1 输入模型缺失（最重）**：`interrupt_check` 只能杀；无 steer/followup 队列，
  无 step 边界 drain，无排队续跑。
- **G2 死代码**：`app/agent_runtime/{event_loop,surprise,assertion_memory,
  model_surface}.py` 零生产引用（仅互相引用+自己的测试）；另有 12 个包内 re-export
  嫌疑模块需符号级核实。
- **G3 无 turn 端验证门**：模型改完就想停、没有验证证据时直接放行。
- **G4 工具效果按工具不按调用**：同一工具的不同入参可以有不同后果
  （CC 的 isDestructive(input)）。
- 非目标（本轮不做）：session 树形分支导航、maintenance 相位、多进程 steer 传输
  （需常驻 agent 进程，另批）。

## 三、批次

### Batch A：死代码清除（先减后加）
1. 删 `event_loop.py` / `surprise.py` / `assertion_memory.py` / `model_surface.py`
   + `tests/cognitive_engine_test.py`（git 里有历史，需要时可复活）。
2. 符号级核实 12 个嫌疑模块（package `__init__` re-export 是否有真实消费者），
   只删零消费者的，逐个记录。
3. 验证：全量 Python/Node/typecheck；提交。

### Batch B：Inbox——steer/followup 输入模型（G1，四家合一的最小版）
新模块 `app/agent_runtime/inbox.py`（目标 ≤200 行，Pi queue + DSH target 语义）：
- `InboxTarget = "next-step" | "next-turn"`；`Inbox.put(msg, target)` /
  `drain(target) -> list[AgentMessage]`；线程安全；空/溢出策略明确。
- loop 接线：
  - 每轮 step 开头 drain `next-step`（steer 注入为本轮消息，Pi/Hermes 语义）；
  - 模型停后 drain `next-turn`（followup 开新轮，Pi 外循环语义）；
  - `interrupt_check` 保留为硬停（语义不同：cancel ≠ steer）。
- `LoopParams` 增 `inbox`；事件 `Steered(turn, text)` / `FollowupQueued(text)`。
- 测试：steer 在下一轮可见；followup 停后续跑；空 inbox 零开销；
  steer 不破坏角色交替（注入为 tool 结果或独立 user 消息按位置）。
- 验证 + 提交。

### Batch C：turn 端验证门（G3，Hermes verification_stop 模式）
新模块 `app/agent_runtime/turn_verification.py`（纯 policy，≤150 行）：
- 输入：本 turn 的工具调用轨迹（effect 分级）+ 是否有 verify_result 通过的回执。
- 策略：有过 REVERSIBLE_WRITE+ 且无新鲜验证证据、模型想以 completed 收尾 →
  第一次拒绝并注入一条有界 nudge（"先验证再收工"），第二次放行（防死循环）；
  纯读 turn 不拦；nudge 次数入 Terminal 记录。
- loop 在 stop 判定处接一道；测试覆盖：改后未验证被拦一次、验证过放行、
  纯读不拦、nudge 只一次。
- 验证 + 提交。

### Batch D：工具效果按调用分级（G4，CC 契约）
- `ToolSpec` 增可选 `effect_for: Callable[[dict], Effect] | None`；
  注册校验；loop 的权限门与 scheduler 的 classify 统一改走
  `spec_effect(spec, args)` 帮助函数（默认回落静态 effect）。
- 现有 18 工具不动（全部回落静态档）；只为后续需要按参数分级的工具开门。
- 测试：注册校验、回落、effect_for 覆盖静态档。
- 验证 + 提交。

### Batch E：loop.py 瘦身收尾
- 把 B/C/D 的接线从 loop.py 内联块收敛为小函数/模块边界；loop.py 只保留
  turn 状态机本体（目标 <1200 行，不追求一步到位）。
- 全量 fresh 验证（Python/Node/typecheck/ESLint）+ STATUS/设计文档账本 + 提交。

## 四、验收

- 全量：`python -m pytest tests/ -q`、`tsx scripts/run-node-tests.ts`、
  `npm run typecheck`，全绿。
- 行为：steer/followup 有单测钉住；验证门有单测钉住；死代码删除后无悬挂引用。
- 诚实边界：跨进程 steer 传输（Studio 对话中途插话）不在本计划——需要常驻
  agent 进程，另立批次。
