# Contextual Result Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents are prohibited by the user; execute inline in the current session.

**Goal:** Replace the sticky Rail and automatic full-height Reader with a debounced, fail-closed, default-inline result surface that dismisses predictably and opens the Reader only after explicit expansion or a future B-mode preference.

**Architecture:** Keep the command Rail, contextual result surface, and Reader as three separate Electron windows with one lifecycle owner in `main.js`. Put timing and result-mode decisions in small pure CommonJS modules so key repeat, unsupported captures, A/B routing, and dismissal can be tested without launching Electron; render default A in new isolated HTML/CSS/JS files and retain Reader as explicit B.

**Tech Stack:** Electron 43, CommonJS JavaScript, context-isolated preload IPC, Node `assert` tests, Python snapshot bridge and pytest.

**Execution status (2026-07-12):** Tasks 1—4 implemented and committed. Task 5 automated, visual, process, repeat-gate, explicit-dismiss, and unsupported auto-dismiss checks completed; a fresh deterministic Edge foreground-selection run remains a stated manual verification rather than an inferred pass.

## Global Constraints

- Default result mode is A (`inline`); Dashboard may later persist A/B, but this plan does not build the Dashboard page.
- Long content and high-risk actions never switch from A to B automatically; only explicit expansion may open B.
- `Ctrl+Alt+M` is debounced for 600ms and, after that interval, toggles all temporary Magic Pointer surfaces closed.
- Unsupported, error, and empty captures never show command input, never invoke the command bridge, and never open Reader.
- Do not register a global Escape shortcut.
- Do not implement Obsidian PDF extraction or screenshot OCR in this change.
- Do not run `rm`, delete user files, stage `2307.00583v1.pdf`, or stage `HANDOFF_2026-07-10_MAGIC_POINTER.md`.
- Use explicit Git file allowlists and run deletion checks before every commit.

---

## File Structure

- Create `electron/activation_gate.js`: pure 600ms hotkey repeat gate returning `activate`, `dismiss`, or `ignore`.
- Create `electron/result_surface_policy.js`: pure capture eligibility and A/B result classification.
- Create `electron/renderer/result.html`: isolated A surface DOM.
- Create `electron/renderer/result.css`: content-sized A visual system and reduced-motion behavior.
- Create `electron/renderer/result.js`: safe Markdown, close/expand/actions, session filtering, and auto-dismiss error state.
- Create `tests/activation_gate_test.js`: deterministic timestamp tests for repeated hotkeys and later toggle.
- Create `tests/result_surface_policy_test.js`: unsupported/error/empty routing and A/B/expandable routing.
- Create `tests/result_static_test.js`: DOM/IPC/security/close/expand static contract.
- Modify `electron/main.js`: create/position/hide result window, own all temporary-surface lifecycle, route IPC, apply gate, short-circuit bad captures.
- Modify `electron/preload.js`: expose narrow `magicPointerResult` API and replace automatic `openSecondaryResult` with `showContextualResult`.
- Modify `electron/renderer/panel.js`: hand completed payload to main and hide Rail; render capture errors as non-interactive transient Rail.
- Modify `electron/renderer/panel.html` and `panel.css`: add explicit close affordance and non-interactive unsupported state without restoring the old card.
- Modify `electron/renderer/reader.html`, `reader.css`, and `reader.js`: textual Close/Pin controls, content-sized B layout, pin state.
- Modify `electron/panel_position.js`: reusable placement for content-sized A anchored to frozen selection.
- Modify `package.json`: include new syntax and unit/static tests.
- Modify `PRODUCT_PROGRESS_ALIGNMENT_20260712.md`: record M1.1 verification evidence and remaining Obsidian adapter gap.

---

### Task 1: Debounce Hotkey Activation and Centralize Dismissal

**Files:**
- Create: `electron/activation_gate.js`
- Create: `tests/activation_gate_test.js`
- Modify: `electron/main.js:15-39, 359-370, 574-588`
- Modify: `package.json:10-12`

**Interfaces:**
- Produces: `ActivationGate({ debounceMs }).decide({ now, hasVisibleSurface }) -> 'activate' | 'dismiss' | 'ignore'`.
- Produces: `hasVisibleTemporarySurface() -> boolean` and `dismissTemporarySurfaces({ invalidateSession, hideObserver })` in `main.js`.

