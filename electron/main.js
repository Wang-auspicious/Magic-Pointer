const { app, BrowserWindow, globalShortcut, ipcMain, screen, safeStorage, systemPreferences } = require('electron');
const path = require('path');
const { nativeTheme } = require('electron');
const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { SelectionSessionStore } = require('./selection_session');
const { InteractionEpisodeStore, inferReferenceLabel, inferReferenceMode } = require('./interaction_episode');
const { ActivationGate } = require('./activation_gate');
const { WiggleDetector } = require('./wiggle_detector');
const { MouseActivationDetector } = require('./mouse_activation');
const { ElectronSettingsStore, defaultSettings } = require('./settings_store');
const { CredentialStore } = require('./credential_store');
const { PreflightRunner } = require('./bootstrap_runner');
const { buildPreflightChecks } = require('./preflight_checks');
const { captureEligibility } = require('./result_surface_policy');
const { inferObjectKind, selectionSourceForReason, stageEventFromBridge } = require('./stage_contract');
const { canAutoExecuteInternalProposal } = require('./internal_action_policy');
const { physicalScreenPoint } = require('./coordinate_space');
const { isSurfaceSender } = require('./ipc_surface_policy');
const { buildGoogleMapsDirectionsUrl, isAllowedGoogleMapsDirectionsUrl } = require('./route_policy');
const {
  chooseAnchorRect,
  normalizeNativeSelectionRectangles,
} = require('./panel_position');

let overlayWindow = null;
let dashboardWindow = null;
let stageWindow = null;
let mousePollTimer = null;
let overlayHideTimer = null;
let wiggleDetector = null;
const mouseActivationDetector = new MouseActivationDetector();
let fabricSettings = null;
let fabricSettingsStore = null;
let credentialStore = null;
let pointerStateChild = null;
let pointerInputState = { buttons: 0, foregroundApp: '', isWindowMoving: false, scrollDelta: 0 };
let wiggleCalibrationTimer = null;
let inputPaused = false;
let isQuitting = false;
const registeredConfigurableHotkeys = new Set();

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const FABRIC_DATA_DIR = path.resolve(process.env.MAGIC_POINTER_USER_DATA_DIR || RUNTIME_DIR);
const LOG_PATH = path.join(RUNTIME_DIR, 'electron.log');
const PID_PATH = path.join(RUNTIME_DIR, 'electron.pid');
const ACTION_PROPOSAL_TTL_MS = 2 * 60 * 1000;
const SELECTION_SESSION_TTL_MS = 2 * 60 * 1000;
const SHOW_STARTUP_OVERLAY = process.env.MAGIC_POINTER_SHOW_STARTUP === '1';
const ALLOWED_ACTION_TYPES = new Set([
  'copy_text_to_clipboard',
  'office_replace_selection',
  'office_undo_last_action',
  'shopping_list_add',
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
          isWindowMoving: parsed.isWindowMoving === true,
          scrollDelta: Number(parsed.scrollDelta || 0),
        };
      } catch (_) {}
    }
  });
  pointerStateChild.on('close', () => {
    pointerStateChild = null;
    pointerInputState = { buttons: 0, foregroundApp: '', isWindowMoving: false, scrollDelta: 0 };
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
    log('second-instance -> requestActivation');
    requestActivation('second-instance');
  });
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function createStageWindow() {
  if (stageWindow && !stageWindow.isDestroyed()) return stageWindow;
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;
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
    },
  });
  stageWindow.setAlwaysOnTop(true, 'screen-saver');
  stageWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  stageWindow.loadFile(path.join(__dirname, 'renderer', 'stage.html'));
  stageWindow.setIgnoreMouseEvents(true, { forward: true });
  stageWindow.on('closed', () => { stageWindow = null; });
  return stageWindow;
}

