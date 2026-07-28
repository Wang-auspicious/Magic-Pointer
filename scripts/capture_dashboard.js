const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const captureUserData = path.join(root, '.tmp', 'dashboard-capture-user-data');
fs.mkdirSync(captureUserData, { recursive: true });
app.setPath('userData', captureUserData);
const outputPath = path.resolve(process.env.MAGIC_POINTER_DASHBOARD_CAPTURE || path.join(
  root,
  'data',
  'runtime',
  'dashboard-shell-20260727.png',
));
const captureView = process.env.MAGIC_POINTER_DASHBOARD_VIEW || 'overview';
const captureTheme = process.env.MAGIC_POINTER_DASHBOARD_THEME || 'system';

const settings = {
  activation: {
    wiggle_enabled: true,
    sensitivity: 0.55,
    fallback_hotkey_enabled: true,
    fallback_hotkey: 'Control+Alt+M',
    disabled_apps: [],
  },
  interaction: {
    default_input_mode: 'voice',
    voice_auto_submit: true,
    voice_language: 'auto',
    voice_output_mode: 'verbatim',
    voice_hallucination_guard: true,
    voice_silence_ms: 1600,
    voice_glossaries: {},
  },
  privacy: {
    upload_screenshots: false,
    default_capture_mode: 'structured_only',
    app_capture_modes: {
      '1Password.exe': 'deny',
      'Microsoft Edge': 'upload_screenshot',
      'WINWORD.EXE': 'structured_only',
      'Figma.exe': 'local_screenshot',
    },
    retain_captures_days: 3,
    retain_artifacts_days: 30,
    retain_audit_days: 30,
    sensitive_apps: [],
  },
  permissions: {
    default_read: 'allow',
    default_write: 'confirm',
    default_send: 'confirm',
    default_destructive: 'confirm',
    default_purchase: 'deny',
    scoped_grants: [],
  },
  agents: {
    preferred: 'codex',
    delivery_mode: 'active_session',
    cwd_match: 'strict',
    image_policy: 'vision_only',
    auto_attach: true,
    session_bindings: { codex: '019f6e3e-1f1c-7631-95ab-f0de61f45dca' },
  },
  connections: {
    browser_devtools_enabled: true,
    browser_devtools_endpoints: ['http://127.0.0.1:9222'],
  },
  recipe_enabled: {},
};

