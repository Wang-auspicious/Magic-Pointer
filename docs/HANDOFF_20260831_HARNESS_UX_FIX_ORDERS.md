# Harness 体验缺口修改工单（2026-08-31）

> 对照基准：Claude Code（query loop / tool surface / permission）、Pi（StreamFn）、
> Hermes（context compressor / partial delivery）。
> 本文只收**当前代码里能定位、且用户能直接感知**的问题，逐条给出「改哪个文件的哪一处、
> 为什么、怎么改、怎么验」。执行者不需要读懂整套架构，按条施工即可。
>
> **与既有文档的关系**：`docs/research/2026-08-31-magic-pointer-competitor-footprint-ux-audit.md`
> 已覆盖体积、桌面动作验证、Electron 常驻资源、会话恢复等 48 条。本文**不重复那 48 条**，
> 只补它没覆盖的 harness 内核（流式、上下文、提示、工具面、权限粒度）与 composer 交互。

## 施工总规矩（每条都适用）

1. 一条一个 commit，不要合并。改完立刻跑该条列出的验证命令。
2. 不删测试、不改测试期望来让红变绿。测试红了先看是不是自己改错了。
3. 中文注释沿用仓库现有风格：写「为什么这么做」，不写「这段代码做了什么」。
4. 全局回归：`python -m pytest -q` 与 `npm test`（改了 TS 时还要 `npm run typecheck`）。

## 2026-09-01 执行回账（1.0.32）

以下不是“照单全收”的勾选，而是逐条回到当前代码验证后的结果；两条原判断已按
当前实现纠正（P1-8 的 MCP 截断顺序、P2-18 的真实焦点问题）。

1. **P0-1 已修**：SSE parser、Streaming backend、LoopModelClient、loop 四层改成真增量；首段消费测试证明后续 delta 尚未生成，活网关实测 124 chunks、TTFT 10.95s、总耗时 15.48s。已输出任何正文/思考后禁止 fallback 重放；`TurnDone` 后不再被 cleanup 异常反写成失败；reasoning-only EOF 诚实失败。
2. **P0-2 已修**：established EventSession 不再重复注入截断的用户/助手历史；旧 Electron 对话只在空 Agent session 首接时迁移一次。对象标签保留，scene evidence 带稳定 id、在 durable surface 中每份只出现一次。
3. **P0-3 已修并更新事实**：context budget 返回真实窗口，loop 是唯一 0.8 safety margin，最长前缀真实生效。2026-09-01 官方资料核实后，GPT-5.4/5.5/5.6 采用 1,050,000，Claude Opus/Sonnet 5 采用 1,000,000；不照抄旧工单已过时的 200k/400k 表。
4. **P0-4 已修**：仅 Messages 协议下放 system/tools/stable-history 三个 cache breakpoint，`MAGIC_POINTER_PROMPT_CACHE=0` 完全关闭；header 从实际 client capability 报告，custom provider 不冒充。当前本机活网关走 chat-completions，因此没有伪造 cache hit 真机数字。
5. **P0-5 已修**：动态 Environment section 注入本地日期、平台、绑定 workspace、symbolic git branch；detached HEAD 不猜，提示构建不做 subprocess。
6. **P1-6 已修**：workspace `MAGIC_POINTER.md` 从本轮绑定目录加载，不再读安装进程 cwd。
7. **P1-7 已修**：Messages 投影会合并相邻同 role block；并行 tool_result 与紧随其后的 user text 顺序保持。
8. **P1-8 已修并纠正原判断**：匹配到的 MCP extra_names 本来会排前，不是“最先被砍”；真问题是截断完全静默、远程 sibling 会重进默认面。现在初始与动态发现都发去重的 ToolsTruncated notice，两桥 limit=128，远程 MCP 工具保持 deferred、只按搜索命中加载。
9. **P1-9 已修**：模型可见工具描述/反馈/系统提示统一 Read/Write/Edit/Patch/Bash/Rewind；旧 alias 只保留路由兼容，不进入 schema。
10. **P1-10 已修**：线程授权支持 `Bash(prefix)`，完整 token 边界匹配；链式、重定向、命令替换、多行不继承。UI 显示具体 prefix；“总是允许”持久化窄规则，“仅这一次”只进入 immediate resumed request、不写回线程。
11. **P1-11 已修**：Grep 支持 case-sensitive 与 content/files_with_matches/count；rg/Python 共用渲染与分页语义。offset 耗尽明确报 page exhausted，不再谎称全局无匹配。
12. **P1-12 已修**：ToolSpec.examples 折进 description JSON，不添加 provider 不接受的顶层字段。
13. **P1-13 已修**：15/25s backend recovery 切成 0.5s 片；取消/interrupt 每片检查，正常 USER_INTERRUPT + Receipt 收口。
14. **P1-14 已修**：`/help` 本地列绑定 workspace 的真实命令/技能/工具；`/compact` 在 session 打开后走现有语义 compactor，只有 token 真下降且 surface CAS 未变化才 replace，压缩期间的新 turn 不会被 stale summary 擦掉。
15. **P2-15 已修**：shared Composer running 时保持可编辑；非空 submit 走 durable steer、空 submit 才 stop；submit/steer ack 失败保留草稿，in-flight gate 防重复。Companion 已接真实 send/steer/stop，不再 no-op。
16. **P2-16 已修**：只有传入 onVoice capability 才创建麦克风；Companion 不再展示死按钮。
17. **P2-17 已修**：Studio Escape 先关菜单；无菜单且有 active turn 才走与按钮相同的 stop path，reject/`ok:false` 都清 guard、可重试。
18. **P2-18 原症状已过时，真实问题已修**：Studio 原来已经在 finally 无条件 focus；问题是会抢走设置等输入框。现在 idle 仅在用户没有操作其他 input/textarea 时恢复焦点。
19. **P2-19 组件能力已修，边界诚实**：shared Composer 支持图片与八类 ≤200KiB 文本附件，等待 FileReader、按 snapshot 清理，不串到下一稿。Companion 还没有结构化附件 IPC，因此直接隐藏纸夹，不把 200KiB/data URL 偷塞进 4k question。
20. **P2-20 已修**：Unicode W/F 计数采用有界 hybrid；连续块 regex 路约 2×，高碎片混排确定性回落 legacy，完整 parity 不变；性能测试不再用易抖的近等价 wall-clock 门。

额外由多轮专项/跨模块复审抓出的同批修复：流式 base64 padding 丢块、prompt cache 少缓存上一轮 assistant、custom provider header 误报、reasoning-only EOF 假成功、`TurnDone` cleanup 双终态/usage/endpoint-health 反写、loop semantic recovery 重放已上屏 partial text、raw-text-only 终态被 cleanup 覆盖、manual compact 并发覆盖与旧历史单消息不真压缩、hook 改写后沿用旧权限、旧 `run_command` alias 绕 prefix/deny、总是允许依赖模型成功才持久化、permission pending 重开复活、Python/Electron durable session id 语法断链、Companion send/steer/stop IPC 拒绝合法 sender、侧栏搜索 Escape 误停任务、Stage/Studio `ToolsTruncated` 通知断链、provider-qualified model id 落 64k、Anthropic cache usage 三桶漏算、短消息集合仍逐条跑 unicodedata、promptCache 诊断未进 Studio trajectory、Studio 新草稿覆盖、附件 read race/重复发送、重复 steer、stop Promise rejection 卡死。最终独立 full-diff review：**Approved**。

