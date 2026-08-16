# Agent 社区真实需求调研：Magic Pointer 应该解决什么

> 调研日期：2026-08-15  
> 调研方式：agent-reach（X / Reddit，使用 OpenCLI 读取公开帖子、评论和评论树）  
> 目标：从开发者在官方发布帖下留下的真实反馈中，提炼 Magic Pointer 能解决、值得解决、且不能靠产品叙事硬凑的需求。  
> 重要边界：本文是产品证据与优先级输入，不等于 Magic Pointer 已经具备这些能力；“架构有预留”不等于“可交付”。

## 1. 结论先行

这轮调研最重要的结论不是“大家想要一个更强的 Agent”，而是：

**大家已经有 Claude Code、Codex、Pi、Hermes 或 Kimi Code 这样的 Agent；他们缺的是一个能把真实桌面现场可靠地交给 Agent、把行动锁在用户意图内、把结果变成可核验交付物的执行层。**

Magic Pointer 最有机会占住的不是“再造一个 Claude Code”，而是下面这条链：

**人指向当前现场 → 系统冻结当时看到的对象 → 编译成可携带上下文 → 让用户选择/确认 Agent 的动作 → 执行后读回验证 → 给出可追溯、可恢复的结果。**

社区反复出现的真实痛点，可以压缩成八个词：

1. **指对**：Agent 必须知道用户说的“这个、那段、这里”到底指什么，而不是重新扫整屏或让用户手动找文件路径。
2. **说清**：用户要知道 Agent 看到了什么、用了哪个模型/工具、改了什么、为什么停下。
3. **不乱动**：权限、确认、撤销、沙箱和不可逆操作必须是系统合同，不应由模型自己保证。
4. **不中断**：断线、重启、更新、长任务、上下文压缩后仍能恢复，而不是重新解释一遍。
5. **不打扰**：后台任务不能抢焦点、夺鼠标、拖慢电脑，也不能默认常驻录屏。
6. **不浪费**：上下文、工具列表、失败重试和长输出要受控；用户需要知道消耗和剩余预算。
7. **能交接**：结果要能从一个会话、Agent 或应用带到另一个，而不是困在聊天记录里。
8. **有人在环**：主动性不是“无限自治”，而是按用户授权在合适的时机提醒、询问和请求决定。

这八点正好与 Magic Pointer 的产品边界重叠：FrameLease、ObjectGraph、ContextCompiler、DraftArtifact、ActionLease、SurfaceAdapter、Verification、TaskStore 和 RunLedger 都可以为它们提供确定性底座。

但需要明确：当前仓库仍处于 frame-lease foundation 阶段。当前最重要的交付不是多 Agent、MCP 市场或视觉特效，而是先确保 pointerup 冻结的是用户刚刚指过的历史画面，不能捕捉到之后变化的屏幕。

## 2. 我如何判断“是真需求”

社交媒体评论不是问卷，也不是每个点赞都代表购买意愿。本次采用以下证据分级：

| 级别 | 含义 | 如何使用 |
|---|---|---|
| A | 官方产品发布帖下的具体问题、故障、请求，且描述了实际工作流 | 直接作为需求候选 |
| B | 不同产品或社区中独立重复出现的同一痛点 | 提升优先级，说明不是单个产品的偶然 bug |
| C | 竞品已把能力做成产品，评论中出现迁移、比较或替代诉求 | 作为市场信号，不自动等于 Magic Pointer 应照抄 |
| D | 纯表态、模型饭圈、价格抱怨但没有可执行场景、重复 emoji | 不进入产品需求 |

本文重点记录 A/B 级证据，C 级只用来判断边界。评论中的“想要”不会直接变成需求；只有能回答“用户在什么场景下损失了时间、信任或结果”，才进入需求池。

## 3. 指定四条 X 帖：全部读完后的高价值需求

### 3.1 Benjamin Pasero：最重要的一条

