# Claude Desktop 2.110.0.0：交互卡与计划/产物取证

取证日期：2026-09-21。来源仅为本机已安装包的编译 JavaScript；未启动 Claude、未访问网络、未发送模型消息。本文区分 **Desktop 内 Code、Desktop 内 Cowork、普通 Chat**；Claude Code CLI 的终端布局不作为 Desktop 的证据。

原始目录：`C:/Program Files/WindowsApps/Claude_2.110.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1/`。下文偏移均为 Node 读取 UTF-8 后的 **JavaScript UTF-16 零基半开字符区间**。混淆函数名只用于定位。只迁移可观察行为与验收条件，由 MP 独立实现，不复制闭源组件代码、字体或资产。

已阅读本仓 canonical design（沿用本轮前序完整阅读）、`docs/STATUS.md`、`docs/design/VIDA_UI_SPEC.md`、`docs/REFERENCE_PROJECTS_20260810.md` 以及前两份 transcript/smoother 取证。Vida 浮层回执与这里的 Studio 会话卡是不同表面，不混用尺寸。

## 已确认的表面差异

| 表面 | 计划/进度 | 审批/反问 | 产物 |
| --- | --- | --- | --- |
| Desktop Code | transcript 工具详情中的 Todo 列表；另有 Session details 右侧 rail 的 Plan section | 同一审批 cluster 可放 dock 或 inline card；真实宿主按 inline slot 是否存在选择 | 成功 Artifact publish/open 的 transcript 卡；session rail 的 Artifacts；工具 update 不等于新增发布卡 |
| Desktop channel | `channel_status` 消息有独立状态列表，可附每项正在调用的工具 | 复用 Code 审批宿主，但需保留 session 归属 | 未完整追踪 channel 专属产物聚合 |
| Desktop Cowork | activity panel 的 Progress，有专门完成步骤折叠与 activeForm 文案 | 有 Cowork 写入警告、account/session 权限范围；不能等同 Code 永久工具授权 | activity panel 有 Outputs，并区分多种输出来源 |
| 普通 Chat | 本次未确认 TodoWrite/Code Plan rail 路径适用 | 本次未确认与 Code 完全相同 | 本次未完整追踪普通 Chat artifact editor/version 路径，不能用 Code Artifact tool 推断 |

## Code Plan：位置、恢复与折叠

**有两种 Todo 呈现，不能把 transcript 详情当作 composer 常驻计划。**

1. `cd5a31703-B0u11PX5.js` 的工具 body 分派约 `[109644,109855)` 把 `kind=todos` 交给 `Sk`；`Sk [114714,115282)` 渲染 `ul`，每项按 todo.id 标识。默认完成项划线、secondary；未完成 primary。`LE [26576,27425)` 给 completed 勾、in_progress 活动图标、pending 占位图标。工具本身的展开默认沿用 transcript 工具规则，不能因为 Todo 列表存在就自动展开所有工具。
2. `cddc0f8fa-FghV125p.js` 导出 `EpitaxySessionRailHost`，其 `Xt [20231,24865)` 用 sessionRef 读取持久消息投影，再交给 `nt [3888,7498)` 的 `aside[aria-label="Session details"]`。`plan.length > 0` 才显示 **Plan**；没有 Plan 才考虑 Chapters。这个位置是右侧会话信息 rail，**不是 composer 上方永久卡**。

持久投影来自 `cc70f2bdf-BMghKK31.js`：`Aa [28653,29754)` 累积 assistant tool_use；忽略 parent_tool_use_id 子任务记录；Todo/Task 类型变化后重投影全部任务。`za [30350,30442)` 从 session 的 messages 快照导出。因此重新打开同一 session 能从消息恢复，不能只靠当前进程里的最后一个 plan 变量。TodoWrite 解析在 `c28efd0ef-BeQG1lfe.js`：每次 TodoWrite **clear 旧集合，再读整个 todos**；显式空数组就是清空，不能跳过后回退到历史旧计划。

rail 步骤映射 `$e [3305,3612)`：第一个 in_progress 为 current；没有 in_progress、但存在 completed 时，下一 pending 可成为视觉 current；其余 completed 为 done、其他 pending。视觉 current 与业务 completed 不能混同。

`mt [10480,11893)` 和 `tt [3627,3772)` 确认：

