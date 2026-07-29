# Magic Pointer 设置、健康诊断与扩展/权限 UX 基准

日期：2026-07-29  
范围：OpenAI Codex 桌面/CLI、Nous Hermes Agent Desktop、Anthropic Claude Code、Obsidian。只使用官方文档或本机公开源码；未读取任何认证、密钥、Cookie 或用户配置值。

## 结论先行

1. **P0：设置必须有明确作用域和可见的最终生效值。** Codex、Claude Code 都把“层级 + 优先级”当作一等概念；Magic Pointer 不能把全局、设备、应用、当前工作区的值混在一个表单里。[Codex config basics][S1]；[Claude settings][S8]
2. **P0：高风险自动化采用“双层控制”。** 将“技术边界（可访问什么）”和“是否要问（批准策略）”分开，且在每次请求中显示动作、目标、范围、原因与持续时间。[Codex sandbox][S5]；[Codex approvals][S6]
3. **P0：建立本地、可导出的健康诊断包。** 诊断必须分项、可重试、可复制，分享前做显式预览与脱敏；不能静默上传日志。[Hermes types][S17]；[Hermes gateway diagnostics][S18]
4. **P0：扩展一律先可见、后启用、可暂停、可移除。** Obsidian 的 Restricted Mode 是合适的默认门槛；但 Magic Pointer 需要比它更细的能力授权，因为其指针/屏幕控制比笔记插件风险更高。[Obsidian plugin security][S22]
5. **P0：支持可搜索、可深链、可键盘操作的设置中心。** Hermes 已实现“字段级 URL 深链 + 命令面板索引”；将同一模型用于 Magic Pointer 的设置发现与支持链接。[Hermes command palette][S19]
6. **P1：把“即时保存”限制在低风险偏好；策略、权限、扩展安装、重置使用显式 Apply/确认，并显示失败回滚。** Claude 的配置热重载值得借鉴，但它不等于“无需保存语义”。[Claude settings][S8]
7. **P1：模型/provider 选择应显示可用性、来源、成本/限制和作用域，且自定义端点与凭据分离。** Hermes 的 provider/model 合同与 Codex 的 profile 层可用作信息架构样本。[Hermes model contract][S15]；[Codex advanced config][S2]
8. **P1：更新流程要区分“检查、下载、应用、重启、版本不一致、失败恢复”。** Hermes 在更新接口中区分 GUI/backend 是否更新及 sandbox 阻断；这是比单一“更新成功”更可信的反馈。[Hermes update contract][S14]
9. **P1：可访问性不应只放一个总开关。** 至少提供键盘导航、焦点可见、减少动画、高对比、缩放、屏幕阅读器语义；Claude 的 screen-reader mode 可作最低参照。[Claude settings][S8]
10. **P2：设置迁移需要 dry-run、变更摘要、备份和回退，而不是第一次启动时静默改写。** Claude 会保留最近配置备份；该体验适合迁移 UX，不适合照搬其具体文件方案。[Claude settings][S8]

## 证据口径

- **[事实]** 为来源直接陈述或可由指定本机代码行直接验证的行为。
- **[推断]** 是面向 Magic Pointer 的产品判断，不把它表述为来源产品已具备的功能。
- “未见”只表示本次限定来源中没有找到可引用的产品能力，**不表示该产品绝对没有**。

## 1. 四产品基准

