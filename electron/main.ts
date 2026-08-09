// @ts-nocheck -- the legacy main-process composition root is compiled without runtime rewrites.
const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, safeStorage, systemPreferences } = require('electron');
const path = require('path');
const { dialog } = require('electron');
const { Menu, nativeImage, Tray } = require('electron');
const { nativeTheme } = require('electron');
const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

// Keep the long-supported `electron electron/main.js` developer entry working
// while local main-process modules migrate to TypeScript. Compiled/package
// output contains runtime_paths.js but never runtime_paths.ts, so production
// does not load or depend on the development-only tsx runtime.
if (fs.existsSync(path.join(__dirname, 'runtime_paths.ts'))) {
  require('tsx/cjs');
}

const { projectRoot } = require('./runtime_paths');
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
const { humanErrorMessage, inferObjectKind, selectionSourceForReason, stageEventFromBridge } = require('./stage_contract');
const { SessionTimeline } = require('./session_timeline');
const {
  DECISION_FAIL: SUBMIT_FAIL,
  DECISION_WAIT: SUBMIT_WAIT,
  decideSubmitGate,
} = require('./submit_gating_policy');
const { canAutoExecuteInternalProposal } = require('./internal_action_policy');
const {
  normalizeGroundingGeometry,
  physicalGestureBoundingBox,
  physicalGestureTrace,
  physicalRectToDip,
  physicalScreenPoint,
  relativeRect,
} = require('./coordinate_space');
const { nativeShapeRegions } = require('./stage_hit_regions');
const { isSurfaceSender } = require('./ipc_surface_policy');
const { buildGoogleMapsDirectionsUrl, isAllowedGoogleMapsDirectionsUrl } = require('./route_policy');
const securityHardening = require('./security_hardening');
const observability = require('./observability');
const { VoiceFocusGuard } = require('./voice_focus_guard');
const { inspectOnboardingReadiness, shouldStartHidden } = require('./app_lifecycle');
const { RuntimeSnapshot } = require('./runtime_snapshot');
const {
  chainFinalizeDelay,
  pointerContinuesGestureChain,
  summarizeGesture,
} = require('./gesture_capture');
const { shouldDismissFromGlobalPointer } = require('./pointer_dismiss_policy');
const { RendererReadiness } = require('./renderer_readiness');
const { gestureRuntimeContract, gestureRuntimeSettingsChanged } = require('./gesture_runtime_settings');
const { createUpdateManager } = require('./update_manager');
const { pointerPollingPolicy } = require('./pointer_polling_policy');
const { PassThroughGestureCapture } = require('./pass_through_gesture');
const { createPythonBridgeRunner } = require('./python_bridge_runner');
const CardModel = require('./cards');
const { createTaskWatcher } = require('./task_watcher');
const { createStashRuntime } = require('./stash_runtime');
const { isTransientShell } = require('./stash_store');
const { evaluateRule } = require('./proactive_rules');
const { createProactiveOnceStore } = require('./proactive_once_store');
const { createConversationStore } = require('./conversation_store');

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
// 划线完成 → 会话开始之间隔一帧合成器。这个定时器必须跟着手势取消走，
// 否则用户在 34ms 内按 Escape/重新划线的操作会被一个迟到的 beginSelectionSession
// 静默覆盖（又开一个新会话、又 spawn 一个探针）。
let selectionGestureCommitTimer = null;
let passThroughChainTimer = null;
let passThroughChainDeadlineAt = 0;
let passThroughChainLastPoint = null;
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
  swallowingLeft: false,
  captureArmed: false,
};
let lastPointerTraceKey = '';
// 采集发生在剪贴板变化之后 700ms 内，那时前台可能已经被截图工具之类的外壳
// 抢走。记住「最后一个真正的应用」，收藏箱才能说清这张图是从哪来的。
let lastStableForegroundApp = '';
let lastStableForegroundWindow = {
  app: '',
  hwnd: 0,
  process_id: 0,
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
let temporaryGestureSubmitShortcutRegistered = false;
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

const ROOT = projectRoot(__dirname);
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
// Recent sessions, as durations a person can read. Every number here was
// already being emitted to the log; this is what puts it somewhere anybody
// would look. See session_timeline.ts for why it is memory-only.
const sessionTimeline = new SessionTimeline();
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
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  pointerStateChild.stdin.on('error', (error) => {
    log(`pointer hook command stream error ${error.name}: ${error.message}`);
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
          swallowingLeft: parsed.swallowingLeft === true,
          captureArmed: parsed.captureArmed === true,
        };
        // 收藏箱要知道「这张图是从哪个应用来的」，但按下 Win+Shift+S 的那一瞬间
        // 前台是截图工具，我们自己的浮层也会抢前台。所以只记住真正的应用，
        // 外壳进程一律跳过——采集发生在 700ms 之后，那时这个值仍然是对的。
        if (!isTransientShell(pointerInputState.foregroundApp)) {
          lastStableForegroundApp = pointerInputState.foregroundApp;
          lastStableForegroundWindow = {
            app: pointerInputState.foregroundApp,
            hwnd: pointerInputState.foregroundHwnd,
            process_id: pointerInputState.foregroundProcessId,
          };
        }
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
      swallowingLeft: false,
      captureArmed: false,
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
  syncPointerEpisodeChord();
}

function sendPointerInputCommand(command) {
  if (process.platform !== 'win32') return false;
  const line = String(command || '').trim();
  if (!line || !pointerStateChild?.stdin || pointerStateChild.stdin.destroyed || !pointerStateChild.stdin.writable) {
    return false;
  }
  try {
    pointerStateChild.stdin.write(`${line}\n`);
    return true;
  } catch (error) {
    log(`pointer hook command failed ${error.name}: ${error.message}`);
    return false;
  }
}

function configuredEpisodeChord() {
  const value = String(fabricSettings?.activation?.mouse_side_button || 'none').trim().toLowerCase();
  return ['xbutton1', 'xbutton2', 'middle_hold'].includes(value) ? value : 'none';
}

function syncPointerEpisodeChord() {
  const episode = interactionEpisodes.active();
  if (!episode) return sendPointerInputCommand('idle');
  return sendPointerInputCommand(`episode:${configuredEpisodeChord()}`);
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
      label: onboardingRequired ? '继续首次设置' : '打开工作室',
      click: () => showPrimarySurface({ activate: true }),
    },
    {
      label: '打开随行窗',
      enabled: !onboardingRequired,
      click: () => showCompanion({}, { activate: true }),
    },
    {
      label: '设置…',
      enabled: !onboardingRequired,
      click: () => showPrimarySurface({ activate: true, view: 'settings' }),
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

// The capsule used to wait for the whole perception pass (screenshot + UIA +
// OCR + annotation, measured at 4.9s on a real machine) before it appeared.
// That is fatal for the interaction we want: you cannot draw, talk, draw again
// if every draw costs five seconds. Two gates control how early it shows.
//
// CAPSULE_CONTENT_PROTECTED asks Windows to exclude the stage window from
// screen capture (SetWindowDisplayAffinity/WDA_EXCLUDEFROMCAPTURE). When that
// holds, the capsule can never contaminate the screenshot, so it may appear
// immediately — before Python has even started. Verify it on real hardware by
// opening the newest .png under data/runtime/selection-captures: the capsule
// must not be in the image, and the capsule itself must not render black.
//
// If that verification fails, set this to false. The capsule then waits for the
// CAPSULE_REVEAL_PHASE marker instead — the moment the pixels are frozen and
// attested, which is the earliest point that is safe without content
// protection. Falling back costs latency, never correctness.
const CAPSULE_CONTENT_PROTECTED = true;
const CAPSULE_REVEAL_PHASE = 'pixels_frozen';

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
  if (CAPSULE_CONTENT_PROTECTED) {
    // Not a DRM feature here — this is what buys the capsule the right to be on
    // screen while we screenshot the desktop underneath it.
    try {
      stageWindow.setContentProtection(true);
    } catch (error) {
      log(`stage content protection unavailable: ${error?.message || error}`);
    }
  }
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
    // Already validated by the settings store, so the renderer receives a
    // known-good "r, g, b" and never has to trust a settings file.
    accentRgb: String(fabricSettings.appearance?.accent_rgb || ''),
  };
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('stage:show', trustedPayload);
    if (!win.isVisible()) win.showInactive();
  };
  stageReadiness.whenReady(send);
}

