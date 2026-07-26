# Demo-Grade Interaction Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three Terra-high No-ship blockers and rebuild the ephemeral UI into a single PointerStage surface at Google-demo experience level.

**Architecture:** Backend (fabric/recipes/whisper/OCR/agents) unchanged. Honest receipt semantics (`accepted` = queued/unverified, `succeeded` = verified) enforced end-to-end; screenshot privacy converges on a single choke point that also governs context-pack prompt compilation; all ephemeral visuals move into one transparent click-through PointerStage window, after which legacy result/reader surfaces are retired.

**Tech Stack:** Electron (vanilla JS renderers), Python 3 backend bridges, GSAP for stage motion, pytest + node test scripts.

**Reference:** design doc `docs/superpowers/specs/2026-07-26-demo-grade-interaction-layer-design.md`; blocker investigation summarized below per task.

---

### Task 1 (M0+M1-queue): Honest receipt semantics + green pytest baseline

Design ruling (do not deviate): status strings must reflect truth. A **verified local synchronous action → `succeeded`**; a **queued/running agent task → `accepted`** (never `succeeded`, never `ok:false`-as-failure). Update whichever side (test or engine) currently lies.

**Files:**
- Modify: `scripts/fabric_bridge.py:104` — direct execute path maps `receipt.status`: `succeeded`→`ok:true,state:"completed"`; `accepted`→`ok:true,state:"accepted"` with provider/taskId and explicit "尚未完成" message (mirror `scripts/action_bridge.py:65-99` semantics); anything else→`ok:false`.
- Modify: `scripts/fabric_bridge.py` `providers` operation — find why it blocks >15s (live CLI probe); add per-provider timeout (≤2s) or cached/offline probe so the op returns promptly.
- Modify: `tests/fabric_engine_test.py` — `test_local_ocr_clean_requires_confirmation_then_verifies_clipboard`: expect `succeeded`/`verified True` after confirmation for the locally-verified clipboard action (rename test if its name no longer matches). `test_raw_screen_visual_prompt_routes_image_to_available_agent`: expect `accepted` (queued agent task) and KEEP the downstream privacy assertions (`attachments == []`, `screenshotUploadAllowed: False`, `withheldVisualAttachmentCount: 1`) — they must now execute and pass.
- Verify: `tests/fabric_bridge_test.py::test_bridge_lists_catalog_and_real_provider_state` passes without timeout.

**Steps:**
- [ ] Run `python -m pytest tests/fabric_engine_test.py tests/fabric_bridge_test.py -q` to reproduce the 3 failures
- [ ] Fix `fabric_bridge.py` accepted-mapping; add regression test asserting queued agent receipt → `ok:true,state:"accepted"` and message contains "尚未完成"
- [ ] Fix provider probe timeout (systematic-debugging: find the blocking call first)
- [ ] Align the two engine tests with honest semantics
- [ ] Run full `python -m pytest -q` → 0 failures; `npm test` → green
- [ ] Commit only the files above: `fix: honest accepted/succeeded receipt semantics across bridges`

### Task 2 (M1-privacy): Context-pack privacy choke point

Gap (confirmed): `app/context_pack/compiler.py:99-104` takes no privacy setting and at `:208-213` unconditionally embeds raw/pointer screenshot file paths into the prompt delivered to agents; `app/context_pack/session.py:344-387` stores them; `scripts/selection_bridge.py:306` and `scripts/electron_bridge.py:69` deliver without any privacy check. The fabric path already honors `privacy.upload_screenshots` (`app/fabric/executors.py:507-551`) — reuse its semantics.

**Files:**
- Modify: `app/context_pack/compiler.py` — `compile_context_prompt(..., allow_screenshot_upload: bool = False)`; when `False`, omit both screenshot-path lines and append the same explicit privacy-boundary notice used in `app/fabric/executors.py:527-531`, downgrading visual context to OCR text already present in the pack.
- Modify: `scripts/selection_bridge.py`, `scripts/electron_bridge.py` — read `privacy.upload_screenshots` via `app/fabric/settings.py` loader and pass it through every `compile_context_prompt` call site.
- Test: `tests/context_pack_compiler_test.py` — new tests: (a) switch off → compiled prompt contains no `.png`/screenshot path substrings and contains the privacy notice; (b) switch on → paths present. Add a bridge-level test in `tests/context_pack_selection_bridge_test.py` asserting the delivered prompt honors the setting.

