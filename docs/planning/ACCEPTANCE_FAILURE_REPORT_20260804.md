# 真机验收失败排查报告 — 2026-08-04

> 依据：今天 11:24–11:30 的真机测试（四个场景全挂）、`data/runtime/electron.log` 的完整时间线、`data/runtime/selection-captures/` 当场截图、以及逐行读代码。**本报告只诊断和给方案，未改一行代码。**

---

## 0. 总览：不是四个 bug，是三个系统性故障叠加

四个场景的失败全部落在下面三条根因上，任何一条不修，后续几乎所有任务都会继续失败：

| # | 根因 | 性质 | 影响面 |
|---|---|---|---|
| A | **气泡里打的每一条命令都被硬编码路由到 `agent.handoff`**（交给 codex 的交接草稿），正常的 OCR/改写/翻译/表格等三十个能力路由自 8 月 2 日起全部变成死代码 | 路由 bug | 图2、图4 的"天书"直接由它产生 |
| B | **模型网关欠费**（上一会话已出现 `402 积分余额不足，当前余额: -5`），所有模型调用 100% 失败 | 运营事故 | "Model 暂不可用"提示、每条命令白烧 12 秒模型超时 |
| C | **感知管线延迟超出两级超时预算**（快照桥 15s、命令桥 30s），且提交路径上把全屏 OCR 又跑了一遍 | 架构性延迟 | 图1 的"目标识别没能完成"、图3 的 `bridge_timeout` |

三条的关系：C 让每条命令都在超时边缘，B 在每条命令里再白烧 12 秒把 C 推过线，A 决定了即使侥幸没超时，出来的也是错的东西。

**日志证据（今天的测试，UTC 时间 = 北京时间减 8）：**

```
03:25:07 手势开始（图1 场景，CMD 脚本窗口）
03:25:26 selection_snapshot_bridge  ok=false error=bridge_timeout   ← 快照桥 15s 超时
03:25:26 capture done status=missing app=none
03:25:34 stage:submit-selection-command grounding wait expired      ← 6s 等待到期
         → 用户看到「目标识别没能完成，请重新选择一次」

03:26:47 capture done status=ready app=application（图2 场景，记事本）
03:26:47 submit command_len=3
03:27:01 selection_bridge ok=true                                   ← 14 秒才回，且回的是 handoff 草稿

03:29:13 capture done status=ready app=screen（图3 场景，"框起来"）
03:29:13 submit command_len=4
03:29:43 selection_bridge ok=false error=bridge_timeout             ← 整整 30s 超时
         → 用户看到裸错误码「bridge_timeout」

03:30:00 capture done status=ready app=browser（图4 场景，Edge PDF "OCR一下"）
03:30:18 selection_bridge ok=true                                   ← 18 秒，回的是 agent.handoff 天书
```

---

## 1. 逐问题诊断

### 1.1 【P0·路由】"OCR一下" 变成 codex 交接天书（图4、图2）

**现象**：在 Edge PDF 上说"OCR一下"，气泡里出来的是 `# Magic Pointer grounded object handoff`、`Selected recipe: agent.handoff`、lease/fingerprint/Context Packet 路径等一大篇内部数据，外加"Model 暂不可用，当前为本地 grounded 草稿"和永远转圈的"正在读取运行中的 Agent…"。

**代码根因（三层）**：

1. `electron/main.js:3159` — stage 提交无条件带 `requestMode: 'agent_prompt'`。这行是 8 月 2 日 `d9f92b1`（"dispatch editable prompts to live agent sessions"）引入的：当时为了做"把 prompt 交给运行中的 codex"功能，把**唯一的**提交通道整个切到了 handoff 模式，没有留意图分流。
2. `scripts/selection_bridge.py:1779` — `requestMode == "agent_prompt"` 时**提前 return**，而 `:1657` 的 `build_agent_prompt_draft` 里 `recipe_id="agent.handoff"` 是写死的。于是"OCR一下"“改写”“翻译”都变成"给 codex 写交接文档"。
3. `:1785` 之后的整条正常路由——`_reference_label_response` → `_context_pack_response` → `_review_response` → 购物/日历/路线 → `_fabric_response`（三十个能力的入口）→ 视觉问答 → Word 改写 → 通用改写/问答——**从气泡打字这条路上完全不可达**。上一轮验收清单里"气泡里打『改写得更正式』出改好的句子"，走的正是这段死代码，所以自动测试全绿、真机全挂。