- 默认最多 **6 步**。围绕 current（无 current 取最后 completed）显示窗口；窗口起点 `clamp(index - 2, 0, length - 6)`。全 pending 从头显示；全完成显示最后六步。
- `Show all {count} steps` 展开全部；`Show fewer steps` 恢复窗口。展开不改变计划状态。
- 行最小高 `min-h-7`；轨道宽 `w-3`；轨道线 `w-px`；current 圆点 `size-1.5`。普通 1× Tailwind 口径分别为 28、12、1、6 px，但最终尺寸仍受应用 token/rem 环境影响。
- 行 `gap-sm px-xs`，文本 `py-1`；current primary，其余 muted；完成状态另有屏幕阅读器文字，不把完成项删掉。
- 只有真实 `anchorToolUseId` 才可点击跳回工具行；无锚点是静态行。不要为了看起来可点添加空动作。
- section header 为 footnote semibold，section `border-top + py-md`，首段无顶边。不是一张大面积填充色计划卡。

另一个 `w0 [698873,699333)` 是 `channel_status` 的 transcript 卡（调用点约 `[907654]`），有圆角/边框/padding 与工具细节；它不能作为 Code composer 计划的证据。

## 审批卡：宿主、动作与真实提交状态

`cf6ae6197-BIWG4YzD.js [55327,55460)` 的 presentation context 默认 `dock`，另可由 provider 设为 `card`。这只是 context 缺省，不代表用户账号一定看到 dock。实际宿主 `c10f0af0c-zyzZp5a2.js` 约 `[182000,182400)` 按 inline slot 是否存在选择 `card` / `dock`，并 portal 同一 clusterHost。`cf6 [55582,57100)` 移动 host 时保存焦点/滚动；不靠重新创建整个审批表单来换位置。是否启用这些宿主受本版本 feature state 影响；未运行账号 UI，不能断言远程开关值。

公共容器 `cf6 [57949,58801)`：圆角 card、padding **12px**、gap **12px**、max-height **60vh**、container query。dock 才显示背板和 queueDepth 堆叠；inline card 的 queueDepth 传 0。普通工具审批 `cd5 dM [235279,239533)` 在 card 模式 `width:100%; max-width:480px`，正文与动作间 gap **24px**。容器宽度不超过 **420px** 时动作纵向铺满（`cd5 [151766,152556)`）。

普通审批不是无条件固定三按钮：

- Deny 位于一侧；另一侧是有资格出现的 persistent allow 与 Allow once。
- 有 thread/session grant 时显示 session 选项；always 可进入其下拉菜单。account/Cowork 范围可能显示 Allow for all tasks。
- 普通情况下 Allow once 为 primary；`defaultToNo` / denyFirst 会让 Deny 为 primary。clickOnly/defaultToNo 会抑制快捷键或持久授权，不能让所有审批统一默认“同意”。
- Escape、Ctrl/Cmd+Enter、Ctrl/Cmd+Shift+Enter 只在对应卡与面板激活、无输入法组合/弹窗抢占时使用；inline 有 **400ms** 的授权按键保护时间。它不是倒计时自动执行。
- `mM [240286,244298)` 将 AskUserQuestion、ExitPlanMode、computer access、普通工具审批分派到不同组件，不能只靠标题区分却共享同一种数据模型。

**身份与错误恢复：** `c57f8fcae-CHN1gwjx.js` 的 decide 链约 `[6500,9900)` 绑定 sessionId、requestId、toolUseId、toolName。发送前 request 置 `resolving`；失败回调约 `[8673]` 恢复 `pending` 并呈现可重试错误；成功才 resolve/claim/清除 request。IPC 分支也调用带 sessionId 与 requestId 的专用响应接口，成功 promise 后才清理。审批响应不是普通聊天消息，也不能先删卡再假设投递成功。

ExitPlanMode 的 `Bie [153862,160501)` 独立支持 Reject、Revise…、Accept，以及策略允许的接受模式。Revise 打开三行反馈文本框，允许带计划选中文本注释；Open plan 指向计划预览。Todo 进度列表不是 ExitPlanMode 审批。

## AskUserQuestion：完整多题状态机

