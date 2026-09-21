# 启动卡顿归因：屏幕换页，不是 Python

日期：2026-09-21。接续用户「`npm run overlay` 一启动整机卡死、鼠标都动不了」。上一批（`docs/research/2026-09-20-startup-model-canvas-fixes.md`）取消了启动 OCR 热身与模型健康轮询，卡顿仍在，所以这次不猜，先量。

## 结论

**卡顿是整机硬缺页风暴，触发它的是应用启动时一次性提交的内存，不是构建、不是 Python、也不是 Electron 本身。**

启动命令把 ~700MB 新内存压进一台 commit 已到 29–31GB（上限 32.5–34GB）、可用 1.3–3.0GB 的机器，Windows 必须从别处换出同样多的页；那些进程立刻把页从磁盘换回来，磁盘被打满，整机停顿。

## 测出来的证据

同一台机器（16 逻辑核 / 16GB），`scripts/measure_page_storm.ps1` 与 `scripts/measure_overlay_launch.ps1`：

| 动作 | 硬缺页 pages in /s | 磁盘 | 说明 |
|---|---:|---:|---|
| `npm run build:electron`（18–21s） | 峰值 1,513，均值 246 | 峰值 6.2% | 构建无罪，不是用户指的那两行 |
| 裸 Electron（同二进制、空 main、隔离 profile） | 峰值 1,377，均值 72 | — | 无风暴 |
| 真 App 启动，可用 2.4GB | **峰值 59,607** | 170% | 风暴窗口 = electron 进程 7→14 那 4 秒 |
| 真 App 启动，可用 3.0GB | 峰值 5,940 | 23% | 同一份代码，严重度随余量变 |

- 抖动时刻**没有任何进程 `IO Read Bytes/sec` 超过 4MB/s**：流量是换页回来的，不是应用在读文件。
- 空载对照（什么都不启动）130s 内也有 9 次抖动，元凶 `registry`（最高 34k 页错/s）、`msmpeng`（Defender）、`sangforudprotectex`（深信服 EDR）、`chatgpt`。机器本身就在边缘。
- 首次离群读数是 `Get-Counter` 首次调用要 2–3s（丢开头窗口）与重采样器自身的 WMI 开销造成的，重跑时用 12s 固定延迟 + 轻量计数器排除。

**为什么昨天的探针没看到**：`scripts/probe_startup_resources.cjs` 在隔离 profile、关语音、假模型、隐藏窗口下测的是**主线程延迟**（338ms）。风暴不在主线程，在整机换页；那份测量结构上就看不到它。

## 内存归因

`scripts/probe_window_memory.cjs`（逐进程 + 逐窗口，含 GPU 状态）与 `scripts/probe_bare_electron.cjs`（同二进制裸启动，只改窗口形状）：

| 配置 | GPU 工作集 | GPU 私有 | 进程总计 |
|---|---:|---:|---:|
| 1 个小隐藏窗 | 105MB | 73MB | 303MB |
| 1 个全屏透明可见 | 161MB | 127MB | 369MB |
| 3 个全屏透明可见 | 273MB | 249MB | 571MB |
| 3 个全屏不透明可见 | 124MB | 73MB | 455MB |
| **3 个全屏透明隐藏** | **106MB** | 74MB | 434MB |

隐藏的全屏透明窗**不花 GPU**。所以那 160MB 差额不是窗口形状，是窗口里画的东西：

- `electron/renderer/overlay.ts` 在模块末尾无条件 `resize()`，按 `innerWidth×innerHeight×dpr` 分配一份 2D 画布（`#trail`）+ 一份 WebGL2 画布（`#sweep-layer`）。
- `index.html` 同时被**两扇窗口**加载：手势 overlay 与 `AgentCursorSurfaces` 的双子光标表面（`electron/agent_cursor_window.ts`）。双子光标是画在 canvas 上的（`drawAgentCursor`），但只在代理真的移动指针时才画。
- 两份画布 × 两扇窗口 ≈ 160MB，与实测差额吻合。

`gpu_compositing=enabled`，不是软件渲染回退；`getGPUFeatureStatus()` 已核对。

## 已实施

