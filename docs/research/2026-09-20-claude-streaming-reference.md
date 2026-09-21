# Claude Desktop 2.110.0.0：思考流、子 Agent 与实时渲染取证

取证日期：2026-09-20。范围为本机已安装 Windows 包的静态资源；没有启动 Claude，没有访问账号、登录状态或网络，没有改动 Magic Pointer 生产代码、测试或包配置。

## 结论

可以读到真实客户端的**编译后 JavaScript、组件状态逻辑与 CSS 参数**。本机 `ion-dist/assets/v1` 的 3,186 个文件中有 2,963 个 JavaScript；没有 `.ts`、`.tsx`、`.map`，这些 JavaScript 也没有 `sourceMappingURL`，包含 inline source map 的情形。因此目前不能说取得了原始 TypeScript、源码文件名、类型声明或服务端实现。AST 格式化只能提高编译产物的可读性，不能恢复原始 TS。[来源与清点][provenance]

最值得 MP 采用的已证实行为有三点：

1. **数据到达与界面提交分开**。Code 的文本流有单独缓冲器，可见面板约每 33ms 提交一次；非活跃面板 100ms，文档隐藏时 200ms。首段内容立即提交，结束事件会提交待显示尾段。
2. **子 Agent 是有父工具身份的活动记录**。父工具持有模型、最近工具、调用次数；运行状态与子任务详情导航来自结构化状态，不靠把子 Agent 日志混进父回答。
3. **展开态与内容分开保存**。Code 的工具/思考行按稳定 ID 保存展开态；Chat 用实际内容高度和 ResizeObserver 判定是否需要 Show more。不能在空思考块创建时只计算一次“是否很长”。

这些是客户端源码取证结论，不是对 Claude 真机帧率、内存或后台协议端到端的验收。

## 原始来源与定位方法

本机权威来源目录：

`C:/Program Files/WindowsApps/Claude_2.110.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1/`

本次存档目录：

`参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/`

该目录有 `extract.cjs`、63 项精确片段的原文/格式化版本，以及 `provenance.json`。每个片段记录安装包原文件、混淆函数名、文件大小、文件修改时间及字符位置；没有为取证增加哈希。位置均为 **JavaScript UTF-16 字符的零基半开区间 `[start,end)`**，不是 UTF-8 字节偏移。`.original.js.txt` 是原串切片，`.formatted.js.txt` 由 TypeScript AST printer 格式化，仍然是 JavaScript。

| 证据 | 原文件与位置 | 作用 |
| --- | --- | --- |
| Code 流提交 | `c06cf64bb-BLUe6JQe.js`，`bm/xm/ym` `[132541,133237)` | 可见性相关提交间隔、首次立即提交 |
| Code 生命周期 | 同上，`Cm/wm/Tm/Em/Dm/Om` `[133359,134526)` | 每会话缓冲、订阅、结束刷新、销毁清理 |
| 子 Agent 事件归属 | 同上，`os` `[40075,40448)` | `parent_tool_use_id` → 父工具活动 |
| 子 Agent 行 | `cd5a31703-B0u11PX5.js`，`nN/iN` `[252788,262455)` | 最新工具、次数、模型、状态、详情入口 |
| 思考显示模式 | 同上，`m2/g2` `[712408,713759)`、`h7` `[937784,939483)` | Code Thinking 模式与稳定展开态 |
| Code 状态行 | 同上，`m7` `[930936,937783)` | 思考/重试/压缩/停止/任务数量 |
| Chat 思考内容 | `c3e2391e3-CyTSz9uV.js`，`wS/OS` `[153105,154990)`、`EC` `[181815,183074)` | 内容截高、测量、流式与完成判定 |
| Chat 运行摘要 | 同上，`Uh` `[27818,34416)` | 运行中摘要、子步骤、展开后的焦点处理 |
| 稳定投影与滚动 | `cd5a31703-B0u11PX5.js`，`L9` `[968929,971110)`、`nfe` `[980167,988583)`、`cfe` `[995827,1003063)` | 复用投影、稳定行身份、用户滚动优先 |
| 子任务详情导航 | `c5638815a-lka5E1z2.js`，`Oe` `[6047,6347)` | 打开 `{kind:"subagent", toolUseId, description}` 面板 |

## 真实的文本流合并与订阅

