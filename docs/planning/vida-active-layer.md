# 主动层：Vida 拆解 → 本项目最小落地路径

> 2026-08-08。调研产物，不写产品代码。目标读者：接下来动手做"主动"的那个会话。
> 证据分级同 [PRODUCT.md](../PRODUCT.md)：**事实**＝有链接/文件可核；**推断**＝基于事实的判断。
> 对照基准：[Vida.md](../../Vida.md)（Vida 逐帧拆解 + 交接单）、[ROADMAP.md](../ROADMAP.md)（摩擦触发层已设计）、[ARCHITECTURE.md](../ARCHITECTURE.md)（模块地图）。
> 对齐 ROADMAP 的叙事：这不是"先砍后补"，是**依赖顺序**——先修地基（记忆写入端），再挂便宜的信号，最后才做需要新常驻组件的东西。

---

## 1. Vida 的"主动"到底由什么构成

把 Vida.md 里的证据摊开，"主动"不是单个能力，是**五块拼图**，缺一块体验就断：

| 拼图 | Vida 的实现 | 出处 |
|---|---|---|
| A. 事件源 | `mac-ax-watcher` 常驻订阅全局 AX 通知（窗口聚焦/值变化/标题变化/应用激活），一事件一行 JSON | Vida.md §4.1 |
| B. 记忆漏斗 | capture → Timeline（墙钟 1 分钟块，LLM 归一化）→ reducer（5 分钟 flush，退避 5/15/30/60/120）→ classifier → Markdown 记忆 + FTS + MCP 工具面。**≈1.2 M token/天，$5–45/月** | Vida.md §4.1 / §4.4 |
| C. 触发判断 | Tracker（`cron + recipe + 交付方式`：每日复盘/URL 日更/文件夹变更，免费档只给 1 个）+ Spark（摩擦触发层 + **第四个信号：收到一条被判定为"要你交东西"的通知**，演示里带紫辉光） | Vida.md §7.4 V6 / §3 用例 005 |
| D. 提案卡 | 不是通知，是**可预览可拒绝的卡**：预览渲染成结果的样子（文件夹图标/目录树/diff），Approve/Reject/重跑。铁律：同一提示一生只出现一次、可永久关闭、绝不打断输入焦点 | Vida.md §3-004 / §7.4 V6 |
| E. 交付 | 产物写进目标应用输入框，不是"已复制到剪贴板" | Vida.md §3-004 / §7.4 V5 |

**两条结构性结论**（Vida.md §4.3 / §8）：

1. **"主动"里唯一贵的部分是 B，而且 B 不是 agent 是 ETL**——四个 LLM 调用点三个是固定 prompt 单次调用，只有 classifier 是 tool-call loop。"主动为什么便宜"的钥匙：**提议本身不调模型，调模型的是记忆构建，且记忆构建是闲时的**。
2. Vida 全天捕获的成本（1.2M token/天）来自"一个工作日几百次捕获"的常驻监听（§4.1 去噪四旋钮）。**这是它的活法，不是我们的**——我们的事件源是用户动作（截图/复制/切换），天然稀疏。

## 2. 对照本项目：已有 / 缺失

### 2.1 已有（直接复用，别重造）

| 拼图 | 本项目已有 | 证据 |
|---|---|---|
| D 的引擎 | fabric `plan → commit → verify → undo`：签名 plan（HMAC）、`preview`（title/description/objectLabels/risk）、`requires_confirmation`、`idempotency_key` | `app/fabric/engine.py:415-663`（plan）、`:716-837`（execute） |
| D 的执行通道 | 模型已能回 `actionProposals`，主进程 `registerActionProposals`/`takePendingActionProposal` 缓存并交付执行，其中 `fabric_recipe_execute` 类型已有（`internal_action_policy.js:53-71` 判定 auto-execute） | `electron/main.js:479-525`、`electron/internal_action_policy.js` |
| D 的持久化 | `WorkflowTaskStore`：跨面任务门（幂等、approvalState `pending/approved`、executionState `idle/running/terminal`、claim 互斥）——Tracker 的"任务"落这里就行 | `app/fabric/workflow_task_store.py:173-207`（create）、`:233-245`（approve）、`:247-271`（claim） |
| A 的部分信号 | 前台窗口信息**已在主进程维护**（`pointerInputState.foregroundApp/hwnd/processId`，来自 `pointer_input_state.ps1` 的 `WH_MOUSE_LL` 轮询），`lastStableForegroundApp` 已去外壳（`isTransientShell`） | `electron/main.js:92-103, 401-424, 1364-1376`、`electron/stash_store.js:76-82` |
| A 的部分信号 | 剪贴板事件循环已有：`stash_runtime.js` 700ms 轮询 + 位图/文本指纹去重 + 成簇 + 来源归属 | `electron/stash_runtime.js:13, 202-224` |
| B 的存储 | `ScreenMemory`：recall API（时间窗 + 子串）+ 不存截图（有测试钉住）+ 上限裁剪 + `memory.recall` recipe 已 wiring 到 executor | `app/context_pack/screen_memory.py:110-143`（record）、`:149-171`（recall）、`app/fabric/executors.py:180-181, 343-370` |
| 摩擦触发层设计 | **ROADMAP P2 已设计**：连续两次截图→取字、两窗口来回切 3 次→合成给 agent、输入与屏幕重合→直接取；铁律已写（一生一次/可永久关闭/绝不打断输入焦点） | `docs/ROADMAP.md:51` |
| 隐私护栏 | `CapturePolicyEngine`、`target_lease`、截图默认不上传、红线"内部数据不进气泡" | `app/fabric/capture_policy.py`、`AGENT.md:26-36` |
| 设置 schema | `settings_store.js` 有 schema + 校验 + 持久化，`stash` 段已有先例 | `electron/settings_store.js:164-179` |

