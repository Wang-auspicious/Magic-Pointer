# Magic Pointer 底层设计：问题调研 + 功能需求推导 + Referent 会话引擎

日期：2026-08-01
作者：Codex（按用户指示整理）
范围：① clicky(macOS farzaa/clicky) 38 个 issue + clicky-windows(Bitshank-2338/tekram) 6 个 issue 的反馈全记录与思考；
② 从"日常真实功能清单"反推底层需要什么输入信息；③ 底层架构设计（Referent 会话引擎）；
④ 与 clicky/Google 的定位差异（成本、速度、human-in-the-loop 聚焦）。
参考：docs/planning/GOOGLE_ADDTHIS_ANDTHIS_ANALYSIS_20260731.md（Google 底层 + 专利 + Clicky 生态对标）。

---

## Part A：clicky 生态 issue 反馈全记录（分类思考）

### A.0 数据来源
- farzaa/clicky（macOS）：38 个 issue（page1 26 + page2 12），全部拉取正文+评论。
- Bitshank-2338/clicky-windows（Windows，tekram 维护）：6 个 issue。
- Raynan00/clacky（Windows）：0 个 issue（该项目反馈走 Discussions，匿名 API 无法读取，注明）。
- 匿名 GitHub API 抓取于 2026-08-01，保存于 %TEMP%\mp_issues_*.json。

### A.1 用户最大的痛：成本与 API key（clicky 最深的坑，也是我们最大的机会）
- **#27 "Running out of credit — how can I use my own codex or claude code API key?"**：官方代理吃用户额度，用户想用自己的 key。这是最热的成本诉求之一。
- **#44 "Critical Security Issues"（6 个 reaction，社区共识）**：Cloudflare Worker 代理无鉴权无限流，任何人拿到 workers.dev 地址就能白嫖你的 Anthropic/ElevenLabs/AssemblyAI 额度；日志泄露 transcript、point 目标、部分 token。建议：要么鉴权，要么 BYOK。
- **#22**：Anthropic API key 直接被 commit 进仓库（虽然已作废，但暴露了安全问题）。
- **#30**：OpenClaw Gateway 作为替代后端（memory/tools/多模型）；**#75**：Codex 被限流时 fallback 到 Claude。
- 评论实证：用户改用 Openrouter + gemini-3-flash，每次请求约 $0.00109，"radically low"——用户非常在意单次成本；也有人用 LM Studio 本地跑 gemma 想零成本（PR #28）。
- 思考：**clicky 的架构（全屏截图+完整对话上下文上云）决定它贵**。用户不是不想用，是"用不起深度用"。这正是我们的差异化空间：本地优先 + 聚焦截图 + 语义层，把每次成本打下来。

### A.2 Windows/Linux 是巨大空白（用户用脚投票）
- **#26（18 条评论，最高热度）**：tekram 用 Electron+TypeScript 重写 Windows 版；评论里 m13v 给了两个关键工程建议：
  1. **截图时机比想象中重要**："if you capture the screenshot when the user starts speaking, by the time the user finishes speaking the screen has changed" → 按下时截的图到松开时已经过期。tekram 改为 push-to-talk **release** 时截图。
  2. 分享 macOS 可访问性元素定位实现 + **Windows UIA 元素抽象**（mediar-ai/terminator）——说明社区已经在往"语义元素定位"走，不再满足于纯截图。
- #21/#63/#104/#19：Windows 请求反复出现；#13 Debian/Linux；#59/#109 其他人做了 Linux/跨平台版。
- 思考：**Mac only 是 clicky 的天花板**；Windows 上没有"好用的标杆"，clacky/clicky-windows 都是粗糙早期版（见 A.5 的 bug 实录）。空白即机会。

### A.3 慢：全链路延迟劝退深度使用
- **#35**："it's slow — to take in input, process it and return the output as compared to the level of precision I would get if I had the same llm opened in a different tab"（还不如开个浏览器 tab 用 LLM）；热键要三根手指 + 麦克风启动有延迟。
- **#60**："I found that it is quite slow to use this on a daily basis"→ 想要简洁回复模式、可自定义快捷键、指定麦克风、光标大小可调、语气 prompt 可设。
- **#36**：说话停不下来，停止要再按 ctrl+option，UX 差。
- 思考：慢 = 全屏截图（~100ms+）+ 上传（+200-500ms）+ 大模型思考（+1-3s）+ TTS 排队。我们人机协同的"聚焦"天然省掉"让 AI 满屏找"的时间；再叠加语义层即时定位，链路能压到 clicky 的零头。

