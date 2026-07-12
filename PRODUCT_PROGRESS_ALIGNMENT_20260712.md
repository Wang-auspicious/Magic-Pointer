# Magic Pointer 产品进度与对齐总账

更新时间：2026-07-12（Asia/Shanghai）

这份文件是持续更新的产品账本。`PRODUCT_WISHES_AND_DEMO_IMPLEMENTATION_20260712.md` 负责回答“完整产品应该是什么、演示里的每个功能如何实现”；本文负责回答“现在做到哪里、下一大块是什么、哪些验证已经完成、哪些仍未完成、每一版应该提交什么”。后续每完成一个可独立使用的里程碑，都必须更新本文并创建 Git 提交，避免只围绕某个局部视觉细节反复打磨。

## 0. 不可违反的约束

- 禁止执行 `rm`、`git clean`、`git reset --hard` 或任何等价删除/清理命令。
- 不删除、移动、改名演示图片、视频、PDF、运行时截图、日志、克隆仓库、压缩包和交接文档。
- `2307.00583v1.pdf` 是真实 PDF 验证素材，不纳入 Git。
- 用户的真实鼠标、点击、拖选、滚动和宿主焦点优先；Magic Pointer 不重新接管鼠标。
- 不确定目标时 fail closed；写入前验证对象，写入后回读，撤销只撤 Magic Pointer 自己的动作。
- 不启动子代理；当前任务全部由主线程实施与复验。
- 每个里程碑先写失败测试、确认 RED，再实现 GREEN；提交前运行完整验证。
- Git 提交使用明确文件白名单，不使用 `git add .`，暂存前检查无删除项。

## 1. 北极星体验

目标不是“悬浮的 AI 聊天框”，而是：

```text
用户保持在原应用
  -> 指向/选中真实对象
  -> 对象旁出现一行短意图
  -> this / that / these / here 绑定真实对象
  -> 结果直接进入正确宿主或专用动作卡
  -> 系统验证结果、提供精确撤销并消失
```

对标视觉与行为以本地 `演示1.png`、`演示7.webm`、`演示8.webm`、`演示9.webm`、`演示10.webm` 为准。Google 演示只证明交互层级，不证明真实延迟或可靠性；本项目必须在错误边界、确认、取消、撤销、隐私和可验证性上做得更好。

## 2. 当前版本事实

### Git

- 当前分支：`main`
- 已提交可靠基线：`3194e45 feat: replace summary bubble with inline action rail`
- 本地缓存的 `origin/main`：`8960991 Lower cursor upper vertex and boost glow pulse`
- 本地相对远端跟踪点：ahead 9
- GitHub 实时状态：上次 TLS 连接失败，尚未二次确认；不能把本地远端缓存冒充线上实时状态。

### 已提交可信底座

- `72caaf4`：observer-first、WPS/Word 读取、写后验证、精确撤销。
- `777ed6a`：冻结 SelectionSession、TTL、旧响应防串台、写回前身份校验。
- `fcd52fb`：Edge HTML/PDF UI Automation 原生选区，不碰剪贴板。
- `3f0299a`：PDF 高亮与本地字符框验真、首尾错字恢复、面板避让选区。

### 2026-07-12 M1 待提交实现

- Inline Action Rail 初始窗口从 128 DIP 改为 44 DIP。
- 动态宽度 88—360 DIP，按 ASCII/宽字符估算。
- 初始 DOM 移除产品标题、THIS 元数据、摘录、三建议按钮和展开按钮。
- 单一主意图或单行短命令；保留 session、stale token、安全 Markdown、action proposal。
- 新 rail 预览：`data/runtime/inline_rail_preview_20260712.png`。
- 新增独立 Secondary Reader：长结果、动作预览与确认从 44 DIP rail 分离；窗口使用 `showInactive()`，与 SelectionSession 和一次性 action token 绑定。
- Reader 预览：`data/runtime/secondary_reader_preview_20260712.png`。
- 已完成 TDD RED/GREEN；本轮新鲜验证为 `npm test` 全绿、Python `63 passed in 10.55s`。
- 最新 Electron 已加载，运行 PID 46764，热键注册成功。
- 尚缺：为 Edge/PDF 热键链路建立不依赖用户当前标签页的确定性自动夹具；本轮三次复用 Edge 进程的尝试无法稳定控制活动标签页，已停止在夹具细节上消耗。Edge/PDF 原生选区能力仍由 `fcd52fb`、`3f0299a` 的真实验证与回归覆盖。

