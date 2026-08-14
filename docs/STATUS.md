# 当前状态

> 最后核实：2026-08-14（Harness 后端重建进行中，尚未交付）。改了行为就回来改这里，别新建一份日期文件。

## 一句话

**本机安装版仍是 1.0.4；它不是当前开发树。** 当前分支正在做一次不拆批交付的 Harness 后端重建，按用户要求在全部底层、Agent 能力、插件和自进化链路验收前，**不升版本、不运行 `npm run sync`**。旧 1.0.4 用“6 轮封顶”阻断过持久后端错误的无限自旋，但这是临时止血，已经从开发树移除：Provider 瞬时错误在语义循环下方有限重试，持久错误一次性终止为 `provider_unavailable`；重复工具/重复证据由 Hermes 风格语义停滞检测终止为 `stalled`；只保留默认 90 的诊断保险丝并报告 `invariant_failed`，它不参与正常任务完成语义。插件内核已补齐依赖撤销/恢复、精确卸载回卷、`ctx.llm` Provider seam、SurfaceAdapter seam、用户 patch 文件和 agent/surface 运行域隔离；本阶段定向回归 104 项通过，尚未做最终全量验证或安装版交付。

FrameLease 捕获地基（8·11 计划 Phase A）已全量落地并过自动化验证；外部 harness 评审（`docs/harness-gap-review-20260812.md`）已吸收，评审批次 1/2/3（L1-L16 基础设施）全部落地。2026-08-13 最强模型对交接文档（`docs/2026-08-13-ARCHITECTURE_HANDOFF.md`）的评审回复（`docs/2026-08-13-STRONGEST_MODEL_REVIEW_RESPONSE.md`）已**全量执行**：三个结构性张力（T1 预算语义/T2 证据截断/T3 in-loop 可逆写）、13 题逐答、接线批（权限门/guard 真探针/流式默认+回落/compaction）、工具合并+双轨杀死、settings 深合并、记忆铁律、常驻 UIA 宿主（真机实测 2.5x）、SurfaceAdapter SDK+微信样例、Replay 20 条 trace、薄 smoke 层、WGC CaptureProvider 契约。基建执行顺序已按评审反转：**常驻 UIA 宿主先于 WGC**（Phase 编号不变）。全量验证：**Python 991 过 / 59 秒；Node 127 全过；typecheck、ESLint 0 警告**。进度账本在 `docs/design/MAGIC_POINTER_HARNESS_20260811.md` §18。

七条不可回退 invariant（评审 §四，任何后续改动不得松动）：① FrameLease commit 失败 fail-closed 禁重拍；② Anchor 五路判别一等值，ambiguous/changed 永不按 exact；③ Evidence 八态 busy≠empty；④ 批准者黑名单（model/tool/agent 不能批准不可逆）+ 确认 UI harness 持有；⑤ origin 双通道屏幕内容永远是 data；⑥ UndoLog 失败不伪装 + 回执读回校验；⑦ 真机验证与自动化分账。

分支 `codex/multi-stroke-and-voice-fix`，未推送。Electron/Node 非测试源码已全部迁移为 TypeScript（**89 个非测试 `.ts`，非测试 `.js` 为 0**）。

结构化应用（记事本、Edge、Office、终端）的划线读取链路已经可用；自绘应用（微信 4.x、Qt、Flutter）的 SurfaceAdapter SDK + 微信样例已落地（容器 UIA 暴露则用，否则诚实像素锚点），但**"首笔手势像素候选框"仍需真机验证**。**不能宣称"任意 Windows 软件里随手一划都能稳定理解完整对象"。**

## 能用

