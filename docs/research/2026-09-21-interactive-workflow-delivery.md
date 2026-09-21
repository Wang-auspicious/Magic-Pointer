# 2026-09-21 交互卡、计划与产物语义修复

用户要求：对照 Claude Desktop 修正 Plan、审批卡、反问卡和产物行为，优先保证 Agent 流程稳定；保持 1.0.50，不管理安装版，分批推送 main。

## 参考与边界

参考来自本机 Claude Desktop 2.110.0.0 编译实现，具体文件、偏移及 Code/Chat/Cowork 区分见 [交互取证](2026-09-21-claude-interactive-cards-reference.md)。本批独立实现已经确认的会话状态和组件行为，不宣称复制所有账号的远程开关、完整 Cowork 功能或像素级一致。

## 已落实的行为

- 审批/反问通过独立 `conversations:respond` / `stage:respond-input` 回答原 requestId。后台记录 `user_input/answered`，替换模型上下文中的原工具结果；不追加一条普通用户问题，不新增聊天回合。
- 提交时卡片禁用，接受成功事件立即清卡。接受前失败保留选择、分页及自填内容，可以重试；接受后的模型失败不复活旧请求。回包绑定任务、请求和选区，切换后的旧结果不能覆盖新任务。
- Studio 和 Stage 共用 DecisionCard 的回答状态：工具名/命令预览、Deny、会话授权、Allow once；多题问答包含描述、单选/多选、自填、前后导航和明确 Skip。未回答的页面不能因跳页而被默认为跳过。Studio 使用 Claude Code 的 inline Wk 表面，480px 上限，卡片跟随对话滚动；不再用固定 dock 挤占聊天区。Stage 保持浮层自己的宿主。
- Skip 在后端明确记录为 `skippedQuestions`，不会被误判空答案。指定命令的拒绝真正参与权限判断；一次授权只供匹配动作的一次实际工具调用使用，重复校验同一调用不会重复消费。
- Plan 来自持久会话中的最新 Todo，位于 Tasks 侧栏，默认显示围绕当前步骤的六项窗口，可展开全部。重开恢复计划，空计划清空。根据用户截图反馈，Studio 正文不再重复显示 Todo 列表；Stage 保留独立工具详情。子 Agent 正文仅保留短入口，真实思考、输出及工具记录放在右侧 Background tasks。
- Background tasks 显示真实耗时、工具次数和当前工具；View transcript 才展开内容，流式更新保留展开。Finished 数量/展开与 Clear 按会话隔离，Clear 只隐藏已完成卡，不删除记录。单个 Stop 核验父子会话关系后写入该子任务的取消请求，等待真实中断终态；显示 Stopping，失败可重试，父任务和兄弟任务继续运行。
- 删除每轮最终答复自动生成 DraftArtifact 的路径。普通问答、进度、澄清、权限和计划消息直接呈现；独立交付物由 Agent 显式调用 `Artifact.create/read/update`。修改保留 artifactId 与 revision 校验；读取或讨论旧稿不重新附加产物卡。用户编辑不会被旧版本静默覆盖。
- 本地产物卡显示真实标题、类型与更新状态，移除虚假的“Published artifact”。Studio 打开本地编辑器，Stage 通过真实产物路由打开对应任务和编辑器。

历史自动创建的草稿没有被批量删除：旧数据不能可靠区分用户主动保存的内容与自动生成内容。本次更正生成规则及新轮次的展示。

## 用户截图纠正后的尺寸

用户随后明确要求按自己看到的 Claude Code 尺寸验收，并提供 1199×991 DIP 浅色对话及 1560×992 DIP 深色 Background tasks 截图。此前把 Plan rail、文档 Inspector 和后台任务卡混用，并把大反问卡固定在输入框上方，导致聊天被挤压；该版本不作为合格交付。

