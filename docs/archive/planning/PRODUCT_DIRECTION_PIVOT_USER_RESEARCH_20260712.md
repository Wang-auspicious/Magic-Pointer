# Magic Pointer 产品方向转变：技术工作者真实痛点、证据调研与新产品定义

日期：2026-07-12（Asia/Shanghai）
文档性质：CEO 决策用研究备忘录，不是已批准的实现规格
适用人群：软件工程师、AI/vibe coding 用户、科研硕博、数据与技术型知识工作者

## 0. 结论先行：Magic Pointer 不应该是“鼠标旁边的 AI”，而应该是“把当前对象送到正确工作流的上下文动作路由器”（核心转向一，不少于 1000 字）

这次方向偏差的根本，不是购物清单做得不够漂亮，也不是 Dashboard 少了几个菜单，而是我把 Google 演示中的某个动作样例当成了目标用户的核心工作。购物清单适合作为工程验证：它能证明选区冻结、typed action、真实写入、回读、幂等和撤销；但它不能证明产品价值。面向技术人员、科研硕博和 vibe coding 用户时，“把意大利面加入购物清单”几乎不在他们每天最高频、最高痛的任务链上。继续沿着购物清单、独立本地日历、独立路线、预约卡逐个造功能，会让 Magic Pointer 变成一个功能很多但每项都比成熟软件浅的杂物箱。这个路线必须立即停止扩张。

新的产品定义应该是：Magic Pointer 是 Windows 上的 contextual action router。它利用鼠标或选区最独特的价值——用户已经用身体动作明确指出了“哪个对象”——把这个对象连同来源、位置、应用、文件、页面、仓库、截图区域和时间一起封装成可靠上下文，然后用一个极短命令把它送到下一步工作系统。产品的核心循环不是 `Point → Ask → Answer`，而是 `Point → Capture → Route → Confirm → Verify`。答案不是第一产物，进入正确工具的可继续工作对象才是第一产物。例如，选中报错堆栈后说“交给当前 agent 排查”，结果应是一个带仓库、分支、终端输出、文件和行号的上下文包进入用户已经在用的 Codex/Claude Code/Cursor 工作流；选中论文中的结论和图后说“记到这篇论文”，结果应是 Zotero child note 或 Obsidian literature note，保留 DOI、页码、PDF 坐标和截图；选中需求讨论说“记成待办”，结果应进入 Microsoft To Do、Todoist、Linear、GitHub Issues 或用户指定的 Obsidian Task，而不是 Magic Pointer 自己再造一个孤岛清单。

鼠标形态的优势只存在于短、频繁、对象明确、目标动作有限的瞬间。长对话、复杂架构设计、跨仓库修改、长时间 autonomous coding，本来就应留给网页 AI、IDE agent 或 CLI agent。Magic Pointer 不与这些工具竞争智能深度，而是减少用户把上下文复制、截图、找文件、解释来源、切窗口和重新描述任务的成本。它还可以在不需要模型时直接完成确定性动作：格式化 JSON、识别文件路径、把表格转 CSV、生成引用、提取 DOI、复制 Markdown 链接、打开文件所在目录、把终端报错打包成 issue 草稿。只有字段真的需要语义补全时才调用小模型或云模型。

因此，现有购物清单功能应降级为内部测试样例或“通用任务 provider 的本地 mock”，不得继续占据 Dashboard 第一导航。现有本地日历应保留 schema、冲突检测、receipt 和测试作为 provider sandbox，但产品默认目标应改成 Microsoft 365/Outlook、Google Calendar 或 ICS 文件；现有路线卡只保留 deep-link provider，不作为核心卖点；Table Merge 的二维模型对科研和数据用户有真实价值，可以升级。此前投入并非全部浪费：SelectionSession、THIS/THAT/THESE/HERE、grounding、一次性 token、写后验证和精确撤销正是新方向需要的底座。需要丢弃的是“我们自己承载所有结果和业务数据”的假设。

## 1. 调研方法、证据等级与局限：不能把几个热帖当需求，也不能只看演示猜产品（核心转向二，不少于 1000 字）

本轮采用四类公开证据交叉验证。第一类是同类或邻近工具的 GitHub Issues/Discussions，重点看用户主动报告的失败、反复要求的能力和维护者明确的技术边界。样本包括 PowerToys Advanced Paste、Command Palette、Text Extractor，VS Code/Copilot Chat，Continue，Zotero Better Notes、Obsidian Zotero Integration、Obsidian Tasks，以及本地屏幕上下文项目。GitHub Issue 的优点是场景具体，常包含复现步骤、预期行为、失败行为和维护者回答；缺点是样本偏向技术用户和遇到问题的人，不能把点赞数直接当市场规模。

