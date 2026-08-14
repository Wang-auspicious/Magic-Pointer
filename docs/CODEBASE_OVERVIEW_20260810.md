# Magic Pointer 架构与代码库全貌

> 用途：发给 Web 端 AI 讨论架构与后续能力接入的完整参考。最后更新 2026-08-10。
> 数据基线：Git 跟踪 ~560 源文件 / 约 11 万行；Python 测试 1073 项、Node 测试 127 项全绿；非测试 JavaScript 已全部迁移为 TypeScript。

> **2026-08-14 增补（插件内核批）**：本文地图保持，但架构新增一层——
> `app/harness/`（Context 服务仓库 / inject / 可逆 effect / 四模式事件 / scope +
> plugin 协议 + 分层组合 + builtin bundle）。`scripts/selection_bridge.py` 的
> `_loop_router` 不再手接线，改为 `boot_loop_context(runtime)` 组合插件树。
> 新增 `data/plugins/`（用户插件目录）与 `scripts/harness_dump_config.py`
> （启动树检视）。审查与实施：`docs/2026-08-14-plugin-architecture-review.md`、
> `docs/superpowers/plans/2026-08-14-plugin-kernel.md`；权威账本仍以
> `docs/design/MAGIC_POINTER_HARNESS_20260811.md` §18 为准。

---

## 一、项目定位（一句话）

**Magic Pointer 是一个默认不可见的跨应用 AI 操作层**：用户在任意应用里短促左右晃动鼠标（或 Ctrl+Alt+M），系统"冻结"指针下的对象（THIS/THAT/THESE/HERE），随后出现一个随语音转写或文字输入逐步生长的气泡，说一句短命令即可对对象执行操作（改写、翻译、OCR、表格、日历、图片编辑、Agent 交接等）。

它不是聊天壳、不是截图问答器，也不要求开发者先帮 Agent 找源码文件——**优先使用原生应用接口（UIA/Office COM/浏览器 DevTools/PDF），缺少专用连接器时才把完整对象现场交给用户已安装的 Pi、Codex、Claude、Gemini 等 Agent**。

产品定位的三个"母动作"：**取（锁定 THIS）→ 问/改（命令气泡）→ 交（Agent 或动作执行）**。核心交互哲学：前台只有一个气泡，不显示建议动作、麦克风键、发送键、Agent 列表。

---

## 二、技术栈与运行机制

| 层 | 技术 | 职责 |
|---|---|---|
| 桌面壳 | Electron 43（TypeScript 6，全量 strict） | 主进程组合根、窗口管理、全局钩子、IPC 安全 |
| 渲染层 | HTML/CSS/TS classic-script（IIFE + globalThis 双发布） | overlay 划线层、PointerStage 舞台、工作室、随行窗 |
| 业务核心 | Python 3.12（`app/` 包） | Fabric 引擎（规划/权限/签名/执行）、39 个 Recipe、Agent 网关 |
| 桥接层 | Python 子进程（stdin/stdout JSONL 协议） | Electron ↔ Python 双向调用，spawn 安全（argv/stdin，shell=false） |
| 原生探针 | C#（UIA）、PowerShell/VBS（COM）、Swift（macOS 宿主） | 读选区/写回文本/指针流 |
| 本地模型 | SenseVoice（sherpa-onnx，中文 ASR 默认）、Whisper（兜底）、OCR 常驻 worker | 全本地语音/文字识别，不上传录音 |
| 外部 LLM | OpenAI 兼容 API（chat-completions / Anthropic messages），文本/视觉双通道 | 意图路由、配方组合、答案生成 |

**一次完整交互的链路**：
```
鼠标晃动 → wiggle_detector 判定意图
  → activation_gate 去抖/静默期决策 → overlay 出现划线层
  → 手势（划圈 THIS / 划线选区）→ gesture_capture 归纳几何
  → selection_session 锁定对象（感知级联：UIA/Office/DOM 结构化读取 → 常驻 OCR → 视觉回退）
  → grounding 把选区接地为真实对象（Explorer 文件/终端证据/微信媒体/PDF 页码…）
  → 气泡出现（打字或语音）→ stage_turn_stream 组装命令
  → Python fabric engine：L0/L1/L2 三级意图路由 → Recipe 匹配 → 权限决策（allow/confirm/deny）
  → 计划 HMAC 签名（integrity_token）→ 确认（高风险动作）→ 执行器执行
  → 结果回显（卡片/内联/证据）+ 撤销回执 + 审计脱敏落盘
```

