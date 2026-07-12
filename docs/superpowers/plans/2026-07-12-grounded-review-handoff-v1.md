# Grounded Review Handoff V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a usable Windows-first loop that remembers review comments across PDF pages or applications, compiles them into a grounded improvement prompt, and writes the draft into a user-designated GUI or CLI input surface without sending it.

**Architecture:** A persistent Python `ReviewSessionStore` owns review sessions and evidence anchors independently from the existing two-minute selection session. `selection_bridge.py` routes explicit Chinese/English review commands into that store and emits either a saved-anchor receipt, a compiled prompt artifact, or a typed `paste_text_to_foreground` proposal. The existing Electron action-token path executes the proposal through a Windows UI Automation helper, revalidates the selected window, focuses the user-indicated point, writes the draft, and verifies accessible text where possible; it never emits Enter.

**Tech Stack:** Python 3 standard library, Windows UI Automation through a small compiled C# helper, Electron/CommonJS, pytest, Node static tests.

## Global Constraints

- Do not start sub-agents.
- Do not execute `rm` or delete unrelated files.
- Preserve untracked user files and stage only explicit implementation paths.
- Never send or press Enter in a target Agent; V1 only writes a review draft.
- Review anchors must retain document/page/selection evidence and the user's verbatim instruction.
- Destructive or external actions are outside this plan.
- Every production behavior follows RED → GREEN → REFACTOR.

---

## File Structure

- Create `app/review/__init__.py`: public review-domain exports.
- Create `app/review/session.py`: persistent review session and anchor store with atomic JSON writes.
- Create `app/review/compiler.py`: deterministic, source-grounded prompt compiler.
- Create `app/actions/draft_delivery.py`: validates target identity and creates `paste_text_to_foreground` proposals.
- Create `scripts/uia_draft_writer.cs`: generic Windows input-surface writer; no product-specific Agent logic.
- Modify `app/actions/executor.py`: execute the typed draft-delivery proposal and verify helper output.
- Modify `app/actions/policy.py`: classify explicit draft writing as a bounded local write.
- Modify `scripts/action_bridge.py`: present a human-readable delivery result.
- Modify `scripts/selection_bridge.py`: recognize review record/compile/deliver commands before generic AI answering.
- Modify `scripts/selection_snapshot_bridge.py`: make review-recording available as a suggested command for grounded selections.
- Modify `electron/main.js`: auto-run only an explicitly requested, bounded draft-delivery proposal after hiding Magic Pointer surfaces so the original target can be restored.
- Modify `electron/internal_action_policy.js`: permit only the verified review-draft auto-execution contract.
- Modify `electron/renderer/panel.js`, `result.js`, and `reader.js`: label review receipts and draft delivery accurately.
- Add focused Python and Node tests for all new behavior.
- Update `PRODUCT_DIRECTION_PIVOT_USER_RESEARCH_20260712.md` and `PRODUCT_PROGRESS_ALIGNMENT_20260712.md` with the approved dual-output architecture and real V1 status.

---

### Task 1: Persistent multi-page review sessions

**Files:**
- Create: `app/review/__init__.py`
- Create: `app/review/session.py`
- Test: `tests/review_session_test.py`

**Interfaces:**
- Consumes: `AdapterReadContext.to_dict()` data already embedded in `selectionSnapshot.context`.
- Produces: `ReviewSessionStore.record(snapshot, instruction) -> dict`, `ReviewSessionStore.active() -> dict | None`, `ReviewSessionStore.finish() -> dict`, and stable `session_id` / `anchor_id` values.

- [ ] **Step 1: Write the failing persistence and multi-page test**

```python
def test_review_store_keeps_pdf_page_anchors_across_processes(tmp_path):
    store = ReviewSessionStore(root=tmp_path, id_factory=iter(["review-1", "anchor-1", "anchor-2"]).__next__)
    first = store.record(pdf_snapshot(page=2, text="Figure 2"), "图注和正文不一致")
    second = store.record(pdf_snapshot(page=7, text="Table 4"), "这个表格的单位需要统一")
    reopened = ReviewSessionStore(root=tmp_path).active()
    assert first["session_id"] == second["session_id"] == "review-1"
    assert [item["page_number"] for item in reopened["anchors"]] == [2, 7]
    assert reopened["anchors"][0]["instruction"] == "图注和正文不一致"
```

