import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { BROWSER_DOM_PROBE_SCRIPT, BROWSER_DOM_REGION_PROBE_SCRIPT, BROWSER_DOCUMENT_READ_SCRIPT, EXCEL_REGION_SCRIPT, EXCEL_SELECTION_SCRIPT, POWERPOINT_NATIVE_WINDOW_SCRIPT, POWERPOINT_SELECTION_SCRIPT } from './desktop_scripts';
import { POWERPOINT_TEXT_STYLE_SCRIPT } from './powerpoint_text_styles';
import { runPowerShellJson, probeSelection, listElements, listWindows, nativeRequest, delay, type DesktopRecord, type DesktopWindow } from './desktop';

export interface AdapterContext extends DesktopRecord { adapter: string; app: string; content: string; method: string; window: DesktopRecord; artifacts: DesktopRecord; error?: string | null }
export interface SurfaceAdapter { id: string; matches(window: DesktopRecord): boolean; resolve(window: DesktopRecord, request?: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> }
export function officeSelectionError(app: string, messages: string[] = []): string | null {
  return messages.filter(message => app !== 'powerpoint' || message !== 'No shape selection; returned current slide structure.')
    .join('; ') || null;
}
export class SurfaceAdapterRegistry {
  private adapters = new Map<string, SurfaceAdapter>();
  register(adapter: SurfaceAdapter): () => void { if (this.adapters.has(adapter.id)) throw new Error(`duplicate surface adapter:${adapter.id}`); this.adapters.set(adapter.id, adapter); return () => { if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id); }; }
  matching(window: DesktopRecord): SurfaceAdapter[] { return [...this.adapters.values()].filter(adapter => adapter.matches(window)); }
  async resolve(window: DesktopRecord, request: DesktopRecord = {}, signal?: AbortSignal): Promise<DesktopRecord[]> { return Promise.all(this.matching(window).map(adapter => adapter.resolve(window, request, signal))); }
}

export function officeApp(window: DesktopRecord): string | undefined {
  const classes: Record<string, string> = { XLMAIN: 'excel', OpusApp: 'word', PPTFrameClass: 'powerpoint' };
  if (classes[window.class_name]) return classes[window.class_name];
  const name = `${window.process_name || ''} ${window.title || ''}`.toLowerCase();
  if (/excel|\.xlsx?\b/.test(name)) return 'excel'; if (/winword|word|wps writer|\.docx?\b/.test(name)) return 'word'; if (/powerpnt|powerpoint|\.pptx?\b/.test(name)) return 'powerpoint';
  return undefined;
}

