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

