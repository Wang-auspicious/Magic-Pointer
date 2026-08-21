# Magic Pointer 8·11 Harness 总方案

> 状态：2026-08-11 已由用户确认核心方向；这是后续底层重构的首要事实源。
>
> 当前阶段：先重构捕获、感知、对象和 Harness 内核；视觉层遵守 `VIDA_UI_SPEC.md`，但不作为本阶段主线。
>
> 更新规则：任何架构边界、数据契约、性能结论、阶段完成情况发生变化，都必须先更新本文“进度账本”，再结束任务。

## 0. 新接手模型必须先做什么

每个新的 Agent/模型在修改项目前，按顺序执行：

1. 完整阅读本文，不能只读摘要。
2. 阅读根目录 `AGENTS.md`，确认当前阶段、禁止事项和验证要求。
3. 阅读 `docs/STATUS.md`，区分已验证能力、只完成代码的能力和仍需真机验收的能力。
4. 根据任务类型，按本文 §16 的“回读路由”读取对应本地材料。
5. 检查 `git status`，保护其他 Agent 或用户尚未提交的修改。
6. 修改旧模块前先执行 §13 Reuse Gate；“已有代码能跑”不是复用理由。
7. 新功能和重构都必须测试先行；不得先写生产代码再补测试。

本文不是一次性方案稿。它同时承担：

- 产品边界；
- Harness 架构决策；
- 关键数据契约；
- 性能和资源预算原则；
- 源码借鉴清单；
- 分阶段实施顺序；
- 跨会话进度账本。

## 1. 这次对话最终澄清的产品定位

### 1.1 Magic Pointer 就是那个 Harness，任务时长不是边界

> 2026-08-19 用户纠正：本节此前写的“短任务边界 / 项目级交给外部 Agent”是错的，已作废。以下为现行边界。

- Magic Pointer 要做的是顶级 Agent Harness 本身，不是别人 Harness 的前端、插件或上下文供应商。
- 任务时长不是产品边界。一轮改写，和需要几十上百轮、跨小时、跨会话的长程任务，同为一等公民，都由 MP 自有 Runtime 承担。
- 因此长程能力是必须做的本体功能，不得以“这属于项目级 Agent”为由推给外部客户端：上下文压缩、子任务分解、持久记忆、断点续跑、进度可见、steer/中断/接管、失败恢复。
- 目标是最综合、最集成各方优点的 harness。Claude Code 的自描述工具与模型即路由、Pi 的 loop、Hermes 的成品面、Kimi CU 的动作原语、DSH 的插件与事件溯源，全部吸收进 MP 自己的内核，而不是把活外包给它们。
- 把编译好的 Prompt 写进外部客户端（Claude Code/Codex/Cursor）只是一条投递通道，与“把文字写进微信输入框”同一性质、同一量级。它只服务于“用户已经用惯那个客户端、不愿意换”的情况；它不是任务难度分级器，也不交出执行权。
- 唯一仍然属实的旧结论：MP 不专门做仓库级代码重构的产品化体验。这是产品重心，不是能力上限——不得据此给 Runtime 加轮次、时长或复杂度封顶。

典型任务，短与长都在范围内：

- 圈选聊天记录、图片、文件和桌面材料，生成报告或回复；
- 把多处零散信息编译成高质量 Prompt；
- OCR、改写、翻译、扩写、表格提取、文件转换；
- 打开应用、调整音量、调用地图/日历等 MCP；
- 跨应用完成可验证的多步任务，步数由任务决定而非由预算封顶；
- 长程作业：批量处理成百上千条目、盯守长时间运行的过程并按结果分支、跨小时推进并在中断后续跑；
- 生成结果后允许用户编辑，再写回、发送或保存。

### 1.2 产品的真正发明点：交互预编译式 Harness

Magic Pointer 的鼠标唤醒、划线、圈选、多选、短录屏，不是聊天框的花哨入口，也不是只提供一张截图。它们构成 Agent 运行前的“编译阶段”：

1. 人类用视线和手势完成高成本语义判断，明确 THIS/THAT/THESE/HERE。
2. Harness 在 pointerup 时固定当时的画面、窗口身份和手势几何。
3. DOM、COM、UIA、应用 Connector、OCR、视觉证据并发解析成对象图。
4. Harness 把对象、原始数据引用、目标租约、权限和少量工具编译成 `RunEnvelope`。
5. Agent 醒来时直接从第一步有用工作开始，而不是重新截图、扫描全屏、猜用户指向什么。

一句话定义：

> Magic Pointer 是一个完整的桌面 Agent Harness：它把人的桌面指代理解预编译成 Agent 可直接执行的上下文，再用自有 Runtime 承担从一轮到长程的全部任务。

### 1.3 不做的事情

- 不做 7×24 小时持续录屏和屏幕监控。
- 不默认把整个桌面或整页图片上传给模型。
- 不把像素 Computer Use 作为第一选择。
- 不让模型决定窗口生命周期、坐标转换、权限、租约和验证等确定性状态。
- 不因为旧代码已存在就保留旧边界。
- 不把“模型返回成功”当作动作成功。
- 不把只圈中的小图 OCR 当作完整上下文。

## 2. 已批准、不可再反复追问的决策

以下决策已经由用户确认，除非用户主动改变，不得在后续会话重新询问：

1. 内部 Agent 可执行外部发送、删除和运行命令。
2. 用户本轮明确说“发送/删除/运行”即构成当前目标和范围内的授权；不需要机械二次弹窗。
3. 当目标失效、范围扩大、结果不可验证、指令含糊或出现新高风险边界时，才暂停交给人。
4. 能结构化完成的动作优先用原生 API、DOM、COM、UIA；像素鼠标操作是语义能力缺失时的受控后端。
5. UIA/无障碍宿主可以常驻，但空闲时不扫描、不轮询 UI 树、不持续占用大量资源。
6. GPU 帧缓冲、OCR、CDP 和应用深度读取只在鼠标唤醒、快捷键或明确任务出现后临时启用。
7. UIA、OCR、模型、Connector 都要尽可能快、低成本；速度不能靠返回错误上下文换取。
8. 规则用于确定性不变量和完全匹配的快路径；模型用于语义、组合和不确定规划；证据不足时交给人。
9. 最终文本是可编辑产物，用户可以手工修改，也可以选中小段让 Agent 局部编辑。
10. 不受现有实现约束。允许跨模块重写和大改，只要新设计更正确、更可扩展且通过验证。
11. 现成 Pi、Kimi CU、Clicky、Everywhere、OpenCLI、OfficeCLI、MCP、Skill 代码和机制优先审计复用，禁止无意义重造。
12. 复用前必须审查实现、性能、许可证、失败语义和扩展边界；不能只看模块名字或现有测试数量。

## 3. 现有实现的已确认结构性问题

### 3.1 画面冻结发生得太晚

`electron/main.ts::completeSelectionGesture` 当前流程：

1. pointerup 后调用 `cancelSelectionGesture('completed')`；
2. 等待 34ms，避免绘图 Canvas 进入截图；
3. 才调用 `beginSelectionSession`；
4. `beginSelectionSession` 再启动 `selection_snapshot_bridge.py`；
5. Python 先跑结构化读取；
6. 最后才调用 ImageGrab/PrintWindow 并标记 `pixels_frozen`。

因此，UIA/DOM 如果耗时几百毫秒甚至数秒，截图捕获的是新界面。缩短 34ms timer 不能解决这个问题；必须把“固定帧”提升为 pointerup 的第一等动作。

### 3.2 当前视觉证据范围过窄

`selection_snapshot_bridge.py::_bounded_gesture_capture_bbox` 明确只构建手势周围的小证据框。它适合隐私裁剪，却不适合：

- 一段聊天记录同时包含文本、文件、图片；
- 圈选只覆盖消息的一部分，但意图依赖相邻消息；
- OCR 需要整窗布局才能分辨消息行、发送者和附件关系；
- 自绘应用需要完整目标表面进行视觉分组。

正确做法是本地保留完整目标窗口/视口作为权威帧，再派生手势语义区和模型上传裁剪。

### 3.3 感知是串行首命中，不是证据融合

`app/grounding/perception_cascade.py` 按优先级逐个 adapter 调用，并在第一条“可用结构”出现时返回。问题包括：

- UIA 容器名可能非空但不是用户圈中的内容；
- 一个慢 adapter 阻塞后续全部路径；
- 低质量早到证据挡住高质量晚到证据；
- 无法输出复合对象，例如一组消息 + 图片 + 文件卡；
- UIA、OCR、DOM 不能互相校验。

### 3.4 UIA 每次起进程且存在同步等待

`app/adapters/uia_text_adapter.py` 每次请求启动 `uia_selection_probe.exe`。Chromium路径还会同步等待 450ms 或 60ms 后重试。已知真实扫描约 115–227ms，进程启动又增加暖启动成本。正确方向是常驻原生宿主、批量 CacheRequest、局部查询和熔断隔离。

### 3.5 微信媒体解析器没有进入真实链路

`app/grounding/wechat_media.py` 当前：

- 只在独立单测中调用；
- 通过上下文中的文件名递归扫描微信存储目录；
- 同名文件只用大小和前 4KiB 去重；
- 图片拿不到原件时只裁冻结图中的选区。

它不能证明文件来自用户圈中的消息，也无法表示多条消息的有序对象关系。微信只是自绘应用例子，最终应由通用 `SurfaceAdapter`/`RawObjectResolver` 承载。

### 3.6 Fabric 不是内部 Agent loop

`app/fabric/model_plan.py` 接受多个工具调用，但 `app/fabric/engine.py::plan_from_model` 在生产路径要求恰好一个 tool call。`agent_gateway.py` 面向外部项目 Agent 和 session worker，不适合作为默认的桌面 Runtime。

## 4. 总体架构

新底层分为十一个有清晰契约的模块：

1. `CaptureCore`：手势 epoch、临时帧缓冲、不可变 `FrameLease`。
2. `AccessibilityHost`：常驻低功耗 Win32/UIA 宿主。
3. `PerceptionBroker`：多路并发、deadline、证据归一化和融合。
4. `ObjectGraph`：文本、控件、消息、图片、文件、视频和容器的统一对象关系。
5. `AdapterRuntime`：按应用/版本渐进增强的 `SurfaceAdapter`。
6. `ContextCompiler`：把证据编译成 `SelectionBundle` 和 `RunEnvelope`。
7. `CapabilityBroker`：本地工具、MCP、Skills、插件和动态工具搜索。
8. `MPAgentRuntime`：自有任务执行器（loop 借鉴 Pi 的稳定实现）。短任务与长程任务走同一条 loop，靠压缩、记忆和续期扩展寿命，不设轮次上限。
9. `ActionBroker`：输入所有权、ActionLease、动作稳定、验证和撤销。
10. `ArtifactStore`：可编辑 Draft、文件、地图、表格、报告等产物。
11. `ResourceGovernor`/`RunLedger`：资源预算、事件、成本、权限和回执。

插件内核（2026-08-14 新增，DSH 架构移植的承载层）：`app/harness/`
Context 服务仓库 / inject 依赖激活 / 可逆 effect / 四模式事件 / scope +
plugin 协议 + 分层组合（bundle 行 → 用户插件目录 → patch）。内置能力
（工具/钩子/提示节/守卫/模型客户端）全部重写为 builtin bundle 插件行，
`_loop_router` 不再手接线。详见 §11.5 与 `docs/2026-08-14-plugin-architecture-review.md`。

主链：

```text
gesture arm
  -> CaptureEpoch + adapter prewarm
pointerup
  -> FrameLease commit
  -> parallel DOM/COM/UIA/app/OCR evidence
  -> EvidenceGraph fusion
  -> SelectionBundle + ActionLease candidates
  -> RunEnvelope + 3-8 tools
  -> Pi agent-loop
  -> observe/act/stabilize/verify receipts
  -> editable DraftArtifact / other Artifact
  -> approve or explicit direct action
  -> target reacquire + write/submit + verify
```

## 5. 时间和身份模型

### 5.1 CaptureEpoch

一次明确唤醒到一次 pointerup 的短生命周期：

```ts
interface CaptureEpoch {
  epochId: string;
  armedAtQpc: bigint;
  foreground: WindowIdentity;
  displayTopologyVersion: string;
  gestureToken: string;
  state: 'armed' | 'committing' | 'committed' | 'cancelled';
}
```

它不保存持续历史，只限定本次捕获边界。

### 5.2 FrameLease

`FrameLease` 是历史事实，固定“用户完成手势时看到了什么”：

```ts
interface FrameLease {
  schemaVersion: 1;
  frameLeaseId: string;
  epochId: string;
  capturedAtQpc: bigint;
  capturedAtUtc: string;
  source: 'wgc-window' | 'wgc-display' | 'dxgi-display' | 'gdi-fallback' | 'test';
  targetWindow: WindowIdentity;
  surfaceBoundsPx: [number, number, number, number];
  displayId: string;
  scaleFactor: number;
  gesture: GestureGeometry;
  localArtifact: FrameArtifactRef;
  contentHash: string;
  overlayExcluded: boolean;
}
```

FrameLease 创建后不可重新指向新图片。保存 PNG、生成缩略图、OCR和模型裁剪都只消费它。

### 5.3 ObjectLease

对象租约说明用户当时指向的语义对象：

- 来源 FrameLease；
- 对象类型、bbox、内容 hash；
- DOM selector/UIA runtime id/COM object id/应用专有 id；
- 父子、前后消息、附件等关系；
- 原始数据解析状态；
- 置信度和所有证据来源。

### 5.4 ActionLease

动作租约说明“现在能否安全操作这个目标”。批准或直接执行前重新获取：

- HWND、PID、进程启动时间；
- 应用身份和窗口类型；
- 文档 URL/路径/会话身份；
- 控件 runtime id/selector/role/name/bounds；
- 可编辑、焦点和内容指纹；
- 当前 `StateVersion`；
- 重定位等级：`exact | stable | reidentified | ambiguous | stale`。

历史 FrameLease 在用户切屏后仍有效；ActionLease 不允许依赖历史坐标盲写。

### 5.5 StateVersion

借鉴 Kimi CU `snapshot_id`，但加强语义：

- 每次 observe 返回 `stateVersion`；
- 动作声明基于哪个版本；
- 动作后返回新版本；
- 几何、窗口或内容发生关键变化时旧版本失效；
- 后端必须诚实返回 `usedBackend`。

## 6. 捕获算法和视觉证据

### 6.1 正确时序

pointerup 的第一件事是提交 FrameLease，不再等待 Python 结构化读取。

目标实现：

- 手势 arm 时启动当前目标表面的短期环形缓冲；
- overlay 使用捕获排除；
- pointerup 选择最新的干净帧；
- 先固定 GPU texture/共享句柄，再异步编码；
- 若捕获排除不可靠，使用 pointerup 前最后一张无 overlay 帧；
- 只有 FrameLease 成功或明确失败后，才进入后续上下文编译。

### 6.2 三层图像

1. `SurfaceFrame`：完整目标窗口/视口，本地保存的权威事实。
2. `SemanticRegion`：根据手势和布局选出的对象区域及必要邻近上下文。
3. `ModelView`：基于任务、隐私和模型能力生成的有界裁剪/降采样。

不再让“小选区图片”承担全部语义，也不默认把完整 SurfaceFrame 发给模型。

### 6.3 借鉴源码

重点阅读但不得直接复制受限制代码：