| 产品 | 设置 IA、查找与深链 | 作用域/保存/覆盖 | 模型、权限和沙箱 | 扩展、更新与诊断 | 隐私、通知、无障碍、重置/迁移 |
| --- | --- | --- | --- | --- | --- |
| **OpenAI Codex（桌面/CLI）** | [事实] IDE 可由齿轮进入 Settings 并打开 `config.toml`；CLI 与 IDE 共用配置层。[S1] [事实] 本次官方文档未见完整“设置内全文搜索”说明；不要据此假定存在。 | [事实] 优先级为 CLI/`--config`、受信任项目层（最近目录胜）、profile、用户、系统、内建默认值；不受信任项目跳过项目 config/hooks/rules。[S1] [事实] profile 是用户层上、项目与 CLI 下的差异层。[S2] | [事实] 默认网络关闭；本地以 OS 强制 sandbox（通常 workspace）和 approval policy 组合控制；sandbox 是边界，approval 决定何时询问。[S6] [事实] sandbox 继承到 `git`、包管理器、测试等 spawned commands。[S5] | [事实] 本地 Codex/桌面/IDE 可共享 MCP 配置，支持 stdio、streamable HTTP、Bearer/OAuth；skills 可独立或打包为 plugin；hooks 会在生命周期运行且非管理 hooks 须信任。[S3][S4][S7] | [事实] 云端 agent 网络需按 environment 启用并可限制域/HTTP 方法，官方明确提示 prompt injection、泄漏与恶意依赖风险。[S7] [事实] 本次来源未见面向本地客户端的诊断日志/无障碍/设置迁移完整 UX 描述。 |
| **Nous Hermes Agent Desktop** | [事实] 设置分为 configuration、providers、keys、sessions、plugins、appearance、gateway、notifications、keybinds 等文件/标签页；旧 MCP 深链会被兼容转向 Capabilities。[S13] [事实] 命令面板能跳到 `?tab=config:<section>&field=<key>`，即字段级深链与关键词索引。[S19] | [事实] 运行时 `approval_mode` 为 `manual/off/smart`，同时带 config/credential/install warning。[S16] [事实] Hermes profile 将 config、keys、memory、sessions、skills、gateway 隔离到独立 `HERMES_HOME`；行为配置在 `config.yaml`，密钥只在 `.env`。[S11] | [事实] computer-use 暴露 platform、driver、各 check、macOS Accessibility/Screen Recording 状态和 grant capability。[S16] [事实] model/provider 是 runtime 信息；模型选择合同可表达 provider、availability、authentication、pricing、capability 与自定义 endpoint/API key 的职责。[S15][S16] | [事实] MCP 具有列表、启用开关、连通性测试、目录安装和诊断；目录项包含 transport/auth/必需环境变量/是否安装和是否启用。[S17] [事实] plugins 可管理；内置/用户/pip 插件和 provider 插件有独立发现与用户覆盖规则。[S10] | [事实] desktop 可 reveal/retrieve logs；debug-share 返回 `redacted`、URL、失败项和自动删除时间。[S14][S17] [事实] 有原生通知设置、完成/请求输入/批准/失败通知；MCP 与技能并非与“设置”混在同一 tab。[S13][S20] [事实] memory status 可分 memory/user/all 重置；curator 归档而非删除技能。[S17][S10] |
| **Anthropic Claude Code** | [事实] `/config` 打开带 tab 的设置界面，且支持 `/config key=value`；`/status` 会列出加载的 settings source。[S8] [事实] 未见官方“字段级深链 URL”能力。 | [事实] scope 为 managed、user、project、local，优先级为 managed > CLI > local > project > user；permissions 是跨 scope 合并例外。[S8] [事实] 设置文件被监听，绝大多数 key（含 permissions/hooks）热重载；model/outputStyle 有会话边界。[S8] | [事实] `/permissions` 可查看所有规则及其来源；allow/deny、附加目录和 default mode 均可配置，deny 优先。CLI 有 `plan` 与跳过批准危险开关。[S9][S12] [事实] 支持 sandbox settings，且 enterprise policy 可锁定 permissions/MCP/marketplace。[S8] | [事实] MCP、plugins、subagents、hooks 均有按 scope 的位置；企业可对 MCP、hooks 和 marketplace 使用 allowlist/managed-only 限制。[S8] [事实] `claude doctor` 可检查安装、无效 managed entry 和来源字段。[S8][S12] | [事实] 自动更新可在启动/运行中检查，后台下载，并在下次启动生效；可关或手动更新。[S12] [事实] 支持 push notification；screen reader mode 以平铺文本移除装饰和动画。[S8][S12] [事实] 自动保留五个近期配置备份，支持会话数据清理期限及不写 prompt history。[S8] |
| **Obsidian** | [事实] Settings → Community plugins 提供浏览、按名称/作者/描述过滤、安装、启用、设置页、热键、禁用与卸载。[S21] [事实] 本次官方 Help 结果未见全局设置搜索/字段深链的说明。 | [事实] 每个 vault 的插件文件在 `.obsidian`；插件变更后需要 disable/enable 或命令面板 reload。[S23] [推断] 它适合作为“每项目/每 vault”对象化配置的参照，而非 agent policy 层级的完整模型。 | [事实] 默认 Restricted Mode 不执行第三方代码，关闭后插件继承 Obsidian 的访问能力；Obsidian 明确说明无法可靠地限制到单独 permission/access level。[S22] | [事实] community plugin 默认不自动更新，需要用户检查并确认更新；目录会显示安全 scorecard，官方会扫描版本并对热门/flagged 插件人工审查。[S21][S22] | [事实] Sync 可选择同步哪些文件和设置，并有 status/log、版本恢复与隐私/安全文档入口。[S24] [事实] 本次官方来源未见“插件诊断包”或完整 accessibility/settings migration 方案。 |

