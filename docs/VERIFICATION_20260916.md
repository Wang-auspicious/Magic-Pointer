# Verification report — 2026-09-16

Independent adversarial verification of every `fixed` entry in
`docs/BUGLEDGER_20260916.md`. Nothing below is taken from the ledger's own
numbers; every figure was re-measured on this machine.

**Verified revision**: work started at `f273c6f` and the tree moved three times
during the run (`bdaf217`, `691c37b`, `10cd3ba`). Every finding was re-confirmed
against the final state, including the uncommitted working-tree edits present at
close (`app/ai_client.py`, `docs/CATALOGUE_20260916.md`, `scripts/selection_bridge.py`).
The ledger grew from 8 entries to 19 during verification; the eleven later
entries (BUG-013 … BUG-018, BUG-008) are covered here as well.

**Re-confirmed at `10cd3ba` + working tree** — the BUG-009 defect is still live:

```
$ grep -n "from .motion import\|glide_points" app/computer_operator/windows.py
20:from .motion import CLICK_HOLD_MS, CLICK_SETTLE_MS
208:        points = glide_points(start, end, duration_ms)

$ python -m pyflakes app/computer_operator/windows.py
app/computer_operator/windows.py:208:18: undefined name 'glide_points'   (exit 1)

$ python -m pytest tests/no_undefined_names_test.py -q
1 failed in 7.91s
```

Environment: Windows 11, PowerShell 5.1 (`pwsh` absent), Node 24.13.1,
Python 3.12. Commands were run from `D:\Desktop\Magic Pointer`.

---

## Summary

