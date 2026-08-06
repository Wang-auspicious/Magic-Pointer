# Google「add this / and this」底层机制 + Clicky 生态对标分析

日期：2026-07-31
范围：Google DeepMind AI Pointer / Gemini in Chrome / Googlebook；Clicky（farzaa）、OpenClicky（jasonkneen）、
Clacky（Raynan00）、clicky-windows（Bitshank-2338）；专利 US11221823B2（Samsung，语音+指针条件选择）。
结论先给：**Google 的"毫秒级"不是靠画得快，而是靠"语义对象层"（DOM / 可访问性树）——画一笔立刻落到一个结构化对象上，不需要等截屏+OCR。** 语音里的 "add this / and this" 是"动词建一次、指示词+指针逐目标累积"的会话机制，专利里 2017 年就写清楚了。Clicky 生态（clacky / clicky-windows）已经把同样的三层定位（UIA→OCR→Vision）在 Windows 上落地，且加了"本地快路径+模型路由"的两级意图路由和 [POINT] 流式指点。这些都能直接吸收进 Magic Pointer。

---

## 一、Google 到底公开了什么

### 1.1 官方博客（deepmind.google/blog/ai-pointer，2026-05-12）

四条交互原则（这是产品哲学，也是架构约束）：

1. **Maintain the flow**——AI 能力跨应用可用，不让用户把内容"拖进"AI 窗口。
2. **Show and tell**——"平滑地捕获指针周围的视觉与语义上下文"，让计算机"看见并理解"用户在意的是哪个词、哪段、图片哪部分、哪个代码块。原文关键词：*smoothly capturing the visual and semantic context around the pointer*。
3. **Embrace the power of "This" and "That"**——用 "Fix this"、"Move that here"、"What does this mean?" 这类口语短指令 + 共享上下文（指向 + 手势）来填理解空白。
4. **Pixels to actions**——把"被指到的像素"变成"可执行的结构化实体"。

配套演示视频（webm，仓库已有帧分析）：maintaining_flow、show_dont_tell、This_and_That、pixels_to_actions。
发布时同步开放两个 AI Studio 实验应用：ai-pointer-create（编辑图片）、ai-pointer-find（地图找地点）。
产品落地：**Gemini in Chrome**（发布当天可用，"select a few products on a page and ask to compare"）与 **Googlebook 上的 Magic Pointer**（后续推送）。

### 1.2 Gemini in Chrome = 语义对象层的最佳证据

"在页面里选几个商品然后问'对比一下'"——在 Chrome 里，指针/框选直接映射到 **DOM 元素**（不是像素）。所以 grounding 是**瞬时**的：
元素有文本、类型、坐标、可交互性，全部现成。这是"毫秒级"感知的真正来源：**不需要截屏 → OCR → 猜**，而是 DOM 树直接给出结构化实体。
Googlebook（Android 系）同理：系统级可访问性树（AccessibilityNodeInfo）给每个控件提供语义节点。第三方应用只要暴露无障碍树，Magic Pointer 就能指到"真的那个按钮"，而不是"截图里像按钮的一块颜色"。

### 1.3 Google 没公开的，靠专利反推

**US11221823B2（Samsung，2017-05-22 优先权，2022-01-11 授权）** 是最贴近"add this / and this"场景的专利族，机制如下（FIGS. 12/18/19/21/22/31/32）：

- **FIG.12「and this one」原型**：用户 hover 选中第一首歌，说 "add to playlist serene"（动作+目标一次建立）；再 hover 选第二首歌，只说 "and this one"（**动词不重复，指示词+指针确定新目标，动作复用**）。这就是 "add this → and this" 的标准范式。
- **FIG.18 条件批量选择**："Make selection, exclude blues" + 指针圈选路径——被指到的元素进入选集，被排除的（blues）不进。
- **FIG.19 指示词**："What is that" + 指向衣服 → 系统识别对象并回答。
- **FIG.21 实时排除**：圈选过程中用语音把个别元素从选集里剔除。
- **FIG.22 实时修改交互属性**：圈选不打断，属性（颜色/形状）边说边改。
- **FIG.31 多对象批量**："load Anna's daughter pictures on this, this, and this" + 三次手势 → 三个目标。
- **FIG.25 voice+CV**："add this to my calendar" + 指向宣传册 → OCR 读文字 → 结构化出时间地点 → 写入日历。

