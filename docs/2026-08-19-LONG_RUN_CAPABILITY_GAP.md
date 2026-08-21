# 长任务能力差距盘点（2026-08-19）

> 触发：2026-08-19 用户裁决产品边界——Magic Pointer 是顶级 Agent Harness 本身，短任务和长任务都自己做，任务时长不是边界。见 `docs/design/MAGIC_POINTER_HARNESS_20260811.md` §1.1。
>
> 方法：四路并发只读审计（持久化与崩溃恢复 / 上下文与记忆 / 任务结构与可观测 / 长任务中的感知适配），全部结论带 `文件:行号`。分类沿用本项目惯例：**已实现并接生产** / **有契约但没接生产** / **完全没有**。
>
> 本文只盘点，不排期落地。批次顺序是建议，由用户裁决。

---

## 0. 结论先行

> **实施进度（2026-08-19，持续更新）**：第 0 层硬天花板已全部解除，第 1 层的上下文部分已完成，均移植自 Hermes（MIT，出处见 `THIRD_PARTY_NOTICES.md`），fresh 验证 Python 1401 passed / Node 152 passed / typecheck + lint 干净。**仍未做**：工具结果 prune、感知语义隔离（第 3.2 节）、持久性（第 4 节）、可控性的 Electron 侧（第 5 节）、结构性能力（第 6 节）。

**长任务原本不是"跑不住"，是"跑不了"（第 0 层，已解除）。**

Electron 侧仍按"一次 bridge 调用 = 一次短问答"设计：Stage 60 秒、Studio 120 秒硬超时杀 Python 子进程（`electron/main.ts:3933-3934`、`electron/main.ts:1187`）。同时 `run_agent_turn` 有 90 轮模型轮次熔断（`app/fabric/engine.py:983-984`）。这两道闸在任何长任务能力被用到之前就先落下——所以目前任何超过 2 分钟的任务都会被静默杀掉，用户看到的是"这次处理被取消了"。

这与 loop 内核的能力形成强烈反差：`app/agent_runtime/loop.py` 的 rolling budget 早就是"productive 轮无条件续期，预算约束反馈节奏而不是循环寿命"（`599-612`），Inbox 的 steer/follow-up、CancellationScope、Receipt、InteractionLedger、effect sandwich 全都在 Python 侧写好了。**内核为长跑做了准备，外壳没有。**

按 OSWorld 2.0 的量纲（中位人类耗时 1.6 小时、平均 318 次工具调用）对照，当前上限是 **≤2 分钟、≤90 轮**。差距不是百分比，是数量级。

---

## 1. 验收靶

采用 OSWorld 2.0 作为长程标尺（数据见 `docs/research/2026-08-18-agent-leaderboards-and-harness-landscape.md`）：任务中位人类耗时 **1.6 小时**，平均 **318 次工具调用**；当前最强系统（Claude Opus 4.8 @500 步）仅 **20.6% 二值完成 / 54.8% 部分分**。全 field 共识是"短任务超人、长任务崩"，主战场四件事：**维持信念状态、跟踪中间产物、延迟验证、显式回溯**。

MP 的最小可信目标应表述为：**一个 300 步、跨 1 小时的桌面作业，能跑完、能看见、能插话、崩了能接着跑。** 四个动词分别对应下面第 2/5/5/4 层。

已被外部证据背书、不要推翻的既有优势：感知多源并发裁决（WAA 官方证实"视觉+无障碍树混合"最优）、证据八态与诚实 `unsupported`（≈ 学界正在补的 Evidence-Supported Bounds）、effect sandwich + 幂等键 + ActionLease 复核。

---

## 2. 第 0 层：硬天花板——长任务根本起不来

> **2026-08-19 本层已解除。**