| BUG | Claim | Verdict | Evidence |
| --- | --- | --- | --- |
| BUG-001 | `Get-Process` per tick replaced by a C# pid-keyed `ProcessNameOf()` | VERIFIED | `grep -n "Get-Process" scripts/pointer_input_state.ps1` → only comment hits (256, 276). `ProcessNameOf` at `:282-295`; old loop confirmed at `git show 6c5b9ad:scripts/pointer_input_state.ps1` (`(Get-Process -Id $pidValue -ErrorAction SilentlyContinue).ProcessName`). |
| BUG-002 | `New-Object` + `Marshal::SizeOf` removed from the loop | VERIFIED (partial) | `New-Object` gone entirely. `Marshal.SizeOf(typeof(GUITHREADINFO))` **still runs once per tick** — it moved into C# at `pointer_input_state.ps1:324`. The reflection was relocated, not eliminated. |
| BUG-003 | hand-built JSON, key set/order preserved exactly | VERIFIED | `node tools/verify_poller_wire_shape.js` → `lines=207 malformed=0`. Differential harness against `git show 6c5b9ad:scripts/pointer_input_state.ps1`: `keys identical (order-sensitive): true`, `types identical: true`, values identical. |
| BUG-004 | 15.6 Hz before, 58.4 Hz after | VERIFIED (numbers approx.) | Old script re-run 4×: `effective_hz=16.5/16.3/16.8/16.9`, `gap p50=59.9/60.0/57.3/58.3`. New script 3×: `effective_hz=60.0/57.6/60.0`, `p50=16.5/16.6/16.6`. `Start-Sleep -Milliseconds 35` in isolation: min 36.2 / **median 47** / max 214 ms. |
| BUG-005 | compile-once DLL cache in `%LOCALAPPDATA%\MagicPointer` | VERIFIED | Cache file present (11264 B). Instrumented copy reports `CACHE_BRANCH=hit` vs `CACHE_BRANCH=compiled`; import cost median **294 ms (hit) vs 601 ms (compiled)**. Four degradation scenarios survived (below). One design hazard found — see Corrections. |
| BUG-006 | 1470 ms → 747 ms cold start | VERIFIED (magnitude overstated) | Interleaved 10 trials, old script median **1327 ms** (952–1651), new script warm median **957–985 ms**. Instrumented: compile path median 1204 ms, cache path 957 ms. The stated 723 ms saving measures **≈370 ms**. |
| BUG-007 | status `open` | n/a | Not a `fixed` entry. `executable = 'powershell.exe'` still at `electron/main.ts:465` (HEAD). |
| BUG-008 | here-string is assigned, never bare | VERIFIED (guard citation wrong) | `$Source = @"…"@` at `:9`. Mechanism independently reproduced: a bare here-string file prints one line per source line to stdout; the assigned form prints nothing. **The guard is not where the ledger says** — see Corrections. |
| BUG-009 | `move()`/`drag()` glide via `motion.py`; covered by `tests/computer_motion_test.py` | **FAILED** | `python -m pyflakes app/computer_operator/windows.py` → `windows.py:208:18: undefined name 'glide_points'`. Every animated `move`/`drag` raises `NameError`; backend returns `executed=False`. See below. |
| BUG-010 | `CLICK_SETTLE_MS` (20 ms) between positioning and press | VERIFIED | `motion.py:50`, `windows.py:224`. Measured `click(count=1)` = **59.1 ms** = 20 settle + 35 hold. Caveat: `drag()` and `scroll()` still press with zero settle — the same race remains on those two paths. |
| BUG-011 | `CLICK_HOLD_MS` (35 ms) between down and up | VERIFIED | `motion.py:43`. Source citation checked: `external/openclicky/cursor-buddy/OpenClickyComputerUseRuntime.swift` → `usleep(35_000)` between `leftMouseDown` and `leftMouseUp`. Measured `count=1` 59.1 ms, `count=2` **140.0 ms**. |
| BUG-012 | `motion.py` pure/stdlib, covered by tests | VERIFIED | `python -m pytest tests/computer_motion_test.py -q` all pass. Ledger says 20 tests; the file has **24**. But the suite cannot see the driver wiring, which is exactly where BUG-009's defect now lives. |
| BUG-013 | selection surface streams `answer_chunk` via `StreamChunkBuffer` | VERIFIED (one claim false) | `scripts/selection_bridge.py:2909` `progress_sink` handles `ModelChunk` and flushes on `TurnFinished`/`LoopStopped`; `TurnFinished` **is** imported. `_run_agent_loop_impl` (`loop.py:586`) swallows sink exceptions, and every exit path goes through `yield _stop(...)` (11 sites) — the tail cannot be stranded. At `6c5b9ad` selection_bridge emitted no `answer_chunk` while `main.ts` already consumed it (verified: only `plan` and `tool_activity` used `mark_blob`) — the "never emitted" claim is true. **"shared by both bridges" is false** — see Corrections. |
| BUG-014 | `selection_bridge` never imported `time`; fix adds it | VERIFIED (rationale false) | `import time` present at `:12`. But `python -m pyflakes scripts/selection_bridge.py` → `:12:1: 'time' imported but unused`. `time.perf_counter()` is called inside `bridge_progress.StreamChunkBuffer`, not here. The import is dead. |
| BUG-015 | `log()` buffered via `electron/append_log.ts` | VERIFIED | `createBufferedLog` at `main.ts:307`; `flushLog()` on `will-quit` (`:4836`) **and** `process.on('exit')` (`:4843`); `DEFAULT_FLUSH_INTERVAL_MS = 150`, `DEFAULT_MAX_PENDING_LINES = 5000`. Re-measured `node tools/measure_main_process_io.js`: `log() one line` **0.98 ms** (ledger 1.20), `appendFileSync only` **0.57 ms** (ledger 0.56). |
| BUG-016 | `stage:update` sent before `recordConversationTurn`/`autoStashResultImage` | VERIFIED | `electron/main.ts:1113` — `safeSurfaceSend('stage','stage:update', payload)` now precedes `recordConversationTurn`, `autoStashResultImage`, `watchTaskFromEvent`. Citation `:1088` points at the wrong line (actual `1083`). |
| BUG-017 | whole-store rewrite coalesced via `deferPersist` | VERIFIED | `conversation_store.ts:132` `deferPersist?: boolean` (default `false`), `CONVERSATION_PERSIST_DEBOUNCE_MS = 1000` (`:142`), timer `unref`'d (`:298`), `flush()` immediate (`:304`); `main.ts:1231` opts in; `flushConversations()` on both quit paths. Re-measured `persist()` e2e: **5.12 / 19.51 / 87.72 ms** for 0.40 / 3.16 / 13.17 MB (ledger 4.7 / 15.8 / 74–85). The "not fixed" note about `JSON.stringify` still being synchronous is honest and correct — `JSON.stringify` alone measured 1.94 / 17.09 / 39.62 ms. |
| BUG-018 | dead `log` option removed from `conversations()` | VERIFIED | `main.ts:1225-1232` now passes `{ baseDir, deferPersist }` only; `ConversationStoreOptions` (`conversation_store.ts:124`) declares `baseDir`, `now`, `deferPersist`, `persistDebounceMs` — no `log`. |

