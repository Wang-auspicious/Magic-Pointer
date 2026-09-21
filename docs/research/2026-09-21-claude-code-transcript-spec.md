# Claude Desktop 2.110.0.0：Code 对话过程的渲染规格

取证日期：2026-09-21。回答"发一条消息给 Claude Code 桌面端，它自己讲的那整个过程，细节能不能全拿到"。

**能。** 而且拿到的不是"看起来像"，是**规则本身**——因为这个客户端的设计系统在编译产物里带着开发期断言，把不变量直接写成 `cds:` 警告字符串。下面每一条都有文件与字符偏移。

范围：本机安装包的静态资源。没有启动 Claude，没有访问账号或网络，没有改动 MP 生产代码。位置口径同前两份：JavaScript UTF-16 字符零基半开区间。

## 一、行原语：`TurnStatus` + `TurnStatus.Step`

`c05970c42-6in_lYKc.js`（40,688 字符）是本机可读到的 **Claude Design System (CDS) 的 TurnStatus 实现**。Code transcript 的每一行都搭在它上面，不是各自拼 DOM。

组件签名（从 props 反推）：

```
TurnStatus        open / defaultOpen / onOpenChange / stepCount / label / state / ...
TurnStatus.Step   label, detail, meta, metaTitle, state,
                  stoppedLabel, deniedLabel, trailing,
                  open, defaultOpen, onOpenChange,
                  actions, actionsLabel, href, onClick, children
```

开发期断言直接写出了三条硬规则（原文为英文 `cds:` 消息）：

| 断言 | 规则 |
| --- | --- |
| `~16975` | `<Step href>` 是导航行，**没有展开态**；children / open / defaultOpen / onOpenChange 一律被忽略 |
| `~26194` | Step 与 TurnStatus 标签相同会被**合并**进同一行，此时展开态归 TurnStatus，Step 自己的不生效 |
| `~26194` | 由宿主控制 `open` 时，`stepCount` 表示"展开时恰好这么多行"，收起时更少 |

也就是说：**能展开的行和不能展开的行是两种东西，展开态归属在合并时上移**。这套约束是写在代码里的，可核对，不是猜的。

## 二、展开规则：用户选择优先，默认几乎全关

`cd5a31703-B0u11PX5.js` 的 `nN`（工具行，`@252788` 起）里：

```js
O = defaultOpen || (kind === 'question' && typeof output !== 'string' && !isError) || Ef(name) || false
[k, A] = FM(tool.id)          // 按工具 ID 取保存的展开态
expanded = forced || (k ?? O)  // 保存值优先于默认值
```

`Ef` 从 `cc4053f14-DMvKAUQW.js` 导入，那个文件只有 445 字符，`Ef` 就是：

```js
function i(e){ return e === r }   // r = "PushNotification"
```

**所以 Claude 只有 `PushNotification` 这一个工具默认展开。** 其余全部默认收起，展开与否只看用户在该 tool id 上的历史选择（`FM` 存 `rows[id]`，组用 `LM` 存 `groups[id]`）。运行中最后一个待回答的 question 会临时默认展开。

这条直接对上用户说的"有的是折叠，有的是自动展开，就很乱"——MP 现在的规则是"单个 chip 就自动展开"（`dsh_chat.ts:1075-1091` 的 `single` 分支），Claude 没有这条规则。

## 三、工具文案表：`CO`

`cd5a31703` `@52298`，**39,578 字符**，是本机取到的最大单块语义表。按工具名分派，返回：

- `verb` / `runningVerb` / `failedVerb` —— 过去式、进行式、失败式三种说法
- `runningLabel` / `doneLabel` / `failedLabel` —— 行首状态标签
- `meta` / `metaIsCode` / `metaHref` —— 右侧那句短细节（文件名、命令、链接）
- `kind` —— 该行属于哪一类渲染（已见 `question` / `diff` / `file` / `todos` / `agent_status` / `peerMessage`）

规模：45 个 `case` 分支、**445 条本地化文案**。覆盖 `Read` `Write` `Edit` `MultiEdit` `NotebookEdit` `Bash` `PowerShell` `Glob` `Grep` `LS` `LSP` `Task` `Agent` `Skill` `BashTool` `AskUserQuestion` `EnterPlanMode` `ExitPlanMode` `EnterWorktree` `ExitWorktree` `CronCreate/Delete/List` `TaskCreate/Get/List` `SendMessage` `SendUserMessage` `SendUserFile` `ReportFindings` `Monitor` `ScheduleWakeup` `ListMcpResourcesTool` `ReadMcpResource*` `RefreshMcpTools` `RemoteTrigger` `Artifact` `ClaudeDesign` `ShareOnboardingGuide` `SendFeedback` …

抽样文案（说明这不是简单动词，而是带宾语的整句）：`Message sent to another session` / `Archived session` / `Added repository to project permissions` / `Switched model` / `Failed to rename session`。

