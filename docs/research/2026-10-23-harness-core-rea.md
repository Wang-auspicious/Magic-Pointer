# Claude Desktop agent harness（Claude Code CLI + claude-agent-sdk）核心机制静态逆向

日期：2026-10-23。目的：为 Magic Pointer 后端重构提取 agent harness 的机制与常量。

**声明**：全程只读静态分析。未启动任何应用、未执行任何被分析包的引导代码、未联网、未向
claude.ai 或任何远端发请求。对 ClaudeDesktopRE 语料与本机已下载的 Claude Code 二进制只做
字节读取与文本/AST 分析；所有写入只发生在本 worktree 与系统临时目录。

## 0. 语料、别名与引用约定

| 别名 | 指向 |
| --- | --- |
| SDK | `ClaudeDesktopRE/pretty/index.chunk-CC1Xit3_.js`（asar 内捆绑的 @anthropic-ai/claude-agent-sdk 0.3.293，report/11 已定位）。行号 = 该文件 prettified 行号 |
| M | `ClaudeDesktopRE/pretty/main-index.chunk.js`（桌面主进程），行号引用沿用 report/11、report/14 |
| CLI295exe | `%APPDATA%\Claude\claude-code\2.1.295\d2e29494ec83\claude.exe`（259,509,920 B，2026-10-12 下载，构建信息 VERSION "2.1.295"、GIT_SHA 07e8f67…、BUILD_TIME 2026-10-08） |
| CLI260exe | `%LOCALAPPDATA%\Claude-3p\claude-code\2.1.260\claude.exe`（217,771,680 B，2026-09-06 下载） |
| CLI295 | CLI295exe 内嵌明文 JS（Bun standalone 尾部源 blob）。**绝对偏移公式：`CLI295exe@X` = blob 相对偏移 + 211,022,956**；blob 区间 [211,022,956, 255,424,180) ≈ 44.4 MB，边界由可打印密度扫描与 `// @bun @bytecode`/`// Version:` 模块分隔符定位 |
| CLI260 | 同法切出，基址 **180,157,944**，blob 区间至 212,220,478 ≈ 32.1 MB |

关键定位证据：CLI295 blob 头部 `// @bun @bytecode\n// Claude Code is a Beta product…\n\n// Version: 2.1.295\nimport{realpathSync…`（CLI295exe@2,110,229,56 起）；CLI260 对应 `// Version: 2.1.260`（CLI260exe@180,158,538 区域）。二进制尾部还有独立的字节码与 trailer 区，本报告只引用明文源区。

**为什么 CLI 证据来自本机下载的二进制**：asar 语料 pin 的是 CLI 2.1.293（report/14 §4.1，
`M:59785` 版本表 + baseUrl），但该版本目录已不在本机（现存 2.1.260 / 2.1.295 / 2.1.299）。
Desktop 包内只有 SDK 桥（spawn 参数、env、权限桥），B/C 类常量在 CLI 二进制里。因此：
- 机制类事实以 CLI 2.1.295（与 pin 相差 2 个 patch 版本）为主证；
- B 类关键常量在 CLI 2.1.260 交叉验证一致（见 §B0）；
- 2.1.299 未分析，版本漂移如实披露。

**REA 运行记录**（`node C:/Users/zjz65/projects/rea-npm/node_modules/rea-agents/scripts/rea.mjs analyze-javascript-application <dir> --json`，方法沿用 `docs/research/2026-10-23-minttr-rea-collector.md`）：

| 输入目录 | 结果 |
| --- | --- |
| SDK chunk 单文件目录 | 成功：1 个 JS、1,621,327 文本字节、299,674 AST 节点、79 findings、0 解析失败 |
| CLI295 blob 按模块分隔符拆成 2328 个模块文件（48 MB）后整目录输入 | 成功（`--max-old-space-size=8192`）：2328 个 JS 全部解析、44,537,639 文本字节、9,218,844 AST 节点、193,217 findings、0 解析失败 |
| 含本报告主要证据的 7 个模块的窄目录 | 成功：7 个 JS、5,684,613 字节、1,302,957 AST 节点、2,665 findings、0 解析失败 |

