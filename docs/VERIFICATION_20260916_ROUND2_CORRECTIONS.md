# Round-2 corrections applied

`docs/VERIFICATION_20260916_ROUND2.md` lists 13 corrections. This records what
was done about each. Corrections are numbered as in that report.

**The headline, stated first because the rest is detail:** the twin cursor is
**not a delivered feature**. There is no executable path from a driver click to
a drawn pixel. That was true when the verification was written; parts of it are
now fixed, and the parts that are not are named below rather than left implied.

---

## Code corrections

### #1 — the channel was wired at both ends and joined nowhere
**Fixed.** The verifier's diagnosis was exact: `_live_driver()` read
`_agent_cursor_sink` at *construction*, and both bridges construct the driver
during `boot_loop_context`, hundreds of lines before `set_agent_cursor_sink()`.

- `AgentCursorEmitter` now accepts a *provider* and resolves it per emission;
  `agent_cursor_observer()` returns an emitter that always follows the current
  sink. The observer is attached unconditionally.
- The sink moved to `app/computer_operator/agent_cursor_channel.py`, because
  both driver sites need it (`app/desktop_actions/session.py` and
  `WindowsComputerOperatorBackend.__init__`).
- **The test was the real bug.** `tests/agent_cursor_channel_test.py` pinned the
  *inverse* order — set the sink, then build the driver — so it passed while
  production emitted nothing. It now exercises the production order, and I
  confirmed it fails against the old construction (4 failures).

### #2 — `idle` accepted nowhere
**Fixed.** Added to `AgentCursorCommandKind`, to the normalizer's `known` list,
and to `onAgentCursorCommand` in `electron/renderer/overlay.ts`, where it
releases the cursor back to following. Previously the cursor stayed planted on
the last click target, which reads as "still busy" after the work finished.

### #3 — the truncation docstring was false for `AiClientBackend`
**Fixed, and the gap closed rather than documented.** `AiClientBackend` has no
stop reason to consult — the wrapped call returns one dict — so the suffix
heuristic really was that path's only truncation detector, and turning it off
removed detection there.

- `app/ai_client.py` now surfaces the provider's own `finish_reason`, across all
  three wire branches (chat-completions `choices[0].finish_reason`, Messages
  `stop_reason`, Responses `status == "incomplete"`).
- `AiClientBackend.generate` withholds the turn on a length finish, the same
  contract every other backend follows. This is protocol evidence, so it is
  strictly better than the text heuristic it replaces — and it does not fire on
  Chinese punctuation.
- The module docstring and `parse_tool_calls` note corrected.

### #4 — `errors.py` claimed a fallback that does not exist
**Fixed.** The comment now says plainly that the optional-field retry strips
`thinking` / `reasoning_effort` / `reasoning` and **not** `max_tokens`, so a
provider whose hard cap is below 8192 has no automatic fallback, and points at
the model profile as the right place to declare a cap.

### #8 — comments still said "four parallel reads"
**Fixed** in `app/agent_runtime/loop.py` and `tests/turn_tool_budget_test.py`.
Both now say eight, and the budget comment notes it binds over a wider batch.

### #9 — two stale `= 4` defaults
**Fixed.** `app/agent_runtime/tool_scheduler.py` and `LoopModelParams` aligned
to 8, each with a note pointing at the engine as the source of truth.

### #11 — `deferPersist` introduces a stale read
**Documented at the reader.** `app/context_pack/daily_wrap.py` is the one reader
in a different process that can observe the window. The comment states the
window, why the trade was taken, and that the fix — if a second of staleness
ever matters — is to flush before reading rather than to shorten the debounce.

### #12 — a refusal the user never sees
**Fixed.** Both `startRequest` refusal sites now `deliverStageError` with a
sentence, matching how every other refusal on that path behaves. The cancellation
of the running request still happens; what changed is that it is no longer
silent.

### #13 — 1030 lines of Python with no production caller
**Recorded, not resolved.** `app/computer_operator/cursors.py` and
`displays.py` are referenced only by their own definitions, the package
re-export, and their tests. The equivalent logic exists a second time in
TypeScript, and *that* copy is the wired one (`agent_cursor_policy.ts`, used by
`AgentCursorSurfaces` in `electron/main.ts`).

This is a genuine open decision, not an oversight to paper over: either the
Python model becomes the source of cursor state and streams positions, or it is
redundant and should go. The split that makes sense on the evidence is the one
already implemented — Python announces *intent* (`approach` / `click` / `idle`),
TypeScript owns *animation*, because Python cannot draw. On that reading
`cursors.py` is duplicating work that belongs where the pixels are.

I did not delete 790 lines of another agent's tested work on my own judgement at
the end of a session. It is open in the catalogue with that recommendation.

### Corrections #5, #6, #7, #10 — documentation claims
**Fixed** in the documents they refer to:
- `docs/perf/2026-09-16-electron-audit.md` now carries a dated header saying the
  F-numbers and raw-output blocks are a **pre-fix snapshot**, measured at
  `6c5b9ad`, and that re-running the harnesses gives different numbers.
- The `~758 µs → ~12 µs` figure is gone; only the C-069 production-shape number
  is quoted (152 → 12.4 ms claimed; **161–173 → 12.6–13.8 ms** re-measured).
- C-053's `60.6 → 36.9 ms` is restated as **not reproducible**, with the
  verifier's measurement (46.86 ms synchronous, 0.00 ms deferred) and the fact
  that no committed harness produces the original pair.
- `tests/harness_builtin_bundle_test.py`'s self-referential equality assertion
  is replaced by the `>= 8_000` floor, which is the assertion that has content.

## What is still not delivered

Stated once, plainly, so no summary has to hedge later:

| Claim | Reality |
| --- | --- |
| Twin cursor draws a cursor | **No.** The channel is now attached, the `idle` action is accepted, and right-click renders distinctly — but no window has been created and no frame has been drawn. The renderer code is typechecked, not run. |
| C-024 / C-025 / C-029 | Written and tested; **not connected to production**. The Python registry and display modules have no caller. |
| C-062 standby overlay | Not attempted; cannot be verified headless and a wrong swap breaks the gesture interaction. |
| C-081 gesture polygon | The three-part patch is specified but not applied. |
