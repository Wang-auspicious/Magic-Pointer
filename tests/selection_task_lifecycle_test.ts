import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { SelectionSessionStore } from '../electron/selection_session';

const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
function handlers(names: string[], globals: Record<string, unknown>) {
  const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
    && names.includes(node.name?.text || '')).map((node) => node.getText(ast));
  assert.equal(functions.length, names.length, `missing handler: ${names}`);
  const code = ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${code}\n({${names.join(',')}})`, globals);
}

let sequence = 0;
const sessions = new SelectionSessionStore({ maxFrozen: 1, idFactory: () => `selection-${++sequence}` });
const selected = sessions.create();
sessions.attachSnapshot(selected.token, { selectionSnapshot: { snapshot_id: 'original' } });
const requestId = sessions.startRequest(selected.token);
let cancelled = false;
const context = {
  activeSelectionSessionToken: selected.token, selectionSessions: sessions,
  stageWindow: { isDestroyed: () => false, isVisible: () => true, webContents: { send() {} } },
  overlayWindow: null, overlayOwnsPointerInput: false, selectionGestureArm: null,
  log() {}, cancelSelectionGesture() {}, setStageMouseCapture() {},
  disarmTemporaryDismissShortcut() {}, hideOverlay() {}, lastStageResult: null,
  invalidateSelectionSession() { cancelled = true; sessions.cancel(selected.token); },
};
const lifecycle = handlers(['detachSelectionSurface', 'dismissTemporarySurfaces'], context);
lifecycle.dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
assert.equal(cancelled, false, 'closing the surface must not cancel the runtime');
assert.equal(sessions.isCurrentRequest(selected.token, requestId), true, 'detached task still accepts progress and completion');
assert.equal(sessions.get(selected.token)?.stageAttached, false, 'late progress cannot reopen the dismissed surface');
const newer = sessions.create();
sessions.attachSnapshot(newer.token, { selectionSnapshot: { snapshot_id: 'new' } });
assert.equal(sessions.isCurrentRequest(selected.token, requestId), true, 'a running task must survive capture eviction');
assert.equal(sessions.finishRequest(selected.token, requestId)?.state, 'ready');
assert.equal(sessions.get(selected.token)?.stageAttached, false, 'completion must stay in the GUI after dismissal');
let stageSends = 0;
const delivery = handlers(['safeSurfaceSend'], {
  selectionSessions: sessions,
  resultTargetWindow: () => ({ isDestroyed: () => false, webContents: {
    isDestroyed: () => false, send() { stageSends++; },
  } }),
});
assert.equal(delivery.safeSurfaceSend('stage', 'stage:update', { selectionSessionToken: selected.token }), false);
assert.equal(stageSends, 0, 'detached completion must not paint over a new selection');
console.log('selection task lifecycle test ok');
