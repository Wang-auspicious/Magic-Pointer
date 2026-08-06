# OfficeCLI 嵌入 Magic Pointer 的集成评估

日期：2026-07-29
结论状态：调研与本机黑盒验证完成；未改产品代码
评估基线：OfficeCLI `1.0.143`，官方仓库 `iOfficeAI/OfficeCLI`，源码提交 `9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28`

## 一句话结论

OfficeCLI 值得成为 Magic Pointer 的一个**受控文档变换引擎**，但不适合直接替换现有 Office COM/UIA 选区适配器，也不应把其 MCP 的通用 `command` 参数或插件自动发现机制直接暴露给模型。近期最合适的是 **adapter 方案**：Magic Pointer 继续负责真实 Office 窗口选区、权限、预览、签名计划、审计和撤销；OfficeCLI 只在受限 argv、固定版本、禁用自更新、工作副本和默认原子 batch 下处理 `.docx/.xlsx/.pptx` 的离线/结构化修改。

若要随 Windows 安装包分发，技术与 Apache-2.0 许可都可行，但目前有两个发布阻断项：上游 Windows release 二进制没有 Authenticode 签名；下载校验是“二进制与 SHA256SUMS 同源”，上游源码也承认镜像整体失陷时不能防护。正式发布前应选择“从固定源码提交自行构建并签名”或要求上游提供可验证签名/证明，不应让内置二进制自行更新。

## 证据标记

- **事实**：来自当前 Magic Pointer 仓库、OfficeCLI 本机帮助、官方仓库或源码。
- **实测**：本机对 `officecli.exe 1.0.143` 的可重复黑盒测试。
- **推断/建议**：基于事实和实测给出的架构判断，不是上游承诺。

## 1. 本机与官方基线

| 项目 | 结果 | 类型 |
|---|---|---|
| 可执行文件 | `C:\Users\zjz65\AppData\Local\OfficeCLI\officecli.exe` | 实测 |
| 版本/大小 | `1.0.143` / `33,357,736` bytes | 实测 |
| 本机 SHA-256 | `d4d4c10fced307e209744cf98a56b003a6e613424fd651b08469274704afd2c6`；与 v1.0.143 官方 `officecli-win-x64.exe` 的 SHA256SUMS 相同 | 实测 |
| Windows 签名 | `Get-AuthenticodeSignature` 返回 `NotSigned` | 实测 |
| 已发现插件 | `officecli plugins list --json` 返回空数组 | 实测 |
| 运行时 | 官方项目为自包含 .NET 单文件；无需用户另装 .NET 或 Office | 事实 |
| 原生格式 | `.docx`、`.xlsx`、`.pptx` | 事实 |
| 许可证 | Apache License 2.0，并带 `NOTICE` 与第三方 notices | 事实 |
| 当前 release | 官方 GitHub release `v1.0.143`，与本机版本一致 | 事实 |

原始来源：

