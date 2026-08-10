# 参考项目实现思路全解（供架构讨论与能力接入）

> 用途：把 Magic Pointer 调研过的所有成熟参考项目——它们的实现思路、底层机制、可借鉴点——完整摆出来。**不含"应该怎么用"的建议**，看过的人自己判断哪些能迁移。
> 日期：2026-08-10。本地代码位置：`external/`（31 个克隆）、`docs/CLICKY.md`、`Vida.md`、`docs/archive/planning/*`（96 项目调研）。
> 重点详读：**Kimi Computer Use**（Windows 13 工具已实测拆解）、**OpenCLI**、**OfficeCLI**、**Clicky 生态**、**Vida**、**Everywhere**、**nemo-assistant**。

---

## 0. 总览

| 项目 | 星数 | 形态 | 本地位置 | 一句话实现思路 |
|---|---|---|---|---|
| Kimi Computer Use | 闭源运行时+开源接线 | macOS/Windows GUI 后台操作 | 已下载插件包拆解 | 薄壳插件 + 闭源 runtime + MCP 13 工具；截图/UIA 双通道观察，真实输入优先 |
| OpenCLI | 28k | 网站→CLI + Browser Use | 已克隆 | Chrome 扩展桥 + 本地 daemon + 声明式 adapter 清单 + agent skill 生态 |
| OfficeCLI | 闭源 CLI | Office 文档读写 | skill 文档 | L1 read / L2 DOM edit / L3 raw XML 三层，resident 常驻内存 |
| Clicky | 7k | macOS AI 伴侣 | external/clicky | push-to-talk + 截图 + Claude + 贝塞尔光标飞指 |
| OpenClicky | 473 | Clicky 开源版 | external/openclicky | CGEventTap 吞事件 + Computer Use 坐标链 |
| Clacky | 开源 | Windows Clicky fork | external/clacky | 正则快路径路由 + [POINT] 流式 tour + 后台 Hermes |
| clicky-windows | 开源 | PyQt6 Windows 版 | external/clicky-windows | UIA 5ms→OCR 300ms→Vision 1-3s 三级定位 |
| Vida | 闭源 | macOS 主动桌面助手 | Vida.md 拆解 | 无障碍树→可查询记忆管线（Einsia/OpenChronicle 开源） |
| Everywhere | 6.2k | C# 桌面 agent | external/everywhere | 常驻原生 UIA 单进程 + 946 行选区降级链 + 策略引擎 |
| nemo-assistant | 93 | 选中动作条 | external/nemo-assistant | 选中→光标旁动作条→翻译/润色/原位替换；MIT 可直接抄 |
| 96 项目调研 | — | 全景 | docs/archive/planning/* | 见 §8 分组清单 |

---

## 1. Kimi Computer Use（重点详读）

**性质**：GUI 操作运行时本身是**闭源**的（macOS `KimiCU.app` / Windows `kimi-cu.exe`），但 Kimi Code CLI（开源，MoonshotAI/kimi-code，11k★）开源了**完整的接入编排层**，且官方插件包（`kimi-cu-plugin.zip` / `kimi-cu-win-plugin.zip`）可公开下载——**工具清单、SKILL.md 工作流、安装编排全部可读**。这就是下面拆解的依据。

### 1.1 整体架构：薄壳插件 + 闭源 runtime + MCP

```
Kimi Code CLI（开源，TS）
  └─ capability/entries/kimiCu.ts   ← 检测-安装-接线编排（开源）
       ├─ 插件层：kimi-cu-plugin.zip（wiring：skills + MCP 声明，公开下载）
       │    └─ bin/kimi-cu-mcp（sh wrapper → exec KimiCU.app/.../kimi-cu mcp）
       ├─ 运行时层：KimiCU.app（macOS 签名）/ kimi-cu.exe（Windows 签名，闭源）
       └─ 权限模型：权限由 launchd 后台服务持有并在服务内执行；
            agent 进程本身不需要也不会有权限（xpc-ping 才是权限判定入口）
```

**编排层的五层检测**（`detect()`）：plugin（已装/启用/MCP server 全开）→ legacy-mcp（旧 mcp.json 重复注册检测与原子迁移）→ app（存在/可执行/Info.plist）→ service（launchctl service-status）→ permissions（xpc-ping 输出 `accessibility=true screenRecording=true`）。**安装幂等**：只有未满足的层重做；/Applications 不可写时走 `osascript ... with administrator privileges` 原生提权对话框；旧进程 best-effort 清理，卡死的旧二进制绝不阻塞替换。

**Windows 安装**（setup_windows.ps1）：下载 runtime zip → **SHA-256 校验 + Authenticode 签名验证**（发布证书+时间戳）→ 装到 `%LOCALAPPDATA%\KimiCU\kimi-cu.exe` → 注册当前用户登录自动启动（无控制台窗口）→ `doctor` 输出 `mcp=true helper=embedded`。**更新链路**：控制面板更新不下载远程脚本——已签名 exe 复制自身到临时目录，由副本下载固定版本 EXE 数据，校验 SHA-256 + 同证书签名，暂存并跑 doctor 成功后才替换，失败自动回滚。

### 1.2 Windows 13 个工具（用户记忆"13 个"即此）

`list_apps` / `launch_app` / `activate_window` / `get_app_state` / `click` / `type_text` / `press_key` / `scroll` / `set_value` / `perform_secondary_action` / `select_text` / `drag` / `turn_ended`

macOS 版 10 个（无 launch_app / activate_window / turn_ended——macOS 后台能力天然更强）。

### 1.3 核心状态模型：snapshot_id + 四模式观察

- **`get_app_state`** 是所有操作的状态来源，返回 `snapshot_id` + windows 列表 + 树/截图。四个模式控制上下文量：
  - `mode:"full"`：截图 + 完整 UIA 树（首次观察/需要布局+索引时）
  - `mode:"image"`：只要截图坐标（UIA 树是噪音时）
  - `mode:"ax"`：只要 UIA 树（含 indexes/roles/focused element）
  - `mode:"text"`：紧凑可见文本（`visible_text` 带行/索引/矩形/filter/max_chars/截断元数据）
- **snapshot_id 语义**：校验目标窗口身份 + 截图坐标系（窗口移动/缩放/换进程 → 后续 mutating 工具拒绝过期 snapshot_id，要求重新观察）；**不**证明视觉内容或索引仍然新鲜——内容变化只能靠工作流规则（导航/对话框/滚动/拖拽后必须重新 get_app_state）。
- **window_id vs app/pid**：window_id 永远锁定那个精确窗口，不跟随对话框；对话框出现后要用 app/pid 重新解析。
- **双目标通道**：元素 `index`（UIA 树可靠时）与截图坐标 `x/y`（树不完整时），**二选一不混用**。
- **批量执行**：同一 snapshot 上批量操作（聚焦→输入→提交），不在每步之间重复观察；不确定/敏感动作前和重要动作后重新观察验证。

### 1.4 写路径分层（Windows，最值得读的部分）

mutating 工具返回 `used_backend` 声明实际用了哪条路：

| 后端 | 用途 | 关键点 |
|---|---|---|
| `foreground_click` / `foreground_wheel` | Web/Electron/飞书/富文本 | 激活窗口 + **真实 SendInput 鼠标输入** |
| `foreground_clipboard_paste` | 文本输入 | 剪贴板 + Ctrl+V；**故意把文本留在剪贴板**（Windows 不通知粘贴完成） |
| `foreground_ctrl_a` | 文本选择/清空 | 真实焦点 + Ctrl+A |
| `uia_value` / `uia_legacy_value` / `uia_range_value` | 原生控件 | UIA Value/RangeValue 模式 |
| `uia_invoke` / `uia_toggle` / `uia_expand` / `uia_collapse` / `uia_selection_select` / `uia_scroll_pattern` / `uia_scroll_item` | 原生控件 | UIA 语义动作模式 |

**核心判断：Electron/Web/前端应用里 UIA 只用于观察（名字/值/角色/矩形），不作为写/点的主路径**——只改 UIA 值是"假成功"，前端事件不会被触发。输入所有权有互斥守卫：另一会话持有真实输入时返回 `code=computer_use_busy`，只读观察仍可用，禁止用 shell 绕过。

### 1.5 type_text 的聚焦语义（细读）

- 传 `index` 或坐标 `x/y` → 内部**真实后台鼠标点击**建立渲染层焦点——这是 Electron/Web 输入区能收到键盘输入的前提
- **不要用 `click(index)` 聚焦输入框**：click 走 AXPress 只建立 AX 焦点，渲染层未聚焦，打字会落空
- 可选 `clear`（Ctrl+A/Backspace）→ 剪贴板粘贴 → 返回 `verification` 字段：`matched` = UIA 确认文本已写入；`submit:true` 只在 matched 时发 Enter，否则 `submitted:false` + `submit_skip_reason`；`unavailable` = 粘贴路径跑了但未确认
- 非可编辑索引在清空前被拒绝

### 1.6 原生控件分工

- `set_value`：只用于真正暴露 UIA Value/RangeValue 的控件（表单/滑杆），原子 + 写后校验
- `perform_secondary_action`：只用于真实暴露语义模式的控件（invoke/expand/collapse/toggle/select/scroll_into_view）；右键菜单优先 `AXShowMenu`（原生+Electron/Web 都可靠），合成右键 `click(mouse_button:"right")` 只对原生 app 有效
- `scroll`：原生滚动区用 `scroll(index, dy)`（元素级 AX 滚动），普通页面用坐标
- `drag` 是最后手段（列表重排/删除优先 perform_secondary_action）

### 1.7 安全与可视化

- 保护窗口黑名单：终端、Codex 应用进程、密码管理器、安全提示、系统权限对话框（标题含 codex 的浏览器页面不算）
- 禁用 Win/Meta/Super 组合键
- 确认模型：当前轮明确指名动作+目标的请求即视为已确认；发送/删除/提交/上传/安装/改权限等不可逆动作只在"未被明确请求 / 目标模糊 / 计划改变"时再询问
- 截图含无关隐私只取所需部分
- **前台真实输入期间**：显示"KimiCU 正在使用电脑"状态提示 + 蓝色边缘 glow + **第二个光标**（点击穿透 overlay，不拦截真实输入），`turn_ended` 隐藏——用户看得见 agent 在操作什么

### 1.8 macOS 后台操作（设计不变量）

- 不移动真实鼠标、不切换前台（launchd 服务内后台注入 AX 事件）
- Electron/Web 文本框后台替换路径：先清空再写入；目标窗口被全覆盖时自动改走"AX 聚焦 + 编辑命令清空 + AX 直写"兜底，绝不把目标 app 拉前台
- 权限由服务持有；`kimi-cu doctor` 检查的是调用者进程（从 agent 跑必然 ❌），排障以 `xpc-ping` 为准

---

## 2. OpenCLI（jackwener/opencli，28k★）

**定位**：把任意网站变成 CLI + 在登录态 Chrome 上跑 Browser Use。对 agent 的第一读者是 **AI agent 而非人类**。

### 2.1 架构三层

```
OpenCLI CLI（Node/bun，npm 安装）
  ├─ Browser Bridge 扩展（Chrome Web Store，复用用户登录态）
  │    └─ 本地 daemon（按需自动启动）
  ├─ 内置 adapter 清单（clis/ 目录，每个站点一个文件夹）
  ├─ 声明式 registry：cli({ site, name, strategy, args, columns, func })
  └─ skill 生态：opencli-browser（驱动浏览器）/ opencli-adapter-author（写新适配器）
       / opencli-autofix / opencli-sitemap-author / smart-search
```

### 2.2 适配器机制（最核心）

- **cli-manifest.json**：站点/命令/参数/列/策略的声明式清单。字段：`site`、`name`、`description`、`access`（read/write）、`domain`、`strategy`（PUBLIC=纯 HTTP 无需浏览器 / COOKIE / INTERCEPT / UI）、`browser`、`args`（name/type/default/required/help）、`columns`（输出列）、`modulePath`、`siteSession`（persistent 等）、`defaultWindowMode`
- **adapter 代码格式**（示例 arxiv/search.js）：`import { cli, Strategy } from '@jackwener/opencli/registry'` → `cli({site, name, access, description, strategy: Strategy.PUBLIC, browser: false, args: [...], columns: [...], func: async (args) => ...})`——一个文件一个命令，注册即生效
- **三层自动化**：内置适配器（Bilibili/知乎/小红书/Reddit/HN/Twitter/12306/1688 等 100+ 站点）→ agent 用 `opencli browser` 原语任意操作页面 → adapter-author skill 引导写新适配器（recon → 字段解码 → 代码 → `opencli browser verify`）
- **CLI hub**：`opencli external register mycli` 把本地二进制（gh/docker/tg/discord/wx/notion）暴露到同一发现面；Electron 桌面应用（Cursor/Trae/Codex/ChatGPT）走 CDP 适配器
- **扩展与分发**：`opencli plugin create` + `plugin install github:user/repo`（第三方命令市场）；`adapter eject`（修改官方适配器）/`adapter reset`（还原）

### 2.3 browser 原语契约（给 agent 的协议设计）

- **Session 生命周期**：`opencli browser <session> open/state/click/type/extract/network/close`；owned session 持 tab 租约（空闲超时释放）；**`bind` 绑定用户已打开的登录页**（SSO/已登录页面），绑定失败关闭，永不关闭用户 tab；绑定后禁止 tab 级变更（new/select/close）
- **Selector-first 目标契约**：interaction 命令的 `<target>` 要么是 state/find 返回的数字 ref，要么是 CSS 选择器；`--nth` 消歧
- **每个信封返回 `matches_n` + `match_level`**（exact / stable / reidentified——CLI 已经帮你救了中度 DOM 漂移，等级告诉你该多信）
- **预算感知输出**：`state` 是预算感知快照；`get html --as json` 支持 `--depth/--children-max/--text-max`；network 先给形状预览，`--detail <key>` 再取单个 body——**不要烧上下文**
- **结构化错误**：`{error: {code, message, hint?, candidates?}}`，按 code 分支，不按消息字符串
- `--window foreground|background` 控制 owned session 开前台还是后台窗口

---

## 3. OfficeCLI

**定位**：AI 友好的 .docx/.xlsx/.pptx CLI。单二进制、零依赖、**无需安装 Office**（直接解析 OOXML）。

### 3.1 三层策略

**L1 read → L2 DOM edit → L3 raw XML**，永远优先高层：
- L1：读取（get/query/view/dump）
- L2：DOM 级编辑（add/set/remove 元素，如 `/body --type paragraph --prop text=...`）
- L3：原始 XML 兜底
- 路径寻址：`/slide[1]`、`/body` 这类元素路径 + `--type/--prop` 属性编辑

### 3.2 对 agent 友好的设计

- **Help 系统是 schema 入口**：`officecli help docx paragraph` 给出完整 schema（属性/别名/示例/readback）；`set` 动词过滤只显示可写属性；`--json` 机器可读——**"一次 help 胜过猜-错-重试循环"**
- 格式别名：word→docx、excel→xlsx、ppt→pptx；动词：add/set/get/query/remove
- **MCP 单参数契约**：整个 schema 通过一个 `command` 字符串参数透传（不是结构化对象）
- **Resident 常驻模式**：首次访问自动起 resident（60s 空闲超时）→ 文件锁冲突自动规避；显式 `open/close` 管长会话（12min）；**只在 officecli 边界外 flush**——officecli 自己的读永远看到最新编辑，`save/close` 只在别的程序要读文件前执行；`OFFICECLI_RESIDENT_FLUSH=each` 可让每次变更立即落盘

---

## 4. Clicky 生态（四个项目，本地有完整代码）

### 4.1 Clicky（macOS 原版，7k★）

**形态**：状态栏图标 + 按住 ctrl+option 说话 + 截图给 Claude + 文本流回 + ElevenLabs 语音播报 + **蓝色小三角光标沿贝塞尔弧线飞向 UI 元素**。核心理念：不是聊天窗口，是一只光标"AI 住在你的指针旁边"。

**8 个可直接借鉴的技术点**：
1. **ElementLocationDetector**（最值钱）：Claude Computer Use API 精确定位——**宽高比匹配**（不用固定 1024×768 4:3，Mac 多是 16:10 1280×800，选最近宽高比避免截图变形 X 轴偏差）；**Retina 修复**（NSBitmapImageRep 精确像素位图绕开 NSImage.lockFocus 双倍像素 bug）；**computer-use header**（`anthropic-beta: computer-use-2025-11-24` + `display_width_px/height_px` 激活像素计数训练——比普通 vision API 准得多）；**坐标变换链**（Computer Use 顶左原点 → AppKit 底左原点）
2. **OverlayWindow 每屏一窗**：`level: .screenSaver`、`ignoresMouseEvents: true`、`canJoinAllSpaces + stationary + fullScreenAuxiliary`、`canBecomeKey: false`
3. 预览截图预热（PTT 按下瞬间截图已备好，省 3-5s）
4. `[POINT:x,y]` 响应标签 + UIA snapping
5. 贝塞尔飞行动画（二次贝塞尔 + atan2 朝向）
6. Cloudflare Worker 代理 API 密钥（不把 key 放客户端）
7. 已知问题即避坑：#35（慢）、#38（要执行能力）、#44（安全）

### 4.2 OpenClicky（jasonkneen，473★）

- **CircleSelectSession.swift**：active `CGEventTap` 返回 nil 吞掉 left down/drag/up（圈选会话内），**overlay 自身保持点击穿透**——"视觉层永远透明，独立全局 tap 决定是否吞事件"的架构（与 Windows 目标一致）
- 同一 PTT hold 内持续吞按钮，新 drag 清理旧 stroke
- 技能打包（58 个 bundled skills）+ Agent Mode / Computer Use runtime

### 4.3 Clacky（Raynan00，Windows，MIT）

- **routing.py 两级路由**：本地正则快路径（`_fast_route` 零模型）→ 小模型（Haiku）工具调用分类（act/walkthrough/remember/learn_skill/background/organize/undo/chat/workspace）；共享 httpx 温连接（省 0.2-0.4s TLS 握手）
- **tour.py 整轮 tour**：inline `[POINT:x,y:label:screenN]` 紧跟描述句 → **指与音同源不会漂移**；SSE 分段流，首段先合成先播、后续段并行合成；`_snap_to_uia`（ControlFromPoint ≤30px 吸附）
- `memory_store.py` 跨会话记忆；`harness.py` 把 Hermes 作为后台研究 agent 嵌入

### 4.4 clicky-windows（Bitshank-2338，PyQt6，MIT）

- **hybrid_pointer.py 三级定位**（最接近我们问题域）：
  - UIA：~5ms，500 节点/40 深度预算，`_INTERACTIVE_TYPES` 加分，`_score_match` 模糊匹配
  - RapidOCR：~300ms
  - Vision-LLM 网格：1-3s（明确标注"least trustworthy"）
- **companion_manager.py 状态机**：IDLE→LISTENING→PROCESSING→SPEAKING（barge-in）；capture→STT→截图→**并行 web+locate**→流式 LLM→`_parse_points` 实时指点→TTS→hold 指点
- `[POINT:x,y]` 0-1000 归一坐标（`_norm/_denorm`）+ UIA snap
- 12 个模型 provider、4 STT + 3 TTS 后端
- **反模式警示**：单体重 companion_manager；无坐标真值；低置信首层阻挡更好证据的顺序回退；overlay 不能托管可拖拽气泡

---

## 5. Vida（Einsia，macOS 主动桌面助手；其管线开源为 Einsia/OpenChronicle）

### 5.1 核心论断

Vida 的"主动"不是模型能力，是**一条把无障碍树压成可查询记忆的确定性管线**——而这管线它自己 MIT 开源了（OpenChronicle，805★）。管线是 macOS-only，Windows 端他们自己也没解决。

### 5.2 产品机制（五个演示逐帧拆解）

- 全局热键唤起 → 屏幕底部居中大号胶囊输入条 → 同条 Generating（彩虹渐变左扫，提交键变停止方块）→ 右侧滑出面板**流式吐证据清单**（`✓ Reviewed latest Figma onboarding flows`、`12/16 screens finalized`…）→ 绿色完成条 → placeholder 转追问入口 → 草稿整段落进 Slack，**关键短语黄色荧光笔标出**
- **证据与判断版式分离**：等宽灰字 = 我读到的原文，黑正文 = 我的结论——等待的 12 秒在建立信任
- 提案预览渲染成结果的样子（0.3 秒能判断该不该批准）
- 追问框绑当前前台页面（切窗口 placeholder 就变）
- 进度用色带扫动，不用百分比不用转圈
- 产物写进目标应用输入框，不写"已复制到剪贴板"

### 5.3 底层（OpenChronicle）

无障碍树（macOS AX）→ 结构化记忆管线 → 可查询（时间/应用/内容）。Chromium 系窗口第一次 UIA 读必错且静默（实测挖出的 bug 类）。

---

## 6. Everywhere（Sylinko，6.2k★，BSL 1.1 禁竞品——只读思路）

最直接的竞品：快捷键→聊天窗→agent 工具循环。**框得快不等于上下文策略对**（用户圈一个投票小框，它把大范围页面交给模型，12k token 等近一分钟）。

技术要点：
- **单进程原生 UIA 常驻**：COM P/Invoke 零 IPC；`LowLevelHook.cs` 在专用高优先级 STA 线程 + 自己的消息泵
- Direct3D11 GPU 捕获
- **946 行 TextSelection.cs 降级链**：UIA 直接读 → 注入 Ctrl+C → 剪贴板兜底 → 恢复剪贴板
- token 预算 best-first UIA 遍历；40K token 每工具硬上限
- 双窗口拆分：输入窗 vs 命中测试不可见视觉窗；`UIA_WindowVisibilityOverridden=2`
- **Strategy Engine**：可组合条件 + Markdown 可编辑的策略
- SKILL.md 生态、ManagedMcpClient
- RegisterHotKey 优先 + hook 兜底；SendDummyKeyUp（挡开始菜单）
- 其 tracked bug 类（窗口生命周期 15+/热键 8/模型协议 12+/高 DPI 4/Markdown 10+）就是该品类的痛点地图

---

## 7. nemo-assistant（SevenBT，93★——"96 星相近项目"，MIT，可直接抄代码）

形态与 Magic Pointer 几乎一样：**选中 → 光标旁弹动作条 → 解释/翻译/润色/原位替换**；`Ctrl+Alt+A` 截图 RapidOCR；工具调用 + 记忆。

实现要点（README 自述）：
- **选区捕获**：UIA 直读优先，需要时注入 Ctrl+C，**完事后恢复剪贴板**（剪贴板纪律）
- 多格式深拷贝（剪贴板历史）
- 动作条 UI（即 PowerToys issue #37343「要一个 Windows 版 PopClip」的社区需求所指形态）

---

## 8. 96 项目全景（本地 16 份调研文档综合，按主题）

### 8.1 同类产品（形态/交互范式，41 个）

| 项目 | 星 | 实现思路要点 |
|---|---|---|
| Google Magic Pointer（DeepMind） | — | wiggle 唤醒、**语义对象层接地**（DOM/无障碍树毫秒级，非截图 OCR）、THIS/THAT/THESE 指示词会话语义、单气泡状态机（invisible→dot→partial→growing→Processing→result）、对象注册表（id/bbox/type/capabilities）、源→目标贝塞尔路径、120-600ms 短促动画 |
| Gemini in Chrome | — | 选区直接映射 DOM 元素（text/type/coords/interactivity 现成）——语义树不是像素 |
| Googlebook（Android） | — | AccessibilityNodeInfo 树 = 每个控件有语义节点，"真按钮而非按钮色块像素" |
| Everywhere | 6.2k | 见 §6 |
| Clicky 全家 | 7k/473/开源/开源 | 见 §4 |
| Samsung 专利 US11221823B2 | — | **referent 会话模型**：动词建一次，指示代词绑定新目标（this=指针最近/that=之前提过/these=区域），对象累积，语音挂条件（排除蓝色），统一执行累积列表 |
| Microsoft Click to Do | — | NPU Phi Silica 小模型；反面教材：模型锁定+无跨应用=结构性天花板；S33/S34 破坏旧 Win32、企业 GPO 禁用 |
| Windows App Actions / Agent Launchers | — | OS 级强类型原子动作框架；agent 注册/发现/提示词与附件传递标准化 |
| 腾讯 QClaw / Marvis | — | 负证据：定位/执行是缺口不是理解；确认要少而准（"硬垂询"反模式） |
| OpenAI Operator | — | OSWorld 38%（人 72.36%）——**让人指（200ms/0 token/100% 准）优于让模型猜** |
| PopClip / SnapRewrite / SwiftPen | — | 选中动作条需求证据；SwiftPen 需求清单：diff/预览/历史/追问/撤销/离线 |
| Pluely | 2.4k | Cluely 开源替代；GPL 只读 |
| eSearch | 6.9k | Electron 截屏+OCR+屏幕翻译；GPL 只读；同栈工程对照 |
| WritingTools | 2.4k | 系统级原位改写（不动剪贴板+Ctrl+Z 撤销）；**已证伪**（README 与代码不符） |
| ppInk / gInk | — | **保留笔迹但点击/滚轮穿透**（Pointer Mode）；Alt+Tab 自动切模式；输入矩形+透明样式 |
| ZoomIt | — | layered/per-pixel 命中；mouse-up 丢失已知坑——overlay 命中脆弱，不宜当捕获底座 |
| shapeof.ai | — | 拖拽拉长/压短结果卡片（选区拉伸把手来源） |
| 语音工具族 | — | WhisperPress（常驻模型省延迟+中文标点决定可用性）、TypeWhisper（按 app 切换引擎）、Echo（离线 PTT+拒静音幻觉）、SuperWhisper/Wispr/Handy（语音可选性证据） |
| LaTeXSnipper / PDF→MD / 截图→Excel | — | 垂直需求证据（公式/学术 PDF 结构保留/低置信格标记） |
| PromptLens / image2prompt | — | 图片→提示词稳定利基需求 |

### 8.2 感知与读取（24 个）

| 项目 | 星 | 实现思路要点 |
|---|---|---|
| selection-hook（0xfullex） | 104 | **Node 原生模块**：跨平台划词监听+全局 hook（拖拽/双击/Shift 三触发、8px/500ms/窗口移动容差）；npm 可直接装 |
| FlaUI | — | C# UIA2/UIA3 封装（元素树/边界/模式/事件） |
| pywinauto | 6.1k | Python Win32/UIA 后端；操作后属性读回 |
| OmniParser（MS） | — | 截图→可交互区域+图标标题（detector+captioner）；**许可混杂**（CC-BY-4.0/AGPL/MIT） |
| UI-TARS（字节） | 38.4k | GUI agent 模型：GROUNDING prompt、动作结构解析、**坐标归一化/反归一化**、动作空间（click/drag/type/scroll） |
| OS-Atlas | — | 13M+ GUI 元素、多 OS 数据合成 |
| OSWorld | — | 369 任务桌面基准（人 72.36%/Operator 38%/GPT-4V 12.24%）；VM E2E 回归 |
| UFO（MS） | 9.4k | GUI agent 框架（任务分解/能力编排/进度结果） |
| RapidOCR/PaddleOCR | 7.4k | 离线 OCR 多后端（ONNX/OpenVINO/MNN/TensorRT） |
| Umi-OCR | 46.4k | 离线 OCR 工程化标杆（批量/PDF/去水印页眉/多语言库） |
| wxauto | — | 微信 4.x 视口渲染（滚动即毁 UIA 对象）；媒体获取链：预览窗另存/右键复制 CF_HDROP/VideoMessage.download |
| cherry-studio | 49k | 进程黑名单/延迟读剪贴板名单/光标形状判定（AGPL 只取数据） |
| 微信媒体链 | — | CF_HDROP→CFSTR_FILEDESCRIPTOR/FILECONTENTS→CF_DIB/PNG→截图裁剪；永不伪造原路径 |
| clip-interrogator | — | 图→结构化提示（caption/CLIP 合成） |
| SenseVoice / sherpa-onnx / whisper.cpp / Parakeet | — | 本地 ASR 家族；Parakeet 无中文 |
| nut.js | — | N-API 原生模块先例（Electron 单进程原生输入/UIA） |
| DWM 缩略图/IDCompositionVisual | — | Everywhere 引用的 DWM 缩略图嵌入技法（公开博客） |

### 8.3 交互与 UI / 插件生态（9 个）

| 项目 | 星 | 实现思路要点 |
|---|---|---|
| PowerToys | 137k | RegisterHotKey 优先+hook 兜底+GetAsyncKeyState 按需+自注入标记+**SendDummyKeyUp**；Mouse Highlighter（WH_MOUSE_LL 观察+渲染/输入分离、多显示器骨架） |
| Flow.Launcher | 15.3k | **"本地文件夹=插件"** manifest 范式（recipe 数据化+插件加载器+商店） |
| kunkun | 1.3k | TS 插件 SDK（技术栈最近） |
| Obsidian | — | 社区插件 UX 基准 + Restricted Mode 默认门；"插件继承全部访问"警示 |
| lucide | — | 线性图标集 |
| ChatGPT 桌面端 | — | 设置中心 IA 模板（3 左分区/每页一卡/可搜/逐项重置） |
| dictation_support（Google） | — | WebHID 按钮状态→外部听写触发器（脚踏板/Stream Deck）作为通用 Trigger Provider |
| agent-bridge / claude-codex-collab | — | 本地 daemon 维护 Codex↔Claude 会话映射（免额外 key）；单会话限制→会话/工作区/ACK/认证要一等公民 |
| 技能生态（superpowers 143k / claude-howto 24k / oh-my-codex 19.9k / karpathy-skills 10.4k） | — | **自然语言配置文件夹就是插件生态赢家** |

### 8.4 Agent 与自动化（16 个）

| 项目 | 实现思路要点 |
|---|---|
| OpenAI Codex | 配置优先级层（CLI>trusted-project>profile>user>system>built-in）；**沙箱=技术边界 vs 审批=人边界**双层控制；app-server 会话协议 |
| Claude Code | /config 分级作用域（managed/user/project/local）+ 显式优先级；/permissions deny-first + 来源显示；配置迁移带备份回滚；CLAUDE.md 自然语言配置即产品品类 |
| HermesAgent | **worker READY 协议**（结构化 JSONL+端口+超时+清理）；健康探针（5s import/--version）替代"文件存在=健康"；**Windows tree-kill**（taskkill /T /F）；插件运行时加载器（契约校验/disposer/每插件错误边界/重入守卫）；**receipts + 已知死目标负缓存**；脱敏 debug 分享自动删除 |
| OpenHuman | 感知→单步决策→执行→稳定→验证循环（重模型不进点击循环）；步骤/快照上限；Tauri capability 契约（窗口/origin/命令白名单，key 不回 RPC）；catalogCache（内存镜像+TTL+single-flight+代数防污染+过期回退） |
| GitHub MCP server | MCP 缺仓库上下文→agent 分心；连接应默认绑定当前仓库 |
| MCP 规范 | 长任务需要标准 status/query/resume；server+client 双面；SSE/HTTP 传输 |
| Copilot Tool Search | **工具定义烧上下文+降低选择准确率**→动态加载 3-8 个能力，token 预算能力检索 |
| Open Interpreter | 高危险动作显示精确变更+快速确认；读操作不逐步打断 |
| Pi Extension SDK / agent-bridge | 插件宿主参考 |

### 8.5 记忆（1 个 + 交叉）

| 项目 | 星 | 实现思路要点 |
|---|---|---|
| Screenpipe | 20.7k | 7×24 录屏+本地检索+喂 agent；issue #5281"复用轻量 activity overlay 别做通知卡"；注意：**连续录屏作为核心产品与隐私叙事冲突**——记"画过/想要的"而非"看到的" |

### 8.6 平台基建（5 个）

Electron（透明窗+点击穿透不是安全模型；setIgnoreMouseEvents 全窗无逐像素命中）、electron-updater（差分包/通道/SHA512/状态机）、WinAppDriver（WebDriver 式 UIA 黑盒测试，仅测试机）、electron-builder/NSIS（asar 结构/签名/公证/杀软误报面——Everywhere 签名之旅就是剧本）、工程工具链（CI/CodeQL/dependabot/SBOM/Playwright-Electron E2E/minisign 发布签名）

---

## 9. external/ 本地克隆清单（31 个）与许可

| 目录 | 项目 | 许可 | 可用性 |
|---|---|---|---|
| clicky / openclicky / clacky / clicky-windows | Clicky 生态 | 作者明示随意用 | 直接抄 |
| nemo-assistant | 选中动作条 | MIT | 直接抄代码 |
| selection-hook | 划词监听 | MIT | npm 依赖 |
| flow-launcher | 插件范式 | MIT | 范式 |
| normcap | 零模型取 | 宽松 | 参考 |
| omniparser | 截图解析 | 许可混杂 | 视觉兜底 |
| rapidocr | OCR | Apache-2.0 | 已在用 |
| screenpipe | 录屏记忆 | MIT | 记忆层参考 |
| openadapt | 演示编译执行 | MIT | 零模型调用思想 |
| agent-desktop | 动作协议 | Apache-2.0 | 协议设计参考 |
| nut.js | 原生输入 | — | 单进程原生参考 |
| whisper.cpp / openai-whisper / const-me-whisper | ASR | MIT/MPL | 已在用/提速参考 |
| everywhere | 桌面 agent | BSL 1.1 | 只读思路 |
| esearch / pluely / writingtools | 各垂直 | GPL/AGPL/证伪 | 只读/除名 |
| ui-tars-desktop / ufo×4 | GUI agent | Apache-2.0/MIT | 架构参考 |
| opensre / pi / claude-vision-skill / ds-vision-skill / claude-code-vision-skill | 生态 | 各自 | 参考 |

---

## 10. 跨项目主题对照（同一问题的不同解法）

| 问题 | Kimi CU | Clicky 系 | Everywhere | OpenCLI | MP 现状 |
|---|---|---|---|---|---|
| 观察通道 | UIA 树 + 截图 + 四模式 | UIA→OCR→Vision 三级 | UIA 常驻 + D3D 捕获 | DOM selector + state 快照 | 感知级联（UIA/Office/DOM→OCR→视觉） |
| 目标表达 | index / 坐标二选一 | [POINT] 0-1000 归一 | 元素引用 | ref / CSS selector | 笔画+矩形+语义点 |
| 写回 | 真实输入优先，UIA 仅原生 | 未实现 | 未实现 | 浏览器表单 | UIA writer + COM |
| 状态新鲜度 | snapshot_id 几何校验+工作流规则 | 每步截图 | token 预算遍历 | match_level 漂移救援 | TTL + 目标租约 |
| 上下文预算 | mode 四档 | 分层截图 | 40K 硬上限 | depth/children-max/text-max | 上下文包编译器 |
| 确认模型 | 明确请求即确认，不可逆动作再问 | — | 位标记权限 | — | HMAC 签名+五级权限 |
| 安全边界 | 保护窗黑名单+禁 Meta 键 | — | JobObject | 绑定不破坏用户 tab | IPC 来源校验+敏感窗拒绝 |
| 可视性 | 二光标+glow overlay | 贝塞尔飞指 | — | 前台/后台窗口 | 扫线+高亮带 |

---

## 11. 可深挖的原始材料位置

- Kimi CU：`%TEMP%/opencode/kimi-code/packages/agent-core-v2/src/app/capability/entries/kimiCu.ts`（编排）、`kimi-cu-win-plugin/SKILL.md`（13 工具工作流全文）、`kimi-cu-plugin/SKILL.md`（macOS）、`INSTALL.md`（Windows 安装/更新/签名链路）
- OpenCLI：`%TEMP%/opencode/opencli/`（clis/ 适配器、skills/、cli-manifest.json、README.zh-CN.md）
- OfficeCLI：`C:\Users\zjz65\.claude\skills\officecli\SKILL.md`
- Clicky 系：`external/clicky`、`external/openclicky`、`external/clacky`、`external/clicky-windows` + `docs/CLICKY.md`（逐文件"抄什么"清单）
- Vida：`Vida.md`（五演示逐帧+六条可抄设计）、OpenChronicle（Einsia/OpenChronicle）
- Everywhere：`external/everywhere` + `docs/archive/planning/EVERYWHERE_ANALYSIS_20260803.md`
- 96 项目全景：`docs/archive/planning/ADJACENT_PROJECTS_SCAN_20260803.md`（23 个清单）、`docs/archive/planning/GAP_ANALYSIS_100_20260730.md`、`docs/archive/planning/COMMUNITY_DEMAND_AND_BUILD_LOG_20260726.md`
