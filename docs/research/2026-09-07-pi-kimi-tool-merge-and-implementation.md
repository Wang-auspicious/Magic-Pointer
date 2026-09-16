# Pi 与 Kimi 桌面工具合并拆解

日期：2026-09-07  
范围：Pi `pi-computer-use@4b8dbd7` 的 8 个公开 UI 工具，与 Magic Pointer 现有 Kimi 风格 13 个桌面工具。  
目的：消除重复工具的语义分叉，同时把每个保留工具的用途、输入、状态边界、底层实现、验证方式和失败语义讲清楚。

## 先给结论：不是 21 个平行工具

Pi 和 Kimi 的差异主要是“观察／引用／验证协议”不同，不是有两套完全不同的鼠标键盘能力。

- Kimi 13 个工具偏向**直接动作 API**：模型先拿 `snapshot_id + index`，再调用 `Click/Type/...`。
- Pi 8 个工具偏向**状态查询和动作编排 API**：模型先得到 `state_id + @r/@e ref`，再搜索、局部展开、读取、等待，并在一个 state 上执行最多 20 步。
- 两者真正重合的底层能力只有三组：窗口发现／观察、原子 UI 动作、等待与动作后验证。
- `Launch`、`Focus`、`turn_ended` 是生命周期／协议工具，不应硬塞进 UI 元素工具。
- `search_ui`、`expand_ui`、`inspect_ui`、`read_text` 是 Pi 的观察查询能力，Kimi 13 个里没有等价物，应保留。

因此，推荐的 MP 对外工具面是 **15 个职责清楚的工具**，而不是同时暴露 21 个名字：

| 合并后的工具 | 来源 | 是否合并 | 主要职责 |
|---|---|---:|---|
| `list_apps` | Kimi `ListApps` | 保留并规范化 | 列出可绑定的应用／窗口资源 |
| `launch_app` | Kimi `Launch` | 保留 | 启动应用并返回候选资源 |
| `activate_window` | Kimi `Focus` | 保留 | 把已确认的窗口置前并重建绑定 |
| `observe_ui` | Pi `observe_ui` + Kimi `Observe` | 合并 | 建立不可变 UI state 和有界 outline |
| `find_roots` | Pi `find_roots` + `ListApps` 的查询部分 | 合并 | 在窗口／菜单／弹层森林中找根资源 |
| `search_ui` | Pi `search_ui` | 新增保留 | 在同一 state 的元素索引中查询目标 |
| `expand_ui` | Pi `expand_ui` | 新增保留 | 对一个元素局部展开上下文 |
| `inspect_ui` | Pi `inspect_ui` | 新增保留 | 读取元素的完整语义、能力和定位证据 |
| `read_text` | Pi `read_text` | 新增保留 | 读取元素或子树的文本，不执行动作 |
| `click` | Kimi `Click` + Pi `act_ui` 的 `click` step | 合并 | 单次点击，适合简单动作和兼容旧调用 |
| `type_text` | Kimi `Type` + Pi `act_ui` 的 `typeText/setText` step | 合并 | 输入文本或设置值并读回 |
| `press_key` | Kimi `Key` + Pi `act_ui` 的 `press/keypress` step | 合并 | 发送键盘组合键／导航键 |
| `scroll` | Kimi `Scroll` + Pi `act_ui` 的 `scroll` step | 合并 | 滚动目标区域或窗口 |
| `set_value` | Kimi `SetValue` + Pi `act_ui` 的 `setText` step | 合并 | 通过 Value/Text pattern 设置控件值 |
| `act_ui` | Kimi `Act/Select/Drag` + Pi `act_ui` | 合并编排 | 在一个 state 中执行 1–20 步并验证 successor |
| `wait_for` | 既有 MP `WaitTool` + Pi `wait_for` | 合并 | 有界等待 UI 条件成立或消失 |
| `end_turn` | Kimi `turn_ended` | 改名保留 | 释放本轮输入所有权并结束工具回合 |

表中看似有 17 行，是因为 `click/type_text/press_key/scroll/set_value` 既可作为兼容入口，也可作为 `act_ui` 的 step kind；它们不是额外的底层执行器。真正的执行内核只有一个。

## 统一状态模型

所有观察和动作都必须落到同一条状态链：

```text
find_roots()
  -> root_ref (@rN, 物理窗口/菜单/弹层)
observe_ui(root_ref)
  -> state_id + 有界 outline + element refs (@eN)
search_ui/expand_ui/inspect_ui/read_text(state_id, @eN)
  -> 从缓存 state 查询，不重新拍一张不相关的图
click/type_text/... 或 act_ui(state_id, steps)
  -> ActionLease + stale 检查 + InputOwnershipLock + Effect
  -> 原生 UIA/DOM/COM 操作
  -> 读回／postcondition
  -> successor state_id + diff + Receipt
```

