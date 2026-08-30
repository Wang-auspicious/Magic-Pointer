# 工具逐行对照审计：MP vs Claude Code vs Hermes vs Pi（2026-08-30）

对照源码：
- **CC** `C:\Users\zjz65\PycharmProjects\claude-code-main\src\tools\`（约 40+ 工具，核心 16）
- **Hermes** `D:\AI_Agents\HermesAgent\tools\`（约 60 工具，Python）
- **Pi** `D:\AI_Agents\pi\packages\coding-agent\src\core\tools\`（8 个，TS，"少而极致"派）
- **MP** 本仓库。真机 boot 实测模型可见 **54 个工具**（`boot_loop_context` → `tools.list()`）。

---

## 0. 本批真机验证（先还账）

| 验证 | 方法 | 结果 |
|---|---|---|
| **落盘回读端到端** | 真实网关模型走 `scripts/conversation_bridge.py`（workspace-write + 预授权 run_command/read_file），令其执行输出 7 万字符的命令 | **PASS**：`.mp/tool-results/call_*.txt` 落盘 64,015 字节全文；模型收到预览+绝对路径后主动 `read_file` 读回，最终回答报出路径与文件结构；5 轮 `succeeded=true`；全程 reasoning 流可见（`thinking` 字段 + `reasoning_chunk` 进度行） |
| **GUI Think 行** | 新探针 `scripts/probe_studio_think.js`：**真实编译产物**（build/electron/renderer/studio.html + 真实 preload.js）+ 真实 `conversations:progress` IPC 通道，灌入 bridge 形状的 `reasoning_chunk`（b64）记录 | **PASS**：Think 行 running 态渲染、摘要实时跟随流式 reasoning；截图 `data/runtime/probe-studio-think-1.0.27.png` 目视确认；console_errors=0 |

诚实边界：截图里的红色"这一轮没有完成"是探针 stub 故意挂起 send 的副作用（真桥会 resolve，真实运行不出现）；探针已入库可回归。

---

## 0.5 实现状态（同日完成，B1–B6 全批次）

| 批 | 内容 | 状态 |
|---|---|---|
| B1 分层 | perception 五件套/Look 的 Capabilities/Recall/SaveSkill 标记 deferred（loop 机制本就支持，40→32 可见）；capability 死代码核实：未注册的 _INDIVIDUAL_RECIPES 条目是数据残留，无死代码可删 | ✅ |
| B2 Edit/Read 智能 | readFileState（未读先写门+修改检测+mtime/hash 双校验+截断拒改）、读去重 stub+force、连读熔断（registry 执行监听 + loop 打点）、五级匹配阶梯（exact→引号→line-trimmed→whitespace→indent-flexible，索引映射取真实子串）、preserveQuoteStyle（含 CJK 开引号上下文）、BOM 保留、空 new 删行、批量 edits[]（对原文匹配+重叠拒绝）、相似文件建议、二进制/设备守卫、apply_patch/restore 的状态维护 | ✅ |
| B3 Shell | cwd 会话持久化（词法 cd 跟踪，`%CD%` 展开时机使 marker 方案不可行）、后台完成通知（watcher 线程→durable inbox next-step，桥经 session_inbox cell 接线）、exit code 落 meta、grep=ripgrep --json 主路+Python 兜底、-A/-B/-C 上下文、offset 分页、凭据打码、glob mtime 降序、白名单补 git 只读子命令+rg/which、默认超时 60→300s | ✅ |
| B4 差异化 | turn_ended 自动化（registry session_end 监听，loop 全部终态收口处触发，模型忘调不再卡锁）、Wait 工具（窗口/元素/文件条件等待，注入探针）、Observe 压缩（零面积剔除/去重/长文本截断/100 上限+截断计数，指纹同视图对齐防假 stale）、Click 迷你回观察（changes_after 变化摘要） | ✅ |
| B6 小项 | Todo status 枚举校验、web_fetch 15min 缓存+重定向显式回显（不自动跟随）、Recall 每会话 3 条聚合、delegate readonly=true（子注册表摘写工具+effect=READ+is_concurrency_safe_for 并行车 道，registry 新增按调用并发判定） | ✅ |
| B5 改名 | CC 风格规范名（Read/Write/Edit/Patch/Glob/Grep/Bash/BashRead/Rewind/Observe/Look/ListApps/ListWindows/GetFocus/Find/Tree/Around/Focus/Launch/Click/Type/Key/Scroll/SetValue/Act/Select/Drag/AskUser/Todo/Agent/Search/Fetch/Recall/SaveSkill/Tools/Capabilities/Wait），registry 别名层（旧名路由+不进 schema，一个版本），system_prompt/子代理提示词/工具描述交叉引用同步，渲染器图标映射补新名（旧名保留渲染历史） | ✅ |

验证：Python **1643 passed**（全量）；Node **179 passed**；五套 typecheck + ESLint 绿；`npm run sync` 交付 **1.0.28**。
诚实边界：LSP 诊断（审计 backlog 项）未做——需要语言服务器运行时，MP 主打桌面/混合场景，明确后置；Glob 未走 rg --files（Python walk + mtime 排序已够，rg 化列 B3 后续）；真机端到端（真实模型跑新 Edit/Bash 闭环）未跑，建议下一个任务自然验证。

---

## 1. 四家工具面哲学（决定了"该有几个工具"）

| | 数量 | 哲学 |
|---|---|---|
| CC | 40+（核心 16） | "自描述工具 + model-as-router"；ToolSearch 把 MCP/低频工具 defer 出 schema；Bash 一个工具背后是 10,894 行安全/权限/输出工程 |
| Hermes | ~60 | toolset 分层（core/file/browser/...），`tool_search.py` 把 MCP 前缀工具全部 defer（`is_deferrable_tool_name`）；registry 统一 `max_result_size_chars` |
| Pi | **8** | 极简面（read/write/edit/bash/grep/find/ls），每个工具把失败语义做到底：截断必须给 `offset=N` 续读指引、bash 全量落盘 temp 文件、edit 批量化 |
| MP | 54 | 混合：22 桌面/感知 + 9 文件/shell + 19 capability/recipe + 4 元工具。**问题不是绝对数，是默认 schema 里挤了太多低频工具**（model-as-router 的反面：模型每轮为 54 个工具描述付 token 和注意力） |

结论：MP 需要**分层**（core + deferred），不是单纯删功能。CC ToolSearch / Hermes tool_search 都是这个答案：**默认面 16-20 个，其余经 find_capability 按需加载**。MP 已有 `find_capability`（CC ToolSearch 同款），但只对 `tool_limit` 截断生效，没有把低频工具主动 defer 出默认 schema。

---

## 2. 语言决策：工具用 Python 还是 TS？

**裁决：工具本体留在 Python（进程内），性能敏感路径下沉到系统二进制；Electron/TS 只做壳。**

逐条理由（对照三家）：
1. CC/Pi 用 TS 不是因为 TS 更适合写工具，是因为它们的宿主（CLI 进程）是 Node。Hermes 证明 Python 工具面可以做到三家最全（file_tools 2107 行 + terminal_tool 3140 行 + fuzzy_match 950 行）。
2. MP 的 Runtime、loop、权限链、Evidence 契约全是 Python（`app/agent_runtime/`）。工具进程内调用 = 零 IPC、零序列化边界、直接拿到 cancel scope / permission decisions / checkpoints。跨到 TS 意味着每个工具一次 bridge 往返，还要在两边重复实现权限与取消语义——纯负资产。
3. 性能瓶颈从来不在"语言"，在实现选择：CC 的 Grep 快是因为**spawn ripgrep 二进制**（`utils/ripgrep.js`），不是 TS 快。MP 的 `_do_grep` 是纯 Python os.walk + 逐文件 read_text（`coding_tools.py:89`）——该换的是 `rg --json` 子进程，语言不变。
4. UIA/Win32 桌面动作（MP 的核心差异化）本来就是 COM/ctypes 生态，Python 是正位。

**唯一规则**：工具内不做像素级/文本级 CPU 密集循环——能下沉就下沉（rg、ffmpeg、tesseract 等二进制），Python 只做编排。

---

## 3. 命名方案（CC 风格：大写驼峰、单词、简短）

CC 风格 = `Read / Edit / Write / Bash / Grep / Glob / Agent / AskUserQuestion`。MP 现为 snake_case。映射表（改名是纯 prompt 兼容性变更——工具名在 schema/权限预设/UI 渲染/测试六处出现，需要一次性迁移 + 兼容别名一个版本）：

| MP 现名 | 新名（CC 风格） | 备注 |
|---|---|---|
| read_file | **Read** | |
| write_file | **Write** | |
| edit_file | **Edit** | |
| apply_patch | **Patch** | Codex V4A 风格保留 |
| glob / grep | **Glob / Grep** | |
| run_command / read_background | **Bash / BashRead** | 后台输出轮询并入 Bash 语义（CC Bash background 同款） |
| restore_files | **Rewind** | CC /rewind 词 |
| get_app_state | **Observe** | MP 语义核心动词，比 get_app_state 短且指令性强 |
| look | **Look** | 冻结帧视觉（保留区分：Look=历史，Observe=现在） |
| list_apps / list_windows / get_focused | **ListApps / ListWindows / GetFocus** | |
| find_in_window / dump_subtree / read_around | **Find / Tree / Around** | 冻结帧感知三件套，defer 候选 |
| click / type_text / press_key / scroll / drag / set_value / select_text / perform_secondary_action | **Click / Type / Key / Scroll / Drag / SetValue / Select / Act** | Kimi 13 件套其余保留 |
| activate_window / launch_app | **Focus / Launch** | |
| copy_selected_text / save_screenshot / show_source | （本地动作，不进 schema，不改） | |
| web_search / web_fetch | **Search / Fetch** | |
| ask_user_question | **AskUser** | CC 叫 AskUserQuestion，MP 短化 |
| todo_write | **Todo** | CC 叫 TodoWrite；Todo 即可 |
| delegate_task | **Agent** | CC 同名 |
| turn_ended | （建议自动化，见 §6.3） | |
| search_history | **Recall** | 跨会话记忆召回 |
| save_skill | **SaveSkill** | |
| find_capability / describe_capabilities | **Tools**（合并两者，见 §6.4） | CC ToolSearch |
| capability/recipe 19 件 | 移出默认 schema（§5） | 面向 Stage/手势路径保留 |

---

## 4. 逐工具逐行 diff（按家族）

### 4.1 文件工具（MP `app/agent_runtime/coding_tools.py` 844 行）

#### Read（read_file，`coding_tools.py:437`，实现 `_numbered:70`）
**MP 现状**：UTF-8 读全文 → splitlines → 行号 → 2000 行 / 50K 字符双帽，帽内截断带分页指引。
**对照**：
- CC（`FileReadTool.ts` 1183 行）：①**读后去重**——`readFileState` 记 (mtime, offset, limit)，同区间重读且 mtime 未变时返回 `file_unchanged` stub（BQ 实测 18% Read 是同文件碰撞，省 2.64% fleet cache_creation）；②**二进制/设备路径防护**（`/dev/zero` 等会挂死的设备黑名单 `FileReadTool.ts:98`）；③ENOENT 时**相似文件建议**（`findSimilarFile`）；④图片原生返回 base64、PDF 分页提取、ipynb 结构化；⑤**token 帽**（25K，超帽先估再 API 精算）。
- Hermes（`file_tools.py:1109`）：①**连读熔断**——同文件同区间连读 3 次警告、4 次**硬阻断**（`file_tools.py:1367-1379`，防模型循环读）；②char 预算内**按完整行截断 + next_offset 续读**（`_truncate_to_char_budget:87`）；③docx/xlsx/ipynb 自动抽取（`read_extract`）；④**压缩后去重重置**（`reset_file_dedup`，否则 compaction 后的 re-read 拿到指向已被摘要掉的 stub）；⑤读文件记录 `file_state` 供写前 staleness 检查。
- Pi（`read.ts`）：截断必须给 `Use offset=N to continue`（行/字节两帽、永不截半行），首行超帽直接给 `sed -n 'Np' | head -c` 的 bash 兜底命令。

**差距与升级项**（按性价比排序）：
1. 【高】**连读熔断**（Hermes）：MP 无任何重复读防护，模型卡循环时每轮白付 50K token。
2. 【高】**相似文件建议**（CC/Pi）：`not found: a.py` 换成 `File does not exist. Did you mean a.py.bak?`——一行 difflib 的事。
3. 【中】**读去重 stub**（CC）：需要 readFileState（与 Edit 未读先写门共用，见 Edit）。
4. 【中】docx/xlsx 抽取（Hermes）：MP 目标用户大量接触 office 文档（微信/表格场景），read_file 读 .docx 现在返回乱码。可先挡：二进制扩展名直接报"用 export 工具/Python 提取"。
5. 【低】设备路径黑名单：Windows 下 `CON`/`NUL`/`\\.\` 类防护。

#### Edit（edit_file，`coding_tools.py:451`）
**MP 现状**（本批刚升级）：精确唯一匹配 → 弯引号归一化二级匹配（取真实子串）→ CRLF 检测还原 → checkpoint。
**对照**：
- CC（`FileEditTool.ts:137` validateInput）：**11 级错误阶梯**——old==new(1)、deny 规则(2)、1GiB 文件帽(10)、ENOENT+相似建议(4)、空 old_string 语义（存在非空文件时"不能创建"(3)、ipynb 转向(5)）、**未读先写(6)**、**读后被外部修改(7，mtime+内容双重校验防云同步误报)**、未找到(8)、多处命中(9)。`utils.ts:73` 引号归一化 + **preserveQuoteStyle**（把 new_string 的引号改写成文件的花引号风格，MP 现在是反向：文件真实子串被替换成 new_string 的直引号）；`utils.ts:196` **空 new_string 删行语义**（old_string 不带尾换行而文件带，则连行删）。
- Hermes（`fuzzy_match.py` 950 行）：**9 级模糊阶梯** exact→line_trimmed→whitespace_normalized→indentation_flexible→escape_normalized→trimmed_boundary→unicode_normalized→block_anchor→context_aware，外加**缩进漂移纠偏**（LLM 发 2 空格文件 4 空格时按 delta 平移 new_string）、**escape 漂移守卫**（工具调用序列化把 `'` 变 `\'` 时拒绝写入而不是写坏文件）、Unicode 保真替换。
- Pi（`edit.ts` + `edit-diff.ts`）：**一次调用批量 edits[]**（全部对原文件匹配、重叠检测、倒序应用）；NFKC+尾空白+引号+破折号+特殊空格归一化；**BOM 剥离还原**；**同文件变更队列**（`file-mutation-queue.ts`，并行 edit 同文件串行化）；模型把 edits 发成 JSON 字符串的容错（`prepareArguments`，注释点名 Opus 4.6/GLM-5.1 会这么发）。

