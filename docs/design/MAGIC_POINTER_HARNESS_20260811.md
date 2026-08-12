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

### 1.1 Magic Pointer 不是另一个项目级 Coding Agent

用户已经明确：

- Claude Code、Codex GUI/CLI、Pi 等项目级 Agent 按用户原有方式正常使用。
- 中大型项目、长程编码和跨仓库重构不会默认搬进 Magic Pointer 的小框里。
- Magic Pointer 内部 Agent 主要完成一两轮、几分钟内结束的日常桌面任务。
- 当用户正在 Claude Code/Codex 中工作时，Magic Pointer 可以收集散落上下文、组织 Prompt、填入原输入框，但默认不代替原 Agent 承担整个项目。
- 外部 Agent 将来可以作为能力提供方接入，但不是“简单任务/复杂任务”分级器。

典型内部任务：

- 圈选聊天记录、图片、文件和桌面材料，生成报告或回复；
- 把多处零散信息编译成高质量 Prompt；
- OCR、改写、翻译、扩写、表格提取、文件转换；
- 打开应用、调整音量、调用地图/日历等 MCP；
- 在少量步骤内完成可验证的跨应用任务；
- 生成结果后允许用户编辑，再写回、发送或保存。

### 1.2 产品的真正发明点：交互预编译式 Harness

Magic Pointer 的鼠标唤醒、划线、圈选、多选、短录屏，不是聊天框的花哨入口，也不是只提供一张截图。它们构成 Agent 运行前的“编译阶段”：

1. 人类用视线和手势完成高成本语义判断，明确 THIS/THAT/THESE/HERE。
2. Harness 在 pointerup 时固定当时的画面、窗口身份和手势几何。
3. DOM、COM、UIA、应用 Connector、OCR、视觉证据并发解析成对象图。
4. Harness 把对象、原始数据引用、目标租约、权限和少量工具编译成 `RunEnvelope`。
5. Agent 醒来时直接从第一步有用工作开始，而不是重新截图、扫描全屏、猜用户指向什么。

一句话定义：

> Magic Pointer 是把人的桌面指代理解预编译为短任务 Agent 可直接执行上下文的桌面 Harness。

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

`app/fabric/model_plan.py` 接受多个工具调用，但 `app/fabric/engine.py::plan_from_model` 在生产路径要求恰好一个 tool call。`agent_gateway.py` 面向外部项目 Agent 和 session worker，不适合作为默认的短任务桌面 Runtime。

## 4. 总体架构

新底层分为十一个有清晰契约的模块：

1. `CaptureCore`：手势 epoch、临时帧缓冲、不可变 `FrameLease`。
2. `AccessibilityHost`：常驻低功耗 Win32/UIA 宿主。
3. `PerceptionBroker`：多路并发、deadline、证据归一化和融合。
4. `ObjectGraph`：文本、控件、消息、图片、文件、视频和容器的统一对象关系。
5. `AdapterRuntime`：按应用/版本渐进增强的 `SurfaceAdapter`。
6. `ContextCompiler`：把证据编译成 `SelectionBundle` 和 `RunEnvelope`。
7. `CapabilityBroker`：本地工具、MCP、Skills、插件和动态工具搜索。
8. `MPAgentRuntime`：基于 Pi 稳定 agent-loop 的短任务执行器。
9. `ActionBroker`：输入所有权、ActionLease、动作稳定、验证和撤销。
10. `ArtifactStore`：可编辑 Draft、文件、地图、表格、报告等产物。
11. `ResourceGovernor`/`RunLedger`：资源预算、事件、成本、权限和回执。

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
- 默认短任务 1–2轮，通常数分钟内结束。

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

### 10.2 短任务 Governor

每个内部任务有明确预算：

- wall-clock；
- provider调用次数；
- tool call数量；
- token/费用；
- 相同错误重试次数；
- 新应用和新权限范围。

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

### 11.4 示例

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
- RunEnvelope、短任务 governor和事件流；
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
   - 内容：用户对 Harness的最终澄清、短任务边界、FrameLease、原始对象、UIA速度、执行授权、资源策略和“不得被旧代码约束”。
   - 持久化方式：已归纳进本文；后续模型以本文为准，不依赖聊天窗口仍存在。

### 16.2 核心项目文档

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
- [x] 确认短任务内部 Agent与项目级外部 Agent边界。
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
- [x] L12 Replay 基座：`app/replay/`（DesktopTrace schema + recorder + replayer）+ `scripts/record_desktop_trace.py`。感知层离线回放未接线。
- [ ] 批次 1：L1 Agent Loop（engine 改解释器、recipe 降级为循环缓存）+ L2 感知即工具（read_around/look 等）。
- [ ] 批次 2：L3 Anchor 重解析 + L4 前置条件 + L5 可逆性 + L7 注入隔离。
- [ ] WGC/D3D 捕获后端（FrameLease 生产热路径）。

下一步主线：批次 1（L1+L2），需先更新 Phase A 账本并编写实施计划。
