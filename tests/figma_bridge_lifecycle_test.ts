import assert from 'node:assert/strict';
import { FigmaLoopbackBridge } from '../electron/figma_bridge';
async function main() {
  const bridge = new FigmaLoopbackBridge({ port: 0 });
  const { baseUrl } = await bridge.start();
  const control = { Authorization: `Bearer ${bridge.controlToken}`, 'Content-Type': 'application/json' };
  try {
    bridge.openPairing('task', '123456');
    const pair: any = await (await fetch(baseUrl + '/pair', { method: 'POST', body: JSON.stringify({ pairCode: '123456', documentSessionId: 'doc' }) })).json();
    const plugin = { Authorization: `Bearer ${pair.pluginToken}`, 'Content-Type': 'application/json' };
    await assert.rejects(bridge.request('task', 'doc', 'apply_patch', { operations: [] }, { timeoutMs: 100, pollIntervalMs: 10 }), /figma_command_timed_out/);
    const expired: any = await (await fetch(baseUrl + '/commands', { headers: plugin })).json();
    assert.equal(expired.commands.length, 0, 'a queued write cannot dispatch after the caller times out');

    const queued: any = await (await fetch(baseUrl + '/requests', { method: 'POST', headers: control, body: JSON.stringify({ taskId: 'task', documentSessionId: 'doc', operation: 'export_preview', arguments: {} }) })).json();
    await fetch(baseUrl + '/commands', { headers: plugin });
    await fetch(baseUrl + '/results', { method: 'POST', headers: plugin, body: JSON.stringify({ commandId: queued.commandId, taskId: 'task', documentSessionId: 'doc', ok: true, result: { base64: 'A'.repeat(1000) } }) });
    const result: any = await (await fetch(baseUrl + '/results/' + queued.commandId, { headers: control })).json();
    assert.equal(result.status, 'completed');
    const consumed = await fetch(baseUrl + '/results/' + queued.commandId, { headers: control });
    assert.equal(consumed.status, 404, 'completed payloads are released after consumption');
    console.log('figma_bridge_lifecycle_test: passed');
  } finally { await bridge.stop(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