**差距与升级项**：
1. 【高】**未读先写门 + 读后修改检测**（CC errorCode 6/7）：MP 现在模型可以不读就 edit，盲改必然 high string-not-found 率。需要 Read/Edit 共享 readFileState（顺带解锁读去重）。**这是 Edit 智能化的最大单点**。
2. 【高】**缩进/空白归一化阶梯**（Hermes line_trimmed → whitespace_normalized → indentation_flexible）：命中率远高于引号归一化（引号是低频，缩进漂移是高频）。MP 已有归一化匹配框架（`_normalized_quote_matches` 的索引映射），扩两级即可。
3. 【中】**批量 edits[]**（Pi）：跨文件大批改动现在要 N 次 edit_file 往返；apply_patch 能做但要求精确上下文，批量 edit 更容错。
4. 【中】**preserveQuoteStyle**（CC）：MP 归一化命中后 new_string 的直引号会覆盖文件的花引号风格——中文文案文件尤其受伤。
5. 【中】**BOM 剥离还原**（Pi）：MP `read_text(encoding="utf-8")` 保留 BOM 字符在 old_string 匹配里造成鬼影。
6. 【低】空 new_string 删行语义（CC）。

#### Write（write_file，`coding_tools.py:443`）
MP：整写 + checkpoint。CC：写已有文件同样走未读门 + 修改检测；文件历史（fileHistoryTrackEdit）供 UI diff。**升级项**：同 Edit 的未读门；返回值可附"这是覆盖，原文件 N 行→M 行"（CC 返回结构化 patch 供 UI）。低优先。

