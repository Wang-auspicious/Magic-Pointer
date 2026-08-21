# Magic Pointer Harness 重建进度（2026-08-14）

> 状态：进行中，不可作为“已完成”或“可交付”声明。
>
> 当前分支：`codex/harness-reconstruction`
>
> 本轮用户约束：不使用 subagent；不做中间版本升级；不做中间 `npm run sync`；前端 GUI 设计不在本轮范围；底层 Agent、插件、会话、感知、动作安全与自进化必须先做扎实。

## 1. 这次重建到底在做什么

Magic Pointer 不应退化成“在桌面上套一个聊天框”，也不应靠关键词把命令分流到几十个互不相干的处理器。当前目标是建立一条统一的后台 Agent 主干：

1. 用户手势完成时冻结现实证据；
2. 将圈选对象、窗口身份、像素、结构化文本和来源证明编译成 Agent 的首轮上下文；
3. 一个模型循环根据自描述工具决定读取、推理、提出动作或回答；
4. 工具结果回到同一个循环，直到模型自然完成或出现可解释的终止原因；
5. 写操作保持在确定性安全层中，由预条件、ActionLease、用户授权与结果验证约束；
6. 会话、工具、模型、感知、SurfaceAdapter、自进化服务均通过可卸载插件提供；
7. 任务结束后可以审查轨迹并产生学习候选，但后台不得自行修改核心代码。

参考架构不是整套照搬某一个项目，而是按职责取长处：

- Claude Code / Pi：单一模型循环、自描述工具、工具结果反馈、模型自然完成；
- DeepSeek Harness（DSH）：作用域插件、依赖注入、卸载回滚、事件溯源会话；
- Hermes：后台轨迹审查、受控学习候选、自进化闭环；
- Magic Pointer 自身：手势即任务编译器、冻结画面证据、指代对象、低摩擦入口（任务时长不设上限）、ActionLease 与本地目标表面验证。

Kimi、Hermes、Claude Code 与新克隆的 UI-TARS 仍需继续做逐模块差距审计；当前不能声称已经完整对齐任何一个成品 Agent。

## 2. 当前代码与工作区事实

- 当前分支：`codex/harness-reconstruction`。
- 已有本轮提交：
  - `9de1dee docs: define harness reconstruction phases`
  - `f9c0135 feat: bind frozen evidence to target identity`
- 工作树当前有大量未提交改动和新增文件；`git status --short` 在本文件记录时为 271 项。
- 其中包含此前模型遗留的大量测试删除与其他用户改动，不能用 reset、checkout 或批量覆盖处理。
- 当前开发树与已安装应用不是同一版本。`docs/STATUS.md` 已明确：已安装的 1.0.4 不能代表当前开发树。
- 按用户本轮明确要求，在整个后端重建满意前不做 patch version 自增，也不运行中间 `npm run sync`。

## 3. 已完成的底层工作

### 3.1 FrameLease 与证据真实性

已完成：

- 手势完成时的冻结帧与目标窗口身份绑定；
- 记录进程身份、窗口句柄、捕获时间、物理屏幕坐标和 capture attestation；
- 选区裁剪使用物理像素坐标；
- Agent 使用完整目标表面证据，小选区 crop 不再成为唯一 OCR/视觉证据；
- 感知结果携带真实 `usedBackend`、错误和 timing；
- 添加安全的真实场景测试入口，不在普通单元测试中随意启动 Electron。

真实验证证据：曾在 Windows 记事本场景完成一次圈选问答，约 3.6 秒、2 个模型回合、1 次 look，后端报告为 `magic_pointer.messages_multiturn_streaming`，无运行时错误。该证据说明主链可以自然短回合完成，不说明所有应用已经通过。

### 3.2 Agent 正常终止与空转治理

已完成：

- 生产语义中的 `max_turns=6` 已删除；
- Recipe 不再拥有或控制 Agent 生命周期；
- 模型供应商的瞬时错误在模型适配层重试，不伪造新的用户消息；
- 持续供应商故障以 `PROVIDER_UNAVAILABLE` 明确终止；
- 重复失败、重复读取同一证据、重复同值写入、无新信息循环由语义 guardrail 检测并以 `STALLED` 终止；
- 取消在工具执行期间仍按取消语义传播；
- 保留 90 回合的异常保险丝，仅用于代码状态机失控时的 invariant failure，不作为正常任务策略。后续仍需通过真实复杂任务确认它只会在异常路径触发。

仍在收口：`app.fabric.engine.run_agent_turn` 虽已忽略 Recipe trajectory，但仍调用 `route_to_trajectory()` 以取得本地动作，因而仍会无意义地进入 Recipe 编译器。新的回归测试已于 2026-08-14 观察到预期失败：`AssertionError: recipe router entered`。下一步是拆出纯 `resolve_local_action()`，使普通 Agent 完全不触碰 Recipe 路由。