function updateStage(payload = {}) {
  // Every outcome the user sees passes through here, which makes it the one
  // place that knows how a session actually ended.
  const type = payload?.event?.type;
  if (payload?.selectionSessionToken && (type === 'RESULT' || type === 'ERROR' || type === 'COMPLETE')) {
    sessionTimeline.finish(payload.selectionSessionToken, {
      outcome: type === 'ERROR' ? 'error' : 'result',
      // Already a written sentence by the time it reaches the stage; error codes
      // are stopped at stage_contract.
      error: type === 'ERROR' ? String(payload.event?.error?.message || '') : '',
      tier: String(payload.event?.result?.route?.tier || ''),
    });
  }
  if (type === 'RESULT' || type === 'COMPLETE' || type === 'ERROR') recordConversationTurn(payload, type);
  // 图相关结果（图转提示词/生图/截屏分析）→ 输入图自动进收藏箱：
  // 用户要的结果图不该只活在对话里，收藏箱随时能翻回来。
  autoStashResultImage(payload);
  // 「已受理」不是「已完成」。后台任务这时候才刚起来，卡上要继续动——
  // 底层早就能查状态了，缺的一直是这边没在看。
  watchTaskFromEvent(payload);
  safeSurfaceSend('stage', 'stage:update', payload);
  // Clicky 式引导：回答里带了 [POINT] 指点，就把目标点给蓝边光标所在的
  // overlay——小三角默认不出现，只有回答要「指给你看」时才飞过去。
  const event = payload?.event || {};
  const points = Array.isArray(event.screenPoints) ? event.screenPoints : [];
  if (points.length) {
    const p = points[0];
    const x = Number(p.x);
    const y = Number(p.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      // 回答阶段 overlay 通常已隐藏（划线提交后 hideOverlay）——指向需要
      // 一个可见的透明层来画三角。没有就临时拉起：穿透、不抢焦点、不拦截。
      // 必须先等渲染器就绪再 show+send：对一个还在加载的窗口 showInactive()
      // 只会留下一层永远可见的透明窗（wiggle 检测因此被关掉），overlay:show
      // 和 overlay:guide-point 也会因为无人订阅而丢掉。
      if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
      const win = overlayWindow;
      if (win && !win.isDestroyed()) {
        const revealGuide = () => {
          if (!win || win.isDestroyed()) return;
          const display = screen.getDisplayNearestPoint({ x, y });
          const bounds = win.getBounds();
          const desired = display.bounds;
          if (Math.abs(bounds.x - desired.x) > 1 || Math.abs(bounds.y - desired.y) > 1
            || Math.abs(bounds.width - desired.width) > 1 || Math.abs(bounds.height - desired.height) > 1) {
            win.setBounds(desired);
          }
          if (!win.isVisible()) {
            win.setIgnoreMouseEvents(true, { forward: true });
            overlayOwnsPointerInput = false;
            win.showInactive();
            if (typeof win.setFocusable === 'function') win.setFocusable(false);
            win.webContents.send('overlay:show', {
              reason: 'guide-point',
              workflow: 'generic',
              gestureMode: false,
              observerMode: false,
              selectionGestureToken: null,
              gestureAcceptAt: 0,
              gestureLineStyle: 'demo6_band',
              gestureLineWidth: 22,
              gestureChainGapMs: 1500,
              gestureInteractionMode: 'exclusive_overlay',
            });
          }
          sendCursorToOverlay();
          // [POINT] 坐标是物理屏幕像素（视觉模型看全屏截图给出），overlay
          // canvas 是 DIP——先除缩放，overlay 里直接当窗口坐标用。
          const scale = (display && display.scaleFactor) || 1;
          win.webContents.send('overlay:guide-point', {
            x: x / scale,
            y: y / scale,
            count: points.length,
          });
        };
        overlayReadiness.whenReady(revealGuide);
      }
    }
  }
}

// 结果里带了 taskId 且状态是「已受理」，就开始盯着它，把状态变成卡片补丁。
function watchTaskFromEvent(payload = {}) {
  const result = payload?.event?.result;
  if (!result || typeof result !== 'object') return;
  const taskId = String(result.taskId || '');
  if (!taskId || result.status === 'succeeded' || result.status === 'failed') return;
  taskWatcher().watch({
    taskId,
    cardId: String(result.cardId || `t-${taskId}`),
    selectionSessionToken: payload.selectionSessionToken || '',
  });
}

let taskWatcherInstance = null;

function taskWatcher() {
  if (taskWatcherInstance) return taskWatcherInstance;
  taskWatcherInstance = createTaskWatcher({
    log,
    CardModel,
    probe: async (taskId) => {
      const parsed = await runPythonBridgePromise(
        { operation: 'status', taskId },
        'scripts/agent_bridge.py',
        { target: 'stage', timeoutMs: 8000 },
      );
      return parsed?.task || null;
    },
    onPatch: ({ cardId, selectionSessionToken, patch }) => {
      safeSurfaceSend('stage', 'stage:card-patch', { cardId, selectionSessionToken, patch });
      // 随行窗和工作室看的是同一次会话，所以它们也要收到——
      // 「他们俩应该是完全同步的才对」。
      for (const window of [companionWindow, dashboardWindow]) {
        if (window && !window.isDestroyed()) {
          window.webContents.send('stage:card-patch', { cardId, selectionSessionToken, patch });
        }
      }
    },
  });
  return taskWatcherInstance;
}

// ---------------------------------------------------------------------------
// 对话记录
// ---------------------------------------------------------------------------
let conversationStore = null;

function conversations() {
  if (!conversationStore) {
    conversationStore = createConversationStore({
      baseDir: path.join(app.getPath('userData'), 'history'),
      log,
    });
  }
  return conversationStore;
}

const pendingQuestions = new Map();

// stage_contract 给出的三种终态，各自把正文放在不同字段里。
// 这里必须全部覆盖——只认 result.answer 的话，写回成功（COMPLETE 没有 result）
// 和交接草稿（正文在 result.prompt）都会被静默丢掉。
function answerTextFrom(event = {}) {
  const r = event.result || {};
  if (event.type === 'ERROR') return String(event.error?.message || '这次没能完成。');
  if (event.type === 'COMPLETE') {
    return event.outcome?.verified ? '已完成，并回读确认过。' : '已完成。';
  }
  return String(r.answer || r.prompt || r.text || r.detail || '').trim();
}

// updateStage 是所有结果的必经之路，所以记录也挂在这里——
// 别的地方再加一处，迟早会漏掉一条。
function recordConversationTurn(payload = {}, type = '') {
  try {
    const token = payload.selectionSessionToken || '';
    const question = (pendingQuestions.get(token) || '').trim();
    const answer = answerTextFrom(payload.event || {});
    if (token) pendingQuestions.delete(token);
    if (!question && !answer) {
      log(`conversation skip token=${token || 'none'} type=${type} reason=empty`);
      return;
    }

    const entry = payload.selectionSessionToken
      ? selectionSessions.get(payload.selectionSessionToken)
      : null;
    const object = entry ? episodeObjectForSession(entry) : {};

    const result = payload?.event?.result || {};
    const conversation = conversations().appendTurn({
      question,
      answer,
      outcome: type === 'ERROR' ? '失败' : (type === 'COMPLETE' ? '已完成' : String(result.route?.tier || '')),
      artifacts: Array.isArray(result.actions)
        ? result.actions.filter((a) => a?.artifact).map((a) => ({ name: a.label || a.artifact, kind: 'file' }))
        : [],
      object: {
        app: object.app || '',
        windowTitle: object.windowTitle || '',
        elementPath: object.snapshotId || '',
        label: object.label || '',
        annotatedPath: object.source?.annotatedPath || '',
      },
    });

    log(`conversation + ${conversation.id} type=${type} q_len=${question.length} a_len=${answer.length}`);
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('conversations:turn', { id: conversation.id });
    }
    if (companionWindow && !companionWindow.isDestroyed()) {
      companionWindow.webContents.send('conversations:turn', { id: conversation.id });
    }
  } catch (error) {
    log(`conversation record failed ${error.name}`);
  }
}

ipcMain.handle('conversations:list', (event) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().list(); } catch (_) { return []; }
});
ipcMain.handle('conversations:get', (event, id) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return null;
  try { return conversations().get(id); } catch (_) { return null; }
});
ipcMain.handle('conversations:timeline', (event) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().timeline(); } catch (_) { return []; }
});
ipcMain.handle('conversations:memories', (event) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().memories(); } catch (_) { return []; }
});
ipcMain.handle('conversations:artifacts', (event) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().artifacts(); } catch (_) { return []; }
});

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

