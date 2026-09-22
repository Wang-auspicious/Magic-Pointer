'use strict';


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

{
  assert(css.includes('--stage-accent-rgb: 38, 115, 235;'), 'no accent channels defined');
  assert(!/rgba\(38, 115, 235/.test(css), 'a literal accent colour crept back into stage.css');
  assert(css.includes('rgba(var(--stage-accent-rgb)'), 'alphas are not composed from the channels');
  assert(js.includes("stageRoot.style.setProperty('--stage-accent-rgb'"), 'accent is never applied');
  assert(main.includes('accentRgb: String(fabricSettings.appearance?.accent_rgb'), 'accent never leaves settings');
  assert(/session\.accentRgb = \/\^/.test(js), 'accent shape is not validated in the renderer');
}
console.log('stage accent token test ok');
