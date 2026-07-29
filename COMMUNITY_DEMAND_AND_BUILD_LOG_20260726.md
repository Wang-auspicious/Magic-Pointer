# Magic Pointer 社区真实需求与实现日志

日期：2026-07-26
状态：进行中
负责人：Codex（本轮单人执行）

## 一、任务目标

重新审视 Fable 当前实现，不以“已经写了多少代码”为价值判断，而以真实用户是否会持续使用、是否明显节省跨应用劳动、是否存在比 Web/CLI 更自然的桌面入口为判断标准。

本轮必须完成：

1. 从开发者、知识工作者和普通用户三个群体收集社区原始反馈。
2. 覆盖 Reddit、Hacker News、GitHub Issues/Discussions、产品社区与论坛、官方演示及评论、应用商店/扩展商店评价等不同渠道。
3. 形成至少 50 条额外真实需求。每条记录用户问题、证据链接、适用人群、发生频率、现有替代方案、Pointer 形态的优势、风险、优先级和验收方式。
4. 合并同义需求，不用“换一种说法”凑数；没有证据的想法只能进入假设池，不能称为真实需求。
5. 从中选出能够形成不可替代价值的核心能力簇，再设计实现顺序。
6. 后续实现必须接入统一对象会话、权限、隐私、Agent 回执和 PointerStage，不再制造孤立演示功能。

## 二、产品价值判断标准

候选需求只有同时满足以下条件，才进入实现候选：

- 用户在多个应用之间来回复制、定位、解释或执行，当前摩擦真实存在。
- 指针指向、圈选、语音补充能够减少上下文描述，而不是只替用户写一句 Prompt。
- 结果可以继续进入现有 Agent、文档、表格、浏览器或系统动作，形成闭环。
- 桌面形态相对单独打开 Web 页面或 CLI 至少减少一个明显步骤。
- 能以可观察回执验证成功；排队、草稿、已写入、已发送必须严格区分。
- 默认隐私安全，高风险动作必须确认，截图关闭时不得外发视觉文件或路径。

## 三、证据来源索引

`证据等级`：A=用户直接陈述实际工作流；B=社区讨论/Issue 中有复现或多人响应；C=已发布产品能力与平台方向；H=只有假设，本轮不计入 50+ 真实需求。

