# 9 月 20 日至今的代码缩减：功能级静态对账

对比：`4c6d7b6acbc6a08d89bc1f0bf56ca38f0690cd84`（2026-09-20，1.0.50）→ `f60aafb301474bbdffe677b290add88fb4a42794`（2026-09-23，1.0.63）。本轮**只读代码与 Git 历史，不运行测试、不修改产品代码、不升版本**。旧文件函数的逐项行号和行数见[函数清单 CSV](2026-09-23-ts-migration-old-functions.csv)：893 行，列出旧 `app/` 里所有不少于 20 行的函数/方法，以及没有此类函数的文件。它是**源码删除清单，不是 893 个功能缺失的断言**。

以下“旧行数”均为旧提交中的物理行（含空行、注释）；一个函数的行数属于其文件，**表中数字不可相加**。判断分为：`明确移除`＝没有对应生产调用链；`缩窄`＝仍有实现，但旧契约中的特定能力不在现行链路；`已迁入`＝能定位现行入口，未因此证明全行为等价；`待验`＝静态代码不足以断言。旧版生产接线也纳入核对，未使用的开发工具单列。

## 1. 65,572 行究竟在哪里

沿用上一份报告的口径：Git 跟踪的 `app/`、`electron/`、`integrations/`、`native/` 中 `.py/.ts/.tsx/.js/.jsx/.css/.html/.cs/.ps1/.mjs/.cjs` 的物理行；不计 Swift、文档、测试、工具脚本、依赖与构建产物。

| 来源 | 9 月 20 日 | 现在 | 净变化 |
| --- | ---: | ---: | ---: |
| `app/` Python | 74,488 | 0 | **−74,488** |
| `electron/runtime/` TypeScript | 0 | 14,757 | **+14,757** |
| `electron/` 根文件 | 26,885 | 22,262 | −4,623 |
| `electron/renderer/` | 34,314 | 33,099 | −1,215 |
| `integrations/` | 935 | 932 | −3 |
| **产品源码合计** | **136,622** | **71,050** | **−65,572** |

因此不是“65,572 行实现被整体拿掉”：旧 `app/` 全数退出，部分能力重写在新 Runtime 中，另有 Electron 壳和界面合并。比如旧 `claude_shell.css`（3,069）与 `claude_chat.css`（2,919）对应新 `studio_layout.css`（3,042）与 `chat_styles.css`（2,636）；旧 `dsh_chat.ts`（1,663）对应新 `chat_view.ts`（1,764）。仅凭路径删除不能把这 7,651 行算作 UI 功能消失。

旧 `app/` 的主要来源如下，完整 268 文件可从 CSV 按目录筛选：

| 旧目录 | 文件 | 旧行数 | 现行主要落点／下文缺口 |
| --- | ---: | ---: | --- |
| `agent_runtime` | 48 | 17,547 | `agent.ts`、`session.ts`、`model.ts`、`agent_files.ts`、`agent_services.ts`；守卫、压缩、会话校验缩窄 |
| `fabric` | 35 | 12,073 | `fabric.ts`、`workflow.ts`、`external.ts`、`context_policy.ts`；能力快照、Context Packet 缩窄 |
| `context_pack` | 19 | 6,312 | `context*.ts`；主要阅读、绑定、历史工具仍在 |
| `actions` | 21 | 5,352 | `actions.ts`、`actions_delivery.ts`、`artifacts.ts`；购物／日历另属明确删除 |
| `adapters` | 9 | 4,111 | `desktop_adapters.ts`、`desktop_sources.ts`；DevTools 网络诊断、终端证据接线缺口 |
| `computer_operator` | 13 | 3,733 | `desktop_operator.ts`、`desktop.ts` 与原生宿主；并非 UI-TARS 整体消失 |
| `harness` | 9 | 3,096 | `agent_plugins.ts`、`index.ts`、`tools.ts`；插件契约尚不能凭行数认定等价 |
| `desktop_actions` | 5 | 2,702 | `desktop.ts`、`desktop_perception.ts` 与 `scripts/uia_selection_probe.cs` |
| `perception` | 7 | 2,511 | `desktop_perception.ts`；多源融合、OCR 失败语义缩窄 |
| `grounding` | 11 | 2,208 | `desktop_sources.ts`、`desktop_adapters.ts`；终端证据接线缺口 |
| 其余 91 个文件 | — | 14,843 | 模型、权限、草稿、记忆、回放、遥测、语音等；逐项见 CSV 与下表 |

同口径以外，`tests/` 从 73,628 行降到 23,001 行（**−50,627**），`scripts/`＋`tools/` 从 35,016 降到 12,402（**−22,614**）。这些**不在**上述 65,572 行内，也不自动代表用户功能删除；迁移说明承认没有逐条复制旧 Python 测试。

## 2. 用户此前明确要求删除的功能

