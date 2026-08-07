# CLICKY.md — clicky 指针陪伴接入设计（v2，含诚实审计）

> 目标：把 clicky 生态（`external/clicky` / `clicky-windows` / `clacky` / `openclicky`，全部 MIT）**融入** Magic Pointer，作为可挂载模块交付。P3 #6，见 `docs/ROADMAP.md:32`。
> v2 修订原因：v1 把项目已有能力当成 clicky 增量在"抄"，方向搞反了。本版先做事实审计，再定接入方案。

---

## 0. 事实审计：我们已经有 vs clicky 真正多

### 0.1 项目已有的（不要再当成 clicky 的价值）

| 能力 | 现状 | 出处 |
|---|---|---|
| **三级感知级联** | 已有且更强：UIA / Chrome DevTools DOM / Office COM → 常驻 OCR worker → 视觉（OmniParser + 授权视觉模型），比 `hybrid_pointer.py` 多 DOM/COM 两层，且有 `marked_read` 命中判据 | `docs/ARCHITECTURE.md:19-31` |
| **[POINT] 指点** | 已完成（P3 十二项之一），含越界丢弃安全规则 | `docs/STATUS.md:28`、`app/text_actions/point_markers.py` |
| 记忆层 / 剪贴板历史 / 本地 STT（SenseVoice+Whisper）/ 写回三级 / Dashboard 审计 | 均可用 | `docs/STATUS.md:13-26` |
| 点探器（坐标→元素矩形） | 已有，且声明"geometry at a point, nothing else" | `scripts/element_probe_bridge.py:2` |

### 0.2 clicky 真正多出来的（全仓 grep 核实过，这才是接入对象）

| 增量 | 证据 | 来源文件 |
|---|---|---|
| **① 反向解析：语言查询→坐标** | 我们 grep `find_target\|locate_element` 零命中；`element_probe_bridge` 只认坐标不认查询。"保存按钮在哪"→(x,y) 这条路不存在 | `clicky-windows/ai/hybrid_pointer.py`（`Target` 契约 + `_score_match` 模糊评分 + 3500节点/40深度上限） |
| **② 常驻伙伴光标** | 我们只有 gesture 期间的蓝点，overlay 空闲即隐藏；没有"住在光标旁边"的形态 | `clicky/leanring-buddy/OverlayWindow.swift`（四态 + 贝塞尔飞行 + 永久穿透） |
| **③ 语音输出端（TTS）** | 生产代码无 TTS（仅 2 个 verify 脚本提到过）；语音闭环只有输入半边 | 新增 `app/companion/tts.py`（edge-tts 默认 / SAPI 兜底，全免费） |
| **④ 教学回合 + 单通道时序** | 我们的 [POINT] 是"画完开气泡、事后画箭头"；没有"边说边指"、没有 next/repeat/stop 指令集 | `clacky/clacky/shell/tour.py:29-120`（标签时机从语音文本位置推导，单通道不漂移；`_fire_main_point`：说话开始才发射） |
| **⑤ 每 tier 时间预算纪律** | 我们的级联没有写明每级预算数字；clicky 的 5ms/300ms/1-3s 可直接当验收标准 | `hybrid_pointer.py` 文件头注释 |

**接入的本质 = 把这 5 个增量挂进我们已有的级联/气泡/语音/执行设施上。** 不是把 clicky 搬进来，是把它的"伙伴形态 + 反向解析 + 输出端"长在我们的地基上。

---

## 1. 挂载架构

```
┌─ Electron 主进程 ─────────────────────────────────────────┐
│  main.js ──(buddy.enabled 时懒加载)──▶ electron/buddy/     │
│    · 光标位置：复用 wiggle 轮询流（不新增任何 hook）        │
│    · STT：复用 voice_resident_runtime.js                    │
│    · gesture session 开始/结束 → buddy:park / buddy:resume │
│    ▼                                                        │
│  buddyWindow：纯视觉、永久穿透、永不拦截输入                 │
└──────────────────────────────────────────────────────────┘
        │ stdin/stdout JSONL（_bridge_common.py 契约）
        ▼
┌─ scripts/buddy_bridge.py（常驻，python_runtime.js 拉起）───┐
│  状态机 idle→listening→processing→responding               │
│  语言查询 → point_resolver（复用既有级联，新增反向入口）     │
│  模型走 ai_client.py（流式）→ [POINT] 由 point_markers.py 解析│
│  TTS → edge-tts / SAPI                                     │
└──────────────────────────────────────────────────────────┘
        │ 感知复用（不新建链路）
        ▼
  app/grounding/（UIA/DOM/COM→OCR→视觉）· app/fabric/ · app/actions/
```

