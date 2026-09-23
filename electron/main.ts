const { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, safeStorage, systemPreferences, WebContentsView } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { dialog } = require('electron');
const { Menu, nativeImage, Tray } = require('electron');
const { nativeTheme } = require('electron');
const { shell } = require('electron');
const { spawn } = require('child_process');
const { net } = require('electron');
const { expandPassage } = require('./runtime/text');
const { resolveModelConfig, listModels } = require('./runtime/model');
const { handleSessionRead } = require('./runtime/session');
const fs = require('fs');
const crypto = require('crypto');

if (fs.existsSync(path.join(__dirname, 'runtime_paths.ts'))) {
  require('tsx/cjs');
}

const { projectRoot } = require('./runtime_paths');
const { scheduleBackgroundLearning } = require('./background_learning');
const { SelectionSessionStore, continuationTaskForSelection } = require('./selection_session');
const { InteractionEpisodeStore, inferReferenceLabel } = require('./interaction_episode');
const TaskSources = require('./task_sources');
const { readBackgroundAgents } = require('./background_agents');
const { ActivationGate } = require('./activation_gate');
const { WiggleDetector } = require('./wiggle_detector');
const { runDeterministicWiggleEvidence } = require('./wiggle_reliability');
const { MouseActivationDetector } = require('./mouse_activation');
const { ElectronSettingsStore, defaultSettings, validate: validateSettings } = require('./settings_store');
const { mergeSettingsPatch, settingsSaveImpact } = require('./settings_save_policy');
const { CredentialStore } = require('./credential_store');
const {
  activeModelRuntimeStatus,
  promoteLegacyProfile,
  LEGACY_CREDENTIAL_REF,
  resolveActiveModelRuntimeConfig,
  selectActiveProfileModel,
  collectModelCatalog,
} = require('./model_runtime_config');
const { probeQuota } = require('./quota_probe');
const { createBufferedLog } = require('./append_log');
const { toPhysicalGeometry, overlayPointToScreenDip, mapOverlayPointToPhysical } = require('./geometry_space');
const { PreflightRunner } = require('./bootstrap_runner');
const { buildAsyncPreflightChecks } = require('./preflight_checks');
const {
  isConversationSender,
  appendTranscript,
  bridgeHistoryTurns,
  planConversationStop,
  planConversationSteer,
  sanitizePermissionRule,
  sessionIdFromRecord,
} = require('./conversation_control');
const { studioConversationSessionId } = require('./agent_session_id');
const { attachmentDialogOptions, resolveConversationWorkspace } = require('./conversation_workspace_policy');
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
  physicalDisplayBounds,
  physicalGestureBoundingBox,
  physicalGestureTrace,
  physicalRectToDip,
  physicalScreenPoint,
  relativeRect,
} = require('./coordinate_space');
const { FrameCaptureWorkerClient } = require('./frame_capture_worker_client');
const { CaptureCommitCoordinator } = require('./capture_commit_coordinator');
const { nativeShapeRegions } = require('./stage_hit_regions');
const { isSurfaceSender } = require('./ipc_surface_policy');
const { AgentCursorSurfaces } = require('./agent_cursor_window');
const { buildGoogleMapsDirectionsUrl, isAllowedGoogleMapsDirectionsUrl } = require('./route_policy');
const securityHardening = require('./security_hardening');
const observability = require('./observability');
const { inspectOnboardingReadiness, shouldStartHidden } = require('./app_lifecycle');
const { RuntimeSnapshot } = require('./runtime_snapshot');
const {
  chainFinalizeDelay,
  boundGestureInput,
  pointerContinuesGestureChain,
  summarizeGesture,
} = require('./gesture_capture');
const { shouldDismissFromGlobalPointer } = require('./pointer_dismiss_policy');
const { RendererReadiness } = require('./renderer_readiness');
const { gestureRuntimeContract, gestureRuntimeSettingsChanged } = require('./gesture_runtime_settings');
const { createUpdateManager } = require('./update_manager');
const { pointerPollingPolicy } = require('./pointer_polling_policy');
const { PassThroughGestureCapture } = require('./pass_through_gesture');
const { createRuntimeBridgeRunner } = require('./runtime_bridge_runner');
const CardModel = require('./cards');
const { createTaskWatcher } = require('./task_watcher');
const { createStashRuntime } = require('./stash_runtime');
const { isTransientShell } = require('./stash_store');
const { evaluateRule } = require('./proactive_rules');
const { createProactiveOnceStore } = require('./proactive_once_store');
const { createConversationStore } = require('./conversation_store');
const { createArtifactRuntime } = require('./artifact_runtime');
const { FigmaRuntimeController } = require('./figma_runtime');
const { createContextTrackerRuntime, createMaterialTracker, buildContextTrackerConversationRequest } = require('./context_trackers');
let contextTrackerRuntime: ReturnType<typeof createContextTrackerRuntime> | null = null;
const { conversationFailureMessage } = require('./conversation_error');
const { listProjectDirectory, projectPath, readProjectText } = require('./project_inspector');
const { parseGitEnvironment, sourceLinksFromConversation } = require('./project_environment');
const {
  isManagedWorktreePath,
  worktreeAddArgs,
  worktreePathFor,
  worktreeRemoveArgs,
  worktreeReuseArgs,
  worktreeSlug,
} = require('./session_worktree');
const { normalizeBrowserUrl, projectContextActions } = require('./browser_view_policy');
const { withKeptStrokes } = require('./stage_turn_stream');

const CONVERSATION_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function normalizeConversationEffort(value: unknown): string {
  const candidate = String(value || '').trim().toLowerCase();
  return CONVERSATION_EFFORT_LEVELS.has(candidate) ? candidate : 'high';
}

let overlayWindow: InstanceType<typeof BrowserWindow> | null = null;
let agentCursorSurfaces: InstanceType<typeof AgentCursorSurfaces> | null = null;
let dashboardWindow: InstanceType<typeof BrowserWindow> | null = null;
let dashboardBrowserView: InstanceType<typeof WebContentsView> | null = null;
let onboardingWindow: InstanceType<typeof BrowserWindow> | null = null;
let stageWindow: InstanceType<typeof BrowserWindow> | null = null;
const overlayReadiness = new RendererReadiness();
const stageReadiness = new RendererReadiness();
let tray: InstanceType<typeof Tray> | null = null;
let updateManager: ReturnType<typeof createUpdateManager> | null = null;
let mousePollTimer: NodeJS.Timeout | null = null;
let overlayHideTimer: NodeJS.Timeout | null = null;
let selectionGestureArm: {
  token: string;
  reason: string;
  runtime: ReturnType<typeof gestureRuntimeContract>;
  armedAt: number;
  readyAt: number;
  expiresAt: number;
  armDelayMs: number;
  timeoutMs: number;
  displayBounds: { x: number; y: number; width: number; height: number };
  source: {
    foregroundApp: string;
    foregroundHwnd: number;
    foregroundProcessId: number;
  };
  committing?: boolean;
} | null = null;
let selectionGestureArmTimer: NodeJS.Timeout | null = null;
let selectionGestureExpiryTimer: NodeJS.Timeout | null = null;
let frameCaptureWorkerClient: InstanceType<typeof FrameCaptureWorkerClient> | null = null;
let captureCommitCoordinator: InstanceType<typeof CaptureCommitCoordinator> | null = null;
let passThroughChainTimer: NodeJS.Timeout | null = null;
let passThroughChainDeadlineAt = 0;
let passThroughChainLastPoint: { x: number; y: number; t?: number } | null = null;
let wiggleDetector: InstanceType<typeof WiggleDetector> | null = null;
const mouseActivationDetector = new MouseActivationDetector();
const passThroughGestureCapture = new PassThroughGestureCapture();
const runtimeBridgeRunner = createRuntimeBridgeRunner();
let fabricSettings: any = null;
let fabricSettingsStore: InstanceType<typeof ElectronSettingsStore> | null = null;
let credentialStore: InstanceType<typeof CredentialStore> | null = null;
let pointerStateChild: import('child_process').ChildProcessWithoutNullStreams | null = null;
let pointerStateRestartTimer: NodeJS.Timeout | null = null;
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
let lastStableForegroundApp = '';
let lastStableForegroundWindow = {
  app: '',
  hwnd: 0,
  process_id: 0,
};
let wiggleCalibrationTimer: NodeJS.Timeout | null = null;
let lastWiggleTraceAt = 0;
let inputPaused = false;
let isQuitting = false;
let onboardingRequired = false;
let onboardingPhase = 'welcome';
let preflightRunPromise: ReturnType<typeof runPreflight> | null = null;
let preflightAbortController: AbortController | null = null;
let backgroundHintShown = false;
let temporaryDismissShortcutRegistered = false;
let temporaryGestureSubmitShortcutRegistered = false;
let temporarySurfaceButtons = 0;
let overlayOwnsPointerInput = false;
let stageHitRegions: { x: number; y: number; width: number; height: number }[] = [];
let stageShapeSettleTimer: NodeJS.Timeout | null = null;
let pendingSurfaceActivation: { reason: string; requestedAt: number } | null = null;
let surfaceReadinessWaitArmed = false;
const registeredConfigurableHotkeys = new Set();

const MAX_OVERLAY_CAPTURE_POINTS = 4096;
const MAX_OVERLAY_CAPTURE_STROKES = 32;

const ROOT = projectRoot(__dirname);
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
const FIGMA_BRIDGE_PORT = Number.parseInt(process.env.MAGIC_POINTER_FIGMA_PORT || '37843', 10);
if (!Number.isInteger(FIGMA_BRIDGE_PORT) || FIGMA_BRIDGE_PORT < 1 || FIGMA_BRIDGE_PORT > 65535) {
  throw new Error('MAGIC_POINTER_FIGMA_PORT must be an integer from 1 to 65535');
}
const figmaRuntime = new FigmaRuntimeController({ port: FIGMA_BRIDGE_PORT });
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
  'paste_text_to_foreground',
  'fabric_recipe_execute',
]);

const pendingActionProposals = new Map();
const selectionSessions = new SelectionSessionStore({ ttlMs: SELECTION_SESSION_TTL_MS });
const interactionEpisodes = new InteractionEpisodeStore({ ttlMs: 30 * 60 * 1000 });
const activationGate = new ActivationGate({ debounceMs: 600 });
const activeSessionChildren = new Map();
const activeSessionAgentIds = new Map();
const activeConversations = new Map();
const GRACEFUL_CANCEL_GRACE_MS = 5_000;
const sessionTimeline = new SessionTimeline();
const runtimeSnapshot = new RuntimeSnapshot({
  probe: probeRuntimeState,
  ttlMs: 5000,
});
let activeSelectionSessionToken: string | null = null;
let lastStageResult: { token: string | null; parsed: any } | null = null;

const appendLog = createBufferedLog({ filePath: LOG_PATH });

function log(message: unknown) {
  appendLog.log(message);
}

function flushLog() {
  appendLog.flush();
}

securityHardening.install({
  logger: log,
  onFatal: ({ kind }: { kind: string }) => {
    try {
      observability.writeEvent('main.fatal', { kind });
      observability.flushEvents();
    } catch (_) {}
    log(`fatal handler notified kind=${kind}`);
    flushLog();
  },
  electron: require('electron'),
});

observability.install({ runtimeDir: RUNTIME_DIR });





