# Evidence Truth Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly prohibited subagents, so execution is inline with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frozen surface, target identity, structured reads, and pixel evidence agree or fail closed; repair the confirmed single-instance and CSP faults; prove the result in the installed app on the current 200% DPI Windows desktop.

**Architecture:** Add one deep Python `EvidenceBinding` boundary between FrameLease validation and perception, repair the real-machine harness and capture worker so coordinates are physical before capture, and keep Electron startup/rendering fixes narrow. The plan does not replace the Agent Runtime; it creates the truth boundary required before that replacement.

**Tech Stack:** Python 3.12, pytest, TypeScript, Electron, Node assertion tests, Pillow/ImageGrab, Windows user32/shcore, PowerShell/NSIS delivery.

---

## File map

- Create `app/grounding/evidence_binding.py`: normalize and validate the binding between a frozen lease, its captured surface, gesture geometry, and the source window selected for structured perception.
- Create `tests/evidence_binding_test.py`: contract tests for accepted and rejected evidence bindings.
- Modify `scripts/selection_snapshot_bridge.py`: invoke the binding exactly once before structured perception and surface structured rejection codes.
- Modify `tests/frame_lease_selection_bridge_test.py`: prove a mismatched lease fails without recapturing.
- Modify `scripts/real_scenario_test.py`: enable DPI awareness before any window coordinates, require foreground acquisition, use real PID/scale/screen metrics, and preserve truthful evidence metadata.
- Create `tests/real_scenario_harness_test.py`: focused tests for foreground verification and physical display metadata.
- Modify `scripts/frame_capture_worker.py`: enable DPI awareness before constructing a production ImageGrab backend.
- Modify `tests/frame_capture_worker_test.py`: prove capture-process initialization occurs before backend use.
- Modify `electron/main.ts`: prevent the losing single-instance process from running readiness initialization.
- Create `tests/single_instance_startup_test.js`: pin the readiness gate and second-instance behavior.
- Modify `electron/renderer/card_render.ts`: replace CSP-blocked iframe style attributes with the safe `height` attribute.
- Modify `tests/card_render_test.js`: pin bounded height without inline style.
- Modify `package.json`: bump the patch version for the user-visible installed fix.
- Modify `docs/design/MAGIC_POINTER_HARNESS_20260811.md`: record Phase 1 evidence and remaining WGC status honestly.
- Modify `docs/STATUS.md`: record the delivered installed version and manual verification evidence.

## Task 1: Add the frozen evidence binding contract

**Files:**
- Create: `app/grounding/evidence_binding.py`
- Create: `tests/evidence_binding_test.py`

- [ ] **Step 1: Write failing binding tests**

Create fixtures with a display-sized lease, a matching source window, and a gesture inside the surface. Pin these behaviors:

```python
def test_bind_frozen_evidence_accepts_matching_window_and_gesture(tmp_path):
    lease = lease_fixture(tmp_path, target={
        "hwnd": 42, "processId": 7,
        "processName": "notepad.exe", "title": "Notes",
    })
    result = bind_frozen_evidence(
        lease,
        source_window={"hwnd": 42, "pid": 7, "process_name": "notepad.exe"},
        gesture=lease["gesture"],
    )
    assert result.status == "verified"
    assert result.target["hwnd"] == 42


@pytest.mark.parametrize(
    ("source_window", "reason"),
    [
        ({"hwnd": 99, "pid": 7, "process_name": "notepad.exe"}, "target_hwnd_mismatch"),
        ({"hwnd": 42, "pid": 8, "process_name": "notepad.exe"}, "target_process_mismatch"),
        ({"hwnd": 42, "pid": 7, "process_name": "other.exe"}, "target_process_name_mismatch"),
    ],
)
def test_bind_frozen_evidence_rejects_wrong_source(tmp_path, source_window, reason):
    with pytest.raises(EvidenceBindingError, match=reason):
        bind_frozen_evidence(lease_fixture(tmp_path), source_window, gesture_fixture())


def test_bind_frozen_evidence_rejects_artifact_surface_size_mismatch(tmp_path):
    lease = lease_fixture(tmp_path, surface=[0, 0, 1920, 1080], image_size=(960, 540))
    with pytest.raises(EvidenceBindingError, match="artifact_surface_mismatch"):
        bind_frozen_evidence(lease, source_window_fixture(), gesture_fixture())


def test_bind_frozen_evidence_rejects_gesture_outside_surface(tmp_path):
    with pytest.raises(EvidenceBindingError, match="gesture_outside_surface"):
        bind_frozen_evidence(
            lease_fixture(tmp_path), source_window_fixture(),
            {"coordinateSpace": "physical_screen_pixels", "points": [{"x": 3000, "y": 2000}]},
        )
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
python -m pytest -q tests/evidence_binding_test.py --basetemp data/runtime/pytest-evidence-binding-red
```

