# v4pro 审查（2026-08-13）

> 审查人：deepseek-v4-pro（单人通读，未开多 agent，未开计划模式）。
>
> **第二次审查（同日，Notepad 真机事故追加）**：用户实测"Notepad 打开 34,660 字 txt，划选未选中文本，问'这个文件里读到了啥。概况总结。'"→ 得到"摘要并路由：provider=agent.task"确认卡 + AgentGatewayError，文件内容从未进模型。真机取证后定位并修复三个根因，见文末 §7。
>
> **第三次审查（同日，架构判决追加）**：用户判决关键词+recipe 路由"从根本上不可扩展"。已研读 Claude Code 源码（模型即路由器：工具自描述 + ToolSearch 延迟加载 + per-input 权限，零关键词表），并据此落地：能力工具化（`capability_tools.py`，真实 schema，propose-only）+ 生产路由切 agent loop（`_loop_router`，L0 之外全走模型）+ 感知/look/本地动作全部工具化 + 系统提示词。细节见 `docs/harness-port-notes/2026-08-13-cc-tool-architecture.md` 与 §8。
> 范围：`app/`（148 个 Python 文件，约 1.39MB）、`electron/`（76 个 TS 文件，约 0.99MB）、`scripts/` 关键桥与 worker、`data/recipes/builtin.recipes.json`（39 条）、以及 agent swarm 未提交的新模块（`app/failure_flow/`、`app/telemetry/`、`app/permissions/capability_matrix.py`、`app/events/`、`app/agent_runtime/`、`app/action_guard/`、`app/anchor/`、`app/governance/`、`app/evidence/`、`app/replay/`）和未提交的 `app/fabric/intent_router.py` 修改。
> 依据：`docs/design/MAGIC_POINTER_HARNESS_20260811.md`（源真值）、`docs/STATUS.md`、`docs/harness-gap-review-20260812.md` 对应的实现。
> 未修改任何生产代码，仅产出本文件。agent swarm 的工作区修改（未提交文件）已保留原样。
> 已核对真机的 Python/Node 全量测试不在本次范围内；下列问题均为代码通读所得，标注【未复现】的需要本地跑一条命令确认。
>
> **修复进展（2026-08-13 同一会话内）**：§1 全部、§2 除 2.7 合并进 1.7 外的全部、§3 除 3.9/3.12 外全部已 TDD 修复并转绿；每个已修条目行尾加 ✅。未修条目保持原样。

---

## 0. 总体结论

设计账本声称的进度基本属实：Phase A FrameLease 链路（arm→commit→fail-closed 消费）确实存在且方向正确；L1/L2/L3-L8/L9-L16 的独立模块质量整体高于旧代码。但存在 **1 个时钟单位级 bug 使预算/熔断路径在生产中失效**、**2 个并发竞态会使"下一笔手势被上一笔的提交尾巴打穿"**、**1 个全局健康文件跨端点/跨进程污染导致文本模型被视觉配置连坐**，以及若干数据契约漂移与语义缝隙。建议按 §1 优先级修复后再继续批次 3 接线。

---

## 1. 高危（P0）：会导致错误行为或安全/预算机制失效

### 1.1 时钟单位错位 ✅

**位置**：`app/agent_runtime/loop.py:262-263, 281-283`；`app/fabric/engine.py:927`（默认 clock=`time.monotonic`）；`app/governance/latency_budget.py:73-77`（FULL_ANSWER=4000ms）。

**问题**：
- `run_agent_turn` 的默认时钟是 `time.monotonic`，它返回**秒**（浮点）。`loop.py` 把差值存进 `elapsed_ms`，直接与 4000 的 `budget_ms` 比较。
- 结果一：`check_budget` 在生产中要 4000 **秒**（约 66 分钟）才判定超预算——`BUDGET_EXHAUSTED` 终止分支实际上不可达。
- 结果二：`remaining_ms = budget_ms - elapsed_ms` 一开始是 ~4000（碰巧正确），但之后每秒只减 1——传给 `client.generate_turn(budget_ms=remaining_ms)` 的每轮模型预算不会随时间真实收缩，长任务无法被墙钟时间掐断。
- 为什么测试没抓到：`tests/engine_loop_backcompat_test.py:95-102` 的 `FakeClock` 返回的是**毫秒**，注入后一切正常；没有任何测试用"秒制时钟"覆盖默认路径。

**怎么改**（三选一，推荐第一种）：
1. 在 `engine.run_agent_turn` 里默认传入毫秒钟：`clock = clock or (lambda: time.monotonic() * 1000.0)`，并在 docstring 中写明"clock 必须返回毫秒"。
2. 或在 `loop.py` 内统一换算：`start_ms = clock() * 1000.0`（但会破坏注入 ms 时钟的既有测试，不如 1）。
3. 补一条回归测试：`run_agent_turn(..., clock=time.monotonic)` 场景下，慢工具仍应触发 `BUDGET_EXHAUSTED`（用 `time.sleep` 真实耗时可置短预算表注入）。

### 1.2 commit 尾巴竞态 ✅

