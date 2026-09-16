# Electron-layer performance audit — 2026-09-16

Recon worker E. Scope: `electron/main.ts`, `electron/renderer/{stage,overlay,studio,sweep_visual,card_render}.ts`,
the `electron/*_policy.ts` / `*_runtime.ts` modules they call, plus the `electron/renderer/*.html` script graph.

Everything below was read in the source. Numbers marked *measured* come from the two harnesses under
`tools/` that accompany this file; nothing here is estimated from vibes.

## Measurement harnesses

| script | what it measures | how to run |
| --- | --- | --- |
| `tools/measure_electron_hotpath.js` | pure-module microbenchmarks (pointer tick, gesture commit, sweep geometry, progress splitter) | `npx tsx tools/measure_electron_hotpath.js` |
| `tools/measure_main_process_io.js` | the synchronous fs patterns that block the main thread | `node tools/measure_main_process_io.js` |
| `tools/measure_poller_rate.js` | (pre-existing) rate of the PowerShell pointer state stream | `node tools/measure_poller_rate.js` |

### Raw output — I/O that runs inside the main process

```
=== conversation_store.persist() — runs on EVERY updateTurn (300ms live flush) ===
  store: 5 conversations x 6 turns = 0.40 MB of JSON
    persist() end-to-end (stringify+write+rename)               n=  20  per_call=    4.10ms
  store: 20 conversations x 12 turns = 3.16 MB of JSON
    persist() end-to-end (stringify+write+rename)               n=  20  per_call=   17.96ms
  store: 50 conversations x 20 turns = 13.17 MB of JSON
    persist() end-to-end (stringify+write+rename)               n=  20  per_call=   85.41ms

=== main.ts log() — mkdirSync + appendFileSync, ~150 call sites ===
log() one line (mkdirSync + appendFileSync)                     n= 200  per_call=    0.98ms
appendFileSync only (dir already exists)                        n= 200  per_call=    0.53ms

=== observability.writeEvent() — statSync + appendFileSync per event ===
writeEvent (statSync + appendFileSync)                          n= 200  per_call=    0.49ms
```

### Raw output — pure-module hot paths

```
pointInRegions(16 regions), hit                             per_call=    0.297us
JSON.stringify(16 regions)                                  per_call=    5.975us
nativeShapeRegions(16 regions)                              per_call=    1.410us
WiggleDetector.push, monotonic clock (production shape)     per_call=    6.847us   (window-bounded: 17 points)
MouseActivationDetector.push                                per_call=    0.023us
boundGestureInput(256 points)                     per_call=    0.832us
summarizeGesture(1024 points)                     per_call=  698.492us
summarizeGesture(4096 points)                     per_call= 2544.524us
buildSdfPath(256 raw points)  [per drawing frame] per_call=  153.682us
buildSdfPath(1024 raw points) [per drawing frame] per_call=  855.785us
buildSdfPath(4096 raw points) [per drawing frame] per_call= 2387.286us
String += of 2000 x 190-byte chunks (per answer)  per_call=  395.601us
Buffer.from(base64).toString(utf8) x 2000 chunks  per_call= 3099.699us
```

### Raw output — pointer state stream (re-measured; the committed baseline is stale)

```
samples=402 over 8051ms
gap p50=16.7 p90=19.3 p99=33.7 max=43.6
effective_hz=56.6
```

`docs/perf/2026-09-16-baseline.md` reports 15.6 Hz for this stream. That is no longer true: the
PowerShell host was rewritten to a high-resolution waitable timer (`scripts/pointer_input_state.ps1:434`,
`WaitForNextTick`), and it now delivers 56.6 Hz with p99 33.7 ms. The stale number matters because it
is the one the "two clocks" story was built on — the real mismatch is now the opposite direction
(see F6).

---

## Findings

### F1 — The answer card is delivered to the stage *after* a full conversation-store rewrite and a synchronous PNG decode

- **Where**: `electron/main.ts:1088-1095`
- **What**:
  ```ts
  if (type === 'RESULT' || type === 'COMPLETE' || type === 'ERROR') recordConversationTurn(payload, type);
  autoStashResultImage(payload);
  watchTaskFromEvent(payload);
  safeSurfaceSend('stage', 'stage:update', payload);
  ```
- **Why it hurts**: `updateStage` is "所有结果的必经之路" (its own comment). The three calls it makes
  before `safeSurfaceSend` are all synchronous and all expensive:
  `recordConversationTurn` → `conversation_store.updateTurn` → `persist()` = `JSON.stringify(entire
  store)` + `writeFileSync` + `renameSync`, **measured 18 ms at a 3.16 MB store and 85 ms at 13 MB**;
  `autoStashResultImage` → `fs.statSync` + `nativeImage.createFromPath(file)` — a synchronous PNG
  decode of a full-screen capture on the main thread. So the frame in which the user's answer becomes
  visible is delayed by an image decode plus a whole-store disk write. This is the single most
  user-visible latency bug in the file, and it is on the path the product is named after.
- **Fix**: In `updateStage`, send `stage:update` first, then run `recordConversationTurn` and
  `autoStashResultImage` on `setImmediate`. Inside `autoStashResultImage`, replace
  `nativeImage.createFromPath` with `fs.promises.readFile` + `nativeImage.createFromBuffer`.
- **Severity**: P0
- **Confidence**: certain

### F2 — Every `conversations:turn` notification costs a full-store IPC plus three forced list rebuilds

- **Where**: `electron/main.ts:1263-1270` → `electron/renderer/studio.ts:4984-4989`
- **What**:
  ```ts
  function notifyConversationChanged(conversationId: string): void {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('conversations:turn', { id: conversationId });
    }
    ...
  ```
  ```ts
  Data.onChange(() => {
    renderSidebar();
    if (document.getElementById('studio-home')?.hidden === false) void renderStudioHome();
    renderArtifacts(true);
    refreshStashSummaries();
  });
  ```
- **Why it hurts**: `renderSidebar()` awaits `Data.conversations()` (`studio.ts:778`) which
  structured-clones the **entire** conversation store over IPC (all turns, all answers, all
  trajectories — the same 3-13 MB the store holds); `renderStudioHome()` adds
  `Data.conversationStats()` (another full-store round trip); `renderArtifacts(true)` forces a rebuild
  of the artifact list including a fresh `innerHTML` string; `refreshStashSummaries()` does another
  `stash:list` IPC. One `conversations:turn` therefore costs 2-4 full-document-round-trips plus three
  list rebuilds. See F3 for how often that fires.
- **Fix**: Give `renderSidebar`/`renderArtifacts`/`refreshStashSummaries` an incremental path keyed on
  the changed conversation id (the payload already carries `id`), and coalesce the whole handler
  behind a single trailing `requestAnimationFrame`/200 ms timer in `Data.onChange`.
- **Severity**: P0
- **Confidence**: certain

### F3 — The live-answer flush rewrites the whole conversation store and notifies both windows every 300 ms

- **Where**: `electron/main.ts:1311-1322`
- **What**:
  ```ts
  if (stageLiveFlushTimers.has(token)) return;
  stageLiveFlushTimers.set(token, setTimeout(() => {
    stageLiveFlushTimers.delete(token);
    const current = stageLiveTurns.get(token);
    if (!current) return;
    const result = conversations().updateTurn({ ... answer: stageLiveAnswers.get(token) || '' });
    if (result.ok) notifyConversationChanged(current.conversationId);
  }, 300));
  ```
- **Why it hurts**: 300 ms is the throttle, and each flush does `persist()` — the measured 18-85 ms
  synchronous whole-store write — on the main thread, plus the F2 storm in two renderer windows.
  During a stage answer stream that is 3.3 store rewrites/second; at a 3 MB store that is ~6 % of the
  main thread, at 13 MB ~28 %. `updateTurn` also rewrites `turn.at` and re-serialises `evidence`
  (1600-char `contentDigest`) in full each time.
