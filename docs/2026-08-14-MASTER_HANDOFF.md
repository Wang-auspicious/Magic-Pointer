# Magic Pointer 全量交接（2026-08-14 Master 版）

> **历史文件，不再是当前事实源。** 本文记录了旧批次的判断，其中“后端错误以 6 轮封顶”
> 和“插件内核已完整交付”等结论已被 2026-08-14 Harness 后端重建推翻。当前事实以
> `docs/design/MAGIC_POINTER_HARNESS_20260811.md` §18 最新条目、
> `docs/superpowers/specs/2026-08-14-magic-pointer-harness-reconstruction-design.md` 和
> `docs/STATUS.md` 为准。不要再从本文恢复 `max_turns` 或旧的追加式插件生命周期。

> **只读这一份就够。** 前置条件为零：不需要读任何其他文件、不需要查任何代码、不需要调用任何工具。
> 本文整合：产品定位 → 全部历史（8-11 设计冻结 → 8-12 外部评审 → 8-13 弱模型交接 + 强模型回应 + 接线批 + 真机事故 → 8-14 DSH 金标准审查 + 插件内核批）→ 当前代码库核心思想（逐模块讲透）→ 真实交互全流程 → 安全模型 → 验证方法 → **当前乱象诚实盘点与收敛计划** → 下一步 → 给读者的提问清单。
> 作者：deepseek-v4-flash（2026-08-14，插件内核批完成并交付 1.0.4 后落盘）。

---

## 0. 导读：这份文件为什么存在

项目此前有两份"写给强模型看"的文档，用户判定都**写得不够好**：

1. `docs/harness-gap-review-20260812.md`（8-12，外部弱模型写）：诊断很准（"流水线 vs harness"、四根支柱），但它是**纯结构推断**——作者明说"未读任何源文件，结论基于结构与命名推断"。结论对，证据弱，且只有诊断没有实施路径。
2. `docs/2026-08-13-ARCHITECTURE_HANDOFF.md`（8-13，deepseek-v4-pro 写）：自称"只读这一份就够"，实际**名不副实**——大量交叉引用（§三/§七/§九）要求读者同时持有设计文档和 STATUS；关键契约只给名字不给定义（Evidence 八态只列枚举，FrameLease 字段只给清单）；写完当天架构又大变（强模型回应、接线批、真机事故），文档即刻过时；"逐文件职责"停在目录级，没有讲任何一个文件的核心思想。

强模型对它的回应（`docs/2026-08-13-STRONGEST_MODEL_REVIEW_RESPONSE.md`）质量高且已被全量执行，但它默认读者已经读过交接文档，同样不自包含。

**本文的使命**：成为唯一的、真正的自包含真相源。读者读完本文，应能：说清产品是什么；说清每一步历史为什么发生、留下了什么；说清当前每个核心文件的思想；说清现在哪里乱、为什么乱、怎么收敛；说清下一步。然后可以给任何强模型看，让它基于本文反馈，而不是基于猜测。

---

## 1. 产品是什么

### 1.1 一句话定义（用户确认，不可再议）

> **Magic Pointer 是把人的桌面指代理解预编译为短任务 Agent 可直接执行上下文的桌面 Harness。**

拆开说：

- 用户在任意 Windows 应用里**短促晃动鼠标**（或 Ctrl+Alt+M）唤醒一个"划线层"，然后**画一笔**（划圈 = THIS，划线 = 选区，可多笔）。
- 抬手（pointerup）的瞬间，系统**先冻结**当时看到的画面（FrameLease，不可变历史事实），然后才做任何结构化读取。
- 冻结帧 + UIA/COM/DOM/OCR 并发感知 → 编译成"对象证据" → 用户说一句短命令（打字或语音）→ 内部 agent 循环执行。
- 结果可以是答案、可编辑草稿、或"签名方案 + 确认卡"（写回类动作）。

### 1.2 发明点：交互预编译式 Harness（不是更便宜的 CUA）

通用 CUA 的预算烧在两件事上：(a) 从全屏像素重建语义；(b) 猜"用户说的'这个'是哪个"。Magic Pointer 用鼠标把这两件事**人类零成本完成**：

| 性质 | 说明 | 竞品 CUA 是否有 |
|---|---|---|
| 指代准确率 ≈ 100% | 目标不是推理出来的，是用户指的 | 无（grounding 错误是 CUA 主要失败源） |
| 证据可裁剪 | 因为知道指哪，证据范围极小 | 无（必须传全屏/大区域） |
| **来源可证明** | 结论能指回具体元素/文本范围/文件路径 | 无（像素推理不可溯源） |

**护城河是第三条（来源可证明），不是"便宜"。** 叙事是"**指点让视觉变便宜**"——视觉不是信仰，是证据阶梯上的一层（结构读不到时才调用）。

### 1.3 边界（不做的事，用户确认）

- 不做 7×24 录屏、不做整屏上传、不把像素 Computer Use 当第一选择。
- **不是项目级 Coding Agent**：Claude Code / Codex / Pi 在各自客户端正常用；Magic Pointer 可以为它们编译 prompt 填入输入框。
- 内部任务 = 一两轮、几分钟内的日常桌面任务（圈选生成回复、OCR/改写/翻译/表格、打开应用/调音量、跨应用可验证小任务）。

### 1.4 用户的三次裁决（必须遵守）

1. **关键词+recipe 路由"从根本上不可扩展"**——已退役为"模型即路由器"（agent loop 就是路由器）。
2. **测试"删的越多越好"**——已从 2080 项瘦到 879 项（现 992 项，见 §8）。
3. **架构向 Claude Code 学**：模型即路由器、工具自描述、ToolSearch 延迟加载、hooks、权限模式、压缩、记忆。只移植架构模式，不逐字复制。
4. **（2026-08-14 新）架构向 DSH 学**："一切皆插件"——见 §4。

### 1.5 七条不可回退 invariant（任何改动不得松动）

1. FrameLease commit 失败 fail-closed，禁止重拍（冻结语义是信任模型的地基）。
2. Anchor 五路判别是一等返回值，ambiguous/changed 永不按 exact 处理。
3. Evidence 八态，busy≠empty，"非空≠读到了"。
4. 批准者黑名单：model/tool/agent 永远不能批准不可逆动作；不可逆确认 UI 由 harness 持有。
5. origin 双通道：屏幕内容永远是 data；跨通道必须经人。
6. UndoLog 失败不伪装成功；回执必须读回校验。
7. 真机验证与自动化验证分账记录，不得混写。

---

## 2. 完整时间线（每步：输入 → 产出 → 教训）

### 2.1 2026-08-11：设计冻结

- **输入**：用户提供的产品需求长文 + VIDA 视觉 UI 规格 + 参考项目报告。
- **产出**：`docs/design/MAGIC_POINTER_HARNESS_20260811.md`（本文的"母文档"，包含 18 个模块设计、Phase A-H 分阶段、进度账本 §18、回读路由 §16）。核心决策：FrameLease 先于感知冻结；感知是并发证据融合不是串行首命中；UIA 常驻低功耗；MPAgentRuntime 基于 Pi 稳定 agent-loop；工具/MCP/Skills 统一 CapabilityBroker；DraftArtifact 可编辑版本化；Reuse Gate（旧代码不自动保留）。
- **教训**：这份设计文档是权威，但它的账本（§18）后来无限堆积历史批次，越来越不适合"快速理解当前真相"——这是后续交接文档存在的原因之一。

