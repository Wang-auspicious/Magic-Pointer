# Runtime / Context Pack 只读审计（2026-09-20）

这份文档是主审计的分区证据稿。审计对象是 **2026-09-20 当前工作树（包含已有未提交修改）**，不是某个历史提交。只新增本文档，没有改生产代码、历史账本或已有测试；没有启动 Electron、调用真实模型、操作真实文档、安装依赖。所有写入验证都在 Python `TemporaryDirectory` 内完成。

本分区确认 **22 条独立问题/不足**：17 条行为或协议错误，5 条执行/恢复/读取能力缺口。证据等级如下：

- **最小复现**：已用临时文件、纯函数或假模型走通相关路径，文内注明实际观察值。
- **代码确定**：完整追踪调用方和下游条件，结论直接来自当前实现；没有声称完成真实应用验收。
- **能力缺口**：现有入口确实支持该用法，但所需能力未接入；不是把理论上能构造的冷门输入算作 bug。

P1 表示会漏数据、错改/错恢复、使支持的工作流无法继续或违背执行约定；P2 表示行为不可靠、审计不实或影响普通用法。严重性用于安排修复顺序，不代表已观察到用户的数据损坏。

## 已理解的项目约定

MP 自己拥有 Harness 和 Runtime，长任务是正式产品能力。子任务、压缩、可恢复执行、显式中断、读回验证、可编辑产物均需由 MP 完成。桥接外部编辑器只是交付通道。当前修复建议依此收敛，不建议换成其他 Harness、加无调用方的框架，或用安全攻防式加固代替具体功能。

已先读长程历史审计；没有复报已经修复的 60/120 秒桥接硬上限、90 轮上限、旧版本完全没有子 Agent 等历史项。以下发现都重新核对了当前调用链。

## 发现

### RT-01 · P1 · 子 Agent 的模型调用仍落到约 4 秒默认预算

- 位置：`app/agent_runtime/subagent.py:189`；`app/fabric/engine.py:1095`；`app/governance/latency_budget.py:75`。
- 触发：生产工具包注册的 `Agent` 委派任意真实子任务。父桥接在 `scripts/conversation_bridge.py:1211` / `scripts/selection_bridge.py:3128` 传入长任务预算，子调用却没有传 `budgets`。
- 实际：`run_agent_turn` 回落到 `DEFAULT_BUDGETS` 的 FULL_ANSWER 4,000 ms。虽然 `Agent` 工具本身的超时很长，子模型每轮收到的请求预算仍约 4 秒。假模型实际记录为 `3998.4584000194445` ms。
- 预期/影响：父任务能等待正常模型推理时，独立子任务也应该有可用的模型等待预算；否则委派很容易比父任务更早超时，长工具超时配置并不能补救。
- 修复方向：将明确的子任务请求预算传入 `run_agent_turn`，或者从父运行配置继承；保留独立的轮次保险丝，不能把轮次预算与模型请求超时混为一谈。
- 证据：**最小复现**（假 provider / 假 model backend，无网络）。

### RT-02 · P1 · Agent / Bash 丢弃工具取消 scope，中断无法穿过正在运行的长工具

- 位置：`app/agent_runtime/loop.py:2846`；`app/agent_runtime/subagent.py:87,189`；`app/agent_runtime/coding_tools.py:1536,1567`。
- 触发：父任务正执行子 Agent，或执行一次耗时 shell 命令时，用户发出 Stop/interrupt。
- 实际：loop 把 scope 传给工具；这两个工具都用 `**_` 接收后丢弃。子 `run_agent_turn` 不接父 `interrupt_check`，Bash 用阻塞 `subprocess.run` 等到退出或最长命令超时。父 loop 的调用前/调用后中断检查无法检查工具内部。
- 预期/影响：显式中断应该使正在做事的执行单元尽快停止；当前父 UI/外层进程只能等待，或最终通过杀桥接进程兜底。此间子任务仍可能继续下一次文件动作；shell 子进程的生命周期也没有在此边界得到处理。
- 修复方向：把父取消信号显式传给子 loop；Bash 使用可取消等待并管理它创建的进程。针对现有两个入口修复，不另建第二套取消框架。
- 证据：**代码确定**；未运行真实长命令或中断用户程序。

