# Magic Pointer HCI 系统级审查与 GUI/HUD 落地规格（2026-08-15）

> 审查对象：指针引导 Grounding 感知链 + 当前 GUI 交付稿（提交 `e48a469` 的
> `stage.css` / `studio.css` / `oreo_tokens.css` / `icons.ts` / `cards.css`）。
> 审查方式：逐文件核对实现与文档（母文档 §18 账本、`docs/STATUS.md`、
> `VIDA_UI_SPEC.md`、2026-08-13 最强模型回应、2026-08-14 重建规格、
> 2026-08-15 Oreo Stage/Studio 设计与 faithful rebuild 计划、Agent 社区需求调研）。
> 结论状态：本文件是审查 + 规格，不改运行时行为；T1–T12 落地须按 §4 逐批测试先行。
>
> 一句话总判：**感知链的"证据可信"已经做对（八态、围栏、显式截断、五路锚点），
> 缺的是"空间结构化注入"与"给 UI 消费的状态流"；GUI 的浅色纸面体系刚做完第一轮，
> 主体合格，但 Stage 结构化结果块仍残留整套暗色石墨调色板，直接违反"严禁全黑/暗黑"，
> 是最高优先级的视觉债。会话导轨、指针 HUD、Refocus/Visual Diff 三块目前为零，
> 下面给出可直接开工的像素级与状态机规格。**

---

## 1. 感知层与 Grounding 审查

### 1.1 现状事实（核对到文件的结论）

1. **证据注入形态**：`scripts/selection_bridge.py` `_bridge_evidence_block` 以
   `<<<MAGIC_POINTER_EVIDENCE>>>` 硬围栏包裹，`_LOOP_EVIDENCE_LIMIT = 60000` 字，
   截断以手势点为中心取窗并显式告知（第 2423–2433 行）。这是 2026-08-13 强模型
   评审 Q3 裁决的执行结果：小模型 + chat-completions 协议下**不建原生结构化工具通道**。
   本规格尊重该裁决：结构化元数据以**围栏内紧凑 JSON** 形态出现，不伪造 tool_call。
2. **坐标现状**：FrameLease 携带 `surfaceBoundsPx` / `scaleFactor` / `displayId`；
   手势逐点转物理坐标后提交。已知存疑点（`docs/STATUS.md` §已知未修 1/3）：
   Stage 的 screen→window 换算在高 DPI（本机 200%）未经真机验证；证据高亮带
   沿用同一套换算。UIA/OCR/像素三路的 bbox 没有统一的"单空间归一化"约定。
3. **噪声过滤现状**：`app/evidence/contract.py` 有反容器启发式（容器名不能冒充正文）；
   UIA 探针按选区→点命中→document_text→区域元素读取；`perception_trace` 记录每路
   attempt 的成败。但**没有节点级属性白名单**——区域元素路径会把装饰容器整体带进
   上下文，剪枝发生在"文字合并"层面而非"节点裁剪"层面。
4. **时空关联现状**：多轮对话里，上一轮的手势锚点只以"对话文本"形式存在于 loop
   历史（compaction 阈值 70%），没有可注入的**结构化指代缓存**。"右下角的表格"
   这类代词指代目前只能靠模型从上一轮证据正文里自行猜位置。
5. **状态流现状**：`scripts/bridge_progress.py` 的 `PhaseClock.mark()`（
   `@@mp phase=… ms=…`）与 loop 事件流（LoopStart/ToolCallStarted/BudgetRenewed…）
   已存在且已通到 UI 心跳——这正是 HUD 状态胶囊唯一需要的数据源，不需要新造链路。

### 1.2 审查发现（每条：事实 → 问题 → 修法）

| # | 发现 | 修法 | 优先级 |
|---|---|---|---|
| F1 | 证据块是**纯文本**：bbox/置信度/来源不进入模型，空间先验只能靠文字暗示；模型对"附近/第二行/下方"没有数字依据 | 围栏内注入 §1.3 Schema：归一化坐标 + 锚点 + 节点表，序列化为紧凑 JSON | P0 |
| F2 | 三路证据坐标空间不统一（物理 px / DIP / 归一化），高 DPI 下换算存疑未真机验证 | Schema 强制单一归一化空间（1000×1000），换算只在确定性层做一次；真机验证 200% 桌面 | P0 |
| F3 | 节点注入无属性白名单与数量上限，区域路径会把装饰容器带进 prompt，token 密度不可控 | 每节点只留 Role/Name/BBox/State/来源/置信度/覆盖率/深度/子节点数；默认 16 节点、硬上限 24 | P0 |
| F4 | 代词指代无时空衰减模型，"这个区域/右下角的表格"跨轮失效风险 | 会话级 DeicticAnchor 缓存（最近 3 条，180s 半衰衰减，窗口/拓扑变化即失效），注入前 2 名 | P1 |
| F5 | 截断诚实性已做（字数+read_around 提示），但**剪枝不诚实**——模型不知道哪些节点被丢 | Schema `pruning` 节显式报告丢弃数与原因（与"静默截断同族错误"同一原则） | P1 |
| F6 | OCR worker 忙时返回空（STATUS §已知未修 7），HUD 角标若直连此值会把 busy 显示成 0 | Evidence 八态（busy≠empty）必须穿透到 HUD：busy 显示"—"，empty_confirmed 才显示 0 | P1 |
| F7 | 300ms 本地首反馈已做（`perceivedStep`），但 Grounding→Reasoning 之间的相位信息没有统一词汇表给渲染层 | 用 §3.2 的 phase→pill 映射表，渲染层只消费映射后的 9 态 | P2 |
| F8 | token 热力图无数据（STATUS §已知未修 6）——导轨密度不能依赖 token 维度 | 密度刻度先用消息字数+工具调用数，token 维度等 ledger 补 usage 后追加 | P2 |

