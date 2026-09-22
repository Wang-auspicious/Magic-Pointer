# 开发与构建

## 环境

- Windows 10/11；其他平台状态见 [已知限制](KNOWN_LIMITATIONS.md)。
- Node.js 20–24、npm 10 及以上；Python 3.11 及以上，本项目开发版本为 Python 3.12。
- 原生桌面功能依赖 Windows API；Office 原生验收需要安装对应应用。

```powershell
npm ci
python -m pip install -r requirements.txt -r requirements-dev.txt
npm run overlay
```

## 源码结构

| 目录 | 职责 |
|---|---|
| `electron/` | 应用生命周期、窗口、手势、IPC、工作台和渲染界面 |
| `electron/runtime/` | TS 模型请求、模型目录、文本扩写及会话读取；工具注册与调度尚未接入主循环 |
| `app/agent_runtime/` | 模型循环、工具、子任务、会话、压缩、记忆与权限 |
| `app/harness/` | 插件发现、依赖注入、服务生命周期与内置能力装配 |
| `app/fabric/` | 工具执行入口、动作计划、设置、任务及产物服务 |
| `app/context_pack/` | 任务来源、定位、文档和聊天内容读取 |
| `app/perception/`、`app/grounding/`、`app/adapters/` | 多来源感知、选区接地及应用适配 |
| `app/desktop_actions/`、`app/computer_operator/` | 桌面观察、UIA、输入和结果检查 |
| `app/actions/`、`app/artifacts/` | 文档修改、写回和可编辑产物 |
| `scripts/` | Python 桥接、原生辅助程序、构建、诊断与验收工具 |
| `integrations/`、`native/` | 可选客户端接口、Figma 插件与原生宿主 |
| `tests/`、`data/replay_traces/` | 自动化回归与离线回放夹具 |

桌面手势先冻结画面，再融合结构化与视觉证据；任务上下文进入同一个 Runtime。
短任务与长任务共用模型循环，通过持久会话、压缩和子任务支持继续执行。
权限、坐标、目标身份和结果校验由确定性代码负责。

## 验证

```powershell
npm run verify
```

该命令执行 lint、全部 TypeScript 检查、构建、Node 测试和 Python 测试。
也可单独运行 `npm test`、`npm run typecheck`、`npm run lint` 和 `npm run test:python`。
新增功能或修复应先给出能暴露具体问题的测试，再修改实现。
协议和夹具测试不等于真实模型、真实 Office 或 Figma 应用验收。

## 构建

```powershell
npm run dist:win
```

Windows 安装器包含独立 Python runtime。`electron-builder.yml` 定义运行文件清单，
`requirements.lock.txt` 用于可复现的 Python runtime 构建。
修改桥接入口时要同步检查打包清单，避免开发版可用而安装版缺文件。

`npm run sync` 用于维护者本机交付：验证、构建、安装并重启应用，会替换本机安装版。
普通开发可使用 `npm run overlay`。

## 仓库边界

提交产品源码、必要资源、依赖锁、配置、测试与维护中的使用文档。
研究材料、第三方参考仓库、抓取的网页、个人会话、验收输出和模型权重保留本地。
`.gitignore` 定义这些排除项；实际采用的第三方组件仍须保留许可证和来源声明。
