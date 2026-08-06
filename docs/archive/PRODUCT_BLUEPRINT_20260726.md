# Magic Pointer 产品总蓝图：从“提示词小工具”到操作层

更新时间：2026-07-26

## 0. 结论

Magic Pointer 不应成为另一个聊天窗口、截图问答器、购物清单或 Coding Agent 外壳。它的产品位置是：

> 一个常驻但默认不可见的跨应用操作层。用户晃动鼠标唤醒它，用 `THIS / THAT / THESE / HERE` 指定屏幕上的真实对象，用一句短语或语音说明意图；系统优先调用应用原生接口完成可验证、可撤销的动作，无法原生执行时再把完整的结构化现场交给用户已在使用的 Agent。

核心价值不是“模型会什么”，而是把用户原本需要切应用、截图、复制、解释位置、整理格式、寻找目标入口、核对结果的连续摩擦，压缩成一次指点。

## 1. 竞品事实与边界

### 1.1 Google

Google DeepMind 在 2026-05-12 公布 AI Pointer，明确提出四条原则：

1. 不跳出当前工作流；
2. 同时利用视觉与语义上下文；
3. 用 `this / that / here` 消除冗长描述；
4. 把像素转成可行动对象。

公开演示覆盖：PDF 摘要写入邮件、表格生成图表、食谱倍增、对象移动、便签转待办、暂停视频中的餐厅转订位入口、跨图像组合等。

Googlebook 同日公布，计划于 2026 年秋季上市。官方对 Magic Pointer 的入口描述是“晃动光标，它就会由 Gemini 唤醒”。这说明：

- Magic Pointer 截至 2026-07 不是已经普及的通用桌面功能；
- Googlebook 是 Android 与 ChromeOS 融合的新设备形态，不等于 Windows/macOS 原生系统能力；
- Gemini in Chrome 能在 Windows、macOS 和 Chromebook 上做页面理解、跨标签比较和部分 Google 服务动作，但主要边界仍是 Chrome，而不是任意原生应用；
- 我们复制的不是 Google 品牌或 UI，而是已经被验证的交互原语：晃动、指代、结构化对象和就地动作。

### 1.2 Microsoft

Microsoft 已经在做同一方向，而且产品形态不止一个：

- **Click to Do**：已在 Copilot+ PC 和合格 Cloud PC 上提供。入口包括 `Win + 单击`、`Win + Q`、右滑和截图工具。它对屏幕文字或图片提供复制、搜索、总结、改写、邮件/Teams、Word、Excel、照片编辑等上下文动作。
- **Copilot Vision / Highlights**：在用户共享桌面或应用后理解屏幕，并可用视觉高亮告诉用户下一步点击位置。
- **Copilot Actions on Windows**：实验性 Agent，可在隔离的 Agent Workspace 中点击、输入、滚动和操作文件，保留审批、监控和接管。
- **Windows App Actions**：应用可注册动作提供商，让系统和 Agent 调用应用能力。
- **Browse with Copilot、Tasks、Microsoft 365 Workflows**：分别覆盖浏览器自动执行、即时/定时任务、Outlook/SharePoint/Teams/Planner 工作流。

Microsoft 的现实限制也是 Magic Pointer 的窗口：

- Click to Do 依赖 Copilot+ 级别硬件或 Cloud PC；
- 部分动作受地区和语言限制，在中国区缺少若干 Copilot 动作；
- 能力围绕 Microsoft 应用、Windows 与已注册提供商；
- 入口依旧偏快捷键、截图或显式界面，尚未公开采用 Googlebook 式晃动指针；
- macOS 不具备等价的系统级 Click to Do。

因此，Google 或 Microsoft 发布类似功能并不取消本项目，反而证明需求成立。Magic Pointer 应赢在：

1. Windows 普通机器与 macOS；
2. Agent 中立，不绑 Gemini/Copilot；
3. 浏览器、Office、文件、图片、PDF、终端和本地 Agent 同一对象协议；
4. 晃动唤醒与 `THIS/THAT/HERE`；
5. 用户自有模型、MCP、CLI、GUI 和连接器；
6. 每个动作有能力发现、预览、确认、验证、撤销与审计。

## 2. 真实用户信号

以下不是市场规模证明，而是用于识别反复出现的工作摩擦：

