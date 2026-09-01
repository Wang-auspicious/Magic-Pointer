# Harness UX Fix Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and implement every still-valid item in `docs/HANDOFF_20260831_HARNESS_UX_FIX_ORDERS.md`, with real streaming, non-duplicated history, correct context budgets, visible tool/permission behavior, and complete Composer interaction.

**Architecture:** Keep `EventSession` as the only durable conversation truth, keep model protocol projection inside `model_client.py`, keep deterministic permission decisions in `permission_decisions.py`, and keep renderer behavior in the existing Studio/Composer surfaces. Review findings that no longer match the current tree are corrected at their real seam instead of copied literally.

**Tech Stack:** Python 3.12/pytest, Electron 43 + TypeScript 6, Node contract tests, Anthropic Messages/OpenAI chat-completions payloads.

**Shared-worktree rule:** The checkout already contains uncommitted 1.0.32 work from another task. Do not reset it and do not create a detached worktree that loses those edits. Each task gets a RED/GREEN verification checkpoint; commits are deferred unless the pre-existing hunks can be separated without staging someone else's work.

---

### Task 1: Make model streaming real end to end (P0-1)

**Files:**
- Modify: `app/agent_runtime/model_client.py`
- Modify: `app/agent_runtime/loop.py`
- Test: `tests/model_reasoning_stream_test.py`
- Test: `tests/harness_completion_test.py`
- Test: `tests/harness_wiring_test.py`
- Test: `tests/agent_runtime_loop_test.py`

- [ ] Add a failing loop test whose backend yields `a`, `b`, `c` and records production count; consume the async loop only through its first `ModelChunk` and assert only `a` has been produced.
- [ ] Run `python -m pytest tests/model_reasoning_stream_test.py tests/harness_completion_test.py tests/harness_wiring_test.py tests/agent_runtime_loop_test.py -q` and confirm the new test sees all backend deltas produced before the first chunk.
- [ ] Convert `_parse_sse` and `_parse_messages_sse` to `Iterator[ModelTurnEvent]`; yield each `MessageDelta`/`ReasoningDelta` at the frame where it arrives, retain accumulated text only for `TurnDone.raw_text`, and emit complete tool calls at stream end.
- [ ] Convert `_post_streaming` to an iterator whose `yield from _parse_sse(...)` stays inside the HTTP client/response context.
- [ ] In `StreamingMessagesBackend.generate`, buffer only until the first real content event. Before commitment an empty/error stream may fall back; after commitment an exception emits an honest `TurnWithheld` + `TurnDone` and never replays output.
- [ ] Add `LoopModelClient.stream_turn(...)`; buffer retryable empty attempts, forbid retry after any user-visible content, maintain `last_events`, `last_usage`, and `last_reasoning`; implement `generate_turn` as `list(stream_turn(...))` for compatibility.
- [ ] Change the loop to consume `stream_turn` and yield `ModelChunk`/`ReasoningChunk` inline; remove the post-hoc replay fallback.
- [ ] Re-run the four targeted files and confirm all pass.

### Task 2: Remove duplicated conversation history (P0-2)

**Files:**
- Modify: `scripts/conversation_bridge.py`
- Test: `tests/conversation_bridge_test.py`

- [ ] Add a failing test that opens one durable conversation session twice and asserts the second `evidence_input` excludes the first question while `derive_messages()` contains it.
- [ ] Split `_history_text` into `_object_label_text`, `_selection_evidence_text`, and the legacy full-history projection.
- [ ] After opening the session, use only object label + scene evidence for an established session; use the legacy projection once when a pre-existing Electron conversation is first attached to an empty Agent session.
- [ ] Run `python -m pytest tests/conversation_bridge_test.py -q`.

### Task 3: Use one compaction margin and current model windows (P0-3)

**Files:**
- Modify: `app/agent_runtime/model_profiles.py`
- Modify: `app/agent_runtime/loop.py`
- Create: `tests/model_profiles_test.py`
- Test: `tests/agent_runtime_loop_test.py`