第二类是官方生态文档，用来判断“成熟服务能否复用”，而不是凭记忆猜 Windows 是否有 API。Microsoft Graph 明确支持 To Do task list、task、checklist、linkedResource 和 delta query；linkedResource 可以把任务链接回触发它的来源。Graph Calendar 支持向指定日历创建 event，并返回事件对象。GitHub REST API 可创建 issue；Linear 提供 `linear.new` 和 GraphQL；Notion API 可在数据源下创建页面并应用模板；Obsidian 官方 URI 支持创建、打开、prepend/append；Zotero Web API 支持写 item、note、child item，并用版本号或 `If-Unmodified-Since-Version` 防止覆盖新版本。这些证据说明我们应该投资 connector contract、授权、幂等、来源链接和验证，而不是重写任务、日历、笔记和文献管理器。

第三类是大样本调查与研究报道，用于校准 AI 的位置。Stack Overflow 2025 开发者调查显示，AI 使用或计划使用很普遍，但对准确性的主动不信任高于信任，只有极少数高度信任。这意味着产品不能把所有动作都变成“让模型猜一下”；更合理的是把模型放在候选解析层，把目标、权限和写入验证留给确定性代码。Nature 报道的近 5000 名研究者调查显示，研究者希望 AI 让工作更快，但同时需要更多支持理解能力边界。JetBrains 对开发工作流的研究也提示，AI 并没有简单消除上下文切换，而是改变并可能加剧碎片化。我们的机会不是制造第四个聊天入口，而是把上下文和结果接回用户现有工具。

第四类是 X、Reddit、小红书等公开社媒搜索。本轮必须诚实记录局限：X 的公开搜索能获得少量开发者关于多项目切换和责任边界的帖子；Reddit 能看到额度、缓存计费、本地模型、Obsidian 快速捕获等具体讨论；但小红书公开网页对搜索引擎开放有限，结果高度偏商业内容，无法在未登录和不可复现的条件下形成可靠样本。因此本文不会伪造“看了很多小红书用户都这么说”。正式产品决策还需要 12—18 名目标用户访谈和 7 天 diary study，社媒只能生成假设，不能替代验证。

证据记录的原则是：一个需求进入 P0，至少要满足“目标用户工作频繁”“鼠标能明显减少摩擦”“已有工具不能以同样成本完成”“能通过 API/协议可靠落地”中的三项。演示中出现、视觉吸引、实现容易、模型能做，都不能单独构成 P0 理由。文档后续每个方向均标注证据、推论和仍需验证的假设，避免再次把工程样例提升为产品主线。

## 2. 技术人员和 vibe coding 用户的真实痛点：不是不会问 AI，而是上下文散、工具重、结果难接续（核心方向一，不少于 1000 字）

技术用户已经拥有很强的网页 AI、IDE AI 和 CLI agent。Magic Pointer 如果只是把“解释这段代码”放到鼠标旁，通常更差：短窗口读不了长答案，模型拿不到仓库结构、依赖、测试、Git 状态和终端历史；用户追问两轮后仍要切回 IDE 或 CLI。公开 issue 能证明这种上下文断裂是真问题。VS Code Copilot Chat 的 issue #827 中，用户报告只有高亮文本时模型才看得到文件；甚至从 Quick Fix 发起“Explain Using Copilot”时，没有选中代码就丢失引发错误的文件上下文。Continue 的 issue #5291 则显示把大文件直接塞给模型会触发 context length 限制。另一个 Continue issue 中出现“模型说已修改，实际没有修改”的假成功。这些并不说明用户需要另一个聊天窗，而是说明上下文选择、范围控制、执行验证和回到来源必须成为一等能力。

第二个痛点是简单任务使用 agent 过重。开发者为了一个 JSON 格式化、一段堆栈解析、路径转义、生成 curl、把错误整理成 issue、从截图复制代码，往往需要打开聊天、粘贴、解释、等待模型、再复制结果。PowerToys Advanced Paste 已经证明系统级转换存在需求，但其 issue 同时暴露 API Key 权限错误、provider 锁定和额外付费焦虑；后续 PowerToys 甚至扩展到 Ollama、Foundry Local 和多家在线 provider。Copilot issue #7343 直接记录 agent mode usage limit 不透明造成的不满。对 Magic Pointer 的启示不是“做更便宜的聊天”，而是建立任务成本分层：能用本地 parser/Windows API/脚本完成的任务零模型；能由小型本地模型分类或抽字段的任务用本地模型；只有跨文件推理、模糊语义和高价值生成才交给用户已有云 provider，并在发送前显示预计上下文大小。

第三个痛点是从“看到问题”到“形成可执行工作项”的搬运。真实开发流程常发生在浏览器文档、GitHub discussion、Slack/Teams、终端、监控面板、PDF 规范和 IDE 之间。用户看到一段错误或需求，需要手工复制正文、找仓库、建 GitHub/Linear issue、补标题、贴日志、写复现、链接来源，再回到 agent。Magic Pointer 最有价值的技术工作流应是 `Capture as Work Item` 和 `Send to Agent`：对象选中后，本地收集当前 app、窗口、URL、repo root、branch、文件/行号、选择正文、终端命令、截图和敏感级别，生成可预览 Context Capsule。用户说“记成 bug”，选择默认 GitHub/Linear 后只补缺失字段；说“让当前 agent 处理”，则把 capsule 写入任务级 Markdown/JSON artifact，交给用户指定的 Codex、Claude Code、Cursor 或 VS Code 命令入口。Magic Pointer 不代替 agent 执行长任务，只负责让 agent 从一开始拿到正确、最小、可追溯的上下文。

