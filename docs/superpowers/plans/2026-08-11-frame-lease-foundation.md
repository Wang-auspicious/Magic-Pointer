# FrameLease Capture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gesture completion bind an immutable full-surface frame before structured perception starts, so switching screens after pointerup can never change the evidence consumed by OCR or the Agent.

**Architecture:** Add a versioned FrameLease contract shared by Electron and Python, a resident idle capture worker with an arm/commit/cancel protocol, and an Electron coordinator that commits before hiding the gesture overlay or opening a selection session. The first production backend is explicitly reported as `gdi-fallback`; the contract is designed for a later WGC/D3D provider without changing downstream code.

**Tech Stack:** Electron 43, TypeScript 6, Node child processes/JSONL RPC, Python 3.11+, Pillow ImageGrab, pytest, Node test runner.

---

## Scope and non-goals

This plan implements Phase A of `docs/design/MAGIC_POINTER_HARNESS_20260811.md` only.

Included:

- CaptureEpoch and FrameLease contracts;
- idle resident capture worker;
- arm-time short ring buffer;
- pointerup commit before perception;
- full display/target-surface artifact plus gesture metadata;
- Python selection bridge consuming the committed frame without recapture;
- honest source/backend/timing fields;
- regression tests and benchmark harness.

Not included:

- final WGC/D3D implementation;
- concurrent PerceptionBroker;
- resident UIA host;
- SurfaceAdapter SDK;
- Pi Agent integration;
- visual card redesign.

The GDI/Pillow backend is not treated as the final performance solution. It exists behind `CaptureProvider`, returns `source=gdi-fallback`, and is accepted only if the temporal correctness tests pass. WGC/D3D is the next capture backend after the contract is proven.

## File structure

- Create `electron/frame_lease.ts`: TypeScript FrameLease/CaptureEpoch types and runtime validation.
- Create `electron/capture_commit_coordinator.ts`: deterministic arm/commit/cancel ordering independent of Electron windows.
- Create `electron/frame_capture_worker_client.ts`: persistent JSONL client for the Python capture worker.
- Create `scripts/frame_lease.py`: Python validation/normalization of the same versioned contract.
- Create `scripts/frame_capture_worker.py`: idle resident worker and bounded in-memory ring buffer.
- Create `tests/frame_lease_test.ts`: TypeScript contract tests.
- Create `tests/capture_commit_coordinator_test.ts`: ordering, stale epoch and failure tests.
- Create `tests/frame_capture_worker_test.py`: worker state machine and immutable frame tests with an injected fake capture backend.
- Create `tests/frame_lease_python_test.py`: Python contract parity tests.
- Create `tests/frame_lease_selection_bridge_test.py`: selection bridge consumes the committed frame and never calls late capture.
- Create `tests/frame_capture_benchmark_test.py`: benchmark report completeness and failed-round accounting.
- Create `scripts/benchmark_frame_capture.py`: cold/warm success and latency report.
- Modify `electron/main.ts`: arm/commit/cancel integration and FrameLease payload forwarding.
- Modify `scripts/selection_snapshot_bridge.py`: accept a FrameLease, mark pixels frozen before structured reads, derive visual evidence from its immutable artifact.
- Modify `electron/coordinate_space.ts`: add tested physical display bounds conversion if no existing helper is sufficient.
- Modify `tests/coordinate_space_test.ts`: mixed-DPI display bounds cases.
- Modify `docs/STATUS.md`: record code status and explicit remaining WGC/real-desktop verification.
- Modify `docs/design/MAGIC_POINTER_HARNESS_20260811.md`: update progress ledger after verification.

## Task 1: Freeze the shared FrameLease contract

**Files:**
- Create: `electron/frame_lease.ts`
- Create: `scripts/frame_lease.py`
- Create: `tests/frame_lease_test.ts`
- Create: `tests/frame_lease_python_test.py`
- Create: `tests/fixtures/frame-lease-v1.json`

- [ ] **Step 1: Write the TypeScript failing contract test**

Create a fixture with `schemaVersion`, lease/epoch ids, timestamps, source, target identity, physical bounds, gesture, artifact, hash and `overlayExcluded`.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFrameLease } from '../electron/frame_lease';