**专利的底层模型（可复用的核心抽象）**：
```
输入模态（voice / pointer / hover / gesture / touch）
        │  每类输入都被"上下文交互处理"关联起来
        ▼
1. 指针/手势事件 → 解析为"当前指代物 referent"（哪个对象）
2. 语音 → 动词/意图（action）+ 指示词（this/that/these/one）
3. 指示词绑定规则：this=当前指针处最近对象 / that=上文提过的对象 / these=区域全部
4. 对象累积：同一会话里动词只建一次，新 referent 复用同一动词（"and this one"）
5. 条件约束：语音可附加条件（exclude blues / add a couple of these）
6. 统一执行：动作应用到"累积 referent 列表"上
```

### 1.4 "毫秒级"延迟的组成（CSDN 深度解析的合理推测 + 我们自己的实测）

| 环节 | 延迟 | 方式 |
|---|---|---|
| 指针悬停识别/目标确定 | <16 ms | 本地语义树/DOM（NPU 本地推理） |
| 语音指令解析 | <100 ms | 本地小模型（Gemini Nano 级） |
| 复杂意图理解 | <500 ms | 本地+云端混合（Nano 起草、Pro 精修） |
| 跨应用执行 | <2 s | 云端 + 应用桥 |

关键点：**"画一笔就识别"不是端到端毫秒**——demo 是被缩短的（博客原文承认）。真正的产品速度来自：
- 目标确定走语义树（毫秒级），不走 OCR（百毫秒级）；
- 语音流式识别（边说边出字，说完了字也齐了）；
- 本地小模型做快路径，只有复杂意图才上云。

---

## 二、Clicky 生态是怎么做的（含 Windows 版源码）

三个仓库已 clone 到 external/：`clicky-windows`（PyQt6 版，最贴我们）、`clacky`（Python，在其上加了 routing/tour/Hermes 后台）、`openclicky`（Swift，macOS）。

### 2.1 交互循环（clacky / clicky-windows 一致）

```
按住热键 (Ctrl+Alt+M / ctrl+option) ── 按下瞬间就开始录音 + 并行预取截图(prewarm)
   ├─ 流式 STT（Deepgram 优先，本地 whisper_cpp 兜底）→ 松开时文字已基本就绪
   ▼
路由 routing.py：① 本地正则快路径（"open X"/"walk me through"/"clean desktop" 等明确意图，
                   零模型开销）→ ② 不明确就丢给 Haiku 用工具调用选 lane
                   (act/walkthrough/remember/learn_skill/background/organize/undo/chat/workspace)
   ▼
执行：act → Claude Computer Use 操作电脑；walkthrough → tour.py 生成带 [POINT] 的流式讲解
   ▼
TTS（Edge TTS 免费）边生成边播放，指针按 [POINT] 标签飞到目标
```

### 2.2 定位层：hybrid_pointer.py 三层（这是对 Windows 最有价值的部分）

```
Tier 1  Windows UI Automation（uiautomation 包）  ~5 ms    像素级精确
        遍历前台窗口的可访问性树，按名字/控件类型模糊匹配
        Chrome/Edge/VS Code/Office/Electron/原生 Win32/WinUI 全兼容
Tier 2  RapidOCR/ONNX 离线 OCR                        ~300 ms  文字级精确
        Figma/PS/游戏/Java Swing 等无 UIA 树的画布应用
Tier 3  Vision LLM 网格定位（element_locator.py）    ~1-3 s   兜底
        只在 UIA+OCR 都失败时用；明确标注"最不可信"
```
选型顺序 = 速度×精度双排序，和我们 perception_cascade 的"结构化优先、像素兜底"完全同构。