REA 只把代码当静态文本分析，未执行 bundle bootstrap；其 findings 用于定位，本报告的事实
全部由人工字节核对（`CLI295exe@偏移`）背书。

---

## A. 工具供给：schema 如何进入模型请求，延迟加载机制

### A1. 每请求附带全量 schema（listed 工具）

工具不是靠模型先调用发现工具才知道的（核心工具如此）。CLI 把每个 listed 工具序列化进
**每次**模型请求的 `tools` 数组，条目形如：

```js
nn = {name: e.name, description: Cn.description, input_schema: Wn}   // Wn = zod inputSchema → JSON Schema
… if (e.strict === !0) { nn.strict = !0; nn.input_schema = so.schema }   // strict 模式重校验
… if (n.deferLoading) Mn.defer_loading = !0
… if (n.cacheControl) Mn.cache_control = n.cacheControl
```

（CLI295exe@220,239,415–220,240,860，序列化函数 `GL`；zod→JSON Schema 经 `_zod.toJSONSchema`
管线，CLI295exe@211,604,121。）schema 有按 cacheKey 的记忆化与 `schemasSentFromRecord`
复用（CLI295exe@220,237,321），并有 token 预算遥测 `tengu_context_size`
（`mcp_tools_count/mcp_tools_tokens/non_mcp_tools_count/non_mcp_tools_tokens`，
CLI295exe@220,242,654）——工具定义本身计入上下文成本。

请求前工具集可变：`refreshTools()` / `refreshMcpClients()` 在循环每轮之间刷新（MCP 重连后
中轮换新工具，CLI295exe@228,052,000 区域 `tengu_mcp_tools_refreshed_mid_turn`）。

### A2. 延迟加载（deferred）确实存在，但只对 MCP 与少量附加工具

分类器（模块导出名即 `isDeferredToolByEngine`，CLI295exe@219,124,290 起）：

```js
function RLe(e,r){ if(e.alwaysLoad===!0)return!1; if(O(e,r))return!1; if(YOn())return!1; return T(e) }
function T(e){ if(e.isMcp===!0)return!0;                      // 所有 MCP 工具默认 deferred
              if(Tfs()&&yw(e,d))return!0;                     // flag 门控附加集（ReportFindings/Brief/ShareOnboardingGuide）
              if(yw(e,Cfs()))return!0;                        // 配置的 defer 集
              return e.shouldDefer===!0 }
function s(e,r=MI()){ …; if(e.name===Sl)return!0;             // ToolSearch 本身永不 defer
              if(e.name===ha)return!0;                        // Task/Agent 永不 defer
              if(e.name===u)return!0;                         // Brief 工具永不 defer
              if(l(e)&&!Rfs())return!0; … }                   // PushNotification（flag）
```

即：**Bash/Read/Write/Edit/Grep/Glob 等内置核心工具不在任何 defer 候选集里，永远以全
schema 进请求**；deferred 的默认对象是全部 `mcp__*` 工具与个别 flag 门控工具。

ToolSearch 工具的自身描述（原文，CLI295exe@219,124,290 前部模块）：

> "Fetches full schema definitions for deferred tools so they can be called.
> Deferred tools appear by name in \<system-reminder\> messages." …
> " This tool takes a query, matches it against the deferred tool list, and returns the matched
> tools' complete JSONSchema definitions inside a \<functions\> block. Once a tool's schema appears
> in that result, it is callable exactly like any tool defined at the top of the prompt.
> Result format: each matched tool appears as one \<function\>{"description": …, "name": …,
> "parameters": {...}}\</function\> line inside the \<functions\> block — the same encoding as the
> tool list at the top of this prompt.
> Query forms: - "select:Read,Edit,Grep" — fetch these exact tools by name … "

未加载即调用会失败："calling the tool fails with InputValidationError"。另有占位工具
`DeferredToolPlaceholder`："Reserved placeholder that keeps deferred tool loading active; never
call this tool."（CLI295exe@215,148,190）。

开关：`ENABLE_TOOL_SEARCH`（settings/env，取值 true/false/"force"/"auto"/"auto:N"，N≥100 才算
开启；非一方 API host 默认关闭并提示代理需转发 `tool_reference` 块，CLI295exe@216,043,454–
216,046,120）。**Desktop 侧在 flag 1129419822 后设 `ENABLE_TOOL_SEARCH="auto"`**
（report/11 §5，BBZ:12545–12580）。

