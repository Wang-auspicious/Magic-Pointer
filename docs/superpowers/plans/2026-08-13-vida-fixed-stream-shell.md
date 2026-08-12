# Vida Fixed StreamShell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Vida-style processing panel keep one immutable outer rectangle while progress moves inside it, then hand off to a separate fixed completion receipt.

**Architecture:** Extend the pure Stage anchor policy with a session-scoped `PanelPlacement`, so renderer content can never influence outer geometry. Keep the processing shell and completion receipt as sibling DOM surfaces: the shell owns live progress and an internal scroller; the receipt owns the settled artifact and approval controls. Preserve the existing state machine, result renderers, target geometry, write-back lease, and neutral processing capsule.

**Tech Stack:** Electron renderer, TypeScript classic-script globals, CSS, Node `assert` tests, existing offscreen Stage screenshot harness.

---

## File map

- `electron/stage_anchor.ts`: pure creation, reuse, drag replacement, and viewport clamping of `PanelPlacement`.
- `electron/stage_stream_model.ts`: pure mapping from bridge phases to Project Memory, Refreshing, Fresh Verification, and Verified body pages.
- `electron/renderer/stage.html`: sibling StreamShell and DeliveryReceipt DOM contracts.
- `electron/renderer/stage.ts`: surface routing, frozen placement application, progress-page rendering, internal auto-scroll, and receipt interactions.
- `electron/renderer/stage.css`: fixed shell geometry, internal viewport, local row motion, receipt styling, and quiet Vida typography.
- `tests/stage_anchor_test.ts`: exact rectangle invariants across phases, sizes, sessions, drag, and viewport changes.
- `tests/stage_stream_model_test.ts`: page boundaries and page-local row selection.
- `tests/stage_static_test.js`: renderer/DOM/CSS regression guards for shell stability and separate receipt.
- `tests/stage_live_progress_test.js`: live progress remains in StreamShell and settlement moves to DeliveryReceipt.
- `docs/design/MAGIC_POINTER_HARNESS_20260811.md`: progress-ledger evidence after verification.

### Task 1: Freeze the process-panel rectangle in the pure anchor policy

**Files:**
- Modify: `tests/stage_anchor_test.ts`
- Modify: `electron/stage_anchor.ts`

- [ ] **Step 1: Write failing immutable-placement tests**

Add `chooseStablePanelPlacement` to the imports and cover first placement, same-session reuse despite requested-size changes, a replacement placement after drag, viewport clamping without side switching, and a fresh placement for a new session:

```ts
const firstPanelPlacement = chooseStablePanelPlacement({
  previous: null,
  sessionToken: 'session-a',
  source: { x: 80, y: 70, width: 700, height: 650 },
  focus: { x: 500, y: 300, width: 120, height: 60 },
  surface: { width: 406, height: 560 },
  viewport: { width: 1440, height: 900 },
});
assert.deepStrictEqual(firstPanelPlacement, {
  sessionToken: 'session-a', x: 788, y: 78, width: 406, height: 560,
  side: 'right', mode: 'outside', viewportWidth: 1440, viewportHeight: 900,
});
assert.strictEqual(chooseStablePanelPlacement({
  previous: firstPanelPlacement,
  sessionToken: 'session-a',
  source: { x: 0, y: 0, width: 1440, height: 900 },
  focus: { x: 20, y: 20, width: 100, height: 40 },
  surface: { width: 840, height: 120 },
  viewport: { width: 1440, height: 900 },
}), firstPanelPlacement);
```

- [ ] **Step 2: Run the focused test and observe the expected failure**

Run: `npx tsx tests/stage_anchor_test.ts`

Expected: FAIL because `chooseStablePanelPlacement` is not exported.

- [ ] **Step 3: Implement the minimal stable placement helper**

