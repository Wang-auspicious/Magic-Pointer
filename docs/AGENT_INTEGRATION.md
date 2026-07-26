# Agent 接入：native first，MCP last

Magic Pointer 不是让模型先猜“有没有一个 pointer 工具”再主动拉取。主链是在用户刚冻结
对象、并在 Agent 中说“修这个 / use this / @pointer”时，把同一个有期限的
`THIS/THAT/THESE/HERE` Episode 注入 Agent turn。

## 接入优先级

| 优先级 | 形式 | 当前实现 | 为什么 |
|---|---|---|---|
| 1 | Agent 原生 hook / plugin | Pi `before_agent_start`；Claude `UserPromptSubmit`；Gemini `BeforeAgent` | 在规划前进入上下文，不依赖模型发现工具 |
| 2 | 原生会话协议 | Pi JSONL RPC steer；Codex `app-server`；OpenCode server；结构化 CLI | 支持 session、流式事件、暂停、接管和回执 |
| 3 | ACP | 预留为跨 Agent 会话客户端协议 | ACP 面向 client↔agent 会话、图片、权限与流式更新，比 MCP 更适合做统一会话面 |
| 4 | 结构化 headless CLI | Codex/Claude/Gemini/Cursor/OpenCode/Aider | 覆盖没有常驻插件接口的 Agent |
| 5 | MCP | 已实现兼容 server | 只给没有 hook/plugin/session API 的产品做反向工具兼容 |

MCP 不再是产品叙事或默认接入。它保留的原因是标准化程度高、一些 Agent 目前只有这条
扩展路径；但实时上下文注入、Agent loop 控制和后台任务都不依赖 MCP。

## 零复制上下文 hook

统一 hook 程序：

```text
scripts/agent_hook_bridge.py
```

它只在以下条件同时成立时注入：

1. hook 事件是 Claude `UserPromptSubmit` 或 Gemini `BeforeAgent`；
2. prompt 包含 `@pointer/@this/this/that/here/这个/这段/这里/屏幕/选区` 等明确指代；
3. `current-object.json` 存在且没有过期。

它不会重新截图，也不会在每条 prompt 中静默塞入陈旧上下文。注入内容包含对象 ID、槽位、
应用、窗口、文件或截图路径、页码、bbox 和已有文本；敏感应用的视觉回退在捕获阶段已被
阻止。

预览 hook 配置（只读）：

```powershell
python scripts/install_agent_hooks.py --provider all
```

明确安装：

```powershell
python scripts/install_agent_hooks.py --provider all --apply
```

安装器合并现有 JSON，不覆盖其他 hooks；输出不会回显用户设置中的凭据。也可手工参考：

- `integrations/claude/hooks.example.json`
- `integrations/gemini/hooks.example.json`

官方生命周期依据：

- Claude Code hooks / `additionalContext`: https://code.claude.com/docs/en/hooks
- Gemini CLI hooks / `BeforeAgent`: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
- Gemini CLI extensions: https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md

## Pi：默认开源 Agent loop

上游源码固定在：

- `external/pi`
- commit `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- MIT

Magic Pointer Extension：

```text
integrations/pi/magic_pointer_extension.ts
```

它提供：

- `magic_pointer_current`：读取冻结 Episode，不重新捕获；
- `magic_pointer_recipes`：列 30 个 Recipe；
- `magic_pointer_plan`：生成签名计划；
- `magic_pointer_execute`：只有显式 `confirmed=true` 才能越过确认门；
- `/pointer <instruction>`：把当前对象作为真实用户 turn 发给 Pi；
- `before_agent_start`：普通 prompt 说“这个 / @pointer”时注入现场。

临时加载：

```powershell
$env:MAGIC_POINTER_ROOT="D:\Desktop\Magic Pointer"
pi --extension "D:\Desktop\Magic Pointer\integrations\pi\magic_pointer_extension.ts"
```

后台任务使用真实 `pi --mode rpc` JSONL：初始 `prompt`、运行中
`streamingBehavior=steer`，收到 `agent_settled` 才写终态。排队不等于完成。

上游协议依据：

- Pi extension lifecycle: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Pi RPC: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md

## Codex、OpenCode、Cursor 和 Aider

- Codex：优先 `app-server` 的 Thread/Turn/Item JSON-RPC；一次性使用
  `codex exec --json`，图片通过 `--image` 附加。
- OpenCode：目标是 plugin hooks + HTTP OpenAPI，会话事件优先于 MCP。
- Cursor：当前 `beforeSubmitPrompt` 可以观察或阻断，但公开能力仍不能可靠附加动态
  `additionalContext`；因此使用 headless CLI/附件，不伪装成已实现上下文注入。
- Aider：使用 message file，禁止 Magic Pointer 自动 commit。
- ACP：适合作为未来统一 session client/proxy 层；当前不把尚未接通的 ACP 适配器标成
  READY。

参考：

- Codex app-server: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenCode plugins: https://opencode.ai/docs/plugins/
- Cursor hooks/loop: https://cursor.com/blog/agent-best-practices
- ACP architecture: https://agentclientprotocol.com/get-started/architecture
- ACP proxy extensions: https://agentclientprotocol.com/rfds/proxy-chains

## Action graph、loop 与安全

每个 `OperationPlan.preview.workflowGraph` 都显式包含：

```text
ground → route → approval (if needed) → execute → verify
```

Agent provider 会把图标为 durable，后台 TaskStore 保存 task id、协议、日志、steer、
cancel 和终态。图不是让模型自由发散的 LangGraph 替身，而是 Magic Pointer 自己可审计的
动作合同。签名覆盖 provider、对象、参数、确认要求、preview graph 和幂等键；Renderer、
hook、MCP 或 Agent 都不能篡改后直接执行。

图像生成、公式、图表 digitizer、Figma 或日历专用 provider 未配置时，计划明确显示
`capabilityFallback` 并把来源文件/截图交给已安装 Agent；连 Agent 也不可用时返回
`capability_unavailable`。