### 2.2 缺失（gap，按依赖顺序）

| # | 缺口 | 现状证据 | 后果 |
|---|---|---|---|
| G1 | **记忆没有写入端** | `ScreenMemory.record()` 全仓库**零调用**（grep：只有定义和 `executors.py:350-353` 的读取）；`context_pack/session.py` 的 record 是会话记账不是屏幕记忆 | 一切"我知道你在干什么"的主动都是空中楼阁；`memory.recall` recipe 永远回答"没找到" |
| G2 | **无事件源** | 全仓库 0 处 `SetWinEventHook` / `AddFocusChangedEventHandler` / `UserNotificationListener`（grep 无命中；Vida.md E1 结论仍然成立） | 只能靠轮询复用（stash 已有、前台状态已有），通知信号做不了 |
| G3 | **无触发器引擎** | 无 cron/scheduler、无窗口切换计数、无 once-store | 摩擦触发层只是文档，没有"判定 + 一生一次"的落地 |
| G4 | **无提案卡 UI** | ROADMAP 明说"引擎已是 plan→commit→verify→undo，缺的只是界面"；`card_render.js` 有 slot 卡渲染但无产出路径（STATUS.md 已知未修 2） | 主动层没有可预览可拒绝的形态，会退化成通知 = Clippy |
| G5 | **无时间线/会话聚合** | `screen_memory` 是平铺 entry 列表，无"这一天"的聚合视角 | 每日复盘类 tracker 没有数据源 |

### 2.3 关键事实核对（避免编造）

- `memory.recall` recipe **已接线**（`executors.py:180-181` 分发、`:343-370` 实现，空结果是真实回答不是失败）——但依赖 G1。
- `screen.recall` recipe 是 `unavailable:screen_history_not_wired`（`data/recipes/builtin.recipes.json`），**不要拿它当已有能力**。
- 提案卡不等于 `internal_action_policy` 的 actionProposals：前者是**主动提议**（无用户请求），后者是**用户请求后的执行确认**。共享通道（fabric plan + confirm），但触发完全不同。
- 本项目红线禁止装第三个 `WH_MOUSE_LL`（Vida.md §7.4），**MVP 的窗口切换检测必须复用现有 `pointerInputState` 轮询**，不得新增 hook。

## 3. 最小落地路径（MVP）

### 3.0 原则

- **提议 0 模型调用**。判定全确定性（规则 + 计数），只有用户 Approve 后才走 fabric plan（模型调用发生在执行时，且走现有 capture_policy 的截图上传门槛）。
- **先修地基 G1**。没有写入端的记忆，任何"主动"都不可信。
- **复用轮询，不新起常驻**。前台状态在 `main.js` 已有，剪贴板事件在 `stash_runtime.js` 已有——事件总线只是给它们加钩子。

### 3.1 组件清单