Expected: collection fails because `app.grounding.evidence_binding` does not exist.

- [ ] **Step 3: Implement the minimal deep module**

Create a frozen result and one public binding function:

```python
@dataclass(frozen=True, slots=True)
class EvidenceBinding:
    status: str
    target: dict[str, Any]
    surface_bounds_px: tuple[int, int, int, int]
    capture_kind: str


class EvidenceBindingError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def bind_frozen_evidence(
    lease: Mapping[str, Any],
    source_window: Mapping[str, Any] | None,
    gesture: Mapping[str, Any] | None,
) -> EvidenceBinding:
    target = _identity(lease.get("targetWindow"))
    observed = _identity(source_window)
    _require_complete_identity(target)
    _require_same_identity(target, observed)
    surface = _surface(lease.get("surfaceBoundsPx"))
    _require_artifact_matches_surface(lease.get("localArtifact"), surface)
    _require_physical_gesture_inside(gesture, surface)
    return EvidenceBinding(
        status="verified",
        target=target,
        surface_bounds_px=surface,
        capture_kind=_capture_kind(str(lease.get("source") or "")),
    )
```

Private helpers normalize `pid/processId`, `process_name/processName`, compare process names case-insensitively, require positive HWND/PID, compare declared artifact width/height to surface width/height, and require every gesture point to be inside the captured surface.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same pytest command. Expected: all tests in `evidence_binding_test.py` pass.

- [ ] **Step 5: Commit only the new contract**

```powershell
git add -- app/grounding/evidence_binding.py tests/evidence_binding_test.py
git commit -m "feat: bind frozen evidence to target identity"
```

## Task 2: Enforce the binding before perception

**Files:**
- Modify: `scripts/selection_snapshot_bridge.py:1654-1705`
- Modify: `tests/frame_lease_selection_bridge_test.py`

- [ ] **Step 1: Write the failing bridge test**

Add a capture call whose lease names HWND/PID 42/7 while the supplied source window is 99/8. The visual capture spy must remain unused:

```python
def test_frozen_lease_target_mismatch_fails_before_perception(tmp_path):
    visual_calls = []
    result = capture_snapshot(
        windows=[window(hwnd=99, pid=8)],
        target_hwnd=99,
        target_point={"x": 120, "y": 120},
        gesture=gesture_fixture(),
        frame_lease=frame_lease_fixture(tmp_path, hwnd=42, pid=7),
        visual_capture=lambda **kwargs: visual_calls.append(kwargs),
    )
    snapshot = result["selectionSnapshot"]
    assert snapshot["status"] == "invalid_frame_lease"
    assert snapshot["structured_gap_reason"] == "invalid_frame_lease:target_hwnd_mismatch"
    assert visual_calls == []
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
python -m pytest -q tests/frame_lease_selection_bridge_test.py -k target_mismatch --basetemp data/runtime/pytest-lease-bridge-red
```

Expected: the current bridge proceeds instead of returning `invalid_frame_lease`.

- [ ] **Step 3: Call `bind_frozen_evidence` once the source window is resolved**

After `target_window = available_windows[0] if available_windows else None`, add:

```python
if frozen_lease is not None:
    try:
        frozen_binding = bind_frozen_evidence(
            frozen_lease,
            target_window,
            normalized_gesture,
        )
    except EvidenceBindingError as exc:
        return _frame_lease_failure_snapshot(captured, exc.reason)
```

Attach the verified binding fields to `capture_attestation`; do not recapture and do not invoke any structured adapter when it fails.

