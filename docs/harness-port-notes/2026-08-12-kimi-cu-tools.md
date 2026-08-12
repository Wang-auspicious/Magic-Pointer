# 移植笔记：Kimi CU 工具接线（kimiCu.ts + 官方插件包）

> 日期：2026-08-12 · 只读研究，未改任何代码
> 源码：`%TEMP%\opencode\kimi-code\packages\agent-core-v2\src\app\capability\entries\kimiCu.ts`（729 行，存在）
> 插件包：`%TEMP%\opencode\kimi-cu-plugin.zip`（macOS v0.5.4）与 `kimi-cu-win-plugin.zip`（Windows v0.2.14），已解压读全：`kimi.plugin.json` / `skills/kimi-cu/SKILL.md` / `README.md` / `INSTALL.md` / `bin/kimi-cu-mcp(.cmd)`
> 定位：本笔记是 `docs/superpowers/plans/2026-08-12-harness-loop-batch.md` 的 B1.5 产物，供 B2.2 `tool_registry.py` 参考

---

## 0. 诚实声明（先看这个）

1. **13 个工具的实现不在开源仓里。** `kimiCu.ts` 是**安装/检测/接线编排**，不注册任何工具、不含任何工具 schema。全仓 grep `list_apps / usedBackend / turn_ended(工具语义)` 无命中——仓库内 `turn_ended` 命中全部是遥测事件（`loopService.ts:541`、`sessionActivityService.ts:136-139`），与本插件工具无关。工具本体在**闭源运行时**（Windows `kimi-cu.exe`、macOS `KimiCU.app`）内部。
2. **工具清单、启用方式、工作流语义可从官方插件包完整读到**（插件 JSON 的 `enabledTools` 白名单 + SKILL.md 全文），这是本笔记契约部分的事实来源。**逐工具的输入/输出 JSON schema 在闭源二进制里，读不到**——本笔记给出的契约是"文档化语义"级别，不是 schema 级别。
3. 任务书里的 `app/actions/executors.py` 不存在；实际是 `app/actions/executor.py`（SafeActionExecutor）与 `app/fabric/executors.py`（recipe 执行）。对照均基于这两个实际文件。
4. Kimi CU 文档里该字段拼作 **`used_backend`**（win SKILL.md:118），MP 设计文档写 `usedBackend`；语义同源，下文统一写 `used_backend`。

---

## 1. 工具注册方式（13 工具的"注册"真相）

**机制**：工具不是代码注册，而是**插件 JSON 的 `mcpServers[].enabledTools` 白名单** + 薄壳 wrapper 启动闭源 MCP server。

