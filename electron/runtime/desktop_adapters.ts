import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { BROWSER_DOM_PROBE_SCRIPT, BROWSER_DOM_REGION_PROBE_SCRIPT, BROWSER_DOCUMENT_READ_SCRIPT, EXCEL_REGION_SCRIPT, EXCEL_SELECTION_SCRIPT, POWERPOINT_NATIVE_WINDOW_SCRIPT, POWERPOINT_SELECTION_SCRIPT } from './desktop_scripts';
import { runPowerShellJson, probeSelection, listElements, nativeRequest, delay, type DesktopRecord } from './desktop';

export interface AdapterContext extends DesktopRecord { adapter: string; app: string; content: string; method: string; window: DesktopRecord; artifacts: DesktopRecord; error?: string | null }
export interface SurfaceAdapter { id: string; matches(window: DesktopRecord): boolean; resolve(window: DesktopRecord, request?: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> }
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
  } else if (app === 'powerpoint') data = await runPowerShellJson(POWERPOINT_SELECTION_SCRIPT.replace('__TARGET_HWND__', String(hwnd)).replace('__NATIVE_WINDOW__', POWERPOINT_NATIVE_WINDOW_SCRIPT), options.signal);
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
  return { adapter: 'office', app, content, method: data.method || `com:${app}.selection`, window, label: path || app, artifacts: { ...data, document: path, document_saved: data.document_saved ?? data.workbook_saved ?? data.presentation_saved, source_identity: { absolutePath: path, hwnd, host }, locators, ...(app === 'word' ? { selection_text_sha256: createHash('sha256').update(content).digest('hex'), selection_text_chars: content.length } : {}) }, error: (data.messages || []).join('; ') || null };
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