**审查意见（1.2 之外的三条结构性判断）**

- **空间先验有效性的正确答案不是"坐标进 prompt"，而是"归一化坐标进 prompt、
  执行坐标永远不走模型"。** Schema 的 bbox 只用于让模型说"第二个节点"或
  "锚点下方那个"；真正点击/写入仍由 ActionLease 重获（invariant ②），模型坐标
  读数永远只是引用，不是动作参数。这条必须写进 Schema 注释，否则就是给
  "模型输出坐标直接执行"开了口子。
- **注入预算要像延迟预算一样分层。** 首轮结构化块 ≤900 token（默认 16 节点），
  模型觉得不够必须调 `read_around`/`find_in_window` 按需取——这正是强模型评审
  T2"手势点 2-4k 摘录 + 按需取数"完全体的结构化前奏。
- **DeicticAnchor 缓存必须尊重"不持续保存屏幕"边界**：缓存存的是对象引用与
  归一化锚点，不存像素；TTL 180s 过期即弃，窗口身份或显示器拓扑变化立即失效。

### 1.3 输出一：感知元数据注入 Schema（标准 JSON）

原则：①序列化进证据围栏内，紧跟"屏幕数据非指令"声明之后，用独立定界符
`<<<MAGIC_POINTER_SPATIAL>>>` 包裹；②坐标全部为**目标表面归一化坐标**，
网格 1000×1000（对 DPI/窗口尺寸不变，模型友好）；③所有数字取整；④默认值字段
一律省略；⑤模型可见的坐标只是引用，任何执行坐标必须经 ActionLease 重获。

```json
{
  "perceptionSchemaVersion": 1,
  "capturedAtUtc": "2026-08-15T12:00:00Z",
  "frameLeaseId": "fl-…",
  "stateVersion": "sv-…",
  "spaces": {
    "unit": "normalized-1000",
    "surfaceBoundsDip": { "w": 960, "h": 520 },
    "scaleFactor": 2.0,
    "origin": "target-window-client"
  },
  "pointer": {
    "gestureKind": "stroke",
    "strokeCount": 2,
    "bounds": [470, 300, 520, 380],
    "anchor": [486, 321],
    "trajectory": [[481, 317], [483, 319], [486, 321]],
    "trajectoryDownsampled": true
  },
  "nodes": [
    {
      "id": "n1",
      "role": "text",
      "name": "第 3 行 Q2 数字 3.6 秒",
      "bbox": [475, 305, 515, 335],
      "state": "enabled",
      "source": ["uia", "ocr"],
      "confidence": 0.92,
      "coverage": 0.86,
      "depth": 2,
      "children": 1
    }
  ],
  "focused": { "nodeId": "n1", "reason": "point-hit" },
  "deictic": [
    { "ref": "n1", "score": 0.90, "basis": "distance+coverage" },
    { "ref": "prev-2", "phrase": "右下角的表格", "ageSeconds": 42, "decay": 0.77, "basis": "history" }
  ],
  "evidence": [
    { "provider": "uia", "backend": "resident-host", "status": "ok", "latencyMs": 212, "confidence": 0.90 },
    { "provider": "ocr", "backend": "resident-ocr", "status": "busy", "latencyMs": 0, "confidence": 0 }
  ],
  "pruning": { "droppedNodes": 17, "droppedRoles": ["grouping"], "reason": "non-interactive-decorator" }
}
```

字段规范表：

| 字段 | 类型 | 必填 | 语义与剪枝规则 |
|---|---|---|---|
| `perceptionSchemaVersion` | int | 是 | Schema 版本，渲染/桥双端校验 |
| `spaces.unit` | string | 是 | 固定 `normalized-1000`；换算只发生在确定性层 |
| `spaces.surfaceBoundsDip` | {w,h} | 是 | 目标表面逻辑尺寸（DIP），供模型估计真实比例 |
| `spaces.scaleFactor` | number | 是 | DPI 缩放，模型可推算物理尺度 |
| `pointer.bounds/ anchor` | [x,y,w,h] / [x,y] | 是 | 手势语义区与焦点，全部归一化取整 |
| `pointer.trajectory` | [x,y][] | 否 | 降采样 ≤16 点；仅当多笔/形状影响语义时注入 |
| `nodes[]` | array | 是 | **唯一允许的属性**：id/role/name/bbox/state/source/confidence/coverage/depth/children。name 截断 16 字（CJK）或 32 字符；role 归一化为 12 个白名单值（text/button/input/link/list/item/image/file/table/cell/heading/container/semantic-object） |
| `nodes.state` | enum | 是 | enabled/disabled/hidden；hidden 节点默认不进列表，进了要带 reason |
| `focused` | object | 是 | 点命中/选区命中的主对象；无命中时省略 |
| `deictic[]` | array | 否 | 每会话最近 3 条锚点；`decay = max(0, 1 − ageSec/180)`；仅注入 decay>0.3 的条目 |
| `evidence[]` | array | 是 | 一路 provider 一行；**status 用 Evidence 八态原词**（ok/degraded/empty_confirmed/busy/timeout/unsupported/denied/error），busy≠empty |
| `pruning` | object | 是 | 丢弃数与原因必填——诚实性原则，模型必须知道有东西被剪掉 |

