# 选区表征：Everywhere 的规矩框 vs MP 的自由笔画，以及 Google 会怎么做

> 2026-08-31。写给你自己看的决策文档，不是给弱模型的工单。
> 术语第一次出现时都在括号里用大白话解释一遍。
>
> **一条更正**：你说 `external/everywhere` 里没有源码——实际上有。
> `external/everywhere/src/`（C# / Avalonia / .NET）是完整的，而且
> `external/everywhere/docs/ScreenPicker/` 里有四篇他们自己写的设计手记，
> 把「为什么最后长成这样」讲得非常透。本文的 Everywhere 部分全部基于这些一手材料，
> 不是猜的。注意它是 **BSL 1.1 许可**（四年后转 Apache 2.0），可以读、可以学思想，
> 不能抄代码。

---

# 第 0 部分：先给结论

你纠结的是「规矩 vs 自由」。**这个纠结本身是个假问题**，因为你把两个独立的轴压成了一个。

真正的两个轴是：

| 轴 | 问的是 | Everywhere | MP 现在 | 应该是 |
|---|---|---|---|---|
| **输入自由度** | 用户的手能怎么动 | 低（悬停 + 滚轮切粒度 + 点击） | 高（点/线/圈/涂/多笔） | **高** |
| **输出确定性** | 系统最后认定了「哪个东西」 | 高（一定是某个 UIA 元素，且高亮给你看） | **中（认定了，但不给你看，也不让你改）** | **高** |

Everywhere 是「输入低自由 + 输出高确定」。
MP 是「输入高自由 + 输出中确定」。
**正确答案是「输入高自由 + 输出高确定」**——两者不冲突，只是 MP 缺了中间那一步。

## 缺的那一步：吸附 → 回显 → 改判

MP 现在的链路是：

```
自由笔画 → 几何区域 → 读内容 → 判断"读到的是不是用户划的" → 交给模型
                                   ↑
                            这一步的结论只写进了日志和 trace，
                            用户屏幕上什么都没有变化
```

应该是：

```
自由笔画 → 几何区域 → 候选对象集合 → 吸附到一个 → 【画出来给用户看】 → 【一键扩/缩改判】 → 交给模型
```

三个动作，按性价比排序：

1. **回显（echo）**——最便宜、收益最大。grounding 落地那一刻，把「我认定的是这一块」的矩形在原位画一次（淡入 → 停 800ms → 淡出）。
   现在 MP 有 `groundingReady=false → true` 这个状态位（`electron/main.ts:3871`），但它只影响胶囊的加载态，**用户永远看不到系统认定了哪一块**。
   Everywhere 的 mask 高亮在这一点上是完全正确的，而且它是**免费**的——不需要多一次模型调用，几何数据早就在手里了。
   这一步能消掉你说的「到底漏判啥了」这个焦虑的绝大部分：不是让它别判错，是让判错**立刻可见**。

2. **改判（repair）**——第二便宜。回显出现的同时，在胶囊上给两个芯片：`↑ 扩到整段` / `↓ 缩到这个词`。
   Everywhere 的滚轮切 Screen / Window / Element 这个交互**本身是对的**，它错在时机：它要求用户在**选之前**就知道自己要哪一级粒度。
   而用户在选之前根本不知道 UIA 树长什么样（那是系统的内部结构，凭什么让用户背）。
   同一个能力挪到**选之后**就完全合理了：用户先随手划，看到系统认定了什么，觉得窄了点一下扩，宽了点一下缩。
   这就是「自由输入 + 确定输出」的正确闭环。

3. **吸附（snap）**——最贵，但 MP 已经做了一半。
   像素侧已经有了：`app/grounding/ocr_mark_selection.py` 把一条开放笔画吸附到 OCR 的某一行（下面详述，做得很好）。
   结构侧**没有**：`app/grounding/marked_read.py` 只回答「覆盖 / 没覆盖」这个二元问题，不做「在这几个候选元素里挑一个」。
   这里应该把 Everywhere 的 element hit-test 拿来**当候选源**，而不是当交互模型。

## 关于「漏判」的具体策略

MP 已经有一个非常好的东西叫 `covers_mark`（「这次读到的内容，真的是用户划的那个东西吗」）。
但它现在的用法是：**判 False → 去调视觉模型看一眼**（`app/perception/visual_once.py`）。这是先花钱的路。

正确的顺序应该是先花 0 块钱：

```
covers_mark == False
  ├─ 有 OCR 行候选？ → 直接回显那一行 + 芯片「就是这行 / 换一行 / 扩到整段」   ← 免费
  ├─ 有 UIA 元素候选？ → 回显那个元素矩形 + 同样的芯片                        ← 免费
  └─ 什么候选都没有 → 才调 look_once 视觉模型                                 ← 花钱
```

理由：用户是唯一知道自己想选什么的人。当系统不确定时，**问一个 0 成本的问题**永远优于**做一次昂贵的猜测**。
而且这个问法不打断心流——芯片就在胶囊上，不点也能直接打字提问。

---

# 第 1 部分：Everywhere 是怎么做的（一手材料）

## 1.1 用户看到的

按呼出快捷键 → 全屏蒙版出现 → 鼠标悬停到哪，哪个 UI 元素就被高亮框住 → 滚轮切换粒度（整屏 / 整窗口 / 单个元素）→ 左键确认 / 右键取消 → 选中的元素成为 AI 的上下文 → 打字提问。

也支持自由拉矩形框（他们的设计文档里提到 "free rectangular selection" 是后加的功能，且加得很痛苦——"required touching six different places"）。

## 1.2 背后有多难：四篇设计手记的浓缩

这部分值得你完整读一遍原文，因为它是一个「看起来简单的功能，工程上有多恶心」的完美案例。

### 根本矛盾：全屏蒙版 vs 元素命中测试