function applyStageShape(dipRegions) {
  if (!stageWindow || stageWindow.isDestroyed()) return;
  const regions = nativeShapeRegions({
    platform: process.platform,
    screenApi: screen,
    stageBounds: stageWindow.getBounds(),
    regions: dipRegions,
  });
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

// Last gate before a failure reaches the bubble. Callers may pass a written
// sentence or a bridge code; only sentences get through.
// Narrow a snapshot to the strokes the user kept in the composer.
//
// An empty or absent list means "everything", because that is what a session
// with no chip edits looks like. A list that would remove every stroke is
// ignored: submitting a gesture with nothing selected would make the perception
// work meaningless, and the user removing the last chip means they want to redraw.
function withKeptStrokes(snapshot, keptStrokeIndexes) {
  if (!snapshot || !Array.isArray(keptStrokeIndexes) || keptStrokeIndexes.length === 0) return snapshot;
  const strokes = snapshot?.selection_gesture?.strokes;
  if (!Array.isArray(strokes) || strokes.length <= 1) return snapshot;
  const keep = new Set(keptStrokeIndexes.map((value) => Number(value)));
  const kept = strokes.filter((_stroke, index) => keep.has(index));
  if (kept.length === 0 || kept.length === strokes.length) return snapshot;
  log(`stage submit dropped strokes kept=${kept.length}/${strokes.length}`);
  return {
    ...snapshot,
    selection_gesture: { ...snapshot.selection_gesture, strokes: kept },
    // The recorded bbox described all the strokes, so it no longer describes
    // this selection. Better absent than wrong: the bridge recomputes from the
    // strokes it is given.
    selection_bbox: null,
  };
}

// Narrow a snapshot to the element the user clicked on.
//
// A pick lights the element up, so the command has to act on that element and
// nothing else. Without this the highlight is a promise the request does not
// keep: the box glows and the answer is about whatever was selected before.
//
// The strokes go with it. They described a different region, and keeping both
// would ask the perception layer to reconcile two claims about what "this" is.
function withPickedElement(snapshot, picked) {
  const rect = picked && picked.rect;
  if (!snapshot || !rect) return snapshot;
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (!(width > 0 && height > 0)) return snapshot;
  return {
    ...snapshot,
    selection_bbox: [Number(rect.x) || 0, Number(rect.y) || 0, width, height],
    selection_gesture: null,
    selection_segments: null,
    picked_element_source: String(picked.source || 'structured'),
  };
}

function deliverStageError(selectionSessionToken, message) {
  updateStage({
    selectionSessionToken: selectionSessionToken || null,
    event: { type: 'ERROR', error: { message: humanErrorMessage(message) } },
  });
}

function dashboardMaterial(settings = fabricSettings) {
  if (settings?.accessibility?.reduce_transparency === true) return 'none';
  return settings?.appearance?.material === 'solid' ? 'none' : 'mica';
}

// 系统按钮画在我们自己的底色上，所以必须跟「应用的主题」走，不是跟系统。
// 系统深色 + 应用浅色时跟系统走，右上角就会出现一条突兀的黑条。
function appIsDark() {
  const theme = fabricSettings?.appearance?.theme || 'light';
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return nativeTheme.shouldUseDarkColors;      // 只有「跟随系统」时才问系统
}

// 底色留全透明——页面自己的底透上来就行。只换符号的颜色去对比它。
// 给 overlay 涂实色会在右上角糊出一块和页面对不上的方块。
function titleBarColors(symbol = null) {
  return {
    color: '#00000000',
    symbolColor: symbol || (appIsDark() ? '#F2F1ED' : '#17170F'),
    height: 44,
  };
}

// ── 标题栏符号颜色：采样按钮底下的真实像素，不是猜主题 ─────────────
// 主屏背景是用户自定义的视频/图片，明暗不定；主题只能给个初始值。
// 每个采样周期截右上角按钮区域，算平均亮度：底亮 → 深色符号，底暗 →
// 浅色符号。周期 500ms，仅采样 138×44 的小区域，开销可忽略。
const { averageBrightness, symbolColorForBrightness } = require('./titlebar_contrast');
const TITLEBAR_SAMPLE_REGION = { width: 138, height: 44 };
let titleBarSampleTimer = null;
let titleBarLastSymbol = null;

function sampleTitleBarSymbolColor() {
  if (process.platform !== 'win32' || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  if (!dashboardWindow.isVisible()) return;
  const bounds = dashboardWindow.getBounds();
  const rect = {
    x: Math.max(0, bounds.width - TITLEBAR_SAMPLE_REGION.width),
    y: 0,
    width: TITLEBAR_SAMPLE_REGION.width,
    height: TITLEBAR_SAMPLE_REGION.height,
  };
  dashboardWindow.webContents.capturePage(rect).then((image) => {
    if (image.isEmpty()) return;
    const symbol = symbolColorForBrightness(averageBrightness(image.toBitmap()));
    if (symbol !== titleBarLastSymbol) {
      titleBarLastSymbol = symbol;
      try {
        dashboardWindow.setTitleBarOverlay(titleBarColors(symbol));
      } catch (error) {
        log(`title bar overlay unavailable ${error.name}`);
      }
    }
  }).catch(() => { /* 采样失败保持上一次的颜色 */ });
}

function startTitleBarSampling() {
  stopTitleBarSampling();
  sampleTitleBarSymbolColor();
  titleBarSampleTimer = setInterval(sampleTitleBarSymbolColor, 500);
}

function stopTitleBarSampling() {
  if (titleBarSampleTimer) {
    clearInterval(titleBarSampleTimer);
    titleBarSampleTimer = null;
  }
}

function applyTitleBarTheme() {
  if (process.platform !== 'win32' || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  try {
    dashboardWindow.setTitleBarOverlay(titleBarColors(titleBarLastSymbol));
  } catch (error) {
    log(`title bar overlay unavailable ${error.name}`);
  }
}

nativeTheme.on('updated', applyTitleBarTheme);

// 渲染层切主题时同步过来，否则按钮颜色会滞后一个来回
ipcMain.on('dashboard:theme', () => setImmediate(applyTitleBarTheme));

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
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 700,
    title: 'Magic Pointer',
    titleBarStyle: 'hidden',
    // 系统按钮画在我们的暖底上：底色必须给实色，否则 Windows 会用默认灰，看不见。
    titleBarOverlay: process.platform === 'darwin' ? { height: 44 } : titleBarColors(),
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
  // 主窗口 = 工作室（对话 / 收藏箱 / 时间线 / 产物 / 设置）。
  // 旧的 dashboard.html 仍在磁盘上，未删除，只是不再是主界面。
  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'studio.html'));
  dashboardWindow.on('close', (event) => {
    if (!isQuitting && fabricSettings?.general?.keep_running !== false) {
      event.preventDefault();
      dashboardWindow.hide();
      stopTitleBarSampling();
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
  dashboardWindow.on('closed', () => { dashboardWindow = null; stopTitleBarSampling(); });
  return dashboardWindow;
}

// ---------------------------------------------------------------------------
// 收藏箱：剪贴板里出现位图就落盘，并把本地路径写回剪贴板。
// 「一起进来的」按 2 分钟窗口 + 同来源成簇（见 stash_store.js）。
// ---------------------------------------------------------------------------
let stashRuntime = null;

function stashBaseDir() {
  const configured = fabricSettings?.stash?.dir;
  if (configured) return configured;
  return path.join(app.getPath('userData'), 'stash');
}

function initializeStashRuntime() {
  if (stashRuntime) return stashRuntime;
  stashRuntime = createStashRuntime({
    clipboard,
    baseDir: stashBaseDir(),
    log,
    pythonExecutable: PYTHON_EXECUTABLE,
    settings: () => fabricSettings || {},
    // 落盘时顺手记下「你截的是哪个窗口的哪个元素」——这是 OCR 拿不到的。
    //
    // 有活动选区会话时能拿到元素名和选中文本，那是最强的证据。但用户在微信里
    // 截图、在终端里复制的时候根本没有选区会话——那才是主场景。只认会话的话，
    // app 永远是空，于是所有东西都归成「素材」、挤进同一簇，整条归类和成簇的
    // 证据链在最常见的路径上是空转的。
    //
    // 退一步用常驻指针流里的前台进程名（已经在内存里，零成本），再退一步留空。
    // 绝不猜。
    focusProbe: async () => {
      const fallback = () => (
        lastStableForegroundApp ? { app: lastStableForegroundApp } : {}
      );
      try {
        const entry = activeSelectionSessionToken
          ? selectionSessions.get(activeSelectionSessionToken)
          : null;
        if (!entry) return fallback();
        const object = episodeObjectForSession(entry);
        return {
          app: object.app || lastStableForegroundApp || '',
          windowTitle: object.windowTitle || '',
          elementName: object.label || '',
          elementPath: object.snapshotId || '',
          selectionText: object.content || '',
        };
      } catch (_) {
        return fallback();
      }
    },
    onEntry: (entry) => {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('stash:entry', entry);
      }
      // 主动提议：截图/文本入库事件喂给规则引擎（Vida 主动层）。
      // 规则触发只记日志——提案 UI 待 proactive_runtime 完整接线后接上。
      feedProactiveEvent({
        kind: entry?.media === 'image' ? 'shot' : 'clip',
        app: entry?.app || '',
        t: entry?.capturedAt || Date.now(),
      });
    },
  });
  if (fabricSettings?.stash?.clipboard !== false) stashRuntime.start();
  return stashRuntime;
}

// ── 主动提议（Vida 主动层触发判断）───────────────────────────────
// 事件进规则引擎（proactive_rules.ts 纯函数），触发时查 once_store
// （一生一次），通过则记日志并暂存待 UI 提案。零模型调用。
let proactiveRuleState = null;
let proactiveOnceStore = null;

function proactiveStore() {
  if (proactiveOnceStore) return proactiveOnceStore;
  proactiveOnceStore = createProactiveOnceStore({
    load: () => {
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(app.getPath('userData'), 'proactive-once.json'), 'utf8'),
        );
        return raw && typeof raw === 'object' ? raw : {};
      } catch (_) {
        return {};
      }
    },
    persist: () => {
      try {
        fs.writeFileSync(
          path.join(app.getPath('userData'), 'proactive-once.json'),
          JSON.stringify(proactiveOnceStore._items()),
          'utf8',
        );
      } catch (_) { /* 存储失败不影响主功能 */ }
    },
  });
  return proactiveOnceStore;
}

// 图相关结果（图转提示词/生图/截屏分析）→ 输入图自动进收藏箱。
// 用户要的结果图不该只活在对话里，收藏箱随时能翻回来。失败静默
// （收藏是副作用，不是主路径）。
function autoStashResultImage(payload) {
  try {
    if (fabricSettings?.stash?.clipboard === false) return;
    const token = payload?.selectionSessionToken;
    const entry = token ? selectionSessions.get(token) : null;
    if (!entry) return;
    // 图相关 = 用户划的是图片/屏幕区域（image / screen_region），
    // 不是文本选区。图转提示词/生图/截屏分析都落在这两类上。
    const sourceKind = String(entry?.snapshot?.source_kind || '');
    if (!/image|screen_region/.test(sourceKind)) return;
    const object = episodeObjectForSession(entry);
    const candidates = [object.source?.annotatedPath, object.source?.path].filter(Boolean);
    const file = candidates.find((p) => {
      try { return fs.statSync(p).isFile() && /\.(png|jpe?g|webp|bmp)$/i.test(p); } catch (_) { return false; }
    });
    if (!file) return;
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) return;
    initializeStashRuntime().ingest(image, 'shot').catch(() => {});
  } catch (_) { /* 收藏失败不影响结果 */ }
}