**位置**：`electron/capture_commit_coordinator.ts:96-128`（`complete()` 的 await 之后不复查身份）。

**问题**（时序）：
1. 手势 A pointerup，`complete()` 进入 `committing`，`await provider.commit()`（GDI 后端约 200ms）挂起。
2. 期间用户立刻开始手势 B：`armSelectionGesture` → `coordinator.arm()` → 因为状态是 `committing`，先 `await this.cancel()`（只置 `cancelledDuringCommit=true`），随后 **B 把状态改成 `armed`、写入新的 `armedRequest`、并把 `cancelledDuringCommit` 重置为 false**。
3. A 的 commit 返回，`complete()` 尾部继续执行：
   - `if (this.state === 'committing')` 为假（已变 `armed`）→ 跳过状态更新；
   - **`releaseOverlay()` 把 B 正在画的手势 overlay 隐藏掉**；
   - `activeToken=null; armedRequest=null` → **B 的 armed 请求被清空**，B 的 pointerup 将抛 `frame_commit_not_armed`；
   - `cancelledDuringCommit` 已被 B 重置为 false → **`beginSession(手势A, leaseA)` 照常执行**，打开一个过期会话。

净效果：B 被杀，A 的过期会话被打开，overlay 在 B 绘画中途消失。

**怎么改**：
- `complete()` 在入口处把 `const token = this.activeToken` 快照下来；`await provider.commit()` 之后，在执行 `releaseOverlay`/清空/`beginSession` 之前复查 `this.state === 'committing' && this.activeToken === token`，不满足就丢弃结果（仅记录日志），不做任何副作用。
- `arm()` 在状态为 `committing` 时不应重置 `cancelledDuringCommit`（或改为等待旧 complete 落定再 arm，若产品上允许 arm 期间等待 ~200ms）。
- 补测试：注入一个延迟 resolve 的 `provider.commit`，在 commit 挂起期间调用 `arm()` 两次，断言第二次 arm 的 `armedRequest` 不被清空、`beginSession` 不携带旧 gesture。

### 1.3 同源竞态在 main.ts 层 ✅

**位置**：`electron/main.ts:2504-2513`；`pendingFrameLease` 定义处（`main.ts` 顶部，`getCaptureCommitCoordinator` 的 `beginSession` 回调 `main.ts:2280-2285`）。

**问题**：
- `completeSelectionGesture(...).then(() => { cancelSelectionGesture('completed'); ... beginSelectionSession(reason, gesture, lease); })` 里没有检查"此刻的 `selectionGestureArm` 还是不是这笔手势的 arm"。若手势 A 的 commit resolve 时用户已 arm 了手势 B，`cancelSelectionGesture('completed')` 会**取消 B 的 arm**（它按"当前 arm"行动，不校验 token），并用 A 的 lease 开会话。
- 即使 1.2 修好，`pendingFrameLease` 仍是无 token 关联的全局槽：coordinator 的 `beginSession` 回调只把 lease 塞进这个全局变量，`.then()` 里再取。连续两笔手势的提交交错时，`.then(A)` 可能消费到 B 的 lease（或反之），FrameLease 与手势错配——这直接违反"FrameLease 是历史事实、不可错配"的验收原则。

**怎么改**：
- 让 coordinator 的 `complete()` **resolve 出 lease 本身**（`beginSession` 回调改为返回值），`main.ts` 写 `const lease = await getCaptureCommitCoordinator().complete(gesture)`，删掉全局 `pendingFrameLease`。
- `.then()`（或 await 之后）先查 `selectionGestureArm?.token === arm.token` 再 `cancelSelectionGesture('completed')` 和 `beginSelectionSession`；token 不匹配时只记日志、清理 lease 产物，不动新 arm。
- 补 Electron 单元测试（coordinator 已有测试文件的模式）：延迟 commit + 新 arm，断言新 arm 存活且无过期会话。

### 1.4 全局模型健康文件跨端点/跨进程连坐 ✅

**位置**：`app/model_health.py:123-128, 163-178, 214-250`；`app/ai_client.py:655-663, 678-683`（`ask_vision_model` 与 `short_circuit_message`）；`app/ai_client.py:412-414, 553-555`（文本路径同样先查 `short_circuit_message`）。

**问题**：
- `ask_vision_model` 发现视觉模型是纯文本模型时调用 `record_failure(status=None, exception_name="vision_model_text_only")` → `state_for_status(None, ...)` 落成 **`unreachable`** → 熔断打开 20 秒。
- 于是：一个纯"本地策略拒绝"（根本不是网络故障）把**整个网关**标记为不可达；紧接着的 `ask_text_model` / `ask_text_model_with_tools`（agent loop 的后端）全部被 `short_circuit_message` 短路，用户看到"连不上模型端点"。
- 更糟的是健康文件不区分 base_url：视觉走 Gemini 端点（`vision_base_url.txt`），文本走 OpenCode Go（`openai_base_url.txt`）。一个端点失败会把另一个端点也熔断；多个 bridge 进程并发写同一个 JSON（成功方 `record_success` 会立刻把别人的失败结论冲掉），结论乱飞。
- `state_for_status(400)` 落到 `server_error`，文案说"端点正在报错（5xx）"——400 不是 5xx，误导。