- `external/everywhere/src/Everywhere.Windows/Interop/Direct3D11ScreenCapture.cs`
  - 学习 WGC + D3D11 device、free-threaded frame pool、staging texture、窗口局部捕获。
  - Everywhere 为 BSL 1.1 竞品限制，只读思路，不能复制实现。
- Kimi CU Windows 插件
  - 学习 snapshot、坐标/元素双目标、输入所有权和 used_backend。
- `external/nut.js`
  - 学习 Electron/Node 原生输入和 N-API 包装方式；按许可证审计后决定是否复用。

第一阶段允许后端先通过契约替换，但生产目标是 WGC/D3D 常驻捕获，不以 Python ImageGrab 作为最终热路径。

## 7. 并发感知和 EvidenceGraph

### 7.1 不再使用串行 fallback

FrameLease 提交后，匹配的 provider 同时启动：

- DOM/CDP/浏览器 Accessibility；
- Office COM/Shell COM；
- UIA；
- 应用 SurfaceAdapter；
- 冻结帧 OCR、布局、模板和必要视觉模型。

每一路有：软 deadline、硬 deadline、取消信号、资源成本、熔断状态。慢 provider 不阻塞快 provider。

### 7.2 EvidenceCandidate

```ts
interface EvidenceCandidate {
  candidateId: string;
  providerId: string;
  backend: string;
  frameLeaseId: string;
  observedAtUtc: string;
  objectType: string;
  bboxPx?: [number, number, number, number];
  content?: string;
  relations: EvidenceRelation[];
  sourceRef?: SourceRef;
  identityAttestation: IdentityAttestation;
  markCoverage: MarkCoverage;
  freshness: FreshnessAttestation;
  confidence: number;
  latencyMs: number;
  status: 'usable' | 'partial' | 'empty' | 'error' | 'timed_out';
}
```

### 7.3 硬门槛与融合

- 窗口/PID/页面身份冲突：淘汰。
- 没有覆盖手势且无法证明语义父子关系：不能作为主对象。
- 晚于 FrameLease 且目标已变化：标记为新状态，不能覆盖历史证据。
- 容器名、可执行路径、窗口标题不能冒充正文。
- DOM/UIA/OCR一致时提高置信度。
- 多条消息、附件、文件允许组合成一个对象子图。
- 第一条非空结果永远不是自动赢家。

### 7.4 快速完成条件

感知不必等待所有慢通道结束，但必须达到最低完整上下文：

- FrameLease 已固定；
- 目标身份明确；
- 手势语义范围明确；
- 至少一个可用 ObjectRef；
- 不存在未解决的身份冲突；
- 尚未完成的 provider 已转为可按需解析的引用或明确缺口。

## 8. 自绘应用和 SurfaceAdapter

微信不是核心特例。统一接口：

```ts
interface SurfaceAdapter {
  manifest: SurfaceAdapterManifest;
  match(window: WindowIdentity): Promise<AdapterMatch>;
  observe(request: ObserveRequest, signal: AbortSignal): Promise<EvidenceCandidate[]>;
  resolve(request: ResolveObjectRequest, signal: AbortSignal): Promise<ResolvedObject>;
  act?(request: SemanticActionRequest, signal: AbortSignal): Promise<ActionReceipt>;
  stabilize?(request: StabilizeRequest, signal: AbortSignal): Promise<StateVersion>;
  verify?(request: VerifyRequest, signal: AbortSignal): Promise<VerificationReceipt>;
}
```

Adapter 包含应用/版本匹配、能力、权限、资源预算和 quirks；不得直接修改 Harness 核心。

### 8.1 微信作为第一个复杂样例

应输出有序消息对象图：文本、发送者、时间、图片、文件、视频、消息 bbox、会话身份和原始数据状态。

原始媒体解析阶梯：

1. 精确 bubble 的 Windows DataObject：`CF_HDROP`。
2. 虚拟文件：`FILEDESCRIPTOR/FILECONTENTS`。
3. 图片：PNG/DIB/应用复制结果。
4. 应用预览/下载动作后获得可验证文件。
5. 维护轻量本地文件索引，用会话、时间、大小、hash等联合匹配。
6. 冻结帧中的完整渲染对象。
7. 明确 unresolved。

只有精确 DataObject、可验证下载或可靠消息映射能标记 `verified_original`。同名搜索不能。

### 8.2 适配优先级

先完成通用 Adapter SDK 和一个端到端样例，再逐个增加关键应用。不能把每个应用的特殊 if/else 堆进主进程。

## 9. 常驻 UIA 和资源治理

### 9.1 AccessibilityHost

Windows UIA 改为常驻原生进程：

- named pipe/受限 IPC；
- 初始化 UIA/COM 后空闲等待；
- `ElementFromPoint`、局部区域、TextPattern、整树查询分开；
- CacheRequest 批量获取属性，减少跨进程往返；
- 按 HWND/PID/版本维护小型缓存；
- WinEvent/UIA事件只负责失效缓存，不持续扫描；
- 容易挂死的目标隔离 worker并设置 deadline/circuit breaker；
- Chromium冷树异步重试，不同步 sleep 阻塞其他 provider。

### 9.2 ResourceGovernor

管理：

- CaptureHost GPU/CPU内存；
- UIA host 工作集；
- OCR模型暖池和 idle unload；
- CDP attach TTL；
- 并发 provider 数；
- 后台 Agent模型和 token预算；
- 电池、低内存、远程桌面降级。

空闲策略已获用户批准：能力可常驻，但不扫描；帧、OCR和深度读取只在明确唤醒后临时启用。

### 9.3 性能目标的制定方式

所有目标用 p50/p95/最大值和成功率共同记录，禁止只报成功样本或把超时误认成固定成本。

初始工程目标：

- pointerup → FrameLease 固定：p95 ≤ 30ms；
- 局部 UIA：p95 ≤ 80ms；
- 完整文档 UIA：p95 ≤ 250ms；
- 单 provider 不能阻塞上下文编译超过 300ms；
- 结构化路径达到最低完整上下文：p95 ≤ 350ms；
- OCR慢路径可继续到 800ms，但必须有明确进度和取消；
- 交互预编译的目的，是让常见桌面任务在 1–2 轮内就能完成；这是首轮效率目标，不是轮次上限。长程任务按 §10.2 的续期预算继续跑。

这些是待实测目标，不是已经达成的声明。

## 10. MPAgentRuntime 与 Pi 的边界

### 10.1 复用 Pi 的稳定层

本机源码：`D:\AI_Agents\pi`。

已核实：

- 本地 HEAD `a116523`（2026-08-01）中的 `packages/agent/src/harness/agent-harness.ts` 有完整 prompt/steer/follow-up/session/hook/compaction实现。
- 已 fetch 的 `origin/main` 为 `75c7fd6`（2026-08-11），正在重写 multi-lane AgentHarness；核心入口仍含 `HarnessNotImplemented`。
- 稳定且值得复用的是 `packages/agent/src/agent.ts`、`agent-loop.ts`、事件契约、并行/串行工具、before/after tool hooks、steering、follow-up、abort和 prepareNextTurn。

决策：

- 不复制 Pi Coding Agent 的大型项目级 `AgentSession`。
- 不把生产绑定到 8·11 未完成的上游 AgentHarness。
- 固定一个审计过的 Pi loop 版本，通过薄适配层使用。
- Magic Pointer 自己拥有 RunEnvelope、桌面工具、租约、权限、验证、Artifact和资源治理。
- Pi升级必须先过兼容测试和本文 §16 回读流程。

### 10.2 任务 Governor

每个任务有明确预算：

- wall-clock；
- provider调用次数；
- tool call数量；
- token/费用；
- 相同错误重试次数；
- 新应用和新权限范围。

预算约束的是反馈节奏和无效消耗，不是循环寿命。有实质进展的一轮无条件续期
（`app/agent_runtime/loop.py` 的 rolling deadline），因此长程任务可以一直跑下去；
硬切只发生在一轮既无进展、预算又耗尽时。

达到预算不是伪造完成，而是交回当前证据、已完成步骤和清晰缺口。

### 10.3 RunEnvelope

Agent首轮直接获得：

- 用户指令；
- SelectionBundle/ObjectGraph；
- FrameLease引用；
- 原始文件/媒体引用；
- ActionLease候选；
- 当前 StateVersion；
- 相关但有限的 Interaction Episode和记忆；
- 动态检索出的3–8个工具；
- 权限、成本和时限。

Agent默认不需要先调用全屏观察工具。补充观察必须是有目的、窄范围的 `resolve_object`/`observe_target`。

## 11. 工具、MCP、Skills和插件

### 11.1 统一 Tool Contract

每个工具必须声明：

- JSON schema；
- 输入/输出对象类型；
- effect：read、reversible_write、local_irreversible、external_send、destructive、purchase；
- idempotency；
- concurrency/conflict key；
- 所需 ObjectLease/ActionLease/StateVersion；
- timeout、retry、cancel；
- stabilize和verify；
- rollback/undo；
- backend和usedBackend；
- latency/cost提示；
- 插件版本和许可证来源。

### 11.2 动作原语

借鉴 Kimi CU 的13工具并做语义增强：

- list_apps、launch_app、activate_window、get_app_state；
- click、type_text、press_key、scroll、set_value；
- perform_secondary_action、select_text、drag、turn_ended。

Magic Pointer优先接收 `TargetRef` 而非裸坐标。能用 CoreAudio、Shell、DOM、COM、UIA时不走像素。

### 11.3 CapabilityBroker

统一接入：

- 本地原生工具；
- SurfaceAdapter工具；
- MCP服务器；
- Skills/Prompt模板；
- 第三方插件；
- 可选外部 Agent能力。

按当前对象、应用、意图、权限和可用性动态加载少量工具。不得把所有 MCP/Skill/插件描述长期塞进系统 Prompt。

### 11.4 插件内核（DSH 架构移植，2026-08-14 批）

金标准：deepseek-harness（vendored Cordis，"一切皆插件"）。移植思想（不复制代码）：

- `app/harness/context.py`：`Context` 服务仓库（`provide/get/has/keys`、
  `in`）、`inject(deps, cb)` 依赖驱动激活（fork 语义，回调注册随依赖撤销
  回卷）、`effect()` 可逆注册（unload LIFO 回卷）、事件四派发模式
  （emit/waterfall/parallel/serial，模式是事件公开契约）、`scope()` 子
  上下文、`provide_up()`（插件向根暴露服务）、`revoke()`。
- `app/harness/plugin.py`：`name/inject/apply(ctx, config)` 协议 +
  `data/plugins/<name>/plugin.py` 目录发现 + 最小 JSON Schema 配置校验 +
  坏插件单行隔离（warning 不拖垮树）+ `waiting` 依赖缺失诚实报告。
- `app/harness/composition.py`：分层组合（bundle 行序 → 用户插件目录 →
  patch 按 id 替换整行 config/禁用/插新行）+ `dump_config()` 真实启动树。
- `app/harness/builtin_bundle.py`：`boot_loop_context(runtime)`——内置能力
  全为插件行（harness-tools / perception-tools / look-tool /
  local-action-tools / capability-tools / guard / system-prompt /
  model-client），旧 `MAGIC_POINTER_*` env 开关映射为行 config 基值。
- Seam 三角第一枚：`ctx.perception`（感知 Provider；Consumer = loop 的
  perception 工具）；`ctx.vision`、`ctx.hooks`、`ctx.prompt`、
  `ctx.tools` 同为可注入 seam。
- 检视：`python scripts/harness_dump_config.py`（对标 `dsh --dump-config`）。
- 已知简化（诚实边界）：inject 一次性激活（重载 = 重 boot 新 Context）；
  scope 子上下文生命周期独立；`model-visible means logged` 的会话事件
  单一事实源（P8）留待 Phase E/H。

用户插件目录：`data/plugins/`（`MAGIC_POINTER_PLUGIN_DIR` 覆盖）。

### 11.5 示例

- “音量调到30%”：CoreAudio语义工具设置并读回验证，不截图拖滑块。
- “打开计算器”：系统 App Activation，不用鼠标找图标。
- “规划这几个地点路线”：加载地图 MCP，产出 `MapArtifact`，视觉层以后决定如何嵌入。
- “把这些材料写成 Prompt”：读取 ObjectRefs，生成可编辑 DraftArtifact，重获外部 Agent输入框，写入但按用户指令决定是否提交。

## 12. 动作、授权和可编辑产物

### 12.1 动作循环

所有动作遵循：

```text
lease/observe -> act -> stabilize -> verify -> receipt
```

读工具可以安全并行。鼠标、键盘、剪贴板、同一文档写入按 conflict key串行，并由 `InputOwnershipLock` 管理。

### 12.2 用户授权

- 明确的当轮命令可授权当前范围内的发送、删除、运行。
- 不建立 send/delete/run 的永久硬禁用。
- 目标或范围发生实质变化时重新询问。
- purchase、凭证和无法撤销的大范围操作保持更高门槛。
- 明确授权不代表可以跳过重获目标和结果验证。

### 12.3 DraftArtifact

文本结果必须是版本化可编辑产物：

```ts
interface DraftArtifact {
  artifactId: string;
  revision: number;
  content: string;
  contentHash: string;
  sources: SourceRef[];
  attachments: ObjectRef[];
  history: DraftPatch[];
  state: 'generated' | 'edited' | 'approved' | 'written' | 'submitted' | 'verified';
}
```

要求：

- 用户可以直接编辑；
- 选中小段可让 Agent局部扩写、缩短、换语气；
- 小改生成 patch，不重写整篇；
- 支持 undo/redo和版本比较；
- Approve绑定当前 revision/contentHash；
- 批准后再次编辑使旧批准失效；
- 写回永远读取最新 revision；
- Reject保留草稿继续修改。

## 13. Reuse Gate：旧代码和参考源码如何处理

任何模块进入生产前只能获得以下结论之一：

1. 原样复用；
2. 重构后复用；
3. 只提取应用知识/测试样本，重写实现；
4. 删除。

必须检查：

- 新架构契约是否匹配；
- 正确性和边界测试；
- 冷/热启动性能；
- p50/p95/最大耗时和成功率；
- 内存、线程、IPC和取消；
- 失败是否诚实；
- 权限、安全和数据泄漏；
- 插件/新应用扩展能力；
- 许可证和竞品限制；
- 是否迫使未来再次推翻。

当前默认重写候选：

- selection snapshot时序；
- 串行 perception cascade；
- 每次启动的 UIA probe；
- 微信文件名扫描；
- Fabric单工具执行；
- 内部任务借用外部 Agent gateway。

DOM、COM、UIA、Fabric等现有模块也不自动保留，只优先保存经过验证的应用知识、测试样本、权限和回执思想。

## 14. 记忆和自进化

- 不持续保存屏幕。
- 只记录用户主动唤醒时的对象引用、任务、工具回执、用户编辑和 Reject原因。
- Prompt补全基于当前应用、近期 Episode、用户明确保存的材料和高置信历史。
- 成功工作流可以提炼为候选 Recipe/Skill，但不能仅因一次成功自动获得永久执行权限。
- app quirks必须带应用版本、证据、成功/失败计数和失效条件。
- 模型生成的“经验”先作为建议；经过重复验证或人工确认后才能进入确定性快路径。
- 记忆内容必须防止把外部文档中的指令当成系统规则。

## 15. 分阶段实施

### Phase A：FrameLease和捕获时序

