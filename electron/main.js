const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { SelectionSessionStore } = require('./selection_session');
const { InteractionEpisodeStore, inferReferenceMode } = require('./interaction_episode');
const { ActivationGate } = require('./activation_gate');
const { WiggleDetector } = require('./wiggle_detector');
const { ElectronSettingsStore, defaultSettings } = require('./settings_store');
const { captureEligibility, classifyResult, normalizeResultPreference } = require('./result_surface_policy');
const { canAutoExecuteInternalProposal } = require('./internal_action_policy');
const { physicalScreenPoint } = require('./coordinate_space');
const { isSurfaceSender } = require('./ipc_surface_policy');
const { buildGoogleMapsDirectionsUrl, isAllowedGoogleMapsDirectionsUrl } = require('./route_policy');
const {
  chooseAnchorRect,
  computeInlineRailWidth,
  computePanelPlacement,
  normalizeNativeSelectionRectangles,
} = require('./panel_position');

let overlayWindow = null;
let panelWindow = null;
let resultWindow = null;
let readerWindow = null;
let dashboardWindow = null;
let stageWindow = null;
let mousePollTimer = null;
let overlayHideTimer = null;
let wiggleDetector = null;
let fabricSettings = null;
let fabricSettingsStore = null;
let pointerStateChild = null;
let pointerInputState = { buttons: 0, foregroundApp: '', isWindowMoving: false, scrollDelta: 0 };
let wiggleCalibrationTimer = null;

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const FABRIC_DATA_DIR = path.resolve(process.env.MAGIC_POINTER_USER_DATA_DIR || RUNTIME_DIR);
const LOG_PATH = path.join(RUNTIME_DIR, 'electron.log');
const PID_PATH = path.join(RUNTIME_DIR, 'electron.pid');
const ACTION_PROPOSAL_TTL_MS = 2 * 60 * 1000;
const SELECTION_SESSION_TTL_MS = 2 * 60 * 1000;
const PANEL_RAIL_HEIGHT = 72;
const PANEL_RAIL_MIN_WIDTH = 72;
const PANEL_RAIL_MAX_WIDTH = 560;
const PANEL_MAX_HEIGHT = 380;
const RESULT_SURFACE_MODE = normalizeResultPreference(process.env.MAGIC_POINTER_RESULT_MODE);
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
let currentResultPayload = null;
let currentResultSessionToken = null;
let resultHasFocused = false;
let resultShownAt = 0;
let resultFarSince = 0;
let readerPinned = false;
let readerHasFocused = false;
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
    objects: episode.objects.map((item) => ({
      id: item.objectId,
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
    log('second-instance -> beginSelectionSession');
    beginSelectionSession('second-instance');
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

function createPanelWindow() {
  if (panelWindow) return panelWindow;
  panelWindow = new BrowserWindow({
    width: PANEL_RAIL_MIN_WIDTH,
    height: PANEL_RAIL_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: false,
    resizable: false,
    movable: true,
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
  panelWindow.setAlwaysOnTop(true, 'screen-saver');
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.loadFile(path.join(__dirname, 'renderer', 'panel.html'));
  panelWindow.on('closed', () => { panelWindow = null; });
  return panelWindow;
}

function createResultWindow() {
  if (resultWindow && !resultWindow.isDestroyed()) return resultWindow;
  resultWindow = new BrowserWindow({
    width: 360,
    height: 160,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: false,
    resizable: false,
    movable: true,
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
  resultWindow.setAlwaysOnTop(true, 'floating');
  resultWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  resultWindow.loadFile(path.join(__dirname, 'renderer', 'result.html'));
  resultWindow.on('focus', () => { resultHasFocused = true; });
  resultWindow.on('blur', () => {
    setTimeout(() => {
      if (resultHasFocused && resultWindow?.isVisible() && !readerWindow?.isVisible()) {
        dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      }
    }, 0);
  });
  resultWindow.on('closed', () => { resultWindow = null; });
  return resultWindow;
}

function createReaderWindow() {
  if (readerWindow && !readerWindow.isDestroyed()) return readerWindow;
  readerWindow = new BrowserWindow({
    width: 420,
    height: 520,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: false,
    resizable: true,
    movable: true,
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
  readerWindow.setAlwaysOnTop(true, 'floating');
  readerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  readerWindow.loadFile(path.join(__dirname, 'renderer', 'reader.html'));
  readerWindow.on('focus', () => { readerHasFocused = true; });
  readerWindow.on('blur', () => {
    setTimeout(() => {
      if (readerHasFocused && !readerPinned && readerWindow?.isVisible()) {
        dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      }
    }, 0);
  });
  readerWindow.on('closed', () => { readerWindow = null; });
  return readerWindow;
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;
  dashboardWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 620,
    frame: false,
    transparent: false,
    backgroundColor: '#f7f8fb',
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
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
  return dashboardWindow;
}

function showDashboard(payload = {}, options = {}) {
  const win = createDashboardWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea || display.bounds;
  const width = Math.min(1120, Math.max(860, workArea.width - 48));
  const height = Math.min(720, Math.max(620, workArea.height - 48));
  const bounds = {
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + Math.max(24, Math.floor((workArea.height - height) / 2)),
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

function showReader(payload = {}) {
  const win = createReaderWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea || display.bounds;
  const width = Math.min(420, Math.max(320, workArea.width - 32));
  const maxHeight = Math.max(240, Math.floor(workArea.height * 0.72));
  const answerLength = String(payload?.answer || payload?.error || '').length;
  const proposalCount = Array.isArray(payload?.actionProposals) ? payload.actionProposals.length : 0;
  const estimatedHeight = 190 + Math.min(260, Math.ceil(answerLength / 48) * 22) + Math.min(160, proposalCount * 96);
  const height = Math.min(maxHeight, Math.max(240, estimatedHeight));
  const bounds = {
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    width,
    height,
  };
  const reveal = () => {
    if (!readerWindow || readerWindow.isDestroyed()) return;
    readerWindow.setBounds(bounds);
    readerPinned = false;
    readerHasFocused = false;
    readerWindow.showInactive();
    readerWindow.webContents.send('reader:show', payload);
    log(`showReader token=${payload?.selectionSessionToken || 'none'}`);
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

function positionPanelForSession(entry, size = {}) {
  if (!panelWindow || panelWindow.isDestroyed()) return null;
  const geometry = entry?.panelGeometry || panelGeometryForSession(entry);
  const display = displayForPanelGeometry(geometry);
  const workArea = display.workArea || display.bounds;
  const current = panelWindow.getBounds();
  const requestedHeight = Math.round(Number(size?.height) || PANEL_RAIL_HEIGHT);
  const desiredHeight = Math.max(
    PANEL_RAIL_HEIGHT,
    Math.min(PANEL_MAX_HEIGHT, requestedHeight),
  );
  const maxWidth = desiredHeight === PANEL_RAIL_HEIGHT ? PANEL_RAIL_MAX_WIDTH : 420;
  const desiredWidth = Math.max(
    PANEL_RAIL_MIN_WIDTH,
    Math.min(maxWidth, Math.round(Number(size?.width) || current.width || PANEL_RAIL_MIN_WIDTH)),
  );
  const placement = computePanelPlacement({
    workArea,
    panelSize: { width: desiredWidth, height: desiredHeight },
    cursor: geometry.anchorCursor,
    selectionRects: geometry.selectionRects,
    preferredMode: entry?.panelPlacement?.mode || null,
  });
  panelWindow.setBounds(placement.bounds);
  if (entry?.token) selectionSessions.setPanelPlacement(entry.token, placement);
  log(
    `panel positioned token=${entry?.token || 'none'} mode=${placement.mode}`
    + ` rects=${geometry.selectionRects.length} overlap=${Math.round(placement.overlapArea)}`
    + ` bounds=${placement.bounds.x},${placement.bounds.y},${placement.bounds.width},${placement.bounds.height}`,
  );
  return placement;
}

function resizePanel(payload = {}) {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const selectionSessionToken = payload?.selectionSessionToken;
  const entry = selectionSessions.get(selectionSessionToken);
  if (
    !entry
    || selectionSessionToken !== activeSelectionSessionToken
    || payload?.layoutNonce !== entry.panelLayoutNonce
  ) {
    log(`panel resize ignored stale token=${selectionSessionToken || 'none'}`);
    return;
  }
  positionPanelForSession(entry, { width: payload?.width, height: payload?.height });
}

function positionResultForSession(entry, size = {}) {
  if (!resultWindow || resultWindow.isDestroyed()) return null;
  const geometry = entry?.panelGeometry || panelGeometryForSession(entry);
  const display = displayForPanelGeometry(geometry);
  const workArea = display.workArea || display.bounds;
  const width = Math.max(280, Math.min(440, Math.round(Number(size.width) || 360)));
  const height = Math.max(92, Math.min(360, Math.round(Number(size.height) || 160)));
  const placement = computePanelPlacement({
    workArea,
    panelSize: { width, height },
    cursor: geometry.anchorCursor,
    selectionRects: geometry.selectionRects,
  });
  resultWindow.setBounds(placement.bounds);
  log(`result positioned token=${entry?.token || 'none'} mode=${placement.mode} bounds=${placement.bounds.x},${placement.bounds.y},${width},${height}`);
  return placement;
}

function hidePanelWindowOnly() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  stopDictation('panel');
  panelWindow.webContents.send('panel:hide');
  panelWindow.hide();
}

function showContextualResult(payload = {}) {
  const selectionSessionToken = payload?.selectionSessionToken || null;
  const entry = selectionSessions.get(selectionSessionToken);
  if (!entry || selectionSessionToken !== activeSelectionSessionToken) {
    log('showContextualResult rejected stale session');
    return;
  }
  const resultMode = classifyResult(payload, RESULT_SURFACE_MODE);
  const enriched = { ...payload, resultMode };
  if (resultMode === 'reader') {
    hidePanelWindowOnly();
    showReader(enriched);
    return;
  }
  currentResultPayload = safeClone(enriched);
  currentResultSessionToken = selectionSessionToken;
  resultHasFocused = false;
  resultFarSince = 0;
  readerPinned = false;
  readerHasFocused = false;
  hidePanelWindowOnly();
  const win = createResultWindow();
  const deliver = () => {
    if (!resultWindow || resultWindow.isDestroyed()) return;
    positionResultForSession(entry, { width: 360, height: 160 });
    resultWindow.webContents.send('result:show', enriched);
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', deliver);
  else deliver();
}

function showPanel(reason = 'manual', payload = {}, { focusInput = true, sessionEntry = null } = {}) {
  const win = createPanelWindow();
  const reveal = () => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    const currentEntry = sessionEntry?.token ? selectionSessions.get(sessionEntry.token) : null;
    if (sessionEntry?.token && (!currentEntry || currentEntry.token !== activeSelectionSessionToken)) return;
    positionPanelForSession(currentEntry || sessionEntry, {
      width: payload.defaultInputMode === 'voice' ? PANEL_RAIL_MIN_WIDTH : 176,
      height: PANEL_RAIL_HEIGHT,
    });
    if (focusInput) {
      win.show();
      win.focus();
    } else {
      win.showInactive();
    }
    win.webContents.send('panel:show', { reason, focusInput, ...payload });
    log(`showPanel reason=${reason} focus=${focusInput}`);
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function hasVisibleTemporarySurface() {
  return Boolean(
    (panelWindow && panelWindow.isVisible())
    || (resultWindow && resultWindow.isVisible())
    || (readerWindow && readerWindow.isVisible())
  );
}

function hasActiveSelectionCapture() {
  if (!activeSelectionSessionToken) return false;
  return selectionSessions.get(activeSelectionSessionToken)?.state === 'capturing';
}

function dismissTemporarySurfaces({ invalidateSession = true, hideObserver = false } = {}) {
  const sessionToken = activeSelectionSessionToken;
  if (readerWindow && !readerWindow.isDestroyed()) {
    readerWindow.webContents.send('reader:hide');
    readerWindow.hide();
  }
  if (resultWindow && !resultWindow.isDestroyed()) {
    resultWindow.webContents.send('result:hide');
    resultWindow.hide();
  }
  if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
    // Ask the stage to play its dismiss fade; it answers with stage:hide.
    stageWindow.webContents.send('stage:hide');
  }
  hidePanelWindowOnly();
  if (invalidateSession) invalidateSelectionSession(sessionToken);
  currentResultPayload = null;
  currentResultSessionToken = null;
  resultHasFocused = false;
  resultShownAt = 0;
  resultFarSince = 0;
  readerPinned = false;
  readerHasFocused = false;
  if (hideObserver) hideOverlay();
  log('dismissTemporarySurfaces');
}

function hidePanel({ hideObserver = false } = {}) {
  dismissTemporarySurfaces({ invalidateSession: true, hideObserver });
  log('hidePanel');
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

function distanceFromPointToRect(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function maybeDismissResultForCursor(pos, now) {
  if (!resultWindow?.isVisible() || now - resultShownAt < 500) return;
  const entry = selectionSessions.get(currentResultSessionToken);
  if (!entry) {
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
    return;
  }
  const resultDistance = distanceFromPointToRect(pos, resultWindow.getBounds());
  const selectionDistances = (entry.panelGeometry?.selectionRects || []).map((rect) => distanceFromPointToRect(pos, rect));
  const nearest = Math.min(resultDistance, ...selectionDistances, Number.POSITIVE_INFINITY);
  if (nearest <= 220) {
    resultFarSince = 0;
    return;
  }
  if (!resultFarSince) resultFarSince = now;
  if (now - resultFarSince >= 450) dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
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
    maybeDismissResultForCursor(pos, now);
    if (overlayWindow && overlayWindow.isVisible()) sendCursorToOverlay(pos);
    if (panelWindow && panelWindow.isVisible()) return;
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
      beginSelectionSession('wiggle');
    }
  }, 35);
  log('wiggle polling started');
}

function panelPayloadForSession(entry) {
  return {
    selectionSessionToken: entry.token,
    selectionSnapshotId: entry.snapshot?.snapshot_id || null,
    panelLayoutNonce: entry.panelLayoutNonce,
    captureSummary: entry.summary,
    suggestedCommands: entry.suggestedCommands,
    captureEligibility: entry.captureEligibility,
    defaultInputMode: fabricSettings.interaction.default_input_mode,
    voiceAutoSubmit: fabricSettings.interaction.voice_auto_submit,
    voiceSilenceMs: fabricSettings.interaction.voice_silence_ms,
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
      url: String(context.url || ''),
      page: Number(context.page),
      hwnd: Number(sourceWindow.hwnd),
      processId: Number(sourceWindow.process_id || sourceWindow.pid),
    },
  };
}

function bindEpisodeForCommand(session, command) {
  const mode = inferReferenceMode(command);
  const object = episodeObjectForSession(session);
  if (mode === 'here') interactionEpisodes.bindHere(object);
  else {
    interactionEpisodes.bindPointedObject(object);
    if (mode === 'these') interactionEpisodes.bindThese();
  }
  const episode = interactionEpisodes.contextPayload();
  persistCurrentObjectEpisode(session);
  log(`interaction episode bind mode=${mode} episode=${episode?.episodeId || 'none'} session=${session?.token || 'none'}`);
  return episode;
}

function beginSelectionSession(reason = 'manual') {
  if (activeSelectionSessionToken) invalidateSelectionSession(activeSelectionSessionToken);
  if (readerWindow && !readerWindow.isDestroyed()) readerWindow.hide();
  readerPinned = false;
  readerHasFocused = false;

  const cursor = screen.getCursorScreenPoint();
  const physicalCursor = physicalScreenPoint(screen, cursor);
  const display = screen.getDisplayNearestPoint(cursor);
  const entry = selectionSessions.create({ reason, cursor });
  activeSelectionSessionToken = entry.token;
  createPanelWindow();
  showOverlay(`${reason}-capturing`, 0);
  // Additive PointerStage wiring: the stage wakes alongside the legacy panel
  // flow (a later task retires the panel from this hot path).
  showStage({
    reason,
    selectionSessionToken: entry.token,
    target: { x: cursor.x, y: cursor.y, width: 0, height: 0 },
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
        const stageBbox = attached.snapshot?.selection_bbox || attached.snapshot?.selection_rect;
        const stageTarget = Array.isArray(stageBbox) && stageBbox.length === 4
          ? { x: Number(stageBbox[0]), y: Number(stageBbox[1]), width: Number(stageBbox[2]), height: Number(stageBbox[3]) }
          : stageBbox && typeof stageBbox === 'object' ? stageBbox : null;
        updateStage({
          selectionSessionToken: entry.token,
          event: { type: 'FREEZE', target: stageTarget },
        });
        showPanel(reason, panelPayloadForSession(laidOut), { focusInput: true, sessionEntry: laidOut });
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
  try {
    fabricSettings = fabricSettingsStore.load();
  } catch (error) {
    fabricSettings = defaultSettings();
    log(`settings load failed closed ${error.name}: ${error.message}`);
  }
  wiggleDetector = new WiggleDetector({
    sensitivity: fabricSettings.activation.sensitivity,
    disabledApps: fabricSettings.activation.disabled_apps,
    cooldownMs: fabricSettings.activation.cooldown_ms,
  });
  createOverlayWindow();
  const ok = fabricSettings.activation.fallback_hotkey_enabled && globalShortcut.register('Control+Alt+M', () => {
    const decision = activationGate.decide({
      hasVisibleSurface: hasVisibleTemporarySurface() || Boolean(overlayWindow?.isVisible()),
      isActivationBusy: hasActiveSelectionCapture(),
    });
    log(`runtime issue hotkey decision=${decision}`);
    if (decision === 'ignore') return;
    if (decision === 'dismiss') {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      return;
    }
    showRuntimeIssueOverlay('hotkey');
  });
  log(`register hotkey Control+Alt+M runtime-issue ok=${ok}`);
  const deliveryHotkeyOk = globalShortcut.register('Control+Alt+Enter', () => {
    const decision = activationGate.decide({
      hasVisibleSurface: hasVisibleTemporarySurface() || Boolean(overlayWindow?.isVisible()),
      isActivationBusy: hasActiveSelectionCapture(),
    });
    log(`runtime delivery hotkey decision=${decision}`);
    if (decision === 'ignore') return;
    if (decision === 'dismiss') {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      return;
    }
    beginSelectionSession('runtime-delivery');
  });
  log(`register hotkey Control+Alt+Enter runtime-delivery ok=${deliveryHotkeyOk}`);
  const legacySelectionHotkeyOk = globalShortcut.register('Control+Alt+Shift+M', () => {
    const decision = activationGate.decide({
      hasVisibleSurface: hasVisibleTemporarySurface() || Boolean(overlayWindow?.isVisible()),
      isActivationBusy: hasActiveSelectionCapture(),
    });
    log(`legacy selection hotkey decision=${decision}`);
    if (decision === 'ignore') return;
    if (decision === 'dismiss') {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      return;
    }
    beginSelectionSession('legacy-native-selection');
  });
  log(`register hotkey Control+Alt+Shift+M legacy-selection ok=${legacySelectionHotkeyOk}`);
  const dashboardHotkeyOk = globalShortcut.register('Control+Alt+D', () => {
    if (dashboardWindow?.isVisible()) dashboardWindow.hide();
    else showDashboard({}, { activate: true });
  });
  log(`register hotkey Control+Alt+D dashboard ok=${dashboardHotkeyOk}`);
  const wiggleEnv = process.env.MAGIC_POINTER_ENABLE_MOUSE_SHAKE;
  const wiggleEnabled = wiggleEnv === '1'
    ? true
    : wiggleEnv === '0'
      ? false
      : fabricSettings.activation.wiggle_enabled;
  if (wiggleEnabled) {
    startPointerInputStateStream();
    startMouseShakePolling();
  }
  log(`wiggle enabled=${wiggleEnabled} sensitivity=${fabricSettings.activation.sensitivity}`);
  if (SHOW_STARTUP_OVERLAY) setTimeout(() => showOverlay('startup', 1400), 650);
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
  try { panelWindow?.close(); } catch (_) {}
  try { resultWindow?.close(); } catch (_) {}
  try { readerWindow?.close(); } catch (_) {}
  try { dashboardWindow?.close(); } catch (_) {}
  log('app will quit');
});

ipcMain.on('overlay:hide', (event) => {
  if (isSurfaceSender(event, 'overlay', resultTargetWindow)) hideOverlay();
});
ipcMain.on('panel:hide', (event) => {
  if (isSurfaceSender(event, 'panel', resultTargetWindow)) hidePanel({ hideObserver: true });
});
ipcMain.on('panel:resize', (event, payload) => {
  if (isSurfaceSender(event, 'panel', resultTargetWindow)) resizePanel(payload);
});
ipcMain.on('panel:show-contextual-result', (event, payload) => {
  if (isSurfaceSender(event, 'panel', resultTargetWindow)) showContextualResult(payload);
});
ipcMain.on('stage:show', (event) => {
  // Renderer re-asserts visibility once it has content to paint.
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  if (stageWindow && !stageWindow.isDestroyed() && !stageWindow.isVisible()) stageWindow.showInactive();
});
ipcMain.on('stage:update', (event, payload) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  log(`stage renderer state=${String(payload?.state || 'unknown')}`);
});
ipcMain.on('stage:hide', (event) => {
  if (isSurfaceSender(event, 'stage', resultTargetWindow)) hideStage();
});
ipcMain.on('dictation:start', (event, payload) => {
  const surface = payload?.surface === 'overlay' ? 'overlay' : payload?.surface === 'panel' ? 'panel' : null;
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
  const child = spawn(pythonExecutable, voiceArgs, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
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
ipcMain.on('result:ready', (event, payload) => {
  if (!isSurfaceSender(event, 'result', resultTargetWindow)) return;
  const selectionSessionToken = payload?.selectionSessionToken || null;
  const entry = selectionSessions.get(selectionSessionToken);
  if (!entry || selectionSessionToken !== currentResultSessionToken || selectionSessionToken !== activeSelectionSessionToken) return;
  positionResultForSession(entry, payload);
  resultWindow?.showInactive();
  resultShownAt = Date.now();
  hidePanelWindowOnly();
  log(`result ready token=${selectionSessionToken}`);
});
ipcMain.on('result:hide', (event) => {
  if (isSurfaceSender(event, 'result', resultTargetWindow)) {
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  }
});
ipcMain.on('result:expand', (event, payload) => {
  if (!isSurfaceSender(event, 'result', resultTargetWindow)) return;
  const selectionSessionToken = payload?.selectionSessionToken || null;
  if (!selectionSessions.get(selectionSessionToken) || selectionSessionToken !== currentResultSessionToken) return;
  if (resultWindow && !resultWindow.isDestroyed()) resultWindow.hide();
  showReader({ ...currentResultPayload, ...payload, resultMode: 'reader' });
  log(`result expanded token=${selectionSessionToken}`);
});

function resultTargetWindow(target) {
  if (target === 'dashboard' || target === 'calendar-dashboard' || target === 'fabric-dashboard') return dashboardWindow;
  if (target === 'stage') return stageWindow;
  if (target === 'reader') return readerWindow;
  if (target === 'result') return resultWindow;
  return target === 'panel' ? panelWindow : overlayWindow;
}

function safeSurfaceSend(surface, channel, payload) {
  const win = resultTargetWindow(surface);
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, payload);
  return true;
}

function sendBridgeResult(target, parsed) {
  const win = resultTargetWindow(target);
  const channel = target === 'calendar-dashboard'
    ? 'dashboard:calendar-state'
    : target === 'fabric-dashboard'
      ? 'dashboard:fabric-state'
    : target === 'dashboard'
      ? 'dashboard:state'
    : target === 'reader'
    ? 'reader:result'
    : target === 'result'
      ? 'result:result'
      : target === 'panel' ? 'panel:result' : 'overlay:result';
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
  runPythonBridge(enriched);
});




ipcMain.on('panel:submit-selection-command', (event, payload) => {
  if (!isSurfaceSender(event, 'panel', resultTargetWindow)) return;
  const selectionSessionToken = payload?.selectionSessionToken;
  const session = selectionSessions.get(selectionSessionToken);
  if (!session || !session.snapshot) {
    log('panel:submit-selection-command rejected missing-or-expired session');
    sendBridgeResult('panel', {
      ok: false,
      error: '当前 THIS 已过期，请重新激活 Magic Pointer。',
      selectionSessionToken: selectionSessionToken || null,
    });
    return;
  }
  if (!session.captureEligibility?.commandReady) {
    log('panel:submit-selection-command rejected ineligible capture');
    sendBridgeResult('panel', {
      ok: false,
      error: session.captureEligibility?.message || '当前选区不可用，请重新选择。',
      selectionSessionToken: selectionSessionToken || null,
    });
    return;
  }

  cancelSessionChild(selectionSessionToken);
  const requestId = selectionSessions.startRequest(selectionSessionToken);
  if (!requestId) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const interactionEpisode = bindEpisodeForCommand(session, payload?.command);
  const enriched = {
    ...payload,
    selectionSessionId: selectionSessionToken,
    selectionSnapshot: safeClone(session.snapshot),
    requestId,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || 1,
    source: 'observer_selection_panel',
    interactionEpisode,
    targetPoint: safeClone(session.snapshot?.target_point || null),
    targetPointSpace: session.snapshot?.target_point_space || null,
  };
  log(`panel:submit-selection-command token=${selectionSessionToken} request=${requestId} command_len=${String(enriched.command || '').length}`);
  let child = null;
  child = runPythonBridge(enriched, 'scripts/selection_bridge.py', 'panel', {
    onComplete: (parsed) => {
      if (activeSessionChildren.get(selectionSessionToken) === child) activeSessionChildren.delete(selectionSessionToken);
      if (!selectionSessions.isCurrentRequest(selectionSessionToken, requestId)) {
        log(`panel result ignored stale token=${selectionSessionToken} request=${requestId}`);
        return;
      }
      selectionSessions.finishRequest(selectionSessionToken, requestId);
      parsed.selectionSessionToken = selectionSessionToken;
      parsed.selectionSnapshotId = session.snapshot?.snapshot_id || null;
      parsed.requestId = requestId;
      registerActionProposals(parsed, selectionSessionToken, 'panel');
      if (parsed?.intentKind === 'calendar_event_draft' && parsed?.calendarDraft) {
        showDashboard({ view: 'calendar', calendarDraft: parsed.calendarDraft }, { activate: false });
        sendBridgeResult('panel', parsed);
        return;
      }
      if (parsed?.intentKind === 'route_draft' && parsed?.routeDraft) {
        showDashboard({ view: 'route', routeDraft: parsed.routeDraft }, { activate: false });
        sendBridgeResult('panel', parsed);
        return;
      }
      const autoProposal = parsed.actionProposals?.find((proposal) => proposal.id === parsed.autoExecuteProposalId);
      if (canAutoExecuteInternalProposal(parsed, autoProposal)) {
        if (
          parsed?.intentKind === 'review_draft_delivery'
          || parsed?.intentKind === 'context_prompt_delivery'
        ) {
          log(`trusted grounded prompt delivery kind=${parsed.intentKind} proposal=${autoProposal.id}`);
          dismissTemporarySurfaces({ invalidateSession: false, hideObserver: true });
          setTimeout(() => {
            executeActionForTarget({
              actionToken: autoProposal.action_token,
              proposalId: autoProposal.id,
              confirmed: false,
              selectionSessionToken,
            }, 'panel', {
              onComplete: (actionResult) => {
                showContextualResult({
                  ...actionResult,
                  selectionSessionToken,
                  intentKind: `${parsed.intentKind}_result`,
                });
              },
            });
          }, 80);
          return;
        }
        log(`trusted internal auto-execute type=${autoProposal.action_type} proposal=${autoProposal.id}`);
        sendBridgeResult('panel', {
          ok: null,
          status: '正在加入购物清单…',
          selectionSessionToken,
          requestId,
        });
        executeActionForTarget({
          actionToken: autoProposal.action_token,
          proposalId: autoProposal.id,
          confirmed: false,
          selectionSessionToken,
        }, 'panel', {
          onComplete: (actionResult) => {
            const output = actionResult?.executionResult?.output || {};
            const highlightItemId = output?.verified === true ? output?.item?.id : null;
            if (actionResult?.ok === true && highlightItemId) {
              showDashboard({ highlightItemId }, { activate: false });
            }
            sendBridgeResult('panel', actionResult);
          },
        });
        return;
      }
      sendBridgeResult('panel', parsed);
    },
  });
  if (child) activeSessionChildren.set(selectionSessionToken, child);
});

function executeActionForTarget(payload, target, options = {}) {
  const token = payload?.actionToken || payload?.action_token;
  const selectionSessionToken = payload?.selectionSessionToken || null;
  const isSelectionSurface = target === 'panel' || target === 'result' || target === 'reader';
  if (isSelectionSurface && !selectionSessions.get(selectionSessionToken)) {
    log(`${target}:execute-action rejected expired selection session`);
    sendBridgeResult(target, {
      ok: false,
      prompt: 'Action result',
      error: '当前 THIS 已过期，请重新激活 Magic Pointer。',
      selectionSessionToken,
    });
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
      if (isSelectionSurface && !selectionSessions.get(selectionSessionToken)) {
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

ipcMain.on('overlay:execute-action', (event, payload) => {
  if (isSurfaceSender(event, 'overlay', resultTargetWindow)) executeActionForTarget(payload, 'overlay');
});
ipcMain.on('panel:execute-action', (event, payload) => {
  if (isSurfaceSender(event, 'panel', resultTargetWindow)) executeActionForTarget(payload, 'panel');
});
ipcMain.on('result:execute-action', (event, payload) => {
  if (isSurfaceSender(event, 'result', resultTargetWindow)) executeActionForTarget(payload, 'result');
});
ipcMain.on('reader:execute-action', (event, payload) => {
  if (isSurfaceSender(event, 'reader', resultTargetWindow)) executeActionForTarget(payload, 'reader');
});
ipcMain.on('reader:hide', (event) => {
  if (isSurfaceSender(event, 'reader', resultTargetWindow)) {
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  }
});
ipcMain.on('reader:set-pinned', (event, payload) => {
  if (!isSurfaceSender(event, 'reader', resultTargetWindow)) return;
  readerPinned = payload?.pinned === true;
  log(`reader pinned=${readerPinned}`);
});
ipcMain.on('reader:resize', (event, payload) => {
  if (!isSurfaceSender(event, 'reader', resultTargetWindow)) return;
  const selectionSessionToken = payload?.selectionSessionToken || null;
  if (!readerWindow || readerWindow.isDestroyed() || !selectionSessions.get(selectionSessionToken)) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea || display.bounds;
  const current = readerWindow.getBounds();
  const maxHeight = Math.max(240, Math.floor(workArea.height * 0.72));
  const height = Math.min(maxHeight, Math.max(240, Math.ceil(Number(payload?.height) || current.height)));
  readerWindow.setBounds({ ...current, y: Math.max(workArea.y + 16, Math.min(current.y, workArea.y + workArea.height - height - 16)), height });
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
  const allowedOperations = new Set([
    'catalog',
    'providers',
    'settings.get',
    'settings.save',
    'audit.tail',
    'task.status',
    'task.cancel',
    'task.steer',
  ]);
  if (!allowedOperations.has(operation)) {
    sendBridgeResult('fabric-dashboard', {
      ok: false,
      fabricOperation: operation,
      error: 'Dashboard operation is not allowed.',
    });
    return;
  }
  runPythonBridge({
    ...payload,
    operation,
  }, 'scripts/fabric_bridge.py', 'fabric-dashboard', {
    onComplete: (parsed) => {
      if (operation === 'settings.save' && parsed?.ok === true && parsed?.settings) {
        fabricSettings = parsed.settings;
        if (wiggleDetector) {
          wiggleDetector.updateSettings({
            sensitivity: parsed.settings.activation?.sensitivity,
            disabledApps: parsed.settings.activation?.disabled_apps || [],
            cooldownMs: parsed.settings.activation?.cooldown_ms,
          });
        }
        if (fabricSettings.activation?.wiggle_enabled && !mousePollTimer) {
          startPointerInputStateStream();
          startMouseShakePolling();
        } else if (!fabricSettings.activation?.wiggle_enabled && mousePollTimer) {
          clearInterval(mousePollTimer);
          mousePollTimer = null;
          try { if (pointerStateChild && !pointerStateChild.killed) pointerStateChild.kill(); } catch (_) {}
          pointerStateChild = null;
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