### A3. 会话中途的工具增删与压缩保持

- 消息流支持 `tool_addition` / `tool_removal` system 内容块，携带
  `{type:"tool_definition",definition}` / `{type:"tool_reference",name}`
  （CLI295exe@215,264,565）——ToolSearch 命中后即以 tool_addition 注入会话。
- 压缩摘要携带 `pre_compact_discovered_tools`："Deferred-tool names discovered before this
  compaction. extractDiscoveredToolNames reads this back on the next turn so the tool-schema filter
  keeps including them after the tool_reference-carrying messages were summarized away."
  （CLI295exe@212,240,169）——压缩后已发现工具的 schema 必须重新进场。
- MCP 规模上限：单 server 最多 **128** 个工具（`xpo=128`）、最多 **32** 个 server
  （`Ppo=32`），超限会在 manifest 校验阶段拒绝（CLI295exe@218,868,040 区域）。

### A4. Desktop/SDK 侧的供给管线（asar 语料，复核）

- SDK spawn 基础参数：`--output-format stream-json --verbose --input-format stream-json`
  （SDK:42925，本次复核一致）；`tools` 选项 → `--tools ""|list|default`（SDK:42969）；
  skills 翻译成 allowedTools 规则（report/11 §6，SDK:42905–42912）。
- MCP 由桌面交给 SDK：`--mcp-config '{"mcpServers":…}'` + `--strict-mcp-config`，配
  `MCP_TOOL_TIMEOUT` / `MCP_CONNECT_TIMEOUT_MS=10000` / `MCP_CONNECTION_NONBLOCKING=0`
  （report/11 §5、report/14 §2.4）。工具名进模型时带 `mcp__<server>__<tool>` 命名空间
  （report/14 §2.3，M:205061）。
- 工具注册表本体在 CLI 进程内，不在 Desktop bundle（report/11 §7.3）。

---

## B. Bash 工具策略（常量全部来自 CLI 明文源，两版本交叉）

### B0. 版本交叉

| 常量 | CLI 2.1.295 | CLI 2.1.260 |
| --- | --- | --- |
| 默认超时 | `a=120000`（CLI295exe@217,984,064 区域，`kY(){return Bne()}` 见 @220,212,524） | `XIo=120000`（CLI260exe@187,725,823） |
| 最大超时 | `i=600000` | `QIo=600000` |
| 输出默认内联上限 | 30000（见 B3） | `eln=30000`，env 上限 `Zan=150000`（CLI260exe@185,502,852） |

### B1. 超时（模块导出 `Bne/zTe/cce/bcs/TOn/COn`，CLI295exe@2,110,229,56 基址下 blob 6,961,108–6,961,500）

```js
var a=120000, i=600000;
function Bne(env){ let e=env.BASH_DEFAULT_TIMEOUT_MS; if(e){let t=Md(e); if(!isNaN(t)&&t>0)return t} return a }
function zTe(env){ let e=env.BASH_MAX_TIMEOUT_MS; if(e){…return Math.max(t,Bne(env))} return Math.max(i,Bne(env)) }
var s=1800000;
function cce(){ return Math.min(Math.max(7200000,zTe()),2147483647) }        // 后台绝对上限：≥2h
function bcs(env){ return Math.max(s,Bne(env)) }                             // 后台默认：≥30min
function TOn(n,e){ return n!==void 0&&n>0?e:void 0 }
var _=2000;
function COn({requestedTimeoutMs,isMainAgent,canAutoBackground,env}){ …      // CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS
  return Math.min(n, Math.max(r, 2000)) }
```

- 默认 120 000 ms；前台最大 600 000 ms；`BASH_DEFAULT_TIMEOUT_MS`（>0 即生效）与
  `BASH_MAX_TIMEOUT_MS`（有效 max = max(设定, 默认)）可覆盖。
- **单次调用可覆盖**：输入 schema `timeout` 描述为 "Optional timeout in milliseconds
  (max ${jL()} for a foreground command)"（CLI295exe@223,714,238）。