---

# P0 —— 用户每一轮都在承受

## P0-1. 流式是假的：三层缓冲让「首字延迟 = 整轮延迟」

**用户症状**：发出问题后，界面上是一团 spinner 一动不动，几秒到几十秒后**整段答案一次性砸出来**。
Studio 的「边收边画」、思考流、`model_first_chunk` 指标全部失真——那个「首 token 时间」量到的其实是
整轮结束时间。

**根因位置（三层，全都要改，只改一层没有任何效果）**：

- `app/agent_runtime/model_client.py:999-1083`（`_parse_sse`）和 `1086-1190`（`_parse_messages_sse`）：
  函数把 SSE 全部行读完，`text_parts` 累积到最后，才 `events.append(MessageDelta(text))` ——
  **整个流被压成一个 MessageDelta**。
- `app/agent_runtime/model_client.py:803-830`（`_post_streaming`）：返回 `list[ModelTurnEvent]`，
  必须等 `_parse_sse` 返回。
- `app/agent_runtime/model_client.py:186-273`（`LoopModelClient.generate_turn`）：
  `events: list = []` 里 for 循环收完才 `return events`。
- `app/agent_runtime/loop.py:928-959`：`events = client.generate_turn(...)` 之后才
  `for event in events: yield ModelChunk(...)`。

**为什么必须改**：这是 MP 与 CC / Pi 最大的一条体感差。CC 首字通常 <1s 出现，MP 是 3-10s 空白。
后端的 SSE 解析、bridge 的节流 flush、渲染层的增量画字**全都已经写好了**，只差事件真的在
流过程中被 yield 出来。这条修完，其他所有「感觉慢」的抱怨会减少一大半。

**怎么改（按顺序，四步，每步单独可跑）**：

**步骤 1**：把 `_parse_sse` / `_parse_messages_sse` 改成生成器。

- 签名从 `-> list[ModelTurnEvent]` 改成 `-> Iterator[ModelTurnEvent]`。
- 文本增量：原来 `text_parts.append(delta["content"])` 的地方，**在 append 之后立刻**
  `yield MessageDelta(delta["content"])`。`text_parts` 保留（`TurnDone.raw_text` 还要用它拼全文）。
- reasoning 增量同理：`reasoning_parts.append(...)` 之后立刻 `yield ReasoningDelta(...)`。
- 函数末尾**删掉**原来那两句汇总式的 `events.append(ReasoningDelta(reasoning_text))` /
  `events.append(MessageDelta(text))`（否则正文会重复一遍）。
- 工具调用、`TurnWithheld`、`TurnDone` 仍在流结束后 yield（工具参数必须收全才能解析，不能边流边发）。
- `_parse_messages_sse` 里 `content_block_start` 携带的初始 text/thinking 也照上面办法即时 yield。

**步骤 2**：`_post_streaming` 改成生成器，`return _parse_sse(...)` 改成 `yield from _parse_sse(...)`；
`with client, client.stream(...)` 块必须**包住整个 yield from**（提前退出 with 会断流）。
状态码 >= 400 的分支改成 `yield TurnWithheld(...); return`。

**步骤 3**：`StreamingMessagesBackend.generate`（`model_client.py:832-932`）重写「先收完再判断要不要降级」的逻辑。
现在它先拿到完整 events 列表，再用 `_stream_looks_empty` 决定回落非流式——生成器化以后不能再这样。
改法（**必须照这个语义写，不要自创**）：

```
buffered: list[ModelTurnEvent] = []
committed = False            # 已经往外吐过内容 => 不能再回落
try:
    for event in self._post_streaming(...):
        if not committed:
            buffered.append(event)
            # 第一次出现"真内容"就提交：正文/思考/工具调用
            if isinstance(event, (MessageDelta, ReasoningDelta, ToolCallArrived)):
                committed = True
                for held in buffered:
                    yield held
                buffered.clear()
            continue
        yield event
except CancelledError:
    raise
except Exception as exc:
    if committed:
        # 已经吐过内容，不能重放：诚实收尾，不要伪造 TurnDone 内容
        yield TurnWithheld(reason=f"backend_error:{type(exc).__name__}")
        yield TurnDone(usage=None, raw_text=None)
        return
    ... 记录 record_failure / record_note，然后 yield from self._fallback_generate(...)
    return
if not committed:
    # 空流或只有 backend_error：走原来的降级路径（record_note + _fallback_generate）
    ...
```

**步骤 4**：`LoopModelClient` 增加 `stream_turn()` 生成器，`loop.py` 改用它。

- 保留现有 `generate_turn`（测试和 `AiClientBackend` 路径还在用），**新增**：

```python
def stream_turn(self, messages, tools, budget_ms=None, cancel_scope=None):
    """边流边 yield；同时把事件累积进 self.last_events 供 parse_tool_calls 使用。

    与 generate_turn 的区别：一旦已经 yield 过内容就不再重试（重试会让用户
    看到同一段话说两遍）。零输出的可重试后端失败仍按原策略重试。
    """
```

  实现要点：复用 `generate_turn` 里的 reserved id 收集、deadline 计算、
  `_provider_failure_is_retryable` 重试判断；把 `events.append(event)` 换成
  `events.append(event); yield event`；**只有当本次 attempt 一个 `MessageDelta` /
  `ReasoningDelta` / `ToolCallArrived` 都没 yield 过时才允许重试**。结束时
  `self.last_events = events`。

- `loop.py:928-959` 改成：

```python
turn_events: list = []
for event in client.stream_turn(state.messages, tool_schemas,
                                budget_ms=remaining_ms,
                                cancel_scope=loop_scope.token):
    turn_events.append(event)
    if isinstance(event, MessageDelta):
        yield ModelChunk(text=event.text)
    elif isinstance(event, ReasoningDelta):
        yield ReasoningChunk(text=event.text)
events = turn_events
if loop_scope.is_cancelled:
    raise CancelledError("cancelled during model call")
calls, text = client.parse_tool_calls(events)
```

  然后**删除**原来 951-959 那段「事后重放 events 并补发 ModelChunk」的循环
  （包括 `yielded_delta == 0 and text is not None` 的兜底——`AiClientBackend`
  这类一次性后端仍会 yield 一个 MessageDelta，兜底会造成重复）。
  注意：`_merge_model_usage` / `record_model_response` 依赖 `client.last_usage`，
  它在 `TurnDone` 到达时被设置，流结束后才读，顺序不变。