- Windows 插件（`kimi-cu-win-plugin.zip` → `kimi.plugin.json:35-59`）：MCP server `win`，`command: "cmd.exe"`, `args: ["/c", "bin\\kimi-cu-mcp.cmd"]`, `cwd: "./"`，`enabledTools` 白名单恰好 13 个：`list_apps, launch_app, activate_window, get_app_state, click, type_text, press_key, scroll, set_value, perform_secondary_action, select_text, drag, turn_ended`。
- macOS 插件（v0.5.4，`kimi.plugin.json:33-51`）：同构，但只有 **10 个**（无 `launch_app` / `activate_window` / `turn_ended`——后台注入不切前台，不需要这些）。
- Wrapper（`bin/kimi-cu-mcp.cmd:1-26`）：按 `$env:KIMI_CU_WINDOWS_EXE` → `$env:KIMI_CU_WINDOWS_HOME` → `%LOCALAPPDATA%\KimiCU\` → `%ProgramFiles%\KimiCU\` 依次找 `kimi-cu.exe`，找不到就打错并退出 1；找到后 `"%APP%" mcp`（stdio MCP）。
- 宿主侧接线（`kimiCu.ts:197-216`）：`ctx.plugins.installPlugin({source: zipUrl})` → 若插件未启用则 `setPluginEnabled` → 逐个 `setPluginMcpServerEnabled` 打开其全部 MCP server。工具就绪 = "插件 enabled + state=ok + 启用 server 数=server 总数"（`kimiCu.ts:172-195` 的 `detectPluginLayer`）。

**对照结论**：MP 的 `app/fabric/model_plan.py:81-100` `TOOL_REGISTRY`（ToolSpec: tool/recipe_id/risk/min-max_objects/required_arguments/implemented）在"集中声明、白名单校验"这一点上是同一思路，但 Kimi CU 的白名单同时是**面向模型的 API 面**（MCP 直曝），而 MP 的 TOOL_REGISTRY 只是模型计划校验表，模型面与执行面被 `executor.py` 的 if/elif 二次分派断开。**照搬**：enabledTools 白名单 + 平台差异化清单（Windows 13 / macOS 10）的形态。

---

## 2. 逐工具输入/输出契约 + `used_backend` 语义

来源：win `SKILL.md:68-180`、mac `SKILL.md:11-28`、`README.md`。所有 mutating 工具共用约定：**必须传 `snapshot_id`**（除 list_apps/launch_app/activate_window 外），目标用**二选一**的 `index`（AX/UIA 树索引）或 `x/y`（截图像素坐标，运行时自动换算真实窗口）。

| 工具 | 输入（文档化） | 输出/语义 | used_backend（可能取值） |
|---|---|---|---|
| `list_apps` | 无 | 可见窗口列表（窗口 id/title/pid） | — |
| `launch_app` | `app`：exe 路径/名（`notepad.exe`）、StartApps 显示名（`飞书`）、或 AppID（`kugou`） | 启动成功；**未知/歧义名直接失败，不打开 Explorer**；成功后需再 `list_apps` 选窗口（SKILL.md:70-75） | — |
| `activate_window` | `window_id` 等目标 | 把已存在窗口置前恢复；仅"最小化后截图失败"或任务明确要求置前时用（SKILL.md:212-217） | — |
| `get_app_state` | `pid` / `app` / `window_id`；`mode: full\|image\|ax\|text`；可带 `ax_filter` | `snapshot_id` + windows 列表 + 树/截图/`visible_text`（行、indexes、rects、`filter`、`max_chars`、截断元数据）。**观察不激活/不聚焦目标**。`mode:"all"` 非法 | — |
| `click` | `snapshot_id` + `index` 或 `x,y` | **真实鼠标输入**；`index` 只用于从最新树解析目标矩形，**不是请求 UIA Invoke**（SKILL.md:151-154） | `foreground_click` / `uia_invoke` 系（原生路径） |
| `type_text` | `snapshot_id, text` + 可选 `index`/`x,y`、`clear`、`submit` | 先聚焦（**真实后台点击建渲染层焦点**——Electron/Web 收到键盘的前提）→ 可选 `clear`（Ctrl+A/Backspace）→ 剪贴板粘贴；返回 `verification: matched\|unavailable` + `dispatch` 字段；`submit:true` **只在 matched 时发 Enter**，否则 `submitted:false` + `submit_skip_reason`；非可编辑 index 清空前即拒 | `foreground_clipboard_paste`（+聚焦 `foreground_click`）|
| `press_key` | `snapshot_id, keys` | 真实 `SendInput`；形式 `Enter`、`Control_L+a`、`CTRLV`、`F5`、`PageDown`、`Insert`；**禁 Win/Meta/Super 组合**（SKILL.md:169-171,187） | `foreground_*` 系 |
| `scroll` | `snapshot_id` + `index` 或 `x,y` + `dx,dy` | `dy>0` 上、`dy<0` 下、`dx>0` 右；原生滚动区/列表优先 `scroll(index, dy)`（元素级 AX 滚动），普通页面用坐标（SKILL.md:165-168） | `foreground_wheel` / `uia_scroll_pattern` / `uia_scroll_item` |
| `set_value` | `snapshot_id, index, value` | **仅限真正暴露 UIA Value/RangeValue 的控件**（原生表单/滑杆），原子 + 写后校验（SKILL.md:158-159） | `uia_value` / `uia_legacy_value` / `uia_range_value` |
| `perform_secondary_action` | `snapshot_id, index, action` | 仅限有真实 UIA 语义模式的控件：`invoke/expand/collapse/toggle/select/scroll_into_view`；右键菜单优先 `AXShowMenu`（原生+Electron/Web 都可靠）；无支持动作则明说，回退到 click/scroll/press_key（SKILL.md:160-164） | `uia_invoke` / `uia_toggle` / `uia_expand` / `uia_collapse` / `uia_selection_select` |
| `select_text` | `snapshot_id` + `index` 或坐标 | Web/Electron：真实焦点 + Ctrl+A；原生控件：UIA TextPattern（SKILL.md:155-157） | `foreground_ctrl_a` / `uia_*` TextPattern |
| `drag` | `snapshot_id` + 起止目标（index 或坐标） | 真实 SendInput；**最后手段**（列表重排/删除优先 perform_secondary_action，mac SKILL.md:25） | `foreground_*` 系 |
| `turn_ended` | 无参 | 回合结束时隐藏 overlay（状态 pill + 蓝边 glow + 第二个光标），"if needed"（SKILL.md:173-176） | — |

**错误契约**：mutating 工具返回 `code=computer_use_busy` = 另一会话持有真实输入（SKILL.md:178-180）；**只读观察不受影响**，刷新状态后重试；**禁止用 shell 绕过所有权守卫**。窗口移动/缩放/换进程 → 旧 `snapshot_id` 被拒并要求重新 `get_app_state`（SKILL.md:111-116）。

**验证语义（type_text 是范本）**：不返回裸成功。`verification.matched` = UIA 确认文本已写入；`unavailable` = 粘贴路径跑了但未确认——此时模型必须看字段决定是否单独提交。这就是"非空 ≠ 读到了"在写路径的对应物。

---

## 3. turn_ended 规则（一轮何时结束）

**机制**：`turn_ended` 是**客户端回合收尾信号工具**，不是引擎事件；"一轮结束"由插件宿主（Kimi Code 的 query loop）决定，工具只在需要时清尾。依据：

- win `SKILL.md:173-176`：Windows 真实输入可能短暂移动物理指针；runtime 结束后恢复指针并显示 second-cursor overlay，**"Call `turn_ended` to hide the overlay at the end of a turn if needed"**——非强制。
- win `INSTALL.md:195`：**用户可按 Esc 停止当前 turn 的后续真实输入**；"正常情况下插件宿主会在 turn 结束时清理停止状态"——宿主在回合结束清理 stop 状态。
- win `INSTALL.md:196`：MCP 正常关闭**自动释放**当前 session 的输入所有权（busy 解除）。
- macOS 无此工具：后台注入永不移动真实鼠标，无需 overlay 清理。

**对照 MP**：MP 无回合概念（`app/pointer_operator.py:21-37` 明言"不是自主 CU loop"）；`turn_ended` 的"回合结束清理 + Esc 停止 + 会话关闭自动释放"三件事分别对应 MP 设计中缺失的 InputOwnershipLock 释放、取消（`governance/cancellation.py`）与 overlay 生命周期。**借鉴**：回合收尾作为一等工具/事件，而非静默状态。

---

## 4. snapshot / 坐标+元素双目标 / 输入所有权

**snapshot_id 语义**（win `SKILL.md:111-116`）：
- 校验的是**目标窗口身份 + 截图坐标系**（窗口移动/缩放/换进程 → mutating 工具拒绝过期 id）；
- **不证明视觉内容或索引新鲜**——按钮重排这类纯内容变化检测不到，只能靠工作流规则（导航/tab/模态/滚动/拖拽后必须重新 `get_app_state`；SKILL.md:103-109）；
- `window_id` 永远锁定精确窗口、**不跟随对话框**；对话框出现后用 `app`/`pid` 重新解析，找到对话框的 id 再作为 `window_id` 观察（SKILL.md:92-96）。

**双目标通道**：元素 `index`（树可靠时）与截图坐标 `x/y`（树不完整时）**恰好传一个**，混传被拒（SKILL.md:100-102）。批量动作在同一 snapshot 上连续做（聚焦→输入→提交），不逐步重观察；不确定/敏感动作前、重要动作后重观察验证。

**输入所有权**：真实输入（鼠标/键盘/剪贴板）**同一时刻只允许一个 session 持有**；冲突返回 `computer_use_busy`；只读观察永不被拒；MCP 会话关闭自动释放（INSTALL.md:196）。macOS 侧等价物是"权限与执行都在 launchd 服务内"，多个 MCP 前端共用服务（kimiCu.ts:404-409 安装时保活）。

**对照 MP**：MP 的 `app/actions/executor.py` 有更强的"目标身份"概念——`paste_text_to_foreground` 要求 hwnd+pid+title+坐标空间+text_sha256 全部匹配才写（executor.py:333-351），Word 替换要求 document/hwnd/selection 哈希前置断言（executor.py:584-596）；但这是**每动作独立断言**，没有 Kimi CU 的"观察先于动作、动作绑定观察版本、stale 自动拒绝"的**成对**机制。设计文档 §5.5 的 `StateVersion`（`MAGIC_POINTER_HARNESS_20260811.md:251-259`）正是为此，但当前代码没有对应实现。MP 的 `selection_snapshot_id` 只作为历史元数据落库（executor.py:663），不参与写前校验。

---

## 5. 平台工具加载与权限接线

**三层模型**（kimiCu.ts:41-49 + `REFERENCE_PROJECTS_20260810.md:31-41`）：

```
CapabilityService（capabilityService.ts:36-66，闭注册表）
  └─ entries: 'kimi-cu' | 'kimi-webbridge'（createKimiCuEntry 按 platform 二选一，kimiCu.ts:727-729）
       ├─ 插件层（开源）：kimi-cu[-win]-plugin.zip → MCP 声明 + skills + enabledTools
       ├─ 运行时层（闭源）：kimi-cu.exe / KimiCU.app
       └─ 权限层：macOS TCC 由 launchd 服务持有；Windows 由 runtime 自行管理