### 2.3 指点：tour.py 的 [POINT] 标签机制（交互同步的关键设计）

- 模型在**一次响应里**输出整段讲解，并在讲到某元素的那句话**前面**内联 `[POINT:x,y:label:screenN]` 标签；
- 解析器按标签位置切段，**每段文字开始播放的瞬间**指针飞到对应坐标——语音和指点同源同序，永远不会漂移；
- 流式处理中，上一段播放时下一段已在合成（流水线）；
- **UIA 吸附**：模型给的坐标只是初值，`ControlFromPoint` 找到该点下的小控件（宽高≤600×360），若偏差≤30px 就把指针"吸"到控件正中心——像素级精确且不会跳进大容器；
- 物理坐标→逻辑坐标换算（DPI 缩放）单独成函数。

### 2.4 语音状态机（companion_manager.py）

```
IDLE →（热键按下，可打断上一轮 thinking/speaking）LISTENING
     →（松开/静音超时）PROCESSING（截屏已预取）
     → SPEAKING（流式 TTS + [POINT] 指点）
     → IDLE；Esc 随时停止
```
热键按下即"抢占打断"（barge-in）：说话中途再按热键 = 取消重来。

### 2.5 clicky-windows 与 clacky 的差别

- clicky-windows：PyQt6 + Python，`ai/` 下 12 个 provider（Claude/Gemini/OpenAI/Ollama/LM Studio/GitHub Copilot），`audio/stt` 4 个后端，`audio/tts` 3 个后端，tray/panel/setup_wizard 完整；
- clacky：在其基础上加 `routing.py`（本地正则+Haiku 路由）、`tour.py`（[POINT] 讲解）、`memory_store.py`（跨会话记忆）、`harness.py`（嵌入 Hermes 做后台研究 agent）、SKILL.md 技能体系、Google Workspace 连接。

### 2.6 openclicky（Swift/macOS）值得借鉴的

- ElementLocationDetector.swift：Computer Use API 定位；**按真实宽高比选 1024x768 / 1280x800 / 1366x768**（避免拉伸导致 X 轴偏移）；Retina 用 NSBitmapImageRep 精确像素位图（规避 lockFocus 2x 像素 bug）；坐标链"Computer Use 顶左原点到 AppKit 底左原点"转换——我们 Windows 侧对应的是"截图像素→物理像素→逻辑 DIP"（main.js 已有 screenToDipPoint）；
- OverlayWindow.swift：per-display overlay、level=.screenSaver、ignoresMouseEvents=true、不抢焦点——与我们 Electron overlay 同思路；
- 状态机驱动 UI（idle→listening→processing→responding），波形/spinner/气泡都是状态的视图。

---

## 三、对我们 Magic Pointer 意味着什么

### 3.1 我们已有的（对齐检查，比想象中近）

- **语义对象层已存在**：`app/adapters/browser_devtools_adapter.py`（DOM probe：节点/选择器/accessibleName/元素屏幕坐标）≈ Chrome 的 DOM grounding；`uia_text_adapter.py`（UIA TextPattern）≈ Tier 1 UIA；`office_adapter.py` 原生选区；`perception_cascade.py` 结构化优先 + OCR 兜底；`explorer_adapter.score_item_against_stroke` 已能把"笔画几何"和对象匹配。
- **多笔链已落地**（2026-07-31 phase2）：一次激活连续圈选，`strokes[]` 累积、`CHAIN_GAP_MS=1000` 自动收尾、Enter 立即完成、气泡锚定第一笔 release 不跳、计数徽章。
- **视频帧分析**已证明我们的"单气泡状态机 + 划过线/轨迹 + 本地结果卡"与 Google 演示同构。