节点裁剪顺序（当预算不够时）：先丢 depth>2 的容器 → 再丢 coverage<0.3 → 再丢
state=disabled → 最后按 coverage 升序丢，保底 6 个节点。任何裁剪都更新 `pruning`。

Token 预算（预估，按 1 CJK 字 ≈ 1 token）：

| 组 | 预算 |
|---|---|
| spaces + pointer + evidence + pruning | ≈ 160 |
| 单节点（16 字名 + 全字段） | ≈ 35–40 |
| 默认 16 节点 | ≈ 600 |
| deictic 前 2 条 | ≈ 40 |
| **默认总预算** | **≤ 900 token** |
| 硬上限（24 节点） | ≤ 1400 token，超出即按裁剪顺序丢节点 |

---

## 2. 浅色系桌面 GUI 审查

### 2.1 色彩系统与层级分界

**总体合格项（不再返工）**：`oreo_tokens.css` 的纸面体系——`--card #FFFFFF` 纯白
表面、`--paper #F2F1ED` 暖纸底、`--hairline rgba(23,23,15,.08)` 1px 低对比分割线、
三层低饱和暖阴影、无一处纯黑描边——与 Oreo/Vida 参考图一致，也满足"纯白 + 高明度
中性灰 + 微阴影分层"的要求。用户给出的 `#F9FAFB / #E5E7EB` 是示例系（Tailwind 冷灰），
不是必须值；当前暖纸系与参考图更接近，**建议保留现状**，把 §2.5 的映射表作为
"若换冷灰系只需改 8 个 token"的证明。

**发现（必须修）**：

| # | 发现 | 事实位置 | 修法 |
|---|---|---|---|
| G1 | **Stage 结构化结果块仍是整套暗色石墨调色板**：错误面、建议 chips、日历/表格/草稿结果卡、compare-table、delivery-bar 使用 `--stage-graphite #0E1116 / --stage-graphite-raised #161B22 / --stage-cold-white / --stage-electric-blue #2F7BFF` | `stage.css:35-41` 定义；`:1061-1218`（.stage-error/.stage-chip/.result-card/.compare-table/.stage-action）、`:1282-1288`（.delivery-bar）使用 | 全部 re-token 到 oreo 语义色：白底卡 + hairline + `--indigo` 强调 + `--green` 成功 + `--terracotta` 失败；删除 5 个 `--stage-graphite*` 变量。**这是"严禁全黑/暗黑"的最大现存违反点** |
| G2 | 本批刚加的"跟随系统主题"会在用户切系统暗色时把整套界面翻黑：`oreo_tokens.css:71-100` 有完整 dark token 块，`settings.ts` 新增 `systemThemeQuery` 跟随，外观页有主题选项 | `oreo_tokens.css:71-100`；`settings.ts`（systemThemeQuery 两处）；`settings_model.ts` 外观页 theme 行 | **删除 dark token 块、删除 theme 设置项与 systemThemeQuery 跟随**；保留"高对比/减少透明/减少动效"。近黑只允许以 `--solid #1A1A18` 实心主按钮形态存在（VIDA `--btn-primary-bg #171619` 同款，是 Oreo 规范内） |
| G3 | 组件级裸色漂移：`.capsule-count` 用 `#edf1ff/#5b5fc7`、`.capsule-send` 用 `#16181d/#2a2e36`、`.stage-brand` 用 `#171717` | `stage.css:1352,1363,1378-1379,283` | 全部改引 token（--indigo-bg/--indigo、--solid/--ink-2），并加静态测试：样式表内除 `:root` 定义外零裸 hex |
| G4 | Composer 阴影是 `0 18px 46px -28px … , 0 2px 8px …`，与令牌 `--shadow-card` 数字不一致（视觉接近但双源） | `stage.css:268` | 统一改引 `--shadow-card`/`--shadow-lift`，阴影只允许三个令牌，禁止手搓第四种 |

**层级分界规范（现行有效部分固化）**：分隔用 `--hairline`（0.08）或 `--hairline-2`
（0.14）1px inset；hover 抬升用 `--shadow-lift`；浮层/模态用 `--shadow-pop`；焦点环
用 `inset 0 0 0 1.5px var(--indigo)`（studio.css:459/542 已如此）。**禁止**任何
`border: 1px solid #000` 或高反差黑边——当前代码全库无此用法，保持。

