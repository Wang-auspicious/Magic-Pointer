# Magic Pointer — 项目状态与方向总纲（持续更新）

> 本文件是 8/1 那场 74MB 会话的浓缩版知识库。**任何新会话先读本文件 + `AGENT.md`**，
> 不要再重读那份超大历史（路径见文末）。每次会话结束必须回来更新本文件与 `AGENT.md`。

## 1. 一句话定位

Magic Pointer = Windows 上默认不可见的跨应用操作层：晃动鼠标唤醒 → 划线/圈选指向屏幕上的东西 → 语音/文字说出意图 → AI 读对目标、给出回答或执行。**完整对标产品是 Google Magic Pointer（指+说+看+做一条龙）**，Windows 目前是空窗，这是我们真实的机会。

### 竞品主次（别再搞混）
| 产品 | 地位 | 我们能拿什么 |
|---|---|---|
| **Google Magic Pointer** | **完整对标目标**（整个产品） | 产品形态、划线视觉风格、指代交互范式 |
| **Speak to Window**（2026-07-29 发布，macOS，云端 Gemini 流式听写） | **可整块搬的组件** = "说"这一块 | 云端流式语音转写思路；**Google 语音就是云端大模型转写，比本地 whisper 准** |
| **clicky / clicky-windows** | **可整块搬的组件** = "指了就说就做"交互循环 | 三级递进感知、光标飞指、push-to-talk |
| UFO²（微软）、Pi、UI-TARS/OmniParser | 借鉴模式/只借合同 | 复用适配器、工具循环，不搬整套架构 |

**核心差异化空位**（Google / Speak to Window / clicky 都没做）：把"指着的内容 + 说的话"打包好，投递给正在运行的 Agent（Codex/Claude/CLI/GUI）的输入侧——先弹预览框可改，确认后一键送达，不用切窗口按 Enter。

### 语音在主功能里的位置
- 语音是 MP 的一半体验，不是附加功能。**方向 = 可插拔**：默认接云端/中转流式（准、快），本地 whisper 只做离线兜底；兼容用户已有的外接语音设备/听写工具（Handy 等）的快捷键习惯。
- 但语音是**第二步**。第一步是把"指得对"修稳（见下），因为"说"已有可跑路径，"指"还不稳定。

## 2. 用户交流偏好（每次会话必须遵守）

- **大白话**，像两个行业熟人聊天；不要术语绕弯、不要长段落。
- 不要中途停下问、不要浪费额度；调研类任务要全面（"知己知彼"）。
- 浏览器/需要登录的操作必须在**用户自己的 Edge 里**做，不要在 Codex 里弹窗（用户负责登录）。
- 能用 caveman 压缩表达就压缩，省 token。

## 3. 当前设计抉择的困境（8/1 晚到 8/2）

**主链路**：划线/圈选 → 读对目标 → 模型看到对的 → 回答/执行。
**反复卡的三个点**：
1. 截图黑帧 / 截图慢 / 截图在语音球之后才到。
2. UIA 读错行：圈的上沿（上一行）被当成目标，圈内真正的版本号读不到。
3. 带尾巴、略有开口的圈被判成直线，区域枚举根本没执行。

**用户明确的设计主张（"能读就别看"）**：
- 不要"画个圈 → 裁小图 → 丢给模型 OCR 自己猜"。要**全局截图 + 圈只做定位标签（不挡住内容）+ 所有能拿到的窗口元件用框标出来、文字读出来**，再交给 AI/API。全局图太大压缩会丢细节，且这样隐私更好。
- 结构化能读到的（UIA/DOM/Office COM）就是真相；截图只是证据；读不到才落到 OCR/视觉。

## 4. 已定位根因与修复记录（避免重复踩坑）

| 症状 | 根因 | 修复状态 |
|---|---|---|
| 截图是纯黑 640×420 | `selection_snapshot_bridge.py` 用窗口句柄直接捕获 Electron GPU 窗口拿到黑帧 | ✅ 黑帧自动退回全桌面裁剪（`ef3150d`） |
| 模型说"暂时无法读取可靠对象" | ① 截图成功但 `screen_region.content=""`；② `base.py` 把"有 artifacts"当 `has_content=True` 提前返回，跳过 OCR；③ 后面又因 content 空判为不可靠 → 自相矛盾 | ✅ content 为空就跑本地 OCR（RapidOCR→Tesseract 兜底），标注 `local:rapidocr-onnx` |
| 圈选读成上面一行 | 只沿手势边界抽 9 点 `ElementFromPoint`，评分还奖励"横线上方一行" | ✅ 圈选=闭合区域内元件集合；横线=指向单元件；区域与手势 bbox **相交**即算（未提交批次） |
| 带尾巴的圈被拒绝 | 只比较整条 stroke 首尾距离 | ✅ 允许"闭环中间结束 + 短尾"（`ef3150d`） |
| **8/2 补的洞**：结构化读到了 "Row B"，但手势强制全屏截图后 `visual_context`（空 content）把结构化的 content 顶掉了 | 截图标注只应作证据，不该替换真相 | ✅ 结构化命中时 `context.content` 保留结构化文本；截图+标注挂 `artifacts`（capture_path/annotated_path/capture_bbox）；`source_kind=native_selection`；只有结构化失败才用 `screen_region` 当 context |
| 语音球没说话就报红 | SenseVoice 声音活动先发空 `partial`，worker 当成非法转写 | ✅ 空 partial = 开始监听，不报错（`68e92af`） |