**怎么改**：
- 健康键增加 `endpoint`（base_url）维度：文件按 `base_url` 存一份健康表，`short_circuit_message(base_url)` 只查自己端点。
- 视觉能力分类拒绝（`classify_vision_capability() is False`）**不要写健康文件**（它是配置问题，不是网关问题）；改为直接返回那句"纯文本模型"提示，或写入一个独立字段 `vision_text_only`，绝不复用 `unreachable`。
- `record_failure` 增加"半开探测"上限：熔断期间至多放行 1 个探针请求，避免 N 个 bridge 同时再打。
- `state_for_status` 补 400/422 单独文案，与 5xx 区分。

### 1.5 冻结帧里画着自己的划选墨水 ⚠️（机制已在、验证未做）

**位置**：`electron/main.ts:2335`（arm 时 `overlayExcluded: true`）；`scripts/frame_capture_worker.py:309`（落盘时原样写回 `overlayExcluded`）；`electron/main.ts:2500-2513`（先 commit 后 `hideOverlay`）；`scripts/selection_snapshot_bridge.py`（OCR/视觉消费该帧）。

**问题（复核更正）**：
- 复核发现 `electron/main.ts` 已对 overlay 与 stage 窗口调用 `setContentProtection(true)`（静态测试 `frame_lease_main_wiring_test.ts` 锁定），即已挂 WDA_EXCLUDEFROMCAPTURE 排除机制——我最初写的"没有排除机制"不准确。
- 但"机制已挂"不等于"排除生效"：`overlayExcluded` 仍是无条件写入 lease 的声明，没有任何运行时验证（本机 GPU/驱动上 GDI 是否真的把 overlay 排除在外未测）。若排除不生效，冻结帧仍含自己画的墨水，且证据链撒谎。

**怎么改**（状态：机制已在，剩余验证）：
- 真机/脚本验证：用测试后端抓两张帧（overlay 显示前后）diff，确认排除生效；验证通过前把 `overlayExcluded` 改为"验证结果驱动"（或加 `overlayContaminated` 标记），并把账本"未验证"升级为"阻塞生产化验收项"。

---

## 2. 中危（P1）：契约漂移、数据正确性与可靠性质疑

### 2.1 `capturedAtMonotonicMs` 存的是秒 ✅

**位置**：`scripts/frame_capture_worker.py:294`（`"capturedAtMonotonicMs": captured_at`，`captured_at = self._clock.monotonic()` 即秒）；`scripts/frame_lease.py:27,142`；`electron/frame_lease.ts:34,164`。

**问题**：字段名是 Ms、设计契约是 QPC bigint，实际值是**本进程 `time.monotonic()` 秒**。两端校验器只查"非负有限数"，不查单位，所以错误值畅通无阻。任何按 ms 解释它的消费方（排序、延迟计算）都会错 1000 倍；而且单调时钟原点各进程不同，Electron 拿这个值和自己时钟比毫无意义。

**怎么改**：
- 要么改名/改语义为 `capturedAtMonotonicS`（同步改 TS 与 Python 契约、设计文档 §5.2），要么改成毫秒整数并在两校验器中增加"整数、≥ 0、量级合理（< 1e9）"的单位级校验。
- 真正有用的跨进程时间已经在 `capturedAtUtc` 里；`captureLatencyMs` 才是 worker 内的延迟。建议把 `capturedAtMonotonicMs` 降级为纯诊断字段并在注释中说明"仅本进程内可比"。

### 2.2 commit 选帧语义 ✅

**位置**：`scripts/frame_capture_worker.py:254-263`（`_capture_once_locked` 先记时后 grab）、`211-234`（`commit` 用 `entry[0] <= commit_time` 过滤）。

**问题**：ImageGrab 单次约 200ms（本机实测 p50 192ms）。一帧若在 pointerup 前 1ms 开始抓取、200ms 后完成，它的 `captured_at` ≤ `commit_time`，会被选为"冻结帧"——内容是 pointerup **之后** 200ms 的屏幕（用户可能已切屏）。与"历史像素"承诺相悖。

**怎么改**：把 `captured_at` 改为抓取**完成**时间（grab 返回后再取 `self._clock.monotonic()`），或者按完成时间过滤 `entry[1] <= commit_time`。同时把"抓取中帧"的情况在 lease 上诚实标注。配合 §1.5 的排除机制改造时一并处理。

### 2.3 `commit()` 在锁内 join 抓取线程 ✅

**位置**：`scripts/frame_capture_worker.py:265-270`（`_stop_epoch_locked` 持锁调用 `thread.join(timeout=1.0)`）。

**问题**：抓取线程每次迭代要拿同一把锁，`join` 持锁等待意味着 commit/cancel/arm 都会被拖住到线程退出为止；若 ImageGrab 恰好在慢盘/锁屏态卡住，pointerup→commit 路径直接吃满 1 秒。这是 p95 ≤ 30ms 目标的隐蔽敌人（当前基准 192ms 里未必包含它）。