**这是 MP 最缺的一块**：MP 的标签是零散拼接，没有三态文案、没有 meta 通道。

## 四、行内插槽：`trailing`

`iN`（`@261094`）把 Step 之外的附加信息集中成 `trailing` 数组，槽位按固定顺序：

1. `agentModel` —— 子 Agent 用的模型
2. `heartbeat` —— 渲染成 `工具名 · 次数`，工具名 `max-w-[24ch] truncate`
3. `annotation`
4. 「Manage settings」按钮（`KwsmcD3XKk`）
5. live task 链接（按 taskId）
6. diff 统计（`+N −M`，组件 `sg`）

行本体是 `qf.Step`，传 `{state, label, meta, metaTitle, stoppedLabel, deniedLabel, trailing}`；有 `onClick` 时退化为不可展开的导航行（符合第一节的断言）。

## 五、思考与动画

- 思考行 `m2` / `g2` 与模式切换 `h7`（`setTranscriptMode("thinking"|"normal")`），展开态同样走 `FM(id)`，**没有保存值时缺省展开**——这是与工具行相反的方向。
- 动画不是 spinner，是**帧序列精灵图**：`Wt=["thinkingFast","toolCall1","thinkingFast","toolCall2","thinkingFast","toolCall3"]` 是运行期序列；`Z=[0,0,2,3,…,2]`、`$=[8,7,6,6,…,0,0]` 是显式帧数组；`mainSparkSheets` 与 `nodeMarkAnimations` 是**按需动态 import 的独立 chunk**（`c98f11b7a`、`cca15fd43`），首屏不加载。
- 时序常量：`Ht=200`、`Ut=32`、`Kt=4000`、`en=600`、`Q={from:48,to:58}`。
- 状态机 `{kind:'intro',startFrame:0}` / `{kind:'run'}`，带 `at: performance.now()`。

## 六、MP 现状对照

| 项 | Claude | MP 现在 | 差在哪 |
| --- | --- | --- | --- |
| 行原语 | 单一 `TurnStatus.Step`，插槽模型 | `dsh_chat.ts` 1726 行，各类行各自拼 DOM | 没有统一原语，行为无法成体系 |
| 展开默认 | 保存值优先，默认只有 question / PushNotification 开 | **单个 chip 自动展开**，成组收起 | 用户点名的"很乱" |
| 组展开态 | `groups[id]` 独立 store | `data-open` 写在 DOM 属性上 | 刷新/重投影后能否保留取决于重建 |
| 图标 | 每个工具行有状态图标 + 帧动画 | 原语支持图标（`disclosureRow({iconName})`），思考行用了 `think`；**工具行不传**，只有 chev/copy/check/browse | 用户点名的"图标你没用" |
| 文案 | 45 工具 × 三态 × meta，445 条 | 零散拼接，无三态、无 meta 通道 | 语义密度差一档 |
| 思考行 | "Thought process"，缺省展开，专属动画 | `thinkNode` 传 `open: false`，缺省收起 | 方向相反（断言口径：Claude 无保存值时缺省展开） |
| 动画 | 帧序列精灵图，按需 chunk | 静态 SVG | 观感差距的主要来源 |

## 七、可做的事（按代价从小到大）

1. **先改展开规则**：去掉"单个 chip 自动展开"，改成"保存值优先、默认全关、只有待回答的 question 默认开"。这条改动小、立刻消除"很乱"。
2. **把展开态从 DOM 属性搬到独立 store**（按 tool call id / group id），与现有 `FM`/`LM` 同构。
3. **加工具文案表**：给现有工具补 `verb / runningVerb / failedVerb` + `meta` 两列，行首标签走三态。
4. **思考行方向对齐**：缺省展开。
5. **加 per-tool 图标**：MP 已有 `dsh_icons.ts`（search/check/chev/copy/edit/think/browse/code/api/sparkle/send），需要补到每个工具一行一个。
6. **帧动画**：最贵，且是观感差距的大头。可先用 CSS 关键帧近似，不必一步到位。

## 边界

- **没有运行 Claude UI**：不知道真实帧率、这些动画在用户账号下是否被远程开关覆盖。
- **没有原始 TS / sourcemap**：混淆名（`CO`/`nN`/`FM`/`Ef`/`qf`）是打包生成的，不是官方标识符；`CO` 的完整分支只抽样读取，未逐条核对全部 445 条文案。
- **CDS 是闭源设计系统**：断言字符串能读，但它是编译产物，不能当作官方文档引用。
- **图标不可复制**：Claude 用的是 Anthropicons 字体，MP 必须用自己的图标集，只对齐"每个工具行有图标"这条行为。
- 按 MP Reuse Gate：**取行为、参数口径与验收样本，由 MP 独立实现**；精确切片只留在本地参考目录，不进 MP 生产代码。
