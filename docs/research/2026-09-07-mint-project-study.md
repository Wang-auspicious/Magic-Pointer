# Mint（Pheem49/Mint）项目研读与 Magic Pointer 对照

日期：2026-09-07  
上游：[Pheem49/Mint](https://github.com/Pheem49/Mint)  
本地副本：`external/mint`  
当前 HEAD：`d7ac2d63a01d9781df0a4d00ec385d432629e1e9`（2026-09-05，`Merge pull request #46 from Pheem49/Rust`）  
仓库版本：`1.13.1`  
许可证：AGPL-3.0-only

## 下载结果

仓库已经成功 clone 到：

```text
D:\Desktop\Magic Pointer\external\mint
```

这是一个完整源码仓库，不是只有二进制下载包。顶层包含：

- Rust workspace：`crates/mint-core`、`crates/mint-cli`、`src-tauri`
- Tauri v2 desktop app
- React + TypeScript desktop/web UI
- CLI `mint`
- messaging bridges、MCP、插件、浏览器自动化、记忆和任务模块
- Windows/macOS/Linux 的构建和安装说明

没有在 Magic Pointer 工作区安装 Mint 的依赖或运行它的安装脚本。这样做是为了避免 AGPL 项目的依赖、编译产物和本机配置污染 MP；源码已完整保留，后续可以按需做只读分析或在隔离目录构建。

## 它到底是什么

Mint 不是单纯的 computer-use executor，也不是 Pi 那种专注 UI resource/state 的桌面控制层。它更像一个“本地助手产品 + agentic CLI + 多入口网关”的完整应用：

```text
Telegram / Discord / Slack / LINE / WhatsApp / Signal / Gmail
                         │
CLI ───────────────┐     │     ┌── Tauri desktop / Live2D UI
Web API ───────────┼─────┼─────┤
                   ▼     ▼     ▼
       mint-core Rust orchestration / memory / tools / safety
                   │
       browser automation / MCP / shell / files / code agent
```

它的强项是“一个 Rust core，多个入口共享会话、记忆、工具和安全策略”。这和 MP 想做的 sovereign Runtime、长任务、跨入口继续工作，方向确实高度相似；但它的桌面控制深度和 MP 当前的 UIA/Lease/Receipt 设计不是同一层级。

## Mint 已实现的主要能力

### 1. 多入口长期助手

- CLI、Tauri desktop、web UI 共用 `mint-core`。
- Telegram、Discord Gateway/RPC、Slack Socket Mode、LINE、WhatsApp Cloud API、Signal、Gmail bridge。
- `mint gateway start/install` 支持 headless 24/7 运行和健康检查接口。
- 会话和记忆通过 SQLite 持久化，跨入口共享 conversation。

这部分与 MP 的 sovereign Runtime、durable task context、resume 和可见进度目标直接相关；Mint 把“同一个 agent 从不同入口继续说话”做成了产品主线。

### 2. Agent loop 与 native tool calling

`crates/mint-core/src/orchestration` 是实际的 agent driver，不是一个只负责转发 prompt 的壳。它负责：

- provider native tool calling
- 工具 catalog
- tool-call / tool-result 历史
- 计划、审批和结果路由
- fallback provider
- 任务和子 agent 调度

支持 Gemini、OpenAI、Anthropic、Ollama、Hugging Face 和 OpenAI-compatible endpoint。工具 schema 会按 provider 做转换，例如 Gemini 的 function declarations、Anthropic 的 input schema 和 OpenAI 的 function schema。

### 3. 代码 agent 与 subagents

README 宣称可以：

- 扫描 workspace
- 制定多文件计划
- 编辑文件
- 运行 shell/test
- 验证结果
- 通过 `dispatch_subagent` 委派子任务
- 可选 Docker sandbox

这和 MP 的长任务、子任务、durable progress 目标明显相似。需要注意的是，Mint 当前的主价值在 agent orchestration；它不是把所有副作用都包装成 MP 这种 Lease/Effect/Receipt 级别的动作协议。

### 4. Memory、knowledge、skills

- SQLite persistent conversation memory
- FTS/semantic knowledge search
- local code/repository search
- linked folders
- agent 可以创建或更新 `.agents/skills/`
- `mint skills add` 从本地或 GitHub 安装 skill

这部分很接近 MP 要做的 durable context、memory 和 skill evolution，但实现假设与 MP 的 task journal、compaction ledger、事件流仍需逐模块对照，不能只看 README 名称相同就判定等价。

### 5. 浏览器自动化

Mint 有一个名为 `mint auto` 的专用 automation browser：

- 启动隔离 Chromium profile
- 通过 CDP 连接固定的 automation browser
- `browser_open`
- `browser_click`
- `browser_type`
- `browser_mouse_move`
- `browser_mouse_click`
- 页面读取／截图／导航
- 通过 native CDP `Input.*` 发送鼠标和键盘事件

源码位置：

- `crates/mint-core/src/browser/lifecycle.rs`
- `crates/mint-core/src/browser/input.rs`
- `crates/mint-core/src/browser/interact.rs`
- `crates/mint-core/src/orchestration/tools/browser.rs`

它有一个重要特点：浏览器自动化是独立的 CDP surface，不是全桌面 UIA resource abstraction。它可以做真实浏览器动作，但不能据此推出它已经完成 Windows 原生应用的 semantic UI automation。

### 6. 屏幕捕获与翻译

Tauri desktop 的 `desktop.rs` 有：

- `capture_screen`
- 屏幕区域翻译
- Windows/Linux/macOS 平台命令或原生能力的 capture fallback
- 结果以 data URI 或图像内容交给模型/UI

这与 MP 的完整 target-surface evidence、FrameLease 和冻结历史像素有共同目标，但目前从源码结构看，Mint 的 screen capture 更像“拍一张给模型看”的产品能力，不等同于 MP 的 gesture completion freeze、full local evidence retention 和 historical/current evidence separation。

### 7. 原生桌面动作的实际边界

Mint 的 Tauri `desktop.rs` 有一个 `DesktopAction` 路由和 `system_automation` allowlist，支持的动作包括：

- `open_url`
- `open_app`
- `search`
- `system_info`
- `system_automation`
- `find_path`
- `create_folder`
- `learn_file`

但这不是 Pi/Kimi 那种完整的 UIA 元素工具面。源码中没有发现等价于 MP 当前这组 state-scoped semantic desktop tools 的 native surface：

- `find_roots`
- `observe_ui`
- `search_ui`
- `expand_ui`
- `inspect_ui`
- `read_text`
- `wait_for`
- `act_ui`

因此 Mint 的“desktop assistant”产品表述很宽，但在“观察任意 Windows 原生应用的 UIA 树 → 以稳定元素身份写入 → 读回确认”的深度上，不能直接判定领先 MP。

## 与 Magic Pointer 的直接对照

| 维度 | Mint | Magic Pointer 当前方向 | 判断 |
|---|---|---|---|
| 多入口 | CLI、Tauri、Web、多个 messaging bridge | MP Runtime + Studio + 外部 prompt delivery channels | Mint 的入口产品更宽；MP 的执行内核边界更严格 |
| 长任务 | agent loop、tasks、headless gateway、SQLite memory | sovereign Runtime、compaction、durable task context、resume、progress、steer/interrupt | 方向高度相似，需要继续对照任务 journal 和恢复语义 |
| 子任务 | `dispatch_subagent`，可选 Docker sandbox | MP Runtime 内部 subtask/worker 方向 | Mint 有成熟产品入口，MP 需确保 subtask 不是外部 harness 转发 |
| 工具调用 | Rust orchestration + provider-native schemas | MP ToolRegistry + Runtime + Effect/Receipt | 两者都有 model-as-router；MP 对副作用边界定义更重 |
| 浏览器 | CDP 隔离 Chromium，CSS selector/native input | MP BrowserDevToolsAdapter + 统一 resource/lease 方向 | 能力相近，但语义状态协议要继续对照 |
| 原生 Windows UI | `system_automation` 等高层动作，未见完整 UIA tree tool surface | UIA ControlView、state/ref、ActionLease、readback | 这是 MP 当前明显优势之一 |
| 视觉证据 | capture screen / translation | FrameLease、冻结像素、全 surface evidence、并发 evidence fusion | MP 的证据治理更严格 |
| 记忆 | SQLite conversation、knowledge、semantic search | durable task context、compaction、memory ledger | Mint 的产品化记忆更完整；MP 要补齐可恢复任务上的用户可见语义 |
| Skills | 可安装、可自我创建／更新 | Codex skills + MP 运行时治理 | Mint 的 skill marketplace/安装路径值得借鉴，AGPL 代码不能直接复制 |
| 安全 | risky action/file write approval、Docker sandbox | ActionLease、Effect、EgressGate、Receipt、SurfaceGrant | MP 对动作授权与结果证据更细 |
| UI 产品面 | Live2D、dashboard、web、gateway | Studio、task cards、可见 progress、takeover | Mint 的产品入口和陪伴形态很强；MP 的 agent task surface 更聚焦执行证据 |

## 和我们最像的地方

真正相似的不是 Live2D 或 messaging，而是下面四个内核判断：

### A. 同一套核心逻辑服务多个表面

Mint 明确规定 CLI、desktop、web 共享 Rust domain layer；MP 的设计也明确要求外部 connector 只是 prompt-delivery channel，所有任务最终进入 MP 自己的 Runtime。

可吸收点：把“入口”与“执行”分开，任何 Telegram/Studio/CLI 输入都落成同一种 `RunEnvelope/Task`。

### B. 工具由模型路由，但由运行时掌管副作用

Mint 的 `orchestration` 让模型调用工具；MP 进一步把权限、Lease、Effect、Receipt 和 verification 留在 Runtime。

可吸收点：继续扩大 MP 的自描述工具 catalog，但不要因为 Mint 的工具数量多就直接复制其高层 action dispatch。

### C. 长期运行是产品能力，不是“另一个客户端的任务”

Mint 的 gateway/headless、tasks、memory 证明了用户需要跨小时、跨入口的 agent；这直接支持 MP `AGENTS.md` 中“长任务是一等公民”的判断。

### D. 本地优先和模型可替换

Mint 同时支持云模型、本地 Ollama 和兼容 endpoint；MP 也需要让 Runtime 不绑定某一家模型或某一个外部 harness。

## Mint 目前不能替代 MP 的地方

### 1. 没有证据表明它拥有 Pi 级完整桌面 UI 状态协议

目前读到的 Mint 源码明确展示了浏览器 CDP input 和 screen capture，但没有展示：

- root/element state refs
- UIA RuntimeId/AutomationId 重定位
- bounded progressive outline
- stale state rejection
- 同资源 epoch / scheduler
- postcondition successor diff
- 原生 Windows app 的语义 pattern 统一层

这些是 MP 最近接入 Pi/Kimi 合并工具面时真正补的能力。

### 2. 浏览器自动化不等于任意桌面自动化

Mint 的 `browser_click` 使用 CSS selector 或 CDP coordinates；这对隔离 Chromium 很好，但不能覆盖 Excel、PowerPoint、微信、钉钉、系统弹窗等非 DOM 应用。

### 3. screen capture 不等于可审计动作证据

“截屏给模型看”与“动作前冻结、动作后保存、历史像素不可被 overlay 改写、局部 OCR 不能替代 full surface evidence”是不同的工程承诺。

### 4. AGPL-3.0-only 不是可以随意摘代码的许可证

Mint 的仓库许可证是 AGPL-3.0-only。当前仅做源码研读和本地 clone，没有把 Mint 代码复制进 Magic Pointer。若未来考虑复用具体代码，必须单独做许可证、边界、派生作品和分发义务审查；在没有明确裁决前只吸收公开架构思想，不复制实现。

## 推荐吸收清单

### 高优先级：吸收产品结构

1. **统一 core、多个入口**：把 MP 的 Studio、CLI、未来 messaging bridge 都映射到同一个 Task/RunEnvelope，而不是每个入口各造 loop。
2. **headless gateway**：为跨小时任务和远程入口补充健康状态、任务列表、恢复与接管接口。
3. **共享 memory + task context**：区分 conversation memory、durable task journal、skill memory 和 surface evidence，不把它们揉成一张聊天历史表。
4. **subagent 作为 Runtime 子任务**：借鉴 Mint 的 dispatch UX，但执行仍留在 MP sovereign Runtime。
5. **skill 安装治理**：借鉴 `mint skills add` 的用户路径，但按 MP 的 Reuse Gate、许可证和权限契约接入。

### 中优先级：吸收工具产品化

1. MCP server/plugin 管理面。
2. provider-native tool schema 适配。
3. headless 任务健康 endpoint。
4. 多入口 identity binding 和 bridge first-user lock。
5. 本地 Ollama/兼容 API 的统一配置。

### 不应直接照搬

1. 不复制 AGPL 实现代码到 MP。
2. 不把 Mint 的高层 `system_automation` 当成 UIA semantic executor。
3. 不把 CDP browser input 误当成 Windows native app parity。
4. 不用普通 screen capture 取代 MP 的 FrameLease/evidence contract。
5. 不把 Mint 的 messaging bridge 直接接成外部执行 harness；它只能成为 MP Runtime 的输入表面。

## 结论

Mint 确实和 Magic Pointer 的总体目标高度相似：都是本地优先、可多入口访问、拥有 agent loop、工具调用、记忆、长任务和自动化能力的“自己的助手系统”。它最值得学习的是**产品整合宽度**：一个 Rust core 同时支撑 CLI、桌面、Web、消息桥、知识和后台 gateway。

但“很像”不等于“它已经做完了我们正在做的 native computer-use kernel”。从当前源码证据看：

- Mint 在**入口、记忆、gateway、插件、浏览器自动化、代码 agent 产品化**上很强；
- MP 在**Windows 原生 UI 语义、冻结证据、状态引用、Lease、Effect、Receipt、动作后验证**上走得更深；
- 两者最合理的关系是：吸收 Mint 的多入口和长期运行产品结构，同时保持 MP 自己的 sovereign desktop execution contract。

本地源码副本已经保留，后续可以在不污染 MP 主依赖的情况下继续逐模块审计其 `orchestration`、`memory`、`tasks`、`subagents`、`browser` 和 `safety`。
