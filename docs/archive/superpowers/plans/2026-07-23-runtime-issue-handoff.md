# Runtime Issue Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Windows flow “circle a live UI problem → optionally circle a reference → fill a grounded task into an Agent that locates the source itself.”

**Architecture:** Extend the existing Context Session schema with a runtime workflow and evidence roles, then reuse its prompt artifact and safe GUI handoff. `Ctrl+Alt+M` becomes the interactive visual capture entry, `Ctrl+Alt+Enter` becomes delivery, and the old native selection rail moves to `Ctrl+Alt+Shift+M`.

**Tech Stack:** Python 3.12, Electron/CommonJS, Win32/UIA C#, Pillow screenshot capture, pytest, Node `assert`.

---

### Task 1: Runtime issue session semantics

**Files:**
- Modify: `tests/context_pack_session_test.py`
- Modify: `app/context_pack/session.py`

- [x] **Step 1: Write failing tests**

Add tests that call `record_runtime_visual(capture, statement)` and assert the first item is `role="issue"`, the session is `workflow_kind="runtime_issue"`, and `task_instruction` equals the first statement. Add a second capture and assert it is `role="reference"` without changing `task_instruction`. Start from an active generic context session and assert it is finished instead of mixed into the runtime issue.

- [x] **Step 2: Verify RED**

Run:

```powershell
python -m pytest -q tests/context_pack_session_test.py
```

Expected: failures because `record_runtime_visual` and workflow fields do not exist.

- [x] **Step 3: Implement runtime recording**

Add `workflow_kind` to newly created sessions, preserve missing legacy values as `context_pack`, and add:

```python
def record_runtime_visual(self, capture: Any, statement: str, *, now: str | None = None) -> JsonDict:
    ...
```

The method must atomically roll over a non-runtime active session, assign `issue`/`reference`, keep the first task, clear stale compilation fields, fingerprint duplicates, increment revision, and return the public session summary.

- [x] **Step 4: Verify GREEN**

Run the focused test and then:

```powershell
python -m pytest -q tests/context_pack_session_test.py tests/review_session_test.py
```

Expected: all pass.

### Task 2: Runtime-aware prompt compiler

**Files:**
- Modify: `tests/context_pack_compiler_test.py`
- Modify: `app/context_pack/compiler.py`

- [x] **Step 1: Write failing compiler tests**

Create a `workflow_kind="runtime_issue"` session with one `issue` and one `reference`. Assert the prompt contains the user's runtime task, the two evidence roles, “自行检查当前工作区并定位负责源码”, “不要要求用户寻找文件”, image paths, and verification requirements. Assert the prompt remains within 60,000 characters.

- [x] **Step 2: Verify RED**

Run:

```powershell
python -m pytest -q tests/context_pack_compiler_test.py
```

Expected: runtime-specific assertions fail against the generic compiler.

- [x] **Step 3: Implement workflow-aware output**

Branch only the title, execution boundary, role labels, and output contract when `session["workflow_kind"] == "runtime_issue"`. Reuse existing catalog, detail truncation, source rendering, Agent profiles, and global budget.

- [x] **Step 4: Verify GREEN**

Run focused compiler tests and confirm both generic Context Pack and runtime issue prompts pass.

### Task 3: Visual bridge automatic issue capture

**Files:**
- Modify: `tests/context_pack_visual_bridge_test.py`
- Create: `tests/runtime_issue_bridge_test.py`
- Modify: `scripts/electron_bridge.py`

- [x] **Step 1: Write failing unit and process tests**

Assert `workflow="runtime_issue"` accepts a natural statement without `收集：`, rejects blank text, records the first capture as issue, a second as reference, returns `intentKind="runtime_issue_recorded"`, produces a prompt artifact, and succeeds with `vision_error` when the vision model is unavailable.

- [x] **Step 2: Verify RED**

Run:

```powershell
python -m pytest -q tests/context_pack_visual_bridge_test.py tests/runtime_issue_bridge_test.py
```

Expected: natural runtime payload is treated as generic visual chat and no runtime session is created.

- [x] **Step 3: Implement automatic record and compile**

In `scripts/electron_bridge.py`, detect:

```python
runtime_issue_mode = payload.get("workflow") == "runtime_issue"
```

For that mode, require a non-empty statement, suppress legacy actions, catch vision failures, call `record_runtime_visual`, reload the active session, compile using its locked task, write the artifact, save with CAS, and return a compact receipt with `autoDismissMs`.

- [x] **Step 4: Verify GREEN**

Run the focused bridge tests, including a subprocess invocation using an isolated `MAGIC_POINTER_USER_DATA_DIR`.

### Task 4: Interactive capture and dedicated delivery hotkeys

**Files:**
- Modify: `tests/overlay_static_test.js`
- Modify: `tests/result_surface_policy_test.js`
- Create: `tests/runtime_issue_hotkeys_test.js`
- Modify: `electron/main.js`
- Modify: `electron/renderer/index.html`
- Modify: `electron/renderer/overlay.js`
- Modify: `electron/renderer/styles.css`

