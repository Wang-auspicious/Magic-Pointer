import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ActionFailure, ToolRegistry, type Effect } from './tools';
import { executableCommand, locateExecutable, terminateProcess } from './external';

type Data = Record<string, any>;
export interface McpConfig { name: string; command: string; args?: string[]; env?: Record<string, string>; toolEffects?: Record<string, Effect> }

export function readMcpConfigs(file: string): McpConfig[] {
  try {
    const entries = JSON.parse(readFileSync(file, 'utf8')).mcpServers || {};
    return Object.entries(entries).flatMap(([name, raw]) => {
      const value = raw as Data;
      return value.command && value.enabled !== false && value.disabled !== true ? [{ ...value, name } as McpConfig] : [];
    });
  } catch { return []; }
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 0;
  private buffer = '';
  private pending = new Map<number, { resolve(value: Data): void; reject(error: Error): void }>();
  constructor(readonly config: McpConfig) {}

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const command = await executableCommand(await locateExecutable(this.config.command) || this.config.command, this.config.args || []);
      const child = spawn(command.file, command.args, { env: { ...process.env, ...command.env, ...this.config.env }, stdio: 'pipe', windowsHide: true });
      this.child = child;
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        if (this.buffer.length > 2_000_000) { this.close(new Error('MCP response exceeds 2000000 characters')); return; }
        let position: number;
        while ((position = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, position); this.buffer = this.buffer.slice(position + 1);
          let message: Data;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.method && message.id !== undefined) { this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client request' } }); continue; }
          const entry = this.pending.get(message.id);
          if (!entry) continue;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(String(message.error.message || 'MCP error')));
          else entry.resolve(message.result || {});
        }
      });
      child.once('error', error => this.close(error));
      child.once('exit', () => this.close(new Error(`${this.config.name}: MCP connection closed`)));
      await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'magic-pointer', version: '1.0.0' } }, undefined, 12_000);
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    })();
    try { await this.starting; } catch (error) { this.starting = null; throw error; }
  }

  private write(value: Data) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('MCP server is not running');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request(method: string, params: Data, signal?: AbortSignal, timeoutMs = 8000): Promise<Data> {
    signal?.throwIfAborted();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const finish = (error?: Error, value?: Data) => { cleanup(); if (error) reject(error); else resolve(value || {}); };
      const abort = () => { try { this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'User interrupted' } }); } catch {} finish(signal?.reason || new Error('Aborted')); };
      const timer = setTimeout(() => this.close(new Error(`${this.config.name} did not answer within ${timeoutMs}ms`)), timeoutMs);
      this.pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { finish(error as Error); }
    });
  }

  async listTools(signal?: AbortSignal): Promise<Data[]> {
    await this.start();
    const tools: Data[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {}, signal);
      tools.push(...(page.tools || [])); cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Data, signal?: AbortSignal): Promise<Data> {
    await this.start();
    const raw = await this.request('tools/call', { name, arguments: args }, signal, 120_000);
    return { text: (raw.content || []).filter((block: Data) => block.type === 'text').map((block: Data) => block.text || '').join('\n'), isError: raw.isError === true, raw, usedBackend: `mcp:${this.config.name}` };
  }

  close(error = new Error('MCP client closed')) {
    const child = this.child; this.child = null; this.starting = null;
    for (const value of this.pending.values()) value.reject(error);
    this.pending.clear(); this.buffer = '';
    if (child) { child.stdin.end(); terminateProcess(child.pid); }
  }
}

export function registerMcpDiscovery(registry: ToolRegistry, configs: McpConfig[]) {
  const clients = new Map<string, McpClient>(), discovered = new Map<string, Data[]>();
  const discover = async (config: McpConfig, signal: AbortSignal): Promise<Data[]> => {
    if (discovered.has(config.name)) return discovered.get(config.name)!;
    let client = clients.get(config.name);
    if (!client) { client = new McpClient(config); clients.set(config.name, client); }
    const rows: Data[] = [];
    for (const tool of await client.listTools(signal)) {
      const base = `mcp_${config.name}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 56);
      let name = base, suffix = 1;
      while (registry.list().some(item => item.name === name)) name = `${base}_${suffix++}`;
      const effect = config.toolEffects?.[tool.name] || 'external_send', schema = tool.inputSchema || {};
      registry.register({ name, description: tool.description || tool.name, input_schema: { ...schema, type: 'object', properties: schema.properties || {}, required: Array.isArray(schema.required) ? schema.required : [] }, deferred: true,
        effect, is_concurrency_safe: effect === 'read', resource_keys: [`mcp:${config.name}`], used_backend: `mcp:${config.name}`,
        execute: async (values, ctx) => { const result = await client!.callTool(tool.name, values, ctx.signal); if (result.isError) throw new ActionFailure('tool_error', result.text || 'MCP tool failed', undefined, result.raw); return result; } });
      rows.push({ name, description: tool.description, server: config.name, effect, parameters: schema });
    }
    discovered.set(config.name, rows); return rows;
  };
  registry.register({ name: 'mcp_search', description: 'Discover configured MCP tools by capability keywords; returned tools can be loaded with Tools.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, effect: 'read', discovers_tools: true, resource_keys: ['mcp-discovery'],
    execute: async (args, context) => {
      const rows: Data[] = [], warnings: string[] = [], query = String(args.query || '').toLowerCase();
      for (const config of configs) { try { rows.push(...await discover(config, context.signal)); } catch (error) { warnings.push(`${config.name}: ${String(error)}`); } }
      return { query, tools: rows.filter(tool => `${tool.server} ${tool.name} ${tool.description}`.toLowerCase().includes(query)), warnings };
    } });
  registry.register({ name: 'MCP', description: 'List configured MCP servers, or discover one by server name.',
    input_schema: { type: 'object', properties: { server: { type: 'string' } }, required: [] }, effect: 'read', discovers_tools: true, resource_keys: ['mcp-discovery'],
    execute: async (args, context) => {
      if (!args.server) return { servers: configs.map(item => item.name) };
      const config = configs.find(item => item.name === args.server); if (!config) throw new Error('Unknown MCP server');
      const tools = await discover(config, context.signal); return { server: config.name, names: tools.map(tool => tool.name), tools };
    } });
  return () => { for (const client of clients.values()) client.close(); };
}

export class RuntimeMcpServer {
  constructor(readonly registry: ToolRegistry, readonly invoke: (name: string, args: Data) => Promise<unknown>) {}
  async handle(message: Data): Promise<Data | null> {
    const base = { jsonrpc: '2.0', id: message.id ?? null };
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { ...base, error: { code: -32600, message: 'Invalid Request' } };
    if (message.method.startsWith('notifications/')) return null;
    if (message.method === 'initialize') return { ...base, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'magic-pointer', version: '1.0.0' } } };
    if (message.method === 'ping') return { ...base, result: {} };
    if (message.method === 'tools/list') return { ...base, result: { tools: this.registry.list().map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) } };
    if (message.method === 'tools/call') {
      try {
        const value = await this.invoke(String(message.params?.name || ''), message.params?.arguments || {});
        return { ...base, result: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: (value as Data)?.ok === false } };
      } catch (error) { return { ...base, result: { content: [{ type: 'text', text: String(error) }], isError: true } }; }
    }
    return { ...base, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}
