# Magic Pointer

[![Release](https://github.com/Wang-auspicious/Magic-Pointer/actions/workflows/release.yml/badge.svg)](https://github.com/Wang-auspicious/Magic-Pointer/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](.nvmrc)
[![Python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](.python-version)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](README.md)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

Magic Pointer 是一个默认不可见的跨应用操作层。用户在任何应用里短促地左右晃动鼠标，
系统冻结指针下的 `THIS`；随后只出现一个随语音转写或文字输入逐步生长的气泡，用户说一句包含
`THIS / THAT / THESE / HERE` 的短命令即可。Magic Pointer 优先使用原生应用接口，缺少专用
连接器时把完整对象现场交给用户已经安装的 Pi、Codex、Claude、Gemini 等 Agent。

它不是聊天壳、截图问答器，也不要求开发者先替 Agent 找到几个源码文件。

## 现在能做什么

产品内有 30 个可组合 Recipe，覆盖以下高频工作：

- 把网页/PDF 选区连同来源、页码、边框和文件哈希保存成证据卡；
- Word/WPS 选区改写或翻译，预览差异后原位写回，并支持精确恢复；
- 屏幕文字 OCR、清洗和可校验剪贴板复制；
- 表格提取为 CSV、同结构多表合并、图表数据/公式交给专用能力或 Agent；
- 图片对象编辑、跨图组合、风格迁移和“给无多模态模型的视觉上下文包”；
- 海报/邮件转日历草稿并检查冲突，两地点对象生成真实地图路线；
- 食谱缩放为结构化清单，错误现场转本地任务或外部 Agent 后台任务；
- 多个文件、图片、表格或选区进行带来源的比较；
- Pi/Claude/Gemini 通过原生 turn hooks 直接收到新鲜对象；Codex/Pi 通过会话协议接管任务；
- MCP 只作为没有 hook/plugin/session API 时的通用兼容层；
- Dashboard 管理晃动、Agent、Recipe、权限、隐私、审计与诊断。

完整清单、竞品依据和验收标准见
[`PRODUCT_BLUEPRINT_20260726.md`](PRODUCT_BLUEPRINT_20260726.md)，实际使用路径见
[`docs/USER_WORKFLOWS.md`](docs/USER_WORKFLOWS.md)。

## 交互

主入口是鼠标晃动，不是快捷键。前台交互刻意只有一个气泡，不显示建议动作、麦克风键、
关闭键、发送键或 Agent 列表：

```text
短促左右晃动 3 次
  → 冻结指针下的 THIS
  → 语音模式：小圆形声纹开始听写，转写每增加一段，气泡随文字横向长大
  → 文字模式：显示最小输入气泡，打字时按内容横向长大
  → 同一个气泡显示 Processing
  → 预览高风险动作
  → 执行、读取回执，必要时撤销
```

检测器要求 250–600 ms 的水平往返、至少 3 次方向反转、足够回程比例，并在拖拽、
滚动、窗口移动和禁用应用里拒绝触发。Dashboard 可以调整灵敏度、禁用应用，并将
默认输入方式设为“语音”或“文字”；这个选择不再占用临时提示框。

语音默认走本机 OpenAI Whisper，不调用 Windows `Win+H`，因此不会弹出第二层系统听写
界面，也不会上传录音。当前安装需要本地已有 Whisper 模型缓存；没有模型时会在同一个
气泡内明确报错，不会静默联网下载。

辅助入口：

- `Ctrl + Alt + M`：无障碍备用入口；
- `Ctrl + Alt + D`：打开设置与诊断 Dashboard；
- `Ctrl + Alt + Enter`：把已收集的运行现场填入当前 Agent 输入框，不自动发送；
- `Ctrl + Alt + Shift + M`：旧原生文本选区兼容入口。

## 安装与启动

要求 Windows 10/11、Python 3.11+、Node.js 20+。macOS 原生宿主源码已经提供，但当前
Windows 开发机无法完成实机签名与权限验证。

```powershell
python -m pip install -r requirements.txt
npm install
npm run overlay
```

启动后应用安静驻留，晃动默认启用。若需要临时关闭：

```powershell
$env:MAGIC_POINTER_ENABLE_MOUSE_SHAKE="0"
npm run overlay
```

Dashboard 中会实时显示本机可用 Agent。当前连接层按 native-first 支持：

- Codex `exec --json` 和 `app-server`；
- Pi Extension hooks、JSONL RPC steer 和 JSON；
- Claude Code `UserPromptSubmit` hook 与 `stream-json`；
- Gemini CLI `BeforeAgent` hook、Extension 与 headless JSON；
- Cursor CLI、OpenCode Server/CLI、Aider；
- 只接受 argv 数组与 stdin 的通用连接器，不拼接 shell 命令。

详细接法见 [`docs/AGENT_INTEGRATION.md`](docs/AGENT_INTEGRATION.md)。

## 安全边界

- 读取、本地写入、外部发送、删除和付款是五个不同权限级别；
- 写入/发送类动作默认要求确认，付款默认拒绝；
- Operation Plan 使用本机 HMAC 签名，Renderer、hook、MCP 或 Agent 不能篡改 provider、
  参数或对象后复用授权；
- Agent handoff 使用 argv/stdin，`shell=false`，默认不提交外部消息；
- 审计只保存 Recipe、provider、状态和校验元数据，prompt、正文和截图路径默认脱敏；
- 专用能力缺失时显示 Agent fallback 或 `capability_unavailable`，不伪造成功；
- 每个成功动作必须返回校验字段；可撤销动作还返回精确 undo receipt。

## 跨平台状态

- Windows：Electron、UIA/Office/PDF、原生鼠标状态流、本地 Whisper 语音和动作执行主链；
- macOS：共享 Electron/Fabric 层与
  [`native/macos/MagicPointerHost.swift`](native/macos/MagicPointerHost.swift) 已实现；
  仍需在 Intel/Apple Silicon 实机验证 Accessibility、Screen Recording、多屏坐标、
  签名和公证；
- Linux：Fabric、MCP 与 Agent 连接层可用；系统级 pointer host 尚未实现。

## 开发验证

```powershell
npm test
python -m pytest -q --basetemp .pytest-local
python scripts/smoke_fabric.py
```

主要架构入口：

- [`app/fabric/engine.py`](app/fabric/engine.py)：规划、权限、签名和执行；
- [`app/fabric/catalog.py`](app/fabric/catalog.py)：30 个 Recipe；
- [`app/fabric/mcp.py`](app/fabric/mcp.py)：Agent 反向调用接口；
- [`electron/wiggle_detector.js`](electron/wiggle_detector.js)：晃动意图检测；
- [`electron/main.js`](electron/main.js)：Electron 生命周期、捕获和安全 IPC；
- [`scripts/local_voice_bridge.py`](scripts/local_voice_bridge.py)：无系统浮层的本地语音转写；
- [`electron/renderer/dashboard.html`](electron/renderer/dashboard.html)：控制台。

逐帧交互依据见
[`GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md`](GOOGLE_DEMO_FRAME_ANALYSIS_20260726.md)，
当前真实完成度与限制见
[`IMPLEMENTATION_STATUS_20260726.md`](IMPLEMENTATION_STATUS_20260726.md)。
