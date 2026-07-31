# 给 Terra 的执行 Prompt

下面整段可直接复制给 Terra 模型：

---

你现在接手 `D:\Desktop\Magic Pointer`。这是一次完整产品重构实施，不是调研、不做小 MVP、不只做一个演示功能。你单 Agent 执行，不创建子 Agent，不停下来向用户提问；先从本地文件恢复上下文，做出合理决定后持续施工。除真正缺少外部账号或 macOS 实机外，不以“需要用户确认方向”为理由停工。

你的唯一主规格是：

`D:\Desktop\Magic Pointer\PRODUCT_ECOSYSTEM_DETAILED_PLAN_20260727.md`

先完整阅读以下文件：

1. `PRODUCT_ECOSYSTEM_DETAILED_PLAN_20260727.md`
2. `COMMUNITY_DEMAND_AND_BUILD_LOG_20260726.md`
3. `IMPLEMENTATION_STATUS_20260726.md`
4. `GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md`
5. `docs/superpowers/specs/2026-07-26-demo-grade-interaction-layer-design.md`
6. `docs/superpowers/specs/2026-07-26-community-demand-object-bridge-design.md`
7. `EXTERNAL_COMPONENTS.md`
8. `D:\AI_Agents\HermesAgent\apps\desktop\DESIGN.md`
9. `D:\AI_Agents\HermesAgent\apps\desktop\electron\bootstrap-runner.ts`
10. `D:\AI_Agents\HermesAgent\apps\desktop\src\components\desktop-install-overlay.tsx`
11. `C:\Users\zjz65\.codex\skills\apple-design\SKILL.md`

逐帧参考本地：

- `演示7.webm`–`演示10.webm`
- `data/runtime/video-frame-review-20260726/`
- 当前 UI 截图 `data/runtime/text-bubble-growing-e2e-clean.png`、`data/runtime/voice-bubble-local-clean.png`、`data/runtime/dashboard-screenshot.png`

硬性保护：

- 当前工作树有大量用户/前序 Agent 的未提交修改，全部保留；
- `PROGRESS_20260726_NIGHT2.md` 是用户文件，绝对不修改、删除、覆盖；
- 禁止 `git reset --hard`、`git checkout --` 或任何批量回滚；
- 不擅自 commit、push；
- 所有文本编辑使用 `apply_patch`；
- 不复制未确认许可证的源码；AionUi Apache-2.0、Hermes MIT 仍需保留归属记录；FrameCue 只借鉴行为，不复制代码；
- 不迁移 React，不把 AionUi/Hermes 整套 UI 搬进来；
- 不把 MCP 当主接入；长连接/ACP/app-server/RPC/hooks 优先；
- 不伪造外部完成，不把 queued/accepted 当 completed；
- 不用 mock、按钮或 JSON 输出冒充真实产品闭环。

产品合同：

- 晃动鼠标是主唤醒，快捷键只备用；
- 默认完全不可见；
- Voice/Text 模式由 Dashboard 预设；
- 语音路径只有一个随转写增长、随指针定位的气泡，无 chips、菜单、模型选择器、发送/关闭按钮；
- PointerStage 只承载即时状态，设置/历史/长结果属于 Dashboard；
- 用户已有 Agent 会话优先；
- 所有动作复用 TargetLease、CapturePolicy、Context Packet、权限、审计、Receipt 和 read-back；
- Windows/macOS、视觉/文本模型、开发者/普通用户都必须是一等公民。

按以下顺序施工，不要只完成前两步就汇报：

## M0 基线

1. 运行 `git status --short --branch`，记录 dirty tree。
2. 运行 `npm test`、`python -m pytest -q --basetemp .tmp/pytest-terra-baseline`、`python scripts/smoke_fabric.py`。
3. 截取当前 Dashboard 与 PointerStage 作为 before。
4. 将真实失败记录进新的实施日志，不篡改为绿色。

## M1 合同先行

用测试先固定并实现：

- `ModelProfileV1`；
- `VisualRelayV1`；
- `AgentAdapter/AgentSession/AgentEvent`；
- `PreflightStage`；
- Electron/Python settings 共享 fixture；
- 模型能力 `yes/no/unknown`；
- Target/Anchor/Stage state。

新增测试文件按主规格第 11 节执行。测试必须先看到预期失败，再写实现。

## M2 模型配置与 N06

新增：

- `app/models/profiles.py`
- `app/models/catalog.py`
- `app/models/capability_resolver.py`
- `app/models/visual_relay.py`
- `app/models/runtime_client.py`
- `data/model_capabilities.v1.json`
- `electron/credential_store.js`

重构 `app/ai_client.py` 为兼容 façade，禁止继续把单一 env/secrets 模型当产品配置。使用 Electron `safeStorage`，settings 只存 `credentialRef`。Python bridge 仅通过 stdin 获得本次凭据，严禁 argv、日志、审计、异常和 settings 泄露。

能力解析优先级固定：

`manual override > explicit probe > provider metadata > dated catalog > unknown`

