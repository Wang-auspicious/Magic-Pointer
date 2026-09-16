# Bug ledger — round 2 (2026-09-16 evening)

Second pass. Commits `ef5ee16..HEAD`. Round 1 is in
`docs/BUGLEDGER_20260916.md`; the catalogue of everything found across both
rounds is `docs/CATALOGUE_20260916.md`.

Independent verification for this round is in
`docs/VERIFICATION_20260916_ROUND2.md`. **Where this file and that one
disagree, the verification report wins** — round 1's verifier falsified several
of my claims, including one that was a live functional regression, and there is
no reason to assume round 2's writing is better than round 1's.

---

## Area F — the harness, on the paths where long tasks die

### BUG-021 — a truncated turn retried at the same ceiling
- **Where**: `app/agent_runtime/loop.py` (withheld recovery), `app/agent_runtime/model_client.py`
- **What**: the loop detected `finish_reason == "length"` and retried — at the
  **same** `max_tokens`. A request needing more than 4096 output tokens was
  re-sent at 4096 until `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` failed the turn.
- **Why it hurts**: the retry existed but could not succeed. Writing a 200-line
  file, emitting one long patch, or summarising a long command's output all sit
  in that band, so the failure was concentrated exactly on the complex tasks the
  product is for.
- **Fix**: `escalated_max_tokens()` (4096 → 16384 → 64000; the cap is applied
  *before* the growth test, because the other order reports 64000 → 64000 as
  growth) and `LoopModelClient.escalate_output_tokens()`. Backends raise their
  own ceiling, so the system prompt — and the provider's prompt cache — survive.
- **Status**: `fixed` — `tests/output_token_escalation_test.py`

### BUG-022 — context overflow had no rescue path
- **Where**: `app/agent_runtime/errors.py`, `model_client.py`, `loop.py`
- **What**: every vendor reports "too many tokens" as a plain 400; only
  `http_5*` was recoverable, so the first overrun became a terminal
  `PROVIDER_UNAVAILABLE`.
- **Why it hurts**: it is the one provider refusal that gets *more* likely to
  succeed the more you do to it, and it was the one we gave up on. A long task
  died at the exact point compaction existed to save it.
- **Fix**: `CONTEXT_OVERFLOW_REASON` and `is_context_overflow_error()` (the
  wordings of five vendor families); the streaming backend reads the error body
  before deciding; the loop compacts and resends, bounded, bypassing the
  threshold check because the provider's 400 is better evidence than our own
  estimate. Reports `compaction_ineffective` rather than looping when compacting
  buys nothing.
- **Status**: `fixed` — `tests/degenerate_turn_recovery_test.py`

### BUG-023 — the anti-thrash compaction counter had no way back down
- **Where**: `app/agent_runtime/loop.py`
- **What**: `fruitless_compactions` was reset only *inside* the block whose
  guard required it to be low. Once it hit the cap, compaction was off for the
  rest of the run.
- **Why it hurts**: the latch outlived its reason. A model that changed
  direction and dropped a pile of tool output — precisely when compacting would
  work again — was refused.
- **Fix**: `_history_moved_since()` asks whether the history actually became
  lighter, instead of trusting a counter that only counted up.
- **Status**: `fixed` — `tests/fruitless_compaction_reset_test.py`

### BUG-024 — an empty completion was delivered as success
- **Where**: `app/agent_runtime/loop.py`
- **What**: `finish_reason=stop` with no text and no tool calls produced no
  withhold, so nothing classified it; the loop appended nothing and closed
  `COMPLETED` with `message=""`.
- **Why it hurts**: the user got an empty bubble **and** a success terminal —
  the worst pair, because it looks like the product worked.
- **Fix**: a bounded retry ladder with an explicit instruction to answer.
- **Status**: `fixed` — `tests/degenerate_turn_recovery_test.py`

### BUG-025 — a round's tool results were bounded individually, not in aggregate
- **Where**: `app/agent_runtime/loop.py`
- **What**: `_MAX_TOOL_RESULT_CHARS` caps each result at 64k, but a round can
  carry `max_parallel_tool_calls` of them.
- **Why it hurts**: four parallel reads at the cap put ~256k characters into the
  history in one step — the budget of an entire conversation, at roughly one
  token per CJK character.
- **Fix**: `_fit_turn_tool_messages()`, largest first, marking every trimmed
  message in place. A silently shortened tool result is worse than a truncated
  one: the model cannot tell "the file ended there" from "we stopped showing
  you".
- **Status**: `fixed` — `tests/turn_tool_budget_test.py`

### BUG-026 — a Chinese ellipsis was treated as truncation evidence
- **Where**: `app/agent_runtime/model_client.py`
- **What**: `parse_tool_calls` marked a turn truncated when its text ended with
  `…` and tool calls were present, and the loop then discarded those calls.
- **Why it hurts**: ending a sentence with `…` is ordinary Chinese punctuation,
  so any tool-calling turn that trailed off in prose had its calls thrown away,
  complete arguments included.
- **Fix**: the heuristic is off by default. Real truncation is already detected
  from protocol evidence (`stop_reason == "max_tokens"`, or a missing stop
  reason) in the withheld branch, which runs before tool calls are considered;
  cut-off arguments already fail closed as invalid JSON.
- **Status**: `fixed` — verified the new test fails against the old default
  (`state["calls"] == 0` instead of 1)

### BUG-027 — the default output ceiling was 4096, spelled out four times
- **Where**: `app/harness/builtin_bundle.py` (3 sites), `app/agent_runtime/subagent.py`, `app/agent_runtime/errors.py`
- **What**: the same literal in four places.
- **Why it hurts**: it is the first hard wall for complex work, and four copies
  are four chances to drift.
