# 2026-09-20 Runtime 审计修复闭环（RT-01–RT-22）

本记录对应 `docs/research/audit-2026-09-20-runtime.md` 的 22 条发现。修改保留了原工作树已有实现；版本、进度账本、安装同步和 Git 提交由主代理统一处理。共享 `app/harness/builtin_bundle.py` 的配置接线由主代理完成，恢复解除与按回合分支的界面/bridge 接线由 Desktop 分区完成。

## 验证结论与边界

- 2026-09-20 最新整合回归：**312 passed in 40.52s**。涵盖下列七个新增文件及 coding/edit/shell/Patch/subagent/fork/loop/todo/chat/context/batch_b6/harness 的旧测试。
- 随后增加了实际调用 `run_agent_turn`/`LoopModelClient`/`EventSession` 的子任务恢复测试，`runtime_child_lifecycle_test.py` **4 passed in 4.05s**。后端仅返回预设模型事件，执行的 Loop 和持久会话均为生产实现；第二次委派确实读取第一次的日志历史，模型收到的时间预算大于 60 秒。
- 红阶段实际观察到：coding 首批 18 failed / 7 passed；context 六种缺陷均观察到对应失败；child/fork 三个缺口失败；Hook 日志、运行中取消、Bash 延迟写入三个失败；恢复解除四种缺口失败；部分错误回执丢失失败；后台跨桥测试缺少接口失败；轻量 session 导入失败；长工具参数的压缩尾部事实丢失失败。测试夹具的 schema/import 错误先修正，未当成产品缺陷证据。
- Windows Bash 取消测试需要终止它自己启动的 Python 子进程。沙箱内 `taskkill` 受限时该测试失败；正常权限重跑通过，整合回归也在正常权限下运行。没有启动 Electron、操纵桌面、调用真实模型或安装依赖。
- 后台跨桥测试实际启动短命 Python bridge，再启动延迟打印命令；bridge 退出后检查 worker 写出的 exit、finished、log 和持久 `next-step` inbox。一次测试的启动辅助进程曾在导入 numpy 时发生 MemoryError，单独重跑通过；随后改掉 EventSession 经包导出被迫加载 Office 库的路径，加入独立解释器测试，后台与旧 shell 13 项一起通过。
- 这份记录是 Runtime 分区的回归结果，不替代最终全量 Python / Node / typecheck / 本机安装验收。真实供应商长任务、操作系统重启后的后台进程延续、真实应用中的用户恢复确认没有在此分区声称验收。

新增测试文件（准确名称）：

1. `tests/runtime_coding_audit_fixes_test.py`
2. `tests/runtime_context_audit_fixes_test.py`
3. `tests/runtime_child_lifecycle_test.py`
4. `tests/runtime_execution_lifecycle_test.py`
5. `tests/runtime_recovery_resolution_test.py`
6. `tests/runtime_partial_failure_test.py`
7. `tests/runtime_background_lifecycle_test.py`

## 逐项实现

