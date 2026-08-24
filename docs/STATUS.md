# 当前状态

> 最后核实：2026-08-24（Studio GUI 三批 + 路线图对账，开发树未升版本）。

2026-08-24 Studio GUI 对标批（对照 `D:\Desktop\Persistence\harness` 五源码拆解文档逐项找差距，开发树，未升版本未 sync）：**①流式正文/停止/插话三件套（DSH P0 全落）**——`answer_chunk` 增量经 `PhaseClock.mark_blob` 以 base64 上 stderr 进度行（120ms 节流 + turn/tool 边界强制冲刷），Studio 边收边画光标闪烁、完成后 markdown 正式重绘；`session_ready` 广播 durable session id，发送钮忙态变停止钮（优雅取消 Receipt + 5s 兑底 kill）；忙态 Enter 写 durable inbox(next-step) 立即显示排队气泡。**顺带修真 bug**：todo_write 的 plan 推送走 `_token` 120 字符截断，多步计划 JSON 必被剪断、decodePlanToken 静默失败、计划卡消失——改走 mark_blob。新纯逻辑层 `electron/conversation_control.ts` 双端共用（sessionId 形状校验）。红绿：`conversation_stream_progress_test.py` 6 项 + `conversation_control_test.ts`。**②渲染三处硬伤**——fenced code 升级 DSH CodeBlock 卡（语言标签+复制钮+原字面体，复制载荷引号转义钉死）；edit_file/write_file 工具行渲染红删绿加 diff 卡（40 行封顶带省略计数，不做 LCS——old/new 本身就是完整两列）；进度记录按 key 增量渲染签名未变不重建（用户展开的工具行不再被下一条进度拍回折叠态）；贴底才跟随（48px 阈值）+ 回到底部胶囊；运行中耗时 15 秒后显示。红绿：`studio_markdown_render_test.js` + `studio_dsh_chat_contract_test.js` 扩充。**③会话重命名/删除**——store `rename/remove`（空白拒绝、titleCustom 防自动标题覆盖、未知 id 诚实失败），IPC 全链，侧栏省略号从死按钮变成 DSH Rows 动作菜单（重命名/删除对话危险项红色）+ 内联重命名对话框（Electron 无 window.prompt）。红绿：`conversation_store_lifecycle_test.ts`。**④斜杠目录内联触发+键盘导航**——`electron/slash_trigger.ts::detectSlashToken` 纯函数（路径样文本不误触），textarea 内联开合目录随输入过滤不抢焦点，方向键循环高亮 + Enter/Tab 选中 + Escape 关闭。红绿：`slash_trigger_test.ts`。验证：Python **1503 passed**；Node **157 passed / 110 源文件**；五套 typecheck 与 eslint 0 干净。**路线图对账结论（防重做）**：§1.6 capability deferred 已在早前批次落地（两个 spec 工厂均 `deferred=True`，路线图过时）；§5.1 derive_messages O(n) 已被 `_adopt_incremental` 内存投影解决；§7.3 图像 token 前提不成立（look 返回文本描述，图像从不进模型表面）；§8.2 排序无失败可达（deferred 后 direct 列表远低于 64 上限）。诚实边界：DSH 报告中的 KaTeX 数学渲染（需新增 katex 依赖）、消息分支 fork GUI、粘贴/拖拽图片进会话作曲家、每会话 pending-work 徽章仍未做。

2026-08-23 权限与回滚批（1.0.17）：继续按 roadmap 对照 Codex/CC 源码逐条处置剩余项。**①线程级权限授权（B2-6，CC toolPermissionDecision + Codex thread scope）**：新增 `permission_decisions.py`（不可变 allow/deny memo）；loop 在模式表之后查 memo——显式 deny 压过 mode-allow、allow 只把 LOCAL_IRREVERSIBLE 的 ASK 升为 ALLOW（外发/破坏/购买永不快授，不变量④⑤⑥）；`ask_user_question` 新增 kind/tool 结构化字段透传到 pendingInput；Studio 作曲家上方渲染三选项授权条（仅这一次/本会话总是允许/拒绝），点击随下一条消息结构化生效；会话记录持久 grants/denials（去重），preload/main/data 全链透传。红绿：`tests/permission_decisions_test.py` 6 项 + 桥 2 项 + store 节点测试。**②危险类 ASK 反馈分叉（B2-7 残留真义）**：grantable 效果才提快授通道，危险效果只引导计划提案（Hermes "send email 永 present_plan" 契约）+ permissionMode 写入 interaction_metadata 审计可回溯。**③todo 回注补 T3 围栏**：`format_for_injection` 原先裸注入（历史指令性文本被抄进 todo 后可经压缩回注复活），改用 resume_context 同款围栏 + 条件续接声明，可执行性保留。红绿：`agent_runtime_todo_store_test` 新增围栏钉死项。**④INVARIANT_FAILED 细分（§12.3/B4-20）**：Terminal 新增 `failure_kind`（runaway_rounds/output_truncation），文案带下一步建议。**⑤/rewind 斜杠命令（B5-25）**：checkpoint 落盘本就跨进程持久，接上用户入口——默认回滚最近一次改动，/rewind N 回滚 N 步；命令目录同步。**对照源码后明确跳过的 roadmap 项（防反复追问）**：B4-17 模型切换重压（MP 摘要是模型中立文本且预算已按模型自适应，阈值每轮兜底降档溢出，字面移植需跨请求持久化「上次压缩模型」属无失败可达的脚手架）；§3.4 摘要 JSON 强制（当前 codex `SUMMARIZATION_PROMPT` 就是纯结构散文提示，无 JSON 校验，roadmap 前提过时）；§3.5 双轨压单轨（or 双轨是 8·21 真机教训：估算器 CJK 低估 48k vs 真实 86k，晚压=窗口拒绝）；B4-18 latency 拆分（latency_ms 本就 handler 内计时，排队时间从未计入，「偏高」声称不成立）；B2-8 BYPASS 审计模块（effect sandwich 已在 session JSONL 持久化全量 arguments+effect+settlement，强于提议的哈希账本）；B3-15 save_skill 审批门（杀死已验证的自进化产品裁决，REVERSIBLE_WRITE 已过权限门）；B3-10 edit_file 白空容错（Python read_text 通用换行已归一 CRLF，行为等价 CC，补回归钉）；B7-33 MCP deferred（mcp_search 惰性发现即更强 deferred）；§8.4 currentMode 刷新（present_plan 审批门已被 a9a1c6c 产品裁决删除重做，前提不复存在）。验证：Python **1497 passed**；Node **154 passed / 108 源文件**；五套 typecheck 与 eslint 0 干净；headless 渲染链探针 0 console 错误。交付：sync 安装版核对 **1.0.17**。

2026-08-23 工作区批（1.0.16）：对照 Codex 源码 `codex_thread.rs` 的 thread `workspace_roots` 语义（线程绑定、请求不匹配即拒绝、profile 默认只由显式命令写），修掉 MP 抄歪的三处。**①芯片选择不再污染全局**：`conversation_bridge.py` 原来每次显式选工作区都 `write_workspace` 回写全局默认（这个会话的选择泄漏进所有其他会话）——改为只对本请求生效；全局默认只由 `/cwd` 斜杠命令写。**②线程保持自己的工作区**：`conversation_store.ts` 会话新增 `workspaceRoot` 字段；`main.ts` 发送时 `explicit || existing.workspaceRoot || ''`——追问自动沿用本会话的 root，换会话互不干扰。**③Stage 不再绑进程 cwd**：`selection_bridge.py::_loop_router` 原硬编码 `Path.cwd()`（安装版=安装目录，手势跑 `ls` 列出的是 MP 自己的文件），改绑持久化 profile 默认工作区。**④侧栏按真实工作区分组**：`sidebar_groups.ts::groupByWorkspace` 按 `workspaceRoot` 聚类渲染（原先按屏幕伪造「应用名」分组）；新对话重置芯片、"+" 按钮加可见 pulse 反馈。红绿：`test_explicit_workspace_pick_is_thread_scoped_not_global`/`test_missing_explicit_workspace_falls_back_to_profile_default`/`test_loop_router_binds_profile_default_workspace_not_process_cwd`/store+sidebar 各自先红后绿；headless 点击探针（`scripts/probe_studio_click.ts`/`probe_studio_flow.ts`）验证打包渲染器链路无死按钮。验证：Python **1483 passed**；Node **154 passed / 108 源文件**；五套 typecheck 与 eslint 0 干净。交付：sync 安装版核对 **1.0.16**。

