/*
 * Headless startup smoke test.
 *
 * Runs the real Electron main process, renders the Studio, captures a PNG and
 * exits. This is the only check in the repo that executes `electron/main.ts`
 * end to end — every other test either exercises a pure module or a fake at a
 * boundary, which is exactly how a NameError shipped through a green suite
 * earlier in this engagement.
 *
 * It proves: the app starts, the main process's buffered logger flushes on
 * quit, preload wiring loads, the renderer reaches a painted frame, and the
 * Studio shell + settings model are present. It does NOT prove anything about
 * the overlay, the stage, the gesture path or the twin cursor, all of which
 * need a real interaction.
 *
 * Usage:  node tools/smoke_studio_headless.js
 * Exits non-zero if no frame is produced or the render state is incomplete.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(os.tmpdir(), `mp-smoke-${process.pid}.png`);

const env = {
  ...process.env,
  MAGIC_POINTER_DASHBOARD_CAPTURE: out,
  MAGIC_POINTER_DASHBOARD_VIEW: 'activity',
  MAGIC_POINTER_DASHBOARD_CAPTURE_DELAY_MS: '6000',
};

const electron = path.join(root, 'node_modules', 'electron', 'cli.js');
const run = spawnSync(process.execPath, [electron, '.'], {
  cwd: root,
  env,
  encoding: 'utf8',
  timeout: 120_000,
});

const stdout = String(run.stdout || '');
process.stdout.write(stdout);
if (run.stderr) process.stderr.write(String(run.stderr));

if (run.status !== 0) {
  console.error(`smoke: electron exited ${run.status}`);
  process.exit(1);
}
if (!fs.existsSync(out)) {
  console.error(`smoke: no frame at ${out}`);
  process.exit(1);
}
const state = /renderedState=(\{.*\})/.exec(stdout);
if (!state) {
  console.error('smoke: the run produced no renderedState — the renderer never reported');
  process.exit(1);
}
const parsed = JSON.parse(state[1]);
const missing = ['dashboardApi', 'studioShell', 'settingsModel'].filter((key) => !parsed[key]);
if (missing.length) {
  console.error(`smoke: renderer missing ${missing.join(', ')}`);
  process.exit(1);
}

const bytes = fs.statSync(out).size;
fs.unlinkSync(out);
console.log(`smoke: ok view=${parsed.view} bytes=${bytes} dpr=${parsed.viewport?.dpr}`);