`$p` 把接收的事件按 text、tool、thinking 分块。文本和思考分别追加到已有块；工具参数追加 `partialJson`。`Cm` 用会话 ID 从 Map 取复用的缓冲状态，状态包含一个 `commitTimer`、最后提交时间、主内容块、思考块、订阅者集合和最后快照；并设置 `dont_smooth=true`。[块解析器][block-parser]、[每会话状态][buffer-state]

`bm` 的实际提交间隔为：

| 当前表面 | 间隔 |
| --- | --- |
| `document.hidden` | 200ms |
| 可见面板 | 33ms |
| 面板不可见/不活跃 | 100ms |
| 面板可见性回调缓存 | 1000ms 后才重查 |

`xm` 中，尚无主内容且第一次出现思考，或从纯思考变成主内容时立即调用 `ym`；其他增量根据“上次提交 + 当前间隔”计算剩余时间，仅保留一个待提交 timer。`wm` 收到 `content_block_stop` 或 `message_stop` 时，如果有待提交 timer，立即提交。`Tm` 是显式 flush；`Em` 重置，`Dm` 清 timer 并删除会话状态。[间隔选择][cadence]、[提交调度][schedule]、[事件入口][feed]

一个细节对 MP 的 CPU 很有价值：如果只有思考块、`wantsThinkingCount===0`，`lm` 只更新最后快照，不广播订阅者；打开思考的订阅者才增加该计数。这是“数据完整保留，没人在看的内容少触发 UI”的真实实现。[思考订阅][thinking-subscription]

边界：`wm` 明确忽略非 null 的 parent 参数，因此这里的 33/100/200ms 是**顶层 Code 文本流**的规则，不能直接宣称每个子 Agent、Chat 或所有面板都采用同一周期。本文件中这条提交链用 timer，不是 `requestAnimationFrame`。其他局部滚动/尺寸观察确实使用 rAF，但不能混为一谈。

## 思考内容：Chat 与 Code 是两种表面

### Code 的正常视图与 Thinking 视图

`g2` 先检查 `Wh()` 决定是否显示思考；不显示时返回 null。其状态行 `h7` 通过 `setTranscriptMode("thinking" | "normal")` 切换整份 transcript 的思考显示，并保留焦点、不主动滚动。进入对应的新样式后，`m2` 显示 “Thought process”，展开状态来自 `FM(id)`；没有保存值时缺省展开，verbose 模式强制展开。**这不等于“Code 默认就展开全部思考”**：正常模式有前置隐藏门。[Code 思考行][code-thought]、[Code 模式切换][code-mode]

`FM` 的展开态不来自文本长度，也不来自重新创建的 `<details>`。其 store 的 `rows[id]`、`groups[id]` 是独立状态，更新某行只改该行对应键。`nN` 同样按工具 ID 查询展开态；普通工具默认关闭，问答等特殊工具可打开。新的工具结果和子 Agent 活动不会天然重置用户的展开选择。[展开存储][expansion-store]、[子 Agent 行][agent-row]

### Chat 的运行摘要与长思考

`Uh` 是 Chat 的 TurnStatus：运行中优先显示实时 label；存在运行中的工具时展示其真实 label；等待输入、失败、完成分别为独立 state。子步骤采用 `step.key`，运行中 Agent 数量来自实际 `agent && state==="running"` 的步骤。它接收保存的组展开状态，收起时若焦点在内部 panel，焦点移回 toggle 并 `preventScroll`。[Chat 运行摘要][chat-status]

普通思考块进入 `EC` 后，由“本消息仍流式且没有 stop_timestamp（或末块因 max_tokens 截断）”判定 `isStreaming`。摘要 highlights 与原始 thinking 是不同路径，`alternative_display_type==="working"` 又有独立路径；本次没有把这三种路径合称一个通用动画。[Chat 思考状态判定][chat-thinking]

`wS` 的具体长内容行为：

- `SS=200`，仅在**非 streaming 且非特殊直接显示上下文**时应用最大高度。
- 它读取实际 `scrollHeight`，内部内容变化由 `ResizeObserver` 重新测量；内容确实超过 200px 才出现 Show more。
- 收起时有底部 40px 渐变遮罩；Show more 默认鼠标悬停/焦点可见，触摸条件始终可见。
- 展开时使用测得的实际高度，`max-height` 变化为 **300ms ease-out**；再次收起回 200px。
- 流式内容不被这个内层 200px 上限截高；是否出现在 transcript 仍由外层状态组决定。
- 运行中 `aria-live="off"`，避免每个 token 都让辅助技术重复播报。

