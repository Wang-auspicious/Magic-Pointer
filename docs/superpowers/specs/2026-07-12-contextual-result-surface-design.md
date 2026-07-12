# Magic Pointer 上下文结果表面与关闭行为设计

日期：2026-07-12

状态：用户已批准视觉方向，等待书面规格复核

范围：修复 PDF/选区命令结果的呈现、关闭、失败反馈与热键重复触发；不在本规格内实现新的 PDF 读取适配器或 Dashboard 全页。

## 1. 背景与实测根因

用户在 Obsidian 内嵌 PDF 中选中一句话，按 `Ctrl+Alt+M` 并输入“翻译”。当前产品显示“结果已在侧边打开”的 Rail，随后打开接近全屏高度的黑色 Reader，但内容只是“无法从 Obsidian 读取可靠对象”。Rail 没有关闭按钮且不会自动消失，Reader 的关闭入口只有一个语义不明显的 `×`。

日志证明这不是单一视觉问题：

1. 一次热键按压在约 0.7 秒内触发七次 `beginSelectionSession`，前六个 Python 捕获子进程被后一次会话取消，缺少键盘自动重复去抖。
2. 最终冻结的前台窗口是 `Reshet论文 - Persistence - Obsidian 1.12.7`。现有已验证 PDF 适配路径针对 Edge/Chromium 可访问性选区，并不支持 Obsidian 内嵌 PDF；系统没有在捕获失败时终止任务，而是继续允许输入命令。
3. Rail 通过 `showInactive()` 展示以保护宿主焦点，因此它收不到键盘 `Escape`；把 Escape 作为 Rail 的主要关闭方式在结构上不可用。
4. 长答案判断只依据答案长度或换行。即使答案是“没有可靠对象”的失败说明，也会被送入 Secondary Reader；Reader 显示后 Rail 只更新文字，不自动退场。

## 2. 已批准的产品决策

### 2.1 默认结果形态

默认使用方案 A：Google 演示 7 风格的就地上下文结果。翻译、解释、总结以及普通改写预览在原选区附近出现，视觉上是轻量、内容驱动的浮层，不是固定屏幕边缘的侧栏，也不形成聊天窗口。

未来 Dashboard 提供 A/B 偏好：

- A：就地上下文结果，产品默认值。
- B：边缘阅读模式，供明确偏好固定侧边阅读的用户选择。

不把 C 作为第三种用户模式。旧的巨大固定 Reader 不再是普通命令默认结果。

### 2.2 长内容和高风险操作

当用户选择 A 时，即使结果很长、包含代码或需要高风险写回确认，也不能自动跳转到 B。A 先在选区附近显示摘要、关键 diff 或操作名称，并提供明确的“展开”或“查看并确认”。只有用户主动点击，才打开 B。用户选择 B 作为 Dashboard 偏好后，结果才可以直接进入边缘阅读模式。

### 2.3 关闭原则

- Reader/结果出现后，命令输入 Rail 在 400ms 内自动隐藏，不留下“结果已在侧边打开”之类的僵尸提示。
- 再按一次 `Ctrl+Alt+M` 永远关闭 Magic Pointer 当前所有临时表面，并使当前 SelectionSession 失效。
- A 模式点击外部、重新选择、移动到明显远离结果的位置或执行完成后关闭；悬停在结果表面内不会误关。
- A 模式显示可理解的“关闭”入口，不只使用孤立的 `×`。
- B 模式提供“关闭”和“固定”。未固定时，用户与 Reader 交互后再点击外部会关闭；固定后只由“关闭”、再次热键或新任务关闭。
- `Escape` 只作为窗口获得焦点后的辅助关闭方式，不能作为唯一或主要关闭方式，也不注册会劫持宿主应用的全局 Escape。

## 3. 状态机

结果表面只有以下状态：

```text
idle
  -> capturing
  -> command-ready
  -> running
  -> inline-result | expandable-result | inline-error
  -> expanded-reader（仅用户主动展开，或 Dashboard 偏好为 B）
  -> dismissed
```

关键转换：

- `capturing` 在 600ms 热键去抖窗口内忽略重复 key repeat，不创建新 SelectionSession。
- 捕获结果为 unsupported/error/empty 时，从 `capturing` 直接进入 `inline-error`，不得进入可输入命令状态。
- `inline-error` 显示具体宿主和原因，例如“Obsidian PDF 暂不支持读取选中文字”，1.5—2 秒后自动关闭。
- `running` 完成后，Rail DOM 不复用为结果卡；创建 A result surface 后立即开始 Rail 退场。
- 普通短结果进入 `inline-result`；长结果或写入动作进入 `expandable-result`，只有点击“展开/查看并确认”才进入 `expanded-reader`。
- 任何状态收到第二次热键、新 SelectionSession、显式关闭或 session 过期，均进入 `dismissed`，清空 proposal token 和当前临时 UI。

