# Google-Style Semantic Sweep Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reproduce the blue sweep itself from demo 7: a translucent line-height body, very thin luminous core, broad low-saturation feathered halo, faded tail edge, and a concentrated cursor-side head—without the painted-marker look of the current three Canvas strokes.

**Architecture:** Keep pointer capture, payload, and Electron input ownership unchanged. Replace only the visual compositor with one local WebGL2 SDF pass whose pixel model is explicit and testable. Geometry stabilization and speed response exist only to make the band look like the reference; they are not a new product subsystem. Keep a small Canvas2D fallback for machines where WebGL2 is unavailable.

**Tech Stack:** Electron, browser JavaScript, WebGL2/GLSL ES 3.0, Canvas2D fallback, Node test runner, Python/Pillow visual verification.

---

## Scope guardrails

- Change only the live gesture drawing visual and its direct lifecycle integration.
- Preserve the current full-screen overlay input model and `gesture-ready` handshake.
- Preserve `kind`, `semanticPoint`, physical-display conversion, and multi-stroke payloads.
- Do not add image assets: the effect is procedural and must scale across DPI/display sizes.
- Do not introduce a continuously running background agent or a per-pointer-move UIA subprocess.
- Do not send screenshots or visual data to any remote model.

## Task 1: Lock the blue-line visual DNA with failing tests

**Files:**

- Create: `tests/sweep_dynamics_test.js`
- Modify: `tests/overlay_static_test.js`
- Modify: `tests/selection_visual_contract_test.js`

- [ ] Assert the shader has separate body, sub-2 DIP core, 10–20 DIP Gaussian halo, directional tail ramp, and cursor-head Gaussian.
- [ ] Assert reference-scale tuning keeps the opaque body near a text row while the low-alpha envelope is substantially wider.
- [ ] Assert horizontal jitter is visually stabilized without mutating payload points.
- [ ] Assert a stationary redraw is stateless and cannot accumulate alpha.
- [ ] Assert the overlay loads a dedicated sweep canvas/script and routes `demo6_band` through it.
- [ ] Run the focused tests and confirm the new assertions fail for the intended missing behavior.

Command:

```powershell
node --test tests/sweep_dynamics_test.js tests/overlay_static_test.js tests/selection_visual_contract_test.js
```

## Task 2: Implement reference-derived sweep geometry

**Files:**

- Create: `electron/renderer/sweep_visual.js`
- Test: `tests/sweep_dynamics_test.js`

- [ ] Export testable style constants and a geometry function through UMD/CommonJS.
- [ ] Convert a drag into a start/end band with an inferred stable centerline; never mutate semantic payload points.
- [ ] Keep the start-side alpha feathered and the cursor side strongest.
- [ ] Bound all dimensions in DIP so the look survives DPI changes.
- [ ] Re-run the visual-model tests until green.

## Task 3: Implement the WebGL2 SDF renderer and Canvas fallback

**Files:**

- Create: `electron/renderer/sweep_gl_renderer.js`
- Modify: `electron/renderer/index.html`
- Modify: `electron/renderer/styles.css`
- Test: `tests/overlay_static_test.js`

- [ ] Add `#sweep-layer` beneath the existing marker/runtime-capture canvas.
- [ ] Create a transparent premultiplied-alpha WebGL2 context.
- [ ] Render oriented capsules analytically in a fragment shader: thin blue-white core, low-opacity broad halo, directional tail falloff, and cursor-coupled head bloom.
- [ ] Use premultiplied `ONE, ONE_MINUS_SRC_ALPHA` blending to avoid dark/boxed edges.
- [ ] Render only while drawing or fading; bound active/committed segments.
- [ ] Handle WebGL context loss and initialization failure with a Canvas2D renderer using the same frame-state contract.
- [ ] Keep the native/CSS armed cursor as the only pointer glyph; the shader draws light beneath it, not a second cursor.

## Task 4: Integrate the sweep into the real overlay lifecycle

**Files:**

- Modify: `electron/renderer/overlay.js`
- Test: `tests/overlay_static_test.js`
- Test: `tests/gesture_activation_integration_test.js`
- Test: `tests/gesture_runtime_settings_test.js`

- [ ] Instantiate dynamics and renderer without changing overlay readiness/input ownership.
- [ ] Feed raw, coalesced, and browser-predicted pointer events to visual dynamics.
- [ ] Keep the existing filtered `points` array as the only semantic payload source.
- [ ] On pointer down, start the energy head without an oversized stationary bloom.
- [ ] On move, render velocity tail and semantic magnetism in animation frames.
- [ ] On pointer up, freeze briefly, fade rapidly, and retain committed multi-stroke state at reduced emphasis until chain completion.
- [ ] Clear the sweep layer before screenshots/runtime captures, on cancel, resize, and reset.
- [ ] Preserve numbered markers and the existing gesture completion/cancel protocol.
- [ ] Keep `demo6_band` as the backward-compatible setting value while changing its implementation to the semantic sweep; keep `thin` on the legacy/fallback path.

## Task 5: Add a real visual regression harness

**Files:**

- Create: `tests/fixtures/live_sweep_visual.html`
- Create: `scripts/verify_live_sweep_visual.py`
- Create at runtime: `data/runtime/live_sweep_visual/*`

- [ ] Drive a jittered horizontal pointer sequence through the same renderer contract.
- [ ] Capture frames at rest, slow motion, fast motion, release hold, and fade completion.
- [ ] Measure that fast motion produces a longer tail than slow motion.
- [ ] Measure that semantic-lock centerline variance is lower than raw input variance.
- [ ] Measure that the vertical envelope is bounded and no rectangular backing-store ghost remains after fade.
- [ ] Save a contact sheet as delivery evidence and inspect it visually.

Command:

```powershell
python scripts/verify_live_sweep_visual.py
```

## Task 6: Regression, performance, and documentation

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `AGENT.md`

- [ ] Document the renderer separation, semantic-guide contract, and the prohibition against merging visual prediction into payload geometry.
- [ ] Run focused tests, the visual verifier, the full Node suite, lint, and whitespace checks.
- [ ] Confirm the renderer is idle when no gesture/fade is active and no remote API receives pixels.
- [ ] Inspect the final contact sheet against demo 7: narrow luminous core, broad soft halo, leading cursor energy, short-lived tail, and no pause-time ink buildup.

Commands:

```powershell
npm test
npm run lint
git diff --check
```

## Acceptance criteria

- The visual reads as a transient object sweep, not a painted polyline.
- The cursor is visibly the leading energy source and the tail changes with speed.
- Horizontal text/control gestures are stable despite hand jitter; curved gestures remain curved.
- Release settles and disappears quickly without rectangular blur artifacts.
- Multi-stroke selection, overlay mouse ownership, payload coordinates, and semantic metadata remain unchanged.
- The effect is generated locally with no screenshot upload and no external visual-model dependency.
