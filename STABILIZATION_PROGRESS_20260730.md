# Magic Pointer 稳定化进度 — 2026-07-30

这份记录只写已复现、已验证的事实。建议不等于结论，代码存在也不等于产品可用。

## 本轮已修

- 启动时不显示顶部胶囊；Stage 在用户完成划线前保持隐藏。
- 晃动唤醒后立即取得全屏输入，允许用户在 180 ms 视觉缓冲内提前按住左键；整条轨迹不会再被吞掉。
- 松开左键后才显示语音胶囊，锚点来自真实 release point。
- 手势启动时冻结一份运行参数。设置保存会取消旧 lease，下一次唤醒使用新线型/宽度，不再出现“界面新值、运行旧值”。
- 旧设置文件会被规范化并原子回写；默认线型为 `demo6_band`，默认宽度为 `22 DIP`。
- 全局中文字体改为 Codex/Windows 同系：
  `Segoe UI Variable Text` → `Segoe UI` → `Microsoft YaHei UI`。
- Windows PowerShell 5 / Python 边界：
  - JSON stdin 允许 UTF-8 BOM；
  - Python 子进程 stderr 不再被 PowerShell 提前截断；
  - Base64 传递多行 Python probe；
  - 修正 bootstrap 后的 `sys.argv` 偏移；
  - Python runtime 临时目录缩短，避开 Torch 深路径的 Win32 路径上限；
  - manifest 使用兼容 PowerShell 5 的无 BOM UTF-8 写法。
- 增加 NSIS 安装包、桌面/开始菜单快捷方式、托盘退出、GitHub 更新 feed、下载前确认、下载进度、重启安装。

## 真实产品验收

### 手势

证据：
`data/runtime/gesture-activation-wiggle-text-early-hold-20260729/evidence.json`

- `armedChangedRatio = 0`
- `topLeftGhostChangedRatio = 0`
- `stageVisibleBeforeDrawing = false`
- 正常拖线 `releaseToCapsuleMs = 120`
- 180 ms 缓冲内提前按住左键 `releaseToCapsuleMs = 129`
- 默认样式日志：`demo6_band width_dip=22`

### 打包程序

产物（不入 Git）：

- `release/Magic-Pointer-1.0.0-setup.exe`：337.8 MiB
- `release/latest.yml`
- `release/Magic-Pointer-1.0.0-setup.exe.blockmap`

`npm run verify:package` 已验证：

- 安装包内 Python 来自 `resources/python-runtime/python.exe`；
- PIL、PyMuPDF、OpenAI、ONNX Runtime、RapidOCR、sounddevice、Whisper、Torch、OpenCC 均由捆绑解释器真实 import；
- Fabric smoke：30 recipes、11 MCP tools、4 个已安装 Agent provider；
- 安装版 EXE 图标、版本、独立 Chromium profile、启动日志和进程清理通过。

真实安装闭环：

1. 静默安装成功；
2. 桌面与开始菜单快捷方式均指向
   `%LOCALAPPDATA%\Programs\Magic Pointer\Magic Pointer.exe`；
3. 安装版使用 `--background` 启动成功；
4. 启动日志未出现 capsule show；
5. 静默卸载后 EXE、卸载注册项、桌面/开始菜单快捷方式均消失。

上述闭环已固化为 `npm run verify:installer`，使用隔离用户数据目录，且检测到
已有用户安装时会拒绝覆盖。CI 的发布顺序为：构建一次 → 验证解包产物 →
真实安装/启动/卸载验证 → 仅在 `v*` 标签上发布同一批已验证的 EXE、
`latest.yml` 与 blockmap；不再由 electron-builder 边构建边提前发布。

### Agent

通过 Magic Pointer 自己的 `agent_bridge.py` 发送只读最小探针：

| Provider | 真实终态 | 证据 |
|---|---|---|
| Codex | succeeded | 精确输出 `MAGIC_POINTER_AGENT_OK`，`turn.completed`，exit 0；WebSocket 超时后由 CLI 回退 HTTPS |
| Claude Code | succeeded | 精确输出，`result/success/end_turn`，exit 0 |
| Pi | failed | CLI 明确报告未登录/没有 API key |
| Gemini CLI | failed | CLI exit 41，明确报告未配置 Auth method |

失败项没有被映射成成功。

### N17–N18 当前桌面证据

- `data/runtime/n17-current-20260730-024609/focus-evidence.json`：快捷键语音从
  `wake → dictation_start → loading → ready` 的前台 HWND 始终为 `1312752`。
- `data/runtime/gesture-activation-wiggle-voice-20260729/evidence.json`：真实三摆
  唤醒、按住左键划线、松开显示语音胶囊通过；绘制、释放、胶囊五个采样点
  的前台 HWND 均为来源浏览器；释放到胶囊 `94 ms`。
- `data/runtime/gesture-activation-wiggle-voice-early-hold-20260729/evidence.json`：
  在 180 ms 视觉缓冲内提前按住左键也通过；无顶部幽灵条，释放到胶囊
  `99 ms`，前台 HWND 不变。
- 真实视觉验证器现在把前台 HWND 稳定作为失败条件，不再只验证“看起来出现了”。
- 启动时不再让 Torch/Whisper 与 Stage/Overlay 冷加载抢资源；两个渲染器都
  ready 后才启动常驻语音预热。延迟预热若撞上真实录音会直接跳过，不向活动
  worker 注入 `load`。
- N19 配置组合回归：`hotkey + push_to_talk` 现在保持指针流
  `polling=true / wiggle=false / mouseButton=false`；同一环境切回 `auto`
  后为 `polling=false`。语音触发监听与晃动唤醒不再错误地绑在同一个开关上。

## 对外部技术审查的核验

| 建议 | 结论 | 处理 |
|---|---|---|
| 多桥存在默认编码问题 | 部分成立 | 找到 PowerShell BOM 与 stderr 截断两个真实问题，已用回归测试修复 |
| Stage/Anchor 存在竞态 | 成立，但建议方案不对 | 用 RendererReadiness、gesture lease、冻结 runtime contract 修复；未采用 `setTimeout(0)` 猜时序 |
| Voice/Snapshot 阻塞主线程 | 未证实 | Voice 已是常驻 worker + 行流式输出；snapshot 是有限单请求。保留实测，不做无依据 asyncio 重写 |
| Engine 内存/连接泄漏 | 未证实 | Engine 按调用构造，无常驻连接循环；不加入掩盖问题的 `gc.collect()` |
| 全部迁移 Web Worker 可提速 30–60% | 缺乏证据 | DOM/窗口/Canvas 所有权不能直接搬；当前使用 rAF 与 coalesced pointer events，以逐帧和延迟证据为准 |
| ThreadPool、CRDT、Merkle 重写 | 当前不合理 | 没有漂移/吞吐基准支持，拒绝用高复杂度替代已验证状态机 |

## 仍未宣称完成

- 安装包 337.8 MiB 仍偏大；需在不牺牲离线语音的前提下拆分/裁剪模型运行时。
- 自动更新代码与元数据已具备；必须在真实 GitHub Release 上再验下载、校验、重启升级。
- 正式发布需要 Windows 代码签名证书，当前本地构建未做可信发布签名。
- Pi/Gemini 需要用户完成各自登录后复验。
- 真实麦克风的“晃动→划线→语音→外部写回”仍需人在本机说话完成最终走查。
- macOS 权限、签名、公证和多屏尚未验收。