宿主 `mM` 选择两套已确认变体：非 dock → `Wk [126364,133099)`；dock → `Tie [134320,141748)`。两者共用结构化问题语义，视觉与选择推进方式不同，不能拼成声称“唯一 Claude 行为”的混合卡。

| 行为 | Inline `Wk` | Dock `Tie` |
| --- | --- | --- |
| 标题/导航 | 当前题正文；左右箭头与 `{position} of {count}` | 当前题正文，多个问题时页码徽章；折叠箭头与 X |
| 选项 | 单选圆点或多选框；每项整行可选，描述文本 | 单选数字快捷键；多选框；可键盘选中高亮 |
| 其他输入 | 始终提供 Other 与 textarea；聚焦或编辑会选择 Other | 同样提供 Other，输入区随选择可聚焦 |
| 底部 | Skip；Next 或 Submit | Back（第2题起）；Skip；Next 或 Submit |
| 可提交 | 末题检查全部问题已回答或明确跳过；不足时提示哪题 | 交给共享 `yf` 表单状态机，当前无选择不可提交 |
| 等待响应 | `sending` 使选项/导航禁用、主按钮busy | 保留 sent draft，由外层 request 状态负责恢复 |

Inline 卡 max-width **480px**；题头 `bg-alpha-1 px-lg py-md gap-md`；选项 `px-lg py-lg gap-md`；动作右对齐。Other textarea autosize，最大 **4 行 line-height + 2×pad-sm**。dock 选项圆角 **5px**，Other 内部 gap **12px**，动作间 gap **8px**。这些是编译代码 literal/token，不是屏幕截图实测。

`Wk` 按 tool.id 保存未提交答案和当前页；发送态缓存还带 sessionId 与问题签名。输入被替换后不会用旧题的下标回答新题。`U2` 约 `[724085]` 匹配 awaiting/running AskUserQuestion，优先 requestId/toolUseId；IPC才允许同问题签名匹配。

提交结构为 `{questions, answers: {[question]: string | string[]}, annotations?}`。单选 string，多选 string[]；带 preview 的单选可以生成 annotations。`c10 [174618]` 的 `onAskUserSubmit` 明确调用 **pendingApproval.decide('once', answers)**，不是发送下一条用户 prompt。

`shared-11-CSOy4SpJ.js [153319,153568附近]` 区分：

- Skip：无偏好，可按假设继续；序列化值 `[No preference]`。
- 显式 dismiss：用户取消问题，等待后续指示。
- 用户转而发送消息：将该消息视为回答，不重复提问。

MP 可以使用自己的结构化枚举承载这些语义；不能将三者统统映射成“批准”或“空回复”。选项点击的传输失败应保留答案并恢复可重试卡，成功响应应写进原工具调用的历史。

## Artifact：成功卡、更新与侧栏资格

这里只确认 **Code Artifact tool / session rail**，不把普通 Chat artifact editor 的 version UI 强行推到 Code。

`shared-3-BHNbhkWJ.js`：`Yl [63922,64014)` 将 action 缺省或 publish 识别为发布；`Xl [64014,64079)` 为 open；`Zl [64079,64146)` 为 update；`Ql [64146,64181)` 只匹配 publish/open。另有 pin/unpin、after_first_write 的明确字段，因此创建、更新、打开、固定不是同一状态。

`cd5 l0 [694508,694622)` 要求 Artifact + publish/open + **completed 且非error** + 可解析结果 URL，才进入专用发布卡。`p0/m0 [695485,696039)`：所属 session 可以打开；只读/非拥有表面可显示同样标签但无可操作打开动作。卡本体 `d0 [694805,695485)`：一行 label，截断，图标与打开 affordance；无 handler 时 aria-disabled，不能制造假点击。`u0 [694622,694805)` 只选尚未 opened 的成功 publish 结果作为候选，不能把 update 或 failed 当新产物卡。

`shared-10-CYoZMcc4.js AT [215060,215231)` 只接受合法本地产品 artifact URL，label 取结果路径/URL名；工具结果必须真的可解析。`OT [214407,214922)` 从工具调用+结果重建输出，`after_first_write` 可先 awaitingWrite，后面的实际写入结果才解除等待。**创建了容器不等于内容已写好。**