- 开发者反复在浏览器和终端之间截图、拖图、画箭头，再写一段话解释“哪里有问题”；用户明确认为“图像可输入”不等于交流问题已解决。
- PowerToys Text Extractor 被用户描述为高频、有用，原因是“一次框选直接复制”，而截图工具的多步骤会破坏心流；帮助台用户用它抓长错误信息写工单。
- 用户想要原位改写、翻译和粘贴，而不是复制到独立 AI 窗口再复制回来。
- PDF/表格用户真正关心的是可验证提取：数字不一致要高亮，结果要能点回页码和原表格位置。
- macOS 自动化开发者普遍指出，持续截图再让模型重建界面结构成本高且不可靠；Accessibility API 应优先，视觉只做补充。
- 语音自动化的有效形态不是“语音遥控器”，而是带当前应用和历史对象上下文的短命令；离线转写、低延迟和不中断当前应用很重要。
- Office 用户反感常驻浮标遮挡内容、无法彻底关闭的提示和被强塞的 AI 入口。Magic Pointer 必须默认不可见、可暂停、可按应用禁用。

产品推论：

> 高频、小而确定、直接写回现有工作流的动作，比“帮我完成一个宏大任务”的展示更容易形成日用价值；复杂后台任务可以存在，但必须沿用同一对象、权限和回执协议。

## 3. 20+ 个必须交付的真实功能

每个功能都不是单独 App，而是统一 `Object → Intent → Plan → Commit → Verify → Undo` 管线中的 Recipe。

| # | Recipe | 用户一句话 | 真正输出 | 主要用户 | 竞品对齐 |
|---|---|---|---|---|---|
| 1 | 晃动唤醒 | 晃两下鼠标 | 冻结指针对象并显示单一命令气泡 | 所有人 | Googlebook |
| 2 | THIS 对象锁定 | “这个” | DOM/UIA/AX/Office/文件/视觉对象快照 | 所有人 | Google |
| 3 | THAT/THESE/HERE | “比较这个和刚才那个”“移到这里” | 有时序和空间关系的多对象 Episode | 所有人 | Google |
| 4 | 一步 OCR | “复制这段” | 任意应用图像文字直接进入剪贴板 | 普通人/运维 | Microsoft/PowerToys |
| 5 | OCR 清洗 | “复制号码，去掉空格” | 按语义规范化后的文本 | 普通人/客服 | 用户高频缺口 |
| 6 | 原位改写 | “让这段更正式” | 在原应用预览差异并写回，可撤销 | 办公人群 | Click to Do |
| 7 | 原位翻译 | “翻成英文放回这里” | 保留段落结构的替换文本 | 办公/学生 | Click to Do |
| 8 | 摘要/要点 | “把这页三点放到邮件里” | 带来源的要点写入当前草稿 | 办公/研究 | Google/Click to Do |
| 9 | 实体快捷动作 | 指日期、邮箱、电话、URL | 日历草稿、邮件草稿、拨号/打开链接 | 所有人 | Click to Do |
| 10 | 表格转 Excel/CSV | “把这张表放进 Excel” | 结构化表格、单元格来源与置信度 | 财务/研究/运营 | Click to Do |
| 11 | 多表合并 | “把这两块表接起来” | 字段对齐、冲突预览、合并文件 | 财务/研究 | Google 演示 |
| 12 | 图表数据提取 | “把这条曲线的数据导出” | CSV + 图像坐标/估计误差 | 研究/分析 | 未公开高需求 |
| 13 | 公式转 LaTeX | “复制这个公式” | LaTeX/MathML，可直接进论文或 Agent | 学生/研究 | 未公开高需求 |
| 14 | 图片对象处理 | “去背景”“擦掉这个” | 新文件或原生编辑器动作，可回退 | 普通人/设计 | Click to Do |
| 15 | 跨图组合/可视化 | “把这张沙发放进这个房间” | 组合图，保留源图引用和生成参数 | 普通人/电商 | Googlebook |
| 16 | 视觉样式迁移 | “让这个用那张图的风格” | 新图、源/目标对象和可复现参数 | 创作者 | Google 演示 |
| 17 | 画布对象移动/样式 | “把这个移到这里”“变成橙色” | 调用 Figma/Office/画布插件或视觉 Agent | 设计/办公 | Google 演示 |
| 18 | 海报/邮件转日历 | “把这个活动加到日历” | 结构化事件草稿、冲突检查、确认写入 | 所有人 | Googlebook/Click to Do |
| 19 | 两地点路线 | “从这里到那个地方” | 地图路线草稿/深链，不伪造距离 | 普通人 | Google 演示 |
| 20 | 视频帧识别到行动 | “这是哪家店，帮我订位” | 地点证据、地图/订位入口和待确认草稿 | 普通人 | Google 演示 |
| 21 | 食谱/清单结构化 | “把配料加到我的清单，做两倍” | 数量/单位归一、目标清单写入 | 普通人 | Google 演示 |
| 22 | 任务/工单路由 | “把这个错误建成任务” | GitHub/Linear/To Do/本地任务，带来源回链 | 开发/客服 | 用户高频缺口 |
| 23 | 研究证据卡 | “把这段和图保存到项目笔记” | 文本、页码、边框、截图、文件哈希、引用键 | 研究/法务 | 未公开高需求 |
| 24 | Agent 现场交付 | “让 Codex/Pi 修这个” | 当前仓库、窗口、终端、截图、对象锚点直接进入 Agent 会话 | 开发者 | 用户高频缺口 |
| 25 | 无多模态模型视觉桥 | “把这张图解释给本地模型” | 可定位对象、OCR、布局、颜色和图像提示词 | 开发/设计 | 差异化 |
| 26 | 多文件/多图比较 | 指多个文件说“比较这些” | 文件路径、元数据、内容摘要和差异任务 | 开发/办公 | Google |
| 27 | 语音短命令 | 晃动后直接说话 | 离线转写并绑定当前 Episode | 所有人 | Google/社区 |
| 28 | 后台 Agent 任务 | “在后台处理这些，完成后提醒我” | Pi/用户 Agent 任务、进度、暂停、接管、回执 | 开发/知识工作 | Microsoft Actions |
| 29 | Agent 原生接入 | Agent 使用 Magic Pointer | turn hook / plugin / session protocol 优先；MCP 仅兼容 | Agent 用户 | Agent hooks / ACP |
| 30 | 设置与审计 Dashboard | “为什么刚才触发/失败？” | 灵敏度、禁用应用、连接器、权限、历史、撤销 | 所有人 | 必要治理 |

