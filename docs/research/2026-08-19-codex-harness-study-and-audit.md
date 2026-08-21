# Codex harness 逐行学习与 MP 审计（2026-08-19）

> 触发：用户裁决——Codex 开源了完整 harness 源码，clone 到本地逐行学习，与
> Hermes/Pi/DSH/Claude Code 整合后，揪出 MP 所有不达标之处，同权重修复。
> 本地源码：`D:\AI_Agents\codex`（github.com/openai/codex，HEAD `2151d3a`）。
> 方法：逐文件读 `codex-rs/core`（turn 循环 / 压缩 / 并行工具 / 输入队列 /
> 持久化 / 目标系统），对照 MP 同名子系统逐条裁决：吸收 / 已有 / 明确不取。

---

## 1. Codex harness 值得学的东西（逐行读到的）

### 1.1 turn 循环（`core/src/session/turn.rs`，2791 行）

- **三处压缩触发点**：pre-sampling（turn 开始前超线就先压）、mid-turn（采样后
  超线，压完 `continue` 继续跑）、**模型切换时**（`comp_hash` 变化或换到更小
  窗口的模型，用**上一个模型**的 step context 压——因为摘要要用旧模型能读的
  历史写）。MP 有前两处（rolling compaction + anti-thrash），没有第三处。
- **steer 每轮排空**：`input_queue.get_pending_input()` 在循环体开头；且
  `can_drain_pending_input` 门保证「auto-compact 后模型/工具先续跑，steer
  排后面」。MP 的 inbox drain 在同一位置，语义一致。
- **stop hooks 在自然收尾边界评估一次**，`should_block` → 注入 hook 提示继续
  跑，`stop_hook_active` 粘住防止重入失败 hook。MP 已移植同一语义。
- **取消是 token 级**：`or_cancel(&cancellation_token)` 包住每一次 stream 读；
  工具取消后合成 `aborted by user after Xs` 结果回喂。MP 用 CancellationScope
  同构。

### 1.2 压缩是一等公民（`core/src/compact.rs` + `prompts/templates/compact/`）

- 压缩是一个**真实 turn item**（`ContextCompactionItem` started/completed 事件），
  用户看得见；MP 只有内部 transition reason，GUI 不可见（本批已把
  `context_compacted` 阶段接进进度通道，补上可见性）。
- **pre/post compact hooks**（可拦截/中止压缩）。MP 无——暂不需要。
- **压缩中再撞 ContextWindowExceeded → 从最老的一条开始删、保留前缀缓存**，
  重试。MP 的压缩失败路径是放弃（fruitless 计数）。差距记录在案。
- **摘要提示词是结构化交接**：「进度/关键决定/约束/剩余步骤/关键数据」。
  MP 原来是「压缩成简短要点」——本批已照 Codex 重写为五段交接
  （`app/agent_runtime/compaction_prompt.py`），并把摘要源上限从 12k 提到 48k
  （旧上限让摘要模型根本看不到它要摘要的历史）。
- 压缩后给用户一条诚实警告（「多次压缩会掉精度，尽量开新线程」）。MP 未取
  （桌面短会话场景噪音大于价值）。

### 1.3 并行工具执行（`core/src/tools/parallel.rs`）

- **RwLock 门**：可并行工具拿读锁、互斥工具拿写锁——一个锁同时表达「并行上
  限」和「互斥串行」。MP 的 scheduler 用显式 conflict-key 分区，等价。
- **取消的精细结算**：handler 已完成 → 返回真结果；没完成 → abort + 合成
  aborted 回执 + `notify_tool_aborted` 事件。MP 的 scope 取消语义一致。
- **计时守卫拆 dispatch/handler 两段**（排队等待 vs 真执行），且 code-mode 嵌套
  调用不重复计时。MP 的 operation settlement 记 latency，但不拆排队/执行。
  差距小，记录在案。

### 1.4 输入队列（`core/src/session/input_queue.rs`）

- steer（用户插话）与 mailbox（agent 间邮件）分列，`watch` channel 通知
  「有新输入」；mailbox 有 delivery phase（本轮收/下轮收）与 trigger-turn 语义。
  MP 只有 steer/followup 双队列——**没有 agent 间邮箱**。这是多 agent 结构
  （S1 子任务）的前置件，等真实账本证明需要再做（蓝图 Gate 6）。

### 1.5 持久化（`codex-rs/rollout/`）