## 5. 调研结论浓缩（知己知彼，细节见 `MAGIC_POINTER_MATURE_ARCHITECTURE_20260801.md`）

- **UIA 不是 YOLO**：UIA 是应用主动暴露的"信息表"（控件类型、名称、位置、文本），不是视觉识别。**自绘界面（微信 4.0 DuiLib、Flutter、Unity、部分 Electron 游戏）对 UIA 完全隐形**。
- **Electron/Chromium 无障碍树是懒加载**：需要 `--force-renderer-accessibility` 或常驻 UIA 客户端保持激活，否则 `ElementFromPoint` 时灵时不灵。**事件驱动 > 轮询**。
- **UFO²（微软）**：UIA + OmniParser 视觉混合；执行时优先软件原生 API（xlwings/win32com），GUI 点击是兜底。源码在 `external/ufo/`。
- **clicky-windows**：三级递进 UIA(~5ms) → 本地 RapidOCR(~300ms) → 视觉 LLM(1-3s)；UIA 先锁前台窗口再遍历，限 3500 节点/40 深度。源码 `external/clicky-windows/ai/hybrid_pointer.py`。**我们的感知策略就采用这个三级递进。**
- **微信自绘界面**：Quicker 社区做法 = 逆向调微信自带 OCR（WeChatOCR.exe/wxocr.dll）或 PaddleOCR/视觉模型。
- **社区情报**：延迟是生死线（"200ms 定位救不了 800ms 推理"）；隐私顾虑（屏内容上 Google 服务器）；夸 Clicky 开源可审计、UI-TARS 可全本地。**Windows 上"指+说+发给 Agent"仍是空窗。**

## 6. 当前代码状态（2026-08-02）

- Git 基线：`82a7aaa`（8/1 13:53 完整封存一版）→ `ef3150d`（黑帧降级+本地 OCR）。
- **未提交 9 个文件**（正在实现"先冻结+全局截图再出语音球 + 圈做定位标签 + 元件框标注 + 视觉 API 开关"）：
  `app/visual_annotation.py`、`electron/main.js`、`scripts/selection_bridge.py`、`scripts/selection_snapshot_bridge.py`、`scripts/uia_selection_probe.cs`、`tests/gesture_activation_integration_test.js`、`tests/selection_bridge_test.py`、`tests/selection_snapshot_bridge_test.py`、`tests/uia_pointer_selection_contract_test.py` + 新增 `tests/visual_annotation_test.py`。
- 这批改动要点：
  - 手势存在时永远来一张**全局截图**（虚拟桌面边界，含负坐标多屏），圈画成 "THIS" 定位标签 + 手势轨迹，**最多 24 个元件框 + 编号**（cyan）。
  - `selection_bbox` = 手势 bbox 或结构化读到的元件并集。
  - 视觉模型（`ask_vision_model`，当前中转 gpt-5.4-mini）**只在用户授权上传截图时**调用：全局原图 + 标注图 + selection_bbox + 结构化文本一起给。
  - 主进程：手势 → `FREEZE → OPEN_CAPSULE`，语音球等快照启动后才显示。
- 测试全绿：**Python 655 passed / Node 115 passed（56 源文件）**。唯一失败测试已修：
  `test_full_gesture_trace_drives_structured_grounding_instead_of_fallback_point`（结构化命中时 context 必须保留 "Row B"）。

## 7. 下一步（按序）

1. **提交这批未提交改动**（全绿，可安全封存）。
2. **真机端到端验收**（这条是硬门槛）：用真实窗口——设置页版本号、微信、Excel——各划一次/圈一次，确认 `selectionSnapshot.context.content` 非空且是画中的内容，回答里不再出现"暂时无法读取可靠对象"。
3. 语音上云（可插拔：云端/中转流式默认，本地 whisper 兜底）。
4. 长期架构（已定稿于 `MAGIC_POINTER_MATURE_ARCHITECTURE_20260801.md`）：统一四套状态为 episode 事件流（Episode→ReferentGraph→IntentFrame→TaskTransaction）、Geometry Authority（多屏/异构 DPI 唯一坐标真值）、Native Input Gate（不依赖永久透明全屏窗）、逐笔指代绑定、事务执行+验证。

## 8. 会话历史文件位置（仅当需要查细节时才读）

- 主会话（8/1 22:50 仍在做，74MB）：`C:\Users\zjz65\.codex\sessions\2026\08\01\rollout-2026-08-01T11-54-51-019fbb75-d973-7cd0-81b9-b2cc067b97f5.jsonl`
- 7/31 会话（5.2MB）：`C:\Users\zjz65\.codex\sessions\2026\07\31\rollout-2026-07-31T16-34-20-019fb74f-5f57-79f1-b112-af2c8a13c2db.jsonl`
- 更早线程（1MB）：`C:\Users\zjz65\.codex\sessions\2026\07\31\rollout-2026-07-31T15-11-37-019fb703-a34a-7280-8406-39d07a5026ed.jsonl`

## 9. 维护规范

- 每次会话结束：更新本文件（状态/决策/坑/下一步）+ `AGENT.md`（状态快照/已知问题/不要做的事/测试计数）。
- **不要在会话里重读第 8 节的大文件**；需要细节时按第 4/5 节的索引定位。
- 新根因、新决策、新坑 → 立刻追加到第 4 节和 `AGENT.md` 的"不要做的事"。