Windows 的 `IUIAutomation::ElementFromPoint`（「告诉我这个屏幕坐标上是哪个界面元素」）是**全局的**——它返回该坐标上**最顶层**的元素。
你放一个全屏蒙版在最上面，它返回的就是**你自己的蒙版**，不是底下的应用。

微软没有提供「限定在某个窗口内部找」的公开 API。他们查遍了 `IUIAutomation2` 到 `IUIAutomation6`，都没有。

### 第一版：三个 hack 叠在一起

- 把蒙版窗口设成 `WS_EX_TRANSPARENT`（鼠标穿透），这样 `ElementFromPoint` 才能看到底下的应用。
- 但穿透了就收不到鼠标事件了 → 装 `WH_MOUSE_LL` **全局低级鼠标钩子**（在系统层面截所有鼠标消息）来补。
- 窗口一出现就 `SendInput` 注入一个**假的右键按下**（不放开），目的是让 Windows 进入「鼠标捕获」状态，防止光标形状被底下的窗口改来改去闪烁。
- 关闭时要还一个假的右键抬起，但如果这时候窗口还是穿透的，这个抬起会落到桌面上 → 资源管理器弹出右键菜单。于是关闭变成了一个 6 步异步序列。

这一版的实际故障：

- **UAC 提权弹窗出现时**，低级钩子（跑在标准权限进程里）收不到高权限窗口的消息 → 钩子静默 → 那个注入的右键**永远没有抬起** → 用户的右键从此坏掉，直到自己手动点一下。
- **和第三方鼠标工具打架**（MouseInc / AutoHotkey 也装 `WH_MOUSE_LL`）→ 钩子顺序不确定 → 行为随机。
- 低级钩子有 300ms 超时，机器一忙就静默丢回调。

### 第二版：逆向 `UIAutomationCore.dll`

他们用 IDA 反编译发现，`CUIAutomation::ElementFromPoint` 内部调用了一个私有方法：

```cpp
HRESULT CUIAutomation::ElementFromPointHelper(
    CUIAutomation *this,
    IUiaNode *clientRootNode,   // ← 这个参数就是搜索范围
    tagPOINT point,
    IUIAutomationElement **result,
    bool *isWebView             // ← Chromium 自动处理
);
```

`clientRootNode` 正是他们要的「限定范围」参数。公开的 `ElementFromPoint` 传的是桌面根节点，所以才是全局的。
而 `UiaNodeFromHandle(HWND, ...)`（一个老的、有文档的导出函数）能把任意窗口句柄变成这个节点类型。

问题是这个私有函数没导出。三条路：

- **A. 用符号表找**：要从微软符号服务器下 PDB，首次几百毫秒，缓存后也要 ~50ms。鼠标每动一下都要调，不可行。
- **B. 硬编码虚表偏移**：`IUiaNode` 是没文档的内部 COM 接口，测下来 Win10 1903 → 21H2 → Win11 23H2 之间偏移已经变过一次。
- **C. 扫遥测字符串**（他们选的）：Windows 的 DLL 编译时带 ETW 遥测，每个非平凡函数的开头都会调 `ClientApiCallTrace::ctor` 并把**自己的函数名当字符串字面量**传进去。所以：
  1. 在已加载的 `UIAutomationCore.dll` 内存里搜字节串 `CUIAutomation::ElementFromPointHelper\0`；
  2. 反汇编整个代码段，找那条把这个字符串地址装进 RDX 的 `LEA` 指令（x64 调用约定里第二个参数走 RDX）；
  3. 从这条指令**往回**扫，遇到连续两个 `0xCC`（函数之间的填充字节）就停——下一个字节就是函数入口。

  全过程 20–50ms，进程生命周期内缓存一次。字符串从 Win7 到 Win11 24H2 一直在，比虚表偏移稳定得多。找不到就回落到全局 `ElementFromPoint`。

拿到这个函数之后，整个架构塌缩了：蒙版窗口**不用再穿透**了 → 不用全局钩子 → 不用注入假右键 → 不用 6 步关闭序列。他们自己的对照表：**~300 行 6 个 workaround → ~150 行直白代码**。

### 第三版：还有一个更阴的坑

新架构上线后，**某些窗口只能拿到窗口级元素，拿不到内部的按钮/列表项**。

他们做了个精妙的实验：把蒙版缩到只盖屏幕左上 1/4，但在代码里把鼠标坐标 ×2 —— 这样右下角是完全没被遮住的测试区，但命中测试逻辑走的还是全屏坐标。

结果：**没被遮住时一切正常，一盖上就退化**。

根因是 **Chromium 的渲染器休眠**：现代 Chromium 会通过 Windows DWM（桌面窗口管理器）的遮挡检测判断自己是不是被完全挡住了。一旦判定被挡住，它会：

1. 挂起 GPU 渲染管线；
2. **把 `Chrome_RenderWidgetHostHWND`（承载页面 DOM 无障碍树的那个窗口）从可见的窗口树上摘下来，挂到一个隐藏的消息窗口下面**；
3. 原位置只留一个没有任何无障碍信息的 `Intermediate D3D Window` 占位。

所以他们的蒙版一盖上去，Chromium 就把整棵 UIA 树搬走了。

两个解法：

- 给蒙版加 `WS_EX_LAYERED` + `SetLayeredWindowAttributes(alpha=254)`——**254 而不是 255**。DWM 就不再把它归类为「完全不透明的遮挡者」，Chromium 也就不休眠了。视觉上看不出区别。
- 更彻底的：给自己的窗口设 `UIA_WindowVisibilityOverridden` 属性（值 2 = 对 UIA 视为不可见），这是他们从 `BasicHwndUtils::GetWindowVisibility` 里逆出来的。

**这一条对 MP 直接有用**：MP 的 overlay 也是全屏窗口，也在 Chromium 系应用（浏览器、VS Code、Electron 应用、微信新版）上做 UIA 读取。如果 MP 出现过「在浏览器里读不到内容，只拿到窗口标题」，`WS_EX_LAYERED` + alpha 254 值得直接试一次。见本文第 5 部分。