- 调用点钳制（CLI295exe@223,739,321）：
  `Ft = min(requested || kY()/*默认*/, background?cce():jL()/*max*/, session.maxTimeoutMs ?? Infinity)`，
  请求值被压低时发遥测 `timeout_clamped{requestedMs,appliedMs}`。
- `run_in_background:true` 时 `timeout` 语义变为后台存活时限：
  `ino(e)=Math.min(e??NYt(),cce())`，其中 `NYt()=bq()?Math.max(600000,Bne()):bcs()`
  （CLI295exe@218,568,123 区域）；工具描述原文 "…default ${NYt()} ms, max ${cce()} ms…
  at that limit it is stopped and you are notified"。
- 超时转后台的自动阈值：`CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`（下限 2000 ms，仅主线程
  且可后台时钳制请求超时，`COn`）。

### B2. 后台任务

- 远程/parity 供给面每会话后台 Bash 上限 **4**（`ONr=4`；文案 "Up to ${ONr} background Bash
  commands, stopped when this machine detaches."，CLI295exe@236,374,860 与 @238,749,882）。
  后台注册类常量：保留最近 `ir=16` 个已结束调用、状态尾读 `ar=8192` 字符、人工停止轮询
  `dr=1000` ms（CLI295exe@236,374,860 起 class `tn`）。
- 本地后台 shell 会被系统内存压力收割（reason `memory_pressure`，文案 "Claude Code stopped it
  because the system was critically low on memory…"；可用
  `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` 关闭，CLI295exe@219,596,743–219,597,436）。
- validateInput 的拒绝码（CLI295exe@223,728,418）：主线程裸 `sleep` 拦截（errorCode 10，
  "…use Monitor with an until-loop… Do not chain shorter sleeps to work around this block"）；
  后台槽位不可用（errorCode 12，"served call has no background slot"）；描述必填门
  （errorCode 11）。

### B3. 输出截断与持久化

- 设置 `bashOutputMaxChars`：schema 描述原文 "How many characters of a successful Bash or
  PowerShell command's output Claude receives inline (**default 30000; values clamp to
  4000-128000**). Output past this is saved to a file and Claude receives a short preview plus the
  path. When set, this also replaces BASH_MAX_OUTPUT_LENGTH, which on its own only sizes the
  read-back window."（CLI295exe@212,874,488）。实现：`c1n=4000,k3e=128000`
  （CLI295exe@211,824,211）；`_fr=30000,sso=150000` + `BASH_MAX_OUTPUT_LENGTH` env 路径
  （CLI295exe@219,109,566）。
- 工具定义：Bash `maxResultSizeChars = Lqe()`（=钳制后的 bashOutputMaxChars ?? 30000），
  `persistenceThresholdCeiling = k3e(128000)`；Read 工具则 `maxResultSizeChars: Infinity`
  （CLI295exe@223,723,598、@222,936,262）。
- 超阈值（`min(maxResultSizeChars, 128000)`，可被 per-tool 配置覆盖）即落盘（`i4`，默认写
  入上限 `XTs=1073741824` 1 GiB；磁盘配额 5 GB 常量 HCt/Vgr，持久文件 `truncatedAtBytes`
  上限 `Gye=67108864` 64 MiB，CLI295exe@216,333,686），模型收到：

  ```
  <persisted-output>
  Output too large (58.2k). Full output saved to: <path>
  Preview (first 2.0k):
  …（CTe=2000 字符预览，行边界优先）…
  </persisted-output>
  ```

  （`ATe`/`Art`，CLI295exe@217,968,700–217,975,000。）落盘失败则降级内联硬截断：
  `<truncated-output> … It could not be saved, so only the first N are shown; the rest was
  dropped…`（同段 `Cpr`）。
- 空输出处理：`(X completed with no output)` + 遥测 `tengu_tool_empty_result`（同段 `Z()`）。
- 旧结果回收：上下文中的旧持久化输出可被替换为 `[Old tool result content cleared]`
  （`tengu_hawthorn_steeple` 门控，CLI295exe@215,721,210）。
- 中断语义：`<error>Command was aborted before completion</error>` 且 `is_error`
  （`mapToolResultToToolResultBlockParam`，CLI295exe@223,724,000 区域）。

### B4. 只读判定与自动放行

