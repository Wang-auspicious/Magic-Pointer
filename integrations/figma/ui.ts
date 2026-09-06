interface PluginIdentity {
  documentSessionId: string;
  documentName: string;
  pageId: string;
  pageName: string;
}

interface Connection {
  bridgeUrl: string;
  pluginToken: string;
  taskId: string;
  documentSessionId: string;
}

const bridgeUrlInput = document.querySelector<HTMLInputElement>('#bridge-url')!;
const pairCodeInput = document.querySelector<HTMLInputElement>('#pair-code')!;
const connectButton = document.querySelector<HTMLButtonElement>('#connect')!;
const disconnectButton = document.querySelector<HTMLButtonElement>('#disconnect')!;
const statusElement = document.querySelector<HTMLElement>('#status')!;
const documentElement = document.querySelector<HTMLElement>('#document')!;
const taskElement = document.querySelector<HTMLElement>('#task')!;

let identity: PluginIdentity | null = null;
let connection: Connection | null = null;
let polling = false;
let pollTimer: number | null = null;

function setStatus(text: string, state: 'idle' | 'connected' | 'error' = 'idle'): void {
  statusElement.textContent = text;
  statusElement.dataset.state = state;
}

function normalizeBridgeUrl(value: string): string {
  const candidate = value.trim().replace(/\/+$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(candidate)) {
    throw new Error('Bridge must be an explicit 127.0.0.1 HTTP address and port.');
  }
  return candidate;
}

async function bridgeFetch(
  path: string,
  options: RequestInit = {},
  current: Connection | null = connection,
): Promise<Record<string, unknown>> {
  const bridgeUrl = current?.bridgeUrl || normalizeBridgeUrl(bridgeUrlInput.value);
  const headers = new Headers(options.headers || {});
  if (current?.pluginToken) headers.set('Authorization', `Bearer ${current.pluginToken}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${bridgeUrl}${path}`, { ...options, headers, credentials: 'omit' });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(String(body.error || `bridge_http_${response.status}`));
  return body;
}

function postToPlugin(message: Record<string, unknown>): void {
  parent.postMessage({ pluginMessage: message }, '*');
}

async function postEvent(payload: Record<string, unknown>): Promise<void> {
  const current = connection;
  if (!current) return;
  await bridgeFetch('/events', {
    method: 'POST',
    body: JSON.stringify({
      taskId: current.taskId,
      documentSessionId: current.documentSessionId,
      ...payload,
    }),
  }, current);
}

function schedulePoll(delay = 350): void {
  if (!connection) return;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => { void pollCommands(); }, delay);
}

async function pollCommands(): Promise<void> {
  const current = connection;
  if (!current || polling) return;
  polling = true;
  try {
    const body = await bridgeFetch('/commands', {}, current);
    const commands = Array.isArray(body.commands) ? body.commands : [];
    for (const command of commands) postToPlugin({ type: 'bridge-command', command });
    schedulePoll(commands.length ? 50 : 450);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    await disconnect(false);
  } finally {
    polling = false;
  }
}

async function connect(): Promise<void> {
  if (!identity) {
    setStatus('Waiting for Figma document identity.', 'error');
    return;
  }
  connectButton.disabled = true;
  try {
    const bridgeUrl = normalizeBridgeUrl(bridgeUrlInput.value);
    const body = await bridgeFetch('/pair', {
      method: 'POST',
      body: JSON.stringify({
        pairCode: pairCodeInput.value.trim(),
        documentSessionId: identity.documentSessionId,
        documentName: identity.documentName,
      }),
    }, { bridgeUrl, pluginToken: '', taskId: '', documentSessionId: identity.documentSessionId });
    const taskId = String(body.taskId || '');
    const pluginToken = String(body.pluginToken || '');
    if (!taskId || !pluginToken || body.documentSessionId !== identity.documentSessionId) {
      throw new Error('Pairing response identity was incomplete.');
    }
    connection = { bridgeUrl, pluginToken, taskId, documentSessionId: identity.documentSessionId };
    taskElement.textContent = taskId;
    disconnectButton.hidden = false;
    pairCodeInput.disabled = true;
    bridgeUrlInput.disabled = true;
    setStatus('Connected to this task and document.', 'connected');
    postToPlugin({ type: 'bridge-connected', taskId, documentSessionId: identity.documentSessionId });
    schedulePoll(0);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    connectButton.disabled = Boolean(connection);
  }
}

async function disconnect(notify = true): Promise<void> {
  const current = connection;
  connection = null;
  if (pollTimer !== null) window.clearTimeout(pollTimer);
  pollTimer = null;
  if (notify && current) {
    try {
      await bridgeFetch('/events', {
        method: 'POST',
        body: JSON.stringify({
          taskId: current.taskId,
          documentSessionId: current.documentSessionId,
          status: 'disconnected',
        }),
      }, current);
    } catch { /* the bridge may already be gone */ }
  }
  postToPlugin({ type: 'bridge-disconnected' });
  taskElement.textContent = '—';
  disconnectButton.hidden = true;
  pairCodeInput.disabled = false;
  bridgeUrlInput.disabled = false;
  connectButton.disabled = false;
  setStatus('Not connected.');
}

connectButton.addEventListener('click', () => { void connect(); });
disconnectButton.addEventListener('click', () => { void disconnect(); });
window.addEventListener('pagehide', () => { void disconnect(); });

window.onmessage = (event: MessageEvent) => {
  const message = event.data?.pluginMessage as Record<string, unknown> | undefined;
  if (!message) return;
  if (message.type === 'plugin-ready') {
    identity = {
      documentSessionId: String(message.documentSessionId || ''),
      documentName: String(message.documentName || 'Untitled Figma document'),
      pageId: String(message.pageId || ''),
      pageName: String(message.pageName || ''),
    };
    documentElement.textContent = `${identity.documentName} · ${identity.pageName}`;
    return;
  }
  if (message.type === 'selection-event' || message.type === 'document-event') {
    void postEvent({
      status: 'connected',
      eventType: message.type,
      selectionIds: message.selectionIds || [],
      pageId: message.pageId,
      pageName: message.pageName,
    }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), 'error'));
    return;
  }
  if (message.type === 'plugin-error') {
    setStatus(String(message.error || 'Figma plugin error'), 'error');
    return;
  }
  if (message.type !== 'command-result' || !connection) return;
  void bridgeFetch('/results', {
    method: 'POST',
    body: JSON.stringify({
      commandId: message.commandId,
      taskId: message.taskId,
      documentSessionId: message.documentSessionId,
      ok: message.ok === true,
      result: message.result,
      error: message.error,
    }),
  }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), 'error'));
};
