# Magic Pointer 全景架构现状图（2026-08-29）

> 用途：把 MP 源码库**当前真实状态**按最完善 harness 的架构层面拆开画全，
> 细粒度到"edit_file 是一个节点"这个级别。不是目标架构，不是对比报告——
> 就是这个项目现在长什么样。状态标注：
> ✅ 可用且已接生产 ｜ ⚠️ 可用但有明确边界 ｜ 🚧 契约/脚手架就位未完成 ｜
> ❌ 存在但未接生产链路 ｜ 🔌 动态（运行时注册）

共 12 张图：总览 / 捕获感知 / 插件内核 / Agent Loop / 工具面全景（58 个
静态注册工具逐个列出）/ 模型客户端 / 上下文记忆 / 治理安全 / 桌面动作面 /
持久化 / Electron 壳 / 桥接层。

---

## 图 1：总览——五层结构

```mermaid
flowchart TB
    subgraph L5["第 5 层 · Electron 壳（TypeScript）"]
        STUDIO["Studio 工作台<br/>studio.html / studio.ts"]:::ui
        STAGE["Stage 舞台气泡<br/>stage.html / stage.ts"]:::ui
        COMPANION["Companion 伴侣窗"]:::ui
        OVERLAY["Overlay 指针覆盖层<br/>overlay.ts"]:::ui
        MAIN["main.ts 主进程<br/>~90 个策略/运行时模块"]:::ok
    end

    subgraph L4["第 4 层 · Python 桥接（scripts/）"]
        SELB["selection_bridge.py<br/>划线主桥 + _loop_router"]:::ok
        CONVB["conversation_bridge.py<br/>Studio 对话桥"]:::ok
        SNAPB["selection_snapshot_bridge.py<br/>快照桥（消费 FrameLease）"]:::ok
        SELW["selection_worker.py<br/>Stage 常驻 worker"]:::ok
        FABRICB["fabric_bridge.py / agent_bridge.py<br/>旧 fabric / 外部 agent 通道"]:::ok
        MISC["专项桥 ×15<br/>calendar / shopping / voice / learning…"]:::ok
        RUNNER["python_bridge_runner.ts<br/>无活动超时 + 进度行解析"]:::ok
    end

    subgraph L3["第 3 层 · Agent Runtime 内核（app/agent_runtime/ + harness/）"]
        LOOP["run_agent_loop 状态机<br/>loop.py"]:::ok
        REG["ToolRegistry 工具注册表<br/>tool_registry.py"]:::ok
        PLUGIN["插件内核 Context/plugin<br/>app/harness/"]:::ok
        GUARD["守卫链 guardrails / hooks<br/>tool_guardrails.py / hooks.py"]:::ok
    end

    subgraph L2["第 2 层 · 能力面（app/ 其余）"]
        DESKTOP["desktop_actions 桌面 13 工具"]:::ok
        CAP["fabric capability 18 工具"]:::ok
        PERC["perception 感知融合"]:::ok
        ACT["actions / adapters / vision<br/>写回与垂直能力"]:::ok
    end

    subgraph L1["第 1 层 · 外部"]
        GW["模型网关<br/>opencode.ai（chat + messages 双协议）"]:::ok
        OS["Windows OS<br/>UIA / SendInput / 剪贴板 / COM"]:::ok
        MCP["MCP servers"]:::ok
    end

    STUDIO --> CONVB
    STAGE --> SELW --> SELB
    STAGE --> SNAPB
    MAIN --> RUNNER --> SELB & CONVB & SNAPB & FABRICB & MISC
    SELB & CONVB --> LOOP
    LOOP --> REG --> DESKTOP & CAP
    SELB & SNAPB --> PERC
    LOOP --> GW
    DESKTOP & PERC --> OS
    REG --> MCP
    classDef ok fill:#2d4a2d,color:#fff
    classDef ui fill:#1f3a5f,color:#fff
```

---

## 图 2：捕获与感知链路（手势 → 证据）