| 编号 | 实际修改与用户可见结果 | 回归证据 |
|---|---|---|
| RT-01 | `subagent.py` 显式给子任务 FULL_ANSWER 一小时滚动预算；不再落入交互快速响应的四秒默认值。保留独立工具轮数熔断及 Agent 工具自身超时。 | child lifecycle 检查注入预算；实际 Loop 测试检查 fake backend 收到的 budget_ms ≥ 60000。 |
| RT-02 | Agent 接收工具 cancellation token，子 Loop 的 interrupt_check 联查父 token 和持久 cancel request。`loop.py` 在工具执行期间轮询已锁存的停止检查并取消 scope。Bash 改用 Popen 轮询，取消/超时时终止自己启动的进程树，再回收输出管道。 | 注入停止后工具确实观察到 token；真实短命 Python 命令在延迟写文件之前被终止；旧取消/超时/Loop 测试通过。 |
| RT-03 | 子任务在父 EventSession 同一存储根下创建自己的 EventSession；写入父子关系、配置与父任务的 created/finished 事件。Agent 提供 `resume_id`，恢复日志、修复中断回合并验证父任务归属；只读子任务不能在恢复时偷偷升级成可写。失败/中断的终态以错误工具结果反馈父任务。 | fake terminal 中断后恢复同一子日志；实际 Loop 连续运行两回合，第二回合模型输入含第一回合事实，持久 request 数为 2。 |
| RT-04 | 子任务获得项目共用的 `compact_messages` / `summarize_history_text`、上下文窗口、请求 token 估算和独立 tool-result 持久目录。估算器包括 system prompt，工具 schema 由 Loop 自己计数。 | 子任务配置与可调用估算器测试；既有 Loop 的主动压缩、再次压缩、供应商 context overflow 等旧回归通过。没有把真实模型摘要质量说成已验收。 |
| RT-05 | Read 状态属于当前工具注册对应的 Agent，不再以 workspace 全局共享“看过”状态。新回合/新子任务会拿到真正内容；旧的无调用方全局缓存入口已移除。 | 两个 registry 顺序 Read 同一个文件，第二个仍得到原始内容；读后修改/去重旧回归通过。 |
| RT-06 | CheckpointStore 录入与恢复使用文件锁；每次录入在锁内重新读取 manifest 中最大序号，避免另一个 handle 缓存的序号覆盖备份。 | 两个顺序创建的 store handle 修改同一文件后能逐步恢复原内容。 |
| RT-07 | coding registry 的备份目录按持久 session_id 隔离；无 session 的直接使用分配独立 owner。父/子和不同会话不能通过本 registry 的 Rewind 取到其他任务的记录。恢复同一子 session 继续使用其检查点目录。 | 第二个 registry 的 Rewind 不撤掉第一个的文件；主代理已为两条生产 bundle 路径传 session_id。 |
| RT-08 | 一个 Patch block 先在内存验证全部 hunk 的最终结果，再逐文件提交；checkpoint 回调仅在即将发生真实写入时执行。失败匹配不消耗撤销记录，后续路径验证失败不留下先前文件的半个 block。 | 成功 Edit 后失败 Patch，再 Rewind 一步能撤 Edit；多文件 Patch 第二个验证失败时第一个文件未改。 |
| RT-09 | `Move to` 分支放到通用补丁标题终止判断之前；改动成功后创建目标并移除源。已有目标不被无提示覆盖。 | `Update File` + `Move to` 的真实临时文件补丁成功。 |
| RT-10 | Patch 记住原文件 BOM、行尾形式和是否有末尾换行；定位用规范化行，落盘恢复原 CRLF / CR / LF 与 BOM。 | CRLF 文件局部补丁仍为 CRLF，移动同时保留格式；旧 Patch 匹配/多文件测试通过。 |
| RT-11 | shell 分类识别重定向、换行、命令替换等效果；git branch/config/tag/remote 仅保留明确只读用法，find -delete、date/set/env 写入式用法、rg --pre 等归入写权限。 | 多种常见写命令不得为 READ；git status/config --get/branch --list 等确实只读形式仍为 READ。没有执行这些危险命令。 |
| RT-12 | 带空格的独立 `cd` 保留引号 token，只有命令成功才更新持久 cwd。复杂 `&&`/管道/条件分支不静态推测 cwd；调用者可显式传 cwd。 | `cd "My Folder"` 正确解析；条件/跳过分支不污染 cwd；既有 Windows 跨调用 cwd 与显式 cwd 测试通过。 |
| RT-13 | Bash 的非零退出除已有明确“无匹配/有差异”退出码语义外，以错误结果返回，保留 exit/stdout/stderr。不会再给失败 build 生成成功工具回执。 | fake returncode=2 的 build 失败为 is_error；真实 Python exit(1) 为错误；grep 无匹配语义仍通过。旧测试相应改为断言 error_message。 |
| RT-14 | 移除 head/tail 二次裁剪、单消息内容裁剪和工具参数 12000 字裁剪。所有历史按每次最多 48000 字分批摘要；每批都成功后才接受组合摘要，任一失败保留整份原历史。失败重试同一批事实，不缩短掉后半段。`summarize_history_text` 的直接长输入也完整分批。 | 12 个跨 160k/48k 边界的事实标记全部进入摘要输入；失败中间批不替换历史；13000 字后的工具参数事实仍存在。摘要输出完整性/缺配置协议由 root 的 ai_client 修复承担。 |
| RT-15 | 有 nativeMessageId 的聊天消息用原生 ID 判断分页重叠；不同 ID 的同人、同时间、同文本消息都保留。 | 相同内容不同 ID overlap=0，同一 ID overlap=1；旧 chat 分页测试通过。 |
| RT-16 | Excel cell-range locator 用同 sheet 下的矩形包含关系匹配单元格；接受绝对引用 `$B$2:$C$3`，不因 Office locator 多一个 workbook 字段而全不匹配。 | 真实临时 xlsx 的 B2/C3 选区包含两个目标值，A1 不被纳入。 |
| RT-17 | URL-only 附件明确标记 `downloadState=requires-download`，不再宣称 DocumentReader 能读尚未下载的文件；已有本地路径继续可读。 | 从聊天附件 follow 出的 URL-only SourceRef 没有虚假的 read capability，并标出需下载状态。没有宣称新增自动下载功能。 |
| RT-18 | Context.search 所有 reader 均失败时抛结构化 ActionFailure；部分失败时保留结果并标出 degraded，而非把空结果包装成正常成功。 | missing file SourceReader 的搜索变成错误工具结果且保留 evidenceStatus；既有 Context 工具回归通过。 |
| RT-19 | Read 增加字符分页 `char_offset`/`char_limit` 与 `nextCharOffset`/`totalChars`；普通行读取截断提示说明续读方式。 | 60000 字单行之后的 TAIL 可读取，下一页位置可见；字符页不造成未见行范围的错误去重。 |
| RT-20 | EventSession 提供 `pending_recovery()`，列出未知操作以及之后成功 READ 的实际参数/结果。只有 UI/session 命令 `resolve_operation_recovery(operation_id, verification_call_id, confirmed=True)` 能持久解除；它不是模型工具。原 UNKNOWN 结果保留，projection 将那条旧操作的 recovery policy 解除；新一次不确定操作会建立新的屏障。 | 四个新测试覆盖真实读回+确认可解除、重开后仍解除，以及非读/不存在读/未确认均拒绝。Desktop 分区负责状态响应和明确确认按钮。 |
| RT-21 | pre-tool hook 在生成实际工具消息、计算 resource/effect、调度和 journal prepared 之前执行。调度与 `_execute_one` 都使用改写后的同一参数，执行时不重复跑 hook；后置 hook 仍保留。 | Hook 把 READ 参数改成 reversible write 后，实际执行参数、operation.arguments、operation.effect 一致；原“调度后改资源必须拒绝”的两项旧测试改为验证调度前可控重写。 |
| RT-22 | 新 `background_job.py` 独立进程执行 shell、原子更新 job meta、写真实 exit/finished，并自行向 EventSession 投递 durable inbox；桥内 daemon 只负责非持久 embedder 的 callback。job ID 使用独立 UUID 派生整数，避免每回合注册重置序号。session 导入不再提前加载 DocumentReader/Office 依赖。 | 桥进程退出后结果和通知依旧落盘；旧 background exit=3、callback 一次、BashRead 测试通过。没有声称后台进程能穿越 OS 重启；若被外部杀死且无 exit，BashRead 报 OUTCOME UNKNOWN。 |

