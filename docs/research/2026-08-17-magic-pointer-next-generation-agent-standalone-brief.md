# Magic Pointer 下一代真实工作流 Agent Harness

> **同组文件：**本文件是供独立审议的完整研究底稿；审议结论见 [《Magic Pointer 下一代 Harness：审议结果》](./2026-08-17-magic-pointer-harness-deliberation-verdict.md)；在用户明确“做完整、自有、前沿 Agent”这一目标后形成的实施裁决见 [《Magic Pointer 主权 Agent 后端重构蓝图》](./2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md)。三份文件分别承担“事实与问题空间 → 外部审议 → 最终方向与落地”的职责。

## 独立研究、架构审议与原创创新推演底稿

> **资料截止时间：2026-08-17（Asia/Shanghai）**  
> **文件用途：**把本文件单独交给一个能力极强、但**不调用工具、不联网、不读取任何其他源码或文档**的模型，让它仅依据这里的完整上下文，审议 Magic Pointer 的产品定位、底层 Agent/Harness、记忆、主动性、群体协作与原创创新方向。  
> **这不是既定实施方案。**文中标为“现状”的内容是事实快照；标为“候选机制”的内容只是待审议材料；标为“必须回答”的内容才是希望后续模型完成的工作。  
> **核心要求：**后续模型不能仅把现有项目拼装成一份“大而全清单”，而应提出少数真正有机制、有取舍、可证伪、简单而高杠杆的原创创新。

---

## 0. 给后续模型的任务说明

你是这份文档的唯一审议者。不要假设自己能查看仓库、运行代码、搜索网页或向用户追问基础事实；本文件已经尽量给出完成判断所需的事实。

你的目标不是赞美项目，也不是把竞品能力逐项抄一遍，而是回答以下问题：

1. Magic Pointer 应当以什么**不可替代的产品楔子**进入真实工作流，而不是成为另一个普通聊天壳、另一个 Coding Agent 或另一个多 Agent Demo？
2. 在不牺牲现有“交互编译式感知”和可验证动作边界的前提下，底层 Harness 怎样达到至少不弱于 Hermes、Pi、Claude Code、Codex、Kimi Code 与 DeepSeek Harness 的综合体验？
3. 怎样让用户从 Hermes 迁入时感觉是“继承已有工作系统并得到明显增益”，而不是从零重建配置、记忆、技能、模型、渠道与习惯？
4. 怎样规范化“指一下、划一下、说半句”的输入，使信息足够、歧义更低、Prompt 更短、工具调用更少，同时不把未经验证的坐标直接交给模型执行？
5. 怎样把大量简单任务从昂贵的完整 Agent 回合中分流出去，又不退回脆弱的关键词路由？
6. 怎样建立长程记忆，使它不仅“记得”，还会判断什么值得写、何时巩固、何时遗忘、何时冲突消解、何时仅按需读取？
7. 怎样实现恰到好处的主动性：用户只说一半时能补全意图，但不会因为错误推断而擅自行动或高频打扰？
8. 动态超图、Agent Swarm、经验网络与自进化，哪些能成为 Magic Pointer 的真实机制，哪些只是昂贵的学术包装？
9. 除了组合已有方法，还能提出哪些此前没有被这里列出的项目直接实现、但朴素、可构建、可验证、可能形成壁垒的原创机制？

你必须严格区分：

- **事实**：已有实现、官方源码/论文/发布记录或明确社区反馈；
- **推断**：从事实推出来但尚未由本项目验证的判断；
- **假设**：值得实验、但可能失败的创新机制；
- **决策**：你最终建议项目采用或放弃的方向。

禁止以下低质量回答：

- “加一个知识图谱、加一个向量库、加一个多 Agent、加一个本地模型”式堆料；
- 把“准确率、成本、安全、体验都要更好”当作架构；
- 用认知神经科学名词给普通 RAG 或状态机换皮；
- 把模型自报“完成”当作真实完成；
- 默认所有任务都要 Agent、所有复杂任务都要 Swarm；
- 回避取舍，给出十几个同等优先级方向；
- 只说“需要更多调研/需要看源码”。本文件就是你的全部输入。

---

## 1. 项目背景：Magic Pointer 到底是什么

### 1.1 产品定义

Magic Pointer 是一个面向 Windows 桌面的**交互编译式 Agent Harness**。它服务的主要不是持续数小时的项目级编码，而是日常真实桌面上通常只需几轮、几分钟的短任务：

- 用户在当前应用中指、点、划选一个对象或区域；
- 系统冻结用户完成手势时看到的历史画面；
- UIA、DOM、COM、OCR、像素/视觉等证据并发读取并融合；
- 把“对象、现场、用户语言、权限、可用能力、历史指代”编译成尽可能短且明确的输入；
- 交给本地 MPAgentRuntime，或编译/填入 Claude Code、Codex、Pi、Kimi Code 等外部 Agent；
- 产生可编辑草稿、受限动作或结构化交付物；
- 对动作结果做读回验证，不能只相信模型说“完成了”。

它不应取代 Claude Code/Codex/Pi 处理项目级代码工程。更合理的边界是：Magic Pointer 捕获代码以外的桌面现场、用户指代和真实应用状态，再把经过编译的上下文交给专业 Agent；对于短任务，Magic Pointer 自己的 Runtime 可以直接完成。

### 1.2 真正的发明点

项目最有潜力的原始发明不是“桌面上再放一个聊天框”，而是：

> **把人类天然的指代行为视为感知层的一部分，把手势、当前对象、窗口状态和一句不完整语言共同编译为 Agent 可消费的、低歧义、低 Token 的任务输入。**

传统 Agent 往往要求用户自己组织大量 Prompt：描述哪个窗口、哪一段、哪个对象、上下文在哪里、希望怎样处理。Magic Pointer 希望让人通过“这个、这里、上面那一行、把它改成这样”表达意图，由系统确定性地补足对象身份与现场证据。

这项创新同时针对四类成本：

1. 用户组织 Prompt 的时间；
2. 模型理解指代的偏差；
3. 重复上传整屏、整文档或整段历史的 Token；
4. Agent 因对象不明确而反复调用感知工具的成本。

### 1.3 硬边界与不可回退原则

以下约束不是建议，而是当前产品真源中的不变量：

- 手势结束时必须先冻结历史像素，UIA/DOM/COM/OCR 或 Overlay 不能让系统捕获到“更晚的屏幕”冒充用户当时看到的内容。
- 小手势裁剪只能做预览或模型局部提示，不能成为唯一视觉/OCR 证据；必须保留目标表面的完整本地证据。
- 感知是并发证据融合，不是“第一个非空结果就返回”的串行 fallback。
- UIA 可常驻，但必须空闲/事件驱动；截图、OCR、深读只能在明确唤醒、手势或任务后启动。
- 历史 `FrameLease` 是不可变事实；真正写入前必须重新获取面向当前状态的 `ActionLease`，不能拿历史坐标盲写。
- 屏幕、网页或文档内容永远属于 data，不属于 instruction，不能通过屏幕文本劫持 Agent。
- 发送、删除、运行、支付、发布等动作只有在当前回合明确授权、ActionLease 重验证和结果验证后才可执行。
- 生成文本是版本化、可编辑的 `DraftArtifact`；用户编辑和 Agent patch 都是第一等历史。
- 新应用通过 `SurfaceAdapter`/Capability 契约接入，不能在核心堆应用名 if/else。
- 模型负责判断和生成；坐标、权限、状态版本、动作执行和验证必须留在确定性系统中。
- 不做全天候录屏式 Recall，不默认持续观察用户屏幕。

---

## 2. 当前真实架构与实现状态

### 2.1 目标链路

```mermaid
flowchart LR
    U["人：手势 + 不完整语言"] --> C["CaptureEpoch / FrameLease"]
    C --> P["并发感知：UIA / DOM / COM / OCR / Vision"]
    P --> E["EvidenceGraph / ObjectLease"]
    E --> I["Interaction Compiler"]
    I --> R["MPAgentRuntime 或外部 Agent"]
    R --> T["Tool / SurfaceAdapter / Capability"]
    T --> A["ActionLease 重获与动作"]
    A --> V["读回验证 / Receipt"]
    V --> D["DraftArtifact / 可核验交付物"]
    D --> M["Episode / 记忆候选 / 后续交接"]
```

这条图是产品目标。当前仓库已经实现了其中不少底层原语，但还没有把它们收束成稳定、完整、有明显吸引力的用户工作系统。

### 2.2 已经存在的底层能力

截至 2026-08-17，本机开发树与安装版版本均为 1.0.7。最近一次记录的完整交付验证为 Python 1286 项、Node 147 项、TypeScript typecheck 与 ESLint 通过。以下是已经存在或基本可用的能力：

