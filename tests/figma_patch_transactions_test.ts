import assert from 'node:assert/strict';
import { applyFigmaNodePatch } from '../integrations/figma/patch';
function textNode(value: string): any {
  return {
    id: '1:2', type: 'TEXT', characters: value, fontName: { family: 'Inter', style: 'Regular' },
    deleteCharacters(start: number, end: number) { this.characters = this.characters.slice(0, start) + this.characters.slice(end); },
    insertCharacters(start: number, text: string) { this.characters = this.characters.slice(0, start) + text + this.characters.slice(start); },
  };
}
function request(operations: any[]) { return { taskId: 'task-a', documentSessionId: 'doc-a', operations }; }
function context(node: any, loadFont = async () => {}) { return { documentSessionId: 'doc-a', getNodeById: async () => node, loadFont }; }
const replace = (start: number, end: number, before: string, after: string): any => ({ op: 'replace_text', nodeId: '1:2', start, end, before, after });
async function main() {
  let node = textNode('abcdef');
  await applyFigmaNodePatch(context(node), request([replace(0, 1, 'a', 'AAAA'), replace(4, 6, 'ef', 'ZZ')]));
  assert.equal(node.characters, 'AAAAbcdZZ', 'batch ranges refer to the original node');
  await assert.rejects(applyFigmaNodePatch(context(node), request([
    replace(0, 4, 'AAAA', 'X'), replace(1, 3, 'AA', 'Y'),
  ])), /overlapping_text_ranges/);

  node = textNode('abc');
  const insert = node.insertCharacters;
  let failOnce = true;
  node.insertCharacters = function (...args: any[]) {
    if (failOnce) { failOnce = false; throw new Error('native insertion failed'); }
    insert.apply(this, args);
  };
  await assert.rejects(applyFigmaNodePatch(context(node), request([replace(0, 1, 'a', 'Z')])), /figma_patch_apply_failed/);
  assert.equal(node.characters, 'abc', 'the currently failing operation also rolls back its completed deletion');

  node = textNode('abc');
  await assert.rejects(applyFigmaNodePatch(context(node, async () => { node.characters = 'xyz'; }),
    request([replace(0, 3, 'abc', 'NEW')])), /base_changed/);
  assert.equal(node.characters, 'xyz', 'a user edit during font loading is preserved');
  console.log('figma_patch_transactions_test: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
