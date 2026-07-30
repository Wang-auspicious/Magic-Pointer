'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_EXTERNAL_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
]);
const FATAL_RELAUNCH_MARKER = 'fatal-relaunch.json';
const DEFAULT_FATAL_RELAUNCH_WINDOW_MS = 5 * 60 * 1000;
const hardenedSessions = new WeakSet();
const installedApps = new WeakSet();

function isAllowedExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return false;
  }
  return ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol);
}

function attachContentsHardening(contents, logger, { shell } = {}) {
  const log = typeof logger === 'function' ? logger : () => {};
  if (!contents || !shell) throw new Error('security_hardening_contents_dependencies_missing');

  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      Promise.resolve(shell.openExternal(url)).catch((error) => {
        log(`security: openExternal failed ${error?.message || error}`);
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
        log(`security: will-navigate openExternal failed ${error?.message || error}`);
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
} = {}) {
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('security_hardening_recovery_dependencies_missing');
  }

  function markerPath() {
    return pathImpl.join(app.getPath('userData'), FATAL_RELAUNCH_MARKER);
  }

  function claim() {
    const timestamp = Number(now());
    const target = markerPath();
    try {
      let prior = null;
      try {
        prior = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
      } catch (_) {
        // No previous marker is the normal first-crash case.
      }
      if (Number.isFinite(prior?.at) && timestamp - prior.at >= 0 && timestamp - prior.at < windowMs) {
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

function install({ logger, onFatal, electron, processRef = process, fatalGuard } = {}) {
  const runtime = electron || require('electron');
  const { app, dialog, shell } = runtime;
  if (!app || !dialog || !shell) throw new Error('security_hardening_electron_dependencies_missing');
  const log = typeof logger === 'function' ? logger : () => {};
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

  const handleFatal = (kind) => (error) => {
    const message = error && error.stack ? error.stack : String(error);
    log(`fatal ${kind}: ${message}`);
    if (typeof onFatal === 'function') {
      try {
        onFatal({ kind, error });
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
          ? `${error?.message || error}\n\n应用将尝试自动重启一次。`
          : `${error?.message || error}\n\n为避免崩溃循环，应用不会自动重启；请修复问题后手动启动。`,
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