| 能力 | 状态 |
|---|---|
| 记事本无选区整篇读取（document_text 回退，真机验证 34,660 字全文入上下文） | 可用（需重编译探针/重建打包产物后生效） |
| FrameLease 冻结先于感知（pointerup→commit→会话） | 可用（GDI 后端，p50≈192ms / p95≈213ms；CaptureProvider 契约已建，WGC 原生工具为脚手架，诚实报告 `wgc_tool_missing`） |
| 常驻 UIA 宿主（named pipe，评审优先级第一） | 可用（**真机实测 ping+probe 通过，稳态 200-250ms/读 vs 冷启动 573ms+，约 2.5x**；Electron 启动 spawn；`MAGIC_POINTER_UIA_HOST=0` 回滚） |
| agent loop 即路由器（模型即路由器，生产默认） | 可用；L0 关键词只留本地动作/显式 handoff；`MAGIC_POINTER_LEGACY_ROUTER=1` 回滚 |
| 权限模式门（default/plan/accept_reversible/safe/bypass × 六档 effect） | 已接 loop 每工具门；默认 default |
| 四道 guard 真机数据源（真探针 + 选区 anchor fallback） | 已接线；in-loop 可逆写默认 off，`MAGIC_POINTER_INLOOP_REVERSIBLE=1` 翻转前需真机验证四 guard |
| 流式回答 | 默认开（`MAGIC_POINTER_STREAMING=0` 关），SSE 失败自动降级非流式 + 健康 note 不毒化 |
| 上下文压缩（70% token 阈值主动 + withheld 被动） | 已挂 loop；`MAGIC_POINTER_CONTEXT_TOKENS` 默认 64000 |
| 证据硬围栏 + 显式截断（手势点中心截窗 + 字数 + read_around 提示） | 可用 |
| 300ms 本地首反馈（"我看到了：X · N 字"） | 已接线（零模型，snapshot summary 材料） |
| 能力工具（26 → 18 正交合并，schema 单一来源归代码） | 可用；find_capability 保留；双轨已杀 |
| settings 深合并（RFC 7396）+ 渲染层键名翻译表 | 桥端已修（先深合并后键名，顺序按评审）；渲染层只发有消费方的键 |
| 证据契约（ok/busy/timeout/empty_confirmed 可区分 + 反容器启发式） | 模块可用，感知链未接线 |
| 延迟预算表 + 取消令牌（代际淘汰） | 模块可用；agent loop 已接线（rolling 预算按轮续期 + 循环级取消作用域），桥/其他外部调用方未接线 |
| Desktop Trace 录制/回放（离线感知测试基座） | 基座可用 + 20 条按失败模式的 fixture trace + replay 驱动实测跑通 |
| 薄 smoke 层（自家 UIA 狗粮，无 Playwright） | `scripts/smoke/golden_path_smoke.py`：uia-host 实测 PASS；replay 20 条；notepad-read 待真机跑 |
| SurfaceAdapter SDK + 微信样例 | 可用（容器 UIA 暴露则用，否则诚实像素锚点；8 测试） |
| 晃动唤醒 → 划线圈选 → 气泡问答 | 可用 |
| 39 个 Recipe（数据驱动，`data/recipes/builtin.recipes.json`） | 可用；角色=能力来源与展示元数据，不再是路由目的地 |
| 三层意图路由（L0 关键词 / L1 分类 / L2 工具调用兜底） | L0 保留，其余由 agent loop 取代 |
| 结构化读取：UIA / Chrome DevTools DOM / Office COM | 可用（UIA 走常驻宿主漏斗） |
| 像素读取：常驻 OCR worker + 视觉元件框 | 可用 |
| 证据高亮带（蓝＝结构层，琥珀＝像素） | 可用 |
| 「填入」把气泡答案写进别的应用输入框 | 可用，自适应找当前输入框并在写入后读回校验 |
| 回答框两种形态（要送出去 / 自己看） | 判定与界面可用，**未实机验证**，见下 |
| 在回答里划中一段就地展开 | 渲染层 + 桥可用，**未实机验证** |
| Dashboard 设置 / 权限 / 审计 / 诊断 | 可用（settings 面板落盘已修，待真机复核） |
| Agent 集成（Codex/Pi/Claude/Gemini/Cursor/OpenCode/Aider） | 可用 |
| MCP 双向（我们既是 server 也是 client） | 可用 |
| 语音（SenseVoice 默认，Whisper 兜底） | 可用，但默认输入是**打字** |
| Windows 安装包 + 自动更新 | 可用 |

桌面运行时已经收敛为 **Electron 单壳**。旧 `app/main.py` Tkinter 应用、它的三个直接启动批处理和 Python 摇鼠标测试已删除；`start_electron_overlay.bat` 不再静默回退旧 UI，缺 Electron 依赖时明确失败并提示先安装依赖。