#### Glob（`coding_tools.py:550`）
MP：os.walk + fnmatch，500 帽，排除目录硬编码。CC GlobTool：ripgrep `--files` + 单 pass 过滤（大仓库快一个量级）；按 mtime 排序（最近改的排前——找"刚才那个文件"的隐含意图）。**升级项**：【中】`rg --files` 子进程化 + mtime 排序。

#### Grep（`_do_grep:89`）
MP：纯 Python walk，每文件 read_text 全文正则，单行 200 字符帽，200 命中帽。对照：CC GrepTool 577 行 = ripgrep `--json` 子进程 + 三种输出模式（content/files_with_matches/count）+ `-A/-B/-C` 上下文 + head_limit/offset 分页 + 超时抛 `RipgrepTimeoutError`；Hermes `search_tool` 同样支持 content/files 两模式 + offset 分页 + 凭据过滤（`_filter_read_blocked_search_results` 防搜出 .env 内容直接回显）。**升级项**：
1. 【高】**rg 子进程化**：MP 自家仓库跑一次 grep 全文 read_text 全仓——性能和内存都不可接受（2MB 文件帽只是止痛）。
2. 【中】上下文行（-A/-B/-C）与 offset 分页：模型定位后的"看周围"现在要再发 read_file，多一轮。
3. 【低】凭据过滤（Hermes）：命中 `.env`/私钥文件时打码。