**连带的两个 UI 恶果**：
- handoff 草稿本身是给另一个 AI 看的（cwd、lease、fingerprint、privacy boundary 全文），直接灌进了给人看的气泡。图4 里那篇"废话"就是它。其中 `cwd: C:\Program Files (x86)\Microsoft\Edge\Application\...` 不是 bug 的另一个 bug——它如实取了目标进程的安装目录当"工作区"，这个字段对非代码场景本来就不该出现。
- `electron/renderer/stage.js:923` "正在读取运行中的 Agent…"：这个 UI 的前提是你正开着 codex/claude 会话可以接活；没有会话时它会变成"当前没有可验证的运行中 Agent 会话"且确认键永久置灰——但用户根本没想交给 agent，这整个 UI 就不该出现。

**修复方案**（估 0.5–1 天）：
- `main.js` 提交时不再写死 `requestMode`。默认走 selection_bridge 的正常路由（那条链路本来就活着，只是被跳过了）；只有命令显式表达"交给 agent / 让 codex 做 / 在仓库里改…"这类意图时（可以先用关键词判定，成本为零）才置 `agent_prompt`。
- 保险丝：`build_agent_prompt_draft` 返回前检查目标是否代码工作区（`repo: not detected` 且能力不含代码类），不是就拒绝并回落到普通问答，防止以后再有入口误挂到 handoff。
- 回归钉子：把"OCR一下 → 走 `text.ocr_copy` 而非 agent.handoff"写成一个 bridge 级测试。这次事故本质是**契约变更零测试覆盖**——和上轮发现的"原位改写假报成功 709 个测试零覆盖"是同一类病。

### 1.2 【P0·运营】模型网关欠费，所有模型调用必败

**现象**："Model 暂不可用，当前为本地 grounded 草稿"（`stage.js:919`，`generatedBy === 'grounded_fallback'` 时显示）。

**根因**：上一会话已经打出 `API Error: 402 {"error":"积分余额不足，当前余额: -5"}`。之后所有 `ask_text_model` 都失败。后果分两层：
- 直接：一切需要模型的能力（改写、问答、prompt 精编）全部退化到本地兜底。
- 间接：`selection_bridge.py:1607` `AGENT_PROMPT_MODEL_TIMEOUT_S = 12.0`——每条命令**白等 12 秒**再失败，占掉 30 秒总预算的 40%。图3 的超时、图4 的 18 秒里都有这 12 秒。

**修复方案**（充值之外，代码侧估 0.5 天）：
- 启动时 + 每 10 分钟一次模型健康探测（一次 1-token 调用），失败就在气泡输入框上方常驻一条"模型服务不可用（余额不足/网络），当前只有本地能力"的横幅——**在用户打字之前告诉他**，而不是让每条命令跑完 12 秒再用一行小字暗示。
- 健康态为坏时跳过模型调用（省 12 秒），直接走本地路径。
- 402/401/欠费类错误单独识别并写明"账户余额不足"，不要混进"暂不可用"。

### 1.3 【P0·延迟】"目标识别没能完成，请重新选择一次"（图1）

**现象**：CMD 脚本查看窗口上划线，输入"这些字更改成赵筠哲666"，报"目标识别没能完成，请重新选择一次"。

**根因链**（全部有日志佐证）：
1. 快照桥（`selection_snapshot_bridge.py`：截 3120×2080 全屏 + OCR + UIA 探针[上限 1.2s 可能重试] + Python 进程冷启动）整体超过 15 秒预算（`main.js:2814`）→ `bridge_timeout` → 会话 `status=missing`。
2. 用户提交命令时 `session.snapshot` 不存在，`main.js:3099` 的 6 秒 grounding 等待轮询到期 → `main.js:3125` 报这句话。

**文案也是 bug**：让用户"重新选择一次"，但失败原因是管线超时，重选大概率再挂（日志里 03:24–03:25 连续多次手势失败正是用户在照做）。错误建议用户做无效动作，比错误本身更伤信任。

