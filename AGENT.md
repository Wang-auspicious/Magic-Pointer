# Magic Pointer — Agent Handoff Document

<!-- AGENTS.md spec: https://github.com/agentsmd/agents.md -->
<!-- 读完这个文件 + docs/planning/PROJECT_STATE_AND_DIRECTION.md + PRODUCT_BLUEPRINT + FEATURE_INVENTORY 即可开工。 -->
<!-- 项目状态/调研结论/会话知识的浓缩版在 PROJECT_STATE_AND_DIRECTION.md，别重读 74MB 会话历史。 -->

## 这是什么

Magic Pointer = 默认不可见的跨应用操作层。鼠标晃动唤醒 → 冻结指针下的 `THIS` → 单气泡语音/文字输入 → 30 个 Recipe 执行。优先原生应用接口（UIA/Office/DOM），缺专用连接器时把完整对象交给用户已安装的 Agent（Pi/Codex/Claude/Gemini）。

**不是聊天壳、不是截图问答器、不要求开发者先替 Agent 找源码文件。**

竞品：Google AI Pointer / Microsoft Click to Do / clicky (7k★ macOS app)。

## 当前状态快照（2026-08-02）

### 2026-08-02 夜间交接（先读这里）
- 当前安全基线提交：`39d86bc checkpoint: preserve perception and prompt progress`。这是本地进度快照，不包含 SenseVoice/Whisper 权重、pytest 临时目录或密钥；`.gitignore` 已补 `/models/`、`data/models/`、`*.gguf`、`*.safetensors`、`*.pt` 等模型规则。
- 该提交包含：全局截图+圈定位标签（THIS 标注、不裁图）+ 最多 24 个元件框编号标注 + 视觉 API 开关（仅授权上传才调用，中转 gpt-5.4-mini）+ 主进程 `FREEZE→OPEN_CAPSULE`（语音球等快照启动后显示）+ 常驻 OCR worker + 多源/跨应用研究结论。
- 手势存在时：先 UIA/结构化区域读取（闭合圈=圈内元件集，横线=单元件，与 bbox 相交即算）→ 结构化命中保留为 `context.content` 真相，全局截图+标注只挂 `artifacts` 证据；只有结构化失败才用 `screen_region` 当 context（`source_kind=native_selection`）。
- 8/2 修复的关键洞：全屏截图曾把 UIA 读到的正确文本（Row B）顶成空 content —— 已修。
- 2026-08-02 晚 fresh 验证：Node 全量 `56 source files / 116 tests` 通过；本次感知改动相关 Python 4 文件 `48 passed`。Python 全量第一次被系统 `%TEMP%/pytest-of-zjz65` 权限错误破坏，换独立 `--basetemp` 后又被 4 分钟工具时限终止，期间无断言失败；后续交付前必须用更长时限重新跑，不能把这次终止写成全量通过。

### 当前获批、正在实现的两个闭环
1. **跨应用连续圈选 Hook**：一次晃动开启长期 `InteractionEpisode`；可视 overlay 始终 no-activate + click-through；Windows `WH_MOUSE_LL` 只在明确的 `STROKE_CAPTURE` 状态吞掉构成该笔的事件，导航态必须 `CallNextHookEx`。同屏多笔保留宽松 grace period，用户已明确否定固定 1 秒；初版不要硬编码 1 秒，采用可配置约 2.5 秒并在前台窗口变化时立即切导航。跨应用后用侧键/Space 轻量续选，不再完整晃动。禁止用 `SendInput` 回放普通点击作为默认方案。
2. **微信图片/文件物化**：每笔立即冻结截图、前台 HWND、DPI、UIA/OCR；微信媒体按“公开 UI 下载/另存为 → 剪贴板/OLE capability probe（`CF_HDROP` / virtual file / DIB/PNG）→ 当笔截图裁剪”降级，成功内容统一落盘到 Magic Pointer 自有 capture/media 目录并把绝对路径、`acquisition`、`quality` 交给 Agent；小图/模糊/不可获取返回 `media_unresolved`，绝不猜图或伪造路径。初版不扫描/解密微信私有数据库。
- 关键研究文档：`docs/research/2026-08-02-cross-app-continuous-selection-and-wechat-media.md`。
- Hook 直接入口：`scripts/pointer_input_state.ps1` 已有 `WH_MOUSE_LL` 滚轮 hook；`electron/pass_through_gesture.js` 已有轨迹状态；`electron/main.js` 的 `armSelectionGesture/processPassThroughGestureSample` 负责接入；`electron/renderer/overlay.js` 当前 10 秒链式等待/独占输入需要收口。
- 微信入口：`scripts/selection_snapshot_bridge.py` 当前主捕获链；`app/grounding/explorer_adapter.py` 已能解析 Explorer 真实路径但未完整接入；需要新增微信消息/媒体解析器并把多路径、截图和可信度完整带进 `InteractionEpisode` → `selection_bridge.py` 的 Agent Context Packet。