- 工具层：Bash `isReadOnly(e,n){return !_v(Ue)&&SQe(e,FAn(n))}`，
  `isConcurrencySafe(e){return this.isReadOnly?.(e)??!1}`——**判定只读即可并发执行**；
  `notReadOnlyReason` 走分析器 `GEn(command, argv, {sessionEnvVarKeys})`，allow 时返回
  `{behavior:"allow"}`（CLI295exe@223,724,000 区域）。PowerShell 工具同构
  （`isReadOnly(e){return on(e)}`，CLI295exe@234,779,035）。
- 命令安全表：git 子命令逐 flag 的 safe/unsafe 分类表（`"git status":{safeFlags:{…}}`、
  `"git blame"` 等，CLI295exe@216,223,144 起），`"none"`=无参 flag 安全、`"string"`=带一个
  字符串值安全。
- 输入净化：`command` 拒绝含隐藏控制字符——"command contains control characters that would
  be hidden in the approval dialog"（CLI295exe@223,714,238）；协调者态只放行可验证只读且
  不出工作目录、无 `$(…)`/变量/`..` 参数的命令（文案集 CLI295exe@219,223,455）。
- Windows 声明："This tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell
  syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%`…"（`wxt()`，
  CLI295exe@220,213,132）。
- 危险 git 操作的正则识别在 Desktop 主进程也有副本：`/\bgit\s+(commit|push|merge(?<!-)|rebase|
  cherry-pick|revert|am|apply)\b/`（report/11 §7.3，M:182370）。

---

## C. 循环控制

### C1. 终止原因全集（`Mw`，CLI295exe@212,071,216–212,071,470）

```
blocking_limit, rapid_refill_breaker, prompt_too_long, image_error, model_error, api_error,
malformed_tool_use_exhausted, aborted_streaming, aborted_tools, stop_hook_prevented, hook_stopped,
tool_deferred, max_turns, background_requested, completed,
budget_exhausted, structured_output_retry_exhausted, tool_deferred_unavailable, turn_setup_failed
```

result 消息 subtype：`error_during_execution / error_max_turns / error_max_budget_usd /
error_max_structured_output_retries`（CLI295exe@212,208,024）。错误→处置映射：
`image_error→retry`、`model_error→pause`、`api_error(rate_limit)→pause`、
`malformed_tool_use_exhausted→retry(unreadable_tool_call)` 等（CLI295exe@227,956,568）。

### C2. 查询循环内的停止/纠正逻辑（CLI295exe@228,048,255–228,057,000）

| 情形 | 处置 | 上限 |
| --- | --- | --- |
| stop_reason `end_turn`/`stop_sequence`（非 compact、有正文） | `completed`（先跑 Stop hook） | — |
| 纯 thinking 无正文 | 注入 nudge meta 消息后重试（`thinking_only_retry`） | **1 次**（guard `thinkingOnlyNudged`；再犯 `nudge_exhausted`） |
| stop_reason `tool_use` 但 0 个工具调用 | tombstone 本轮消息 + meta 消息重试（`malformed_tool_use_retry`） | **1 次**；再犯写入 "The model's tool call could not be parsed (retry also failed)." → `malformed_tool_use_exhausted` |
| max_output_tokens 截断（可恢复续写路径） | `truncated_response_recovery` 续写 | **3 次**（`br=3`，guards `maxOutputTokensRecoveryCount`，CLI295exe@227,984,543） |
| 模型拒答 | `refusal_retry`（可换 fallback model、抢救已产出文本） | guard `refusalRetrySpent`（1 次） |
| Stop hook 连续阻止 | 计数继续循环 | `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8` 次 → 强制结束本轮（"A hook blocked the turn from ending N consecutive times — overriding…"）→ `completed` |
| 轮次超限 | `max_turns_reached` system 消息 → `max_turns` | `--max-turns`（仅 --print 生效，无默认上限；SDK/桌面自设，如一次性采样 maxTurns:1，report/11 §3） |
| 工具请求结束回合 / PostToolBatch hook 阻止 / 工具被延迟 | `completed` / `hook_stopped` / `tool_deferred` | — |
| 中止 | `aborted_streaming` / `aborted_tools` | — |

结构化输出校验重试：`MAX_STRUCTURED_OUTPUT_RETRIES ?? 5`（`Mgn=5`，
CLI295exe@232,459,815），耗尽 → `structured_output_retry_exhausted`。
Stop-hook 型子代理熔断："Hooks: Agent hook did not complete within 50 turns"（
CLI295exe@222,312,121）；fork 型子代理默认轮数 50（`GZt=50`，CLI295exe@221,932,303）。

### C3. 重复/拒绝检测

- 没有找到"同一工具调用重复 N 次即熔断"的数值断路器（见不可证明 §E2）。
- 权限拒绝熔断存在：`E1={maxConsecutive:3,maxTotal:20}`（CLI295exe@221,931,863）；触发文案
  "3 consecutive actions were blocked. Please review the transcript before continuing." /
  "20 actions were blocked this session. …"（CLI295exe@222,749,074），结束回合；超时回退
  `WZt=120000`。
- result 携带 `permission_denials` 与 `safety_stops`（后者由 refusal/特定错误递增，
  `recordSafetyStop`，CLI295exe@222,059,407、@222,063,140）。

### C4. API 传输层重试（CLI295exe@222,118,989–222,132,400）

```js
var Xdr=10, Qdr=300, rYe=15, …, mcr=60000, gcr=300000, lYe=21600000, aJr=30000;
function RYe(){ …CLAUDE_CODE_MAX_RETRIES…(无 watchdog 时钳到 15)… return watchdog?Qdr:Xdr }
```

- 默认重试 **10** 次；`CLAUDE_CODE_RETRY_WATCHDOG` 开启时 **300** 次；
  `CLAUDE_CODE_MAX_RETRIES` 可覆盖（无 watchdog 上限 15）。
- 服务器 `retry-after` > 60 000 ms 即放弃（`api_retry_after_too_long`）；watchdog 模式单次
  等待上限 5 min、总等待上限 6 h（`gcr=300000`、`lYe=21600000`）。
- 每次重试发 system 消息 `api_retry{attempt,max_retries,retry_delay_ms,error_status,…}`；
  首字节无响应（`CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`）单独计数且"normally one retry"
  （CLI295exe@212,249,621）。流空闲超时 = max(env/配置, **300 000 ms**)
  （`NXt(){return Math.max(Vc()??0,300000)}`，CLI295exe@215,403,378）。
- 上下文超限自愈：请求级 maxTokens 下调 `tengu_max_tokens_context_overflow_adjustment`
  （FLOOR_OUTPUT_TOKENS 3000，CLI295exe@222,118,989 区域 `Drn=3000`）。

### C5. 上下文压缩（autocompact）

窗口与阈值（CLI295exe@220,271,721–220,273,856）：

```js
var BAt=13000, Trr=3000, Oie=0.2, Crr=20000;
r6(model) = contextWindow - min(maxOutputTokens, 20000)        // 有效窗口
xY(W)    = W - 13000                                            // compact 触发阈值（token 数）
iLe(W)   = min(W - round(W*0.2), xY(W))                         // 预计算(后台预压缩)阈值：80% 窗口
aLe(used,W): used ≥ W-3000 → "blocked";  used ≥ xY(W) → "compact";  used ≥ W-20000 → "warn"; else "ok"
```

- 即：**压缩触发 = 有效窗口 − 13 000 tokens**（非百分比）；预压缩在 80% 窗口即可开始；
  `blocked`（blocking_limit）在有效窗口 − 3 000。
- 覆盖项：`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（0–100%，钳到 W−13000）、
  `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`；设置 `autoCompactWindow`（100 000–1 000 000 或
  "auto"，CLI295exe@212,900,974）；`autoCompactEnabled` 默认 true（CLI295exe@214,215,159）；
  `DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT` env（CLI295exe@212,322,145）。