Code rail `cdd Xt [20231,24865)` 从 sessionFrames 聚合，要求 kind=claudePage、非 reference、URL可用且未删除。列表只在非空时出现；`Z=5` 是默认可见个数，Show all/收起由 `pt [10288,10480)` 控制。`dt [9381,10215)` 显示名称与类型，已知 updatedMs 才显示更新时间 tooltip；单击打开面板，modifier/middle click 可外部打开。

Cowork `c21f11e6d-DzG4FNRY.js` 将 todos、designOutputs、coworkArtifactOutputs、frameArtifactOutputs 等交给 `ce5658dc8-uoBZp7dU.js` 的 activity panel。该面板有 Progress 和 Outputs，但本次未完整追踪每类输出创建/更新/去重的 reducer，因此不宣称它与上述 Code 条件相同。

## Cowork Progress 已确认细节

`ce5658dc8-uoBZp7dU.js ia [6152,7270)` 与 `la [7619,7715)`：flat面板把连续已完成前缀中**最后2步之前**的部分折叠；`Hide earlier steps` / `{count} earlier steps` 可展开。折叠选择按 conversationUuid保存；揭示某个旧步骤时自动展开它。`ga [10573,10645)` 在 in_progress 使用 activeForm，否则 content；运行项可有文字 shimmer。`Hl [116264附近]` 是 Progress section，可折叠；空列表显示“长任务的进度会出现在这里”空态。该折叠算法与 Code rail 的六步窗口完全不同。

## 本轮可以据此改的真实差异

- MP composer 上方的常驻 plan 和只存内存的计划，改为持久事件投影 + 独立任务侧栏 section；不要把它变成另一张审批卡。
- 多题反问必须保留所有题、单/多选、Other、跳过、前后导航、结构化响应及 request/tool 归属；不能只取第一题，把按钮label发成新 prompt。
- 审批与反问都需要 pending → resolving → resolved，失败回 pending。切任务后的旧ACK不得改新任务卡。
- 成功产物引用与工具执行日志、创建中容器、更新事件分开；真实存在且可打开才提供打开动作。
- 不能用新问题到来或整体重画清空用户已选答案、草稿、分页和展开状态。

## 同日补证：Code shell 与两套问题卡的实际尺寸

以下像素值由本机编译 CSS 的 token 定义计算，基准是 Windows 的 16px root、`--cds-rem-scale=1`。不是把 Tailwind 名称当像素，也不是从高 DPI 截图量出的 CSS 尺寸。用户字体大小偏好、实验覆盖和页面缩放仍可改变最终运行时尺寸。

### Code 使用 compact，不能混用 Web comfortable

`c11959232-DSGhSoTs.js [70456附近]` 与 `[75446附近]` 的 Code 根 provider 明确 `density:"compact"`，内部是 `epitaxy-root`。`c229e852c-D1xREEQq.js [946附近]` 的 Code 表面也相同。组件库 `shared-frame-C5qE0AlO.js [14835]` 的默认 context 虽是 comfortable，但 Code 的显式 provider 会覆盖它。

`c6a992d55-CCAJX9iv.css [1163425附近]` 的 `.cds-root` compact 值：

| 变量 | Code compact 的 CSS px |
|---|---:|
| body 字号 / 行高 | 13 / 19 |
| footnote 字号 / 行高 | 12 / 15 |
| prose 字号 / 行高 | 14 / 20 |
| pad xs / sm / md / lg / xl | 4 / 6 / 8 / 12 / 20 |
| gap xs / sm / md / lg / xl | 6 / 8 / 12 / 20 / 32 |
| 普通 control 高度 / nested 高度 | 24 / 18 |
| 普通 icon / radius / composer radius | 16 / 6 / 12 |

同一 CSS `[1195957附近]` 的 comfortable 则是 body14/20、footnote13/17、control32、pad-md12、pad-lg16。已有 Web `scraped/css/computed.json` 的 sidebar288、row32、glyph20 属于该 sidebar 抓取表面，不能拿来推 Code 问题卡 control32。

### Session details rail 与正文

`shared-21-BReOo3jr.js [96332附近]`：

```css
--session-rail-g: var(--session-rail-gutter, 24px);
--session-rail-end: var(--session-rail-g);
--session-rail-measure: var(--chat-column-measure, 768px);
--session-rail-w: clamp(15rem,
  calc(100cqw - var(--session-rail-measure) - 2 * var(--session-rail-g) - var(--session-rail-end)),
  var(--session-rail-max, 20rem));
```

