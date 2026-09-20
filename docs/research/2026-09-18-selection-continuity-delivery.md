# 圈选证据、任务连续性与 Claude 参考界面修复

本记录区分真实故障、代码修复、模型验证与界面验证。安装交付状态以 `docs/STATUS.md` 为准。

## 用户报告与已证实的原因

用户圈选的是 Codex 右侧 Environment 面板。原始冻结帧为 `data/runtime/frame-leases/frame-77cd6b736b74471b.png`，3120×2080，物理选区 XYWH 为 `[2505,206,598,482]`。窗口内有 Environment、Changes、Local、main、Commit or push、Pull request status unavailable 和 Compare branch。用户问的是这个对象，而非 JSONL 对话的主题。

- 原任务 `agent-a3618dc7-e244-4894-b2a6-2157f77a05d9` 将视觉 Provider 的 HTTP 429 错误文本记录成了 status=ok、confidence=1 的屏幕证据。随后模型沿着局部 OCR 片段和会话背景作了错误解释。
- UIA 返回 1560×992 的逻辑边界，而截图及鼠标坐标在 3120×1985 的物理空间，二者混用。
- Electron 转换逐笔手势时丢失 canonical geometry，闭合选区进入 Python 后被重新按开线分类，选区 OCR 被错误缩窄。
- 对话 `c1789657940597` 已落盘 552 字答案，但 GUI 的通知仅刷新侧栏，没有刷新正在打开的正文。
- Stage 每个进度片段重建卡片，展开状态和文本节点被反复替换。关闭临时窗口同时失效 selection session 并取消其子进程，使任务所有权错误地依赖一个展示窗口。
- selection bridge、Stage contract 和持久会话间丢失推理、轨迹、运行身份、权限输入、usage 和任务材料等信息；GUI 续问也没有接受 selection 的 agent UUID 身份。

## 已实现的底层修复

1. 视觉失败统一为失败契约；空输出及 AI failure prefix 不再作为成功内容。Look 返回 confidence=0 并保留 Provider 的实际错误原因。UIA 在线程进入 COM 前启用物理坐标 DPI 模式；逐笔 geometry 保留并转换到物理空间，OCR 使用已经确认的闭合选区。
2. 一份 `RuntimeActivitySink` 同时服务普通对话和圈选任务，输出相同的答案、推理、工具调用/结果与最终轨迹。完整工具返回通过单个 base64 JSON 进度事件传输，解析器保留分块到达的大结果，工具失败不会被成功标签掩盖。
3. 任务在提交时获得持久 conversation/turn；Stage 与 GUI 消费相同的 live progress。关闭 Stage 只解除窗口挂接；显式 Stop 或 GUI 运行态 Escape 才取消执行，小窗的关闭快捷键仍只关闭展示。新选区不会淘汰仍运行的旧任务。迟到输出及最终结果不能重新弹出已关闭的 Stage。
4. 实时渲染复用 DOM 节点；思考展开状态、阅读滚动位置保持稳定。终态通知刷新当前 GUI 正文和权限/澄清输入，无需退出再打开。COMPLETE 保留实际答案，ERROR 保留已有答案和工具轨迹。
5. selection UUID 会话可从 GUI 继续。最终 taskContext、agentSessionId、pending work、pending input、用量与证据一起保存；运行轨迹不再在第 256 条静默截断，300 条轨迹的持久化回归验证两端完成后的过程仍相同。会话摘要返回全部保留记录、创建时间与材料来源，供全会话页、排序和定时任务选择使用。
6. 圈选规则要求先解释选区对象，JSONL 只补充背景。冻结读取失败后改读实时屏幕，必须说明信息来自当前画面；实时数字不能冒充圈选时刻的数字。
7. 全图 OCR 的固定 640 像素检测把原面板压成约 123×99 像素。现在保留全图检测，并对有分辨率收益的选区及周边做细读；识别始终使用原分辨率像素，检测框映射回原图坐标并缓存。原图生产 OCR 已完整读出八项标签。
8. InputArtifact 不再遗漏 OS 已知的窗口标题、进程、物理边界及选区坐标；同一几何计算给出 `selectionLocation`，本图为 `top-right`。视觉模型取得明确的局部 anchor，完整冻结全景作为同一对象的上下文附图。Look 的历史上下文实例与 Observe 的实时视觉实例分开，实时调用不会混入历史图。

## 真实 Provider 证据与限制

