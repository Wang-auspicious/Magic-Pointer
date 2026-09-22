import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

type Fields = Record<string, string>;
export interface Measurement {
  ok: boolean; error: string; wallMs: number; totalMs: number | null; bootMs: number | null;
  turns: number; ttftMs: number[]; toolMs: number[]; toolNames: string[]; usedBackend: string;
}

export function phases(stderr: string): Fields[] {
  return stderr.split(/\r?\n/).filter(line => line.startsWith('@@mp ')).map(line => Object.fromEntries(
    line.slice(5).trim().split(/\s+/).map(token => { const split = token.indexOf('='); return split < 0 ? [token, ''] : [token.slice(0, split), token.slice(split + 1)]; }),
  ));
}

export function reducePhases(rows: Fields[], outcome: Measurement): void {
  let requestedAt: number | null = null;
  for (const row of rows) {
    const at = Number(row.ms);
    if (row.phase === 'runtime_ready' || row.phase === 'agent_start' && outcome.bootMs === null) outcome.bootMs = Number.isFinite(at) ? at : null;
    if (row.phase === 'total') outcome.totalMs = Number.isFinite(at) ? at : null;
    if (row.phase === 'model_request') { outcome.turns++; requestedAt = Number.isFinite(at) ? at : null; }
    if (['reasoning_chunk', 'answer_chunk', 'model_first_chunk', 'tool_call'].includes(row.phase) && requestedAt !== null && Number.isFinite(at)) {
      outcome.ttftMs.push(Math.max(0, at - requestedAt)); requestedAt = null;
    }
    if (row.phase === 'tool_result') {
      let value: Record<string, unknown> = row;
      try { if (row.b64) value = JSON.parse(Buffer.from(row.b64, 'base64').toString('utf8')); } catch {}
      const latency = Number(value.latency_ms);
      if (value.latency_ms !== null && value.latency_ms !== undefined && Number.isFinite(latency)) outcome.toolMs.push(latency);
      if (value.name) outcome.toolNames.push(String(value.name));
    }
  }
}

export async function runOnce(task: string, options: { root: string; userDataDir: string; preset: string; timeoutMs: number }): Promise<Measurement> {
  const worker = path.join(options.root, 'build', 'electron', 'runtime', 'worker.js');
  if (!existsSync(worker)) throw new Error('Compiled worker missing; run npm run build:electron first.');
  const started = performance.now(), sessionId = `measure-runtime-${randomUUID()}`;
  return new Promise(resolve => {
    const child = spawn(process.execPath, [worker, 'conversation'], { cwd: options.root, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MAGIC_POINTER_USER_DATA_DIR: options.userDataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure = '';
    const timer = setTimeout(() => { failure = `timeout>${options.timeoutMs / 1000}s`; child.kill(); }, options.timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { failure = error.message; }); child.stdin.on('error', error => { failure ||= error.message; });
    child.on('close', code => {
      clearTimeout(timer);
      const outcome: Measurement = { ok: false, error: failure, wallMs: performance.now() - started, totalMs: null, bootMs: null, turns: 0, ttftMs: [], toolMs: [], toolNames: [], usedBackend: '' };
      try {
        const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}');
        outcome.ok = code === 0 && !failure && result.ok === true && Boolean(String(result.answer || '').trim());
        outcome.usedBackend = String(result.usedBackend || '');
        if (!outcome.ok) outcome.error ||= String(result.error || `No successful answer (exit ${code})`).slice(0, 500);
      } catch (error) { outcome.error ||= `Invalid worker response: ${(error as Error).message}`; }
      reducePhases(phases(stderr), outcome); resolve(outcome);
    });
    child.stdin.end(JSON.stringify({ root: options.root, question: task, turns: [], object: {}, permissionPreset: options.preset, effort: 'high', conversationId: sessionId, agentSessionId: sessionId }));
  });
}

const sum = (values: number[]) => values.reduce((left, right) => left + right, 0);
export const percentile = (values: number[], fraction: number): number | null => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.round(fraction * (values.length - 1)))] : null;
const fmt = (value: number | null) => value === null ? '—' : `${value.toFixed(1)}ms`;

async function main(): Promise<void> {
  const args = process.argv.slice(2), values = new Map<string, string>();
  if (args.includes('--help')) {
    console.log('tsx scripts/measure-runtime.ts [--runs 3] [--task "List open windows using tools"] [--preset read-only] [--timeout 180] [--min-success 1] [--user-data DIRECTORY] [--json FILE]'); return;
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!['--runs', '--task', '--preset', '--timeout', '--min-success', '--user-data', '--json'].includes(args[index]) || args[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    values.set(args[index], args[index + 1]);
  }
  const root = path.resolve(__dirname, '..'), runs = Number(values.get('--runs') ?? 3), timeout = Number(values.get('--timeout') ?? 180), minimum = Number(values.get('--min-success') ?? 1);
  if (!Number.isInteger(runs) || runs < 1 || !Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(minimum) || minimum < 0 || minimum > 1) throw new Error('Invalid runs, timeout or min-success value');
  const task = values.get('--task') || '列出当前打开的所有窗口标题，然后告诉我一共几个。必须调用工具获取。';
  const userDataDir = path.resolve(values.get('--user-data') || process.env.MAGIC_POINTER_USER_DATA_DIR || path.join(root, 'data', 'runtime'));
  const outcomes: Measurement[] = [];
  console.log(`Measuring ${runs} real compiled worker runs. Data: ${userDataDir}`);
  for (let index = 0; index < runs; index++) {
    const outcome = await runOnce(task, { root, userDataDir, preset: values.get('--preset') || 'read-only', timeoutMs: timeout * 1000 }); outcomes.push(outcome);
    console.log(`run ${index + 1}: ${outcome.ok ? 'ok' : 'FAIL: ' + outcome.error}; wall ${fmt(outcome.wallMs)}; model wait ${fmt(sum(outcome.ttftMs))}; tools ${fmt(sum(outcome.toolMs))}; rounds ${outcome.turns}`);
  }
  const passed = outcomes.filter(outcome => outcome.ok), successRate = passed.length / outcomes.length;
  const walls = passed.map(item => item.wallMs), waits = passed.map(item => sum(item.ttftMs)), tools = passed.map(item => sum(item.toolMs));
  const summary = { task, runs, successRate, wallMsP50: percentile(walls, .5), wallMsP95: percentile(walls, .95), modelWaitMsP50: percentile(waits, .5), toolMsP50: percentile(tools, .5), outcomes };
  console.log(`Success ${passed.length}/${runs}; wall p50 ${fmt(summary.wallMsP50)}, p95 ${fmt(summary.wallMsP95)}; model wait p50 ${fmt(summary.modelWaitMsP50)}; tools p50 ${fmt(summary.toolMsP50)}`);
  if (values.has('--json')) { const file = path.resolve(values.get('--json')!); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(summary, null, 2) + '\n'); }
  if (successRate < minimum) process.exitCode = 1;
}

if (require.main === module) void main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