---

## 三、产品能力清单（已实现）

### 3.1 交互能力
- **鼠标晃动唤醒**：方向反转 ≥3 次、250-500ms 往返、回程比判定；拒绝拖拽/滚动/窗口移动/禁用应用中的触发；灵敏度可调 + 自适应校准
- **无障碍备用入口**：Ctrl+Alt+M（唤醒）、Ctrl+Alt+D（Dashboard）、Ctrl+Alt+Enter（现场填入 Agent）、Ctrl+Alt+Shift+M（旧文本选区兼容）
- **划线手势**：划圈锁定 THIS、划线选区、多笔链提交、右键取消、穿透式裸屏绘制
- **语音输入**（本地优先）：SenseVoice 默认 / Whisper 自动回退；能量型 VAD（噪声底自适应、拒稳态交流声）；静音 1250ms 切句、最长 20s；增量部分转写（1.25s 间隔）；auto / push-to-talk / hover 三触发策略；语音文本规范化（繁简/标点/中英空格）
- **气泡交互**：随内容横向生长、Processing 态、预览高风险动作、执行/读回/撤销；结果线程卡片（10 种卡 × 三态）、同意审批流、原地展开
- **感知级联**：结构化读取（UIA TextPattern / Office COM / 浏览器 DOM）→ 常驻 OCR → 视觉回退，逐层降级并记录审计（哪一层成功、为何回退）
- **接地（Grounding）**：把选区变成真实对象——Explorer 文件（绝对路径+bbox）、终端缓冲区（命令/退出码/脱敏）、微信消息背后的真实文件（三档诚实级别，重名报 ambiguous 不猜）、PDF 文本层+页码+边框+文件哈希证据卡、OCR 行与笔画的映射验证（marked-read 评分）
- **主动提议**（proactive_rules）：连截两图、剪贴板滞留、双窗切换三次等场景触发建议，带"一生一次"去重
- **收藏箱（Stash）**：剪贴板轮询采样、指纹去重成簇（凭证/交接/灵感/素材）、路径回写剪贴板、自动图注
- **对话记忆**：按所指对象归类的会话历史、THIS 槽位绑定（interaction_episode）、时间线/记忆/产物三视图
- **诊断与更新**：Dashboard 实时运行时快照、JSONL 事件日志轮转、自动更新（electron-updater）、崩溃防循环重启

### 3.2 动作能力（39 个 Recipe，`data/recipes/builtin.recipes.json`）
覆盖：文本（改写/翻译/原地替换/长度目标）、图像（编辑/跨图组合/风格迁移/无多模态视觉上下文包）、表格（提取 CSV/多表合并/图表数据）、OCR（一步复制/清洗/证据标注）、PDF/网页选区证据卡、日历草稿+冲突检查、地图路线、食谱缩放、购物清单、剪贴板历史、记忆回忆、任务管理、Agent 现场交付、MCP 嵌入卡等。

动作执行器（`app/actions/executor.py`）注册 11 类动作：复制到剪贴板、Office 选区替换/撤销、购物清单增删勾、日历事件创建/撤销、粘贴到前台、Recipe 执行——全部带 before/after sha256 校验 + 精确撤销回执（如 Word undo 提案）。

### 3.3 Agent 集成（native-first）
- **Codex**：`exec --json` / `app-server`，支持 `--sandbox read-only`、`--image` 附件、`resume` 会话续接
- **Pi**：Extension hooks + JSONL RPC steer（`--mode rpc` 可操控后台任务）
- **Claude Code**：`UserPromptSubmit` hook（提示词含 THIS/这个/屏幕等指代时注入冻结对象）+ `stream-json`
- **Gemini CLI**：`BeforeAgent` hook + headless JSON
- **Cursor / OpenCode / Aider / generic**：argv/stdin 通用连接器，不拼接 shell 命令
- **MCP**：只作为没有 hook/plugin/session API 时的通用兼容层（`magic_pointer_mcp.py` stdio 服务端 + 客户端调用用户已配置的 MCP 服务器）
- **会话发现**：自动解析 `~/.codex/sessions`、`~/.claude/projects`、`~/.gemini/tmp`、`~/.pi/agent/sessions`，标题/首条消息/时间/存活探测
- **后台任务**：Agent 任务持久化（task_store）、目标租约强校验（窗口跑偏即暂停 `paused_target_mismatch`）、steer/cancel/approve/resume、技能候选学习

