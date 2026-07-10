# Magic Pointer Open — 2026-07-07 视觉原型到深层能力交接汇报

> 工作目录：`D:\Desktop\Magic Pointer`
> GitHub：`https://github.com/Wang-auspicious/Magic-Pointer.git`
> 当前最后已推送提交：`8960991 Lower cursor upper vertex and boost glow pulse`
> 本文档生成时间：2026-07-07
> 本轮主题：从 Tk 原型切到 Electron overlay，重点打磨 Google/Gemini Magic Pointer 式交互外观，并记录下一阶段从“看图问答”走向“桌面对象/本地信息/执行”的方向。

---

## 1. 本轮用户核心反馈总结

用户明确不想要：

- 终端里手动启动 Python 程序。
- 小而不能缩放的 Tk 控制面板。
- 像普通 AI 聊天框一样的大窗口。
- 默认展示历史缩略图、手动 pin group 的笨重流程。
- 把 Magic Pointer 做成“截图聊天机器人”。
- 粗糙的蓝色矩形框、假对象圈、僵硬文本框。
- 原生系统小手/I-beam 光标叠在自绘指针上。
- 失败时把 HTML 错误页整页吐到结果框。

用户想要：

- 对标 Google / Gemini / DeepMind 的 Magic Pointer：轻、小、快、流畅、美观。
- 默认是 pointer + 语音/短指令，而不是大聊天框。
- 轨迹、发光、结果卡片都要局部、自然、贴着对象。
- 指针视觉要接近 Google demo：白色填充、蓝色描边、柔光、凹四边形，不是纸飞机。
- 选择对象不是“截图框选”，而是“鼠标扫/划/圈某个语义对象”。
- 结果框要可复制、可拖动，挡视线时能挪开。
- 历史记录不能污染当前任务；昨天的对象不应影响今天的问题。
- 后续重点要从外观进入真正的对象理解、本地信息连接、执行和写回。

---

## 2. 本轮已经完成的主要工作

### 2.1 从 Tk 主交互迁移到 Electron overlay

已新增/改造 Electron overlay 路径：

```text
Electron transparent overlay
  -> freehand sweep / circle gesture
  -> local command pill
  -> Python bridge capture + object registration + AI call
  -> local result card
```

关键文件：

```text
electron/main.js
electron/preload.js
electron/renderer/index.html
electron/renderer/overlay.js
electron/renderer/styles.css
scripts/electron_bridge.py
```

当前 Tk/Python 后端仍存在，但主视觉交互已经转向 Electron。Python 继续负责：

- 截图。
- 对象登记。
- TaskContext。
- OpenAI-compatible 视觉模型调用。

Electron 负责：

- 全屏透明 overlay。
- 鼠标指针与轨迹绘制。
- command pill。
- result card。
- 快捷键/鼠标晃动唤醒。

---

### 2.2 启动方式与后台进程

用户不接受终端启动，所以已改成 VBS/批处理启动。

当前入口：

```text
MagicPointer.vbs              双击启动隐藏后台 Electron overlay
stop_magic_pointer.bat        停止后台
stop_magic_pointer.ps1        实际停止逻辑
start_electron_overlay.bat    启动 Electron overlay
```

已做：

- `MagicPointer.vbs` 不需要终端。
- `start_electron_overlay.bat` 启动前会尝试停止旧实例。
- `electron/main.js` 写入 pidfile：`data/runtime/electron.pid`。
- `stop_magic_pointer.ps1` 优先根据 pidfile 停止当前 Magic Pointer。

注意：

- 如果用户说“改了没变化”，第一怀疑仍然是旧 Electron 进程没退出。
- 看 `data/runtime/electron.log` 是否有最新格式日志。
- 看 `data/runtime/electron.pid` 是否存在。

---

### 2.3 坐标与识别问题修复

曾经严重问题：用户扫 `MagicPointer.vbs` 文件名，模型却回答“新建按钮”。

根因：

- Electron renderer 给的是 CSS/DIP 坐标。
- Python `ImageGrab` 用的是物理像素坐标。
- 高 DPI 下没转换，导致后端截到更左上方区域。

已修：

- `electron/main.js` 传 `scaleFactor`。
- `electron/renderer/overlay.js` 传 `viewport.dpr`。
- `scripts/electron_bridge.py` 用 `_coord_scale()` 把 bbox 和 stroke points 转为物理像素。
- 加入 `capture_bbox`，把“选择 bbox”和“给模型看的上下文截图 bbox”分开。

现在语义：

```text
selection_bbox = 用户真实指向/划过的目标
capture_bbox   = 给模型看的更大上下文截图
```