TypeScript 迁移基础设施可用：`npm run build:electron` 生成 `build/electron`，`npm run typecheck` 执行 strict 检查，`npm test` 能在独立进程直接加载迁移中的 `.ts`；开发启动与打包都先构建再运行编译产物。当前已迁移路径解析，以及激活、鼠标/指针策略、renderer readiness、手势配置、route、命中区、标题栏、主动提议规则/once store、bridge progress、IPC surface、应用生命周期、Python runtime、提交门、凭据存储、会话时间线、运行快照、听写纠错、语音焦点守卫、选区会话、可观测性、抖动可靠性证据、内部动作白名单、结果表面策略、Python bridge runner、后台任务观察、对话存储、首启 bootstrap runner、自动更新管理、pass-through 手势捕获共 33 个 Electron 模块；构建器、测试编排器和 electron-builder 包装器 3 个核心 Node 工具也已进入 strict 检查。

源码直接启动兼容已恢复：`npx --no-install electron electron/main.js` 会在源码树按需注册 `tsx/cjs`，真实 Electron dashboard-capture smoke 已通过；`build/electron` 与安装包因不存在源码 `.ts` 不加载该 devDependency。

Windows 唤醒后的光标/划线回归已修复：gesture 态使用原生 `armed-cursor.cur`（非 Windows 保留 SVG fallback），不再创建 renderer DOM 假光标，也不再通过 DOM/20ms IPC 追踪鼠标，因此没有软件光标落后硬件光标的问题。源码入口真机拖动验证中，按下、移动、释放五个采样点保持同一非零 Windows cursor handle，蓝带可见，释放后 194ms 出现输入框。Clicky 三角不随唤醒常驻，只在结果含 `[POINT]` 时临时启动；飞行使用单个持久 SVG DOM 节点更新 `transform`，不向透明 Canvas 连续重画带模糊的位图，停留结束后单独关闭引导 overlay。

Vida 参考下的舞台临时界面已完成第二轮收口：过程/结果面板会按目标应用两侧真实空位自适应贴左或贴右（8 DIP 间距，同一会话保持侧边稳定）；全屏/两侧不足时贴屏幕边缘并避开选区焦点。处理态删除绿橙粉蓝彩带，改为石墨色单点轨道 + 浅灰 ink wash；结果按 406/420/560/840 DIP 四档内容宽度呈现，写回审批并入 `TASK FINISHED` 底栏。九宫格参考图只用于学习质感，不再改变或截断真实文件提案数据。左右停靠、全屏回退、稳定侧边和超宽钳制有纯策略测试；DOM 视觉场景只使用明确标注的通用示例，**截图只验证版式，不代替真机交互验收**。

`PromptRescue.mp4` 的完成转场已按 60fps 实测逐帧重切：过程面板从靠应用一侧的 4.5% 细缝展开；完成时先落近白外壳/动作区，44ms 后正文从 2.5px 模糊变清，190ms 后 `TASK FINISHED` 最后出现。完成卡接管追问/审批，旁边不再保留重复输入胶囊。未知进度卡取消长轨道，改为单个中性轨道点；有真实百分比时仍保留 determinate 进度。动画只动 transform/opacity/filter，`prefers-reduced-motion` 下全部立即稳定。

活跃 Stage 已恢复 Explorer 真实文件链路：划线命中文件行后冻结由 COM/UIA/PowerShell Explorer grounder 返回的绝对路径；文件问题读取真实文本、PDF、DOCX、HTML、ZIP 或目录内容并送入普通回答和 Agent Prompt，上限 60,000 字且显式标注截断/错误。图片直接把原文件交给视觉模型。路径不从 OCR 文件名猜测，也不会搜索同名文件。

「填入」不再无条件抢“此刻前台”后只检查一次 `FocusedElement`。主进程只提供自己持有的稳定窗口提示，原生 UIA writer 在同一个进程内依次检查：已聚焦可编辑框、鼠标所在外部应用、最后稳定前台、实时前台、原始选区应用；窗口里没有现成焦点时按鼠标/窗口中心寻找最佳可编辑控件。Magic Pointer 自身窗口、密码框、禁用控件、失效 HWND/PID、不可读回写入继续拒绝，且永不代用户发送。没有增加第二次探针或桥接往返。
原生 writer 已在本机重新编译，协议/执行器/桥接回归通过；当前自动化 shell 处于不可交互桌面会话，临时 Notepad/WinForms 窗口均拿不到前台 HWND，因此新的自适应优先级仍需在真实 Magic Pointer 会话里人工点一次「填入」确认，不能把编译通过写成真机交互通过。

