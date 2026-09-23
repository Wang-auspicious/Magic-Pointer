import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

type Data = Record<string, any>;
type RecordedEvent = { type: string; seq: number; data: Data };
const root = resolve(__dirname, '..');
const outputRoot = join(root, 'data', 'runtime', 'personal-agent-acceptance', 'native-excel-model');
const modelFlag = process.argv.indexOf('--model-root');
if (modelFlag >= 0 && !process.argv[modelFlag + 1]) throw new Error('--model-root requires a directory');
const modelRoot = resolve(modelFlag >= 0 ? process.argv[modelFlag + 1]!
  : process.env.MP_ACCEPT_MODEL_ROOT || root);
const runtimeFlag = process.argv.indexOf('--runtime-dir');
if (runtimeFlag >= 0 && !process.argv[runtimeFlag + 1]) throw new Error('--runtime-dir requires a directory');
const runtimeDir = resolve(runtimeFlag >= 0 ? process.argv[runtimeFlag + 1]!
  : process.env.MP_ACCEPT_RUNTIME_DIR || join(root, 'build', 'electron', 'runtime'));
const { resolveModelConfig } = require(join(runtimeDir, 'model.js')) as {
  resolveModelConfig: (config: null, root: string, userDataDir: string) => Data;
};
const { runRuntime } = require(join(runtimeDir, 'index.js')) as {
  runRuntime: (payload: Data, options: { root: string; userDataDir: string; signal?: AbortSignal }) => Promise<Data>;
};
const { handleArtifact } = require(join(runtimeDir, 'artifacts.js')) as {
  handleArtifact: (payload: Data, userDataDir: string) => Promise<Data>;
};
const { EventSession } = require(join(runtimeDir, 'session.js')) as {
  EventSession: { open: (userDataDir: string, sessionId: string, repair?: boolean) => Promise<{ events: RecordedEvent[] }> };
};
const { runPowerShellJson, closeDesktop } = require(join(runtimeDir, 'desktop.js')) as {
  runPowerShellJson: (script: string, signal?: AbortSignal, timeoutMs?: number) => Promise<Data>;
  closeDesktop: () => void;
};

const escaped = (value: unknown) => String(value).replaceAll("'", "''");
const briefError = (error: unknown) => String(error).replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 600);

async function inspect(setup: Data): Promise<Data> {
  return runPowerShellJson(String.raw`
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$book=$null
foreach($candidate in @($app.Workbooks)){
 if(-not [string]::Equals([string]$candidate.FullName,'${escaped(setup.workbook)}',[StringComparison]::OrdinalIgnoreCase)){continue}
 foreach($win in @($candidate.Windows)){if([int64]$win.HWND -eq ${Number(setup.hwnd)}){$book=$candidate;break}}
 if($book){break}
}
if($null -eq $book){throw 'acceptance_workbook_identity_changed'}
$sheet=$book.Worksheets.Item('${escaped(setup.sheet)}')
@{target=$sheet.Range('B2').Value2;neighbor=[string]$sheet.Range('C2').Value2;saved=[bool]$book.Saved;visible=[bool]$app.Visible;diskExists=(Test-Path -LiteralPath $book.FullName)} | ConvertTo-Json -Compress`);
}

