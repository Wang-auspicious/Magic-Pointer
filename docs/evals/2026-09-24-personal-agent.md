# Personal Agent Runtime 实施与验收

日期：2026-09-24。版本保持 **1.0.63**。本文记录本批真实结果及其边界；运行原始记录保存在执行本批验收的工作树的忽略目录 `data/runtime/`，不把凭据或用户资料提交到仓库。下文原始记录路径相对该工作树，其他 checkout 只同步本报告与可复跑脚本。

## 交付内容

本批沿用 MP 自有 Runtime、EventSession 和工作台，没有新增 Agent loop 或任务数据库。

- **工具与上下文成本**：首轮只加载当前任务需要的工具，其他能力经真实工具目录发现；普通文件元数据不再被误认成屏幕圈选。超过 6,000 字符的工具结果向模型投影为短片段和 `ToolResult.read` 续读入口，完整原文留在持久日志。请求日志、压缩预算和实际发送的投影一致，记录系统、工具、状态、材料和历史的估算分布，Provider 缺报字段继续保留缺失语义。
- **逐目标完成**：回执记录具体操作、目标、结果和验证方式；同一文件的不同编辑不能互相覆盖失败，复合桌面动作逐项结算。桌面后置验证绑定调用、动作序号、窗口、进程及动作前状态；输入成功不证明消息已经送达。未完成计划、未核对写入和未知结果保持可继续状态。同一会话普通续问保留上一份未完成回执的结果；成功后才从下一任务边界重新结算。此处采用保守语义，全新的独立工作宜新建任务，避免旧欠账被自然语言消息隐式抹掉。
- **有效进展**：跨工具重复读取同一事实、换参数继续遇到同类失败不会无限刷新任务期限。正常重复按键不被第四次机械截停；新事实、实际写入或明确外部条件的本地等待才能形成有效进展。
- **后台与恢复**：纠正进入原子任务 inbox，撤销尚未执行的旧权限请求并重新判断；停止等待中的子任务会通知父任务。崩溃后的待决定事项只能回答原 requestId，再显式恢复。来源恢复检查当前文件、版本及冻结像素是否仍可用。Windows 后台状态原子替换对瞬时 EPERM/EBUSY 做有限重试，其他错误继续暴露，并保留独立 stderr。
- **桌面让路**：聚焦与物理输入共用桌面所有权和用户空闲检查；忙碌时产生可恢复等待。长输入期间检测实际用户接管，释放按键并中断，已经开始的动作不被标成“未执行”。
- **文件精确修改**：Read 返回实际字节/BOM/换行事实；Edit 按原始字节位置替换并读回，保留未选内容与混合换行；Rewind 核对恢复后的字节或删除结果。实际 workspaceRoot 进入 Context/Wait 权限范围；原来未注册的 wait 接回 Runtime，显式本地等待可跨小时且可取消。
- **文档工具契约**：真实模型连续三次使用错误补丁字段后，补齐 `Document.propose_patch` 的操作结构、必需字段、现有操作类型和定位器说明；校验仍拒绝错误别名。工具示例使用 B7 的 5→8，独立验收使用 B2 的 120→210。

## Python → TypeScript 的产品缺口

本批恢复有实际消费者的终端当前命令、窗口与已观察退出码；终端 UIA 宿主 PID 不同时仍须匹配精确窗口身份，原始 buffer 不进入模型上下文，凭据文本脱敏。多个覆盖目标的结构化来源两两核对，而非只比较前两项；OCR busy、timeout、unsupported、error 保持真实状态，圈选外文字不计为成功读取。这些信息贯通感知、InputArtifact 和 `Context.read`。

迁移审计中已由产品明确移除的语音、日历、购物、图库，以及无当前消费者的 recorder、PointerBench、旧隐式 Git 扫描，没有机械搬回。浏览器网络/控制台诊断、能力快照的详细 repair 解释、交互账本聚合、公开 append 的全部旧写入约束仍未恢复；当前任务链没有证明这些是本批交付所需。Figma 真插件与 macOS 不在本批已验收范围。

## 真实模型与原生结果

模型为 `deepseek-v4.1-flash`，Provider host 为 `opencode.ai`，chat-completions，effort=high。以下真实模型结果经过 MP 编译后的 worker；Pi 仅用于用户要求的同口径对照。