## 4. 核心交互

### 4.1 默认入口

1. 指针停在对象上时只做 120–250 ms 的只读预热；
2. 用户在 250–600 ms 内做短距离水平往返晃动；
3. 系统检查鼠标键、滚轮、拖窗、绘图/游戏禁用列表和冷却时间；
4. 在显示任何界面前冻结当前对象；
5. P50 120 ms 内显示一个不抢焦点的最小蓝色气泡；
6. Dashboard 已选择语音时，小圆声纹立即听写，转写逐段出现并推动同一气泡横向增长；
7. Dashboard 已选择文字时，同一位置直接获得文字输入，打字时按内容增长；
8. 临时气泡不再放建议动作、麦克风键、关闭键、发送键、模式切换或 Agent 选择；
9. 用户说“这个”“那个”“这里”时读取 Episode，不要求重新解释；
10. 提交后仍在同一个气泡内显示 `Processing…`，结果需要更多空间时才切换到结果面；
11. 低风险读操作可直接完成；写入、发送、删除、付费按风险升级确认；
12. 完成后给短回执，失败时说明缺少哪项能力，不伪装成功。

全局快捷键只保留为无障碍和故障恢复备用，不再是主体验。

这一交互不是凭主观简化。对仓库内 `演示7.webm` 至 `演示10.webm` 的逐帧检查显示，
公开演示稳定采用“圆形待命/声纹 → 部分转写逐步增长 → Processing → 结果”的单气泡
状态机；没有出现此前实现的动作建议栏和成排按钮。逐帧证据与帧号见
`GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md`。

### 4.2 晃动检测合同

- 窗口：250–600 ms，最多保留 900 ms 历史用于排除普通移动；
- 特征：横向速度、有效反转、垂直漂移、总路程、净位移、回到中心、停留前速度；
- 拒绝：鼠标键按下、快速滚轮、窗口拖动、绘图/游戏/剪辑应用、已有捕获会话；
- 冷却：一次有效触发后至少 900 ms；
- 自适应：连续触发后立即取消会自动提高阈值；
- 校准：10 秒采集有意晃动样本，只保存特征，不保存屏幕内容；
- 目标：误触 < 0.1 次/小时；有意晃动成功率 > 95%；光晕 P50 < 120 ms；命令气泡 P95 < 350 ms。