### 3.3 唯一 Agent 路径

已完成的生产路径变化：

- `scripts/selection_bridge.py` 的普通命令只调用一次 `_loop_router()`；
- 已从 `main()` 移除旧购物清单、日历、路线、长度目标等硬编码业务分流；
- 已移除 `IntentRouter`、模型意图分类器、强制 Recipe 路由和 `MAGIC_POINTER_LEGACY_ROUTER` 的生产调用；
- Agent 失败后不再调用屏幕视觉模型或单轮文本模型生成另一个答案；
- 非完成终态返回真实 `ok: false`、终止原因、后端、receipts 和 diagnostics；
- copy、保存截图、显示来源仍作为零模型本地动作保留；
- 用户明确要求的外部 Agent handoff、上下文包、review、引用标签等产品模式仍是显式入口，不是普通命令的隐式 fallback。

已通过的针对性检查：

- 普通指令保持原文，不再被 Recipe 模板改写；
- `selection_bridge.main()` 只有一个 loop router 调用；
- loop 之后不存在 screen vision/direct model fallback；
- loop 正常回答和本地动作映射均通过。

尚未完成：旧桥接文件仍保留若干已经退出生产路径的死函数和 imports，包括 `_classify_with_model`、`_general_fallback_answer`、`_screen_region_vision_answer`、购物清单/日历/路线/长度专用 response。能力已由工具承接，但死代码尚未安全删除；必须先核对直接调用方与陈旧测试，不能粗暴删文件。

### 3.4 插件内核

已完成：

- 插件可声明依赖并按拓扑激活；
- `ctx.provide()` 是响应式服务注入，服务出现后等待它的插件可激活；
- 服务 revoke/reprovide 可触发正确的停用与重新激活；
- 父子 scope 生命周期隔离；
- 工具、prompt section、hook、SurfaceAdapter、service 在卸载时精确回滚；
- Agent scope 与 surface scope 分开，避免插件重复激活；
- 支持内建插件、用户插件目录、禁用、配置 patch、live config dump；
- `ctx.llm`、`ctx.sessions`、`ctx.learning_review`、`surface_adapters` 已成为正式 seam；
- 生产路径不再依赖隐藏的 `GLOBAL_REGISTRY` 默认值。

已通过过 104 项插件/SurfaceAdapter 相关测试；随后新增会话和学习插件后，相关 Python 测试集合曾达到 218 项通过。因为代码仍在继续变化，这些历史数字不能替代最终 fresh full verification。

### 3.5 事件溯源会话

新增 `app/agent_runtime/session.py`，核心行为参考 DSH 的 MIT 实现并适配 Magic Pointer：

- JSONL append-only 事件日志；
- 每条事件带 sequence、session id 与 hash chain；
- 模型可见消息由显式事件投影重建；
- 发给模型的消息、工具 schema、system/provider request header 先落日志；
- assistant 工具请求在执行工具之前落盘；
- tool call 与 tool result 分别记录；
- compaction 通过追加 `surface/replace` 实现，不原地改历史；
- 只自动修复末尾截断；中间篡改或 hash 错误 fail closed；
- 中断工具按风险修复为 `TOOL_NOT_STARTED` 或 `TOOL_OUTCOME_UNKNOWN`；
- fork 只能从完成边界创建，并保留 lineage；
- resume 还原历史消息与回合编号；
- selection bridge 为每个选择会话生成稳定的 `agentSessionId`。

### 3.6 Hermes 式受控自进化

已阅读本地 Hermes 的 MIT 许可证以及 `background_review.py`、`learn_prompt.py`、`learning_mutations.py` 和相关测试，完成第一版安全实现：

- 后台 review 是独立、受限、只生成候选的模型请求；
- 可修改范围仅限用户拥有的 `learning/`、`skills/`、`plugins/`；
- 绝对路径、路径穿越、核心代码路径、符号链接/reparse ancestor 均拒绝；
- candidate 记录 exact old hash、diff、审查信息与 audit；
- 后台不能 apply；只有 `approved_by="user"` 才能原子写入；
- apply 前再次比对旧 hash；
- 生成 backup，支持 reject 与 rollback；
- 候选去重；学习故障不影响当前用户答案；
- Electron 在 selection 结果后异步调度 review，不阻塞主 UI 回答。

当前缺口：还没有把候选列表、diff、批准、拒绝、回滚做成完整产品交互；本轮 GUI 不在范围，因此应先补一个可审计的本地 CLI/后台 API，再由以后 GUI 接入。

## 4. Magic Pointer 已融入的自身优势

