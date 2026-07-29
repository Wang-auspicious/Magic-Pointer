# Grounding and Runtime Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false target geometry and mixed-DPI selection drift, then give the Dashboard one authoritative, low-latency runtime/capability snapshot.

**Architecture:** Introduce two deep modules. `GroundingGeometry` separates evidence capture from target feedback and owns all physical-pixel-to-Electron-DIP transforms. `RuntimeSnapshot` owns readiness/capability probing, caching, single-flight refresh, generation invalidation, and repair actions. Existing UIA, DOM/CDP, visual capture, voice, Fabric, Stage, and Dashboard code become adapters or callers of these interfaces.

**Tech Stack:** Electron 43/CommonJS, Node.js, Python 3, Windows UIA/C#, Chrome DevTools Protocol, Pillow, pytest, Node `assert`, electron-builder/NSIS.

---

## Scope and delivery boundary

This is the first executable slice of [the 2026-07-29 product design](../specs/2026-07-29-grounded-desktop-product-design.md). It intentionally stops before OfficeCLI writes, a public extension host, and macOS claims. Those are separate implementation plans because they have independent trust, lifecycle, and release surfaces.

The user has already selected inline continuation with few subagents. Execute tasks in order, preserve the dirty working tree, and commit/push `main` only after the verification gate in Task 10.

## File map

### GroundingGeometry

- `scripts/selection_snapshot_bridge.py`: produce distinct capture and target geometry; all Python-origin rectangles declare a coordinate space.
- `electron/coordinate_space.js`: validate and transform canonical physical geometry to Electron DIP and Stage-local geometry.
- `electron/main.js`: call `GroundingGeometry`; stop performing ad hoc rectangle conversion.
- `electron/renderer/stage.js`: render only exact target rectangles; pointer-only and invalid grounding stay invisible; never render capture evidence.
- `tests/selection_snapshot_bridge_test.py`: Python geometry contract.
- `tests/coordinate_space_test.js`: transform, negative-coordinate, and invalid-geometry contract.
- `tests/grounding_geometry_integration_test.js`: bridge-payload-to-Stage projection contract.
- `scripts/verify_browser_selection_alignment.py`: real browser/UIA/DOM evidence and edge-error measurement.

### RuntimeSnapshot

- `electron/runtime_snapshot.js`: authoritative snapshot, TTL cache, single-flight refresh, generation invalidation.
- `electron/runtime_probes.js`: owned local probes with explicit deadlines and typed results.
- `electron/main.js`: one IPC endpoint and invalidation events.
- `electron/preload.js`: expose one context-isolated snapshot call and one change subscription.
- `electron/renderer/dashboard.js`: bootstrap from one snapshot; no independent startup Fabric fan-out.
- `electron/preflight_checks.js`: return probe evidence to RuntimeSnapshot instead of deciding UI truth independently.
- `app/fabric/capability_snapshot.py`: compute executable capability states from adapters, settings, permissions, and verification paths.
- `scripts/electron_bridge.py`: add `runtime.snapshot` bridge mode.
- `tests/runtime_snapshot_test.js`: cache/single-flight/generation/error contract.
- `tests/capability_snapshot_test.py`: executable/needs-setup/blocked/experimental/unavailable contract.
- `tests/dashboard_runtime_snapshot_static_test.js`: supplemental wiring checks.

### Workspace performance

- `app/fabric/recipes.py`: declare whether a recipe needs Git workspace evidence.
- `app/fabric/engine.py`: resolve Git evidence only for recipes that declare it.
- `app/fabric/runtime_workspace.py`: retain Git inspection implementation behind its current interface.
- `tests/fabric_workspace_gating_test.py`: prove OCR/local settings do not call Git and Agent handoff does.
- `scripts/benchmark_runtime_snapshot.py`: record cold/warm request and process-count evidence.

## Task 1: Separate capture evidence from target feedback

**Files:**

- Modify: `scripts/selection_snapshot_bridge.py`
- Modify: `tests/selection_snapshot_bridge_test.py`

- [ ] **Step 1: Write the failing visual-fallback geometry test**

Replace the old assertion that equates `selection_bbox` with the 640 x 420 crop. Assert three independent facts:

