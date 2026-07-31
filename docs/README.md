# Magic Pointer 文档导航

## 根目录（必读）

| 文件 | 内容 |
|---|---|
| `README.md` | 项目介绍 + 安装 + 启动 |
| `PRODUCT_BLUEPRINT_20260726.md` | 产品蓝图：竞品、30 Recipe、交互合同、系统架构 |
| `FEATURE_INVENTORY_20260730.md` | 完整功能清单 + 竞品差距分析 |
| `CHANGELOG.md` | 版本变更记录 |
| `CONTRIBUTING.md` | 贡献指南 |
| `CODE_OF_CONDUCT.md` | 行为准则 |
| `SECURITY.md` | 安全策略 |

## `docs/planning/` — 规划、分析、交接

产品方向研究、竞品逐帧分析、实现进度记录、AI 对话交接备忘录。

## `docs/reference/` — 外部参考

- `magic pointer.pdf` — 原始参考论文
- `2307.00583v1.pdf` — 相关学术文献
- `Shaping the future...` — Google DeepMind 官方博文存档

## `demo/recordings/` — 演示截图与录屏

Google AI Pointer 公开演示的逐帧截图（演示 1-20）和 WebM 录屏（演示 7-10）。

## 项目代码

| 目录 | 内容 |
|---|---|
| `electron/` | Electron 主进程 + 渲染进程（Overlay / Stage / Dashboard / Onboarding） |
| `app/` | Python 后端：fabric 引擎 / 适配器 / 动作 / 模型 |
| `scripts/` | Python 桥接 / 语音 / MCP / 配置脚本 / `.bat` `.ps1` 启动脚本 |
| `native/` | macOS 原生宿主（Swift） |
| `integrations/` | Agent 集成配置（Pi / Claude / Gemini / Codex / Cursor） |
| `tests/` | Node + Python 测试 |
| `packaging/` | electron-builder 资源：entitlements、NSIS 脚本 |
| `build/` | 构建产物：Python runtime、wheelhouse |
| `external/` | 外部参考代码（pi, ufo-schannel, nut.js, omniparser 等） |