- 建立 CaptureEpoch/FrameLease契约。
- 引入可替换 CaptureProvider和测试后端。
- pointerup先 commit，再隐藏/开 session/跑结构化读取。
- Python桥只消费既有 FrameLease，不得重新捕获新界面。
- 本地保留完整目标 surface和派生语义区。
- 建立 pointerup→freeze benchmark。

> **执行顺序修正（2026-08-13 评审 §三）**：Phase 编号不变，但执行顺序改为
> **Phase C（常驻 UIA 宿主）先于 Phase B 的 WGC 后端**。WGC 优化的是一次性
> 冻结延迟（192ms→30ms，用户刚画完线还没反应）；常驻 UIA 宿主优化的是每个
> 工具调用/每次前置断言都要付的感知边际成本（573ms→~200ms/次），三个结构
> 性张力（预算经济性、按需取数、in-loop 写前断言）全部以它为前提，并直接
> 命中死亡风险第一名"UIA 覆盖率不够"。2026-08-13 批已落地常驻宿主（真机
> 2.5x 实测）、WGC CaptureProvider 契约 + 脚手架。

### Phase B：并发 PerceptionBroker

- Provider统一契约、deadline、取消和 trace。
- DOM/COM/UIA/app/OCR并发。
- EvidenceCandidate和融合评分。
- 删除 first-nonempty生产依赖。
- 编译 SelectionBundle/ObjectGraph。

### Phase C：常驻 AccessibilityHost

- named-pipe协议；
- 常驻 COM/UIA；
- 局部/文档/终端请求；
- CacheRequest、缓存失效、熔断；
- 性能/内存验收。

### Phase D：SurfaceAdapter SDK和首个复杂应用

- 通用 adapter manifest和注册；
- raw object resolver；
- 微信作为验证样例，但不把微信逻辑写进核心；
- 文件/图片/消息有序对象图；
- 原件诚实等级。

### Phase E：MPAgentRuntime

- 引入固定 Pi agent-loop适配；
- RunEnvelope、任务 governor和事件流；
- Tool hooks接权限、租约、验证和回执；
- 多工具/并行读取/串行动作；
- 停止把内部任务映射成单一 Fabric Recipe。

### Phase F：CapabilityBroker、MCP、Skills和插件

- 动态工具搜索；
- 本地系统工具；
- MCP/Skill统一 manifest；
- trust level、权限和资源预算；
- 地图等结构化 Artifact。

### Phase G：DraftArtifact和视觉层接回

- 版本化可编辑文本；
- 局部 Agent patch；
- approve hash和写回状态机；
- 按 `VIDA_UI_SPEC.md` 接入 Receipt/Stream/Proactive surface。

### Phase H：记忆、自进化和第三方生态

- activated-event memory；
- workflow候选提炼；
- quirks验证和失效；
- 插件签名、沙箱/可信分级；
- 开发者 SDK和兼容测试。

每一 Phase 必须单独有 `docs/superpowers/plans/` 下的测试先行实施计划；不能用本节替代具体计划。

## 16. 本地事实源与什么时候必须回读

### 16.1 本次需求原始材料

1. `C:\Users\zjz65\Downloads\文件与提示词处理就绪.md`
   - 内容：产品定位、规则/模型分工、Pi Agent疑问、人肉 ROI、Prompt Builder、后台 Agent、插件、记忆、Vida讨论。
   - 回读：产品边界被质疑、内部 Agent与外部 Agent关系变化、记忆/插件策略调整时。

2. `C:\Users\zjz65\.claude\projects\D--Desktop-Magic-Pointer\c4783d7c-5710-4051-9871-48899e035473.jsonl`
   - 内容：VIDA视觉分析的完整对话和中断续写来源。
   - 回读：`VIDA_UI_SPEC.md`出现证据缺口、需要重新核对原对话时；普通底层任务不必每次读取797行。

3. 当前 Codex任务对话
   - 内容：用户对 Harness的最终澄清、任务边界（其中“短任务”一条已于 2026-08-19 推翻，见 §1.1）、FrameLease、原始对象、UIA速度、执行授权、资源策略和“不得被旧代码约束”。
   - 持久化方式：已归纳进本文；后续模型以本文为准，不依赖聊天窗口仍存在。

### 16.2 核心项目文档

0. `docs/2026-08-14-MASTER_HANDOFF.md`（2026-08-14 新增）
   - 内容：自包含全量交接（产品/历史/强模型回应固化/DSH 插件内核/逐模块核心思想/乱象盘点/下一步）。**新接手模型第一读**——只读这一份即可获得完整真相，无需再读任何文件。
   - 回读：任何接手任务的第一件事；本文与母文档冲突时，以本文的最新状态修正读法，权威决策仍以母文档为准。

1. `docs/design/VIDA_UI_SPEC.md`
   - 内容：三阶段语义、TargetLease写回、Fresh Evidence、ResumeRescue/DailyWrap和完整视觉状态机。
   - 回读：开始任何卡片/气泡/动效/可编辑 Draft UI；修改写回目标生命周期；实现 PromptRescue/ResumeRescue/DailyWrap时。

2. `docs/REFERENCE_PROJECTS_20260810.md`
   - 内容：Kimi CU 13工具、snapshot、输入所有权、OpenCLI selector、OfficeCLI、Clicky、Everywhere、wxauto媒体链、许可证矩阵。
   - 回读：设计工具协议、UIA宿主、SurfaceAdapter、MCP/Skill、复制任何 external源码前。

3. `docs/CODEBASE_OVERVIEW_20260810.md`
   - 内容：代码地图和当前模块关系。
   - 回读：新模型首次大范围改代码；主流程入口发生移动后要同步更新或明确废弃。

4. `docs/ARCHITECTURE.md`
   - 内容：现有结构化/像素/写回路径、历史性能数据和真实应用测试。
   - 回读：改 UIA、OCR、写回、选择桥、终端和应用 grounding前；注意其中部分旧决策会被本文替代。

4b. `docs/2026-08-14-plugin-architecture-review.md`（2026-08-14 新增）
   - 内容：对照 DSH 金标准的插件架构审查（问题 P1–P8）与目标架构。
   - 回读：任何插件/扩展机制改动前；实现计划 `docs/superpowers/plans/2026-08-14-plugin-kernel.md`。

5. `docs/STATUS.md`
   - 内容：哪些能力已验证、哪些只完成代码、已知缺口和真机命令。
   - 回读：每个任务开始和完成；更新真实进度时。

6. `docs/PRODUCT.md`
   - 内容：旧产品定位和竞品证据。
   - 回读：改变对外定位、README、功能范围时。本文已覆盖的新决策优先于其中“不做通用 computer-use”的绝对表述。

7. `docs/AGENT_INTEGRATION.md`
   - 内容：现有 Codex/Pi/Claude/Gemini连接方式。
   - 回读：外部 Agent handoff和 provider adapter工作；不要把它误当内部 MPAgentRuntime设计。

8. `docs/archive/research/2026-08-02-cross-app-continuous-selection-and-wechat-media.md`
   - 回读：实现多对象连续选择、自绘聊天媒体解析时。

9. `docs/archive/research/2026-08-04-what-uia-actually-exposes.md`
   - 回读：改 UIA准入、常驻宿主、应用覆盖判断时。

### 16.3 本地源码参考

1. `D:\AI_Agents\pi`
   - 回读：实现/升级 MPAgentRuntime；必须同时检查固定版本和最新 upstream，不能假设 AgentHarness API稳定。

2. `external/everywhere`
   - 回读：WGC/D3D、常驻 UIA、文本选择；BSL 1.1，仅学习思想，不复制竞品实现。

3. `external/clicky-windows`、`external/clacky`、`external/openclicky`
   - 回读：本地快路径、UIA/OCR/Vision、POINT snap、权限和 skills渐进披露；先查各自许可证。

4. `external/ufo*`、`external/ui-tars-desktop`、`external/agent-desktop`
   - 回读：工具动作协议、状态观察、GUI Agent验证；避免复制重型项目编排。

5. `%TEMP%\opencode\kimi-code\packages\agent-core-v2\src\app\capability\entries\kimiCu.ts`
   - 回读：Kimi CU公开编排接线、平台工具加载、turn_ended规则；临时目录可能消失，关键事实已在 `REFERENCE_PROJECTS_20260810.md`。

### 16.4 回到本文的明确时点

必须重新打开并更新本文：

- 开始新的 Phase；
- 新建/修改 FrameLease、ObjectLease、ActionLease、StateVersion、RunEnvelope或 Tool Contract；
- benchmark推翻性能目标；
- 新增第一个或新的 SurfaceAdapter；
- Pi依赖升级；
- MCP/插件信任模型变化；
- 开始视觉层工作；
- 一项旧模块通过或未通过 Reuse Gate；
- 阶段验收、合并、发布或向另一个 Agent handoff前。

## 17. 验收原则

### 17.1 正确性

- pointerup后切屏不改变 FrameLease。
- OCR/视觉只读冻结帧。
- 结构化证据不能用窗口标题冒充圈中正文。
- 多对象顺序和附件关系可表达。
- 原始文件解析等级诚实。
- 写入前重新获取 ActionLease。
- 每个动作返回可验证 receipt。

### 17.2 性能和资源

- 每项 benchmark 同时报成功率、p50、p95、最大值、冷/热状态和错误。
- 空闲不扫描 UI 树、不持续截图。
- worker有启动、复用、闲置回收和熔断证据。
- 不能以占用大量常驻内存换取少量首击速度而没有 ResourceGovernor策略。

### 17.3 成本

- 精确规则/本地 API命中时零模型。
- 默认模型只做语义和少量规划。
- 模型默认拿结构化对象和必要视觉，不拿全桌面垃圾上下文。
- 工具动态选择，默认3–8个。
- 长任务不偷偷转为内部无限 Agent loop。

### 17.4 人类控制

- 用户可以编辑最终文本。
- 明确授权的发送/删除/运行允许直接完成。
- 系统无法证明目标/范围/结果时交回人。
- Reject保留可编辑产物，不丢上下文。

## 18. 进度账本

### 2026-08-11：设计冻结

- [x] 重读用户提供的完整需求导出 Markdown。
- [x] 合并 VIDA UI规格、参考项目报告和本轮用户纠正。
- [~] 曾确认“短任务内部 Agent 与项目级外部 Agent”边界——**2026-08-19 已被用户推翻**，现行边界见 §1.1。
- [x] 确认明确指令可直接发送/删除/运行。
- [x] 确认空闲常驻但不扫描的资源策略。
- [x] 确认最终 Draft可手动/局部 Agent编辑。
- [x] 确认不受旧代码约束并建立 Reuse Gate。
- [x] 核实迟到截图、串行感知、UIA子进程、微信解析未接线、Fabric单工具限制。
- [x] 核实 Pi稳定 agent-loop与上游实验 AgentHarness边界。
- [x] 完成 Phase A实施计划：`docs/superpowers/plans/2026-08-11-frame-lease-foundation.md`。
- [x] 建立 FrameLease第一条失败测试（契约测试 2026-08-12）。
- [x] 完成 pointerup先冻结的端到端生产链（2026-08-12，GDI 后端）。

### 2026-08-12：Phase A 完成 + 外部评审吸收

- [x] 外部 harness 评审：`docs/harness-gap-review-20260812.md`（定位校正：不是"更便宜的 CUA"而是"指代输入模态"；四支柱：稳定寻址/前置条件/可逆性/廉价复读；P0 缺口 L1-L8、P1 L9-L16、P2 L17-L22；批次 0=L12+L6+L8）。
- [x] Phase A FrameLease 全量落地（8·11 计划 Task 1-7 除真实 Electron overlay 验收）：
  - `electron/frame_lease.ts` + `scripts/frame_lease.py`：版本化不可变 FrameLease 契约（TS/Python 双端校验一致）。
  - `scripts/frame_capture_worker.py`：空闲常驻捕获 worker + arm/commit/cancel 状态机 + 有界环形缓冲 + JSONL stdio。
  - `electron/frame_capture_worker_client.ts` + `electron/capture_commit_coordinator.ts`：持久单 worker 客户端与 commit 排序协调器。
  - `electron/main.ts`：接入 coordinator、删除旧 34ms 定时器、commit 先于 overlay 释放与会话启动、overlay 内容保护。
  - `scripts/selection_snapshot_bridge.py`：消费已冻结 FrameLease，禁止迟到重捕获，失败 fail-closed。
  - 真实基准（gdi-fallback）：20/20 成功，p50 192ms / p95 213ms / max 233ms，单 worker 复用。
  - 未完成：WGC/D3D 后端、overlay 排除需真实 Electron 会话验收。
- [x] L6 证据契约：`app/evidence/contract.py`（EvidenceStatus/Source、容器启发式、merge_for_decision、is_trustworthy）。
- [x] L8 基础设施：`app/governance/latency_budget.py`（评审预算表）+ `app/governance/cancellation.py`（代际淘汰取消注册表）。接线改造未做。
  - 2026-08-12 循环/工具接线（T5.1）：`run_agent_loop` 每轮经 `check_budget(FULL_ANSWER)` 门控（注入 budgets 生效，DEFAULT_BUDGETS 为默认）；整循环挂在 `CancellationScope(cancel_registry)` 上，模型调用前与工具执行前检查取消，外部 `cancel_all()` 抛 `CancelledError`，已启动并行工具跑完即终止；感知工具 Evidence 在消息边界经 `evidence_to_text` 序列化为 `{status, confidence, value, note}`（registry 层仍保留 Evidence 对象）；validate_input/execute_tool 的 failure_type 透传到 Terminal.results。桥/引擎外部调用方仍未接线（仅 agent loop 内部）。
- [x] L12 Replay 基座：`app/replay/`（DesktopTrace schema + recorder + replayer）+ `scripts/record_desktop_trace.py`。感知层离线回放未接线。
- [x] 批次 1：L1 Agent Loop + L2 感知即工具 + recipe 重定位（2026-08-12 完成，见 `docs/superpowers/plans/2026-08-12-harness-loop-batch.md`）：
  - `app/agent_runtime/` 新建：types/errors/tool_registry/model_client/loop/perception_tools/look_tool/recipe_cache。
  - 循环移植 CC queryLoop：State 整体重建 + transition、withhold 防死循环、截断作废、stop hooks 网关、并发分区、代际取消、FULL_ANSWER 预算门控。
  - recipe 降级为预编译轨迹：39/39 编译成功，L0/L1/L2 路由器退役为轨迹编译器（旧签名零改动），18 个高流量动作注册为工具，`engine.run_agent_turn` 循环入口（旧入口无感）。
  - 验证：Python 1529 过（2 个既有环境失败：local_image_vision 缺验收图）；Node 131 过；typecheck/lint 过。agent loop 基准（假模型）：20/20，p50≈0ms/p95≈75ms（假后端，不代表真实模型延迟）。
  - 未接线：fabric_bridge/selection_bridge 生产调用方仍走旧 engine 路径；真实多轮模型客户端（ai_client 单 user_prompt 限制）。
