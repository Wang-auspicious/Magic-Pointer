# Agent 榜单打法与开源 Harness 全景调研（2026-08-18）

> 调研工具：agent-reach（Exa 语义搜索 + GitHub 代码搜索 + Jina/WebSearch 网页）。
> 目的：搞清近三个月各类 agent 榜单（综合 / 编码终端 / 桌面 GUI / 记忆专项 / ARC-AGI-3）到底怎么打，
> 各队是"接同类强模型、只拼自研架构"还是"从零造轮子"，并据此校准 Magic Pointer 的方向。
> 所有数字均来自公开来源，vendor 自报与独立复现分开标注。
>
> ⚠️ **2026-08-19 边界更新后重读本文：**文中"MP 是短任务桌面助理""短日常任务定位规避了长程崩塌"的前提已被用户推翻——MP 要正面做长任务。因此本文最有价值的一条不是"规避"，而是靶心：OSWorld 2.0（中位 1.6 小时、平均 318 次工具调用）最强系统仅 20.6% 二值完成，"短任务超人、长任务崩"正是 MP 要打的那一仗；文中"维持信念状态、跟踪中间产物、延迟验证、显式回溯"应作为主战场需求读，不是可选项。

---

## 0. 一句话结论（先给判断）

1. **打榜的胜负手早已不是"谁的模型强"，而是"谁的 harness（scaffold）好"。** 有对照实验证明：同一个模型换三套开源 harness，解题率只差 0–8 个百分点，但**单位解题 token 成本能差 40 倍**。业界的原话是"一个不错的模型配一套很好的 harness，胜过一个很强的模型配一套差 harness"。
2. **绝大多数队伍不从零训模型，而是"接现成强模型 + 自研外壳"**，分三档：as-is 直接用 / **extend（在 Claude Agent SDK、Codex、MCP、hooks、subagent 之上扩展）** / from-scratch 从零写 loop。**extend 是主流**，from-scratch 只在四种硬条件下才对（模型无关性、合规气隙、领域 loop 与编码 harness 形状不符、harness 本身就是你的产品）。
3. **唯一"从零造轮子"造得凶的是 GUI/computer-use 这一支**——但他们造的是**端到端 VLM 策略模型**（UI-TARS、Qwen3-VL、OpenCUA、Fara），不是造 loop；另一半人走**模块化 planner-grounder**，planner 接 frontier 模型、grounder 用专门的 GUI grounding 模型。
4. **记忆专项榜（LoCoMo / LongMemEval）目前基本不可信**：全是 vendor 自跑、自定义评委 prompt，同一系统换个判分 prompt 能差 20–30 分；且**长上下文裸跑常常反超"记忆层"30+ 分**。买/做记忆不该看这些榜的准确率，要看延迟、token、可复现性。
5. **ARC-AGI-3**（交互推理榜）当前 frontier 模型得分 **<1%**、人类 100%。目前最像样的打法是**让编码 agent 维护一个"可执行的 Python 世界模型"，用 verifier 回放校验、随证据积累重构简化，再拿模型去规划**——25 个公开游戏解出 7 个、平均 RHAE 32.58%。
6. **对 Magic Pointer 最直接的一条外部背书**：Windows Agent Arena 官方结论是"**OmniParser（视觉）+ UIA 无障碍树 混合**"是 Windows 屏幕理解的最佳模式，纯像素 OCR/图标检测明显更差。这正是 MP 感知融合（UIA/DOM/COM/Explorer/SurfaceAdapter/OCR/Vision 并发裁决）的路线，方向是对的。

---

## 1. 大家到底在打哪些榜（分类地图）

计算机使用/agent 领域已形成一套稳定的分类坐标系（来源：Adnan Masood《The State of Computer Use Agents》, 2026-07；OSWorld 论文）：

**按环境分：**
| 类别 | 代表榜单 | 说明 |
|---|---|---|
| 桌面 OS | **OSWorld / OSWorld 2.0、Windows Agent Arena（WAA）、WindowsWorld** | 在真实操作系统里跨应用完成任务——与 MP 最相关 |
| 浏览器 | WebArena / VisualWebArena / WebVoyager / Online-Mind2Web | 网页导航 |
| 移动 | AndroidWorld / MobileWorld / A3 | 手机 UI |
| 终端 | **Terminal-Bench / Terminal-Bench Pro** | 命令行/编译/调试 |
| 编码 | **SWE-bench / SWE-bench Verified** | 修真实仓库 issue |
| 综合助理 | **GAIA（HAL 榜）** | 多模态+推理+浏览+工具，450 题分三级 |
| 记忆 | **LoCoMo、LongMemEval、DMR** | 长程对话/长记忆问答 |
| 交互推理 | **ARC-AGI-3** | 无指令、需自己探索规则的回合制环境 |