### 2.2 会话历史与快速导航导轨（Session Scrubbing Rail）

现状：Studio 侧栏是平铺会话行（`.side-item`），无密度可视化；打开对话后无
正文级定位导航。**导轨为零，按以下规格新建。**

**数据缺口（先修数据再画 UI）**：`conversation_store.ts` 的 turn 只有
`at/question/answer/outcome/object`——**工具调用节点、错误中断点、用户编辑点没有
持久化**（loop receipts 只在答案 JSON 里，不落盘）。T9 必须先扩展 turn 结构：
`events: [{t, kind: 'tool'|'error'|'approval'|'edit', name?, ms?}]`，历史 turn 按
`outcome` 字符串推断降级标记。

**两级导轨规格**：

- **L1 列表级密度条**：会话行右侧 44×16px 迷你条，每条 turn 一个 2px 高横刻度，
  左对齐，宽度=密度档（≤40 字 2px / ≤200 字 3px / ≤800 字 4px / >800 字 5px，
  封顶 44px），颜色：普通 `--ink-4`，工具节点 `--indigo`，错误 `--terracotta`（恒 4px），
  审批 `--amber`，用户编辑 `--green`。超过 48 turn 聚合为桶（每桶 4 turn，取最大值+混合色）。
- **L2 会话内擦洗条**：打开对话后，正文右侧 10px 宽竖轨（`.rail`），刻度纵向堆叠
  映射整个会话；当前视口范围画 2px `--ink` 高亮游标；hover 刻度 140ms 后弹 280px 预览卡：
  缩略图（复用 `chat-peek` 的选区预览管线，取该 turn 的 `object` 捕获图，无图用对象
  图标占位）+ turn 时间 + 问题前 2 行 + 工具数/结果标记。点击：正文平滑滚动到该 turn，
  目标 turn 以 `--indigo-bg` 洗底 600ms 淡出。键盘：上下键在刻度间移动，Enter 跳转。
  500+ turn 会话虚拟化渲染，只画可视段。

**验收**：预览卡内容来自落盘事件而非临时推断；错误刻度与 `outcome≠模型` 的 turn
一一对应；hover 不改变会话正文滚动位置。

### 2.3 指针交互与感知层 HUD

现状为零。以下规格**必须**服从两条既有不变量：①`FrameLease.overlayExcluded`——
放大环是 overlay，它的矩形必须在手势期间注册进抓帧排除，pointerup 前 120ms 先消失，
FrameLease 里不能出现它；②常驻进程空闲不扫描——放大环的实时放大图**复用**
`frame_capture_worker` 在 arm 态已经开着的 33ms×8 环形缓冲，不新增常驻抓屏。

**放大环（Zooming Loop）**：

| 属性 | 值 |
|---|---|
| 形态 | 正圆，直径 144px，`--r-pill` 圆角，`--card` 底 + `--hairline-2` 1px 环 + `--shadow-lift` |
| 位置 | 指针上方 24px（贴边时自动翻到下方/侧方，同 Composer 贴边策略） |
| 缩放 | 默认 1.75×；滚轮循环 1.5/1.75/2.0/2.5/3.0；倍率角标 12px mono |
| 内容 | 从环形缓冲最近一帧裁剪指针周围区域，GPU 纹理绘制；帧间平滑 0.35 线性插值（不是物理弹簧，确定性） |
| 十字线 | 圆心处 1px `rgba(23,23,15,.25)` 十字，中心留 7px 圆孔；命中 UIA 元素时中心点换 2px `--indigo` 实点 |
| 边界框脉冲 | 常驻宿主 `ElementFromPoint`（120ms 节流，属手势期显式活动）命中可交互元素时，在 Stage 坐标画 2px `--indigo` 圆角框（元素 bbox），脉冲 = 600ms 放大 1.0→1.02 + 淡出，循环 2 次后静止为常亮描边；元素变化重新脉冲 |
| 角标 Badge | 放大环右上 6px 处 20×16 药丸：当前命中元素数 `N 个`；evidence 状态 busy 时显示 `—`，empty_confirmed 显示 `0`（F6） |
| 显隐 | arm 即出现（跟随光标）；pointerup → 120ms 淡出 → 提交 FrameLease；`prefers-reduced-motion` 下无脉冲、无插值，静态显示 |

**状态胶囊（Floating Status Pill）**：

| 属性 | 值 |
|---|---|
| 形态 | 高 26px，`--r-pill`，`rgba(255,255,255,.86)` + 12px blur，1px `--hairline`，内容 8px 状态点 + 12px 标签 + 可选 11px mono 耗时 |
| 位置 | 附着当前表面（Composer/WorkPanel）底边下方 10px，左对齐；不遮手势区；两表面切换时 120ms 位移过渡 |
| 状态点颜色 | Idle `--ink-4` / Capturing `--indigo` 呼吸 / Grounding `--amber` / Reasoning `--indigo` / Executing `--teal` / Verifying `--green` / AwaitUser `--amber` 慢闪 / Error `--terracotta` / Done `--green` 停留 2s 后淡出 |
| 数据源 | `bridge_progress` 的 `@@mp phase=` 行 + loop 事件流（已通 UI 心跳），映射表见 §3.2；任何映射失败落在 Reasoning 态并记录，**不显示假状态** |