- [ ] **Step 2: Run test to verify RED**

Run: `python -m pytest tests/review_session_test.py -q`

Expected: collection fails because `app.review.session` does not exist.

- [ ] **Step 3: Implement minimal normalized storage**

Implement an atomic JSON store under `${MAGIC_POINTER_USER_DATA_DIR}/review/review_sessions.json`. A recorded anchor contains `anchor_id`, `sequence`, `instruction`, `captured_at`, `source_window`, `app`, `method`, `document_path`, `document_label`, `page_number`, `selected_text`, `surrounding_context`, `selection_rectangles`, and `snapshot_id`. Reject blank instructions and snapshots without a grounded context.

- [ ] **Step 4: Run focused and regression tests**

Run: `python -m pytest tests/review_session_test.py tests/selection_snapshot_bridge_test.py -q`

Expected: all pass.

- [ ] **Step 5: Commit explicit files**

Run: `git add app/review/__init__.py app/review/session.py tests/review_session_test.py && git commit -m "feat: persist grounded review sessions"`

---

### Task 2: Grounded improvement prompt compiler

**Files:**
- Create: `app/review/compiler.py`
- Test: `tests/review_compiler_test.py`

**Interfaces:**
- Consumes: normalized session dictionaries from `ReviewSessionStore`.
- Produces: `compile_review_prompt(session, global_context="") -> str` and `write_prompt_artifact(session, prompt, root=None) -> Path`.

- [ ] **Step 1: Write failing compiler tests**

```python
def test_compiler_preserves_verbatim_notes_and_page_order():
    prompt = compile_review_prompt(session_with_pages(7, 2))
    assert prompt.index("第 2 页") < prompt.index("第 7 页")
    assert "用户原话：图注和正文不一致" in prompt
    assert "不要修改未被指出的内容" in prompt
    assert "完成后逐项报告" in prompt
```

Add a second test proving that non-PDF anchors use application/window labels rather than inventing page numbers and that long exact selections are excerpted without losing the artifact path.

- [ ] **Step 2: Run test to verify RED**

Run: `python -m pytest tests/review_compiler_test.py -q`

Expected: import failure for `app.review.compiler`.

- [ ] **Step 3: Implement the deterministic compiler**

The generated prompt must contain: role and objective, artifact identity, unchanged-scope constraint, ordered evidence ledger, exact user instruction for every anchor, selected/surrounding evidence, an execution checklist, verification requirements, and a structured completion report. It must label added guidance as execution guidance rather than user speech.

- [ ] **Step 4: Run focused tests**

Run: `python -m pytest tests/review_compiler_test.py tests/review_session_test.py -q`

Expected: all pass.

- [ ] **Step 5: Commit explicit files**

Run: `git add app/review/compiler.py tests/review_compiler_test.py && git commit -m "feat: compile grounded review prompts"`

---

### Task 3: Review intents in the selection bridge

**Files:**
- Modify: `scripts/selection_bridge.py`
- Modify: `scripts/selection_snapshot_bridge.py`
- Test: `tests/review_selection_bridge_test.py`
- Test: `tests/selection_snapshot_bridge_test.py`

**Interfaces:**
- Consumes: command and `selectionSnapshot` payload from Electron.
- Produces: intent kinds `review_anchor_recorded`, `review_prompt_compiled`, and `review_draft_delivery`; compiled results include `reviewSession`, `promptArtifact`, and typed action proposals.

- [ ] **Step 1: Write failing bridge tests**

Use a subprocess with an isolated `MAGIC_POINTER_USER_DATA_DIR`. Verify `验收：这里字号太小` records one anchor, a second process records another page into the same session, `整理验收意见` returns a prompt artifact, and `把验收意见填到这里` returns exactly one `paste_text_to_foreground` proposal carrying target `hwnd`, original cursor point, prompt text, prompt hash, and `submit=False`.

- [ ] **Step 2: Run test to verify RED**

