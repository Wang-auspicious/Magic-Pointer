const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/renderer/stage.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/stage.html', 'utf8');
const css = fs.readFileSync('electron/renderer/stage.css', 'utf8');

assert(html.includes('class="stage-composer"'), 'the default entry surface must be a fixed text composer');
assert(html.includes('class="work-panel-viewport"'), 'the answer shell needs a fixed viewport');
assert(html.includes('class="work-panel-scroller"'), 'answer growth must happen in an internal scroller');
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
assert(!css.includes("[data-width-tier='"), 'the 406/420/560/840 result-width ladder must be gone');
assert(!css.includes('@keyframes stage-capsule-expand'));
assert(!css.includes('@keyframes stage-capsule-collapse'));
assert(!css.includes('@keyframes stage-thread-finish'));
assert(!css.includes('scaleY(.045)'), 'the answer panel must not grow from a tiny bubble');

console.log('stage fixed surface contract test ok');
