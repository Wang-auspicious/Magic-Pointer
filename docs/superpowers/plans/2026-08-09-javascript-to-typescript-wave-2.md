# JavaScript to TypeScript Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the contextual stage chips policy and its tests to strict TypeScript without changing its Node or browser API.

**Architecture:** Keep the policy as a dual-runtime classic script inside an IIFE so TypeScript declarations cannot collide with other renderer scripts. Model untrusted callers as `unknown`, narrow object inputs before property access, and retain the compiled `.js` URL consumed by `stage.html`.

**Tech Stack:** TypeScript 6, tsx, Node.js CommonJS, browser classic scripts, Electron.

---

### Task 1: Preserve the chips behavior contract

**Files:**
- Rename: `tests/stage_chips_policy_test.js` to `tests/stage_chips_policy_test.ts`

- [x] **Step 1: Run the renamed characterization test**

Run: `node --require tsx/cjs tests/stage_chips_policy_test.ts`

Expected: PASS against the JavaScript implementation.

### Task 2: Migrate the dual-runtime policy

**Files:**
- Rename and modify: `electron/stage_chips_policy.js` to `electron/stage_chips_policy.ts`
- Modify: `tests/stage_browser_script_namespace_test.ts`

- [x] **Step 1: Introduce strict internal types**

Wrap the implementation in an IIFE; add `Chip`, `UnknownRecord`, immutable mapping types, `unknown` inputs, defensive narrowing, and a typed `globalThis.StageChipsPolicy` assignment. Preserve all labels, commands, caps, and return values.

- [x] **Step 2: Point the browser namespace test at TypeScript source**

Change only the chips source entry from `.js` to `.ts`; the existing VM helper transpiles TypeScript to a classic script before evaluation.

- [x] **Step 3: Run focused tests and strict checks**

Run: `node --require tsx/cjs tests/stage_chips_policy_test.ts`

Run: `node --require tsx/cjs tests/stage_browser_script_namespace_test.ts`

Run: `npm run typecheck && npm run lint && npm run build:electron && npm test`

Expected: all commands PASS and `build/electron/stage_chips_policy.js` exists.

### Task 3: Commit the chips migration

**Files:**
- All files above and this plan.

- [x] **Step 1: Stage only the chips wave and commit**

Run: `git commit -m "refactor: migrate stage chips policy to TypeScript"`

Expected: the commit succeeds while `docs/STATUS.md` remains unstaged.