function showStage(payload = {}) {
  const win = createStageWindow();
  const send = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('stage:show', payload);
    if (!win.isVisible()) win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
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
function setStageMouseCapture(enabled) {
  if (!stageWindow || stageWindow.isDestroyed()) return;
  if (enabled) {
    stageWindow.setIgnoreMouseEvents(false);
    stageWindow.focus();
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
    },
  });
  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));
  dashboardWindow.on('close', (event) => {
    if (!isQuitting && fabricSettings?.general?.keep_running !== false) {
      event.preventDefault();
      dashboardWindow.hide();
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
    log(`showDashboard highlight=${payload.highlightItemId || 'none'}`);
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function panelGeometryForSession(entry) {
  const context = entry?.snapshot?.context || {};
  const artifacts = context.artifacts || {};
  const rawRectangles = artifacts.selection_rectangles;
  const coordinateSpace = String(
    artifacts.selection_rectangles_coordinate_space
    || (context.adapter === 'uia_text_selection' ? 'physical_screen_pixels' : 'electron_dip'),
  );
  const shouldConvertPhysicalPixels = (
    coordinateSpace === 'physical_screen_pixels'
    && process.platform === 'win32'
    && typeof screen.screenToDipRect === 'function'
  );
  const selectionRects = normalizeNativeSelectionRectangles(rawRectangles, (rect) => {
    if (!shouldConvertPhysicalPixels) return rect;
    return screen.screenToDipRect(null, {
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
    });
  });
  return {
    coordinateSpace: 'electron_dip',
    sourceCoordinateSpace: coordinateSpace,
    anchorCursor: entry?.cursor || screen.getCursorScreenPoint(),
    selectionRects,
  };
}

function displayForPanelGeometry(geometry) {
  const cursor = geometry?.anchorCursor || screen.getCursorScreenPoint();
  const anchorRect = chooseAnchorRect(geometry?.selectionRects || [], cursor);
  if (anchorRect && typeof screen.getDisplayMatching === 'function') {
    return screen.getDisplayMatching({
      x: Math.round(anchorRect.x),
      y: Math.round(anchorRect.y),
      width: Math.max(1, Math.round(anchorRect.width)),
      height: Math.max(1, Math.round(anchorRect.height)),
    });
  }
  return screen.getDisplayNearestPoint(cursor);
}

// Selection anchor projected into stage-window coordinates (the stage covers
// the primary display; UIA rectangles arrive in physical pixels and are DIP-
// normalized by panelGeometryForSession).
function stageTargetForSession(entry) {
  const geometry = entry?.panelGeometry || panelGeometryForSession(entry);
  const win = createStageWindow();
  const bounds = win.getBounds();
  const anchor = chooseAnchorRect(geometry.selectionRects || [], geometry.anchorCursor);
  if (anchor) {
    return {
      x: Math.round(anchor.x - bounds.x),
      y: Math.round(anchor.y - bounds.y),
      width: Math.max(0, Math.round(anchor.width)),
      height: Math.max(0, Math.round(anchor.height)),
    };
  }
  const cursor = geometry.anchorCursor || screen.getCursorScreenPoint();
  return {
    x: Math.round(cursor.x - bounds.x - 8),
    y: Math.round(cursor.y - bounds.y - 8),
    width: 16,
    height: 16,
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
  stopDictation('stage');
  setStageMouseCapture(false);
  if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
    // Ask the stage to play its dismiss fade; it answers with stage:hidden.
    stageWindow.webContents.send('stage:hide');
  }
  if (invalidateSession) invalidateSelectionSession(sessionToken);
  lastStageResult = null;
  if (hideObserver) hideOverlay();
  log('dismissTemporarySurfaces');
}

function requestActivation(reason) {
  if (inputPaused) {
    log(`activation ignored paused reason=${reason}`);
    return 'paused';
  }
  const decision = activationGate.decide({
    hasVisibleSurface: hasVisibleTemporarySurface() || Boolean(overlayWindow?.isVisible()),
    isActivationBusy: hasActiveSelectionCapture(),
  });
  log(`activation request reason=${reason} decision=${decision}`);
  if (decision === 'dismiss') {
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  } else if (decision === 'activate') {
    beginSelectionSession(reason);
  }
  return decision;
}

function stopDictation(surface) {
  const child = dictationChildren.get(surface);
  if (!child) return;
  dictationChildren.delete(surface);
  try { if (!child.killed) child.kill(); } catch (_) {}
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
  overlayWindow.setBounds(display.bounds);
  overlayWindow.setIgnoreMouseEvents(false);
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
  log('hideOverlay');
}

function startMouseShakePolling() {
  if (mousePollTimer) return;
  if (!wiggleDetector) return;
  mousePollTimer = setInterval(() => {
    const now = Date.now();
    const pos = screen.getCursorScreenPoint();
    if (overlayWindow && overlayWindow.isVisible()) sendCursorToOverlay(pos);
    const mouseButtonMode = fabricSettings?.activation?.wake_mode === 'mouse_button'
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
    if (fabricSettings?.activation?.wake_mode === 'mouse_button') return;
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
    if (decision.triggered) {
      log(`wiggle accepted metrics=${JSON.stringify(decision.metrics)}`);
      requestActivation('wiggle');
    }
  }, 35);
  log('wiggle polling started');
}

function stopMouseShakePolling() {
  if (mousePollTimer) clearInterval(mousePollTimer);
  mousePollTimer = null;
  try { if (pointerStateChild && !pointerStateChild.killed) pointerStateChild.kill(); } catch (_) {}
  pointerStateChild = null;
}

function applyConfiguredWakeState() {
  const wiggleEnv = process.env.MAGIC_POINTER_ENABLE_MOUSE_SHAKE;
  const wiggleConfigured = ['wiggle', 'wiggle_hotkey'].includes(fabricSettings?.activation?.wake_mode)
    && fabricSettings?.activation?.wiggle_enabled !== false;
  const configured = wiggleConfigured || fabricSettings?.activation?.wake_mode === 'mouse_button';
  const enabled = !inputPaused && (wiggleEnv === '1' ? true : wiggleEnv === '0' ? false : configured);
  mouseActivationDetector.reset(pointerInputState.buttons);
  if (enabled) {
    startPointerInputStateStream();
    startMouseShakePolling();
  } else {
    stopMouseShakePolling();
  }
  log(`pointer activation polling=${enabled} wakeMode=${fabricSettings?.activation?.wake_mode} paused=${inputPaused} sensitivity=${fabricSettings?.activation?.sensitivity}`);
  return enabled;
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
  if (mode === 'here') interactionEpisodes.bindHere(object);
  else {
    interactionEpisodes.bindPointedObject(object);
    if (referenceLabel) interactionEpisodes.labelCurrent(referenceLabel);
    if (mode === 'these' || referenceLabel) interactionEpisodes.bindThese();
  }
  const episode = interactionEpisodes.contextPayload();
  persistCurrentObjectEpisode(session);
  log(`interaction episode bind mode=${mode} episode=${episode?.episodeId || 'none'} session=${session?.token || 'none'}`);
  return episode;
}

function beginSelectionSession(reason = 'manual') {
  if (activeSelectionSessionToken) invalidateSelectionSession(activeSelectionSessionToken);
  lastStageResult = null;

  const cursor = screen.getCursorScreenPoint();
  const physicalCursor = physicalScreenPoint(screen, cursor);
  const display = screen.getDisplayNearestPoint(cursor);
  const entry = selectionSessions.create({ reason, cursor });
  activeSelectionSessionToken = entry.token;
  showOverlay(`${reason}-capturing`, 0);
  // The stage is the single ephemeral surface: it wakes in targeting mode at
  // the cursor and freezes onto the captured selection once the snapshot lands.
  const stageBounds = createStageWindow().getBounds();
  showStage({
    reason,
    selectionSessionToken: entry.token,
    selectionSource: selectionSourceForReason(reason),
    defaultInputMode: inputModeForReason(reason),
    voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit,
    pointer: {
      x: cursor.x - stageBounds.x,
      y: cursor.y - stageBounds.y,
    },
    target: {
      x: cursor.x - stageBounds.x - 8,
      y: cursor.y - stageBounds.y - 8,
      width: 16,
      height: 16,
    },
  });
  log(`selection session capture start reason=${reason} token=${entry.token}`);

  let child = null;
  child = runPythonBridge(
    {
      mode: 'capture_selection_snapshot',
      reason,
      cursor: physicalCursor,
      cursorSpace: physicalCursor ? 'physical_screen_pixels' : null,
      screenBounds: display.bounds,
      scaleFactor: display.scaleFactor || 1,
      foregroundApp: pointerInputState.foregroundApp,
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
        updateStage({
          ...stageSessionPayload(laidOut),
          selectionSource: selectionSourceForReason(current.reason),
          objectKind: inferObjectKind(attached.snapshot),
          event: { type: 'FREEZE', target: stageTargetForSession(laidOut) },
        });
        if (!attached.captureEligibility?.commandReady) {
          // Honest failure: the capsule never opens over an unusable selection.
          deliverStageError(entry.token, attached.captureEligibility?.message || '当前选区不可用，请重新选择。');
          return;
        }
        const mode = current.reason === 'shortcut-text'
          ? 'text'
          : current.reason === 'shortcut-voice'
            ? 'voice'
            : (fabricSettings.interaction.default_input_mode === 'text' ? 'text' : 'voice');
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
  fabricSettingsStore = new ElectronSettingsStore(path.join(FABRIC_DATA_DIR, 'fabric-settings.json'));
  credentialStore = new CredentialStore(path.join(FABRIC_DATA_DIR, 'credentials.v1.json'), safeStorage);
  try {
    fabricSettings = fabricSettingsStore.load();
  } catch (error) {
    fabricSettings = defaultSettings();
    log(`settings load failed closed ${error.name}: ${error.message}`);
  }
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
  createOverlayWindow();
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
    if (dashboardWindow?.isVisible()) dashboardWindow.hide();
    else showDashboard({}, { activate: true });
  });
  log(`register hotkey Control+Alt+D dashboard ok=${dashboardHotkeyOk}`);
  applyConfiguredWakeState();
  if (SHOW_STARTUP_OVERLAY) setTimeout(() => showOverlay('startup', 1400), 650);
  const dashboardCapturePath = String(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE || '').trim();
  if (dashboardCapturePath) {
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
    showDashboard({ view: captureView }, { activate: false });
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
  if (mousePollTimer) clearInterval(mousePollTimer);
  if (wiggleCalibrationTimer) clearTimeout(wiggleCalibrationTimer);
  try { if (pointerStateChild && !pointerStateChild.killed) pointerStateChild.kill(); } catch (_) {}
  pointerStateChild = null;
  for (const child of dictationChildren.values()) {
    try { if (child && !child.killed) child.kill(); } catch (_) {}
  }
  dictationChildren.clear();
  try { stageWindow?.close(); } catch (_) {}
  try { dashboardWindow?.close(); } catch (_) {}
  log('app will quit');
});
app.on('before-quit', () => { isQuitting = true; });

ipcMain.on('overlay:hide', (event) => {
  if (isSurfaceSender(event, 'overlay', resultTargetWindow)) hideOverlay();
});
ipcMain.on('stage:show', (event) => {
  // Renderer re-asserts visibility once it has content to paint.
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  if (stageWindow && !stageWindow.isDestroyed() && !stageWindow.isVisible()) stageWindow.showInactive();
});
ipcMain.on('stage:state', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  log(`stage renderer state=${String(payload?.state || 'unknown')}`);
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
  setStageMouseCapture(payload?.enabled === true);
});
ipcMain.on('dictation:stop', (event, payload) => {
  const surface = payload?.surface === 'overlay' ? 'overlay' : payload?.surface === 'stage' ? 'stage' : null;
  if (!surface || !isSurfaceSender(event, surface, resultTargetWindow)) return;
  stopDictation(surface);
});
ipcMain.on('dictation:start', (event, payload) => {
  const surface = payload?.surface === 'overlay' ? 'overlay' : payload?.surface === 'stage' ? 'stage' : null;
  if (!surface || !isSurfaceSender(event, surface, resultTargetWindow)) {
    log('dictation:start rejected untrusted sender or surface');
    return;
  }
  if (dictationChildren.has(surface)) {
    safeSurfaceSend(surface, 'dictation:result', { ok: true, surface, status: 'already_starting', error: null });
    return;
  }
  const scriptPath = path.join(ROOT, 'scripts', 'local_voice_bridge.py');
  const pythonExecutable = process.env.MAGIC_POINTER_PYTHON || 'python';
  const silenceMs = Math.max(
    600,
    Math.min(5000, Number(fabricSettings?.interaction?.voice_silence_ms) || 1600),
  );
  const voiceArgs = [
    '-u',
    scriptPath,
    '--model',
    process.env.MAGIC_POINTER_WHISPER_MODEL || 'tiny',
    '--silence-ms',
    String(silenceMs),
  ];
  if (process.env.MAGIC_POINTER_VOICE_INPUT_WAV) {
    voiceArgs.push('--input-wav', path.resolve(process.env.MAGIC_POINTER_VOICE_INPUT_WAV));
  }
  const voiceSession = activeSelectionSessionToken
    ? selectionSessions.get(activeSelectionSessionToken)
    : null;
  const voiceSnapshot = voiceSession?.snapshot || {};
  const voiceContext = voiceSnapshot.context || {};
  const voiceContextPath = String(
    voiceContext.document_path
    || voiceContext.path
    || voiceSnapshot.capture_path
    || '',
  );
  const child = spawn(pythonExecutable, voiceArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      MAGIC_POINTER_VOICE_SETTINGS_FILE: fabricSettingsStore?.path || '',
      MAGIC_POINTER_VOICE_CONTEXT_PATH: voiceContextPath,
    },
  });
  dictationChildren.set(surface, child);
  let stdout = '';
  let stderr = '';
  let terminalEventSeen = false;
  const forwardEvent = (eventPayload = {}) => {
    if (dictationChildren.get(surface) !== child) return;
    if (eventPayload.type === 'partial' || eventPayload.type === 'final') {
      if (eventPayload.type === 'final') terminalEventSeen = true;
      safeSurfaceSend(surface, 'dictation:result', {
        ok: true,
        surface,
        transcript: String(eventPayload.transcript || ''),
        final: eventPayload.type === 'final',
        engine: eventPayload.engine || 'whisper-local',
      });
    } else if (eventPayload.type === 'error') {
      terminalEventSeen = true;
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
    if (dictationChildren.get(surface) === child) dictationChildren.delete(surface);
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
    if (dictationChildren.get(surface) === child) dictationChildren.delete(surface);
    if (!terminalEventSeen && code !== 0) {
      safeSurfaceSend(surface, 'dictation:result', {
        ok: false,
        surface,
        error: `本地语音识别失败：${stderr.trim().slice(0, 500) || `exit ${code}`}`,
      });
    }
    log(`local dictation closed surface=${surface} code=${code}`);
  });
});
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
  const py = process.env.MAGIC_POINTER_PYTHON || 'python';
  const child = spawn(py, [scriptPath], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      MAGIC_POINTER_USER_DATA_DIR: FABRIC_DATA_DIR,
    },
  });

  let stdout = '';
  let stderr = '';
  let delivered = false;
  const deliver = (parsed) => {
    if (delivered) return;
    delivered = true;
    if (typeof options.onComplete === 'function') {
      options.onComplete(parsed);
      return;
    }
    registerActionProposals(parsed, options.selectionSessionToken || null, target);
    sendBridgeResult(target, parsed);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => {
    log(`bridge spawn error ${error.name}: ${error.message}`);
    deliver({
      ok: false,
      error: `${error.name}: ${error.message}`,
    });
  });
  child.on('close', (code) => {
    let parsed = null;
    try {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      parsed = JSON.parse(lines[lines.length - 1] || '{}');
    } catch (error) {
      parsed = { ok: false, error: `Could not parse bridge output: ${error.message}`, raw: stdout };
    }
    if (code !== 0 && parsed && parsed.ok !== true) {
      parsed.code = code;
      parsed.stderr = stderr.slice(0, 2000);
    }
    log(`bridge close script=${scriptPath} code=${code} ok=${parsed?.ok}`);
    deliver(parsed);
  });

  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  return child;
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

