# Everywhere (Sylinko) 技术分析报告

> 目的：给正在改 Magic Pointer 的 agent 一份"心中有数"的底稿。
> 源码已克隆到 `external/everywhere`（浅克隆 depth 200）。Release 原始数据在 `.tmp-everywhere/releases_stable.md`。
> 调研日期：2026-08-03。数据来自 GitHub API + 全量 76 条 release notes + 源码通读。

---

## 0. 给赶时间的人：五条结论

1. **他们比你想的还早**。不是"去年 10 月"，是 **2025-07-30 首个 release**，仓库 2025-04-23 创建。到今天整整 **12 个月、60 个正式版 + 16 个 canary**，6207 star。你晚了一年。
2. **但赛道不完全重合**。Everywhere 是 **快捷键唤起 → 聊天窗口 → Agent 工具循环**（本质是"带屏幕上下文的 Claude Code 桌面版"）。Magic Pointer 是 **晃动唤醒 → 圈选 THIS → 单气泡即时动作**。他们**完全没有语音、没有手势圈选、没有"原位改写"**——那是我们的地盘。
3. **不要换 C#**。语言不是他们的优势来源，**进程架构**才是。真正该抄的是"单进程 + 原生 UIA 常驻"，而不是"用 C# 重写"。见 §3。
4. **源码里有三个直接能治我们当前 P0 的答案**：`UIA_WindowVisibilityOverridden=2`（overlay 不再污染 UIA / 不触发 Chromium 渲染器休眠）、双窗口拆分（输入面 vs 视觉面）、token 预算的 best-first UIA 遍历。见 §5.1 / §5.2 / §5.3。
5. **法律红线**：v0.5.4（2025-12-20）起从 Apache 2.0 改成 **BSL 1.1，明文禁止 Competing Use**。Magic Pointer 就是 competing product。**不能抄他们的代码**，只能读思路、走上游原始来源。见 §6。

---

## 1. 项目事实卡

| 项 | 值 |
|---|---|
| 仓库 | `Sylinko/Everywhere`（原 `DearVa/Everywhere`，约 v0.7.7 改名，说明背后开了公司 Sylinko Inc.） |
| 创建 | 2025-04-23 |
| 首个 release | **2025-07-30 (v0.1.0)** |
| 最新 | v0.8.0 稳定（2026-06-19）/ v0.8.1-canary.16（2026-07-25） |
| Star / Fork | 6207 / 383，watcher 34，open issue 25 |
| 语言/框架 | C# / .NET 10 / **Avalonia 12** / Semantic Kernel |
| 许可 | v0.5.3 及以前 Apache 2.0；**v0.5.4 起 BSL 1.1**（4 年后转 Apache 2.0） |
| 平台 | Windows（首发）→ macOS（2026-01-21, v0.6.0）→ Linux |
| 代码量 | `src/` ≈ 11.7 万行；Core 8.6 万 / Windows 5.7k / Mac 4.5k / Linux 4.5k / Terminal 3.7k |
| 商业化 | v0.7.0 (2026-04-16) 上线 Everywhere Cloud：托管模型 + 云同步 + 积分制 + BYOK 并行 |

### 发版节奏（正式版按月）

```
2025-07  2   ← 首发
2025-08  7
2025-09  0   ← ★ 静默 47 天：重构插件系统 + OOBE
2025-10  16  ← ★ 爆发月，一天两版都有
2025-11  7
2025-12  4   ← 改 BSL + 全新 UI
2026-01  7   ← macOS 落地
2026-02  6
2026-03  1   ← ★ 静默 46 天：做 Cloud + Strategy Engine
2026-04  5   ← v0.7.0 大版本 + 4 个紧急修复
2026-05  4
2026-06  1   ← v0.8.0 + 转 canary 通道
```

---

## 2. 功能对照：他们有什么 / 我们有什么

### 2.1 他们做到了、我们还没有的

| 能力 | 他们的实现 | 我们的状态 |
|---|---|---|
| 全局划词监听（选中即感知） | `VisualElementContext.TextSelection.cs`，946 行工业级降级链 | 无 |
| UIA 树 → LLM 上下文（带 token 预算） | `VisualContextBuilder`，best-first + 优先队列 + 三档详略 | `selection_snapshot_bridge.py` 只做 bbox 相交打分，无预算 |
| Agent 工具循环 + 工具权限门 | `ChatPluginManager` + `ChatFunctionPermissions` 位标志 + 逐次同意/本会话同意/始终允许 | Recipe 引擎有 policy，但没有"聊天流内嵌确认 UI" |
| Strategy Engine（上下文推荐动作） | 条件 DSL + Provider + 预处理器，Markdown 可编辑 | Recipe 是硬编码 Python 元组（AGENT.md 自己承认"生态被物理封死"） |
| SKILL.md 生态 | `SkillManager` + `skill://` URI + 系统提示注入索引 + 按需 read_file | 无 |
| MCP 客户端（stdio/HTTP/SSE） | `ManagedMcpClient`，含自动重连、运行时依赖检测（缺 uv/node 会引导安装） | 我们是 MCP **server**（8 tools），不是 client |
| 工具输出硬截断 | 每次工具执行 ~40K token 上限（`PromptTokenLimit(40000)`） | 无，长会话必炸 |
| PTY 终端集成 | `Everywhere.Terminal` 3.7k 行，OSC 633 shell 集成 | PowerShell 直调 |
| 子 Agent + Todo List | `EssentialPlugin`，子 agent 继承视觉上下文与会话级授权 | 无 |
| 看门狗进程 | `Everywhere.Watchdog` + **JobObject**，兜底杀干净所有子进程 | 无（我们有 MCP/Python 子进程泄漏风险） |
| 多语言 | 12+ 语言，GitHub Action 自动翻译 | 中文 |
| 数字签名 + 增量更新 + 更新通道 | Certum 签名、dll 也签、canary/stable 通道、后台限速下载 | 有 electron-updater，无签名 |

