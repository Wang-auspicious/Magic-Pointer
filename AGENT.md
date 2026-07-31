# Magic Pointer — Agent Handoff Document

<!-- AGENTS.md spec: https://github.com/agentsmd/agents.md -->
<!-- 读完这个文件 + PRODUCT_BLUEPRINT + FEATURE_INVENTORY 即可开工。 -->

## 这是什么

Magic Pointer = 默认不可见的跨应用操作层。鼠标晃动唤醒 → 冻结指针下的 `THIS` → 单气泡语音/文字输入 → 30 个 Recipe 执行。优先原生应用接口（UIA/Office/DOM），缺专用连接器时把完整对象交给用户已安装的 Agent（Pi/Codex/Claude/Gemini）。

**不是聊天壳、不是截图问答器、不要求开发者先替 Agent 找源码文件。**

竞品：Google AI Pointer / Microsoft Click to Do / clicky (7k★ macOS app)。

## 当前状态快照（2026-07-31）

### 能正常工作
- 晃动唤醒 → overlay 出现 → 划线圈选 → 气泡弹出 → 语音/文字输入 → Recipe 执行
- 30 个 Recipe（OCR 复制、原位改写、翻译、表格提取、日历、地图、证据卡等）
- Dashboard 全部设置（唤醒/语音/Agent/Recipe/权限/隐私/诊断）
- Agent 集成（Codex/Pi/Claude/Gemini/Cursor/OpenCode/Aider + Generic）
- MCP stdio server（8 tools, 可在 Dashboard 开关）
- 本地 Whisper 语音（tiny 模型）
- Windows 安装包构建 + 自动更新（NSIS, electron-updater, delta package）
- macOS 打包脚本（DMG, 双架构, entitlements, Python runtime bundling）
- SenseVoice Small 模型已下载（228MB, 中文精度高 3-5 倍, 本地可用）

### 已知问题
- **第二次激活画线失败**：首次晃动→画线正常，右键关闭后再晃→左键画线不触发。根因：`gesture-ready` handler 里的冗余 `showInactive()` 在已可见窗口上重复调用，触发 Electron compositor 状态重置。**已修复**——移除了 `showInactive()`，保留 `setIgnoreMouseEvents(false)`。
- **选区偏移（高 DPI）**：150%/200% 缩放屏上圈选位置与实际截屏区域有偏移。根因：overlay 坐标是逻辑像素，截屏模块需要物理像素，缺 `× scaleFactor`。**已修复**——`completeSelectionGesture` 坐标全部乘了 `display.scaleFactor`。
- **语音识别精度差**：whisper tiny (39M 参数) vs 微信云端 ASR (千亿参数)。SenseVoice Small 已准备就绪但未接入 voice worker——上次引擎重构引入崩溃被回退到 `ce8d125` 纯净 whisper 版本。
- **气泡定位不精确**：releasePoint 直接用于气泡锚点，无 workArea 边界 clamp。

### 正在进行的开发
1. 手势 grounding 精度——semanticPoint 距离权重已加，py 桥接侧 3.0× 距离分 + 4.0× 覆盖率
2. clicky 架构学习——ElementLocationDetector（Computer Use API）、bezier 飞行动画
3. 语音升级——SenseVoice 引擎切换（引擎路由代码已完成但有问题，临时回退到纯 whisper）

## 完整文件清单（按模块）

### Electron 主进程 — `electron/`
| 文件 | 行 | 职责 |
|---|---|---|
| `main.js` | 3255 | App 入口，BrowserWindow 创建，IPC 路由，overlay/stage/dashboard 生命周期 |
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
| `voice_worker_client.js` | 269 | VoiceWorkerClient：spawn 管理 + JSONL IPC |
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
| `index.html` + `overlay.js` | 全屏透明画线 Overlay：Canvas 渲染 + mousedown/move/up + submitGesture |
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
| `omniparser/` | MIT (代码) | 截图→UI 元素 bbox。需要精确 screen parsing 时用 |
| `ufo-schannel/` | MIT | Windows UIA/COM/Win32 混合 GUI agent 参考 |
| `pi/` | MIT | Pi Agent 会话/RPC/扩展底座 |
| `nut.js/` | MIT | 跨平台鼠标/键盘操作库 |

### 参考文档
| 路径 | 内容 |
|---|---|
| `PRODUCT_BLUEPRINT_20260726.md` | **核心文档**：竞品依据、30 Recipe、交互合同、架构蓝图、验收标准 |
| `FEATURE_INVENTORY_20260730.md` | 完整功能清单（~130 项）+ Google/Microsoft/Claude 三方竞品差距分析 |
| `docs/planning/GAP_ANALYSIS_100_20260730.md` | 100 条漏洞清单 |
| `docs/planning/TODO_REMAINING_20260730.md` | 62 项代办 |
| `docs/planning/CLICKY_ANALYSIS_20260731.md` | clicky 源码深度分析（7600 行 Swift），8 个可借鉴技术点 |
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

## 不要做的事

- **不要切换 `setIgnoreMouseEvents` 做固定死**——必须二态（待机穿透/画线拦截）
- **不要在 gesture-ready handler 里调 `showInactive()`**——会导致二次激活 DOM 失活
- **不要在 `summarizeGesture` 删 `kind`/`semanticPoint`**——桥接需要圈心做距离打分
- **不要把 overlay 永久设 `setIgnoreMouseEvents(true, {forward: true})`**——应用下方会收到左键拖拽、误选文本
- **不要引入需要付费 API 的依赖**——SenseVoice/whisper/RapidOCR/OmniParser 全部免费本地
- **不要在未经日志确认的情况下改 overlay 鼠标处理**——这是最容易引入系统级破坏的模块

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
npm test                                  # JS 测试 (54 文件/112 测)
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