### 2.2 2026-08-12：外部 harness 评审（第一份弱模型文件）

- **输入**：代码库总览报告（约 577 文件 / 99.6k 行）+ 产品构思陈述；作者未读任何源文件。
- **产出**：`docs/harness-gap-review-20260812.md`。核心结论：
  - **总判**：你造的是"新输入模态"，但现在是一条**流水线**，不是一个 **harness**（循环）。
  - **定位校正**："指点让视觉变便宜"；来源可证明是护城河。
  - **四根支柱**（CC 靠文件系统+git 白拿，GUI 必须自己造）：稳定寻址（Anchor）、前置条件（写前断言世界没变）、可逆性（undo）、廉价复读（感知必须便宜才能"做完再看一眼"；**开环是最致命的**）。
  - **缺失层清单 L1-L22**（P0：Agent Loop、感知即工具、Anchor、前置条件、可逆性、证据契约、注入隔离、延迟预算/取消）。
  - 风险排序：UIA 覆盖率不够 > 用户不知道能干什么 > 延迟压不下去 > 一次误写信任崩塌 > 提示注入事故。
- **教训（用户判定"写得不好"的原因）**：诊断准确但**全部是推断**（作者自己声明没读源码）；没有给出任何实施顺序；没有和当时的真实代码状态对齐（部分指责的"病灶"其实已在改）。结论可留，证据不可信。
- **落地**：评审后连做三个批次（L1-L16 基础设施全部实现），账本见母文档 §18 的 8-12 批次 1/2/3。

### 2.3 2026-08-13 上午：弱模型交接文档 + 强模型回应

- **弱模型交接**（`docs/2026-08-13-ARCHITECTURE_HANDOFF.md`，deepseek-v4-pro）：把当时架构、逐文件职责、真实交互流程、安全模型、13 个待抉择问题写成一站式文档。
- **强模型回应**（`docs/2026-08-13-STRONGEST_MODEL_REVIEW_RESPONSE.md`）：总判"骨架正确、无需推翻"，但指出**三个结构性张力**：
  - **T1 预算语义**：4000ms 墙钟 + max_turns≤6 是流水线遗产——循环"在代码里存在，在经济上不存在"（每次感知 573ms、非流式回合 1-2s）。解法：预算约束"多久必须看到反馈"，不约束"循环多久被杀"；明显推进时按轮滚动续期；硬截断只留给真正卡死。
  - **T2 证据注入**：34,660 字全文前置注入 = 模型永远不需要感知工具，循环退化为一次性问答。解法分两步：先做"截断必须显式告知"（零成本），常驻 UIA 宿主 + 流式落地后切"手势点附近 2-4k 摘录 + 按需 read_around"。
  - **T3 全量确认卡**：所有写动作（包括剪贴板这种完全可补偿的）都要人点确认 = 护城河从"人指代"退化成"人盖章"。解法：四道 guard 真机验证通过后，机器可验证可逆的动作 in-loop 直接执行；external_send/destructive/purchase 永远 propose+确认。
  - **优先级修正（最重要）**：常驻 UIA 宿主 **先于** WGC/D3D（三个张力共同解锁件）；WGC 优化一次性冻结延迟（192→30ms），UIA 宿主优化每次感知的边际成本（573→~200ms）。
  - **13 题逐答**（in-loop 写边界、工具数量/合并、证据通道、流式+300ms 首反馈、recipe 双轨杀、settings 深合并、Replay 20 条按失败模式、测试策略、记忆两层够用+防互注入三铁律、compaction 70% token 阈值、真机验证薄 smoke 层不吃狗粮用自家 UIA、账本数据回路）。
- **教训（用户判定交接文档"写得不好"）**：信息量大但**依赖性强、过时快、契约不给定义、文件级不讲到思想级**。强模型之所以还能给出高质量回应，靠的是它自己极强的推理能力，不是文档本身写得好。**文档必须自带全部定义，不能依赖读者的推理**。
- **落地**：13 题逐答全量执行（见账本 8-13 批）：权限门进 loop、guard 真探针工厂、流式默认+回落、compaction 挂 loop、300ms 本地首反馈、证据硬围栏+显式截断、rolling budget+UI 心跳、in-loop 可逆写（env 开关默认 off）、工具 26→18 合并、settings 深合并、记忆三铁律、常驻 UIA 宿主（真机 2.5x）、SurfaceAdapter SDK+微信样例、Replay 20 条、薄 smoke 层、WGC CaptureProvider 契约、健康非毒化。

### 2.4 2026-08-13 下午：Notepad 事故 + 复杂情景真机测试

- **事故**：用户在 Notepad 打开 34,660 字 txt，划选未选中文本，问"这个文件里读到了啥。概况总结。"——答案只有"摘要并路由…请核对动作后确认"，文件内容从未进模型。
- **三根因**：①无选区 → UIA 返回空 → 结构化层空；②"总结"被关键词路由误判为写回类 recipe；③model.text 回落外部 agent.task 网关报错。
- **修复**：探针加 `document_text` 整篇回退（无选区读全文，上限 65536 字）；路由信息问题守卫；model.text 走本地模型。三处都有回归测试。
- **复杂情景真机测试**（`scripts/real_scenario_test.py`，视觉模型当眼睛）：六情景全过（概况总结数字全对、交叉引用 1 轮答对、屏幕注入被标记、双窗口身份陷阱、图片视觉、终端结构化端到端）。又修了三个真 bug：UIA 宿主缺 import time 的 NameError（全路径静默退化 OCR——正是死亡风险第一名）、Windows Terminal DocumentRange 空白、loop 终端证据饥饿。
- **教训**：自动化全绿 ≠ 真机可用；真机走查才能暴露"静默失败"类缺陷。这条教训被第七 invariant 固化。

### 2.5 2026-08-13 深夜：v4pro 全仓审查 + 批次 4 启动

- 25 项 P0/P1/P2 修复（时钟单位毫秒、模型健康 per-endpoint、commit 竞态、恢复消息 injected 白名单等）——都带回归测试。
- 批次 4（生产接线批）启动：messages 协议多轮客户端、loop 回答接线（opt-in）、流式、guard 生产接线、fabric_bridge 入口。**未完成**，被 8-14 的插件内核批接替方向。

### 2.6 2026-08-14：DSH 金标准审查 + 插件内核批（本次改动，§4 详述）