- [x] 批次 2：L3 Anchor 重解析 + L4 前置条件 + L5 可逆性 + L7 注入隔离（2026-08-12 完成，见 `docs/superpowers/plans/2026-08-12-harness-safety-batch.md`）：
  - `app/anchor/`：Anchor 五字段多重身份 + AnchorResolver 降级链（exact/moved/changed/gone/ambiguous 一等返回值，lazy probe）。
  - `app/action_guard/`：preconditions 四断言（宁可失败不猜）、ActionApproval（不可逆动作人类批准，by 黑名单防模型自触发，身份变化 EXPIRED）、UndoLog（补偿动作+幂等+失败不伪装）、EgressGate（默认全禁，data 来源需 explicit_approval，全审计）。
  - loop 接线：ToolSpec.preconditions + precondition_context_factory（fail-closed）；AgentMessage.origin 指令/数据通道隔离（validate_messages 拒绝 data+user）。
  - executors：4 个写回动作挂 compensate 槽。
  - 验证：Python 1767 过（2 既有环境失败）；Node 131；typecheck/lint 过。
  - 诚实缺口：approval/undo/egress 接线缝在工具实现层（真实写回工具接线待动作批）；恢复提示消息 role=user+origin=data 与 validate_messages 的已知间隙（文档化）。
- [x] 批次 3：L9 变更流 + L10 感知权限 + L13 账本/Bench + L14 能力矩阵 + L15 修复对话 + L16 能力提示（2026-08-12 完成，见 `docs/superpowers/plans/2026-08-12-harness-scale-batch.md`）：
  - `app/events/`：四类变更事件 + 按窗口订阅/节流/白名单/风暴熔断（不做真实 UIA 宿主接线）。
  - `app/permissions/`：感知黑名单（内置 10 规则，感知前拦截）+ 敏感脱敏（Luhn 卡号/身份证/电话）+ 不出网模式 + 能力矩阵（应用×能力×状态，持久化）。
  - `app/telemetry/`：交互账本（token 文本/视觉分开、阶段延迟、look 占比、失败 Top）+ PointerBench 基座（三方对比报告，缺组诚实"未采集"）+ doctor 报告（unknown≠failed）。
  - `app/failure_flow/`：失败归因修复建议映射表（timeout→look+retry 等 7 类）+ 目标条件化能力提示（7 目标类型，3-8 个钳制）。
  - 验证：Python 2026 过（2 既有环境失败）；Node 131；typecheck/lint 过。
  - 诚实缺口：变更流/黑名单/账本均未接生产感知链（基础设施先于接线）。
- [ ] 批次 4：L1 生产接线（fabric_bridge 切换循环）、真实多轮模型客户端、写回工具挂 guard、WGC/D3D 捕获后端、常驻 UIA 宿主（Phase B/C）。
- [ ] WGC/D3D 捕获后端（FrameLease 生产热路径）。

### 2026-08-13：Harness 补全收官（CC 模式全量移植）

- [x] 测试瘦身（用户裁决）：191 文件 / 2080 项 → 50 文件 / 879 项；全量 84 秒；根目录 swarm 垃圾目录已清。
- [x] 系统提示词 section 组装器：`app/agent_runtime/system_prompt.py`（Identity/System/Permissions/Memory/Language，静态/动态边界，CC systemPromptSections 模式）；`_loop_router` 已接。
- [x] 记忆层：`app/agent_runtime/memory.py`（MAGIC_POINTER.md 分层：用户级 + 工作区，mtime 缓存，4k 上限，注入系统提示词）。
- [x] 上下文压缩：`compact_messages`（CC compact：前文摘要成一条 injected user 消息）。
- [x] 权限模式：`app/agent_runtime/permission_modes.py`（default/plan/accept_reversible/bypass × 六档 effect，ask=生成确认方案，deny=禁止；purchase 永远 ask）。
- [x] 流式后端：`StreamingMessagesBackend` + SSE 解析器（delta/tool_calls 增量重组，[DONE] 终止）；解析器全测，真实端点验证待真机。
- [x] T4.2 结构化证据通道：assistant 消息携带 `tool_calls`，工具结果以 API 原生 role=tool/tool_use+tool_result 回传（chat-completions 与 messages 双协议）；loop 消息序列、origin 隔离、fabric 集成测试同步修订。
- [x] 写回 guard 生产工厂：`app/action_guard/guard_factory.py`（GuardProbe 协议 + build_context_factory + anchor_from_arguments；无 anchor 时 fail-closed 返回 None→permission_denied）；`run_agent_turn` 增 `precondition_context_factory`/`hook_manager` 参数。
- [x] hooks + AskUserQuestion + TodoWrite（上一批）全部已接线进 `_loop_router` registry。
- [x] 验证：Python 879 过 / 84 秒；Node 131；typecheck 绿。
- [ ] 剩余真机接线（模块全完成、待桥侧接）：permission mode 接入 loop 门、streaming 设为生产默认、guard factory 接真实 UIA 探针适配器、compaction 挂 loop compact_callback。

### 2026-08-13：模型即路由器——关键词+recipe 路由退役（架构修复）

- [x] 用户实测判决：关键词+recipe 路由"从根本上不好、不可扩展"（加功能不能靠关键词表）。按用户指示研读 Claude Code 源码（`C:\Users\zjz65\PycharmProjects\claude-code-main`，1350 TS 文件）：结论记录在 `docs/harness-port-notes/2026-08-13-cc-tool-architecture.md`——CC 没有关键词意图表，工具自描述（schema/description/isReadOnly/checkPermissions/searchHint）+ ToolSearch 延迟加载，模型即路由器。
- [x] 重读 fable5（8·12 外部最强模型）产品理解：`docs/harness-gap-review-20260812.md`——产品是"指代输入模态"，必须从流水线变 harness（循环 + 四支柱 + 证据阶梯）；本批 L1-L16 即其清单。
- [x] 端到端全链路真实数据文档：`docs/harness-port-notes/2026-08-13-end-to-end-walkthrough.md`（晃动→划线→FrameLease→UIA 探针→snapshot→loop 输入全字段→HTTP payload→工具执行→提案→确认→回执，全部用 8·13 Notepad 真实案例数字）。
- [x] `app/fabric/capability_tools.py`：每个 recipe 变成真实工具（真实参数 schema `ARGUMENT_SCHEMAS`、诚实描述、READ effect、只生成方案）；调用只 propose 签名 plan，走原 plan/confirm/receipt 链（`make_fabric_action_proposal`）。测试 8 项。
- [x] `AiClientMessagesBackend` 支持原生 system prompt（chat-completions system 消息 / messages 协议 system 字段）。测试 2 项。
- [x] CC ToolSearch 模式移植：`ToolRegistry.search(keyword)`（ASCII 整词含下划线分词 + CJK 子串）+ `register_find_capability` 搜索工具 + loop 读完 `find_capability` 结果后把发现的工具动态加入下一轮 schema（`_select_tool_schemas(extra_names=...)`）；`run_agent_turn` 增 `tool_limit`。测试 3 项。
- [x] `scripts/selection_bridge.py` 生产路由改造（`_loop_router`）：
  - L0（确定性本地动作 + 显式 handoff + L0 recipe）保留零模型快路径；
  - ACT_MODEL / ACT_TOOLS / 关键词命中的非 L0 recipe 全部进 agent loop：感知工具接真实后端（本轮 grounding 证据 + 实时窗口枚举）、`look` 接真实视觉模型 + 冻结帧裁剪、copy/screenshot/show_source 变成模型可调用的真实工具、能力工具 + find_capability 注册进 loop registry；
  - 首条消息注入 `[本次圈选对象证据]`（上限 60k 字）；
  - loop 失败/无输出自动回退旧链；`MAGIC_POINTER_LEGACY_ROUTER=1` 强制回滚。
  - 测试：`tests/selection_bridge_test.py` 4 项（映射/崩溃回退/本地动作/提案收集）。
- [x] 验证：Python 873 过（测试瘦身后，见下）；Node 131；typecheck 过。
- [x] 测试瘦身（用户裁决"删的越多越好"）：191 个测试文件 / 2080 项 → **50 个文件 / 873 项**（-57%），删除迁移/静态钉死/重叠/文案类测试与 swarm 遗留根目录垃圾；全量跑通 83 秒（原 5 分钟）。保留的均为行为级测试（FrameLease 竞态、探针、快照 fail-closed、guard 状态机、anchor 判别、loop、桥）。
- [x] Harness 补全（CC 模式移植，第二批）：`app/agent_runtime/hooks.py`（PreToolUse/PostToolUse：block 回喂模型 / approve 短路 / 输入改写 / 抛错不杀 loop，loop 已接线）+ `app/agent_runtime/ask_todo_tools.py`（AskUserQuestion 澄清工具 + TodoWrite 计划工具，桥未接 UI 时诚实拒绝不猜）；`_loop_router` 已注册。测试 7 项。
- [ ] 诚实缺口：能力工具超 tool_limit 的部分默认不进首轮 prompt（靠 find_capability 按需发现）；loop 首条消息仍以文本携带证据（T4.2 结构化通道）；写回类能力仍只能"生成方案"，loop 内不直接执行写。

### 2026-08-13：Notepad 记事本"文件内容没进模型"事故修复（真机取证）

- [x] 事故：用户在 Notepad 打开 34,660 字 txt，划选未选中文本，问"这个文件里读到了啥。概况总结。"——回答是"摘要并路由：已锁定 1 个对象，provider=agent.task。 请核对动作后确认"，随后 AgentGatewayError。文件内容从未进入模型。
- [x] 真机取证（Notepad 仍开着，hwnd 67130）：UIA 探针返回 "No non-empty UI Automation text selection was exposed."（未选中文本 → 无选区 → 结构化层空 → 对象降级为 screen_region 像素兜底）；冻结帧 OCR 显示 Notepad 文档区被其他窗口遮挡，像素路径也拿不到正文。
- [x] R1 路由修复：`_is_information_question` 增加"总结/概况/概括/读到了啥/讲了什么/啥意思"等疑问词；`_QUESTION_ACTION_MARKERS` 移除裸"总结/summarize"、增加显式目的地词（放到/写入/发到/存到…）——"概况总结"→ ACT_MODEL 直接回答；"总结成三点放到邮件"仍走 write-recipe。测试：`test_summary_questions_with_file_wording_answer_with_content` 等 3 项。
- [x] R2 grounding 修复：`scripts/uia_selection_probe.cs` 新增 `TryDocumentTextFallback`（无选区时读 TextPattern DocumentRange，上限 65536 字，result_kind=`document_text`，document 矩形作为选区证据），点在窗口外/被遮挡区域同样命中；adapter 映射 `uia:document-text`。真机验证：Notepad 无选区 → probe 返回 34,660 字全文；`capture_snapshot(target_hwnd=67130)` → `hasContent=true, covers_mark=True, context 34660 字`（修复前为空、app=screen）。已重编译 `data/runtime/uia_selection_probe.exe`。
- [x] R3 provider 修复：`scripts/selection_bridge.py` 两处 `FabricEngine()` 改为 `FabricEngine(model_transform=_local_model_transform)`（本地文本模型，timeout 18s）——`model.text` recipe 不再回落到 `agent.task` 外部网关。测试：`fabric_engine_test` 2 项 + `selection_bridge_test` 2 项。
- [x] 验证：Python 2065 过（2 既有环境失败不变）；Node 131；typecheck 过。
- [ ] 部署注意：以上修复在开发树内；用户当前运行的打包构建需 `npm run build:electron` 重新构建后才能看到效果（`data/runtime/uia_selection_probe.exe` 已重编译，但打包产物需重建）。

### 2026-08-13：v4pro 审查修复 + 批次 4（生产接线批）启动

- [x] v4pro 单人全仓审查：`v4pro审查.md`（P0/P1/P2 共 25 项，均附修复方案；未改任何生产代码，只产出审查文件）。
- [x] P0.1 时钟单位：`run_agent_turn` 默认毫秒钟（`time.monotonic()*1000`），新增 `budgets` 参数；回归测试证明旧秒时钟会失守预算（`test_run_agent_turn_default_clock_is_ms_scaled`）。
- [x] P0.4 模型健康 per-endpoint：健康文件 v2（`{"entries": {base_url: ...}}`，v1 单条自动迁移）；`short_circuit_message(base_url)` 只熔断自己端点；视觉分类拒绝不再写健康（`tests/model_health_endpoint_test.py` 5 项）。
- [x] 修复 swarm 批次 2 遗留的顺序依赖循环导入（`tool_registry` ↔ `action_guard`，annotation-only import 化解）。
- [x] P2.4 本地动作：`Terminal` 增 `LOCAL_ACTION` reason / `local_action` 字段；`run_agent_turn` 对 `LocalActionCandidate` 短路返回，不再吞掉"截图/复制这个"。
- [x] P2.11 minObjects 三态门：None 跳过 / [] 按 0 过滤 / 列表比较（`route_to_trajectory`）。
- [x] P2.1/P2.2/P2.3 捕获 worker：`capturedAtMonotonicMs`/`captureLatencyMs` 真毫秒；选帧按抓取**完成**时间；grab 移出锁、不再 join（arm/commit 不被慢抓取拖 1 秒）；arm 校验边界正方向。
- [x] P1.2/P1.3 commit 竞态：coordinator 尾部 token 复查（旧 commit 尾巴不再清空新 arm / 开过期会话）；lease 由 `complete()` resolve 返回，删除 `pendingFrameLease` 全局槽；main.ts await 链校验 `selectionGestureArm.token`。
- [x] P2.5 恢复消息：`AgentMessage.injected` 白名单；`validate_messages` 每轮接入 loop（backend-error 恢复轮真实存活）。
- [x] P2.6 `compile_extra_entry` 风险标签类型安全（list risk 不再 TypeError）；P1.7 `TrajectoryCompiler.matched_keywords` 公开接口（去 `_raw_by_id` 私有耦合）。
- [x] P2.9 订阅 `auto_flush_interval_s` 后台 flusher（孤立事件不再滞留）；P2.10 提示目录按 target 重写（email/url 不再出现"拨号"）+ token 级关键词匹配；P3 杂项（多行容器启发式、doctor check_id 唯一、matrix app 校验、scope 保留字、死代码清理、文案统一、协议噪音消音）。
- [x] 批次 4 第一批（生产接线批，见 `docs/superpowers/plans/2026-08-13-production-wiring-batch.md`）：
  - `AiClientMessagesBackend`：messages 协议多轮客户端（chat-completions/messages 自适应、assistant 轮次保角色、预算→timeout、超时不毒化端点；`tests/agent_runtime_ai_backend_test.py` 5 项）。
  - `loop_answer.terminal_to_answer`：Terminal → 桥回答形状（含 loopReceipts 审计字段；4 测试）。
  - `selection_bridge._loop_answer`：`MAGIC_POINTER_LOOP_ANSWER=1` opt-in，ACT_TOOLS 路径先跑 READ-only 循环，失败/空答案/本地动作一律回退旧单发路径（5 测试）。
- [ ] 批次 4 剩余：T4.1 关 opt-in、T4.2 assistant tool_calls、T4.3 流式、T4.4 四道 guard 生产接线、T4.5 fabric_bridge 入口；WGC/D3D 与常驻 UIA 子批次。
- [x] 验证：全量 Python 2061 过（2 既有环境失败：`local_image_vision_test` 缺验收图，与改动无关）；Node 131；typecheck 过。

### 2026-08-13：recipe 重定位对账 5 项 P1 修复（review-recipes）