- **Fix**: `DEFAULT_MAX_OUTPUT_TOKENS = 8192`, one home. The test that asserted
  `== 4096` encoded the defect rather than the contract; it now asserts the
  property that was meant — large enough that one long file write does not
  truncate.
- **Status**: `fixed`

### BUG-028 — the summarizer ran when pruning had already solved the problem
- **Where**: `app/agent_runtime/memory.py`, `app/harness/builtin_bundle.py`
- **What**: duplicate tool results and stale outputs were pruned before the
  summarizer — that ordering was already right — but nothing asked whether
  pruning had made the model call unnecessary.
- **Why it hurts**: a long job that polls the same subtree has most of its
  weight in exactly the duplicates just removed, so the answer is often no, and
  the call costs a full round trip with a 25 s timeout on the very path where a
  failed call used to be accepted as a summary.
- **Fix**: `model_free_below_chars`, opt-in, scaled to the model's window in the
  bundle. Note the prune rewrites content in place, so the message *count* is
  unchanged while the weight drops — weight is what the loop judges by.
- **Status**: `fixed` — `tests/compaction_model_free_test.py`

### BUG-029 — the summarizer's parameters guaranteed it would fail
- **Where**: `app/agent_runtime/compaction_prompt.py`, both bridges
- **What**: a fixed 25 s timeout, one attempt, and the model-client default of
  1200 output tokens — over up to 48,000 characters of Chinese history, asked
  for a five-section structured handoff.
- **Why it hurts**: the timeout is the common case failing rather than the
  exception, and 1200 tokens is smaller than the format being requested. This is
  the input to BUG-019.
- **Fix**: one shared `summarize_history_text()`. The two bridges had drifted
  copies — the same shape as BUG-019, where only one copy received a fix — with
  a timeout scaled to the source (25–90 s), two attempts, and an explicit
  4000-token ceiling.
- **Status**: `fixed`. Caught in the making by
  `tests/no_undefined_names_test.py`: the import was function-local in
  `conversation_bridge.py` and went out with the body I replaced.

### BUG-030 — the twin cursor had no way to say where it was going
- **Where**: `app/computer_operator/agent_cursor_channel.py`, `app/desktop_actions/session.py`, both bridges, `electron/main.ts`
- **What**: the driver knew where it was about to click and how long the flight
  would take; the Electron side knew how to draw and animate a cursor; nothing
  carried the news between them.
- **Why it hurts**: the cursor followed the pointer and was never pointed at
  anything — the visible half of 双生鼠标 without the half that makes it read as
  intent.
- **Fix**: `AgentCursorEmitter` on the `@@mp` progress channel every bridge
  already reports on; a module-level sink in `session.py` (the driver is built
  lazily there, by callers with no way to pass one); attach and detach in both
  bridges; `handleAgentCursorProgress` in main, which parses the strings the
  line protocol delivers and drops what will not parse rather than turning it
  into NaN — which would place a cursor at 0,0. In the selection bridge it sits
  **behind the stale-turn guard**: a superseded turn must not move the on-screen
  cursor to where a cancelled action was going to click.
- **Status**: `fixed` at the channel (`tests/agent_cursor_channel_test.py`).
  **The pixels are unverified** — no window has ever been created and no frame
  has ever rendered.

---

## Area G — from the parallel workers

These were fixed by four workers in disjoint file areas; the detailed evidence
is in `docs/CATALOGUE_20260916.md` and `docs/VERIFICATION_20260916_ROUND2.md`.

| ID | Defect | Status |
| --- | --- | --- |
| C-080 | Four spellings of the same coordinate space; a locator from one rejected or mis-scaled by another | fixed |
| C-082 | Two incompatible stroke classifiers disagreeing about the same stroke | fixed (producer half) |
| C-083 | A deliberate press-and-hold dropped for failing both the duration and the path-length test | fixed |
| C-084 | A bare `null` with no reason when a gesture could not be converted; adjacent NaN→(0,0) relocation | fixed |
| C-085 | The stage origin was derived as DIP where the consumers need physical — correct only at 100% scale with the display at virtual origin 0 | fixed (main now sends it) |
| C-086 | A fallback that reintroduced the exact bug its own comment says was fixed | fixed |
| C-087 | A second request overwriting `activeRequestId` mid-flight, dropping the first answer | fixed — and the test that ENCODED the bug was rewritten |
| C-088 | A drag latch with no release path | fixed (policy half) |
| C-056 | `observability.writeEvent` at 0.33–0.96 ms per event | fixed (0.00 ms queue-only) |
| C-061 | The `conversations:turn` render cascade | fixed |
| C-065 | Stage bounds read 50×/second | fixed (5 call sites share a cache) |
| C-067 | Episode persisted synchronously between pointerup and the capsule | fixed |
| C-068 | An unstoppable 30 fps rAF pulse loop | fixed |
| C-069 | Per-frame sweep geometry rebuild — 152 ms → 12.4 ms on the production shape | fixed |
| C-071 | `fitComposer` forcing layout per keystroke | fixed |
| C-072 | 25 parser-blocking scripts | fixed (`theme_boot.js` deliberately not deferred) |
| C-073 | Clipboard bitmap re-decoded every 700 ms | fixed |
| C-074 | ~95 Python spawns per 5-minute task | fixed (~20; trade-off stated) |
| C-053 | Whole-store `JSON.stringify` still synchronous | partly fixed (60.6 ms → 36.9 ms); per-conversation files not done, reason recorded |
| C-062 | `ensureFreshGestureOverlay` destroy-and-recreate | **not done** — needs per-window readiness and a `reset()` fix first, and a wrong swap breaks the core gesture interaction |
| C-081 | The gesture polygon never leaves the main process | **not done** — three-part patch written up in the worker report |
