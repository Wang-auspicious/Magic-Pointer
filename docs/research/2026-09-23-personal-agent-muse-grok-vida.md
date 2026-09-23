# Personal agent：Muse、Grok Bot、Vida 与 Magic Pointer

调研日期：2026-09-23。以下产品事实来自厂商当日可访问的公开页面；它们说明厂商**发布或宣称**了什么，不等于独立验收了可靠性、覆盖率或用户留存。本文只提出产品判断，不实施功能。

## 结论

**Vida 可以被理解为面向个人工作的 personal agent。** 它当前把自己称为“会学习你如何工作的主动式 AI 工作伙伴”，重点是持续理解工作上下文、在原有工具中做事，以及让用户查看、编辑、删除记忆和限定可见应用。[Vida 桌面产品页，访问于 2026-09-23](https://vida.app/desktop/)；[Vida 场景页，访问于 2026-09-23](https://vida.app/sotacases/)。这仍是厂商定位；其跨应用任务成功率、后台持续运行和主动触发效果，公开页面没有足够的独立数据可核实。

**Magic Pointer 靠近这个方向是顺着既有产品边界发展。** 它已有自有 Runtime、跨时任务边界、手势指代编译和按用户唤醒记录的记忆原则；下一步产品焦点应是把“我当下指的这个对象”持续连到个人目标、授权材料、任务进度和可验证结果。这里的 *personal* 是用户与任务上下文的连续关系，*agent* 是能在授权范围内主动找材料、推进并完成任务。两者合在一起，才超出一次性聊天。此判断依据本仓库 [README](../../README.md) 及本机产品文档 `docs/design/MAGIC_POINTER_HARNESS_20260811.md`、`PRD.md`；不是声称下述全部体验已经交付。

## 产品身份与公开能力

| 产品 | 当前可核实的定位和机制 | 公开边界 |
| --- | --- | --- |
| **Meta Muse** | Meta 于 **2026-09-08** 发布的个人 AI agent。用户可在 Muse 应用或 WhatsApp 交谈；其个人云 VM 带浏览器、文件系统和终端，能处理邮件、表单、预订、生成文件，并在应用关闭后继续任务。产品设计说明明确：一个主对话、项目 side chat、持久记忆、Goals、活动日志、可编辑记忆、可调节主动消息和结构化批准卡。[发布公告](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)；[设计说明](https://introducing.muse.ai/) | 当日公告说先在美国向 iOS、Android 和网页推出；“多数日常使用免费”，但没有可据以计算的任务配额。Confidential VM 被列为**以后**推出；Meta 的安全文档承认当前架构仍可能让 Meta 为支持、安全或运营而访问数据，也承认 agent 会犯错。[公告](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)；[安全设计，2026-09-08](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) |
| **Grok Bot** | xAI 于 **2026-08-11** 以 beta 发布的“AI teammates”。每个命名 Bot 保留自身会话、偏好和工作记忆；同一用户的 Bots 共用一台持久云电脑及其文件、浏览器登录，可并行协作、交接任务。网站操作结合连接器与 computer use；成功流程可存成 skill，再由日程或支持的事件触发 routine。[发布公告](https://x.ai/news/introducing-grok-bot)；[官方概览](https://docs.x.ai/grok-bot/overview)；[Skills 与 routines，文档更新于 2026-09-14](https://docs.x.ai/grok-bot/skills-routines-and-automations) | 云电脑的隔离单位是**用户，不是 Bot**；各 Bot 共用登录与文件。网站可阻止自动化、使会话过期或要求人工步骤。敏感动作有批准和 Auto Review；本地电脑执行是另外授权，文档称默认每次询问。初始公告称面向指定付费套餐，当前文档列出更广平台与套餐，具体可用性应按登录账号核对。[电脑与应用文档，更新于 2026-09-14](https://docs.x.ai/grok-bot/computer-and-apps)；[批准与隐私](https://docs.x.ai/grok-bot/approvals-security-and-privacy)；[概览](https://docs.x.ai/grok-bot/overview) |
| **Einsia Vida** | 官网目前使用 “Viskey & Vida” 和“proactive AI work companion”定位，承诺理解工作、随使用学习、在现有工具中工作，并允许用户查看/改/删记忆、暂停上下文收集及排除应用。[桌面产品页，访问于 2026-09-23](https://vida.app/desktop/) | 场景页当日实际列出 **10** 个场景，其中 **5** 个标为 *Achieved*（Reply/Prompt/Resume Rescue、Workspace Cleanup、Daily Wrap），另 **5** 个标为 *Under Conquest*。标题里的“100”不能当成已交付数量；这些状态也都是厂商自述。[场景页，访问于 2026-09-23](https://vida.app/sotacases/) |

Muse 与 Grok Bot 的产品身份要区分清楚：这里的 Muse 指 **Meta 的个人代理产品**，其底层模型名为 Muse Spark；Grok Bot 指 **持久 AI teammate 产品**，不是 X 上回答提问的普通 Grok 聊天机器人。[Meta 公告](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)；[Grok Bot 官方概览](https://docs.x.ai/grok-bot/overview)。

## “很热”目前能证明到什么程度

这是一个**厂商密集发布的产品方向**：Google 在 **2026-05-19** 宣布可在后台处理任务的 Gemini Spark，OpenAI 在 **2026-07-09** 宣布跨应用和文件、可持续数小时的 ChatGPT Work，接着是 **08-11** 的 Grok Bot 和 **09-08** 的 Muse。[Google 公告](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)；[OpenAI 公告](https://openai.com/index/chatgpt-for-your-most-ambitious-work/)；[Grok Bot 公告](https://x.ai/news/introducing-grok-bot)；[Muse 公告](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)。这些一手资料支持“头部厂商正在争夺持续代理入口”；它们本身**不能证明** personal agent 已被大规模高频使用，也不能证明这些产品在真实长任务中的完成率。

公开产品形态的交集已经很明确：**持久身份与记忆、跨应用工具、后台任务、进度/活动可见、关键动作由人批准**。Muse 在个人生活目标和主动建议上更强调整体陪伴；Grok Bot 把多角色分工、示范学习及工作流程复用放在中心；Vida 将用户当前桌面和历史工作上下文纳入入口。上述是对各家官方设计的归纳，不是能力优劣排名。[Muse 设计说明](https://introducing.muse.ai/)；[Grok Bot 官方概览](https://docs.x.ai/grok-bot/overview)；[Vida 桌面产品页](https://vida.app/desktop/)。

## 本仓库代码量（只读 Git 统计）

以 `app/`、`electron/`、`integrations/`、`native/` 中被 Git 跟踪的 `.py/.ts/.tsx/.js/.jsx/.css/.html/.cs/.ps1/.mjs/.cjs` 文件为产品源码，计算物理行数，**包含空行与注释**；工具脚本和测试单列，不计文档、构建产物、依赖和本地运行数据。三个时点使用同一口径：

| 时点与提交 | 产品源码 | 工具脚本 `scripts/`、`tools/` | 测试 `tests/` |
| --- | ---: | ---: | ---: |
| 2026-08-11 `452ba55` | 203 文件 / **56,918 行** | 20,848 行 | 32,443 行 |
| 2026-09-20 `4c6d7b6`，TypeScript 迁移前 | 427 文件 / **136,622 行** | 35,016 行 | 73,628 行 |
| 2026-09-23 `2893564`，当前 | 207 文件 / **71,050 行** | 12,402 行 | 23,001 行 |

当前产品源码比 9 月 20 日少 **65,572 行（48.0%）**，比 8 月 11 日多 **14,132 行（24.8%）**。当前构成为 TypeScript 58,443 行、CSS 11,468 行、HTML 1,123 行、JavaScript 16 行；Python 产品源码为 0。9 月 22 日的 `2f3a2d5` 与 `aaea7c6` 是源码瘦身和应用 Runtime 迁移的主要节点。`electron/renderer/studio.ts`（7,053 行）与 `electron/main.ts`（6,249 行）合计占当前产品源码约 **18.7%**。行数下降反映仓库体积变化，不证明旧能力已逐项等价保留，也不是质量评分。本轮未跑测试。

## 对 Magic Pointer 的研究建议

1. **把现有“指向→对象→任务”延长成“个人目标→授权材料→持续执行→结果”。** 手势在鼠标释放时固定历史像素与对象身份，是 MP 的明确起点；后续任务应保留该对象与用户修正过的指代、未完成计划、来源链接和产物版本，跨会话继续。用户应能从一个入口看到任务现在在做什么、下一步是什么、需要自己决定什么。这与现有自有 Runtime 和 EventSession 的方向相符；见本机 `docs/design/MAGIC_POINTER_HARNESS_20260811.md` §1、§10、§14 及 `PRD.md` W10。
2. **让个人记忆可用、可查、可改、可忘，并在动作前读新鲜来源。** 记录用户主动提供或明确授权的材料、任务回执、编辑与纠正；给每条记忆保留来源和有效性。旧摘要可帮助找到目标，但写入/发送前要回到当前文档或应用确认。Vida/Muse 的公开设计都把可编辑记忆和权限可见性放到前台；MP 本机架构文档已有“唤醒事件记忆”的明确边界。[Vida 桌面产品页](https://vida.app/desktop/)；[Muse 设计说明](https://introducing.muse.ai/)。
3. **主动性从用户设定的有限范围开始。** 对选定文件、任务、时间或消息来源设关注，变化时先形成有证据的草稿或提议；同一事实不重复打扰，用户随时暂停或撤销。涉及发送、购买、删除等动作，保留精确目标和效果的批准与实际结果回执。本机 `PRD.md` W12 已把明确授权的关注列为后续工作，**截至本次调研不能把 W12 说成已完成**；架构母文档也明确不做默认全天持续录屏。[Muse 设计说明](https://introducing.muse.ai/)；[Grok Bot routines 文档](https://docs.x.ai/grok-bot/skills-routines-and-automations)。
4. **从真实交付中学习工作方法。** 将用户反复认可并纠正过的跨应用流程提炼成可编辑的候选 skill；每次执行仍要重新确认来源、目标和现行权限。Grok Bot 的“示范一次→复核 skill→再调度”提供了具体产品参考；MP 本机架构文档已有“成功流程只成为候选，不自动获得永久权限”的规则。[Grok Bot Skills 与 routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)。

**定位判断（推断）：** Muse 的个人云电脑和 Grok Bot 的云端 Bot 团队都能处理跨应用工作；MP 的差异是**以用户本机当时真正指向的对象为任务起点，并在同一自有 Runtime 中持续完成**。因此适合先把办公/设计资料的跨应用理解、原件局部修改、用户可接管的长任务和明确授权的有限主动关注连成完整体验。上述优先序是基于本项目既有边界与竞品公开材料的产品建议；本轮没有做产品测试或代码修改。