`state_id` 只是“模型看到的观察代际”，不是权限凭据。真正允许写入的条件仍由 MP 的 `FrameLease`、`ActionLease`、`SurfaceGrant`、输入锁、stale 重探和 Effect/Receipt 决定。

## 逐工具拆解

### 1. `list_apps`

**解决的问题**：不知道当前机器上有哪些可绑定的应用窗口时，提供资源目录；它不读取完整 UI 树，也不执行动作。

**输入**：可选 `app`、窗口标题、进程名、`visible_only`、`include_background`。

**输出**：有界窗口列表，每项包含 `window_id/hwnd`、pid、app、title、bounds、visible、focused、kind，以及可继续交给 `find_roots` 或 `activate_window` 的引用。

**底层实现**：调用 MP 的窗口枚举／SurfaceAdapter，而不是截图 OCR。Windows 上使用窗口句柄和前台窗口信息；UIA 只在需要建立 root 时唤醒。结果不携带可写授权。

**与 Pi 的关系**：Pi 的 `find_roots` 直接返回可操作根；MP 保留 `list_apps` 作为资源目录，避免把“列目录”和“在目录中按条件找 root”混为一件事。

**失败语义**：枚举为空是合法空结果；权限或窗口已销毁是明确错误，不伪造一个 root。

### 2. `launch_app`

**解决的问题**：启动尚未运行的应用。

**底层实现**：通过已登记的应用启动策略执行进程／URI／快捷方式启动，等待窗口候选出现，再返回候选 `root_ref`。启动本身不等于窗口已经 ready。

**状态边界**：启动后的窗口必须重新 `find_roots` / `observe_ui`；旧 state 不可用于新窗口。

**失败语义**：启动失败、超时、没有窗口、窗口被其他实例占用分别返回；不把“进程创建成功”当成“应用可操作”。

### 3. `activate_window`

**解决的问题**：把已选窗口置前，处理 UIA／键盘输入的焦点目标。

**底层实现**：按 `window_id` 做前台切换和焦点确认；随后重建当前 surface binding。不会仅凭标题猜测窗口，也不会自动把其他窗口抢成目标。

**与 Pi 的关系**：Pi 的 root 选择通常隐含在 resource scheduler；MP 显式保留 Focus，因为 Windows 输入和旧 Kimi 调用需要一个明确的生命周期动作。

**失败语义**：窗口不存在、无法置前、置前后身份不符都失败，并要求重新 `list_apps/find_roots`。

### 4. `find_roots`

**解决的问题**：在多个窗口、菜单、弹层或浏览器页面根中，找出模型要观察的物理资源。

**输入**：`text`、`app`、pid、`kind`、可选 `focused`。

**输出**：有界 root 列表：`@rN`、窗口身份、进程、标题、bounds、focused、root kind。

**底层实现**：先用窗口／SurfaceAdapter 枚举物理资源，再按语义过滤；菜单和弹层进入独立 root 需要 UIA event／原生树证据，不用 OCR 猜测。root 引用只在其 state/resource 代际内有效。

**与 `list_apps` 的合并边界**：`list_apps` 是目录；`find_roots` 是可供观察的资源选择器。二者共享枚举器，但输出契约不同。

### 5. `observe_ui`

**解决的问题**：冻结一个可引用的 UI 观察状态，避免后续动作拿着“刚才看过的画面”盲点。

**输入**：可选 `root_ref`、观察模式（semantic/fused/ax 等）。旧 Kimi 的 `window_id/app/mode` 参数继续兼容。

**输出**：`state_id`、`root_ref`、bounded outline、每个元素的 `@eN`、role/name/value/rect/capabilities，以及 source/epoch 信息。

**底层实现**：优先读取 UIA ControlView 和可用 pattern；需要视觉证据时由 MP 的 FrameLease 冻结完整目标 surface，再做 OCR/视觉融合。元素树进入 bounded snapshot cache，后续查询不重新抓取。

**与 Kimi `Observe` 的合并**：`Observe` 的 snapshot_id 成为兼容别名；规范输出采用 `state_id/root_ref/@eN`。旧 index 仍可用，但动作前必须做同样的 stale 重探。

### 6. `search_ui`

**解决的问题**：在当前 state 中按文本、role、capability 找目标，不让模型依赖易变的数组下标。