**Steps:**
- [ ] Write failing tests (a)+(b); run to confirm (a) fails
- [ ] Implement compiler param + bridge wiring
- [ ] Full `python -m pytest -q` green
- [ ] Commit: `fix: screenshot privacy switch constrains context-pack prompt delivery`

### Task 3 (M2): PointerStage core renderer

**Files:**
- Create: `electron/renderer/stage.html`, `electron/renderer/stage.js`, `electron/renderer/stage.css`
- Create: `electron/stage_state.js` (pure state machine, node-testable: states `hidden → targeting → frozen → capsule-voice|capsule-text → processing → result|error → dismissing`; transitions carry payloads)
- Modify: `electron/main.js` — `createStageWindow()` full-display transparent click-through alwaysOnTop window (pattern of `createOverlayWindow` `main.js:291-325`); new IPC `stage:show|update|hide` guarded by `ipc_surface_policy.isSurfaceSender`; wire wiggle-wake session to stage alongside (not yet replacing) panel
- Modify: `electron/preload.js` — `magicPointerStage` bridge
- Test: `tests/stage_state_test.js` (state machine transitions incl. reduced-motion flag), `tests/stage_static_test.js` (DOM contract: capsule, waveform bars, letter-fly container, shimmer, no legacy pill/lasso elements), register both in `package.json` test script

**Visual contract (from design §2):** graphite `#0E1116`, single electric-blue accent, targeting outline 1.5px/120ms fade, frozen glow 2px breathing 2.4s, capsule 72px voice / 176px text growing ≤560px, letters fly in ~30ms stagger via GSAP (vendored local file, no CDN), shimmer processing, zero DOM when hidden. Honor `prefers-reduced-motion`.

- [ ] Write stage_state tests → fail → implement → pass
- [ ] Build renderer + static test; wire main.js window + IPC
- [ ] `npm test` green; manual smoke via `npm start`
- [ ] Commit: `feat: PointerStage single-surface renderer core`

### Task 4 (M3): Chips + result cards + write-back progress

- Create: `electron/stage_chips_policy.js` — chips only when (click-selected object) ∧ (capsule empty) ∧ (input mode not voice); ≤3 derived from object type (image→对比/整理; text→改写/翻译/摘要; date→加入日历); hide on first keystroke/speech.
- Extend `stage.js`: three result card types (calendar draft / table compare / text draft with diff) expanding from capsule anchor; delivery progress state shows true UIA draft-write progress (no fake foreign-app animation — design §2.2).
- Test: `tests/stage_chips_policy_test.js`, extend `tests/stage_static_test.js`.
- [ ] TDD as above; commit `feat: contextual chips and structured result cards on PointerStage`

### Task 5 (M4): Legacy retirement + honest Activity timeline

- Modify: `electron/main.js` — route all results to stage; delete `createResultWindow`/`createReaderWindow` paths (`main.js:355-424,633-654`), `RESULT_SURFACE_MODE` env toggle (`main.js:49`); remove legacy lasso/pill/in-overlay result from `electron/renderer/overlay.js` + `index.html` (keep observer aura + runtime-issue circle capture).
- Delete: `electron/renderer/result.html|js|css`, `reader.html|js|css`; update `electron/result_surface_policy.js` `classifyResult` to stage modes (`inline|card|error`); rewrite `tests/result_surface_policy_test.js`, `tests/reader_static_test.js` (delete), `tests/overlay_static_test.js`, `tests/panel_static_test.js` accordingly.
- Modify: `electron/renderer/dashboard.js` — Activity view becomes timeline (intent → plan → true state incl. `accepted`/queued position → verify result), reading fabric task_store statuses verbatim.
- [ ] TDD; full `npm test` + pytest green; commit `feat: retire legacy result surfaces; honest activity timeline`

### Task 6: Evidence + regression gate

- [ ] `python -m pytest -q` 0 failed; `npm test` green
- [ ] Screenshot each stage state (wake/targeting/frozen/voice/grow/processing/card/dismiss) into `docs/evidence/2026-07-26-stage/`
- [ ] Real-machine smoke: wiggle → voice → draft write-back
- [ ] Update `IMPLEMENTATION_STATUS_20260726.md` honestly; push branch, update PR #1

---

**Parallelization:** Tasks 1, 2, 3 touch disjoint files → run concurrently (each commits only its own listed files). Task 4 depends on 3; Task 5 depends on 3+4 and merges after 1+2 land; Task 6 last.