### 新增文件（克制版——v1 的 6 个 Electron 文件压到 3 个）

| 文件 | 职责 |
|---|---|
| `electron/buddy/buddy_module.js` | 生命周期 + 状态机 + park/resume（v1 拆成 module/state 两个文件，合并） |
| `electron/renderer/buddy.html` + `buddy.js` + `buddy.css` | 三角/波形/spinner/气泡 + 贝塞尔飞行 + spring 跟随（运动算法内联，可单测） |
| `scripts/buddy_bridge.py` | 常驻服务 main loop |
| `app/companion/__init__.py` | 包 |
| `app/companion/point_resolver.py` | **反向解析**：query→Target。tier 顺序直接调既有设施（见 §2.1），不是重抄级联 |
| `app/companion/tutor_loop.py` | 教学回合：next/repeat/stop、单回合记忆 |
| `app/companion/tts.py` | edge-tts / SAPI provider |
| `electron/settings_store.js` 追加 `buddy` 段 | `{enabled:false, hotkey, tts_engine, slow_mode}` |

**不改 `point_markers.py` 建第二套解析器**：v1 说"[POINT] 解析统一进 point_resolver"是错的。正确做法是 buddy_bridge 直接 `import` 现有 `point_markers`，它的越界丢弃规则原样保留。clicky 的 `[POINT:x,y:label:screenN]` 语法只在我们 prompt 里约定，解析时归一化成现有 `[POINT x,y]` 再进 point_markers。

---

## 2. 适配层：中间问题的解法

### 2.1 反向解析怎么挂进既有级联（核心适配点）

`point_resolver.find_target(query) -> Target{bbox,label,source,confidence}`：

```
tier-1  结构层：UIA 探针按 Name/AutomationId/HelpText 模糊评分
        → 复用 scripts/uia_selection_probe.cs 的通道，加一个 by-name 查询模式
        → P0 的 C# 常驻探针落地后切过去（Target 契约不变，无缝换引擎）
tier-2  常驻 OCR：ocr_resident_worker.py 的块缓存里做文本模糊匹配（不重跑 OCR）
tier-3  视觉网格：仅 visionInput=yes 且授权时；复用 universal_locator 两级网格模式
吸附    物理坐标 → ControlFromPoint → 仅小控件（≤600×360）、nudge≤30px、
        远跳=容器则保留原坐标（tour.py:54-83 三条判定原样搬）
```

**与既有级联的关系**：既有级联是"笔画→这块是什么"（正向），反向解析是"词→它在哪"。两条路共享同一个 UIA/OCR/视觉底座，但入口相反——所以是**在底座上加一个查询入口**，不是新级联。

### 2.2 输入互斥：buddy 与晃动划线

buddy 窗口永久 `setIgnoreMouseEvents(true,{forward:true})`，**永不参与输入仲裁**。语义层互斥：gesture session 开始 → 主进程发 `buddy:park`（隐藏+状态挂起），结束 → `buddy:resume`。PTT 按住期间检测到 wiggle 以 gesture 为准（wiggle 链路有既有冷却与门槛，buddy 不加新规则）。
验收：划线全程 buddy 不出现不闪烁；PTT 说话时晃动不双触发。

### 2.3 坐标空间

规则不变：**一切坐标过 `electron/coordinate_space.js`**。模型给的是截图空间坐标，Target 给的是逻辑坐标，两条换算链分开走，互不交叉。不抄 tour.py 的 `_point_to_logical`（它没有我们的 200% 缩放处理）。

### 2.4 截图策略

