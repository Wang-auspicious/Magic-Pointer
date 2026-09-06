# Magic Pointer mainline consolidation

## Goal

把 Magic Pointer 收敛成一条可维护的主流程，并一次性关闭当前文档列出的未完成安全与产品闭环。所有改动直接进入 `main`，不再创建新的 `codex/*` 交付分支。

## Scope

- 以 `MPAgentRuntime`、`ActionBroker`、`ArtifactStore` 和 `SurfaceAdapter` 作为唯一生产入口。
- 删除旧路由、重复桥接、只为历史兼容保留且没有生产调用者的代码与测试。
- 让 `EgressGate`、`ActionApproval`、`UndoLog`、预算检查和窗口订阅成为实际生产出口的必经路径。
- 使用 Electron safeStorage/Windows DPAPI 保存计划签名材料；禁止明文 `plan-signing.key`。
- 所有出网请求禁止跨源重定向复用认证头，并校验最终来源。
- ScreenMemory 由显式设置控制，关闭时不记录、不恢复自动记忆。
- 插件默认拒绝，批准卡展示完整变更内容和权限。
- compaction 使用结构化数据来源字段，恢复后保持证据与指令分离。
- replay 只验证真实结果和协议形状，不允许 fixture 自证成功。
- 统一 Office、浏览器、微信/钉钉的选择、动作、验证和撤销接口。
- 全量 Python、Node、TypeScript、lint、audit、构建和安装版同步验证。

## Invariants

1. 历史 FrameLease 不被新屏幕状态覆盖。
2. 所有写、发送、删除和出网动作都有可追踪 approval、执行回执和验证回执。
3. 任意凭据只能来自本机安全存储或明确配置，不进入仓库、日志、模型上下文或跨源请求。
4. 数据证据和用户指令在内存、持久化、压缩、恢复和模型请求中始终分离。
5. 失败必须返回失败状态和原因；不得把接受、排队或协议成功伪装成动作成功。

## Delivery

直接在 `main` 提交。每个可独立验证的变更保留清晰提交信息，但不创建新的长期分支。完成后更新设计文档进度账本、`docs/STATUS.md`，按项目要求执行 `npm run sync` 并核对安装目录版本。