### 2.4 错误边界、回滚指示与 Refocus

现状：Stage 有 error 面（但走 G1 的暗色样式）；Anchor 五路判别（exact/moved/changed/
gone/ambiguous）是一等返回值但 **UI 不消费**。规格：

**Anchor 判别 → UI 动作映射**：

| 判别 | UI |
|---|---|
| exact | 直接继续；无需打扰 |
| moved | 自动按新 bbox 重锚 + 一次边界框脉冲 + pill 上"已重新定位"提示 2s |
| changed | 弹 **Refocus 卡**：琥珀色、文案"目标内容已变化" + [看差异] + [重新指向] + [仍然继续（明示确认）] |
| gone | 弹 **Re-ground 卡**：[重新指向] 为主按钮，[仍然继续] 禁用；重新指向 = 复用当前问题开启新 gesture epoch |
| ambiguous | 候选选择器：前 3 个候选各一行（缩略图 + 名称 + 覆盖率），点选即重锚并重跑前置断言 |

**Visual Diff（执行前后状态差分）**：写回类动作完成后，用 ActionLease 的
`contentFingerprint`（前）与读回校验文本（后）做行级 LCS diff（纯本地，不引新依赖），
在 thread 内渲染 diff 块：不变行 `--ink-2`、新增行 `--green-bg` 底、删除行
`--terracotta-bg` 底 + 删除线；块头一行 mono eyebrow："写入前 → 写入后 · N 行变化 ·
读回校验 ✓"。undo 动作同理反向显示。**diff 数据来自回执层，模型只贡献文案不贡献事实。**

**按钮/图标/排版微交互规范**（现状核对结论）：图标已是 24px 网格、1.5px 圆头描边
（`icons.ts` 全量符合 Lucide 规范），16px 场景按 24 网格缩放渲染，**不引入外部图标库**
（Studio 计划已裁决）；控件过渡现为 140ms 统一值，按下表分档。

---

### 2.5 输出二：像素级排版与交互参数表

#### 2.5.1 色彩 Token（现状值 + 与用户示例系的映射 + 修项）

| 角色 | Token | 值 | 用户示例系等价 | 用途 |
|---|---|---|---|---|
| 主底色（表面） | `--card` | `#FFFFFF` | `#FFFFFF` ✓ | 卡、行、输入、浮层 |
| 次级容器 | `--card-sunk` | `#FAF9F6` | `#F9FAFB`（冷） | 预览区、代码块底 |
| 页面底色 | `--paper` | `#F2F1ED` | —（暖纸系） | 工作区画布 |
| 边框分割线 | `--hairline` | `rgba(23,23,15,.08)`（白底 ≈ `#F0EFED`） | `#E5E7EB` | 1px 分割 |
| 边框强化 | `--hairline-2` | `rgba(23,23,15,.14)` | `#D8D8D4` | hover/焦点前态 |
| 主文字 | `--ink` | `#17170F` | `#111827` | 标题正文 |
| 次文字 | `--ink-2` | `#6B6A62`（白底对比 ≈ 5.2:1） | `#4B5563` | 正文/说明 |
| 弱文字 | `--ink-3` | `#A3A199`（仅装饰用） | `#9CA3AF` | 元信息 |
| 语义·强调 | `--indigo` / `--indigo-bg` | `#5B5BD6` / `rgba(91,91,214,.10)` | — | 焦点、选中、工具节点 |
| 语义·成功 | `--green` / `--green-bg` | `#3D8B5F` / `.11` | — | 读回校验、完成 |
| 语义·警告 | `--amber` / `--amber-bg` | `#B4690E` / `.11` | — | 审批、待决定 |
| 语义·失败 | `--terracotta` / `--terracotta-bg` | `#B44A24` / `.10` | — | 错误、删除行 |
| 主操作实心 | `--solid` | `#1A1A18`（近黑非纯黑） | `#171619`（VIDA 同款） | 主按钮、品牌块 |
| 荧光笔 | `--pen` | `rgba(232,178,26,.38)` | — | 正文命中高亮 |
| 玻璃 | `--glass` / `--glass-lip` | `rgba(255,255,255,.70/.92)` | — | HUD 胶囊、浮层 |

**删除项**：`--stage-graphite*` / `--stage-cold-white*` / `--stage-electric-blue*`
（G1）；`oreo_tokens.css:71-100` 整个 dark 块（G2）。

#### 2.5.2 层级 Z-Index（两个顶层窗口各自成梯，互不竞争）

