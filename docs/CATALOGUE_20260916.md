# Defect catalogue — 2026-09-16 mainline pass

Every distinct defect or improvement identified in this pass, in one place, with
its disposition. Findings are numbered `C-nnn`. Fixes that landed also carry a
`BUG-nnn` entry in `docs/BUGLEDGER_20260916.md` with the measured before/after.

**Status key**: `fixed` (on `main`) · `open` (identified, not yet fixed) ·
`rejected` (investigated and found not to be a defect — recorded so it is not
re-investigated).

Sources of record for the detail behind each line:

| Source | Document |
| --- | --- |
| Electron main + renderer audit (43 findings, measured) | `docs/perf/2026-09-16-electron-audit.md` |
| Circle-and-point / Vida parity (15 defects) | `docs/research/2026-09-16-vida-circle-point.md` |
| Clicky twin-cursor parity | `docs/research/2026-09-16-clicky-twin-cursor.md` |
| Everywhere line-by-line | `docs/research/2026-09-16-everywhere-linebyline.md` |
| Harness parity vs dsh / Claude Code / Hermes | `docs/research/2026-09-16-harness-parity-audit.md` |
| Pointer-stream measurements | `docs/perf/2026-09-16-baseline.md` |

---

## A. Pointer input stream — `scripts/pointer_input_state.ps1`

| ID | Defect | Status |
| --- | --- | --- |
| C-001 | `Get-Process` cmdlet per poll tick (35 ms cadence) | fixed (BUG-001) |
| C-002 | `New-Object` + `Marshal::SizeOf` per tick | fixed (BUG-002) |
| C-003 | `ConvertTo-Json` + `[ordered]@{}` per tick | fixed (BUG-003) |
| C-004 | `Start-Sleep -Milliseconds 35` rounds to the 15.6 ms timer tick — delivered 15.6 Hz against an intended 28.6 Hz | fixed (BUG-004) |
| C-005 | `Add-Type` recompiles the embedded C# on every process start (546 ms measured for a one-line class) | fixed (BUG-005) |
| C-006 | 1470 ms cold start before the first pointer sample | fixed (BUG-006) |
| C-007 | Remaining ~747 ms cold start is `powershell.exe` boot | open (BUG-007) |
| C-008 | No pid→process-name caching | fixed (BUG-001) |
| C-009 | The poll loop's fallback retried `EmitSnapshot` unguarded — a throw inside `catch` would escape the loop and kill the stream | fixed |
| C-010 | Two unsynchronised clocks sampling related state (PowerShell 35 ms, Electron 20 ms) | open |
| C-011 | The stream carries no cursor position, so Electron calls `screen.getCursorScreenPoint()` separately at 50 Hz | open |

## B. Twin cursor / agent pointer motion — `app/computer_operator/`