- [ ] **Step 4: Run focused bridge and binding tests**

```powershell
python -m pytest -q tests/evidence_binding_test.py tests/frame_lease_selection_bridge_test.py --basetemp data/runtime/pytest-evidence-bridge-green
```

Expected: all selected files pass.

- [ ] **Step 5: Commit the bridge enforcement**

```powershell
git add -- scripts/selection_snapshot_bridge.py tests/frame_lease_selection_bridge_test.py
git commit -m "fix: fail closed on frozen target mismatch"
```

## Task 3: Repair the real-machine capture harness

**Files:**
- Modify: `scripts/real_scenario_test.py`
- Create: `tests/real_scenario_harness_test.py`

- [ ] **Step 1: Write failing tests for foreground and physical metrics**

Extract testable helpers and pin:

```python
def test_wait_for_foreground_requires_the_requested_hwnd():
    observed = iter([11, 11, 42])
    assert wait_for_foreground(
        42,
        reader=lambda: next(observed),
        clock=fake_clock([0.0, 0.1, 0.2]),
        sleeper=lambda _: None,
        timeout=0.5,
    ) is True


def test_wait_for_foreground_times_out_instead_of_capturing_wrong_window():
    assert wait_for_foreground(
        42,
        reader=lambda: 11,
        clock=fake_clock([0.0, 0.6]),
        sleeper=lambda _: None,
        timeout=0.5,
    ) is False


def test_virtual_screen_bounds_use_origin_plus_size():
    metrics = {76: -1920, 77: 0, 78: 5760, 79: 2160}
    assert virtual_screen_bounds(lambda key: metrics[key]) == [-1920, 0, 3840, 2160]
```

- [ ] **Step 2: Run tests and verify RED**

```powershell
python -m pytest -q tests/real_scenario_harness_test.py --basetemp data/runtime/pytest-real-harness-red
```

Expected: imported helpers are missing.

- [ ] **Step 3: Make the harness DPI-aware and foreground-safe**

At process initialization call the existing `enable_dpi_awareness()` before any `GetWindowRect`/DWM enumeration. Implement:

```python
def wait_for_foreground(hwnd, *, reader, clock, sleeper, timeout=2.0):
    deadline = clock() + timeout
    while clock() <= deadline:
        if int(reader() or 0) == int(hwnd):
            return True
        sleeper(0.05)
    return False


def virtual_screen_bounds(metric_reader=user32.GetSystemMetrics):
    left = int(metric_reader(76))
    top = int(metric_reader(77))
    return [left, top, left + int(metric_reader(78)), top + int(metric_reader(79))]
```

`_set_foreground` raises `RuntimeError("foreground_acquisition_failed")` unless the requested HWND is observed. Preserve the real PID when rebuilding the scenario window record. Use `GetDpiForWindow(hwnd) / 96` for the lease scale factor and use virtual screen metrics rather than `[0, 0, 1920, 1080]`. Do not reintroduce clipboard paste; the manual acceptance driver uses Unicode input.

- [ ] **Step 4: Run harness tests and syntax checks**

```powershell
python -m pytest -q tests/real_scenario_harness_test.py --basetemp data/runtime/pytest-real-harness-green
python -m py_compile scripts/real_scenario_test.py
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the harness repair**

```powershell
git add -- scripts/real_scenario_test.py tests/real_scenario_harness_test.py
git commit -m "test: make desktop scenarios coordinate truthful"
```

## Task 4: Initialize the production capture worker in physical coordinates

**Files:**
- Modify: `scripts/frame_capture_worker.py:347-372`
- Modify: `tests/frame_capture_worker_test.py`

- [ ] **Step 1: Write a failing initialization-order test**

Add a public process initializer with injected dependencies so the order is testable without opening a GUI:

```python
def test_capture_process_enables_dpi_before_backend_creation():
    calls = []
    initialize_capture_process(
        enable_dpi=lambda: calls.append("dpi"),
        create_backend=lambda: calls.append("backend") or SolidColorTestBackend(),
    )
    assert calls == ["dpi", "backend"]
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
python -m pytest -q tests/frame_capture_worker_test.py -k dpi --basetemp data/runtime/pytest-worker-dpi-red
```

Expected: `initialize_capture_process` does not exist.

- [ ] **Step 3: Add the initializer and use it in `main`**

```python
def initialize_capture_process(*, enable_dpi, create_backend):
    enable_dpi()
    return create_backend()