### RT-03 · P1 · 子任务没有持久会话，重启只能重新委派，不能恢复它的执行现场

- 位置：`app/agent_runtime/subagent.py:95,189,210,215`；`app/fabric/engine.py:1055,1113`。
- 触发：已经执行多步的 `Agent` 中途发生桥接退出、应用重启或父任务中断，随后继续该任务。
- 实际：子任务的 ID、步骤和当前工具保存在局部列表；子 loop 不传 `session`。父会话能看到委派工具及最终摘要，但没有子任务自己的持久消息、operation journal 和可恢复位置。UI 事件中的有限步骤摘要不能替代这些状态。
- 预期/影响：既然子任务属于正式长程能力，已完成的读取和写入不能在恢复时变成只有“曾经委派过”的模糊状态。重新运行会重复工作，写入任务尤为不可靠。
- 修复方向：为每个子任务创建与父任务关联的持久 session，并把委派生命周期和恢复入口接回父任务；复用现有 session / operation 机制。
- 证据：**能力缺口**，已追踪实际 `Agent` 注册与调用方，非“没有子 Agent”的历史问题。

### RT-04 · P1 · 子任务没有压缩器，支持的批量读取会累积到上下文上限

- 位置：`app/agent_runtime/subagent.py:189`；`app/fabric/engine.py:1049,1107`。
- 触发：工具描述明确推荐的调研、批量重构、写测试任务，连续读取较多文件/工具结果。
- 实际：子调用没有 `compactor`、`context_budget_tokens`、`token_estimator`、`tool_result_dir`；这些参数默认都是 `None`。父 loop 的压缩配置不会自动进入这个全新的子 loop。
- 预期/影响：子任务虽然有独立上下文，却没有已实现的长上下文维护能力；多轮输出只会增长，直到供应商拒绝请求或终止。这与 RT-03 的进程间恢复不同，单次不中断运行也会遇到。
- 修复方向：按子模型的真实窗口配置现有压缩器和结果持久目录，保留必要的任务目标/更正/工具结果引用。
- 证据：**能力缺口**；没有用真实模型故意跑满上下文。

### RT-05 · P1 · Read 的全局“已读”缓存把别的 Agent 读过误当成自己读过

- 位置：`app/agent_runtime/coding_tools.py:494,499,1297`；`app/agent_runtime/subagent.py:165`。
- 触发：父 Agent 读过文件，然后让“全新上下文”的子 Agent 读同一路径；或同进程中两个独立 registry 共享 workspace。
- 实际：`_READ_STATES` 只按 workspace root 索引，没有按上下文/session 区分。第二个 registry 第一次 Read 就收到“文件未变，参见之前的工具结果”的 stub，而自己的消息历史里没有那份结果。临时测试第一次返回 `ORIGINAL`，第二次只返回 unchanged 提示。
- 预期/影响：磁盘内容缓存可以共享，但“该上下文已见过正文”的状态不能共享。否则子 Agent 被要求独立定位却没有实际代码，容易猜测、漏检或反复请求。
- 修复方向：将已呈现状态绑定 agent/session；需要共享解析结果时只共享正文缓存，不共享“已读过”的判定。
- 证据：**最小复现**，两个真实 ToolRegistry，同一临时 workspace。

### RT-06 · P1 · 多个 CheckpointStore 顺序运行也会覆盖对方的备份

- 位置：`app/agent_runtime/coding_tools.py:1180,1202,1209`；`app/agent_runtime/subagent.py:165`。
- 触发：父 registry 与子 registry 分别创建自己的 store，随后先后修改同一 workspace。无需毫秒级竞态，也无需并发写文件。
- 实际：序号仅在构造时从 manifest 读一次，随后各对象本地 `+=1`，备份名是同目录下的序号文件。两个对象都从同一旧序号开始，后者覆写前者的 `.bak`。临时验证先备份 `ORIGINAL`、再由第二个 store 备份 `SECOND`，第一次记录对应的恢复结果变成 `SECOND`。
- 预期/影响：Rewind 必须恢复操作前的版本。当前备份索引看似存在，内容却可能已被另一个 store 换掉，属于实际恢复数据错误。
- 修复方向：让 workspace 的备份写入使用同一个所有者/分配器，或在现有 manifest 写入边界原子分配唯一序号。重点是避免已有对象的旧序号，不需要额外哈希系统。
- 证据：**最小复现**，两个 store，顺序操作。