## 2. Magic Pointer 目标 IA 与字段映射

以下为**推断/建议**。`scope` 不等于存储位置；每个字段都要在 UI 显示“从何处继承、当前谁覆盖、何时生效”。

| Magic Pointer 设置区 | 关键字段（建议 schema） | 参照和理由 | 优先级 |
| --- | --- | --- | --- |
| **General → Workspace & scope** | `scope = global/device/app/workspace/session`；`origin`；`effectiveValue`；`restartRequired`；`lastChangedAt` | [推断] 用 Codex/Claude 的确定 precedence 把“为什么这个值生效”变成一眼可见的解释，而非隐藏的合并逻辑。[S1][S8] | P0 |
| **General → Behavior** | `enabled`、`launchAtLogin`、`pointerMode`、`motionSensitivity`、`hotkeys`、`reduceMotion`、`language` | [推断] 低风险视觉/交互偏好可即时保存；每项显示保存状态与“恢复默认”。Hermes 将 appearance、keybinds 分页的 IA 可借鉴。[S13] | P0 |
| **Automation → Actions** | `actionId`、`trigger`、`targetScope`、`dryRun`、`requiresApproval`、`approvalPolicy`、`lastRun` | [推断] 采用 Codex 的“sandbox 技术边界 + approval 人类边界”双层模型；绝不把一个“安全模式”开关同时承载二者。[S5][S6] | P0 |
| **Automation → Capability grants** | `capability`（input/screen/clipboard/filesystem/network/browser/terminal） 、`allow`、`ask`、`deny`、`scope`、`expiry`、`ruleSource` | [推断] 使用 Claude 的 allow/deny/source 可解释规则模型；默认 `ask`，`deny` 优先，支持一次/会话/工作区/永久的可撤销授予。[S8][S9] | P0 |
| **Privacy & data** | `telemetryOptIn`、`crashReportsOptIn`、`logRetentionDays`、`redactionPolicy`、`localOnly`、`shareDiagnosticsConsent` | [推断] 用 Hermes `redacted` debug-share 合同和 Claude 的保留期/历史关闭能力；每个外发动作须先展示用途、字段、目的地、到期时间。[S17][S8] | P0 |
| **Health → Readiness** | 每项 `id/status/severity/message/evidence/repairAction/retryAt`；覆盖 runtime、OS permissions、driver、network、storage、extension host | [推断] 遵循 Hermes computer-use 的“原始状态 + 可理解消息 + 独立 check”模型，不能只给红/绿灯。[S16] | P0 |
| **Health → Logs & support** | `logLevel`、`component`、`timeRange`、`exportPath`、`redactionPreview`、`diagnosticBundleId`、`autoDeleteAt` | [推断] 借鉴 Hermes reveal logs/recent logs/debug share；分享是单独 CTA，默认离线导出，不自动上传。[S14][S17] | P0 |
| **Models & providers** | `providerId`、`modelId`、`endpoint`、`credentialRef`（非明文）、`availability`、`costHint`、`scope`、`fallbackChain` | [推断] 模型选择器应区分“已配置/不可用/管理员限制/会话临时覆盖”，并显示原因；参照 Hermes model 合同与 Codex profile 层。[S15][S2] | P1 |
| **Extensions → Catalog & installed** | `extensionId`、`publisher`、`source`、`version`、`signature/reviewStatus`、`requestedCapabilities`、`enabled`、`health`、`updatePolicy` | [推断] 先显示权限摘要、来源和风险，再安装；安装后默认 disabled，首次 enable 要逐项授权。Obsidian 的 Restricted Mode 是底线，Hermes 的 MCP test/enable/catalog 是操作模型。[S22][S17] | P0 |
| **Extensions → Skills/hooks/MCP** | `kind`、`scope`、`trustState`、`entrypoint`、`event`、`timeoutMs`、`lastRun`、`lastError`、`networkTargets` | [推断] 保留三类对象的不同心智模型：skills=说明/工作流，hooks=确定性生命周期脚本，MCP=外部工具；不要用一个“插件”tab 伪装相同权限。Codex 同时支持这些不同对象。[S3][S4] | P1 |
| **Notifications** | `eventKind`、`channel`、`enabled`、`quietHours`、`actionButtons`、`test` | [推断] 支持完成、需要输入、需要批准、失败四类；批准通知的按钮必须回到带完整上下文的确认页。Hermes 已有这些事件的原生通知骨架。[S20] | P1 |
| **Accessibility** | `keyboardOnly`、`focusVisible`、`screenReaderMode`、`reducedMotion`、`contrast`、`fontScale`、`shortcutConflict` | [推断] 设置导航、批准弹窗和诊断表格都必须可键盘操作；screen-reader mode 以语义信息替代动画/装饰，参考 Claude。[S8] | P0 |
| **Updates & migration** | `channel`、`availableVersion`、`downloadState`、`applyState`、`restartState`、`migrationPlan`、`backupId`、`rollback` | [推断] 区分 app/runtime/extension 更新并显示不一致状态；迁移先 preview 再确认，保留备份与 rollback。Hermes/Claude 各提供一半证据。[S14][S8] | P1 |
| **Danger zone** | `resetSettings`、`resetPermissions`、`disableAllExtensions`、`clearLocalData`、`exportBeforeReset`、`confirmationPhrase` | [推断] 分开重置偏好、授权、扩展与数据；先列影响和可恢复性。Hermes 的 memory/user/all 分粒度重置是可借鉴的最低粒度。[S17] | P1 |