第四个痛点是信任与控制。Stack Overflow 2025 调查中，46% 的开发者不信任 AI 输出准确性，信任者约 33%，高度信任仅 3%。因此产品默认不应自动改代码、运行命令或提交 issue。鼠标入口应该先展示动作摘要：“将 1 段终端错误、2 个相关文件和当前 Git diff 作为诊断任务发送到 Codex；不包含 `.env`。”用户确认后才发送。完成时必须返回真实目标链接、task/thread ID 或文件路径，而不是“已处理”。这比把模型回答做得更长更重要。

技术用户 P0 场景应按价值排序为：选中错误→打包给现有 agent；选中需求→创建 GitHub/Linear/To Do 工作项并回链来源；选中代码/终端→确定性微工具；选中网页/PDF 代码→保真 OCR 后复制或落文件；选中多个表格/日志→结构化合并与导出；选中文档片段→生成可验证引用/链接。普通解释、翻译和长问答保留为低优先级兼容能力，默认引导到用户已有 AI surface。

## 3. 科研硕博的真实痛点：阅读、证据、任务和写作之间反复搬运，来源很容易丢（核心方向二，不少于 1000 字）

科研用户的工作对象不是抽象“文本”，而是论文条目、PDF 页、图、表、公式、引用、实验参数、代码仓库、数据集和待验证假设。真正的摩擦是这些对象散落在 Zotero、浏览器、PDF 阅读器、Obsidian/Notion、Word/LaTeX、Jupyter、Excel 和任务系统之间。一个博士生看到论文第 7 页的一张图，可能要截图片、复制 caption、记录论文题目/DOI/页码、写自己的判断、链接到研究主题笔记，再创建“复现 Figure 3”的任务。当前 Magic Pointer 如果只给一段图像解释，反而把最重要的证据链丢了。

Zotero 与 Obsidian 社区的公开项目非常能说明问题。Zotero Better Notes 把“annotation 一键转 note”“模板汇总多篇论文标注”“Markdown 双向同步”“导出 Word/PDF/Markdown”作为核心工作流，并公开编辑器、note、sync、convert API。Obsidian Zotero Integration 的 issue 列表长期出现连接失效、annotation/attachment 嵌套、导入后空笔记、成功后进度不消失、某些条目 annotation 丢失等问题。其文档还提示重复导入可能覆盖现有 Markdown，某些路径会丢图片、颜色和 annotation link。这些痛点都指向“保留身份和版本”的重要性，而不是需要另一个 AI 总结面板。

科研方向的第一核心功能应是 `Capture Research Evidence`。用户在 PDF 内选中句子、圈选公式、图或表后，说“记到这篇论文”或“放进研究问题 X”，Magic Pointer 创建 Evidence Capsule：Zotero item key/DOI/标题、PDF attachment key、页码、选区坐标、原文、截图/结构化表、用户短评、时间和来源哈希。若 Zotero 已安装并授权，优先通过 Zotero 插件 API 或 Web API 创建 child note/annotation link；若用户以 Obsidian 为主，则使用官方 URI 或直接在已配置 vault 中生成带 frontmatter 的 literature note block；如果两者都用，则 Zotero 保留文献真相，Obsidian 只保存 citekey 和深链，避免复制两套不可同步的数据。

第二核心功能是 `Paper → Action`。看到方法限制时说“记为实验风险”，进入当前课题的风险清单；看到 future work 说“加入待读/待复现”，进入 Microsoft To Do、Todoist、Obsidian Tasks 或 GitHub issue，并自动回链原论文页。Microsoft Graph To Do 的 linkedResource 天然支持把任务连接到来源对象，正适合这种设计。任务字段不应只是一句正文，还应包含课题、截止时间、优先级、证据引用和完成定义。模型可以从一句话中建议标题和日期，但最终任务由成熟任务系统同步到手机和邮件生态，Magic Pointer 不再维护孤立任务库。

第三核心功能是 `Structure, not summarize`。科研用户常需要把论文表格转 CSV/XLSX、把图中坐标点数字化、把公式转 LaTeX、把参考文献转 BibTeX、把实验设置抽成参数表、把多个 paper 的同类指标对齐。这里很多步骤可以确定性或半确定性完成：PDF text layer/字符框优先，OCR/VLM 只做候选；表格解析必须展示列映射；公式识别要同时保留截图；引用元数据先查 DOI/Crossref/Zotero translator，不用模型杜撰。输出应落到 Excel、CSV、`.bib`、Markdown 或 notebook，而不是停在 Reader 中。