- `artifacts/selection-frozen-vision-20260917.json`：生产 LookTool → 原冻结帧裁剪 → FileVisionBackend → 当前真实配置的 `app.ai_client.ask_vision_model`。耗时 **12475.82ms**，正确识别 Environment、Changes +17,726 / -1,227、Local、main、Commit or push。输出在 Commit or push 后结束，不能宣称完整底部标签转录已经通过。
- `artifacts/selection-sovereign-replay-20260918.json`：同一原始问题、只读 plan 模式、生产 OCR 与自有 Runtime，**59102.14ms / 3 轮 / 27073 input / 1077 output / 10432 cache read**。能解释 Environment，但该轮冻结视觉失败，随后 Observe 读取了当前桌面，回答中的变更数字因此来自当前画面。这不是冻结画面准确性的完整通过；该发现促成上述来源区分与错误原因保留。
- 原始 raw gesture points 未持久记录，回放采用原物理 bbox 构造闭合多边形；不能称其为逐笔完全相同的原始输入重播。
- 第二次回放 `selection-sovereign-replay-20260918-after.json` 用47.94s返回；真实HTTP429原因透传，但模型将缺乏标签的 `+17,726` 猜成提交数，仍失败。纯本地对照随后确认：全图缩成640px使面板只有122.67×98.87px，漏读Changes与删除数；保留周边64px的细读恢复全部8项标签。证据在 `artifacts/selection-ocr-scale-comparison-20260918.json`。生产worker据此保留全帧检测并增加有分辨率收益的局部检测，仍从全尺寸原图识别文字，局部框转换回原图坐标且缓存两类检测；定向18项通过，最终生产回放另记。
- `selection-sovereign-replay-20260918-detail.json`：当前 OCR 4014.2ms，全部标签正确；Runtime 27.30s，正确解释增删行数，却误称 VS Code 左侧。因此不能仅凭 OCR 成功宣布问题修复，窗口身份随后进入模型投影。
- `selection-sovereign-replay-20260918-identity.json`：OCR 3823.46ms、Runtime 83.95s，改为 ChatGPT 身份，首次局部 Look 成功但描述短缺；模型又误用 XYWH 作 LTRB、再遇429，最终仍猜测 Artifact 功能归属及 PR 不可用原因。此轮为部分改善，非完整验收通过。
- `selection-sovereign-replay-20260918-fullcontext.json`：实际请求包含 679×610 主图和原始 3120×2080 同帧上下文，OCR 2917.45ms、Runtime 35.64s、3轮、`usedBackend=magic_pointer.messages_multiturn_streaming`。Look HTTP429，没有 Observe。模型仍错说底部并猜测实现架构；这促成由运行时直接计算选区位置，而非让模型根据数字猜位置。全景传递与历史/实时隔离的生产接线回归67项通过，尚不能把受限流影响的这一轮称为视觉理解通过。
- 最后一轮 `selection-sovereign-replay-20260918-location.json` 已含真实 `selectionLocation=top-right`，OCR 3048.30ms、Runtime 33.62s、3轮，同一真实 backend。回答不再误称底部/左侧/VS Code，应用及增删行数正确，但省略右上位置，并仍将 PR 状态不可用归因为没有关联 PR。Look 再遇 HTTP429，无 Observe。严格识别验收仍是部分通过，未继续重试。成功视觉响应的结束原因/usage 未取得，不能将前次短缺文本武断归因为1200-token上限。

读取这些回执又发现：感知 Evidence 已明确 unsupported/error，但循环的外层 ToolResult 仍标 `is_error=false`。现已在既有归一化边界将 error/unsupported/timeout/busy/denied 转成对应失败，保留完整 Evidence JSON 和 backend/timing；degraded/empty_confirmed 仍作为可用部分证据/确定为空。五个错误用例先失败再通过，连循环及视觉接线 **116 passed**。它修正了模型历史和两端工具失败样式；上述最后一轮真实模型回放发生在此标志修复之前，不混写验证先后。

## 实际双窗口验收

`scripts/probe_selection_live_acceptance.js` 使用真实编译 main、真实 preload IPC、两扇离屏 Chromium BrowserWindow 和隔离用户目录；替换的是模型进度样本和与本项无关的启动/网络边界，不是任务状态或 IPC。

`artifacts/selection-live-acceptance/acceptance.json` 记录：两窗口实时答案/推理/工具结果一致；答案、思考容器、思考正文节点身份不变；关闭按钮使 Stage detached=true、requestSurvived=true、killRequests=0；后续片段不会重开 Stage；GUI 自动显示最终答案并结束忙碌状态；随后的权限问题自动显示三个确认按钮；consoleErrors 为空。此验收为 `usedBackend=recorded.fixture.read_only`，不是第二次真实模型请求。

后续新增真实 Chromium 验收还确认：GUI Stop 的实际鼠标点击到达对应 selection child；Tab 接受预测为可编辑草稿且会话 turn 数不增加；长文 textarea 的实际 height/maxHeight 均374px，900px以上内容内部滚动；Edit 失败在两端保留红绿差异及完整错误。Markdown 的 HTTP/HTTPS/file/data 四类 `<img>` 均实际解码，HTTP(S)响应由隔离协议fixture提供已知PNG，未访问网络。Stage 的额外计时展示另行移除，阶段状态来自同一共享投影。

## 参考图与资源边界

逐图对照见 `2026-09-17-claude-reference-parity.md`：原始 22 张、新增 25 张，共 47 张均独立查看，另检查既有 6 张抓取状态。