- [x] 按 `docs/harness-port-notes/2026-08-12-review-recipes.md` P1-1~P1-5 逐项 TDD（先失败测试→观察失败→修复→转绿；63/63 通过，`route_to_trajectory` 三测试文件）：
  - P1-1 信息问题守卫：`route_to_trajectory` 前置复用 `_is_information_question`（无圈选对象时 `What is OCR?` 等 → []，不进 OCR/复制轨迹）。
  - P1-2 en 关键词覆盖：`score_keyword_entry`（大小写不敏感，默认 zh 模式 = zh+en 并集打分，旧 L1 语义恢复），`match_keywords`/`_manifest_keywords` 同源；`copy text`/`translate` 默认命中。
  - P1-3 L0 双命中破平：按 DETERMINISTIC_RULES 顺序恢复旧 winner（`整理后复制这段文字`→ocr_copy、`让codex识别文字`→ocr_copy），manifest-only 平手仍按 id。
  - P1-4 本地动作：新 `LocalActionCandidate(action, score, matched_keywords)` 与轨迹候选并列返回（本地动作在前）；`save_screenshot` 短语补 `截屏`。
  - P1-5 开关与门：`enabled_recipes: set[str] | None`、minObjects 对象数门（objects 数量不足过滤）、`extra_recipes` 插件条目接口（`TrajectoryCompiler.compile_extra_entry`，不注册不接线）。
- [x] 修正：`engine.run_agent_turn` 是 `route_to_trajectory` 真实调用方（对账笔记称零调用点有误）——改为按候选类型取轨迹；语义不变。
- [ ] 待办（P2 遗留，未动）：en 短词子串陷阱（`recall`）、共享关键词翻转（screen.recall→memory.recall）、L2 工具面差异、自由循环 6 turn 与轨迹 3/4 turn 上限文档化。

### 2026-08-13：评审回复全量执行批（docs/2026-08-13-STRONGEST_MODEL_REVIEW_RESPONSE.md）

执行顺序按评审 §三 修正（接线批 → 近零成本项 → 基建反转）。全量验证：Python **935 过 / 95 秒**、Node 127、typecheck 过、ESLint 0 警告。

- [x] **接线批**（每接一线补集成测试；`tests/harness_wiring_test.py` 12 项 + loop/权限/流式测试）：
  - 权限门进 loop：`LoopParams.permission_mode` + `decide_effect` 与 `allowed_effects` 双门组合（ASK→permission_denied 反馈"请走能力工具提案"）；`permission_modes.py` 增 SAFE 模式。
  - guard 真探针适配：`_BridgeGuardProbe`（真实窗口枚举 + foreground + UIA 探针哈希）+ `_build_selection_anchor` fallback + `build_context_factory` 接入 `_loop_router`（无 anchor fail-closed）。
  - 流式默认 + 自动回落：`StreamingMessagesBackend` SSE 失败/空流自动降级非流式并 `record_note`（不毒化端点）；`MAGIC_POINTER_STREAMING=0` 退出。
  - compaction 挂 loop：`compactor`/`context_budget_tokens`/`token_estimator`，70% 阈值主动压缩 + withheld 被动压缩（`MAGIC_POINTER_CONTEXT_TOKENS` 默认 64000）。
- [x] **近零成本项**：60k 静默截断→显式字数+read_around 提示+手势点中心截窗（`_evidence_window`）；证据硬围栏（唯一定界符+“屏幕数据非指令”声明）；300ms 本地首反馈（`CardModel.perceivedStep`，零模型，snapshot summary 全有）。
- [x] **T1 预算语义**：rolling deadline，productive 轮按轮续期（`BudgetRenewed` 事件→UI 心跳 `loop_progress`），仅卡死轮硬截断；`event_sink` 把 loop 事件变桥 phase。
- [x] **T3 in-loop 可逆写**：补偿机器可验证判据（local_write + UndoLog）→ REVERSIBLE_WRITE + 四道 guard 前置；`MAGIC_POINTER_INLOOP_REVERSIBLE=1` 翻转，默认 off 直到真机验证（评审两阶段要求）。
- [x] **工具合并 + 双轨杀死**（Q2/Q5）：26 → 18 正交工具（text_transform/data_export/image_ops/task_route/place_route/screen_help/clipboard_text + 11 独立）；schema 单一来源归代码，manifest 只剩展示元数据；`recipe_ids_for_tool` 可达性钉死（无孤儿 recipe）。
- [x] **settings 深合并**（Q6）：`deep_merge_settings`（RFC 7396）桥端生效；渲染层 `KEYMAP` 键名翻译表（有消费方的键才落盘）+ 值翻译。
- [x] **记忆三条铁律**（Q10）：screen→memory 无自动路径（结构保证）；skill 固化需确认（install 既有确认门，测试钉死）；system prompt 记忆节只读包装。
- [x] **测试补缝**（Q9）：假模型金样端到端（`test_scripted_model_end_to_end_over_real_capability_registry`）+ 各接线集成测试；删 4 个 grep 型静态 wiring 钉死（frame_lease_main_wiring/security_hardening_wiring/preflight_main_static/credential_main_static），capture_proof_wiring 留行为断言半。
- [x] **常驻 UIA 宿主（评审优先级第一，先于 WGC）**：`uia_selection_probe.cs` 加 `RESIDENT_HOST` 条件编译（named pipe 每请求一连接、ping/probe 协议、空闲零扫描）；`app/uia_host_client.py`（ctypes 管道 + 熔断器 + 11 测试）；`_run_uia_selection_probe` 漏斗化（resident 优先→失败/降级回落每请求进程）；**真机实测：ping True，steady-state 200-250ms/读（冷启动 573ms+），2.5x**；Electron 启动时 spawn、退出时 kill。
- [x] **SurfaceAdapter SDK + 微信样例**（Q7 第三位，Phase D）：manifest/registry/protocol + `wechat_adapter`（容器 UIA 暴露则用，否则诚实返回像素锚点）；快照桥集成（claimed/error 才记 attempt，不污染默认 trace）；8 测试。
- [x] **Replay 20 条 trace**（Q8 按失败模式清单）：`app/replay/perception_replay.py`（trace→selection_bridge 载荷，回放时间戳防 TTL 误杀）+ `generate_replay_fixtures.py`（恰好 20 条，一半失败路径）+ `run_trace_replay.py` 驱动（实测跑通，个别答案断言随真模型波动，机制绿）。
- [x] **薄 smoke 层**（Q12 自家 UIA 狗粮无 Playwright）：`scripts/smoke/golden_path_smoke.py`（uia-host PASS 实测；replay 20 条驱动；notepad-read 真机金路径待用户跑）。
- [x] **WGC CaptureProvider 契约**（Phase B 契约优先）：`app/capture` 协议 + gdi-fallback/wgc-window/test 三实现 + benchmark p50/p95/p99 + worker `--backend wgc-window` 接线 + `wgc_capture_tool.cs` 脚手架（本机 csc 无 WinMD 投影 facades、无 dotnet SDK——**原生捕获未验证，如实报告 `wgc_tool_missing`**，不回退伪装）。
- [x] 健康非毒化：`model_health.record_note`（流式回落等软事件不毒化端点）。
- [ ] 真机验证清单（用户侧）：`MAGIC_POINTER_INLOOP_REVERSIBLE=1` 前必须过四道 guard 真机链路（评审两阶段门）；overlay 排除实测；微信首笔候选框；settings 面板落盘；多屏 DPI。
- [ ] 评审遗留（已记录未做）：账本数据回路（ledger×capability_matrix×hints，死亡风险第二名解法）；per-input 动态 description 跳过（评审判定规模不到）；ask_user Inbox 按 question id 绑定 answer（Stage 选项芯片已接）。

### 2026-08-13：复杂情景真机测试（视觉模型当眼睛）

试验台 `scripts/real_scenario_test.py`（真窗口+SendInput+真冻结帧+常驻宿主+活网关；证据 `data/runtime/scenario-evidence/`）。六情景结果与四类真 bug 修复记录在 STATUS.md「复杂情景真机测试记录」。要点：

- [x] 视觉校准（形状/颜色/数值全对）；notepad 概况总结数字全对；交叉引用 1 轮答对；屏幕注入被明确标记不执行；双窗口身份陷阱落在手势窗；图片视觉路径全对；终端结构化端到端（layer=uia 无像素兜底）答对终端内容。
- [x] 修复 UIA 全路径 NameError（uia_text_adapter 缺 import time → 静默退化 OCR，死亡风险第一名）；测试钉死。
- [x] 修复 Windows Terminal 结构化读取（DocumentRange 空白/异常 → RangeFromPoint 逐行窗口 + 边框偏移重试；真机 terminal_buffer 3104 字）。
- [x] 修复 loop 终端证据饥饿（content 只有锚点行 → 证据块/感知后端统一取窗口摘录 `_evidence_content`）。
- [x] 修场景试验台与冒烟的 payload 契约（cursor/cursorSpace/gesture schemaVersion2、FrameLease 字段）。
- [ ] 待复跑（网关 429 配额恢复后）：notepad 各情景最终态确认；连续情景运行触发限流是环境配额问题，桥如实报告不谎称成功。

下一步主线：真机验证批（用户）+ WGC 原生 vtable 编译验证 pass + 账本数据回路。

### 2026-08-14：插件内核批（DSH 架构移植，问题 P1–P8 的基础修复）

审查金标准 deepseek-harness 本地 clone（HEAD 47f9438，vendored Cordis：
一切皆插件、ctx 服务仓库、inject 依赖、可逆 effect、四模式事件、分层组合）。
审查结论 + 目标架构：`docs/2026-08-14-plugin-architecture-review.md`；
实施计划：`docs/superpowers/plans/2026-08-14-plugin-kernel.md`。
全量验证：Python **992 过 / 73 秒**（原 935 + 新增 57）；Node 127；typecheck、ESLint 0 警告；
smoke：uia-host PASS、replay 20 条 trace 走真实网关（机制绿，见下）。

- [x] **T1 Context 内核**（`app/harness/context.py`，24 测试）：provide/get/has/keys/
  `in`、重复 provide 报错、inject 依赖激活（立即/等待/级联 fork 内）+ `service/<key>`
  激活事件、effect LIFO 回卷 + 坏 disposer 不阻断、四派发模式（emit/waterfall 短路/
  parallel 线程池/serial 末值）+ 模式错配与未声明报错、on prepend/可逆、scope 隔离、
  revoke 级联拆 fork、provide_up 插件向根贡献服务、unload 幂等。
- [x] **T2 插件协议**（`app/harness/plugin.py`，10 测试）：name/inject/apply(ctx, config)、
  行 config 覆盖默认、坏 apply 行隔离（PluginActivationError 带行 id）、config schema
  校验（最小 JSON Schema 子集）、目录发现（plugin.py + plugin.json）、坏条目 warning
  跳过（坏 import/名字不匹配/仅 manifest 拒绝）、依赖缺失 waiting 诚实报告。
- [x] **T3 分层组合**（`app/harness/composition.py`，10 测试）：bundle 行序挂载、
  patch 按 id 整体替换 config/禁用/插新行、未知插件行 error 隔离、坏行不毒化树、
  waiting 报告、core 服务注入、dump_config 真实启动树、重复行 id fail loud。
- [x] **T4 builtin bundle 迁移**（`app/harness/builtin_bundle.py` + `tests/harness_builtin_bundle_test.py` 8 测试）：
  `_loop_router` 的 8 个注册点全部改写为插件行（harness-tools/perception-tools/look-tool/
  local-action-tools/capability-tools/guard/system-prompt/model-client）；
  **注册等价性钉死**：新树 27 工具清单 == 迁移前手接线快照逐项一致（名字+effect 全对）；
  旧 `_register_look_tool/_register_local_action_tools/_register_harness_tools/_loop_system_prompt`
  删除，`_loop_router` 从 ~300 行瘦身为"构造 runtime → boot → 从 ctx 取服务 → run_agent_turn"；
  env 开关（INLOOP/PERMISSION_MODE/STREAMING/CONTEXT_TOKENS）语义不变，经行 config 生效，
  显式 patch 优先；`system_prompt.py` 拆出 `default_sections()` 单一来源。
- [x] **T5 外部插件 + 检视**：`data/plugins/`（README + 示例）为用户插件目录
  （`MAGIC_POINTER_PLUGIN_DIR` 覆盖，坏插件单行 warning 隔离测试钉死）；
  `scripts/harness_dump_config.py`（对标 `dsh --dump-config`，输出 core seams/rows/warnings）；
  electron-builder files 白名单补 `data/plugins/**`。
- [x] **环境修复**：根 `conftest.py`——本机沙箱按 POSIX mode 位授予目录 ACL，
  pytest 硬编码 `mode=0o700` 导致 tmp_path 全部 setup 失败（STATUS 记录的 basetemp
  权限问题的根因）；shim 强制列表模式（真实 Windows 无副作用）。修复后全量 992 项
  零环境失败（此前 2 项环境失败也一并消除）。另修 `scripts/sync_install.ps1`
  缺 UTF-8 BOM 导致 Windows PowerShell 5.1 解析中文注释报错的交付阻塞（补 BOM）。
- [x] **既有 bug 的临时止血（已被下方重建批替代）**：验证期发现非 token
  `TurnWithheld` 可在持久网关错误下自旋 1400+ 轮；本批曾用 `max_turns=6` 封顶。
  用户随后明确裁决：固定六轮不是 Agent 完成语义，只是掩盖 Provider 与循环状态机混层。
- [x] 验证细节：uia-host smoke PASS（ping+probe，document_text）；replay smoke 20 条
  fixture 走真网关 + 迁移后 `_loop_router` 全链路（18/20 断言过；2 条 FAIL 为模型
  回答内容波动——`answer_contains 'PDF'` 与 `proposal_recipe` 属断言随真模型波动，
  STATUS 已记录此类波动；机制绿且有界）。
- [ ] 后续（不在本批）：P8 会话事件单一事实源（Phase E/H）；更多 seam 三角
  （`ctx.llm`/`ctx.fs`/`ctx.actions`）；SurfaceAdapter 深度 seam 化；WGC；账本数据回路。

### 2026-08-14：Harness 后端重建（进行中，未交付）

执行规格：`docs/superpowers/specs/2026-08-14-magic-pointer-harness-reconstruction-design.md`；
当前计划：`docs/superpowers/plans/2026-08-14-evidence-truth-foundation.md`。Hermes 是主要成品
对标；DSH 用于插件/事件溯源契约；Pi/Kimi/Claude Code 分别用于简洁循环、工具体验和重型
编码 Agent 行为参考。GUI 视觉设计不在本批。按用户裁决，本次所有工作视为一个开放批次，
最终验收前不升 `package.json` 版本、不执行 `npm run sync`。

- [x] **冻结证据与目标身份真相**：FrameLease、真实捕获来源、进程身份、物理坐标裁剪、
  mismatch fail-closed 已接通；真实 Notepad 交叉引用场景 2 个模型回合完成，回答 Q2=3.6 秒，
  `usedBackend=magic_pointer.messages_multiturn_streaming`，无桥错误。试验台改为唯一标题、
  Unicode SendInput、禁用剪贴板并校验可见像素，避免复用错误标签页。
- [x] **移除“6 轮即修复”的错误语义**：生产代码不再暴露 `max_turns`；Provider 瞬时错误
  在模型调用层以原消息有限重试，持久错误一次终止为 `provider_unavailable`；Hermes 风格
  Tool Guardrail 按 effect 和规范化参数/结果检测重复失败、重复读取证据和重复写入，终止为
  `stalled`；只有默认 90 的诊断保险丝，触发时诚实报告 `invariant_failed`。Recipe 不得控制
  Agent 生命周期，预算续期只认语义进展。