当前架构不是把 UI-TARS、Codex 或 Hermes 套一个壳。Magic Pointer 的优势已经成为主链输入和安全边界：

1. **手势即对象编译**：用户不是先描述“屏幕上那个东西”，而是用动作直接建立 `THIS/THAT/THESE/HERE` 对象。
2. **历史像素被冻结**：pointerup 后 UIA、OCR、overlay 或窗口变化不能偷换模型观察的画面。
3. **多证据融合**：UIA、OCR、像素、窗口/进程身份和应用适配器并发形成证据；小 crop 不是唯一真相。
4. **零摩擦入口 + 不封顶的执行**：指一下就能开工，首轮直接进入有效工作；任务要跑几十上百轮、跨小时也照跑，时长不是入口的代价。
5. **动作安全在模型之外**：模型可以选择工具和提出计划，但坐标、权限、precondition、ActionLease、确认和结果验证保持确定性。
6. **可投递但不依附**：Magic Pointer 可把冻结证据编译为 prompt 写进 Codex/Claude/微信等任意输入框；那是一条投递通道，执行权始终在 MP 自己的 Runtime。

尚未完全贯穿的新主干优势：版本化 `DraftArtifact`、用户编辑与 Agent patch、跨手势对象记忆、完整 ActionLease 写回链、SurfaceAdapter 的更多真实应用实现。

## 5. 已知高风险与未解决问题

### P0：必须先解决

1. 从 `run_agent_turn` 中彻底移除 Recipe 编译器调用，仅保留独立零模型本地动作解析。
2. 删除 `selection_bridge` 的第二套死路由与二次模型 fallback 代码，而不破坏显式模式。
3. 审计当前 271 项工作树变化，尤其是此前模型造成的大量测试删除；判定哪些应恢复、哪些确属被淘汰架构。
4. 用 fresh full verification 重新建立真实基线：Python、Node、TypeScript、构建、真实场景。
5. 确认 FrameLease 到所有写入工具的 ActionLease 重验证完整闭环，而不是只有读取/提案链完整。

### P1：核心能力差距

1. Hermes：长期任务、记忆检索、学习候选评估、用户审批入口、回滚体验。
2. DSH：更完整的插件契约、插件配置 schema、插件冲突诊断、跨 scope 可观测性。
3. Pi / Claude Code：上下文压缩质量、工具错误恢复、长任务 steering、任务中断/继续、权限模式一致性。
4. UI-TARS / Computer Use：视觉动作循环、全屏/窗口控制、动作后截图验证、GUI benchmark 与安全确认策略。
5. Kimi：尚未完成本轮逐文件对照，不能宣称已吸收其优势。

### P2：交付前工作

1. 更新架构进度 ledger、STATUS、插件文档和真实验证记录。
2. 只在全部后端改造满意并通过验证后，统一递增一次版本。
3. 最后一次运行 `npm run sync`，核对安装目录 `package.json` 版本，并在真实安装版复测。

## 6. 当前测试状态

最近明确的绿色检查：

```text
4 passed:
- raw instruction / no recipe-biased tool order（旧版本检查）
- single agent route / no post-loop fallback
- loop terminal -> answer mapping
- loop local action mapping
```

当前明确的红色检查（有意先写失败测试）：

```text
tests/agent_runtime_fabric_integration_test.py::
test_run_agent_turn_keeps_raw_instruction_and_does_not_route_via_recipe

失败原因：app.fabric.engine.run_agent_turn 仍调用 route_to_trajectory，
从而进入 get_trajectory_compiler；下一步生产修改必须让该检查转绿。
```

历史上已经跑通过的局部集合包括：插件/SurfaceAdapter、Agent loop、session、tool guardrails、自进化、Electron background learning wiring 和完整 TypeScript typecheck。由于当前仍有红测和后续重构，项目现在不处于可交付状态。

## 7. 新增参考源码（只读研究用途）

2026-08-14 已浅克隆：

- `D:\AI_Agents\UI-TARS-desktop`
  - upstream：`https://github.com/bytedance/UI-TARS-desktop`
  - commit：`c2ad42e3eb9b27830db41a3e6f51ca7179d9b168`
  - license：Apache-2.0
- `D:\AI_Agents\UI-TARS`
  - upstream：`https://github.com/bytedance/UI-TARS`
  - commit：`582f3a7ea5d285ee8ed9e2e84048d1ab01453c49`
  - license：Apache-2.0

这两份源码尚未复制进 Magic Pointer。已完成第一轮核心路径审阅，并形成独立报告：

- `docs/2026-08-14-UI-TARS_CODEX_COMPUTER_USE_COMPARISON.md`

