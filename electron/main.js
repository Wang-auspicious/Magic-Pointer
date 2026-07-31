const { app, BrowserWindow, globalShortcut, ipcMain, screen, safeStorage, systemPreferences } = require('electron');
const path = require('path');
const { dialog } = require('electron');
const { Menu, nativeImage, Tray } = require('electron');
const { nativeTheme } = require('electron');
const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { SelectionSessionStore } = require('./selection_session');
const { InteractionEpisodeStore, inferReferenceLabel, inferReferenceMode } = require('./interaction_episode');
const { ActivationGate } = require('./activation_gate');
const { WiggleDetector } = require('./wiggle_detector');
const { runDeterministicWiggleEvidence } = require('./wiggle_reliability');
const { MouseActivationDetector } = require('./mouse_activation');
const { ElectronSettingsStore, defaultSettings } = require('./settings_store');
const { CredentialStore } = require('./credential_store');
const { PreflightRunner } = require('./bootstrap_runner');
const { buildAsyncPreflightChecks } = require('./preflight_checks');
const { resolvePythonRuntime, pythonInvocationArgs, pythonSpawnEnvironment } = require('./python_runtime');
const { VoiceResidentRuntime } = require('./voice_resident_runtime');
const { captureEligibility } = require('./result_surface_policy');
const { inferObjectKind, selectionSourceForReason, stageEventFromBridge } = require('./stage_contract');
const { canAutoExecuteInternalProposal } = require('./internal_action_policy');
const { physicalScreenPoint, normalizeGroundingGeometry } = require('./coordinate_space');
const { physicalGestureTrace } = require('./coordinate_space');
const { isSurfaceSender } = require('./ipc_surface_policy');
const { buildGoogleMapsDirectionsUrl, isAllowedGoogleMapsDirectionsUrl } = require('./route_policy');
const securityHardening = require('./security_hardening');
const observability = require('./observability');
const { VoiceFocusGuard } = require('./voice_focus_guard');
const { inspectOnboardingReadiness, shouldStartHidden } = require('./app_lifecycle');
const { RuntimeSnapshot } = require('./runtime_snapshot');
const { summarizeGesture } = require('./gesture_capture');
const { shouldDismissFromGlobalPointer } = require('./pointer_dismiss_policy');
const { RendererReadiness } = require('./renderer_readiness');
const { gestureRuntimeContract, gestureRuntimeSettingsChanged } = require('./gesture_runtime_settings');
const { createUpdateManager } = require('./update_manager');
const { pointerPollingPolicy } = require('./pointer_polling_policy');
const { PassThroughGestureCapture } = require('./pass_through_gesture');
const { createPythonBridgeRunner } = require('./python_bridge_runner');

let overlayWindow = null;
let dashboardWindow = null;
let onboardingWindow = null;
let stageWindow = null;
const overlayReadiness = new RendererReadiness();
const stageReadiness = new RendererReadiness();
let tray = null;
let updateManager = null;
let mousePollTimer = null;
let overlayHideTimer = null;
let selectionGestureArm = null;
let selectionGestureArmTimer = null;
let selectionGestureExpiryTimer = null;
let wiggleDetector = null;
const mouseActivationDetector = new MouseActivationDetector();
const passThroughGestureCapture = new PassThroughGestureCapture();
const pythonBridgeRunner = createPythonBridgeRunner();
let fabricSettings = null;
let fabricSettingsStore = null;
let credentialStore = null;
let pointerStateChild = null;
let pointerStateRestartTimer = null;
let pointerInputState = {
  buttons: 0,
  foregroundApp: '',
  foregroundHwnd: 0,
  foregroundProcessId: 0,
  isWindowMoving: false,
  scrollDelta: 0,
};
let wiggleCalibrationTimer = null;
let lastWiggleTraceAt = 0;
let inputPaused = false;
let isQuitting = false;
let onboardingRequired = false;
let onboardingPhase = 'welcome';
let preflightRunPromise = null;
let preflightAbortController = null;
let backgroundHintShown = false;
let temporaryDismissShortcutRegistered = false;
let temporarySurfaceButtons = 0;
let overlayOwnsPointerInput = false;
let stageHitRegions = [];
let stageShapeSettleTimer = null;
let pendingSurfaceActivation = null;
let surfaceReadinessWaitArmed = false;
let startupVoiceWarmupScheduled = false;
const registeredConfigurableHotkeys = new Set();

// Bound what a (possibly compromised) overlay renderer can hand to the
// capture bridge: distance-filtered real strokes stay far below this.
const MAX_OVERLAY_CAPTURE_POINTS = 4096;

const ROOT = path.resolve(__dirname, '..');
const PYTHON_RUNTIME = resolvePythonRuntime({
  isPackaged: app.isPackaged,
  platform: process.platform,
  resourcesPath: process.resourcesPath,
  env: process.env,
});
const PYTHON_EXECUTABLE = PYTHON_RUNTIME.executable;
const PYTHON_ISOLATED = PYTHON_RUNTIME.required === true;
const DEVELOPMENT_RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const EXPLICIT_USER_DATA_DIR = process.env.MAGIC_POINTER_USER_DATA_DIR
  ? path.resolve(process.env.MAGIC_POINTER_USER_DATA_DIR)
  : null;
const PACKAGED_WINDOWS_USER_DATA_DIR = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Magic Pointer')
  : null;
const ELECTRON_USER_DATA_DIR = EXPLICIT_USER_DATA_DIR
  || (app.isPackaged ? PACKAGED_WINDOWS_USER_DATA_DIR : null);
if (ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', ELECTRON_USER_DATA_DIR);
}
const DEFAULT_USER_DATA_DIR = app.isPackaged ? app.getPath('userData') : DEVELOPMENT_RUNTIME_DIR;
const FABRIC_DATA_DIR = path.resolve(EXPLICIT_USER_DATA_DIR || DEFAULT_USER_DATA_DIR);
const RUNTIME_DIR = FABRIC_DATA_DIR;
const LOG_PATH = path.join(RUNTIME_DIR, 'electron.log');
const PID_PATH = path.join(RUNTIME_DIR, 'electron.pid');
const ONBOARDING_MARKER_PATH = path.join(FABRIC_DATA_DIR, 'onboarding.json');
const PREFLIGHT_MANIFEST_PATH = path.join(ROOT, 'data', 'preflight_manifest.v1.json');
const ONBOARDING_BOOTSTRAP_VERSION = 1;
const ACTION_PROPOSAL_TTL_MS = 2 * 60 * 1000;
const SELECTION_SESSION_TTL_MS = 2 * 60 * 1000;
const SELECTION_GESTURE_ARM_DELAY_MS = 180;
const SELECTION_GESTURE_TIMEOUT_MS = 5000;
const ALLOWED_ACTION_TYPES = new Set([
  'copy_text_to_clipboard',
  'office_replace_selection',
  'office_undo_last_action',
  'shopping_list_add',
  'shopping_list_add_many',
  'shopping_list_set_checked',
  'shopping_list_undo_add',
  'calendar_event_create',
  'calendar_event_undo_create',
  'paste_text_to_foreground',
  'fabric_recipe_execute',
]);

const pendingActionProposals = new Map();
const selectionSessions = new SelectionSessionStore({ ttlMs: SELECTION_SESSION_TTL_MS });
const interactionEpisodes = new InteractionEpisodeStore({ ttlMs: 30 * 60 * 1000 });
const activationGate = new ActivationGate({ debounceMs: 600 });
const activeSessionChildren = new Map();
const dictationChildren = new Map();
const dictationStopFiles = new Map();
let voiceRuntime = null;
const voiceFocusGuards = new Map();
let latestVoiceFocusEvidence = null;
let latestVoiceRuntimeStatus = {
  state: 'unloaded',
  errorCode: null,
  residentEnabled: true,
  workerEvent: null,
};
const runtimeSnapshot = new RuntimeSnapshot({
  probe: probeRuntimeState,
  ttlMs: 5000,
});
let activeSelectionSessionToken = null;
// Last bridge result delivered to the stage; context actions (open calendar /
// route draft in the dashboard) resolve against it.
let lastStageResult = null;
let dashboardRequestSerial = 0;
let dashboardOperationQueue = Promise.resolve();

function log(message) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch (_) {
    // Logging must never break the overlay.
  }
}

securityHardening.install({
  logger: log,
  onFatal: ({ kind }) => {
    try { observability.writeEvent('main.fatal', { kind }); } catch (_) {}
    log(`fatal handler notified kind=${kind}`);
  },
  electron: require('electron'),
});

observability.install({ runtimeDir: RUNTIME_DIR });

function persistVoiceFocusEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return;
  latestVoiceFocusEvidence = safeClone(evidence);
  try {
    fs.mkdirSync(FABRIC_DATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(FABRIC_DATA_DIR, 'voice-focus-evidence.jsonl'),
      `${JSON.stringify(evidence)}\n`,
      'utf8',
    );
  } catch (error) {
    log(`voice focus evidence persist failed ${error.name}`);
  }
}

function beginVoiceFocusGuard(selectionSessionToken) {
  if (fabricSettings?.activation?.keep_current_app_focus === false) return null;
  const expectedHwnd = Number(pointerInputState.foregroundHwnd || 0);
  if (!Number.isSafeInteger(expectedHwnd) || expectedHwnd <= 0) {
    persistVoiceFocusEvidence({
      sessionId: String(selectionSessionToken || ''),
      expectedHwnd: 0,
      contract: 'foreground-hwnd-stable',
      invariant: false,
      violationCount: 1,
      violations: [{
        phase: 'wake', expectedHwnd: 0, observedHwnd: 0, timestamp: Date.now(),
      }],
      phases: [],
      startedAt: Date.now(),
      finishedAt: Date.now(),
      failure: 'foreground_hwnd_unavailable',
    });
    return null;
  }
  const guard = new VoiceFocusGuard({
    expectedHwnd,
    sessionId: String(selectionSessionToken || crypto.randomUUID()),
  });
  voiceFocusGuards.set(selectionSessionToken, guard);
  observeVoiceFocusPhase('wake', selectionSessionToken);
  return guard;
}

function observeVoiceFocusPhase(phase, selectionSessionToken = activeSelectionSessionToken) {
  const guard = voiceFocusGuards.get(selectionSessionToken);
  if (!guard) return false;
  const stable = guard.observe(phase, Number(pointerInputState.foregroundHwnd || 0));
  if (!stable) log(`voice focus invariant failed phase=${phase}`);
  return stable;
}

function finishVoiceFocusGuard(phase = null, selectionSessionToken = activeSelectionSessionToken) {
  const guard = voiceFocusGuards.get(selectionSessionToken);
  if (!guard) return null;
  if (phase) observeVoiceFocusPhase(phase, selectionSessionToken);
  const evidence = guard.finish();
  voiceFocusGuards.delete(selectionSessionToken);
  persistVoiceFocusEvidence(evidence);
  log(`voice focus complete invariant=${evidence.invariant} violations=${evidence.violationCount}`);
  return evidence;
}