| 阶梯 | Studio 窗 | Stage 透明覆盖窗 |
|---|---|---|
| 0 | 内容流 | 桌面内容（下层应用） |
| 1 | 选中项浮起 | 冻结辉光/证据亮带 |
| 2 | 页面工具栏 | 划线笔迹 |
| 3 | — | 选区外框 targeting-outline |
| 4 | — | Composer 胶囊（现行 4） |
| 5 | — | WorkPanel 线程面（现行 5） |
| 6 | — | notice/delivery 浮条（现行 6） |
| 7 | — | **放大环 Loupe（新）** |
| 8 | — | **状态胶囊 Pill（新）** |
| 9 | — | **Refocus/Re-ground 卡（新）** |
| 10 | 悬浮预览 peek | — |
| 20 | 保存状态 + toast | — |
| 30 | 辅助详情面板 aux | — |
| 40 | 模态 stash-viewer | — |
| 50 | 全局遮罩 | — |

现行值迁移：studio 30→20、80→20、50→30、90→40；stage 保持 1–6 不动，新件 7–9。

#### 2.5.3 阴影与描边

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-card` | `0 1px 2px rgba(23,23,15,.04), 0 8px 24px -6px rgba(23,23,15,.08)` | 静止卡、选中态 |
| `--shadow-lift` | `0 2px 4px rgba(23,23,15,.05), 0 16px 40px -10px rgba(23,23,15,.12)` | hover 抬升、Loupe、Pill |
| `--shadow-pop` | `0 4px 8px rgba(23,23,15,.06), 0 24px 56px -12px rgba(23,23,15,.18)` | 浮层、模态、预览卡 |
| 分割线 | `inset 0 1px 0 var(--hairline)` | 行间 |
| 焦点环 | `inset 0 0 0 1.5px var(--indigo)` | 输入/选择聚焦 |

规则：三层之外禁止新阴影；禁止 `border + 深阴影` 双保险堆叠（选其一）。

#### 2.5.4 圆角

| 元件 | 值 |
|---|---|
| 控件（按钮/输入/行内 chip） | `8px`（小控件 6px 允许） |
| 列表行/卡片 tile | `10–12px`（--r-chip 10 / --r-tile 12） |
| 面板/工作卡 | `18px`（--r-card） |
| Composer 输入面 | `22px`（--r-input） |
| 药丸（标签/胶囊/分段） | `999px`（--r-pill） |
| Loupe / 发送键 | 正圆（50%） |

#### 2.5.5 排版（字号阶梯收敛为 8 档，正文行高 ≥1.5）

| 档 | 字号 | 行高 | 用途 |
|---|---|---|---|
| eyebrow | 10.5px | 1.2 | 等宽大写小标（`TASK FINISHED` 类，字距 .08em） |
| meta | 11.5–12px | 1.5 | 时间戳、计数、徽章 |
| caption | 12.5px | 1.5 | 辅助说明、行副文本 |
| body-s | 13px | 1.55 | 密集列表（设置行、会话行） |
| body | 15px | 1.6–1.72 | 正文（prose 1.62、文档 1.7） |
| strong | 15.5px/600 | 1.35 | 卡标题 |
| title | 19px/600 | 1.35 | 面板标题 |
| display | 26px/600 | 1.1 | 工作区标题 |

- 基线：`:root { line-height: 1.5; }` 兜底所有未覆盖元素（当前无全局基线）。
- 段落间距：正文块 gap `12px`（0.75em @15px）；卡片内标题到正文 10px。
- 字族：UI `Inter/Segoe UI/微软雅黑`；章节大标题衬线 `--font-serif`（VIDA 规则：
  衬线只用于章节标题）；证据/回执/数字/快捷键徽章等宽 `--font-mono`
  （Cascadia Code/Consolas）。三体并用是识别特征，禁止单一无衬线。
- 等宽 eyebrow 一律大写 + 字距 .08em（VIDA 实测规范）。

#### 2.5.6 关键组件几何与间距（现行实现核对 + 新件）

| 组件 | 几何 | Padding | 备注 |
|---|---|---|---|
| Stage Composer | 480×132 固定（CSS var） | 14 16 12 | 圆角 18，白底 1px 冷描边，双层影（改为引 token，G4） |
| Stage WorkPanel | 560×520 固定 | header 48 / footer 56 / body 20 | 外框全程不变，body 独立滚动（已实现，勿动） |
| Studio 侧栏 | 宽 240 | 18 14 14 | 右缘 1px hairline；会话行高 38 |
| Studio 主区 | — | 22 32 28（header 22 34 18） | 聊天正文列宽 clamp(24,5vw,76) |
| 设置布局 | 左 236 + 右自适应 | 页头 34 28 | 行 12×16，行间 inset hairline |
| 按钮 | 高 34–40（主 40/次 34） | 左右 16 | 见动效表 |
| 会话行 | min-h 38–74 | 12 16 | L1 密度条嵌右侧 |
| L2 擦洗轨（新） | 宽 10，贴正文右缘 | — | 刻度 2–5px，见 §2.2 |
| 预览卡（新） | 280px 宽，`--shadow-pop` | 12 | 140ms 延迟出现 |
| Loupe（新） | Ø144 | — | 见 §2.3 |
| Pill（新） | 26 高，圆角 999 | 左右 12 | 见 §2.3 |

#### 2.5.7 动效时长（按钮 Default/Hover/Active/Disabled + 进出场）

| 场景 | 时长 | 缓动 |
|---|---|---|
| 控件 hover/背景/阴影 | **150ms** | `--ease-out` |
| 控件 :active 按压缩放 | **60ms** | `--ease-out`（不做 150ms 的按压） |
| 面板/卡进场 | **180ms** | `--ease-out` |
| 浮层/模态进场 | 150ms | `--ease-out` |
| 退出/淡出（含 Loupe pointerup） | **120–130ms** | `--ease-out`（VIDA 实测退出 130ms，保持） |
| 导轨 hover 预览卡延迟 | 140ms 后才出现 | — |
| 禁用态 | 无过渡；opacity .34 + cursor default | — |

规则：缓动只允许 `--ease-out/--ease-in-out/--ease-drawer` 三条（oreo_tokens 已定），
禁止手搓新曲线；所有动效只动 transform/opacity/filter；`prefers-reduced-motion`
全部立即稳定（现行 media query 保留）。

---

## 3. 输出三：交互状态转移逻辑

### 3.1 会话擦洗导轨（Scrubbing Rail）状态机

```text
[IDLE 静止]
  ├─ pointerenter(刻度) ──140ms 延迟──▶ [PREVIEW 预览卡显示]
  │     ├─ pointerleave ──────────────▶ IDLE（预览卡 120ms 淡出）
  │     ├─ click ─────────────────────▶ [JUMPING 跳转中]（正文滚动到该 turn）
  │     └─ 数据未加载（旧 turn 无缩略图）─▶ 占位图标态，不阻塞跳转
  ├─ focus(刻度) / ↑↓ ────────────────▶ [KEY 键盘导航]（刻度高亮 1px --indigo 环）
  │     └─ Enter ─────────────────────▶ JUMPING
  └─ 正文滚动（用户/程序）───────────────▶ 游标同步（节流 60ms，只更新位置不触发跳转）

