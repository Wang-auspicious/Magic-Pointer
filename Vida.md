# Vida 拆解与实现交接

> 2026-08-06 调研 + 本机实测。证据分级同 [PRODUCT.md](docs/PRODUCT.md)：**事实**＝有链接/文件可核；**推断**＝基于事实的判断。
> 本文是给**正在做 GUI 与底层的那个会话**的交接。要动手直接看 [§7](#7-交接单)。

---

## 1. 三句话

1. Vida 的"主动"不是模型能力，是**一条把无障碍树压成可查询记忆的确定性管线**——而这条管线被它自己 MIT 开源了（`Einsia/OpenChronicle` ★2805）。不用反推，直接读。
2. 它的管线是 **macOS-only**，Windows 端他们自己也没解决。**这是我们的时间窗口。**
3. 本机实测挖出一条比调研更重要的 bug：**任何我们从没碰过的 Chromium 窗口（Electron / Tauri / WebView2 / 浏览器），第一次 UIA 读一定是错的，而且静默。** 唤醒延迟 <50ms，修它是一个函数。见 [§5](#5-本机验证六个实验)。

---

## 2. Vida 事实层

| 项 | 值 |
|---|---|
| 公司 / 版本 | Einsia AI Technology (SG) PTE. LTD.；**v0.6.3**（2026-07-30） |
| 平台 / 体积 | macOS 13+ · Windows 10/11；Win 安装包 **306 MB**、mac arm64 **348 MB** |
| 技术栈 | **Electron + electron-builder**（`latest.yml`/`latest-mac.yml`/`.blockmap` 三件套实锤）。306 MB **推断**内置浏览器内核（Pro 有"浏览器任务"）+ 原生 addon |
| 模型 | Standard `gpt-5.6-luna` / Ultra `gpt-5.6-terra`。**写死在套餐里，产品内没有换模型入口** |
| 定价 | Free $0（Standard、1 个定时任务）；Pro **$9.9/月**（首月 $0.99）含 500 积分、Ultra、记忆、主动协助、无限定时任务、浏览器任务、文档/幻灯片/表格/图片生成、深度研究。加购 500 积分 $10 |
| 发布 | 06-24 公测，07-04 PH 日榜第一（462 upvotes） |
| 主界面 IA | **New Chat / Tracker / Spark / Memory / Calendar** |
| SOTA 进度 | 已达成 5（回复救星 / 提示词救星 / 简历救星 / 工作区整理 / 每日复盘），攻坚中 5（投研 / 市场调研 / 产品调研 / Deck Builder / Sheet Builder） |

**两条要纠正的传言：**
- **它不是 LLM-agnostic。** 公众号那句"LLM-agnostic、是 Codex/Claude Code 之上的上下文层"是营销转述。**这条是我们相对它、也相对 Google/MS 的同一条结构性差异。**
- 隐私政策 2.2 逐字列举的桌面上下文字段是「应用名称、窗口标题、**可见文本、所选内容、按钮、菜单、文本字段**及工作流信号」——**一份无障碍树字段清单，不是截图 OCR。** §4 由其开源仓库实锤。

---

## 3. 五个演示逐帧（1920×1080/60fps，25–35s，原片已下载逐帧拆过）

| 用例 | 关键帧 |
|---|---|
| **001 回复救星** | Slack 里同事催进度 → 全局热键唤起**屏幕底部居中的大号胶囊输入条**，打"Please help" → 同条变"Generating…"，**彩虹渐变从左扫到右**，提交键变停止方块 → 右侧滑出面板"Concrete design update"，**流式吐证据清单**（`✓ Reviewed latest Figma onboarding flows` → `12/16 screens finalized` → `Mobile handoff still pending`…）→ 绿色 `✓ Vida has completed your task`，placeholder 转成追问入口 → 草稿整段落进 Slack，**关键短语被黄色荧光笔标出** |
| **002 提示词救星** | Gmail 邮件带 Notion+GDoc 附件 → 用户逐个打开 → 到 Claude.ai 唤起 → 面板用**等宽灰字**流式吐读到的原文，**黑色正文 = 我的结论，等宽灰字 = 我读到的原文** → 生成的 prompt **直接落进 Claude 输入框** |
| **003 简历救星** | Google Docs 里唤起。输入条**左下角是剪刀**（截屏区域），右侧 历史/麦克风/提交 |
| **004 工作区整理** | 桌面唤起打"Clean u\|" → 卡片：`▽ TASK FINISHED` + "Organizing files request" + **渲染成三个文件夹图标的预览**（不是命令行回显）+ Approve/Reject 单选 + 底部 Reject/Approve 按钮 + 左下重跑图标 → 批准后 Finder 里真建好了 |
| **005 每日复盘** | Slack 通知"Can you send me a quick summary of today's progress?"**带紫色辉光**（＝Vida 判定它是触发器）→ Figma 里面板 placeholder 是 **`Ask Vida anything about this page…`**（绑当前前台页面）→ 日报卡：8h 环形图 + 时间分布（等宽着色 `6h/75%` `1.5h/20%` `0.5h/5%`）+ Key Deliverables + Tomorrow's Plan + Today's Keywords 胶囊 |

**六条可直接抄的设计：**
1. **把"我读了什么"当主要输出流式播出来**，不藏在折叠的 thinking 里。`✓` 是动作，`→` 是从那个动作里读到的事实。等待的 12 秒因此在建立信任。
2. **证据与判断用版式分离**（等宽灰 vs 黑正文）。这正好实现 AGENT.md 红线 9——不说免责话术，但把来源摊开。
3. **产物写进目标应用的输入框**，不是"已复制到剪贴板"。
4. **提案的预览渲染成结果的样子**，用户 0.3 秒能判断该不该批准。
5. **追问框绑当前前台页面**，切窗口 placeholder 就变。用户因此不用交代背景。
6. **进度用色带扫过**，不用百分比不用转圈。廉价且不撒谎。

**事实**｜网易实测日报 **112 秒**，中途要了两次终端权限。慢，而且慢得可见。

---

## 4. 架构：他们自己开源了

Einsia 组下四个仓库，两个是要害：

### 4.1 OpenChronicle（MIT，Python，★2805，**macOS only**）＝ Vida 的记忆层

```
mac-ax-watcher (Swift 常驻二进制：订阅全局 AX 通知——窗口聚焦/值变化/标题变化/应用激活，一事件一行 JSON)
 → S0 event_dispatcher  四时间旋钮 + 内容指纹
 → S1 s1_parser         抽 focused_element / visible_text / url
 → capture-buffer/{iso8601}.json
 → Timeline 聚合器 (LLM)  墙钟对齐 1 分钟块，逐字保留用户敲的字
 → Session 管理器        三刀切会话
 → S2 reducer (LLM)      → event-YYYY-MM-DD.md
 → Classifier (LLM 工具循环) → user-/project-/tool-/topic-/person-/org-*.md
 → SQLite FTS5 → MCP 只读服务器 127.0.0.1:8742/mcp
```

**去噪四旋钮**：`debounce 3.0s`（值变化合并，防一键一捕获）/ `dedup 1.0s`（同 `(event_type, app)` 直接丢）/ `min_capture_gap 2.0s`（硬地板）/ `same_window_dedup 5.0s`（**聚焦变化永远豁免**）。
**内容指纹（无时间窗）**：`hash(bundle + title + focused_element.value + visible_text + url)`，**时间戳/触发原因/截图不进指纹**。解决时间旋钮解决不了的：锁屏过夜、暂停的视频会无限产生内容相同的事件。默认配置**一个工作日几百次捕获**。

**Timeline**：墙钟对齐 1 分钟窗口 → `(start,end)` 天然唯一键 → **幂等**。**只喂 S1 字段不喂原始树**（Electron 原始树 200–400 KB）；`visible_text` 截 10 KB → prompt 再截 4 KB；每窗最多 30 事件。输出一行一条 `[<app>] <context>: <what>. "<verbatim>". Involving: <...>`。`is_editable && value_length>0` 时那段 value 是用户自己敲的，**prompt 里标为最高优先级必须原样带出**。这一层**是归一化器不是摘要器**。

**Session 三刀**：`gap_minutes=5` 硬切（**会话结束在最后一个事件的时间戳上，不是你回来的时刻**）/ `soft_cut_minutes=3` 单一无关应用独占（**但"近 2 分钟内 ≥2 个应用被聚焦"豁免**）/ `max_session_hours=2` 兜底。

**S2 reducer**：活跃期每 `flush_minutes=5` 产一条 `[flush]`，结束产终版。输出 `{summary, sub_tasks[]}`，sub_task 必须形如 `[HH:MM-HH:MM, <app>] <action>, involving <...>`。**失败退避 5/15/30/60/120 分钟，5 次耗尽写启发式条目**（每 app 一条，打 `heuristic`）——**一次会话永不静默丢失**。每日 23:55 兜底 cron 强制结束当前会话。

**Classifier**：每 30 分钟 + 终结补尾窗。**硬守卫：拒绝任何写 `event-*.md` 的调用**（reducer 独占）。reducer/classifier 各自维护 `flush_end`/`classified_end` 书签，条目恰好处理一次。

**记忆格式**（整套值得搬）：`~/.openchronicle/memory/*.md`，YAML frontmatter（`description/tags/status: active|dormant|archived/created/updated/entry_count/needs_compact`）+ 追加式条目 `## [ISO] {id: YYYYMMDD-HHMM-6hex} #tag`。
- **supersede 不删除**：旧 body 包 `~~ ~~` + 标题追加 `#superseded-by:{new_id}` + FTS 打 `superseded=1`。
- **压缩守卫**：`soft_limit 20000` / `hard_limit 50000` token；重写后正则做名词短语保全检查，**丢失 >5% 直接拒绝**，留标记等人工。
- SQLite 是**可重建的派生物**，手改 Markdown 后 `rebuild-index` 即可。

**MCP 工具面**（常驻 daemon 内，streamable-http）分**两层**：压缩层 `list_memories/read_memory/search/recent_activity`；**原始层 `current_context/search_captures/read_recent_capture`**。server-level instructions 明写"关键词可能在屏幕上但还没进记忆 → 先搜原始层再退回压缩层"。
> **最聪明的一处：面包屑。** 每条 sub_task 末尾带 `— raw: read_recent_capture(at="14:30", app_name="Cursor")`，agent 照抄这句就能从压缩层一步下钻回原始层。它承认"压缩过的记忆不是全部真相"。我们的 `context_pack/screen_memory.py` 缺的正是这个。

**他们的 AX-first 论证**（成本更低 / 意图捕获更准 / 记忆更小更干净 / 截图后补）**和我们 ARCHITECTURE.md「结构化能读到的就是真相，截图只是证据」是同一句话。** 两队独立收敛，这条判据大概率对。

### 4.2 Browser-BC ★488（arXiv:2606.32014）＝ 他们不赌视觉 GUI agent

Chrome MV3 扩展录真人任务 → `localhost:8099` → atomize → 按 capability 分类 → 按 `(domain, capability)` 装桶 → 每桶蒸馏成 `SKILL.md` → 装进 `~/.claude/skills/` → **执行走 Playwright MCP**。
**不做视觉 grounding、不猜坐标，而是从人类轨迹蒸馏站点级技能。** 和我们 PRODUCT.md「不做通用 computer-use」是同一个战略判断；差别是他们做了"人类轨迹→技能"那一层，我们的 recipe 还是人写的。

### 4.3 harness 形态：自己搭的，外部模型只出 API

四个 LLM 调用点里**三个是固定 prompt 的单次调用**（timeline、reducer 用 `json_mode=True`、compact），**只有 classifier 是 tool-call loop**。
> **主动的部分（记忆构建）根本不是 agent，是 ETL。** 这是"主动为什么便宜"的钥匙。我们的 `intent_router.py` 三层路由是同一种思路——**V1–V3 必须挂 L0/L1，不要挂 L2 工具调用兜底。**

### 4.4 成本账（算得出来，不用猜）

8 小时工作日、60% 分钟有活动：

| 调用点 | 频次/天 | 单次输入 | 合计 |
|---|---|---|---|
| Timeline 聚合器 | **288** | ~3.5k token | **≈1.0 M** |
| S2 reducer (flush) | 96 | ~1k | 0.10 M |
| Classifier | 16 | ~3k | 0.05 M |

**≈1.2 M 输入 token/工作日**，输出可忽略。便宜后端 ≈$5/月，GPT-5 级 ≈$45/月。他们卖 $9.9 含 500 积分 →**推断**管线三层跑 `luna` 且不扣用户积分，只有交付任务跑 `terra` 扣积分。

> **不需要"大量预制 token"，需要的是一条把 token 压两个数量级的漏斗。** 屏幕不变→指纹→**0 次调用**；原始树 200–400 KB→只喂 S1→**4 KB（压 100 倍）**；层层递减 `capture 4KB → timeline block ~200 token → event entry ~100 → memory fact ~30`。

**我们能更省**（**推断，待实测**）：timeline 是调用次数最多的一层（288 vs 96 vs 16）。他们必须用 LLM，因为 AX 的 `visible_text` 是一坨没有语义边界的渲染文本。**我们有 DevTools DOM 和 Office COM，边界是现成的**；`focused_element.value`+`is_editable` 本身就是逐字内容。若只让"纯 UIA、无 DOM"的应用走模型（估 20%），**总调用次数降约 65%**。验证方法：拿 §5 的真实 dump 写两版归一化（纯规则/LLM），比对逐字保留率与上下文标签正确率。

---

## 5. 本机验证（六个实验）

Windows 11、200% 缩放。E4/E5/E6 用自拉的隔离 Edge（独立 `--user-data-dir`），不碰用户窗口。原始数据在 `%TEMP%\vida_verify\`（**会被系统清理，fixture 先拷出来**）。

**E1 缺件**：`SetWinEventHook|EVENT_OBJECT_FOCUS|EVENT_SYSTEM_FOREGROUND|EVENT_OBJECT_VALUECHANGE` 在仓库里只命中 3 个 md，**代码里一次都没有**。

**E2 冷读**：一次性 `uia_tree_dump.py --all` 打三个 WebView 应用 → Clash Verge 31 行 / CC Switch 47 行 / Token Monitor 17 行，树全停在 `WRY_WEBVIEW` / `Chrome_WidgetWin_1` / `Intermediate D3D Window`。**零个网页内容节点。**

**E3 再打一次**：同窗口同命令，Clash Verge **31 → 155 行**，`MuiListItem-root … "首 页"/"代 理"/"订 阅"`、CSS 类名、实时速率全在。

**E4 唤醒延迟 <50ms**（决定性）：全新 Edge 打开带 `COLDMARKER` 的页面，渲染完但不让任何 UIA 客户端碰它——

| # | 距上次 | 节点 | 带名 | 命中 COLDMARKER |
|---|---|---|---|---|
| 0 | 冷首读 | 48 | 21 | **0** |
| 1 | +50ms | 72 | 36 | **5** |
| 2–7 | +100ms…+3200ms | 55–72 | 27–36 | 5 |

**E5 不衰减、且状态住在目标应用里**：Clash Verge 唤醒后 0/3/10/30/60/120 秒各打一次（**每次都是全新探针进程**），恒定 149 节点 / 101 带名 / 深度 17。另测最小化：标记命中数不变（6/6/6）——**可见性不是开关**。

**E2 微信（Qt）**：连打 4 次，每次都是 **8 节点 / 深度 2 / 1164 字节**，一字不差（`MMUIRenderSubWindowHW`）。**Qt 不实现 UIA provider，和 Chromium 懒加载不是一回事。探针再多次、常驻再久都不会变。** AGENT.md 那条可从"实测"升级为"结构性事实"。

**E6 树深与 `ax_depth`**：

| 宿主 | 类型 | 冷首读 | 热节点 | 最大深度 | 带名深度 p50/p90/max |
|---|---|---|---|---|---|
| Clash Verge | Tauri/WebView2 | 31 行 | 149 | 17 | 16/17/17 |
| CC Switch | Tauri/WebView2 | 47 行 | 321 | 18 | 16/17/**18** |
| Token Monitor | Chromium 应用 | 17 行 | 860 | 12 | 10/11/12 |
| **Magic Pointer** | **Electron 43** | — | 124 | 11 | 10/10/10 |
| Edge → vida.app | 浏览器 | — | 251 | 16 | 13/15/16 |
| Edge → GitHub | 浏览器 | — | 574 | **20** | 18/20/**20** |
| 微信 4.x | Qt | 8 | 8 | 2 | — |

- **`ax_depth = 24`**。实测最深 20，Tauri 18，Electron 11，留 20% 余量。**不要抄 OpenChronicle 的 100**——Windows UIA 的 Chromium provider 已扁平化，比 macOS AX（20–60 层）浅一半，每多一层都是跨进程往返（约 8ms/节点）。
- **内容层集中在 10–20 层，外壳占 0–12 层。截到 12 层，网页正文一个都拿不到。**
- GitHub 上 "AX Tree" 出现在树的**第 38,525 字符**、第 18 层（OpenChronicle 在 macOS 量到的对应值是 5639）。**Windows 上这个坑深 7 倍**——任何"截前 N 个字符喂模型"的做法都会静默漏掉正文。
- 树体积 13–98 KB（macOS 200–400 KB），S1 截 10 KB 对我们偏保守。

### 结论与更正

- ~~"spawn-per-request 探针在架构上读不到 Electron"~~ —— **E4 推翻了。这不是架构问题，是一行时序 bug。**
- 真正的失败模式更窄也更难受：**任何没碰过的 Chromium 窗口，第一次读一定是错的，且静默。** 用户打开应用→晃动→划线，那就是第一次触碰。**这也是它一直没被抓到的原因：自己开发时反复测同一个窗口，第二次起就是好的。**
- STATUS.md 那条"自绘应用两条读取路同时断"**对 Electron/Tauri 那一半是错的归因**，要拆成两句。
- AGENT.md「常驻化能省 440ms」的证伪**只对延迟成立**。常驻的真实收益是①消除首读时序赌博 ②给捕获管线提供事件源，**不是省毫秒**。

**还没验**：激活超过 120 秒会不会掉（Chromium 有 a11y auto-disable 心跳，**推断**常驻宿主持续触碰后对我们不构成问题，但补丁方案要考虑）；Flutter 桌面（本机无样本）。

---

## 6. 信息源与 SOTA 复现

### 6.1 我们多四路强的，少一路要害的

| 信息源 | Vida | 我们 |
|---|---|---|
| 无障碍树 | AX ✅ | UIA ✅ |
| **网页 DOM**（结构化程度高于无障碍树） | ❌ | **DevTools ✅** |
| **Office 文档对象** | ❌ | **COM ✅** |
| 像素 | 截图（自标 secondary） | 常驻 OCR + OmniParser 元件框 + 视觉分组 ✅ **更强** |
| **指代（"这个"）** | ❌ 只有截图剪刀 | **划线 + semanticPoint + THIS/THAT/THESE/HERE ✅** |
| **任意 MCP server / 用户自己在跑的 agent** | ❌ | **✅ 这一路信息源可无限扩展** |
| 第三方 OAuth（Slack/Notion/Figma 服务端数据） | ✅ | ❌ **有意不做**，靠 MCP 转接 |
| 日历 / 系统通知 | ✅ | ❌ 都便宜可加（Win 有 `UserNotificationListener`） |
| **时间维度：过去 8 小时发生了什么** | ✅ | ❌ **唯一要害缺口** |

要害那一路就是 V0–V3。它不是"多一个数据源"，是**把"此刻这个窗口"变成"这一天"**——所有"不用交代背景"的体验全长在上面。

### 6.2 五个 SOTA

| # | 判断 |
|---|---|
| 001 回复救星 | **能，写回比他们严谨**（`written_unverified` 三态 + 读回校验，他们没展示）。当下就能做更准的版本：划线指定回哪条，只喂那一块。**限制**：微信/钉钉这类读不到内部消息的，做不了，别硬来 |
| 002 提示词救星 | **基本已有**（图转提示词是 P3 落地十项之一）。他们要把整个 Notion 页读进去，我们只读你圈的几块 |
| 003 简历救星 | **要做**——见 §6.3 |
| 004 工作区整理 | **能，引擎比他们完整**（他们全程没展示 undo）。缺的只是提案卡界面。**最快能落地的一个** |
| 005 每日复盘 | **非 V1–V3 不可，没有捷径。** 但也是最能证明"主动"的一个 |

### 6.3 更正：003 该做，因为红线的表述要改

我上一版判它"违反『永远不要要求用户打开 Magic Pointer』"。**这个判断错了**，因为收藏箱（`stash_*`）落地后产品形态变了。红线的正确表述是：

> **触发永远不需要打开我们；但产物可以有一个家。**

收藏箱就是那个家——替代"发给微信文件传输助手"这个真实工作流。截图、剪贴板、AI 交接的话都往里落，**且直接存本地**（微信存不了本地、终端里 Ctrl+V 收不了位图，这两个痛点是真的）。有了这个家：
- 003 的正确形态**不是**"打开我们做简历"，而是"你划过/截过的东西已经在箱子里，需要时被聚合成简历"。这反而更接近 Vida 的 Resume Rescue——它也是从已有上下文里攒。
- 后续的聚类 / AI 解释 / 读图 / 实况录制（3–5 秒小视频 → 抽帧 → image-to-prompt）都挂在这个箱子上。

---

## 7. 交接单

> 给 `529b4a98` 那个会话（GUI + 底层）。它 08-06 14:34 因 402 积分不足停在半路。

### 7.1 对齐：它已经做完的

| 文件 | 状态 |
|---|---|
| `electron/renderer/studio.{html,css,js}` `companion.{html,css,js}` `oreo.css` `icons.js` `data.js` `settings.js` | 主界面 Studio + 小窗 Companion + Oreo 风格系统。`data.js` 有桥走桥、没桥用样例 |
| `electron/stash_store.js`（160 行，纯逻辑无 IO） | `fingerprint`（16×16 亮度采样，不做全图哈希）/ `classify`（凭证>交接>片段>素材>灵感，中文阈值 6 字）/ `describe` / `assignBurst`（2 分钟 + 同来源成簇）/ `shouldDedupe`（5 秒）/ `relativePath`（按月分目录）/ `clipboardPayload` / `groupIntoBursts` |
| `electron/stash_runtime.js`（162 行，IO 层） | 700ms 轮询剪贴板、落盘、**把本地路径写回剪贴板同时保留位图**（终端 Ctrl+V 拿路径、图片编辑器拿图——这是真正省事的地方）、`index.json` 先写 `.tmp` 再改名 |
| `electron/conversation_store.ts` | 对话按**对象身份**归类（进程+窗口标题+元素路径，逐级降级），挂在 `updateStage` 上（"每个用户看得见的结果都过这里"），同对象累计问 ≥2 次进记忆 |
| `electron/main.js` / `preload.js` | IPC：`stash:list` `stash:entry` `conversations:list/get/timeline/memories/artifacts` `conversations:turn` |

**它自己承认还没在真机验过的**：`payload.command` 改成在提交那一刻存下（原来去 `payload.prompt` 找，永远是空）；`RESULT/COMPLETE/ERROR` 三终态全覆盖（原来只认 `result.answer`，写回成功的那类根本没有 `result` 对象，被静默丢掉）；开机读记录而不是显示写死那屏；新对话按钮绑事件。
**它卡住的地方**：小窗转半天没结果然后消失——它判断是桥超时/终端读不到，不是显示层，需要 `data/runtime/electron.log` 才能定位。日志钉子已经加了：`conversation + <id> type=... q_len=... a_len=...` / `conversation skip ... reason=empty`。

### 7.2 今晚：收藏箱五个缺口（按严重度排）

纯逻辑层（`stash_store.js`）已经支持文本了——`classify` 里有 `交接`/`灵感`/`片段`、`describe` 吃 `input.text`。**缺的全在 IO 层和接线。**

| # | 缺口 | 改哪 | 怎么做 |
|---|---|---|---|
| 1 | **不打开 Studio 就永远不收** | `main.js` | `initializeStashRuntime()` 只在 `ipcMain.handle('stash:list')` 里被调用。要在**应用 ready 后就起**（受 `fabricSettings.stash.clipboard` 开关约束） |
| 2 | **`focusProbe` 在最常见场景下返回 `{}`** | `main.js` | 它只在有活动选区会话时才给值。而用户在微信里截图、终端里复制时**没有 selection session** → `classify` 拿不到 app → 全落成"素材"、全归一簇，**整个归类和成簇的证据链在主场景下是空的**。要改成走前台窗口探针（进程名 + 标题 + 焦点元素），**复用 §7.3 的 `is_cold_tree` 判据**，拿不到就留空绝不猜 |
| 3 | **只收位图，不收文本** | `stash_runtime.js` | `tick()` 只在 `availableFormats()` 含 `image/*` 时才动。加文本分支：`clipboard.readText()` → 独立的文本指纹（`hash(text)`，不走 `sampleImage`）→ `buildEntry({kind:'text', text})` |
| 4 | **文本条目绝对不能回写剪贴板** | `stash_runtime.js` | 现在回写路径覆盖剪贴板。对文本这么做会**破坏用户刚复制的内容**、毁掉 Ctrl+V。回写只对位图生效 |
| 5 | **`relativePath` 给文本发 `.png`** | `stash_store.js` | `ext = kind === 'clip' ? 'gif' : 'png'`，文本要 `.txt`。**改这个函数要同步改测试**（它是纯函数，本来就该有钉子） |

**验收**（真机，不是自动测试）：微信里截个图 → 不打开任何界面 → 打开 Studio 应当已经有这条，且 `app` 是 `Weixin.exe`、`kind` 合理；终端里 Ctrl+V 拿到的是本地路径；连续截三张归一簇；复制一段文字 → 进箱子且**剪贴板里还是那段文字**。

### 7.3 然后：V-1 冷树重试补丁（一个函数，独立于整个 Vida 方案）

§5 直接给出的现成 bug 修复。现在每个用户**第一次**在 Electron/Tauri/WebView2 应用里划线，我们都静默返回"读不到"。

- 在 `app/adapters/uia_text_adapter.py` 的树读取出口加纯函数 `is_cold_tree(max_depth, class_chain, named_count) -> bool`：
  - 判为冷：`max_depth ≤ 8` **且** 类名链命中 `WRY_WEBVIEW`/`Chrome_WidgetWin_*`/`Intermediate D3D Window`/`RootView`+`ClientView` **且** `named_count < 30`
  - **排除表**：`MMUIRenderSubWindowHW` 等已知 Qt/自绘类名直接 `False`，否则每次点微信白等 60ms 换来永远的 8 个节点
- 判为冷 → 隔 60ms 重读一次（实测 50ms 足够，留 20% 余量），**只重试一次不递归**
- 成本：命中 +60ms，未命中 0。相比现有探针 199–975ms 可忽略
- **先写测试**（`/tdd`）：喂 E2 的冷树 dump 判 True、E6 的热树 dump 判 False、微信 dump 判 False。三个 fixture 在 `%TEMP%\vida_verify\`，拷进 `tests/fixtures/`
- **`is_cold_tree` 同时是 §7.2 缺口 2 和 §7.4 V0 的预热判据**，一处写三处用

**验收**：冷启动一个 Tauri/Electron 应用，**第一次**划线就拿到正文。

### 7.4 再然后：V0–V3（时间维度）

**V0 常驻感知宿主。** 立项理由用修正后的说法：①在 `EVENT_SYSTEM_FOREGROUND` 到达时预热新前台窗口，用户划线时连那 60ms 都省了 ②**给 V1 提供事件源——这才是它不可替代的地方**。
- 在 `scripts/native_element_picker_demo.cs` 上做成受生命周期管理的常驻服务（ROADMAP P0 第 2 项）
- 事件源两路：`SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_OBJECT_VALUECHANGE, …, WINEVENT_OUTOFCONTEXT)` + `IUIAutomation::AddFocusChangedEventHandler`/`AddPropertyChangedEventHandler(ValuePattern)`
- IPC 用 named pipe（**不要**复用 OCR worker 那套 socket+PORT_FILE）；一事件一行 JSON
- **禁止装第三个 `WH_MOUSE_LL`**（已有两个，见 ROADMAP P1 selection-hook 的互斥约束）
- **验收**：切到冷启动的 Tauri/Electron 窗口后不做任何操作，200ms 内该窗口 `is_cold_tree == False`

**V1 捕获层** `app/context_pack/capture/`：四旋钮抄默认值（3.0/1.0/2.0/5.0，聚焦变化永远豁免）+ 内容指纹 `hash(exe+title+focused_element.value+visible_text+url)`。**`ax_depth=24`**，`visible_text` 截 10 KB。
- **截图默认关**（AGENT.md「不要默认上传截图给模型厂商」，OpenChronicle 默认是开的，**这条不抄**）
- **心跳默认关**（`heartbeat_minutes=0`，纯事件驱动）。他们的心跳是为"长时间空闲也留痕"，那是 Recall 的目的，不是我们的
- **排除列表是准入条件不是后续功能**：默认排除密码管理器、银行/支付、终端里的敏感窗口（对标 Vida 的 Data Control）
- **验收**：连续工作 1 小时几十到几百个 capture；锁屏 10 分钟产出 0 个（内容指纹生效）

**V2 时间线+会话**：墙钟 1 分钟块 + `UNIQUE(start,end)`；只喂 S1 字段；三刀（5/3+高频切换豁免/2h）。这几个 LLM 调用**不在交互路径上**，可用批处理超时，但要独立失败队列，不能共用 `ask_text_model` 的默认 120s×2。
**验收**：一天的块数 ≈ 有活动的分钟数；同一分钟重跑 tick 不产生第二个块。

**V3 记忆写入器**：reducer（`{summary, sub_tasks[]}` + 格式校验 + 退避 5/15/30/60/120 + 耗尽写 `heuristic` 条目）+ classifier（30 分钟 + 尾窗，**硬守卫拒写 `event-*.md`**）+ 双书签。记忆格式照 §4.1（supersede 不删除、压缩守卫丢失 >5% 名词短语拒绝）。
**沿用**：不存截图（`screen_memory.py` 已有测试在出现 `capture_path`/`.png` 时失败，新目录要覆盖到）。
**验收**：杀掉 daemon 重启，没有会话行停在 `active`；同一批 timeline 块不产生两条 event 条目。

**V4 MCP 工具面**（我们已经是 server，这层最便宜）：加压缩层四个 + 原始层三个工具，server instructions 明说两层，**每条 sub_task 末尾加面包屑**。做完这层，我们对用户自己的 Claude Code/Codex 就已经是一个"能回答我今天干了什么"的记忆服务——**而这是 Vida 结构上不会做的事**（它锁 gpt-5.6）。

**V5 提案卡**：引擎已是 `plan→commit→verify→undo`，**缺的只是界面**。按 §3-004 那张卡：状态行 → 一句人话 → **渲染式预览**（按 `outputKind` 分派：文件操作画目录树、文本改写画 diff、写回画输入框前后对照）→ Approve/Reject → 重跑。级别 3 写回的 `written_unverified` **在提案卡上就要标出来**，不能等执行完才说。内部数据（lease/fingerprint/错误码/Context Packet）不进这张卡。

**V6 主动层**：Tracker（`cron + recipe + 交付方式`，第一批只做每日复盘/URL 日更/文件夹变更；**免费档只给 1 个**，这个分法是对的）+ Spark（ROADMAP P2 摩擦触发层已设计，加第四个信号：**收到一条被判定为"要你交东西"的通知**）。
**铁律不变**：同一提示一生只出现一次、可永久关闭、绝不打断输入焦点。**提议不是通知，是一张可预览可拒绝的提案卡**——Vida 的信任飞轮全靠这个。
**加一条 Vida 没解决的**（PH 上 Mustafa Arian 提的 "clone drift"）：偏好会过期。`status: dormant`（超过 `auto_dormant_days` 未被触碰）已在格式里，**要真的用起来——dormant 的偏好不参与主动提议，只参与被动回答**。这条在 V6 之前定死。

---

## 8. 不抄 / 做不到

| 不抄 | 为什么 |
|---|---|
| 常驻心跳捕获 | PRODUCT.md：不做常驻录屏/Recall。纯事件驱动 + 内容指纹足够 |
| `include_screenshot` 默认开 | 默认本地，显式开关 |
| 锁死单一模型 | 相对 Google/MS/Vida 唯一的结构性差异，不能自己放弃 |
| 底部大胶囊输入条**取代**划线 | 那是他们没有指代能力的代偿——只能取整个前台窗口，所以必须靠模型猜你说的是哪个。剪刀那种"取一块屏幕"可作补充入口，但不能覆盖划线 |
| 112 秒的交付 | 按 flush 设计（每 5 分钟增量 reduce），**你开口前 95% 已经算完**，只剩最后一个窗口+汇总，目标 <10 秒。**这不是优化，是把成本挪到闲时** |
| 306 MB 安装包 | 浏览器执行走用户已装的 Chrome + DevTools/扩展，不打包内核 |

**做不到 / 不该做（诚实部分）**：第三方 SaaS 服务端数据（Slack 全历史、Notion 全库）——不做 OAuth，靠 MCP client 转接，**用户没配 MCP server 时这块就是空的**；文档/幻灯片/表格/图片生成——三个母动作一个都不是；macOS——Swift host 没实机验过权限/多屏坐标/签名公证；**微信、钉钉这类读不到内部消息的，回复类用例做不了，别硬来**。

**他们的软肋**：PH 上没答严实的四问（记忆是全局还是按工作区？能否查看编辑？在本地还是他们服务器？clone drift 怎么办？）；隐私三条**无审计背书**，且政策 2.2 白纸黑字写着桌面上下文会传第三方模型商——**"本地优先"说的是记忆文件，不是上下文**；**OpenChronicle 只有 macOS**，`mac-ax-watcher` 是 Swift 二进制、`install.sh` 要 Xcode CLT。§5 那个惰性激活的坑他们必然也要踩。

---

## 9. 来源

官网 https://vida.app/zh-CN/desktop/ ｜ 演示原片 `download.einsia.com/web/cases/sota-achieved/{ReplyRescue,PromptRescue,ResumeRescue,WorkspaceCleanup,DailyWrap}.mp4` ｜ 版本元数据 `download.einsia.com/vida-dmg/releases/0.6.3/latest{,-mac}.yml` ｜ 定价 /zh-CN/pricing ｜ 隐私 /zh-CN/privacy ｜ **OpenChronicle** https://github.com/Einsia/OpenChronicle（设计文档在 `docs/{architecture,capture,timeline,session,writer,mcp,memory-format}.md`）｜ **Browser-BC** https://github.com/Einsia/Browser-BC ｜ 论文 arXiv:2606.32014 ｜ PH https://www.producthunt.com/products/vida-5 ｜ 网易实测 https://www.163.com/dy/article/L0KGPR0N0556I7IY.html ｜ 01Founder https://mp.weixin.qq.com/s/1WVORtB06uplG1q36De7Zw

**本机实验数据**：`%TEMP%\vida_verify\`（`run.log` E1/E2/E3、`e4.log`、`e5.log`、`e6.log`、`results.json`、`e6.json` + 每次探针的完整树 dump）。复现脚本 `%TEMP%\vida_verify{,_e4,_e5,_e6}.py`，全部只读、只调 `scripts/uia_tree_dump.py`。
