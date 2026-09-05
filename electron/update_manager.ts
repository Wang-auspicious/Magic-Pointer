'use strict';

import semver from 'semver';

interface UpdateApp {
  isPackaged: boolean;
  getVersion(): string;
}

interface UpdateInfo {
  version?: unknown;
}

interface DownloadProgress {
  percent?: unknown;
}

interface UpdateUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string;
  on(event: string, listener: (payload?: unknown) => unknown): unknown;
  checkForUpdates(): unknown | Promise<unknown>;
  downloadUpdate(): unknown | Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

interface DialogResult {
  response: number;
}

interface UpdateDialog {
  showMessageBox(options: Record<string, unknown>): DialogResult | Promise<DialogResult>;
}

interface UpdateState {
  state: string;
  checkedAt?: number;
  version?: string;
  progress?: number;
  message?: string;
}

interface TimerHandle {
  unref?(): void;
}

interface UpdateManagerOptions {
  app?: UpdateApp;
  updater?: UpdateUpdater;
  dialog?: UpdateDialog;
  log?: (message: string) => void;
  onStatus?: (state: Readonly<UpdateState>) => void;
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  automaticDelayMs?: number;
}

interface CheckResult {
  ok: boolean;
  reason?: string;
  result?: unknown;
}

interface UpdateManager {
  start(options?: { channel?: string; automatic?: boolean }): Readonly<UpdateState>;
  check(options?: { manual?: boolean }): Promise<CheckResult>;
  setChannel(channel?: string): string;
  dispose(): void;
  status(): Readonly<UpdateState>;
}

function infoFrom(value: unknown): UpdateInfo {
  return value && typeof value === 'object' ? (value as UpdateInfo) : {};
}

function progressFrom(value: unknown): DownloadProgress {
  return value && typeof value === 'object' ? (value as DownloadProgress) : {};
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const UPDATE_CHANNELS = Object.freeze({
  stable: Object.freeze({ updaterChannel: 'latest', allowPrerelease: false }),
  preview: Object.freeze({ updaterChannel: 'beta', allowPrerelease: true }),
});

function createUpdateManager({
  app: appDependency,
  updater: updaterDependency,
  dialog: dialogDependency,
  log = () => {},
  onStatus = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = (handle) => clearTimeout(handle as NodeJS.Timeout),
  automaticDelayMs = 20_000,
}: UpdateManagerOptions = {}): UpdateManager {
  if (!appDependency || !updaterDependency || !dialogDependency) {
    throw new Error('update_manager_dependencies_missing');
  }
  const app = appDependency;
  const updater = updaterDependency;
  const dialog = dialogDependency;

  let state: Readonly<UpdateState> = Object.freeze({
    state: app.isPackaged ? 'idle' : 'unsupported',
  });
  let started = false;
  let inFlight: Promise<CheckResult> | null = null;
  let automaticTimer: TimerHandle | null = null;
  let lastCheckWasManual = false;
  let availablePromptOpen = false;
  let downloadedPromptOpen = false;

  function acceptedUpdateVersion(value: unknown = {}): string | null {
    const info = infoFrom(value);
    const current = semver.valid(app.getVersion());
    const candidate = semver.valid(String(info.version || ''));
    if (!current || !candidate) return null;
    if (semver.prerelease(candidate) && updater.allowPrerelease !== true) return null;
    return semver.gt(candidate, current) ? candidate : null;
  }

  function publish(next: UpdateState): Readonly<UpdateState> {
    state = Object.freeze({ ...next, checkedAt: Date.now() });
    onStatus(state);
    log(`update state=${state.state}${state.version ? ` version=${state.version}` : ''}`);
    return state;
  }

  function show(options: Record<string, unknown>): Promise<DialogResult> {
    return Promise.resolve(dialog.showMessageBox(options)).catch((error) => {
      log(`update dialog failed ${errorName(error)}: ${errorMessage(error)}`);
      return { response: 1 };
    });
  }

  function bindEvents(): void {
    if (started) return;
    started = true;
    updater.on('checking-for-update', () => publish({ state: 'checking' }));
    updater.on('update-not-available', (value = {}) => {
      const info = infoFrom(value);
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
    updater.on('update-available', async (value = {}) => {
      const info = infoFrom(value);
      const version = acceptedUpdateVersion(info);
      if (!version) {
        publish({ state: 'current', version: app.getVersion() });
        log(`update rejected version=${String(info.version || '')}`);
        return;
      }
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
        publish({ state: 'error', message: errorMessage(error) });
        log(`update download failed ${errorName(error)}: ${errorMessage(error)}`);
      }
    });
    updater.on('download-progress', (value = {}) => {
      const progress = progressFrom(value);
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      publish({ state: 'downloading', progress: percent });
    });
    updater.on('update-downloaded', async (value = {}) => {
      const info = infoFrom(value);
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
      publish(lastCheckWasManual
        ? { state: 'error', message: errorMessage(error || 'update_failed') }
        : { state: 'idle' });
      log(`update failed ${errorName(error)}: ${errorMessage(error)}`);
    });
  }

  function setChannel(channel = 'stable'): string {
    const selected = (
      UPDATE_CHANNELS as Readonly<
        Record<string, { updaterChannel: string; allowPrerelease: boolean }>
      >
    )[channel];
    if (!selected) throw new Error('update_channel_unsupported');
    // electron-updater intentionally enables allowDowngrade when its channel
    // setter is used. Explicitly reset it for every supported channel.
    updater.channel = selected.updaterChannel;
    updater.allowPrerelease = selected.allowPrerelease;
    updater.allowDowngrade = false;
    return channel;
  }

  function check({ manual = false }: { manual?: boolean } = {}): Promise<CheckResult> {
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
        log(`update check failed ${errorName(error)}: ${errorMessage(error)}`);
        if (manual) {
          publish({ state: 'error', message: errorMessage(error) });
          return show({
            type: 'warning',
            buttons: ['知道了'],
            title: 'Magic Pointer 更新',
            message: '暂时无法检查更新。',
            detail: '请检查网络后重试。Magic Pointer 仍可正常使用。',
          }).then(() => ({ ok: false, reason: 'check_failed' }));
        }
        publish({ state: 'idle' });
        return { ok: false, reason: 'check_failed' };
      })
      .finally(() => {
        inFlight = null;
        lastCheckWasManual = false;
      });
    return inFlight;
  }

  function start({
    channel = 'stable',
    automatic = true,
  }: { channel?: string; automatic?: boolean } = {}): Readonly<UpdateState> {
    bindEvents();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    setChannel(channel);
    if (automatic && app.isPackaged && !automaticTimer) {
      automaticTimer = setTimeoutFn(() => {
        automaticTimer = null;
        void check({ manual: false });
      }, automaticDelayMs);
      automaticTimer.unref?.();
    }
    return state;
  }

  function dispose(): void {
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

export { createUpdateManager };
