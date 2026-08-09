# JavaScript to TypeScript Wave 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the stage stretch gesture policy and its test to strict TypeScript with identical hints and commands.

**Architecture:** Model stretch directions and intent results explicitly, narrow unknown runtime input through records and number conversion, and retain a classic-script IIFE with the same CommonJS and browser APIs. Keep the renderer consuming the compiled `.js` file.

**Tech Stack:** TypeScript 6, tsx, Node.js CommonJS, browser classic scripts, Electron.

---

### Task 1: Characterize both runtimes

**Files:**
- Rename and type: `tests/stage_stretch_policy_test.js` to `tests/stage_stretch_policy_test.ts`
- Modify: `tests/stage_browser_script_namespace_test.ts`

- [x] Run the policy test and add the current JavaScript policy/global to the namespace test; verify both pass.

### Task 2: Migrate the policy

**Files:**
- Rename and modify: `electron/stage_stretch_policy.js` to `electron/stage_stretch_policy.ts`
- Modify: `tests/stage_browser_script_namespace_test.ts`

- [x] Type constants, direction, intent, helpers, unknown input narrowing, command generation, and the browser global without changing numeric or text output.
- [x] Switch the namespace fixture from `.js` to `.ts`.

### Task 3: Verify and commit

- [x] Run focused tests, typecheck, lint, Electron build, and all Node tests.
- [x] Commit only this wave as `refactor: migrate stage stretch policy to TypeScript`; leave `docs/STATUS.md` unstaged.
