import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runOnce, type Measurement } from './measure-runtime';

const task = 'Read approved.txt, then change only the Quantity line in order.txt to the approved Aurora quantity. Preserve every other character of order.txt. Read back the result before answering.';
const initialOrder = Buffer.from('Order: Aurora\nQuantity: 98\nDelivery: Tuesday\n');
const finalOrder = Buffer.from('Order: Aurora\nQuantity: 112\nDelivery: Tuesday\n');
const approved = Buffer.from('Approved Aurora quantity: 112\n');
type Side = 'mp' | 'pi';
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; reported: number };

function options(argv: string[]) {
  const values = new Map<string, string>();
  if (argv.includes('--help')) {
    console.log('tsx scripts/eval-file-harness-comparison.ts [--pi-cli PATH] [--out DIRECTORY] [--pairs 3] [--first mp|pi] [--timeout 180] [--user-data DIRECTORY]');
    process.exit(0);
  }
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--pi-cli', '--out', '--pairs', '--first', '--timeout', '--user-data'].includes(argv[i]!) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    values.set(argv[i]!, argv[i + 1]!);
  }
  const pairs = Number(values.get('--pairs') ?? 3), timeout = Number(values.get('--timeout') ?? 180);
  if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10 || !Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid pairs or timeout');
  const first = values.get('--first') || 'mp';
  if (first !== 'mp' && first !== 'pi') throw new Error('Invalid first runner');
  return { values, pairs, first: first as Side, timeoutMs: timeout * 1000 };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mpUncached(outcome: Measurement): number | null {
  const usage = outcome.modelUsage;
  return usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)
    ? Math.max(0, usage.inputTokens - (usage.cacheReadTokens || 0)) + usage.outputTokens : null;
}

async function exactBytes(workspace: string): Promise<{ orderExact: boolean; approvedUnchanged: boolean }> {
  const order = await readFile(path.join(workspace, 'order.txt')).catch(() => Buffer.alloc(0));
  const approval = await readFile(path.join(workspace, 'approved.txt')).catch(() => Buffer.alloc(0));
  return { orderExact: order.equals(finalOrder), approvedUnchanged: approval.equals(approved) };
}

async function prepare(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await Promise.all([writeFile(path.join(workspace, 'order.txt'), initialOrder), writeFile(path.join(workspace, 'approved.txt'), approved)]);
}

function piCliPath(explicit?: string): string {
  const selected = explicit || process.env.MP_PI_CLI;
  if (!selected) throw new Error('Pass --pi-cli with the installed Pi executable or dist/cli.js path (or set MP_PI_CLI).');
  return path.resolve(selected);
}

async function runPi(piCli: string, workspace: string, configDir: string, sessionDir: string, apiKey: string,
  timeoutMs: number, logDir: string): Promise<Record<string, unknown>> {
  const args = ['--mode', 'json', '--provider', 'mp-eval', '--model', 'deepseek-v4.1-flash', '--thinking', 'high',
    '--session-dir', sessionDir, '--no-extensions', '--no-skills', '--no-prompt-templates', task];
  const command = piCli.toLowerCase().endsWith('.js') ? process.execPath : piCli;
  const commandArgs = command === process.execPath ? [piCli, ...args] : args;
  const started = performance.now();
  let stdout = '', stderr = '', timedOut = false, spawnError = '';
  const child = spawn(command, commandArgs, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PI_CODING_AGENT_DIR: configDir, MP_PI_EVAL_API_KEY: apiKey } });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const exitCode = await new Promise<number | null>(resolve => {
    child.once('error', error => { spawnError = error.message; resolve(null); });
    child.once('close', resolve);
  });
  clearTimeout(timer);
  const redact = (text: string) => text.split(apiKey).join('[redacted]');
  await Promise.all([writeFile(path.join(logDir, 'pi-events.jsonl'), redact(stdout)), writeFile(path.join(logDir, 'pi-stderr.log'), redact(stderr))]);
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } });
  const assistants = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(event => event.message);
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reported: 0 };
  for (const message of assistants) if (message.usage) {
    usage.reported++;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[key] += Number(message.usage[key] || 0);
  }
  const bytes = await exactBytes(workspace);
  return { side: 'pi', verified: exitCode === 0 && !timedOut && assistants.length > 0 && bytes.orderExact && bytes.approvedUnchanged,
    ...bytes, exitCode, timedOut, error: redact(spawnError || stderr).slice(-800), wallMs: performance.now() - started,
    rounds: assistants.length, tools: events.filter(event => event.type === 'tool_execution_start').map(event => event.toolName),
    reportedModels: [...new Set(assistants.map(message => String(message.model || '')).filter(Boolean))],
    stopReasons: assistants.map(message => message.stopReason || null), usage,
    uncachedInputPlusOutput: usage.reported ? usage.input + usage.output : null,
    logs: ['pi-events.jsonl', 'pi-stderr.log'] };
}

