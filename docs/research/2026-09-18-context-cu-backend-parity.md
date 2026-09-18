# 上下文、成本与 CU 底层对照（2026-09-18）

本批只改 Runtime、来源读取、模型请求投影及 CU 执行状态，不改 GUI。按用户要求保留 **1.0.48**，分批本地 Git 提交；安装同步结果在验收后补录。

## 事实源及比较边界

- 本地 `C:/Users/zjz65/PycharmProjects/claude-code-main` 的 README 自述为 2026-03-31 source-map 暴露源码的研究镜像，非官方仓库。本批学习实现机制，自行用 Python 实现，不复制其 TypeScript 实现，也不把该快照等同于当前 Claude Code。
- `Vida.md`、`docs/research/2026-09-16-vida-circle-point.md`、`docs/planning/vida-active-layer.md`、`docs/design/VIDA_PROMPTRESCUE_MEASURED.md` 及其引用的五段本地演示，是产品行为参照。演示经过剪辑/镜头推拉，不能作为端到端延迟实测；Vida 的矩形截图也不能证明 MP 的多笔圈选正确。
- [OpenAI Astra 官方介绍](https://openai.com/index/gpt-6-astra/) 报告模型和 Codex harness 结合后，Mind2Web 任务完成速度相对 Sol 提升 1.9 倍；OSWorld 2.0 的 47% 时间下降属于延迟模拟。文章还说明跨上下文笔记及旧窗口检索机制。它没有公开完整的 CU 内部优化实现，本批不能据此承诺相同模型/准确率/速度。
- [Astra 工作场景介绍](https://openai.com/index/gpt-6-astra-next-generation-work/) 的 Excel 比赛示例与 MP 用户工作流不是同一测试，不能直接作 MP 的验收数字。

## 逐文件对应与落地

Claude 路径均相对于上述本地源码目录；MP 路径相对于本仓库。表中“已有”表示不重复造一套。

| Claude / 其他事实源 | MP 对应代码 | 实际差异与处理 |
| --- | --- | --- |
| `src/context.ts`：缓存环境上下文，并发收集固定事实 | `app/agent_runtime/system_prompt.py`、`scripts/selection_bridge.py`、`app/input_artifact/schema.py` | 已有静态/动态提示区分。但多来源已读文字没有随来源目录充分进入首轮。新增逐来源 availableContent、明确覆盖范围和可直接使用的 readArgs；总预览正文有界，不复制原始坐标数组。 |
| `src/tools/FileReadTool/FileReadTool.ts:523`：相同范围、未变文件不重发全文 | `app/context_pack/document_reader.py`、`app/agent_runtime/context_projection.py` | 原 DocumentReader 每次翻页/搜索/describe 都重解析。现在任务 reader 最多缓存 8 个文档，依据路径、mtime、大小、来源 revision 复用，修改后重读；目录保持实时读取。无新增哈希。重复读结果仅当原文仍在当前请求中时才引用前一 call ID。 |
| `src/tools/FileReadTool/FileReadTool.ts`：有界读取和多格式输出 | `app/context_pack/tools.py`、`app/context_pack/document_reader.py` | 原 PDF 默认按小坐标块读取，21 页被分为 630 块，造成十余次往返。Context.read 默认 text 视图按页，32 页上限与结果字符预算共同约束；structured/明确 locator 保留精确块结构。预览截断后的游标不再跳过未读段尾。 |
| `src/utils/toolResultStorage.ts`：结果按工具预算处理，Read 避免递归落盘再读 | `app/agent_runtime/loop.py:2892`、`app/agent_runtime/context_projection.py` | MP 已有落盘/结果上限。新增 dict/list 正规 JSON 序列化，修复 Python repr 使结构处理失效；请求中把重复来源 metadata、citation locator、coverage range 提取为共享字段，正文、页码、完整性和续读游标保留。完整记录不因模型投影而改写。 |
| `src/query.ts:412`、`src/services/compact/microCompact.ts` | `app/agent_runtime/memory.py`、`app/agent_runtime/context_projection.py` | MP 已有多次压缩与 tail prune；此前重复结果只在摘要阶段去重。现在每次 provider 请求都可去掉仍有原文的重复读取；压缩删掉原文后，下一次投影自动恢复全文，不保留失效去重状态。未照搬 Anthropic 内部 cache-edit beta 或 feature flags。 |
| `src/services/compact/apiMicrocompact.ts`：特定模型的服务端上下文编辑 | `app/agent_runtime/model_client.py` | MP 支持多个协议，不能向全部厂家发送 Anthropic 专属参数。请求投影同时覆盖 Messages、Responses、Chat Completions，三协议回归验证。 |
| `src/tools/ToolSearchTool/ToolSearchTool.ts`：精确工具名加载与渐进发现 | `app/agent_runtime/loop.py:2135`、`app/agent_runtime/tool_registry.py` | 现有 Tools 精确加载、延迟 schema、跨压缩恢复已落地。保留；未把所有 CU 工具常驻塞进提示。当前回放首轮有 15 个 schema。 |
| `src/services/tools/StreamingToolExecutor.ts`：并发安全工具、独占动作 | `app/agent_runtime/tool_scheduler.py` | MP 已有有界并行、资源冲突和按模型顺序提交。保留。Claude 快照能在完整工具块到达时提前调度；MP 当前仍在整轮解析完成后派发。这属于后续可量化的延迟差异，本批未实施早派发，避免破坏现有截断/权限语义。 |
| Astra 官方：早期窗口可检索，不只依赖摘要 | `app/agent_runtime/memory_tools.py` | Recall 原先命中长 JSON 行却只返回行首，可能丢掉真正命中的文字；先截断匹配再做每会话限制，也会吞掉其他会话。现在返回命中附近 700 字，按会话限制后再限制总数，并支持 session_id/event_seq/offset 精确分页读回，无需工作区 Read 权限。 |
| Pi/Kimi CU 状态契约（`docs/REFERENCE_PROJECTS_20260810.md`） | `app/desktop_actions/session.py:181`、`:260`、`:286` | observe_ui 原来重复发 elements/outline；wait_for 判定后重抓一份状态；act_ui 又抓一份，验证和状态 ID 不一致。现在只投影一份可操作树，条件判断和返回状态同源，act_ui 复用已验证 successor；无 postcondition 不宣称验证成功；full 视图实际带可操作 outline。 |
| Vida PromptRescue：已有证据直接进入任务，显示读取事实而后交付 | `app/context_pack/initial_evidence.py`、`scripts/selection_bridge.py` | 冻结文字/native 文件预览直接进入数据通道；不增加首轮摘要模型，不靠再问视觉才能确认文字存在。短标签 A/B/C 仅确定性解析到当前活动来源，权限门使用真实 source ID。 |

## 测试与失败见证

新增回归均先观察失败：重复解析 4 次而非 1 次；预览后漏掉段尾；首轮缺少第二处微信和 PDF 已读证据；dict 结果不能 JSON 解码；模型请求重复 metadata；CU 重抓/状态 ID 不一致；Recall 丢命中文字及第二个会话；PDF 默认读取无法覆盖 21 页；短标签未解析。修复后定向回归通过，完整门结果待本机 sync 完成补录。

## 真实默认模型回放

运行 `python scripts/benchmark_selection_context.py`。使用用户事故中的原始冻结图和两处 OCR，原桌面 PDF 实际由 DocumentReader 读取，调用生产 `_loop_router` 与默认 Provider；没有注入预期答案。冻结帧/手势框是历史 fixture，微信 HTML 附件只有卡片文字，没有正文。

| 状态 | Runtime 耗时 | 模型请求 | 输入 token | 输出 token | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| 上一批基线 | 190.719 s | 4 | 45,012 | 1,429 | 先调用视觉遇 429，再读少量材料 |
| 加首轮已读证据，尚未修 JSON 边界 | 62.453 s | 3 | 63,930 | 936 | 速度改善，但 token 变差、选择过于笼统 |
| 修 JSON 后，仍按坐标块翻页 | 149.266 s | 9 | 284,534 | 2,761 | 暴露 630 小块导致的反复翻读；该结果保留，不当作成功 |
| 按页阅读 | 84.329 s | 3 | 52,675 | 2,161 | 一次读完正文；复制长 source ID 出错一次 |
| 短标签 | 113.203 s | 3 | 52,666 | 1,366 | source ID 正确，但编造 cursor 后重试一次 |
| 最终参数说明与预览精简 | **40.047 s** | **2** | **33,562** | **1,068** | **1 次 Context.read(C, text)，0 次失败，0 次视觉；取得 21 页正文后完成** |

最终原生预览准备另耗 1.640 s。相对基线，单次回放 Runtime 用时下降约 79.0%，输入 token 下降约 25.4%，请求轮数减半。**这不是多轮统计分布，也不是与 Claude Code 在同条件下的跑分。** 缓存命中从 24,320 变为 9,152，未缓存输入由 20,692 变为 24,410；最终读到了更多正文，不能把 token 总数下降直接换算成账单下降。

所有中间回放保存在 `data/backend-20260918/runtime-replay-before-*.json`，最终在 `runtime-replay.json`，基线在 `data/acceptance-20260918/runtime-replay.json`。材料里的论文/基准主张只是被读文档内容，本批未替它做外部学术核验。

## 尚未通过的边界

- 默认 mimo-v2.5 在最终回放中仍没有遵守 200 字，虽然已把长度/格式作为明确交付条件写入 prompt。不能说该需求已解决，也没有用硬截断伪造合格答案。
- 微信 HTML 正文尚未取得，不能说三份原文全部读全。
- CU 改动有生产类回归，尚未因此证明微信、Office、Figma 等所有真实应用端到端达标。
- 未实现在流中提前执行工具，未宣称达到 Astra 的模型能力、官方基准或 Claude Code 全仓库 parity。

## 交付

版本维持 1.0.48。已完成本地分批提交；保留接手时的大量未提交 GUI/后端工作，只暂存本批差异。全量验证、安装目录核对及最终提交号待下方交付记录补齐。