### 3.4 安全边界
- 读取/本地写入/外部发送/删除/付款五级权限；写入发送默认确认、付款默认拒绝
- Operation Plan HMAC-SHA256 签名（本机 key），Renderer/hook/MCP 不能篡改 provider/参数后复用授权
- Agent handoff 纯 argv/stdin、shell=false、默认不提交外部消息
- 审计脱敏（prompt/正文/截图路径默认脱敏），只保留 Recipe/provider/状态/校验元数据
- 每个成功动作必须返回校验字段；可撤销动作返回精确 undo receipt
- 渲染进程只能给几何不能指定窗口（防瞄准任意目标）；IPC 来源校验（webContents 归属）

### 3.5 跨平台状态
- **Windows**：完整主链（Electron + UIA/Office/PDF + 原生鼠标流 + 本地语音 + 动作执行）
- **macOS**：共享 Electron/Fabric 层 + `MagicPointerHost.swift`（权限检查/请求、35ms 指针流、滚动归并）；未实机验证签名/公证/多屏坐标
- **Linux**：Fabric/MCP/Agent 连接层可用，系统指针宿主未实现

---

## 四、代码库逐文件地图

### 4.1 `electron/` 主进程（~58 个 .ts + preload，编译到 build/electron）

**组合根与生命周期**
| 文件 | 功能 |
|---|---|
| `main.ts` | 组合根（~4900 行）：创建 5 类窗口（overlay/stage/dashboard/companion/onboarding）、全部 IPC handler、鼠标轮询/晃动/手势/选区会话生命周期、Python 桥调用、语音运行时、预检引导、托盘、更新、收藏箱与对话落盘 |
| `preload.ts` | contextBridge 暴露 6 组 API：magicPointer（overlay）、magicPointerPanel（气泡）、magicPointerStage（舞台双向 invoke）、magicPointerDashboard、magicPointerCompanion、magicPointerOnboarding |
| `app_lifecycle.ts` | 隐藏启动决策、按 marker 判断引导就绪 |
| `security_hardening.ts` | 全局安全加固：拦 window.open/导航/webview、拒权限、崩溃防循环 |
| `observability.ts` | JSONL 事件日志（轮转）+ 进程内计数器 |
| `preflight_checks.ts` | 引导期本机检查项（Python 运行时/权限/模型/隐私/e2e 冒烟） |
| `bootstrap_runner.ts` | 预检清单执行器，通过后写 ready marker |
| `update_manager.ts` | electron-updater 封装 |
| `python_bridge_runner.ts` | spawn Python 桥子进程：JSONL 协议、限额/超时/取消、stderr 进度透传 |
| `bridge_progress_lines.ts` | 解析桥进度行（`@@mp phase=… ms=…`） |
| `result_surface_policy.ts` | 选区是否可发命令/可交付，结果归类 error/card/inline |
| `ipc_surface_policy.ts` | IPC 事件来源校验（必须来自指定窗口 webContents） |
| `titlebar_contrast.ts` | 按主屏位图亮度算标题栏按钮深浅 |
| `runtime_paths.ts` | 编译/源码两种布局的项目根解析 |