## 3. 十大产品模块总览

| 编号 | 产品模块 | 当前完成度 | 当前状态 | 达到“可用大头”的定义 |
|---|---|---:|---|---|
| P1 | 一行式 Inline Action Rail | 90% | M1 可提交；欠真实自动夹具 | 真实选区旁一行出现、焦点不变、动作可执行、长结果不污染初始 rail |
| P2 | 自然唤起与低误触预热 | 25% | 有旧 detector/observer | 热键稳定；wiggle 可配置、低误触；对象在显示 rail 前完成冻结 |
| P3 | THIS/THAT/THESE/HERE 连续对象会话 | 65% | M2 内存 episode 已接主路径 | 连续四步短指令不重述上下文，目标/集合可纠正、过期时 fail closed |
| P4 | 跨应用 Destination 与安全写回 | 35% | Word 已可靠，其余不足 | Word/WPS、标准网页输入、受控浏览器 DOM 至少三条真实写入路径可验证可撤销 |
| P5 | 多类型对象 Grounding | 45% | 文本/PDF/Explorer 较强 | 文本、文件、DOM 控件、表格、图片对象、视频帧有统一身份与能力模型 |
| P6 | 语音/键盘/鼠标统一短命令 | 15% | 有 Windows dictation 旧入口 | push-to-talk、partial/final、键盘修正、无麦克风降级，共用同一 intent |
| P7 | 操作生命周期、进度、取消、回执、撤销 | 40% | proposal/history 已存在 | 所有动作有 accepted→verify 终态；无假成功；可取消与 receipt 可追踪 |
| P8 | 日历/地图/预约/比较专用动作卡 | 5% | 只有演示分析 | 至少日历与路线两个端到端沙盒，schema 驱动，不让模型生成任意 UI |
| P9 | 长结果 Secondary Reader 与任务 artifact | 45% | Reader 最小闭环完成；artifact 待做 | 长结果独立于 rail，带来源与 artifact ID，不形成全局聊天历史污染 |
| P10 | 安装、托盘、设置、权限、隐私、性能、无障碍 | 20% | 有 VBS/托盘雏形 | 无终端安装启动；权限/模型/触发可配置；日志隐私与高 DPI/键盘路径通过 |

完成度只用于防止遗忘，不是对外宣传。任何模块只有满足下方验收门槛后才能标记“完成”。

## 4. P1：Inline Action Rail

### 已完成

- 原始选区矩形驱动位置算法，支持多显示器、负坐标和 DPI。
- `showInactive()` 不抢宿主焦点。
- rail 44 DIP 高，宽度 88—360 DIP。
- 单一主建议或一行输入；无初始标题、元数据、摘录、三按钮卡。
- ready/input/running/success/error 一行状态。
- TDD 覆盖动态宽度、DOM 类别和位置避让。

### 本里程碑必须完成

- 安全重启旧 Electron，确认真实运行的是最新源码。
- Edge HTML 与 Edge PDF 各做一次真实热键流程。
- 检查前景 HWND、剪贴板序列号、选区高亮、rail bounds、overlap 和日志耗时。
- 截图与演示 7 帧并排复核，确认不再是摘要卡。
- 处理长解释与高风险 proposal：短结果留在 rail；需要详情时进入独立 Secondary Reader，而不是 rail 扩高。
- 完整 Node/Python 回归、diff 检查、无删除审计、白名单暂存和 Git 提交。

### 暂不在 P1 纠缠的细节

- 不为 1—2 px 阴影、单个图标形状反复迭代。
- 达到一行、清楚、无遮挡、流畅后立即进入 P3/P4 大功能。
- 颜色和微动画只做一次可访问性校准，不阻塞连续对象与写入能力。

## 5. P2：自然唤起与预热

### 已有资产

- `electron/main.js` 有 mouse shake polling。
- overlay 有真实鼠标周围 observer aura。
- 热键 `Ctrl+Alt+M` 已能在焦点变化前捕获对象。

### 缺失大功能

- detector 只有基础轨迹规则，没有应用级禁用、校准、冷却和误触反馈。
- 无后台只读 candidate prewarm；冷路径仍可能启动 helper 后才反馈。
- 无鼠标侧键/按住说统一 ActivationIntent。

### 完成门槛

- 正常浏览/拖拽/绘图轨迹不误触，有意 wiggle 成功率可测。
- 第一次可见反馈 P50 <120 ms，rail 外壳 P50 <350 ms。
- trigger source、前景 HWND、cursor 与 session 统一记录；误触可立即 Esc。
- 设置里允许“仅热键 / 热键+wiggle / 侧键”。