### RT-07 · P1 · Rewind 宣称恢复本会话，实际能撤掉其他会话的改动

- 位置：`app/agent_runtime/coding_tools.py:1173,1216`，Rewind 注册说明 `:1842` 附近。
- 触发：同一 workspace 先后用于两个任务；第二个任务执行 `Rewind(steps=0)`。
- 实际：所有会话都使用 workspace 的 `.mp/backups` 和同一 manifest；记录没有 session 所属信息，restore 按全局序号恢复。临时验证第一 registry 创建 `x.txt`，第二 registry 的 Rewind 将其删除，返回 `removed x.txt (was created by the agent)`。
- 预期/影响：工具说明中的“本会话内”不成立。用户想撤销当前尝试时，可以撤掉已经完成的另一项工作。这与 RT-06 的备份覆盖是两个独立问题：即使序号绝不碰撞也会跨任务撤销。
- 修复方向：记录并按 task/session 隔离恢复范围；若需要 workspace 级历史回退，必须把它作为不同的明确操作展示范围。
- 证据：**最小复现**，两个真实 registry，临时目录。

### RT-08 · P2 · 失败 Patch 仍添加 checkpoint，让“撤销上一步”撤不到最后一次真实修改

- 位置：`app/agent_runtime/coding_tools.py:1435`–`:1447`。
- 触发：先成功 Edit 文件 A，然后 Patch 文件 B 因上下文不匹配失败，再 `Rewind(steps=1)`。
- 实际：Patch 在验证/实际应用前已为目标写 checkpoint，失败后不移除无效记录。验证中 Rewind 报告恢复了本来没有改动的 B，A 仍然是 `changed`。
- 预期/影响：失败操作不应占据一项成功修改的恢复位置；否则 UI/模型认为已经撤销最后修改，实际修改仍留在文件中。
- 修复方向：先解析、准备并验证补丁，确定将实际修改的目标后再建立 checkpoint；失败时不留下未发生操作的恢复记录。
- 证据：**最小复现**。

### RT-09 · P2 · Patch 文档支持的 `Move to` 语法永远进不到解析分支

- 位置：`app/agent_runtime/apply_patch.py:156,159`。
- 触发：使用该模块公开支持的 `*** Update File: a.txt` 后接 `*** Move to: b.txt`。
- 实际：前面的通用 `line.startswith("*** ")` 分支先结束解析，后面的 Move 分支不可达。实际报错：`ApplyPatchError: invalid patch line outside any file hunk: *** Move to: b.txt`。
- 预期/影响：编码 Agent 选择已提供的移动补丁语法后必然失败，导致重试、退回手动 copy/delete，或者无法完成结构调整。
- 修复方向：在通用指令边界前解析 Move 行，并用一条文档格式的移动补丁验证源/目标结果。
- 证据：**最小复现**。

### RT-10 · P2 · Patch 局部改一行会把 Windows 文件的全部 CRLF 重写成 LF

- 位置：`app/agent_runtime/apply_patch.py:432,443`。
- 触发：对普通 Windows CRLF 源码/脚本做局部补丁。
- 实际：`read_text` 先做通用换行转换，写入时显式 `newline="\n"`。临时文件 `first\r\nsecond\r\n` 只改第二行，结果为 `first\nchanged\n`。
- 预期/影响：精确局部编辑应保留未选内容的换行风格。现在会产生整文件 diff，也会改变依赖 CRLF 的现有交付文件。这不是冷门编码输入。
- 修复方向：与 Edit 路径一致，读取时识别并保留文件原有换行约定，避免局部补丁变成全文件格式化。
- 证据：**最小复现**，比较临时文件字节。

### RT-11 · P1 · Bash 将常见写操作分类为 READ，绕过正常写权限判断