| # | 组件 | 形态 | 依赖 |
|---|---|---|---|
| C1 | `electron/proactive_events.js` 事件总线【新】 | 三个信号源接进来：① `pointerInputState` 前台变化（main.js:401-424 已有数据，加"hwnd 变化"事件）② `stash_runtime` 的 `onEntry` 回调（stash_runtime.js:22 已有钩子位）③ 定时器（setTimeout 最小 cron，**不加 node-cron 依赖**——nextDue 计算后 setTimeout，精度够） | 无 |
| C2 | `electron/proactive_rules.js` 规则引擎【新，纯函数】 | 每条规则 `{id, source, matcher, recipeId, minGapMs}`；输入事件流，输出 `TriggerVerdict {ruleId, recipeId, objects, previewText}`。规则见 §3.2 | C1 |
| C3 | `electron/proactive_once_store.js` 一生一次存储【新】 | 纯逻辑 + IO 分离（照 `stash_store.js`/`stash_runtime.js` 分法）：`{triggerId: {firstShownAt, dismissed, blockedForever}}`，同名规则带参数指纹；"永不再提示"写 `blockedForever`。**铁律落点** | 无 |
| C4 | 提案卡 UI【新，renderer】 | 非焦点卡：不抢焦点、不弹窗、挂在 Dashboard/companion 右下角；只显示 `preview.title/description/objectLabels` + Approve/Reject/永不再提示三键；Approve → `engine.execute(plan, confirmed=true)`（engine.py:716）；**内部数据（lease/fingerprint/Context Packet）不进卡**（AGENT.md 红线 4）；卡本身沿用 `setContentProtection` 不进截图 | C2/C3、D 通道 |
| C5 | 记忆写入端【改】 | `stash onEntry` + 前台变化时调 `ScreenMemory.record(app, windowTitle, excerpt)`；excerpt 取 focusProbe 的 selectionText / 剪贴板文本（截 400 字，screen_memory.py:38）；sensitive 沿用 capture_policy 的敏感应用名单 | C1、`screen_memory.py` |
| C6 | 设置 schema【改】 | `settings_store.js` 加 `proactive: {enabled: false, rules: {stash_ocr: true, window_merge: false, clipboard_linger: true}}`；**默认全关**（PRODUCT.md:94 "默认全关、同一提示一生只出现一次"） | — |

### 3.2 三个信号（全部来自 ROADMAP P2 已设计，成本几乎为零）

| 信号 | 判定（确定性） | 提案 | recipeId（已有） |
|---|---|---|---|
| **连续两次截图** | stash `onEntry` 收到 2 条同簇 image（stash_store.js:155-173 `assignBurst` 已有簇概念）且距上次提议 > 10 分钟 | "刚才截的图里好像有字，要直接取出来吗？" | `text.ocr_copy`（intent_router.py:56-60 有 L0 短语，plan 直走 recipe_id） |
| **剪贴板滞留** | stash tick 连续 3 次（约 2 秒+）读到同一文本指纹（stash_store.js:30-38 `textFingerprint`）且用户没有粘贴动作（无前台切换） | "这段字还在剪贴板里，要存进收藏箱吗？" | 无 recipe——走 `stash.ingestText` 本地动作，**0 模型调用** |
| **窗口来回切换** | 前台 hwnd 变化事件，10 分钟内 ≥3 次在两个窗口间交替 | "这两边的内容要合成一条给 agent 吗？" | `agent.handoff`（minObjects=1）或 `objects.compare`（minObjects=2）——MVP 标 **默认关**，因需要攒双窗口对象，复杂度最高 |

**明确不做（诚实部分）**：通知信号（UserNotificationListener）是 C# winrt 常驻组件，放 V2；"输入与屏幕重合"检测需要读取输入流，放 V2；Tracker 的每日复盘放 V2（依赖 G5 时间线）。

### 3.3 Tracker / Spark → 本项目的等价实现

| Vida | 本项目等价 | 复用点 |
|---|---|---|
| Tracker（`cron + recipe + 交付方式`） | C1 定时器（最小 cron）+ fabric `plan()`（engine.py:415）+ `WorkflowTaskStore.create/approve/claim`（workflow_task_store.py:173-271）+ 提案卡交付 | 任务持久化、幂等、跨面互斥全是现成的 |
| Spark（摩擦触发） | C2 规则纯函数 + C3 once_store + 提案卡 | ROADMAP P2 设计原样落地 |
| Spark 第四个信号（"要你交东西"的通知） | **V2**：UserNotificationListener（Windows 通知读取）。MVP 不写，因为全仓库没有任何通知监听，需要新的 C# 常驻组件 | — |
| 记忆漏斗（B） | **裁剪版**：C5 写入端 + 现有 `screen_memory`，不做 Timeline/reducer/classifier。理由见 §4 成本账 | `screen_memory.py` 原样 |

## 4. 成本账（参考 Vida.md §4.4 格式）

Vida 全天 1.2M token/天（Timeline 288 次 + reducer 96 + classifier 16）。本方案**提议 0 调用**，唯一有模型成本的是用户 Approve 后的 recipe 执行（那是现有产品的正常用量，不算增量）和 V2 每日复盘：

| 调用点 | 频次/天 | 单次输入 | 合计 | 说明 |
|---|---|---|---|---|
| 摩擦触发判定 | 0 | — | **0** | 纯规则，指纹/簇/计数全是本地 |
| 剪贴板滞留提议 | 0 | — | 0 | 本地 `ingestText` |
| 记忆写入 | 0 | — | 0 | 无 LLM，纯落盘 |
| 用户 Approve 后执行（OCR/改写/handoff） | ≤3 | 走现有 recipe | 现有用量 | 不算主动层增量 |
| V2 每日复盘（tracker） | 1 | ~2k token | **≈2k token/天** | 比 Vida 的 1.2M 便宜约 **600 倍**——因为我们是事件驱动（用户动作才记），不是常驻监听 |