由此 rail **最小240px、默认最大320px**，普通 gutter24px，右边距24px；不是普通文件/产物 Inspector 的560px。正文 `shared-12-BI42rzMP.js [13244附近]` 的 `mh` 默认内容宽度768px，`data-transcript-width=m` 为960px，`l` 为1280px；max-width 外层会把左右 column gutter 加回去。rail 开启时预留 `rail width + rail end`，而不是给正文硬套一个与侧栏无关的固定总宽。

同处 `AS=320+240+24+8`，`jS({width})` 返回 `width>=AS`，所以适配阈值是 **chat pane 可用宽592px**，不是整个窗口592px。当前只确认这个 eligibility 判断；尚未逐个验证其消费者在小宽度时选择隐藏还是浮层，不能把 MP 的窄窗 overlay 策略写成已验证的 Claude 行为。

`cddc0f8fa-FghV125p.js nt [3888,7498)` 的 aside 使用上述 rail width，并 `px-md`，即左右8px。`Q [8138,8612)` section 上下8px、上边线（第一个无），heading左右4px、min-height24px，footnote semibold12/15。`mt [10480,11893)` plan 行 min-height28px、左右4px、gap8px、正文13/19；时间线轨道12px、线1px、当前点6px、文字上下4px。长内容增加真实行高，不固定28px裁切。

### 会话内 Wk 问题卡：完整的一套

选择链是 `cd5 mM [240238附近]`：`I=gm(), L=I!=="dock"`，Ask 分支 `[241127]` 用 `L ? Wk : Tie`。因此移动到真实 inline 宿主后会使用 Wk，而不是只把 Tie 的 DOM 换位置。

`cd5 [245387附近]` 的 inline CSS 明确覆盖：

```css
.epitaxy-root .epitaxy-approval-card.epitaxy-question-card {
  gap: 0;
  max-height: none;
  padding: 0;
  overflow: clip;
}
.epitaxy-root .epitaxy-answer-option + .epitaxy-answer-option {
  border-top: 1px solid var(--cds-border);
}
```

`Wk [126367,133099)`、`xie [125856,126364)` 与 compact tokens 合并后：

| 部位 | Wk inline 几何 |
|---|---|
| 整卡 | max-width480px；外padding0；外gap0；不设60vh限高；随transcript滚动 |
| 题头 | 浅底；横padding12、纵padding8、列gap12；文字13/19 |
| 多题导航 | 题头右侧 previous / position of count / next；小号按钮；可回看 |
| 普通选项 | 横/纵padding12；radio/checkbox与文字gap12；整行可点；相邻行1px分隔 |
| 选项 label + description | 均body13/19，description次要色；二者gap6 |
| Other | 独立选项行；radio/label在第一行；textarea第二行第2列；纵gap8；横/纵padding12 |
| textarea | 始终显示；rows1/autosize；横padding8、纵padding6；body13/19；最低31px，上限88px |
| footer | 横padding12、上8、下12；右对齐；按钮gap8；普通按钮高24px |

textarea 不是选中 Other 后才创建；未选中时 tabIndex=-1，focus/onChange 选中 Other。其最低/最高高度来自 `shared-frame vv [164279]` 的 rows1 与 `cd5 Wk` 的 `4lh + 2*pad-sm`。按钮 `shared-frame gs [46334]` 使用 h-control，文本按钮横pad-md8。单行题头35px、无说明选项43px、footer44px只是内容未换行的推导；文字换行必须增高，不能硬写成每卡固定总高。

### 底部 Tie 问题卡：不能与 Wk 混搭

Tie `[134324,141748)` 依然使用 `cf6 Td [57952]` 的卡外padding12、gap12、max-height60vh；可滚动body为 `jd [59153]`（min-height0、overflow-y:auto）。选项各自圆角5px、横/纵pad-md8；选项间gap3px；label13/19、description12/15，二者gap2。Other内部gap12，textarea同样rows1且始终显示。footer按钮gap8、高24。