| # | 缺口 | 证据 | 现状 |
|---|---|---|---|
| T1 | Stage bridge 60s 超时杀进程 | 原 `electron/main.ts:3933-3934` | **已修**：`electron/python_bridge_runner.ts` 的期限改为**无活动超时**——每一块 stdout/stderr 都重新计时，只有沉默才算挂。各调用点的 60s/120s 值不变，语义从"最多跑这么久"变成"沉默这么久才算挂" |
| T2 | Studio conversation bridge 120s 超时杀进程 | 原 `electron/main.ts:1187` | **已修**：同上，一处运行器改动，全部调用点受益 |
| T3 | `emergency_turn_fuse=90` → `INVARIANT_FAILED` | 原 `app/fabric/engine.py:983` | **已修**：提到 1000。90 低于真实长程负载（OSWorld 2.0 均 318 次工具调用），正常长任务撞上它会被当成内部不变量失败报给用户。防空转的正主是 `tool_guardrails` 的停滞检测和滚动预算，熔断只接住真正的失控 |

修法依据（Hermes）：`gateway/run.py:20211-20303` 明写 agent 只要在调工具、在收流式 token 就可以跑几小时，只有卡死的 API 调用或僵住的工具在配置时长内毫无活动才被杀（默认 1800s）。轮次同理——Hermes 的默认 `max_iterations` 也是 90，但它配合 grace summary、tool guardrails 和 idle timeout 共同区分"空转该停"与"正常长跑"，不让轮数单独当天花板。

失败形态：任务跑到 60/120 秒被 kill，session 留下 open turn，下次打开时 repair 补结算并关闭该 turn。用户侧只看到 `bridge_cancelled: 这次处理被取消了，没有改动任何东西`（`electron/stage_contract.ts:197`）——**这句话在已经点过按钮、发过消息的情况下是不诚实的**。

这一层不解，后面所有能力都用不上。它同时也是最便宜的一层：本质是把"请求-响应式 bridge 调用"改成"长驻任务 + 事件流"，Python 侧的事件通道（`params.event_sink` → stderr `@@mp` → `onProgress`）已经存在。

---

## 3. 第 1 层：跑起来之后会崩——上下文与感知的正确性

### 3.1 上下文

> **2026-08-19 本层已修复**（移植自 Hermes，MIT，出处登记在 `THIRD_PARTY_NOTICES.md`）。

| # | 缺口 | 证据 | 现状 |
|---|---|---|---|
| C1 | proactive compaction 每个 loop 只触发一次（`compacted` 标志全程不重置） | 原 `loop.py:553,636-645` | **已修**：锁去掉，每轮判定；连续 2 次压完仍超线则停试（`_MAX_FRUITLESS_COMPACTIONS`，移植 Hermes anti-thrash） |
| C2 | 压缩只保留摘要 + 最后 4 条，无任何进度事实保护 | 原 `builtin_bundle.py:341-344` | **已修**：`app/agent_runtime/todo_store.py` 持有计划，压缩后把未完成项原样贴回（移植 Hermes `TodoStore.format_for_injection`）。进度不再经过摘要模型 |
| C3 | 工具结果进 messages 后每轮全量重放，无窗口化/引用化/去重 | `loop.py:1243-1245,716-718` | **部分**：尾部体积已由 token 预算约束，但仍缺 Hermes 的压缩前 prune（MD5 去重、旧结果降级成一行、大结果落盘换引用） |
| C4 | token 估算是 `len(content)//2`，且**完全没算 system prompt 与 tool schema** | 原 `builtin_bundle.py:348-349` | **已修**：`app/agent_runtime/token_estimate.py`（移植 Hermes 三桶估算）。原估算漏掉的正是 MP 最大的两桶——记忆 4000 + 技能 12000 字符的 system prompt，以及十几个桌面工具的 schema |
| C5 | 无结构化任务状态/信念状态 | `app/agent_runtime/types.py:124-139` | **部分**：TodoStore 是第一块跨压缩存活的结构化状态；更完整的信念状态仍无 |
| C6 | `todo_write` 注册时 `sink=None`，计划只回到 tool message | 原 `builtin_bundle.py:117` | **已修**：sink 接到 TodoStore |
| C7 | 压缩成功与否用**条数**判定，压缩换来的 token 收益被忽略；一旦 compactor 追加任何携带状态，整次压缩会被丢弃 | 原 `loop.py:644` | **已修**（实施中发现的真 bug）：改判 token 权重 |

C1 + C3 合起来是致命组合：压缩一次之后上下文继续线性膨胀，而且再也不会压第二次。C2 的具体失败形态是——"137 条已处理 90 条，从 91 继续"这个事实在压缩后只存在于 LLM 摘要里，没有任何程序保证；模型可能重复处理或整段跳过，而且**不会有任何东西发现这件事**。