Add a `PanelPlacement` shape and a pure helper that returns the exact previous frozen object for the same token and viewport. On viewport change, preserve side/mode/size where possible and clamp `x/y/width/height`; on a new token, normalize requested size, call `chooseAdaptivePanelAnchor()` once, and freeze the full record:

```ts
function chooseStablePanelPlacement(input: StablePanelInput = {}): PanelPlacement {
  const token = input.sessionToken == null ? null : String(input.sessionToken);
  const previous = recordOf(input.previous) as PanelPlacement | null;
  const viewport = normalizeViewport(input.viewport);
  if (previous?.sessionToken === token
      && previous.viewportWidth === viewport.width
      && previous.viewportHeight === viewport.height) return previous;
  if (previous?.sessionToken === token) return Object.freeze(clampPanel(previous, viewport));
  const surface = normalizePanelSize(input.surface, viewport);
  const anchor = chooseAdaptivePanelAnchor({
    source: input.source, focus: input.focus, surface, viewport,
    preferredSide: input.preferredSide,
  });
  return Object.freeze({
    sessionToken: token, ...anchor, ...surface,
    viewportWidth: viewport.width, viewportHeight: viewport.height,
  });
}
```

Export the helper through `StageAnchor`.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `npx tsx tests/stage_anchor_test.ts && npm run typecheck`

Expected: PASS, then all four TypeScript projects typecheck successfully.

- [ ] **Step 5: Commit the geometry policy**

```bash
git add electron/stage_anchor.ts tests/stage_anchor_test.ts
git commit -m "fix: freeze stage panel placement per session"
```

### Task 2: Turn the running surface into a fixed StreamShell

**Files:**
- Modify: `tests/stage_static_test.js`
- Modify: `electron/renderer/stage.html`
- Modify: `electron/renderer/stage.ts`
- Modify: `electron/renderer/stage.css`

- [ ] **Step 1: Replace adaptive-width expectations with fixed-shell failures**

Update the static test to require:

```js
assert(html.includes('id="stream-viewport"'));
assert(html.includes('id="stream-scroller"'));
assert(source.includes('anchor.chooseStablePanelPlacement'));
assert(source.includes("threadPanel.style.setProperty('--stage-thread-width'"));
assert(source.includes("threadPanel.style.setProperty('--stage-thread-height'"));
assert(!source.includes('completionWidthTier('));
assert(!source.includes('threadPanel.getBoundingClientRect()'));
assert(!css.includes(".stage-thread[data-width-tier='wide']"));
assert.match(css, /\.stream-viewport\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
assert.match(css, /\.stream-scroller\s*\{[^}]*height:\s*100%[^}]*overflow-y:\s*auto/s);
assert(!css.includes('@keyframes stage-thread-finish'));
```

- [ ] **Step 2: Run the focused tests and observe the expected failures**

Run: `node tests/stage_static_test.js && npx tsx tests/stage_anchor_test.ts`

Expected: `stage_static_test.js` fails on missing fixed viewport/scroller contracts.

- [ ] **Step 3: Add the fixed viewport structure**

Wrap the existing result log without moving header or footer:

```html
<div id="stream-viewport" class="stream-viewport">
  <div id="stream-scroller" class="stream-scroller">
    <div id="stage-result" class="stage-result" role="log" aria-live="polite"></div>
  </div>
</div>
```

- [ ] **Step 4: Apply one frozen placement instead of measuring content**

Replace `placeThreadSurface()` with a constant-role-size implementation. It must call `chooseStablePanelPlacement`, store the returned full record, set left/top plus the two CSS variables, and never inspect result content dimensions:

```ts
const requested = {
  width: Math.min(406, Math.max(320, window.innerWidth - 16)),
  height: Math.min(560, Math.max(360, window.innerHeight - 16)),
};
session.panelPlacement = anchor.chooseStablePanelPlacement({
  previous: session.panelPlacement,
  sessionToken: session.token,
  source: isUsableTargetRect(session.targetWindowRect) ? session.targetWindowRect : null,
  focus,
  surface: requested,
  viewport: { width: window.innerWidth, height: window.innerHeight },
});
applyPanelPlacement(threadPanel, session.panelPlacement);
```

