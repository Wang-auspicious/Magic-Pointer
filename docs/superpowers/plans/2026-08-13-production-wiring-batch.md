# 批次 4（生产接线批）实施计划 — 2026-08-13

> 状态：本计划由 v4pro 审查修复回合顺带启动；已完成部分见 §3。
> 原则：测试先行；动生产代码的每一项先有红测试；真机路径没有验证前不得宣称完成。

## 1. 目标

把评审批次 1–3 落地的基础设施接进真实生产链路，同时保留旧路径的等价回退能力：

1. fabric_bridge / selection_bridge 的命令路径可走 `run_agent_turn` 循环。
2. 模型客户端支持 messages 协议多轮历史（不再单 prompt 拍平）。
3. 写回工具挂满四道 guard（前置断言 / 人类批准 / undo 补偿 / egress 门）。
4. Phase B/C：WGC/D3D 捕获后端 + 常驻 UIA 宿主（单独子批次，见 §6）。

## 2. 已完成的切片（本回合，均有测试）

### 2.1 循环基建修复（P0/P1 审查修复，与批次 4 直接相关）

- `engine.run_agent_turn` 默认时钟改为毫秒（`time.monotonic()*1000`），新增 `budgets` / `allowed_effects` 参数；`BUDGET_EXHAUSTED` 生产可达。
- `run_agent_turn` 处理 `LocalActionCandidate`（Terminal 增加 `LOCAL_ACTION` reason 与 `local_action` 字段）——"截图/复制这个"不再掉进自由循环。
- 恢复消息 `injected=True` 白名单 + 循环每轮 `validate_messages` 自检。
- 模型健康文件按 endpoint 分条；视觉分类拒绝不再写健康状态。

### 2.2 messages 协议多轮客户端

- `app/agent_runtime/model_client.AiClientMessagesBackend`：native messages 数组（chat-completions 与 messages 协议自适应），assistant 轮次保留角色；tool 结果投影为 user 条目（诚实说明：loop 状态尚不存 assistant tool_calls，无法用 API 原生 tool role）。
- 预算→HTTP timeout；超时不毒化端点健康；错误/熔断 → `TurnWithheld(backend_error:...)`。
- 测试：`tests/agent_runtime_ai_backend_test.py`（5 项，stub httpx，无真实网络）。

### 2.3 循环回答接线（opt-in）

- `app/fabric/loop_answer.terminal_to_answer`：Terminal → 桥回答形状（含 loopReceipts 审计字段）。
- `scripts/selection_bridge._loop_answer`：`MAGIC_POINTER_LOOP_ANSWER=1` 时 ACT_TOOLS 路径先跑循环（READ-only 工具），失败/空答案/本地动作一律回退旧单发路径；写 recipe 仍走旧 plan/confirm/receipt。
- 测试：`tests/loop_answer_test.py`（4 项）、`tests/selection_bridge_test.py`（5 项）。

## 3. 未完成切片（顺序执行，每项测试先行）

### T4.1 关闭 opt-in：selection_bridge 默认走循环

- 前置：T4.4 guard 接线完成后才允许默认开启；当前保留 `MAGIC_POINTER_LOOP_ANSWER=1`。
- 任务：路由层加白名单（哪些 command 形态走循环，哪些仍走单发）；`loopTerminated` 回退策略（预算耗尽 → 单发补答）补测试。
- 验收：真机 3 个 L2 长尾命令（问答/对比/生成）输出 `route.action=model_loop`，且写回类命令仍出现确认卡。

### T4.2 loop 状态记录 assistant tool_calls

- 目标：`TurnState.messages` 里 assistant 消息携带 tool_calls 与 id，TOOL 结果用 API 原生 `role=tool` + `tool_call_id` 回传（消除 2.2 的投影限制）。
- 改动：`types.AgentMessage` 增 `tool_calls` 字段；`loop.py` 在 tool 执行前把 calls 记录进 assistant 消息；`AiClientMessagesBackend._message_entry` 输出原生 role。
- 测试：messages 数组含 assistant tool_calls 与 role=tool 结果，两端 id 一致。

### T4.3 流式模型客户端

- `LoopModelClient` 已吃事件流；新增 streaming 后端（httpx stream + SSE 解析），`ModelChunk` 逐块 yield。
- 测试：假 SSE 流逐块事件顺序。

### T4.4 写回工具挂四道 guard（关键安全切片）

- `ToolSpec.preconditions` 已有；缺生产 `precondition_context_factory`：
  1. Anchor 解析（`app/anchor` 已有）+ 前置四断言（exact/focused/content/无弹窗）。
  2. `ActionApproval`：EXTERNAL_SEND/DESTRUCTIVE 效果工具在 execute 前 `requires_approval` → 人类批准；approver 黑名单已就位。
  3. `UndoLog.record`：写回工具 execute 成功后记录补偿；`spec.compensate` 已挂 4 个写回动作。
  4. `EgressGate.assert_allowed`：external_send 效果工具必经 egress；data 来源需 explicit_approval。
- 任务：新增 `app/action_guard/guard_factory.py`（生产上下文工厂，注入真实 probe），`run_agent_turn` 增加 `precondition_context_factory`/`approval`/`undo_log`/`egress` 注入参数；`selection_bridge` 接线。
- 验收（真机）：WeChat/记事本「填入」类命令 → 重获 anchor → 批准卡 → 写回 → 读回校验 → undo 可用。

### T4.5 fabric_bridge 循环入口

- fabric_bridge 目前只做 settings/agent/session 等操作；T4.4 后把 `run_agent_turn` 作为 bridge 的 `command.answer` 操作暴露给 Electron 主进程，与 selection_bridge 共用 `terminal_to_answer`。
- 测试：bridge 级集成测试（fake 后端 + fake registry）。

## 4. WGC/D3D 捕获后端（Phase B，独立计划）

- 前置读：`docs/REFERENCE_PROJECTS_20260810.md` 的 Everywhere/Kimi CU 条目；`external/everywhere` BSL 1.1 只读思路。
- 步骤：CaptureProvider 接口 → WGC window capture 实验脚本（单窗口、free-threaded frame pool、staging texture）→ 与 `frame_capture_worker.py` 协议对齐（source=wgc-window）→ overlay 排除实测（WDA_EXCLUDEFROMCAPTURE）→ benchmark p50/p95/max/成功率。
- 验收门槛：pointerup→freeze p95 ≤ 30ms；`overlayExcluded` 由实测结果决定，不再无条件声明。

## 5. 常驻 UIA 宿主（Phase C，独立计划）

- 前置读：`docs/archive/research/2026-08-04-what-uia-actually-exposes.md`。
- 步骤：named-pipe 协议 → 常驻 COM/UIA 进程 → CacheRequest 批量属性 → 局部/文档/终端请求 → 缓存失效（L9 事件已就位）→ 熔断/隔离 worker → 性能验收（局部 p95 ≤ 80ms、全文档 p95 ≤ 250ms）。
- 验收门槛：`uia_text_adapter` 的每请求起进程与同步 sleep 全部移除；空闲不扫描。

## 6. 验收与账本

- 每个切片完成后：全量 Python + Node + typecheck + lint；更新 `docs/design/MAGIC_POINTER_HARNESS_20260811.md` 进度账本与 `docs/STATUS.md`。
- 真机项必须在 STATUS 的"能用/不能用"表格单独登记，不得与自动化通过混写。