```mermaid
flowchart TB
    WIG["wiggle_detector.ts 晃动唤醒"]:::ok
    GEST["gesture_capture.ts 手势捕获<br/>（划线/圈选/多选）"]:::ok
    COORD["coordinate_space.ts 坐标空间"]:::ok
    ARM["CaptureEpoch arm<br/>（环形缓冲预热的契约）"]:::ok
    FLTS["frame_lease.ts + frame_capture_worker.py<br/>FrameLease 冻结帧（pointerup 第一等动作）"]:::ok
    FRAMEWORK["frame_capture_worker_client.ts<br/>常驻捕获 worker 客户端"]:::ok
    COMMIT["capture_commit_coordinator.ts<br/>commit 排序/竞态防护"]:::ok
    CAPPROT["app/capture 协议<br/>gdi-fallback ✅ / wgc-window 🚧（csc 无 WinMD，wgc_tool_missing）/ test"]:::warn

    subgraph BROKER["PerceptionBroker 并发证据（app/perception/）"]
        direction LR
        PROV["providers.py Provider 协议<br/>（descriptor/result/observation）"]:::ok
        BROK["broker.py 并发 fan-out + per-provider deadline"]:::ok
        FUSE["fusion.py 纯裁决<br/>覆盖mark &gt; 非容器 &gt; 非降级 &gt; tier &gt; 优先级 &gt; 置信度"]:::ok
        PIX["pixel_ocr.py 冻结帧 OCR provider"]:::ok
        VIS["visual_once.py 结构化未覆盖时 look 一次"]:::ok
        ELEM["element_handles.py 元素句柄"]:::ok
    end

    subgraph GROUND["结构化适配器（app/adapters/ + app/grounding/）"]
        direction LR
        UIA["uia_text_adapter.py UIA 文本"]:::ok
        DOM["browser_devtools_adapter.py CDP DOM<br/>（需 --remote-debugging-port）"]:::warn
        OFFICE["office_adapter.py Office COM"]:::ok
        PDFR["pdf_selection_recovery.py PDF"]:::ok
        EXPL["explorer_adapter.py 资源管理器文件链路"]:::ok
        CASCADE["perception_cascade.py 旧串级<br/>（已由 broker 取代主路）"]:::legacy
        TERM["terminal_evidence.py 终端结构化"]:::ok
        MARK["marked_read.py 划中行读取"]:::ok
    end

    UIAHOST["uia_host_client.py 常驻 UIA 宿主客户端<br/>（named pipe + 熔断，实测 2.5x）<br/>+ scripts/uia_selection_probe.cs / uia_draft_writer.cs"]:::ok
    OCRW["常驻 OCR worker（RapidOCR）"]:::ok

    ART["InputArtifact v1（app/input_artifact/schema.py）<br/>指令与屏幕数据分离 · origin=data 硬围栏<br/>公开投影 + 有界模型投影"]:::ok
    SURF["surface_adapter/ SDK + manifest/registry<br/>+ adapters/wechat_adapter.py 微信样例"]:::warn
    EVIC["evidence/contract.py 八态证据契约<br/>ok/degraded/empty_confirmed/busy/timeout/unsupported/denied/error"]:::ok
    REPLAY["replay/ trace 录制回放 ×20 fixtures<br/>+ perception_replay.py"]:::ok

    WIG --> GEST --> ARM --> FLTS
    FLTS --> FRAMEWORK
    FLTS --> COMMIT --> SNAPB2["selection_snapshot_bridge"]
    SNAPB2 --> BROK
    UIA --> UIAHOST
    BROK --> PROV & PIX
    GROUND --> BROK
    BROK --> FUSE --> ART
    ART --> EVIC
    SURF --> BROK
    classDef ok fill:#2d4a2d,color:#fff
    classDef warn fill:#6b5320,color:#fff
    classDef legacy fill:#555,color:#fff
```

---

## 图 3：插件内核（app/harness/，DSH 移植）

```mermaid
flowchart TB
    CTX["context.py Context 服务仓库<br/>provide/get/has/keys · inject 依赖激活<br/>effect 可逆注册 LIFO · 四模式事件<br/>emit/waterfall/parallel/serial · scope · revoke"]:::ok
    PLUGIN["plugin.py 插件协议<br/>name/inject/apply(ctx, config)<br/>目录发现 + JSON Schema 校验 + 坏插件隔离"]:::ok
    COMP["composition.py 分层组合<br/>bundle 行序 → 用户插件目录 → patch 替换"]:::ok
    BUNDLE["builtin_bundle.py 内置能力全插件化<br/>boot_loop_context(runtime)"]:::ok
    HOST["runtime_host.py LoopHarnessHost<br/>常驻复用（Stage 路径）"]:::ok
    SERVICES["services.py 内核服务 seams<br/>ctx.tools / ctx.hooks / ctx.prompt /<br/>ctx.perception / ctx.vision / ctx.llm"]:::ok
    DUMP["harness_dump_config.py 检视工具"]:::ok
    USERPL["data/plugins/ 用户插件目录<br/>（MAGIC_POINTER_PLUGIN_DIR 覆盖）"]:::ok

    subgraph ROWS["builtin bundle 的插件行"]
        R1["harness-tools 行<br/>copy_selected_text / save_screenshot / show_source"]
        R2["perception-tools 行<br/>read_around / dump_subtree / find_in_window /<br/>list_windows / get_focused"]
        R3["look-tool 行<br/>look / describe_capabilities"]
        R4["local-action-tools 行"]
        R5["capability-tools 行（fabric 18 工具）"]
        R6["coding-tools 行（9 工具）+ delegate 行"]
        R7["desktop-action-tools 行（13 工具）"]
        R8["guard 行（precondition 工厂）"]
        R9["system-prompt 行（section 注册）"]
        R10["model-client 行（backend 装配）"]
        R11["computer-agent 行（UI-TARS 视觉环）🚧"]
    end

    COMP --> BUNDLE --> CTX
    PLUGIN --> CTX
    USERPL --> COMP
    BUNDLE --> ROWS
    ROWS --> SERVICES
    HOST --> BUNDLE
    DUMP --> COMP
    classDef ok fill:#2d4a2d,color:#fff
```

---

## 图 4：Agent Loop 内核（loop.py 状态机 + 全部支撑件）

这是 MP 的心脏。一轮的完整路径：

