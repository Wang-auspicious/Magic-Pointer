'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/onboarding.html', 'utf8');
const css = fs.readFileSync('electron/renderer/onboarding.css', 'utf8');
const js = fs.readFileSync('electron/renderer/onboarding.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');

for (const id of [
  'onboarding-welcome',
  'onboarding-start',
  'onboarding-progress',
  'onboarding-progress-fill',
  'onboarding-current-stage',
  'onboarding-step-count',
  'onboarding-stage-list',
  'onboarding-details-toggle',
  'onboarding-details',
  'onboarding-cancel',
  'onboarding-success',
  'onboarding-continue',
  'onboarding-failure',
  'onboarding-retry',
]) {
  assert(html.includes(`id="${id}"`), `missing onboarding element: ${id}`);
}

assert(!html.includes('sidebar'), 'first-run onboarding must not reuse dashboard navigation');
assert(html.includes('MAGIC POINTER'), 'welcome surface needs a deliberate product wordmark');
assert(css.includes('--onboarding-blue: #2457f5'), 'onboarding blue is a stable design token');
assert(css.includes('@media (prefers-reduced-motion: reduce)'), 'motion must respect OS accessibility settings');
assert(css.includes('.onboarding-stage[data-state="running"]'), 'active stage needs a dedicated visual state');
assert(js.includes("api.start()"), 'user starts setup from the welcome screen');
assert(js.includes('api.onPreflightEvent'), 'progress surface consumes real backend events');
assert(js.includes('.onboarding-screen[data-screen="${screenName}"]'),
  'screen switching must never target the document root status attribute');
assert(js.includes("showScreen('success')"), 'completed setup has a distinct success screen');
assert(js.includes("showScreen('failure')"), 'blocked setup has a distinct failure screen');

assert(main.includes('let onboardingWindow = null;'));
assert(main.includes('function createOnboardingWindow()'));
assert(main.includes("loadFile(path.join(__dirname, 'renderer', 'onboarding.html'))"));
assert(main.includes('function showOnboarding('));
assert(main.includes("ipcMain.on('onboarding:start'"));
assert(main.includes("ipcMain.on('onboarding:continue'"));
assert(main.includes("ipcMain.on('onboarding:cancel'"));
assert(main.includes("if (onboardingRequired) showOnboarding("));
assert(preload.includes("contextBridge.exposeInMainWorld('magicPointerOnboarding'"));

console.log('onboarding surface test ok');
