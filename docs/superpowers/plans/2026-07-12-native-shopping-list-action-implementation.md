# Native Shopping List Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user prohibits subagents, so execute inline in the current session.

**Goal:** Make `Add this` perform a real, verified, reversible write into a persistent Magic Pointer shopping-list Dashboard instead of returning an answer.

**Architecture:** Add a versioned Python ShoppingListStore and typed internal shopping-list actions to the existing SafeActionExecutor. A strict local intent parser creates an auto-executable proposal only from a reliable SelectionSnapshot; Electron owns the trusted auto-execution allowlist and a normal context-isolated DashboardWindow that reads and mutates the list through narrow Python bridges.

**Tech Stack:** Python dataclasses/JSON/atomic `Path.replace`, existing ActionProposal/SafeActionExecutor, Electron 43 CommonJS, context-isolated IPC, Node `assert`, pytest.

## Global Constraints

- `Add this` must write a real Dashboard item and verify it by reading storage back; answer-only output is failure.
- Default destination is `magic-pointer://dashboard/shopping-list/default`.
- Shopping-list add is auto-executable only when a strict local parser, reliable current SelectionSnapshot, internal action allowlist, internal target URI, and no-confirm policy all agree.
- Model-produced action text never grants auto-execution.
- Item text is 1—160 characters and at most two lines; longer selections fail closed.
- The persistent list lives under Electron `app.getPath('userData')`, never in the Git workspace.
- Every successful add returns an item receipt and precise undo proposal; retrying the same idempotency key cannot duplicate an item.
- Dashboard renderer has no Node integration and never renders arbitrary HTML.
- Do not execute `rm`; do not stage the user PDF or prior handoff document.

---

## File Structure

- Create `app/dashboard/__init__.py`: exports Dashboard store types.
- Create `app/dashboard/shopping_list.py`: versioned store, validation, atomic persistence, add/check/undo operations.
- Create `app/actions/shopping_list.py`: strict intent parser, proposal factories, target URI, idempotency hashing.
- Create `electron/internal_action_policy.js`: pure allowlist decision for trusted auto-execution.
- Create `scripts/shopping_list_bridge.py`: list/check/undo Dashboard bridge using typed executor where state changes occur.
- Create `electron/renderer/dashboard.html`, `dashboard.css`, `dashboard.js`: native Dashboard shopping-list GUI.
- Create `tests/shopping_list_store_test.py`, `shopping_list_action_test.py`, `internal_action_policy_test.js`, `dashboard_static_test.js`.
- Modify `app/actions/executor.py`, `policy.py`, `__init__.py`: support three shopping-list action types.
- Modify `scripts/selection_bridge.py`, `action_bridge.py`: produce and execute local list actions and return receipts.
- Modify `electron/main.js`, `preload.js`, `package.json`: auto-execution, Dashboard window/hotkey/IPC, test registration, user-data environment.
- Modify `PRODUCT_PROGRESS_ALIGNMENT_20260712.md`: record real action evidence and next action priorities.

---

### Task 1: Persistent, Versioned ShoppingListStore

**Files:**
- Create: `app/dashboard/__init__.py`
- Create: `app/dashboard/shopping_list.py`
- Create: `tests/shopping_list_store_test.py`

**Interfaces:**
- Produces: `ShoppingListStore(root: Path | None = None)`.
- Produces: `add_item(text, idempotency_key, source, now=None) -> dict`.
- Produces: `set_checked(item_id, checked, expected_updated_at, now=None) -> dict`.
- Produces: `undo_add(item_id, receipt_id, expected_updated_at, now=None) -> dict`.
- Produces: `public_list() -> dict` containing active items and monotonically increasing `revision`.

- [ ] **Step 1: Write failing store tests**

Use pytest `tmp_path` and assert:

```python
store = ShoppingListStore(tmp_path)
first = store.add_item(
    "  1 lb   Spaghetti  ",
    idempotency_key="key-1",
    source={"selection_snapshot_id": "snap-1", "app": "pdf"},
    now="2026-07-12T10:00:00+08:00",
)
assert first["created"] is True
assert first["item"]["text"] == "1 lb Spaghetti"
assert store.public_list()["items"][0]["id"] == first["item"]["id"]

retry = store.add_item("1 lb Spaghetti", idempotency_key="key-1", source={}, now="2026-07-12T10:01:00+08:00")
assert retry["created"] is False
assert len(store.public_list()["items"]) == 1

checked = store.set_checked(first["item"]["id"], True, first["item"]["updated_at"], now="2026-07-12T10:02:00+08:00")
assert checked["item"]["checked"] is True

with pytest.raises(ShoppingListConflict):
    store.undo_add(first["item"]["id"], first["receipt_id"], first["item"]["updated_at"])
```