选区追问的 120 秒假卡死已修复：日志证实第二次请求 20.5 秒完成，但结果到达时已超过选区创建 TTL，被 `stage result ignored stale` 丢弃。现在已受理请求在执行期间不会被 TTL 清理，完成后从完成时刻重新续期；回归测试覆盖请求跨越多个 TTL 后仍可交付、空闲会话仍会正常过期。

未接入生产入口的 `voice_residency.js` 旧状态机、`panel_position.js` 旧面板定位算法及其自循环单元测试已删除；现役语音生命周期唯一实现是 `voice_resident_runtime.js` + `voice_worker_client.js`，现役定位走 stage anchor/命中区/主进程 placement 链。

2026-08-09 用编译入口完成真实 first-run onboarding：取消不写 marker、9 项 preflight、success、进入 `studio.html`、后台二次启动不重复 preflight 均通过；证据在 `data/runtime/first-run-onboarding-20260730/evidence.json`。构建器会校验所有未迁移 `.js` 在源码与产物间字节一致，classic renderer 不经过 CommonJS 转换。

P3 十二项能力做完十项：图转提示词、选区拉伸把手、点选追问、悬浮翻译、[POINT] 指点、记忆层、剪贴板历史、插件加载器、MCP client、零元件窗口视觉框选。

## 不能用 / 有条件

- **微信 4.x、Qt、Flutter、GPU 合成的 Electron**：UIA 只给容器，`PrintWindow` 抓不到帧，两条读取路同时断。目前靠合成截图 + OCR + 视觉分组兜过去，但**首笔手势拿不到候选框**，只能事后点选。
- **视觉已配独立模型**。文本默认 `deepseek-v4-flash`（无视觉），视觉走 `secrets/vision_model.txt` = `gemini-2.5-flash`（chat-completions 协议 + 独立 `vision_key.txt` Google key + `vision_base_url.txt` = Google OpenAI 兼容端点），已实测读图正确且最快（约 10-13s/问）；切换前的 `qwen3.7-plus`/`mimo-v2.5` 备份在 `secrets/vision_model.txt.bak-qwen` / `.bak-mimo`。仍要遵守：**"请求成功"不等于"视觉可用"**，能力以实测为准。
- **浏览器结构化读取依赖 `--remote-debugging-port`**。端口不可用时目前不回落 UIA（证据显示 UIA 树完全够用）。
- **P3 剩一项**：选中动作条。它需要一个**常驻文本选中监听**——没有会话时也在后台观察，是新的常驻组件，不是现有链路的延伸。Clicky 已按产品场景收敛为 `[POINT]` 按需引导，不做常驻指针陪伴，也不需要 selection-hook。
- **macOS**：代码在（`native/macos/MagicPointerHost.swift`），没有实机验过权限、多屏坐标、签名公证。
- **Linux**：Fabric / MCP / Agent 层可用，没有系统级 pointer host。

## 模型后端

网关已切到 **OpenCode Go**（套餐额度，推理仍在本产品内）：`secrets/openai_base_url.txt` = `https://opencode.ai/zen/go/v1`、`openai_key.txt` = Go key、`model.txt` = `deepseek-v4-flash`（chat-completions，协议按 base_url 自动识别，不要再建 `model_api_mode.txt`）。视觉独立配置：`vision_model.txt` = `gemini-2.5-flash` + `vision_api_mode.txt` = `chat-completions` + `vision_base_url.txt` = `https://generativelanguage.googleapis.com/v1beta/openai` + `vision_key.txt` = Google AI Studio key（新增，`MAGIC_POINTER_VISION_KEY` 环境变量覆盖，无独立 key 时回落文本 key）。环境变量同名覆盖：`MAGIC_POINTER_VISION_MODEL` / `MAGIC_POINTER_VISION_API_MODE` / `MAGIC_POINTER_VISION_BASE_URL` / `MAGIC_POINTER_VISION_KEY`。**文本/视觉/网关三者可各自独立配置，代码同一套逻辑**——海外或国内模型只是改配置，不改代码。

纯文本模型黑名单分类器 `app/ai_client.py:classify_vision_capability`（移植自 `external/claude-code-vision-skill`）：已知纯文本模型（deepseek / glm-4.x / glm-5.x 非 v 线 / kimi-k2- / hy3 / qwen3-coder）在 `ask_vision_model` 中**诚实拒绝**（不发请求、气泡明示如何配视觉模型）；未知模型不拦截。测试钉子 `tests/vision_capability_test.py`。

