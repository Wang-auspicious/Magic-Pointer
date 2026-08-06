# Magic Pointer 全面验收与技术决策（Codex，2026-08-05）

## 1. 最终结论

当前版本不能宣称“任意 Windows 软件里，随手一划就能稳定理解完整对象”。结构化应用的基础链路已明显改善；自绘应用、微信 4.x、Qt/Flutter 仍缺“首笔手势 + 像素候选框”的统一生产链路。

本轮最重要的结论不是 OCR 能不能复述一句话，而是：

> 用户的笔画只表达意图范围；系统必须在同一冻结帧里寻找更完整的语义候选。高置信时静默吸附，歧义时让人选，证据残缺时拒绝补猜。模型只接收问题所需的最小证据包。

正确技术边界是：

> C# 常驻 Windows 感知宿主（HWND、UIA/MSAA/IA2、WGC/D3D、全局输入） + Python 感知融合/模型编排 + Electron 交互界面。

不建议全量改写为 C#。C# 能改善热路径、系统互操作和框选反馈，但不能让不暴露 UIA 节点的应用凭空出现结构。

## 2. 用户刚才真实失败：原因与修复

### 现场证据

2026-08-05 18:51 的真实会话中，用户连续选了两处内容并输入 3 个字的命令。日志与对象快照显示：

- 两次手势均成功冻结了正确 HWND：`396802`，窗口标题为“为朋友电脑配置 codex 和 ccswitch”。
- 两个登记对象却都变成了 `16×16`：`[474,723,16,16]`、`[872,489,16,16]`。
- 两张 `320×180` 有界截图确实含有文字，但只剩残片，例如“两个地方仍需外网”“包进文件夹了，所”。
- 命令桥先等待约 6 秒做能力分类；该请求超时后把全局模型健康错误写成 `unreachable`，后续真正回答被断路器直接跳过，于是出现：

  `AI 调用失败：连不上模型端点。已跳过模型调用，用本地能力尽力回答。`

端点本身当时并没有断。修复后真实探针持续为 HTTP 200、状态 `ok`。

### 已修复的七个串联 bug

1. **请求超时误判端点断线。** `ReadTimeout` 现在只结束本次请求，不再污染全局健康状态；连接失败与单次预算耗尽分开记录。
2. **水平/垂直划线坍缩成点。** 原代码要求手势 bbox 的宽、高都大于 0；完全水平线高度为 0，于是退成 16×16 pointer anchor。现在零维度扩成真实笔画 corridor，仍保持 gesture-region 语义。
3. **短问题先传全部工具 schema。** `对比下 / 解释下 / 有啥区别 / 哪个好` 直接进入回答；`总结下`走明确总结能力，不再先跑巨型 L1 分类。
4. **对象数硬编码为 1。** 路由现在读取冻结 episode 中的真实对象数，多对象能力不再丢掉 THAT/THESE。
5. **会话版本字段读错。** 持久化会话写 `schemaVersion: 1`，回答桥只认 `version: 1`，导致 THAT 即使已 OCR 也没有进入模型上下文；现已兼容两种字段。
6. **直接回答再次退回工具模式。** 已判为 `model_answer` 的“对比下”不再二次开放所有 Recipe，避免变成“创建比较产物并确认”的奇怪流程。
7. **HTTP 200 但无可见正文。** 当前 DeepSeek 模型默认可能把短输出预算全用于 thinking。Anthropic Messages 请求现显式关闭 thinking；若仍无正文，按空响应失败处理，不再返回假成功。

### 防止“乱回答”

修到能调用模型后，同一残缺数据曾得到一段自行补全语义的回答，这仍是错误。现新增：

- OCR 框触碰有界截图边缘时标记 `ocr_edge_clipped`。
- 多对象比较只要存在边缘截断，就列出 THIS/THAT 的已读残片，并明确“不能可靠比较、不会用残句补猜”。
- 同一真实 payload 重放由原来的假断线，变为约 **0.9 秒**本地诚实回答；不调用模型、不创建产物、不要求确认。

完整对象仍可进入模型推理；残缺对象不会再被当成完整事实。

## 3. 与最新规划文档的对齐

已重新读取并按以下顺序校准验收：

- `docs/planning/HANDOFF_20260805.md`
- `docs/planning/PROGRESS_20260805.md`
- `docs/planning/MASTER_PLAN_20260804.md`
- 用户提供的交接全文附件

最新定位是“取 → 问改 → 交”的通用屏幕衔接层，重点是复杂提问、比较、诊断与后续动作，而不是展示 OCR 玩具。

原生日历、购物清单只保留为自动化回归项，不再作为本轮产品验收主线，也不构成“体验已完成”的证据。

## 4. Everywhere 验收与源码/程序集分析