### 能正常工作
- 晃动唤醒 → overlay 出现 → 划线圈选 → 气泡弹出 → 语音/文字输入 → Recipe 执行
- 30 个 Recipe（OCR 复制、原位改写、翻译、表格提取、日历、地图、证据卡等）
- Dashboard 全部设置（唤醒/语音/Agent/Recipe/权限/隐私/诊断）
- Agent 集成（Codex/Pi/Claude/Gemini/Cursor/OpenCode/Aider + Generic）
- MCP stdio server（8 tools, 可在 Dashboard 开关）
- 本地 Whisper 语音（tiny 模型）；**语音引擎双后端**：默认自动选 SenseVoice（sherpa-onnx，中文更准、实测加载 2.6s / 单句 0.14s），失败自动回退 Whisper（tiny）
- Windows 安装包构建 + 自动更新（NSIS, electron-updater, delta package）
- macOS 打包脚本（DMG, 双架构, entitlements, Python runtime bundling）
- SenseVoice Small 模型已下载（228MB, 中文精度高 3-5 倍, 本地可用）

### 已知问题
- **第二次激活画线失败**：首次晃动→画线正常，右键关闭后再晃→左键画线不触发。根因：`gesture-ready` handler 里的冗余 `showInactive()` 在已可见窗口上重复调用，触发 Electron compositor 状态重置。**已修复**——移除了 `showInactive()`，保留 `setIgnoreMouseEvents(false)`。
- **选区偏移（高 DPI）**：150%/200% 缩放屏上圈选位置与实际截屏区域有偏移。根因：overlay 坐标是逻辑像素，截屏模块需要物理像素，缺 `× scaleFactor`。**已修复**——`completeSelectionGesture` 坐标全部乘了 `display.scaleFactor`。
- **【已修 2026-07-31 Phase2】语音识别精度差**：SenseVoice Small 已正式接入为默认引擎（sherpa-onnx，模型已下载 228MB），同一 Whisper 模型不再并发推理（`_ModelRWLock`）；`voice_engine` 设置支持 auto/whisper/sense_voice，SenseVoice 连续 2 次加载失败自动回退 Whisper 并在 status/ready 事件带 `engineFallback` 原因；`scripts/benchmark_voice_engines.py` 提供同录音双引擎对比（CER/意图准确率/延迟）。

- **【已修 2026-07-31 用户反馈】气泡跑到右下角**：`completeSelectionGesture` 输出的是物理像素，但 `beginSelectionSession` 把它当 DIP 用——高分屏（150%/200%）下减去 stageBounds 后溢出视口，被钳制到右下角。修复：手势 releasePoint 先经 `screen.screenToDipPoint` 转回 DIP 再做锚定；`physicalGestureTrace` 对手势坐标空间为 `physical_screen_pixels` 的输入不再二次缩放。
- **【已修 2026-07-31 用户反馈】气泡出现后乱动**：stage 气泡改为每个会话只锚定一次（`capsulePlaced`），grounding 后续解析不再重新定位；用户可按住气泡本体（非输入框）拖到任意位置（`capsuleDragged` 锁定，边界内钳制）。
- **【已修 2026-07-31 用户反馈】语音点了没反应**：`dictation:start` 在目标 grounding 未完成时曾静默丢弃请求；现在有界等待 3 秒（80ms 轮询），超时给出友好提示「目标识别还在进行，请稍候再试语音」，不再无声无息。- **气泡定位不精确**：releasePoint 直接用于气泡锚点，无 workArea 边界 clamp。
- **【P0 已修 2026-07-31】语音管线崩溃**：`local_voice_bridge.py` 已捕获暂时性的 `queue.Empty` 并继续检查协作停止；partial 转录改为单在途后台任务，final 前串行收尾，同一 Whisper 模型不会并发推理。worker 同时补齐 `microphone_stopped` push，避免 Electron 残留 active request。详见 `docs/planning/REVIEW_AUDIT_20260731.md` #1/#2。
- **【P0 已修 2026-07-31】bridge stdin 无大小上限**：`selection_bridge.py` / `electron_bridge.py` 统一使用 64KiB UTF-8 有界读取，不在内存中驻留完整超限 payload；超限后按固定块排空 stdin 以避免写端 `EPIPE`，再返回 `payload_too_large` 失败关闭。详见 REVIEW_AUDIT #3。
- **【P0 已修 2026-07-31】overlay 黑屏无恢复**：`overlay:done` 非 gesture 分支改为事件驱动恢复——收到完成事件立即 `hideOverlay()`，不再等 bridge `onComplete`（最长 120s）才隐藏；overlay 再也不会在截图后黑屏并拦截全屏输入。详见 REVIEW_AUDIT #5。
- **【P0 已修 2026-07-31】overlay:done 坐标无界**：非 gesture 分支的 `points` 截断至 `MAX_OVERLAY_CAPTURE_POINTS=4096`，恶意/异常渲染进程无法向 bridge 投递巨量坐标（真实笔画有 4.2px 距离过滤，远低于上限）。详见 REVIEW_AUDIT #6。
- **【P0 已修 2026-07-31】生产环境测试钩子**：N17 语音焦点证据 / N18 wiggle 证据 / dashboard 截图三个 env 门控钩子全部隔离到 `!app.isPackaged` 之后，打包版永不执行（残留 `MAGIC_POINTER_*` 变量不会导致启动即退出），packaged 启动时会记录忽略日志。详见 REVIEW_AUDIT #4。