```mermaid
flowchart TB
    entry["run_agent_turn（engine.py:994）<br/>本地动作短路 → LoopParams 冻结快照"]:::ok

    subgraph LOOP["run_agent_loop while True（loop.py）"]
        direction TB
        B1["① 预算检查<br/>rolling deadline · productive 轮无条件续期<br/>compaction/steer 也算进展 · BudgetRenewed 事件"]:::ok
        B2["② 主动压缩门<br/>估算器 ≥70% 或 provider 真实 prompt_tokens 超线<br/>→ compactor 换历史 · 2 次无效放弃"]:::ok
        B3["③ interrupt_check / 取消检查"]:::ok
        B4["④ steer 排水<br/>inbox next-step → 注入指令通道"]:::ok
        B5["⑤ 模型调用 generate_turn<br/>→ ReasoningChunk / ModelChunk 流出"]:::ok
        B6{"事件分派"}
        W1["TurnWithheld 非token类<br/>→ backend 退避重试（15s/25s，http_5xx 零进展也重试）<br/>或 PROVIDER_UNAVAILABLE 终止"]:::ok
        W2["TurnWithheld token类<br/>→ 恢复消息 + 被动压缩一次<br/>> 上限 MAX_OUTPUT_TOKENS_RECOVERED 终止"]:::ok
        W3["last_truncated 截断<br/>→ 全部 tool call 换截断结果回喂"]:::ok
        W4["无工具调用 → 收尾路径<br/>stop hooks → 验证门 nudge → followup 续跑<br/>→ COMPLETED + artifact 生成 + receipt"]:::ok
        W5["有工具调用 → 澄清优先级隔离<br/>（ask 类挂起其余调用）→ 调度执行"]:::ok
        B7["⑥ 工具执行循环<br/>schedule_tool_calls 并行/串行分区<br/>operation prepared → settled 持久化<br/>guardrail 观察 → 工具消息 → 下一轮"]:::ok
        B8["⑦ 发现工具装载<br/>find_capability 结果 → 下轮 schema<br/>emergency_turn_fuse=1000 保险丝"]:::ok
    end

    subgraph SUPPORT["支撑组件（每个都是独立文件）"]
        direction LR
        TSCHED["tool_scheduler.py<br/>并发安全分区 + resource_keys 冲突域<br/>+ model-order commit"]:::ok
        TGUARD["tool_guardrails.py<br/>签名查重 · 重复失败/重复读/重复写<br/>warn → stalled 终止"]:::ok
        TV["turn_verification.py 验证门<br/>写过未验证想收工 → nudge 一次"]:::ok
        HOOKS["hooks.py PreToolUse/PostToolUse<br/>block 回喂 / 改参 / 抛错不杀 loop"]:::ok
        INBOX["inbox.py next-step steer /<br/>next-turn followup 双队列"]:::ok
        SESS["session.py EventSession<br/>hash-chain JSONL 唯一持久真值<br/>turn lease · 增量采用 · repair"]:::ok
        PMOD["permission_modes.py 六档 effect ×<br/>5 模式 · permission_presets.py<br/>DSH 双旋钮预设表"]:::ok
        PDEC["permission_decisions.py<br/>线程级 allow/deny memo（CC 同款）"]:::ok
        TYPES["types.py AgentMessage origin<br/>指令/数据双通道 + validate_messages"]:::ok
        RESUME["resume_context.py 断点续跑摘要<br/>interrupted_turn_summary"]:::ok
        ERRORS["errors.py ActionFailure<br/>FailureType 六态"]:::ok
    end

    entry --> B1 --> B2 --> B3 --> B4 --> B5 --> B6
    B6 --> W1 & W2 & W3 & W4 & W5
    W5 --> B7 --> B8 --> B1
    SUPPORT -.-> LOOP
    classDef ok fill:#2d4a2d,color:#fff
```

---

## 图 5：工具面全景（58 个静态注册工具逐个列出）

分组标注：`[效果档] 并发安全? deferred?`

