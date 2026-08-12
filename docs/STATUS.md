# 当前状态

> 最后核实：2026-08-12。改了行为就回来改这里，别新建一份日期文件。

## 一句话

FrameLease 捕获地基（8·11 计划 Phase A）已全量落地并过自动化验证；外部 harness 评审（`docs/harness-gap-review-20260812.md`）已吸收，评审 P0 的 L6 证据契约、L8 预算/取消模块、L12 Replay 基座已建好独立模块；下一步是评审批次 1：L1 Agent Loop + L2 感知即工具。全量测试：**Python 1253 过 / 2 环境依赖失败（`local_image_vision_test.py` 硬编码本机验收图 `D:/Desktop/参考/1d9473e9....jpg` 缺失，与本次改动无关）；Node 89 源文件 131 测试全过**；typecheck、ESLint、ruff 通过。

分支 `codex/multi-stroke-and-voice-fix`，未推送。当前全量测试：**Python 1073 项、Node 127 项（86 个 JS/TS 源文件）**，ESLint 与 TypeScript strict typecheck 通过；Electron/Node 非测试源码已全部迁移为 TypeScript（**87 个非测试 `.ts`，非测试 `.js` 为 0**），重构前 Node 基线为 145 项。

## 一句话

结构化应用（记事本、Edge、Office、终端）的划线读取链路已经可用；自绘应用（微信 4.x、Qt、Flutter）还缺"首笔手势直接给出像素候选框"这条生产链路。**不能宣称"任意 Windows 软件里随手一划都能稳定理解完整对象"。**

## 能用

| 能力 | 状态 |
|---|---|
| FrameLease 冻结先于感知（pointerup→commit→会话） | 可用（GDI 后端，p50≈192ms / p95≈213ms / max≈233ms，20/20 轮） |
| 证据契约（ok/busy/timeout/empty_confirmed 可区分 + 反容器启发式） | 模块可用，感知链未接线 |
| 延迟预算表 + 取消令牌（代际淘汰） | 模块可用；agent loop 已接线（每轮 FULL_ANSWER 预算门控 + 循环级取消作用域），桥/其他外部调用方未接线 |
| Desktop Trace 录制/回放（离线感知测试基座） | 基座可用，感知层回放未接线 |
| 晃动唤醒 → 划线圈选 → 气泡问答 | 可用 |
| 39 个 Recipe（数据驱动，`data/recipes/builtin.recipes.json`） | 可用，插件目录可加载 |
| 三层意图路由（L0 关键词 / L1 分类 / L2 工具调用兜底） | 可用 |
| 结构化读取：UIA / Chrome DevTools DOM / Office COM | 可用 |
| 像素读取：常驻 OCR worker + 视觉元件框 | 可用 |
| 证据高亮带（蓝＝结构层，琥珀＝像素） | 可用 |
| 「填入」把气泡答案写进别的应用输入框 | 可用，自适应找当前输入框并在写入后读回校验 |
| 回答框两种形态（要送出去 / 自己看） | 判定与界面可用，**未实机验证**，见下 |
| 在回答里划中一段就地展开 | 渲染层 + 桥可用，**未实机验证** |
| Dashboard 设置 / 权限 / 审计 / 诊断 | 可用 |
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
10. **工作室的设置面板一条都存不下来**（2026-08-09 新增，实测）。`settings.ts` 的 `writeSetting` 发的补丁用的是自造键名（`act.wiggle`、`voice.resident`、`cap.mode`），和 `app/fabric/settings.py` 的 schema（`activation.wiggle_enabled`、`interaction.voice_resident_enabled`、`privacy.default_capture_mode`）对不上，也不带 `schema_version`；`FabricSettings.from_dict` 于是抛 `SettingsError`，`saveFabricSettings` 又是 `ipcRenderer.send` 的单向调用，主进程只在 `ok === true` 时才动作——**每次拨开关都静默失败，界面上却已经拨过去了**。同时它也从不回填：面板显示的永远是 `SETTINGS` 数组里写死的 `v:`，不是磁盘上真正生效的值。
11. **`settings.save` 是整体替换，不是合并**（2026-08-09 实测）。`fabric_bridge.py` 收到补丁后直接 `FabricSettings.from_dict(payload)` 再 `store.save`，缺席的分支一律取默认值——实测先存 `activation.sensitivity=0.9`，再发一个只含 `appearance.theme` 的补丁，`sensitivity` 被冲回 `0.55`。**修第 10 条时不能只给补丁补上 `schema_version`**：那样验证就过了，于是每拨一个开关会把其余所有设置清成默认，比现在静默失败更糟。要么渲染层发完整设置对象，要么桥改成深合并。
12. **旧 dashboard 的约 100 个设置控件没有等价物**（2026-08-09）。工作室的 `settings.ts` 覆盖 96 个键，但是另一套语义，且与上面两条一起决定了它目前不通链路。已随死界面删除、需要重建的包括：唤醒与手势参数（`wiggle-sensitivity` / `gesture-arm-delay` / `gesture-timeout` / `multi-stroke-submit` / `gesture-interaction-mode`）、选区视觉全套（`selection-visual` + `sweep-*` + `capsule-*`）、语音驻留（`voice-resident-enabled` / `voice-memory-limit-mb` / `voice-idle-unload-seconds`）、语音文本规整（`voice-punctuation` / `voice-script` / `voice-mixed-spacing` / `voice-start-strategy`）、模型档案、权限范围、隐私留存天数、诊断页（`session-timeline` 容器）。settings_store 里对应的校验和默认值都还在，缺的只是界面。

## 真机验收怎么跑

```bash
python -m pytest tests/ -q --basetemp=data/runtime/pytest-tmp-verify   # 不指定 basetemp 会因系统 temp 权限报 PermissionError，是环境问题
tsx scripts/run-node-tests.ts
git grep -n "sk-"                                                     # 期望无输出

python scripts/uia_tree_dump.py --title-contains "Notepad" --all      # UIA 真相复验（只读）
python scripts/verify_marked_line_answer.py --title-contains "微信" --y <某条消息的屏幕Y>
```

划线端到端看四个字段：`source_kind`、`covers_mark`、`gap_reason`、`selection_bbox`。微信上应当是 `screen_region` / `False` / `no_structured_text`，且 `selection_bbox` **等于你画的那一笔**，不是整窗。

人眼必看两条：读到的每一块外围有跑动的亮带且**按来源分色**；气泡**不能出现在** `data/runtime/selection-captures/*.png` 里，同时气泡本身**不能发黑**（透明窗口开 display affinity 在某些 GPU 上会整窗变黑，任一条失败就把 `CAPSULE_CONTENT_PROTECTED` 翻成 false）。

### 两种回答框怎么验（2026-08-07 新增，全部未跑过）

界面版式可以用 `npx electron scripts/capture_stage.ts <out.png>` 离线看——但那是**用 DOM 摆出来的**，不经过桥、不经过锚定，**不能当验收**。真机四条：

1. 微信里划中一条消息 → 说「帮我回复一下」。框应当贴在**微信窗口右侧外沿**（右边放不下换左边），正文**没有任何 markdown 标记**，问题框下面出现「拒绝 / 同意」且写着写回哪个应用。
2. 按「同意」→ 那段话进微信输入框；按「拒绝」→ 什么都不发生，框留着还能继续改。
3. 随便划一段问「这是什么」。框挂在选区旁边，**没有**「拒绝 / 同意」，markdown 正常渲染。
4. 在回答里划中一句 → 冒出「展开讲讲」→ 点它。那一句被换成更长的、黄一下再褪掉，**底栏轮次数字不变**（它不是第二轮）。
