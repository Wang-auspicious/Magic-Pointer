import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeGitWorkspace } from '../electron/runtime/context_workspace';
import { buildContextPacket, renderAgentPrompt } from '../electron/runtime/context_policy';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

test('workspace probe reports branch, head, changed files and a bounded diff', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mp-workspace-'));
  git(repo, 'init', '-q', '-b', 'feature/cart');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  writeFileSync(join(repo, 'cart.ts'), 'export const total = 1;\n');
  git(repo, 'add', 'cart.ts');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'cart');
  writeFileSync(join(repo, 'cart.ts'), 'export const total = 2;\n');
  writeFileSync(join(repo, 'notes.md'), 'todo\n');
  const workspace = await probeGitWorkspace(join(repo));
  assert.equal(workspace.branch, 'feature/cart');
  assert.match(String(workspace.head), /^[0-9a-f]{12}$/);
  assert.equal(workspace.isDirty, true);
  assert.deepEqual([...(workspace.changedFiles as string[])].sort(), ['cart.ts', 'notes.md']);
  assert.match(String(workspace.diffExcerpt), /\+export const total = 2;/);
  const outside = await probeGitWorkspace(mkdtempSync(join(tmpdir(), 'mp-no-repo-')));
  assert.equal(outside.repoRoot, '');
  assert.deepEqual(outside.changedFiles, []);
});

test('the handoff prompt is readable evidence, not a JSON dump', () => {
  const objects = [
    { id: 'o1', referenceLabel: 'A', kind: 'text', label: 'Total', content: 'Total: $12', bbox: { x: 10, y: 10, width: 40, height: 20 }, source: { app: 'msedge.exe', title: 'Cart',
      browserContext: { page: { title: 'Cart', url: 'https://shop.example.com/cart' }, networkFailures: [{ url: 'https://api.example.com/cart', errorText: 'HTTP 500', source: 'resource_timing' }], consoleErrors: [{ text: 'TypeError: cart.items is undefined' }] } } },
    { id: 'o2', referenceLabel: 'B', kind: 'text', label: 'Tax', content: 'Tax: $0', bbox: { x: 200, y: 10, width: 40, height: 20 }, source: { app: 'msedge.exe', title: 'Cart' } },
  ];
  const packet = buildContextPacket({ command: 'why is tax zero', recipeId: 'agent.handoff', objects, cwd: process.cwd(), targetLease: { leaseId: 'L1' },
    captureDecisions: objects.map(() => ({ allowStructure: true, allowUpload: false })) as never,
    workspace: { cwd: 'D:/shop', repoRoot: 'D:/shop', branch: 'feature/cart', head: 'abc123def456', isDirty: true, changedFiles: ['cart.ts'], diffStat: ' cart.ts | 2 +-', diffExcerpt: '+export const total = 2;' },
    terminalExcerpt: 'npm test\nFAIL cart.test.ts' });
  assert.deepEqual(packet.spatialRelations, [{ from: 'A', to: 'B', horizontal: 'left_of', vertical: 'aligned', delta: [190, 0] }]);
  const prompt = renderAgentPrompt(packet, 'C:/packets/p.json');
  for (const expected of ['why is tax zero', 'C:/packets/p.json', 'feature/cart', 'abc123def456', 'cart.ts', '+export const total = 2;', 'Total: $12', 'A is left of B',
    'HTTP 500 https://api.example.com/cart', 'TypeError: cart.items is undefined', 'FAIL cart.test.ts']) assert.ok(prompt.includes(expected), `missing ${expected}\n${prompt}`);
  assert.ok(!prompt.includes('"schemaVersion"'), 'no raw packet JSON');
});