**修复方案**（分两档）：
- 止血（1 天内）：把"没拿到快照"的话术改成如实的"这次读取花的时间太长，已中止"；submit 等待期间气泡里显示"正在识别目标…（已 X 秒）"（pending 计时 UI 已有，接过来即可）；快照超时后不作废会话，允许命令带着"仅坐标 + 前台窗口"降级执行，而不是硬报废。
- 治本（1 周量级，和 1.4 合并做）：见 §2 的常驻感知 worker。快照拆两级——**第一级只做窗口绑定 + 选区读取（目标 <1s），气泡立刻可用；OCR/截图归档作为第二级异步补**。现在是全量感知做完才算 ready，用户比管线快是常态。

### 1.4 【P0·延迟+话术】"框起来" → 30 秒后裸报 `bridge_timeout`（图3）

**现象**：网页上划线说"框起来"，转 30 秒，气泡里出现英文裸错误码 `bridge_timeout`。

**根因（四个叠加）**：
1. **提交路径二次全屏 OCR**：`selection_bridge.py:1776` 在进任何路由之前调 `_enrich_screen_region_context`（`:757`），只要快照是 `screen_region` 兜底（这台机器上几乎总是，见 1.5），就把全屏 OCR **再跑一遍**。快照进程明明刚跑过 OCR，但两个进程各算各的，结果没有复用——这正是 AGENT.md 里记录的头号嫌疑，本次日志实锤。
2. 加上 handoff 的 engine.plan + grounded prompt 组装 + **12 秒必死的模型调用**（见 1.2），总和击穿 30 秒（`main.js:2820`）。
3. **裸错误码出口**：`stage_contract.js:169` `message: String(parsed.error || …)`——submit 路径的失败没有错误码→人话映射（capture 路径在 `main.js:2144` 有映射，submit 路径漏了）。
4. "框起来"这个意图即使路由修好也没有归宿：框高亮能力存在（`sweep_band`，吃 `artifacts.selection_rectangles`），但没有一条从文字命令触发它的 recipe。要么加一条"高亮"意图，要么明确回复"框选高亮请用划线动作完成，这里帮不上"。

**修复方案**：
- OCR 结果写进快照 JSON（blocks + engine 名 + 覆盖区域），`_enrich_screen_region_context` 先查快照缓存，miss 才重算（估 0.5 天，直接砍掉 5–10 秒）。
- 错误码映射收拢到 `stage_contract.js` 一处：`bridge_timeout`→"这次处理超时了"、`agent_prompt_context_missing`→"没有读到可用的目标"……未知码显示"出错了（代码：xxx）"（估 2 小时）。
- "框起来"意图给归宿（估 0.5 天，可延后）。

### 1.5 【P0·正确性】记事本划线，气泡里出来的是背后 CMD 窗口的内容（图2）

**现象**：记事本里选"我是个大傻逼。"，气泡里显示的却是被记事本压在下面的 CMD 窗口的"搬家成功！现在 Docker 住在这里: %TARGET_DIR%…"。

**根因**：
1. 结构化读取（UIA）在记事本上失败——用户贴的 handoff 元数据自己招了：`perception=screen_region; pixelFallback=True; fallbackReason=structured_context_unavailable`。注意**连 Edge PDF 场景也是这个标记**：结构化读取实际上处处失败，全屏 OCR 兜底才是这台机器上事实的主路径。这与上轮"UIA 白名单已放开"的预期不符，需要单独排查为什么放开后真机仍然 `structured_context_unavailable`（嫌疑：Win11 记事本是 UWP 宿主、探针 1.2s 超时在真机负载下仍不够、或 `match_window` 的排除名单误伤）。
2. 兜底路径是**整屏截图 + 全屏 OCR + 笔画穿过过滤**（`selection_bridge.py:773` 起的注释写明了这个设计），但**没有窗口 z-order 裁剪**：OCR 不知道哪些像素属于最上层的记事本、哪些属于背后的 CMD 窗口。笔画附近恰好有背景窗口文字时就混进来。第二个对象干脆 `bbox=null / gesture_no_bounded_candidate`——连界定都没做成。
3. 读取侧没有任何"内容来源窗口 = 绑定窗口"的一致性校验。写入侧有 hwnd/pid/标题/哈希四重校验，读取侧一重都没有——所以错误内容一路畅通进了气泡。