## 3. 推荐交互规则

### 保存、搜索和深链

- **[推断 | P0]** 每个可编辑字段都有 `draft → validating → saved/failed` 状态；即时保存失败必须保留输入和提供 retry，不能悄悄回退。
- **[推断 | P0]** URL/命令深链格式：`/settings?scope=workspace&section=automation&field=approvalPolicy`。打开后滚动、聚焦、短暂高亮，并在无权限时说明原因。证据是 Hermes 的字段级 tab/field 路由。[S19]
- **[推断 | P1]** 设置搜索索引字段 label、描述、同义词、当前值、来源、风险标签；结果直接深链到字段而非只到大类。Hermes 仅证明“可索引和可跳转”，字段搜索是扩展判断。[S19]
- **[推断 | P0]** scope 切换始终显示冲突与优先级堆栈，提供“编辑来源层/提升为本地覆盖/移除覆盖”。Codex 和 Claude 均证明层级系统对可预期性至关重要。[S1][S8]

### 权限与沙箱

- **[推断 | P0]** 每次批准卡片包含：动词、受影响对象、capability、环境/工作区、是否联网、命令或 API 摘要、规则命中原因、可选 duration，以及拒绝后的安全替代建议。
- **[推断 | P0]** 默认策略为最小权限：屏幕读取、输入注入、剪贴板写入、网络、文件写入、终端执行、安装扩展分别授权；不要使用 Obsidian 那种“插件继承整个 app 权限”的粗粒度模型。[S22]
- **[推断 | P1]** 规则优先级：企业/受管 deny > 用户 deny > 临时 allow；同类 allow 合并但要显示每一来源。Claude 的 managed 不可覆盖、deny 优先和来源可查是可用先例。[S8][S9]
- **[推断 | P1]** sandbox 应声明的不是“安全/不安全”，而是具体读写根、临时目录、允许的网络 destination、子进程与复制/粘贴边界；Codex 已把 sandbox 与 approval 明确拆开。[S5][S6]