这一点很重要：Magic Pointer 的 sweep/circle 不应该被当成普通截图框，而应该被当成“语义指针”。

---

### 2.4 后端截图上下文扩大

用户指出：圈文件名时，模型看不到全名/附近上下文。

已修：

- 后端不再只截用户 stroke 外接矩形。
- `_expand_capture_bbox()` 会围绕 selection_bbox 生成更大的上下文截图。
- 对象日志仍保存精确 selection_bbox。
- 模型输入使用 pointer-annotated image + raw crop。

当前仍有不足：

- 只靠 VLM/OCR 读屏幕文字，不能保证读到文件全名。
- 还没接 Windows UI Automation、本地文件系统信息、Explorer 选中项、DOM、OCR 缓存。
- 这就是下一阶段要解决的“不是只看截图，而是连接本地对象信息”。

---

### 2.5 结果框交互

已完成：

- 结果框可复制文字。
- 结果框可拖动，拖标题区域即可。
- Thinking 过程中也可拖动。
- 最终结果不会跳回原位置。
- 原生 I-beam / 小手光标已隐藏，只显示自绘 Magic Pointer cursor。

当前问题：

- 结果文本仍按纯文本显示，Markdown 没渲染。
- 所以模型输出 `**加粗**` 时会直接暴露星号。
- 下一步应在 renderer 中做安全 Markdown 渲染，至少支持：
  - bold
  - list
  - code span
  - line break
- 注意安全：不要直接 innerHTML 渲染模型输出，需 sanitize 或自己写极小 Markdown renderer。

---

### 2.6 输入问题框

已完成：

- 初始问题框从长条 input 改为较短 textarea。
- 宽度从约 420px 缩到约 305px。
- 长问题自动换行。
- Enter 提交。
- Shift+Enter 换行。
- 高度自动增长，最高约 76px。

用户偏好：

- command pill 不要像聊天输入框。
- 可以承载短语音转文字/短命令。
- 长问题能自动换行即可，不要默认变成大输入框。

---

### 2.7 轨迹与指针视觉

本轮大量迭代了指针外观。

#### 已放弃的错误方向

- 纸飞机形象。
- 带内部折线的箭头。
- 左侧奇怪凸起。
- 长尾。
- 中心假蓝圈。
- 过于明显的多层色带。

#### 当前方向

目标是 Google demo 中那种：

```text
白色填充
蓝色描边
蓝色柔光
凹四边形 cursor
头部指向左上
无内折线
无长尾
```

当前实现位置：

```text
electron/renderer/overlay.js -> drawPointer()
```

当前最近一次用户反馈：

- 指针截图中右侧上边顶点不对称。
- 用户用红色标注指出：右上顶点应往下移动到更接近中轴对称的位置。
- 最新已改：右上顶点从 `21.8,13.8` 下移到 `22.4,18.8`。
- 用户随后又提出：还需要 y 再下移几个像素，x 再右移几个像素。

**注意：最后这条尚未实现。**

下一次如果继续调外观，优先改这里：

```js
// electron/renderer/overlay.js drawPointer()
path.lineTo(22.4, 18.8);  // upper-right vertex
```

用户要求：

```text
y 再下移几个像素
x 再右移几个像素
```

建议下一步试：

```js
path.lineTo(24.0, 21.5);
path.quadraticCurveTo(26.2, 23.0, 22.5, 23.3);
path.lineTo(11.0, 21.2);
```

但要实际看截图再调。

---

### 2.8 呼吸发光

已完成：

- 指针边缘加呼吸式蓝色 glow。
- result card 边缘加呼吸式 glow。
- Thinking 状态有 spinner。

用户反馈：

- 早期版本呼吸太克制，看不出来。
- 回答框的呼吸不能像硬条带，要是模糊边界感。
- 最新版本呼吸感用户说“不错”。

当前实现：

```text
electron/renderer/overlay.js     pointer glow pulse
electron/renderer/styles.css     resultBreath keyframes
```

注意：

- 不要再用 `0 0 0 8px` 这种硬 spread 条带作为主要呼吸。
- 用多层 `box-shadow` blur 做模糊边界。
- pointer glow 可以明显一点，用户不想太克制。

---

### 2.9 Thinking 动画

已完成：

- result card 的 Thinking 状态加入 spinner。
- 避免用户觉得“卡住/很久没回应”。

位置：

```text
electron/renderer/overlay.js -> showResult(ok === null)
electron/renderer/styles.css -> .spinner, @keyframes spin
```

---

### 2.10 API 错误处理

用户遇到：

```text
AI 调用失败：HTTP 502
然后结果框显示整页 HTML Bad Gateway
```

已修：

