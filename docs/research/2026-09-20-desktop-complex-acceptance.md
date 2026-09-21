# 1.0.50 安装版复杂任务实机验收

日期：2026-09-20。接续用户指定的上一任务「审计项目并优化 Jev 模型接入」，通过 native computer use 操作已安装 Magic Pointer 与真实 Excel。测试使用合成材料，不把单元测试、协议回放或原生 API 临时文档验收等同于本次端到端成功。

**结论：四组场景均有未通过项。** 文件读写、订单数值推导、排期日期/费用和中断后的持久上下文恢复确实工作；插话、优雅停止、稍长会话续问、验证收尾与 Excel 桌面工作流仍有实际阻塞。本轮只验收和定位，未修改生产代码、未升版本、未 sync，安装版仍为 **1.0.50**。

## 环境与证据

- 安装入口：`%LOCALAPPDATA%\Programs\Magic Pointer\Magic Pointer.exe`；安装目录 package.json 独立核对为 1.0.50。
- MP 模型：`mimo-v2.5`，Extra，Accept edits；本轮未改变模型。进入模型的回合 `usedBackend=magic_pointer.messages_multiturn_streaming`；文件工具为 `workspace_fs`，桌面发现/聚焦为 `desktop`。未观察到 Jev 调用，不能宣称本轮验收了 Jev。
- 测试工作区：`%LOCALAPPDATA%\Temp\mp-ws-test`；仅新增 `cu-acceptance-20260920/` 内的产物。
- 原始产物逐字节副本：`artifacts/desktop-cu-20260920/originals/`。样本保留错误，验收者未代为修正，也未执行其中生成脚本。
- 运行日志：`%LOCALAPPDATA%\Magic Pointer\electron.log`；UI 会话：同目录 `history\conversations.json`。
- Runtime JSONL 位于同目录 `agent-sessions\`：
  - A1/A2：`agent-studio-new-6612bd5cd5b245e6a32e61398c657221.jsonl`。
  - A3：`agent-studio-new-660ff53a1405496f833131c2611a2997.jsonl`。
  - A4：`agent-studio-new-cd240bf238b54bf88d3bba3b79821018.jsonl`。
- 截图经 native computer-use 工具直接显示在本任务中；没有将包含其他应用标题的完整日志复制入仓库。

## 四组场景

| 场景 | 实际执行 | 通过项 | 未通过项 |
|---|---|---|---|
| CU-A1：多版本订单、取消、退货、两表工作簿与报告 | 提交三份合成材料，拒绝额外 Bash 请求；运行中插话；真实 Excel 打开 CSV | 毛额2440、退款280、净额2160，三区净额770/700/690正确；三个文本文件落盘 | xlsx未生成；CSV乱码、首行串行、循环引用H10；却声称公式/结构核对无误；插话未送达 |
| CU-A2：原会话修复CSV、区域汇总和报告，再打开Excel | 正常追问，要求保留样本、另存修复文件 | 提交失败后输入内容保留 | 桥请求超过65536字节，未进入模型，修复无法开始 |
| CU-A3：材料恢复、桌面发现、停止与继续、原生Excel制作 | 读三文件并加载工具后点击停止，再在同会话继续 | crash repair恢复读取结果与2/6计划；发现真实Excel；失败报告落盘并读回 | 优雅停止失败，5秒强杀；Observe来源授权拒绝、Focus/Launch失败；xlsx未完成，计划却6/6 |
| CU-A4：工作日排期、并行依赖、预算修订、两版JSON与决策文档 | 写四文件并读回；验收者独立计算 | 12个任务的日期/依赖/加总正确；v1保留；新方案17800、余200、10月5日交付正确 | 决策漏掉第二条关键路径；验证门要求重读后触发防循环，最终stalled |

桥端持久计时：A1 首回合 **50.520 s**、拒绝 Bash 后回合 **201.448 s**；A3 恢复 **169.904 s**；A4 **153.418 s**。UI 可见 A1 后回合3m19s/164.7k tokens、A3恢复2m48s/304.4k、A4为2m31s/195.1k。计时口径不同；token是UI累计显示，不能据此推导账单或实际计算成本。

## B01 — P1：安装版会话桥导入失败，插话与优雅停止失效

A1插话显示 `插话未送达：bridge_no_output`，草稿保留，JSONL没有对应已接收消息。A3点击停止后同样失败，宽限期后子进程被强制结束；UI报「这一轮没有完成 / bridge_no_output，exit unknown」，原先展开的中间过程不再显示。

2026-09-20T08:36:22.281Z日志记录 `graceful cancel bridge failed`；08:36:27.144Z对话桥退出。`electron/main.ts:291`、`:2559`定义5000ms宽限和强杀兜底。

实际跑过的安装版只读复现命令：

```powershell
'{"action":"status","sessionId":"agent-studio-new-6612bd5cd5b245e6a32e61398c657221"}' |
  & "$env:LOCALAPPDATA\Programs\Magic Pointer\resources\python-runtime\python.exe" -I -X utf8 "$env:LOCALAPPDATA\Programs\Magic Pointer\resources\app\scripts\agent_session_bridge.py"
