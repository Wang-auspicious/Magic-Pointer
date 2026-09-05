# Studio Claude Interaction Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Studio's dead or mis-specified highlighted controls with measured Claude Desktop interactions and carry five-level reasoning effort into Magic Pointer's own Runtime.

**Architecture:** Keep existing ConversationStore, permission effect table and update manager as truth. Add focused pure modules for effort and popup geometry, expand the bounded statistics projection, and let `studio.ts` compose those contracts into real DOM interactions. Provider-native effort is optional; the Runtime prompt is the deterministic semantic floor.

**Tech Stack:** Electron 43, TypeScript 6, classic renderer globals, Node `assert` tests, Python 3.12/pytest, CSS custom properties, offscreen Electron input probes.

**Approved specification:** `docs/superpowers/specs/2026-09-05-studio-claude-interaction-correction-design.md`

---

## File structure

### New files

- `electron/renderer/effort_levels.ts` — canonical five-level renderer catalog.
- `electron/renderer/popover_position.ts` — pure trigger/viewport popup placement.
- `app/agent_runtime/effort.py` — validation and semantic prompt directives.
- `tests/effort_levels_render_test.ts` — exact renderer catalog contract.
- `tests/popover_position_test.ts` — collision/clamping contract.
- `tests/agent_runtime_effort_test.py` — Runtime semantic fallback contract.
- `tests/studio_interaction_probe_test.js` — real Electron click-probe assertions.
- `scripts/probe_studio_interactions.ts` — offscreen real-input interaction witness.

### Modified files

- `electron/renderer/studio.html` — semantic home buttons, direct effort popup,
  separate voice button, account popup and heatmap tooltip host.
- `electron/renderer/studio.ts` — popup controller, permission/model/effort/account
  bindings, update visibility and effort send field.
- `electron/renderer/claude_chat.css`, `electron/renderer/claude_shell.css` — complete
  row/icon/check/popup/home/account/model states.
- `electron/renderer/permission_presets.ts` — exact Claude labels/descriptions while
  retaining internal execution values.
- `electron/studio_home_stats.ts`, `electron/renderer/studio_home.ts` — ranged
  overview/model projections and interactions.
- `electron/renderer/data.ts`, `electron/preload.ts`, `electron/main.ts`,
  `scripts/conversation_bridge.py`, `app/agent_runtime/system_prompt.py`,
  `app/agent_runtime/model_client.py`, `app/ai_client.py` — canonical `effort`
  transport and optional native request field.
- Related focused tests and the two progress ledgers.

---

### Task 1: Lock exact control catalogs and popup geometry

**Files:**
- Create: `tests/effort_levels_render_test.ts`
- Create: `tests/popover_position_test.ts`
- Modify: `tests/permission_presets_render_test.js`
- Create: `electron/renderer/effort_levels.ts`
- Create: `electron/renderer/popover_position.ts`
- Modify: `electron/renderer/permission_presets.ts`

- [x] **Step 1: Write failing catalog tests**

```ts
const assert = require('node:assert');
const { EFFORT_LEVELS, normalizeEffort } = require('../electron/renderer/effort_levels');
assert.deepStrictEqual(EFFORT_LEVELS.map((row: { value: string }) => row.value),
  ['low', 'medium', 'high', 'xhigh', 'max']);
assert.deepStrictEqual(EFFORT_LEVELS.map((row: { label: string }) => row.label),
  ['Low', 'Medium', 'High', 'Extra', 'Max']);
assert.strictEqual(normalizeEffort('xhigh'), 'xhigh');
assert.strictEqual(normalizeEffort('bogus'), 'high');
```

Change the permission expectation to:

```js
assert.deepStrictEqual(PRESETS.map((row) => row.label),
  ['Plan', 'Accept edits', 'Bypass permissions', 'Manual']);
```

- [x] **Step 2: Write failing placement tests**

```ts
const assert = require('node:assert');
const { placePopover } = require('../electron/renderer/popover_position');
assert.deepStrictEqual(placePopover(
  { left: 900, right: 980, top: 700, bottom: 728 },
  { width: 280, height: 260 },
  { width: 1024, height: 768 },
), { left: 700, top: 436 });
```

- [x] **Step 3: Run RED**

```powershell
node --require tsx/cjs tests/effort_levels_render_test.ts
node --require tsx/cjs tests/popover_position_test.ts
node tests/permission_presets_render_test.js
```

Expected: missing modules and old permission labels.

- [x] **Step 4: Implement the pure catalogs and placement helper**