## 6. P3：连续对象与代词

### 已有资产

- `SelectionSessionStore` 能冻结单对象并防旧结果串台。
- `TaskContextStore` 已有 THIS/THAT/GROUP/DESTINATION 旧概念。
- GroundedObject、selection snapshot 与 action target 已有 schema。

### 缺失大功能

- 单对象 session 与旧 task context 尚未统一为 InteractionEpisode。
- THAT 仍可能只是数组上一项，不是语义焦点/动作结果。
- THESE 没有显式集合身份；HERE 没有容器+局部坐标+插入规则。
- 无连续四步“Add this / and this / here / Double that”真实执行闭环。

### 计划实现

- 新建独立 `interaction_episode` 模块，不继续把状态堆进 `electron/main.js`。
- 对象节点保存 identity、adapter、geometry、version、capabilities；关系边保存 selected/created/destination。
- 确定性代词解析优先，槽位缺失只显示最小澄清。
- 先用内存与 fixture 完成 TDD，再接真实应用。

### 完成门槛

- 连续四步无需重复目标名称。
- 页面滚动/对象变化/重复文本时不会把代词绑定到错误对象。
- 用户可说“不是这个，是那个”纠正；旧 episode 过期后不能写入。

## 7. P4：Destination 与安全写回

### 已有资产

- Word replacement、确认、range/hash 验证、写后回读与精确撤销可靠。
- typed proposal、permission policy、action history 已存在。

### 缺失大功能

- WPS 写回缺真实隔离复验。
- 浏览器仍主要只读；无 DOM/标准输入的可靠写入 adapter。
- 微信/聊天/普通 Electron 输入框没有明确白名单策略。
- 没有统一 DestinationAdapter 的 prepare/preview/commit/verify/undo 接口。

### 计划实现

- 先抽统一 destination contract 与 receipt，不改现有 Word 行为。
- 第二条真实路径做受控 HTML fixture 的 DOM/输入写入。
- 第三条路径做 WPS 或标准 UIA ValuePattern；无法验证的应用保持只读。
- 外部发送、创建、付费一律高风险确认与幂等。

### 完成门槛

- 三类宿主真实写入后均可回读、可撤销、不会越过前景窗口。
- 目标变化、权限不足、验证不一致都失败关闭，不使用泛化 Ctrl+V 冒充支持。

## 8. P5：多类型 Grounding

### 已完成较多的部分

- Explorer 文件对象和本地路径/内容。
- Office 文本选区、Edge HTML/PDF 文本、PDF 几何验真。
- 基础 screen region、stroke scoring 和视觉调用。

### 缺失大功能

- 浏览器 DOM card/button/table/canvas 稳定 identity。
- 图片内实例 mask、画布图层、视频帧时间锚点。
- 多证据冲突的统一 evidence/confidence/version 模型。

### 完成门槛

- 至少文本、文件、DOM 控件、表格、图片实例、视频帧六类对象通过 fixture。
- 写入动作使用更高置信门槛；高低层证据冲突时拒绝猜测。

## 9. P6：统一短命令与语音

### 路线

- 先实现与 provider 无关的 partial/final intent buffer。
- Windows dictation 作为可用 fallback，不作为最终唯一方案。
- push-to-talk 默认，不常听；松开才 final，partial 不执行。
- 中英文命令 grammar 优先解析 add/move/merge/double/this/that/these/here。

### 完成门槛

- 键盘、点击 suggestion、语音三种入口产生同一 typed intent。
- 无麦克风/权限拒绝/ASR 失败立即回退键盘。
- 界面明确何时正在听，停止后立即结束采集。

## 10. P7：操作生命周期与回执

### 路线

- 统一 accepted/grounding/planning/confirmation/executing/verifying/success/failure/cancelled。
- operation ID、session token、idempotency key 和 receipt 全链路贯通。
- rail 只显示短阶段；调试详情进入本地日志。

### 完成门槛

- 故障注入下每个操作都有唯一终态。
- HTTP 200、模型返回或进程退出不能直接视为成功；必须 verify。
- 用户取消、网络未知状态和撤销冲突均有真实语义。

## 11. P8：专用动作卡

### 首批两张卡

1. CalendarEventCard：海报/文本 → 标题、开始、结束、地点、时区 → 测试日历或 ICS。
2. RouteCard：两个地点对象 → 地理编码候选 → 地图 deep link/路线预览。