Run: `python -m pytest tests/review_selection_bridge_test.py -q`

Expected: generic AI path is taken or expected intent kinds are absent.

- [ ] **Step 3: Implement explicit intent parsing and responses**

Record prefixes: `验收：`, `验收:`, `记录问题：`, `批注：`, `review:`. Compile phrases: `整理验收意见`, `生成改进提示词`, `compile review`. Delivery phrases: `把验收意见填到这里`, `填入这里`, `写到这个输入框`, `deliver review here`. Explicitly refuse delivery when there is no active review, no compiled prompt, no target HWND, or no pointer location.

- [ ] **Step 4: Run bridge regression tests**

Run: `python -m pytest tests/review_selection_bridge_test.py tests/selection_bridge_test.py tests/selection_snapshot_bridge_test.py -q`

Expected: all pass.

- [ ] **Step 5: Commit explicit files**

Run: `git add scripts/selection_bridge.py scripts/selection_snapshot_bridge.py tests/review_selection_bridge_test.py tests/selection_snapshot_bridge_test.py && git commit -m "feat: route grounded review commands"`

---

### Task 4: Generic GUI/CLI draft writer

**Files:**
- Create: `app/actions/draft_delivery.py`
- Create: `scripts/uia_draft_writer.cs`
- Modify: `app/actions/executor.py`
- Modify: `app/actions/policy.py`
- Modify: `scripts/action_bridge.py`
- Test: `tests/draft_delivery_test.py`
- Test: `tests/action_bridge_test.py`

**Interfaces:**
- Consumes: a `paste_text_to_foreground` proposal with immutable target window identity, point, text, SHA-256, and `submit=False`.
- Produces: verified `ExecutionResult.output` fields `target_hwnd`, `target_title`, `written_chars`, `method`, `verified`, and `submit_sent=False`.

- [ ] **Step 1: Write failing proposal and executor tests**

Test that proposal construction rejects blank text, hashes the exact Unicode prompt, records the target HWND/title/process, and forces `submit=False`. Inject a fake draft writer into `SafeActionExecutor` and verify dispatch succeeds only when the helper reports matching HWND, exact written length, and no submit. Verify a helper response with `submit_sent=True` fails closed.

- [ ] **Step 2: Run test to verify RED**

Run: `python -m pytest tests/draft_delivery_test.py tests/action_bridge_test.py -q`

Expected: import or unsupported-action failure.

- [ ] **Step 3: Implement the generic writer contract**

The C# helper receives base64 JSON, validates the target top-level HWND still exists, restores that window, focuses the accessible element at the recorded screen point, rejects password controls, prefers `ValuePattern.SetValue`, falls back to clipboard paste only for a verified editable target, restores the previous clipboard, never sends Enter, and returns JSON. The Python executor compiles the helper on demand using the same cache strategy as `uia_selection_probe.cs`, invokes it with a timeout, and validates all receipt fields.

- [ ] **Step 4: Run focused tests and compile helper**

Run: `python -m pytest tests/draft_delivery_test.py tests/action_bridge_test.py -q`

Run: `powershell -NoProfile -Command "Add-Type -Path scripts/uia_draft_writer.cs"`

Expected: tests pass and C# compiles.

- [ ] **Step 5: Commit explicit files**

Run: `git add app/actions/draft_delivery.py app/actions/executor.py app/actions/policy.py scripts/action_bridge.py scripts/uia_draft_writer.cs tests/draft_delivery_test.py tests/action_bridge_test.py && git commit -m "feat: write review drafts to selected input surfaces"`

---

### Task 5: Electron execution and visible product feedback

**Files:**
- Modify: `electron/internal_action_policy.js`
- Modify: `electron/main.js`
- Modify: `electron/renderer/panel.js`
- Modify: `electron/renderer/result.js`
- Modify: `electron/renderer/reader.js`
- Test: `tests/internal_action_policy_test.js`
- Test: `tests/panel_static_test.js`
- Test: `tests/result_static_test.js`
- Test: `tests/reader_static_test.js`