## 1.3 从中该学什么、不该学什么

**该学**：
- 输出必须**可见**（mask 高亮）。这是 Everywhere 做得比 MP 好的唯一一件重要的事。
- 粒度是**可切换**的（Screen / Window / Element）。想法对，时机错。
- `WS_EX_LAYERED alpha=254` 这个具体 trick。

**不该学**：
- 悬停选元素这个交互模型本身。它把 UIA 树的结构泄露给用户当操作负担——用户得先理解「这个按钮属于哪个面板」才能选对。
- 全局低级钩子。MP 现在走的是指针轮询 + 自己的 overlay 收事件，没有这个包袱，别加回来。
- 内存扫描找私有函数。这是他们被自己的架构逼到墙角的产物；MP 的 overlay 在冻结帧之后就撤了（见下），根本不存在「蒙版挡住命中测试」这个问题。

---

# 第 2 部分：MP 从唤起到答案，每一步在做什么

下面按真实时间顺序走，每段都给文件和行号。

## T0（0ms）唤起：三条入口

### 入口 A：晃鼠标（wiggle）

主进程有一个指针轮询循环（`electron/main.ts:3476` 附近的 tick），每一拍把光标位置喂给
`electron/wiggle_detector.ts` 的 `WiggleDetector.push()`。

**先看要不要直接否决**（`_blocked`，`wiggle_detector.ts:160-167`）——四条硬闸，任意一条命中就清空缓冲：

| 闸 | 判据 | 为什么 |
|---|---|---|
| `button_down` | 最近任一采样有鼠标键按下 | 拖拽不是唤起 |
| `active_scroll` | 最近采样滚轮累计位移 ≥ 80 | 边滚边动鼠标不是唤起 |
| `window_move` | 有采样标记窗口正在被拖动 | 拖窗口不是唤起 |
| `disabled_app` | 前台应用在用户黑名单里 | 游戏/绘图软件 |

**再算特征**（`_metrics`，第 169-232 行）。判定窗口 700ms，至少 4 个采样点：

```
durationMs  ∈ [65, 700]                       太快是抖动，太慢是正常移动
xRange      ≥ 28 × thresholdScale             横向跨度
yRange      ≤ max(48, xRange × 0.90)          否决"主要是竖直"的运动
reversals   ≥ 2                               至少两次横向反向（也就是"左-右-左"三段）
horizontalTravel ≥ 68 × thresholdScale        三段的横向总行程
returnRatio ≥ 0.12                            = 1 - 净位移/xRange，"回到原处"的程度
velocity    ≥ 90 × thresholdScale px/s        慢悠悠地来回不算
```

`reversals` 的算法（第 193-209 行）：逐点算 dx，忽略 |dx| < 5 的抖动，方向一变就把上一段（长度 ≥ 10×scale）记为一个 segment，段数 - 1 就是反向次数。

**自适应阈值**（`recordOutcome`，第 146-158 行）——这是个很聪明的设计：
- 用户唤起后**立刻取消** → `thresholdScale += 0.08`（上限 1.45），下次更难触发；
- 用户唤起后**真的问了问题** → `thresholdScale -= 0.04`（下限 0.82），下次更容易触发。

也就是说 MP 的手势灵敏度是**跟着你用的方式自己走的**，不需要你去设置里调。另外有 `startCalibration` / `finishCalibration`（第 110-144 行）做首次校准：让用户晃 10 秒，取 xRange 中位数反推灵敏度。

触发后 900ms 冷却（`cooldownMs`）。

### 入口 B：鼠标侧键 / 中键长按

`electron/mouse_activation.ts`。侧键（xbutton1/2）看按位掩码的**上升沿**（从没按到按下）；中键是**长按 450ms**（第 14 行 `middleHoldMs = 450`），按住不放到时间才触发一次，不会连发。

### 入口 C：全局快捷键兜底

`electron/main.ts:3651`，`fallback_hotkey_enabled` 控制。

三条路最后都汇进 `requestActivation(reason)`（`main.ts:2725` 附近），过一道
`ActivationGate`（`main.ts:232`，debounce 600ms，防止一次晃动触发两次）。

## T1（~5ms）overlay 显示 + 帧捕获预备（arm）

`armSelectionGesture`（`main.ts:3154`）：

1. 显示透明全屏 overlay（用户看到光标变成画笔）；
2. 调 `getCaptureCommitCoordinator().arm({ epochId, displayId, scaleFactor, surfaceBoundsPx, targetWindow, overlayExcluded })`（`main.ts:3183`）；
3. 这个 arm 会通知帧捕获 worker **开始持续缓冲屏幕帧**（Windows Graphics Capture，WGC——Win10 1903+ 的官方屏幕捕获 API，能按窗口捕获且能排除指定窗口）。

**注意 `overlayExcluded`**：WGC 支持把自己的 overlay 从捕获里排除，所以 MP 冻结的那一帧里**没有自己画的线**。这跟 Everywhere 的困境是两码事——MP 的 overlay 是自己的绘制层，不参与 UIA 命中测试（MP 根本不做实时 hover 命中测试）。

## T2（0–数秒）用户画

`electron/renderer/overlay.ts` 收 pointer 事件，累积点。
支持**多笔链式**（`electron/gesture_capture.ts:34-35`）：
- `CHAIN_CONTINUE_DISTANCE = 4`px：抬笔后光标移动超过 4px 才算「要接着画下一笔」；
- `CHAIN_IDLE_FINALIZE_MS = 520`ms：抬笔后 520ms 没有新动作就收笔定稿。

所以「圈这个，再圈这个，然后提问」是一次手势，不是三次。
Esc 随时取消（`overlay.ts:646`）。

## T3（收笔瞬间）笔画分类——MP 和 Everywhere 分道扬镳的地方

`electron/gesture_capture.ts` 的 `summarizeStroke`（第 131-227 行）。

