# Magic Pointer 代码审读与修复记录 · 2026-09-18

用户本轮要求：阅读产品文档与代码、沿途修复真实问题，不跑完整测试。途中明确取消 Jev 集成；取消时没有任何 Jev 专属代码落地，本轮没有新增模型 API、密钥配置或模型依赖。

## 产品与审读方法

MP 的生产主线是自有桌面 Agent Harness：手势冻结历史画面，结构化与像素证据汇合成任务材料；自己的 Runtime 使用材料、工具和任务账本持续工作；局部修改经过当前目标与版本检查，输出可编辑产物和真实回执。对接其他客户端只是交付渠道。

本轮按上述调用链追代码，关注实际使用中会让用户觉得“没看懂、漏材料、改错对象、没停下来、假完成”的接缝。保留开始时工作树中已有的大量未提交改动。测试仅用于证明指定失败及其修复，不以全量通过替代产品验收。

“完整过一轮”在此记录为跨模块调用链审读；**不能把本轮覆盖冒称为全仓每一个文件、每一行已经审计无缺陷**。下方分别记录实际覆盖、修复和未验证边界。

## 已复现并修复的材料问题

| 问题与触发 | 修复位置 | 行为证据 |
|---|---|---|
| 冻结选区命中占用一个位置，但全文搜索仍按整个 limit 推进游标；合并后截断会漏正文，续页又重复返回选区 | `app/context_pack/selection_reader.py` | limit=1/2 逐页读取都完整得到选区和三条正文；不漏项、不重复插入选区 |
| 没有后续 reader 时，请求另一页却把原选区文字换上新 locator 返回 | 同上 | 第1页的冻结材料不能伪装成第37页；返回 unsupported、空片段与明确缺口 |
| 目录结果用排序数组下标当身份；新增或删除一个文件后，follow 旧结果打开另一个文件 | `app/context_pack/document_reader.py` | 新增前序文件仍跟随原文件；删除原文件后不跟随占据旧下标的替代文件。目录片段和子来源使用真实条目名 |
| 指定文档 locator 后先返回前邻居，小 limit 时目标本身不在结果中 | 同上 | Word 目标段落在第一页首先返回，后续游标仍能取得前后上下文 |
| 一个文本单元超过 16,000 字符时永久截尾，却返回 complete=true、无继续游标 | 同上 | 单行长 JSON 按游标完整重建原文；第二片的 locator 可直接读回，保留字符偏移 |
| 第27个 Context.bind 把标签再次设成 Z，触发重复标签错误 | `app/context_pack/tools.py` | 保持与 Electron 相同的 A…Z、AA…标签规则 |
| 聊天扫描取得多条消息后只返回 limit 条，却宣称完整、不给剩余结果游标 | `app/context_pack/chat_reader.py` | 已取得消息在任务 reader 中分批交付，续读不重复滚动界面；游标绑定来源与查询 |
| Context.read/search 被统一声明可并行，但聊天 reader 实际会操作公共界面滚动历史 | `app/context_pack/tools.py` | 聊天读取走串行调度；独立文件/文档读取继续允许并行 |

相应回归集中在 `tests/source_reader_audit_test.py`、`tests/chat_pagination_audit_test.py`，并运行相邻的 document/context/chat 行为测试。测试使用临时材料、真实 SourceReader、真实 ToolRegistry/EventSession；聊天窗口由明确的 viewport fixture 提供，不伪称真实微信验收。

## Runtime、感知和桌面动作

