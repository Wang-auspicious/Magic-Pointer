import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
class Element {
  children: Element[] = []; handlers: Record<string, (...args: any[]) => any> = {};
  textContent = ''; hidden = false; disabled = false; value = '';
  constructor(public tag = '') {}
  replaceChildren() { this.children = []; }
  append(...children: Element[]) { this.children.push(...children); }
  appendChild(child: Element) { this.children.push(child); }
  setAttribute() {}
  addEventListener(event: string, handler: (...args: any[]) => any) { this.handlers[event] = handler; }
}
async function main() {
  const source = fs.readFileSync(path.resolve(__dirname, '../electron/renderer/studio.ts'), 'utf8');
  const code = source.slice(source.indexOf('let recoveryRenderGeneration ='), source.indexOf('\nfunction esc('));
  const host = new Element('host'); const calls: any[] = [];
  let confirmed = false; let resolved = false;
  const sandbox: any = { activeConversationId: 'c',
    document: { getElementById: () => host, createElement: (tag: string) => new Element(tag) },
    window: { confirm: () => confirmed },
    Data: { recovery: async (payload: any) => {
      calls.push(payload);
      if (payload.action === 'resolve') { resolved = true; return { ok: true }; }
      return { ok: true, pendingRecovery: resolved ? [] : [{ operationId: 'operation-a', tool: 'Write', arguments: { path: 'a.txt' }, verificationCandidates: [{ callId: 'read-a', tool: 'Read', arguments: { path: 'a.txt' }, result: 'old text' }] }] };
    } },
  };
  vm.runInNewContext(transformSync(code, { loader: 'ts' }).code, sandbox);
  await sandbox.renderConversationRecovery('c');
  const section = host.children[0];
  assert.ok(section.children.some((element) => element.textContent.includes('old text')), 'the actual readback is visible before permission');
  const button = section.children.find((element) => element.tag === 'button')!;
  await button.handlers.click(); assert.equal(resolved, false, 'cancelled confirmation makes no recovery mutation');
  confirmed = true; await button.handlers.click();
  const sent = calls.find((payload) => payload.action === 'resolve');
  assert.equal(sent.operationId, 'operation-a'); assert.equal(sent.verificationCallId, 'read-a'); assert.equal(sent.confirmed, true);
  assert.equal(host.hidden, true, 'resolved barriers disappear after authoritative refresh');
  console.log('recovery_panel_test: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