先算三个无量纲量：

```
pathLength   = 折线总长
chord        = 起点到终点的直线距离
diagonal     = 包围盒对角线长
straightness = chord / pathLength     1 = 完全直线
closure      = chord / diagonal       0 = 首尾重合（闭合）
circuit      = pathLength / diagonal  绕了多少圈
```

然后分类：

| 类别 | 判据 | 产出的几何 |
|---|---|---|
| **point**（点一下） | `durationMs ≤ 420` 且 `pathLength ≤ 14` | `point_target`，半径 14px |
| （丢弃） | `pathLength < 12` 或 `durationMs < 40` | 无 |
| **circle**（圈） | ≥6 点 且 宽高都 ≥16 且 `closure ≤ 0.36` 且 `circuit ≥ 1.65` | `polygon_region`：按包围盒拟合的 **32 边椭圆环** |
| **line**（划一行） | `straightness ≥ 0.80` | `band_corridor`：沿笔画中心线的**带状走廊** |
| **freeform**（乱涂） | 其余 | 同上，`band_corridor` |

**走廊宽度**（`corridorWidthFor`，第 85-87 行）：`clamp(pathLength × 0.05, 10, 36)` 像素。
也就是划得越长，容错带越宽，但封顶 36px（大约两行文字的高度，再宽就会吃到隔壁行）。

走廊怎么构造（`buildCorridor`，第 89-105 行）：对每个点取前后邻点算切向量，旋转 90° 得法向量，向两侧各推 width/2，左边一串正序 + 右边一串逆序 = 一个闭合多边形。

**这就是 MP 相对 Everywhere 的核心资产**：Everywhere 交出去的是「一个 UIA 元素」，MP 交出去的是「一块用户亲手划出来的、带宽容度的区域 + 它的类型」。
类型是有语义的：圈 = 「这一整块」，线 = 「这一行」，点 = 「这个东西」。这个语义 Everywhere 拿不到。

多笔时（`summarizeGesture`，第 263-322 行）：每笔各自保留自己的几何，聚合字段里
`semanticPoint` / `anchorPoint` 取**第一笔**（这样胶囊不会在你接着画的时候乱跳），
`releasePoint` 取**最后一笔**。

## T4（收笔 + 0～200ms）先冻帧，再放 overlay

这是 MP 一个做得很对、且很容易做错的地方。

`completeSelectionGesture`（`main.ts:3340-3392`）：

1. 把所有点从 **logical DIPs**（Windows 的逻辑像素，跟 DPI 缩放无关）转成 **physical screen pixels**（物理像素）。
   为什么必须转：150% 缩放的屏幕上，逻辑 100px = 物理 150px。截图是物理像素的，UIA 的 `BoundingRectangle` 也是物理像素的，只有 Electron 的窗口 API 是逻辑像素的。
   `electron/coordinate_space.ts` 整整 364 行就是干这个的。这是 Windows 特有的税，Android 上不存在（见第 3 部分）。
2. 组装 gesture 对象（`main.ts:3345-3368`），带上 `coordinateSpace: 'physical_screen_pixels'`、`displayBounds`、`scaleFactor`。
3. 调 `coordinator.complete(gesture)`。

`CaptureCommitCoordinator`（`electron/capture_commit_coordinator.ts`）的状态机：

```
idle → armed → committing → committed | failed | cancelled
```

`complete()` 的关键顺序（第 102-165 行）：

1. **先** `provider.commit()` —— 让捕获 worker 把「缓冲区里最新的那一帧」定格，产出一个 **FrameLease**；
2. 有 12 秒硬超时（`DEFAULT_COMMIT_TIMEOUT_MS`），provider 挂了不会把 overlay 永久钉在屏幕上；
3. **然后才** `releaseOverlay()`；
4. **最后才** `beginSession()`。

注释里写得很清楚（第 8-11 行）：*"pointerup must freeze pixels (commit) before the overlay is released"*。
旧版是固定等 34ms 让合成器出帧，结果**用户抬手后屏幕变了，截到的是新画面**。现在这个竞态没了。

还有一个**陈旧令牌**保护（第 143-145 行）：如果 commit 在飞行途中来了一个新手势（新的 arm），旧的 commit 结果直接丢弃——不释放 overlay、不开会话。两个交错的手势永远不会串台。

**FrameLease**（`electron/frame_lease.ts`）是一份不可变契约：

```
frameLeaseId, epochId, capturedAtMonotonicMs, capturedAtUtc,
source ('wgc-window' | 'wgc-display' | 'dxgi-display' | 'gdi-fallback'),
targetWindow { hwnd, processId, processName, title },
surfaceBoundsPx, displayId, scaleFactor,
gesture,                      ← 手势几何跟着帧一起走
localArtifact { path, mimeType, width, height },
contentHash,                  ← 内容哈希，防止后面被换掉
overlayExcluded, captureLatencyMs
```

TS 侧和 Python 侧（`scripts/frame_lease.py`）**各有一份校验器，字段必须逐一对齐**。
一张 lease 一旦创建就再也不能指向另一张图。这是「你看到的就是我读的」这个承诺的技术形式。

## T5（+~10ms）胶囊乐观出现

`beginSelectionSession`（`main.ts:3799`）：

- `hideOverlay()` —— 画笔层撤掉；
- `placeStageOnDisplay(display)` —— 舞台窗口挪到手势所在的那块屏幕；
- `revealCapsule('immediate')`（第 3863-3896 行）—— **在任何读取完成之前**就把输入胶囊弹出来，`groundingReady: false`。

注释说得很好（第 3860-3862 行）：*"The bubble is a promise that we heard the gesture, and that promise is worth nothing four seconds later."*
——泡泡是「我收到了」的承诺，四秒之后再给这个承诺就一文不值。

