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
    this.allowDowngrade = false;
    this._channel = 'latest';
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

  get channel() {
    return this._channel;
  }

  set channel(value) {
    this._channel = value;
    // electron-updater's real channel setter enables downgrade support.
    // Keep that side effect in the fake so the contract cannot regress.
    this.allowDowngrade = true;
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
  assert.strictEqual(updater.autoInstallOnAppQuit, false,
    'installation must require the explicit restart confirmation');
  assert.strictEqual(updater.allowPrerelease, false);
  assert.strictEqual(updater.channel, 'latest');
  assert.strictEqual(updater.allowDowngrade, false,
    'stable channel selection must restore downgrade protection after setting channel');
  manager.setChannel('preview');
  assert.strictEqual(updater.channel, 'beta');
  assert.strictEqual(updater.allowPrerelease, true, 'update channel changes must apply without restart');
  assert.strictEqual(updater.allowDowngrade, false,
    'preview channel selection must restore downgrade protection after setting channel');
  manager.setChannel('stable');
  assert.strictEqual(updater.channel, 'latest');
  assert.strictEqual(updater.allowDowngrade, false);
  const channelState = {
    channel: updater.channel,
    allowPrerelease: updater.allowPrerelease,
    allowDowngrade: updater.allowDowngrade,
  };
  assert.throws(() => manager.setChannel(' Preview '), /update_channel_unsupported/,
    'only exact supported channel identifiers are accepted');
  assert.deepStrictEqual({
    channel: updater.channel,
    allowPrerelease: updater.allowPrerelease,
    allowDowngrade: updater.allowDowngrade,
  }, channelState, 'invalid channel input must not mutate updater state');

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

  const promptsBeforeRejectedVersions = dialogCalls.length;
  const downloadsBeforeRejectedVersions = updater.downloadCount;
  for (const version of ['1.0.0', '0.9.9', '1.1.0-beta.1', 'not-a-version']) {
    updater.emit('update-available', { version });
    await tick();
  }
  assert.strictEqual(dialogCalls.length, promptsBeforeRejectedVersions,
    'equal, older, prerelease, and malformed versions must never be offered on stable');
  assert.strictEqual(updater.downloadCount, downloadsBeforeRejectedVersions,
    'rejected versions must never start a download');

  const previewUpdater = new FakeUpdater();
  const previewDialogs = [];
  const preview = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    updater: previewUpdater,
    dialog: {
      showMessageBox: async (options) => {
        previewDialogs.push(options);
        return { response: 1 };
      },
    },
    log: () => {},
  });
  preview.start({ channel: 'preview', automatic: false });
  previewUpdater.emit('update-available', { version: '1.1.0-beta.1' });
  await tick();
  assert.strictEqual(previewDialogs.length, 1,
    'preview channel may offer a newer prerelease version');

  const automaticFailureUpdater = new FakeUpdater();
  automaticFailureUpdater.checkForUpdates = async function checkForUpdates() {
    this.checkCount += 1;
    throw new Error('offline');
  };
  const automaticFailureDialogs = [];
  const automaticFailure = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    updater: automaticFailureUpdater,
    dialog: {
      showMessageBox: async (options) => {
        automaticFailureDialogs.push(options);
        return { response: 0 };
      },
    },
    log: () => {},
  });
  automaticFailure.start({ automatic: false });
  const automaticResult = await automaticFailure.check({ manual: false });
  assert.deepStrictEqual(automaticResult, { ok: false, reason: 'check_failed' });
  assert.strictEqual(automaticFailure.status().state, 'idle',
    'an automatic check failure settles quietly instead of pinning a sidebar error');
  assert.strictEqual(automaticFailureDialogs.length, 0,
    'automatic failures never interrupt the user with a dialog');

  const manualFailureUpdater = new FakeUpdater();
  manualFailureUpdater.checkForUpdates = async function checkForUpdates() {
    this.checkCount += 1;
    throw new Error('offline');
  };
  const manualFailureDialogs = [];
  const manualFailure = createUpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    updater: manualFailureUpdater,
    dialog: {
      showMessageBox: async (options) => {
        manualFailureDialogs.push(options);
        return { response: 0 };
      },
    },
    log: () => {},
  });
  manualFailure.start({ automatic: false });
  const manualResult = await manualFailure.check({ manual: true });
  assert.deepStrictEqual(manualResult, { ok: false, reason: 'check_failed' });
  assert.strictEqual(manualFailureDialogs.length, 1,
    'a manual failed check keeps the one-shot native explanation');

  console.log('update manager test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