### 正在进行的开发
1. 手势 grounding 精度——semanticPoint 距离权重已加，py 桥接侧 3.0× 距离分 + 4.0× 覆盖率
2. clicky 架构学习——ElementLocationDetector（Computer Use API）、bezier 飞行动画
3. 语音升级——**已完成（Phase 2）**：SenseVoice 默认 + Whisper 自动回退 + 双引擎 benchmark；剩余：真实中文录音样本库、意图准确率基线、Dashboard 诊断页回退原因展示
4. **P0 修复排期**——#1/#2 语音管线、#3 bridge stdin 上限、#5 overlay 事件化恢复、#6 capture points 上限、#4 生产测试钩子隔离全部完成，全量 Python 602 + JS 113 全绿；语音收口含测试契约修复与竞态回归测试。剩余 #7 asar 打包设计（依赖 #4 的打包基线，风险较高，单独排期）
5. OpenSRE 借鉴——合成评分测试套件（Recipe 验收）、可逆脱敏、上下文预算（见下方 OpenSRE 分析段）
7. **感知链路收口（2026-08-01 晚 ~ 08-02，未提交）**——先冻结+全局截图再出语音球；圈只做定位标签（全局理解、不裁小图）；UIA 能枚举的元件全部框标注+编号；本地 OCR 兜底（RapidOCR→Tesseract）；视觉 API 仅在授权上传时调用；结构化读到的内容永远优先于截图。验收线：真实窗口端到端划一次，`selectionSnapshot.context.content` 非空且是画中的内容。
8. 语音上云（可插拔）：默认接云端/中转流式转写，本地 whisper 兜底；兼容外部听写设备快捷键。**排在感知链路之后**。
9. **意图-执行分离改造（高级 AI 路线图 Phase 1 已完成 2026-07-31）**——a) `app/fabric/model_plan.py`：ModelPlan 契约（intent / targetObjectIds / requestedResult / toolCalls / riskLevel / needsConfirmation / expectedVerification），18 个模型工具注册表（copy_text / translate_text / replace_text / insert_text / fill_form / extract_table / create_calendar_event / open_map_route / handoff_to_agent 等），严格校验（未知工具、未实现工具、缺参数、风险降级、危险未确认、对象数越界、64KB 上限全部 fail-closed）；b) `FabricEngine.plan_from_model()`：模型规划优先，关键词 Recipe 路由保留为离线降级；模型不能绕过本地权限策略（只能升级确认）。c) 手势几何升级（`electron/gesture_capture.js`）：圈→闭合多边形区域（32 采样+闭合点）、线/自由形→带宽走廊（法向偏移闭合多边形）、自由形语义点改质心、新增 direction 单位向量；`completeSelectionGesture` 透传 geometry/direction。d) Stage 气泡边界 clamp 验证为已实现（`electron/stage_anchor.js` 溢出最小候选 + 强制钳制，已有测试覆盖贴边场景）；危险手势绑定验证为不存在（gesture kind 仅作几何语义，路由纯文本 + 权限 fail-closed）。

## 完整文件清单（按模块）

### Electron 主进程 — `electron/`
| 文件 | 行 | 职责 |
|---|---|---|
| `main.js` | 3300+ | App 入口，BrowserWindow 创建，IPC 路由，overlay/stage/dashboard 生命周期 |
| `wiggle_detector.js` | 221 | 晃动检测：速度/反转/漂移/冷却/自适应阈值 |
| `gesture_capture.js` | 80 | 手势摘要：kind(圈/线/自由形) + semanticPoint(圈心/线中点) + bbox |
| `gesture_runtime_settings.js` | 30 | 手势运行参数：延迟/超时/交互模式/线样式 |
| `selection_session.js` | - | 选区会话生命周期：创建/取消/快照/完成 |
| `stage_contract.js` | - | Stage 状态机：targeting→frozen→capsule→processing→result |
| `interaction_episode.js` | - | THAT/THESE/HERE 多对象 Episode 绑定 |
| `activation_gate.js` | 24 | 激活决策：防重复触发/防抖/冷却 |
| `pass_through_gesture.js` | 110 | 穿透模式画线追踪：arm/push/cancel，主进程原生坐标采样 |
| `mouse_activation.js` | - | 侧键激活检测 |
| `pointer_dismiss_policy.js` | 16 | 全局指针右击关闭策略 |
| `pointer_polling_policy.js` | - | 鼠标轮询配置 |
| `coordinate_space.js` | 35 | 物理屏幕坐标转换：DIP→物理像素 |
| `panel_position.js` | - | 面板/Stage 窗口位置 |
| `stage_anchor.js` | - | Stage 锚点类型（pointer/bubble/result） |
| `stage_state.js` | - | Stage 渲染状态 |
| `stage_hit_policy.js` | - | Stage 点击命中策略 |
| `stage_chips_policy.js` | - | Stage 建议动作条策略 |
| `ipc_surface_policy.js` | 9 | IPC sender 校验：防止非对应窗口伪造 IPC |
| `result_surface_policy.js` | - | 结果展示面策略 |
| `internal_action_policy.js` | - | 内部动作自动执行策略 |
| `route_policy.js` | - | 地图 URL 白名单校验 |
| `voice_focus_guard.js` | - | 语音焦点守卫：防止语音事件泄露 |
| `voice_resident_runtime.js` | 266 | 常驻语音 runtime：预热/启动/停止/关闭 |
| `voice_worker_client.js` | 230 | VoiceWorkerClient：spawn 管理 + JSONL IPC（事件推送，无轮询） |
| `voice_trigger_policy.js` | - | 语音触发策略 |
| `dictation_correction_policy.js` | - | 语音纠正策略 |
| `security_hardening.js` | 185 | CSP/sandbox/致命崩溃恢复/navigation 守卫/权限拦截 |
| `observability.js` | 90 | JSONL 事件日志（5MB 滚动）+ crashReporter + counters |
| `update_manager.js` | 207 | 自动更新：semver 降级保护/channel/error 积累 |
| `settings_store.js` | 600 | 设置 schema + validate + persist |
| `credential_store.js` | 106 | safeStorage API key 加密存储 |
| `bootstrap_runner.js` | - | Preflight 检查 runner |
| `preflight_checks.js` | - | 启动前环境检查 |
| `python_runtime.js` | - | Python 运行时解析 + spawn 参数 |
| `renderer_readiness.js` | 33 | 渲染进程就绪 gate |
| `runtime_snapshot.js` | - | 运行时状态快照 |
| `app_lifecycle.js` | - | 启动/隐藏/退出策略 |
| `python_bridge_runner.js` | - | Python bridge 启动 + 超时管理 |