- 左栏 288px；导航使用截图的 Code 密度：26px 行高 + 0.5px 行间距、13/19.5 字体、16px 图标、24px leading、4px 图文间距、18px New 圆。普通正文内容宽 768px、外侧对称 32px，用户气泡最大 75%。
- Plan rail 使用源码 240–320px 自适应规则；Background tasks 使用用户两张图的 416px 外框基准，二者是不同表面。该 416px 是截图实测，不宣称所有 Claude 版本或用户配置都固定此值。
- Background tasks 开启时，正文距中央面板左侧 50px，composer 40px；任务卡另按截图及 compiled compact token 实现。
- Code 输入文字 14/18px，上下 13px，编辑区最小 44px/最大 218px；发送控件 24px、距底/右 10px。修复叙述正文的内层 Markdown 覆盖，实际文字为 15/23px。普通对话对称预留滚动条位置，避免正文相对输入框向左偏 4px。
- Background tasks 实测外框 416px、任务卡 394×77px、卡间距 4px、卡内 padding 8px、标题 13/19、元信息 12/15；卡内两处行间距取截图的 4px，区别于本机新版源码的 5px。深色 sidebar/page/panel/composer/card 分别匹配 `#1D1D1C/#20201F/#262626/#2C2C2A/#2F2F2F`。
- Inline 反问整卡最大宽 480px，无 dock 外 padding/gap/max-height；标题横 12/纵 8，选项横/纵 12，说明 13/19，footer 横 12/上 8/下 12，按钮 24px，Other 输入一行起始、最多四行。

窄于 592px 的可用聊天面板采用 MP 的覆盖式打开策略，避免两栏把正文压成零宽；源码确认的是 inline rail 启用阈值，覆盖式策略不是对 Claude 未确认行为的声称。

## 验证方式

新增失败回归先于实现，覆盖真实 EventSession、真实 Runtime loop、桥接入口及 Electron IPC 行为；模型响应使用确定性脚本，以直接验证工具结果回放、权限和版本关系。

真实离屏 Chromium 加载构建后的 Studio/Stage。点击验证原请求提交、重复点击、输入框草稿/附件保留、多题分页和多选、自填、未回答提示、失败重试、accepted 后模型失败、切换选区晚回包、计划恢复/展开及真实产物打开回调。Studio 不再为隐藏的 Todo 创建伪跳转；Stage 的独立工具详情仍有身份标记。

- Studio 证据：`data/runtime/studio-decisions-20260921/witness.json`、`permission.png`、`questions.png`。
- Stage 证据：`data/runtime/stage-input-20260921/witness.json`、`stage.png`。
- 子 Agent 卡与停止：`data/runtime/subagent-streaming-20260920/witness.json`，实际卡尺寸 394×77，`failures=[]`。
- 同尺寸对照：`data/runtime/claude-geometry-review/final-white-conversation.{png,json}`（1199×991 DIP），`final-dark-subagent.{png,json}`（1560×992 DIP）。模型与会话使用明确的回放 fixture，浏览器排版与点击执行真实代码。
- Python 最新全量：**2545 passed / 6 条既有 Pillow 弃用警告 / 286.00s**；日志 `data/runtime/subagent-stop-python-full.log`。此前并发 pytest 使用同一固定 basetemp 会互删 fixture 已用两个真实 pytest 进程复现，现按 PID 分目录。
- 前端最终完整回归：**278 个 Node 测试文件全部通过**；`npm run lint`、全部 TypeScript 配置与 Electron/Figma bundle 构建通过。日志为 `data/runtime/interactive-final-node.log`、`interactive-final-lint.log`、`interactive-final-typecheck.log`、`interactive-final-build.log`。Figma bundle 的既有“未配置真实 plugin ID”提示保留，未冒充原生 Figma 验收。
- 源码提交：`1142170`（原请求回答与显式产物）和 `ac18f7e`（交互接线、侧栏布局与真实子任务操作）。本批分别推送 main，截图与运行日志保留本机；用户原始参考图片未加入提交。

没有运行安装同步、没有修改版本号。本批验证不等同于真实云模型长任务或 Office/Figma 原生应用验收。