**修复方案**（估 1–2 天）：
- 兜底截图从"整屏"改成"目标窗口 hwnd 的 PrintWindow"（这条路主截图管线已经在用，兜底没接）；拿不到 hwnd 时至少用 `WindowFromPoint(笔画中心)` 的窗口 rect 裁剪 OCR 块。
- OCR 块过滤加窗口边界条件：块中心必须落在目标窗口可见区域内。
- 快照里记录 `content_source_window`，与 lease 绑定窗口不一致时降级为"没读到内容"，宁可空不可错——和写入侧同一条纪律。

### 1.6 【P1·体验】水平滚动条一拉，整个气泡跟着跑

**现象**：消息内容超宽出现水平滚动条，拖滚动条 = 拖走整个气泡。

**根因（两个独立 bug 叠加）**：
1. 内容区若干容器是 `overflow: auto`（`stage.css:1058/1086/1130`），长不可断行内容（文件路径、URL、代码）会撑出水平条。handoff 天书里全是 `D:\Desktop\...\17d7741f-...-context-packet.json` 这种长串，所以这次特别明显。
2. 拖拽不是 DOM 事件实现的，而是**全局指针轮询 + 命中数学**（`stage.js:200-227`）：按下时只要指针在面板矩形内、且不在 `button/textarea/input/[contenteditable]` 任何一个的矩形上，就开始 `surfaceDrag`。**原生滚动条不属于这四类控件**，于是按住滚动条拖动被判定为"拖面板"。而且因为事件被 hook 层消费，浏览器原生的滚动条拖动本来也收不到事件——双输。

**修复方案**（估 0.5 天）：
- 按用户要求**直接消灭水平条**：内容区 `overflow-x: hidden`，配 `overflow-wrap: anywhere` + 长串 `white-space: pre-wrap`（`stage.css:437/451` 已有 `overflow-wrap: anywhere` 的先例，扩到结果区即可）。竖向保留滚动。
- 拖拽判定改为**只有把手可拖**（气泡顶部标题条区域），不要"全表面减控件"这种否定式白名单——每加一种新控件（滚动条、以后可能的链接/选中文字）都会再踩一次。若保留全表面拖拽，至少把"距容器右/下边缘 16px 内"（滚动条区）排除。

### 1.7 【P2】其他在日志里看到、这次没直接撞上的

- `07:32:18 capture done status=target_mismatch` → "当前选区不可用"：目标校验失败的会话直接作废。DPI 200% 机器上逻辑/物理坐标混用曾把点打进别的窗口（AGENT.md 已记录），`target_mismatch` 大概率同源，修 1.5 时一并查。
- 手势日志里大量 `draw_timeout(5000)` + `chain_timeout(3500)` 租约过期：说明"晃动唤醒→划线"经常没在 5 秒内完成判定，入口本身的容错窗口偏紧，属于 §3 的交互形态问题。
- `bridge complete ok=undefined`：快照桥某些返回不带 `ok` 字段，边界契约不严，排查时容易误读，顺手修。

---

## 2. 为什么"这四个场景挂了，后面基本没有任务能成功"——结构性结论

把今天一条命令的真实执行路径摊开（这台机器实测值）：

```
晃动+划线（租约 5s，经常过期重来）
→ 冷启动 Python #1：全屏截图 + 全屏 OCR + UIA 探针(必失败,1.2s) ≈ 5–15s+（15s 超时线）
→ 用户打字提交
→ 冷启动 Python #2：全屏 OCR 再来一遍 ≈ 5–10s
→ engine.plan(写死 agent.handoff) + grounded prompt 组装
→ 模型调用（402 必败）白等 12s
→ 兜底：把内部交接文档当答案显示（30s 超时线，经常先到）
```

每一环的失败率相乘，**成功率约等于零是结构决定的，不是运气差**。所以修复必须按层来，顺序不能乱：