test('accepts an immutable frame lease with physical coordinates', () => {
  const lease = validateFrameLease({
    schemaVersion: 1,
    frameLeaseId: 'frame-1',
    epochId: 'epoch-1',
    capturedAtMonotonicMs: 1250.5,
    capturedAtUtc: '2026-08-11T00:00:00.000Z',
    source: 'test',
    targetWindow: { hwnd: 42, processId: 7, processName: 'demo.exe', title: 'Demo' },
    surfaceBoundsPx: [0, 0, 1920, 1080],
    displayId: 'display-1',
    scaleFactor: 1,
    gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [] },
    localArtifact: { path: 'D:/tmp/frame.png', mimeType: 'image/png', width: 1920, height: 1080 },
    contentHash: 'sha256:abc',
    overlayExcluded: true,
    captureLatencyMs: 12.5,
  });
  assert.equal(lease.frameLeaseId, 'frame-1');
  assert.deepEqual(lease.surfaceBoundsPx, [0, 0, 1920, 1080]);
});

test('rejects non-physical or incomplete frame leases', () => {
  assert.throws(() => validateFrameLease({ schemaVersion: 1 }), /frameLeaseId/);
});
```

- [ ] **Step 2: Run the TypeScript test and observe the expected failure**

Run: `node --require tsx/cjs tests/frame_lease_test.ts`

Expected: FAIL because `electron/frame_lease.ts` does not exist.

- [ ] **Step 3: Implement the TypeScript types and validator**

Implement exported `FrameLease`, `WindowIdentity`, `FrameArtifactRef`, `CaptureSource`, `validateFrameLease`, and `cloneFrameLease`. Validation must:

- require schema version 1;
- require non-empty ids/timestamps/path/hash;
- require finite non-negative monotonic/latency values;
- require `[left, top, right, bottom]` with positive area;
- copy nested objects/arrays and return a deeply frozen object;
- allow only `wgc-window`, `wgc-display`, `dxgi-display`, `gdi-fallback`, `test` sources.

```ts
export function cloneFrameLease(value: FrameLease): FrameLease {
  return validateFrameLease(JSON.parse(JSON.stringify(value)));
}
```

- [ ] **Step 4: Run the TypeScript test and observe it pass**

Run: `node --require tsx/cjs tests/frame_lease_test.ts`

Expected: PASS.

- [ ] **Step 5: Write the Python failing parity tests**

```python
import json
from pathlib import Path

import pytest

from scripts.frame_lease import FrameLeaseError, normalize_frame_lease


def test_python_accepts_the_shared_v1_fixture() -> None:
    fixture = Path('tests/fixtures/frame-lease-v1.json')
    lease = normalize_frame_lease(json.loads(fixture.read_text(encoding='utf-8')))
    assert lease['frameLeaseId'] == 'frame-1'
    assert lease['surfaceBoundsPx'] == [0, 0, 1920, 1080]


def test_python_rejects_a_missing_artifact() -> None:
    with pytest.raises(FrameLeaseError, match='localArtifact'):
        normalize_frame_lease({'schemaVersion': 1, 'frameLeaseId': 'x'})