## 与其他分区的接口

- `register_coding_tools(..., session_id=..., session_getter=...)`：生产 bundle 的 session getter 返回当前 EventSession，后台 worker 在启动时取得持久路径。
- `register_delegate_tool(..., parent_session_getter=...)`：子任务与父任务位于同一 session store。共享 bundle 的注入由 root 验证，子工具参数 `resume_id` 是实际可调用接口。
- `FileSessionStore.fork(source_id, child_id, through_turn=N)`：复制至第 N 个已完成的 `turn/end`，不夹带之后的消息/材料/计划；用于 Desktop D11，旧不传边界的完整 fork 保持原契约。
- `ActionFailure(..., partial_result=...)`：配合 CU10，ToolRegistry 保留失败前的已执行回执，Loop 对模型输出 `{error, partialResult}` 且 `is_error=True`。真实执行步骤不会因后一步失败而从结果中消失。
- `pending_recovery()` / `resolve_operation_recovery(...)`：用于 Desktop RT20 确认界面。后端检查真实成功读回与显式确认；目标是否已生效由用户阅读展示的证据后判断，不以模型自报“核验过”充当解除条件。

## 可重复的整合命令

```powershell
python -m pytest tests/runtime_coding_audit_fixes_test.py tests/runtime_context_audit_fixes_test.py tests/runtime_child_lifecycle_test.py tests/runtime_execution_lifecycle_test.py tests/runtime_recovery_resolution_test.py tests/runtime_partial_failure_test.py tests/runtime_background_lifecycle_test.py tests/coding_tools_test.py tests/coding_edit_intelligence_test.py tests/shell_infrastructure_test.py tests/apply_patch_multi_test.py tests/apply_patch_locate_test.py tests/subagent_progress_test.py tests/session_fork_context_test.py tests/agent_runtime_loop_test.py tests/agent_runtime_todo_store_test.py tests/chat_reader_test.py tests/context_tools_test.py tests/batch_b6_test.py tests/harness_builtin_bundle_test.py tests/harness_extensions_test.py --basetemp=.pytest-tmp/runtime-audit -q --tb=short -p no:cacheprovider
```