- 位置：`app/agent_runtime/coding_tools.py:948,959,976,980`。
- 触发：普通 Bash 调用 `echo hello > a.txt`、`git branch -D work` 或 `git config user.name MP`。
- 实际：命令分类只识别有限操作符和 git 前两个 token；重定向 `>` 未被排除，`branch/config` 作为整体在只读表内。纯分类验证以上三个命令均得到 `Effect.READ`。
- 预期/影响：READ 被用来决定权限、并行和 operation 恢复语义；这些命令真实会改文件或仓库配置。这里不是要求抵抗恶意 shell，而是模型日常能生成的命令被判错。
- 修复方向：只把明确读形式判为 READ，识别重定向以及 git 子命令中写入参数；不能明确判断的沿用现有 local_irreversible 处理。无需建立完整 shell 安全沙箱。
- 证据：**最小复现**（仅分类函数，没有执行这三条命令）。

### RT-12 · P2 · Bash 的持久 cwd 解析无法处理正常带空格目录，也不依据命令实际是否成功

- 位置：`app/agent_runtime/coding_tools.py:1025,1579`。
- 触发：`cd "My Folder"` 后在下一次 Bash 中运行依赖 cwd 的命令；或 `cd` 位于未执行/失败的命令分支。
- 实际：解析使用拆分后的最后 token 再剥引号，带空格目录被截成尾词。临时存在 `My Folder` 时 `_resolve_cd_target` 返回 `None`。调用完成后还无条件把静态解析结果写回 shell.cwd，没有以返回码/实际执行分支为依据。
- 预期/影响：工具承诺的跨调用 cwd 会与用户/模型认为的位置不一致，后续命令可能读错或写错目录。Windows 的常见目录名可直接触发，不是罕见路径。
- 修复方向：正确解析受支持的独立 cd 形式并只在成功时更新；复杂 shell 分支不要推测其 cwd，明确传 cwd 或从受控 shell 回报。
- 证据：**最小复现**（带空格目录）；条件分支问题为代码确定。

### RT-13 · P2 · Bash 真实失败退出仍被登记为成功工具结果

- 位置：`app/agent_runtime/coding_tools.py:1582,1594`；`app/agent_runtime/tool_registry.py:492,516`；`app/agent_runtime/loop.py:2947`。
- 触发：编译器/测试/脚本执行完并返回真正的失败码，例如 build exit 2；不包括 grep 无命中等已明确定义的 exit 1 特例。
- 实际：run_command 无论 returncode 都返回普通字符串 `exit=N`，registry 只把异常视为 is_error，因此结果、步骤和 operation 仍走成功分支。模型或许能从文字理解失败，但 Runtime 的审计和失败计数不理解。
- 预期/影响：失败构建不能作为成功执行记录和有效进展。否则恢复、UI 状态和 guardrails 对同一事实各说各话。
- 修复方向：保留已有“无命中”等合法退出码语义；其余失败通过明确失败结果传给 registry，同时保留 stdout/stderr 和退出码。
- 证据：**代码确定**，没有运行项目构建来制造失败。

### RT-14 · P1 · 压缩源先保留最近内容，下一层却再只取前 48k，最近的更正被无声丢掉

- 位置：`app/agent_runtime/memory.py:39,216`；`app/agent_runtime/compaction_prompt.py:93`。
- 触发：需要压缩的历史超过 48,000 字符；这是长任务文件读取后正常可达的量。
- 实际：memory 可组装最多 160,000 字符，并对超限输入保留头尾；summarizer 随后使用 `history[:48000]`。被压缩段靠后的新要求根本没送给模型，却随整段历史一起被摘要替换。假摘要调用捕获输入恰为 48,000 字符，靠后写入的 `RECENT_CRITICAL_CORRECTION` 不在输入里。
- 预期/影响：摘要模型再好也无法保留没见到的最新更正，任务可能重新采用用户已经否定的做法。主审计另有摘要返回成功协议问题，此条只讨论输入事实丢失，不重复计数。
- 修复方向：统一压缩预算，在选取待替换历史时完成预算控制；显式保留最新更正/目标，不要在摘要调用层再次不透明截头。
- 证据：**最小复现**，12 条长消息和假 ask_text_model。

### RT-15 · P1 · 聊天分页按内容去重，能把不同 native ID 的真实重复消息删掉

