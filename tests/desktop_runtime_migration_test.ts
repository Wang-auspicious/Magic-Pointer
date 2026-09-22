const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { FrameCaptureService } = require('../electron/runtime/desktop_capture');
const { textsAgree, selectOpenStroke, registerPerceptionTools } = require('../electron/runtime/desktop_perception');
const { parseComputerResponse, extractTerminalEvidence } = require('../electron/runtime/desktop_operator');
const { registerDesktopTools } = require('../electron/runtime/desktop');
const { ToolRegistry } = require('../electron/runtime/tools');

async function main() {
  const registry = new ToolRegistry(); registerDesktopTools(registry); registerPerceptionTools(registry, { snapshot: {} }); assert.ok(registry.get('choose_ui_target')); assert.ok(registry.get('look')); assert.equal(registry.get('type_text').effect_for({ submit: true }), 'external_send');
  assert.equal(textsAgree('profit +20.5%', 'profit -20.5%'), false);
  assert.deepEqual(selectOpenStroke([[10, 10, 80, 20], [10, 50, 80, 20]], [[0, 32], [100, 32]]), [0]);
  assert.throws(() => parseComputerResponse("Action: click(start_box=__import__('os').system('bad'))"), /literal/);
  assert.deepEqual(parseComputerResponse('Action: click(start_box=(50, 25))', [100, 100])[0].start, [0.5, 0.25]);
  const terminal = extractTerminalEvidence('PS C:\\a> first\nError old\nexit code: 8\nPS C:\\a> second\nError current', 'uia:text'); assert.equal(terminal.command, 'second'); assert.equal(terminal.exitCode, null);
  const root = await mkdtemp(join(tmpdir(), 'mp-frame-'));
  let complete: ((value: any) => void) | undefined, count = 0;
  const service = new FrameCaptureService(root, 1, async () => { count++; if (count === 1) return { bytes: Buffer.from('historical'), width: 10, height: 10, source: 'test', capturedAtUtc: new Date().toISOString() }; return new Promise(resolve => { complete = resolve; }); });
  try {
    service.arm({ epochId: 'one', displayId: 'one', surfaceBoundsPx: [0, 0, 10, 10] });
    await new Promise(resolve => setTimeout(resolve, 10));
    const frozen = await service.commit({ epochId: 'one' });
    complete?.({ bytes: Buffer.from('late'), width: 10, height: 10, source: 'test', capturedAtUtc: new Date().toISOString() });
    assert.equal((await readFile(frozen.localArtifact.path)).toString(), 'historical');
    service.arm({ epochId: 'two', displayId: 'one', surfaceBoundsPx: [0, 0, 10, 10] });
    await assert.rejects(service.commit({ epochId: 'two' }), /no_frame_buffered/);
  } finally { service.cancel(); await rm(root, { recursive: true, force: true }); }
  console.log('desktop runtime migration tests passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