**Interfaces:**
- Consumes: `autoExecuteProposalId` only for explicit `review_draft_delivery` responses.
- Produces: hide-before-write behavior, a success notification stating that the draft is ready and was not sent, and no accidental stale-session execution.

- [ ] **Step 1: Write failing Node policy/static tests**

Verify the internal policy permits auto-execution only when `intentKind === "review_draft_delivery"`, action type is `paste_text_to_foreground`, `submit === false`, the response proposal ID matches, and the target/source selection session is current. Static tests require a Chinese label equivalent to `填入输入框（不发送）` and success copy equivalent to `草稿已填入，等待你发送`.

- [ ] **Step 2: Run test to verify RED**

Run: `node tests/internal_action_policy_test.js && node tests/panel_static_test.js && node tests/result_static_test.js && node tests/reader_static_test.js`

Expected: new assertions fail.

- [ ] **Step 3: Wire the bounded auto-execution**

Before invoking the action bridge, hide panel/result/reader/overlay without invalidating the selection session. Execute only the policy-approved proposal. On success, show the compact result surface near the pointer; do not reactivate or type into Magic Pointer itself.

- [ ] **Step 4: Run Node and package tests**

Run: `npm test`

Expected: all Node and static tests pass.

- [ ] **Step 5: Commit explicit files**

Run: `git add electron/internal_action_policy.js electron/main.js electron/renderer/panel.js electron/renderer/result.js electron/renderer/reader.js tests/internal_action_policy_test.js tests/panel_static_test.js tests/result_static_test.js tests/reader_static_test.js && git commit -m "feat: complete review draft handoff flow"`

---

### Task 6: End-to-end verification and product alignment ledger

**Files:**
- Create: `tests/grounded_review_handoff_flow_test.py`
- Modify: `PRODUCT_DIRECTION_PIVOT_USER_RESEARCH_20260712.md`
- Modify: `PRODUCT_PROGRESS_ALIGNMENT_20260712.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the complete review store, compiler, bridge, proposal, and executor contract.
- Produces: reproducible CEO verification instructions and a durable ledger separating V1-complete work from the direct Word/Excel action layer and resident diagnostic Agent still to build.

- [ ] **Step 1: Write failing subprocess E2E test**

Record page 2 and page 7 through `selection_bridge.py`, compile, request delivery against a fake target window, and execute with an injected writer receipt. Assert prompt ordering, artifact existence, exact prompt hash, `submit_sent=False`, and persisted session status.

- [ ] **Step 2: Run test to verify RED, then add only missing integration code**

Run: `python -m pytest tests/grounded_review_handoff_flow_test.py -q`

Expected: fail before the final bridge/executor integration, then pass after the smallest necessary correction.

- [ ] **Step 3: Update durable product documents**

Document the approved dual-output model, exact V1 behavior, constraints, manual verification workflow, and next P0 sequence: direct Excel/Word actions followed by the resident local diagnostic Agent. Do not mark either later subsystem complete.

- [ ] **Step 4: Run full verification**

Run: `python -m pytest -q`

Run: `npm test`

Run: `git diff --check`

Expected: all pass with no whitespace errors.

- [ ] **Step 5: Commit explicit files**

Run: `git add tests/grounded_review_handoff_flow_test.py PRODUCT_DIRECTION_PIVOT_USER_RESEARCH_20260712.md PRODUCT_PROGRESS_ALIGNMENT_20260712.md README.md docs/superpowers/plans/2026-07-12-grounded-review-handoff-v1.md && git commit -m "docs: align grounded review handoff progress"`

---

## Self-Review

- Spec coverage: multi-page memory, global prompt compilation, arbitrary GUI/CLI draft input, no send, visible result, and the resident-Agent interface boundary are covered. Direct Excel/Word manipulation and the resident Agent implementation are intentionally tracked as the next independent P0 subprojects rather than falsely included in this V1.
- Placeholder scan: there are no `TBD`, `TODO`, or unspecified “handle errors” steps; every failure condition and test command is explicit.
- Type consistency: all later tasks consume the same normalized session dictionary, `paste_text_to_foreground` action type, `submit=False` invariant, HWND identity, exact prompt hash, and action-token flow introduced in earlier tasks.