第四核心功能是隐私和可复现。未发表论文、审稿稿件、病人数据、实验日志不能默认上传。每个 recipe 应标明 Local / Existing API / Cloud AI，发送前显示字段而不是模糊云图标。模型生成的结论不能混入原始证据；Evidence Capsule 需要明确 `verbatim`、`extracted`、`model_suggested`、`user_note` 四层。用户后来打开笔记时必须知道哪段是原文、哪段是 OCR、哪段是 AI。Nature 对近 5000 名研究者的调查显示大家希望 AI 加速工作，但需要更多支持理解如何使用，这正说明“能力边界和证据出处”本身就是产品功能。

科研用户 P0 顺序应是：PDF/网页证据→Zotero/Obsidian；证据→真实待办系统；表/公式/引用结构化导出；多篇证据收集篮与对齐；一键把当前实验错误和 notebook 上下文交给 coding agent。长论文总结、文献综述写作和复杂推理交给网页/CLI AI，Magic Pointer 负责把正确文献集合与引用送进去，并把结果作为带来源的 artifact 写回。

## 4. 鼠标、网页 AI、IDE/CLI Agent 的边界：产品必须主动把不适合自己的任务交出去（核心转向三，不少于 1000 字）

此前默认假设是：只要用户圈到对象，任何 AI 功能都可以在附近完成。这不成立。鼠标形态最强的是空间指代和即时性，最弱的是长阅读、长输入、多轮规划和后台执行。网页 AI 擅长长对话、广泛知识、文档上传和结果阅读；IDE/CLI agent 擅长仓库级上下文、工具调用、测试、Git 和长时间任务；Magic Pointer 擅长用户正在看的具体对象、跨应用瞬时选择和一个短动作。如果不主动划界，产品一定会成为三者都不如的折中品。

适合 Magic Pointer 原地完成的任务应同时满足：输入对象在屏幕上明确；命令可在几个词内表达；输出很短或直接写入目标；风险可以预览；通常在数秒内完成。典型包括复制/格式化/转换、创建任务或 issue 草稿、保存证据、打开相关文件、把片段追加到指定笔记、提取 DOI/路径/表格、将 THIS 与 THAT 绑定后生成 diff/compare、将 context capsule 投递给 agent。结果反馈只需“已创建 DEV-431”“已追加到 Experiment Log”“已发送给 Codex task 8a…”并提供撤销或打开目标。

应该转交网页 AI 的任务包括：解释一整篇论文、比较十种框架、写长方案、持续追问、浏览大量公开资料、创作长文和需要宽屏阅读的答案。Magic Pointer 可以做两件辅助工作：一是把用户圈选的对象和来源打包成网页 AI 可理解的 prompt/attachment；二是把最终答案中的选中部分再投递回笔记或任务系统。它不应在 Dashboard 中复制一套聊天历史。

应该转交 IDE/CLI agent 的任务包括：修改多个文件、安装依赖、运行测试、调试环境、持续监控进程、创建分支/PR 和跨仓库分析。Magic Pointer 的入口可以让这类任务开始得更快。例如用户圈选浏览器里的报错，说“在当前项目修这个”，系统识别当前 repo 与 IDE session，生成一个待确认 capsule；确认后通过 provider adapter 向 Codex/Claude Code/Cursor 创建任务。后续状态只在轻量 activity 中显示，详细日志仍由 agent 自己承载。用户不应在鼠标浮层里看 build log。

还需要一条成本边界。每个 recipe 在注册时声明 execution tier：Tier 0 deterministic（无模型）、Tier 1 local small model、Tier 2 user subscription/connected agent、Tier 3 paid cloud API。路由器优先选择最低可满足能力的 tier。`格式化 JSON` 永远 Tier 0；`判断这段是不是报错并抽取路径`可先 regex/parser，不足才本地模型；`把需求改写成 issue 标题`可以用小模型，也允许用户直接使用原文；`分析根因并修复仓库`发送到已订阅 agent。Dashboard 显示本周节省的云请求数、各 provider 使用量和最近一次上传内容摘要，让“心疼额度”从情绪变成可控策略。

产品还应允许完全关闭内置生成式 AI，只保留 grounding、deterministic recipes、connector 和 agent handoff。PowerToys Advanced Paste 从只支持 OpenAI发展到多 provider 和本地模型，相关 issue 清楚说明用户不愿被单一 API Key 和额外付费绑定。Magic Pointer 的差异不应是再卖一个模型套餐，而应是让用户已有的模型、本地模型和订阅工具协同工作。

## 5. 三条可选转向路径与推荐：连接器优先，确定性微工具做护城河，Agent handoff 做高价值出口（每条方案与取舍，不少于 1000 字）

### 方案 A：继续做“全能原生 Dashboard OS”——不推荐