```python
snapshot = payload["selectionSnapshot"]
context = snapshot["context"]
artifacts = context["artifacts"]

assert snapshot["capture_bbox"] == [280, 290, 920, 710]
assert snapshot["selection_bbox"] == [592, 492, 608, 508]
assert artifacts["capture_bbox"] == [280, 290, 920, 710]
assert artifacts["capture_bbox_coordinate_space"] == "physical_screen_pixels"
assert artifacts["selection_rectangles"] == [[592, 492, 16, 16]]
assert artifacts["selection_rectangles_coordinate_space"] == "physical_screen_pixels"
assert artifacts["selection_geometry_kind"] == "pointer_anchor"
```

Also assert that `capture_bbox` and `selection_bbox` are unequal so a later refactor cannot silently recombine them.

- [ ] **Step 2: Run the focused test and verify the old contract fails**

Run:

```powershell
python -m pytest tests/selection_snapshot_bridge_test.py::test_unsupported_foreground_becomes_local_visual_object_at_pointer -q
```

Expected: FAIL because the current snapshot uses `[280, 290, 920, 710]` as both capture and target geometry and omits coordinate-space fields.

- [ ] **Step 3: Add explicit rectangle helpers**

Add pure helpers near `_normalized_point`:

```python
POINTER_ANCHOR_SIZE = 16


def _pointer_anchor_ltrb(point: dict[str, int]) -> list[int]:
    radius = POINTER_ANCHOR_SIZE // 2
    return [point["x"] - radius, point["y"] - radius,
            point["x"] + radius, point["y"] + radius]


def _ltrb_to_xywh(rect: list[int] | tuple[int, int, int, int]) -> list[int]:
    left, top, right, bottom = (int(value) for value in rect)
    if right <= left or bottom <= top:
        raise ValueError("rectangle must have positive area")
    return [left, top, right - left, bottom - top]
```

The helpers deliberately preserve the Python/Fabric `bbox` convention as LTRB while producing the Stage artifact convention as XYWH.

- [ ] **Step 4: Emit distinct geometry in the visual context**

When `visual is not None`, compute:

```python
pointer_anchor = _pointer_anchor_ltrb(normalized_target_point)
```

Then emit:

```python
"artifacts": {
    "capture_path": visual["path"],
    "annotated_path": visual["annotated_path"],
    "capture_bbox": visual["bbox"],
    "capture_bbox_coordinate_space": "physical_screen_pixels",
    "selection_rectangles": [_ltrb_to_xywh(pointer_anchor)],
    "selection_rectangles_coordinate_space": "physical_screen_pixels",
    "selection_geometry_kind": "pointer_anchor",
},
```

At snapshot level set `capture_bbox` to `visual["bbox"]` and `selection_bbox` to `pointer_anchor`. Do not change the image crop passed to Pillow.

- [ ] **Step 5: Verify the Python geometry contract**

Run:

```powershell
python -m pytest tests/selection_snapshot_bridge_test.py -q
```

Expected: all tests PASS; the captured file remains 640 x 420, the 16 x 16 pointer anchor remains internal evidence, and Stage renders nothing until a target resolves.

## Task 2: Deepen coordinate conversion into GroundingGeometry

**Files:**

- Modify: `electron/coordinate_space.js`
- Modify: `tests/coordinate_space_test.js`
- Create: `tests/grounding_geometry_integration_test.js`

- [ ] **Step 1: Write failing interface tests**

Extend `tests/coordinate_space_test.js` with:

```javascript
const {
  physicalScreenPoint,
  normalizeGroundingGeometry,
} = require('../electron/coordinate_space');

const geometry = normalizeGroundingGeometry({
  pointer: { x: -1320, y: 300 },
  pointerSpace: 'physical_screen_pixels',
  targetRects: [{ x: -1330, y: 286, width: 160, height: 28 }],
  targetSpace: 'physical_screen_pixels',
  captureRect: { x: -1500, y: 120, width: 640, height: 420 },
  captureSpace: 'physical_screen_pixels',
  stageBounds: { x: -880, y: 0, width: 880, height: 1440 },
  screenApi: mixedDpiScreen,
});

assert.strictEqual(geometry.state, 'resolved');
assert.deepStrictEqual(geometry.capturePhysicalRect,
  { x: -1500, y: 120, width: 640, height: 420 });
assert.notDeepStrictEqual(geometry.stageTarget, geometry.capturePhysicalRect);
assert.deepStrictEqual(geometry.stageTarget,
  { x: -440, y: 191, width: 107, height: 19 });
```