**怎么改**：拆锁——`_stop_epoch_locked` 先置 `_stop`、记录 thread 引用、**释放锁后再 join**（join 的目标线程退出并不依赖持有这把锁，因为循环在拿到锁后会先检查 `_stop`）。加一个"commit 等待抓取中帧的最长时长"参数并上报超时事件。

### 2.4 `run_agent_turn` 直接丢弃 `LocalActionCandidate` ✅

**位置**：`app/fabric/engine.py:906-914`（只取第一个 `TrajectoryCandidate`）；`app/fabric/intent_router.py:578`（`local_candidates + candidates`，本地动作排在最前）。

**问题**：`route_to_trajectory` 明确把 `save_screenshot` / `copy_object_text` / `show_source` 作为第一类候选返回（P1-4 修复的成果），但 `run_agent_turn` 用 `isinstance(candidate, TrajectoryCandidate)` 把 `LocalActionCandidate` 全跳过。于是 loop 路径下"截图"会掉进自由循环让模型自由发挥，而不是执行本地截图；旧路径 `IntentRouter.route` 里同样的词却能命中 `ACT_LOCAL`。当前生产还没接 `run_agent_turn`（账本已注明"未接线"），所以是**接线前的定时炸弹**。

**怎么改**：`run_agent_turn` 在取 trajectory 之前先处理本地候选——由于 `Terminal` 契约没有本地动作通道，建议给 `Terminal` 增加可选 `local_action` 字段（或直接返回一个预先构造的、带 `LocalActionCandidate` 的 Terminal），由调用方（bridge）执行 `copy_object_text`/`save_screenshot`/`show_source`；并在 `engine_loop_backcompat_test.py` 加"截图"输入的单测，断言本地动作被返回而不是跑自由循环。

### 2.5 恢复提示消息 `role=user + origin=data` 与 `validate_messages` 自相矛盾 ✅

**位置**：`app/agent_runtime/loop.py:348-358, 392-399`（构造 `Role.USER` + `origin=ORIGIN_DATA` 的恢复/后端错误消息）；`loop.py:733-750`（`validate_messages` 恰好禁止这个组合）。

**问题**：账本把这条登记为"已知间隙（文档化）"，但现状是**同仓库同模块里一个函数生成的消息会被另一个函数拒绝**。任何未来把 `validate_messages` 接进发送前校验的改动都会立刻炸掉恢复路径；`instruction_messages` 也会把注入的恢复消息漏进来（它只按 origin 过滤，恢复消息是 data 所以没问题——但谁都没保证过调用方不误用）。

**怎么改**：二选一并写进契约：a) 恢复消息改用 `Role.TOOL`/专用 role 并在模型客户端里映射成 user 语义；b) 保留 `role=user`，但给 `AgentMessage` 增加显式的 `kind: 'recovery'` 字段，`validate_messages` 对 `kind=recovery` 白名单放行。无论哪种，先补测试锁定"loop 产出的消息序列永远能通过 `validate_messages`"。

### 2.6 `compile_extra_entry` 承诺"never raises" ✅

**位置**：`app/agent_runtime/recipe_cache.py:186-191`（`"external_send" in {risk, provider}`）、`155-172`（`compile_extra_entry` 无 try/except）；调用点 `app/fabric/intent_router.py:543-568`。

**问题**：builtin 清单里 `risk` 都是单字符串（已核实 39 条），但 `extra_recipes`（插件/指令库接口，P1-5 新增）不受此约束。`{"risk": ["external_send"]}` 这类条目能通过 `_REQUIRED_FIELDS` 的 truthy 检查，然后在集合字面量里因 list 不可哈希抛 `TypeError`，直接炸掉 `route_to_trajectory`——与 docstring "never raises" 矛盾，也让一次插件配置错误击穿整个路由。

**怎么改**：把判断改成字符串化安全版本：`risk_tags = {str(risk)} | set(str(s) for s in strategies) | {str(provider)}`，再 `"external_send" in risk_tags`；`compile_extra_entry` 整体包 try/except 返回 None 并记录到 `self.errors`。补一条"risk 为列表的插件条目"测试。

### 2.7 `_manifest_keywords` 读私有字段 ✅

**位置**：`app/fabric/intent_router.py:428-450`（访问 `compiler._raw_by_id`、假设 `{"keywords": {"zh": [...], "en": [...]}}`）。

**问题**：跨模块私有字段耦合，任何 recipe_cache 重命名都让"匹配到了但说不清为什么"（score 来自 `match_keywords`，关键词列表来自另一处私有读取，二者可能漂移）。没有测试锁住"两个来源必须一致"。

**怎么改**：在 `TrajectoryCompiler` 上加一个公开方法 `matched_keywords(recipe_id, text, lang)`（同一份 `_raw_by_id` 内部实现打分+命中，保证同源），intent_router 只调公开接口；删掉 `_manifest_keywords`。加一致性测试：`match_keywords` 得分 > 0 时 `matched_keywords` 非空。

### 2.8 全局健康状态多进程写竞争 + 单进程多 endpoint 无法表达 ✅