async function closeOwned(setup: Data): Promise<boolean> {
  const result = await runPowerShellJson(String.raw`
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$bound=$null
foreach($book in @($app.Workbooks)){
 if(-not [string]::Equals([string]$book.FullName,'${escaped(setup.workbook)}',[StringComparison]::OrdinalIgnoreCase)){continue}
 foreach($win in @($book.Windows)){if([int64]$win.HWND -eq ${Number(setup.hwnd)}){$bound=$book;break}}
 if($bound){break}
}
if($bound){$bound.Close($false);if([int]$app.Workbooks.Count -eq 0){$app.Quit()}}
@{closed=[bool]$bound} | ConvertTo-Json -Compress`, undefined, 20000);
  return result.closed === true;
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  const runDir = await mkdtemp(join(outputRoot, 'run-'));
  const report: Data = { schemaVersion: 1, createdAtUtc: new Date().toISOString(),
    scope: 'real model -> exact patch proposal -> artifact accept/apply -> hidden unsaved native Excel COM readback',
    status: 'failed', model: null, timingsMs: {}, proposal: null, application: null, readback: null,
    fixtureModelUsed: false, nativeApplicationUsed: true, physicalGestureUsed: false,
    runtimeDirectory: runtimeDir, outputDirectory: runDir };
  const started = performance.now();
  let setup: Data | undefined;
  try {
    const config = resolveModelConfig(null, modelRoot, join(modelRoot, 'data', 'runtime'));
    const host = config.baseUrl ? new URL(config.baseUrl).hostname : '';
    assert.equal(config.model, 'deepseek-v4.1-flash');
    assert.equal(config.apiMode, 'chat-completions');
    assert.equal(host, 'opencode.ai');
    assert.ok(config.credential, 'configured model credential is required');
    report.model = { id: config.model, apiMode: config.apiMode, providerHost: host, effort: 'high' };

    const existing = await runPowerShellJson("@{count=@(Get-Process EXCEL -ErrorAction SilentlyContinue).Count} | ConvertTo-Json -Compress");
    assert.equal(existing.count, 0, 'isolated acceptance requires no existing Excel process');
    const setupStarted = performance.now();
    setup = await runPowerShellJson(String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MpModelExcelPid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid); }
"@
$app=New-Object -ComObject Excel.Application
$app.Visible=$false; $app.DisplayAlerts=$false
$book=$app.Workbooks.Add()
$sheet=$book.Worksheets.Item(1)
$sheet.Range('B2').Value2=120
$sheet.Range('C2').Value2='neighbor untouched'
$win=$book.Windows.Item(1)
$ownerPid=[uint32]0
[MpModelExcelPid]::GetWindowThreadProcessId([IntPtr][int64]$win.HWND,[ref]$ownerPid) | Out-Null
@{hwnd=[int64]$win.HWND;pid=[int64]$ownerPid;workbook=[string]$book.FullName;sheet=[string]$sheet.Name;visible=[bool]$app.Visible;saved=[bool]$book.Saved;diskExists=(Test-Path -LiteralPath $book.FullName)} | ConvertTo-Json -Compress`, undefined, 30000);
    report.timingsMs.setup = Math.round(performance.now() - setupStarted);
    assert.equal(setup.visible, false);
    assert.equal(setup.diskExists, false);
    assert.equal(setup.saved, false);
    assert.ok(Number.isSafeInteger(Number(setup.hwnd)) && Number(setup.hwnd) > 0);
    assert.ok(Number.isSafeInteger(Number(setup.pid)) && Number(setup.pid) > 0);

    const baseline = await inspect(setup);
    assert.deepEqual({ target: baseline.target, neighbor: baseline.neighbor, saved: baseline.saved, visible: baseline.visible },
      { target: 120, neighbor: 'neighbor untouched', saved: false, visible: false });

    const sessionId = `agent-${randomUUID()}`;
    const sourceId = 'source:excel-model-hidden';
    const referenceId = 'target:B2';
    const locator = { kind: 'cell-range', value: { sheet: String(setup.sheet), range: 'B2' } };
    const source = { sourceId, taskId: sessionId, kind: 'document', title: String(setup.workbook),
      identity: { host: 'excel', hwnd: Number(setup.hwnd), pid: Number(setup.pid),
        workbookPath: String(setup.workbook), processName: 'EXCEL.EXE' },
      revision: { authority: 'live' }, capabilities: ['read', 'search', 'follow', 'patch'],
      origin: 'user-pointed', parentSourceId: null };
    const reference = { referenceId, label: 'B2 target cell', sourceId, locator, role: 'target',
      frameLeaseId: null, capturedAtMs: Date.now(), ordinal: 1, active: true };
    const question = '请只把当前绑定的 Excel 工作簿 B2 的数值从 120 改为 210，C2 保持不变。';
    const modelStarted = performance.now();
    const runtime = await runRuntime({ question, agentSessionId: sessionId, sources: [source],
      inputArtifact: { references: [reference] }, permissionPreset: 'workspace-write',
      modelRuntime: { ...config, effort: 'high' } },
    { root, userDataDir: runDir, signal: AbortSignal.timeout(180000) });
    report.timingsMs.modelRuntime = Math.round(performance.now() - modelStarted);
    report.modelRuntime = { ok: runtime.ok, reason: runtime.loopTerminatedReason ?? null,
      usedBackend: runtime.usedBackend, timingMs: runtime.timingMs ?? null,
      modelUsage: runtime.modelUsage ?? null, receiptStatus: runtime.receipts?.[0]?.status ?? null };

    const session = await EventSession.open(runDir, sessionId, false);
    const toolResults = session.events.filter(event => event.type === 'operation/settled')
      .map(event => ({ name: (event.data.message as Data)?.name, outcome: event.data.outcome,
        usedBackend: event.data.usedBackend }));
    report.modelRuntime.tools = toolResults;
    const proposalEvent = session.events.find(event => event.type === 'operation/settled' &&
      (event.data.message as Data)?.name === 'Document.propose_patch' && event.data.outcome === 'succeeded');
    const liveReads = session.events.filter(event => event.type === 'operation/settled' &&
      (event.data.message as Data)?.name === 'Context.read' && event.data.outcome === 'succeeded')
      .map(event => { try { return { seq: event.seq, value: JSON.parse(String((event.data.message as Data).content)) as Data }; }
        catch { return { seq: event.seq, value: {} as Data }; } });
    const confirmedRead = liveReads.find(({ seq, value }) => {
      if (!proposalEvent || seq >= proposalEvent.seq) return false;
      const fragments = Array.isArray(value.fragments) ? value.fragments as Data[] : [];
      return fragments.some(item => item.metadata?.address === 'B2' && item.metadata.value === 120) &&
        fragments.some(item => item.metadata?.address === 'C2' && item.metadata.value === 'neighbor untouched');
    });
    report.modelRuntime.liveRead = { confirmed: !!confirmedRead,
      beforeProposal: !!confirmedRead, usedBackend: confirmedRead?.value.usedBackend ?? null, attempts: liveReads.length };
    assert.ok(confirmedRead, 'model must actually read both live B2 and C2 values before proposing');
    assert.ok(proposalEvent,
      'model must actually create the patch proposal');

    const drafts = await handleArtifact({ action: 'read', sessionId }, runDir) as Data;
    assert.equal(drafts.ok, true);
    const proposed = (drafts.artifacts as Data[]).filter(item => item.kind === 'document_patch');
    assert.equal(proposed.length, 1, 'exactly one document patch proposal is required');
    const draft = proposed[0], patch = draft.patchPayload as Data;
    assert.equal(draft.revision, 1);
    assert.equal(patch.references.length, 1);
    assert.deepEqual({ referenceId: patch.references[0].referenceId, sourceId: patch.references[0].sourceId,
      role: patch.references[0].role, locator: patch.references[0].locator },
    { referenceId, sourceId, role: 'target', locator });
    assert.equal(patch.operations.length, 1, 'proposal must contain only B2');
    const operation = patch.operations[0] as Data;
    assert.ok(typeof operation.operationId === 'string' && operation.operationId);
    assert.deepEqual({ operation: operation.operation, sourceId: operation.sourceId,
      referenceId: operation.referenceId, locator: operation.locator, before: operation.before, after: operation.after },
    { operation: 'set_cell_values', sourceId, referenceId, locator, before: [[120]], after: [[210]] });
    report.proposal = { verifiedExact: true, artifactId: draft.artifactId, revision: draft.revision,
      operationId: operation.operationId, operationCount: 1, target: 'B2', before: 120, after: 210 };

    const beforeApply = await inspect(setup);
    assert.deepEqual({ target: beforeApply.target, neighbor: beforeApply.neighbor, saved: beforeApply.saved, visible: beforeApply.visible },
      { target: 120, neighbor: 'neighbor untouched', saved: false, visible: false },
      'workbook must remain unchanged until the exact proposal is accepted');
    const applyStarted = performance.now();
    const accepted = await handleArtifact({ action: 'accept', sessionId,
      artifactId: draft.artifactId, revision: draft.revision }, runDir) as Data;
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const applied = await handleArtifact({ action: 'apply', sessionId,
      artifactId: draft.artifactId, revision: draft.revision }, runDir) as Data;
    report.timingsMs.acceptApply = Math.round(performance.now() - applyStarted);
    report.application = { acceptOk: accepted.ok, applyOk: applied.ok,
      status: applied.result?.status ?? null, verified: applied.result?.verified ?? null,
      succeededOperationIds: applied.result?.succeededOperationIds ?? [],
      usedBackend: applied.result?.usedBackend ?? null };
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.result.status, 'succeeded');
    assert.deepEqual(applied.result.succeededOperationIds, [operation.operationId]);

    const readbackStarted = performance.now();
    const independent = await inspect(setup);
    report.timingsMs.independentComReadback = Math.round(performance.now() - readbackStarted);
    report.readback = { targetB2: independent.target, neighborC2: independent.neighbor,
      saved: independent.saved, visible: independent.visible, diskExists: independent.diskExists,
      usedBackend: 'excel.com.independent' };
    assert.deepEqual(report.readback, { targetB2: 210, neighborC2: 'neighbor untouched',
      saved: false, visible: false, diskExists: false, usedBackend: 'excel.com.independent' });
    report.status = 'passed';
  } catch (error) {
    report.error = briefError(error);
  } finally {
    if (setup) {
      try { report.cleanup = { closedOwnedWorkbook: await closeOwned(setup) }; }
      catch (error) { report.cleanup = { closedOwnedWorkbook: false, error: briefError(error) }; }
    }
    report.timingsMs.total = Math.round(performance.now() - started);
    await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    closeDesktop();
    console.log(JSON.stringify({ status: report.status, report: join(runDir, 'report.json'),
      model: report.model, modelRuntime: report.modelRuntime, proposal: report.proposal,
      application: report.application, readback: report.readback, cleanup: report.cleanup,
      timingsMs: report.timingsMs, error: report.error ?? null }));
    if (report.status !== 'passed') process.exitCode = 1;
  }
}

void main().catch(error => { console.error(briefError(error)); process.exitCode = 1; });