```

In production pass `app.system_context.enable_dpi_awareness` and the existing provider-selection closure. DPI initialization must occur before `ImageGrab` captures its first frame.

- [ ] **Step 4: Run worker tests**

```powershell
python -m pytest -q tests/frame_capture_worker_test.py tests/capture_provider_test.py --basetemp data/runtime/pytest-worker-dpi-green
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the worker fix**

```powershell
git add -- scripts/frame_capture_worker.py tests/frame_capture_worker_test.py
git commit -m "fix: initialize frame capture in physical coordinates"
```

## Task 5: Stop losing instances from booting services

**Files:**
- Modify: `electron/main.ts:598-607,3189`
- Create: `tests/single_instance_startup_test.js`

- [ ] **Step 1: Write the failing static contract test**

```javascript
const source = fs.readFileSync('electron/main.ts', 'utf8');
assert.match(source, /const gotLock = app\.requestSingleInstanceLock\(\)/);
assert.match(source, /if \(gotLock\) app\.whenReady\(\)\.then\(/,
  'the losing instance must never enter readiness initialization');
assert.match(source, /if \(!gotLock\)\s*\{\s*app\.quit\(\)/);
assert.match(source, /app\.on\('second-instance'/);
```

- [ ] **Step 2: Run Node tests and verify RED**

```powershell
node tests/single_instance_startup_test.js
```

Expected: readiness initialization is currently unconditional.

- [ ] **Step 3: Gate readiness on lock ownership**

Change only the readiness entry:

```typescript
if (gotLock) app.whenReady().then(() => {
  // existing primary-instance initialization unchanged
});
```

The loser calls `app.quit()` and has no code path into UIA startup, hotkey registration, capture workers, or windows. The primary retains the `second-instance` handler that shows the existing surface.

- [ ] **Step 4: Run the focused and existing integration tests**

```powershell
node tests/single_instance_startup_test.js
node tests/gesture_activation_integration_test.js
node tests/multi_stroke_chain_contract_test.js
node tests/stage_observer_handoff_test.js
```

Expected: all exit 0.

- [ ] **Step 5: Commit the lifecycle fix**

```powershell
git add -- electron/main.ts tests/single_instance_startup_test.js
git commit -m "fix: gate startup on single-instance ownership"
```

## Task 6: Remove the CSP-blocked iframe style

**Files:**
- Modify: `electron/renderer/card_render.ts:407-431`
- Modify: `tests/card_render_test.js:231-258`

- [ ] **Step 1: Change the test first**

Replace the old serialized-style assertion with:

```javascript
assert.ok(/height="520"/.test(slotTall));
assert.ok(!/<iframe[^>]+style=/.test(slotTall),
  'stage CSP forbids iframe inline style attributes');
assert.ok(!/<iframe[^>]+style=/.test(slotHtml));
```

- [ ] **Step 2: Run the test and verify RED**

```powershell
node tests/card_render_test.js
```

Expected: generated iframe contains `style="height:...px"` and no safe height attribute.

- [ ] **Step 3: Use the iframe height attribute**

In both `srcdoc` and HTTPS branches replace:

```typescript
style: `height:${height}px`,
```

with:

```typescript
height: String(height),
```

Keep the existing 96–520 clamp and CSS `max-height: 520px`.

- [ ] **Step 4: Run card rendering and type checks**

```powershell
node tests/card_render_test.js
npm run typecheck
```

Expected: both exit 0 and the card test emits no CSP-related assertion failure.

- [ ] **Step 5: Commit the renderer fix**

```powershell
git add -- electron/renderer/card_render.ts tests/card_render_test.js
git commit -m "fix: render tool iframe height without inline style"
```

## Task 7: Run controlled source-tree acceptance

**Files:**
- Evidence output: `data/runtime/scenario-evidence/notepad-crossref/`
- Modify only if the run exposes a new root cause; start a new RED/GREEN cycle before any such production edit.

- [ ] **Step 1: Launch the controlled Notepad cross-reference scenario with Unicode input**