2026-08-23 续批（1.0.15）：在 1.0.14 之上追加两项 roadmap 高置信项。**§3.2 tail-prune 改 token 口径**：`memory.py::_prune_stale_tool_outputs` 原先 `_TAIL_PRUNE_THRESHOLD_CHARS=24000` 按裸字符数判断——CJK 1 字/token、英文约 4 chars/token，同一阈值对两种语言的 token 负担完全失衡（24k 字符英文 ≈ 6k token 早该压、24k 字符中文 = 24k token 却压晚了）。改为单一 `_TAIL_PRUNE_THRESHOLD_TOKENS=4000` 判据（估算器已含 CJK 修正，中英文共用同一个门），丢掉字符数双轨。红绿：`tests/tail_prune_token_test.py` 3 项（轻英文不压、CJK 超 4k 压、阈值常量钉死）。**§12.2 PROVIDER_UNAVAILABLE 带重试倒计时**：`model_health.GatewayHealth.message` 在 `circuit_open` 时追加「约 N 秒后可重试」（N=open_until-now，取自真实 cooldown，健康端点不会凭空造 deadline）。这条 message 是所有消费者的单一事实源——loop 的 PROVIDER_UNAVAILABLE、ai_client 的「AI 调用失败」、设置页健康卡都会带上可见的重试地平线，不再一句「稍后自动重试」没有边际。红绿：`tests/model_health_endpoint_test.py::test_open_circuit_message_carries_retry_horizon`。验证：Python **1480 passed**；Node **154 passed / 106 源文件**；五套 typecheck 与 eslint 0 干净。


2026-08-23 1.0.14 交付批：**①首句卡死真 bug（用户实测）**：Cursor agent 给 `LoopParams`/`conversation_bridge` 加了 `keepalive` 心跳与 `todo_store` partial-delivery，但没给 `app/fabric/engine.py::run_agent_turn` 加上对应转发参数——生产第一句消息必炸 `TypeError: run_agent_turn() got an unexpected keyword argument 'keepalive'`（electron.log 实证 `Agent 运行失败：TypeError`，543ms 内失败）。修法：`run_agent_turn` 新增 `keepalive`/`todo_store` 转发到 `LoopParams`；selection_bridge（Stage 路径）也补上同样两个参数（原先只有 conversation 有），Stage 长任务不再被 60s idle 静默杀死。红绿：`test_run_agent_turn_forwards_keepalive_to_the_loop` + `test_run_agent_turn_forwards_todo_store_for_partial_delivery` 先红后绿；真机桥呼 `ok=true` 11s 出答案。**② reply-style 语量控制（caveman 嵌入为自选按钮）**：本地 caveman skill（极简/简洁/正常/干脆/文言五档）接入产品——`system_prompt.py` 新增 `Style` section（normal 零开销，其余注入精简/极简/文言指令，技术细节不丢的底线写死）；Studio 作曲家新增 `composer-style` 芯片（五档自选，弹层同 DSH 权限选择器）；`replyStyle` 走 renderer→preload→main→双桥→runtime→context 全链（conversation + selection 两路都通）。红绿：3 项 section 测试 + 真机桥验证 ultra 档注入生效。**③ apply_patch 多段**（roadmap §1.7，Codex 契约）：schema 改 `oneOf: string | array<string>`，执行端逐段 parse/apply，checkpoint 逐段记录；单段行为零变化。红绿：`tests/apply_patch_multi_test.py` 2 项（schema + 双文件双段实测）。**④ ToolSpec.examples**（roadmap §1.1/§1.2，Graft/CC prompt_sample）：`ToolSpec` 新增 `examples`，`schemas_for_model` 透传；`search()` 把 examples 纳入 haystack（关键词只出现在示例里也能 find_capability 找到）；apply_patch 挂上真实示例避免首轮猜参数形状。红绿：3 项 registry 测试。**⑤ 顺手修 pre-existing 红灯**：a9a1c6c 把 `dsh_web.css` 存成 CRLF 弄挂了 `studio_dsh_source_parity_test.js`（断言按 LF 字面检查）——改 newline 无关化；`permission_presets_render_test.js` 钉的旧档位表没跟上 plan 档——改按 Python 真值表；`studio.ts` 一处 `/[\/]/` 多余转义 lint 红。修复后 Node **154/154**、lint 0 警告。验证：Python **1475 passed**；Node **154 passed / 106 源文件**；五套 typecheck 干净；真机桥呼（conversation，compact 档）ok=true。交付：`npm run sync` 构建 `Magic-Pointer-1.0.14-x64.exe` 静默安装重启，安装目录版本核对为 **1.0.14**。诚实边界：Stage 的 replyStyle 芯片未做（Stage 提交默认 normal）；四个参考仓库（Graft/agency-agents/codebase-memory-mcp/agent-reach）中 Graft 的持久化 repo graph 与 codebase-memory 的 tree-sitter 图不搬（MP 已有 grep/glob/read_file/search_history，重图属 HERO 范围外重型脚手架）；agency-agents 的子代理并行不搬（写同一 workspace 冲突是 MP 构造性拒绝的，非凭运气）；这两个决定记录在案供后续复议。

2026-08-23 harness base-fidelity 第一批（开发树，未升版本）：按 `docs/research/2026-08-23-harness-base-fidelity-roadmap.md` §13 B1 顺序执行。**B1.1 `run_command` 加 effect_for**：tool registry 早就支持 `spec_effect(spec, args)`,`ToolSpec.effect_for` 也已就位（`tool_registry.py:116-129`），只缺 `coding_tools.run_command` 没挂——所有 shell 调用都被固定 `Effect.LOCAL_IRREVERSIBLE`,让 `ls`/`pwd`/`cat` 在 workspace-write 模式也被 ask 门拦下,与 Codex sandboxMode=readOnly / CC Bash readonly 不一致。新增 `_classify_command_effect`：命令首 token 落在 `_READ_ONLY_COMMANDS`（ls/dir/pwd/cat/type/head/tail/wc/find/tree/echo/date/whoami/hostname/env/get-childitem/get-location/get-content/get-date/get-item/test-path/select-object/where-object/printenv/set）且不含 `|;&`/backtick/`$(` 链式操作符时返回 `READ`；其余回落 `LOCAL_IRREVERSIBLE`（默认闭,误分类只多一道确认而不是误放行）。红绿：`tests/coding_tools_test.py::test_run_command_classifies_pure_read_commands_as_read` 14/14 绿。**B1.3 loop 给 IPC 桥接加 keepalive 心跳**：批盘点已指出"长任务现在不是跑不住,是跑不了",但 Stage 60s / Studio 120s 已被上一批改为 idle 沉默计时,关键漏洞是 `run_agent_turn` 内部模型调用+单条 `run_command` 中途**完全沉默**,60s 后 Electron 仍然杀 Python 子进程（`electron/python_bridge_runner.ts:143-150` 的 `armIdleDeadline` 严格按 chunk 计时）。修法:`LoopParams` 新增 `keepalive: Callable[[str], None] | None`,loop 在 `TurnStarted` 与 `ToolCallFinished` 边界各打一次心跳,失败吞掉（心跳破不得 abort 工具调用）;`scripts/conversation_bridge.py` 把 `conversation_clock.mark` 作为心跳回调注入,输出形如 `@@mp phase=agent_turn_turn=1 ms=... d=... scope=conversation`,正好命中 Electron `bridge_progress_lines` splitter 的正则,沉默被重置。红绿：`tests/agent_runtime_loop_test.py::test_keepalive_fires_at_turn_and_tool_boundaries` + `test_keepalive_swallows_callback_exceptions` 2/2 绿,全 loop 76/76 + coding_tools 14/14 = 90/90 绿。**B1.4 tool 边界也检查 interrupt**：上一刀只补心跳没补取消响应——`interrupt_check` 仍只在 model call 前后生效,长 `run_command` 中途按取消按钮必须等 timeout 才停。修法:`_execute_one` 在进入 timeout/cancellation scope 之前先调一次 `params.interrupt_check`,命中返回 cancelled ToolResult（不 raise,避免 scheduler 把整 batch 误当成系统 cancel 重新抛出）;下一次 turn start 时 line 813 的现有 interrupt check 命中并转 `USER_INTERRUPT`。红绿：`test_interrupt_check_terminates_before_long_running_tool_starts` + 重写后的 `test_interrupt_check_stops_before_model_call` 绿,全 loop 77/77 + coding_tools 14/14 = 91/91 绿。**B1.5 顺手修：compaction 也算 productive**：原 budget 续期只看 `turn_number - 1 == last_progress_turn`,但 compaction 占一个 turn 不调工具,`last_progress` 留在上轮 → 下次预算检查非 productive → 长任务在压过一次上下文后必然被 BUDGET_EXHAUSTED 截掉（review T1 旁路）。修法:proactive compaction 成功路径上 `last_progress_turn = turn_number`（`app/agent_runtime/loop.py:805`）。红绿：`test_compaction_keeps_budget_renewable_on_followup_round` 绿,全 loop 78/78 + 跨 13 个模块 = 338/338 绿。诚实边界：`python_bridge_runner` 的 60s idle 仍是 Python 子进程外壳上的最后一道闸（心跳只是把它推到几小时量级,没有真正撤销）,后续批可换成按 turn 数量续期或长时任务独立 subprocess;`run_agent_turn` 内部的工具级同步阻塞（无 async 化）让 interrupt 仍要等当前 syscall 返回;B2/B3-B7 整张 §13 路线图尚未启动。