```

- **平台分叉**：`ctx.platform === 'win32' && ctx.arch === 'x64'` 走 Windows entry（kimiCu.ts:532），darwin 走 macOS entry（kimiCu.ts:263）；不支持则 `supported=false` → 状态 `unsupported`（capabilityService.ts:143-145）。
- **macOS 检测五层**（kimiCu.ts:328-390）：plugin → legacy-mcp（旧 mcp.json 重复注册检测+原子迁移，kimiCu.ts:224-246,304-326）→ app（存在/可执行/Info.plist）→ service（`service-status` 输出 `status=1`）→ permissions（`xpc-ping` 输出 `permissionStatus: accessibility=true screenRecording=true`，kimiCu.ts:94-101）。`optional` 步骤不阻塞 ready（types.ts:8-9,18-23）。
- **macOS 安装**（kimiCu.ts:436-517）：幂等，只重做未满足层；/Applications 不可写时走 `osascript ... with administrator privileges` 原生提权（kimiCu.ts:421-427）；旧进程 best-effort 清理（kimiCu.ts:398-413）；装完 `xattr -dr com.apple.quarantine`（kimiCu.ts:483-485）。
- **Windows**（kimiCu.ts:531-725）：先探测可用 PowerShell（5.1 或 7，要求 `Get-FileHash/Expand-Archive/Get-AuthenticodeSignature/Get-CimInstance/Invoke-WebRequest/Invoke-RestMethod/ConvertFrom-Json/ConvertTo-Json`，kimiCu.ts:62-69,540-567）→ 下载官方 `setup_windows.ps1` 执行（签名/回滚/自启逻辑留在上游）→ `doctor` 脚本按 env/LOCALAPPDATA/ProgramFiles 找 exe 并输出 `mcp=true helper=embedded`（kimiCu.ts:70-76,103-115）。插件文件被占用（EBUSY）时报"重启 Kimi Code 后再装"（kimiCu.ts:651-664）。
- **权限的关键洞察**：macOS 权限由后台服务持有并在服务内执行，**agent 进程不需要也不会有权限**；`doctor` 检查的是调用者进程，从 agent 跑必然 ❌，排障以 `xpc-ping` 为准（mac SKILL.md:37,44）。Windows 侧：目标应用以管理员运行时 KimiCU agent 也需同权限（UIPI，INSTALL.md:20）。

**对照 MP**：MP 当前无对应物。最近的形态是 `app/fabric/capabilities.py` / `capability_snapshot.py`（能力注册）与 `fabric/capture_policy.py`（隐私裁剪），但**没有**"二进制运行时 + 检测分层 + 幂等安装 + 权限接线"的 capability 编排；设计文档 §11.3 `CapabilityBroker`（`MAGIC_POINTER_HARNESS_20260811.md:517-528`）规划了统一接入（本地原生工具/SurfaceAdapter/MCP/Skills/插件/外部 Agent）与"按需加载少量工具，不长期塞系统 Prompt"，其"分层检测 + optional 不阻塞 ready + 单 entry 检测失败降级为 failed step 不整体失败"（capabilityService.ts:160-183）值得照搬进 CapabilityBroker。

---

## 6. 与 Magic Pointer 现状的差距

对照对象：`app/actions/executor.py`、`app/pointer_operator.py`、`app/fabric/model_plan.py`、`app/fabric/executors.py`。

| 维度 | Kimi CU（13 工具） | MP 现状 | 判定 |
|---|---|---|---|
| 工具面 | MCP 白名单直曝模型，schema 在运行时 | `TOOL_REGISTRY`（model_plan.py:81-100）仅校验工具名/风险/对象数，无输入 schema | MP 缺 schema 层（B2.2 要补） |
| 观察-动作绑定 | `snapshot_id`，stale 自动拒绝 | 每动作独立断言（hwnd/哈希），无观察版本 | **改写**：StateVersion 入写前校验（设计 §5.5） |
| 双目标 | index 或坐标二选一，混传拒绝 | 只有 TargetRef/坐标语义的 ActionTarget（actions/schema.py） | **借鉴**：校验放注册表，不混用 |
| 输入所有权 | 单 session 互斥 + `computer_use_busy` | `fabric/target_lease.py` 有租约；无真实输入互斥锁（设计 §12.1 InputOwnershipLock 未实现） | **借鉴** |
| 验证 | 写后验证字段（`matched/unavailable`、`submit_skip_reason`）、used_backend 如实报 | 文本哈希+字符数验证（executor.py:386-398）、Word 写后读回+失败回滚（executor.py:620-623）——验证强于 Kimi CU | MP 更严，保留 |
| used_backend | 每种路径一个枚举值 | 无；`method` 字段部分动作有（executor.py:391,671）但非强制契约 | **照搬**：设计 §5.5/§11.1 已要求 |
| 动作分层 | 原生控件 UIA 语义动作 vs 前端真实输入，写路径只走真实输入 | `paste_text_to_foreground` 走键盘注入；无 click/scroll/drag/set_value/select_text/perform_secondary_action 全套 | **改写**：补 13 工具但输入优先 TargetRef（设计 §11.2:515） |
| 回合 | `turn_ended` + Esc 停止 + 会话关闭释放 | 无回合；单 tool call 分类器（harness-gap-review L1） | 纳入 B2 循环 |
| 窗口发现 | list_apps/launch_app/activate_window | `system_context.list_visible_windows`（executor.py:189 传入）仅有列表 | **照搬**清单 |
| 能力接线 | 检测分层+幂等安装+权限服务化 | 无 capability 编排 | CapabilityBroker（设计 §11.3） |

MP 明确更强、不要退化：前置断言（executor.py:584-596）、undo（Word 精确恢复 executor.py:698-824、购物清单/日历）、确认策略（policy.py）、防注入/权限裁剪（fabric/capture_policy.py）。

---

## 7. 桌面动作工具契约建议（供 B2.2 `tool_registry.py` 参考）

综合 Kimi CU 文档化语义 + MP 既有 ToolSpec 形态，建议 tool_registry 条目契约（对应设计文档 §11.1 的字段清单，`MAGIC_POINTER_HARNESS_20260811.md:493-505`）：

```text
ToolEntry {
  id                    # list_apps / click / type_text / ...（Kimi CU 命名，平台差异化清单）
  schema                # JSON Schema 输入校验（Kimi CU 有 schema 但闭源；MP 必须自建并放注册表）
  effect                # read | reversible_write | local_irreversible | external_send | destructive | purchase
  risk                  # 复用 RiskLevel（model_plan.py:102-108）
  min_objects/max_objects
  required_args
  target_shape          # "index" | "coords" | "both_or_either" | "none" —— 双目标校验点：
                        #   恰好传 index 或 x/y 之一，混传拒绝（Kimi CU 规则照搬）
  leases                # 所需 ObjectLease / ActionLease / StateVersion（观察版本绑定，stale 拒绝）
  concurrency           # 并行允许 | 串行（conflict key）—— 输入所有权按 conflict key 互斥
  ownership             # read（永不被 busy 拒）| real_input（busy 语义 + 会话关闭自动释放 + Esc 停止）
  verify                # 写后验证契约字段：matched | unavailable | mismatch（照 type_text verification）
  used_backend          # 枚举契约，如实返回（照 Kimi CU 13 个值 + MP 自有 backend）
  undo/rollback         # 补偿动作引用（MP 已有 Word/购物清单/日历 undo，new tools 须带）
  idempotency           # 幂等键（MP 已有 idempotency_key 惯例）
  timeout/retry/cancel
  latency_hint
  platform              # windows 13 | macos 10（照 kimi.plugin.json 平台分叉）
}
```

额外三条规则（来自 Kimi CU，注册表/校验器层面强制，不靠模型自觉）：
1. **busy 是状态不是失败**：`computer_use_busy` 时只读工具照常放行，mutating 返回可重试错误；禁止 shell 绕过。
2. **回合收尾一等公民**：循环的 turn 结束 = 清理 stop 状态 + 释放输入所有权 + 隐藏 overlay（`turn_ended` 等价物），会话关闭兜底释放。
3. **写成功必须带证据**：mutating 结果必须包含 `verification` + `used_backend`；"路径跑了但没确认"（unavailable）与"确认写入"（matched）是不同状态，模型不得把前者当成功。

---

## 8. 来源索引

- `kimiCu.ts`：41-49（插件 URL/ID）、62-76（PS 探测与 doctor 脚本）、94-115（权限/doctor 解析）、172-216（插件层检测与安装）、224-246/304-326（legacy MCP 迁移）、328-390（macOS 五层检测）、398-517（macOS 幂等安装）、531-725（Windows entry）、727-729（平台分叉）
- `capabilityService.ts`：36-66（注册表）、68-120（list/get/install 串行化）、134-158（readiness 状态机）、160-183（单 entry 失败降级）
- win `kimi.plugin.json`：35-59（13 工具白名单）；mac `kimi.plugin.json`：33-51（10 工具）
- win `SKILL.md`：68-116（工作流/snapshot/window_id 规则）、118-137（used_backend 含义）、139-180（工具偏好/turn_ended/busy）、182-217（安全与排障）
- win `INSTALL.md`：173-196（工具清单/Esc 停止/所有权释放/环境变量）
- mac `SKILL.md`：11-28（后台不变量）、24（type_text 聚焦）、29-34（安全）
- MP：`app/actions/executor.py:33-45,130-163,323-406,546-824`；`app/pointer_operator.py:21-96`；`app/fabric/model_plan.py:35-108,295-297`；`docs/design/MAGIC_POINTER_HARNESS_20260811.md:251-259,493-554`；`docs/harness-gap-review-20260812.md`
