# JavaScript to TypeScript Wave 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the stage element-picking geometry policy and its test to strict TypeScript with unchanged selection behavior.

**Architecture:** Keep runtime boundary values unknown, narrow usable rectangles through a type predicate, and represent selected targets explicitly. Wrap the dual-runtime API in an IIFE so it remains safe beside the other classic renderer scripts.

**Tech Stack:** TypeScript 6, tsx, Node.js CommonJS, browser classic scripts, Electron.

---

### Task 1: Extend characterization coverage

**Files:**
- Modify: `tests/stage_browser_script_namespace_test.ts`
- Rename: `tests/stage_pick_policy_test.js` to `tests/stage_pick_policy_test.ts`

- [x] **Step 1: Cover the pick policy browser global**

Add the current JavaScript policy to the shared classic-script VM test and assert `globalThis.StagePickPolicy` exists.

- [x] **Step 2: Run both characterization tests**

Run the renamed policy test and the namespace test against the JavaScript source; both must pass before migration.

### Task 2: Migrate the policy

**Files:**
- Rename and modify: `electron/stage_pick_policy.js` to `electron/stage_pick_policy.ts`
- Modify: `tests/stage_browser_script_namespace_test.ts`

- [x] **Step 1: Add strict geometry types and boundary narrowing**

Type rectangles, pick input, selected targets, numeric helpers, and comparison inputs. Preserve point coercion, minimum dimensions, hit tolerance, window coverage rejection, smallest-area selection, label conversion, and rounded equality.

- [x] **Step 2: Switch the VM contract to TypeScript source**

Change the pick source entry to `.ts`; keep the renderer's `.js` URL because it consumes compiled output.

- [x] **Step 3: Verify and commit**

Run focused tests, strict typecheck, lint, Electron build, and all Node tests; then commit as `refactor: migrate stage pick policy to TypeScript` without staging `docs/STATUS.md`.