- `app/ai_client.py` 5xx 会重试。
- 如果仍失败，降级为主截图 + 结构化上下文。
- 最终失败只显示短错误，不再把 HTML 页原样吐到 UI。
- `_plain_error_excerpt()` 会清理 HTML 标签。

解释：

- 502 不是用户圈太大。
- 通常是 OpenAI-compatible 网关/代理临时错误。
- 当前项目使用 `secrets/openai_base_url.txt` 中的兼容网关时更容易遇到。

---

## 3. 已读/参考的项目文档与指导文件

本次整理已阅读/参考：

```text
README.md
AGI_DISTANCE.md
HANDOFF.md
GEMINI_POINTER_FRAME_ANALYSIS.md
GEMINI_POINTER_STUDY.md
EXTERNAL_COMPONENTS.md
CHANGELOG.md
```

PDF 文件：

```text
magic pointer.pdf
```

状态：

- 文件存在，大小约 303 KB。
- 本轮尝试用 Python 提取，但本地没有 `PyPDF2`，提取失败。
- 本轮没有把 PDF 内容作为主要依据。
- 如果后续要纳入 PDF 内容，建议安装/加入轻量 PDF 文本提取工具，或直接把 PDF 转成 md/txt。

演示文件：

- `演示1.png` 到 `演示20.png/webm` 已在此前分析中形成 `GEMINI_POINTER_STUDY.md` 与 `GEMINI_POINTER_FRAME_ANALYSIS.md`。
- 关键结论是：不要做聊天框，要做 pointer-native overlay。

---

## 4. 当前项目与文档目标的完成情况

### 4.1 MVP0

已完成。

- 全局唤起。
- 框选/截图。
- AI 问答。
- 对象日志。

但主交互已逐渐从 Tk 迁移到 Electron。

---

### 4.2 ScreenContext

已完成基础版。

- 可枚举可见窗口。
- 可计算窗口与选区重叠。
- 可生成窗口对象上下文。

仍不足：

- 不能识别窗口内部 UI 元素。
- 不能读 Explorer 文件名、Word 文本、浏览器 DOM。
- 不能把屏幕像素和本地应用对象打通。

---

### 4.3 MVP1-alpha / beta / gamma / delta / epsilon

已部分完成并多次转向。

已完成：

- ObjectStore。
- THIS/THAT/GROUP 基础指代。
- TaskContextStore。
- 30 分钟 idle task rollover。
- 隐藏式 task context，而不是默认历史缩略图。
- DESTINATION 概念基础。
- command bar / pointer card 方向。
- voice fallback 曾接 Windows dictation 方案。

但当前 Electron overlay 版本还没有完整继承旧 Tk 版本中的所有按钮/快速动作 UI。

需要注意：

- 旧文档中有些功能是在 Tk `app/main.py` 中实现的，不一定已经完整迁移到 Electron overlay。
- Electron 是当前产品主方向，但 Python/Tk 中可能还有旧逻辑。

---

### 4.4 外部组件

已记录可参考项目：

```text
OmniParser       Python，UI screenshot -> structured UI elements
nut.js           TypeScript/Node，跨平台鼠标键盘自动化
whisper.cpp      C/C++，本地语音识别
UI-TARS Desktop  TypeScript/Electron 架构参考
screenpipe       Rust + TypeScript，本地屏幕/音频记忆参考
Microsoft UFO    Windows GUI agent 参考，尚未完整下载
```

当前实际接入：

- Electron overlay + Python bridge 已接。

尚未接入：

- OmniParser。
- nut.js 执行动作。
- whisper.cpp 本地语音。
- UIA/Accessibility。
- Browser DOM。
- Screenpipe 风格长期记忆。

---

## 5. 当前暴露的新问题

### 5.1 Markdown 未渲染

用户截图中可见 `**加粗**` 星号暴露。

应做：

- 在 `electron/renderer/overlay.js` 中对 answer 做轻量 Markdown 渲染。
- 最小支持：bold、列表、inline code、换行。
- 必须 sanitize，不能直接信任模型 HTML。

建议实现：

```text
escapeHtml(answer)
  -> replace **text** with <strong>text</strong>
  -> replace `code` with <code>code</code>
  -> list lines starting -
```

不要一开始引入大 Markdown 库，除非确实需要。

---

### 5.2 只看截图，没连本地信息

用户指出模型看不到文件全名，怀疑目前只是在截图 OCR。

判断：用户判断正确。

当前主要依据：

- screenshot crop。
- pointer annotated image。
- ScreenContext 顶层窗口信息。
- AI/VLM 视觉识别。

还没有：