function persistCurrentObjectEpisode(session) {
  if (!fabricSettingsStore || !session?.snapshot) return false;
  const snapshot = session.snapshot;
  const context = snapshot.context || {};
  const sourceWindow = snapshot.source_window || context.window || {};
  const episode = interactionEpisodes.contextPayload();
  const currentObjectPath = path.join(path.dirname(fabricSettingsStore.path), 'current-object.json');
  const value = episode ? {
    schemaVersion: 1,
    episodeId: episode.episodeId,
    capturedAt: new Date(episode.recentEvents.at(-1)?.at || Date.now()).toISOString(),
    expiresAt: new Date(episode.expiresAt).toISOString(),
    slots: episode.slots,
    labels: episode.labels,
    spatialRelations: episode.spatialRelations,
    objects: episode.objects.map((item) => ({
      id: item.objectId,
      referenceLabel: item.referenceLabel || null,
      kind: item.kind || 'native_selection',
      label: item.label || item.objectId,
      content: item.content || '',
      bbox: item.bbox || null,
      source: item.source || {
        app: item.app || '',
        title: item.windowTitle || '',
      },
    })),
  } : {
    schemaVersion: 1,
    episodeId: session.token,
    capturedAt: snapshot.captured_at || new Date().toISOString(),
    expiresAt: snapshot.expires_at || new Date(Date.now() + SELECTION_SESSION_TTL_MS).toISOString(),
    slots: { this: snapshot.snapshot_id || session.token, that: null, these: [], here: null },
    labels: {},
    spatialRelations: [],
    objects: [{
      id: snapshot.snapshot_id || session.token,
      kind: snapshot.source_kind || 'native_selection',
      label: session.summary?.label || context.label || 'THIS',
      content: String(context.content || ''),
      bbox: snapshot.selection_bbox || snapshot.selection_rect || null,
      source: {
        app: context.app || session.summary?.app || '',
        title: sourceWindow.title || '',
        path: context.document_path || context.path || null,
        annotatedPath: snapshot.annotated_path || null,
        captureAttestation: snapshot.capture_attestation || null,
        perceptionTrace: snapshot.perception_trace || null,
        url: context.url || null,
        page: context.page ?? null,
        hwnd: sourceWindow.hwnd ?? null,
        processId: sourceWindow.process_id ?? null,
      },
    }],
  };
  const tempPath = `${currentObjectPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(currentObjectPath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, currentObjectPath);
    return true;
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    log(`current object persist failed ${error.name}: ${error.message}`);
    return false;
  }
}

function startPointerInputStateStream() {
  if (pointerStateChild) return;
  let executable = null;
  let args = [];
  if (process.platform === 'win32') {
    executable = 'powershell.exe';
    args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(ROOT, 'scripts', 'pointer_input_state.ps1'),
    ];
  } else if (process.platform === 'darwin') {
    executable = process.env.MAGIC_POINTER_MACOS_HOST
      || path.join(ROOT, 'native', 'macos', 'magic-pointer-host');
    if (!fs.existsSync(executable)) {
      log(`macOS pointer host missing path=${executable}`);
      return;
    }
  } else {
    log(`pointer input state stream unsupported platform=${process.platform}`);
    return;
  }
  pointerStateChild = spawn(executable, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  pointerStateChild.stdout.setEncoding('utf8');
  pointerStateChild.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        pointerInputState = {
          buttons: Number(parsed.buttons || 0),
          foregroundApp: String(parsed.foregroundApp || ''),
          foregroundHwnd: Number(parsed.foregroundHwnd || 0),
          foregroundProcessId: Number(parsed.foregroundProcessId || 0),
          isWindowMoving: parsed.isWindowMoving === true,
          scrollDelta: Number(parsed.scrollDelta || 0),
        };
      } catch (_) {}
    }
  });
  pointerStateChild.on('close', () => {
    pointerStateChild = null;
    pointerInputState = {
      buttons: 0,
      foregroundApp: '',
      foregroundHwnd: 0,
      foregroundProcessId: 0,
      isWindowMoving: false,
      scrollDelta: 0,
    };
    if (!isQuitting && mousePollTimer && !pointerStateRestartTimer) {
      pointerStateRestartTimer = setTimeout(() => {
        pointerStateRestartTimer = null;
        startPointerInputStateStream();
      }, 300);
    }
  });
  pointerStateChild.on('error', (error) => {
    log(`pointer state stream error ${error.name}: ${error.message}`);
  });
}

function prunePendingActionProposals(now = Date.now()) {
  for (const [token, entry] of pendingActionProposals.entries()) {
    if (!entry || entry.expiresAt <= now) pendingActionProposals.delete(token);
  }
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function registerActionProposals(parsed, selectionSessionToken = null, surface = null) {
  if (!parsed || !Array.isArray(parsed.actionProposals)) return;

  prunePendingActionProposals();
  const now = Date.now();
  const safeProposals = [];
  const surfaceWindow = surface ? resultTargetWindow(surface) : null;
  const webContentsId = surfaceWindow && !surfaceWindow.isDestroyed() ? surfaceWindow.webContents.id : null;
  for (const proposal of parsed.actionProposals.slice(0, 5)) {
    if (!proposal || typeof proposal !== 'object') continue;
    if (!ALLOWED_ACTION_TYPES.has(proposal.action_type)) continue;

    const token = crypto.randomUUID();
    const canonical = safeClone(proposal);
    pendingActionProposals.set(token, {
      proposal: canonical,
      selectionSessionToken,
      surface,
      webContentsId,
      createdAt: now,
      expiresAt: now + ACTION_PROPOSAL_TTL_MS,
    });
    safeProposals.push({ ...canonical, action_token: token });
  }

  parsed.actionProposals = safeProposals;
}

function takePendingActionProposal(token, selectionSessionToken = null, surface = null) {
  prunePendingActionProposals();
  if (typeof token !== 'string' || !token) return null;
  const entry = pendingActionProposals.get(token);
  if (!entry) return null;
  if (entry.selectionSessionToken && entry.selectionSessionToken !== selectionSessionToken) return null;
  if (entry.surface !== surface) return null;
  const surfaceWindow = surface ? resultTargetWindow(surface) : null;
  if (!surfaceWindow || surfaceWindow.isDestroyed() || entry.webContentsId !== surfaceWindow.webContents.id) return null;
  pendingActionProposals.delete(token);
  return safeClone(entry.proposal);
}

function invalidateActionProposalsForSession(selectionSessionToken) {
  if (!selectionSessionToken) return;
  for (const [token, entry] of pendingActionProposals.entries()) {
    if (entry?.selectionSessionToken === selectionSessionToken) pendingActionProposals.delete(token);
  }
}

function cancelSessionChild(selectionSessionToken) {
  const child = activeSessionChildren.get(selectionSessionToken);
  activeSessionChildren.delete(selectionSessionToken);
  if (!child || child.killed) return;
  try { child.kill(); } catch (_) {}
}

function invalidateSelectionSession(selectionSessionToken) {
  if (!selectionSessionToken) return;
  if (voiceRuntime?.active && activeSelectionSessionToken === selectionSessionToken) {
    appendVoiceAudit({
      eventType: 'voice.cancel', sessionToken: selectionSessionToken, surface: voiceRuntime.active.surface,
      outcome: 'cancelled', cancellationReason: 'selection_session_invalidated',
    });
    voiceRuntime.stop(voiceRuntime.active.requestId, { cancel: true });
  }
  if (voiceFocusGuards.has(selectionSessionToken)) {
    finishVoiceFocusGuard('dismissed', selectionSessionToken);
  }
  cancelSessionChild(selectionSessionToken);
  invalidateActionProposalsForSession(selectionSessionToken);
  selectionSessions.cancel(selectionSessionToken);
  if (activeSelectionSessionToken === selectionSessionToken) activeSelectionSessionToken = null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance -> showPrimarySurface');
    showPrimarySurface({ activate: true });
  });
}

function trayNativeImage() {
  const iconPath = path.join(ROOT, 'assets', 'app', 'icon.ico');
  if (fs.existsSync(iconPath)) return iconPath;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <defs><linearGradient id="g" x1="4" y1="3" x2="28" y2="29" gradientUnits="userSpaceOnUse"><stop stop-color="#48A8FF"/><stop offset=".52" stop-color="#7475FF"/><stop offset="1" stop-color="#995FDF"/></linearGradient></defs>
    <rect x="2" y="2" width="28" height="28" rx="9" fill="url(#g)"/>
    <path d="M10 7.5v16.8l4.25-4.15 2.55 6.15 3.25-1.35-2.55-6.05h5.85L10 7.5Z" fill="white" stroke="white" stroke-width="1.35" stroke-linejoin="round"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: 20, height: 20 });
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const statusLabel = onboardingRequired ? '首次检查尚未完成' : inputPaused ? '已暂停' : '正在运行';
  tray.setToolTip(`Magic Pointer · ${statusLabel}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: onboardingRequired ? '继续首次设置' : '打开设置',
      click: () => showPrimarySurface({ activate: true }),
    },
    {
      label: inputPaused ? '恢复唤醒' : '暂停唤醒',
      enabled: !onboardingRequired,
      click: () => {
        inputPaused = !inputPaused;
        if (inputPaused) dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
        applyConfiguredWakeState();
        refreshTrayMenu();
      },
    },
    {
      label: updateManager?.status()?.state === 'checking'
        ? '正在检查更新…'
        : updateManager?.status()?.state === 'downloading'
          ? `正在下载更新 ${Math.round(updateManager.status().progress || 0)}%`
          : updateManager?.status()?.state === 'downloaded'
            ? '更新已下载，等待重启'
            : '检查更新…',
      enabled: !['checking', 'downloading'].includes(updateManager?.status()?.state),
      click: () => {
        initializeUpdateManager({ automatic: false });
        updateManager?.check({ manual: true });
      },
    },
    { type: 'separator' },
    {
      label: '退出 Magic Pointer',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(trayNativeImage());
  tray.on('click', () => {
    showPrimarySurface({ activate: true });
  });
  refreshTrayMenu();
  return tray;
}

function initializeUpdateManager({ automatic = true } = {}) {
  if (updateManager) return updateManager;
  let updater = null;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (error) {
    log(`update runtime unavailable ${error.name}: ${error.message}`);
    return null;
  }
  updateManager = createUpdateManager({
    app,
    updater,
    dialog,
    log,
    onStatus: () => refreshTrayMenu(),
  });
  updateManager.start({
    channel: fabricSettings?.general?.update_channel || 'stable',
    automatic,
  });
  refreshTrayMenu();
  return updateManager;
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;

  overlayReadiness.reset();
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayOwnsPointerInput = false;
  overlayWindow.webContents.on('did-start-loading', () => overlayReadiness.reset());

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayOwnsPointerInput = false;
    overlayReadiness.reset();
  });
}

function ensureFreshGestureOverlay() {
  // Electron (Windows) transparent overlays can stop delivering DOM pointer
  // events after a hide/show reuse cycle. Production logs show the second
  // gesture session never receives pointerdown even though gesture-ready
  // succeeded. Give every gesture session a freshly created window so the
  // input path starts clean (readiness gating waits for the new renderer).
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
  createOverlayWindow();
}

function createStageWindow() {
  if (stageWindow && !stageWindow.isDestroyed()) return stageWindow;
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;
  stageReadiness.reset();
  stageWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  stageWindow.setAlwaysOnTop(true, 'screen-saver');
  stageWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  stageWindow.loadFile(path.join(__dirname, 'renderer', 'stage.html'));
  stageWindow.setIgnoreMouseEvents(true, { forward: true });
  stageWindow.webContents.on('did-start-loading', () => stageReadiness.reset());
  stageWindow.on('closed', () => {
    stageWindow = null;
    stageReadiness.reset();
  });
  return stageWindow;
}

function placeStageOnDisplay(display) {
  const win = createStageWindow();
  const desired = display?.bounds;
  if (!desired) return win;
  const current = win.getBounds();
  if (
    current.x !== desired.x
    || current.y !== desired.y
    || current.width !== desired.width
    || current.height !== desired.height
  ) {
    win.setBounds(desired);
  }
  return win;
}

function selectionVisualForStage() {
  const visual = String(fabricSettings?.appearance?.selection_visual || 'sweep_band');
  return ['sweep_band', 'soft_glow', 'outline'].includes(visual) ? visual : 'sweep_band';
}

function stageVisualTuningForStage() {
  const appearance = fabricSettings?.appearance || {};
  return {
    sweepHeightRatio: Number(appearance.sweep_height_ratio ?? 0.52),
    sweepMinHeightDip: Number(appearance.sweep_min_height_dip ?? 10),
    sweepMaxHeightDip: Number(appearance.sweep_max_height_dip ?? 24),
    sweepDurationMs: Number(appearance.sweep_duration_ms ?? 292),
    sweepFadeMs: Number(appearance.sweep_fade_ms ?? 96),
    capsuleSpawnMs: Number(appearance.capsule_spawn_ms ?? 80),
    capsuleExpandMs: Number(appearance.capsule_expand_ms ?? 125),
    capsuleVoiceWidthDip: Number(appearance.capsule_voice_width_dip ?? 40),
    capsuleTextWidthDip: Number(appearance.capsule_text_width_dip ?? 144),
    capsuleMaxWidthDip: Number(appearance.capsule_max_width_dip ?? 440),
    capsuleInlineGapDip: Number(appearance.capsule_inline_gap_dip ?? 18),
  };
}

function showStage(payload = {}) {
  const win = createStageWindow();
  armTemporaryDismissShortcut();
  const trustedPayload = {
    ...payload,
    selectionVisual: selectionVisualForStage(),
    visualTuning: stageVisualTuningForStage(),
  };
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('stage:show', trustedPayload);
    if (!win.isVisible()) win.showInactive();
  };
  stageReadiness.whenReady(send);
}

function updateStage(payload = {}) {
  safeSurfaceSend('stage', 'stage:update', payload);
}

function hideStage() {
  if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) stageWindow.hide();
}

// The stage window is click-through by default; the renderer asks for real
// mouse capture only while an interactive surface (text capsule, result card,
// chips) is on screen.
function sanitizeStageHitRegions(rawRegions) {
  if (!stageWindow || stageWindow.isDestroyed() || !Array.isArray(rawRegions)) return [];
  const bounds = stageWindow.getBounds();
  const regions = [];
  for (const raw of rawRegions.slice(0, 16)) {
    const x = Math.max(0, Math.floor(Number(raw?.x)));
    const y = Math.max(0, Math.floor(Number(raw?.y)));
    const right = Math.min(bounds.width, Math.ceil(Number(raw?.x) + Number(raw?.width)));
    const bottom = Math.min(bounds.height, Math.ceil(Number(raw?.y) + Number(raw?.height)));
    if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) continue;
    regions.push({ x, y, width: right - x, height: bottom - y });
  }
  return regions;
}