### 扩展、skills、hooks 与 MCP

- **[推断 | P0]** 安装流：来源 → 版本/发布者 → 代码/安全状态 → 请求能力 → 最小 scope → 安装 → 测试 → 显式启用。任何失败应保留诊断，而非直接建议“重装”。Obsidian 的非自动插件更新、审查和受限模式，以及 Hermes 的 MCP test/enable/catalog 支持该流程。[S21][S22][S17]
- **[推断 | P1]** hooks 默认不随“下载”即运行；首次运行需要 trust + event/网络目标摘要。Codex 也要求非 managed command hooks 经审查和信任。[S4]
- **[推断 | P1]** MCP 先执行 `test`（显示 server、transport、auth 状态和暴露 tools），成功才可 enable；缺少 credential 时只显示字段名和安全输入控件，不读出已有 secret。Hermes 具有相应测试合同。[S17]

### 健康、日志、隐私和恢复

- **[推断 | P0]** 诊断首页给“可行动的首要问题”，详情再给原始 evidence；每项有 Copy、Retry、Fix、Learn more。computer-use 需要独立报告驱动安装、无障碍、屏幕录制及其来源。[S16]
- **[推断 | P0]** 日志/诊断包导出前显示脱敏清单，任何“上传支持”都需要额外确认、回传 URL 和自动删除时刻。Hermes 的 `redacted`/`auto_delete_seconds` 是较好的最低合同。[S17]
- **[推断 | P1]** 迁移页显示“旧值 → 新值 → 影响范围”，支持备份、dry run、应用、回退；不要在首次启动静默改权限。Claude 自动备份只作为“备份存在”的借鉴，不作为自动变更的授权。[S8]

## 4. 不能照搬

| 不应照搬 | 原因 | Magic Pointer 替代 |
| --- | --- | --- |
| Obsidian community plugin 的“插件继承 app 全权” | 官方明确其无法可靠做细权限；这对于屏幕、输入和自动化风险过高。[S22] | capability 级 allow/ask/deny + scope + expiry + 审计记录。 |
| Codex/Claude 的纯文件配置作为普通用户主界面 | 文件适合版本化和专家工作流，但会隐藏作用域、最终值、错误与迁移成本。[S1][S8] | GUI 是默认入口，导入/导出结构化配置供专家使用；两者共用 schema。 |
| Claude 的“多数设置热重载”作为所有值的默认 | 权限/驱动/网络边界和扩展 host 的变更有运行期副作用；无边界热加载会造成状态漂移。[S8] | 明列生效语义：即时、下次动作、重启 extension host、重启 app。 |
| Hermes 的较多工程标签页直接平移 | 其 IA 服务于 agent runtime，Magic Pointer 的核心是指针交互，过多并列页会稀释关键安全控制。[S13] | 默认展示 5 个主组：General、Automation、Privacy & permissions、Extensions、Health；高级项通过搜索和 disclosure。 |
| 一键“关闭所有批准” | Claude CLI 与 Codex 都将绕过批准视为危险/明确控制；把它做成普通 toggle 会误导用户。[S6][S12] | 只提供有时效、醒目状态条、明确 scope 的“临时高级模式”，并要求二次确认。 |
| 自动上传诊断/遥测 | Hermes 的共享合同仍表明必须有脱敏与保留信息；桌面指针数据可能包含更敏感的屏幕上下文。[S17] | 默认本地；上传为显式、可预览、可撤销、限时。 |

