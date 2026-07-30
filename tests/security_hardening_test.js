'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  attachContentsHardening,
  createFatalRecoveryGuard,
  install,
} = require('../electron/security_hardening');

class FakeContents extends EventEmitter {
  constructor(url, session = null) {
    super();
    this.url = url;
    this.session = session || {
      setPermissionRequestHandler: (handler) => { this.permissionHandler = handler; },
      setPermissionCheckHandler: (handler) => { this.permissionCheckHandler = handler; },
    };
  }

  getURL() {
    return this.url;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

const contents = new FakeContents('file:///app/dashboard.html');
const opened = [];
attachContentsHardening(contents, () => {}, {
  shell: { openExternal: async (url) => { opened.push(url); } },
});

assert.deepStrictEqual(contents.windowOpenHandler({ url: 'https://example.com/docs' }), { action: 'deny' });
assert.deepStrictEqual(contents.windowOpenHandler({ url: 'file:///C:/sensitive.txt' }), { action: 'deny' });
assert.deepStrictEqual(opened, ['https://example.com/docs']);

const blockedNavigation = { preventDefault() { this.prevented = true; } };
contents.emit('will-navigate', blockedNavigation, 'file:///C:/sensitive.txt');
assert.equal(blockedNavigation.prevented, true,
  'a privileged renderer must not navigate from its own file URL to an arbitrary local file');

const sameDocument = { preventDefault() { this.prevented = true; } };
contents.emit('will-navigate', sameDocument, 'file:///app/dashboard.html');
assert.equal(sameDocument.prevented, undefined, 'the current document URL remains harmless');

for (const permission of ['media', 'clipboard-read']) {
  let granted = null;
  contents.permissionHandler({}, permission, (allowed) => { granted = allowed; });
  assert.equal(granted, false, `permission ${permission} must be denied unless a surface explicitly needs it`);
}
{
  let granted = null;
  contents.permissionHandler({}, 'notifications', (allowed) => { granted = allowed; });
  assert.equal(granted, false, 'notification permission must remain denied');
}
assert.equal(contents.permissionCheckHandler({}, 'media'), false);

{
  let requestHandlerInstalls = 0;
  let checkHandlerInstalls = 0;
  const sharedSession = {
    setPermissionRequestHandler(handler) {
      requestHandlerInstalls += 1;
      this.requestHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      checkHandlerInstalls += 1;
      this.checkHandler = handler;
    },
  };
  attachContentsHardening(new FakeContents('file:///app/overlay.html', sharedSession), () => {}, {
    shell: { openExternal: async () => {} },
  });
  attachContentsHardening(new FakeContents('file:///app/stage.html', sharedSession), () => {}, {
    shell: { openExternal: async () => {} },
  });
  assert.equal(requestHandlerInstalls, 1, 'a shared Electron session gets one permission request policy');
  assert.equal(checkHandlerInstalls, 1, 'a shared Electron session gets one permission check policy');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-fatal-'));
let now = 1000;
const guard = createFatalRecoveryGuard({
  app: { getPath: () => tmp },
  fs,
  path,
  now: () => now,
  windowMs: 10_000,
});
assert.equal(guard.claim(), true, 'the first fatal event may request one recovery relaunch');
assert.equal(guard.claim(), false, 'a second fatal event within the crash window must not loop');
now += 10_001;
assert.equal(guard.claim(), true, 'the recovery budget resets after the crash-loop window');

const app = new EventEmitter();
app.enableSandbox = () => {};
app.getPath = () => tmp;
app.relaunchCount = 0;
app.quitCount = 0;
app.relaunch = () => { app.relaunchCount += 1; };
app.quit = () => { app.quitCount += 1; };
const processRef = new EventEmitter();
const messages = [];
let remainingRelaunches = 1;
install({
  electron: {
    app,
    dialog: { showErrorBox: (...args) => { messages.push(args); } },
    shell: { openExternal: async () => {} },
  },
  processRef,
  logger: () => {},
  fatalGuard: { claim: () => remainingRelaunches-- > 0 },
});
processRef.emit('uncaughtException', new Error('first crash'));
processRef.emit('uncaughtException', new Error('second crash'));
assert.equal(app.relaunchCount, 1, 'only one relaunch is permitted for a crash loop');
assert.equal(app.quitCount, 2, 'fatal exits must use the graceful Electron quit lifecycle');
assert.equal(messages.length, 2, 'each fatal event remains visible to the user');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('security hardening test ok');