function mergeStageHitRegions(previous, current) {
  const seen = new Set();
  return [...previous, ...current].filter((region) => {
    const key = `${region.x}:${region.y}:${region.width}:${region.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
}

function applyStageShape(regions) {
  if (!stageWindow || stageWindow.isDestroyed()) return;
  stageWindow.setShape(regions);
}

function setStageMouseCapture(enabled, requestFocus = false, rawRegions = undefined) {
  if (!stageWindow || stageWindow.isDestroyed()) return;
  const previousRegions = stageHitRegions;
  if (Array.isArray(rawRegions)) stageHitRegions = sanitizeStageHitRegions(rawRegions);
  const regions = stageHitRegions;
  if (typeof stageWindow.setShape === 'function' && ['win32', 'linux'].includes(process.platform)) {
    const transitionRegions = previousRegions.length && regions.length
      ? mergeStageHitRegions(previousRegions, regions)
      : regions;
    applyStageShape(transitionRegions);
    if (stageShapeSettleTimer) clearTimeout(stageShapeSettleTimer);
    stageShapeSettleTimer = setTimeout(() => {
      stageShapeSettleTimer = null;
      if (!stageWindow || stageWindow.isDestroyed()) return;
      applyStageShape(stageHitRegions);
    }, 34);
  }
  if (requestFocus) stageWindow.focus();
  if (enabled && regions.length) {
    stageWindow.setIgnoreMouseEvents(false);
  } else {
    stageWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

// Render-safe delivery: the stage receives only the contract projection of a
// bridge payload (no prompts, no raw parameters, no screenshots).
function deliverStageBridgeResult(selectionSessionToken, parsed) {
  lastStageResult = { token: selectionSessionToken || null, parsed: safeClone(parsed) };
  updateStage({
    selectionSessionToken: selectionSessionToken || null,
    event: stageEventFromBridge(parsed),
  });
}

function deliverStageError(selectionSessionToken, message) {
  updateStage({
    selectionSessionToken: selectionSessionToken || null,
    event: { type: 'ERROR', error: { message } },
  });
}

function dashboardMaterial(settings = fabricSettings) {
  if (settings?.accessibility?.reduce_transparency === true) return 'none';
  return settings?.appearance?.material === 'solid' ? 'none' : 'mica';
}

function applyDashboardMaterial(settings = fabricSettings) {
  if (process.platform !== 'win32' || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  try {
    dashboardWindow.setBackgroundMaterial(dashboardMaterial(settings));
  } catch (error) {
    log(`dashboard material unavailable ${error.name}`);
  }
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;
  dashboardWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: 'Magic Pointer',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? { height: 46 } : {
      color: 'rgba(1, 0, 0, 0)',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f5f7' : '#1d1d1f',
      height: 46,
    },
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
    backgroundMaterial: process.platform === 'win32' ? dashboardMaterial() : undefined,
    transparent: false,
    backgroundColor: process.platform === 'win32'
      ? '#00000000'
      : (nativeTheme.shouldUseDarkColors ? '#161719' : '#f5f5f7'),
    fullscreenable: true,
    resizable: true,
    movable: true,
    skipTaskbar: false,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  dashboardWindow.on('close', (event) => {
    if (!isQuitting && fabricSettings?.general?.keep_running !== false) {
      event.preventDefault();
      dashboardWindow.hide();
      if (!backgroundHintShown && tray && !tray.isDestroyed() && process.platform === 'win32') {
        backgroundHintShown = true;
        try {
          tray.displayBalloon({
            title: 'Magic Pointer 仍在后台运行',
            content: '从系统托盘可以暂停唤醒、重新打开设置或完全退出。',
            noSound: true,
          });
        } catch (_) {}
      }
    } else if (!isQuitting) {
      setImmediate(() => app.quit());
    }
  });
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
  return dashboardWindow;
}

function showDashboard(payload = {}, options = {}) {
  const win = createDashboardWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea || display.bounds;
  const width = Math.min(1240, Math.max(960, workArea.width - 72));
  const height = Math.min(820, Math.max(680, workArea.height - 72));
  const bounds = {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
  };
  const reveal = () => {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    dashboardWindow.setBounds(bounds);
    if (options.activate === false) dashboardWindow.showInactive();
    else dashboardWindow.show();
    dashboardWindow.webContents.send('dashboard:show', payload);
    dashboardWindow.webContents.send('dashboard:voice-residency-status', latestVoiceRuntimeStatus);
    log(`showDashboard highlight=${payload.highlightItemId || 'none'}`);
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function createOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) return onboardingWindow;
  onboardingWindow = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 560,
    minHeight: 460,
    title: '设置 Magic Pointer',
    frame: false,
    roundedCorners: true,
    transparent: false,
    backgroundColor: '#f7f8fc',
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    show: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  onboardingWindow.setMenuBarVisibility(false);
  onboardingWindow.loadFile(path.join(__dirname, 'renderer', 'onboarding.html'));
  onboardingWindow.on('close', () => {
    if (onboardingRequired && !isQuitting) {
      preflightAbortController?.abort();
      isQuitting = true;
      setImmediate(() => app.quit());
    }
  });
  onboardingWindow.on('closed', () => { onboardingWindow = null; });
  return onboardingWindow;
}

function showOnboarding(payload = {}, options = {}) {
  const win = createOnboardingWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea || display.bounds;
  const width = Math.min(1040, Math.max(560, workArea.width - 48));
  const height = Math.min(700, Math.max(460, workArea.height - 48));
  const bounds = {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
  };
  const reveal = () => {
    if (!onboardingWindow || onboardingWindow.isDestroyed()) return;
    onboardingWindow.setBounds(bounds);
    if (options.activate === false) onboardingWindow.showInactive();
    else onboardingWindow.show();
    onboardingWindow.webContents.send('onboarding:show', {
      screen: onboardingPhase,
      ...payload,
    });
    log(`showOnboarding screen=${payload.screen || onboardingPhase}`);
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function showPrimarySurface(options = {}) {
  if (onboardingRequired) showOnboarding({}, options);
  else showDashboard({ view: 'general' }, options);
}

function panelGeometryForSession(entry) {
  const snapshot = entry?.snapshot || {};
  const context = snapshot.context || {};
  const artifacts = context.artifacts || {};
  const cursor = entry?.cursor || screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const stageBounds = placeStageOnDisplay(display).getBounds();
  const grounding = normalizeGroundingGeometry({
    pointer: snapshot.target_point,
    pointerSpace: snapshot.target_point_space,
    targetRects: artifacts.selection_rectangles || [],
    targetSpace: artifacts.selection_rectangles_coordinate_space || null,
    targetFormat: artifacts.selection_rectangles_format || null,
    targetKind: artifacts.selection_geometry_kind || null,
    captureRect: artifacts.capture_bbox || null,
    captureSpace: artifacts.capture_bbox_coordinate_space || null,
    captureFormat: artifacts.capture_bbox_format || null,
    stageBounds,
    screenApi: screen,
  });
  return {
    coordinateSpace: 'electron_dip',
    sourceCoordinateSpace: snapshot.target_point_space || null,
    anchorCursor: grounding.pointerDip || cursor,
    selectionRects: grounding.targetDipRects || [],
    stageBounds,
    stageTarget: grounding.stageTarget || null,
    targetGeometryKind: grounding.state,
    groundingReason: grounding.reason || null,
  };
}

function stageTargetForSession(entry) {
  const geometry = entry?.panelGeometry || panelGeometryForSession(entry);
  return {
    target: geometry.stageTarget || null,
    targetGeometryKind: geometry.targetGeometryKind || 'invalid',
  };
}

function hasVisibleTemporarySurface() {
  return Boolean(stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible());
}

function hasActiveSelectionCapture() {
  if (!activeSelectionSessionToken) return false;
  return selectionSessions.get(activeSelectionSessionToken)?.state === 'capturing';
}

function dismissTemporarySurfaces({ invalidateSession = true, hideObserver = false } = {}) {
  const sessionToken = activeSelectionSessionToken;
  log(`dismissTemporarySurfaces overlayOwnsPointerInput=${overlayOwnsPointerInput} armPresent=${Boolean(selectionGestureArm)}`);
  cancelSelectionGesture('dismissed', { hideSurface: false });
  stopDictation('stage');
  stopDictation('overlay');
  setStageMouseCapture(false);
  if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
    // Ask the stage to play its dismiss fade; it answers with stage:hidden.
    stageWindow.webContents.send('stage:hide');
  }
  if (invalidateSession) invalidateSelectionSession(sessionToken);
  disarmTemporaryDismissShortcut();
  lastStageResult = null;
  if (hideObserver) hideOverlay();
  log('dismissTemporarySurfaces');
}

function armTemporaryDismissShortcut() {
  temporarySurfaceButtons = Number(pointerInputState.buttons || 0);
  if (temporaryDismissShortcutRegistered) return true;
  try {
    temporaryDismissShortcutRegistered = globalShortcut.register('Escape', () => {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
    });
  } catch (_) {
    temporaryDismissShortcutRegistered = false;
  }
  log(`temporary Escape dismiss registered=${temporaryDismissShortcutRegistered}`);
  return temporaryDismissShortcutRegistered;
}

function disarmTemporaryDismissShortcut() {
  if (!temporaryDismissShortcutRegistered) return;
  try { globalShortcut.unregister('Escape'); } catch (_) {}
  temporaryDismissShortcutRegistered = false;
}

function queueActivationUntilSurfacesReady(reason) {
  createOverlayWindow();
  createStageWindow();
  pendingSurfaceActivation = {
    reason,
    requestedAt: Date.now(),
  };
  if (!surfaceReadinessWaitArmed) {
    surfaceReadinessWaitArmed = true;
    const replay = () => {
      if (!pendingSurfaceActivation || isQuitting) {
        surfaceReadinessWaitArmed = false;
        return;
      }
      if (!stageReadiness.isReady || !overlayReadiness.isReady) {
        surfaceReadinessWaitArmed = false;
        queueActivationUntilSurfacesReady(pendingSurfaceActivation.reason);
        return;
      }
      const pending = pendingSurfaceActivation;
      pendingSurfaceActivation = null;
      surfaceReadinessWaitArmed = false;
      log(`activation renderer warmup complete reason=${pending.reason} delay_ms=${Date.now() - pending.requestedAt}`);
      setImmediate(() => requestActivation(pending.reason));
    };
    stageReadiness.whenReady(() => overlayReadiness.whenReady(replay));
  }
  log(`activation queued renderer_warming reason=${reason}`);
  return 'renderer_warming';
}

function requestActivation(reason) {
  if (onboardingRequired) {
    log(`activation blocked onboarding_required reason=${reason}`);
    showOnboarding({}, { activate: true });
    return 'onboarding_required';
  }
  if (inputPaused) {
    log(`activation ignored paused reason=${reason}`);
    return 'paused';
  }
  if (!stageReadiness.isReady || !overlayReadiness.isReady) {
    return queueActivationUntilSurfacesReady(reason);
  }
  const decision = activationGate.decide({
    hasVisibleSurface: hasVisibleTemporarySurface() || Boolean(overlayWindow?.isVisible()),
    isActivationBusy: hasActiveSelectionCapture() || Boolean(selectionGestureArm),
  });
  log(`activation request reason=${reason} decision=${decision}`);
  if (decision === 'dismiss') {
    const continuingEpisode = interactionEpisodes.active();
    if (continuingEpisode && (reason === 'wiggle' || reason === 'shortcut-wake')) {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      armSelectionGesture(reason);
      return 'continue';
    }
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  } else if (decision === 'activate') {
    if (reason === 'wiggle' || reason === 'shortcut-wake') armSelectionGesture(reason);
    else beginSelectionSession(reason);
  }
  return decision;
}

function cleanupDictationStopFile(surface) {
  const stopFile = dictationStopFiles.get(surface);
  dictationStopFiles.delete(surface);
  if (!stopFile) return;
  try { fs.unlinkSync(stopFile); } catch (_) {}
}

function localWhisperModelName() {
  const value = String(process.env.MAGIC_POINTER_WHISPER_MODEL || 'tiny').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && !value.includes('..')
    ? value
    : 'tiny';
}

function voiceRuntimeConfig(settings = fabricSettings) {
  const interaction = settings?.interaction || {};
  const engine = String(interaction.voice_engine || 'auto').trim().toLowerCase() || 'auto';
  return {
    enabled: interaction.voice_resident_enabled !== false,
    memoryLimitMb: Number(interaction.voice_memory_limit_mb) || 1024,
    idleUnloadMs: Number(interaction.voice_idle_unload_ms) || 300000,
    root: ROOT,
    pythonExecutable: PYTHON_EXECUTABLE,
    pythonIsolated: PYTHON_ISOLATED,
    engine,
    modelName: engine === 'sense_voice' ? 'sense-voice-small' : localWhisperModelName(),
    settingsPath: fabricSettingsStore?.path || '',
  };
}

function sessionIdHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function appendVoiceAudit({ eventType, sessionToken, surface, engine, reused, measuredMemoryMb, latencyMs, outcome, errorCode, cancellationReason }) {
  const data = {
    eventType: String(eventType || 'voice.unknown').slice(0, 120),
    timestamp: new Date().toISOString(),
    sessionIdHash: sessionIdHash(sessionToken),
    surface: surface === 'stage' ? 'stage' : 'overlay',
    engine: String(engine || 'whisper-local').slice(0, 120),
    modelId: localWhisperModelName(),
    residentEnabled: fabricSettings?.interaction?.voice_resident_enabled !== false,
    reused: reused === true,
    memoryLimitMb: Number(fabricSettings?.interaction?.voice_memory_limit_mb) || 1024,
    measuredMemoryMb: Number.isFinite(measuredMemoryMb) ? measuredMemoryMb : null,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    idleUnloadMs: Number(fabricSettings?.interaction?.voice_idle_unload_ms) || 300000,
    outcome: String(outcome || 'unknown').slice(0, 80),
    errorCode: errorCode ? String(errorCode).slice(0, 120) : null,
    cancellationReason: cancellationReason ? String(cancellationReason).slice(0, 120) : null,
  };
  try {
    const auditPath = path.join(FABRIC_DATA_DIR, 'fabric-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify({
      eventId: crypto.randomUUID(), timestamp: data.timestamp, type: 'voice.residency', data,
    })}\n`, 'utf8');
    return true;
  } catch (error) {
    log(`voice audit persist failed ${error.name}`);
    return false;
  }
}

function sendVoiceRuntimeStatus(status = {}) {
  if (status.workerEvent && !appendVoiceAudit({
    eventType: `voice.${status.workerEvent.reason || status.workerEvent.type || 'status'}`,
    surface: 'stage', engine: status.workerEvent.engine, measuredMemoryMb: Number(status.workerEvent.memory_mb),
    outcome: status.state === 'error' ? 'failed' : 'completed', errorCode: status.errorCode,
  })) {
    status = { ...status, state: 'error', errorCode: 'voice_audit_failed' };
  }
  const previousRuntimeState = JSON.stringify({
    state: latestVoiceRuntimeStatus?.state,
    errorCode: latestVoiceRuntimeStatus?.errorCode,
    residentEnabled: latestVoiceRuntimeStatus?.residentEnabled,
  });
  latestVoiceRuntimeStatus = safeClone(status);
  const nextRuntimeState = JSON.stringify({
    state: latestVoiceRuntimeStatus?.state,
    errorCode: latestVoiceRuntimeStatus?.errorCode,
    residentEnabled: latestVoiceRuntimeStatus?.residentEnabled,
  });
  if (previousRuntimeState !== nextRuntimeState) invalidateRuntimeState('voice_worker_changed');
  safeSurfaceSend('dashboard', 'dashboard:voice-residency-status', status);
}

function forwardResidentVoiceEvent(event = {}) {
  const active = voiceRuntime?.active;
  if (!active || event.requestId !== active.requestId) return;
  const sessionToken = activeSelectionSessionToken;
  const startedAt = active.startedAt || Date.now();
  const common = {
    eventType: `voice.${event.type || 'unknown'}`,
    sessionToken,
    surface: active.surface,
    engine: event.engine,
    reused: event.reused === true,
    measuredMemoryMb: Number(event.memory_mb),
    latencyMs: Date.now() - startedAt,
    outcome: event.type === 'error' ? 'failed' : event.type === 'microphone_stopped' ? 'stopped' : 'accepted',
    errorCode: event.code,
  };
  if (!appendVoiceAudit(common)) {
    safeSurfaceSend(active.surface, 'dictation:result', { ok: false, surface: active.surface, error: '本地语音审计写入失败，已停止本次会话。' });
    voiceRuntime.shutdown();
    return;
  }
  if (event.type === 'loading' || event.type === 'ready') {
    observeVoiceFocusPhase(event.type);
    safeSurfaceSend(active.surface, 'dictation:result', { ok: true, surface: active.surface, status: event.type, engine: event.engine || 'whisper-local', reused: event.reused === true });
  } else if (event.type === 'partial' || event.type === 'final') {
    observeVoiceFocusPhase(event.type);
    safeSurfaceSend(active.surface, 'dictation:result', { ok: true, surface: active.surface, transcript: String(event.transcript || ''), final: event.type === 'final', engine: event.engine || 'whisper-local' });
  } else if (event.type === 'error') {
    observeVoiceFocusPhase('error');
    safeSurfaceSend(active.surface, 'dictation:result', { ok: false, surface: active.surface, error: String(event.error || '本地语音识别失败。'), engine: event.engine || 'whisper-local' });
  }
}

function configureVoiceRuntime(settings, { preload = false } = {}) {
  if (!voiceRuntime) return { ok: false, error: 'voice_runtime_unavailable' };
  const result = voiceRuntime.configure(voiceRuntimeConfig(settings));
  if (
    result.ok
    && preload
    && result.changed
    && settings?.interaction?.voice_resident_enabled !== false
  ) voiceRuntime.warmUp();
  return result;
}

function scheduleStartupVoiceWarmup(configResult) {
  if (
    startupVoiceWarmupScheduled
    || !configResult?.ok
    || fabricSettings?.interaction?.voice_resident_enabled === false
  ) return false;
  startupVoiceWarmupScheduled = true;
  stageReadiness.whenReady(() => {
    overlayReadiness.whenReady(() => {
      if (isQuitting) return;
      const started = voiceRuntime?.warmUp() === true;
      log(`voice startup warmup renderers_ready=true started=${started}`);
    });
  });
  return true;
}

function stopLegacyDictation({ surface, graceful = false } = {}) {
  const child = dictationChildren.get(surface);
  if (!child) return false;
  if (graceful) {
    const stopFile = dictationStopFiles.get(surface);
    if (!stopFile) return false;
    try {
      fs.mkdirSync(path.dirname(stopFile), { recursive: true });
      fs.writeFileSync(stopFile, 'stop\n', { encoding: 'utf8', flag: 'wx' });
      observeVoiceFocusPhase('stop_requested');
    } catch (error) {
      if (error?.code !== 'EEXIST') log(`dictation stop request failed ${error.name}`);
    }
    return true;
  }
  dictationChildren.delete(surface);
  cleanupDictationStopFile(surface);
  try { if (!child.killed) child.kill(); } catch (_) {}
  return true;
}

function stopDictation(surface, { graceful = false } = {}) {
  if (voiceRuntime?.active?.surface === surface) {
    return voiceRuntime.stop(voiceRuntime.active.requestId, { graceful, cancel: !graceful });
  }
  return stopLegacyDictation({ surface, graceful, cancel: !graceful });
}

function sendCursorToOverlay(pos = screen.getCursorScreenPoint()) {
  if (!overlayWindow || !overlayWindow.isVisible()) return;
  const display = screen.getDisplayNearestPoint(pos);
  const desired = display.bounds;
  const current = overlayWindow.getBounds();
  if (
    current.x !== desired.x
    || current.y !== desired.y
    || current.width !== desired.width
    || current.height !== desired.height
  ) {
    overlayWindow.setBounds(desired);
  }
  const bounds = overlayWindow.getBounds();
  overlayWindow.webContents.send('overlay:cursor', {
    x: pos.x - bounds.x,
    y: pos.y - bounds.y,
    globalX: pos.x,
    globalY: pos.y,
  });
}


function showOverlay(reason = 'manual', durationMs = 0) {
  if (!overlayWindow) return;
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  overlayWindow.setBounds(display.bounds);
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayOwnsPointerInput = false;
  overlayWindow.showInactive();
  overlayWindow.webContents.send('overlay:show', { reason, observerMode: true });
  sendCursorToOverlay(cursor);
  log(`showOverlay observer reason=${reason} cursor=${cursor.x},${cursor.y}`);
  if (durationMs > 0) {
    overlayHideTimer = setTimeout(() => hideOverlay(), durationMs);
  }
}

function showRuntimeIssueOverlay(reason = 'runtime-issue') {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (activeSelectionSessionToken) invalidateSelectionSession(activeSelectionSessionToken);
  dismissTemporarySurfaces({ invalidateSession: false, hideObserver: false });
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  if (typeof overlayWindow.setFocusable === 'function') overlayWindow.setFocusable(true);
  overlayWindow.setBounds(display.bounds);
  overlayWindow.setIgnoreMouseEvents(false);
  overlayOwnsPointerInput = true;
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send('overlay:show', {
    reason,
    observerMode: false,
    workflow: 'runtime_issue',
  });
  sendCursorToOverlay(cursor);
  log(`showRuntimeIssueOverlay reason=${reason} cursor=${cursor.x},${cursor.y}`);
}

