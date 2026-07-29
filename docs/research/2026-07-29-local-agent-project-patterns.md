# 本地 Agent 项目架构调研（2026-07-29）

## 范围、结论边界与方法

- 用户所称的 “AI Agent” 目录经仅枚举 `D:\` 一级目录确认，为 `D:\AI_Agents`；该目录包含 `HermesAgent`、`OpenHuman`、`OpenHumanApp`、`kimi-code`、`ZCode` 等。
- 本次只读审计了有完整源码且与桌面指针/本地 Agent 最相关的两个仓库：`D:\AI_Agents\HermesAgent`（MIT）与 `D:\AI_Agents\OpenHuman`（GPL-3.0-only）。`OpenHumanApp`、`kimi-code`、`ZCode` 是已构建二进制，未作逆向或运行，因此不作为可复制实现来源。
- 对 Magic Pointer 的现状以已有 Electron 主进程、常驻语音 worker、设置 schema、权限 grant、diagnostics 为基线；以下建议均是增量强化，**不是**建议替换现有 Python/Electron 架构。
- “直接移植”仅表示技术上可从 MIT 源码取用，仍需保留 MIT 版权与许可；“改造复用”表示保留结构、重写边界；“仅借鉴”表示绝不复制 GPL 代码/文本。许可证判断是工程风险提示，不替代法务意见。

## 最重要的 10 个可执行结论

| # | 借鉴点与具体实现 | 为什么体验好 | Magic Pointer 的落点、成本与建议 | 许可证/复制风险 |
| --- | --- | --- | --- | --- |
| 1 | **显式 worker 就绪协议，而非“已 spawn 即可用”。** Hermes 在 [`backend-ready.ts:38-107`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-ready.ts:38) 监听结构化 `READY port=N`，把 `exit`、`error`、超时收束到一个 cleanup；同文件 [`125-195`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-ready.ts:125) 提供 ready-file 备选。 | 冷启动、杀毒扫描和意外退出不会表现为“界面卡住”；用户能看到确定的启动/失败状态，重试不会累积 listener。 | 为 `electron/voice_worker_client.js` 和任何后续 capture/agent worker 定义一条 JSONL `ready` 消息（含 `protocol_version`、pid、模型/能力摘要）；主进程在收到前只显示 warming，超时诊断记录 stderr 摘要。低—中成本。**改造复用**。 | Hermes 为 MIT，保留版权/许可后可复制小型工具函数；更建议按现有 CommonJS 风格重写。 |
| 2 | **以健康探针选择后端候选，拒绝“文件存在即健康”。** Hermes 的 [`backend-probes.ts:15-32`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-probes.ts:15) 说明候选阶梯；[`68-84`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-probes.ts:68) 用 5 秒 import probe，[`107-123`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-probes.ts:107) 用最便宜的 `--version` probe。 | 避免选择残留 shim、半装环境或“路径有效、运行必死”的 Python；安装/修复 UI 只在确实不可用时出现。 | 在现有 `electron/preflight_checks.js` 前增加“解释器 + `local_voice_worker.py --probe` + 关键模型路径”三段式检查，结果结构化写入 diagnostics。探针必须无网络、无模型加载、有限超时。中成本。**改造复用**。 | MIT；可移植思路/测试组织。 |
| 3 | **Windows 上按进程树关闭托管 worker。** Hermes 的 [`backend-child.ts:4-17`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-child.ts:4) 描述 Python/pty 后代会遗留锁；[`39-54`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-child.ts:39) 选择 Windows tree kill、其他平台 SIGTERM，并将平台分支抽成可测纯函数。 | 退出、设置重载和升级后不会留下占麦克风/端口/模型文件的孤儿进程；异常重复关闭安全。 | 把 `VoiceWorkerClient` 的 stop/fail/close 汇合为一个 idempotent `stopManagedChild`，Windows 用 `taskkill /T /F`，其他平台 graceful → deadline → force；附单元测试模拟 child。中成本。**改造复用**。 | MIT；注意 Windows 命令参数必须固定，不拼接用户输入。 |
| 4 | **把模型驱动操作写成“感知→单步决定→执行→稳定→验证”的闭环。** OpenHuman 的 [`automate.rs:3-19`](D:/AI_Agents/OpenHuman/src/openhuman/accessibility/automate.rs:3) 将重模型排除在 click loop 之外；[`40-48`](D:/AI_Agents/OpenHuman/src/openhuman/accessibility/automate.rs:40) 对步数与 snapshot 大小设上限；[`28-37`](D:/AI_Agents/OpenHuman/src/openhuman/accessibility/automate.rs:28) 把短暂进度发到 overlay。 | 视觉/自动化失败时不是盲点下一步：动作后拿新证据、用户始终知道当前进展，成本和延迟均有上界。 | 对 Magic Pointer 的 selection/action delivery 引入 `ActionReceipt`：`request_id`、前后 target fingerprint、执行原语、结果/原因、置信度、截图/文本证据引用；失败只允许有限次修复，不让 LLM 自行声明成功。中—高成本。**仅借鉴**（GPL）。 |
| 5 | **权限作为窗口/来源/命令三维合同，而不是 renderer 的全权桥。** OpenHuman [`capabilities/default.json:3-38`](D:/AI_Agents/OpenHuman/app/src-tauri/capabilities/default.json:3) 将主/overlay 窗口及 URL allowlist 写成声明；[`webview-accounts.json:3-21`](D:/AI_Agents/OpenHuman/app/src-tauri/capabilities/webview-accounts.json:3) 进一步把不可信第三方来源限制为 `acct_*` webview 的单命令。其安全配置 schema 又明确不向 RPC 返回 API key，[`schema_defs.rs:19-60`](D:/AI_Agents/OpenHuman/src/openhuman/config/schemas/schema_defs.rs:19)。 | 权限审计可读、可测，嵌入网页或新 surface 不会默获主窗口能力；密钥不会随 settings snapshot 漏给 UI。 | 将现有 `permissions.scoped_grants` 扩为统一 capability registry：`surface`（dashboard/stage/worker）、`origin`、`operation`、`resource scope`、`decision/expiry`。预加载层只暴露白名单 IPC；每项 action 记录 grant id。高成本，但可按高风险命令先做。**仅借鉴**（GPL）。 |
| 6 | **设置采用显式 schema、默认合并、校验及可逆迁移。** Hermes 插件决定表在 [`plugins-store.ts:27-52`](D:/AI_Agents/HermesAgent/apps/desktop/src/contrib/plugins-store.ts:27) 用 v2 key，并将旧 v1 disabled-set 迁为显式布尔决定；[`54-71`](D:/AI_Agents/HermesAgent/apps/desktop/src/contrib/plugins-store.ts:54) 将持久化失败降级为非致命。 | 升级后用户设置不会“静默重置”，新默认与用户显式选择可区分；存储配额/损坏不使主流程崩溃。 | 现有 [`electron/settings_store.js:194-469`](../../electron/settings_store.js) 已有 `schema_version=1` 及 strict validation。下一步不要继续无版本地加字段：实现 `migrate(raw): {settings, migratedFrom}` 阶梯、每步纯函数+fixture 测试，并在 diagnostics 显示版本和迁移结果。中成本。**改造复用**（其机制来自 MIT；Magic Pointer 中重写）。 |
| 7 | **缓存是“内存镜像 + 持久 TTL + 单飞 + generation 防污染 + stale fallback”。** OpenHuman [`catalogCache.ts:22-42`](D:/AI_Agents/OpenHuman/app/src/lib/composio/catalogCache.ts:22) 定义两层缓存、in-flight promise 与 generation；[`44-78`](D:/AI_Agents/OpenHuman/app/src/lib/composio/catalogCache.ts:44) 校验持久值、内存热路径和 TTL；[`96-137`](D:/AI_Agents/OpenHuman/app/src/lib/composio/catalogCache.ts:96) 合并并发请求、身份切换时丢弃旧响应、失败时仅对同 generation 回退 stale。 | UI 快速响应、不会并发打爆后端；配置/身份切换后旧异步响应不会覆盖新状态。 | 应用于模型能力发现、浏览器 target 快照和任何远端 catalog；**不要**把 live pointer/selection 这种高频事件做 localStorage 缓存。为高频数据用内存 ring buffer + fingerprint/invalidation。中成本。**仅借鉴**（GPL）。 |
| 8 | **插件的生命周期、热重载和错误边界必须先于“开放插件”。** Hermes [`runtime-loader.ts:1-27`](D:/AI_Agents/HermesAgent/apps/desktop/src/contrib/runtime-loader.ts:1) 明确说完整性 hash 不等于 sandbox；[`97-177`](D:/AI_Agents/HermesAgent/apps/desktop/src/contrib/runtime-loader.ts:97) 先校验模块合同、保存 disposer、失败入库存而非打崩应用；[`237-303`](D:/AI_Agents/HermesAgent/apps/desktop/src/contrib/runtime-loader.ts:237) 用 re-entrancy guard、文件 watch 与慢轮询做增量发现/删除清理。插件 UI 在 [`boundary.tsx:17-58`](D:/AI_Agents/HermesAgent/apps/desktop/src/contrib/react/boundary.tsx:17) 有单插件重试边界。 | 新扩展可在线启停、编辑立即生效，坏扩展只坏自己；“安全隔离”和“故障隔离”没有被混为一谈。 | 当前仅内部 recipes 时，先定义 manifest（id/version/requested capabilities/default enabled）+ disposer + inventory/status；本地开发扩展可用上述 lifecycle。若未来允许下载/第三方脚本，必须 worker/iframe + CSP + capability RPC，**绝不能**照抄 renderer `Blob import()` 管线。中成本（内部）/高成本（第三方）。**改造复用**（MIT），远程加载部分**不要采用**。 |
| 9 | **每个副作用都返回可处理的结果回执，并记忆“已证实不可达”的对象。** Hermes [`delivery.py:246-319`](D:/AI_Agents/HermesAgent/gateway/delivery.py:246) 为每个 target 返回 success/result 或 error；对确认死亡的 target 短路，成功后清除 stale 标记；[`321-365`](D:/AI_Agents/HermesAgent/gateway/delivery.py:321) 同时将本地输出和元数据持久化。 | 批量操作部分成功时不会谎报全成；重复失败不反复浪费用户时间，状态会被成功自愈。 | 为 stage 的浏览器/UIA/文件动作统一 `receipt` protocol，并把“已失效窗口句柄、已关闭 tab、权限拒绝”分为短 TTL negative cache 与永久规则；任何 UI 成功提示都由 receipt 驱动。中成本。**改造复用**（MIT）。 |
| 10 | **诊断、崩溃恢复和打包信息是产品协议。** Hermes [`backend-ready.ts:8-19`](D:/AI_Agents/HermesAgent/apps/desktop/electron/backend-ready.ts:8) 对 Windows 冷启动给合理超时下限，避免健康进程重启风暴；[`preload.ts:204-238`](D:/AI_Agents/HermesAgent/apps/desktop/electron/preload.ts:204) 同时提供 backend exit、power resume、boot snapshot、repair/cancel 和事件订阅，令 renderer reload 后可恢复状态。 | 用户遇到“首次安装慢、睡眠唤醒、worker 崩溃”时有清楚的等待、诊断、repair 路径，而非只有一个转圈。 | Magic Pointer 已有 preflight、voice audit 和 packaged runtime。补齐一个版本化 `RuntimeHealthSnapshot`（应用/worker/模型/权限/最近崩溃/修复建议），在 dashboard 和故障 toast 复用；对 worker crash 使用受限退避重启，保留最后 200 行日志。中成本。**改造复用**（MIT）。 |

## 推荐落地顺序

1. **先可靠性（#1、#2、#3、#10）**：标准化 voice worker `ready`、health probe、进程树关闭、health snapshot；这些不改变用户交互语义，能直接降低“看似随机”的启动/退出问题。
2. **再可信执行（#4、#5、#9）**：所有 pointer/selection/action 进入 receipt + grounding 验证链；先让高风险写入和浏览器动作强制权限合同。
3. **最后可扩展与性能（#6、#7、#8）**：增加 settings migration harness、按数据新鲜度选择缓存，再开放仅本地可信的 recipe/plugin 生命周期。

## 明确不应照搬的内容

- 不复制 OpenHuman 的任何实现、测试文本或 UI：其根仓库是 GPL-3.0（[`LICENSE:1-18`](D:/AI_Agents/OpenHuman/LICENSE:1)），合并/派生进闭源或不同许可的 Magic Pointer 风险高；仅抽取抽象模式并从零编写。
- 不把 Hermes 运行时插件 loader 当作安全沙箱。源码自己在 [`runtime-loader.ts:17-27`](D:/AI_Agents/HermesAgent/apps/desktop/src/contrib/runtime-loader.ts:17) 明示它拥有 renderer 全部权限；hash 只验证字节，不降低权限。
- 不为鼠标移动、实时 stage hit-test 或选择观察引入磁盘 TTL 缓存、轮询发现或大对象 JSON 序列化；这些热路径应保持常驻内存、事件驱动、可取消和有界。
- 不把“模型返回 done”作为动作完成。必须由操作后的 target/snapshot/adapter 证据签发 receipt；验证失败应呈现不确定/失败，并允许用户重试或接管。

## 审计证据与许可

- HermesAgent 许可为 MIT，[`D:\AI_Agents\HermesAgent\LICENSE:1-13`](D:/AI_Agents/HermesAgent/LICENSE:1) 要求在复制的实质性部分保留版权与许可声明。
- OpenHuman 许可为 GNU GPL v3，[`D:\AI_Agents\OpenHuman\LICENSE:1-42`](D:/AI_Agents/OpenHuman/LICENSE:1)。本报告把它列为“仅借鉴”来源，以避免把 copyleft 代码带入 Magic Pointer。
- 未运行、构建、安装、解压、修改或删除 `D:\AI_Agents` 下任何项目；二进制项目只通过目录形态识别，未进行逆向。
