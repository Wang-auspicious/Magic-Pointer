# Changelog

## v0.0.1 - MVP0

- Added Windows desktop prototype using Tkinter.
- Added `Ctrl + Alt + M` global hotkey polling.
- Added region selection overlay and screenshot capture.
- Added OpenAI multimodal model integration with no-key fallback.
- Added local object logging in JSONL.
- Added README, AGI distance tracking, smoke test, MIT license.

## Unreleased

- Fixed multi-DPI physical coordinate mapping in `completeSelectionGesture` (`electron/main.js`): per-point display lookup with `X_phys = Screen_Physical_Origin + (Local_Logical × sf)` instead of a single global scale factor; bbox recomputed from physical point set.
- Fixed model unload segfault race (`scripts/local_voice_worker.py`): added `_ModelRWLock` reader-writer lock so `unload()` waits for in-flight transcription to finish before dropping the model reference.
- Replaced 80ms microphone polling with event-driven push (`scripts/local_voice_worker.py` + `electron/voice_worker_client.js`): worker pushes `partial`/`final`/`error` events straight to stdout via an async event sink; deleted `poll_microphone` command, `_pollActiveMicrophone`, and `pollIntervalMs` timer.
- Optimized overlay rendering (`electron/renderer/overlay.js`): pointer and observer aura pre-rendered into OffscreenCanvas frame caches (6 frames each), main loop only calls `drawImage()`; removed blind `setTimeout(1050)` restore — recovery is driven by the main-process capture completion path.
- Made VAD noise-floor tracking noise-immune (`scripts/local_voice_bridge.py`): asymmetric envelope follower (fast release 0.99 / slow attack 0.001) replaces the symmetric 0.92/0.08 EMA so transient noise (keystrokes, door slams) can no longer poison the threshold.
- Fixed the P0 microphone capture failure path (`scripts/local_voice_bridge.py`): temporary audio-queue starvation no longer leaks `queue.Empty`, and partial Whisper inference now runs as a single background job so it cannot block the sampling pump or overlap final inference on the same model.
- Completed the event-driven microphone lifecycle contract (`scripts/local_voice_worker.py`): `microphone_stopped` is now pushed to Electron after the session returns to idle, preventing the client from retaining a stale active request.
- Added a 64 KiB UTF-8 input ceiling to the reviewed selection and Electron bridges, with bounded prefix reads and explicit `payload_too_large` fail-closed responses instead of unbounded stdin buffering.

- - Fixed P0#5 overlay recovery (`electron/main.js`): the non-gesture `overlay:done` branch now hides the overlay immediately at capture handoff (event-driven), instead of waiting for the bridge `onComplete` — the overlay can no longer sit black and input-blocking for the whole bridge run (up to 120s on timeout).
- - Fixed P0#6 unbounded capture coordinates (`electron/main.js`): non-gesture `overlay:done` points are truncated to `MAX_OVERLAY_CAPTURE_POINTS = 4096` before forwarding, so a compromised renderer cannot push an unbounded coordinate array to the bridge.
- - Fixed P0#4 production test-hook isolation (`electron/main.js`): the N17 focus-evidence, N18 wiggle-evidence, and dashboard-capture env hooks (and `captureMode`) are now gated behind `!app.isPackaged`, so leftover `MAGIC_POINTER_*` variables can no longer make a packaged app auto-quit at startup; packaged runs log that the hooks are ignored.
- - Closed the voice push-mode test contract (`tests/local_voice_worker_test.py`): the removed `MAX_MICROPHONE_EVENTS` constant is no longer imported; the push-mode regression test emits 65 partials (past the old 64-event poll buffer cap) and asserts no forced stop and no dropped events. Added a deterministic regression test proving `start_microphone` cannot overlap an in-flight WAV transcription on the same model.
- - Made the PDF fixture-dependent test robust (`tests/pdf_selection_recovery_test.py`): `test_live_recovery_rejects_an_occluded_background_pdf` now skips when the local `2307.00583v1.pdf` fixture is absent, matching its sibling tests, so the suite is green without the fixture.
- - Added `tests/test_hooks_isolation_static_test.js` and P0#5/#6 regression assertions in `tests/runtime_issue_hotkeys_test.js` locking in the event-driven overlay recovery and the capture-points cap.- Added `docs/planning/REVIEW_AUDIT_20260731.md`: P8 code review, 44 findings (P0×7 / P1×12 / P2×12 / P3×8 / P4×5) with prioritized fix order.
- Cloned `external/opensre` (Tracer-Cloud, Apache 2.0, depth 1) and documented the borrowable patterns (synthetic scored RCA suites, reversible masking, context budgeting) in AGENT.md.
- Added `electron/observability.js`: structured JSONL event log
  (`events.jsonl` under the runtime directory, rotated at 5 MB × 5 files),
  in-process counters via `bump()`/`snapshotCounters()`, and lazy
  `crashReporter.start()` with `uploadToServer: false`. Wired into
  `electron/main.js` so every run records `session.start` and fatal
  hardening events.