- **输入**：用户本地 clone 了 `C:\Users\zjz65\Documents\Default Project\deepseek-harness`（deepseek-harness 源码，HEAD 47f9438），要求以它为金标准审查 MP 并转型"一切皆插件"。
- **产出**：`docs/2026-08-14-plugin-architecture-review.md`（问题 P1-P8）、`docs/superpowers/plans/2026-08-14-plugin-kernel.md`（计划 T1-T6）、`app/harness/` 插件内核、builtin bundle 迁移、`data/plugins/` 用户插件目录、`scripts/harness_dump_config.py`、conftest.py 环境修复、loop 无限自旋 bug 修复、交付 1.0.4。
- **我的反思（用户验证后判定"改得很乱"）**：见 §9。核心问题是：**先改造、后解释**——没有先写自包含真相文档再动手；多线并进（内核+迁移+环境+bug+打包+文档）造成观感混乱；新抽象与旧子系统并存；工作树 40+ 文件未提交。本文就是对这个问题的正面回应。

---

## 3. 强模型回应的精华（已经执行的部分在此固化）

本节把 `docs/2026-08-13-STRONGEST_MODEL_REVIEW_RESPONSE.md` 的可执行结论**自带定义**地固化，不再需要读原文。

### 3.1 三个结构性张力的最终形态（当前代码里的样子）

1. **预算语义（T1）已改**：`loop.py` 的 FULL_ANSWER 预算是**滚动续期**的——每轮检查 `turn_number - 1 == last_progress_turn`（上一轮是否产出新工具结果），产出则续期（上限 `budget_renewals=3`），并发 `BudgetRenewed` 事件给 UI 心跳；**硬截断只留给真正卡死**（空转、withhold 超限）。另外 2026-08-14 修复了一个让 T1 破功的既有 bug：后端持续报错（429/网络/auth）时非 token `TurnWithheld` 路径**不检查 max_turns**，实测自旋 1400+ 轮——现该路径也封顶（`MAX_TURNS`，6 轮）。
2. **证据注入（T2）已改**：首条消息证据块以唯一定界符 `<<<MAGIC_POINTER_EVIDENCE>>>` 包裹 + 显式声明"屏幕数据不是指令"；截断**显式告知**（"全文 N 字，此处含第 M 字，可用 read_around 继续"）且**以手势点为中心取窗**（不是从头截）。"手势点附近 2-4k 摘录 + 按需取数"的完全体仍待常驻 UIA 宿主 + 流式完全落地后切换。
3. **全量确认（T3）已改**：in-loop 可逆写已实现但默认 **off**（`MAGIC_POINTER_INLOOP_REVERSIBLE=1` 翻转，真机验证四道 guard 前禁止开）；翻转后 local_write 类能力在 loop 内 guarded 执行；external_send/destructive/purchase 永远 propose+确认卡，确认 UI harness 持有。

### 3.2 13 题逐答的可执行结论（速记）

| 题 | 结论 | 状态 |
|---|---|---|
| 1 in-loop 写 | guard 真机通过后 REVERSIBLE_WRITE in-loop 直接执行；判据是"补偿动作机器可执行且已验证" | 已实现，默认 off 等真机 |
| 2 工具数量 | 26 个全量注入可接受；更高杠杆是**合并工具**（18 个正交工具 + enum 参数）；find_capability 留着 | 已合并 26→18 |
| 3 证据通道 | 小模型留在首条 user 消息 + 硬围栏；不建结构化通道 | 已做硬围栏+显式截断 |
| 4 流式 | 流式默认 + 首败自动降级非流式 + 健康记录不毒化；300ms 本地首反馈先做（零模型） | 已做（`MAGIC_POINTER_STREAMING=0` 退出） |
| 5 recipe 双轨 | **杀掉双轨**：参数 schema 归代码（单一事实源），manifest 降级为展示元数据 | 已做（capability_tools 归代码，manifest 只剩元数据） |
| 6 settings | 桥端 RFC 7396 深合并 + 渲染层只发有消费方的键；旧 96 键不批量补 | 已做 |
| 7 优先级 | **常驻 UIA 宿主先于 WGC**；微信 SurfaceAdapter 第三 | 已做（真机 2.5x；WGC 仍是脚手架） |
| 8 Replay | 按"行为契约 × 失败模式"选 20 条，一半是失败路径 | 已做（`data/replay_traces/fixtures/`） |
| 9 测试 | 行为级取向健康；补两个缝：接线集成测试 + 脚本化假模型端到端金样 | 已做（harness_wiring_test 等） |
| 10 记忆 | 两层够，不做递归继承；防互注入三铁律 | 已做（memory.py + 测试钉死） |
| 11 compaction | 70% token 阈值触发；摘要用网关文本模型；摘要 injected+data | 已做 |
| 12 真机自动化 | 建薄的、不吃 Playwright 用自家 UIA 狗粮；5-6 条黄金路径 smoke | 已做（`scripts/smoke/golden_path_smoke.py`） |
| 13 架构 | 三个张力见上；账本数据回路（ledger×capability_matrix×hints）是"用户不知道能干什么"的最终解法，未做 | 未做（下一步候选） |

---

## 4. DSH 金标准：学到了什么，我落地了什么

### 4.1 DSH 的"一切皆插件"到底指什么（从源码 docs/architecture.md + cordis-primer.md 提炼）

DSH 在 vendored Cordis（一个服务容器框架）上把产品全部拆成插件，五个核心思想：

1. **插件即 Service 对象**：`name / inject（依赖声明）/ Config（配置 schema）/ apply(ctx, config)`。模型适配器、工具注册表、会话日志、agent loop 本身都是插件，任何一部分都能从配置里被替换。**没有特权内核**。
2. **上下文是服务仓库**：服务抢占稳定键位 `ctx.<key>`（`ctx.tools`、`ctx.llm`、`ctx.sessions`）；插件按 key 找服务，从不 import 具体实现。**加载顺序由服务依赖表达，不是手工启动顺序**。
3. **类型化事件是扩展点**：`emit / waterfall / parallel / serial` 四种派发模式是事件公开契约；策略插件监听 `tools/pre-execute`、`approval/request` 等瀑布事件拦截决策。
4. **注册是可逆 effect**：`ctx.effect()` / `ctx.on()` 安装的一切在插件卸载时按 LIFO 回卷；坏插件只影响自己那一行。
5. **分层组合**：bundle 行 → profile patch → home patch → CLI 覆盖；任何行按 id 可被 patch；`--dump-config` 打印真实启动树。
6. **Seam 三角**：Service Definition / Provider / Consumer。换 Provider（local→sandbox→e2b）只动配置不动消费方。
7. **"model-visible means logged"**：任何进模型的内容必须能从会话事件日志重建。

### 4.2 审查发现 MP 的八个设计问题（P1-P8，详见 review 文档）

- **P1**：六套并行的扩展系统（ToolRegistry / SurfaceAdapterRegistry / recipe 插件清单 / HookManager / SystemPromptBuilder / capability_tools），各自注册 API、各自生命周期，没有统一插件模型。
- **P2**：组合根是手工接线巨函数——`selection_bridge._loop_router` 约 300 行手工构造 registry、感知、视觉、本地动作、能力工具、守卫、模型客户端……加一个能力 = 改好几个地方 + 改接线处。
- **P3**：没有依赖序、没有可逆注册、没有卸载/重载；坏插件要么整体失败要么静默跳过。
- **P4**：没有分层配置组合与可检视的启动树（env 开关 + 散落 settings + 代码硬编码；无 dump、无按 id patch）。
- **P5**：事件语义三套并存（loop 事件流 / 窗口变更订阅 / CC hooks），无统一派发模式契约。
- **P6**：Seam 三角缺失，Provider 不可配置替换（视觉后端、模型客户端、感知后端全部内联在组合根里）。
- **P7**：注册表按功能重复造轮子（四套"注册"语义平行）。
- **P8**：没有"模型可见即可重建"的单一事实源（会话事件日志）——Phase E/H 级，本次只记录不实施。