（同 §1.4 的根因，这里列补充点）

**位置**：`app/model_health.py:202-211`（tmp+replace 是原子的，但"读-改-写"不是；没有 per-endpoint key）。

**问题**：`record_success`（任意一次成功）与 `record_failure`（任意一次失败）互冲，多个 bridge worker 并发时最终文件是随机一方；健康结论因此不能作为审计依据。

**怎么改**：文件改成 `{"entries": {base_url: {...}, ...}}`；`short_circuit_message(base_url)` 只读自己的条目；`record_success` 只清自己条目的熔断。迁移时对旧单条文件做兼容读取。

### 2.9 尾沿节流没有定时器 ✅

**位置**：`app/events/subscription.py:136-148`（首事件只入 `_pending` 不投递）、`150-163`（`flush` 是唯一的外部兜底）。

**问题**：一次 `TextChanged` 之后若无后续同类事件，该事件会一直躺在 `_pending` 里；`unsubscribe` 直接丢弃。L9 的消费者（未来的缓存失效逻辑）若忘记周期 `flush`，单次文本变化就静默丢失——这是"事件驱动只失效缓存"设计下最不该丢的那一类事件。

**怎么改**：给订阅增加可选的后台定时 flush（`throttle_ms` 到期后投递 pending 事件），或把 `deliver` 语义改为"首事件立即投递、窗口内后续事件合并"（前缘+尾沿混合）。至少要在 `WindowSubscription` 文档与 consumer 契约里写明"必须定期 flush，否则丢事件"，并补一个"孤立事件在 flush 后能投递、不 flush 则不投递"的显式测试锁定语义。

### 2.10 能力提示目录 ✅

**位置**：`app/failure_flow/capability_hints.py:69-83`（三段完全相同的 `HintSpec`，含 `("拨号", "dial", ...)`）；`115-116`（`_available` 用 `spec.keyword in tool` 子串匹配）。

**问题**：
- 用户在**邮件/链接**上看到"拨号"，在**号码**上看到"打开链接/发邮件"——目录明显是复制粘贴出来的（测试 `failure_flow_hints_test.py:69-71` 把这三个类型断言成同一组动作，等于把 bug 固化成了规格）。
- `"open" in tool` 会命中 `opencode`、`openopened` 之类任何含 "open" 的工具名；`_make_hint` 对 trajectory id 的匹配也是子串（`"translate" in ...`），跨语言提示容易串线。

**怎么改**：
- 按目标类型重写目录：`url` → 打开/复制/翻译；`email` → 打开/回复草稿/抄送；`phone` → 拨号/发短信/存联系人。至少把"拨号"从 email/url 里删掉，并同步改测试。
- 关键词匹配改成 token 级（按 `.`、`_` 分词后相等）或前缀+词边界正则，避免子串串线。

### 2.11 `route_to_trajectory` 的 minObjects 门 ✅

**位置**：`app/fabric/intent_router.py:533, 560`。

**问题**：`objects=[]`（明确知道没有对象）与 `objects=None`（不知道）被同一处理——`0` 是假值，门直接跳过，`minObjects=2` 的 `table.merge` 在零对象时照样出候选（测试 `intent_router_trajectory_test.py:167-174` 固化了这个语义）。旧 `_deterministic` 同款写法，所以这是"旧病沿袭"不是新引入，但它会在 loop 接线的第一周制造"模型拿着零对象跑合并表格"的怪案。

**怎么改**：区分三态——`None` 跳过门；`[]` 按 0 计数过滤 `min_objects > 0` 的候选；`[...]` 正常比较。同步更新测试与 docstring（现 docstring 说"empty objects list skips the gate"，需要改成"empty list counts as zero objects"）。

---

## 3. 低危（P2）：健壮性、一致性与小错

### 3.1 worker 超时后补发的 cancel 响应 ✅

**位置**：`electron/frame_capture_worker_client.ts:192-206, 250-255`。

**问题**：请求超时后客户端删掉 pending 并补发一个 `cancel`；cancel 的响应回来时 pending 里没有对应 id，`_handleLine` emit `protocol-error`——纯噪音，但会污染上层对"协议坏掉"的监控信号。

**怎么改**：对"已知自己发起的 cancel 响应"维护一个忽略集合，或在 `_rpc` 超时分支里为 cancel 请求注册一个"吞掉结果"的 pending。

### 3.2 `commit` 成功后 `releaseOverlay` 若抛异常会吞掉 lease ✅

**位置**：`electron/capture_commit_coordinator.ts:116`。

**问题**：`this.releaseOverlay()` 无 try/except；若 `hideOverlay` 抛错（窗口销毁竞态），`complete()` 直接 reject，`main.ts` 走 `commit_failed` 路径——用户手势成功冻结却被告知失败。反向场景（失败时 release 成功）已有处理。

**怎么改**：`releaseOverlay` 单独 try/catch，异常记日志不改变 commit 结果；commit 成功与否只由 provider 结果决定。

### 3.3 `frame_capture_worker.py::arm` 未校验边界 ✅

**位置**：`scripts/frame_capture_worker.py:178-179, 188`。