- **快速回填熔断**：compact 后 3 轮内又到阈值，连续 3 次 →
  "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous
  compact, 3 times in a row." → 停止继续压缩并终止（`rapid_refill_breaker`，
  `YAt=3`，CLI295exe@220,277,549、@221,994,130）。
- 压缩后已发现 deferred 工具名要回填（§A3）；compact 后轮数计数 `turnCounter++`
  （`tengu_post_autocompact_turn`，CLI295exe@228,056,000 区域）。
- 微压缩（microcompact）在 Desktop 启动 env 里被禁用：`DISABLE_MICROCOMPACT="1"`
  （report/11 §5，BBZ:12520–12580）。

---

## D. 已证明（摘要，均带证据位置）

1. 工具 schema 随每次模型请求的 `tools` 数组附带（name/description/input_schema[strict/cache_control/defer_loading]）——CLI295exe@220,239,415。
2. 延迟加载仅作用于全部 MCP 工具 + flag/配置集；核心工具（Bash/Read/Write/Edit/Grep/Glob）与 ToolSearch/Task 永不全量延迟——CLI295exe@219,124,290。
3. ToolSearch 用 `select:`/关键词查询，结果以 `<functions><function>{…}</function></functions>` 块注入，未加载先调用报 InputValidationError——CLI295exe@219,124,290 模块原文。
4. 会话中途 tool_addition/tool_removal system 块增删工具；压缩摘要带 pre_compact_discovered_tools——CLI295exe@215,264,565、@212,240,169。
5. Bash 默认超时 120 000 ms、前台最大 600 000 ms、env 可覆盖、单次调用 `timeout` 可覆盖并被钳制（telemetry timeout_clamped）——CLI295exe@217,984,064、@223,739,321；CLI260exe@187,725,823 交叉一致。
6. 后台默认时限 ≥30 min、绝对上限 ≥2 h 且 ≤2^31−1；CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS（下限 2000 ms）触发超时转后台——CLI295exe@217,984,064、@218,568,123。
7. 输出内联默认 30 000 字符（钳 4 000–128 000），超出落盘 + `<persisted-output>` + 2 000 字符预览 + 路径；落盘失败降级 `<truncated-output>` 硬截断；持久文件 64 MiB 截断上限、默认写入上限 1 GiB——CLI295exe@212,874,488、@219,109,546、@217,968,700–217,975,000、@216,333,686、@211,824,211。
8. 远程供给面每会话后台 Bash 上限 4；本地后台 shell 有内存压力收割——CLI295exe@236,374,860、@219,596,743。
9. 只读判定 = 命令安全分析器（git 逐 flag 分类表），只读即并发安全；控制字符命令直接拒绝；Windows 用 Git Bash POSIX 语义——CLI295exe@216,223,144、@223,724,000、@223,714,238、@220,213,132。
10. 循环终止原因 19 值枚举 + 4 个 error subtype；malformed-tool-use 与 thinking-only 各重试 1 次；截断恢复 3 次；Stop-hook 连续阻止默认 8 次封顶——CLI295exe@212,071,216、@228,048,255–228,057,000、@227,984,543。
11. API 重试默认 10 次（watchdog 300，env 覆盖无 watchdog 钳 15），retry-after>60 s 放弃，流空闲超时下限 5 min，首字节超时通常只重试 1 次——CLI295exe@222,118,989、@215,403,378、@212,249,621。
12. 压缩阈值 = 有效窗口 − 13 000 tokens（有效窗口 = 窗口 − min(maxOutputTokens,20 000)），预压缩 80% 起，blocked = 有效窗口 − 3 000；compact 后 3 轮内回填连续 3 次触发 rapid_refill_breaker——CLI295exe@220,271,721–220,273,856、@220,277,549。
13. 权限拒绝熔断 3 连续/20 累计；结构化输出重试默认 5——CLI295exe@221,931,863、@232,459,815。
14. SDK spawn 协议：stream-json 双向 + `--permission-prompt-tool stdio`（有 canUseTool 时）+ `--tools`/`--mcp-config`/`--max-turns`——SDK:42925–42990（本次复核）。

