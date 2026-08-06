# Clicky 源码分析报告

来源：`external/clicky/` | 7600 行 Swift | macOS 菜单栏 AI 伴侣 | 7K GitHub Stars

## 是什么

Clicky = macOS 状态栏图标 + 按住 ctrl+option 说话 + 截图发 Claude + Claude 文本流回 + ElevenLabs 语音播报 + 蓝色光标飞指向 UI 元素。

**核心理念**：不是聊天窗口——是一只蓝色小三角光标跟着你的鼠标，当 Claude 提到某个 UI 元素时，光标会沿贝塞尔弧线飞过去指向它，同时显示气泡文字。

## 与 Magic Pointer 的相似与差异

| | Clicky | Magic Pointer |
|---|---|---|
| 触发 | push-to-talk (ctrl+option) | 鼠标晃动 |
| 截图 | 全屏，每次对话都发 | 仅用户画选区时截 |
| AI | Claude API (cloud) | 30 Recipe 本地优先，Agent 可选 |
| 语音 | AssemblyAI (cloud) | 本地 Whisper/SenseVoice |
| 平台 | macOS only | Windows + macOS |
| 交互 | 说话→截图→Claude→语音回答 | 晃动→划线→语音→Recipe 执行 |
| 光标动画 | 贝塞尔弧线飞行+气泡+指向 | 蓝色圆点跟随（简单） |
| API 密钥 | Cloudflare Worker 代理 | 本地 safeStorage |

## 8 个可以直接借鉴的技术点

### 1. ElementLocationDetector（最值钱）

`ElementLocationDetector.swift` — 用 Claude Computer Use API 精确定位 UI 元素。

**核心技巧**：
- **宽高比匹配**：不是固定 1024x768（4:3）。Mac 屏幕多是 16:10→1280x800，选最近宽高比避免截图变形导致 X 轴偏差。
- **Retina 修复**：直接用 `NSBitmapImageRep` 创建精确像素位图，绕开 `NSImage.lockFocus()` 在 Retina 屏上双倍像素的 bug。
- **Computer Use Beta Header**：`anthropic-beta: computer-use-2025-11-24` + `tools: [{type: "computer_20251124", display_width_px, display_height_px}]` 激活 Claude 的像素计数训练——比普通 vision API 坐标准得多。
- **坐标变换链**：Computer Use 坐标（顶左原点）→ 实际屏幕点映射 → 底左原点（AppKit）。

**Magic Pointer 可复用**：用户画圈后，把选区截图 + voice transcript 发给 Claude Computer Use API → Claude 返回精确的 UI 元素坐标 → 不再需要 shape 分类。

### 2. OverlayWindow 多屏模式

`OverlayWindow.swift` — 每个屏幕一个透明全屏窗口。

```
level: .screenSaver          // 在子菜单和弹窗之上
ignoresMouseEvents: true     // 点击穿透
collectionBehavior: [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
canBecomeKey: false          // 不抢焦点
canBecomeMain: false
```

**Magic Pointer 已有**：类似的 overlay 窗口（`alwaysOnTop: true, 'screen-saver'`）。但缺少 per-display overlay 实例。

### 3. 贝塞尔弧线飞行动画

`animateBezierFlightArc` — 光标从当前位置沿二次贝塞尔曲线飞向目标。

```
B(t) = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2
B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1)  // 切线 → 光标朝向
```

控制点 P1 在 P0-P2 连线中点之上偏移，产生弧形轨迹。用 `Timer` 每帧（1/60s）更新位置。`atan2` 切线方向旋转光标三角形朝向运动方向。

**Magic Pointer 可复用**：结果展示时，光标从选区位置飞向气泡/结果位置。

### 4. 状态机驱动 UI

`CompanionManager.swift` — 中心状态机：

```
voiceState: idle → listening → processing → responding → idle
```

每个状态直接驱动 cursor overlay、waveform/spinner/bubble 的显示。@Published 属性让所有 SwiftUI view 自动响应。