- [x] **插件生命周期与核心 seam 修复**：依赖撤销会卸载插件 fork，重新提供会重新激活；
  子 scope 观察父服务变化且随父卸载；工具、提示词、hooks、SurfaceAdapter 注册均随插件
  精确回卷。用户插件自动挂载、按行卸载、动态 `dump_config`、文件 patch 与显式覆盖已接通。
  `ctx.llm` 可用插件替换 Provider，模型消费者不 import 具体网关；SurfaceAdapter 走独立
  插件 scope。新增 agent/surface 运行域，避免无依赖插件在两个启动阶段重复执行。
  最新定向回归：插件/SurfaceAdapter 104 项通过。
- [x] **事件溯源会话**：落实 “model-visible means logged”；hash-chain JSONL、原生工具消息、
  append-only compaction、crash repair、resume/fork 已进入主路。追加/读取具备跨进程锁，真实 Agent
  轮持有 turn lease，活跃请求不会被并发 resume 误修；压缩不产生孤立 tool result。
- [x] **Hermes 式受控自进化（后端）**：轨迹复盘只生成用户目录候选；已有可见 diff、列表/
  读取、批准、拒绝、审计和回滚 API，批准前禁止生效；已批准 memory/skills 才按相关性进入 prompt。
- [x] **删除重复路由与旧 fallback（后端）**：模型作为普通命令唯一主路；确定性层只保留权限、
  坐标、租约、显式本地动作和专门产品模式。旧分类器/第二答案路径已删除。
- [x] **工具/Provider 完整性**：DSH 式有界滚动调度、资源冲突、取消回执、OpenAI/Anthropic
  原生多轮+SSE、usage、畸形参数自修正、懒 MCP/动态工具发现、结果验证已接入。
- [x] **人在环与后台 Agent 监督**：ask_user 可暂停并从同一日志恢复；后台任务状态迁移跨进程
  串行化；Pi steering 使用 queued→delivered ack 和 attempt 隔离，不再虚报或重放旧指令。
- [x] **Agent 循环与模型协议续审**：公开 `LoopParams` 在模型调用/会话落盘前校验权限模式、
  保险丝、工具/并发上限、预算续期、上下文预算、effect 与 FULL_ANSWER budget；默认时钟统一为
  毫秒。Provider 多次重试共享同一截止时间，流式→非流式降级只用剩余预算；第三方 adapter
  抛异常、HTTP 200 空响应均转为请求层可重试失败，不再炸穿循环或生成空白成功。截断轮会为
  每一个 assistant tool call 生成失效结果，OpenAI/Anthropic 历史保持合法；Anthropic 失败
  `tool_result` 带 `is_error=true`。
- [x] **插件/Hook 隔离续审**：patch 畸形 config 单行隔离；插件只能进入声明的 agent/surface
  scope；每次激活获得独立嵌套 config，重载不继承插件私改。PostToolUse block 已进入 loop，
  明确报告“工具已执行但结果被阻止”；PreToolUse 使用深拷贝参数，内层对象不能污染原调用并
  隐藏动态资源所有权变化。
- [x] **会话/执行完整性续审**：当前 turn 内按调用出现次序修复重复 provider call id；恢复历史
  的重复/缺失 id 统一生成会话唯一 `mp_call_*`。严格布尔确认阻止字符串 `"false"` 冒充批准；
  Fabric 幂等键绑定完整有效动作参数，receipt 必须匹配 plan/recipe；首次生成签名 key 的并发
  进程采用唯一临时文件+原子发布，输家读取赢家 key；raising precondition probe fail-closed。
- [x] **Hermes 自进化续审**：候选与备份在 apply/rollback 前重新校验内容哈希；已决定候选
  不再被同 ID 新提议覆盖；propose/apply/reject/rollback 使用跨进程 mutation lock，双窗口
  只有一个决策赢家。后台 review 在模型 handoff 前脱敏 API key/Bearer/token/password/私钥，
  review 结果 session id 禁止路径穿越。
- [ ] **最终验收与安装交付**：逐文件审计 dirty tree，补齐真实应用 ActionLease/SurfaceAdapter/
  ComputerOperator 场景；完成 fresh 全量 Python/Node/typecheck/build 与实时截图验收后，再一次性
  升版本并执行 `npm run sync`。GUI 候选审查/clarification 专用交互仍属后续视觉批。

(End of file - total 942 lines)
### 2026-08-14：后端加固续批（开发中，未交付）

- [x] **TargetLease fail-closed**：所有字典租约均验证；需要实时校验但缺少 probe 时拒绝执行；畸形 OperationPlan 转为结构化失败，不能炸穿 IPC。
- [x] **Windows-native ComputerOperator 底座**：完成 surface-only 截图、哈希/尺寸回执、SurfaceGrant 坐标约束、根 HWND/前台 HWND 复核、SendInput Unicode、取消与输入释放；常驻/一次性 Harness 均注册 `windows-native` provider。
- [x] **UI-TARS 动作协议硬化**：支持归一化/模型截图坐标，控制意图与执行动作分离，阻止写动作伪装只读，scroll 强制锚点，hotkey 两种格式兼容。
- [x] **UI-TARS 受控编排与 Harness 服务**：单截图单动作、自然 `finished/call_user`、相同画面重复动作停滞、源 observation SHA 绑定、动作后延迟复核、取消上抛；复用配置视觉网关并按模型实际缩放图尺寸换算坐标。`FrameLease → SurfaceGrant → ComputerTaskService` 已进入常驻 `computer-agent` row，但没有作为无条件万能点击工具暴露给模型。
- [x] **工具输入与上下文边界**：递归有界 JSON Schema 子集；拒绝非有限数与超深输入；工具结果统一限制 64,000 字符并记录原长度/SHA-256，日志与模型保持同一值。
- [x] **PreToolUse TOCTOU**：hook 后重新校验最终参数；precondition 读取最终参数；动态资源所有权变化拒绝执行；执行前再次检查取消。
- [x] **插件在途卸载一致性**：SurfaceAdapter、hooks、system-prompt render 和 Context 事件派发均计入 scope 工作租约；卸载等待在途工作；并行 listener 自卸载改为立即失败，消除死锁。
- [x] **自进化/MCP 边界**：确认 learning candidate 只由用户批准后生效且有哈希、路径、备份、回滚保护；MCP stdio 单行限制 2,000,000 字符，越界/超时立即终止进程，不再额外等待 close grace period。
- [x] **秒级定向验证**：本批新增/相关集合分别为 12、3、10、14、56、2、4、4、11、6、7、32 项通过；触及的生产 Python 文件 `py_compile` 通过。未运行全量测试、Node/typecheck/build/sync，不能据此声明零 bug 或已交付。
- [ ] **ComputerOperator 产品验收**：尚需 GUI 显式批准入口、真实视觉端点、多应用桌面回归与可见进度/接管交互；底层循环、动作后观察和 effect 授权服务已经完成。
- [ ] **剩余底层审计**：dirty tree 逐文件取舍、更多真实 SurfaceAdapter/ActionLease 链路，以及 MCP/插件第三方兼容样本扩充。
- [ ] **最终交付**：后端稳定后再执行 fresh Python/Node/typecheck/build/实时截图验收；最后统一 patch bump、`npm run sync`、安装目录版本核对与 `docs/STATUS.md` 更新。

### 2026-08-15：Agent 社区真实需求调研

- [x] 使用 agent-reach 完成四条指定 X 帖的全量评论阅读，并扩展读取 Claude Code、Hermes、Pi、Kimi Code、Computer Use、主动性 Agent 与 Reddit 高评论讨论；结论、证据链接、需求矩阵和当前能力缺口记录在 `docs/research/2026-08-15-agent-community-real-needs.md`。
- [x] 调研没有改变既有产品边界：Magic Pointer 仍是桌面现场的意图编译、受限执行和可验证交接层，不转向项目级 Claude Code 替代品、全天候录屏记忆或通用 OSWorld。

### 2026-08-15：Oreo Stage / Studio 与设置真值交付（1.0.5）

- [x] 设置保存改为 renderer → preload invoke → main 持久化/运行时应用/失败回滚的确认链；补齐 Python `voice_engine` schema，加入语音总开关并在关闭时强制文字输入、停止常驻与禁用语音快捷键。安装机配置已核对为 voice off / text / non-resident。
- [x] Stage 删除 40 DIP 语音球与 406/420/560/840 内容宽度档；Composer 固定 `480×132`，WorkPanel 固定 `560×520`，首次锚定后流式/完成/错误只改内部内容，body 独立滚动。
- [x] Studio 删除营销 Hero、动态彩球、重复顶部导航和内容驱动输入框增高；六个真实工作页共用 Oreo 纸面工作区页头、导航、卡片、标签和固定输入面；设置收敛为八页真实 schema 控件。
- [x] 外壳安全收尾：全手势点数总预算 4096、输入有界、capture commit 12s 超时与桥接边界测试；安装器运行时哈希改用 .NET SHA-256，避免非交互 PowerShell 未自动加载 Utility 模块时构建失败。
- [x] 交付证据：Python **1249 passed**；Node **138 passed / 95 source files**；typecheck、ESLint、Electron build 通过；uia-host smoke PASS（`kind=document_text`）；`Magic-Pointer-1.0.5-x64.exe` 已生成，`npm run sync` 成功，安装目录与开发树均为 **1.0.5**。
- [ ] 本批不改变更长期待办：治理门生产接线、ComputerOperator 明示批准 UI、真实视觉端点与多应用桌面验收仍须继续，不能因 UI/设置完成而降级或隐去。

### 2026-08-15：模型真值、隐私开关与 UI 稳定性续批（开发树，未交付）

- [x] Groq `openai/gpt-oss-120b` 档案接入 Electron 安全凭据存储，主 selection worker、段落展开和健康检查均使用同一请求级模型配置；新增不回显密钥的终端配置、状态与实测命令。
- [x] 修复语音总开关在活动录音期间被 `voice_session_active` 回滚；关闭总开关会立即终止当前语音会话并回到键盘输入。
- [x] 自动屏幕记忆和后台学习候选均改为默认关闭，并在“感知与隐私”设置中提供独立真实开关；关闭时不落记忆、不启动后台 review bridge。
- [x] Stage 处理/完成视觉夹具与运行时固定面板契约对齐；Studio 首屏尊重请求视图，收藏箱默认 100% 缩放并限制卡片摘要高度。
- [x] 按 HERO 范围约束删除 6 个无引用旧网关/测试探针，未增加 hook、评分表或兼容脚手架。
- [x] fresh 验证：Python **1256 passed**；Node **141 passed / 97 source files**；typecheck、ESLint、Electron build 通过。
- [ ] 按用户明确要求，本批不升版本、不打包、不执行 `npm run sync`；安装版仍不得宣称包含本节改动。

### 2026-08-15：HCI 系统级审查 + GUI/HUD 落地规格（文档批）

- [x] 逐文件核对感知注入、坐标归一化、色彩体系、动效与层级阶梯（stage.css/studio.css/oreo_tokens.css/icons.ts、selection_bridge 证据围栏、bridge phase 流）。
- [x] 产出 `docs/2026-08-15-HCI_SYSTEM_REVIEW.md`：感知元数据注入 Schema（归一化 1000×1000 + 节点白名单 + 预算 ≤900 token）、像素级 GUI 参数表、会话导轨与指针 HUD（放大环/状态胶囊）状态机、Refocus/Visual Diff 交互、T1-T12 落地清单。
- [x] 提交上一批 Oreo faithful UI 实现（e48a469，30 文件）：本审查基于该提交版本；用户脏着的 STATUS/本文/research 未动。
- [ ] 未改任何运行时行为；T1-T12 落地仍须测试先行、逐批验收，版本与 sync 维持用户裁决（最终批统一）。

### 2026-08-15：Harness 认知架构重构 + DSH 聊天渲染移植（261e553 / b00753d）

- [x] 按用户四定律指令逐条裁决（见 `docs/2026-08-15-HARNESS_COGNITIVE_ARCHITECTURE.md`）：预测编码只作用于环境预测、不建意图规则（用户点名否决 if/else 路由）；侧向抑制留到多 Agent（现有四守卫是单支退化）；主动遗忘/具身卸载立即落地。
- [x] 新核心四模块（均纯函数/无 I/O，测试先行）：`app/agent_runtime/surprise.py`（S0-S3 惊奇分级，五路锚点投影，busy≠empty、预期失败不算惊奇）、`assertion_memory.py`（断言记忆 O(1)/LRU/TTL，日志真相分家）、`model_surface.py`（预算化表面 + 保护节 + 剪枝账本）、`event_loop.py`（Event-Action 仲裁：优先级抢占 + 合成取消回执 + 有界 re-ground 自愈 → needs_user）。
- [x] 极限场景基准 `tests/cognitive_engine_test.py` **24 passed**：高并发抢占、预测失败自愈、上下文饿死、确定性回放、优先级稳定。
- [x] deepseek-harness 聊天视觉 100% 移植进 Studio（`dsh_tokens.css`/`dsh_chat.css`/`dsh_chat.ts`）：用户气泡/工具行 IN-OUT/Think 行/StateDot/渐变字，浅色档 only；发送中/失败态与后台任务补丁接线。
- [x] 验证：typecheck 五配置过；Node **143 passed / 98 源文件**；Python 全量见交付记录。
- [ ] 诚实缺口：认知核尚未接生产 loop（迁移路径见映射文档 §3，先与 tool_guardrails/四守卫双轨只读）；turn.events 持久化与桥侧 receipts→trace 落盘是下一批；未升版本、未 sync。

### 2026-08-15：Studio 整体重建为 deepseek-harness Web 外壳（d7328f1）

- [x] 用户实测判定前一轮 DSH 移植不完整且对比度错乱（暗底黑字看不清）。本批按 DSH 源码逐文件重建 Studio：AppFrame 侧栏（280px/新对话条/导航格/底部设置入口）+ ConversationRoot（粘性作曲家座 + 22px 输入卡 + 34px 蓝色发送圆钮 + 输入框下 StatsLine 统计行）+ SettingsRoot 居中模态（800px 面板/188px 导航/遮罩模糊，内容仍是我们的 8 页设置）。
- [x] 令牌平台改双档完整（浅色 + 暗色 `body[data-ds-dark-theme]`，默认 system，与 DSH boot-theme 一致）；oreo 令牌在暗色档重映射，收藏箱/时间线/记忆/产物/设置行跟随主题。探针实测：亮档白底黑字、暗档黑底白字，发送键按档取色（65,118,230 / 103,158,254）。
- [x] 设置从页面改为 DSH 式模态（点击侧栏「设置」打开，遮罩/关闭键/Esc 返回上一视图；搜索与保存状态保留）。
- [x] 验证：typecheck 五配置过；Node **143 passed / 98 源文件**、lint 0；`data/runtime/dsh-chat-check.png` / `dsh-settings-check.png` 离屏截图留档。
- [ ] 诚实缺口：Stage 线程面与 Companion 仍用旧视觉（本批只重建 Studio）；StatsLine 目前只有轮数/步数（token 与上下文占用无数据源，不显示假数字）；未升版本、未 sync。

### 2026-08-15：Studio 对话改为真实 agent 回合 + 权限门（5e96be7）