已确认 UI-TARS 实际分为模型仓库、UI-TARS Desktop 视觉操作循环和更完整的 Agent TARS/Tarko Harness；Agent TARS 的复杂任务能力来自浏览器、文件、命令、搜索、MCP 与 GUI grounding 的组合，不是单纯截图点击。架构裁决是把 UI-TARS/Codex Computer Use 作为可插拔 `ComputerOperator`，不能替换 Magic Pointer 的手势编译、FrameLease、证据融合和 ActionLease 主干。任何源码复制仍必须先过 Reuse Gate。

## 8. 下一步严格顺序

1. 新增纯 `resolve_local_action()`，让当前 Recipe 编译器红测转绿。
2. 执行 Agent loop、session、selection bridge 相关回归。
3. 删除桥接层死路由和对应死 imports，保持一个正常 Agent 状态机。
4. 按比较报告定义 `ComputerOperator` capability 和风险包装，先写契约，不直接耦合 UI-TARS SDK。
5. 据报告只吸收 hybrid browser、MCP importer、operator 与事件可观测性等能加强差异化的部分，不把产品改成另一个全屏截图点击器。
6. 继续 Hermes/DSH/Pi/Claude Code/Kimi 的能力缺口实现。
7. 完成全量自动验证和多应用实时桌面验证后，再做唯一一次版本升级与本机安装同步。

## 9. 2026-08-14 后续重建实况（以本节覆盖上文的过期待办）

状态仍是“开发中、未交付”。本节记录上文写成后继续完成的生产代码；上文所称
Recipe 仍进入普通 Agent、旧分类/第二回答函数仍保留、事件会话尚未完成等内容已经过期。

### 9.1 单一正常 Agent 主路

- `run_agent_turn` 已不再调用 Recipe/trajectory 编译器；用户原始指令原样进入模型。
- 普通命令只走一个模型循环。旧 `_classify_with_model`、`_general_fallback_answer` 及其
  附属死代码已从 `selection_bridge.py` 删除；Agent 失败不会再偷偷调用第二个模型生成另一答案。
- 固定 6 轮上限彻底移除。正常完成由模型自然结束；重复失败、相同证据、跨工具重复证据、
  重复写操作由 Hermes 风格语义 guardrail 告警后以 `stalled` 停止；90 轮只作为 invariant fuse。
- 工具批次采用 DSH 式有界滚动池：并行安全读可重叠，独占工具形成 barrier，同资源 key
  不并行，物理完成可乱序但提交给模型严格保持原顺序；取消会为未调度调用生成合法回执。

### 9.2 模型协议、工具与 MCP

- OpenAI chat-completions 与 Anthropic Messages 两种多轮工具协议均使用原生
  assistant tool call / tool result 结构；流式 SSE、usage、取消与错误归因已接入。
- 畸形工具参数不再被静默丢弃，而是作为 `is_error` 工具结果反馈给模型自我修正。
- 每个工具有 effect、资源占用、超时、前置条件和结果校验；假 `ToolSpec.compensate`
  与 Fabric 空撤销函数已删除，真实撤销只走 ActionHistory/UndoLog。
- MCP 采用懒发现：初始只暴露发现工具，模型请求能力后才加载远端 schema；Provider 失败会清理，
  动态发现能力不再硬编码为 MCP 专属。

### 9.3 事件溯源会话（DSH 契约）

- JSONL append-only 日志、连续 seq、SHA-256 hash chain、显式 surface projection、模型请求
  message hash、assistant/tool 原生消息、崩溃修复、resume/fork、追加式 compaction 已投入主路。
- 压缩边界会退到完整 assistant-tool exchange，绝不留下真实 API 会拒绝的孤立 tool result。
- 独立进程/句柄追加同一 session 时使用跨平台文件锁；每次追加先重读并验证最新 hash chain，
  防止两个合法 JSON 行形成分叉历史。
- `turn/start` 到 `turn/end` 持有真实 turn lease。并发请求等待活跃轮结束，不能把活任务误修成
  崩溃；进程退出后 OS 自动释放，下一次才按 `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN` 修复。
- 同时首次创建会话时，竞态输家重新采用赢家的已验证日志，不向用户报伪失败。

### 9.4 DSH 插件生命周期与 Hermes 学习闭环

- 插件 host 已提升到进程生命周期；每个请求只创建/回收 request scope。文件指纹在请求边界
  检测，安装、批准、修改、移除插件对下一请求生效，正在运行的 scope 不被热切换破坏。
- 卸载先进入 quiescing，等待插件在途工作完成，再按 LIFO 回滚工具、服务、hook、prompt；
  旧 disposer 不能卸掉热重载后的新注册。