| 问题与触发 | 修复位置 | 结果与边界 |
|---|---|---|
| 已验证过一次写入，后续未验证写入仍继承已验证；canonical Click 与别名语义不一，普通观察也被当验证 | `app/agent_runtime/turn_verification.py`、`loop.py` | 每次写入使旧验证失效；普通 Observe/get_app_state 只提供观察。注册工具 → Loop → durable receipt 的回归覆盖真实契约 |
| Key/Scroll/Drag/Act/Select 等仅执行成功也返回 matched，反而真正 act_ui 条件命中没有映射到验证门 | `app/desktop_actions/session.py` | 在返回源头把输入成功标为验证 unavailable；明确后置条件的 found 映射 matched/status。仅配置 timeout 或空 text 不算后置条件。SetValue 的真实读回仍算验证。规范名、别名、原生/键盘路径和 postcondition 正反例均覆盖 |
| 恢复后把工具名换成 canonical/alias 就能绕过不可重放或先验证再重试屏障 | `loop.py` | 屏障两侧使用 registry 的 canonical name；相同参数、双向别名均不能再次进入执行体 |
| durable Stop 被第一项工具单次消费，后续工具与模型继续；多次取消错误又误成 STALLED | `loop.py` | 每次运行独立锁存取消；整批 prepared 操作先结算，然后以 USER_INTERRUPT 结束，不继承到下次运行 |
| fork 原样重放父 taskId，带计划/材料/structured inbox 的公开 API 无法成功创建可用 child | `app/agent_runtime/session.py` | 只重绑定 child 的任务身份与相应消息投影，保持材料、文档、引用、权限限制和父谱系；子会话可 resume，父日志不变。当前产品入口未调用该 API，未把此项夸大成已有 GUI 故障 |
| Wait 即时满足也声称耗时 20 秒；元素超时误报窗口过滤条件 | `app/agent_runtime/wait_tool.py` | 使用实际 monotonic 差值，超时正确标识 element_text；三项失败见证后，相关 9 项通过 |
| 金额120/1200、正负金额、两字段交换数字被子串/相似度判成一致 | `app/perception/fusion.py` | 先比较数值，并保持正负号和出现次序；正常同数值 OCR 噪声仍能汇合 |
| 第二阶段只重建 selected context，却把第一阶段冲突和佐证覆盖为空 | `scripts/selection_bridge.py` 的 `_fuse_pixel_tier` | 合并并去重已有和新增关系；保留冲突进入 InputArtifact 的完整接缝 |
| OCR 有文字却没有几何时，被丢成 empty_confirmed 或当覆盖用户标记 | `pixel_ocr.py`、`providers.py`、`input_artifact/schema.py` | 保留未定位文字，明确 degraded、coversMark=false、unlocated_text，不冒充 selected_text |
| SetValue 只凭原生调用返回就标结果已验证 | `app/desktop_actions/session.py` | 读回相同才 matched；无法读回如实 unavailable |
| RangeValue 可写但读回只支持 ValuePattern | `app/desktop_actions/uia.py` | 原生 RangeValue getter 返回 double 并验证同一数值；HRESULT 失败不转成成功 |
| snapshot 中 name/value 被展示层截到80字，深读与完整值等待都丢尾部 | `app/desktop_actions/session.py` | snapshot 本地保留原始文本；read_text 仍读指定历史状态，wait_for 使用新观察原文，默认 outline 仍有界 |
| 坐标落到目标窗口外，或窗口内部坐标实际被另一窗口覆盖 | 同上 | Click/Scroll/Drag 等物理输入检查目标边界与 window_at，Drag 两端先校验；原生 UIA 操作不伪装物理点击 |
| Key、无 index Type、Select 键盘后备路径可能输入当前另一个窗口 | 同上 | 使用已有前台窗口探针核对目标；失败提示先 Focus 再 Observe，不自动抢焦点 |
| ActionFailure 中明确给出的恢复步骤在工具边界丢失 | `app/agent_runtime/tool_registry.py` | 将 recovery_hint 保留在模型可见错误中，保持原 failure type/backend/timing，已在正文的提示不重复 |

## 模型配置、Studio 和重启