默认路径零截图（tier-1/tier-2 不需要）。仅教学指点需要全局布局时才截：走 `app/fabric/capture_policy.py` 门控（密码/银行窗口跳过——把 clicky-windows 的 Privacy Guard 名单并进 capture_policy，不新开模块）、JPEG 压缩、仅发视觉已配置的模型。

### 2.5 语音

输入复用（不引 AssemblyAI/Deepgram）。输出新增 `tts.py`：edge-tts 默认（免费、中文语音全）、SAPI 兜底（断网可用、首音更快）。**气泡文字先流式出现，声音后到；Esc 全链路取消（<50ms），不走模型。**

### 2.6 模型纪律

走 `app/ai_client.py`，交互路径必传 `timeout_s`+`attempts=1`+`max_tokens`。buddy 是 P1"模型改流式"的首个消费方；非流式时整包出（3–6s，可接受不宣传）。

### 2.7 命名与窗口形态

- `main.js:1243` 已有 `companionWindow`（聊天侧栏「随行」）。**新模块一律命名 `buddy`**，禁止 companion。
- **窗口形态：倾向全屏静止透明窗（每屏一个），只改内容不动窗口**——依据见 §5.5.1：飞行目标无界，小窗在飞行瞬间的跳变/resize 才是真闪烁源。注意两条既有坑：不与 gesture overlay 的 show/hide 周期纠缠（buddyWindow 只在启用/禁用/park 时动）；渲染内容限定在无手势语义。落地时仍跑一轮交替 A/B（帧间隔 + CPU + GPU），验证而非选型。

### 2.8 常驻组件与第三个 hook

- buddy 零新增 hook（位置复用 wiggle 轮询流）。
- selection-hook（选中动作条 + "选中即解释"入口共用）归属**主进程统一管理**，按 ROADMAP:32 互斥状态机执行（划线时 stop、结束延迟 ~400ms 再 start）；buddy 只订阅 `selection-changed` 事件，不直接持有 hook。选中文本不落盘不进日志不进遥测。
- bridge 死亡按 `python_runtime.js` 退避重启，状态回 idle 并告知（fail-closed）。

---

## 3. 性能与反应预算（含硬依赖标注）

| 环节 | 预算 | 硬依赖 / 降级口径 |
|---|---|---|
| 跟随光标（spring） | 帧 ≤16ms，滞后 <80ms | 复用 wiggle 轮询流；窗口形态 A/B 实测后定 |
| PTT→listening 视觉 | <100ms | voice runtime 常驻 |
| 松手→转写 | 300–700ms | SenseVoice 既有数字 |
| 提交→首 token→气泡首字 | <2s（流式） | **依赖 P1 流式改造**；未做前整包 ≤6s 不宣传 |
| 反向解析 tier-1 | ≤50ms | **依赖 P0 C# 常驻探针**；未落地前 Python 探针 199–975ms，预算降级 ≤1s 并在文档明示 |
| tier-2 OCR 缓存匹配 | ≤50ms | 读常驻 worker 缓存，不重跑 |
| tier-3 视觉 | 1–3s | 仅授权+视觉模型已配 |
| TTS 首音 | edge-tts ≤1s / SAPI ≤300ms | 新组件 |
| Esc 中断 | <50ms | 取消令牌链 |

铁律：①视觉反馈永不等待模型；②指点永不早于说话（`_fire_main_point` 条件）；③失败必说进已打开的气泡，禁止静默。

---

## 4. 落地顺序（修正依赖后）

| 阶段 | 内容 | 依赖 | 完成标志 |
|---|---|---|---|
| 1 | buddy 视觉壳：窗口 + 四态 + 贝塞尔飞行 + 跟随（无后端） | 无 | 窗口形态 A/B 实测有数据；单测绿（飞行端点/超界/状态转移表） |
| 2 | `buddy_bridge.py` + tutor_loop + TTS + [POINT] 复用 point_markers | 无 | 真机：按住说话→气泡流式（或整包）→边说边指→Esc 停 |
| 3 | `point_resolver.py`：tier-1 用现有 Python 探针（≤1s 降级预算）+ tier-2 OCR 缓存匹配 + 吸附 | 无 | 单测：查询命中/双失/容器拒绝/30px 边界；真机"保存按钮在哪" |
| 4 | gesture 互斥（park/resume）+ capture_policy 门控 + preflight + 设置页 | 无 | 划线全程 buddy 不干扰；禁用后进程零残留 |
| 5 | P0 C# 常驻探针落地后，tier-1 无缝换引擎（Target 契约不变） | **P0** | 交替 A/B：tier-1 199–975ms → ≤50ms |
| 6 | 长稳：8h 常驻 + 多屏 + 200% DPI + 微信自绘窗 + §3 全表 A/B 核对 | 全部 | 每项预算有 A/B 证据 |