export async function readOffice(window: DesktopRecord, options: { region?: DesktopRecord; signal?: AbortSignal } = {}): Promise<AdapterContext> {
  const app = officeApp(window); const hwnd = Number(window.hwnd);
  if (!app || !Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error('office_captured_window_required');
  let data: DesktopRecord;
  if (app === 'excel') {
    let script = (options.region ? EXCEL_REGION_SCRIPT : EXCEL_SELECTION_SCRIPT).replaceAll('__TARGET_HWND__', String(hwnd));
    for (const [key, token] of Object.entries({ x: 'region_x', y: 'region_y', width: 'region_w', height: 'region_h' })) script = script.replaceAll(`{${token}}`, String(Math.round(Number(options.region?.[key] || 0))));
    data = await runPowerShellJson(script, options.signal);
  } else if (app === 'powerpoint') {
    const script = POWERPOINT_SELECTION_SCRIPT
      .replace('__TARGET_HWND__', String(hwnd))
      .replace('__NATIVE_WINDOW__', POWERPOINT_NATIVE_WINDOW_SCRIPT)
      .replace('function Read-Shape([object]$shape, [object]$parentShapeId) {',
        `${POWERPOINT_TEXT_STYLE_SCRIPT}\nfunction Read-Shape([object]$shape, [object]$parentShapeId) {`)
      .replace('    text=$text\n    parent_shape_id=$parentShapeId',
        '    text=$text\n    styleSpans=@(if($text){Read-MpTextStyles $shape.TextFrame.TextRange})\n    parent_shape_id=$parentShapeId');
    if (!script.includes('styleSpans=@(')) throw new Error('powerpoint_style_probe_unavailable');
    data = await runPowerShellJson(script, options.signal);
  }
  else {
    const progId = /wps (office|writer)/i.test(window.title || '') ? 'KWPS.Application' : 'Word.Application';
    data = await runPowerShellJson(`$app=[Runtime.InteropServices.Marshal]::GetActiveObject('${progId}')
$win=@($app.Windows) | Where-Object { [int64]$_.Hwnd -eq ${hwnd} } | Select-Object -First 1
if($null -eq $win){throw 'office_window_mismatch'}
$doc=$win.Document
$sel=$win.Selection
@{hwnd=[int64]$win.Hwnd;document=[string]$doc.FullName;document_name=[string]$doc.Name;document_saved=[bool]$doc.Saved;selection_start=[int]$sel.Start;selection_end=[int]$sel.End;text=$(if($sel.End -gt $sel.Start){[string]$sel.Text}else{''});com_prog_id='${progId}'} | ConvertTo-Json -Depth 8 -Compress`, options.signal);
  }
  if (Number(data.hwnd) !== hwnd) throw new Error(`office_window_mismatch:${data.messages || ''}`);
  const path = String(data.document || data.workbook || data.presentation || '');
  const host = app === 'word' ? data.com_prog_id === 'KWPS.Application' ? 'wps_writer' : 'microsoft_word' : `microsoft_${app}`;
  let content = String(data.text || ''), locators: DesktopRecord[] = [];
  if (app === 'word') locators = [{ kind: 'text', value: { story: 'selection', start: data.selection_start, end: data.selection_end } }];
  if (app === 'excel') { content = (data.rows || []).map((row: DesktopRecord[]) => row.map(cell => cell.formula || cell.text || cell.value || '').join('\t')).join('\n'); locators = [{ kind: 'cell-range', value: { workbook: path, sheet: data.worksheet, range: data.address } }]; }
  if (app === 'powerpoint') { content = (data.shapes || []).map((shape: DesktopRecord) => shape.text || shape.name).join('\n'); locators = (data.shapes || []).map((shape: DesktopRecord) => ({ kind: 'slide-shape', value: { slideId: data.slide_id, shapeId: shape.shape_id, parentShapeId: shape.parent_shape_id } })); }
  return { adapter: 'office', app, content, method: data.method || `com:${app}.selection`, window, label: path || app, artifacts: { ...data, document: path, document_saved: data.document_saved ?? data.workbook_saved ?? data.presentation_saved, source_identity: { ...(isAbsolute(path) ? { absolutePath: path } : { documentName: path }), hwnd, host }, locators, ...(app === 'word' ? { selection_text_sha256: createHash('sha256').update(content).digest('hex'), selection_text_chars: content.length } : {}) }, error: officeSelectionError(app, data.messages || []) };
}

export class FigmaClient {
  readonly config: DesktopRecord;
  constructor(config: DesktopRecord) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !config.taskId || !config.documentSessionId || String(config.controlToken || '').length < 24) throw new Error('figma_runtime_identity_incomplete');
    this.config = { ...config, baseUrl: String(config.baseUrl).replace(/\/$/, '') };
  }
  get task_id(): string { return this.config.taskId; }
  get document_session_id(): string { return this.config.documentSessionId; }
  async json(method: string, path: string, body?: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> {
    const timeout = AbortSignal.timeout(Number(this.config.requestTimeoutS || 5) * 1000);
    const response = await fetch(this.config.baseUrl + path, { method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Authorization: `Bearer ${this.config.controlToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`figma_bridge_http_${response.status}`);
    return await response.json() as DesktopRecord;
  }
  async request(operation: string, args: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> {
    if (!['read_selection', 'read_nodes', 'read_parent', 'export_preview', 'apply_patch', 'readback'].includes(operation)) throw new Error(`unsupported_figma_operation:${operation}`);
    const timeoutMs = Math.max(100, Number(this.config.resultTimeoutS || 30) * 1000);
    const queued = await this.json('POST', '/requests', { taskId: this.task_id, documentSessionId: this.document_session_id, operation, arguments: args, timeoutMs }, signal);
    if (!queued.commandId) throw new Error(queued.error || 'figma_command_not_queued');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.json('GET', `/results/${encodeURIComponent(queued.commandId)}`, undefined, signal);
      if (result.status === 'completed') return result.result;
      if (['failed', 'cancelled'].includes(result.status)) throw new Error(result.error || `figma_command_${result.status}`);
      await delay(Math.max(10, Number(this.config.pollIntervalS || 0.1) * 1000), signal);
    }
    throw new Error(`figma_command_timeout:${queued.commandId}`);
  }
}

export interface CdpEventSource { onEvent(handler: (method: string, params: DesktopRecord) => void): void; request(method: string, params?: DesktopRecord): Promise<DesktopRecord> }
export class CdpConnection implements CdpEventSource {
  private sequence = 0;
  private pending = new Map<number, { accept(value: DesktopRecord): void; reject(error: Error): void }>();
  private listeners: ((method: string, params: DesktopRecord) => void)[] = [];
  private socket: WebSocket;
  readonly opened: Promise<void>;
  constructor(url: string, readonly signal?: AbortSignal) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((accept, reject) => { this.socket.addEventListener('open', () => accept(), { once: true }); this.socket.addEventListener('error', () => reject(new Error('cdp_connection_failed')), { once: true }); });
    this.socket.addEventListener('message', event => { const data = JSON.parse(String(event.data));
      if (data.method && data.id === undefined) { for (const listener of this.listeners) listener(String(data.method), data.params || {}); return; }
      const pending = this.pending.get(data.id); if (!pending) return; this.pending.delete(data.id); if (data.error) pending.reject(new Error(data.error.message)); else pending.accept(data.result); });
    this.socket.addEventListener('close', () => { for (const pending of this.pending.values()) pending.reject(new Error('cdp_connection_closed')); this.pending.clear(); });
    signal?.addEventListener('abort', () => this.close(), { once: true });
  }
  onEvent(handler: (method: string, params: DesktopRecord) => void): void { this.listeners.push(handler); }
  async request(method: string, params: DesktopRecord = {}): Promise<DesktopRecord> { await this.opened; this.signal?.throwIfAborted(); const id = ++this.sequence; return new Promise((accept, reject) => { this.pending.set(id, { accept, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  close(): void { this.socket.close(); }
}
const NETWORK_ERROR = /net::ERR_|failed to load resource|networkerror|http error|status (?:4|5)\d\d/i;
/**
 * What went wrong on the page, from DevTools: failed requests, network log lines and HTTP errors seen by
 * resource timing, plus JavaScript console errors. Log.enable replays entries buffered before we attached.
 */
export async function collectDevtoolsFailures(connection: CdpEventSource, resourceFailures: DesktopRecord[] = [], drainMs = 180): Promise<{ networkFailures: DesktopRecord[]; consoleErrors: DesktopRecord[]; uncertainty: string[] }> {
  const failures: DesktopRecord[] = [], consoleErrors: DesktopRecord[] = [], urls = new Map<string, string>();
  const stamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : new Date().toISOString();
  connection.onEvent((method, params) => {
    if (method === 'Network.requestWillBeSent') { const id = String(params.requestId || ''); if (id) urls.set(id, String(params.request?.url || '')); }
    else if (method === 'Network.loadingFailed') { const id = String(params.requestId || ''); failures.push({ url: urls.get(id) || '', errorText: String(params.errorText || ''), source: 'network.loadingFailed', timestamp: new Date().toISOString(), requestId: id }); }
    else if (method === 'Log.entryAdded') {
      const entry = params.entry || {}, text = String(entry.text || '');
      if (String(entry.source || '').toLowerCase() === 'network' || NETWORK_ERROR.test(text)) failures.push({ url: String(entry.url || ''), errorText: text, source: 'devtools_log', timestamp: stamp(entry.timestamp) });
      else if (entry.level === 'error') consoleErrors.push({ text: text.slice(0, 2000), url: String(entry.url || ''), line: entry.lineNumber ?? null, source: String(entry.source || ''), timestamp: stamp(entry.timestamp) });
    }
  });
  await connection.request('Network.enable');
  await connection.request('Log.enable');
  await delay(drainMs);
  for (const resource of resourceFailures.slice(0, 20)) failures.push({ url: String(resource.url || ''), errorText: `HTTP ${Number(resource.responseStatus || 0)}`, status: resource.responseStatus ?? null, source: 'resource_timing', timestamp: '' });
  const seen = new Set<string>(), networkFailures = failures.slice(-40).filter(item => { const key = `${item.url}\n${item.errorText}\n${item.source}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(-20);
  const consoleSeen = new Set<string>();
  return { networkFailures, consoleErrors: consoleErrors.filter(item => !consoleSeen.has(item.text) && !!consoleSeen.add(item.text)).slice(-20),
    uncertainty: networkFailures.length ? [] : ['no_network_failure_observed_in_devtools_log_or_resource_timing'] };
}

export async function evaluateBrowser(endpoint: string, targetId: string, expression: string, signal?: AbortSignal): Promise<DesktopRecord> {
  const timeout = AbortSignal.timeout(12000); const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/list`, { signal: combined });
  if (!response.ok) throw new Error(`cdp_http_${response.status}`);
  const targets = await response.json() as DesktopRecord[];
  const target = targets.find(row => row.id === targetId && row.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('browser_target_unavailable');
  const connection = new CdpConnection(target.webSocketDebuggerUrl, combined);
  try {
    const result = await connection.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'browser_evaluation_failed');
    return result.result?.value ?? {};
  } finally { connection.close(); }
}

export async function readBrowser(request: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> {
  const endpoint = String(request.endpoint || request.cdpEndpoint || request.browserInstanceId || '');
  if (!endpoint || !request.targetId || !request.documentEpoch) throw new Error('browser_exact_identity_required');
  const version = await (await fetch(`${endpoint.replace(/\/$/, '')}/json/version`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })).json() as DesktopRecord;
  const processIdentity = version.webSocketDebuggerUrl || endpoint;
  const instance = request.browserInstanceId || endpoint;
  if (instance !== endpoint && instance !== processIdentity || request.browserProcessIdentity && request.browserProcessIdentity !== processIdentity) throw new Error('browser_instance_changed');
  const result = await evaluateBrowser(endpoint, request.targetId, `(${BROWSER_DOCUMENT_READ_SCRIPT})(${JSON.stringify(request)})`, signal);
  if (result.documentEpoch !== request.documentEpoch) return { ...result, browserInstanceId: instance, targetId: request.targetId, nodes: [], complete: false, limitations: ['browser_document_epoch_changed'] };
  return { ...result, browserInstanceId: instance, browserProcessIdentity: processIdentity, targetId: request.targetId, usedBackend: 'cdp_document' };
}

export async function readBrowserSelection(window: DesktopRecord, request: DesktopRecord = {}, signal?: AbortSignal): Promise<AdapterContext> {
  const endpoints = request.endpoint ? [request.endpoint] : String(process.env.MAGIC_POINTER_CDP_ENDPOINTS || 'http://127.0.0.1:9222,http://127.0.0.1:9223,http://127.0.0.1:9224,http://127.0.0.1:9333').split(',');
  const errors: string[] = [];
  const resolved: DesktopRecord[] = [];
  const browserPid = async (version: DesktopRecord): Promise<number> => {
    if (!version.webSocketDebuggerUrl) return 0;
    const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500);
    const connection = new CdpConnection(String(version.webSocketDebuggerUrl), timeout);
    try {
      const info = await connection.request('SystemInfo.getProcessInfo', {});
      const browsers = (info.processInfo || []).filter((item: DesktopRecord) => item.type === 'browser');
      const pid = browsers.length === 1 ? Number(browsers[0].id) : 0;
      return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
    } catch { signal?.throwIfAborted(); return 0; }
    finally { connection.close(); }
  };
  const samePhysicalWindow = (result: DesktopRecord): boolean => {
    const browser = result.browserWindow || {}, bounds = window.bbox || [];
    const values = [browser.screenX, browser.screenY, browser.outerWidth, browser.outerHeight, ...bounds].map(Number);
    if (Number(browser.devicePixelRatio) !== 1 || values.length !== 8 || !values.every(Number.isFinite)) return false;
    const [x, y, width, height, left, top, right, bottom] = values;
    return width > 0 && height > 0 && [x - left, y - top, x + width - right, y + height - bottom]
      .every(offset => Math.abs(offset) <= 8);
  };
  for (const endpoint of endpoints) {
    try {
      const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(600)]) : AbortSignal.timeout(600);
      const pages = await (await fetch(`${endpoint}/json/list`, { signal: timeout })).json() as DesktopRecord[];
      const version = await (await fetch(`${endpoint}/json/version`, { signal: timeout })).json() as DesktopRecord;
      const candidates = pages.filter(row => row.type === 'page' && (!request.targetId || row.id === request.targetId));
      for (const page of candidates) {
        const input = { point: request.point, region: request.region, outerBBox: window.bbox, sampleStep: 48 };
        const probe = request.region ? BROWSER_DOM_REGION_PROBE_SCRIPT : BROWSER_DOM_PROBE_SCRIPT;
        const result = await evaluateBrowser(endpoint, page.id, `(() => {
          const visibilityState = document.visibilityState;
          if (visibilityState !== 'visible') return { state: 'background_tab', page: { visibilityState } };
          const result = (${probe})(${JSON.stringify(input)});
          return { ...result, page: { ...(result.page || {}), visibilityState }, browserWindow: {
            screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth,
            outerHeight: window.outerHeight, devicePixelRatio: window.devicePixelRatio,
          } };
        })()`, signal);
        if (!result || result.state !== 'resolved' || result.page?.visibilityState !== 'visible' || result.coordinates?.hitTestVerified === false) continue;
        if (!request.targetId && result.page?.title && !String(window.title).includes(result.page.title)) continue;
        resolved.push({ result, page, endpoint, version });
      }
    } catch (error) { signal?.throwIfAborted(); errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (!resolved.length) throw new Error(errors.join('; ') || 'browser_target_unmatched');
  const endpointVersions = [...new Map(resolved.map(item => [String(item.endpoint), item.version])).entries()];
  const [nativeWindows, endpointPids] = await Promise.all([
    listWindows(signal).catch(error => { signal?.throwIfAborted(); errors.push(String(error)); return []; }),
    Promise.all(endpointVersions.map(async ([endpoint, version]) => [endpoint, await browserPid(version)] as const)),
  ]);
  const pids = new Map(endpointPids), targetPid = Number(window.pid ?? window.processId);
  const peers = nativeWindows.filter(item => Number(item.pid) === targetPid);
  const target = peers.find(item => Number(item.hwnd) === Number(window.hwnd));
  const sameBounds = (a: DesktopRecord, b: DesktopRecord): boolean =>
    Array.isArray(a.bbox) && Array.isArray(b.bbox) && a.bbox.length === 4 && b.bbox.length === 4 &&
    a.bbox.every((value: number, index: number) => Math.abs(value - Number(b.bbox[index])) <= 8);
  const uniqueWindow = target && peers.filter(item => sameBounds(item, target)).length === 1;
  const bound = target && Number.isSafeInteger(targetPid) && targetPid > 0
    ? resolved.filter(item => pids.get(String(item.endpoint)) === targetPid &&
      (peers.length === 1 || uniqueWindow && samePhysicalWindow(item.result)))
    : [];
  if (bound.length !== 1) throw new Error('browser_target_ambiguous');
  const { result, page, endpoint, version } = bound[0]; const epoch = result.page?.documentEpoch || result.documentEpoch;
  const { resourceFailures = [], ...dom } = result;
  let failures: DesktopRecord = { networkFailures: [], consoleErrors: [], uncertainty: ['devtools_failure_probe_unavailable'] };
  if (page.webSocketDebuggerUrl) {
    const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500);
    const connection = new CdpConnection(String(page.webSocketDebuggerUrl), timeout);
    try { failures = await collectDevtoolsFailures(connection, Array.isArray(resourceFailures) ? resourceFailures : []); }
    catch { signal?.throwIfAborted(); }
    finally { connection.close(); }
  }
  const browserContext = { ...dom, networkFailures: failures.networkFailures, consoleErrors: failures.consoleErrors, uncertainty: [...(Array.isArray(dom.uncertainty) ? dom.uncertainty : []), ...failures.uncertainty],
    provenance: { ...result.provenance, endpoint, browserInstanceId: endpoint, browserProcessIdentity: version.webSocketDebuggerUrl, targetId: page.id, documentEpoch: epoch, structural: true,
      networkSources: [...new Set(failures.networkFailures.map((item: DesktopRecord) => String(item.source)))].sort() } };
  const content = result.content || result.selection?.text || result.node?.text || (result.elements || []).map((row: DesktopRecord) => row.text).join('\n');
  return { adapter: 'browser-devtools', app: 'browser', window, content: String(content || ''), method: 'cdp:dom', artifacts: { browser_context: browserContext, region_elements: result.elements || [] } };
}

export function conversationIdentity(adapterId: string, window: DesktopRecord, data: DesktopRecord = {}): DesktopRecord {
  const hwnd = Number(window.hwnd || 0); const native = data.native_conversation_id || window.nativeConversationId || window.conversation_id || null;
  const account = data.account_key || window.accountKey || window.account_id || null; const surface = data.conversation_surface_id || data.automation_id || null;
  return { adapterId, conversationKey: native ? account ? `${account}:${native}` : native : `${adapterId}:window:${hwnd}:surface:${surface || 'root'}`, keyProvenance: native ? 'native' : 'window-surface', nativeConversationId: native, accountKey: account, windowHwnd: hwnd, processId: window.pid || window.processId || null, surfaceRuntimeId: surface, title: data.conversation_title || window.title || null, type: data.conversation_type || window.conversation_type || null };
}
export async function readChat(window: DesktopRecord, adapter = 'wechat', signal?: AbortSignal): Promise<DesktopRecord> {
  const liveWindow = await nativeRequest<DesktopWindow>('window', { hwnd: Number(window.hwnd) }, signal);
  const [left, top, right, bottom] = liveWindow.bbox;
  const data = await probeSelection(liveWindow.hwnd, { region: { x: left, y: top, width: right - left, height: bottom - top }, signal });
  const boundWindowMatches = Number(window.hwnd) === liveWindow.hwnd && liveWindow.pid > 0 && Number(window.pid || window.processId) === liveWindow.pid &&
    !!window.title && String(window.title) === liveWindow.title;
  const identity = conversationIdentity(adapter, boundWindowMatches ? {
    ...liveWindow, nativeConversationId: window.nativeConversationId, accountKey: window.accountKey,
  } : liveWindow, data);
  const liveNativeId = String(data.native_conversation_id || '').trim();
  const historyIdentityVerified = !!liveNativeId && (!window.nativeConversationId || boundWindowMatches && String(window.nativeConversationId) === liveNativeId);
  if (identity.nativeConversationId && !liveNativeId) identity.keyProvenance = 'bound-native-unverified';
  const visibleRows: DesktopRecord[] = (data.region_elements || []).filter((row: DesktopRecord) => String(row.text || '').trim());
  const rows = visibleRows.filter(row => row.native_message_id || row.speaker && row.time)
    .sort((a, b) => Number(a.rect?.[1] || 0) - Number(b.rect?.[1] || 0) || Number(a.rect?.[0] || 0) - Number(b.rect?.[0] || 0));
  const unresolvedRows = visibleRows.filter(row => !row.native_message_id && !(row.speaker && row.time));
  const messages = rows.map((row, index) => ({ id: `${adapter}-visible-message-${index}`, kind: 'chat_message', label: '可见消息', text: row.text, rect_xywh: row.rect, order_index: index + 1, confidence: row.native_message_id && row.speaker && row.time ? 0.9 : 0.6, evidence: 'uia:region_element', fields: { conversationIdentity: identity, visibleObjectId: row.automation_id || null, idProvenance: row.automation_id ? 'uia-automation' : 'visible-order', nativeMessageId: row.native_message_id || null, speaker: row.speaker || null, time: row.time || null, replyTo: row.reply_to || null, attachments: row.attachments || [], attachment: row.attachments?.length === 1 ? row.attachments[0] : null, requiresVisualObservation: !row.native_message_id || !row.speaker || !row.time, missingSemantics: ['speaker', 'time', 'native_message_id'].filter(key => !row[key]) } }));
  const objects: DesktopRecord[] = [{ id: `${adapter}-conversation-surface`, kind: 'conversation', label: '当前会话', text: identity.title || '', order_index: 0, fields: { conversationIdentity: identity }, confidence: identity.nativeConversationId ? 0.9 : 0.7 }, ...messages];
  if (unresolvedRows.length || !messages.length) objects.push({ id: `${adapter}-container`, kind: 'screen_region', text: unresolvedRows.map(row => row.text).join('\n') || data.text || '', rect_xywh: data.element_rectangle || null, fields: { conversationIdentity: identity, requiresVisualObservation: true, originalResolution: 'unresolved' } });
  return { adapter, conversationIdentity: identity, objects, messages, complete: false,
    nextCursor: historyIdentityVerified && messages.length ? `older:${Number(/^older:(\d+)$/.exec(String(window.cursor || ''))?.[1] || 0) + 1}` : null,
    pagePosition: window.cursor ? 'before' : 'initial',
    limitations: [...(!historyIdentityVerified ? ['visible-viewport-only', liveNativeId ? 'bound-chat-window-changed' : 'conversation-native-identity-unavailable'] : []), ...(unresolvedRows.length || !messages.length ? ['message-semantics-not-exposed'] : [])],
    usedBackend: 'uia_surface_adapter' };
}

export function explorerContextFromEvidence(window: DesktopRecord, data: DesktopRecord, elements: DesktopRecord[], request: DesktopRecord = {}): AdapterContext {
  const nativePaths = Array.isArray(data.selected_paths) ? data.selected_paths.map(String) : [];
  const items = elements.length ? elements.filter(row => ['listitem', 'dataitem'].includes(row.role)).map(row => {
    const matches = (data.items || []).filter((item: DesktopRecord) => item.name === row.name || String(item.name).replace(/\.[^.]+$/, '') === row.name);
    const path = matches.length === 1 && existsSync(matches[0].path) ? String(matches[0].path) : null;
    return { name: row.name, path, bbox: row.rect, selected: !!path && nativePaths.includes(path), source: 'shell-com+uia' };
  }) : (data.items || []).map((row: DesktopRecord) => ({ name: row.name, path: row.path && existsSync(row.path) ? String(row.path) : null, bbox: row.bbox, selected: nativePaths.includes(row.path), source: 'shell:desktop-folder-view' }));
  const region = request.region;
  const mark = region && [region.x, region.y, region.x + region.width, region.y + region.height].every(Number.isFinite)
    ? [region.x, region.y, region.x + region.width, region.y + region.height]
    : request.point && [request.point.x, request.point.y].every(Number.isFinite)
      ? [request.point.x, request.point.y, request.point.x + 1, request.point.y + 1]
      : null;
  const strokeMarks = (request.gesture?.strokes || []).flatMap((stroke: DesktopRecord) => {
    const points = (stroke.points || []).filter((point: DesktopRecord) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!points.length) return [];
    const xs = points.map((point: DesktopRecord) => point.x), ys = points.map((point: DesktopRecord) => point.y);
    return [[Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1]];
  });
  const marks = strokeMarks.length ? strokeMarks : mark ? [mark] : [];
  const hits = marks.length ? items.filter((item: DesktopRecord) => item.path && Array.isArray(item.bbox) && item.bbox.length === 4 && marks.some((rect: number[]) => item.bbox[0] < rect[2] && item.bbox[2] > rect[0] && item.bbox[1] < rect[3] && item.bbox[3] > rect[1])) : nativePaths.flatMap(path => items.find((item: DesktopRecord) => item.path === path) || (data.items || []).find((item: DesktopRecord) => item.path === path && existsSync(path)) || []);
  const seen = new Set<string>();
  const selectedItems = hits.filter((item: DesktopRecord) => !seen.has(item.path) && seen.add(item.path));
  const selectedPaths = selectedItems.map((item: DesktopRecord) => item.path);
  return { adapter: 'explorer', app: 'explorer', window, content: selectedPaths.length ? selectedPaths.join('\n') : marks.length ? '' : items.map((item: DesktopRecord) => item.path || item.name).join('\n'), method: elements.length ? 'shell:folder-items' : 'shell:desktop-folder-view', artifacts: { ...data, items, selected_paths: selectedPaths, selected_items: selectedItems, selected_item: selectedItems.length === 1 ? selectedItems[0] : null } };
}

export async function readExplorer(window: DesktopRecord, request: DesktopRecord = {}, signal?: AbortSignal): Promise<AdapterContext> {
  const hwnd = Number(window.hwnd); if (!Number.isSafeInteger(hwnd)) throw new Error('missing_hwnd');
  if (/^(Progman|WorkerW)$/.test(window.class_name || '')) {
    try { const desktop = await nativeRequest('desktop_items', {}, signal); if (desktop.items?.length) return explorerContextFromEvidence(window, { items: desktop.items, selected_paths: [], folder_path: null }, [], request); } catch { signal?.throwIfAborted(); }
  }
  const data = await runPowerShellJson(`$shell=New-Object -ComObject Shell.Application
$result=@{folder_path=$null;selected_paths=@();items=@()}
foreach($win in @($shell.Windows())){if([int64]$win.HWND -eq ${hwnd}){$result.folder_path=[string]$win.Document.Folder.Self.Path;foreach($item in @($win.Document.Folder.Items())){$result.items+=@{name=[string]$item.Name;path=[string]$item.Path}};foreach($item in @($win.Document.SelectedItems())){$result.selected_paths+=[string]$item.Path};break}}
if(-not $result.folder_path -and '${String(window.class_name || '').replaceAll("'", "''")}' -match '^(Progman|WorkerW)$'){$result.folder_path=[Environment]::GetFolderPath('Desktop');foreach($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'))){foreach($item in @(Get-ChildItem -LiteralPath $folder -ErrorAction SilentlyContinue)){$result.items+=@{name=$item.Name;path=$item.FullName}}}}
$result | ConvertTo-Json -Depth 8 -Compress`, signal);
  const elements = await listElements(hwnd, signal);
  return explorerContextFromEvidence(window, data, elements, request);
}

export function uiaContextFromProbe(window: DesktopRecord, data: DesktopRecord): AdapterContext {
  const sameHwnd = Number(data.hwnd) === Number(window.hwnd) && Number(data.root_hwnd) === Number(window.hwnd);
  // Console text is exposed by the hosting process, whose UIA PID can differ from the bound window PID.
  const sameProcess = !window.pid || Number(data.process_id) === Number(window.pid) || data.result_kind === 'terminal_buffer';
  const matches = sameHwnd && sameProcess;
  return { adapter: 'uia', app: String(window.process_name || ''), window, content: matches ? String(data.text || '') : '', method: `uia:${data.result_kind || 'selection'}`, artifacts: data, error: matches ? data.error || null : 'uia_window_identity_mismatch' };
}

export async function resolveSelection(window: DesktopRecord, request: DesktopRecord = {}, signal?: AbortSignal): Promise<AdapterContext[]> {
  const readers: Promise<AdapterContext>[] = [(async () => {
    const probe = () => probeSelection(Number(window.hwnd), { point: request.point, region: request.region, signal });
    let data = await probe();
    if (/chrome_widget|mozilla/i.test(window.class_name || '') && !data.text && !data.document_count) { await delay(data.error ? 450 : 60, signal); data = await probe(); }
    return uiaContextFromProbe(window, data);
  })()];
  if (officeApp(window)) readers.push(readOffice(window, { region: request.region, signal }));
  if (/chrome_widget|mozilla/i.test(window.class_name || '')) readers.push(readBrowserSelection(window, request, signal));
  if (/^(CabinetWClass|ExploreWClass|Progman|WorkerW)$/i.test(window.class_name || '')) readers.push(readExplorer(window, request, signal));
  const results = await Promise.allSettled(readers);
  signal?.throwIfAborted();
  return results.map((result, index) => result.status === 'fulfilled' ? result.value : { adapter: `provider-${index}`, app: '', window, content: '', method: 'unavailable', artifacts: {}, error: String(result.reason) });
}

export const builtinSurfaceAdapters: SurfaceAdapter[] = [{ id: 'figma', matches: window => /figma/i.test(`${window.process_name || ''} ${window.title || ''} ${window.class_name || ''}`), resolve: async (_window, request = {}, signal) => {
  const connection = request.figmaConnection;
  if (!connection) return { adapter: 'figma', objects: [], complete: false, limitations: ['figma-current-document-connection-required'], usedBackend: 'figma-plugin-unavailable' };
  const client = new FigmaClient(connection), result = await client.request('read_selection', {}, signal);
  return { adapter: 'figma', objects: (result.nodes || []).map((node: DesktopRecord) => ({ id: node.id, kind: 'figma_node', text: typeof node.characters === 'string' ? `${node.name}: ${node.characters}` : node.name || node.type, fields: node })), complete: true, usedBackend: 'figma-plugin-loopback', documentSessionId: connection.documentSessionId };
} }];
for (const [id, pattern] of [['wechat', /wechat|weixin|微信/i], ['dingtalk', /dingtalk|钉钉/i]] as const) builtinSurfaceAdapters.push({ id, matches: window => pattern.test(`${window.process_name || ''} ${window.title || ''} ${window.class_name || ''}`), resolve: (window, _request, signal) => readChat(window, id, signal) });
export const surfaceAdapters = new SurfaceAdapterRegistry();
for (const adapter of builtinSurfaceAdapters) surfaceAdapters.register(adapter);

export function locateChatFiles(name: string, roots: string[], limit = 20): DesktopRecord[] {
  if (!name || /[\\/]/.test(name)) throw new Error('file_name_required');
  const results: DesktopRecord[] = []; const queue = roots.filter(existsSync).map(root => ({ path: resolve(root), depth: 0 }));
  let visited = 0;
  while (queue.length && results.length < limit && visited++ < 10000) {
    const entry = queue.shift()!; let rows; try { rows = readdirSync(entry.path, { withFileTypes: true }); } catch { continue; }
    for (const row of rows) { const path = join(entry.path, row.name); if (row.isDirectory() && entry.depth < 8) queue.push({ path, depth: entry.depth + 1 }); else if (row.isFile() && row.name.toLowerCase() === name.toLowerCase()) results.push({ path, name: row.name, resolution: 'candidate', verifiedOriginal: false }); }
  }
  return results;
}
