# 独立后台 Agent、子任务审批与真实模型续接

开发版本保持 **1.0.50**；直接在 main 工作，不 sync、不安装、不发布。承接 `2026-09-21-claude-runtime-source-alignment.md` 第一批明确记录的三个运行时差距。本实现使用 MP 自己的工具调度、事件会话、权限、操作账本与模型适配，不调用外部 Claude/Codex 执行循环。

## 用户可见行为

- `Agent(run_in_background=true)` 立即交还父 Runtime。子进程独立执行，父 bridge 退出后仍能完成；有独立会话、任务状态、完整步骤、输出文件和完成通知。`AgentStatus` 查询真实状态；`AgentStop` 停止指定子任务，等待审批也能停止。
- 任务卡在父回合结束后继续读取状态；只在存在活动子任务时继续轮询。重开任务重新读取持久快照。进程异常退出显示中断，不能永久显示 Running 或伪装成完成。
- 子工具审批显示实际完整动作，在父界面批准／拒绝时绑定父 session、子 session、原 requestId；不会改写 composer 草稿，不会发出新的父聊天回合。前台子 Agent 遇到权限等待时转入后台等待，批准后执行原参数。
- 恢复保持子任务 effort、只读限制、父持久权限和子会话内的持久 grant；once 只授权原调用。后台任务恢复默认仍在后台运行，用户／模型可显式选择前台继续。恢复步骤保留审批前的失败尝试和之后真正执行的动作。
- AskUser 选项支持文本／代码 preview；保存和重开保留换行缩进。HTML 作为文本显示，不执行；不把 option preview 误当网页 iframe。

## 运行方式与恢复边界

`background_agent.py` 通过私有 stdin 管道传递当前模型配置；凭据不写入任务状态或会话。子进程继承父 Python 的隔离方式，开发环境不会因强制 `-I` 丢失用户依赖。状态文件由任务 worker 原子更新，Windows 读句柄造成的短暂拒绝访问采用有界重试；错误日志可用于定位启动／终止失败。

完整执行记录仍在原来的 EventSession。审批没有另起一套操作队列，直接回答子会话的待处理请求，继续使用准确一次批准和操作回执。子任务完成进入父会话的 `next-step` inbox，父 Runtime 在后续安全点读到结果；任务卡也可独立显示完成输出。应用重启或 worker 崩溃后恢复是显式操作，不自动重放不确定的写入，也不自动为闲置父对话启动付费模型回合。

## 失败见证与验收

- 跨进程测试先观察到：`run_in_background` 没有实现，父进程一直阻塞，15 秒超时。随后验证父进程真实退出后，独立 worker 能调用 loopback 模型并完成。
- 测试覆盖后台／前台转等待两条审批路径，错误父 session／错误 requestId 被拒绝，原 Write 精确执行一次，等待中 Stop 不写文件，后台恢复不退化为同步等待。
- 同一测试发现真实 Windows 文件替换失败及错误后的重复通知问题；修复后保留这条进程级回归。任务名称和审批前步骤不再在恢复时丢失。
- 子会话恢复测试先发现 Allow for this session 没有继承该子会话自己的 grant；已修复，不扩大 once。
- 实际 Chromium 点击 option preview、子任务 Allow once、原父权限和 Plan 卡，验证 requestId、任务绑定、重复提交门、批准清卡、输入草稿保留。Node 测试另测状态文件读取、退出进程、跨任务隔离及 store／Stage 的 preview 传输。
- 真实已配置模型 **deepseek-v4.1-flash / Chat Completions / streaming**：第一次批准 Write 后 HTTP 400，供应商明确返回 `reasoning_content` 必须回传。修复流式／非流式推理字段持久化和审批合成回合的协议数据后，再次实测通过：Write 请求 → 一次批准 → 写入 `acceptance.txt` → Read 读回 → completed → 父 inbox 通知，**16,202 ms**。文件字节精确为 `background-agent-verified\n`。
- 真实验收脚本：`scripts/probe_background_agent.py`。本机报告：`data/runtime/background-acceptance-be78c092c8/acceptance.json`；首次失败：`data/runtime/background-real-provider.log`；成功：`data/runtime/background-real-provider-fixed.log`。报告只记录隔离验收目录的任务数据，不含模型凭据。

真实验收不是 fixture，但仅覆盖该配置和上述小任务；进程退出、错误审批与停止由独立进程 fixture 补充。没有在本批执行跨小时压力验收、真实 Claude Messages 账户验收、原生 Office/Figma 或安装版验收。官方完整功能等价不能由这些结果推导。

## 全量验证

最终 fresh 全量：Python **2575 passed / 6 条既有 Pillow 提示 / 285.18s**；Node **279 test files passed**；ESLint、全部 TypeScript 项目检查、Figma bundle／Electron／脚本构建全部通过。日志分别为 `data/runtime/claude-background-python-verified.log`、`claude-background-node-verified.log`、`claude-background-lint-verified.log`、`claude-background-typecheck-verified.log`。首次 Node 全量发现两个旧测试桩遗漏新增的 `childActive`／`refreshBackgroundAgentTasks` 依赖；补齐真实依赖后保留原断言。