Use the existing SendInput Unicode driver so clipboard contents are untouched. The test must assert foreground ownership before capture.

- [ ] **Step 2: Inspect the frozen frame and JSON binding**

Required evidence:

```text
frame pixels show the Notepad document
frameLease.targetWindow.hwnd == selectionSnapshot.source_window.hwnd
frameLease.targetWindow.processId == selectionSnapshot.source_window.pid
capture_attestation.status == verified
gesture coordinates lie inside surfaceBoundsPx
answer contains 3.6 and does not mention Magic Pointer settings
```

- [ ] **Step 3: Run a deliberate mismatch case**

Change only the diagnostic payload identity to a different HWND. Expected: `invalid_frame_lease:target_hwnd_mismatch`, zero structured reads, zero OCR/model calls, and no current-screen recapture.

- [ ] **Step 4: Record timings and backend honestly**

Copy the snapshot phase timings and answer route/backend into the evidence note. Do not turn a model timeout or an OCR miss into a pass.

## Task 8: Full verification and installed delivery

**Files:**
- Modify: `package.json`
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Run full verification with an isolated project-local pytest temp**

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
python -m pytest -q --basetemp "data/runtime/pytest-full-$stamp"
npm test
npm run typecheck
```

Expected: Python reports zero failures/errors, Node reports zero failures, and every TypeScript project exits 0. Any frame-worker shutdown warning is treated as a defect to diagnose, not ignored.

- [ ] **Step 2: Bump the patch version**

Change `package.json` from `1.0.4` to `1.0.5` only after the complete source-tree verification passes.

- [ ] **Step 3: Update the canonical progress ledger and status**

Record:

```text
Phase 1 evidence binding implemented
controlled 200% DPI scenario evidence paths and measured timings
single-instance and CSP root causes/fixes
full verification counts
WGC remains unverified unless a real WGC lease was observed
delivered installed version 1.0.5
```

- [ ] **Step 4: Sync the installed application**

```powershell
npm run sync
```

Expected: verification, Electron build, NSIS build, running-instance shutdown, silent install, and restart all succeed.

- [ ] **Step 5: Verify development and installed versions match**

```powershell
$dev = (Get-Content -Raw -LiteralPath package.json | ConvertFrom-Json).version
$installedPath = Join-Path $env:LOCALAPPDATA 'Programs\Magic Pointer\resources\app\package.json'
$installed = (Get-Content -Raw -LiteralPath $installedPath | ConvertFrom-Json).version
if ($dev -ne $installed) { throw "version mismatch: dev=$dev installed=$installed" }
```

Expected: both versions are `1.0.5`.

- [ ] **Step 6: Re-run the installed-app acceptance**

Use the actual installed executable, capture the dashboard and one real Notepad gesture, then inspect `electron.log` for:

```text
exactly one app ready line for a second-instance launch
no hotkey registration from the losing instance
no CSP inline-style violation
frozen target identity and pixels agree
no voice focus invariant failure caused by result delivery
```

If a new failure appears, do not mark the phase complete. Start a focused diagnosis and TDD task, repeat full verification, bump again if the fix changes visible behavior, and resync.

- [ ] **Step 7: Commit the delivered ledger/version update**

```powershell
git add -- package.json docs/design/MAGIC_POINTER_HARNESS_20260811.md docs/STATUS.md
git commit -m "chore: deliver evidence truth foundation 1.0.5"
```

## Self-review

- Spec coverage: Phase 1 covers evidence binding, high-DPI test truth, production capture initialization, single-instance startup, CSP rendering, real-machine acceptance, full verification, installed sync, and progress-ledger updates.
- Deliberately deferred: RunJournal, continuation lease, scheduler, typed plugins, external-agent supervision, and self-evolution belong to later independently testable plans defined by the master reconstruction spec.
- Placeholder scan: the plan contains no TBD/TODO steps; each behavior change has an explicit failing test, implementation shape, passing command, and delivery gate.
- Type consistency: `EvidenceBinding`, `EvidenceBindingError.reason`, `bind_frozen_evidence`, `ContinuationLease`, FrameLease camelCase fields, and source-window aliases are consistent with the master spec and existing bridge payloads.
