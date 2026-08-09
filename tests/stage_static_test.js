const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/renderer/stage.js', 'utf8');
const html = fs.readFileSync('electron/renderer/stage.html', 'utf8');
const css = fs.readFileSync('electron/renderer/stage.css', 'utf8');

// stage.js drives everything through the pure state machine
assert(source.includes('globalThis.StageState'));
assert(source.includes('transition(state, event)'));
assert(source.includes("dispatch({ type: 'WAKE'"));
assert(source.includes('prefers-reduced-motion'));
assert(source.includes('replaceChildren'));
assert(source.includes('textMeasure.measureText'));
assert(source.includes('anchor.choosePointerAnchor'));
assert(source.includes('anchor.chooseAdaptivePanelAnchor'),
  'every process/result panel must use the free-space-aware edge policy');
assert(source.includes('session.panelPlacement?.side'),
  'streaming updates must preserve the side chosen for this session');
assert(source.includes('threadPanel.dataset.placementMode = placement.mode'),
  'CSS motion must know whether the panel is outside the app or on a screen edge');
assert(!source.includes("if (answerShape.shape === 'deliver' && isUsableTargetRect(session.targetWindowRect))"),
  'inspect and deliver panels must not use different placement systems');
assert(!source.includes('animationDelay'));
assert(source.includes('GSAP'), 'must document the no-GSAP / vendor-later decision');
assert(!source.includes('innerHTML'));
assert(!source.includes("require("), 'renderer must not use node require');
assert(!source.includes('gsap.'), 'no GSAP dependency in the renderer');

// DOM contract: capsule, waveform bars, letter-fly transcript, shimmer,
// result/error surfaces — and nothing rendered while hidden.
assert(html.includes('id="stage"'));
assert(html.includes('data-state="hidden"'));
assert(html.includes('<main id="stage" class="stage-root" data-state="hidden" hidden'));
assert(html.includes('id="targeting-outline"'));
assert(html.includes('id="frozen-glow"'));
assert(html.includes('id="capsule"'));
assert(html.includes('id="voice-waveform"'));
assert(html.includes('<i></i><i></i><i></i>'));
assert(html.includes('id="capsule-input"'));
assert(html.includes('id="transcript"'));
assert(html.includes('id="processing-shimmer"'));
assert(html.includes('id="stage-result"'));
assert(html.includes('id="stage-thread"'),
  'results live inside a thread panel that keeps earlier turns on screen');
assert(html.includes('id="tpl-thread-turn"'),
  'each turn renders from one template: the ask above, its answer below');
assert(html.includes('id="thread-close"') && html.includes('id="thread-copy"'),
  'copy and close belong to the thread, not to every answer card');
assert(html.includes('id="stage-error"'));
assert(html.includes('src="../stage_state.js"'));
assert(html.includes('src="../stage_anchor.js"'));
assert(html.includes('Content-Security-Policy'));

// No legacy pill / lasso / reader / panel-rail markup on the stage
assert(!/pill/i.test(html));
assert(!/lasso/i.test(html));
assert(!html.includes('id="inline-action-rail"'));
assert(!html.includes('reader'));
assert(!html.includes('id="run"'));

// Visual contract: graphite surface, electric-blue accent, exact motion specs
assert(css.includes('#0E1116'));
assert(css.includes('--stage-electric-blue'));
assert(css.includes('1.5px solid var(--stage-electric-blue)'));
assert(css.includes('opacity 120ms'));
assert(css.includes('2px solid var(--stage-electric-blue)'));
assert(css.includes('2.4s'));
assert(css.includes('--stage-capsule-size: 40px'));
assert(css.includes('width: var(--capsule-width'));
assert(source.includes('capsuleMaxWidthDip'));
assert(css.includes('.fly-letter'));
assert(css.includes('.processing-shimmer'));
assert(css.includes('.voice-waveform'));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));
assert(!/gsap/i.test(css));
// Capsule placement contract: anchor once next to the selection, never
// drift afterwards, and let the user drag the bubble to a new spot.
assert(source.includes('if (session.capsulePlaced || session.capsuleDragged) return;'),
  'capsule must anchor exactly once per session');
assert(source.includes('session.capsuleDragged = true;'),
  'dragging the capsule must lock it in place');
assert(source.includes('capsuleDrag = { startX: x, startY: y'),
  'pointer press on the capsule body must begin a drag');
assert(source.includes("surfaceDrag = { element: threadPanel"),
  'pointer press on the thread panel must begin a drag');
assert(source.includes('session.resultDragged = true;'),
  'a dragged answer bubble must keep its user-selected position');

// Demo 7 capsule contract: voice state drives motion, text never shows the
// waveform, and answer cards grow from the same stable capsule anchor.
assert(source.includes('capsule.dataset.voiceState = session.voiceState'));
assert(source.includes('anchorThreadToCapsule()'),
  'the thread must hang off the composer rather than take its place');
assert(source.includes("if (name === 'processing' || name === 'result' || name === 'error') capsuleInput.value = '';"),
  'a submitted question moves into the thread, leaving an empty composer');
assert(!source.includes('renderResultToolbar'),
  'the per-answer toolbar is replaced by the thread bar');

// 答案的版式（含 markdown 子集）现在由共享的 renderer/card_render.js 出，
// 舞台只负责把卡片挂上去。守卫跟着能力一起搬家，不是取消：
// - 舞台必须走共享渲染器，不许自己再长一套模板
// - 那份渲染器必须仍然渲 markdown，并且同样不许碰 innerHTML
const cardRender = fs.readFileSync('electron/renderer/card_render.js', 'utf8');
assert(source.includes("renderCard(card, { density: 'capsule' })"),
  'the capsule must render the shared card, not a capsule-only template');
assert(cardRender.includes('function markdown('),
  'answers still render the markdown subset, just from the shared renderer now');
assert(!/\.innerHTML\s*=/.test(cardRender),
  'the shared renderer builds nodes; escaping must stay structural');
assert(html.includes('card_render.js') && html.includes('../cards.js'),
  'the capsule has to actually load the shared card contract and renderer');
assert(css.includes(".stage-capsule[data-mode='text'] .voice-waveform"));
assert(css.includes('.stage-capsule.is-exiting'));
assert(css.includes('@keyframes stage-result-expand'));
assert.match(css, /\.stage-root \[hidden\]\s*\{\s*display:\s*none\s*!important;/,
  'hidden stage children must never leak through component display rules');

console.log('stage static test ok');