**验收**：
- `python -m pytest tests/model_reasoning_stream_test.py tests/conversation_stream_progress_test.py tests/agent_runtime_loop_test.py -q` 全绿。
- 新增一条测试：假后端 yield 三个 `MessageDelta("a"/"b"/"c")`，断言 loop 依次 yield 三个
  `ModelChunk`，且在第三个 delta 产生前第一个 `ModelChunk` 已经被消费（用生成器逐个 next 验证）。
- 真机：Studio 里问一个长问题，肉眼确认文字是逐段出现而不是整段砸出。

---

## P0-2. 每一轮把整段对话历史重复塞进上下文（durable session 已经带着真消息了）

**用户症状**：聊到第 5-6 轮开始明显变慢、变贵，然后突然「压缩」一次，压缩完模型忘事。
问「刚才那个文件叫什么」有时会答错——因为它同时看到两份互相矛盾的历史。

**根因位置**：
- `scripts/conversation_bridge.py:890`：`evidence = f"[本次对话历史]\n{history}"`
- `scripts/conversation_bridge.py:580-611`：`_history_text()` 把最近 `MAX_TURNS=12`（第 72 行）
  轮的 question(≤2000 字) + answer(≤4000 字) + 证据摘要拼成纯文本。
- `scripts/conversation_bridge.py:931`：这段文本作为 `evidence_input` 进 loop。
- 与此同时 `conversation_bridge.py:898` 已经 `sessions.open_or_create(...)` 复用了同一条
  durable session，`loop.py:721` 的 `initial_messages = params.session.derive_messages()`
  **本来就带回了历次的 assistant / tool 真消息**。

**为什么必须改**：同一段历史进了两次，一次是结构化的真消息（带 tool_call_id、带工具结果），
一次是被截断过的纯文本复述。后果三条：
(a) 上下文体积翻倍，CJK 场景下每轮多烧上万 token；
(b) 提前触发压缩（见 P0-3），压缩又把真消息压掉、留下劣质文本副本；
(c) 两份历史不一致时（文本副本被 2000/4000 字截断）模型按错的那份答。

**怎么改**：
1. `conversation_bridge.py:890` 改为只保留**当前对象标签**，不再拼历史：
   ```python
   # durable session 已经带回历次真消息（loop 从 derive_messages 起手），
   # 再拼一份被截断的文本副本只会让模型看到两份互相矛盾的历史。
   evidence = _object_label_text(obj)   # 新函数，见下
   ```
2. `_history_text` 拆成两个函数：
   - `_object_label_text(obj)`：只产出原来第 581-585 行那段 `当前对象：{app · title · label}`；
   - `_selection_evidence_text(turns)`：只产出第 593-610 行那段「第 N 轮现场证据」
     （截图路径 + 当时读到的内容）——这部分**不能删**，它是圈选轮的现场存档，
     durable session 里没有。
   然后 `evidence` 由这两个拼成，`用户：/助手：` 那两行（589-592）删掉。
3. 兼容分支：如果 `agent_session` 是全新的（`derive_messages()` 返回空且 `turns` 非空，
   说明是老对话第一次接上新 session），**这一轮**仍然拼完整 `_history_text`。
   实现：在 `open_or_create` 之后判断 `len(agent_session.derive_messages()) == 0 and turns`，
   是则 `evidence = 原完整拼法`。这条分支要写注释说明它只在迁移期生效。

**验收**：
- `python -m pytest tests/conversation_bridge_test.py -q` 全绿（可能要改期望，改的是
  「不再包含 `用户：`」这类断言，不是删测试）。
- 新增测试：同一 conversation 连发两轮，断言第二轮的 `evidence_input` 里**不含**第一轮的问题文本，
  而 `session.derive_messages()` 里含。
- 真机：连聊 6 轮，看 `#composer-usage-label` 的 input tokens 增长曲线，应明显低于改前。

---

## P0-3. 压缩阈值被打了两次七折：模型窗口白扔一半

**用户症状**：200k 窗口的模型，聊到大概 10 万 token 就开始压缩、开始忘事。用户感觉
「这么大的模型怎么记性这么差」。

**根因位置**：
- `app/agent_runtime/model_profiles.py:55-56, 81`：
  `_COMPACTION_SAFETY_MARGIN = 0.7`，`context_budget_for` 返回 `window * 0.7`。
- `app/agent_runtime/loop.py:212`：`_PROACTIVE_COMPACT_RATIO = 0.7`，
  `loop.py:237` 判断 `estimated >= 0.7 * params.context_budget_tokens`。

两者相乘 = **0.49**。200k 模型实际在 ~98k 就压缩。

**怎么改**（二选一，**选 A**，改动最小且语义最清楚）：

**A（推荐）**：让 `context_budget_for` 返回**真实窗口**，安全边际只由 loop 那一层负责。
- `model_profiles.py:81`：`return max(_DEFAULT_CONTEXT_WINDOW, int(window * _COMPACTION_SAFETY_MARGIN))`
  改为 `return max(_DEFAULT_CONTEXT_WINDOW, int(window))`。
- 删除 `_COMPACTION_SAFETY_MARGIN` 常量与其 docstring，在 `context_budget_for` 的 docstring 里
  写清楚：「返回的是模型窗口本身；压缩安全边际由 `loop._PROACTIVE_COMPACT_RATIO` 唯一持有，
  两处都打折会让可用窗口变成 0.49」。
- `loop.py:212` 的 `_PROACTIVE_COMPACT_RATIO` 从 0.7 提到 **0.8**（留 20% 给工具 schema 和回复）。
  docstring 补一句「这是全系统唯一的压缩边际，不要在别处再乘一次」。

**同时修**：`_DEFAULT_CONTEXT_WINDOW = 64_000` 这个 fallback 现在会让任何未登记的模型
被当成 64k。`_CONTEXT_WINDOWS`（`model_profiles.py:23-53`）补齐新家族：
`("claude-opus-5", 200_000)`、`("claude-sonnet-5", 200_000)`、`("claude-haiku-4-5", 200_000)`、
`("gpt-5.1", 400_000)`、`("glm-4.6", 200_000)`、`("kimi-k2", 256_000)`。

**顺带修一个隐患**：docstring 说「Longest-prefix match」，但 `context_window_for`（59-67 行）
是**按列表顺序取第一个 startswith 命中**，不是最长前缀。现在靠人工排序侥幸正确，加一条就可能错。
改成真的最长前缀：
```python
best: tuple[int, int] | None = None    # (prefix_len, window)
for prefix, window in _CONTEXT_WINDOWS:
    if name.startswith(prefix) and (best is None or len(prefix) > best[0]):
        best = (len(prefix), window)
return best[1] if best else _DEFAULT_CONTEXT_WINDOW
```

**验收**：
- 新增测试：`context_budget_for("claude-sonnet-5") == 200_000`；
  `context_window_for("gpt-4o-mini") == 128_000`；
  `context_window_for("qwen3-coder-plus") == 256_000`（最长前缀而不是 `qwen3` 的 128k）。