- [ ] Add failing tests for longest-prefix matching and current verified families: `gpt-5.6` / `gpt-5.5` / base `gpt-5.4` = 1,050,000, `gpt-5.4-mini` = 400,000, `gpt-5.1` = 400,000, `claude-opus-5`/`claude-sonnet-5` = 1,000,000, and `claude-haiku-4-5` = 200,000. These values supersede the 2026-08-31 handoff table after fresh official-doc verification on 2026-09-01.
- [ ] Add threshold tests proving 75% does not compact and 85% does.
- [ ] Make `context_budget_for` return the true window, implement real longest-prefix selection, and set `_PROACTIVE_COMPACT_RATIO = 0.8` as the only safety margin.
- [ ] Run `python -m pytest tests/model_profiles_test.py tests/agent_runtime_loop_test.py -q`.

### Task 4: Request prompt caching on Messages payloads (P0-4)

**Files:**
- Modify: `app/agent_runtime/model_client.py`
- Modify: `app/harness/builtin_bundle.py`
- Test: `tests/agent_runtime_ai_backend_test.py`
- Test: `tests/harness_builtin_bundle_test.py`

- [ ] Add failing payload tests for exactly three explicit breakpoints (last tool, system block, stable history boundary), zero breakpoints when `MAGIC_POINTER_PROMPT_CACHE=0`, and no cache fields in chat-completions mode.
- [ ] Add `_prompt_cache_enabled()` and Messages-only projection. Mark the last tool, the system text block, and the last message before the current trailing user run; never exceed four breakpoints.
- [ ] Add `promptCache` to `model_request_header` so Studio traces state whether caching was requested.
- [ ] Run `python -m pytest tests/agent_runtime_ai_backend_test.py tests/harness_builtin_bundle_test.py -q`.

### Task 5: Add deterministic environment facts (P0-5)

**Files:**
- Modify: `app/agent_runtime/system_prompt.py`
- Modify: `app/harness/builtin_bundle.py`
- Test: `tests/harness_builtin_bundle_test.py`

- [ ] Add failing tests for date/platform/workspace/branch rendering, omission when facts are absent, symbolic HEAD parsing, and detached HEAD omission.
- [ ] Add a dynamic `environment` section before `coding`; avoid duplicating the workspace line between those sections.
- [ ] Build environment values in `builtin_bundle.py` from local date/platform and a no-subprocess `_git_branch(root)` helper.
- [ ] Run `python -m pytest tests/harness_builtin_bundle_test.py -q`.

### Task 6: Load workspace memory from the bound workspace (P1-6)

**Files:**
- Modify: `app/harness/builtin_bundle.py`
- Test: `tests/harness_builtin_bundle_test.py`

- [ ] Add a failing boot test with `MAGIC_POINTER.md` under `config.workspace_root` while process cwd points elsewhere.
- [ ] Pass the bound workspace path (or `None`) to `MemoryLoader`; never use process cwd for project memory.
- [ ] Run `python -m pytest tests/harness_builtin_bundle_test.py -q`.

### Task 7: Normalize consecutive Messages roles and tool results (P1-7)

**Files:**
- Modify: `app/agent_runtime/model_client.py`
- Test: `tests/agent_runtime_ai_backend_test.py`

- [ ] Add failing tests for two adjacent TOOL results becoming one user message with ordered `tool_result` blocks and for adjacent list/string user entries becoming one block list.
- [ ] Add `_merge_messages_entries` for Messages mode only; copy lists before merging and preserve block order.
- [ ] Run `python -m pytest tests/agent_runtime_ai_backend_test.py -q`.

### Task 8: Surface tool truncation and retain MCP headroom (P1-8)

**Files:**
- Modify: `app/agent_runtime/loop.py`
- Modify: `scripts/conversation_bridge.py`
- Test: `tests/agent_runtime_loop_test.py`
- Test: `tests/conversation_stream_progress_test.py`

- [ ] Extend the existing five-tools/limit-three test to expect one `ToolsTruncated(dropped=(...), limit=3)` immediately after `LoopStart`.
- [ ] Return truncation metadata from a new selection helper while keeping `_select_tool_schemas` compatibility; emit one frozen event when names were dropped.
- [ ] Project the event into a Studio notice row and raise both production bridge limits from 64 to 128.
- [ ] Run `python -m pytest tests/agent_runtime_loop_test.py tests/conversation_stream_progress_test.py -q`.

### Task 9: Remove stale aliases from model-visible descriptions (P1-9)

