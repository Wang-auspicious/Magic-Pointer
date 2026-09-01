'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');

assert(!html.includes('sv_motion.js'));
assert(!source.includes('SvMotion'));
assert(!source.includes('svMotionGlobals'));
assert(source.includes("check.className = 'mp-plan-check'"));
assert(source.includes("content.className = 'mp-plan-step-label'"));
assert.match(source, /stroke-width="1\.5"/);

assert.match(css, /\.mp-plan-check\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s);
assert.match(css, /\.dshw-plan-step\.is-active \.mp-plan-check\s*\{[^}]*var\(--mp-clay\)/s);
assert.match(css, /\.dshw-plan-step\.is-done \.mp-plan-check\s*\{[^}]*background:\s*var\(--mp-text\)/s);
assert.match(css, /\.dshw-plan-step\.is-done \.mp-plan-step-label\s*\{[^}]*text-decoration:\s*line-through/s);
assert(!css.includes('infinite'), 'plan state must not pulse forever');

console.log('studio plan checkbox contract ok');