Also test empty, 161 characters, three lines, corrupted JSON, schema version 2, same text with different keys, and reload persistence.

- [ ] **Step 2: Run RED**

Run: `python -m pytest -q tests\shopping_list_store_test.py`

Expected: import error for `app.dashboard.shopping_list`.

- [ ] **Step 3: Implement store and atomic persistence**

The initial state is:

```python
{"version": 1, "revision": 0, "list": {"id": "default-shopping-list", "name": "购物清单", "items": [], "receipts": []}}
```

Default root resolution:

```python
base = Path(os.environ["MAGIC_POINTER_USER_DATA_DIR"])
self.path = base / "dashboard" / "shopping_list.json"
```

Tests pass an explicit root. `_save` writes `shopping_list.json.tmp`, flushes, then calls `Path.replace(self.path)`. `_load` raises `ShoppingListDataError` for malformed JSON or unknown version and never overwrites it.

Normalize text with `" ".join(text.replace("\r", "\n").split())`, while checking the original logical line count before folding whitespace. Each state mutation increments `revision` and updates only the target item.

- [ ] **Step 4: Run GREEN and full Python tests**

Run: `python -m pytest -q tests\shopping_list_store_test.py && python -m pytest -q`

Expected: focused tests pass and total Python tests increase above 64.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- app/dashboard/__init__.py app/dashboard/shopping_list.py tests/shopping_list_store_test.py
git diff --cached --check
git diff --cached --diff-filter=D --name-status
git commit -m "feat: persist verified dashboard shopping items"
```

---

### Task 2: Typed Add, Check, and Undo Actions

**Files:**
- Create: `app/actions/shopping_list.py`
- Create: `tests/shopping_list_action_test.py`
- Modify: `app/actions/executor.py`
- Modify: `app/actions/policy.py`
- Modify: `app/actions/__init__.py`
- Modify: `scripts/action_bridge.py`
- Modify: `tests/action_bridge_test.py`

**Interfaces:**
- Produces: `wants_shopping_list_add(command: str) -> bool`.
- Produces: `make_shopping_list_add_proposal(context, command, selection_session_id, selection_snapshot_id) -> ActionProposal | None`.
- Produces action types `shopping_list_add`, `shopping_list_set_checked`, `shopping_list_undo_add`.

- [ ] **Step 1: Write parser and proposal RED tests**

```python
assert wants_shopping_list_add("Add this")
assert wants_shopping_list_add("把这个加入购物清单")
assert not wants_shopping_list_add("Explain this")
assert not wants_shopping_list_add("Add more detail to this paragraph")

