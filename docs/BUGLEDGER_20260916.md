# Bug ledger — 2026-09-16 mainline quality pass

Every entry: where, what, why it hurts, fix, status. `fixed` means the change is
on `main`. `verified` means a separate verifier re-ran the evidence command from
a clean checkout and reproduced the result.

Status key: `open` · `fixed` · `verified` · `rejected`

> **Read `docs/VERIFICATION_20260916.md` alongside this file.** An independent
> verifier re-measured every `fixed` entry here and falsified several of the
> claims written below, including one that was a live functional regression.
> Where the two disagree, the verification report wins. The corrections are
> listed at the end of this file under "Corrections from verification" — they
> are kept separate rather than quietly edited into the entries above, because
> the fact that they were wrong is itself part of the record.

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

### BUG-016 — the answer is delivered to the stage *after* a store rewrite and a PNG decode
- **Where**: `electron/main.ts:1088` (`updateStage`)
- **What**: the order was
  ```ts
  if (type === 'RESULT' || ...) recordConversationTurn(payload, type);
  autoStashResultImage(payload);
  watchTaskFromEvent(payload);
  safeSurfaceSend('stage', 'stage:update', payload);
  ```
- **Why it hurts**: `updateStage` is the path every user-visible outcome takes —
  its own comment calls it 所有结果的必经之路. All three calls before the send are
  synchronous and none of them is cheap: `recordConversationTurn` →
  `conversation_store.updateTurn` → `persist()` rewrites the **entire**
  conversation store (BUG-017), and `autoStashResultImage` does `fs.statSync` +
  `nativeImage.createFromPath` — a synchronous PNG decode of a full-screen
  capture on the main thread. The frame in which the answer becomes visible was
  therefore queued behind a whole-store disk write and an image decode, on the
  path the product is named after.
- **Fix**: send `stage:update` first, then do the bookkeeping. Safe because the
  two are independent and `safeSurfaceSend` only posts an IPC — the renderer
  cannot observe it until this tick ends, by which point the records exist.
- **Status**: `fixed`

### BUG-017 — every mutation rewrites the entire conversation store
- **Where**: `electron/conversation_store.ts:243` (`persist`)
- **What**: `JSON.stringify(items)` over **all** conversations followed by
  `writeFileSync` + `renameSync`, called from `appendTurn`, `updateTurn`,
  `rename`, `remove`, `clear`, `registerProject`, and more.