**问题**：`("surfaceBoundsPx 必须正面积")` 的校验发生在 `scripts/frame_lease.py` 的**落盘归一化**里，而不是 `arm` 时；arm 阶段 `[100, 100, 50, 50]` 这类反方向框会让 `ImageGrab` 抛错直到 commit 才暴露。`int(value)` 截断浮点（0.9→0）没有舍入/拒绝。

**怎么改**：`arm` 时即校验 `right>left, bottom>top` 且四元均可转整数，非法直接 `invalid_arm`；浮点用 `round()` 或拒绝非整数。

### 3.4 `_execute_one` 的 `scope` 关键字与工具输入 schema 中的 `scope` 参数冲突 ✅

**位置**：`app/agent_runtime/tool_registry.py:285-289`。

**问题**：`spec.execute(scope=scope, **args)`——若某工具 schema 恰好声明了名为 `scope` 的输入参数（未来完全可能，比如"搜索范围"），会 `TypeError: multiple values for keyword 'scope'`，被包装成 TOOL_ERROR，工具永远不可用。

**怎么改**：注册时校验保留关键字集合（`{"scope"}`）与 input_schema 的 properties 不相交；或改用位置参数 `spec.execute(scope, **args)`。

### 3.5 `validate_messages` 在 loop 中没有任何调用点 ✅

**位置**：`app/agent_runtime/loop.py`（定义了 `validate_messages`，但整个 loop 没有一次调用）。

**问题**：L7 注入隔离的"断言"是死代码。当前唯一入口是人工构造，等于没有防线。账本没有明确登记这条（只登记了恢复消息间隙）。

**怎么改**：在每轮 `with_transition` 前对即将送入模型的消息列表调用 `validate_messages`（配合 §2.5 的恢复消息修复），并在测试里断言非法组合会被循环内部拒绝而非只在独立单测里拒绝。

### 3.6 容器启发式只做整串相等 ✅

**位置**：`app/evidence/contract.py:140-144`（`stripped not in set(container_like_texts)`）；`app/agent_runtime/perception_tools.py:104-112`（`read_around` 先 join 多行再送检）。

**问题**：`read_around` 把多行 `"Window\nPane\nEdit"` join 后，与任何单个容器名都不相等 → `ok`、confidence 1.0。L6 的"容器名不得冒充正文"对最常见的多行场景无效。

**怎么改**：启发式升级为"**每一**非空行都命中容器集合才降级"（并保留整串相等的快路径）；补一条多行纯容器名的测试。

### 3.7 `doctor_report._slug` ✅

**位置**：`app/telemetry/doctor_report.py:65-66`。

**问题**：`ch.isalnum()` 对中文字符返回 True，中文 label 会原样保留，只有空格/符号被替换成 `_`。两个"仅空格和符号不同"的 label（如 `"UIA 宿主"` 与 `"UIA-宿主"`）会得到同一个 `check_id`（都是 `uia_宿主`），后注册的检查覆盖先注册的，检查列表出现静默丢失。

**怎么改**：`check_id` 改为显式传入或加入 hash 后缀（`f"{_slug(label)}-{hashlib.sha1(label).hexdigest()[:6]}"`），保证唯一。

### 3.8 `_normalize` 之后 `_is_information_question` 里 `"？" in value` 是死判断 ✅

**位置**：`app/fabric/intent_router.py:199, 218-220`。

**问题**：`_normalize` 已把 `？` 替换为 `?`，随后的 `"？" in value` 恒为 False。无行为危害，但属于让人误读的死代码。

**怎么改**：删掉 `"？" in value` 分支。

### 3.9 `InstructionLibrary._save` 与 `record_success` 等小文件写操作用"读-改-写"，无进程间锁 ⚠️（部分缓解：健康文件已 per-endpoint 分条；学习库可接受丢失）

**位置**：`app/fabric/intent_router.py:272-280`；`app/model_health.py:202-211`。

**问题**：多 bridge 进程并发写同一 JSON 时互相覆盖（tmp+replace 只保证不写坏，不保证不丢更新）。学习库丢一次计数可接受，健康文件丢一次熔断结论不可接受（见 §1.4）。

**怎么改**：健康文件按 §2.8 改 per-endpoint 结构并接受"最终一致"；instruction-library 至少用 `os.replace` 前再读一次合并（或接受丢失，文档写明）。

### 3.10 `CapabilityMatrix.load` 不校验 `app` 字段 ✅

**位置**：`app/permissions/capability_matrix.py:130-141, 102-108`。

**问题**：`item["app"]` 可以是数字/null，进入 dict key 后序列化再加载类型就变了；`status_for` 每次新建 dict 无泄漏，但 `apps()` 排序混合类型（int/str）会在 Python 3 抛 TypeError。

**怎么改**：load 时 `app` 强制 `str` 且非空校验；`set` 时同样校验 `app` 非空字符串。

### 3.11 文案混杂中英文 + 标点不规范 ✅

**位置**：`app/action_guard/preconditions.py` 的 `ResolvedExact.check`、`ContentUnchanged.check` 等消息。