### 2.2 我们有、他们**完全没有**的

- **语音输入**：全仓库 grep `whisper|speech|dictation|microphone` = **零命中**。他们没有任何语音路径。我们有 SenseVoice + Whisper 双引擎本地识别。
- **手势圈选**：他们的选择模式只有 `Screen / Window / Element / Free`（悬停高亮点选 + 自由矩形），**没有画圈/画线的笔画语义**。我们的 `kind + semanticPoint + 走廊多边形`是独有的。
- **原位改写**：他们 v0.5.8 **删掉了** UI 元素操作工具（"Removed the unstable UI element manipulation tool"），到 v0.6.7 才以 `execute_visual_actions` 实验性回归，且 v0.7.5 还在修 `SetText 总是失败`。**写回是全行业的硬骨头，他们也没啃下来**——这里是我们能赢的点。
- **不可见默认态**：他们是"按快捷键弹聊天窗"，本质仍是一个窗口。我们是"默认不可见的操作层"。
- **本地 Agent 交接**（Codex/Pi/Claude/Gemini CLI）：他们只接模型 API 和 MCP，不接用户已装的 CLI agent。

### 2.3 冷酷的判断

**你的优势不在"做得更早/更全"，在于交互形态不同。**
Everywhere 是"另一个能看屏幕的聊天框"。真要拼聊天框 + 工具生态，一年差距 + 一个公司的资源，追不上也没必要追。
真正值钱的是 AGENT.md 战略文档里已经写对的那句：**主战场是 Ctrl+C 复制不了的东西**。而 Everywhere 的整条 TextSelection 链路恰恰证明了——**能 Ctrl+C 的部分他们已经做到工业级了**。所以我们的差异化必须往"复制不了 + 要写回 + 要跨应用"三个方向压，不要在"选中文字然后翻译"上耗。

---

## 3. 为什么他们用 C#？我们要不要换？

### 3.1 他们选 C# 得到了什么（真实的）

1. **单进程直调 Win32/COM**。UIA 是 COM 接口，C# 通过 `Interop.UIAutomationClient` + `CsWin32` 源生成器直接 P/Invoke，**零 IPC、零序列化、零进程启动**。
   我们的链路是 `Electron → spawn python → pywinauto/comtypes → 回 JSON`。这就是"提交后 30 秒 bridge_timeout"和"Enter 后 5 秒气泡才出"的结构性原因——**不是哪一行代码慢，是架构上每次感知都要付一次进程冷启动**。
2. **hook 跑在专用高优先级 STA 线程 + 自建消息泵**（`LowLevelHook.cs`）。`ThreadPriority.Highest`，`GetMessage/DispatchMessage` 循环。Windows 对低级 hook 有 ~300ms 超时，超时即静默摘钩。
   我们是 `pointer_input_state.ps1` **轮询**——延迟高、丢事件、还引发了 8/3 那个"hook 吞掉 WM_LBUTTONDOWN 导致 GetAsyncKeyState 读不到"的连锁 bug。
3. **DirectX 截屏**（`Direct3D11ScreenCapture.cs`，Windows.Graphics.Capture + DComposition）。GPU 路径，能抓被遮挡窗口，不闪。我们是 Pillow ImageGrab。
4. **PublishTrimmed 自包含**，v0.5.1 靠 trimming 把包砍掉约 50%。

### 3.2 但这些**都不是"C# 才行"**

- Electron 侧可以写 **N-API 原生模块**（node-ffi-napi / node-addon-api），直接调 UIA COM 和 `SetWindowsHookEx`，同样单进程零 IPC。`nut.js`（已在 `external/`）就是这么做的。
- 常驻 Python worker（像我们已经做的 `local_voice_worker.py` / 常驻 OCR worker）也能消掉冷启动，只是消不掉序列化和 GIL。

### 3.3 结论：**不换**，理由三条

| 理由 | 说明 |
|---|---|
| 迁移成本远大于收益 | 我们已有 11.7 万行量级的资产（30 Recipe、双语音引擎、Agent 网关、MCP server、Dashboard 14 面板、117 JS 测试 + 600 Python 测试）。重写 = 归零，且换完还是落后一年。 |
| 语言不是瓶颈，**边界**才是 | 我们的延迟根因全部落在"跨进程"上，不落在"Python 慢"上。把边界从"每次感知 spawn 一次"改成"常驻 + 原生 hook"，收益 ≥ 换语言的 80%，成本 < 5%。 |
| 我们的差异化功能在 Python 一侧更强 | SenseVoice/sherpa-onnx、RapidOCR、Whisper——这些生态在 .NET 上要么没有要么难用。换 C# 等于把自己唯一的护城河（语音+本地感知）拆了。 |

### 3.4 该抄的是**架构**，不是语言（按优先级）

