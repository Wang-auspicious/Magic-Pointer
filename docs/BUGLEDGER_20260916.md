# Bug ledger — 2026-09-16 mainline quality pass

Every entry: where, what, why it hurts, fix, status. `fixed` means the change is
on `main`. `verified` means a separate verifier re-ran the evidence command from
a clean checkout and reproduced the result.

Status key: `open` · `fixed` · `verified` · `rejected`

---

## Area A — pointer input stream (`scripts/pointer_input_state.ps1`)

This process feeds every field of `pointerInputState` in `electron/main.ts`,
which drives wiggle wake, mouse-button wake, dismiss-on-click, and pass-through
gesture chaining. Baseline measurements in `docs/perf/2026-09-16-baseline.md`.

### BUG-001 — `Get-Process` cmdlet runs on every poll tick
- **Where**: `scripts/pointer_input_state.ps1` (old loop body, foreground process name)
- **What**: every tick called `(Get-Process -Id $pidValue -ErrorAction SilentlyContinue).ProcessName`.
- **Why it hurts**: `Get-Process` is a PowerShell cmdlet that resolves, snapshots
  and materialises a `Process` object per invocation — single-digit milliseconds
  against a 35 ms budget, on a loop whose whole job is to be cheap. The foreground
  process changes a few times an hour, so the answer was almost always identical.
- **Fix**: `ProcessNameOf()` in C# with a pid-keyed cache (`scripts/pointer_input_state.ps1`).
- **Status**: `fixed` — `49533e8..` follow-up commits.

### BUG-002 — `New-Object` + `Marshal::SizeOf` per tick
- **Where**: same loop, `GUITHREADINFO` construction
- **What**: `$info = New-Object MagicPointerInputState+GUITHREADINFO` then
  `$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)`.
- **Why it hurts**: `New-Object` is reflection-based and allocates; `SizeOf` is
  another reflection entry per tick. Two managed round-trips for a struct that
  is a stack local in any other language.
- **Fix**: struct built inside `EmitSnapshot()` in C#.
- **Status**: `fixed`

### BUG-003 — `ConvertTo-Json` + `[ordered]@{}` per tick
- **Where**: same loop, output serialisation
- **What**: an ordered hashtable piped into `ConvertTo-Json -Compress` every tick.
- **Why it hurts**: cmdlet pipeline setup, hashtable allocation, and a JSON
  serialiser driven by reflection — per sample, 28 times a second, forever.
- **Fix**: hand-built JSON written straight to `Console.Out` in `EmitSnapshot()`.
  Key set and key order are preserved exactly (verified against the old wire
  shape).
- **Status**: `fixed`

### BUG-004 — `Start-Sleep -Milliseconds 35` never slept 35 ms
- **Where**: `scripts/pointer_input_state.ps1`, old loop tail
- **What**: `Start-Sleep -Milliseconds 35`.
- **Why it hurts**: `Start-Sleep` rounds up to the default Windows 15.6 ms timer
  tick, so the requested 35 ms became ~46–50 ms before the per-tick work was even
  added. Measured end-to-end: **15.6 Hz against an intended 28.6 Hz**, p50 gap
  63.1 ms, p99 110.3 ms. The wake detector's budget is **50 ms**
  (`app/governance/latency_budget.py`, `Stage.WAKE_DETECTION`) — a sampling
  period longer than the budget it feeds cannot meet it. A fast wiggle or a click
  can fall entirely between two samples.
- **Fix**: `WaitForNextTick()` uses `CreateWaitableTimerEx` with
  `CREATE_WAITABLE_TIMER_HIGH_RESOLUTION` — ~1 ms pacing without raising the
  global timer resolution for the machine. Interval is now 16 ms and configurable
  via `MAGIC_POINTER_POINTER_POLL_MS`.
- **Measured after**: **58.4 Hz**, p50 gap 16.6 ms, p90 18.0 ms, p99 26.4 ms.
- **Status**: `fixed`

### BUG-005 — `Add-Type` recompiles the C# on every process start
- **Where**: `scripts/pointer_input_state.ps1`, script preamble
- **What**: the embedded C# was passed to `Add-Type -TypeDefinition` on every launch.
- **Why it hurts**: `Add-Type` invokes the CodeDom/C# compiler at runtime.
  Measured at **546 ms / 506 ms** for a trivial one-line class; this file's C# is
  substantially larger. The pointer stream therefore paid a compiler before its
  first sample, every time it started — including every restart of the polling
  loop after a settings change or pause.
- **Fix**: `Import-InputStateType` compiles once to
  `%LOCALAPPDATA%\MagicPointer\pointer_input_state_<version>.dll` and loads the
  cached assembly thereafter; the version is in the filename so a new version
  never collides with an old file. Falls back to in-memory compile if the profile
  is read-only or the DLL is locked.
