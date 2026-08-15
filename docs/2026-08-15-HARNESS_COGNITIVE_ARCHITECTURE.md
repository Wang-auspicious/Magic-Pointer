# Harness 认知架构重构映射表（2026-08-15）

> 输入：用户 8·15 重构指令（预测编码 / 侧向抑制 / 主动遗忘 / 具身卸载四条朴素定律）
> + 既有事实源（母文档 §18、`docs/2026-08-14-HARNESS_RECONSTRUCTION_PROGRESS.md`、
> 重建规格、插件架构审查、Agent 社区需求调研）+ 本批逐文件阅读。
> 本文件是**映射与裁决**，不是术语堆叠：每条定律都给"现状是什么 / 可行性裁决 /
> 落在哪个文件 / 什么不建"。
>
> 一句话总判：**四条定律里只有一条（预测编码）需要在架构上"重新发明"，且它的正确
> 形态不是规则路由器，而是"惊奇分级 + 断言记忆 + 预算表面"三层；另外三条要么已经
> 以更朴素的形式存在于代码里（租约四守卫 = 侧向抑制的单支退化），要么是数据纪律
> 而不是新模块（主动遗忘、具身卸载）。真正的架构创新点不是认知学术语，而是
> 「Journal 是唯一心智、惊奇是唯一唤醒信号、断言是唯一记忆形状」。**

---

## 1. 现状瓶颈点与模块耦合图（核对到文件）

### 1.1 当前链路（谁在生产链上）

```text
gesture arm/pointerup
  → electron/main.ts + frame_capture_worker_client.ts   FrameLease 冻结（p50 192ms GDI）
  → scripts/selection_snapshot_bridge.py                并发感知（UIA resident host / OCR / CDP / COM）
  → scripts/selection_bridge.py                         编译对象证据 + 确定性路径（L0/undo/handoff）
        └ _loop_router → app/harness/builtin_bundle.py  8 行插件树 boot
             └ app/agent_runtime/loop.py                主循环（69KB：预算滚动续期 / 工具调度 / guardrail）
                  ├ app/agent_runtime/tool_scheduler.py DSH 式有界调度（exists, 2026-08-14）
                  ├ app/agent_runtime/session.py        hash-chain 会话日志（exists）
                  ├ app/agent_runtime/tool_guardrails.py Hermes 式重复/停滞熔断（exists）
                  └ app/agent_runtime/memory.py         用户级/工作区记忆（4k 上限）
  → loop_answer / Terminal → 桥回答 + actionProposals
  → electron/main.ts appendTurn → conversation_store.json（question/answer/outcome/object）
```

### 1.2 瓶颈清单（每条：位置 → 问题 → 本批裁决）

| # | 瓶颈 | 位置 | 问题 | 裁决 |
|---|---|---|---|---|
| B1 | 模型唤醒无分级 | `loop.py` 每轮固定调模型；`tool_guardrails.py` 只有 stalled 熔断 | 工具结果符合预期时仍付全价模型回合——"非必要也思考" | **新增 `surprise.py`**：S0/S1 零 token 路径、S2/S3 才唤醒并携带 delta。不做意图规则 |
| B2 | 记忆形状是转录本 | `memory.py` 是提示词文件；conversation_store 存 question/answer 全文 | 工作记忆随轮数线性膨胀，检索靠全文 | **新增 `assertion_memory.py`**：每回合结束后只留断言（≤120 字/条，O(1) 查找，LRU 上限 200）。转录本留在 session 日志里供回放 |
| B3 | 模型表面无预算推导 | `selection_bridge._bridge_evidence_block` 60k 字硬围栏 + 手势点截窗 | 截断有告知，但无"哪些节点被剪、为什么"的结构化报告；无 token 估算 | **新增 `model_surface.py`**：预算化表面 + 剪枝账本（保护惊奇/断言节，大块证据先截） |
| B4 | 抢占语义散落 | `governance/cancellation.py`（代际取消）+ loop 内 check | 取消没有统一的"抢占者"与"取消回执"概念 | **新增 `event_loop.py`**：优先级抢占（用户 0 > 重定向 1 > 正常 5 > 后台 9），抢占即留合成取消回执，回放结构完整 |
| B5 | 惊奇之后无自愈 | 五路 Anchor 判别一等值存在，但 UI 不消费、循环内无自动重定向 | changed/gone 后要么盲写要么直接失败 | event_loop 的 re-ground 探针（读-only）+ 有界重试（≤2 次 → needs_user） |
| B6 | 后台任务补丁与聊天渲染脱钩 | studio.ts 用 CardModel 卡片流 | 工具调用/思考没有结构化渲染 | 本批已做：DSH 聊天渲染器 + turn.events 数据缝（见 §5） |