这些归为“有意丢弃”，不要再误报为迁移事故；数字只算能直接按文件名归属的旧产品源码，散落在 `main.ts`／界面里的删行未硬凑进去。

| 功能 | 明确消失的旧产品源码 | 当前状态 |
| --- | ---: | --- |
| 语音输入、听写、唤醒和语音归一化 | `app/voice/` **183** ＋ `electron/voice_*` 与 `dictation_correction_policy.ts` **1,189**，合计 **1,372 行** | 生产界面与启动链已按 9 月 22 日用户要求删除；零星配置词不等于入口仍在 |
| 本地购物清单和日历草稿／存储 | `app/actions/calendar.py` 66、`calendar_draft.py` 159、`shopping_list.py` 196、`app/dashboard/calendar.py` 336、`shopping_list.py` 338，合计 **1,095 行** | 内置配方 `calendar.create_from_screen` 已移除；该旧配方本身标为 provider 不可用。购物／日历演示链是明确删除范围 |
| Gallery 与 Lab 页面 | `gallery.ts/html` 176 ＋ `lab.ts/html` 154，合计 **330 行** | 演示页面已删除；Studio 主界面仍在 |

以上可直接归属的**至少 2,797 行**是有意删除。`app/actions/route_draft.py` 的 61 行不计入：当前 `actions_delivery.ts` 仍有 `wantsRouteDraft`／`parseRouteDraft`，`map.route` 与 `text.summarize_route` 配方仍在。旧 39 个内置配方变为 36 个，精确移除的是 `calendar.create_from_screen`、`recipe.scale_and_route`、`voice.short_command`。

## 3. 生产链路上找到的具体缩窄／缺口

下表回答“哪个功能的多少旧代码没有对应能力”这一问题。写成**具体行为**，而不是宣称整个旧文件缺失。`当前证据`只来自静态调用链；需要应用验收才能决定体感与严重度。