- 新增测试：估算 `0.75 * budget` 的历史**不**触发压缩，`0.85 * budget` 触发。

---

## P0-4. 完全没有 prompt caching：每一轮按全价重付整个前缀

**用户症状**：轮次越多每轮越慢、越贵，且这个慢是**线性叠加**的。用户会说「它怎么越聊越卡」。

**根因位置**：`app/agent_runtime/model_client.py:726-762`（`_messages_payload`）。
messages（Anthropic）协议分支里 `payload["system"] = system_prompt`、`payload["tools"] = converted`
都是**裸值**，没有任何 `cache_control` 断点。

**佐证这是遗漏而非有意**：`loop.py:1747-1754` 的 `_merge_model_usage` 已经在解析
`cache_read_input_tokens` / `cache_creation_input_tokens` / `prompt_cache_hit_tokens`，
即「读缓存命中」的观测链路早就铺好了，只是从来没有请求过缓存，这些字段永远是 0。

**怎么改**（只改 messages 协议分支；chat-completions 分支的缓存是网关自动的，不要动）：

在 `_messages_payload` 的 `if api_mode == "messages":` 分支里：

1. system 改成带断点的 block 数组：
```python
if system_prompt:
    payload["system"] = [{
        "type": "text",
        "text": system_prompt,
        "cache_control": {"type": "ephemeral"},
    }]
```
2. tools 数组的**最后一个**工具挂断点（工具表是稳定前缀，整体缓存）：
```python
if converted:
    converted = [dict(tool) for tool in converted]
    converted[-1]["cache_control"] = {"type": "ephemeral"}
    payload["tools"] = converted
```
3. 消息历史挂一个滚动断点：找到 `entries` 里**倒数第二条** user 消息，给它 content 的
   最后一个 block 加 `cache_control`。若 content 是字符串，先包成
   `[{"type": "text", "text": <原字符串>, "cache_control": {...}}]`。
   倒数第二条而不是最后一条：最后一条每轮都变，缓存不到；倒数第二条正好是上一轮已固定的边界。
   消息少于 2 条 user 时跳过这一步。

**硬约束**：Anthropic 一次请求最多 4 个 `cache_control` 断点。上面正好用掉 3 个，
**不要再加**。加多了会 400。

**如果网关不支持**：`cache_control` 是未知字段时部分网关会 400。所以要有开关：
读环境变量 `MAGIC_POINTER_PROMPT_CACHE`，值为 `"0"` 时完全跳过上述三步（默认开启）。
`app/harness/builtin_bundle.py` 的 `model_request_header` 里加一个 `"promptCache": bool`
方便排障时在 Studio 轨迹页看到本轮有没有请求缓存。

**验收**：
- 新增测试：`_messages_payload(..., api_mode="messages")` 的 system 是 list 且带
  `cache_control`；`cache_control` 断点总数 == 3；`MAGIC_POINTER_PROMPT_CACHE=0` 时断点数 == 0。
- 真机：连问三轮，第二三轮的 `modelUsage.cacheReadTokens` 应 > 0（Studio 轨迹页可见）。
  如果网关返回 400，把开关默认改成关，并在 STATUS 里记一句「本网关不支持」。

---

## P0-5. 系统提示里没有环境块：模型不知道今天几号、在什么机器上、在哪个分支

**用户症状**：
- 问「这周改了什么」「这个 issue 多久了」→ 模型按训练截止日算，答错年份。
- 生成 changelog / 日志时间戳凭空捏造。
- 在 Windows 上写出 `rm -rf`、`/tmp/xxx` 这种路径。
- 不知道当前 git 分支，提交/PR 建议全是猜的。

**根因位置**：`app/agent_runtime/system_prompt.py:125-278`（`default_sections()`）。
11 个 section 里没有任何一个提供环境事实。全文件 grep `date`/`datetime`/`今天` 零命中。
`app/harness/builtin_bundle.py:404-421` 组装的 context dict 里也没有。

**为什么必须改**：CC 每次会话都注入 `<env>`（working directory / is git repo / platform /
OS version / today's date）。这是**最低成本、最高收益**的一条：几十个 token 换掉一整类幻觉。

**怎么改**：

1. `system_prompt.py`，在 `default_sections()` 内新增一个 section 函数（放在 `coding` 之后）：

```python
    def environment(ctx: dict[str, Any]) -> str | None:
        """环境事实：日期、平台、工作区、git 分支。

        没有这一段，模型只能按训练截止日推断"今天"，changelog 时间戳、
        "这周改了什么"这类问题全部答错；也不知道自己在 Windows 还是 POSIX，
        会写出跑不起来的命令。事实全部由调用方注入，这里不做任何探测——
        提示层探测文件系统会让 prompt 构建变成一次不可预期的 IO。
        """
        lines: list[str] = []
        today = str(ctx.get("today") or "").strip()
        if today:
            lines.append(f"今天的日期：{today}")
        platform_name = str(ctx.get("platform") or "").strip()
        if platform_name:
            lines.append(f"运行平台：{platform_name}")
        root = str(ctx.get("workspace_root") or "").strip()
        if root:
            lines.append(f"工作区目录：{root}")
        branch = str(ctx.get("git_branch") or "").strip()
        if branch:
            lines.append(f"当前 git 分支：{branch}")
        if not lines:
            return None
        lines.append("以上是本机事实，不要凭训练记忆推断日期或平台。")
        return "\n".join(lines)
```

   并在返回列表里插入 `Section("environment", "Environment", environment, dynamic=True)`，
   位置放在 `Section("coding", ...)` **之前**（环境先于工作方式）。

2. `app/harness/builtin_bundle.py:404-421` 的 `context` dict 里补三个键：

```python
    import platform as _platform
    from datetime import datetime as _datetime

    context = {
        ...
        "today": _datetime.now().astimezone().strftime("%Y-%m-%d（%A）"),
        "platform": f"{_platform.system()} {_platform.release()}",
        "git_branch": _git_branch(str(config.get("workspace_root") or "")),
        ...
    }
```

3. 同文件新增 `_git_branch(root: str) -> str`：`root` 为空直接返回 `""`；
   否则读 `Path(root)/".git"/"HEAD"`，内容形如 `ref: refs/heads/xxx` 就取 `xxx`，
   否则返回 `""`（detached HEAD 不猜）。**不要 spawn git 子进程**——每轮启动一个进程
   会给冷启动加几十毫秒，而且 git 不一定在 PATH 上。任何异常一律 `return ""`。

**验收**：
- 新增测试：`default_sections()` 里存在 id 为 `environment` 的 section；
  给定 `{"today": "2026-08-31（星期一）"}` 时 `build()` 输出含该日期；
  context 全空时该 section 不出现（不产出空标题）。
- 新增测试：`_git_branch` 对 `ref: refs/heads/main` 返回 `main`，对裸 sha 返回 `""`。
- 真机：问「今天几号」，答案应与系统日期一致。

---

# P1 —— 特定场景必踩