所以 MP 可以学习“动态测高、保持展开状态、分开状态行和思考内容”的行为，不能简单认为 Claude 是“固定三行、每 token 改 innerHTML”。[长内容组件][long-thinking]

## 状态文字与动画参数

Code `m7` 将停止、连接/等待、重试、压缩、思考和普通运行分开；重试保留 attempt/maxRetries，子任务区能在主运行结束后继续显示剩余运行任务或已完成任务。时间/Token 的一般统计展示有 2 秒门槛，不是任务一开始就同时闪出一排占位数字。[Code 状态行][code-status]

`_le` 按 15、30、45、60 秒选择不同思考文字；完成时的 “Thought for” 来自 `thinking.kind==="done"` 和 seconds。`gle` 比较活动/完成状态，仅活动阶段不因累计思考内容每次变化而令状态标签变化。另一个 `al` 格式化器按实际毫秒时长生成秒、分、小时文字。[状态词选择][thinking-words]、[完成时长][duration]

动画取证：

- Code 状态文字变更 `oD`：进入 opacity 0 / y +3 → opacity 1 / y 0，退出 y −3；180ms，ease `[0.2,0,0,1]`。存在 reduced-motion 路径。
- Code thinking shimmer：opacity 1 ↔ 0.75，2 秒 ease-in-out，开始延迟 3 秒；reduced-motion 下停动画，hover/focus 保持清晰。
- 工具行 `CM(...,650,...)` 对显示状态交换做时间保持，避免短任务一闪而过；它不是工具执行计时器，也不是增量文本的节流。

以上参数来自编译客户端，不表示 MP 必须复制该客户端内部过渡架构。特别是“Almost done thinking”只是超时长文案，不能在 MP 里据此保证模型即将完成；本项目可以采用中性的持续处理提示。[状态切换][morph]、[shimmer][shimmer]、[工具状态保持][status-hold]

## 子 Agent：父子身份、活动摘要与详情

`os(event, toolMap)` 只处理有 `parent_tool_use_id` 的 assistant 事件。它找到对应父工具记录，遍历子 assistant 的 `tool_use` 块，将 `latestToolName`、累加的 `toolCallCount`、模型写进父工具的 `subagentActivity`。构建 transcript 的 `Cp` 在这些子事件分支里调用 `os` 后 `continue`，避免把子记录当作普通父回答继续投影。这是事件归属，不是靠工具名和时间猜匹配。[父子活动投影][subagent-event]

`c497618d0::se` 仅在父工具运行中且为 Agent 类工具时生成 heartbeat 字段，包含最近工具、显示名与计数。模型显示是另一个有条件字段。`nN` 对 Agent/Task 行显示这些信息；`iN` 将最近工具限制在 `24ch` 并截断，次数仍保持可读。[规范行投影][projected-tool]、[子 Agent 行][agent-row]

这里的 **heartbeat 是客户端字段名和活动摘要，不是本次已证明的固定周期网络心跳**。一次子工具事件能更新该摘要；没有工具事件时不能据此声称它会每 N 秒刷新思考全文。

点击 Agent 行时，`nN` 优先调用 `subagentOpener(tool.id, description)`；pane 上下文的 `Oe` 将它变为 `pushPaneView(tileId,{kind:"subagent",toolUseId,description})`。模型/工具摘要留在父 transcript，完整子过程有专属查看位置。子工具不能混成父任务工具，也不能在父 Agent 调用返回后就把仍在后台运行的子任务错误标记完成：`nN` 会组合 wire 状态与单独 background 状态，并区分 completed、failed、stopped。[子任务详情][subagent-pane]、[子 Agent 行][agent-row]

## 长 transcript 与滚动

Code `L9` 保留前一次投影，下一次 `cX` 构建接收前一状态；输出的 rows 与 entry index 供渲染消费。`nfe` 使用 memo、row ID、entry key、tool ID 和片段存储，估计行高并交给滚动层。可确认其状态与 row identity 是独立概念，不能从静态分析进一步保证所有 DOM 节点在任意操作中都绝不更换。[行投影][rows]、[行渲染][row-render]

`cfe` 的滚动代码保留目标 row ID；行索引变化时重新按 ID 定位。用户 wheel、touchstart、pointerdown、mousedown、keydown 会取消正在进行的目标定位补偿。历史片段释放使用 `requestIdleCallback`（有超时退路），在用户手势、恢复、查找、滚动调整等期间让步；当前可见内容与仍在使用的片段不能随意释放。平滑滚动使用 rAF，并识别外部滚动变化；reduced-motion 跳过平滑过渡。[滚动与历史片段][scroll]