#### Patch（apply_patch，`coding_tools.py:516`）
MP：Codex V4A 解析+应用 + checkpoint 预录。对照：Hermes patch_tool 对 V4A 头做 `..` 穿越校验（`file_tools.py:1672`）+ 文件锁 + staleness 警告。**升级项**：【低】V4A 头路径穿越校验（MP 有 WorkspaceSpace 兜底，双重不必要；Hermes 是因为没有统一 confiner）。**裁决：现状合格，不动。**

#### Rewind（restore_files，`FileCheckpointStore:344`）
MP：manifest + before-image，跨进程 seq 续号（修过覆盖 bug）。对照：CC 无等价工具（rewind 是 UI 命令）；Hermes checkpoint_manager。**MP 在这里是领先项，保留。**可升级：restore 后对被还原文件发 UI 通知（CC fileHistory 有）。

### 4.2 Shell（run_command，`coding_tools.py:588` + BackgroundJobs:269）

**MP 现状**：每次 `subprocess.run(shell=True)` 新 shell；60s 默认/600s 帽；输出尾部 64K + stderr 8K；灾难命令黑名单；只读白名单 → Effect.READ（effect_for）；后台 job = Popen 脱离 + 日志文件 + read_background 轮询；退出码 1 语义注释（本批加）。
**对照**：
- CC（BashTool 目录 10,894 行 + Shell.ts）：①**cwd 持久化**——每条命令包一层 `pwd -P >|$tmp`，命令后读回，`cd` 生效且触发 hooks（`Shell.ts:395-410`）；②默认超时 **30 分钟**、输出持久化到文件（`filePersistence/`）+ TaskOutput 流式；③后台 shell = 独立 task id + 完成通知；④bashSecurity/readOnlyValidation/sedValidation 共 ~5,000 行的命令安全分析（静态判断只读性，比 MP 白名单细得多——MP 白名单 24 个词，CC 是语法级分析）；⑤sandbox（bwrap/沙箱适配）。
- Hermes（terminal_tool.py 3,140 行）：①**持久环境**——env/venv/cd 跨调用保持（"activate 一次，整个会话有效"）；②后台 + **notify_on_complete**（完成推一次，模型不用轮询）+ **watch_patterns**（限频 1 次/15s，3 strike 自动降级，`terminal_tool.py:2140` docstring）；③**pty 模式**（交互式 CLI：vim/repl 不挂死）；④docker/ssh/modal 后端；⑤sudo 密码交互托管。
- Pi（bash.ts）：**流式 onUpdate**（100ms 节流推进 UI）+ OutputAccumulator **全量落盘 temp 文件**（截断时给 fullOutputPath，模型可 bash 兜底读取）+ killProcessTree + 无默认超时。