- 位置：`app/context_pack/chat_reader.py:302,422,697`。
- 触发：两页边界有同一发言人、同一可见分钟、相同文本的两条真实消息，例如连续发“好的”，但平台原生消息 ID 不同。
- 实际：overlap key 不包含 nativeMessageId，先按内容判断重叠并裁剪，再执行 native ID 去重。最小两页测试 IDs 为 `new` / `old`，最终只保留 `new`。同样的内容 key 还被用于边界稳定判断，可能把两个不同页面误认成同一边界。
- 预期/影响：原生 ID 已能证明它们是两条消息，不能被较弱的内容启发式盖掉；否则“完整聊天记录”会漏消息，消息条数和完整性声明都不可信。
- 修复方向：有稳定原生 ID 时用 ID 判断同一消息和页边界；只有缺失 ID 的记录才走保守内容重叠逻辑。
- 证据：**最小复现**，假聊天分页 provider，无 GUI。

### RT-16 · P1 · Excel 选区 locator 与磁盘读取器的匹配规则不兼容

- 位置：`app/adapters/office_adapter.py:233`；`app/context_pack/document_reader.py:682,701`；桥接 reader 注册 `scripts/conversation_bridge.py:923`、`scripts/selection_bridge.py:2777`。
- 触发：受支持的 Excel 选区，如 `$B$2:$C$3`，后续通过 Context.read 重读本地 xlsx 文档；FrozenSelectionReader 不覆盖的请求也会转到该 reader。
- 实际：Office adapter 的 locator 带 workbook、sheet、带 `$` 的 range；磁盘解析器每个 unit 是单元格 `{sheet, range: "B2"}`，匹配用字典完全相等，没有区域包含/地址标准化。临时 xlsx 的范围读取返回 `empty_confirmed`、0 fragments、complete=False，尽管单元格有值。
- 预期/影响：用户选中一块表格后，Agent 不能把有效选区当空数据；这会破坏精确改单元格之前的取证和验证。
- 修复方向：对 Excel locator 解析规范地址和范围包含关系；工作簿身份在 source 层对齐，不能混进单元格结构的字典全等。
- 证据：**最小复现**，临时 xlsx；调用链已核对。

### RT-17 · P2 · 只有 URL 的聊天附件被标为可读，但注册的 reader 只接受本地路径

- 位置：`app/context_pack/chat_reader.py:529,545`；`app/context_pack/document_reader.py:59`；`scripts/conversation_bridge.py:923`–`:926`。
- 触发：聊天平台返回一个有附件 URL、尚无本地下载路径的文件，模型 Context.follow 后尝试 read。
- 实际：chat reader 以 `path or url` 决定 readable，并给出 read/search/follow 能力，source.kind 是 document/file；实际这两个 kind 都走 DocumentReader，后者必须有 absolutePath/path，只有 URL 必然失败。现有 BrowserReader 不是任意附件 URL 的读取器，也不会自动接管这个 kind。
- 预期/影响：系统给模型展示了不能执行的能力，附件会在用户最需要进一步阅读时断链。
- 修复方向：有现成下载/解析路径就先解析到可读 SourceRef；尚不能下载的附件如实标记待解析，不虚报 read 能力。
- 证据：**代码确定**，未访问真实附件 URL。

### RT-18 · P2 · Context.search 的 reader 错误被包进成功工具结果

- 位置：`app/context_pack/tools.py:139,160`；`app/agent_runtime/tool_registry.py:516`；`app/agent_runtime/loop.py:2958`。
- 触发：搜索一个文件已不存在、格式不支持或读超时的 source，reader 返回带 evidence_status=error/unsupported/timeout 的 ReadResult。
- 实际：Context.read 会把上述状态转为 ActionFailure；Context.search 没有这个处理，直接把结果字典装进 results 后返回。registry 将其标为成功；loop 只识别顶层 Evidence 对象，无法识别此嵌套字典。
- 预期/影响：搜索未执行成功与“成功但零匹配”必须区别；否则 UI、operation 和失败重试策略记录错误，模型也更容易把证据缺失当作没有结果。
- 修复方向：全失败搜索返回明确工具失败；多源混合结果保留每源错误并返回部分成功状态。不要把 genuine empty 当错误。
- 证据：**代码确定**，与同文件 read 路径对照。