- Windows Explorer 当前目录与选中项读取。
- UI Automation 文本树。
- 浏览器 DOM。
- Word/WPS 文档选区文本。
- OCR 缓存。
- 本地文件系统对象绑定。

这就是下一阶段最重要的“深层能力”。

---

### 5.3 文件对象识别不可靠

例子：用户圈一个文件行，模型可能答出类型但看不到完整名称。

未来正确做法：

```text
pointer stroke / bbox
  -> 先定位前台窗口类型
  -> 如果是 Explorer：读取当前文件夹、可见/选中文件、命中行
  -> 如果是 Browser：读取 DOM/选区/link/text
  -> 如果是 Word/WPS/PDF：读选中文本或 OCR 文本块
  -> 再把本地结构化对象 + 截图一起给模型
```

不要只靠 VLM。

---

### 5.4 仍未执行/写回

当前主要还是问答。

未实现：

- 自动写回目标输入框。
- 粘贴到 DESTINATION。
- 修改 Word/WPS 文本。
- 浏览器表单填写。
- 文件操作。
- 日历/地图/购物清单 action card。
- 执行后校验。

---

### 5.5 语音仍未成为真正默认

当前还没有完整内置语音流。

历史上尝试过 Windows dictation，但产品目标应是：

- 唤醒后默认 listening。
- 语音转文字出现在 pill 中。
- 用户可按 Enter/停顿/按钮执行。
- 没有语音时才键入。

可选方案：

- `whisper.cpp` 本地离线。
- 云 STT 临时方案。
- Windows dictation 作为 fallback。

---

## 6. 距离桌面 AGI 还差什么

按照 `AGI_DISTANCE.md` 的桌面 AGI 工作定义：

```text
理解当前屏幕与用户指向
  -> 把屏幕内容注册成对象
  -> 理解短指令和指代关系
  -> 制定多步计划
  -> 操作应用、网页、文件和剪贴板
  -> 校验结果
  -> 在失败时解释原因并请求确认
```

当前完成度：

### 已经接近的部分

- 用户可用指针/sweep 表达 THIS。
- 有本地对象日志。
- 有 task/session scoped context。
- 有 Electron overlay 视觉层。
- 有 VLM 问答闭环。
- 有初步 pointer-native UI。

### 仍缺的关键层

1. **本地对象连接层**
   - Explorer 文件对象。
   - UIA 控件树。
   - 浏览器 DOM。
   - OCR 文本块。
   - PDF/Word/WPS 文本。

2. **对象类型与能力层**
   - 文件、网页、按钮、输入框、文本段、表格、图片、公式、视频帧等类型。
   - 每种对象的可用动作：解释、复制、改写、移动、添加、比较、写回。

3. **语音/意图层**
   - 默认语音 listening。
   - 短命令转动作，不是长 prompt。
   - 自动建议 chips。

4. **执行层**
   - clipboard-first paste。
   - nut.js 鼠标键盘。
   - UIA/DOM 原生写入。
   - 文件/网页/应用动作。

5. **校验层**
   - 写入后截图/DOM/UIA 校验。
   - 失败回滚/解释。
   - 执行前确认和权限分级。

6. **记忆/session 层**
   - 当前 task OK，但没有可视化 task browser。
   - 没有长期本地活动记忆。
   - 没有 screenpipe 类检索。

7. **产品化层**
   - 系统托盘。
   - 设置页。
   - API/model 配置 UI。
   - 权限与隐私提示。
   - 安装包。
   - Windows/macOS/Linux 差异处理。

---

## 7. 下一阶段建议：从外观进入“对象 grounding + 本地信息”

用户明确说下一轮要做更深入的，不仅仅是外观。

建议下一阶段不要再优先调光效，除非非常小修。应进入：

```text
MVP2-alpha: Local object grounding for selected screen objects
```

优先级建议：

### P0：Markdown result rendering

小但必要，用户已经看到问题。

- 修 `**bold**`、列表、inline code。
- 保持可复制。

### P1：Explorer 文件对象 grounding

因为用户反复用文件管理器测试。

目标：当用户扫/圈 Explorer 文件行时，不只看截图，而是返回：

```json
{
  "app": "Explorer",
  "folder": "D:\\Desktop\\Magic Pointer",
  "hit_file": "Shaping the future of AI interaction by reimagining the mouse pointer — Google DeepMind.html",
  "type": "Microsoft Edge HTML Document",
  "size": "184 KB"
}
```

可能实现路线：

- Windows UI Automation 读取 Explorer ListView/Grid。
- 或用当前窗口标题 + 当前目录推断 + 截图 y 坐标匹配文件列表。
- 先做 Windows-only Explorer adapter，不要一开始泛化所有应用。