async function main(): Promise<void> {
  const { values, pairs, first, timeoutMs } = options(process.argv.slice(2));
  const repository = path.resolve(__dirname, '..');
  const userDataDir = path.resolve(values.get('--user-data') || path.join(repository, 'data', 'runtime', 'personal-agent-acceptance'));
  const outputRoot = path.resolve(values.get('--out') || path.join(repository, 'data', 'runtime', 'personal-agent-acceptance', 'paired-comparison'));
  const fixture = path.join(repository, 'data', 'runtime', 'personal-agent-acceptance', 'eval', 'precise-edit');
  if (!(await readFile(path.join(fixture, 'approved.txt'))).equals(approved) || !(await readFile(path.join(fixture, 'order.txt'))).equals(finalOrder))
    throw new Error('The original MP acceptance fixture changed; comparison input is not verified.');
  const { resolveModelConfig } = require(path.join(repository, 'build', 'electron', 'runtime', 'model.js')) as {
    resolveModelConfig: (config: null, root: string, userDataDir: string) => { model: string; apiMode?: string; baseUrl?: string; credential?: string };
  };
  const config = resolveModelConfig(null, repository, userDataDir);
  if (config.model !== 'deepseek-v4.1-flash' || config.apiMode !== 'chat-completions' || !config.baseUrl || !config.credential || new URL(config.baseUrl).hostname !== 'opencode.ai')
    throw new Error('MP model/provider/credential does not match the requested paired comparison.');
  const piCli = piCliPath(values.get('--pi-cli'));
  await readFile(piCli);
  const piPackage = await readFile(path.resolve(path.dirname(piCli), '..', 'package.json'), 'utf8').then(text => JSON.parse(text).version as string, () => null);
  await mkdir(outputRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(outputRoot, 'run-'));
  const configDir = path.join(runDir, 'pi-config');
  await mkdir(configDir);
  await writeFile(path.join(configDir, 'models.json'), JSON.stringify({ providers: { 'mp-eval': {
    baseUrl: config.baseUrl, api: 'openai-completions', apiKey: '$MP_PI_EVAL_API_KEY',
    models: [{ id: config.model, name: config.model, reasoning: true, input: ['text'], contextWindow: 128000,
      maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }, null, 2) + '\n');
  const report: Record<string, any> = { schemaVersion: 1, createdAt: new Date().toISOString(),
    task, input: { orderBefore: initialOrder.toString(), approved: approved.toString(), orderAfter: finalOrder.toString() },
    model: { id: config.model, apiMode: config.apiMode, providerHost: new URL(config.baseUrl).hostname, effort: 'high' },
    pi: { package: '@earendil-works/pi-coding-agent', version: piPackage, defaultBuiltinTools: true,
      extensionsEnabled: false, skillsEnabled: false, promptTemplatesEnabled: false },
    pairs: [] as Array<Record<string, unknown>>, summary: null };
  const persist = async () => writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await persist();
  for (let index = 0; index < pairs; index++) {
    const pairDir = path.join(runDir, `pair-${index + 1}`), order: Side[] = index % 2 ? [first === 'mp' ? 'pi' : 'mp', first] : [first, first === 'mp' ? 'pi' : 'mp'];
    const mpWorkspace = path.join(pairDir, 'mp'), piWorkspace = path.join(pairDir, 'pi');
    await Promise.all([prepare(mpWorkspace), prepare(piWorkspace), mkdir(path.join(pairDir, 'pi-sessions'), { recursive: true })]);
    const pair: Record<string, any> = { number: index + 1, runOrder: order, mp: null, pi: null };
    report.pairs.push(pair); await persist();
    for (const side of order) {
      if (side === 'mp') {
        const outcome = await runOnce(task, { root: repository, userDataDir, preset: 'auto', timeoutMs, workspaceRoot: mpWorkspace });
        const bytes = await exactBytes(mpWorkspace);
        pair.mp = { side, verified: outcome.ok && !outcome.hasPendingWork && bytes.orderExact && bytes.approvedUnchanged,
          ...bytes, protocolCompleted: outcome.ok, hasPendingWork: outcome.hasPendingWork === true,
          error: outcome.error.slice(0, 800), wallMs: outcome.wallMs, rounds: outcome.turns, tools: outcome.toolNames,
          answer: String(outcome.answer || '').slice(0, 1500), usedBackend: outcome.usedBackend, usage: outcome.modelUsage ?? null, cache: outcome.cache ?? null,
          uncachedInputPlusOutput: mpUncached(outcome), sessionId: outcome.sessionId };
      } else pair.pi = await runPi(piCli, piWorkspace, configDir, path.join(pairDir, 'pi-sessions'), config.credential!, timeoutMs, pairDir);
      await persist();
      const row = pair[side];
      console.log(`pair ${index + 1} ${side}: ${row.verified ? 'VERIFIED' : 'FAILED'}; ${Math.round(row.wallMs)}ms; ${row.rounds} rounds; uncached+output=${row.uncachedInputPlusOutput ?? 'unreported'}`);
    }
  }
  const attempts = report.pairs.flatMap((pair: any) => [pair.mp, pair.pi]);
  const summaryFor = (side: Side) => {
    const rows = attempts.filter((item: any) => item.side === side);
    return { correct: rows.filter((item: any) => item.verified).length, attempts: rows.length,
      successfulUncachedPlusOutputMedian: median(rows.filter((item: any) => item.verified).map((item: any) => item.uncachedInputPlusOutput).filter((value: unknown): value is number => typeof value === 'number')),
      allReportedUncachedPlusOutputMedian: median(rows.map((item: any) => item.uncachedInputPlusOutput).filter((value: unknown): value is number => typeof value === 'number')),
      successfulWallMsMedian: median(rows.filter((item: any) => item.verified).map((item: any) => item.wallMs)),
      allWallMsMedian: median(rows.map((item: any) => item.wallMs)),
      totalReportedUncachedPlusOutput: rows.reduce((sum: number, item: any) => sum + (item.uncachedInputPlusOutput ?? 0), 0),
      missingUsageAttempts: rows.filter((item: any) => item.uncachedInputPlusOutput === null).length };
  };
  const mp = summaryFor('mp'), pi = summaryFor('pi');
  const ratio = mp.successfulUncachedPlusOutputMedian !== null && pi.successfulUncachedPlusOutputMedian
    ? mp.successfulUncachedPlusOutputMedian / pi.successfulUncachedPlusOutputMedian : null;
  const correctnessAtLeastPi = mp.correct >= pi.correct;
  const tokenMedianWithin125Percent = ratio !== null && ratio <= 1.25;
  report.summary = { mp, pi,
    successfulTokenMedianRatio: ratio,
    gate: { correctnessAtLeastPi, tokenMedianWithin125Percent, achieved: correctnessAtLeastPi && tokenMedianWithin125Percent },
    interpretation: 'Three paired same-file, same-model runs; each side starts from identical bytes. Failed attempts remain in pairs and total token spend. The successful-task median is a small-sample result.' };
  await persist();
  console.log(`report: ${path.join(runDir, 'report.json')}`);
  if (mp.correct !== pairs || pi.correct !== pairs || mp.missingUsageAttempts || pi.missingUsageAttempts) process.exitCode = 1;
}

if (require.main === module) void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