312 项运行发生在最后一条真实子 Loop 测试加入之前；当前命令包含该追加用例，不把它重复累加到旧运行结果。最终全量结果以主代理的 fresh 验证为准。

## 交叉复核 OP11 的补充修复

主代理要求针对撤销链做一次有界复核。新增 `tests/artifact_undo_lifecycle_review_test.py`，先观察到四个失败，再观察到重复 apply 的单独失败，随后修复如下路径：

- 删除 Word 文本后，逆操作的范围是 start=end；允许这个合法的 COM 插入点，执行后用实际替换文本的 UTF-16 长度读回。
- 原文字是新文字前缀（`cat` → `caterpillar`）时，不能继续读取旧的三个字符来验证。handler 记录本次已写操作的新范围，读回完整新文字；非 BMP 字符也按 UTF-16 单元数计算。
- 撤销写成功、读回暂时不可用之后，后续撤销根据之前 `writtenOperationIds` 核验恢复后的范围。已经恢复的操作直接记录核验成功，不重复执行。测试包括删除后的零长度插回，重建 backend 后重试仍不会重复插入。
- 同一个已接受修订有未撤销的记录时拒绝重复 apply。旧行为的最小例会把 `cat suffix` 第二次改成 `caterpillarerpillar suffix`。完整撤销后重新 apply 仍成功。

修改范围为 `app/actions/office_document.py`、`app/artifacts/document_patch.py`、`scripts/artifact_bridge.py`。新增六个用例加 artifact / patch / office audit 旧测试共 **35 passed in 14.40s**。Word 范围测试模拟 COM 的 UTF-16 位置与实际字符串变动；PDF/文件逆操作继续运行已有真实临时文件测试。生产 Word 路径发生变化，主代理会重跑 native 验收；这里不沿用修改前的 native 结果宣称新代码已经验收。