| 阶段 | 内容 | 工作量 | 修完的效果 |
|---|---|---|---|
| **止血**（1–2 天） | 1.1 路由恢复 + 1.2 充值与健康门控 + 1.6 砍水平条 + 1.4 错误话术映射 | 2 天 | 四个场景里，图2/图3/图4 直接变样：命令走正常路由、不再白烧 12s、错误说人话 |
| **管线**（约 1 周） | 常驻感知 worker（复用 `ocr_resident_worker.py` 的 socket 范式，快照桥与命令桥共用一个热进程）+ OCR 结果进快照缓存 + 快照两级化（绑定先行、OCR 异步）+ 1.5 窗口裁剪与来源校验 | 5–7 天 | 划线→气泡 <1s，命令→结果的固定开销从 ~20s 降到 2–3s；内容不再串窗口 |
| **形态**（2–4 周） | §3 GUI + §4 v1 收敛 | 见下 | 可发布 |

管线阶段有一条现成弹药：`docs/planning/EVERYWHERE_ANALYSIS_20260803.md` §5.1 的 `UIA_WindowVisibilityOverridden=2`（overlay 不污染 UIA、不触发 Chromium 渲染器休眠）和 §5.3 双窗口拆分——前者可能正是"结构化读取处处失败"（1.5 根因 1）的解药之一：我们自己的 overlay 覆盖在目标窗口上，可能一直在干扰 UIA 命中。**排查 1.5 时第一个就验它。**

---

## 3. GUI：怎么从"功能件"变成"产品"（对标 Codex / Claude Code 的配置体验）

Codex 和 Claude Code 的配置页好用，共性不在视觉，在四条纪律：

1. **配置的真身是一份可读的纯文本**（`settings.json` / `config.toml`），GUI 只是它的视图。好处：可 diff、可备份、可让 AI 改。我们已有 fabric settings 存储，缺的是把它declared 成"唯一真身"并给每项配上说明。
2. **分组少而扁平**（≤6 组），每项配置一行：名称 + 一句人话说明 + 当前值 + 默认值角标。没有二级弹窗套弹窗。
3. **危险项显式标记**（如 bypass permissions 的红字），风险由视觉承担而不是埋在文档里。我们的 recipe 本来就带 `risk=` 分级（local_write / external_send…），直接映射成徽章。
4. **即改即生效 + 可回默认**，每项旁边一个 reset。

**建议的信息架构**（对着现有 dashboard 改，不新造）：

```
左侧五组                     右侧内容
─────────────              ─────────────────────────────
通用        │  启动/语言/外观（solid|mica）/缩放
触发        │  晃动灵敏度、划线租约时长、默认输入(text|voice)、快捷键
模型与网络   │  端点、密钥、余额/健康状态(常显!)、超时预算、本地兜底开关
能力        │  30 个 recipe 逐行：名称+一句人话+风险徽章+开关（agent.handoff 默认关）
诊断        │  最近 10 次会话时间线：快照 Xs / OCR Xs / 模型 Xs / 结果，一键导出日志
```

其中**诊断页是这次事故教出来的刚需**：本报告的每个结论都是翻 `electron.log` 拼出来的，管线各阶段耗时打点（`bridge_progress.py` 的 `@@mp phase=` 通道）已经存在，缺的只是一页 UI 把它画出来。用户下次说"又挂了"，让他截诊断页，比拿手机拍屏幕强十倍。

**气泡本体**，三条铁律先立起来：
1. 给人看的气泡里**永远不出现**：错误码、lease/fingerprint、Context Packet 路径、`# Magic Pointer grounded object handoff`。内部数据要看去诊断页。
2. 竖向滚动唯一，永无水平条（1.6）。
3. 每个等待状态必须带秒数和当前阶段（"正在识别目标…3s"），任何等待超过 8 秒必须给取消键。已有的 pending 计时和琥珀色变色是对的，扩展到快照阶段。
4. 先解决 `stage.css` 顶部注释（石墨黑）与实现（浅蓝白）的规范分叉——定一个，删另一个，再谈打磨。

---

## 4. 第一版怎么上线（完整版本，不是 MVP）

### 4.1 竞品格局，一段话

**Everywhere**（Sylinko，6207★，BSL 1.1 明文禁止竞品使用其代码）：快捷键唤起的"带屏幕上下文的聊天窗"，能 Ctrl+C 的部分做到工业级，但**没有语音、没有手势圈选、没有原位写回**。**nemo-assistant**（93★，即"发布不久、形态几乎重合"的那个；MIT，已 clone 进 `external/`）：证明这条路有人走但没走通，其剪贴板纪律代码可直接抄。**WritingTools**（2385★）：README 吹的"不动剪贴板+可撤销"与代码不符，参考价值为负（上轮已实证）。**clicky / UFO²**：全屏识别+标注的交互范式来源。我们的差异化按战略文档不变：**Ctrl+C 复制不了的东西 + 要写回 + 跨应用**。