---

## Regression

`python -m pytest tests/ -q` (full suite, 329 s):

```
1 failed, 1906 passed, 1 warning in 329.30s
```

Baseline was **1869 passed, 1 warning**. The suite gained 38 tests
(`pytest tests/computer_motion_test.py tests/bridge_stream_chunks_test.py --collect-only -q` → `38 tests collected`), so the expected pass count was 1907. One
**pre-existing** test now fails:

```
FAILED tests/no_undefined_names_test.py::test_no_undefined_names_anywhere
E   AssertionError: 存在未定义名（生产路径 NameError 地雷）：
E     D:\Desktop\Magic Pointer\app\computer_operator\windows.py:208:18: undefined name 'glide_points'
```

That guard is tracked and unmodified since `6c5b9ad`, and `python -m pyflakes`
on the baseline copy of `windows.py` exits 0. So this is a **new regression
introduced by the BUG-009 fix**, caught by the repo's own guard, and the ledger
did not record it.

Node suite (the other half of the repo's `verify` script), for completeness:
`npm test` → `node suite passed: 203 test files`, exit 0. No TS/JS regressions.

---

## BUG-009 is not fixed — the glide path raises `NameError`

`Win32InputDriver._glide()` calls the bare name `glide_points`, but
`windows.py` imports only `from . import motion` and
`from .motion import CLICK_HOLD_MS, CLICK_SETTLE_MS` (`:19-20`). The name is
undefined. Minimal reproduction, real driver, raw input stubbed:

```
$ python -c "…Win32InputDriver().move((400,0), duration_ms=500)"
move RAISED NameError name 'glide_points' is not defined
drag RAISED NameError name 'glide_points' is not defined
move dur=0 OK (teleport)
```

End-to-end through `WindowsComputerOperatorBackend.execute()`:

```
click        -> executed=True  error=None
hover        -> executed=False error="windows_input_failed:NameError:name 'glide_points' is not defined"
hover(dur=250)-> executed=False error="windows_input_failed:NameError:name 'glide_points' is not defined"
drag         -> executed=False error="windows_input_failed:NameError:name 'glide_points' is not defined"
scroll       -> executed=True  error=None

=== same backend with the missing import patched in (win.glide_points = win.motion.glide_points) ===
hover        -> executed=True  error=None
drag         -> executed=True  error=None
```

This is a **functional regression**, not just a latent bug. At `6c5b9ad`,
`move()` did `del duration_ms; self._position(point)` and `drag()` had its own
inline stepped loop — both returned `executed=True`. Since `1d11515`, **every
HOVER and every DRAG action fails**, because the schema default of
`duration_ms=0` still routes through the distance rule
(`flight_duration_ms(400.0) == 600`) into `glide_points`.

That no test caught it is the point: `tests/computer_motion_test.py` (24 tests)
exercises `motion.glide_points` with the module qualifier, and
`tests/windows_computer_operator_test.py` drives a fake `_Driver` that never
touches `Win32InputDriver._glide`. BUG-012's own "why it hurts" — *"BUG-009 was
able to sit in the codebase precisely because no test covered 'a move should
take time'"* — applies verbatim to the defect that replaced it.

**With the name patched in, the intended behaviour is correct** (measured, real
driver, `_position` stubbed):

```
move(dist=400, duration_ms=0):    calls= 37 elapsed= 659.1ms expected= 600ms  last=(1576,2)  <- exact endpoint
move(dist=400, duration_ms=500):  calls= 31 elapsed= 546.8ms expected= 500ms  distinct=31
move(dist=400, duration_ms=1400): calls= 87 elapsed=1527.2ms expected=1400ms  distinct=84
GetCursorPos fails:               calls=[(1476,2)] elapsed=0.0ms (teleport fallback)
```

---

## Falsification attempts

**PowerShell poller — what I tried to break, and what happened** (all scenarios
kept the wire contract; `malformed=0` in every case):

| Scenario | Result |
| --- | --- |
| Cached DLL overwritten with garbage bytes | recovered: `CACHE_BRANCH=compiled`, first line 1262 ms, 167 valid lines |
| Cached DLL truncated to 0 bytes | recovered: first line 1704 ms, 125 valid lines |
| `%LOCALAPPDATA%` pointed at a *file*, so the cache dir cannot be created | fell through to in-memory compile, first line 2759 ms, 130 valid lines |
| `%LOCALAPPDATA%` unset/empty | `GetTempPath()` fallback, 246 valid lines |
| `MAGIC_POINTER_POINTER_POLL_MS=4` | 452 lines / 3 s |
| `MAGIC_POINTER_POINTER_POLL_MS=200` | 12 lines / 3 s |
| `MAGIC_POINTER_POINTER_POLL_MS=abc` | rejected, default 16 ms |
| `MAGIC_POINTER_POINTER_POLL_MS=1000000000` | rejected (`[int]` range check), default 16 ms |
| Kill a run and immediately restart | the cached DLL is held with a lock after `Add-Type -Path`; `Remove-Item` and `fs.unlinkSync` both fail with access-denied until the process fully exits. Harmless for the script (each start is a fresh process) but it silently corrupted two of my own measurement arms until I added a retry. |
| **Stale cache with an unbumped `$CACHE_VERSION`** | **BROKEN.** Copying the script to a temp dir, changing the emitted `"buttons"` key to `"buttons_MODIFIED"` and leaving `$CACHE_VERSION = "3"` produced `{"buttons":0,…}` — the *old* assembly was loaded, with no error, no warning and no test failure. |

**Motion policy (falsification of BUG-009/010/011/012):**

- `duration_ms = 10**9` → `glide_points` clamps to 119 points, `_glide` gives each a
  ~8 s delay. Unbounded in principle, but `ComputerAction.duration_ms` is
  validated `0 <= x <= 30_000` at `app/computer_operator/schema.py:144`, so the
  action path is bounded. `flight_duration_ms(1000.0, requested_ms=30001)`
  returns `30001` unclamped — only the schema stops it.
- **Cursor already on the target** → `distance == 0` → `flight_duration_ms`
  returns 0 → `glide_points` returns `[]` → single `_position(end)`. No divide
  by zero, no floor applied. Correct.
- **`GetCursorPos` fails** → `_cursor_position()` returns `None` → teleport.
  Verified.
- **`duration_ms = 30000` on a drag** → blocks **30177 ms** with the left button
  physically down, and `_glide` has no cancellation check, so `scope.raise_if_cancelled`
  is only consulted between actions. `WAIT` polls for cancellation; HOVER and DRAG
  do not.
- **`drag()` and `scroll()` press immediately after `SetCursorPos`** — the exact
  race BUG-010 documents and fixes in `click()`. Measured `scroll`: elapsed
  **0.0 ms** between the position call and the wheel event. The fix was applied
  to one of three call sites.
- `smoothstep` monotonicity, clamping, bounding box, endpoint contract — all
  hold; I could not break them.

**Streaming buffer (falsification of BUG-013):**

- Clock raises → `StreamChunkBuffer.flush()` catches, clears pending, does not
  propagate. Covered by `test_mark_failure_does_not_propagate` and verified by
  reading `bridge_progress.py:181-185`.
- Loop ends without `TurnFinished` → `LoopStopped` flushes. Every termination
  path in `loop.py` goes through the single `_stop()` helper (11 `yield _stop(...)`
  sites), and `_run_agent_loop_impl` wraps the sink in `except Exception: pass`.
- A raising `progress_sink` cannot kill the loop (`loop.py:591-594`).
- **`conversation_bridge.py` never imports `StreamChunkBuffer`.** It still has
  its own `_flush_answer_chunks` / `_flush_reasoning_chunks` (`:156-181`). The
  stated purpose — *"shared by both bridges so the two cannot diverge again"* —
  is not achieved; the duplication that caused BUG-013 is still there.
- The guard test `test_bridge_emits_answer_chunks` is
  `assert "answer_chunk" in source`. It passes for `conversation_bridge.py`,
  which does not use the shared buffer at all. It is a substring search over a
  file, not a wiring check — its own docstring concedes it "is not a substitute".

**Log buffer (BUG-015):** on any `appendFileSync` failure the entire pending
batch — up to 5000 lines — is discarded silently (`append_log.ts:114-120`).
That is deliberate (the test asserts it) and bounded, but a transient EBUSY on
the log file loses the tail with no signal. Also, hitting the 5000-line cap
forces a *synchronous* flush on the caller's hot path, so a log storm still
blocks the main thread — once, with a large payload, instead of many times.

**"X was never emitted" claims:** checked both.
`answer_chunk` — at `6c5b9ad` `selection_bridge.py` had exactly two `mark_blob`
sites (`plan`, `tool_activity`); no other path emitted the phase. True.
The BUG-008 here-string mechanism — reproduced directly (below), true.

---

## Corrections needed

1. **BUG-009 — status must change from `fixed` to `open`/`broken`.**
   `app/computer_operator/windows.py:208` references an undefined
   `glide_points`; HOVER and DRAG return `executed=False` for every non-zero-distance
   move. One-line fix: add `glide_points` to the `from .motion import …` list at
   `:20` (verified: patching the name makes both actions succeed). This also
   resolves the currently failing `tests/no_undefined_names_test.py`.
2. **BUG-006 — the stated numbers are not reproducible as measurements.**
   `1470 ms → 747 ms` are each attainable as individual samples, but the medians
   are `1327 ms → ~960 ms`: the saving is ≈370 ms, not ≈723 ms. The ledger should
   say so, or state `n` and the spread. "Remaining cost is `powershell.exe`
   process boot" is right — the compile is ~300 ms of the ~1200 ms.
3. **BUG-003/BUG-008 — "Guarded by the shape check in
   `tools/measure_poller_rate.js`" is wrong.** `measure_poller_rate.js` has no
   `JSON.parse` at all; it counts lines. The shape check lives in
   `tools/verify_poller_wire_shape.js`. (The line counter *would* notice a giant
   burst, but it is not a shape check.)
4. **BUG-005 — the stale-cache hazard is undocumented.** Forgetting to bump
   `$CACHE_VERSION` after editing the embedded C# silently serves the *old*
   compiled code, with no error and no test failure. Demonstrated. This deserves
   the same "recorded because the trap applies to any future edit" treatment
   BUG-008 got.
5. **BUG-013 — "shared by both bridges so the two cannot diverge again" is
   false.** `scripts/conversation_bridge.py` was not touched by `f273c6f` and
   still implements its own chunk buffer. Only `selection_bridge.py` uses
   `StreamChunkBuffer`.
6. **BUG-014 — the fix is a dead import.** `selection_bridge.py:12` imports
   `time` but nothing in the module uses it (`pyflakes`: `'time' imported but
   unused`). `time.perf_counter()` lives in `bridge_progress.py`. The
   "NameError near-miss" never existed in the shipped design.
7. **BUG-012 — "20 tests"** — `tests/computer_motion_test.py` contains **24**.
8. **BUG-002 — "Two managed round-trips … removed."**
   `Marshal.SizeOf(typeof(GUITHREADINFO))` still executes once per tick; it moved
   into `EmitSnapshot`. Say "moved into C#", not "removed".
9. **BUG-010 — the fix is incomplete and the entry should say so.** `click()`
   settles for 20 ms; `drag()` (`windows.py:255-256`) and `scroll()` (`:266-267`)
   still position-then-press with zero settle and retain the identical race.
10. **BUG-013/016 line citations are wrong.** `scripts/selection_bridge.py:2895`
    → `progress_sink` is at **2909**; `electron/main.ts:1088` → `updateStage` is
    at **1083**. (`electron/main.ts:5799` → 5797 at `f273c6f`, 5845 at HEAD,
    which is fair drift. `electron/main.ts:301` → `log()` is now at **309**
    after BUG-015's own comment block was inserted.)
11. **`scripts/pointer_input_state.ps1:264` — "The six `GetAsyncKeyState` reads"
    is five** (`IsDown(1/2/4/5/6)`).
12. **No ledger entry covers commit `f273c6f`'s stated defect** as its own
    item beyond BUG-013 — fine — but note that the ledger has no entry at all
    for the `tool/` measurement harnesses' own correctness, and
    `docs/perf/2026-09-16-baseline.md` still carries the stale `15.6 Hz` /
    `samples=47 over 8079ms` block. That block is **internally inconsistent**:
    47 samples over 8079 ms implies a mean gap of ≤176 ms (≤5.7 Hz), not the
    `effective_hz=15.6` printed beneath it. It should be marked superseded rather
    than left as the baseline (the electron audit at
    `docs/perf/2026-09-16-electron-audit.md:62` already flags it).
13. **BUG-017's `open` half is correctly stated** — worth keeping. The
    `JSON.stringify` figure I re-measured is 39.62 ms at 13.17 MB against the
    ledger's 42 ms; both are in the same place.

---

## Commands run (raw)

```
node tools/verify_poller_wire_shape.js
  -> lines=207 malformed=0
     sample={"buttons":0,"foregroundApp":"LockApp","foregroundHwnd":1640408,
             "foregroundProcessId":11056,"isWindowMoving":false,"scrollDelta":0,
             "swallowingLeft":false,"captureArmed":false}

node tools/measure_poller_rate.js            (x3, new script)
  -> samples=446 over 8036ms  gap p50=16.5 p90=16.9 p99=20.6 max=26.1  effective_hz=60.0
  -> samples=395 over 8041ms  gap p50=16.6 p90=18.5 p99=29.6 max=63.3  effective_hz=57.6
  -> samples=428 over 8045ms  gap p50=16.6 p90=17.1 p99=18.9 max=20.2  effective_hz=60.0

node <temp>/rate.js <temp>/old_pointer_input_state.ps1 8000   (x4, git show 6c5b9ad:…)
  -> samples=114 over 8033ms  gap p50=59.9 p90=70.5 p99=97.5  effective_hz=16.5
  -> samples=105 over 8080ms  gap p50=60.0 p90=70.5 p99=119.2 effective_hz=16.3
  -> samples=114 over 8046ms  gap p50=57.3 p90=72.6 p99=109.3 effective_hz=16.8
  -> samples=115 over 8039ms  gap p50=58.3 p90=66.8 p99=112.4 effective_hz=16.9

powershell … addtype_cost.ps1  -> TYPEDEF_COMPILE_MS=388,1,0,0
powershell … pathtest.ps1      -> ADD_TYPE_PATH_MS=161 / 130 / 144
powershell … sleep35.ps1       -> Start-Sleep -Milliseconds 35: min=36.2 median=47 max=214

node <temp>/branch2.js <instrumented copy> <cache dll> 4
  cache-present : branch=hit      importMs=219  firstLine=672
  cache-deleted : branch=compiled importMs=587  firstLine=1171
  cache-present : branch=hit      importMs=345  firstLine=1089
  cache-deleted : branch=compiled importMs=427  firstLine=829
  cache-present : branch=hit      importMs=373  firstLine=993
  cache-deleted : branch=compiled importMs=616  firstLine=1236
  cache-present : branch=hit      importMs=242  firstLine=920
  cache-deleted : branch=compiled importMs=646  firstLine=1279

node <temp>/interleave.js <new> <old> <cache> 10
  warm-cache  new script: [685,763,1730,1096,873,897]        median=897  mean=995.8
  no-cache    new script: [625,694,1567,1093,855,944]        median=944  mean=963.0
  baseline    old script: [1451,1145,2291,1499,1096,1208]    median=1451 mean=1448.3
  (10-trial repeat) old median=1327  new warm median=985  new cold median=857

node <temp>/adv.js   -> A corrupt-cache 167 lines malformed=0
                        B zero-byte-cache 125 lines malformed=0
                        C LOCALAPPDATA=file 130 lines malformed=0
                        D LOCALAPPDATA unset 246 lines malformed=0
                        E poll-ms 4/200/abc/1e9 -> all malformed=0

node <temp>/diff_shape.js <new> <old>
  keys identical (order-sensitive): true
  types identical: true
  non-volatile value fields match: true

python -m pyflakes app/computer_operator/windows.py
  app/computer_operator/windows.py:208:18: undefined name 'glide_points'
python -m pyflakes <baseline copy of windows.py>       -> exit 0
python -m pyflakes scripts/selection_bridge.py
  scripts/selection_bridge.py:12:1: 'time' imported but unused   (+ 8 other pre-existing warnings)

python -m pytest tests/computer_motion_test.py tests/windows_computer_operator_test.py \
               tests/computer_operator_test.py tests/bridge_stream_chunks_test.py -q
  -> 64 passed in 2.81s

python -m pytest tests/ -q
  -> 1 failed, 1906 passed, 1 warning in 329.30s

npm test
  -> node suite passed: 203 test files   (exit 0)

node tools/measure_main_process_io.js
  persist() e2e 0.40 MB → 5.12ms   3.16 MB → 19.51ms   13.17 MB → 87.72ms
  log() one line → 0.98ms          appendFileSync only → 0.57ms
```