1. **感知常驻化**：`selection_snapshot_bridge.py` 从"每次 spawn"改成"常驻 worker + JSONL"。我们在语音链路上已经验证过这套模式（`voice_worker_client.js` 事件推送无轮询），照搬即可。这一条直接治 §HANDOFF 里的"Enter 后 5 秒"。
2. **hook 原生化**：把 `pointer_input_state.ps1` 轮询换成 N-API 里的 `WH_MOUSE_LL`，跑独立高优先级线程，事件推送而不是轮询。这一条直接治"蓝色光标高频闪烁"和"pass_through 吞事件"。
3. **子进程 JobObject 化**：抄 `Everywhere.Watchdog` 的思路——把所有 Python/MCP 子进程放进 Job Object，主进程死了 OS 自动清干净。他们 v0.5.1 就是修这个 bug。

---

## 4. 从 76 个版本里学到的产品经验

> 这一节是你要的"没做过产品所以不知道该怎么一步步来"的答案。全部从 release notes 反推，不是我编的方法论。

### 4.1 版本节奏：**长静默做大改，然后高频小版本收尾**

两次最明显的静默期：

- **2025-08-15 → 2025-10-01（47 天，0 发版）**：出来的是 v0.3.0——插件系统重构 + OOBE 向导 + 自定义模型 + 看门狗进程。之后 **10 月一个月发了 16 个版本**，全在修 v0.3.0 引入的问题。
- **2026-03-01 → 2026-04-16（46 天，0 发版）**：出来的是 v0.7.0——Cloud Services + Strategy Engine，19 新功能 / 27 改进 / 15 修复。三天后 v0.7.1 开头就写：*"⚠️ 此更新修复了 0.7.0 的许多问题，包括致命崩溃，强烈建议所有用户立即更新"*。

**教训**：大版本后 72 小时内必然有一个"救火版"。**不要在大版本发布后立刻开下一个大版本**，要预留 1-2 周的高频修复窗口。我们现在的 Stage v2 + 感知链路改造就是一个"大版本"，发出去之后要按这个节奏排期。

### 4.2 顺序：**先把"能用"做扎实，再谈"聪明"**

真实顺序（每一步都是上一步的前提）：

```
v0.1  能弹出窗口 + 能对话                        （2 个版本，9 天）
v0.2  模型接得全（20+ 模型）+ 设置页重构          ← 先解决"用户没 key/没模型"
v0.3  插件系统 + OOBE + 看门狗 + 遥测            ← 先解决"装上跑不起来"
v0.4  插件执行反馈 + 权限确认 + 结果可视          ← 先解决"不敢让它动我电脑"
v0.5  MCP + 密钥加密 + 全新 UI + 子 Agent        ← 才开始谈生态
v0.6  macOS + 划词上下文 + get_visual_tree       ← 才开始谈"更懂屏幕"
v0.7  云服务 + Strategy Engine                   ← 才开始谈商业化和自动化
v0.8  SKILL.md 生态 + 主页                       ← 才开始谈"别人来扩展"
```

注意 **OOBE（首次启动向导）排在 v0.3.0，比 MCP 早了 5 个大版本**。他们很早就意识到：一个装上之后不知道怎么配模型的工具，功能再强也是零。

对照我们：`onboarding.html` 有了，但 AGENT.md 的下一步列表里"配置页/主页重设计"排在很后面。**这个优先级要往前提**。

### 4.3 破坏性变更：**提前公告 + 自动备份 + 留后路**

他们做过 4 次破坏性变更，每次的处理模板一致：

- v0.2.0 数据库重构 → 明说"beta 阶段历史记录丢失"，同时承诺"新结构支持迁移，以后不会再丢"。
- v0.3.11 模型配置页重建 → **告诉用户旧值还在 `settings.json` 里，附上完整路径**，高级用户可自己捞。
- v0.5.6 密钥加密迁移 → 提前警告备份、迁移后旧 key 落到 `LegacyApiKeys` 字段、并提醒"配好之后请立刻删掉这个字段"。**连续两个版本（v0.5.6/v0.5.7）都在 release notes 顶部重复这段警告**。
- v0.7.2 → 配置文件损坏时**自动备份并保留**，枚举值非法自动回退默认。

**教训**：破坏性变更不是"改了就完了"，是一套动作——公告 + 备份 + 可人工恢复的落点 + 连续多版本重复提示。

### 4.4 什么样的 bug 会重复出现（他们的"踩坑热力图"）

统计 60 个正式版的 fix 条目，**同一类问题反复出现**的 top 5：

| 类别 | 出现次数 | 典型条目 |
|---|---|---|
| **窗口生命周期/焦点/置顶** | 15+ | 关闭后无法重开、Alt+Tab 残留、多屏跑到屏幕外、pin 时闪烁打断输入法、最大化按钮无效 |
| **快捷键** | 8 | Win 键卡死、Alt 不能用、修饰键卡住、监听器偶发失效（**重构了 2 次**：v0.7.1 和 v0.7.2） |
| **模型协议兼容** | 12+ | DeepSeek 推理中调工具 400、Gemini 并行调用报错、Kimi 在 OpenAI schema 下工具失败、signature 缺失 |
| **高 DPI / 多屏** | 4 | 元素选择器偏移（**修了 3 次**：#17 / v0.7.0 / v0.6.2） |
| **Markdown 渲染** | 10+ | 选中丢字、粗体变回常规、复制报错、内存暴涨（一次优化 2700%） |

