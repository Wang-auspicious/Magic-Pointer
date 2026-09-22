'use strict';


const assert = require('assert');
const fs = require('fs');

const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const stageJs = fs.readFileSync('electron/renderer/stage.ts', 'utf8');
const stageHtml = fs.readFileSync('electron/renderer/stage.html', 'utf8');

assert(preload.includes('insertResultText:') && preload.includes("ipcRenderer.send('stage:insert-result-text'"));
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
assert(handlerBody.includes('if (!selectionSessions.get(selectionSessionToken))'));

assert(stageHtml.includes('id="thread-copy"'));
assert(stageJs.includes('consentApprove.addEventListener'));
assert(stageJs.includes('const text = capsuleInput.value.trim() || resultPlainText(resultCard);'));
assert(stageJs.includes('api.insertResultText({ text, selectionSessionToken: session.token })'));

assert(!stageJs.includes('已填入'));

console.log('stage insert result text test ok');