- Added `scripts/collect-diagnostics.js` and the `npm run diag:collect`
  script: bundles the runtime directory into a zip (falls back to a
  timestamped directory if `archiver` is not installed) with secret
  redaction (`sk-*`, `api_key=`, `token=`, `password=`) applied to text
  logs and JSONL events, plus a `meta.json` header. Hostname is hashed.
- Added `tests/observability_test.js` covering event write / counter
  accumulation / secret redaction — surfaced by
  `scripts/run-node-tests.js`.
- Added `electron/security_hardening.js` and wired it into `electron/main.js`:
  enables Electron sandbox, rejects `window.open` and `will-navigate` targets
  outside `http/https/mailto/tel`, blocks webview attachment, denies
  non-media permission prompts, and installs `uncaughtException` /
  `unhandledRejection` handlers that log, notify the user via
  `dialog.showErrorBox`, and `app.relaunch()`.
- Hardened all `BrowserWindow` `webPreferences` with `sandbox: true` and
  `webSecurity: true` for overlay, stage, dashboard and onboarding surfaces.
- Added strict `Content-Security-Policy` meta tags to `dashboard.html` and
  `onboarding.html`, matching the existing policy in `index.html` /
  `panel.html` / `stage.html`.
- Added GitHub Actions workflows for macOS release (`release-macos.yml`),
  CodeQL security scanning (JS + Python), dependency audits (`npm audit`,
  `pip-audit`) and CycloneDX SBOM generation attached to tagged releases.
- Added `.github/dependabot.yml` covering npm, pip and GitHub Actions with
  weekly grouped updates.
- Enabled Windows differential updates (`nsis.differentialPackage: true`)
  and cross-arch builds (`x64` + `arm64`) for both Windows and macOS in
  `electron-builder.yml`.
- Added macOS packaging metadata: hardened runtime entitlements
  (`build/entitlements.mac.plist`), usage descriptions for microphone,
  Apple Events, accessibility and screen capture, DMG + ZIP targets.
- Extended `installer.nsh` with a `customUnInit` prompt that asks whether to
  purge `%LOCALAPPDATA%\Magic Pointer` on uninstall (defaults to keep).
- Added project meta and quality gates: `.editorconfig`, `.nvmrc`, `.python-version`,
  `.prettierrc.json`, `.prettierignore`, `eslint.config.mjs`, `pyproject.toml`
  (ruff + pytest + coverage), and `.pre-commit-config.yaml`.
- Added community docs: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- Added `engines` (Node 20-24, npm 10+), `bugs`, `homepage`, and dependency
  `overrides` to `package.json`; added `lint`/`lint:fix`/`format`/`format:check`
  scripts.
- Added V2 native selected-text support for Chromium/Firefox-style applications
  and PDF readers through Windows UI Automation:
  - reads `TextPattern.GetSelection()` without sending keys or touching the
    clipboard;
  - validates the selected element against the frozen foreground HWND and PID;
  - records source element identity, text hash, range count, and selection
    rectangles;
  - labels browser, PDF, and other application selections separately and keeps
    the capability read-only.
- Added a small C# UI Automation probe that is compiled locally into ignored
  runtime data using the Windows compiler already present on the machine.