```

- [ ] **Step 6: Run the Python test and observe the expected failure**

Run: `python -m pytest tests/frame_lease_python_test.py -q --basetemp .pytest-local-frame-lease`

Expected: FAIL because `scripts.frame_lease` does not exist.

- [ ] **Step 7: Implement Python normalization**

Implement `FrameLeaseError` and `normalize_frame_lease(value)` with the same accepted sources, field names and geometry requirements as TypeScript. Return a new dictionary and never mutate the input.

- [ ] **Step 8: Run both contract suites**

Run:

```powershell
node --require tsx/cjs tests/frame_lease_test.ts
python -m pytest tests/frame_lease_python_test.py -q --basetemp .pytest-local-frame-lease
```

Expected: both PASS.

- [ ] **Step 9: Commit the contract**

```powershell
git add electron/frame_lease.ts scripts/frame_lease.py tests/frame_lease_test.ts tests/frame_lease_python_test.py tests/fixtures/frame-lease-v1.json
git commit -m "feat: define immutable frame lease contract"
```

## Task 2: Build the resident capture worker state machine

**Files:**
- Create: `scripts/frame_capture_worker.py`
- Create: `tests/frame_capture_worker_test.py`

- [ ] **Step 1: Write a failing worker state test with a fake backend**

The test must not capture the real desktop. Inject a backend returning uniquely colored PIL images and a fake monotonic clock.

```python
def test_commit_returns_the_latest_frame_captured_before_commit(tmp_path: Path) -> None:
    backend = FakeCaptureBackend(colors=['red', 'green', 'blue'])
    worker = FrameCaptureService(backend=backend, output_root=tmp_path, clock=FakeClock())
    worker.handle({'id': '1', 'method': 'arm', 'params': _arm_params()})
    worker.capture_once_for_test()
    worker.capture_once_for_test()
    result = worker.handle({'id': '2', 'method': 'commit', 'params': _commit_params()})
    assert result['result']['source'] == 'test'
    assert Image.open(result['result']['localArtifact']['path']).getpixel((0, 0)) == (0, 128, 0)
```

Also test:

- commit before arm returns `epoch_not_armed`;
- stale epoch id cannot commit another epoch;
- cancel releases all buffered images;
- ring size is bounded;
- commit persists exactly one immutable artifact;
- idle worker performs no captures.

- [ ] **Step 2: Run the worker test and observe the expected failure**

Run: `python -m pytest tests/frame_capture_worker_test.py -q --basetemp .pytest-local-capture-worker`

Expected: FAIL because `FrameCaptureService` does not exist.

- [ ] **Step 3: Implement the service independently of stdio**

Implement:

```python
class CaptureBackend(Protocol):
    source: str
    def capture(self, bbox_ltrb: tuple[int, int, int, int]) -> Image.Image: ...