function hideOverlay() {
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  if (!overlayWindow) return;
  overlayWindow.webContents.send('overlay:hide');
  overlayWindow.hide();
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayOwnsPointerInput = false;
  if (typeof overlayWindow.setFocusable === 'function') overlayWindow.setFocusable(false);
  log('hideOverlay');
}

function cancelSelectionGesture(reason = 'cancelled', { hideSurface = true } = {}) {
  const active = selectionGestureArm;
  passThroughGestureCapture.cancel();
  if (selectionGestureArmTimer) clearTimeout(selectionGestureArmTimer);
  if (selectionGestureExpiryTimer) clearTimeout(selectionGestureExpiryTimer);
  selectionGestureArmTimer = null;
  selectionGestureExpiryTimer = null;
  selectionGestureArm = null;
  if (hideSurface) hideOverlay();
  if (!stageWindow || stageWindow.isDestroyed() || !stageWindow.isVisible()) {
    disarmTemporaryDismissShortcut();
  }
  if (active) log(`selection gesture ${reason} token=${active.token}`);
  return active;
}

function armSelectionGesture(reason = 'wiggle') {
  cancelSelectionGesture('replaced');
  ensureFreshGestureOverlay();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const now = Date.now();
  const token = crypto.randomUUID();
  const runtime = gestureRuntimeContract(fabricSettings);
  const armDelayMs = runtime.armDelayMs;
  const timeoutMs = runtime.timeoutMs;
  selectionGestureArm = {
    token,
    reason,
    runtime,
    armedAt: now,
    readyAt: now + armDelayMs,
    expiresAt: now + timeoutMs,
    armDelayMs,
    timeoutMs,
    displayBounds: { ...display.bounds },
    source: {
      foregroundApp: String(pointerInputState.foregroundApp || ''),
      foregroundHwnd: Number(pointerInputState.foregroundHwnd || 0),
      foregroundProcessId: Number(pointerInputState.foregroundProcessId || 0),
    },
  };
  if (runtime.interactionMode === 'pass_through') {
    passThroughGestureCapture.arm({
      token,
      displayBounds: display.bounds,
      initialButtons: Number(pointerInputState.buttons || 0),
      source: selectionGestureArm.source,
    });
  }
  // Warm the hidden capsule renderer during the arm grace period. By the time
  // the user releases a stroke it can paint immediately without startup jank.
  const residentStage = createStageWindow();
  armTemporaryDismissShortcut();

  const reveal = () => {
    const arm = selectionGestureArm;
    if (!arm || arm.token !== token) return;
    if (Date.now() >= arm.expiresAt) {
      cancelSelectionGesture('expired');
      return;
    }
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    const win = overlayWindow;
    if (!win || win.isDestroyed()) return;
    const show = () => {
      if (!selectionGestureArm || selectionGestureArm.token !== token) return;
      win.setBounds(arm.displayBounds);
      if (typeof win.setFocusable === 'function') win.setFocusable(false);
      // Standby: click-through so user can interact with app below.
      // The renderer will request pointer ownership via gesture-ready after
      // it has reset its internal state — only then do we intercept mouse.
      win.setIgnoreMouseEvents(true, { forward: true });
      overlayOwnsPointerInput = false;
      win.showInactive();
      win.webContents.send('overlay:show', {
        reason,
        workflow: 'selection_gesture',
        gestureMode: true,
        observerMode: false,
        selectionGestureToken: token,
        gestureAcceptAt: arm.readyAt,
        gestureLineStyle: arm.runtime.lineStyle,
        gestureLineWidth: arm.runtime.lineWidthDip,
        gestureInteractionMode: arm.runtime.interactionMode,
      });
      if (arm.runtime.interactionMode === 'pass_through') {
        log(
          `selection gesture ready token=${token} delay_ms=${Date.now() - arm.armedAt}`
          + ` mode=${arm.runtime.interactionMode}`
          + ` style=${arm.runtime.lineStyle} width_dip=${arm.runtime.lineWidthDip}`,
        );
      }
    };
    stageReadiness.whenReady(() => overlayReadiness.whenReady(show));
  };

  // Capture the next pointerdown immediately. The renderer honors readyAt for
  // visual grace, but an early press-and-hold is retained instead of lost.
  log(`selection gesture armed reason=${reason} token=${token}`);
  reveal();
  selectionGestureExpiryTimer = setTimeout(() => {
    if (selectionGestureArm?.token === token) cancelSelectionGesture('expired');
  }, timeoutMs);
  return token;
}

function markSelectionGestureDrawing(token) {
  const arm = selectionGestureArm;
  if (!arm || String(token || '') !== arm.token) return false;
  if (selectionGestureExpiryTimer) clearTimeout(selectionGestureExpiryTimer);
  selectionGestureExpiryTimer = setTimeout(() => {
    if (selectionGestureArm?.token === arm.token) cancelSelectionGesture('draw_timeout');
  }, Number(arm.timeoutMs || SELECTION_GESTURE_TIMEOUT_MS));
  log(`selection gesture drawing token=${arm.token}`);
  return true;
}

function completeSelectionGesture(payload) {
  const arm = selectionGestureArm;
  if (!arm || String(payload?.selectionGestureToken || '') !== arm.token) {
    cancelSelectionGesture('stale');
    return false;
  }
  const summary = summarizeGesture(payload?.points);
  if (!summary.valid) {
    cancelSelectionGesture(summary.reason || 'invalid');
    return false;
  }
  // Per-point display lookup: each point's physical coordinate is computed
  // against the display that contains it, not a single global scale factor.
  // Formula: X_phys = Screen_Physical_Origin + (Local_Logical_X × sf_display)
  // This prevents nonlinear origin shift when displays have different scale
  // factors (e.g. primary 100%, secondary 150%).
  const toPhysical = (point) => {
    const px = Number(point.x);
    const py = Number(point.y);
    const pointDisplay = screen.getDisplayNearestPoint({ x: px, y: py });
    const pointSf = pointDisplay.scaleFactor || 1;
    const physicalOriginX = pointDisplay.bounds.x * pointSf;
    const physicalOriginY = pointDisplay.bounds.y * pointSf;
    const localX = px - pointDisplay.bounds.x;
    const localY = py - pointDisplay.bounds.y;
    return {
      x: Math.round(physicalOriginX + localX * pointSf),
      y: Math.round(physicalOriginY + localY * pointSf),
    };
  };
  const physicalPoints = summary.points.map((point) => ({ ...toPhysical(point), t: point.t }));
  const physicalStrokes = summary.strokes.map((stroke) => ({
    points: stroke.points.map((point) => ({ ...toPhysical(point), t: point.t })),
  }));
  const allPhysical = physicalStrokes.length
    ? physicalStrokes.flatMap((s) => s.points)
    : physicalPoints;
  const xs = allPhysical.map((p) => p.x);
  const ys = allPhysical.map((p) => p.y);
  const armDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const gesture = {
    schemaVersion: 2,
    coordinateSpace: 'physical_screen_pixels',
    points: physicalPoints,
    strokes: physicalStrokes,
    bbox: allPhysical.length
      ? { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
      : { x: 0, y: 0, width: 0, height: 0 },
    kind: summary.kind,
    semanticPoint: summary.semanticPoint
      ? toPhysical(summary.semanticPoint)
      : undefined,
    releasePoint: toPhysical(summary.releasePoint),
    // Stroke region geometry (logical DIPs): polygon ring for circles,
    // bandwidth corridor for lines/freeforms. Used by grounding to rank
    // targets by region coverage instead of a single point.
    geometry: summary.geometry || undefined,
    direction: summary.direction || undefined,
    displayBounds: { ...armDisplay.bounds },
    scaleFactor: armDisplay.scaleFactor || 1,
    source: { ...arm.source },
  };
  const reason = arm.reason;
  cancelSelectionGesture('completed');
  // One compositor frame after hiding the drawing canvas prevents it from
  // entering pixel fallback captures. Stage remains absent during this gap.
  setTimeout(() => beginSelectionSession(reason, gesture), 34);
  return true;
}

function processPassThroughGestureSample(now, pos) {
  const arm = selectionGestureArm;
  if (!arm || arm.runtime.interactionMode !== 'pass_through') return false;
  const events = passThroughGestureCapture.push({
    t: now,
    x: pos.x,
    y: pos.y,
    buttons: Number(pointerInputState.buttons || 0),
  });
  for (const event of events) {
    if (event.type === 'started') {
      markSelectionGestureDrawing(event.token);
      safeSurfaceSend('overlay', 'overlay:gesture-input', {
        token: event.token,
        phase: 'start',
      });
    } else if (event.type === 'point') {
      safeSurfaceSend('overlay', 'overlay:gesture-input', {
        token: event.token,
        phase: 'point',
        point: event.point,
      });
    } else if (event.type === 'completed') {
      safeSurfaceSend('overlay', 'overlay:gesture-input', {
        token: event.token,
        phase: 'end',
      });
      setTimeout(() => completeSelectionGesture({
        workflow: 'selection_gesture',
        selectionGestureToken: event.token,
        points: event.points,
      }), 17);
    }
  }
  return events.length > 0;
}

function startMouseShakePolling() {
  if (mousePollTimer) return;
  if (!wiggleDetector) return;
  mousePollTimer = setInterval(() => {
    const now = Date.now();
    const pos = screen.getCursorScreenPoint();
    if (overlayWindow && overlayWindow.isVisible()) sendCursorToOverlay(pos);
    if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
      const stageBounds = stageWindow.getBounds();
      stageWindow.webContents.send('stage:pointer-input', {
        t: now,
        x: pos.x - stageBounds.x,
        y: pos.y - stageBounds.y,
        buttons: Number(pointerInputState.buttons || 0),
      });
    }
    const temporarySurfaceVisible = hasVisibleTemporarySurface() || Boolean(overlayWindow?.isVisible());
    const currentButtons = Number(pointerInputState.buttons || 0);
    const dismissFromGlobalPointer = shouldDismissFromGlobalPointer({
      currentButtons,
      previousButtons: temporarySurfaceButtons,
      hasVisibleTemporarySurface: temporarySurfaceVisible,
      interactiveOverlayOwnsPointer: overlayOwnsPointerInput && Boolean(overlayWindow?.isVisible()),
    });
    temporarySurfaceButtons = currentButtons;
    if (dismissFromGlobalPointer) {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      return;
    }
    processPassThroughGestureSample(now, pos);
    const pointerPolicy = currentPointerPollingPolicy();
    const mouseButtonMode = pointerPolicy.detectMouseButton
      ? (fabricSettings?.activation?.mouse_side_button || 'none')
      : 'none';
    const mouseActivationReason = mouseActivationDetector.push({
      t: now,
      buttons: pointerInputState.buttons,
      mode: mouseButtonMode,
    });
    if (mouseActivationReason) {
      requestActivation(mouseActivationReason);
      return;
    }
    if (!pointerPolicy.detectWiggle) return;
    // An active stage session owns the pointer; no re-triggering underneath it.
    if (hasVisibleTemporarySurface()) return;
    if (!overlayWindow || overlayWindow.isVisible()) return;
    const scrollDelta = pointerInputState.scrollDelta;
    pointerInputState.scrollDelta = 0;
    const decision = wiggleDetector.push({
      t: now,
      x: pos.x,
      y: pos.y,
      buttons: pointerInputState.buttons,
      foregroundApp: pointerInputState.foregroundApp,
      isWindowMoving: pointerInputState.isWindowMoving,
      scrollDelta,
    });
    if (
      process.env.MAGIC_POINTER_WIGGLE_TRACE === '1'
      && decision.reason !== 'idle'
      && decision.reason !== 'insufficient_samples'
      && now - lastWiggleTraceAt >= 80
    ) {
      lastWiggleTraceAt = now;
      log(`wiggle trace reason=${decision.reason} metrics=${JSON.stringify(decision.metrics || {})}`);
    }
    if (decision.triggered) {
      log(`wiggle accepted metrics=${JSON.stringify(decision.metrics)}`);
      requestActivation('wiggle');
    }
  }, 20);
  log('wiggle polling started');
}

function stopMouseShakePolling() {
  if (mousePollTimer) clearInterval(mousePollTimer);
  if (pointerStateRestartTimer) clearTimeout(pointerStateRestartTimer);
  pointerStateRestartTimer = null;
  mousePollTimer = null;
  try { if (pointerStateChild && !pointerStateChild.killed) pointerStateChild.kill(); } catch (_) {}
  pointerStateChild = null;
}

function applyConfiguredWakeState() {
  const policy = currentPointerPollingPolicy();
  mouseActivationDetector.reset(pointerInputState.buttons);
  if (policy.shouldPoll) {
    startPointerInputStateStream();
    startMouseShakePolling();
  } else {
    stopMouseShakePolling();
  }
  log(`pointer activation polling=${policy.shouldPoll} wiggle=${policy.detectWiggle} mouseButton=${policy.detectMouseButton} wakeMode=${fabricSettings?.activation?.wake_mode} paused=${inputPaused} sensitivity=${fabricSettings?.activation?.sensitivity}`);
  return policy.shouldPoll;
}

function currentPointerPollingPolicy() {
  const voiceStartStrategy = String(fabricSettings?.interaction?.voice_start_strategy || 'auto');
  return pointerPollingPolicy({
    wakeMode: fabricSettings?.activation?.wake_mode,
    wiggleEnabled: fabricSettings?.activation?.wiggle_enabled,
    mouseShakeOverride: process.env.MAGIC_POINTER_ENABLE_MOUSE_SHAKE,
    voicePointerConfigured: ['push_to_talk', 'hover'].includes(voiceStartStrategy),
    voiceStartStrategy,
    onboardingRequired,
    inputPaused,
  });
}

function inputModeForReason(reason) {
  if (reason === 'shortcut-text') return 'text';
  if (reason === 'shortcut-voice') return 'voice';
  return fabricSettings?.interaction?.default_input_mode === 'text' ? 'text' : 'voice';
}

function registerConfigurableHotkeys() {
  for (const accelerator of registeredConfigurableHotkeys) {
    try { globalShortcut.unregister(accelerator); } catch (_) {}
  }
  registeredConfigurableHotkeys.clear();
  const results = {};
  const register = (name, accelerator, handler, enabled = true) => {
    if (!enabled) {
      results[name] = { accelerator, registered: false, disabled: true };
      return;
    }
    let registered = false;
    try { registered = Boolean(accelerator && globalShortcut.register(accelerator, handler)); } catch (_) {}
    if (registered) registeredConfigurableHotkeys.add(accelerator);
    results[name] = { accelerator, registered };
    log(`register configurable hotkey name=${name} accelerator=${accelerator || '<empty>'} ok=${registered}`);
  };
  register('wake', fabricSettings.shortcuts?.wake || 'Control+Alt+M', () => {
    requestActivation('shortcut-wake');
  }, fabricSettings.activation?.fallback_hotkey_enabled !== false);
  register('text_mode', fabricSettings.shortcuts?.text_mode || 'Control+Alt+T', () => {
    requestActivation('shortcut-text');
  });
  register('voice_mode', fabricSettings.shortcuts?.voice_mode || 'Control+Alt+V', () => {
    requestActivation('shortcut-voice');
  });
  register('pause', fabricSettings.shortcuts?.pause || 'Control+Alt+P', () => {
    inputPaused = !inputPaused;
    if (inputPaused) dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
    applyConfiguredWakeState();
    refreshTrayMenu();
  });
  return results;
}