这条路会把购物清单扩成任务系统，把本地日历扩成日历客户端，把路线扩成地图，把 Table Merge 扩成数据工具，再加笔记、历史和聊天。优点是所有数据结构和视觉完全受控，演示时连贯，离线功能容易做 mock。缺点是商业上几乎不可成立：每个领域都有成熟产品、同步、多端、权限、通知、协作和生态；我们需要同时追赶 Microsoft To Do、Outlook、Todoist、Notion、Obsidian、Zotero、Excel、GitHub 和地图服务。用户不会为了鼠标入口迁移真实工作数据，最终 Dashboard 只剩 demo 数据。更严重的是，这条路会持续吞噬研发资源，使真正独特的 grounding 和 context routing 停滞。现有购物清单已经验证了这个风险。

### 方案 B：Connector-first Context Router——推荐主路线

Dashboard 不再是业务应用，而是控制中心：Connections、Recipes、Inbox/Review、Activity/Undo、Privacy & Cost。用户首次设置选择“任务默认进 Microsoft To Do”“代码问题默认 GitHub repo/Linear team”“论文证据默认 Zotero + Obsidian vault”“长任务默认 Codex”。日常使用时 Dashboard 多数不出现；鼠标旁只显示动作和目标，例如“创建 To Do：复现 Figure 3”“发送到 GitHub：repo/name”“追加到 Obsidian：Research Inbox”。只有缺字段、目标歧义、权限失效或高风险时才打开 review card。

优势是直接借成熟生态完成同步、移动端、提醒、团队协作和搜索，Magic Pointer 聚焦自身不可替代能力。Microsoft Graph To Do 支持 linkedResource，正好保留来源；Graph Calendar 返回真实 event；GitHub/Linear/Notion/Zotero 都有正式 API；Obsidian 有 URI 和本地文件。风险是 OAuth、API 版本、企业权限和 connector 维护成本较高，且 Windows 应用并不都有统一 API。应对方式是 provider contract + capability discovery + deep link/API/plugin 分级，而不是声称“兼容所有软件”。

### 方案 C：Local-first Micro-tool Engine——推荐作为护城河，不单独成为产品

把 Magic Pointer 做成鼠标驱动的 Raycast/PowerToys recipes：用户圈选对象后运行本地动作，支持脚本、PowerShell、Python、小模型、MCP 和社区插件。它能提供极低成本、隐私和高度可定制性，特别适合技术用户。PowerToys、Raycast Script Commands、Flow Launcher 的成功证明 power-user plugin 模式有需求。但纯工具引擎容易变成“装完不知道做什么”，普通用户要自己配置命令，插件质量和安全也难控制。

推荐组合是 B 为产品骨架、C 为扩展层、Agent Handoff 为高价值出口。官方维护 12—20 个有明确验收的 recipes，覆盖任务、issue、research evidence、agent handoff、table/JSON/path/citation 等；社区可以创建 recipe，但权限、输入输出 schema、网络域名和 destructive action 必须声明。AI 不是第四条路线，而是 recipe 内的一种可替换处理器。

## 6. 新的功能优先级：从“购物清单/日历/路线”改为六条专业工作流（核心产品规划，不少于 1000 字）

### P0-1 Context Capsule 与 Agent Handoff

这是开发者方向的第一功能。用户圈选终端错误、浏览器报错、代码、issue 或截图，系统收集来源对象及最小邻近上下文，识别当前 IDE/repo/branch，允许勾选要附带的文件、diff、terminal tail 和截图。输出是可审计 capsule，而非拼接 prompt。首批 destination 可做：复制为 Markdown、保存 `.magic-pointer/context/*.md`、发送到当前 Codex task、打开 Claude Code/Cursor/VS Code provider。成功指标是用户不再重复解释“我在哪个项目、哪个文件、刚才运行了什么”。

### P0-2 Capture as Work Item

把“购物清单思想”改成真正的任务路由。对象可以是邮件、论文结论、bug、需求、网页、图或一段聊天。用户说“记成待办/bug/实验任务”，系统建议 title、destination、due、project 和 source link。默认 connector 顺序建议 Microsoft To Do、GitHub Issues、Linear、Todoist、Obsidian Tasks；企业版再做 Jira/Azure DevOps。任务创建后返回真实 ID/URL，undo 删除或关闭本次创建且检查版本。购物清单 provider 仅作为离线 demo，不出现在默认首页。

### P0-3 Research Evidence Capture

围绕 Zotero/Obsidian 构建。支持 quote、figure、table、equation 和 citation 五种对象；保留 PDF attachment/page/bbox/DOI/citekey。动作包括追加到 Zotero child note、追加到 Obsidian literature note、加入 research inbox、创建复现实验任务、导出 BibTeX/LaTeX/CSV。所有模型生成字段单独标记，不污染原文。此功能比通用“总结论文”更适合鼠标，也更难被网页 AI 替代。

### P0-4 Deterministic Developer/Research Micro-tools