### RT-19 · P2 · Read 的单行截断没有可到达的续读位置

- 位置：`app/agent_runtime/coding_tools.py:77,96`。
- 触发：读取单行超过输出字符上限的普通 JSON、生成 HTML、minified JS 或日志记录。
- 实际：Read 的分页只有行 offset/limit；第一行太长时切掉尾部，提示减小 limit/调整 offset。但 limit 最小也是一行，offset 跳到下一行只会跳过尚未读取的字符。即使显式提高行 limit 获得较大字符上限，超长单行的尾部仍不可取回。
- 预期/影响：Read 应对已授权文件提供完整可达的读取方式，不能把普通大文件的一部分永远藏在分页接口之外。
- 修复方向：为截断的单行提供字符 continuation/offset，或返回能直接读取该段的持久结果引用；不需要无限放大每次结果预算。
- 证据：**能力缺口**，代码路径确定；不把大型文件本身当异常输入。

### RT-20 · P1 · 不确定结果的恢复屏障没有解除路径，用户重新确认后仍永久挡住相同动作

- 位置：`app/agent_runtime/loop.py:1810`–`:1845`；`app/run_kernel/projection.py:28` 起的恢复策略投影。
- 触发：一项写操作已经留下 VERIFY_BEFORE_RETRY / NEVER_REPLAY 的不确定结果；用户检查外部结果，确认未生效并明确要求再执行相同参数。
- 实际：每次调用都遍历历史 operation，只要工具名和参数与任何一个旧的未解屏障相同，立即拒绝。该分支不消费新确认/验证结果，也没有现有事件将旧 operation 的恢复要求标记为已解决。提示“先读回再用新确认动作”后，照做也仍会匹配旧记录。
- 预期/影响：防止自动重复是对的；阻止显式、检查后的恢复则会把支持的长任务永久卡住。改一个无关参数绕过屏障不是正确恢复方式。
- 修复方向：在已有 operation/session 机制中加入明确的恢复处置结果；由检查结果和当前确认满足旧屏障，保留旧审计记录，但不再永久拒绝。
- 证据：**能力缺口**；读取投影和调用前门禁，检索现有恢复事件/调用方未发现闭环。

### RT-21 · P1 · pre-tool hook 修改了实际参数，journal 和 effect 仍记录修改前的参数

- 位置：`app/agent_runtime/loop.py:1891,1920,1929,2644,2846`。
- 触发：项目支持的 pre-tool hook 对工具输入进行替换，例如将 target 从 before 改为 after；工具 effect 随参数变化。
- 实际：调度/operation prepared 使用原始 call；`_execute_one` 内部才采用 hook 的 pre.input。settled 和验证仍引用原始 call/effect。用真实 loop + 假模型 + 一个测试工具验证：实际执行 `['after']`，journal arguments 为 `{'target': 'before'}`，effect 仍是 read，而 after 的工具声明 effect 是 reversible_write。
- 预期/影响：操作日志不能指向没执行过的目标；权限、并行调度和恢复也不能依据另一组参数。即使 hook 本身可信，这仍是参数变换后的确定性状态错误。
- 修复方向：在 prepared/权限/调度之前完成 hook 参数变换，并对实际调用重新计算 effect；原始模型参数可单独作为输入轨迹记录，不能冒充实际执行参数。
- 证据：**最小复现**，真实 loop/session，假模型和无副作用 Fixture 工具。

### RT-22 · P1 · 后台任务的完成回执依赖短命桥接中的 daemon 线程，跨轮就可能丢失