## P1-6. 工作区级记忆文件永远加载不到（用错了 workspace_root）

**用户症状**：在项目根放了 `MAGIC_POINTER.md` 写项目规约，模型完全无视。用户以为记忆功能坏了。

**根因位置**：`app/harness/builtin_bundle.py:395-398`：
```python
    memory = MemoryLoader(
        user_dir=Path(config.get("user_data_dir") or str(_FALLBACK_ROOT)),
        workspace_root=Path.cwd(),          # <—— 这里
    ).load()
```
`MemoryLoader`（`app/agent_runtime/memory.py:67-68`）用 `workspace_root / MAGIC_POINTER.md`
找工作区记忆。但打包后的 Electron 进程 `cwd` 是 app 安装目录，**不是**用户选的工作区。
`config` 里明明有 `workspace_root`（同文件第 414 行就在用它）。

**怎么改**：
```python
    workspace_root = str(config.get("workspace_root") or "").strip()
    memory = MemoryLoader(
        user_dir=Path(config.get("user_data_dir") or str(_FALLBACK_ROOT)),
        # 打包进程的 cwd 是安装目录，不是用户工作区；用 cwd 会让工作区级
        # MAGIC_POINTER.md 永远读不到。没有工作区就只加载用户级记忆。
        workspace_root=Path(workspace_root) if workspace_root else None,
    ).load()
```
`MemoryLoader` 已经支持 `workspace_root=None`（`memory.py:67`），不用改它。

**验收**：新增测试——临时目录写 `MAGIC_POINTER.md`，`config["workspace_root"]` 指向它，
断言 `boot_loop_context` 产出的 `model_request_header["systemPrompt"]` 含该文件内容；
`workspace_root` 为空时不含。

---

## P1-7. Anthropic 协议下并行工具会产生连续 user 消息（协议风险）

**用户症状**：模型一轮同时调 2 个以上工具时，接 Anthropic-协议网关的请求可能 400，
表现为整轮失败并显示 `backend_error:http_400`，且**重试没用**（`http_400` 在
`_provider_failure_is_retryable` 里是不可重试的）。

**根因位置**：`app/agent_runtime/model_client.py:707-717`（`_message_entry` 的 TOOL 分支）
把**每一条** tool 结果单独包成一个 `{"role": "user", "content": [tool_result]}`；
`model_client.py:735` 的 `entries = [_message_entry(m, api_mode) for m in messages]`
没有任何合并步骤。一轮 3 个并行工具 = 3 条连续的 user 消息。
Anthropic Messages 的契约是：**一轮 assistant 的所有 tool_use，对应的 tool_result 必须
放在紧随其后的同一条 user 消息里**。

**怎么改**：在 `_messages_payload` 里 `entries = [...]` 之后、构造 payload 之前，
加一次合并（只在 `api_mode == "messages"` 时做）：

```python
def _merge_messages_entries(entries: list[dict]) -> list[dict]:
    """Anthropic 契约：一轮的所有 tool_result 必须合并进同一条 user 消息。

    loop 每个 tool 结果是一条独立消息，逐条投影会产生连续同角色消息，
    并行工具一多就会被协议拒绝。这里把相邻的同角色 list-content 消息合并。
    """
    merged: list[dict] = []
    for entry in entries:
        prev = merged[-1] if merged else None
        if (
            prev is not None
            and prev.get("role") == entry.get("role")
            and isinstance(prev.get("content"), list)
            and isinstance(entry.get("content"), list)
        ):
            prev["content"] = [*prev["content"], *entry["content"]]
            continue
        merged.append({**entry, "content": (
            list(entry["content"]) if isinstance(entry.get("content"), list)
            else entry.get("content")
        )})
    return merged
```

注意 `_message_entry` 的普通 user 分支返回的是**字符串** content，不会被误合并（条件里要求两边都是 list）。
但会出现「tool_result 消息 + 紧跟一条字符串 user 消息」的相邻同角色情况（比如 steer 注入），
所以合并函数还要处理：如果 `prev` 是 list 而 `entry` 是 str，把 entry 包成
`[{"type": "text", "text": <str>}]` 再合并。**先写测试再改。**

**验收**：新增测试——两条 TOOL 消息投影到 messages 协议后只产出 1 条 user 消息，
其 content 有 2 个 `tool_result` block，且 `tool_use_id` 顺序与原消息一致。

---

## P1-8. 工具表被静默截断：装了 MCP 之后工具会凭空消失

**根因位置**：`app/agent_runtime/loop.py:1685`：`selected = selected[: params.tool_limit]`。
无日志、无事件、无告警。

**现状数字**：`app/**` 里静态 `ToolSpec` 已有 **46 个**，Studio 传 `tool_limit=64`
（`conversation_bridge.py:922`）。再加 capability 工具（按 enabled_recipes 动态）
和 MCP 工具（`mcp_provider` 按配置注册），越界很容易。

**为什么严重**：截断按**注册顺序**发生，而 `BUILTIN_ROW_IDS`（`builtin_bundle.py:567+`）里
`mcp-provider` 排在很后面——也就是说**用户自己配的 MCP 工具是最先被砍掉的**。
用户配好 MCP、模型说「我没有这个工具」，无从排查。

**怎么改**：
1. `_select_tool_schemas` 在截断发生时把被砍掉的名字记下来，通过新增的
   `ToolsTruncated(dropped: tuple[str, ...], limit: int)` 事件在 `LoopStart` 之后 yield 一次。
   （`loop.py` 里照 `BudgetRenewed` 的写法加 frozen dataclass，加进 `__all__`。）
2. `scripts/conversation_bridge.py` 的 `_ConversationActivitySink.__call__` 里认这个 kind，
   在轨迹里落一条 `kind: "notice"` 记录，文案：
   `已注册 N 个工具，超过本轮上限 {limit}，未下发：{names}`。
3. `conversation_bridge.py:922` 的 `tool_limit=64` 提到 **128**，并在旁边写注释说明
   这个值必须大于当前注册总数 + MCP 余量。

**验收**：新增测试——注册 5 个工具、`tool_limit=3`，断言事件流里有一个 `ToolsTruncated`
且 `dropped` 是后两个的名字。

---

## P1-9. 工具描述里全是旧别名，模型被教着去调 schema 里不存在的名字

**用户症状**：模型偶尔调 `read_file` / `edit_file` / `run_command`，虽然
`register_alias` 兜住了，但轨迹里显示的工具名和真实工具名对不上；
更糟的是当模型照描述去查「有没有 edit_file」时会自我怀疑，浪费一轮。

**根因位置**（`app/agent_runtime/coding_tools.py`，规范名是 `Read/Write/Edit/Patch/Glob/Grep/Bash/BashRead/Rewind`，
第 1459 行注释已明说「别名不进 schema」）：
- 1471-1474 `Read` 描述里没问题，但
- 1499-1502 `Write` 描述：「修改现有文件优先用 **edit_file**」
- 1519-1525 `Edit` 描述：「修改前必须先 **read_file**」
- 1677-1681 `Rewind` 描述：「被 **write_file/edit_file/apply_patch** 改过」
- 447-464 `_gate_message`：`"Call read_file first"` / `"re-read the region ... (read_file with offset/limit)"`
- `loop.py:2338-2339` 的超大结果提示里已经用了 `Read`（正确，照它）