胶囊锚点用**第一笔**的位置（第 3809-3810 行），多笔时不会乱跳。
锚点还要从物理像素**转回** DIP（第 3811-3815 行），否则在缩放屏上胶囊会被挤到右下角——这是个真实修过的 bug。

同时 `sessionTimeline.begin()` 开始计时，**计时起点是手势，不是第一个 bridge**（第 3856-3857 行）：用户关心的是「从我划完到我看到答案」多久。

## T6（+50～2000ms）结构化读：并发扇出

`runPythonBridge({ mode: 'capture_selection_snapshot', ... }, 'scripts/selection_snapshot_bridge.py')`（`main.ts:3899-3914`）
把 cursor（物理像素）、gesture（含几何）、frameLease、screenBounds、scaleFactor、foregroundHwnd 一起丢给 Python。

Python 侧 `app/perception/broker.py` 做**分层并发扇出**：

- 层（tier）只有两个：`structured`（结构化，即 UIA / Office COM / 浏览器 DevTools 这类能直接拿到文字的源）和 `pixel`（像素，即 OCR）。
- structured 层默认截止 **2000ms**（`broker.py:43`）。
- 每个 provider 可以声明自己的截止时间（`descriptor.deadline_ms`）。手势策略 provider 有 3.5s 的采样预算，不会被层默认值砍掉（第 162-167 行注释）。
- 实现（第 197-236 行）：`ThreadPoolExecutor` 全部并发提交，然后按各 provider 的截止时间**从小到大分批 wait**。超时的 provider 变成一条 `TIMEOUT` 观测，**线程留着自己跑完**——注释明确说 *"this bounds the interaction, not the thread"*（限制的是交互时长，不是线程）。
- 需要冻结像素但没有 lease 的 provider（`requires_frozen_pixels`）直接短路成 `UNSUPPORTED`（第 174-184 行）：*"Reading the live screen here would certify a post-gesture frame as the moment of the gesture."*

每个 provider 产出一条 `PerceptionObservation`（`app/perception/providers.py:255`），字段包括
`content`、`tier`、`status`、`confidence`、`container_hint`、`covers_mark`、`provider_trace`。

## T7（关键一步）「读到的到底是不是你划的那个东西」

`app/grounding/marked_read.py`。这个文件的开头写了一段真实事故，值得原样读：

> 2026-08-04，一条划过 PowerShell 控制台某一行的笔画，UIA 读回来的内容是
> `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` —— 容器的无障碍名称。
> 因为这个字符串**非空**，整条流水线判定「结构化读取成功」，**关掉了像素兜底**，
> 然后告诉用户「我能看见你指的是哪个窗口，但看不见你划了什么」。
> 而像素一直在磁盘上——事后拿同一张截图跑 OCR，从 53 个候选块里**精确**挑出了那一行。

于是有了 `structured_read_covers_mark`（第 116-149 行），五档判据，**只会降低置信度，永远不会提高**：

| 返回 | 条件 | 大白话 |
|---|---|---|
| `False / no_structured_text` | 内容为空 | 什么都没读到 |
| `False / identity_only` | 内容 == 窗口标题 / 进程名，或长得像 exe 路径 | 应用在报自己的名字，不是内容 |
| `True / structured_text` | 没有几何信息可比对 | Word COM、DOM 这类有文字无坐标的源，只能信 |
| `False / mark_crossed_no_element` | 笔画包围盒和所有元素矩形都不相交 | 划在了元素之间的空白上 |
| `False / container_not_selection` | 相交的最高矩形 **高 > 窗口高×0.5 且 高 > 笔画高×6** | 读到的是承载它的那个面板/聊天记录/控制台缓冲，不是那一行 |
| `True / structured_text` | 其余 | 读对了 |

两个比例常数（第 24-27 行）：`CONTAINER_WINDOW_HEIGHT_RATIO = 0.5`、`CONTAINER_MARK_HEIGHT_RATIO = 6.0`。
第二个的注释很关键：*"A paragraph that is a few lines taller than one underline is a perfectly ordinary read."*——比划线高几行的段落是正常读取，高 6 倍才是容器。

**这就是你问的「漏判怎么办」的技术答案：MP 已经有一个专门判断自己有没有漏判的模块。** 它现在缺的只是把这个判断**告诉用户**。

## T8 融合：把几路观测裁成一个结论

`app/perception/fusion.py`。纯函数，无 IO——同一组观测在任何进程里融合出的结论必须一致。

**排序键**（`_rank_key`，第 103-114 行），从高到低：

```
1. covers_mark is False       → 排最后    ← "读对东西"压倒一切其他质量
2. container_hint             → 次后
3. status == DEGRADED         → 再次
4. tier 顺序                  → structured 优先于 pixel
5. provider 自己的 priority
6. -confidence                → 置信度高的靠前
7. provider_id                → 定序，保证可复现
```

第一条的注释是整个模块的立意：*"A perfect read of the wrong thing is the failure this whole layer exists to prevent."*——完美地读错东西，正是这一层存在的意义。

**要不要跑 OCR**（`pixel_tier_warranted`，第 132-154 行）：**只有当**存在一条既 `marked_content` 又非 `container_hint` 的观测时才跳过 OCR。其余情况（没有结构化 provider / 只拿到容器 / 没覆盖到笔画 / 读取失败）**一律跑**。

**内容一致性**（`texts_agree`，第 52-71 行）——这个函数设计得很好：

```
先精确比对数字：_numbers("Invoice total: 120") != _numbers("Invoice total: 210") → 直接判冲突
其余走 bigram（相邻二字组）Jaccard 相似度 ≥ 0.6
```

注释解释得很到位：*"'Invoice total: 120' and 'Invoice total: 210' are 70% similar as text and completely different as facts."*
—— 两个字符串 70% 相似，但作为事实完全不同。**数字必须精确匹配，其余容忍识别噪声。**

两路读出来不一致 → 记 `conflict`；一致 → 记 `corroboration`（互证）。
两者都进 trace，最后能在诊断页看到。