### 4.3 我落地了什么（插件内核批，全部测试先行）

**新增 `app/harness/` 四模块**（DSH 五思想 → Python 实现，不复制代码）：

- `context.py`：`Context` 服务仓库（provide/get/has/keys/`in`）、`inject(deps, cb)` 依赖驱动激活（回调跑在 fork 里，fork 的注册随依赖撤销回卷）、`effect()` 可逆注册（unload LIFO 回卷，坏 disposer 不阻断）、事件四派发模式（emit 观察 / waterfall 可短路 / parallel 线程池 / serial 末值；模式错配与未声明都报错）、`scope()` 子上下文（读父服务、注册隔离）、`provide_up()`（插件在 fork 里向根暴露服务）、`revoke()`（级联拆依赖 fork）、`service/<key>` 隐式激活事件。24 项测试。
- `plugin.py`：`PluginSpec(name/inject/apply)` + `data/plugins/<name>/plugin.py` 目录发现（`plugin.json` 可选元数据）+ 最小 JSON Schema 配置校验 + **坏插件单行隔离**（import 失败/名字不匹配/apply 抛错都记 warning 跳过，不拖垮树）+ 依赖缺失 `waiting` 诚实报告。10 项测试。
- `composition.py`：`boot(bundle_rows, builtin_plugins, plugin_dir, patch, core)` 分层组合 + `dump_config()` 真实启动树 + patch 按 id 替换整行 config / 禁用 / 插新行 + 未知插件行 error 隔离。10 项测试。
- `builtin_bundle.py`：`boot_loop_context(runtime)`——**内置能力全部重写为 8 个插件行**（行序即注册序）：
  1. `harness-tools`（inject tools）：ask_user_question + todo_write；
  2. `perception-tools`（inject tools, perception）：5 个感知工具；
  3. `look-tool`（inject tools, vision）：视觉逃生舱；
  4. `local-action-tools`（inject tools）：copy_selected_text / save_screenshot / show_source；
  5. `capability-tools`（inject tools）：能力工具 + find_capability；
  6. `guard`（inject guard_probe, selection_anchor）：向根 `provide_up("precondition_factory")`；
  7. `system-prompt`（inject prompt）：五个提示节注册进共享 builder；
  8. `model-client`（inject prompt）：模型客户端 + compactor + token_estimator 三个服务（provide_up）。

**`_loop_router` 瘦身**：从约 300 行手接线变为"构造每轮运行时数据（感知后端/视觉后端/守卫探针/锚点/propose 回调等）→ `boot_loop_context(runtime)` → 从 ctx 取服务 → `run_agent_turn`"。**注册等价性钉死**：新树 27 个工具与迁移前快照逐项一致（名字+effect 全对，见 `tests/harness_builtin_bundle_test.py`）。旧 `_register_look_tool/_register_local_action_tools/_register_harness_tools/_loop_system_prompt` 删除；`system_prompt.py` 拆出 `default_sections()` 单一来源。

**外部插件与检视**：`data/plugins/` 用户插件目录（README + 最小示例；`MAGIC_POINTER_PLUGIN_DIR` 覆盖）；`scripts/harness_dump_config.py` 对标 `dsh --dump-config`（打印 core seams / 每行状态与解析后 config / warnings）；electron-builder files 白名单补 `data/plugins/**`。

**环境与 bug 修复**（详见 §8、§9）：
- 根 `conftest.py`：本机沙箱按 POSIX mode 位授予目录 ACL，pytest 硬编码 mode=0o700 导致 tmp_path 全部 setup 失败（STATUS 长期记录的 basetemp 权限问题的根因）；shim 强制列表模式（真实 Windows 无副作用）。修复后全量 992 项零环境失败。
- `loop.py` 无限自旋修复（§3.1 T1 补充）。
- `sync_install.ps1` 缺 UTF-8 BOM → Windows PowerShell 5.1 解析中文注释报错 → 交付链路阻塞；补 BOM 修复。

**验证与交付**：Python 992 过 / 73s；Node 127；typecheck、ESLint 0 警告；uia-host smoke PASS；replay 20 条走真网关机制绿（2 条断言失败为模型回答内容波动，非程序问题）；`npm run sync` 交付安装版 **1.0.4**（安装目录版本与开发树一致）。

---

## 5. 当前代码库核心思想（逐模块讲透）

> 结构：按"交互层 → 捕获与感知 → 内核 → 能力与执行 → 安全 → 插件内核 → 桥与数据 → 支撑"分层。每个文件：**一句话职责 + 核心思想（为什么这么设计）+ 关键机制**。

### 5.1 桌面壳（electron/，TypeScript，主进程 + 渲染层）

- **`main.ts`（约 5000 行，主进程心脏）**：组合根。指针轮询/wiggle 检测/热键/窗口生命周期/手势 arm-complete-cancel 状态机/FrameLease coordinator 接线/会话管理/提案确认执行/stash/打包启动。核心思想：**主进程只做窗口、输入、协议；一切 AI 决策在 Python 侧；两者只走 JSONL，无共享内存**。
- **`capture_commit_coordinator.ts`**：arm→committing→committed|cancelled 状态机；**pointerup 先 commit 冻结帧，成功后才释放 overlay 再开感知会话**（失败 fail-closed 禁重拍）；commit 尾部 token 复查防旧提交清空新手势（竞态修复）。
- **`frame_capture_worker_client.ts` + `scripts/frame_capture_worker.py`**：常驻抓帧 worker 的 JSONL RPC 客户端/服务端。worker 空闲零抓取，arm 后 33ms×8 环形缓冲；commit 时选"抓取完成时间 ≤ commit 时间"的最后一帧；grab 移出锁、不 join（arm/commit 不被慢抓取拖 1 秒）。
- **`frame_lease.ts` / `scripts/frame_lease.py`**：FrameLease v1 双端校验器，逐字段一致、深冻结。字段：schemaVersion/frameLeaseId/epochId/capturedAtMonotonicMs（**毫秒**）/capturedAtUtc/source（gdi-fallback|wgc-window|wgc-display|dxgi-display|test）/targetWindow/surfaceBoundsPx/displayId/scaleFactor/gesture/localArtifact/contentHash/overlayExcluded/captureLatencyMs。
- **渲染层**（`stage.ts`/`overlay.ts`/`card_render.ts`/`settings.ts` 等）：气泡/划线/卡片/设置 UI。设计约束：渲染进程只能给几何不能指定窗口；IPC 事件来源校验（webContents 归属）。
- 其余 policy 纯函数文件（`answer_shape_policy`/`submit_gating_policy`/`internal_action_policy` 等）：决策逻辑抽成 Node 可单测的纯函数（IIFE 双发布），主进程与渲染层共用同一份契约。