**怎么改**：把上述位置的旧名逐字替换为规范名：
`read_file`→`Read`、`write_file`→`Write`、`edit_file`→`Edit`、`apply_patch`→`Patch`、
`run_command`→`Bash`、`glob`→`Glob`、`grep`→`Grep`、`restore_files`→`Rewind`。
**别名注册（1460-1468 行）保留不动**——那是给历史授权用的。
同时 `app/agent_runtime/system_prompt.py:198-208` 的 `coding` section 已经用的是规范名，
不用改，作为参照标准。

**验收**：`grep -n "read_file\|edit_file\|write_file\|run_command" app/agent_runtime/coding_tools.py`
只在 1460-1468 的 `register_alias` 行命中。

---

## P1-10. 跑测试永远要点确认：权限粒度只到「整个 Bash」

**用户症状**：让它改代码，它改完要跑 `pytest` 验证 → 弹确认卡 → 用户点「本会话总是允许 Bash」
→ 等于把整个 shell 全开了。用户要么每次点，要么一次性交出全部权限，没有中间档。

**根因位置**：
- `app/agent_runtime/permission_modes.py:45`：DEFAULT 模式下 `LOCAL_IRREVERSIBLE = ASK`。
- `app/agent_runtime/coding_tools.py:816-826`：`_READ_ONLY_COMMANDS` 白名单里没有任何
  测试/构建命令（`pytest` / `npm` / `node` / `python -m` 都不在），也不可能在——它们确实会写文件。
- `app/agent_runtime/permission_decisions.py`：授权粒度是**工具名**，不是命令前缀。
- 与此同时 `system_prompt.py:206` 明确要求「改完必须用 Bash 跑测试或构建验证，绿了才算完成」。
  提示要求 A、权限拒绝 A，模型每次都要绕一圈。

**怎么改**（做成 CC 那种命令前缀规则，改动集中在两个文件）：

1. `app/agent_runtime/permission_decisions.py`：`PermissionDecisions` 的 `allowed` 除了工具名，
   再支持 `"Bash(<prefix>)"` 形式的条目（例：`Bash(npm run test)`、`Bash(pytest)`）。
   新增方法：
```python
def allows_call(self, tool_name: str, arguments: Mapping[str, Any]) -> bool:
    """工具名整体授权，或命令前缀授权（CC 的 Bash(cmd:*) 规则）。

    前缀匹配只对 Bash 生效，且必须匹配到完整 token 边界——
    Bash(git status) 不能放行 git statusx，更不能放行 git status && rm -rf。
    """
```
   实现要点：
   - 先看 `tool_name in self.allowed`（保持现有行为）。
   - 再看形如 `f"{tool_name}({prefix})"` 的条目：取 `arguments["command"]` 去空白，
     若 `command == prefix` 或 `command.startswith(prefix + " ")` 则放行。
   - **命令里含 `_CHAIN_OPERATORS`（`|&;` 反引号 `$(`）时一律不放行**，防止
     `pytest && rm -rf .` 借前缀过关。这条必须有独立测试。

2. `app/agent_runtime/loop.py:1919` 之后（`_execute_one` 里查 `permission_decisions` 的地方）
   改为调 `allows_call(call.name, call.arguments)`。

3. `app/agent_runtime/permission_modes.py:106-112` 的 ASK 反馈文案里，给 Bash 追加第三个选项：
   `"本会话总是允许 " + 命令前缀`（前缀取命令的前两个 token）。
   相应地 `loop.py:1808-1835` 的 `_pending_user_input` 已经支持 `kind="permission"` + `tool`，
   再加一个 `prefix` 字段透传给渲染层。

4. 渲染层：`electron/renderer/studio.ts` 里处理 permission 芯片的地方，
   收到 `prefix` 就把第二个按钮文案改成「总是允许 `<prefix>`」，回传的授权值写成
   `Bash(<prefix>)`。

**验收**：
- 新增测试：`allows_call("Bash", {"command": "pytest -q"})` 在 allowed 含 `Bash(pytest)` 时 True；
  `{"command": "pytest && rm -rf ."}` 时 **False**；`{"command": "pytestx"}` 时 False。
- 真机：让它改一个文件并跑测试，第一次点「总是允许 pytest」，第二次跑测试不再弹。

---

## P1-11. Grep 强制大小写不敏感，且没有「只列文件」模式

**用户症状**：搜 `Read` 会把所有 `read`、`READ` 全捞出来，200 条上限被垃圾占满，
模型看不到真正想要的定义行，然后加 `offset` 翻页浪费轮次。

**根因位置**：
- `app/agent_runtime/coding_tools.py:122`：`args = [rg_path, "--json", "--no-messages", "-i"]` —— `-i` 写死。
- `app/agent_runtime/coding_tools.py:178`：`re.compile(pattern, re.IGNORECASE)` —— 兜底路径同样写死。
- `coding_tools.py:1573-1605` 的 `Grep` schema 里没有大小写开关，也没有输出模式。

**怎么改**：
1. `Grep` schema 增两个可选参数：
   - `"case_sensitive": {"type": "boolean", "description": "默认 false（不区分大小写）；查标识符时传 true"}`
   - `"output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"], "description": "默认 content"}`
2. `_rg_search` / `_py_search` 各加一个 `case_sensitive: bool` 参数：
   rg 路 `-i` 改为条件追加；Python 路 `re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)`。
3. `output_mode`：
   - `files_with_matches`：把 entries 按 `rel` 去重后每行一个路径输出（这是最省 token 的定位模式，
     模型探索大仓库时应该先用它）；
   - `count`：输出 `rel: N` 每文件命中数。
   两种模式下 `max_results` 语义变成「最多几个文件」。
4. `Grep` 的 description 补一句：「先用 output_mode=files_with_matches 定位文件，
   再对具体文件用 content 模式读细节，不要一上来就拉 200 行匹配」。

**验收**：新增测试——同一固定目录，`case_sensitive=true` 搜 `Read` 的命中数
严格小于 `false` 时；`output_mode="files_with_matches"` 的输出每行都是路径且无 `:行号:`。

---

## P1-12. 工具 examples 被写了但从来没发给模型

**根因位置**：
- `app/agent_runtime/tool_registry.py:364-382`（`schemas_for_model`）会把 `spec.examples`
  挂到 entry 上——**但 loop 不用这个函数**。
- `app/agent_runtime/loop.py:1686-1693` 的 `_select_tool_schemas` 只产出
  `{name, description, parameters}`，examples 直接丢。
- 就算挂上了，`model_client.py:765-788` 的 `_convert_tools` 也只读这三个键，
  额外顶层键会被丢掉（丢掉是对的——OpenAI/Anthropic 的 tool 定义不认未知顶层字段，
  硬塞会 400）。

