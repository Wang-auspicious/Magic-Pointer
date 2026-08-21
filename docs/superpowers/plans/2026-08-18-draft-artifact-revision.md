# DraftArtifact revision（蓝图 Gate 2 / §6.4 / §13.1）

> 前置：`docs/research/2026-08-17-magic-pointer-sovereign-agent-backend-blueprint.md` §6.4、§13.1、Gate 2。
> 上一批把感知打成 provider/fusion；产出仍只是聊天气泡字符串。本批让模型最终文本成为版本化可编辑产物。

## 为什么现在做

蓝图把 `app/artifacts/store.py` 标为「下一批」，现状是零个模块。完成一次 loop 的文本只活在 `Terminal.message` 和 `assistant/message` 里：用户改三个字，那三处差异消失；批准无法绑定内容；写回不知道该读哪一版。这不是 GUI 缺控件，是领域对象不存在。

本批不另建第二套 store。沿用 run_kernel 的形状：**EventSession 仍是唯一 durable truth，`app/artifacts/` 只放 typed schema 与纯投影。**

## 范围

做：
- `DraftArtifact` / `DraftPatch` / `DraftState` 纯领域对象。
- 三类会话事件：`artifact/generated`、`artifact/patched`、`artifact/accepted`。
- 投影：按 artifactId 还原最新 revision、历史、是否仍被批准。
- 生产接线：loop 在 `TransitionReason.COMPLETED` 且文本非空时写入 generated；用户/Agent 补丁走 session 方法。
- 批准绑定 `(revision, contentHash)`；之后再补丁使旧批准失效。

不做：
- 不升版本、不 sync（用户指示产品成熟再升）。
- 不改 GUI；display 投影给后续渲染用。
- 不实现 written/submitted/verified（那些要 ActionLease 真写回，另批）。
- 不把每次 assistant 中间话当成草稿；只有 COMPLETED 终稿。
- 不把 ask_user 的问题文案当成草稿。
- 不另建 SQLite/JSON 文件。

## 不变量

1. 一个 artifactId 的第一件事必须是 generated，revision=1。
2. 每次 patched 的 baseRevision 必须是当前最新；新 revision = 当前 + 1。
3. accepted 必须对准当前 revision 的 contentHash；对不上就拒绝，不静默批准旧文。
4. accepted 之后的 patched 把 state 从 approved 打回 edited，旧批准不再有效。
5. 空文本不得 generated。
6. 补丁事件不进入模型表面（不是 user/assistant/tool message）。
7. 同一次 session 里多次 COMPLETED 各自生成新 artifactId（追问是新产物，不是给旧草稿打补丁）。

## 测试先行

1. generated → revision 1、hash 稳定、state=generated。
2. user patch → revision 2、state=edited、历史里能看出作者是 user。
3. accept 绑定 hash；用过期 hash 接受必须失败。
4. accept 后再 patch → 最新不是 approved。
5. 空文本 generated 必须失败。
6. 有 session 的 loop COMPLETED 会留下一条 generated 草稿，内容就是终稿。
7. AWAITING_USER 不产生草稿。

## 顺序

1. 失败测试（schema/投影/会话方法）。
2. `app/artifacts/schema.py` + `projection.py` + session 记录方法。
3. 失败测试（loop 接线）。
4. loop COMPLETED 路径写入 generated。
5. 相关测试全绿；STATUS 与蓝图账本更新；不升版本。
