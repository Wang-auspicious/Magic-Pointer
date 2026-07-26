# Magic Pointer 交接：2026-07-10

本文是当前长对话结束前的事实交接。它优先记录已经验证的事实、用户最新纠偏、工作区真实状态、失败方向和下一版硬性验收标准。

## 0. 先读这一页

当前结论不是“产品已经做得差不多”，而是：

- 底层的真实选区读取、会话绑定、安全写回、撤销和 PDF 选区验真已经取得实质进展。
- 2026-07-10 晚上最后尝试的 V4 初始界面仍然是摘要卡/气泡，只是缩小了，用户明确否决。
- 当前真正可提交、可依赖的产品基线是提交 `3f0299a`。
- 当前工作区的 V4 六个文件有未提交修改。不要提交这组产品形态。
- 下一版必须从本地 `演示1.png` 和 `演示7.webm` 的对象旁单行控件重新出发，不能继续润色现有卡片。

## 1. 最高约束

### 1.1 绝不删除任何文件

这是用户最高优先级要求，覆盖项目源文件、运行时产物、图片视频、PDF、克隆项目、压缩包、日志、测试证据和交接文档。

禁止使用会删除文件的命令或流程，包括但不限于：

- `git clean`
- `git reset --hard`
- 删除未跟踪文件
- 清理 `data/runtime`
- 删除旧截图或视频帧
- 删除克隆项目或压缩包
- 运行会删除 PID 文件的停止脚本

不要运行 `stop_magic_pointer.ps1`。该脚本第 11 行会执行：

```powershell
Remove-Item -Path $PidPath -Force
```

如果必须重启 Electron，应先确认 PID，再只结束进程，不删除任何文件：

```powershell
$pidValue = [int](Get-Content .\data\runtime\electron.pid -Raw).Trim()
Stop-Process -Id $pidValue -Force
npm run overlay
```

### 1.2 不要暂存测试 PDF

`2307.00583v1.pdf` 当前是未跟踪文件，是本轮真实 Edge PDF 验证素材。

- 不要删除。
- 不要移动。
- 不要重命名。
- 不要 `git add`。
- 不要提交。

### 1.3 宿主应用拥有原生鼠标

浏览器、PDF、Word、WPS 等宿主应用必须继续拥有：

- 点击
- 拖选
- 滚动
- 文本高亮
- 原生焦点

Magic Pointer 的 overlay 只做轻量观察反馈，不能重新接管鼠标或要求用户在第二套截屏框选界面里重复选择。

### 1.4 不确定就拒绝，不能猜

读取顺序应保持：

```text
宿主原生语义
  -> 截图验证原生语义是否可信
  -> 必要时使用本地文档字符框恢复
  -> 无法证明时 fail closed
```

截图不是默认真相。OCR/VLM 不能在原生选区不一致时擅自补字、猜目标或猜上下文。

## 2. Git 与进程真实状态

记录时间：2026-07-10 晚间，时区 Asia/Shanghai。

分支：

```text
main
```

上游关系：

```text
main...origin/main [ahead 9]
```

最新提交：

```text
3f0299a Verify PDF selections and avoid target overlap
```

当前 Electron：

```text
PID: 372
进程: electron.exe
启动时间: 2026-07-10 22:14:37
路径: D:\Desktop\Magic Pointer\node_modules\electron\dist\electron.exe
```

当前运行进程加载的是 V4 早期的约 116 DIP 初始高度版本。源码随后被改成 128 DIP，但没有再次重启，因此“当前屏幕运行状态”和“当前工作区源码”不完全一致。

当前未提交修改：

```text
M electron/main.js
M electron/renderer/panel.css
M electron/renderer/panel.html
M electron/renderer/panel.js
M tests/panel_position_test.js
M tests/panel_static_test.js
?? 2307.00583v1.pdf
?? HANDOFF_2026-07-10_MAGIC_POINTER.md
```

在写本文之前，V4 diff 规模是：

```text
6 files changed, 112 insertions(+), 24 deletions(-)
```

## 3. 2026-07-10 今天真正完成的内容

今天有四个已提交版本。它们主要完成底层可信链路，不代表前端形态已经合格。

### 3.1 `72caaf4`：Observer-first 与精确撤销

提交时间：2026-07-10 17:26:34 +08:00

完成：

