# 安全策略

## 支持的版本

只对 GitHub Release 页面最新的 stable 版本提供安全修复。beta 通道的问题会尽快
合入下一个 stable。

| 版本 | 支持情况 |
|------|----------|
| 最新 stable | ✅ |
| 最新 beta | ✅（会随下一个 stable 合入） |
| 历史版本 | ❌ 请升级 |

## 报告漏洞

**请不要在公开 Issue 里披露安全漏洞。**

首选方式：使用 GitHub 的 [Security Advisory](https://github.com/Wang-auspicious/Magic-Pointer/security/advisories/new) 私下报告。

备用方式：发送邮件到 `security@magicpointer.dev`（若邮箱不可用，请在仓库
README 里查看最新联系方式）。邮件请包含：

1. 漏洞描述与影响范围
2. 复现步骤或最小 POC
3. 你的建议修复方向（可选）
4. 若你希望被致谢，请附上署名信息

我们承诺：

- 48 小时内确认收到
- 7 天内给出初步分析
- 90 天内发布修复或披露时间表

## 攻击面说明

Magic Pointer 会在本机运行以下敏感组件，报告漏洞时可以直接引用：

- **Electron 主进程 / 渲染进程**：`electron/main.js`、`electron/preload.js`、`electron/renderer/*`
- **Python 桥 / MCP server**：`scripts/*.py`、`app/fabric/mcp.py`
- **原生桥**：`scripts/pointer_input_state.ps1`、`scripts/office_selection_probe.vbs`、`native/macos/*.swift`
- **凭据存储**：`electron/credential_store.js`（使用 Electron `safeStorage`）
- **审计与运行现场**：`data/runtime/current-object.json`、`data/captures/`

## 我们不视为漏洞的场景

- 需要本机管理员权限才能利用
- 用户主动关闭沙箱 / 加载不受信任的第三方 Recipe / 修改本地脚本后触发的问题
- 第三方 Agent（Codex/Pi/Claude/Gemini 等）自身的漏洞，请报给相应上游

## 致谢

修复发布后，我们会在 CHANGELOG 与 GitHub Advisory 中致谢报告者（除非报告者
希望匿名）。