**按屏幕表征分（对 MP 极其相关）：** 纯像素 vs DOM/a11y 无障碍树增强 vs 混合（Set-of-Marks 在可交互元素上打编号框）。OSWorld 至今把 screenshot / a11y-tree / screenshot+a11y / SoM 四种条件**分开报分**，因为这个选择"实质性改变结果"。

**按 agent 架构分：**
- **端到端 VLM 策略**（UI-TARS 血统）：吃像素、单次自回归直接吐坐标。
- **模块化 planner-grounder**：frontier 推理模型规划语义意图（"点用户头像"），专门的 grounding 模块把意图翻译成屏幕坐标。

---

## 2. 打法一：接同类模型，差异化全在 harness/scaffold

**这是你问的核心。** 答案是：**是的，多数队伍接的是能力相近的大模型，真正拉开差距的是自研 agent 的架构/处理逻辑（harness）。** 有一篇 2026 的对照论文《The Scaffold Effect in Coding Agents》（arXiv:2607.22585）把这件事量化得很干净：

- 固定模型（Qwen 3.6 Plus / MiniMax M2.5），在 **Goose / OpenCode / OpenHands-SDK** 三套开源 harness 上跑 Terminal-Bench Pro 子集。
- **解题率差异（配对）：0–8 个百分点**，多数落在 bootstrap 噪声内。
- **单位解题 token 成本差异：最高 40 倍**（OpenCode ≈ Goose 的 40×）。
- 失败指纹是 harness 级、跨模型复现的：Goose 爱 REASON 失败、OpenHands-SDK 爱 VERIFY/MAX_TURNS、OpenCode 爱 idle-loop/TIME。
- 结论：**"模型名"不是有效的比较单位，"harness–模型对"才是**。榜单应把"单位解题 token""空转轮数""失败类别向量"和通过率并列上报。

《Build Your Own Agent Harness or Buy Claude Code?》（capitalandcompute.net, 2026-07）给了同一枚硬币的另一面，引用了实测的 **13.7 分的 scaffold 落差——"scaffold 比一整代模型进步还值钱"**，并引 Addy Osmani：**"一个不错的模型 + 很棒的 harness，胜过很强的模型 + 差 harness；从零写的 harness 一开始就是那个差 harness。"**

> **对 MP 的意义**：MP 的护城河（确定性感知/权限/执行边界、FrameLease 冻结、证据八态、幂等键、effect sandwich）**正是 harness 层**——这正是"值钱的那部分"。你不需要也不应该去拼模型。

---

## 3. 打法二：从零造轮子，还是站在巨人肩上？

同一篇 build-vs-buy 把选择拆成三档，并给了明确的适用边界：

| 路径 | 做什么 | 适合谁 |
|---|---|---|
| **Adopt as-is** | 直接用 Claude Code / Codex | 大多数人和团队 |
| **Adopt & extend（主流）** | 在 harness 的 SDK 之上扩展：自定义工具、MCP、生命周期 hooks（PreToolUse/PostToolUse/SessionStart）、subagent、skills、权限模型、可恢复 session | 需要接内部系统、教特定工作流、施加组织级 guardrail——"我们要个定制 agent"几乎都是这个意思 |
| **Build from scratch** | 自己写 loop、上下文管理、工具层、验证、guardrail | 只在四种硬条件下才对 |

**"从零"只在这四种情况下正确（成本从来不是理由）：**
1. **模型无关性是硬需求**（各家 SDK 都绑自家模型，这是唯一真正必须自建的理由之一）；
2. **硬合规/气隙**——代码与上下文法律上不能离开你的环境，且没有厂商部署选项能满足；
3. **领域的 loop/动作空间/状态与编码 harness 形状根本不符**（机器人、交易系统、物理过程控制……编码 harness 是"文件+shell+仓库"的形状，硬套是逆纹理）；
4. **harness 本身就是你的产品**——loop 与编排就是你的差异化和护城河，那自建就是生意本身。