- [官方仓库与功能概览](https://github.com/iOfficeAI/OfficeCLI/tree/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28)
- [v1.0.143 release](https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.143)
- [v1.0.143 官方 SHA256SUMS](https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.143/SHA256SUMS)
- [自包含单文件与依赖定义](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/officecli.csproj)
- [安全政策](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/SECURITY.md)

## 2. 它能补上 Magic Pointer 的什么缺口

### 2.1 与当前项目的互补关系

当前仓库已有清晰的责任边界：

- [`app/adapters/office_adapter.py`](../../app/adapters/office_adapter.py) 已能通过 COM 读取真实 Excel 选区及 Word 选区；Word 路径还记录文档、字符范围和原文哈希。
- [`app/actions/office.py`](../../app/actions/office.py) 与 [`app/actions/history.py`](../../app/actions/history.py) 已把 Word 写入做成先预览、再核对、可精确恢复的高风险动作。
- PowerPoint 原生选区适配器目前注册但未实现。
- Fabric 已有 permission、signed operation plan、receipt 与 audit；[`docs/AGENT_INTEGRATION.md`](../AGENT_INTEGRATION.md) 明确是 native first、MCP last。

因此 OfficeCLI 的价值不是再造一套权限或真实窗口选区，而是补足：

1. Word/Excel/PPT 的统一 OOXML DOM、结构查询和批量变换；
2. Excel 图表、透视表、条件格式，PPT shape/table/chart，Word revisions/comments 等高层操作；
3. `validate`、`view issues`、HTML/PNG 预览和 `dump -> batch`；
4. 无 Office 安装时处理落盘文件；
5. 把大量 Python Office 库调用收敛成固定 JSON/argv 协议。

### 2.2 不应由 OfficeCLI 取代的部分

- **真实应用当前选区**：OfficeCLI 的 `watch` 选区来自它自己生成的浏览器预览，不是用户正在使用的 Word/Excel/PowerPoint 窗口。真实选区仍需 COM/UIA/add-in。
- **未保存内容**：OfficeCLI 读取磁盘文件；Word/Excel/PPT 窗口中尚未保存的编辑不在磁盘中。
- **权限与确认**：OfficeCLI 本身是文件工具，不理解 Magic Pointer 的对象租约、敏感应用、用户确认或签名计划。
- **产品级撤销**：原子写入只能防“半个 ZIP”，不等于保留可撤销历史。

## 3. Word / Excel / PowerPoint 能力与选择边界

| 场景 | OfficeCLI 适配度 | 关键边界 |
|---|---|---|
| Word 读取/全局查改/样式/评论/revisions | 高 | Word 段落可用 `paraId`；run、表格行列等仍有位置路径。通用修改不会自动变成 tracked change，只有明确使用 revision 能力的操作才可在 Word 内审查。 |
| Excel 单元格/公式/表/图/透视表 | 高 | 单元格以 `/Sheet/A1` 定位，插行列后含义会漂移；没有通用、持久的“修订模式”。必须由 Magic Pointer 保存前后值、公式、样式与范围哈希。 |
| PowerPoint shape/table/chart | 高 | shape 返回 `@id=` 稳定路径；slide、段落、run、表格内部节点仍可能是位置索引。真实 PowerPoint Selection 仍需 COM 映射到 shape ID。 |
| 浏览器点击/框选 | 中高 | 适合 OfficeCLI 自己的 review 预览；不是系统 Office 窗口框选，且 positional selection 没有漂移指纹。 |
| 打开中的 Office 文档原位编辑 | 低 | 文件锁、未保存状态和 Office 自身对象模型使其不适合作为第一写入路径。 |

### 3.1 稳定 ID 实测

- **实测**：新建 PPT 后，shape 返回 `/slide[1]/shape[@id=100000]`；标题 shape 返回 `@id=2`。
- **实测**：新建 Word 段落返回 `/body/p[@paraId=00100000]`。
- **事实**：OfficeCLI watch 源码明确写着 selection/mark 是位置模型，“No drift detection, no fallback lookup”。
- **推断**：Magic Pointer 不应把 OfficeCLI path 单独当作长期对象 ID。应组合 `文件规范路径 + 文件内容哈希/mtime + workbook/sheet 或 slide 关系 + OfficeCLI path + 目标内容/样式指纹`，执行前重新解析并 fail closed。

原始来源：

- [watch selection 的位置漂移说明与 Excel 选择代码](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Resources/watch-overlay.js#L278-L307)
- [Excel 单元格、范围和多选交互](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Resources/watch-overlay.js#L542-L586)

### 3.2 XLSX 选择：当前事实与局限

本机安装的 skill 文档称 XLSX 不发出 `data-path`，但这已落后于 1.0.143 源码和二进制。

- **实测**：启动 `watch probe.xlsx --port 28311` 后，向 loopback `/api/selection` 写入 `/Sheet1/A1`、`/Sheet1/B2` 得到 HTTP 204；随后 `officecli get probe.xlsx selected --json` 返回两个 cell node。
- **事实**：当前 overlay 支持单击、Shift 矩形范围、Ctrl/Cmd 多选、行列选择及 Excel 风格高亮。
- **局限**：地址是位置，不是不可变实体 ID；插行、删列、重命名 sheet 后需要重新定位。
- **局限**：框选发生在 OfficeCLI HTML 预览，不能读取真实 Excel 应用当前选区。
- **局限**：预览选择是 watch 进程内存状态；应把它视为 UI 输入，不是审计记录或持久修订。

## 4. 调用方式评估

| 调用方式 | 事实 | 对 Magic Pointer 的判断 |
|---|---|---|
| 直接 CLI | `--json`、明确退出码、argv、batch；单文件二进制 | **近期首选**。Node/Electron 用 `spawn` 的 `ArgumentList`，Python 用 list argv；禁止 shell 字符串。最容易做路径/verb/property allowlist、超时与进程回收。 |
| Resident | 自动启动短 idle resident；显式 `open` 约 12 分钟；named pipe；`save/close` flush | 仅用于 Magic Pointer 独占的工作副本。不要对正在 Office 中打开的原件常驻；崩溃和外部重命名需要额外状态机。 |
| MCP stdio | 本机可启动；只暴露一个 `officecli` tool，参数是任意 `command` 字符串/argv | **不用于核心执行**。权限粒度太粗，容易绕过 Magic Pointer recipe/签名 plan。可保留为开发者兼容入口，但必须再包一层受限工具。 |
| 进程内 .NET | 源码公开 `BatchExecutor`，协议与 CLI batch 对齐 | 中长期可研究，但 Electron/Python 主架构要增加受管 .NET host/FFI 和崩溃隔离；第一阶段收益不如 CLI adapter。 |
| OfficeCLI plugin | sidecar JSONL/stdin/stdout，三类格式插件 | 它扩展的是 OfficeCLI **文件格式**，不是 Magic Pointer 功能插件。协议仍标为 final draft 且“无 backward-compatibility goal”，不应拿来直接定义 Magic Pointer 插件生态。 |

MCP 本机实测还发现：客户端请求协议 `2025-03-26` 时，server 回应 `2024-11-05`；`tools/list` 只有一个通用 `officecli(command)`。若未来接 MCP，必须加入协议兼容测试，不能只凭“能启动”判定 READY。

原始来源：

- [MCP 是一个通用 command tool 的实现](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/McpServer.cs#L277-L305)
- [MCP tool 单参数 schema](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/McpServer.cs#L535-L563)
- [公开的进程内 BatchExecutor](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Core/BatchExecutor.cs#L7-L35)
- [官方 plugin protocol](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/plugins/plugin-protocol.md)

## 5. 文件锁、原子写入与回滚

### 5.1 默认原子 batch 已验证，但不是产品级 undo

**实测**（关闭 auto resident 的 standalone 路径）：

1. `A1=before`；记录文件 SHA-256；
2. batch 第 1 项把 A1 改为 `after`，第 2 项使用不存在的 `bogus` command；
3. 进程退出码为 1，JSON 为 `atomicRolledBack:true`；
4. batch 前后文件 SHA-256 完全一致，重新读取 A1 仍为 `before`。

**源码事实**：standalone atomic batch 在同目录工作副本上执行，全部成功后才以 `File.Replace` 覆盖原件；成功覆盖时 `destinationBackupFileName:null`，所以不会留下旧版本备份。resident 的失败 batch 会丢弃污染的内存 DOM 并从磁盘重载。

**源码事实**：resident flush 先完整写 sibling temp，再 `File.Replace`，避免进程崩溃留下截断 OOXML；但源码明确没有 `Flush(flushToDisk:true)`，所以保证是 crash-atomic，不是断电级 durability。

**结论**：

- 保持默认 atomic，禁止模型使用 `--best-effort`；只有明确的人工高级选项才能放开。
- 在成功 batch 前由 Magic Pointer 保存 preimage：小文件保留完整副本，大文件至少保存版本化工作副本/增量和哈希。
- “文件替换成功”后仍需 `validate + view issues + 目标重读 + 可视检查`，验证失败时由 Magic Pointer 用 preimage 恢复。
- 不要把 OfficeCLI atomic 宣传为用户撤销；撤销历史必须由 Magic Pointer 持有。

原始来源：

- [standalone atomic batch 的工作副本与 promote](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/CommandBuilder.Batch.cs#L421-L590)
- [resident crash-atomic writer 及非 fsync 限制](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Core/AtomicPackageWriter.cs#L7-L71)

### 5.2 文件锁实测

- **实测**：用 `FileShare.None` 独占 `probe.xlsx` 后运行 `officecli set`，退出 1；错误 code 是通用 `io_error`，不是帮助中列出的 `file_locked`。
- **事实**：OfficeCLI 自己的 resident 可避免其内部命令之间的锁冲突，但不能消除 Microsoft Office/WPS 对原件的锁，也不能看到未保存内存内容。
- **建议**：adapter 将 `io_error + sharing violation` 归一成 `document_busy`，提供“重试 / 让 Office 保存并关闭 / 编辑副本”三种明确恢复，不自动反复重试写入。

针对活跃 Office 文档，建议双轨：

1. 文本或当前选区的小改动继续用 COM 原位写回；
2. 大范围结构变换先让 COM `SaveCopyAs`/等价方式生成工作副本；
3. OfficeCLI 修改工作副本并产生差异与截图；
4. 用户确认后，由 COM 导入结果、另存为新文件，或提示关闭原件后进行受控替换。

## 6. 可审查变更设计

OfficeCLI 提供的 primitives 有价值，但不能独立完成 Magic Pointer 的审查承诺：

- `mark` 是 watch 内存中的建议标记，watch 退出即消失；它适合预览层，不适合审计真相。
- Word 可以显式创建 comments/revisions；适合“查找替换、文字修订”一类动作，但不能假设所有样式、表格、图表修改都会自动生成 Word tracked changes。
- Excel/PPT 没有统一的人类友好修订模式，应由 Magic Pointer 生成结构 diff。
- `dump -> batch` 更适合复制/重放，不应被误当作最小逆操作日志。

建议每次 Office 变换形成一份 Magic Pointer 自有 receipt：

```text
source file identity + before SHA256
selection/object locator + fingerprint
typed operations（非任意 CLI 文本）
OfficeCLI version + binary SHA256
batch result + exit code
after SHA256
validate/issues/readback/screenshot verdict
preimage/undo artifact location
user confirmation + timestamp
```

## 7. Windows 打包、分发与许可证

### 7.1 Apache-2.0 允许嵌入和再分发

**事实**：Apache-2.0 允许以 source 或 object form 复制、修改和分发，也有专利许可。随 Magic Pointer 分发时至少应：

1. 向接收者提供 Apache-2.0 LICENSE；
2. 保留 OfficeCLI 的 NOTICE；
3. 保留适用的版权、专利、商标与 attribution notices；
4. 若修改上游文件，在修改文件中显著说明变更；
5. 同时分发其第三方 notices（Open XML SDK、System.CommandLine、.NET Runtime 均列为 MIT）；
6. 不把 Apache 许可误写成对 `OfficeCLI` 商标的授权。

这不是法律意见；正式发布仍应走一次 release license review。

原始来源：

- [Apache-2.0 LICENSE，含 redistribution 条件和商标条款](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/LICENSE#L1-L203)
- [OfficeCLI NOTICE](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/NOTICE)
- [第三方 notices](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/THIRD-PARTY-NOTICES.txt)

### 7.2 推荐的 Windows 包装方式

不要调用用户 PATH 上任意 `officecli.exe` 作为默认后端。建议：

- 在 `extraResources` 中放版本化路径，例如 `officecli/1.0.143/win-x64/officecli.exe`；ARM64 使用单独 asset/installer 选择，不混用。
- release manifest 固定 `version + upstream tag/commit + asset SHA256 + built binary SHA256 + license files`。
- 设置 `OFFICECLI_SKIP_UPDATE=1`，并使用隔离 HOME/config 或显式 `autoUpdate=false`；更新只能随 Magic Pointer 发布。
- 从固定源码提交在 Magic Pointer CI 构建最可控；至少应对最终 child executable 做 Authenticode 签名，并验证签名与哈希。
- 安装/卸载测试加入 child process 启动、路径含中文/空格、受限用户、AppLocker/Defender、x64/ARM64、离线环境。
- 当前约 33.4 MB 的二进制会直接增加安装体积；无需再带 .NET runtime。

上游 Windows installer 使用版本化 URL 和 SHA256SUMS，但校验文件来自同一发布/镜像；失败时甚至允许“checksum file not available, skipping verification”。上游自更新源码也明确说明“fully compromised mirror”可同时伪造二进制与 checksum，需 pinned-key signature 才能解决。Magic Pointer 不应继承这条自动更新链。

原始来源：

- [Windows installer 的架构选择、版本 URL 与 checksum 逻辑](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/install.ps1#L1-L109)
- [Windows 安装目录和 skill 安装行为](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/install.ps1#L136-L192)
- [release workflow：Windows 未签名、生成 SHA256SUMS](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/.github/workflows/build.yml)
- [自更新供应链限制与默认开启](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Core/UpdateChecker.cs#L52-L85)
- [源码承认同源 mirror + checksum 不能防完全失陷](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Core/UpdateChecker.cs#L190-L218)

## 8. 安全边界

### 8.1 Magic Pointer adapter 的最小 allowlist

第一阶段仅开放：

- 读：`view text|outline|stats|issues`、`get`、`query`、`validate`；
- 写：经类型化 recipe 生成的 `set/add/remove/move/swap/batch`；
- 生命周期：adapter 管理的 `open/save/close`，且只对工作副本；
- 预览：`view html|screenshot`，输出固定到 adapter 创建的临时目录。

默认拒绝：

- `raw`、`raw-set`、`add-part`；
- OLE/embedded executable、外部关系/远程图片、宏相关绕行；
- `--best-effort`、任意 output path、任意 `--input` 文件；
- `install`、`skills`、`mcp register`、插件安装/发现；
- 模型生成的完整 command string；
- 跳出用户授权文件/工作目录的规范化路径与符号链接目标。

### 8.2 watch server

**事实**：watch 绑定 `IPAddress.Loopback`，并做 Host anti-DNS-rebinding 与 state-changing endpoint 的 Origin 检查。**但 Origin 缺失时允许请求，且 `/api/send`、`/api/batch` 能修改当前文档，没有会话 token。**这对普通本地预览合理，但不应被当成 Magic Pointer 的授权边界。

建议只把 watch 用作受监督预览，使用随机端口 `--port 0`、短生命周期、子进程 PID 绑定；真正执行仍通过 adapter 的 signed plan。不要设置 `OFFICECLI_WATCH_ALLOWED_HOSTS` 对局域网开放。

原始来源：

- [watch 只绑定 loopback](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Core/Watch/WatchServer.cs#L125-L143)
- [Host/Origin 检查；缺失 Origin 被允许](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Core/Watch/WatchServer.cs#L2075-L2107)

### 8.3 OfficeCLI 第三方插件不应默认继承

插件发现顺序包含环境变量、用户目录、bundled 目录和 PATH；发现时会直接执行候选程序的 `--info`。Windows 路径没有签名/发布者信任检查。protocol 文档还把 registry package signing 列为后续问题；本机 CLI 只有 `list/info/lint`，没有文档中设想的成熟 install/trust UX。

因此 Magic Pointer 若开放第三方插件，应自建更严格的契约：签名包、发布者身份、声明式 capabilities、逐项权限、固定依赖、隔离进程、资源配额、可撤销安装、更新签名与公开审计。OfficeCLI 可作为某个插件内部依赖，不能把 `~/.officecli/plugins` 目录等同于 Magic Pointer 商店。

原始来源：

- [OfficeCLI plugin 自动发现与执行 manifest](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/src/officecli/Core/Plugins/PluginRegistry.cs#L82-L132)
- [plugin protocol 仍为 final draft、无兼容目标](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/plugins/plugin-protocol.md#L1-L8)
- [package signing 仍是 open question](https://github.com/iOfficeAI/OfficeCLI/blob/9a1982d1884cf73c9f5d2bb44d1960fa0e5efb28/plugins/plugin-protocol.md#L892-L904)

## 9. 失败恢复契约

建议 adapter 固定执行状态，不把 stderr 文案直接等同于业务状态：

1. `DISCOVER`：只使用 bundled pinned binary；校验版本、SHA256、Authenticode 发布者。
2. `SNAPSHOT`：确认真实文件、是否已保存/打开；生成工作副本与 before hash。
3. `RESOLVE`：把 native selection/object 映射到 OfficeCLI path，并记录内容/样式指纹。
4. `PLAN`：只生成类型化操作；Magic Pointer 签名并显示 diff。
5. `EXECUTE`：默认 atomic batch；超时杀整个进程树；禁止 best-effort。
6. `VERIFY`：检查 exit/envelope/per-item、重新定位、`validate`、`view issues`、readback；布局相关再 screenshot。
7. `COMMIT`：用户确认后再导入/另存/替换；记录 after hash 和 receipt。
8. `RECOVER`：任何失败均保留原件；已 commit 后验证失败则用 preimage 回滚并再次验证。

建议错误归一：`binary_untrusted`、`unsupported_version`、`document_unsaved`、`document_busy`、`target_drifted`、`batch_rejected`、`atomic_rollback_confirmed`、`validation_failed`、`visual_not_verified`、`commit_conflict`、`rollback_failed`。上游原始 code 和 stderr 作为 evidence 附在 receipt，不直接显示给普通用户。

## 10. Build / Buy / Adapter / 插件四种选项

| 选项 | 做法 | 优点 | 主要成本/风险 | 判断 |
|---|---|---|---|---|
| Build | fork/固定源码，自行构建 .NET 单文件，必要时裁剪命令并签名 | 供应链、权限面、更新节奏最可控；可加专用 API | 长期跟进上游、Office 格式回归、.NET 构建与签名维护 | 中长期备选；若上游签名问题不解决，可转此路 |
| Buy | 向上游购买 SLA/签名构建/企业支持，或采购成熟商业文档 SDK | 把兼容性与支持责任合同化 | 本次一手资料未找到公开企业 SLA 或再分发支持方案；价格与承诺未知 | 当前阻断；只有拿到书面 SLA、签名和安全响应承诺后再评估 |
| Adapter | Magic Pointer bundle 固定 OfficeCLI，外包成受限 typed adapter，在工作副本运行 | 最快复用能力，又保留现有权限、审计、COM 选区和撤销架构 | 需做映射、工作副本、验证、供应链和安装测试 | **推荐主方案** |
| 插件 | 先把 OfficeCLI 做成可选 Magic Pointer provider/plugin；未来开放第三方插件商店 | 可渐进试用、可替换引擎，符合生态方向 | 插件信任、签名、权限、升级、沙箱是独立大工程；不能照搬 OfficeCLI plugin discovery | 推荐作为第二阶段产品化形态，不作为第一阶段执行内核 |

## 11. 推荐分阶段方案

### Phase 0：只读与工作副本 spike

- bundle 或开发环境固定 1.0.143，关闭自更新；记录 binary hash。
- 实现只读 typed adapter：`inspect/get/query/validate/render`。
- 对 repo 中自建 fixture 和用户复制件测试，不触碰活跃 Office 原件。
- 建立 Word/Excel/PPT 的 golden corpus 与 Office 打开回归。

### Phase 1：受控变换 MVP

- 开放少量高价值 recipe：Excel 范围值/公式写入与表格生成、PPT 选定 shape 的文字/颜色/位置、Word 明确范围的替换/评论。
- 所有写入走工作副本、atomic batch、preimage、Magic Pointer diff/confirm/receipt。
- Excel/Word 活跃选区继续使用现有 COM；补 PowerPoint COM `ShapeRange` 与 shape ID 捕获。
- 锁冲突只提供可解释恢复，不静默切换到原件写入。

### Phase 2：审查与真实 Office 往返

- 加结构 diff：值/公式/样式、shape 属性、Word revisions/comments。
- 实现 `SaveCopyAs -> OfficeCLI -> preview -> COM import/replace` 的往返协议。
- 大文件性能、resident 生命周期、崩溃恢复、并发编辑与漂移测试达标后，才允许后台批处理。

### Phase 3：插件生态

- 把 OfficeCLI adapter 封装为 Magic Pointer 官方插件，验证插件 API 能覆盖真实 provider。
- 再开放第三方 SDK/商店；先签名、capability manifest、权限与审查，再谈下载量和生态。
- OfficeCLI 的格式插件可被官方 adapter 选择性代理，但必须重新经过 Magic Pointer trust store，不直接自动发现。

## 12. 发布前阻断项

1. **Windows child binary 信任**：上游 release 未 Authenticode 签名；需自建并签名或取得可验证上游签名/attestation。
2. **自更新关闭与版本锁**：必须证明 packaged app 不访问更新端点、不替换内置 binary。
3. **活跃文档协议**：未保存内容、文件锁、COM SaveCopyAs、用户关闭/重开流程没有端到端定义前，不得宣称“原位编辑任意 Office 文档”。
4. **定位漂移**：XLSX 地址、Word run/table、PPT 内部 positional path 必须有 fingerprint + precondition，漂移时 fail closed。
5. **持久审查/撤销**：marks 非持久；Excel/PPT 无通用 revisions。必须由 Magic Pointer 保存 preimage、diff、receipt 和 undo。
6. **安全面**：禁止 raw/OLE/外部关系、任意 CLI/MCP、用户 PATH binary 与 OfficeCLI 自动插件发现，直到独立威胁模型通过。
7. **兼容语料**：需覆盖中文/英文、复杂样式、批注/修订、图表/透视表、外链、受保护/加密、超大文件、损坏文件、WPS 与 Microsoft Office round-trip。
8. **打包矩阵**：x64/ARM64、中文和空格路径、NSIS 安装/升级/卸载、离线、标准用户、Defender/AppLocker、child process cleanup。
9. **MCP 兼容**：若保留 MCP，只能作为受限兼容面；需明确支持的 protocol version 和 capability tests。
10. **商业支持选择**：若依赖上游 SLA，需先获得书面安全响应、发布签名、兼容周期和再分发支持条款。

## 最终建议

批准 OfficeCLI 进入 **Phase 0/1 adapter spike**，不批准“直接把 officecli/MCP 接给模型”或“立即把它当插件商店底座”。产品叙事应是：Magic Pointer 负责指哪儿、确认什么、为什么改、怎么审查和怎么恢复；OfficeCLI 只是其中一个可替换、被约束的本地 Office 文件引擎。