- 保留真实系统鼠标，overlay 改为 click-through 的短时 observer aura。
- 热键后只读取最前台宿主应用，不再越过不支持的前台窗口误抓后台 Word。
- 修复 Word/WPS 选区读取和 WPS 折叠选区误判。
- Word 写回继续使用 typed proposal、显式确认、文档/range/hash 校验。
- 写入后验证真实 range 内容。
- 撤销优先恢复记录 range；range 偏移时使用文本与左右上下文共同定位。
- 多个同样锚点时拒绝恢复，不再写回全文第一个匹配。
- 修复面板乱码、安全 Markdown 和损坏代理环境。
- 把原来的大面板缩为局部工具，但当时仍然没有解决“一行式对象操作”的产品形态。

### 3.2 `777ed6a`：冻结对象会话

提交时间：2026-07-10 19:11:25 +08:00

完成：

- 用户按热键时先冻结前台 HWND、应用、文档、range、文本和哈希。
- 每次命令、模型请求和 action proposal 都绑定短 TTL session token。
- 新会话出现后，旧模型结果不能覆盖新对象。
- 写回前再次校验文档、窗口、range 和内容哈希。
- suggestion/action 点击继续使用同一冻结会话，不重新猜目标。
- 增加 selection session、stale result、action provenance 等测试。

这部分非常重要，因为它定义了 `THIS` 是真实对象会话，不是界面里写出来的一个标签。

### 3.3 `fcd52fb`：浏览器与 PDF 原生文本选区

提交时间：2026-07-10 20:43:10 +08:00

完成：

- 新增 Windows UI Automation 文本选区读取。
- 使用 `TextPattern.GetSelection()` 读取 Edge HTML、Edge PDF 和兼容应用。
- 不发送 `Ctrl+C`。
- 不修改剪贴板。
- 校验 UIA 元素进程与冻结的前景 HWND/PID。
- 返回文本、哈希、range 数、选区矩形、源元素和只读能力。
- 前台窗口不支持、选区为空、身份不匹配或超时时全部关闭能力。

真实机器结果：

- Edge HTML：49 字符，完整快照约 602 ms。
- Edge PDF：43 字符，完整快照约 643 ms。
- warm Electron PDF 热键：约 805 ms 捕获，约 827 ms 显示。
- cold Electron PDF：约 1.1 秒。
- 验证过程没有使用剪贴板。

### 3.4 `3f0299a`：修复 PDF 错字与面板遮挡

提交时间：2026-07-10 22:01:41 +08:00

这是今天最关键的正确性修复。

#### 原始问题

用户在 Edge PDF 中真实选中：

```text
A multi-task learning framework for carotid
```

UI Automation 却返回：

```text
multi-task learning framework for carotid p
```

错误同时发生在两端：

- 丢失真实选区首字母 `A`
- 错误吸入下一行首字母 `p`

因此模型只得到残缺文本，错误回答“上下文不足”。

#### 修复内容

新增：

```text
app/adapters/pdf_selection_recovery.py
```

该模块：

- 从截图读取 Edge 真实高亮边界。
- 检测并丢弃下一行虚假的 `p` 高亮矩形。
- 使用本地 PDF 和 PyMuPDF 字符框恢复精确连续文本。
- 从 PDF 页面提供已验证的完整标题上下文：

```text
A multi-task learning framework for carotid plaque segmentation and classification from ultrasound images
```

- 对前景 HWND、文件、页码、页面矩形、缩放、旋转、文本连续性、高亮矩形和 UIA 语义一致性进行验证。
- 任一关键证据不一致时拒绝恢复，不猜。

同时完成：

- UIA probe 进入 DPI-aware 模式。
- 增加页面祖先页码、工具栏页码、页面矩形和选区容器元数据。
- 使用真实选区矩形定位面板。
- 支持多显示器、负坐标和 DPI 换算。
- 选择不覆盖选区的候选位置，并记录 overlap。
- 没有放松写回确认、session token、范围或哈希校验。

#### 验证证据

自动测试：

```text
python -m pytest -q
63 passed

npm test
panel position test ok
selection session test ok
overlay static test ok
panel static test ok
```

2026-07-10 在写本文前重新运行，结果仍然是：

```text
63 passed in 8.24s
npm test 全部通过
```

真实桌面验证：

- Windows 200% 缩放。
- Edge 原生 PDF 选区。
- 精确恢复首字母 `A`。
- 不再吸入下一行 `p`。
- 面板与真实选区零重叠。
- 剪贴板 sequence 始终为 `7368`，没有借用剪贴板。
- 真实模型调用能够获得完整论文标题上下文，不再因为残缺选区声称“无法确定”。

