# Evidence Truth Foundation Implementation Plan

> Execute inline. The user explicitly prohibited subagents. This is an internal backend milestone, not a separately versioned or installed release.

**Goal:** Make the frozen surface, target identity, structured reads, and pixel evidence agree or fail closed; repair confirmed capture/startup/CSP defects; prove the result on the current 200% DPI Windows desktop.

**Architecture:** One `EvidenceBinding` boundary sits between FrameLease validation and perception. Coordinates become physical before capture. Electron lifecycle and renderer fixes remain narrow. No later runtime is allowed to consume evidence until this milestone passes.

**Verification:** Every production edit starts with an observed failing test. Focused tests are followed by the complete Python/Node/typecheck suite and controlled real-desktop evidence. Do not change `package.json` or run `npm run sync` during this milestone.

## Task 1: Frozen evidence binding contract

**Files:**

- `app/grounding/evidence_binding.py`
- `tests/evidence_binding_test.py`

- [x] Add failing tests for matching identity, HWND/PID/process mismatches, artifact/surface size mismatch, and gesture containment.
- [x] Observe the missing-module failure.
- [x] Implement the immutable binding and structured rejection codes.
- [x] Run the focused tests green.
- [x] Commit the isolated contract as `f9c0135`.

## Task 2: Enforce binding before perception

**Files:**

- `scripts/selection_snapshot_bridge.py`
- `tests/frame_lease_selection_bridge_test.py`

- [x] Add a test whose lease and enumerated source window disagree.
- [x] Observe that the existing bridge incorrectly continues.
- [x] Resolve the source window, invoke `bind_frozen_evidence` once, and return `invalid_frame_lease:<reason>` before UIA/OCR/model/capture on rejection.
- [x] Attach verified binding fields to the capture attestation.
- [x] Run the binding and bridge suites green (`16 passed`).

## Task 3: Repair the real-machine scenario harness

**Files:**

- `scripts/real_scenario_test.py`
- `tests/real_scenario_harness_test.py`

- [x] Test foreground acquisition and virtual-screen physical bounds first.
- [x] Enable DPI awareness before reading coordinates.
- [x] Require the requested HWND to become foreground or abort the scenario.
- [x] Preserve real PID/process identity, `GetDpiForWindow` scale, virtual-screen origin and dimensions.
- [x] Use safe Unicode input; do not modify the clipboard.
- [x] Run focused tests and syntax checks (`22 passed` across evidence/bridge/harness; `py_compile` passed).

## Task 4: Initialize production capture in physical coordinates

**Files:**

- `scripts/frame_capture_worker.py`
- `tests/frame_capture_worker_test.py`

- [x] Add a failing initialization-order test.
- [x] Enable DPI awareness before constructing or using the capture backend.
- [x] Run capture worker/provider tests (`19 passed`).

## Task 5: Stop losing Electron instances from booting services

**Files:**

- `electron/main.ts`
- `tests/single_instance_startup_test.js`

- [x] Add a failing contract proving readiness is conditional on lock ownership.
- [x] Gate `app.whenReady()` so a losing instance only quits and never starts UIA, capture, hotkeys, or windows.
- [x] Run focused lifecycle tests (4 scripts passed under the TS runtime).

## Task 6: Remove the CSP-blocked iframe style

**Files:**

- `electron/renderer/card_render.ts`
- `tests/card_render_test.js`

- [x] Change the test first to require an iframe `height` attribute and forbid inline style.
- [x] Observe the failure.
- [x] Replace the inline height style while retaining the existing clamp.
- [x] Run card rendering tests and typecheck (both passed).

## Task 7: Controlled real-desktop evidence

- [ ] Run a Notepad cross-reference scenario with foreground verification and Unicode input.
- [ ] Inspect the frozen frame and confirm its pixels show Notepad.
- [ ] Confirm lease HWND/PID/process identity equals the structured source window.
- [ ] Confirm gesture coordinates lie within the physical surface and the answer refers only to the frozen target.
- [ ] Run a deliberate identity mismatch and prove zero structured/OCR/model/recapture calls.
- [ ] Record screenshot paths, JSON receipts, timings, and `usedBackend` honestly.

## Task 8: Internal milestone verification

- [ ] Run full pytest with `-p no:cacheprovider` and a unique project-local `--basetemp`.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Record evidence and remaining limitations in the canonical design progress ledger and `docs/STATUS.md` as an unreleased development milestone.
- [ ] Do not bump the version, build an installer, run `npm run sync`, or claim installed delivery.

The complete backend reconstruction plan owns final packaging after all runtime, journal, scheduler, plugin, external-agent, self-evolution, cleanup, and real-machine gates pass.