| 功能／旧代码位置与行数 | 当前证据 | 对用户可能产生的差别 | 结论 |
| --- | --- | --- | --- |
| **终端错误定位**：旧 `TerminalEvidenceExtractor.extract` **101 行**（`app/grounding/terminal_evidence.py:168–268`），旧 UIA 读取在 `uia_text_adapter.py:788–807` 将整段终端缓冲提炼为命令、错误附近窗口和退出码 | 新 `desktop_operator.ts:119` 有 `extractTerminalEvidence`，但全 `electron/` 只有定义、没有调用；`desktop_adapters.ts:284–294` 直接把 UIA `data.text` 放进 context | 用户指着终端错误时仍可能读到原文，但旧的“哪条命令、哪行错误、退出码已观察到否”不会经生产 UIA 选区自动组织成证据 | **明确未接入 live 路径** |
| **浏览器网络／控制台失败证据**：旧 `ChromeDevToolsProbe._evaluate_region` **135 行**（`browser_devtools_adapter.py:980–1114`）及 `_probe_target` **130 行**（`:1116–1245`）启用 DevTools Network/Log 并收集 `loadingFailed`／日志 | 新 `desktop_adapters.ts:98–211` 的 CDP 连接只请求 `Runtime.evaluate`；异步事件无请求 ID 即被忽略。`interaction_episode.ts:155` 仍接收 `networkFailures`，生产读取器没有填它 | 指向失败网页时 DOM 仍可读，但旧版能带出的具体网络失败 URL／错误不再由当前 CDP 读取器采集 | **明确移除诊断采集** |
| **结构化来源之间的冲突／互证**：旧 `_content_conflicts` **28 行**（`perception/fusion.py:164–191`）和 `fuse_observations` **83 行**（`:259–341`）比较所有覆盖标记的来源，输出 `conflicts` 与 `corroborations` | 新 `desktop_perception.ts:201–222` 选一个 `best`，只将它同 OCR 结果比较；`mergeEvidence` 有定义但 live `perceiveFrozenFrame` 不调用；`context_prepare.ts:134` 仍读取 `trace.corroborations` | UIA 与 DOM／Office 都给出内容而彼此冲突时，旧版可显式暴露分歧；当前可能选优先级最高的一个而不标记结构化来源间分歧 | **明确缩窄** |
| **OCR 失败不等于屏幕无文字**：旧 `FrozenFrameOcrProvider.read` **150 行**（`perception/pixel_ocr.py:585–734`）区分 `worker_busy`；旧 `read_ocr_blocks_cold` **64 行**（`:497–560`）提供 RapidOCR／Tesseract 冷路径 | 新 `desktop_perception.ts:200` 把 OCR 异常存进 `ocr.error`，但 `:222` 在无内容时统一给 `status='unsupported'`；OCR 仅走 `desktop_ocr.ps1` Windows OCR resident，无 RapidOCR／Tesseract 后备 | OCR 忙碌、超时或 Windows OCR 不可用时，上层会看到 unsupported；旧的引擎后备也不再提供。没有做准确率对照 | **明确缩窄** |
| **恢复任务时判断旧来源还在不在**：旧 `with_source_availability` **66 行**（`agent_runtime/resume_context.py:79–144`）检查冻结文件、普通文件和 live 连接，标注 `available/historical_evidence/missing/rebind_required` | 新 `agent.ts:273–278` 注入续接摘要时只按 source kind 赋 `resumeRequirement`，没有检查文件存在或已重绑的 live source ID | 跨重启任务的续接提示失去“已缺失／仍可读”的即时状态，模型要靠后续工具失败再发现 | **明确缩窄** |
| **工具失败和重复证据的停机条件**：旧 `ToolCallGuardrailController.observe` **153 行**（`agent_runtime/tool_guardrails.py:123–275`）与 `_observe_failure` **69 行**（`:277–345`）分别追踪同参数失败、同工具不同参数失败、跨工具重复读、重复成功写 | 新 `agent.ts:412–425` 只按 `工具名＋参数＋错误标志＋相同输出` 计数，重复 2 次警告、4 次停机；没有跨参数失败桶或跨工具内容去重桶 | 报错文字／参数不断变化但实质无进展时，旧版可提前停或建议换能力；当前更可能继续消耗回合 | **明确缩窄** |
| **压缩后保留尾部的大工具结果**：旧 `_prune_stale_tool_outputs` **30 行**（`agent_runtime/memory.py:262–291`）在保留尾部超过 4k token 时缩短较旧的工具正文，最近 6 条保留 | 新 `agent.ts:232–259` 会去重待摘要的前段，但直接拼上 `surface.slice(cutoff)`，不裁较旧尾部工具结果 | 多次大读取挤在最近上下文时，压缩后的尾部可能仍很重，降低长任务的可续行空间 | **明确缩窄** |
| **会话事件的写入时约束**：旧 `_validate_append_transition` **202 行**（`agent_runtime/session.py:687–888`）验证 model/request 消息哈希、inbox 消费的顺序和消息体、cancel 与 receipt、artifact applied 等 | 新 `session.ts:445–491` 保留了 turn、operation、artifact 一部分检查，但直接 `append('model/request', ...)` 不再核对当前 surface 哈希，`inbox/consumed` 仅检查 ID 属于 pending，没有核对消息体和顺序 | 正常内部 `recordRequest`／`claimInbox` 会构造正确数据；直接使用公开 `EventSession.append` 的插件／桥若提交不匹配事件，旧版拒绝、现在可能写入不一致日志 | **内部契约缩窄；日常可达性较低** |
| **配方可用性说明**：旧 `_status_for_recipe` **72 行**（`fabric/capability_snapshot.py:85–156`）与 `build_engine_capability_snapshot` **109 行**（`:250–358`）区分平台、provider、验证器、权限和 experimental，并提供修复入口 | 新 `fabric_api.ts:37–42` 的 `runtime.snapshot` 仅以 enabled、`unavailable:` provider 和有没有外部 agent 可执行文件算 ready/unavailable，`repairs` 固定空数组 | 面板可能把缺验证器、权限、平台支持等配方显示为 ready，或不给用户可执行的修复入口 | **明确缩窄** |
| **外部 Agent Context Packet 的工作区与空间上下文**：旧 `probe_workspace` **36 行**（`fabric/context_packet.py:71–106`）收集 branch/head/changed files/diff；`_spatial_relations` **22 行**（`:242–263`）；`build_agent_prompt` **154 行**（`:557–710`）将它们和终端证据编成可读段落 | 新 `context_policy.ts:311–373` 的 packet 只接收 cwd/repoRoot/binding，未写 branch/head/diff 或 spatialRelations；`fabric.ts:176` 给外部客户端的是 `command + JSON.stringify(contextPacket)`。`interaction_episode.ts` 虽仍计算 spatialRelations，却未流入此 packet | 喜欢外部客户端交付通道的用户，旧版自动附带的 Git 改动概览、多对象方位和结构化说明减少。MP 自有 Runtime 的来源读取不由这个外部 prompt 代替 | **该投递通道明确缩窄** |

### 原本有代码、现在只剩简版的开发／诊断能力

