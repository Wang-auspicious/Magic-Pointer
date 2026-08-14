# Claude Code 工具架构研究 + Magic Pointer 路由架构决策（2026-08-13）

> 起因：用户实测指出关键词+recipe 路由从根本上不可扩展（"以后也要加各种功能啊，你总不能都是关键词或者recipe吧"）。本文记录对 Claude Code 源码（`C:\Users\zjz65\PycharmProjects\claude-code-main`，约 1350 个 TS 文件 / 13MB）的调研结论与据此做出的架构决策。

## 1. Claude Code 的做法（读源码结论）

### 1.1 模型就是路由器，没有关键词表

全仓搜索确认：**Claude Code 没有任何基于关键词的意图分类表**。`src/query.ts`（agent 循环）里不存在 `if (text.includes(...))` 这类意图匹配。命令（slash commands）是用户显式输入的，不是猜的。

### 1.2 每个工具自我描述（`src/Tool.ts`）

- `inputSchema`：每个工具自带真实输入 schema（Zod/JSON Schema）。
- `description(input, options)`：**按输入动态生成描述**，不是写死的字符串。
- 每个工具自带：`isReadOnly(input)` / `isDestructive(input)` / `isConcurrencySafe(input)` —— 按输入判定的副作用声明。
- `checkPermissions(input, context)`：工具级权限询问（用户批准/拒绝），模型收到拒绝反馈后自己调整。
- `searchHint`：3-10 个词的能力短语，供 ToolSearch 匹配。

### 1.3 工具规模治理：deferred loading + ToolSearch（`src/utils/toolSearch.ts`）

超过阈值的工具（MCP 工具 + `shouldDefer` 工具）**不进初始 prompt**，只发一个 `defer_loading: true` 的轻量引用；模型需要时调用 ToolSearch 按关键词发现并加载。这就是"以后加几百个工具"的答案：**自描述 + 按需发现**，而不是把所有工具塞进 prompt，更不是关键词路由表。

### 1.4 系统提示词承担行为约束

系统提示词由 section 组合而成（`src/constants/prompts.ts`、`systemPromptSections.ts`）：身份、系统规则、权限模式说明、语言偏好、工具提示等。模型从工具描述 + 系统提示自主决定调用什么。

## 2. Magic Pointer 的对应决策

### 2.1 已落地（2026-08-13 同批）

| Claude Code | Magic Pointer 落地 |
|---|---|
| Tool.ts 自描述 | `app/fabric/capability_tools.py`：每个 recipe 变成带真实 schema（`ARGUMENT_SCHEMAS`）、诚实描述、READ effect 的工具；调用只**生成方案**（propose），走原有 plan/confirm/receipt 链 |
| 无关键词路由 | `scripts/selection_bridge.py`：L0 之后全部走 agent loop（`_loop_router`）——模型按工具描述选择；关键词只剩 L0 确定性本地动作/显式 handoff；`MAGIC_POINTER_LEGACY_ROUTER=1` 为回滚开关 |
| 系统提示词 | `_LOOP_SYSTEM_PROMPT`（身份 + 证据规则 + 方案确认规则 + 简短回答）；`AiClientMessagesBackend` 原生发送 system |
| 感知工具 | `PerceptionTools` 接真实后端（`_BridgePerceptionBackend`：本轮 grounding 证据 + 实时窗口枚举）+ `look` 接真实视觉模型与冻结帧裁剪 |
| 本地动作 | copy/screenshot/show_source 变成模型可直接调用的真实工具（`_register_local_action_tools`） |
| 首轮证据 | 证据块 `[本次圈选对象证据]` 注入 loop 首条消息 |

### 2.2 后续（T4.x 计划）

- 工具规模治理：能力工具超过阈值时改为 defer + `describe_capabilities`（对应 ToolSearch）；当前 ~30 个能力工具直接进 prompt 可接受。
- 按输入动态描述与 per-input isDestructive（当前 effect 静态）。
- 写回工具四道 guard 完整接线后，允许 loop 内执行 REVERSIBLE_WRITE 之外的受控动作。

## 3. 诚实边界

- 关键词路由代码（`IntentRouter.route` legacy API、RecipeRouter）**没有删除**：兼容旧调用方与测试；生产路径不再依赖它做决策。
- L0 确定性短语仍存在（"复制这段文字/截图/让 codex"）——它们零模型成本，属于合理快路径，不是意图分类。
- `_loop_router` 首条消息仍把证据拼进 user 文本（T4.2 的 structured evidence 通道落地前）。