```mermaid
flowchart LR
    REG["ToolRegistry（tool_registry.py）<br/>ToolSpec: name/description/input_schema/effect/<br/>effect_for/is_concurrency_safe/resource_keys/<br/>used_backend/timeout_ms/verify_result/<br/>discovers_tools/suspends_for_user_input/<br/>deferred/examples/preconditions<br/>+ validate_input 严格 JSON Schema 子集<br/>+ search 关键词索引（find_capability 用）"]:::core

    subgraph G_HARNESS["harness-tools（3）"]
        T1["copy_selected_text<br/>[read] 安全"]:::ok
        T2["save_screenshot [read]"]:::ok
        T3["show_source [read]"]:::ok
    end

    subgraph G_PERC["perception-tools（5）冻结帧语义"]
        T4["read_around [read] 安全<br/>手势周围上下文"]:::ok
        T5["dump_subtree [read]<br/>UIA 子树倾倒"]:::ok
        T6["find_in_window [read]"]:::ok
        T7["list_windows [read]"]:::ok
        T8["get_focused [read]"]:::ok
    end

    subgraph G_LOOK["look-tool（2）"]
        T9["look [read]<br/>视觉模型看冻结帧<br/>每 run 12 次配额"]:::ok
        T10["describe_capabilities [read]<br/>能力自描述"]:::ok
    end

    subgraph G_LOCAL["本地动作 + 记忆（2）"]
        T11["search_history [read]<br/>跨会话 FTS 记忆检索"]:::ok
        T12["ask_user_question [read]<br/>suspends_for_user_input<br/>→ awaitingUserInput 挂起"]:::ok
    end

    subgraph G_PLAN["计划（1）"]
        T13["todo_write [reversible_write]<br/>计划卡 + 压缩后回贴"]:::ok
    end

    subgraph G_WEB["web（2）"]
        T14["web_search [read] 安全<br/>DDG HTML 零 key"]:::ok
        T15["web_fetch [read] 安全<br/>httpx 抽正文（无 JS/PDF）"]:::ok
    end

    subgraph G_SKILL["技能（1）"]
        T16["save_skill [reversible_write]<br/>agent 自写 skill 闭环"]:::ok
    end

    subgraph G_CODE["coding-tools（9）workspace 沙箱"]
        T17["read_file [read] 安全<br/>行号+分页+50K 字符帽"]:::ok
        T18["write_file [reversible_write]<br/>checkpoint 先拍快照"]:::ok
        T19["edit_file [reversible_write]<br/>精确匹配两态报错<br/>（无未读校验/引号归一 → P1-4 待修）"]:::gap
        T20["glob [read] 安全 500 帽"]:::ok
        T21["grep [read] 安全 200 帽"]:::ok
        T22["run_command [local_irreversible]<br/>effect_for: 纯读命令→read<br/>小黑名单 + 后台 job<br/>（无退出码语义表 → P2-6）"]:::gap
        T23["apply_patch [reversible_write]<br/>Codex 契约移植<br/>四级模糊匹配 + 多段"]:::ok
        T24["restore_files [reversible_write]<br/>checkpoint 回滚 N 步"]:::ok
        T25["read_background [read]<br/>后台 job 轮询"]:::ok
    end

    subgraph G_SUB["subagent（1）"]
        T26["delegate_task [local_irreversible]<br/>单层 · 串行 · coding 工具面<br/>父收摘要（并行/后台化 = P3 待 Batch A）"]:::gap
    end

    subgraph G_CAP["capability 配方（18）全部 deferred=true<br/>find_capability 按需装载"]
        C1["ocr_copy"]:::ok
        C2["ocr_clean"]
        C3["rewrite_in_place"]
        C4["translate_in_place"]
        C5["summarize_route"]
        C6["selection_expand"]
        C7["selection_condense"]
        C8["to_spreadsheet"]
        C9["merge_tables"]
        C10["evidence_card"]
        C11["image_to_prompt"]
        C12["map_route"]
        C13["agent_handoff"]
        C14["background_task"]
        C15["task_route"]
        C16["screen_translate"]
        C17["clipboard_history"]
        C18["memory_recall"]
    end

    subgraph G_DESK["desktop-action-tools（13）Kimi 契约"]
        D1["list_apps [read]"]:::ok
        D2["launch_app [local_irreversible]<br/>未知名不打开资源管理器"]:::ok
        D3["activate_window [reversible_write]"]:::ok
        D4["get_app_state [read]<br/>COM ControlView 树 + snapshot_id"]:::ok
        D5["click [reversible_write]<br/>index XOR 坐标"]:::ok
        D6["type_text [reversible_write]<br/>ValuePattern 读回验证"]:::ok
        D7["press_key [reversible_write]<br/>拒 Win/Meta"]:::ok
        D8["scroll [reversible_write]"]:::ok
        D9["set_value [reversible_write]<br/>UIA 原生优先"]:::ok
        D10["perform_secondary_action [reversible_write]"]:::ok
        D11["select_text [reversible_write]"]:::ok
        D12["drag [reversible_write]<br/>最后手段"]:::ok
        D13["turn_ended [read]<br/>释放输入所有权"]:::ok
    end

    subgraph G_DISC["发现（1）"]
        T27["find_capability [read] discovers_tools<br/>→ loop 下轮装载 deferred 工具<br/>（CC ToolSearch 契约）"]:::ok
    end

    MCP["mcp_provider.py 🔌 MCP 动态工具<br/>mcp_search 惰性发现"]:::ok

    REG --> G_HARNESS & G_PERC & G_LOOK & G_LOCAL & G_PLAN & G_WEB & G_SKILL & G_CODE & G_SUB & G_CAP & G_DESK & G_DISC & MCP
    classDef core fill:#3a2d4a,color:#fff
    classDef ok fill:#2d4a2d,color:#fff
    classDef gap fill:#7a3b2d,color:#fff
```

---

## 图 6：模型客户端栈（model_client.py + 模型接入）