Add invalid-space, non-finite, zero-area, and pointer-only cases. A missing/unknown coordinate declaration must produce `state: 'invalid'`, not a guessed conversion.

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
node tests/coordinate_space_test.js
```

Expected: FAIL because `normalizeGroundingGeometry` is not exported.

- [ ] **Step 3: Implement the deep module interface**

Implement and export pure helpers inside `electron/coordinate_space.js`:

```javascript
function finiteRect(value) { /* return {x,y,width,height} or null */ }
function physicalRectToDip(screenApi, rect) { /* screenToDipRect(null, rect) */ }
function relativeRect(rect, stageBounds) { /* subtract stage x/y */ }
function normalizeGroundingGeometry(input) { /* enforce declared spaces */ }
```

Rules:

- `targetSpace` and `captureSpace` accept only `physical_screen_pixels` at the external bridge seam.
- Convert each target rect separately; never union capture and target.
- Derive `stageTarget` from the target rect nearest the DIP pointer.
- If there is no target rect but the physical pointer is valid, return a 16 x 16 pointer-only Stage target and `state: 'pointer_only'`.
- Return immutable plain data; never call Electron window APIs from this module.

- [ ] **Step 4: Add bridge-to-Stage integration coverage**

Create `tests/grounding_geometry_integration_test.js` with one structured target and one visual fallback payload. Assert:

```javascript
assert.strictEqual(structured.state, 'resolved');
assert.strictEqual(pointerOnly.state, 'pointer_only');
assert(pointerOnly.capturePhysicalRect.width > pointerOnly.stageTarget.width);
assert(pointerOnly.capturePhysicalRect.height > pointerOnly.stageTarget.height);
```

- [ ] **Step 5: Run both tests**

Run:

```powershell
node tests/coordinate_space_test.js
node tests/grounding_geometry_integration_test.js
```

Expected: both print their success line and exit 0.

## Task 3: Route Stage projection through GroundingGeometry

**Files:**

- Modify: `electron/main.js`
- Modify: `electron/renderer/stage.js`
- Modify: `electron/renderer/stage.css`
- Modify: `tests/stage_display_static_test.js`
- Modify: `tests/selection_visual_contract_test.js`

- [ ] **Step 1: Replace static-string expectations with observable geometry behavior where possible**

Keep one supplemental wiring assertion, but make the contract assert that main imports `normalizeGroundingGeometry` and that `stageTargetForSession` returns the module's `stageTarget` plus a `targetGeometryKind`.

- [ ] **Step 2: Run the Stage contract tests and verify they fail**

Run:

```powershell
node tests/stage_display_static_test.js
node tests/selection_visual_contract_test.js
```

Expected: FAIL on the new GroundingGeometry wiring assertions.

- [ ] **Step 3: Replace `panelGeometryForSession` ad hoc conversion**

In `electron/main.js`, build one module input from:

```javascript
{
  pointer: entry?.snapshot?.target_point || entry?.physicalCursor,
  pointerSpace: entry?.snapshot?.target_point_space,
  targetRects: artifacts.selection_rectangles,
  targetSpace: artifacts.selection_rectangles_coordinate_space,
  captureRect: artifacts.capture_bbox,
  captureSpace: artifacts.capture_bbox_coordinate_space,
  stageBounds: placeStageOnDisplay(display).getBounds(),
  screenApi: screen,
}
```

Retain `entry.cursor` only for the initial Electron-DIP wake animation. Frozen geometry must come from snapshot evidence.

- [x] **Step 4: Keep pointer-only evidence invisible**

Send `targetGeometryKind: 'resolved' | 'pointer_only' | 'invalid'` to Stage. In `stage.js`, set `stageRoot.dataset.targetGeometryKind` and keep the gradient sweep only for resolved text/object rectangles. `pointer_only` and `invalid` render no target DOM surface; the Stage remains full-display, transparent, and click-through.

Add CSS under:

```css
.stage-root[data-target-geometry-kind='pointer_only'] .targeting-outline,
.stage-root[data-target-geometry-kind='pointer_only'] .frozen-glow { ... }
```

These selectors must use `display: none`. The internal pointer anchor may guide capture and capsule placement but must never become a visible box, dot, radial glow, or sweep band.

- [ ] **Step 5: Run focused Node tests**

Run:

```powershell
node tests/coordinate_space_test.js
node tests/grounding_geometry_integration_test.js
node tests/stage_display_static_test.js
node tests/selection_visual_contract_test.js
node tests/stage_state_test.js
```

Expected: all exit 0.

## Task 4: Measure real displayed-target alignment

**Files:**

- Modify: `scripts/verify_browser_selection_alignment.py`
- Modify: `tests/fixtures/selection_alignment.html`
- Create: `tests/selection_alignment_evidence_test.py`

- [ ] **Step 1: Add a failing evidence-schema test**

Define the required evidence fields:

```python
required = {
    "targetPointPhysical",
    "domTargetRectPhysical",
    "adapterTargetRectPhysical",
    "stageTargetDip",
    "projectedStageTargetPhysical",
    "edgeErrorDip",
    "coordinateTransforms",
    "screenshot",
}
assert required <= evidence.keys()
assert max(evidence["edgeErrorDip"].values()) <= 2.0
```

- [ ] **Step 2: Extend the verifier**

Have the fixture return its target DOM rectangle. Convert it to physical pixels using the same browser-window mapping already used for the pointer. Feed adapter rectangles through `normalizeGroundingGeometry` by invoking a small Node subprocess with JSON stdin. Project the Stage DIP target back to physical pixels and calculate left/top/right/bottom error.

Draw two colors on the evidence screenshot:

- green: DOM/adapter evidence target;
- magenta: projected Stage target.

The screenshot must show the two outlines overlapping.

- [ ] **Step 3: Run the real browser verification**

Run:

```powershell
python scripts/verify_browser_selection_alignment.py
```

Expected: exit 0 and `data/runtime/selection-alignment-20260729/evidence.json` with `passed: true` and maximum edge error <= 2 DIP.

- [ ] **Step 4: Repeat at available Windows scales**

Run the verifier at 100%, 125%, 150%, and 200% when those display modes are available. If the current host cannot change scale non-destructively, record only the current scale as verified and mark the others `blocked: display_mode_unavailable`; do not label them passed.

## Task 5: Add RuntimeSnapshot cache and single-flight semantics

**Files:**

- Create: `electron/runtime_snapshot.js`
- Create: `electron/runtime_probes.js`
- Create: `tests/runtime_snapshot_test.js`

- [ ] **Step 1: Write failing cache/generation tests**

Use injected clocks/probes:

```javascript
const runtime = new RuntimeSnapshot({
  clock: () => now,
  ttlMs: 5000,
  probe: async ({ generation }) => ({ generation, readiness: { state: 'ready' } }),
});