**差距与升级项**：
1. 【高】**cwd/env 持久化**：MP 每次调用丢 cwd（模型 `cd build && make` 后下一轮又回工作区根；venv activate 全白做）。最小实现：单会话维护 cwd 状态，每条命令 `cd <cwd> && <cmd> && pwd -P` 回读（CC 同款，Windows 用 `Set-Location`+`(Get-Location).Path`）。这是编程闭环的基础设施，不是锦上添花。
2. 【高】**后台完成通知**：MP read_background 是轮询；Hermes notify_on_complete 证明"完成推一次"把后台任务的轮次成本从 O(n) 降到 O(1)。MP loop 已有 durable inbox（session.enqueue_inbox）——后台 job 完成时投一条 inbox 消息即可，基础设施全在。
3. 【中】**输出全量落盘**：MP 截 64K 丢弃中段；P1-3 的 loop 级落盘已经解决"模型回读"问题（本批真机验证过），run_command 内部可不动。**裁决：已被 P1-3 覆盖，降级为不做。**
4. 【中】只读判定升级：白名单 → CC 式语法分析太重（5,000 行不值）；折中：`git status/log/diff`、`rg`（无 `--glob` 写副作用）、`python -c`（不可证）仍回落 IRREVERSIBLE 即可。**裁决：白名单加 git 只读子命令 + rg，一行事。**
5. 【低】pty/交互式：MP 场景（桌面自动化为主）少用 vim/repl，backlog。
6. 【低】默认超时 60s→300s：MP 长构建必配 timeout_s，但默认值对构建不友好；Hermes 前台语义"配 300s 但快完成秒回"已由 subprocess.run 天然满足。

