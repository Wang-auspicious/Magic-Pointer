# 跨应用连续圈选与微信媒体获取：初版技术决策

> 日期：2026-08-02
> 范围：研究与产品决策，不包含实现改动
> 结论可信度标记：**事实**来自官方文档或源码；**推断**是基于事实给 Magic Pointer 的设计建议；**未验证**必须在当前 Windows / 微信版本上实测。

## 摘要：初版应该怎么做

用户不应每跨一个应用就关闭圈选、重新晃动唤醒。正确的抽象是把一次任务拆成两个不同生命周期：

1. **Context Session（上下文会话）**：晃动一次后开始，可跨微信、浏览器、文件夹等多个应用持续存在，保存每一笔选中的上下文。
2. **Stroke Capture（单笔捕获）**：只在用户明确要圈选的那一笔期间拦截左键；一抬手就尽快释放鼠标给底层应用。

推荐的初版交互是：

- 第一次晃动后直接进入 `BURST_DRAW`，用户可以连续画三段，不用在三段之间重新唤醒。
- 每次抬手后保留约 **0.8–1.2 秒**的连续画笔窗口。在窗口内再次按下仍然算同一批圈选，适配“演示七”中连续三段 `@@@` 的感觉。
- 连续画笔窗口超时，或检测到前台应用变化后，进入 `NAVIGATE`。笔迹和已选上下文可以保留/变淡，但 overlay 必须完全穿透；用户可以正常点击任务栏、Alt+Tab、滚动或打开浏览器。
- 跨应用继续增加一笔时，不要求重新完整晃动。初版优先采用一个很轻且明确的动作，例如 **`Space + 左拖`**；有鼠标侧键时优先支持“按住侧键 + 拖动”。也可实验 ppInk 式的 Alt+Tab 自动切换 pointer/drawing mode。
- `Enter`、语音结束命令或气泡中的确认键统一提交；`Esc` 取消当前会话，撤销键只删除最近一项。

这里最关键的底层缺口不是 OCR，也不是多笔数据结构，而是：

> **同一个全局鼠标 hook 必须能按状态选择性地“吞掉”或“放行”输入；可视 overlay 则应长期保持 click-through / no-activate。**

如果坚持同时满足“无按键、无再次晃动、普通点击能操作应用、下一次普通左拖又自动变成圈选”，系统只能先吞掉输入，再延迟判断它是点击、拖拽还是圈选，并尝试回放。这条路会破坏双击、拖文件、文本选择、鼠标 capture 和按住反馈，不能作为默认方案。

对于微信图片/文件，Magic Pointer 不应承诺“总能找到微信原始缓存路径”。正确语义是：

- 能通过公开 UI 或剪贴板拿到文件时，把内容**落盘到 Magic Pointer 自己的 capture/media 目录**，再向 Agent 提供稳定的绝对路径；
- 拿不到文件时，使用圈选发生当时保存的原分辨率截图裁剪；
- 裁剪图太小、被遮挡或视觉模型无法可靠判断时，明确返回 `media_unresolved`，只描述失败原因，不能编造原图内容或文件地址。

## “演示七”三段线为什么可以顺畅

没有该产品的源码，不能断言演示中的具体实现。单从行为看，最可能是以下两种机制之一：

- 一次按住某个 PTT / 修饰键期间，所有左键笔画都属于同一个捕获会话；或
- 第一笔之后开启一个短暂的 multi-stroke grace period，抬手不会立刻结束，下一次按下继续追加笔画。

Magic Pointer 已有后者的雏形：`electron/renderer/overlay.js` 支持多笔，运行设置中的 `multi_stroke_submit_ms` 默认是 10000 ms，最多可收集多条 stroke。当前不顺畅的根因是 `exclusive_overlay` 把全屏 Electron 窗口变成可接收鼠标，导致用户不能同时操作其他应用；而 `pass_through` 虽能看到鼠标轨迹，却会让底层应用真的收到拖拽、文字选择或文件拖动。

因此，不需要推翻已有多笔链。需要补的是中间层：

