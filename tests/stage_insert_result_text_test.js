'use strict';

// 填入 writes into another application, so the interesting part is not that it
// works -- it is what the renderer is allowed to influence. It may choose the
// text; it may not choose the window, the process, the title, or the point. Those
// come from the frozen selection session in main, which is what makes "write into
// the app the user pointed at" a bounded claim rather than an arbitrary write.

const assert = require('assert');
const fs = require('fs');

const preload = fs.readFileSync('electron/preload.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');
const stageJs = fs.readFileSync('electron/renderer/stage.js', 'utf8');
const stageHtml = fs.readFileSync('electron/renderer/stage.html', 'utf8');

// The preload surface forwards exactly two fields, both of them harmless on
// their own: the visible text and the session token that scopes it.
assert(preload.includes("insertResultText: (payload) => ipcRenderer.send('stage:insert-result-text'"));
assert(preload.includes("text: String(payload?.text || '')"));
assert(preload.includes('selectionSessionToken: payload?.selectionSessionToken || null'));
assert(
  !/insertResultText[\s\S]{0,400}targetWindow/.test(preload),
  'the renderer must not be able to name a target window',
);
assert(
  !/insertResultText[\s\S]{0,400}targetPoint/.test(preload),
  'the renderer must not be able to name a target point',
);

// Main gates on the stage being the real sender and on a live session, then
// supplies the target itself from the snapshot.
assert(main.includes("ipcMain.on('stage:insert-result-text'"));
const handler = main.slice(main.indexOf("ipcMain.on('stage:insert-result-text'"));
const handlerBody = handler.slice(0, handler.indexOf('\n});') + 4);
assert(handlerBody.includes("isSurfaceSender(event, 'stage', resultTargetWindow)"));
assert(handlerBody.includes('selectionSessions.get(selectionSessionToken)'));
assert(handlerBody.includes('targetWindow: safeClone(snapshot.source_window || {})'));
assert(handlerBody.includes('targetPoint: safeClone(snapshot.target_point || null)'));
assert(handlerBody.includes('targetPointSpace: snapshot.target_point_space || null'));
assert(handlerBody.includes("targetResolution: 'adaptive'"));
assert(handlerBody.includes('currentTargetWindow: safeClone(lastStableForegroundWindow)'));
assert(!handlerBody.includes('preferForeground: true'));
assert(handlerBody.includes("'scripts/deliver_text_bridge.py'"));
// A stale session must not receive a write result either.
assert(handlerBody.includes('if (!selectionSessions.get(selectionSessionToken))'));

// The 填入 action exists and sends what is actually on screen, so an edited or
// re-asked answer is what travels. The entry point moved from a thread-bar
// button to the capsule's consent approve (2026-08-07 Vida card redesign);
// the renderer still may not name a window or point.
assert(stageHtml.includes('id="thread-copy"'));
assert(stageJs.includes('consentApprove.addEventListener'));
assert(stageJs.includes('const text = capsuleInput.value.trim() || resultPlainText(resultCard);'));
assert(stageJs.includes('api.insertResultText({ text, selectionSessionToken: session.token })'));

// The bridge decides the verdict; the renderer has no success wording of its own
// to accidentally show for an unverifiable write.
assert(!stageJs.includes('已填入'));

console.log('stage insert result text test ok');