## E. 不可证明 / 未取得（不得编造）

1. **asar 所 pin 的 CLI 2.1.293 二进制不在本机**（现目录为 2.1.295/2.1.299）；B/C 常量引用
   自 2.1.295（主）与 2.1.260（交叉）。2.1.299 未分析；2.1.293 与 2.1.295 之间若有小改未
   覆盖。
2. **数值化的"重复相同工具调用"断路器**：在 2.1.295 明文源中按 identical/same tool call/
   repetition/loop guard/safety 等词穷举未命中数值阈值；已证实的只有权限拒绝计数（3/20）与
   malformed 重试 1 次。若该机制存在且在服务端或以其他命名实现，包内不可达。
3. **API 重试的完整退避公式**（`T$` 函数的底数/抖动参数）：默认次数、上限、retry-after 处
   理已证，公式逐项未展开。
4. **模型侧/服务侧行为**（quota 判定、fallback 决策的服务端部分、tool_reference 的 API
   端语义）：静态字节内不可证。
5. **CLI 2.1.260→2.1.295 新增机制的完整 diff**（如 bashOutputMaxChars 设置项 2.1.260 无、
   ToolSearch 门控细节）：只做点查交叉，未做全量 diff。
6. Desktop UI/CSS 侧事实不在本任务范围，未取证。

