# 开发与构建

## 环境

- Windows 10/11；其他平台状态见 [已知限制](KNOWN_LIMITATIONS.md)。
- Node.js 20–24、npm 10 及以上。本项目开发与集中验证使用 Node.js 24。
- 原生桌面功能依赖 Windows API；Office 原生验收需要安装对应应用。

```powershell
npm ci
npm run overlay
```

## 源码结构

| 目录 | 职责 |
|---|---|
| `electron/` | 应用生命周期、窗口、手势、IPC、工作台和渲染界面 |
| `electron/runtime/index.ts`、`agent*.ts` | 模型循环、子任务、压缩、记忆、插件和内置能力装配 |
| `electron/runtime/session.ts`、`tools.ts` | 持久会话、权限、动作调度及恢复 |
| `electron/runtime/fabric*.ts` | 动作计划、设置、任务及产物服务 |
| `electron/runtime/context*.ts` | 任务来源、定位、文档和聊天内容读取 |
| `electron/runtime/desktop*.ts` | 多来源感知、历史帧、桌面动作和应用适配 |
| `electron/runtime/actions*.ts`、`artifacts.ts` | 精确文档修改、写回和可编辑产物 |
| `scripts/` | C#/PowerShell 原生辅助程序、TypeScript 构建、诊断及验收工具 |
| `integrations/`、`native/` | 可选客户端接口、Figma 插件与原生宿主 |
| `tests/`、`data/replay_traces/` | 自动化回归与离线回放夹具 |

桌面手势先冻结画面，再融合结构化与视觉证据；任务上下文进入同一个 Runtime。
短任务与长任务共用模型循环，通过持久会话、压缩和子任务支持继续执行。
权限、坐标、目标身份和结果校验由确定性代码负责。

## 验证

```powershell
npm run verify
```

该命令执行 lint、全部 TypeScript 检查、构建和 Node 测试。
也可单独运行 `npm test`、`npm run typecheck` 和 `npm run lint`。
新增功能或修复应先给出能暴露具体问题的测试，再修改实现。
协议和夹具测试不等于真实模型、真实 Office 或 Figma 应用验收。

## 构建

```powershell
npm run dist:win
```

Windows 安装器使用 Electron 自带的 Node Runtime，不包含 Python。`electron-builder.yml`
定义编译后的 JavaScript、生产依赖与原生辅助源码清单，`package-lock.json` 固定依赖。
原生辅助程序缓存写入用户数据目录。修改入口时同步检查打包清单，避免安装版缺文件。

构建后可运行 `npm run desktop -- windows`、`npm run replay -- stats TRACE_DIRECTORY`。
`npm run measure:runtime -- --runs 1` 通过真实 worker 和当前模型测量任务耗时；会调用模型。
`npm run mcp` 启动 JSONL MCP 服务；`npm run hooks -- --apply` 显式安装外部客户端提示词钩子。

`npm run sync` 用于维护者本机交付：验证、构建、安装并重启应用，会替换本机安装版。
普通开发可使用 `npm run overlay`。

## 仓库边界

提交产品源码、必要资源、依赖锁、配置、测试与维护中的使用文档。
研究材料、第三方参考仓库、抓取的网页、个人会话、验收输出和模型权重保留本地。
`.gitignore` 定义这些排除项；实际采用的第三方组件仍须保留许可证和来源声明。
