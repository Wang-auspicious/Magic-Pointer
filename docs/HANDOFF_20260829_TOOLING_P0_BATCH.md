# 交接：工具调用对比修复批（P0/P1，2026-08-29）

> 背景：用户要求对比 Hermes（`D:\AI_Agents\HermesAgent`）、Claude Code
>（`C:\Users\zjz65\PycharmProjects\claude-code-main`）、Magic Pointer 三方的
> 工具调用架构，按差距清单从 P0 开始逐项修。用户明确指示：**不升版本号，
> 先修好**；修完一批再统一验证交付。本文件是本轮的完整交接。

## 0. 一句话

P0 两项（思考流、系统提示词人格层）已完成并有真机证据；P1-3（工具结果
落盘回读）核心已落地、**差两座桥最后一行接线**；P1-4、P2-5、P2-6 未动。

## 1. 对比结论（驱动本批的差距清单）

三方深读报告要点（详细数据在对话记录中，关键事实如下）：

- **工具数量**：CC 常驻约 22 个、Hermes 静态注册 74 个、MP 约 52 个
  （其中约 18 个 capability 配方工具默认 deferred）。数量不是差距，**单工具
  实现深度**才是：CC 的 Edit 有 9 级 errorCode 阶梯 + 弯引号归一化，MP 的
  edit_file 只有精确匹配两态报错。
- **回话生硬的三个根因**：① `model_client.py` 把 thinking 硬编码 disabled、
  流式解析只读 `delta.content`/`delta.tool_calls`，reasoning 全部静默丢弃；
  ② 系统提示词 9 个 section 全是操作纪律禁令，没有任何"怎么说话"的人格层；
  ③ "回答要简短"与"不要为了显得勤奋"双压制。
- **工具结果处理**：CC/Hermes 都是三层（工具内自截 → 超限落盘+路径回读 →
  整轮聚合预算），MP 只有 64K head+tail 硬截断一层，截掉的中间内容模型
  永远拿不回来。
- **技能频次**：Hermes 的 skill_view 带使用计数 bump + curator 归档；MP 的
  SkillCatalog 无任何计数器（用户点名要"按使用频率排序"）。

优先级：P0-1 思考流、P0-2 人格层、P1-3 落盘回读、P1-4 edit_file 错误阶梯、
P2-5 技能频次、P2-6 未知工具错误附可用列表 + run_command 退出码语义。
P3（delegate 并行/后台化）明确跳过——依赖 Batch A（60s/120s 硬顶）先落地。

## 2. 本轮已完成

### 2.1 P0-1 思考流（完成，真机验证过）

链路：模型 API → SSE 解析 → loop 事件 → 桥 sink → 进度行/trajectory →
Electron store → GUI Think 行。每一跳都有测试。

| 层 | 文件 | 改动 |
|---|---|---|
| 解析 | `app/agent_runtime/model_client.py` | 新增 `ReasoningDelta` 事件；chat SSE 解析 `delta.reasoning_content`/`delta.reasoning`（OpenRouter 变体）；messages SSE 解析 thinking 块（`content_block_start` type=thinking + `thinking_delta`）；非流式响应解析 `message.reasoning_content` 和 messages 协议 content 里的 thinking 块；`LoopModelClient.last_reasoning` 逐轮累计 |
| loop | `app/agent_runtime/loop.py` | 新增 `ReasoningChunk` 事件（kind=`reasoning_chunk`，与 ModelChunk 同权 yield 给 event_sink）；**不进消息历史**（DeepSeek 系拒绝回传 reasoning，Anthropic 系要求完整 thinking 块往返——所以只做展示流，不改 API 载荷） |
| 桥 | `scripts/conversation_bridge.py` | `_ConversationActivitySink` 新增 `reasoning_chunk` 处理：trajectory message record 累计 `reasoning` 字段（正式渲染数据源）；`mark_blob("reasoning_chunk", b64)` 进度行（边想边画，与 answer_chunk 同款节流）；turn/tool 边界冲刷；终态载荷新增 `thinking` 字段（本轮全部思考拼接） |
| store | `electron/conversation_store.ts` | `updateTurn` 接受 `thinking` 字段持久化（appendTurn 早已支持）；不带 thinking 的更新不清掉已有值 |
| main | `electron/main.ts` | `recordConversationTurn` 透传 `eventResult.thinking` |
| 渲染 | `electron/renderer/studio.ts` | 流式：`reasoning_chunk` 进度行 → `appendLiveReasoningText` → 复用 `DshChat.thinkNode(text, running=true)`（DSH Think 行组件，8·29 批删掉假数据后闲置，现在喂真数据）；正式回合：`turn.thinking` → Think 行本就支持 |
| 类型 | `electron/renderer/data.ts` | `MagicPointerDshChatApi` 加 `thinkNode` 声明 |