> **对 MP 的意义**：Magic Pointer 命中第 3 条和第 4 条。它的领域是"**冻结屏幕像素 → 感知融合 → 手势/指令编译 → 桌面动作**"，动作空间和状态与"文件+shell"的编码 harness 完全不同形状；而且 harness（感知+权限+执行边界）就是产品本体。所以 MP **自建感知/执行内核是对的**；但"通用推理 loop、上下文压缩、工具编排"这类能复用现成 SDK 的部分，**没必要重造**——蓝图里"可编译并填 prompt 进 Claude Code/Codex/Pi"的定位与本条一致。

---

## 4. 各专项榜的真实打法

### 4.1 综合助理（GAIA / HAL 榜）
HAL（Princeton）GAIA 榜把每一行标成 **"Scaffold + Primary Model"**——正是"harness–模型对"作为单位。榜首是 **"HAL Generalist Agent" 这套 scaffold** 分别接不同模型：
- HAL Generalist + **Claude Sonnet 4.5** = **74.55%**（成本 $178）
- HAL Generalist + Claude Opus 4.1 High = 68.48%（成本 $562，更贵却更低）
- 同一套 scaffold 从 GPT-5 到 DeepSeek R1 全试一遍。

**观察**：同 scaffold 换模型，分数和成本都在动，但榜单结构本身就承认 scaffold 是恒量、模型是变量。HAL 团队甚至公告"暂停追新模型，转向测 agent 的**可靠性**"——信号很明确：**准确率见顶，可靠性/成本才是下半场**。

### 4.2 编码 / 终端（SWE-bench / Terminal-Bench）
见 §2。核心开源 harness：**Goose**（Agentic AI Foundation，原 Block）、**OpenCode**、**OpenHands-SDK**（微代理+子代理委派+内部重试+显式验证）。都接 frontier 模型，差异全在上下文预加载策略、工具 API、重试/子代理逻辑。

### 4.3 桌面 GUI / computer-use（OSWorld / WAA）—— **与 MP 最相关**
**这是唯一"造轮子造得凶"的赛道，但造的是感知/策略模型，不是 loop。**

关键事实与数字：
- **表面繁荣，长程崩塌**：OSWorld 从 2024-04 的 12% 涨到 2026-06 的 **85%**（frontier 自报）；但 **OSWorld 2.0**（长程、任务中位人类耗时 1.6 小时、平均 **318 次工具调用**）最强系统只完成 **20.6%（二值）/ 54.8%（部分分）**（Claude Opus 4.8 @500 步）。**"短任务超人、长任务崩"是全field 最重要的一句话。**
- **屏幕理解的最佳配方 = 视觉 + 无障碍树混合**：WAA 官方——"只靠像素 OCR + 图标检测的 agent，明显低于同时用 UIA 树的；OmniParser 的图标描述能力再加一档"。仓库里**明确标注 `--som-origin mixed-omni --a11y-backend uia`（OmniParser + UIA 混合）为"推荐、最佳结果"**。
- **两大架构流派**：
  - 端到端 VLM 策略：**UI-TARS / UI-TARS-2**（多轮 RLVR + 数据飞轮）、**Qwen3-VL**（开源模型里 OSWorld ~67%）、**OpenCUA**（NeurIPS'25）、**ScaleCUA**（ICLR'26 Oral）、**Fara**（微软，前沿 CUA 模型族）。
  - 模块化 planner-grounder：**Agent S3 (Simular)**——planner+grounder + Behavior Best-of-N，OSS 里近人类 SOTA（曾越过 72.36% 人类基线）；grounding 专门模型 **OS-ATLAS / CogAgent / Holo1.5 / Aria-UI / RegionFocus（视觉 test-time scaling，出错后放大重看）**。
- **治理抽象在 harness**：Anthropic/OpenAI/Google 三家架构收敛到同一句话——**"模型永远不碰机器，harness 碰"**；policy、审批、记忆、session 回放、kill switch 全住在 harness 里。CUA loop 是 Capture→Reason→Emit→Execute(client-side)→**Settle（等 UI 稳定）**→Loop。
- **评测本身成了"承重基础设施"**：出现了 **OSWorld-Verified / WebArena-Verified**（标准化重跑），以及一个被命名的病理——**outcome-evidence gap（结果-证据缺口）**：评测只看表面产物、不核后端真实状态。补救方案是 **Evidence-Supported Bounds**，把每次运行标成 **Evidence Pass / Evidence Fail / Unknown**。
- **自进化一派**：**SEAgent（ICML'26，从经验自主学习）**、**EvoCUA（美团）**、**Mano-P**（OSWorld 专项榜第 1，58.2%，纯视觉、可在 Mac mini 本地跑、数据不出机）。

