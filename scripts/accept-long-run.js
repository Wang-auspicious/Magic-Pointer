const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { EventSession } = require(path.join(root, 'build/electron/runtime/session.js'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const startedAt = Date.now(), directory = path.join(root, 'data', 'runtime', 'personal-agent-acceptance', 'long-run', randomUUID());
  const workspace = path.join(directory, 'workspace'), userDataDir = path.join(directory, 'user');
  await fs.mkdir(workspace, { recursive: true });
  const before = 'Order: Aurora\r\nQuantity: 100\r\nDelivery: Friday\r\n';
  await fs.writeFile(path.join(workspace, 'A.txt'), before);
  await fs.writeFile(path.join(workspace, 'B.txt'), before);
  const report = { startedAt: new Date(startedAt).toISOString(), directory, workspace, phase: 'starting', releaseAfterMs: 3610000, restartAfterWaitMs: 90000, workerRestarts: 0 };
  const save = async () => fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  await save();
  console.log(JSON.stringify({ report: path.join(directory, 'report.json'), phase: report.phase }));
  const producer = spawn(process.execPath, ['-e', "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'Approved units: 314\\n'),Number(process.argv[2]))", path.join(workspace, 'release.txt'), String(report.releaseAfterMs)], { windowsHide: true, stdio: 'ignore' });
  let worker;
  const payload = { root, workspaceRoot: workspace, permissionPreset: 'auto', effort: 'high', conversationId: 'hour-long-file-task',
    question: 'This is an authorized long wait for an external producer. Load the wait tool and wait locally for release.txt with timeout_s=3700 and poll_ms=2000; do not poll using model turns or shell commands. Once it exists, Read its approved units and Read A.txt, then Edit only the Quantity line of A.txt to that value, preserving all other bytes. Read back and report. Do not edit any file before release.txt arrives.' };
  const run = (request, attempt) => {
    const child = spawn(process.execPath, [path.join(root, 'build/electron/runtime/worker.js'), 'conversation'], { cwd: root, windowsHide: true,
      env: { ...process.env, MAGIC_POINTER_USER_DATA_DIR: userDataDir, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    worker = child; let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.end(JSON.stringify(request));
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', async code => {
      await fs.writeFile(path.join(directory, `attempt-${attempt}.stdout`), output); await fs.writeFile(path.join(directory, `attempt-${attempt}.stderr`), errors);
      resolve({ code, output });
    }); });
  };
  try {
    const first = run(payload, 1);
    let sessionId, waitStarted = 0;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const files = await fs.readdir(path.join(userDataDir, 'agent-sessions')).catch(() => []);
      sessionId = files.find(file => file.endsWith('.jsonl'))?.slice(0, -6);
      if (sessionId) {
        const events = (await fs.readFile(path.join(userDataDir, 'agent-sessions', sessionId + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        if (events.some(event => event.type === 'operation/prepared' && event.data.name === 'wait' && event.data.dispatched)) { waitStarted = Date.now(); break; }
      }
      if (worker.exitCode !== null) throw new Error('first worker ended before waiting');
      await pause(250);
    }
    assert(waitStarted, 'model must start the local wait');
    Object.assign(report, { phase: 'first_wait', sessionId, waitStartedAt: new Date(waitStarted).toISOString() }); await save();
    console.log(JSON.stringify({ phase: report.phase, sessionId }));
    await pause(report.restartAfterWaitMs);
    worker.kill(); await first;
    const session = await EventSession.open(userDataDir, sessionId, false);
    await session.enqueue('Correction: A.txt is reference only and must remain unchanged. After release.txt arrives, change only B.txt Quantity to its approved units and preserve all other bytes. Keep waiting locally if release.txt is absent.', 'next-step');
    Object.assign(report, { phase: 'resumed_wait', workerRestarts: 1, restartedAt: new Date().toISOString() }); await save();
    console.log(JSON.stringify({ phase: report.phase, sessionId }));
    const second = await run({ ...payload, question: '', agentSessionId: sessionId, resume: true }, 2);
    const result = JSON.parse(second.output.trim().split(/\r?\n/).at(-1) || '{}');
    Object.assign(report, { phase: 'finished', elapsedMs: Date.now() - startedAt, exitCode: second.code, result });
    const a = await fs.readFile(path.join(workspace, 'A.txt')), b = await fs.readFile(path.join(workspace, 'B.txt'));
    report.aUnchanged = a.equals(Buffer.from(before)); report.bExact = b.equals(Buffer.from(before.replace('Quantity: 100', 'Quantity: 314')));
    const finalSession = await EventSession.open(userDataDir, sessionId, false);
    const writes = finalSession.events.filter(event => event.type === 'operation/prepared' && event.data.dispatched && event.data.effect !== 'read');
    const releaseAt = (await fs.stat(path.join(workspace, 'release.txt'))).mtimeMs;
    report.writes = writes.map(event => ({ time: event.time, tool: event.data.name, arguments: event.data.arguments }));
    report.modelRequests = finalSession.events.filter(event => event.type === 'model/request').length;
    report.noEarlyWrites = writes.every(event => event.time >= releaseAt);
    report.onlyBEdited = writes.length > 0 && writes.every(event => event.data.name === 'Edit' && path.resolve(workspace, String(event.data.arguments.path)).toLowerCase() === path.join(workspace, 'B.txt').toLowerCase());
    report.verified = second.code === 0 && result.ok === true && result.hasPendingWork === false && report.aUnchanged && report.bExact && report.noEarlyWrites && report.onlyBEdited && report.elapsedMs >= 3600000;
    await save(); console.log(JSON.stringify({ report: path.join(directory, 'report.json'), verified: report.verified, elapsedMs: report.elapsedMs }));
    assert(report.verified, 'long-run result conditions failed');
  } catch (error) { Object.assign(report, { phase: 'failed', error: error.message, elapsedMs: Date.now() - startedAt }); await save(); throw error; }
  finally { if (worker?.exitCode === null) worker.kill(); if (producer.exitCode === null) producer.kill(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