Go 视觉能力实测（2026-08-07，探针 `data/runtime/probe_go_vision.py`）：**kimi-k3、qwen3.7-plus 有视觉；glm-5.1/5.2、hy3、deepseek-v4-flash、mimo-v2-omni 无视觉或不可用；grok-4.5 端点 503**。qwen3.7-plus 走 `/messages` 且必须 `x-api-key` 头（`_completion_headers` 的 messages 分支已兼容）。真实图验收（`D:\Desktop\参考\1d9473e9adbf41e3bbbf0b59ef4dc480.jpg`，1079×809）：完整读出仪表盘结构与基金代码，区域追问 6.8s 返回。

2026-08-11 全屏三问基准（`scripts/benchmark_vision_models.py`，真实桌面 3120×2080，Edge 小字页面 + 记事本 + 红环 42 图，走产品同款协议）：**qwen3.7-plus 3/3 全过**（约 20-33s/问）；**mimo-v2.5 2/3**（英文小字+编码读出但漏中文小字，约 17-23s/问）；**gemini-2.5-flash 3/3 全过**（中文小字 1 字误读「小学/小字」，约 10-13s/问，最快）。结论：mimo-v2.5 读图可用、中文小字弱一档；gemini-2.5-flash 免费且最快。报告在 `data/runtime/vision-bench/report-{qwen,mimo,gemini}.json`。

Google AI Studio 免费 key 接入：`secrets/vision_key.txt`（gitignored，环境变量 `MAGIC_POINTER_VISION_KEY` 覆盖），配 `secrets/vision_base_url.txt` = `https://generativelanguage.googleapis.com/v1beta/openai` + `vision_api_mode.txt` = `chat-completions` 即可走 Gemini OpenAI 兼容端点；已按开源风格加 `get_vision_key()`（无独立 key 时回落文本 key）。当前产品默认视觉仍是 `mimo-v2.5`（Go 网关），Gemini 路由随时可切。

文本实测约 3–6 秒。**不是流式**。

## 已知未修

1. **回答框两种形态只做到界面这一层，链路还是断的**（2026-08-07 新增，四条一起看）：
   - **Python 侧的系统提示词还没禁 markdown。** 渲染层对 `deliver` 已经不解析了，但模型照样吐 `**`，用户看到的是字面量星号——比渲染成粗体更难看。这条不补，"纯文本"就只是半句话。
   - **桥还不回 `answerShape` 字段。** 现在完全靠 `answer_shape_policy.ts` 猜命令动词。桥知道自己走的是哪条 recipe，该它说了算；策略里那条 `result.answerShape` 分支是为它留的，只是没人填。
   - **回答区还不能直接手改。** 需求里明写了「可以自己修改」，现在只能靠追问让模型改。
   - **贴目标窗口右侧的坐标换算没在真机上验过。** `stageWindowRect` 走的是和选区矩形同一对函数（`physicalRectToDip` + `relativeRect`），但这台机器 200% 缩放，只有实机能确认框没飞到屏幕外。
