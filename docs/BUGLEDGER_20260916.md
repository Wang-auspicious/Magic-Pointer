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