本机 Claude **2.110.0.0** 的 `resources/ion-dist` 补足了此前缺失的原始资源。来源、准确 CSS 动画参数、Scheduled 微预览 React、Artifacts 动态缩略图 bundle 与空态 SVG 存于 `参考claude设计/scraped/extras/desktop-2.110.0.0/README.md`。图标真实字体包含 ANIM/ANM2 轴；Code 使用独立循环，Palette 使用 800ms 特例，其余按实际 glyph 元数据启用。静态截图本身不证明动效时序。

Projects/会话/材料关注/技能/Harness 插件/MCP 页面只投影本产品真实数据。MCP configured 不等于 connected，发现插件文件不等于插件已激活。不复制 Claude 订阅、组织分享、第三方安装量等不存在于 MP 的事实。视觉状态验收与最终全量/安装结果在本批收尾补记。

第二次逐图复核后继续补修：预测追问可用 Tab 接受成可编辑草稿且不自动发送；自己的输入、Shift+Tab、IME 不被覆盖；长文高度使用当前 CSS 上限；GUI Stop 同时接受本窗和圈选任务；Edit/Write 的展开与统计使用相同生产工具名；Code 发送恢复原始 ArrowReturn 字形，标题恢复 Laptop，移除常驻 @ 显示。每项都先观察预期失败再修复。Artifacts HTML/SVG 为不执行脚本的实际内容预览、实际图片预览和三列布局；Design 日期分组及布局切换；Chats 批量归档/恢复/删除及失败保留；这些状态另由真实 Chromium 验收记录。

中间完整验证 `data/runtime/selection-parity-final-verify-20260918.log`：lint/typecheck 通过，Node **227 test files**，Python **2153 passed / 1 条既有 Pillow warning / 230.79s**。该结果早于最后的界面补项与视觉全景接线，安装交付须使用收尾新一轮全量结果，不能把这个中间门当作最终门。

## 最终页面验收

最后三项现有数据可支持的差异也已完成：Chats 的标题与工具栏同行、Plugins Yours 紧凑列表、可搜索的项目侧边子菜单及新建项目后分配。右侧筛选子菜单根据可用空间向左展开，原生鼠标点击落在窗口内；HTML/SVG 内容以完整画布缩成缩略图。Stage 补载与 GUI 相同的星芒和代码高亮脚本，移除独有秒数；两端真实阶段文字仍保留。

最终编译版本的双窗验收 **6178ms / ok=true / consoleErrors=[]**；库页验收 **24189ms / ok=true / failures=[] / consoleErrors=[]**。后者覆盖实际搜索、项目持久分配、批量操作、真实内容预览、排序、导航和原字体/模板动效。目录选择器返回值是隔离测试目录，注册和会话分配走真实 main/preload/store；不把它描述为操作系统目录选择器外观验收。最终图片分别在 `artifacts/selection-live-acceptance/` 与 `artifacts/library-acceptance/`，父任务复看了 Artifacts、小窗运行态、GUI 完成态、项目搜索子菜单和 Plugins 列表。

收尾前又一轮完整验证 `data/runtime/selection-parity-release-verify-final-20260918.log` 已通过 **Node 228 个文件 / Python 2164 passed / 1 条既有 warning / 218.29s**。此门之后补入最后三项库页差异，因此另启 `selection-parity-delivery-verify-20260918.log` 验证最终代码；安装结果在下节补记。

## 最终全量与本机交付

最后生产冻结后的 `data/runtime/selection-parity-delivery-verify-20260918.log` 已通过：ESLint、全部 TypeScript 配置、**Node 228 个测试文件、Python 2164 passed / 1 条既有 Pillow warning / 227.51s**，退出码 0。

`npm run sync` 已成功，内置全量复验也通过相同 lint/typecheck、Node 228 个文件及 Python **2164 passed / 1 warning / 214.50s**。构建安装包 `release/sync-1.0.47-20260918-013049-44572/Magic-Pointer-1.0.47-x64.exe`，384179519 bytes；2026-09-18 01:47 本机同步结束并重启。完整日志为 `data/runtime/selection-parity-sync-1.0.47.log`。

安装后独立核对：

- 开发树及 `%LOCALAPPDATA%/Programs/Magic Pointer/resources/app/package.json` 均为 **1.0.47**。
- 新增/修改的交付 Python、全部 Electron/Figma 构建与资源共 **308 个文件逐字节一致，0 项缺失或差异**。没有以版本号一致代替实际内容核对；报告为 `artifacts/installed-file-parity-20260918.json`。
- 安装版自带 Python 以隔离模式运行，6 个关键模块的实际导入路径全部位于安装目录；本地调用确认 ChatGPT 进程身份、top-right 位置、selection anchor、OCR 细读 ROI、感知失败的 is_error 及历史/实时视觉实例隔离。该检查无网络请求，也不伪称再次执行真实 OCR/模型；报告为 `artifacts/installed-selection-smoke-20260918.json`。
- 5 个 Magic Pointer 进程的可执行路径均为本机安装目录，启动时间 01:47:38–39。

`docs/STATUS.md` 与设计进度账本已更新。原有用户/其他 Agent 的未提交工作保留；模型识别的严格未通过项和未取得的参考资源/服务状态继续保留，不因安装成功改写为通过。