**教训 A**：窗口生命周期是这个品类**最大的 bug 源**，超过 AI 本身。我们的"第二次激活画线失败""气泡跑到右下角""气泡出现后乱动""光标在两套之间跳"全都在这一类里——**这不是我们特别菜，这是品类特性**。应对方式是把窗口状态机写成可测试的纯函数（我们的 `stage_contract.js` / `stage_hit_policy.js` 方向是对的，要继续加固）。

**教训 B**：高 DPI 偏移会修不止一次。别指望一次修完，要加**跨 DPI 的回归测试夹具**。

**教训 C**：多模型兼容是个无底洞。他们最后的解法是**收敛到 schema 层**（v0.6.6"增强 OpenAI schema 并弃用独立 DeepSeek schema"）。我们接 Agent CLI 而不是裸 API，某种意义上绕开了这个坑——**这是我们架构的隐性优势，别丢掉**。

### 4.5 用户信任是**一条独立的产品线**

从 v0.3.3 到 v0.7.7，他们持续投入在"让用户敢用"上，且**每一步都写进 release notes**：

```
v0.3.3  加遥测，同时立刻写 DATA_AND_PRIVACY.md 并在 notes 里链出去
v0.3.4  "移除了不必要的遥测数据"          ← 主动做减法
v0.4.0  高权限插件执行前必须用户确认
v0.4.4  多行 PowerShell 脚本禁用"本会话允许/始终允许"   ← 主动收紧
v0.5.1  加数字签名（感谢 Certum）
v0.5.6  API key 改用更安全的加密方式
v0.6.5  自动批准管理，但终端类工具永远手动
v0.7.0  拒绝工具调用时可以填"拒绝理由"，模型据此纠正行为
v0.7.0  Windows 安装包加官方数字签名，减少杀软误报
v0.7.2  .dll 也加签名
v0.7.7  终端自动批准开关，notes 里直接写"⚠️ 数据无价，请谨慎授权"
v0.7.8  0Harmony.dll 移除依赖，只为了减少杀软误报
```

**教训**：安全能力不是"做完就行"，是要**持续公开地做、并且敢做减法和收紧**。我们的隐私立场（默认不上传截图、遥测默认关、本地 OCR 兜底）是对的，但**没有对外表达**。至少该有一份 `DATA_AND_PRIVACY.md`。

另外注意 **杀软误报**这条线——他们为此改了 UserAgent、删了 0Harmony.dll、给 dll 单独签名。我们是 Electron + 打包 Python runtime + 装全局鼠标钩子，**误报概率只会更高**。这是发布前必须处理的问题，现在还没进我们的清单。

### 4.6 错误消息本身是个功能

至少 10 个版本在改错误提示：翻译化、加详细提示、上下文超限单独提示、代理错误单独提示、去重、更新失败给出原因、模型不支持的附件提前过滤掉而不是让模型报错……

v0.7.8 还加了"**继续并重试**"按钮——出错后能保留当前轮已生成的部分内容继续，而不是开新分支。

**教训**：对照我们 AGENT.md 里那条"不要在交互路径上用批处理超时"——他们更进一步：**不仅要快速失败，还要失败得可理解、可恢复**。我们的 pending turn 已经显示已耗时秒数了，下一步该做的是失败后的"继续/重试"而不是"重来"。

### 4.7 关于"抄"的正确姿势（他们自己就是这么做的）

看他们的代码注释：

- TextSelection 检测：`Ported from selection-hook (github.com/0xfullex/selection-hook)`
- 进程排除名单：`from: CherryHQ/cherry-studio ... SelectionConfig.ts`（连 commit hash 都写了）
- 键盘 hook 兜底：`Reference: PowerToys / CmdPalKeyboardService/KeyboardListener.cpp`
- 技能提示词模板：`From vscode copilot prompt template, with modifications`
- DWM 缩略图技巧：`https://blog.adeltax.com/dwm-thumbnails-but-with-idcompositionvisual/`

**他们几乎没有从零发明任何底层技术**。全是找到已经解决这个问题的开源项目，读懂，移植，标注来源。
这就是"没做过产品不知道怎么做"的最好答案：**先找到已经踩过这个坑的人的代码**。

---

## 5. 源码里可直接落地的技术点（按 ROI 排序）

### 5.1 ★★★ `UIA_WindowVisibilityOverridden = 2`

**文件**：`docs/ScreenPicker/04-The-Overlay-Occlusion-Problem.md`（196 行，建议全文读）
**代码**：`src/Everywhere.Windows/Interop/ScreenSelectionSession.cs:82-86`

他们花了几个月、写了 4 章文档、逆向了 `UIAutomationCore.dll` 才找到这个答案。核心事实：

`UIAutomationCore.dll` 里的 `BasicHwndUtils::GetWindowVisibility(HWND)` **第一件事**就是读窗口属性 `UIA_WindowVisibilityOverridden`：

| 属性值 | UIA 遍历时的效果 |
|---|---|
| `1` | 强制视为可见，跳过其它检查 |
| **`2`** | **强制视为不可见，UIA 完全跳过这个窗口** |
| 不存在 | 走正常可见性逻辑 |

```csharp
// 给每一个 overlay 窗口设上
SetProp(hWnd, "UIA_WindowVisibilityOverridden", (HANDLE)2);
// 关闭时清掉
RemoveProp(hWnd, "UIA_WindowVisibilityOverridden");
```