1. **`electron/main.ts`**：`whenReady` 里不再预建 overlay 与 stage 两扇窗口。两者在被用上之前没有用途——`armSelectionGesture()` 第一步调 `ensureFreshGestureOverlay()` 把 overlay 销毁重建（`main.ts:1022`），并自己调 `createStageWindow()` 在宽限期预热 capsule；冷启动唤醒先经过 `queueActivationUntilSurfacesReady()`，那里同样两扇都建。
2. **`electron/renderer/overlay.ts`**：画布按需分配、隐藏时释放。新增 `canvasAllocated` 标志与 `allocateCanvas()` / `releaseCanvas()`；分配点是 `overlay:show`（手势与 `[POINT]` 指点共同的入口）与 `overlay:agent-cursor`；释放点是 `overlay:hide` 与 agent cursor 的 `clear`（后者 main 只调 `hide()`，不走 `overlay:hide`）。`render` / `scheduleRender` / `clear` / `pulseAllowed` / resize 监听全部加闸，未分配时不动手。
3. **`tests/overlay_canvas_lifecycle_static_test.js`**：把上面两条锁成静态契约——分配与释放成对、模块末尾不得无条件 `resize()`、未分配时所有绘制路径都必须早退、`whenReady` 不得预建两扇窗口、而 `queueActivationUntilSurfacesReady` 必须保留按需建立。

## 效果（同机同口径）

| 指标 | 修前 | 修后 |
|---|---:|---:|
| 启动工作集增量 | +709MB | **+406MB** |
| 启动 commit 增量 | +773MB | **+476MB** |
| 新增进程 | 7 | 5 |
| 探针峰值总计 | 646MB | **369MB** |
| GPU 进程 | 267–284MB | **137MB** |

按 4KB 页算，需要换出的页从 ~181k 降到 ~104k（−43%）。

**代价只是搬家，不是消失**：`probe_window_memory.cjs --create-surfaces` 在窗口已存在之前/之后取样，启动后常驻 1 窗 371MB；调同一条手势路径用的两个创建函数之后 3 窗 549MB（+178MB 渲染进程）。画布那 ~127MB 要到真的发 `overlay:show` 才分配，也就是第一次手势时才会补上。稳态占用和修前接近，变的是**不再在启动那一刻付**——启动时用户没在等这个应用，第一次手势时窗口已经起来、人已经在交互。`--create-surfaces` 只建窗口不发 `overlay:show`，所以「画布在第一次手势时分配」这条是静态核对的，没有实机手势计时。

## 边界

- 这减少的是**应用自己压给系统的那部分**。机器基本面没变：commit 仍常在 29–31GB/32.5–34GB，可用 1.3–3.0GB，且跑着 Defender + 深信服两套端点防护。空载抖动仍会发生，那是环境问题，不是 MP 的问题。
- **未做真机手势验收**：本次没有真的划过一笔。`overlay:show` 之外若还有让 overlay 画画的路径，画布就不在那一刻分配。已核对 main 侧只有手势 reveal 与 `guide-point` 两处发 `overlay:show`，但这是静态核对，不是实机走查。
- 双子光标表面的窗口仍常驻（它加载 `index.html`，仍占 ~74MB 渲染进程）。它的画布已按需，窗口本身没动——`agent_cursor_window.ts` 顶部三条硬约束决定了窗口建一次不销毁，改它需要单独一轮。
- 首次手势会比以前多一次窗口创建（约几百毫秒）。`armSelectionGesture` 在宽限期里建，`queueActivationUntilSurfacesReady` 有 readiness 门控兜底；但这条没有实机计时证据。

## 复现

```powershell
# 构建阶段与整机
powershell -File scripts/measure_overlay_launch.ps1 -Phase build
powershell -File scripts/measure_overlay_launch.ps1 -Phase launch
powershell -File scripts/measure_overlay_launch.ps1 -Phase idle      # 空载对照
# 逐进程 / 逐窗口归因
electron scripts/probe_window_memory.cjs
# 窗口形状对照（透明 × 可见性 × 数量）
electron scripts/probe_bare_electron.cjs --count 3 --transparent --visible
```
