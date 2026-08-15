const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/renderer/stage.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/stage.html', 'utf8');
const css = fs.readFileSync('electron/renderer/stage.css', 'utf8');
const capture = fs.readFileSync('scripts/capture_stage.ts', 'utf8');

assert(html.includes('class="stage-composer"'), 'the default entry surface must be a fixed text composer');
assert(html.includes('class="work-panel-viewport"'), 'the answer shell needs a fixed viewport');
assert(html.includes('class="work-panel-scroller"'), 'answer growth must happen in an internal scroller');
assert(html.includes('class="stage-brand"'), 'the Vida single-surface panel needs one quiet product mark');
assert(html.includes('class="thread-stop-icon"'),
  'the work panel itself must expose the stop affordance while a turn is running');
assert(html.includes('src="../stage_surface_policy.js"'));

assert(source.includes('globalThis.StageSurfacePolicy'));
assert(source.includes("workPanelScroller.addEventListener('scroll'"),
  'selection-bound tools must follow the real internal scroller');
assert(!source.includes('function completionWidthTier('), 'answer kind must never select a new panel width');
assert(!source.includes('threadPanel.dataset.widthTier'), 'streaming content must not change panel geometry');
const placementStart = source.indexOf('function placeThreadSurface()');
const placementEnd = source.indexOf('\n  }', placementStart);
assert(placementStart >= 0);
assert(!source.slice(placementStart, placementEnd).includes('getBoundingClientRect'),
  'work-panel placement must use its fixed contract size, not rendered content');

assert.match(css, /\.stage-composer\s*\{[^}]*width:\s*var\(--stage-composer-width,\s*480px\)[^}]*height:\s*var\(--stage-composer-height,\s*132px\)/s);
assert.match(css, /\.stage-thread\s*\{[^}]*width:\s*var\(--stage-work-panel-width,\s*560px\)[^}]*height:\s*var\(--stage-work-panel-height,\s*520px\)/s);
assert.match(css, /\.work-panel-scroller\s*\{[^}]*overflow-y:\s*auto/s);
assert.match(css, /\.stage-thread\s*\{[^}]*border-radius:\s*18px/s);
assert.match(css, /\.thread-bar\s*\{[^}]*border-top:\s*1px solid/s);
assert(css.includes(".stage-thread[data-phase='running'] .thread-bar { display: none; }"),
  'running work must not show disabled follow-up controls');
assert.match(css, /\.stage-result \.mcard\[data-density='capsule'\]\s*\{[^}]*background:\s*transparent/s);
assert(!css.includes("[data-width-tier='"), 'the 406/420/560/840 result-width ladder must be gone');
assert(!css.includes('@keyframes stage-capsule-expand'));
assert(!css.includes('@keyframes stage-capsule-collapse'));
assert(!css.includes('@keyframes stage-thread-finish'));
assert(!css.includes('scaleY(.045)'), 'the answer panel must not grow from a tiny bubble');
assert(source.includes("const capsuleOpen = name === 'capsule-voice' || name === 'capsule-text'"),
  'the entry composer must only exist while accepting input');
assert(!source.includes("name === 'capsule-text' || name === 'processing'\n      || ((name === 'result'"),
  'processing must not leave a second composer beside the fixed work panel');
assert(source.includes("threadClose.setAttribute('aria-label', pending ? '停止' : '关闭')"),
  'the panel close control must honestly become Stop while work is running');
assert(source.includes("const anchorEl = name === 'processing' ? threadPanel"),
  'real delivery progress must stay attached to the single processing panel');
assert(capture.includes('const PANEL_ANCHOR = Object.freeze({ x: 672, y: 108 });'),
  'processing and finished visual fixtures must share the same work-panel anchor');
assert(!capture.includes('showCapsule({\n      x: isRight'),
  'the processing visual fixture must not fabricate the retired duplicate composer');
assert(!capture.includes("setProperty('--capsule-width'"),
  'the visual fixture must use the real fixed composer geometry variable');

console.log('stage fixed surface contract test ok');