**底层实现**：查询 observe 阶段建立的有界元素索引，按 exact、prefix、substring 和 role/pattern 过滤排序；不会重新截图或跨 state 搜索。

**输出**：匹配元素的 `@eN`、name/value/role/rect、匹配原因和 state_id。

**失败语义**：空匹配是正常结果；state 不存在或已过期是 stale，要求重新 observe。

### 7. `expand_ui`

**解决的问题**：只展开某个元素附近或其子树，获得更多上下文而不是一次性倾倒整棵 UI 树。

**底层实现**：在同一 root/resource 上对指定 `@eN` 做局部 UIA subtree read，限制 depth、节点数和输出字节数；未来可用 rootDelta 只返回变化部分。

**当前 MP 边界**：现在是有界扁平投影上的局部读取，不等同于 Pi native helper 的完整 RuntimeId 树；父子关系增强列为下一批。

### 8. `inspect_ui`

**解决的问题**：在准备写动作前，读取一个元素的完整语义证据。

**底层实现**：按 `@eN` 回到缓存节点，再在 stale 校验后读取 role/name/value/description/bounds、可用 pattern、enabled/focused/selected、automation id/runtime id（若 adapter 提供）和可执行 capability。

**用途**：让模型知道元素是 Invoke、Value、Selection、Toggle 还是只能坐标后备；它不执行动作。

### 9. `read_text`

**解决的问题**：只读取文本、值或可读子树，不把读取误报为截图，也不触发输入。

**底层实现**：优先 ValuePattern/TextPattern/Name/DocumentRange；必要时读取 bounded 子树；OCR 只作为明确标记的后备证据。

**与 `inspect_ui` 的区别**：`inspect_ui` 是“这个元素能做什么以及如何定位”；`read_text` 是“它当前显示／保存的文本是什么”。

### 10. `click`

**解决的问题**：兼容旧 Kimi 的单次点击。

**底层实现**：规范入口先解析 `state_id + @eN`；兼容 `snapshot_id + index` 时转换为同一内部目标。优先 Invoke/SelectionItem/Toggle pattern，不能语义调用时才在当前 FrameLease 的坐标证据上点击。

**安全与验证**：ActionLease revalidation、InputOwnershipLock、写后重新观察；Receipt 记录目标、方式、结果。它是 `act_ui` 的单步特例，不再有第二套点击实现。

### 11. `type_text`

**解决的问题**：向文本控件输入文本，或替代旧 `Type` 的兼容入口。

**底层实现**：优先 ValuePattern/TextPattern 或控件语义输入；不得把普通键盘注入当成唯一实现。输入前确认目标 role/capability，输入后 readback 验证值或文本变化。

**与 `set_value` 的区别**：`type_text` 表示用户式输入，可保留选择／光标语义；`set_value` 表示控件值的明确赋值，允许走 ValuePattern。

### 12. `press_key`

**解决的问题**：发送 Enter、Escape、Tab、快捷键等键盘动作。

**底层实现**：确认当前 ActionLease 的焦点窗口，经过输入所有权锁发送 key chord；动作后只在有可观察 postcondition 时报告完成，不能把 key event 送达等同于业务成功。

### 13. `scroll`

**解决的问题**：滚动窗口、列表、文档或目标容器。

**底层实现**：优先 ScrollPattern；否则在当前目标 surface 和焦点绑定上发送滚轮／滚动输入。滚动后产生 successor observation，因为原 `@eN` 的可见性和坐标可能改变。

### 14. `set_value`

**解决的问题**：对输入框、滑块、下拉值等控件做明确值设置。

**底层实现**：优先 UIA ValuePattern/RangeValuePattern/SelectionItem；没有语义 pattern 才降级为选中、输入、确认的组合。必须检查 enabled、类型和读回值。

### 15. `act_ui`

**解决的问题**：把一连串同一 state、同一 resource 上的动作放进一个有界事务，减少“每一步都重新路由”的模型轮次。

**输入**：`state_id`、最多 20 个 step、可选 `expect`。step kind 包括 `click`、`press`、`setText/typeText`、`keypress`、`scroll`、`drag`，以及兼容 `Select/Act` 的语义动作。

**底层实现流程**：

1. 检查 state/resource/epoch 和每个 `@eN`；
2. 获取同一资源 lane 的 ActionLease 和输入锁；
3. 每一步调用统一的 click/type/key/scroll/set-value/drag executor；
4. 每一步失败都保留失败位置，不把后续步骤伪装成已执行；
5. 执行 `expect` 对应的 `wait_for`；
6. 重新 observe，生成 successor `state_id`、added/removed/changed diff 和 Receipt。