function stageSessionPayload(entry) {
  return {
    selectionSessionToken: entry.token,
    selectionSnapshotId: entry.snapshot?.snapshot_id || null,
    captureEligibility: entry.captureEligibility,
    defaultInputMode: inputModeForReason(entry.reason),
    voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit,
    voiceStartStrategy: fabricSettings.interaction.voice_start_strategy,
    groundingReady: Boolean(entry?.snapshot),
    sessionExpiresAt: entry.expiresAt,
  };
}

function episodeObjectForSession(entry) {
  const snapshot = entry?.snapshot || {};
  const context = snapshot.context || {};
  const sourceWindow = snapshot.source_window || {};
  return {
    snapshotId: String(snapshot.snapshot_id || ''),
    selectionSessionToken: entry?.token || '',
    app: String(context.app || entry?.summary?.app || ''),
    windowTitle: String(sourceWindow.title || context?.window?.title || ''),
    label: String(entry?.summary?.label || context.label || '当前选区'),
    kind: String(snapshot.source_kind || 'native_selection'),
    capturedAt: String(snapshot.captured_at || ''),
    expiresAt: String(snapshot.expires_at || ''),
    content: String(context.content || ''),
    bbox: snapshot.selection_bbox || snapshot.selection_rect || null,
    source: {
      app: String(context.app || entry?.summary?.app || ''),
      title: String(sourceWindow.title || context?.window?.title || ''),
      path: String(context.document_path || context.path || snapshot.capture_path || ''),
      annotatedPath: String(snapshot.annotated_path || ''),
      captureAttestation: snapshot.capture_attestation || null,
      perceptionTrace: snapshot.perception_trace || null,
      url: String(context.url || ''),
      page: Number(context.page),
      hwnd: Number(sourceWindow.hwnd),
      processId: Number(sourceWindow.process_id || sourceWindow.pid),
    },
  };
}

function bindEpisodeForCommand(session, command) {
  const mode = inferReferenceMode(command);
  const referenceLabel = inferReferenceLabel(command);
  const object = episodeObjectForSession(session);
  interactionEpisodes.bindCommandTarget(object, command);
  if (referenceLabel) interactionEpisodes.labelCurrent(referenceLabel);
  if (mode === 'these' || referenceLabel) interactionEpisodes.bindThese();
  const episode = interactionEpisodes.contextPayload();
  persistCurrentObjectEpisode(session);
  log(`interaction episode bind mode=${mode} episode=${episode?.episodeId || 'none'} session=${session?.token || 'none'}`);
  return episode;
}

function shouldContinueGestureEpisode(command, episode) {
  if (!episode) return false;
  const mode = inferReferenceMode(command);
  if (mode === 'here') return false;
  return mode === 'append' || ['add', 'move'].includes(episode.pendingIntent);
}

function composedEpisodeCommand(command, episode) {
  if (!episode || inferReferenceMode(command) !== 'here') return command;
  const sourceCount = Array.isArray(episode?.slots?.these) ? episode.slots.these.length : 0;
  if (!episode?.slots?.here || sourceCount < 1) return command;
  if (episode.pendingIntent === 'add') return 'add these here';
  if (episode.pendingIntent === 'move') return 'move these here';
  return command;
}

function beginSelectionSession(reason = 'manual', gesture = null) {
  if (activeSelectionSessionToken) invalidateSelectionSession(activeSelectionSessionToken);
  lastStageResult = null;

  const liveCursor = screen.getCursorScreenPoint();
  const releasePoint = gesture?.releasePoint || liveCursor;
  // completeSelectionGesture emits physical pixels; the stage window and
  // display APIs work in DIPs, so convert once before anchoring. Using a
  // physical point as DIP on scaled displays pushed the capsule past the
  // viewport edge and clamped it into the bottom-right corner.
  const releasePointDip = gesture?.releasePoint
    ? (typeof screen.screenToDipPoint === 'function'
      ? screen.screenToDipPoint({ x: releasePoint.x, y: releasePoint.y })
      : { x: Number(releasePoint.x) || 0, y: Number(releasePoint.y) || 0 })
    : liveCursor;
  const targetPoint = releasePointDip;
  const physicalCursor = physicalScreenPoint(screen, targetPoint);
  const physicalGesture = physicalGestureTrace(screen, gesture);
  const display = screen.getDisplayNearestPoint(targetPoint);
  const entry = selectionSessions.create({ reason, cursor: targetPoint });
  entry.gesture = gesture ? safeClone(gesture) : null;
  activeSelectionSessionToken = entry.token;
  const initialInputMode = inputModeForReason(reason);
  if (initialInputMode === 'voice') beginVoiceFocusGuard(entry.token);
  // Normal target capture is intentionally invisible. The old observer aura
  // repainted a full-display canvas at 30 FPS while grounding ran, producing
  // startup jank and stale compositor artifacts on high-DPI displays.
  hideOverlay();
  let stageBounds = display.bounds;
  if (gesture) {
    // Release commits the gesture. Open the capsule immediately; grounding is
    // asynchronous and later enriches this already-visible session.
    stageBounds = placeStageOnDisplay(display).getBounds();
    showStage({
      ...stageSessionPayload(entry),
      groundingReady: false,
      reason,
      selectionSource: selectionSourceForReason(reason),
      targetGeometryKind: 'pointer_only',
      target: null,
      capsuleAnchor: 'pointer',
      capsuleDelayMs: 0,
      pointer: {
        x: targetPoint.x - stageBounds.x,
        y: targetPoint.y - stageBounds.y,
      },
      eventSequence: [
        { type: 'FREEZE', target: null },
        { type: 'OPEN_CAPSULE', mode: initialInputMode },
      ],
    });
    armTemporaryDismissShortcut();
  } else {
    // Shortcut/native-selection paths retain immediate targeting.
    stageBounds = placeStageOnDisplay(display).getBounds();
    showStage({
      reason,
      selectionSessionToken: entry.token,
      selectionSource: selectionSourceForReason(reason),
      defaultInputMode: initialInputMode,
      voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit,
      voiceStartStrategy: fabricSettings.interaction.voice_start_strategy,
      targetGeometryKind: 'pointer_only',
      pointer: {
        x: targetPoint.x - stageBounds.x,
        y: targetPoint.y - stageBounds.y,
      },
      target: null,
    });
    armTemporaryDismissShortcut();
  }
  log(`selection session capture start reason=${reason} token=${entry.token}`);

  let child = null;
  child = runPythonBridge(
    {
      mode: 'capture_selection_snapshot',
      reason,
      cursor: physicalCursor,
      cursorSpace: physicalCursor ? 'physical_screen_pixels' : null,
      gesture: physicalGesture ? safeClone(physicalGesture) : null,
      screenBounds: display.bounds,
      scaleFactor: display.scaleFactor || 1,
      foregroundApp: gesture?.source?.foregroundApp || pointerInputState.foregroundApp,
      foregroundHwnd: gesture?.source?.foregroundHwnd || pointerInputState.foregroundHwnd,
      allowVisualFallback: true,
    },
    'scripts/selection_snapshot_bridge.py',
    'panel',
    {
      onComplete: (parsed) => {
        if (activeSessionChildren.get(entry.token) === child) activeSessionChildren.delete(entry.token);
        const current = selectionSessions.get(entry.token);
        if (!current || activeSelectionSessionToken !== entry.token) return;
        const attached = selectionSessions.attachSnapshot(entry.token, parsed);
        if (!attached) return;
        interactionEpisodes.bindPointedObject(episodeObjectForSession(attached));
        persistCurrentObjectEpisode(attached);
        attached.captureEligibility = captureEligibility({
          snapshot: attached.snapshot,
          summary: attached.summary,
          reason: current.reason,
        });
        const laidOut = selectionSessions.setPanelLayout(entry.token, {
          nonce: crypto.randomUUID(),
          geometry: panelGeometryForSession(attached),
        });
        if (!laidOut) return;
        log(`selection session capture done token=${entry.token} status=${attached.snapshot?.status || 'missing'} app=${attached.summary?.app || 'none'}`);
        const frozenTarget = stageTargetForSession(laidOut);
        const mode = current.reason === 'shortcut-text'
          ? 'text'
          : current.reason === 'shortcut-voice'
            ? 'voice'
            : (fabricSettings.interaction.default_input_mode === 'text' ? 'text' : 'voice');
        if (gesture) {
          updateStage({
            ...stageSessionPayload(laidOut),
            groundingReady: true,
            selectionSource: selectionSourceForReason(current.reason),
            objectKind: inferObjectKind(attached.snapshot),
            targetGeometryKind: 'pointer_only',
            target: null,
          });
          return;
        }
        updateStage({
          ...stageSessionPayload(laidOut),
          selectionSource: selectionSourceForReason(current.reason),
          objectKind: inferObjectKind(attached.snapshot),
          targetGeometryKind: frozenTarget.targetGeometryKind,
          event: { type: 'FREEZE', target: frozenTarget.target },
        });
        if (frozenTarget.targetGeometryKind === 'invalid') {
          deliverStageError(entry.token, '目标坐标无法验证，请重新选择。');
          return;
        }
        if (!attached.captureEligibility?.commandReady) {
          // Honest failure: the capsule never opens over an unusable selection.
          deliverStageError(entry.token, attached.captureEligibility?.message || '当前选区不可用，请重新选择。');
          return;
        }
        updateStage({
          selectionSessionToken: entry.token,
          event: { type: 'OPEN_CAPSULE', mode },
        });
      },
    },
  );
  if (child) activeSessionChildren.set(entry.token, child);
}