| 问题与触发 | 修复位置 | 结果 |
|---|---|---|
| 合法 defaultMaxTokens 被含 token 的密钥检查拒绝 | `app/models/profiles.py` | 允许该明确非秘密字段，实际模型配置可回读；密钥禁存约束不变 |
| Electron 保存 profile 时丢掉显式 models 目录 | `electron/settings_store.ts` | 真实 load/save/runtime resolve 保留目录 |
| Python 模型设置写回时丢掉 Electron 支持的 stash/context_trackers | `app/fabric/settings.py` | 在真实模型保存路径保留这两项 |
| 普通 Studio 完成前没有持久 turn，失败丢用户问题、session、部分成果 | `electron/main.ts`、`conversation_store.ts`、`scripts/conversation_bridge.py` | 请求前落任务占位，流式保存实际文本与轨迹，终态更新原 turn；失败/异常和强制停止保留身份与可续状态 |
| 失败响应先 throw 才绑定 conversationId，重试丢任务；有部分答案时隐藏错误 | `electron/renderer/studio.ts`、`dsh_chat.ts` | 先保留任务身份再展示失败；部分答案和实际错误分别显示，LiveCards 使用 error 字段 |
| `/model` 只改 legacy 文件，活动 profile 不变，下一次请求仍旧模型 | `electron/main.ts` | 命令和菜单共用 selectRuntimeModel；下一次实际 bridge payload 使用新模型，并保留被中断任务 |
| 运行中退出应用后磁盘占位永远“进行中” | `main.ts`、`conversation_store.ts` | 首次建立 store 时把旧运行轮次标“可恢复”，保留文本、轨迹、回执、时间及 task context；不捏造完成时刻或物理动作终止。该进程新任务不受影响 |

测试全部在相应生产修改前观察预期失败。测试替身、真实磁盘 store/bridge 和原生验收在下方分开列出，不将 fixture 等同于真实模型/办公应用结果。

## 实际覆盖

主审全文阅读：`app/perception/fusion.py`，`app/context_pack/{sources,source_scope,source_store,tools,initial_evidence,selection_reader,document_reader,browser_reader,chat_reader,knowledge,daily_wrap,screen_memory}.py`，`app/agent_runtime/{hooks,tool_discovery,live_observer,inbox,permission_decisions,context_projection,turn_verification,wait_tool,ask_todo_tools}.py`，`app/artifacts/{schema,projection}.py`，`app/harness/{runtime_host,composition}.py`，`app/action_guard/{action_broker,preconditions}.py`，`electron/model_runtime_config.ts`，`electron/task_input_transport.ts`，`electron/python_bridge_runner.ts`，`app/fabric/loop_answer.py`，打包配置及 build/sync 脚本。

主审按生产函数追读：`app/harness/builtin_bundle.py` 的插件注册、单次/常驻 boot、source 工具接线；`app/agent_runtime/loop.py` 的工具结果、终态、验证和中断；`scripts/selection_bridge.py` 的任务来源与 Runtime 入口；`scripts/artifact_bridge.py` 的编辑/接受/apply/回执；`electron/task_sources.ts` 的引用投影、标签与校验；`app/ai_client.py` 的请求配置绑定；`electron/main.ts` 的发送/持久化/恢复和模型选择；桌面动作与上下文修复的最终 diff。

协作审读的全文覆盖：

- Runtime：`tool_registry.py`、`tool_scheduler.py`、`turn_verification.py`、`session.py`、`memory.py`、`resume_context.py`、`run_kernel/projection.py` 及 document patch 实现。Loop 是启动/终止、调度、恢复、压缩、取消、材料关联的函数级审读，不记为该大文件全量逐行覆盖。
- 感知与动作：`app/perception/{fusion,providers,broker,pixel_ocr,visual_once,element_handles}.py`，`app/grounding/{perception_cascade,marked_read}.py`，`app/input_artifact/schema.py`，`app/adapters/base.py`，`app/evidence/contract.py`，`app/desktop_actions/{session,uia}.py`，`app/action_guard/{preconditions,guard_factory,action_broker,undo_log,approval,egress_gate}.py`。选择 bridge 和 Windows input driver 按相关接缝审读。
- 设置与会话：`electron/{settings_store,model_runtime_config,credential_store,conversation_control,conversation_store,task_input_transport,agent_session_id,selection_session,task_sources}.ts`，`electron/renderer/{settings,settings_model}.ts`，`app/models/profiles.py`，`app/fabric/loop_answer.py`，`scripts/model_cli.js`。主进程、conversation/fabric bridge、Studio、Dsh、activity projection 和 Python settings 按相关生产函数审读。

这轮没有宣称完整审过所有 UI/CSS、所有历史辅助脚本或全部测试文件。跨进程 input ownership/undo 的风险未完成产品可达性核对，没有据此新增防御框架，也不作为已确认问题报告。

未在这轮证明的项目：真实 Office/Figma/微信/钉钉所有版本上的端到端完成率，所有 GUI 页面与设计像素一致，真实模型的判断质量与语言约束遵守率。既有 Figma 插件发布与原生验收缺口仍然存在。