- **Fix**: In `appendStageLiveAnswer`, keep the growing answer in memory only and persist it once at
  turn end (`recordConversationTurn` already runs then); raise the flush interval to ≥1 s for the
  renderer notification and split it from persistence. Add an incremental/append-only store path so
  `updateTurn` does not rewrite unrelated conversations.
- **Severity**: P0
- **Confidence**: certain

### F4 — Every gesture destroys and reboots the overlay renderer, and the drawing surface waits for it

- **Where**: `electron/main.ts:902-911`, `3561`, `3663`
- **What**:
  ```ts
  function ensureFreshGestureOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
    createOverlayWindow();
  }
  ```
  ```ts
  // armSelectionGesture()
  ensureFreshGestureOverlay();
  ...
  stageReadiness.whenReady(() => overlayReadiness.whenReady(show));
  ```
- **Why it hurts**: `createOverlayWindow` builds a new full-screen transparent `BrowserWindow`,
  `loadFile`s `index.html`, and `did-start-loading` calls `overlayReadiness.reset()`. The `reveal()`
  path then refuses to `showInactive()` + send `overlay:show` until the **fresh** renderer has
  booted and called `magicPointer.ready()`. That bootstrap runs three parser-blocking scripts
  (`electron/renderer/index.html:20-22`) and, at `overlay.ts:4`, constructs `SweepRenderer` — `getContext('webgl2')`
  plus two shader compiles and a program link — all before `ready()` is signalled. So every single
  wake pays a renderer cold start (window creation + document load + WebGL bring-up) before the user
  can draw, and `gesture-ready` (which is what sets `setIgnoreMouseEvents(false)`) is behind it too.
- **Fix**: Stop destroying the overlay per gesture. Keep one window and do the reset the comment
  actually needs (a `webContents.reload()` at most, and only after a failed gesture), or gate the
  gesture on the existing renderer and only recreate on the "second gesture never receives
  pointerdown" symptom. If a fresh process is truly required, create it *speculatively* when the arm
  begins and reuse it for the next arm.
- **Severity**: P0
- **Confidence**: certain

### F5 — `log()` is two synchronous file operations per line, called from ~150 sites including every bridge progress record

- **Where**: `electron/main.ts:301-308`
- **What**:
  ```ts
  function log(message: unknown) {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch (_) { /* Logging must never break the overlay. */ }
  }
  ```
- **Why it hurts**: measured **0.98 ms per call** (0.53 ms of it is the open/close of
  `appendFileSync` alone). It runs on the main thread — the same thread as the 20 ms pointer poll and
  every IPC handler. `runPythonBridge`'s `onProgress` calls `log()` for *every* progress record
  (`main.ts:5194`), and the Python side flushes answer/reasoning chunks every 120 ms
  (`scripts/conversation_bridge.py:119`), i.e. ~17 records/s → ~17 ms of blocking fs per second while
  an answer streams, plus the `dismissTemporarySurfaces` double log, plus every activation.
- **Fix**: Make `log()` append through a buffer flushed on a 250 ms timer (or `fs.promises.appendFile`
  with an ordered queue), and drop the `mkdirSync` after the first success (cache a boolean).
  `observability.writeEvent` (`electron/observability.ts:53-97`, measured 0.49 ms) needs the same
  treatment.
- **Severity**: P0
- **Confidence**: certain

### F6 — The 50 Hz main-process poll is the only consumer of a 56.6 Hz state stream, so samples are dropped

- **Where**: `electron/main.ts:3882-3884`, and `scripts/pointer_input_state.ps1:434`
- **What**:
  ```ts
  mousePollTimer = setInterval(() => {
    const now = Date.now();
    const pos = screen.getCursorScreenPoint();
  ```
  Stream measured at `effective_hz=56.6`, `gap p50=16.7`, against the script's `$pollIntervalMs = 16`.
- **Why it hurts**: the producer writes ~17.7 samples per 20 ms tick of the consumer; the consumer
  keeps only the last one. Every intermediate button transition is discarded. A mouse side-button
  click is a sub-20 ms event, and `mouseActivationDetector.push` only ever sees the level at tick
  boundaries — so a fast side-button press can be missed entirely, and the `t` fed to
  `wiggleDetector.push`/`mouseActivationDetector.push` is the *reader's* clock, not the sample's.
  (Wiggle detection itself is fine: measured 6.8 µs per push with a window-bounded 17-point history —
  the earlier suspicion that the detector scans a growing array does not survive measurement.)
- **Fix**: Drive the poll from the stream instead of a timer: in the `child.stdout.on('data')` handler
  (`main.ts:488-519`) push the freshly parsed sample straight into `processPassThroughGestureSample` /
  `mouseActivationDetector` / `wiggleDetector`, and keep the 20 ms timer only for the
  `overlay:cursor` / `stage:pointer-input` emission (or drop to a timer only when nothing is visible).
- **Severity**: P0 (correctness on the pointer path: missed wake/cancel)
- **Confidence**: certain (both rates measured)

### F7 — The pointer tick sends IPC to the stage unconditionally, 50 times a second

- **Where**: `electron/main.ts:3891-3903`
- **What**:
  ```ts
  if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
    const stageBounds = stageWindow.getBounds();
    stageWindow.webContents.send('stage:pointer-input', {
      t: now, x: pos.x - stageBounds.x, y: pos.y - stageBounds.y, screenX: pos.x, screenY: pos.y,
      buttons: Number(pointerInputState.buttons || 0),
    });
  }
  ```
- **Why it hurts**: one native `getBounds()` plus one structured-clone IPC per tick = 50/s, sent
  whenever the stage window is visible — including while the user is just *reading* a result card and
  no pointer interaction is possible. Every message lands in `handleVoicePointerInput`, which is the
  most expensive function in the renderer (F8).
- **Fix**: Only send when the stage is in an input-accepting state (the renderer already reports its
  state via `stage:state`; mirror it in main), and stop sending while `stageHitRegions` is empty and
  no selection session is live. Cache `stageBounds` and refresh it on `move`/`resize`/display change
  instead of calling `getBounds()` per tick.
- **Severity**: P0
- **Confidence**: certain

### F8 — `syncHitRegions()` performs two full `getBoundingClientRect` sweeps and an IPC window reshape per pointer sample

- **Where**: `electron/renderer/stage.ts:775-809`, called from `597`, `812`, `838`, `2140-2151`
- **What**:
  ```ts
  const hasInteractiveSurface = hasInteractiveStageSurface();
  const interactiveRegions = interactiveStageRegions();
  const wantCapture = hitPolicy.shouldCaptureMouse({ ... });
  const regions = (capsuleDrag || surfaceDrag) ? [fullViewport] : visibleStageRegions();
  const nextHitRegionKey = JSON.stringify(regions);
  if (wantCapture !== mouseCaptureOn || requestFocus !== keyboardFocusRequested || nextHitRegionKey !== hitRegionKey) {
    api.setMouseCapture(wantCapture, { requestFocus, regions });
  ```
- **Why it hurts**: `interactiveStageRegions()` (`stage.ts:747-773`) reads
  `getBoundingClientRect()` for the capsule, the thread panel, the passage button, the consent bar and
  **every enabled `<button>` inside three containers** (up to 12 more); `visibleStageRegions()`
  (`726-745`) reads nine more. Those are forced synchronous layout reads, and they happen inside a
  handler that has already written styles (`capsule.style.left`, `surfaceDrag.element.style.left`) in
  the same tick — the textbook read-after-write layout thrash. `shouldCaptureMouse` is
  `pointInRegions(pointer, interactiveRegions)` (`stage_hit_policy.ts:48-56`), so `wantCapture`
  flips every time the cursor crosses a button edge, and each flip fires an IPC
  (`stage:set-mouse-capture`) that makes main call `stageWindow.setShape()` — a native
  `SetWindowRgn` (F9). Measured JS-only cost of the bookkeeping is small
  (`JSON.stringify(16 regions)` = 5.975 µs, `pointInRegions` = 0.297 µs); the cost is the layout and
  the native reshape, and it is paid up to 50 times a second.