| 层 | 已有能力 | 真实含义 |
|---|---|---|
| 捕获 | 版本化不可变 `FrameLease`；pointerup 后先提交再感知；GDI 热路径；CaptureProvider 契约 | 已解决“手势结束后切屏导致读到后来画面”的基础竞态；原生 WGC 仍未完成 |
| 感知 | UIA 常驻宿主、OCR/像素路径、Browser DevTools、Office COM、终端读取、SurfaceAdapter SDK | 多个证据源存在；部分八态证据契约和统一空间元数据仍未贯通生产链 |
| Agent loop | 模型即路由器、流式与非流式回退、工具调用、预算、取消、compaction、hook、事件流 | 已不是简单问答；具备真实多轮工具循环 |
| Session | append-only JSONL 事件会话、模型可见投影、崩溃修复、fork 基础 | 有可审计历史，但还不是完整跨进程、跨设备的 durable task/session 系统 |
| 工具 | 约 18 个正交工具、首轮工具上限 12、`find_capability` 按需发现 | 已开始避免把全部工具塞入 Prompt；能力选择仍缺真实 token/成功率反馈闭环 |
| 并行执行 | 资源冲突键、独占 barrier、有序 commit、取消结果 | 吸收了 DeepSeek Harness 的 rolling pool 思路 |
| 人在环 | 权限预设、guard、确认卡方向、Inbox 的 `next-step`/`next-turn` | 当前 Inbox 主要在进程内；桥按请求启动子进程，跨进程实时 steer 尚未真正成立 |
| 完成验证 | 写效果无通过验证时，结束前追加一次 verification nudge | 吸收 Hermes 的“不要相信模型自报完成”原则，但还不是所有真实应用的端到端完成合同 |
| 插件内核 | Context 服务仓库、scope 生命周期、hooks、工具/Prompt/LLM/Session/Adapter seam | 插件地基存在；生态、兼容样本、能力市场和安装体验都远未达到 Hermes 水平 |
| UI | Studio 真实 Agent 回合、工具事件可见、模型/权限/技能入口、会话落盘 | 已从静态壳转为真实运行；Stage/Companion 与直接编辑 Draft 等仍有断链 |

### 2.3 当前底层 Agent 的具体形态

当前 `run_agent_turn` 只有少数非常精确的本地动作（例如复制、截图、查看来源）能完全绕过模型。其他普通对话或任务会进入 Agent Loop：

1. 加载有限的系统 Prompt、记忆、技能与首批工具 Schema；
2. 调模型；
3. 调度工具，按资源冲突决定并行或串行；
4. 把结构化工具结果回送模型；
5. 在上下文达到约 70% 时压缩旧消息；
6. 处理用户的 next-step/next-turn 输入；
7. 在模型准备结束但写动作没有验证证据时，要求它验证一次；
8. 产生答案、工具事件与结果状态。

当前记忆与上下文仍偏基础：

- 用户级 `MAGIC_POINTER.md`、经批准的 `learning/MEMORY.md`、工作区 `MAGIC_POINTER.md` 总注入量约 4000 字符；
- Skill 路由主要依赖文本 token overlap，最多注入约 6 个技能、总计约 12000 字符；
- 历史压缩由模型总结旧消息，通常保留最近 4–6 条；
- 自动屏幕记忆和后台学习已改为默认关闭；
- 没有成熟的 episodic / semantic / procedural / prospective 分层，没有稳定的写入准入、巩固、冲突、遗忘和跨 Agent 共享规则。

### 2.4 必须诚实面对的缺口

| 缺口 | 当前事实 | 为什么重要 |
|---|---|---|
| 综合集成弱 | 工具、插件、Memory、Session、外部 Agent 接口都有零件，但没有形成 Hermes 式“一处安装、处处工作、持续生长”的系统 | 用户不会为了底层原语迁移；迁移发生在完整工作系统层 |
| 简单任务仍常调大模型 | 除少数精确本地动作外，普通小请求仍进入完整模型回合 | API 成本、延迟和“为了小事启动 Agent”的心理负担仍在 |
| 空间规范化输入未落地 | 2026-08-15 已写 `normalized-1000` 感知 Schema 规格，但属于文档设计，不是生产现实 | 当前模型仍可能拿到冗长文本而缺稳定空间结构 |
| 原生 WGC 缺失 | CaptureProvider 有契约，WGC 工具仍报告 `wgc_tool_missing` | 捕获延迟、窗口级隔离和真实热路径仍未到目标状态 |
| Evidence 八态未全链贯通 | ok/degraded/empty/busy/timeout 等契约存在，感知链尚有未接线处 | busy 不能被误判为“屏幕上没有东西” |
| durable steering 不完整 | Inbox 是进程内队列，Studio bridge 当前请求级子进程限制了活跃回合纠偏 | 用户无法获得 Hermes/Pi 那种真正“边跑边改方向”的体验 |
| `ask_user` UI 断链 | 工具已注册，渲染层未接；模型需要澄清时会诚实报告无法提问 | 人在环不能只存在于权限审批，也应进入语义澄清 |
| Draft 直接编辑不完整 | 数据结构和视觉方向存在，气泡内直接编辑与版本/patch 全链仍未完成 | “生成—编辑—继续执行”是桌面工作流的核心，而不是附加 UI |
| 账本闭环缺失 | token、模型、工具、成本、能力成功率、提示反馈尚未形成闭环 | 无法证明“更省、更快、更可靠”，也无法训练路由与记忆准入 |
| 多应用真实验证不足 | Notepad、Terminal 等有样本，真实 Office/浏览器/微信等端到端 ActionLease 与结果验证仍薄 | Demo 级“能点”不等于业务完成 |
| 核心重新膨胀 | Agent Loop 与 Model Client 文件规模再次增长，来源机制被吸收后仍容易集中到大模块 | 如果继续复制功能而不重定边界，会复刻 Hermes 大循环的维护问题 |

### 2.5 一次重要的失败经验

2026-08-15，项目曾新增“惊奇分级、断言记忆、预算表面、Event-Action 仲裁”四个认知模块，并写了 24 项测试；第二天审计发现这些模块**没有任何生产入口引用**，于是约 1500 行相关代码被删除。

这个事件必须成为后续创新的约束：

> 新认知机制不能先建一个平行的“漂亮大脑”，再等待未来接线。每项创新必须挂在现有真实 seam 上，改变当前一次任务的输入、路由、工具选择、记忆写入、验证或用户介入，并能在真实回执中测到差异。

---

## 3. 原创方向一：人在感知环中的“交互编译”

### 3.1 当前候选输入契约

项目已有一份尚未生产化的空间元数据设计，核心是把手势和对象统一到目标表面的 `1000×1000` 归一化空间。候选数据包括：

```json
{
  "perceptionSchemaVersion": 1,
  "frameLeaseId": "fl-...",
  "stateVersion": "sv-...",
  "spaces": {
    "unit": "normalized-1000",
    "surfaceBoundsDip": { "w": 960, "h": 520 },
    "scaleFactor": 2.0,
    "origin": "target-window-client"
  },
  "pointer": {
    "gestureKind": "stroke",
    "strokeCount": 1,
    "bounds": [470, 300, 520, 380],
    "anchor": [486, 321],
    "trajectory": [[481, 317], [483, 319], [486, 321]]
  },
  "nodes": [
    {
      "id": "n1",
      "role": "text",
      "name": "第 3 行 Q2 数字 3.6 秒",
      "bbox": [475, 305, 515, 335],
      "state": "enabled",
      "source": ["uia", "ocr"],
      "confidence": 0.92,
      "coverage": 0.86,
      "depth": 2
    }
  ],
  "focused": { "nodeId": "n1", "reason": "point-hit" },
  "deictic": [
    { "ref": "n1", "score": 0.90, "basis": "distance+coverage" }
  ],
  "evidence": [
    { "provider": "uia", "status": "ok", "latencyMs": 212 },
    { "provider": "ocr", "status": "busy", "latencyMs": 0 }
  ],
  "pruning": {
    "droppedNodes": 17,
    "reason": "non-interactive-decorator"
  }
}
```

候选预算是：默认约 16 个节点，总体不超过约 900 token；硬上限 24 个节点、约 1400 token。信息不够时通过 `read_around`/`find_in_window` 渐进读取，而不是首轮塞入整屏、整文档和全部工具。

重要边界：这些归一化坐标只帮助模型理解“第二个节点”“锚点下方那一行”，不能直接成为鼠标动作参数；真正执行必须重新通过 ActionLease 获取当前对象和坐标。

### 3.2 2026 年最新相关研究给出的启示

这些研究并不直接等于 Magic Pointer 的方案，但证明“手势不应只变成一句 OCR 文本”是合理方向：