`placePopover` places above with a 4 px gap, aligns popup right edge to the
trigger, and clamps every edge to a 12 px viewport margin. `normalizeEffort`
accepts only the five identifiers and falls back to `high`.

- [x] **Step 5: Run GREEN**

Run the three commands from Step 3; expected all pass.

---

### Task 2: Rebuild composer and account popups

**Files:**
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/renderer/claude_chat.css`
- Modify: `electron/renderer/claude_shell.css`
- Modify: `tests/studio_composer_states_test.js`
- Modify: `tests/studio_navigation_interaction_test.js`

- [x] **Step 1: Write failing structure contracts**

Require `#composer-effort`, five effort rows produced by the catalog,
`#composer-voice` outside the effort popup, `#account-menu`, complete
`.dshw-perm-row*`/`.dshw-perm-check` CSS, and forbid `Response style`,
`composer-style`, and Voice inside the popup.

- [x] **Step 2: Run RED**

```powershell
node tests/studio_composer_states_test.js
node tests/studio_navigation_interaction_test.js
```

- [x] **Step 3: Implement one popup controller**

Use `placePopover(trigger.getBoundingClientRect(), popup size, viewport)` after
temporarily revealing the popup. Opening a popup closes the other composer and
account popups. Escape/outside click restores `aria-expanded=false`; selected
rows carry `aria-selected=true`, and the first selected row receives focus.

- [x] **Step 4: Implement complete popup CSS**

Permission/effort rows use a 20 px leading slot, flexible two-line copy and a
16 px trailing check. Set explicit SVG dimensions so no browser-default SVG can
escape. Menus use 200 px minimum, 360 px maximum, 4 px padding, measured border,
radius and shadow; they never use the old shared `right:32px; bottom:42px` rule.

- [x] **Step 5: Bind truthful account actions**

Settings calls `show('settings')`; Models & runtime opens its settings section;
Check for updates calls `Data.checkForUpdates()`; changelog delegates a new
`window:command` action; shortcuts/about reuse `executeWindowMenuCommand`.

- [x] **Step 6: Run GREEN**

Run both Step 2 commands plus `node tests/studio_update_card_contract_test.js`.

---

### Task 3: Carry effort through Runtime and model requests

**Files:**
- Create: `app/agent_runtime/effort.py`
- Create: `tests/agent_runtime_effort_test.py`
- Modify: `tests/conversation_bridge_test.py`
- Modify: `tests/ai_client_request_config_test.py`
- Modify: `electron/renderer/data.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Modify: `scripts/conversation_bridge.py`
- Modify: `app/agent_runtime/system_prompt.py`
- Modify: `app/agent_runtime/model_client.py`
- Modify: `app/ai_client.py`

- [x] **Step 1: Write failing Python contracts**

```py
from app.agent_runtime.effort import effort_instruction, normalize_effort

def test_effort_catalog_and_fallback():
    assert normalize_effort('xhigh') == 'xhigh'
    assert normalize_effort('bogus') == 'high'
    assert 'deepest available analysis' in effort_instruction('max')
```

Add a bridge test passing `"effort":"xhigh"` and assert
`answer_conversation(... effort="xhigh")`. Add payload tests asserting
chat-completions receives `reasoning_effort: "xhigh"` and messages mode does
not invent an unsupported provider field.

- [x] **Step 2: Run RED**

```powershell
python -m pytest tests/agent_runtime_effort_test.py tests/conversation_bridge_test.py tests/ai_client_request_config_test.py -q --basetemp=data/runtime/pytest-tmp-effort-red
```

- [x] **Step 3: Replace reply-style transport**

Renderer sends `effort`; preload/main validate to the five identifiers;
conversation bridge normalizes with `app.agent_runtime.effort` and puts the
value in Runtime context. Remove the reply-style section and add an `Effort`
section whose text comes from `effort_instruction`.

- [x] **Step 4: Add native OpenAI-compatible effort with bounded fallback**

`_messages_payload` and `_text_completion_payload` add
`reasoning_effort=<canonical>` only in chat-completions mode. On an HTTP 4xx
that can be caused by optional request fields, retry once after removing
`reasoning_effort` (and the existing optional `thinking` field where present).
The system prompt remains, so removal does not make the UI choice inert.

- [x] **Step 5: Run GREEN**

Run Step 2 plus `python -m pytest tests/agent_runtime_ai_backend_test.py -q
--basetemp=data/runtime/pytest-tmp-effort-adjacent`.

---

### Task 4: Make home tabs, ranges, models and heatmap real

**Files:**
- Modify: `tests/studio_home_stats_test.ts`
- Modify: `tests/studio_home_render_test.ts`
- Modify: `electron/studio_home_stats.ts`
- Modify: `electron/renderer/studio_home.ts`
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/claude_shell.css`