## T9 像素层：把一条笔画吸附到一行文字

`app/grounding/ocr_mark_selection.py`。**这是 MP 处理「划不准」最精妙的一段代码，也是你该往结构化侧复制的那个思想。**

问题：用户划一条下划线，想选的是**线上面**那一行。但线本身落在两行之间的空隙里，对称地把矩形往外扩会同时吃到下面那行。

解法（`_row_cost`，第 62-95 行）是一个**非对称成本函数**：

```
容差 tolerance = 14px
边缘带 edge_band = clamp(行高 × 0.12, 2, 4)

笔画点 y 相对于候选行 [top, bottom]：
  y < top（笔画在行上方）      → cost = gap + 10      ← BELOW_STROKE_PENALTY_PX 惩罚
  y > bottom（笔画在行下方）   → cost = gap           ← 不惩罚，这是下划线的正常位置
  top < y ≤ top + edge_band    → cost = 10 - (y-top)  ← 刚进入行的顶部，仍带惩罚
  行内其余                     → cost = -min(y-top, bottom-y)  ← 越靠行中心越负（越好）
```

大白话：**笔画在某一行下方，是这一行的下划线；笔画在某一行上方，多半是上一行的下划线，罚它 10 像素。**
但一条真的划穿了文字中心的删除线，仍然能靠负成本赢过上面那行。

选出成本最低的那一行之后，再做一次**同行归拢**（第 126-131 行）：把所有 `top` 与获胜行相差
`≤ max(4, min(两者行高) × 0.35)` 的 OCR 框全收进来——因为 OCR 常把一行切成好几块。

这一段的价值：**它承认用户划不准，然后用「人是怎么画下划线的」这个先验去补。** 这就是自由手势的正确工程化方式。

## T10（可选，花钱）看一眼

`app/perception/visual_once.py` 的 `should_look_once`：只有在
`covers_mark == False` **且** 有 visual_anchor **且** 有冻结帧 **且** 配了视觉模型
四个条件同时成立时，才调一次视觉模型。

注释：*"Conversation turns without a frozen crop stay honest: they never call look from here."*
——没有冻结裁剪的对话轮次绝不从这里调视觉。不会凭空捏造「我看了一眼」。

## T11 交给 Agent loop

用户在胶囊里打字/说话 → `scripts/selection_bridge.py` 的 `main()`（第 2726 行）。

顺序（每一步都打 `clock.mark`，所以每一段耗时在轨迹页上都能看到）：

```
payload_read
  → _context_from_snapshot           取回 T6 的快照
  → （冻结帧 TTL 120s 检查）
  → _fuse_pixel_tier                 像素层在这里跑，跑在冻结帧上，本地，永不外发
  → _enrich_interaction_episode_ocr
  → _enrich_local_file_context
  → _exact_readback_response         如果用户只是要"把这行原样念给我"，直接结算，不调模型
  → ...各种专用路由（评审 / 购物清单 / 日历 / 路线）...
  → _loop_router                     兜底：进 Agent loop
```

`_loop_router`（第 2082 行）调 `run_agent_turn`，
`SELECTION_BUDGETS` 给 FULL_ANSWER **5 分钟**（第 2042-2048 行），
证据以 `ORIGIN_DATA`（数据通道，非指令通道）注入——屏幕上的文字**永远不能**当成用户指令。

**冻结帧过期的降级**（第 2778-2809 行）很值得一提：TTL 是 120 秒，比一轮长答案的往返还短，所以第二条追问必然撞上。
现在的处理是：如果这个会话已经有历史，**只宣布「屏幕证据不可信」并继续**，把上下文交给对话历史；没有历史才整轮失败，且给人话（「重新圈选一次即可」）。

## T12 如果要写回：锚点五态

只读问答到 T11 就结束了。要写回（改 Word 里那段话、往微信输入框填字）就多一整层：
`app/anchor/resolver.py` 的 `AnchorResolver.resolve()`，**降级阶梯**从最稳定的证据开始：

| 层 | 判据 | 结论 |
|---|---|---|
| 1. 应用身份 | 进程 + 窗口还在吗 | 不在 → `gone` |
| 2. 结构路径 | 结构探针找到几个候选 | 2 个以上 → `ambiguous`（**绝不自动挑**）；1 个且哈希匹配 → `exact`；1 个但哈希不同 → `changed` |
| 3. 内容哈希 | 没有结构候选时，读上次位置的内容哈希 | 匹配 → `moved`；不匹配 → `changed` |
| 4. 空间兜底 | 空间探针报告现在在哪 | 有 → `moved`；没有 → `gone` |

模块开头一句：*"`ambiguous` 和 `changed` 是一等结果，永远不会被折叠成 `exact` —— 这是「写到错误位置」经过复盘确认的根因。"*

这一整层 Everywhere 不需要（它主要是只读问答），Google 的 Circle to Search 也不需要（纯检索）。
**这是 MP 独有的、也是最难的部分。**

---

# 第 3 部分：Google 会怎么做（推测，标注了哪些是已知哪些是推断）

## 3.1 先说清楚我知道什么、不知道什么

**已知**：Google 在 Android 上有 **Circle to Search**（2024 年 1 月随 Galaxy S24 / Pixel 发布）：长按 Home 键或导航条 → 当前画面「凝固」→ 用户可以**圈、涂、划线、点**任意屏幕内容 → 结果以底部抽屉（bottom sheet）形式出现。它的交互模型和 MP 几乎一模一样——**你说你是仿照它做的，这个判断是对的**。

**不确定**：一个确切叫 "Magic Pointer" 的 Google 产品的具体形态和实现细节，我不掌握可靠信息。下面凡是讲实现的，都是**基于公开的 Android 架构常识 + Circle to Search 的可观察行为做的推断**，不是内部信息。我会标出来。

## 3.2 他们不需要解决的问题（结构性优势）