注：2026-08-15 曾实现过断言记忆 / 保护节（`assertion_memory.py`、`model_surface.py`），已删除且零生产引用（`docs/STATUS.md:39`）。设计文档里对它的描述是历史契约，不是现行代码。

### 3.2 感知——MP 独有的架构张力

整个感知层围绕"一次手势 → 一张冻结帧 → 编译一次 InputArtifact"设计（`app/perception/__init__.py:1` 明写 for a single frozen interaction），而执行期观察走 live UIA。两种语义**同时挂在模型面前**：

| # | 缺口 | 证据 | 分类 |
|---|---|---|---|
| P1 | `look` 的 crop 来源永远是 pointerup 那一刻的 PNG；`read_around`/`find_in_window` 读 turn 初 snapshot 文本；`get_app_state` 是 live。三者混用无隔离 | `scripts/selection_bridge.py:1776-1819,1912-1970`；`app/desktop_actions/session.py:136-170` | 已实现，语义未隔离 |
| P2 | 系统提示第 2 条**主动教模型**在结构化未覆盖时用 `visual_anchor` 调 `look` —— 长任务里这会把模型引向过期画面 | `app/agent_runtime/system_prompt.py:164` | 已实现（短任务正确，长任务有害） |
| P3 | `InputArtifact.revision` 硬编码为 1，无 mid-loop 重新编译入口 | `app/input_artifact/schema.py:508`；`scripts/selection_bridge.py:2105-2110` | 完全没有 |
| P4 | `snapshot_id` 失效判定只绑窗口几何（hwnd + pid + rect 四角），不 re-walk 元素树 | `app/desktop_actions/session.py:353-367,780-786` | 已实现（保护范围不足） |
| P5 | `look` 无调用配额，只受 wall-clock 约束 | `app/harness/builtin_bundle.py:129,574` | 完全没有 |
| P6 | 无周期性重新感知、无状态漂移检测 | 全库无实现 | 完全没有 |

P4 的具体失败形态：列表刷新后 `index=5` 仍被判为有效 snapshot（窗口几何没变），但它已经指向另一行了；click 会成功，verification 可能返回 unavailable，Agent 据此认为做对了。

方向本身没错——冻结帧作历史锚点、loop 内用 live 工具，这个分层是对的。缺的是把两种语义硬隔离，以及给中途再感知留一个 seam。

---

## 4. 第 2 层：崩了救不回来——持久性

| # | 缺口 | 证据 | 分类 |
|---|---|---|---|
| D1 | crash 后无法接着干：repair 只做"补结算 + 关闭中断 turn"，用户必须重新发话 | `app/agent_runtime/session.py:840-955`；`app/agent_runtime/loop.py:424-433` | 完全没有 |
| D2 | 无"这个 session 有活没干完"的标记，重启后不会自动接续 | `app/agent_runtime/session.py:1031-1048` | 完全没有 |

> **2026-08-19 目标修正**：本文初稿把 D1 写成"必须实现 program counter 续跑"。源码调研推翻了这个目标——**Hermes 也没有 PC 续跑**。它的做法是 transcript 重放：持久化消息 → 重载历史 → `agent/replay_cleanup.py` 清掉被打断的工具尾巴（含 assistant 发了 tool_call 却没有结果的悬空尾部）→ 注入 recovery system note → 让模型自己接着干；配套一个 session 级 `resume_pending` marker（`gateway/session.py:2113-2160`）和启动时的自动 drain（`gateway/run.py:6721-6858`）。MP 应当照此实现，不要去造字节码级续跑。
| D3 | **effect sandwich 尚未上生产盘**：本机 276 个真实 session JSONL 全是旧格式 `tool/call`+`tool/result`，0 个含 `operation/prepared` | `data/runtime/agent-sessions/`；`app/agent_runtime/session.py:897-901`（旧格式退化路径） | 开发树已实现，未 sync |
| D4 | session JSONL 无轮转/分段/快照；每次 append 全量 reload + O(n) hash chain 验证 | `app/agent_runtime/session.py:307-317,1075-1115` | 完全没有 |
| D5 | 跨会话只有"对话能接着聊"，没有"未完成任务"语义：无任务队列、无 resume-task API、无自动 re-dispatch | `app/agent_runtime/session.py:1031-1048` | 完全没有 |
| D6 | skipped_calls / truncation 恢复 / withheld 恢复三条路径绕过 operation 记录，effect 等级丢失 | `app/agent_runtime/loop.py:1020-1036,525-528,458-470` | 已实现但绕过 |