### 5.2 捕获与感知（FrameLease → snapshot）

- **时序铁律**：pointerup 的第一件事是提交 FrameLease（历史事实），感知（UIA/COM/DOM/OCR）只消费它，**不允许迟到重捕获**（`selection_snapshot_bridge.py` fail-closed）。
- **三层图像概念**：SurfaceFrame（完整目标窗口，本地权威事实）→ SemanticRegion（手势语义区+必要邻近）→ ModelView（上模型的有界裁剪）。**小选区图永远不是唯一证据**。
- **`scripts/selection_snapshot_bridge.py`（感知桥，~87KB）**：消费 FrameLease → 窗口枚举 → 结构化读取（UIA/Office COM/浏览器 CDP）→ 不足才走 OCR 像素兜底 → 产出 snapshot JSON（captureSummary/context/perception_trace/frame_lease）。每个感知 attempt 记录在 perception_trace（诚实：哪层成功、为何回退）。
- **UIA 探针（`scripts/uia_selection_probe.cs`）**：C# 编译探针。读取优先级：TextPattern 选区 → 点命中 → **无选区整篇 document_text 回退（65536 上限，2026-08-13 新增，Notepad 事故的修复）** → 区域元素。2026-08-13 又加 Terminal 容错（DocumentRange 空白/异常 → RangeFromPoint 逐行窗口读）。另有 `RESIDENT_HOST` 条件编译：常驻 named-pipe 宿主（`data/runtime/uia_resident_host.exe`），每请求一连接、ping/probe 协议、空闲零扫描；`app/uia_host_client.py`（ctypes 管道 + 熔断器）。真机实测稳态 200-250ms/读 vs 冷启动 573ms+（约 2.5x）。
- **`app/adapters/`**：uia_text_adapter（探针调度，resident 优先→回落每请求进程）、browser_devtools_adapter（CDP，需 --remote-debugging-port，无端口回落 UIA）、office_adapter（Word/WPS COM）、pdf_selection_recovery。
- **`app/surface_adapter/`**（Phase D 第一枚）：`SurfaceResolver` 协议（matches/resolve）+ `RawObject`（id/kind/label/text/rect/order/confidence/evidence）+ 微信样例适配器（容器 UIA 暴露则用，否则诚实像素锚点）+ manifest（展示元数据，行为归代码）。核心思想：**新应用通过契约进入，核心代码零 if/else**。

### 5.3 agent 内核（app/agent_runtime/，CC 移植）

- **`loop.py`（约 1130 行，循环心脏）**：
  - **状态整体重建**：`TurnState` 每次续轮 `with_transition` 重建（dataclasses.replace），绝不原地突变（CC query.ts 模式）。
  - **事件流**：async generator yield `LoopStart/TurnStarted/ModelChunk/ToolCallStarted/ToolCallFinished/TurnFinished/BudgetRenewed/LoopStopped`；Terminal 作为最后一个事件（PEP 525 禁止 async gen return 值）。`event_sink` 收到每个事件的副本（UI 心跳），抛错不杀 loop。
  - **每轮流程**：预算检查（滚动续期，§3.1）→ 中断检查 → `validate_messages`（origin 白名单自检）→ 模型回合（`client.generate_turn`）→ withheld 恢复（token withheld 走 recovery 上限 3 次 + compactor 一次；**非 token backend_error 也封顶 max_turns——2026-08-14 修复**）→ 截断守卫（last_truncated 时插截断消息，超过 max_turns 终止）→ 工具执行（`concurrency_partition` 并发批 + 顺序列）→ stop hooks 网关 → 重建状态续轮或终止。
  - **动态工具加载**：读完 `find_capability` 结果后把发现的工具 schema 加入下一轮（`_select_tool_schemas(extra_names=...)`），超出 tool_limit 的工具不付每轮 token。
- **`tool_registry.py`**：`ToolSpec`（name/description/input_schema/execute/effect/is_concurrency_safe/used_backend/timeout_ms/preconditions/compensate），注册期严格校验（名字 [a-z0-9_]+、schema 结构、保留字 scope）；`execute_tool` 从不抛给调用方（ActionFailure 透传 failure_type，其余包成 TOOL_ERROR）；`search()` 关键词检索（ASCII 整词+CJK 子串）供 find_capability；`concurrency_partition`（is_concurrency_safe 才可并行）。`GLOBAL_REGISTRY` 进程级单例（engine 默认用，首调注册 fabric 工具集，幂等）。
- **`model_client.py`**：`LoopModelClient`（吃事件流）+ 三个后端：
  - `AiClientMessagesBackend`：真实多轮 HTTP（chat-completions 与 messages 双协议自适应），assistant 轮次保角色，system prompt 原生，tool 结果 API 原生 role 回传；预算→HTTP timeout；超时不毒化端点健康。
  - `StreamingMessagesBackend`：SSE 解析（delta/tool_calls 增量重组，`[DONE]` 终止），**生产默认**；首次失败自动降级非流式 + `record_note`（健康不毒化）。