来源：[Benjamin Pasero 的官方发布帖](https://x.com/BenjaminPasero/status/2088134390442307697)

读取结果：帖子加评论共 148 个对象，逐条阅读。

这条帖下最有价值的不是某一个 UI 建议，而是它暴露了“Agent 桌面产品”的真实断裂：

| 评论中出现的需求 | 原始评论代表 | 对 Magic Pointer 的含义 |
|---|---|---|
| 任务完成必须能交接：原始目标、范围、改了哪些文件、跑过什么命令/测试、还有什么失败、提交信息 | defaultsettle | 这是 MP 最应该做成结构化 Receipt 的需求；不要只把聊天记录转发给下一个 Agent |
| 用户在等待 Agent 时继续输入，输入被吞进 thinking 或不能形成真正的下一条消息 | option2ghost | 需要明确的 turn 状态、输入队列、steer/cancel 语义；排队不能伪装成已发送 |
| 会话历史难搜索、按主题组织和恢复困难 | option2ghost、ddfpivasp、SoyZetaDeZorro | 需要任务、对象、工件索引，而不是只有聊天列表 |
| 想要 Director Agent + 持久的专门 Worker，能生成、管理、恢复子任务 | geladaris_georg、jake_moshel | 是多 Agent 管理需求，但不是 MP 当前第一阶段；必须建立在 TaskStore、预算和证据之上 |
| 远程会话断开、空白、线程名不同步；会话恢复不顺滑 | LS_Andrew、finlayekins | 断线恢复和终态记录比“再加一个模型”更重要 |
| 多窗口、多会话、列式布局、多个账号和 MCP 配置 | sarabiafrenz、nikforester | 这是工作区管理诉求；MP 可先提供对象、任务、Agent 的清晰路由，不必先做全功能 IDE |
| VS Code 与桌面 Agent 的实时同步、在编辑器里发语音命令、对计算机操作必须可确认 | 0xinha | MP 的价值是把桌面指代编译给现有 Agent，并在高风险动作前保留显式授权 |
| 研究结果直接交给 Claude Code，避免人工写 handoff 文档 | jackbremer、nthonymiller | Handoff 不是附加功能，而是 MP 的核心商业价值 |
| Skills、Plugins、MCP 入口隐藏，用户看不见、不会配 | datagobes、finlayekins | Capability Broker 必须能解释能力来源、权限和失败原因；不一定要做插件市场 |
| side chat 不知道上下文、模型、工具，可能悄悄执行终端 | SeanBlundin、gafiegarcia | 任何旁路 Agent 都需要可见上下文、权限和执行回执 |
| 任务建议应该能启动自定义环境或进程；多个 Claude Code 在同一个工作区协作 | finlayekins、RealFMH | 应把环境、工作目录、会话 ID、子任务关系写入任务合同 |
| 移动端连接失败会丢消息；手机需要看状态、通知和接管 | Quizcroc、DanielNe36 | 先做可恢复 durable task 和可导出的 Receipt，再考虑移动端 |
| App 更新后 spawned task 丢失、多个 Claude 占用 RAM 很高 | eve_silb | ResourceGovernor、任务持久化、更新后的子进程清理都是可靠性需求 |
| 用户分不清 chat、cowork、Claude Code 什么时候该用哪个 | ChuckReynolds | MP 不应再创造一个模糊的“万能 Agent”；要明确“取/问改/交”和交给哪一个 Agent |
| 代码和聊天分离、项目管理差、需要更强的文件和工件浏览 | Trisjl1、TheLeeBase、gafiegarcia | DraftArtifact、工件索引和项目/任务关系比装饰性卡片更重要 |

这条帖给 Magic Pointer 的最强提示是：

**桌面 Agent 的核心单位不是聊天消息，而是一个可以被指向、被执行、被验证、被交接的任务 Episode。**

### 3.2 Thijs Sottiaux：一条“系统健康”反馈帖

来源：[Thijs Sottiaux 的 Computer History 帖](https://x.com/thsottiaux/status/2088133823619895712)

读取结果：帖子加评论共 134 个对象，逐条阅读。

原帖本身展示了应用切换、标签页、Slack 使用等历史统计。评论把注意力从“有趣的统计”拉回了 Agent 产品最容易被忽视的系统问题：

- 常驻功能导致内存增长、CPU 占用、鼠标卡顿、输入延迟、长会话逐渐失去响应。
- Windows 支持不完整、自动退出、更新后残留进程、不同平台能力不透明。
- 用户担心键盘记录、历史收集和“操作系统级监控”，并要求 allowlist，而不是让用户一个个排除敏感应用。
- 长时间会话经过多次 compaction 后质量坍塌；Agent 反复失败仍继续循环，烧掉配额。
- 用户不懂模型、reasoning level、额度和消耗；“自动选模型”和“停止无效循环”比更多模型名更有价值。
- Computer Use 一旦碰到 modal、焦点、cookie 或意外 UI 状态，就会进入错误状态；用户要的是状态重新确认和退出路径，而不是一个只会继续点的脚本。
- 读代码时“逐字朗读”没有帮助；用户要摘要、解释和下一步，而不是把屏幕内容重新念一遍。
- 用户需要明确知道数据去了哪里、哪一个 Agent 正在读取什么、什么时候会把数据发送到云端。

对 MP 的结论：

1. **常驻不等于持续采集。** MP 的 UIA 可以常驻，但必须 idle/event-driven；capture、OCR、深读和模型调用只能在明确唤醒、手势或任务发生后启动。
2. **ResourceGovernor 是产品能力，不是优化项。** 只有当资源、token、子进程和后台任务有上限、有 stop reason，用户才敢把它留在桌面上。
3. **不要承诺解决 Claude 的供应商额度。** MP 可以减少错误上下文、无效重试和无界输出，但不能把第三方的 quota 变成无限。

### 3.3 Fei：多 Agent 协作不是“多开几个聊天框”

来源：[Fei 关于 Grok Bot 多 Agent 协作的帖子](https://x.com/Fei2411/status/2087418325588693071)

读取结果：帖子加评论共 76 个对象，逐条阅读。

评论集中在：

- Agent 之间能否互相通信，以及是否支持 A2A、跨进程、跨模型、OAuth/API。
- 能否把 Agent 组织成一个“公司/团队”，有负责人、成员和任务关系。
- 能否接入 Teams 或其他协作工具，与人一起工作。
- 是否能直接操作社交账号、发帖；这里同时出现了非常明确的风险控制需求：产品方回答不应无条件开放。
- 云端 VM、长任务和本地电脑关闭后是否还能继续。
- 价格、额度和“这么多 Agent 是否值得”的疑问。

对 MP 的结论：

**多 Agent 的价值不在于屏幕上显示很多头像，而在于任务关系、权限边界、状态回执和失败接管。**

MP 可以把一个桌面 Episode 分派给现有 Agent，但在没有 durable TaskStore、Agent-to-Agent Receipt、预算和审批之前，做“Agent 公司”只会制造视觉幻觉。

### 3.4 Tianyi：Harness 研究者关心的是证据和可恢复性

来源：[Tianyi 的 DeepSeek Harness 招募帖](https://x.com/tianyi/status/2084693319188439211)

读取结果：帖子加评论共 87 个对象，逐条阅读。

这是四条帖里最接近 Magic Pointer 架构的讨论。高价值反馈包括：

- 需要 audit log、token diff、tool trace、state recovery 和 replay。
- 需要把文件范围、权限、预算、回滚、verifier evidence 写进执行合同。
- 需要 coordinator + subagent tree、分层记忆、SQLite/FTS 检索、跨 Agent 的共享项目状态。
- 需要企业式任务链：上级分配 → 计划 → 用户确认 → worker 执行 → 自检 → manager 复核 → 最终归档。
- 需要事实、假设、动作依据、验证结果分离，阻止 Agent 用流畅的语言假装完成。
- 需要低延迟反馈、批量/并行调用、按需加载工具、上下文压缩和 prefix cache。
- 需要手机通知长任务、失败恢复、跨设备/跨项目上下文。
- 需要“只请求一小段 JSON/字段”，不要每次把整份大文件塞回上下文。
- 需要可观测合同：工具边界、状态、失败原因、成本和 replay sample 可以导出。

对 MP 的结论：

这条帖验证了 Magic Pointer 的核心方向：**确定性状态、权限、坐标、证据和验证必须在模型外部。** Agent 负责判断和生成，MP 负责把现场、动作和结果变成有期限、可核验的合同。

## 4. 扩展阅读：Claude Code、Hermes、Pi、Kimi、Computer Use 和主动性 Agent

### 4.1 Claude Code：用户愿意为结果付费，但不愿意为失控过程买单

本轮没有把 Claude Code 当成“竞品功能清单”，而是把它当作 Magic Pointer 需要承认的基线：用户已经习惯项目上下文、文件编辑、终端执行、权限确认、hooks、skills、MCP、多会话、子 Agent、worktree 和长任务工作流。Magic Pointer 不能用一个气泡 UI 假装替代这些能力。

在官方 Claude 相关帖子和 r/ClaudeAI 高评论讨论中，反复出现的痛点是：

- context、compaction、长会话和失败重试会浪费大量 token；
- 额度、消耗不透明，用户不知道为什么一个简单任务烧掉这么多；
- Agent 会在失败后重复相同路径，用户需要硬停；
- 更新、断线、远程会话和后台任务恢复不可靠；
- 代码改好了但 handoff、测试、未解决问题和决策依据没有被结构化保存；
- 多 Agent 让吞吐更高，但也带来 RAM、协调、文件冲突和结果合并成本；
- 用户希望“写好规格后让 Agent 自己跑，只有需要决定时才来找我”，但又不接受没有边界的常驻自治；
- 破坏性 shell 命令的灾难案例使用户明确要求沙箱、deny-by-default、回滚和备份。

这对 MP 的定位很关键：

**Claude Code 负责代码工程本身；MP 负责把代码之外的桌面现场、用户指代、权限和可验证交接接入 Claude Code。**

### 4.2 Hermes：真正有粘性的不是“会自己学习”，而是连续工作记忆和后台任务

来源：

- [Hermes Desktop 官方帖](https://x.com/NousResearch/status/2061843507417944552)
- [Hermes Kanban / 多 Agent 官方帖](https://x.com/NousResearch/status/2050997692977844324)
- [Hermes 的学习/记忆讨论](https://x.com/NousResearch/status/2026758996107898954)
- [r/LocalLLaMA Hermes Desktop 讨论](https://www.reddit.com/r/LocalLLaMA/comments/1tve7qu/nous_research_hermes_desktop/)
- [Nous Research AMA](https://www.reddit.com/r/LocalLLaMA/comments/1sz2y76/ama_with_nous_research_ask_us_anything/)

社区认可的方向：

- 本地 Agent + 桌面应用让 Agent 更接近真实机器，而不只是聊天窗口。
- 记忆、cron、heartbeat、定时/周期任务和主动消息让一次性助手变成“持续工作的同事”。
- Kanban、任务队列、claim/block/handoff 比单纯多开窗口更适合管理多 Agent。
- MCP/技能需要按需加载，否则工具列表和上下文会膨胀。
- profile、导入/导出、凭据隔离、沙箱和本地模型支持决定了能否长期使用。
- 用户要能编辑、批准、锁定记忆和技能；“自动自我改写”必须可见、可回滚。

反复出现的失败：

- 安装、更新、卸载、Windows 支持、Chrome/扩展兼容性不稳定。
- UI 被认为丑、难懂，CLI 能力没有很好地进入桌面产品。
- 本地模型 provider 检测失败，初次配置摩擦太大。
- 自动任务和普通聊天混在一起，真正的对话被 cron 噪声淹没。
- 全桌面权限让用户不放心；本地运行并不自动等于安全。
- Agent 记忆会漂移、重复、覆盖新旧结论；用户需要带时间、退出码、来源和状态的记忆。

对 MP 的可取部分：

- 可以借鉴其“持续任务”与“结果归档”的思路，但 MP 的记忆对象应首先是用户明确圈选过的 Episode、任务和工件，而不是默认收集所有屏幕历史。
- 可以把“后台任务的普通聊天视图”和“主动任务视图”分开；MP 不能让后台任务偷偷改变当前视觉状态。
- 可以把技能、能力显示成可解释的 Capability，而不是把 MCP 名字堆在设置页。

### 4.3 Pi：简洁 harness 的价值在于可控、低耗和可扩展

来源：

- [Pi 官方关于 vanilla 与扩展的讨论](https://x.com/badlogicgames/status/2043342359551766929)
- [Composio 同模型跨 harness 对比](https://x.com/composio/status/2086814488162972027)
- [Best Local Agents megathread](https://www.reddit.com/r/LocalLLaMA/comments/1uaebfe/best_local_agents_jun_2026/)

社区把 Pi 的优势归结为：

- harness 简洁、token 开销低、扩展机制直接；
- 同一个模型换 harness 后，成本、成功率、延迟和失败恢复会明显变化；
- 通过 extension、RPC、subagent、web、remote、memory 等小模块组合，而不是把一切都塞进核心；
- 安全扩展可以默认 deny，高风险动作显式审批；
- GUI 仍有价值，因为纯 CLI/TUI 对很多用户不够可见、不够容易恢复。

重要提醒：

**“Pi 更便宜或更高分”不是 Magic Pointer 的需求本身。** 它提示我们应该让 harness 的成本、延迟、重试、阻塞时间、人工介入和最终结果可测，而不是只展示模型名字或 Agent 数量。

### 4.4 Kimi Code、Kimi Work、WebBridge：跨 Agent 的浏览器桥是实际需求，但信任边界更难

来源：

- [Kimi Work：本地桌面 Agent、swarm、记忆](https://x.com/Kimi_Moonshot/status/2063990409903112344)
- [Kimi WebBridge：支持 Kimi Code、Claude Code、Cursor、Codex、Hermes](https://x.com/Kimi_Moonshot/status/2054918374837322140)
- [Kimi Code 官方介绍](https://x.com/Kimi_Moonshot/status/2016034259350520226)

评论和相关讨论说明：

- 用户确实想让 Claude Code、Codex、Hermes 等共享同一个浏览器现场，而不是每个 Agent 都维护一套浏览器自动化。
- 浏览器桥的核心体验是复用登录态、当前 tab、表单和真实网页，而不是让用户重新复制 URL、Cookie 和页面内容。
- 但 DOM 合成事件、isTrusted、CAPTCHA、反自动化、社交媒体封禁、跨 profile 和 tab 状态污染都是硬边界。
- “Agent 能点击”不等于“Agent 知道点击是否生效、现在处于哪个页面、提交后的结果是否正确”。
- 本地监听端口、自动安装 skill、凭据和浏览器历史都需要用户可见、可撤销、可按应用或站点限制。

对 MP 的可取部分：

- MP 可以做统一的“当前对象、当前窗口、当前区域”上下文入口，让现有 Agent 获得同一份冻结现场。
- 浏览器、桌面、微信、Office 等应通过 SurfaceAdapter/Capability 合同进入，不能在核心里写应用 if/else。
- MP 不能把“浏览器桥”宣传成万能 Web 自动化；高风险站点、登录、支付、发帖和社交账号操作必须显式授权，并且必须有结果验证或明确失败。

### 4.5 Computer Use：真实需求是“后台但不失控”，不是“帮我乱点电脑”

来源：

- [Gemini Computer Use 官方发布及评论](https://x.com/_philschmid/status/2069819170477293863)
- [Cua Driver：后台 Computer Use](https://x.com/trycua/status/2067639336703775037)
- [OpenAI Windows Computer Use / 移动端 review-steer](https://x.com/OpenAI/status/2060428604727771421)
- [OpenAI Mac Computer Use](https://x.com/OpenAI/status/2044827932145897652)
- [Computer Use 相关 Reddit 搜索样本](https://www.reddit.com/r/LocalLLaMA/comments/1sxqa2c/im_done_with_using_local_llms_for_coding/)

高频真实需求：

- Agent 能操作那些没有 API、没有 MCP、只有 GUI 的旧系统和桌面软件。
- Agent 在后台运行时，用户仍能使用自己的电脑；不能抢焦点、夺鼠标或把主窗口推到前台。
- Agent 必须在每一步重新确认当前状态，尤其是 modal、cookie、权限对话框和页面跳转后。
- 需要用户确认、prompt-injection auto-stop、allowlist、沙箱和操作回执。
- 需要知道一次操作改了什么、是否验证成功、失败后停在哪里。
- 需要非视觉模型也能通过桥接访问浏览器或桌面，但不能因此失去安全边界。

高频否定反馈：

- 只展示“它会点、会滚、会打字”的 demo 不足以证明长期可靠。
- Computer Use 会消耗大量 token 和计算额度，若失败后继续循环，成本不可接受。
- 即使操作在屏幕上成功，Agent 也可能不知道业务结果是否成功。
- 常驻屏幕数据会触发隐私和监控恐惧；用户更愿意授权一次明确动作，而不是开放全天候观察。

这与 Magic Pointer 的战略边界一致：**MP 不做通用 OSWorld，不替用户长期接管电脑；MP 首先让用户用鼠标明确指出目标，再把受限、可验证的动作交给合适的 Agent 或 SurfaceAdapter。**

### 4.6 主动性 Agent：用户要的是“记得帮我”，不是“替我拥有生活”

来源：

- [Claude 官方主动维护实验](https://x.com/bcherny/status/2088014489438621990)
- [Claude /loop 讨论](https://x.com/bcherny/status/2030193932404150413)
- [主动性 Agent X 搜索样本](https://x.com/dannypostma/status/2088181331465253045)
- [Reddit ADHD 主动性 Agent 经验帖](https://www.reddit.com/r/AI_Agents/comments/1tw7te9/adhd_how_im_using_ai_agents_to_help_me_be/)

真实场景比“自主 Agent”这个词具体得多：

- 用户发一条文字或语音，Agent 把承诺、截止时间和相关上下文放进任务表，之后在合适时间提醒。
- Agent 读邮件或消息，只在需要用户决定时通知；不是每天发一堆摘要。
- Agent 反复跟进“还没完成”的小任务，直到用户明确完成、取消或改变计划。
- 代码库维护 Agent 在没有问题时保持安静，只在有结果、风险或需要决定时出现。
- 长任务完成后发通知，并提供暂停、继续、接管和验证入口。
- 用户愿意授权小范围读写，但不愿意给无限制邮件、金融和社交权限。

因此主动性的最小安全合同应是：

**用户明确创建任务 → 明确作用范围和提醒方式 → Agent 按时间或事件运行 → 需要行动时询问 → 写入、发送等高风险动作重新确认 → 结果可追踪、可取消、可归档。**

Magic Pointer 当前不应直接承诺“全天候主动 Agent”。首先应把显式手势触发的短任务做得可靠，再建设受约束的任务唤醒。

## 5. Magic Pointer 需求矩阵

状态定义：

- **现在能解决**：已有代码或合同可以支持，完成当前基础阶段后能形成可交付体验。
- **架构已预留**：设计上有模块或接口，但当前状态文档明确还有缺口，不能对外宣称 READY。
- **后续解决**：需求真实，但依赖前面的安全、持久化或资源治理基础。
- **不应承诺**：超出 Magic Pointer 产品边界，或需要第三方供应商保证。

| 优先级 | 真实需求 | 证据 | MP 解决方式 | 当前判断 |
|---|---|---|---|---|
| P0 | “这个、那段、这里”必须指向用户刚看到的对象 | Benjamin、Tianyi、Kimi WebBridge、Claude/CU 评论 | FrameLease 冻结像素；ObjectGraph 绑定 UIA/OCR/视觉证据；ContextCompiler 生成 Episode | 架构已预留；frame-lease foundation 尚未完成 |
| P0 | 不重新截图、不把全屏上传给模型 | Benjamin 指代评论；Computer History 隐私评论 | pointerup 后冻结历史画面；保留完整本地目标面证据，按权限选择上传片段 | 核心原则已确定，需继续做时序测试 |
| P0 | 破坏性操作前必须可见确认、可拒绝、可撤销 | Reddit rm -rf、Gemini CU、OpenAI CU、Tianyi | ActionLease、Capability Broker、审批门、UndoLog、Verification | 模块有预留，但 STATUS 记载生产调用仍不完整 |
| P0 | 结果不能靠模型一句“完成了” | defaultsettle、haoli、qianqiongge、NeoSoulAI | 执行前计划图；执行后验证；保存 Receipt：对象、动作、文件、命令、测试、错误、未决项 | 架构方向正确；需要端到端验收 |
| P0 | 用户电脑仍可用，Agent 不能抢焦点或鼠标 | Cua Driver、OpenAI CU、Thijs 帖评论 | MP 只在明确任务唤醒；后台路径、资源限额、焦点保护、捕获前后状态对比 | UIA 可常驻；完整后台 CU 不是当前交付 |
| P0 | 断线、更新、关闭窗口后可以恢复 | Benjamin、Hermes、OpenAI、Claude loop 评论 | durable TaskStore、task id、协议、日志、steer/cancel、终态、重连 | 架构已预留；更新清理和 UI 恢复仍是缺口 |
| P1 | Agent 需要看到“当前对象”，而不是用户手动找路径 | Benjamin、产品定位、Kimi Work | native hook/plugin 优先；Claude UserPromptSubmit、Pi before_agent_start；MCP 只作兼容 | 已有接入设计；需以 FrameLease 正确性为前提 |
| P1 | 研究、回答、修改结果要能编辑后再投递 | Benjamin、jackbremer、Hermes 用户 | 版本化 DraftArtifact；气泡内编辑；记录用户编辑与 Agent patch；发送目标和会话 ID 可见 | STATUS 明确 direct edit 尚未接通 |
| P1 | 每一次 Agent 执行都知道使用了哪个模型、工具、权限、预算 | Tianyi、Composio、Claude usage 评论 | RunLedger、Capability Broker、Provider/Model/Cost/Error 字段、可导出 Receipt | 数据结构有方向；ledger 与 capability 提示回路尚未完成 |
| P1 | 失败要分类、停住并告诉用户下一步 | Claude limits、Hermes AMA、Pi/LocalLLaMA | failure class、stop reason、重试上限、用户接管、验证失败而非假成功 | 部分已有，需纳入所有执行链 |
| P1 | 上下文、工具、长输出按需加载，避免 token 浪费 | Tianyi、Hermes AMA、Manus、Claude limits | concurrent evidence fusion；按字段查询；工具和技能懒加载；输出截断和摘要 | 设计已明确，需看真实 token 和延迟数据 |
| P1 | 把跨应用现场交给 Claude Code、Pi、Codex，不锁模型 | Benjamin、Kimi WebBridge、Claude baseline | SurfaceAdapter + native hook + session protocol + ACP 预留；MCP last | 这是 MP 核心差异，不能退化为单一模型壳 |
| P1 | 用户能快速知道“哪个 Agent 在做什么” | Benjamin、Fei、Hermes Kanban | 当前 Task、Agent、Surface、Permission 卡片；清晰的 route、状态、暂停、接管 | 需要视觉与任务状态 UI；先保证状态模型 |
| P1 | 主动任务只在需要用户时打扰 | Claude maintenance、/loop、ADHD Reddit | 明确创建的 durable task、唤醒策略、ask_user、通知、取消和归档 | ask_user bridge UI、数据回路尚有缺口 |
| P1 | 屏幕证据不能变成全天候监控 | Computer History、Hermes、隐私评论 | 事件或手势触发；本地 evidence fence；敏感应用阻断；不做 Recall | 已在产品边界内，必须持续守住 |
| P2 | 多 Agent 协作、队列、负责人、worker | Fei、Tianyi、Benjamin、Kimi Work | MPAgentRuntime + TaskStore + Agent-to-Agent Receipt + worktree/资源隔离 | 需求强；等单 Agent Receipt 和权限成熟后 |
| P2 | 多模型自动路由 | Thijs、Pi、Composio | Capability/Provider contract；按任务选择，不把路由交给黑盒 | 能做，但不是首要 wedge |
| P2 | 语音、手机通知、远程接管 | Benjamin、Fei、Claude/CU、ADHD Reddit | 语音为旁路输入；任务通知；远程只传控制和结果，不默认传全屏 | 语音不是主路径；移动和远程后置 |
| P2 | Skills、Plugins、MCP 可见、可安装、可导入导出 | Benjamin、Hermes AMA、Kimi | Capability Broker、权限/来源/版本、沙箱和签名 | 生态后置；先完成核心契约 |
| 不应承诺 | 取代 Claude Code 的项目级代码 Agent | Claude Code 社区基线 | MP 只编译桌面现场、做受限接入和交接 | 明确不做 |
| 不应承诺 | 全天候录屏、Recall 式记忆 | Thijs、隐私评论 | 只保存用户指过的 Episode 和任务 | 明确不做 |
| 不应承诺 | 通用 OSWorld 或全自动电脑接管 | CU 评论、产品边界 | 只做明确目标、受限动作、读回验证 | 明确不做 |
| 不应承诺 | 修复 Claude 或其他供应商的额度、价格和服务中断 | Claude limits Reddit、各产品价格评论 | 只能减少无效上下文和重试，并诚实报告成本和错误 | 明确不做 |

## 6. 适合 Magic Pointer 的产品形态

### 6.1 核心产品句子

**Magic Pointer 不是另一个 Agent；它是 Agent 使用真实桌面时的意图编译器和安全交接层。**

### 6.2 最小闭环

1. 用户在任意应用中指向一块区域、一行、一张图、一个窗口或一个不可复制对象。
2. gesture completion 立即冻结历史像素，生成有期限的 FrameLease。
3. 本地并行获取 UIA、OCR、结构和像素证据，不在模型侧猜用户指的是什么。
4. 把对象、应用、窗口、文件或页码、bbox、文本、截图路径和敏感性编译为 Episode。
5. 用户输入“解释、改这个、把它交给 Claude Code、用这段报错修复”。
6. ContextCompiler 生成可编辑 DraftArtifact；用户可修改、删减或补充范围。
7. Agent 通过 native hook 或 session protocol 接收；MCP 仅在没有更好的接入时使用。
8. 如有写入、发送、删除、运行等动作，ActionLease 重新验证对象、参数、权限和时效。
9. SurfaceAdapter 执行；读回目标表面和结构化结果做验证。
10. 生成 Receipt：看了什么、做了什么、结果是什么、哪些没完成、下一步是什么。

这个闭环同时满足社区的“快速”“真实桌面”“不丢上下文”“可交接”“可证明”和“可控风险”。

### 6.3 适合首批交付的场景

#### 场景 A：圈住报错弹窗，交给 Claude Code

用户圈住不可复制的报错弹窗，输入“修这个”。MP 提供：

- 冻结的报错图和完整目标面；
- OCR 文本、窗口标题、前后 UIA 关系；
- 当前文件或项目路径（若能确定）；
- 可编辑的任务草稿；
- Claude Code session handoff；
- 最终变更、测试、未解决错误和回滚入口。

这不是与 Claude Code 竞争，而是解决“报错在 GUI 里、代码 Agent 看不到”的交接问题。

#### 场景 B：圈住聊天中的表格截图，提取并整理

用户圈住微信、邮件或网页中的表格截图，MP 提取文字与表格结构，用户编辑字段，交给用户选定的 Agent 生成 CSV、Excel、Markdown 或回复草稿。发送或写回前要重新确认。

#### 场景 C：圈住网页或后台系统中的一条记录，问“这是什么或帮我处理”

MP 先做只读证据和对象定位，再路由到 Browser 或 SurfaceAdapter。若动作是提交、删除、发帖、支付或改变状态，必须显示计划、范围、审批和验证结果。

#### 场景 D：多个 Agent 的结果合并

先支持“把这个现场和已有任务交给另一个 Agent”，并把结果保存为可验证 Receipt。多 Agent 并发只在任务、文件范围、资源预算和冲突策略明确后进入。

## 7. 按阶段的产品路线

### Phase 0：FrameLease 正确性（现在，最高优先级）

验收目标：

- pointerup 对应的像素一定是手势完成前的历史画面；
- 后续 UIA、DOM、OCR 或 overlay 不能改变已观察状态；
- 全本地目标面证据保留；手势小 crop 不能成为唯一证据；
- usedBackend、capture timing、errors 真实记录；
- 同一手势的 object id、时间戳、bbox、窗口和权限可回放；
- DPI、窗口移动、缩放、快速变化界面有明确失败语义。

不能在这一阶段用多 Agent、视觉风格或插件市场转移注意力。

### Phase 1：可信执行合同

验收目标：

- 每个写、发、删、跑动作都有 ActionLease；
- 预览包含对象、目标表面、参数、权限、审批要求、幂等键和 verify plan；
- 用户可以批准、拒绝、编辑参数或撤销；
- 失败分类和 stop reason 可见；
- 不能验证成功时，终态必须是“未知或待处理”，不能是“完成”；
- 关键动作生成可导出的 Receipt。

这里要把 STATUS 中“模块准备好但生产调用为零”的部分真正接入主链。

### Phase 2：DraftArtifact 与 Agent Handoff

验收目标：

- 用户编辑前后的草稿版本可追踪；
- Claude Code、Pi、Codex 等目标可见，包含 session、working directory、provider；
- hook、session、RPC 的发送状态、排队、steer、cancel 和 settled 语义清楚；
- 发送失败不会丢失用户输入；
- Agent 回传结果可回到同一任务 Episode；
- 从一个 Agent 交给另一个 Agent 时自动生成结构化 handoff，而不是要求用户复制聊天。

### Phase 3：恢复、成本和资源

验收目标：

- App 更新、断线、进程死亡后 TaskStore 能恢复；
- 子进程、工作区、worktree 和临时文件有生命周期；
- 每项运行记录模型、provider、工具、token 或估算成本、时间、重试和人工介入；
- 资源达到上限时自动暂停并解释；
- context compaction 有摘要、来源和可回溯边界；
- 失败任务不会无界重复。

### Phase 4：受约束的主动性

只在 Phase 1 至 3 稳定后做：

- 用户明确创建的 schedule、loop 或 task；
- 状态与普通聊天分开；
- 只有事件或任务需要时唤醒；
- 需要决定时通过 ask_user bridge 回到用户；
- 无动作时保持安静；
- 用户可暂停、取消、修改、导出和删除；
- 不默认采集屏幕、不默认读取所有消息、不默认访问账户。

### Phase 5：多 Agent 或团队

可做：

- Director 与 worker 关系；
- 子任务队列、claim、block、handoff；
- 每个 worker 的能力、权限、预算和文件范围；
- 结果合并、冲突和失败接管；
- 每个 Agent 的 Receipt 组成最终归档。

不可做：

- 用头像数量替代真实协调；
- 让多个 Agent 同时无边界写同一个目录；
- 没有用户可见的责任边界就自动发消息、发帖或改账户状态。

## 8. 需要写进产品和工程的非功能要求

### 8.1 可观察合同

每次任务至少记录：

- 用户意图原文和编辑后的版本；
- FrameLease、Episode、ObjectGraph ID；
- 捕获时间、窗口、应用、坐标、DPI 和 evidence source；
- 使用的 Agent、provider、model、session id；
- 工具或 SurfaceAdapter、参数摘要、权限模式；
- 等待时间、执行时间、重试次数、成本或 token 估算；
- 验证器、验证输入、验证输出；
- 最终状态：completed、failed、blocked、cancelled 或 unknown；
- 未解决问题、需要用户决定的事项、下一步；
- 可以安全分享的 handoff 版本。

### 8.2 可恢复合同

一个任务不能只存在于 renderer 的内存里。至少要有：

- durable task id；
- 当前 phase 和状态；
- 可重入或幂等信息；
- 输入草稿版本；
- 已产生的工件；
- 事件日志；
- cancel 或 steer 信息；
- 失败分类；
- 重新连接后用户能看懂的恢复提示。

### 8.3 安全合同

- 默认最小权限，不能用“模型说它安全”代替策略；
- 视觉、OCR、DOM 文本都视为不可信输入，尤其是网页 prompt injection；
- ActionLease 过期或对象变化时重新确认；
- 发送、删除、支付、发布、运行脚本和改系统设置需要额外门；
- 敏感应用可以 allowlist 或 denylist；
- 用户知道哪些数据会离开本机；
- 不保存全天候屏幕历史；
- 任何自动化失败都 fail-closed。

### 8.4 体验合同

- 零语音也能完整使用；语音只是加速方式；
- 从手势到可见反馈要快，等待深读或 Agent 时先告诉用户状态；
- 不在 Agent thinking 时吞掉用户输入；
- 不让用户猜“现在到底是排队、执行、等待确认还是失败”；
- 卡片或气泡必须能回到原对象、原任务和原 Receipt；
- 视觉漂亮不能掩盖状态不真实。

## 9. 不要被社区带偏的几个方向

### 9.1 “300 个 Agent”不等于能力

Kimi Work、Fei 的多 Agent 讨论和 Tianyi 帖下的评论都显示了对 swarm 的兴趣。但用户真正会感知的是：

- 任务能否拆对；
- 是否共享了必要而不是全部的上下文；
- 是否会争抢资源或写同一文件；
- 失败后谁负责；
- 结果能否合并、验证和回滚；
- 成本和时间是否比单 Agent 更好。

因此 MP 应先做“一个 Episode 的可验证闭环”，再做“多个 Agent 的协作图”。

### 9.2 “更主动”不等于“更聪明”

主动维护、/loop、cron、ADHD 用户都证明了提醒和跟进的价值，但也反复暴露：

- 提醒太多会变成噪声；
- 账号权限让用户害怕；
- 无界循环会烧钱；
- Agent 说已经处理但没有完成实际结果。

主动性的质量指标应是：减少用户召回成本、在正确时机出现、完成实际动作、需要时把决定交回人，而不是一天生成多少消息。

### 9.3 “能操作屏幕”不等于“能完成业务”

Computer Use 的 demo 容易展示点击，但业务完成还需要：

- 当前状态识别；
- 动作后确认；
- 目标结果校验；
- 失败退出；
- 权限和数据边界；
- 长任务恢复。

MP 的 ObjectGraph、SurfaceAdapter、Verification 和 Receipt 是补这个缺口的地方，不是再造一个更会点坐标的模型。

### 9.4 “工具越多”不等于“Agent 越强”

Hermes、Tianyi 和 Manus 讨论都提示工具列表会污染上下文。MP 的 Capability Broker 应该回答：

- 这个能力是否适用于当前目标；
- 来源和版本是什么；
- 会读或写什么；
- 是否需要审批；
- 失败会怎样；
- 能否验证结果。

如果不能回答这些，隐藏菜单和自动加载只会增加不信任。

## 10. 产品指标：不要只看模型成功率

针对 Magic Pointer，更有意义的指标是：

| 指标 | 含义 |
|---|---|
| Target grounding success | 用户指的目标是否被正确冻结、关联和解释 |
| Time to useful context | 从 pointerup 到 Agent 拿到可用上下文的时间 |
| Handoff edit rate | 用户是否需要大量改写 MP 生成的草稿 |
| Verified completion rate | 有验证证据的完成率，不把模型自报完成算进去 |
| Unknown/blocked honesty | 无法验证时是否诚实停在 unknown 或 blocked |
| Recovery success | 断线、更新或重启后是否能继续，而不是重做 |
| Human intervention cost | 每个短任务需要用户补多少步骤 |
| Unnecessary escalation rate | 是否把本可本地解决的小事过度交给模型 |
| Reversible action coverage | 高风险动作中有多少具备撤销或恢复路径 |
| Resource cost per useful result | 每个真正有用结果消耗的时间、token、CPU 和内存 |
| Focus-steal incidents | 后台任务抢焦点、改变用户当前窗口的次数 |
| Evidence egress | 任务实际离开本机的数据量和敏感性 |

不建议用以下指标做主指标：

- 同时运行了多少 Agent；
- 产生了多少 token；
- 视觉动画有多复杂；
- 调用了多少个工具；
- 没有验证的“成功”；
- 只在干净 demo 环境中的点击成功率。

## 11. 来源索引与读取范围

### 11.1 用户指定的四条 X

- [Benjamin Pasero：Claude/Agent 桌面反馈帖](https://x.com/BenjaminPasero/status/2088134390442307697)——148 个对象，全部阅读，最高优先级。
- [Thijs Sottiaux：Computer History / 桌面使用统计帖](https://x.com/thsottiaux/status/2088133823619895712)——134 个对象，全部阅读。
- [Fei：Grok Bot 多 Agent 协作帖](https://x.com/Fei2411/status/2087418325588693071)——76 个对象，全部阅读。
- [Tianyi：DeepSeek Harness 插件、技能、MCP、编排招募帖](https://x.com/tianyi/status/2084693319188439211)——87 个对象，全部阅读。

### 11.2 X 扩展样本

- [Hermes Desktop 官方帖](https://x.com/NousResearch/status/2061843507417944552)
- [Hermes Kanban 多 Agent 官方帖](https://x.com/NousResearch/status/2050997692977844324)
- [Hermes /loop 官方帖](https://x.com/NousResearch/status/2088367838977237029)
- [Claude Tag：主动、多用户、记忆](https://x.com/bcherny/status/2069474681749754272)
- [Claude 主动维护实验](https://x.com/bcherny/status/2088014489438621990)
- [Claude /loop](https://x.com/bcherny/status/2030193932404150413)
- [Kimi Work](https://x.com/Kimi_Moonshot/status/2063990409903112344)
- [Kimi WebBridge](https://x.com/Kimi_Moonshot/status/2054918374837322140)
- [Kimi Code](https://x.com/Kimi_Moonshot/status/2016034259350520226)
- [Gemini Computer Use](https://x.com/_philschmid/status/2069819170477293863)
- [Cua Driver 后台桌面控制](https://x.com/trycua/status/2067639336703775037)
- [Composio：同模型跨 Agent harness 对比](https://x.com/composio/status/2086814488162972027)
- [OpenAI Windows Computer Use / review-steer](https://x.com/OpenAI/status/2060428604727771421)
- [OpenAI Mac Computer Use](https://x.com/OpenAI/status/2044827932145897652)
- [Pi：vanilla 与扩展](https://x.com/badlogicgames/status/2043342359551766929)

扩展 X 帖采用了官方原帖、评论中高信号或高互动评论和关键词命中评论的组合阅读；评论区的低信息重复表态没有逐条写入本文。用户指定的四条则按上面的全量范围处理。

### 11.3 Reddit 高评论或高信号样本

- [Hermes Desktop](https://www.reddit.com/r/LocalLLaMA/comments/1tve7qu/nous_research_hermes_desktop/)
- [Nous Research AMA](https://www.reddit.com/r/LocalLLaMA/comments/1sz2y76/ama_with_nous_research_ask_us_anything/)
- [Best Local Agents - Jun 2026](https://www.reddit.com/r/LocalLLaMA/comments/1uaebfe/best_local_agents_jun_2026/)
- [Claude Code usage limits](https://www.reddit.com/r/ClaudeAI/comments/1s7zgj0/investigating_usage_limits_hitting_faster_than/)
- [Claude CLI 删除 home directory 的灾难案例](https://www.reddit.com/r/ClaudeAI/comments/1pgxckk/claude_cli_deleted_my_entire_home_directory_wiped/)
- [Hermes 自动记录 debugging session](https://www.reddit.com/r/AI_Agents/comments/1su7lz7/holy_crap_my_hermes_agent_just_documented_my/)
- [主动性 Agent 与 ADHD 生产力工作流](https://www.reddit.com/r/AI_Agents/comments/1tw7te9/adhd_how_im_using_ai_agents_to_help_me_be/)
- [Manus 后端负责人：Unix-style run tool 与 harness](https://www.reddit.com/r/LocalLLaMA/comments/1rrisqn/i_was_backend_lead_at_manus_after_building_agents/)

Reddit 采用搜索结果、帖子正文、可读取的高赞顶层评论和可展开的回复组合。个别大型评论树的 Reddit morechildren 展开接口返回 orphan 或 unplaceable 错误，因此本文不声称 Reddit 每一条嵌套回复都已完整读取；结论只使用多来源重复出现、且能落到具体工作流的内容。

### 11.4 本地 Magic Pointer 依据

本文的产品映射以以下仓库文档为准：

- [Magic Pointer Harness canonical design](../design/MAGIC_POINTER_HARNESS_20260811.md)
- [当前状态](../STATUS.md)
- [产品定位](../PRODUCT.md)
- [Agent 接入设计](../AGENT_INTEGRATION.md)

## 12. 最终产品判断

如果只能保留一句话：

**Magic Pointer 应该让用户用一次明确的指向，把“我此刻看到的这个东西”变成 Claude Code、Pi、Codex 或其他 Agent 能理解、能执行、能验证、能交接的短任务；它的护城河是意图与证据合同，不是模型数量。**

如果只能保留三个下一步：

1. 完成 frame-lease foundation，证明 pointerup 不会捕捉到未来画面。
2. 把 ActionLease、审批、读回验证、Receipt 接入真实主链，消灭“模型说完成了”。
3. 把 DraftArtifact、native handoff、TaskStore 和恢复状态做成用户能看懂的短任务体验。

在这三步完成以前，不应把资源投入到“Agent 公司”、全天候主动记忆、通用 Computer Use 或插件生态叙事上。社区确实对这些方向有兴趣，但他们最愿意留下来的前提仍然是：**目标没指错，机器没被拖慢，动作没越权，结果能证明，失败能恢复。**
