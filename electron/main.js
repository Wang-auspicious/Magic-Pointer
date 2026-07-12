const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { SelectionSessionStore } = require('./selection_session');
const { InteractionEpisodeStore, inferReferenceMode } = require('./interaction_episode');
const { ActivationGate } = require('./activation_gate');
const { captureEligibility, classifyResult, normalizeResultPreference } = require('./result_surface_policy');
const { canAutoExecuteInternalProposal } = require('./internal_action_policy');
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
let mousePoints = [];
let lastShakeTrigger = 0;
let mousePollTimer = null;
let overlayHideTimer = null;

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const LOG_PATH = path.join(RUNTIME_DIR, 'electron.log');
const PID_PATH = path.join(RUNTIME_DIR, 'electron.pid');
const ACTION_PROPOSAL_TTL_MS = 2 * 60 * 1000;
const SELECTION_SESSION_TTL_MS = 2 * 60 * 1000;
const PANEL_RAIL_HEIGHT = 44;
const PANEL_RAIL_MIN_WIDTH = 88;
const PANEL_RAIL_MAX_WIDTH = 360;
const PANEL_MAX_HEIGHT = 380;
const RESULT_SURFACE_MODE = normalizeResultPreference(process.env.MAGIC_POINTER_RESULT_MODE);
const ALLOWED_ACTION_TYPES = new Set([
  'copy_text_to_clipboard',
  'office_replace_selection',
  'office_undo_last_action',
  'shopping_list_add',
  'shopping_list_set_checked',
  'shopping_list_undo_add',
]);

const pendingActionProposals = new Map();
const selectionSessions = new SelectionSessionStore({ ttlMs: SELECTION_SESSION_TTL_MS });
const interactionEpisodes = new InteractionEpisodeStore({ ttlMs: 30 * 60 * 1000 });
const activationGate = new ActivationGate({ debounceMs: 600 });
const activeSessionChildren = new Map();
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