**策略模块（纯函数，主进程与渲染层双加载：IIFE + globalThis + module.exports）**
| 文件 | 功能 |
|---|---|
| `answer_shape_policy.ts` | 判回答形态：deliver（禁 markdown、需同意）还是 inspect |
| `capture_proof_policy.ts` | UIA/文本范围/OCR 矩形去重排序成"证明拿到"的高亮带 |
| `stage_state.ts` | PointerStage 状态机（hidden→targeting→frozen→capsule→processing→result/error）+ 词级 LCS diff |
| `stage_anchor.ts` | 胶囊/面板锚点计算（指针旁/目标旁/屏边，稳定不跳） |
| `stage_chips_policy.ts` | 上下文建议芯片显隐与内容 |
| `stage_hit_policy.ts` | 舞台鼠标是否应被捕获（交互区内/拖拽中） |
| `stage_hit_regions.ts` | 清洗舞台窗口形状区域（Electron 43 缩放坑） |
| `stage_pick_policy.ts` | 光标下最小非整窗元素矩形（pick 模式） |
| `stage_stretch_policy.ts` | 拖拽边/把手拉伸：像素拖距→行/字数目标与命令 |
| `stage_turn_stream.ts` | "字+笔画"时间流拼成带 ①② 序号的命令，判提交时机 |
| `voice_trigger_policy.ts` | 语音触发状态机：auto/push_to_talk/hover |
| `dictation_correction_policy.ts` | 听写纠正流程状态机（final/correct/repeat/submit） |
| `submit_gating_policy.ts` | 感知未完成时命令提交门禁（等/提交/失败） |
| `pointer_dismiss_policy.ts` | 全局右键新按下是否解散临时浮层 |
| `pointer_polling_policy.ts` | 综合唤醒模式/晃动/侧键/语音配置决定是否轮询鼠标 |
| `activation_gate.ts` | 去抖+静默期的激活/解散决策闸门 |
| `gesture_runtime_settings.ts` | 设置项收敛为手势运行契约（arm 延迟/超时/链间隙/线型） |
| `route_policy.ts` | Google 地图路线 URL 白名单构造/校验 |
| `internal_action_policy.ts` | 内部提案（购物清单/粘贴/配方）能否免确认自动执行 |
| `proactive_rules.ts` | 主动提议规则引擎（连截两图/剪贴板滞留/双窗切换） |
| `proactive_once_store.ts` | "一生一次"提示去重纯逻辑 |

**存储模块**
| 文件 | 功能 |
|---|---|
| `settings_store.ts` | 设置读写与规整（快捷键/捕获模式/模型档案/权限授权）+ 默认值 |
| `credential_store.ts` | 凭据 safeStorage 加密落盘、原子写、损坏保护 |
| `conversation_store.ts` | 对话历史按所指对象归类、追问续接 |
| `selection_session.ts` | 选区会话内存库：token 生命周期、快照/布局/请求状态、TTL 清理 |
| `interaction_episode.ts` | 交互片段记忆：this/that/these/here 槽位绑定、空间关系 |
| `session_timeline.ts` | 最近 N 次会话各阶段耗时的内存环（诊断页） |
| `runtime_snapshot.ts` | 运行时状态快照缓存：TTL+代际失效+降级 |
| `stash_store.ts` | 收藏箱纯逻辑：指纹/去重/成簇/归类 |
| `stash_runtime.ts` | 收藏箱 IO：剪贴板轮询/采样落盘/路径回写/自动图注 |

**运行时模块**
| 文件 | 功能 |
|---|---|
| `wiggle_detector.ts` | 晃动检测：方向反转/行程/回程比/速度 + 灵敏度校准自适应 |
| `wiggle_reliability.ts` | 晃动检测回归运行器：命中率/误触发/p50/p95 |
| `mouse_activation.ts` | 鼠标侧键/中键按住激活 |
| `gesture_capture.ts` | 划线手势归纳：点/线/圆/自由线、包围盒、走廊几何、多笔聚合 |
| `pass_through_gesture.ts` | 穿透式手势采集：裸屏画线、右键取消、多笔链提交 |
| `coordinate_space.ts` | 物理像素↔DIP 坐标换算、归一化矩形与手势几何 |
| `python_runtime.ts` | 定位 Python 解释器（打包内置/环境变量/PATH）+ 隔离环境 |
| `voice_worker_client.ts` | 本地语音 worker 子进程客户端：JSONL、麦克风/WAV 听写、空闲卸载 |
| `voice_resident_runtime.ts` | 常驻语音运行时：预热/会话/崩溃退避重启/状态发布 |
| `voice_focus_guard.ts` | 语音期间前台 HWND 稳定性证据收集 |
| `task_watcher.ts` | 后台任务观察器：退避轮询、任务状态→卡片补丁、终态即停 |
| `renderer_readiness.ts` | 渲染器就绪信号门闩 |