- Hermes 式候选审查已有列表、读取、diff、approve/reject/rollback 后端 API 与 Electron IPC；
  后台只能写候选，只有用户批准能修改用户 learning/skills/plugins，核心目录和 reparse path 拒绝。
- 已批准 `MAGIC_POINTER.md`、`learning/MEMORY.md` 和相关 `skills/*/SKILL.md` 会按当前命令
  相关性、数量与字符预算注入动态系统提示；未批准候选不进入模型上下文。

### 9.5 人在环、后台 Agent 与可观测性

- `ask_user_question` 是真正的 suspension boundary：模型发问后不执行同批 speculative actions，
  返回结构化 question/options，下一条用户消息从同一事件历史继续，而非重开一次任务。
- token usage 跨轮聚合，OpenAI/Anthropic 字段归一化，并与响应元数据、工具 receipt 一起进入日志
  和 bridge 结果；未知 usage 保持未知，不估算伪数字。
- 后台任务的 queued/running/complete/cancel/resume/target-pause 状态迁移使用跨线程、跨进程锁，
  worker 完成不能覆盖并发取消。Pi steering 提交时只报告 queued；真正写入 RPC stdin 后才落
  delivered ack，并按 attempt 隔离，resume 不重放旧 steering。

### 9.6 本轮定向验证与仍未完成事项

为避免开发期间再次耗费半小时，本轮只运行秒级定向测试；最近新增/修复的测试均先观察红灯
再改生产代码。已验证的重点包括：压缩协议 2 项、后台竞态/steering 3 项、session 并发/lease/
创建竞态 7 项、工具契约 2 项。最近一次相应命令均在约 1.7–3.3 秒内结束。

仍未完成，不能声称零 bug 或可交付：

1. 对当前巨大 dirty worktree 做逐文件审计，尤其确认历史删除测试哪些应恢复、哪些属于淘汰架构。
2. 完整 ActionLease 写回链和更多真实 SurfaceAdapter 的多应用真机验证。
3. ComputerOperator/UI-TARS 能力契约及动作后截图验证；当前没有把视觉点击器冒充核心能力。
4. GUI 重做、clarification 专用交互、学习候选管理界面；本轮仍按用户要求先完成后台。
5. 后端停止变动后，才执行一次 fresh Python/Node/typecheck/build/真实截图回归，随后统一 bump
   patch、`npm run sync`、核对安装目录版本和更新 `docs/STATUS.md`。当前没有执行这些长任务。
## 10. 2026-08-14 后端加固续批（秒级定向验证，未交付）

本节记录在第 9 节之后继续完成的生产代码。当前仍处于开发态：没有升级版本、没有构建安装包、没有运行 `npm run sync`，也没有用局部测试冒充全量验收。

### 10.1 TargetLease 与执行入口 fail-closed

- `FabricEngine.execute()` 现在会验证每一个字典形式的 `TargetLease`。需要实时验证却没有 `target_probe` 时，返回 `target_lease_probe_unavailable`，不再静默执行。
- 不要求实时探测的租约仍检查过期时间与捕获指纹。
- 畸形 `OperationPlan` 不再炸穿 IPC，而是返回 `status=failed`、`verified=false`、`error=invalid_plan`。
- 定向验证：TargetLease/engine 相关 12 项通过（5.11 秒）；OperationPlan 相关 3 项通过（3.06 秒）；相应 Ruff 检查通过。

### 10.2 ComputerOperator 安全底座与 UI-TARS 动作协议

