# Google Magic Pointer 与开源 UI grounding 调研

访问日期：2026-07-29。本文只把可直接回到原始发布者的页面、原始论文、官方 GitHub/Hugging Face 页面作为证据；搜索摘要只用于发现，未作为结论依据。

## 结论先行

Google 官方已经把 **Magic Pointer** 用作 Googlebook 上的产品功能名称；Google DeepMind 同时把其研究/演示原型称为 **AI-enabled pointer**。前者不是一个已宣布可在 Windows/macOS 通用安装的系统级产品，后者是实验环境与 AI Studio 演示。因此目前不能诚实地承诺“系统级 Windows/macOS 应用与 Google 1:1”，只能对齐已经公开的交互原则与已展示流程。

P0 不应从视觉模型或全自动代理开始。应先做：原生系统指针唤醒、可审计的对象冻结、UIA/AX/DOM 优先 grounding、物理像素坐标不漂移、明确的预览/确认、动作后的结构化回读。OmniParser/UI-TARS 应是视觉兜底或离线评测候选，不是写入动作的唯一证据。

## 1. Google 官方事实与名称消歧

| 项目 | 一手证据与可以下的结论 | 不可推出的结论 |
| --- | --- | --- |
| 正式名称 | Google 的 Googlebook 发布文明确写 **“Magic Pointer on Googlebook”**，并称其与 Google DeepMind 团队共同构建。它说明该功能由 Gemini 在指针处给出上下文建议。来源：[Googlebook 发布](https://blog.google/products-and-platforms/platforms/android/meet-googlebook/)。 | 不能把任何第三方“AI pointer”、LG 遥控器的 Magic Pointer、或研究论文中的同名术语等同为 Google 产品。 |
| 研究原型名称 | DeepMind 发布使用 **“AI-enabled pointer”**、称其为 experimental demos/prototype；它说明用 Gemini 驱动的指针可结合屏幕上下文与语音。来源：[DeepMind 原始发布](https://deepmind.google/blog/ai-pointer/)，[官方视频](https://www.youtube.com/watch?v=pZNzfQLgGsA)。 | “AI-enabled pointer”不是 Googlebook 产品名的替代，也不等于有公开 SDK。 |
| 载体与预览 | 官方已公开的载体分三层：Googlebook（称“稍后推出”）、Gemini in Chrome（指向网页局部询问 Gemini）、Google AI Studio 的两个实验演示（图像编辑、地图找地点）。来源：[DeepMind 原始发布](https://deepmind.google/blog/ai-pointer/)、[Gemini in Chrome 官方页](https://gemini.google/overview/gemini-in-chrome/)。 | Chrome 的页面没有把此入口命名为 Magic Pointer；其官方激活方式仍可为工具栏 Gemini 图标或用户设置的快捷键。不能把 Chrome 的控制/隐私语义外推到 Googlebook。 |
| 产品状态 | 2026-05-12 的 Googleblog 是“sneak peek”，称设备将在当年秋季有更多信息；DeepMind 的措辞是 “will soon roll out Magic Pointer in Googlebook”。来源：[Googlebook 发布](https://blog.google/products-and-platforms/platforms/android/meet-googlebook/)、[DeepMind 原始发布](https://deepmind.google/blog/ai-pointer/)。 | 不能宣称已有公开、稳定、跨平台实现或可复现 API。 |

### 已证实的交互时序

以下是能从官方原文/官方视频直接支持的状态，而不是逆向推断的实现。

1. **待机 → 唤醒：** Googlebook 的产品描述是“wiggle your cursor”，随后指针以 Gemini “come alive”；DeepMind 的视频把重点称为同时理解指向内容、语音与屏幕。
2. **指向/选择 → grounded context：** DeepMind 说系统平滑捕获指针周围的视觉和语义上下文，原型可识别 word、paragraph、image part、code block；视频字幕还说明 hover 时可得到背后的数据，并由多个窗口共同即时构造 prompt。来源：[DeepMind 原始发布](https://deepmind.google/blog/ai-pointer/)、[官方视频](https://www.youtube.com/watch?v=pZNzfQLgGsA)。
3. **指代/多目标 → 命令：** 原型明确采用 “this / that / here” 等指代；官方展示过选两个图片（客厅与沙发）做联合可视化、选若干商品比较，以及视频中“两个食材加这个到购物单”。这支持 **object set**，而非仅单点 click。来源：[Googlebook 发布](https://blog.google/products-and-platforms/platforms/android/meet-googlebook/)、[DeepMind 原始发布](https://deepmind.google/blog/ai-pointer/)、[官方视频](https://www.youtube.com/watch?v=pZNzfQLgGsA)。
4. **Gemini 建议/执行 → 结果：** 已展示例子包括对日期建会、路线、图像生成，以及视频里的 “Done”/“I've updated the draft”。这是任务结果反馈的证据，但不是安全确认协议的证据。来源：[Googlebook 发布](https://blog.google/products-and-platforms/platforms/android/meet-googlebook/)、[官方视频](https://www.youtube.com/watch?v=pZNzfQLgGsA)。

### 必须明确标为未知的 1:1 细节

Google 的公开文本和可访问的官方视频字幕均**没有**规定下列内部 UI/阈值；实现这些项只能作为 Magic Pointer 的本项目设计，不应声称来自 Google：

- `wiggle` 的采样频率、距离/速度阈值、误触防抖、超时和多显示器切换规则；
- 目标框的来源（DOM/UIA/视觉）、框样式、置信度阈值、与鼠标“sweep”路径的语义；
- 是否存在固定的气泡布局、候选气泡何时出现/消失、语音录音状态；
- 多目标追加/撤销手势、命令编辑、写入动作是否一定二次确认；
- 行动后视觉回读、失败文案、撤销和审计机制。

官方视频是概念演示，DeepMind 还明确标注部分序列被缩短；不能从视频帧推导性能 SLA 或完整时序。Chrome 官方页反而明确强调只在用户选择激活时协助，这可以作为“不可惊扰”的产品原则，不能代替 Googlebook 的未公开细节。来源：[官方视频](https://www.youtube.com/watch?v=pZNzfQLgGsA)、[Gemini in Chrome 官方页](https://gemini.google/overview/gemini-in-chrome/)。

## 2. 可复用开源与平台技术清单

“维护活跃”是 2026-07-29 对默认分支 `pushed_at` 的快照，不是长期承诺；许可证以仓库/模型卡当前声明为准，集成前仍须逐文件和依赖 SBOM 复核。

| 领域 / 项目 | 许可证、活跃度、平台、语言 | 可复用模块 | 不能直接拿来之处 / 风险 |
| --- | --- | --- | --- |
| [Microsoft OmniParser](https://github.com/microsoft/OmniParser) + [官方 HF 模型卡](https://huggingface.co/microsoft/OmniParser-v2.0) | 仓库页当前标为 **CC-BY-4.0**；GitHub API 快照 pushed 2026-07-20，主要 Notebook/Python。HF 卡主标签为 MIT，但同页又明确 icon detector 为 **AGPL**、caption 为 MIT；仓库 README 还说明历史 detector 许可证不同。 | 截图 → interactable region + icon caption 的 parser；可把其输出变成视觉候选框和可解释候选清单。官方模型卡还给出 V2 的检测/描述两模型划分。 | 许可证声明彼此不一致且组件不同，**不得**把整个权重/代码当作 MIT；先做法务清单。它是视觉解析器，非系统级坐标、权限、确认或读回框架；模型卡要求人类判断，误检不能直接驱动写操作。 |
| [ByteDance UI-TARS](https://github.com/bytedance/UI-TARS) + [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | 主仓库 **Apache-2.0**，GitHub API pushed 2026-01-27，Python；Desktop 仓库也标 **Apache-2.0**，含 TypeScript monorepo，页面有 2025 年更新。 | `GROUNDING` prompt、动作结构解析、坐标归一化/反归一化、桌面动作空间（click/drag/type/scroll）和其公开坐标可视化说明；可用于离线候选排序和对比评测。 | 模型输出是概率性行动建议；README 自己要求按图像宽高后处理坐标。不能绕过本项目的目标租约、权限、确认和回读；远程 computer/browser operator 也不应纳入可信执行面。HF 页当次读取被 429 限流，故不记录未核实的模型卡许可证。 |
| [OS-Atlas 原始论文](https://arxiv.org/abs/2410.23218) | 论文公开；论文说明有跨 Windows/macOS/Linux/Android/Web 的数据合成工具与 13M+ GUI elements。 | 把 UIA/AX/DOM 产出的结构化元素与截图、指代表达、坐标组成训练/评测样本的思路；论文特别展示 Windows 用 pywinauto、macOS 用 ApplicationServices、Web 用 HTML 可见元素。 | 论文和训练语料不是生产 SDK；样本/权重的逐项许可、隐私与分发边界需另验。不要把论文主张的基准成绩当作真实用户可靠性。 |
| [OSWorld](https://github.com/xlang-ai/OSWorld) | **Apache-2.0**；GitHub API pushed 2026-07-28；Python。官方仓库含 `desktop_env`、评测、虚拟化/容器指南，并在 2025-07 发布 OSWorld-Verified。 | 在隔离 VM 中跑端到端回归：截图、步骤、成功判定、日志与失败重放；可用来检验视觉兜底是否损害 UIA/DOM 优先策略。 | 基准/VM 基础设施，不是可嵌入的系统 overlay；安装需 VMware/VirtualBox/Docker 等，官方也提示异常中断会残留容器。不要在真实用户桌面上把 benchmark runner 当执行器。 |
| [Microsoft UFO](https://github.com/microsoft/UFO) | **MIT**；GitHub API pushed 2026-07-08；Python。README 将 UFO² 定位为 Windows 单机、混合 GUI/API，UFO³ 是更复杂的跨设备 DAG。 | 任务分解、应用/设备能力编排、进度和结果反馈的架构参考；可用于研究任务/receipt 而非取代底层动作。 | 它是完整 agent 体系，超出“快速、可预测指针”的 P0；不得把 LLM planner 赋予 unrestricted OS 控制权，也不能直接合并其凭据、网络或工具面。 |
| [FlaUI](https://github.com/FlaUI/FlaUI) | **MIT**；GitHub API pushed 2026-06-17；Windows、C#/.NET、UIA2/UIA3 wrapper。 | Windows UI Automation 元素树、bounding rectangle、AutomationId/Name、Pattern、事件的稳健封装；适合 C# sidecar 或概念映射。 | Windows-only；只覆盖暴露 accessibility provider 的应用。必须处理权限/UIPI、失效元素和窗口变动，不能以 Name 匹配作为不可变目标身份。 |
| [pywinauto](https://github.com/pywinauto/pywinauto) | **BSD-3-Clause**；GitHub API pushed 2026-05-23；Windows、Python，Win32/UIA backend。 | 若现有 Python bridge 继续，直接用于 UIA 读取、控件模式、窗口定位与动作后的属性读回；OS-Atlas 论文也将其用于 Windows A11y tree 采集。 | Windows-only，和 FlaUI 一样受 provider 完整度/权限边界限制；不要依赖坐标 click 代替 pattern invocation，也不能无条件执行模型生成的 pywinauto 代码。 |
| [AXSwift](https://github.com/tmandry/AXSwift) 与 [Apple AXUIElement API](https://developer.apple.com/documentation/applicationservices/axuielement) | AXSwift 为 **MIT**，Swift/macOS；API 快照最近 push 2023-07-25（非活跃，不宜作为唯一依赖）。AXUIElement 是 Apple 平台 API，无开源许可证。 | macOS 可访问性树、role/title/value/position/size、target identity 与事件 readback 的适配层。 | macOS 需用户授予 Accessibility/Automation 权限；AXSwift 推送较旧，P0 宜以 Apple API + 小封装为主。跨 app 的元素不一定暴露完整语义，沙盒/受保护应用另需测试。 |
| [Playwright](https://github.com/microsoft/playwright) 与 [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) | Playwright **Apache-2.0**；GitHub API pushed 2026-07-28；TypeScript（亦有多语言 bindings）。CDP 是 Chrome 的协议规范。 | browser adapter：通过 page/locator/DOM/ARIA box 得到高精度元素身份与 bounding box；执行后可用 locator assertion、DOM/text/URL/readback 验证。 | 仅浏览器上下文，不能宣称系统级；连接现有浏览器必须先给用户可见授权与 target-scoped session，不能暴露任意远程调试端口或跨 profile 数据。 |
| [python-mss](https://github.com/BoboTiG/python-mss) | **MIT**；GitHub API pushed 2026-07-27；Python、Windows/macOS/Linux。 | 多 monitor 的快速截图抽象，可作为视觉 fallback 的 capture provider。 | 只提供像素抓取，不给 UI 语义、DPI policy、overlay 或安全执行；截图内容可能敏感，必须受 capture policy/本地留存/上传开关约束。 |
| [Electron](https://github.com/electron/electron) | **MIT**；GitHub API pushed 2026-07-29；Windows/macOS/Linux，C++/Node/TypeScript。 | 透明无框 overlay、stage/preview、跨平台窗口生命周期。现项目已采用它，适合继续复用而非另造 UI host。 | 透明窗口和点击穿透不是安全模型；必须隔离 preload/IPC、避免 overlay 吞掉鼠标，且不把 renderer 当可信动作执行方。 |
| [WinAppDriver](https://github.com/microsoft/WinAppDriver) | **MIT**；GitHub API pushed 2025-04-14；Windows/C#。 | WebDriver 风格的 Windows UIA 自动化、黑盒回归测试。 | 维护频率明显低于 UIA wrappers；适合独立测试机，不建议作为新的运行时核心或用于任意用户桌面写入。 |

### 平台原语（应优先于视觉模型）

- **Windows UIA：** Microsoft 的 UI Automation 将桌面暴露为 `AutomationElement` 树，元素有属性、control pattern 和可订阅事件；它可同时提供结构化定位和执行后 readback。来源：[Microsoft UI Automation Overview](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview)。
- **macOS AX：** 以 `AXUIElement`/ApplicationServices 建立同类的 accessibility adapter；权限与元素可见性必须纳入 preflight。来源：[Apple AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement)。
- **Browser DOM/CDP：** DOM/ARIA/locator 是网页最佳 grounding source，像素模型只在 canvas、远程桌面、无可访问性树等场景补位。协议面可参考 [CDP](https://chromedevtools.github.io/devtools-protocol/)，执行面选 Playwright。
- **DPI/多屏/物理像素：** Windows 应采用 Per-Monitor V2；微软明确说明其可看到每屏 raw pixels，且在 DPI 改变时收到 `WM_DPICHANGED`。官方也特别要求混合 DPI、多显示器、远程桌面测试。来源：[Microsoft High-DPI 指南](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)。

## 3. 建议的 grounding、坐标与回读合同

### Source-of-truth 优先级

```text
Browser DOM/CDP locator  ┐
Windows UIA / macOS AX   ├─> GroundedObject + evidence + physicalRect
应用专属 API/COM         │
截图 OCR/OmniParser      ┘          ↓
                              preview / explicit confirmation
                                      ↓
                             narrowly-scoped action adapter
                                      ↓
                      DOM/UIA/AX/API + screenshot readback receipt
```

每个 `GroundedObject` 应至少有：`source_kind`、稳定 identity（UIA runtime-id / DOM locator / AX path / app ID）、`window_id`、`monitor_id`、capture timestamp、physical-pixel `rect`、原始 screenshot size、semantic label、confidence、可执行 pattern、以及证据摘要。视觉识别生成的候选应标 `vision_only`，禁止无确认地进行不可逆写入。

### 坐标与多屏 P0 合同

1. 进程/overlay 采用 Windows PMv2；全链路以 virtual desktop 的 **physical pixels** 表示鼠标点与矩形。
2. 每次 freeze 同时记录 monitor bounds、该 monitor DPI、窗口 rect、capture image width/height 和时间戳；图像坐标只通过显式 affine transform 映射到 desktop coordinates，绝不默认截图就是主屏 96 DPI。
3. `WM_DPICHANGED`、display topology change、前台窗口/目标元素失效、超过短 lease 的 action 都使 selection 过期，必须重新 ground。
4. overlay 可视觉透明且 click-through；确认卡临时接收输入时需明确切换并在关闭后恢复，不可让透明 UI 吃掉原应用点击。
5. 在 100/125/150/200% 和混合 DPI、多显示器、负坐标 monitor、断接 dock、RDP/睡眠恢复下做 Golden tests。上述 PMv2/多屏要求有 Microsoft 直接依据：[High-DPI 指南](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)。

### 交互状态机：对齐原则而非伪称 Google UI

```text
Idle → Invoke(wiggle/hotkey) → CandidateHighlight → ObjectSet
     → Command(voice/text) → PlanPreview → Confirm/Cancel
     → Execute → ReadbackVerified | ReadbackMismatch | Failed
     → Receipt/Undo
```

- `CandidateHighlight`：先显示目标及 source/confidence；视觉候选只可作为建议。
- `ObjectSet`：支持 `this/that/here`、单目标/多目标的添加、移除、当前锚点，正好覆盖 Google 已展示的自然指代与双图选择，但具体手势是本项目设计。
- `PlanPreview`：写入、外发、覆盖、跨应用操作必须展示目标、影响、数据路径、可否撤销。
- `ReadbackVerified`：优先比对 UIA/AX/DOM/API 的预期后态；无结构源时至少重截图并把差异/不确定性写入 receipt，不可把“无异常”报成成功。

## 4. Build / Buy / Adapt 决策矩阵

| 能力 | Build（自建） | Buy（采购/托管） | Adapt（复用） | P0 决策 |
| --- | --- | --- | --- | --- |
| 系统唤醒、wiggle、selection lease、透明 overlay | 必须自建：它决定不误触、状态可见与隐私边界。 | 无可信的跨 OS 成品可替代。 | 复用现有 Electron shell，仅把 native input/窗口职责明确分层。 | **Build**。 |
| 结构化目标定位 | 自建统一 `GroundedObject`/证据/过期合同。 | 无；不把 agent SaaS 当 data source。 | Windows UIA + FlaUI/pywinauto；macOS AX；网页 DOM/CDP/Playwright。 | **Adapt + Build thin layer**。 |
| 视觉 UI parsing | 自建 fallback policy、候选 UI、数据处理与评测集。 | 若用托管 VLM，须单独审批数据出境、成本、可用性。 | OmniParser/OS-Atlas/UI-TARS 的模型或解析器仅在许可证、权重来源、离线性能审核后试验。 | **Adapt in a feature flag**，非核心。 |
| 动作执行 | 自建 scope token、preview、confirm、target lease、receipt、undo。 | 不采购“全桌面代理”来绕过安全链。 | UIA/AX patterns、Playwright locator、应用 API/COM；UI-TARS 只产生候选 plan。 | **Build policy + Adapt deterministic adapters**。 |
| 动作回读与回归 | 自建 receipt schema、before/after evidence、失败态。 | VM/CI 可按需采购。 | UIA event/DOM assertion/Playwright trace，OSWorld 隔离回归，WinAppDriver 仅测试。 | **Adapt test infra + Build receipt**。 |

## 5. P0 技术建议（Windows first，macOS adapter-ready）

1. **冻结“所指对象”而不是冻结截图。** 首次可交付物是 `selection -> GroundedObject -> preview -> receipt` 的稳定链路；先覆盖浏览器、Win32/WPF/Office 等已有结构源。
2. **把视觉模型放在最后一层。** UIA/AX/DOM 命中时不要再把全屏传给视觉模型；只有没有结构源时才本地截图、OCR/OmniParser 候选，并标明不确定性。
3. **只对可验证动作自动执行。** 读取、可撤销且结构化的 local action 可低摩擦；跨 app 写入、发送、覆盖、删除与 vision-only click 必经预览+确认。成功条件是回读到期望状态，不是输入事件已发出。
4. **建立坐标实验矩阵后再调模型。** 先用 PMv2 physical-pixel canonical space，记录 transform，再测混合 DPI/RDP；坐标错误会让任何高分 grounding 模型在真实桌面失效。
5. **把“Google 对标”拆成可验收项。** 对齐其公开原则：flow（不切出当前应用）、show-and-tell（对象+语义）、this/that（多目标指代）、pixels-to-entities（可行动实体）。目标框动画、sweep 阈值和气泡外观属于本项目可用性实验，不能写成 Google 规格。
6. **macOS 不做假对等承诺。** 先定义 AX adapter 与权限/测试合同；在真实 AX 覆盖率、多屏坐标、screen recording permission、sandbox 应用案例通过前，Windows 和 macOS capability matrix 应分别显示。

## 6. 证据缺口与访问限制

- Google 未公开 Magic Pointer 的 API、源代码、协议、视觉 target-box/sweep/bubble 详细状态、手势阈值、确认/撤销/readback 机制或性能数据；这些是 1:1 对标的主要证据缺口。
- AI Studio 两个官方演示链接在本次未登录访问时重定向到 Google 登录，无法用作可复现交互细节证据；已只记录 DeepMind 页面明确写出的演示存在性。
- Hugging Face 的 UI-TARS 模型页在本次请求返回 429，故未把未经读取的模型卡许可证或限制写入结论；其 GitHub 主仓库与 Desktop 仓库已可核验。
- GitHub CLI 未认证，改用公开 GitHub API 的仓库元数据作“维护活跃”快照；不使用 star 数量作为技术可用性的判断。
- 已按 Agent Reach 要求先执行 `agent-reach doctor --json`。其结果显示 X/Twitter `active_backend: null`、缺少显式凭证；因此**没有访问或引用 X 帖子/讨论**，也不以搜索引擎的 X 摘要作为证据。此限制不影响 Google、GitHub、Hugging Face、论文和官方平台文档的结论。
- web-access skill 声明的本地 `check-deps.sh` 在该 skill 目录不存在；已按其网页/视频/代码原始来源路由继续采集并记录该工具缺口，未对用户浏览器做登录或写操作。

## 一手来源索引

- Google DeepMind：<https://deepmind.google/blog/ai-pointer/>
- Googleblog Googlebook：<https://blog.google/products-and-platforms/platforms/android/meet-googlebook/>
- Google DeepMind 官方视频：<https://www.youtube.com/watch?v=pZNzfQLgGsA>
- Gemini in Chrome：<https://gemini.google/overview/gemini-in-chrome/>
- OmniParser：<https://github.com/microsoft/OmniParser>；模型卡：<https://huggingface.co/microsoft/OmniParser-v2.0>
- UI-TARS：<https://github.com/bytedance/UI-TARS>；Desktop：<https://github.com/bytedance/UI-TARS-desktop>；论文：<https://arxiv.org/abs/2501.12326>
- OS-Atlas：<https://arxiv.org/abs/2410.23218>
- OSWorld：<https://github.com/xlang-ai/OSWorld>
- UFO：<https://github.com/microsoft/UFO>
- FlaUI：<https://github.com/FlaUI/FlaUI>；pywinauto：<https://github.com/pywinauto/pywinauto>；AXSwift：<https://github.com/tmandry/AXSwift>
- Playwright：<https://github.com/microsoft/playwright>；CDP：<https://chromedevtools.github.io/devtools-protocol/>
- python-mss：<https://github.com/BoboTiG/python-mss>；Electron：<https://github.com/electron/electron>；WinAppDriver：<https://github.com/microsoft/WinAppDriver>
- Microsoft UIA：<https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview>
- Microsoft High-DPI：<https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows>
- Apple AXUIElement：<https://developer.apple.com/documentation/applicationservices/axuielement>