**为什么视觉壳先做**：它不依赖 P0/P1，能最先真机暴露窗口形态问题；resolver 的 tier-1 降级版（≤1s）能跑通完整链路，P0 落地后只换引擎不换契约。

---

## 5. 稳定性与红线对照

1. 默认关闭、onboarding 明示三项权限用途、禁用即全量回收。
2. preflight 扩展：python runtime / UIA 探针 / TTS 引擎 / 截图权限，失败保持关闭并说明原因。
3. fail-closed：查询全 tier 失败→"没找到，请描述位置"；bridge 崩→退避重启回 idle。
4. 命名 `buddy`（companion 被占）；buddyWindow 永不拦截输入；`overlay.js` 零改动。
5. 隐私：无剪贴板读取、选中文本三不进（盘/日志/遥测）、截图过 capture_policy。
6. 契约变更必带测试钉子；性能对比必须交替 A/B（本机漂移 200ms，顺序对比无效）。
7. 真机冒烟不可省：多屏 + 高 DPI + 微信 + 8h 常驻。

---

## 5.5 定位精度核查（为什么准、分辨率怎么管、弱模型会不会崩）

> 本节是对 clicky 三个仓库定位实现的源码级核查结论，作为 point_resolver 的设计约束。

### 5.5.1 为什么全屏窗（这个问题已有定论，A/B 侧重验证而非选型）

clicky 选全屏静止窗的真实原因（`OverlayWindow.swift`）：绘制区域无界——贝塞尔飞行目标是屏幕上任意点，小窗在飞行瞬间必须跳变/resize，而窗口移动是窗口管理器级操作（Windows 上 `SetWindowPos`+DWM 重组会闪烁）；静止全屏窗里改内容只是 GPU 图层更新。附带收益：窗口坐标系=屏幕坐标系（每帧零换算）、穿透一次设置终身有效、多屏每屏一窗避开异构 DPI。**结论：倾向全屏静止窗 + 只改内容；A/B 只验证性能，不再纠结形态。**

### 5.5.2 精度来源：不是模型准，是架构准

| 实现 | 机制 | 精度 | 模型依赖 |
|---|---|---|---|
| `element_locator.py` / `.swift` | Claude Computer Use：beta header + `computer_20251124` 工具激活像素计数训练；坐标在声明分辨率空间返回 | ~5px | **仅 Anthropic** |
| `universal_locator.py` | 两级 Set-of-Mark：12×8 编号格选一 → 裁 3×3 区域放大 ≥768px → 6×6 细格再选一，取中心 | 25–50px | 任意视觉模型 |
| `hybrid_pointer.py` + `tour.py` | UIA 精确命中 → OCR 文本命中 → 视觉网格兜底；最后 `ControlFromPoint` 吸附小控件中心（nudge≤30px） | 像素级 | 前两级零模型 |

全屏分辨率大不是问题：**没有任何环节让模型在大图上数像素**。Claude 路线归一化到 ~1MP（源码注释："Higher resolutions get downsampled by the API and degrade precision, so these are intentionally small"）；通用路线把定位分层成"小图里选格子"；前两级干脆不用模型。

三条铁律（抄进 point_resolver）：
1. **声明分辨率=实发图像素数**（clicky 的 Retina bug：lockFocus 在 2x 屏把图放大两倍、声明不变，坐标尺度全错）。
2. **宽高比匹配，禁止扭曲**（16:10 硬塞 4:3 显著毁 X 轴精度）。
3. **模型坐标只是初值**，能吸附就吸附，不可信就丢弃。