## 验证与本机交付

不执行 `npm run verify`、无参数 `npm test` 或整目录 pytest；现有 `npm run sync` 强制调用全测，因此本轮按其构建/同步安装步骤执行，跳过该全测步骤。

已完成的定向检查（各组有重叠，不把它们相加冒充独立覆盖量）：

| 检查 | 结果与目的 |
|---|---|
| 材料、聊天、Wait、验证门、receipt、恢复别名、取消 latch 的 13 个相关 Python 文件 | 79 passed / 9.10s；核对各模块合并后的材料与 Runtime 接缝 |
| 感知融合、两阶段、OCR、broker、InputArtifact | 57 passed / 4.97s |
| CU、UIA、Pi parity、ToolRegistry | 122 passed / 2.46s；其后验证语义补充另记 |
| 最终验证语义 + CU/UIA/ToolRegistry + fork（生产改动收口后的6文件） | 152 passed / 7.11s；包含新增26项验证新鲜度及动作结果契约 |
| 仅 timeout / 空 text 的后置条件遗漏补充，以及 successor observation | 先2 failed，再31 passed / 11.38s；覆盖其余真实条件与无条件分支 |
| fork / resume / repair 指定场景 | 20 passed / 17 deselected / 4.77s |
| Python 设置持久化、deep merge | 15 passed |
| 合并后的 Python 配置 + 感知7文件 | 72 passed / 7.52s |
| conversation bridge 的失败/异常/身份/恢复指定场景 | 9 passed / 57 deselected |
| Studio persistence、startup recovery、failure、control、store lifecycle、model runtime/catalog、external refresh、settings store | 9 个 Node 文件通过 |
| Electron/renderer/tests TypeScript 配置、改动 TS/JS 的定向 ESLint | 通过 |
| `npm run build:electron` | 通过，含 Figma bundle、Electron/renderer 编译及 classic script 产物检查。构建仍明确提示 Figma 没有真实 plugin ID，未伪造 manifest |

开发树真实原生验收：临时 Win32 Edit，通过生产 UIA 写入 **295 字符**，等待整个 value 匹配，并从指定 successor state 读回完整尾部，**357.82 ms**。不使用物理键鼠、不调用模型；窗口在 finally 关闭。脚本与结果在 `artifacts/code-audit-20260918/verify_native_delivery.py`、`native-development.json`。这不是 Office/Figma/微信验收，也不是性能统计。

本批交付版本为 **1.0.49**。通过与 sync 脚本相同的 unpacked 目录复制路径完成安装同步，robocopy exit 7（成功，存在复制/差异项目），随后核对版本并重启。没有运行内含全套测试的 `npm run sync`。

安装目录核对：**24 个本批 Python/编译 JS 文件逐字节一致**；`package.json` 比对版本字段（electron-builder 会正常删除开发脚本/devDependencies，不应将完整 JSON 字节相同作为打包契约）。安装版自带 Python 实际导入安装目录模块，原生295字符写入→完整条件匹配→指定状态读回通过，**405.12 ms**。结果保存在 `artifacts/code-audit-20260918/installed-verification.json`。重启后核对7个 Magic Pointer 进程，路径均在本机安装目录。

打包过程：首次 NSIS 压缩期间，最终审读补充了“仅 timeout/空 text 不能冒充后置条件”的2项红测与修复；因此主动停止旧压缩进程，将该最后修改同步到已构建的 unpacked 树，再使用 electron-builder `--prepackaged` 在独立 final 输出目录重建安装器。这个主动停止导致的首次 exit 1 不记为成功构建。

最终 NSIS 构建 **exit 0**：`release/audit-1.0.49-final-20260918/Magic-Pointer-1.0.49-x64.exe`，**392,342,147 bytes**。安装器及更新元数据已同步到常规 `release/` 路径。构建显式使用 `--publish never`，没有发布 MP GitHub release。安装版使用的正是该 final 构建所用的 unpacked 树；安装代码核对和原生验收结果见上。

本批保留在当前工作树，未把其他任务的已有改动一并提交或推送。另行创建的用户任务“发布 Pi 与 Codex 的 Jev 上下文压缩插件”负责两个独立插件项目，未将它们作为 MP 本批实现或验收内容。