### 4.3 感知与桌面动作（MP 独有面，三家无对等物）

这是 MP 的差异化：CC/Pi 零桌面能力，Hermes 有 computer_use_tool（截图+坐标点击）但无 UIA 结构化。**逐行对照对象是 Kimi CU（session.py 抄的 13 件套）与 Hermes computer_use**。

#### Observe（get_app_state，`session.py:136`）
MP：live 窗口选择 → snapshot_id + 元素树；**元素级失效**（`_require_unchanged_element:383`——动作前重探目标元素指纹，index 漂移即 STALE_SNAPSHOT）+ 窗口几何/身份校验（`_require_snapshot:356`）。这是 MP 的金牌机制（点完必须再观察、快照绑定动作），Kimi 原版都没有这么严。**升级项**：【中】元素树**带 schema 描述的压缩视图**（Kimi/Anthropic computer-use 的观察都做 token 压缩；MP 元素全量 JSON 在大窗口下爆 token——需要采样/折叠：容器折叠、可见文本优先、每类上限）。
#### Look（look_tool.py）
冻结帧视觉 + 每轮配额（12 次）+ 诚实 Evidence 状态机。对照 Hermes vision_tools（截图→视觉模型，无冻结帧概念）。**裁决：MP 领先（冻结帧=防 UIA/屏幕漂移），保留原样。**
#### Click/Type/Key/Scroll/Drag/SetValue/Select/Act（session.py:172-343）
MP：快照绑定 + Win 键拒绝 + type_text 读回验证（verification.matched 才 submit）+ input ownership 锁。对照 Hermes computer_use_tool：纯截图坐标流，无结构化绑定。**升级项**：【中】Click 后**自动返回受影响区域的迷你 Observe**（省一轮；Kimi 的 click 返回元素变更摘要——MP 可用 UIA ReValidate 事件做）；【低】double_click/triple_click 参数（MP count=1/2 已有 button/count，够）。
#### Turn_ended（session.py:341）
**设计缺陷**：把"释放输入锁"的责任推给模型——模型忘了调就 COMPUTER_USE_BUSY 卡死下一个会话。Hermes/CC 的锁都是 harness 生命周期管理。**升级项**：【高】turn 结束（COMPLETED/INTERRUPT/CRASH）时 loop 自动 release；turn_ended 保留为"提前让锁"的显式选项。一行 hook 的事（loop 的 ToolGuardrail 边界已存在）。
#### Around/Tree/Find（perception_tools.py，冻结帧三件套）
Evidence 状态机（busy/empty_confirmed/ok + container 启发式）做得对。**用法问题**：与 Observe（live）并存但模型常混淆——描述里已写"historical, 用 get_app_state 看现在"。**裁决：保留，defer 候选**（Stage 手势路径用得多，Studio 对话少用）。
#### ListApps/ListWindows/GetFocus/Launch/Focus
保留。Launch 的 `_known_app` 白名单防"打不开就开资源管理器"是对的。