2026-08-21 编码工具批（1.0.13 已交付；同日第二轮已提交待 sync）：交接文档 §5 的 ①②③ 全部完成。①coding-tools/delegate-tool 行接线进 builtin_bundle（无 workspace_root 时诚实缺席），`/cwd` 命令持久化工作区，双桥传 workspace_root+permission_mode；②E2E 真实修复：生产链路 + mimo-v2.5 用 78s/17 工具调用把含 3 个种子 bug 的实验室包修到 4/4 全绿；③Hermes 对照：同仓库同 prompt 同模型 Hermes 71s/18 调用，首战同档（`docs/research/2026-08-21-coding-tools-e2e-and-hermes-baseline.md`）。第二轮（真机驱动）：apply_patch（Codex 契约）、checkpoint 回滚、delegate_task 子代理真机验证（139s 委派统计任务完成并交叉验收）、plan mode 产品闭环真机验证（present_plan→选项按钮→批准后自动转写入权限执行，7/7 绿）、web_search/web_fetch（DDG keyless）、save_skill 自进化闭环、search_history 跨会话记忆、后台命令+read_background、模型档案自适应压缩预算、压缩撞窗重试、尾部陈旧工具输出修剪。真机抓出并修掉的真 bug：tool_limit=30 按注册序截断把 delegate_task 挤出模型视野（30→64）；_completed_result 丢 awaitingUserInput/pendingInput 字段；background meta 丢 pid 状态永远 FINISHED；pywin32 scripts 目录毒化 namespace package 缓存致桥直跑必炸；apply_patch delete 文件不进 checkpoint。验证：Python **1457 passed**；Node **154 passed / 106 源文件**；五套 typecheck 干净。

> **产品边界（2026-08-19 用户裁决，优先于本文一切旧表述）：** Magic Pointer 是顶级 Agent Harness 本身，**短任务和长任务都自己做，任务时长不是边界**。把 prompt 写进 Claude Code/Codex 输入框只是一条投递通道，与写进微信输入框同级，不是移交执行权，也不是任务难度分级器。目标是最综合、最集成各方优点的 harness。凡文档写着"短任务 Harness / 长任务交给外部 Agent"的一律作废。

2026-08-19 Codex 逐行学习 + 全链修复批（1.0.12 已交付）：clone `openai/codex`（HEAD `2151d3a`）逐文件读 `codex-rs/core`（turn 循环/压缩/并行工具/输入队列/rollout 持久化/goal 系统），对照 MP 同名子系统逐条裁决，学习与审计全文在 `docs/research/2026-08-19-codex-harness-study-and-audit.md`。本批修复（全部同权重，每批独立 fresh 验证并单独提交）：①完成上一批悬空的 9 个 TDD 契约——look/read_around 等冻结证据与描述标注 historical/frozen（P1）、系统提示「冻结帧不得据此点击」、get_app_state 轮询只 warn 不 halt（S5）、index 类动作前重探元素树 role/name/rect 变化即 stale_snapshot（P4）、压缩摘要源去重（C3/Hermes prune）；②压缩摘要升级为 Codex 五段结构化交接（进度/关键决定/约束/剩余步骤/关键数据）+ 摘要源 12k→48k，双桥单源；③session append 从每 append 全量重读重验（O(n²)）改为 stat 前缀 + 增量采用（对照 Codex rollout）；④跨进程优雅取消（O3）：cancel/request+consumed 持久事件、bridge action=cancel、双桥 interrupt_check、GUI 停止先优雅后 kill 兑底；⑤运行中插话（O1/O2）：stage 处理中提交走 stage:steer-selection-command 写 durable inbox，loop 下轮携带；⑥真实步数上卡（O5）：「第 N 轮」+ 工具名，不再共用 TYPICAL_PHASES=7 假估计；⑦has_pending_work() 从 turn/end reason 派生 + bridge status（D2）；⑧look 每 run 12 次配额（P5）；⑨steer_absorbed/context_compacted 等进度阶段（O7）；⑩账单过契约层（O6）；⑪取消/超时文案不再谎称「没有改动任何东西」（O4）。fresh 验证：Python **1426 passed**；Node **154 passed / 106 源文件**；五套 typecheck 与 ESLint 干净。交付：`npm run sync` 构建 `Magic-Pointer-1.0.12-x64.exe`、静默安装并重启，安装目录版本核对为 **1.0.12**。诚实边界：steer/取消的 GUI 链路未经真机长任务实测；压缩中撞墙的删最老重试、agent 间 mailbox、session 轮转压缩、目标 token 余量提醒记录在审计文档 §3 暂不做；300 步真机基准仍未跑。

2026-08-19 产品边界纠正（开发树，未升版本）：根因是 8·17 已裁决"完整自有 Agent"，却只写进了进度账本与 research 文档，没同步 `AGENTS.md` 和设计文档 §1 产品定位——而那才是每个新会话的必读入口，于是"短任务"边界持续自我复制。本批把事实源改对（设计文档 §1.1/§1.2/§4.8/§9/§10.2/§16.1/§17、`AGENTS.md`、`AGENT.md`、两份 HANDOFF、RECONSTRUCTION_PROGRESS、本文），并给被推翻的两份 research 文档加作废横幅。同时修掉唯一一处真行为 bug：`app/agent_runtime/system_prompt.py` rules 第 1 条"证据已经足够时立即回答并结束"会让模型在多步长作业中途收工，改为区分回答类（够了就交付）与多步交付类（做完全部步骤，"看够了是可以停止翻找，不是可以停止干活"）。先观察测试失败再实现，fresh 全量 Python **1384 passed**。**未升版本、未 sync**（延续本开放批次的用户指示）。诚实边界：loop 的 rolling budget 本就支持长跑（productive 轮无条件续期），但外壳没跟上。

