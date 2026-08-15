# Oreo Fixed Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the morphing voice bubble with a fixed Oreo composer and keep one fixed WorkPanel rectangle through processing, answer, failure, follow-up, and approval.

**Architecture:** Preserve StageState and bridge messages, but freeze separate composer and work-panel placements per session. Geometry comes from pure policy constants and never from rendered content; body overflow is internal.

**Tech Stack:** Electron renderer, TypeScript classic globals, CSS, Node assert tests.

---

## File map

- `electron/stage_surface_policy.ts`: fixed role sizes and placement reuse.
- `electron/stage_anchor.ts`: stable placement support.
- `electron/renderer/stage.html`: composer/work-panel DOM.
- `electron/renderer/stage.ts`: state-to-surface routing without morph/re-anchor.
- `electron/renderer/stage.css`: Oreo fixed geometry and internal scrolling.
- `electron/settings_store.ts`: remove obsolete capsule animation geometry after migration.
- `tests/stage_surface_policy_test.ts`: immutable geometry tests.
- `tests/stage_static_test.js`: no-morph DOM/CSS contract.
- `tests/stage_anchor_test.ts`: stable placement tests.

### Task 1: Define immutable role geometry

- [ ] Create a failing test expecting `composer={480,132}` and `work={560,520}`, viewport clamping only at first placement, and same-session object reuse.
- [ ] Run it and observe module-not-found.
- [ ] Implement `stage_surface_policy.ts` with `surfaceSize(role,viewport)` and `stableSurfacePlacement(input)`.
- [ ] Run focused test and typecheck.

### Task 2: Replace capsule DOM with Oreo Composer

- [ ] Change static tests to require `stage-composer`, `composer-context`, `composer-input`, `composer-tools`, and to reject waveform-only ball markup.
- [ ] Run static tests and observe failure.
- [ ] Update HTML/renderer references while preserving input, selection refs, submit/stop and dictation behavior.
- [ ] Render voice as an internal composer mode; never alter width or radius.
- [ ] Run state, voice-trigger, hit-region and static tests.

### Task 3: Freeze WorkPanel geometry and anchor

- [ ] Replace width-tier/static expectations with fixed width/height CSS variables and a body scroller.
- [ ] Run tests and observe failures.
- [ ] Replace content measurement/adaptive repeat placement with one `stableSurfacePlacement` call per role/session.
- [ ] Remove `completionWidthTier`, data width tiers, result-driven re-anchoring and shell size animations.
- [ ] Keep drag as an explicit placement replacement and clamp only after display topology changes.
- [ ] Run focused tests and typecheck.

### Task 4: Apply the reference visual system

- [ ] Add static assertions for hairline border, paper surface, fixed header/footer, black primary controls, mono eyebrow, lavender/cyan tags and reduced-motion behavior.
- [ ] Run and observe style contract failure.
- [ ] Rewrite active Stage CSS using the approved Oreo tokens; delete obsolete capsule/finish keyframes.
- [ ] Ensure processing/result changes only body content and state labels.
- [ ] Run Node tests, typecheck, lint and build.

### Task 5: Commit and ledger

- [ ] Commit Stage policy, renderer and tests with `feat: replace stage bubble with fixed Oreo surfaces`.
- [ ] Update the canonical progress ledger with test evidence.