- Bound snapshot capture to the exact Windows foreground handle instead of the
  first Z-order window, and fail closed when that handle is Magic Pointer or
  cannot be matched.
- Narrowed self-window filtering to the exact `Magic Pointer Overlay` and
  `Magic Pointer Panel` titles so legitimate documents containing the product
  name are not ignored.
- New pointer sessions now clear old command text before binding a new `THIS`.
- Verified real Edge HTML and Edge PDF selections with unchanged clipboard
  sequence numbers. Warm PDF hotkey capture completed in about 805 ms and the
  panel appeared in about 827 ms; a cold Electron run took about 1.1 seconds.
- Added observer selection sessions aligned with the public Google Magic Pointer
  interaction principles:
  - the hotkey freezes the foremost native selection before the panel takes
    focus;
  - the compact panel identifies `THIS`, its source, excerpt, and contextual
    actions without opening as a chat transcript;
  - commands, model requests, and action proposals carry short-lived session
    provenance, and stale results are ignored;
  - Word write proposals retain document, window, range, and content-hash
    verification.
- Added a fast read-only Word/WPS selection probe using `cscript`, with the
  existing PowerShell COM path retained as fallback. Real Word snapshot time is
  now 356-428 ms and full hotkey-to-panel time is about 560-770 ms on the
  reference machine.
- Fixed the panel run button so a mouse click submits the command text instead
  of serializing the browser click event.
- Added selection-session, frozen-snapshot, fast-probe/fallback, stale-request,
  and panel interaction regression coverage.
- Added `GOOGLE_MAGIC_POINTER_ALIGNMENT.md` to keep public evidence, local demo
  observations, deliberate product differences, and V2 acceptance criteria in
  one tracked decision record.
- Reworked the in-progress observer-first flow after real desktop review:
  - kept the native mouse fully usable and replaced the duplicate custom cursor with a transient observer aura;
  - reduced the selection command panel to a compact, content-sized local tool;
  - fixed corrupted Chinese panel/bridge/model strings and restored safe Markdown rendering;
  - stopped the selection bridge from scanning past an unsupported foreground app into a background Office window;
  - added WPS Writer selection support through `KWPS.Application`, including collapsed-selection rejection;
  - added post-write verification and context-anchored delayed restore for Word-compatible documents;
  - made ambiguous restore attempts fail closed instead of replacing the first full-document text match;
  - redacted full before/after restore text after a successful undo;
  - hardened the HTTP client against malformed proxy environment variables;
  - added focused pytest coverage and a real-size Electron panel preview helper.
- Added v0.2.0-alpha pointer-first local grounding/action scaffold:
  - platform-neutral grounding and action schemas;
  - Explorer file grounding adapter with optional COM/UIA backends and safe fallback;
  - `MagicPointerOperator` observation/proposal pipeline;
  - typed clipboard-copy action bridge with confirmation and main-process proposal provenance tokens;
  - safe Markdown result rendering and action chips in the Electron overlay.
- Added regression tests for grounding schemas, Explorer dependency fallback, and action bridge rejection paths.
- Improved Explorer copy-path flow: added PowerShell COM/UIA fallback when Python UIA packages are missing, and suppresses misleading manual-shortcut answers when safe path grounding fails.
- Added local file content understanding scaffold: Explorer-grounded PDF/HTML/TXT/MD/DOCX/ZIP files can be read locally and injected into model context for summarize/explain/key-point prompts.
- Added UFO-inspired Windows app adapter harness with Office Word/Excel native selection context via COM/PowerShell and a hard local permission policy for future write-back actions.

- Added local `secrets/*.txt` config fallback for API key/base URL/model.
- Switched AI call path to direct OpenAI-compatible HTTP chat completions for 78code compatibility.
- Verified 78code `gpt-5.4-mini` text and vision calls.