### 4.2 `electron/renderer/` 渲染层（15 个 .ts + 8 个 HTML）

| 文件 | 功能 |
|---|---|
| `overlay.ts` + `index.html` | 全屏透明指针层：画线轨迹、扫线、引导三角飞行、手势链提交 |
| `sweep_visual.ts` | WebGL 扫线渲染器：SDF 路径、尾迹渐变、线段着色器 |
| `stage.ts` + `stage.html` | PointerStage 主渲染器（~2270 行）：目标框/冻结光/胶囊/结果线程/同意/展开/拾取 |
| `panel.ts` + `panel.html` | 命令气泡窗：输入/语音自动提交/尺寸自适应/结果态自动消失 |
| `studio.ts` + `studio.html` | 工作室：对话流、收藏箱画布（布局/平移缩放）、时间线/记忆/产物/设置页 |
| `companion.ts` + `companion.html` | 随行小窗：与工作室同数据同渲染、pin/expand/hide |
| `onboarding.ts` + `onboarding.html` | 首次引导：欢迎/进度/成功/失败四屏 |
| `settings.ts` | 设置界面：声明式页面结构渲染、控件交互、搜索、刻度滑杆 |
| `data.ts` | 渲染层数据层 + 全部共享类型声明（`declare global`） |
| `cards.ts` | 卡片数据契约（主进程/渲染层双加载）：归一化/补丁合并/进度不造假 |
| `card_render.ts` | 卡片契约→DOM 唯一渲染器（h() 造节点禁 innerHTML） |
| `live_cards.ts` | "活卡"注册表：补丁就地更新不重建、终态停计时器 |
| `composer.ts` | 三界面共用输入条：附件预览、生成态同条切换 |
| `gallery.ts` + `gallery.html` | 卡片视觉核对页（开发用）：十种卡 × 三态 |
| `lab.ts` + `lab.html` | 交互实验页（开发用） |
| `icons.ts` | SVG 图标精灵注入 + 烟雾滤镜 defs |
| CSS | tokens.css / oreo_tokens.css（设计令牌）、oreo.css、cards.css、stage.css、studio.css、beam.css、typography.css |

### 4.3 `app/` Python 业务核心（~100 个模块）

**fabric/（34 个）——动作织布机，心脏**
| 文件 | 功能 |
|---|---|
| `engine.py` | 核心流水线：plan（路由→配方→捕获策略→视觉中继规划→目标租约→上下文包→权限决策→提供方选择→HMAC 签名）→ execute（签名校验→确认门→实时租约校验→执行器→回执→产物→审计） |
| `executors.py` | 执行器分发：clipboard / native.ocr（rapidocr→tesseract 回退）/ artifact.table / evidence / compare / visual_context / list / local.memory / local.task / maps.deep_link / overlay.translation / model.text / inplace.text / agent.task（+ 外部注入 provider_handlers） |
| `intent_router.py` | 三级路由"永不答不支持"：L0 确定性（指令库 0.99 置信 → 本地动作 → 信息性问题直答 → 6 组关键词规则）；L1（Recipe 关键词 ≥0.70 或模型分类 ≥0.55）；L2（全配方当工具自由组合 / 纯文本回退；长尾句式 3 次即存为 L0 快路径） |
| `agents.py` | 各 Agent CLI 的 argv/stdin 调用契约（codex/pi/claude/gemini/cursor/opencode/aider/generic） |
| `agent_sessions.py` | 发现各 CLI 已存会话（路径/标题/首条消息/存活探测/cwd 匹配去重） |
| `agent_gateway.py` | Agent 调用唯一入口：payload 校验（禁 submit/权限 read-write）、会话解析、任务持久化、租约强校验 |
| `agent_context_handoff.py` | 上下文包不可变密封 + 多代理派发 |
| `agent_prompt_dispatch.py` | 提示词校验并派发到指定代理会话 |
| `context_packet.py` | 构建含工作区/终端/浏览器/元件证据的上下文包与提示词 |
| `catalog.py` + `recipe_manifest.py` | 配方目录加载（内置 JSON + 插件目录） |
| `capabilities.py` | 按关键词/对象类型给配方打分检索 |
| `capability_snapshot.py` | 各项能力就绪状态快照（Dashboard 用） |
| `capture_policy.py` | 截图捕获模式与敏感应用决策 |
| `artifacts.py` | 本地产物注册表与保留期回收 |
| `audit.py` | 脱敏 JSONL 审计日志 |
| `hooks.py` | 提示词引用指针对象时的 hook 处理 |
| `mcp.py` | 作为 MCP 服务器暴露工具 |
| `mcp_client.py` | 客户端调用用户已配置的 MCP 服务器 |
| `model_plan.py` | 模型结构化计划契约与工具注册表（TOOL_REGISTRY） |
| `provenance.py` | 指针对象→执行/产物反向索引 |
| `providers.py` | 探测各 Agent CLI 可用性与版本 |
| `router.py` | 确定性关键词首轮路由与指代模式 |
| `runtime_snapshot.py` / `runtime_workspace.py` | 引擎快照 / 工作区/进程绑定/终端证据解析 |
| `schema.py` | 配方/计划/回执数据契约 |
| `settings.py` | Fabric 设置存储与权限决策（allow/confirm/deny） |
| `skill_candidates.py` | 从代理任务观察可复用技能候选 |
| `target_lease.py` | 目标窗口租约创建与存活校验 |
| `task_store.py` / `workflow_task_store.py` | 代理任务持久化 / 跨 CLI-GUI 计划执行门闩 |
| `workflow.py` | 操作流程图节点与边生成 |