D3 值得单独说：crash recovery 的分级重放（read 可安全重放 / reversible_write 需先读回确认 / external_send 与 destructive 永不重放）**依赖 `operation/prepared` 里的 `dispatched` 和 `effect` 字段**。生产盘上没有这些字段，repair 只能退化成 `call["started"]=True` 的粗粒度推断。也就是说安装版 1.0.11 上的崩溃恢复，比开发树弱一档。

D4 的量级：真实样例单个 session 78 行已达 197KB（大头是每轮 `model/request` 里嵌的完整 tools schema）。几百步下文件可达数十 MB，而每次 append 都要全量 reload 并逐行验 hash。

---

## 5. 第 3 层：跑着的时候管不住——可控性与可见性

| # | 缺口 | 证据 | 分类 |
|---|---|---|---|
| O1 | **steer 断点只在 Electron**：`loop.py:721-729` 每轮都 `session.claim_inbox("next-step")`，只要有 session 跨进程 steer 就能进到正在跑的循环（`params.inbox` 只是额外的进程内队列，不传不影响）。真正缺的是 Electron 全树没有一处调用 `scripts/agent_session_bridge.py` | `app/agent_runtime/loop.py:721-729`；`scripts/agent_session_bridge.py:42-83` | Python 侧已通，GUI 侧没接 |
| O2 | Stage 在 `processing` 时直接 return，用户连排队一条 steer 都做不到——与 Inbox 设计意图相反 | `electron/renderer/stage.ts:832-835` | 已实现（阻断） |
| O3 | 取消 = kill Python 子进程，不是 loop 内 graceful `USER_INTERRUPT`；kill 路径可能来不及写 Receipt | `electron/main.ts:580-585,3660-3663`；`app/agent_runtime/loop.py:661-669,1864-1883` | 内核有契约，生产走 kill |
| O4 | 中止后不枚举已执行工具与已发出的 egress，只给一句通用文案 | `electron/stage_contract.ts:197` | 完全没有 |
| O5 | 运行中看不到真实步数：GUI 用 `TYPICAL_PHASES=7` 估进度条，100 步和 3 步的任务 UI 一模一样 | `electron/cards.ts:107-141`；loop 的 `turn_number` 未渲染 | 完全没有 |
| O6 | InteractionLedger 随 bridge 返回但 `stage_contract.ts` 不透传、Studio 渲染路径从不读取；Receipt 只在终态显示一行状态标签 | `scripts/selection_bridge.py:2410-2415`；`electron/conversation_store.ts:217` | 有契约但无 UI |
| O7 | `Steered` / `FollowupContinued` 事件 loop 会 yield，但无 sink 处理、不推 GUI | `app/agent_runtime/loop.py:313-325` | 有契约但无 UI |
| O8 | 唯一合法的 mid-run 交互是 `ask_user_question` 的澄清 chips；自由文本 steer 不通 | `electron/clarification_chips.ts:32-34` | 已实现（范围过窄） |

O1+O2 的组合意味着：跑了 200 步发现方向错了，用户只能杀进程。而 Fabric 的后台 Pi 任务反而**有** `task.steer`（`app/fabric/task_store.py:620-665`）——外部 Agent 能 steer，自有 Runtime 不能，这与新产品边界直接冲突。

---

## 6. 第 4 层：跑不远——结构性能力缺失