app.whenReady().then(() => {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  } catch (_) {}
  log(`app ready pid=${process.pid}`);
  for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(eventName, () => invalidateRuntimeState('display_configuration_changed'));
  }
  if (process.platform === 'win32') app.setAppUserModelId('com.magicpointer.desktop');
  fabricSettingsStore = new ElectronSettingsStore(path.join(FABRIC_DATA_DIR, 'fabric-settings.json'));
  credentialStore = new CredentialStore(path.join(FABRIC_DATA_DIR, 'credentials.v1.json'), safeStorage);
  try {
    fabricSettings = fabricSettingsStore.load();
  } catch (error) {
    fabricSettings = defaultSettings();
    log(`settings load failed closed ${error.name}: ${error.message}`);
  }
  voiceRuntime = new VoiceResidentRuntime({
    startLegacy: startLegacyDictation,
    stopLegacy: stopLegacyDictation,
    onDeliver: forwardResidentVoiceEvent,
    onStatus: sendVoiceRuntimeStatus,
  });
  const voiceRuntimeStart = configureVoiceRuntime(fabricSettings, { preload: false });
  if (!voiceRuntimeStart.ok) log(`voice runtime startup rejected ${voiceRuntimeStart.error}`);
  const requiredPaths = [
    path.join(ROOT, 'scripts', 'fabric_bridge.py'),
    path.join(ROOT, 'electron', 'renderer', 'stage.html'),
    ...(PYTHON_RUNTIME.required === true ? [PYTHON_EXECUTABLE] : []),
  ];
  const onboardingReadiness = inspectOnboardingReadiness({
    markerPath: ONBOARDING_MARKER_PATH,
    bootstrapVersion: ONBOARDING_BOOTSTRAP_VERSION,
    requiredPaths,
  });
  onboardingRequired = !onboardingReadiness.ready;
  log(`onboarding readiness ready=${onboardingReadiness.ready} reason=${onboardingReadiness.reason}`);
  try {
    app.setLoginItemSettings({ openAtLogin: fabricSettings.general?.launch_at_login === true });
  } catch (error) {
    log(`login item settings failed ${error.name}`);
  }
  wiggleDetector = new WiggleDetector({
    sensitivity: fabricSettings.activation.sensitivity,
    disabledApps: fabricSettings.activation.disabled_apps,
    cooldownMs: fabricSettings.activation.cooldown_ms,
  });
  const wiggleEvidencePath = String(process.env.MAGIC_POINTER_N18_WIGGLE_EVIDENCE_PATH || '').trim();
  if (!app.isPackaged && wiggleEvidencePath) {
    try {
      const evidence = runDeterministicWiggleEvidence({
        runId: 'n18-detector-regression',
        expectedTrials: 100,
        detectorOptions: {
          sensitivity: fabricSettings.activation.sensitivity,
          disabledApps: [],
          cooldownMs: fabricSettings.activation.cooldown_ms,
        },
      });
      const resolvedEvidencePath = path.resolve(wiggleEvidencePath);
      fs.mkdirSync(path.dirname(resolvedEvidencePath), { recursive: true });
      fs.writeFileSync(resolvedEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      process.stdout.write(`${resolvedEvidencePath}\nalgorithmPass=${evidence.pass}\nphysicalInputValidated=false\n`);
    } catch (error) {
      process.stderr.write(`n18_wiggle_evidence_failed:${error.name}:${error.message}\n`);
      process.exitCode = 1;
    } finally {
      setImmediate(() => app.quit());
    }
    return;
  }
  createOverlayWindow();
  createStageWindow();
  createTray();
  registerConfigurableHotkeys();
  const deliveryHotkeyOk = globalShortcut.register('Control+Alt+Enter', () => {
    requestActivation('runtime-delivery');
  });
  log(`register hotkey Control+Alt+Enter runtime-delivery ok=${deliveryHotkeyOk}`);
  const legacySelectionHotkeyOk = globalShortcut.register('Control+Alt+Shift+M', () => {
    requestActivation('legacy-native-selection');
  });
  log(`register hotkey Control+Alt+Shift+M legacy-selection ok=${legacySelectionHotkeyOk}`);
  const dashboardHotkeyOk = globalShortcut.register('Control+Alt+D', () => {
    if (onboardingRequired) showOnboarding({}, { activate: true });
    else if (dashboardWindow?.isVisible()) dashboardWindow.hide();
    else showDashboard({}, { activate: true });
  });
  log(`register hotkey Control+Alt+D dashboard ok=${dashboardHotkeyOk}`);
  applyConfiguredWakeState();
  refreshTrayMenu();
  if (app.isPackaged && (
    process.env.MAGIC_POINTER_DASHBOARD_CAPTURE
    || process.env.MAGIC_POINTER_N17_FOCUS_EVIDENCE_PATH
    || process.env.MAGIC_POINTER_N18_WIGGLE_EVIDENCE_PATH
  )) {
    log('ignoring MAGIC_POINTER_* evidence/capture hooks: packaged builds never run test hooks');
  }
  const captureMode = Boolean(
    !app.isPackaged
    && (process.env.MAGIC_POINTER_DASHBOARD_CAPTURE
      || process.env.MAGIC_POINTER_N17_FOCUS_EVIDENCE_PATH
      || process.env.MAGIC_POINTER_N18_WIGGLE_EVIDENCE_PATH)
  );
  if (!captureMode && !onboardingRequired) scheduleStartupVoiceWarmup(voiceRuntimeStart);
  if (!captureMode) initializeUpdateManager({ automatic: true });
  let wasOpenedAtLogin = false;
  try { wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin === true; } catch (_) {}
  const startHidden = shouldStartHidden({ argv: process.argv.slice(1), wasOpenedAtLogin, captureMode });
  if (onboardingRequired && !captureMode) showOnboarding({}, { activate: true });
  else if (!startHidden) showDashboard({ view: 'general' }, { activate: true });
  let focusEvidencePath = String(process.env.MAGIC_POINTER_N17_FOCUS_EVIDENCE_PATH || '').trim();
  if (!app.isPackaged && focusEvidencePath) {
    focusEvidencePath = path.resolve(focusEvidencePath);
    const focusEvidenceStartDelay = Math.max(800, Math.min(
      Number(process.env.MAGIC_POINTER_N17_FOCUS_START_DELAY_MS || 1500),
      10000,
    ));
    const focusEvidenceDuration = Math.max(4000, Math.min(
      Number(process.env.MAGIC_POINTER_N17_FOCUS_DURATION_MS || 12000),
      30000,
    ));
    setTimeout(async () => {
      const foregroundDeadline = Date.now() + 10000;
      while (Number(pointerInputState.foregroundHwnd || 0) <= 0 && Date.now() < foregroundDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const decision = requestActivation('shortcut-voice');
      const evidenceSessionToken = activeSelectionSessionToken;
      log(`N17 focus evidence activation decision=${decision}`);
      setTimeout(() => {
        try {
          if (voiceFocusGuards.has(evidenceSessionToken)) {
            finishVoiceFocusGuard('evidence_timeout', evidenceSessionToken);
          }
          const evidence = latestVoiceFocusEvidence || {
            sessionId: String(evidenceSessionToken || ''),
            expectedHwnd: 0,
            contract: 'foreground-hwnd-stable',
            invariant: false,
            violationCount: 1,
            violations: [{
              phase: 'evidence', expectedHwnd: 0, observedHwnd: 0, timestamp: Date.now(),
            }],
            phases: [],
            startedAt: Date.now(),
            finishedAt: Date.now(),
            failure: 'voice_focus_evidence_unavailable',
          };
          const envelope = {
            schemaVersion: 1,
            platform: process.platform,
            activationDecision: decision,
            observedForegroundHwnd: Number(pointerInputState.foregroundHwnd || 0),
            evidence,
          };
          fs.mkdirSync(path.dirname(focusEvidencePath), { recursive: true });
          fs.writeFileSync(focusEvidencePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
          process.stdout.write(`${focusEvidencePath}\ninvariant=${evidence.invariant}\n`);
          if (evidence.invariant !== true) process.exitCode = 1;
        } catch (error) {
          process.stderr.write(`n17_focus_evidence_failed:${error.name}:${error.message}\n`);
          process.exitCode = 1;
        } finally {
          app.quit();
        }
      }, focusEvidenceDuration);
    }, focusEvidenceStartDelay);
  }
  const dashboardCapturePath = String(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE || '').trim();
  if (!app.isPackaged && dashboardCapturePath) {
    const captureView = String(process.env.MAGIC_POINTER_DASHBOARD_VIEW || 'activity');
    const captureAnchor = String(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE_ANCHOR || '').trim();
    const captureProvenanceObjectId = String(
      process.env.MAGIC_POINTER_DASHBOARD_PROVENANCE_OBJECT_ID || '',
    ).trim();
    const captureSkillCandidateId = String(
      process.env.MAGIC_POINTER_DASHBOARD_SKILL_CANDIDATE_ID || '',
    ).trim();
    const captureDelay = Math.max(1000, Math.min(
      Number(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE_DELAY_MS || 4500),
      15000,
    ));
    showDashboard({ view: captureView, onboardingRequired }, { activate: false });
    setTimeout(async () => {
      try {
        if (captureProvenanceObjectId) {
          await dashboardWindow.webContents.executeJavaScript(
            `fabricRequest('provenance.trace', { objectId: ${JSON.stringify(captureProvenanceObjectId)} })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        if (captureSkillCandidateId) {
          await dashboardWindow.webContents.executeJavaScript(
            `fabricRequest('skills.candidates.draft', { candidateId: ${JSON.stringify(captureSkillCandidateId)} })`,
          );
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
        if (captureAnchor) {
          await dashboardWindow.webContents.executeJavaScript(`(() => {
            const target = document.getElementById(${JSON.stringify(captureAnchor)});
            if (!target) return false;
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const image = await dashboardWindow.capturePage();
        fs.mkdirSync(path.dirname(path.resolve(dashboardCapturePath)), { recursive: true });
        fs.writeFileSync(path.resolve(dashboardCapturePath), image.toPNG());
        process.stdout.write(`${path.resolve(dashboardCapturePath)}\nview=${captureView}\n`);
      } catch (error) {
        process.stderr.write(`dashboard_capture_failed:${error.name}:${error.message}\n`);
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    }, captureDelay);
  }
});

app.on('will-quit', () => {
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
  globalShortcut.unregisterAll();
  temporaryDismissShortcutRegistered = false;
  if (mousePollTimer) clearInterval(mousePollTimer);
  if (wiggleCalibrationTimer) clearTimeout(wiggleCalibrationTimer);
  voiceRuntime?.shutdown();
  try { if (pointerStateChild && !pointerStateChild.killed) pointerStateChild.kill(); } catch (_) {}
  pointerStateChild = null;
  for (const child of dictationChildren.values()) {
    try { if (child && !child.killed) child.kill(); } catch (_) {}
  }
  dictationChildren.clear();
  for (const surface of dictationStopFiles.keys()) cleanupDictationStopFile(surface);
  updateManager?.dispose();
  try { stageWindow?.close(); } catch (_) {}
  try { dashboardWindow?.close(); } catch (_) {}
  try { tray?.destroy(); } catch (_) {}
  tray = null;
  log('app will quit');
});
app.on('before-quit', () => { isQuitting = true; });

ipcMain.on('overlay:renderer-ready', (event) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  overlayReadiness.markReady();
  log('overlay renderer ready');
});
ipcMain.on('overlay:gesture-ready', (event, payload) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) {
    log('gesture-ready SKIP: not surface sender');
    return;
  }
  const arm = selectionGestureArm;
  const rxToken = String(payload?.token || '');
  if (!arm) {
    log(`gesture-ready SKIP: no active arm (rxToken=${rxToken})`);
    return;
  }
  if (rxToken !== arm.token) {
    log(`gesture-ready SKIP: token mismatch rx=${rxToken} arm=${arm.token}`);
    return;
  }
  if (arm.runtime.interactionMode !== 'exclusive_overlay') {
    log(`gesture-ready SKIP: mode=${arm.runtime.interactionMode}`);
    return;
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    log('gesture-ready SKIP: overlayWindow missing/destroyed');
    return;
  }
  // The renderer has reset its pointer state — safe to intercept mouse now.
  // Force a full input-state refresh: toggling ignore off twice and raising
  // the window prevents the transparent-overlay compositor from keeping a
  // stale click-through state after a reuse cycle.
  overlayWindow.setIgnoreMouseEvents(false);
  overlayOwnsPointerInput = true;
  if (typeof overlayWindow.moveTop === 'function') overlayWindow.moveTop();
  log(
    `gesture-ready OK token=${arm.token} overlayOwnsPointerInput=true`
    + ` delay_ms=${Date.now() - arm.armedAt} mode=${arm.runtime.interactionMode}`,
  );
});
ipcMain.on('stage:renderer-ready', (event) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  stageReadiness.markReady();
  log('stage renderer ready');
});

ipcMain.on('overlay:hide', (event) => {
  if (isSurfaceSender(event, 'overlay', resultTargetWindow)) {
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  }
});
ipcMain.on('stage:show', (event) => {
  // Renderer re-asserts visibility once it has content to paint.
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  if (stageWindow && !stageWindow.isDestroyed() && !stageWindow.isVisible()) stageWindow.showInactive();
});
ipcMain.on('stage:state', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  const state = String(payload?.state || 'unknown');
  log(`stage renderer state=${state}`);
  if (state === 'result') {
    observeVoiceFocusPhase('result');
    finishVoiceFocusGuard();
  } else if (state === 'error') {
    observeVoiceFocusPhase('error');
    finishVoiceFocusGuard();
  }
});
ipcMain.on('stage:hidden', (event) => {
  // Renderer finished its dismiss fade; the window can actually hide now.
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  setStageMouseCapture(false);
  hideStage();
});
ipcMain.on('stage:dismiss', (event) => {
  // User-initiated dismissal (Escape / outside click) tears the session down.
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
});
ipcMain.on('stage:set-mouse-capture', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  setStageMouseCapture(
    payload?.enabled === true,
    payload?.requestFocus === true,
    Array.isArray(payload?.regions) ? payload.regions : [],
  );
});
ipcMain.on('dictation:stop', (event, payload) => {
  const surface = payload?.surface === 'overlay' ? 'overlay' : payload?.surface === 'stage' ? 'stage' : null;
  if (!surface || !isSurfaceSender(event, surface, resultTargetWindow)) return;
  stopDictation(surface, { graceful: payload?.graceful === true });
});
function startLegacyDictation({ requestId, surface, contextPath, silenceMs }) {
  if (dictationChildren.has(surface)) {
    return { ok: false, error: 'voice_session_active' };
  }
  const voiceEngine = String(fabricSettings?.interaction?.voice_engine || 'auto').trim().toLowerCase() || 'auto';
  const scriptPath = voiceEngine === 'sense_voice'
    ? path.join(ROOT, 'scripts', 'sense_voice_bridge.py')
    : path.join(ROOT, 'scripts', 'local_voice_bridge.py');
  const pythonExecutable = PYTHON_EXECUTABLE;
  const voiceArgs = pythonInvocationArgs([
    '-u',
    scriptPath,
    '--model',
    voiceEngine === 'sense_voice' ? 'sense-voice-small' : localWhisperModelName(),
    '--silence-ms',
    String(silenceMs),
  ], { isolated: PYTHON_ISOLATED });
  const stopFile = path.join(FABRIC_DATA_DIR, 'voice-control', `${crypto.randomUUID()}.stop`);
  voiceArgs.push('--stop-file', stopFile);
  if (!app.isPackaged && process.env.MAGIC_POINTER_VOICE_INPUT_WAV) {
    voiceArgs.push('--input-wav', path.resolve(process.env.MAGIC_POINTER_VOICE_INPUT_WAV));
  }
  const child = spawn(pythonExecutable, voiceArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: pythonSpawnEnvironment({ env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      MAGIC_POINTER_VOICE_SETTINGS_FILE: fabricSettingsStore?.path || '',
      MAGIC_POINTER_VOICE_CONTEXT_PATH: contextPath,
    }, isolated: PYTHON_ISOLATED }),
  });
  dictationChildren.set(surface, child);
  dictationStopFiles.set(surface, stopFile);
  let stdout = '';
  let stderr = '';
  let terminalEventSeen = false;
  const forwardEvent = (eventPayload = {}) => {
    if (dictationChildren.get(surface) !== child) return;
    const runtimeSession = voiceRuntime?.active;
    if (
      !runtimeSession
      || runtimeSession.requestId !== requestId
      || runtimeSession.surface !== surface
      || runtimeSession.resident !== false
    ) return;
    if (
      runtimeSession.cancelled
      && (eventPayload.type === 'partial' || eventPayload.type === 'final')
    ) return;
    if (eventPayload.type === 'loading') observeVoiceFocusPhase('loading');
    else if (eventPayload.type === 'ready') observeVoiceFocusPhase('ready');
    else if (eventPayload.type === 'partial') observeVoiceFocusPhase('partial');
    else if (eventPayload.type === 'final') observeVoiceFocusPhase('final');
    else if (eventPayload.type === 'error') observeVoiceFocusPhase('error');
    if (eventPayload.type === 'partial' || eventPayload.type === 'final') {
      if (eventPayload.type === 'final') terminalEventSeen = true;
      if (eventPayload.type === 'final') voiceRuntime?.legacyFinished(requestId);
      safeSurfaceSend(surface, 'dictation:result', {
        ok: true,
        surface,
        transcript: String(eventPayload.transcript || ''),
        final: eventPayload.type === 'final',
        engine: eventPayload.engine || 'whisper-local',
      });
    } else if (eventPayload.type === 'error') {
      terminalEventSeen = true;
      voiceRuntime?.legacyFinished(requestId);
      safeSurfaceSend(surface, 'dictation:result', {
        ok: false,
        surface,
        error: String(eventPayload.error || '本地语音识别失败。'),
        engine: eventPayload.engine || 'whisper-local',
      });
    } else if (eventPayload.type === 'loading' || eventPayload.type === 'ready') {
      safeSurfaceSend(surface, 'dictation:result', {
        ok: true,
        surface,
        status: eventPayload.type,
        engine: eventPayload.engine || 'whisper-local',
      });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        forwardEvent(JSON.parse(line));
      } catch (_) {
        log('local dictation emitted invalid JSONL');
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => {
    terminalEventSeen = true;
    if (dictationChildren.get(surface) === child) {
      dictationChildren.delete(surface);
      cleanupDictationStopFile(surface);
    }
    voiceRuntime?.legacyFinished(requestId);
    safeSurfaceSend(surface, 'dictation:result', {
      ok: false,
      surface,
      error: `本地语音启动失败：${error.message}`,
    });
  });
  child.on('close', (code) => {
    if (stdout.trim()) {
      try { forwardEvent(JSON.parse(stdout)); } catch (_) {}
    }
    if (dictationChildren.get(surface) === child) {
      dictationChildren.delete(surface);
      cleanupDictationStopFile(surface);
    }
    voiceRuntime?.legacyFinished(requestId);
    if (!terminalEventSeen && code !== 0) {
      safeSurfaceSend(surface, 'dictation:result', {
        ok: false,
        surface,
        error: `本地语音识别失败：${stderr.trim().slice(0, 500) || `exit ${code}`}`,
      });
    }
    log(`local dictation closed surface=${surface} code=${code}`);
  });
  return { ok: true, requestId, mode: 'legacy' };
}

ipcMain.on('dictation:start', (event, payload) => {
  const surface = payload?.surface === 'overlay' ? 'overlay' : payload?.surface === 'stage' ? 'stage' : null;
  if (!surface || !isSurfaceSender(event, surface, resultTargetWindow)) {
    log('dictation:start rejected untrusted sender or surface');
    return;
  }
  const selectionToken = activeSelectionSessionToken;
  const selectionSession = selectionToken ? selectionSessions.get(selectionToken) : null;
  if (!selectionSession) {
    safeSurfaceSend(surface, 'dictation:result', { ok: false, surface, error: '当前 THIS 已过期，请重新激活 Magic Pointer。' });
    return;
  }
  if (!selectionSession.snapshot) {
    // Bounded wait for grounding instead of a silent drop: a manual voice
    // press right after releasing the stroke must never do nothing.
    const deadline = Date.now() + 3000;
    const attempt = () => {
      const current = selectionSessions.get(selectionToken);
      if (!current || activeSelectionSessionToken !== selectionToken) {
        safeSurfaceSend(surface, 'dictation:result', { ok: false, surface, error: '当前 THIS 已过期，请重新激活 Magic Pointer。' });
        return;
      }
      if (current.snapshot) {
        startStageDictation({ surface, selectionSession: current, selectionToken });
        return;
      }
      if (Date.now() >= deadline) {
        safeSurfaceSend(surface, 'dictation:result', { ok: false, surface, error: '目标识别还在进行，请稍候再试语音。' });
        return;
      }
      setTimeout(attempt, 80);
    };
    attempt();
    return;
  }
  startStageDictation({ surface, selectionSession, selectionToken });
});

function startStageDictation({ surface, selectionSession, selectionToken }) {
  const snapshot = selectionSession.snapshot;
  const context = snapshot.context || {};
  const contextPath = String(context.document_path || context.path || snapshot.capture_path || '');
  const requestId = crypto.randomUUID();
  const silenceMs = Math.max(600, Math.min(5000, Number(fabricSettings?.interaction?.voice_silence_ms) || 1600));
  const inputWav = !app.isPackaged && process.env.MAGIC_POINTER_VOICE_INPUT_WAV
    ? path.resolve(process.env.MAGIC_POINTER_VOICE_INPUT_WAV)
    : '';
  if (!appendVoiceAudit({
    eventType: 'voice.start', sessionToken: selectionToken, surface, outcome: 'requested', latencyMs: 0,
  })) {
    safeSurfaceSend(surface, 'dictation:result', { ok: false, surface, error: '本地语音审计写入失败，未启动录音。' });
    return;
  }
  observeVoiceFocusPhase('dictation_start', selectionToken);
  const result = voiceRuntime?.start({
    requestId,
    surface,
    contextPath,
    silenceMs,
    inputWav,
  }) || { ok: false, error: 'voice_runtime_unavailable' };
  if (!result.ok) {
    appendVoiceAudit({
      eventType: 'voice.start_rejected', sessionToken: selectionToken, surface, outcome: 'rejected', errorCode: result.error,
    });
    safeSurfaceSend(surface, 'dictation:result', { ok: false, surface, error: `本地语音未启动：${result.error}` });
  }
}
function resultTargetWindow(target) {
  if (target === 'dashboard' || target === 'calendar-dashboard' || target === 'fabric-dashboard') return dashboardWindow;
  if (target === 'stage') return stageWindow;
  return overlayWindow;
}

