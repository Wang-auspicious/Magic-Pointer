import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_RESULT_BODY_BYTES = 12 * 1024 * 1024;
const FIGMA_OPERATIONS = new Set([
  'read_selection',
  'read_nodes',
  'read_parent',
  'export_preview',
  'apply_patch',
  'readback',
]);

interface PairingState {
  taskId: string;
  pairCode: string;
  expiresAt: number;
}

interface PluginConnection {
  pluginToken: string;
  taskId: string;
  documentSessionId: string;
  documentName: string;
  connectedAt: number;
  lastEventAt: number;
  pageId?: string;
  pageName?: string;
  selectionIds: string[];
}

interface CommandRecord {
  commandId: string;
  taskId: string;
  documentSessionId: string;
  operation: string;
  arguments: Record<string, unknown>;
  pluginToken: string;
  status: 'queued' | 'dispatched' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

export interface FigmaBridgeAddress {
  host: '127.0.0.1';
  port: number;
  baseUrl: string;
}

export interface FigmaConnectionSnapshot {
  taskId: string;
  documentSessionId: string;
  documentName: string;
  connectedAt: number;
  lastEventAt: number;
  pageId?: string;
  pageName?: string;
  selectionIds: string[];
}

function bearer(request: IncomingMessage): string {
  const value = String(request.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function cors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  response.setHeader('Access-Control-Max-Age', '600');
}

function reply(
  response: ServerResponse,
  status: number,
  value: Record<string, unknown> = {},
): void {
  cors(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

async function readBody(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request_body_must_be_object');
  }
  return parsed as Record<string, unknown>;
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class FigmaLoopbackBridge {
  readonly controlToken: string;
  private readonly requestedPort: number;
  private readonly now: () => number;
  private server: http.Server | null = null;
  private pairing: PairingState | null = null;
  private readonly connections = new Map<string, PluginConnection>();
  private readonly commands = new Map<string, CommandRecord>();

  constructor(options: { port?: number; now?: () => number } = {}) {
    this.requestedPort = options.port ?? 37843;
    this.now = options.now || Date.now;
    this.controlToken = crypto.randomBytes(32).toString('base64url');
  }

  openPairing(taskId: string, pairCode?: string): { taskId: string; pairCode: string; expiresAt: number } {
    const normalizedTask = nonEmpty(taskId);
    if (!normalizedTask) throw new Error('figma_pairing_task_required');
    const normalizedCode = nonEmpty(pairCode)
      || crypto.randomInt(100_000, 1_000_000).toString();
    this.pairing = {
      taskId: normalizedTask,
      pairCode: normalizedCode,
      expiresAt: this.now() + 10 * 60_000,
    };
    return { ...this.pairing };
  }

  connectionSnapshot(): FigmaConnectionSnapshot[] {
    return [...this.connections.values()].map((connection) => ({
      taskId: connection.taskId,
      documentSessionId: connection.documentSessionId,
      documentName: connection.documentName,
      connectedAt: connection.connectedAt,
      lastEventAt: connection.lastEventAt,
      pageId: connection.pageId,
      pageName: connection.pageName,
      selectionIds: [...connection.selectionIds],
    }));
  }

  closeConnection(taskId: string, documentSessionId: string): boolean {
    const entry = [...this.connections.entries()].find(([, connection]) => (
      connection.taskId === taskId && connection.documentSessionId === documentSessionId
    ));
    if (!entry) return false;
    const [token] = entry;
    this.connections.delete(token);
    for (const command of this.commands.values()) {
      if (command.pluginToken === token && command.status === 'queued') {
        command.status = 'cancelled';
        command.completedAt = this.now();
        command.error = 'figma_connection_closed_before_dispatch';
      }
    }
    return true;
  }

  clientConfiguration(
    taskId: string,
    documentSessionId: string,
  ): { baseUrl: string; controlToken: string; taskId: string; documentSessionId: string } {
    const connection = [...this.connections.values()].find(
      (candidate) => candidate.taskId === taskId
        && candidate.documentSessionId === documentSessionId,
    );
    if (!connection) throw new Error('figma_document_not_connected');
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('figma_bridge_not_started');
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      controlToken: this.controlToken,
      taskId: connection.taskId,
      documentSessionId: connection.documentSessionId,
    };
  }

  async start(): Promise<FigmaBridgeAddress> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address === 'object') {
        return {
          host: '127.0.0.1',
          port: address.port,
          baseUrl: `http://127.0.0.1:${address.port}`,
        };
      }
      throw new Error('figma_bridge_address_unavailable');
    }
    const server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const status = message === 'request_body_too_large' ? 413 : 400;
        reply(response, status, { ok: false, error: message });
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        this.server = null;
        reject(new Error(
          error.code === 'EADDRINUSE'
            ? `figma_bridge_port_in_use:${this.requestedPort}`
            : `figma_bridge_start_failed:${error.code || error.message}`,
        ));
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.requestedPort, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('figma_bridge_address_unavailable');
    return {
      host: '127.0.0.1',
      port: address.port,
      baseUrl: `http://127.0.0.1:${address.port}`,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.pairing = null;
    this.connections.clear();
    for (const command of this.commands.values()) {
      if (command.status === 'queued') command.status = 'cancelled';
    }
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async request(
    taskId: string,
    documentSessionId: string,
    operation: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('figma_bridge_not_started');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${this.controlToken}`,
      'Content-Type': 'application/json',
    };
    const queuedResponse = await fetch(`${baseUrl}/requests`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ taskId, documentSessionId, operation, arguments: args }),
    });
    const queued = await queuedResponse.json() as Record<string, unknown>;
    if (!queuedResponse.ok) throw new Error(String(queued.error || `figma_request_${queuedResponse.status}`));
    const commandId = nonEmpty(queued.commandId);
    if (!commandId) throw new Error('figma_command_not_queued');
    const deadline = this.now() + Math.max(100, options.timeoutMs ?? 15_000);
    const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 50);
    while (this.now() < deadline) {
      const resultResponse = await fetch(`${baseUrl}/results/${encodeURIComponent(commandId)}`, {
        headers: { Authorization: `Bearer ${this.controlToken}` },
      });
      const result = await resultResponse.json() as Record<string, unknown>;
      if (!resultResponse.ok) {
        throw new Error(String(result.error || `figma_result_${resultResponse.status}`));
      }
      const status = nonEmpty(result.status);
      if (status === 'completed') {
        const value = result.result;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('figma_command_result_must_be_object');
        }
        return value as Record<string, unknown>;
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new Error(nonEmpty(result.error) || `figma_command_${status}`);
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, pollIntervalMs); });
    }
    throw new Error(`figma_command_timed_out:${commandId}`);
  }

  private plugin(token: string): PluginConnection | null {
    return this.connections.get(token) || null;
  }

  private controlAuthorized(request: IncomingMessage): boolean {
    return bearer(request) === this.controlToken;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'OPTIONS') {
      cors(response);
      response.statusCode = 204;
      response.end();
      return;
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/pair') {
      await this.pair(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/events') {
      await this.events(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/commands') {
      this.pullCommands(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/results') {
      await this.postResult(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/requests') {
      await this.enqueue(request, response);
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/results/')) {
      this.getResult(request, response, decodeURIComponent(url.pathname.slice('/results/'.length)));
      return;
    }
    reply(response, 404, { ok: false, error: 'figma_bridge_route_not_found' });
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const pairing = this.pairing;
    if (
      !pairing
      || pairing.expiresAt < this.now()
      || nonEmpty(body.pairCode) !== pairing.pairCode
    ) {
      reply(response, 403, { ok: false, error: 'figma_pairing_rejected' });
      return;
    }
    const documentSessionId = nonEmpty(body.documentSessionId);
    if (!documentSessionId) {
      reply(response, 400, { ok: false, error: 'document_session_id_required' });
      return;
    }
    const pluginToken = crypto.randomBytes(32).toString('base64url');
    const connection: PluginConnection = {
      pluginToken,
      taskId: pairing.taskId,
      documentSessionId,
      documentName: nonEmpty(body.documentName),
      connectedAt: this.now(),
      lastEventAt: this.now(),
      selectionIds: [],
    };
    this.connections.set(pluginToken, connection);
    this.pairing = null;
    reply(response, 200, {
      ok: true,
      pluginToken,
      taskId: connection.taskId,
      documentSessionId,
    });
  }

  private async events(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearer(request);
    const connection = this.plugin(token);
    if (!connection) {
      reply(response, 401, { ok: false, error: 'figma_plugin_unauthorized' });
      return;
    }
    const body = await readBody(request);
    if (
      nonEmpty(body.taskId) !== connection.taskId
      || nonEmpty(body.documentSessionId) !== connection.documentSessionId
    ) {
      reply(response, 409, { ok: false, error: 'figma_connection_identity_mismatch' });
      return;
    }
    connection.lastEventAt = this.now();
    const selectionIds = body.selectionIds;
    if (Array.isArray(selectionIds)) {
      connection.selectionIds = selectionIds
        .slice(0, 100)
        .map((value) => nonEmpty(value))
        .filter(Boolean);
    }
    const pageId = nonEmpty(body.pageId);
    const pageName = nonEmpty(body.pageName);
    if (pageId) connection.pageId = pageId;
    if (pageName) connection.pageName = pageName;
    if (body.status === 'disconnected') {
      this.connections.delete(token);
      for (const command of this.commands.values()) {
        if (command.pluginToken === token && command.status === 'queued') {
          command.status = 'cancelled';
          command.completedAt = this.now();
          command.error = 'figma_plugin_disconnected_before_dispatch';
        }
      }
    }
    reply(response, 200, { ok: true });
  }

  private pullCommands(request: IncomingMessage, response: ServerResponse): void {
    const token = bearer(request);
    const connection = this.plugin(token);
    if (!connection) {
      reply(response, 401, { ok: false, error: 'figma_plugin_unauthorized' });
      return;
    }
    const commands = [...this.commands.values()]
      .filter((command) => command.pluginToken === token && command.status === 'queued')
      .slice(0, 20);
    for (const command of commands) {
      command.status = 'dispatched';
      command.dispatchedAt = this.now();
    }
    reply(response, 200, {
      ok: true,
      commands: commands.map((command) => ({
        commandId: command.commandId,
        taskId: command.taskId,
        documentSessionId: command.documentSessionId,
        operation: command.operation,
        arguments: command.arguments,
      })),
    });
  }

  private async postResult(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearer(request);
    const connection = this.plugin(token);
    if (!connection) {
      reply(response, 401, { ok: false, error: 'figma_plugin_unauthorized' });
      return;
    }
    // Exported node previews are bounded local PNG evidence and can legitimately
    // exceed the tiny command-body budget.
    const body = await readBody(request, MAX_RESULT_BODY_BYTES);
    const command = this.commands.get(nonEmpty(body.commandId));
    if (
      !command
      || command.pluginToken !== token
      || command.taskId !== nonEmpty(body.taskId)
      || command.documentSessionId !== nonEmpty(body.documentSessionId)
      || command.status !== 'dispatched'
    ) {
      reply(response, 409, { ok: false, error: 'figma_result_identity_mismatch' });
      return;
    }
    command.ok = body.ok === true;
    command.status = command.ok ? 'completed' : 'failed';
    command.result = body.result;
    command.error = nonEmpty(body.error) || undefined;
    command.completedAt = this.now();
    reply(response, 200, { ok: true });
  }

  private async enqueue(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.controlAuthorized(request)) {
      reply(response, 401, { ok: false, error: 'figma_control_unauthorized' });
      return;
    }
    const body = await readBody(request);
    const taskId = nonEmpty(body.taskId);
    const documentSessionId = nonEmpty(body.documentSessionId);
    const operation = nonEmpty(body.operation);
    if (!FIGMA_OPERATIONS.has(operation)) {
      reply(response, 400, { ok: false, error: 'figma_operation_not_allowed' });
      return;
    }
    const connection = [...this.connections.values()].find(
      (candidate) => candidate.taskId === taskId
        && candidate.documentSessionId === documentSessionId,
    );
    if (!connection) {
      reply(response, 409, { ok: false, error: 'figma_document_not_connected' });
      return;
    }
    const args = body.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      reply(response, 400, { ok: false, error: 'figma_arguments_must_be_object' });
      return;
    }
    const commandId = crypto.randomUUID();
    this.commands.set(commandId, {
      commandId,
      taskId,
      documentSessionId,
      operation,
      arguments: args as Record<string, unknown>,
      pluginToken: connection.pluginToken,
      status: 'queued',
      createdAt: this.now(),
    });
    reply(response, 202, { ok: true, commandId, status: 'queued' });
  }

  private getResult(
    request: IncomingMessage,
    response: ServerResponse,
    commandId: string,
  ): void {
    if (!this.controlAuthorized(request)) {
      reply(response, 401, { ok: false, error: 'figma_control_unauthorized' });
      return;
    }
    const command = this.commands.get(commandId);
    if (!command) {
      reply(response, 404, { ok: false, error: 'figma_command_not_found' });
      return;
    }
    reply(response, 200, {
      ok: command.ok,
      commandId: command.commandId,
      taskId: command.taskId,
      documentSessionId: command.documentSessionId,
      operation: command.operation,
      status: command.status,
      result: command.result,
      error: command.error,
    });
  }
}

export { FIGMA_OPERATIONS };