- **Fix**: Cache the region rects and invalidate them from a `ResizeObserver` + explicit
  `scheduleHitRegionRefresh()` calls instead of measuring inline; memoise `visibleStageRegions()` for
  a frame; skip the whole function when `state.name` is one of the states where
  `hasInteractiveStageSurface()` is false (`hasInteractiveStageSurface` already early-returns — do it
  before building any regions).
- **Severity**: P0
- **Confidence**: certain

### F9 — `setShape` + `setIgnoreMouseEvents` + a 34 ms settle timer on every mouse-capture toggle

- **Where**: `electron/main.ts:2322-2356`
- **What**:
  ```ts
  applyStageShape(transitionRegions);
  if (stageShapeSettleTimer) clearTimeout(stageShapeSettleTimer);
  stageShapeSettleTimer = setTimeout(() => { ... applyStageShape(stageHitRegions); }, 34);
  ...
  if (enabled && regions.length) stageWindow.setIgnoreMouseEvents(false);
  else stageWindow.setIgnoreMouseEvents(true, { forward: true });
  ```
  `applyStageShape` itself is `stageWindow.setShape(nativeShapeRegions({ ..., stageBounds: stageWindow.getBounds(), regions }))`.
- **Why it hurts**: three native window operations plus a timer per toggle, and the toggle is driven
  by pointer position (F8) — so crossing the edge of a chip while moving the mouse produces a
  `SetWindowRgn`, an ignore-mouse-state change, and a repaint of a full-screen transparent window each
  time, followed 34 ms later by a second `SetWindowRgn`. The 34 ms "settle" timer also keeps firing
  after the stage is hidden unless something else clears it.
- **Fix**: In `setStageMouseCapture`, short-circuit when `enabled` and the sanitised region list are
  identical to the last applied pair; drop the union-with-previous-regions + settle-timer pair (it
  exists to paper over the flicker that the toggling itself causes) and apply the regions once.
- **Severity**: P0
- **Confidence**: certain

### F10 — `completeSelectionGesture` does one native display lookup per gesture point, synchronously, before opening the session

- **Where**: `electron/main.ts:3704-3747`
- **What**:
  ```ts
  const toPhysical = (point: { x: number; y: number }) => {
    const px = Number(point.x) + gestureFrame.x;
    const py = Number(point.y) + gestureFrame.y;
    const pointDisplay = screen.getDisplayNearestPoint({ x: px, y: py });
    const pointSf = pointDisplay.scaleFactor || 1;
    ...
  };
  const physicalPoints = summary.points.map((point) => ({ ...toPhysical(point), t: point.t }));
  const physicalStrokes = summary.strokes.map((stroke) => ({ points: stroke.points.map(...) }));
  ```
- **Why it hurts**: `boundGestureInput` allows `MAX_OVERLAY_CAPTURE_POINTS = 4096` (`main.ts:207`), so
  this loop can run 4096 times, each with a `screen.getDisplayNearestPoint` plus a fresh
  `{x, y, t}` object. On top of that, `summarizeGesture` is measured at **0.70 ms for 1024 points and
  2.54 ms for 4096**, and `physicalGestureTrace` (called a few lines later at `4268`) re-maps and
  re-allocates the same points with an 8 × 512 cap. All of it happens on the `pointerup` path, before
  `getCaptureCommitCoordinator().complete()` and before the capsule is even asked to appear.
- **Fix**: Resolve the display set once — `screen.getAllDisplays()` at arm time is already available as
  `arm.displayBounds` + `display.scaleFactor` — and map points with a pure function that picks the
  containing display from that cached list, with no native call per point. Reuse the `physicalPoints`
  array computed here for the `physicalGestureTrace` call instead of recomputing.
- **Severity**: P0
- **Confidence**: certain (JS cost measured; per-call native cost is one synchronous call × N)

### F11 — Capture completion writes a pretty-printed JSON snapshot of the whole episode to disk before grounding the capsule

- **Where**: `electron/main.ts:439-444` (called at `4398`)
- **What**:
  ```ts
  const tempPath = `${currentObjectPath}.tmp`;
  fs.mkdirSync(path.dirname(currentObjectPath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, currentObjectPath);
  ```
  with `value.objects[].content = item.content || ''` — the full selected text — and
  `captureAttestation` / `perceptionTrace` / `annotatedPath` attached.
- **Why it hurts**: `onComplete` in `beginSelectionSession` runs `persistCurrentObjectEpisode(attached)`
  *before* `setPanelLayout`/`showStage`, i.e. before the capsule is told `groundingReady: true`. Two
  problems compound: `JSON.stringify(value, null, 2)` roughly doubles the byte count with indentation,
  and the payload includes the entire selected content plus the attestation trace. A perception result
  with a few KB of content can serialise and write several hundred KB synchronously, inside the
  latency the user experiences as "the bubble finally showed up".
- **Fix**: Move this off the critical path (`setImmediate` after the `showStage`/`updateStage` calls),
  drop the pretty-printing (`JSON.stringify(value)`), and stop embedding full `content` — store a
  digest and let the reader re-read the capture.
- **Severity**: P0
- **Confidence**: certain

### F12 — Two independent pointer clocks drive the same expensive renderer path

- **Where**: `electron/renderer/stage.ts:2177-2192` and `2375-2377` + `2435-2437`
- **What**:
  ```ts
  window.addEventListener('mousemove', (event) => {
    lastPointerPoint = { x: event.clientX, y: event.clientY };
    syncHitRegions();
    if (state.name === 'capsule-voice') {
      handleVoicePointerInput({ t: performance.now(), x: event.clientX, y: event.clientY, buttons: event.buttons });
    }
  });
  ```
  plus `api.onPointerInput((payload) => handleVoicePointerInput(payload))` fed by the 50 Hz main loop.
- **Why it hurts**: the same work is sampled by two clocks: the 20 ms `setInterval` in main (sending
  `stage:pointer-input`) and Chromium's `mousemove` dispatch. `handleVoicePointerInput` itself calls
  `syncHitRegions()` (`597`) and, in voice mode, the `mousemove` listener calls it *twice* per event
  (once directly, once inside `handleVoicePointerInput`). While the capsule is in voice mode with the
  pointer moving, that is up to 100+ full region sweeps per second, each with layout reads and
  possible IPC.
- **Fix**: Delete the `mousemove` listener; the IPC stream already carries `screenX/screenY` and
  `buttons` and is the authoritative source for `stageOriginX/Y`. If a local signal is needed for
  responsiveness while the stream is paused, use a single rAF-coalesced handler that reuses the last
  hit-region key.
- **Severity**: P0
- **Confidence**: certain

### F13 — `document.addEventListener('selectionchange', …)` forces layout on every selection change

- **Where**: `electron/renderer/stage.ts:1506` → `1414-1434`
- **What**:
  ```ts
  function syncPassageExpand() {
    if (passageBusy) return;
    const pick = passageRangeFrom(document.getSelection());
    ...
    const rect = pick.range.getBoundingClientRect();
    const size = passageExpand.getBoundingClientRect();
  ```
- **Why it hurts**: `selectionchange` fires on every pointer move that extends a text selection —
  i.e. continuously while the user drags, which is the exact interaction the passage-expand feature
  exists for. For a selection *outside* the answer card the cost is one `contains()` check
  (`passageRangeFrom` returns before touching the range), but once the drag enters the card each event
  runs `range.toString()` (a DOM string walk of the selection), two `getBoundingClientRect()` reads,
  and `scheduleHitRegionRefresh()` (`1433`) which queues a rAF *and* a 240 ms timer, both running the
  full F8 sweep — up to 2 full sweeps per selection event, with no throttle.
- **Fix**: Throttle `selectionchange` to one rAF (or 100 ms), keep the cheap `contains()` gate as a
  first-line filter, and skip the work entirely when `threadPanel.hidden` — there is nothing
  selectable then.
- **Severity**: P1
- **Confidence**: certain

### F14 — `renderModelNotice` and `renderThread` read layout immediately after writing it