Remove `completionWidthTier`, `data-width-tier`, and the whole-shell finished transform. When dragging ends, replace `session.panelPlacement` with a frozen record containing the dragged `x/y` and unchanged geometry.

- [ ] **Step 5: Make only the body scroll**

Use fixed flex geometry and local overflow:

```css
.stage-thread {
  width: var(--stage-thread-width, 406px);
  height: var(--stage-thread-height, 560px);
  display: flex;
  flex-direction: column;
}
.stream-viewport { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.stream-scroller { height: 100%; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
.stage-result { padding: 0 24px 16px; max-height: none; overflow: visible; }
```

Change `newest.scrollIntoView()` to `streamScroller.scrollTo({ top: streamScroller.scrollHeight, behavior })`, using `auto` under reduced motion.

- [ ] **Step 6: Run focused tests, build, and commit**

Run: `node tests/stage_static_test.js && npx tsx tests/stage_anchor_test.ts && npm run typecheck && npm run build:electron`

Expected: all pass and the Electron runtime builds.

```bash
git add electron/renderer/stage.html electron/renderer/stage.ts electron/renderer/stage.css tests/stage_static_test.js
git commit -m "fix: keep the Vida stream shell stationary"
```

### Task 3: Model body-page replacement inside the fixed shell

**Files:**
- Create: `tests/stage_stream_model_test.ts`
- Create: `electron/stage_stream_model.ts`
- Modify: `electron/renderer/stage.html`
- Modify: `electron/renderer/stage.ts`
- Modify: `electron/renderer/stage.css`

- [ ] **Step 1: Write failing page-model tests**

Create a pure test that proves context phases stay on Project Memory, the first verification phase switches to Fresh Verification without retaining memory rows, and `verify`/`total` marks the page verified:

```ts
const assert = require('assert');
const { pageForSteps, rowsForPage } = require('../electron/stage_stream_model');

const memory = [
  { phase: 'payload_read', label: '收到了你要问的', state: 'done' },
  { phase: 'context_from_snapshot', label: '凑上下文', note: 'cache', state: 'done' },
];
assert.strictEqual(pageForSteps(memory), 'project-memory');
assert.deepStrictEqual(rowsForPage(memory).map((row: any) => row.phase),
  ['payload_read', 'context_from_snapshot']);

const fresh = [...memory, { phase: 'enrich_screen_region', label: '补屏幕上的信息', state: 'done' }];
assert.strictEqual(pageForSteps(fresh), 'fresh-verification');
assert.deepStrictEqual(rowsForPage(fresh).map((row: any) => row.phase), ['enrich_screen_region']);

const verified = [...fresh, { phase: 'verify', label: '回读确认', state: 'done' }];
assert.strictEqual(pageForSteps(verified), 'verified');
assert.deepStrictEqual(rowsForPage(verified).map((row: any) => row.phase),
  ['enrich_screen_region', 'verify']);
```

- [ ] **Step 2: Run the focused test and observe failure**

Run: `npx tsx tests/stage_stream_model_test.ts`

Expected: FAIL because `electron/stage_stream_model.ts` does not exist.

- [ ] **Step 3: Implement the pure page model**

Create a dual-export classic script. Memory ends at `context_from_snapshot`; fresh verification starts at `enrich_screen_region`; verified is a display state for the same fresh-page rows:

```ts
(() => {
  const FRESH_PHASES = new Set([
    'enrich_screen_region', 'route_recipe', 'model_request', 'model_response',
    'action_planned', 'action_executed', 'verify', 'total',
  ]);
  function phaseOf(step: any): string { return String(step?.phase || '').trim(); }
  function pageForSteps(steps: any[] = []): string {
    const phases = steps.map(phaseOf);
    if (phases.includes('verify') || phases.includes('total')) return 'verified';
    return phases.some((phase) => FRESH_PHASES.has(phase))
      ? 'fresh-verification' : 'project-memory';
  }
  function rowsForPage(steps: any[] = []): any[] {
    const page = pageForSteps(steps);
    return page === 'project-memory'
      ? steps.filter((step) => !FRESH_PHASES.has(phaseOf(step)))
      : steps.filter((step) => FRESH_PHASES.has(phaseOf(step)));
  }
  const StageStreamModel = Object.freeze({ pageForSteps, rowsForPage });
  if (typeof module !== 'undefined' && module.exports) module.exports = StageStreamModel;
  if (typeof globalThis !== 'undefined') (globalThis as any).StageStreamModel = StageStreamModel;
})();
```

- [ ] **Step 4: Load the page model and perform body-only replacement**

Load `../stage_stream_model.js` before `stage.js`. Add `data-page` to `#stream-viewport`. When `pageForSteps()` moves from `project-memory` to `fresh-verification`, set `data-page="refreshing"`, clear only `#stream-result`, then install the filtered fresh rows on the next animation frame. Header, shell, composer, and frozen placement must remain mounted.

```ts
const nextPage = streamModel.pageForSteps(card.steps || []);
if (streamViewport.dataset.page === 'project-memory' && nextPage !== 'project-memory') {
  streamViewport.dataset.page = 'refreshing';
  streamResult.replaceChildren();
  requestAnimationFrame(() => paintStreamPage(card, nextPage));
} else {
  paintStreamPage(card, nextPage);
}
```

- [ ] **Step 5: Add page-local transitions and reduced motion**

Animate only `.stream-page` and new rows. `refreshing` is an empty body state; it must not change outer geometry. Under reduced motion, remove page/row transforms and render synchronously.

- [ ] **Step 6: Run focused tests, build, and commit**

Run: `npx tsx tests/stage_stream_model_test.ts && node tests/stage_static_test.js && npm run typecheck && npm run build:electron`

Expected: all pass and the browser-global script is present in the build.

```bash
git add electron/stage_stream_model.ts electron/renderer/stage.html electron/renderer/stage.ts electron/renderer/stage.css tests/stage_stream_model_test.ts tests/stage_static_test.js
git commit -m "feat: page Vida progress inside the fixed shell"
```

### Task 4: Separate live progress from the settled DeliveryReceipt

**Files:**
- Modify: `tests/stage_live_progress_test.js`
- Modify: `tests/stage_static_test.js`
- Modify: `electron/renderer/stage.html`
- Modify: `electron/renderer/stage.ts`
- Modify: `electron/renderer/stage.css`

- [ ] **Step 1: Write failing sibling-surface and routing tests**

Replace the obsolete “running card becomes final card” assertion with:

```js
assert(html.includes('id="delivery-receipt"'));
assert(html.indexOf('id="delivery-receipt"') > html.indexOf('id="stage-thread"'));
assert(stage.includes("const liveTurn = turns.find((turn) => turn.status === 'pending')"));
assert(stage.includes('renderStreamShell(liveTurn)'));
assert(stage.includes('renderDeliveryReceipt(turns)'));
assert(stage.includes('threadPanel.hidden = liveTurn == null'));
assert(stage.includes('deliveryReceipt.hidden = liveTurn != null'));
assert(!stage.includes("threadPanel.dataset.phase = pending ? 'running' : failed ? 'failed' : 'finished'"));
```

- [ ] **Step 2: Run tests and observe failure**

Run: `node tests/stage_live_progress_test.js && node tests/stage_static_test.js`

Expected: FAIL because the completion receipt is not a sibling surface yet.

- [ ] **Step 3: Add the separate receipt DOM**

Create a sibling `section#delivery-receipt` with its own fixed header, `#receipt-result`, approval row, and retry/follow-up/copy footer. Use unique IDs and the same accessible names; do not move the StreamShell while it is visible.