### A.4 语言、记忆、功能缺失
- **#7**：非英语用户回复乱切语言（俄语→西班牙语/意大利语）、上下文立刻丢、音频被说截断——多语言+会话记忆是硬需求。
- **#93**：持久记忆（提议接 TINM 做 MCP 后端）；**#83**：连自己的知识库。
- **#38（灵魂拷问）**："If it can't type on my behalf what's the USP?" ——只读屏+说话=教学工具；用户要的是**替你打字、点击、做事**。
- **#77**："Capture contextual screenshots for references like 'here' or 'right here'"——用户明确要"here/right here"这类空间指代。
- **#43** 复制到剪贴板；**#125** 听写历史（插入失败丢文字无法找回）；**#76** 会话记录面板；**#126** 多语言手动选择。
- 思考：这些恰好是我们 30 个 Recipe + 任务上下文 + DESTINATION + 审计日志已经/正在覆盖的方向；"here/right here"正是 referent 引擎的核心场景。

### A.5 clicky-windows 的 bug 实录（工程质量反面教材）
- **#6（最典型）**：USB 游戏耳机 16kHz 打不开麦克风，错误被**静默吞掉**，UI 永远卡在 "Listening..."。根因：内部音频错误没上抛。→ 教训：所有底层失败必须 fail-closed + 可见报错（我们 voice 桥已有同样教训，REVIEW_AUDIT #1/#2）。
- **#4**：全屏 overlay 把 Windows 自动隐藏任务栏顶没了 → overlay 不能霸占全屏交互区域（我们 overlay 的 setIgnoreMouseEvents 二态设计正是为此）。
- **#3**：.env 改了不生效，vision model 硬编码 llama3.2-vision（新版 Ollama 加载失败卡 "Thinking..."）→ 配置必须运行时生效 + 显式诊断。
- **#2**：托盘关闭后图标残留；**#1**：中国区用户要 OpenAI 兼容端点（DeepSeek/Qwen/SiliconFlow）。
- 思考：这些 bug 全在我们"不要做的事"清单里有对应条目——我们踩过的坑比 clicky-windows 更深（二次激活、黑屏、坐标越界），说明只要稳住工程底线，就能在 Windows 上做出第一个"靠谱的"。

### A.6 社区共识一句话总结
用户要的是：**便宜（自己的 key / 本地 / 便宜模型）、快（毫秒级感知、边指边说）、能做事（打字/点击/执行）、记住我（多语言+记忆）、跨平台（尤其 Windows）、别偷我的 key**。clicky 做到了"演示惊艳"，但以上六条没有一条做到位——这就是我们的靶心。

---

## Part B：日常真实功能清单 → 输入需求 → 底层能力

方法：先把"日常真正能用的功能"列全（不追求具体，只求覆盖真实使用），再逐个问"它需要底层喂什么输入"，收敛出底层必须提供的最小能力集。

### B.1 功能清单（8 大类，日常口语场景）

| # | 类别 | 口语场景例子 | 需要底层提供的输入 |
|---|---|---|---|
| 1 | 单点问答/解释 | "这个按钮是干嘛的""这行代码啥意思""这个图表讲了什么" | 单个 referent（元素定位+内容提取）+ 窗口/文档上下文 |
| 2 | 内容操作 | "把这段翻译成英文""把这句改得更正式""给这段话写个摘要" | 选中文本/对象（区域→内容）+ 动作动词 |
| 3 | 多选累积 | "这个也加上""排除这个""把这几个都合并"（Google add this/and this） | 多 referents + 会话内累积 + 语音/笔画交错绑定 |
| 4 | 跨应用搬移 | "把这张图放进我的文档""把这个数据做成表格贴到邮件里" | 源 referent + 目标 referent（here/there）+ 执行桥 |
| 5 | 执行操作 | "打开浏览器搜天气""点保存""把这个文件重命名" | 元素定位 + 动作原语（点击/键入/打开）+ 验证 |
| 6 | 记忆/个性化 | "记住我喜欢深色""我上次说的那个方案呢" | 会话历史 + 长期记忆存储/检索 + 指代回溯 |
| 7 | 教学/指点 | "教我怎么用这个软件""我屏幕上这些是啥" | 屏幕整体理解 + 分步 + [POINT] 指点 + TTS 流 |
| 8 | 整理/批处理 | "把桌面整理一下""把这周的截图归档" | 文件系统/对象列表访问 + 计划 + 可撤销执行 |