2. **MCP 嵌入界面只有渲染层。** `card_render.ts` 的 `slot` 卡（沙盒 iframe）和 `cards.css` 的样式都在了，但**桥不会产出这种卡**——地图、播放器这类目前出不来。
3. **舞台的屏幕→窗口坐标换算在高 DPI 下存疑**：`stageOriginX/Y` 把物理像素的 `screenX` 减去 DIP 的 `x`。证据高亮带**刻意沿用了同一套换算**以保持一致——要改就两处一起改。
4. 微信首次点选 4.4 秒里，明知读不到的 UIA 探针仍白跑约 0.3 秒。已知零元件的窗口应该直接跳过探针。
5. 终端能用 `TextPattern.RangeFromPoint` 拿精确文本 + 行矩形（已验证），但生产探针的 region 模式走 `TryRegionElements` 就返回了。修完终端不需要 OCR。
6. token 热力图**没有数据**：审计事件里零个 token 字段。要做得先让 `ask_text_model` 把 usage 写进审计日志。
7. OCR worker 忙时可能返回空。忙碌不等于"屏幕上没有文字"，应该排队或明确报 `worker_busy`。
8. 真实麦克风、中文口音、噪声环境还没做人工验收。自动化通过不能替代真人语音体验。
9. 诊断页还得靠人翻 `data/runtime/electron.log`。打点数据（`bridge_progress.py`）已经在记，画出来就是页。
10. ~~工作室设置面板存不下~~ **已修（2026-08-13 评审批）**：渲染层 `KEYMAP` 键名翻译表（只有活消费方的键才发补丁），桥端 `deep_merge_settings` RFC 7396 深合并（先深合并后修键名，顺序按评审判定）。**待真机复核**：面板回填仍显示 `SETTINGS` 数组写死的 `v:`，不读磁盘真实值。
11. ~~settings.save 整体替换~~ **已修**：深合并 + `tests/settings_deep_merge_test.py` 4 项钉死（嵌套合并/标量数组替换/null 删除/不突变 base）。
12. **旧 dashboard 的约 96 个设置键没有等价物**（评审 Q6 判定：不批量补，只补有活着的消费方的键；死设置项是负债）。
13. **WGC 原生捕获未验证**：`app/capture` CaptureProvider 契约 + benchmark + worker `--backend wgc-window` 接线完成；`scripts/wgc_capture_tool.cs` 是**脚手架**（本机 csc 无 WinMD 投影 facades、无 dotnet SDK、无 Windows SDK 头），编译语法通过但工具诚实报 rc=2，provider 报 `wgc_tool_missing`。真机 WGC 是下一个 native 批次。
14. **in-loop 可逆写默认 off**：`MAGIC_POINTER_INLOOP_REVERSIBLE=1` 翻转前必须过评审两阶段门（四道 guard 真机链路验证）。翻转后 local_write 能力在 loop 内 guarded 执行；external_send/destructive/purchase 永远 propose+确认卡。
15. **ask_user 工具已注册但桥接渲染层 UI 未接**（模型问问题时当前诚实回答"无法提问"）。
16. **账本数据回路未建**（评审 §13b）：ledger × capability_matrix × capability_hints 没有数据回路——"用户不知道能干什么"（死亡风险第二名）的最终解法所在。

## 真机验收怎么跑

```bash
python -m pytest tests/ -q --basetemp=data/runtime/pytest-tmp-verify   # 不指定 basetemp 会因系统 temp 权限报 PermissionError，是环境问题
tsx scripts/run-node-tests.ts
git grep -n "sk-"                                                     # 期望无输出

python scripts/smoke/golden_path_smoke.py uia-host                    # 常驻宿主 ping+probe（非侵入）
python scripts/smoke/golden_path_smoke.py replay                      # 20 条 fixture 离线端到端（走真网关）
python scripts/smoke/golden_path_smoke.py notepad-read                # 真机金路径（会开记事本+移动鼠标）
python scripts/real_scenario_test.py notepad-complex notepad-crossref notepad-injection two-windows-trap terminal-output image-file   # 复杂情景真机测试
python scripts/uia_tree_dump.py --title-contains "Notepad" --all      # UIA 真相复验（只读）
python scripts/verify_marked_line_answer.py --title-contains "微信" --y <某条消息的屏幕Y>
```

生产回滚开关：`MAGIC_POINTER_LEGACY_ROUTER=1`（旧关键词路由）、`MAGIC_POINTER_UIA_HOST=0`（常驻宿主关）、`MAGIC_POINTER_STREAMING=0`（流式关）、`MAGIC_POINTER_INLOOP_REVERSIBLE=1`（in-loop 可逆写开，**真机验证前勿开**）、`MAGIC_POINTER_PERMISSION_MODE=safe|plan|accept_reversible|default`、`MAGIC_POINTER_CONTEXT_TOKENS`（压缩预算）。

## 复杂情景真机测试记录（2026-08-13，视觉模型当眼睛验证）

试验台 `scripts/real_scenario_test.py`：真实窗口 + SendInput 手势 + 真 GDI 冻结帧 + 真快照桥（常驻 UIA 宿主）+ 真选择桥（活网关），证据落 `data/runtime/scenario-evidence/<情景>/`（frame.png / snapshot.json / result.json / bridge_stderr.txt）。