- **真机证据**：生产网关 mimo-v2.5（opencode.ai，chat 流式）实测吐
  `reasoning_content`（99 字符，"Let me compute 37 × 46 = 1702"），MP 全链
  捕获成功（`tests/` 外的一次真实调用，5.4s）。说明这条链路在用户当前
  模型上**默认就有数据**，不需要开 thinking 开关。
- 测试：`tests/model_reasoning_stream_test.py` 9 项（解析三种方言、非流式
  两协议、loop 事件、桥 sink 双输出）；`tests/conversation_store_test.js`
  追加 thinking 持久化契约。全绿。
- **未验证**（诚实边界）：Electron GUI 里 Think 行的实际显示没起真窗口看
  过——渲染代码复用的是已验证的 thinkNode 组件 + 已验证的 answer_chunk
  同款通道，风险低但没截图证据。

### 2.2 P0-2 系统提示词人格层（完成）

`app/agent_runtime/system_prompt.py` 新增静态 `voice` section（排在
identity 之后、rules 之前）：

- 先给结论或直接回应用户意图，结论永远比过程先说；
- 有观点就给观点和理由，不确定就直说不确定；
- 不写空话套话（"好的""希望这能帮到你"），不堆敬语，语气跟着用户走；
- 简短不等于冷冰冰：答完可以自然带一句下一步建议；
- 闲聊/问"你能做什么"时像正常人回答，不为此调工具、不抄功能清单。

静态 section（不随 ctx 变化）保住 system prompt 前缀缓存；不含"圈选"
字样，不破坏"无选区不得谎称圈选"的既有契约。测试：
`tests/harness_extensions_test.py::TestVoiceSection` 1 项，加上既有 48 项
prompt/bundle 契约全绿。

注意：rules 第 1 条和第 6 条的"压制性规则"（不要显得勤奋/回答要简短）
**本轮没有放松**——voice section 的"简短不等于冷冰冰"已经在语义上对冲，
实测如果还生硬，下一步再动 rules 原文（动之前先看
`test_system_prompt_stops_gathering_evidence_without_stopping_multi_step_jobs`
和 `test_system_prompt_bans_raw_output_dumps_in_answers` 两个契约）。

### 2.3 P1-3 工具结果落盘回读（✅ 已完成并接线）

| 文件 | 改动 |
|---|---|
| `app/agent_runtime/loop.py` | `_bounded_tool_result` 升级为三层：超限（>64K 字符）结果**全文落盘** `<persist_dir>/<call_id>.txt`，模型收 ~3K 预览 + 绝对路径 + "Use read_file on that path with offset/limit" 指引；无 persist_dir 或写失败时退回旧 head+tail 截断（带 sha256）。新增 `_persist_tool_result`（OSError 安全）。`LoopParams.tool_result_dir` 新参数 → `_execute_one(persist_dir=...)` → `_normalize_result` |
| `app/fabric/engine.py` | `run_agent_turn` 新增 `tool_result_dir` 参数转发进 LoopParams |
| `app/agent_runtime/coding_tools.py` | read_file 的 `[truncated]` 裸标记升级为带 offset/limit 分页指引的明确文案（read_file 自身 50K 字符上限 < 64K 落盘阈值，persist→read→persist 死循环构造性不可能） |
| `scripts/conversation_bridge.py` | `run_agent_turn` 调用传入 `tool_result_dir=str(Path(runtime["workspace_root"]) / ".mp" / "tool-results")`（显式工作区与 /cwd 默认都已解析进 runtime） |
| `scripts/selection_bridge.py` | `_loop_router` 的 `run_agent_turn` 调用同样传入（`.mp/tool-results` 与 `.mp/backups` 并列） |

测试：`tests/tool_result_persistence_test.py` 6 项 + 桥级 3 项
（`conversation_bridge_test.py` 2 项显式/默认工作区、`selection_bridge_test.py`
1 项 Stage 路径）全绿；回归 loop/coding_tools/bundle/双桥共 234 passed。

## 3. 本轮未动（下一批从这里继续）

1. ~~**P1-4 edit_file 错误阶梯 + 引号归一化**~~ → ✅ 已完成：
   `coding_tools.py` 新增 `_quote_normalized`/`_normalized_quote_matches`
   （弯/直引号双边归一化 + 索引映射取文件真实子串），edit_file 精确匹配
   count==0 后进入第二级归一化匹配，仍要求唯一或 replace_all。测试
   `tests/coding_tools_test.py` 新增 4 项全绿。未做：未读先写校验
   （readFileState，工作量大一档）。