### B.2 收敛：底层必须提供的 6 个能力（这就是"底层"）

1. **元素定位（Grounding）**：任意坐标/区域 → 一个语义对象 {id, 类型, 边界, 文本/内容, 可交互性, 来源, 置信度}。分层：UIA(5ms) → DOM(devtools, 10-30ms) → 离线OCR(~300ms) → 视觉模型(~1-3s，异步兜底)。**这是所有功能的地基**。
2. **内容提取（Content）**：referent → 可用内容（纯文本/富文本/图像/结构化：表格、代码、表单字段）。不是"给模型一张截图"，而是"给模型它需要的结构化内容"。
3. **指代解析（Reference）**：this/that/these/here/there/这个/那个/这些/这里 → 绑定到会话里的 referent 列表；支持"动词一次、目标累积"（专利范式）。
4. **语音流（Voice Stream）**：流式 STT（边说边出字）+ 静音边界 + 与笔画事件时间戳对齐（说话和划线在同一个会话里交错）；支持打断。
5. **上下文（Context）**：前台窗口/当前文档/选中状态/会话历史/长期记忆；所有 referent 带"来源窗口身份"（hwnd+pid+文档指纹），防止张冠李戴。
6. **执行与验证（Act+Verify）**：动作原语（读/写/点击/键入/打开/复制）+ 写入前确认 + 写入后重读验证 + 可撤销（fileops/journal 已有基础）。

### B.3 推导出的关键设计决策
- **截图不是底层，是兜底**：只有 UIA/DOM/OCR 全失败才截图给视觉模型，且只截**用户聚焦的小区域**（circle 的 bbox，而不是全屏）。这样 token/延迟都受控。
- **每次交互的"视野"由用户圈定**：human-in-the-loop 的指向本身就是聚焦指令（"我圈的就是我要的"），AI 不需要满屏找 → 这就是对 clicky"全屏截图+发散找"的降维。
- **输入信息按需最小化**：翻译只要文本；搬移只要源+目标两个 referent 的身份；解释按钮只要该元素的可访问名+类型。功能需求不同，payload 不同，底层统一走"Referent → Content"两段式，绝不把整屏塞给模型。

---

## Part C：底层架构——Referent 会话引擎（一次唤醒 = 一个会话）

```
                输入流（互不排斥，同一会话内任意交错）
   ┌──────────────┬──────────────┬──────────────┬─────────────┐
   │ 划线圈选(多笔) │ 点选/hover   │ 晃动唤醒      │ 按住说话      │
   └──────┬───────┴──────┬───────┴──────┬───────┴──────┬──────┘
          ▼              ▼              ▼              ▼
   ┌────────────────────── ReferentEngine ─────────────────────┐
   │ 增量 grounding：每笔/每次指向 → UIA→DOM→OCR→Vision(异步)    │
   │ 产出 referent：{id,type,bounds,content,windowId,conf}     │
   │ 累积到 ReferentSession.referents[]（本次唤醒持续有效）      │
   └───────────┬──────────────────────────────────┬───────────┘
               ▼                                  ▼
   ┌── IntentEngine（语音/文字流，边识别边绑定）──┐  ┌── ContextStore ──┐
   │ 动词 once + 指示词绑定(this/and this/排除)   │  │ 前台窗口/文档    │
   │ 笔画事件时间戳 ⇄ 语音片段时间戳对齐          │  │ 会话历史/长期记忆 │
   └───────────┬──────────────────────────────────┘  └─────────────────┘
               ▼
   ┌──────────────────── Executor ───────────────────┐
   │ 动作原语(读/写/点击/键入/打开/复制) → 验证 → 撤销 │
   └──────────────────────────────────────────────────┘
```