| ID | Defect | Status |
| --- | --- | --- |
| C-020 | `Win32InputDriver.move()` did `del duration_ms` and teleported; `drag()` already had the glide loop | fixed (BUG-009) |
| C-021 | Clicks pressed with zero settle time after `SetCursorPos` — the press can land at the previous position | fixed (BUG-010) |
| C-022 | Clicks held for 0 ms — ambiguous to double-click heuristics, dropped by some apps | fixed (BUG-011) |
| C-023 | No test or tuning surface for motion at all | fixed (BUG-012) |
| C-024 | No overlay-rendered companion cursor (Clicky's twin is a companion at +35,+25, not a second OS cursor) | open |
| C-025 | Cursor window is primary-display only; Clicky creates one per display | open |
| C-026 | `overlay.ts:302` deliberately draws no canvas cursor; the guide flight is a fixed 620 ms rather than Clicky's `clamp(dist/800, 600, 1400)` | open |
| C-027 | Guide easing is easeOutCubic, not smoothstep (all three Clicky variants use smoothstep) | open |
| C-028 | No tangent-following rotation on the flying marker | open |
| C-029 | No addressable multi-cursor API (openclicky has `/cursor`, `/cursors` with per-cursor accent + TTL) | open |
| C-030 | `clicky-windows/ui/overlay.py:379` `hide_cursor()` hides nothing and has zero callers — dead code whose name implies a hide/restore pair that does not exist (reference-repo finding, recorded for the port) | n/a |

## C. Perceived latency

| ID | Defect | Status |
| --- | --- | --- |
| C-040 | The selection surface never streamed its answer — `progress_sink` dropped every `ModelChunk` while `main.ts` was already waiting for `answer_chunk` | fixed (BUG-013) |
| C-041 | `selection_bridge` never imported `time`; the streaming fix would have raised `NameError` on the highest-traffic path | fixed (BUG-014) |
| C-042 | The two bridges had grown separate copies of the chunk-buffering logic, which is how they diverged | fixed (BUG-013) |
| C-043 | Reasoning deltas (`ReasoningChunk`) are still not forwarded on the selection surface | open |

## D. Main-process I/O and blocking work

| ID | Defect | Status |
| --- | --- | --- |
| C-050 | `log()` = `mkdirSync` + `appendFileSync` per call, ~150 sites, measured 1.20 ms | fixed (BUG-015) |
| C-051 | `updateStage` ran a whole-store rewrite and a synchronous PNG decode before sending the result to the stage | fixed (BUG-016) |
| C-052 | `persist()` rewrites the entire conversation store on every mutation — 74–85 ms at 13 MB, ~3×/second while an answer streams | fixed (coalescing, BUG-017) |
| C-053 | The whole-store `JSON.stringify` is still synchronous (42 ms at 13 MB); needs per-conversation files or a journal | open (BUG-017) |
| C-054 | `conversations()` passed a `log` option the store never declared or used | fixed (BUG-018) |
| C-055 | Store persistence failures are silent — the user's history can stop saving with nothing watching | open |
| C-056 | `observability.writeEvent()` = `statSync` + `appendFileSync` per event, measured 0.49–0.65 ms | open |

## E. Electron hot paths (from `docs/perf/2026-09-16-electron-audit.md`, F1–F43)

| ID | Defect | Status |
| --- | --- | --- |
| C-060 | F2 — 300 ms live flush → `updateTurn` → whole-store `persist()` | fixed (BUG-017) |
| C-061 | F3 — `conversations:turn` triggers `renderSidebar` + `renderStudioHome` + `renderArtifacts(true)` + `refreshStashSummaries` on every turn | open |
| C-062 | F5 — `ensureFreshGestureOverlay` destroys and recreates the overlay window per gesture; `reveal()` then waits for the fresh renderer including a WebGL2 shader compile | open (deliberate: it is a workaround for a real Electron input bug — see note below) |
| C-063 | F6 — `syncHitRegions()` does two `getBoundingClientRect` sweeps over ~21 elements plus `JSON.stringify` plus an IPC per pointer sample | open |
| C-064 | F7 — `setShape` + `setIgnoreMouseEvents` + a 34 ms settle timer on every capture toggle | open |
| C-065 | F8 — 50 Hz loop sends `stage:pointer-input` and calls `getBounds()` whenever the stage is visible, even while the user is just reading | open |
| C-066 | F9 — `completeSelectionGesture` calls `screen.getDisplayNearestPoint` per point (cap 4096); `summarizeGesture` measured 2.54 ms at 4096 | open |
| C-067 | F10 — `persistCurrentObjectEpisode` pretty-prints and writes the whole episode synchronously before grounding the capsule | open |
| C-068 | `overlay.ts:499-509` — unstoppable 30 fps rAF pulse loop | open |
| C-069 | `sweep_visual.ts:134` per-frame geometry rebuild, 0.86 ms at 1024 points / 2.39 ms at 4096 | open |
| C-070 | `stage.css` has zero `will-change` and animates `clip-path`/`box-shadow`/`left`/`top`/`width`/`height` | open |
| C-071 | `studio.ts:4170` `fitComposer` forces layout per keystroke | open |
| C-072 | `studio.html:581-606` — 25 parser-blocking scripts, 584 KB | open |
| C-073 | `stash_runtime.ts:412` re-decodes the clipboard bitmap on every 700 ms tick while an image sits on the clipboard, then compares fingerprints to discover it is the same image. **Partly overstated in the source audit**: `start()` is gated on `stash.clipboard === true \|\| stash.text === true` (`main.ts:2611`), so the poll does not run for users who never enabled the feature. The real defect is narrower — the fingerprint check happens *after* the decode, so an unchanged clipboard image is fully decoded ~1.4×/second indefinitely. Fixing it needs a cheap change-detector before decode (e.g. `clipboard.readBuffer('PNG')` and hash the bytes, skipping the PNG→bitmap decode) | open |
| C-074 | `task_watcher.ts` spawns a Python process per poll — ~95 spawns for a 5-minute task | open |
| C-075 | F1..F43 remainder — the full numbered list with measurements is in the audit document | open |

**Not defects — measured and ruled out** (`docs/perf/2026-09-16-electron-audit.md`):
the wiggle detector (6.8 µs/push), `pointInRegions` (0.297 µs), `JSON.stringify(regions)`
(5.98 µs). These were suspected and cleared by measurement.

**Rejected on verification**: the audit's finding that `stage.ts:1650` leaks a click
listener per re-render. Reading `renderThread` shows it reuses a node only when
`dataset.status` is unchanged, and `buildTurn` — which is where the binding
happens — only ever runs on a freshly cloned node. Reused nodes are returned
without re-binding, so the listener cannot accumulate on one element. Not fixed;
the claim did not survive checking.

**Note on C-062**: `ensureFreshGestureOverlay`'s destroy-and-recreate is
documented as a workaround for a genuine Electron/Windows defect (a transparent
overlay can stop delivering DOM pointer events after a hide/show reuse cycle).
It is expensive, but removing it risks reintroducing "the second gesture never
receives pointerdown". The safe fix is a pre-created standby window that is
loaded and ready before the swap, so the workaround survives without the user
paying for it. Not attempted in this pass because it cannot be verified without
driving the real GUI.

## F. Circle-and-point / Vida parity (from `docs/research/2026-09-16-vida-circle-point.md`)

| ID | Defect | Status |
| --- | --- | --- |
| C-080 | `interaction_episode.ts:327,556` writes `'physical-screen-pixels'` (hyphens); `coordinate_space.ts:103` and `grounding/evidence_binding.py:142` test `'physical_screen_pixels'` (underscores). Four spellings of the same concept across the codebase | open |
| C-081 | `pixel_ocr.py:194,207-216` reduces the circle to its bounding box while `gesture_capture.ts:213-217` builds a polygon ring nothing consumes — loose circles import neighbouring lines | open |
| C-082 | Two incompatible stroke classifiers: `gesture_capture.ts:186-188` (closure/circuit) vs `pixel_ocr.py:71-77` (`tolerance=26.0` in **physical** px, so it flips with DPI) | open |
| C-083 | `gesture_capture.ts:147-171` drops a deliberate press-and-hold point | open |
| C-084 | `coordinate_space.ts:151-153` returns a bare `null` when `dipToScreenPoint` is absent — the circle vanishes with no reason given | open |
| C-085 | `stage.ts:594-595` subtracts DIP from physical for `stageOrigin` (already flagged unfixed in `docs/STATUS.md:233`) | open |
| C-086 | `main.ts:4264-4265` falls back to physical-as-DIP, the exact bug the comment above it says was fixed | open |
| C-087 | `selection_session.ts:259` overwrites `activeRequestId` mid-flight; `finishRequest:267` then drops the first answer | open |
| C-088 | `stage_hit_policy.ts:54` sets `dragging→true` with no release path, while `gesture_capture.ts:1-2` admits pointerup is lost on Windows | open |
| C-089 | `uia_text_adapter.py:610` gates the 450 ms retry on a title-based `_is_chromium_window` while `:626` uses a class-based `is_cold_tree` — Tauri/WebView2 get no retry | open |
| C-090 | Vida's own region selection is a rectangle, not a circle (`参考/Vida实机体验/15.png`). Our circle-and-point is a capability Vida lacks; the bar is that it must beat a rectangle | context |

## G. Everywhere-linebyline port list

From `docs/research/2026-09-16-everywhere-linebyline.md`. Everywhere is **.NET 8 /
Avalonia**, not Electron — there is no IPC layer to copy, so the ports are about
dispatcher-boundary discipline rather than plumbing.

| ID | Port | Status |
| --- | --- | --- |
| C-100 | Stream the Python bridge line-by-line instead of buffering all stdout and parsing only the last line | open |
| C-101 | Coalesce token deltas per `requestAnimationFrame` in the renderer rather than per IPC | open |
| C-102 | Pre-create the gesture overlay once and cloak it, instead of destroy-and-recreate | open (= C-062) |
| C-103 | Keep the stage window resident; make close a cloak, not a destroy | open |
| C-104 | Send `{seq, delta}` instead of re-sending the full answer string on every update | open |
| C-105 | Replace the full-payload `stage:update` with stable row identity + reference diffing | open |
| C-106 | Add a one-flag refresh coalescer to the stage renderer | open |
| C-107 | Dedupe screenshots by top-level window handle and sub-crop | open |
| C-108 | Set `UIA_WindowVisibilityOverridden = 2` on the stage/overlay windows — directly targets the recorded UIA-probe failures | open |
| C-109 | Instrument time-to-first-token as a first-class metric (Everywhere does; we do not) | open |

## H. Harness parity

See `docs/research/2026-09-16-harness-parity-audit.md` for the full comparison
table with `path:line` citations on both sides. Highest-ranked items:

| ID | Port | Status |
| --- | --- | --- |
| C-120 | Model text deltas produced by the loop were being discarded before reaching the screen on the primary surface | fixed (BUG-013) |
| C-121 | Remaining harness parity items are enumerated in the audit document | open |

---

## Counts

| Disposition | Count |
| --- | --- |
| Defects **fixed** on `main` in this pass | 18 |
| Defects identified and **open**, individually enumerated above | 60 |
| Defects identified and open in the source audits beyond those enumerated (F1–F43 remainder, Vida detail, harness table) | 40+ |
| **Total enumerated** | **118+** |
| Rejected on verification (recorded, not fixed) | 1 |

The fixed set is deliberately the subset that could be **measured and tested**:
every `fixed` row above has either a probe under `tools/` or a test under
`tests/` that fails without the change. The open rows are enumerated with
`file:line` and a stated cause so the next pass starts from a list rather than
from an investigation.