这一节比「他们怎么做」更重要，因为它解释了**为什么 MP 的代码必须比他们复杂**。

### (1) 截屏：他们是系统的一部分

Circle to Search 跑在 **SystemUI**（Android 的系统界面进程，状态栏、导航条、最近任务都是它）里。
它拿当前画面不需要任何截屏 API、不需要权限弹窗、不需要排除自己的窗口——它**就是**合成器的一层，直接从 SurfaceFlinger 拿。

MP 要：WGC 捕获 → `overlayExcluded` 标记 → FrameLease 契约 → 双端校验器 → 内容哈希防篡改（`electron/frame_lease.ts` + `scripts/frame_lease.py`，两百多行只为保证「你看到的就是我读的」）。

**Everywhere 那四篇设计手记里的所有痛苦，本质上都是「我是个第三方应用，但我要装成系统的一部分」。Google 不用装。**

### (2) 坐标空间：他们只有一个

Android：一块屏幕，一个密度（density），一套坐标。
Windows：逻辑 DIP / 物理像素 / 窗口客户区坐标 / 多显示器各自不同的 `scaleFactor`，还有 Electron 自己的一套。
`electron/coordinate_space.ts` 整整 364 行、`main.ts:3805-3815` 那段「物理点当 DIP 用会把胶囊挤到屏幕角落」的注释——**这一整类 bug 在 Android 上不存在**。

### (3) 无障碍树：他们大概根本不用

**这是我最重要的推断**：Circle to Search 的行为强烈暗示它是 **纯像素 + 服务端多模态模型**，不走 `AccessibilityNodeInfo`（Android 的无障碍树，相当于 UIA）。

依据：
- 它对**任何内容**都有效，包括视频画面、游戏、图片里的文字、别人发的截图。无障碍树在这些场景里什么都没有。
- 它返回的是**搜索结果**，不是「这个按钮叫什么」。
- 圈住一个包的照片能识别出款式——这只可能是视觉模型。

**这个选择带来的连锁效应，就是 MP 和它最大的架构分歧：**

| | Google | MP |
|---|---|---|
| 主证据源 | 像素 + 自家视觉模型 | UIA / COM / DOM 结构化读取 |
| 视觉调用成本 | 内部成本，自家 TPU，延迟可控 | 外部网关，一次调用又慢又贵 |
| 因此 | 每次都看图，不需要「有没有读对」这个概念 | **必须**尽量用结构化读取省钱，于是**必须**有 `covers_mark` 判断自己读没读对 |
| 融合层 | 不需要（只有一路证据） | 必需（`fusion.py` 334 行） |

**换句话说：MP 的 `marked_read.py` + `fusion.py` + `providers.py` 这一整套，是「视觉调用很贵」这个约束的产物。Google 没有这个约束，所以不会写这套东西。**

如果哪天 MP 能用上便宜、快、且能跑在本机的视觉模型，这一整层的存在意义会大幅下降。这是一个值得记住的战略判断。

### (4) 他们不写回

Circle to Search 是**只读检索**。它不需要 `AnchorResolver` 的五态、不需要 undo log、不需要 `action_guard`、不需要审批卡。
MP 的第 T12 步——那一整层——他们不需要。

## 3.3 他们做得比 MP 好的地方（应该学的）

### 分割（segmentation）——这是最大的能力差距

**推断，但把握较大**：Circle to Search 用的是真正的图像分割。你随手圈一个大概的圈，它吸附到的是**物体的真实轮廓**（一只鞋、一件衣服、一段文字块），不是你画的那个椭圆的包围盒。

MP 现在能吸附到的候选是：
- OCR 的文本行矩形（`ocr_mark_selection.py`）
- UIA 的元素矩形（`marked_read.py` 里当判据用，没当候选源用）

**没有任何非文本的视觉对象概念。** 圈一张图里的一只猫，MP 只能给出一个矩形裁剪。

这是「怎么把表征做好」的最终答案：**表征的质量上限，取决于你的候选对象集合有多丰富。**
- Everywhere 的候选集 = UIA 元素树（在浏览器里很丰富，在游戏/图片里为空）
- MP 的候选集 = OCR 行 + UIA 矩形（比 Everywhere 好一些，但仍然是「文字和控件」）
- Google 的候选集 = 视觉分割出的**任意物体** + OCR 行 + 页面结构

MP 短期能做的最实际的一步：**把 UIA 元素矩形从「判据」升级成「候选源」**（见第 4 部分）。这不需要任何模型，是纯几何工作。

### 凝固（freeze）的视觉语言

Circle to Search 长按后画面会有一个明显的「凝固」动效——轻微缩放 + 变暗 + 一个微妙的边框。用户**立刻知道**「现在这一帧被锁住了，我可以放心画」。

MP 技术上做的是同一件事（FrameLease 就是凝固），但**用户看不到凝固发生**。overlay 出现了，但画面看起来还是活的。
这是一个纯视觉的、零技术风险的改进，而且它会顺带解释「为什么我划完之后画面变了但答案还是旧的」——因为凝固过。

## 3.4 一句话总结这个对比

> DeepMind 的工程师不会写 MP 的 `fusion.py`——因为他们不需要。
> 他们的难题在别处：分割质量、端上延迟、检索排序。
>
> MP 的复杂度不是过度设计，是**「第三方应用 + Windows + 外部模型 + 要写回」这四个约束的必然代价**。
> 你不该拿它跟 Google 的简洁比，该拿它跟 Everywhere 比——同样是第三方 Windows 应用，
> Everywhere 为了做到一件更简单的事（选一个 UIA 元素），付出了逆向 `UIAutomationCore.dll` 的代价。
>
> **MP 的路线是对的。缺的不是架构，是那三步用户可见的闭环。**

---

# 第 4 部分：决策落地——具体做什么

按性价比排序。前两条不需要任何模型调用，纯前端 + 已有数据。

## 决策 1：grounding 回显（必做，收益最大）