function feedProactiveEvent(event) {
  if (fabricSettings?.interaction?.proactive === false) return;
  const rule = proactiveRuleState
    ? evaluateRule('burst_screenshots', event, proactiveRuleState)
    : evaluateRule('burst_screenshots', event, null);
  proactiveRuleState = rule.state;
  if (!rule.trigger) return;
  const store = proactiveStore();
  const triggerId = 'burst_screenshots';
  if (!store.shouldShow(triggerId)) return;
  store.markShown(triggerId);
  log(`proactive trigger rule=burst_screenshots once=${triggerId}`);
  // 提案 UI 落点：后续 proactive_runtime 在这里弹非焦点提案卡。
}

ipcMain.handle('stash:list', () => {
  try {
    return initializeStashRuntime().list();
  } catch (error) {
    log(`stash list failed ${error.name}`);
    return [];
  }
});

// 悬停收藏图片 1 秒后调用：本地文件 + 视觉模型 → 3-4 句简介。
// 输入是用户自己收藏的本地文件，不是截屏上传，不走隐私开关。
ipcMain.handle('stash:describe', async (event, imagePath) => {
  // 只允许主界面（dashboard）窗口调用，且路径必须落在 stash 目录里——
  // 否则任意渲染进程都能让模型读任意本地文件（信息泄漏）。
  if (!event.sender || event.sender !== dashboardWindow?.webContents) {
    return { ok: false, error: 'forbidden_sender' };
  }
  const root = path.resolve(stashBaseDir());
  const target = path.resolve(String(imagePath || ''));
  if (target !== root && !target.startsWith(root + path.sep)) {
    log(`stash describe blocked: path outside stash dir ${target}`);
    return { ok: false, error: 'forbidden_path' };
  }
  try {
    const parsed = await runPythonBridgePromise(
      { operation: 'describe', imagePath: target },
      'scripts/stash_describe_bridge.py',
      { target: 'fabric-dashboard', timeoutMs: 30000 },
    );
    if (parsed?.ok && parsed.summary) return { ok: true, summary: String(parsed.summary) };
    return { ok: false, error: parsed?.error || 'vision_unavailable' };
  } catch (error) {
    log(`stash describe failed ${error.name}`);
    return { ok: false, error: 'bridge_failed' };
  }
});

let companionWindow = null;

function createCompanionWindow() {
  if (companionWindow && !companionWindow.isDestroyed()) return companionWindow;
  companionWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 420,
    title: 'Magic Pointer',
    frame: false,
    titleBarStyle: 'hidden',
    transparent: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191815' : '#F2F1ED',
    backgroundMaterial: process.platform === 'win32' ? 'mica' : undefined,
    vibrancy: process.platform === 'darwin' ? 'sidebar' : undefined,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
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
  companionWindow.loadFile(path.join(__dirname, 'renderer', 'companion.html'));
  companionWindow.on('blur', () => {
    if (!companionWindow || companionWindow.isDestroyed()) return;
    if (companionPinned) return;
    companionWindow.hide();
  });
  companionWindow.on('closed', () => { companionWindow = null; });
  return companionWindow;
}

let companionPinned = true;

