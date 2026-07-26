# Magic Pointer 一小时外部调研、产品重审与讨论修正

日期：2026-07-22  
性质：产品研究记录，不是实现计划  
范围：历史对话、当前项目状态、Google/Microsoft/同类产品、社交媒体需求、Pi 与多 Agent 架构，以及 2026-07-22 讨论后的修正

## 一、结论摘要

当前 Magic Pointer 是一个具备部分底层能力的技术原型，还不是已经验证客户需求的完整产品。按“能否让真实用户稳定、反复地完成工作”评估，整体完整度约为 12%–18%。

需要修正的不是“是否继续做鼠标 AI”，而是产品单位：

> 鼠标不应该成为另一个聊天窗口或封闭 Agent。鼠标首先是一个低成本的指代输入设备，用来告诉已有工具和 Agent：“就是这个、那个、这些东西，并且我要对它们做这件事。”

上一轮审视得出的“Context Switchboard”方向仍然成立，但本次讨论进一步明确：Magic Pointer 不只应是上下文采集层，也可以是一个跨 Agent 的 **Context and Prompt Compiler**：把点击、框选、语音、应用状态、文件路径和视觉理解结果，编译为不同 Agent 可直接消费的上下文包或完整 prompt。

Google 和 Microsoft 是否发布类似功能，并不决定项目是否值得做。它们影响的是：

1. 用户对基础交互和速度的最低预期；
2. OCR、翻译、总结等功能是否已成为免费商品；
3. Magic Pointer 必须在哪些层面形成系统性差异。

真正可以形成差异的不是“右键菜单里动作更多”，而是：

- Windows 与 macOS 跨平台；
- Agent 中立，而不是绑定 Gemini 或 Copilot；
- 点击、框选、语音和多对象指代的统一表达；
- 精确文件、页面、代码行、DOM、应用对象和来源信息；
- 为纯文本模型提供可验证的视觉转译；
- 写回、回读验证、收据与撤销；
- 通过稳定协议送入用户已经在工作的 Agent，而不是把用户拉进新聊天框。

## 二、读取到的历史对话

项目对应的两份 Claude 历史记录为：

- `C:\Users\zjz65\.claude\projects\D--Desktop-Magic-Pointer\62c0bb29-e618-436c-8b92-046270879e14.jsonl`
- `C:\Users\zjz65\.claude\projects\D--Desktop-Magic-Pointer\7768056a-8782-44d8-9842-86e91cbd6468.jsonl`

两份记录都主要审查 V2 UIA 选区适配器，不是完整产品决策历史。一份给出 NO-GO，另一份给出带后续事项的 GO，但都没有执行充分的真实运行验证。

这说明当时已经投入较多精力在“能否从浏览器/PDF 获得原生选区”，但还没有把底层验证、工作流闭环和真实用户需求连成一个系统。

历史审查中最重要的风险包括：

- PID 为 0 或身份未知时没有严格失败关闭；
- 同进程多标签页或多文档可能取得错误对象；
- 探测开始后没有重新验证前台 HWND/PID；
- 后代节点搜索范围与延迟风险；
- `activeRequestId` 生命周期不完整；
- 静态测试通过被误认为运行时信任已经建立。

## 三、当前项目的真实完成度

### 3.1 已经有价值的部分

- Windows UIA、浏览器/PDF 原生文本选区探索；
- semantic-first、减少剪贴板扰动的思路；
- 选择会话、快照桥、动作策略等分层雏形；
- inline rail、结果表面、Reader 和 Dashboard 等交互实验；
- 操作确认、撤销、写回和回读验证的部分机制；
- 将生成结果粘贴到已有 CLI/GUI 输入框且不自动提交的受控原型；
- 多对象、THIS/THAT、来源锚点和工作流路由的产品文档基础。

### 3.2 仍然缺失的部分

- 对前台窗口、文档和选区身份的完整可信证明；
- 浏览器、PDF、IDE、Office 等场景的真实稳定性矩阵；
- Google Calendar、Outlook、GitHub、Linear、Slack、Teams、Zotero、Obsidian 等真实连接器；
- Pi、Codex、Claude Code、Gemini CLI 等稳定机器接口；
- macOS 原生宿主；
- 安装、更新、首次引导、权限解释、崩溃恢复和安全密钥存储；
- 真实用户留存、重复使用和付费证据；
- 一组足够窄、足够高频、真正优于复制粘贴的核心工作流。