**为什么能差 600 倍**（对应 Vida.md §4.4 的"漏斗"论）：Vida 必须全天捕获（它不知道用户何时开口），我们是**只在用户留痕的动作上记**（截图/复制/切换），稀疏性本身把成本压掉。

## 5. 数据流

```
[C1 事件源]
  pointerInputState 前台变化 ─┐
  stash onEntry（截图/文本） ─┼─→ [C2 规则引擎] ─→ TriggerVerdict
  定时器（V2 tracker）        ┘        │
                                      ▼
                             [C3 once_store] 查重
                         ┌─────────────┴─────────────┐
                    新触发                           已看过/永久关闭 → 丢弃（记 dismissed）
                         ▼
                   [C4 提案卡]（非焦点、不进截图）
                    ┌────┴─────┬─────────┐
                  Approve    Reject   永不再提示
                    │          │         │
              fabric plan    记 once   记 blockedForever
              + execute        │
              （复用全链：      └─ 同一 triggerId 一生只出现一次
               capture_policy / lease / receipt / undo）
```

## 6. 验收标准（真机，交替 A/B 测量，AGENT.md 红线 5）

| # | 场景 | 通过条件 |
|---|---|---|
| A1 | 微信里连续截两张图（不打开任何界面） | 3 秒内出现提案卡"要直接取出文字吗？"；Approve 后 OCR 文字进剪贴板；卡不抢输入焦点（焦点仍在微信） |
| A2 | 同一信号第二次触发 | 不出现（once_store 生效）；"永不再提示"后同参数永不出现，且清 once_store 或换参数后才恢复 |
| A3 | 设置里关掉 proactive | 0 条记忆写入、0 张卡；`screen-memory.json` 无新增（对照改前快照） |
| A4 | 剪贴板滞留场景 | 复制一段 >12 字文本，2 秒+ 无粘贴动作 → 卡"存进收藏箱？"；Approve 后条目进 stash 且**剪贴板内容未被覆盖**（stash_store.js:134-136 `writeBackAllowed` 语义） |
| A5 | 记忆写入端 | 截图/复制后 30 秒内 `screen-memory.json` 出现对应条目（app/windowTitle/excerpt 非空）；敏感应用（密码管理器）不出现 |
| A6 | 隐私 | 提案卡截图中不可见（沿用 contentProtection）；卡内无 lease/fingerprint/错误码字样（grep 断言） |
| A7 | 性能 | 事件总线的前台轮询复用现有 `pointerInputState`，**不新增 WH_MOUSE_LL**（grep 断言只有一个 `pointer_input_state.ps1`）；无事件时主进程 CPU 增量 <1% |

## 7. 不做（V2+，诚实标注）

- 通知监听（UserNotificationListener）：新的 C# 常驻组件，先有 V0 感知宿主再说。
- "输入与屏幕重合"检测：需要读输入流，复杂度和隐私风险最高，ROADMAP P2 已标"最强的一击"，值得等。
- 每日复盘 tracker：依赖 G5（时间线聚合），V2 排期。
- 记忆漏斗全量版（Timeline/reducer/classifier）：本项目不做常驻录屏（PRODUCT.md:35 红线），事件驱动版记忆够用——**这条是我们相对 Vida 的差异不是差距**。

## 8. 落地顺序（依赖关系）

1. **C5 记忆写入端**（半天）：stash onEntry + 前台变化 → `ScreenMemory.record`。地基，先测（tdd：写入 → recall 命中 → 敏感应用拒绝 → 上限裁剪）。
2. **C1 + C2 + C3**（一天）：事件总线接两个信号源、两条规则（截图连续/剪贴板滞留）、once_store。纯函数先行（照 `stash_store.js` 分法，测试钉子）。
3. **C4 提案卡**（一天）：非焦点卡 + Approve/Reject/永不再提示三键 + 走 `engine.execute(confirmed=true)`。卡内数据只取 `preview` 三字段。
4. **C6 设置** + 真机验收 A1–A7。
5. 窗口切换规则默认关地放开 → V2（tracker/通知/时间线）。

## 9. 一句话交接

Vida 的"主动"＝**事件源 + 记忆漏斗 + 触发判断 + 提案卡 + 交付**五块拼图；我们已拥有其中三块半（fabric 签名 plan/提案通道/任务门/隐私护栏 + 已设计未落地的摩擦触发层），最短路径是：**给 `screen_memory.py` 装上写入端 → 用现成轮询搭三条确定性规则 → 复用 fabric plan 的 preview/confirm 出一张非焦点提案卡**。提议 0 模型调用，日增量成本≈0，比 Vida 的全天漏斗便宜两个数量级。