**为什么这对我们是 P0**：

我们现在 `electron/main.js:1978` 的做法是——**先 `hideOverlay()` 再截屏/UIA**，代码注释自己写了原因：

> *"Secure the physical screen before showing any stage surface. Otherwise the voice capsule becomes part of the screenshot and **UIA point probes hit our overlay instead of the user's application**."*

也就是说我们已经撞上了同一个问题，但用的是"躲"的方案。躲的代价有三个：

1. **要等一帧甚至更久**（Electron 隐藏透明窗口不是同步的），这是"Enter 后 5 秒"里实打实的一段。
2. **用户的笔画在感知期间消失**，视觉上断裂。
3. **躲不掉 Chromium 渲染器休眠**——见下条。

设上这个属性后，overlay 可以**一直挂着**，UIA 照样能读到底下应用的深层元素。

### 5.2 ★★★ Chromium 渲染器休眠 —— 一个我们几乎肯定已经中了但没诊断出来的 bug

同一份文档第 4 章。事实链：

1. 现代 Chromium/Electron 用 **DWM 遮挡检测**判断自己是不是被完全挡住了。
2. 一旦判定被一个**不透明的外来窗口**完全遮挡，它会**休眠渲染器**：把 `Chrome_RenderWidgetHostHWND`（**UIA provider 就挂在这个窗口上**）从可见的 `Chrome_WidgetWin_1` 下**动态重新挂载**到隐藏的 `Chrome_WidgetWin_0` 下。
3. 原位置只剩一个没有 UIA provider 的 `Intermediate D3D Window`。
4. 结果：`ElementFromPoint` **只能返回根元素**，读不到任何页面内容。

**对我们意味着什么**：任何一个 Electron/Chrome/VSCode/Discord/微信新版（很多是 CEF）目标窗口，只要被我们的全屏 overlay 完全盖住，UIA 就会**退化成只能读到窗口标题**。

这**极可能是** AGENT.md 里那条"全屏截图曾把 UIA 读到的正确文本顶成空 content"以及"结构化失败才用 screen_region"高频触发的真实根因之一——我们一直以为是打分/几何问题，可能根本是目标应用把 UIA 树搬走了。

两个修法（都不需要换语言）：
- **首选**：`UIA_WindowVisibilityOverridden=2`（§5.1），UIA 直接无视我们的窗口，也不触发遮挡判定。
- **兜底**：给 overlay 加 `WS_EX_LAYERED` + `SetLayeredWindowAttributes(alpha=254)`。**254 不是 255** —— DWM 就不再把它算作完全遮挡者。对纯 Win32 owner-draw 窗口无效，但对 Chromium 有效。

> **验证建议**：拿一个 Electron 应用（比如 VSCode）做对照实验——overlay 只盖住屏幕左上 1/4 时读 UIA，和 overlay 全屏时读 UIA，比较 `context.content`。他们就是这么定位的（文档里的"1/4 屏测试台"）。这个实验一小时能做完，能一次性解释我们一堆"感知不稳定"的现象。

### 5.3 ★★★ 输入面与视觉面拆成两个窗口

**代码**：`src/Everywhere.Windows/Interop/ScreenSelectionSession.cs:45-70`

他们的架构：

```
ScreenSelectionSession       ← 普通的、对输入不透明的 topmost 窗口，走标准事件路由
├── ScreenSelectionMaskWindow[]   ← 每个显示器一个，SetHitTestVisible(false)
└── ScreenSelectionToolTipWindow  ← SetHitTestVisible(false)
```

**一个窗口只负责收输入，另外几个只负责画**。收输入的那个永远不切 hit-test 状态，画的那些永远不收输入。

对照我们：`shouldCaptureMouse` / `setIgnoreMouseEvents` 二态切换 + `dragging` 参数 + 拖拽时 hit region 扩到整屏 + `hasInteractiveSurface` 被 `chipsBox.hidden` 门控……这一整套复杂度**全部来自"同一个窗口既要画又要收事件"**。

他们第 1 章明确记录了走过我们同一条路（`WS_EX_TRANSPARENT` + 全局 hook + 合成右键锁光标），列出的失败模式和我们的一模一样：

- **UAC 提权时 hook 静默失效** → 合成的右键按下永远收不到抬起 → 用户的右键彻底废掉
- **第三方鼠标工具**（MouseInc / X-Mouse / AutoHotkey）也装 `WH_MOUSE_LL`，互相吃事件 → 行为不可预测
- **hook 300ms 超时**，机器一忙就静默摘钩
- **关闭序列要两层异步 dispatch**，还要防"幽灵右键"弹出资源管理器菜单

> 这段应该原样加进我们 AGENT.md 的「不要做的事」，作为"为什么不能靠 SendInput 回放/不能靠单窗口二态"的外部证据。

### 5.4 ★★ 全局划词的完整降级链

**文件**：`src/Everywhere.Windows/Interop/VisualElementContext.TextSelection.cs`（946 行）
**上游**：`github.com/0xfullex/selection-hook`（他们移植的原始来源，**我们应该直接去读这个而不是读他们的 C#**，见 §6）

值得抄的**设计**（不是代码）：