## 5. 系统架构

```text
Activation
  Wiggle / Side Button / Accessibility Hotkey
        │
        ▼
Object Fabric
  DOM → Office/COM → UIA/AX → File metadata → OCR → Vision
        │
        ▼
Interaction Episode
  THIS / THAT / THESE / HERE + source geometry + app identity + expiry
        │
        ▼
Recipe Router
  deterministic rules → local model → configured Agent
        │
        ▼
Operation Plan
  capability guard + preview + risk + provider + idempotency key
        │
        ├── Native destination adapter
        ├── Deep link / local artifact
        ├── Image or model provider
        └── Agent connector
              Codex / Pi / Claude / Gemini / Cursor / OpenCode / Aider / Generic
        │
        ▼
Commit → Verify → Receipt → Undo / Audit
```

### 5.1 不可妥协的接口

所有目标端实现：

```python
inspect_capabilities(snapshot) -> CapabilityReport
prepare(operation) -> OperationPlan
preview(plan) -> Diff
commit(plan, idempotency_key) -> Receipt
verify(receipt, expected) -> Verification
undo(receipt) -> UndoReceipt
```

所有 Agent 连接器实现：

```python
discover() -> AgentAvailability
start(task, cwd, attachments, safety) -> AgentTaskReceipt
status(task_id) -> AgentTaskStatus
steer(task_id, message) -> AgentTaskStatus
cancel(task_id) -> AgentTaskStatus
```

### 5.2 Agent 接入

- **Codex**：优先 `codex app-server` 的 Thread/Turn/Item 协议；兼容 `codex exec --json`。
- **Pi**：优先 `@earendil-works/pi-coding-agent` SDK；跨语言宿主使用 `pi --mode rpc` 的 JSONL。
- **Claude Code**：`claude -p`，`--input-format stream-json` / `--output-format stream-json`，保留 session。
- **Gemini CLI**：headless `gemini -p`，结构化输出。
- **Cursor CLI**：`cursor-agent -p --output-format stream-json`；只有明确授权才加 `--force`。
- **OpenCode**：连接 `opencode serve` 的 OpenAPI/SDK。
- **Aider**：使用 `--message` 或 `--message-file`；默认关闭自动提交。
- **Generic**：用户配置命令模板、stdin/argv 模式、输出协议和只读/写入权限。

Magic Pointer 优先通过 Pi Extension、Claude/Gemini prompt hooks、Codex/Pi 会话协议把对象
直接注入 Agent loop；ACP 作为统一会话层预留。MCP stdio server 只保留给缺少这些接口的
Agent，提供获取当前对象、列出 Recipe、执行动作和查询后台任务的兼容能力。

## 6. 组件采用原则

已拉取或存在的成熟组件：

- `external/pi`：MIT；Agent 会话/RPC/扩展底座；
- `external/ufo-schannel`：MIT；Windows UIA、Win32、COM 与混合 GUI/API 参考；
- `external/nut.js`：跨平台鼠标/键盘执行参考；
- `external/openai-whisper`：MIT；当前本地语音转写实现；
- `external/whisper.cpp`：MIT；未来打包为单二进制语音运行时的候选；
- `external/omniparser`：代码与模型权利分开核对；模型权重包含不同许可证，不可整体假设为 MIT；
- `external/screenpipe`：当前仓库根许可证为商业许可证，不能直接混入开源核心；
- `external/ui-tars-desktop`：本地克隆不完整，不作为当前可信依赖。

采用规则：

1. 只把有明确许可证、边界清晰、能替换的组件放入核心；
2. 大模型/GUI Agent 做规划和视觉兜底，不承担能由 UIA/AX/DOM/COM 完成的确定性操作；
3. 外部组件通过 adapter 隔离，不能让其数据留存、遥测或账户假设污染核心；
4. 每个执行结果必须由 Magic Pointer 自己验证，不能以第三方进程退出码代替业务成功。

## 7. Dashboard 定位

Dashboard 后期仍然需要，但它是控制面，不是日常工作首页：