- [x] 纠正上一轮判断错误：Studio 追问不是纯文本问答，而是与 selection 同构的 agent 回合。`conversation_bridge.py` 重写为 agent 运行器——boot 同一插件树（perception/look/capability/guard/model-client），`run_agent_turn` 多轮 + 工具调用；历史走 origin=data 证据通道；感知读历史 + 真实可见窗口；无选区锚点时 guard fail-closed（写动作只 propose 签名计划）。
- [x] 作曲家新增真实权限下拉（default/plan/accept_reversible/safe/bypass，标注"完全访问"= bypass），经 preload→main→bridge 透传到 loop 的 `permission_mode` 逐工具门。
- [x] 验证：Python **1286 passed**；Node **143 passed**；typecheck 过；conversation_bridge 单测 6 项（空问/未知模式/历史有界/感知搜索/窗口枚举/effect ceiling）。
- [ ] 诚实缺口：端到端模型回合待真机（复用 selection loop 的 boot/run 路径，boot 由既有 loop 测试覆盖）；55s 桥超时对多轮长任务偏紧，待真机测时评估；未升版本、未 sync。

### 2026-08-16：DSH harness 能力对齐——权限预设/模型目录/斜杠目录/侧栏浏览器（4 commits）

- [x] 权限模式重定义（`app/agent_runtime/permission_presets.py`）：DSH 双旋钮模型——sandbox（read-only/workspace-write/danger-full-access）× approval（ask/never）捆绑成预设表，`custom` 仅派生展示态；映射到既有效果表 PermissionMode（SAFE/DEFAULT/BYPASS），loop 执行语义不变。渲染层权限下拉重建为 DSH PermissionSelect：盾形三态图标（DSH design set 1556 原路径）、弹层描述+选中勾、Full access 走 RiskConfirmation 勾选确认门。链路 `permissionPreset` 端到端改名，桥对未知名 fail-closed。
- [x] 模型接入（`app/models_catalog.py` + fabric_bridge `model.catalog`/`model.select`）：目录从真实网关 `GET {base_url}/models` 拉（OpenAI 兼容），失败诚实回落当前配置并带原因；切换写 `secrets/model.txt`（全栈消费的同一份配置），`MAGIC_POINTER_MODEL` 环境变量覆盖时拒绝而非装成功。作曲家模型位重建为 DSH ModelSelect（芯片+目录+选中勾+视觉标签）。真机实测：opencode.ai 网关 26 模型。
- [x] `+` 菜单=DSH 斜杠目录（`app/agent_runtime/skill_catalog.py` + `slash_directory.py`）：DSH 兼容根扫描（项目 .dsh/.agents → 用户 ~/.dsh/~/.agents skills），SKILL.md frontmatter 解析（kebab-case 校验、user-invocable、whenToUse），项目覆盖用户，坏文件跳过不毁扫描。菜单分组 命令/技能 + 本地搜索，选中插 `/name `；提交经 `route_slash_command` 结算——/permission 落芯片、/model 写配置、已知 skill 注入正文为本回合指令（DSH pre-step 语义），未知名按普通问题走模型。真机实测：51 skills 发现、0 错误。假动作（复制回答/看来源）删除。
- [x] 侧栏 DSH WorkspaceBrowser 形状（`sidebar_groups.ts` 纯函数）：新对话下方搜索框 + 对话按 今天/昨天/近 7 天/更早 分组（新→旧），本地过滤；MP 自有导航（对话/收藏箱/时间线/记忆/产物）保留。图标对齐：DSH 原路径入 sprite（new-chat/panel-left/search/plus/chev-down/check），+ 按钮、新对话、折叠、搜索、芯片箭头、菜单勾全部换用。
- [x] 验证：Python **1312 passed**；Node **147 passed / 100 源文件**；typecheck 五配置、ESLint 0；离屏截图 `data/runtime/dsh-studio-check.png` console_errors=0。
- [ ] 诚实缺口：交互流（菜单开合/确认门/命令结算的视觉行为）未真机截图核验，只有合约测试+离屏渲染；`/model` 切换写文件对打包安装版走 USER_SECRETS_DIR 路径未在安装版实测；skill 注入的回合效果（模型真的按 skill 行事）待真机对话验收；未升版本、未 sync。

### 2026-08-16：Agent 地基融会贯通批（Pi/CC/DSH/Hermes 审计 → 5 commits）

- [x] 四源码审计落档 `docs/superpowers/plans/2026-08-16-agent-foundation-consolidation.md`：Pi 纯 turn 状态机 + steer/followup 双队列；CC 按调用分级的 Tool 契约 + StreamingToolExecutor；DSH Inbox target + session 日志唯一真值；Hermes turn 端验证门（其 5562 行巨石为反面教材，MP loop.py 1633 行正在同向漂移）。社区调研 P0「输入被吞」「结果不能靠模型一句完成了」为差距主轴。
- [x] **Batch A 死代码清除**：入口可达性走查 + 符号级 re-export 核实后删除零生产引用的模块——认知四件套（event_loop/surprise/assertion_memory/model_surface，761 行 + 24 测试）、actions/table_merge（table.merge 实际走 executors 内联实现）、events 包、capability_hints、doctor_report、terminology 包、wechat_media、custom_action_request，共约 1500 行含测试。
- [x] **Batch B Inbox**（`app/agent_runtime/inbox.py`）：`next-step`（steer，下一轮模型请求即携带）与 `next-turn`（followup，模型想停时续跑新轮）双目标有界 FIFO，线程安全 put、loop 边界 drain；与 interrupt_check（cancel 语义）分立。Steered/FollowupContinued 事件。社区 P0「用户输入被吞」补上。
- [x] **Batch C turn 端验证门**（`app/agent_runtime/turn_verification.py`，Hermes verification_stop 模式，纯 policy）：写入类效果执行过且无通过的 verify_result 回执就想 completed → 第一次拦截注入指令通道 nudge，第二次放行；纯读不拦、失败验证不算证据。VerificationNudged 事件；门在 followup drain 之前。
- [x] **Batch D 效果按调用分级**（CC isDestructive(input) 契约）：`ToolSpec.effect_for` + `spec_effect()`/`ToolRegistry.resolve_effect`，权限门/权限模式反馈/guardrail 分类/验证门记账四消费点全部改走解析后效果；分类器异常回落静态声明档，权限链不被实现 bug 炸掉。
- [x] **Batch E loop 收口**：withheld 恢复与截断恢复两个内联块提取为纯函数（`_withheld_recovery_plan` / `_truncation_messages`），生成器体瘦 ~130 行，行为零变化。
- [x] 验证：Python **1283 passed**（新增 19 项：inbox 6 + 验证门 8 + 按调用分级 5）；Node/typecheck 未受影响（纯 Python 侧批次）。
- [ ] 诚实缺口：跨进程 steer 传输（Studio 对话中途插话需常驻 agent 进程）与 session 树形分支/maintenance 相位仍是显式非目标，另批；验证门的 nudge 复用 stop_hook 转移语义，账面上未新增 TransitionReason。

### 2026-08-17：Studio DSH 高保真收口与安装版交付（1.0.7）

- [x] 按已批准边界收口：本地 deepseek-harness 继续作为 Studio 布局、密度与交互形态金样；Magic Pointer 名称/MP 标记、五个工作区入口、八页设置语义以及真实权限/模型/Agent 能力不复制 DSH 品牌或内容。设计与实施记录：`docs/superpowers/specs/2026-08-17-dsh-studio-fidelity-design.md`、`docs/superpowers/plans/2026-08-17-dsh-studio-fidelity.md`。
- [x] 左栏由「整块搜索框 + 导航/会话共用滚动区」改成 DSH WorkspaceBrowser 结构：固定 MP 导航、36px 最近对话头、点击展开/清除/Escape 收起的内联搜索、单独滚动列表座、既有 32px StateDot 会话行与稳定设置底栏。
- [x] ConversationRoot 修正两处可见错误：StatsLine 成为 InputBar 卡片下方 footer；来源标签改为可收缩且文字自身 ellipsis，900px 窄窗长标题/长来源不再互相覆盖。统计仍只取真实轮数/步骤数，不伪造 token、TTFT 或上下文占用。
- [x] SettingsRoot 保留真实设置模型、保存确认、失败回滚和主题切换，仅重组表现：DSH 16/24 页头、14/22 描述、hairline 行与一页一组原位 disclosure 卡；首组默认展开，组头按钮带稳定 id 与 `aria-expanded`，其余组就地开合。
- [x] 测试先行：新增契约先在旧 StatsLine 顺序上失败，再完成实现；fresh 验证 Python **1286 passed**、Node **147 passed / 100 源文件**、五套 typecheck、ESLint 0。离屏截图 `data/runtime/dsh-fidelity-{chat,settings}-1.0.7.png` 和 `dsh-fidelity-chat-narrow-1.0.7.png` 已人工审看，窄窗 capture `console_errors=0`。
- [x] 本机交付：`npm run sync` 再跑全门后构建 `release/Magic-Pointer-1.0.7-x64.exe`，静默安装、同步 secrets、重启；安装目录 `resources/app/package.json` 版本核对为 **1.0.7**。
- [ ] 诚实边界：本批只收口 Studio；Stage/Companion 不在范围内。截图验证版式与 Chromium 渲染，不代替真实多应用手势/设置持久化人工验收；StatsLine 更丰富的 token/时延组等待真实数据源。

### 2026-08-18：Sovereign Agent 后端地基第一批与安装版交付（1.0.9）

- [x] **方向重新裁决**：目标是完整自有 Agent，不是纯外设、Hermes 后端或整体 fork。Hermes/Pi 作为持续对照与资产语义来源，认知循环、确定性边界、状态与产品体验由 Magic Pointer 自己持有。最新蓝图为 `docs/research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md`，并与前期综述、审议文档相互链接；实现顺序单列于 `docs/superpowers/plans/2026-08-17-perception-input-artifact-foundation.md`。
- [x] **结构化感知从串行回落改为并发证据 Broker**：匹配适配器同时执行，完成顺序不参与裁决；复用 Evidence 契约输出 ok/degraded/empty_confirmed/busy/timeout/unsupported/denied/error 八态，完整保留 observations、耗时与错误，显式产出 content_disagreement；容器窗口名不再压过真实内容，干净 ok 证据可压过更高优先级的 degraded partial。
- [x] **InputArtifact v1 成为感知到 Agent loop 的边界对象**：手势输入必须绑定已提交 FrameLease；公开投影只给 GUI/CLI 可解释信息（目标、来源徽标、置信度、冲突、预览），模型投影不重复用户指令、不泄露原始 UIA/DOM 树和本地附件路径，并使用 origin=data 硬围栏。长文本有显式窗口说明；终端输入同时携带选中锚点与 8,000 字符内错误窗口。
- [x] **生产链已消费新契约**：`selection_bridge._loop_router` 将纯 command 放指令通道、InputArtifact 放 `evidence_input` 数据通道，并把公开 artifact 回传 GUI/CLI；后续像素证据追加不会抹掉结构化 observations/conflicts/readState。
- [x] **TDD 与交付**：并发/八态/冲突/反容器、FrameLease、模型投影、围栏、显式截断、终端窗口与 loop 接线均先观察失败再实现。fresh 全门：Python **1302 passed**；Node **151 passed / 104 源文件**；五套 typecheck 通过。NSIS 生成成功；同步安装阶段实测发现 PowerShell `Copy-Item` 在 269 字符 Torch 源路径失败，新增失败契约后改为 Robocopy `/E`（不 purge，退出码 ≥8 才失败），重跑完整 `npm run sync` 返回 0；安装目录版本为 **1.0.9**、超长路径存在、应用已重启。
- [ ] **下一批明确边界**：并发 Broker 当前只收束结构化适配器；Explorer、SurfaceAdapter、OCR、Vision 仍需纳入一次 fan-out/fuse，且 SurfaceAdapter 仍有按手势启动成本。InteractionLedger 仍未接 Agent loop，session 没有 durable operation program counter/effect sandwich，旧 `_bridge_evidence_block` 只剩测试调用但尚未删除。这些不得被本节冒充为完成。

### 2026-08-18：Run Kernel、durable Inbox 与唯一账本投影交付（1.0.10）

- [x] **EventSession 继续是唯一 durable truth**：新增 `app/run_kernel` 只承载 frozen schema 与纯投影，不拥有第二套持久化；既有 hash-chained JSONL、跨进程文件锁、turn lease、surface projection 与 repair 继续由 `EventSession` 统一负责。
- [x] **Effect sandwich 进入真实 tool loop**：scheduler 给出 started 后、物理执行体运行前写 `operation/prepared`（operationId/callId/step/effect/dispatched）；执行完成写单一 `operation/settled`（outcome/failureType/usedBackend/latency/message），settlement 本身即 TOOL surface，新生产执行不再写 `tool/call + tool/result` 双形状。旧 `tool/call` 只保留历史日志 repair 读取。
- [x] **恢复语义由 effect 确定**：未 dispatch 为 not_started/safe replay；未结算 read 可重放；reversible_write 必须 verify-before-retry；local irreversible/external send/destructive/purchase 永不盲重放。普通异常、取消后外部状态未知与成功结算不再混成一个“工具失败”。
- [x] **Inbox 跨进程且消费原子化**：`inbox/message` 持久化 next-step/next-turn；`inbox/consumed` 用一次 `append_many` 同时标记已领取并把 instruction-origin USER 消息加入模型 surface。两个 store handle 并发 claim 只有一个成功；旧进程内 Inbox 在 loop 边界先落盘再 claim。新增并打包 `scripts/agent_session_bridge.py` 的有界 put/pending API。
- [x] **InteractionLedger 改成 session projection**：每个 loop turn 在 `turn/start` 后写 `interaction/start`；投影真实 model usage/轮数、request→response 时延、tool latency/backend、look、终态、egress operation、app/evidence/confidence/InputArtifact id。open turn 的 succeeded/ended/e2e 保持 null；selection 与 conversation 返回同一公开账单，生产没有 `InteractionLedger.save()` caller。
- [x] **TDD 与安装交付**：operation 执行前可见、settlement 单 surface、并发不双吃、next-step/next-turn 续跑、bridge 错误语义、ledger token/终态/感知身份与 package allowlist 均有回归。fresh 全门：Python **1313 passed**；Node **151 passed / 104 源文件**；五套 typecheck 与 ESLint 通过。`npm run sync` 再跑同套门、构建 `Magic-Pointer-1.0.10-x64.exe`、静默安装并重启；安装目录版本 **1.0.10**，run_kernel/session bridge/InputArtifact/ledger projection 均独立核对存在。
- [ ] **仍未闭合**：Electron/Studio 尚未提供运行中 steer 控件，账单字段虽已随 bridge 返回但未做完整可视化；crash repair 会按风险补结算并关闭中断 turn，尚不能从 program counter 续跑原 loop；DraftArtifact revision、ask-user UI 跨进程往返、Explorer/SurfaceAdapter/OCR/Vision 同一次 fan-out/fuse 仍是后续。完整自有 Agent 产品方向不变，本节只是第二块可测地基。

### 2026-08-18：两批地基复审与四处修复交付（1.0.11）