- [ ] **Step 1: Write the failing timestamp test**

```js
const assert = require('assert');
const { ActivationGate } = require('../electron/activation_gate');
const gate = new ActivationGate({ debounceMs: 600 });
assert.strictEqual(gate.decide({ now: 1000, hasVisibleSurface: false }), 'activate');
for (const now of [1050, 1100, 1250, 1599]) {
  assert.strictEqual(gate.decide({ now, hasVisibleSurface: true }), 'ignore');
}
assert.strictEqual(gate.decide({ now: 1600, hasVisibleSurface: true }), 'dismiss');
assert.strictEqual(gate.decide({ now: 2200, hasVisibleSurface: false }), 'activate');
console.log('activation gate test ok');
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `node tests\activation_gate_test.js`

Expected: `Cannot find module '../electron/activation_gate'`.

- [ ] **Step 3: Implement the pure gate**

```js
class ActivationGate {
  constructor({ debounceMs = 600 } = {}) {
    this.debounceMs = debounceMs;
    this.lastAcceptedAt = Number.NEGATIVE_INFINITY;
  }
  decide({ now = Date.now(), hasVisibleSurface = false } = {}) {
    if (now - this.lastAcceptedAt < this.debounceMs) return 'ignore';
    this.lastAcceptedAt = now;
    return hasVisibleSurface ? 'dismiss' : 'activate';
  }
}
module.exports = { ActivationGate };
```

- [ ] **Step 4: Replace the direct hotkey callback**

In `main.js`, instantiate one gate and route the callback through it:

```js
const activationGate = new ActivationGate({ debounceMs: 600 });
const decision = activationGate.decide({ hasVisibleSurface: hasVisibleTemporarySurface() });
log(`activation hotkey decision=${decision}`);
if (decision === 'ignore') return;
if (decision === 'dismiss') {
  dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  return;
}
beginSelectionSession('hotkey');
```

Declare `let resultWindow = null` beside `panelWindow` and `readerWindow`. `hasVisibleTemporarySurface` must inspect all three with null/destroyed guards. Until Task 3 creates the BrowserWindow, `resultWindow` remains null. `dismissTemporarySurfaces` must hide all three windows and invalidate exactly the active SelectionSession once.

- [ ] **Step 5: Run focused and full Node tests**

Run: `node tests\activation_gate_test.js && npm test`

Expected: `activation gate test ok` and all existing Node tests pass.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- electron/activation_gate.js electron/main.js package.json tests/activation_gate_test.js
git diff --cached --check
git diff --cached --diff-filter=D --name-status
git commit -m "fix: debounce pointer activation and dismissal"
```

---

### Task 2: Fail Closed Before Showing Command Input

**Files:**
- Create: `electron/result_surface_policy.js`
- Create: `tests/result_surface_policy_test.js`
- Modify: `electron/main.js:485-572`
- Modify: `electron/renderer/panel.js:251-305`
- Modify: `electron/renderer/panel.html`
- Modify: `electron/renderer/panel.css`
- Modify: `package.json`

**Interfaces:**
- Produces: `captureEligibility({ snapshot, summary }) -> { commandReady: boolean, state: string, message: string, autoDismissMs: number | null }`.
- Consumes: `SelectionSessionStore.attachSnapshot()` result.

- [ ] **Step 1: Write failure-state tests**

```js
const assert = require('assert');
const { captureEligibility } = require('../electron/result_surface_policy');

for (const state of ['unsupported', 'error', 'empty']) {
  const result = captureEligibility({
    snapshot: { status: state, source_window: { title: 'Paper - Obsidian' } },
    summary: { state, app: state === 'unsupported' ? null : 'application', hasContent: false },
  });
  assert.strictEqual(result.commandReady, false);
  assert.strictEqual(result.autoDismissMs, 1800);
  assert.match(result.message, /Obsidian|选中内容|暂不支持/);
}
assert.strictEqual(captureEligibility({
  snapshot: { status: 'ready' }, summary: { state: 'ready', app: 'pdf', hasContent: true },
}).commandReady, true);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node tests\result_surface_policy_test.js`

Expected: module-not-found failure.

- [ ] **Step 3: Implement eligibility without adapter guessing**