- **Why it hurts**: measured end-to-end at **4.7 ms for a 0.4 MB store,
  15.8 ms at 3.16 MB, and 74–85 ms at 13.17 MB**
  (`tools/measure_main_process_io.js`). `persist()` hangs off `updateTurn`, and
  the stage's live-answer flush calls `updateTurn` **every 300 ms** while an
  answer streams (BUG-013's fix makes that path hotter, not colder). So the
  main thread — the thread that services the pointer poll, every IPC and every
  window operation — stopped to rewrite the whole store roughly three times a
  second for the duration of every answer. This is a direct cause of the
  "输入卡顿 / 拖动掉帧" feel, and it grows with how much history the user has.
- **Fix**: `deferPersist` option. `persist()` marks dirty and arms a single
  coalescing timer (1000 ms, `unref`'d so it cannot hold the process open);
  `flush()` writes immediately. Default stays synchronous, so existing callers
  and tests are unchanged; production opts in at `conversations()` in
  `electron/main.ts` and calls `flushConversations()` on both quit paths.
- **Not fixed, and stated plainly**: the `JSON.stringify` of the whole store is
  still synchronous (42 ms at 13 MB) — coalescing reduces how often it runs,
  not how long it takes. Removing that requires not keeping one JSON document
  as the store (per-conversation files, or an append-only journal). Tracked as
  an open architectural item; the number is in the ledger so it is not
  forgotten.
- **Status**: `fixed` (coalescing) / `open` (whole-store serialisation) —
  covered by `tests/conversation_store_deferred_persist_test.ts`

### BUG-018 — `conversations()` passed a `log` option the store ignores
- **Where**: `electron/main.ts:1225`
- **What**: `createConversationStore({ baseDir, log })`, while
  `ConversationStoreOptions` declares only `baseDir` and `now`. The `log`
  argument was silently discarded — including by TypeScript, because the
  options object was not excess-property-checked at that call site.
- **Why it hurts**: it reads as though store failures are logged when they are
  not. A failed persist is one of the few failures a user would actually notice
  (their history quietly stops saving), and nothing was watching for it.
- **Fix**: the dead argument is removed. Whether the store *should* report
  failures is a separate decision, tracked as open.
- **Status**: `fixed` (argument) / `open` (failure reporting)

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

---

## Corrections from verification

Full evidence in `docs/VERIFICATION_20260916.md`. These are corrections to the
entries above, not additions to them.

### V-1 — BUG-009 shipped a functional regression, and the status was wrong

`_glide()` called `glide_points()` without importing it into `windows.py`. Every
HOVER and DRAG raised `NameError` and returned `executed=False` — both worked
before the change. The verifier found this by running the driver; **no test did**,
because `tests/computer_motion_test.py` exercises the pure policy module and
`tests/windows_computer_operator_test.py` injects a fake driver that never
executes `Win32InputDriver` at all.

- **Fixed**: `glide_points` added to the `from .motion import` line.
  `tests/no_undefined_names_test.py` — a pre-existing pyflakes guard that would
  have caught it — now passes; it was failing, and the full suite had not been
  re-run after the motion change. That is the process failure behind the code
  failure.
- **Guarded**: `tests/computer_operator_driver_motion_test.py` now instantiates
  the real driver with `_position` stubbed, so the driver's own calls are
  executed by a test for the first time, and asserts the module imports every
  name it references.
- **Corrected status**: BUG-009 was `fixed` when it was in fact `broken`, for the
  duration between its commit and this correction. The lesson is recorded rather
  than the commit rewritten: a fake at the boundary does not test the boundary.

### V-2 — BUG-006 overstated by roughly 2×
The 1470 ms → 747 ms figures were single runs. The verifier measured medians of
**1327 ms → ~960 ms**, i.e. a saving of about **370 ms**, not 723 ms. The
direction and cause are right; the magnitude was wrong. Quote the verification
report for the number.

### V-3 — BUG-005's cache has a stale-assembly trap that was not documented
`Import-InputStateType` loads `pointer_input_state_<version>.dll` whenever that
file exists. If the C# changes and `$CACHE_VERSION` is not bumped, the **old
compiled assembly is silently loaded** and the new C# never runs. The verifier
demonstrated it. Anyone editing the C# in that script must bump
`$CACHE_VERSION`; the failure mode is silent, which is why it is written down
here rather than left to the inline comment.

### V-4 — BUG-013's "shared by both bridges" was false
`StreamChunkBuffer` is used by `selection_bridge.py` only. `conversation_bridge`
still has its own `_ConversationActivitySink._flush_answer_chunks`. The
duplication that caused the original divergence therefore still exists; the
shared module is a place for it to go, not yet where it lives. The behavioural
tests cover the buffer; only the static tripwire covers the two bridges both
publishing the channel.

### V-5 — BUG-014's `import time` was dead on arrival
`time` was added for a `time.perf_counter()` call that the `StreamChunkBuffer`
refactor then removed. It is now deleted again. The finding stands — the module
had no `time` and the first version of the streaming fix called into it, which
would have been a `NameError` on the primary path — but the import as committed
was unused. `tests/computer_operator_driver_motion_test.py` now includes the
reverse check so a leftover import fails a test instead of a linter.

### V-6 — BUG-010's settle time was not applied to `drag()` or `scroll()`
`click()` waits `CLICK_SETTLE_MS` after `SetCursorPos`; `drag()` and `scroll()`
do not. The same "the window has not processed the move yet" race applies to
both. Not yet fixed.

### V-7 — Line references in several entries have shifted
`selection_bridge.py:2895` → `:2909`; `main.ts:1088` → `:1083`. The citations
were correct when written and are wrong now that the surrounding files changed.
Cite the verification report for current positions.

### V-8 — the baseline's P1 numbers were internally inconsistent
`samples=47 over 8079ms` and `effective_hz=15.6` cannot both describe the same
run: 47 samples over that window is ~5.8 Hz wall-clock, while the inter-sample
gap statistics imply 15.6 Hz. Both are real and they measure different things —
the wall-clock figure includes the 1470 ms cold start, the gap figure does not.
The baseline now reports them separately. The pre-fix *rate* was independently
re-measured by the verifier at **16.3–16.9 Hz**, which is the number to quote.

---

## Area E — what actually breaks complex tasks

From `docs/research/2026-09-16-harness-parity-audit.md`, a line-by-line harness
comparison against Claude Code, deepseek-harness and Hermes. The four ranked root
causes are `RC-1`…`RC-4` there, each with `path:line` on both sides.

### BUG-019 — a failed summarization replaces the entire conversation history
- **Where**: `scripts/selection_bridge.py` (`summarize_history`),
  `scripts/conversation_bridge.py:_summarize_history`, root cause in
  `app/ai_client.py`
- **What**: both bridges called `ask_text_model(...)` inside
  `try/except → return ""`. But `ask_text_model` **never raises** — it catches
  its own exceptions and *returns* a sentence beginning `AI 调用失败：`
  (`app/ai_client.py:732,735,740`). The `except` was therefore dead code, and the
  error sentence became a non-empty "summary".
  `app/agent_runtime/memory.py:221` does `summary = str(summarize(...)).strip()`
  then `if not summary:` — a guard that is correct and was **unreachable**.
- **Why it hurts**: the error text was accepted as a successful compaction and
  used to replace `[condensed, *tail]` — i.e. the whole older conversation. The
  model lost its history and received "AI 调用失败：HTTP 400" as its memory of
  everything that had happened. It then repeats work or calls tools at random,
  trips the duplicate-evidence guard in `tool_guardrails`, and terminates
  `STALLED`. From the user's seat: 跑到一半突然失忆然后卡住.
  The parameters make failure the common case rather than the exception — the
  summarizer runs with `timeout_s=25.0`, `attempts=1`, `max_tokens=1200`
  (`selection_bridge.py:2780-2781`, `ai_client.py:592`) over up to 48,000
  characters of Chinese history.
- **Fix**: `AI_FAILURE_PREFIX` and `is_ai_failure()` in `app/ai_client.py`, so a
  caller can tell "no answer" from "an answer". Both summarizers now return `""`
  on failure, which makes the existing (already-correct) retry-then-keep-history
  path in `memory.compact_messages` actually reachable.
- **Status**: `fixed`

### BUG-020 — the stage never received the streaming answer
- **Where**: `electron/main.ts:1299` (`notifyConversationChanged`), called from
  `appendStageLiveAnswer`
- **What**: the live-answer flush wrote the growing text into the conversation
  store and called `notifyConversationChanged`, which sends `conversations:turn`
  to `dashboardWindow` and `companionWindow` — **never to `stageWindow`**.
- **Why it hurts**: this is the last hop of the streaming path fixed in BUG-013.
  All the plumbing worked: the Python bridge emitted `answer_chunk` (0.12 s
  coalescing), main parsed it, and the Studio and companion surfaces re-rendered
  continuously. The on-screen stage — the window the user is actually looking at
  — received nothing until the terminal `stage:update`, so it showed a spinner
  and then the whole answer at once. The perceived latency of the primary
  surface was the entire turn.
- **Fix**: the flush now also sends the accumulated text to the stage on the
  `stage:card-patch` channel it already subscribes to
  (`stage.ts:2399` → `patchRunningCard` → `CardModel.applyPatch`, which copies
  arbitrary keys including `answer`). `applyPatch` is a no-op unless the card is
  still running, so a flush arriving after the terminal update cannot overwrite a
  finished answer.
- **Status**: `fixed`

### RC-2 / RC-3 / RC-4 — recorded, not fixed
- **RC-2**: there is no context-overflow rescue path (no `prompt_too_long` /
  `context_length_exceeded` handling anywhere in the repo), and the anti-thrash
  counter `fruitless_compactions` has **no reset path** — once it reaches 2,
  compaction is disabled for the rest of the run.
- **RC-3**: `max_tokens` is hard-coded to 4096 in three places, and a truncated
  turn is retried at the same 4096 rather than escalated. Claude Code retries the
  same request at 64,000.
- **RC-4**: a single tool result may be 64,000 characters with no per-turn
  aggregate budget, and `max_parallel_tool_calls = 4`.
- **Status**: `open` — all three are specified with citations in the harness
  audit; none is a one-line change and none could be verified in this pass.