2026-08-19 长任务地基第一批（开发树，未升版本）：按"别造轮子、直接搬"从本地 HermesAgent（MIT）移植，出处登记在 `THIRD_PARTY_NOTICES.md`。**硬天花板全解除**：①bridge 超时从 wall-clock 改为**无活动超时**（`electron/python_bridge_runner.ts`，每块 stdout/stderr 重新计时，只有沉默才算挂；60s/120s 值不变但语义反转），Hermes 的 `gateway/run.py:20211-20303` 就是这么区分"长跑"与"卡死"的；②`emergency_turn_fuse` 90→1000（90 低于 OSWorld 2.0 均值 318 步，正常长任务撞上会被报成 `INVARIANT_FAILED` 内部错误）。**上下文层**：③`app/agent_runtime/token_estimate.py`（移植 Hermes 三桶估算）——原 `len//2` 只数消息，完全漏掉 system prompt（记忆 4000+技能 12000 字符）和 tool schema，压缩阈值因此系统性偏晚；④压缩去掉一次性锁改为可反复触发 + 连续 2 次无效则停试（移植 anti-thrash）；⑤`app/agent_runtime/todo_store.py`（移植 Hermes `TodoStore`）接上一直空置的 `todo_write` sink，压缩后把未完成步骤原样贴回——进度不再依赖摘要模型记得住；⑥压缩尾部改由 token 预算决定而非写死 4 条（移植 `_find_tail_cut_by_tokens`）；⑦修掉一个真 bug：压缩成功与否原本用**条数**判定，任何携带状态的回贴都会让整次压缩被丢弃，改判 token 权重。fresh 验证：Python **1401 passed**；Node **152 passed / 105 源文件**；五套 typecheck 与 lint 干净。**未升版本、未 sync。** 仍未做：工具结果 prune/去重、感知的冻结与实时语义隔离、崩溃重放、steer 的 Electron 侧、子任务。

2026-08-19 长任务能力差距盘点（`docs/2026-08-19-LONG_RUN_CAPABILITY_GAP.md`，四路并发只读审计，全部结论带文件:行号）：**长任务现在不是"跑不住"，是"跑不了"**——Stage 60s / Studio 120s 硬超时杀 Python 子进程（`electron/main.ts:3933-3934`、`1187`），`run_agent_turn` 90 轮熔断（`app/fabric/engine.py:983-984`），两道闸在任何长跑能力被用到之前就落下。对照 OSWorld 2.0 的量纲（中位 1.6 小时、平均 318 次工具调用），当前上限是 ≤2 分钟、≤90 轮。其余四层缺口：上下文（compaction 每 loop 只压一次、摘要丢进度事实无保护、工具结果全历史重放、token 用 chars//2 粗估）、感知（冻结帧的 look/read_around 与 live 的 get_app_state 语义混用、InputArtifact revision 硬编码为 1 不可中途再编译、snapshot 只绑窗口几何不绑元素语义）、持久性（无 program counter 续跑、effect sandwich 未上生产盘——本机 276 个真实 session 全是旧格式 tool/call、session JSONL 无轮转且每 append 全量 reload）、可控性（steer 内核通但生产链断且 processing 时输入被挡、取消=kill 进程无 partial 账本、运行中看不到真实步数、ledger/Receipt 无 UI）。建议批次 A→E 顺序见该文档 §7。未真机跑过 300 步任务，结论来自代码路径推演。

2026-08-19 Gate 2 聪明感收口（开发树，未升版本）：短任务不再瞎猜、一点就停、看不见像素还敢写。①Stage 在 `awaiting` 且 `pendingInput.options` ≥2 时画与闲置芯片同族的选项钮，点选把选项原文送进现有 `submitCommand` / 同 selection session 续跑；闲置罐头命令让路，不新 bridge。②`type_text` 确认改为 ValuePattern 读回（`read_value` / GetCurrentValue），匹配才 `verification.matched`，禁止再用 SetValue 冒充读回。③验证门：`click` 的 JSON matched 不能单独当作完成证明；写后再成功 `get_app_state` 才算观察过；`type_text`/`set_value` 自带 matched 仍可过门。④13 个桌面工具描述改成中文短任务手册；系统提示加上「证据够就停 / 不确定就 ask_user_question / 写后再观察 / 视觉已尝试则勿重复 look」。⑤fusion 未覆盖手势且有 `visual_anchor`、冻结帧和 vision backend 时，harness 同步 look 一次写入 InputArtifact `look_once` 再进 loop；失败保持八态，不改抓实时屏。这不是 Vision 每轮 fan-out；conversation 无冻结帧仍诚实 unsupported。⑥`max_tokens` 800→4096，不改 FULL_ANSWER 墙钟。fresh 验证：Python **1384 passed**；触及的 Node/stage 测试与 renderer/tests typecheck 通过。**未升版本、未 sync**。诚实边界：crash 从 program counter 中段续跑、DraftArtifact `written`、Vision 每轮 fan-out、ask-user Inbox 按 question id 绑定、真机记事本写回归仍未做。

2026-08-19 UIA 树接入 + Receipt 停止条件（开发树，未升版本）：上一刀 13 工具有契约、生产树是空的。本批把 ControlView COM 接到 `get_app_state` / `set_value` / `perform_secondary_action`，并把蓝图 Gate 2 的 Receipt 变成 loop 收尾的一等事件。①`app/desktop_actions/uia.py`：原始节点规范成 1-based index / role / name / rect / patterns，无名且无 pattern 的容器丢掉，预算 400；`UiaBridge` 可注入 walker/actor；生产 walker/actor 走 ctypes `CUIAutomation`（IID 按 Wine `uiautomationclient.idl`），hwnd 0 或 COM 失败返回空树 / `{ok:false}`，不假装 click。真机对前台窗口 ControlView 可走出树（Cursor Agents 实测 266 raw，规范化后按钮带 Invoke）。未改 C# 常驻宿主协议。②`default_session` 的 `_live_elements` / `_live_uia` 走这座桥，index 路径不再是空列表。③`app/receipts/`：`receipt/issued` 由 session 持久化、纯投影还原；loop 在每一次 `LoopStopped` 前发票。COMPLETED 且写过未验证 → `unverified`；写后 `verification.matched` 或 `verify_result` → `succeeded` + `write_verified`；纯回答成稿 → `succeeded` + `draft_generated`。工具 JSON `verification.matched=true` 算验证门证据（随后一批规定 `click` 除外）。诚实边界：未对记事本/Office 做端到端手势写回回归；COM 树是 ControlView 当场走，不是 named-pipe 宿主；Receipt 尚未进 GUI/ledger 可视化；crash 续跑、Vision 每轮 fan-out 仍未做。fresh 验证：Python **1369 passed**。**未升版本、未 sync**。

2026-08-18 桌面动作面（开发树，未升版本）：主 loop 第一次有模型可调的桌面 CU 工具，不再只能读不能点。对照 Kimi Windows 十三工具白名单、UFO²「原生语义优先」、Clicky 回合收尾、Everywhere JobObject 看门狗（自写 ctypes，不抄 BSL）。①`app/desktop_actions/`：`get_app_state` 发 `snapshot_id`，mutating 必须出示；窗口 hwnd/pid/bounds 变了就 `stale_snapshot`；index 与 x/y 混传拒绝；`InputOwnershipLock` 让真实输入互斥，busy 时 `list_apps` 等只读仍放行，`turn_ended` 释放。②UFO²：`set_value` / `perform_secondary_action` 先走注入的 UIA，失败诚实 unsupported，不假装 click 成功；`type_text` 聚焦后写入，UIA 读不回则 `verification.status=unavailable`。③`launch_app` 未知名失败且不打开 Explorer；`press_key` 拒绝 Win/Meta/Super。④builtin bundle 新增 `desktop-action-tools` row，系统提示第 7 条写清观察-动作绑定。⑤MCP stdio 与冻结帧 OCR worker 的 `Popen` 进入 kill-on-close JobObject，主进程死后 OS 收掉子进程。诚实边界（已被 2026-08-19 批次部分收口）：当时生产 `elements_probe` 仍空、`uia_act` 未接线；`type_text` 走 SendInput Unicode，`used_backend` 仍报 Kimi 契约名 `foreground_clipboard_paste`；未升版本、未 sync。fresh 验证：Python **1359 passed**（recipe cache 那条被本机 `pytest-of-zjz65` 目录拒绝访问挡住 setup，换独立 basetemp 后通过，与本批代码无关）。

