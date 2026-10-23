import assert from 'node:assert/strict';
import test from 'node:test';
import {runShell, commandEffect} from '../electron/runtime/agent_files';
import {ProgressTracker} from '../electron/runtime/agent_outcomes';

const missing =
  process.platform === 'win32'
    ? 'type "C:\\definitely\\not\\here\\mp-read-probe.txt"'
    : 'cat "/definitely/not/here/mp-read-probe.txt"';
const failFast =
  process.platform === 'win32' ? 'cmd /c exit 1' : "sh -c 'exit 1'";

test('a read-classified probe that exits 1 returns data instead of throwing', async () => {
  assert.equal(commandEffect({command: missing}), 'read');
  const result = await runShell(
    missing,
    process.cwd(),
    AbortSignal.timeout(15000),
    15000,
  );
  assert.equal(result.exit, 1);
  assert.match(String(result.stderr), /not|找不到|no such/i);
});

test('a non-read command that exits 1 still throws a tool error', async () => {
  assert.equal(commandEffect({command: failFast}), 'local_irreversible');
  await assert.rejects(
    runShell(failFast, process.cwd(), AbortSignal.timeout(15000), 15000),
    /exited with code 1/,
  );
});

test('first-seen read probe data counts as progress for the activity budget', () => {
  const tracker = new ProgressTracker();
  const call = {id: 'probe', name: 'Bash', arguments: {command: missing}};
  const seen = tracker.observe(
    call,
    {
      tool_call_id: 'probe',
      tool_name: 'Bash',
      value: {exit: 1, cwd: process.cwd(), stdout: '', stderr: 'not found'},
      is_error: false,
      failure_type: null,
      used_backend: 'shell',
      latency_ms: 1,
      outcome_known: true,
    },
    'read',
  );
  assert.equal(seen.progress, true);
  assert.equal(seen.stalled, false);
});