const [left, right] = await Promise.all([runtime.get(), runtime.get()]);
assert.strictEqual(probeCalls, 1);
assert.deepStrictEqual(left, right);

runtime.invalidate('settings_changed');
await runtime.get();
assert.strictEqual(probeCalls, 2);
```

Also prove that a slow generation-1 result cannot replace generation 2 and that a failed refresh returns a typed degraded snapshot rather than throwing into the renderer.

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
node tests/runtime_snapshot_test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the RuntimeSnapshot interface**

Implement:

```javascript
class RuntimeSnapshot {
  constructor({ probe, clock = Date.now, ttlMs = 5000 }) { ... }
  invalidate(reason) { ... }
  async get({ force = false } = {}) { ... }
}
```

The returned schema must include `schemaVersion`, `capturedAt`, `generation`, `readiness`, `workers`, `models`, `permissions`, `capabilities`, `repairs`, and `diagnostics`. Cache only completed snapshots; share one in-flight promise per generation.

- [ ] **Step 4: Implement owned local probes**

`electron/runtime_probes.js` should compose existing preflight, Python runtime, voice runtime, permission, and settings evidence. Every probe returns `{state, evidence, repairAction}` and has an explicit timeout. It must not launch a model inference or access the network during Dashboard bootstrap.

- [ ] **Step 5: Run the module tests**

Run:

```powershell
node tests/runtime_snapshot_test.js
```

Expected: success line, exit 0.

## Task 6: Make capability availability executable and honest

**Files:**

- Create: `app/fabric/capability_snapshot.py`
- Create: `tests/capability_snapshot_test.py`
- Modify: `scripts/electron_bridge.py`

- [ ] **Step 1: Write capability-state tests**

Cover at minimum:

```python
assert snapshot.by_id("copy_text").state == "ready"
assert snapshot.by_id("local_voice").state == "needs_setup"
assert snapshot.by_id("agent_fix").state == "needs_agent"
assert snapshot.by_id("vision_click").state == "experimental"
assert snapshot.by_id("macos_ax").state == "unavailable"
```

Each state must include evidence and, where applicable, a typed repair action.

- [ ] **Step 2: Verify the tests fail**

Run:

```powershell
python -m pytest tests/capability_snapshot_test.py -q
```

Expected: import/module failure.

- [ ] **Step 3: Implement the snapshot builder**

Define immutable dataclasses:

```python
@dataclass(frozen=True)
class CapabilityStatus:
    id: str
    state: Literal["ready", "needs_setup", "needs_agent", "experimental", "blocked", "unavailable"]
    reason: str
    evidence: dict[str, Any]
    repair_action: dict[str, Any] | None = None