### 3.2 差距（按对体验的影响排序）

1. **Grounding 时机**：我们现在是"整条笔画链结束后"才启动截屏桥（34ms×N + 整块截图 + 级联）；Google/Clicky 是"每笔/每次指向"即时解析（UIA 5ms 级）。→ 目标：每笔 pointerup 后**立即**用 UIA/DOM 对笔画区域做增量 grounding，把命中对象加入 referent 列表（先本地结构化层，OCR 兜底异步补）。
2. **语音在圈画过程中进来**：现在是"画完→语音"；Google 是"边画边说 this / and this"，语音命令与指针事件在**同一个会话里交错**。→ 目标：圈画会话内打开听写/流式 STT，把"this/and this"解析为对当前 referent 列表的追加/绑定，而不是等整句画完。
3. **referent 列表与动作分离**：专利的核心抽象是"动词建一次、目标累积、统一执行"。我们现在 selection→command 是 1:1。→ 目标：gesture session 产出 `referents[]`，命令/Recipe 绑定到整个列表（"把选中的都……"），语音里的 "exclude/这些/加上" 可实时改列表。
4. **毫秒级延迟链**：目标定为 悬停/指向识别 <50ms（UIA/DOM），语音流式 STT 边说边出，复杂意图才走模型。
5. **Clicky 的 [POINT] 流式指点**：结果讲解阶段让指针/轨迹按 TTS 句子飞到每个 referent——把"确认 AI 理解对了"从文字变成视线。

### 3.3 统一底层的结论（回答"为什么必须同一套底层"）

Google、专利、Clicky 三方的答案一致：**不要为每种交互方式（画圈/点选/hover/语音/推按说话）建独立形态，而是建一个"referent 会话"引擎**：

```
任意输入模态 ──► 产出 referent（UIA/DOM/OCR/Vision 四层定位，谁快用谁）
                      │
                      ▼
           ReferentSession（本次激活期间持续累积 referents[]）
                      │
                      ▼
语音/文字意图（动词 once + 指示词绑定 + 条件约束）──► 统一执行器（对列表执行）
```

我们的多笔链已经朝这个方向走了一步（strokes[] 累积）；下一步是把"语音交错"和"增量 grounding"接进同一个会话，形态（画圈/点选/长按说话）只是 referent 的不同来源。

---

## 四、参考仓库与文档清单

- external/clicky（farzaa，macOS Swift 原版，7600 行，已有 CLICKY_ANALYSIS_20260731.md）
- external/openclicky（jasonkneen，2026-07 开源版，带 Agent Mode / Computer Use runtime / 58 个 skills）
- external/clacky（Raynan00，Windows 版，routing.py / tour.py / harness.py / memory_store.py）
- external/clicky-windows（Bitshank-2338，Python/PyQt6 Windows 版，clacky 的前身）
- 专利 US11221823B2（Samsung，"and this one" / exclude / 多对象条件选择）
- 官方博客 deepmind.google/blog/ai-pointer（四条原则 + 4 段演示视频）
- 本仓库：GOOGLE_MAGIC_POINTER_ALIGNMENT.md、GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md、GEMINI_POINTER_FRAME_ANALYSIS.md、CLICKY_ANALYSIS_20260731.md

## 五、下一步建议（落地顺序）

1. P0：每笔 grounding 增量解析（UIA/DOM 先查，OCR 异步兜底）——把"画完才认识"变"边画边认识"。
2. P0：圈画会话内语音交错（流式 STT + this/and this/这些/排除 绑定 referent 列表）。
3. P1：referent 会话抽象落地（ReferentSession 替换 1:1 selection→command）。
4. P1：结果讲解 [POINT] 流式指点 + UIA 吸附（学 tour.py）。
5. P2：本地小模型快路径 + 模型路由（学 routing.py），为"更快更顺"的总目标服务。