- **Where**: `electron/renderer/stage.ts:2125-2134`, `1886-1895`, `1921-1923`
- **What**:
  ```ts
  noticeText.textContent = message;
  noticeBox.dataset.kind = transient ? 'progress' : 'warning';
  noticeBox.hidden = false;
  const rect = anchorSurface.getBoundingClientRect();
  const top = Math.min(window.innerHeight - 40, rect.bottom + 8);
  const left = Math.max(6, Math.min(window.innerWidth - noticeBox.offsetWidth - 6, rect.left));
  ```
  ```ts
  const anchor = anchorEl.getBoundingClientRect();
  chipsBox.style.left = `${anchor.left}px`;
  ```
- **Why it hurts**: `render()` writes a series of class/dataset/style changes for the capsule, the
  glow, the stretch handles and the thread, then `renderChips`/`renderDelivery`/`renderModelNotice`
  immediately read `getBoundingClientRect()`/`offsetWidth`. Every `render()` therefore ends with at
  least one forced synchronous layout of a full-screen transparent document. `render()` runs on every
  `stage:update`, every card patch, every model-health push and several dictation events.
- **Fix**: Batch the reads at the top of `render()` (measure once into local variables before any
  writes), or defer the placement pass to a single rAF scheduled at the end of `render()`.
- **Severity**: P1
- **Confidence**: certain

### F15 — Animated properties are non-composited, and the primary targeting visual animates `clip-path`

- **Where**: `electron/renderer/stage.css:98-99`, `125-126`, `203-213`, `234-244`, `1292`, `1998`, `2019`
- **What**:
  ```css
  transition: opacity 120ms ease-out, left 90ms ease-out, top 90ms ease-out,
    width 90ms ease-out, height 90ms ease-out;
  ```
  ```css
  .stage-root[data-selection-visual='sweep_band'] .frozen-glow {
    animation: selection-sweep-reveal ... both, selection-sweep-fade ... both;
  }
  @keyframes selection-sweep-reveal { from { clip-path: inset(0 92% 0 0 round 999px); } to { clip-path: inset(0 0 0 0 round 999px); } }
  ```
- **Why it hurts**: `will-change` appears in exactly three places repo-wide (`beam.css:33`,
  `styles.css:41,66`) — **zero** in `stage.css`. `left`/`top`/`width`/`height` transitions force
  layout + paint per frame; `clip-path` is not compositable in Chromium, so the default
  (`sweep_band`) selection sweep repaints its element every frame for 292 ms; and `stage-breathe`
  (`234-244`) animates `box-shadow` **infinitely** on the frozen glow for as long as it is visible,
  which is also a per-frame repaint of a large element. `delivery-bar` transitions `width`
  (`1998`), the selection-stretch hint transitions `width` (`1998`/`2019`).
- **Fix**: Convert the sweep to `transform: scaleX()` + `opacity` (both composited) on a
  `transform-origin: left center` element, drop the `box-shadow` keyframes in favour of an
  `opacity`-animated pseudo-element with a static shadow, and add `will-change: transform, opacity`
  to `.stage-composer`, `.frozen-glow`, `.targeting-outline`. Replace the `left/top/width/height`
  transitions with a `transform: translate()` on a wrapper.
- **Severity**: P1
- **Confidence**: certain

### F16 — `bindCardActions` adds a click listener to the same container on every re-render and never removes it

- **Where**: `electron/renderer/stage.ts:1647-1678`, churn source at `1295`
- **What**:
  ```ts
  function bindCardActions(container: HTMLElement, payload: any) {
    const actions = payload && Array.isArray(payload.actions) ? payload.actions : [];
    if (!actions.length) return;
    container.addEventListener('click', (event) => { ... });
  ```
  ```ts
  button.addEventListener('click', () => {
    agentPromptUi.selectedSession = item;
    renderStructured(container, payload);   // -> replaceChildren + bindCardActions(container, ...)
  ```
- **Why it hurts**: `renderStructured` replaces the container's *children* but the container element
  survives, so each re-render stacks another identical `click` listener on it. Clicking a session chip
  three times leaves four listeners; the next click on an action button then runs
  `api.executeAction` / `api.undoAction` four times per click (main rejects the repeats as
  "missing-or-expired token", so the visible symptom is N wasted IPC round trips and a log line per
  duplicate). This is both a leak and a duplicate-execution bug on the action path.
- **Fix**: Bind with a named handler and `removeEventListener` first — or better, bind once via
  delegation at the stage root keyed on `[data-act="action"]` + `data-action-id`, which the card
  markup already carries.
- **Severity**: P1
- **Confidence**: certain

### F17 — The overlay's 30 fps pulse loop runs for as long as the overlay is visible, doing nothing

- **Where**: `electron/renderer/overlay.ts:499-509`, started at `673`
- **What**:
  ```ts
  function startPulseLoop() {
    if (pulseRaf) return;
    function tick(now: number) {
      if (now - lastPulseFrame > 33) { lastPulseFrame = now; if (!captureMode) render(); }
      pulseRaf = requestAnimationFrame(tick);
    }
    pulseRaf = requestAnimationFrame(tick);
  }
  ```
- **Why it hurts**: the rAF callback itself runs at the display refresh rate (60-144 Hz) doing a
  subtraction, and `render()` (`271-303`) is called 30×/s. In non-gesture mode with `points.length === 0`
  `render()` is nearly a no-op, but on a 4K/144 Hz machine this keeps a full-screen transparent
  always-on-top window — with `backgroundThrottling: false` (`main.ts:875`) and content protection
  enabled (`main.ts:881-889`) — from ever going idle. The observer path (`observerMode`) exists only to
  draw the cursor trail, which is event-driven anyway (`onCursor` → `scheduleRender`).
- **Fix**: Delete `startPulseLoop`/`stopPulseLoop` and rely on `onCursor` + `scheduleRender`, which
  already coalesces to one rAF per frame and only renders when the pointer actually moved.
- **Severity**: P1
- **Confidence**: certain

### F18 — Sweep geometry is rebuilt from the raw stroke on every frame, allocating thousands of objects

- **Where**: `electron/renderer/overlay.ts:289-294` → `electron/renderer/sweep_visual.ts:134-154`, `400-416`
- **What**:
  ```ts
  if (gestureLineStyle === 'demo6_band') {
    sweepRenderer.render([{ points, opacity: trailAlpha, head: drawing }], gestureLineWidth);
  ```
  ```ts
  function smoothPath(points) {
    ...
    const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 6));
    for (let step = 1; step <= steps; step += 1) {
      const point = catmullRomPoint(p0, p1, p2, p3, step / steps);   // new object per step
  ```
- **Why it hurts**: `points` grows for the whole stroke (4.2 px gate, `overlay.ts:217`), and every rAF
  frame re-runs `smoothPath` → `resamplePath` → `addArcProgress` → new `Float32Array`s, discarding the
  previous frame's work. Measured: **0.15 ms at 256 raw points, 0.86 ms at 1024, 2.39 ms at 4096** —
  i.e. up to 14 % of a 60 Hz frame budget spent regenerating geometry that changed by one point, plus
  thousands of short-lived objects per frame (GC pressure shows up as periodic hitches).
- **Fix**: Cache the built path in `SweepRenderer.render` and invalidate it only when the point count
  changes or the last point moves more than ~2 px; append to the smoothed array incrementally instead
  of rebuilding. Keep `MAX_POINTS = 64` for the GPU upload but stop re-deriving it from scratch.
- **Severity**: P1
- **Confidence**: certain

### F19 — The overlay sends every sampled point to the main process and only then are the limits applied

- **Where**: `electron/renderer/overlay.ts:323-348`, `406-413`; limits at `electron/main.ts:207-208`, `3704`
- **What**:
  ```ts
  function computeSelectionPayload() {
    const allPoints = strokes.length ? strokes.flatMap((s) => s.points) : points;
    ...
    points: [...allPoints],
    strokes: strokes.map((s) => ({ points: [...s.points] })),
  ```