关键截图：

```text
data/runtime/pdf_exact_selection_v3_final_20260710_215858.png
data/runtime/pdf_exact_selection_v3_panel_20260710_214202.png
data/runtime/pdf_exact_selection_v3_answer_20260710_214307.png
```

## 4. 前序五个提交的底座

这五个提交早于 2026-07-10，但解释了当前代码为什么已经有较多基础设施。

```text
3008a45 Add pointer grounding and safe action scaffold
837b421 Improve Explorer copy path fallback
0e7a4df Add local file content understanding
b9a1388 Add Windows app adapter harness
59818bd Add guarded Word writeback and undo actions
```

已经形成的能力：

- 平台中立 grounding/action schema。
- Explorer 文件对象 grounding 和路径读取 fallback。
- 本地 PDF/HTML/TXT/MD/DOCX/ZIP 内容读取。
- UFO 风格的 adapter registry、观察层与动作层分离。
- Word/Excel 原生上下文适配器。
- typed action proposal。
- 权限策略。
- Word 安全替换、执行后校验、审计历史和只撤销 Magic Pointer 自己的写入。

这些都是有价值的底层，但用户看见的交互入口仍然没有达到 Google Magic Pointer 的形态和便利性。

## 5. 本地演示素材复核

本轮不是只读旧 Markdown，而是重新查看了原始/生成视觉文件：

```text
演示1.png
demo1_ascii.png
演示7.webm
data/runtime/demo_video_frames/演示7_sheet.jpg
data/runtime/frame_trajectory_analysis/demo7_trajectory_overlay.jpg
```

为了更清楚看演示 7，另外从原始 `演示7.webm` 每秒取帧生成了：

```text
data/runtime/demo_video_frames/演示7_handoff_review_20260710.jpg
```

该文件位于被忽略的 runtime 目录，没有进入 Git 状态。不要删除。

### 5.1 演示 1 的可靠结论

`演示1.png` 中：

- 被选中的大图是主视觉对象，有明确发光边界。
- Gemini 入口贴在对象右侧/右下附近，不占据独立工作区。
- 自由命令入口是一条横向输入带，包含对象缩略图、短提示和发送入口。
- 动作文字是直接可执行意图，如 `Visualize Together`、`Compare items`、`Synthesize`。
- 没有展示文件名、应用名、字数、选区类型、长摘录或“Magic Pointer”产品标题。
- 对象始终是第一视觉层级，工具只是对象的附属层。

演示 1 中动作建议的具体排列存在空间适配，不应机械复制。用户最新明确口径高于任何模糊解读：

> 初始形态必须是一行式对象操作条，不能再做成气泡或卡片。

### 5.2 演示 7 的可靠结论

演示 7 比演示 1 更直接地证明了单行控件形态。

逐帧可以清楚看到：

- 用户命中食谱中的具体列表项，而不是打开一个全局聊天窗口。
- 指针附近可能先出现短时圆形感知/聆听状态。
- 真正承载意图的是旁边的一条单行圆角控件。
- 可见短语包括 `Add this`、`and this`、`here`、`Double that`。
- 控件贴着当前列表项/指针移动，不固定在屏幕某个角落。
- 用户切换对象时，同一个轻量形态被复用。
- 动作执行后，购物清单出现可见变化，单行控件随后消失。

它不是摘要卡，因为没有标题、正文、元数据和多行信息。

它不是迷你聊天窗，因为没有历史消息、输入区、发送区和滚动内容。

它也不是“三个快捷按钮的气泡”，因为每个时刻只突出当前短意图，核心是：

```text
命中具体对象
  -> 对象旁出现一个短意图
  -> 指向目标或确认动作
  -> 宿主任务出现结果
  -> 控件消失
```

演示 7 不能证明的内容：

- 触发一定是语音、鼠标或某个固定手势。
- 圆形状态一定代表什么。
- 所有短语都是模型建议还是语音转写。
- `Double that` 的完整内部执行机制。

这些不能猜，也不能把演示动画的速度当作真实性能指标。

## 6. V4 为什么被用户否决

V4 的内部目标是“动作优先的小气泡”，修改了：

```text
electron/main.js
electron/renderer/panel.css
electron/renderer/panel.html
electron/renderer/panel.js
tests/panel_position_test.js
tests/panel_static_test.js
```