// 随行窗贴到光标所在屏幕的右侧，和舞台共用同一个会话。
function showCompanion(payload = {}, options = {}) {
  const win = createCompanionWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea || display.bounds;
  const width = 420;
  const height = Math.min(720, Math.max(420, area.height - 120));
  const bounds = {
    x: area.x + area.width - width - 24,
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height,
  };
  const reveal = () => {
    if (!companionWindow || companionWindow.isDestroyed()) return;
    companionWindow.setBounds(bounds);
    if (options.activate === false) companionWindow.showInactive();
    else companionWindow.show();
    companionWindow.webContents.send('companion:show', payload);
    log('showCompanion');
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
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
    startTitleBarSampling();
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
  else showDashboard({ view: options.view || 'chat' }, options);
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
  // 无论 hideObserver 与否，overlay 必须释放鼠标拦截——否则划线被取消后
  // overlay 仍吞鼠标，用户点不到下面的应用（cancelSelectionGesture 的
  // hideSurface:false 路径不释放 overlay 输入）。
  if (overlayOwnsPointerInput && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayOwnsPointerInput = false;
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

function armTemporaryGestureSubmitShortcut(token) {
  if (temporaryGestureSubmitShortcutRegistered) return true;
  try {
    temporaryGestureSubmitShortcutRegistered = globalShortcut.register('Enter', () => {
      const arm = selectionGestureArm;
      if (!arm || arm.token !== String(token || '')) return;
      safeSurfaceSend('overlay', 'overlay:gesture-submit', { token: arm.token });
    });
  } catch (_) {
    temporaryGestureSubmitShortcutRegistered = false;
  }
  log(`temporary Enter gesture submit registered=${temporaryGestureSubmitShortcutRegistered}`);
  return temporaryGestureSubmitShortcutRegistered;
}

function disarmTemporaryGestureSubmitShortcut() {
  if (!temporaryGestureSubmitShortcutRegistered) return;
  try { globalShortcut.unregister('Enter'); } catch (_) {}
  temporaryGestureSubmitShortcutRegistered = false;
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

function isSelectionGestureActivation(reason) {
  const value = String(reason || '');
  return value === 'wiggle'
    || value === 'shortcut-wake'
    || value === 'episode-continue'
    || value.startsWith('mouse-button-');
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
    hasVisibleSurface: hasVisibleTemporarySurface()
      || Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
    isActivationBusy: hasActiveSelectionCapture() || Boolean(selectionGestureArm),
  });
  log(`activation request reason=${reason} decision=${decision}`);
  if (decision === 'dismiss') {
    const continuingEpisode = interactionEpisodes.active();
    if (continuingEpisode && isSelectionGestureActivation(reason)) {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      armSelectionGesture(reason);
      return 'continue';
    }
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  } else if (decision === 'activate') {
    if (isSelectionGestureActivation(reason)) armSelectionGesture(reason);
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
    idleUnloadMs: Number.isInteger(interaction.voice_idle_unload_ms) ? interaction.voice_idle_unload_ms : 0,
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
    idleUnloadMs: Number(fabricSettings?.interaction?.voice_idle_unload_ms) || 0,
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
  // Safety net for users with a stored/custom idle-unload value: after the
  // worker drops the model for idle, re-warm so the next voice ball does not
  // pay a 4-11s cold model load. The default config never idle-unloads (0),
  // so this path only fires for legacy/non-zero settings.
  if (
    status.state === 'unloaded'
    && status.errorCode === 'idle_timeout'
    && !isQuitting
    && fabricSettings?.interaction?.voice_resident_enabled !== false
  ) {
    setTimeout(() => {
      if (isQuitting) return;
      const started = voiceRuntime?.warmUp() === true;
      if (started) log('voice idle-unload re-warmed');
    }, 750);
  }
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

// overlay 当前覆盖的屏幕 index（避免高频轮询反复 setBounds）。
let overlayBoundDisplayId = null;

function sendCursorToOverlay(pos = screen.getCursorScreenPoint()) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
  const display = screen.getDisplayNearestPoint(pos);
  const desired = display.bounds;
  const current = overlayWindow.getBounds();
  // 只有光标跨屏（overlay 要换屏覆盖）才 setBounds。高频轮询下反复
  // setBounds 会让 Windows 每次重设光标区域——光标在 CSS 光标和原生
  // 光标之间闪的根源（与光标格式无关，之前误判为 SVG 问题）。
  const moved = Math.abs(current.x - desired.x) > 1
    || Math.abs(current.y - desired.y) > 1
    || Math.abs(current.width - desired.width) > 1
    || Math.abs(current.height - desired.height) > 1;
  if (moved && overlayBoundDisplayId !== display.id) {
    overlayWindow.setBounds(desired);
    overlayBoundDisplayId = display.id;
  }
  const bounds = overlayWindow.getBounds();
  overlayWindow.webContents.send('overlay:cursor', {
    x: pos.x - bounds.x,
    y: pos.y - bounds.y,
    globalX: pos.x,
    globalY: pos.y,
  });
}
function hideOverlay() {
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = null;
  if (!overlayWindow) return;
  overlayWindow.webContents.send('overlay:hide');
  overlayWindow.hide();
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayOwnsPointerInput = false;
  overlayBoundDisplayId = null;
  if (typeof overlayWindow.setFocusable === 'function') overlayWindow.setFocusable(false);
  log('hideOverlay');
}

function cancelSelectionGesture(reason = 'cancelled', { hideSurface = true } = {}) {
  const active = selectionGestureArm;
  if (passThroughChainTimer) clearTimeout(passThroughChainTimer);
  passThroughChainTimer = null;
  passThroughChainDeadlineAt = 0;
  passThroughChainLastPoint = null;
  passThroughGestureCapture.cancel();
  sendPointerInputCommand('idle');
  if (selectionGestureArmTimer) clearTimeout(selectionGestureArmTimer);
  if (selectionGestureExpiryTimer) clearTimeout(selectionGestureExpiryTimer);
  if (selectionGestureCommitTimer) clearTimeout(selectionGestureCommitTimer);
  selectionGestureArmTimer = null;
  selectionGestureExpiryTimer = null;
  selectionGestureCommitTimer = null;
  selectionGestureArm = null;
  disarmTemporaryGestureSubmitShortcut();
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
      multiStroke: true,
    });
    sendPointerInputCommand(`capture-next:${timeoutMs}:${runtime.chainGapMs}`);
  }
  // Warm the hidden capsule renderer during the arm grace period. By the time
  // the user releases a stroke it can paint immediately without startup jank.
  createStageWindow();
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
      // 本屏首次轮询会重新对齐一次，之后不再 setBounds（避免光标闪）
      overlayBoundDisplayId = null;
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
        gestureChainGapMs: arm.runtime.chainGapMs,
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

function markSelectionGestureDrawing(token, { timeoutMs = null, reason = 'draw_timeout' } = {}) {
  const arm = selectionGestureArm;
  if (!arm || String(token || '') !== arm.token) return false;
  if (selectionGestureExpiryTimer) clearTimeout(selectionGestureExpiryTimer);
  const leaseMs = Math.max(1, Number(timeoutMs) || Number(arm.timeoutMs || SELECTION_GESTURE_TIMEOUT_MS));
  selectionGestureExpiryTimer = setTimeout(() => {
    if (selectionGestureArm?.token === arm.token) cancelSelectionGesture(reason);
  }, leaseMs);
  log(`selection gesture lease token=${arm.token} reason=${reason} timeout_ms=${leaseMs}`);
  return true;
}

function completeSelectionGesture(payload) {
  const arm = selectionGestureArm;
  if (!arm || String(payload?.selectionGestureToken || '') !== arm.token) {
    cancelSelectionGesture('stale');
    return false;
  }
  const summary = summarizeGesture(payload?.points, payload?.strokes);
  if (!summary.valid) {
    cancelSelectionGesture(summary.reason || 'invalid');
    return false;
  }
  // Per-point display lookup: each point's physical coordinate is computed
  // against the display that contains it, not a single global scale factor.
  // Formula: X_phys = Screen_Physical_Origin + (Local_Logical_X × sf_display)
  // This prevents nonlinear origin shift when displays have different scale
  // factors (e.g. primary 100%, secondary 150%).
  //
  // The renderer's points are LOCAL to the overlay window, which covers one
  // display. Feed screen coordinates to getDisplayNearestPoint: without the
  // window offset, points drawn on a secondary display (bounds.x/y ≠ 0) are
  // looked up against the primary display and the whole selection shifts by
  // the display origin.
  const gestureFrame = (overlayWindow && !overlayWindow.isDestroyed())
    ? overlayWindow.getBounds()
    : arm.displayBounds;
  const toPhysical = (point) => {
    const px = Number(point.x) + gestureFrame.x;
    const py = Number(point.y) + gestureFrame.y;
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
  const armDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scaleFactor = armDisplay.scaleFactor || 1;
  const gesture = {
    schemaVersion: 2,
    coordinateSpace: 'physical_screen_pixels',
    points: physicalPoints,
    strokes: physicalStrokes,
    bbox: physicalGestureBoundingBox(allPhysical, 8 * scaleFactor),
    kind: summary.kind,
    semanticPoint: summary.semanticPoint
      ? toPhysical(summary.semanticPoint)
      : undefined,
    releasePoint: toPhysical(summary.releasePoint),
    // Multi-stroke sessions anchor the capsule at the FIRST stroke so it never
    // jumps while the user keeps circling; single strokes keep the release
    // point as the anchor.
    anchorPoint: summary.anchorPoint ? toPhysical(summary.anchorPoint) : toPhysical(summary.releasePoint),
    // Stroke region geometry (logical DIPs): polygon ring for circles,
    // bandwidth corridor for lines/freeforms. Used by grounding to rank
    // targets by region coverage instead of a single point.
    geometry: summary.geometry || undefined,
    direction: summary.direction || undefined,
    displayBounds: { ...armDisplay.bounds },
    scaleFactor,
    source: { ...arm.source },
  };
  const reason = arm.reason;
  cancelSelectionGesture('completed');
  // One compositor frame after hiding the drawing canvas prevents it from
  // entering pixel fallback captures. Stage remains absent during this gap.
  // The timer is owned by cancelSelectionGesture: a dismiss/re-arm inside the
  // gap cancels it instead of opening a stale session.
  selectionGestureCommitTimer = setTimeout(() => {
    selectionGestureCommitTimer = null;
    beginSelectionSession(reason, gesture);
  }, 34);
  return true;
}

function schedulePassThroughChainFinalize() {
  if (passThroughChainTimer) clearTimeout(passThroughChainTimer);
  const delay = chainFinalizeDelay({
    now: performance.now(),
    deadlineAt: passThroughChainDeadlineAt,
  });
  passThroughChainTimer = setTimeout(() => {
    passThroughChainTimer = null;
    const completed = passThroughGestureCapture.finish();
    if (!completed || completed.token !== selectionGestureArm?.token) return;
    completeSelectionGesture({
      workflow: 'selection_gesture',
      selectionGestureToken: completed.token,
      points: completed.points,
      strokes: completed.strokes,
    });
  }, delay);
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
      if (passThroughChainTimer) clearTimeout(passThroughChainTimer);
      passThroughChainTimer = null;
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
    } else if (event.type === 'stroke-completed') {
      safeSurfaceSend('overlay', 'overlay:gesture-input', {
        token: event.token,
        phase: 'end',
      });
      markSelectionGestureDrawing(event.token, {
        timeoutMs: arm.runtime.chainGapMs + 1000,
        reason: 'chain_timeout',
      });
      passThroughChainDeadlineAt = performance.now() + arm.runtime.chainGapMs;
      passThroughChainLastPoint = event.releasePoint || null;
      schedulePassThroughChainFinalize();
    } else if (event.type === 'completed') {
      completeSelectionGesture({
        workflow: 'selection_gesture',
        selectionGestureToken: event.token,
        points: event.points,
        strokes: event.strokes,
      });
    }
  }
  if (
    passThroughChainTimer
    && passThroughGestureCapture.active
    && !passThroughGestureCapture.drawing
    && passThroughGestureCapture.strokes.length > 0
  ) {
    const localPoint = passThroughGestureCapture.localPoint({ x: pos.x, y: pos.y, t: now });
    if (pointerContinuesGestureChain(passThroughChainLastPoint, localPoint)) {
      passThroughChainLastPoint = localPoint;
      schedulePassThroughChainFinalize();
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
    // 滚动量只在 wiggle 判定那里读一次，但必须在 tick 开头就清零——
    // 中段的 early return（临时表面可见、overlay 可见）会跳过读取，
    // 不清零的话整段手势期间的滚动会攒成一笔，表面消失后误触一次唤醒。
    const scrollDelta = pointerInputState.scrollDelta;
    pointerInputState.scrollDelta = 0;
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) sendCursorToOverlay(pos);
    if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
      const stageBounds = stageWindow.getBounds();
      stageWindow.webContents.send('stage:pointer-input', {
        t: now,
        x: pos.x - stageBounds.x,
        y: pos.y - stageBounds.y,
        // Pick mode asks the target app's automation tree about a point, and
        // that tree speaks screen coordinates, not ours.
        screenX: pos.x,
        screenY: pos.y,
        buttons: Number(pointerInputState.buttons || 0),
      });
    }
    const temporarySurfaceVisible = hasVisibleTemporarySurface()
      || Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
    const currentButtons = Number(pointerInputState.buttons || 0);
    // Cursor flicker is a state machine oscillating, and we do not yet know
    // which state. This prints only on change, so a 20ms loop stays readable and
    // the transition that flips can be read straight out of electron.log.
    // Arm with MAGIC_POINTER_POINTER_TRACE=1; it is off by default and changes
    // nothing but the log.
    if (process.env.MAGIC_POINTER_POINTER_TRACE === '1') {
      const overlayVisible = Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
      const stageVisible = Boolean(stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible());
      const traceKey = [
        currentButtons,
        pointerInputState.swallowingLeft ? 1 : 0,
        pointerInputState.captureArmed ? 1 : 0,
        overlayVisible ? 1 : 0,
        overlayOwnsPointerInput ? 1 : 0,
        stageVisible ? 1 : 0,
        temporarySurfaceVisible ? 1 : 0,
      ].join('|');
      if (traceKey !== lastPointerTraceKey) {
        lastPointerTraceKey = traceKey;
        log(
          `pointer trace buttons=${currentButtons} swallowingLeft=${pointerInputState.swallowingLeft}`
          + ` captureArmed=${pointerInputState.captureArmed} overlayVisible=${overlayVisible}`
          + ` overlayOwnsPointer=${overlayOwnsPointerInput} stageVisible=${stageVisible}`
          + ` tempSurface=${temporarySurfaceVisible} app=${pointerInputState.foregroundApp || 'none'}`,
        );
      }
    }
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
    if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.isVisible()) return;
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
  // 暂停/恢复唤醒会停掉轮询再重启，期间 buttons 基线会过期——
  // 否则恢复后第一次右键（取消临时表面那条判定）会把很久之前的按键
  // 当成「上一帧」，错过一次本应触发的取消。
  temporarySurfaceButtons = Number(pointerInputState.buttons || 0);
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
    episodeActive: Boolean(interactionEpisodes.active()),
    mouseSideButton: fabricSettings?.activation?.mouse_side_button,
    onboardingRequired,
    inputPaused,
  });
}