## F. 对 MP 后端重构的直接落点

- 工具供给采用"每请求全量 schema + 按 token 计价"模型；MCP/低频工具走 deferred + ToolSearch
  形态（名字进 `<system-reminder>`，schema 经 `<functions>` 块注入，压缩后回填）。
- Bash：默认 2 min/上限 10 min/单次可覆盖/超阈值（默认 30 k 字符）落盘 + 2 k 预览，是可直接
  采用的常量组；后台时限语义（timeout=后台存活上限，≥30 min 默认、≥2 h 上限）值得照搬。
- 循环：malformed/thinking-only 各 1 次重试、截断续写 3 次、Stop-hook 阻止 8 次封顶、API 重试
  10 次 + retry-after 60 s 放弃线、压缩阈值"绝对 token 余量（−13 k）而非百分比"、3 轮内回填
  连续 3 次熔断——这组数字是 Claude Code 两版本间稳定的生产常量。

## G. 权限模式阶梯与 auto 定义（2026-10-23 补充，CLI295exe 静态证据）

- 模式枚举与阶梯：`var d0=["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`；权威阶梯 `mr={plan:0,bubble:1,default:1,dontAsk:1,acceptEdits:2,auto:3,bypassPermissions:4}`，`Rz(e,n)` 用它裁决模式抬升是否合法（CLI295exe@212,711,123 区域）。
- 各模式官方描述（zod schema，CLI295exe@212,091,453–212,091,654）：'default'——危险操作提示；'acceptEdits'——自动接受文件编辑；'bypassPermissions'——跳过全部权限检查（需 allowDangerouslySkipPermissions）；'plan'——只规划不执行；'dontAsk'——不提示、未预批则拒；**'auto'——"Use a model classifier to approve/deny permission prompts"（用模型分类器批准/拒绝权限弹窗）**。
- 桌面端批准卡的模式抬升文案（JE 表，cache fc725cbb30.js）：Accept / "Accept and allow edits" / **"Accept and auto mode"** / "Accept and bypass permissions"——批准一个动作时可顺带抬升会话模式；另有独立 onModeChange 通道。
- 桌面端仍在询问时的原因行（同 chunk @101,070–104,640）：bypass 被组织关闭/进程未带 bypass 启动/远程控制中/自动审批暂停等，每条一句解释"为什么这次还在问"。
- auto 模式有可用性闸与熔断（isAutoModeAvailable、circuit breaker `LW()`、`s6` 在熔断时回退 default，CLI295exe@222,701,051、@227,199,562）。

## H. 本批对 MP 的落点（权限批）

- decidePermission 阶梯改为 safe < default < auto(accept_reversible) < bypass 单调放宽：auto 放行 local_irreversible（原与 default 完全同权、每个本地动作都走模型评审后弹卡，即用户反馈"开 auto 也一直弹窗"的根因），external_send/destructive 仍走评审（与 'auto'=模型分类器 官方定义一致），purchase 永远问。
- 权限卡新增"允许并本会话切到自动模式"（Accept and auto mode 模式抬升）：后端按 mode+effect 标 modeRaise，session.answer 校验 modeRaise==='auto' 且非 deny，追加 permission/mode 事件即时生效。
- 卡片文案对齐：中文问句"允许执行 X？"、Bash 预览带"命令："前缀与"完整查看上述命令后再允许。"提示（对应原件 commandHint "Scroll through the whole command to allow it."）。