- 位置：`app/agent_runtime/coding_tools.py:1088`–`:1118`；`scripts/conversation_bridge.py:1315,1385,1390`；`app/harness/builtin_bundle.py:1204`–`:1207`。
- 触发：Bash(background=True) 启动一个正常长任务，模型随后完成本轮；后台任务在这轮 Python bridge 退出之后才结束。
- 实际：记录退出码、完成时间、向 durable inbox 发消息的唯一 watch 在线程 `daemon=True` 中。conversation bridge 是一次 read payload → answer → write result → SystemExit；正常结束不等待 daemon。后台进程可以继续写 log，但完成回执的写入者已经消失。后续 BashRead 只由 PID 是否存活推测 FINISHED，拿不到退出码，inbox 通知也不会补发。
- 补充接线证据：Studio 的 `boot_loop_context` 为 coding-tools 只传 workspace_root，没有传 runtime.session_inbox；只有 resident 的 `_run_loop_rows:1059` 接了 inbox。因此 Studio 即使后台任务在桥退出前完成，也没有完成消息回到 durable inbox。
- 预期/影响：工具文字声称“loop 已结束则随会话留到下一次运行，不丢”，但进程边界使这个保证不成立。后台构建/测试完成后无法可靠区分成功失败，也无法自动续接工作。
- 修复方向：由生命周期更长的进程管理后台任务，或让任务包装进程自行持久写入结束状态，再由现有 Runtime 收取完成事件。无需为此另造全局调度服务。
- 证据：**能力缺口**，已核对实际单请求桥接 main；未启动后台命令或 GUI。

## 本轮最小验证记录

运行前的判断：这些验证分别回答“新上下文是否真读到了代码”“备份能否恢复原版本”“接口声明的定位/移动能否完成”“原生 ID 是否被保留”“摘要是否收到最近更正”“实际参数和审计参数是否相同”。若验证否定上述怀疑，就删去该发现或降为未验证缺口。不是为了给审计增加泛化检查数量。

验证方式为 PowerShell 传入内联 Python，临时目录由标准库自动清理。没有持久更改测试套件。关键实际输出：

```text
independent_registry_read: first=ORIGINAL; second=unchanged stub
checkpoint_two_handles_restore: SECOND (expected ORIGINAL)
patch_move: ApplyPatchError invalid patch line outside any file hunk: *** Move to: b.txt
quoted_cd_persistence: None
shell_effect 'echo hello > a.txt': read
shell_effect 'git branch -D work': read
shell_effect 'git config user.name MP': read
xlsx_range: empty_confirmed fragments=0 complete=False
compaction_source: 48000 recent_correction_preserved=False
chat_duplicate_native_ids: [('okay', 'new')] (expected both old and new)
child_model_budget_ms: [3998.4584000194445]
child_result_error: False
other_task_rewind: restored removed x.txt; x_exists=False
failed_patch: True; rewind1: reverted b.txt; a=changed
patch_crlf: b'first\nchanged\n'
hook_actual: ['after']; journal_args={'target': 'before'}; effect=read
```

一次 compaction/chat 验证脚本最初漏传测试用 AgentMessage 的必需字段，脚本构造失败；补齐后重跑得到了上面的结果。这是审计脚本问题，没有当成产品问题。

未运行全量测试、类型检查、构建或 sync：这是只读审计加文档交付，没有修改产品；这些检查不能替代此处具体失败的证明，也不会改变上述判断。本文不声称全部已有测试通过。

## 阅读覆盖：全文、分段与未读明确区分

### 全文阅读