**actions/（15 个）——动作实现**
`executor.py`（类型化执行器 + 11 类动作）、`policy.py`（权限分级，屏蔽 send_message/delete_file/run_shell）、`history.py`（动作账本 before/after sha256 + 精确撤销提案）、`office.py`（Word/WPS 替换提案）、`calendar.py` + `calendar_draft.py`（事件创建/撤销 + 从文本解析日期地点）、`shopping_list.py`、`route_draft.py`（"这两个地方"起终点）、`table_merge.py`（多表合并 CSV）、`draft_writer.py`（UIA 写回，拒写已有草稿）、`draft_delivery.py` + `capsule_delivery.py`（投递原应用 + 剪贴板回退）、`clipboard_history.py`（100 条/7 天环形历史）、`schema.py`（提案/结果/安全等级契约）

**adapters/（7 个）——原生接口适配**
`browser_devtools_adapter.py`（CDP 探测 Chrome/Edge：选区文本/矩形/CSS 选择器/网络失败检测，端口 9222/9223/9224/9333/9515 + 30s 冷却）、`uia_text_adapter.py`（运行时 csc 编译 C# 探针，UIA TextPattern 读任意 Win32 窗口）、`office_adapter.py`（Word/WPS/Excel/PowerPoint COM）、`pdf_selection_recovery.py`（PDF 截屏 OCR + 文本层匹配恢复选区/页码）、`base.py` + `registry.py`（抽象基类 + 默认装配）

**grounding/（11 个）——把选区接地为真实对象**
`explorer_adapter.py` + `explorer_context.py`（Explorer 文件绝对路径）、`terminal_evidence.py`（终端缓冲区提取/脱敏）、`wechat_media.py`（微信消息→真实文件，三档诚实级别）、`marked_read.py` + `ocr_mark_selection.py`（验证结构化读取覆盖划线 + 笔画→OCR 行映射）、`perception_cascade.py`（感知优先级 native_app/dom/uia/ax/像素）、`component_source.py`（浏览器元件→仓库源码文件）、`schema.py` + `base.py`

**models/（6 个）**：`capability_resolver.py`（能力三态解析）、`catalog.py`（模型目录）、`profiles.py`（配置档校验存储）、`runtime_client.py`（按配置档调用端点）、`visual_relay.py`（视觉中继规划：直传/结构化）

**context_pack/（6 个）**：`session.py`（上下文包会话持久化）、`compiler.py`（汇编为代理提示词）、`capture_policy.py`、`intent.py`（收集/编译/交付/清空意图）、`screen_memory.py`（屏幕阅读记忆）