### 3.3 分层估算

| 层级 | 当前完整度 |
|---|---:|
| Windows 选区、语义捕获与基础定位 | 25%–35% |
| 可信身份、来源证明和竞态处理 | 20%–30% |
| 能替客户完成真实工作 | 10%–15% |
| 对接 Pi、Codex、Claude、Gemini 等 Agent | 15%–25% |
| 安装、权限、升级、恢复和产品化 | <10% |
| 真实留存、付费和 PMF 证据 | 0%–5% |

这些百分比不是代码量，而是完整客户体验的方向性估算。

## 四、Google 实际发布了什么

### 4.1 Googlebook Magic Pointer

Google 于 2026-05-12 展示 Googlebook 和 Magic Pointer。官方形式包括：

- 摇动指针唤起 Gemini；
- 根据当前指向对象显示上下文建议；
- 指向邮件中的日期创建会议；
- 选择两张图片进行组合或空间可视化；
- 将像素解释为日期、地点、物体等可操作实体；
- 使用指向与语音表达“This”“That”“These”。

截至 2026-07-22，完整的 Magic Pointer 被官方描述为 Googlebook 功能，随 Googlebook 设备在 2026 年秋季上市。Google 没有宣布把同样的系统级 Magic Pointer 发布到旧 Chromebook、Windows 或 macOS。

来源：

