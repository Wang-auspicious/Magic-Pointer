'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/studio.css', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');

assert.strictEqual((html.match(/class="side"/g) || []).length, 1, 'Studio must have one navigation rail');
assert.strictEqual((html.match(/id="workspace-header"/g) || []).length, 1, 'all views share one workspace header');
assert(html.includes('id="workspace-title"'));
assert(html.includes('id="workspace-description"'));
assert(html.includes('class="workspace-composer"'), 'chat must use one fixed Oreo composer');
assert(html.includes('../studio_shell.js'));
assert(!html.includes('id="hero"'));
assert(!html.includes('hero.mp4'));
assert(!html.includes('你指过的每一处'));
assert(!source.includes('function makeOrb('), 'decorative moving avatar generation must be removed');
assert(!source.includes("ta.style.height = 'auto'"), 'composer shell must not grow with textarea content');

assert.match(css, /\.shell\s*\{[^}]*background:\s*#f4f3ef/s);
assert.match(css, /\.workspace-composer\s*\{[^}]*height:\s*128px/s);
assert.match(css, /\.workspace-card\s*\{[^}]*border:\s*1px solid/s);
assert.match(css, /\.btn-solid\s*\{[^}]*background:\s*#16181d/s);
assert.match(css, /\.workspace-eyebrow\s*\{[^}]*font-family:\s*var\(--mp-font-mono\)/s);
assert(!/radial-gradient\([^)]*#[0-9a-f]{3,8}/i.test(css), 'marketing color orbs must not return');

console.log('studio visual contract test ok');