- UI-TARS 解析器同时支持归一化坐标与显式 `model_image_size` 的模型截图坐标；修复列表框坐标解析异常。
- `finished()` / `call_user()` 只作为控制意图，不能编译为可执行动作；click/type/scroll 等动作不能伪装成只读 effect。
- scroll 必须携带起点，避免在未知鼠标当前位置滚动；hotkey 同时接受 `CTRL A` 与 `CTRL+A`。
- 新增 `WindowsComputerOperatorBackend`：截图原子持久化、SHA-256 与尺寸回执、坐标严格限制在 `SurfaceGrant` 内；鼠标动作前以 `WindowFromPoint` 校验根 HWND，键盘动作前校验前台根 HWND；使用 `SendInput` Unicode 输入而不是剪贴板；拖拽与取消路径释放按键/鼠标；Win32 HWND 类型按 64 位正确声明。
- 后端以 `windows-native` 注册到常驻和一次性 Harness，观察文件进入运行时 `computer-observations`。
- 新增受控 UI-TARS 循环：每张截图最多执行一个动作，动作后必须取得新观察；`finished/call_user` 自然结束，没有 6 轮业务上限；相同像素上第三次重复同一动作转为 `stalled`，100 次仅为代码失控保险丝。
- 新增配置视觉网关适配器，复用现有 vision key/base URL/model；发送图像缩放后会把模型实际看到的尺寸带回解析器，避免用原窗口尺寸错误换算坐标。
- 每个动作强制绑定源 observation ID 与图像 SHA-256；执行前重拍像素变化则拒绝。租约先于截图验证；点击后界面延迟变化会在重新校验租约后做短暂复核，不会让模型盲点第二次。
- `FrameLease → SurfaceGrant` 会核对 HWND/PID、冻结帧哈希、表面边界与 TargetLease 期限。`ComputerTaskService` 以 `computer-agent` Harness row 常驻提供，但不是默认模型工具；调用方必须先明确授予最大 effect，避免通用点击绕过确认。
- 用户取消从视觉模型、Guarded seam 与 Windows backend 原样上抛；所有终止路径调用 abort 释放可能遗留的按键。
- 定向验证：ComputerOperator、Windows backend、UI-TARS loop/model、ComputerTaskService 与 Harness 合并 51 项通过（1.51 秒）；相关生产 Ruff 通过。
- 真实边界：代码闭环和 Harness 服务已完成，但尚未由 GUI 的确认流程发起，也未用真实视觉端点在多应用桌面跑任务；因此不能宣称 Computer Use 已完成产品验收。通用任意点击工具仍未暴露给主 Agent，这是有意的权限边界。

### 10.3 工具契约、上下文边界与 TOCTOU 修复

- ToolRegistry 从顶层浅校验升级为有界递归 JSON Schema 子集：嵌套 object/array、required、additionalProperties、enum/const、字符串和数值边界、`anyOf`/`oneOf`/`allOf`；限制深度 32、节点 10,000、错误 64，并拒绝 NaN/Infinity。
- 工具结果进入日志和模型前统一限制为 64,000 字符；保留头尾、原始字符数和 SHA-256。hook 追加内容后再次限制，保证“模型可见即已记录”且 hook 不能绕过预算。
- 修复 PreToolUse TOCTOU：hook 修改参数后重新做 schema 校验；前置条件使用最终参数；执行前再次检查取消；动态资源 key 被 hook 改变时拒绝执行，避免调度器锁住 A、实际操作 B。
- 本地 `$ref` 支持 `#/$defs/...` 与 RFC 6901 token；外部、缺失和循环引用 fail-closed。
- 定向验证：ToolRegistry 全套 58 项通过（0.28 秒）；结果截断 2 项通过（0.34 秒）；hook 后重限 4 项通过（0.36 秒）；TOCTOU 相关 4 项通过（0.36 秒）。
- MCP 工具默认仍按 `EXTERNAL_SEND` 权限 fail-closed；完整 JSON Schema 方言不是本项目目标，当前实现是有边界的安全子集。

### 10.4 插件卸载的在途一致性

- SurfaceAdapter 的 scoped 注册现在由 owner wrapper 持有 `Context.work()`；卸载会等待在途 resolve，且不会让旧 disposer 删除热重载后的新注册。
- pre/post hooks 与 system-prompt section render 同样进入插件工作计数；插件卸载等待在途 callback/render 完成。
- Context 的 emit/waterfall/parallel/serial 在整个派发期间持有工作租约；并行 listener 若尝试卸载自己的 dispatch context 会立即报错，不再形成“listener 等 dispatch、dispatch 等 listener”的死锁。
- 定向验证：SurfaceAdapter 11 项通过（0.56 秒）；hook 6 项通过（0.29 秒）；hook+prompt 7 项通过（0.37 秒）；Context 全套 32 项通过（0.37 秒）。

### 10.5 已审计但本批未改动

- Hermes 风格自进化链路并非死代码：selection bridge 会准备 learning review；后台只能写 pending candidate；apply 必须 `approved_by=user`、旧哈希匹配、目标位于用户 learning/skills/plugins 根目录，拒绝 reparse ancestor，并提供备份与回滚。
- MCP stdio 请求不是只依赖合作式取消：reader 在线程中受 deadline 约束。响应单行限制为 2,000,000 字符；越界或超时会立即 kill 并丢弃连接，不再额外等待 2 秒 close grace period。MCP 相关 8 项通过（0.40 秒）。

### 10.6 本批验证事实与未完成边界

- 所有本批触及的生产 Python 文件完成一次 `py_compile`，1.1 秒通过。
- 每个生产修复均先看见对应失败，再修改实现；只运行了秒级定向回归，没有运行全量 Python、Node、typecheck、build、安装版或实时 GUI 截图验收。
- 工作树包含大量此前/用户已有的修改与历史测试删除，本批没有恢复、删除、提交或覆盖它们。
- 下一阶段仍需：逐文件审计 dirty tree；让 GUI 的显式批准入口调用 `ComputerTaskService`；用真实视觉端点完成多应用 Computer Use 回归；继续真实 SurfaceAdapter/ActionLease 场景；后端稳定后再做完整 GUI 重构与真实桌面验收。
- 只有后端停止变动且完成 fresh 全量验证后，才统一升级一次版本、执行 `npm run sync`、核对安装目录版本并更新 `docs/STATUS.md`。

