# Independent verification — round 2 (`ef5ee16..HEAD`)

Verifier: adversarial, independent. Product is the verdict, not a fix. Nothing in
this round's source or tests was modified by this report.

## 0. What was actually audited, and a warning about the target

The branch **moved during this audit**. It was `218ed0c` when the audit opened
and `f95e2f8` when the regression suites were run:

```
$ git reflog -5
f95e2f8 HEAD@{0}: commit: test: headless startup smoke that runs the real main process
7334d5d HEAD@{1}: commit: docs: round-2 bug ledger
a294ec6 HEAD@{2}: commit: fix(harness): one summarizer, with parameters that fit the job
ee682bd HEAD@{3}: commit: perf(harness): skip the summarizer when pruning already sufficed
90d95b6 HEAD@{4}: commit: docs: round-2 catalogue update
```

Everything below is measured at **`f95e2f8f0b734575cb9bb62845efd9f96101fcac`**.
`docs/BUGLEDGER_20260916_ROUND2.md` and the "Round 2" section of
`docs/CATALOGUE_20260916.md` were themselves added mid-audit by `7334d5d` /
`90d95b6` and are treated as claims of record.

And it was still moving when this report was written: uncommitted work appeared
in the tree during the audit —

```
$ git status --short
 M electron/main.ts
 M scripts/selection_snapshot_bridge.py
?? electron/geometry_space.ts
?? tests/geometry_space_test.ts
```

None of it is this report's (its only artefact is this file). The two regression
counts in §1 were taken before those edits landed, so 2112 / 209 is the number
for `f95e2f8`, not for the current working tree.

## 1. Regression counts

| Suite | Baseline given | Measured at `f95e2f8` | Verdict |
| --- | --- | --- | --- |
| `python -m pytest tests/ -q --basetemp=.pytest-tmp-verifier` | 2104 passed | **2112 passed, 1 warning in 293.24s** | PASS (+8, from the later commits) |
| `npx tsx scripts/run-node-tests.ts` | 209 test files | **node suite passed: 209 test files** | PASS |

```
$ python -m pytest tests/ -q --basetemp=.pytest-tmp-verifier
2104 passed, 1 warning in 248.76s (0:04:08)      # at the HEAD present when the audit opened

$ python -m pytest tests/ -q --basetemp=.pytest-tmp-verifier2
2112 passed, 1 warning in 293.24s (0:04:53)      # at f95e2f8

$ npx tsx scripts/run-node-tests.ts
node suite passed: 209 test files
```