这些证据支持 MP 保留阅读位置、只更新活动行及必要尾段。它不要求 MP 为当前几千条记录立即重造一个完整虚拟列表框架。

## MP 实施建议与验证边界

以下是基于上述事实的**本项目建议**，不是已经修改或验证完成的实现：

| MP 实际问题 | 可采用的行为 | 应证明的结果 |
| --- | --- | --- |
| 思考节点从空文本创建，长短判定不再变化 | 内容增长后重判高度/可展开性；展开状态留在节点或独立 ID 状态中 | 空 → 长 → 完成能展开，用户展开后继续流式不被关掉 |
| 每个增量重新遍历全部 trajectory | 保存已投影位置；合并同一绘制周期内增量，结束前 flush | 高频增量不丢尾字，不反复重建旧工具/旧思考 |
| 子任务更新时重建整个 details 列表 | 按 child task ID 建立稳定行，逐项更新状态/最近活动 | 展开、滚动、焦点在新事件后保留 |
| 子事件缺父 Agent call 身份 | 每条子任务事件带稳定 child ID 与 parentCallId | 两个并行 Agent 的活动不会串到同一父工具 |
| 子任务只有 started/finished | 将真实工具开始、完成、模型活动按事件投影 | GUI 能说明子任务正在处理什么，同时诚实保留失败/停止状态 |
| 思考与最终输出混淆 | 状态行、可展开思考、工具活动、最终正文分别投影 | 没有思考输出的模型不出现伪造思考；完成保留既有内容 |

取证中没有运行 Claude UI，因此没有 Claude 的实际帧时间、CPU/RSS基线或用户账号下功能开关结论。没有拿到原始 TS；没有查验 server 端子任务调度。这里的客户端事件流是结构化文本/工具事件，**不能作为 Claude 已实现 KV-cache 直连或 C2C 的证据**。

## 许可证与复用裁决

本机安装包是闭源应用编译产物，未发现把这部分客户端实现授权为开源库的依据。按 MP Reuse Gate，本次结论是：**提取行为、参数和验收样本，由 MP 独立实现**。精确片段只存本地参考目录，不导入或整段复制到 MP 生产代码，不把混淆名还原猜测包装成官方源码。63 项原始切片的内容与记录位置已直接比对；未为纯研究报告跑产品全量测试。

[provenance]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/provenance.json
[block-parser]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c06cf64bb-BLUe6JQe.dollarp.129041.formatted.js.txt
[buffer-state]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c06cf64bb-BLUe6JQe.Cm.133359.formatted.js.txt
[cadence]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c06cf64bb-BLUe6JQe.bm.132681.formatted.js.txt
[schedule]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c06cf64bb-BLUe6JQe.xm.132948.formatted.js.txt
[feed]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c06cf64bb-BLUe6JQe.wm.133704.formatted.js.txt
[thinking-subscription]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c06cf64bb-BLUe6JQe.lm.130785.formatted.js.txt
[code-thought]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.m2.712408.formatted.js.txt
[code-mode]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.h7.937784.formatted.js.txt
[expansion-store]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.jM.248347.formatted.js.txt
[chat-status]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c3e2391e3-CyTSz9uV.Uh.27818.formatted.js.txt
[chat-thinking]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c3e2391e3-CyTSz9uV.EC.181815.formatted.js.txt
[long-thinking]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c3e2391e3-CyTSz9uV.wS.153105.formatted.js.txt
[code-status]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.m7.930936.formatted.js.txt
[thinking-words]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5._le.927464.formatted.js.txt
[duration]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c36902c73-CVYbZ7Wg.al.77129.formatted.js.txt
[morph]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.oD.32755.formatted.js.txt
[shimmer]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/code-thinking-shimmer.original.css.txt
[status-hold]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.CM.246839.formatted.js.txt
[subagent-event]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c06cf64bb-BLUe6JQe.os.40075.formatted.js.txt
[projected-tool]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c497618d0-CH7iwBUi.se.6024.formatted.js.txt
[agent-row]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.nN.252788.formatted.js.txt
[subagent-pane]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/c5638815a-lka5E1z2.Oe.6047.formatted.js.txt
[rows]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.L9.968929.formatted.js.txt
[row-render]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.nfe.980167.formatted.js.txt
[scroll]: ../../参考claude设计/scraped/extras/desktop-2.110.0.0/streaming-reference/cd5a31703-B0u11PX5.cfe.995827.formatted.js.txt
