# Context Stack：让 Agent 读懂任何界面，包括自绘界面

日期：2026-09-24。状态：设计已定，S1–S4 在本批实现，S5 以后按顺序推进。
上位文档：`docs/design/MAGIC_POINTER_HARNESS_20260811.md` §4、§7、§8、§9。

## 0. 为什么要重新设计

现在最强的 CUA（Codex computer use、Operator、Claude computer use）走的是同一条路：每一步截一张图交给模型，由模型从像素里猜「这是什么应用、哪里能点、上面写着什么」，点完再截一张图看变化。这条路有五个根本缺陷：

1. **身份靠猜。** 模型不知道这个窗口是 Qt、Electron 还是 Flutter，不知道背后是哪个文件、哪个会话、哪个版本。
2. **内容只到可见区域。** 超出视口的聊天记录、长文档、被遮住的部分都读不到；长文档只能反复「滚动加截图」。
3. **文字是转述来的。** 像素 → 模型转述会丢字、错字、错位；原件（文件本身、DOM、数据）明明就在本机。
4. **变化靠比图。** 每步都重新看整个窗口，不知道哪里变了；动作有没有生效也要靠模型比两张图。
5. **交互状态看不见。** 光标在哪、输入法正在拼什么、焦点在哪个控件、刚才用户切过哪些窗口，截图里都没有或看不清。

Magic Pointer 跑在用户自己的机器上，操作系统、应用框架、磁盘上的原件和用户的交互都能直接读到。**截图只应是其中一层证据，而不是唯一入口。** Context Stack 把这些层同时读出来，按几何位置和身份对齐，融合成一张 SurfaceModel 交给 Agent。

「自绘界面」（微信 4.x 的 Qt、向日葵的 Flutter、游戏、部分 Electron、Skia 画布）是这条路的试金石：UIA 树几乎是空的，纯截图 CUA 在这里和普通应用一样只能猜，而 MP 仍然可以从 OS 层、原件层、交互层拿到截图给不了的东西。

## 1. 五层证据

| 层 | 读什么 | 读法（Windows） | 截图给不了的东西 |
|---|---|---|---|
| **L0 OS 身份层** | 进程、可执行文件与版本、**已加载模块（识别 UI 框架）**、GUI 线程状态（焦点 HWND、系统光标位置、菜单/拖动状态）、子窗口类、同进程弹窗、DPI | `EnumProcessModulesEx`、`FileVersionInfo`、`GetGUIThreadInfo`、`EnumChildWindows` | 精确身份和框架，决定下面各层走哪条路 |
| **L1 语义唤醒层** | 应用框架里本来有、但默认没打开的语义树 | 按框架：Chromium/Electron/WebView2 在收到 UIA 请求后建树（冷树需要重试）；Qt 5.15+ 和 Flutter 在检测到辅助技术时才建树；Java 走 Access Bridge；WPF/WinUI 本来就开 | 自绘应用的控件、文字、可执行动作 |
| **L2 原件层** | 窗口背后的**真实文件或数据**：文档路径、笔记库、项目目录、网页 URL | 标题解析 + 系统「最近使用」快捷方式（`%APPDATA%\Microsoft\Windows\Recent\*.lnk`）+ 应用自己的配置（Obsidian 的 vault 列表、VS Code 的最近工作区）+ 已有的 Office COM / 浏览器 CDP；以后加进程句柄 | 可见区域以外的全部内容、逐字准确的原文、可以直接修改的对象 |
| **L3 交互层** | 用户的手势、鼠标、键盘光标、焦点控件、选区、输入法组合串；最近几分钟的前台切换（只保留元数据） | 冻结帧手势（已有）、`GetGUIThreadInfo`、UIA `TextPattern` 选区、`SetWinEventHook` 前台/焦点事件环形缓冲 | 「用户此刻在看什么、在改什么、刚从哪里过来」 |
| **L4 像素层** | 画面本身，但**结构化**：OCR 文字块带坐标、分组成可点的视觉元素（`@v` ref），只对变化区域重新识别，滚动拼接读取视口以外的内容 | WGC 窗口捕获 + 脏区；Windows OCR；版面分组 | —（这是纯截图 CUA 唯一有的一层，这里把它变成可引用、可增量的结构） |