function safeSurfaceSend(surface, channel, payload) {
  const win = resultTargetWindow(surface);
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, payload);
  return true;
}

function sendBridgeResult(target, parsed) {
  if (target === 'stage') {
    deliverStageBridgeResult(parsed?.selectionSessionToken || null, parsed);
    return;
  }
  const channel = target === 'calendar-dashboard'
    ? 'dashboard:calendar-state'
    : target === 'fabric-dashboard'
      ? 'dashboard:fabric-state'
    : target === 'dashboard'
      ? 'dashboard:state'
      : 'overlay:result';
  safeSurfaceSend(target, channel, parsed);
}

function runPythonBridge(payload, scriptPath = 'scripts/electron_bridge.py', target = 'overlay', options = {}) {
  if (!resultTargetWindow(target)) return;
  const py = PYTHON_EXECUTABLE;
  const defaultTimeoutMs = scriptPath.includes('selection_snapshot_bridge')
    ? 15_000
    : scriptPath.includes('action_bridge')
      ? 45_000
      : scriptPath.includes('shopping_list_bridge') || scriptPath.includes('calendar_bridge')
        ? 20_000
        : 120_000;
  return pythonBridgeRunner.run({
    executable: py,
    args: pythonInvocationArgs([scriptPath], { isolated: PYTHON_ISOLATED }),
    spawnOptions: {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: pythonSpawnEnvironment({ env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        MAGIC_POINTER_USER_DATA_DIR: FABRIC_DATA_DIR,
      }, isolated: PYTHON_ISOLATED }),
    },
    input: payload,
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || defaultTimeoutMs),
    maxStdoutBytes: Math.max(4096, Number(options.maxStdoutBytes) || 1024 * 1024),
    maxStderrBytes: Math.max(4096, Number(options.maxStderrBytes) || 256 * 1024),
    signal: options.signal || null,
    logger: log,
    onComplete: (parsed) => {
      log(`bridge complete script=${scriptPath} ok=${parsed?.ok} error=${parsed?.error || 'none'}`);
      if (typeof options.onComplete === 'function') {
        options.onComplete(parsed);
        return;
      }
      registerActionProposals(parsed, options.selectionSessionToken || null, target);
      sendBridgeResult(target, parsed);
    },
  });
}

function runPythonBridgePromise(payload, scriptPath, { target = 'fabric-dashboard', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const child = runPythonBridge(payload, scriptPath, target, {
      timeoutMs,
      onComplete: (parsed) => {
        if (parsed?.ok !== true) {
          finish(reject, new Error(String(parsed?.error || 'runtime_snapshot_probe_failed')));
          return;
        }
        finish(resolve, parsed);
      },
    });
    if (!child) {
      finish(reject, new Error('runtime_snapshot_surface_unavailable'));
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish(reject, new Error('runtime_snapshot_probe_timeout'));
    }, Math.max(1000, Number(timeoutMs) || 5000));
  });
}

function runtimePermissionEvidence() {
  if (process.platform !== 'darwin') {
    return {
      accessibility: { state: 'not_required', source: 'platform_contract' },
      screenCapture: { state: 'not_required', source: 'platform_contract' },
    };
  }
  const accessibilityReady = typeof systemPreferences.isTrustedAccessibilityClient === 'function'
    && systemPreferences.isTrustedAccessibilityClient(false);
  const screenCaptureState = typeof systemPreferences.getMediaAccessStatus === 'function'
    ? systemPreferences.getMediaAccessStatus('screen')
    : 'unknown';
  return {
    accessibility: {
      state: accessibilityReady ? 'ready' : 'blocked',
      source: 'system_preferences',
    },
    screenCapture: {
      state: screenCaptureState === 'granted' ? 'ready' : screenCaptureState,
      source: 'system_preferences',
    },
  };
}

async function probeRuntimeState() {
  const parsed = await runPythonBridgePromise({
    operation: 'runtime.snapshot',
    runtimeEvidence: {
      voiceWorker: safeClone(latestVoiceRuntimeStatus),
      permissions: runtimePermissionEvidence(),
    },
  }, 'scripts/fabric_bridge.py', { timeoutMs: 5000 });
  if (!parsed.snapshot || typeof parsed.snapshot !== 'object') {
    throw new Error('runtime_snapshot_payload_missing');
  }
  return parsed.snapshot;
}

function invalidateRuntimeState(reason) {
  const generation = runtimeSnapshot.invalidate(reason);
  safeSurfaceSend('dashboard', 'runtime-snapshot:changed', {
    generation,
    reason: String(reason || 'unspecified'),
  });
  return generation;
}

function modelCredentialRef(profileId) {
  const id = String(profileId || '').trim().toLowerCase();
  const profiles = Array.isArray(fabricSettings?.models?.profiles) ? fabricSettings.models.profiles : [];
  const profile = profiles.find((item) => String(item?.id || '').trim().toLowerCase() === id);
  const ref = String(profile?.credentialRef || '').trim();
  if (!profile || !ref) throw new Error('model_credential_ref_missing');
  return ref;
}

function withoutRawCredential(payload) {
  const clean = { ...(payload || {}) };
  for (const key of ['credential', 'credentialValue', 'apiKey', 'token', 'secret', 'authorization']) delete clean[key];
  return clean;
}

function handleModelCredentialOperation(operation, payload) {
  if (!credentialStore) throw new Error('credential_store_unavailable');
  const ref = modelCredentialRef(payload?.profileId);
  if (operation === 'models.credentials.status') return credentialStore.status(ref);
  if (operation === 'models.credentials.set') return credentialStore.set(ref, payload?.credentialValue);
  if (operation === 'models.credentials.delete') return credentialStore.delete(ref);
  throw new Error('credential_operation_unknown');
}

function microphonePermissionStatus() {
  try {
    return systemPreferences.getMediaAccessStatus('microphone');
  } catch (_) {
    return 'unknown';
  }
}

function sendPreflightEvent(preflightEvent) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('dashboard:preflight-event', preflightEvent);
  }
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.webContents.send('onboarding:preflight-event', preflightEvent);
  }
}

async function runPreflight(payload = {}, { signal = null } = {}) {
  const manifestBytes = fs.readFileSync(PREFLIGHT_MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const manifestDigest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const runner = new PreflightRunner({
    manifest,
    markerPath: path.join(FABRIC_DATA_DIR, 'onboarding.json'),
    bootstrapVersion: ONBOARDING_BOOTSTRAP_VERSION,
    productVersion: app.getVersion(),
    manifestDigest,
    emit: sendPreflightEvent,
    checks: buildAsyncPreflightChecks({
      root: FABRIC_DATA_DIR,
      projectRoot: ROOT,
      settings: fabricSettings || defaultSettings(),
      credentialStore,
      wiggleDetector,
      pythonRuntime: PYTHON_RUNTIME,
      microphoneStatus: microphonePermissionStatus,
    }),
  });
  const stageIds = Array.isArray(payload.stageIds) ? payload.stageIds : null;
  const userSkips = Array.isArray(payload.userSkips) ? payload.userSkips : [];
  return runner.runAsync({ stageIds, userSkips, signal });
}

function startPreflight(payload = {}) {
  if (preflightRunPromise) return preflightRunPromise;
  log(`preflight start source=${String(payload?.source || 'dashboard')}`);
  preflightAbortController = new AbortController();
  preflightRunPromise = runPreflight(payload, { signal: preflightAbortController.signal })
    .then((result) => {
      log(`preflight complete ready=${result.ready}`);
      return result;
    })
    .finally(() => {
      preflightRunPromise = null;
      preflightAbortController = null;
    });
  return preflightRunPromise;
}

function cancelPreflight() {
  if (!preflightAbortController || preflightAbortController.signal.aborted) return false;
  preflightAbortController.abort();
  log('preflight cancel requested');
  return true;
}

ipcMain.on('overlay:done', (event, payload) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  if (payload?.workflow === 'selection_gesture') {
    completeSelectionGesture(payload);
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const rawPoints = Array.isArray(payload?.points) ? payload.points : [];
  const points = rawPoints.slice(0, MAX_OVERLAY_CAPTURE_POINTS);
  const enriched = {
    ...payload,
    points,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || payload?.viewport?.dpr || 1,
    capturePad: 54,
  };
  log(`overlay:done action=${enriched.action || 'capture'} points=${enriched.points?.length || 0} scale=${enriched.scaleFactor} bounds=${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}`);
  // Runtime-issue capture results render on the stage (the overlay no longer
  // hosts result surfaces). Recovery here is event-driven off overlay:done
  // itself, not off bridge completion: hide the overlay immediately so it can
  // never sit black and input-blocking for the whole bridge run (up to the
  // 120s timeout). The bridge completion then opens the stage.
  placeStageOnDisplay(display);
  hideOverlay();
  runPythonBridge(enriched, 'scripts/electron_bridge.py', 'stage', {
    onComplete: (parsed) => {
      registerActionProposals(parsed, null, 'stage');
      lastStageResult = { token: null, parsed: safeClone(parsed) };
      showStage({
        reason: 'runtime-issue',
        selectionSessionToken: null,
        event: stageEventFromBridge(parsed),
      });
    },
  });
});

ipcMain.on('overlay:gesture-start', (event, payload) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  markSelectionGestureDrawing(payload?.token);
});




ipcMain.on('stage:submit-selection-command', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  const selectionSessionToken = payload?.selectionSessionToken;
  const session = selectionSessions.get(selectionSessionToken);
  if (!session || !session.snapshot) {
    log('stage:submit-selection-command rejected missing-or-expired session');
    deliverStageError(selectionSessionToken || null, '当前 THIS 已过期，请重新激活 Magic Pointer。');
    return;
  }
  if (!session.captureEligibility?.commandReady) {
    log('stage:submit-selection-command rejected ineligible capture');
    deliverStageError(selectionSessionToken || null, session.captureEligibility?.message || '当前选区不可用，请重新选择。');
    return;
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const interactionEpisode = bindEpisodeForCommand(session, payload?.command);
  if (shouldContinueGestureEpisode(payload?.command, interactionEpisode)) {
    log(`interaction episode continue episode=${interactionEpisode?.episodeId || 'none'} mode=${inferReferenceMode(payload?.command)}`);
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
    setTimeout(() => armSelectionGesture('episode-continue'), 90);
    return;
  }
  cancelSessionChild(selectionSessionToken);
  const requestId = selectionSessions.startRequest(selectionSessionToken);
  if (!requestId) return;
  const effectiveCommand = composedEpisodeCommand(payload?.command, interactionEpisode);
  const enriched = {
    command: effectiveCommand,
    originalCommand: payload?.command,
    inputMode: payload?.inputMode || null,
    selectionSessionId: selectionSessionToken,
    selectionSnapshot: safeClone(session.snapshot),
    requestId,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || 1,
    source: 'pointer_stage',
    interactionEpisode,
    targetPoint: safeClone(session.snapshot?.target_point || null),
    targetPointSpace: session.snapshot?.target_point_space || null,
  };
  log(`stage:submit-selection-command token=${selectionSessionToken} request=${requestId} command_len=${String(enriched.command || '').length}`);
  let child = null;
  child = runPythonBridge(enriched, 'scripts/selection_bridge.py', 'stage', {
    onComplete: (parsed) => {
      if (activeSessionChildren.get(selectionSessionToken) === child) activeSessionChildren.delete(selectionSessionToken);
      if (!selectionSessions.isCurrentRequest(selectionSessionToken, requestId)) {
        log(`stage result ignored stale token=${selectionSessionToken} request=${requestId}`);
        return;
      }
      selectionSessions.finishRequest(selectionSessionToken, requestId);
      parsed.selectionSessionToken = selectionSessionToken;
      parsed.selectionSnapshotId = session.snapshot?.snapshot_id || null;
      parsed.requestId = requestId;
      registerActionProposals(parsed, selectionSessionToken, 'stage');
      const autoProposal = parsed.actionProposals?.find((proposal) => proposal.id === parsed.autoExecuteProposalId);
      if (canAutoExecuteInternalProposal(parsed, autoProposal)) {
        if (
          parsed?.intentKind === 'review_draft_delivery'
          || parsed?.intentKind === 'context_prompt_delivery'
        ) {
          log(`trusted grounded prompt delivery kind=${parsed.intentKind} proposal=${autoProposal.id}`);
          // Hide our surfaces so the delivery lands in the target app, then
          // bring the stage back with the honest receipt.
          dismissTemporarySurfaces({ invalidateSession: false, hideObserver: true });
          setTimeout(() => {
            executeActionForTarget({
              actionToken: autoProposal.action_token,
              proposalId: autoProposal.id,
              confirmed: false,
              selectionSessionToken,
            }, 'stage', {
              onComplete: (actionResult) => {
                lastStageResult = { token: selectionSessionToken, parsed: safeClone(actionResult) };
                showStage({
                  reason: 'delivery-result',
                  selectionSessionToken,
                  event: stageEventFromBridge(actionResult),
                });
              },
            });
          }, 80);
          return;
        }
        // Stage stays in processing (shimmer) while the trusted internal
        // action runs; the result event lands when it truly finishes.
        log(`trusted internal auto-execute type=${autoProposal.action_type} proposal=${autoProposal.id}`);
        executeActionForTarget({
          actionToken: autoProposal.action_token,
          proposalId: autoProposal.id,
          confirmed: false,
          selectionSessionToken,
        }, 'stage', {
          onComplete: (actionResult) => {
            const output = actionResult?.executionResult?.output || {};
            const highlightItemId = output?.verified === true
              ? (output?.item?.id || output?.items?.[0]?.id || null)
              : null;
            if (actionResult?.ok === true && highlightItemId) {
              showDashboard({ highlightItemId }, { activate: false });
            }
            deliverStageBridgeResult(selectionSessionToken, actionResult);
          },
        });
        return;
      }
      deliverStageBridgeResult(selectionSessionToken, parsed);
    },
  });
  if (child) activeSessionChildren.set(selectionSessionToken, child);
});

// Context actions open the reviewed draft in the dashboard; they never write.
ipcMain.on('stage:context-action', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  const id = String(payload?.id || '');
  const token = payload?.selectionSessionToken || null;
  if (!lastStageResult || (lastStageResult.token || null) !== token) {
    log('stage:context-action rejected stale result');
    return;
  }
  const parsed = lastStageResult.parsed || {};
  if (id === 'open-calendar-draft' && parsed.calendarDraft) {
    showDashboard({ view: 'calendar', calendarDraft: safeClone(parsed.calendarDraft) }, { activate: true });
  } else if (id === 'open-route-draft' && parsed.routeDraft) {
    showDashboard({ view: 'route', routeDraft: safeClone(parsed.routeDraft) }, { activate: true });
  } else {
    log(`stage:context-action unknown id=${id}`);
  }
});