`captureEligibility` must accept only `snapshot.status === 'ready'`, `summary.state === 'ready'`, and `summary.hasContent === true`. It must derive the visible application name from `snapshot.source_window.title`, but never include selection content in the error. Unsupported Obsidian titles return `“Obsidian PDF 暂不支持读取选中文字”`; other failures return `“未能从「<title>」读取可靠选中内容”`.

- [ ] **Step 4: Short-circuit `beginSelectionSession` completion**

After `attachSnapshot`, compute eligibility. Include it in `panelPayloadForSession`. Do not call `selection_bridge.py` unless `commandReady` is true; enforce the same check again in `panel:submit-selection-command` to prevent renderer bypass.

Panel behavior for `commandReady: false`:

```js
primaryIntentButton.textContent = payload.captureEligibility.message;
primaryIntentButton.disabled = true;
primaryIntentButton.hidden = false;
commandRow.hidden = true;
setRailState('error');
window.setTimeout(() => window.magicPointerPanel?.hide(), payload.captureEligibility.autoDismissMs);
```

Add a visible close button to the Rail with `aria-label="关闭"`; it sends `panel:hide`. Do not add metadata, excerpt, or multiple suggestion buttons.

- [ ] **Step 5: Extend static tests**

Assert that unsupported payloads hide `#command-row`, disable `#primary-intent`, schedule `1800`, and call `magicPointerPanel.hide`. Assert `main.js` checks eligibility inside both capture completion and submit IPC.

- [ ] **Step 6: Run Node and Python regression**

Run: `npm test && python -m pytest -q`

Expected: all Node tests and all Python tests pass; Python total remains at least 64.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- electron/result_surface_policy.js electron/main.js electron/renderer/panel.html electron/renderer/panel.css electron/renderer/panel.js package.json tests/result_surface_policy_test.js tests/panel_static_test.js
git diff --cached --check
git diff --cached --diff-filter=D --name-status
git commit -m "fix: stop unsupported selections before commands"
```

---

### Task 3: Add Default A Contextual Result Window

**Files:**
- Create: `electron/renderer/result.html`
- Create: `electron/renderer/result.css`
- Create: `electron/renderer/result.js`
- Create: `tests/result_static_test.js`
- Modify: `electron/result_surface_policy.js`
- Modify: `electron/panel_position.js`
- Modify: `electron/preload.js`
- Modify: `electron/main.js:14-18, 190-240, 334-371, 603-610, 780-798`
- Modify: `electron/renderer/panel.js:181-218`
- Modify: `package.json`

**Interfaces:**
- Produces: `classifyResult(payload, preference = 'inline') -> 'inline-error' | 'inline' | 'expandable' | 'reader'`.
- Produces: preload API `magicPointerResult.hide()`, `.expand(payload)`, `.executeAction(payload)`, `.onShow(callback)`, `.onHide(callback)`, `.onResult(callback)`.
- Produces: main IPC `panel:show-contextual-result`, `result:ready`, `result:hide`, `result:expand`, `result:execute-action`.

- [ ] **Step 1: Add pure routing tests**

```js
assert.strictEqual(classifyResult({ ok: false, error: 'x' }), 'inline-error');
assert.strictEqual(classifyResult({ ok: true, answer: '短译文', actionProposals: [] }), 'inline');
assert.strictEqual(classifyResult({ ok: true, answer: 'x'.repeat(500), actionProposals: [] }), 'expandable');
assert.strictEqual(classifyResult({ ok: true, answer: 'ok', actionProposals: [{ action_type: 'office_replace_selection' }] }), 'expandable');
assert.strictEqual(classifyResult({ ok: true, answer: '短译文' }, 'reader'), 'reader');
```

The default preference must be `inline`. `expandable` means A with an explicit expand button, not automatic Reader.

- [ ] **Step 2: Run and confirm routing RED**

Run: `node tests\result_surface_policy_test.js`

Expected: missing export or incorrect classification.

- [ ] **Step 3: Write the result renderer static test before files exist**

Test requirements:

```js
assert(html.includes('id="contextual-result"'));
assert(html.includes('id="result-close"'));
assert(html.includes('id="result-expand"'));
assert(!html.includes('id="command"'));
assert(js.includes('window.magicPointerResult?.onShow'));
assert(js.includes('window.magicPointerResult?.hide'));
assert(js.includes('window.magicPointerResult?.expand'));
assert(js.includes('renderSafeMarkdown'));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
```

Run: `node tests\result_static_test.js`

Expected: missing result files.

- [ ] **Step 4: Implement A renderer**

DOM contains only: intent/source header, textual close button, result body, and contextual actions. CSS uses content-sized width 280—440 DIP, maximum body height 260 DIP, 16—18 DIP radius, translucent dark background, no full-height empty area. `result.js` must escape all HTML before applying the same limited Markdown rules as Reader.

For `inline-error`, render one concise message and request hide after `1800ms`. For `expandable`, render a bounded preview and show `展开` or `查看并确认`. For `inline`, show result plus `复制` only if an explicit copy proposal exists; do not synthesize clipboard writes.

- [ ] **Step 5: Add and position `resultWindow`**

Create a frameless, transparent, always-on-top BrowserWindow with `showInactive()`. Position it using the frozen `panelGeometry.selectionRects`, reusing placement math from `panel_position.js`; never anchor to the later cursor position. Clamp width to 280—440 and height to measured renderer size with a maximum of 360 DIP.

Panel completion flow becomes:

```js
window.magicPointerPanel?.showContextualResult({
  ...payload,
  resultMode: classifyResult(payload, 'inline'),
  selectionSessionToken: currentSelectionSessionToken,
});
```

Main validates the current session, shows result window, waits for `result:ready`, then hides Panel without invalidating the session. Remove the `setRailState('success', '结果已在侧边打开')` branch.

- [ ] **Step 6: Implement deterministic dismissal**

- Result close sends `result:hide`; main hides result and invalidates session only when no Reader/action is active.
- `resultWindow.on('focus')` records that the user interacted with A; a later `blur` dismisses the unpinned A surface. A surface shown with `showInactive()` is not dismissed merely because it never owned focus.
- A result tracks its anchor and starts a grace period before cursor-distance dismissal. Main polling may dismiss when cursor is more than 220 DIP from both result bounds and selection anchor for at least 450ms.
- Second accepted hotkey calls centralized `dismissTemporarySurfaces` and invalidates the session.
- Escape works only while result window has focus; no global Escape registration.

- [ ] **Step 7: Run focused and complete tests**

Run: `node tests\result_surface_policy_test.js && node tests\result_static_test.js && npm test && python -m pytest -q`

Expected: new focused tests and all regressions pass.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- electron/main.js electron/panel_position.js electron/preload.js electron/result_surface_policy.js electron/renderer/panel.js electron/renderer/result.html electron/renderer/result.css electron/renderer/result.js package.json tests/panel_position_test.js tests/result_surface_policy_test.js tests/result_static_test.js
git diff --cached --check
git diff --cached --diff-filter=D --name-status
git commit -m "feat: show results beside the selected object"
```

