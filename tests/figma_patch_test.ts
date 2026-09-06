import assert from 'node:assert/strict';

import {
  applyFigmaNodePatch,
  type FigmaNodeLike,
  type FigmaPatchContext,
} from '../integrations/figma/patch';

type FakeNode = FigmaNodeLike & Record<string, any>;

function context(
  nodes: Map<string, FakeNode>,
  options: { documentSessionId?: string; missingFont?: string } = {},
): FigmaPatchContext {
  return {
    documentSessionId: options.documentSessionId || 'document-a',
    async getNodeById(nodeId: string) {
      return nodes.get(nodeId) || null;
    },
    async loadFont(font) {
      if (`${font.family}/${font.style}` === options.missingFont) {
        throw new Error('font unavailable');
      }
    },
  };
}

async function main() {
  const changed: string[] = [];
  const interRegular = { family: 'Inter', style: 'Regular' };
  const textNode: FakeNode = {
    id: '1:2',
    type: 'TEXT',
    name: 'Button label',
    locked: false,
    characters: 'Old label',
    fontName: interRegular,
    getStyledTextSegments() {
      return [{ start: 0, end: 9, fontName: interRegular }];
    },
    deleteCharacters(start: number, end: number) {
      changed.push('delete');
      const characters = String(this.characters || '');
      this.characters = characters.slice(0, start) + characters.slice(end);
    },
    insertCharacters(start: number, value: string) {
      changed.push('insert');
      const characters = String(this.characters || '');
      this.characters = characters.slice(0, start) + value + characters.slice(start);
    },
  };
  const nodes = new Map<string, FakeNode>([['1:2', textNode]]);

  await assert.rejects(
    applyFigmaNodePatch(context(nodes), {
      taskId: 'task-1',
      documentSessionId: 'document-b',
      operations: [{
        op: 'replace_text',
        nodeId: '1:2',
        start: 0,
        end: 3,
        before: 'Old',
        after: 'New',
      }],
    }),
    /document_identity_mismatch/,
  );
  assert.equal(textNode.characters, 'Old label');

  await assert.rejects(
    applyFigmaNodePatch(context(nodes), {
      taskId: 'task-1',
      documentSessionId: 'document-a',
      operations: [{
        op: 'replace_text',
        nodeId: 'deleted:1',
        start: 0,
        end: 3,
        before: 'Old',
        after: 'New',
      }],
    }),
    /node_not_found:deleted:1/,
  );
  assert.equal(textNode.characters, 'Old label');

  await assert.rejects(
    applyFigmaNodePatch(context(nodes), {
      taskId: 'task-1',
      documentSessionId: 'document-a',
      operations: [{
        op: 'replace_text',
        nodeId: '1:2',
        start: 0,
        end: 3,
        before: 'Outdated',
        after: 'New',
      }],
    }),
    /base_changed:1:2/,
  );
  assert.equal(textNode.characters, 'Old label');

  await assert.rejects(
    applyFigmaNodePatch(context(nodes, { missingFont: 'Inter/Regular' }), {
      taskId: 'task-1',
      documentSessionId: 'document-a',
      operations: [{
        op: 'replace_text',
        nodeId: '1:2',
        start: 0,
        end: 3,
        before: 'Old',
        after: 'New',
      }],
    }),
    /font_unavailable:1:2:Inter\/Regular/,
  );
  assert.equal(textNode.characters, 'Old label');
  assert.equal(changed.length, 0);

  const frame: FakeNode = {
    id: '2:3',
    type: 'FRAME',
    name: 'Auto layout card',
    locked: false,
    layoutMode: 'VERTICAL',
    width: 320,
    height: 180,
    resize(width: number, height: number) {
      changed.push('resize');
      this.width = width;
      this.height = height;
    },
  };
  nodes.set(frame.id, frame);
  const resized = await applyFigmaNodePatch(context(nodes), {
    taskId: 'task-1',
    documentSessionId: 'document-a',
    operations: [{
      op: 'resize',
      nodeId: '2:3',
      before: { width: 320, height: 180 },
      after: { width: 360, height: 200 },
    }],
  });
  assert.equal(resized.appliedCount, 1);
  assert.deepEqual({ width: frame.width, height: frame.height }, { width: 360, height: 200 });
  assert.deepEqual(resized.nodes.map((node) => node.id), ['2:3']);

  const edited = await applyFigmaNodePatch(context(nodes), {
    taskId: 'task-1',
    documentSessionId: 'document-a',
    operations: [{
      op: 'replace_text',
      nodeId: '1:2',
      start: 0,
      end: 3,
      before: 'Old',
      after: 'New',
    }],
  });
  assert.equal(textNode.characters, 'New label');
  assert.equal(edited.nodes[0].characters, 'New label');

  const requestedRanges: Array<[number | undefined, number | undefined]> = [];
  const appendNode: FakeNode = {
    id: '3:4',
    type: 'TEXT',
    characters: 'A',
    getStyledTextSegments(_fields, start, end) {
      requestedRanges.push([start, end]);
      return [{ start: 0, end: 1, fontName: interRegular }];
    },
    deleteCharacters(start: number, end: number) {
      this.characters = String(this.characters).slice(0, start) + String(this.characters).slice(end);
    },
    insertCharacters(start: number, value: string) {
      this.characters = String(this.characters).slice(0, start) + value + String(this.characters).slice(start);
    },
  };
  nodes.set(appendNode.id, appendNode);
  await applyFigmaNodePatch(context(nodes), {
    taskId: 'task-1',
    documentSessionId: 'document-a',
    operations: [{
      op: 'replace_text',
      nodeId: appendNode.id,
      start: 1,
      end: 1,
      before: '',
      after: 'B',
    }],
  });
  assert.equal(appendNode.characters, 'AB');
  assert.deepEqual(requestedRanges, [[0, 1]], 'append inherits the last character font');

  console.log('figma patch test ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