### 渲染进程 — `electron/renderer/`
| 文件 | 职责 |
|---|---|
| `index.html` + `overlay.js` + `sweep_visual.js` | 全屏透明画线 Overlay：默认蓝带由 WebGL2 屏幕空间路径 SDF 渲染（Canvas2D 降级）；单一蓝色、平坦主体、窄边缘羽化，自由路径按累计弧长从旧尾到光标连续增强，按住时尾部不消失。标记/观察光标保留 Canvas/OffscreenCanvas；mousedown/move/up + submitGesture |
| `stage.html` + `stage.js` | Stage 气泡：targeting→frozen→capsule→processing→result 状态机 |
| `dashboard.html` + `dashboard.js` | 控制面：唤醒/语音/Agent/Recipe/权限/隐私/诊断 14 个面板 |
| `onboarding.html` + `onboarding.js` | 首次启动向导 |
| `panel.html` + `panel.js` | 旧版面板（已退役，PointerStage 替代） |
| `styles.css` + `tokens.css` + `typography.css` + `ui_primitives.css` | 设计系统 |
| `dashboard.css` + `stage.css` + `onboarding.css` | 各页面样式 |

### Python 后端 — `app/`
| 文件 | 职责 |
|---|---|
| `main.py` | Python 入口 |
| `fabric/engine.py` | Recipe 引擎：plan→commit→verify→undo 管线 |
| `fabric/router.py` | 命令→Recipe 路由（中文关键词+打分） |
| `fabric/catalog.py` | 30 个 Recipe 定义 + `public_recipe_catalog()` |
| `fabric/schema.py` | RecipeDefinition / IntentMatch / OperationPlan / ExecutionReceipt |
| `fabric/capabilities.py` | 能力注册 + 搜索 |
| `fabric/mcp.py` | MCP stdio server (8 tools, tool 开关持久化) |
| `fabric/agent_gateway.py` | Agent 发现/会话/任务 gateway |
| `fabric/agent_sessions.py` | Agent 会话注册 |
| `fabric/agent_context_handoff.py` | Agent 上下文交接 |
| `fabric/agents.py` | Agent 连接器注册表 |
| `fabric/executors.py` | Recipe 执行器 |
| `fabric/hooks.py` | Claude/Gemini prompt hook 注入 |
| `fabric/providers.py` | Agent 可用性发现 |
| `fabric/task_store.py` | Agent 后台任务持久化 |
| `fabric/workflow_task_store.py` | Workflow 任务持久化 |
| `fabric/settings.py` | Fabric 设置 load/save |
| `fabric/audit.py` | 审计事件 |
| `fabric/provenance.py` | 对象溯源索引 |
| `fabric/artifacts.py` | 产物注册 + 过期清理 |
| `fabric/context_packet.py` | Agent 上下文包构建 |
| `fabric/capture_policy.py` | 截屏隐私策略 |
| `fabric/target_lease.py` | 目标窗口 HWND 租约 |
| `fabric/skill_candidates.py` | 技能候选项 |
| `fabric/runtime_snapshot.py` | Python 侧运行时快照 |
| `fabric/runtime_workspace.py` | 运行时工作区 |
| `adapters/browser_devtools_adapter.py` | Chrome DevTools 选区（DOM） |
| `adapters/uia_text_adapter.py` | Windows UIA 选区 |
| `adapters/office_adapter.py` | Word/WPS COM 选区 |
| `adapters/pdf_selection_recovery.py` | PDF 选区恢复 |
| `actions/executor.py` | 动作执行层：policy+precondition+history |
| `actions/office.py` | Office 文本操作 |
| `actions/shopping_list.py` | 购物清单 |
| `actions/calendar.py` | 日历事件 |
| `actions/draft_writer.py` | 草稿写回 |
| `models/capability_resolver.py` | 模型能力解析 |
| `models/profiles.py` | 模型配置 |
| `models/runtime_client.py` | 模型运行时客户端 |
| `models/visual_relay.py` | 视觉中继规划器 |
| `grounding/` | 选区位点 grounding（UIA/DOM/OCR/视觉） |
| `voice/text_normalization.py` | 语音文本规范化 |
| `dashboard/shopping_list.py` | 购物清单管理 |
| `dashboard/calendar.py` | 日历管理 |
| `context_pack/` | 上下文包 + 编译 |
| `review/` | 代码审查 |
| `terminology/` | 术语管理 |