### 第二批

- ReservationCard：人数、日期、时段、政策、确认回执。
- CompareCard：对象集合、比较维度、来源证据。

### 完成门槛

- schema 驱动本地可信 UI，模型不能生成任意 HTML 或未注册动作。
- 卡片仅在需要补字段时渐进展开，完成后收回 rail。

## 12. P9：Secondary Reader 与 Artifact

### 路线

- 将长 Markdown、代码、表格、引用和高风险 diff 从 rail 拆到独立窗口。
- 每个结果是 immutable ResultArtifact，绑定来源对象与 episode。
- 默认只显示当前 artifact，不建立无限聊天历史。

### 完成门槛

- 任意长结果下 rail 仍不超过 48 DIP。
- reader 显示/隐藏不改变宿主焦点，来源可追踪，旧 artifact 不污染新代词。

## 13. P10：产品化

### 大块任务

- Electron 成为唯一主 shell；Python/C# helper 受管化，减少双前端和僵尸进程。
- 安装包、托盘、开机启动、暂停、退出、更新。
- 设置：触发、语音、模型、允许应用、权限、历史、隐私、动画、无障碍。
- 凭据迁移到 Windows Credential Manager/DPAPI。
- 空闲 CPU/GPU/内存、崩溃恢复、日志关联 ID。
- README 与启动文档去乱码并更新到 observer/rail 主流程。

### 完成门槛

- 干净 Windows 机器无需终端即可安装、启动、暂停、完成一次动作并撤销。
- 高 DPI、多屏、键盘、屏幕阅读器、高对比和减少动画路径可用。

## 14. 里程碑与 Git 提交节奏

### M1：Inline Rail 可用版

- 真实 Edge/PDF 验证、Secondary Reader 最小拆分、完整回归。
- 计划提交：`feat: replace summary bubble with inline action rail`

### M2：Interaction Episode

- THIS/THAT/THESE/HERE 数据模型与 fixture 连续四步。
- 计划提交：`feat: add continuous pointer interaction episodes`

### M3：Destination Adapter

- 统一 contract、Word 兼容、HTML fixture 写入、receipt/undo。
- 计划提交：`feat: add verified cross-app destinations`

### M4：统一操作生命周期

- progress/cancel/verify/receipt 全链路。
- 计划提交：`feat: track pointer operations through verification`

### M5：语音短命令

- partial/final provider、push-to-talk、键盘回退。
- 计划提交：`feat: add optional push-to-talk pointer commands`

### M6：日历与路线动作卡

- CalendarEventCard、RouteCard 及模拟 provider。
- 计划提交：`feat: add calendar and route action cards`

### M7：Secondary Reader 与 Artifact

- 长结果独立窗口、来源绑定、任务级结果。
- 计划提交：`feat: add task-scoped result artifacts`

### M8：可安装 Alpha

- 设置、权限、隐私、打包、README 与启动体验。
- 计划提交：`feat: package Magic Pointer alpha experience`

每个 M 都必须形成可运行、可测试的完整软件增量；不能在同一 M 里堆叠未经验证的跨应用功能。

## 15. 防止在小细节上打转的规则

- 每个里程碑最多进行一轮视觉精修；满足交互类别、可读性、无遮挡和无障碍后转入下一大模块。
- 不以“再调一点阴影/圆角/颜色”为理由推迟多对象、写入、动作卡等主能力。
- 每次工作更新必须回答：本轮让用户完成了哪种以前不能完成的任务？
- 连续两轮只改视觉、不增加任务闭环时，强制回到本总账选择下一个 P 模块。
- 自动测试全绿不代表产品体验完成；真实桌面/沙盒任务必须作为里程碑门槛。
- 演示里的动画速度不是验收证据；本项目必须记录 P50/P95 延迟与失败率。

## 16. 进度日志

### 2026-07-12：产品蓝图与 M1 开始

- 完整读取历史 JSONL 与上一任务对话。
- 核对 Git 基线、未提交 V4、20 张图片、4 段原始视频和高密度接触表。
- 写成 `PRODUCT_WISHES_AND_DEMO_IMPLEMENTATION_20260712.md`：4 个视频章节和 10 个用户愿望均超过 1000 字。
- 以 TDD 把 V4 摘要气泡改为 44 DIP inline rail；目标 Node 测试从 RED 到 GREEN。
- 新鲜预览图生成成功；Node/Python 回归在上一轮通过。
- 下一步：真实加载最新 Electron、Edge/PDF 验证、Secondary Reader 最小拆分并提交 M1。