[JUMPING]
  ├─ 滚动完成 ─▶ [WASH 命中洗底]（--indigo-bg 600ms 淡出）──▶ IDLE
  └─ 用户打断（wheel/touch）──▶ IDLE（跳转立即取消，用户优先）

守卫：预览卡数据必须来自落盘 turn.events（T9），不得从渲染层临时构造；
     会话 >500 turn 时刻度虚拟化，PREVIEW 仍按真实 turn 数据渲染。
```

### 3.2 指针 HUD（Loupe + Status Pill）状态机

```text
[IDLE 无手势]
  └─ wiggle/热键唤醒 ─▶ arm：worker 环形缓冲启动 + Loupe 矩形注册进抓帧排除
       └▶ [CAPTURING 划线中]
            ├─ 指针移动（60Hz 渲染）─ Loupe 跟随（0.35 插值）+ 十字线
            ├─ ElementFromPoint（120ms 节流）命中 ─▶ 边界框脉冲（2 次后常亮）
            ├─ 滚轮 ─▶ 倍率循环 1.5→3.0（角标同步）
            └─ Badge 每 120ms 更新命中数；busy 显示 "—"
  └─ pointerup ─▶ [LOUPE-OUT]（120ms 内 Loupe/十字线/脉冲全部淡出）
       └▶ FrameLease 提交（失败 fail-closed 禁重拍，invariant ①）
       └▶ [GROUNDING 感知中]（结构化读取/OCR，phase 流驱动）
            └▶ [REASONING 模型推理]（loop 模型回合）
                 ├─ 工具调用 ─▶ [EXECUTING]（可反复 REASONING⇄EXECUTING）
                 ├─ 读回校验 ─▶ [VERIFYING]
                 ├─ needs_user/permission_required ─▶ [AWAIT_USER 等待决定]
                 └─ completed ─▶ [DONE]（2s 后 Pill 淡出）
                 └─ 任何 terminal 失败 ─▶ [ERROR]（Pill 显示失败原因短语）

守卫：
· Loupe 的每一帧像素都来自环形缓冲（arm 态已有），不新增常驻抓屏（空闲不扫描边界）；
· FrameLease 必须 overlayExcluded=true，且 Loupe 矩形在 commit 前已注销排除；
· phase 映射失败 ─▶ 落回 REASONING 并记 note，禁止显示猜测状态；
· prefers-reduced-motion：Loupe 静态、无脉冲、无插值，Pill 只变色不闪。
```

**Phase → Pill 映射表（唯一词汇表，渲染层只消费右列）**：

| 数据源 | 事件 | Pill 状态 | 状态点 |
|---|---|---|---|
| 手势状态机 | armed/划线中 | Capturing | `--indigo` 呼吸 |
| bridge_progress | `payload_read` / `pixels_frozen` / `structured_read` / `ocr` | Grounding | `--amber` |
| loop 事件流 | `LoopStart` / `TurnStarted` | Reasoning | `--indigo` |
| loop 事件流 | `ToolCallStarted` / `ToolCallFinished` | Executing | `--teal` |
| 动作回执 | verify/readback 阶段 | Verifying | `--green` |
| loop Terminal | `needs_user` / `permission_required` | AwaitUser | `--amber` 慢闪 |
| loop Terminal | 失败 reason | Error（附原因短语） | `--terracotta` |
| loop Terminal | `completed` | Done（2s 淡出） | `--green` |

### 3.3 Refocus / Re-ground / Visual Diff 状态机

```text
[ANCHOR_CHECK 写前/执行前前置断言]
  ├─ exact  ─▶ [PROCEED 继续]
  ├─ moved  ─▶ 自动重锚 → 一次脉冲 → 提示 2s → PROCEED
  ├─ changed ─▶ [REFOCUS_CARD 差异卡]
  │     ├─ [看差异] ─▶ [DIFF_VIEW]（行级 LCS，绿色新增/赭红删除）── 返回
  │     ├─ [重新指向] ─▶ 复用当前问题开新 gesture epoch ─▶ CAPTURING（§3.2）
  │     └─ [仍然继续] ─▶ 明示确认（记审计）→ PROCEED
  ├─ gone ─▶ [REGROUND_CARD 重定向卡]：唯一出口 [重新指向]；[仍然继续] 禁用
  └─ ambiguous ─▶ [CANDIDATE_PICKER 候选选择]（前 3 候选：缩略图+名称+覆盖率）
        └─ 点选 ─▶ 重锚 → 重跑前置断言 → ANCHOR_CHECK