### Python 桥接 — `scripts/`
| 文件 | 职责 |
|---|---|
| `electron_bridge.py` | Electron 主桥：路由→plan→execute→回执 |
| `fabric_bridge.py` | Fabric 引擎桥：catalog/providers/settings/route/plan/execute/audit/models/workflow/artifacts/tasks/provenance/skills |
| `selection_bridge.py` | 选区捕获桥：UIA/DOM/OCR/截图 |
| `selection_snapshot_bridge.py` | 选区快照桥：多点 grounding + semanticPoint 距离打分 |
| `action_bridge.py` | 动作执行桥 |
| `agent_bridge.py` | Agent 桥：providers/status/cancel/start |
| `agent_hook_bridge.py` | Agent hook 注入桥（Claude/Gemini/Cursor/Windsurf/OpenCode/Aider） |
| `agent_worker.py` | Agent 后台 worker |
| `calendar_bridge.py` | 日历桥 |
| `shopping_list_bridge.py` | 购物清单桥 |
| `local_voice_bridge.py` | Whisper 语音桥：load_model/transcribe/VAD/run_microphone |
| `local_voice_worker.py` | Whisper JSONL worker（常驻） |
| `sense_voice_bridge.py` | SenseVoice 语音桥（sherpa-onnx） |
| `sense_voice_setup.py` | SenseVoice 模型下载 |
| `magic_pointer_mcp.py` | MCP stdio server 入口 |
| `install_agent_hooks.py` | Agent hook 安装 |
| `list_models.py` | 模型列表 |
| `smoke_fabric.py` | Fabric 冒烟测试 |
| `onboarding_fixture.py` | 首次启动夹具 |
| `_bridge_common.py` | 共享：force_utf8_stdio/read_json_line/write_json/ensure_root_on_path |
| `prepare_python_runtime.ps1` | Windows Python runtime 构建（pip download + copy stdlib + manifest） |
| `prepare_python_runtime_macos.sh` | macOS Python runtime 构建（uv + cpython + pip + manifest） |
| `pointer_input_state.ps1` | Windows 鼠标/前景窗口轮询（原生） |
| `office_selection_probe.vbs` | Word 选区探针 |
| `uia_selection_probe.cs` | UIA 选区探针 |
| `uia_draft_writer.cs` | UIA 写回 |
| `collect-diagnostics.js` | 诊断打包（脱敏 zip） |
| `run-node-tests.js` | Node 测试 runner |
| 各种 `verify_*.py/js/ps1` | 验证脚本 |
| `*.bat` | 启动/停止脚本（run/start/stop） |

### Agent 集成 — `integrations/`
| 目录 | 内容 |
|---|---|
| `claude/hooks.example.json` | Claude prompt hook 配置 |
| `gemini/hooks.example.json` | Gemini hook 配置 |
| `codex/config.example.toml` | Codex 配置 |
| `cursor/mcp.example.json` | Cursor MCP 配置 |
| `pi/magic_pointer_extension.ts` | Pi Extension SDK 集成 |

### 外部参考 — `external/`
| 项目 | 许可证 | 什么情况用 |
|---|---|---|
| `clicky/` | 自有 | 7k★ macOS AI 伴侣。Overlay 动画、ElementLocationDetector（Computer Use API）、bezel 飞行动画、push-to-talk、Cloudflare Worker API 代理。**最近在读** |
| `openclicky/` | MIT | jasonkneen 维护的开源版 Clicky（2026-07）：Agent Mode、Computer Use runtime、58 个 bundled skills、Cursor overlay。**2026-07-31 克隆** |
| `clacky/` | MIT | Windows 版 Clicky（Claude 脑 + Deepgram/Edge TTS）：`routing.py` 本地快路径+Haiku 路由、`tour.py` [POINT] 流式指点+UIA 吸附、Hermes 后台 agent、memory_store。**2026-07-31 克隆** |
| `clicky-windows/` | MIT | Bitshank-2338 的 PyQt6 Windows 版 Clicky（clacky 前身）：`hybrid_pointer.py` 三层定位（UIA 5ms → OCR 300ms → Vision 1-3s）、12 个 LLM provider、4 个 STT 后端。**2026-07-31 克隆** |
| `opensre/` | Apache 2.0 | 9.6k★ AI SRE Agent 框架（Tracer-Cloud）。ReAct 工具循环、60+ 集成、**合成评分 RCA 测试套件**、可逆标识符脱敏、上下文预算。2026-07-31 克隆（depth 1），**只借模式不搬代码** |
| `omniparser/` | MIT (代码) | 截图→UI 元素 bbox。需要精确 screen parsing 时用 |
| `ufo-schannel/` | MIT | Windows UIA/COM/Win32 混合 GUI agent 参考 |
| `pi/` | MIT | Pi Agent 会话/RPC/扩展底座 |
| `nut.js/` | MIT | 跨平台鼠标/键盘操作库 |