> **对 MP 的两条硬背书**：
> ① **感知融合方向被官方证实是最优**（OmniParser+UIA 混合）。MP 的多来源并发裁决就是这条路的"讲究版"。
> ② **MP 的证据八态 + coversMark/coverageReason + `unsupported: frozen_pixels_unavailable`，几乎就是学界正在补的 Evidence-Supported Bounds（Pass/Fail/Unknown）+ 反 outcome-evidence gap。** MP 在这点上不落后，反而领先于多数只看"截图对不对"的 demo 系统。

### 4.4 记忆专项（LoCoMo / LongMemEval）—— **榜单目前不可信**
多篇 2026 独立评测的一致结论：
- **全是 vendor 自跑**：Mem0 自报 LongMemEval **94.4%**，独立复现（vectorize.io, 2026-03）只有 **49.0%**；另一组把 Mem0 托管版复现出 **57.5%→73.8%**（4-14 更新后），自报仍 93.4%。
- **换个判分 prompt 差 20–30 分**：Zep 自报 LoCoMo ~84%，被 Mem0 复现成 58.44%，Zep 回怼 75.14%——**同数据、不同 pipeline，不可比**。Zep 甚至自己修正把 84% 砍到 58.44%。
- **长上下文裸跑常反超**：2026 成本-性能分析——长上下文模型在 LoCoMo 上比最好的记忆系统高 **35.2 分**、LongMemEval 高 **33.4 分**。原因不玄：全量历史无损，记忆层压缩必然丢信息。
- **该看什么**：延迟、token/次、可复现性、数据驻留（本地 vs SaaS）、"bolt-on 难易"。有个本地优先项目 **Awareness** 号称 LongMemEval R@5 **96.0%**、零 API、一条命令可复现——**"本地优先"正在从妥协变成标杆**。

**开源记忆架构清单（GitHub 实仓）：**
| 项目 | 方法 | 备注 |
|---|---|---|
| **Letta / MemGPT** | agent 运行时（不只是记忆层），分层记忆 | LoCoMo ~83%；自己设计了自己被测的榜 |
| **Mem0** | 抽取原子事实 + 图记忆 | 图记忆在付费档；自报虚高 |
| **Zep** | 时序知识图谱 | SaaS 为主 |
| **thakshak/ReasoningBank** | **把 agent 自己的成功/失败轨迹提炼成可复用的"推理策略"，检索回来指导后续决策，闭环自进化** | 与 MP"从交互中学"最合拍 |
| **openmemind/memind** | Java 的自进化认知记忆引擎，面向 24/7 主动 agent | |
| **kongshan001/agent-memory-frameworks-research** | 中文的记忆层框架深度调研（Text2Mem/Mem0/Letta/ReMe/memU） | 可直接参考 |
| **MemoryStackBench** | 记忆框架的自动化基准农场 | 想自评时用 |

### 4.5 ARC-AGI-3（交互推理）—— **最难、最像"通用智能"**
- **定义**：无自然语言指令的回合制新环境，agent 要自己探索机制、推目标、建世界模型、规划。四项能力：探索 / 建模 / 目标设定 / 规划执行。**人类 100% 可解，2026-03 的 frontier 系统 <1%。** 评分是 **RHAE（相对人类动作效率）**——比谁用更少动作达标，反暴力搜索。
- **竞赛规则（Kaggle）**：无联网、代码须开源才有奖、有硬件/算力上限。
- **当前最强打法（arXiv:2605.05138《Executable World Models for ARC-AGI-3》）**：编码 agent 维护一个**可执行的 Python 世界模型** → **verifier 回放校验**（模型必须先能复现已观测转移，才允许消耗真实环境动作）→ **随证据积累重构简化模型**（把简化当作 MDL 简洁性偏置的实用代理）→ 用模型规划再行动。无任何游戏特定硬编码，25 个公开游戏**解出 7 个、6 个 RHAE>75%、平均 RHAE 32.58%**。
- **谁在打**：Anthropic 等拿最强模型打；顶尖高校自研 agent 打；用官方 SDK（Kaggle），编排框架如 NVIDIA nooa、自研 harness Tycho。**注意：这里"自研 agent"= 自研 harness/编排 + 世界模型循环，底层仍是接强模型。**