第一批完全无模型：JSON/YAML/XML pretty/minify；URL/Base64/Unicode encode/decode；哈希；路径转 WSL/Windows/URI；堆栈提取 file:line；日志去时间戳/去 ANSI；Markdown/HTML/纯文本转换；表格转 CSV/XLSX；BibTeX/DOI/citation 格式；公式 OCR 候选到 LaTeX（OCR 部分可选模型但必须保留图）；截图代码 OCR 后语法保真检查；文件批量重命名预览。每个工具都应该比打开网页转换器更快，并且不花 API 额度。

### P1-1 Multi-object Compare/Collect

复用 THESE：收集多段日志、多张表、多篇论文证据、多份配置，进入短期 Collection Tray。用户可以“比较这些”“合并这些表”“把这些交给 agent”。Table Merge 已有的列模型可保留，但 UI 应是任务级 preview，不是 Dashboard 永久业务页。Compare 的结果必须链接回每个来源。

### P1-2 Mature Ecosystem Calendar/Note Actions

本地日历降级为 sandbox。正式路径优先 Microsoft Graph Calendar；其次 Google Calendar provider；离线/无账号时导出 ICS。创建前显示目标账号和日历，写后保存真实 event ID。笔记优先 Obsidian URI/文件、Notion API、OneNote Graph、Zotero note；不再新建 Magic Pointer 自有笔记系统。新 Outlook 不支持 COM add-in，说明我们不应依赖传统 COM 做长期架构，而应使用 Graph/Web Add-in 或标准 deep link。

明确停止项：独立购物清单 UI、独立地图数据、预约平台、通用长聊天历史、为了“看起来完整”而做的空 Dashboard 菜单、默认云端 OCR 全屏监控。路线 deep link 可作为 recipe；本地日历和购物清单保留测试，不再投入产品化精修。

## 7. Dashboard 应如何重做：不是主页式应用，而是连接、规则、待确认和可追溯活动中心（核心界面方向，不少于 1000 字）

现有 Dashboard 左侧放购物清单、日历、路线，本质是在向用户宣告“Magic Pointer 自己管理你的生活数据”。这与新方向冲突。新 Dashboard 的信息架构应只有五个一级区域：Home/Today、Connections、Recipes、Review Queue、Activity。Home 不展示购物条目，而展示产品是否就绪：当前连接的 agent、默认任务 destination、默认 research destination、今天完成的动作、节省的模型调用和需要处理的失败。Connections 管理 Microsoft、GitHub、Linear、Todoist、Notion、Obsidian、Zotero、IDE/CLI agents 和 model providers；每个连接显示能力、账号、权限范围、最近验证和断开。

Recipes 是核心配置。每条 recipe 用自然语言描述触发与结果，例如“选中错误 + 说记成 bug → GitHub repo 当前仓库”“选中论文证据 + 说记下来 → Zotero child note + Obsidian Research Inbox”“选中任意文本 + 说待办 → Microsoft To Do / Research 列表”。用户可设置快捷短语、目标、确认等级、是否使用模型、隐私和失败回退。技术用户可以查看 schema/脚本；普通用户只看到清晰表单。官方 recipes 有签名和测试版本，社区 recipe 需要权限清单。

Review Queue 只承载需要用户补字段或高风险确认的暂存动作。它不是收件箱，也不是新的任务库。卡片回答四个问题：来源是什么、准备做什么、写到哪里、会使用什么处理器/费用。创建 GitHub issue 可补 repo/labels；创建任务可补 due/project；科研证据可选择 Zotero item/Obsidian note；agent handoff 可勾选上下文文件。提交后卡片离开 Queue，进入 Activity。

Activity 按 operation 而不是聊天消息展示。每条记录有来源、recipe、destination、终态、receipt、open target、undo/retry 和诊断。默认不保存完整敏感正文，只存必要摘要/哈希；用户固定的 capsule 才保存内容。这里复用我们已经实现的 verified action、receipt 和 precise undo。长 agent 任务只显示 provider task 状态和链接，不复制 agent 的全部日志。

日常鼠标交互仍尽量不打开 Dashboard。Rail 只显示一句目标化动作：“→ Microsoft To Do · 复现 Figure 3”“→ Codex · 排查当前错误”“→ Zotero · 添加证据”。低风险且用户设置自动执行的本地动作 Enter 即完成；外部写动作显示一行确认；缺字段才打开 Review Queue。Dashboard 变成可配置、可审计的后台，而不是每次动作结束都弹出的侧边窗口。这会直接修复当前“结果在哪里、怎么关、为什么打开巨大侧栏”的体验问题。

## 8. 模型与额度策略：默认证明“不调用模型也有价值”，再让模型成为可替换加速器（成本方向，不少于 1000 字）

新产品必须建立 `Model-Optional` 原则。如果用户不配置任何 API Key、不登录任何云 AI，仍能使用对象捕获、任务/笔记 connector、确定性转换、文件与路径操作、Table Merge、引用元数据、agent context 打包和操作历史。这样用户不会因为“每点一下鼠标都扣钱”而形成心理阻力，也能在公司敏感环境部署。