- **Status**: `fixed`

### BUG-006 — 1.47 s cold start before the first pointer sample
- **Where**: `scripts/pointer_input_state.ps1` → `startPointerInputStateStream()`, `electron/main.ts:452`
- **What**: measured time from `spawn` to the first JSON line on stdout: **1470 ms**.
- **Why it hurts**: `applyConfiguredWakeState()` starts and stops this stream.
  Every stop/start pair costs 1.47 s during which `pointerInputState` is frozen at
  its last value — wiggle wake, side-button wake and dismiss-on-click are all
  decided on stale data, and the user experiences the trigger simply not working.
- **Fix**: cached assembly (BUG-005) plus the lighter loop.
- **Measured after**: **747 ms**. Remaining cost is `powershell.exe` process
  boot, which cannot be removed without replacing the host.
- **Status**: `fixed` (further reduction tracked as BUG-007)

### BUG-007 — PowerShell host boot is the remaining cold-start cost
- **Where**: `electron/main.ts:457` — `executable = 'powershell.exe'`
- **What**: ~400–500 ms of the remaining 747 ms is `powershell.exe` initialising
  before the script's first statement runs.
- **Why it hurts**: it is pure overhead on the pointer path. The script now does
  all its real work in compiled C#, so the PowerShell host is a launcher.
