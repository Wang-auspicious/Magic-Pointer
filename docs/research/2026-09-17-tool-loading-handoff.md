# 2026-09-17：Pi / DeepSeek 接手与工具加载基础

## 回读结论

这次停点是“下一轮开始做工具加载”的未实现方案，并非已经发生的工具加载死锁。

本机回读来源：

- `C:/Users/zjz65/.pi/agent/sessions/--D--Desktop-Magic Pointer--/2026-09-16T07-44-46-917Z_01a0a92c-e545-741f-851b-9f3d88efa0e9.jsonl`：Studio 的 Claude 对照实现、素材来源与交互修正。
- 同目录 `2026-09-17T01-01-48-062Z_01a0ace2-509e-7cf5-9c28-6c1dc3f62518.jsonl`：真实 Claude 页面 CSS、字体和图标提取；对应本机 `参考claude设计/scraped`。后续用户明确禁止继续打开浏览器/Claude，本次没有打开。
- `C:/Users/zjz65/.claude/projects/D--Desktop-Magic-Pointer/0a5d3c1b-3c3e-4a6e-8705-90099b610000.jsonl`：实际 DeepSeek v4.1 flash 的续作记录。末段 7266/7287 讨论 eager/deferred 工具，7291 为用户删除冗余工具、列出名字/短描述并按需加载的要求，7309 停在提案，未实现。

Pi 文件中的模型标识分别为 Gemini 与 Muse；不能因为任务统称“Pi agent”就把 DeepSeek 的实际续作日志漏掉。

## 已经完成的近期工作

与提交、代码和验收文件交叉核实后，本次沿用这些成果：

1. **Studio 交互与素材**：实际 Claude 字体/图标、侧栏与 Composer 尺寸，IN/OUT 工具卡、Artifact 卡及面板、文本 Reply/side chat、Mode 菜单、左侧导航轨、context 卡。近期提交包括 `7e90484`、`77cdab0`、`cbf5c67`、`63f2771`、`8043d0b`、`1f32a17`、`61176e3`。
2. **执行与故障收敛**：权限决定从 GUI 到 Runtime 的接线（`a114543`），此前的输出截断、上下文超限、空回合恢复、压缩预算与工作区相关改动。依据 `docs/BUGLEDGER_20260916.md`、`docs/VERIFICATION_20260916.md` 和 `docs/research/2026-09-16-harness-parity-audit.md`，不重复实现已有修复。
3. **指针和性能**：已做采样路径与重复光标相关处理，以及启动、模型首 token 等分阶段耗时观测；保留现有计时与 `usedBackend` 契约。
4. **成本定位**：`docs/COST_20260917.md` 将多轮重复输入、工具 schema 和权限循环分开分析。`659aa57` 已读取嵌套 `prompt_tokens_details.cached_tokens` 并分段显示上下文。不能再把“界面原来没显示 cache”推断成“服务端没有缓存”。

接手时已有未提交改动：`app/ai_client.py` 的空 HTTP 200 兼容重试、`app/agent_runtime/subagent.py` 的工具 schema 限额与子任务轮数分离、`electron/renderer/icons.ts` 及对应测试、测量脚本和素材。这些不是本批新实现，保留并纳入工作树验证。

## 本批实现

- 删除模型注册表上的 14 个 recipe 包装器：`text_transform`、`clipboard_text`、`data_export`、`image_ops`、`screen_help`、`task_route`、`place_route`、`agent_handoff`、`table_merge`、`compare_objects`、`research_card`、`vision_bridge`、`canvas_transform`、`recipe_scale`。删除旧 `app/fabric/capability_tools.py` 及只覆盖这些包装器的测试；显式应用操作与文档动作继续走原执行器。
- 新 `app/agent_runtime/tool_discovery.py` 直接根据 ToolRegistry 生成短目录。`Tools(names=[...])` 一次精确加载多个工具；不知道名称时才用 keyword。返回名称和提示，完整参数仅出现在下一轮工具声明，避免结果与声明各复制一次。
- 常见文件/搜索/计划及 `ListApps`、`Observe` 保持直接暴露，专用桌面、本地和等待工具按需加载。真实感知、`Recall`、MCP 保留。未加模型路由器、备用注册表或 intent 分类层。
- `Tools` 在有工具配额时优先保留，精确名称搜索优先于描述模糊命中。单次 bridge 与 resident host 使用同一 bundle row。
- 从已有成功 `operation/settled` 回执恢复实际发现或执行过的工具名称。压缩和进程重启后取当前 schema/权限，不复活删除的实现；旧 eager 请求列表不被当作使用证据。
- 删除 `conversation_store.ts` 一个没有读取方的累计变量，修复 fresh lint 的既有阻断；有界错误报告仍由原 `failureReports` 和间隔控制。