| # | 缺口 | 证据 | 分类 |
|---|---|---|---|
| S1 | 无子任务分解、无任务树、无并行子任务；一个 run 就是扁平的工具调用序列 | `app/agent_runtime/loop.py:591-937`；`app/fabric/executors.py:1460-1461`（handoff 是外部投递，不是内部分解） | 完全没有 |
| S2 | `Receipt.memory_eligible` 恒为 False，"验证过才能沉淀"的回执准入未接线 | `app/receipts/schema.py:37`；`app/receipts/projection.py:79-80` | 有契约但没接生产 |
| S3 | 静态记忆上限 4000 字符注入 system prompt，无导航面/按需展开 | `app/agent_runtime/memory.py:28-92` | 已实现（长跑不足） |
| S4 | 无跨 compaction 的累计任务 token 预算（CC 的 taskBudgetRemaining 语义） | port notes 有描述，Python loop 无字段 | 完全没有 |
| S5 | tool guardrails 把"跨不同读工具的重复读证据"判为停滞并终止——长任务里合法轮询（等进度条、反复确认窗口出现）会被误杀 | `app/agent_runtime/loop.py:1218-1227`；`app/agent_runtime/tool_guardrails.py:49-50,185-221` | 已实现（短任务正确，长任务有害） |

---

## 7. 建议批次顺序

排序原则：先解除让长任务"跑不了"的闸，再补"跑得住"，然后"管得住"，最后"跑得远"。每批都能独立验收。

**批次 A — 解除硬天花板（最小改动、最大解锁）**
T1/T2/T3。把 Electron 的"请求-响应式 bridge 调用"改成长驻任务 + 事件流；把 90 轮 fuse 从固定常量改为与预算体系一致的语义（stalled 判定负责杀死无进展的循环，fuse 不该替它做轮次封顶）。验收：一个刻意设计的 200 步任务能跑完不被杀。

**批次 B — 上下文与感知的正确性**
C1（rolling compaction，允许多次触发）、C2（进度事实的结构化保护，不依赖摘要模型）、C3（工具结果窗口化）、C4（真实 token 计数）、P1/P2（冻结与实时语义硬隔离，长任务下调整 look 的提示策略）、P4（元素级 snapshot 失效）。验收：300 步任务的 token 曲线不失控，且不出现基于过期画面的动作。

**批次 C — 持久性**
D1/D2（program counter 续跑）、D3（effect sandwich 上生产盘）、D4（session 轮转）、D6（补齐绕过路径）。验收：在第 137 步 kill 进程，重启后能从第 138 步继续，且不重放任何不可逆动作。

**批次 D — 可控性与可见性**
O1/O2（steer 生产接线 + 运行中允许排队）、O3/O4（graceful interrupt + partial 账本）、O5（真实步数）、O6（ledger/Receipt 可视化）。验收：跑到一半能插话改方向，能看见它在第几步做什么，中止时能看到已经做了什么。

**批次 E — 结构性能力**
S1（子任务分解）、C6（todo 落盘）、S2（回执准入）、S5（长任务下的 guardrail 语义）。这批应当先有真实账本数据证明必要性再做——蓝图 Gate 6 已经写明"只有真实任务账本证明单 Agent 的关键路径受可并行子任务限制，才实现 durable lanes"。

---

## 8. 与既有 Gate 结构的关系

蓝图（`docs/research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md` §14）的 Gate 0–6 仍然成立，本文不另起炉灶。对应关系：批次 A/C/D 基本属于 **Gate 2（完整自有 Run 闭环）**未闭合的部分——Gate 2 原本就列了 crash recovery，只是当时没有按"318 步"的量纲定义它；批次 B 跨 Gate 1/2；批次 E 落在 Gate 4/6。

需要补进 Gate 结构的新认识：**Gate 2 的"crash recovery"必须升级为"program counter 续跑"**，"能补结算并安全封口"不足以支撑长任务；以及**长任务的上下文耐久性（rolling compaction + 进度保护）此前没有出现在任何 Gate 里**，它是新边界带来的新需求。

---

## 9. 诚实边界

- 本文是只读审计的产物，没有真机跑过一个 300 步任务。所有"会失败"的判断来自代码路径推演与既有测试，不是实测复现。批次 A 完成后应当立即补一个真实长任务基准，用真实数字校准本文。
- 本机 276 个 session JSONL 全为旧格式这一事实，说明开发树与安装版（1.0.11）在崩溃恢复能力上已经分叉；本文第 4 层的部分结论对安装版更悲观。
- 未审计：多 provider 长跑下的限流与重试、长任务的成本上限策略、GUI 长时间运行的内存占用。