function persistCurrentObjectEpisode(session: any) {
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
    objects: episode.objects.map((item: any) => ({
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
  queueEpisodeWrite(currentObjectPath, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

let pendingEpisodeWrite: { filePath: string; payload: string } | null = null;
let episodeWriteScheduled = false;

function writeEpisodeNow(job: { filePath: string; payload: string }): void {
  const tempPath = `${job.filePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(job.filePath), { recursive: true });
    fs.writeFileSync(tempPath, job.payload, 'utf8');
    fs.renameSync(tempPath, job.filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    log(`current object persist failed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

function flushCurrentObjectEpisode(): void {
  episodeWriteScheduled = false;
  const job = pendingEpisodeWrite;
  pendingEpisodeWrite = null;
  if (job) writeEpisodeNow(job);
}

function queueEpisodeWrite(filePath: string, payload: string): void {
  pendingEpisodeWrite = { filePath, payload };
  if (episodeWriteScheduled) return;
  episodeWriteScheduled = true;
  setImmediate(flushCurrentObjectEpisode);
}

function startPointerInputStateStream() {
  if (pointerStateChild) return;
  let executable = null;
  let args: string[] = [];
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
  const child = spawn(executable, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  pointerStateChild = child;
  child.stdin.on('error', (error: Error) => {
    log(`pointer hook command stream error ${error.name}: ${error.message}`);
  });
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
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
  child.on('close', () => {
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
  child.on('error', (error: Error) => {
    log(`pointer state stream error ${error.name}: ${error.message}`);
  });
  syncPointerEpisodeChord();
}

function sendPointerInputCommand(command: unknown) {
  if (process.platform !== 'win32') return false;
  const line = String(command || '').trim();
  if (!line || !pointerStateChild?.stdin || pointerStateChild.stdin.destroyed || !pointerStateChild.stdin.writable) {
    return false;
  }
  try {
    pointerStateChild.stdin.write(`${line}\n`);
    return true;
  } catch (error) {
    log(`pointer hook command failed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
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

function safeClone(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function registerActionProposals(parsed: any, selectionSessionToken: string | null = null, surface: string | null = null) {
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

function takePendingActionProposal(token: string, selectionSessionToken: string | null = null, surface: string | null = null) {
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

function cancelSessionChild(selectionSessionToken: string | null) {
  const child = activeSessionChildren.get(selectionSessionToken);
  activeSessionChildren.delete(selectionSessionToken);
  const agentSessionId = activeSessionAgentIds.get(selectionSessionToken);
  activeSessionAgentIds.delete(selectionSessionToken);
  if (!child || child.killed) return;
  if (agentSessionId) requestGracefulAgentCancel(agentSessionId);
  setTimeout(() => {
    try { if (!child.killed) child.kill(); } catch (_) {}
  }, GRACEFUL_CANCEL_GRACE_MS);
}

async function putTaskInputToSession(
  sessionId: string,
  rawTaskInput: unknown,
  sources: unknown[] = [],
) {
  const taskInput = TaskSources.normalizeTaskInput({
    ...(rawTaskInput && typeof rawTaskInput === 'object' ? rawTaskInput : {}),
    taskId: sessionId,
    target: 'next-step',
  });
  const payload: Record<string, unknown> = { action: 'put', sessionId, taskInput };
  if (sources.length) payload.sources = sources;
  return runRuntimeBridgePromise(
    payload,
    'agent_session',
    { target: null, timeoutMs: 8_000 },
  );
}

ipcMain.handle('stage:steer-selection-command', async (event: Electron.IpcMainInvokeEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return { ok: false, error: 'unauthorized_renderer' };
  const token = String(payload?.selectionSessionToken || '');
  const selectionSession = selectionSessions.get(token);
  if (!token || !selectionSession) return { ok: false, error: 'invalid_request' };
  const agentSessionId = activeSessionAgentIds.get(token) || selectionSession.taskId;
  if (!agentSessionId) return { ok: false, error: 'no_agent_session' };
  try {
    const rawTaskInput = payload?.taskInput && typeof payload.taskInput === 'object'
      ? payload.taskInput
      : {
        inputId: String(payload?.inputId || crypto.randomUUID()),
        taskId: agentSessionId,
        target: 'next-step',
        instruction: String(payload?.text || '').trim(),
        referenceUpdates: [],
        sourceIds: [],
        timeline: [],
        capturedAtMs: Date.now(),
      };
    const parsed = await putTaskInputToSession(agentSessionId, rawTaskInput);
    log(`stage TaskInput queued session=${agentSessionId} inputId=${parsed?.inputId || '-'}`);
    return {
      ok: parsed?.ok === true,
      inputId: parsed?.inputId || null,
      status: parsed?.status || null,
      referenceRevision: parsed?.referenceRevision,
      error: parsed?.error,
    };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error || 'bridge_failed') };
  }
});

function requestGracefulAgentCancel(agentSessionId: string) {
  runRuntimeBridgePromise(
    { action: 'cancel', sessionId: agentSessionId, reason: 'user stop' },
    'agent_session',
    { target: null, timeoutMs: 8_000 },
  ).then(
    (parsed: any) => {
      if (parsed?.ok !== true) log(`graceful cancel not accepted session=${agentSessionId} error=${parsed?.error || 'unknown'}`);
      else log(`graceful cancel requested session=${agentSessionId} turn=${parsed.turn}`);
    },
    (error: any) => log(`graceful cancel bridge failed session=${agentSessionId}: ${error?.message || error}`),
  );
}

ipcMain.handle('stage:stop-selection-command', (event: Electron.IpcMainInvokeEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return { ok: false, error: 'unauthorized_stage_sender' };
  const token = String(payload?.selectionSessionToken || '');
  if (!stageLiveTurns.has(token)) return { ok: false, error: 'no_request' };
  cancelSessionChild(token);
  return { ok: true };
});

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
    log(`update runtime unavailable ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return null;
  }
  updateManager = createUpdateManager({
    app,
    updater,
    dialog,
    log,
    onStatus: (state: { state: string; checkedAt?: number; version?: string; progress?: number; message?: string }) => {
      refreshTrayMenu();
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('dashboard:update-status', state);
      }
    },
  });
  updateManager.start({
    channel: fabricSettings?.general?.update_channel || 'stable',
    automatic,
  });
  refreshTrayMenu();
  return updateManager;
}

function syncAgentCursorSurfaces() {
  if (!agentCursorSurfaces) {
    agentCursorSurfaces = new AgentCursorSurfaces({
      rendererFile: path.join(__dirname, 'renderer', 'index.html'),
      log,
    });
  }
  agentCursorSurfaces.sync();
}

function sendAgentCursorCommand(payload: unknown): boolean {
  return agentCursorSurfaces ? agentCursorSurfaces.command(payload) : false;
}

function handleAgentCursorProgress(record: any): void {
  if (!record || record.phase !== 'agent_cursor') return;
  const fields = record.fields || {};
  const kind = String(fields.action || '').trim();
  if (!kind) return;
  const x = Number(fields.x);
  const y = Number(fields.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const leadMs = Number(fields.leadMs);
  const count = Number(fields.count);
  sendAgentCursorCommand({
    kind,
    id: String(fields.id || 'agent'),
    x,
    y,
    ...(Number.isFinite(leadMs) ? { leadMs } : {}),
    ...(fields.button ? { button: String(fields.button) } : {}),
    ...(Number.isFinite(count) ? { count } : {}),
  });
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
  if (CAPSULE_CONTENT_PROTECTED) {
    try {
      overlayWindow.setContentProtection(true);
    } catch (error) {
      log(`overlay content protection unavailable: ${(error as { message?: string })?.message || error}`);
    }
  }
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
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
  createOverlayWindow();
}

const CAPSULE_CONTENT_PROTECTED = true;
const CAPSULE_REVEAL_PHASE = 'pixels_frozen';

function createStageWindow() {
  if (stageWindow && !stageWindow.isDestroyed()) return stageWindow;
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;
  invalidateStageBounds();
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
    try {
      stageWindow.setContentProtection(true);
    } catch (error) {
      log(`stage content protection unavailable: ${(error as { message?: string })?.message || error}`);
    }
  }
  stageWindow.loadFile(path.join(__dirname, 'renderer', 'stage.html'));
  stageWindow.setIgnoreMouseEvents(true, { forward: true });
  stageWindow.webContents.on('did-start-loading', () => stageReadiness.reset());
  stageWindow.webContents.on('console-message', (_e: Electron.Event, level: number, message: string, line: number, sourceId: string) => {
    log(`stage console level=${level} ${sourceId}:${line} ${message}`);
  });
  stageWindow.webContents.on('did-fail-load', (_e: Electron.Event, code: number, desc: string, url: string) => {
    log(`stage did-fail-load code=${code} desc=${desc} url=${url}`);
  });
  stageWindow.webContents.on('preload-error', (_e: Electron.Event, preloadPath: string, error: Error) => {
    log(`stage preload-error path=${preloadPath} error=${error?.message || error}`);
  });
  stageWindow.on('closed', () => {
    stageWindow = null;
    invalidateStageBounds();
    stageReadiness.reset();
  });
  return stageWindow;
}

let stageBoundsCache: { window: Electron.BrowserWindow; bounds: Electron.Rectangle } | null = null;

function stageBounds(): Electron.Rectangle | null {
  if (!stageWindow || stageWindow.isDestroyed()) {
    stageBoundsCache = null;
    return null;
  }
  if (!stageBoundsCache || stageBoundsCache.window !== stageWindow) {
    stageBoundsCache = { window: stageWindow, bounds: stageWindow.getBounds() };
  }
  return stageBoundsCache.bounds;
}

function invalidateStageBounds() {
  stageBoundsCache = null;
}

function liveStageBounds(): Electron.Rectangle {
  return stageBounds() || { x: 0, y: 0, width: 0, height: 0 };
}

function placeStageOnDisplay(display: Electron.Display) {
  const win = createStageWindow();
  const desired = display?.bounds;
  if (!desired) return win;
  const current = stageBounds() || win.getBounds();
  if (
    current.x !== desired.x
    || current.y !== desired.y
    || current.width !== desired.width
    || current.height !== desired.height
  ) {
    win.setBounds(desired);
    invalidateStageBounds();
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
    capsuleTextWidthDip: Number(appearance.capsule_text_width_dip ?? 144),
    capsuleMaxWidthDip: Number(appearance.capsule_max_width_dip ?? 440),
    capsuleInlineGapDip: Number(appearance.capsule_inline_gap_dip ?? 18),
  };
}

function showStage(payload: any = {}) {
  if (payload.selectionSessionToken && selectionSessions.get(payload.selectionSessionToken)?.stageAttached === false) return;
  const win = createStageWindow();
  armTemporaryDismissShortcut();
  const trustedPayload = {
    ...payload,
    selectionVisual: selectionVisualForStage(),
    visualTuning: stageVisualTuningForStage(),
    accentRgb: String(fabricSettings.appearance?.accent_rgb || ''),
  };
  const send = () => {
    if (!win || win.isDestroyed()) return;
    if (payload.selectionSessionToken && selectionSessions.get(payload.selectionSessionToken)?.stageAttached === false) return;
    win.webContents.send('stage:show', trustedPayload);
    if (!win.isVisible()) win.showInactive();
    kickTaskWatch();
  };
  stageReadiness.whenReady(send);
}

type StageUpdatePayload = {
  selectionSessionToken?: string | null;
  taskId?: string | null;
  taskContext?: unknown;
  selectionSource?: unknown;
  objectKind?: unknown;
  targetGeometryKind?: unknown;
  event?: {
    type?: string;
    target?: unknown;
    mode?: string;
    notice?: { message?: string };
    error?: { message?: string };
    outcome?: { verified?: boolean };
    screenPoints?: Array<{ x: number; y: number }>;
    result?: {
      route?: { tier?: string };
      taskId?: string;
      status?: string;
      cardId?: string;
      answer?: string;
      prompt?: string;
      text?: string;
      detail?: string;
      actions?: unknown[];
    };
  };
};

function updateStage(payload: StageUpdatePayload = {}) {
  const type = payload?.event?.type;
  if (payload?.selectionSessionToken && (type === 'RESULT' || type === 'ERROR' || type === 'COMPLETE')) {
    sessionTimeline.finish(payload.selectionSessionToken, {
      outcome: type === 'ERROR' ? 'error' : 'result',
      error: type === 'ERROR' ? String(payload.event?.error?.message || '') : '',
      tier: String(payload.event?.result?.route?.tier || ''),
    });
  }
  safeSurfaceSend('stage', 'stage:update', payload);
  if (type === 'RESULT' || type === 'COMPLETE' || type === 'ERROR') recordConversationTurn(payload, type);
  autoStashResultImage(payload);
  watchTaskFromEvent(payload);
  if (payload.selectionSessionToken && selectionSessions.get(payload.selectionSessionToken)?.stageAttached === false) return;
  const event: { screenPoints?: Array<{ x: number; y: number }> } = payload?.event || {};
  const points = Array.isArray(event.screenPoints) ? event.screenPoints : [];
  if (points.length) {
    const p = points[0];
    const x = Number(p.x);
    const y = Number(p.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
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

function watchTaskFromEvent(payload: StageUpdatePayload = {}) {
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

let taskWatcherInstance: ReturnType<typeof createTaskWatcher> | null = null;

function taskCardSurfaceVisible(): boolean {
  const visible = (win: Electron.BrowserWindow | null) =>
    Boolean(win && !win.isDestroyed() && win.isVisible());
  return visible(stageWindow) || visible(companionWindow) || visible(dashboardWindow);
}

function kickTaskWatch() {
  try { taskWatcherInstance?.kick(); } catch (_) { /* watching must never break a window show */ }
}

function taskWatcher() {
  if (taskWatcherInstance) return taskWatcherInstance;
  taskWatcherInstance = createTaskWatcher({
    log,
    CardModel,
    probeEnabled: taskCardSurfaceVisible,
    probe: async (taskId: string) => {
      const parsed = await runRuntimeBridgePromise(
        { operation: 'status', taskId },
        'agent',
        { target: 'stage', timeoutMs: 8000 },
      );
      return parsed?.task || null;
    },
    onPatch: ({ cardId, selectionSessionToken, patch }: { cardId: string; selectionSessionToken: string; patch: unknown }) => {
      safeSurfaceSend('stage', 'stage:card-patch', { cardId, selectionSessionToken, patch });
      for (const window of [companionWindow, dashboardWindow]) {
        if (window && !window.isDestroyed()) {
          window.webContents.send('stage:card-patch', { cardId, selectionSessionToken, patch });
        }
      }
    },
  });
  return taskWatcherInstance;
}

let conversationStore: ReturnType<typeof createConversationStore> | null = null;
let artifactRuntime: ReturnType<typeof createArtifactRuntime> | null = null;

function conversations() {
  if (!conversationStore) {
    conversationStore = createConversationStore({
      baseDir: path.join(app.getPath('userData'), 'history'),
      deferPersist: true,
      onPersistError: (error: unknown, context: string) => {
        log(`conversation store persist failed context=${context} ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      },
    });
    conversationStore.recoverInterruptedTurns();
  }
  return conversationStore;
}

function flushConversations() {
  try {
    conversationStore?.flush();
  } catch (_) {
    // Shutdown must reach the end: a failed flush cannot be allowed to skip
    // the remaining cleanup.
  }
}

function artifactCommands() {
  if (!artifactRuntime) {
    artifactRuntime = createArtifactRuntime({
      conversationStore: conversations(),
      runBridge: (payload: Record<string, unknown>) => runRuntimeBridgePromise(
        {
          ...payload,
          _figmaRuntimeConnections: figmaRuntime.clientConfigurations(),
        },
        'artifact',
        { target: null, timeoutMs: 120_000 },
      ),
    });
  }
  return artifactRuntime;
}

const pendingQuestions = new Map();

function answerTextFrom(event: {
  type?: string;
  error?: { message?: string };
  outcome?: { verified?: boolean };
  result?: { answer?: string; prompt?: string; text?: string; detail?: string };
} = {}) {
  const r: { answer?: string; prompt?: string; text?: string; detail?: string } = event.result || {};
  if (event.type === 'ERROR') return String(r.answer || event.error?.message || '这次没能完成。');
  if (event.type === 'COMPLETE') {
    return String(r.answer || (event.outcome?.verified ? '已完成，并回读确认过。' : '已完成。'));
  }
  return String(r.answer || r.prompt || r.text || r.detail || '').trim();
}

type SelectionLiveProgress = {
  answer: string;
  thinking: string;
  records: Array<{ phase: string; fields?: Record<string, unknown> }>;
  requestId: string;
  agentSessionId: string;
  trajectory: Array<Record<string, unknown>>;
};
const stageLiveTurns = new Map<string, {
  conversationId: string; turnIndex: number; progress: SelectionLiveProgress;
}>();
const stageLiveFlushTimers = new Map<string, NodeJS.Timeout>();

function notifyConversationChanged(conversationId: string, live?: { turnIndex: number; progress: SelectionLiveProgress }): void {
  const payload = {
    id: conversationId,
    ...(live ? { turnIndex: live.turnIndex, liveProgress: live.progress } : {}),
  };
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('conversations:turn', payload);
  }
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.webContents.send('conversations:turn', payload);
  }
}

function beginStageLiveTurn(token: string, payload: any): void {
  try {
    const question = String(payload?.command || '').trim();
    if (!question) return;
    const entry = selectionSessions.get(token);
    const object: any = entry ? episodeObjectForSession(entry) : {};
    const conversation = conversations().appendTurn({
      question,
      answer: '',
      outcome: '进行中',
      agentSessionId: entry?.taskId,
      hasPendingWork: true,
      object: {
        app: object.app || '',
        windowTitle: object.windowTitle || '',
        elementPath: object.snapshotId || '',
        label: object.label || '',
        annotatedPath: object.source?.annotatedPath || '',
      },
    });
    stageLiveTurns.set(token, {
      conversationId: conversation.id,
      turnIndex: Math.max(0, (Array.isArray(conversation.turns) ? conversation.turns.length : 1) - 1),
      progress: {
        answer: '', thinking: '', records: [], trajectory: [],
        requestId: String(entry?.activeRequestId || ''),
        agentSessionId: String(entry?.taskId || ''),
      },
    });
    notifyConversationChanged(conversation.id);
    log(`conversation live-start ${conversation.id} token=${token} q_len=${question.length}`);
  } catch (error) {
    log(`conversation live-start failed ${error instanceof Error ? error.name : 'Error'}`);
  }
}

function appendStageLiveProgress(token: string, record: any): void {
  const live = stageLiveTurns.get(token);
  if (!live) return;
  try {
    const phase = String(record.phase || '');
    const fields = record.fields || {};
    appendTranscript(live.progress, record);
    if (phase === 'answer_chunk' || phase === 'reasoning_chunk') {
      const chunk = Buffer.from(String(fields.b64 || ''), 'base64').toString('utf8');
      if (!chunk) return;
    } else if (phase === 'loop_started' || phase === 'session_ready') {
      live.progress.agentSessionId = String(fields.sid || fields.session || live.progress.agentSessionId);
    } else if (['tool_call', 'tool_result', 'model_request', 'model_response', 'model_first_chunk', 'plan', 'subagent'].includes(phase)) {
      const key = (item: any) => item.phase === 'tool_call' || item.phase === 'tool_result'
        ? `tool:${String(item.fields?.id || item.fields?.name || '')}`
        : item.phase === 'subagent' || item.phase === 'plan' ? item.phase : 'status';
      const index = live.progress.records.findIndex((item) => key(item) === key(record));
      if (index < 0) live.progress.records.push(record);
      else live.progress.records[index] = record;
    } else return;
    if (stageLiveFlushTimers.has(token)) return;
    stageLiveFlushTimers.set(token, setTimeout(() => {
      stageLiveFlushTimers.delete(token);
      const current = stageLiveTurns.get(token);
      if (!current) return;
      const result = conversations().updateTurn({
        conversationId: current.conversationId,
        turnIndex: current.turnIndex,
        answer: current.progress.answer,
        thinking: current.progress.thinking,
        trajectory: current.progress.trajectory,
        agentSessionId: current.progress.agentSessionId,
      });
      if (result.ok) notifyConversationChanged(current.conversationId, current);
      safeSurfaceSend('stage', 'stage:card-patch', {
        selectionSessionToken: token,
        patch: { liveProgress: current.progress },
      });
    }, 300));
  } catch (error) {
    log(`conversation live-append failed ${error instanceof Error ? error.name : 'Error'}`);
  }
}

function recordConversationTurn(payload: StageUpdatePayload = {}, type: string | undefined = '') {
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
    const object: Partial<ReturnType<typeof episodeObjectForSession>> = entry ? episodeObjectForSession(entry) : {};
    const evidence = {
      capturePath: String((object as any).source?.path || ''),
      annotatedPath: String((object as any).source?.annotatedPath || ''),
      label: String(object.label || ''),
      contentDigest: String((object as any).content || '').slice(0, 1600),
    };

    const result: { route?: { tier?: string }; actions?: unknown[] } = payload?.event?.result || {};
    const live = stageLiveTurns.get(token || '');
    const store = conversations();
    const conversation = live
      ? (() => {
          const eventResult = (payload?.event?.result || {}) as any;
          const verificationPending = Array.isArray(eventResult.receipts)
            && eventResult.receipts.some((receipt: any) => receipt?.status === 'unverified');
          const updated = store.updateTurn({
            conversationId: live.conversationId,
            turnIndex: live.turnIndex,
            answer,
            outcome: type === 'ERROR' ? '失败' : eventResult?.pendingInput ? '等待输入' : eventResult?.loopTerminated ? '失败' : verificationPending ? '待核对' : '已完成',
            agentSessionId: eventResult.agentSessionId || live.progress.agentSessionId,
            runtimeTurn: eventResult.runtimeTurn,
            hasPendingWork: eventResult.hasPendingWork === true || Boolean(eventResult.pendingInput) || verificationPending,
            taskContext: eventResult.taskContext,
            pendingInput: eventResult.pendingInput || null,
            artifacts: Array.isArray(eventResult?.actions)
              ? eventResult.actions.filter((a: any) => a?.artifact).map((a: any) => ({ name: a.label || a.artifact, kind: 'file' }))
              : undefined,
            events: eventResult?.events,
            trajectory: eventResult?.trajectory,
            activities: eventResult?.activities,
            receipts: eventResult?.receipts,
            modelUsage: eventResult?.modelUsage,
            usedBackend: eventResult?.usedBackend,
            timingMs: eventResult?.timingMs,
            thinking: eventResult?.thinking,
            evidence,
          });
          const timer = stageLiveFlushTimers.get(token);
          if (timer) clearTimeout(timer);
          stageLiveFlushTimers.delete(token);
          stageLiveTurns.delete(token || '');
          return updated.conversation || null;
        })()
      : store.appendTurn({
      agentSessionId: (result as any).agentSessionId,
      runtimeTurn: (result as any).runtimeTurn,
      taskContext: (result as any).taskContext,
      question,
      answer,
      outcome: type === 'ERROR' ? '失败' : (type === 'COMPLETE' ? '已完成' : String(result.route?.tier || '')),
      artifacts: Array.isArray(result.actions)
        ? result.actions.filter((a: any) => a?.artifact).map((a: any) => ({ name: a.label || a.artifact, kind: 'file' }))
        : [],
      evidence,
      object: {
        app: object.app || '',
        windowTitle: object.windowTitle || '',
        elementPath: object.snapshotId || '',
        label: object.label || '',
        annotatedPath: object.source?.annotatedPath || '',
      },
    });

    if (!conversation) return;
    log(`conversation + ${conversation.id} type=${type} q_len=${question.length} a_len=${answer.length}`);
    notifyConversationChanged(conversation.id);
  } catch (error) {
    log(`conversation record failed ${error instanceof Error ? error.name : 'Error'}`);
  }
}

ipcMain.handle('conversations:list', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().list(); } catch (_) { return []; }
});
ipcMain.handle('conversations:stats', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) return null;
  try { return conversations().stats(); } catch (_) { return null; }
});
ipcMain.handle('projects:list', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) return [];
  try { return conversations().listProjects(); } catch (_) { return []; }
});
ipcMain.handle('projects:open', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const parent = BrowserWindow.fromWebContents(event.sender) || dashboardWindow || undefined;
  const picked = await dialog.showOpenDialog(parent, {
    title: '打开项目文件夹',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true };
  const project = conversations().registerProject(picked.filePaths[0]);
  return project ? { ok: true, project } : { ok: false, error: 'invalid_project_folder' };
});
ipcMain.handle('projects:pick-files', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const projectRoot = String(raw?.projectRoot || '').trim();
  const parent = BrowserWindow.fromWebContents(event.sender) || dashboardWindow || undefined;
  const picked = await dialog.showOpenDialog(parent, attachmentDialogOptions(projectRoot, raw?.kind === 'folder' ? 'folder' : 'files'));
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, paths: picked.filePaths };
});

function knownProjectRoot(rawRoot: unknown): string | null {
  const requested = path.resolve(String(rawRoot || '').trim());
  if (!String(rawRoot || '').trim()) return null;
  const match = conversations().listProjects().find((project: { root?: string }) =>
    path.resolve(String(project.root || '')).toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (match) return path.resolve(String(match.root || ''));
  const managed = path.join(FABRIC_DATA_DIR, 'worktrees') + path.sep;
  if ((requested + path.sep).startsWith(managed) && fs.existsSync(requested)) return requested;
  return null;
}

function runGitCapture(root: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git.exe', args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value.trim());
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish('');
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: unknown) => { stdout = (stdout + String(chunk)).slice(-512 * 1024); });
    child.on('error', () => finish(''));
    child.on('close', (code: number | null) => finish(code === 0 ? stdout : ''));
  });
}

ipcMain.handle('projects:worktree', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const root = knownProjectRoot(raw?.projectRoot);
  if (!root) return { ok: false, error: '请先打开项目。' };
  const action = String(raw?.action || '');
  if (action !== 'create' && action !== 'remove') return { ok: false, error: 'unknown_worktree_action' };

  const insideRepo = await runGitCapture(root, ['rev-parse', '--is-inside-work-tree']);
  if (insideRepo !== 'true') return { ok: false, error: '这个项目不是 git 仓库，无法开 worktree。' };

  if (action === 'remove') {
    const target = String(raw?.path || '').trim();
    if (!target) return { ok: false, error: 'missing_worktree_path' };
    if (!isManagedWorktreePath(FABRIC_DATA_DIR, target)) {
      return { ok: false, error: 'worktree_outside_managed_dir' };
    }
    const resolved = path.resolve(target);
    const failure = await runGitCaptureCapturingError(root, worktreeRemoveArgs(resolved));
    if (failure !== null) return { ok: false, error: failure };
    await runGitCapture(root, ['worktree', 'prune']);
    log(`worktree removed path=${resolved}`);
    return { ok: true };
  }

  const slug = worktreeSlug(String(raw?.conversationId || ''));
  const target = worktreePathFor(FABRIC_DATA_DIR, root, slug);
  const branch = `mp/${slug}`;
  if (fs.existsSync(target)) return { ok: true, path: target, branch };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let failure = await runGitCaptureCapturingError(root, worktreeAddArgs(target, branch));
  if (failure !== null) {
    failure = await runGitCaptureCapturingError(root, worktreeReuseArgs(target, branch));
    if (failure !== null) return { ok: false, error: failure };
  }
  log(`worktree created path=${target} branch=${branch}`);
  return { ok: true, path: target, branch };
});

function runGitCaptureCapturingError(root: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git.exe', args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish('git 命令超时。');
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: unknown) => { stdout = (stdout + String(chunk)).slice(-256 * 1024); });
    child.stderr?.on('data', (chunk: unknown) => { stderr = (stderr + String(chunk)).slice(-64 * 1024); });
    child.on('error', (error: unknown) => finish(`无法运行 git：${String((error as { message?: string })?.message || error)}`));
    child.on('close', (code: number | null) => {
      if (code === 0) { finish(null); return; }
      finish((stderr.trim() || stdout.trim() || `git 退出码 ${code}`).slice(0, 400));
    });
  });
}

ipcMain.handle('projects:environment', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const root = knownProjectRoot(raw?.projectRoot);
  if (!root) return { ok: false, error: '请先打开项目。' };
  const [branchOutput, unstagedNumstat, stagedNumstat, remoteUrl] = await Promise.all([
    runGitCapture(root, ['status', '--porcelain=v1', '--branch', '-z']),
    runGitCapture(root, ['diff', '--numstat']),
    runGitCapture(root, ['diff', '--cached', '--numstat']),
    runGitCapture(root, ['remote', 'get-url', 'origin']),
  ]);
  const conversationId = String(raw?.conversationId || '').slice(0, 120);
  const conversation = conversationId ? conversations().get(conversationId) : null;
  return {
    ok: true,
    ...parseGitEnvironment({
      root,
      branchOutput,
      numstatOutput: [unstagedNumstat, stagedNumstat].filter(Boolean).join('\n'),
      remoteUrl,
    }),
    sources: sourceLinksFromConversation(conversation),
  };
});

ipcMain.handle('projects:context-menu', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const root = knownProjectRoot(raw?.projectRoot);
  if (!root) return { ok: false, error: '请先打开项目。' };
  const relativePath = String(raw?.path || '').slice(0, 1000);
  const kind = raw?.kind === 'directory' ? 'directory' : 'file';
  let absolutePath = '';
  try { absolutePath = projectPath(root, relativePath); } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const parent = BrowserWindow.fromWebContents(event.sender) || dashboardWindow || undefined;
  return new Promise((resolve) => {
    let resolved = false;
    const complete = (action: string, result: Record<string, unknown> = {}) => {
      if (resolved) return;
      resolved = true;
      resolve({ ok: true, action, path: relativePath, ...result });
    };
    const labels: Record<string, string> = {
      preview: '预览',
      open: kind === 'directory' ? '在文件资源管理器中打开' : '使用默认应用打开',
      reveal: '在文件资源管理器中显示',
      'open-in-browser': '在 Web 浏览器中打开',
      'terminal-here': '在此处打开终端',
      'copy-path': '复制路径',
    };
    const menu = Menu.buildFromTemplate(projectContextActions(kind, relativePath).map((action: string) => ({
      label: labels[action] || action,
      click: async () => {
        try {
          if (action === 'open') {
            const error = await shell.openPath(absolutePath);
            complete(action, error ? { error } : {});
          } else if (action === 'reveal') {
            shell.showItemInFolder(absolutePath);
            complete(action);
          } else if (action === 'open-in-browser') {
            await shell.openExternal(pathToFileURL(absolutePath).href);
            complete(action);
          } else if (action === 'copy-path') {
            clipboard.writeText(absolutePath);
            complete(action);
          } else {
            complete(action, { absolutePath });
          }
        } catch (error) {
          complete(action, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    })));
    menu.popup({ window: parent, callback: () => {
      if (!resolved) complete('dismissed');
    } });
  });
});

ipcMain.handle('projects:tree', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const root = knownProjectRoot(raw?.projectRoot);
  if (!root) return { ok: false, error: '请先打开项目。' };
  try {
    return { ok: true, entries: listProjectDirectory(root, String(raw?.path || '')) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('projects:read-file', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const root = knownProjectRoot(raw?.projectRoot);
  if (!root) return { ok: false, error: '请先打开项目。' };
  try {
    return { ok: true, ...readProjectText(root, String(raw?.path || '')) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('projects:open-path', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const root = knownProjectRoot(raw?.projectRoot);
  if (!root) return { ok: false, error: '请先打开项目。' };
  try {
    const error = await shell.openPath(projectPath(root, String(raw?.path || '')));
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('projects:open-url', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  try {
    const url = new URL(String(raw?.url || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: '只支持 http/https 地址。' };
    await shell.openExternal(url.toString());
    return { ok: true };
  } catch {
    return { ok: false, error: '网页地址无效。' };
  }
});

ipcMain.handle('window:command', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_window_sender' };
  const command = String(raw?.command || '').trim();
  const window = BrowserWindow.fromWebContents(event.sender) || dashboardWindow;
  if (!window || window.isDestroyed()) return { ok: false, error: 'dashboard_unavailable' };
  try {
    if (command === 'undo') event.sender.undo();
    else if (command === 'redo') event.sender.redo();
    else if (command === 'cut') event.sender.cut();
    else if (command === 'copy') event.sender.copy();
    else if (command === 'paste') event.sender.paste();
    else if (command === 'select-all') event.sender.selectAll();
    else if (command === 'zoom-in') event.sender.setZoomFactor(Math.min(2, event.sender.getZoomFactor() + 0.1));
    else if (command === 'zoom-out') event.sender.setZoomFactor(Math.max(0.6, event.sender.getZoomFactor() - 0.1));
    else if (command === 'zoom-reset') event.sender.setZoomFactor(1);
    else if (command === 'fullscreen') window.setFullScreen(!window.isFullScreen());
    else if (command === 'close-window') window.close();
    else if (command === 'diagnostics') {
      const error = await shell.openPath(app.getPath('logs'));
      if (error) return { ok: false, error };
    } else if (command === 'changelog') {
      await shell.openExternal('https://github.com/Wang-auspicious/Magic-Pointer/releases');
    } else if (command === 'about') {
      return { ok: true, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome };
    } else return { ok: false, error: 'unknown_window_command' };
    return { ok: true, zoomFactor: event.sender.getZoomFactor(), fullscreen: window.isFullScreen() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

function normalizedBrowserBounds(raw: any = {}): { x: number; y: number; width: number; height: number } {
  const content = dashboardWindow?.getContentBounds() || { width: 1320, height: 860 };
  const x = Math.max(0, Math.min(Math.round(Number(raw?.x) || 0), content.width));
  const y = Math.max(0, Math.min(Math.round(Number(raw?.y) || 0), content.height));
  const width = Math.max(1, Math.min(Math.round(Number(raw?.width) || 1), Math.max(1, content.width - x)));
  const height = Math.max(1, Math.min(Math.round(Number(raw?.height) || 1), Math.max(1, content.height - y)));
  return { x, y, width, height };
}

function emitBrowserViewState(extra: Record<string, unknown> = {}) {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  const webContents = dashboardBrowserView?.webContents;
  dashboardWindow.webContents.send('browser:view-state', {
    url: webContents && !webContents.isDestroyed() ? webContents.getURL() : '',
    title: webContents && !webContents.isDestroyed() ? webContents.getTitle() : '',
    canGoBack: Boolean(webContents && !webContents.isDestroyed() && webContents.navigationHistory.canGoBack()),
    canGoForward: Boolean(webContents && !webContents.isDestroyed() && webContents.navigationHistory.canGoForward()),
    loading: Boolean(webContents && !webContents.isDestroyed() && webContents.isLoading()),
    ...extra,
  });
}

function destroyDashboardBrowserView() {
  const view = dashboardBrowserView;
  dashboardBrowserView = null;
  if (!view) return;
  try { dashboardWindow?.contentView.removeChildView(view); } catch (_) {}
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch (_) {}
}

function ensureDashboardBrowserView() {
  if (dashboardBrowserView && !dashboardBrowserView.webContents.isDestroyed()) return dashboardBrowserView;
  if (!dashboardWindow || dashboardWindow.isDestroyed()) throw new Error('dashboard_unavailable');
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: 'persist:magic-pointer-browser',
    },
  });
  dashboardWindow.contentView.addChildView(view);
  securityHardening.registerBrowserContents(view.webContents);
  dashboardBrowserView = view;
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#292927' : '#f7f6f2');
  view.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    try { shell.openExternal(normalizeBrowserUrl(url)); } catch (_) {}
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event: Electron.Event, url: string) => {
    try { normalizeBrowserUrl(url); } catch (_) { event.preventDefault(); }
  });
  view.webContents.on('did-start-loading', () => emitBrowserViewState({ loading: true }));
  view.webContents.on('did-stop-loading', () => emitBrowserViewState({ loading: false }));
  view.webContents.on('did-navigate', () => emitBrowserViewState());
  view.webContents.on('did-navigate-in-page', () => emitBrowserViewState());
  view.webContents.on('page-title-updated', () => emitBrowserViewState());
  view.webContents.on('context-menu', (_event: Electron.Event, params: any) => {
    const currentUrl = view.webContents.getURL();
    const template: any[] = [];
    if (params?.linkURL) {
      template.push({
        label: '在 Web 浏览器中打开链接',
        click: () => { try { shell.openExternal(normalizeBrowserUrl(params.linkURL)); } catch (_) {} },
      });
      template.push({ label: '复制链接地址', click: () => clipboard.writeText(String(params.linkURL || '')) });
      template.push({ type: 'separator' });
    }
    if (params?.selectionText) template.push({ label: '复制', role: 'copy' });
    template.push(
      { label: '后退', enabled: view.webContents.navigationHistory.canGoBack(), click: () => view.webContents.navigationHistory.goBack() },
      { label: '前进', enabled: view.webContents.navigationHistory.canGoForward(), click: () => view.webContents.navigationHistory.goForward() },
      { label: '重新加载', click: () => view.webContents.reload() },
      { type: 'separator' },
      { label: '在 Web 浏览器中打开当前页面', enabled: Boolean(currentUrl), click: () => { if (currentUrl) shell.openExternal(currentUrl); } },
      { label: '复制当前页面地址', enabled: Boolean(currentUrl), click: () => clipboard.writeText(currentUrl) },
    );
    Menu.buildFromTemplate(template).popup({ window: dashboardWindow || undefined });
  });
  view.webContents.on('destroyed', () => {
    if (dashboardBrowserView === view) dashboardBrowserView = null;
  });
  return view;
}

ipcMain.handle('browser:view-open', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_browser_sender' };
  try {
    const url = normalizeBrowserUrl(String(raw?.url || ''));
    const view = ensureDashboardBrowserView();
    view.setBounds(normalizedBrowserBounds(raw?.bounds));
    await view.webContents.loadURL(url);
    emitBrowserViewState();
    return { ok: true, url: view.webContents.getURL() || url };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('browser:view-resize', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_browser_sender' };
  if (!dashboardBrowserView || dashboardBrowserView.webContents.isDestroyed()) return { ok: false, error: 'browser_view_closed' };
  dashboardBrowserView.setBounds(normalizedBrowserBounds(raw?.bounds));
  return { ok: true };
});

ipcMain.handle('browser:view-command', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_browser_sender' };
  const view = dashboardBrowserView;
  const command = String(raw?.command || '');
  if (command === 'close') {
    destroyDashboardBrowserView();
    return { ok: true };
  }
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'browser_view_closed' };
  try {
    if (command === 'back' && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
    else if (command === 'forward' && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
    else if (command === 'reload') view.webContents.reload();
    else if (command === 'stop') view.webContents.stop();
    else if (command === 'external') await shell.openExternal(view.webContents.getURL());
    else return { ok: false, error: 'unknown_browser_command' };
    emitBrowserViewState();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

function runProjectPowerShell(workingDirectory: string, command: string): Promise<{ ok: boolean; code?: number | null; output?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: unknown) => (current + String(chunk)).slice(-512 * 1024);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: unknown) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: unknown) => { stderr = append(stderr, chunk); });
    child.on('error', (error: Error) => resolve({ ok: false, error: error.message }));
    child.on('close', (code: number | null) => resolve({
      ok: code === 0,
      code,
      output: [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n'),
      ...(code === 0 ? {} : { error: `命令退出码 ${code}` }),
    }));
  });
}

ipcMain.handle('projects:run-command', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_project_sender' };
  const root = knownProjectRoot(raw?.projectRoot);
  const command = String(raw?.command || '').trim().slice(0, 8000);
  if (!root) return { ok: false, error: '请先打开项目。' };
  if (!command) return { ok: false, error: '请输入命令。' };
  try {
    const relativeDirectory = String(raw?.path || '').trim().slice(0, 1000);
    const workingDirectory = relativeDirectory ? projectPath(root, relativeDirectory) : root;
    if (!fs.statSync(workingDirectory).isDirectory()) return { ok: false, error: '终端目录不是文件夹。' };
    return runProjectPowerShell(workingDirectory, command);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
const restoredContextUsage = new Map<string, { mtimeMs: number; usage: Promise<any> }>();

async function restoreConversationContext(conversation: any) {
  let turn = conversation.turns?.at(-1);
  if (!turn || !conversation.agentSessionId) return conversation;
  const sessionId = conversation.agentSessionId;
  const sessionPath = path.join(FABRIC_DATA_DIR, 'agent-sessions', `${sessionId}.jsonl`);
  let mtimeMs: number;
  try { mtimeMs = (await fs.promises.stat(sessionPath)).mtimeMs; } catch { return conversation; }
  if (turn.pendingInput || turn.outcome === '可恢复' || turn.outcome === '等待输入') {
    try {
      const status = await handleSessionRead({ action: 'status', sessionId }, FABRIC_DATA_DIR);
      if (status.ok && 'pendingInput' in status
        && (status.pendingInput
          ? status.pendingInput.requestId !== turn.pendingInput?.requestId
          : Boolean(turn.pendingInput))) {
        const trajectory = (turn.trajectory || []).map((item: any) => item.kind === 'tool' && item.callId === status.lastInputAnswer?.requestId
          ? { ...item, result: status.lastInputAnswer.message.content, state: 'done', isError: false } : item);
        conversations().updateTurn({ conversationId: conversation.id, pendingInput: status.pendingInput || null, trajectory });
        conversations().flush();
        turn = { ...turn, pendingInput: status.pendingInput || undefined, trajectory };
        conversation = { ...conversation, turns: [...conversation.turns.slice(0, -1), turn] };
      }
    } catch { /* Leave an unanswered card retryable if the runtime cannot be read. */ }
  }
  if (typeof turn.modelUsage?.contextTokens === 'number') return conversation;
  let cached = restoredContextUsage.get(sessionId);
  if (!cached || cached.mtimeMs !== mtimeMs) {
    cached = { mtimeMs, usage: handleSessionRead(
      { action: 'usage', sessionId }, FABRIC_DATA_DIR,
    ).then((result: any) => result?.ok ? result.contextUsage : null) };
    restoredContextUsage.set(sessionId, cached);
  }
  const usage = await cached.usage;
  if (!usage) return conversation;
  return { ...conversation, turns: [...conversation.turns.slice(0, -1), {
    ...turn, modelUsage: { ...turn.modelUsage, ...usage },
  }] };
}

ipcMain.handle('conversations:get', async (event: Electron.IpcMainInvokeEvent, id: string) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return null;
  try {
    const conversation = conversations().get(id);
    if (!conversation) return null;
    const live = [...stageLiveTurns.values(), ...activeConversations.values()]
      .find((run) => run.conversationId === id);
    if (!live) return await restoreConversationContext(conversation);
    return {
      ...conversation,
      turns: conversation.turns.map((turn: any, index: number) => index === live.turnIndex
        ? { ...turn, answer: live.progress.answer, thinking: live.progress.thinking, liveProgress: live.progress }
        : turn),
    };
  } catch (_) { return null; }
});
ipcMain.handle('conversations:set-project', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  const id = String(raw.id || '');
  const conversation = conversations().get(id);
  if (!conversation) return { ok: false, error: '找不到这条对话。' };
  if ([...stageLiveTurns.values()].some((run) => run.conversationId === id)
    || [...activeConversations.values()].some((run: any) => run.agentSessionId === conversation.agentSessionId)) {
    return { ok: false, error: '请等当前任务停止后再切换项目。' };
  }
  const root = String(raw.root || '').trim();
  const registered = root ? knownProjectRoot(root) : '';
  if (root && !registered) return { ok: false, error: '请先打开目标项目文件夹。' };
  try {
    const result = conversations().setProject(id, registered);
    if (result.ok) notifyConversationChanged(id);
    return result;
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('conversations:branch', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  const id = String(raw?.id || '').slice(0, 120);
  const turnIndex = Number(raw?.turnIndex);
  try {
    const source = conversations().get(id);
    const turn = source?.turns?.[turnIndex];
    if (!turn || !Number.isInteger(turnIndex)) return { ok: false, error: 'invalid_conversation_or_turn' };
    let runtime: { agentSessionId: string; taskContext?: unknown } | undefined;
    if (source?.agentSessionId) {
      const throughTurn = Number(turn.runtimeTurn);
      if (!Number.isInteger(throughTurn) && turnIndex !== source.turns.length - 1) {
        return { ok: false, error: '这条旧记录未保存执行轮号；请从最后一轮创建完整分支。' };
      }
      const childSessionId = `agent-${crypto.randomUUID()}`;
      const forked = await new Promise<any>((resolve) => runRuntimeBridge({
        action: 'fork', sessionId: source.agentSessionId, childSessionId,
        ...(Number.isInteger(throughTurn) && throughTurn > 0 ? { throughTurn } : {}),
      }, 'agent_session', 'dashboard', { onComplete: resolve }));
      if (forked?.ok !== true) return forked;
      runtime = { agentSessionId: forked.sessionId, taskContext: forked.taskContext };
    }
    const conversation = conversations().branch(id, turnIndex, runtime);
    if (!conversation) return { ok: false, error: 'invalid_conversation_or_turn' };
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('conversations:turn', { id: conversation.id });
    }
    return { ok: true, conversation };
  } catch (_) { return { ok: false, error: 'store_failed' }; }
});
ipcMain.handle('conversations:export', async (event: Electron.IpcMainInvokeEvent, id: string) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_conversation_sender' };
  const conversation = conversations().get(String(id || '').slice(0, 120));
  if (!conversation) return { ok: false, error: '找不到这条对话。' };
  const printableTitle = Array.from(String(conversation.title || 'session-log'), (char) =>
    char.charCodeAt(0) < 32 ? '-' : char).join('');
  const safeTitle = printableTitle.replace(/[<>:"/\\|?*]/g, '-').slice(0, 80);
  const parent = BrowserWindow.fromWebContents(event.sender) || dashboardWindow || undefined;
  const picked = await dialog.showSaveDialog(parent, {
    title: '导出 Session log',
    defaultPath: `${safeTitle || 'session-log'}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(picked.filePath, `${JSON.stringify(conversation, null, 2)}\n`, 'utf8');
  return { ok: true, path: picked.filePath };
});
ipcMain.handle('conversations:pick-workspace', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_conversation_sender' };
  const parent = BrowserWindow.fromWebContents(event.sender) || dashboardWindow || undefined;
  const picked = await dialog.showOpenDialog(parent, {
    title: '选择项目文件夹（Agent 将在这里读写与执行）',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, path: picked.filePaths[0] };
});
ipcMain.handle('conversations:send', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isConversationSender(event, dashboardWindow, companionWindow)) {
    return { ok: false, error: 'unauthorized_conversation_sender' };
  }
  return sendConversation(raw, event.sender);
});

const inputResponseRuns = new Set<string>();

ipcMain.handle('conversations:respond', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isConversationSender(event, dashboardWindow, companionWindow)) return { ok: false, accepted: false, error: 'unauthorized_conversation_sender' };
  return respondConversation(raw, event.sender);
});

function conversationForSelection(token: string): any {
  const selection = selectionSessions.get(token);
  if (!selection) return null;
  const live = stageLiveTurns.get(token);
  if (live) return conversations().get(live.conversationId);
  const sessionId = activeSessionAgentIds.get(token) || selection.taskId;
  const summary = conversations().list().find((item: any) => item.agentSessionId === sessionId);
  return summary ? conversations().get(summary.id) : null;
}

ipcMain.handle('stage:respond-input', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return { ok: false, accepted: false, error: 'unauthorized_renderer' };
  const conversation = conversationForSelection(String(raw.selectionSessionToken || ''));
  if (!conversation) return { ok: false, accepted: false, error: 'unknown_selection_task' };
  return respondConversation({ ...raw, conversationId: conversation.id }, event.sender);
});

ipcMain.handle('stage:history-sources', (event: Electron.IpcMainInvokeEvent) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return { ok: false, error: 'unauthorized_renderer' };
  return conversations().list().map((item: { id: string; title: string }) => ({ id: item.id, title: item.title }));
});

ipcMain.handle('stage:open-artifact', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return { ok: false, error: 'unauthorized_renderer' };
  const conversation = conversationForSelection(String(raw.selectionSessionToken || ''));
  if (!conversation) return { ok: false, error: 'unknown_selection_task' };
  const artifactId = String(raw.artifactId || '');
  const result = await artifactCommands().read({ conversationId: conversation.id, artifactId });
  if (result.ok !== true) return result;
  showDashboard({ view: 'chat', conversationId: conversation.id, artifactId });
  return { ok: true, conversationId: conversation.id, artifactId };
});

async function respondConversation(raw: any = {}, sender?: Electron.WebContents): Promise<any> {
  const conversationId = String(raw.conversationId || '');
  const conversation = conversations().get(conversationId);
  if (!conversation?.agentSessionId || !conversation.turns?.length) return { ok: false, accepted: false, error: 'unknown_conversation' };
  if (inputResponseRuns.has(conversationId) || [...activeConversations.values()].some(run => run.conversationId === conversationId)) {
    return { ok: false, accepted: false, error: 'input_response_in_progress' };
  }
  inputResponseRuns.add(conversationId);
  try {
    const status = await handleSessionRead({ action: 'status', sessionId: conversation.agentSessionId }, FABRIC_DATA_DIR);
    if (!status.ok) throw new Error(String(status.error || 'Session unavailable'));
    const last = conversation.turns[conversation.turns.length - 1];
    const requestId = String(raw.requestId || status.pendingInput?.requestId || '');
    if (requestId && status.answeredInputIds?.includes(requestId)) {
      if (last.pendingInput && (!status.pendingInput || last.pendingInput.requestId === requestId)) {
        const trajectory = (last.trajectory || []).map((item: any) => item.kind === 'tool' && item.callId === status.lastInputAnswer?.requestId
          ? { ...item, result: status.lastInputAnswer.message.content, state: 'done', isError: false } : item);
        conversations().updateTurn({ conversationId, pendingInput: null, trajectory });
        conversations().flush();
        notifyConversationChanged(conversationId);
      }
      return { ...last, ok: !last.failed, accepted: true, alreadyAccepted: true, active: false,
        conversationId, turnIndex: conversation.turns.length - 1 };
    }
    if (!requestId || status.pendingInput?.requestId !== requestId) {
      return { ok: false, accepted: false, error: 'pending_input_mismatch' };
    }
    return await sendConversation({ ...raw, question: '', requestId: raw.requestToken,
      inputResponse: { requestId, response: raw.response }, conversationId }, sender);
  } catch (error) {
    return { ok: false, accepted: false, error: error instanceof Error ? error.message : String(error) };
  } finally { inputResponseRuns.delete(conversationId); }
}

async function sendConversation(raw: any = {}, sender?: Electron.WebContents): Promise<any> {
  const inputResponse = raw?.inputResponse;
  const question = String(raw?.question || '').trim();
  if (!question && !inputResponse) return { ok: false, error: '问题不能为空。' };
  if (question.length > 12000) return { ok: false, error: '问题最多 12000 字，请缩短后重试。' };
  const conversationId = String(raw?.conversationId || '').trim().slice(0, 120);
  const permissionPreset = String(raw?.permissionPreset || 'workspace-write').trim().slice(0, 40);
  const effort = normalizeConversationEffort(raw?.effort);
  const requestId = String(raw?.requestId || crypto.randomUUID()).trim().slice(0, 120) || crypto.randomUUID();
  const workspaceRoot = String(raw?.workspaceRoot || '').trim();
  const attachments = Array.isArray(raw?.attachments)
    ? [...new Set(raw.attachments
        .map((item: unknown) => String(item || '').trim())
        .filter(Boolean)
        .map((item: string) => path.resolve(item)))].slice(0, 32)
    : [];
  let existing = conversationId ? conversations().get(conversationId) : null;
  if (inputResponse && !existing?.turns?.length) return { ok: false, accepted: false, error: 'unknown_conversation' };
  const grantNow = sanitizePermissionRule(raw?.permissionGrant);
  const denyNow = sanitizePermissionRule(raw?.permissionDeny);
  const onceNow = sanitizePermissionRule(raw?.permissionGrantOnce);
  if (existing && (grantNow || denyNow)) {
    const recorded = conversations().recordPermissionDecision({
      conversationId: existing.id,
      grant: grantNow,
      deny: denyNow,
    });
    if (!recorded.ok || !recorded.conversation) {
      return { ok: false, error: 'permission_decision_not_persisted' };
    }
    existing = recorded.conversation;
    notifyConversationChanged(existing.id);
  }
  const threadGrants = [...new Set([...(Array.isArray(existing?.permissionGrants) ? existing!.permissionGrants as string[] : []), ...(grantNow ? [grantNow] : [])])];
  const threadDenials = [...new Set([...(Array.isArray(existing?.permissionDenials) ? existing!.permissionDenials as string[] : []), ...(denyNow ? [denyNow] : [])])];
  // without one, a thread that already has a root keeps it (no global bleed).
  const effectiveWorkspaceRoot = resolveConversationWorkspace(
    workspaceRoot,
    existing?.workspaceRoot,
  );
  const effectiveAgentSessionId = studioConversationSessionId({
    existing: existing?.agentSessionId,
    conversationId,
  });
  const capturedAtMs = Date.now();
  const rawTaskInput = raw?.taskInput && typeof raw.taskInput === 'object' && !Array.isArray(raw.taskInput)
    ? { ...raw.taskInput }
    : {
        inputId: `input:studio:${requestId}`,
        taskId: effectiveAgentSessionId,
        target: 'next-step',
        instruction: question,
        referenceUpdates: [],
        sourceIds: [],
        timeline: [],
        capturedAtMs,
      };
  if (Array.isArray(rawTaskInput.sourceIds)) {
    rawTaskInput.sourceIds = rawTaskInput.sourceIds.map((value: unknown) => {
      const sourceId = String(value || '').trim();
      const prefix = 'source:attachment:';
      if (!sourceId.startsWith(prefix)) return sourceId;
      const filePath = sourceId.slice(prefix.length).trim();
      return filePath
        ? `${prefix}${path.resolve(filePath).replace(/\\/g, '/')}`
        : sourceId;
    });
  }
  let taskInput: Record<string, unknown> | undefined;
  try {
    taskInput = inputResponse ? undefined : TaskSources.bindConversationTaskInput(rawTaskInput, {
      taskId: effectiveAgentSessionId,
      instruction: question,
      attachments,
      capturedAtMs,
    });
  } catch (error: any) {
    return { ok: false, error: `invalid_task_input: ${String(error?.message || error)}` };
  }
  const modelRuntime = activeModelRuntimeConfig();
  const hadPendingWork = existing?.hasPendingWork === true;
  const payload = {
    question,
    turns: bridgeHistoryTurns(existing?.turns),
    object: existing?.object || {},
    modelRuntime,
    permissionPreset,
    effort,
    requestId,
    attachments,
    taskInput,
    ...(inputResponse ? { inputResponse } : {}),
    ...(conversationId ? { conversationId } : {}),
    agentSessionId: effectiveAgentSessionId,
    _figmaRuntimeConnections: figmaRuntime.clientConfigurations().filter(
      (connection: { taskId: string }) => connection.taskId === effectiveAgentSessionId,
    ),
    workspaceRoot: effectiveWorkspaceRoot || '',
    ...(threadGrants.length ? { permissionGrants: threadGrants } : {}),
    ...(threadDenials.length ? { permissionDenials: threadDenials } : {}),
    ...(onceNow ? { permissionGrantOnce: [onceNow] } : {}),
  };
  const conversation = inputResponse ? existing! : conversations().appendTurn({
    conversationId: existing?.id,
    newConversation: !existing,
    capturedAt: capturedAtMs,
    question,
    answer: '',
    outcome: '进行中',
    agentSessionId: effectiveAgentSessionId,
    hasPendingWork: true,
    modelId: String(modelRuntime?.model || '').trim() || undefined,
    object: existing?.object || {},
    workspaceRoot: effectiveWorkspaceRoot || undefined,
    permissionGrant: grantNow || undefined,
    permissionDeny: denyNow || undefined,
    permissionGrantOnce: onceNow || undefined,
  });
  const turnIndex = conversation.turns.length - 1;
  const previousTurn = inputResponse ? { ...conversation.turns[turnIndex] } : null;
  const priorTrajectory = (previousTurn?.trajectory || []).map((item: any) => ({ ...item }));
  const turnOffset = Math.max(0, ...priorTrajectory.map((item: any) => Number(item.turn) || 0));
  const continuationTrajectory = (items: any[]) => [...priorTrajectory, ...items.map(item => (
    item.turn ? { ...item, turn: Number(item.turn) + turnOffset } : item
  ))];
  let inputAccepted = false;
  const acceptInput = (answer?: any) => {
    if (!inputResponse || inputAccepted && !answer) return;
    inputAccepted = true;
    if (answer?.requestId === inputResponse.requestId && typeof answer.message?.content === 'string') {
      for (const entries of [priorTrajectory, progress.trajectory]) {
        const entry = entries.find((item: any) => item.kind === 'tool' && item.callId === inputResponse.requestId);
        if (entry) Object.assign(entry, { result: answer.message.content, state: 'done', isError: false });
      }
    }
    conversations().updateTurn({ conversationId: conversation.id, turnIndex, pendingInput: null, outcome: '进行中', trajectory: progress.trajectory });
    conversations().flush();
    notifyConversationChanged(conversation.id);
  };
  const progress: SelectionLiveProgress = {
    answer: '', thinking: '', trajectory: priorTrajectory.map((item: any) => ({ ...item })), records: [],
    requestId, agentSessionId: effectiveAgentSessionId,
  };
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  const flushProgress = () => {
    progressTimer = null;
    conversations().updateTurn({ conversationId: conversation.id, turnIndex,
      answer: progress.answer, thinking: progress.thinking, trajectory: progress.trajectory,
      agentSessionId: progress.agentSessionId });
    notifyConversationChanged(conversation.id, { turnIndex, progress });
  };
  notifyConversationChanged(conversation.id);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (parsed: any) => {
      if (finished) return;
      finished = true;
      if (parsed?.accepted === true) acceptInput(parsed.inputAnswer);
      if (activeConversations.get(requestId)?.forcedStop) {
        parsed = { ...parsed, ok: false, loopTerminated: true,
          loopTerminatedReason: 'user_interrupt', hasPendingWork: true };
      }
      activeConversations.delete(requestId);
      if (progressTimer !== null) clearTimeout(progressTimer);
      progressTimer = null;
      if (inputResponse && !inputAccepted) {
        resolve({ ...parsed, ok: false, accepted: false, conversationId: conversation.id, turnIndex });
        return;
      }
      const failed = parsed?.ok !== true || !String(parsed?.answer || '').trim();
      const terminated = parsed?.loopTerminated === true || Boolean(parsed?.loopTerminatedReason);
      const stopped = parsed?.loopTerminatedReason === 'user_interrupt';
      const verificationPending = Array.isArray(parsed?.receipts)
        && parsed.receipts.some((receipt: any) => receipt?.status === 'unverified');
      const error = failed ? conversationFailureMessage(parsed) : '';
      const settled = {
        ...parsed,
        ok: !failed,
        conversationId: conversation.id,
        turnIndex,
        ...(inputResponse ? { accepted: inputAccepted } : {}),
        agentSessionId: parsed?.agentSessionId || progress.agentSessionId,
        hasPendingWork: verificationPending || (typeof parsed?.hasPendingWork === 'boolean'
          ? parsed.hasPendingWork : failed || terminated || Boolean(parsed?.pendingInput)),
        answer: String(parsed?.answer || progress.answer || previousTurn?.answer || ''),
        thinking: String(parsed?.thinking || progress.thinking || previousTurn?.thinking || ''),
        trajectory: Array.isArray(parsed?.trajectory) ? continuationTrajectory(parsed.trajectory) : progress.trajectory,
        ...(failed ? { error, errorCode: parsed?.error || (parsed?.ok === true ? 'empty_answer' : 'missing_bridge_error'), exitCode: parsed?.code } : {}),
      };
      conversations().updateTurn({
        ...settled, turnIndex,
        outcome: stopped ? '已停止' : failed || terminated ? '失败' : parsed?.pendingInput ? '等待输入' : verificationPending ? '待核对' : '已完成',
        failed: failed || terminated,
        error: error || (terminated ? String(parsed?.loopTerminatedReason || '') : ''),
        pendingInput: parsed?.pendingInput || null,
      });
      conversations().flush();
      notifyConversationChanged(conversation.id);
      resolve(settled);
    };
    const modelCommand = /^\/model +(\S[\s\S]*)$/i.exec(question);
    if (modelCommand) {
      void selectRuntimeModel(modelCommand[1]).then((selected) => finish(selected?.ok === true
        ? { ...selected, command: { type: 'model', model: selected.model },
          answer: `默认模型已切换为 ${selected.model}，下一次发送即生效。`, hasPendingWork: hadPendingWork }
        : selected));
      return;
    }
    const child = runRuntimeBridge(payload, 'conversation', 'dashboard', {
      timeoutMs: 120_000,
      onProgress: (record: any) => {
        if (record?.phase === 'user_input_accepted') {
          let answer;
          try { answer = JSON.parse(Buffer.from(record.fields?.b64 || '', 'base64').toString('utf8')); } catch { /* Final response repeats the durable answer. */ }
          acceptInput(answer);
        }
        if (turnOffset && record?.fields?.turn) record = { ...record, fields: { ...record.fields, turn: String(Number(record.fields.turn) + turnOffset) } };
        handleAgentCursorProgress(record);
        const sid = sessionIdFromRecord(record);
        const entry = sid ? activeConversations.get(requestId) : null;
        if (sid && entry) entry.agentSessionId = sid;
        if (sid) progress.agentSessionId = sid;
        if (appendTranscript(progress, record) && progressTimer === null) {
          progressTimer = setTimeout(flushProgress, 300);
        }
        if (sender && !sender.isDestroyed()) sender.send('conversations:progress', {
          requestId, conversationId: conversation.id, turnIndex,
          record,
        });
      },
      onComplete: finish,
    });
    if (!child) finish({ ok: false, error: '对话服务没有启动。' });
    else if (!finished) activeConversations.set(requestId, { child, agentSessionId: effectiveAgentSessionId,
      conversationId: conversation.id, turnIndex, progress });
  });
}

function initializeContextTrackers() {
  contextTrackerRuntime = createContextTrackerRuntime({
    loadTrackers: () => fabricSettings.context_trackers || [],
    persistTrackers: (trackers: unknown[]) => {
      const next = { ...fabricSettings, context_trackers: trackers };
      fabricSettingsStore!.save(next);
      fabricSettings = next;
    },
    runTask: (request: any) => sendConversation(buildContextTrackerConversationRequest(request)),
    onError: (error: unknown, trackerId: string) => log(`material tracker ${trackerId}: ${String(error)}`),
  });
  void contextTrackerRuntime.start().catch((error: unknown) => log(`material trackers: ${String(error)}`));
}

ipcMain.handle('context-trackers:list', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  if (!contextTrackerRuntime) return { ok: false, error: '材料关注尚未就绪。' };
  return { ok: true, trackers: contextTrackerRuntime.list() };
});
ipcMain.handle('context-trackers:set-enabled', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  if (!contextTrackerRuntime) return { ok: false, error: '材料关注尚未就绪。' };
  try {
    const tracker = contextTrackerRuntime.setEnabled(String(raw.trackerId || ''), raw.enabled === true);
    return tracker ? { ok: true, tracker } : { ok: false, error: '找不到这项任务。' };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('context-trackers:remove', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  if (!contextTrackerRuntime) return { ok: false, error: '材料关注尚未就绪。' };
  try {
    return contextTrackerRuntime.remove(String(raw.trackerId || ''))
      ? { ok: true } : { ok: false, error: '找不到这项任务。' };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('context-trackers:material', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  if (!contextTrackerRuntime) return { ok: false, error: '材料关注尚未就绪。' };
  try {
    const conversation = conversations().get(String(raw.conversationId || ''));
    const sources = conversation?.taskContext?.sources;
    const source = Array.isArray(sources) ? sources.find((item: any) => item.sourceId === raw.sourceId) : null;
    if (!source?.identity?.absolutePath) return { ok: false, error: '请选择本任务的本机文件或文件夹。' };
    const materialPath = path.resolve(source.identity.absolutePath).replace(/\\/g, '/');
    const existing = contextTrackerRuntime.list().find((tracker: any) => (
      tracker.sourceIds.includes(`source:attachment:${materialPath}`) || tracker.folderRoot === materialPath
    ));
    if (raw.action === 'stop') {
      if (existing) contextTrackerRuntime.setEnabled(existing.trackerId, false);
    } else if (raw.action === 'follow') {
      const tracker = createMaterialTracker({
        source: { identity: { absolutePath: materialPath } },
        task: String(raw.task || ''), cadence: raw.cadence,
        trackerId: existing?.trackerId || crypto.randomUUID(),
        isDirectory: fs.statSync(materialPath).isDirectory(),
      });
      contextTrackerRuntime.upsert(tracker);
    } else if (raw.action !== 'get') return { ok: false, error: '未知材料关注操作。' };
    return { ok: true, tracker: contextTrackerRuntime.list().find((tracker: any) => (
      tracker.sourceIds.includes(`source:attachment:${materialPath}`) || tracker.folderRoot === materialPath
    )) || null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('conversations:stop', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isConversationSender(event, dashboardWindow, companionWindow)) {
    return { ok: false, error: 'unauthorized_renderer' };
  }
  const requestId = String(raw?.requestId || '').trim().slice(0, 120);
  const selectionRun = [...stageLiveTurns.entries()].find(([, run]) => run.progress.requestId === requestId);
  if (selectionRun) {
    cancelSessionChild(selectionRun[0]);
    return { ok: true, sessionId: selectionRun[1].progress.agentSessionId };
  }
  const entry = activeConversations.get(requestId);
  const plan = planConversationStop({ requestId, agentSessionId: entry?.agentSessionId });
  if (plan.action !== 'cancel') return { ok: false, error: plan.reason };
  requestGracefulAgentCancel(plan.sessionId);
  setTimeout(() => {
    try {
      if (activeConversations.get(requestId) === entry && entry?.child && !entry.child.killed) {
        entry.forcedStop = true;
        entry.child.kill();
      }
    } catch (_) {}
  }, GRACEFUL_CANCEL_GRACE_MS);
  log(`conversation stop requested id=${requestId} session=${plan.sessionId}`);
  return { ok: true, sessionId: plan.sessionId };
});

ipcMain.handle('conversations:subagents', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isConversationSender(event, dashboardWindow, companionWindow)) return { ok: false, error: 'unauthorized_renderer' };
  const conversation = conversations().get(String(raw.conversationId || ''));
  if (!conversation?.agentSessionId) return { ok: true, tasks: [] };
  try {
    return { ok: true, tasks: await readBackgroundAgents(path.join(FABRIC_DATA_DIR, 'agent-sessions'), conversation.agentSessionId) };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});

ipcMain.handle('conversations:respond-subagent', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isConversationSender(event, dashboardWindow, companionWindow)) return { ok: false, error: 'unauthorized_renderer' };
  const conversation = conversations().get(String(raw.conversationId || ''));
  if (!conversation?.agentSessionId) return { ok: false, error: 'unknown_subagent' };
  try {
    return await runRuntimeBridgePromise({ action: 'subagent-respond', sessionId: String(raw.subagentId || ''),
      parentSessionId: conversation.agentSessionId, requestId: String(raw.requestId || ''), response: raw.response },
    'agent_session', { target: null, timeoutMs: 8000 });
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});

ipcMain.handle('conversations:stop-subagent', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isConversationSender(event, dashboardWindow, companionWindow)) return { ok: false, error: 'unauthorized_renderer' };
  const conversation = conversations().get(String(raw.conversationId || ''));
  const subagentId = String(raw.subagentId || '').trim();
  if (!conversation?.agentSessionId || !subagentId || subagentId === conversation.agentSessionId) {
    return { ok: false, error: 'unknown_subagent' };
  }
  try {
    return await runRuntimeBridgePromise({ action: 'cancel', sessionId: subagentId,
      parentSessionId: conversation.agentSessionId, reason: 'user stopped this subagent' },
    'agent_session', { target: null, timeoutMs: 8000 });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('conversations:steer', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isConversationSender(event, dashboardWindow, companionWindow)) {
    return { ok: false, error: 'unauthorized_renderer' };
  }
  const plan = planConversationSteer({
    text: String(raw?.text || ''),
    taskInput: raw?.taskInput,
    agentSessionId: String(raw?.agentSessionId || ''),
  });
  if (plan.action !== 'steer') return { ok: false, error: plan.reason };
  try {
    const capturedAtMs = Date.now();
    const taskInput = plan.taskInput || {
      inputId: String(raw?.inputId || crypto.randomUUID()),
      taskId: plan.sessionId,
      target: 'next-step',
      instruction: plan.text,
      referenceUpdates: [],
      sourceIds: [],
      timeline: [{
        eventId: `utterance:${capturedAtMs}`,
        kind: 'utterance',
        startMs: capturedAtMs,
        endMs: capturedAtMs,
        text: plan.text,
      }],
      capturedAtMs,
    };
    const parsed = await putTaskInputToSession(plan.sessionId, taskInput, Array.isArray(raw?.sources) ? raw.sources : []);
    return {
      ok: parsed?.ok === true,
      inputId: parsed?.inputId || null,
      status: parsed?.status || null,
      error: parsed?.error,
    };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error || 'bridge_failed') };
  }
});
ipcMain.handle('conversations:timeline', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().timeline(); } catch (_) { return []; }
});

ipcMain.handle('conversations:rename', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  const id = String(raw?.id || '').slice(0, 120);
  const title = String(raw?.title || '').slice(0, 200);
  try {
    const result = conversations().rename(id, title);
    if (!result.ok) return { ok: false, error: 'invalid_id_or_title' };
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('conversations:turn', { id });
    }
    return { ok: true, title: result.conversation?.title || title };
  } catch (_) { return { ok: false, error: 'store_failed' }; }
});

ipcMain.handle('conversations:suggest', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  const turns = bridgeHistoryTurns(raw?.turns);
  if (!turns.length) return { ok: true, suggestion: '' };
  const payload = {
    operation: 'suggest_next',
    turns,
    object: raw?.object && typeof raw.object === 'object' ? raw.object : {},
    modelRuntime: activeModelRuntimeConfig(),
  };
  return new Promise((resolve) => {
    const child = runRuntimeBridge(payload, 'conversation', 'dashboard', {
      timeoutMs: 45_000,
      onComplete: (parsed: any) => {
        resolve({ ok: true, suggestion: parsed?.ok === true ? String(parsed?.suggestion || '') : '' });
      },
    });
    if (!child) resolve({ ok: true, suggestion: '' });
  });
});

ipcMain.handle('conversations:delete', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  const id = String(raw?.id || '').slice(0, 120);
  try {
    const result = conversations().remove(id);
    if (!result.ok) return { ok: false, error: 'unknown_conversation' };
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('conversations:turn', { id });
    }
    return { ok: true };
  } catch (_) { return { ok: false, error: 'store_failed' }; }
});
ipcMain.handle('conversations:memories', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().memories(); } catch (_) { return []; }
});
ipcMain.handle('conversations:artifacts', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) return [];
  try { return conversations().artifacts(); } catch (_) { return []; }
});
ipcMain.handle('conversations:event-summaries', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) {
    return { materialAvailable: false, events: [], error: 'unauthorized_renderer' };
  }
  try {
    return conversations().eventSummaries({
      fromMs: raw?.fromMs,
      toMs: raw?.toMs,
      conversationIds: Array.isArray(raw?.conversationIds) ? raw.conversationIds.slice(0, 500) : [],
      limit: Math.max(1, Math.min(500, Number(raw?.limit) || 200)),
    });
  } catch (_) {
    return { materialAvailable: false, events: [], error: 'store_failed' };
  }
});
ipcMain.handle('artifacts:read', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  return artifactCommands().read(raw);
});
ipcMain.handle('artifacts:edit', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  return artifactCommands().edit(raw);
});
ipcMain.handle('artifacts:accept', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  return artifactCommands().accept(raw);
});
ipcMain.handle('artifacts:apply', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  return artifactCommands().apply(raw);
});
ipcMain.handle('artifacts:undo', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  return artifactCommands().undo(raw);
});
const conversationRecoveryQueries = new Map<string, { mtimeMs: number; result: Promise<any> }>();
ipcMain.handle('conversations:recovery', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  const conversation = conversations().get(String(raw.conversationId || ''));
  if (!conversation?.agentSessionId) return { ok: true, pendingRecovery: [] };
  const sessionId = conversation.agentSessionId;
  try {
    const sessionPath = path.join(FABRIC_DATA_DIR, 'agent-sessions', `${sessionId}.jsonl`);
    const { mtimeMs } = await fs.promises.stat(sessionPath);
    if (raw.action === 'resolve') {
      const result = await runRuntimeBridgePromise({
        action: 'recovery-resolve', sessionId, operationId: raw.operationId,
        verificationCallId: raw.verificationCallId, confirmed: raw.confirmed === true,
      }, 'agent_session', { target: null, timeoutMs: 8000 });
      conversationRecoveryQueries.delete(sessionId);
      if (result?.ok === true) notifyConversationChanged(conversation.id);
      return result;
    }
    let cached = conversationRecoveryQueries.get(sessionId);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, result: handleSessionRead({ action: 'status', sessionId }, FABRIC_DATA_DIR) };
      conversationRecoveryQueries.set(sessionId, cached);
    }
    return await cached.result;
  } catch (error: any) {
    conversationRecoveryQueries.delete(sessionId);
    return { ok: false, pendingRecovery: [], error: error?.code === 'ENOENT'
      ? 'session_not_found' : String(error?.message || error) };
  }
});