`c10 [180184附近]` 的 `rail-composer-dock` 是同一 flex column：approval cluster 在前，普通 composer 在后。`hh [173582附近]` 只在 ExitPlanMode 等具体条件隐藏 composer，普通 Ask 并不替换 composer。打开 inline 宿主时 cluster 被移动进 transcript，才不再占固定底部卡高度。这说明聊天被挤没时，应检查所选宿主和对应整套布局，不应声称 Claude 普通 Ask 默认隐藏输入框。

原始用户 Code 图 `参考claude设计/008952ba378233c3b5743d61fb3f2714.png` 已重新查看：正文、单行输入区和下方独立工具条的紧凑关系与上述 Code 表面一致；没有根据该图片物理像素反算 CSS 宽度，也没有以它证明该账号当下的 inline feature gate。

## 用户补充的三张当前视觉基准

本段以用户在本轮补充的三张图为当前外观验收基准，优先级高于默认 token。三图均已 `view_image` 查看，并使用只读 Pillow 像素游程检查边界，没有重采样后反算尺寸：

- `C:/Users/zjz65/AppData/Local/Temp/codex-clipboard-47329178-aa12-4867-a349-ba31de19e36e.png`：原2398×1982，对应1199×991 DIP，浅色 Code、无右面板、展开工具栈。
- `C:/Users/zjz65/AppData/Local/Temp/codex-clipboard-af68e364-6714-4eb8-9b07-9293889a48f2.png`：原3120×1984，对应1560×992 DIP，深色 Code、右侧 Background tasks、Workflow。
- `C:/Users/zjz65/AppData/Local/Temp/codex-clipboard-9aa4beb0-a7ec-4915-9b92-cf654dde195e.png`：原3120×1984，对应1560×992 DIP，深色 Code、右侧 Background tasks、三个 Agent。

### Background tasks 与 Plan Session rail 是不同表面

两张黑图右侧是 **Background tasks 独立 pane**，不是上文的 Session details rail。原图像素检查：sidebar边界x575/576；Tasks内背景x2274–3102，外边框约x2272–3104；列表卡x2294–3082。除以2后为 sidebar288 DIP、Tasks外框约 **416 DIP**、卡394 DIP、卡距pane内侧10 DIP。这与 Tasks 列表源码 `px-2.5` 完全吻合。

当前未找到可明确归到 Tasks 的通用默认420px常量。`shared-21 [169023]` 虽有420，但它属于 `messages.paneWidth`，**不能当Tasks证据**。Tasks宽度由外层pane/tile布局决定，可能受会话持久状态影响；本次应以用户图416 DIP作为该场景的验收值，而不能把这张图压成Plan rail的240–320。

`cccc2cf0a-Cp2fno1a.js` 的真实组件：

- `mb [238402,242465)`：普通Agent/Bash任务卡。
- `Sb [246239,250158)`：任务列表和真实running/finished分组。
- `Cb [250161,251643)`：section、Finished展开状态（按session持久）、列表。
- `cd5 B6 [828277附近]`：可操作任务的sm secondary Stop按钮，icon-only；compact sm为20×20px。
- `cd5 tse [840758附近]`：Workflow详细卡；只有真实phases存在才渲染Phases，不能从普通Agent集合伪造。

| 部位 | 当前截图 / 编译实现可确认的值 |
|---|---|
| Background tasks pane | 本次截图外框416 DIP；与Plan rail分开 |
| 列表内边距 | 横/纵10px；列表min-width220px |
| Running / Finished section | section之间16px；heading到列表8px；heading footnote12/15 |
| 多张普通任务卡间距 | 4px |
| 普通任务卡 | bg-alpha1、rounded-lg；内容padding8px、纵gap5px |
| 三张Agent卡实测 | 原图y220–374、382–536、544–698，即每张77 DIP高、卡距4 DIP；源码20px Stop撑高标题行，按两处5px gap推导79px。MP按用户图将这两处gap调为4px，得到77px；这是截图匹配，不声称编译源码也为4px |
| 任务标题 | body13/19；长标题换行；running时primary，其余muted |
| 类型/时间一行 | footnote12/15，横gap8px，换行gap3px |
| token/tool uses/current tool/View transcript一行 | footnote12/15，横gap8px，换行gap3px；两个metadata行相距5px、末尾3px |
| 展开详情 | 横padding8、下16、gap5；只有明确展开时显示 |
| Stop | 20×20px，真实running且onStop存在才渲染 |
| Workflow card | padding8、底12；大段之间24px；header段内部12px；title/metadata gap5px |
| Finished | 空时不显示；初始折叠；数量真实；本次截图为文本Clear，本机新版本组件为Trash图标动作，按用户图验收展示 |

