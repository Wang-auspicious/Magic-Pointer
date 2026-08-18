# Run Kernel、Durable Inbox 与 Ledger Projection 实施计划

> **交付状态（2026-08-18）：** Task 1–6 已按本计划落地并随 1.0.10 sync 到本机安装版；fresh 证据为 Python 1313、Node 151/104、五套 typecheck、ESLint、NSIS 与安装目录独立核验全部通过。计划中的非目标仍为非目标，具体剩余边界见本文 Task 6 与 canonical progress ledger。

> **执行说明：**本计划承接 [主权 Agent 后端重构蓝图](../../research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md) Gate 0 / Gate 2 的最小公共地基。它不另建第二套 session store，而是在现有 `EventSession` 的 append-only JSONL 真相上增加 Run/Operation、durable Inbox 和账本投影。

**目标：**让每个自有 Agent 回合都能从同一本事件日志回答：输入来自哪里、模型花了多少 token、每个工具是否真正开始、是否得到持久化结算、当前等待什么、崩溃后哪些动作可安全重试，以及 GUI/CLI 应展示哪一张成本与结果账单。

**核心裁决：**

1. `app/agent_runtime/session.py` 继续是唯一 durable truth；不新增平行 JSON/SQLite 账本。
2. `app/run_kernel/` 只放 typed schema 与纯投影，不拥有 I/O。
3. 工具副作用使用两侧持久化事件：`operation/prepared` 必须先于执行，`operation/settled` 必须在执行后一次性写入结果并进入模型表面。
4. `InteractionLedger` 由 session events 投影；原独立 save/load 只作为旧 API 暂留，生产不能再写第二本账。
5. durable Inbox 的“领取”与“成为模型可见用户消息”是同一个 append event，避免崩溃窗口吞掉 steer。

---

## Task 1：Run Kernel typed schema 与纯投影

**新增：**

- `app/run_kernel/__init__.py`
- `app/run_kernel/schema.py`
- `app/run_kernel/projection.py`
- `tests/agent_runtime_run_kernel_test.py`

**先写失败测试：**

- `operation/prepared → operation/settled` 投影为 completed/failed；
- prepared 且 dispatched、无 settled 时按 effect 给出 recovery policy；
- 未 dispatched 的 operation 为 not_started，可安全重放；
- 重复 operation id、无 prepared 的 settlement、二次 settlement 必须拒绝；
- 同一 call id 在不同 turn/step 仍由 operation id 精确区分。

**实现：**

- `OperationPhase`、`OperationOutcome`、`RecoveryPolicy`、`OperationSnapshot`；
- `project_operations(events)` 仅消费事件快照，不读文件、不调用工具；
- effect 到恢复语义的确定性映射：read 可重放，reversible write 先核验，irreversible/send/delete/purchase 永不盲重放。

---

## Task 2：Effect sandwich 进入 EventSession 与生产 loop

**修改：**

- `app/agent_runtime/session.py`
- `app/agent_runtime/loop.py`
- `tests/agent_runtime_session_test.py`
- `tests/agent_runtime_run_kernel_test.py`

**先写失败测试：**

- 工具 execute 函数被调用时，`operation/prepared` 已经可从另一个 session handle 读到；
- 工具返回后，`operation/settled` 同时成为模型表面的 TOOL message，不再另写重复 `tool/result`；
- 崩溃修复对 read 给出 safe-retry，对写入给出 outcome-unknown；
- scheduler 的 cancelled-before-dispatch 不得被记为“可能已执行”。

**实现：**

- `record_tool_call()` 改为记录 operation id、effect、dispatched，并返回 prepared event；
- `record_tool_settlement()` 写结果元数据和 TOOL message，使用单一 surface append；
- loop 在 `ScheduledCallStarted` 保存 operation id，在 `ScheduledCallCommitted` 结算同一 operation；
- 保留旧 `tool/call` 的读取兼容，只为现有日志恢复，不再作为新生产写入形状。

---