```

exit 1：line 10报 `No module named 'scripts._bridge_common'`，fallback line 18再报 `No module named '_bridge_common'`。公共模块实际存在。

根因：`electron/python_runtime.ts:74` 安装启动使用 `-I`；`scripts/agent_session_bridge.py:10`在补路径前导入公共模块，`ensure_root_on_path()`调用太晚。相邻 `scripts/conversation_bridge.py:37`已有先补根目录再导入的模式。

修复范围：沿用已有入口bootstrap；回归实际使用随包Python `-I -X utf8` 调status/steer/cancel，再做运行中插话和停止。只测import成功不能覆盖这里。

## B02 — P1：正常工具会话续问超出桥传输限额

A1只完成两个Runtime回合，A2正常追问即在进模型前失败：`payload exceeds maximum of 65536 UTF-8 bytes`。没有模型上下文用尽的证据。

`electron/main.ts:2360`把最近12个完整UI turn放入payload，内含thinking、activities、trajectory、receipts；`scripts/conversation_bridge.py:1324`使用`scripts/_bridge_common.py:17`默认64KiB限额。

从真实会话只取前两个turn，加很短的「继续核验」，请求已为 **134499 UTF-8 bytes**。以安装Python/对话桥只读重放，输出同一限额错误，exit 2；不需要请求模型即可复现。后来包含失败turn的turns数组为137061 bytes。

修复范围：对齐普通会话的传输契约与持久Runtime会话职责，避免将完整UI轨迹无选择重复传输；保留真实工具密集会话作为入口回归。不能解释为用户输入过长。

## B03 — P1：验证门要求读回，读取防循环却终止收尾

A4事件链：

1. 四次Write成功，四文件首次Read成功，Todo为5/5。
2. seq63模型已给出日期、依赖、费用核对后的最终回答。
3. seq64验证门注入「本回合执行过写入类操作，但还没有任何通过的验证回执」，并要求用「读回、测试或verify类工具」。
4. 模型再读四文件，seq72–75返回unchanged，提示必要时`force=true`。
5. 模型按提示force读四文件；seq83–86工具均成功，但重复证据触发`duplicate_read_evidence_halt`。
6. seq87回执为`status=failed / failureType=stalled / wrote=true / verified=false / usedBackend=workspace_fs`；seq88以`stalled`结束。UI显示「多轮重试未获得新证据，已停止，未能生成最终答复」。

相关实现：`app/agent_runtime/turn_verification.py:18`的nudge与认可证据契约；`loop.py:1512`注入nudge；`coding_tools.py:1355`的unchanged/force；`tool_guardrails.py:213`的重复证据终止。

这不是无限循环，而是矛盾的恢复提示把已有文件产出的任务推入失败终态。应给出当前工具确实可提供的验证方式，利用已有写后证据，并允许无法验证时诚实结束。不能把任意Read一律升级成语义正确的验证，也不应关掉全部防循环保护。

## B04 — P1：普通会话发起的原生Excel工作流没有闭环

A3恢复回合的实际结果：

- ListApps/find_roots成功发现 `sales-data.csv - Excel`，window `w-1772946`，EXCEL.EXE。
- seq46 Observe：`source access denied: window_not_granted:w-1772946`；seq56/66为`window_not_granted:unbound-live-surface`。
- seq61/71/86 Focus：`window_focus_failed`。
- seq76 Launch(EXCEL.EXE)：`[WinError 2] 系统找不到指定的文件`；seq81 Launch(excel)：`unknown app 'excel'`。
- seq90模型给Click编造`snapshot_id="placeholder"`，seq91被授权检查阻止，未发生点击。这项拒绝正确。
- 只生成`report-native.md`，未生成`sales-native.xlsx`，没有Excel内验收。

Observe拒绝来自MP的任务来源范围检查：`app/harness/builtin_bundle.py:449` → `app/context_pack/source_scope.py:277`。**不能归因为Windows UIA系统权限。** 会话未把目标窗口绑定成可读来源，也没有成功完成绑定/授权引导。应打通现有任务来源取得与授权流程，不是移除检查或开放所有窗口。

Focus失败位置为`app/computer_operator/windows.py:195`的前台确认。已确认现象，但未隔离Windows前台限制与验收控制器并存的影响，不能宣称所有机器必然失败。Launch的EXCEL.EXE名称在本机未解析到安装路径，恢复提示应与公开参数契约一致。

最终答案把Observe、Focus、Click统一说成`window_not_granted`，与Focus真实错误不符。「加载Document.propose_patch」也不能证明已尝试文档路径：日志中没有该工具调用。

## B05 — P1：CSV实际错误与「全部核对无误」矛盾

A1 `sales-data.csv`为UTF-8无BOM，0个CRLF、11个LF。前10个非空行各10列，合计行只有 **9列**：

```csv
合计,,,,,,=SUM(H2:H10),=SUM(I2:I10),=SUM(J2:J10)
```

三个合计公式因此落在G/H/I而非H/I/J。真实Excel通过文件打开对话框打开后，中文乱码、表头与O101串到首行，并弹循环引用警告；关闭警告后状态栏明确为 **循环引用: H10**。这是实际应用观察，不是从文本推测UI。

模型声称「CSV公式、结构全部核对无误」和「两表合计一致」，却未打开工作簿。`report.md`还将不存在的`sales-audit.xlsx`列入已生成文件清单；最终聊天承认xlsx未生成，报告未同步更正。

这包含产物/模型质量问题与验证呈现问题。底层最终回执仍诚实保留`unverified_write`，不能描述成verified。修复应以目标Excel实际导入、列数、公式位置与产物存在性为准，不以模型读过文本为准。

## B06 — P2：计划完成与实际失败冲突

A3 seq100把「观察Excel」「创建sales-native.xlsx」「Excel内检查」全标completed，UI为6/6；最终回答却明确这些步骤未通过/未完成。A4最终stalled时计划仍5/5。

需要可表达阻塞/未完成的计划语义，不能把“已尝试”呈现为“目标完成”。

## B07 — P2：工具活动错误归类为读文件/已运行

A1只有Todo与AskUser的阶段，UI将两者显示成Read并汇总`read 2 files`；两个permission_denied的Bash则称`Ran 2 commands (2 failed)`，实际上命令未执行。

`electron/renderer/dsh_chat.ts:241`直接映射`AskUser: 'read', Todo: 'read'`，`:1072`将read固定表述为`Read N files`，`:1096`累计时不区分权限拒绝与执行失败。A3的ListApps/Observe也被称作读文件。

应按实际动作和执行结果表述，计划/提问/观察/拒绝执行不能冒充文件读取或已运行命令。

## B08 — P2：权限控制问题覆盖用户任务标题

A1拒绝Bash后，侧栏和顶部标题变为`Deny Bash. Use another appr...`。`electron/conversation_store.ts:677`把每个非自定义标题更新成最新turn.question，其中包含内部权限恢复问题。

这里记录的是控制消息泄漏到标题；普通追问是否更新自动标题是另一项产品选择。修复只需避免权限决策控制turn改写任务身份。

## B09 — P2：决策文档漏掉第二条关键路径

A4 `decision.md:48`只给A→C→D→E→F，`:50`否认B为关键瓶颈。加速后B/C均9月28日完成，D依赖二者，两个分支均为零余量。

正确的是 **A→B→D→E→F** 与 **A→C→D→E→F** 两条关键路径，均10个工作日。B延误一工作日同样会把F推到10月6日。重复读回没有发现这一错误。

同表v1剩余预算为2200，但v1原预算17000，原口径应为1200；若用修订后18000比较，应明确口径。v2的17800总额和200余额正确。

## 正面结果和交付边界

- 写入范围符合要求；Bash拒绝确实阻止执行。没有操作其他已有工作文档。
- 订单毛额2440、退款280、净额2160，华北770、华东700、华南690正确。
- A3 seq30用`crash_repair/interrupted`关闭旧回合，seq31开启新回合，随后直接延续发现Excel，没有从零再读三材料。
- A4两版JSON经独立工作日计算核对，共12项的实际工作日序列、开始/结束、依赖与费用通过；原方案15800/10月6日，新方案17800/10月5日；两个版本均保留。
- 本轮没有生产补丁，没有运行与本次实机现象无关的全量回归，没有声明bug已修。后续修复仍需先复现/回归，再全量验证、补丁升版、sync，并重做对应安装版场景。