## 11. 2026-08-14 Agent/插件/自进化续审（秒级定向验证，未交付）

### 11.1 正常 Agent 行为与协议合法性

- `LoopParams` 公开 seam 新增集中校验：非法 permission mode、零/负保险丝、工具/并发上限、
  预算续期、上下文预算、非 `Effect` allowed_effects、缺失/非法 FULL_ANSWER budget 均在任何
  模型调用或 session 写入前拒绝；direct caller 的默认 clock 从秒修正为毫秒。
- Provider adapter 抛异常不会炸穿 Agent；重试和 streaming fallback 共用原请求截止时间，
  不能每次再拿一整份 timeout；子秒剩余 HTTP budget 不再被扩大为 1 秒。
- HTTP 200 空响应转 `backend_error:empty_response` 在请求层有限重试，不再返回空白完成。
- provider tool-call id 原样保留；缺失、重复、控制字符或超长 id 生成会话唯一 `mp_call_*`。
  多工具截断为每个 call 生成对应失效 tool result；Anthropic error tool_result 显式
  `is_error:true`，OpenAI/Anthropic 第二轮消息均保持原生合法结构。
- EventSession crash repair 只扫描当前 open turn，并按调用出现次序匹配 call/result；旧轮或同轮
  重复 `call_0` 不再误判当前调用已完成。

### 11.2 插件、Hook 与执行授权

- MCP provider 有 per-server cooldown：失败 server 可在同一 resident host 内重试，成功 server
  不重启，恢复后 warning 清除；请求超时/协议越界仍立即终止子进程。
- patch 的非对象 config/null、空 plugin、非布尔 disabled 单行忽略并 warning，不再拖垮 boot。
  插件只能挂入声明的 `scopes`；surface-only 不能由 patch 塞进 agent。每次依赖重激活拿独立的
  嵌套 config，插件私自修改不会污染默认值或后续 request。
- PreToolUse 嵌套输入完全脱离原调用，不能用原地修改掩盖 resource key 变化；PostToolUse block
  进入 loop，返回非重试 permission error，同时如实说明动作已经执行。
- Python 真值漏洞修复：只有 JSON boolean `true` 能确认动作，字符串 `"false"` 不能执行。
  Fabric 幂等键覆盖 risk/provider/完整 params；workflow receipt 的 planId/recipeId 必须与任务一致；
  并发首次启动只发布一个 plan signing key。

### 11.3 Hermes 式自进化的完整性和隐私

- candidate JSON 的 proposed/original content 在读取时重算 new/old hash；篡改候选不能 apply。
  rollback 前重算 backup hash；篡改备份不能覆盖当前文件。
- 已 rejected/applied/rolled_back 的 candidate 是不可覆盖的历史；相同提议再次出现获得新 ID。
- propose/apply/reject/rollback 共享跨线程、跨进程 mutation lock；并发决策严格一个赢家，审计
  不重复记录两个成功。
- review context 在外发模型前脱敏 API key、Bearer、token、password 和 private key；review
  result 文件名复用 session-id 白名单，`../` 无法逃出 reviews 目录。

### 11.4 本轮验证事实与诚实边界

- 所有上述生产修复均先运行对应失败测试再修改实现。最近生产静态检查覆盖
  `model_client/hooks/harness/self_evolution`，Ruff 全绿；模型协议、streaming、候选与 review
  组合定向回归 18 项通过，其余每个修复均有 1–34 项秒级相关回归。
- 没有运行全量 Python/Node/typecheck/build/sync，没有启动 Electron UI，没有升版本，没有提交。
  当前不能声称“零 bug”或“已交付”。
- 任意第三方 Python 工具若完全不合作取消，线程无法安全强杀；当前内置进程/HTTP/UIA 路径有
  自身硬 timeout，通用插件仍必须遵守 cancellation token/timeout 契约。让线程偷偷脱离会产生
  延迟点击等幽灵副作用，因此没有伪造“已超时结束”。

## 12. 2026-08-14 最后一批底层加固（本次交接停止点）

本节是本文件的最新事实，覆盖前文与其冲突的旧描述。用户要求额度不足后停止继续开发，因此
本批只记录已落地代码，不再启动测试、构建、Electron、安装或同步。

### 12.1 插件 Context 不再留下半注册状态