```text
永久穿透的可视 overlay
          +
后台运动/晃动检测（只观察）
          +
WH_MOUSE_LL 全局 hook（仅 STROKE_CAPTURE 状态吞鼠标）
          +
Context Session 聚合每一笔的截图、UIA、OCR、媒体与应用元数据
```

## 当前 Magic Pointer 的准确缺口

### 已有能力

- `electron/renderer/overlay.js`：已有多笔收集、stroke 渲染和延迟提交。
- `electron/gesture_runtime_settings.js`：已有 `multi_stroke_submit_ms` 与 `exclusive_overlay` / `pass_through` 两种模式。
- `electron/pass_through_gesture.js`：已有穿透状态下的轨迹观察。
- `electron/main.js`：已有 `setIgnoreMouseEvents(true/false)` 切换。
- `scripts/pointer_input_state.ps1`：已有鼠标状态读取和 wheel 的低级 hook 基础。

### 缺失能力

- 没有一个统一的 `WH_MOUSE_LL` 状态机，能在 `STROKE_CAPTURE` 返回非零吞事件、在 `NAVIGATE` 立即 `CallNextHookEx` 放行。
- 没有把“一次上下文会话”和“一笔输入捕获”分开。
- 穿透观察模式无法阻止底层应用发生副作用；独占模式又阻止跨应用导航。
- 当前最终截图不足以保证旧应用被新窗口遮住后仍可还原上下文。应当对**每一笔**保存当时的截图和前台窗口元数据，而不是只在会话末尾截一张全屏。
- 微信媒体还缺少“UIA 命中 → 文件物化 → 剪贴板格式探测 → 截图兜底”的解析器和明确状态。

## Windows 输入与 overlay：可依赖的事实

| 机制 | 官方保证 | 对本项目的含义 |
|---|---|---|
| `WH_MOUSE_LL` / `LowLevelMouseProc` | 回调返回非零可以阻止消息到达目标窗口；安装线程必须有消息循环；回调超时可能被系统静默移除。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc)) | 用它做“当前这一笔是否吞鼠标”的唯一裁决器。hook 线程只入队，截图、OCR、渲染全部异步。需要健康检查/自动重装。 |
| Raw Input | 应用注册后可从 `WM_INPUT` 获取原始设备输入，并支持后台输入。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input)) | 适合晃动检测、高频运动和设备区分；它不是拦截器，不能替代 `WH_MOUSE_LL`。 |
| `WS_EX_TRANSPARENT` | 官方定义重点是同线程兄弟窗口的延后绘制顺序，并非通用的跨进程输入穿透承诺。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)) | 不应只靠这个 style 证明 overlay 永远不会吃输入；Electron 的 ignore-mouse-events 与实际窗口命中行为仍需测试。 |
| `HTTRANSPARENT` | `WM_NCHITTEST` 返回该值后，命中会转交**同一线程**的底层窗口。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-nchittest)) | 不能把它当作对任意第三方应用的完整穿透方案。 |
| `SetCapture` | 只有前台窗口可以捕获鼠标；后台窗口调用时限制明显。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setcapture)) | 不能用它全局接管原本属于微信、Chrome 等其他进程的鼠标输入。 |
| `SendInput` | 输入注入受 UIPI 完整性级别限制，失败也不总能明确指出是 UIPI。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)) | “先吞后回放”不能保证对管理员应用、复杂拖拽和鼠标 capture 无损。 |
| `LLMHF_INJECTED` | 低级鼠标事件结构会标识被注入的事件。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-msllhookstruct)) | 如果实验回放，必须过滤自己注入的事件，避免递归捕获；这仍不解决语义丢失。 |
| `GetAsyncKeyState` | 读取的是当前物理按键状态，并有交换左右键等注意事项。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate)) | 可用于 chord 状态辅助，但不能独立承担可靠的完整事件序列。 |
| `SetWinEventHook` | 可以监听前台窗口等可访问性事件。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)) | 用 `EVENT_SYSTEM_FOREGROUND` 及时把 burst 画笔状态降级为导航状态，并记录每笔所属窗口。 |
| Per-Monitor V2 DPI | 多显示器/缩放场景需要进程与窗口正确声明 DPI awareness。([Microsoft](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)) | stroke、截图、UIA BoundingRectangle 与最终裁剪必须统一到物理像素坐标并记录 monitor/DPI。 |