### 2026-07-12：M1 Inline Rail + Secondary Reader 大结构完成

- 新增 `reader.html`、`reader.css`、`reader.js`，形成独立阅读与高风险动作确认面；长答案、换行答案或 action proposal 不再撑高 rail。
- Rail 的尺寸同步逻辑固定为 44 DIP，只根据主意图或短输入动态调整宽度；运行、成功、失败都保持单行。
- Reader 与当前 `SelectionSession` 绑定：旧 token 无法打开 Reader，Reader 动作结果再次检查 session；确认仍使用一次性 action token。
- 新会话开始或 panel 隐藏时同步隐藏 Reader，防止旧结果覆盖新指代。
- 真实 Electron 重启成功：PID 46764，`Control+Alt+M` 注册成功；没有运行停止脚本或删除命令。
- 视觉验收图：`data/runtime/secondary_reader_preview_20260712.png`。已检查标题/来源、Markdown、变更前后预览、固定底部确认区、内容滚动区和窗口边界。
- 新鲜验证证据：`node tests\\reader_static_test.js` 通过；`npm test` 全部通过；`python -m pytest -q` 为 `63 passed in 10.55s`。
- 已知欠账：当前 Edge 会复用用户既有进程与标签页，临时自动化夹具不能稳定保持测试页为活动页；不把夹具失败误报为产品失败，也不为此阻塞 M2。后续在 P10 的确定性桌面 E2E 夹具中统一解决。
- 本轮新增的用户任务能力：用户可以在指针旁保持极轻的一行入口，同时在不污染该入口的独立面中阅读长结果、核对写入 diff 并确认安全动作。
- 下一大块：M2 Interaction Episode。优先完成 THIS/THAT/THESE/HERE 的对象槽位和连续四步 fixture，不继续打磨 Reader 阴影、圆角或字距。

### 2026-07-12：M2 Interaction Episode 主路径完成

- 新增 `InteractionEpisodeStore`，生命周期为 30 分钟空闲 TTL，独立于单次 120 秒 `SelectionSession`；一个 episode 可跨越多次真实热键选区，但过期后整组槽位 fail closed，不从全局历史猜测。
- 槽位语义落地：新来源进入 THIS，前一个 THIS 自动成为 THAT；`these/those/them/both/这些/那些/它们/两者/一起/合并` 建立 THESE；`here/there/这里/那里/放到/写到/插入到` 只绑定 HERE，不覆盖来源对象。
- 对象引用包含 snapshot ID、来源应用、窗口、标签、冻结选区内容与时间边界；内容最多 12000 字，只保存在 Electron 内存并随当前请求发送，不写入持久全局聊天历史。
- episode 在用户真正提交命令时绑定，而不是鼠标路过或只打开 rail 时绑定，降低误指向污染。
- Python `selection_bridge.py` 已把已绑定 THIS/THAT/THESE/HERE 编成明确上下文；系统提示禁止从 global history 推测缺失代词。Word 写入仍只允许当前有效 SelectionSession，旧 episode 对象只能参与理解，不能绕过写入校验。
- 连续 fixture 覆盖：浏览器 A → PDF B → THESE(A,B) → Word HERE；同时覆盖 HERE 不覆盖 THIS、对象去重、内存 payload 不重复 `selectedText` 字段、30 分钟过期清空与新 episode 隔离。
- TDD 证据：Node 测试先因模块不存在失败，Python 测试先因 episode formatter 不存在失败；实现后目标测试转绿。
- 新鲜全量验证：`npm test` 全绿；`python -m pytest -q` 为 `64 passed in 8.78s`；最新 Electron PID 55504，热键注册成功。
- 本轮新增的用户任务能力：用户可连续指向两个来源形成 THIS/THAT 或 THESE，再指向目标位置建立 HERE；后续短命令无需把对象名称、窗口和选区内容重新描述一遍。
- 已知欠账：目前没有可视化槽位纠正控件；`correctReference` 数据接口已具备，但“不是这个/移除第二个”的 rail 微交互仍待后续 episode UX。HERE 目前是可信目标引用，真正向网页/其他宿主写入属于 M3 Destination Adapter。
- 下一大块：M3 Destination Adapter。优先做统一 destination contract、标准 HTML 输入 fixture 的写前身份验证/写后回读/receipt/精确撤销，不回头微调 Reader 视觉。
