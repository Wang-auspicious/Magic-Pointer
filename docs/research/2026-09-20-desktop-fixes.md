# 桌面与集成审计修复记录（2026-09-20）

对应 `audit-2026-09-20-desktop.md` 的 D01–D21，以及本轮协作分配的 RT20、OP11 GUI 接线。保留已有工作树修改；此分区不改版本、STATUS、canonical 账本，不 commit/push，不启动 Electron GUI，不向真实联系人发消息。版本、安装同步和最终全量验证由主任务统一完成。

测试策略：先用公开调用接口复现用户可达的失败，观察红色结果后再修改生产实现。磁盘故障用临时会话和延迟 I/O，插件命令用本地回环 HTTP 和 Figma API fixture；renderer 回调用真实源码转译后在最小 DOM 中执行。旧审计 repro 明确断言历史缺陷，不能在修复后作为验收运行。

| 编号 | 修复与用户行为 | 观察到的失败 → 修复后证据 |
|---|---|---|
| D01 | `conversation_store.ts` 仅在真正开始异步写时清 dirty；写完后继续保存期间发生的修改，同步 flush 的写入顺序仍受保护。 | `conversation_store_pending_write_test.ts` 重开只见 1 轮，预期 2；修后后台完成即重开可见 2 轮。deferred/incremental 旧回归也通过。 |
| D02 | `python_bridge_runner.ts` 将 stderr 改为有界诊断尾部，合法已消费进度不再占用整个任务的累计配额。普通 runner、main 和 selection worker 的最终 JSON 上限统一为 32 MiB，保留显式调用方更小预算与超限错误。 | `python_bridge_progress_volume_test.ts` 连续 12 条、每条约 128 KiB 的合法分块进度原先提前失败，现全部收到并正常完成；`bridge_large_result_test.ts` 的 40 条 32 KiB 工具轨迹分别触发两个旧 1 MiB 限制，修后完整接收。 |
| D03 | `artifact_editor.ts` 单独比较已保存补丁与当前补丁；恢复说明文字不清除未保存补丁；保存过程中继续编辑也不会被旧响应覆盖。 | `artifact_editor_unsaved_patch_test.ts` 原 dirty=false、旧批准可丢补丁；现保持 dirty，批准返回 save_required，并保留保存途中新增编辑。 |
| D04 | `studio.ts` 按原 after 值类型解析：文本编辑器保存原始字符串，数组/对象仍解析 JSON。 | `artifact_renderer_edits_test.ts` 中文纯文本原报 JSON 错误，现保存为原字符串。 |
| D05 | Figma retarget 回包核对编辑器选择代次、版本及补丁引用；用户换草稿或继续修改后，不再套用旧回包。 | 同上测试：原把 a 补丁写进 b 草稿，现 b 保持不变。 |
| D06 | `integrations/figma/patch.ts` 同节点非重叠文本修改按原范围从后向前执行，重叠范围明确拒绝。 | `figma_patch_transactions_test.ts` 原 `AAAAZZdef`，现 `AAAAbcdZZ`；重叠请求无写入失败。 |
| D07 | 当前操作先进入恢复集合，记录已删除和实际插入长度；插入失败也恢复已完成删除；恢复再失败会明确返回 rollback_failed。 | 同上：注入第一次 insert 失败，原剩 `bc`，现恢复 `abc`；原始写失败仍向调用者报告。 |
| D08 | 字体加载后、首次写入前，同步重新验证全部节点基值、锁定/删除状态及字体身份。 | 同上：加载字体时把 `abc` 改为 `xyz`，原被覆盖成 NEW；现 base_changed 且保留 `xyz`。 |
| D09 | `figma_bridge.ts` 请求有 dispatch 截止时间；超时撤销尚在队列的命令；已派发超时明确 result_unknown。服务端拉取也跳过到期 queued 命令。Python timeoutMs 接线由主任务完成。 | `figma_bridge_lifecycle_test.ts` 超时后原仍拉到 1 条写入，现 0 条。 |
| D10 | 完成结果消费后删除；结果提交时清理原参数；已断开的终态、停止服务时清理；未消费终态在后续插件拉取时按 60 秒回收。 | 同上：完成结果首次获取后，二次 GET 原仍 200、现 404；正常 request/result 旧回归通过。 |
| D11 | `agent_session_bridge.py` 调用真正的 FileSessionStore.fork，通过已完成 durable turn 截取事件；两条运行桥回传 runtimeTurn，store 保存独立映射；main 将新子 session 与其材料投影连到分支对话。子 ID 采用现有 stop/steer/续跑接受的 agent-UUID 格式。 | `desktop_session_fork_bridge_test.py` 原 invalid_target；现子任务具有首轮材料及正确 turn 边界。`conversation_branch_runtime_test.ts` 原缺 runtimeTurn/session/context，现保存完整，且正常停止控制接受子 ID。 |
| D12 | 删除保存层 200 轮、500 会话的破坏性截断，默认列表返回全部已存会话。 | `conversation_store_retention_test.ts` 原 500、现 501 个会话；最早会话的 201 轮及第一轮文字重开仍在。 |
| D13 | composer 支持的 12000 字经 preload、main、Python 与 steer 完整传递；main 超长先拒绝再归档，Python 一致拒绝；不再静默 slice 到 4000。 | `conversation_question_length_test.ts`、`preload_conversation_length_test.ts` 依次观察 main/preload 仅传 4000；`conversation_question_limit_test.py` 原拒绝合法 12000；修后完整送达，12001 明确拒绝。 |
| D14 | `task_watcher.ts` 比较实际可见 patch，步骤数不变的 note/state 更新也派发。 | `task_watcher_step_updates_test.ts` 原仅 1 次 patch，现 2 次并显示 complete。 |
| D15 | 已有观察记录的 tracker 启动时主动对比当前文件；文件监听使用父目录，可发现离线删除并经受编辑器原子替换。 | `context_tracker_restart_nested_test.ts` 原重启变化运行 0 次、现 1；真实临时文件离线删除原 0、现 1。 |
| D16 | 观察选中目录的整棵普通文件/目录树，取消首层 4096 项截断；目录使用递归 fs.watch。 | 同上：修改 sub/a.txt 原 observationsEqual=true，现 false。 |
| D17 | git status 使用 porcelain -z，解析保留中文原路径，重命名消费目标/来源双记录，不再把引号转义文本当真实路径。 | `project_paths_preview_test.ts` 使用真实临时 git 仓库，原中文路径不可发现，现路径为 `报告.md` 且磁盘存在。 |
| D18 | `project_inspector.ts` open/read/close 仅读取 maxBytes+1，用额外 1 字节判截断；保留二进制检查。 | 同上：1 MiB 文件、32 字节预览原调用整文件 readFileSync；现只做有界读取，返回 32 字节与 truncated=true。 |
| D19 | 用户选下次启动安装时启用 autoInstallOnAppQuit，正常退出安装，保留当前任务继续运行。 | `update_browser_navigation_test.ts` 原 autoInstallOnAppQuit=false；现 true，且没有立即 quitAndInstall。 |
| D20 | Pi 扩展成为显式 `/pointer "绝对路径prompt.md"` 提示词交付入口，逐字交付已审阅文件；取消 Pi 调用 MP current/plan/execute 的执行入口和普通 turn 自动现场注入。更新 AGENT_INTEGRATION 对应章节。 | `pi_prompt_delivery_test.ts` 原注册 4 个越过产品边界的工具；现无工具/自动 hook，用户命令逐字交付实际临时 prompt 文件。 |
| D21 | `security_hardening.ts` 按准确 WebContents 实例登记本项目内置浏览器；其 HTTP(S) 正常导航留在视图内，其他应用 UI 保持原策略。 | `update_browser_navigation_test.ts` 注册的浏览器正常 URL 未被 preventDefault/未转系统浏览器；file URL 仍阻止；既有 hardening 回归通过。 |