```mermaid
flowchart TB
    LMC["LoopModelClient<br/>generate_turn 事件消费 + 请求级重试（0.25s×2^n）<br/>call_id 保留/合成 · last_usage /<br/>last_reasoning / last_truncated / last_errors"]:::ok

    subgraph EVENTS["ModelTurnEvent 联合（判别联合）"]
        E1["TurnStarted"]:::ok
        E2["MessageDelta 正文增量"]:::ok
        E3["ReasoningDelta 思考增量 ✨8·29 新增<br/>reasoning_content/reasoning/thinking 三方言"]:::new
        E4["ToolCallArrived"]:::ok
        E5["TurnDone usage+raw"]:::ok
        E6["TurnWithheld 恢复类"]:::ok
        E7["ModelUnsupported 诚实拒绝"]:::ok
    end

    subgraph BACKENDS["三个后端"]
        B1["AiClientMessagesBackend<br/>多轮原生 messages 数组（非流式）"]:::ok
        B2["StreamingMessagesBackend（生产默认）<br/>SSE 流式 · 失败/空流自动降级非流式<br/>+ record_note 不毒化端点"]:::ok
        B3["AiClientBackend<br/>旧单 prompt 包装（ask_text_model_with_tools）"]:::legacy
    end

    PARSE["_parse_sse chat 流解析<br/>content/tool_calls 增量 + reasoning ✨<br/>_parse_messages_sse Anthropic 流 ✨<br/>_reasoning_from_payload 非流式 ✨"]:::new
    PAYLOAD["_messages_payload 双协议投影<br/>messages: thinking disabled（思考开关未做）<br/>chat: system 消息 + tool_choice auto"]:::gap
    HEALTH["model_health.py per-endpoint 熔断<br/>健康文件 v2 · circuit_open 带重试倒计时"]:::ok
    CATALOG["models_catalog.py 模型目录<br/>GET /models 拉取 + select_model 写 secrets<br/>app/models/ runtime_client + profiles<br/>+ visual_relay（视觉独立模型 gemini-2.5-flash）"]:::ok
    PROFILES["model_profiles.py 模型档案<br/>30+ 族前缀 → 上下文窗口<br/>→ 压缩预算自适应"]:::ok
    GW["网关 opencode.ai<br/>chat-completions + messages 自适应"]:::ok

    LMC --> BACKENDS --> PARSE
    BACKENDS --> PAYLOAD --> GW
    B2 --> HEALTH
    CATALOG --> GW
    PROFILES -.压缩预算.-> LOOP2["Agent Loop"]
    EVENTS -.-> LMC
    classDef ok fill:#2d4a2d,color:#fff
    classDef new fill:#1f5f5f,color:#fff
    classDef gap fill:#7a3b2d,color:#fff
    classDef legacy fill:#555,color:#fff
```

---

## 图 7：上下文管理与记忆

```mermaid
flowchart TB
    subgraph CTX["上下文工程（agent_runtime/）"]
        TOKEN["token_estimate.py 三桶估算<br/>消息+system prompt+tool schema<br/>CJK 修正"]:::ok
        COMPACT["memory.py compact_messages<br/>70% 主动 + withheld 被动<br/>Codex 五段结构化交接摘要<br/>撞窗删最老重试 · 尾部 token 预算裁剪<br/>_prune_stale_tool_outputs 尾部修剪"]:::ok
        CPROMPT["compaction_prompt.py<br/>进度/关键决定/约束/剩余步骤/关键数据"]:::ok
        TODO["todo_store.py TodoStore<br/>压缩后未完成步骤回贴<br/>+ BUDGET_EXHAUSTED 部分交付"]:::ok
    end

    subgraph MEM["记忆三层"]
        M1["memory.py MAGIC_POINTER.md<br/>用户级+工作区 分层 mtime 缓存 4k 帽<br/>→ system prompt 只读注入"]:::ok
        M2["search_history 跨会话检索工具"]:::ok
        M3["self_evolution/ Hermes 式受控进化<br/>candidates 候选 + review 审核 +<br/>background 后台复盘 + worker<br/>批准前不生效 · 哈希/备份/回滚"]:::ok
    end

    subgraph SKILL["技能体系"]
        S1["skill_catalog.py DSH 兼容发现<br/>项目 .dsh/.agents → 用户 ~/.dsh/.agents<br/>SKILL.md frontmatter 校验<br/>（无使用频次计数 → P2-5 待做）"]:::gap
        S2["slash_directory.py 斜杠命令<br/>/cwd /permission /model /rewind + skills"]:::ok
        S3["save_skill 自写闭环<br/>→ 下回合自动注入"]:::ok
        S4["skill_writer.py 写入器"]:::ok
    end

    WS["workspace_state.py 工作区状态<br/>线程级绑定（Codex workspace_roots）"]:::ok
    RECIPE["recipe_cache.py + recipe_manifest.py<br/>39 recipe 数据驱动（能力来源，非路由）"]:::ok
    FCHIST["fabric/skill_candidates.py<br/>技能候选进 review 流"]:::ok

    CTX --> LOOP["Agent Loop"]
    MEM --> PROMPT["system_prompt.py"]
    SKILL --> PROMPT
    classDef ok fill:#2d4a2d,color:#fff
    classDef gap fill:#7a3b2d,color:#fff
```

---

## 图 8：治理与安全层