**Files:**
- Modify: `app/agent_runtime/coding_tools.py`
- Modify: `app/agent_runtime/system_prompt.py`
- Test: `tests/coding_tools_test.py`
- Test: `tests/harness_builtin_bundle_test.py`

- [ ] Add a failing test that concatenates model-visible coding descriptions and rejects `read_file`, `write_file`, `edit_file`, `apply_patch`, `run_command`, and `restore_files` while alias registration remains intact.
- [ ] Replace model-facing names with `Read`, `Write`, `Edit`, `Patch`, `Bash`, and `Rewind`; leave internal function names and alias routing unchanged.
- [ ] Run `python -m pytest tests/coding_tools_test.py tests/harness_builtin_bundle_test.py -q`.

### Task 10: Add Bash command-prefix grants (P1-10)

**Files:**
- Modify: `app/agent_runtime/permission_decisions.py`
- Modify: `app/agent_runtime/permission_modes.py`
- Modify: `app/agent_runtime/ask_todo_tools.py`
- Modify: `app/agent_runtime/loop.py`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/conversation_store.ts`
- Test: `tests/permission_decisions_test.py`
- Test: `tests/agent_runtime_loop_test.py`
- Test: `tests/studio_composer_contract_test.js`

- [ ] Add failing tests for `Bash(pytest)` allowing `pytest -q` but rejecting `pytestx`, shell chaining, redirection, command substitution, and multiline suffixes.
- [ ] Add `PermissionDecisions.allows_call(tool_name, arguments)`; whole-tool grants remain compatible and deny remains tool-scoped.
- [ ] Add bounded `prefix` data to `AskUser` and `_pending_user_input`; derive at most the first two command tokens for Bash permission suggestions.
- [ ] Store `Bash(<prefix>)` on the Studio “always allow” button; the “once” choice uses the same narrow prefix only for the immediate resumed request and is never persisted to the thread. Render the prefix in the label.
- [ ] Run Python permission/loop tests, Node Studio contract tests, and renderer typecheck.

### Task 11: Add Grep case and output modes (P1-11)

**Files:**
- Modify: `app/agent_runtime/coding_tools.py`
- Test: `tests/coding_tools_test.py`

- [ ] Add failing tests for case-sensitive identifier search and `content`, `files_with_matches`, and `count` output.
- [ ] Thread `case_sensitive` and `output_mode` through rg and Python fallbacks; aggregate unique files/counts before applying file-based offset/limit.
- [ ] Update the schema/description to recommend file discovery before content retrieval.
- [ ] Run `python -m pytest tests/coding_tools_test.py -q`.

### Task 12: Deliver tool examples in descriptions (P1-12)

**Files:**
- Modify: `app/agent_runtime/loop.py`
- Test: `tests/agent_runtime_loop_test.py`

- [ ] Add a failing schema-selection test for `调用示例：` plus JSON, with no change for tools lacking examples.
- [ ] Fold `ToolSpec.examples` into description text using `json.dumps(..., ensure_ascii=False)`; never add an unsupported provider-level key.
- [ ] Run `python -m pytest tests/agent_runtime_loop_test.py -q`.

### Task 13: Make backend recovery wait interruptible (P1-13)

**Files:**
- Modify: `app/agent_runtime/loop.py`
- Test: `tests/agent_runtime_loop_test.py`

- [ ] Add a failing test with patched `_sleep` and an interrupt on the third slice; assert total requested sleep is under two seconds and terminal reason is `USER_INTERRUPT`.
- [ ] Slice recovery sleep at 0.5 seconds, checking cancellation and interrupt between slices; let the normal loop boundary produce the receipt-bearing interrupt terminal.
- [ ] Run `python -m pytest tests/agent_runtime_loop_test.py -q`.

### Task 14: Implement `/compact` and `/help` without a model call (P1-14)

**Files:**
- Modify: `app/agent_runtime/slash_directory.py`
- Modify: `scripts/conversation_bridge.py`
- Test: `tests/conversation_bridge_test.py`
- Test: `tests/slash_menu_contract_test.js`

- [ ] Add failing route tests and a fake-session integration test proving `/compact` records `surface/replace` with reason `manual_compaction`; add a `/help` test proving no backend call.
- [ ] Add both directory entries. Defer their handling until after runtime boot: `/compact` opens the resolved durable session, invokes the configured compactor, replaces only when token weight shrinks, and reports before/after counts; `/help` renders commands, skills, and current registry tool names.
- [ ] Run `python -m pytest tests/conversation_bridge_test.py -q` and the Node slash-menu test.

### Task 15: Keep shared Composer editable while running (P2-15)

**Files:**
- Modify: `electron/renderer/composer.ts`
- Modify: `electron/renderer/companion.ts`
- Test: `tests/composer_surface_test.js`

- [ ] Add a failing pure decision test: running + text = steer, running + empty = stop, idle payload = submit.
- [ ] Add `onSteer`; never disable the textarea; change placeholder/title in running state; route non-empty running submissions to steer and empty submissions to stop.
- [ ] Ensure the Companion either supplies a real send/steer callback or does not show an input that cannot act; no no-op callbacks remain.
- [ ] Run `npm test -- --match composer_surface_test` (or the repository Node runner when match filtering is unavailable) and renderer typecheck.

### Task 16: Remove or wire the dead microphone (P2-16)

**Files:**
- Modify: `electron/renderer/composer.ts`
- Test: `tests/composer_surface_test.js`

- [ ] Add a failing source/DOM contract that no voice button is produced when `onVoice` is absent.
- [ ] Add optional `onVoice`; create and bind the button only when provided.
- [ ] Run the Composer contract test.

### Task 17: Make Escape stop a Studio turn (P2-17)

**Files:**
- Modify: `electron/renderer/studio.ts`
- Test: `tests/studio_composer_contract_test.js`

- [ ] Add a failing contract for a shared `stopActiveConversation()` used by both the stop button and Escape.
- [ ] Capture whether any menu was open before closing it; an Escape that only closes a menu must not stop, while an Escape with no menu open and an active request calls the shared stop path and shows `正在停止…`.
- [ ] Run the Studio contract test and renderer typecheck.

### Task 18: Restore focus without stealing it (P2-18, corrected)

**Files:**
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/renderer/composer.ts`
- Test: `tests/studio_composer_contract_test.js`
- Test: `tests/composer_surface_test.js`