做过的改动：

- 初始隐藏命令输入框。
- 把固定高度从 188 DIP 降到早期 116 DIP，源码后改为 128 DIP。
- 初始显示 `THIS`、对象摘要、三个建议动作和一个键盘展开按钮。
- 使用 `showInactive()`，不抢 Edge 焦点。
- 点击键盘图标后才展开完整命令输入。
- suggestion 和输入仍绑定同一冻结 session。
- 增加 128 DIP 位置和静态测试。

### 6.1 有技术价值、下一版可以保留

- `showInactive()` 和不抢宿主焦点。
- 冻结 selection session 和 stale token 防护。
- 真实选区矩形驱动的位置选择。
- 多显示器、DPI、工作区边界和零重叠算法。
- 输入作为可选层，而不是默认夺焦。
- 动作点击后继续绑定原对象，不重新猜目标。

### 6.2 产品形态必须放弃

当前初始界面同时显示：

- `Magic Pointer` 标题
- 关闭按钮
- `THIS · PDF 选区`
- 字数
- 文件名
- 应用名
- 选区摘录
- `解释`
- `总结`
- `翻译`
- 键盘展开按钮

这在认知上就是一张摘要卡。把高度从 188 降到 116/128 并没有改变它的交互类别。

必须放弃：

- `bubble` 作为产品概念和代码命名中心。
- 初始展示产品标题。
- 初始展示文件/应用/字数/对象类型元数据。
- 初始重复展示用户已经高亮的完整摘录。
- 同时摆三个通用动作按钮。
- 让同一控件向下扩成 380 DIP 的结果/聊天面板。
- 固定 420 px 宽的大矩形。
- 把“解释/总结/翻译”当成有上下文价值的核心体验。
- 认为“输入框默认隐藏”就等于完成了 Google 式对象交互。

当前 V4 截图：

```text
data/runtime/pdf_action_bubble_v4_20260710_221520.png
data/runtime/pdf_action_bubble_v4_expanded_20260710_221646.png
```

这些截图应作为反例保留，不要删除。

### 6.3 为什么自动测试通过仍然是失败版本

当前 V4 工作区在 2026-07-10 晚间仍通过：

```text
63 Python tests
npm test 全部测试
```

但现有测试主要证明：

- 代码语法正确。
- session/token 没有断。
- 位置算法不覆盖选区。
- HTML 中存在预期控件。

它们没有证明：

- 控件是一行。
- 控件贴着具体对象而不是形成大卡片。
- 用户一眼知道下一步。
- 动作执行后直接推进宿主任务。
- 初始界面没有元数据噪音。
- 用户完成任务比直接打字更快。

所以“测试绿”不能再被当作“产品方向正确”。

## 7. 下一版的产品定义

下一版不要叫 action bubble。建议内部名称：

```text
inline action rail
```

初始层级：

```text
真实宿主对象/选区
  -> 短时对象高亮或 observer
  -> 对象边缘的一条单行动作 rail
```

### 7.1 初始态硬性要求

- 只有一行。
- 建议初始高度控制在 36-48 DIP，不允许 100+ DIP。
- 宽度由短命令内容决定，不固定为 420。
- 贴近具体对象或选区边缘，保持小间距。
- 不覆盖真实对象、选区文本、复选框或目标输入区。
- 不显示 `Magic Pointer` 标题。
- 不显示 `THIS` 标签。
- 不显示应用名、文件名、字数和选区摘要。
- 不显示三个并列通用动作。
- 不显示长结果。
- 不抢宿主焦点。
- `Esc` 或用户继续宿主操作时可以立即消失。

### 7.2 单行动作内容

优先显示一个当前意图，而不是动作菜单：

```text
解释这一段
翻译成中文
把这个加到那里
总结到右侧文档
```

它可以来自：

- 用户短语音转写。
- 用户在单行输入中的短命令。
- 置信度足够高的一个上下文建议。

如果系统不能确定唯一合适动作，不应一次堆出三个按钮。可以保持一条自由命令入口，或通过一个熟悉的更多菜单提供次级选择。

### 7.3 结果层级

单行动作条不能自己膨胀成聊天卡。

- 写入型动作：在宿主应用/目标对象中直接出现结果，并校验。
- 短确认：在原 rail 中短时显示完成/失败状态，然后消失。
- 长解释：用户执行后才进入独立的次级阅读层；不能污染初始对象操作条。
- 所有写入继续使用 typed proposal、确认、session 和本地校验。