function inputModeForReason(reason) {
  if (reason === 'shortcut-text') return 'text';
  if (reason === 'shortcut-voice') return 'voice';
  return fabricSettings?.interaction?.default_input_mode === 'voice' ? 'voice' : 'text';
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

// 目标窗口的几何和显示名：渲染层只能画，不能读/写（不给句柄/pid）。
// 目标窗口在**舞台窗口自己的坐标系**里是哪一块。
//
// 快照给的 bbox 是物理屏幕像素的 [left, top, right, bottom]；渲染层用的是舞台
// 窗口左上角为原点的 DIP。中间隔着两次换算（缩放、以及舞台落在哪个显示器上），
// 少做一次，在 200% 缩放的机器上框就会飞到屏幕外——所以这里走和选区矩形完全
// 同一对函数，不自己乘除。
function stageWindowRect(sourceWindow, stageBounds) {
  const raw = sourceWindow && Array.isArray(sourceWindow.bbox) && sourceWindow.bbox.length === 4
    ? sourceWindow.bbox
    : null;
  if (!raw || !stageBounds) return null;
  const values = raw.map((v) => Number(v));
  if (values.some((v) => !Number.isFinite(v))) return null;
  const [left, top, right, bottom] = values;
  if (right <= left || bottom <= top) return null;
  const dip = physicalRectToDip(screen, {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  });
  if (!dip) return null;
  return relativeRect(dip, stageBounds);
}

function stageAppLabel(snapshot) {
  const context = (snapshot && snapshot.context) || {};
  const window = (snapshot && snapshot.source_window) || {};
  const app = String(context.app || '');
  const title = String(window.title || context.window?.title || '');
  const bits = [app, title].filter(Boolean);
  return bits.length ? bits.join(' · ') : '';
}

function stageSessionPayload(entry) {
  const strokeCount = entry?.gesture && Array.isArray(entry.gesture.strokes) && entry.gesture.strokes.length > 0
    ? entry.gesture.strokes.length
    : 1;
  return {
    selectionSessionToken: entry.token,
    selectionSnapshotId: entry.snapshot?.snapshot_id || null,
    selectionCount: strokeCount,
    captureEligibility: entry.captureEligibility,
    defaultInputMode: inputModeForReason(entry.reason),
    voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit,
    voiceStartStrategy: fabricSettings.interaction.voice_start_strategy,
    groundingReady: Boolean(entry?.snapshot),
    // 选中内容有多少字——只有这个数字过去，内容本身不过去。渲染层需要它是因为
    // 拉伸手势量到的是屏幕上的折行，而引擎认的是字数；没有这个数，两边就得各自
    // 猜对方说的「行」是什么意思，而它们猜的从来不一样。
    selectionChars: String(entry?.snapshot?.context?.content || '').trim().length,
    // 目标窗口的矩形和名字。「要送出去」的那一路回答框贴在这个窗口右侧外沿，
    // 而不是挂在选区旁边——那样会压住你要参照的上文。
    //
    // 只给几何和一个显示用的名字。渲染层拿不到句柄、进程 id 或任何能用来瞄准
    // 一次读写的东西：它能画在哪儿，不等于它能读哪儿或写哪儿。
    targetWindowRect: stageWindowRect(
      entry?.snapshot?.source_window,
      (entry?.panelGeometry || panelGeometryForSession(entry))?.stageBounds,
    ),
    targetAppLabel: stageAppLabel(entry?.snapshot),
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
  const releasePoint = gesture?.anchorPoint || gesture?.releasePoint || liveCursor;
  // completeSelectionGesture emits physical pixels; the stage window and
  // display APIs work in DIPs, so convert once before anchoring. Using a
  // physical point as DIP on scaled displays pushed the capsule past the
  // viewport edge and clamped it into the bottom-right corner.  For
  // multi-stroke sessions the anchor is the FIRST stroke so the capsule
  // appears next to the first selection and never jumps while chaining.
  const releasePointDip = (gesture?.anchorPoint || gesture?.releasePoint)
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
    // Secure the physical screen before showing any stage surface. Otherwise
    // the voice capsule becomes part of the screenshot and UIA point probes
    // hit our overlay instead of the user's application.
    stageBounds = placeStageOnDisplay(display).getBounds();
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
      selectionCount: 1,
      pointer: {
        x: targetPoint.x - stageBounds.x,
        y: targetPoint.y - stageBounds.y,
      },
      target: null,
    });
    armTemporaryDismissShortcut();
  }
  log(`selection session capture start reason=${reason} token=${entry.token}`);
  // The clock starts at activation, not at the first bridge: what a person wants
  // to know is how long from gesture to answer.
  sessionTimeline.begin(entry.token, { reason: String(reason || '') });

  // Optimistic capsule. The bubble is a promise that we heard the gesture, and
  // that promise is worth nothing four seconds later. It opens with
  // groundingReady=false and is filled in when the snapshot lands.
  const revealCapsule = (via) => {
    if (!gesture) return;
    if (entry.capsuleRevealed) return;
    if (activeSelectionSessionToken !== entry.token) return;
    if (!selectionSessions.get(entry.token)) return;
    entry.capsuleRevealed = via;
    showStage({
      selectionSessionToken: entry.token,
      groundingReady: false,
      reason,
      selectionSource: selectionSourceForReason(reason),
      defaultInputMode: initialInputMode,
      voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit,
      voiceStartStrategy: fabricSettings.interaction.voice_start_strategy,
      targetGeometryKind: 'pointer_only',
      target: null,
      capsuleAnchor: 'pointer',
      capsuleDelayMs: 0,
      selectionCount: Array.isArray(gesture?.strokes) && gesture.strokes.length
        ? gesture.strokes.length
        : 1,
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
    log(`capsule revealed token=${entry.token} via=${via} grounded=false`);
  };
  if (gesture && CAPSULE_CONTENT_PROTECTED) revealCapsule('immediate');

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
      timelineToken: entry.token,
      onProgress: (record) => {
        // Without content protection this marker is the earliest safe reveal:
        // the pixels are captured and attested, so nothing we draw from here on
        // can contaminate them.
        if (record?.phase === CAPSULE_REVEAL_PHASE) revealCapsule(CAPSULE_REVEAL_PHASE);
      },
      onComplete: (parsed) => {
        if (activeSessionChildren.get(entry.token) === child) activeSessionChildren.delete(entry.token);
        const current = selectionSessions.get(entry.token);
        if (!current || activeSelectionSessionToken !== entry.token) return;
        // Once the capsule is open, every failure has to be spoken into it.
        // Returning silently would leave the user staring at a bubble that
        // never resolves — the one outcome worse than a slow bubble.
        const failOpenCapsule = (message) => {
          if (!entry.capsuleRevealed) return false;
          deliverStageError(entry.token, message);
          return true;
        };
        const attached = selectionSessions.attachSnapshot(entry.token, parsed);
        if (!attached) {
          failOpenCapsule(String(parsed?.error || '') === 'bridge_timeout'
            ? '这次读取超时了，请再选一次。'
            : '这次没能读到选中的内容，请再选一次。');
          return;
        }
        interactionEpisodes.bindPointedObject(episodeObjectForSession(attached));
        syncPointerEpisodeChord();
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
        if (!laidOut) {
          failOpenCapsule('这次选区没能定位好，请再选一次。');
          return;
        }
        log(`selection session capture done token=${entry.token} status=${attached.snapshot?.status || 'missing'} app=${attached.summary?.app || 'none'}`);
        const frozenTarget = stageTargetForSession(laidOut);
        const mode = current.reason === 'shortcut-text'
          ? 'text'
          : current.reason === 'shortcut-voice'
            ? 'voice'
            : (fabricSettings.interaction.default_input_mode === 'voice' ? 'voice' : 'text');
        if (gesture) {
          const groundedPayload = {
            ...stageSessionPayload(laidOut),
            groundingReady: true,
            reason: current.reason,
            selectionSource: selectionSourceForReason(current.reason),
            objectKind: inferObjectKind(attached.snapshot),
            targetGeometryKind: 'pointer_only',
            target: null,
            capsuleAnchor: 'pointer',
            capsuleDelayMs: 0,
            selectionCount: Array.isArray(gesture?.strokes) && gesture.strokes.length
              ? gesture.strokes.length
              : 1,
            pointer: {
              x: targetPoint.x - stageBounds.x,
              y: targetPoint.y - stageBounds.y,
            },
          };
          if (entry.capsuleRevealed) {
            // Backfill only. Replaying OPEN_CAPSULE here would re-anchor the
            // bubble and replay its entrance animation on a capsule the user is
            // already typing into — that is the "capsule jumps around" bug.
            // No eligibility gate: the gesture path never had one, and the
            // frozen snapshot stays valid no matter what the user switches to
            // afterwards.
            updateStage(groundedPayload);
            return;
          }
          showStage({
            ...groundedPayload,
            eventSequence: [
              { type: 'FREEZE', target: null },
              { type: 'OPEN_CAPSULE', mode },
            ],
          });
          armTemporaryDismissShortcut();
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
  startModelHealthWatch();
  setTimeout(warmUpOcrWorker, 2500);
  // 收藏箱要在应用就绪时就开始收，而不是等用户打开工作室。
  // 挂在 `stash:list` 上等于说「你不来看，我就不收」——而用户在微信里截图的
  // 那一刻，界面本来就不该开着。
  setTimeout(() => {
    try {
      initializeStashRuntime();
    } catch (error) {
      log(`stash runtime startup failed ${error.name}: ${error.message}`);
    }
  }, 1200);
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
    else if (dashboardWindow?.isVisible()) {
      dashboardWindow.hide();
      stopTitleBarSampling();
    }
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
  temporaryGestureSubmitShortcutRegistered = false;
  if (mousePollTimer) clearInterval(mousePollTimer);
  stopTitleBarSampling();
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
ipcMain.on('overlay:guide-finished', (event) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  // Guidance is disposable. Do not dismiss the answer stage, and do not hide
  // a window that has since been repurposed for an active selection gesture.
  if (selectionGestureArm || overlayOwnsPointerInput) return;
  hideOverlay();
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
  } else if (state === 'dismissing') {
    finishVoiceFocusGuard();
    const token = String(payload?.selectionSessionToken || '');
    if (token) invalidateSelectionSession(token);
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
  if (!options.allowWithoutSurface && !resultTargetWindow(target)) return;
  const py = PYTHON_EXECUTABLE;
  const defaultTimeoutMs = scriptPath.includes('selection_snapshot_bridge')
    ? 15_000
    // The stage bubble is on screen while selection_bridge runs, so it gets an
    // interactive deadline. Its model call is bounded well under this and
    // always has a grounded fallback; anything past this is a hang, and a hang
    // must fail visibly rather than spin for two minutes.
    //
    // 60s, not 30s: the Python side budgets 40s for one model attempt because
    // the configured gateway measured 20-33s for a one-line question on
    // 2026-08-04. A deadline under the budget it is supposed to contain would
    // kill working answers and report them as a hang — which is exactly what
    // the user saw as "连不上模型端点".
    : scriptPath.includes('selection_bridge')
      ? 60_000
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
    // Phase timings arrive on stderr while the bridge is still running. They
    // are what turns "it took 30 seconds" into "which step took 30 seconds",
    // and they are what lets the capsule appear before the work is finished.
    onProgress: (record) => {
      log(`bridge phase script=${scriptPath} phase=${record.phase} ms=${record.ms}`);
      if (options.timelineToken) {
        sessionTimeline.phase(options.timelineToken, {
          script: scriptPath,
          phase: record.phase,
          ms: record.ms,
          detail: record.detail || '',
        });
      }
      if (typeof options.onProgress === 'function') options.onProgress(record);
    },
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
      allowWithoutSurface: true,
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

// --- Model gateway health -------------------------------------------------
// Knowing the gateway is refusing (402 balance, 401 key) before a command runs
// is the difference between "this app is broken" and "your endpoint is out of
// credit". Python owns the verdict; this keeps a copy for the surfaces.
let modelHealth = {
  state: 'unknown',
  healthy: true,
  circuitOpen: false,
  message: '',
  errorCode: '',
  model: '',
  baseUrl: '',
  checkedAt: 0,
};
let modelHealthTimer = null;

function broadcastModelHealth() {
  const payload = { ...modelHealth };
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('dashboard:model-health', payload);
  }
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.webContents.send('stage:model-health', payload);
  }
}

async function refreshModelHealth({ probe = false } = {}) {
  try {
    const parsed = await runPythonBridgePromise(
      { operation: 'model.health', probe, timeoutS: 6 },
      'scripts/fabric_bridge.py',
      { target: 'fabric-dashboard', timeoutMs: probe ? 12000 : 6000 },
    );
    if (parsed?.health && typeof parsed.health === 'object') {
      modelHealth = { ...modelHealth, ...parsed.health };
      log(`model health state=${modelHealth.state} circuitOpen=${modelHealth.circuitOpen === true}`);
      broadcastModelHealth();
    }
  } catch (error) {
    // A failed health probe is not itself a gateway verdict; say unknown.
    log(`model health probe failed ${error.name}: ${error.message}`);
  }
  return modelHealth;
}

function startModelHealthWatch() {
  if (modelHealthTimer) return;
  setTimeout(() => { refreshModelHealth({ probe: true }); }, 1500);
  modelHealthTimer = setInterval(() => { refreshModelHealth({ probe: false }); }, 60_000);
  modelHealthTimer.unref?.();
}

ipcMain.handle('dashboard:session-timeline', async (event) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_dashboard_sender');
  return {
    ok: true,
    sessions: sessionTimeline.snapshot(),
  };
});

ipcMain.handle('dashboard:model-health-refresh', async (event) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_dashboard_sender');
  const health = await refreshModelHealth({ probe: true });
  return { ok: true, health };
});

// Loading the OCR models is seconds; serving a request is milliseconds. Paying
// that on the user's first command is the single largest avoidable chunk of
// perceived latency, so the worker warms up while the app is still settling.
let ocrWarmupStarted = false;

function warmUpOcrWorker() {
  if (ocrWarmupStarted) return;
  ocrWarmupStarted = true;
  const script = path.join(ROOT, 'scripts', 'ocr_resident_worker.py');
  if (!fs.existsSync(script)) return;
  try {
    const child = spawn(PYTHON_EXECUTABLE, [script], {
      cwd: ROOT,
      detached: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => log(`ocr warmup failed ${error.name}: ${error.message}`));
    child.unref?.();
    log('ocr worker warmup started');
  } catch (error) {
    log(`ocr warmup spawn failed ${error.name}`);
  }
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

// A stroke was committed but the user keeps circling (multi-stroke chain):
// keep the arm alive so the session does not expire between strokes.
ipcMain.on('overlay:gesture-stroke', (event, payload) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  const arm = selectionGestureArm;
  if (!arm || String(payload?.token || '') !== arm.token) return;
  const index = Number(payload?.index);
  armTemporaryGestureSubmitShortcut(arm.token);
  // Renderer owns the rolling inactivity timer. Keep the main-process lease
  // slightly longer so its legacy per-stroke timeout cannot cancel the chain
  // before the renderer's configurable auto-submit event arrives.
  markSelectionGestureDrawing(arm.token, {
    timeoutMs: arm.runtime.chainGapMs + 1000,
    reason: 'chain_timeout',
  });
  log(`selection gesture stroke committed token=${arm.token} index=${Number.isFinite(index) ? index : '?'}`);
});




// The capsule opens before grounding finishes, so a fast typist can press Enter
// while the snapshot is still being read. That submit waits for perception —
// bounded by whether the bridge is still working, not by a fixed deadline. A 6s
// deadline used to fire 0.8s before a 13.6s first-run read succeeded, telling
// the user their selection failed when it had not. See submit_gating_policy.ts.
const SUBMIT_GROUNDING_POLL_MS = 60;

ipcMain.on('stage:submit-selection-command', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  submitSelectionCommandWhenGrounded(payload, Date.now());
});

function submitSelectionCommandWhenGrounded(payload, startedAt, noticeShown = false) {
  const selectionSessionToken = payload?.selectionSessionToken;
  const session = selectionSessions.get(selectionSessionToken);
  const gate = decideSubmitGate({
    sessionAlive: Boolean(session),
    hasSnapshot: Boolean(session?.snapshot),
    captureInFlight: activeSessionChildren.has(selectionSessionToken),
    elapsedMs: Date.now() - startedAt,
  });
  if (gate.decision === SUBMIT_WAIT) {
    if (gate.notice && !noticeShown) {
      // Waiting silently and failing look the same from outside. Say which.
      updateStage({
        selectionSessionToken: selectionSessionToken || null,
        event: { type: 'NOTICE', notice: { message: gate.notice } },
      });
    }
    setTimeout(
      () => submitSelectionCommandWhenGrounded(payload, startedAt, noticeShown || Boolean(gate.notice)),
      SUBMIT_GROUNDING_POLL_MS,
    );
    return;
  }
  if (gate.decision === SUBMIT_FAIL) {
    log(`stage:submit-selection-command stopped reason=${gate.reason} elapsed_ms=${Date.now() - startedAt}`);
    deliverStageError(selectionSessionToken || null, gate.message);
    return;
  }
  if (!session) return;
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
  // A chip the user removed must actually leave the request. Dropping it only
  // from the display would make the chip a decoration that lies about what was
  // sent — the one thing worse than not having chips at all.
  const snapshotForRequest = withPickedElement(
    withKeptStrokes(session.snapshot, payload?.keptStrokeIndexes),
    payload?.pickedElement,
  );
  const enriched = {
    command: effectiveCommand,
    originalCommand: payload?.command,
    inputMode: payload?.inputMode || null,
    selectionSessionId: selectionSessionToken,
    selectionSnapshot: safeClone(snapshotForRequest),
    requestId,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || 1,
    source: 'pointer_stage',
    interactionEpisode,
    targetPoint: safeClone(session.snapshot?.target_point || null),
    targetPointSpace: session.snapshot?.target_point_space || null,
    // 'auto' lets the Python router decide. Hardcoding 'agent_prompt' here (as
    // d9f92b1 did) turned every bubble command into a codex handoff draft and
    // made the whole normal routing chain unreachable from the stage.
    requestMode: payload?.requestMode === 'agent_prompt' ? 'agent_prompt' : 'auto',
    workspaceRoot: ROOT,
  };
  // 用户问的那句话只在这一刻存在：stage 事件流里不带它。
  // 不在这里记下来，工作室永远只能显示答案、没有问题。
  pendingQuestions.set(selectionSessionToken, String(payload?.command || '').trim());
  log(`stage:submit-selection-command token=${selectionSessionToken} request=${requestId} command_len=${String(enriched.command || '').length}`);
  let child = null;
  child = runPythonBridge(enriched, 'scripts/selection_bridge.py', 'stage', {
    timelineToken: selectionSessionToken,
    // 桥在跑的时候就在报它走到哪一步了。这些阶段一直存在，只是从来没有送到
    // 界面上——于是用户看到的是一个跳动的秒数，跟一个卡死的进程分不出来。
    // 现在每一步都变成正在等的那张卡上的一行。
    onProgress: (record) => {
      if (!selectionSessions.isCurrentRequest(selectionSessionToken, requestId)) return;
      const step = CardModel.phaseStep(record);
      if (!step) return;
      safeSurfaceSend('stage', 'stage:card-patch', {
        selectionSessionToken,
        requestId,
        patch: { steps: [step] },
      });
    },
    onComplete: (parsed) => {
      if (activeSessionChildren.get(selectionSessionToken) === child) activeSessionChildren.delete(selectionSessionToken);
      if (!selectionSessions.isCurrentRequest(selectionSessionToken, requestId)) {
        log(`stage result ignored stale token=${selectionSessionToken} request=${requestId}`);
        return;
      }
      selectionSessions.finishRequest(selectionSessionToken, requestId);
      if (parsed?.kind === 'agent-prompt-draft' && parsed?.contextPacket) {
        const storedDraft = selectionSessions.setAgentPromptDraft(selectionSessionToken, {
          prompt: parsed.contextPrompt || parsed.answer,
          contextPacket: parsed.contextPacket,
          contextPacketArtifact: parsed.contextPacketArtifact,
          generatedBy: parsed.generatedBy,
        });
        delete parsed.contextPacket;
        if (!storedDraft) {
          deliverStageError(selectionSessionToken, 'Prompt 草稿未能绑定到当前选区，请重新选择。');
          return;
        }
      }
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
}

// Pick mode: the stage asks what element is under a point so it can outline the
// whole thing. Geometry only — no screenshot, no OCR, no content.
//
// TODO(perf): this spawns Python per pick (~1.2s, of which ~300ms is interpreter
// startup and the rest is the UIA probe process). That is tolerable on click and
// far too slow for hover. Make it resident the way the OCR worker is, then hover
// highlighting becomes possible. Recorded rather than fixed now: click-rate is
// the interaction the feature was asked for.
ipcMain.handle('stage:pick-element', async (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) {
    return { ok: false, error: 'unauthorized_stage_sender' };
  }
  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: 'invalid_point' };
  }
  const session = selectionSessions.get(String(payload?.selectionSessionToken || ''));
  const hwnd = Number(session?.snapshot?.source_window?.hwnd || 0);
  try {
    return await runPythonBridgePromise(
      { x: Math.round(x), y: Math.round(y), hwnd: Number.isFinite(hwnd) ? hwnd : 0 },
      'scripts/element_probe_bridge.py',
      { target: 'stage', timeoutMs: 3000 },
    );
  } catch (error) {
    log(`stage:pick-element failed ${error.name}: ${error.message}`);
    return { ok: false, error: 'element_probe_unavailable' };
  }
});

ipcMain.handle('stage:agent-sessions', async (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) {
    return { ok: false, error: 'unauthorized_stage_sender' };
  }
  const selectionSessionToken = String(payload?.selectionSessionToken || '');
  const draft = selectionSessions.getAgentPromptDraft(selectionSessionToken);
  if (!draft) return { ok: false, error: 'agent_prompt_draft_expired' };
  const packetWorkspace = draft.contextPacket?.workspace;
  const cwd = String(packetWorkspace?.cwd || ROOT);
  try {
    return await runPythonBridgePromise({
      operation: 'agent.sessions',
      cwd,
      cwdMatch: 'strict',
      includeMismatch: false,
      activeOnly: true,
      limit: 5,
    }, 'scripts/fabric_bridge.py', { target: 'stage', timeoutMs: 15000 });
  } catch (error) {
    return { ok: false, error: String(error?.message || 'agent_sessions_unavailable') };
  }
});