2026-08-18 DraftArtifact revision（开发树，未升版本）：蓝图 Gate 2 / §6.4 的产物对象从「不存在」变成 session 投影。模型 COMPLETED 终稿写入 `artifact/generated`（revision 1 + contentHash），不再只活在聊天气泡里；用户/Agent 补丁走 `artifact/patched`；批准绑定当前 `(revision, contentHash)`，过期 hash 拒绝，批准后再改把 state 打回 edited。追问是新 artifactId，不是给旧稿打补丁。空文本不得成稿；ask_user 澄清不产生草稿；补丁事件不进模型表面。不另建第二套 store。诚实边界：written/submitted/verified 要等 ActionLease 真写回；GUI 尚未渲染草稿 diff；Receipt 停止条件与 crash 续跑原 loop 仍未做。

2026-08-18 感知 provider 协议与融合接缝（**开发树已实现并全量验证，未升版本、未 sync**）：蓝图 §13.1 的 `app/perception/providers.py` 与 `fusion.py` 从「标为第一批但不存在」变成真实实现，并**同批接入第二类 provider**（`app/perception/pixel_ocr.py` 的冻结帧 OCR），因此这层协议不是给单一实现立的抽象。①**provider 边界成形**：`ProviderDescriptor`（层/tier/优先级/自己的 deadline/是否需要冻结像素）+ `ProviderResult` + `PerceptionObservation` 取代 `adapter.read_context()` 的隐式约定；Explorer、SurfaceAdapter、手势结构化策略各自成为一个 provider，Explorer 命中不再短路掉其余来源，SurfaceAdapter 也不再覆写别人的 trace。②**融合独立且纯**：`fuse_observations` 是唯一裁决点（覆盖 mark > 非容器 > 非降级 > tier > 优先级 > 置信度），跨来源文字比对把数字当关键位（"120" vs "210" 是冲突而不是 70% 相似），复合 provider 内部的 attempts/冲突照原样并入外层 trace，被压过的结构化读取记为 note 而不是 conflict（否则每个纯像素应用都会弹确认）。③**像素 tier 进同一张表**：OCR 从「另一个进程里由 `structured_covers_mark` 布尔触发、命中后整体替换上下文」改成第二段 fuse——快照阶段的 observation 随 trace 过河并被复原，OCR 作为一个 observation 参与同一次排序；结构化读到了划中的那一行时像素 tier 根本不启动，被压过时容器名仍留在裁决里（`coversMark=false`/`coverageReason`/note 都在）。没有冻结帧就诚实记 `unsupported: frozen_pixels_unavailable`，绝不改抓实时屏幕。④**broker 按 provider 计时**：每个 provider 可以有自己的 deadline，tier 只等到最有耐心的那个为止，超时的记 timeout observation；对当前窗口不适用的 provider 记为 declined 而不是往证据里塞噪音。⑤**模型表面对齐真实来源**：来源徽标只列被选中的读取及与它一致的读取（被压过的容器名、判定冲突的另一路各自作为 note/conflict 出现，不再冒充"这段文字的来源"）；`read_around` 不再把 OCR 的结果签成 `source: uia, confidence: 1.0`；长文本投影从"取前 16k 字"改成"以手势位置为中心的 16k 字窗口 + 明确交代前后各少了多少"（这条窗口逻辑此前只挂在一个已经无生产调用方的证据块上）；系统提示词第 2 条指向 InputArtifact 真实携带的 `visual_anchor`（`bbox:l,t,r,b`，`look` 可原样使用），此前它指向的证据块已不存在。同批删除死代码 `_bridge_evidence_block` 及其只为它存在的截断助手。⑥**幂等键不再随工作树抖动**：`contextPacket.workspace` 把仓库的活体脏状态（HEAD、changedFiles、diffStat、diffExcerpt、isDirty）和 `runtime.processBinding` 的进程号一起带进了 canonical，于是在工作区里保存任何一个无关文件都会让同一次重规划算出新键——回执复用不命中，一次重试就能把同一封外部发送再发一遍；这与 §审计第 9 条剥掉的随机 leaseId 是同一个缺陷的第二处。现在只保留操作真正落在哪里（cwd/repoRoot），证据内容仍照旧绑定（换一条错误文本仍换键）。这一处不是推演出来的：完整套跑里两次相邻的同意图重规划确实算出了不同键，随机顺序下才暴露。fresh 验证：Python **1338 passed**；Node **151 passed / 104 源文件**；五套 typecheck 与 ESLint 0 警告。**未交付**：按用户指示不再逐批升版本，这批不动 `package.json`（仍 1.0.11）、不跑 `npm run sync`，安装版维持上一批 1.0.11；等一批成熟的产品级里程碑再统一升版本并 sync。诚实边界：Vision 仍未成为 provider（`look` 仍是模型可调工具，不参与自动 fan-out）；SurfaceAdapter 仍有按手势启动成本；像素 tier 仍在回答阶段而非 pointerup 阶段跑（同一张冻结帧、同一套融合，代价是首反馈之后才有 OCR）。

2026-08-18 第二批地基复审与修复（1.0.11 已交付）：对 1.0.9/1.0.10 两批新代码逐份复审，找到并修掉四处真问题。①**结算语义不再从结果文本里猜**：settlement 此前用 `"outcome may be unknown"` 子串判断结果是否未知，而工具名是模型可控的——模型调一个叫这个名字的未知工具，就能让一次从未派发的调用被记成 unknown + never_replay；反过来，任何人改写调度器那句文案，真正"取消发生在派发之后"的外部发送会被记成 failed，崩溃恢复不再核验就可能重发。现在由 `ScheduledCallCommitted.outcome_known` 从唯一能观察到它的调度器直接说出来。②**崩溃修复的文本与记录对齐**：prepared 但从未 dispatched 的调用记为 not_started，给模型的文本却说 TOOL_OUTCOME_UNKNOWN，会让模型拒绝重试一个记录明确允许安全重放的读。③**RecoveryPolicy 第一次真正被消费**：它此前只被投影和断言，零个生产调用方读它——三种恢复语义拿到的是同一句话；现在 safe_replay / verify_before_retry / never_replay 各自成句，从 prepared 时的 effect 一路走到模型读到的指引。④**并发感知有了裁决 deadline**：broker 原先等每个 provider 都返回才裁决，总延迟等于最慢的那个，对无响应窗口的 UIA 探针就是无限等待——并发融合要消除的正是这个失败；超时的 provider 记为 timeout observation，用已到达的证据裁决，单适配器路径也不再走同步特例（"只匹配到一个 UIA 适配器"恰是最常见的挂死场景）。fresh 验证：Python **1318 passed**；Node **151 passed / 104 源文件**；五套 typecheck 与 ESLint 0 警告；`git diff --check` 干净。同时把 1.0.7–1.0.10 三批此前未提交的工作按主题分四次提交（分支已推 origin），并把 pytest 临时产物挡在版本控制外。交付：`npm run sync` 再跑同套 typecheck/Node/Python 门后构建 `Magic-Pointer-1.0.11-x64.exe`、覆盖安装并重启，安装目录版本核对为 **1.0.11**，`run_kernel/projection.py`、`perception/broker.py`、`input_artifact/schema.py`、`scripts/agent_session_bridge.py` 均已在安装目录中独立核对存在。