每个 recipe 声明四级处理链。Tier 0 使用正则、parser、宿主 API 和本地脚本；Tier 1 使用小型本地分类/抽取模型；Tier 2 调用用户已经订阅的 agent/provider；Tier 3 调用按量云 API。路由器先检查任务是否能由更低 tier 完成。例如日期解析先本地；标题可以直接用原文首句；只有用户要求“改写得更清晰”才用模型。对于云请求，review 展示将发送的对象类型、字符/token 估算、模型和可能费用区间；敏感来源默认禁止云端。

模型 provider 必须可插拔：OpenAI、Anthropic、Gemini、Azure OpenAI、Ollama/Foundry Local 等不应改变 recipe contract。PowerToys 用户提出多 provider 的原因包括已有订阅、供应商锁定、价格和质量差异；PowerToys 后续实际增加多在线和本地 provider，验证了这一方向。Magic Pointer 可以提供 Auto policy：简单分类走本地，短改写走低价模型，复杂任务交已有 agent；但用户始终可锁定 provider 或禁用自动路由。

需要新增成本可观测性：本日/本周模型请求数、估算输入输出 token、按 recipe/provider 分布、缓存命中、被 deterministic route 替代的请求、失败但计费的调用。产品 KPI 不应是“AI 调用次数”，而应包括 `model-free completion ratio`。P0 阶段建议目标：至少 70% 的 Magic Pointer 动作不需要生成式模型；需要模型的动作中至少 80% 使用用户已有 provider；只有清晰高价值任务使用新增按量 API。

本地模型也不能被浪漫化。公开社区讨论显示本地模型受 VRAM、并发、上下文长度、推理速度和维护成本影响。我们不应为了“免费”让用户下载几十 GB。首版本地智能只做小任务：意图分类、敏感信息检测、短字段抽取；复杂代码推理仍交专业 agent。设置页应给出可测的延迟和内存，而不是“Local AI”营销标签。

## 9. 90 天产品路线与验收指标：先证明三个高频闭环，再扩 connector（执行建议，不少于 1000 字）

### 阶段 0：两周方向验证，不继续堆功能

招募 12—18 人：5 名软件工程师/DevOps，4 名科研硕博，3 名高频 vibe coding 独立开发者，另加 2—4 名交叉人群。进行 45 分钟访谈和 7 天 diary study，要求记录“刚才为了完成一个小动作切了哪些窗口、复制了什么、最后写到哪里、是否调用 AI、是否担心费用”。用当前 Magic Pointer 做可点击原型，只验证四种概念：Send to Agent、Create Work Item、Capture Research Evidence、Deterministic Tool。成功不是口头喜欢，而是在真实任务中每人至少重复使用同一 recipe 5 次。

### 阶段 1：四周专业 MVP

重做 Dashboard 信息架构；实现 Connection/Recipe/Activity 最小框架。官方 connector 首批只做三条：Microsoft To Do（个人任务与 linkedResource）、GitHub Issues（开发者工作项）、Obsidian/Zotero（二选一先插件/URI，再补另一条）。Agent handoff 首批支持“复制/保存 Context Capsule”和一个当前环境中最稳定的 agent provider，不同时做四家。确定性工具先交付 10 个最高频转换。购物清单、路线和本地日历从导航移除，迁移到 Labs/Provider Sandbox。

### 阶段 2：四周科研与多对象

完成 PDF Evidence Capsule、Zotero/Obsidian 双链、表格/公式/引用导出；把 THESE Collection Tray 接入 Table Merge 和 Send to Agent。新增 Microsoft Calendar 或 ICS provider，但只在任务访谈证明事件捕获高频后做。建立 provider contract、OAuth/credential storage、capability discovery、receipt 和重试。

### 核心指标

1. `Time to committed action`：从激活到真实目标创建完成的中位时间；任务/证据目标 < 8 秒，确定性工具 < 2 秒。
2. `Context preservation`：创建后的工作项中，来源链接/对象 ID/文件行号/论文页码保留率 > 95%。
3. `Verified success`：API/文件回读验证成功率 > 98%；误报成功接近 0。
4. `Repeat use`：目标用户一周内重复使用同一 recipe 至少 5 次的比例，而不是打开 Dashboard 次数。
5. `Model-free ratio`：整体动作 ≥ 70% 无生成模型。
6. `Destination correction rate`：用户修改默认 destination 的比例；过高说明路由不可信。
7. `Undo/conflict safety`：错误目标写入率、撤销冲突率和数据破坏为零容忍指标。
8. `Interruption cost`：动作期间前景应用焦点丢失率、关闭成本、恢复原任务时间。

## 10. 对当前代码和路线的明确处置