const responses = {
  'settings.get': { settings },
  'settings.save': { settings },
  'browser.status': {
    state: 'unavailable',
    configuredEndpointCount: 1,
    reachableEndpointCount: 0,
    pageCount: 0,
    endpoints: ['http://127.0.0.1:9222'],
    reason: 'cdp_endpoint_unavailable',
  },
  catalog: {
    recipes: [
      { id: 'agent.handoff', title: '交给现有 Agent', description: '把当前对象、指令与来源证据送进已连接的工作会话。', risk: 'external_send', providerStrategies: ['native session', 'structured CLI'] },
      { id: 'text.explain', title: '解释选中的内容', description: '在不离开当前应用的前提下理解、翻译或朗读文本。', risk: 'read', providerStrategies: ['local text', 'model'] },
      { id: 'document.extract', title: '提取文档结构', description: '优先读取结构化文字与表格，必要时使用本地 OCR。', risk: 'read', providerStrategies: ['UIA', 'RapidOCR'] },
    ],
  },
  providers: {
    providers: [
      { id: 'codex', name: 'Codex', available: true, protocols: ['app-server'], version: 'local' },
      { id: 'gemini', name: 'Gemini', available: true, protocols: ['ACP'], version: 'local' },
      { id: 'pi', name: 'Pi', available: false, protocols: ['RPC'], installHint: '未检测到运行时' },
    ],
  },
  'agent.sessions': {
    cwd: 'D:\\Desktop\\Magic Pointer',
    sessions: [
      { provider: 'codex', sessionId: '019f6e3e-1f1c-7631-95ab-f0de61f45dca', cwd: 'D:\\Desktop\\Magic Pointer', lastActiveAt: '2026-07-27T18:52:29Z', state: 'recent', transport: 'exec-resume-jsonl', cwdMatch: 'strict' },
      { provider: 'claude', sessionId: 'ba4720b0-43bd-4fe9-bec0-341c4c2a7e3e', cwd: 'D:\\Desktop\\Magic Pointer', lastActiveAt: '2026-07-27T18:45:19Z', state: 'recent', transport: 'print-resume-stream-json', cwdMatch: 'strict' },
      { provider: 'codex', sessionId: '019f6e3e-1f3c-7dd2-9c52-c4ce4e4cb11d', cwd: 'D:\\Desktop\\Magic Pointer', lastActiveAt: '2026-07-17T04:03:17Z', state: 'resumable', transport: 'exec-resume-jsonl', cwdMatch: 'strict' },
    ],
  },
  'models.list': {
    defaultProfileId: 'primary',
    models: [{
      id: 'primary',
      displayName: '主模型',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      model: 'vision-model',
      apiMode: 'responses',
      overrides: { visionInput: 'auto' },
      resolved: {
        visionInput: 'yes',
        source: 'explicit_probe',
        evidence: 'user-requested 1x1 image capability probe',
        checkedAt: '2026-07-27T18:42:00+08:00',
      },
    }],
  },
  'audit.tail': {
    events: [
      { timestamp: '2026-07-27T15:42:06+08:00', type: 'recipe.executed', data: { recipeId: 'agent.handoff', status: 'succeeded' } },
      { timestamp: '2026-07-27T15:47:18+08:00', type: 'recipe.executed', data: { recipeId: 'document.extract', status: 'accepted' } },
      {
        timestamp: '2026-07-27T17:58:24+08:00',
        type: 'perception.resolved',
        data: {
          selectedLayer: 'uia',
          selectedAdapter: 'uia_text_selection',
          selectedMethod: 'uia:element-from-point',
          pixelFallbackUsed: false,
          fallbackReason: null,
          policyMode: 'local_screenshot',
        },
      },
      { timestamp: '2026-07-27T19:17:59+08:00', type: 'recipe.planned', data: { planId: 'n09-plan', recipeId: 'agent.handoff', provider: 'agent.task', risk: 'external_send', objectCount: 1, requiresConfirmation: true, workspaceBindingState: 'bound', workspaceBindingRelation: 'window_process', targetProcessBound: true, workspaceProcessBound: true } },
      { timestamp: '2026-07-27T19:18:03+08:00', type: 'recipe.executed', data: { planId: 'n09-plan', receiptId: 'n09-receipt', recipeId: 'agent.handoff', provider: 'agent.task', status: 'accepted', verified: false, workspaceBindingState: 'bound', workspaceBindingRelation: 'window_process', targetProcessBound: true, workspaceProcessBound: true } },
      { timestamp: '2026-07-27T20:14:04+08:00', type: 'terminal.evidence', data: { snapshotId: 'n10-terminal-live', state: 'resolved', method: 'uia:terminal-text-pattern', exitCodeObserved: true, exitCode: 7, windowLineCount: 8, pixelFallbackUsed: false } },
      { timestamp: '2026-07-27T20:14:05+08:00', type: 'recipe.planned', data: { planId: 'n10-plan', recipeId: 'agent.handoff', provider: 'agent.task', risk: 'external_send', objectCount: 1, requiresConfirmation: true, terminalEvidenceState: 'resolved', terminalEvidenceMethod: 'uia:terminal-text-pattern', terminalExitCodeObserved: true, terminalExitCode: 7, terminalWindowLineCount: 8 } },
      { timestamp: '2026-07-27T21:15:46+08:00', type: 'browser.evidence', data: { snapshotId: 'n11-browser-live', state: 'resolved', method: 'cdp:dom-point', selectorObserved: true, accessibleNameObserved: true, networkFailureCount: 1, coordinatesObserved: true, pixelFallbackUsed: false } },
      { timestamp: '2026-07-27T21:15:47+08:00', type: 'recipe.planned', data: { planId: 'n11-plan', recipeId: 'agent.handoff', provider: 'agent.task', risk: 'external_send', objectCount: 1, requiresConfirmation: true, browserEvidenceState: 'resolved', browserEvidenceMethod: 'cdp:dom-point', browserSelectorObserved: true, browserAccessibleNameObserved: true, browserNetworkFailureCount: 1, browserCoordinatesObserved: true, componentLinkState: 'ambiguous', componentCandidateCount: 3, componentTopConfidence: 0.78, componentAutoModificationAllowed: false } },
    ],
  },
  'artifacts.list': { artifacts: [] },
  'task.list': {
    tasks: [{
      taskId: '7d41c9f0-42a1-4a77-97fe-19b6ed6ac1ef',
      provider: 'pi',
      status: 'paused_target_mismatch',
      attempt: 1,
      targetLease: {
        state: 'reconfirmation_required',
        reason: 'stale_target_window',
        confirmationRequired: true,
        lease: {
          revision: 1,
          window: { title: 'Design review · Figma' },
        },
      },
    }],
  },
};

ipcMain.on('dashboard:fabric-request', (event, payload = {}) => {
  const response = responses[payload.operation] || {};
  event.sender.send('dashboard:fabric-state', {
    ok: true,
    fabricOperation: payload.operation,
    ...response,
  });
});
ipcMain.on('dashboard:request-state', event => event.sender.send('dashboard:state', { ok: true, state: { items: [] } }));
ipcMain.on('dashboard:theme', () => {});
ipcMain.on('dashboard:hide', () => app.quit());

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: 'Magic Pointer',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(1, 0, 0, 0)',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f5f7' : '#1d1d1f',
      height: 46,
    },
    backgroundMaterial: process.platform === 'win32' ? 'mica' : undefined,
    backgroundColor: process.platform === 'win32'
      ? '#00000000'
      : (nativeTheme.shouldUseDarkColors ? '#161719' : '#f5f5f7'),
    show: false,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(root, 'electron', 'renderer', 'dashboard.html'));
  win.show();
  win.webContents.send('dashboard:show', {});
  await new Promise(resolve => setTimeout(resolve, 900));
  await win.webContents.executeJavaScript(`applyTheme(${JSON.stringify(captureTheme)})`);
  await win.webContents.executeJavaScript(`setActiveView(${JSON.stringify(captureView)})`);
  await new Promise(resolve => setTimeout(resolve, 180));
  const renderedView = await win.webContents.executeJavaScript('activeView');
  const image = await win.capturePage();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, image.toPNG());
  process.stdout.write(`${outputPath}\nview=${captureView} rendered=${renderedView}\n`);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