2. ~~**P2-5 技能使用频次计数与排序**~~ → ✅ 已完成：
   新增 `app/agent_runtime/skill_usage.py`（`SkillUsageStore`，落
   `<user_data>/skill-usage.json`，损坏按空表重建）；`SkillLoader` 注入时
   bump，同分排序键改为 `(-score, -count, name)` 高频靠前；斜杠显式加载
   （conversation_bridge `route_slash_command`）经 `bump_skill_usage` 计入
   同一份 JSON。未做：长期不用降级为只列名字（Hermes 有、本轮未做）。
   测试：`tests/skill_usage_test.py` 5 项 + `conversation_bridge_test` 1 项。
3. ~~**P2-6 未知工具错误附可用列表 + run_command 退出码语义**~~ → ✅ 已完成：
   - `loop.py` `_execute_one` unknown tool 分支附 `Available tools: ...`
     （排序后的全量工具名）；
   - `coding_tools.py` 新增 `_exit_code_semantics`：grep/egrep/fgrep/rg/
     find/diff/cmp/test/[ 等命令退出码 1 时 header 注明 "exit 1 means no
     matches / differences / condition false — not an execution error"；
     普通命令 exit 1 不受影响。测试各 1 项。

## 4. 验证状态（诚实账）

- **全量 fresh 验证（P0–P2 全部完成后，2026-08-30）**：Python
  `python -m pytest` 1577 passed；`npm test` 179 tests passed；
  `npm run typecheck` 五套 tsconfig 全绿；`npm run lint` 绿。
- 版本已升 **1.0.27** 并 `npm run sync` 交付安装版（见 STATUS.md）。
- **真机（2026-08-30 补齐，见 `docs/2026-08-30-TOOL-BY-TOOL-AUDIT.md` §0）**：
  ①落盘回读端到端 **PASS**——真实网关模型 + 7 万字符命令输出，全文落
  `.mp/tool-results/call_*.txt`（64,015 字节），模型拿预览+路径后主动
  read_file 读回并在回答里报出路径；②GUI Think 行 **PASS**——真实编译
  产物 + 真实 conversations:progress IPC（`scripts/probe_studio_think.js`），
  Think 行 running 态、摘要实时跟随 reasoning 流，截图
  `data/runtime/probe-studio-think-1.0.27.png` 目视确认。
- 早期批次记录（全量套件未跑时的部分绿）：本轮相关测试
  `model_reasoning_stream_test` 9、`tool_result_persistence_test` 6、
  `conversation_bridge_test` 30、`harness_extensions_test` +
  `harness_builtin_bundle_test` 48、`coding_tools_test` +
  `agent_runtime_loop_test` 相关全部通过。

## 5. 改动文件清单（本轮新增/修改）

```
新增：
  tests/model_reasoning_stream_test.py      （P0-1，9 项）
  tests/tool_result_persistence_test.py     （P1-3，6 项）
修改：
  app/agent_runtime/model_client.py         （ReasoningDelta + 三方言解析）
  app/agent_runtime/loop.py                 （ReasoningChunk + tool_result_dir + 落盘）
  app/agent_runtime/system_prompt.py        （voice section）
  app/agent_runtime/coding_tools.py         （read_file 截断文案）
  app/fabric/engine.py                      （tool_result_dir 转发）
  scripts/conversation_bridge.py            （sink reasoning + thinking 字段）
  electron/conversation_store.ts            （updateTurn thinking）
  electron/main.ts                          （thinking 透传）
  electron/renderer/studio.ts               （reasoning_chunk 流式渲染）
  electron/renderer/data.ts                 （thinkNode 类型）
  tests/harness_extensions_test.py          （TestVoiceSection）
  tests/conversation_store_test.js          （thinking 契约）
```

注意：工作区在本轮开始前就有大量未提交修改（git status 一开始就是
dirty，见 `docs/STATUS.md` 8·28/8·29 批），本轮改动是纯叠加，没有回滚
或覆盖任何既有未提交工作。

## 6. 交接文档（供下一会话回读）

- 三方对比的完整报告在本轮对话中（Hermes/CC 两个深读 agent 的输出），
  关键结论已浓缩进本文 §1；如需 file:line 级细节，重读
  `D:\AI_Agents\HermesAgent\tools\registry.py`、`tools/tool_result_storage.py`、
  `agent/tool_guardrails.py` 与
  `C:\Users\zjz65\PycharmProjects\claude-code-main\src\services\tools\toolOrchestration.ts`、
  `utils/toolResultStorage.ts`、`tools/FileEditTool/FileEditTool.ts`。
- 仓库内既有参考：`docs/harness-port-notes/2026-08-13-cc-tool-architecture.md`。
