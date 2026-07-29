const assert = require('assert');
const fs = require('fs');

const surfaces = [
  'electron/renderer/dashboard.html',
  'electron/renderer/index.html',
  'electron/renderer/panel.html',
  'electron/renderer/stage.html',
];

for (const file of surfaces) {
  const html = fs.readFileSync(file, 'utf8');
  const styles = [...html.matchAll(/href="([^"]+\.css)"/g)].map((match) => match[1]);
  assert(styles.includes('typography.css'), `${file} must load shared typography contract`);
  assert(styles.at(-1) === 'typography.css', `${file} must load typography.css after component styles`);
}

const css = fs.readFileSync('electron/renderer/typography.css', 'utf8');
assert(css.includes('"Segoe UI Variable Text"'), 'Latin UI glyphs must match the Windows Codex system stack');
assert(css.includes('"Microsoft YaHei UI"'), 'Chinese UI glyphs must use the Windows UI face');
assert(css.includes('html *'), 'all current and future UI descendants must inherit the contract');
assert(css.includes('!important'), 'component CSS must not silently override the global contract');

const panel = fs.readFileSync('electron/renderer/panel.js', 'utf8');
assert(panel.includes('"Microsoft YaHei UI"'),
  'canvas text measurement must use the same Chinese system font as rendered controls');

console.log('typography contract test ok');