```mermaid
flowchart TB
    subgraph PERMGATE["每工具调用权限链（loop._execute_one）"]
        P0["① registry.get 未知工具"]:::ok
        P1["② effect_for 解析效果<br/>（分类器崩→静态档兜底）"]:::ok
        P2["③ allowed_effects 天花板"]:::ok
        P3["④ permission_mode 模式表<br/>5 模式 × 6 档 effect"]:::ok
        P4["⑤ permission_decisions memo<br/>deny 压过一切 / allow 升 ASK"]:::ok
        P5["⑥ validate_input 严格校验"]:::ok
        P6["⑦ PreToolUse hook 改参/拒绝<br/>+ 改参后资源所有权复验"]:::ok
        P8["⑧ preconditions fail-closed<br/>（context factory 缺失=拒绝）"]:::ok
        P9["⑨ interrupt/cancel 前置检查"]:::ok
        P10["⑩ 执行（CancellationScope+timeout）<br/>→ PostToolUse hook"]:::ok
    end

    subgraph GUARD["guard 家族（app/action_guard/）"]
        G1["preconditions.py 四断言<br/>宁可失败不猜"]:::ok
        G2["approval.py 不可逆动作人类批准<br/>批准者黑名单（model/tool 不能批）"]:::ok
        G3["undo_log.py 补偿动作 + 幂等 +<br/>失败不伪装 + 读回校验"]:::ok
        G4["egress_gate.py 出网默认全禁<br/>data 来源需显式批准 + 全审计"]:::ok
        G5["guard_factory.py 生产工厂<br/>真探针 + 选区 anchor fallback"]:::ok
    end

    ANCHOR["anchor/ 五字段身份 + resolver<br/>exact/moved/changed/gone/ambiguous<br/>ambiguous 永不按 exact"]:::ok
    TLEASE["fabric/target_lease.py TargetLease<br/>fail-closed 字典租约校验"]:::ok
    INJ["指令/数据双通道<br/>屏幕内容永远 origin=data<br/>工具结果注入围栏 + 记忆只读包装"]:::ok

    subgraph GOV["运行时治理（app/governance/）"]
        GOV1["cancellation.py 代际淘汰取消注册表<br/>CancellationScope"]:::ok
        GOV2["latency_budget.py 预算表<br/>FULL_ANSWER rolling"]:::ok
    end

    PERMS["permissions/ 感知侧<br/>app_blacklist 敏感窗黑名单 ·<br/>sensitive_detect Luhn 脱敏 ·<br/>offline_mode 不出网 · capability_matrix"]:::ok
    AUDIT["fabric/audit.py + provenance.py +<br/>receipt_verification.py 回执核验"]:::ok
    JOB["process/job_object.py<br/>JobObject 看门狗（MCP/OCR 子进程）"]:::ok
    SEC["electron/security_hardening.ts +<br/>ipc_surface_policy + internal_action_policy"]:::ok

    PERMGATE --> GUARD & ANCHOR
    classDef ok fill:#2d4a2d,color:#fff
```

---

## 图 9：桌面动作面细部（desktop_actions/）

```mermaid
flowchart TB
    SESS["session.py DesktopActionSession<br/>StateVersion: snapshot_id 绑 hwnd/pid/bounds<br/>窗口移动/换进程 → stale_snapshot<br/>内容重排不检测（Kimi 规则）<br/>index XOR 坐标混传拒绝"]:::ok

    subgraph WRITE["写路径分层（used_backend 诚实报告）"]
        W1["UIA 原生 pattern<br/>set_value / invoke / toggle / expand<br/>（uia.py ctypes COM CUIAutomation）"]:::ok
        W2["真实输入 SendInput Unicode<br/>type_text → 剪贴板+粘贴 → 读回验证<br/>verification.matched"]:::ok
        W3["失败诚实码<br/>STALE_SNAPSHOT / COMPUTER_USE_BUSY"]:::ok
    end

    LOCK["InputOwnershipLock 输入所有权<br/>mutating 互斥 · busy 时只读放行<br/>turn_ended 释放"]:::ok
    UIAB["uia.py UiaBridge<br/>walk_window ControlView 规范化<br/>1-based index/role/name/rect/patterns<br/>预算 400 · 可注入 walker/actor"]:::ok
    PROBE["elements_probe / uia_act<br/>ctypes COM 生产实现"]:::ok

    CU["computer_operator/ UI-TARS 视觉环<br/>单截图单动作 · observation SHA 绑定<br/>SurfaceGrant 坐标约束<br/>（GUI 显式批准入口未做 🚧）"]:::warn
    INPUT["input_artifact + 感知标记<br/>historical/frozen vs live 语义硬隔离<br/>冻结帧不得据此点击"]:::ok

    SESS --> WRITE & LOCK
    UIAB --> W1
    PROBE --> UIAB
    CU --> SESS
    classDef ok fill:#2d4a2d,color:#fff
    classDef warn fill:#6b5320,color:#fff
```

---

## 图 10：持久化与产物（会话/回执/草稿）

