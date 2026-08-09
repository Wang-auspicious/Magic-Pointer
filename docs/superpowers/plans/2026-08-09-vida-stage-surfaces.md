# Vida-inspired Stage Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository explicitly forbids subagents, so execute inline.

**Goal:** Make Magic Pointer's capsule, adaptive process sheet, completion card, and preview tiles reproduce Vida's useful visual hierarchy and motion without copying its branding or rainbow progress treatment.

**Architecture:** Extend the existing pure `StageAnchor` policy with adaptive edge docking, then let the classic stage renderer consume the placement result through datasets and CSS variables. Keep behavior in the existing Stage state machine; CSS owns compositor-safe motion, while the shared card renderer continues to own structured result content.

**Tech Stack:** Electron 43, classic renderer JavaScript, CSS, Node `assert` tests, existing screenshot fixture.

---

### Task 1: Adaptive edge placement policy

**Files:**
- Modify: `electron/stage_anchor.js`
- Modify: `tests/stage_anchor_test.js`

- [ ] **Step 1: Write the failing placement tests**

Import `chooseAdaptivePanelAnchor` and assert these exact contracts:

```js
assert.deepStrictEqual(chooseAdaptivePanelAnchor({
  source: { x: 80, y: 70, width: 700, height: 650 },
  focus: { x: 500, y: 300, width: 120, height: 60 },
  surface: { width: 360, height: 500 },
  viewport: { width: 1440, height: 900 },
}), { x: 788, y: 78, side: 'right', mode: 'outside' });

assert.deepStrictEqual(chooseAdaptivePanelAnchor({
  source: { x: 420, y: 70, width: 900, height: 650 },
  focus: { x: 860, y: 300, width: 120, height: 60 },
  surface: { width: 360, height: 500 },
  viewport: { width: 1440, height: 900 },
}), { x: 52, y: 78, side: 'left', mode: 'outside' });

assert.strictEqual(chooseAdaptivePanelAnchor({
  source: { x: 0, y: 0, width: 1440, height: 900 },
  focus: { x: 1100, y: 300, width: 140, height: 80 },
  surface: { width: 380, height: 620 },
  viewport: { width: 1440, height: 900 },
}).side, 'left');
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node tests/stage_anchor_test.js`

Expected: failure because `chooseAdaptivePanelAnchor` is not exported.

- [ ] **Step 3: Implement the minimal pure policy**

Add a function that computes left/right exterior gutters, respects `preferredSide` when it still fits, falls back to the screen edge farthest from `focus`, clamps Y to `edge`, and returns `{x, y, side, mode}`. Export it from both CommonJS and `globalThis.StageAnchor`.

- [ ] **Step 4: Run the placement tests and verify GREEN**

Run: `node tests/stage_anchor_test.js`

Expected: `stage anchor test ok`.

- [ ] **Step 5: Commit**

```powershell
git add electron/stage_anchor.js tests/stage_anchor_test.js
git commit -m "feat: add adaptive stage edge placement"
```

### Task 2: Bind the stage panel to adaptive placement

**Files:**
- Modify: `electron/renderer/stage.js`
- Modify: `tests/stage_static_test.js`
- Modify: `tests/stage_hit_region_transition_test.js`

- [ ] **Step 1: Write failing renderer contract tests**

Require `anchor.chooseAdaptivePanelAnchor`, a stable `session.panelPlacement`, `threadPanel.dataset.side`, and `threadPanel.dataset.placementMode`. Assert the old `answerShape.shape === 'deliver'` placement gate is absent so inspect and deliver panels share the policy.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node tests/stage_static_test.js; node tests/stage_hit_region_transition_test.js`

Expected: failure on missing adaptive placement binding.

- [ ] **Step 3: Replace the side-placement branch**

Initialize `panelPlacement: null` in session state. In `anchorThreadToCapsule()`, call:

```js
const placement = anchor.chooseAdaptivePanelAnchor({
  source: session.targetWindowRect,
  focus: isUsableTargetRect(state.target) ? state.target : session.pointer,
  surface: { width, height },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  preferredSide: session.panelPlacement?.side,
});
session.panelPlacement = placement;
threadPanel.style.left = `${placement.x}px`;
threadPanel.style.top = `${placement.y}px`;
threadPanel.dataset.side = placement.side;
threadPanel.dataset.placementMode = placement.mode;
```

Keep the existing manual-drag return first. Clear `panelPlacement` only when a new selection session begins.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node tests/stage_static_test.js; node tests/stage_hit_region_transition_test.js`

- [ ] **Step 5: Commit**

```powershell
git add electron/renderer/stage.js tests/stage_static_test.js tests/stage_hit_region_transition_test.js
git commit -m "feat: dock stage panels into available space"
```

### Task 3: Replace rainbow processing and refine shell motion

**Files:**
- Modify: `electron/renderer/stage.html`
- Modify: `electron/renderer/stage.css`
- Modify: `electron/renderer/stage.js`
- Modify: `tests/stage_static_test.js`
- Modify: `tests/stage_accent_token_test.js`