function figmaTaskForConversation(rawConversationId: unknown): { conversationId: string; taskId: string } {
  const conversationId = String(rawConversationId || '').trim().slice(0, 120);
  const conversation = conversationId ? conversations().get(conversationId) : null;
  const taskId = String(conversation?.agentSessionId || '').trim();
  if (!conversation || !taskId) throw new Error('figma_connection_requires_started_task');
  return { conversationId, taskId };
}

ipcMain.handle('figma:pair', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  try {
    const { taskId } = figmaTaskForConversation(raw?.conversationId);
    const pairing = await figmaRuntime.openPairing(taskId);
    const manifestPath = path.join(ROOT, 'build', 'figma', 'manifest.json');
    return {
      ok: true,
      ...pairing,
      installableManifestBuilt: fs.existsSync(manifestPath),
      ...(fs.existsSync(manifestPath) ? { manifestPath } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('figma:status', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  try {
    const { taskId } = figmaTaskForConversation(raw?.conversationId);
    return { ok: true, ...figmaRuntime.status(taskId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('figma:disconnect', (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  try {
    const { taskId } = figmaTaskForConversation(raw?.conversationId);
    const documentSessionId = String(raw?.documentSessionId || '').trim().slice(0, 256);
    if (!documentSessionId) return { ok: false, error: 'document_session_id_required' };
    return { ok: figmaRuntime.disconnect(taskId, documentSessionId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

function figmaDocumentForTask(taskId: string, rawDocumentSessionId: unknown): string {
  const requested = String(rawDocumentSessionId || '').trim().slice(0, 256);
  const connections = figmaRuntime.status(taskId).connections;
  const connection = requested
    ? connections.find((candidate: { documentSessionId: string }) => (
      candidate.documentSessionId === requested
    ))
    : connections[0];
  if (!connection) throw new Error('figma-current-document-connection-required');
  return connection.documentSessionId;
}

ipcMain.handle('figma:inspect-selection', async (
  event: Electron.IpcMainInvokeEvent,
  raw: any = {},
) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  try {
    const { taskId } = figmaTaskForConversation(raw?.conversationId);
    const documentSessionId = figmaDocumentForTask(taskId, raw?.documentSessionId);
    const result = await figmaRuntime.request(
      taskId,
      documentSessionId,
      'read_selection',
      {},
    );
    return { ok: true, documentSessionId, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('figma:export-preview', async (
  event: Electron.IpcMainInvokeEvent,
  raw: any = {},
) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_renderer' };
  try {
    const { taskId } = figmaTaskForConversation(raw?.conversationId);
    const documentSessionId = figmaDocumentForTask(taskId, raw?.documentSessionId);
    const nodeId = String(raw?.nodeId || '').trim().slice(0, 256);
    if (!nodeId) return { ok: false, error: 'figma_node_id_required' };
    const result = await figmaRuntime.request(
      taskId,
      documentSessionId,
      'export_preview',
      { nodeId },
    );
    return { ok: true, documentSessionId, result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

function hideStage() {
  if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) stageWindow.hide();
}

function sanitizeStageHitRegions(rawRegions: any[]) {
  if (!stageWindow || stageWindow.isDestroyed() || !Array.isArray(rawRegions)) return [];
  const bounds = liveStageBounds();
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

function mergeStageHitRegions(previous: Array<{ x: number; y: number; width: number; height: number }>, current: Array<{ x: number; y: number; width: number; height: number }>) {
  const seen = new Set();
  return [...previous, ...current].filter((region) => {
    const key = `${region.x}:${region.y}:${region.width}:${region.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
}

function applyStageShape(dipRegions: Array<{ x: number; y: number; width: number; height: number }>) {
  if (!stageWindow || stageWindow.isDestroyed()) return;
  const regions = nativeShapeRegions({
    platform: process.platform,
    screenApi: screen,
    stageBounds: liveStageBounds(),
    regions: dipRegions,
  });
  stageWindow.setShape(regions);
}

function setStageMouseCapture(enabled: boolean, requestFocus = false, rawRegions: any[] | undefined = undefined) {
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

function deliverStageBridgeResult(selectionSessionToken: string | null, parsed: any) {
  if (!selectionSessionToken || selectionSessions.get(selectionSessionToken)?.stageAttached !== false) {
    lastStageResult = { token: selectionSessionToken || null, parsed: safeClone(parsed) };
  }
  updateStage({
    selectionSessionToken: selectionSessionToken || null,
    event: stageEventFromBridge(parsed),
  });
}

function withPickedElement(snapshot: any, picked: any) {
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

function deliverStageError(selectionSessionToken: string | null, message: unknown) {
  updateStage({
    selectionSessionToken: selectionSessionToken || null,
    event: { type: 'ERROR', error: { message: humanErrorMessage(message) } },
  });
}

function dashboardMaterial(settings = fabricSettings) {
  if (settings?.accessibility?.reduce_transparency === true) return 'none';
  return settings?.appearance?.material === 'solid' ? 'none' : 'mica';
}

function appIsDark() {
  const theme = fabricSettings?.appearance?.theme || 'light';
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

function titleBarColors(symbol: string | null = null) {
  return {
    color: '#00000000',
    symbolColor: symbol || (appIsDark() ? '#F2F1ED' : '#17170F'),
    height: 36,
  };
}

function applyTitleBarTheme() {
  if (process.platform !== 'win32' || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  try {
    dashboardWindow.setTitleBarOverlay(titleBarColors());
  } catch (error) {
    log(`title bar overlay unavailable ${error instanceof Error ? error.name : 'Error'}`);
  }
}

nativeTheme.on('updated', applyTitleBarTheme);

function applyDashboardMaterial(settings = fabricSettings) {
  if (process.platform !== 'win32' || !dashboardWindow || dashboardWindow.isDestroyed()) return;
  try {
    dashboardWindow.setBackgroundMaterial(dashboardMaterial(settings));
  } catch (error) {
    log(`dashboard material unavailable ${error instanceof Error ? error.name : 'Error'}`);
  }
}

function createDashboardWindow(initialView = 'chat') {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;
  dashboardWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 700,
    title: 'Magic Pointer',
    titleBarStyle: 'hidden',
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
  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'studio.html'), {
    query: { view: initialView },
  });
  dashboardWindow.on('close', (event: Electron.Event) => {
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
  dashboardWindow.on('closed', () => {
    destroyDashboardBrowserView();
    dashboardWindow = null;
  });
  return dashboardWindow;
}

let stashRuntime: ReturnType<typeof createStashRuntime> | null = null;

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
    runtimeExecutable: process.execPath,
    userDataDir: FABRIC_DATA_DIR,
    settings: () => fabricSettings || {},
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
    onEntry: (entry: any) => {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        dashboardWindow.webContents.send('stash:entry', entry);
      }
      feedProactiveEvent({
        kind: entry?.media === 'image' ? 'shot' : 'clip',
        app: entry?.app || '',
        t: entry?.capturedAt || Date.now(),
      });
    },
  });
  if (fabricSettings?.stash?.clipboard === true || fabricSettings?.stash?.text === true) stashRuntime.start();
  return stashRuntime;
}

function reconfigureStashRuntime(settings = fabricSettings) {
  stashRuntime?.stop();
  stashRuntime = null;
  if (settings?.stash?.clipboard === true || settings?.stash?.text === true) {
    initializeStashRuntime();
  }
}

let proactiveRuleState: ReturnType<typeof evaluateRule>['state'] | null = null;
let proactiveOnceStore: ReturnType<typeof createProactiveOnceStore> | null = null;

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

function autoStashResultImage(payload: any) {
  try {
    const token = payload?.selectionSessionToken;
    const entry = token ? selectionSessions.get(token) : null;
    if (!entry) return;
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

function feedProactiveEvent(event: any) {
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
}

ipcMain.handle('stash:list', (event: Electron.IpcMainInvokeEvent) => {
  if (!event.sender || (
    event.sender !== dashboardWindow?.webContents
    && event.sender !== companionWindow?.webContents
  )) {
    return [];
  }
  try {
    return initializeStashRuntime().list();
  } catch (error) {
    log(`stash list failed ${error instanceof Error ? error.name : 'Error'}`);
    return [];
  }
});

function canManageStash(event: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(event.sender && event.sender === dashboardWindow?.webContents);
}

function stashEntryWithPath(entry: any) {
  return entry ? { ...entry, absPath: path.join(stashBaseDir(), String(entry.relPath || '')) } : null;
}

ipcMain.handle('stash:add-note', async (event: Electron.IpcMainInvokeEvent, payload: any = {}) => {
  if (!canManageStash(event)) return { ok: false, error: 'forbidden_sender' };
  const text = String(payload?.text || '').trim().slice(0, 200_000);
  if (!text) return { ok: false, error: 'empty_note' };
  try {
    const entry = await initializeStashRuntime().addText({
      text,
      summary: String(payload?.summary || text).trim().slice(0, 2000),
      userCategory: String(payload?.userCategory || '笔记').trim().slice(0, 80),
      sourceId: String(payload?.sourceId || '').trim().slice(0, 300),
      sourceTimeMs: Number.isFinite(Number(payload?.sourceTimeMs))
        ? Number(payload.sourceTimeMs)
        : Date.now(),
      locator: payload?.locator && typeof payload.locator === 'object'
        ? structuredClone(payload.locator)
        : null,
    });
    return entry ? { ok: true, entry: stashEntryWithPath(entry) } : { ok: false, error: 'add_failed' };
  } catch (error) {
    log(`stash add note failed ${error instanceof Error ? error.name : 'Error'}`);
    return { ok: false, error: 'add_failed' };
  }
});

ipcMain.handle('stash:add-files', async (event: Electron.IpcMainInvokeEvent) => {
  if (!canManageStash(event) || !dashboardWindow) return { ok: false, error: 'forbidden_sender' };
  const picked = await dialog.showOpenDialog(dashboardWindow, {
    title: '加入材料',
    properties: ['openFile', 'multiSelections'],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true, entries: [] };
  const added = [];
  for (const filePath of picked.filePaths.slice(0, 32)) {
    try {
      const entry = await initializeStashRuntime().addFile(filePath, {
        userCategory: '文件',
        summary: path.basename(filePath),
      });
      if (entry) added.push(stashEntryWithPath(entry));
    } catch (error) {
      log(`stash add file failed ${error instanceof Error ? error.name : 'Error'}`);
    }
  }
  return added.length
    ? { ok: true, entries: added }
    : { ok: false, error: 'no_files_added', entries: [] };
});

ipcMain.handle('stash:search', (event: Electron.IpcMainInvokeEvent, payload: any = {}) => {
  if (!event.sender || (
    event.sender !== dashboardWindow?.webContents
    && event.sender !== companionWindow?.webContents
  )) return [];
  try {
    return initializeStashRuntime().search(payload?.query, {
      category: payload?.category,
      limit: payload?.limit,
    }).map(stashEntryWithPath);
  } catch (error) {
    log(`stash search failed ${error instanceof Error ? error.name : 'Error'}`);
    return [];
  }
});

ipcMain.handle('stash:open', async (event: Electron.IpcMainInvokeEvent, id: unknown) => {
  if (!canManageStash(event)) return { ok: false, error: 'forbidden_sender' };
  const entry = initializeStashRuntime().get(id);
  if (!entry) return { ok: false, error: 'not_found' };
  const original = String(entry.originalArtifactPath || '').trim();
  const retained = path.join(stashBaseDir(), String(entry.relPath || ''));
  const target = original && fs.existsSync(original) ? original : retained;
  if (!target || !fs.existsSync(target)) {
    return {
      ok: false,
      error: 'source_unavailable',
      sourceTimeMs: entry.sourceTimeMs || entry.capturedAt,
    };
  }
  const error = await shell.openPath(target);
  return error
    ? { ok: false, error, path: target }
    : {
        ok: true,
        path: target,
        evidenceState: target === original ? 'original' : 'retained_evidence',
        sourceTimeMs: entry.sourceTimeMs || entry.capturedAt,
      };
});

ipcMain.handle('stash:update-category', (event: Electron.IpcMainInvokeEvent, payload: any = {}) => {
  if (!canManageStash(event)) return { ok: false, error: 'forbidden_sender' };
  const entry = initializeStashRuntime().updateCategory(payload?.id, payload?.category);
  return entry
    ? { ok: true, entry: stashEntryWithPath(entry) }
    : { ok: false, error: 'not_found_or_empty_category' };
});

ipcMain.handle('stash:remove', (event: Electron.IpcMainInvokeEvent, id: unknown) => {
  if (!canManageStash(event)) return { ok: false, error: 'forbidden_sender' };
  return initializeStashRuntime().remove(id);
});

ipcMain.handle('stash:describe', async (event: Electron.IpcMainInvokeEvent, imagePath: string) => {
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
    const parsed = await runRuntimeBridgePromise(
      { operation: 'describe', imagePath: target },
      'stash_describe',
      { target: 'fabric-dashboard', timeoutMs: 30000 },
    );
    if (parsed?.ok && parsed.summary) return { ok: true, summary: String(parsed.summary) };
    return { ok: false, error: parsed?.error || 'vision_unavailable' };
  } catch (error) {
    log(`stash describe failed ${error instanceof Error ? error.name : 'Error'}`);
    return { ok: false, error: 'bridge_failed' };
  }
});

let companionWindow: InstanceType<typeof BrowserWindow> | null = null;

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

function showCompanion(payload = {}, options: { activate?: boolean } = {}) {
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
    kickTaskWatch();
    companionWindow.webContents.send('companion:show', payload);
    log('showCompanion');
  };
  if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function showDashboard(payload: Record<string, unknown> = {}, options: { activate?: boolean } = {}) {
  const win = createDashboardWindow(String(payload.view || 'chat'));
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
    kickTaskWatch();
    dashboardWindow.webContents.send('dashboard:show', payload);
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

function showOnboarding(payload: { screen?: string } = {}, options: { activate?: boolean } = {}) {
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

function showPrimarySurface(options: { view?: string; activate?: boolean } = {}) {
  if (onboardingRequired) showOnboarding({}, options);
  else showDashboard({ view: options.view || 'chat' }, options);
}

function panelGeometryForSession(entry: any) {
  const snapshot = entry?.snapshot || {};
  const context = snapshot.context || {};
  const artifacts = context.artifacts || {};
  const cursor = entry?.cursor || screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  placeStageOnDisplay(display);
  const stageBounds = liveStageBounds();
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

function stageTargetForSession(entry: any) {
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
  setStageMouseCapture(false);
  if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
    stageWindow.webContents.send('stage:hide');
  }
  if (overlayOwnsPointerInput && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayOwnsPointerInput = false;
  }
  if (invalidateSession) detachSelectionSurface(sessionToken);
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

function armTemporaryGestureSubmitShortcut(token: string) {
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

function queueActivationUntilSurfacesReady(reason: string) {
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

function isSelectionGestureActivation(reason: string) {
  const value = String(reason || '');
  return value === 'wiggle'
    || value === 'shortcut-wake'
    || value === 'episode-continue'
    || value.startsWith('mouse-button-');
}

function requestActivation(reason: string) {
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











let overlayGhostTimer: NodeJS.Timeout | null = null;
let overlayGhostShownByUs = false;

function replayElementGhosts(attachedSession: any, display: Electron.Display): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const artifacts = attachedSession?.snapshot?.context?.artifacts || {};
  const handles = Array.isArray(artifacts.element_handles) ? artifacts.element_handles : [];
  const { buildElementGhosts } = require('./element_ghost_policy');
  const replay = buildElementGhosts({
    handles,
    displayBounds: display.bounds,
    scaleFactor: display.scaleFactor || 1,
    focusPoint: attachedSession?.snapshot?.target_point || null,
  });
  if (!replay.ghosts.length) return;
  if (overlayGhostTimer) clearTimeout(overlayGhostTimer);
  overlayGhostTimer = null;
  const wasVisible = overlayWindow.isVisible();
  overlayWindow.setBounds(display.bounds);
  overlayWindow.showInactive();
  overlayWindow.webContents.send('overlay:element-ghosts', replay);
  overlayGhostShownByUs = !wasVisible;
  const total = replay.holdMs + replay.fadeMs
    + Math.max(...replay.ghosts.map((ghost: any) => Number(ghost.delayMs) || 0)) + 80;
  overlayGhostTimer = setTimeout(() => {
    overlayGhostTimer = null;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.send('overlay:element-ghosts', { ghosts: [] });
    if (overlayGhostShownByUs && !overlayOwnsPointerInput && !hasActiveSelectionCapture()) {
      overlayWindow.hide();
    }
    overlayGhostShownByUs = false;
  }, total);
}

let overlayBoundDisplayId: number | null = null;

function sendCursorToOverlay(pos = screen.getCursorScreenPoint()) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
  const display = screen.getDisplayNearestPoint(pos);
  const desired = display.bounds;
  const current = overlayWindow.getBounds();
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
  selectionGestureArmTimer = null;
  selectionGestureExpiryTimer = null;
  selectionGestureArm = null;
  if (captureCommitCoordinator) {
    captureCommitCoordinator.cancel().catch((error: any) => {
      log(`frame capture epoch cancel failed: ${error?.message || error}`);
    });
  }
  disarmTemporaryGestureSubmitShortcut();
  if (hideSurface) hideOverlay();
  if (!stageWindow || stageWindow.isDestroyed() || !stageWindow.isVisible()) {
    disarmTemporaryDismissShortcut();
  }
  if (active) log(`selection gesture ${reason} token=${active.token}`);
  return active;
}

function getFrameCaptureWorkerClient() {
  if (!frameCaptureWorkerClient) {
    frameCaptureWorkerClient = new FrameCaptureWorkerClient({
      root: ROOT,
      runtimeExecutable: process.execPath,
    });
  }
  return frameCaptureWorkerClient;
}

let uiaResidentHostProcess: ReturnType<typeof spawn> | null = null;
const UIA_RESIDENT_HOST_PIPE = process.env.MAGIC_POINTER_UIA_HOST_PIPE || 'MagicPointerUIAHost';

function ensureResidentUiaHost(): void {
  if (uiaResidentHostProcess) return;
  const exe = path.join(DEVELOPMENT_RUNTIME_DIR, 'uia_resident_host.exe');
  if (!fs.existsSync(exe)) {
    log('resident UIA host exe not compiled yet; first probe will compile it');
    return;
  }
  process.env.MAGIC_POINTER_UIA_HOST_PIPE = UIA_RESIDENT_HOST_PIPE;
  uiaResidentHostProcess = spawn(exe, [], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, MAGIC_POINTER_UIA_HOST_PIPE: UIA_RESIDENT_HOST_PIPE },
  });
  uiaResidentHostProcess.on('exit', (code: number | null) => {
    log(`resident UIA host exited code=${code ?? 'unknown'}`);
    uiaResidentHostProcess = null;
  });
  uiaResidentHostProcess.on('error', (error: Error) => {
    log(`resident UIA host spawn failed: ${error?.message || error}`);
    uiaResidentHostProcess = null;
  });
  log('resident UIA host started');
}

function reportFrameCommitFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log(`frame commit failed: ${message}`);
  deliverStageError(null, '这次没能冻结画面，请再选一次。');
}

function getCaptureCommitCoordinator() {
  if (!captureCommitCoordinator) {
    const worker = getFrameCaptureWorkerClient();
    captureCommitCoordinator = new CaptureCommitCoordinator({
      provider: {
        arm: (request: any) => worker.start().then(() => worker.arm(request)),
        commit: (request: any) => worker.commit(request),
        cancel: (epochId: string) => worker.cancel(epochId),
      },
      releaseOverlay: () => hideOverlay(),
      beginSession: (_gesture: unknown, _lease: any) => {
        // The lease is returned by complete() and consumed by
        // completeSelectionGesture's await chain — no global pending slot, so
        // two interleaved gestures can never exchange FrameLeases.
      },
      onCommitFailure: (error: unknown) => reportFrameCommitFailure(error),
    });
  }
  return captureCommitCoordinator;
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
  getCaptureCommitCoordinator().arm({
    epochId: token,
    displayId: String(display.id || 'display-1'),
    scaleFactor: display.scaleFactor || 1,
    surfaceBoundsPx: physicalDisplayBounds({
      bounds: display.bounds,
      scaleFactor: display.scaleFactor || 1,
    }),
    targetWindow: {
      hwnd: selectionGestureArm.source.foregroundHwnd,
      processId: selectionGestureArm.source.foregroundProcessId,
      processName: selectionGestureArm.source.foregroundApp || '',
      title: '',
    },
    overlayExcluded: true,
  }).catch((error: any) => {
    log(`frame capture arm failed: ${error?.message || error}`);
  });
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
      overlayBoundDisplayId = null;
      if (typeof win.setFocusable === 'function') win.setFocusable(false);
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

  log(`selection gesture armed reason=${reason} token=${token}`);
  reveal();
  selectionGestureExpiryTimer = setTimeout(() => {
    if (selectionGestureArm?.token === token) cancelSelectionGesture('expired');
  }, timeoutMs);
  return token;
}

function markSelectionGestureDrawing(token: string, { timeoutMs = null, reason = 'draw_timeout' }: { timeoutMs?: number | null; reason?: string } = {}) {
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

function completeSelectionGesture(payload: any) {
  const arm = selectionGestureArm;
  if (!arm || String(payload?.selectionGestureToken || '') !== arm.token) {
    cancelSelectionGesture('stale');
    return false;
  }
  if (arm.committing) {
    cancelSelectionGesture('stale');
    return false;
  }
  const boundedGesture = boundGestureInput(payload?.points, payload?.strokes, {
    maxPoints: MAX_OVERLAY_CAPTURE_POINTS,
    maxStrokes: MAX_OVERLAY_CAPTURE_STROKES,
  });
  const summary = summarizeGesture(boundedGesture.points, boundedGesture.strokes);
  if (!summary.valid) {
    cancelSelectionGesture(summary.reason || 'invalid');
    return false;
  }
  // against the display that contains it, not a single global scale factor.
  const gestureFrame = (overlayWindow && !overlayWindow.isDestroyed())
    ? overlayWindow.getBounds()
    : arm.displayBounds;
  const toPhysical = (point: { x: number; y: number }) =>
    mapOverlayPointToPhysical(point, gestureFrame, (dip: { x: number; y: number }) => {
      const converted = physicalScreenPoint(screen, dip);
      if (converted) return converted;
      const display = screen.getDisplayNearestPoint(dip);
      const scaleFactor = display.scaleFactor || 1;
      return { x: dip.x * scaleFactor, y: dip.y * scaleFactor };
    });
  const physicalPoints = summary.points.map((point: { x: number; y: number; t?: number }) => ({ ...toPhysical(point), t: point.t }));
  const physicalStrokes = summary.strokes.map((stroke: {
    points: Array<{ x: number; y: number; t?: number }>;
    geometry?: unknown;
  }) => ({
    points: stroke.points.map((point: { x: number; y: number; t?: number }) => ({ ...toPhysical(point), t: point.t })),
    ...(stroke.geometry ? { geometry: toPhysicalGeometry(stroke.geometry, toPhysical) } : {}),
  }));
  const allPhysical = physicalStrokes.length
    ? physicalStrokes.flatMap((s: { points: Array<{ x: number; y: number; t?: number }> }) => s.points)
    : physicalPoints;
  const armDisplay = screen.getDisplayNearestPoint(overlayPointToScreenDip(summary.releasePoint, gestureFrame));
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
    anchorPoint: summary.anchorPoint ? toPhysical(summary.anchorPoint) : toPhysical(summary.releasePoint),
    geometry: toPhysicalGeometry(summary.geometry, toPhysical),
    direction: summary.direction || undefined,
    displayBounds: { ...armDisplay.bounds },
    scaleFactor,
    source: { ...arm.source },
  };
  const reason = arm.reason;
  arm.committing = true;
  getCaptureCommitCoordinator().complete(gesture).then((lease: any) => {
    if (lease === null) {
      log('frame commit discarded: a newer gesture replaced this epoch');
      return;
    }
    if (!selectionGestureArm || selectionGestureArm.token !== arm.token) {
      log('frame commit arrived for a replaced gesture; discarding session');
      return;
    }
    cancelSelectionGesture('completed');
    beginSelectionSession(reason, gesture, lease);
  }).catch((error: any) => {
    cancelSelectionGesture('commit_failed');
    log(`frame commit failed: ${error?.message || error}`);
  });
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

function processPassThroughGestureSample(now: number, pos: { x: number; y: number }) {
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
    const scrollDelta = pointerInputState.scrollDelta;
    pointerInputState.scrollDelta = 0;
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) sendCursorToOverlay(pos);
    if (stageWindow && !stageWindow.isDestroyed() && stageWindow.isVisible()) {
      const bounds = stageBounds();
      if (bounds) {
        const stageDisplay = screen.getDisplayMatching(bounds);
        const stageScale = Number(stageDisplay?.scaleFactor) > 0
          ? Number(stageDisplay.scaleFactor)
          : 1;
        stageWindow.webContents.send('stage:pointer-input', {
          t: now,
          x: pos.x - bounds.x,
          y: pos.y - bounds.y,
          screenX: pos.x,
          screenY: pos.y,
          stageOriginX: Math.round(bounds.x * stageScale),
          stageOriginY: Math.round(bounds.y * stageScale),
          buttons: Number(pointerInputState.buttons || 0),
        });
      }
    }
    const temporarySurfaceVisible = hasVisibleTemporarySurface()
      || Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
    const currentButtons = Number(pointerInputState.buttons || 0);
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
  return pointerPollingPolicy({
    wakeMode: fabricSettings?.activation?.wake_mode,
    wiggleEnabled: fabricSettings?.activation?.wiggle_enabled,
    mouseShakeOverride: process.env.MAGIC_POINTER_ENABLE_MOUSE_SHAKE,
    episodeActive: Boolean(interactionEpisodes.active()),
    mouseSideButton: fabricSettings?.activation?.mouse_side_button,
    onboardingRequired,
    inputPaused,
  });
}

function inputModeForReason(_reason: string) {
  return 'text';
}

function registerConfigurableHotkeys() {
  for (const accelerator of registeredConfigurableHotkeys) {
    try { globalShortcut.unregister(accelerator); } catch (_) {}
  }
  registeredConfigurableHotkeys.clear();
  const results: Record<string, { accelerator: string; registered: boolean; disabled?: boolean }> = {};
  const register = (name: string, accelerator: string, handler: () => void, enabled = true) => {
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
  register('pause', fabricSettings.shortcuts?.pause || 'Control+Alt+P', () => {
    inputPaused = !inputPaused;
    if (inputPaused) dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
    applyConfiguredWakeState();
    refreshTrayMenu();
  });
  return results;
}

function stageWindowRect(sourceWindow: any, stageBounds: { x: number; y: number; width: number; height: number }) {
  const raw = sourceWindow && Array.isArray(sourceWindow.bbox) && sourceWindow.bbox.length === 4
    ? sourceWindow.bbox
    : null;
  if (!raw || !stageBounds) return null;
  const values = raw.map((v: unknown) => Number(v));
  if (values.some((v: number) => !Number.isFinite(v))) return null;
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

function stageAppLabel(snapshot: any) {
  const materials = Array.isArray(snapshot?.selection_materials) ? snapshot.selection_materials : [];
  if (materials.length > 1) {
    return [...new Set(materials.map((material: any) => String(
      material.source_window?.title || material.context?.window?.title || material.context?.label || '屏幕区域',
    )))].join(' + ');
  }
  const context = (snapshot && snapshot.context) || {};
  const window = (snapshot && snapshot.source_window) || {};
  const app = String(context.app || '');
  const title = String(window.title || context.window?.title || '');
  const bits = [app, title].filter(Boolean);
  return bits.length ? bits.join(' · ') : '';
}

function stageSessionPayload(entry: any) {
  const strokeCount = entry?.gesture && Array.isArray(entry.gesture.strokes) && entry.gesture.strokes.length > 0
    ? entry.gesture.strokes.length
    : 1;
  return {
    selectionSessionToken: entry.token,
    taskId: entry.taskId,
    selectionSnapshotId: entry.snapshot?.snapshot_id || null,
    selectionCount: strokeCount,
    captureEligibility: entry.captureEligibility,
    defaultInputMode: inputModeForReason(entry.reason),
    groundingReady: Boolean(entry?.snapshot),
    selectionChars: String(entry?.snapshot?.context?.content || '').trim().length,
    targetWindowRect: stageWindowRect(
      entry?.snapshot?.source_window,
      (entry?.panelGeometry || panelGeometryForSession(entry))?.stageBounds,
    ),
    targetAppLabel: stageAppLabel(entry?.snapshot),
    sessionExpiresAt: entry.expiresAt,
  };
}

function episodeObjectForSession(entry: any): any {
  const snapshot = entry?.snapshot || {};
  const context = snapshot.context || {};
  const sourceWindow = snapshot.source_window || {};
  const strokes = Array.isArray(snapshot.selection_gesture?.strokes)
    ? snapshot.selection_gesture.strokes.slice(0, 12)
    : [];
  const regions = strokes.flatMap((stroke: any, strokeIndex: number) => {
    const points = Array.isArray(stroke?.points) ? stroke.points : [];
    const xs = points.map((point: any) => Number(point?.x)).filter(Number.isFinite);
    const ys = points.map((point: any) => Number(point?.y)).filter(Number.isFinite);
    if (!xs.length || !ys.length) return [];
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return [{
      strokeIndex,
      bbox: [left, top, Math.max(...xs) - left, Math.max(...ys) - top],
      object: snapshot.selection_materials?.[strokeIndex] ? episodeObjectForSession({
        ...entry,
        snapshot: { ...snapshot, ...snapshot.selection_materials[strokeIndex], selection_materials: [] },
      }) : undefined,
    }];
  });
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
    frameLeaseId: String(snapshot.frame_lease?.frameLeaseId || ''),
    bbox: snapshot.selection_bbox || snapshot.selection_rect || null,
    regions,
    source: {
      app: String(context.app || entry?.summary?.app || ''),
      title: String(sourceWindow.title || context?.window?.title || ''),
      path: String(context.artifacts?.local_file?.path || context.document_path || context.path || snapshot.capture_path || ''),
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

function bindEpisodeForCommand(session: any, command: string) {
  const referenceLabel = inferReferenceLabel(command);
  const object = episodeObjectForSession(session);
  interactionEpisodes.bindCommandTarget(object, command, {
    taskId: session.taskId,
    slot: 'this',
    role: 'target',
  });
  if (referenceLabel) interactionEpisodes.labelCurrent(referenceLabel);
  const episode = interactionEpisodes.contextPayload();
  persistCurrentObjectEpisode(session);
  log(`interaction episode bind task=${session.taskId || 'none'} episode=${episode?.episodeId || 'none'} session=${session?.token || 'none'}`);
  return episode;
}

function runningTaskContinuation(excludeToken: string | null = null) {
  const episode = interactionEpisodes.contextPayload();
  const stageOwners = [...activeSessionAgentIds.entries()].map(([token, taskId]) => ({
    token,
    taskId,
    running: token !== excludeToken && activeSessionChildren.has(token),
  }));
  const studioOwners = [...activeConversations.entries()].flatMap(([requestId, entry]: [string, any]) => {
    const taskId = String(entry?.agentSessionId || '').trim();
    return taskId ? [{
      token: `conversation:${requestId}`,
      taskId,
      running: Boolean(entry?.child && !entry.child.killed),
    }] : [];
  });
  return continuationTaskForSelection({
    episodeTaskId: episode?.taskId,
    taskOwners: [...stageOwners, ...studioOwners],
  });
}

function detachSelectionSurface(selectionSessionToken: string | null) {
  if (!selectionSessionToken) return;
  selectionSessions.detach(selectionSessionToken);
  if (activeSelectionSessionToken === selectionSessionToken) activeSelectionSessionToken = null;
}

type SelectionGesture = {
  anchorPoint?: { x: number; y: number };
  releasePoint?: { x: number; y: number };
  strokes?: unknown[];
  source?: { foregroundApp?: string | null; foregroundHwnd?: string | number | null };
};

function beginSelectionSession(reason = 'manual', gesture: SelectionGesture | null = null, frameLease: any = null) {
  const continuation = runningTaskContinuation();
  if (activeSelectionSessionToken) {
    detachSelectionSurface(activeSelectionSessionToken);
  }
  lastStageResult = null;

  const liveCursor = screen.getCursorScreenPoint();
  const releasePoint = gesture?.anchorPoint || gesture?.releasePoint || liveCursor;
  const releasePointDip = (gesture?.anchorPoint || gesture?.releasePoint)
    && typeof screen.screenToDipPoint === 'function'
    ? screen.screenToDipPoint({ x: releasePoint.x, y: releasePoint.y })
    : liveCursor;
  const targetPoint = releasePointDip;
  const physicalCursor = physicalScreenPoint(screen, targetPoint);
  const physicalGesture = physicalGestureTrace(screen, gesture);
  const display = screen.getDisplayNearestPoint(targetPoint);
  const entry = selectionSessions.create({
    reason,
    cursor: targetPoint,
    taskId: continuation?.taskId,
  });
  entry.gesture = gesture ? safeClone(gesture) : null;
  activeSelectionSessionToken = entry.token;
  const initialInputMode = inputModeForReason(reason);
  hideOverlay();
  let stageBounds = display.bounds;
  if (gesture) {
    placeStageOnDisplay(display);
    stageBounds = liveStageBounds();
  } else {
    placeStageOnDisplay(display);
    stageBounds = liveStageBounds();
    showStage({
      reason,
      selectionSessionToken: entry.token,
      selectionSource: selectionSourceForReason(reason),
      defaultInputMode: initialInputMode,
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
  sessionTimeline.begin(entry.token, { reason: String(reason || '') });

  const revealCapsule = (via: string) => {
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

  let child: ReturnType<typeof runRuntimeBridge> | null = null;
  child = runRuntimeBridge(
    {
      mode: 'capture_selection_snapshot',
      reason,
      cursor: physicalCursor,
      cursorSpace: physicalCursor ? 'physical_screen_pixels' : null,
      gesture: physicalGesture ? safeClone(physicalGesture) : null,
      frameLease: frameLease ? safeClone(frameLease) : null,
      screenBounds: display.bounds,
      scaleFactor: display.scaleFactor || 1,
      foregroundApp: gesture?.source?.foregroundApp || pointerInputState.foregroundApp,
      foregroundHwnd: gesture?.source?.foregroundHwnd || pointerInputState.foregroundHwnd,
      allowVisualFallback: true,
    },
    'selection_snapshot',
    'panel',
    {
      timelineToken: entry.token,
      onProgress: (record: any) => {
        handleAgentCursorProgress(record);
        if (record?.phase === CAPSULE_REVEAL_PHASE) revealCapsule(CAPSULE_REVEAL_PHASE);
      },
      onComplete: (parsed: any) => {
        if (activeSessionChildren.get(entry.token) === child) activeSessionChildren.delete(entry.token);
        const current = selectionSessions.get(entry.token);
        if (!current || activeSelectionSessionToken !== entry.token) return;
        const failOpenCapsule = (message: unknown) => {
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
        replayElementGhosts(attached, display);
        const frozenTarget = stageTargetForSession(laidOut);
        const mode = inputModeForReason(current.reason);
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

if (gotLock) app.whenReady().then(() => {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  } catch (_) {}
  log(`app ready pid=${process.pid}`);
  ensureResidentUiaHost();
  for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(eventName, () => {
      invalidateStageBounds();
      invalidateRuntimeState('display_configuration_changed');
      syncAgentCursorSurfaces();
    });
  }
  syncAgentCursorSurfaces();
  agentCursorSurfaces?.startSampling();
  if (process.platform === 'win32') app.setAppUserModelId('com.magicpointer.desktop');
  fabricSettingsStore = new ElectronSettingsStore(path.join(FABRIC_DATA_DIR, 'fabric-settings.json'));
  credentialStore = new CredentialStore(path.join(FABRIC_DATA_DIR, 'credentials.v1.json'), safeStorage);
  try {
    fabricSettings = fabricSettingsStore.load();
  } catch (error) {
    fabricSettings = defaultSettings();
    log(`settings load failed closed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
  migrateLegacyModelProfile();
  const requiredPaths = [
    path.join(ROOT, 'build', 'electron', 'runtime', 'worker.js'),
    path.join(ROOT, 'build', 'electron', 'renderer', 'stage.html'),
  ];
  const onboardingReadiness = inspectOnboardingReadiness({
    markerPath: ONBOARDING_MARKER_PATH,
    bootstrapVersion: ONBOARDING_BOOTSTRAP_VERSION,
    requiredPaths,
  });
  onboardingRequired = !onboardingReadiness.ready;
  initializeContextTrackers();
  setTimeout(() => {
    try {
      initializeStashRuntime();
    } catch (error) {
      log(`stash runtime startup failed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
  }, 1200);
  log(`onboarding readiness ready=${onboardingReadiness.ready} reason=${onboardingReadiness.reason}`);
  try {
    app.setLoginItemSettings({ openAtLogin: fabricSettings.general?.launch_at_login === true });
  } catch (error) {
    log(`login item settings failed ${error instanceof Error ? error.name : 'Error'}`);
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
      process.stderr.write(`n18_wiggle_evidence_failed:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}\n`);
      process.exitCode = 1;
    } finally {
      setImmediate(() => app.quit());
    }
    return;
  }
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
  if (!captureMode) initializeUpdateManager({ automatic: true });
  let wasOpenedAtLogin = false;
  try { wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin === true; } catch (_) {}
  const startHidden = shouldStartHidden({ argv: process.argv.slice(1), wasOpenedAtLogin, captureMode });
  if (onboardingRequired && !captureMode) showOnboarding({}, { activate: true });
  else if (!startHidden) showDashboard({ view: 'general' }, { activate: true });
  const dashboardCapturePath = String(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE || '').trim();
  if (!app.isPackaged && dashboardCapturePath) {
    const captureView = String(process.env.MAGIC_POINTER_DASHBOARD_VIEW || 'activity');
    const captureAnchor = String(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE_ANCHOR || '').trim();
    const captureClick = String(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE_CLICK || '').trim() === '1';
    const capturePrompt = String(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE_PROMPT || '').trim().slice(0, 4000);
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
            if (${JSON.stringify(captureClick)}) target.click();
            return true;
          })()`);
          await new Promise((resolve) => setTimeout(resolve, captureClick ? 3000 : 300));
        }
        if (capturePrompt) {
          await dashboardWindow.webContents.executeJavaScript(`(() => {
            const textarea = document.querySelector('#composer-form textarea');
            const form = document.getElementById('composer-form');
            if (!textarea || !form) return false;
            textarea.value = ${JSON.stringify(capturePrompt)};
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            form.requestSubmit();
            return true;
          })()`);
          const submitDeadline = Date.now() + Math.max(5000, Math.min(
            Number(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE_SUBMIT_TIMEOUT_MS || 60000),
            90000,
          ));
          while (Date.now() < submitDeadline) {
            const busy = await dashboardWindow.webContents.executeJavaScript(
              `document.getElementById('composer-form')?.getAttribute('aria-busy') === 'true'`,
            );
            if (!busy) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        const image = await dashboardWindow.capturePage();
        const renderedState = await dashboardWindow.webContents.executeJavaScript(`({
          view: document.getElementById('shell')?.dataset.view || 'missing',
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
          settingsRect: (() => { const rect = document.querySelector('.mpw-settings-panel')?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; })(),
          show: typeof show,
          dashboardApi: Boolean(window.magicPointerDashboard),
          studioShell: Boolean(globalThis.StudioShell),
          settingsModel: Boolean(globalThis.SettingsModel),
        })`);
        fs.mkdirSync(path.dirname(path.resolve(dashboardCapturePath)), { recursive: true });
        fs.writeFileSync(path.resolve(dashboardCapturePath), image.toPNG());
        process.stdout.write(`${path.resolve(dashboardCapturePath)}\nview=${captureView}\nrenderedState=${JSON.stringify(renderedState)}\n`);
      } catch (error) {
        process.stderr.write(`dashboard_capture_failed:${error instanceof Error ? `${error.name}:${error.message}` : String(error)}\n`);
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    }, captureDelay);
  }
});

app.on('will-quit', () => {
  void contextTrackerRuntime?.stop();
  void figmaRuntime.stop().catch((error: unknown) => {
    log(`figma bridge shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  try { fs.unlinkSync(PID_PATH); } catch (_) {}
  globalShortcut.unregisterAll();
  temporaryDismissShortcutRegistered = false;
  temporaryGestureSubmitShortcutRegistered = false;
  if (mousePollTimer) clearInterval(mousePollTimer);
  agentCursorSurfaces?.dispose();
  agentCursorSurfaces = null;
  if (wiggleCalibrationTimer) clearTimeout(wiggleCalibrationTimer);
  if (uiaResidentHostProcess && !uiaResidentHostProcess.killed) {
    try { uiaResidentHostProcess.kill(); } catch (_) {}
  }
  uiaResidentHostProcess = null;
  if (frameCaptureWorkerClient) {
    frameCaptureWorkerClient.shutdown().catch((error: any) => {
      log(`frame capture worker shutdown failed: ${error?.message || error}`);
    });
  }
  try { if (pointerStateChild && !pointerStateChild.killed) pointerStateChild.kill(); } catch (_) {}
  pointerStateChild = null;
  updateManager?.dispose();
  try { stageWindow?.close(); } catch (_) {}
  try { dashboardWindow?.close(); } catch (_) {}
  try { tray?.destroy(); } catch (_) {}
  tray = null;
  log('app will quit');
  flushConversations();
  flushCurrentObjectEpisode();
  flushLog();
  observability.flushEvents();
});
app.on('before-quit', () => { isQuitting = true; });
process.on('exit', () => {
  flushConversations();
  flushCurrentObjectEpisode();
  flushLog();
  observability.flushEvents();
});

ipcMain.on('agent:cursor', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  sendAgentCursorCommand(payload);
});
ipcMain.on('overlay:renderer-ready', (event: Electron.IpcMainEvent) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  overlayReadiness.markReady();
  log('overlay renderer ready');
});
ipcMain.on('overlay:gesture-ready', (event: Electron.IpcMainEvent, payload: any) => {
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
  overlayWindow.setIgnoreMouseEvents(false);
  overlayOwnsPointerInput = true;
  if (typeof overlayWindow.moveTop === 'function') overlayWindow.moveTop();
  log(
    `gesture-ready OK token=${arm.token} overlayOwnsPointerInput=true`
    + ` delay_ms=${Date.now() - arm.armedAt} mode=${arm.runtime.interactionMode}`,
  );
});
ipcMain.on('stage:renderer-ready', (event: Electron.IpcMainEvent) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  stageReadiness.markReady();
  log('stage renderer ready');
});

ipcMain.on('overlay:hide', (event: Electron.IpcMainEvent) => {
  if (isSurfaceSender(event, 'overlay', resultTargetWindow)) {
    dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
  }
});
ipcMain.on('overlay:guide-finished', (event: Electron.IpcMainEvent) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  if (selectionGestureArm || overlayOwnsPointerInput) return;
  hideOverlay();
});
ipcMain.on('stage:show', (event: Electron.IpcMainEvent) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  if (!activeSelectionSessionToken || selectionSessions.get(activeSelectionSessionToken)?.stageAttached === false) return;
  if (stageWindow && !stageWindow.isDestroyed() && !stageWindow.isVisible()) stageWindow.showInactive();
  kickTaskWatch();
});
ipcMain.on('stage:state', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  const state = String(payload?.state || 'unknown');
  log(`stage renderer state=${state}`);
  if (state === 'dismissing') {
    const token = String(payload?.selectionSessionToken || '');
    if (token) detachSelectionSurface(token);
  }
});
ipcMain.on('stage:hidden', (event: Electron.IpcMainEvent) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  setStageMouseCapture(false);
  hideStage();
});
ipcMain.on('stage:dismiss', (event: Electron.IpcMainEvent) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  dismissTemporarySurfaces({ invalidateSession: true, hideObserver: true });
});
ipcMain.on('stage:set-mouse-capture', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  setStageMouseCapture(
    payload?.enabled === true,
    payload?.requestFocus === true,
    Array.isArray(payload?.regions) ? payload.regions : [],
  );
});



function resultTargetWindow(target: string | null | undefined) {
  if (target === 'dashboard' || target === 'fabric-dashboard') return dashboardWindow;
  if (target === 'stage') return stageWindow;
  return overlayWindow;
}

function safeSurfaceSend(surface: string | null | undefined, channel: string, payload: any) {
  if (surface === 'stage' && payload?.selectionSessionToken
    && selectionSessions.get(payload.selectionSessionToken)?.stageAttached === false) return false;
  const win = resultTargetWindow(surface);
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  win.webContents.send(channel, payload);
  return true;
}

function sendBridgeResult(target: string | null, parsed: any) {
  if (target === 'stage') {
    deliverStageBridgeResult(parsed?.selectionSessionToken || null, parsed);
    return;
  }
  const channel = target === 'fabric-dashboard'
      ? 'dashboard:fabric-state'
    : target === 'dashboard'
      ? 'dashboard:state'
      : 'overlay:result';
  safeSurfaceSend(target, channel, parsed);
}

function runRuntimeBridge(payload: any, scriptPath = 'electron', target: string | null = 'overlay', options: any = {}) {
  if (!options.allowWithoutSurface && !resultTargetWindow(target)) return;
  const defaultTimeoutMs = scriptPath.includes('selection_snapshot')
    ? 15_000
    : scriptPath.includes('selection')
      ? 15 * 60_000
      : scriptPath.includes('action')
        ? 45_000
        : 120_000;
  const onProgress = (record: any) => {
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
  };
  const onComplete = (parsed: any) => {
    log(`bridge complete script=${scriptPath} ok=${parsed?.ok} error=${parsed?.error || 'none'}${parsed?.detail ? ` detail=${String(parsed.detail).slice(0, 300)}` : ''}`);
    if (typeof options.onComplete === 'function') {
      options.onComplete(parsed);
      return;
    }
    registerActionProposals(parsed, options.selectionSessionToken || null, target);
    sendBridgeResult(target, parsed);
  };
  return runtimeBridgeRunner.run({
    executable: process.execPath,
    args: [path.join(ROOT, 'build', 'electron', 'runtime', 'worker.js'), scriptPath],
    spawnOptions: {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MAGIC_POINTER_USER_DATA_DIR: FABRIC_DATA_DIR,
      },
    },
    input: payload,
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || defaultTimeoutMs),
    maxStdoutBytes: Math.max(4096, Number(options.maxStdoutBytes) || 32 * 1024 * 1024),
    maxStderrBytes: Math.max(4096, Number(options.maxStderrBytes) || 256 * 1024),
    signal: options.signal || null,
    logger: log,
    onProgress,
    onComplete,
  });
}

function runRuntimeBridgePromise(payload: any, scriptPath: string, { target = 'fabric-dashboard', timeoutMs = 5000 }: { target?: string | null; timeoutMs?: number } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (callback: (value: unknown) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const child = runRuntimeBridge(payload, scriptPath, target, {
      timeoutMs,
      allowWithoutSurface: true,
      onComplete: (parsed: any) => {
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

ipcMain.handle('learning-candidates:request', async (event: Electron.IpcMainInvokeEvent, payload: any) => {
  if (!isDashboardSender(event) && !isCompanionSender(event)) {
    return { ok: false, error: 'unauthorized_renderer' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'candidate_request_invalid' };
  }
  try {
    return await runRuntimeBridgePromise(
      payload,
      'learning_candidates',
      { target: null, timeoutMs: 5_000 },
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'candidate_request_failed',
    };
  }
});

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
    const parsed = await runRuntimeBridgePromise(
      { operation: 'model.health', probe, timeoutS: 6, modelRuntime: activeModelRuntimeConfig() },
      'fabric',
      { target: 'fabric-dashboard', timeoutMs: probe ? 12000 : 6000 },
    );
    if (parsed?.health && typeof parsed.health === 'object') {
      modelHealth = { ...modelHealth, ...parsed.health };
      log(`model health state=${modelHealth.state} circuitOpen=${modelHealth.circuitOpen === true}`);
      broadcastModelHealth();
    }
  } catch (error) {
    log(`model health probe failed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
  return modelHealth;
}

ipcMain.handle('dashboard:session-timeline', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_dashboard_sender');
  return {
    ok: true,
    sessions: sessionTimeline.snapshot(),
  };
});

ipcMain.handle('dashboard:model-health-refresh', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_dashboard_sender');
  const health = await refreshModelHealth({ probe: true });
  return { ok: true, health };
});

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
  const parsed = await runRuntimeBridgePromise({
    operation: 'runtime.snapshot',
    runtimeEvidence: {
      permissions: runtimePermissionEvidence(),
    },
  }, 'fabric', { timeoutMs: 5000 });
  if (!parsed.snapshot || typeof parsed.snapshot !== 'object') {
    throw new Error('runtime_snapshot_payload_missing');
  }
  return parsed.snapshot;
}

const QUOTA_CACHE_TTL_MS = 60_000;
const quotaCache = new Map<string, { at: number; report: any }>();

function invalidateRuntimeState(reason: string | null = null) {
  quotaCache.clear();
  if (reason && /model|settings/.test(reason)) modelCatalogRefreshedAt = 0;
  const generation = runtimeSnapshot.invalidate(reason);
  safeSurfaceSend('dashboard', 'runtime-snapshot:changed', {
    generation,
    reason: String(reason || 'unspecified'),
  });
  return generation;
}

function modelCredentialRef(profileId: unknown) {
  const id = String(profileId || '').trim().toLowerCase();
  const profiles = Array.isArray(fabricSettings?.models?.profiles) ? fabricSettings.models.profiles : [];
  const profile = profiles.find((item: any) => String(item?.id || '').trim().toLowerCase() === id);
  const ref = String(profile?.credentialRef || '').trim();
  if (!profile || !ref) throw new Error('model_credential_ref_missing');
  return ref;
}

const discoveredModelCatalogs = new Map<string, { baseUrl: string; apiMode: string; models: any[] }>();
let legacyModelCatalog: any[] = [];
let modelCatalogRefresh: Promise<void> | null = null;
let modelCatalogRefreshedAt = 0;
const modelCatalogErrors = new Map<string, string>();

function configuredModelCatalog(runtime: any) {
  const read = (name: string) => {
    if (process.env.MAGIC_POINTER_DISABLE_LOCAL_SECRETS === '1') return '';
    for (const root of [ROOT, FABRIC_DATA_DIR]) {
      try { return fs.readFileSync(path.join(root, 'secrets', name), 'utf8').replace(/^\uFEFF/, '').trim(); }
      catch { /* Try the same next location as ai_client.read_local_secret. */ }
    }
    return '';
  };
  const current = runtime?.model || process.env.MAGIC_POINTER_MODEL || read('model.txt') || 'gpt-4o-mini';
  const baseUrl = runtime?.baseUrl || process.env.OPENAI_BASE_URL || read('openai_base_url.txt');
  let provider = runtime?.provider || '本地';
  try {
    const url = new URL(baseUrl);
    const service = url.pathname.split('/').filter(Boolean)[0];
    provider = url.hostname === 'opencode.ai' && ['go', 'zen'].includes(service)
      ? `opencode-${service}` : url.hostname;
  } catch { /* Local endpoints may have no URL. */ }
  const discovered = runtime ? discoveredModelCatalogs.get(runtime.profileId) : null;
  const cached = discovered?.baseUrl === runtime?.baseUrl && discovered?.apiMode === runtime?.apiMode
    ? discovered?.models || [] : [];
  const entries = runtime ? (runtime.models?.length ? runtime.models : cached) : legacyModelCatalog;
  const models = entries.some((item: any) => item.id === current) ? entries : [{ id: current }, ...entries];
  return { current, provider, source: 'config', error: modelCatalogErrors.get(runtime?.profileId || 'legacy') || '',
    groups: [{ id: provider, name: provider, models }] };
}

async function getStudioModelCatalog(refresh = false) {
  if (refresh && (modelCatalogRefresh || Date.now() - modelCatalogRefreshedAt > 60_000)) {
    if (!modelCatalogRefresh) {
      modelCatalogRefresh = collectModelCatalog(fabricSettings, credentialStore, async (runtime: any) => {
        if (runtime?.models?.length) return configuredModelCatalog(runtime);
        const key = runtime?.profileId || 'legacy';
        try {
          const result = await listModels(resolveModelConfig(runtime, ROOT, FABRIC_DATA_DIR), net.fetch.bind(net));
          modelCatalogErrors.set(key, result.error || '');
          const models = (result.groups || []).flatMap((group: any) => group.models || []);
          if (result.source === 'gateway') {
            if (runtime) discoveredModelCatalogs.set(runtime.profileId, { baseUrl: runtime.baseUrl, apiMode: runtime.apiMode, models });
            else legacyModelCatalog = models;
          }
          return result;
        } catch (error) {
          modelCatalogErrors.set(key, error instanceof Error ? error.message : String(error));
          return configuredModelCatalog(runtime);
        }
      }).then(() => { modelCatalogRefreshedAt = Date.now(); }).finally(() => { modelCatalogRefresh = null; });
    }
    await modelCatalogRefresh;
  }
  return collectModelCatalog(fabricSettings, credentialStore, async (runtime: any) => configuredModelCatalog(runtime));
}

function activeModelRuntimeConfig() {
  const runtime = resolveActiveModelRuntimeConfig(fabricSettings, credentialStore);
  if (!runtime) return legacyModelCatalog.length ? { models: legacyModelCatalog } : null;
  const discovered = runtime && discoveredModelCatalogs.get(runtime.profileId);
  if (runtime && !runtime.models.length && discovered
    && discovered.baseUrl === runtime.baseUrl && discovered.apiMode === runtime.apiMode) {
    runtime.models = discovered.models;
  }
  return runtime;
}

function migrateLegacyModelProfile() {
  if (!fabricSettingsStore || !credentialStore || !fabricSettings) return;
  const profiles = Array.isArray(fabricSettings?.models?.profiles) ? fabricSettings.models.profiles : [];
  if (profiles.length) return;
  const read = (name: string) => {
    try { return fs.readFileSync(path.join(FABRIC_DATA_DIR, 'secrets', name), 'utf8').trim(); } catch (_) { return ''; }
  };
  const model = read('model.txt');
  if (!model) return;
  const baseUrl = read('openai_base_url.txt');
  const apiMode = read('model_api_mode.txt') || (baseUrl.includes('/anthropic') ? 'messages' : 'chat-completions');
  const key = read('openai_key.txt');
  if (apiMode !== 'local' && !key) return;
  if (apiMode !== 'local') {
    try { credentialStore.set(LEGACY_CREDENTIAL_REF, key); } catch (_) { return; }
  }
  const host = (() => { try { return new URL(baseUrl).hostname || 'openai'; } catch (_) { return 'openai'; } })();
  const next = promoteLegacyProfile(fabricSettings, { provider: host.replace(/[^a-z0-9._-]/gi, '') || 'openai', baseUrl, model, apiMode });
  if (next === fabricSettings) return;
  fabricSettingsStore.save(next);
  fabricSettings = next;
  log(`migrated legacy model into profile id=${LEGACY_CREDENTIAL_REF}`);
}

function withoutRawCredential(payload: any) {
  const clean = { ...(payload || {}) };
  for (const key of ['credential', 'credentialValue', 'apiKey', 'token', 'secret', 'authorization']) delete clean[key];
  return clean;
}

function handleModelCredentialOperation(operation: string, payload: any) {
  if (!credentialStore) throw new Error('credential_store_unavailable');
  const ref = modelCredentialRef(payload?.profileId);
  if (operation === 'models.credentials.status') return credentialStore.status(ref);
  if (operation === 'models.credentials.set') return credentialStore.set(ref, payload?.credentialValue);
  if (operation === 'models.credentials.delete') return credentialStore.delete(ref);
  throw new Error('credential_operation_unknown');
}


function sendPreflightEvent(preflightEvent: unknown) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send('dashboard:preflight-event', preflightEvent);
  }
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.webContents.send('onboarding:preflight-event', preflightEvent);
  }
}

async function runPreflight(payload: { stageIds?: unknown[]; userSkips?: unknown[]; source?: string } = {}, { signal = null }: { signal?: AbortSignal | null } = {}) {
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
      runtimeExecutable: process.execPath,
    }),
  });
  const stageIds = Array.isArray(payload.stageIds) ? payload.stageIds : null;
  const userSkips = Array.isArray(payload.userSkips) ? payload.userSkips : [];
  return runner.runAsync({ stageIds, userSkips, signal });
}

function startPreflight(payload: { source?: string } = {}) {
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

ipcMain.on('overlay:done', (event: Electron.IpcMainEvent, payload: any) => {
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
  placeStageOnDisplay(display);
  hideOverlay();
  runRuntimeBridge(enriched, 'electron', 'stage', {
    onComplete: (parsed: any) => {
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

ipcMain.on('overlay:gesture-start', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  markSelectionGestureDrawing(payload?.token);
});

ipcMain.on('overlay:gesture-stroke', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'overlay', resultTargetWindow)) return;
  const arm = selectionGestureArm;
  if (!arm || String(payload?.token || '') !== arm.token) return;
  const index = Number(payload?.index);
  armTemporaryGestureSubmitShortcut(arm.token);
  markSelectionGestureDrawing(arm.token, {
    timeoutMs: arm.runtime.chainGapMs + 1000,
    reason: 'chain_timeout',
  });
  log(`selection gesture stroke committed token=${arm.token} index=${Number.isFinite(index) ? index : '?'}`);
});


const SUBMIT_GROUNDING_POLL_MS = 60;

ipcMain.on('stage:submit-selection-command', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  submitSelectionCommandWhenGrounded(payload, Date.now());
});

function submitSelectionCommandWhenGrounded(payload: any, startedAt: number, noticeShown = false) {
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
  updateStage({
    selectionSessionToken,
    taskId: session.taskId,
    taskContext: interactionEpisode ? {
      sources: interactionEpisode.sources,
      references: interactionEpisode.references,
      referenceRevision: interactionEpisode.referenceRevision,
    } : null,
  });
  const continuationOwner = runningTaskContinuation(selectionSessionToken);
  if (continuationOwner && interactionEpisode?.taskInput) {
    const requestId = selectionSessions.startRequest(selectionSessionToken);
    if (!requestId) {
      deliverStageError(
        selectionSessionToken,
        '上一轮还在跑，这次补充没有送出。等它结束再发。',
      );
      return;
    }
    activeSessionAgentIds.set(selectionSessionToken, continuationOwner.taskId);
    pendingQuestions.set(selectionSessionToken, String(payload?.command || '').trim());
    beginStageLiveTurn(selectionSessionToken, payload);
    log(`stage TaskInput continuation token=${selectionSessionToken} owner=${continuationOwner.token} task=${continuationOwner.taskId}`);
    void putTaskInputToSession(
      continuationOwner.taskId,
      interactionEpisode.taskInput,
      Array.isArray(interactionEpisode.sources) ? interactionEpisode.sources : [],
    ).then((parsed: any) => {
      selectionSessions.finishRequest(selectionSessionToken, requestId);
      if (parsed?.ok !== true || parsed?.status !== 'queued') {
        deliverStageError(
          selectionSessionToken,
          `这次补充没有排入任务：${String(parsed?.error || '持久化确认缺失')}`,
        );
        return;
      }
      updateStage({
        selectionSessionToken,
        event: {
          type: 'RESULT',
          result: {
            route: { tier: 'L0' },
            taskId: continuationOwner.taskId,
            status: 'queued',
            prompt: String(payload?.command || '').trim(),
            answer: '已接收新的指向或纠正；它会在当前任务下一次安全边界前生效。',
          },
        },
      });
    }).catch((error: any) => {
      selectionSessions.finishRequest(selectionSessionToken, requestId);
      deliverStageError(
        selectionSessionToken,
        `这次补充没有送达：${String(error?.message || error || 'bridge_failed')}`,
      );
    });
    return;
  }
  cancelSessionChild(selectionSessionToken);
  const requestId = selectionSessions.startRequest(selectionSessionToken);
  if (!requestId) {
    deliverStageError(
      selectionSessionToken,
      '上一轮还在跑，这次没有发出。等它结束，或先按停止。',
    );
    return;
  }
  const effectiveCommand = String(payload?.command || '');
  const snapshotForRequest = withPickedElement(
    withKeptStrokes(session.snapshot, payload?.keptStrokeIndexes),
    payload?.pickedElement,
  );
  const enriched = {
    command: effectiveCommand,
    originalCommand: payload?.command,
    inputMode: payload?.inputMode || null,
    selectionSessionId: selectionSessionToken,
    taskId: session.taskId,
    selectionSnapshot: safeClone(snapshotForRequest),
    requestId,
    screenBounds: display.bounds,
    scaleFactor: display.scaleFactor || 1,
    source: 'pointer_stage',
    interactionEpisode,
    targetPoint: safeClone(session.snapshot?.target_point || null),
    targetPointSpace: session.snapshot?.target_point_space || null,
    replyStyle: String(payload?.replyStyle || 'normal').trim().slice(0, 20),
    requestMode: payload?.requestMode === 'agent_prompt' ? 'agent_prompt' : 'auto',
    workspaceRoot: '',
    modelRuntime: activeModelRuntimeConfig(),
    _figmaRuntimeConnections: figmaRuntime.clientConfigurations().filter(
      (connection: { taskId: string }) => connection.taskId === session.taskId,
    ),
  };
  pendingQuestions.set(selectionSessionToken, String(payload?.command || '').trim());
  beginStageLiveTurn(selectionSessionToken, payload);
  log(`stage:submit-selection-command token=${selectionSessionToken} request=${requestId} command_len=${String(enriched.command || '').length}`);
  let child: ReturnType<typeof runRuntimeBridge> | null = null;
  activeSessionAgentIds.set(selectionSessionToken, session.taskId);
  child = runRuntimeBridge(enriched, 'selection', 'stage', {
    timelineToken: selectionSessionToken,
    onProgress: (record: any) => {
      if (!selectionSessions.isCurrentRequest(selectionSessionToken, requestId)) return;
      handleAgentCursorProgress(record);
      if (record.phase === 'loop_started' && typeof record.fields?.session === 'string' && record.fields.session && record.fields.session !== '-') {
        activeSessionAgentIds.set(selectionSessionToken, record.fields.session);
      }
      appendStageLiveProgress(selectionSessionToken, record);
    },
    onComplete: (parsed: any) => {
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
      scheduleBackgroundLearning({
        enabled: fabricSettings?.privacy?.background_learning_enabled === true,
        request: parsed.learningReview,
        runBridge: runRuntimeBridge,
        log,
      });
      registerActionProposals(parsed, selectionSessionToken, 'stage');
      const autoProposal = parsed.actionProposals?.find((proposal: any) => proposal.id === parsed.autoExecuteProposalId);
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
            }, 'stage', {
              onComplete: (actionResult: any) => {
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
        log(`trusted internal auto-execute type=${autoProposal.action_type} proposal=${autoProposal.id}`);
        executeActionForTarget({
          actionToken: autoProposal.action_token,
          proposalId: autoProposal.id,
          confirmed: false,
          selectionSessionToken,
        }, 'stage', {
          onComplete: (actionResult: any) => {
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

ipcMain.handle('stage:pick-element', async (event: Electron.IpcMainInvokeEvent, payload: any) => {
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
    return await runRuntimeBridgePromise(
      { x: Math.round(x), y: Math.round(y), hwnd: Number.isFinite(hwnd) ? hwnd : 0 },
      'element_probe',
      { target: 'stage', timeoutMs: 3000 },
    );
  } catch (error) {
    log(`stage:pick-element failed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return { ok: false, error: 'element_probe_unavailable' };
  }
});

ipcMain.handle('stage:agent-sessions', async (event: Electron.IpcMainInvokeEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) {
    return { ok: false, error: 'unauthorized_stage_sender' };
  }
  const selectionSessionToken = String(payload?.selectionSessionToken || '');
  const draft = selectionSessions.getAgentPromptDraft(selectionSessionToken);
  if (!draft) return { ok: false, error: 'agent_prompt_draft_expired' };
  const packetWorkspace = draft.contextPacket?.workspace;
  const cwd = String(packetWorkspace?.cwd || ROOT);
  try {
    return await runRuntimeBridgePromise({
      operation: 'agent.sessions',
      cwd,
      cwdMatch: 'strict',
      includeMismatch: false,
      activeOnly: true,
      limit: 5,
    }, 'fabric', { target: 'stage', timeoutMs: 15000 });
  } catch (error) {
    return { ok: false, error: String((error as { message?: string })?.message || 'agent_sessions_unavailable') };
  }
});

ipcMain.handle('actions:undo', async (event: Electron.IpcMainInvokeEvent, payload: any) => {
  if (!isDashboardSender(event) && !isCompanionSender(event) && !isSurfaceSender(event, 'stage', resultTargetWindow)) {
    return { ok: false, error: 'unauthorized_renderer' };
  }
  const taskId = String(payload?.taskId || payload?.sessionId || '').trim().slice(0, 200);
  const actionId = String(payload?.actionId || payload?.action_id || '').trim().slice(0, 200);
  if (!taskId) return { ok: false, error: 'missing_task_id' };
  try {
    return await runRuntimeBridgePromise({
      operation: 'undo',
      taskId,
      actionId: actionId || undefined,
    }, 'action', { target: 'stage', timeoutMs: 15000 });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'undo_unavailable' };
  }
});

ipcMain.handle('stage:dispatch-agent-prompt', async (event: Electron.IpcMainInvokeEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) {
    return { ok: false, error: 'unauthorized_stage_sender' };
  }
  const selectionSessionToken = String(payload?.selectionSessionToken || '');
  const draft = selectionSessions.getAgentPromptDraft(selectionSessionToken);
  if (!draft) return { ok: false, error: 'agent_prompt_draft_expired' };
  try {
    const result = await runRuntimeBridgePromise({
      operation: 'agent.prompt.dispatch',
      contextPacket: draft.contextPacket,
      prompt: String(payload?.prompt || ''),
      provider: String(payload?.provider || ''),
      sessionId: String(payload?.sessionId || ''),
    }, 'fabric', { target: 'stage', timeoutMs: 30000 });
    if (result?.ok === true) selectionSessions.clearAgentPromptDraft(selectionSessionToken);
    return result;
  } catch (error) {
    return { ok: false, error: String((error as { message?: string })?.message || 'agent_prompt_dispatch_failed') };
  }
});

ipcMain.on('stage:context-action', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  const id = String(payload?.id || '');
  const token = payload?.selectionSessionToken || null;
  if (!lastStageResult || (lastStageResult.token || null) !== token) {
    log('stage:context-action rejected stale result');
    return;
  }
  const parsed = lastStageResult.parsed || {};
  if (id === 'open-route-draft' && parsed.routeDraft) {
    showDashboard({ view: 'route', routeDraft: safeClone(parsed.routeDraft) }, { activate: true });
  } else {
    log(`stage:context-action unknown id=${id}`);
  }
});

function executeActionForTarget(payload: any, target: string, options: any = {}) {
  const token = payload?.actionToken || payload?.action_token;
  const selectionSessionToken = payload?.selectionSessionToken || null;
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
  runRuntimeBridge(enriched, 'action', target, {
    onComplete: (parsed: any) => {
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

ipcMain.on('stage:execute-action', (event: Electron.IpcMainEvent, payload: any) => {
  if (isSurfaceSender(event, 'stage', resultTargetWindow)) executeActionForTarget(payload, 'stage');
});

ipcMain.on('stage:insert-result-text', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isSurfaceSender(event, 'stage', resultTargetWindow)) return;
  const selectionSessionToken = payload?.selectionSessionToken || null;
  const session = selectionSessionToken ? selectionSessions.get(selectionSessionToken) : null;
  if (!session) {
    log('stage:insert-result-text rejected expired selection session');
    deliverStageError(selectionSessionToken, '当前 THIS 已过期，请重新激活 Magic Pointer。');
    return;
  }
  const text = String(payload?.text || '').slice(0, 200000);
  if (!text.trim()) {
    deliverStageError(selectionSessionToken, '没有可填入的文字。');
    return;
  }
  const snapshot = session.snapshot || {};
  log(`stage:insert-result-text token=${selectionSessionToken} chars=${text.length}`);
  runRuntimeBridge({
    text,
    targetResolution: 'adaptive',
    currentTargetWindow: safeClone(lastStableForegroundWindow),
    targetWindow: safeClone(snapshot.source_window || {}),
    targetPoint: safeClone(snapshot.target_point || null),
    targetPointSpace: snapshot.target_point_space || null,
  }, 'deliver_text', 'stage', {
    onComplete: (parsed: any) => {
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

ipcMain.handle('stage:expand-passage', async (event: Electron.IpcMainInvokeEvent, payload: any) => {
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
  const result = await expandPassage(passage, String(payload?.context || ''),
    resolveModelConfig(activeModelRuntimeConfig(), ROOT, FABRIC_DATA_DIR),
    { fetch: net.fetch.bind(net), healthFile: path.join(FABRIC_DATA_DIR, 'model-health.json') });
  log(`stage:expand-passage outcome=${result.ok ? 'ok' : result.error} backend=${result.usedBackend} ms=${result.latencyMs}`);
  return result;
});

function isDashboardSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return Boolean(dashboardWindow && !dashboardWindow.isDestroyed() && event.sender === dashboardWindow.webContents);
}

function isCompanionSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return Boolean(companionWindow && !companionWindow.isDestroyed() && event.sender === companionWindow.webContents);
}

function isOnboardingSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return Boolean(onboardingWindow && !onboardingWindow.isDestroyed() && event.sender === onboardingWindow.webContents);
}

ipcMain.on('onboarding:start', (event: Electron.IpcMainEvent) => {
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

ipcMain.on('onboarding:continue', (event: Electron.IpcMainEvent) => {
  if (!isOnboardingSender(event) || onboardingRequired) return;
  showDashboard({ view: 'general' }, { activate: true });
  onboardingWindow?.close();
});

ipcMain.on('onboarding:cancel', (event: Electron.IpcMainEvent) => {
  if (!isOnboardingSender(event)) return;
  cancelPreflight();
  isQuitting = true;
  app.quit();
});

ipcMain.on('companion:hide', (event: Electron.IpcMainEvent) => {
  if (!isCompanionSender(event)) return;
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.hide();
});
ipcMain.on('companion:pin', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isCompanionSender(event)) return;
  companionPinned = payload?.pinned !== false;
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.setAlwaysOnTop(companionPinned);
  }
});
ipcMain.on('companion:expand', (event: Electron.IpcMainEvent) => {
  if (!isCompanionSender(event)) return;
  showPrimarySurface({ activate: true });
});

ipcMain.on('dashboard:hide', (event: Electron.IpcMainEvent) => {
  if (!isDashboardSender(event)) return;
  dashboardWindow.hide();
});
ipcMain.on('dashboard:theme', (event: Electron.IpcMainEvent, payload: any = {}) => {
  if (!isDashboardSender(event) || process.platform === 'darwin') return;
  const theme = ['light', 'dark'].includes(payload.theme) ? payload.theme : 'system';
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  try {
    dashboardWindow.setTitleBarOverlay(titleBarColors(dark ? '#F2F1ED' : '#17170F'));
  } catch (_) {
    // Window Controls Overlay is optional; renderer chrome remains usable.
  }
});
ipcMain.handle('updates:status', (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_update_status_reader');
  return updateManager?.status() || { state: app.isPackaged ? 'idle' : 'unsupported' };
});
ipcMain.handle('updates:check', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_update_check_sender');
  const manager = initializeUpdateManager({ automatic: false });
  if (!manager) return { ok: false, reason: 'update_runtime_unavailable' };
  return manager.check({ manual: true });
});
ipcMain.handle('runtime-snapshot:get', async (event: Electron.IpcMainInvokeEvent, options: any = {}) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_runtime_snapshot_sender');
  return runtimeSnapshot.get({ force: options?.force === true });
});
ipcMain.handle('extensions:inventory', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_extensions_reader' };
  return runRuntimeBridgePromise(
    { operation: 'extensions.inventory' },
    'fabric',
    { target: null, timeoutMs: 10_000 },
  );
});
ipcMain.handle('dashboard:settings:get', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_settings_reader');
  if (!fabricSettings) {
    return { ok: false, error: 'settings_not_loaded' };
  }
  return {
    ok: true,
    settings: fabricSettings,
    modelStatus: activeModelRuntimeStatus(fabricSettings, credentialStore),
  };
});

async function saveFabricSettingsPatch(rawPatch: unknown) {
  if (!fabricSettingsStore || !fabricSettings) return { ok: false, error: 'settings_not_loaded' };
  if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    return { ok: false, settings: safeClone(fabricSettings), error: '设置内容无效。' };
  }
  const previousSettings = safeClone(fabricSettings);
  let nextSettings: any;
  try {
    nextSettings = validateSettings(mergeSettingsPatch(previousSettings, rawPatch));
  } catch (error) {
    return {
      ok: false,
      settings: previousSettings,
      error: `设置没有保存：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const impact = settingsSaveImpact(previousSettings, nextSettings);
  let hotkeys: Record<string, { accelerator: string; registered: boolean; disabled?: boolean }> | null = null;
  try {
    fabricSettingsStore.save(nextSettings);
    fabricSettings = nextSettings;
    if (impact.hotkeys) {
      hotkeys = registerConfigurableHotkeys();
      const failed = Object.entries(hotkeys)
        .filter(([, result]) => result && result.registered === false && result.disabled !== true)
        .map(([name]) => name);
      if (failed.length) throw new Error(`快捷键注册失败：${failed.join('、')}`);
    }
    if (impact.gesture && wiggleDetector) {
      wiggleDetector.updateSettings({
        sensitivity: nextSettings.activation?.sensitivity,
        disabledApps: nextSettings.activation?.disabled_apps || [],
        cooldownMs: nextSettings.activation?.cooldown_ms,
      });
      cancelSelectionGesture('settings_changed');
    }
    if (impact.update) updateManager?.setChannel(nextSettings.general?.update_channel || 'stable');
    if (impact.login) {
      app.setLoginItemSettings({ openAtLogin: nextSettings.general?.launch_at_login === true });
    }
    if (impact.stash) reconfigureStashRuntime(nextSettings);
    if (impact.gesture || impact.hotkeys) applyConfiguredWakeState();
    if (impact.appearance) applyDashboardMaterial(nextSettings);
    invalidateRuntimeState('settings_changed');
    return { ok: true, settings: safeClone(nextSettings), impact, hotkeys };
  } catch (error) {
    fabricSettings = previousSettings;
    try { fabricSettingsStore.save(previousSettings); } catch (_) {}
    if (impact.hotkeys) registerConfigurableHotkeys();
    if (impact.gesture && wiggleDetector) {
      wiggleDetector.updateSettings({
        sensitivity: previousSettings.activation?.sensitivity,
        disabledApps: previousSettings.activation?.disabled_apps || [],
        cooldownMs: previousSettings.activation?.cooldown_ms,
      });
    }
    if (impact.stash) reconfigureStashRuntime(previousSettings);
    applyConfiguredWakeState();
    applyDashboardMaterial(previousSettings);
    return {
      ok: false,
      settings: safeClone(previousSettings),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

ipcMain.handle('slash:directory', async (event: Electron.IpcMainInvokeEvent) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_slash_directory' };
  try {
    const parsed = await runRuntimeBridgePromise(
      { operation: 'slash.directory' },
      'fabric',
      { target: 'fabric-dashboard', timeoutMs: 10000 },
    );
    return parsed ?? { ok: false, error: 'slash_directory_failed' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('models:catalog', async (event: Electron.IpcMainInvokeEvent, options: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_catalog_reader' };
  try {
    const catalog = await getStudioModelCatalog(options.refresh === true);
    return { ok: true, catalog };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('models:quota', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_quota_reader' };
  const runtime = activeModelRuntimeConfig();
  if (!runtime) return { ok: false, error: 'no_active_model_profile' };
  const key = String(runtime.profileId || runtime.provider || 'active');
  const force = raw?.force === true;
  const cached = quotaCache.get(key);
  if (!force && cached && Date.now() - cached.at < QUOTA_CACHE_TTL_MS) {
    return { ok: true, quota: cached.report };
  }
  try {
    const report = await probeQuota({
      provider: runtime.provider,
      baseUrl: runtime.baseUrl,
      apiMode: runtime.apiMode,
      credential: runtime.credential,
    });
    quotaCache.set(key, { at: Date.now(), report });
    return { ok: true, quota: report };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('models:select', async (event: Electron.IpcMainInvokeEvent, raw: any = {}) => {
  if (!isDashboardSender(event)) return { ok: false, error: 'unauthorized_model_select' };
  return selectRuntimeModel(raw?.model, raw?.profileId);
});

async function selectRuntimeModel(raw: unknown, profileId?: unknown): Promise<{ ok: boolean; model?: string; profileId?: string | null; error?: string }> {
  const model = String(raw || '').trim().slice(0, 120);
  if (!model || [...model].some(char => char === '\\' || char.charCodeAt(0) < 32)) {
    return { ok: false, error: '模型名无效。' };
  }
  try {
    const selectedSettings = selectActiveProfileModel(fabricSettings, model, profileId);
    if (selectedSettings) {
      const saved = await saveFabricSettingsPatch({ models: selectedSettings.models });
      if (saved?.ok !== true) return saved;
      invalidateRuntimeState('model_selected');
      return { ok: true, model, profileId: selectedSettings.models?.defaultProfileId || null };
    }
    if (profileId) return { ok: false, error: '所选模型的服务商配置不可用。' };
    if (process.env.MAGIC_POINTER_MODEL) {
      return { ok: false, error: '环境变量 MAGIC_POINTER_MODEL 覆盖模型文件，请先移除该覆盖。' };
    }
    const secretsDir = fs.existsSync(path.join(ROOT, 'secrets'))
      ? path.join(ROOT, 'secrets') : path.join(FABRIC_DATA_DIR, 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, 'model.txt'), `${model}\n`, 'utf8');
    invalidateRuntimeState('model_selected');
    return { ok: true, model };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

ipcMain.handle('dashboard:settings:save', async (event: Electron.IpcMainInvokeEvent, payload: any = {}) => {
  if (!isDashboardSender(event)) throw new Error('unauthorized_settings_writer');
  return saveFabricSettingsPatch(payload?.settings);
});

ipcMain.on('dashboard:fabric-request', (event: Electron.IpcMainEvent, payload: any) => {
  if (!isDashboardSender(event)) return;
  const operation = typeof payload?.operation === 'string' ? payload.operation : '';
  if (operation === 'settings.save') {
    void saveFabricSettingsPatch(payload?.settings).then((result) => {
      sendBridgeResult('fabric-dashboard', { ...result, fabricOperation: operation });
    });
    return;
  }
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
        error: error instanceof Error ? error.message : String(error),
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
  runRuntimeBridge({
    ...bridgePayload,
    operation,
  }, 'fabric', 'fabric-dashboard', {
    onComplete: (parsed: any) => {
      if (
        parsed?.ok === true
        && ['models.save', 'models.delete', 'models.set_default', 'models.test'].includes(operation)
      ) {
        try {
          fabricSettings = fabricSettingsStore.load();
        } catch (error) {
          log(`model settings reload failed ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
        }
      }
      if (operation === 'settings.save' && parsed?.ok === true && parsed?.settings) {
        const previousSettings = fabricSettings;
        const gestureContractChanged = gestureRuntimeSettingsChanged(previousSettings, parsed.settings);
        fabricSettings = parsed.settings;
        if (wiggleDetector) {
          wiggleDetector.updateSettings({
            sensitivity: parsed.settings.activation?.sensitivity,
            disabledApps: parsed.settings.activation?.disabled_apps || [],
            cooldownMs: parsed.settings.activation?.cooldown_ms,
          });
        }
        parsed.hotkeys = registerConfigurableHotkeys();
        const failedHotkeys = Object.entries(parsed.hotkeys as Record<string, { accelerator: string; registered: boolean; disabled?: boolean }>)
          .filter(([, result]) => result && result.registered === false && result.disabled !== true)
          .map(([name]) => name);
        if (failedHotkeys.length) {
          fabricSettings = previousSettings;
          try {
            fabricSettingsStore.save(previousSettings);
          } catch (error) {
            log(`settings hotkey rollback persistence failed ${error instanceof Error ? error.name : 'Error'}`);
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
          log(`login item settings save failed ${error instanceof Error ? error.name : 'Error'}`);
        }
      }
      if (operation.startsWith('models.') && parsed?.ok === true && fabricSettingsStore) {
        try {
          fabricSettings = fabricSettingsStore.load();
        } catch (error) {
          log(`model settings refresh failed ${error instanceof Error ? error.name : 'Error'}`);
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
ipcMain.on('dashboard:route-open', async (event: Electron.IpcMainEvent, payload: any) => {
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
      error: `无法打开默认浏览器：${error instanceof Error ? error.message : String(error)}`,
    });
  }
});