function executeActionForTarget(payload, target, options = {}) {
  const token = payload?.actionToken || payload?.action_token;
  const selectionSessionToken = payload?.selectionSessionToken || null;
  // Runtime-issue results carry no selection session (token null); a stale
  // provided token is still rejected.
  const isSelectionSurface = target === 'stage';
  if (isSelectionSurface && selectionSessionToken && !selectionSessions.get(selectionSessionToken)) {
    log(`${target}:execute-action rejected expired selection session`);
    deliverStageError(selectionSessionToken, '当前 THIS 已过期，请重新激活 Magic Pointer。');
    return;
  }
  const proposal = takePendingActionProposal(token, selectionSessionToken, target);
  if (!proposal) {
    log(`${target}:execute-action rejected missing-or-expired token`);
    sendBridgeResult(target, {
      ok: false,
      prompt: 'Action result',
      error: 'Action expired or was not proposed by this session.',
      selectionSessionToken,
    });
    return;
  }

  const enriched = {
    proposal,
    confirmed: payload?.confirmed === true,
  };
  log(`${target}:execute-action type=${proposal.action_type || 'unknown'} confirmed=${enriched.confirmed}`);
  runPythonBridge(enriched, 'scripts/action_bridge.py', target, {
    onComplete: (parsed) => {
      if (isSelectionSurface && selectionSessionToken && !selectionSessions.get(selectionSessionToken)) {
        log(`${target}:action result ignored expired selection session`);
        return;
      }
      parsed.selectionSessionToken = selectionSessionToken;
      registerActionProposals(parsed, selectionSessionToken, target);
      if (typeof options.onComplete === 'function') options.onComplete(parsed);
      else sendBridgeResult(target, parsed);
    },
  });
}

ipcMain.on('stage:execute-action', (event, payload) => {
  if (isSurfaceSender(event, 'stage', resultTargetWindow)) executeActionForTarget(payload, 'stage');
});

function isDashboardSender(event) {
  return Boolean(dashboardWindow && !dashboardWindow.isDestroyed() && event.sender === dashboardWindow.webContents);
}

function isOnboardingSender(event) {
  return Boolean(onboardingWindow && !onboardingWindow.isDestroyed() && event.sender === onboardingWindow.webContents);
}

ipcMain.on('onboarding:start', (event) => {
  if (!isOnboardingSender(event) || !onboardingRequired) return;
  onboardingPhase = 'progress';
  void startPreflight({ source: 'onboarding' })
    .then((preflight) => {
      if (!preflight.ready) {
        onboardingPhase = 'failure';
        return;
      }
      onboardingRequired = false;
      onboardingPhase = 'success';
      applyConfiguredWakeState();
      refreshTrayMenu();
    })
    .catch((error) => {
      if (error?.message === 'preflight_cancelled') {
        sendPreflightEvent({ type: 'cancelled' });
        return;
      }
      onboardingPhase = 'failure';
      log(`onboarding preflight failed ${error.name}: ${error.message}`);
      sendPreflightEvent({ type: 'error', error: `preflight_failed:${error.name}` });
    });
});

ipcMain.on('onboarding:continue', (event) => {
  if (!isOnboardingSender(event) || onboardingRequired) return;
  showDashboard({ view: 'general' }, { activate: true });
  onboardingWindow?.close();
});

ipcMain.on('onboarding:cancel', (event) => {
  if (!isOnboardingSender(event)) return;
  cancelPreflight();
  isQuitting = true;
  app.quit();
});

function queueDashboardOperation(operation, payload = {}) {
  const requestId = `dashboard-${++dashboardRequestSerial}`;
  dashboardOperationQueue = dashboardOperationQueue
    .catch(() => undefined)
    .then(() => new Promise((resolve) => {
      if (!dashboardWindow || dashboardWindow.isDestroyed()) {
        resolve();
        return;
      }
      runPythonBridge({
        operation,
        requestId,
        ...payload,
      }, 'scripts/shopping_list_bridge.py', 'dashboard', {
        onComplete: (parsed) => {
          sendBridgeResult('dashboard', parsed);
          resolve();
        },
      });
    }));
}

function queueCalendarOperation(operation, payload = {}) {
  const requestId = `calendar-${++dashboardRequestSerial}`;
  dashboardOperationQueue = dashboardOperationQueue
    .catch(() => undefined)
    .then(() => new Promise((resolve) => {
      if (!dashboardWindow || dashboardWindow.isDestroyed()) {
        resolve();
        return;
      }
      runPythonBridge({
        operation,
        requestId,
        ...payload,
      }, 'scripts/calendar_bridge.py', 'calendar-dashboard', {
        onComplete: (parsed) => {
          sendBridgeResult('calendar-dashboard', parsed);
          resolve();
        },
      });
    }));
}

ipcMain.on('dashboard:hide', (event) => {
  if (isDashboardSender(event)) dashboardWindow.hide();
});
ipcMain.on('dashboard:theme', (event, payload = {}) => {
  if (!isDashboardSender(event) || process.platform === 'darwin') return;
  const theme = ['light', 'dark'].includes(payload.theme) ? payload.theme : 'system';
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  try {
    dashboardWindow.setTitleBarOverlay({
      color: 'rgba(1, 0, 0, 0)',
      symbolColor: dark ? '#f5f5f7' : '#1d1d1f',
      height: 46,
    });
  } catch (_) {
    // Window Controls Overlay is optional; renderer chrome remains usable.
  }
});
ipcMain.handle('runtime-snapshot:get', async (event, options = {}) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_runtime_snapshot_sender');
  return runtimeSnapshot.get({ force: options?.force === true });
});
ipcMain.on('dashboard:fabric-request', (event, payload) => {
  if (!isDashboardSender(event)) return;
  const operation = typeof payload?.operation === 'string' ? payload.operation : '';
  if (operation === 'calibration.start') {
    if (!wiggleDetector || !fabricSettingsStore) {
      sendBridgeResult('fabric-dashboard', {
        ok: false,
        fabricOperation: operation,
        error: '晃动检测器尚未启动。',
      });
      return;
    }
    if (wiggleCalibrationTimer) clearTimeout(wiggleCalibrationTimer);
    wiggleDetector.startCalibration(Date.now(), 10000);
    sendBridgeResult('fabric-dashboard', {
      ok: true,
      fabricOperation: operation,
      calibration: { status: 'running', durationMs: 10000 },
    });
    wiggleCalibrationTimer = setTimeout(() => {
      wiggleCalibrationTimer = null;
      const result = wiggleDetector.finishCalibration();
      if (result.ok) {
        fabricSettings.activation.sensitivity = result.sensitivity;
        fabricSettingsStore.save(fabricSettings);
      }
      sendBridgeResult('fabric-dashboard', {
        ok: result.ok,
        fabricOperation: 'calibration.complete',
        calibration: result,
        settings: fabricSettings,
        error: result.ok ? null : '没有检测到完整晃动，请重试。',
      });
    }, 10000);
    return;
  }
  if (operation.startsWith('models.credentials.')) {
    try {
      const credential = handleModelCredentialOperation(operation, payload);
      sendBridgeResult('fabric-dashboard', {
        ok: true,
        state: 'completed',
        fabricOperation: operation,
        credential,
      });
    } catch (error) {
      sendBridgeResult('fabric-dashboard', {
        ok: false,
        state: 'failed',
        fabricOperation: operation,
        error: error.message,
      });
    }
    return;
  }
  if (operation === 'preflight.run') {
    void startPreflight(payload)
      .then((preflight) => {
        if (preflight.ready) {
          onboardingRequired = false;
          applyConfiguredWakeState();
          refreshTrayMenu();
        }
        sendBridgeResult('fabric-dashboard', {
          ok: true,
          state: preflight.ready ? 'completed' : 'blocked',
          fabricOperation: operation,
          preflight,
        });
      })
      .catch((error) => {
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('dashboard:preflight-event', {
            type: 'error',
            error: `preflight_failed:${error.name}`,
          });
        }
        sendBridgeResult('fabric-dashboard', {
          ok: false,
          state: 'failed',
          fabricOperation: operation,
          error: `preflight_failed:${error.name}`,
        });
      });
    return;
  }
  const allowedOperations = new Set([
    'catalog',
    'providers',
    'agent.sessions',
    'agent.contexts.list',
    'agent.context.dispatch',
    'settings.get',
    'settings.save',
    'browser.status',
    'models.list',
    'models.inspect',
    'models.save',
    'models.delete',
    'models.set_default',
    'models.test',
    'visual_relay.plan',
    'audit.tail',
    'artifacts.list',
    'artifacts.cleanup',
    'artifacts.restore',
    'skills.candidates.list',
    'skills.candidates.draft',
    'skills.candidates.install',
    'provenance.objects',
    'provenance.trace',
    'task.status',
    'task.list',
    'task.cancel',
    'task.steer',
    'task.reconfirm_target',
    'workflow.list',
    'workflow.get',
    'workflow.approve',
    'workflow.execute',
  ]);
  if (!allowedOperations.has(operation)) {
    sendBridgeResult('fabric-dashboard', {
      ok: false,
      fabricOperation: operation,
      error: 'Dashboard operation is not allowed.',
    });
    return;
  }
  const bridgePayload = withoutRawCredential(payload);
  if (operation === 'models.test') {
    try {
      const ref = modelCredentialRef(bridgePayload.profileId);
      const credential = credentialStore ? credentialStore.get(ref) : null;
      if (credential) bridgePayload.credential = credential;
    } catch (_) {
      // The Python bridge returns credential_missing without exposing a secret.
    }
  }
  runPythonBridge({
    ...bridgePayload,
    operation,
  }, 'scripts/fabric_bridge.py', 'fabric-dashboard', {
    onComplete: (parsed) => {
      if (
        parsed?.ok === true
        && ['models.save', 'models.delete', 'models.set_default', 'models.test'].includes(operation)
      ) {
        try {
          fabricSettings = fabricSettingsStore.load();
        } catch (error) {
          log(`model settings reload failed ${error.name}: ${error.message}`);
        }
      }
      if (operation === 'settings.save' && parsed?.ok === true && parsed?.settings) {
        const previousSettings = fabricSettings;
        const gestureContractChanged = gestureRuntimeSettingsChanged(previousSettings, parsed.settings);
        const voiceReconfigure = configureVoiceRuntime(parsed.settings, { preload: true });
        if (!voiceReconfigure.ok) {
          fabricSettings = previousSettings;
          try {
            fabricSettingsStore.save(previousSettings);
          } catch (error) {
            log(`voice settings rollback persistence failed ${error.name}`);
          }
          parsed.ok = false;
          parsed.settings = previousSettings;
          parsed.error = voiceReconfigure.error === 'voice_session_active'
            ? '语音正在录音，不能在会话中修改常驻模型设置。'
            : `常驻语音设置未应用：${voiceReconfigure.error}`;
          sendBridgeResult('fabric-dashboard', { ...parsed, fabricOperation: operation });
          return;
        }
        fabricSettings = parsed.settings;
        if (wiggleDetector) {
          wiggleDetector.updateSettings({
            sensitivity: parsed.settings.activation?.sensitivity,
            disabledApps: parsed.settings.activation?.disabled_apps || [],
            cooldownMs: parsed.settings.activation?.cooldown_ms,
          });
        }
        parsed.hotkeys = registerConfigurableHotkeys();
        const failedHotkeys = Object.entries(parsed.hotkeys)
          .filter(([, result]) => result && result.registered === false && result.disabled !== true)
          .map(([name]) => name);
        if (failedHotkeys.length) {
          fabricSettings = previousSettings;
          try {
            fabricSettingsStore.save(previousSettings);
          } catch (error) {
            log(`settings hotkey rollback persistence failed ${error.name}`);
          }
          const voiceRollback = configureVoiceRuntime(previousSettings, { preload: true });
          if (!voiceRollback.ok) log(`settings voice runtime rollback failed ${voiceRollback.error}`);
          if (wiggleDetector) {
            wiggleDetector.updateSettings({
              sensitivity: previousSettings.activation?.sensitivity,
              disabledApps: previousSettings.activation?.disabled_apps || [],
              cooldownMs: previousSettings.activation?.cooldown_ms,
            });
          }
          parsed.hotkeys = registerConfigurableHotkeys();
          parsed.ok = false;
          parsed.settings = previousSettings;
          parsed.error = `快捷键注册失败：${failedHotkeys.join('、')}；设置已回滚。`;
        }
        if (parsed.ok === true && gestureContractChanged) {
          cancelSelectionGesture('settings_changed');
        }
        if (parsed.ok === true) {
          updateManager?.setChannel(parsed.settings.general?.update_channel || 'stable');
        }
        applyConfiguredWakeState();
        applyDashboardMaterial(fabricSettings);
        try {
          app.setLoginItemSettings({ openAtLogin: fabricSettings.general?.launch_at_login === true });
        } catch (error) {
          log(`login item settings save failed ${error.name}`);
        }
      }
      if (operation.startsWith('models.') && parsed?.ok === true && fabricSettingsStore) {
        try {
          fabricSettings = fabricSettingsStore.load();
        } catch (error) {
          log(`model settings refresh failed ${error.name}`);
        }
      }
      if (operation === 'settings.save' && parsed?.ok === true) {
        invalidateRuntimeState('settings_changed');
      } else if (
        parsed?.ok === true
        && ['models.save', 'models.delete', 'models.set_default', 'models.test'].includes(operation)
      ) {
        invalidateRuntimeState('models_changed');
      }
      sendBridgeResult('fabric-dashboard', { ...parsed, fabricOperation: operation });
    },
  });
});
ipcMain.on('dashboard:request-state', (event) => {
  if (isDashboardSender(event)) queueDashboardOperation('list');
});
ipcMain.on('dashboard:set-checked', (event, payload) => {
  if (!isDashboardSender(event)) return;
  queueDashboardOperation('set_checked', {
    itemId: payload?.itemId,
    checked: payload?.checked,
    expectedUpdatedAt: payload?.expectedUpdatedAt,
  });
});
ipcMain.on('dashboard:undo-add', (event, payload) => {
  if (!isDashboardSender(event)) return;
  queueDashboardOperation('undo_add', {
    itemId: payload?.itemId,
    receiptId: payload?.receiptId,
    expectedUpdatedAt: payload?.expectedUpdatedAt,
  });
});
ipcMain.on('dashboard:calendar-request-state', (event) => {
  if (isDashboardSender(event)) queueCalendarOperation('list');
});
ipcMain.on('dashboard:calendar-preview', (event, payload) => {
  if (!isDashboardSender(event)) return;
  queueCalendarOperation('preview', { event: payload?.event });
});
ipcMain.on('dashboard:calendar-create', (event, payload) => {
  if (!isDashboardSender(event)) return;
  queueCalendarOperation('create', {
    event: payload?.event,
    idempotencyKey: payload?.idempotencyKey,
    source: payload?.source,
    allowConflict: payload?.allowConflict === true,
    confirmed: payload?.confirmed === true,
  });
});
ipcMain.on('dashboard:calendar-undo-create', (event, payload) => {
  if (!isDashboardSender(event)) return;
  queueCalendarOperation('undo_create', {
    eventId: payload?.eventId,
    receiptId: payload?.receiptId,
    expectedUpdatedAt: payload?.expectedUpdatedAt,
  });
});
ipcMain.on('dashboard:route-open', async (event, payload) => {
  if (!isDashboardSender(event)) return;
  const url = buildGoogleMapsDirectionsUrl(payload);
  if (!url || !isAllowedGoogleMapsDirectionsUrl(url)) {
    dashboardWindow?.webContents.send('dashboard:route-result', {
      ok: false,
      error: '起点、终点或交通方式无效，未打开外部地图。',
    });
    return;
  }
  try {
    await shell.openExternal(url);
    dashboardWindow?.webContents.send('dashboard:route-result', { ok: true });
    log(`route external opened mode=${String(payload?.travelMode || '')}`);
  } catch (error) {
    dashboardWindow?.webContents.send('dashboard:route-result', {
      ok: false,
      error: `无法打开默认浏览器：${error.message}`,
    });
  }
});