| 功能／旧行数 | 当前证据 | 结论 |
| --- | --- | --- |
| **真实桌面轨迹录像**：旧 `DesktopTraceRecorder` **151 行**（`replay/recorder.py:43–193`），可逐次加入 frame、pointer、UIA、focus、显示配置和 ground truth；旧严格 schema `trace_schema.py` **338 行**，CLI `scripts/record_desktop_trace.py` 另计工具脚本 | 新 `replay.ts` **42 行**只由单个既有 snapshot 复制一帧，写入 pointer 列表；`focus_events/display_config/ground_truth` 固定空值；没有旧的持续 recorder CLI。`cdp_snapshots` 在旧 recorder 中本来也为空，不计作新损失 | **录制与严格回放夹具能力移除**，不等于产品手势本身移除 |
| **交互账本统计**：旧 `telemetry/interaction_ledger.py` **499 行**，其中 `project_session` **106**、`query` **23**、`summarize` **20**，可按应用／成功／token 筛选并求成功率、Look 比例、p50/p95、主要失败类型；旧 selection/conversation bridge 均调用 | 新 `index.ts:136` 只把 `interaction/` 和 receipt 原始事件返回为数组，没有对应筛选／聚合 API | **聚合分析能力移除**；原始事件还在 |
| **PointerBench 三组对照对象**：旧 `telemetry/pointerbench.py` **278 行**，有 `BenchTask/BenchRun/BackendStats`、运行集合与统计 | 当前产品和脚本都无 `PointerBench` 符号；`scripts/eval-harness.ts` 是新建的真实结果判定基准，不能自动视作旧三组对照的等价实现。旧 `PointerBench` 在基线产品链没有调用者 | **未接生产的旧开发 API 被删除**，用户可判断是否需要回归 |

## 4. 大量删行已有现行入口，不能当成丢失

| 旧实现（旧行数） | 现行主要入口 | 静态结论 |
| --- | --- | --- |
| Agent loop `loop.py` 3,170、会话 `session.py` 2,158 | `electron/runtime/agent.ts`、`session.ts`、`tools.ts` | 主 loop、持续预算、会话、恢复、权限和工具调度存在；上节列的是具体缩窄点 |
| 模型层 `model_client.py` 1,832、`ai_client.py` 1,085 | `electron/runtime/model.ts`、`model_admin.ts` | Chat Completions/Messages/Responses 流式路径存在；行差不能证明模型协议丢失 |
| 编程工具 `coding_tools.py` 1,910 | `electron/runtime/agent_files.ts`、`agent_services.ts` | Read/Write/Edit/Patch/Glob/Grep/Bash、checkpoint 和后台命令仍有入口 |
| 文档阅读 `document_reader.py` 1,129 | `electron/runtime/context_documents.ts`、`context_surfaces.ts` | PDF/DOCX/XLSX/PPTX、定位、游标和当前 Office 来源仍有代码 |
| 文档动作 `actions/executor.py` 1,069、`office_document.py` 571、`powerpoint.py` 519 | `electron/runtime/actions.ts`、`artifacts.ts`、`actions_delivery.ts` | Office/文档 patch 与读回在新 Runtime；不能把旧动作文件总行数算丢失 |
| 浏览器 DOM `browser_devtools_adapter.py` 1,546 | `electron/runtime/desktop_adapters.ts`、`context_surfaces.ts`，既有 DOM probe 脚本 | 目标绑定、DOM 读取仍在；缺的是上表的 Network/Log 失败采集 |
| 微信／钉钉 `surface_adapter/adapters/*` 282、聊天 `chat_reader.py` 879 | `desktop_adapters.ts`、`context_surfaces.ts`、`context_chat_files.ts` | 会话身份、可见消息、文件卡定位、翻页限制仍有入口；原生会话 ID 暴露问题迁移前后都未解决 |
| PDF 高亮恢复 `pdf_selection_recovery.py` 645 | `electron/runtime/desktop_sources.ts` | 冻结像素确认高亮、PDF 原文恢复仍存在 |
| UI-TARS `computer_operator/ui_tars.py` 277、动作 loop `agent.py` 336 | `electron/runtime/desktop_operator.ts`、`desktop.ts` | 响应解析、动作效果分类、逐步读回仍在；不能因原模块名消失认定 computer use 删除 |
| 子 Agent、MCP、插件、学习候选 | `agent_background.ts`、`mcp.ts`、`agent_plugins.ts`、`learning.ts`、`context_skill_candidates.ts` | 有现行入口，但这份静态对账不宣称旧 100% 行为等价 |

## 5. 给决策的边界

1. **先决定功能，别按净行数做加法。** 上述缺口是 13 个独立的行为/契约判断；旧函数行数包含复用代码、注释和旧架构成本。它们不能加出“真正少了多少功能行”。
2. **用户此前已经要求删除语音、购物／日历演示、Gallery／Lab**，已在 §2 单列；恢复它们需要新的产品决定。Figma 真插件 ID、macOS 和跨小时原生验收在旧版也未完成，不能列作本次迁移“丢失”。
3. **本轮没有运行任何产品测试或应用验收。** 对“没有生产调用点”“字段不再生成”的判断有静态调用链证据；对可靠性、准确率、任务成功率没有新结论。`git status`、`git grep`、旧提交源码与 AST 行数是本次全部证据。