ipcMain.handle('stage:dispatch-agent-prompt', async (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) {
    return { ok: false, error: 'unauthorized_stage_sender' };
  }
  const selectionSessionToken = String(payload?.selectionSessionToken || '');
  const draft = selectionSessions.getAgentPromptDraft(selectionSessionToken);
  if (!draft) return { ok: false, error: 'agent_prompt_draft_expired' };
  try {
    const result = await runPythonBridgePromise({
      operation: 'agent.prompt.dispatch',
      contextPacket: draft.contextPacket,
      prompt: String(payload?.prompt || ''),
      provider: String(payload?.provider || ''),
      sessionId: String(payload?.sessionId || ''),
    }, 'scripts/fabric_bridge.py', { target: 'stage', timeoutMs: 30000 });
    if (result?.ok === true) selectionSessions.clearAgentPromptDraft(selectionSessionToken);
    return result;
  } catch (error) {
    return { ok: false, error: String(error?.message || 'agent_prompt_dispatch_failed') };
  }
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

// "填入" carries the answer the user is looking at back into the app they were
// working in. The renderer supplies only the text; the target window, pid, title
// and point come from the frozen selection session, so the write can never be
// aimed somewhere the user did not point. Python decides whether the write is
// possible and verifiable, and falls back to the clipboard when it is not.
ipcMain.on('stage:insert-result-text', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  const selectionSessionToken = payload?.selectionSessionToken || null;
  const session = selectionSessionToken ? selectionSessions.get(selectionSessionToken) : null;
  if (!session) {
    log('stage:insert-result-text rejected expired selection session');
    deliverStageError(selectionSessionToken, '当前 THIS 已过期，请重新激活 Magic Pointer。');
    return;
  }
  // 渲染层只送它正在显示的文字，但也得有个上限：preload 不截断这条路，
  // 一个失控/被攻破的渲染进程不能往桥里灌无界字符串。
  const text = String(payload?.text || '').slice(0, 200000);
  if (!text.trim()) {
    deliverStageError(selectionSessionToken, '没有可填入的文字。');
    return;
  }
  const snapshot = session.snapshot || {};
  log(`stage:insert-result-text token=${selectionSessionToken} chars=${text.length}`);
  runPythonBridge({
    text,
    // 主进程提供最后一个稳定外部窗口作为提示；渲染层不能指定写入目标。
    // 原生 writer 在同一个进程里按焦点、鼠标、稳定前台、实时前台、原目标解析。
    targetResolution: 'adaptive',
    currentTargetWindow: safeClone(lastStableForegroundWindow),
    targetWindow: safeClone(snapshot.source_window || {}),
    targetPoint: safeClone(snapshot.target_point || null),
    targetPointSpace: snapshot.target_point_space || null,
  }, 'scripts/deliver_text_bridge.py', 'stage', {
    onComplete: (parsed) => {
      if (!selectionSessions.get(selectionSessionToken)) {
        log('stage:insert-result-text result ignored expired selection session');
        return;
      }
      parsed.selectionSessionToken = selectionSessionToken;
      log(`stage:insert-result-text outcome=${parsed?.delivery?.reasonCode || parsed?.error || 'unknown'}`);
      sendBridgeResult('stage', parsed);
    },
  });
});