## 5. P0/P1/P2 交付顺序

### P0 — 先建立可控性

1. 四作用域与 precedence inspector；字段级深链/搜索结果。
2. capability 级权限 + 每次批准卡片 + deny 优先 + 到期时间。
3. Health 首页、分项 probes、日志浏览/离线导出、脱敏预览。
4. Extensions 的 Restricted Mode、安装前风险摘要、禁用/移除、失败诊断。
5. 无障碍基础：全键盘、焦点、语义标签、减少动画、高对比/字体缩放。

### P1 — 形成可维护生态

1. provider/model 与 fallback 选择器，凭据引用而非明文。
2. skills/hooks/MCP 分模型管理，MCP test→enable、hook trust。
3. 原生通知偏好与“需要批准/输入/失败/完成”四类事件。
4. 更新状态机、版本不一致提示、迁移 preview/backup/rollback。
5. 支持包上传与自动删除，但只在显式同意后。

### P2 — 企业与高级用户

1. Managed policy、可审计的管理员覆盖、团队预设。
2. 可版本化的 workspace config 导入/导出与冲突合并 UI。
3. policy simulation（“此动作会命中哪条规则”）和扩展来源签名/审查信号。
4. 批量诊断/远程支持工作流。

## Sources

### OpenAI 官方文档