2026-08-18 Sovereign Agent 后端地基第二批（1.0.10 已交付）：现有 `EventSession` 被确立为 Runtime 唯一 durable truth，没有另建平行 session/ledger store。每个真实工具执行现在以 `operation/prepared → 物理执行 → operation/settled` 形成 effect sandwich：执行体启动前已持久化 operation id、effect 与 dispatched，settlement 同时写 usedBackend/latency/failure/outcome 并作为唯一 TOOL surface；未结算的 read 可安全重放、可逆写先核验、不可逆/send/delete/purchase 永不盲重放，未 dispatch 不再伪装成“可能执行”。进程内 Inbox 已降为 producer 缓冲，`next-step`/`next-turn` 最终写入同一 session；`inbox/consumed` 用一次 `append_many` 原子完成“领取 + 进入模型上下文”，并发 handle 不会重复消费。新增已打包的 `scripts/agent_session_bridge.py` 提供有界 put/pending 本地 API。`InteractionLedger.from_session()` 直接投影 interaction start、模型 usage、请求/响应时延、operation settlement、look、终态、感知层与 InputArtifact id；selection 与 Studio conversation 都返回公开账单，不再有生产调用方写第二本 ledger 文件。fresh 验证：Python **1313 passed**；Node **151 passed / 104 源文件**；五套 typecheck 与 ESLint 通过；`npm run sync` 再跑同套 Python/Node 门后构建 NSIS、静默安装并重启；开发树和安装目录均为 **1.0.10**，安装目录中的 run_kernel/session bridge/InputArtifact/ledger projection 均已独立核对存在。诚实边界：bridge 后端已可调用，但 GUI 尚无“运行中插话”控件；ledger 已随 bridge 返回但 Studio 尚未把整张账单可视化；崩溃恢复当前会风险感知地结算并关闭中断 turn，尚未续跑原 loop；DraftArtifact revision、ask-user UI 往返以及 Explorer/SurfaceAdapter/OCR/Vision 的统一 Broker 仍未完成。

2026-08-18 Sovereign Agent 后端地基第一批（1.0.9 已交付）：方向正式收束为“**完整自有 Agent 产品 + 确定性感知/执行内核**”，不是纯外设，也不把 Hermes 当后端；三份相互链接的决策文档以 `docs/research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md` 为最新实施蓝图。代码侧先打感知入口：结构化适配器由串行 first-usable 改为并发证据 Broker，保留 ok/degraded/empty_confirmed/busy/timeout/unsupported/denied/error 八态、全部 observation 与显式冲突，干净证据优先于高优先级降级证据；新增纯领域对象 InputArtifact，把指令与屏幕数据分离，要求手势输入绑定 FrameLease，并提供 GUI/CLI 可直接渲染的公开投影和有界模型投影；selection loop 已实际消费该 artifact，终端场景同时保留锚点错误行与有界错误窗口。交付链同时修复 PowerShell `Copy-Item` 无法覆盖 Torch 超长路径的问题，改为不删除额外文件的 Robocopy `/E` 并严格处理退出码。fresh 验证：Python **1302 passed**；Node **151 passed / 104 源文件**；五套 typecheck 通过；NSIS 安装器生成；`npm run sync` 返回 0；安装目录版本与开发树均为 **1.0.9**，超长许可证路径存在，应用已重启。诚实边界：当前并发只覆盖结构化适配器；Explorer/SurfaceAdapter/OCR/Vision 尚未全部纳入同一 Broker，InteractionLedger 尚未接生产 loop，durable session/operation cursor 仍属后续后端批次。

2026-08-17 Studio DSH 高保真收口（1.0.7 已交付）：沿用用户批准的边界——DSH 是布局/密度/展开交互金样，品牌、设置语义和运行时能力仍是 Magic Pointer。①左栏改成 MP 五个工作区入口 + DSH WorkspaceBrowser（36px「最近对话」头、点击展开的内联搜索、独立滚动列表座、32px 会话行、稳定底栏）；②修正 StatsLine 的真实 DOM 位置，从输入卡上方移到 InputBar 卡片下方，只显示会话能推导出的轮数/步骤数；③来源标签允许收缩且自身省略，900px 窄窗截图中与长标题不重叠；④设置保留八页真实 MP 内容与原保存/回滚链，外观改为 DSH 16/24 页头、14/22 说明和原位 disclosure 卡（每页首组默认展开、点击组头在当前页展开）。fresh 验证：Python **1286 passed**；Node **147 passed / 100 源文件**；五套 typecheck、ESLint 0；离屏截图 `data/runtime/dsh-fidelity-{chat,settings}-1.0.7.png` 与 `dsh-fidelity-chat-narrow-1.0.7.png`（console_errors=0）已人工审看；NSIS `Magic-Pointer-1.0.7-x64.exe` 已构建、静默安装并重启，安装目录版本核对为 **1.0.7**。

2026-08-17 Studio GUI 链路批（1.0.6 已交付）：①**"full answer budget exhausted" 根除**——conversation_bridge / selection_bridge 调 loop 时没传 budgets，默认 4 秒 FULL_ANSWER 预算把普通 3-6 秒模型回答在第一轮就误杀；两桥各传宽松 FULL_ANSWER（对话 1h / 划线 5min），该错误从此不可能出现；②**工具链进 GUI**——`ToolResult` 加 `tool_name`/`arguments`（loop 执行处富化），`loop_answer` 投影 `events`（name/arguments/result/isError），bridge→conversation_store→main.ts 全链透传落盘，DSH 聊天渲染层的 pwsh/Think/工具行第一次有数据可画；③**侧栏会话行按 DSH 重做**——去掉 C1 两字母色块与副标题小字，改为 DSH 32px 行（状态点 + 单行标题 + 相对时间 + hover 省略号），StateDot/行 CSS/ellipsis 图标按 DSH 源码原样移植；④**复制按钮不再假装成功**——Promise 校验 + textarea 兜底，失败不换勾。fresh 验证：Python **1286 passed**（+3 测试）；Node **147 passed / 100 源文件**；typecheck、ESLint 0；离屏 DOM 探针：32px/8px/6px gap/状态点绿+光晕/时间 tertiary，console_errors=0；NSIS 1.0.6 已装并重启。

2026-08-16 Agent 地基融会贯通批（5 commits，纯 Python 侧）：按 Pi/Claude Code/DSH/Hermes 四源码审计（计划文档 `docs/superpowers/plans/2026-08-16-agent-foundation-consolidation.md`）——①死代码清除约 1500 行（零生产引用的认知四件套/table_merge/events 包/capability_hints 等，入口可达性+符号级核实后删除）；②Inbox steer/followup 输入模型（社区 P0「输入被吞」：next-step 下一轮即携带、next-turn 停后续跑）；③turn 端验证门（Hermes 模式：写入无验证回执想收工先 nudge 一次）；④工具效果按调用分级（CC isDestructive(input) 契约，effect_for 四消费点接线）；⑤loop 恢复块提取纯函数。fresh 验证：Python **1283 passed**（+19 新测试）。跨进程 steer 传输与 session 树仍是显式非目标。

2026-08-16 DSH harness 能力对齐（4 commits，开发树未交付）：①权限模式按 DSH 重定义——sandbox×approval 预设表（read-only/workspace-write/danger-full-access，custom 派生），Full access 带勾选确认门，链路 `permissionPreset` 端到端；②模型接入真实化——`model.catalog` 从网关 `/models` 拉目录（实测 26 模型），`model.select` 写 `secrets/model.txt`，作曲家模型位=DSH ModelSelect；③`+` 菜单=DSH 斜杠目录——本机 skill 扫描（`.dsh/.agents` 项目+用户根，实测 51 个）+ 命令（/permission、/model）分组搜索，skill 正文按回合注入；④侧栏 DSH 浏览器形状（搜索+今天/昨天/7天/更早分组，MP 收藏导航保留）+ 图标换 DSH 原路径。fresh 验证：Python **1312 passed**；Node **147 passed / 100 源文件**；typecheck、ESLint 0；离屏截图 console_errors=0。交互流真机核验与安装版 sync 未做。

2026-08-15 已完成 Agent 社区真实需求调研，结论与来源记录在 `docs/research/2026-08-15-agent-community-real-needs.md`；本次只新增研究文档，没有改变运行时行为，因此不升版本、不执行 sync。

2026-08-15 开发树续批（**未打包、未同步安装版**）：接通 Groq `openai/gpt-oss-120b` 模型档案、安全凭据与主回答/展开/健康检查链，加入终端安全配置与实测命令；修复活动语音会话导致总开关保存回滚；自动屏幕记忆与后台学习改为默认关闭并各有真实设置开关；Stage 处理/完成态固定复用 `560×520` 面板锚点；Studio 首屏路由与收藏箱 100% 缩放可读性修复；删除 6 个无引用旧探针。fresh 验证：Python **1256 passed**；Node **141 passed / 97 source files**；typecheck、ESLint、Electron build 通过。按用户要求，本批不升版本、不执行 NSIS/`npm run sync`。