### 4.4 元工具

#### Todo（todo_write，`ask_todo_tools.py:102`）
CC TodoWrite 同款 + MP 计划卡 UI + nudge 门（计划没做完不许收工——CC 没有的，MP 领先）。**升级项**：【低】CC 的 TodoWrite 有 content 非空校验与 status 枚举校验，MP 现在 status 随便填——加枚举校验一行。
#### AskUser（ask_user_question，`ask_todo_tools.py:22`）
CC AskUserQuestion 对齐（options 2-4、permission kind 结构化授权）。**升级项**：【低】CC 支持多问题数组 + "Other"自由输入；MP 单问题。够用，backlog。
#### Agent（delegate_task，`subagent.py`）
MP：子注册表只有 coding tools + 预算帽 + 串行（冲突靠构造拒绝）。CC AgentTool：**并行 + run_in_background + 子代理可再派生**（有深度限制）。**升级项**：
1. 【中】**只读子代理并行**：registry 声明 is_concurrency_safe 已有——delegate 一个 effect=READ 的子任务可进并行车道（调研类委派不吃锁）。
2. 【低】后台子代理 + 完成通知（依赖 Bash 通知的 inbox 基础设施）。
#### Search→Recall（search_history，`memory_tools.py`）
grep JSONL 的朴素实现，够用。Hermes session_search（921 行）有索引与时间衰减。**升级项**：【低】按会话聚合去重（同一事件多行 JSONL 重复命中）。**defer 候选**。
#### Search/Fetch（web_tools.py）
MP：DDG HTML 单源 + httpx 正则抽正文，头尾窗口。对照 CC WebFetch（15 分钟缓存 + 域名升级 + 重定向回显）、WebSearch（API 域名过滤）；Hermes web_tools 1,238 行（多引擎 + readabilitipy 级抽取 + 站点策略）。**升级项**：【中】fetch 结果缓存（同 URL 15min——MP 长任务里反复 fetch 同一文档页）；【低】`follow_redirects=False` + 跨源重定向显式回显（与出网安全审计一致的收敛）。
#### SaveSkill（skill_writer.py）+ SkillLoader 频次（本批 P2-5）
MP 已闭环（写→注入→频次排序）。Hermes skill_usage 有 view/use/patch 三计数 + patch 检测（skill 被模型改过）。**升级项**：【低】长期不用降级"只列名字"（Hermes 有；用户原话只要频次排序，先不做）。
#### Tools（find_capability，`capability_tools.py:492` + describe_capabilities）
MP 的 ToolSearch 但**没接 defer**。CC ToolSearchTool：deferred 工具不出现在默认 schema，搜索命中才加载进下一轮；Hermes `classify_tools` 同款 + token 预算估算（`estimate_tokens_from_schemas`）。**升级项**：【高】把 §5 的 deferred 名单真 defer——这是"54 个工具"问题的一招解。

### 4.5 Capability/Recipe 层（19 个，`capability_tools.py`）