function prunePendingActionProposals(now = Date.now()) {
  for (const [token, entry] of pendingActionProposals.entries()) {
    if (!entry || entry.expiresAt <= now) pendingActionProposals.delete(token);
  }
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function registerActionProposals(parsed, selectionSessionToken = null) {
  if (!parsed || !Array.isArray(parsed.actionProposals)) return;

  prunePendingActionProposals();
  const now = Date.now();
  const safeProposals = [];
  for (const proposal of parsed.actionProposals.slice(0, 5)) {
    if (!proposal || typeof proposal !== 'object') continue;
    if (!ALLOWED_ACTION_TYPES.has(proposal.action_type)) continue;

    const token = crypto.randomUUID();
    const canonical = safeClone(proposal);
    pendingActionProposals.set(token, {
      proposal: canonical,
      selectionSessionToken,
      createdAt: now,
      expiresAt: now + ACTION_PROPOSAL_TTL_MS,
    });
    safeProposals.push({ ...canonical, action_token: token });
  }

  parsed.actionProposals = safeProposals;
}

function takePendingActionProposal(token, selectionSessionToken = null) {
  prunePendingActionProposals();
  if (typeof token !== 'string' || !token) return null;
  const entry = pendingActionProposals.get(token);
  if (!entry) return null;
  if (entry.selectionSessionToken && entry.selectionSessionToken !== selectionSessionToken) return null;
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
    width: 860,
    height: 640,
    minWidth: 680,
    minHeight: 540,
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
  const width = Math.min(860, Math.max(680, workArea.width - 48));
  const height = Math.min(640, Math.max(540, workArea.height - 48));
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
    const initialIntent = payload?.suggestedCommands?.[0];
    const initialLabel = initialIntent?.label || initialIntent?.command || '输入短命令';
    positionPanelForSession(currentEntry || sessionEntry, {
      width: computeInlineRailWidth(initialLabel),
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
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send('panel:hide');
    panelWindow.hide();
  }
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

function looksLikeMouseShake(now) {
  const recent = mousePoints.filter((p) => now - p.t <= 1150);
  if (recent.length < 8) return false;

  const xs = recent.map((p) => p.x);
  const ys = recent.map((p) => p.y);
  const xRange = Math.max(...xs) - Math.min(...xs);
  const yRange = Math.max(...ys) - Math.min(...ys);
  if (xRange < 58) return false;
  if (yRange > Math.max(92, xRange * 0.75)) return false;

  const chunks = [];
  let currentDir = 0;
  let currentDist = 0;
  let prevX = xs[0];
  for (const x of xs.slice(1)) {
    const dx = x - prevX;
    prevX = x;
    if (Math.abs(dx) < 10) continue;
    const dir = dx > 0 ? 1 : -1;
    if (currentDir === 0) {
      currentDir = dir;
      currentDist = Math.abs(dx);
    } else if (dir === currentDir) {
      currentDist += Math.abs(dx);
    } else {
      chunks.push([currentDir, currentDist]);
      currentDir = dir;
      currentDist = Math.abs(dx);
    }
  }
  if (currentDir) chunks.push([currentDir, currentDist]);

  const meaningful = [];
  for (const [dir, dist] of chunks) {
    if (dist < 24) continue;
    const last = meaningful[meaningful.length - 1];
    if (last && last[0] === dir) last[1] += dist;
    else meaningful.push([dir, dist]);
  }
  if (meaningful.length < 4) return false;
  const turns = meaningful.slice(1).filter((chunk, i) => chunk[0] !== meaningful[i][0]).length;
  if (turns < 3) return false;
  const total = meaningful.reduce((sum, chunk) => sum + chunk[1], 0);
  const net = Math.abs(xs[xs.length - 1] - xs[0]);
  if (total < 145) return false;
  if (net > total * 0.65 && net > 110) return false;
  return true;
}

function startMouseShakePolling() {
  if (mousePollTimer) clearInterval(mousePollTimer);
  mousePollTimer = setInterval(() => {
    const now = Date.now();
    const pos = screen.getCursorScreenPoint();
    maybeDismissResultForCursor(pos, now);
    if (overlayWindow && overlayWindow.isVisible()) sendCursorToOverlay(pos);
    if (panelWindow && panelWindow.isVisible()) return;
    if (!overlayWindow || overlayWindow.isVisible()) return;
    mousePoints.push({ t: now, x: pos.x, y: pos.y });
    if (mousePoints.length > 28) mousePoints.shift();
    if (now - lastShakeTrigger > 900 && looksLikeMouseShake(now)) {
      lastShakeTrigger = now;
      mousePoints = [];
      showOverlay('mouse-shake', 1600);
    }
  }, 35);
  log('mouse shake polling started');
}

function panelPayloadForSession(entry) {
  return {
    selectionSessionToken: entry.token,
    selectionSnapshotId: entry.snapshot?.snapshot_id || null,
    panelLayoutNonce: entry.panelLayoutNonce,
    captureSummary: entry.summary,
    suggestedCommands: entry.suggestedCommands,
    captureEligibility: entry.captureEligibility,
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
  log(`interaction episode bind mode=${mode} episode=${episode?.episodeId || 'none'} session=${session?.token || 'none'}`);
  return episode;
}

function beginSelectionSession(reason = 'manual') {
  if (activeSelectionSessionToken) invalidateSelectionSession(activeSelectionSessionToken);
  if (readerWindow && !readerWindow.isDestroyed()) readerWindow.hide();
  readerPinned = false;
  readerHasFocused = false;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const entry = selectionSessions.create({ reason, cursor });
  activeSelectionSessionToken = entry.token;
  createPanelWindow();
  showOverlay(`${reason}-capturing`, 0);
  log(`selection session capture start reason=${reason} token=${entry.token}`);

  let child = null;
  child = runPythonBridge(
    {
      mode: 'capture_selection_snapshot',
      reason,
      cursor,
      screenBounds: display.bounds,
      scaleFactor: display.scaleFactor || 1,
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
        attached.captureEligibility = captureEligibility({ snapshot: attached.snapshot, summary: attached.summary });
        const laidOut = selectionSessions.setPanelLayout(entry.token, {
          nonce: crypto.randomUUID(),
          geometry: panelGeometryForSession(attached),
        });
        if (!laidOut) return;
        log(`selection session capture done token=${entry.token} status=${attached.snapshot?.status || 'missing'} app=${attached.summary?.app || 'none'}`);
        showPanel(reason, panelPayloadForSession(laidOut), { focusInput: false, sessionEntry: laidOut });
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
  createOverlayWindow();
  const ok = globalShortcut.register('Control+Alt+M', () => {
    const decision = activationGate.decide({
      hasVisibleSurface: hasVisibleTemporarySurface(),
      isActivationBusy: hasActiveSelectionCapture(),
    });
    log(`activation hotkey decision=${decision}`);
    if (decision === 'ignore') return;
    if (decision === 'dismiss') {
      dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
      return;
    }
    beginSelectionSession('hotkey');
  });
  log(`register hotkey Control+Alt+M selection-session ok=${ok}`);
  const dashboardHotkeyOk = globalShortcut.register('Control+Alt+D', () => {
    if (dashboardWindow?.isVisible()) dashboardWindow.hide();
    else showDashboard({}, { activate: true });
  });
  log(`register hotkey Control+Alt+D dashboard ok=${dashboardHotkeyOk}`);
  startMouseShakePolling();
  // First launch should show once so the user knows the background process is alive.
  setTimeout(() => showOverlay('startup', 1400), 650);
});

app.on('will-quit', () => {
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
  globalShortcut.unregisterAll();
  if (mousePollTimer) clearInterval(mousePollTimer);
  try { panelWindow?.close(); } catch (_) {}
  try { resultWindow?.close(); } catch (_) {}
  try { readerWindow?.close(); } catch (_) {}
  try { dashboardWindow?.close(); } catch (_) {}
  log('app will quit');
});

ipcMain.on('overlay:hide', hideOverlay);
ipcMain.on('panel:hide', () => hidePanel({ hideObserver: true }));
ipcMain.on('panel:resize', (_event, payload) => resizePanel(payload));
ipcMain.on('panel:show-contextual-result', (_event, payload) => showContextualResult(payload));
ipcMain.on('result:ready', (_event, payload) => {
  const selectionSessionToken = payload?.selectionSessionToken || null;
  const entry = selectionSessions.get(selectionSessionToken);
  if (!entry || selectionSessionToken !== currentResultSessionToken || selectionSessionToken !== activeSelectionSessionToken) return;
  positionResultForSession(entry, payload);
  resultWindow?.showInactive();
  resultShownAt = Date.now();
  hidePanelWindowOnly();
  log(`result ready token=${selectionSessionToken}`);
});
ipcMain.on('result:hide', () => dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true }));
ipcMain.on('result:expand', (_event, payload) => {
  const selectionSessionToken = payload?.selectionSessionToken || null;
  if (!selectionSessions.get(selectionSessionToken) || selectionSessionToken !== currentResultSessionToken) return;
  if (resultWindow && !resultWindow.isDestroyed()) resultWindow.hide();
  showReader({ ...currentResultPayload, ...payload, resultMode: 'reader' });
  log(`result expanded token=${selectionSessionToken}`);
});

function resultTargetWindow(target) {
  if (target === 'dashboard') return dashboardWindow;
  if (target === 'reader') return readerWindow;
  if (target === 'result') return resultWindow;
  return target === 'panel' ? panelWindow : overlayWindow;
}

function sendBridgeResult(target, parsed) {
  const win = resultTargetWindow(target);
  const channel = target === 'dashboard'
    ? 'dashboard:state'
    : target === 'reader'
    ? 'reader:result'
    : target === 'result'
      ? 'result:result'
      : target === 'panel' ? 'panel:result' : 'overlay:result';
  win?.webContents.send(channel, parsed);
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
      MAGIC_POINTER_USER_DATA_DIR: app.getPath('userData'),
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
    registerActionProposals(parsed, options.selectionSessionToken || null);
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

ipcMain.on('overlay:done', (_event, payload) => {
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




ipcMain.on('panel:submit-selection-command', (_event, payload) => {
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
      registerActionProposals(parsed, selectionSessionToken);
      const autoProposal = parsed.actionProposals?.find((proposal) => proposal.id === parsed.autoExecuteProposalId);
      if (canAutoExecuteInternalProposal(parsed, autoProposal)) {
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
  const proposal = takePendingActionProposal(token, selectionSessionToken);
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
      registerActionProposals(parsed, selectionSessionToken);
      if (typeof options.onComplete === 'function') options.onComplete(parsed);
      else sendBridgeResult(target, parsed);
    },
  });
}

ipcMain.on('overlay:execute-action', (_event, payload) => executeActionForTarget(payload, 'overlay'));
ipcMain.on('panel:execute-action', (_event, payload) => executeActionForTarget(payload, 'panel'));
ipcMain.on('result:execute-action', (_event, payload) => executeActionForTarget(payload, 'result'));
ipcMain.on('reader:execute-action', (_event, payload) => executeActionForTarget(payload, 'reader'));
ipcMain.on('reader:hide', () => dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true }));
ipcMain.on('reader:set-pinned', (_event, payload) => {
  readerPinned = payload?.pinned === true;
  log(`reader pinned=${readerPinned}`);
});
ipcMain.on('reader:resize', (_event, payload) => {
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

ipcMain.on('dashboard:hide', (event) => {
  if (isDashboardSender(event)) dashboardWindow.hide();
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