**触发判定**（三选一才算一次选择）：
- 拖拽：距离 ≥ 8px 且时长 ≤ 8000ms，**且窗口没移动**（用 mousedown/up 两次 `GetWindowRect` 比对，容差 2px——防止把"拖窗口"误判成"选文字"）
- 双击：500ms 内、位移 ≤ 3px
- Shift+单击（且没按 Ctrl/Alt）

**防抖**：命中后**等 500ms 再执行**，等三连击的序列稳定下来，用可复用的 CancellationTokenSource 取消上一次。

**取文字的降级链**：
1. `GetFocusedElement()` → 校验 PID 匹配 → `GetSelectionText()`（UIA TextPattern，零副作用）
2. 失败才走剪贴板，且走之前有**三道闸**：
   - **进程黑名单**：Snipaste/PixPin/ShareX/Excel/PPT/PS/AI/Pr/AE/Au/Blender/3dsMax/Maya/AutoCAD/SolidWorks/mstsc — 这些应用发 Ctrl+C 会造成真实破坏
   - **光标形状判定**：mousedown 或 mouseup 任一时刻是 I-beam → 认为是真选字；不是 I-beam 也不是箭头/手型 → 拒绝（除非在 acrobat/wps/cajviewer 白名单里）；是箭头/手型时看 UIA ControlType 是否为 Group/Document/Text（Chrome DevTools 是 Group，Chrome 页面是 Document/Text）
   - **用户意图检测**：先看剪贴板序列号有没有自己变（用户自己复制了就直接读，不插手）；再检测 Ctrl/C/X/V 是否按下，按着就放弃
3. **剪贴板备份**：优先 `CF_UNICODETEXT` → `CF_DIB`（不能弄丢用户的截图）→ `CF_HDROP`（不能弄丢用户复制的文件列表）
4. **发键策略 A：Ctrl+Insert**（比 Ctrl+C 更少被应用重写），发之前先把 Alt/Shift 抬起来，用 `GetClipboardSequenceNumber` 5ms×20 次轮询变化
5. **策略 B：Ctrl+C**（5ms×36 次），但对 cmd/powershell/WindowsTerminal/conhost **禁用**（那里 Ctrl+C 是中断信号）
6. Acrobat/WPS/CAJViewer/福昕 这类会**多次改剪贴板**的，额外等 135ms 再读
7. **finally 里恢复剪贴板**，并写入 `CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` 两个格式把这次操作**排除出 Win+V 历史和云剪贴板**

第 7 条尤其值得注意——**他们 v0.6.5 才修好"选区结果污染剪贴板历史"这个 bug**。这是那种你不亲自发布过、被用户骂过就绝对想不到的细节。

### 5.5 ★★ Token 预算驱动的 UIA 遍历

**文件**：`VisualContextBuilder.Traversal.cs`（679 行）+ `VisualContextBuilder.cs`（681 行）

算法骨架：

```
从 core element（用户选中的那个）出发，最佳优先搜索（优先队列/最小堆）
score = 拓扑分 × 类型权重

拓扑分：Parent 2000 / 兄弟 10000 / Child 1000，除以「局部距离」线性衰减，再减去「全局距离 - 局部距离」
类型权重：Label/TextEdit/Document 2.0 > Panel/TopLevel/TabControl 1.5 > Button/ComboBox/... 1.0 > Image/ScrollBar 0.5

每弹出一个节点就计算它的 token 成本（结构 + 内容），累加；超预算立刻停
三档详略：Detailed(XML) 结构成本 8 tok/节点 · Compact(JSON) 5 · Minimal(TOON 表格) 2
```

两个精巧之处：

- **"自信息性"传播**：一个容器节点本身没内容，但只要有一个后代是有信息的，就往上冒泡把祖先"激活"（并在那一刻才付它的结构 token）。避免了"为了一个按钮把整棵空 div 树都渲染进去"。
- **多附件的预算分配**：`BuildAndPopulate` 先按 `(ProcessId, 顶层 HWND)` 分组，每组按元素数量比例分配 token，**同组只有第一个附件拿到完整 XML，其余置 null**——彻底消除重复上下文。

配套的 `TokenBudget.Allocate`（`AI/TokenBudget.cs`）是个**加权公平队列**（类比路由 QoS）：先给每项保底 `min(desired, 200)`，剩余按未满足需求比例分配，单项封顶 `totalBudget/2` 防止独占，最后余数按缺口大小分配。

**对我们**：`selection_snapshot_bridge.py` 现在是 `3.0×距离 + 4.0×覆盖率` 的**平面打分**，没有：预算概念、类型权重、祖先/兄弟方向的差异化、内容截断标记（`isContentOmitted` / `HasOmittedChildren`）。AGENT.md 里 OpenSRE 分析那条"上下文预算 —— 我们的 compile_context_prompt 无 token 预算，长会话必炸"说的就是这个，这里给了一个可直接对照实现的参考。

### 5.6 ★★ 全局快捷键：`RegisterHotKey` 优先，hook 兜底

**文件**：`ShortcutListener.cs`（509 行），注释指明参考 **PowerToys 的 CmdPalKeyboardService**