## 验证与测量

TDD 先观察生产 boot、目录、精确批量加载和恢复失败后再修改实现。第一轮扩大回归 **359 passed**。随后增加 names 批量跨压缩恢复、只读模式下已加载写工具仍拒绝执行，定向 **21 passed**。

相同 advanced-tools fixture、工作区和 `tool_limit=128`，用项目 `estimate_request_tokens` 计算；加载目录已计入成本：

| 指标 | 之前 | 之后 |
|---|---:|---:|
| 注册工具总数 | 62 | 48 |
| 首请求完整 schemas | 41 | 18 |
| schemas + 目录估算 tokens | 4995 | 3794 |
| 本地 schema 选择均值（100 次） | 0.084 ms | 0.145 ms |

减少 **1201 tokens / 24.0%**。这些数字针对相同配置的工具声明部分；真实 conversation bridge 有 Context/Knowledge 等声明，数量不同。它们不是整轮任务账单下降 24% 的证据，也不证明首遇专用工具时没有新增模型往返。

证据：`data/runtime/tool-loading-baseline.json`、`data/runtime/tool-loading-after.json`（本机运行产物）。

### 真实默认 Provider / 桌面读取

通过原 `scripts/conversation_bridge.py`，read-only 权限，要求批量加载 `find_roots`、`inspect_ui`，执行前者并报告数量；没有启动 UI 或点击输入。

- 成功回环：首请求 15 个 schemas，不含上述两项；Tools 一次精确加载后第二请求包含它们，共 17 个 schemas；随后真实桌面 `find_roots` 成功，最终回答“共找到 3 个顶层窗口。”
- `usedBackend=magic_pointer.messages_multiturn_streaming`，Tools backend 为 `tool_registry_search`，执行 backend 为 `desktop`。
- 3 次模型请求；桥内 **18077.95 ms**，连同 Python 启动/退出进程共 **20461 ms**；Tools **0.093 ms**，桌面读取 **4.062 ms**。
- Provider usage：input **14628**、output **136**、total **14764**、cacheRead **11584**。不将缓存量重复计入 total，不外推到其他 Provider。
- 首次尝试：Tools 与 find_roots 均有成功回执，最后一条为第 3 次 `model/request`，外部验收进程在 180s 截止。不能宣称两次都成功，也不能把最后一次模型未完成归因于工具加载。

成功原始结果/计时：`data/runtime/tool-loading-live-20260917.stdout.json`、同名前缀 `.stderr.log`。成功 durable session 为 `agent-studio-conv-2e374ac018aec4348f7a808e2fa83dcd`；超时尝试为 `agent-studio-conv-a36921ef84cd43906edc939dbd2b61d7`。

本次真实验收覆盖目录批量加载和一个真实只读桌面调用。跨压缩恢复、写权限边界由确定性测试覆盖；不据此宣称 Office/Figma 原生编辑或全部模型协议验收完成。

恢复仅适用于当前已注册的工具。MCP 仍保持“调用 mcp_search 才启动服务器”的原有契约：bridge 进程重启后，远端工具必须重新发现，不能仅凭历史名称恢复不存在的注册或启动服务；resident host 内已存在的注册可正常恢复。MCP 搜索结果原有的参数重复也未在本批改动。

## 交付

**1.0.46 已同步安装版并重启。** `npm run sync` 的 fresh 全量验证通过：lint/typecheck 全绿、Node **217 个测试文件**、Python **2129 passed / 1 条既有 Pillow warning / 232.80s**。Electron/Figma bundle 和 NSIS 构建成功；Figma 缺真实 plugin ID 的原有验收边界不变。

安装器：`release/sync-1.0.46-20260917-224339-40812/Magic-Pointer-1.0.46-x64.exe`。完整日志：`data/runtime/tool-loading-sync-1.0.46.log`，进程退出码 0。

安装目录独立核对：package version 为 **1.0.46**，8 个 Python 文件和 3 个编译后 JS 文件与工作树逐字节相同；用安装版自带 Python 导入安装目录内的新模块，执行 `Tools(names=[InstalledRead])` 和只读 fixture 均通过；5 个应用进程的路径均为 `%LOCALAPPDATA%/Programs/Magic Pointer/Magic Pointer.exe`。

现有 sync 使用 robocopy `/E`，不会清除源树已删的文件。本次额外删除安装目录里已退役的 `app/fabric/capability_tools.py` 及对应 pycache，确认不再存在；未扩大为安装目录清理或改动用户数据。