proposal = make_shopping_list_add_proposal(
    AdapterReadContext(app="pdf", content="1 lb Spaghetti", ...),
    command="Add this",
    selection_session_id="session-1",
    selection_snapshot_id="snap-1",
)
assert proposal.action_type == "shopping_list_add"
assert proposal.target.object_id == "magic-pointer://dashboard/shopping-list/default"
assert proposal.confirmation_required is False
assert proposal.metadata["trusted_local_intent"] is True
```

- [ ] **Step 2: Run RED**

Run: `python -m pytest -q tests\shopping_list_action_test.py`

Expected: missing module/functions.

- [ ] **Step 3: Implement strict intent and proposal factories**

Accept only normalized full-command patterns equivalent to `add this`, `add it to (the/my) shopping list`, `添加这个`, `加入清单`, `加到购物清单`, and `把这个加入购物清单`. Do not use substring-only `"add" in command` logic.

The proposal uses SafetyLevel.LOW, `confirmation_required=False`, target metadata `{provider: "magic_pointer_dashboard", destination: "shopping_list", list_id: "default-shopping-list"}`, and metadata `{trusted_local_intent: True, auto_execute: True}`. Idempotency is SHA-256 of list ID, snapshot ID, normalized text, and canonical intent.

- [ ] **Step 4: Add executor RED tests**

Inject `ShoppingListStore(tmp_path)` into `SafeActionExecutor`. Execute add with `confirmed=False`; assert succeeded, `verified is True`, item exists, and output contains a `shopping_list_undo_add` proposal. Execute undo with the returned expected version; assert only that item becomes removed. Execute set_checked with stale version; assert failed and original state preserved.

- [ ] **Step 5: Implement executor and policy**

Extend `SafeActionExecutor.__init__` with `shopping_list_store`. Add all three action types to `SUPPORTED_ACTION_TYPES`. Policy treats only these internal target-bound actions according to their explicit LOW confirmation setting; it does not add them to external `WRITE_ACTIONS`.

`_shopping_list_add` calls store, rereads `public_list`, verifies item identity/text/idempotency, and returns:

```python
{
  "verified": True,
  "receipt_id": result["receipt_id"],
  "item": result["item"],
  "list_id": "default-shopping-list",
  "created": result["created"],
  "undo_proposal": make_shopping_list_undo_proposal(...).to_dict(),
}
```

- [ ] **Step 6: Update action bridge responses**

Successful add answer is `已加入购物清单。`; checked/undo messages are specific. `_followup_proposals` already forwards typed undo output. Add subprocess tests using `MAGIC_POINTER_USER_DATA_DIR` pointing to a test temp directory.

- [ ] **Step 7: Run GREEN and commit Task 2**

Run: `python -m pytest -q tests\shopping_list_action_test.py tests\action_bridge_test.py && python -m pytest -q`

Then stage the exact Task 2 files and commit:

```powershell
git commit -m "feat: execute reversible shopping list actions"
```

---

### Task 3: Route `Add this` Around the Question Model and Auto-Execute Safely

**Files:**
- Create: `electron/internal_action_policy.js`
- Create: `tests/internal_action_policy_test.js`
- Modify: `scripts/selection_bridge.py`
- Modify: `tests/selection_bridge_test.py`
- Modify: `electron/main.js`
- Modify: `package.json`

**Interfaces:**
- Produces selection result fields `autoExecuteProposalId` and `intentKind="shopping_list_add"` only from local parser branch.
- Produces JS `canAutoExecuteInternalProposal(parsed, proposal) -> boolean`.

- [ ] **Step 1: Write selection bridge RED test**

Construct a non-expired snapshot with `AdapterReadContext.content="1 lb Spaghetti"`, monkeypatch `ask_text_model` to raise if called, invoke a new pure `build_selection_response(payload)` entry, and assert:

```python
assert output["ok"] is True
assert output["intentKind"] == "shopping_list_add"
assert output["autoExecuteProposalId"] == output["actionProposals"][0]["id"]
assert output["answer"] == "正在加入购物清单…"
```

Unsupported/empty context must return no action proposal.

- [ ] **Step 2: Implement local branch before model calls**

After snapshot validation and before Word rewrite/general `ask_text_model`, call `wants_shopping_list_add`. Build the typed proposal only from current `app_ctx.content`. Refactor `main()` minimally into `build_selection_response(payload)` plus JSON printing so tests exercise real response construction.

- [ ] **Step 3: Write JS auto-execution policy RED tests**

Accept only when all are exact:

```js
parsed.intentKind === 'shopping_list_add'
parsed.autoExecuteProposalId === proposal.id
proposal.action_type === 'shopping_list_add'
proposal.confirmation_required === false
proposal.target.object_id === 'magic-pointer://dashboard/shopping-list/default'
proposal.metadata.trusted_local_intent === true
proposal.metadata.auto_execute === true
```

Flip each field individually and assert false. Assert model-like payload without `intentKind` is rejected.

- [ ] **Step 4: Implement Electron policy and main orchestration**

Add shopping action types to `ALLOWED_ACTION_TYPES`. After `registerActionProposals`, find the proposal matching `autoExecuteProposalId`; call the pure policy. If false, preserve normal result behavior. If true, call `executeActionForTarget` with its one-time token and `confirmed:false`.

Extend `executeActionForTarget(payload, target, options={})` so its bridge completion can invoke `options.onComplete(parsed)` after session checks. Auto-add completion sends the action result to Panel and calls `showDashboard({ highlightItemId })` implemented in Task 4. Never auto-execute more than one proposal.

Set bridge environment:

```js
MAGIC_POINTER_USER_DATA_DIR: app.getPath('userData')
```

- [ ] **Step 5: Run Node/Python tests and commit Task 3**

Run: `npm test && python -m pytest -q`

Commit exact files with message `feat: route add-this into trusted local actions`.

---

### Task 4: Native Shopping-List Dashboard Window

**Files:**
- Create: `scripts/shopping_list_bridge.py`
- Create: `electron/renderer/dashboard.html`
- Create: `electron/renderer/dashboard.css`
- Create: `electron/renderer/dashboard.js`
- Create: `tests/dashboard_static_test.js`
- Create: `tests/shopping_list_bridge_test.py`
- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `package.json`

**Interfaces:**
- Produces preload `magicPointerDashboard.close/listRequest/setChecked/undoItem/onListUpdated/onError`.
- Produces IPC `dashboard:list-request`, `dashboard:set-checked`, `dashboard:undo-item`, `dashboard:close`.
- Produces global shortcut `Control+Alt+D` to toggle Dashboard.

- [ ] **Step 1: Write bridge tests and confirm RED**

Invoke `scripts/shopping_list_bridge.py` with an isolated user-data directory. Test `list`, `set_checked`, and `undo_item`; mutations must construct typed ActionProposal objects and execute through SafeActionExecutor, not call private store mutation methods directly from untrusted payload.

- [ ] **Step 2: Implement bridge**

Input schema is `{mode, itemId?, checked?, expectedUpdatedAt?, receiptId?}`. Reject unknown keys/types and unknown modes. Output `{ok, list, executionResult?}`. No command can specify a filesystem path.

- [ ] **Step 3: Write Dashboard static RED test**

Assert:

- HTML contains `id="shopping-list"`, `id="shopping-empty"`, `id="dashboard-close"`.
- renderer creates item text with `textContent`, never `innerHTML`.
- checkbox change includes item ID and `expectedUpdatedAt`.
- preload exposes only narrow Dashboard methods.
- BrowserWindow uses `contextIsolation:true`, `nodeIntegration:false`, is resizable, and is not `skipTaskbar:true`.
- main registers `Control+Alt+D` and refreshes Dashboard after verified shopping add.

- [ ] **Step 4: Implement Dashboard renderer**

Use a 48px navigation rail with Shopping List selected, header counts, scrollable item list, and empty state. Each item is built with `document.createElement`; source is a subdued single line. New `highlightItemId` receives a 1.2s CSS animation and `scrollIntoView({block:'nearest'})`. Checkbox and undo buttons are keyboard accessible.

- [ ] **Step 5: Implement Dashboard lifecycle and IPC**

Create an 860×640 normal BrowserWindow. `showDashboard({highlightItemId})` positions it on the right side of the cursor display, calls `showInactive()`, then requests current list and sends `dashboard:list-updated`. `Ctrl+Alt+D` toggles visibility without cancelling pointer sessions.

Every list/check/undo bridge call uses the fixed script and user-data environment. After mutations, main rereads the list and sends it; stale renderer responses are guarded with a request nonce.

- [ ] **Step 6: Run tests, generate visual preview, and commit Task 4**

Run `npm test && python -m pytest -q`. Add `scripts/capture_dashboard_preview.js`, generate `data/runtime/dashboard_shopping_list_preview_20260712.png`, inspect it, and perform at most one structural visual correction. Commit with `feat: add native shopping list dashboard`.

---

### Task 5: End-to-End Action Verification and Progress Record

**Files:**
- Modify: `PRODUCT_PROGRESS_ALIGNMENT_20260712.md`
- Modify implementation/tests only for deterministic defects discovered during verification.

- [ ] **Step 1: Fresh automated verification**

Run:

```powershell
npm test
python -m pytest -q
git diff --check
git diff --diff-filter=D --name-status
```

- [ ] **Step 2: Restart latest Magic Pointer without deletion commands**

Stop only the PID in `data/runtime/electron.pid` with `Stop-Process`; start the current Electron entry hidden. Confirm app ready and both `Ctrl+Alt+M` and `Ctrl+Alt+D` register.

- [ ] **Step 3: Verify a real source action**

In Edge/Word/WPS select `1 lb Spaghetti`, submit `Add this`, and verify:

- no general model answer is generated;
- log shows trusted internal auto-execution exactly once;
- Dashboard appears with the actual item highlighted;
- persisted JSON under Electron userData contains the item;
- bridge output says `verified=true`;
- retrying the identical captured request does not duplicate;
- a new SelectionSnapshot with the same text can add a second item.

If foreground automation cannot be controlled without interrupting the user, run the exact frozen snapshot payload through `selection_bridge.py` and `action_bridge.py`, then require the user to perform only the final visible-source gesture; do not claim the UI gesture passed automatically.

- [ ] **Step 4: Verify check, restart, and undo**

Check the item in Dashboard, restart Magic Pointer, reopen with `Ctrl+Alt+D`, and confirm checked state persists. Undo the add with its receipt; confirm only the target item becomes hidden. Test a stale expected version and confirm conflict without overwrite.

- [ ] **Step 5: Update ledger and final allowlist commit**

Record commit hashes, test counts, data path, screenshot, real-action evidence, and any manual-only gate. Stage only the ledger and deterministic fixes; leave the user PDF and handoff untracked.

---

## Plan Self-Review Result

- Spec coverage: persistent Dashboard data, strict intent, typed actions, trusted auto-execution, write verification, idempotency, visible GUI result, check persistence, receipt undo, and real source verification each map to a task.
- Security: renderer cannot choose paths or arbitrary action types; automatic execution requires redundant local parser, target, metadata, policy, and allowlist checks.
- Scope: arbitrary webpage writes, cloud sync, multiple lists, calendar, route, table merge, reservation, and image canvas remain outside this first action slice.
- Type consistency: item IDs, receipt IDs, expected timestamps, `autoExecuteProposalId`, target URI, and Dashboard IPC names remain consistent across tasks.
- Placeholder scan: no placeholder markers or unspecified implementation steps remain.