**问题**："resolution is ambiguous，需要用户确认；never act on an ambiguous target" 这类中英混杂句子会直接进模型可见的 tool 结果里，低质量文本喂给模型。

**怎么改**：统一成单一语言（模型提示全用英文，或全中文），去掉逗号混排。

### 3.12 `frame_capture_worker.py::main` 对超长行回 `id: None` ✅（客户端静默丢弃 null-id 行）

**位置**：`scripts/frame_capture_worker.py:345-351`；`electron/frame_capture_worker_client.ts:250-255`。

**问题**：超长/非法 JSON 行回包没有 id，TS 端 `candidate.id` 是 null→`''`→pending 查不到→protocol-error。对"响应坏行"其实应当带原始 id 才能对应上超时的请求。

**怎么改**：读行阶段无法安全解析时回 `{"id": null, "error": ...}` 保持契约；或 TS 端对 `id: null` 的错误行静默丢弃而非 protocol-error。

---

## 4. 使用/工程问题（不影响单次正确性，但会咬人）

### 4.1 文档账本与代码不一致处（审查时发现，非代码 bug）

- 设计 §5.2 的 `capturedAtQpc: bigint` 与实现的 `capturedAtMonotonicMs: number` 字段名/类型不一致（见 §2.1），账本从未登记这次偏离。
- `docs/STATUS.md` 开头的两段"一句话"互相矛盾（一条说"Python 1253 过 / Node 131"，下一条说"Python 1073 / Node 127"），且"一句话"段落有两条。合并成一条并注明最近一次全量验证日期。
- 账本 8·12 批注明"循环/工具接线完成"但 `docs/STATUS.md` 第一句仍写"下一步是评审批次 1"——两处进度口径不一致，新模型会被误导。

### 4.2 根目录散落 30+ 个 `.pytest-*` / `.tmp-*` 目录

**问题**：`.pytest-swarm-*`、`.tmp-pytest-*` 等大量临时目录留在仓库根目录（`git status` 干净是因为被 gitignore，但磁盘和文件树被污染），其中部分可能包含旧测试基线。审查时无法判断哪些还有用。

**怎么改**：确认无保留价值后统一清理，并在 AGENTS.md 增加"测试临时目录必须用系统 temp 或 basetemp，不得在仓库根目录落地"的规则。

### 4.3 `app/agent_runtime/tool_registry.py:43-67` 保留着 errors.py 的镜像 fallback ⏳（待删）

**问题**：`try/except ImportError` 的 fallback 在 `errors.py` 早已存在后成为死代码，两处 `FailureType` 定义存在漂移风险（新加类型只加一边）。文档说"一旦 errors.py 存在 import 优先"，但没人移除镜像。

**怎么改**：删除镜像 fallback，直接 `from app.agent_runtime.errors import ActionFailure, FailureType`（grep 确认无循环导入后）。

### 4.4 单元换算、枚举、坐标空间缺一处集中定义

**问题**：`ms` 与秒、物理像素与 DIP、monotonic 与 QPC 在 `loop.py`、`frame_capture_worker.py`、`main.ts`、`frame_lease.ts` 之间以裸数字和注释传递（§1.1、§2.1 都源于此）。设计文档强调"确定性状态不在模型里"，但确定性状态的**单位**也应当不在注释里。

**怎么改**：在 `electron/coordinate_space.ts` 与 Python 侧各建一个"单位命名约定"小节（`_ms` 后缀强制毫秒、`_s` 强制秒），CI 用 lint 规则或至少代码评审检查点约束。

---

## 5. 附：agent swarm 新代码的正面记录

以下模块质量良好，审查未发现阻断性问题（仅上述已列条目）：`app/action_guard/*`（批准黑名单、undo LIFO、egress 默认拒绝）、`app/anchor/*`（五路判别与降级链）、`app/governance/cancellation.py`（代际取消）、`app/replay/*`（严格 schema）、`app/evidence/contract.py`、`app/telemetry/pointerbench.py` 与 `interaction_ledger.py` 的诚实统计（None 与 0 区分、open 条目不进统计）、`scripts/frame_lease.py`/`electron/frame_lease.ts` 双端校验一致性、`selection_snapshot_bridge.py` 的 fail-closed 消费路径。

## 7. 第二次审查：Notepad"文件内容没进模型"事故（2026-08-13 当日）

**现象**（`history/conversations.json` 实锤）：问题"这个文件里读到了啥。概况总结。"（14 字）→ 回答"摘要并路由：已锁定 1 个对象，provider=agent.task。 请核对动作后确认。"，确认后 `AgentGatewayError`，多轮重试全失败。文件 34,660 字符，模型从未见过一个字。

**取证**（Notepad 窗口 hwnd 67130 当时仍开着）：
- UIA 探针：`No non-empty UI Automation text selection was exposed.`——用户在 Notepad 里**没有选中文本**，而探针只读选区；region 模式只返回菜单/标题/状态栏等控件名（"行 7，列 35 34,660 个字符"），不读文档正文。
- 冻结帧 OCR：Notepad 文档区被其他窗口（VS Code/Claude Code 终端）遮挡，像素兜底也拿不到正文 → 对象降级为 `screen` 屏幕对象。
- 路由：`IntentRouter.route("这个文件里读到了啥。概况总结。")` → `text.summarize_route`（本地写入 recipe，"把选区摘要写入草稿或笔记"）→ preview 确认卡。
- provider：`selection_bridge` 构造 `FabricEngine()` 未接 `model_transform` → `model.text` 回落 `agent.task` 外部 agent → AgentGatewayError。

