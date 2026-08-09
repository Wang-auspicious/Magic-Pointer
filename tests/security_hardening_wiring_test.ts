'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const security = fs.readFileSync('electron/security_hardening.ts', 'utf8');

const liveCalls = main.match(/securityHardening\.install\s*\(\s*\{/g) || [];
assert.strictEqual(liveCalls.length, 1, 'production main must install security hardening exactly once');
assert.doesNotMatch(main, /TEMPORARY\s+—\s+bisecting overlay flash bug/,
  'the production security install must not remain behind the old bisect marker');
assert.doesNotMatch(main, /app\.enableSandbox\s*\(/,
  'sandbox remains a per-window choice for transparent surfaces');
assert.doesNotMatch(security, /setIgnoreMouseEvents|\.show\(|\.hide\(|\.focus\(|moveTop/,
  'security guards must not mutate transparent-surface visibility or input ownership');

console.log('security hardening wiring test ok');