> **对 MP 的意义**：ARC-AGI-3 与 MP 当前产品无直接关系（MP 是短任务桌面助理，不是从零学新游戏），**不建议去打**。但它的"**verifier 先回放校验、验证通过才允许消耗真实动作**"的思想，与 MP"**ActionLease 复核 + 结果验证后才 send/delete/run**"是同一个安全内核，可作为设计佐证。

---

## 5. 主动性（proactivity）开源架构清单

你点名的"主动性"方向，开源生态在近三个月很活跃，且**其中一个项目的设计与 MP 已有工作高度重合**：

| 项目 | 核心设计 | 对 MP 的价值 |
|---|---|---|
| **refixai/proactivity**（TS SDK） | 框架无关：**durable wake 调度、跨唤醒目标记忆、LLM 自定节奏、幂等动作治理**。原文：`governed()` 包住工具→**副作用前先认领幂等键、每次唤醒动作上限、每次尝试留审计行；"这次唤醒是否真动作了"由审计流水推导，不信模型自述；拒绝回传给模型让它重规划而非盲重试** | **几乎逐条命中 MP 的 effect sandwich / 幂等键 / 权限门设计**——强烈建议精读它的 PRIMITIVES.md 作对照，看有没有可借鉴的原语切分 |
| **AgentACE-AI/ProAct** + ProActEval | 论文《Anticipate and Learn: Unleashing Idle-Time Compute》：**用空闲算力预判用户未来需求**；200 场景评测集 | 主动性的学术基准，想量化 MP 主动性时可用 |
| **thunlp/ProactiveAgent** | 清华，预测式主动触发任务 | 学术基线 |
| **leomariga/ProactiveAgent** | 多因子决策引擎决定"是否/何时开口"+ 动态 sleep 计算 | 轻量、易读的主动触发参考 |
| **gusitllc/proactive-action-engine** | **空闲扫描多信号源产生候选动作，两道闸（角色可用性 + 按动作类型分层冷却）在调 LLM 前先过滤，防刷屏** | "按动作类型冷却 + LLM 前闸"可直接用于 MP 的主动提醒不扰民 |
| **google-deepmind/proactive_t2i_agents** | 不确定性下的主动澄清（先问再画） | "先澄清再动手"范式 |
| **proma-ai/Proma、saolalab/clawforce、xfey/ContextOS** | 主动 agent 产品/框架 | 生态参考 |

> **共性范式**：主动 = **wake（定时/事件）→ 观察变化 → 跨唤醒追目标 → 自定节奏 → 治理后动作（幂等+冷却+审计）**。MP 已有 durable `next-step`/`next-turn` Inbox、effect sandwich、幂等键，**基本盘已经在**；缺的是"自主 wake 调度 + 空闲扫描 + 按类型冷却"这层，refixai/proactivity 与 proactive-action-engine 是最直接的抄作业对象。

---

## 6. 对 Magic Pointer 的方向判断与建议

### 6.1 你已经做对的（外部证据支持，别推翻）
1. **押 harness 而非模型**——scaffold effect 证明这是唯一稳定的差异化来源。
2. **感知融合（UIA+DOM+COM+Explorer+SurfaceAdapter+OCR+Vision 并发裁决）**——WAA 官方证实"视觉+无障碍树混合"是 Windows 屏幕理解最优；MP 是它的严肃工程化版本。
3. **证据八态 + coversMark/coverageReason + 诚实 unsupported**——正好是学界在补的 Evidence-Supported Bounds（Pass/Fail/Unknown）与反 outcome-evidence gap。**领先，不落后。**
4. **effect sandwich + 幂等键 + ActionLease 复核后才不可逆动作**——与 refixai/proactivity 的动作治理、与 ARC-AGI-3 的"verifier 通过才消耗真实动作"同构。