- **[S1]** [Codex — Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)（configuration locations、shared IDE/CLI layers、trusted-project gate、precedence，页面行 747–769）。
- **[S2]** [Codex — Advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)（profiles and their overlay order，页面行 750–763）。
- **[S3]** [Codex — MCP](https://learn.chatgpt.com/docs/extend/mcp)（desktop/CLI/IDE shared config、transport/auth，页面行 749–763）。
- **[S4]** [Codex — Hooks](https://learn.chatgpt.com/docs/hooks)（lifecycle events、concurrent execution、trust，页面行 753–778）。
- **[S5]** [Codex — Sandbox](https://learn.chatgpt.com/docs/sandboxing)（sandbox vs approval、spawned commands，页面行 753–761）。
- **[S6]** [Codex — Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)（default network-off、OS sandbox、approval distinction，页面行 751–764）。
- **[S7]** [Codex — Agent internet access](https://learn.chatgpt.com/docs/cloud/internet-access)（per-environment enablement、domain/method limit、risk list，页面行 752–762）；[Codex — Build skills](https://learn.chatgpt.com/docs/build-skills)（skills/plugins distribution and progressive disclosure，页面行 753–760）。

### Anthropic 官方文档

- **[S8]** [Claude Code settings](https://code.claude.com/docs/en/settings)（`/config`、scopes、precedence、storage、hot reload、managed policy、accessibility、backup and retention；页面行 83–302）。
- **[S9]** [Claude Code IAM / permissions](https://code.claude.com/docs/en/iam)（`/permissions`、allow/deny、permission modes；官方页面）。
- **[S12]** [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)（allowed/disallowed tools、model、permission mode、dangerous skip）；[Claude Code getting started](https://docs.anthropic.com/en/docs/claude-code/getting-started)（auto update behavior and `claude doctor`）。

### Hermes 本机公开源码（只读）

- **[S10]** [`D:\AI_Agents\HermesAgent\AGENTS.md:735`](D:/AI_Agents/HermesAgent/AGENTS.md:735)（plugins discovery/hooks/provider override）和 [`AGENTS.md:853`](D:/AI_Agents/HermesAgent/AGENTS.md:853)（skills/optional skills）；[`AGENTS.md:1017`](D:/AI_Agents/HermesAgent/AGENTS.md:1017)（curator archives rather than deletes）。
- **[S11]** [`D:\AI_Agents\HermesAgent\AGENTS.md:272`](D:/AI_Agents/HermesAgent/AGENTS.md:272)（config vs `.env` and logs）和 [`AGENTS.md:1160`](D:/AI_Agents/HermesAgent/AGENTS.md:1160)（isolated profiles）。
- **[S13]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\app\settings\index.tsx:51`](D:/AI_Agents/HermesAgent/apps/desktop/src/app/settings/index.tsx:51)（settings tabs）和 [`index.tsx:62`](D:/AI_Agents/HermesAgent/apps/desktop/src/app/settings/index.tsx:62)（MCP deep-link compatibility/move）。
- **[S14]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\global.d.ts:106`](D:/AI_Agents/HermesAgent/apps/desktop/src/global.d.ts:106)（log reveal/recent logs）及 [`global.d.ts:323`](D:/AI_Agents/HermesAgent/apps/desktop/src/global.d.ts:323)（update outcomes and recovery）。
- **[S15]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\types\hermes.ts:247`](D:/AI_Agents/HermesAgent/apps/desktop/src/types/hermes.ts:247)（provider availability/auth/cost/capability contract）及 [`types\hermes.ts:890`](D:/AI_Agents/HermesAgent/apps/desktop/src/types/hermes.ts:890)（model assignment custom endpoint/key scope）。
- **[S16]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\types\hermes.ts:396`](D:/AI_Agents/HermesAgent/apps/desktop/src/types/hermes.ts:396)（runtime approval mode/warnings）及 [`types\hermes.ts:721`](D:/AI_Agents/HermesAgent/apps/desktop/src/types/hermes.ts:721)（computer-use readiness/OS permissions）。
- **[S17]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\types\hermes.ts:990`](D:/AI_Agents/HermesAgent/apps/desktop/src/types/hermes.ts:990)（MCP list/test/catalog diagnostics）、[`types\hermes.ts:1033`](D:/AI_Agents/HermesAgent/apps/desktop/src/types/hermes.ts:1033)（memory reset scope）、[`types\hermes.ts:1051`](D:/AI_Agents/HermesAgent/apps/desktop/src/types/hermes.ts:1051)（redacted debug share/autodelete）。
- **[S18]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\app\settings\gateway-settings.tsx:1076`](D:/AI_Agents/HermesAgent/apps/desktop/src/app/settings/gateway-settings.tsx:1076)（diagnostics UI exposes logs）。
- **[S19]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\app\command-palette\index.tsx:555`](D:/AI_Agents/HermesAgent/apps/desktop/src/app/command-palette/index.tsx:555) 与 [`index.tsx:705`](D:/AI_Agents/HermesAgent/apps/desktop/src/app/command-palette/index.tsx:705)（settings/field keyword index and deep-link routes）。
- **[S20]** [`D:\AI_Agents\HermesAgent\apps\desktop\src\app\session\hooks\use-message-stream\gateway-event.ts:560`](D:/AI_Agents/HermesAgent/apps/desktop/src/app/session/hooks/use-message-stream/gateway-event.ts:560)（native approval actions）及 [`D:\AI_Agents\HermesAgent\apps\desktop\src\app\session\hooks\use-message-stream\index.ts:460`](D:/AI_Agents/HermesAgent/apps/desktop/src/app/session/hooks/use-message-stream/index.ts:460)（turn-done notification）。

### Obsidian 官方文档

- **[S21]** [Community plugins](https://obsidian.md/help/Extending%2BObsidian/Community%2Bplugins)（browse/filter/install/enable/manual update/uninstall and plugin settings；页面行 0–7）。
- **[S22]** [Plugin security](https://obsidian.md/help/Extending%2BObsidian/Plugin%2Bsecurity)（Restricted Mode、inherited app access、review/scorecard；页面行 0–4）。
- **[S23]** [Build a plugin](https://docs.obsidian.md/Plugins/Getting%20started/Build%20a%20plugin)（per-vault `.obsidian` plugin location and reload semantics）。
- **[S24]** [Introduction to Obsidian Sync](https://obsidian.md/help/Obsidian%2BSync/Introduction%2Bto%2BObsidian%2BSync)（selective settings sync, status/log, version history, privacy/security links；页面行 0–3）。