## 4. 视觉规格

### 4.1 A：默认就地结果

- 锚定当前冻结选区，不锚定提交命令后移动的鼠标。
- 宽度以内容为准，建议 280—440 DIP；高度以内容为准，普通翻译不超过约 180 DIP。
- 圆角 16—18 DIP，深色半透明材质，边框和阴影仅用于与宿主内容分层，不使用大面积纯黑空白。
- 顶部只显示意图和必要来源，例如“翻译 · PDF 当前选区”；不显示“处理结果”这类无信息标题。
- 正文是第一视觉层级；操作区只出现当前可执行动作，例如“复制译文”“展开”“关闭”。
- 无结果时不保留空白正文区。

### 4.2 B：可选边缘阅读模式

- 宽度约 360—420 DIP，高度由内容决定，最大不超过工作区高度的 72%；不得默认铺满整屏高度。
- 顶部显示真实任务名称和来源，提供文字“关闭”与“固定”。
- 内容滚动区与底部操作区分离；高风险确认按钮固定可见。
- 普通失败不打开 B。

### 4.3 动效

- Rail 到 A：结果卡从选区方向以 120—180ms 淡入/轻微缩放，Rail 在最多 400ms 内淡出。
- A 关闭：100—140ms 淡出，不做长距离飞行动画。
- 展开到 B：保持来源连续性，可用 180—240ms 的尺寸与位置过渡；遵守 `prefers-reduced-motion`。

## 5. 捕获与错误边界

- 捕获桥返回 `unsupported`、`error` 或没有可靠内容时，Panel 只能展示不可提交的错误 Rail，不呈现输入框和建议命令。
- 错误文案必须说明实际冻结到的应用，避免用户以为选中了 PDF，而系统却静默读取另一个窗口。
- 当前 Obsidian 内嵌 PDF 明确标记为未支持；本规格不通过截图 OCR 猜测选区，也不把屏幕内容擅自交给模型。
- Edge PDF、浏览器网页、Word/WPS 等已有适配器继续使用原生选区与 session 身份校验。
- 后续 Obsidian PDF 支持必须作为独立适配器工作，具有可访问性选区读取、来源窗口验证和真实 fixture，不与本次 UX 修复混合。

## 6. 组件边界

- `main.js`：拥有热键去抖、表面生命周期、窗口显示/隐藏与 session 失效，不判断视觉内容高度。
- Panel renderer：只负责命令输入和 running 状态；收到完成结果后请求创建 result surface，随后退场。
- Result surface renderer：实现 A 的短结果、错误、可展开摘要与动作；不承载命令输入。
- Reader renderer：实现 B，只有用户主动展开或偏好为 B 才显示。
- Selection snapshot bridge：提供可靠的 `state/app/error/hasContent`；unsupported/error 不能被上层改写为可提交状态。
- 未来 Dashboard：持久化 `resultSurfaceMode = inline | reader`，缺省为 `inline`。本次先提供配置模型与默认值，不要求完成 Dashboard 页面。

## 7. 测试与验收

### 自动测试

- 连续七次热键回调在 600ms 内只创建一次 SelectionSession；600ms 后的新按压可正常切换关闭或重新打开。
- unsupported/error/empty snapshot 不显示命令输入，不调用 `selection_bridge.py`，不打开 Reader。
- A 结果出现后 Rail 自动隐藏；不会同时存在 Rail 与结果提示。
- 默认偏好为 A；偏好 B 时直接进入 Reader；A 的长内容只有用户点击展开后进入 Reader。
- 再次热键关闭 Panel、A result、Reader，并使当前 proposal/session 无效。
- A/B 的关闭按钮、键盘焦点和 reduced-motion 静态契约存在。

### 真实桌面验收

1. Edge PDF 选中文字并翻译：只创建一次捕获；A 在选区旁显示真实译文；Rail 自动消失；点击外部关闭。
2. Obsidian 内嵌 PDF 选中文字：显示“Obsidian PDF 暂不支持读取选中文字”，不显示输入框，不打开大 Reader，约 1.8 秒自动关闭。
3. Word/WPS 改写：A 显示简短 diff 摘要；点击“查看并确认”后才进入 B；未确认不写入。
4. 任意临时表面显示时再次按 `Ctrl+Alt+M`：全部关闭，没有残留窗口。
5. 多显示器与高 DPI：A 不越出工作区、不遮挡主要选区；B 不铺满整个屏幕。

## 8. 非目标

- 本规格不实现完整 Dashboard，只定义默认偏好和未来设置键。
- 本规格不实现 Obsidian 内嵌 PDF 读取能力。
- 本规格不重做模型翻译质量；只有读取到可靠选区后才允许评价模型输出。
- 本规格不引入全局聊天历史、永久侧栏或全局 Escape 劫持。