结构（枚举参数合并 recipe 变体 + propose/confirm 链 + inloop_reversible 预条件）设计是对的（文档头写明这是 2026-08-13 评审结论）。问题：**它们绝大多数只服务于 Stage/手势路径**（text_transform/data_export/place_route...），却默认注册进 Studio 对话的 54 工具 schema。**裁决：全部 defer**（保留注册与 find_capability 可见性，移出默认 schema）。个别疑点：
- `voice_command`、`dashboard_govern`、`mcp_integration`、`element_pick`、`recipe_scale`、`canvas_transform`、`vision_bridge`：查不到 Studio 路径消费，疑似 Stage 专用甚至死代码——**逐个核实在 Stage manifest 的引用后再删/defer**（下批第一件事，防误删 Stage 依赖）。
- `agent_handoff`：产品边界（提示词投递通道）明确要求保留。

---

## 5. 冗余裁剪与分层（54 → 默认 20 + deferred 34）

**默认 schema（20，Studio 对话高频）**：Read, Edit, Write, Grep, Glob, Patch, Bash, BashRead, Rewind, Observe, Look, Click, Type, Key, Scroll, Drag, SetValue, Select, Act, AskUser, Todo, Agent, Search, Fetch, Tools ——（实数 25；Click 系 9 件在纯对话模式可再 defer，只留 Observe+Look：**分模式**：Studio 对话默认 25，Stage 默认含桌面 13 件套）。
**Deferred（经 Tools 搜索加载）**：Around, Tree, Find, ListApps, ListWindows, GetFocus, Focus, Launch, Recall, SaveSkill, capability 19 件, mcp_search 托管的 MCP 工具。
**裁剪（真删）候选**：capability 层中核实无消费的 recipe 工具（见 §4.5）；`describe_capabilities`（并入 Tools）。
预期收益：默认 schema token 直接砍半，模型选错工具率下降（54 选 1 vs 20 选 1）；CC 的 ToolSearch 数据（deferred + 搜索加载）证明无能力损失。

## 6. 新工具设计（三家都没有/三家不足，MP 补）

1. **Wait（MP 首创，桌面 agent 刚需）**：等条件成立——窗口标题出现/元素可见（UIA 探针）/文件存在/进程退出，带超时与 200ms 轮询。CC SleepTool 是裸 sleep（浪费秒数+轮次）；Hermes watch_patterns 只覆盖后台输出。桌面自动化里"点开菜单→等菜单渲染→点菜单项"现在靠模型连发 Observe 烧轮次。**这是 MP 超越三家的单点。**
2. **Screenshot（实时屏幕→模型视觉）**：MP 有 Look（冻结帧）但实时视觉断档（save_screenshot 只落盘给人看）。Kimi/CC computer-use 都有。配合 Observe 的 ax 树做"视觉优先"的定位。
3. **后台完成通知（不是新工具，是 Bash/Agent 的 inbox 升级）**：见 §4.2。
4. **LSP 诊断（backlog）**：CC LSPTool（definition/references/hover/diagnostics）。Python 侧接 jedi/pyright 子进程可行，但 MP 当前主打桌面/混合场景，编码深度场景排后。

## 7. 批次计划（建议顺序）

- **B1（工具面结构）**：deferred 分层 + Tools 合并 describe_capabilities + capability 死代码核实。*解决"54 个工具"。*
- **B2（Edit/Read 智能）**：readFileState（未读先写门 + 修改检测 + 读去重）→ 缩进/空白归一化阶梯 → preserveQuoteStyle + BOM。*对齐 CC/Hermes 的 Edit 智能大头。*
- **B3（Shell 基础设施）**：cwd/env 持久化 → 后台完成通知（durable inbox）→ Grep/Glob 的 rg 子进程化 + 上下文行 + mtime 排序。
- **B4（MP 差异化）**：turn_ended 自动化 → Wait 工具 → Observe 压缩视图 → Click 迷你回观察。
- **B5（改名迁移）**：CC 风格命名一次性切换（schema/prompt/权限/UI/测试六处 + 一个版本的旧名别名）。
- **B6（backlog）**：Recall 聚合、fetch 缓存、并行只读子代理、LSP、连读熔断（若 B2 未覆盖可并入）。

每批照旧：测试先行、全量验证、sync 交付、账本更新。