### 主会话与 Code composer

两张黑图正文左约338–340 DIP，距离288px sidebar约50–52px；composer左约328px，比正文再向左10px。浅色窄窗图正文/工具栈左约358–360px，原因是 **内容768 + 左右32 = wrapper832px，再在可用空间居中**。因此50px是某个窗口下的结果，不是所有窗口的固定gutter。

普通 Code composer 是 `c099c328d-CAW82TFg.js`：`compact` prop在 `[162992]` 缺省false；`[182516附近]` 的普通分支为text-heading、tiptap min-height44px、上下padding13px、max-height218px。Code compact的heading token为14/18，所以单行18+26=44，符合本次图中约44–46 DIP输入区。它不是Web首页的16/22、scrollmin54。

| 主会话部位 | 当前取值与证据 |
|---|---|
| sidebar | 三图288 DIP |
| 默认正文内容上限 | 768px；外wrapper加左右32px=832px并居中 |
| narration / 工具行视觉目标 | 本次用户图由主验收测量为15/23与15/24；白图工具分隔y722/796/870/944…原像素，周期37 DIP，其中内容36+分隔1；本机默认prose14/20不能覆盖用户图的字号/版本状态 |
| 普通输入区 | font14/18；min44px；max218px；上下13px；默认左10/右4px；p margin0 |
| 有内置附件按钮的输入区 | 编辑文字左padding改4px；附件按钮另有自己的容器 |
| 发送/停止区域 | 默认容器padding10px、自底对齐；普通控制24px；扩展hit area不应当作可见按钮宽高 |
| `compact:true` 输入变体 | 13/19，min36、上下9；这是另一模式，不能拿来覆盖普通Code输入44px |
| pane header | `shared-12 [约9900]` Rm普通32px、zm分隔变体40px；外宿主/Windows titlebar另计，不能把二者合成任意一个header常量 |

本次截图没有给出实时computed font设置，故聊天15/23与本机默认14/20的差异保留为**视觉目标与默认源码基准的差异**，不虚构字号偏好原因。问题卡、任务卡仍应按各自组件层级和本次截图验收，不能把主正文15px全局覆盖所有footnote与按钮。

### 本次深色图的真实填色

对 `9aa4beb0-…png` 的原图区域做颜色频数检查，选取面积最大的平面填色而非文字抗锯齿像素：

| 层级 | 图中 RGB / hex |
|---|---|
| Sidebar | 29,29,28 / `#1D1D1C` |
| 主页面 | 32,32,31 / `#20201F` |
| Background tasks pane | 38,38,38 / `#262626` |
| 普通任务卡 | 47,47,47 / `#2F2F2F` |
| 普通输入框内部 | 44,44,42 / `#2C2C2A` |
| 用户气泡 | 49,49,49 / `#313131` |
| 选中 sidebar 行 | 52,52,51 / `#343433` |

这些是用户当前参考图的实际值，不能用较黑的Web默认主题替代。字体抗锯齿、阴影和渐隐区不适合以单点颜色当基准。

### 左侧导航的紧凑尺寸

三图的 New 与后续导航周期为 **26.5 DIP**，不能用之前 Web computed 快照的32px行高加2px外距。两张暗图的 New / Artifacts / Customize / More 文字墨迹原始 y 范围为193–211、245–264、299–317、352–370；不同字形顶部相差1物理像素，同大写字形 New 到 Customize 相距106物理像素，即两个26.5 DIP周期。白图 New / Customize 首墨迹 y193/246，同样相隔53物理像素。

本机 `shared-styles-BR5YpWif.css` 的 `.dframe-root` 默认紧凑变量为下表；`.dframe-sidebar` 的 line-height 为1.5。该CSS另有 `.dframe-root[data-variant=web] .dframe-sidebar-body [data-row]{margin-bottom:.5px}`；截图没有运行态DOM，不能仅凭图中Code入口就宣称框架variant值，但26px行高加0.5px外距与三图实际周期相符。Desktop comfortable特例是30px，Web comfortable是32px，两者均不是本次截图的行密度。