- `docs/design/MAGIC_POINTER_HARNESS_20260811.md`：分块读到末尾，对被输出截断的块补读；含当前正文和进度账本。
- `docs/2026-08-19-LONG_RUN_CAPABILITY_GAP.md`。
- `app/agent_runtime/subagent.py`
- `app/agent_runtime/coding_tools.py`
- `app/agent_runtime/session.py`
- `app/agent_runtime/tool_registry.py`
- `app/agent_runtime/tool_scheduler.py`
- `app/agent_runtime/compaction_prompt.py`
- `app/agent_runtime/memory.py`
- `app/agent_runtime/resume_context.py`
- `app/agent_runtime/turn_verification.py`
- `app/agent_runtime/tool_guardrails.py`
- `app/agent_runtime/permission_modes.py`
- `app/agent_runtime/apply_patch.py`
- `app/agent_runtime/hooks.py`
- `app/agent_runtime/skill_catalog.py`
- `app/agent_runtime/slash_directory.py`
- `app/context_pack/tools.py`
- `app/context_pack/source_scope.py`
- `app/context_pack/source_store.py`
- `app/context_pack/document_reader.py`
- `app/context_pack/selection_reader.py`
- `app/context_pack/chat_reader.py`
- `app/context_pack/browser_reader.py`
- `app/harness/plugin.py`
- `app/harness/builtin_bundle.py`
- `app/harness/context.py`
- `app/harness/composition.py`
- `app/harness/runtime_host.py`
- `app/harness/services.py`
- `app/harness/extension_paths.py`
- `app/harness/extensions_inventory.py`
- `app/harness/__init__.py`
- `app/agent_runtime/permission_decisions.py`
- `app/agent_runtime/permission_presets.py`
- `app/agent_runtime/inbox.py`
- `app/agent_runtime/effort.py`
- `app/agent_runtime/session_id.py`
- `app/agent_runtime/workspace_state.py`
- `app/agent_runtime/usage_cost.py`
- `app/agent_runtime/context_projection.py`
- `app/agent_runtime/memory_tools.py`
- `app/agent_runtime/model_profiles.py`
- `app/agent_runtime/next_prompt.py`
- `app/agent_runtime/skill_usage.py`
- `app/agent_runtime/skill_writer.py`
- `app/agent_runtime/todo_store.py`
- `app/agent_runtime/ask_todo_tools.py`
- `app/agent_runtime/tool_discovery.py`
- `app/agent_runtime/token_estimate.py`
- `app/agent_runtime/errors.py`
- `app/agent_runtime/wait_tool.py`
- `app/agent_runtime/__init__.py`
- `app/context_pack/capture_policy.py`
- `app/context_pack/intent.py`
- `app/context_pack/initial_evidence.py`
- `app/context_pack/daily_wrap.py`
- `app/context_pack/runtime_document_smoke.py`
- `app/context_pack/__init__.py`
- `scripts/selection_worker.py`
- `app/run_kernel/projection.py`
- `app/governance/latency_budget.py`

### 阅读了正文片段和相应调用链，不能记作全文

- `docs/STATUS.md`：当前最新记录、前部状态及与本分区相关条目；没有逐行读完全部历史。
- `PRD.md`：前 240 行产品/数据契约；其余未在本分区完整读完。
- `app/agent_runtime/loop.py`：约 840–1149、1465–1985、2540–2895、2935–3000；其余通过符号/调用点检索，未全文。
- `app/agent_runtime/model_client.py`：前 180 行及相关预算调用点。
- `app/fabric/engine.py`：run_agent_turn 完整入口约 1027–1135，其余未全文。
- `app/context_pack/sources.py`：前 110 行及验证使用的类型接口。
- `app/adapters/office_adapter.py`：211–246 的 Excel 选区 locator。
- `scripts/conversation_bridge.py`：reader/Runtime 配置调用点、末尾 main 完整。
- `scripts/selection_bridge.py`：reader/Runtime 配置调用点、2851–2972 的完整 runtime 字典和 boot 选择。
- `tests/agent_runtime_loop_test.py`：前 110 行测试夹具。
- `tests/conversation_bridge_test.py`：1201–1285，针对主审计发现的测试失败核查 fixture。
- `tests/selection_bridge_test.py`：1061–1125，同上。

### 未读范围与边界

本分区没有声称“已经读完项目所有文件”。未列为全文的其他 runtime/harness/fabric/context_pack 文件、相关测试的大部分内容，均未逐行完整阅读；图形 UI、模型传输、artifacts/actions/lease、安装交付等由主审计或其他分区负责。本文件中的分区发现数量不能代替全项目阅读覆盖率。

没有读取参考项目、`_sv_sources`、`fast-jev-compaction-*` 或其他外部项目；Jev 模型接入与本地模型包由主审计单独处理。本分区也没有重复计入 Computer Use Click/Type/Key 的固定 effect 问题、ai_client 摘要成功协议问题、DocumentPatch 逆操作 consumer 缺失等其他分区认领项。

## 建议修复顺序

先处理 RT-05/06/07/14/15/16/21 这组会让实际证据、修改或恢复记录失真的问题；其次打通 RT-01/02/03/04/20/22 的子任务、中断和持久恢复；再处理 Patch、Bash 和工具状态的一致性。更强模型可以提高规划与视觉识别，却无法自行修好错误的 locator、丢失的历史、被覆盖的备份和不真实的 operation journal。接入 Jev 时应复用这些确定性的 Runtime 契约，而不是让模型推测它们。