### 6.2 建议收敛的方向（别追的）
- **不要去打 ARC-AGI-3**：与短任务桌面助理无关，是从零学新环境的研究赛道，投入产出极不匹配。
- **不要自建通用推理 loop / 上下文压缩 / 工具编排到"重造 Claude Code"的程度**：build-vs-buy 的四条硬条件里，这部分该 extend 现成 SDK；MP 的稀缺资源应压在感知/权限/执行内核。
- **不要用记忆专项榜的准确率给自己定目标**：那些榜不可比、且长上下文常反超。要做记忆，按"本地优先 + 延迟/token/可复现"定验收，不追 LoCoMo 数字。

### 6.3 建议投入的方向（下一步真正的杠杆）
1. **可靠性/长程，而非短任务准确率**：全 field 的下半场是"短任务超人、长任务 20%"。MP 的短日常任务定位规避了长程崩塌，但**"维持信念状态、跟踪中间产物、延迟验证、显式回溯"**是学界公认的下一个 12 个月主战场——MP 的 durable session + effect ledger 是打这场的地基，值得继续厚。
2. **把主动性这层补上**：抄 refixai/proactivity（durable wake + 跨唤醒目标 + 幂等治理）和 proactive-action-engine（按动作类型分层冷却 + LLM 前闸防刷屏）。MP 已有 Inbox/effect/幂等键基本盘，缺的是自主 wake 与节奏控制。
3. **记忆走"轨迹自进化"而非"事实抽取"**：ReasoningBank 的路线（把成功/失败轨迹提炼成可复用推理策略）比 Mem0 式事实图更贴 MP 的"从每次划线交互中学"，也避开了记忆层的有损压缩短板。
4. **可选：用一个已验证的开源 grounding 模型补视觉短板**：MP 的 Vision 还没进 fan-out。若要补，OS-ATLAS / Holo1.5 / Aria-UI / OmniParser 是现成的、专门解决"意图→坐标"的 grounding 模块，比自训省得多——符合"extend 而非 from-scratch"。
5. **可选：给自己搭个私有小评测**（借 MemoryStackBench/OSWorld-MCP 的思路），用 MP 真实数据而非公开榜，按 Evidence Pass/Fail/Unknown 记分——你已经有八态证据，做这个几乎是顺手的事，且能持续量化"harness 改进值多少钱"。

### 6.4 一句话方向
**继续做"最讲究的桌面感知/执行 harness"，接现成强模型、不碰模型训练；把资源从"堆功能"转向"长程可靠性 + 主动性 + 轨迹自进化记忆"这三件下半场真正的杠杆上；用自己的 Evidence-Bounds 评测替代不可信的公开榜给自己定验收。**

---

## 附：本次调研主要来源

- Scaffold Effect（harness=40× 成本差）：arXiv:2607.22585《The Scaffold Effect in Coding Agents》
- Build vs Buy（adopt/extend/from-scratch 三档）：capitalandcompute.net/blog/build-vs-buy-agent-harness（2026-07-13）
- 计算机使用现状（分类/OSWorld 2.0 20.6%/harness 治理抽象/Evidence Bounds）：Adnan Masood《The Hardest Easy Problem in AI: The State of Computer Use Agents》（Medium, 2026-07）
- Windows Agent Arena（OmniParser+UIA 混合最佳）：microsoft.github.io/WindowsAgentArena；github.com/microsoft/WindowsAgentArena；MLR proceedings v267/bonatti25a
- OSWorld / OSWorld 2.0：github.com/xlang-ai/OSWorld、OSWorld-V2；arXiv:2606.29537
- GAIA HAL 榜：hal.cs.princeton.edu/gaia
- 记忆榜不可信：digitalapplied.com（Mem0/Letta/Zep 对比）、dreaming.press（LoCoMo/LongMemEval number wars）、dev.to（2026 独立复现）
- ARC-AGI-3：arcprize.org/arc-agi/3；arXiv:2603.24621（榜设计）；arXiv:2605.05138（可执行世界模型打法）
- 主动性：github.com/refixai/proactivity、AgentACE-AI/ProAct（arXiv:2605.25971）、thunlp/ProactiveAgent、leomariga/ProactiveAgent、gusitllc/proactive-action-engine
- 记忆开源：Letta/MemGPT、Mem0、Zep、thakshak/ReasoningBank、openmemind/memind
- computer-use 开源模型：UI-TARS/UI-TARS-2（arXiv:2509.02544）、Qwen3-VL、xlang-ai/OpenCUA、OpenGVLab/ScaleCUA、microsoft/fara、Simular Agent S3、SEAgent（ICML'26）、Mano-P
