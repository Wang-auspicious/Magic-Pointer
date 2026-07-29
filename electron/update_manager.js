'use strict';

function createUpdateManager({
  app,
  updater,
  dialog,
  log = () => {},
  onStatus = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  automaticDelayMs = 20_000,
} = {}) {
  if (!app || !updater || !dialog) throw new Error('update_manager_dependencies_missing');

  let state = Object.freeze({ state: app.isPackaged ? 'idle' : 'unsupported' });
  let started = false;
  let inFlight = null;
  let automaticTimer = null;
  let lastCheckWasManual = false;
  let availablePromptOpen = false;
  let downloadedPromptOpen = false;

  function publish(next) {
    state = Object.freeze({ ...next, checkedAt: Date.now() });
    onStatus(state);
    log(`update state=${state.state}${state.version ? ` version=${state.version}` : ''}`);
    return state;
  }

  function show(options) {
    return Promise.resolve(dialog.showMessageBox(options)).catch((error) => {
      log(`update dialog failed ${error.name}: ${error.message}`);
      return { response: 1 };
    });
  }

  function bindEvents() {
    if (started) return;
    started = true;
    updater.on('checking-for-update', () => publish({ state: 'checking' }));
    updater.on('update-not-available', (info = {}) => {
      publish({ state: 'current', version: String(info.version || app.getVersion()) });
      if (lastCheckWasManual) {
        show({
          type: 'info',
          buttons: ['知道了'],
          title: 'Magic Pointer 更新',
          message: '当前已是最新版本。',
          detail: `当前版本：${app.getVersion()}`,
        });
      }
    });
    updater.on('update-available', async (info = {}) => {
      const version = String(info.version || '新版本');
      publish({ state: 'available', version });
      if (availablePromptOpen) return;
      availablePromptOpen = true;
      const answer = await show({
        type: 'info',
        buttons: ['下载更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: 'Magic Pointer 更新',
        message: `发现 Magic Pointer ${version}`,
        detail: '下载在后台进行。完成后可立即重启安装，也可留到下次启动。',
        noLink: true,
      });
      availablePromptOpen = false;
      if (answer.response !== 0) return;
      publish({ state: 'downloading', version, progress: 0 });
      try {
        await updater.downloadUpdate();
      } catch (error) {
        publish({ state: 'error', message: String(error.message || error) });
        log(`update download failed ${error.name}: ${error.message}`);
      }
    });
    updater.on('download-progress', (progress = {}) => {
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      publish({ state: 'downloading', progress: percent });
    });
    updater.on('update-downloaded', async (info = {}) => {
      const version = String(info.version || '新版本');
      publish({ state: 'downloaded', version, progress: 100 });
      if (downloadedPromptOpen) return;
      downloadedPromptOpen = true;
      const answer = await show({
        type: 'info',
        buttons: ['立即重启更新', '下次启动时安装'],
        defaultId: 0,
        cancelId: 1,
        title: 'Magic Pointer 更新',
        message: `Magic Pointer ${version} 已下载完成`,
        detail: '重启只关闭 Magic Pointer，不会关闭其他应用。',
        noLink: true,
      });
      downloadedPromptOpen = false;
      if (answer.response === 0) updater.quitAndInstall(false, true);
    });
    updater.on('error', (error) => {
      publish({ state: 'error', message: String(error?.message || error || 'update_failed') });
      log(`update failed ${error?.name || 'Error'}: ${error?.message || error}`);
    });
  }

  function setChannel(channel = 'stable') {
    updater.allowPrerelease = channel === 'preview';
    return updater.allowPrerelease ? 'preview' : 'stable';
  }

  function check({ manual = false } = {}) {
    if (!app.isPackaged) {
      const result = { ok: false, reason: 'packaged_only' };
      if (!manual) return Promise.resolve(result);
      return show({
        type: 'info',
        buttons: ['知道了'],
        title: 'Magic Pointer 更新',
        message: '开发模式不检查更新。',
        detail: '安装版会通过托盘自动检查 GitHub Releases。',
      }).then(() => result);
    }
    bindEvents();
    if (inFlight) return inFlight;
    lastCheckWasManual = manual;
    publish({ state: 'checking' });
    inFlight = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then((result) => ({ ok: true, result }))
      .catch((error) => {
        publish({ state: 'error', message: String(error.message || error) });
        log(`update check failed ${error.name}: ${error.message}`);
        if (manual) {
          return show({
            type: 'warning',
            buttons: ['知道了'],
            title: 'Magic Pointer 更新',
            message: '暂时无法检查更新。',
            detail: '请检查网络后重试。Magic Pointer 仍可正常使用。',
          }).then(() => ({ ok: false, reason: 'check_failed' }));
        }
        return { ok: false, reason: 'check_failed' };
      })
      .finally(() => {
        inFlight = null;
        lastCheckWasManual = false;
      });
    return inFlight;
  }

  function start({ channel = 'stable', automatic = true } = {}) {
    bindEvents();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    setChannel(channel);
    if (automatic && app.isPackaged && !automaticTimer) {
      automaticTimer = setTimeoutFn(() => {
        automaticTimer = null;
        check({ manual: false });
      }, automaticDelayMs);
      if (typeof automaticTimer?.unref === 'function') automaticTimer.unref();
    }
    return state;
  }

  function dispose() {
    if (automaticTimer) clearTimeoutFn(automaticTimer);
    automaticTimer = null;
  }

  return {
    start,
    check,
    setChannel,
    dispose,
    status: () => state,
  };
}

module.exports = { createUpdateManager };