联合接线：

- RT20：`agent_session_bridge.py` status 返回 pendingRecovery；resolve 必须传 operationId、成功读取的 verificationCallId 和 confirmed=true。Studio 面板展示原操作参数和真实读回候选，明确确认后才解除。`desktop_recovery_bridge_test.py` 原缺 pendingRecovery；修后未确认拒绝、确认成功且持久清空。`recovery_panel_test.ts` 执行实际 renderer：显示读回，取消确认不发解除请求，确认携带匹配 ID，成功后刷新消失。
- OP11：artifact runtime/main/preload/Data/editor/面板完整增加 undo。read 消费 artifact.undoAvailable，apply 消费 result.undoAvailable；显示“撤销本次应用”，明确确认后传 confirmed=true。只有 result.status=succeeded 且 verified=true 才显示撤销成功；成功后禁止重复撤销。`artifact_undo_ui_contract_test.ts` 原无 undo 接口，修后验证 payload、确认门和状态转换。后端恢复与真实 Office 验收由主任务负责。

验证边界：这些是 headless 行为回归、真实临时磁盘/Git/回环 HTTP 测试，不代表 Figma 原生插件已验收。Figma 缺真实插件 ID/用户文档验收的原边界仍成立。升级延迟安装需签名/发布更新环境验证；本轮不伪造升级下载。没有启动 Electron GUI。

旧会话没有 durable turn 映射时，末轮可复制完整已结束 Runtime 会话；较早轮次会明确提示缺少可靠边界，而不会猜测消息序号等于执行轮号。新记录保存映射后可按任意已完成边界分支。

D02 的 32 MiB 是有界桥传输保护，不能描述成“无限大终态结果已根治”。超大终态仍可能返回传输超限；任务事件保存在 durable session 中，不能将传输失败当成未执行，也不宣称本轮完成了事件分页 UI。原累计合法进度导致长任务早退的问题已由 bounded tail 消除。

自动审批审查曾拒绝取消全部 stdout 上限，原因是无界输出内存风险；随后改用上述有界 32 MiB 方案，没有绕过拒绝，也没有为此要求用户追加审批。

本分区最终定向验证：

- 18 个新增 Node 回归文件整批通过，覆盖上表及 RT20/OP11 接线；此前相关既有 conversation store、artifact editor/runtime、Figma bridge/patch、watcher/tracker、project inspector/environment、security/update、bridge runner/worker 测试也分别通过。
- Python 定向 `desktop_session_fork_bridge_test.py`、`desktop_recovery_bridge_test.py`、`conversation_question_limit_test.py`、`agent_session_bridge_test.py`、`conversation_bridge_test.py`：**74 passed in 21.06s**。旧 status 精确对象测试增加新公共字段 `pendingRecovery: []`，没有删断言。
- 较早一批 `npm run typecheck` 全配置通过。最终重跑先发现新测试以 ES import 读取 CommonJS SelectionWorkerClient 的声明错误，已改成 require；随后重跑遇到 Node `NewSpace::EnsureCurrentCapacity` 内存不足，没有把该次记作通过。根代理已接管串行全门，停止本分区额外 Node/typecheck 进程以免争用内存。
- 生产源码冻结后已向根代理交接 D11 额外边界：若本轮异常仍留 open_turn，runtimeTurn 应返回空，不能借用上一已完成轮号；由根代理在统一验证前收敛。

完整 Python/Node/typecheck、最终版本、安装同步与最终真机交付以主任务本轮日志为准。