2026-08-15 HCI 系统级审查完成（纯文档批）：`docs/2026-08-15-HCI_SYSTEM_REVIEW.md` 交付感知元数据注入 Schema、像素级 GUI 参数表、会话导轨/指针 HUD 状态机与 T1-T12 落地清单；上一批 Oreo Stage/Studio 实现已提交（`e48a469`，30 文件）。未改变运行时行为，不升版本、不 sync。

2026-08-15 Harness 认知架构重构（`261e553` GUI 移植 + `b00753d` 认知核心，开发树未交付）：deepseek-harness 聊天视觉 100% 移植进 Studio（浅色档）；新增惊奇分级/断言记忆/预算表面/Event-Action 仲裁四模块 + 24 项极限场景基准（Python 24 passed；Node 143 passed / 98 源文件；typecheck 过）。**认知核未接生产 loop、turn.events 未落盘、未升版本未 sync**——架构映射与裁决在 `docs/2026-08-15-HARNESS_COGNITIVE_ARCHITECTURE.md`。

2026-08-15 Studio 整体重建为 deepseek-harness Web 外壳（`d7328f1`，开发树未交付）：侧栏/输入卡/统计行/设置模态全部按 DSH 源码 1:1 移植，令牌平台双档完整（默认随系统，修复暗底黑字看不清）；收藏箱/时间线/记忆/产物保留并随主题。验证：Node **143 passed**、lint 0、typecheck 过，离屏截图 `data/runtime/dsh-{chat,settings}-check.png`。Stage/Companion 仍为旧视觉；未升版本未 sync。

2026-08-15 Studio 对话 = 真实 agent 回合 + 权限门（`79b92c5` 控制栏/回车、`5e96be7` agent 化，开发树未交付）：`conversation_bridge.py` 改为 boot 插件树跑 `run_agent_turn`（多轮+工具），历史走 data 通道、无锚点 guard fail-closed、写动作只 propose；作曲家补 `+` 菜单/模型切换/上下文环/权限下拉（5 档，逐工具门），回车发送（IME+Shift 守卫）。验证：Python **1286 passed**、Node **143 passed**、typecheck 过。端到端模型回合待真机；未升版本未 sync。

## 一句话

**本机安装版为 1.0.12（Codex 学习批已 sync）；开发树与安装版同源。** Magic Pointer 的路线是完整自有 Agent：Studio 保留已交付的 DSH 高保真工作面，自有 Runtime 承担**全部任务（短任务与长程任务，时长不是边界）**，确定性感知/权限/执行边界归 MP；Hermes/Pi/Codex 只作为持续对照和资产语义来源，不是底座。感知能读（冻结/实时语义硬隔离），主 loop 能按 snapshot 绑定去 click/type/set_value（元素级失效），点完必须再观察，收工必须发票；运行中可插话（durable inbox）、可优雅停止（cancel/request → USER_INTERRUPT + Receipt）、看得见真实轮数，崩了能从会话记录知道有活没干完。验证：**Python 1426 过 / Node 154 过 / 五套 typecheck 干净**。真机 300 步长任务基准、steer/取消 GUI 真机实测、ledger 完整可视化仍是明确后续（见 `docs/research/2026-08-19-codex-harness-study-and-audit.md` §3）。

**2026-08-14 全库深度审计 + 修复批（已完成，见 §审计）**：9 个区域逐文件逐行审查 + 红队对抗实测；修复 6 个 P1（L0 本地动作劫持、证据进指令通道、compaction 剥围栏、tasks 并发丢数据、UIA 管道无鉴权、快照桥缺 lease fail-open、undo 无读回校验、scope 泄漏级联等 14 项）与 20+ P2；已随 2026-08-15 的 1.0.5 一并同步到本机安装版。

FrameLease 捕获地基（8·11 计划 Phase A）已全量落地并过自动化验证；外部 harness 评审（`docs/harness-gap-review-20260812.md`）已吸收，评审批次 1/2/3（L1-L16 基础设施）全部落地。2026-08-13 最强模型对交接文档（`docs/2026-08-13-ARCHITECTURE_HANDOFF.md`）的评审回复（`docs/2026-08-13-STRONGEST_MODEL_REVIEW_RESPONSE.md`）已**全量执行**：三个结构性张力（T1 预算语义/T2 证据截断/T3 in-loop 可逆写）、13 题逐答、接线批（权限门/guard 真探针/流式默认+回落/compaction）、工具合并+双轨杀死、settings 深合并、记忆铁律、常驻 UIA 宿主（真机实测 2.5x）、SurfaceAdapter SDK+微信样例、Replay 20 条 trace、薄 smoke 层、WGC CaptureProvider 契约。基建执行顺序已按评审反转：**常驻 UIA 宿主先于 WGC**（Phase 编号不变）。进度账本在 `docs/design/MAGIC_POINTER_HARNESS_20260811.md` §18。

七条不可回退 invariant（评审 §四，任何后续改动不得松动）：① FrameLease commit 失败 fail-closed 禁重拍；② Anchor 五路判别一等值，ambiguous/changed 永不按 exact；③ Evidence 八态 busy≠empty；④ 批准者黑名单（model/tool/agent 不能批准不可逆）+ 确认 UI harness 持有；⑤ origin 双通道屏幕内容永远是 data；⑥ UndoLog 失败不伪装 + 回执读回校验；⑦ 真机验证与自动化分账。**审计修正**：⑥ 的"回执读回校验"此前只在 replace 路径存在，undo 路径未验证即 mark_undone——审计批已补上读回校验并加测试；④⑤ 的接线边界以 §审计 为准（治理门 EgressGate/UndoLog 模块契约完备、生产接线仍是明确缺口，见下）。

分支 `codex/harness-reconstruction`（已推送 origin）。Electron/Node 非测试源码已全部迁移为 TypeScript（**92 个非测试 `.ts`，非测试 `.js` 为 0**）。

结构化应用（记事本、Edge、Office、终端）的划线读取链路已经可用；自绘应用（微信 4.x、Qt、Flutter）的 SurfaceAdapter SDK + 微信样例已落地（容器 UIA 暴露则用，否则诚实像素锚点），但**"首笔手势像素候选框"仍需真机验证**。**不能宣称"任意 Windows 软件里随手一划都能稳定理解完整对象"。**

## 能用

| 能力 | 状态 |
|---|---|
| 记事本无选区整篇读取（document_text 回退，真机验证 34,660 字全文入上下文） | 可用（需重编译探针/重建打包产物后生效） |
| FrameLease 冻结先于感知（pointerup→commit→会话） | 可用（GDI 后端，p50≈192ms / p95≈213ms；CaptureProvider 契约已建，WGC 原生工具为脚手架，诚实报告 `wgc_tool_missing`） |
| 常驻 UIA 宿主（named pipe，评审优先级第一） | 可用（**真机实测 ping+probe 通过，稳态 200-250ms/读 vs 冷启动 573ms+，约 2.5x**；Electron 启动 spawn；`MAGIC_POINTER_UIA_HOST=0` 回滚） |
| agent loop 即路由器（模型即路由器，生产默认） | 可用；L0 关键词只留本地动作/显式 handoff；`MAGIC_POINTER_LEGACY_ROUTER=1` 回滚 |
| 桌面动作面（Kimi 13 工具） | 开发树可用：`get_app_state` 发 COM ControlView 树 + `snapshot_id`；index 与坐标均可 click；`set_value`/`invoke` 走原生 pattern，缺 pattern 诚实失败。未 sync 到安装版 |
| 权限模式门（default/plan/accept_reversible/safe/bypass × 六档 effect） | 已接 loop 每工具门；默认 default |
| 四道 guard 真机数据源（真探针 + 选区 anchor fallback） | 已接线；in-loop 可逆写默认 off，`MAGIC_POINTER_INLOOP_REVERSIBLE=1` 翻转前需真机验证四 guard |
| 流式回答 | 默认开（`MAGIC_POINTER_STREAMING=0` 关），SSE 失败自动降级非流式 + 健康 note 不毒化 |
| 上下文压缩（70% token 阈值主动 + withheld 被动） | 已挂 loop；`MAGIC_POINTER_CONTEXT_TOKENS` 默认 64000 |
| 证据硬围栏 + 显式截断（手势点中心截窗 + 字数 + read_around 提示） | 可用（现由 InputArtifact 投影承担：16k 字以手势为中心的窗口 + 前后缺字交代） |
| 300ms 本地首反馈（"我看到了：X · N 字"） | 已接线（零模型，snapshot summary 材料） |
| 能力工具（26 → 18 正交合并，schema 单一来源归代码） | 可用；find_capability 保留；双轨已杀 |
| settings 深合并（RFC 7396）+ 渲染层键名翻译表 | 桥端已修（先深合并后键名，顺序按评审）；渲染层只发有消费方的键 |
| 证据契约（八态 + 反容器启发式 + 冲突） | provider 协议 + 独立 fusion；结构化（适配器/Explorer/SurfaceAdapter/手势策略）并发 fan-out，冻结帧 OCR 作为像素 tier 参与同一次裁决；结构化未覆盖手势时 harness 同步 look 一次写入证据，仍不是每轮 Vision fan-out |
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
15. **ask_user Stage 选项芯片已接**（`awaiting` + ≥2 options 点选原文续跑）。Inbox 按 question id 绑定 answer 仍未做。
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