- [ ] **Step 4: Route pending and settled turns to different renderers**

Split the old `renderThread` responsibility:

```ts
function renderSurfaces(turns: any[]) {
  const liveTurn = turns.find((turn) => turn.status === 'pending') || null;
  if (liveTurn) {
    renderStreamShell(liveTurn);
    threadPanel.hidden = false;
    deliveryReceipt.hidden = true;
    placeThreadSurface();
    return;
  }
  threadPanel.hidden = true;
  renderDeliveryReceipt(turns);
  deliveryReceipt.hidden = false;
  placeDeliveryReceipt();
}
```

`patchRunningCard()` must update only `#stream-result`. Settled artifacts continue through `renderStructured`, but render into `#receipt-result`. Move close/retry/copy/follow-up/consent listeners to their corresponding surface controls. Receipt placement is computed once per settled turn from its output kind and then frozen.

- [ ] **Step 5: Style the prompt receipt independently**

Use a wide initial rectangle for `agent-prompt-draft`/deliver shapes, otherwise a compact fixed receipt. Do not share StreamShell width/height variables and do not animate StreamShell into the receipt:

```css
.delivery-receipt { position: fixed; width: var(--receipt-width, 560px); max-height: min(72vh, 640px); }
.delivery-receipt[data-shape='deliver'] { --receipt-width: min(840px, calc(100vw - 16px)); }
.delivery-receipt.is-entering { animation: delivery-receipt-in 220ms cubic-bezier(.16, 1, .3, 1) both; }
```

- [ ] **Step 6: Run focused tests, typecheck, build, and commit**

Run: `node tests/stage_live_progress_test.js && node tests/stage_static_test.js && npm run typecheck && npm run build:electron`

Expected: all pass; no duplicate DOM IDs or TypeScript errors.

```bash
git add electron/renderer/stage.html electron/renderer/stage.ts electron/renderer/stage.css tests/stage_live_progress_test.js tests/stage_static_test.js
git commit -m "feat: split stream progress from delivery receipt"
```

### Task 5: Match the reference's quiet evidence language

**Files:**
- Modify: `tests/stage_static_test.js`
- Modify: `electron/renderer/stage.ts`
- Modify: `electron/renderer/stage.css`
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`

- [ ] **Step 1: Write failing visual-contract guards**

Require action/fact hierarchy, local row motion, no Stage running timer/orbit/dashboard chrome, green verified completion, black primary actions, reduced motion, and the explicitly retained neutral capsule:

```js
assert(css.includes('.stream-action-row'));
assert(css.includes('.stream-fact-row'));
assert(css.includes('translateY(6px)'));
assert(css.includes('.stream-verified'));
assert(!css.includes('animation: stage-orbit-dot'));
assert(!stage.includes('syncWaitClock('));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
assert(processCss.includes('var(--stage-process-ink)'));
assert(!processCss.includes('rgba(134, 239, 172'));
```

- [ ] **Step 2: Run the static test and observe failure**

Run: `node tests/stage_static_test.js`

Expected: FAIL until the old orbit/timer styling is removed and the new evidence rows exist.

- [ ] **Step 3: Render the StreamShell's progress as document rows**

Render each completed bridge phase as one sans-serif action plus optional monospaced fact. Add the verified row only for a real `verify`/`total` phase. Remove running elapsed chips, progress orbit, nested fact tiles, and backend badges from the Stage density only. Keep trusted source identity and failure text unchanged.

- [ ] **Step 4: Apply the quiet Vida surface treatment**

Use warm translucent paper, one-pixel dividers, near-black text, gray monospaced facts, green only for verification/approval, black primary actions, and restrained shadow. Local rows may fade/translate; no animation may target StreamShell `left`, `top`, `width`, `height`, or the settled shell transform.

- [ ] **Step 5: Run the focused Stage suite**

Run:

```bash
node tests/stage_static_test.js
node tests/stage_live_progress_test.js
npx tsx tests/stage_anchor_test.ts
npx tsx tests/stage_stream_model_test.ts
npm run typecheck
npm run build:electron
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the visual convergence**

