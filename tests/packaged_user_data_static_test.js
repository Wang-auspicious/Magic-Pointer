'use strict';

const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/main.js', 'utf8');
assert(source.includes("app.isPackaged ? app.getPath('userData')"),
  'packaged settings, logs, and runtime files must live in the per-user app data directory');
assert(source.includes("path.join(process.env.LOCALAPPDATA, 'Magic Pointer')"),
  'Windows packaged data must stay in LocalAppData, not the roaming profile');
assert(source.includes('const EXPLICIT_USER_DATA_DIR = process.env.MAGIC_POINTER_USER_DATA_DIR'),
  'test and enterprise launches must be able to isolate Chromium and runtime state together');
assert(source.includes("app.setPath('userData', ELECTRON_USER_DATA_DIR)"),
  'Chromium session data and Magic Pointer runtime data must share the explicit local directory');
assert(!source.includes("MAGIC_POINTER_USER_DATA_DIR || RUNTIME_DIR"),
  'packaged runtime must not silently write into resources/app/data/runtime');

console.log('packaged_user_data_static_test: all assertions passed');