- [x] **Step 1: Write failing range/model projection tests**

Build fixtures spanning 45 days and assert all/30d/7d message totals differ,
model rows expose input/output totals and percentages, and each range has a
daily token series of the matching length.

- [x] **Step 2: Write failing render contracts**

Assert real `button[role=tab]` markup, selected state changes, Models markup has
daily bars/model rows, and heatmap cells have `tabindex=0`, a tooltip string and
no fake navigation href.

- [x] **Step 3: Run RED**

```powershell
node --require tsx/cjs tests/studio_home_stats_test.ts
node --require tsx/cjs tests/studio_home_render_test.ts
```

- [x] **Step 4: Expand the bounded projection**

Refactor the projector around one aggregate helper and return slices under
`ranges.all`, `ranges['30d']`, and `ranges['7d']`. Each slice contains overview
metrics, heatmap, per-model input/output/total/turn/share rows and daily totals.
Keep the existing top-level fields as the all-range compatibility projection.

- [x] **Step 5: Bind the renderer state**

Keep module-owned `homeView` and `homeRange`; bind controls once, update
`aria-selected`, and rerender from cached stats without another IPC request.
Create one delayed positioned tooltip host used by pointer hover, focus and
click.

- [x] **Step 6: Run GREEN**

Run Step 3 plus `node tests/studio_claude_fidelity_contract_test.js`.

---

### Task 5: Correct update visibility and prove real clicks

**Files:**
- Modify: `tests/update_manager_test.js`
- Modify: `tests/studio_update_card_contract_test.js`
- Modify: `electron/update_manager.ts`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/main.ts`
- Create: `scripts/probe_studio_interactions.ts`
- Create: `tests/studio_interaction_probe_test.js`

- [x] **Step 1: Write failing update visibility tests**

Automatic check failure must settle to hidden `idle`; manual failure still
opens one dialog. Renderer contract permits only available/downloading/downloaded
to unhide the card.

- [x] **Step 2: Write the real-input probe contract**

The probe loads built Studio with deterministic preload data, obtains the centre
of each highlighted trigger, calls `webContents.sendInputEvent` for mouse down/up,
and emits JSON for popup visibility/bounds, tab/range selection, account menu,
heatmap tooltip and console errors. Test fails if a click has no corresponding
state change or any popup exceeds the viewport.

- [x] **Step 3: Run RED**

```powershell
node tests/update_manager_test.js
npm run build:electron
node tests/studio_interaction_probe_test.js
```

- [x] **Step 4: Implement update settlement and changelog action**

Automatic errors publish `idle` after logging; manual errors remain dialog-only.
Renderer hides checking/current/error. Add main-process `changelog` command that
opens the repository Releases HTTPS URL.

- [x] **Step 5: Run GREEN and inspect screenshot witness**

Run Step 3. Capture the interaction end state to
`data/runtime/studio-claude-interactions-20260905.png` and inspect it for menu
alignment, clipping, row density and selected states.

---

### Task 6: Fresh verification, ledgers and commit

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`

- [x] **Step 1: Run focused suites**

Run every command named above from a fresh process. Fix only concrete failures
and rerun affected commands.

- [x] **Step 2: Run full gates**

```powershell
npm run typecheck
npm test
npm run lint
python -m pytest tests -q --basetemp=data/runtime/pytest-tmp-studio-interactions-full
npm run build:electron
git diff --check
```

- [x] **Step 3: Review the complete diff against the approved specification**

Verify every highlighted control has an observable state transition, effort is
not a tone alias, automatic update failures stay quiet, and no unrelated user
files changed.

- [x] **Step 4: Update progress truth without changing the version**

Record exact test counts, probe evidence and honest remaining boundaries in both
ledgers. Do not edit `package.json` or `package-lock.json`; do not run the version
bump step. The user requested a commit rather than an installed-version delivery.

- [x] **Step 5: Commit**

```powershell
git add electron app scripts tests docs
git commit -m "fix: make Studio Claude controls fully interactive"
```

Expected: a clean worktree on `main`, package version still `1.0.33`, and the
final commit contains only this correction batch.

---

## Inline execution choice

The user approved the design and explicitly said to continue in this session.
Execute inline with `superpowers:executing-plans`. Do not dispatch subagents.