**根因与修复（三项，全部 TDD + 真机验证）**：
1. **R1 路由** ✅：`_is_information_question` 增加疑问词（总结/概况/概括/读到了啥/讲了什么/啥意思）；`_QUESTION_ACTION_MARKERS` 删除裸"总结/summarize"、新增显式目的地词（放到/写入/发到/存到/保存到/记到）。"概况总结"→ ACT_MODEL（模型拿着 grounded 内容回答）；"总结成三点放到邮件"仍走 recipe。
2. **R2 grounding** ✅：`scripts/uia_selection_probe.cs` 新增 `TryDocumentTextFallback`——无选区时读 TextPattern `DocumentRange.GetText(65536)`，`result_kind="document_text"`，document 矩形作为选区证据；点在窗口外/被遮挡区域同样命中。adapter 映射 `uia:document-text`。**真机验证**：无选区 Notepad → 探针返回 34,660 字全文；`capture_snapshot(target_hwnd=67130)` → `hasContent=true / covers_mark=True / context 34660 字`（修复前 app=screen、零内容）。已重编译 `data/runtime/uia_selection_probe.exe`。
3. **R3 provider** ✅：`selection_bridge` 两处 `FabricEngine()` → `FabricEngine(model_transform=_local_model_transform)`（本地文本模型，18s 预算）——`model.text` recipe 不再回落外部 agent 网关。

**验证**：Python 2065 过（2 既有环境失败不变）；Node 131；typecheck 过。
**部署**：修复在开发树内；用户运行的打包构建需重新 `npm run build:electron`（及打包）后生效。

---

## 8. 第三次审查：关键词+recipe 路由退役（架构级修复）

**问题本质**（用户判决）：关键词表做意图路由 = 每加一个功能就要加关键词，长尾永远漏、"总结"这种词还会被写回 recipe 抢走（Notepad 事故的直接帮凶）；recipe 也不是目的地（设计文档自己写的"recipe 是 cache"），但生产路径一直把它当目的地。

**CC 源码结论**（`src/Tool.ts` / `src/query.ts` / `src/utils/toolSearch.ts` / `src/constants/prompts.ts`）：模型即路由器。工具自带真实 inputSchema、按输入动态 description、isReadOnly/isDestructive/isConcurrencySafe、checkPermissions、searchHint；规模治理靠 defer_loading + ToolSearch 按需发现；系统提示词 section 组合承载行为约束。**零关键词表。**

**落地（全部 TDD，Python 2072 / Node 131 / typecheck 绿）**：
1. `app/fabric/capability_tools.py`：recipe → 真实工具（真实参数 schema、诚实描述、"只生成方案"语义，READ effect），propose 走原 plan/confirm/receipt。
2. `AiClientMessagesBackend` 原生 system prompt。
3. `selection_bridge._loop_router` 成为生产路由：L0 保留（零模型快路径），其余全进 agent loop；感知工具接真实 grounding 后端、`look` 接真实视觉 + 冻结帧裁剪、copy/screenshot/show_source 工具化、首条消息注入 60k 证据块；失败自动回退旧链；`MAGIC_POINTER_LEGACY_ROUTER=1` 回滚开关。
4. 关键词路由代码保留为兼容层（legacy API + 测试冻结），生产决策不再经过它。

**剩余（诚实）**：~30 能力工具全量进 prompt（CC 的 defer+ToolSearch 是 T4 项）；loop 首条消息仍以文本携带证据（T4.2）；写回能力在 loop 内仍只 propose 不执行（T4.4 四道 guard 后放开）。

---

## 6. 修复优先级建议

> 状态更新：§1 全部、§2 全部、§3（除 3.9 仅部分缓解）已于同日 TDD 修复并全量验证（Python 2061 过 / 2 既有环境失败、Node 131、typecheck 过）；§4 的 4.1 设计账本已修订、4.3 待办、4.2/4.4 待办。

| 优先级 | 条目 | 理由 |
|---|---|---|
| 立即 | §1.1 时钟单位 | 预算/熔断在生产中全部失效 |
| 立即 | §1.4 健康文件跨端点连坐 | 用户会看到"模型挂了"的假故障 |
| 接线前必做 | §1.2 / §1.3 commit 竞态 | 接真机多笔手势前必现 |
| 生产化前 | §1.5 墨水入帧 | 冻结帧证据不可信 |
| 批次 3 前 | §2.1 / §2.2 / §2.3 | FrameLease 契约与选帧语义 |
| 接线时 | §2.4 本地动作被吞 | run_agent_turn 一旦接线就触发 |
| 顺手修 | §2.5–2.11, §3.x | 契约一致性与健壮性 |
