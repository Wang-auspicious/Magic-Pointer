# JavaScript to TypeScript Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish TypeScript test execution and migrate the first dual-runtime Electron policy without changing behavior.

**Architecture:** Keep Electron's current compile-to-`build/electron` runtime and CommonJS output. Tests execute source TypeScript through the existing `tsx/cjs` register, while renderer-compatible policies remain classic scripts by wrapping declarations in an IIFE and publishing the same `globalThis` API.

**Tech Stack:** TypeScript 6, tsx, Node.js CommonJS, Electron, ESLint.

---

### Task 1: Type-check and execute TypeScript tests

**Files:**
- Create: `tsconfig.tests.json`
- Modify: `package.json`
- Modify: `scripts/run-node-tests.ts`
- Rename: `tests/typescript_build_contract_test.js` to `tests/typescript_build_contract_test.ts`

- [x] **Step 1: Strengthen the build contract**

Add assertions that `package.json` type-checks `tsconfig.tests.json`, that the test config includes `tests/**/*.ts`, and that the runner discovers both `_test.js` and `_test.ts`.

- [x] **Step 2: Run the contract test and verify it fails**

Run: `node --require tsx/cjs tests/typescript_build_contract_test.js`

Expected: FAIL because the test TypeScript config and TypeScript test discovery do not exist yet.

- [x] **Step 3: Add the tests compiler configuration and discovery**

Create `tsconfig.tests.json` with strict, no-emit Node settings and forced module detection. Add it to the `typecheck` script and `run-node-tests.ts`; change the test filename filter to `/_test\.[jt]s$/`.

- [x] **Step 4: Rename and run the contract test**

Run: `node --require tsx/cjs tests/typescript_build_contract_test.ts`

Expected: PASS with `typescript build contract test ok`.

### Task 2: Migrate the stage hit policy

**Files:**
- Rename and modify: `electron/stage_hit_policy.js` to `electron/stage_hit_policy.ts`
- Rename: `tests/stage_hit_policy_test.js` to `tests/stage_hit_policy_test.ts`
- Rename and update: `tests/credential_main_static_test.js` to `tests/credential_main_static_test.ts`
- Rename and update: `tests/preflight_main_static_test.js` to `tests/preflight_main_static_test.ts`
- Rename and update: `tests/stage_browser_script_namespace_test.js` to `tests/stage_browser_script_namespace_test.ts`

- [x] **Step 1: Preserve the characterization test**

Rename the existing test without changing its assertions, then run it through `tsx/cjs` against the still-JavaScript policy.

- [x] **Step 2: Add strict input types and migrate the policy**

Type unknown pointer and region inputs defensively, keep number coercion and half-open rectangle bounds unchanged, preserve pointer-capture precedence, and publish the unchanged CommonJS and `globalThis.MagicPointerStageHitPolicy` API.

- [x] **Step 3: Verify the focused behavior and compiler**

Run: `node --require tsx/cjs tests/stage_hit_policy_test.ts`

Run: `npm run typecheck`

Expected: both commands PASS.

- [x] **Step 4: Update source-path contract consumers**

Migrate the static credential and preflight tests to assert the dual JS/TS test discovery expression. Migrate the browser namespace test and transpile TypeScript policy sources before evaluating them as classic scripts in its VM context.

### Task 3: Verify and checkpoint

**Files:**
- All files above.

- [x] **Step 1: Run lint, build, and the full Node suite**

Run: `npm run lint && npm run build:electron && npm test`

Expected: all commands PASS and `build/electron/stage_hit_policy.js` exists.

- [x] **Step 2: Commit only wave-one files**

Run: `git add package.json tsconfig.tests.json scripts/run-node-tests.ts tests/typescript_build_contract_test.ts electron/stage_hit_policy.ts tests/stage_hit_policy_test.ts docs/superpowers/plans/2026-08-09-javascript-to-typescript-wave-1.md`

Run: `git commit -m "refactor: start JavaScript to TypeScript migration"`

Expected: commit succeeds while the pre-existing `docs/STATUS.md` modification remains unstaged.