### 参考文档
| 路径 | 内容 |
|---|---|
| `PRODUCT_BLUEPRINT_20260726.md` | **核心文档**：竞品依据、30 Recipe、交互合同、架构蓝图、验收标准 |
| `FEATURE_INVENTORY_20260730.md` | 完整功能清单（~130 项）+ Google/Microsoft/Claude 三方竞品差距分析 |
| `docs/planning/REVIEW_AUDIT_20260731.md` | P8 代码审查：44 项发现（P0×7/P1×12/P2×12/P3×8/P4×5），按优先级排修 |
| `docs/planning/GAP_ANALYSIS_100_20260730.md` | 100 条漏洞清单 |
| `docs/planning/TODO_REMAINING_20260730.md` | 62 项代办 |
| `docs/planning/CLICKY_ANALYSIS_20260731.md` | clicky 源码深度分析（7600 行 Swift），8 个可借鉴技术点 |
| `docs/planning/GOOGLE_ADDTHIS_ANDTHIS_ANALYSIS_20260731.md` | Google「add this/and this」底层机制 + Clicky 生态对标：referent 会话模型、三层定位、[POINT] 流式指点、落地差距与路线 |
| `docs/planning/BOTTOM_LAYER_DESIGN_20260801.md` | 底层设计：clicky 生态 44 个 issue 反馈全记录 + 8 类日常功能→输入需求推导 + Referent 会话引擎架构 + 成本/速度/聚焦定位 |
| `docs/planning/HANDOFF.md` | 历史 AI 对话交接 |
| `docs/planning/GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md` | Google 演示逐帧分析 |
| `docs/planning/GOOGLE_MAGIC_POINTER_ALIGNMENT.md` | Google AI Pointer 对齐 |
| `docs/planning/EXTERNAL_COMPONENTS.md` | 外部依赖 + 许可证矩阵 |
| `docs/planning/PRODUCT_*.md` 系列 | 产品方向研究 |
| `docs/planning/PROGRESS_*.md` 系列 | 进展记录 |
| `docs/reference/` | 外部参考 PDF/HTML（Google DeepMind 博文等） |
| `demo/recordings/` | Google 演示截图+录屏（演示 1-20） |
| `AGENT.md` | 你正在读的这个文件 |

## 交互流（完整）

```
1. 用户在任何应用中短促左右晃动鼠标（250-600ms, 2+ 反转）
   → wiggle_detector.js 检测 → activation_gate.js 决策 activate
2. 系统冻结指针对象，显示全屏透明 Overlay
   → armSelectionGesture() 创建时间窗口
   → reveal() 显示 overlay → 渲染进程收到 overlay:show → gestureMode=true
   → renderer 调用 gestureReady() → 主进程 setIgnoreMouseEvents(false)
3. 用户在 overlay 上左键划线圈选屏幕内容
   → overlay.js pointerdown → drawing=true → pointermove → addPoint → render
   → pointerup → submitGesture() → overlay:done IPC
4. 主进程 completeSelectionGesture() → summarizeGesture() 计算 bbox+semanticPoint
   → 坐标 × display.scaleFactor → physical_screen_pixels
   → beginSelectionSession() → 触发 Python 桥接截屏+OCR/UIA
5. Stage 气泡出现 → targeting → frozen → capsule-voice/text
   → 用户说/打字命令 → Recipe router 匹配 → plan → preview → confirm → execute
6. 回执/结果展示 → 可撤销 → Dashboard 审计记录
```

## 核心架构决策

### 为什么 overlay 二态切换（不是永久穿透）
clicky 用永久 `ignoresMouseEvents=true` + CGEvent tap 追踪画线——但 clicky 是 macOS-only 且不需要划线圈选（它只做 push-to-talk 语音+光标飞指）。Magic Pointer 必须在 Windows 上通过 overlay Canvas 接收 mousedown/move/up DOM 事件来画线。

**正确模式**：待机=穿透(`forward:true`)，画线时=拦截(`setIgnoreMouseEvents(false)`)。切换点在 `gesture-ready` handler。

### 为什么 redundant showInactive 是 bug
`reveal()` 已调用 `win.showInactive()` 显示 overlay。`gesture-ready` handler 不应该再次 `showInactive()`。在已可见的 transparent window 上重复 show 会触发 Electron compositor 内部状态重置，导致 DOM 事件在这个窗口的第二次 show/hide 周期后**静默停止投递**。症状：首次画线正常，第二次激活后 pointerdown 不触发。

**修复**：移除 gesture-ready 内的 `showInactive()`，保留 `setIgnoreMouseEvents(false)`。

### 为什么需要 scaleFactor
overlay 的 Canvas 坐标是逻辑像素（CSS pixels，DIP）。Python 截屏模块（Pillow ImageGrab/UIA bbox）使用物理像素。150% DPI 下不乘 1.5 = 截屏区域缩小到 67%，向上左偏移。

**修复**：`completeSelectionGesture` 中所有坐标 × `screen.getDisplayNearestPoint(cursor).scaleFactor`，坐标空间标注 `physical_screen_pixels`。

### 为什么 gesture 需要 kind + semanticPoint
Codex 删掉了圆/线/自由形分类和语义点。没有 semanticPoint，Python 桥接只能按 bbox 矩形截屏→OCR 取"第一行文本"。圈心落在目标行但 bbox 顶部包含上一行→错选。恢复后 bridge 用 `3.0 × proximity + 4.0 × coverage` 打分，圈心最近的元素胜出。

### 为什么 voice engine 回退到了纯 whisper
引擎切换重构（`_resolve_engine` + 动态 import）引入了 `VoiceProfile` 和 `MicrophoneRunner` 类型引用错误。当前 `local_voice_worker.py`、`voice_worker_client.js`、`voice_resident_runtime.js`、`settings_store.js` 均已从 `ce8d125` commit 恢复为纯净 whisper 版本。

