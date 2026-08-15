# Magic Pointer Agent Instructions

## HERO 范围约束

=== 范围约束(约束你提议什么修法,不约束你找什么)===
凡是这里真的有问题,都要报——包括听起来罕见但本项目确实会产生的情况。
然后把修法收在范围内:
1. 这不是一篇安全攻防论文。可以校验,禁止过度防御。除非本项目另有说明,默认操作者是
   自己机器上的合作者;如果它真有对手,它会写明,以那个范围为准。
2. 不要加哈希/校验和/指纹,除非它替代了一个实质上更贵的操作,并且结果会改变下一步做什么。
3. 禁止防御性脚手架:不为这里不会发生的情况加 feature flag、迁移框架、兼容层、包装层。
4. 禁止钻牛角尖:冷门编码、符号链接竞态、RTL 文本、毫秒级竞态一律不在范围内,
   除非该情况经由本项目**受支持的用法**可达——它的文档示例、它公开的接口、它真实的
   数据。可达即可,不需要你复现出来;但“理论上构造得出”不算。
5. 该判断的地方就判断,不要换成评分表、检查清单,或对已经定论的东西再跑一遍校验。
6. 以上都不覆盖用户、本项目自己的约定、或更高优先级规则明确要求的安全、迁移、校验与
   审阅。那些是被要求的,是活儿本身,不算范围外。
已经见过的形状,供你校准。是例子不是清单——一个真问题不会因为“长得像其中一条”就被驳回:
  H  为了比对两个表格的差异,给每一行都算哈希——直接比单元格就能回答
  H  写下一堆校验和文件,而没有任何代码会去读它们
  E  给一个没有用户、没有部署的应用做账号安全加固
  R  用一整夜对自己的补丁反复审计,而功能一行没写
  R  一个对任何提交都给不通过的审阅者
  O  一层守卫的理由是上一层守卫,而不是需求
另有两种长得像上面、但不是的。这些要报:
  ✓  用摘要比对来跳过重读一个你已经有的大文件
  ✓  本项目自己的文档示例就会产生的那种“听起来罕见”的输入
跑任何检查之前先回答:这次运行会检测出什么具体的失败?真出现了我下一步会做什么不同的事?
答不上来就别跑。
对的就说对。不要为了交差硬找问题。

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