**做什么**：结构化/像素读取落地、`covers_mark` 判定完成的那一刻，把系统认定的那块区域在原位画一次。

- 淡入 120ms → 停 800ms → 淡出 200ms
- `covers_mark == True` → 用确认色（比如现有的绿）
- `covers_mark == False` → 用存疑色（比如琥珀），并且**不要淡出**，留着等用户处理

**数据从哪来**：`snapshot["perception_trace"]` 里已经有 `marksCovered`；元素矩形在
`app/perception/providers.py:389` 的 `context_rectangles()` 里；OCR 行矩形在
`select_open_stroke_rect_indexes` 的返回索引对应的框里。**全都已经算好了，现在只是没往上送。**

**为什么这是最重要的一条**：你问的「到底漏判啥了」——现在这个问题只有看日志才能回答。
回显之后，用户在 1 秒内就知道。判错的成本从「答案莫名其妙 + 不知道为什么」降到「哦它选窄了，我扩一下」。

## 决策 2：两向改判芯片（必做）

回显出现时，胶囊上挂两个芯片：

```
[ ↑ 扩到整段 ]   [ ↓ 缩到这个词 ]
```

语义：
- **扩**：在候选集合里往上找包含当前选中矩形的下一级（OCR：本行 → 本段 → 本块；UIA：当前元素 → 父元素）
- **缩**：往下找当前矩形内、离笔画中心最近的下一级（OCR：本行 → 笔画横向覆盖的那几个词；UIA：当前元素 → 命中的子元素）

**这是 Everywhere 滚轮切粒度的正确版本**：一样的能力，但发生在用户看到结果之后，而不是要求用户预先理解 UIA 树。

`covers_mark == False` 时，芯片换成三个更直接的：
```
[ 就是这行 ]   [ 换上一行 ]   [ 扩到整段 ]
```
**在调 `look_once` 视觉模型之前先给这个。** 0 成本，而且用户是唯一知道答案的人。

## 决策 3：把 UIA 元素矩形升级成候选源（值得做）

现在 `app/grounding/marked_read.py` 的 `structured_read_covers_mark` 拿 `element_rects` 只做一件事：
判断「相交的最高矩形是不是容器」。**这些矩形本身被扔掉了。**

应该新增一个和 `ocr_mark_selection.py` 对称的模块——比如
`app/grounding/uia_mark_selection.py`——干同一件事，但对象是 UIA 矩形：

- 输入：笔画几何（`polygon_region` 或 `band_corridor`）+ 元素矩形列表 + 窗口信息
- 输出：按「被笔画覆盖的程度」排序的候选索引列表，容器（`rect_is_container` 判 True 的）排最后
- 覆盖度算法：对 `band_corridor` 用走廊多边形与矩形的**面积交比**；对 `polygon_region` 同理；
  对 `point_target` 用「包含该点的最小矩形」

有了这个，决策 2 的「扩/缩」在结构化侧才有东西可翻，而且圈选（circle）在非文本界面上第一次有了真正的对象概念。

## 决策 4：试一下 `WS_EX_LAYERED alpha=254`（成本极低，值得一试）

Everywhere 第四篇文档挖出来的：全屏不透明窗口会触发 **Chromium 渲染器休眠**，
Chromium 会把承载 DOM 无障碍树的窗口从可见窗口树上摘走，导致 UIA 只能读到窗口级信息。

MP 的 overlay 同样是全屏窗口。**如果 MP 曾经出现过「在浏览器 / VS Code / Electron 应用 / 新版微信里只读到窗口标题」的现象，这很可能就是根因之一**——而且它会伪装成「UIA 读不到」，跟你 memory 里记的「UIA 返回容器名」是同一类症状。

试法：在 overlay 窗口创建后拿到 HWND，加 `WS_EX_LAYERED` 并
`SetLayeredWindowAttributes(hwnd, 0, 254, LWA_ALPHA)`。**必须是 254 不是 255**——255 等于没设。
视觉上看不出区别。

MP 的情况比 Everywhere 好一点：MP 的 UIA 读取发生在 **overlay 已经撤掉之后**（`main.ts:3828` 的 `hideOverlay()` 在 `beginSelectionSession` 开头）。
但 arm 阶段 overlay 是显示着的，而且 Chromium 的休眠有滞后——摘下来的树不会因为你撤了窗口就立刻挂回去。**所以仍然值得测。**

验证方法：打开一个 Electron 应用（VS Code 就行），划一行代码，看 `perception_trace.coverageReason`。
如果是 `container_not_selection` 或 `identity_only`，就是这个问题。

## 决策 5：凝固要看得见（低优先级，纯视觉）

FrameLease 提交成功的那一刻（`capture_commit_coordinator.ts:146` 状态变 `committed`），
给屏幕一个 150ms 的极轻微变暗 + 边框脉冲。

技术上什么都不改，但它让「我锁住了这一帧」这件事变成用户的认知，而不是只存在于 `frame_lease.ts` 的类型定义里。

---

# 第 5 部分：一句话回答你的原问题

> **「太规矩的框不如自由的好，但太自由又划不准，怎么整？」**

自由是**输入**的属性，准确是**输出**的属性，这两件事不用互相让步。

- 输入端：保持现在的自由（点/线/圈/涂/多笔）。这是 MP 相对 Everywhere 的真实优势，别退。
- 输出端：**吸附**到候选对象（已有一半）→ **画出来**（缺）→ **让用户一键改判**（缺）。
- 漏判的兜底：MP 已经有 `covers_mark` 这个「我知道我可能读错了」的自省信号。
  现在它触发的是**花钱的视觉调用**；应该先触发**免费的一句问**。

Everywhere 用「规矩」换来的是**确定性可见**——它的高亮框让用户永远知道系统认定了什么。
这一点它是对的，而且这一点跟自由输入毫不冲突。

**把它的高亮学过来，把它的悬停选元素扔掉。这就是答案。**