class FrameCaptureService:
    def handle(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def capture_once_for_test(self) -> None: ...
    def close(self) -> None: ...
```

`arm` starts a daemon capture thread only for the active epoch. Use a bounded `deque` of timestamped images. `commit` atomically detaches the latest image at or before the commit time, saves it under `data/runtime/frame-leases`, computes SHA-256, returns a normalized FrameLease, and cancels the epoch. Never write every buffered frame to disk.

The production `PillowDisplayCaptureBackend` calls `ImageGrab.grab(bbox=bbox, all_screens=True)` and reports `gdi-fallback`. Do not claim overlay exclusion unless the caller explicitly provides `overlayExcluded=true` and the platform is Windows.

- [ ] **Step 4: Run the worker tests and observe them pass**

Run: `python -m pytest tests/frame_capture_worker_test.py -q --basetemp .pytest-local-capture-worker`

Expected: PASS.

- [ ] **Step 5: Add bounded JSONL stdio transport**

`main()` reads one JSON object per line, limits each line to 64KiB, writes one JSON response per request, flushes immediately, and returns structured errors. Supported methods are `ping`, `arm`, `commit`, `cancel`, `shutdown`.

- [ ] **Step 6: Test the real subprocess protocol without desktop capture**

Add `--backend test` and send `ping`, `arm`, `commit`, `shutdown` through `subprocess.Popen`. Assert request ids match and stdout contains JSON only.

- [ ] **Step 7: Run worker tests again**

Run: `python -m pytest tests/frame_capture_worker_test.py -q --basetemp .pytest-local-capture-worker`

Expected: PASS.

- [ ] **Step 8: Commit the worker**

```powershell
git add scripts/frame_capture_worker.py tests/frame_capture_worker_test.py
git commit -m "feat: add idle resident frame capture worker"
```

## Task 3: Add the Electron worker client and commit coordinator

**Files:**
- Create: `electron/frame_capture_worker_client.ts`
- Create: `electron/capture_commit_coordinator.ts`
- Create: `tests/frame_capture_worker_client_test.ts`
- Create: `tests/capture_commit_coordinator_test.ts`

- [ ] **Step 1: Write the failing client tests**

Use an injected fake child process with PassThrough streams. Cover:

- one persistent child is reused across arm/commit;
- request ids resolve the correct promise even if replies are delayed;
- malformed output rejects only the affected request and records a protocol error;
- process exit rejects all pending requests;
- timeout sends cancel and rejects;
- stdout logging never includes frame contents.

- [ ] **Step 2: Run and observe failure**

Run: `node --require tsx/cjs tests/frame_capture_worker_client_test.ts`

Expected: FAIL because the client does not exist.

- [ ] **Step 3: Implement `FrameCaptureWorkerClient`**

Expose:

```ts
export interface FrameCaptureWorkerClientOptions {
  spawnWorker: () => ChildProcessWithoutNullStreams;
  requestTimeoutMs?: number;
}

export class FrameCaptureWorkerClient {
  start(): Promise<void>;
  arm(request: CaptureArmRequest): Promise<void>;
  commit(request: CaptureCommitRequest): Promise<FrameLease>;
  cancel(epochId: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

Do not spawn through a shell. Reuse the repository Python runtime resolver and pass an argv array.

- [ ] **Step 4: Run client tests and observe pass**

Run: `node --require tsx/cjs tests/frame_capture_worker_client_test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing coordinator ordering tests**

```ts
test('commits pixels before overlay release and session start', async () => {
  const events: string[] = [];
  const coordinator = new CaptureCommitCoordinator({
    provider: fakeProvider(events),
    releaseOverlay: () => events.push('overlay-release'),
    beginSession: (_gesture, lease) => events.push(`session:${lease.frameLeaseId}`),
  });
  await coordinator.arm(_arm());
  await coordinator.complete(_gesture());
  assert.deepEqual(events, ['arm', 'commit', 'overlay-release', 'session:frame-1']);
});
```

Also test stale token, duplicate completion, commit failure, cancellation during commit and beginSession receiving a deep-frozen lease.

- [ ] **Step 6: Run and observe failure**

Run: `node --require tsx/cjs tests/capture_commit_coordinator_test.ts`

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 7: Implement the coordinator state machine**

States: `idle -> armed -> committing -> committed | failed | cancelled`. Only the active token may complete. On commit failure, release the overlay, report a structured failure and do not silently call the old late-capture path.

- [ ] **Step 8: Run both TypeScript suites**

Run:

```powershell
node --require tsx/cjs tests/frame_capture_worker_client_test.ts
node --require tsx/cjs tests/capture_commit_coordinator_test.ts
npm run typecheck
```

Expected: tests PASS; typecheck exits 0.

- [ ] **Step 9: Commit client and coordinator**

```powershell
git add electron/frame_capture_worker_client.ts electron/capture_commit_coordinator.ts tests/frame_capture_worker_client_test.ts tests/capture_commit_coordinator_test.ts
git commit -m "feat: coordinate frame commit before session capture"
```

## Task 4: Make physical display bounds explicit and tested

**Files:**
- Modify: `electron/coordinate_space.ts`
- Modify: `tests/coordinate_space_test.ts`

- [ ] **Step 1: Write failing mixed-DPI tests**

Test a primary 100% display and secondary 150% display with non-zero and negative origins. The desired helper returns physical LTRB bounds and never treats a DIP width as a physical width.

```ts
assert.deepEqual(
  physicalDisplayBounds({ bounds: { x: 1920, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }),
  [2880, 0, 5441, 1440],
);
```

- [ ] **Step 2: Run and observe failure**

Run: `node --require tsx/cjs tests/coordinate_space_test.ts`

Expected: FAIL because `physicalDisplayBounds` is not exported.

- [ ] **Step 3: Implement the pure helper**

Round origin and size separately, require finite positive scale, and return `[left, top, right, bottom]`.

- [ ] **Step 4: Run coordinate and type tests**

Run:

```powershell
node --require tsx/cjs tests/coordinate_space_test.ts
npm run typecheck
```

Expected: PASS and typecheck exit 0.

- [ ] **Step 5: Commit coordinate conversion**

```powershell
git add electron/coordinate_space.ts tests/coordinate_space_test.ts
git commit -m "fix: define physical display capture bounds"
```

## Task 5: Integrate arm/commit into Electron gesture lifecycle

**Files:**
- Modify: `electron/main.ts`
- Create: `tests/frame_lease_main_wiring_test.ts`

- [ ] **Step 1: Write the failing static wiring test**

The test reads `electron/main.ts` and asserts:

- overlay and stage windows call `setContentProtection(true)` under the same capture-protection policy;
- `armSelectionGesture` arms the capture coordinator with physical display bounds and the committed foreground identity;
- `completeSelectionGesture` awaits coordinator commit before `cancelSelectionGesture('completed')` and before `beginSelectionSession`;
- the old fixed 34ms commit timer is absent;
- `beginSelectionSession` accepts and forwards `frameLease`.

- [ ] **Step 2: Run and observe the expected failure**

Run: `node --require tsx/cjs tests/frame_lease_main_wiring_test.ts`

Expected: FAIL because the old 34ms timer and late bridge flow remain.

- [ ] **Step 3: Wire the persistent client during app lifecycle**

Create one `FrameCaptureWorkerClient`. It may be started lazily on first arm, remains idle between gestures, and shuts down during app quit. Do not start a new Python process per gesture.

- [ ] **Step 4: Arm capture with the gesture**

At `armSelectionGesture`, record epoch id/token, physical display bounds, foreground HWND/app, display id and scale factor. Start ring capture before showing the drawing overlay when possible; otherwise start before accepting pointerdown.

- [ ] **Step 5: Commit before releasing overlay**

Convert `completeSelectionGesture` to an async-safe flow. Mark the arm as committing so duplicate callbacks cannot start another session. Await the most recent buffered frame, then hide/cancel overlay and call `beginSelectionSession(reason, gesture, frameLease)` immediately. Remove the 34ms timer.

If commit fails, do not perform a late screenshot. Open the existing error surface with `frame_commit_failed` and allow retry.

- [ ] **Step 6: Forward the immutable lease to Python**

Add `frameLease: safeClone(frameLease)` to the `capture_selection_snapshot` payload. Do not pass raw image bytes through IPC.

- [ ] **Step 7: Run targeted Electron tests and typecheck**

Run:

```powershell
node --require tsx/cjs tests/frame_lease_main_wiring_test.ts
node --require tsx/cjs tests/gesture_capture_test.ts
node --require tsx/cjs tests/coordinate_space_test.ts
node tests/continuous_gesture_episode_contract_test.js
node tests/multi_stroke_chain_contract_test.js
npm run typecheck
```

Expected: all targeted tests PASS; typecheck exits 0.

- [ ] **Step 8: Commit lifecycle integration**

```powershell
git add electron/main.ts tests/frame_lease_main_wiring_test.ts
git commit -m "fix: freeze gesture frame before perception starts"
```

## Task 6: Make the Python bridge consume FrameLease without recapture

**Files:**
- Modify: `scripts/selection_snapshot_bridge.py`
- Create: `tests/frame_lease_selection_bridge_test.py`

- [ ] **Step 1: Write the failing regression test**

Create two images: `frozen.png` contains `BEFORE`; a fake late capture returns `AFTER`. Pass a valid FrameLease referencing `frozen.png`, delay the structured adapter, and assert:

- returned `capture_path` is `frozen.png`;
- fake late capture was never called;
- `capture_bbox` equals FrameLease surface bounds;
- `pixels_frozen` is emitted before `structured_read`;
- source/backend remains `gdi-fallback` rather than being relabeled;
- gesture selection bbox remains separate from surface bbox.

- [ ] **Step 2: Run and observe the expected failure**

Run: `python -m pytest tests/frame_lease_selection_bridge_test.py -q --basetemp .pytest-local-frame-bridge`

Expected: FAIL because `capture_snapshot` does not accept `frame_lease`.

- [ ] **Step 3: Normalize FrameLease at the start of capture**

Add `frame_lease: dict[str, Any] | None = None` to `capture_snapshot`. When present:

1. validate it before enumerating structured adapters;
2. verify artifact path exists and dimensions/hash match;
3. construct `visual` from the immutable artifact;
4. emit `pixels_frozen` immediately;
5. run structured perception afterward;
6. never call `_grab_capture_image` or `_capture_visual_region` for that snapshot.

Invalid leases fail closed with `invalid_frame_lease`; they do not silently recapture the current screen.

- [ ] **Step 4: Preserve full-surface and semantic-region fields**

Return:

- `frame_lease`;
- `capture_path`/`capture_bbox` for full surface;
- `selection_bbox` for gesture semantics;
- `model_view_path` only when later derived;
- capture attestation including backend, hash and overlay exclusion.

Do not overwrite capture bbox with the selected crop.

- [ ] **Step 5: Forward payload in `main()`**

Pass `payload.get('frameLease')` into `capture_snapshot`.

- [ ] **Step 6: Run bridge regression and affected suites**

Run:

```powershell
python -m pytest tests/frame_lease_selection_bridge_test.py tests/selection_snapshot_bridge_test.py tests/marked_read_wiring_test.py tests/capture_blank_test.py tests/window_identity_test.py -q --basetemp .pytest-local-frame-bridge
```

Expected: all PASS.

- [ ] **Step 7: Commit bridge consumption**

```powershell
git add scripts/selection_snapshot_bridge.py tests/frame_lease_selection_bridge_test.py
git commit -m "fix: consume frozen frame lease in selection bridge"
```

## Task 7: Benchmark, verify and update durable progress

**Files:**
- Create: `scripts/benchmark_frame_capture.py`
- Modify: `docs/STATUS.md`
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`

- [ ] **Step 1: Write benchmark output tests**

Add a test around the report formatter so every report includes rounds, successes, errors, cold/warm, p50, p95, max, backend, frame dimensions and process reuse count. Do not test real desktop pixels in CI.

- [ ] **Step 2: Run and observe failure**

Run: `python -m pytest tests/frame_capture_benchmark_test.py -q --basetemp .pytest-local-frame-bench`

Expected: FAIL because formatter/module does not exist.

- [ ] **Step 3: Implement benchmark script**

The script starts one worker, arms/commits N rounds against a user-provided or current display, validates every returned artifact, and emits JSON plus a human summary. A failed round remains in the denominator.

- [ ] **Step 4: Run the headless full verification**

Run:

```powershell
npm test
npm run typecheck
npm run lint
python -m pytest -q --basetemp .pytest-local-frame-full
```

Expected: all commands exit 0. If the pre-existing baseline is not green, record exact failures and do not claim full completion.

- [ ] **Step 5: Run the real capture benchmark without launching Electron UI**

Run: `python scripts/benchmark_frame_capture.py --rounds 20`

Expected: 20 valid immutable artifacts, one reused worker, backend reported honestly, latency distribution printed. This measures the GDI fallback; it does not prove WGC target performance.

- [ ] **Step 6: Update durable docs**

In `docs/STATUS.md`, record:

- FrameLease code and automated verification;
- actual benchmark numbers;
- whether overlay exclusion still requires real Electron-session verification;
- WGC/D3D remains pending.

In the canonical design progress ledger, check only completed facts and link the next Phase B plan.

- [ ] **Step 7: Commit verification artifacts and status**

```powershell
git add scripts/benchmark_frame_capture.py tests/frame_capture_benchmark_test.py docs/STATUS.md docs/design/MAGIC_POINTER_HARNESS_20260811.md
git commit -m "test: verify frame lease capture foundation"
```

## Plan self-review checklist

- [ ] Every production behavior has a preceding failing test.
- [ ] No test requires launching the Electron UI.
- [ ] The old 34ms timer is removed only after commit ordering is covered.
- [ ] Invalid/missing FrameLease never falls back to capturing a later screen.
- [ ] Full surface bbox and gesture bbox remain distinct.
- [ ] Backend is reported as `gdi-fallback`, not WGC.
- [ ] Worker is idle when not armed and reused across gestures.
- [ ] Multi-DPI and negative-origin displays are covered.
- [ ] Other-agent untracked files are preserved.
- [ ] Docs distinguish automated, benchmark and real-desktop verification.