- Added background mode, no-console VBS launcher, and mouse-shake trigger.
- Improved prompt/result dialog: visible primary send button, non-selectable hint label, Ctrl+Enter send, larger resizable window.
- Redesigned prompt window into a cleaner card layout; removed explanatory gray hint text; simplified actions.
- Relaxed mouse-shake trigger thresholds so small left-right wiggles summon selection more reliably.
- Changed prompt dialog to left screenshot / right prompt+reply layout; Enter sends and Shift+Enter inserts newline.
- Added Windows visible-window metadata to reduce VLM-only mistakes when counting partially hidden windows.
- Added best-effort Windows Mica/Acrylic backdrop for a more modern glass-like window.

- Added general Screen Context foundation: z-ordered window metadata, overlap/visibility ratios, annotated object map image, and object-log persistence.
- Right-click now cancels region selection.
- Mouse-shake trigger is more responsive with lower thresholds and shorter cooldown.
- Reworked mouse-shake trigger into a fixed three-reversal left-right gesture to reduce accidental triggers while keeping low latency.
- Added gesture smoke test.

- Started MVP1 object registry: recent objects, this/that/group reference context, history image attachment for comparison/merge prompts, and continue-select flow.
- Added object store test.

- Optimized outbound vision images as bounded JPEG data URLs to reduce gateway failures.
- Added retry and primary-image fallback for transient SSL/connection errors from OpenAI-compatible gateways.
- Limited extra reference images per request to keep multimodal payload stable.

- Fixed this/that reversal risk by labeling every multimodal image: IMAGE A=THIS current object, IMAGE B=THAT previous object.
- Comparison prompts now attach only the immediate previous object by default to avoid historical image confusion.
- Added coreference guard instructing the model never to swap ??/?? with ???/??.

- Added MVP1-beta explicit object panel: recent object thumbnails, THIS/THAT/GROUP badges, pin/unpin, clear group, and pin-current-after-send.
- Added persistent explicit group state in `data/objects/object_state.json`.
- Changed group/merge prompts to use the explicit pinned group instead of implicit recent history; compare-with-previous still uses THAT.
- Expanded object store tests for explicit group management.

- Revised MVP1-beta direction: removed default historical thumbnail panel and persistent manual pin group from active model context.
- Added hidden current-task context with `TaskContextStore`, 30-minute idle rollover, explicit new task, and previous-task restore.
- Changed `THIS/THAT/GROUP` semantics to be session-scoped: global object history is now diagnostic/log-only by default.
- Added `tests/task_context_test.py`.

- Enlarged and made the home/control window resizable to avoid clipped UI on Windows scaling.
- Added `MagicPointerPanel.vbs` for no-terminal visible panel startup; it stops an existing Magic Pointer process first, then launches the panel with `pythonw`.
- Added a `?????` button so users can keep hotkey/mouse listening without using the terminal.

- Fixed VBS launcher again: `pythonw` was not on PATH when launched by Windows Script Host, so the launcher now uses the user's Scoop Python path first.
- Added `data/runtime/launcher.log` for VBS launch attempts.
- Added `data/runtime/app_error.log` for silent `pythonw` startup failures.

- Fixed the home/control panel source text by using Unicode escape literals, preventing PowerShell/VBS editing from corrupting Chinese UI strings into `????`.
- Increased the home/control panel to `760x460` with minimum `700x420` to avoid clipped buttons and text.

- Added MVP1-gamma task-scoped `DESTINATION`: users can set/clear the current selection as the destination inside the current task.
- Added destination state to `TaskContextStore` and model context; commands like "there", "target", "????", "????" now resolve to the explicit current-task destination.
- Destination reference images are attached only when destination-like prompts are detected.
- Expanded task context tests for destination and task object registration.

- Added MVP1-delta interaction redesign: region selection now opens a compact pointer command bar instead of a large chat-style prompt window.
- Added quick actions: explain, compare, set destination, clear destination, execute, details, continue selection.
- Results now appear as a short action-card style result; the old large view is replaced by an on-demand details window.
- The command bar is positioned near the selected region and keeps task context hidden by default.

- Added MVP1-epsilon low-friction command capture: a `??` button focuses the command field and opens Windows dictation with Win+H, without adding microphone dependencies.
- Added context-aware suggested default prompts in the command bar: explain first object, compare when THAT exists, or prepare content for DESTINATION when available.
- Added a `???` quick action that uses current-task DESTINATION semantics.

