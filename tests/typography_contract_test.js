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
assert(css.includes('"Times New Roman"'), 'English glyphs must use Times New Roman');
assert(css.includes('"KaiTi"'), 'Chinese glyphs must use KaiTi');
assert(css.includes('html *'), 'all current and future UI descendants must inherit the contract');
assert(css.includes('!important'), 'component CSS must not silently override the global contract');

console.log('typography contract test ok');
