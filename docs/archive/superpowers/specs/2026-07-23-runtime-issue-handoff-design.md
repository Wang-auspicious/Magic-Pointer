# Magic Pointer Runtime Issue Handoff 设计

日期：2026-07-23  
状态：用户已确认，直接实施

## 1. 被否定的旧价值

上一版把“选中代码或文件 → 组织 Context Pack → 交给 Coding Agent”作为主要体验。这要求用户先知道问题属于哪些文件，并替 Agent 做仓库检索。现代 Coding Agent 已经能从一个清楚任务中自行搜索仓库、阅读实现和运行测试，因此这条链路只是在重新包装 Agent 已有能力。

原生文本选区和通用 Context Pack 继续作为底层兼容能力，但不再定义 Coding 场景的首页、快捷键或试用流程。

## 2. 新的产品承诺

> 用户只负责指出运行中的真实问题和期望效果；Magic Pointer 负责把 Agent 看不到的运行现场编译成任务；Coding Agent 自己负责定位源码。

Runtime Issue Handoff 处理 Coding Agent 缺失、而用户天然拥有的信息：

- 登录态或本机运行应用中的真实界面；
- 鼠标圈出的具体对象和空间关系；
- 当前窗口、应用、URL、视口和显示器信息；
- “这个”和可选“参考这个”之间的关系；
- 用户通过键盘或系统听写给出的期望；
- 原始截图、指针标注图、UIA/应用上下文和视觉观察；
- 无法确认的来源或视觉字段。

## 3. 一条完整用户流程

### 3.1 捕获问题

用户在运行中的界面看到问题，按 `Ctrl+Alt+M`。Magic Pointer 打开可交互透明 Overlay，用户直接圈住问题对象，输入或听写一句自然语言，例如：

> 这个保存按钮太靠下，应该和右边卡片顶部对齐。

不需要说“收集”，不需要提供源码文件，不需要提前知道组件名。

提交后系统自动创建一个 `runtime_issue` session。第一条视觉证据角色为 `issue`，用户原话同时成为该 session 的最终任务。即使视觉模型不可用，截图、指针轨迹、窗口和几何信息仍然落盘。

### 3.2 补充参考

如果用户还有设计稿、Figma、竞品网页或另一个正确状态，可以切换过去再次按 `Ctrl+Alt+M`，圈出参考并说：

> 参考这个卡片的间距和按钮位置。

当存在尚未交付的 `runtime_issue` 时，后续视觉捕获角色默认为 `reference`，加入同一任务。正常单对象问题不要求这一步。

### 3.3 交给 Agent

用户把鼠标放进 Codex、Claude、Gemini、Pi 或其他 Agent 的空输入框，按 `Ctrl+Alt+Enter`。

Magic Pointer 读取当前目标窗口并显示一条紧凑交付 Rail。点击“填入 Agent”后，它针对目标 Agent 重新编译 Runtime Issue prompt，锁定 HWND、PID、窗口标题、物理像素落点和文本 hash，只填入、不发送。

写入成功后 session 标记为 finished，下一次 `Ctrl+Alt+M` 自动开始新问题。写入失败时 session 保持 active，允许用户换目标重试。

### 3.4 Agent 收到的任务

Prompt 必须明确：

- 这是运行现场，不是用户提供的源码定位；
- 不得要求用户寻找文件或组件；
- Agent 应在当前工作区自行定位负责该界面的源码；
- `issue` 是待修现场，`reference` 是期望参考，二者不能混为事实；
- 优先使用截图、指针标注图、可见文字、URL、窗口和结构化上下文定位；
- 修改后应运行与目标相符的测试、构建或视觉检查；
- 无法复现或无法访问运行环境时明确说明，而不是猜测完成。

## 4. 快捷键与界面

| 快捷键 | 默认行为 |
|---|---|
| `Ctrl+Alt+M` | 打开 Runtime Issue 圈选 Overlay；若已有 active issue，则补充 reference |
| `Ctrl+Alt+Enter` | 在当前指向的 Agent 输入框交付 active issue |
| `Ctrl+Alt+Shift+M` | 保留旧原生选区 Command Rail，作为次级兼容入口 |

Overlay 文案改为“圈出问题，然后说你期望什么”。命令框 placeholder 改为“描述问题或期望，不需要找源码”。提交后的收据只显示：

- 已创建/补充 Runtime Issue；
- 当前证据条数和角色；
- 下一步快捷键；
- 视觉转译是否缺失。