**Magic Pointer 可改进**：当前 main.js 3255 行没有明确状态机，overlay/stage/dashboard 之间的切换散落各处。

### 5. Cloudflare Worker API 代理

`worker/src/index.ts` — 142 行。三个路由：POST /chat、POST /tts、POST /transcribe-token。所有 API key 在 Worker secrets 中，客户端零密钥。

**Magic Pointer 可复用**：如果有朝一日接云端模型，照搬这个模式。当前全是本地，暂时不需要。

### 6. Push-to-talk 全局快捷键

`GlobalPushToTalkShortcutMonitor.swift` — 用 `CGEvent` tap（监听级，非拦截级）监听系统范围按键。比 `NSEvent.addGlobalMonitorForEvents` 更可靠地检测 modifier 组合键（ctrl+option）。

**Magic Pointer 已有**：`globalShortcut.register` + `wiggle_detector.js` 鼠标检测。但点击退出 bug 可能与此相关——CGEvent tap 的思路可在 mousedown→dismiss 路径上参考。

### 7. 波形 + Spinner + 气泡状态动画

`BlueCursorView` — 小三角光标在三种状态间切换：
- idle: 蓝色发光三角形跟随鼠标（spring 动画）
- listening: 变成了音频波形条（5 条竖线，高度随实时音量脉动）
- processing: 变成了旋转 spinner（3 个圆点，椭圆旋转）
- responding: 显示 Claude 的流式文本气泡

全部在 SwiftUI 中，用 `TimelineView(.animation(minimumInterval: 1.0/36.0))` 驱动波形。

**Magic Pointer 可改进**：当前 overlay cursor 只有一个静态蓝色圆点，没有状态动画。

### 8. 多 transcription provider 可插拔

`BuddyTranscriptionProvider.swift` — 协议 + 工厂模式：
```swift
protocol BuddyTranscriptionProvider { ... }
// Factory resolves provider from Info.plist setting
// AssemblyAI (cloud streaming websocket)
// OpenAI (cloud upload WAV)
// Apple Speech (local fallback)
```

同一个 `BuddyDictationManager` 不管用哪个 provider，接口一致。

**Magic Pointer 已有类似**：`voice_resident_runtime.js` + `voice_worker_client.js`，Whisper/SenseVoice 双后端。但 provider 选择目前要走 settings→重启，不如 clicky 的 Info.plist 实时切换灵活。

## 我们比 clicky 多什么

- 30 个可组合 Recipe（不只是一个 ChatGPT 对话）
- 原生应用接口（UIA/Office/DOM，不只是截图）
- 跨平台（Windows+macOS，不只是 Mac）
- 本地离线（不全靠云 API）
- Dashboard 治理（权限/审计/隐私/诊断）
- Agent 集成（Codex/Pi/Claude/Gemini 直连，不只是 Claude）

## clicky 比我们多什么（应该补齐的）

1. **Element Location Detection → 手势理解**：Claude Computer Use API 可以告诉你用户画的那个圈里到底是什么 UI 元素。这是解决"圈一行取到上一行"问题的直接路径。
2. **Cursor 动画系统**：贝塞尔飞行+气泡文字+三角朝向。这是"体验"差距——用户感觉"AI 真的在屏幕上找东西"。
3. **状态机驱动 UI**：CompanionManager 的 idle/listening/processing/responding 四态清晰。我们 overlay/stage/dashboard 切换松散。
4. **API 代理模式**：未来接云端模型时的安全实践。
5. **Per-display overlay**：多屏下每个屏幕独立 overlay 实例。

## 下一步

优先级：
1. **接 Claude Computer Use API** 到选区的 grounding 流程——这是解决当前最大 bug（选不准）的最快路径
2. **Overlay 光标状态动画**（波形→spinner→气泡）——提升体验感知最明显
3. **中心状态机重构 main.js**——长期可维护性