```

Build state from registered recipe/provider, dependency readiness, required permissions, platform, experimental flag, and whether a receipt verifier exists. A configured provider without a verifier cannot be `ready`.

- [ ] **Step 4: Add one bridge request**

Add `mode == "runtime_snapshot"` to `scripts/electron_bridge.py`. Return preflight plus `CapabilitySnapshot` in one JSON response. This request must not collect Git diff or launch a model.

- [ ] **Step 5: Run focused Python tests**

Run:

```powershell
python -m pytest tests/capability_snapshot_test.py tests/fabric_capabilities_test.py -q
```

Expected: all pass.

## Task 7: Replace Dashboard startup fan-out with one bootstrap snapshot

**Files:**

- Modify: `electron/main.js`
- Modify: `electron/preload.js`
- Modify: `electron/renderer/dashboard.js`
- Create: `tests/dashboard_runtime_snapshot_static_test.js`

- [ ] **Step 1: Write supplemental wiring and request-count tests**

Assert one preload method, one IPC handler, and one Dashboard boot request. Add an injected Dashboard harness that counts Fabric calls before first paint; expected count is 1.

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
node tests/dashboard_runtime_snapshot_static_test.js
```

Expected: FAIL because Dashboard still starts multiple independent requests.

- [ ] **Step 3: Wire the one-call interface**

Expose:

```javascript
runtimeSnapshot: {
  get: (options) => ipcRenderer.invoke('runtime-snapshot:get', options),
  onChanged: (listener) => subscribe('runtime-snapshot:changed', listener),
}
```

Main owns `RuntimeSnapshot`; settings saves, worker state changes, permission changes, display topology changes, and model install/remove call `invalidate(reason)`.

- [ ] **Step 4: Render from snapshot truth**

Dashboard first paint consumes the snapshot for readiness, models, workers, permissions, capability cards, diagnostics, and repair actions. Activity/history may lazy-load only when the user enters that page. Remove the 2.5-second multi-request poll; use typed events plus a low-frequency refresh only while Activity is visible.

- [ ] **Step 5: Verify startup request count**

Run:

```powershell
node tests/dashboard_runtime_snapshot_static_test.js
node tests/dashboard_settings_center_static_test.js
node tests/preflight_checks_test.js
```

Expected: all exit 0; Dashboard bootstrap request count is 1.

## Task 8: Gate Git workspace evidence by recipe declaration

**Files:**

- Modify: `app/fabric/recipes.py`
- Modify: `app/fabric/engine.py`
- Create: `tests/fabric_workspace_gating_test.py`

- [ ] **Step 1: Write failing call-count tests**

Inject a counting workspace resolver. Prove:

```python
engine.plan("copy visible text", local_packet)
assert resolver.calls == 0

engine.plan("send this error to the coding agent", agent_packet)
assert resolver.calls == 1
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
python -m pytest tests/fabric_workspace_gating_test.py -q
```

Expected: the local recipe currently calls the workspace resolver.

- [ ] **Step 3: Add a recipe declaration**

Use one explicit boolean field:

```python
needs_workspace_evidence: bool = False
```

Set it only for coding-Agent handoff, repo issue, and other recipes whose output explicitly consumes branch/diff/process binding evidence.

- [ ] **Step 4: Move resolution after recipe selection**

In `FabricEngine.plan`, select/resolve the recipe first. Call `RuntimeWorkspaceResolver` only when `recipe.needs_workspace_evidence` is true. Do not create a generic lazy proxy or pass the resolver to every recipe.

- [ ] **Step 5: Verify behavior and latency**

Run:

```powershell
python -m pytest tests/fabric_workspace_gating_test.py tests/fabric_engine_test.py -q
```

Expected: tests pass; the local OCR plan does not invoke Git.

## Task 9: Produce performance and desktop evidence

**Files:**

- Create: `scripts/benchmark_runtime_snapshot.py`
- Modify: `scripts/verify_stage_selection_visual.py`
- Create: `data/runtime/grounding-runtime-truth-20260729/evidence.json` (generated)