[DIFF_VIEW]（写回后）
  ├─ 读回校验 ✓ ─▶ 块头绿色 mono："写入前 → 写入后 · N 行变化 · 读回校验 ✓"
  └─ 读回校验 ✗ ─▶ 块头赭红 + 差异高亮 + [撤销]（UndoLog 补偿，invariant ⑥）
```

---

## 4. 落地执行清单（测试先行；HERO 范围约束：不引新框架、不加校验和、不加
不必要脚手架；每批完成后按仓库规则跑 fresh 全量验证，最终批才升版本/sync）

| # | 任务 | 改动点 | 先行测试 | 验收标准 |
|---|---|---|---|---|
| T1 | 删除暗色主题全链路 | `oreo_tokens.css:71-100`、`settings.ts` systemThemeQuery、`settings_model.ts` theme 行 | 静态测试：无 `data-theme="dark"` 路径、外观页无 theme 控件 | 系统切暗色后界面仍全浅色 |
| T2 | Stage 结构化结果块 re-token | `.stage-error/.stage-chip/.result-card/.compare-table/.stage-action/.delivery-bar` 及 5 个 graphite 变量 | 静态测试：stage.css 无 `#0E1116/#161B22/#2F7BFF` | 结果卡/错误面/进度条为白底浅色系 |
| T3 | 裸色归零 | `.capsule-count/.capsule-send/.stage-brand` | 静态测试：样式表除 `:root` 外零裸 hex | 全组件走 token |
| T4 | 阴影/层级 token 化 | Composer 阴影引 token；studio z-index 迁移；§2.5.2 阶梯落文档注释 | 静态测试：阴影只出现三个令牌值 | 无手搓第四阴影 |
| T5 | 动效分档 | 全样式 140ms 控件的 hover 改 150ms、:active 60ms | 静态测试按 §2.5.7 表抽查 | 交互节奏一致 |
| T6 | 排版基线 | `:root line-height:1.5`；段落 gap 12px；字号收敛 | 视觉契约测试补行高断言 | 未覆盖元素不再塌行高 |
| T7 | 感知 Schema 注入 | `selection_bridge._bridge_evidence_block` 内嵌 §1.3 JSON（新定界符） | 形状/预算/裁剪顺序/归一化数学（100%/200% DPI 双 fixture） | 首轮块 ≤900 token；裁剪必报 pruning |
| T8 | DeicticAnchor 缓存 | 会话级缓存（3 条 / 180s 衰减 / 窗口与拓扑变化失效），注入前 2 条 | 衰减、失效、跨轮注入测试 | "右下角的表格"二轮命中率可测 |
| T9 | 导轨数据 + UI | `conversation_store.ts` turn.events 持久化；Studio L1 密度条 + L2 擦洗轨 + 预览卡 | 事件落盘、刻度映射、hover 不滚动正文 | §2.2 验收 |
| T10 | Loupe HUD | overlay 渲染层：环形缓冲裁剪放大 + 十字线 + 脉冲框 + Badge；排除注册 | 契约测试：排除矩形注册、pointerup 先于 commit 隐藏 | 人眼两条：帧内无 Loupe、无发黑（STATUS 划线端到端） |
| T11 | Status Pill | 消费 `@@mp phase=` + loop 事件 → §3.2 映射 → 渲染 | 映射表测试：每个 phase 有且仅有一个 pill 态 | 状态滞后 ≤200ms；未知 phase 落 Reasoning 不瞎猜 |
| T12 | Refocus / Visual Diff | Anchor 判别 → §3.3 UI；回执层行级 diff 渲染 | 五路判别→UI 映射测试；diff 行分类测试 | 改/gone/ambiguous 各有正确出口；diff 事实来自回执 |

**交付纪律**：本清单不改运行时行为，不升版本、不 sync；每批落地时按 AGENTS.md
测试先行、fresh 全量验证，真机项（Loupe 排除、DPI、Refocus 实机）单列验收，
自动化通过不得冒充真机通过（invariant ⑦）。
