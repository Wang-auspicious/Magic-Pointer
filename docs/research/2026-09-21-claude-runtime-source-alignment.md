# Claude 本地源码与 MP Runtime 行为对照

本轮以 `C:/Users/zjz65/PycharmProjects/claude-code-main` 的实际文件为依据。该目录 README 自述为 2026-03-31 暴露源码的非官方快照，没有可用的 package 版本和许可证授权。因此这里记录的是这个快照的行为，不宣称等同于当前官方 Claude Code，也不复制其实现。MP 继续使用自己的 Python Runtime、事件会话、工具调度、权限及 Electron 交互。

交付约束：直接在 main 工作，保持 1.0.50，不 sync、不安装、不发布。用户参考图片不进入提交。代码按实质批次验证并推送。

## 已阅读的行为入口与结论

参考路径均相对于上述源码目录；MP 路径相对于本仓库。行号随开发变化，以符号为定位依据。

| 参考入口 | 实际行为 | MP 对应与本轮处理 |
| --- | --- | --- |
| `src/utils/effort.ts`；`src/services/api/claude.ts` 的 `configureEffortParams` | 模型原生 effort；Opus/Sonnet 4.6 有能力区别，非支持模型不能假称原生支持 | `effort.py`、`model_client.py`：Messages 的 Claude 4.6 发 adaptive thinking 与 output_config.effort；Sonnet max、Extra 映射 high。其他 Messages 保持提示词档位，Responses/chat 保持各自协议。thinking/signature 与 redacted_thinking 持久化并在工具回合后回传；跨协议不混入错误 block。 |
| `src/tools/AgentTool/runAgent.ts` 的子任务配置与 `resumeAgent.ts` 的恢复 | 独立历史、父配置继承、显式覆盖；恢复使用子任务信息 | `subagent.py`：修复每个子任务固定 high，改成继承父 effort／显式覆盖／恢复已存 effort；再次恢复保留上次显式覆盖，省略 readonly 继承初始只读约束；Plan 父任务强制子任务只读。继承父会话及当前派发的持久权限规则，不继承父调用的 once 批准。已有独立 session、进度、Stop、历史与压缩继续保留。 |
| `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`；`ExitPlanModeTool/ExitPlanModeV2Tool.ts` | Plan 是实际只读执行边界；退出提交完整计划并由用户批准；子任务不能改变父模式 | 新增 `plan_mode.py`，注册 EnterPlanMode/ExitPlanMode，模式写入会话事件；每次工具派发读取当前模式，阻断同批 Enter 后的写操作。批准可选择手动权限或接受编辑；拒绝保持 Plan。计划正文使用 MP 事件会话保存，不照搬 Claude 的计划文件机制。 |
| `src/tools/TodoWriteTool/TodoWriteTool.ts` | Todo 是按 agent/session 分开的进度清单；更新无需执行授权；完成提醒独立于权限 | MP 已有 durable Todo 与右侧进度投影。本轮明确系统指令与审批文案：Todo 不批准执行；Plan 预设不再错误映射 DEFAULT。MP 保留 completed/blocked/cancelled 历史，属于有意保留的产品行为。 |
| `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` | 1–4 题、2–4 选项、描述、多选、唯一题目／选项，工具调用与回答绑定 | MP 具备规范化、多题导航、自由输入、请求 ID、重复提交门、接受后恢复和失败重试；Plan 卡复用同一持久回答通道。第二批补齐 option preview 的工具、store、Stage 与共享渲染；实际 Chromium 验证按钮、模式恢复和文本预览。 |
| `src/hooks/toolPermission/handlers/interactiveHandler.ts` | 每个工具调用自己的确认／拒绝／中止生命周期；批准返回实际 updatedInput | `loop.py`／`session.py`：有持久会话的本地写操作直接进入 Harness 审批队列，保存原调用及完整参数；回答原 requestId，批准后先恢复准确动作再请求模型。修改后的 hook 输入仍需重新批准；操作账本阻止重复恢复。新用户指令取消尚未开始的旧批准／排队动作。外部发送、破坏和购买保留 MP 自身 action proposal／lease 边界。 |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx`；`src/tools/AgentTool/AgentTool.tsx` 的后台分支 | 前台／后台任务具有真实不同的生命周期；后台可独立于父调用继续执行，有状态、输出和通知 | 第二批实现独立进程 `run_in_background`、持久状态／输出／父 inbox 通知、后台恢复；跨进程测试验证父 bridge 退出后继续，真实配置模型通过审批、写入、读回与完成。前台子任务遇到审批转入独立等待。 |
| `src/tools/TaskStopTool/TaskStopTool.ts`；`TaskOutputTool/TaskOutputTool.tsx` | 独立停止指定任务；等待／立即读取任务状态与输出。此快照已将 TaskOutput 标为 deprecated，建议读取输出文件与完成通知 | MP 的 AgentStatus 查询子任务状态和输出，AgentStop／父界面 Stop 停止指定子任务，等待审批也可停止；完整输出文件可由 Read 读取，完成结果进入原父 inbox。没有为名称对齐复制 deprecated TaskOutput API。 |
| `src/utils/messageQueueManager.ts` | 用户输入、通知、孤立审批入同一队列；优先级 now/next/later，同级 FIFO，可按 agent 过滤 | MP 有 durable next-step/followup、停止和恢复；需继续检查后台通知及审批队列与当前模型回合的衔接。 |
| `src/services/compact/autoCompact.ts` | 按有效上下文预留摘要输出、提前压缩、失败熔断，不只按消息数 | MP 已有 token 估算 + provider usage 校准、压缩收益判断、保留持久 Todo、失败／输出截断恢复。不是照搬固定 13k buffer；以多 provider 的实际窗口和既有 Runtime 规则为准。 |

## 第一批测试证据

- 先红后绿：Plan 预设错误、缺少 Enter/Exit 工具、同批模式切换后仍写、Plan 正文丢失、过期 composer 覆盖批准后的模式；由 `tests/plan_mode_workflow_test.py` 覆盖。
- 先红后绿：子任务不接受继承 effort；由 `tests/subagent_progress_test.py` 覆盖。
- 先红后绿：Claude Messages 未发原生 effort、thinking 签名未保存／回传；由 `tests/agent_runtime_effort_test.py` 覆盖。
- `scripts/probe_studio_decisions.cjs` 在实际 Chromium 内点击 Plan 卡，断言原 requestId、批准后清卡、恢复模式与 effort；同时保留审批、多题问答、草稿附件、Todo 恢复的原有检查。测试脚本的模板字符串换行转义错误已修复，实际检查通过。
- `tests/runtime_permission_queue_test.py` 先复现：没有直接审批、没有队列、准确一次批准被 shell 前缀规则误拦、用户新指令后仍执行旧批准动作。修复后断言准确原参数先于下次模型请求执行、恢复后不重复执行、队列保留下一项、新指令取消旧动作；`permission_decisions_test.py` 保留拒绝与不同效果等级的检查。
- 权限卡新增完整动作预览，先由实际 Chromium 复现“只显示 npm test 前缀，隐藏 && npm run build”，再验证修复。
- 传输／持久化层单独验证：`conversation_store_test.js` 先复现重开后 mode/effort 丢失；`stage_contract_test.js` 先复现 Stage 丢失 requestId、多题及描述。两项修复避免仅用 renderer fixture 就声称整条链路已通。
- `subagent_permission_inheritance_test.py` 先复现父会话规则完全没有传给子任务，再验证会话允许、拒绝、once 不继承，以及真实 Runtime 派发上下文的传递与清理。
- 组合回归另外覆盖 Messages thinking 与审批恢复：先复现恢复动作丢失原始 thinking block，再让审批恢复从原 assistant 事件中读取并保留该签名数据。Responses 的 reasoning item 不复制到这条 Messages 协议路径。
- 全量首轮暴露旧 bridge 测试桩缺少新会话方法／request header 类型，以及旧 Plan 错误文案断言。补齐测试桩契约、保留明确拒绝提示；不是删除失败断言。定向 Runtime、权限、Plan、bridge 合计 187 项通过，子任务与审批新增集 10 项通过。
- 最终 fresh 全量：Python **2565 passed / 6 条既有 Pillow 提示 / 259.80s**（`data/runtime/claude-runtime-python-final.log`）；Node **278 test files passed**；ESLint、全部 TypeScript 项目检查、Figma/Electron/脚本构建均通过。UI 使用实际 Chromium 与本地确定性响应；协议测试使用响应 fixture，均不替代真实云模型、原生 Office/Figma 或安装版验收。

## 第二批对上述差距的处理

1. `Agent(run_in_background=true)` 现在启动独立 Python Runtime 进程，父 bridge 结束后继续执行；状态、完整子会话、输出文件、完成 inbox 通知、AgentStatus／AgentStop 与恢复入口已实现。恢复后台任务默认保持独立生命周期，显式 false 才转为前台。
2. 子任务新遇到的审批现在可在父界面的任务卡直接回答，传输绑定父 session、子 session 和原 requestId。前台子任务遇到审批时转入独立等待；已批准动作沿用原操作账本恢复，不发送新父回合。子会话内的持久 grant 在恢复后继续生效，once 不扩大。
3. AskUser 的 option preview 已穿过 Python 工具／规范化、Studio store、Stage 传输及共享 DecisionCard，以保留缩进的纯文本显示；实际 Chromium 检查其不执行 HTML。
4. 真实模型验收发现并修复 Chat Completions `reasoning_content` 被丢弃的问题，覆盖流式、非流式及审批续接。真实配置的 `deepseek-v4.1-flash` 完成写入审批、文件读回与通知，记录见 `docs/research/2026-09-21-claude-background-agent-delivery.md`。
5. 对照中的 Queue、compaction、Artifact 继续采用 MP 的既有契约。上述结论针对已读取快照中的具体行为；不将一次真实模型验收表述为当前官方 Claude 全功能、所有模型或原生 Office/Figma 的完整兼容证明。