### 1.3 耦合结论

- 需要解耦的两对：**模型唤醒频率 × 证据真实性**（现在绑死：每轮都问模型）；**记忆体积 × 检索成本**（现在转录本形状）。
- 不需要解耦的：插件内核（DSH 移植已对）、会话日志（hash-chain 已对）、工具调度（DSH 语义已对）、租约四守卫（已对，见 §2 定律二裁决）。

---

## 2. 四条定律的可行性裁决（用户点名要求先想清楚第一条）

### 定律一：预测编码 / 惊奇触发——"非必要不思考"

**裁决：可行，但绝不是 if/else 意图规则；它的正确形态是"比较器 + 分级"，并且只作用于环境预测，不作用于用户意图。**

理由（从本项目自己的历史里得到的证据）：Magic Pointer 曾经有 L0 关键词路由 + recipe
编译器，用户实测判决"从根本上不好、不可扩展"并已退役（2026-08-13）。规则路由器在
复杂场景下的失败模式是确定的：意图空间无限、关键词表永远追不上表达方式、规则冲突
时没有仲裁者。**任何"80% 走规则"的意图方案都会被同一把刀杀死。**

但预测编码并不要求预测"用户想干什么"。它只要求预测"世界接下来是什么样"，而这个
问题**天然有确定性答案**：

- 动作之前，四守卫已经断言目标 exact / 聚焦 / 内容未变 / 无模态（`app/action_guard/preconditions.py`）；
- 动作之后，回执读回校验（`verify` + `readBackAndCompare`）已经断言结果；
- Evidence 八态已经断言 busy≠empty、非空≠读到了。

**这些就是预测器。缺的只有一件事：把"预测 vs 实际"的比较结果分级，并让分级决定
唤醒谁。** `surprise.py` 做的只是这件事——S0 EXPECTED / S1 DRIFT（busy、延迟超标、
锚点 moved）→ 零 token 继续；S2 CONFLICT（意外错误、预期有内容却为空、证据身份
打架、锚点 changed/ambiguous）→ 唤醒 System 2 并携带精确 delta；S3 BROKEN（锚点
gone/stale、结构断裂）→ 先做读-only 重定向探针，绝不让模型在坏世界上推理。

因此**本批没有建任何规则引擎**：没有意图表、没有路由表、没有关键词。惊奇分级只
消费类型化证据字段（is_error / status / exit_code / identity / anchor 状态），
这些字段是确定性的世界事实，不是对用户命令的解释。

### 定律二：侧向抑制 / 局部竞合——"赢家通吃、败者自抑"

**裁决：暂不建（swarm 层）。** 侧向抑制的用武之地是多分支并行探索（多子 Agent、
多候选路径）。本产品当前是单 Agent 短任务（产品边界：一两轮、几分钟），并且 P2
才规划多 Agent（需求矩阵）。在单支执行里，这条定律已经以最朴素的形态存在——
四守卫的 fail-closed 就是"单支通路自我抑制"：一支通路拿不到正向证据就自断，
不需要中央仲裁。等 TaskStore + 多 Agent 落地后，进展斜率看板是 journal 的
自然投影（每条分支的斜率 = hits/轮 的导数），届时再实现，现在建就是脚手架
（HERO 边界：不为这里不会发生的情况加框架）。

### 定律三：主动遗忘 / 不变性抽取——"记忆是断言不是转录本"

**裁决：立即建，且它纠正一个真实的设计债。** 现在的 `memory.py` 是提示词文件、
conversation_store 存 question/answer 全文——两个都是转录本形状，体积随轮数线性
增长。`assertion_memory.py` 把它翻成断言形状：每个回合结算时只落
`{surface|object_kind|fingerprint, kind, text≤120字, source_run, hits}`，
O(1) 哈希查找 + LRU 上限 + TTL 过期。**完整的转录本永远留在 hash-chain 会话日志里
（那是回放用的，不是回忆用的）**——记忆与真相分家：真相 append-only、记忆有界。
模型表面只注入 top-k 断言（按 hits×recency 排名）。