后果：`Patch` 工具（`coding_tools.py:1659-1670`）精心写的那个 apply_patch 示例，
模型一次都没看到过。而 apply_patch 格式恰恰是模型最容易写错的。

**怎么改**：examples **折进 description 文本**，不要做成顶层字段。
`loop.py:1686-1693` 改为：

```python
    def _describe(spec) -> str:
        text = spec.description
        if spec.examples:
            # examples 不能做成 tool 定义的顶层字段（provider 不认未知键会 400），
            # 折进描述里是唯一能真正到达模型的通道。
            samples = "\n".join(
                json.dumps(example, ensure_ascii=False) for example in spec.examples
            )
            text = f"{text}\n调用示例：\n{samples}"
        return text

    return [
        {
            "name": specs[name].name,
            "description": _describe(specs[name]),
            "parameters": specs[name].input_schema,
        }
        for name in selected
    ]
```
`json` 已在 `loop.py` 顶部 import。

**验收**：新增测试——注册一个带 examples 的工具，断言 `_select_tool_schemas` 产出的
description 含 `调用示例：` 且含示例 JSON；无 examples 的工具 description 逐字不变。

---

## P1-13. 停止按钮在后端退避期间最长 25 秒无反应

**用户症状**：端点抖动时界面显示「等待恢复」，用户不想等了点停止——**没反应**，
最多要等 25 秒才真的停。用户会连点、会以为卡死。

**根因位置**：`app/agent_runtime/loop.py:1010`：`_sleep(bounded_delay_s)` 是一次性阻塞睡眠；
取消检查在**睡完之后**的 1011 行。退避时长是 `_BACKEND_RECOVERY_DELAYS_S = (15.0, 25.0)`
（`loop.py:275`）。

**怎么改**：把整段睡眠切成小片，每片后检查取消与用户中断：

```python
                            # 退避期间必须可中断：停止按钮在 25 秒里毫无反应
                            # 会让用户连点、以为卡死。切片检查，不改总时长。
                            remaining_sleep = bounded_delay_s
                            while remaining_sleep > 0:
                                slice_s = min(0.5, remaining_sleep)
                                _sleep(slice_s)
                                remaining_sleep -= slice_s
                                if loop_scope.is_cancelled:
                                    raise CancelledError(
                                        "cancelled during backend recovery wait"
                                    )
                                if (
                                    params.interrupt_check is not None
                                    and params.interrupt_check()
                                ):
                                    remaining_sleep = 0
                                    break
```
睡完后原来那句 `if loop_scope.is_cancelled: raise ...` 保留（做最终确认）。
`interrupt_check` 命中时不 raise，直接跳出退避、进入下一轮循环开头——
那里（`loop.py:872-881`）本来就有 `interrupt_check` 分支会走正常的 `USER_INTERRUPT` 终态，
这样用户能拿到部分结果和 Receipt，而不是一个异常。

**验收**：新增测试——monkeypatch `loop._sleep` 记录调用次数，
`interrupt_check` 在第 3 次调用后返回 True，断言总睡眠时间 < 2 秒且终态是 `user_interrupt`。

---

## P1-14. 斜杠命令只有 4 条，日常最需要的全缺

**根因位置**：`app/agent_runtime/slash_directory.py:16-21` 只有
`permission` / `model` / `cwd` / `rewind`。

**缺的（按用户需要的顺序）**：
- `/compact` —— 压缩功能整套都在（`compact_messages` + loop 的 compactor），
  但**只能被动触发**。用户明知道要开始一个大任务、想先清一清，没有入口。
- `/clear` —— 开新对话现在只能点侧栏或 Ctrl+N，输入框里没有等价物。
- `/help` —— 用户完全不知道 MP 能干什么。这是新用户第一天就会敲的东西。
- `/cost` —— 用量数据已经在 `#composer-usage-label` 上了，但没有命令能把本会话明细吐出来。

**怎么改**（先做 `/compact` 和 `/help`，这两个价值最高）：
1. `slash_directory.py:16-21` 的 `SLASH_COMMANDS` 加：
```python
    "compact": "立即压缩本对话的上下文（保留结论与未完成计划，释放窗口）",
    "help": "列出当前可用的命令、技能与工具",
```
2. `scripts/conversation_bridge.py:476` 的 `route_slash_command` 加两个分支：
   - `compact`：拿到 `agent_session`（注意当前 `route_slash_command` 在 session 打开**之前**
     被调用，见 890-898 行的顺序——所以这个分支要么把命令路由后移到 session 打开之后，
     要么返回一个 `{"ok": True, "command": {"type": "compact"}}` 让下游处理。
     **选后者**，改动小）。下游收到 `type == "compact"` 时：打开 session →
     `compact_messages(session.derive_messages(), summarize)` →
     `session.replace_messages(..., reason="manual_compaction")` → 返回一条
     「已压缩：N 条消息 → M 条，约省 X token」的系统气泡，**不调模型**。
   - `help`：直接返回 `directory_payload()` 的渲染文本 + 当前 registry 的工具名列表，
     同样不调模型。
3. 渲染层 `electron/renderer/studio.ts` 里处理 `routed.command.type` 的分支加这两种。

**验收**：`/compact` 后 `#composer-usage-label` 的下一轮 input tokens 明显下降；
`/help` 立即返回且不产生模型调用（轨迹页无 model 活动行）。

---

# P2 —— 每天磨一下，但不致命

## P2-15. Composer 运行中把输入框禁用掉了（插话功能被一行代码挡死）

**根因位置**：`electron/renderer/composer.ts:158`：`input.disabled = next === 'running';`

**为什么是问题**：loop 层的插话（`Inbox` + `next-step` / `next-turn` 队列，
`loop.py:887-919` 和 `1149-1187`）是**完整实现并有测试**的能力；Studio 也接了
（`studio.ts:2839-2854` 的 `steerActiveConversation`）。但用 `Composer` 模块的界面
（`companion.ts:152`）因为这一行，用户在跑的时候根本打不了字。
CC / Pi 的核心体验就是「它在干活我继续补充」。

**怎么改**：
```typescript
    function setState(next: 'idle' | 'running') {
      state = next;
      form.dataset.state = next;
      beam.dataset.on = String(next === 'running');
      // 忙态不禁用输入：插话（steer）是这套 harness 的一等能力，
      // 禁用输入等于把 Inbox next-step 通道从界面上焊死。
      submit.title = next === 'running' ? '停下' : '发送';
      input.placeholder = next === 'running' ? '插一句（下一轮生效）…' : placeholder;
    }
```
同时 `form` 的 submit 分支（162-173 行）在 `state === 'running'` 时的行为要分叉：
输入框**有内容**时走插话回调（新增 `onSteer` option，默认回落到 `onStop`），
**空**时才是停止。

**验收**：`tests/composer_surface_test.js` 加断言——`running(true)` 后
`input.disabled === false`；有文本时 submit 触发 `onSteer` 而不是 `onStop`。