```bash
git add electron/renderer/stage.ts electron/renderer/stage.css tests/stage_static_test.js
git commit -m "feat: match Vida stream evidence styling"
```

### Task 6: Add the separate proactive proposal renderer and complete verification

**Files:**
- Modify: `tests/stage_static_test.js`
- Modify: `electron/renderer/stage.html`
- Modify: `electron/renderer/stage.ts`
- Modify: `electron/renderer/stage.css`
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`

- [ ] **Step 1: Write failing proactive-surface guards**

Require a sibling black proposal surface that is never a phase of the white shell or receipt:

```js
assert(html.includes('id="proactive-card"'));
assert(html.indexOf('id="proactive-card"') > html.indexOf('id="delivery-receipt"'));
assert(source.includes('function renderProactiveCard('));
assert(source.includes('session.proactiveProposal'));
assert(!source.includes('threadPanel.dataset.proactive'));
assert(css.includes('.proactive-card'));
assert.match(css, /\.proactive-card\s*\{[^}]*background:\s*#(?:0e1116|111318|16181d)/is);
```

- [ ] **Step 2: Run the static test and observe failure**

Run: `node tests/stage_static_test.js`

Expected: FAIL because the separate proposal surface is absent.

- [ ] **Step 3: Add an inert sibling proposal contract**

Add `section#proactive-card` after the receipt with a title, inset context statement, equal-width action pills, Deny, and Approve. Track only an explicit trusted payload on `session.proactiveProposal`; do not invent background triggers in the renderer. `renderProactiveCard()` must build text with `textContent`, expose the proposal token through the existing action IPC only after Approve, and hide the surface on Deny.

- [ ] **Step 4: Style the reference hierarchy**

Use a near-black rounded shell, white title ending in a colon, darker inset statement, muted equal-width pills, dark Deny, and green Approve. Give it its own once-per-payload placement; do not reuse StreamShell geometry or phase attributes.

- [ ] **Step 5: Run the Stage suite and full repository verification**

Run:

```bash
node tests/stage_static_test.js
node tests/stage_live_progress_test.js
npx tsx tests/stage_anchor_test.ts
npx tsx tests/stage_stream_model_test.ts
npm test
npm run typecheck
npm run lint
npm run build:electron
```

Expected: all commands exit 0.

- [ ] **Step 6: Perform deterministic offscreen visual verification**

Capture fixed-shell scenes for short progress, overflowing progress, and settled prompt receipt with the existing Stage capture fixture. Record `getBoundingClientRect()` before and after injected progress; assert identical `x/y/width/height` for the two running scenes. Visually compare against `参考/Vida/PromptRescue.mp4`, especially the 15.50-21.50 second interval; confirm only the internal scroller moves.

- [ ] **Step 7: Update the canonical progress ledger**

Add the implemented commit hashes, exact test commands, offscreen screenshot paths, rectangle measurements, `usedBackend`, timing, errors, and remaining manual verification to the current phase ledger in `docs/design/MAGIC_POINTER_HARNESS_20260811.md`.

- [ ] **Step 8: Commit the proactive surface and ledger**

```bash
git add electron/renderer/stage.html electron/renderer/stage.ts electron/renderer/stage.css tests/stage_static_test.js docs/design/MAGIC_POINTER_HARNESS_20260811.md
git commit -m "feat: add Vida proactive proposal surface"
```

## Completion gate

Before claiming completion, rerun the full verification from Task 4 after the final commit, inspect `git status`, and report unrelated pre-existing work separately. Do not stage `app/fabric/intent_router.py`, `v4pro审查.md`, or `参考/`.