- **Why it hurts**: the caps (`MAX_OVERLAY_CAPTURE_POINTS = 4096`) live in main and are applied *after*
  the structured-clone IPC. A long/complex gesture therefore ships an unbounded array (the renderer
  gates only at 4.2 px spacing; a 5-second scribble can be 1000-3000 points) across the process
  boundary, and the copy is done twice (`flatMap` + spread for `points`, then again for `strokes`).
  Main then pays F10's per-point native lookups on whatever arrived.
- **Fix**: Cap in the renderer at the same constant before building the payload (decimate by arc
  length, not by dropping the tail), and skip the double copy by reusing `strokes` for `points`.
- **Severity**: P1
- **Confidence**: certain

### F20 — Studio panning repaints the full-viewport canvas background on every pointermove

- **Where**: `electron/renderer/studio.ts:182-191`, driven from `212-222`
- **What**:
  ```ts
  function applyCam() {
    const w = document.getElementById('canvas-world');
    if (!w) return;
    w.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
    const cv = document.getElementById('canvas');
    if (cv) cv.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    if (cv) cv.style.backgroundSize = `${22 * cam.k}px ${22 * cam.k}px`;
  ```
  ```ts
  cv.addEventListener('pointermove', e => { if (!drag) return; cam.x = e.clientX - drag.x; cam.y = e.clientY - drag.y; applyCam(); });
  ```
- **Why it hurts**: the world transform is composited (good), but `background-position` and
  `background-size` on the dot-grid canvas are paint-level properties — changing them every
  pointermove invalidates the paint of a full-viewport element, so panning the stash canvas repaints
  the whole scene in software each event, plus three `getElementById` lookups per event.
- **Fix**: Move the grid into the transformed layer (an inner absolutely-positioned element that
  inherits the pan by living inside `#canvas-world`) so panning is a single composited transform; at
  minimum, drive `applyCam` from one rAF per frame rather than per pointermove, and cache the three
  element handles.
- **Severity**: P1
- **Confidence**: certain

### F21 — Each streamed chunk rebuilds the whole pending body and scrolls the container

- **Where**: `electron/renderer/studio.ts:4500-4505`, `4383-4409`, `4413-4424`
- **What**:
  ```ts
  function appendLiveStreamText(text: string) {
    const pending = pendingConversation;
    if (!pending || !text) return;
    pending.streamText += text;
    followIfNearBottom(pending.body, renderPendingBody);
  }
  ```
  ```ts
  pending.body.replaceChildren(...els, ...renderLiveReasoningNode(), ...renderLiveStreamNode());
  ```
  ```ts
  pending.streamNode.textContent = pending.streamText;
  ```
- **Why it hurts**: `replaceChildren` detaches and re-attaches every live activity node on *every*
  chunk even though the nodes are memoised by signature — a full style/layout/paint invalidation of
  the turn body. Then `followIfNearBottom` (`4478-4486`) reads `scrollHeight`/`scrollTop`/`clientHeight`
  and writes `scrollTo({top: scrollHeight})` — a forced layout plus a scroll per chunk. And
  `renderLiveStreamNode` replaces the entire growing text node each time, which is O(n) per chunk and
  O(n²) per answer. Python flushes every 120 ms per stream (`conversation_bridge.py:119`) for both
  answer and reasoning, so this is ~17 rebuilds + scrolls per second mid-answer.
- **Fix**: Append only the new node when nothing was removed (`body.appendChild`), update only the
  stream node's text otherwise, and coalesce chunk handling behind one rAF; make the scroll follow a
  single `scrollTop = scrollHeight` assignment after the DOM update rather than a `scrollTo` with an
  options object.
- **Severity**: P1
- **Confidence**: certain

### F22 — Progress records cross the IPC boundary one at a time and are decoded from base64 in the renderer

- **Where**: `electron/main.ts:1962-1968`, `electron/python_bridge_runner.ts:168`, `electron/renderer/studio.ts:4361`
- **What**:
  ```ts
  onProgress: (record: any) => {
    const sid = sessionIdFromRecord(record);
    const entry = sid ? activeConversations.get(requestId) : null;
    if (sid && entry) entry.agentSessionId = sid;
    if (sender && !sender.isDestroyed()) sender.send('conversations:progress', { requestId, record });
  },
  ```
  ```ts
  appendLiveStreamText(ConversationControl.decodeChunkBlob(fields));
  ```
- **Why it hurts**: one `webContents.send` per progress record — no batching, no coalescing — and each
  answer chunk carries a base64 blob (33 % larger than the bytes it encodes) that the renderer decodes
  with `Buffer.from(...).toString('utf8')`. Measured: decoding 2000 such chunks costs **3.1 ms** of
  pure CPU, i.e. `Buffer.from` allocation per chunk. Combined with F21 each record also triggers a
  full body rebuild.
- **Fix**: Batch progress records in the main process on a 60-100 ms timer (the studio renderer is
  already a coalescing consumer); for `answer_chunk`/`reasoning_chunk` send the decoded UTF-8 string
  instead of base64, or concatenate chunks in main and send the accumulated tail.
- **Severity**: P1
- **Confidence**: certain

### F23 — `fitComposer` forces a synchronous layout on every keystroke