### 4.2 v1 功能清单（发布即完整，之后只修小 bug、加小需求）

| 模块 | 内容 | 现状 → v1 要做的 |
|---|---|---|
| 入口 | 晃动唤醒 + 划线圈选；选中即感知（selection-hook，默认关灰度） | 已通；租约时长放宽 + 入口失败率打点 |
| 取 | 圈选→结构化读取优先→OCR 兜底→复制；零模型快路径 | 修 1.5 的串窗口 + §2 管线提速；这是招牌，必须 <1s |
| 改 | 改写/翻译/纠错 → 气泡内出结果 → 「填入」（已带四重校验）；Word 原位替换+撤销 | 路由修复后已基本齐；补微信"无法确认"话术真机验证 |
| 问 | 圈选+提问（本地上下文，不上传截图除非授权） | 路由修复后可用 |
| 结构化 | 表格转 Excel、日历、路线、证据卡 | 已有，路由修复后逐个真机过一遍 |
| Agent | handoff 交给 codex——**仅显式意图触发**，默认开关关闭 | 从"唯一路径"降级为"可选能力" |
| 语音 | 按住说话，默认关闭（HN 反对意见明确） | two-pass 延迟优化按 memory 里的结论排期，不阻塞 v1 |
| 设置/诊断 | §3 的五组配置页 + 诊断页 | 新做，约 1 周 |
| 明确不做 | 微信视觉框选（OmniParser 链路）、记忆层、插件生态、macOS | 记入 roadmap，v1 不碰 |

### 4.3 v1 验收门槛（量化，达不到不发）

1. **延迟**：划线→气泡可输入 <1s（p90）；命令→首结果：零模型路径 <1.5s、模型路径 <5s（p50）。
2. **正确性**：气泡内容 100% 来自绑定窗口（1.5 的校验兜底）；读不到就说读不到。
3. **诚实**：所有错误是人话；所有等待有秒数；模型不可用提前告知。
4. **回归**：把这次的四个场景（CMD 改字 / 记事本改字+填入 / 网页框选 / PDF OCR）+ 微信"无法确认"写成冒烟清单，每次发版真机跑一遍——**自动测试这次全绿而真机全挂，说明真机冒烟不可替代**。
5. **稳定**：连续 50 次圈选无一次串窗口/假报成功/裸错误码。

### 4.4 时间估算（单人 + AI 结对）

止血 2 天 → 管线 1 周 → GUI+配置诊断页 1.5 周 → 全能力真机走查+冒烟固化 1 周 ≈ **一个月到可发布的完整 v1**。风险最大的一段是管线常驻化（Windows 进程/COM 的坑多），但两套常驻 worker 范式（OCR socket、语音 stdin/stdout）都是现成的，属于照抄自己。

---

## 附：本次结论对应的关键代码位置速查

| 问题 | 位置 |
|---|---|
| 提交硬编码 handoff 模式 | `electron/main.js:3159`（`d9f92b1` 引入） |
| agent_prompt 提前 return / recipe 写死 | `scripts/selection_bridge.py:1779` / `:1657` |
| 死掉的正常路由链 | `scripts/selection_bridge.py:1785-1881+` |
| 12s 必死模型调用 | `scripts/selection_bridge.py:1607` |
| 提交路径二次全屏 OCR | `scripts/selection_bridge.py:1776→:757` |
| 快照桥 15s / 命令桥 30s 预算 | `electron/main.js:2813-2825` |
| 6s grounding 等待与误导文案 | `electron/main.js:3099` / `:3125` |
| 裸错误码出口 | `electron/stage_contract.js:169` |
| "正在读取运行中的 Agent…" | `electron/renderer/stage.js:919-926` |
| 全表面拖拽误吞滚动条 | `electron/renderer/stage.js:200-227` |
| 内容区 overflow | `electron/renderer/stage.css:1058/1086/1130` |
| 兜底 OCR 无窗口裁剪 | `scripts/selection_bridge.py:773` 起 |