核心规则：
1. **一次唤醒 = 一个 ReferentSession**：晃动/热键唤起 → 会话开始；会话内所有 referent 累积；空闲收尾或显式完成才结束。形态（划线/点选/说话）只是往会话里加 referent 的不同入口，不需要切形态。
2. **笔画与语音时间戳对齐**：每笔 pointerup 打一个事件（含时间戳+区域）；语音流按片段打时间戳。"this" 绑定最近 1.5s 内的笔画；"and this" 追加；"排除"从列表移除；"这些" 绑定区域半径内全部。这就是把 Google 的"划线→add this→and this"做成本地可实现的机制。
3. **增量 grounding**：每笔完成后立刻跑 UIA/DOM（毫秒级），OCR/视觉异步补——"边画边认识"，不等整轮画完。
4. **延迟预算**：元素识别 <50ms（语义层）；语音 final <300ms（本地流式）；复杂意图才上模型；结果 TTS 流式边出边播。
5. **成本预算**：默认零云端成本（本地 SenseVoice/Whisper/RapidOCR）；云模型只在需要语义推理时用，且 payload = referent.content 而非整屏截图；用户可 BYOK。
6. **fail-closed**：任何一步失败（麦克风打不开、UIA 拿不到）都给出可见原因，绝不静默卡死（clicky-windows #6 的教训）。

---

## Part D：我们 vs clicky vs Google MP（定位差异）

| 维度 | clicky | Google MP（预览） | Magic Pointer（目标） |
|---|---|---|---|
| 眼睛 | 全屏截图+云端视觉猜 | DOM/无障碍树（毫秒级） | UIA/DOM 语义层优先，OCR/视觉兜底 |
| 找东西 | AI 满屏发散找 | 系统级即时 | 用户圈=聚焦，AI 只读圈内 |
| 成本 | 每次全屏图+长对话上云，贵 | Google 自有生态，免费预览 | 本地免费优先，云只按需小 payload |
| 速度 | 截图+上传+大模型+TTs，慢 | 演示级（被缩短） | <50ms 识别 + 流式语音/输出 |
| 平台 | macOS only | Chrome/Googlebook | Windows（+macOS 后续） |
| 交互 | 按住说话，单目标 | 划线+说话交错，多目标累积 | 划线/点选/说话同会话交错，多 referent |
| 做事 | 教学/问答为主（被骂"不能打字"） | 演示多为编辑/搜索 | 30 Recipe 执行 + 可撤销验证 |

结论：**Google 的底层 + clicky 的交互秀 + 我们的 human-in-the-loop 聚焦和本地执行**，才是我们要的形态。不抄 clicky 的眼睛（贵+慢+发散），学它的状态机 UI 和 [POINT] 指点；底层走 Google 那条语义对象层路线（我们已经有一半：devtools DOM + UIA + 感知级联）。

---

## Part E：下一步（落地顺序，P0 先行）

1. **P0-1 增量 grounding**：每笔 pointerup 立即跑 UIA/DOM 解析笔画区域 → 产出 referent 加入 session；OCR/视觉异步补。改动：selection_snapshot_bridge 拆分"增量解析"接口 + overlay/stage 会话持有 referents[]。
2. **P0-2 语音与笔画交错**：会话内打开流式 STT；笔画事件与语音片段按时间戳对齐；"this/and this/排除/这些" 绑定 referent 列表。改动：voice 桥事件增加时间戳 + IntentEngine 解析指示词。
3. **P1-1 ReferentSession 抽象**：替换现在 1:1 的 selection→command；session 产出 referents[] + anchorPoint（气泡锚定已有基础）。
4. **P1-2 [POINT] 流式指点 + UIA 吸附**（学 tour.py）：结果讲解时指针逐句飞到 referent，吸附到控件中心。
5. **P2-1 本地快路径 + 模型路由**（学 routing.py）：明确意图不经过模型；意图路由小模型兜底。
6. **P2-2 记忆/多语言**：会话历史 + 长期记忆 + 语言跟随（吸收 #7/#93 反馈）。

---

## 附：数据留档
- %TEMP%\mp_issues_farzaa_clicky_p1.json / p2.json（38 issue + 74 PR）
- %TEMP%\mp_issues_Bitshank-2338_clicky-windows_p1.json（14 项，6 issue）
- %TEMP%\mp_comment_*.json / mp_c2_*.json（关键 issue 评论）
- external/clicky-windows、external/clacky、external/openclicky（源码已 clone）