- Activation：晃动开关、灵敏度、10 秒校准、禁用应用、备用快捷键；
- Agents：自动发现 Codex/Pi/Claude/Gemini，配置 Cursor/OpenCode/Aider/Generic；
- Models：本地/云端模型、视觉/文本/语音职责；
- Recipes：30 个 Recipe 的启用、目标应用和默认风险策略；
- Connections：日历、任务、笔记、GitHub、浏览器、Figma 等；
- Privacy：截图上传、内容保留、敏感应用、暂停；
- Activity：触发原因、对象来源、计划、确认、验证、失败和撤销；
- Diagnostics：当前平台宿主能力、缺失权限、延迟与误触指标。

视觉方向：近乎隐形的系统工具。石墨黑、冷白和单一电蓝状态色；高信息密度但无卡片堆砌、紫色渐变和虚构统计。Dashboard 可以稍后继续美化，但数据与设置合同本轮必须建立。

## 8. 发布与验收

### Windows

- 普通 Windows 11 机器可运行，不要求 NPU；
- UIA/COM 优先；视觉兜底；
- 晃动默认开启；
- 真实 Word、浏览器、文件、PDF、终端与至少一个本地 Agent 冒烟。

### macOS

- Electron 共享 UI、Recipe、Agent 和审计层；
- 原生宿主使用 Accessibility、ScreenCaptureKit/CGWindow 和 CGEvent；
- TCC 权限必须有分步状态，不允许只写“未来支持”；
- 在 Windows 上不能声称已完成 macOS 实机验证，必须保留独立构建/签名验收。

### 成功标准

不是“页面能打开”或“单测通过”，而是：

1. 不按快捷键，按规定晃动即可出现；
2. 指针对象在 UI 出现前已锁定；
3. 至少 20 个 Recipe 都能进入真实 provider、明确缺失 provider，或完成确定性本地动作，绝不返回虚假成功；
4. Codex、Pi、Claude、Gemini 能被自动发现并生成各自真实调用；
5. Pi/Claude/Gemini 原生 hook 能在用户指代 THIS 时注入对象，MCP tools 仍可作兼容调用；
6. 写操作有预览、确认、验证；支持的动作有精确撤销；
7. Dashboard 能控制晃动、Agent、Recipe、权限和审计；
8. 自动测试、静态检查、应用启动、实际 bridge 调用和至少一个真实 Agent dry-run 全部留有证据。

## 9. 参考资料

官方：

- Google DeepMind AI Pointer: https://deepmind.google/blog/ai-pointer/
- Googlebook: https://blog.google/products-and-platforms/platforms/android/meet-googlebook/
- Gemini in Chrome: https://gemini.google/overview/gemini-in-chrome/
- Microsoft Click to Do: https://support.microsoft.com/en-us/windows/ai/ai-features/click-to-do-do-more-with-what-s-on-your-screen
- Microsoft Windows AI experiences: https://blogs.windows.com/windowsexperience/2025/05/06/introducing-a-new-generation-of-windows-experiences/
- Microsoft experimental agentic features: https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features
- Windows App Actions: https://learn.microsoft.com/en-us/windows/ai/app-actions/actions-provider-manifest
- Codex app-server: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Pi RPC: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
- Pi Extensions: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Claude Hooks: https://code.claude.com/docs/en/hooks
- Gemini Hooks: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
- ACP Architecture: https://agentclientprotocol.com/get-started/architecture
- Claude Code CLI: https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Gemini CLI headless: https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
- Cursor CLI headless: https://docs.cursor.com/en/cli/headless
- OpenCode server: https://dev.opencode.ai/docs/server/
- Aider scripting: https://aider.chat/docs/scripting.html

社区需求样本：

- Screenshot → Coding Agent friction: https://www.reddit.com/r/ClaudeCode/comments/1twmmon/how_are_you_giving_instructions_with_screenshots/
- Copilot floating UI blocks work: https://www.reddit.com/r/Office365/comments/1t80i63/microsoft_copilot_floating_icon_is_blocking_the/
- Screenshot OCR without breaking focus: https://www.reddit.com/r/productivity/comments/1pfikjc/how_do_you_handle_extracting_text_from/
- Screenshot OCR used 15–20 times daily: https://www.reddit.com/r/productivity/comments/1pcwhqk/quick_tip_screenshot_ocr_saves_more_time_than/
- macOS Accessibility beats continuous screenshots: https://www.reddit.com/r/MacOS/comments/1suhp2z/using_screenshots_to_track_user_context_for_an_ai/
- Voice automation workflows: https://www.reddit.com/r/MacOSApps/comments/1s2q4sj/i_built_a_native_macos_voice_automation_and/