---

### Task 4: Make B Explicit, Content-Sized, Closable, and Pinnable

**Files:**
- Modify: `electron/renderer/reader.html`
- Modify: `electron/renderer/reader.css`
- Modify: `electron/renderer/reader.js`
- Modify: `electron/preload.js`
- Modify: `electron/main.js:190-240, 359-371, 780-798`
- Modify: `tests/reader_static_test.js`
- Modify: `scripts/capture_reader_preview.js`

**Interfaces:**
- Consumes: `result:expand` payload from Task 3.
- Produces: `reader:set-pinned({ pinned: boolean })`; main-owned `readerPinned` state.

- [ ] **Step 1: Extend Reader test and confirm RED**

Require `id="reader-close"` with text `关闭`, `id="reader-pin"`, `magicPointerReader.setPinned`, and CSS max height `72vh` or equivalent computed main bound. Assert `panel:open-secondary` is absent from Panel and Reader only opens from `result:expand` or stored preference `reader`.

Run: `node tests\reader_static_test.js`

Expected: missing pin API/textual close or stale automatic-open channel.

- [ ] **Step 2: Implement B layout and lifecycle**

- Replace isolated `×` with `关闭`; add `固定` toggle with `aria-pressed`.
- Set Reader height from rendered content, minimum 240 and maximum 72% of display work area; retain a separate scroll body and sticky action footer.
- `readerWindow.on('blur')` hides only when the window has previously received focus and `readerPinned === false`.
- Opening a new SelectionSession always clears `readerPinned` and hides Reader.
- Closing Reader invalidates proposals bound to the old session.

- [ ] **Step 3: Verify explicit expansion**

Use static tests to assert A `result-expand` sends the payload, main validates the same SelectionSession token, hides A, and then shows B. Confirm no answer-length branch directly calls `showReader`.