**vision/（5 个）**：`visual_elements.py`（OCR 行聚合为可指点对象）、`visual_element_cache.py`（磁盘缓存元件矩形）、`image_prompt.py`（图片转提示词三层：OCR+元件+字幕）、`overlay_translation.py`（逐块翻译布局覆盖层）

**其他**：`review/`（接地审阅：session + compiler）、`text_actions/`（point_markers 指点标记 / length_target 拉伸目标 / custom_action_request）、`voice/text_normalization.py`（繁简/标点/空格规范化）、`terminology/glossary.py`（术语表契约）、`dashboard/`（本地日历事件存储 + 购物清单存储）、根文件：`ai_client.py`（文本/工具/视觉三通道 LLM 客户端 + 视觉能力分类）、`file_context.py`（本地文件读取：文本/HTML/PDF/ZIP）、`model_health.py`（熔断）、`object_store.py`（指针对象持久化）、`pointer_operator.py`、`screen_context.py`（窗口枚举/选区覆盖）、`system_context.py`（Win32 句柄/DPI）、`task_context.py`、`visual_annotation.py`（截图标注）

### 4.4 `scripts/` 桥接与工具（~90 个）

**JSONL 桥（Electron 子进程协议：stdin 读 JSON / stdout 写 JSON）**
- `selection_bridge.py`（129KB，主桥）：选区结构化读取 + 三层意图路由 + 动作提案 + 执行
- `selection_snapshot_bridge.py`（87KB）：划线快照"感知级联"：DPI 截屏→结构化→常驻 OCR→视觉回退，marked-read 评分锁定对象 + 目标窗口身份哈希 attestation + TTL 临时锁定
- `electron_bridge.py`（40KB）：Electron 主入口桥：runtime-issue 模式/问答载荷、截屏视觉标注、窗口捕获决策、上下文打包
- `fabric_bridge.py`（32KB）：面向 Agent 的通用桥（40+ 操作），Pi 扩展与 MCP 的公共后端
- `action_bridge.py` / `agent_bridge.py` / `agent_hook_bridge.py` / `calendar_bridge.py` / `shopping_list_bridge.py` / `stash_describe_bridge.py` / `deliver_text_bridge.py`（写回+读回验证）/ `expand_passage_bridge.py` / `element_probe_bridge.py` / `sense_voice_bridge.py`（sherpa-onnx）
- `_bridge_common.py` / `bridge_progress.py`（公共协议/阶段耗时上报）

**常驻 worker**：`agent_worker.py`（后台任务领取/steer/租约控制）、`local_voice_worker.py`（常驻听写，JSONL，无 UI）、`ocr_resident_worker.py`（TCP OCR 服务）、`voice_engine.py`（Whisper/SenseVoice 统一接口）、`local_voice_bridge.py`（麦克风+VAD+增量转写）

**C# 原生探针**：`uia_selection_probe.cs`（读选区）、`uia_draft_writer.cs`（写回/替换）、`uia_tree_dump.cs`（UIA 树转储）、`native_element_picker_demo.cs`（拾取器演示）

**PowerShell/VBS/BAT**：`prepare_python_runtime.ps1`（可移植 Python 运行时）、`pointer_input_state.ps1`（指针状态流）、`office_selection_probe.vbs`、`MagicPointer.vbs`（无窗口启动）、`verify_windows_package.ps1` / `verify_windows_installer.ps1`

**开发工具**：`build-electron.ts`、`run-node-tests.ts`、`run-electron-builder.ts`、`collect-diagnostics.ts`、`capture_*.ts`（8 个视觉回归截图）、`cdp_eval.py` / `cdp_shot.py`、`extract_frames.ts`、`analyze_pointer_videos.py`、`benchmark_voice_engines.py`、`smoke_fabric.py`、`install_agent_hooks.py`、`sense_voice_setup.py`（下载模型）

**真机验收**：`verify_marked_line_answer.py`、`verify_first_run_onboarding.py`、`verify_n19_voice_triggers_desktop.py`、`verify_n20_resident_desktop.py`、`verify_browser_selection_alignment.py`、`verify_stage_selection_visual.py` 等