- [ ] **Step 1: Implement the benchmark harness**

Measure at least 30 warm requests after 3 warmups. Record P50/P95/P99, child-process count, repository dirty/clean context, Python runtime path, display topology, DPI scale, and commit hash. Separate:

- runtime snapshot warm latency;
- local OCR plan overhead excluding inference;
- coding-Agent plan with workspace evidence;
- Dashboard bootstrap process count.

- [ ] **Step 2: Run visual evidence capture**

Run:

```powershell
python scripts/verify_stage_selection_visual.py
python scripts/verify_browser_selection_alignment.py
```

Expected: screenshots and JSON evidence show no pointer-only target feedback and an exact structured target. No screenshot may show a 640 x 420 selection band or any pointer box/dot.

- [ ] **Step 3: Run performance evidence**

Run:

```powershell
python scripts/benchmark_runtime_snapshot.py
```

Expected gates:

- warm RuntimeSnapshot P50 <= 80 ms, P95 <= 180 ms;
- local non-workspace recipe performs zero Git probes;
- Dashboard bootstrap creates at most one Python child;
- structured target edge error <= 2 DIP on verified display scales.

If a gate fails, keep the evidence and return to the owning task. Do not lower the threshold to make the run green.

## Task 10: Verification, commit, and push

**Files:**

- All files modified by Tasks 1-9
- Generated evidence under `data/runtime/grounding-runtime-truth-20260729/`

- [ ] **Step 1: Run focused suites**

```powershell
node tests/coordinate_space_test.js
node tests/grounding_geometry_integration_test.js
node tests/runtime_snapshot_test.js
node tests/dashboard_runtime_snapshot_static_test.js
python -m pytest tests/selection_snapshot_bridge_test.py tests/browser_selection_contract_test.py tests/capability_snapshot_test.py tests/fabric_workspace_gating_test.py -q --basetemp .pytest-grounding-runtime-truth
```

Expected: all exit 0.

- [ ] **Step 2: Run full Node suite**

```powershell
npm test
```

Expected: exit 0 with the exact source/test count printed by `scripts/run-node-tests.js`.

- [ ] **Step 3: Run full Python suite with an isolated base temp**

```powershell
python -m pytest -q --basetemp .pytest-grounding-runtime-truth-full
```

Expected: exit 0. If the known Fabric test hangs, capture the exact test and stack/process evidence; do not report the suite as passed.

- [ ] **Step 4: Run release-relevant checks**

```powershell
git diff --check
npm run dist:win
npm run verify:package
```

Expected: no whitespace errors; NSIS build and package verification exit 0. Line-ending warnings are not whitespace failures but should be recorded.

- [ ] **Step 5: Review scope and secrets**

```powershell
git status --short
git diff --stat
git diff --name-only
rg -n "api[_-]?key|secret|token|password" docs electron app scripts tests --glob '!**/*.jsonl'
```

Inspect every candidate hit. Do not stage credentials, local user data, temporary profiles, model files, or unsigned third-party binaries.

- [ ] **Step 6: Commit the verified milestone**

```powershell
git add -- <explicit verified file list>
git commit -m "fix: make pointer grounding and runtime readiness truthful"
```

Expected: one commit on `main` containing the recovered research notes, design/plan, implementation, tests, and intentional evidence only. Existing unrelated user files remain unstaged.

- [ ] **Step 7: Push main**

```powershell
git push origin main
```

Expected: remote `main` advances to the new commit. Report the commit hash, exact test results, evidence paths, and any blocked DPI/macOS/package checks.

## Follow-on plans after this slice

Create these only after Task 10 is green:

1. `2026-07-29-worker-lifecycle-and-clean-machine-release.md`
2. `2026-07-29-dashboard-six-domain-settings.md`
3. `2026-07-29-officecli-typed-adapter.md`
4. `2026-07-29-out-of-process-extension-host.md`
5. `2026-07-29-macos-ax-grounding.md`

Each must use the interfaces established here rather than adding parallel readiness, coordinate, permission, or receipt models.

The Dashboard follow-on plan must treat the six domains as non-collapsing group labels, retain every detailed page as a direct sidebar row, and implement the user-supplied Codex reference: bounded centered content column, grouped row surfaces, field-level search, and an Extensions page with `Extensions / Applications / MCP / Skills` tabs plus row-level readiness, permissions, and repair actions.