## 审计（2026-08-14：全库逐文件深度审查 + 红队对抗实测 + 修复批）

按用户要求做了一次面向"可发布"的全库审查：9 个区域并行深审（harness 内核 / agent_runtime / fabric+模型层 / 安全治理 / 感知操作 / electron / Python 桥 / 红队跨域对抗 / 文档声明核验），全部发现都以文件:行 + 实测复现为证。修复分批提交（`0907b9a`、`32be047`、`2bb06ea`、`70d9c89`、`1daef91`、`cd2f661`）。以下按严重度记录。

### 已修复的 P1（发布前必须修）

1. **L0 本地动作可被屏幕文本劫持**（红队 T6 实测）：圈选内容含「复制这个」等词时，任意问题被零模型短路成剪贴板写入。修：本地动作只匹配纯指令通道（`run_agent_turn.local_action_input`）。
2. **证据块整体标记 origin=instruction**（违反 invariant ⑤ 的结构性缺口）：证据现在作为独立 `origin=data` 消息进入 loop；compaction 摘要重包数据围栏；`AgentMessage.from_dict` 缺 origin 时 fail-closed 归 data。
3. **compaction 剥离证据围栏**（红队 T3 实测）：摘要回注时重包 `<<<MAGIC_POINTER_EVIDENCE>>>` 围栏 + 非指令声明。
4. **tasks/tasks.json 无锁并发写**（红队 T5 实测丢 47% 任务 + PermissionError）：跨进程锁 + 唯一临时文件名。
5. **UIA 常驻宿主 named pipe 无鉴权/无界读**：任何本地进程可读任意窗口文本或 DoS。修：PipeSecurity DACL（仅当前用户）+ 有界行读（256 字符）+ 每连接请求上限；客户端校验响应 id；客户端 `_read_pipe` 每次迭代查 deadline + 1MB 缓冲上限（滴送字节不再挂死感知链）。host 已重编译，uia-host smoke PASS。
6. **selection_snapshot_bridge 缺 FrameLease 时 fail-open**：带手势但无 lease 的请求现在 fail-closed（`missing_frame_lease`），不再实时抓屏伪报冻结证据。
7. **Word undo 无回执读回校验**（invariant ⑥ 直接违背）：restore 后读回哈希比对，失败 FAILED 且不 mark_undone。
8. **工作室 DOM XSS**：`esc()` 补引号转义；studio/companion HTML 加 CSP；`stash:list` 加 sender 校验。
9. **幂等键非确定性**：targetLease 随机 id + 时间戳从 canonical 剥离，同意图重规划得到同键（回执复用恢复）；workflow 同键不同参数拒绝复用。
10. **模型自填 attachments 任意文件外泄**：模型侧 propose/execute 闭包丢弃 attachments（路径只能来自接地证据链）。
11. **engine.execute 异常冒泡**：执行器异常转诚实 failed receipt 并落审计。
12. **MCP 解析炸弹**：reader 线程捕获 RecursionError/MemoryError，不再静默空成功。
13. **resident scope 泄漏级联**：缺服务 KeyError 时 scope 不 close 的级联泄漏已修（open+get 入 try/finally）。
14. **frame_capture_worker re-arm 僵尸线程**：旧线程绑定自己启动时的 stop 事件，re-arm 不再叠加并发 ImageGrab 循环。
15. **computer_operator 取消后按键卡死**：CancelledError 传播前 abort 已执行动作，KEY_DOWN 键释放。
16. **review 脱敏 JSON 绕过**：`{"api_key": "..."}`（转义引号）此前原样泄漏给后台 review 模型；正则重构 + AKIA/pwd/passphrase 覆盖。

### 已修复的 P2（抽样，全部带回归测试）

预算 productive 轮被 renewals 上限硬截断（改：productive 无条件续期，budget_renewals=0 保持单预算模式）；stop hook 返回 None 杀死 loop；clarification 静默丢弃同批其他工具调用（现在显式 not executed 回喂）；工具结果非字符串哈希崩溃；微信适配器子串误匹配（evilwechat.exe / "微信使用技巧 - Chrome"）；manifest 字符串类型混淆逐字符展开；model_health 并发写丢端点 + 单条目跨端点串扰；harness `_effects` 累积、unload 不清 services、parallel 吞异常；dump_config 泄漏配置密钥与绝对路径；replay 自证 frame_lease 但 frame_lease=None；deliver 判定恢复（重建批误删）+ 禁 markdown 提示词进 loop；测试 env 泄漏隔离；快照桥失败仍返回 exit 0。

### 仍未修复的发布阻塞（架构性，需下批接线或显式裁决）

1. **治理门零接线**：`EgressGate` / `UndoLog` / `ActionApproval` / `WindowSubscription` / `check_budget` / `merge_for_decision` / `AppBlacklist` 模块契约完备（测试全绿），但生产代码零调用——出网/undo 的"单一出口 + 全审计"目前靠权限表 + HMAC 计划签名 + 确认卡三层，没有第二道网闸兜底。**要么接线（下批），要么把 invariant ④⑤⑥ 的声明明确降级为"契约层已建、接线中"。**
2. **replay 断言漂移**：20 条 fixture 中 5 条 FAIL（2 条内容波动 + 3 条 proposal 形状机制失败）；"机制绿"的说法不成立，断言需改成形状断言并复核 3 条机制失败。
3. **compaction 注入持久化**已缓解（围栏重包），但"摘要模型把注入原文忠实复述"的残余面未闭环（summarize 提示已加剥离要求，无结构性保证）。
4. **插件=任意代码执行**：`data/plugins/**/plugin.py` 只靠文件系统写权限；批准 UI 是唯一门。发布前确认插件候选批准流程展示完整 diff 且默认拒绝。
5. **plan-signing.key 明文 + Windows 0o600 无效**：同用户进程可伪造 `requires_confirmation=false` 计划；应迁 safeStorage/DPAPI 或显式 DACL。
6. **出网 key 重定向外泄面**：messages 模式 `x-api-key` 在跨源重定向时不被 httpx 剥离；`follow_redirects=False` 或白名单校验。
7. **screen memory 无设置门控**：`_record_auto_memory` 无条件记录（模块契约承诺 off 即 off）；应接 settings 开关。
8. **uia-host smoke 环境相关**：本会话 PASS（文档此前数字 2.5x 无法复验，与前台窗口类型强相关）。
9. **交付管线**：全量验证数字以 §一句话 为准（Python 1249 / Node 131 / typecheck / lint / uia-host smoke）；真实桌面截图回归与安装版交付仍未执行——开发树仍**不能声称零 bug 或已交付**。