### 定律四：具身卸载 / 以环境为模型——"探测完即弃"

**裁决：已是本产品的立身之本，只需补一块：探测必须廉价（定律一的前提）。**
证据链本来就是"微小探测 → 物理操作 → 验证断言 → 丢弃上下文"：SurfaceAdapter 按需
读、常驻 UIA 空闲零扫描、环境（文件系统/exit code/UIA）是唯一真相源。本批补的是
`model_surface.py`——模型不拿环境、只拿环境的**有界投影**，超出预算的部分永远
以"剪枝账本"如实报告，绝不静默丢失。

---

## 3. 重构后的状态机迁移图

```text
                         ┌──────────────────────────────────────────┐
                         │            确定性层（System 1）            │
                         │  FrameLease 冻结 · 四守卫 · 回执读回 ·     │
                         │  惊奇分级 · 断言记忆 · 重定向探针           │
                         └───────────────┬──────────────────────────┘
                                         │ 惊奇 S2/S3 才上行（携带 delta）
                                         ▼
                        ┌───────────────────────────────────────────┐
                        │            模型层（System 2）               │
                        │  模型表面（预算化投影） → 推理/规划 → 工具    │
                        └───────────────┬───────────────────────────┘
                                        │ 动作结果回读 → 与预测比较
                                        ▼
                 ┌────────────── Event-Action Loop 仲裁 ──────────────┐
                 │ 优先级：用户中断 0 > 重定向探针 1 > 正常 5 > 后台 9   │
                 └───────────────┬────────────────────────────────────┘
              S0/S1 → 零 token 继续        S2 → 唤醒模型（带 delta）
              S3 → re-ground 探针（读-only）→ 回归 → 恢复
                   反复失败（>max_heal）→ suspend(needs_user)
```

Phase 迁移（与现生产 loop 的关系）：

```text
idle → reasoning → executing ⇄ reasoning
         │            │
         │            ├─ surprise S2/S3 ─▶ probing ─▶ (probe ok) reasoning
         │            │                        └─ 反复失败 ─▶ suspended(needs_user)
         │            ├─ user_interrupt ─▶ done（取消一切 + 合成回执）
         │            └─ context_starved ─▶ 排队 compact（后台优先级）
         └─ model_output(completed/needs_user/permission_required) ─▶ done / suspended
```

**迁移路径（诚实的接线计划，不是并行重写）**：`event_loop.py` 是仲裁核（纯函数、
可回放），生产 `loop.py` 保持模型/工具执行所有权。接线顺序：
1. `tool_guardrails` 的重复/停滞判定前插 `grade_surprise`（用同一批 typed 字段，双轨只读）；
2. 四守卫的 `content_hash_at`/anchor 结果 → `Observation(kind=anchor)`；
3. loop 每轮结束把断言写入 `AssertionStore`（先 memory.py 旁边共存，跑两批后按
   08-14 规格的 "Delete after replacement" 退役旧提示词记忆路径）；
4. `selection_bridge` 的证据块构造改由 `build_model_surface` 产出；
5. 用户中断/预算事件改经 `EventActionLoop.step` 仲裁（生成取消回执）。

---

## 4. 核心类型与调度循环（本批已实现，全部测试先行）

- `app/agent_runtime/surprise.py`：`Expectation / Observation / SurpriseReport`，
  `grade_surprise()` 纯函数；五路锚点判别投影为惊奇分级（changed/ambiguous 永不
  按 exact，不变量②）。
- `app/agent_runtime/assertion_memory.py`：`Assertion / AssertionStore`（O(1) upsert/
  recall、LRU 上限、TTL 懒清除、`render_for_prompt` 单行断言形状）。
- `app/agent_runtime/model_surface.py`：`SurfaceBudget / SurfaceNode / ModelSurface /
  build_model_surface()`——剪枝顺序（深容器 → 低覆盖 → 禁用）、保护节（惊奇/断言/
  指令）优先于大块证据、剪枝账本永不为空。