// 就地展开回答里的一段。
//
// 和上面那条写回不同，这条**不动任何外部世界**：不写别人的窗口、不碰剪贴板、
// 不产生动作提案。它把一段字送去变长，再把变长的字送回来，界面自己换掉那一段。
// 所以它是 invoke 不是 send——调用方要等一个返回值，而不是等一条新的舞台事件。
//
// 它也因此不开新的一轮：selectionSessions 的 request 计数不动，pendingQuestions
// 不动，conversation_store 不动。用户看到的是同一张卡上那一段字长长了。
ipcMain.handle('stage:expand-passage', async (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) {
    return { ok: false, error: '这个请求不是从舞台发来的。' };
  }
  const selectionSessionToken = payload?.selectionSessionToken || null;
  if (selectionSessionToken && !selectionSessions.get(selectionSessionToken)) {
    return { ok: false, error: '当前 THIS 已过期，请重新激活 Magic Pointer。' };
  }
  const passage = String(payload?.passage || '');
  if (!passage.trim()) return { ok: false, error: '没有选中任何文字。' };
  log(`stage:expand-passage token=${selectionSessionToken} chars=${passage.length}`);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = runPythonBridge({
      passage,
      context: String(payload?.context || ''),
    }, 'scripts/expand_passage_bridge.py', 'stage', {
      timeoutMs: 60_000,
      onComplete: (parsed) => {
        log(`stage:expand-passage outcome=${parsed?.ok === true ? 'ok' : (parsed?.error || 'unknown')}`);
        finish(parsed && typeof parsed === 'object'
          ? parsed
          : { ok: false, error: '展开没有返回内容。' });
      },
    });
    if (!child) finish({ ok: false, error: '舞台不在，没有展开。' });
    // 桥自己有超时会走 onComplete；这条只兜住「进程根本没起来也没报错」。
    setTimeout(() => finish({ ok: false, error: '展开超时，那一段保持原样。' }), 62_000);
  });
});

function isDashboardSender(event) {
  return Boolean(dashboardWindow && !dashboardWindow.isDestroyed() && event.sender === dashboardWindow.webContents);
}

function isCompanionSender(event) {
  return Boolean(companionWindow && !companionWindow.isDestroyed() && event.sender === companionWindow.webContents);
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

ipcMain.on('companion:hide', (event) => {
  if (!isCompanionSender(event)) return;
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.hide();
});
ipcMain.on('companion:pin', (event, payload) => {
  if (!isCompanionSender(event)) return;
  companionPinned = payload?.pinned !== false;
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.setAlwaysOnTop(companionPinned);
  }
});
ipcMain.on('companion:expand', (event) => {
  if (!isCompanionSender(event)) return;
  showPrimarySurface({ activate: true });
});

ipcMain.on('dashboard:hide', (event) => {
  if (!isDashboardSender(event)) return;
  dashboardWindow.hide();
  stopTitleBarSampling();
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
