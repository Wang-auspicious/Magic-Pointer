# Context & Prompt Compiler Alpha Implementation Plan

> 执行方式：当前工作树包含同一产品链路的未提交实现，本轮在原工作树上小步测试驱动集成，不新建会遗漏这些改动的隔离 worktree。

**Goal:** 交付“指向/选中 → 多对象 Context Pack → target-specific prompt → 精确填入 Agent 且不发送”的 Windows Alpha，并保留现有 review 工作流兼容性。

**Architecture:** 新的 `app/context_pack` 负责显式意图、持久 session、目标 profile 和 prompt 编译；原生选择桥与视觉桥都只生产统一 item。Electron 只展示状态并转交 policy-checked delivery proposal，实际写入继续由受限的内部动作执行器处理。

**Tech Stack:** Python 3、Electron/Node.js、原生 Win32/UIA、pytest、Node `assert` 静态与单元测试。

---

### Task 1: 固化 Dashboard 后置与现状处置

- [x] 把 Dashboard 的设置、连接、权限、配方、审计职责写入产品研究记录。
- [x] 在设计规格中列出保留、重构、降级和新增模块。
- [x] 运行当前 Node/Python 基线并记录现有唯一失败：HTML context 在缺少 BeautifulSoup 时走 regex fallback。

### Task 2: Context Pack 核心（先红后绿）

**Files:**
- Create: `tests/context_pack_intent_test.py`
- Create: `tests/context_pack_session_test.py`
- Create: `tests/context_pack_compiler_test.py`
- Create: `app/context_pack/__init__.py`
- Create: `app/context_pack/intent.py`
- Create: `app/context_pack/session.py`
- Create: `app/context_pack/compiler.py`

- [x] 写出显式收集、编译、交付、清理命令的失败测试，运行确认缺少模块。
- [x] 写出 native/visual item、去重、重载、原子保存和空 session 边界测试。
- [x] 写出 Codex/Claude/Gemini/Pi/generic profile 与有界 prompt 测试。
- [x] 实现满足测试的最小核心，不从模型输出反推来源事实。

### Task 3: 通用 Handoff 契约（先红后绿）

**Files:**
- Modify: `tests/draft_delivery_test.py`
- Modify: `tests/internal_action_policy_test.js`
- Modify: `app/actions/draft_delivery.py`
- Modify: `electron/internal_action_policy.js`

- [x] 先测试 `make_prompt_delivery_proposal` 的窗口、坐标、hash、profile、`submit=false` 契约。
- [x] 实现通用 proposal，并让旧 review 工厂成为兼容包装器。
- [x] Electron policy 仅允许受信的 `context_prompt_delivery` 与既有 review delivery 自动执行。

### Task 4: 原生选择桥接入 Context Pack（先红后绿）

**Files:**
- Create: `tests/context_pack_selection_bridge_test.py`
- Modify: `tests/selection_snapshot_bridge_test.py`
- Modify: `scripts/selection_bridge.py`
- Modify: `scripts/selection_snapshot_bridge.py`

- [x] 为收集、编译、目标 Agent 交付、空 session、重复条目写失败测试。
- [x] 在通用命令优先级后保留 review 与 Lab 工作流兼容。
- [x] active Context Pack 存在时，目标输入区建议 `发送 N 条上下文`，而不是 review-only 文案。

### Task 5: 视觉桥接入 Context Pack（先红后绿）

**Files:**
- Create: `tests/context_pack_visual_bridge_test.py`
- Modify: `scripts/electron_bridge.py`

- [x] 测试视觉 item 构造保留 raw/pointer screenshot、bbox、grounding、文件/应用 context 和视觉观察。
- [x] 收集命令对视觉模型使用去掉前缀后的实际说明。
- [x] 即使视觉模型失败，也可记录截图与几何信息并明确缺失观察。

### Task 6: Command Rail、Overlay 与系统听写

**Files:**
- Modify: `tests/panel_static_test.js`
- Create: `tests/overlay_static_test.js`
- Create: `tests/dictation_static_test.js`
- Modify: `electron/renderer/panel.html`
- Modify: `electron/renderer/panel.js`
- Modify: `electron/renderer/index.html`
- Modify: `electron/renderer/overlay.js`
- Modify: `electron/preload.js`
- Modify: `electron/panel-preload.js`
- Modify: `electron/main.js`
- Create: `scripts/start_windows_dictation.ps1`

- [x] 先测试通用文案、上下文计数、麦克风 IPC、无自动 submit 和听写脚本边界。
- [x] 实现紧凑 Command Rail/Overlay 麦克风按钮与收集/交付状态。
- [x] 主进程只接受来自已知窗口的 IPC，Windows 上触发系统听写；其他平台明确失败。
- [x] 默认关闭启动弹层和鼠标摇动唤醒，保留主动快捷键。

### Task 7: 回归、桌面冒烟与边界审核

**Files:**
- Modify: `README.md`
- Modify: `HANDOFF_2026-07-10_MAGIC_POINTER.md` only if it is the active handoff document

- [x] 运行完整 `npm test` 与 `pytest`，区分既存失败和新增失败。
- [x] 启动 Electron，验证主进程、快捷键注册和新版 Command Rail 可见行为；保存界面截图。真实第三方 Agent 写入仍需人工端到端验收。
- [x] 更新 README 的主链、命令、平台边界和 Dashboard backlog。
- [x] 完成后启动 `gpt-5.6-terra` 子 Agent，只做边界情况与安全契约审核。
- [x] 主 Agent 复核 Terra 意见，修复有效问题并重跑相关验证。