- [x] **结算语义不再嗅探结果文本**：`outcome_known` 由唯一能观察到它的调度器直接给出，取代对 `"outcome may be unknown"` 子串的匹配（工具名是模型可控的，子串判断把"是否未知"交给了模型）。
- [x] **崩溃修复文本与持久记录对齐**：prepared 但从未 dispatched 记为 not_started 时，给模型的文本不再说 TOOL_OUTCOME_UNKNOWN。
- [x] **`RecoveryPolicy` 第一次被生产代码消费**：safe_replay / verify_before_retry / never_replay 各自成句，从 prepared 时的 effect 一路走到模型读到的指引。
- [x] **并发感知加裁决 deadline**：broker 不再等最慢的 provider 无限久；超时记 timeout observation，用已到达的证据裁决，单适配器路径不再走同步特例。
- [x] **交付**：fresh 全门 Python **1318 passed**、Node **151 passed / 104 源文件**、五套 typecheck 与 ESLint 0；`npm run sync` 构建 `Magic-Pointer-1.0.11-x64.exe`、静默安装并重启，安装目录版本 **1.0.11**。

### 2026-08-18：感知 provider 协议、独立融合与像素 tier 同表裁决（开发树已实现并全量验证，未升版本、未 sync）

- [x] **§13.1 的 provider 协议真实存在，并与第二类 provider 同批落地**：`app/perception/providers.py`（`ProviderDescriptor`/`ProviderResult`/`PerceptionObservation`/`AdapterProvider`/`CallableProvider`）+ `app/perception/fusion.py`（纯裁决）+ `app/perception/pixel_ocr.py`（冻结帧 OCR provider）。协议不是为单一实现立的抽象：结构化适配器、Explorer、SurfaceAdapter、手势结构化策略与 OCR 各自是一个 provider。
- [x] **provider 不再互相压制**：Explorer 命中不再短路 fan-out，SurfaceAdapter 不再覆写别人的 trace，手势策略把自己内部的 attempts/冲突原样并入外层 trace（复合 provider 是这些细节唯一存在的地方）。对当前窗口不适用的 provider 记 declined，不往证据里塞噪音。
- [x] **裁决只有一处**：`fuse_observations` 按「覆盖 mark > 非容器 > 非降级 > tier > 优先级 > 置信度」排序；跨来源文字比对把数字当关键位（"120" vs "210" 是冲突，不是 70% 相似）；被压过的结构化读取记为 note 而非 conflict，避免每个纯像素应用都弹确认。
- [x] **像素 tier 进同一张表**：OCR 不再由 `structured_covers_mark` 布尔在另一个进程触发、命中后整体替换上下文。快照阶段的 observation 随 trace 过河并被复原，OCR 作为一个 observation 参与同一次排序；结构化读到划中那一行时像素 tier 不启动；被压过时容器名仍留在裁决里。没有冻结帧就记 `unsupported: frozen_pixels_unavailable`，不改抓实时屏幕。
- [x] **broker 按 provider 计时**：每个 provider 可有自己的 deadline，tier 只等到最有耐心的那个为止。
- [x] **模型表面与真实来源对齐**：来源徽标只列被选中的读取及与它一致的读取；`read_around` 不再把 OCR 结果签成 `source: uia, confidence: 1.0`；长文本投影改为以手势位置为中心的 16k 字窗口 + 前后缺字交代（此前该窗口逻辑只挂在无生产调用方的 `_bridge_evidence_block` 上，实际投影是"取前 16k 字"）；系统提示词第 2 条指向 InputArtifact 真实携带的 `visual_anchor`（`bbox:l,t,r,b`，`look` 原样可用）。死代码 `_bridge_evidence_block` 与其专属截断助手已删除。
- [x] **幂等键不再随工作树抖动**：`contextPacket.workspace` 的活体脏状态（HEAD、changedFiles、diffStat、diffExcerpt、isDirty）与 `runtime.processBinding` 的进程号曾一起进 canonical，于是保存任何无关文件都会让同意图重规划换键——回执复用不命中，重试可以把同一封外部发送再发一遍。现在只保留操作落在哪里（cwd/repoRoot），证据内容照旧绑定。与 §审计第 9 条剥掉的随机 leaseId 是同一缺陷的第二处，随机顺序的完整套跑实测暴露。
- [x] **TDD 与交付**：provider/fusion 单元契约、像素 provider 冻结帧约束、两段接缝集成（容器名被压过仍在裁决里 / 干净结构化读取不花 OCR / 无冻结帧诚实 unsupported）、模型表面来源与截窗、幂等键对无关文件改动免疫均先观察失败再实现。fresh 全门：Python **1338 passed**；Node **151 passed / 104 源文件**；五套 typecheck 与 ESLint 0。**未升版本、未 sync**（按用户指示，版本号留到成熟里程碑统一升；安装版仍为上一批 1.0.11）。
- [ ] **诚实边界**：Vision 仍未成为 provider（`look` 仍是模型可调工具，不参与自动 fan-out）；SurfaceAdapter 仍有按手势启动成本；像素 tier 仍在回答阶段跑（同一张冻结帧、同一套融合，但首反馈之后才有 OCR），把它提前到 pointerup 需要单独的延迟预算裁决。

### 2026-08-18：DraftArtifact revision（开发树，未升版本、未 sync）

- [x] **产物不再是聊天气泡**：`app/artifacts/` 只有 schema 与纯投影，EventSession 仍是唯一 store。`artifact/generated` / `artifact/patched` / `artifact/accepted` 三类事件；批准绑定 `(revision, contentHash)`，过期 hash 拒绝；批准后再改把 state 打回 edited。
- [x] **生产接线**：loop 在 `TransitionReason.COMPLETED` 且文本非空时写入 generated；追问生成新 artifactId；ask_user 澄清不产生草稿；补丁不进模型表面。
- [x] **TDD**：生成/补丁/批准/空文本/loop 终稿/澄清非草稿/追问新草稿均先观察失败再实现。Python 全门 **1346 passed**。**未升版本、未 sync**。
- [ ] **诚实边界**：written/submitted/verified 要等 ActionLease 真写回；GUI 尚未渲染草稿与 diff；crash 从 program counter 续跑、ask-user UI 往返仍未做。Receipt 停止条件见 2026-08-19。

### 2026-08-18：桌面动作面（开发树，未升版本、未 sync）

- [x] **Kimi 13 工具进主 loop**：`list_apps` / `launch_app` / `activate_window` / `get_app_state` / `click` / `type_text` / `press_key` / `scroll` / `set_value` / `perform_secondary_action` / `select_text` / `drag` / `turn_ended` 注册在 `desktop-action-tools` row。`ComputerTaskService` 仍是另一条视觉环，不是这 13 个工具。
- [x] **StateVersion**：`snapshot_id` 绑定 hwnd/pid/bounds；窗口移动/换进程 stale；内容重排不靠 snapshot 检测（Kimi 规则）。index XOR 坐标，混传拒绝。
- [x] **InputOwnershipLock**：mutating 互斥；busy 时只读放行；`turn_ended` 释放。`FailureType.STALE_SNAPSHOT` / `COMPUTER_USE_BUSY`。
- [x] **UFO² 原生优先**：`set_value` / `perform_secondary_action` 先走注入 UIA；失败不假装 click 成功。`press_key` 拒 Win/Meta；`launch_app` 未知名不打开 Explorer。
- [x] **Everywhere 看门狗（自写）**：MCP stdio 与 OCR worker 的 Popen 进入 `KILL_ON_JOB_CLOSE` JobObject。不抄 BSL 源码。常驻 UIA 宿主保持 DETACHED，不进此 job。
- [x] **TDD**：13 工具注册、缺 snapshot、窗口移动 stale、混传、busy、turn_ended、未知 app、Win 键、set_value 原生路径、type_text unavailable、JobObject 杀子进程、MCP/OCR 接线均先观察失败再实现。Python **1359 passed**。**未升版本、未 sync**。
- [ ] **当时诚实边界（已被 2026-08-19 收口）**：生产 `elements_probe` 仍空；`uia_act` 未接 COM；Receipt 未做。

### 2026-08-19：UIA 树接入 + Receipt 停止条件（开发树，未升版本、未 sync）

- [x] **生产 AX 树不再为空**：`app/desktop_actions/uia.py` 把原始 UIA 节点规范成 Kimi 元素（1-based index / role / name / rect / patterns）；无名无 pattern 的容器丢掉；预算 400。`UiaBridge` 可注入 walker/actor。
- [x] **ctypes COM，不改 C# 宿主协议**：生产 `walk_window` / `act_on_element` 走 `CUIAutomation` ControlView（IID 取 Wine `uiautomationclient.idl` 的 `30cbe57d-…-7ac5ac4825ee`）。hwnd 0 或 COM 失败返回空树 / `{ok:false}`，不假装 click。`default_session` 的 `_live_elements` / `_live_uia` 走这座桥。真机对前台窗口走出 266 个 ControlView 节点，按钮带 Invoke。
- [x] **Receipt 是停止条件**：`app/receipts/` schema + 纯投影；session 事件 `receipt/issued`。loop 在每一次 `LoopStopped` 前发票。写过未验证 → `unverified`；写后验证 → `succeeded`/`write_verified`；纯回答成稿 → `succeeded`/`draft_generated`。
- [x] **验证门认工具 JSON**：`verification.matched is true` 与 `verify_result` 同等为证据，13 工具的 set_value 不再永远 nudge。随后一批规定 click 的 matched 不能单独收工。
- [x] **TDD**：normalize/bridge/缺 pattern/live probe、walk_window(0) 空列表、纯回答发票、未验证写入发票、JSON 验证消 nudge 均先观察失败再实现。Python **1369 passed**。**未升版本、未 sync**。
- [ ] **诚实边界**：未做记事本/Office 端到端手势写回回归；COM 树是当场 ControlView，不是 named-pipe 宿主；Receipt 未进 GUI/ledger；crash 从 program counter 续跑、Vision 每轮 fan-out 仍未做。ask-user Stage 芯片见下一批。

### 2026-08-19：Gate 2 聪明感收口（开发树，未升版本、未 sync）

- [x] **澄清选项芯片**：Stage 在 turn `awaiting` 且 `pendingInput.options` ≥2 时渲染 `.stage-chip`；点击把选项原文送进现有 `submitCommand` / 同 selection session。闲置罐头命令让路。不新 bridge、不新 session。
- [x] **写后必再观察**：`type_text` 用 ValuePattern GetCurrentValue 读回，匹配才 matched。验证门：click 的 JSON matched 不是完成证明；写后再成功 `get_app_state` 才算观察过；type_text/set_value 自带 matched 仍可过门。
- [x] **中文操作手册**：13 个桌面 ToolSpec description 改为何时用/失败码/下一步；系统提示加上证据够就停、不确定 ask_user_question、写入后再 get_app_state、视觉已尝试则勿重复 look。
- [x] **结构化未覆盖时自动 look 一次**：fusion `marksCovered` 不为 true、且有 visual_anchor + 冻结帧 + vision backend 时，selection 桥同步 look 一次，结果写入 InputArtifact `look_once` 再进 loop。失败保持八态，不改抓实时屏。conversation 无冻结帧仍 unsupported。这不是 Vision 每轮 fan-out。
- [x] **多步 token**：builtin bundle `max_tokens` 800→4096；FULL_ANSWER 墙钟预算不变。
- [x] **TDD 与验证**：澄清芯片、读回确认、click 不能单独收工、look_once、4096 token 均先观察失败再实现。Python **1384 passed**；触及的 Stage Node 测试与 renderer/tests typecheck 通过。**未升版本、未 sync**。
- [ ] **诚实边界**：crash 从 program counter 中段续跑原 loop、DraftArtifact `written`、Vision 每轮 fan-out、ask-user Inbox 按 question id 绑定、真机记事本写回归仍未做。不把本批冒充 Gate 2 完成。

### 2026-08-19：产品边界纠正——任务时长不是边界（文档事实源 + prompt 早停偏置）

- [x] **用户裁决**：Magic Pointer 是顶级 Agent Harness 本身，短任务和长任务都自己做；对接 Claude Code 等外部客户端只是“把 prompt 写进它输入框”，与写进微信输入框同级，不是把执行外包出去，也不是任务难度分级器。目标是最综合、最集成各方优点的 harness。
- [x] **根因**：8·17 已把方向裁决为“完整自有 Agent”（§18 2026-08-18 条、`docs/research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md`），但那次只写进了进度账本和 research 文档，**没有同步 §1 产品定位和根目录 `AGENTS.md`**——而那两处才是每个新会话的必读入口。于是“短任务”边界持续自我复制，直到 8·19 仍在产出“中文短任务手册”“证据够就停”。
- [x] **事实源已改**：§1.1（推翻旧短任务边界）、§1.2 一句话定义、§4.8 `MPAgentRuntime`、§9 轮次目标、§10.2 改名“任务 Governor”并写明 rolling budget 约束反馈节奏而非循环寿命、§16.1、§17 checklist；根 `AGENTS.md` 与 `AGENT.md` 产品边界段；`docs/2026-08-13-ARCHITECTURE_HANDOFF.md`、`docs/2026-08-14-MASTER_HANDOFF.md`、`docs/2026-08-14-HARNESS_RECONSTRUCTION_PROGRESS.md`、`docs/STATUS.md`。
- [x] **prompt 早停偏置已修（真行为 bug）**：`app/agent_runtime/system_prompt.py` rules 第 1 条原为“证据已经足够时立即回答并结束”，会让模型在多步长作业中途以“看够了”为由收工。改为区分两种形态：回答/生成类证据够就交付、不为显得勤奋空转；多步交付类必须做完全部步骤，“看够了是可以停止翻找，不是可以停止干活”。先观察 `tests/harness_builtin_bundle_test.py` 断言失败再实现，fresh 全量 Python **1384 passed**。
- [x] **长任务能力差距盘点已完成**：`docs/2026-08-19-LONG_RUN_CAPABILITY_GAP.md`，四路并发只读审计，全部结论带 `文件:行号`，含五层缺口与建议批次 A–E。后续长任务工作先读该文档，不要重新推导清单。
- [x] **长任务地基第一批已落地（开发树，未升版本）**：按用户裁决「别造轮子，本地顶级 agent 源码直接搬」，从 HermesAgent（MIT）移植。硬天花板全解除——bridge 期限改无活动超时、`emergency_turn_fuse` 90→1000；上下文层——请求级 token 估算（补上此前完全漏算的 system prompt 与 tool schema）、可反复触发的压缩 + anti-thrash、`TodoStore` 跨压缩保留未完成步骤、尾部按 token 预算裁剪、压缩成功判据由条数改为 token 权重（实施中发现的真 bug）。出处登记在 `THIRD_PARTY_NOTICES.md`。fresh：Python **1401 passed**、Node **152 passed**、typecheck + lint 干净。
- [ ] **未闭合（长任务真实缺口，不得冒充已完成）**：首要事实是**长任务当前跑不了**——Stage 60s / Studio 120s bridge 硬超时（`electron/main.ts:3933-3934`、`1187`）与 90 轮 fuse（`app/fabric/engine.py:983-984`）在任何长跑能力被用到之前就落闸，当前上限 ≤2 分钟、≤90 轮，而 OSWorld 2.0 量纲是 1.6 小时、318 次工具调用。其后依次是：上下文耐久（rolling compaction、进度事实保护、工具结果窗口化、真实 token 计数）、感知语义隔离（冻结 look/read_around 与 live get_app_state 混用、InputArtifact 不可中途再编译）、持久性（program counter 续跑、effect sandwich 上生产盘、session 轮转）、可控性（steer 生产接线、graceful interrupt、真实步数与账本可视化）、结构性（子任务分解、todo 落盘、回执准入）。**Gate 2 的“crash recovery”需升级为“program counter 续跑”；长任务的上下文耐久性此前不在任何 Gate 里，是新边界带来的新需求。**