### 录屏结论

- 优点：Edge 等结构化界面上的矩形非常快、非常准，框有类别，反馈接近即时。
- 严重问题：用户只圈一个投票小框时，Everywhere 仍把大范围页面交给模型；录屏中出现约 12 万 token、混入多条推文和广告、等待近一分钟。它证明“框得准”不等于“上下文策略正确”。

### 本机实现证据

`D:\Everywhere` 没有项目源码，只有托管程序集。以下来自类型、方法和 IL 元数据，不冒充官方说明：

- `AutomationVisualElementImpl`：`CUIAutomation8`、`ElementFromPoint`、`ElementFromWindowHandle`、`TextPattern`。
- `ScreenVisualElementImpl`：无结构时的屏幕元素实现。
- `Direct3D11ScreenCapture`：`Windows.Graphics.Capture`、`Direct3D11CaptureFramePool`、`D3D11CreateDevice`。
- Picker：`FindWindowBehindOwnOverlays`、`WindowFromPoint`，主动绕开自己的 overlay。
- `IVisualElement`：`BoundingRectangle`、`NativeWindowHandle`、`GetText/GetSelectionText`、`CaptureAsync`。

它快的主要原因是常驻原生热路径、真实 UIA rectangle、WGC/D3D 帧和缓存，不是“C# 天生识别更准”。

## 5. 已做出的可见 C# 分类框选原型

文件：

- `scripts/native_element_picker_demo.cs`
- `scripts/start_native_element_picker_demo.ps1`