补充：layered window 可通过每像素 alpha 影响命中，完全透明像素可穿透，但这是窗口合成/命中的实现细节，不能代替全局输入状态机。([Microsoft Archive](https://learn.microsoft.com/en-us/archive/msdn-magazine/2014/june/windows-with-c-high-performance-window-layering-using-the-windows-composition-engine))

## 推荐状态机

| 状态 | 鼠标是否放行 | overlay | 进入方式 | 离开方式 |
|---|---:|---|---|---|
| `IDLE` | 是 | 隐藏 | 默认 | 晃动达到阈值 |
| `BURST_DRAW` | 左键笔画期间吞；其余按设计 | 显示实时笔迹 | 首次晃动 | 抬手后启动 0.8–1.2 s grace period |
| `BURST_GRACE` | 建议仍把下一次左键按下视为追加笔画；其余事件谨慎处理 | 已画笔迹保留 | 一笔抬手 | 再次按下回 `BURST_DRAW`；超时或换前台进入 `NAVIGATE` |
| `NAVIGATE` | 全部放行 | 保留但变淡，窗口 no-activate + click-through | burst 超时、Alt+Tab、前台窗口改变 | `Space + 左拖` / 侧键 + 拖动进入 `STROKE_CAPTURE` |
| `STROKE_CAPTURE` | 只吞构成该笔的 down/move/up | 显示新笔迹 | 明确 chord | 抬手返回 `NAVIGATE` |
| `REVIEW` | 放行 | 气泡可编辑 prompt | 用户结束选择/语音 | 确认发送或取消 |

### 对“连续三段”的具体处理

1. 第一次鼠标按下开始第一段，hook 吞掉 down/move/up，底层微信不会误选文字或拖图片。
2. 抬手后不结束 Context Session，只进入短 grace period。
3. 1 秒内的第二、第三次按下继续由 hook 吞掉并追加到同一 Context Session。
4. 一旦用户停顿超过 grace period或切换前台应用，立刻放行，不再让全屏膜挡住任务栏和别的应用。
5. 到新应用后按住 Space 再左拖即可加下一项；不需要再次晃动。

`0.8–1.2 s` 是产品建议而非 Windows 限制，最终应通过埋点看连续笔间隔分布再调。默认不建议继续使用 10 秒全拦截窗口，因为 10 秒足以让用户感觉电脑被“锁住”。Context Session 可以保持更久，但 hook 的吞事件窗口必须很短。

## 为什么普通左键存在不可消除的歧义

同一个 `leftButtonDown` 到来时，系统必须马上决定：

- 把它交给底层应用：用户可以点按钮、拖文件、选择文字；但若后来发现用户画的是圈，底层副作用已经发生。
- 把它吞掉：可以安全圈选；但若后来发现用户只是想切窗口，就必须伪造/回放输入。

在看到后续轨迹之前，没有算法能知道用户真实意图。延迟分类只能把矛盾往后推，无法无损恢复：

- 双击间隔与目标窗口状态可能已经变化；
- 拖文件需要原应用的完整 OLE drag source 生命周期；
- 文字选择、按住按钮的视觉反馈、鼠标 capture 都依赖实时事件；
- `SendInput` 还受 UIPI 限制。

因此，初版必须保留一个明确但很轻的“这次拖动是圈选”信号。Space、侧键或短暂重新晃动都可以；默认推荐 Space/侧键，因为它比每次晃动更稳定，也不会和普通导航混淆。

## 开源项目能借什么，不能借什么

| 项目 | 已验证行为/源码证据 | 可借鉴 | 不能直接解决的问题 |
|---|---|---|---|
| [ppInk](https://github.com/pubpub-zz/ppInk) / [官网说明](https://pubpub-zz.github.io/ppInk/) | Pointer Mode 会保留绘图、折叠 toolbar，并把点击/滚轮交给底层；Alt+Tab 可在 pointer/drawing mode 间切换。源码在失去激活时进入 pointer mode，并通过 input rectangle 与 transparent style 切输入状态。([`FormCollection.cs`](https://github.com/pubpub-zz/ppInk/blob/master/src/FormCollection.cs#L3688-L3741)) | “笔迹保留但输入穿透”、Alt+Tab 自动切导航、显式 chord 消除歧义。 | 它是标注工具，不负责把跨应用选区合并成 Agent prompt；不能直接复制成我们的上下文解析层。 |
| [gInk](https://github.com/geovens/gInk) | ppInk 的上游/同类 Windows 屏幕标注项目。 | 窗口、工具栏、墨迹层的成熟交互参考。 | 同样没有多源上下文物化与 Agent 注入。 |
| [OpenClicky](https://github.com/jasonkneen/openclicky/blob/b0b4855ceb223ef0b0a57997cc0803cbd482f336/cursor-buddy/CircleSelectSession.swift) | macOS 使用 active `CGEventTap`；在圈选会话内对 left down/drag/up 返回 `nil` 吞事件，overlay 自身保持忽略鼠标。 | “视觉层永远穿透，独立全局 tap 决定是否吞事件”的架构与 Windows 目标一致。 | 它在一次 PTT hold 内持续吞按钮，新 drag 还会清理旧 stroke；不能直接提供跨窗口导航 + 多对象会话。 |
| [Clicky](https://github.com/farzaa/clicky/blob/a80fa80721a8aebe51a170a7780705024ebc6e46/leanring-buddy/OverlayWindow.swift) / [Clicky-Windows](https://github.com/Bitshank-2338/clicky-windows/blob/09208d88740db7ba593eb6b95085b63e92a59772/ui/overlay.py) / [Clacky](https://github.com/Raynan00/clacky/blob/e239089a4eb9daf7ac62d0f5c38e92fa53648499/clacky/shell/ui/overlay.py) | 核心是 click-through 视觉 overlay。 | 可借鉴光标跟随、透明窗口和轻量反馈。 | 主要是展示层，不是按状态拦截输入的底层。 |
| [PowerToys Mouse Highlighter](https://github.com/microsoft/PowerToys/blob/main/src/modules/MouseUtils/MouseHighlighter/MouseHighlighter.cpp#L418-L621) / [Pointer Crosshairs](https://microsoft.github.io/PowerToys/modules/mouseutils/mousepointer/) | 使用 `WH_MOUSE_LL` 获取全局鼠标信息，渲染与输入跟踪分离；Highlighter 观察后继续 `CallNextHookEx`。 | Windows hook 生命周期、消息线程、异步渲染与多显示器处理的可靠骨架。 | 默认只是观察，不会在特定状态吞事件；需要我们增加捕获状态机。 |
| [ZoomIt](https://learn.microsoft.com/en-us/sysinternals/downloads/zoomit) / [PowerToys 源码](https://github.com/microsoft/PowerToys/blob/main/src/modules/ZoomIt/ZoomIt/Zoomit.cpp#L5986-L5990) | LiveDraw 使用 layered/per-pixel 命中；源码里也有 mouse-up 丢失等补救。 | 可参考演示级绘图体验与 layered window。 | 它的已知边界反而说明 overlay 命中与精确选择很脆弱，不宜直接充当上下文捕获底座。 |

macOS 对照也支持同一架构判断：active `CGEventTap` 回调可以返回 `NULL` 过滤事件，listen-only tap 只能观察；tap 也可能因超时被禁用。([Apple `CGEvent.tapCreate`](https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate%28tap%3Aplace%3Aoptions%3Aeventsofinterest%3Acallback%3Auserinfo%3A%29?language=objc), [Apple callback](https://developer.apple.com/documentation/coregraphics/cgeventtapcallback?language=objc))

## 跨应用上下文不能只靠“最后一张截图”

用户在微信圈一项，然后打开全屏浏览器，旧微信内容必然被遮挡。解决方式不是让 overlay 一直挡住屏幕，而是**每一笔在发生时冻结自己的证据包**：

```json
{
  "item_id": "ctx-003",
  "captured_at": "2026-08-02T14:32:10.412+08:00",
  "source": {
    "process": "Weixin.exe",
    "window_title": "项目群",
    "hwnd": "0x...",
    "foreground": true
  },
  "geometry": {
    "screen_rect_physical_px": [1210, 640, 1660, 990],
    "monitor": "DISPLAY1",
    "dpi": 144
  },
  "artifacts": {
    "screenshot_path": "D:/.../capture/items/ctx-003/screen.png",
    "crop_path": "D:/.../capture/items/ctx-003/crop.png",
    "ocr_text": "...",
    "uia_snapshot_path": "D:/.../capture/items/ctx-003/uia.json"
  },
  "media": {
    "status": "resolved | crop_only | unresolved",
    "local_path": "D:/.../capture/media/ctx-003/image.png",
    "acquisition": "save_as | clipboard_hdrop | clipboard_virtual_file | clipboard_pixels | screenshot_crop",
    "quality": "original | downloaded | rendered_crop",
    "reason": null
  }
}
```

推荐在 stroke down 时先抓“无新笔迹污染”的屏幕帧，stroke up 后根据最终几何裁剪；同时记录 foreground HWND、进程、标题、monitor 和 DPI。这样后来浏览器盖住微信，旧上下文仍然存在于 `ctx-003` 的证据包里。

UIA 树也应在消息仍可见时立即做缓存快照。不能把一个活的 AutomationElement 引用留到很久以后再读，因为微信 4.x 的可见消息 UI 会随滚动/重绘销毁。需要交互才能下载的媒体则标成 `pending_materialization`，在提交前或用户停止导航后串行处理；若原窗口/消息已经无法重新定位，直接降级，不应打断整个 Context Session。

## 微信图片与文件：可靠获取链

### 已确认事实

wxauto 当前官方文档列出微信 4.1 支持，并明确说明 4.x 消息 UI 是按可见区域实时渲染的：消息滚出可视区后，对应 UI 对象会失效。因此，命中与必要元数据必须在消息仍可见时完成。([wxauto 完整文档](https://docs.wxauto.org/llms-full.txt))

同一文档提供：

- `ImageMessage.download(dir_path, original=False)`：下载图片并返回本地 `Path`，`original=True` 请求原图；
- `ImageMessage.ocr()`：读取图片文字；
- `VideoMessage.download()`：下载视频；
- `FileMessage.download()`：文档中标记为 Plus 能力；
- `WeChatImage.save()`：从图片/视频预览窗口保存到指定目录。

旧版 wxauto 开源源码还展示过一种不解密微信数据库的 UI 路线：图片消息通过打开预览窗口再“另存为”；文件消息通过右键“复制”，从剪贴板 `CF_HDROP` 读取绝对路径。([`elements.py`](https://raw.githubusercontent.com/cluic/wxauto/main/wxauto/elements.py))

这些证据只能说明“公开 UI 自动化路线可行”，不能证明当前本机微信 `4.1.11.55` 的每一种消息都暴露同样菜单或剪贴板格式，也不意味着可以直接复制 wxauto 的实现或许可证受限代码。

### 初版获取优先级

对圈选几何命中的可见微信消息：

1. **UIA 命中与分类**
   用 UIA BoundingRectangle 与圈选区域相交，确定消息气泡、类型、发送人、时间和可访问名称。UIA 负责“找到并调用控件”，不会直接提供图片字节或文件路径。`InvokePattern` 只调用 provider 暴露的动作。([Microsoft UIA InvokePattern](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.invokepattern.invoke), [UIA control patterns](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-client-controlpatterninterfaces))

2. **公开 UI 下载/另存为（图片首选）**
   若能稳定打开图片预览，使用“原图/下载/另存为”把媒体写入 Magic Pointer 的 `capture/media/<session>/<item>/`。向 Agent 提供的是这个被物化后的稳定绝对路径，并在 `quality` 中说明它是 original、downloaded 还是 rendered，不假装它是微信内部缓存原路径。

3. **运行时探测右键“复制”的剪贴板格式**
   对当前微信版本实测并枚举 OLE `IDataObject`：
   - `CF_HDROP`：可直接读出已有本地文件的完整路径；
   - `CFSTR_FILEDESCRIPTOR` + `CFSTR_FILECONTENTS`：把虚拟文件的 `IStream` 落盘；
   - `CF_DIB` / `CF_DIBV5` / PNG：把像素保存为本地 PNG。

   Windows Shell 官方说明了 `CF_HDROP` 和虚拟文件传输的这些标准机制。([Shell Data Transfer Scenarios](https://learn.microsoft.com/en-us/windows/win32/shell/datascenarios), [Shell Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard), [Standard Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats))

4. **预览 → 另存为回退**
   若复制动作没有可用格式，再尝试标准预览窗口与 Save As。自动化期间要记录并尽量恢复前台窗口，但不能声称完全无打扰；更适合在用户结束选择、进入 REVIEW 后执行。

5. **圈选时截图裁剪**
   文件物化失败时，使用该笔刚发生时冻结的原分辨率截图裁剪，并明确 `quality=rendered_crop`。这是“看到屏幕上什么就交什么”，不是原图。

6. **明确失败**
   如果裁剪区域太小、严重遮挡、只包含模糊缩略图，或视觉/OCR 置信不足，输出例如：

   ```json
   {
     "status": "unresolved",
     "reason": "thumbnail_too_small",
     "observed_crop_px": [42, 31],
     "description": "无法可靠识别该图片内容；未取得原文件。"
   }
   ```

   不应通过放大低分辨率缩略图后猜测内容，更不能生成一个看似真实的原图路径。

### 关于“能不能复制出原图”的准确回答

**有可能，但不能预先保证。** 如果微信向剪贴板提供 `CF_HDROP`、虚拟文件流或像素格式，就能复制/物化；如果右键复制只提供文本、内部私有格式或什么都不提供，就拿不到。当前未找到一手证据证明本机微信 `4.1.11.55` 的图片消息一定提供上述任一格式，因此必须做 capability probe。

拖拽导出同理：只有微信作为 OLE drag source 暴露可用 `IDataObject` 时才可能获得文件；不能把“用户能拖动一个缩略图”误当成“一定能拿到原文件”。

如果产品必须得到原图，最诚实的交互是提示用户先在微信中点开原图/完成下载，再圈选；否则只把当前可见裁剪交给 Agent，并标注来源质量。

## 事实、推断与未验证项

### 事实

- Windows 低级鼠标 hook 能阻止事件到达目标窗口，但必须快速返回并有消息循环。
- Raw Input 适合观察，不负责阻止事件。
- `HTTRANSPARENT` 与 `WS_EX_TRANSPARENT` 都不能单独作为任意跨进程窗口穿透的完整保证。
- ppInk 已实现“保留笔迹、切 pointer mode 后把点击/滚轮交给底层”的产品形态。
- OpenClicky 使用独立 active event tap 吞输入，而 overlay 本身 click-through。
- 微信 4.x 可见消息 UI 可能随滚动销毁；公开 UI 的下载/预览/另存为路线存在。
- Windows 标准剪贴板/OLE 格式支持真实文件路径、虚拟文件流和像素数据，但提供哪些格式由 source app 决定。

### 设计推断

- Magic Pointer 最稳的初版是“一次晃动开始 Context Session；短 burst 内直接多笔；跨应用后用轻 chord 增加下一笔”。
- 可视 overlay 应长期 click-through；全局 hook 只在明确的 stroke capture 状态吞事件。
- 每一笔都要即时保存截图、窗口、DPI、UIA/OCR 和媒体状态，才能抵抗后来窗口遮挡。
- 媒体对 Agent 的契约应是 Magic Pointer 自己物化出的绝对路径 + acquisition/quality，而不是内部微信缓存路径承诺。

### 未验证、不可承诺

- “演示七”的原产品是否确实采用 grace period、PTT 还是其他机制。
- 本机微信 `4.1.11.55` 图片/文件右键复制实际提供哪些 clipboard/OLE format。
- 当前版本微信能否对每类图片稳定进入预览并选择原图。
- 微信拖拽是否提供可读取的虚拟文件 `IDataObject`。
- wxauto 的行为不能替代对本机版本的集成测试，且其生产/商业使用限制需要单独做许可证审查；可以借公开 UI 与 Windows 协议思路，不应直接复制受限实现。
- Electron `setIgnoreMouseEvents`、原生 hook 与多显示器高 DPI 的组合需要在 Windows 10/11、不同缩放比和管理员窗口上实测。

## 被否决为默认方案的路径

- **每跨一个应用就关闭并重新晃动**：打断思路，用户已经明确认为体验差。
- **overlay 一直独占 10 秒**：能连续画，但任务栏、Alt+Tab、浏览器和微信都无法自然操作。
- **完全 pass-through 观察左拖**：底层应用会同时发生文字选择、拖文件、按钮操作等副作用。
- **先吞所有点击，事后 `SendInput` 回放**：输入语义不能无损恢复，且受 UIPI 影响，只能作为实验开关。
- **只靠 `WS_EX_TRANSPARENT` / `HTTRANSPARENT`**：官方保证范围不足以覆盖任意第三方进程。
- **扫描/解密微信私有数据库作为初版**：版本耦合、隐私和合规风险高；公开 UI、剪贴板/OLE 与截图足以先完成可解释的初版。
- **视觉模型猜小图**：会产生最危险的假上下文；无法可靠读取就返回 unresolved。

## 初版验收清单

### 连续圈选

- [ ] 晃动一次后能在同一应用连续画三段，三段之间不重新唤醒。
- [ ] burst grace period 超时后，普通左键、滚轮、任务栏和 Alt+Tab 全部恢复原生行为。
- [ ] 从微信切到浏览器后，不重新晃动，通过 Space/侧键 + 左拖增加下一项。
- [ ] 捕获中的 left down/move/up 不传给底层微信/浏览器，不产生文字选择或文件拖动。
- [ ] 导航状态 hook 必须 `CallNextHookEx`，overlay 必须 no-activate + click-through。
- [ ] hook 回调不做 OCR、截图、文件 I/O 或渲染；压力测试下不因超时静默失效。
- [ ] 每笔都有独立截图和窗口元数据；后续全屏窗口遮挡旧应用后，旧选区仍可进入 prompt。
- [ ] 100% / 125% / 150% / 200% 缩放和跨显示器场景中，stroke、截图裁剪与 UIA rectangle 对齐。

### 微信媒体

- [ ] 圈中可见图片消息时，能定位消息 UIA 元素并记录会话/发送人/时间（能取到多少记录多少）。
- [ ] 运行时枚举并记录剪贴板/OLE formats，不假设 `CF_HDROP` 必然存在。
- [ ] 可下载/另存为时，媒体被写入 Magic Pointer 自有目录，prompt 包含可访问的绝对路径。
- [ ] path 同时带 `acquisition` 与 `quality`，Agent 能区分原图、下载副本和屏幕裁剪。
- [ ] 原文件失败时自动使用该笔的即时截图裁剪，而不是会话末尾已经被遮挡的屏幕。
- [ ] 小图、遮挡图、失效 UI 对象返回明确 `media_unresolved`，不编造描述和地址。
- [ ] 用户快速滚动、切窗口、关闭预览时不会拖垮整个 Context Session；单项失败可降级。

## 最终产品决策

初版完整闭环应定义为：

```text
晃动一次开启 Context Session
→ 短 burst 内连续画多段
→ 每笔立即冻结截图/UIA/窗口/DPI 证据
→ burst 后 overlay 穿透，用户自然跨应用导航
→ Space/侧键 + 拖动继续添加上下文
→ 微信媒体按 UI 下载、剪贴板/OLE、截图裁剪逐级物化
→ prompt 气泡展示可编辑的多源上下文和绝对路径
→ unresolved 项明确标注
→ 用户确认后直接发送给所选 Agent
```

这条路线既保留了“鼠标指代 + 语音”的轻量感，也承认桌面输入系统的真实边界。它不要求安装浏览器扩展，浏览器网页的 DOM/selector 可继续由现有 DevTools adapter 补充；Windows 全局 hook + UIA + per-stroke screenshot 才是跨原生应用的底层。