```mermaid
flowchart TB
    ES["EventSession（agent_runtime/session.py）<br/>hash-chain JSONL · 跨进程文件锁<br/>turn lease · append 增量采用 O(n)<br/>append-only compaction · crash repair<br/>inbox/message + inbox/consumed 原子领取<br/>cancel/request 持久取消"]:::ok

    subgraph EVENTS2["事件类型（唯一持久真值）"]
        EV1["operation/prepared → settled<br/>effect sandwich（dispatched/outcome/恢复策略）"]:::ok
        EV2["turn/start → end + interaction/start"]:::ok
        EV3["receipt/issued 回执即停止条件"]:::ok
        EV4["artifact/generated / patched / accepted"]:::ok
        EV5["model_request / response · inbox · cancel"]:::ok
    end

    RK["run_kernel/ 冻结 schema + 纯投影<br/>RecoveryPolicy: safe_replay /<br/>verify_before_retry / never_replay"]:::ok
    LEDGER["telemetry/interaction_ledger.py<br/>会话投影公开账单（token/时延/工具/终态）<br/>pointerbench.py 三方基准"]:::ok
    REC["receipts/ schema + projection<br/>unverified / write_verified / draft_generated"]:::ok
    ART2["artifacts/ DraftArtifact revision<br/>批准绑 (revision, contentHash)<br/>written/submitted/verified 待写回链 🚧"]:::warn
    CP["coding_tools.FileCheckpointStore<br/><workspace>/.mp/backups 落盘<br/>+ .mp/tool-results ✨8·29 落盘回读（桥接线待收尾）"]:::new
    CONVST["conversation_store.ts（Electron）<br/>turns: question/answer/thinking ✨/events/<br/>trajectory/activities/receipts/modelUsage<br/>workspaceRoot/permissionGrants"]:::ok
    TASKST["fabric/task_store.py + workflow_task_store.py"]:::ok

    ES --> EVENTS2
    ES --> RK & LEDGER & REC & ART2
    classDef ok fill:#2d4a2d,color:#fff
    classDef new fill:#1f5f5f,color:#fff
    classDef warn fill:#6b5320,color:#fff
```

---

## 图 11：Electron 壳层（main + renderer）

```mermaid
flowchart TB
    MAIN["main.ts 主进程编排"]:::ok

    subgraph CAP2["手势/捕获子系统"]
        M1["wiggle_detector 晃动唤醒"]:::ok
        M2["mouse_activation + pointer_polling_policy"]:::ok
        M3["gesture_capture + pass_through_gesture"]:::ok
        M4["frame_lease + capture_commit_coordinator<br/>+ frame_capture_worker_client"]:::ok
        M5["native cursor（armed-cursor.cur）"]:::ok
    end

    subgraph SESM["会话/选区管理"]
        M6["selection_session + selection_worker_client"]:::ok
        M7["interaction_episode + episodeObjectForSession"]:::ok
        M8["conversation_store + conversation_control<br/>+ conversation_error"]:::ok
        M9["agent_session_id + stash_store + stash_runtime"]:::ok
    end

    subgraph RT["Python 运行时"]
        M10["python_runtime + python_bridge_runner<br/>无活动超时（60s 沉默才杀）+ stderrTail"]:::ok
        M11["bridge_progress_lines 进度行解析<br/>answer_chunk / reasoning_chunk ✨ / plan"]:::new
        M12["model_runtime_config + credential_store"]:::ok
    end

    subgraph STAGE["Stage 策略群"]
        M13["stage_state + stage_surface_policy<br/>+ stage_hit_policy/regions/pick/stretch"]:::ok
        M14["stage_turn_stream + clarification_chips<br/>选项芯片 + steering"]:::ok
        M15["cards + card_render（live 卡）"]:::ok
    end

    subgraph MISC2["其它运行时"]
        M16["update_manager 自动更新"]:::ok
        M17["voice_resident_runtime + voice_worker_client<br/>+ voice_focus_guard + dictation_correction"]:::ok
        M18["background_learning 后台学习（默认关）"]:::ok
        M19["task_watcher + project_inspector +<br/>profile_workspace + project_environment"]:::ok
        M20["proactive_rules + proactive_once_store"]:::ok
        M21["titlebar_contrast + renderer_readiness +<br/>observability + security_hardening"]:::ok
    end

    subgraph RENDERER["renderer/ 页面"]
        R1["studio.html/ts 主工作台<br/>Codex 式左栏 + Composer + Inspector"]:::ok
        R2["dsh_chat.ts DSH 聊天渲染<br/>Think 行 ✨ / 工具芯片 / CodeBlock / diff 卡"]:::new
        R3["stage.html/ts 舞台"]:::ok
        R4["overlay.ts 指针覆盖"]:::ok
        R5["companion / gallery / lab / onboarding / panel"]:::ok
        R6["settings.ts + settings_model.ts<br/>八页真实 schema"]:::ok
        R7["sidebar_groups 会话分组"]:::ok
        R8["permission_presets.ts 权限渲染"]:::ok
        R9["data.ts preload API 面"]:::ok
    end

    MAIN --> CAP2 & SESM & RT & STAGE & MISC2
    MAIN --> RENDERER
    classDef ok fill:#2d4a2d,color:#fff
    classDef new fill:#1f5f5f,color:#fff
```

---

## 图 12：桥接层全图（scripts/ 每座桥的职责）

