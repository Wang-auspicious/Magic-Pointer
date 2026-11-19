import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Bug 1: .mp-perception-popover floats absolutely above composer without clipping bottom bar', () => {
  const css = readRepo('electron/renderer/desktop_perception.css');
  assert.match(
    css,
    /\.mp-perception-popover\s*\{[^}]*position:\s*absolute/s,
    '.mp-perception-popover must be position: absolute so opening it never pushes the bottom composer off screen',
  );
  assert.match(
    css,
    /\.mp-perception-popover\s*\{[^}]*bottom:\s*calc\(100%/s,
    '.mp-perception-popover must anchor above the composer via bottom: calc(100% + ...)',
  );
  const chatCss = readRepo('electron/renderer/chat_styles.css');
  assert.match(
    chatCss,
    /\.mpw-composer-stack\s*\{[^}]*position:\s*relative/s,
    '.mpw-composer-stack must establish relative positioning context for the floating popover',
  );
});

test('Bug 2: runtime/index.ts gracefully degrades missing workspaceRoot instead of throwing ENOENT', () => {
  const idxSrc = readRepo('electron/runtime/index.ts');
  assert.doesNotMatch(
    idxSrc,
    /if\s*\(workspace\s*&&\s*!\(await\s+stat\(workspace\)\)\.isDirectory\(\)\)/,
    'runtime/index.ts must not call unguarded await stat(workspace) which throws raw ENOENT when a temp folder is deleted',
  );
  assert.match(
    idxSrc,
    /workspaceDirectoryExists|stat\(workspace\)\.then\(/,
    'runtime/index.ts must safely check workspace existence with .then(..., () => false) and degrade gracefully',
  );
});

test('Bug 3: stageWindow is visible to screenshots and gesture capture syncs immediately to Studio GUI', () => {
  const mainSrc = readRepo('electron/main.ts');
  const stageWindowSection = mainSrc.slice(
    mainSrc.indexOf('function createStageWindow'),
    mainSrc.indexOf('let stageBoundsCache'),
  );
  assert.doesNotMatch(
    stageWindowSection,
    /stageWindow\.setContentProtection\(true\)/,
    'stageWindow must NOT enable WDA_EXCLUDEFROMCAPTURE content protection (otherwise screenshots hide it)',
  );
  assert.match(
    mainSrc,
    /desktop-perception:captured/,
    'main.ts must broadcast desktop-perception:captured to Studio GUI immediately when gesture capture finishes',
  );

  const preloadSrc = readRepo('electron/preload.ts');
  assert.match(
    preloadSrc,
    /desktop-perception:captured/,
    'preload.ts must forward desktop-perception:captured to Studio renderer',
  );

  const html = readRepo('electron/renderer/studio.html');
  assert.match(
    html,
    /mp-captured-evidence-bar/,
    'studio.html must provide .mp-captured-evidence-bar container',
  );
  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(
    studioSrc,
    /captured-evidence-bar/,
    'studio.ts must render immediate captured screenshot/OCR preview bar inside the main GUI',
  );
});