**融合（SurfaceModel）。** 每个节点带来源层、矩形、文字、角色、可执行动作和置信度。

- UIA 节点和 OCR 块按矩形重叠对齐：互相印证时提高置信度；UIA 只有容器名、OCR 有正文时，正文以 OCR 为准（「非空 ≠ 读到了」）。
- 原件层给出「整份内容」，像素层给出「用户看到的这一段在原件的哪里」。
- 缺口必须写明：`uia_sparse`、`ocr_pending`、`backing_unresolved`、`truncated:deadline`。模型不能把「没读到」当成「不存在」。

## 2. 和纯截图 CUA 的差别

| 能力 | 截图 CUA | Context Stack |
|---|---|---|
| 这是什么应用、什么框架 | 看图猜 | L0 模块指纹，确定 |
| 这个窗口背后是哪个文件 | 不知道 | L2 原件解析，给路径并可直接读写 |
| 视口外的内容 | 滚动加反复截图 | L2 直接读原件；L4 滚动拼接兜底 |
| 文字准确度 | 模型转述 | 原件或语义树原文 > OCR > 模型转述，逐层降级并标注来源 |
| 点哪里 | 模型报像素坐标 | UIA `@e` ref、OCR 视觉元素 `@v` ref，都能直接点；坐标只是最后兜底 |
| 动作后哪里变了 | 再截一张整图比 | WGC 脏区和 WinEvent 直接给出变化区域（S5/S6） |
| 光标、输入法、焦点、选区 | 看不清或看不到 | L3 直接读 |
| 用户刚才在做什么 | 不知道 | L3 前台时间线（元数据，内存环形缓冲） |

## 3. 性能与资源

- 空闲时零扫描，遵守母文档 §9。WinEvent 钩子是事件驱动的，只写内存环形缓冲；OCR 和截图只在观察或手势时运行。
- 每层单独设截止时间，慢的层不阻塞快的层：L0 ≤ 50ms；UIA 4s（已实现，带截断标记）；原件解析 ≤ 300ms；OCR 用热进程，冷启动时先返回其他层，并标 `ocr_pending`。
- 结果按窗口身份（HWND + PID + 进程启动时间）缓存。L0 身份在进程生命周期内不变，L2 按标题变化失效。

## 4. 边界

- **不注入目标进程，不 hook 渲染调用，不解密应用私有数据库。** 这些做法会触发微信、游戏的反作弊，也会影响稳定性。唤醒只使用框架公开的辅助功能接口。
- 系统级「屏幕阅读器在运行」标志（`SPI_SETSCREENREADER`）会改变所有应用的行为，只在用户明确开启后才设置，而且不持久化。
- 窗口标题、原件路径和时间线都受任务读取范围约束（`windowReadScope`）。未授权窗口只露出编号和进程名，与现有规则一致。
- 时间线只记录「何时、哪个进程、哪个窗口」，不记录正文、按键内容或截图，只保存在内存里，进程退出即消失。

## 5. 和 Personal Agent 的关系

Personal agent 的差异不在聊天框，而在**它比用户更快地知道用户此刻的处境**。Muse、Grok Bot 的代理跑在云端 VM 上，看不到用户自己的桌面；Vida 看得到桌面，但主要靠截图和记忆（见 `docs/research/2026-09-23-personal-agent-muse-grok-vida.md`）。

MP 的做法：任务开始时，Runtime 调用 `Context.now`，一次拿到前台应用和框架、背后的原件、焦点/光标/选区、最近切换过的授权窗口，以及当前可见的结构化内容。首轮就从「知道用户在做什么」开始，不需要先截图再猜。记忆里存的是原件引用（路径、URL、会话），不是像素；跨会话继续时回到原件重新读取，而不是依赖旧截图的转述。