```mermaid
flowchart TB
    subgraph BRIDGES["生产桥"]
        B1["selection_bridge.py 划线主桥<br/>_loop_router: 插件树 boot + 感知工具接真后端<br/>+ L0 本地动作 + 提案收集 + guard<br/>+ steering/cancel/todo/plan 门"]:::ok
        B2["conversation_bridge.py Studio 对话桥<br/>answer_conversation: 会话身份钉 conversationId<br/>+ 1h FULL_ANSWER + activity sink<br/>+ reasoning ✨/answer 流式 + thinking ✨"]:::new
        B3["selection_snapshot_bridge.py<br/>只消费已冻结 FrameLease<br/>迟到重捕获 fail-closed"]:::ok
        B4["selection_worker.py Stage 常驻 worker"]:::ok
    end

    subgraph SESSIONB["会话/输入桥"]
        B5["agent_session_bridge.py<br/>durable inbox put/pending + cancel"]:::ok
        B6["agent_bridge.py / agent_hook_bridge.py<br/>外部 agent 通道（prompt 投递性质）"]:::ok
    end

    subgraph SPEC["专项能力桥"]
        B7["fabric_bridge.py 模型目录/选择"]
        B8["learning_candidates_bridge.py +<br/>learning_review_bridge.py 自进化审核"]
        B9["expand_passage_bridge.py 段落展开"]
        B10["deliver_text_bridge.py 文本交付"]
        B11["element_probe_bridge.py 元素探测"]
        B12["calendar_bridge.py 日历"]
        B13["shopping_list_bridge.py 购物清单"]
        B14["sense_voice_bridge.py + voice_engine.py 语音"]
        B15["stash_describe_bridge.py 收纳"]
    end

    subgraph INFRA["桥基础设施"]
        I1["_bridge_common.py sys.path 自举<br/>（-I 隔离模式修复）"]:::ok
        I2["bridge_progress.py PhaseClock<br/>mark/mark_blob base64 进度行"]:::ok
        I3["frame_capture_worker.py 常驻捕获"]:::ok
        I4["frame_lease.py TS/Python 双端校验"]:::ok
    end

    subgraph TOOLS["开发/验证工具（非生产链）"]
        D1["smoke/ golden_path_smoke.py"]
        D2["record_desktop_trace + run_trace_replay<br/>+ generate_replay_fixtures"]
        D3["benchmark_agent_loop / frame_capture /<br/>vision_models / voice_engines"]
        D4["uia_tree_dump / check_uia_admission"]
        D5["verify_* ×10 视觉/链路验证脚本"]
        D6["harness_dump_config.py 插件树检视"]
        D7["sync_install.ps1 本机交付"]
    end

    RUNNER2["python_bridge_runner.ts"]:::ok
    RUNNER2 --> BRIDGES & SESSIONB & SPEC
    BRIDGES --> I1 & I2
    classDef ok fill:#2d4a2d,color:#fff
    classDef new fill:#1f5f5f,color:#fff
```

---

## 附：fabric/ 其余模块（能力引擎层）

```mermaid
flowchart LR
    F1["engine.py run_agent_turn 入口<br/>+ FabricEngine plan/execute"]:::ok
    F2["executors.py 18 capability 实现<br/>_ocr/_clipboard/_inplace_text/_model_text/<br/>_table/_evidence/_image_prompt/_map/_agent/_task/<br/>_overlay_translation/_memory_recall"]:::ok
    F3["capability_tools.py recipe→真实工具<br/>真实 ARGUMENT_SCHEMAS · 只 propose"]:::ok
    F4["loop_answer.py terminal→桥回答形状<br/>events/receipts/pendingInput 投影"]:::ok
    F5["model_plan.py 多工具计划（生产取单 call）"]:::legacy
    F6["intent_router.py / router.py<br/>L0 确定性层（本地动作+handoff）"]:::ok
    F7["context_packet.py 上下文包<br/>幂等键（活体脏状态已剥离）"]:::ok
    F8["agent_context_handoff / agent_prompt_dispatch<br/>/ agent_gateway / agent_sessions 外部通道"]:::ok
    F9["mcp.py + mcp_client.py MCP 双向<br/>（MP 既是 server 也是 client）"]:::ok
    F10["settings.py 深合并 RFC 7396"]:::ok
    F11["workflow.py + workflow_task_store.py"]:::ok
    F12["hooks.py fabric 层钩子"]:::ok
    classDef ok fill:#2d4a2d,color:#fff
    classDef legacy fill:#555,color:#fff
```

---

## 已知缺口索引（图中 🚧/P 标注的汇总）

| 缺口 | 图 | 优先级来源 |
|---|---|---|
| edit_file 无未读校验/引号归一化/错误阶梯 | 图 5 | P1-4（8·29 交接） |
| run_command 无退出码语义表 | 图 5 | P2-6 |
| 未知工具错误不附可用列表 | 图 5 | P2-6 |
| skill_catalog 无使用频次计数 | 图 7 | P2-5 |
| delegate_task 单层串行、无后台化 | 图 5 | P3（依赖 Batch A） |
| tool-results 落盘桥接线未收尾 | 图 10 | P1-3 尾巴 |
| messages 协议 thinking 硬编码 disabled | 图 6 | 思考开关（展示流已通） |
| WGC 原生捕获未编译 | 图 2 | wgc_tool_missing |
| ComputerOperator GUI 批准入口 | 图 9 | 产品验收项 |
| DraftArtifact written/submitted/verified | 图 10 | 写回链 |
| crash 从 program counter 续跑 | 图 10 | 长任务批次 |
| 300 步长任务真机基准 | 全局 | LONG_RUN_GAP 文档 |
| macOS 未实机验证 | native/ | STATUS |
```
