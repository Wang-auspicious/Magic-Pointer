'use strict';

import type { App, Dialog, Shell, WebContents } from 'electron';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');

type FatalKind = 'uncaughtException' | 'unhandledRejection';
type Logger = (message: string) => void;
type UnknownRecord = Record<string, unknown>;

interface FatalGuard {
  claim(): boolean;
}

interface RecoveryOptions {
  app?: Pick<App, 'getPath'>;
  fs?: typeof import('node:fs');
  now?: () => number;
  path?: typeof import('node:path');
  windowMs?: number;
}

interface ProcessEvents {
  on(event: FatalKind, listener: (error: unknown) => void): unknown;
}

interface ElectronRuntime {
  app?: App;
  dialog?: Dialog;
  shell?: Shell;
}

interface InstallOptions {
  electron?: ElectronRuntime;
  fatalGuard?: FatalGuard;
  logger?: unknown;
  onFatal?: unknown;
  processRef?: ProcessEvents;
}

const ALLOWED_EXTERNAL_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
]);
const FATAL_RELAUNCH_MARKER = 'fatal-relaunch.json';
const DEFAULT_FATAL_RELAUNCH_WINDOW_MS = 5 * 60 * 1000;
const hardenedSessions = new WeakSet<WebContents['session']>();
const installedApps = new WeakSet<App>();

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAllowedExternalUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return false;
  }
  return ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol);
}

function attachContentsHardening(
  contents: WebContents,
  logger: unknown,
  { shell }: { shell?: Shell } = {},
): void {
  const log: Logger = typeof logger === 'function' ? (logger as Logger) : () => {};
  if (!contents || !shell) throw new Error('security_hardening_contents_dependencies_missing');

  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      Promise.resolve(shell.openExternal(url)).catch((error) => {
        log(`security: openExternal failed ${errorMessage(error)}`);
      });
    } else {
      log(`security: blocked window.open for ${String(url).slice(0, 200)}`);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL();
    if (!url || url === current) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      Promise.resolve(shell.openExternal(url)).catch((error) => {
        log(`security: will-navigate openExternal failed ${errorMessage(error)}`);
      });
    } else {
      log(`security: blocked navigation to ${String(url).slice(0, 200)}`);
    }
  });

  contents.on('will-attach-webview', (event, webPreferences, params) => {
    event.preventDefault();
    log(`security: blocked webview attach to ${String(params?.src || '').slice(0, 200)}`);
  });

  const session = contents.session;
  if (session && !hardenedSessions.has(session)) {
    session.setPermissionRequestHandler?.((_wc, permission, callback) => {
      callback(false);
      log(`security: denied permission request "${permission}"`);
    });
    session.setPermissionCheckHandler?.((_wc, permission) => {
      log(`security: denied permission check "${permission}"`);
      return false;
    });
    hardenedSessions.add(session);
  }
}

function createFatalRecoveryGuard({
  app,
  fs: fsImpl = fs,
  path: pathImpl = path,
  now = Date.now,
  windowMs = DEFAULT_FATAL_RELAUNCH_WINDOW_MS,
}: RecoveryOptions = {}): FatalGuard {
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('security_hardening_recovery_dependencies_missing');
  }
  const recoveryApp = app;

  function markerPath(): string {
    return pathImpl.join(recoveryApp.getPath('userData'), FATAL_RELAUNCH_MARKER);
  }

  function claim(): boolean {
    const timestamp = Number(now());
    const target = markerPath();
    try {
      let prior: unknown = null;
      try {
        prior = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
      } catch (_) {
        // No previous marker is the normal first-crash case.
      }
      const priorAt = recordOf(prior)?.at;
      if (typeof priorAt === 'number'
        && Number.isFinite(priorAt)
        && timestamp - priorAt >= 0
        && timestamp - priorAt < windowMs) {
        return false;
      }
      fsImpl.mkdirSync(pathImpl.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fsImpl.writeFileSync(temporary, JSON.stringify({ at: timestamp }), 'utf8');
      fsImpl.renameSync(temporary, target);
      return true;
    } catch (_) {
      // If crash-loop state cannot be recorded, do not risk an infinite loop.
      return false;
    }
  }

  return { claim };
}

function install({
  logger,
  onFatal,
  electron,
  processRef = process,
  fatalGuard,
}: InstallOptions = {}) {
  const runtime: ElectronRuntime = electron || require('electron');
  const { app, dialog, shell } = runtime;
  if (!app || !dialog || !shell) throw new Error('security_hardening_electron_dependencies_missing');
  const log: Logger = typeof logger === 'function' ? (logger as Logger) : () => {};
  const recovery = fatalGuard || createFatalRecoveryGuard({ app });
  if (installedApps.has(app)) return { recovery, installed: false };
  installedApps.add(app);

  // Sandbox is set per-window in webPreferences. enableSandbox() forces ALL
  // windows including the pointer overlay and stage into sandbox mode, which
  // can break the preload contract for transparent/screen-saver surfaces.
  // Dashboard and onboarding opt into sandbox individually.

  app.on('web-contents-created', (_event, contents) => {
    attachContentsHardening(contents, log, { shell });
  });

  const handleFatal = (kind: FatalKind) => (error: unknown): void => {
    const message = error instanceof Error && error.stack ? error.stack : String(error);
    log(`fatal ${kind}: ${message}`);
    if (typeof onFatal === 'function') {
      try {
        (onFatal as (details: { error: unknown; kind: FatalKind }) => void)({ kind, error });
      } catch (_hookError) {
        // The original fatal event was already logged.
      }
    }
    if (kind !== 'uncaughtException') return;

    const shouldRelaunch = recovery.claim() === true;
    try {
      dialog.showErrorBox(
        'Magic Pointer 遇到内部错误',
        shouldRelaunch
          ? `${errorMessage(error)}\n\n应用将尝试自动重启一次。`
          : `${errorMessage(error)}\n\n为避免崩溃循环，应用不会自动重启；请修复问题后手动启动。`,
      );
    } catch (_dialogError) {
      // Headless / early crash — the log is still available.
    }
    if (shouldRelaunch) {
      try {
        app.relaunch();
      } catch (_relaunchError) {
        // A normal quit below still prevents the broken process from surviving.
      }
    }
    // app.quit preserves before-quit cleanup for pointer and voice helpers.
    try {
      app.quit();
    } catch (_quitError) {
      // Nothing safer remains if Electron cannot start its normal shutdown path.
    }
  };

  processRef.on('uncaughtException', handleFatal('uncaughtException'));
  processRef.on('unhandledRejection', handleFatal('unhandledRejection'));
  return { recovery, installed: true };
}

module.exports = {
  ALLOWED_EXTERNAL_SCHEMES,
  FATAL_RELAUNCH_MARKER,
  attachContentsHardening,
  createFatalRecoveryGuard,
  install,
  isAllowedExternalUrl,
};
