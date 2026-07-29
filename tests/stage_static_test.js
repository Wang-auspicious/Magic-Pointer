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

console.log('stage static test ok');