- JSONL 每行带 `timestamp + ordinal`；**冷文件后台 zstd 压缩 worker**；
  **reverse scanner**（从尾部扫，resume 不用读全文件）；sqlite 状态库 + 会话
  索引。MP 本批补了**增量采用**（stat 前缀 + 逐行链哈希，append 从 O(n²) 降
  回 O(1)），轮转/压缩/索引仍无——MP 会话量级（单机单用户）暂时不需要，
  增量加载已消掉最痛的 O(n²)。

### 1.6 目标系统（`ext/goal/` + `core/src/session/token_budget.rs`）

- `create_goal/get_goal/update_goal` 三个工具 + token 预算记账；**余量低于阈值
  注入提醒 fragment**（claim-once 防重复）；预算耗尽注入 wrap-up 提示让模型
  收尾；空闲时 continuation prompt 自动续跑。MP 的对应物是 TodoStore（跨压缩
  存活）+ rolling budget。**「余量提醒 + 收尾提示」MP 没有**——记录为后续
  （S4 任务 token 预算）。

### 1.7 其他

- 会话恢复后 `restore_after_resume` + `continue_if_idle`：重启后自动接续目标。
  MP 本批加了 `has_pending_work()` 派生 + bridge `status` 查询（GUI 主动问，
  不自动跑——桌面环境自动续跑风险大于价值，交给人决定）。
- `SUMMARIZATION_PROMPT`/`SUMMARY_PREFIX` 固定文案进 prompts crate，全入口
  共用。MP 同构（compaction_prompt.py 单源）。
- 技能/插件 mention 解析、guardian 审稿、code-mode（把工具调用编译成代码执行）
  ——MP 均无，均记录为候选而非本批目标。

## 2. 本批据此修复的 MP 缺口（全部同权重，无 P0/P1）

| # | 缺口 | 修复 |
|---|---|---|
| 1 | 上一批 9 个 TDD 契约悬空（P1 冻结标注 / S5 轮询守卫 / P4 元素级快照失效 / C3 压缩去重） | 全部实现转绿（commit `04f4e58`） |
| 2 | 压缩摘要是「简短要点」不是交接；摘要源 12k 截断看不见历史 | Codex 五段交接提示 + 48k 上限，双桥单源（本批） |
| 3 | session append O(n²)（每 append 全量重读重验哈希链） | `_known_size` 前缀 + `_adopt_incremental` 逐行链上（本批） |
| 4 | 取消=kill 子进程，Receipt 写不上（O3） | `cancel/request`+`cancel/consumed` 持久事件 + bridge `action=cancel` + 双桥 interrupt_check + GUI 5s 宽限（本批） |
| 5 | 处理中提交被静默丢弃（O1/O2） | stage 处理中提交 → `stage:steer-selection-command` → durable inbox → loop 下轮携带（本批） |
| 6 | 运行中看不到真实步数（O5） | loop 事件 turn 字段上卡（「第 N 轮」），tool_call 显示工具名（本批） |
| 7 | 重启后不记得有活没干完（D2） | `has_pending_work()` 从 turn/end reason 派生 + bridge `status`（本批） |
| 8 | `look` 无配额，视觉调用可被无限刷（P5） | 每 run 12 次配额，耗尽诚实 unsupported（本批） |
| 9 | steer/压缩事件 GUI 不可见（O7） | `steer_absorbed`/`followup_continued`/`context_compacted` 进度阶段（本批） |
| 10 | 账单随桥返回但过不了契约层（O6） | `ledgerFromBridge` 有界透传（本批） |
| 11 | 取消/超时文案谎称「没有改动任何东西」（O4） | 全部改为「已完成部分记录在会话里」；预模型失败类保留真话（本批） |

## 3. 记录在案、明确暂不做的（防反复追问）

- **压缩中撞墙的「删最老重试」**：MP 的 fruitless 停试已防抖；真实 300 步
  任务跑出数据后再决定是否加。
- **agent 间 mailbox / 子任务树（S1）**：等 Gate 6 真实账本证明单 agent 关键
  路径受并行限制。
- **session 轮转/zstd/索引（D4 后半）**：单机单用户量级未到；O(n²) 已消。
- **目标系统三工具 / token 余量提醒（S4）**：TodoStore 已覆盖「计划跨压缩存
  活」；余量提醒等真实长任务成本数据。
- **code-mode（工具调用编译成代码）**：MP 工具面是桌面动作不是文件树，收益
  未证明。
- **P3 InputArtifact 中途重编译 / P6 周期性重感知**：需要先有真实长任务的
  过期画面事故数据，避免为想象中的需求加机制。

## 4. 验证

每批独立 fresh 验证并单独提交：Python 1426 passed / Node 154 passed /
五套 typecheck 干净 / ESLint 0。交付版本见 `docs/STATUS.md`。