- [ ] **Step 4: Generate and visually inspect previews**

Run:

```powershell
node_modules\.bin\electron.cmd scripts\capture_panel_preview.js
node_modules\.bin\electron.cmd scripts\capture_reader_preview.js
```

Add `scripts/capture_result_preview.js` using the same isolated BrowserWindow pattern and save `data/runtime/contextual_result_preview_20260712.png`. Inspect all three with the local image viewer. Acceptance: ordinary translation is A, no black full-height empty area, Close is obvious, and Reader occupies at most 72% work-area height.

- [ ] **Step 5: Run regression and commit Task 4**

Run: `npm test && python -m pytest -q`

Then:

```powershell
git add -- electron/main.js electron/preload.js electron/renderer/reader.html electron/renderer/reader.css electron/renderer/reader.js electron/renderer/result.js scripts/capture_reader_preview.js scripts/capture_result_preview.js tests/reader_static_test.js tests/result_static_test.js
git diff --cached --check
git diff --cached --diff-filter=D --name-status
git commit -m "fix: make expanded results explicit and dismissible"
```

---

### Task 5: Real Desktop Verification and Progress Ledger

**Files:**
- Modify: `PRODUCT_PROGRESS_ALIGNMENT_20260712.md`
- Modify: tests only if real verification exposes a deterministic regression.

**Interfaces:**
- Consumes all prior tasks; produces fresh runtime evidence and final M1.1 status.

- [ ] **Step 1: Run final automated verification**

Run:

```powershell
npm test
python -m pytest -q
git diff --check
git diff --diff-filter=D --name-status
```

Expected: all tests pass, no whitespace errors, and deletion output is empty.

- [ ] **Step 2: Restart only Magic Pointer**

Read `data/runtime/electron.pid`; stop only that PID with PowerShell `Stop-Process`; start `node_modules\.bin\electron.cmd .` hidden. Do not invoke a stop script and do not delete the PID file. Confirm one `app ready` and one successful hotkey registration in `data/runtime/electron.log`.

- [ ] **Step 3: Verify hotkey debounce from fresh logs**

Hold `Ctrl+Alt+M` long enough to reproduce key repeat once. Confirm the log contains one `decision=activate` followed by `decision=ignore`, not seven capture starts. After 600ms, press again and confirm `decision=dismiss` hides every Magic Pointer surface.

- [ ] **Step 4: Verify supported and unsupported flows**

- Edge PDF: select text, translate, confirm one A result beside selection, Rail gone, Reader absent, Close works.
- Obsidian embedded PDF: select text, activate, confirm concise unsupported error, no command input, no Reader, auto-dismiss around 1.8 seconds.
- Word/WPS: request rewrite, confirm A diff summary; only clicking `查看并确认` opens B; no write occurs before confirmation.

Record actual window titles, session tokens, log timestamps, screenshots, and any limitation. Do not claim a path passed if it could not be exercised deterministically.

- [ ] **Step 5: Update the ledger**

In `PRODUCT_PROGRESS_ALIGNMENT_20260712.md`, mark each M1.1 acceptance item with passed/failed and evidence paths. Keep Obsidian PDF extraction under the adapter backlog; do not mark it implemented.

- [ ] **Step 6: Final allowlist commit**

```powershell
git add -- PRODUCT_PROGRESS_ALIGNMENT_20260712.md
git diff --cached --check
git diff --cached --diff-filter=D --name-status
git commit -m "docs: record contextual result verification"
git status --short
```

Expected final untracked entries remain only user-owned files such as `2307.00583v1.pdf` and `HANDOFF_2026-07-10_MAGIC_POINTER.md`.

---

## Plan Self-Review Result

- Spec coverage: hotkey debounce, unsupported capture short-circuit, default A, explicit B expansion, close/pin behavior, no global Escape, reduced motion, real Edge/Obsidian/Word verification, and progress logging each map to a task.
- Scope: Obsidian PDF extraction and full Dashboard remain explicit non-goals; preference plumbing uses default `inline` without building settings UI.
- Type consistency: `ActivationGate.decide`, `captureEligibility`, `classifyResult`, `magicPointerResult`, and IPC channel names are defined once and used consistently across tasks.
- Placeholder scan: no placeholder markers or unspecified error-handling steps remain.