| 导航部位 | 当前参考值 |
|---|---|
| 单行高度 / 相邻行周期 | 26px / 26.5px；对应下外距0.5px |
| 文字 | 13px，line-height1.5即19.5px |
| 行左右padding | 2px |
| leading slot / 内部gap | 24px / 4px |
| 普通图标 | 16px |
| New圆形 / 加号glyph | 18px / 13px |
| 辅助行控件 | 20px |
| label左边界 | row x8 + pad2 + leading24 + gap4 = x38 DIP；三图New墨迹起点raw x78=39 DIP，Artifacts/Customize raw x77=38.5 DIP，符合字形bearing |
| 首行垂直位置 | 行top88、高26、center101；New墨迹y96.5–105.5 DIP |

`shared-20-DDaeJOX2.js [146794附近]` 的 nav variant 直接使用 `df-row-h`、`df-row-px`、`df-row-gap` 和 `df-row-font`。这些是该控件的独立几何，不要求删改MP自身的Projects、Scheduled、Design入口来复制参考图的导航数量。

会话选中行同为26px高：暗图平面选中填色原始y482–533、浅图376–427，均52物理像素。会话标题同13/19.5，label box x38，6px状态点居于24px leading槽中、中心x22。项目/Recents组标题不使用nav的leading槽：`shared-20 tj [158470附近]` 使用group-font12、line16、pt12、pb4、min-height34（12+(26−8)+4）；`df-label-inset` 默认2+(24−16)/2=6，即sidebar row x8后文字box x14，符合浅图项目名称首墨迹raw x30=15。透明标题盒的实际高度受trailing控件撑高，截图不能单独确定总盒高；不把它误报为26px会话行。具备24px普通流操作控件时，应容纳该控件而不裁剪。

### 同窗口复测记录

`scripts/probe_studio_claude.ts` 已更新为当前持久轨迹 `record.subagent` fixture，恢复接口提供确定性空结果，避免不存在的测试preload方法产生假错误条；同时记录实际input、narration内部p、卡片、header、工具行、导航行的DOM与computed值。

2026-09-21，最终生产build 3590完成后，1199×991浅色conversation与1560×992深色subagent探针均正常退出，console errors为空、horizontal overflow为0。浅色正文与composer均x359.5、width768；深色正文x338/width748，composer x328/width768；真实input均14/18、高44、外框46，发送按钮24。深色Tasks pane x1136/width416、header32、卡x1147/y110/width394/height77；narration内部p为15/23。独立打开工具组后实测工具行高36，相邻行y602/639与746/783，即36+1的37px周期。截图fixture文字与用户图不同，故这些结果是对应窗口/控件尺寸验收，未声称整张图片逐像素相同。

此轮发现的旧comfortable导航32+2px、font14、leading28/gap8已由主代理修正。build25962完成后重跑同两窗口并实际查看PNG：导航DOM top为88/114.5/141…，height26、margin-bottom0.5、font13/19.5、label x38、gap4、普通icon16/New glyph13；会话行height26、title x38、font13/19.5；项目名12/16，header padding12/6/4、min-height34，20px trailing操作控件使实际高度为36，符合自适应内容盒。上述正文、composer、输入与Tasks几何全部保持，未新增范围内需修尺寸。两次探针均exit0、renderer console errors为空、horizontal overflow为0；并行Electron进程stderr出现共享GPU cache访问告警，不能声称进程所有输出均无告警。

最终可复查产物（PNG已查看，JSON记录对应DOM/computed）：

- `data/runtime/claude-geometry-review/final-white-conversation.png` / 同名 `.json`：1199×991 DIP，原图2398×1982。
- `data/runtime/claude-geometry-review/final-dark-subagent.png` / 同名 `.json`：1560×992 DIP，原图3120×1984。

## 证据边界

本次主要证据是本机 2.110.0.0 编译实现，不是当前账号实时运行态截图。已补齐 Code compact token 的 CSS 像素基准；未确认 feature gates 在该账号的实际值、远程策略、用户字号覆盖后的最终 computed 尺寸、普通Chat完整artifact版本栏、所有Cowork输出类型。本文没有声称 UI 像素级一致或真实Claude会话验收完成。范围内实现应以以上确证状态机与对应表面为准；未知项保留未知，不能自行补成“Claude默认逻辑”。