- [Googlebook 官方介绍](https://blog.google/products-and-platforms/platforms/android/meet-googlebook/)
- [Google DeepMind AI Pointer](https://deepmind.google/blog/ai-pointer/)

### 4.2 Chrome 中已经存在的部分能力

Google 同时在 Chrome 中逐步发布了较小范围的屏幕选择能力：

- 打开 Chrome 的 Gemini 侧栏；
- 选择“Select from screen”；
- 在网页上绘制一个或多个矩形区域；
- 将这些区域自动附加到 Gemini prompt；
- 调整、重叠或删除选区。

该功能明确支持 Chromebook Plus、Mac 和 Windows，但它只发生在 Chrome 网页内，不是跨任意应用的系统级 Magic Pointer，也没有完整的摇动、语音、多应用动作和可靠写回链路。

来源：

- [Share specific parts of your screen with Gemini in Chrome](https://support.google.com/gemini/answer/17077507?hl=en)
- [Gemini in Chrome availability](https://support.google.com/chrome/answer/17140089?hl=en)

### 4.3 什么才算已被用户验证

Googlebook Magic Pointer 尚未正式上市，因此不能说它已经获得良好用户反馈。真正得到大规模验证的是 Circle to Search/Lens 这一类原子功能：

- 复制不可选择文本；
- 翻译；
- 识别商品、植物、地点和物体；
- 视觉搜索；
- 裁剪并分享。

Google 曾披露 Lens 每月接近 200 亿次视觉搜索，Circle to Search 已覆盖超过 1.5 亿台设备。

来源：[Google Lens 和 Circle to Search 数据](https://blog.google/products-and-platforms/products/search/google-search-lens-october-2024-updates/)

## 五、Microsoft 实际在做什么

### 5.1 产品形式

Microsoft 的同类功能叫 **Click to Do**。它不是传闻，而是已经发布给符合条件的 Copilot+ PC 和部分 Cloud PC。

调用方式包括：

- `Win + 鼠标点击`；
- `Win + Q`；
- 触摸屏从右侧滑入；
- Snipping Tool；
- Print Screen 和开始菜单入口。

进入后，Windows 对当前屏幕截图进行本地分析，指针变为蓝白状态，用户再选择文本或图片，并看到与对象类型相关的动作。

现有动作包括：

- 文本：复制、打开、搜索、发送邮件、Teams 消息、安排会议；
- 本地 Phi Silica：总结、列表、语气改写、语法润色；
- 图片：复制、保存、分享、视觉搜索、背景模糊、物体擦除、移除背景；
- 交给 Copilot 或 Microsoft 365 Copilot；
- 交给 Word、Teams、Excel、Paint、Photos 等 Microsoft 应用。

来源：[Microsoft Click to Do 支持文档](https://support.microsoft.com/en-us/windows/ai/ai-features/click-to-do-do-more-with-what-s-on-your-screen)

### 5.2 什么时候发布

时间线是：

- 2024 年先进入 Windows Insider/Copilot+ PC 预览路线；
- 2025 年 4 月非安全预览更新开始面向消费者滚动发布；
- 2025-05-06，Microsoft 宣布 Click to Do 已更广泛地提供给 Copilot+ PC，并继续逐步增加动作；
- Snapdragon 设备先获得部分文本动作，AMD 和 Intel Copilot+ PC 随后跟进。

来源：

- [2025-04-25 Windows Experience Blog](https://blogs.windows.com/windowsexperience/2025/04/25/copilot-pcs-are-the-most-performant-windows-pcs-ever-built-now-with-more-ai-features-that-empower-you-every-day/)
- [2025-05-06 Windows Experience Blog](https://blogs.windows.com/windowsexperience/2025/05/06/introducing-a-new-generation-of-windows-experiences/)

### 5.3 为什么很多人没听说或用不到

它要求：

- Copilot+ PC 或符合条件的 Cloud PC；
- 40 TOPS NPU；
- 16 GB 内存；
- 8 个逻辑处理器；
- 256 GB 存储；
- 对应 Windows、Snipping Tool、区域和语言更新。

普通旧 Windows 11 电脑不能直接获得完整能力。Microsoft 也没有公布把完整 Click to Do 下放到所有旧 Windows 设备的时间。

中国区当前还缺少 Ask Copilot、Draft with Copilot in Word、Summarize、Create a bulleted list、Formal/Refine Rewrite 等动作。因此对中国用户而言，剩余能力更接近 OCR、复制、链接识别和部分本地图片动作。

### 5.4 它与 Magic Pointer 的关系

Click to Do 与 Magic Pointer 共享“指向屏幕对象并获得上下文动作”的交互思想，但它更像：

> Windows 内置、Copilot+ 硬件限定、Microsoft 生态优先的系统动作菜单。

它尚不是：

- Agent 中立的输入层；
- 面向 Pi、Codex、Claude Code、Gemini CLI 的统一接口；
- 能表达多对象关系和复杂语音意图的 prompt 编译器；
- 可在普通 Windows 和 macOS 上运行的跨平台产品；
- 对文件、代码行、DOM、PDF 页码和来源进行统一封装的上下文系统。

因此它验证品类，但没有完成 Magic Pointer 可以追求的完整系统。

## 六、同类产品与用户反馈

### 6.1 AIPointer

AIPointer 已具备跨平台、BYOK、多模型、系统安全存储、引导、自动更新、文件附件、语音、审批等较完整的产品包装。这说明 Magic Pointer 在产品化层面明显落后。

但 AIPointer 的主要社交证据仍以作者发布帖为主，独立长期留存证据有限。它更像“通用鼠标 AI 客户端”，还没有证明跨 Agent 可信上下文是其核心。

来源：[AIPointer 仓库](https://github.com/gonemedia/aipointer)

### 6.2 PopClip 和 Raycast

PopClip 长期验证了“小型、按需出现、上下文相关的选择工具条”具有高频价值。Raycast 验证了选中文本后原位改写、复制、命令和 Agent 扩展的需求。

它们也说明：用户喜欢的是短、快、可预测的动作，不是鼠标旁再出现一个完整聊天应用。

来源：

- [PopClip Guide](https://www.popclip.app/guide/)
- [PopClip 用户讨论](https://www.reddit.com/r/macapps/comments/1q17yct/popclip_is_seriously_next_level/)
- [Raycast AI Commands](https://manual.raycast.com/ai/ai-commands)

### 6.3 普通 Windows 用户反馈

Windows 用户反复称赞的是：

- Snipping Tool；
- OCR/Text Extractor；
- Clipboard History；
- 语音输入；
- 快速截图与分享。

对 Click to Do 的公开讨论相对弱，有用户表示功能有限，主要用来从图片复制文字，也有人明确认为 Snipping Tool OCR 更直接。

来源：

- [Windows 11 隐藏功能讨论](https://www.reddit.com/r/Windows11/comments/1v2fz9i/)
- [Windows 用户最喜欢的功能](https://www.reddit.com/r/Windows11/comments/1r5pocd/)

### 6.4 开发者需求

开发者正在反复经历：

1. 截取错误、页面或原型；
2. 拖入 Claude Code、Codex 或其他 Agent；
3. 再写一段文字解释“我说的是右上角这个元素”；
4. Agent 仍然不知道对应 DOM、组件文件、日志和源码位置。

这类用户一天可能产生 5–50 张临时截图。鼠标和语音在此有明显优势，因为用户可以用“这个按钮”“这里的间距”“这个报错”表达意图。

来源：

- [Claude Code screenshot workflow](https://www.reddit.com/r/ClaudeCode/comments/1twmmon/how_are_you_giving_instructions_with_screenshots/)
- [Screenshot clutter discussion](https://www.reddit.com/r/ClaudeCode/comments/1sk1qrj/how_many_screenshots_do_you_drag_in_per_day_be/)

### 6.5 非代码工作者需求

会计、销售、运营和行政人员的高频痛点包括：

- PDF 或网页表格到 Excel；
- 选定证据到报告或备忘录；
- 会议记录到 CRM；
- 邮件内容到日历、任务或客户记录；
- 多系统之间重复复制粘贴。

但完整文档转换和整场会议处理属于批量 Agent 任务。鼠标的优势只存在于“选定哪块、送到哪个已知字段、预览后写入”这一段。

### 6.6 普通人需求

最确定的普通人入口是：

- 复制任何屏幕文字；
- 翻译；
- 解释短文本；
- 只朗读选中的小段内容；
- 识别物体或商品；
- 裁剪分享；
- 将日期、电话、地址变成可执行对象。

这些适合获客和建立使用习惯，但单独不构成护城河。

## 七、什么场景天然适合鼠标

一个任务只有同时满足以下条件，才应放进鼠标工作流：

1. 对象已经显示在屏幕上；
2. 对象难以用文本准确描述或定位；
3. 动作短、结果明确；
4. 目标应用或 Agent 已知；
5. 用户能够快速确认、撤销或验证。

如果任务需要长 prompt、多轮对话、长答案阅读、遍历多个文件或几十秒以上执行，就应交给现有 Agent、Web 或 CLI。Magic Pointer 负责构造上下文和发起任务，而不是承载整个任务。

## 八、修正后的核心产品：Context and Prompt Compiler

### 8.1 用户交互

用户执行：

1. 点击、框选或连续指向多个对象；
2. 用短语音说“把这个错误和那段规范发给 Codex，让它修当前项目”；
3. Magic Pointer 识别应用、文件、页面、代码、图片和对象关系；
4. 系统生成完整、可检查的 Context Capsule 与目标 Agent prompt；
5. 通过 Agent 协议发送，或复制到用户正在工作的 Agent；
6. Agent 在原有环境中继续执行。

用户不需要重新描述：

- 文件在哪里；
- 截图中指的是哪个区域；
- 当前项目是什么；
- 报错属于哪个终端或页面；
- 哪些对象是输入、参考或目标。

### 8.2 Context Capsule 建议内容

```yaml
intent:
  transcript: "把这个错误和那段规范发给 Codex，让它修当前项目"
  normalized_action: "diagnose_and_fix"

targets:
  - role: problem
    app: Chrome
    url: https://example.com/page
    region: [x, y, width, height]
    dom_selector: "..."
    screenshot_ref: "..."
  - role: constraint
    app: PDFReader
    file_path: "D:/docs/spec.pdf"
    page: 17
    text_range: "..."

workspace:
  root: "D:/project"
  active_file: "src/component.tsx"
  active_lines: [120, 148]

observations:
  ocr: "..."
  accessibility_text: "..."
  vision_description: "..."
  vision_confidence: 0.82

delivery:
  target_agent: "codex"
  mode: "rpc"
  require_confirmation: true
```

### 8.3 Target-specific Prompt Compiler

同一个 Capsule 可被编译为不同目标：

- Pi RPC 消息；
- Codex app-server 或 MCP resource；
- Claude Code stream JSON / MCP；
- Gemini CLI 输入；
- IDE 插件命令；
- 普通 Markdown prompt；
- 剪贴板文本，作为最低兼容兜底。

这里的护城河不是 prompt 模板数量，而是输入上下文的真实性、精确性和跨应用一致性。

## 九、FrameCue 类视觉桥接与纯文本模型

FrameCue 当前是一个 Chrome 扩展：捕获网页视觉参考，提取可复用的图像生成提示词，并支持内置额度或自定义 API。它说明“视觉对象 → 结构化文本提示词”可以成为独立工具。

来源：[FrameCue Chrome Web Store](https://chromewebstore.google.com/detail/framecue/ominnoofpoiipbbghbclcgdondgpehba)

Magic Pointer 可以把类似能力泛化成 **Visual Context Compiler**：

1. 用户点击图片、界面或其中一个区域；
2. 系统保留原始图片路径、窗口、像素坐标、缩放和选区；
3. OCR、DOM/AX、图像分割和 VLM 分别提取证据；
4. VLM 生成面向当前任务的结构化视觉说明；
5. 将说明、坐标、来源和不确定性发送给纯文本 coding model。

这可以让纯文本模型间接处理很多视觉任务，例如：

- UI 与参考图差异；
- 哪个按钮错位；
- 图中出现了什么错误状态；
- 页面层级、颜色、间距和组件关系；
- 用户点击的是哪个具体视觉对象。

但它不是让纯文本模型真正变成多模态模型，而是在模型前增加一个视觉解释器。主要风险是：

- 图像信息被文字压缩后丢失；
- VLM 可能误读小字、图表和空间关系；
- 自由描述无法可靠映射回像素；
- 下游文本模型可能把推断当成事实。

因此不能只输出一段自然语言 caption。必须同时提供：

- 原图或截图引用；
- 点击点、框选区域和屏幕尺寸；
- OCR 原文；
- DOM/Accessibility 语义；
- 文件、URL、页码、代码行；
- “观测事实”与“模型推断”的区分；
- 置信度和失败提示。

## 十、Pi 与后台 Agent

Pi 可作为默认或可选执行引擎，因为它具备多 provider、会话、工具调用和 JSONL RPC。Magic Pointer 不应与 Pi 强绑定。

合理分层是：

### Magic Pointer 负责

- OS 输入和指向手势；
- 屏幕、文本、对象和应用身份；
- Context Capsule；
- 语音转写与意图编译；
- 权限、敏感信息和确认；
- 目标 Agent 路由；
- 执行收据、验证与撤销。

### Pi/Codex/Claude/Gemini 负责

- 推理；
- 长任务规划；
- 代码或文档处理；
- 工具调用；
- 在各自环境中执行工作。

Pi 官方明确说明其进程按用户权限运行，并不内置沙箱。因此“后台运行”应理解为一个默认休眠的 Broker，而不是持续观察屏幕、拥有无限权限的自主 Agent。

来源：

- [Pi repository](https://github.com/earendil-works/pi)
- [Pi RPC documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md)
- [Pi security](https://pi.dev/docs/latest/security)

## 十一、Windows 与 macOS 的产品策略

跨平台目标是合理的，而且应从协议和数据模型开始设计，而不是最后把 Windows 代码硬移植到 macOS。

建议的边界为：

### 共享核心

- Context Capsule schema；
- Prompt Compiler；
- Agent Router；
- 权限策略；
- 配方系统；
- 执行收据与审计；
- UI 状态模型。

### Windows Host

- UI Automation；
- Windows Graphics Capture；
- 窗口和进程身份；
- Win32 全局手势与快捷键；
- Explorer、Office、浏览器和终端适配器。

### macOS Host

- Accessibility/AXUIElement；
- ScreenCaptureKit；
- CGWindow/Event Tap；
- Finder、Xcode、浏览器、终端和常用开发工具适配器；
- Screen Recording、Accessibility、Microphone 等系统权限引导。

Electron 可以承载部分共享 UI，但不能假装 OS 捕获层也可以一次编写、到处运行。

需要修正“开发者更多使用 Mac”这一表述：Mac 在创业公司、AI、设计、前端和高端个人开发者群体中具有很高密度，确实不能忽略；但 2025 Stack Overflow Developer Survey 的职业使用数据仍是 Windows 49.5%、macOS 32.9%。因此正确结论不是“Mac 用户总量更大”，而是 **Mac 是高价值目标群体且必须成为一等平台**。

来源：[2025 Stack Overflow Developer Survey](https://survey.stackoverflow.co/2025/technology/#1-computer-operating-systems)

## 十二、修正后的竞争判断

Google 或 Microsoft 出现类似功能，不构成停止项目的理由。它们证明了指向式 AI 是一个真实交互方向。

但竞争不能完全忽略，因为：

- OCR、翻译、搜索、总结会被系统免费提供；
- 用户会拿 Magic Pointer 的速度和系统原生体验比较；
- 通用右键 AI 菜单难以收费；
- 系统厂商可能占据默认手势和快捷键；
- 应用连接器可能限制第三方写入。

Magic Pointer 应避免与它们竞争的层：

- 模型能力；
- 系统自带 OCR；
- 搜索引擎；
- Office/Gmail 等单一厂商生态内的基本动作；
- 只面向网页的区域截图提问。

应该建立的系统性差异：

1. 普通 Windows 与 macOS，而不是新硬件限定；
2. Pi、Codex、Claude、Gemini 等任意 Agent；
3. 多对象、语音和关系表达；
4. 文件、代码、DOM、PDF 和视觉区域的联合上下文；
5. 为纯文本模型提供视觉桥接；
6. 完整 prompt 自动生成与目标适配；
7. 可信写回、验证、撤销和审计；
8. 开放 Capsule/Adapter/Recipe 接口。

## 十三、UI 重审

现有 UI 的问题不是配色，而是产品层级错误：

- Dashboard 不应成为日常操作中心；
- Overlay、inline rail、结果窗、Reader 和 Dashboard 形成过多表面；
- 鼠标摇动和启动弹窗可能破坏安静感；
- `Ctrl+Alt+M` 与 Google Docs、Word、PowerPoint 的插入评论快捷键冲突；
- 购物、日历和地图演示让产品看起来像多个未完成的小应用。

日常交互应围绕：

- 用户主动指向或选择；
- 状态提示；
- 极少数强相关动作；
- 语音或一句短指令；
- 显示将要发送的对象和目标 Agent；
- 一键发送或复制；
- 结果回到原工作流。

Dashboard 只保留连接器、Agent、权限、配方、活动记录和审计。

## 十四、应停止与保留的内容

### 停止作为产品支柱

- 本地购物清单；
- 假日历和地图演示；
- Dashboard-first；
- 鼠标旁的长聊天；
- 强制 Reader；
- 默认主动摇动建议；
- 持续屏幕捕获；
- UIA 粘贴作为主要 Agent 集成；
- 过早声称 1.0 和 cross-platform。

这些功能可以作为测试夹具保留，但不能继续定义产品。

### 继续投资

- 可信指向和选区；
- 多对象 THIS/THAT/THESE；
- Voice + Point；
- 文件、页面、代码和应用身份；
- Context Capsule；
- Target-specific Prompt Compiler；
- Visual Context Compiler；
- Agent 协议与插件；
- 写回验证、撤销和收据；
- Windows/macOS 双宿主架构。

## 十五、Naval 视角

通用 AI 浮窗、翻译、总结、聊天和日历属于同质竞争，系统厂商很容易免费内置。

Magic Pointer 的特殊知识应当是：

- Windows/macOS 对象身份与权限；
- 跨应用来源与空间上下文；
- 指向和语音如何编译成机器可执行意图；
- Agent 中立互操作；
- 可信写回和验证。

杠杆来自开放的 Capsule、SDK、Adapter 和 Recipe 生态。商业价值更可能来自团队权限、企业连接器、部署、安全和支持，而不是模型调用差价。

> 如果系统厂商一次更新就能复制全部可见功能，项目没有护城河；如果各类 Agent 仍需要通过 Magic Pointer 才能准确理解“这个、那个、这些”并安全进入用户工作流，项目就拥有独立位置。

## 十六、继续开发前的验证门槛

- 只选择 3 个首发工作流；
- 12–18 名目标用户进行 7 天真实使用；
- 有效配方每人至少重复 5 次；
- 原子动作中位耗时小于 3 秒；
- 从指向到 Agent 接收上下文小于 8 秒；
- 来源、文件和目标身份正确率高于 99%；
- 写操作必须具有确认、回读、收据或可恢复撤销；
- 检查第二周留存，而不是只收集“很酷”的评价；
- 分别测量 Windows 和 macOS，不用一个平台的结果推断另一个平台。

## 十七、当前修正版产品一句话

> Magic Pointer 是面向 Windows 和 macOS 的 Agent 中立指向输入层：用户通过点击、框选和语音，把屏幕上的对象、文件、代码、图片及其关系编译成可信上下文和完整 prompt，发送给正在工作的任意 Agent；必要时先用视觉模型把图像转译给没有多模态能力的模型，并保留来源、坐标、验证和撤销能力。

这比“做一个鼠标里的 Agent”更准确，也比“复制 Google 的 Magic Pointer”具有更独立的产品边界。

## 十八、2026-07-22 实施轮决策：Dashboard 后置，先闭环主链

本轮确认 Dashboard 仍然必要，但它的角色是设置与治理中心，不是日常操作首页。后续 Dashboard 至少需要覆盖：快捷键与唤醒参数、Agent profiles、CLI/RPC/GUI 连接、截图与麦克风权限、敏感应用黑名单、上下文保留周期、Recipes、活动记录和审计。购物、日历、路线等现有演示可以收进开发者可见的 Lab，继续充当动作策略回归夹具。

Dashboard 独立排入后续里程碑。本轮不再给旧 Dashboard 增加业务卡片，也不构造临时设置页；少量参数先通过环境变量或现有配置暴露。

当前实现优先级调整为一条可以交付的完整链路：

1. 用户在任意应用中选中原生文本/文件/控件，或在视觉界面上指向、框选对象；
2. 用一句短指令或主动触发的系统听写说明该对象的意义；
3. 连续采集多个对象，生成包含来源、坐标、原文、视觉观察和不确定性的 Context Pack；
4. 识别当前目标是 Codex、Claude、Gemini、Pi 还是未知 Agent；
5. 编译针对目标 Agent 的完整 prompt artifact；
6. 锁定当前输入框填入 prompt，但绝不自动按回车或点击发送；
7. 保留现有论文验收流程作为该通用能力的专业模板，而不是继续让它定义整个产品。

对应设计与逐文件实施计划分别记录在：

- `docs/superpowers/specs/2026-07-22-context-prompt-compiler-alpha-design.md`
- `docs/superpowers/plans/2026-07-22-context-prompt-compiler-alpha.md`

## 十九、2026-07-22 本轮成品与 Terra 边界审核记录

本轮没有继续给旧购物、日历或路线演示堆功能，而是把产品主链重构成一个可运行的 Windows Alpha：原生选区和视觉指向都能进入持久 Context Pack；多条证据可被编译成 Codex、Claude、Gemini、Pi 或 generic Agent prompt；用户指向目标输入框后，系统只填入、不发送。论文/交付物验收保留为专业 Recipe，旧 Dashboard 与生活类动作默认隐藏在 `MAGIC_POINTER_ENABLE_LAB=1` 后。

界面改为安静的 Command Rail：默认不显示启动弹层，不启用摇动唤醒，日常入口只保留主动快捷键、少量上下文相关动作、文本/系统听写输入和 Context Pack 数量。完整设置 Dashboard 仍是后续独立里程碑，负责快捷键、Agent 连接、CLI/RPC/GUI 路由、权限、隐私、Recipes、保留周期与审计，而不是回到 Dashboard-first。

完成主体后，使用 `gpt-5.6-terra` 子 Agent 对边界条件做了只读审核。审核发现并已收口的有效问题包括：

- Electron DIP 与 Win32/UIA 物理像素混用，在混合 DPI 或负坐标屏幕上可能写错输入框；现在显式转换并把坐标空间纳入交付契约。
- 收集与编译并发时可能把旧 prompt 保存成最新；现在用 session revision 与 item digest 做 compare-and-swap，冲突时重新读取并编译。
- 合法 JSON 但内部结构损坏可能产生未受控异常；现在验证 session、active reference 和 item schema。
- UIA writer 的 HWND 曾按 32 位解析且未严格核对标题；现在使用 `long`/`IntPtr`，同时核对 HWND、PID、窗口标题、落点所属窗口和坐标空间。
- Electron renderer IPC 和 action token 的 surface 边界不完整；现在 IPC 校验发送方，token 绑定 surface 与 webContents。
- 系统听写可能重复启动或在窗口销毁后回送；现在每个 surface 只允许一个 in-flight 子进程，结果只结算一次并安全清理。
- 通用 Context Pack 与验收会话同时存在时，“填入这里”含义冲突；现在拒绝模糊命令，要求明确说“发送到这里”或“把验收意见填到这里”。
- prompt 只有字段级截断，没有全局预算；现在总长度限制为 60,000 字符，并始终保留所有 item 的短索引，详细证据超限时明确指向原始 Context Pack。
- 视觉来源曾默认取窗口列表第一项；现在只采用实际包含指针落点的最上层窗口，无法命中时来源保持 unknown。

本轮保留的真实边界：macOS AXUIElement/ScreenCaptureKit 宿主、Pi/Codex/Claude/Gemini 的 CLI/RPC 原生连接器、正式设置 Dashboard、权限引导与敏感应用策略仍未实现；GUI handoff 仍是 Windows 本地 fallback。它已是可以继续做真实用户试用的整体 Alpha，不应被表述为跨平台完成品或生产版。

## 二十、2026-07-23 价值纠偏：从源码收集器改为 Runtime Issue Handoff

用户否定了上一轮建议的 Coding 体验：要求开发者先选中实现函数和测试文件，是让用户替 Coding Agent 完成它本来就擅长的仓库检索。现代 Agent 在得到清楚任务后可以自行浏览仓库，Magic Pointer 再包装代码文件没有独立价值。

因此 Coding 主链改为处理 Agent 缺失的运行现场：

1. 用户在真实软件、网页或登录态系统中看到问题；
2. 按 `Ctrl+Alt+M` 圈出对象，直接说哪里不对、期望怎样；
3. 可选在设计稿、竞品或正确状态上再次圈出 reference；
4. Magic Pointer 保存截图、指针、窗口、URL、空间位置、结构化上下文和视觉观察；
5. 用户在 Agent 输入框按 `Ctrl+Alt+Enter`；
6. 生成的 Runtime Issue 明确要求 Agent 自行检查当前工作区、定位源码、修改并验证；
7. 系统只填入、不发送，成功后结束 session，失败保留现场以便重试。

旧原生选区与通用 Context Pack 不删除，但降到 `Ctrl+Alt+Shift+M` 的兼容入口。它们可以服务文档、PDF 和精确引用，不再定义 Coding 产品价值。

这次纠偏后的护城河不是“帮 Agent 看代码”，而是把 Agent 原本看不到的 THIS、REFERENCE、登录态运行状态和跨应用空间关系变成可执行任务。对应规格与计划：

- `docs/superpowers/specs/2026-07-23-runtime-issue-handoff-design.md`
- `docs/superpowers/plans/2026-07-23-runtime-issue-handoff.md`

本轮已经落地并验证的不是概念稿，而是 Windows Alpha 主链：

- 第一条视觉证据锁定为 `issue`，后续证据标记为 `reference`，不会悄悄改写最初任务；
- Runtime Issue prompt 明确要求目标 Agent 自行检查当前工作区并定位源码，不再要求用户选文件；
- `Ctrl+Alt+M`、`Ctrl+Alt+Enter`、`Ctrl+Alt+Shift+M` 分别承担现场捕获、Agent 交付和旧原生选区；
- Magic Pointer 自身 Overlay、Panel、Reader、Result 等窗口在屏幕对象建模前被排除，避免透明层抢占真实目标窗口；
- 交付锁定目标窗口与会话，只填入、不发送；成功交付只结束匹配的 Runtime Issue，失败或会话不匹配时保留现场；
- 无视觉模型时仍保存原始截图、指针、几何和窗口上下文，允许纯文本 Coding Agent 使用；
- `demo/runtime_issue_demo.html` 提供一个可重复体验的错位按钮与正确参考，不依赖真实项目源码。

2026-07-23 验证证据：Python 全量 `212 passed`；Electron/Node 语法、策略和静态界面测试全部通过；C# UIA 写入器编译结果为 `(True, None)`；真实启动日志确认三个快捷键均 `ok=true`，旧 Lab 默认关闭，结束烟测后没有残留的新 Electron 进程；1440×1000 演示页截图完成视觉检查。

仍需诚实保留的边界：本轮没有在真实 Codex/Claude/Gemini 外部输入框中进行人工最终点击，因此“跨所有 Agent GUI 均已兼容”尚未被证明；macOS 原生捕获、CLI/RPC 连接器和正式设置 Dashboard 仍属于后续里程碑。