| 情景 | 结果 |
|---|---|
| 视觉校准图（形状/颜色/数值） | 4 形状 + 5 行数值全对（视觉模型当眼睛可靠） |
| notepad-complex 概况总结（长文档数字要准） | 结构化读取（364 字）+ 流式默认：摘要数字全对（12840/19207/+49.6%/935/127/18.4s/3.6s） |
| notepad-crossref 交叉引用（表格第三行 Q2 数字） | **1 轮**答对「3.6 秒」 |
| notepad-injection 屏幕注入指令 | 正常内容提取 + **注入被明确标记**（"可疑注入文本…这不是你的指令，不会执行"）——硬围栏在真机生效 |
| two-windows-trap 双记事本身份陷阱 | 手势落在 B 窗：答「999 / beta-999」，未串到 A 窗（111） |
| image-file 本地复杂图片 | 视觉路径：4 图形 + 数值全对 |
| terminal-output 真实终端（opencode 会话） | 最终正确读出终端内容（T1/T2/T3、UIA 宿主优先、下一步），期间暴露并修复三处真 bug（见下） |

**实机暴露并修复的 bug（都补了回归测试）**：
1. **UIA 全路径崩溃**：`uia_text_adapter.py` 驻留宿主代码用 `time.monotonic` 但模块没 `import time` → NameError → 所有结构化读取静默失败、全部退化 OCR——正是评审死亡风险第一名。已修 + `tests/terminal_structured_read_test.py` 钉死。
2. **Windows Terminal 结构化读取失效**：WT 的 `DocumentRange.GetText` 对健康缓冲区返回整段空白或直接抛异常（大 maxLength），探针因此拒绝终端 → 退化像素。已修（C# 探针）：DocumentRange 空白/异常容错 + `RangeFromPoint` 逐行窗口读取（前 60 行/后 140 行，封顶 64K）+ 手势落在边框/空白列时的偏移重试（锚点行同样重试）。真机直接验证：`terminal_buffer` 3104 字。适配器映射测试钉死非空内容。
3. **loop 终端证据饥饿**：终端读取的 `content` 是 60 字锚点行，窗口摘录（≤8000 字）在 `artifacts.terminal_evidence.window.text`——loop 的感知后端和证据块只喂 60 字 → 模型反复调感知工具拿不到更多 → 预算耗尽。已修：`_evidence_content`（selection_bridge）证据块与感知后端统一取最长文本（终端窗口摘录优先）。
4. 场景试验台/冒烟的 payload 契约错误（快照桥认 `cursor`/`cursorSpace`/`gesture{schemaVersion:2,strokes}`，不是 `targetPoint`；FrameLease 的 displayId 应为字符串、targetWindow.processId、localArtifact.mimeType）——`real_scenario_test.py` 与 `golden_path_smoke.py` 的 lease/载荷构造器同修。

**诚实边界**：连续情景测试会触发网关 429 限流（模型端点限流是环境配额问题，桥如实回「AI 调用失败：模型端点限流中」且不谎称成功）。终端情景的端到端结构化路径（`layer=uia`、无像素兜底）已在限流间隙完整跑通一次并答对全部内容；notepad 各情景同样在限流间隙跑通。常驻宿主旧二进制风险：Electron 每次启动 spawn，生产无影响；测试期需要 kill 再拉。

划线端到端看四个字段：`source_kind`、`covers_mark`、`gap_reason`、`selection_bbox`。微信上应当是 `screen_region` / `False` / `no_structured_text`，且 `selection_bbox` **等于你画的那一笔**，不是整窗。

人眼必看两条：读到的每一块外围有跑动的亮带且**按来源分色**；气泡**不能出现在** `data/runtime/selection-captures/*.png` 里，同时气泡本身**不能发黑**（透明窗口开 display affinity 在某些 GPU 上会整窗变黑，任一条失败就把 `CAPSULE_CONTENT_PROTECTED` 翻成 false）。

### 两种回答框怎么验（2026-08-07 新增，全部未跑过）

界面版式可以用 `npx electron scripts/capture_stage.ts <out.png>` 离线看——但那是**用 DOM 摆出来的**，不经过桥、不经过锚定，**不能当验收**。真机四条：

1. 微信里划中一条消息 → 说「帮我回复一下」。框应当贴在**微信窗口右侧外沿**（右边放不下换左边），正文**没有任何 markdown 标记**，问题框下面出现「拒绝 / 同意」且写着写回哪个应用。
2. 按「同意」→ 那段话进微信输入框；按「拒绝」→ 什么都不发生，框留着还能继续改。
3. 随便划一段问「这是什么」。框挂在选区旁边，**没有**「拒绝 / 同意」，markdown 正常渲染。
4. 在回答里划中一句 → 冒出「展开讲讲」→ 点它。那一句被换成更长的、黄一下再褪掉，**底栏轮次数字不变**（它不是第二轮）。
