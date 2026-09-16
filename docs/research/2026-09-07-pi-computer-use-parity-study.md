# pi-computer-use 对照研读与 Magic Pointer 接线记录

日期：2026-09-07  
上游：[`injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use)  
本地副本：`external/pi-computer-use`  
读取版本：`4b8dbd7`（`main`，package `0.5.1`，MIT）

## 结论

Pi CU 的真正优势不是“能截图点击”，而是把桌面控制收敛成一个有状态、可渐进披露、可验证的工具协议：`find_roots → observe_ui(stateId) → search/expand/inspect/read → act_ui → successor state/diff`。状态属于物理资源，动作带旧状态并发检测；原生 UIA/AX/AT-SPI 先行，像素坐标只作为当前观察的受限后备；动作可批处理但仍在同一资源 lane 内串行，完成条件由 postcondition 验证，而不是由“事件已发送”推断成功。

Magic Pointer 原来已经有更严格的 FrameLease、Target/ActionLease、Effect/Receipt、UIA 原生 pattern、写后读回和长任务 Runtime，但桌面模型工具面仍停在 Kimi 风格的 `Observe + snapshot_id + 13 个动作`。这会让模型多耗轮次，也没有 Pi 的 root/element ref、精确搜索、局部展开、状态 successor diff 和条件等待。

本批已在 MP 自有 `DesktopActionSession` 上补齐一层兼容能力，不引入 Pi 运行时，也不把执行权外包给 Pi：

- `find_roots`：稳定 `@rN` 根引用，返回窗口身份和几何，不激活窗口。
- `observe_ui`：基于同一已有 snapshot 建立 `state_id`、`root_ref` 和 `@eN` outline。
- `search_ui`：在缓存 state 内按 exact/prefix/substring、role、patterns 搜索，不重复抓屏。
- `expand_ui` / `inspect_ui` / `read_text`：局部上下文、字段/证据和文本读取。
- `wait_for`：有界 UIA 重读等待 present/absent 条件，超时诚实返回。
- `act_ui`：同一 `state_id` 上 1–20 步事务，复用既有 snapshot stale 检查和输入锁，返回 successor `state_id`、`base_state_id`、确定性 diff 与 verification。

## 能力逐项对账

| Pi CU 能力 | MP 原有状态 | 本批处理 | 仍需补齐 |
|---|---|---|---|
| 多根窗口/菜单/弹层森林 | `list_visible_windows` + 原始窗口列表 | `find_roots` 根引用层 | 菜单/弹层作为独立 root 的真机枚举与 rootDelta |
| 不可变 state + resource epoch | `snapshot_id`、窗口/元素 stale 校验 | state-scoped 查询与 successor state | 跨 session 的有界 durable state store/epoch 账本 |
| 渐进式 outline | 100 节点压缩元素列表 | search/expand/inspect 读取同一缓存 | 真正的父子树与 scoped re-observe（当前 UIA 归一化仍是扁平列表） |
| 原生语义动作 | `UiaBridge` ControlView + Invoke/Value/Text | `act_ui` 复用 `Click/Type/SetValue/Act` | ScrollPattern/Toggle/SelectionItem 的统一公开 capability 名 |
| 动作后验证 | 写入读回、Receipt、写后 Observe | `expect` → `wait_for` + successor diff | 将 verification 状态直接映射到统一 Receipt schema |
| 多步动作事务 | 输入锁，单动作工具 | `act_ui` 1–20 步同资源串行 | 每步 partial boundary/失败位置的 GUI 投影 |
| stale 防重放 | 窗口身份 + 元素 role/name/rect 重读 | ref→index 映射复用旧检查 | RuntimeId/AutomationId 优先重定位而非 index |
| 有界输出/continuation | ToolRegistry 64K 结果门 | 新结果受同一工具结果边界 | `@o` UTF-8 continuation ref |
| browser page 统一 root | BrowserDevToolsAdapter 已有 exact target/epoch | 未在本批重复造浏览器工具 | managed CDP browser launch / evaluate 的独立工具面 |
| 等待而非盲轮询 | 既有 `WaitTool` | `wait_for` 精确条件补齐 | WinEvent/UIA event 驱动，减少 polling |
| 多平台 | MP 当前生产重点 Windows | 不复制 Pi 的 Rust/Swift helper | macOS/Linux 原生 parity 需另过 Reuse Gate |

## 关键实现判断

1. **不复制 Pi 源码。** Pi 仓库 MIT，但其 native helper、平台权限和协议是另一套产品内核；MP 已有自己的 FrameLease、SurfaceGrant、ActionBroker、Receipt 和 SurfaceAdapter。这里吸收的是工具契约和失败语义，不复制实现。
2. **不把 `state_id` 当安全凭据。** 它只是模型可见的观察代际；真正执行仍经过 MP 的 stale snapshot、ActionLease/guard、Effect 授权、输入所有权和读回验证。
3. **坐标不升级为第一选择。** Pi 的 `pictureOnly`/coordinate fallback 仍受当前 observation 约束；MP 继续遵守 UIA/DOM/COM 原生优先和 FrameLease 历史事实不可重拍。
4. **批量动作不绕过状态边界。** `act_ui` 只接受一个 state、最多 20 步、同一资源 lane；跨状态依赖必须拆成下一轮 observe/search。
5. **等待失败不伪装成功。** `wait_for` 返回 `found=false,timed_out=true`；`act_ui.expect` 把条件结果带回，不把“输入已发送”当成完成证明。

## 验证

新增 `tests/pi_computer_use_parity_test.py`，先观察 3 个红灯，再实现后 **3 passed**；与现有桌面/UIA/Wait/插件树聚焦集合合计 **79 passed**。测试覆盖根/状态/元素引用、搜索与读取、同一状态多步动作、successor diff、postcondition wait 和超时边界。生产仍未宣称真实 Office/微信菜单弹层的 Pi parity 已真机验收；这些列为下一批真机证据。

## 上游自测记录

已阅读 README、usage、architecture、configuration、troubleshooting、Windows bridge、Linux support，以及 extension、bridge、runtime/state、actions、outline、Windows backend/native protocol。仓库在本机执行 `typecheck` 时暴露两个环境/上游问题：peer dependency `typebox` 未由 `npm ci --ignore-scripts` 安装，且 Windows 下 `test:schema` 脚本把绝对路径重复拼成 `D:\\D:\\...`；`test:output` 已通过。该结果只作为上游副本的诚实记录，不改写 Pi 源码。