它不再先生成一段聊天式“解释这个对象”的回答。

## 5. 数据模型

Context session 增加：

- `workflow_kind`: `context_pack` 或 `runtime_issue`；
- `task_instruction`: 第一条 runtime issue 的用户原话；
- 每个 visual item 的 `role`: `issue` 或 `reference`。

旧 session 没有 `workflow_kind` 时按 `context_pack` 读取，保持向后兼容。

`record_runtime_visual` 的规则：

1. 没有 active runtime issue 时创建新 session；
2. 若 active session 是旧 `context_pack`，结束旧 session并创建 runtime issue，避免混入旧代码收集内容；
3. 第一条 item 为 `issue` 并锁定最终任务；
4. 后续 item 为 `reference`，不得覆盖第一条最终任务；
5. 重复截图和同一句说明仍按 fingerprint 去重；
6. 每次新增证据后使旧编译结果失效，并重新生成本地 artifact。

## 6. 组件边界

### Context Session Store

负责 workflow、角色、持久化、去重、原子写入、并发 revision 和完成状态。它不生成 prompt。

### Runtime-aware Prompt Compiler

继续复用 `app/context_pack/compiler.py` 的来源字段和长度预算，但根据 `workflow_kind=runtime_issue` 输出专门的任务头、证据角色和 Agent 自主定位要求。

### Visual Bridge

`scripts/electron_bridge.py` 在 `workflow=runtime_issue` 时：

- 接受自然语言而不是显式 Context 命令；
- 捕获截图、指针、窗口和 grounding；
- 视觉模型失败也继续；
- 自动调用 `record_runtime_visual`；
- 编译并落盘最新 prompt；
- 返回简短 receipt，不返回通用聊天答案或旧动作。

### Electron Host

`electron/main.js` 分离三个入口：

- 交互式 Runtime Issue Overlay；
- Runtime Issue delivery session；
- 旧 native selection session。

Overlay 捕获时接收鼠标；观察者模式仍保持 click-through。IPC 继续校验发送 surface。

### Delivery Lifecycle

`scripts/action_bridge.py` 仅在 `paste_text_to_foreground` 成功且 proposal 携带 `workflow_kind=runtime_issue` 时，按精确 `context_session_id` 完成 session。任何失败都不清理证据。

## 7. 安全与失败处理

- Overlay 截图前必须隐藏自身，不能把 Magic Pointer UI 截进现场。
- 空问题描述拒绝创建 issue。
- bbox 太小、窗口身份未知或截图失败时返回明确错误。
- 视觉模型/API Key 缺失不会阻止现场落盘。
- 参考条目不能覆盖最初任务。
- 没有 active runtime issue 时，`Ctrl+Alt+Enter` 只显示“没有待交付现场”，不创建空 prompt。
- 写入仍要求空目标输入框、精确 HWND/PID/标题/落点、物理像素空间、回读成功和 `submit=false`。
- Runtime Issue artifact 使用全局 60,000 字符预算，始终保留所有证据索引。

## 8. 成品验收

自动验收必须覆盖：

- runtime issue 第一条/参考角色与任务锁定；
- 旧 generic session 与 runtime session 隔离；
- runtime prompt 要求 Agent 自行定位源码；
- 视觉模型失败仍生成 artifact；
- 三个快捷键和交互/observer Overlay 模式；
- delivery 成功才 finish、失败保留 active；
- 所有既有 Python 与 Node 回归。

桌面验收使用一个仓库内 demo 页面：

1. 打开有明显错位按钮的运行界面；
2. `Ctrl+Alt+M` 圈出错位并输入期望；
3. 可选再次圈参考；
4. 在测试 Agent 输入框按 `Ctrl+Alt+Enter`；
5. 验证完整 Runtime Issue prompt 被填入且未发送；
6. 确认 prompt 没有要求用户提供源码文件，而是要求 Agent 自行定位。

## 9. 本轮不伪装完成的能力

- 浏览器 CDP 的 console/network/DOM 深度抓取；
- macOS Accessibility 与 ScreenCaptureKit 宿主；
- Agent CLI/RPC 原生连接器；
- 自动启动用户项目和自动操作真实生产系统；
- 自动判定修复后的像素结果已经满足设计意图。

这些是后续增强，不影响 Runtime Issue capture → grounded artifact → safe Agent handoff 的完整 Windows 成品链路。