| 场景 | 实测结果 | 证据边界 |
| --- | --- | --- |
| 跨两文件读取 | 正确，8.124 秒、2 次模型请求 | 保留原件，答案满足案例条件 |
| 同两文件精确编辑 MP/Pi | 修复后均 3/3 正确；MP 未缓存输入加输出中位数 3,272，Pi 2,765，比值 **1.183**；耗时中位数 12.10 / 17.31 秒 | 首对使用较早的编辑修复构建，后两对使用共享最终构建；小样本不代表总体成功率或账单价格 |
| 显式转发消息与两版报价 | 13.470 秒、4 次请求；采用最终版 USD 150 / Friday，生成可编辑草稿，三份原件不变，没有发送动作 | 使用合成转发材料，不是微信/钉钉原生完整会话验收；模型明确缺少此前聊天 |
| 文件关注触发草稿 | 真实 fs.watch 变化后 11.581 秒完成正确的 210 / Tuesday 草稿；一次变化一个任务、无变化静默、停用后不触发 | 使用现有任务输入绑定及 Runtime，没有模拟模型输出 |
| 后台独立进程、纠正与恢复 | 启动器退出后子任务继续；A→B 纠正使 A 保持不存在；同会话恢复后精确 B 字节为 `MARK_B\r\n` | 初次生成多了一个空格，且在 Provider 请求中途 worker 意外退出，根因未证实；原失败保留，后续 Read/Edit 纠正 15.327 秒，无新审批 |
| 真实终端感知 | 临时 PowerShell 控制台捕获→UIA→perceive 成功，`uia:terminal_buffer`，精确窗口，已打印退出码 8，秘密文本脱敏 | 8 是屏幕所见命令退出信息，不是验收进程退出状态；全程未把 raw buffer 发给模型 |
| Windows OCR | 中文默认语言识别测试数字 4821，5 个文字块，801ms | 英文字符并非全部准确；本机 en-US 不可用如实返回 unsupported |
| 原生 Excel 精确修改 | 独立隐藏未保存工作簿 B2 从 120 改到 210，C2 不变，Saved=false、Visible=false；独立 COM 核对 | 先完成的是实际生产 Backend / live reader 验收，不含模型决策或物理手势；模型链结果另行记录 |
| 普通自然语言→模型→原生 Excel | 真实模型 27.240 秒、首次补丁提案正确；Artifact 接受/应用 9.515 秒，独立 COM 回查 1.593 秒，总计 48.085 秒。唯一 B2 从 120→210，C2 未变，仍隐藏且未保存、没有生成磁盘文件 | 使用最终结算和工具 schema 的隔离编译，未干扰一小时 worker；任务只含一句普通修改要求，不提供内部操作字段 |

修复前 MP/Pi 对照为 2/3 与 3/3。失败是模型在已完成文件编辑后继续请求非必要 shell 编码探针的权限，未将此轮计作成功，也未放宽权限。修复前三次（含失败）的未缓存输入加输出总量为 MP 11,314、Pi 8,883。修复改为提供足够的实际字节事实和编辑读回。修复后三次总量为 MP 10,637、Pi 8,290；冷缓存与热缓存如实记录，没有将缓存读取算成零成本账单。

原始报告索引（相对仓库根目录，本机）：

- `data/runtime/personal-agent-acceptance/eval/report.json`
- `data/runtime/personal-agent-acceptance/paired-comparison/fixed-three-summary.json`，其引用的修复前 `run-o9OGDa/report.json` 保留。
- `data/runtime/personal-agent-acceptance/forwarded-real/report.json`
- `data/runtime/personal-agent-acceptance/tracker-real/report.json`
- `data/runtime/background-evals/eeced5c9-e5a4-4640-a63d-c9f14e218922/report.json`
- `data/runtime/personal-agent-acceptance/perception-native.json`
- `data/runtime/personal-agent-acceptance/excel-native.json`
- `data/runtime/personal-agent-acceptance/native-excel-model/run-LHbbbb/report.json`

可复跑入口：`scripts/eval-file-harness-comparison.ts`（同文件 Pi 对照）、`scripts/eval-background-agent.ts`（真实后台进程）、`scripts/accept-native-excel-model.ts`（模型及独立 Excel）、`scripts/accept-long-run.js`（实际至少一小时）。使用项目已配置的模型，不在脚本或报告中写入密钥；原生 Excel 脚本在发现已有 Excel 进程时拒绝创建测试实例。

## 跨小时与模型办公验收

跨小时验收于 2026-09-23 16:58:24 UTC 开始，实际 **3,619.584 秒（60 分 19.584 秒）** 后通过。独立外部进程在 3,610 秒后才创建 release.txt；MP 使用本地 wait，不靠模型循环轮询。首次等待 90 秒后终止 worker，在同一持久会话加入“A 是参考，只改 B”的纠正，再恢复等待。最终 A 字节未变，B 仅 Quantity 从 100 改为 314，48 字节与 CRLF 保留，receipt=succeeded、hasPendingWork=false、进程 exit 0。

全会话只有 **7 次模型请求**，外部事件到达前为 3 次。独立操作账本核对发现仅一次 Edit，目标为 B.txt，发生于 release.txt 到达约 5.2 秒后；没有提前写入，也没有修改 A。证据为 `data/runtime/personal-agent-acceptance/long-run/2544ea5c-1f17-4d6d-add2-874a16f2d0a0/report.json` 及其中 `postRunVerification`，保留实际运行的核心 JS 哈希。这证明真实跨小时等待、同会话进程恢复、纠正与精确文件修改，不等于 PC 重启或任意长 GUI 任务验收。