- `app/agent_runtime/event_loop.py`：`Action / Event / LoopState / LoopParams /
  EventActionLoop`。step 只返回新增动作、drain 取走就绪队列；抢占产生合成取消回执。
- 基准：`tests/cognitive_engine_test.py` 24 项——高并发抢占、预测失败自愈（含有界
  suspend）、上下文饿死、确定性回放、优先级稳定、惊奇分级全投影。

**为什么这个形状比现有方案好（对用户问题的正面回答）**：

| 对比轴 | Pi / Hermes / Claude Code / DSH | 本设计 |
|---|---|---|
| 唤醒 | 每轮都问模型（或靠大 max_turns 自然结束） | 惊奇分级：符合预测的回合零 token；惊奇携带精确 delta 上行 |
| 记忆 | 转录本 + 压缩摘要（信息随摘要损失） | 断言（≤120 字/条）+ 日志真相分家；O(1) 查找，永不膨胀 |
| 表面 | 全量上下文直喂 / 摘要代偿 | 预算化投影 + 剪枝账本（模型知道它没看到什么） |
| 抢占 | 取消令牌散落 | 统一优先级仲裁 + 合成取消回执（回放结构完整） |
| 坏世界 | 模型自己猜 / 人接管 | 读-only 重定向探针 + 有界自愈 + needs_user |
| 差异的前提 | 无 | 全部依赖 Magic Pointer 独有的确定性资产（FrameLease、四守卫、五路锚点、Evidence 八态）——**这些是 Pi/Hermes/CC 没有的，所以它们抄不走这个组合** |

诚实的代价：本设计的收益只在"环境可被确定性验证"的任务里成立（这正是本产品
短任务边界内的全部场景）；开放式探索（OSWorld 类）仍然要模型全量介入，那部分
不假装省。

---

## 5. DSH 聊天渲染 100% 移植（本批已交付）

用户要求"GUI 对话框里的设计……完全 100% 复制 deepseek-harness"。已交付：

- `electron/renderer/dsh_tokens.css`：DSH `--dsw-*` 令牌平台浅色档逐条展开
  （DeepSeek-50 用户气泡、bluish 中性刻度、red/amber/green 状态色；暗色块被有意
  丢弃——遵守"严禁暗黑模式"）。
- `electron/renderer/dsh_chat.css`：`MessageItem`（r22 右对齐蓝气泡）、
  `MessageIconActions`（28px 复制键 + 1s 对勾 + 时钟 hover 显现）、`DisclosureRow`
  （24px 行骨架 + 图标↔chevron hover 预览）、`ToolRow`（标题 14/24 次级灰 + 2×2
  分隔点 + FILL 截断摘要 + 运行扫光 + IN/OUT 卡 + 错误红摘要 + Inspect 药丸）、
  `ReasoningRow`（Think 行 + 扫光 + 22px 缩进灰字展开体）、`StateDot`（10px 光晕 +
  像素追逐）、`turnStatus` 渐变字、`turnErrorRow`、重试行。
- `electron/renderer/dsh_chat.ts`：原生 DOM 渲染器（无框架、无 innerHTML，
  XSS 结构防护与舞台同款），`toolRowModel` 移植（variant 分类/标题/摘要/文件路径/
  IN/OUT 体推导）。
- 接线：Studio 聊天页整条改用 DSH 模型（用户气泡 + 助手正文/Think/工具行）；
  发送中态 = `turnStatus('Thinking')` 渐变字；失败 = 红点错误行；后台任务补丁按
  同款 cardId 就地 replaceWith 重画该轮（`LiveCards.track` 契约保留）。
- 数据缝：`MagicPointerTurn` 增 `thinking` / `events` 字段；旧 `trace` 降级映射为
  通用工具行。**结构化事件（name/arguments/result/isError）持久化进
  conversation_store 是下一批（桥侧 receipts→trace 落盘）。**

---

## 6. 本批验证与 git

- Python：`tests/cognitive_engine_test.py` **24 passed**（新基准套件）。
- Node：DSH 聊天契约 + 视觉契约 + 后台任务卡契约单独复跑通过；全量见交付记录。
- typecheck：strict 五配置通过。
- 未动：FrameLease 时序、四守卫、权限门、写回链路——本批是"仲裁与渲染"层，
  不碰确定性不变量。
- 未升版本、未 sync（用户裁决：最终批统一交付）。