### 5.5.3 模型分辨率差异的管法

clicky 的分辨率参数是按模型特化的，不能全家共用：CU 三档（1024×768/1280×800/1366×768）仅 Claude 有效；`MAX_INFERENCE_WIDTH=1280` 之上各模型编码器约束不同（Claude 长边 ~1568px、GPT-4o 512px tile 上限 2048²、Gemini 768² tile、Qwen2-VL 动态分辨率 ~1MP 默认、LLaVA 类 CLIP-336/448）。

**我们的做法：扩展 `app/models/profiles.py` 的 `ModelProfile`（已有 `visionInput` 位）加视觉画像**：

```json
"vision": {
  "max_long_edge": 1568,
  "target_pixels": 1000000,
  "grid": [12, 8],
  "crop_upscale_to": 768,
  "can_pixel_count": false,
  "prompt_lang": "zh"
}
```

定位器按画像取参，禁止硬编码。未知模型按最保守档（6×4 网格 + 强制裁剪放大）。落在 ROADMAP P0-3"模型能力持久化"既有决策上。

**第一块已落地（2026-08-07）**：`app/ai_client.py:classify_vision_capability`（移植 `external/claude-code-vision-skill`）——纯文本模型黑名单（deepseek/glm-5 非 v 线/kimi-k2-/hy3/qwen3-coder）在视觉调用前诚实拒绝，未知模型不拦截；配套 `tests/vision_capability_test.py`。这是视觉画像的最小版本：**会拒绝的已知纯文本 + 放行的未知**。完整画像（分辨率/网格密度/坐标能力）仍按上文扩展。

### 5.5.4 弱国产多模态模型：会崩什么、不崩什么

会崩（必须按模型画像调参）：
1. Computer Use 整路失效（Anthropic 私有工具），弱模型裸坐标预测无效（hybrid_pointer 文档字符串自述原因）；
2. 12×8 网格在 CLIP-336/448 编码器上数字不可读 → 降密度到 6×4、大字号、裁剪放大转强制；
3. JSON 约束输出不稳 → 放宽解析（整数扫描兜底）、中文提示词、放宽 400 字符截断；
4. 两级两次调用 × 慢端点 → 撞 8–12s 墙钟，超预算直接放弃视觉层。

不崩（我们的结构性优势，弱模型下反而更稳）：
1. tier-1 UIA / tier-2 OCR 与模型无关，大多数窗口走不到视觉层；
2. 零元件窗口几乎总有用户笔画 bbox——**搜索区裁到笔画邻域再画网格**，分辨率压力消失（clicky 必须全屏语言搜索，我们有人机协同聚焦）；
3. 零元件窗口已有 OmniParser 元件框（`app/vision/visual_elements.py`）——**给元件框编号让弱模型"多选一"**，不做自由定位。读数字+语义匹配是弱 VLM 能做好的，自由坐标才是它做不好的；
4. 兜底纪律：`point_markers.py` 不可信即丢弃——弱模型下丢弃率升高是正确降级，绝不出错箭头。

---

## 6. 一页速览

```
先审计再动手：
  三级级联=[我们已有，更强]   [POINT]=[已完成]   记忆/STT/写回=[已有]
  clicky 真正多的只有 5 样：
    ①语言查询→坐标（反向解析）  ②常驻伙伴光标  ③TTS 输出端
    ④教学回合+边说边指时序      ⑤每级时间预算数字

挂载：
  electron/buddy/*（全屏静止透明窗、永久穿透、每屏一个——依据 §5.5.1）
  scripts/buddy_bridge.py（常驻）+ app/companion/*（纯逻辑）
  解析复用 point_markers.py，不建第二套；级联复用 grounding，不建第二条

顺序：
  视觉壳 → 对话闭环 → 反向解析（Python 探针降级跑通）→ 互斥/门控
  → P0 落地后换 tier-1 引擎 → 长稳 A/B

命名 buddy（companion 已被占用，main.js:1243）。
默认关闭。开了能摘。划线时它退让。说话才指点。失败必说人话。
```
