'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../electron/app_lifecycle');

assert.strictEqual(lifecycle.shouldStartHidden({ argv: [], wasOpenedAtLogin: false, captureMode: false }), false);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: ['--background'], wasOpenedAtLogin: false, captureMode: false }), true);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: [], wasOpenedAtLogin: true, captureMode: false }), true);
assert.strictEqual(lifecycle.shouldStartHidden({ argv: [], wasOpenedAtLogin: false, captureMode: true }), true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-onboarding-'));
const marker = path.join(root, 'onboarding.json');
assert.strictEqual(lifecycle.onboardingIsReady(marker), false);
fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, status: 'ready' }), 'utf8');
assert.strictEqual(lifecycle.onboardingIsReady(marker), true);
fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, status: 'blocked' }), 'utf8');
assert.strictEqual(lifecycle.onboardingIsReady(marker), false);

const main = fs.readFileSync('electron/main.js', 'utf8');
assert(main.includes('new Tray('), 'resident desktop app needs a visible tray entry');
assert(main.includes("label: '退出 Magic Pointer'"), 'tray must expose a real quit action');
assert(main.includes("app.on('second-instance'"), 'clicking the shortcut twice must reveal the existing app');
assert(main.includes("showDashboard({ view: onboardingRequired ? 'diagnostics' : 'general'"),
  'normal desktop launch must reveal the independent dashboard');

console.log('desktop_lifecycle_test: all assertions passed');
