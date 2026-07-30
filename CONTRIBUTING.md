# 贡献指南

感谢关注 Magic Pointer。本项目采用 MIT 协议开源，欢迎 PR、Issue 与讨论。

## 开发环境

- Node.js 20（见 `.nvmrc`）
- Python 3.12（见 `.python-version`）
- Windows 10/11 或 macOS 14+
- 建议编辑器：VS Code + `dbaeumer.vscode-eslint` + `esbenp.prettier-vscode` + `charliermarsh.ruff`

首次设置：

```bash
git clone https://github.com/Wang-auspicious/Magic-Pointer.git
cd Magic-Pointer
npm install
python -m pip install -r requirements.txt
pre-commit install   # 可选，本地跑 ruff / prettier / eslint
```

## 常用命令

```bash
npm run overlay        # 本地跑 Electron 主进程
npm test               # Node 侧单元 + 静态测试
python -m pytest -q    # Python 侧测试
npm run dist:win       # 构建 Windows 安装包
```

## 分支与提交

- 主分支 `main` 只接受 PR，不直接 push。
- 分支名建议 `feat/xxx`、`fix/xxx`、`docs/xxx`、`refactor/xxx`。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org)：
  - `feat: 新能力`
  - `fix: 修复 xxx`
  - `docs: 文档更新`
  - `refactor: 重构`
  - `test: 新增测试`
  - `chore: 构建/工具链`
- 一个 PR 只做一件事，控制在 400 行 diff 以内更容易被合入。

## PR checklist

- [ ] `npm test` 通过
- [ ] `python -m pytest -q` 通过
- [ ] 修改了用户可见行为时，同步更新 `CHANGELOG.md`
- [ ] 修改了 Recipe / MCP 契约时，更新 `PRODUCT_BLUEPRINT_20260726.md`
- [ ] 与安全相关时，遵守 `SECURITY.md`

## 报告 Bug

请附上：

1. 版本号（Dashboard「诊断」页可复制）
2. 平台（Windows 版本 / macOS 版本）
3. 复现步骤
4. 日志：`%LOCALAPPDATA%\Magic Pointer\logs\`（Windows）、`~/Library/Logs/Magic Pointer/`（macOS）

若涉及安全，请走 `SECURITY.md` 描述的私下渠道，不要在公开 Issue 里直接披露。

## 行为准则

见 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