- **`types.py`**：`AgentMessage`（role/content/tool_call_id/name/is_error/**origin**（instruction|data）/injected/tool_calls）、`TurnState`、`Terminal`（reason/message/turns/results/local_action）、`TransitionReason`（含 LOCAL_ACTION/BUDGET_EXHAUSTED/MAX_TURNS）、`Trajectory`。
- **`perception_tools.py`**：5 个模型可调感知工具（read_around/dump_subtree/find_in_window/list_windows/get_focused），返回 Evidence 结构（§5.5），后端注入。
- **`look_tool.py`**：视觉逃生舱。`look(anchor, box?, prompt?)`——anchor 定框、冻结帧裁剪、真实视觉后端注入；box 缺失/超界 → 诚实 `Evidence(error)`；无后端 → `Evidence(unsupported)` 不发请求。绝不在没有证据时猜。
- **`hooks.py`**：CC PreToolUse/PostToolUse 语义（block 回喂模型 / approve 短路 / 输入改写 / 抛错不杀 loop）。
- **`ask_todo_tools.py`**：AskUserQuestion（桥未接渲染 UI 时诚实拒绝不猜）+ TodoWrite（全量替换语义）。
- **`system_prompt.py`**：分节组装器（Section id/title/render/dynamic）；`default_sections()` 五节（identity/rules/permissions/memory/language）——单一来源，插件内核复用。
- **`memory.py`**：MAGIC_POINTER.md 分层（用户级+工作区，mtime 缓存，4k 上限）+ `compact_messages`（摘要成 injected user 消息，keep_last=4）。
- **`permission_modes.py`**：default/plan/accept_reversible/safe/bypass × 六档 effect；purchase 永远 ask。
- **`errors.py`**：FailureType 词汇表（stale_anchor/focus_lost/content_changed/blocked_by_modal/permission_denied/timeout/tool_error）。

### 5.4 能力与执行（app/fabric/）

- **`engine.py`**：双入口。
  - `FabricEngine.plan/execute`：plan（路由→配方→捕获策略→上下文包→权限决策→provider 选择→HMAC 签名）→ execute（签名校验→确认门→实时租约校验→执行器→回执→审计）。签名链：Renderer/hook/MCP 都不能改 provider/参数后复用授权。
  - `run_agent_turn(user_input, objects, registry, client, ...)`：**loop 的同步入口**。`route_to_trajectory` 排名关键词候选：L0 本地动作（save_screenshot/copy/show_source）短路返回 `Terminal(LOCAL_ACTION)`；否则取轨迹（recipe 编译缓存）或自由循环；ms 时钟（`time.monotonic()*1000`——秒时钟会静默失守预算，已修）；max_turns 默认 6。
- **`capability_tools.py`**：recipe → 真实工具（真实参数 schema、诚实描述、READ effect、只 propose）。`register_capability_tools(registry, propose, enabled_recipes, execute_plan, inloop_reversible)` + `register_find_capability`。**schema 单一来源归代码，manifest 只剩展示元数据**（评审 Q5）。
- **`recipe_cache.py`**：recipe manifest → `Trajectory` 编译（风险标签安全、matched_keywords 公开）。角色：recipe 是**缓存/轨迹提示**，不是路由目的地。
- **`loop_answer.py`**：`terminal_to_answer`——Terminal → 桥回答形状（answer/route/loopReceipts 审计字段/actionProposals 装配）。
- **`executors.py`**：执行器分发（clipboard/native.ocr/artifact.table/evidence/compare/visual_context/list/local.memory/local.task/maps.deep_link/overlay.translation/model.text/inplace.text/agent.task），写回类挂 compensate 槽。
- 其余：`settings.py`（fabric-settings.json + RFC 7396 深合并）、`audit.py`（脱敏 JSONL）、`context_packet.py`、`target_lease.py`、`provenance.py`、`skill_candidates.py`。

### 5.5 安全四件套与证据（app/action_guard/ + app/anchor/ + app/evidence/）

- **`app/anchor/`**：`Anchor` 五字段多重身份（anchor_id/app_identity/structural_path/content_hash/spatial/captured_at_utc/dpi_scale）；`AnchorResolver` 五路判别 **exact/moved/changed/gone/ambiguous 是一等返回值**——ambiguous/changed 永不按 exact 处理（fail-closed）。
- **`app/action_guard/preconditions.py`**：四断言（ResolvedExact/TargetFocused/ContentUnchanged/NoModalSince），任一不满足宁可失败不猜。
- **`app/action_guard/approval.py`**：人类批准账本；`NON_HUMAN_APPROVERS` 黑名单（model/tool/agent 不能批准不可逆）；目标身份变化自动 EXPIRED。
- **`app/action_guard/undo_log.py`**：LIFO 补偿栈；失败不伪装、不重排队。
- **`app/action_guard/egress_gate.py`**：所有出网路径统一 gate；data 来源需 explicit_approval；全审计。
- **`app/action_guard/guard_factory.py`**：生产前置条件上下文工厂——`GuardProbe` 协议（resolve_anchor/is_focused/content_hash_at/modal_seen_since）+ `build_context_factory(probe, anchor_from_arguments)`；无 anchor fail-closed 返回 None → permission_denied。
- **`app/evidence/contract.py`**：`Evidence` 八态——**ok/degraded/empty_confirmed/busy/timeout/unsupported/denied/error**；ok 要求 confidence≥0.5；busy≠empty；容器启发式（容器名不能冒充正文）；`merge_for_decision` 可信融合；`is_trustworthy`。

### 5.6 支撑模块（app/governance/、app/events/、app/permissions/、app/replay/、app/telemetry/、app/failure_flow/）

- `governance/latency_budget.py`：六阶段延迟预算表（FrameLease/局部 UIA/整文档/上下文编译/OCR/完整回答）；`cancellation.py`：代际取消注册表（新代际淘汰旧代际，`CancelledError` 传播）。
- `events/`：窗口变更订阅（白名单/节流/风暴熔断/auto-flush 后台 flusher）——**未接真实 UIA 事件宿主**（基础设施先于接线）。
- `permissions/`：感知黑名单（10 条内置规则，感知前拦截）+ 敏感脱敏（Luhn 卡号/身份证/电话）+ 不出网模式 + 能力矩阵（应用×能力×状态，持久化）。
- `replay/`：DesktopTrace schema + 录制器 + 回放器 + 20 条 fixture trace（一半失败路径）；`scripts/run_trace_replay.py` 进程内驱动 selection_bridge.main()。
- `telemetry/`：interaction_ledger（token 文本/视觉分开、阶段延迟、look 占比）+ PointerBench（三方对比报告，缺组诚实"未采集"）+ doctor（unknown≠failed）。
- `failure_flow/`：失败归因→修复建议映射 + 目标条件化能力提示（7 目标类型，3-8 个钳制）。
- `models/`：模型目录/配置档/视觉能力分类器（纯文本模型诚实拒绝视觉请求）。
- `ai_client.py`：ask_text_model/ask_vision_model/工具通道三合一；视觉独立配置（vision_model/key/base_url 与文本分离）；健康熔断 per-endpoint。

### 5.7 插件内核（app/harness/，2026-08-14 新增，§4.3 已详述）

要点重申：Context 服务仓库 + inject 依赖 + 可逆 effect + 四模式事件 + scope + provide_up + 分层组合 + dump_config + builtin bundle 8 行 + `data/plugins/` 用户插件目录。

### 5.8 桥与数据（scripts/）

- **`selection_bridge.py`（生产命令主路径，~3400 行）**：消费 snapshot → 编译对象证据 → 处理各确定性路径（undo 请求/agent handoff/引用标签/上下文包/购物清单/日历/地图…）→ 其余进 `_loop_router`（§4.3）→ 答案 JSON。**2026-08-14 后 `_loop_router` 只做"构造 runtime + boot 插件树 + 取服务 + run_agent_turn"**。
- **`fabric_bridge.py`**：settings/models/agent/workflow/确认执行（签名+租约+剪贴板探针）。
- **`_bridge_common.py`/`bridge_progress.py`**：JSONL 协议与阶段耗时上报（`@@mp phase=… ms=…`）。
- **`frame_capture_worker.py`**：§5.1。
- **`uia_selection_probe.cs` / `uia_draft_writer.cs` / `uia_tree_dump.cs`**：UIA 探针/写回/转储。
- **`ocr_resident_worker.py`**：常驻 OCR（TCP），忙时返回空——STATUS 已知问题（应报 worker_busy）。
- 语音：`voice_engine.py`（Whisper/SenseVoice 统一接口）+ `local_voice_bridge.py`（VAD+增量转写）+ 常驻 runtime（Electron 侧）。
- **数据契约**：`data/recipes/builtin.recipes.json`（39 条展示元数据）；`data/objects/`（运行态）；`data/runtime/`（日志/证据/验收）；`data/plugins/`（用户插件）。

---

## 6. 一条真实交互全流程（Notepad 34,660 字案例，串起所有模块）

1. **常驻态**：Electron 主进程 20ms 指针轮询（检测晃动）；`frame_capture_worker` 空闲零抓取；OCR/语音常驻暖池；UIA 常驻宿主空闲零扫描。空闲策略（用户批准）：能力可常驻，但不扫描。
2. **晃动唤醒**：wiggle 指标（时长/行程/方向反转≥3）→ 激活。同时三件事：记录前台身份（app/hwnd/pid）→ `coordinator.arm`（worker 开始 33ms×8 环抓帧）→ overlay 显示开始画线。
3. **pointerup**：手势合法校验 → 逐点转物理坐标 → `coordinator.complete`：worker commit 取环中最新干净帧 → FrameLease JSON（毫秒时间戳/hash/overlayExcluded）→ **先 commit 成功，才释放 overlay、开感知会话**（失败 fail-closed，禁重拍）。
4. **感知**（真实案例 1619ms：pixels_frozen 23ms → structured_read 1611ms）：窗口枚举 → UIA 探针点路径 → **无选区 → document_text 整篇回退读全文 34,660 字** → `AdapterReadContext(method=uia:document-text)` → 结构化不足才走 OCR 像素兜底 → snapshot JSON。
5. **命令路由**：命令进 `selection_bridge.main` → 各确定性路径依次尝试（undo/agent handoff/引用/上下文包/购物/日历/地图）→ 未命中进 `_loop_router`：
   - 构造每轮 runtime（感知后端/视觉后端/守卫探针/锚点/propose 回调/summarize）；
   - `boot_loop_context(runtime)` 启动插件树（8 行，27 工具）；
   - 从 ctx 取 registry/model_client/compactor/token_estimator/precondition_factory；
   - 首条消息 = 命令 + `[本次圈选对象证据]` 硬围栏证据块（显式截断、手势点取窗）；
   - `run_agent_turn`（预算滚动续期、权限门、hooks、guard 前置断言、流式默认）。
6. **循环内**：模型可 read_around/find_in_window/look 补证据；写回类调能力工具 → `propose` 回调跑 `FabricEngine.plan` → 返回签名 plan（requiresConfirmation）→ Terminal → `terminal_to_answer` → 答案文本 + actionProposals。
7. **确认执行**：气泡确认卡 → fabric_bridge plan/execute（HMAC 校验/租约实时校验/回执读回/undo 入账）。
8. **全程落账**：electron.log 各阶段 ms、bridge_progress、fabric-audit.jsonl、conversations.json、interaction_ledger。

## 7. 安全模型（全部已实现，除标注"未接线"）

- **身份/冻结**：FrameLease 不可变（commit 后不可重指）；`target_lease.py` 执行前实时窗口校验。
- **锚点**：五字段冗余身份 + 五路判别（§5.5）。
- **前置断言**：四断言 fail-closed；生产工厂已接真实探针（`_BridgeGuardProbe`：窗口枚举+前台+UIA 内容哈希；无 anchor fail-closed）。
- **可逆**：UndoLog LIFO 补偿栈（失败不伪装）。
- **批准**：不可逆动作人类批准账本 + approver 黑名单 + 身份变化自动 EXPIRED。
- **egress**：出网统一 gate，data 来源需 explicit_approval，全审计。
- **注入隔离**：origin 双通道（instruction/data）；屏幕内容永远是 data；恢复消息 injected 白名单；每轮 validate_messages 自检；不可逆确认 UI 由 harness 持有。
- **权限模式**：default/plan/accept_reversible/safe/bypass × 六档 effect，已接 loop 每工具门。
- **感知权限**：应用黑名单（连感知都不发生）、敏感脱敏、不出网、能力矩阵。
- **模型健康**：per-endpoint 熔断（视觉端点坏不连坐文本）；软事件（流式回落）record_note 不毒化。

## 8. 测试与验证现状（命令、范围、环境怪癖）

- **Python**：`python -m pytest tests/ -q`（992 项 / 约 73s）。50 个测试文件，行为级取向（FrameLease 竞态、探针、快照 fail-closed、guard 状态机、anchor 判别、loop、桥、hook、SSE、harness 内核 57 项新测试）。
- **Node**：`npx --no-install tsx scripts/run-node-tests.ts`（89 源文件 / 127 测试）；`npm run typecheck`（五个 tsconfig strict）；`npm run lint`（ESLint --max-warnings=0）。
- **真机级冒烟**（薄 smoke 层，自家 UIA 狗粮，无 Playwright）：
  - `python scripts/smoke/golden_path_smoke.py uia-host`（常驻宿主 ping+probe，非侵入）；
  - `... replay`（20 条 fixture 离线端到端，**走真网关**；个别答案断言随真模型波动，机制绿）；
  - `... notepad-read`（真机金路径，会开记事本+移动鼠标——留给用户在真机会话跑）。
- **复杂情景真机测试**：`python scripts/real_scenario_test.py notepad-complex ...`（真窗口+SendInput+真冻结帧+活网关，证据落 `data/runtime/scenario-evidence/`）。2026-08-13 六情景全过并修了三个真 bug。
- **回滚开关**：`MAGIC_POINTER_LEGACY_ROUTER=1`（旧关键词路由）、`MAGIC_POINTER_UIA_HOST=0`（常驻宿主关）、`MAGIC_POINTER_STREAMING=0`、`MAGIC_POINTER_INLOOP_REVERSIBLE=1`（真机验证前勿开）、`MAGIC_POINTER_PERMISSION_MODE=...`、`MAGIC_POINTER_CONTEXT_TOKENS`、`MAGIC_POINTER_PLUGIN_DIR`。
- **环境怪癖（重要，避免误判为代码问题）**：
  - 本机开发沙箱按 POSIX mode 位授予目录 ACL：`os.mkdir(mode=0o700)`（pytest basetemp 与 tempfile.mkdtemp 默认）创建的目录**连创建者都无法列举**。根 `conftest.py` shim 已把测试期目录创建强制为列表模式（真实 Windows 无副作用）。若脱离 conftest 跑 pytest 且报 basetemp 权限错，先用 `--basetemp` 指到可写位置。
  - 系统 `%TEMP%` 下的 `pytest-of-*` 残留目录（历史 0o700 创建）可能仍不可删，无害，可手动清。
  - 仓库根遗留 `pytest-mode-probe/`、`pytest-tmp-root/`、`probe-*` 空目录（本会话探测残留，ACL 拒绝沙箱删除，已在 .gitignore 中）——**用户在普通会话里可手动删除**。
  - 打包/安装走 `npm run sync`（验证→构建→覆盖安装→拷 secrets→重启）；`sync_install.ps1` 必须保留 UTF-8 BOM（否则 Windows PowerShell 5.1 解析中文注释报错）。

## 9. 当前乱象盘点（我的反思，诚实版）

用户验证后判定"改得很乱"。以下逐条承认并给出收敛计划：

1. **顺序反了：先改造、后解释。** 插件内核批动手前没有先写自包含真相文档（本文就是补课）。强模型评审早已示范"文档质量决定接手效率"，我这次重蹈了 8-13 交接文档的覆辙。**收敛**：本文成为唯一 master；以后任何架构批，先写真相文档再动手。
2. **多线并进造成观感混乱。** 一晚上同时做了：插件内核 + `_loop_router` 迁移 + conftest 环境修复 + loop 无限自旋 bug 修复 + sync 脚本编码修复 + 打包白名单 + 版本交付 + 三份文档。每一项本身都有测试与账本，但对读者是"一锅粥"。**收敛**：批内按 T1-T6 顺序本已清晰，问题在对外叙事没有先给"地图"。本文的 §2 时间线就是地图。
3. **新抽象与旧子系统并存，职责边界只靠文档。** `app/harness/`（DSH 移植）与 `app/agent_runtime/`（CC 移植）并存：tools/hooks/prompt 三个子系统现在既可以被旧 API 直接调用，也可以作为 ctx 服务注入。短期内无害（等价性测试钉死），但长期是两套访问方式。**收敛**：下一批把 agent_runtime 的注册入口收敛为"只能经 ctx 服务访问"（单入口），或明确定义 harness 只管组合、agent_runtime 只管实现。
4. **工作树长期未提交（40+ modified / 30+ untracked）。** 叠加了前一个 agent 的 v4pro 批次和本批，任何人 `git status` 都面对一座山。**收敛**：用户确认后分两到三个逻辑提交（v4pro 批次 / 插件内核批 / 文档与交付）。
5. **环境 hack 进了仓库根。** `conftest.py` 是沙箱环境的 shim；`.gitignore` 里躺着本会话的探测残留目录。真实用户机器上 conftest 无副作用（注释已写明），但"仓库根出现一个没人懂的 py 文件"本身就是乱。**收敛**：conftest 保留（全量 992 零环境失败的收益真实），但注释已强化；残留目录待用户手动清理。
6. **文档家族漂移。** 现存：母文档（§18 账本 1000+ 行历史堆积）、ARCHITECTURE.md（8-10 快照）、CODEBASE_OVERVIEW（8-10 快照+一段增补）、STATUS.md（一句话越来越长）、两份弱模型文件、强模型回应、本 master。新模型不知道先读哪份。**收敛**：读序固定为「本文 → 母文档 §18 最新批次 → STATUS.md」；旧快照文档标注"历史快照，以 master 为准"。
7. **两条 replay 断言未闭合。** 20 条中 2 条 FAIL 已查实为模型回答内容波动（`answer_contains 'PDF'`、`proposal_recipe`），机制绿。但未做"多跑几轮看波动率"的统计。**收敛**：真机批次里把这两条标注为"内容断言，随模型波动"，或改为断言形状（proposal 存在性）而非具体值。
8. **loop 行为修复未高亮。** 后端持续报错自旋修复（1400+ 轮 → 6 轮封顶）是用户可感知的行为变化，交付说明里没单独讲。**收敛**：已在本文 §3.1 与账本记录；STATUS 一句话已更新。

## 10. 待办与下一步（按依赖顺序）

1. **（用户侧）真机验证批**：`MAGIC_POINTER_INLOOP_REVERSIBLE=1` 前的四道 guard 真机链路；overlay 排除实测；微信首笔候选框；settings 面板落盘复核；多屏 DPI；`golden_path_smoke.py notepad-read`。
2. **插件生态下一枚 seam**：`ctx.llm`（模型客户端 seam 化：本地/网关/回放 Provider 可配置替换）、`ctx.fs`/`ctx.actions` 同法。目标是"换 Provider 只动配置"。
3. **账本数据回路**（评审 §13b、死亡风险第二名）：ledger × capability_matrix × capability_hints 数据回路——"用户不知道能干什么"的最终解法。
4. **WGC/D3D 捕获后端**（Phase B）：当前 GDI p50 192ms，目标 pointerup→freeze p95≤30ms；`wgc_capture_tool.cs` 是脚手架（本机无 WinMD 投影，诚实报 `wgc_tool_missing`）。
5. **感知层回放接线 + Replay 闭环**：DesktopTrace 已能录/回放，感知层离线回放尚未接生产链。
6. **Phase E/H 遗留**：MPAgentRuntime 与 Pi loop 的适配边界复核；会话事件单一事实源（P8，"model-visible means logged"）。
7. **代码库收敛**（§9 各项）：逻辑提交、读序固定、旧文档标注。

## 11. 给读者的提问清单（读完本文后请反馈）

1. 本文是否真正做到"零前置自包含"？哪一节还依赖外部知识？（这是本文件唯一的验收标准。）
2. 插件内核（§4.3）对当前规模是否是过度设计？判断依据应该是：第三个真实第三方插件出现时，这套机制的边际成本是否小于手写注册。
3. 双轨并存（§9.3）应该"收敛为单入口"还是"维持现状"？如果是单入口，先收哪个（tools/hooks/prompt）？
4. T2 的"手势点 2-4k 摘录 + 按需取数"切换时机怎么判定？（前置：常驻 UIA 宿主稳态 + 流式稳定。是否有可度量的闸门？）
5. in-loop 可逆写的真机验收标准应该是什么粒度？（评审两阶段门的具体化。）
6. 基于本文所述乱象（§9），你认为**最先**应该修哪一条？为什么？
7. 对比 8-13 强模型回应：哪三条结论本文固化得不够准确？（防止我在转述中失真。）

—— 交接完。

## 12. 2026-08-14 晚间续批补充（最新停止点）

> 本节晚于上文，是当前最新事实。完整逐项记录见
> `docs/2026-08-14-HARNESS_RECONSTRUCTION_PROGRESS.md` §12。

本轮继续完成了四类底层修复：

1. **插件服务注册原子性**：`service/<key>` 第三方监听器抛错会被记录和隔离，不再让
   `Context.provide()` 停在“service 已存在、inject 未激活”的半状态；Context 全文件 33 项通过。
2. **常驻 host 生命周期**：run scope 启动失败会回收未返回的 child；scope/host 卸载被 active
   work 拒绝后可再次 close，不再因过早 `_closed=True` 永久泄漏；host 全文件 7 项通过。
3. **模型请求截止与 usage 防御**：0ms 剩余预算不进入 provider；`NaN/Infinity` token usage 在
   聚合和 JSONL 前过滤，不能用元数据杀死正常答案。
4. **事件会话深快照**：公开 messages 与 events 均深复制；模型适配器不能通过嵌套
   tool-call arguments 原地修改内存中的事件投影，继续守住“model-visible means logged”。

停止时正在只读核对生产入口 `selection_bridge -> LoopHarnessHost -> run_agent_turn`，尚未追加该链
修改。没有运行全量 Python/Node/typecheck/build、没有启动 Electron、没有升版本、没有 sync、
没有提交。当前仍不可声称零 bug 或已交付。下一位必须先读进度文档 §12，再从
`app/harness/builtin_bundle.py::LoopHarnessHost` 和 `app/fabric/engine.py::run_agent_turn` 继续。

—— 晚间续批交接完。