| 来源 | 渠道 | 直接信号 |
|---|---|---|
| S01 | [Reddit / ClaudeCode：截图指令工作流](https://www.reddit.com/r/ClaudeCode/comments/1twmmon/how_are_you_giving_instructions_with_screenshots/) | 截图、标箭头、再写一段上下文很慢；浏览器外的原生应用仍没有好办法 | A |
| S02 | [Claude Code #12644](https://github.com/anthropics/claude-code/issues/12644) | Windows 截图仍要先保存文件再拖入 Agent | B |
| S03 | [Codex #21668](https://github.com/openai/codex/issues/21668) | 多 Space 下抓错窗口，浪费 token 且可能泄露其他应用内容 | B |
| S04 | [Codex #24433](https://github.com/openai/codex/issues/24433) | 后台建议未获明确授权便读取 Gmail，缺少可见任务与审计 | B |
| S05 | [Codex #24287](https://github.com/openai/codex/issues/24287) | Thinking 卡死、Stop 失效、任务重启后不可见 | B |
| S06 | [Codex #18522](https://github.com/openai/codex/issues/18522) | 重启后旧会话的 Computer Use 授权失效，新会话却正常 | B |
| S07 | [Claude Code #11380](https://github.com/anthropics/claude-code/issues/11380) | 已授权动作仍反复询问，权限范围不能可靠记忆 | B |
| S08 | [Harnss](https://github.com/OpenSource03/harnss) | 用户需要多 Agent 会话、图片批注、语音、后台任务和系统通知合一 | C |
| S09 | [PowerToys #34008](https://github.com/microsoft/PowerToys/issues/34008) | 用户明确要求 Ollama/本地模型，而不是被锁定到单一云 API | B |
| S10 | [Reddit / MCP context tax](https://www.reddit.com/r/mcp/comments/1t73igk/how_to_connect_100_mcp_servers_without_the/) | 工具定义吞掉上下文；需要按意图发现而非全量暴露 | A |
| S11 | [GitHub MCP #1683](https://github.com/github/github-mcp-server/issues/1683) | MCP 不理解当前仓库，导致 Agent 分心且不精确 | B |
| S12 | [MCP SEP-1391](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1391) | 长任务需要标准状态、查询与恢复，不能靠一次同步调用 | B |
| S13 | [GitHub Copilot Tool Search](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/tool-search) | 官方确认工具定义浪费上下文且降低选择准确率 | C |
| S14 | [WhisperPress](https://github.com/ggml-org/whisper.cpp/discussions/3876) | 常驻模型降低延迟；中文标点与解码策略直接影响可用性 | B |
| S15 | [Reddit / Echo 本地听写](https://www.reddit.com/r/csharp/comments/1te5bxn/i_built_a_completely_offline_pushtotalk_dictation/) | 技术术语、VAD、防静音幻觉、全局输入且不抢焦点是真实需求 | A |
| S16 | [TypeWhisper](https://github.com/TypeWhisper) | 用户需要按应用切换语言、引擎和后处理策略 | C |
| S17 | [Reddit / 低延迟听写反馈](https://www.reddit.com/r/learnmachinelearning/comments/1ulnxon/what_stack_are_people_using_for_lowlatency_ai/) | 端点检测、纠错 UX、避免擅自改写比单纯模型速度更关键 | A |
| S18 | [V2EX / sayany](https://www.v2ex.com/t/1206174) | 中文用户明确要求语音与剪贴板数据不上传、在线/离线可选 | A |
| S19 | [Reddit / VIBE WHISPER](https://www.reddit.com/r/VibeCodersNest/comments/1r24hd7/i_built_a_local_ai_voice_typing_tool_for_vibe/) | 在 Claude、Gemini、邮件、Slack、Notion 间切换和重复输入破坏心流 | A |
| S20 | [Reddit / SnapRewrite](https://www.reddit.com/r/MacOSApps/comments/1uf9s9a/i_got_tired_of_copypasting_into_chatgpt_so_i/) | 选中文字后直接处理、模板化、BYOK，避免打开独立 AI 窗口 | A |
| S21 | [Reddit / SwiftPen](https://www.reddit.com/r/SideProject/comments/1sfhq2d/fix_text_anywhere_on_macos_without_leaving_the/) | 用户需要 diff、预览、历史、追问、撤回及完全离线模式 | A |
| S22 | [Reddit / Table capture](https://www.reddit.com/r/macapps/comments/1uxgnlz/app_request_table_capture/) | 普通 OCR 会压平表格；用户需要保留网格并在写入前校对 | A |
| S23 | [Reddit / PDF to Markdown](https://www.reddit.com/r/ObsidianMD/comments/1rh1mti/i_finally_built_a_pdftomarkdown_tool_that_doesnt/) | 学术 PDF 的公式、表格、双栏和脚注在复制时损坏 | A |
| S24 | [Reddit / PDF 公式转 LaTeX](https://www.reddit.com/r/LaTeX/comments/1uxvfds/is_there_anyway_to_copy_latex_with_ctrlc_from_a/) | 用户希望框一下公式便得到可编辑 LaTeX，而不是截屏搬运 | A |
| S25 | [Reddit / LaTeXSnipper](https://www.reddit.com/r/LaTeX/comments/1uu1yz7/latexsnipper_opensource_crossplatform_latex/) | 现有工具常需联网、收费、无快捷桌面入口且 Office 集成差 | A |
| S26 | [Reddit / 截图转 Excel](https://www.reddit.com/r/SideProject/comments/n55bdl/i_built_a_screenshot_to_excel_converter/) | 财务用户只想取报告中的一张表，且不愿上传整份敏感 PDF | A |
| S27 | [Reddit / ChatGPT 回复搬运](https://www.reddit.com/r/automation/comments/1st8qay/the_copypastetochatgpt_workflow_for_writing/) | 消息→ChatGPT→草稿→原应用的往返仍比直接回复更慢 | A |
| S28 | [Reddit / 小企业跨应用搬运](https://www.reddit.com/r/smallbusiness/comments/1uipyf2/what_business_task_do_you_still_copypaste_between/) | CRM、发票、排班、表格和通知之间重复录入，人工保留是因为怕静默错误 | A |
| S29 | [Reddit / 自动化仍需大量手工](https://www.reddit.com/r/smallbusiness/comments/1ry01nd/is_it_just_me_or_is_automated_software_still/) | 用户不信任脆弱连接，维护 Zapier 拼接本身成为负担 | A |
| S30 | [Reddit / Jira 与 Slack](https://www.reddit.com/r/dataengineering/comments/1npgsfy/what_data_do_you_copypaste_between_systems_every/) | 工单号、状态和链接每周重复搬运，用户自称“human API” | A |
| S31 | [Reddit / 销售 AI 工作流](https://www.reddit.com/r/sales/comments/1r6j849/how_are_you_actually_using_ai_to_make_your_work/) | 会后痛点、下一步、预测金额仍需复制到多个销售系统 | A |
| S32 | [Microsoft Click to Do](https://blogs.windows.com/windowsexperience/2025/05/06/introducing-a-new-generation-of-windows-experiences/) | 屏幕文字/图像动作、Excel 表格、Word 草稿、Teams 日程与消息是平台确认方向 | C |
| S33 | [Microsoft Community / Click to Do 故障](https://answers.microsoft.com/en-us/insider/forum/all/click-to-do-is-not-working-on-my-copilot-pc/e8fce8b5-bafe-4c82-9ea3-98ebbbaf445a) | 即使 Copilot+ PC 也出现无法启动、无法选中对象和版本漂移 | A |
| S34 | [Reddit / Click to Do 破坏旧 Win32 应用](https://www.reddit.com/r/sysadmin/comments/1kile4b) | 系统叠层不得阻止旧应用移动/缩放，企业会直接用 GPO 禁用 | A |
| S35 | [Windows App Actions](https://learn.microsoft.com/en-us/windows/ai/app-actions/actions-get-started) | Windows 已提供可发现、强类型、跨体验调用的原子动作框架 | C |
| S36 | [Windows Agent Launchers](https://learn.microsoft.com/en-us/windows/ai/agent-launchers/) | 平台正在标准化 Agent 注册、发现、Prompt 与附件传递 | C |
| S37 | [Screenpipe changelog](https://screenpipe.com/changelog) | 长期屏幕上下文产品持续修复 CPU、OCR、窗口过滤、留存和隐私问题 | C |
| S38 | [Screenpipe #5281](https://github.com/screenpipe/screenpipe/issues/5281) | 建议应复用一个轻量活动浮层，不应再造通知卡片 | B |
| S39 | [Open Interpreter approvals](https://www.openinterpreter.com/docs/desktop/approvals) | 高风险动作应展示精确变化并快速确认；读操作不应每步打断 | C |
| S40 | [Reddit / macOS 抢焦点](https://www.reddit.com/r/MacOS/comments/1t7b2im/give_us_a_systemlevel_option_to_prevent_apps_from/) | 抢焦点会误触 Enter、打断全屏应用并造成真实操作风险 | A |
| S41 | [Reddit / RSI 复制粘贴](https://www.reddit.com/r/RSI/comments/1sa6q71/copypaste_and_general_browsing_suggestions/) | 跨应用选择与复制对手部疼痛用户尤其困难，焦点错误会加重负担 | A |
| S42 | [Reddit / 就地翻译](https://www.reddit.com/r/chrome_extensions/comments/1u120is/i_got_tired_of_copying_text_into_google_translate/) | 用户希望翻译紧贴原文显示，而不是往返翻译网站 | A |
| S43 | [Reddit / 选中文字朗读](https://www.reddit.com/r/macapps/comments/1jfsz65/looking_for_a_mac_app_to_read_selected_text_with/) | 普通用户需要系统范围自然语音朗读和语言选择 | A |
| S44 | [V2EX / 桌面 Agent](https://www.v2ex.com/t/1209021) | 中文用户重视跨软件搬运、手机远程触发、项目记忆和全平台 | A |

## 四、64 条额外真实需求

以下需求不按“又多一个按钮”计数，而按可独立验收的用户结果计数。它们是对现有 30 个粗粒度 Recipe 的补充：`缺失` 表示代码没有该闭环，`部分` 表示已有底座但不满足来源中的完整结果。

### A. 指针现场与多模态交付

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N01 | 指一下界面并说话，自动生成“截图区域＋箭头＋转写＋来源应用”的 Agent 指令包，无需先保存截图 | 前端/测试/设计 | S01、S02 | 指针本身就是歧义消除器 | 部分 | 从原生应用指向控件，现有 Agent 会话收到可定位对象包 |
| N02 | 一次标记多个区域并给出 A/B/C 标签，Agent 理解“把 A 的样式应用到 B，C 保持不变” | 开发/设计 | S01、S08 | 鼠标空间关系比长句描述更快 | 部分 | 三对象跨窗口绑定不串位，Prompt 保留标签和 bbox |
| N03 | 截图前本地验证目标应用、窗口标题和 Space，不一致则拒绝外发 | 所有人 | S03 | 唤醒时已有明确指针目标 | Windows 核心合同已实现 | 抓错窗口时零上传并给出 target-mismatch |
| N04 | 长任务期间持有“目标窗口租约”，窗口切换或重启后不悄悄漂移 | Agent 用户 | S03、S06 | Pointer 可把任务绑定到冻结对象而非当前焦点 | 部分：执行前租约已实现 | 切换桌面后动作暂停，重新确认目标才恢复 |
| N05 | 每个应用单独配置“只读 UIA / 允许 OCR / 允许截图 / 永不捕获” | 企业/隐私用户 | S03、S04、S37 | Dashboard 可作为统一隐私控制面 | 核心出站路径已实现 | 敏感应用策略覆盖所有出站路径 |
| N06 | 给无多模态模型生成结构化视觉描述：OCR、层级、颜色、相对位置、控件类型和局部图像摘要 | 本地小模型用户 | S01、S02 | 点中对象后只需描述局部而非全屏 | 部分 | 文本模型能引用具体元素并输出可复现指令 |
| N07 | UIA/AX/DOM 优先，Canvas、视频、微信等不可访问界面才使用局部截图兜底 | 跨应用用户 | S03、S34、S37 | 同一指针入口可隐藏底层感知差异 | 部分 | 日志显示所用感知层，截图兜底需受隐私策略约束 |
| N08 | 把当前对象送进用户已经打开的 Agent 会话，而不是另起一个 Magic Pointer 聊天 | 开发者/知识工作 | S08、S19 | Pointer 只负责现场，不与 Agent 争夺工作台 | 部分 | Codex/Pi/Claude/Gemini 至少两种会话可追加对象并返回 task id |

### B. 开发与多 Agent 工作流

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N09 | 指向运行中的 UI 时自动附带仓库、cwd、branch、最近 diff 与启动命令 | 开发者 | S01、S11 | 用户不应手工猜是哪三个文件 | 部分 | Agent 收到真实仓库元数据，不根据截图编造路径 |
| N10 | 指向终端错误后提取相关错误窗口、退出码和前后日志，而不是整屏 OCR | 开发/运维 | S01、S19 | 指针确定日志锚点，可定向取上下文 | 部分 | 只采集相关日志片段且保留命令/时间 |
| N11 | 浏览器问题同时交付 DOM 节点、CSS selector、可访问名称、网络失败和截图坐标 | 前端/测试 | S01 | 用户指的是像素，Agent 需要可执行引用 | 缺失 | Playwright/DevTools 能直接复现被指控件 |
| N12 | 指向设计稿或截图中的组件，自动关联到当前页面的候选 DOM/组件文件，而非让用户报文件名 | 前端/设计 | S01、S08 | 视觉对象与代码对象可由系统反向匹配 | 缺失 | 输出候选组件及置信度，低置信度不自动修改 |
| N13 | 从 CLI 继续到 GUI、从 GUI 继续到 CLI，保留同一个任务和审批状态 | 多 Agent 开发者 | S05、S08 | Pointer 作为中立会话入口 | 缺失 | 同一 task id 可被两种前端恢复，无重复执行 |
| N14 | 在 Codex、Pi、Claude、Gemini 间切换执行者而不重复描述现场 | 多模型用户 | S08、S11 | 结构化对象包不依赖模型 Prompt 格式 | 部分 | 同一 Context Pack 可被两种 Agent 接收且字段一致 |
| N15 | Agent 产出的文件、补丁和页面能反向绑定到最初指向的屏幕对象 | 开发/设计 | S08 | 形成屏幕对象到交付物的可追溯链 | 本地来源链已实现 | Activity 可从对象跳到 diff/artifact/task |
| N16 | 从反复出现的真实调试流程生成候选 Skill，但必须让人审核后才安装 | 高级开发者 | S08、S11 | Pointer 能记录动作语义而非全量录像 | 缺失 | 三次相似流程后生成可读 Skill 草稿，默认不启用 |

### C. 语音、低干扰与无障碍

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N17 | 语音唤醒、转写和结果都不抢走原应用焦点 | 所有人/RSI | S15、S40、S41 | 浮层可以 showInactive 并围绕指针反馈 | 部分 | 语音全程前台 hwnd 不变 |
| N18 | 按既定鼠标晃动直接开始，不要求记住全局快捷键 | 普通用户 | S19、S41 | 肌肉动作比组合键更易发现 | 已有底座 | 真机连续 100 次统计误触/漏触 |
| N19 | 嘈杂环境可选按住说话或鼠标驻留开始，松开立即提交 | 办公/会议 | S14、S15 | 不在气泡增加模式按钮，策略在 Dashboard 预设 | 缺失 | 两种触发可配置，语音气泡仍保持单一形态 |
| N20 | 常驻语音模型避免每次冷启动，同时能设置显存/内存上限 | 高频语音用户 | S14 | 系统级入口需要亚秒反馈 | 缺失 | 短句 P50 首字延迟目标 <800ms，空闲资源可回收 |
| N21 | VAD 丢弃空音频，防止 Whisper 在静音时生成“谢谢观看”等幻觉 | 所有人 | S15 | 错误命令可能触发真实动作，必须入口拦截 | VAD＋no-speech 门已实现 | 静音/背景噪声测试零提交 |
| N22 | 中文标点、简繁转换和中英混说可按用户固定偏好输出 | 中文用户 | S14、S18 | Dashboard 可保存语言风格 | 缺失 | 中文基准集标点与简繁输出可重复 |
| N23 | 每个项目维护术语词典，如类名、客户名、药品名和公式符号 | 开发/专业人员 | S14、S16 | 当前对象已知道项目和应用 | 本地作用域词典已实现 | 术语召回率基准提升且词典可导入导出 |
| N24 | 语音 final 后可用同一胶囊快速纠正、重说、取消，不能擅自润色原意 | 所有人 | S17 | 反馈就在指针处，不需打开历史窗口 | 部分 | final 未提交前可撤销；“逐字/清理/Prompt”三种策略可配置 |

### D. 跨应用写作、沟通与阅读

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N25 | 在任意应用选中文字后直接运行自定义动作，不打开聊天或命令面板 | 所有文字工作者 | S20、S21 | 选区已经携带输入与写回位置 | 部分 | Mail/Slack/Word/浏览器至少四类应用可用 |
| N26 | 写回前显示词级 diff，写回后提供精确撤回 | 编辑/办公 | S21、S39 | 风险确认可以紧贴原选区 | 部分 | 原文哈希变化时拒绝覆盖，撤回只影响本次修改 |
| N27 | 保存“技术说明、学术润色、客户回复、简洁化”等个人模板 | 知识工作者 | S20、S21 | 模板与当前对象组合，免重复 Prompt | 缺失 | 模板可配置变量、风险和默认 Agent |
| N28 | 对生成结果继续说“再短一点/保留数字/更直接”，不丢失原选区 | 文字工作者 | S21 | 同一对象会话天然支持多轮细化 | 缺失 | 追问链保留 original/current/proposed 三版本 |
| N29 | 根据发件人、线程和关系生成邮件草稿，但绝不自动发送 | 销售/管理/普通用户 | S27、S31 | 指向消息即可局部读取线程 | 部分 | 草稿写入正确回复框，发送必须单独确认 |
| N30 | 把 Slack/Teams 消息直接变成任务、日历草稿或工单并回链原消息 | 团队用户 | S27、S30、S32 | 指针可选择具体消息，避免复制链接 | 缺失 | 创建草稿含来源链接、负责人、截止时间 |
| N31 | 翻译结果贴着原文显示，并可一键替换或双语保留 | 跨语言用户 | S42 | 不离开阅读位置 | 部分 | 浏览器、PDF、桌面应用三类来源保持段落结构 |
| N32 | 选中文字后用自然语音朗读，可按语言/速度/声音预设 | 学习/视障/普通用户 | S32、S43 | 指针直接定义朗读范围 | 缺失 | 朗读不上传原文，支持暂停和继续 |

### E. 文档、表格、公式与图像

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N33 | 截图/PDF 表格转真实单元格，并在写入 Excel 前逐个标出低置信度单元格 | 财务/研究/办公 | S22、S26、S32 | 用户只框目标表，不上传整份文件 | 部分 | 合并单元格、跨行表头和数字格式通过校对门 |
| N34 | 如果源是 Word/Excel/网页真实表格，优先提取结构而非 OCR | 办公用户 | S22 | 指针统一入口可选择最佳适配器 | 部分 | 输出保留行列、类型、公式和合并关系 |
| N35 | 表格可直接生成给 Agent 的带坐标 JSON/CSV，而不是扁平文本 | 数据/Agent 用户 | S22 | Pointer 可同时保留视觉位置与结构 | 部分 | 每个单元格包含 row/col/source bbox/confidence |
| N36 | 框选 PDF/网页公式后输出 LaTeX、MathML 与 Word 可编辑公式三种目标 | 学生/研究 | S24、S25 | 选择公式比上传整页更自然 | 接口 | 本地基准正确率、预览和目标格式写回均可验证 |
| N37 | 把已有 LaTeX/Markdown 公式直接写入 Word/PowerPoint 原生公式对象 | 学术/教师 | S23、S25 | 免去网页转换和多次复制 | 缺失 | 结果不是位图，Office 中可继续编辑 |
| N38 | 将学术 PDF 的局部或页面转 Markdown，保留双栏顺序、脚注、表格和公式 | 研究/学生 | S23 | 用户可指向真正需要的部分 | 缺失 | 对照渲染检查结构，无脚注串页 |
| N39 | 只提取敏感文档中的选定区域并本地处理，禁止上传整份 PDF | 财务/法律/医疗 | S03、S26 | 局部指针权限天然最小化数据 | 部分 | 出站审计证明仅包含所选结构，零原文件路径 |
| N40 | 图片/界面元素生成可编辑的“视觉提示包”：主体、材质、构图、颜色、负面约束和局部引用 | 设计/内容创作者 | S01、S08 | 点哪个就分析哪个，可供无视觉模型间接使用 | 接口 | 输出既可复制 Prompt，也可直接送入配置 Agent |

### F. 真实业务跨应用闭环

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N41 | 指向表单新线索，把字段写入 CRM、分配负责人并生成跟进草稿 | 小企业/销售 | S28、S29 | 不需先搭完整 Zap，边工作边确认 | 缺失 | 三处写入均有独立回执，任一步失败不静默继续 |
| N42 | 将报价单变为发票草稿、日历任务和施工/交付通知，数字只录一次 | 服务企业 | S28 | 指向现有报价即可建立对象链 | 缺失 | 金额、客户和日期回读一致，发送仍需确认 |
| N43 | 从预订/咨询消息创建 CRM 记录、日程和团队消息 | 客服/运营 | S28、S32 | 当前消息提供客户与时间上下文 | 缺失 | 创建前统一预览，避免重复客户和重复日程 |
| N44 | 从多个 Dashboard 指定数字生成周报表格和幻灯片草稿 | 运营/管理 | S29、S31 | 用户用 THESE 明确选择指标 | 部分 | 每个数字保留来源、日期和链接，不生成无出处指标 |
| N45 | Jira/Linear 工单状态与 Slack/Teams 周报互相同步并附原链接 | 开发团队 | S30 | 指针选择工单或消息，无需复制编号 | 缺失 | 同步有幂等键，重复执行不产生重复消息 |
| N46 | 会后从笔记中提取痛点、承诺、下一步和日期，更新 CRM 并生成跟进邮件草稿 | 销售/咨询 | S31 | 用户可指向本次会议记录 | 缺失 | 每条字段可追溯到原文，邮件不自动发送 |
| N47 | 指向发票/收据，提取字段、匹配项目并进入待审核归档队列 | 财务/普通用户 | S28、S29 | 只处理当前票据而非搭建复杂 RPA | 缺失 | 税额/总额校验，低置信度阻止入账 |
| N48 | 指向消息中的承诺或截止日期，创建提醒并在原消息处留下回链 | 所有人 | S27、S28、S32 | Pointer 直接把自然语言锚定为任务来源 | 部分 | 时区与相对日期必须人工确认后写入 |

### G. Agent 控制、安全与可信回执

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N49 | `accepted / queued / running / needs_confirmation / succeeded / failed` 全链路真实展示 | 所有 Agent 用户 | S05、S08、S12 | 同一胶囊可显示任务真实状态 | 部分 | 未 verify 永不显示完成，状态来自 provider 回执 |
| N50 | Stop 必须真正终止后台进程，并显示“已请求/已终止/无法终止”区别 | Agent 用户 | S05、S12 | 用户在指针处即可接管 | 部分 | 进程与 TaskStore 双重验证，停止失败不得隐藏 |
| N51 | 应用重启后能恢复任务、审批与结果，不能把运行中任务变成不可见 | 长任务用户 | S05、S06、S12 | PointerStage 只是视图，状态应在持久任务层 | 部分 | 强制重启测试后状态和 task id 不丢失 |
| N52 | 每个任务都有可见审计：谁触发、看了什么、调用什么、写到哪里、如何验证 | 企业/隐私用户 | S04、S05 | 指针对象提供最小且明确的审计起点 | 关联与脱敏核心已实现 | Dashboard 可展开时间线且敏感正文默认脱敏 |
| N53 | 审批界面显示精确目标和 diff，而不是笼统“允许 Agent 操作电脑” | 所有人 | S07、S39 | 用户能看到指针锁定对象与拟修改字段 | 部分 | 不同风险动作呈现字段级变化与撤销能力 |
| N54 | 权限记忆必须有作用域：本次、此 Recipe、此应用、此项目；不能全局放大 | 高级/企业用户 | S04、S07、S39 | Dashboard 可管理作用域并随对象匹配 | Recipe/应用/项目/到期已实现 | 授权不跨越配置作用域，随时可撤销 |
| N55 | 动作前重新校验窗口、对象哈希和 capture id，抵御焦点切换与陈旧截图 | 所有人 | S03、S34 | 冻结对象可提供乐观锁 | 部分 | TOCTOU 测试中目标变化则拒绝动作 |
| N56 | 所有写动作具备幂等键、读回验证和可用时的精确 Undo | 办公/业务用户 | S28、S29、S39 | 跨应用自动化只有可恢复才值得信任 | 部分 | 重试不重复写；verify 失败清楚说明；Undo 有目标范围 |

### H. 平台、中立 Agent 与跨系统能力

| ID | 真实需求 | 主要人群 | 证据 | Pointer 为什么更合适 | 现有覆盖 | 验收 |
|---|---|---|---|---|---|---|
| N57 | 不把几十个 MCP 工具常驻上下文；按当前对象和意图动态加载 3–8 个能力 | Agent 开发者 | S10、S13 | Pointer 已提供高质量路由信号 | 有界能力搜索已实现 | 工具定义 token 预算可测，正确率不低于全量模式 |
| N58 | GitHub/Linear 等连接默认绑定当前仓库/项目，需要跨项目时再明确扩展 | 开发者 | S11 | 当前窗口和 cwd 可自动给出作用域 | 缺失 | 默认查询不会访问其他仓库 |
| N59 | 大型工具输出写入本地 artifact，仅把摘要和路径送进 Agent 上下文 | Agent 用户 | S10、S12、S13 | Pointer 可把 artifact 继续绑定到对象会话 | 本地索引与可恢复留存已实现 | 大输出不直接污染上下文，文件有留存/清理策略 |
| N60 | Agent 接入优先原生 Hook、Session、CLI JSON/ACP；MCP 只作兼容网关 | 多 Agent 用户 | S08、S10、S11 | Pointer 是 Agent 中立入口 | 部分 | 每个适配器声明能力、状态、steer、cancel 和附件合同 |
| N61 | 用户可按应用/项目选择本地模型、云模型或现有 Agent，并看到成本与隐私差异 | 所有人 | S09、S18、S20 | Dashboard 预设，气泡不出现模型菜单 | 部分 | 运行前可预测数据边界，失败能自动降级但不偷偷换云 |
| N62 | 在 Windows 注册并消费 App Actions，让其他应用也能调用 Pointer Recipe | Windows 用户/开发者 | S32、S35、S36 | 与系统原子动作方向一致且不依赖 Copilot UI | 缺失 | 至少一个 provider 和 consumer 在非 Copilot+ x64 机器运行 |
| N63 | macOS 使用 AX、Shortcuts/App Intents 与原生 Agent CLI，共享同一 Recipe/权限/回执合同 | Mac 开发者/知识工作 | S20、S21、S40 | Mac 开发者不应被锁定在 Windows 功能 | 接口 | Mac 实机通过多屏、权限、签名、公证和写回验证 |
| N64 | 支持普通 x64 Windows、旧 Win32 应用和非 NPU 机器；叠层不得破坏移动、缩放或输入 | 普通/企业 Windows 用户 | S33、S34 | Magic Pointer 的机会正是跨硬件覆盖 | 部分 | Win10/Win11 兼容矩阵和旧 GDI 应用回归通过 |

## 五、当前代码审视

| 层 | Fable 当前结果 | 局外人判断 | 下一步 |
|---|---|---|---|
| PointerStage | 已成为 targeting→freeze→语音/文字→processing→结果/错误的唯一瞬时热路径；旧 Result/Reader 已删除 | 解决了“界面乱”，但只证明交互容器成立 | 不能再向气泡加功能菜单；所有新能力走统一事件合同 |
| 对象捕获 | Windows UIA、OCR、截图兜底、THIS/THAT/THESE/HERE 已有 | 能指到对象，但缺目标窗口租约、跨 Space 验证和细粒度应用策略 | 先实现 N03–N07、N55 |
| 30 Recipe | 规划、风险、签名、回执和部分确定性 provider 已有 | 数量看起来完整，真实外部闭环不足；“转 Agent”不能算原生能力 | 按能力簇补 provider，不再增加空壳 Recipe |
| Agent | Pi/Claude/Gemini hooks，Codex/Pi session 参数，多个 CLI 连接器 | 最大机会是成为现有 Agent 的“指针现场端口”，而不是自建 Agent UI | 优先实现 N08–N16、N57–N61 |
| 语音 | Whisper 本地 partial/final 和静音提交已有 | 能转写不等于适合长期使用；冷启动、术语、标点、纠错仍不足 | 实现 N17–N24 的可测语音运行时 |
| 写回 | Word/UIA 草稿、日历草稿、购物清单和部分 artifact 已有 | 有安全底座，但跨应用写回覆盖小 | 先做模板/diff/线程草稿/消息转任务 |
| 可信控制 | action token、确认、verify、undo、accepted/succeeded 区分已有 | 方向正确，但任务恢复、可靠停止、权限作用域和目标租约仍是硬缺口 | 实现 N49–N56 |
| 平台 | Windows 有实测；macOS 仅宿主源码 | 尚不是跨平台产品，也不是普通用户可安装成品 | macOS、旧 Windows、安装签名必须独立验收 |

## 六、不可替代价值与实施架构

64 条需求不能做成 64 个孤立按钮。按需求密度归并为五个能力簇：

1. **Point-to-Agent Object Bridge（第一楔子）**：N01–N16。用户指一下、说一句，已有 Agent 获得目标对象、来源、结构、仓库和安全边界。这是相对 Web/CLI 最难替代的部分。
2. **Trustworthy Cross-App Commit Layer**：N25–N32、N41–N56。不是生成答案，而是把草稿安全写回真实应用，并通过 diff、确认、读回、撤回和审计形成闭环。
3. **Local Voice Intent Runtime**：N17–N24。语音只负责表达意图，常驻、低延迟、不抢焦点、可纠错，并按项目理解术语。
4. **Structure Recovery Engine**：N33–N40。把用户指向的像素恢复为表格、公式、文档结构和视觉提示包，既能写入 Office，也能喂给无多模态 Agent。
5. **Capability Gateway and OS Adapters**：N57–N64。Hook/Session/CLI 优先、工具按需发现、Windows App Actions 与 macOS 原生接口并行，避免 MCP 上下文税。

架构数据流固定为：

`Wiggle → Freeze Target → Target Lease → Minimal Context Packet → Intent Router → Capability Search → Plan → Confirm → Execute → Read-back Verify → Undo/Audit`

每个能力簇必须回答：

1. 用户为什么不用现有系统快捷键、聊天框、浏览器扩展或 Agent CLI？
2. Magic Pointer 少了哪一步、保留了什么真实上下文？
3. 能否跨应用复用，而不是只支持一个受控 Demo？
4. 没有多模态能力的模型能否通过结构化对象包间接获得视觉上下文？
5. 完成状态怎样被回读验证？

## 七、实现纪律

- 先完成社区证据矩阵和需求去重，再冻结产品设计。
- 遵循“单一 PointerStage、晃动唤醒、Dashboard 预设、语音流零 chips”的现有裁决。
- 优先打通能力簇，不按 50 个孤立按钮逐个堆功能。
- 所有功能通过统一 Recipe/Action Contract 注册，Agent 接入优先 Hook/本地 Session/CLI JSON，MCP 只作兼容层。
- 不伪造外部应用进度，不把 Agent `accepted` 写成完成。
- 每次实现后补自动测试、真实桌面验证和证据记录。

## 八、实时进度

- [x] 建立本轮任务、证据标准和实现日志。
- [x] 盘点当前代码与 Fable 已完成功能，建立“已有/半成品/无效/缺失”矩阵。
- [x] 完成第一轮多渠道社区调研及 44 个原始来源归档。
- [x] 写入并去重 64 条额外真实需求。
- [x] 形成价值密度排序和五个能力簇架构。
- [x] 完成设计审查与实现计划。
- [x] 完成第一波共享底座：Target Lease、Capture Policy、Context Packet v2、Capability Search、可信任务恢复。
- [x] 完成作用域授权、审计关联、本地语音防幻觉/术语配置、产物来源链与可恢复留存。
- [x] 完成 Node/Python 全量回归、Fabric 冒烟、Windows 目标租约和 Electron Dashboard 启动/视觉检查。
- [ ] 分批实现其余外部 provider 与平台适配。
- [ ] 在真实麦克风与多台 Windows/macOS 机器上完成晃动→语音→写回的硬件兼容矩阵。

## 九、阶段记录

### 2026-07-26 / 启动

已先固化任务边界。下一步先读取当前项目实现和最近提交，再开始多渠道取证；本文件将持续追加来源、需求、决策、代码状态和验证结果。

### 2026-07-26 / 第一轮调研完成

- 已核对 Fable 最新提交 `c44ae71` 与 `6afaab2`：PointerStage 已端到端接线，Result/Reader 已退役。
- 已从 Reddit、Hacker News、GitHub Issues/Discussions、V2EX、Microsoft Community、官方 Windows 文档和开源产品反馈中归档 44 个来源。
- 已去重得到 64 条额外需求；核心信号集中在“把现场交给现有 Agent”“不抢焦点的本地语音”“结构保持”“可信写回”和“真实任务控制”，而不是更多聊天 UI。
- 下一步先验证当前测试基线，再把五个能力簇拆成可以连续交付的实现波次。

### 2026-07-26 / Fable 基线复核

- `npm test` 通过：25 组 Node/渲染层静态与行为测试全部成功。
- `python -m pytest -q --basetemp .pytest-tmp-community-baseline` 通过：`294 passed in 34.66s`。
- 该结果只证明 Fable 当前契约没有回归，不把尚未接入真实外部系统的 Recipe 算作“已经实现”。
- 下一阶段按 TDD 先实现可被多条需求复用的底层能力：Target Lease 与 Capture Policy、Context Packet v2、Capability Search/Gateway、可信任务运行时；不新增 64 个按钮或气泡菜单。

### 2026-07-26 / 社区需求第一波底座实现

- 新增 `Target Lease`：对象/截图指纹、10 分钟租约、窗口 `HWND + PID` 存活校验、过期与陈旧窗口拒绝。覆盖 N03、N04、N55 的共享基础。
- 新增每应用 `Capture Policy`：`follow_global / structured_only / local_ocr / local_screenshot / upload_screenshot / deny`；敏感应用即使全局允许上传也强制结构化。覆盖 N05、N07、N61 的数据边界。
- 新增 `Context Packet v2`：把指向对象、repo/cwd/branch/dirty files、终端摘录、来源结构、目标租约和隐私决策写入本地 artifact；被禁止的截图路径不会进入 Agent prompt。覆盖 N01、N06、N09–N11、N14、N58–N59。
- 新增有界 `Capability Search`：按当前命令、对象、平台和 provider 状态只返回 3–8 项能力；Bridge/MCP 都复用该结果，不再要求模型读取完整 Recipe 目录。覆盖 N57、N60。
- Agent handoff 已改用 Packet v2，支持显式已有 `sessionId`，仍保持 `submit=false`；真正匹配目标窗口后才启动 Agent。
- 后台任务增加 `list / recover / resume`、attempt 记录和真实取消验证；进程仍活着时状态保持 `cancelling`，不再伪称 `cancelled`。覆盖 N49–N52 的一部分与 N50–N51 核心合同。
- Dashboard 新增默认捕获边界和 `pattern=mode` 每应用规则；PointerStage 没有增加菜单或 chips。
- TDD 分层结果：Target Lease 5 项、Capture Policy/Settings 12 项、Context Packet/Capability Search 8 项、Engine/Action/Selection 25 项、Task/Gateway/MCP 19 项、Dashboard/Settings 2 组 Node 测试均已通过。全量回归和真实桌面烟测仍在进行，尚未把外部 provider 或 macOS 写成完成。

### 2026-07-27 / 权限、审计与本地语音可信化

- N54 作用域授权已进入 Python Engine 和 Dashboard：规则可按 Recipe、风险、应用、项目与到期时间约束；越具体越优先，同等具体度下 `deny > confirm > allow`，无效或过期规则不生效。
- N52 审计链已改为 `planId → receiptId → taskId → leaseId` 关联。修复了两个相同 Recipe 并发时 Dashboard 可能把 A 的回执挂到 B 计划上的真实错配；旧事件才回退到 Recipe/Provider 匹配。
- 审计继续保留操作证据，但新增路径、cwd、项目路径、窗口标题、URL、附件和 artifact 字段的递归脱敏；项目只记录不可逆短指纹，目标只保留应用名。
- Claude/Gemini hook 不再直接拼接截图路径，统一经过 Capture Policy、Target Lease、Capability Search 和 Context Packet v2。默认与敏感应用不会把视觉路径送入 hook；只有 Dashboard 全局允许且应用规则明确允许时才进入本地 Agent 附件合同。
- N21–N23 本地语音增加可信配置：Whisper 高 `no_speech_prob` 结果被丢弃，默认逐字保留，可选仅清理重复空格；Dashboard 可设置语言、停顿时长、是否自动提交和静音幻觉拦截。
- 项目术语采用 `scope | term` 规则。只把全局词与当前选区路径匹配的项目词注入本地 Whisper `initial_prompt`，术语正文不进入命令行参数或云端。
- 真实 Fabric 冒烟发现旧脚本把 Agent `accepted` 错断言成 `verified=true`。脚本已纠正为“任务已接收、终态未验证”，并验证本机发现 Codex、Pi、Claude、Gemini；不会用假完成换取绿灯。
- 当前验证证据：Node 全量套件通过；Python 分组全量为 `210 + 126 = 336 passed`（加入语音后还需最终重跑）；语音/设置聚焦测试 `15 passed`；Fabric smoke 的本地剪贴板与证据卡已回读验证，Agent fallback 仅为 accepted，MCP 暴露 10 个工具。

### 2026-07-27 / 产物来源链与最终验证

- 新增本地 Artifact Registry：本地 CSV、证据卡、Context Packet 和 Agent 明确返回的文件，都可关联 `sourceObjectIds / planId / receiptId / taskId / recipeId / provider / sha256`。Activity 用 `artifactId` 展示来源链，审计中不暴露实际路径。
- Magic Pointer 自己生成的过期产物采用两阶段操作：先预览候选，再明确确认后移入 `artifact-trash`；支持恢复且从不直接递归删除。Agent 在工作区生成的文件只登记为 `external` 引用，永不进入自动清理。
- Dashboard Activity 增加本地产物列表、来源关系、过期清理预览、确认移入回收区与恢复按钮；清理和恢复都复用本地 Bridge，不进入 PointerStage。
- 自动验证最终结果：`npm test` 全部 Node/渲染合同通过；`python -m pytest -q` 为 `345 passed in 115.91s`；`git diff --check` 无空白错误。
- Fabric 真实冒烟：30 个 Recipe 可加载；本机发现 Codex、Pi、Claude、Gemini；剪贴板清洗和证据卡读取验证成功；Agent fallback 为 `accepted=true / terminalVerified=false`；MCP 暴露 10 个工具。
- Windows 真机目标烟测：枚举到 4 个可见窗口，`HWND + PID` 匹配返回 `live_target_match`，空窗口探针返回 `stale_target_window`。
- Electron 已重启到新代码，四个全局入口注册均为 `ok=true`。实际打开并截取 Dashboard，确认中文、布局、双列语音模块、滚动和设置表面无明显溢出；随后恢复后台。
- 尚未完成并明确保留：真实麦克风长时间延迟/噪声基准、完整晃动→语音→外部写回实测、macOS 实机权限/签名/公证、日历/Figma/GitHub/Linear/图像/数学视觉真实 provider。

### 2026-07-30 / N17–N18 稳定化复验

- N17 当前主路径已用真实 Windows HWND 复验：三摆唤醒、绘制、释放和语音胶囊
  均不改变来源应用前台窗口；普通拖线释放到胶囊 91 ms，180 ms 缓冲内提前
  按住左键为 99 ms。真实麦克风 final/外部写回仍保留为人工验收，不把它写成完成。
- N18 的“左右—右—左三摆”已通过真实物理鼠标事件；视觉验证器先等待常驻
  RendererReadiness，避免用一次性测试进程的冷加载阻塞污染手势漏触统计。
- 启动语音预热改为 Stage 与 Overlay 均 ready 后开始，避免 Torch/Whisper 在
  应用 ready 的第一帧与透明渲染器竞争；活动录音期间禁止重复 warm-up。