- [ ] **Step 1: Write failing visual-contract tests**

Assert `.processing-shimmer` contains no green/orange/pink/blue multi-stop gradient, requires `--stage-process-ink`, requires a single `::after` activity dot, and requires edge-specific `transform-origin` rules plus staged child delays. Assert the done eyebrow text becomes `TASK FINISHED`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/stage_static_test.js; node tests/stage_accent_token_test.js`

- [ ] **Step 3: Implement the neutral processing state**

Use a neutral wash and one ink dot:

```css
.processing-shimmer {
  background: linear-gradient(90deg, transparent, rgba(22, 24, 29, .08), transparent);
  filter: none;
  animation: stage-ink-wash 1.6s cubic-bezier(.45, 0, .55, 1) infinite;
}
.processing-shimmer::after {
  content: '';
  position: absolute;
  right: 13px;
  top: 50%;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #16181d;
  animation: stage-ink-pulse 1.2s ease-in-out infinite;
}
```

Set edge-dependent transform origins. Shorten shell motion to 260ms and stagger `.thread-head`, `.stage-result`, and `.thread-bar`/`.capsule-consent` by 40/70/110ms through opacity/transform animations. Preserve reduced-motion rules.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node tests/stage_static_test.js; node tests/stage_accent_token_test.js`

- [ ] **Step 5: Commit**

```powershell
git add electron/renderer/stage.html electron/renderer/stage.css electron/renderer/stage.js tests/stage_static_test.js tests/stage_accent_token_test.js
git commit -m "feat: refine stage motion and processing feedback"
```

### Task 4: Make completion and preview cards Vida-like

**Files:**
- Modify: `electron/renderer/stage.css`
- Modify: `electron/renderer/cards.css`
- Modify: `electron/renderer/card_render.js`
- Modify: `tests/card_render_test.js`
- Modify: `tests/stage_static_test.js`

- [ ] **Step 1: Write failing card contracts**

Require a responsive three-column `.mprev-folders`/`.mprev-files` grid, at most nine rendered preview items, per-item stagger indices, adaptive completion widths, and a compact/wide shape dataset derived without changing card content.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node tests/card_render_test.js; node tests/stage_static_test.js`

- [ ] **Step 3: Implement the card system**

Slice preview items to nine and expose `--tile-index` on each item. Replace flex previews with:

```css
.mprev-folders,
.mprev-files {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.mfolder,
.mfile {
  width: auto;
  min-width: 0;
  padding: 10px 6px 8px;
  border: 1px solid var(--hairline);
  border-radius: 10px;
  background: var(--card);
  animation-delay: calc(var(--tile-index) * 34ms);
}
```

Use 360/560/840 DIP completion width tiers selected from content length and card kind, clamped to the viewport. Keep the existing shared renderer and proposal actions.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node tests/card_render_test.js; node tests/stage_static_test.js`

- [ ] **Step 5: Commit**

```powershell
git add electron/renderer/stage.css electron/renderer/cards.css electron/renderer/card_render.js tests/card_render_test.js tests/stage_static_test.js
git commit -m "feat: refine completion and preview cards"
```

### Task 5: Visual evidence and full regression

**Files:**
- Modify: `scripts/capture_stage.js`
- Modify: `tests/selection_visual_contract_test.js`
- Modify: `AGENT.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Add deterministic capture scenes**

Extend `capture_stage.js` with a scene argument for `input`, `processing`, `dock-left`, `dock-right`, `fullscreen-left`, `compact-finished`, `wide-finished`, and `preview-grid`. Each scene must set only DOM state and must continue to identify itself as a layout fixture, not end-to-end acceptance.

- [ ] **Step 2: Capture and inspect all scenes**

Run each scene into `data/runtime/vida-stage-evidence`. Verify there is no rainbow strip, nested-card chrome, clipped text, horizontal scrollbar, off-screen button, or overlap with the fixture focus rectangle.

- [ ] **Step 3: Run complete verification**

```powershell
npm test
python -m pytest -q --basetemp=data/runtime/pytest-tmp-vida-stage
npm run lint
npm run typecheck
npm run build:electron
$env:MAGIC_POINTER_VERIFY_SOURCE_ENTRY='1'; python scripts/verify_gesture_activation_visual.py
```

Expected: Node 146+ tests pass, Python 1073+ tests pass, lint/typecheck/build exit 0, and desktop gesture evidence reports `passed: true`.

- [ ] **Step 4: Update durable documentation**

Record the adaptive placement rule, neutral processing treatment, completion-card tiers, preview grid, and exact verification counts. Explicitly warn that promotional full-screen blur is not part of the product interaction.

- [ ] **Step 5: Commit**

```powershell
git add scripts/capture_stage.js tests/selection_visual_contract_test.js AGENT.md CHANGELOG.md docs/STATUS.md docs/ROADMAP.md
git commit -m "docs: record Vida-inspired stage surfaces"
```