## Task 3：Durable Inbox 与跨进程 bridge

**修改/新增：**

- `app/agent_runtime/session.py`
- `app/agent_runtime/loop.py`
- `scripts/agent_session_bridge.py`
- `electron-builder.yml`
- `tests/agent_runtime_run_kernel_test.py`
- `tests/agent_session_bridge_test.py`
- `tests/windows_package_contract_test.js`

**先写失败测试：**

- 独立 store handle enqueue 后，运行中的 loop 在下一个 step 读取；
- `next-turn` 在模型准备停止时续跑；
- 两个进程/handle 并发 claim 不重复消费；
- claim event 同时把消息加入 session surface；恢复时不会出现“已消费但模型没看见”；
- bridge 对 put/pending 提供有界 JSON API，未知 session/target 明确失败。

**实现：**

- 事件：`inbox/message`、`inbox/consumed`；
- `EventSession.enqueue_inbox()` / `claim_inbox()` / `pending_inbox()`；
- loop 将旧进程内 Inbox 先落 durable event，再通过 session 原子 claim；无 session 时维持旧行为；
- bridge 默认指向与 Harness 相同的 `data/runtime/agent-sessions` 或 `MAGIC_POINTER_USER_DATA_DIR/agent-sessions`。

---

## Task 4：InteractionLedger 成为 session projection

**修改：**

- `app/telemetry/interaction_ledger.py`
- `app/agent_runtime/session.py`
- `app/agent_runtime/loop.py`
- `app/fabric/engine.py`
- `scripts/selection_bridge.py`
- `scripts/conversation_bridge.py`
- `tests/agent_runtime_run_kernel_test.py`
- `tests/selection_bridge_test.py`
- `tests/conversation_bridge_test.py`

**先写失败测试：**

- 一个真实 loop 的 interaction entry 能投影 token、模型轮数、工具延迟、look、终态；
- open turn 不伪造 succeeded/e2e latency；
- selection 输入投影 app/evidence/confidence/InputArtifact id；
- GUI/CLI 返回的 ledger 是 session 事件派生值，不写独立 ledger 文件。

**实现：**

- 每个 session turn 在 `turn/start` 后记录 `interaction/start`，metadata 由 `LoopParams.interaction_metadata` 提供；
- `InteractionLedger.from_session()` / `project_session()`；
- selection/conversation 返回当前 interaction 的公开账单；
- 不调用 `InteractionLedger.save()`，生产调用图只有事件投影。

---

## Task 5：删除旧生产形状并核对调用图

**检查：**

- 新生产事件不再写 `tool/call` + 独立 `tool/result` 双形状；
- 旧 `Inbox` 只作为同进程 producer 缓冲，不再是 session 存续期间的真相；
- `InteractionLedger.save/load` 没有生产 caller；
- operation settlement 是工具结果唯一的生产 session event；
- 不删除旧日志读取分支，直到 fixture 覆盖 legacy resume。

---

## Task 6：验证与本机交付

1. 先跑新增 Run Kernel / session / inbox / ledger 定向测试；
2. 跑 loop、selection、conversation 相关集合；
3. fresh 全量 Python、Node、五套 typecheck、lint、Electron build；
4. 可感知后端行为变化，patch version +1；
5. `npm run sync`；
6. 核对安装目录版本、新 bridge、新 run_kernel 模块与运行进程；
7. 更新 canonical progress ledger 与 `docs/STATUS.md`，明确仍未完成 DraftArtifact revision/GUI ask-user 往返/完整 crash resume runner。

---

## 非目标

- 不在本批实现长期记忆、Hermes 资产兼容或 multi-agent lanes；
- 不改 GUI 视觉；只返回可渲染账单与 durable session id；
- 不把 hash-chain 扩展成通用数据库或分布式共识；
- 不为理论攻击者增加新认证层；本机 bridge 继续遵守现有本地协作者边界；
- 不复制 Pi 尚未实现的 Harness API；只实现本项目生产 loop 真正消费的最小状态语义。