### 4.5 测试（285 个文件）
- Python `*_test.py` 147 个（pytest，1073 项）；Node `*_test.js` 107 个 + `*_test.ts` 20 个（`scripts/run-node-tests.ts` 独立进程加载，127 项）
- 测试风格：**源码文本契约测试**（断言架构约束，如"main 必须使用 shared GroundingGeometry 模块"）+ 行为测试 + 静态 wiring 测试；fixtures 含 UIA 树样例/HTML 样例

### 4.6 数据与配置
| 路径 | 内容 |
|---|---|
| `data/recipes/builtin.recipes.json` | 39 个 Recipe 定义（id/title/description/inputKinds/outputKind/providerStrategies/risk/verification/keywords/minObjects/maxObjects/platforms/version/provider） |
| `data/objects/` | 运行态：current-object.json、objects.jsonl、action_history、task_state、clipboard-history、screen-memory |
| `data/runtime/` | 证据/日志/截图（electron.log、fabric-audit.jsonl、events.jsonl、验收证据包） |
| `data/models/` | SenseVoice/Whisper 模型（大文件，不入 git，`/data/models/` 已 gitignore） |
| `integrations/` | claude（MCP + UserPromptSubmit hook）、codex（config.toml）、cursor（MCP）、gemini（BeforeAgent hook）、pi（extension.ts 4 工具 + pointer 斜杠命令）的接入示例 |
| `native/macos/MagicPointerHost.swift` | macOS 指针宿主（权限/35ms 指针流/滚动归并） |
| `packaging/` | installer.nsh（卸载保留数据询问）、entitlements.mac.plist（JIT/音频输入/Apple Events） |
| `docs/` | ARCHITECTURE.md（架构事实）、PRODUCT.md（产品定位）、STATUS.md（状态基线）、AGENT_INTEGRATION.md（Agent 分级接入）、ROADMAP.md（依赖顺序）、superpowers/plans/（实施计划） |

---

## 五、关键设计决策（讨论扩展时的背景）

1. **感知诚实性**：不知道就说不知道。`capability_unavailable` 不伪造成功；微信重名文件报 ambiguous；PDF 恢复不了选区就明说。`marked_read` 验证"读到的真的覆盖了画到的"。
2. **双进程边界**：Electron 主进程只做窗口/输入/协议；一切 AI 决策在 Python 侧；两者只走 JSONL，无共享内存。
3. **纯函数策略层**：决策逻辑抽成可在 Node 测试里直接跑的纯函数（IIFE 双发布），渲染层与主进程共用同一份契约。
4. **签名授权链**：计划签名→确认→执行，Renderer/hook/Agent 三方都不能改 provider/参数后复用授权。
5. **路由永不落空**：L0→L1→L2 三级，模型不可用时纯文本兜底，长尾句式自动沉淀为快路径。
6. **上下文包不可变密封**：Agent 收到的是签名后的快照，防止中途被改。
7. **常驻 worker 哲学**：语音/OCR/Agent 任务都是常驻子进程 + JSONL + 空闲卸载 + 崩溃退避重启。

---

## 六、后续能力接入的扩展点（供讨论）

- **新 Recipe**：往 `data/recipes/` 加 JSON（或插件目录），引擎自动纳入检索/路由/执行——无需改 Python 代码；需要新执行器时在 `fabric/executors.py` 加一个 provider 分支
- **新原生适配**：`app/adapters/` 加适配器 + 注册进 registry，感知级联自动尝试
- **新 Agent**：`app/fabric/agents.py` 加 argv 契约 + `integrations/` 加 hook 示例；MCP 兜底
- **新交互手势**：`gesture_capture.ts` 加分类 + `stage_turn_stream.ts` 加语义
- **新本地模型**：`scripts/voice_engine.py` / `ocr_resident_worker.py` 换后端，接口不变
- **新窗口表面**：`electron/main.ts` 建窗 + `preload.ts` 加 API + renderer 加 HTML/TS
- **跨平台**：macOS 实机验证 + 指针宿主完善；Linux 需新写系统指针宿主
- **待办缺口**（STATUS.md 记录）：工作室设置面板与 fabric schema 键名不对齐（静默失败）、settings.save 整体替换非合并、旧 dashboard 约 100 个设置控件无等价物、MCP slot 卡桥不会产出、token 热力图无数据等