- [x] **Step 1: Write failing Node/static tests**

Assert main registers:

```js
Control+Alt+M
Control+Alt+Enter
Control+Alt+Shift+M
```

Assert `Ctrl+Alt+M` calls a runtime capture function that sets `setIgnoreMouseEvents(false)`, sends `observerMode:false` and `workflow:'runtime_issue'`; delivery calls the existing selection session; legacy selection uses the shifted shortcut. Assert renderer includes `workflow` in `overlay:done`, uses natural-language placeholder text, and displays runtime receipts.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test
```

Expected: new hotkey and workflow assertions fail.

- [x] **Step 3: Implement host routing**

Add `showRuntimeIssueOverlay()` separate from click-through `showOverlay()`. It must size to the cursor display, accept mouse events, focus the Overlay, and send the runtime workflow payload. Route hotkeys exactly as specified and preserve activation debounce/dismiss behavior.

- [x] **Step 4: Implement renderer state**

Store the current workflow from `overlay:show`; include it in bridge payloads; update hint and placeholder; render “现场任务已准备” instead of “Thinking/Result” wording for runtime receipts; auto-dismiss only successful receipts after the returned delay.

- [x] **Step 5: Verify GREEN**

Run `npm test`. Expected: every Node/static test passes.

### Task 5: Finish session only after verified handoff

**Files:**
- Modify: `tests/action_bridge_test.py`
- Modify: `app/context_pack/session.py`
- Modify: `scripts/action_bridge.py`
- Modify: `app/actions/draft_delivery.py`

- [x] **Step 1: Write failing lifecycle tests**

Build a successful `paste_text_to_foreground` proposal with `workflow_kind="runtime_issue"` and an exact session ID. Assert the action result completes that active session. Simulate writer failure and assert the session remains active. Assert a mismatched session ID cannot finish another issue.

- [x] **Step 2: Verify RED**

Run:

```powershell
python -m pytest -q tests/action_bridge_test.py tests/draft_delivery_test.py
```

Expected: proposal lacks workflow metadata and successful handoff does not finish the session.

- [x] **Step 3: Implement exact finish contract**

Add an expected-session argument to `ContextSessionStore.finish`. Add `workflow_kind` to delivery proposal parameters/metadata. After `SafeActionExecutor` succeeds, `scripts/action_bridge.py` finishes only the matching runtime session and includes `contextSessionFinished` in its receipt. Failure paths do not mutate session state.

- [x] **Step 4: Verify GREEN**

Run focused lifecycle tests and the existing review handoff tests.

### Task 6: Demo and documentation

**Files:**
- Create: `demo/runtime_issue_demo.html`
- Modify: `README.md`
- Modify: `PRODUCT_RESEARCH_REASSESSMENT_20260722.md`
- Modify: `tests/overlay_static_test.js`

- [x] **Step 1: Add the demo**

Create a dependency-free local page containing an intentionally misaligned “Save changes” button, an adjacent correct reference card, a concise scenario label, and a large empty “Agent draft target” textarea. The page must not contain scripts that repair itself or auto-submit.

- [x] **Step 2: Update docs**

Replace the source-file collection walkthrough with:

```text
Ctrl+Alt+M → circle live problem → state expectation
Ctrl+Alt+M → optional reference
Ctrl+Alt+Enter → fill Agent, do not submit
```

Document `Ctrl+Alt+Shift+M` as legacy native selection, the no-vision fallback, local artifact paths, and honest non-goals.

- [x] **Step 3: Update product record**

Append the rejected old value, the new runtime wedge, the implemented behavior, and validation evidence to the research/reassessment Markdown.

### Task 7: Full verification and desktop smoke

**Files:**
- Modify only if a test exposes a defect in an in-scope file.

- [x] **Step 1: Run complete automated verification**

```powershell
python -m pytest -q --basetemp .pytest-runtime-final
npm test
python -c "from app.actions.draft_writer import _compile_draft_writer; print(_compile_draft_writer())"
git diff --check
```

Expected: all Python tests pass, all Node tests pass, C# compilation prints `(True, None)`, and diff check exits zero.

- [x] **Step 2: Launch Electron**

Start the exact local Electron executable hidden, inspect `data/runtime/electron.log`, and confirm all three hotkeys register plus Lab remains disabled. Stop only the PID launched by the smoke command and confirm no new Electron processes remain.

- [x] **Step 3: Inspect UI**

Render or run the Overlay against `demo/runtime_issue_demo.html` and verify the hint, natural-language command pill, receipt, and delivery rail are legible at the target viewport.

- [x] **Step 4: Report honest boundary**

Report automated and smoke evidence separately. Do not claim a real Codex/Claude input was modified unless that exact external UI handoff was manually exercised.