export class CdpConnection {
  private sequence = 0;
  private pending = new Map<number, { accept(value: DesktopRecord): void; reject(error: Error): void }>();
  private socket: WebSocket;
  readonly opened: Promise<void>;
  constructor(url: string, readonly signal?: AbortSignal) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((accept, reject) => { this.socket.addEventListener('open', () => accept(), { once: true }); this.socket.addEventListener('error', () => reject(new Error('cdp_connection_failed')), { once: true }); });
    this.socket.addEventListener('message', event => { const data = JSON.parse(String(event.data)); const pending = this.pending.get(data.id); if (!pending) return; this.pending.delete(data.id); if (data.error) pending.reject(new Error(data.error.message)); else pending.accept(data.result); });
    this.socket.addEventListener('close', () => { for (const pending of this.pending.values()) pending.reject(new Error('cdp_connection_closed')); this.pending.clear(); });
    signal?.addEventListener('abort', () => this.close(), { once: true });
  }
  async request(method: string, params: DesktopRecord): Promise<DesktopRecord> { await this.opened; this.signal?.throwIfAborted(); const id = ++this.sequence; return new Promise((accept, reject) => { this.pending.set(id, { accept, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  close(): void { this.socket.close(); }
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
  for (const endpoint of endpoints) {
    try {
      const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(600)]) : AbortSignal.timeout(600);
      const pages = await (await fetch(`${endpoint}/json/list`, { signal: timeout })).json() as DesktopRecord[];
      const version = await (await fetch(`${endpoint}/json/version`, { signal: timeout })).json() as DesktopRecord;
      const candidates = pages.filter(row => row.type === 'page' && (!request.targetId || row.id === request.targetId));
      const resolved: DesktopRecord[] = [];
      for (const page of candidates) {
        const input = { point: request.point, region: request.region, outerBBox: window.bbox, sampleStep: 48 };
        const result = await evaluateBrowser(endpoint, page.id, `(${request.region ? BROWSER_DOM_REGION_PROBE_SCRIPT : BROWSER_DOM_PROBE_SCRIPT})(${JSON.stringify(input)})`, signal);
        if (!result || result.state === 'unavailable' || result.coordinates?.hitTestVerified === false) continue;
        if (!request.targetId && result.page?.title && !String(window.title).includes(result.page.title)) continue;
        resolved.push({ result, page });
      }
      if (resolved.length !== 1) { errors.push(resolved.length ? 'browser_target_ambiguous' : 'browser_target_unmatched'); continue; }
      const { result, page } = resolved[0]; const epoch = result.page?.documentEpoch || result.documentEpoch;
      const browserContext = { ...result, provenance: { ...result.provenance, endpoint, browserInstanceId: endpoint, browserProcessIdentity: version.webSocketDebuggerUrl, targetId: page.id, documentEpoch: epoch, structural: true } };
      const content = result.content || result.selection?.text || result.node?.text || (result.elements || []).map((row: DesktopRecord) => row.text).join('\n');
      return { adapter: 'browser-devtools', app: 'browser', window, content: String(content || ''), method: 'cdp:dom', artifacts: { browser_context: browserContext, region_elements: result.elements || [] } };
    } catch (error) { signal?.throwIfAborted(); errors.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(errors.join('; ') || 'browser_devtools_unavailable');
}

export function conversationIdentity(adapterId: string, window: DesktopRecord, data: DesktopRecord = {}): DesktopRecord {
  const hwnd = Number(window.hwnd || 0); const native = window.nativeConversationId || window.conversation_id || data.native_conversation_id || null;
  const account = window.accountKey || window.account_id || data.account_key || null; const surface = data.conversation_surface_id || data.automation_id || null;
  return { adapterId, conversationKey: native ? account ? `${account}:${native}` : native : `${adapterId}:window:${hwnd}:surface:${surface || 'root'}`, keyProvenance: native ? 'native' : 'window-surface', nativeConversationId: native, accountKey: account, windowHwnd: hwnd, processId: window.pid || window.processId || null, surfaceRuntimeId: surface, title: data.conversation_title || window.title || null, type: data.conversation_type || window.conversation_type || null };
}
export async function readChat(window: DesktopRecord, adapter = 'wechat', signal?: AbortSignal): Promise<DesktopRecord> {
  const data = await probeSelection(Number(window.hwnd), { signal }); const identity = conversationIdentity(adapter, window, data);
  const rows: DesktopRecord[] = (data.region_elements || []).filter((row: DesktopRecord) => String(row.text || '').trim()).sort((a: DesktopRecord, b: DesktopRecord) => Number(a.rect?.[1] || 0) - Number(b.rect?.[1] || 0) || Number(a.rect?.[0] || 0) - Number(b.rect?.[0] || 0));
  const messages = rows.map((row, index) => ({ id: `${adapter}-visible-message-${index}`, kind: 'chat_message', label: '可见消息', text: row.text, rect_xywh: row.rect, order_index: index + 1, confidence: row.native_message_id && row.speaker && row.time ? 0.9 : 0.6, evidence: 'uia:region_element', fields: { conversationIdentity: identity, visibleObjectId: row.automation_id || null, idProvenance: row.automation_id ? 'uia-automation' : 'visible-order', nativeMessageId: row.native_message_id || null, speaker: row.speaker || null, time: row.time || null, replyTo: row.reply_to || null, attachments: row.attachments || [], attachment: row.attachments?.length === 1 ? row.attachments[0] : null, requiresVisualObservation: !row.native_message_id || !row.speaker || !row.time, missingSemantics: ['speaker', 'time', 'native_message_id'].filter(key => !row[key]) } }));
  const objects: DesktopRecord[] = [{ id: `${adapter}-conversation-surface`, kind: 'conversation', label: '当前会话', text: identity.title || '', order_index: 0, fields: { conversationIdentity: identity }, confidence: identity.nativeConversationId ? 0.9 : 0.7 }, ...messages];
  if (!messages.length) objects.push({ id: `${adapter}-container`, kind: data.text ? 'message_list' : 'screen_region', text: data.text || '', rect_xywh: data.element_rectangle || null, fields: { conversationIdentity: identity, requiresVisualObservation: true, originalResolution: 'unresolved' } });
  return { adapter, conversationIdentity: identity, objects, messages, complete: false, limitations: ['visible-viewport-only', ...(!identity.nativeConversationId ? ['conversation-native-identity-unavailable'] : []), ...(!messages.length ? ['message-semantics-not-exposed'] : [])], usedBackend: 'uia_surface_adapter' };
}

export async function readExplorer(window: DesktopRecord, signal?: AbortSignal): Promise<AdapterContext> {
  const hwnd = Number(window.hwnd); if (!Number.isSafeInteger(hwnd)) throw new Error('missing_hwnd');
  if (/^(Progman|WorkerW)$/.test(window.class_name || '')) {
    try { const desktop = await nativeRequest('desktop_items', {}, signal); if (desktop.items?.length) return { adapter: 'explorer', app: 'explorer', window, content: desktop.items.map((row: DesktopRecord) => row.path).join('\n'), method: 'shell:desktop-folder-view', artifacts: { items: desktop.items, selected_paths: [], folder_path: null } }; } catch { signal?.throwIfAborted(); }
  }
  const data = await runPowerShellJson(`$shell=New-Object -ComObject Shell.Application
$result=@{folder_path=$null;selected_paths=@();items=@()}
foreach($win in @($shell.Windows())){if([int64]$win.HWND -eq ${hwnd}){$result.folder_path=[string]$win.Document.Folder.Self.Path;foreach($item in @($win.Document.Folder.Items())){$result.items+=@{name=[string]$item.Name;path=[string]$item.Path}};foreach($item in @($win.Document.SelectedItems())){$result.selected_paths+=[string]$item.Path};break}}
if(-not $result.folder_path -and '${String(window.class_name || '').replaceAll("'", "''")}' -match '^(Progman|WorkerW)$'){$result.folder_path=[Environment]::GetFolderPath('Desktop');foreach($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'))){foreach($item in @(Get-ChildItem -LiteralPath $folder -ErrorAction SilentlyContinue)){$result.items+=@{name=$item.Name;path=$item.FullName}}}}
$result | ConvertTo-Json -Depth 8 -Compress`, signal);
  const elements = await listElements(hwnd, signal);
  const items = elements.filter(row => ['listitem', 'dataitem'].includes(row.role)).map(row => {
    const matches = (data.items || []).filter((item: DesktopRecord) => item.name === row.name || String(item.name).replace(/\.[^.]+$/, '') === row.name);
    return { name: row.name, path: matches.length === 1 && existsSync(matches[0].path) ? matches[0].path : null, bbox: row.rect, selected: matches.length === 1 && data.selected_paths.includes(matches[0].path), source: 'shell-com+uia' };
  });
  return { adapter: 'explorer', app: 'explorer', window, content: items.map(row => row.path || row.name).join('\n'), method: 'shell:folder-items', artifacts: { ...data, items } };
}

export async function resolveSelection(window: DesktopRecord, request: DesktopRecord = {}, signal?: AbortSignal): Promise<AdapterContext[]> {
  const readers: Promise<AdapterContext>[] = [(async () => {
    const probe = () => probeSelection(Number(window.hwnd), { point: request.point, region: request.region, signal });
    let data = await probe();
    if (/chrome_widget|mozilla/i.test(window.class_name || '') && !data.text && !data.document_count) { await delay(data.error ? 450 : 60, signal); data = await probe(); }
    const matches = Number(data.hwnd) === Number(window.hwnd) && Number(data.root_hwnd) === Number(window.hwnd) && (!window.pid || Number(data.process_id) === Number(window.pid));
    return { adapter: 'uia', app: String(window.process_name || ''), window, content: matches ? String(data.text || '') : '', method: `uia:${data.result_kind || 'selection'}`, artifacts: data, error: matches ? data.error || null : 'uia_window_identity_mismatch' };
  })()];
  if (officeApp(window)) readers.push(readOffice(window, { region: request.region, signal }));
  if (/chrome_widget|mozilla/i.test(window.class_name || '')) readers.push(readBrowserSelection(window, request, signal));
  if (/^(CabinetWClass|ExploreWClass|Progman|WorkerW)$/i.test(window.class_name || '')) readers.push(readExplorer(window, signal));
  const results = await Promise.allSettled(readers);
  signal?.throwIfAborted();
  return results.map((result, index) => result.status === 'fulfilled' ? result.value : { adapter: `provider-${index}`, app: '', window, content: '', method: 'unavailable', artifacts: {}, error: String(result.reason) });
}

export const surfaceAdapters = new SurfaceAdapterRegistry();
surfaceAdapters.register({ id: 'figma', matches: window => /figma/i.test(`${window.process_name || ''} ${window.title || ''} ${window.class_name || ''}`), resolve: async (_window, request = {}, signal) => {
  const connection = request.figmaConnection;
  if (!connection) return { adapter: 'figma', objects: [], complete: false, limitations: ['figma-current-document-connection-required'], usedBackend: 'figma-plugin-unavailable' };
  const client = new FigmaClient(connection), result = await client.request('read_selection', {}, signal);
  return { adapter: 'figma', objects: (result.nodes || []).map((node: DesktopRecord) => ({ id: node.id, kind: 'figma_node', text: typeof node.characters === 'string' ? `${node.name}: ${node.characters}` : node.name || node.type, fields: node })), complete: true, usedBackend: 'figma-plugin-loopback', documentSessionId: connection.documentSessionId };
} });
for (const [id, pattern] of [['wechat', /wechat|weixin|微信/i], ['dingtalk', /dingtalk|钉钉/i]] as const) surfaceAdapters.register({ id, matches: window => pattern.test(`${window.process_name || ''} ${window.title || ''} ${window.class_name || ''}`), resolve: (window, _request, signal) => readChat(window, id, signal) });

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