**与 Kimi `Act/Select/Drag` 的合并**：

- `Act` 的二级动作成为 `act_ui` 的 semantic step；
- `Select` 成为 selection step，底层优先 SelectionItem pattern；
- `Drag` 成为 drag step，必须携带当前 geometry/FrameLease 证据；
- 旧的单步调用继续可用，但内部转译为同一 executor。

**边界**：不能跨两个 state 批处理；不能用旧 state 重放；不能用“事件发送成功”代替业务 postcondition。

### 16. `wait_for`

**解决的问题**：等待一个元素出现、消失、值改变或角色条件成立，避免模型盲目 sleep／重复 observe。

**输入**：`state_id`、text/ref/role/value 条件、`until=present|absent`、有界 timeout。

**底层实现**：当前 MP 使用同一 root 的 UIA probe 重读；每次重读都重新确认窗口身份，条件成立时产生 successor state。未来可由 UIA WinEvent 替代大部分 polling，但仍必须保留 timeout 和取消边界。

**失败语义**：`found=false, timed_out=true` 是诚实的等待超时；不会返回成功，也不会吞掉应用无响应或 state stale。

### 17. `end_turn`

**解决的问题**：释放本轮的真实输入所有权，结束一次 Kimi 风格工具回合。

**底层实现**：关闭／释放 `InputOwnershipLock`，写入 turn boundary，通知 Runtime 当前动作序列结束。它不观察 UI、不点击、不产生新的 state。

**为什么不和 Pi 工具合并**：这是 MP 的回合协议，不是跨平台 UI 能力；必须保留为独立的生命周期信号。

## 重复能力的最终归属

| 旧工具 | 最终规范入口 | 处理方式 |
|---|---|---|
| Kimi `ListApps` | `list_apps` + `find_roots` | 目录与 root 查询拆开，共享窗口枚举器 |
| Kimi `Launch` | `launch_app` | 保留，启动不是观察 |
| Kimi `Focus` | `activate_window` | 保留，焦点／surface binding 是生命周期动作 |
| Kimi `Observe` | `observe_ui` | snapshot_id 兼容，统一 state_id/root/@e |
| Kimi `Click` | `click` / `act_ui` step | 单步兼容入口，唯一 executor |
| Kimi `Type` | `type_text` / `act_ui` step | 与 set_value 分开表达输入语义 |
| Kimi `Key` | `press_key` / `act_ui` step | 唯一 key executor |
| Kimi `Scroll` | `scroll` / `act_ui` step | 唯一 scroll executor |
| Kimi `SetValue` | `set_value` / `act_ui` step | 唯一 ValuePattern/readback executor |
| Kimi `Act` | `act_ui` semantic step | 不再有第二套二级动作路由 |
| Kimi `Select` | `act_ui` selection step | SelectionItem 优先 |
| Kimi `Drag` | `act_ui` drag step | geometry + lease 约束 |
| Kimi `turn_ended` | `end_turn` | 回合协议独立保留 |
| Pi `find_roots` | `find_roots` | 与 list_apps 共用资源枚举 |
| Pi `observe_ui` | `observe_ui` | 与 Observe 合并 |
| Pi `search_ui` | `search_ui` | 无 Kimi 等价物，保留 |
| Pi `expand_ui` | `expand_ui` | 无 Kimi 等价物，保留 |
| Pi `inspect_ui` | `inspect_ui` | 无 Kimi 等价物，保留 |
| Pi `read_text` | `read_text` | 无 Kimi 等价物，保留 |
| Pi `wait_for` | `wait_for` | 与 MP 既有 WaitTool 合并 |
| Pi `act_ui` | `act_ui` | 与 Act/Select/Drag 和基础动作合并 |

## 还不能声称已经完成的部分

这份合并设计描述的是工具契约和 MP 当前实现路径，不把尚未验收的能力写成既成事实：

- 当前 UIA outline 仍是有界扁平投影，不是 Pi native helper 的完整 RuntimeId/AutomationId 树；
- 菜单、弹层作为独立 transient root 的真机枚举尚未完成 Office/微信验收；
- 大部分 `wait_for` 仍是有界 probe polling，UIA event 驱动是优化方向；
- `act_ui` 已有 successor diff，但统一 Receipt schema 的所有字段还需要继续收敛；
- 浏览器 CDP、Windows UIA、未来 macOS/Linux adapter 应共享上述契约，但不能因为工具名相同就假设底层能力已全部等价。

这些限制不影响“重复工具合并”的结论：无论底层平台如何变化，模型看到的都应是同一套 state、ref、capability、lease、postcondition 和 receipt 语义。