- 先试 `RegisterHotKey`（带 `MOD_NOREPEAT`），**失败才**退到 `WH_KEYBOARD_LL`（`Id=0` 标记走 hook 路径）。这是对的顺序——`RegisterHotKey` 由 OS 分发，不吃 hook 超时，不和第三方工具打架。
- **自注入标记**：`dwExtraInfo = 0x0d000721`，hook 里先判断是不是自己发的，避免自己吃自己。
- **`SendDummyKeyUp()`**：hook 吞掉带 Win 键的组合后，注入一个 `VK 0xFF` 的 keyup，**阻止开始菜单弹出**。这就是他们 v0.3.6 修的"Shift 和 Win 键会失灵"。
- 修饰键状态**不自己维护**，每次用 `GetAsyncKeyState` 现查（PowerToys 的做法）——自己维护状态机就会在丢事件时永久错乱。

**对我们**：我们的 `pointer_input_state.ps1` 是纯轮询，没有 `RegisterHotKey` 层。侧键激活 / Space 续选这些"轻量续选"路径都能从这套结构受益。`SendDummyKeyUp` 这个技巧几乎肯定我们也会需要。

### 5.7 ★ Strategy Engine：Recipe 数据化的现成范本

**目录**：`src/Everywhere.Core/StrategyEngine/` + `docs/StrategyEngine/*.md`（7 篇中文规格文档，**建议直接读**）

管线：

```
Context Snapshot → Strategy Providers → 静态依赖分析 → 收集 extra context
  → 条件求值 → 推荐列表 → 用户选 1 个 → Preprocessors
  → prompt + system prompt override + 工具规则集 → Chat Pipeline
```

`Strategy` 的字段就是一个 Recipe 该有的样子（`Abstractions/Strategy.cs`）：
`Id / NameKey / DescriptionKey / Icon / Priority / Condition / Body / SystemPrompt / ToolPatternRulesets / Preprocessors / ArgumentHintKey`

条件系统是**可组合的对象**而不是脚本：`TextCondition{TargetType, MinLength, MinCount}` / `FileCondition` / `VisualElementCondition` / `CompositeCondition` / `NotCondition` / `GroupedCondition` / `RuntimeInformationCondition`。

他们的 v1 明确**非目标**（这份克制清单很值得学）：不支持用户脚本、不支持一次发送组合多个 Strategy、不允许覆盖内置、不自动把所有 SKILL.md 变成 Strategy、不做完整 XPath、不做市场。

**对我们**：AGENT.md 下一步 #2 写的"Recipe 数据化 + 插件加载器（catalog.py 现在是硬编码 Python 元组，生态被物理封死）"——这就是那个设计的完整参考答案，而且是中文写的。

### 5.8 ★ 工具输出硬上限 + 权限位标志

- **硬上限**：每个工具执行 `PromptTokenLimit(40000)`，FileSystem / OfficeCLI / Terminal / Web 全部套上。v0.7.8 的原话是防"**token 炸弹**"撑爆模型上下文。**这是一行代码的事，我们现在完全没有。**
- **权限位标志**（`Chat/Permissions/ChatFunctionPermissions.cs`）：`ScreenRead(1) / ScreenAccess(3=含ScreenRead) / NetworkAccess(4) / ClipboardRead(8) / ClipboardAccess(24) / FileRead(32) / FileAccess(...)`，用**位包含关系**表达"写权限自动含读权限"。`BypassApproval = FileRead` 定义了唯一可以不问就给的最小权限。
- 三档同意：本次 / 本会话 / 始终；**终端类工具永远不给"始终允许"**（v0.4.4 主动收紧）。

---

## 6. ⚠️ 法律红线（必读）

**Everywhere 从 v0.5.4（2025-12-20）起是 BSL 1.1，不是开源许可。**

```
Licensor: Sylinko Inc.
Change Date: 该版本首次公开发布后 4 年
Change License: Apache 2.0

禁止 Competing Use，定义为：
- 替代本软件的商业产品或服务
- 替代 Licensor 已有的任何基于本软件的产品或服务
- 提供相同或实质相似功能的产品或服务
```

**Magic Pointer 属于"实质相似功能"。** 所以：

| 能做 | 不能做 |
|---|---|
| 读代码、学架构、学算法思路 | 复制粘贴任何 v0.5.4 之后的代码 |
| 引用他们的**公开文档**结论（`docs/ScreenPicker` 等） | 把他们的类/文件搬进我们仓库（哪怕改了变量名） |
| 去他们**注明的上游**取用（见下） | 以 Everywhere 为基础做衍生产品 |
| checkout `v0.5.3` 及更早 tag，那部分是 Apache 2.0 | 假设"BSL 就是开源" |

**上游来源（这些才是可以直接用的）**：

| 我们想要的能力 | 他们标注的上游 | 建议 |
|---|---|---|
| 全局划词检测 | `github.com/0xfullex/selection-hook` | **直接去读/用这个**，它本身就是给 Electron 用的 Node 原生模块，比抄 C# 顺得多 |
| 进程排除名单 | `CherryHQ/cherry-studio` `src/main/configs/SelectionConfig.ts` | Apache 2.0，Electron 项目，可直接参考 |
| 键盘 hook / 修饰键处理 | `microsoft/PowerToys` `CmdPalKeyboardService/KeyboardListener.cpp` | MIT |
| 技能提示词模板 | VSCode Copilot prompt template | 公开 |
| `UIA_WindowVisibilityOverridden` | **Windows API 本身的行为**，不是他们的代码 | 直接用，无版权问题 |
| DWM 缩略图 + IDCompositionVisual | `blog.adeltax.com` + 对应 gist | 技术博客 |

`selection-hook` 这条线尤其重要：**它是 Node 原生模块，我们是 Electron，可以直接 npm 装**。等于我们能用比 Everywhere 更低的成本拿到同等的划词能力。

