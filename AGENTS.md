# Magic Pointer Agent Instructions

## Mandatory first read

Before changing this repository, read `docs/design/MAGIC_POINTER_HARNESS_20260811.md` completely. It is the current product and architecture source of truth.

Then read `docs/STATUS.md` and inspect `git status`. Preserve user and other-agent work.

## Current product boundary

- Magic Pointer is an interaction-compiled desktop Agent Harness for short daily tasks, usually a few turns/minutes.
- Project-scale Claude Code/Codex/Pi work remains in those native clients; Magic Pointer may compile and fill a prompt into them.
- Gesture completion must freeze historical pixels before UIA/DOM/COM/OCR or any overlay can change the observed state.
- Full local target-surface evidence is retained; a tiny gesture crop is never the sole OCR/vision evidence.
- Perception is concurrent evidence fusion, not serial first-nonempty fallback.
- UIA may stay resident but must be idle/event-driven; capture, OCR and deep reads activate only after explicit wake/gesture/task.
- Explicit current-turn instructions may authorize send/delete/run after ActionLease revalidation and result verification.
- Generated text is a versioned editable DraftArtifact; user edits and local Agent patches are first-class.
- New applications enter through SurfaceAdapter/Capability contracts, never core app-specific if/else.
- Reuse Pi/Kimi/Clicky/etc. only after contract, performance, failure-semantics and license review.
- Existing Magic Pointer code has no presumption of retention. Apply the Reuse Gate in the canonical design.

## Current implementation phase

Execute `docs/superpowers/plans/2026-08-11-frame-lease-foundation.md` first. Do not start later Harness, plugin, MCP or visual work while pointerup can still capture a later screen.

After each completed phase, update the progress ledger in `docs/design/MAGIC_POINTER_HARNESS_20260811.md`.

## Local machine delivery (mandatory after every bug-fix batch)

用户机器上的已安装应用必须与开发树同步。每次修完 bug、全量验证（Python/Node/typecheck）通过后：

1. 若涉及可感知的行为变化：`package.json` version 自增一位补丁号（如 1.0.1 → 1.0.2）。
2. 运行 `npm run sync`（scripts/sync_install.ps1：验证→构建 NSIS 安装器→杀运行中实例→静默安装→重启应用）。
3. 确认 `%LOCALAPPDATA%\Programs\Magic Pointer\resources\app\package.json` 的 version 与开发树一致。
4. 把本次交付版本写进 `docs/STATUS.md` 一句话状态。

不要只改开发树让用户每次自己敲命令开开发版；交付=sync 后的安装版。GitHub 自动更新通道（electron-builder publish: github）对最终用户生效需要打 tag 推送发布，未配置前以本机 sync 为准。

## Task-specific rereads

- Visual/card/draft UI: read `docs/design/VIDA_UI_SPEC.md`.
- Tool/UIA/app adapter/source reuse: read `docs/REFERENCE_PROJECTS_20260810.md` and the routed sources in canonical design §16.
- Current truth and manual verification: read `docs/STATUS.md`.
- External Agent connectors: read `docs/AGENT_INTEGRATION.md`; do not confuse them with MPAgentRuntime.

## Engineering rules

- Test first for every feature, bug fix and refactor; observe the expected failure before production edits.
- Use `apply_patch` for hand edits.
- Report `usedBackend`, timing, errors and verification honestly.
- Do not launch the Electron UI unless a test/verification explicitly requires it. Headless tests and builds are allowed.
- Do not claim completion without fresh full verification.
- Never preserve a module merely because it already exists or has tests.
- Keep deterministic state, permissions, coordinates and verification outside the model.