SenseVoice 桥接（`sense_voice_bridge.py`）和模型（228MB）已就绪，但引擎路由需要**重新严谨实现**——不是简单加 `--engine` flag，而是要保证所有类型引用、module-level default、resident_microphone_runner 都正确。

## OpenSRE 分析（2026-07-31，external/opensre）

**它是什么**：Tracer-Cloud 开源的 AI SRE Agent 框架（9.6k★，Apache 2.0，public alpha）。事故调查（RCA）工具循环 + 60+ 观测/云/数据库/告警集成 + 合成评分测试套件（"SWE-bench for SRE"）。分层 Python：`core/`（ReAct loop + LoopHost Protocol + context budget）、`tools/`（注册表自动发现）、`integrations/<vendor>/tools/`、`platform/`（masking/guardrails/sandbox/observability）、`surfaces/`（CLI + REPL）、`gateway/`（Telegram daemon）。

**对我们的帮助**（按价值排序）：

1. **合成评分测试套件（tests/synthetic/rds_postgres）——最有价值**。20+ 静态场景（difficulty 1-4、red herring、forbidden categories、must-rule-out keywords），驱动生产同一管线评分。对应 Magic Pointer 缺口：Recipe 30 个只有 verify_* 冒烟脚本，无评分验收。**可照做**：为每个高风险 Recipe（OCR 复制/选区 grounding/表格提取/日历解析）建 `scenario-XXX/` 静态夹具 + `answer.yml`（required_keywords / forbidden_categories），跑分进 CI。
2. **可逆标识符脱敏（platform/masking）**：pod/email/IP/account id 进 LLM 前脱敏、输出回填。对应我们 #38 审计脱敏未完成——截图/选区上下文交给 Agent 前应做同类脱敏。
3. **上下文预算（core/context_budget）**：模型窗口 ceiling、响应 headroom、重复工具结果淘汰、截断标记。我们的 `compile_context_prompt`（context_pack）无 token 预算——长会话必炸上下文。
4. **工具框架纪律**：BaseTool + `@tool` 装饰器 + 注册表自动发现 + JSON Schema draft-07 陷阱（多 tool 同时发送时 schema 必须严格）。我们 MCP 8 tools 手写，缺契约测试。
5. **LoopHost 事件化循环**：react_loop 每步发事件（turn/tool/provider），host 回调决定工具过滤/结论接受/nudge——结论拒绝必须有 nudge 否则死循环（他们有明确 guard）。对应我们的 agent_gateway 会话推进。
6. **CWE-209 纪律**：外部面（HTTP/聊天网关）绝不外泄异常详情，日志全量本地。我们 stage 向 Agent 交付 prompt 时同理——错误只给 `type(exc).__name__`。
7. **AGENTS.md 反模式文档文化**：每个 footgun 配 CodeQL 规则 + 先例文件。我们的"不要做的事"段可学其格式。

**不借的**：技术栈不共享（pydantic/FastAPI/async 服务端 vs Electron+JSONL bridge），代码不可复用只借模式；遥测 PostHog/Sentry 默认开，与我们的隐私立场冲突（我们 11.8 匿名遥测默认关）。

## 当前修复进度（2026-07-31）

- **15:13 已启动 P0 修复**：已读取 `docs/planning/REVIEW_AUDIT_20260731.md`，本轮最高优先级保持为 #1/#2 语音管线；按根因域并行处理语音采样泵、partial 转录线程化与 bridge stdin 大小上限。
- **工作区保护**：开始时已有 `main.js`、`overlay.js`、voice worker/client、`AGENT.md`、`CHANGELOG.md` 等未提交改动；本轮保留这些改动，只在对应 P0 范围内追加测试与实现。
- **验证约束**：每项修复必须先有能复现风险的失败测试，再跑定向测试、JS 全量测试和 Python 全量测试；子 agent 结果需由主 agent 独立复核。
- **15:15 基线**：`npm test` 通过（54 个源测试文件、114 项测试）；语音相关 Python 定向集合当前为 35 项。该结果仅是修复前基线，合入后必须重新验证。
- **15:24 P0 #1/#2 已进入复核**：新增 3 个确定性回归测试，红测为 `3 failed, 9 passed`，分别命中 `queue.Empty` 外泄、partial 阻塞采样泵、partial 异常终止会话；实现改为单在途后台 partial，final 前等待并丢弃过期 partial，确保同一模型最大并发为 1。子任务定向绿测为 19/19，主 agent 仍需重跑集成验证。
- **15:34 worker 集成红绿**：扩大验证时发现 push 模式只推送 `final`、未推送 `microphone_stopped`，Electron client 会一直保留 active session。先把旧 poll 测试改成 push 契约并看到失败，再补齐 lifecycle event 推送；`tests/local_voice_worker_test.py` 现为 19/19。
- **15:39 P0 #3 已复核**：selection/electron bridge 使用共享 64KiB UTF-8 reader；红测同时暴露提前关闭 stdin 会让 Electron 写端报 `EPIPE`，因此超限后以固定大小块排空余量再返回结构化 `payload_too_large`。bridge + BOM 定向测试为 20/20，并已用真实 Electron runner 验证两座 bridge 的退出码与错误协议。
- **15:44 全量验证状态**：首次 Python 全量测试在 240 秒工具时限处被终止，未产生失败明细；这不是通过结论。后续将放宽执行时限并继续定位耗时项。