## 6. 数据契约

```ts
interface SurfaceFacts {            // L0
  hwnd: number; pid: number; exe: string; product?: string; version?: string;
  framework: 'chromium' | 'electron' | 'webview2' | 'qt' | 'flutter' | 'wpf' | 'winui' | 'winforms' | 'java' | 'win32' | 'unknown';
  frameworkEvidence: string[];      // e.g. ['Qt5Core.dll', 'class Qt51514QWindowIcon']
  gui: { focusHwnd?: number; focusClass?: string; caret?: Rect; inMenu: boolean; moving: boolean };
  childClasses: string[];
}
interface BackingSource {           // L2
  kind: 'file' | 'folder' | 'url' | 'vault_note';
  path: string; via: 'title' | 'recent_lnk' | 'app_config' | 'office_com' | 'cdp';
  confidence: number; modifiedAt?: string;
}
interface VisualElement {           // L4
  ref: `@v${number}`; text: string; rect: Rect; lines: number; source: 'ocr';
  uiaRef?: string;                  // aligned UIA node when rects overlap
}
interface SurfaceModel {
  facts: SurfaceFacts; channels: string[];          // what was actually read
  elements: DesktopElement[]; visual: VisualElement[]; backing: BackingSource[];
  gaps: string[];                                   // uia_sparse | ocr_pending | backing_unresolved | truncated:*
}
```

## 7. 实施切片

| 切片 | 内容 | 验收（测试先行） |
|---|---|---|
| **S1** L0 身份与框架指纹 | 宿主新增 `surface_facts`：模块指纹、版本、GUI 线程状态、子窗口类；TS 端 `classifyFramework` 纯函数 | WPF/WinForms 夹具窗口识别正确；纯函数覆盖 Qt/Electron/Flutter/WebView2 模块组合 |
| **S2** L4 视觉元素 ref | UIA 稀疏时对窗口截图做 OCR，分组为 `@v` 元素，写进标记图和 outline；`click`/`search_ui`/`read_text` 接受 `@v` ref；OCR 冷启动不阻塞，标 `ocr_pending` | 注入 OCR 的会话：稀疏窗口产出 `@v`，按 ref 点击落在块中心，search_ui 能搜到 OCR 文字 |
| **S3** L2 原件解析 | 标题解析、Recent `.lnk`（宿主 IShellLink 解析）、Obsidian vault 配置；按标题匹配排序 | 临时文件、临时 `.lnk`、临时 vault 配置夹具，解析出正确路径并排序 |
| **S4** SurfaceModel 进入观察和 `Context.now` | `get_app_state` 带 `surface: { framework, backing, gaps, focus }`；新工具 `Context.now` 汇总前台处境，遵守读取范围 | 未授权窗口不泄露标题和路径；授权窗口给出框架、原件和缺口 |
| S5 | WGC 捕获 + 脏区：动作后只看变化区域，只对脏区重新 OCR | 脏区与实际变化一致；动作回执带变化区域 |
| S6 | WinEvent 前台/焦点时间线（内存环形缓冲） | 切换窗口后 `Context.now` 给出最近切换序列；空闲时 CPU ≈ 0 |
| S7 | 语义唤醒探针：Qt/Flutter 的辅助技术唤醒、Electron 冷树重试、用户开启后的屏幕阅读器标志 | 每个框架给出「唤醒前后元素数」的实测表 |
| S8 | 滚动拼接：用 move rect 或图像配准把多屏内容拼成一份，读取视口以外的内容 | 长列表夹具读全且不重复 |

## 8. 明确不做

- 不做 7×24 录屏，不记录键盘内容。
- 不做 DLL 注入、渲染 hook 或私有数据库解密。
- 不把 OCR 或模型转述的文字当作原件；有原件时以原件为准。
