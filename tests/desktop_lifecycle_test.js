'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../electron/app_lifecycle');

assert.strictEqual(lifecycle.shouldStartHidden({ argv: [], wasOpenedAtLogin: false, captureMode: false }), true);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: ['--background'], wasOpenedAtLogin: false, captureMode: false }), true);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: [], wasOpenedAtLogin: true, captureMode: false }), true);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: [], wasOpenedAtLogin: false, captureMode: true }), true);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: ['--show'], wasOpenedAtLogin: false, captureMode: false }), false);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: ['--dashboard'], wasOpenedAtLogin: false, captureMode: false }), false);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-onboarding-'));
const marker = path.join(root, 'onboarding.json');
assert.strictEqual(lifecycle.onboardingIsReady(marker), false);
fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 2, status: 'ready', bootstrapVersion: 1 }), 'utf8');
assert.strictEqual(lifecycle.onboardingIsReady(marker), true);
fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 2, status: 'blocked', bootstrapVersion: 1 }), 'utf8');
assert.strictEqual(lifecycle.onboardingIsReady(marker), false);

const main = fs.readFileSync('electron/main.js', 'utf8');
assert(main.includes('new Tray('), 'resident desktop app needs a visible tray entry');
assert(main.includes("label: '退出 Magic Pointer'"), 'tray must expose a real quit action');
assert(main.includes("app.on('second-instance'"), 'clicking the shortcut twice must reveal the existing app');
assert(main.includes('showPrimarySurface({ activate: true })'),
  'secondary launches must reveal onboarding or dashboard according to readiness');
assert(main.includes('if (onboardingRequired) showOnboarding({}, options);'),
  'unready installations must reveal the independent setup window');
assert(main.includes("else showDashboard({ view: options.view || 'chat' }, options);"),
  'ready installations must reveal the main surface (studio), defaulting to the chat view');
assert(main.includes("renderer', 'studio.html'"),
  'the primary window must load the studio, not the legacy dashboard page');

console.log('desktop_lifecycle_test: all assertions passed');