视觉模型：合规局部图 + 2–5 行轻量定位。
文本模型/unknown：完整结构化视觉转述，不附图。
Capture Policy deny：直接失败。
不得暗中调用另一个云端视觉模型。

在 `scripts/fabric_bridge.py` 增加：

`models.list/inspect/save/delete/test/set_default` 和 `visual_relay.plan`。

Dashboard 完成模型 Profile 的增删改、能力来源、测试和默认选择。

## M3 Agent Gateway

新增 `app/fabric/agent_gateway.py`、`app/fabric/acp_client.py`。先复用现有 `providers.py`、`agents.py`、hooks、task store，不平行造第二套任务系统。

协议顺序：

1. Codex app-server；
2. Pi JSONL RPC；
3. Gemini ACP；
4. Hermes ACP；
5. Claude hook/stream-json/resume；
6. Copilot/OpenCode/Cursor 可用的官方协议；
7. structured CLI；
8. 明示 clipboard；
9. MCP 只兼容。

实现会话发现、附着、send、event stream、steer、cancel、healthcheck。把 Provider 的事件映射到统一真值事件；禁止从进程存活时间编造百分比。

至少用本机真实 Codex、Pi、Gemini 跑通同一 Context Packet。若 Agent 未安装，只能记 blocked，不创建假成功。

## M4 Onboarding、Doctor、Dashboard

借鉴 Hermes 的 manifest/stage/event/marker 模式，但用本项目 Electron/DOM 实现。

新增：

- `app/fabric/preflight.py`
- `data/preflight_manifest.v1.json`
- `electron/bootstrap_runner.js`
- `electron/renderer/tokens.css`
- `electron/renderer/ui_primitives.css`

Preflight 顺序：Runtime、OS Permissions、Pointer Host、Voice、Grounding、Agents、Model Profile、Privacy、E2E smoke。状态只允许：

`pending/running/pass/warn/fail/skipped/needs_user`

Dashboard 导航重构为：概览、唤醒、模型与 Agent、能力、隐私、活动、诊断。去除网格、编号导航、Consolas 状态、嵌套卡片和开发控制台质感。使用系统字体、克制蓝色、flat not boxed、tokens over literals。支持 system/light/dark。

所有设置均保存、重启可恢复；保存失败先回滚 UI，再显示行内错误。

## M5 PointerStage

严格对照四个 Google 演示和主规格第 8 节：

- 轻色 40–44px 单气泡；
- voice idle 38–40px；
- 最大宽度 440px；
- Canvas 测量文字；
- 以真实 cursor `(x+18,y-18)` 为首选锚点，四象限碰撞；
- 同一气泡完成 awakening/listening/typing/resolving/accepted/completed/error；
- partial transcript 更新同一文本节点或词组；
- processing 复用气泡；
- 错误不离开指针、不变成大红条；
- voice 永无 chips；
- 无 close/send/mic 常驻按钮；
- WAAPI/CSS 动画可中断；
- reduced motion/transparency/high contrast；
- production 与 screenshot preview 只用一套 CSS。

从热路径移除旧 `panel/reader/result`，确认无引用且测试通过后才删除旧文件。

保存主规格要求的 10 类真实状态截图。

## M6 20 个黄金场景

按主规格 G01–G20 全部推进。它们是验收场景，不是菜单按钮。共享现有确定性写入器和 Agent Gateway，不为每个场景造孤立 Demo。

每个 verified 场景必须保存到：

`data/runtime/golden-flows/<Gxx>/`

包含脱敏 Context Packet、输入说明、UI 截图、Receipt、目标应用回读和至少一个失败边界。没有真实外部 Provider/账号时记 blocked，不计 completed；继续完成不依赖该 Provider 的其他场景。

## M7 完整验证

最后重新运行：

```powershell
npm test
python -m pytest -q --basetemp .tmp/pytest-terra-final
python scripts/smoke_fabric.py
```

再运行真实桌面链路：

`wiggle → pointer target → local voice partial/final → model-aware relay → Agent/deterministic executor → honest status → read-back receipt`

覆盖：

- 视觉模型、文本模型、unknown；
- screenshot allowed/structured_only/deny；
- stale lease；
- queued/running/completed/failed/cancelled；
- 单屏/双屏/边缘/DPI；
- Codex/Pi/Gemini；
- no-speech、无权限、无 API、Agent 不存在。

Windows 实机通过不等于 macOS 完成。现有 `native/macos/MagicPointerHost.swift` 只算源码；没有 Intel/Apple Silicon 实机证据就明确记录 blocked。

全过程及时更新一个新的实施日志，记录每个里程碑的真实状态、测试和证据路径。不要反复运行无新增信息的验证；合同改变、里程碑结束和最终交付时再跑相应测试。

最终只在所有可在当前机器完成的工作实际完成后汇报，格式必须包含：

1. 60 秒 CEO 汇报；
2. 关键架构变化；
3. 修改/删除文件；
4. G01–G20 的 `verified/blocked` 表；
5. 自动测试精确结果；
6. 真实 UI/桌面证据路径；
7. macOS 与外部账号 blocker；
8. 不得把“部分完成”写成完成。

---