- **Where**: `electron/renderer/studio.ts:4170-4173`, bound at `4642`
- **What**:
  ```ts
  function fitComposer(ta: HTMLTextAreaElement) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(336, ta.scrollHeight)}px`;
  }
  ```
  ```ts
  ta.addEventListener('input', () => { fitComposer(ta); syncComposerSubmitState(); });
  ```
- **Why it hurts**: write (`height: auto`) → read (`scrollHeight`, forced layout) → write. One forced
  synchronous layout of the studio document per character typed, in the composer that is the product's
  primary input. On a long conversation (the studio DOM is large) that is tens of milliseconds of
  hidden latency per keystroke — the classic "typing feels heavy" complaint.
- **Fix**: Only measure when the text actually wraps: compare `ta.value.length` against a cached
  characters-per-line estimate for the current width, or measure on a rAF after the input burst
  settles. Better: drop the auto-grow entirely (a fixed-height composer with internal scroll), which
  removes the layout dependency.
- **Severity**: P1
- **Confidence**: certain

### F24 — The studio loads 25 parser-blocking scripts / 584 KB before it can paint

- **Where**: `electron/renderer/studio.html:581-606`
- **What**: 26 `<script src>` tags, all classic (no `type="module"`, no `defer`), each with a manual
  `?v=` cache-buster. Measured total of the 25 first-party files: **584 128 bytes** across
  ~15 k lines (`icons, cards, studio_shell, card_render, live_cards, dsh_markdown, dsh_icons, dsh_chat,
  dsh_trajectory, conversation_control, slash_trigger, permission_presets, effort_levels,
  popover_position, sidebar_groups, studio_search, studio_home, studio_subagents,
  studio_inspector_state, artifact_editor, task_sources, task_input_transport, data, settings_model,
  settings, studio`).
- **Why it hurts**: every one of these is fetched, parsed and executed synchronously in order before
  the first paint; `studio.ts` cannot run until all 24 preceding files have been evaluated, and
  `boot()` (`studio.ts:4809`) then awaits `renderSidebar()` (an IPC round trip) before anything
  meaningful is on screen. The version query strings also defeat HTTP caching between builds.
- **Fix**: Bundle the renderer scripts into one file at build time (the repo already has esbuild via
  `tsx`; `scripts/build-electron.ts` is the natural home), mark it `defer` so the shell HTML paints
  first, and render the static shell before booting data.
- **Severity**: P1
- **Confidence**: certain (file inventory + byte counts measured)

### F25 — Every startup work item is scheduled behind a fixed delay that races the first window

- **Where**: `electron/main.ts:4526`, `4530-4536`, `5360`, and `4607-4608`
- **What**:
  ```ts
  startModelHealthWatch();
  setTimeout(warmUpOcrWorker, 2500);
  ...
  setTimeout(() => { try { initializeStashRuntime(); } catch (error) { ... } }, 1200);
  ```
  ```ts
  setTimeout(() => { refreshModelHealth({ probe: true }); }, 1500);
  ```
- **Why it hurts**: `warmUpOcrWorker` spawns a *second* Python interpreter (after the pointer-state
  PowerShell host, the UIA resident host and later the frame-capture worker) with `stdio: 'ignore'`, at
  T+2.5 s — exactly while the user is looking at a first-paint dashboard that is still loading its own
  scripts. `initializeStashRuntime` starts a 700 ms clipboard poll (F26) at T+1.2 s. The model-health
  probe spawns a `fabric_bridge.py` process at T+1.5 s that will hold the interpreter for several
  seconds. Nothing serialises or de-prioritises them.
- **Fix**: Chain these on a single startup queue that waits for the first window's `did-finish-load`
  (and, for the OCR warmup, for an idle period), instead of three independent fixed timers.
- **Severity**: P1
- **Confidence**: certain

### F26 — The stash poll reads the clipboard image and does a native resize every 700 ms, forever

- **Where**: `electron/stash_runtime.ts:408-430`, `132-140`, `78`
- **What**:
  ```ts
  const formats = clipboard.availableFormats();
  if (settings()?.stash?.clipboard === true && formats.some((f: string) => f.startsWith('image/'))) {
    const image = clipboard.readImage();
    if (!image.isEmpty()) { await ingest(image, 'shot'); return; }
  }
  ```
  ```ts
  const small = image.resize({ width: SAMPLE, height: SAMPLE, quality: 'good' });
  ```
- **Why it hurts**: the app *itself* writes the image back with the bitmap kept
  (`stash_runtime.ts:250-253`, `write(payload.keepImage ? { image, text } : ...)`), so after the first
  screenshot the clipboard holds an image format indefinitely. Every 700 ms the main process then
  decodes the full bitmap via `readImage()` and resizes it natively in `sampleImage()` **before** the
  fingerprint comparison that would have short-circuited — the early-out at `line 238` is after the
  expensive part. A 4K screenshot is ~33 MB of raw bitmap copied and resampled 1.43 times a second.
- **Fix**: Compare `clipboard.availableFormats()` + a cheap `readText()`/`readImage()`-free signal (for
  example the clipboard sequence number via `clipboard.readImage` replaced by a native
  `GetClipboardSequenceNumber` probe, or simply remember that we wrote it and skip N polls); and move
  the fingerprint check above the resize by hashing a single `toBitmap()` sample without resizing.
- **Severity**: P1
- **Confidence**: certain

### F27 — Task watching spawns a Python interpreter per poll, once a second for the first ten seconds

- **Where**: `electron/task_watcher.ts:22-27`, probe wired at `electron/main.ts:1176-1183`
- **What**:
  ```ts
  function pollDelayMs(elapsedMs: number): number {
    if (elapsedMs < 10_000) return 1000;
    if (elapsedMs < 60_000) return 2000;
    if (elapsedMs < 5 * 60_000) return 4000;
    return 8000;
  }
  ```
  ```ts
  probe: async (taskId: string) => {
    const parsed = await runPythonBridgePromise({ operation: 'status', taskId }, 'scripts/agent_bridge.py', { target: 'stage', timeoutMs: 8000 });
  ```
- **Why it hurts**: `runPythonBridgePromise` spawns a fresh `python.exe` for every probe — there is no
  resident worker, unlike the OCR/UIA lanes that were deliberately made resident. A 5-minute background
  image task therefore pays 10 + 25 + 60 = 95 interpreter cold starts, each with `-u` and a script
  import, competing for CPU with the streaming answer that the user is watching.
- **Fix**: Route task status through the resident bridge worker (`frames`/`uia` both have one), or push
  task status from the bridge on the existing progress channel instead of polling; if polling stays,
  start at 2-3 s and use a dedicated long-lived `agent_bridge` process.
- **Severity**: P1
- **Confidence**: certain

### F28 — The submit gating loop polls at 16.7 Hz per pending submit

- **Where**: `electron/main.ts:5637-5665`
- **What**:
  ```ts
  const SUBMIT_GROUNDING_POLL_MS = 60;
  ...
  setTimeout(
    () => submitSelectionCommandWhenGrounded(payload, startedAt, noticeShown || Boolean(gate.notice)),
    SUBMIT_GROUNDING_POLL_MS,
  );
  ```
- **Why it hurts**: a self-rescheduling `setTimeout` chain that re-runs `selectionSessions.get`,
  `decideSubmitGate` and `Date.now()` 16.7 times a second for as long as the capture is in flight —
  which, for a cold perception pass, is seconds. It is a poll where an event would do: the capture
  completing is already an event (`onComplete` in `beginSelectionSession`).
- **Fix**: Replace the poll with a single wait that the capture-completion path resolves (a promise
  keyed by session token), with a real deadline timer as the only fallback.
- **Severity**: P2
- **Confidence**: certain

### F29 — The model-health watch spawns a Python bridge process every 60 s while idle

- **Where**: `electron/main.ts:5358-5363`, `5339-5356`
- **What**:
  ```ts
  setTimeout(() => { refreshModelHealth({ probe: true }); }, 1500);
  modelHealthTimer = setInterval(() => { refreshModelHealth({ probe: false }); }, 60_000);
  ```
- **Why it hurts**: `refreshModelHealth` runs `runPythonBridgePromise(..., 'scripts/fabric_bridge.py', ...)`
  — a full interpreter start plus imports, per minute, for a verdict that only changes when a key runs
  out of credit. Over an 8-hour desktop session that is 480 interpreter launches, each also hitting
  `log()` and `runtimeSnapshot` invalidation paths.
- **Fix**: Make the health verdict push-based from the model client (the gateway already knows when it
  returns 401/402 — see `model_client`/`conversation_error`), keep the periodic timer only as a
  15-minute backstop, and start it only after the first conversation fails.
- **Severity**: P2
- **Confidence**: certain

### F30 — `sendCursorToOverlay` sends a 50 Hz IPC message and reads window bounds per tick

- **Where**: `electron/main.ts:3422-3444`, called from `3890`
- **What**:
  ```ts
  function sendCursorToOverlay(pos = screen.getCursorScreenPoint()) {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
    const display = screen.getDisplayNearestPoint(pos);
    ...
    const current = overlayWindow.getBounds();
    ...
    const bounds = overlayWindow.getBounds();
    overlayWindow.webContents.send('overlay:cursor', { x: pos.x - bounds.x, y: pos.y - bounds.y, globalX: pos.x, globalY: pos.y });
  ```
- **Why it hurts**: two `getBounds()` calls (native) plus a `getDisplayNearestPoint` plus an IPC send,
  50 times a second, whenever the overlay is visible. The renderer's handler (`overlay.ts:676-681`)
  calls `scheduleRender()` for each, and in observer mode that is the only reason the overlay repaints.
  Most of these messages carry a position identical to the previous one.
- **Fix**: Cache `bounds` (invalidated on the `setBounds` calls and on display change), and skip the
  send when `pos` is unchanged since the last tick (`pos.x === last.x && pos.y === last.y`).
- **Severity**: P2
- **Confidence**: certain

### F31 — `writeEvent` does a `statSync` plus an `appendFileSync` per event

- **Where**: `electron/observability.ts:53-97`
- **What**:
  ```ts
  function rotateIfNeeded(): void {
    if (!eventLogPath) return;
    let size = 0;
    try { size = fs.statSync(eventLogPath).size; } catch { return; }
    if (size < rotateBytes) return;
  ```
- **Why it hurts**: measured **0.49 ms per event** synchronously on the main thread, and the size
  check can be answered from an in-memory counter (the module already writes every line itself). The
  rotation check re-`statSync`s on every single write.
- **Fix**: Track the written byte count in a module variable and `statSync` only once per process start
  (or every N writes); batch the appends.
- **Severity**: P2
- **Confidence**: certain

### F32 — `python_bridge_runner` re-arms a timer and byte-counts on every chunk

- **Where**: `electron/python_bridge_runner.ts:151-175`
- **What**:
  ```ts
  const append = (stream, chunk) => {
    armIdleDeadline();                 // clearTimeout + setTimeout per chunk
    const text = String(chunk);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (stream === 'stdout') { stdoutBytes += bytes; ...; stdout += text; }
    else { stderrBytes += bytes; if (feedProgress) feedProgress(text); ...; stderr += text; }
  };
  ```
- **Why it hurts**: for a streaming answer this runs hundreds of times: a `Buffer.byteLength` pass over
  every chunk, a timer teardown/create pair (two syscalls' worth of event-loop churn each), and
  `stdout += text` growth that is O(n) per chunk on a string that can reach the 1 MB cap. The idle
  deadline only needs to be re-armed a few times a second, not per chunk.
- **Fix**: Only re-arm the deadline if more than ~250 ms have passed since the last arm; count bytes
  with `chunk.length`+ a rough fallback or accumulate `Buffer.byteLength` on a sampled basis; keep
  stdout in an array of chunks and `join` once at close.
- **Severity**: P2
- **Confidence**: certain

### F33 — `renderThread` scrolls the newest turn into view on every signature change

- **Where**: `electron/renderer/stage.ts:1764-1777`
- **What**:
  ```ts
  resultCard.replaceChildren(...nodes);
  const newest = nodes[nodes.length - 1];
  if (newest) newest.scrollIntoView({ block: 'end' });
  ```
- **Why it hurts**: `scrollIntoView` on a full-screen transparent document scrolls the whole document
  to satisfy the request and can force layout of ancestors; the thread signature changes on every
  status transition (`pending` → `done`/`failed`) of every turn, so this runs several times per
  session, each followed by `render()`'s own layout reads (F14). The same pattern appears in the
  studio (`studio.ts:1460`, `4127`).
- **Fix**: Set `container.scrollTop = container.scrollHeight` on the actual scroller instead of
  `scrollIntoView`, or drive from the existing `SCROLL_FOLLOW_THRESHOLD_PX` logic.
- **Severity**: P2
- **Confidence**: certain

### F34 — The stage's wait clock polls the DOM twice a second per pending turn

- **Where**: `electron/renderer/stage.ts:1741-1759`
- **What**:
  ```ts
  waitTimer = setInterval(paint, 500);
  ...
  const label = resultCard.querySelector<HTMLElement>('.thread-turn[data-status="pending"] [data-elapsed]');
  ```
- **Why it hurts**: a `querySelector` over the whole result card twice a second for as long as a turn
  is pending (and a pending turn can last minutes on an agent task). The same shape exists in
  `live_cards.ts:27-42` (a `document.querySelector` per tracked card per 500 ms with `CSS.escape`).
- **Fix**: Keep a direct reference to the elapsed node created by `buildTurn` and update its text;
  stop the timer when `label` is absent.
- **Severity**: P2
- **Confidence**: certain

### F35 — `panelGeometryForSession` re-places and re-measures the stage window on every payload

- **Where**: `electron/main.ts:2982-2992`
- **What**:
  ```ts
  const cursor = entry?.cursor || screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const stageBounds = placeStageOnDisplay(display).getBounds();
  ```
  with `placeStageOnDisplay` (`989-1003`) calling `win.getBounds()` and conditionally `setBounds`.
- **Why it hurts**: two native window calls (bounds read, and a `setBounds` whenever the desired rect
  differs by a pixel) plus a display lookup, executed for every `stageSessionPayload` /
  `stageTargetForSession` call — which includes the `onComplete` path where the capsule is waiting to
  be grounded, and `updateStage`'s guide-point path. `setBounds` on a full-screen transparent window
  forces a re-composite of the whole surface.
- **Fix**: Cache `panelGeometry` per session (it is derived from a frozen snapshot and never changes
  after `setPanelLayout`), and cache the stage bounds per display id, invalidating only on
  `display-*` events (the handlers already exist at `main.ts:4488-4490`).
- **Severity**: P2
- **Confidence**: certain

### F36 — `dismissTemporarySurfaces` logs twice and reshapes the window, from inside the pointer tick

- **Where**: `electron/main.ts:3031-3054`
- **What**:
  ```ts
  function dismissTemporarySurfaces({ invalidateSession = true, hideObserver = false } = {}) {
    const sessionToken = activeSelectionSessionToken;
    log(`dismissTemporarySurfaces overlayOwnsPointerInput=${overlayOwnsPointerInput} armPresent=${Boolean(selectionGestureArm)}`);
    cancelSelectionGesture('dismissed', { hideSurface: false });
    ...
    setStageMouseCapture(false);
    ...
    log('dismissTemporarySurfaces');
  ```
- **Why it hurts**: this is reachable directly from the 20 ms poll (`main.ts:3941-3944`, the
  global-pointer dismiss branch) — i.e. from the same tick that must keep the pointer clock honest.
  Inside it: two `log()` calls at a measured 0.98 ms each, a `setShape`/`setIgnoreMouseEvents` pair via
  `setStageMouseCapture(false)`, an IPC to the stage, and a `setPointerInputCommand` stdin write.
  ~2 ms of blocking work plus native window ops, on a tick whose budget is 20 ms.
- **Fix**: Drop the two trace logs (or make them `MAGIC_POINTER_POINTER_TRACE`-gated, as the
  neighbouring pointer trace already is), and make `setStageMouseCapture(false)` a no-op when the
  stage is already click-through.
- **Severity**: P2
- **Confidence**: certain

### F37 — `RendererReadiness.reset()` keeps its waiters, so callbacks accumulate across renderer reloads

- **Where**: `electron/renderer_readiness.ts:12-14`, used at `electron/main.ts:3663`, `1043`, `1150`
- **What**:
  ```ts
  reset(): void { this.isReady = false; }        // waiters are NOT cleared
  whenReady(callback: unknown): () => boolean | void { ... this.waiters.add(readyCallback); return () => this.waiters.delete(readyCallback); }
  ```
- **Why it hurts**: the returned unsubscribe closure is discarded at every call site
  (`stageReadiness.whenReady(send)`, `overlayReadiness.whenReady(revealGuide)`,
  `stageReadiness.whenReady(() => overlayReadiness.whenReady(show))`). A window that is destroyed or
  reloaded before reporting ready leaves its waiters in the Set; the next `markReady` runs all of
  them, including closures that captured a destroyed window or a stale gesture token (they bail on
  their own guards, but the Set only grows). `ensureFreshGestureOverlay` (F4) reloads the overlay on
  every gesture, which is exactly the cycle that grows it.
- **Fix**: Clear `waiters` in `reset()` (the callbacks are per-load by construction), and bound the Set.
- **Severity**: P2
- **Confidence**: certain

### F38 — `renderStash` rebuilds the entire canvas world as one `innerHTML` string, re-decoding every image

- **Where**: `electron/renderer/studio.ts:110-156`, forced at `1918`
- **What**:
  ```ts
  world.innerHTML = laid.map(b => {
    ...
    <span class="node-shot" style="width:${n.imageW}px;height:${n.imageH}px;${n.src ? `background-image:url('file:///${cssUrl(n.src)}');...` ...
  ```
  ```ts
  if (view === 'stash') { renderStash(true); bindCanvas(); }
  ```
- **Why it hurts**: `show('stash')` passes `force = true`, so every switch to the stash view re-parses
  the whole markup string for every node and re-issues a `file:///` background-image request per
  screenshot — the browser cache helps, but the CSS is re-parsed, the layout is rebuilt and all
  decoded images are re-attached. The guard `world.childElementCount && !force` is what allows the
  force path to bypass the cache, and `renderStashList` does the same with a second giant string.
- **Fix**: Only force when the underlying data changed (compare a cheap revision/hash of the stash
  index), and build nodes with `createElement` + a DocumentFragment instead of `innerHTML` strings.
- **Severity**: P2
- **Confidence**: certain

### F39 — `showPickHighlight` forces a synchronous reflow to restart an animation

- **Where**: `electron/renderer/stage.ts:483-487`, `studio.ts:4861`
- **What**:
  ```ts
  frozenGlow.hidden = false;
  frozenGlow.classList.remove('is-picked');
  void frozenGlow.offsetWidth;      // restart the animation
  frozenGlow.classList.add('is-picked');
  ```
- **Why it hurts**: `offsetWidth` after a class removal is a forced synchronous layout, executed on
  the pick path — which already waits on a Python UIA probe (`stage:pick-element`, up to 3 s,
  `main.ts:5903-5923`). The studio does the same in `startNewChat` (`studio.ts:4861`).
- **Fix**: Use `element.getAnimations().forEach(a => { a.cancel(); a.play(); })`, or toggle the class
  across a `requestAnimationFrame` instead of a forced reflow.
- **Severity**: P2
- **Confidence**: certain

### F40 — Preload serialises the task input twice before every submit/steer

- **Where**: `electron/preload.ts:26-36`, used at `316`, `343`
- **What**:
  ```ts
  function boundedTaskInput(value: unknown): UnknownRecord | null {
    const encoded = JSON.stringify(value);
    if (encoded.length > 48 * 1024) return null;
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  }
  ```
- **Why it hurts**: the size check is implemented as a full stringify + parse round trip of a payload
  that can be 48 KB (task input with timeline + references), on the submit path in the renderer,
  immediately before the structured clone that IPC performs anyway. Two extra serialisations of the
  same object per submit and per steer.
- **Fix**: Bound the parts (the callers already slice `timeline`, `sourceIds`, `referenceUpdates`),
  or count with a cheap depth/length walk instead of a JSON round trip.
- **Severity**: P2
- **Confidence**: certain

### F41 — `episodeObjectForSession` spreads arrays through `Math.min/max` for every stroke region

- **Where**: `electron/main.ts:4146-4157`
- **What**:
  ```ts
  const xs = points.map((point: any) => Number(point?.x)).filter(Number.isFinite);
  const ys = points.map((point: any) => Number(point?.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return [];
  const left = Math.min(...xs); const top = Math.min(...ys);
  return [{ strokeIndex, bbox: [left, top, Math.max(...xs) - left, Math.max(...ys) - top] }];
  ```
- **Why it hurts**: four array allocations plus four spread-applies of up to the full point count per
  stroke (12 strokes) = up to 12 × 4 argument-spread calls over thousands of elements. `episodeObjectForSession`
  is called from `stageSessionPayload`, `recordConversationTurn`, `beginStageLiveTurn` and
  `autoStashResultImage` — several times per turn — and each call re-derives the same bboxes from the
  immutable frozen snapshot.
- **Fix**: Compute bboxes in a single `for` loop (no spreads, no intermediates) and memoise the result
  on the session entry.
- **Severity**: P2
- **Confidence**: certain

### F42 — The keyboard/Enter submit shortcut is a global hotkey that swallows Enter system-wide

- **Where**: `electron/main.ts:3076-3095`
- **What**:
  ```ts
  temporaryGestureSubmitShortcutRegistered = globalShortcut.register('Enter', () => {
    const arm = selectionGestureArm;
    if (!arm || arm.token !== String(token || '')) return;
    safeSurfaceSend('overlay', 'overlay:gesture-submit', { token: arm.token });
  });
  ```
- **Why it hurts**: correctness rather than CPU. `globalShortcut.register('Enter')` is a machine-wide
  grab — while a gesture is armed, every Enter keystroke anywhere is intercepted by the OS and routed
  to this callback, and the callback does nothing unless the token matches. The unregister only
  happens in `cancelSelectionGesture`/`disarmTemporaryGestureSubmitShortcut`, so any path that arms
  without reaching one of those leaves the user's Enter key dead until the app quits.
- **Fix**: Register the accelerator only while an overlay actually owns the keyboard, and prefer a
  renderer-side `keydown` handler on the focused overlay window; if a global grab is genuinely
  required, add a watchdog that unregisters after `arm.timeoutMs`.
- **Severity**: P2 (latent correctness)
- **Confidence**: likely

### F43 — `refreshTrayMenu` rebuilds a full menu template on every update status change

- **Where**: `electron/main.ts:755-809`, `835-840`
- **What**:
  ```ts
  onStatus: (state) => { refreshTrayMenu(); if (dashboardWindow && !dashboardWindow.isDestroyed()) { ... } },
  ```
- **Why it hurts**: `Menu.buildFromTemplate` with ~10 items plus several `updateManager.status()` calls
  runs on every updater state transition (checking → downloading → progress ticks). During a download
  the progress ticks push a new state continuously, so the tray menu is rebuilt and the entire
  template re-created per tick.
- **Fix**: Only rebuild when the *label-relevant* fields change (state + rounded percent), and cache
  the `updateManager.status()` result in one call instead of five.
- **Severity**: P2
- **Confidence**: certain

---

## Ranked fix order (impact ÷ effort)

| # | Fix | Finding | Why first |
| --- | --- | --- | --- |
| 1 | `log()` → buffered/async append; drop the per-call `mkdirSync` | F5 | 0.98 ms × ~150 sites × every bridge progress record, one-line change, removes measurable main-thread blocking everywhere at once |
| 2 | In `updateStage`, send `stage:update` before `recordConversationTurn` + `autoStashResultImage`; make `autoStashResultImage` async | F1 | Directly moves the answer card earlier on the path the product is judged by; ~6 lines of reordering |
| 3 | Make `updateTurn` persistence incremental / move it off the 300 ms flush | F3 | Removes an 18-85 ms synchronous whole-store rewrite 3.3×/s; the single largest main-thread block |
| 4 | Coalesce `Data.onChange` into one trailing timer and pass the changed id | F2 | Deletes 2-4 full-store IPC round trips + 3 list rebuilds per notification |
| 5 | Stop destroying the overlay per gesture (`ensureFreshGestureOverlay`) | F4 | Removes a whole renderer cold start from every wake |
| 6 | Early-return in `syncHitRegions` before building any regions; memoise per frame | F8 | Removes ~21 forced layout reads per pointer sample |
| 7 | Give `setStageMouseCapture` an idempotence guard and drop the settle timer | F9 | Removes a native `SetWindowRgn` per cursor crossing |
| 8 | Cache geometry in `panelGeometryForSession` + cache stage bounds per display | F35, F7 | Two-line caches that remove native window calls from per-tick paths |
| 9 | Renderer-side cap + single pass in `completeSelectionGesture` (`toPhysical`) | F10, F19 | Removes up to 4096 native lookups from `pointerup` |
| 10 | Delete the `mousemove` listener in `stage.ts` (or make `syncHitRegions` rAF-coalesced) | F12 | Halves the renderer's region-sweep rate for one deleted listener |

Runners-up worth doing in the same pass, all small diffs: F15 (composited sweep animation +
`will-change`), F21 (append instead of `replaceChildren`, one rAF per chunk), F23 (`fitComposer`),
F16 (delegated card actions — also fixes duplicate execution), F39 (`getAnimations()` instead of
`offsetWidth`).

## Notes / non-findings (measured, so they are ruled out rather than assumed)

- **Wiggle detection is not a hotspot.** `WiggleDetector.push` measured 6.8 µs per call with a
  window-bounded 17-point history (0.34 ms/s at 50 Hz). The `[...this.points, point]` spread in
  `_blocked` and the `filter` on the window trim are micro-costs at that size. Do not "optimise" it.
- **`pointInRegions` / `JSON.stringify(regions)` are not the cost in `syncHitRegions`** — 0.297 µs and
  5.975 µs respectively. The cost is the forced layout from the rect reads and the native reshape the
  IPC triggers. Optimising the JS bookkeeping would be measuring the wrong thing.
- **The pointer stream is healthy.** 56.6 Hz, p50 gap 16.7 ms, p99 33.7 ms — the committed baseline
  (`docs/perf/2026-09-16-baseline.md`) is stale and should be corrected or deleted; it is currently
  the stated justification for the "50 ms budget cannot be met" claim, which measurement no longer
  supports. The remaining clock problem is the opposite one (F6).
- `studio.ts:4796-4804` registers a `setInterval(..., 2600)` for `#demo-run`, which does not exist in
  `studio.html` — dead code today, but if that markup ever returns it will run unstopped. Left
  unreported as a finding because it costs nothing now.