function runPreflight(payload = {}) {
  const manifestPath = path.join(ROOT, 'data', 'preflight_manifest.v1.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const runner = new PreflightRunner({
    manifest,
    markerPath: path.join(FABRIC_DATA_DIR, 'onboarding.json'),
    checks: buildPreflightChecks({
      root: FABRIC_DATA_DIR,
      projectRoot: ROOT,
      settings: fabricSettings || defaultSettings(),
      credentialStore,
      wiggleDetector,
      microphoneStatus: microphonePermissionStatus,
    }),
  });
  const stageIds = Array.isArray(payload.stageIds) ? payload.stageIds : null;
  const userSkips = Array.isArray(payload.userSkips) ? payload.userSkips : [];
  return runner.run({ stageIds, userSkips });
}

ipcMain.on('overlay:done', (event, payload) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const enriched = {
    ...payload,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || payload?.viewport?.dpr || 1,
    capturePad: 54,
  };
  log(`overlay:done action=${enriched.action || 'capture'} points=${enriched.points?.length || 0} scale=${enriched.scaleFactor} bounds=${display.bounds.x},${display.bounds.y},${display.bounds.width},${display.bounds.height}`);
  // Runtime-issue capture results render on the stage (the overlay no longer
  // hosts result surfaces).
  createStageWindow();
  runPythonBridge(enriched, 'scripts/electron_bridge.py', 'stage', {
    onComplete: (parsed) => {
      hideOverlay();
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

  cancelSessionChild(selectionSessionToken);
  const requestId = selectionSessions.startRequest(selectionSessionToken);
  if (!requestId) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const interactionEpisode = bindEpisodeForCommand(session, payload?.command);
  const enriched = {
    command: payload?.command,
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
            const highlightItemId = output?.verified === true ? output?.item?.id : null;
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
    try {
      const preflight = runPreflight(payload);
      sendBridgeResult('fabric-dashboard', {
        ok: true,
        state: preflight.ready ? 'completed' : 'blocked',
        fabricOperation: operation,
        preflight,
      });
    } catch (error) {
      sendBridgeResult('fabric-dashboard', {
        ok: false,
        state: 'failed',
        fabricOperation: operation,
        error: `preflight_failed:${error.name}`,
      });
    }
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