### P2：OCR fallback

不要求用户安装系统 OCR。

可选：

- Windows.Media.Ocr（Windows 自带 OCR API，但 Python 调用有复杂度）。
- PaddleOCR / EasyOCR 可选依赖，不默认安装。
- Tesseract 不适合作为默认依赖。
- OmniParser 可做 UI element detection，不等价 OCR，但可作为结构化屏幕解析。

原则：

- 没有 OCR 时产品仍能用 VLM。
- 有 OCR/UIA/DOM 时结果更稳。
- 不要要求普通用户手动安装 OCR 才能用。

### P3：Browser DOM / selected text

如果当前窗口是浏览器/Edge：

- 读页面标题、URL、选中文本。
- 后续可做 extension 或 DevTools Protocol。
- 不要只靠截图识别网页内容。

### P4：Write-back primitive

先做最安全的：

```text
生成文本 -> 用户确认 -> 复制到剪贴板 / 粘贴到当前输入框
```

再做 UIA/DOM 直接写入。

---

## 8. 用户偏好与踩坑记录

必须记住：

1. 用户非常反感“我明明让你学 Google，你却做成聊天框”。
2. 用户更看重交互感/流动感，而不是堆功能面板。
3. 用户接受阶段性不完美，但不能误解问题、不能解释错方向。
4. 当用户用微信截图给你看时，那只是给 assistant 的说明图，不是工具内部截图。
5. 不要把用户红色标注当成 Magic Pointer 工具产生的 overlay。
6. 不要再说“是不是太大传不上去”这种猜测，要看日志/产物。
7. 用户喜欢明确、直接、立刻修，不喜欢长篇辩解。
8. 用户要的是面向普通用户的产品，不是必须终端/开发者操作的脚本。
9. 用户希望不买 Googlebook/Chromebook 的人也能体验 Magic Pointer。
10. 历史对象不要默认可见，不要污染当前任务。
11. 语音应是默认理想交互，文本只是 fallback。
12. 外观上：
    - 不要纸飞机。
    - 不要长尾。
    - 不要内部折线。
    - 指针应接近 Google demo 的凹四边形。
    - 蓝色边缘/轨迹/结果框可以有明显呼吸式柔光，不要太克制。
    - 结果框呼吸不要硬条带，要模糊边界。
13. 输入框：
    - 不要太长。
    - 长问题自动换行。
14. 结果框：
    - 可复制。
    - 可拖动。
    - Markdown 要渲染。

---

## 9. 当前代码状态与最近提交

最近已推送提交：

```text
8960991 Lower cursor upper vertex and boost glow pulse
5651035 Refine cursor symmetry and wrap command input
203db42 Tighten cursor shape and strengthen breathing glow
00a1a17 Add breathing glow and thinking spinner
70db9db Replace pointer with Google-style concave cursor
426fda9 Try mirrored clockwise pointer variant
20aeb73 Retry gateway failures and orient pointer upper-left
79f3854 Hide native cursors and refine pointer shape
13475bf Make result card draggable and smooth pointer rendering
3ac4877 Add pidfile based overlay stop
db36011 Broaden pointer vision crop and restart stale overlay
6a44e26 Fix DPI coordinate mapping and duplicate overlay submit
```

当前写本文档前 `git status` 是 clean；写完本文档后会出现本 md 文件未提交。

---

## 10. 新对话推荐开场提示词

可直接复制：

```text
我们继续做 D:\Desktop\Magic Pointer。请先阅读 HANDOFF_20260707_VISUAL_TO_AGI.md、AGI_DISTANCE.md、GEMINI_POINTER_STUDY.md、GEMINI_POINTER_FRAME_ANALYSIS.md、EXTERNAL_COMPONENTS.md。当前状态：Electron overlay 已作为主交互层；指针/轨迹/结果卡片已初步接近 Google Magic Pointer 外观；后端通过 scripts/electron_bridge.py 接 Python AI/object/task context。下一阶段不要继续只调外观，重点做 MVP2-alpha：本地对象 grounding。先修结果框 Markdown 渲染，然后实现 Explorer 文件对象识别：用户扫/圈文件行时，结合本地文件系统/UIA/窗口信息返回完整文件名、类型、路径，而不是只靠截图 OCR。请先检查代码和测试，给出计划后开始实现。
```

---

## 11. 最后提醒

用户最后指出的外观微调尚未做：

```text
当前指针右上顶点还要 y 再下移几个像素，x 再右移几个像素。
```

但用户随后要求“这一步先别动”，转而写交接报告。因此新对话若不是继续外观，应先不要改指针，优先做 deeper grounding。