- **EGOPOINTVQA / HINT（CVPR 2026）**：把 3D 手部关键点编码为 Hand Intent Tokens，与视觉 token 按时间交错输入；论文报告 HINT-14B 在六类手势指代任务平均 68.1%，比对应开放基线高 5.4%。关键启示是：指代几何可以成为独立、紧凑的一等输入流，而不是让通用视觉模型从整帧里自己猜。来源：[论文](https://arxiv.org/abs/2603.12533)、[CVPR 页面](https://openaccess.thecvf.com/content/CVPR2026/html/Choi_Do_You_See_What_I_Am_Pointing_At_Gesture-Based_Egocentric_CVPR_2026_paper.html)。
- **GesVLA（2026-05）**：把手势作为与视觉、语言并列的一等模态，使用手腕/食指关键点的连续表示；其机器人场景与桌面不同，但支持“语言负责语义、手势负责消除空间歧义”的基本判断。来源：[论文](https://arxiv.org/abs/2605.22812)。
- **PersonalAlign / HIM-Agent（ACL 2026）**：从 20k 条长期手机轨迹中区分稳定偏好和状态相关例行行为，用 Preference Intent Memory 与 Routine Intent Memory 补全模糊指令和提供主动建议。它提醒我们：补全“把这个发给他”需要的可能不是更多当前像素，而是稳定偏好与当前状态的交叉。来源：[GitHub](https://github.com/JiuTian-VL/PersonalAlign)、[ACL 论文](https://aclanthology.org/2026.acl-long.1669/)。
- **ProcAgent（2026-07）**：轻量感知持续提出候选，只有歧义或疑似偏离时才调用昂贵视觉验证；能从任务状态直接回答的问题不调用视觉模型。它称之为 Reason-Before-Perception，并强调自愿使用场景中，错误主动干预的成本常高于漏掉一次。来源：[论文](https://arxiv.org/abs/2607.24770)。

### 3.3 必须由后续模型回答的问题

请不要简单确认上面的 JSON。请从信息论、HCI、认知负荷和 Agent 工具经济性出发，重新判断：

1. 一次“指一下 + 说半句”的**最小充分统计量**是什么？哪些字段是真正帮助模型决策的，哪些只是看起来结构化？
2. 手势轨迹应被压缩成 bbox、锚点、方向、速度、停顿、形状类别，还是一个小型 learned token？怎样避免为桌面交互训练昂贵专用模型？
3. 什么时候一个对象引用已经足够，应该零视觉/零 OCR；什么时候必须补局部文字；什么时候必须升级到完整表面证据或视觉模型？
4. 怎样量化“继续读上下文的期望价值”，使工具调用只发生在补充信息预计能改变下一步时？
5. 跨轮指代应怎样衰减？当前候选是最近 3 个锚点、约 180 秒 TTL；这是否过于机械？能否使用窗口身份、对象稳定性和任务阶段决定失效，而不是单一时间？
6. 用户怎样感知系统理解了什么、缺什么，并以最低成本纠正？是否存在比弹窗提问更自然的微交互？
7. 什么指标能证明交互编译真正优于纯语言 Prompt：首轮指代成功率、澄清次数、感知调用数、输入 token、任务总时长、错误动作率，还是其他指标？

---

## 4. Hermes：必须正面跨越的综合体验壁垒

### 4.1 为什么 Hermes 有粘性

Hermes Agent 不是因为拥有一个特别神秘的单循环而形成壁垒，而是因为它把大量用户长期需要的能力做成了同一套连续工作系统。截至 2026-08-17：

- 官方仓库为 MIT，GitHub 约 23.18 万 stars；最新稳定标签为 **v0.20.2 / 2026.8.16**，仅 8 月 13 日到 16 日的补丁窗口就合并约 397 个 PR；来源：[官方仓库](https://github.com/NousResearch/hermes-agent)、[v0.20.2 发布](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.16)。
- 它覆盖完整 TUI/CLI、原生桌面、Web Dashboard、Telegram、Discord、Slack、WhatsApp、Signal 等表面，并通过一个 Gateway 延续会话。
- 支持多模型/多 Provider、本地与云端、MCP、Skills Hub、插件、浏览器、终端、定时任务、长期运行、远程服务器与多种沙箱后端。
- 有长期记忆、会话全文搜索、用户模型、技能生成/改进、记忆提醒与定期整理。
- 有 profile、subagent、Kanban/任务管理、并行委派、实时子 Agent transcript、持久化后台结果与 delivery-obligation ledger。
- 支持 mid-turn redirect、`/undo`、上下文查看、diff、focus、草稿暂存、完成合同和验证 hook。
- 新版本加入从 Claude Code/Codex 等导入 Agent 配置的能力；迁移本身已经被当作产品功能，而不是 README 说明。

对用户来说，真正的沉没成本是逐渐形成的：模型配置、Provider、Skills、MCP、记忆、Persona、Profiles、定时任务、渠道、工作目录、工具习惯、Prompt 习惯以及对系统故障方式的理解。新 Agent 如果要求全部重建，即使单项 benchmark 更高，也很难让用户离开 Hermes。

### 4.2 社区反馈中的正面壁垒

以下 Reddit 帖只能作为社区样本，不能当作普遍定律，但它们揭示了迁移心理：

- 一位连续使用三个月的用户把 Hermes 从“工具”变成自己机器的主要界面，强调它在低成本硬件上稳定运行、Profile/Memory/Soul 文件可检查、可编辑；他最终关闭了更复杂的 Memory Provider，认为短小、可见、可清理的 Markdown 反而最好。来源：[three months with Hermes Agent，2026-06-17](https://www.reddit.com/r/hermesagent/comments/1u8fm0t/three_months_with_hermes_agent_what_i_wish_i_had/)。
- 一位从 OpenClaw 迁入的用户首先检查的不是聊天 UI，而是既有 config、memory、skills、API key 是否能继承；他明确说，如果新 runtime 要全部重建，会很快失去兴趣。来源：[Hermes migration/MCP experience，2026-06-03](https://www.reddit.com/r/CustomAI/comments/1tvlb65/i_tested_hermes_agent_locally_after_openclaw_and/)。

因此，Magic Pointer 若想“引流”Hermes 用户，不能只说自己 Grounding 更好。至少要提供：

- 无破坏的导入预览、冲突报告与回滚；
- 兼容或转换 Hermes 的 Profile、Skills、Memory、MCP、Model/Provider 与主要渠道设置；
- 允许用户继续把 Hermes 当执行后端，而 Magic Pointer 先提供手势感知、场景交接和验证增益；
- 在用户确认收益之后，才逐步把任务迁移到 MPAgentRuntime；
- 清楚告诉用户哪些东西被继承、哪些被代理、哪些暂不支持。

### 4.3 Hermes 同样暴露的机会窗口

Hermes 并非没有明显问题：

- 社区批评它持续堆 Features、默认启用过多工具/技能、产生噪声和不可预测性；插件 API 对系统 Prompt 和 Skill 注册等扩展仍有限。来源：[Unpopular opinion，2026-06-04](https://www.reddit.com/r/hermesagent/comments/1tx1jt9/unpopular_opinion_hermes_agent_takes_the_path_of/)。
- 一位 2026-07-25 用户报告：即使底层模型很强、工具很多、Persona 要求主动，Hermes 仍会反复要求确认、只列图片不下载、把同一图片下载 250 次、把新任务与旧任务混淆；“主动”可能变成高成本的错误。来源：[How do you get Hermes Agent to actually do stuff well?](https://www.reddit.com/r/hermesagent/comments/1v5tixs/how_do_you_get_hermes_agent_to_actually_do_stuff/)。
- 长期用户对外部记忆 Provider 的反馈说明：“更多记忆技术”不自动等于更好的记忆；错误写入、不可见的召回和持续污染会破坏信任。
- Hermes 的综合性也使内部复杂度、配置理解成本和产品/开发者定位张力不断上升。

Magic Pointer 的机会不是“功能数量超过 Hermes”，而可能是：

> 用交互编译显著降低任务启动成本，用分层能力按需加载降低上下文噪声，用可编辑对象和可验证回执提高真实完成率，再通过无痛迁移继承 Hermes 已形成的生态资产。

这只是一个战略假设，后续模型需要决定它是否足够强，以及还缺什么。

### 4.4 Hermes parity 不是照抄清单

后续模型应给出一个**最小迁移等价集**，而不是要求 Magic Pointer 首版实现 Hermes 所有功能。请判断下列能力哪些是用户迁移的“必需继承面”、哪些可以通过连接 Hermes 暂时满足、哪些应明确不做：

- Provider/Model 与本地模型；
- Profile/Persona/Soul/Memory；
- Skills、MCP 与工具权限；
- Session 搜索与恢复；
- Cron/Loop/后台任务；
- Telegram/Discord/Slack/移动通知；
- Subagent/Kanban/多 Agent；
- Browser/Terminal/文件/Office；
- Import/Export/Undo/Redirect；
- 成本、上下文、工具和完成验证可见性。

---

## 5. 已吸收的主流 Agent 地基，以及为什么还“不像一个完整产品”

项目本地已有 Pi、Claude Code、Codex、DeepSeek Harness、Hermes、Kimi Code 等源码或固定快照，并做过一次底层审计。已经吸收的主要机制是：

| 来源 | 已吸收的核心思想 | 当前不足 |
|---|---|---|
| Pi | 极简 turn 状态机、steer/followup、extension seam、低核心复杂度 | MP 的跨进程 steer 仍未形成完整体验；核心重新增长 |
| Claude Code | 工具调用级 effect、hook、scheduler、compaction、完成/停止控制 | 部分 effect/治理只在契约或局部消费，未覆盖全部真实动作 |
| DeepSeek Harness | Context 服务仓库、统一 session log、Inbox target、rolling 并发池、插件生命周期 | 零件已移植，但缺与 Magic Pointer 场景交互相绑定的整体工作流 |
| Hermes | iteration budget、verification stop、Memory/Skills/Gateway/长期任务的产品经验 | 只吸收了验证等局部原语，没有吸收它的迁移、渠道、持续任务和学习闭环 |
| Codex | 事件化执行、工具边界、计划/权限/验证、App Server 式集成 | 与外部 Codex 的稳定 handoff 和 session continuation 仍需落地 |
| Kimi | 外部 Agent/浏览器桥、跨表面工作流、Swarm 产品化信号 | 真实浏览器当前态、登录态复用与结果验证仍是硬问题 |

问题不是“再抄一次源码”，而是之前的复用经常停在局部机制：某个队列、某个接口、某个视觉壳、某个 stop 条件。用户感知不到这些模块共同解决了一个完整工作日中的问题。

因此后续设计必须给出一条纵向闭环：

> 用户如何发起 → 系统如何理解 → 为什么无需再次解释 → 如何选择最便宜充分的执行路径 → 怎样完成真实动作 → 如何验证 → 如何编辑/交付 → 下次怎样变得更省事。

若一个新模块不能改善这条闭环中的至少一个可测节点，就不应进入核心。

---

## 6. “EXOV / EVOX”的核实结果：EvoX 与 EvoMap

### 6.1 项目身份

用户记忆中的 E 开头热门项目，高度吻合 **EvoX**，其背后平台为 **EvoMap**。它在 2026 年 7 月集中发布 Swarm 与 Agent Harness 实验，并提供桌面 beta。官方定位是“self-evolving swarm agent / experience network”。

必须区分三个对象：

1. **EvoX 完整桌面 Agent/Swarm 产品**：可以下载 beta，但本轮没有发现与完整产品一一对应、可完整审计的开源仓库；
2. **EvoMap 平台与官方实验报告**：公开展示 Swarm、经验资产网络和 benchmark，但数据主要是官方自报；
3. **EvoMap/evolver**：GPLv3 开源的 GEP 自进化引擎，2026-08-09 发布 v2.0.2，仓库截至 8 月 17 日持续更新；这是能直接审计的部分，但它本身明确是“生成受协议约束的进化 Prompt/资产”，不是完整 Agent 或自动代码修补器。来源：[EvoMap](https://evomap.ai/)、[Evolver GitHub](https://github.com/EvoMap/evolver)、[v2.0.2](https://github.com/EvoMap/evolver/releases/tag/v2.0.2)。

开源边界也并不完全透明：Evolver 的 Gene/Capsule Schema、事件、MemoryGraph 等文件可读，但公开仓库中的 selector/recall 等关键 JavaScript 文件存在明显混淆，Schema 注释还引用未在该仓库完整公开的 EvoX Rust agent-core。因此不能把“Evolver 开源”表述成“EvoX 完整 Agent 源码已开源”。

### 6.2 EvoX Swarm 实验的真正机制

EvoX 2026-07-25 的官方实验比较了相同 Claude Haiku 4.5 下的三种组织形式：563 道逻辑、数学、竞赛数学和物理题；官方报告结果为：

- EvoX Swarm：70.69%–70.87%；
- 主 Agent + Subagent：38.54%；
- 单上下文：26.29%。

它声称优势主要来自：

1. 把任务尽量拆成有稳定 ID 的原子项；
2. 每个 Agent 在隔离上下文中只负责一个清晰局部；
3. 每项结果写到预先约定的位置；
4. 最终由程序按 ID 聚合，不让另一个 LLM 重新理解、压缩、选择所有报告；
5. 检查覆盖、重复、缺口、失败与重试。

官方追踪发现，普通 Subagent 路径曾产生 373 个正确中间答案，但最终只交付 217 个；166 个正确结果在汇报/汇总链中丢失，正确结果保留率约 55.5%。这个发现比“多 Agent 更强”更重要：

> **已正确的结果不应再次经过自然语言转述和中央模型重理解；应通过类型化、可验证、程序化的接口直达交付物。**

来源：[From 26% to 71% with the Same Model](https://evomap.ai/blog/how-ai-swarms-win-from-26-to-71-percent)。这些数字来自 EvoMap 自身实验，本轮未找到独立复现，因此应视为“高价值待验证主张”，不是定论。

### 6.3 自组织实验

第二个实验让 24 个初始相同的 Agent 多轮解题并把经验记为 Gene，随后根据实际选择和正确率形成专业画像。Agent 从固定环形关系中断边、重新选择伙伴：

- 只看到社交连接时，倾向选择“朋友的朋友”，网络保持聚类；
- 看到专业画像和准确率时，倾向连接高正确率或能力互补者，网络降低聚类并形成枢纽。

这说明组织结构不是凭空涌现，Agent **能看到哪些状态和绩效信号**会决定网络长成什么样。对 Magic Pointer 的重要问题不是复制“24 个 Agent”，而是：

- 哪些真实任务值得形成多个执行单元？
- Agent/工具/记忆/用户之间应公开哪些能力、成本、历史成功率和当前负载？
- 结果如何不用二次 LLM 汇总就进入同一个 Draft/Receipt？
- 经验怎样在任务之间传播而不把错误做法扩散？

### 6.4 GEP 的可审计资产形态

Evolver 的公开 Schema 把经验拆为：

- **Gene**：触发信号、策略、验证、约束、前置条件、反模式、学习历史，以及 cheap/mid/expensive 路由提示和工具 allow/deny 提示；
- **Capsule**：某次具体结果，含 outcome、confidence、成功连续次数、环境指纹、执行轨迹、影响范围、来源类型、真实或估算 token 成本、可否广播；
- **EvolutionEvent**：每次选择、变异、固化和反馈的审计事件。

这个方向比把所有经验写成一篇越来越长的 `MEMORY.md` 更结构化，但后续模型必须判断：哪些字段真的会改变 Magic Pointer 下一次短任务，哪些只是协议复杂度；以及 GPLv3 与混淆代码是否意味着只能借鉴思想，不能直接复用实现。

---

## 7. 截至 2026-08-17 的最新机制雷达

下面只列与 Magic Pointer 当前问题有直接关系的近期项目/论文。GitHub stars 只是热度快照，不是质量证明；所有 benchmark 都应先区分官方自报、论文评测和独立复现。

| 项目/论文 | 截止日期的状态 | 值得研究的机制 | 不能直接下的结论 |
|---|---|---|---|
| [Omnigent](https://github.com/omnigent-ai/omnigent) | 2026-06 创建；8 月 11 日 v0.9.0；Apache-2.0 | Meta-harness：同一服务器接 Claude/Codex/Cursor/Hermes/Pi；session 分享、co-drive、fork；server/agent/session 三级 policy；harness capability test bench | 支持很多 Harness 不等于任务成功更高；Windows 原生 terminal/sandbox 能力仍有限 |
| [Shepherd](https://github.com/shepherd-agents/shepherd) | 2026-06 创建；MIT；论文 arXiv:2605.10913 | Agent 工作先进入 retained output；执行轨迹可检查、fork、replay、select/apply/release/discard；函数签名就是权限面 | 主要面向代码/工作区候选变更，不能直接替代桌面 ActionLease，但“先形成候选世界再结算”很有价值 |
| [OpenViking](https://github.com/volcengine/OpenViking) | 2026-01 创建；8 月 17 日 v0.4.14；AGPLv3 | 把 memory/resource/skill 统一为 `viking://` 文件系统；L0 约 100 token、L1 约 1–2k、L2 原文；目录递归检索与可视轨迹 | 三层摘要会产生写入/更新成本；尚不能证明适合短桌面 Episode；AGPL 影响直接复用 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | 2025-10 创建；8 月 14 日 v0.9.1；MIT | World facts / Experiences / Mental Models；retain/recall/reflect；语义、BM25、图、时间四路并行检索后融合与 rerank | 官方 LongMemEval 成绩不能替代本项目实测；自动抽取与反思也可能写入错误模型 |
| [Magic Context](https://github.com/cortexkit/magic-context) | 2026-03 创建；8 月 15 日 v0.37.0；MIT | 后台 Historian 把历史压成分层 compartment；确定性 decay rendering；cache-stable layout；夜间 Dreamer 校验、去重、晋升 | “永不忘记/无限上下文”是产品措辞；替换宿主 compaction 的侵入性和双重记忆冲突需谨慎 |
| [OpenSquilla](https://github.com/opensquilla/opensquilla) | 2026-05 创建；8 月 13 日 v0.5.3；Apache-2.0 | 本地 LightGBM+ONNX 路由器按长度、语言、代码、关键词、embedding 选 C0–C3 最便宜模型；按复杂度缩放系统 Prompt/推理；统一 TurnRunner、成本账本、迁移 Hermes/OpenClaw | 25 任务 benchmark 为官方结果；本地路由分类错判和模型档位维护成本需单独验证 |
| [deja-vu](https://github.com/vshulcz/deja-vu) | 2026-07 创建；8 月 16 日 v0.17.2；MIT | 直接索引 17 种 Agent 已写到磁盘的历史；一个本地 Go binary；无 LLM、无 embedding | 词法/结构检索适合代码历史不等于能理解用户偏好；但“先继承已有历史”非常适合迁移 |
| [Graft](https://github.com/NanoNets/Graft) | 2026-07 创建；MIT | 无 LLM 构建代码 wiring graph、repo map、symbol skeleton、callers/blast radius；精确片段按需给 Agent；可选深层 LLM 摘要 | 自报最高 4× 便宜/3× 快需独立验证；领域主要是代码，不是桌面对象 |
| [XERJ](https://github.com/xerj-org/xerj) | 2026-06 创建；8 月 15 日 rc.17；Apache-2.0 | 自动索引代码/文档/日志/PDF；兼容 Elasticsearch；Agent 查询精确片段而非 grep 后读整文件；MCP 同时暴露 search 与 memory | 2.7×/26× 等 token 数字来自官方案例；建立索引是否值得取决于数据复用频率 |
| [Better Harness](https://github.com/QoderAI/better-harness) | 2026-07 创建；8 月 4 日 v0.4.1；MIT | 从项目与 session evidence 形成 loop 级改进建议和可验证下一步，而不是凭印象调 Prompt | 适合离线改进 Harness，不代表在线任务需要自我修改 |
| [PersonalAlign](https://aclanthology.org/2026.acl-long.1669/) | ACL 2026 | 把长期记录区分为稳定偏好与状态相关例行行为；主动性同时评估 recall 和 false alarm | Android 轨迹与桌面短任务不同；其 false alarm 仍高，不能直接授权动作 |
| [ProcAgent](https://arxiv.org/abs/2607.24770) | 2026-07 | propose-and-verify、Reason-Before-Perception、符号任务图、昂贵视觉按歧义触发、冲突时向人确认 | 家具装配是受限流程；不能据此假设开放桌面任务同样容易建 FSM |
| [EvoHyper](https://aclanthology.org/2026.findings-acl.1258/) | ACL Findings 2026 | 一个动态超图同时表示 Agent 与共享记忆；hyperedge 是协作单元；Update/Spawn/Merge；论文报告 token 最多降 23.5% | 只在数学/代码 benchmark 验证；不应为了“主流”就把所有 MP 状态塞入图 |
| [HyperAgent](https://arxiv.org/abs/2608.02650) | 2026-08 | Tool-Schema Hypergraph：工具是从输入 Schema 到输出/Effect Schema 的超边；按当前缺失输入做 deficit-oriented expansion，减少盲试工具 | AppWorld 结果不能替代真实 Windows 工具；Schema 维护和状态正确性是前提 |
| [PRISM](https://arxiv.org/abs/2605.12260) | 2026-05 | 类型化关系路径、query-sensitive edge cost、严格预算 evidence compression；意图分类先 regex，再 prototype embedding，最后才 LLM | 依赖已有高质量图记忆；“便宜级联”需要防止规则长期堆积 |
| [GAM](https://aclanthology.org/2026.acl-long.1600/) | ACL 2026 | 把快速事件进展图与稳定主题关联图分离，只在语义转折时巩固，减轻瞬时噪声干扰 | 论文问答 benchmark 不等于个人工作流记忆 |
| [APEX-MEM](https://aclanthology.org/2026.acl-long.749/) | ACL 2026 | append-only 时序事件；不急于覆盖旧事实，在检索时按有效期和证据解决冲突 | 强结构化抽取成本高；对短任务必须证明收益大于写入成本 |

这一雷达指向一个共识：**不再把所有状态、历史、工具和 Agent 一股脑塞进同一个 Prompt；让便宜、确定性、可缓存的结构先缩小问题，只把真正改变决策的信息交给昂贵模型。**但这只是共同方向，不足以构成 Magic Pointer 的原创壁垒。

---

## 8. 关键问题一：简单任务为什么还要浪费一个 Agent 回合

### 8.1 当前矛盾

用户提出的直觉是正确的：复制当前对象、截一张图、提取当前表格某个字段、把已有文字按固定模板格式化、打开一个已知能力、重复上次已经验证的动作等简单工作，如果每次都调用一个高水平 Agent，不仅浪费 API，还增加延迟、不可预测性和工具误用机会。

但直接回到关键词/正则路由也会产生旧问题：语言变体一多就脆弱，屏幕数据可能误触发动作，规则越写越长，最终形成第二个隐蔽 Agent。

### 8.2 当前候选分层空间（尚未决策）

后续模型应评估一个“最便宜充分路径”的分层，而不是默认所有层都要实现：

| 候选层 | 可能处理的任务 | 成本与风险 |
|---|---|---|
| L0 确定性直达 | 完全精确的本地命令、显式按钮/快捷操作、读取已知字段 | 零模型；范围窄；必须只看 instruction 通道并有严格参数契约 |
| L1 已验证 Procedure/Capsule 回放 | 环境指纹和前置条件一致、过去已成功且有结果验证的短流程 | 可极省 token；环境漂移或隐式副作用会使回放危险 |
| L2 本地轻量分类/解析 | 判断请求属于哪个能力、是否需要视觉、抽取少量槽位 | 低成本；分类错会把任务送错层；需要可拒绝/升级 |
| L3 小模型单回合 | 简单改写、分类、结构化提取、无工具或只读工具 | 比 frontier 便宜；仍需判断模型质量和隐私 |
| L4 Frontier 单回合 | 需要较强理解但不需循环的工作 | 无工具循环成本；必须避免模型为证明自己而调用工具 |
| L5 完整 Agent Loop | 多步、状态变化、工具依赖、失败恢复、验证 | 最强也最贵；只在预计收益超过开销时启用 |
| L6 多 Agent/Swarm | 真正可分解、并行收益大、结果可程序合并的任务 | 协调、成本和错误面最大；不适合绝大多数 MP 短任务 |

近期先例包括：Hermes 的 `!command` 不消耗模型回合；OpenSquilla 用本地分类器选择最便宜模型并按复杂度缩放 Prompt；PRISM 把意图判断按规则、prototype embedding、LLM 三级升级；ProcAgent 在调用视觉前先判断当前任务状态是否已经足够。

### 8.3 必须回答

请设计一个不会退化成规则泥潭的升级/降级协议，并回答：

1. 每层的**可判定准入条件**是什么？
2. 哪些失败必须立即升级，哪些可以在本层重试一次？
3. 怎样让一次已验证成功沉淀为可复用 Procedure，而不是把整个聊天转成 Skill？
4. Procedure 如何绑定环境、对象、权限和验证合同，又不过度绑定到像素或窗口句柄？
5. 本地分类器应使用哪些不含敏感正文的特征？它是否需要学习，还是可用 Schema/类型系统直接判定？
6. 怎样度量 intelligence density：每个真正有用且被验证的结果花了多少 token、模型费用、工具调用、等待时间和人工介入？
7. 若路由判断不确定，默认升级还是默认向人询问？这个阈值怎样随动作风险改变？

---

## 9. 关键问题二：长程记忆不是“把更多东西写下来”

### 9.1 当前项目的记忆现实

Magic Pointer 当前拥有事件会话、少量 Markdown Memory、Skill 注入、历史压缩和自动屏幕记忆开关，但还没有一套完整记忆宪法。长期风险包括：

- 每次任务都写记忆，形成低价值噪声；
- 错误总结被反复召回，变成稳定偏差；
- 用户一次偶然选择被误当长期偏好；
- 新事实覆盖旧事实，丢失“什么时候改变”的时间信息；
- 召回只按语义相似，忽略任务阶段、对象、因果、有效期和失败经验；
- Memory、Skill、Prompt、Session Summary 互相复制同一事实；
- 记忆系统本身消耗比任务更多的模型 token；
- 用户无法查看、纠正、冻结、删除或导出影响 Agent 的记忆。

### 9.2 候选记忆类型

后续模型应判断是否需要以下区分，以及最小可行集合是什么：

- **Raw Episode**：不可变的任务事件、证据引用、动作、验证、用户修改、成本和结果；
- **Working Set**：当前几轮和当前对象的短时状态；
- **Semantic Fact**：相对稳定的世界/项目事实，带来源、有效期与冲突；
- **Preference**：重复选择支持的用户偏好，不等于一次行为；
- **Routine/Prospective Cue**：在某个状态出现时值得提醒或准备的例行行为；
- **Procedure/Skill**：可执行方法，必须有前置条件、工具、权限、验证和失败模式；
- **Anti-pattern**：已验证会失败、浪费或产生错误的路径；
- **Mental Model/Hypothesis**：从多次经历归纳出的解释，但置信度低于事实；
- **Handoff Artifact**：跨 Agent 传递的已验证结论、未决项和引用，而不是聊天摘要。

### 9.3 候选生命周期

一个可能的讨论框架，而非既定答案：

1. **Capture**：完整事件先进入 append-only Episode，不能为了摘要丢掉原始证据；
2. **Admit**：只有会改变未来决策、被用户明确保存、重复出现或与失败恢复有关的信息才成为记忆候选；
3. **Consolidate**：在任务结束或语义转折时，把快速事件与稳定概念分离；
4. **Promote**：多次独立成功、跨环境复用或用户确认后，Procedure/Preference 才升格；
5. **Retrieve**：先用便宜结构和 L0 摘要缩小范围，再读取 L1/L2；
6. **Resolve**：冲突保留各自证据和有效期，在检索时判断，不静默覆盖；
7. **Decay/Retire**：不常用、环境已变或反复失败的经验降权或退役；
8. **Edit**：用户能看见哪条记忆影响了本次任务，并可纠正、冻结、删除；
9. **Export/Import**：记忆是用户资产，应能在 Hermes、Pi、Codex 和 MP 之间迁移。

### 9.4 认知神经科学只作为发散镜片

请用下列概念产生机制假设，但不能仅做类比：

- **工作记忆门控**：不是所有感知都进入当前思考；什么信号打开门？
- **互补学习系统**：快速、具体的 Episode 与缓慢、稳定的概念如何分离？
- **记忆巩固与睡眠重放**：离线整理究竟验证什么，怎样避免“梦”出新事实？
- **再巩固**：被召回的记忆在什么条件下允许更新，怎样保留版本与证据？
- **事件分段**：任务边界是否应由窗口/对象/目标/预测误差共同决定，而不是每条消息？
- **预测处理与惊奇**：只有结果明显偏离预期时才提高感知、模型或记忆写入预算，能否降低常态成本？
- **前瞻记忆**：怎样把“当 X 状态出现时提醒我做 Y”保存为条件，而不是定时器或普通文本？
- **提取诱发遗忘/抑制**：频繁召回某条经验会不会压制更合适的替代方案？如何保持探索？
- **元认知**：系统如何知道自己是“缺信息”“记忆冲突”“能力不足”还是“验证失败”？
- **主动推断**：Agent 是应先行动减少不确定性，还是先向人提一个最低成本问题？风险如何改变选择？

对每个借鉴，必须给出：可执行的数据结构/状态转移、接入现有 seam 的位置、可测指标、可能失败的条件。若不能，视为类比装饰并删除。

### 9.5 必须回答

请交付一份最小但完整的 **Memory Constitution**：

- 什么可写、谁批准、写到哪一层；
- 什么永远只留在 raw Episode；
- 怎样从一次成功形成 Procedure；
- 怎样从重复行为形成 Preference/Routine；
- 怎样处理冲突、时间、环境漂移和失败；
- 每轮最多注入多少、按什么逐层读取；
- 怎样让召回路径对用户与开发者可观察；
- 怎样防止 Memory、Skill、Prompt、Session Summary 重复同一信息；
- 怎样在不读取全文的情况下迁移 Hermes 等既有记忆；
- 怎样用真实任务证明它优于短 Markdown，而不是 benchmark 自嗨。

---

## 10. 关键问题三：主动性与“用户只说一半，我已经懂了”

### 10.1 主动性不等于多发消息或擅自执行

Magic Pointer 希望带来“未来已来”的感觉：用户说到一半，系统已理解当前对象、近期目标和个人习惯，能补全剩余意图。但这项能力最容易滑向三种失败：

- 把一次偶然行为当作稳定偏好；
- 在错误时机弹出建议，增加用户召回和拒绝成本；
- 推断正确一半就擅自执行不可逆动作。

社区对 Hermes 的负面样本表明，Persona 中写“主动、自主”并不能产生可靠主动性。PersonalAlign 也显示，如果保留所有候选原型而缺状态过滤，false alarm 可能接近 70%。

### 10.2 建议把主动性拆成不同权力等级

这只是供审议的行为梯度：

1. **预测但不显示**：系统内部预取可能需要的廉价上下文；
2. **补全表达**：在 Composer 中灰显一个可接受/可忽略的意图补全；
3. **提出单一建议**：说明依据和置信度，不打断当前输入；
4. **准备可编辑草稿**：生成 DraftArtifact，但不发送、不写回；
5. **执行可逆动作**：仅在已有授权范围和当前 ActionLease 下；
6. **请求关键决定**：只有无法安全继续时通知人；
7. **不可逆动作**：必须由当前回合明确授权和再验证，不能靠习惯记忆自动升级。

后续模型需要判断这些等级是否合理，以及系统如何在等级间移动。

### 10.3 必须回答

1. “意图补全”的对象到底是什么：下一句话、下一工具、下一子目标、缺失偏好，还是用户最终希望看到的状态？
2. 哪些上下文能合法支持推断：当前手势、当前窗口、近期 Episode、稳定偏好、日历/任务状态？怎样避免持续监控？
3. 是否可以把主动性视为**有选择地减少未来交互次数**，并用净节省的人类操作量减去误报成本来优化？
4. 怎样学习个体阈值：有人喜欢自动准备，有人讨厌任何打扰；阈值能否由接受/拒绝历史更新？
5. 怎样设计“最小反事实确认”：只问一个能最大幅度区分两个意图的问题，而不是让用户重新写完整 Prompt？
6. 什么情况下系统应静默预取，什么情况下应显式询问，什么情况下必须停止？
7. 如何评测：意图补全接受率、误报率、错误动作率、节省输入量、打断恢复时间、长期信任变化？

---

## 11. 关键问题四：动态超图到底该承载什么

### 11.1 最新研究与项目假设

动态超图不是凭空想象。EvoHyper 在 ACL Findings 2026 中把 Agent 与共享记忆统一进超图：一个 hyperedge 同时绑定多个协作者与共享状态，通过 Update、Spawn、Merge 随任务演化；论文报告在数学/代码任务上提升 3.2%–7.8%，token 最多降低 23.5%。它观察到代表性多 Agent 系统中同一关键事实会在消息、记忆和 Prompt 间重复 2.8–4.1 次。

HyperAgent 则把工具建成从输入 Schema 到输出/Effect Schema 的有向超边，执行时从当前“缺失的输入”反向寻找 producer 工具，而不是让模型在工具列表中盲试。

Magic Pointer 早期设想过动态超图，但目前生产系统中并没有成熟实现。一个候选语义是：

- 节点：用户目标、对象、Surface、状态版本、Agent、Tool、Skill、Episode、Artifact、Receipt；
- 超边：某个任务阶段中一组参与者和共享证据/约束；
- 变更：目标分解、工具需求、对象变化、失败、用户 steer、验证结果导致局部图更新；
- Prompt：只投影当前相关的最小子图，不把全图喂给模型。

这只是候选，不应因为“超图是主流”就采用。

### 11.2 必须回答

1. Magic Pointer 的哪个真实痛点必须用超边而不是普通 DAG、关系表或事件日志才能更好解决？
2. 图是**运行时真源**、**检索索引**、**模型可见投影**，还是三者之一？不能含糊。
3. 哪些状态由确定性代码更新，哪些结构允许模型提议？模型不得直接修改权限、坐标和事实真源。
4. 如何防止图、Session Log、Memory、Tool Result 再次复制同一事实？
5. 超边何时 Spawn、Update、Merge、Retire？是否能用任务覆盖、Schema 缺口、验证失败等明确事件触发，而非另一个 LLM 每步决定？
6. 对一个通常只有 2–5 步的短任务，建立动态图的固定成本是否大于收益？能否只在复杂度达到阈值时物化？
7. 是否可以把 hyperedge 直接定义为“有稳定输入/输出/验证合同的协作单元”，从而与 EvoX 的原子任务、Tool-Schema Hypergraph 和 MP Receipt 统一？
8. 最小实验是什么？应与普通 DAG/事件投影比较 token、工具调用、完成率、信息重复和恢复能力。

---

## 12. 关键问题五：Swarm、经验网络和自进化

### 12.1 对 Magic Pointer 有价值的不是“多开几个 Agent”

绝大多数 Magic Pointer 任务很短，不应为了展示 Agent 数量而启动 Swarm。只有满足下列部分条件时才可能值得：

- 任务可拆成相对独立且覆盖可检查的原子项；
- 各项可以并行，且上下文隔离带来的收益大于启动成本；
- 结果能按稳定 ID 和 Schema 程序化合并；
- 冲突、重复和缺口能检测；
- 有明确的整体完成合同；
- 多个 Agent 不会写同一资源或抢占同一 Surface；
- 总 token、时间或成功率相对单 Agent 有可测优势。

EvoX 最值得吸收的原则是：

- 原子任务有 ID、owner、输入、输出、依赖、完成合同；
- 每个 worker 只见局部充分上下文；
- 正确结果不经过中央 LLM 再次改写；
- 程序负责聚合可确定合并的部分；
- 专长和历史成功率是路由信号，但不能是永久身份标签；
- 经验共享要带环境、验证、成本与失败信息。

### 12.2 “新 Agent 的前期记忆如何走入长期系统”

用户特别关注一个朴素问题：新 Agent 或新 worker 刚加入时，前期记忆如何在长程之后融入统一系统，而不形成孤岛？候选问题包括：

- 新 worker 是否只从共享任务合同和 L0/L1 记忆起步，而不是复制主 Agent 全历史？
- 它的局部发现怎样先成为本任务的共享事实，再在验证后晋升为长期经验？
- 任务结束时，局部 Episode 是合并、链接、保留独立，还是只提交结构化 Receipt？
- 反复成功的局部经验是否形成可移植 Capsule；反复失败是否形成 Anti-pattern？
- 多个 Agent 对同一事实冲突时，谁有权合并？是否只保留证据、交给检索时消解？
- 新 Agent 如何借用历史专长而不被旧身份锁死？

### 12.3 必须回答

请提出一个适合短任务 Harness 的、**默认单 Agent、达到明确条件才展开群体**的方案，并给出：

- 展开条件；
- 原子任务 Schema；
- 局部上下文预算；
- 结果 transport 与 programmatic merge；
- 共享记忆边界；
- worker 专长更新；
- 失败、重复、空缺、冲突与取消；
- 用户怎样看到和 steer；
- 与单 Agent 的对照实验；
- 何时绝对不应使用 Swarm。

---

## 13. Magic Pointer 可能形成壁垒的组合，但仍需原创跃迁

从现有事实看，以下组合具有战略一致性：

1. **Interaction Compiler**：人类指代 + 冻结现场 + 多源证据 → 最小充分输入；
2. **Least-Sufficient Execution**：确定性直达、Procedure、本地路由、小模型、Frontier、Agent、Swarm 按需升级；
3. **Lease-Bound Action**：历史理解与当前动作分离，任何写入重获 ActionLease；
4. **Artifact/Receipt Transport**：Agent 之间传递类型化结果与证据，不反复转述自然语言；
5. **Memory Constitution**：Episode、Preference、Routine、Procedure 等有不同准入和生命周期；
6. **External Agent Continuity**：不要求用户放弃 Hermes/Codex/Pi，而是先为其提供更好的桌面感知、任务编译和验证；
7. **Migration as a Product**：把用户现有记忆、技能、配置、会话和渠道视为资产。

但这七项仍可能只是一个高质量组合。后续模型的最重要任务，是在它们之上找出 1–3 个真正原创、简单、能产生非线性收益的机制。

原创候选必须通过以下门：

- **新机制，不只是新名字**：它改变信息流、状态转移、学习准入或执行方式；
- **高杠杆**：最好在多个问题上同时降低 token、错误和人类负担；
- **小切口**：能在现有生产 seam 上用一个最小原型验证，而不是先建新平台；
- **可证伪**：有明确对照组和失败阈值；
- **真实工作流可达**：来自本项目支持的桌面用法，不是理论极端；
- **用户可理解**：用户能知道系统为什么这样做，必要时能纠正；
- **不会牺牲确定性边界**：模型不能接管权限、坐标、状态真源和验证；
- **有迁移或数据飞轮**：用户使用越久，收益能积累但不形成不可导出的锁定。

---

## 14. 希望后续模型专门发散的原创问题

请至少提出 12 个候选原创机制，再严格淘汰到 3 个。不要局限于下面的问题，但必须覆盖它们：

1. 能否把“用户手势”视为一种**对计算预算的路由信号**：手势精度越高，系统允许的搜索空间越小，从而动态缩减工具、上下文与模型档位？
2. 能否让用户纠正一次指代，不仅修当前对象，还更新一个可解释的“个人指代模型”，但不保存屏幕像素？
3. 能否用“预期下一状态”而不是“自然语言计划”驱动工具选择：每一步只选择最可能减少当前状态缺口的动作？
4. 能否把每次工具调用看作一次信息购买，只有预期决策价值高于 token/延迟/风险成本才调用？如何近似计算而不再调一个模型？
5. 能否让完成验证同时成为记忆准入器：没有外部证据的成功永远不能晋升为 Procedure？
6. 能否让用户编辑 Draft 的差异成为比“点赞/踩”更高密度的学习信号：系统学习的是哪里被改、为什么，而不是把全文重存？
7. 能否把外部 Agent 当作可替换“认知引擎”，而 Magic Pointer 保持统一的感知、权限、Artifact、Receipt 与 Memory，使用户换模型/Agent 不丢工作系统？
8. 能否设计“反摘要 transport”：对可结构化部分完全禁止 LLM 汇总，只传 ID/字段/引用；只有无法结构化的残余才总结？
9. 能否让长期记忆在任务开始前只给出一个很小的“导航面”，由 Agent 自己逐层展开；并让展开路径成为可学习的检索经验？
10. 能否通过事件分段和语义转折，只在“预测模型被真实结果推翻”时触发巩固，从根源减少无用记忆？
11. 能否把主动性定义为“准备一个可撤销的未来”，而不是“预测并执行一个动作”：例如预生成草稿、预取证据、建立候选分支，用户选择后再结算？
12. 能否把动态超图只物化为当前任务的“共享事实所有权”，消灭 Agent 消息、Memory、Prompt 三份复制，而不是建一个通用知识图谱？
13. 能否形成跨用户但不上传原始数据的经验资产：共享的是失败模式、验证合同或工具 Schema 组合，不是个人内容？
14. 能否从 Hermes 迁移数据中自动发现用户真正依赖的 20% 能力，先构建个性化兼容层，而不是一次实现 100% parity？
15. 能否用“任务启动摩擦”作为核心优化目标：从用户第一次指到系统做出有用、可验证的第一步，怎样降到近乎零？
16. 还能否从认知神经科学、编译器、数据库、分布式系统、控制理论、程序综合、经济学机制设计或协同工作研究中找到更朴素、更强的机制？

对每个原创候选，必须回答：

- 一句话机制；
- 它解决的具体失败链；
- 为什么现有项目/论文不是已经做了同一件事；
- 接入当前哪个生产 seam；
- 最小数据结构或状态机；
- 一周内可做的最小实验；
- 对照组与指标；
- 什么结果出现时应立即放弃；
- 可能形成的用户价值和长期壁垒；
- 最大副作用。

---

## 15. 后续模型必须交付的最终答案结构

请严格按以下结构输出，不要省略：

### A. 残酷总判

- 用不超过 500 字判断 Magic Pointer 当前最强资产、最大幻觉、最大工程债和最可能失败的原因。

### B. 唯一产品楔子

- 给出一个主楔子和一个备选；
- 解释为什么用户会为它迁移或先安装一个伴随层；
- 明确哪些看似诱人的方向必须放弃。

### C. Hermes 迁移与 parity 策略

- 给出“继承、代理、原生实现、明确不做”四类能力表；
- 设计无破坏导入、冲突预览、回滚和渐进迁移；
- 说明怎样先让 Hermes 用户获益，再降低其切换成本。

### D. 三个架构选项与单一推荐

- 至少三个真正不同的系统结构；
- 比较复杂度、延迟、token、可靠性、迁移性和创新空间；
- 最终只推荐一个，并写清为什么另外两个不选。

### E. 最小充分交互输入契约

- 重新设计或裁剪现有 normalized input；
- 给出首轮预算、渐进读取、指代衰减、歧义升级和用户纠正机制；
- 说明哪些字段绝不能进入执行坐标。

### F. Least-Sufficient Execution

- 给出简单任务零 Agent/小模型/完整 Agent/Swarm 的准入、升级和停止协议；
- 避免关键词规则泥潭；
- 给出真实成本账本与 intelligence-density 指标。

### G. Memory Constitution

- 给出类型、写入准入、巩固、召回、冲突、遗忘、用户编辑、迁移与预算；
- 明确哪些 neuroscience 灵感被采用，怎样操作化；
- 明确哪些流行记忆方案不采用以及原因。

### H. 主动性与动态超图

- 定义主动性的权力边界和学习信号；
- 判断超图是否必要；若必要，给出其唯一职责、最小 Schema 和物化阈值；若不必要，给出更简单替代。

### I. Swarm 与经验网络

- 默认单 Agent；给出展开为群体的严格门槛；
- 设计原子任务、结果 transport、programmatic merge 和经验晋升；
- 明确怎样避免正确结果在二次总结中丢失。

### J. 12 → 3 原创机制淘汰赛

- 先提出至少 12 个候选；
- 做 prior-art 对照和失败分析；
- 淘汰到 3 个；
- 对前三名给出最小实验、可证伪指标、预期壁垒与实施 seam；
- 如果前三名仍只是已有方法拼装，必须继续生成，直到机制层面有新增。

### K. 90 天研究—产品路线

- 不是功能堆积计划；
- 每阶段只围绕一个关键假设；
- 每阶段有用户任务、对照、指标、停止条件；
- 先验证楔子与成本收益，再扩生态和多 Agent；
- 说明哪些现有模块应删除、保留或延后。

### L. 红队反驳

- 站在 Hermes 重度用户、Pi 极简主义者、企业工作流负责人、HCI 研究者和系统工程师五个角色上，分别指出推荐方案最可能失败的地方；
- 最后说明什么证据会让你推翻自己的推荐。

---

## 16. 评价指标：不要再用“功能数量”和“模型说完成了”

建议后续模型至少在以下指标中选出一组主指标，并解释取舍：

| 指标 | 定义 |
|---|---|
| Grounding success | 第一次就命中用户真实指代对象的比例 |
| Time-to-useful-first-step | 从手势完成到出现第一个真实有用、可验证步骤的时间 |
| Prompt construction burden | 用户为组织任务额外输入的字数、动作数和时间 |
| Context efficiency | 每个有效结果进入模型的输入 token，以及其中真正被使用的信息比例 |
| Tool-call necessity | 工具调用中有多少确实改变下一步决策；多少属于可避免探测 |
| Verified completion rate | 有外部状态/文件/测试/读回证据的完成率 |
| Correct-result retention | 中间正确结果最终无损进入交付物的比例 |
| Human intervention cost | 每个任务的澄清、审批、纠错和重新解释次数 |
| Proactivity net value | 主动建议节省的操作量减去误报、打断和纠正成本 |
| Memory precision | 被召回记忆中实际有助于当前决策且未过期的比例 |
| Memory pollution | 被用户纠正/删除、导致错误或无任何未来使用的记忆比例 |
| Procedure reuse yield | 已验证 Procedure 带来的节省减去验证与漂移处理成本 |
| Resource cost per useful result | 每个被验证有用结果的模型费、token、CPU、内存和耗时 |
| Recovery success | 进程/网络/应用变化后从 Receipt/Session 恢复而不重复副作用的比例 |
| Migration retained value | 导入后可直接继续使用的配置、技能、记忆和工作流资产比例 |
| Focus-steal incidents | Agent 抢焦点、鼠标或破坏用户当前窗口的次数 |
| Evidence egress | 实际离开本机的数据量、范围和敏感性 |

不建议把以下作为主指标：工具数量、Agent 数量、Memory 条数、支持模型数量、最长上下文、自动运行时长、模型自评成功率、Demo 中点击次数。

---

## 17. 证据等级与来源边界

### 17.1 如何阅读这些资料

- **A级**：官方源码中可定位的机制、正式论文、官方 release 的具体功能；
- **B级**：官方 benchmark，但尚无独立复现；可形成假设，不能直接宣称领先；
- **C级**：Reddit/GitHub 社区个案；用于发现工作流损失和迁移心理，不代表总体用户；
- **D级**：营销口号、stars、单一 Demo；只能用于发现热度，不能用于架构决策。

### 17.2 关键一手来源

#### Magic Pointer 本地事实（已在本文件转述，无需外部读取）

- 当前产品真源：`docs/design/MAGIC_POINTER_HARNESS_20260811.md`
- 当前状态：`docs/STATUS.md`
- 2026-08-15 社区调研：`docs/research/2026-08-15-agent-community-real-needs.md`
- 2026-08-16 Agent 地基整合计划：`docs/superpowers/plans/2026-08-16-agent-foundation-consolidation.md`
- 2026-08-15 HCI 输入 Schema：`docs/2026-08-15-HCI_SYSTEM_REVIEW.md`
- 外部 Agent 连接边界：`docs/AGENT_INTEGRATION.md`

#### Agent/Harness 官方来源

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [Hermes v0.20.2 / 2026.8.16](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.8.16)
- [Pi](https://github.com/earendil-works/pi)
- [Claude Code](https://github.com/anthropics/claude-code)
- [OpenAI Codex](https://github.com/openai/codex)
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli)
- [Omnigent](https://github.com/omnigent-ai/omnigent)
- [Shepherd](https://github.com/shepherd-agents/shepherd)
- [OpenSquilla](https://github.com/opensquilla/opensquilla)

#### EvoX/EvoMap

- [EvoMap](https://evomap.ai/)
- [EvoX Swarm experiment](https://evomap.ai/blog/how-ai-swarms-win-from-26-to-71-percent)
- [EvoX harness benchmark report](https://evomap.ai/research/evox-benchmark-claude-code-codex)
- [EvoMap Evolver](https://github.com/EvoMap/evolver)
- [Evolver v2.0.2](https://github.com/EvoMap/evolver/releases/tag/v2.0.2)

#### Memory/Context

- [OpenViking](https://github.com/volcengine/OpenViking)
- [OpenViking Context Layers](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/03-context-layers.md)
- [Hindsight](https://github.com/vectorize-io/hindsight)
- [Magic Context](https://github.com/cortexkit/magic-context)
- [deja-vu](https://github.com/vshulcz/deja-vu)
- [Graft](https://github.com/NanoNets/Graft)
- [XERJ](https://github.com/xerj-org/xerj)
- [PRISM](https://arxiv.org/abs/2605.12260)
- [GAM](https://aclanthology.org/2026.acl-long.1600/)
- [APEX-MEM](https://aclanthology.org/2026.acl-long.749/)

#### 指代、主动性与群体组织

- [EGOPOINTVQA / HINT](https://arxiv.org/abs/2603.12533)
- [GesVLA](https://arxiv.org/abs/2605.22812)
- [PersonalAlign](https://aclanthology.org/2026.acl-long.1669/)
- [PersonalAlign GitHub](https://github.com/JiuTian-VL/PersonalAlign)
- [ProcAgent](https://arxiv.org/abs/2607.24770)
- [EvoHyper](https://aclanthology.org/2026.findings-acl.1258/)
- [HyperAgent](https://arxiv.org/abs/2608.02650)

#### 社区样本

- [Three months with Hermes Agent](https://www.reddit.com/r/hermesagent/comments/1u8fm0t/three_months_with_hermes_agent_what_i_wish_i_had/)
- [Hermes feature/plugin criticism](https://www.reddit.com/r/hermesagent/comments/1tx1jt9/unpopular_opinion_hermes_agent_takes_the_path_of/)
- [Hermes proactive/reliability failure](https://www.reddit.com/r/hermesagent/comments/1v5tixs/how_do_you_get_hermes_agent_to_actually_do_stuff/)
- [Migration from OpenClaw to Hermes](https://www.reddit.com/r/CustomAI/comments/1tvlb65/i_tested_hermes_agent_locally_after_openclaw_and/)
- [Hermes Desktop discussion](https://www.reddit.com/r/LocalLLaMA/comments/1tve7qu/nous_research_hermes_desktop/)
- [Best Local Agents — June 2026](https://www.reddit.com/r/LocalLLaMA/comments/1uaebfe/best_local_agents_jun_2026/)

---

## 18. 最后的提醒

Magic Pointer 现在最不缺的是更多名词、更多模块和更多参考源码。它缺的是：

- 一个用户愿意安装、愿意从 Hermes 等系统迁入或并用的明确理由；
- 一条从手势感知到真实验证的纵向闭环；
- 一个能证明“更少输入、更少 token、更少工具、更少纠错、更多真实完成”的测量系统；
- 少数真正原创、简单、高杠杆、能在当前生产 seam 上被证伪的机制。

请把本项目当作一个要进入真实工作流、承受长期使用和迁移成本的产品，而不是论文原型。也请把“创新”理解为对信息流、权力边界、学习准入或交付方式的重新安排，而不是给已有模块换一个生物学名字。

现在请按第 15 节的结构，给出你的完整审议结果。