- [ ] Add failing contracts that idle transition focuses the composer only when `document.activeElement` is not another input/textarea.
- [ ] Move Studio's existing unconditional `textarea.focus()` into guarded idle-state focus; mirror the policy in shared Composer.
- [ ] Run Composer/Studio tests and renderer typecheck.

### Task 19: Accept bounded text attachments in shared Composer (P2-19)

**Files:**
- Modify: `electron/renderer/composer.ts`
- Test: `tests/composer_surface_test.js`

- [ ] Add failing tests for the accepted extension list and a pure 200 KiB text-size policy.
- [ ] Keep images as data URLs; read `.txt/.md/.log/.csv/.json/.py/.ts/.js` with `readAsText`, store `{name,text}`, show a file icon, and reject larger text files with a visible component error.
- [ ] Run the Composer contract test and renderer typecheck.

### Task 20: Speed token estimation without changing its useful bucket (P2-20)

**Files:**
- Modify: `app/agent_runtime/token_estimate.py`
- Test: `tests/agent_runtime_token_estimate_test.py`

- [ ] Add an old-vs-new parity test over mixed Chinese/Japanese/Korean/fullwidth/emoji text with <2% difference and a benchmark fixture over a 200k-character context.
- [ ] Use a compiled range regex (C-level scan) rather than a nested Python range loop if the latter does not beat `unicodedata`; retain wide emoji/fullwidth coverage needed by the existing estimator.
- [ ] Run `python -m pytest tests/agent_runtime_token_estimate_test.py tests/tail_prune_token_test.py -q` and record the benchmark ratio.

### Task 21: Full verification, ledgers, and local installation

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`
- Verify: `package.json`, `package-lock.json`, installed package

- [ ] Run `git diff --check` and inspect only the intended paths/hunks.
- [ ] Run `python -m pytest -q --basetemp=data/runtime/pytest-tmp-harness-ux-20260901`.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Update the canonical progress ledger and STATUS with the exact pass counts, corrected review findings, `usedBackend`/timing evidence, and honest manual-verification gaps.
- [ ] Keep the already-bumped behavior version at 1.0.32, run `npm run sync`, and confirm `%LOCALAPPDATA%\\Programs\\Magic Pointer\\resources\\app\\package.json` reports 1.0.32.