同时把 `external/everywhere` 加进 `docs/planning/EXTERNAL_COMPONENTS.md` 的许可证矩阵，标注 **BSL 1.1 / 仅供阅读 / 禁止代码复用**。

---

## 7. 建议的行动清单

按"能验证的收益 ÷ 成本"排序。前三条不改架构，一两天内能做完，且都直接对着 `HANDOFF_20260803.md` 里的三个待修问题。

| # | 动作 | 治哪个问题 | 成本 |
|---|---|---|---|
| 1 | **1/4 屏对照实验**：拿 VSCode/Chrome 做目标，对比 overlay 半盖 vs 全盖时 `context.content` 的差异 | 确认我们是否中了 Chromium 渲染器休眠（§5.2）。一小时，可能一次解释掉一堆"感知不稳定" | 1h |
| 2 | 给 overlay + stage 窗口设 `UIA_WindowVisibilityOverridden=2`（N-API 或 `SetProp` 的 ffi 调用） | 去掉 `hideOverlay()` 再感知的等待、笔画不再消失、UIA 不再被自己污染 | 半天 |
| 3 | 所有工具/桥接输出加 40K token 硬上限 | 长会话炸上下文 | 1h |
| 4 | `selection_snapshot_bridge.py` 常驻化（复用 `voice_worker_client.js` 的 JSONL push 模式） | 「Enter 后约 5 秒气泡才出」 | 1-2 天 |
| 5 | 为 `_enrich_screen_region_context()` 加分段计时到 stderr（HANDOFF 已定的下一步） | 「提交后 30 秒 bridge_timeout」 | 已排期 |
| 6 | 把 §5.3 的失败模式（UAC 摘钩 / 第三方 hook 冲突 / 300ms 超时 / 幽灵右键）写进 AGENT.md「不要做的事」 | 防止后来的 agent 重走 `pass_through` 老路 | 30min |
| 7 | 引入 `selection-hook`（npm）做全局划词，补上"选中即感知"入口 | 补一个完整缺失的入口能力 | 2-3 天 |
| 8 | Recipe 数据化，照 `docs/StrategyEngine/` 的 Strategy schema 设计 | AGENT.md 下一步 #2 | 1 周 |
| 9 | 子进程 JobObject 化（Python bridge / MCP / OCR worker） | 主进程崩了不留孤儿进程 | 1 天 |
| 10 | UIA 遍历改成 token 预算 + best-first（参考 §5.5 的评分与传播规则） | 上下文质量与可控性 | 1 周 |
| 11 | 写 `DATA_AND_PRIVACY.md`；调研 Electron + 全局钩子的杀软误报面 | 发布前必须处理，现在不在清单里 | 1 天 |
| 12 | 更新 `EXTERNAL_COMPONENTS.md`：everywhere = BSL 1.1，仅阅读 | 合规 | 15min |

---

## 8. 一句话回答"那我还有啥优势"

**他们证明了这条赛道成立（6.2k star、上了 ProductHunt/Trendshift、开公司做云服务），也证明了最难的两块——原位写回和跨应用连续操作——一年了还没人做出来（v0.5.8 他们把写回功能删了，v0.7.5 还在修 SetText）。**

**你的优势是形态：不可见的操作层 + 手势圈选 + 语音 + 本地 Agent 交接。这四样他们一样都没有，而且短期内不会做——因为他们已经把自己钉死在"快捷键弹聊天窗"这个形态上了。**

晚一年不是问题。**在一个别人还没赢的方向上，晚一年只是意味着你能免费读到他们一年的踩坑记录。**这份报告就是那份记录。

---

## 附录：值得精读的文件清单

**优先级 P0（今天就该读）**
- `docs/ScreenPicker/01-The-Hacky-Foundation.md` — 我们现在正在走的弯路，他们已经完整记录了终点
- `docs/ScreenPicker/04-The-Overlay-Occlusion-Problem.md` — `UIA_WindowVisibilityOverridden` + Chromium 休眠
- `src/Everywhere.Windows/Interop/ScreenSelectionSession.cs` — 双窗口拆分的实现

**P1**
- `src/Everywhere.Windows/Interop/VisualElementContext.TextSelection.cs` — 划词降级链（**读思路，代码去上游 selection-hook 取**）
- `src/Everywhere.Core/Chat/VisualContext/VisualContextBuilder.Traversal.cs` — token 预算遍历
- `src/Everywhere.Core/AI/TokenBudget.cs` — 加权公平分配
- `docs/StrategyEngine/01-Overview.md` + `02-CoreConcepts.md` + `03-MatchingSystem.md`（中文）

**P2**
- `src/Everywhere.Windows/Interop/ShortcutListener.cs` — RegisterHotKey + hook 兜底
- `src/Everywhere.Windows/Interop/LowLevelHook.cs` — 专用 STA 高优先级线程 + 消息泵
- `src/Everywhere.Core/Chat/Permissions/ChatFunctionPermissions.cs` — 权限位标志
- `src/Everywhere.Watchdog/Program.cs` — JobObject 兜底清理
- `AGENTS.md`（他们的）— 一份写得很克制的 agent 规范，可对照我们的 AGENT.md
- `docs/ScreenPicker/02` / `03` — 逆向 `ElementFromPointHelper` 的完整过程，暂时用不上但是好教材