启动：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start_native_element_picker_demo.ps1
```

行为：

- 青色 `TEXT`、紫色 `ACTION`、橙色 `ITEM`、粉色 `MEDIA`、黄色 `CONTAINER`。
- 标签显示类型、名称、探测延迟。
- 四边空心、点击穿透；45ms 轮询并做背压。
- `Ctrl+Alt+F9` 暂停/继续，`Ctrl+Alt+Shift+F9` 退出。
- 20 次桌面探测：中位约 5.1ms、P95 约 101.2ms、最大 172ms。

这是供人直接体验 UIA 热路径的独立原型，不是生产集成。微信等自绘窗口中它仍只能看到容器；不能据此宣称像素候选已完成。

## 6. 本轮其他已修问题

### 感知与坐标

- 激活时提交的 HWND 固化，避免本产品窗口抢前台后串窗。
- 高 DPI 下统一物理屏幕坐标、Stage 原点、缩放与命中区域。
- `PrintWindow` 纯灰死帧按通道变化判空并回退合成截图。
- 结构层只返回应用名/容器名时不再冒充真实选区。
- Terminal 使用 `TextPattern.RangeFromPoint → Line`，避免整缓冲区污染。
- OCR 常驻 worker 串行访问、复用模型和画布、合并碎片，避免并发初始化和崩溃。
- 多笔、Escape、临时表面点击穿透和热键冲突已修；产品 `Ctrl+Alt+P` 恢复注册。

### 浏览器复杂问题

- 细线 DOM 采样由边缘采样改为单元格中心采样，可命中完整状态元素。
- 区域探测保留并脱敏 Network/Log 证据。
- 一次完整适配器硬失败后不再沿笔画重复超时。
- `ERR_UNSAFE_PORT / CONNECTION_REFUSED / NAME_NOT_RESOLVED / TIMED_OUT` 有基于真实浏览器证据的本地诊断，不必先等模型。

### 模型后端

- 已切换为用户指定的 Anthropic-compatible DeepSeek 后端。
- 文本、tool calling、健康探针均实际 HTTP 调用通过。
- 当前模型的图片请求能到端点，但模型明确表示无法读取图片；不能把“请求成功”写成“视觉可用”。
- 截图上传设置当前为关闭；本轮真实双对象回答使用本地 OCR 后的结构化文本，没有上传截图。
- 密钥只存在 gitignored 的 `secrets/`，未写入代码、报告或 Git diff。

## 7. 手划线与精准框的正确融合

必须同时保留：

- `literalStroke`：用户真实画出的线/圈，是范围底线。
- `semanticCandidate`：系统认为线指向的文本行、按钮、卡片或图片。

首笔落下后，在同一冻结帧执行：

1. DOM → UIA → MSAA/IA2 获取结构候选。
2. 结构不足时，只在目标 HWND 和笔画邻域用 WGC 帧构建 OCR 行框、图标框、视觉分组框。
3. 按笔画相交、圈选覆盖、语义点距离、层级具体度、provider 置信度评分；整窗容器强惩罚。
4. 高分且 margin 足够：保留手线视觉，后台静默吸附到完整框。
5. margin 低：显示 2–3 个柔和 ghost 框供一次点击选择。
6. 没有可靠候选：保持字面笔画，只分析局部证据；绝不扩大成整窗。

上下文随问题变化：

- 复制/OCR：只给对象。
- 解释：对象 + 最小父级标题。
- 复杂错误：对象 + 所属卡片/表单 + 相关 Network/Console 证据。
- 比较：只给两个完整对象及其最小标签。
- 用户明确问整个页面时，才允许 viewport 级上下文。

## 8. GitHub 路线调研结论

- Text Grab：`FromPoint`、祖先候选、`TextPattern.RangeFromPoint`、可见文本矩形、区域采样与 overlay 去重；最接近结构层需求。
- Accessibility Insights：由 `BoundingRectangle` 驱动空心点击穿透高亮。
- Microsoft UFO：UIA COM `FindAllBuildCache` 一次缓存 ControlType/Name/Rectangle，并限制元素量；证明性能核心是批量缓存和常驻 COM。
- FlaUI：可作为 UIA2/UIA3 兼容封装参考。
- OmniParser：OCR 文本框与图标框合并、重叠去重，适合离线像素候选层。
- Win32CaptureSample：WGC free-threaded frame pool、首帧等待、D3D texture copy，适合常驻帧源。
- WPF `StrokeCollection.HitTest`：可借鉴路径/lasso/percentage 几何，但只能判断墨迹命中，不能替代语义目标识别。

用户要求的 Luna 子智能体在当前运行时不可用；没有擅自用 Terra/Sol 替代。调研由主智能体通过本地 GitHub/联网检索完成。

## 9. 仍未完成及精确修法

### P0

1. **首笔手势与元素 picker 仍是两条链。** `element_probe_bridge.py` 目前只在 Stage 打开后再次点击时使用。应让常驻 native host 在第一次手势提交时返回 `candidates / selected / score / margin / provider`，接入 `selection_snapshot_bridge.py`。
2. **微信/Qt/Flutter 缺生产像素候选服务。** 建 C# WGC 常驻帧环；先问 MSAA/IA2，再在笔画邻域跑 OCR 行框 + 轻量 detector。缓存键至少含 `hwnd + frameHash + dpi + clientRect`。
3. **当前模型无视觉输入。** 模型 profile 必须持久化 `visionInput=no`；配置独立视觉模型后才启用视觉路由。未知能力不能默认为 yes。
4. **浏览器生产链不能依赖 remote-debugging-port。** 应做扩展 + Native Messaging，返回当前 tab/frame 的受限 DOM 和相关网络证据；无扩展时诚实回退 UIA/像素。

### P1

5. C# 原型需变成受生命周期管理的常驻服务：named pipe、provider hang 隔离、多屏/DPI 测试、窗口移动/销毁事件、tray 与安装包集成。
6. 模型调用仍非流式。当前文本实测约 3–6 秒；应流式显示首 token，并给整个交互设置 8–12 秒 wall-clock，超时立即显示本地证据。
7. OCR worker 忙时目前可能返回空；应排队一个有界请求或返回明确 `worker_busy` 并在 UI 显示“正在读取”，不能把忙碌等同于“屏幕没有文字”。
8. 真实麦克风、中文口音和噪声环境仍需硬件验收；自动化通过不能替代真人语音体验。

### P2

9. 选中文字动作条、clicky 指针陪伴、token 热力图尚未完成。
10. 诊断页应直接展示每次会话的 HWND、候选层、OCR 框数/截断、路由 tier、模型首 token/总耗时和降级原因；不能继续依赖人工翻 `electron.log`。

## 10. 最终验证

- Python 全量：`1026 passed in 220.89s`。
- Node：`132 tests`，64 个源测试文件全部通过。
- ESLint：0 error / 0 warning。
- `python -m compileall -q app scripts`：通过。
- `git diff --check`：通过；仅 Windows LF→CRLF 提示。
- DeepSeek 文本：HTTP 200，关闭 thinking 后返回“端点正常”，约 3.3 秒。
- 模型健康：`ok / HTTP 200 / circuit_open=false`。
- 真实双对象残片重放：命中 `clipped_multi_object_guard`，桥内约 0.3 秒、进程总计约 0.9 秒，无模型调用、无乱猜。

## 11. 最终判断

这轮已修掉刚才“假断线 + 丢 THAT + 错路由 + 空正文 + 残句乱猜”的完整故障链，也把水平线坍缩为 16×16 的直接代码原因修掉。最新自动化全绿。

尚不能宣布最终体验完成：真正决定产品是否“像 Everywhere 一样快、又比它更懂范围”的工作，是把当前独立的 C# 元素框、现有手划线和像素候选图合并到第一次手势里。下一轮应只做这条 P0 主线，不再用简单 OCR、日历或清单用例代替真人复杂场景验收。
