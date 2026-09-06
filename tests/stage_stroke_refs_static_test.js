'use strict';

// Reference deletion, stable numbering and the submitted stroke index list are
// behavior-tested in stage_turn_stream_test.ts.  This file retains only the
// independent accent-token contract.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

// --- Accent tokens --------------------------------------------------------
// The stage floats over other people's windows, so it keeps its own palette —
// but it must derive every accent from one set of channels. Repeating
// rgba(38, 115, 235, ...) is how a theme setting silently stops working.
{
  assert(css.includes('--stage-accent-rgb: 38, 115, 235;'), 'no accent channels defined');
  assert(!/rgba\(38, 115, 235/.test(css), 'a literal accent colour crept back into stage.css');
  assert(css.includes('rgba(var(--stage-accent-rgb)'), 'alphas are not composed from the channels');
  // The renderer must be able to retint at runtime, or the tokens are decoration.
  assert(js.includes("stageRoot.style.setProperty('--stage-accent-rgb'"), 'accent is never applied');
  assert(main.includes('accentRgb: String(fabricSettings.appearance?.accent_rgb'), 'accent never leaves settings');
  // A settings file must not be able to inject CSS through this field.
  assert(/session\.accentRgb = \/\^/.test(js), 'accent shape is not validated in the renderer');
}
console.log('stage accent token test ok');