该长任务启动后保持原构建不变；等待期间补充的收尾 Steer、结果结算和 Studio 状态边界另经源码、隔离编译与 GUI 检查。最终构建统一包含全部修补，没有声称最终每个 JS 字节都重新跑过一小时。

模型→Excel 的第一次尝试因提案字段错误而失败，保留在 `native-excel-model/run-PiOJRH/`；给出内部参数后的成功尝试保留在 `run-PTOUBK/`，没有将其当作普通用户任务通过。随后修复生产工具 schema，以一句“请只把当前绑定的 Excel 工作簿 B2 的数值从 120 改为 210，C2 保持不变”完成 `run-LHbbbb/`。日志确认 seq15 的 Context.read 已从原生当前工作簿取得 B2/C2 事实，seq22 才提出唯一精确补丁；脚本严格核对提案后，经生产 Artifact accept/apply，再用独立 COM 核对。测试实例仅按自身 HWND/FullName 关闭，已有用户 Excel 会导致脚本拒绝启动。

## 检查与安装

本批执行与修改风险直接相关的 25 个测试文件、102 个 Node 条目。首次 100 通过、2 失败：一次真实 Windows 状态读写造成 EPERM 原子重命名失败，增加有限重试后后台相关两例通过；另一处旧测试期望缺少新增 `lastReceiptStatus:null`，修正期望后通过。没有声称对最终源码重新跑过完整 102 项或全仓套件。逐目标结果、工具投影、文件字节、来源恢复、子任务纠正、桌面等待及原生复合动作各有对应的行为见证。

最终审查又补了收尾期间插话、Stop 撤销旧审批、崩溃审批在界面的可见性，以及续问保留未完成结果、普通读回不覆盖失败、外部效果的证据范围、取消计划不等于交付。更新后的结果结算 17 个场景通过；新增 schema 与后台生命周期定向检查、对应类型检查和 lint 通过，后续构建验证单独记录。

隔离编译产物的三项后台协议检查通过：收尾 Steer 消费纠正并发起第二次请求；Stop 后 pendingInput=null 且无可执行旧批准；崩溃审批保留原 requestId，答复仅保存。记录在 `data/runtime/personal-agent-acceptance/background-recovery-check-1790184318287/report.json`，使用明确的模型 fixture，不计为真实模型或 GUI 通过。Studio 保留这些真实终态，将部分完成、待核对与待恢复放入 Needs attention，未知状态不再默认显示 Completed。

同一隔离目录进一步编译 browser-globals/renderer 并复制静态资源，`studio_decisions_ui_test.js` 的真实离屏 Chromium DOM/点击探针通过：崩溃待批卡可见原请求、答复仅保存且 normalSends=0、partial 显示 Partially complete 并位于 Needs attention。证据为 `data/runtime/studio-decisions-20260921/witness.json`。这是实际渲染与交互检查，依赖明确的任务/模型 fixture；不是人在桌面上物理点击的验收。

相关 Electron/renderer/tools/tests TypeScript、全部变更 JS/TS 的定向 ESLint、最终 Electron 构建通过。最终构建首次在验收脚本的跨目录类型引用处失败；将脚本改为动态读取已编译模块并使用本地接口签名后，scripts-build 检查及完整构建通过，没有放宽 rootDir 或跳过检查，源码目录也没有误发射文件。

一小时任务结束后统一构建并同版同步安装有效负载，**389 个文件逐字节一致、desktop_host.cs 一致、版本 1.0.63**。最终编译的 9 个关键 Runtime/Studio 文件也与已通过模型、后台协议及 GUI 验收的隔离编译一致。再次用安装目录实际 EXE 完成包 smoke：Node 24.17、模块导入、四类文档读回、29 个桌面工具、原生宿主编译/ping、隔离 GUI 启动和退出通过。证据为 `installed-final.json` 和 `installed-package-smoke.log`（位于 `data/runtime/personal-agent-acceptance/`）；原安装有效负载保留备份。此次为本机同版有效负载交付，没有生成新版安装器或发布新版本。

本批不宣称覆盖真实微信/钉钉全会话、任意 Windows 应用、Figma 原生插件、macOS、混合 DPI 物理手势，或人在同时打字时的完整接管体验。协议检查、真实模型、原生应用读回和安装版验证分别记录，互不替代。

逐目标回执核对的是已记录操作及其证据，不是任意自然语言要求的完整语义判定器。没有操作的正常回答仍标记 `response_completed`；这不能单独证明用户要求的文件修改已经发生。因此真实验收另以指定文件/对象、未选邻区及最终字节判定，不能用模型的“Done”或 Runtime 协议成功替代实际结果。