---

## P2-16. 麦克风按钮是死的

**根因位置**：`electron/renderer/composer.ts:107`：
```typescript
h('button', { type: 'button', class: 'mcomp-tool', title: '说话' }, [icon('ic-mic')]),
```
没有任何 `addEventListener`。点了什么都不会发生。

**为什么是问题**：MP 是主打语音的产品，主输入条上那个麦克风点了没反应，是最直接的
「这东西没做完」信号。旁边的剪刀（`onScissor`）和附件（`clip`）都是接了的，唯独它没接。

**怎么改**（二选一，**先做 B**）：
- **B（本条要做的）**：`create()` 的 options 加 `onVoice = null`；没传就**不渲染这个按钮**
  （照 `onScissor` 的写法：`const mic = onVoice ? h('button', ...) : null;`）。
  一个不存在的按钮比一个死按钮好。
- A（后续立项）：接 `electron/voice_resident_runtime.ts` 的按住说话。不在本工单范围。

**验收**：不传 `onVoice` 时 DOM 里没有 `title="说话"` 的按钮。

---

## P2-17. Studio 里 Escape 不能停止正在跑的回合

**根因位置**：`electron/renderer/studio.ts:1154-1162`：全局 Escape 只关三个菜单，
关完就 `return`。停止只能靠点发送钮（`studio.ts:2858-2870`）。

**怎么改**：在 `closeWindowMenu()` 那一段之后、`return` 之前插入：
```typescript
    // 菜单都关掉了还在跑：Escape = 停止本回合（CC / Pi 同款肌肉记忆）。
    // 顺序很重要——先让 Escape 关菜单，第二次 Escape 才停任务。
    const menuWasOpen = /* 上面三个菜单里有任意一个原本是打开的 */;
    if (!menuWasOpen && studioComposerBusy && pendingConversation) {
      void Data.stopConversation(pendingConversation.requestId);
    }
    return;
```
`menuWasOpen` 要在关闭它们**之前**采集（现在的代码是无条件关，得先读一次 hidden 状态）。
另外输入框内的 keydown（`studio.ts:2886-2905`）已经有 Escape 分支关 slash 菜单，
它不冒泡到 document 之前先 `closeSlashMenu()`，行为正确，不用改。

**验收**：跑一个长任务，按一次 Escape（无菜单打开）→ 出现「正在停止…」。

---

## P2-18. 回合结束后输入框不自动回到焦点

**根因位置**：`electron/renderer/composer.ts:154-160` 的 `setState` 只改 disabled/title；
`studio.ts` 的 `setComposerRunningState(false)` 同样没有 focus。

**症状**：一轮答完，用户想接着问，必须先用鼠标点一下输入框。每一轮都点一次。

**怎么改**：`setComposerRunningState(running)` 里 `running === false` 分支末尾加
```typescript
  if (!running) {
    // 答完就能接着打字：每轮都要用鼠标点一次输入框是最廉价的体验损耗。
    // 但用户正在别处输入（比如设置面板）时不要抢焦点。
    const active = document.activeElement;
    const isTyping = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (!isTyping) document.querySelector<HTMLTextAreaElement>('#composer-form textarea')?.focus();
  }
```
`composer.ts` 的 `setState` 同样处理（它已经 export 了 `focus()`）。

---

## P2-19. 附件只收图片

**根因位置**：`electron/renderer/composer.ts:95`：`accept: 'image/*'`，
且 116-126 行只走 `readAsDataURL`。

**症状**：想把一份日志、一段 CSV、一个 `.py` 拖进来问，做不到。而
`studio.ts` 那条 composer 走的是 `composerAttachments` 路径（贴的是文件**路径**，
`studio.ts:2923-2926`），能力其实是有的，只是 `Composer` 模块这条没接。

**怎么改**：`accept` 改成 `'image/*,.txt,.md,.log,.csv,.json,.py,.ts,.js'`；
非图片走 `readAsText` 并在 `attachments` 里记 `{name, text}`（不塞 dataURL，
一个 10MB 日志转 base64 会把渲染进程卡住）；`safeThumb` 拿不到 src 时已经会回落成
文件图标（143-149 行），不用改。超过 200KB 的文本文件拒绝并提示用路径方式。

---

## P2-20. token 估算每轮把整个上下文逐字符过一遍 `unicodedata`

**根因位置**：`app/agent_runtime/token_estimate.py:47-54`：
```python
def _count_cjk(text: str) -> int:
    import unicodedata
    return sum(1 for ch in text if unicodedata.east_asian_width(ch) in ("W", "F"))
```
`loop.py:817` 和 `834-836` 每轮至少调 2 次、压缩时调 4 次，每次遍历全上下文。
10 万字上下文 = 每轮 20-40 万次 Python 层函数调用 + 元组比较。

**症状**：不会崩，但每轮多出几十到几百毫秒的纯 CPU 空转，叠在本来就慢的响应上。

**怎么改**：换成码点区间判断，语义等价且快一个量级：
```python
_CJK_RANGES = (
    (0x1100, 0x115F), (0x2E80, 0xA4CF), (0xAC00, 0xD7A3),
    (0xF900, 0xFAFF), (0xFE30, 0xFE4F), (0xFF00, 0xFF60),
    (0xFFE0, 0xFFE6), (0x20000, 0x2FFFD), (0x30000, 0x3FFFD),
)

def _count_cjk(text: str) -> int:
    """East-Asian Wide/Fullwidth 的码点区间近似。

    原实现逐字符调 unicodedata.east_asian_width，10 万字上下文每轮要过
    20-40 万次；这是纯粹的估算函数，区间判断足够准且快一个量级。
    """
    count = 0
    for ch in text:
        code = ord(ch)
        for low, high in _CJK_RANGES:
            if low <= code <= high:
                count += 1
                break
    return count
```
**改之前先写一条对拍测试**：对一段混合中英日韩 emoji 的样本，新旧实现的差值 < 2%。
超过就说明区间选错了，回退不要硬改。

---

# 附：改完之后的一次性总验收

```bash
python -m pytest -q
npm test
npm run typecheck
```

真机走查清单（按顺序做，每条都要肉眼确认）：

1. Studio 问一个需要长回答的问题 → 文字**逐段出现**（P0-1）。
2. 连聊 6 轮 → `#composer-usage-label` 的 input tokens 增长明显慢于改前（P0-2）。
3. 问「今天几号」→ 与系统日期一致（P0-5）。
4. 在工作区放 `MAGIC_POINTER.md` 写一条奇怪规约 → 模型遵守（P1-6）。
5. 让它改文件并跑测试 → 点一次「总是允许 pytest」，第二次不再弹（P1-10）。
6. 长任务跑起来后按 Escape → 出现「正在停止…」（P2-17）。
7. 长任务跑起来后在输入框打字 → 能打，回车后出现排队气泡（P2-15）。
8. 一轮答完 → 光标已经在输入框里（P2-18）。