### 7.4 下一版视觉与交互验收

自动化：

- 静态测试禁止初始 DOM 出现产品标题、元数据摘要和多行动作卡。
- 初始高度必须小于等于 48 DIP。
- 宽度必须按内容约束并有最大值，长文字保持单行截断。
- 位置测试覆盖选区上、下、左、右、屏幕边缘、负坐标和 100%/200% DPI。
- 新旧 session、stale response、writeback 校验测试继续全部通过。

真实桌面：

- Edge PDF 100% 和 200% 缩放各测一次。
- 原生高亮必须一直保留。
- Edge 前景 HWND 不变。
- 剪贴板 sequence 不变。
- rail 与选区零重叠。
- 触发后只出现一行，不出现摘要卡。
- 切换到另一选区时，旧 rail 消失，新 rail 重新锚定。
- 执行动作后 rail 短时反馈并消失。
- 截图与 `演示1.png`、`演示7_handoff_review_20260710.jpg` 并排评审。

人工体验：

- 用户不读说明就能知道当前在操作哪个对象。
- 用户不需要先理解 `THIS`、session、adapter 等内部概念。
- 一步动作的完成成本必须明显低于打开聊天窗口并重新描述上下文。
- 在共享空间不能强制语音；语音可选，键盘始终可用。

## 8. 下一位模型的建议执行顺序

1. 先读本文，不要先改代码。
2. 打开 `演示1.png` 和 `演示7.webm`，再看高分辨率联系表。
3. 查看当前六个未提交文件，区分可保留机制与必须替换的视觉结构。
4. 不提交当前 V4。
5. 在原文件内重做 initial panel 为 `inline action rail`，不要删除文件。
6. 保留 `showInactive()`、session、placement 和安全链路。
7. 增加“一行、无元数据、无标题、无多按钮卡”的防回归测试。
8. 重启时只结束 Electron 进程，不运行删除 PID 的脚本。
9. 真实 Edge PDF 100%/200% 体验并截图。
10. 开多 agent，从视觉、普通用户完成时间、安全、测试四个角度独立否决或通过。
11. 只有视觉和真实使用都过关后才提交 Git。

## 9. 还没有完成的关键能力

离真正产品还差：

- 稳定、自然的一行式对象操作入口。
- 低误触 wiggle/point 激活。
- 连续 THIS/THAT/HERE 多对象交互。
- 目标对象与写入目的地的统一会话模型。
- 浏览器 DOM 和输入框的安全读写。
- PDF 以外更多应用的统一原生对象能力。
- WPS 写回隔离验证。
- 微信、普通文本框等常用应用的可靠选区/输入适配。
- 可选而低摩擦的语音转写。
- 写入型任务的用户可见确认、进度、失败恢复。
- 长结果的非聊天式次级阅读形态。
- 安装包、托盘、设置、模型配置、权限与隐私说明。
- 普通用户任务完成时间、误触率、失败率和重试率数据。

## 10. 60 秒 CEO 汇报底稿

今天真正做成的是底层可信链路：Magic Pointer 现在能在不碰剪贴板、不抢宿主鼠标的前提下，冻结 Word、网页和 Edge PDF 的真实选区，把命令绑定到短时对象会话；Word 写回有确认、范围和哈希校验，也能精确撤销自己的修改。今晚还修掉了一个很难的 PDF 选区错误：系统原来会漏掉首字母 `A`、误读下一行 `p`，现在会用真实高亮和本地 PDF 字符框验真，63 个 Python 测试和 Electron 测试全部通过。

但用户可见产品没有完成。最后一版只是把原来的卡片压矮，仍然塞了标题、元数据、摘录和三个按钮，本质还是气泡，不是 Google 演示里贴着对象、只承载当前短意图的一行操作条。这一版不应提交。

距离成品最大的差距不再是“能不能读到选区”，而是“普通人能不能不思考界面就完成动作”。下一步必须把入口重做成对象边缘的单行 rail，动作后直接推进宿主任务并消失，再补连续对象、目标写入、可选语音和真实用户完成时间测试。底座已经比昨天可靠很多，但前台体验仍处在原型期，不能对外称为成品。

## 11. 一句最终判断

今天完成了可信的“看见和绑定对象”，但没有完成好用的“对象旁立即行动”。下一轮必须停止缩小卡片，真正改成交互类别。