- **Fix**: not yet applied — candidates are a precompiled `.exe` (host the same
  C# as a console app, spawn it directly) or keeping the stream resident for the
  process lifetime instead of stopping it.
- **Status**: `open`

## Area B — twin cursor / agent pointer motion (`app/computer_operator/`)

### BUG-009 — `move()` accepts a duration and throws it away
- **Where**: `app/computer_operator/windows.py:185` (`Win32InputDriver.move`)
- **What**: `def move(self, point, *, duration_ms): del duration_ms; self._position(point)`
- **Why it hurts**: every agent-initiated pointer move was an **instantaneous
  teleport**. `drag()` immediately below it already had the stepped-glide loop,
  so the capability existed and simply was not used for the common case. A
  teleporting pointer is the single biggest difference between this product and
  Clicky: the user cannot follow what is being aimed at, cannot predict the next
  action, and cannot interrupt in time. It also reads as a glitch rather than as
  an agent doing something.
- **Fix**: `app/computer_operator/motion.py` (new) holds the motion policy;
  `Win32InputDriver._glide()` walks the pointer along smoothstep-eased
  intermediate points and always sets the exact end afterwards. `move()` and
  `drag()` both use it. Constants are Clicky's, read off
  `external/clicky/leanring-buddy/OverlayWindow.swift:510` —
  `min(max(distance / 800.0, 0.6), 1.4)` **seconds** — i.e. 1.25 ms per pixel,
  floored at 600 ms and capped at 1400 ms.
- **Status**: `fixed` — covered by `tests/computer_motion_test.py`

### BUG-010 — clicks press with zero settle time after moving
- **Where**: `app/computer_operator/windows.py` (`Win32InputDriver.click`)
- **What**: `self._position(point)` immediately followed by `_mouse(down); _mouse(up)`.
- **Why it hurts**: `SetCursorPos` only *queues* the move. The target window has
  not necessarily processed the resulting `WM_MOUSEMOVE`, so a press sent
  immediately can be delivered at the **previous** pointer position. This is the
  classic synthetic-input race and is why synthesized clicks appear to "miss"
  or hit the wrong control.
- **Fix**: `CLICK_SETTLE_MS` (20 ms) between positioning and press.
- **Status**: `fixed`

### BUG-011 — a click is held for 0 ms
- **Where**: same function
- **What**: `_mouse(down)` immediately followed by `_mouse(up)`.
- **Why it hurts**: a zero-length press is ambiguous to double-click heuristics
  and is dropped outright by some applications. Clicky holds ~35 ms
  (`OpenClickyComputerUseRuntime.swift:1106`).
- **Fix**: `CLICK_HOLD_MS` (35 ms) between down and up, and between repeats.
- **Status**: `fixed`

### BUG-012 — the motion policy had no test and no way to be retuned
- **Where**: `app/computer_operator/`
- **What**: the interpolated path existed only inline inside `drag()`; nothing
  asserted that easing happened, that the path stayed in bounds, or that the
  final position was exact.
- **Why it hurts**: BUG-009 was able to sit in the codebase precisely because no
  test covered "a move should take time". Unmeasured motion is untunable, and
  the user's core complaint was about motion feel.
- **Fix**: `motion.py` is pure and stdlib-only; `tests/computer_motion_test.py`
  covers easing shape, clamping at both ends, step-count bounds, in-box
  containment, and the endpoint contract.
- **Status**: `fixed`

## Area C — perceived latency (`scripts/selection_bridge.py`)

### BUG-013 — the selection surface never streamed its answer
- **Where**: `scripts/selection_bridge.py:2895` (`progress_sink`)
- **What**: `progress_sink` handled ten loop event types — `LoopStart`,
  `ToolsTruncated`, `TurnStarted`, `TurnFinished`, `BudgetRenewed`,
  `ToolCallStarted`, `ToolCallFinished`, `Steered`, `FollowupContinued`,
  `BackendRecovery` — and silently dropped `ModelChunk`. The chain is a plain
  `if/elif` with no `else`, so the deltas were discarded without a trace.
- **Why it hurts**: the receiving end was already built and waiting.
  `electron/main.ts:5799` reacts to `phase=answer_chunk` by calling
  `appendStageLiveAnswer`, which batches into the conversation turn every
  300 ms; `conversation_bridge` has always emitted that phase, so the Studio
  surface streamed normally. The circle-and-point surface — the primary one —
  showed a spinner and then the entire answer at once. Same model, same turn,
  two surfaces, only one of them streamed. This is the single largest
  contributor to "响应起来特别特别慢": the user was not waiting for the answer,
  they were waiting for the answer *plus* the whole turn, with no text until
  the end.
- **Fix**: `StreamChunkBuffer` in `scripts/bridge_progress.py`, shared by both
  bridges so the two cannot diverge again; `progress_sink` feeds it
  `ModelChunk` and flushes on `TurnFinished`/`LoopStopped` so the tail of an
  answer is never stranded in the buffer. The first delta always flushes —
  time-to-first-token is what the user feels — and later deltas coalesce at
  120 ms so the stderr line protocol is not flooded with one row per token.
- **Status**: `fixed` — covered by `tests/bridge_stream_chunks_test.py`

### BUG-014 — `selection_bridge` never imported `time`
- **Where**: `scripts/selection_bridge.py` (module imports)
- **What**: the module used no `time` at all, and had no `import time`. The
  streaming fix above calls `time.perf_counter()`.
- **Why it hurts**: would have been a `NameError` on the first model delta of
  every selection turn — the highest-traffic path in the product — while
  passing a syntax check and every existing test, because the sink is a closure
  inside a multi-thousand-line function that no test instantiates.
- **Status**: `fixed` (recorded because the near-miss is the finding: this
  path has no behavioural test coverage, which is also why BUG-013 survived)

---

## Area D — main-process I/O (`electron/main.ts`)

### BUG-015 — `log()` does synchronous filesystem I/O per call
- **Where**: `electron/main.ts:301` (`log`)
- **What**: `fs.mkdirSync(RUNTIME_DIR, { recursive: true })` followed by
  `fs.appendFileSync(LOG_PATH, ...)` on every invocation, across ~150 call
  sites — including one per bridge progress record, which is per-event.
- **Why it hurts**: measured at **1.20 ms per call** (`appendFileSync` alone
  0.56 ms), on the main process thread — the same thread that services the
  20 ms pointer poll, every IPC handler, and every bridge progress line.
  A logging call is not worth blocking the UI for, and the `mkdirSync` was
  re-checking a directory that had existed for hours.
- **Fix**: `electron/append_log.ts` — `createBufferedLog`. `log()` becomes a
  push; lines are written in one batched `appendFileSync` on a 150 ms timer,
  and the directory is created once. Flushed on `will-quit` and on
  `process.on('exit')` so a shutdown or a crash does not lose the tail — the
  tail being the part anyone actually reads. A burst is capped at 5000 pending
  lines so a runaway logger cannot grow the buffer without bound.
  Deliberately synchronous on flush rather than `appendFile`: a pending async
  write can land after the shutdown flush and invert the end of the log.
- **Compatibility**: the repo's verification scripts poll the log with
  `wait_for_log(..., timeout=20)` at 150 ms intervals
  (`scripts/verify_first_run_onboarding.py:151`), so a 150 ms write delay is
  inside tolerance.
- **Status**: `fixed` — covered by `tests/append_log_test.ts`

### BUG-008 — a here-string that is not an argument leaks to stdout
- **Where**: `scripts/pointer_input_state.ps1` preamble
- **What**: introducing `$Source = @"…"@` was necessary; a bare `@"…"@` in
  PowerShell is an expression, and its value is written to the output stream —
  which in this process is the snapshot wire `electron/main.ts` parses. The
  compiler source would have been emitted as a "sample".
- **Why it hurts**: would have produced gigabytes of unparseable lines and
  broken `pointerInputState` entirely. Caught before merge; recorded because the
  same trap applies to any future edit of this file.
- **Fix**: the here-string is assigned, never bare. Guarded by the shape check in
  `tools/measure_poller_rate.js`.
- **Status**: `fixed`