- `Context.provide()` 原先先写入 service，再同步通知 `service/<key>` 监听器；任意第三方监听器
  抛异常都会跳过依赖刷新，形成“`ctx.has()` 为真、依赖插件却没激活”的半状态。
- 现在内部 service 事件是提交后的生命周期通知：逐监听器隔离异常并写入 Python 日志，继续
  通知其他监听器和刷新 inject。普通公开 `emit()` 仍保持原来的 fail-fast 契约，没有被吞错。
- 对应 `tests/harness_context_test.py` 全文件：**33 passed / 0.30s**。

### 12.2 常驻 Harness host 的失败回收与可重试关闭

- `HarnessRuntimeHost.open_scope()` 在创建 child 后若 `boot()` 抛错，调用方拿不到 scope，旧实现
  也不会卸载 child。现在启动异常会先完整 `unload()` 部分挂载树，再原样抛出错误。
- `RuntimeScope.close()` 和 `HarnessRuntimeHost.close()` 原先在真正卸载前就写 `_closed=True`；若
  Context 因“当前线程仍持有自己的 active work”拒绝卸载，后续重试会被错误短路。现在只在
  `unload()` 成功后提交关闭状态，失败可安全重试。
- 对应 `tests/harness_runtime_host_test.py` 全文件：**7 passed / 0.31s**。

### 12.3 模型截止时间与不可信 usage 元数据

- `LoopModelClient` 在剩余预算恰好为 0ms 时不再进入 provider、也不再由 HTTP 层强行扩成
  50ms 请求；直接返回 `backend_error:model_request_timeout`，避免预算后拖尾或多打一枪。
- provider 返回的 `NaN`、`Infinity`、`-Infinity` token usage 不再执行 `int()` 或进入 JSONL；
  聚合层和 session 落盘层都只接受有限数值。非法计费元数据不能再杀死一条有效回答。
- 模型重试/截止时间定向回归：**4 passed**；usage 聚合用例通过；session usage 落盘用例：
  **1 passed**（系统 `%TEMP%` ACL 拒绝后，使用仓库内全新 `--basetemp` 验证）。

### 12.4 EventSession 的深快照不变量

- `derive_messages()` 过去只复制 list；冻结的 `AgentMessage` 内仍含可变的嵌套
  `tool_calls[].arguments`。模型适配器或调用方可原地修改它，导致内存 surface 偏离磁盘事件。
  现在返回完整深快照。
- `events` 属性同样不再暴露内部 `SessionEvent.data` 字典，外部修改公开快照不会篡改当前进程
  的 hash-chain 状态。
- 深快照、公开事件隔离、非有限 usage 三项定向回归：**3 passed / 0.36s**。

### 12.5 本批实际改动文件

```text
app/harness/context.py
app/harness/runtime_host.py
app/agent_runtime/model_client.py
app/agent_runtime/loop.py
app/agent_runtime/session.py
tests/harness_context_test.py
tests/harness_runtime_host_test.py
tests/agent_runtime_loop_test.py
tests/agent_runtime_session_test.py
docs/2026-08-14-HARNESS_RECONSTRUCTION_PROGRESS.md
docs/2026-08-14-MASTER_HANDOFF.md
```

### 12.6 停止点、未执行事项与下一步

- 停止时刚开始审计生产入口 `selection_bridge -> LoopHarnessHost -> run_agent_turn`，只做了只读
  检查，尚未对这条入口追加修改。下一位应从 `app/harness/builtin_bundle.py` 的
  `LoopHarnessHost.open/_run_loop_rows` 与 `app/fabric/engine.py::run_agent_turn` 继续核对：GUI 每条
  普通任务是否都只进入这一套 event-sourced loop，是否还存在旁路旧 API。
- 尚未执行 fresh 全量 Python、Node、typecheck、lint、build、真实桌面截图回归；也未启动
  Electron、未 bump 版本、未 `npm run sync`、未核对安装目录、未提交。**当前仍是开发树，不能
  声称零 bug 或完成交付。**
- pytest 因系统临时目录 ACL 使用过以下仓库内新 basetemp，未做删除：
  `.test-tmp-session-finite/`、`.test-tmp-session-nested/`、
  `.test-tmp-session-nested-2/`、`.test-tmp-session-events/`、
  `.test-tmp-session-events-2/`。此前已有 `.test-tmp-agent-supervision/` 与
  `.test-tmp-agent-supervision-2/`；不要误当产品文件提交。
- 工作树原本就有大量用户/此前模型的 modified、deleted、untracked 文件。本批没有 reset、
  restore、clean、commit，也没有替用户判断历史删除是否应恢复；继续工作前必须先读 canonical
  design、`docs/STATUS.md` 和 `git status`，保留现有工作。