- 保留并继续投资：SelectionSession、InteractionEpisode、THIS/THAT/THESE/HERE、grounding adapters、Inline Rail、typed action schema、permission policy、receipt、写后验证、精确撤销、Table Merge 数据模型。
- 降级到 Labs/测试：ShoppingListStore 与 UI、本地 CalendarStore 与 UI、Route 卡。它们保留回归价值，不再代表默认产品首页。
- 暂停：Reservation、Image Canvas、独立长期 Reader 聊天、继续扩展原生 Dashboard 业务页。
- 新增优先级：Context Capsule、Connector SDK、Recipe schema、Connection/Auth、Microsoft To Do、GitHub Issues、Zotero/Obsidian、Agent Handoff、Deterministic Tool Registry、Cost/Privacy policy。
- 日历改造：本地 CalendarStore 作为测试 provider；产品路径接 Microsoft Graph/Google Calendar/ICS。新 Outlook 不支持 COM add-ins，因此长期不依赖 COM，采用 Graph/Web Add-in/deep link。
- Dashboard 改造：旧导航不删除代码但默认隐藏，迁移为 Labs；新首页围绕 Connections/Recipes/Review/Activity。

## 11. 主要证据与可复核来源

### 开发者痛点与 AI 信任

- [Stack Overflow 2025 Developer Survey：AI 信任与使用](https://survey.stackoverflow.co/2025/ai)
- [Stack Overflow 2025 新闻稿：46% 不信任 AI 准确性](https://stackoverflow.co/company/press/archive/stack-overflow-2025-developer-survey/)
- [VS Code Copilot #827：文件/错误上下文在不同入口丢失](https://github.com/microsoft/vscode-copilot-release/issues/827)
- [VS Code Copilot #7343：agent mode usage limit 不透明](https://github.com/microsoft/vscode-copilot-release/issues/7343)
- [Continue #5291：文件超出上下文长度](https://github.com/continuedev/continue/issues/5291)
- [Continue #7143：声称修改但实际未修改](https://github.com/continuedev/continue/issues/7143)
- [PowerToys #42136：多模型 provider、已有订阅与锁定问题](https://github.com/microsoft/powertoys/issues/42136)
- [PowerToys #32989：Advanced Paste API Key 权限摩擦](https://github.com/microsoft/powertoys/issues/32989)
- [PowerToys #31594：代码/视频 OCR 对符号和结构不可靠](https://github.com/microsoft/powertoys/issues/31594)
- [PowerToys Command Palette Dock #45201：不打断工作流的快速入口需求](https://github.com/microsoft/PowerToys/issues/45201)

### 科研工作流

- [Nature：近 5000 名研究者的 AI 使用调查](https://www.nature.com/articles/d41586-025-00343-5)
- [Zotero Better Notes：annotation、note、Markdown sync 与插件 API](https://github.com/windingwind/zotero-better-notes)
- [Obsidian Zotero Integration Issues：导入、annotation、连接与 silent failure](https://github.com/mgmeyers/obsidian-zotero-integration/issues)
- [Obsidian Zotero Integration 模板文档：重复导入覆盖风险](https://github.com/mgmeyers/obsidian-zotero-integration/blob/main/docs/Templating.md)
- [Zotero Web API 写入与版本冲突控制](https://www.zotero.org/support/dev/web_api/v3/write_requests)

### 可复用生态 API/协议

- [Microsoft Graph To Do API 与 linkedResource](https://learn.microsoft.com/en-us/graph/api/resources/todo-overview?view=graph-rest-1.0)
- [Microsoft Graph linkedResource 创建](https://learn.microsoft.com/en-us/graph/api/todotask-post-linkedresources?view=graph-rest-1.0)
- [Microsoft Graph Calendar 创建 event](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0)
- [GitHub REST API 创建 issue](https://docs.github.com/en/rest/issues/issues?apiVersion=latest)
- [Linear issue 创建与 GraphQL/deep link](https://linear.app/docs/creating-issues)
- [Notion API 创建 page](https://developers.notion.com/reference/post-page)
- [Todoist REST API](https://developer.todoist.com/rest/v1/)
- [Obsidian 官方 URI：创建、打开与 append/prepend](https://obsidian.md/help/Extending%2BObsidian/Obsidian%2BURI)
- [新 Outlook 不支持 COM add-ins，应迁移 Web Add-in](https://learn.microsoft.com/en-us/microsoft-365-apps/outlook/get-started/migrate-com-to-web-addins)
- [Windows Share Target 可接收文本、URI、图片和文件](https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/receive-shared-data)

## 12. 自审与仍待 CEO 决策

本文没有把社媒热帖当统计结论，没有声称已完成目标用户访谈，也没有把 API 存在等同于集成成本很低。本文的强结论是产品层级判断：默认业务数据应进入成熟生态；鼠标服务短动作与上下文路由；长对话/长 agent 任务应主动转交；大多数动作应无模型。仍需 CEO 确认的是第一批主 destination 的商业选择：以 Microsoft To Do + GitHub + Zotero/Obsidian 为默认，还是以 Todoist/Linear/Notion 为默认。这个选择影响 OAuth、用户覆盖和首批访谈对象，但不改变 Context Router 总架构。
