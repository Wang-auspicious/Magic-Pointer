import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runOnce, verifyBenchmarkOutcome, type BenchmarkExpectation } from './measure-runtime';

type CaseId = 'cross-source' | 'precise-edit';

interface EvalCase {
  id: CaseId;
  task: string;
  preset: string;
  workspace: string;
  initialFiles: Array<{ path: string; text: string }>;
  expected: BenchmarkExpectation;
}

function argumentsOf(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--case', '--repeats', '--timeout', '--user-data', '--out'].includes(argv[index]) || argv[index + 1] === undefined)
      throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    values.set(argv[index], argv[index + 1]);
  }
  const selected = values.get('--case') || 'all';
  if (!['all', 'cross-source', 'precise-edit'].includes(selected)) throw new Error('Unknown benchmark case');
  const repeats = Number(values.get('--repeats') || 1), timeout = Number(values.get('--timeout') || 180);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isFinite(timeout) || timeout <= 0)
    throw new Error('Invalid repeats or timeout');
  return { selected, repeats, timeoutMs: timeout * 1000, userDataDir: values.get('--user-data'), out: values.get('--out') };
}

async function casesAt(base: string): Promise<EvalCase[]> {
  const first = randomInt(120, 801), change = randomInt(7, 41);
  const original = randomInt(20, 101), approved = original + randomInt(5, 31);
  const crossWorkspace = join(base, 'cross-source'), editWorkspace = join(base, 'precise-edit');
  await mkdir(crossWorkspace, { recursive: true });
  await mkdir(editWorkspace, { recursive: true });
  const brief = `Project Aurora provisional shipment: ${first} units. This number is not final.\n`;
  const update = `Signed change for Project Aurora: add ${change} units to the provisional shipment.\n`;
  const order = `Order: Aurora\nQuantity: ${original}\nDelivery: Tuesday\n`;
  const approval = `Approved Aurora quantity: ${approved}\n`;
  return [{
    id: 'cross-source', workspace: crossWorkspace, preset: 'read-only',
    task: 'Read brief.txt and signed-change.txt in this workspace. Give the final Aurora shipment as FINAL_UNITS=<number>, cite both file names, and do not edit either file.',
    initialFiles: [{ path: 'brief.txt', text: brief }, { path: 'signed-change.txt', text: update }],
    expected: { answerIncludes: [`FINAL_UNITS=${first + change}`, 'brief.txt', 'signed-change.txt'],
      files: [{ path: 'brief.txt', exactText: brief }, { path: 'signed-change.txt', exactText: update }] },
  }, {
    id: 'precise-edit', workspace: editWorkspace, preset: 'auto',
    task: 'Read approved.txt, then change only the Quantity line in order.txt to the approved Aurora quantity. Preserve every other character of order.txt. Read back the result before answering.',
    initialFiles: [{ path: 'order.txt', text: order }, { path: 'approved.txt', text: approval }],
    expected: { files: [{ path: 'order.txt', exactText: `Order: Aurora\nQuantity: ${approved}\nDelivery: Tuesday\n` },
      { path: 'approved.txt', exactText: approval }] },
  }];
}

async function main() {
  const args = argumentsOf(process.argv.slice(2));
  const repository = resolve(__dirname, '..');
  const output = resolve(args.out || join(repository, 'data', 'runtime', 'harness-evals', randomUUID()));
  const userDataDir = resolve(args.userDataDir || process.env.MAGIC_POINTER_USER_DATA_DIR || join(repository, 'data', 'runtime'));
  await mkdir(output, { recursive: true });
  const selected = (await casesAt(output)).filter(item => args.selected === 'all' || item.id === args.selected);
  const { resolveModelConfig } = require(join(repository, 'build', 'electron', 'runtime', 'model.js')) as {
    resolveModelConfig: (config: null, root: string, userDataDir: string) => {
      model: string; apiMode?: string; baseUrl?: string;
    };
  };
  const config = resolveModelConfig(null, repository, userDataDir);
  const packageVersion = String(JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')).version);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const worktreeDirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'],
    { cwd: repository, encoding: 'utf8' }).trim());
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(), repository, commit, worktreeDirty, packageVersion,
    model: { id: config.model, apiMode: config.apiMode,
      providerHost: config.apiMode === 'local' ? 'local' : config.baseUrl ? new URL(config.baseUrl).host : 'api.openai.com' },
    userDataDir, cases: [] as Array<Record<string, unknown>> };
  for (const item of selected) {
    for (let repeat = 1; repeat <= args.repeats; repeat++) {
      for (const file of item.initialFiles) await writeFile(join(item.workspace, file.path), file.text, 'utf8');
      const measurement = await runOnce(item.task, { root: repository, userDataDir, preset: item.preset,
        timeoutMs: args.timeoutMs, workspaceRoot: item.workspace });
      const verdict = await verifyBenchmarkOutcome(measurement, item.expected, item.workspace);
      const row = { caseId: item.id, repeat, verified: verdict.passed, failures: verdict.failures,
        protocolCompleted: measurement.ok, usedBackend: measurement.usedBackend,
        wallMs: measurement.wallMs, rounds: measurement.turns, tools: measurement.toolNames,
        modelUsage: measurement.modelUsage || null, cache: measurement.cache || null,
        answer: measurement.answer || '', sessionId: measurement.sessionId };
      report.cases.push(row);
      console.log(`${item.id} #${repeat}: ${verdict.passed ? 'VERIFIED' : `FAILED ${verdict.failures.join(', ')}`}; `
        + `backend=${measurement.usedBackend || 'unknown'}; wall=${Math.round(measurement.wallMs)}ms; `
        + `cache=${measurement.cache?.hitRate == null ? 'unreported' : `${(measurement.cache.hitRate * 100).toFixed(1)}%`}`);
    }
  }
  const file = join(output, 'report.json');
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`Report: ${file}`);
  if (report.cases.some(item => item.verified !== true)) process.exitCode = 1;
}

if (require.main === module) void main().catch(error => { console.error(error); process.exitCode = 1; });
