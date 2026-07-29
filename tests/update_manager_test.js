'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createUpdateManager } = require('../electron/update_manager');

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = false;
    this.allowPrerelease = false;
    this.checkCount = 0;
    this.downloadCount = 0;
    this.quitCount = 0;
  }

  async checkForUpdates() {
    this.checkCount += 1;
    return { updateInfo: { version: '1.1.0' } };
  }

  async downloadUpdate() {
    this.downloadCount += 1;
    return [];
  }

  quitAndInstall() {
    this.quitCount += 1;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  const devDialogs = [];
  const dev = createUpdateManager({
    app: { isPackaged: false, getVersion: () => '1.0.0' },
    updater: new FakeUpdater(),
    dialog: { showMessageBox: async (options) => { devDialogs.push(options); return { response: 0 }; } },
    log: () => {},
  });
  const devResult = await dev.check({ manual: true });
  assert.deepStrictEqual(devResult, { ok: false, reason: 'packaged_only' });
  assert.strictEqual(devDialogs.length, 1, 'manual development checks need a truthful explanation');

  const updater = new FakeUpdater();
  const dialogCalls = [];
  const responses = [0, 0];
  const states = [];
  const manager = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    updater,
    dialog: {
      showMessageBox: async (options) => {
        dialogCalls.push(options);
        return { response: responses.shift() ?? 1 };
      },
    },
    log: () => {},
    onStatus: (status) => states.push(status),
  });

  manager.start({ channel: 'stable', automatic: false });
  assert.strictEqual(updater.autoDownload, false, 'updates download only after user consent');
  assert.strictEqual(updater.autoInstallOnAppQuit, true);
  assert.strictEqual(updater.allowPrerelease, false);
  manager.setChannel('preview');
  assert.strictEqual(updater.allowPrerelease, true, 'update channel changes must apply without restart');
  manager.setChannel('stable');

  const first = manager.check({ manual: true });
  const coalesced = manager.check({ manual: true });
  assert.strictEqual(first, coalesced, 'concurrent checks must share one in-flight request');
  await first;
  assert.strictEqual(updater.checkCount, 1);

  updater.emit('update-available', { version: '1.1.0' });
  await tick();
  assert.strictEqual(updater.downloadCount, 1);
  assert.match(dialogCalls[0].message, /1\.1\.0/);

  updater.emit('download-progress', { percent: 48.5 });
  assert(states.some((status) => status.state === 'downloading' && status.progress === 48.5));

  updater.emit('update-downloaded', { version: '1.1.0' });
  await tick();
  assert.strictEqual(updater.quitCount, 1);
  assert(dialogCalls[1].buttons.includes('立即重启更新'));

  console.log('update manager test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