## 不要做的事

- **不要切换 `setIgnoreMouseEvents` 做固定死**——必须二态（待机穿透/画线拦截）
- **不要在 gesture-ready handler 里调 `showInactive()`**——会导致二次激活 DOM 失活
- **不要在 `summarizeGesture` 删 `kind`/`semanticPoint`**——桥接需要圈心做距离打分
- **不要把 overlay 永久设 `setIgnoreMouseEvents(true, {forward: true})`**——应用下方会收到左键拖拽、误选文本
- **不要引入需要付费 API 的依赖**——SenseVoice/whisper/RapidOCR/OmniParser 全部免费本地
- **不要在未经日志确认的情况下改 overlay 鼠标处理**——这是最容易引入系统级破坏的模块
- **不要让全屏截图的 `visual_context`（空 content）覆盖结构化读到的 `context.content`**——截图+标注只是证据，真相永远是 UIA/DOM/COM 读到的文本；结构化失败才允许 `screen_region` 当 content
- **不要只裁圈内小图丢给模型**——要全局截图 + 圈做定位标签 + 元件框标注；裁小图会丢上下文、大图直接压缩会丢细节
- **不要默认上传截图给模型厂商**——上传必须有显式开关（`upload_screenshots`），默认本地 OCR 兜底

## 代码规范

- JS：`.prettierrc.json` + `eslint.config.mjs`。2 空格。单引号。`'use strict'`。
- Python：`pyproject.toml` (ruff)。4 空格。`from __future__ import annotations`。
- 文件命名：`snake_case.py`、`camelCase.js`。
- 改了行为→同步改 `CHANGELOG.md`。改了 Recipe 契约→同步改 `PRODUCT_BLUEPRINT_20260726.md`。
- 不确定的 bug 先加诊断日志（`log()` → `data/runtime/electron.log`），确认根因后再改。
- **改 overlay 鼠标处理前，先读这条 "不要做的事" 列表。**
- commit message：feat/fix/docs/refactor + 简短描述。

## 命令

```bash
npm test                                  # JS 测试 (56 文件/115 测)
python -m pytest -q                       # Python 测试
npx --no-install electron electron/main.js # 开发启动
npm run dist:win                          # 构建 Windows 安装包
npm run diag:collect                      # 诊断包
python scripts/sense_voice_setup.py       # 下载 SenseVoice 模型
node scripts/collect-diagnostics.js --out diagnose.zip  # 脱敏诊断包
```

## 日志 & 调试

- Electron 日志：`data/runtime/electron.log`（`Get-Content ... -Tail 50`）
- Python bridge 超时：分操作 5s-120s，stdout/stderr 有上限
- 诊断命令：`npm run diag:collect` 生成脱敏 zip
- 选区定位调试：看日志中 `wiggle accepted` → `gesture-ready OK` → `selection gesture drawing` → `selection session capture` 链路
- 画线失败调试：看 `gesture-ready OK` 后是否有 `selection gesture drawing`。没有 = DOM pointerdown 未触发

## 自我更新规范

- 改文件→更新上方的文件表
- 发现新 bug→更新"已知问题"段
- 新增架构决策→更新"核心架构决策"段
- 尝试新方案但失败→更新"不要做的事"段
- 新增 Recipe→更新 `FEATURE_INVENTORY` 和 `PRODUCT_BLUEPRINT`
- 改测试→更新上方的 `npm test` 计数
- 发现重要外部项目→更新"外部参考"表
- 新增文档→更新"参考文档"表
- 每次会话结束→更新 `docs/planning/PROJECT_STATE_AND_DIRECTION.md`（状态/根因/决策/下一步）——它是 74MB 会话历史的浓缩版，新会话先读它
- 不要在会话里重读超大会话历史 JSONL（路径在 PROJECT_STATE_AND_DIRECTION.md 第 8 节）


## 高级 AI 路线图（2026-07-31，尚未执行）

来源：外部顾问意见（意图-执行分离）。Phase 1 已完成（见上），剩余按序执行：
- **Phase 2 语音引擎 ✅（2026-07-31 完成）**：引擎契约 `scripts/voice_engine.py`（whisper/sense_voice/auto），worker `--engine` + 2 次失败回退 Whisper + `engineFallback` 事件字段，设置 `voice_engine` + Dashboard 选项（auto/whisper/sense_voice），`scripts/benchmark_voice_engines.py` 双引擎对比（实测 SenseVoice 加载 2.6s / 单句 0.14s vs whisper 6.2s / 0.50s）。
- **Phase 3 手势落地**：区域覆盖+轨迹经过+中心距离综合排序（grounding）；低置信度定位走视觉模型（局部截图+候选框）；逐点逐显示器坐标（异构 DPI 跨屏，非 gesture 分支仍未修）。
- **Phase 4 统一动作协议**：read/replace/insert/set_value/invoke/verify/undo 统一适配器；Word/浏览器/Excel 执行器迁移；写入前重确认目标、写入后重读验证（target_lease 已有基础）。
- **Phase 5 体验**：模型输出流式展示；晃动后并行预取截图/UIA/DOM；窗口结构短缓存；设置分普通/高级两层；阶段耗时与失败回放（observability 已有事件日志基础）；一键体验回归脚本。
- **Phase 6 降级**：模型 API 失败时本地降级（OCR 复制/原生选区/剪贴板）+ 自然语言错误提示。
