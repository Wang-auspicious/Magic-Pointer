# Mainline consolidation Implementation Plan

> **For agentic workers:** Execute inline in the current `main` checkout; do not create subagent branches.

**Goal:** 收敛 Magic Pointer 的生产入口，关闭已知安全缺口并删除无调用者的旧代码。

**Architecture:** `MPAgentRuntime → ActionBroker → SurfaceAdapter → ArtifactStore` 是唯一生产链；桥接层只负责 IPC 编解码。凭据从 safeStorage/DPAPI 读取，所有出网、写入、撤销和压缩都经过统一治理边界。

**Tech Stack:** Python 3.12, Electron/TypeScript, pytest, Node test runner, ESLint, npm audit, Electron safeStorage, Windows DPAPI。

---

### Task 1: 建立安全缺口回归测试

**Files:**
- Create: `tests/mainline_security_regression_test.py`
- Create: `tests/mainline_security_regression_test.ts`

- [ ] 写测试覆盖：重定向不携带认证头、screen memory off 不写入、插件默认拒绝、compaction 保持 data/instruction 分离、明文 plan-signing.key 不被读取。
- [ ] 运行定向测试，确认失败。

### Task 2: 修复出网、签名和记忆边界

**Files:**
- Modify: `app/ai_client.py`
- Modify: `app/fabric/engine.py`
- Modify: `app/context_pack/screen_memory.py`
- Modify: `electron/settings_store.ts`

- [ ] 让所有 HTTP client 禁止跨源重定向复用认证头。
- [ ] 将计划签名密钥改为 safeStorage/DPAPI 封装，旧明文文件只作为拒绝信号。
- [ ] 让 screen memory 设置关闭时完全跳过记录和恢复。
- [ ] 运行 Task 1 测试并修到通过。

### Task 3: 收紧插件、压缩和生产出口

**Files:**
- Modify: `app/harness/builtin_bundle.py`
- Modify: `app/agent_runtime/loop.py`
- Modify: `app/action_guard/action_broker.py`
- Modify: `app/actions/executor.py`

- [ ] 插件候选默认 denied，批准请求携带完整 diff 和权限集合。
- [ ] compaction 使用结构化 evidence 字段并在恢复时重建 origin。
- [ ] 所有写、发送、删除、出网动作经过 ActionBroker、ActionApproval、EgressGate 和 UndoLog。
- [ ] 运行相关 Python 测试。

### Task 4: 删除旧生产路径并修正文档

**Files:**
- Modify/Delete: `app/fabric/intent_router.py` 及其无调用者测试
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`
- Modify: `docs/STATUS.md`

- [ ] 用静态调用图确认无生产调用者后删除旧路径。
- [ ] 更新进度账本和真实验证边界。

### Task 5: 全量验证和交付

- [ ] 运行 `npm audit`、lint、typecheck、Node tests、pytest。
- [ ] 运行 `npm run sync`，核对安装版版本。
- [ ] 检查 `git diff --check`、`git status`，提交并推送 `main`。