`tests/sweep_visual_incremental_test.js` is inside the 209 (it matches the
runner's `_test.[jt]s` filter), so the C-069 evidence does run in the suite.

## 2. Verdict table

### 2.1 Measured improvements

| # | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| M1 | C-069 / BUG-030-area: "Sweep geometry is incremental: **152 ms → 12.4 ms** on the production shape (append-one-point-per-call, 1024 steps)" | **VERIFIED** (numbers within noise) | `sweep_visual_incremental_test.js` three runs below; full 161–173 ms, incremental 12.6–13.8 ms, **11.7–13.8×** |
| M2 | `tools/measure_electron_hotpath.js`: `buildSdfPath` "~758 µs → ~12 µs at 1024 points" | **FAILED as stated** | Neither 758 nor 12 appears in any document. The audit's own figure is 855.785 µs; the harness now reports 15.587 µs — and the harness number is **not a production measure at all** (below) |
| M3 | `tools/measure_main_process_io.js` baselines (persist 4.10/17.96/85.41 ms; `log()` 0.98 ms; `writeEvent` 0.49 ms) | **VERIFIED as re-measurable, numbers moved** | Re-run below: 4.06 / 17.63 / 67.13 ms; `log()` 0.58 ms; `writeEvent` 0.64 ms |
| M4 | BUG-004: pointer stream rate "**58.4 Hz**" (audit: 56.6 Hz) | **VERIFIED** | `node tools/measure_poller_rate.js` → `effective_hz=59.6`, `gap p50=16.6` |
| M5 | BUG-008: poller wire shape preserved | **VERIFIED** | `node tools/verify_poller_wire_shape.js` → `lines=205 malformed=0`, full key set present |
| M6 | BUG-006 cold start 1470 → 747 ms (round-1 verifier corrected to 1327 → ~960 ms) | **VERIFIED as improved beyond both figures** | `node tools/measure_poller_coldstart.js` ×6: `first_line_ms` **516–573**, median 552 |
| M7 | C-056 / BUG-table: `observability.writeEvent` "0.33–0.96 ms/call → **0.00 ms queue-only**" | **VERIFIED** | Real module, 2000 calls: `per_call=0.0004ms` |
| M8 | C-053: "`updateTurn` at the audit's 13 MB store went **60.6 ms → 36.9 ms**" | **PARTLY VERIFIED — number not reproduced** | Real store, 13.17 MB, synchronous path: **46.86 ms**; `deferPersist:true` (production): **0.00 ms** |
| M9 | C-074: "~95 Python spawns per 5-minute task → ~20" | **UNVERIFIED** | No committed probe prints this; not re-measured in this pass |
| M10 | Everything in `electron/main.ts` / `agent_cursor_window.ts` / `overlay.ts` changed in round 2 | **UNVERIFIABLE-HEADLESS** | Needs a real Electron window; the docs already say so. `tools/smoke_studio_headless.js` was added by `f95e2f8` but is a startup smoke, not a cursor-render check |

Raw output for the measured rows:

```
$ for i in 1 2 3; do npx tsx tests/sweep_visual_incremental_test.js | grep "1024-step"; done
sweep_visual_incremental_test: 1024-step growth rebuild incremental=12590us full=173123us (13.8x)
sweep_visual_incremental_test: 1024-step growth rebuild incremental=13785us full=161052us (11.7x)
sweep_visual_incremental_test: 1024-step growth rebuild incremental=13094us full=165292us (12.6x)

$ npx tsx tools/measure_electron_hotpath.js      # section 7 only
buildSdfPath(64 raw points)   [per drawing frame]  per_call=   15.713us
buildSdfPath(256 raw points)  [per drawing frame]  per_call=   10.085us
buildSdfPath(1024 raw points) [per drawing frame]  per_call=   15.587us
buildSdfPath(4096 raw points) [per drawing frame]  per_call=   58.742us

$ node tools/measure_main_process_io.js
    persist() end-to-end (stringify+write+rename)  n=20  per_call=     4.06ms   # 0.40 MB
    persist() end-to-end (stringify+write+rename)  n=20  per_call=    17.63ms   # 3.16 MB
    persist() end-to-end (stringify+write+rename)  n=20  per_call=    67.13ms   # 13.17 MB
log() one line (mkdirSync + appendFileSync)        n=200 per_call=     0.58ms
writeEvent (statSync + appendFileSync)             n=200 per_call=     0.64ms

$ node tools/measure_poller_rate.js
samples=446 over 8027ms
gap p50=16.6 p90=17.2 p99=21.4 max=27.3
effective_hz=59.6

$ node tools/verify_poller_wire_shape.js
lines=205 malformed=0
sample={"buttons":0,"foregroundApp":"ChatGPT","foregroundHwnd":6753142,"foregroundProcessId":22360,"isWindowMoving":false,"scrollDelta":0,"swallowingLeft":false,"captureArmed":false}

$ for i in 1 2 3; do node tools/measure_poller_coldstart.js | tail -1; done
first_line_ms=563  lines=391  elapsed=7032
first_line_ms=541  lines=391  elapsed=7031
first_line_ms=546  lines=391  elapsed=7032
$ for i in 1 2 3; do node tools/measure_poller_coldstart.js | tail -1; done   # second sample
first_line_ms=570  lines=391  elapsed=7040
first_line_ms=573  lines=390  elapsed=7044
first_line_ms=516  lines=394  elapsed=7031

$ npx tsx  # real electron/observability writeEvent, 2000 calls
writeEvent per_call=0.0004ms (n=2000)

$ npx tsx  # real createConversationStore, 50 conv x 20 turns = 13.17 MB
updateTurn deferPersist=false per_call=46.86ms
updateTurn deferPersist=true  per_call=0.00ms
```

### 2.2 The twin cursor — the channel is not wired, it is only wired-at-both-ends

This is the highest-density claim in the round and the one that does not survive.

| # | Claim | Verdict |
| --- | --- | --- |
| T1 | "The twin cursor's message channel is wired end to end: bridge → sink → emitter → `@@mp phase=agent_cursor` → main → cursor surface" (`CATALOGUE` round-2 table, `BUGLEDGER_ROUND2` BUG-030) | **FAILED** |
| T2 | Serialisation half: phase name, action/kind, `leadMs`, `x`, `y` survive `_token()` | **VERIFIED** |
| T3 | Renderer accepts `approach` / `click` | **VERIFIED** |
| T4 | `idle` action "releases the cursor back to plain following" — renderer accepts `idle` | **FAILED** |
| T5 | `button` / `count` reach the renderer | **FAILED** (dropped at the main-process boundary) |
| T6 | The sink is detached on every exit path | **VERIFIED** |
| T7 | `handleAgentCursorProgress` is reachable from the bridge that runs computer-use | **VERIFIED** (attached, but never receives a row — see T1) |
| T8 | Python emits physical pixels where main expects DIP — a coordinate-space break | **NOT ESTABLISHED** (see falsification log) |
| T9 | C-025 / C-029: per-display placement and the addressable multi-cursor model exist as first-class surfaces | **FAILED — the Python half is unreachable from production** |

**T1 — the emitter is never attached in production.**

`_live_driver()` reads the module-global sink **at construction time** and bakes
the observer into the driver:

`app/desktop_actions/session.py:1188-1200`
```python
return Win32InputDriver(
    approach_observer=(
        AgentCursorEmitter(_agent_cursor_sink)
        if _agent_cursor_sink is not None
        else None
    ),
)
```

The desktop-action session — and therefore this driver — is built while
`boot_loop_context` mounts the plugin tree, which happens **before** the bridge
sets the sink:

```
$ grep -n "boot_loop_context(runtime\|set_agent_cursor_sink(" scripts/selection_bridge.py scripts/conversation_bridge.py
scripts/selection_bridge.py:2829:            report = boot_loop_context(runtime, root=ROOT)
scripts/selection_bridge.py:3043:            set_agent_cursor_sink(clock)
scripts/selection_bridge.py:3102:            set_agent_cursor_sink(None)
scripts/conversation_bridge.py:1266:    report = boot_loop_context(runtime, root=ROOT)
scripts/conversation_bridge.py:1475:        set_agent_cursor_sink(conversation_clock)
scripts/conversation_bridge.py:1534:        set_agent_cursor_sink(None)
```

`boot_loop_context` → `boot(...)` → the `desktop-action-tools` row
(`app/harness/builtin_bundle.py:766`) → `_apply_desktop_action_tools` →
`default_session(...)` at `app/harness/builtin_bundle.py:322` → `_live_driver()`.
At that moment `_agent_cursor_sink` is `None` (process start, or the previous
turn's `finally`), so `approach_observer=None` and the driver never announces
anything. `set_agent_cursor_sink(clock)` 214 lines later has nothing to attach to.

Reproduced with the real driver and the real session factory:

```
$ python (production order: sink set AFTER the driver is built)
PRODUCTION ORDER (sink set after driver built): NO MARKS
TEST ORDER (sink set before driver built): [('agent_cursor', 'approach', 300, 400), ('agent_cursor', 'click', 300, 400)]
```

`tests/agent_cursor_channel_test.py:137-158` pins the wiring but only in the
**inverse** order (`set_agent_cursor_sink(sink)` *then* `_live_driver()`), which
is the order the bridges do not use. The test therefore passes while production
stays silent.

There is a second, independent dead end: the visual computer-use path builds its
own backend with no observer at all —
`app/harness/builtin_bundle.py:910-912`:
```python
registry.register(WindowsComputerOperatorBackend(
    output_root=_runtime_root(root) / "computer-observations",
))
```
`WindowsComputerOperatorBackend.__init__` (`app/computer_operator/windows.py:411`)
then does `self.driver = driver if driver is not None else Win32InputDriver()` —
no `approach_observer` parameter is available on that path.

**T2 — the wire format is exactly what main reads.** Emitted from the real
`AgentCursorEmitter` through a real `PhaseClock`, parsed by the real
`electron/bridge_progress_lines.ts`:

```
@@mp phase=agent_cursor ms=0 d=0 scope=selection id=agent action=approach x=1234 y=567 leadMs=600
@@mp phase=agent_cursor ms=0 d=0 scope=selection id=agent action=click x=1234 y=567 button=left count=1
@@mp phase=agent_cursor ms=0 d=0 scope=selection id=agent action=idle x=1234 y=567

$ npx tsx  # parseProgressLine
{"phase":"agent_cursor","ms":0,"fields":{"phase":"agent_cursor","ms":"0","d":"0","scope":"selection","id":"agent","action":"approach","x":"1234","y":"567","leadMs":"600"}}
{"phase":"agent_cursor","ms":0,"fields":{"phase":"agent_cursor","ms":"0","d":"0","scope":"selection","id":"agent","action":"click","x":"1234","y":"567","button":"left","count":"1"}}
{"phase":"agent_cursor","ms":0,"fields":{"phase":"agent_cursor","ms":"0","d":"0","scope":"selection","id":"agent","action":"idle","x":"1234","y":"567"}}
```

`_token()` (`scripts/bridge_progress.py:26-33`) replaces whitespace with `_` and
truncates at 120 chars; every key and value here is whitespace-free and far under
120, so **nothing is mangled**. `handleAgentCursorProgress`
(`electron/main.ts:947-965`) reads `fields.action`, `fields.x`, `fields.y`,
`fields.leadMs`, `fields.button`, `fields.count` and emits `kind` — matching the
emitter's `action=`/`leadMs=` names and the renderer's `payload.kind` /
`payload.leadMs` (`electron/renderer/overlay.ts:420-457`). The `action` vs `kind`
rename happens exactly once, in the right place.

**T4 — `idle` is dead at two boundaries.** The emitter sends a third action the
rest of the system does not know about:

```
$ npx tsx  # normalizeAgentCursorCommand({kind, id:'agent', x:10, y:20, leadMs:600})
approach  ACCEPTED
click     ACCEPTED
idle      REJECTED at the main-process boundary
mark      ACCEPTED
move      ACCEPTED
release   ACCEPTED
hold      ACCEPTED
clear     ACCEPTED
```

`electron/agent_cursor_policy.ts:275` whitelists `approach, mark, move, click,
hold, release, clear`; `electron/renderer/overlay.ts:420-457` has no `idle`
branch either (only `clear`, `approach`, `mark`/`move`, `click`, `release`,
`hold`). So `AgentCursorEmitter.idle()`'s docstring — "Release the cursor back to
plain following" (`app/computer_operator/agent_cursor_channel.py:98-102`) —
describes behaviour that exists nowhere. The action is dropped at
`sendAgentCursorCommand` → `agentCursorSurfaces.command()` →
`normalizeAgentCursorCommand` returning `null`.

**T5 — `button` and `count` are dropped.** `handleAgentCursorProgress` forwards
them, but `AgentCursorCommand` (`electron/agent_cursor_policy.ts:235-246`) has no
such fields and `normalizeAgentCursorCommand` rebuilds the object from a fixed
shape, so `agent_cursor_window.ts:211-215` broadcasts a command without them. A
right-click or double-click renders identically to a single left click. Latent
rather than visible today, because the renderer never read them either.

**T6 — detach is correct.** Both bridges wrap the turn in `try/finally` with
`set_agent_cursor_sink(None)` in the `finally`
(`scripts/selection_bridge.py:3102`, `scripts/conversation_bridge.py:1534`), so a
crashed turn cannot leak a stale emitter. Verified by reading; not a break.

**T7 — reachable, but starved.** `handleAgentCursorProgress` is called from three
`runPythonBridge` `onProgress` handlers: `electron/main.ts:2188`
(`conversation_bridge.py`), `:4637` (`selection_snapshot_bridge.py`), and
`:6099` (`selection_bridge.py` — the one that actually runs computer-use), behind
the `isCurrentRequest` stale-turn guard as the round-2 commit says. The
`SelectionWorkerClient` path also forwards parsed records
(`electron/selection_worker_client.ts:95` uses the same
`createProgressLineSplitter`). So the receiving half is correctly attached — it
simply never receives a row, because T1 means none is ever emitted.

**T9 — 1030 lines of Python that nothing in production calls.**

`app/computer_operator/cursors.py` (790 lines, the addressable multi-cursor
registry: id, accent, TTL, `CursorFrame`, `tick`/`frames`) and
`app/computer_operator/displays.py` (240 lines, `parse_display`,
`display_for_point`, `surface_for_point`, `SurfaceBounds.local_point`) are
referenced **only** by their own definitions, the package re-export, and their
tests:

```
$ grep -rn "CursorRegistry|CursorFrame|from \.cursors|import cursors" --include=*.py .
app\computer_operator\__init__.py:10:from .cursors import CursorFrame, CursorRegistry
app\computer_operator\__init__.py:33:    "CursorFrame",
app\computer_operator\__init__.py:34:    "CursorRegistry",
app\computer_operator\cursors.py:259:class CursorFrame:
app\computer_operator\cursors.py:509:class CursorRegistry:
  … (only self-references) …
tests\agent_cursor_model_test.py:19:from app.computer_operator import cursors
tests\agent_cursor_model_test.py:20:from app.computer_operator.cursors import CursorRegistry
```

```
$ grep -rn "display_for_point|surface_for_point|...\.displays" --include=*.py .   (minus tests)
app\computer_operator\displays.py:174:def display_for_point(...)
app\computer_operator\displays.py:190:def surface_for_point(
app\computer_operator\__init__.py:10:from .cursors import CursorFrame, CursorRegistry
```

There is no production call site for either. The equivalent logic is
implemented a second time, in TypeScript, and *that* copy is the one wired up:
`AgentCursorSurfaces` is constructed at `electron/main.ts:925`, `sync()`ed at
`:930`, `:4780`, `:4783`, sampled at `:4787`, disposed at `:5066`, and
`electron/agent_cursor_policy.ts` (358 lines) carries its own
`parseAgentDisplays` / `agentSurfaceForPoint` / `CursorSampleGate`. The
constants are cross-checked against the Python source by
`tests/agent_cursor_policy_test.ts`, which is what makes the duplication look
connected.

So the round-2 "Newly fixed" rows for **C-025** ("`app/computer_operator/displays.py`,
and one cursor surface per display") and **C-029** ("Addressable multi-cursor
model — id, position, accent, TTL, state") describe code that is written and
tested but reachable from nothing. Combined with T1, the twin cursor has no
executable path from a driver click to a drawn pixel: the Python model is
uncalled, the driver has no observer, the emitter produces an action the
boundary rejects, and the surface that *is* wired receives nothing to draw.

### 2.3 Behaviour-changing defaults

| # | Change | Verdict |
| --- | --- | --- |
| D1 | `_DEFAULT_TRUNCATION_SUFFIX = None` (`app/agent_runtime/model_client.py:73`) | **VERIFIED as safe for the SSE paths; the "a genuinely truncated turn never reaches this function" claim is FALSE for `AiClientBackend`** |
| D2 | `DEFAULT_MAX_OUTPUT_TOKENS` 4096 → 8192 (`app/agent_runtime/errors.py:29`) | **VERIFIED — no model in the catalog declares a smaller hard cap**; the stated mitigation is wrong (below) |
| D3 | `max_parallel_tool_calls` 4 → 8 (`app/fabric/engine.py:1047`) | **VERIFIED as effective**; two stale `4` defaults and two stale comments remain |
| D4 | Context-overflow rescue, empty-response ladder, `_fit_turn_tool_messages` (`app/agent_runtime/loop.py`) | **VERIFIED bounded**; one latent (unreachable) edge case |
| D5 | `deferPersist` on in production (`electron/main.ts:1400`) | **ONE stale-read path found** |

**D1 — can a cut-off tool call now execute?**

Two different questions, two different answers.

*Mid-argument truncation: no.* `_normalize_call`
(`app/agent_runtime/model_client.py:620-640`) records invalid JSON as
`argument_error` and drops the parse, and the loop refuses to execute such a call:
`app/agent_runtime/loop.py:2410-2418` turns `call.argument_error is not None` into
an error `ToolResult` without dispatching. Fail-closed survives the change.

*Silent truncation on the non-streaming gateway backend: yes.* The docstring's
justification is:

> Protocol evidence (`stop_reason == "max_tokens"`, or a missing stop reason)
> detects real truncation earlier, in the withheld branch, so a genuinely
> truncated turn never reaches this function.

That is true for both SSE parsers — `_parse_sse` yields
`TurnWithheld(reason="max_output_tokens")` on `finish_reason == "length"` **and**
on `finish_reason is None` (`app/agent_runtime/model_client.py:1572-1581`), and
`_parse_messages_sse` does the same for `stop_reason is None` (`:1775-1781`),
and `_parse_responses_sse` for a missing terminal frame (`:1661-1663`). It is
**not** true for `AiClientBackend`, which speaks the gateway protocol and has no
`stop_reason`/`finish_reason` concept at all — its `generate()`
(`app/agent_runtime/model_client.py:575-613`) emits `TurnWithheld` only on an
explicit `error` field. On that path the text-suffix heuristic was the only
truncation detector, and it is now off.

Reproduced against a client built on that backend with a turn whose prose ends in
`…` and which carries a complete tool call:

```
DEFAULT (truncation_suffix=None):
  last_truncated = False  calls returned = ['Click']
OPT-IN  truncation_suffix='…':
  last_truncated = True   calls returned = ['Click']
```

and `app/agent_runtime/loop.py:1532` (`if client.last_truncated:`) is what
converts that flag into "discard every call and retry". Before: discarded. Now:
executed. The call's *arguments* were complete, so nothing fail-closes — this is
exactly the behaviour the old guard existed to prevent, given up on the one
backend that has no protocol evidence to replace it. Whether that backend is
configured in the field is a deployment question this audit cannot settle; the
docstring's blanket "never reaches this function" is wrong as written and should
name `AiClientBackend` as the exception.

**D2 — nothing in the catalog is capped below 8192.** `app/models_catalog.py`
holds model selection only (`select_model` at `:153`, no output ceiling field) and
`app/models/profiles.py` carries no `max_output_tokens`:

```
$ grep -rn "max_output_tokens\|maxOutputTokens" app/models_catalog.py app/models/profiles.py electron/model_runtime_config.ts
(no output)
```

So no request will exceed a declared cap. The docstring's reassurance —
"the provider rejects the request and `ai_client` already retries without the
optional fields" — is nevertheless **wrong**: `_without_optional_request_fields`
(`app/ai_client.py:346-353`) strips only `thinking` / `reasoning_effort` /
`reasoning`. `max_tokens` survives the retry, so a provider that hard-caps below
8192 would 400 on every request with no max_tokens fallback. The catalogue has no
such model today; the wording still needs fixing so the next reader does not rely
on a fallback that does not exist.

**D3 — the effective value is 8, but two `4`s remain.**

```
$ grep -rn "max_parallel_tool_calls" app/ --include=*.py
app/agent_runtime/loop.py:375:    max_parallel_tool_calls: int = 4
app/agent_runtime/tool_scheduler.py:70:    max_parallel_tool_calls: int = 4,
app/fabric/engine.py:1047:    max_parallel_tool_calls: int = 8,
app/fabric/engine.py:1105:        max_parallel_tool_calls=max_parallel_tool_calls,
```

`run_agent_turn` always passes its value into `LoopParams` (`engine.py:1105`) and
the loop always passes `params.max_parallel_tool_calls` into `schedule_tool_calls`
(`loop.py:1770`), so production runs at 8. The other two are fallbacks for direct
`LoopParams(...)` / `schedule_tool_calls(...)` construction (tests do this).
**Nothing downstream assumes 4** — the pool is sized from the parameter
(`tool_scheduler.py:165` `max_workers=max_parallel_tool_calls`) and the per-round
aggregate budget is applied once over the whole batch (`loop.py:1873`), not per
wave. Two stale comments still say four: `app/agent_runtime/loop.py:2868` ("four
parallel reads at the cap") and `tests/turn_tool_budget_test.py:4-5`. The engine's
own justification ("a task that reads six files ran them in two waves") is
correct at 8.

**D4 — none of the three new ladders can loop.**

- Context overflow: `context_overflow_recoveries` increments on every entry and
  terminates at `_MAX_CONTEXT_OVERFLOW_RECOVERIES = 3` (`loop.py:1163-1180`); the
  resend is additionally abandoned when compaction did not shrink the history.
  Monotonic, bounded.
- Empty response: `empty_response_recoveries` capped at 3 (`loop.py:1471-1508`),
  gated on `not text and not state.tool_calls_pending`, and placed after the stop
  hooks / nudge path. It cannot terminate a task that previously succeeded — it
  only adds up to 3 model round-trips to a turn that previously "succeeded"
  with an empty message. That is the intended trade.
- `_fit_turn_tool_messages` (`loop.py:2873-2920`): each index is visited at most
  once, so it always terminates. One edge: if a message is shorter than the
  ~70-char trim marker and `keep` clamps to 0, the marker *replaces* it and the
  batch can end up **larger** than it went in. Reproduced, but it needs ~3000
  tool messages in one round:

```
realistic batch (max_parallel=8): n=8 each=30000 before=240000 after=120000 grew=False
3000 tiny messages:               n=3000 each=41  before=123000 after=204000 grew=True
```

  A round carries at most `max_parallel_tool_calls` (8) tool messages, so this is
  unreachable in production. Latent, not a break.

**D5 — one reader can see stale data, in the packaged build only.**

The in-process reader is safe: `load()` (`electron/conversation_store.ts:364-373`)
memoises into `items` and returns early, and `items` is never reset to `null`, so
no reader inside the main process ever re-reads the file after the first load.
`flush()` is called on both quit paths.

The cross-process reader is not. `ConversationEventCatalog._load()`
(`app/context_pack/daily_wrap.py:52-56`) reads
`<MAGIC_POINTER_USER_DATA_DIR>/history/conversations.json` directly. In the
packaged build those are the same file:

- store: `path.join(app.getPath('userData'), 'history')` (`electron/main.ts:1394`)
- `app.setPath('userData', ELECTRON_USER_DATA_DIR)` (`electron/main.ts:233-235`)
- `FABRIC_DATA_DIR = path.resolve(EXPLICIT_USER_DATA_DIR || DEFAULT_USER_DATA_DIR)`
  and `DEFAULT_USER_DATA_DIR = app.isPackaged ? app.getPath('userData') : DEVELOPMENT_RUNTIME_DIR`
  (`electron/main.ts:236-237`), passed to every Python child as
  `MAGIC_POINTER_USER_DATA_DIR` (`electron/main.ts:5545`).

So a DailyWrap read during the 1000 ms debounce
(`CONVERSATION_PERSIST_DEBOUNCE_MS`, `electron/conversation_store.ts:148`) sees a
file up to ~1 s old, plus any in-flight background write. Before this round
`persist()` wrote synchronously on every mutation, so the same read saw the
latest turn. Bounded, small, and only in the packaged build (in dev the store
writes to Electron's default userData while Python reads
`ROOT/data/runtime/history` — different files). The atomic `.tmp` + `renameSync`
means a reader never sees a torn document, only a stale one.

### 2.4 Test modifications

| Test | Verdict |
| --- | --- |
| `tests/selection_session_test.js` — worker claims the original **encoded a bug** | **CLAIM CORROBORATED** |
| `tests/stage_display_static_test.js` — assertion replaced with a regex | **FAIR REFRAME** (literal weakened, contract kept) |
| `tests/agent_runtime_loop_test.py` — tests opt in to `truncation_suffix="…"` | **FAIR**, and a new test pins the new default |
| `tests/agent_runtime_origin_isolation_test.py` — same opt-in | **FAIR** |
| `tests/harness_builtin_bundle_test.py` — `== 4096` → `== DEFAULT_MAX_OUTPUT_TOKENS` | **WEAKENED in one line** (self-referential) |

`git show ef5ee16:tests/selection_session_test.js` contains:

```js
const request1 = store.startRequest('session-1', 300);
const request2 = store.startRequest('session-1', 350);
assert.strictEqual(store.isCurrentRequest('session-1', request1, 400), false);
assert.strictEqual(store.finishRequest('session-1', request1, 400), null);
```

`finishRequest` returns `null` when the id does not match `activeRequestId`
(`electron/selection_session.ts:274-278`), so those two lines asserted that the
first answer was dropped whenever a second gesture arrived mid-flight. The worker's
claim is correct. The replacement test asserts the new contract
(`blocked === null`, then `request2` after `finishRequest`), and
`electron/selection_session.ts:258-261` is the production change. One behavioural
consequence is not tested: `electron/main.ts:6044-6046` calls
`cancelSessionChild(...)` and then returns silently when `startRequest` returns
`null`, so a second gesture during a running answer now cancels the running
request **and** drops the new command with no `deliverStageError`. The session
itself recovers — `child.on('close')` in `electron/python_bridge_runner.ts:192`
still fires on a killed child, so `finishRequest` runs at `main.ts:6129` and the
`running` state clears. Verified by reading, not a latch, but the user gets no
feedback.

`tests/harness_builtin_bundle_test.py:482-489` now reads
`assert int(model_cfg["max_tokens"]) == DEFAULT_MAX_OUTPUT_TOKENS` followed by
`assert int(model_cfg["max_tokens"]) >= 8_000`. The first assertion is
self-referential — it passes for any value of the constant, including 1. The real
contract is carried entirely by the `>= 8_000` line. Not harmful, but it should
either pin a literal or drop the tautology.

For `tests/stage_display_static_test.js`: the regex still requires the ordering
cursor-display → `getDisplayNearestPoint(cursor)` → `placeStageOnDisplay(display)`
→ bounds read from the window, and both accepted alternatives were checked.
`electron/main.ts:3214-3217` is the matched site, and `liveStageBounds()` is an
equivalent value because `stageBounds()` caches `stageWindow.getBounds()` keyed on
the window instance and is invalidated by the only three things that can change
it — the `setBounds` inside `placeStageOnDisplay` (`:1154`), a new/destroyed
window (`:1054`, `:1103`), and the display-added/-removed/-metrics-changed
handlers (`:4754-4758`); the stage window is `movable: false, resizable: false`
(`:1065-1066`). The regex is looser than a literal (its `[\s\S]{0,200}?` windows
can cross newlines), but the behaviour it guards is intact.

## 3. Falsification attempts and what happened

1. **Tried to break C-069 by distrusting the harness.** The committed
   `sweep_visual_incremental_test.js` *does* use the production shape (append one
   point to the same array, then rebuild), and it compares the incremental result
   bit-for-bit against a literal copy of the pre-change algorithm on five shapes,
   at 600 steps and again at 4096. That is a real measurement, not a replay of a
   cached array. **Claim survived.**
2. **Tried to break the `buildSdfPath` microbenchmark.** It did break, but not in
   the workers' favour. `tools/measure_electron_hotpath.js` calls `buildSdfPath`
   with the *same* array every iteration, so after the first call every iteration
   is a pure cache hit — the harness cannot see the un-cached cost at all. The
   tell is internal: the 64-point number (15.713 µs) is *larger* than the
   256-point number (10.085 µs). **The 855.785 µs → 15.587 µs "improvement" is not
   a production number and must not be quoted as one.**
3. **Tried to break the twin-cursor wiring.** Found the ordering break (T1) and
   confirmed it with the real driver and the real session factory in both
   directions.
4. **Tried to break T1 by finding a lazy driver construction.** There is none:
   `_live_driver()` is called eagerly as an argument to `default_session()`, and
   `boot()` mounts rows eagerly. The `_LOOP_HARNESS_HOST` resident path
   (`selection_bridge.py:2826`) builds its report at open, also before the sink.
   **Break stands.**
5. **Tried to establish a coordinate-space break.** The emitter sends raw
   `SetCursorPos` coordinates and `agent_cursor_window.command()` routes them
   with `screen.getAllDisplays()` bounds, which are DIP — so on a scaled display
   the commanded cursor would land at the physical-pixel offset inside a DIP-sized
   window. But `scripts/selection_bridge.py` and `scripts/conversation_bridge.py`
   never call `app.system_context.enable_dpi_awareness()` (only
   `selection_snapshot_bridge.py:54`, `electron_bridge.py:46`,
   `element_probe_bridge.py:36` and the verify scripts do), so the bridge process
   is DPI-unaware and Windows virtualises `SetCursorPos`/`GetCursorPos` into the
   same logical space Electron reports. **Not established — the evidence points
   the other way. UNVERIFIABLE-HEADLESS** (would need a scaled display and a
   running GUI to settle definitively).
6. **Tried to make `_fit_turn_tool_messages` grow a batch.** It can, but only at
   ~3000 messages per round; unreachable at `max_parallel_tool_calls = 8`.
   **Not a break.**
7. **Tried to find a permanent latch in `selection_session.startRequest`
   returning `null`.** `cancelSessionChild` does not call `finishRequest`, which
   looked like a session stuck in `running` forever. It is not: killing the child
   fires `child.on('close')` (`electron/python_bridge_runner.ts:192`), the
   `onProgress`/`onComplete` handler at `main.ts:6125-6129` passes the
   `isCurrentRequest` guard (the id still matches) and calls `finishRequest`.
   **Latch falsified.**
8. **Tried to find a stale read through `deferPersist` in the main process.**
   Every reader goes through `load()`, which is memoised in `items`, and `items` is
   never cleared. **No in-process staleness.** The cross-process reader found
   instead is D5.
9. **Tried to find a model in the catalog whose hard output cap 8192 would
   exceed.** None exists. **Claim survived**; only the mitigating wording is wrong.

## 4. Corrections needed

1. **`docs/CATALOGUE_20260916.md` round-2 table, the `—` row** ("The twin
   cursor's message channel is wired end to end") and
   **`docs/BUGLEDGER_20260916_ROUND2.md` BUG-030 status** ("`fixed` at the
   channel"). Both are wrong. The channel is wired at both ends and **joined
   nowhere**: `_live_driver()` reads `_agent_cursor_sink` when the driver is
   constructed (`app/desktop_actions/session.py:1195`), and both bridges construct
   it during `boot_loop_context` (`selection_bridge.py:2829`,
   `conversation_bridge.py:1266`) *before* calling
   `set_agent_cursor_sink(...)` (`:3043`, `:1475`). Status should be "wired,
   **not attached** — no row is ever emitted", with the fix being either a lazy
   observer that reads the sink per call, or attaching the emitter to the driver
   after the sink is set. `tests/agent_cursor_channel_test.py` pins only the
   inverse order and therefore cannot catch this.
2. **`app/computer_operator/agent_cursor_channel.py:33-38` and `:98-102`.** The
   `idle` action is accepted nowhere: `electron/agent_cursor_policy.ts:275` rejects
   it and `electron/renderer/overlay.ts:420-457` has no branch. Either add it to
   both, or delete `ACTION_IDLE` and `AgentCursorEmitter.idle()` and stop claiming
   the cursor is released.
3. **`app/agent_runtime/model_client.py:475-482`.** "a genuinely truncated turn
   never reaches this function" is false for `AiClientBackend`
   (`:575-613`), which has no stop reason of any kind. Say so, and note that the
   suffix heuristic was that path's only detector.
4. **`app/agent_runtime/errors.py:22-26`.** "the provider rejects the request and
   `ai_client` already retries without the optional fields" — the retry
   (`app/ai_client.py:346-353`) strips `thinking` / `reasoning_effort` /
   `reasoning` only. `max_tokens` is not removed, so there is no fallback for a
   provider that hard-caps below 8192.
5. **`docs/perf/2026-09-16-electron-audit.md`, "Raw output" blocks.** These are
   presented as the harness's output ("nothing here is estimated from vibes") but
   they are a **pre-fix snapshot**, and re-running the named harnesses now gives
   different numbers throughout: `log()` 0.98 → 0.58 ms, `persist()` at 13 MB
   85.41 → 67.13 ms, `buildSdfPath(1024)` 855.785 → 15.587 µs. The `buildSdfPath`
   rows in particular are meaningless in both snapshots (see §3.2). The document
   needs a dated "measured at `<sha>`" header and a note that the F-numbers are
   before-states.
6. **The `~758 µs → ~12 µs` figure quoted for `buildSdfPath`.** It appears in no
   document. The audit says 855.785 µs, this machine measures 15.587 µs on the
   same harness, and the harness cannot measure the production path. Quote only
   the C-069 production-shape figure: 152 → 12.4 ms claimed, **161–173 → 12.6–13.8
   ms** re-measured (11.7–13.8×).
7. **C-053's numbers.** "60.6 ms → 36.9 ms" is not reproducible and is not backed
   by any committed harness (`tools/measure_main_process_io.js` re-implements the
   persist pattern rather than calling the store). The real store at 13.17 MB
   measures **46.86 ms** on the synchronous path and **0.00 ms** with
   `deferPersist: true`. Either add a store-backed benchmark or restate the number
   with the machine it came from. A repo-wide search finds the pair **only** in
   the two claim documents and in the comment at
   `electron/conversation_store.ts:302` — no probe emits it:

```
$ grep -rn "60\.6\|36\.9" --include=*.md --include=*.ts --include=*.js .
./electron/conversation_store.ts:302:  // measured at 45.7 ms for a 13 MB store, 60.6 ms end-to-end. Only one
./docs/BUGLEDGER_20260916_ROUND2.md:185:| C-053 | ... partly fixed (60.6 ms → 36.9 ms); per-conversation files not done ...
./docs/CATALOGUE_20260916.md:197:| C-053 | Per-conversation JSON cache: `updateTurn` ... went 60.6 ms → 36.9 ms ...
```

8. **`app/agent_runtime/loop.py:2868` and `tests/turn_tool_budget_test.py:4`.**
   Both still say "four parallel reads"; the effective ceiling is 8
   (`app/fabric/engine.py:1047`). `_MAX_TURN_TOOL_RESULT_CHARS = 120_000` is
   unchanged and now binds over a wider batch, which is the stated intent — but
   the comments should say eight.
9. **`app/agent_runtime/tool_scheduler.py:70` and `app/agent_runtime/loop.py:375`
   still default to 4.** Dead in the production path, live for direct
   construction. Align them or say why they differ.
10. **`tests/harness_builtin_bundle_test.py:488`** is self-referential
    (`== DEFAULT_MAX_OUTPUT_TOKENS` passes for any value). The `>= 8_000` line
    below it is the actual assertion.
11. **D5 should be recorded**, not discovered later: with `deferPersist: true`
    in production, `app/context_pack/daily_wrap.py:52` can read a
    `conversations.json` up to ~1 s stale in the packaged build. Either
    `flushConversations()` before a DailyWrap read, or document the window.
12. **`electron/main.ts:6044-6046`** returns silently when `startRequest` refuses
    a second in-flight request, after `cancelSessionChild` has already cancelled
    the running one. The session recovers, but the user sees nothing. A
    `deliverStageError`/notice would match how every other refusal on this path
    behaves.
13. **`docs/CATALOGUE_20260916.md` round-2 "Newly fixed", rows C-025 and C-029.**
    Both present the Python modules as delivered surfaces.
    `app/computer_operator/displays.py` and `app/computer_operator/cursors.py`
    have no production call site (see §2.2 T9); the equivalent behaviour lives a
    second time in `electron/agent_cursor_policy.ts` / `agent_cursor_window.ts`,
    which is the copy that is actually constructed. Either wire the Python model
    to the driver (which is where the per-display and TTL logic belongs, and which
    would also give the emitted `id` something to mean) or mark both rows as
    "model written and tested; not connected", in the same voice the C-024 row
    already uses ("Not yet rendered in anger"). As written, a reader would
    reasonably conclude that per-display placement is live.

## 5. What could not be checked

- **Any pixel of the twin cursor.** No window, no frame, no canvas. The docs say
  this; this report confirms it is still true — and §2.2 T1 means the situation is
  worse than "unverified pixels": no command reaches the cursor surface at all.
- **The physical/DIP question for the emitted coordinates** (§3.5). Needs a
  scaled display and a live app.
- **`electron/main.ts` round-2 changes generally.** Typecheck-and-read only.
- **C-074's spawn-count reduction.** No committed probe reproduces the ~95 → ~20
  figures.
