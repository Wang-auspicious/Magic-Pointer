# JavaScript to TypeScript Wave 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the voice trigger state machine and its test to strict TypeScript without changing state transitions or dual-runtime exports.

**Architecture:** Derive literal unions from the frozen state and strategy tables, type effects and transition results, and keep boundary inputs `unknown` until runtime validation narrows them. Preserve the IIFE, CommonJS API, browser global, WeakMap configuration, and enumerable instance fields.

**Tech Stack:** TypeScript 6, tsx, Node.js CommonJS, browser classic scripts, Electron.

---

### Task 1: Preserve the state-machine contract

**Files:**
- Rename and type: `tests/voice_trigger_policy_test.js` to `tests/voice_trigger_policy_test.ts`

- [x] **Step 1: Run the renamed characterization test**

Add structural parameter types to the test helper and run `node --require tsx/cjs tests/voice_trigger_policy_test.ts`.

Expected: PASS against the JavaScript implementation.

### Task 2: Migrate the voice trigger policy

**Files:**
- Rename and modify: `electron/voice_trigger_policy.js` to `electron/voice_trigger_policy.ts`
- Modify: `tests/stage_browser_script_namespace_test.ts`

- [x] **Step 1: Type the state machine**

Add literal `VoiceState`, `VoiceStrategy`, and `VoiceEffect` unions; typed configuration, results, fields, and methods; safe record narrowing for unknown events; and typed global publication. Keep every transition and validation error unchanged.

- [x] **Step 2: Update the browser-source contract**

Point the namespace VM test at `electron/voice_trigger_policy.ts` so its existing transpilation path validates the classic-script output.

- [x] **Step 3: Verify the migration**

Run the focused policy and browser namespace tests, then `npm run typecheck`, `npm run lint`, `npm run build:electron`, and `npm test`.

Expected: every command exits 0 and the complete 126-test Node suite passes.

### Task 3: Commit the voice trigger migration

**Files:**
- All files above and this plan.

- [x] **Step 1: Commit only wave-three files**

Run: `git commit -m "refactor: migrate voice trigger policy to TypeScript"`

Expected: commit succeeds while the unrelated `docs/STATUS.md` edit remains unstaged.
