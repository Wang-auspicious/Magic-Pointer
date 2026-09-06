import {
  applyFigmaNodePatch,
  type FigmaNodeLike,
  type FigmaPatchOperation,
} from './patch';

interface BridgeCommand {
  commandId: string;
  taskId: string;
  documentSessionId: string;
  operation: string;
  arguments: Record<string, unknown>;
}

interface ConnectedIdentity {
  taskId: string;
  documentSessionId: string;
}

let connected: ConnectedIdentity | null = null;
const documentSessionId = [
  figma.fileKey || 'local',
  figma.currentPage.id,
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 10),
].join(':');

function cloneForWire(value: unknown): unknown {
  if (value === figma.mixed) return { mixed: true };
  if (Array.isArray(value)) return value.map(cloneForWire);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item !== 'function' && typeof item !== 'symbol') result[key] = cloneForWire(item);
    }
    return result;
  }
  return value;
}

function supports(node: BaseNode, property: string): boolean {
  return property in node;
}

function serializeNode(node: BaseNode): Record<string, unknown> {
  const record = node as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    name: node.name,
    parentId: node.parent?.id || null,
    locked: supports(node, 'locked') ? record.locked === true : false,
    visible: supports(node, 'visible') ? record.visible !== false : true,
    capabilities: {
      replaceText: node.type === 'TEXT',
      setFill: supports(node, 'fills') && record.fills !== figma.mixed,
      setSpacing: supports(node, 'layoutMode'),
      resize: supports(node, 'resize'),
      move: supports(node, 'x') && supports(node, 'y')
        && !(
          node.parent
          && 'layoutMode' in node.parent
          && node.parent.layoutMode !== 'NONE'
        ),
    },
  };
  if ('absoluteBoundingBox' in node) result.bounds = cloneForWire(node.absoluteBoundingBox);
  if ('characters' in node) result.characters = node.characters;
  if ('fontName' in node) result.fontName = cloneForWire(node.fontName);
  if ('fills' in node) result.fills = cloneForWire(node.fills);
  for (const property of [
    'x', 'y', 'width', 'height', 'layoutMode', 'primaryAxisSizingMode',
    'counterAxisSizingMode', 'itemSpacing', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft', 'componentProperties',
  ]) {
    if (property in record) result[property] = cloneForWire(record[property]);
  }
  if (node.type === 'INSTANCE') {
    result.mainComponentId = node.mainComponent?.id || null;
  }
  return result;
}

async function nodesById(rawIds: unknown): Promise<BaseNode[]> {
  if (!Array.isArray(rawIds)) throw new Error('node_ids_must_be_array');
  const ids = rawIds.map((value) => String(value || '').trim()).filter(Boolean);
  if (!ids.length || ids.length > 100) throw new Error('node_ids_count_invalid');
  const found: BaseNode[] = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new Error(`node_not_found:${id}`);
    found.push(node);
  }
  return found;
}

async function readSelection(): Promise<Record<string, unknown>> {
  const selected = [...figma.currentPage.selection];
  const related = new Map<string, BaseNode>();
  for (const node of selected) {
    related.set(node.id, node);
    const parent = node.parent;
    if (parent && parent.type !== 'DOCUMENT') {
      related.set(parent.id, parent);
      if ('children' in parent) {
        for (const sibling of parent.children.slice(0, 20)) related.set(sibling.id, sibling);
      }
    }
  }
  return {
    selectionIds: selected.map((node) => node.id),
    nodes: [...related.values()].map(serializeNode),
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    scope: 'selection-parent-and-bounded-siblings',
  };
}

async function execute(command: BridgeCommand): Promise<unknown> {
  if (!connected) throw new Error('figma_plugin_not_connected');
  if (
    command.taskId !== connected.taskId
    || command.documentSessionId !== connected.documentSessionId
    || command.documentSessionId !== documentSessionId
  ) {
    throw new Error('figma_command_identity_mismatch');
  }
  switch (command.operation) {
    case 'read_selection':
      return readSelection();
    case 'read_nodes':
    case 'readback': {
      const nodes = await nodesById(command.arguments.nodeIds);
      return { nodes: nodes.map(serializeNode) };
    }
    case 'read_parent': {
      const [node] = await nodesById([command.arguments.nodeId]);
      const parent = node.parent;
      const siblings = parent && 'children' in parent
        ? parent.children.slice(0, 50).map(serializeNode)
        : [];
      return {
        node: serializeNode(node),
        parent: parent && parent.type !== 'DOCUMENT' ? serializeNode(parent) : null,
        siblings,
      };
    }
    case 'export_preview': {
      const [node] = await nodesById([command.arguments.nodeId]);
      if (!('exportAsync' in node)) throw new Error(`node_export_unsupported:${node.id}`);
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
      return { nodeId: node.id, mimeType: 'image/png', base64: figma.base64Encode(bytes) };
    }
    case 'apply_patch': {
      const operations = command.arguments.operations;
      if (!Array.isArray(operations)) throw new Error('figma_patch_operations_required');
      return applyFigmaNodePatch(
        {
          documentSessionId,
          async getNodeById(nodeId) {
            return await figma.getNodeByIdAsync(nodeId) as unknown as FigmaNodeLike | null;
          },
          async loadFont(font) { await figma.loadFontAsync(font); },
        },
        {
          taskId: command.taskId,
          documentSessionId: command.documentSessionId,
          operations: operations as FigmaPatchOperation[],
        },
      );
    }
    default:
      throw new Error(`figma_operation_not_allowed:${command.operation}`);
  }
}

function sendSelectionEvent(): void {
  if (!connected) return;
  figma.ui.postMessage({
    type: 'selection-event',
    taskId: connected.taskId,
    documentSessionId,
    selectionIds: figma.currentPage.selection.map((node) => node.id),
    pageId: figma.currentPage.id,
  });
}

figma.showUI(__html__, { width: 360, height: 420, themeColors: true });
figma.ui.postMessage({
  type: 'plugin-ready',
  documentSessionId,
  documentName: figma.root.name || figma.currentPage.name,
  pageId: figma.currentPage.id,
  pageName: figma.currentPage.name,
});

figma.on('selectionchange', sendSelectionEvent);
figma.on('currentpagechange', () => {
  if (!connected) return;
  figma.ui.postMessage({
    type: 'document-event',
    taskId: connected.taskId,
    documentSessionId,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
  });
  sendSelectionEvent();
});

figma.ui.onmessage = async (message: Record<string, unknown>) => {
  if (message.type === 'bridge-connected') {
    const taskId = String(message.taskId || '').trim();
    const incomingDocument = String(message.documentSessionId || '').trim();
    if (!taskId || incomingDocument !== documentSessionId) {
      figma.ui.postMessage({ type: 'plugin-error', error: 'figma_connection_identity_mismatch' });
      return;
    }
    connected = { taskId, documentSessionId };
    sendSelectionEvent();
    return;
  }
  if (message.type === 'bridge-disconnected') {
    connected = null;
    return;
  }
  if (message.type !== 'bridge-command') return;
  const command = message.command as BridgeCommand;
  try {
    const result = await execute(command);
    figma.ui.postMessage({
      type: 'command-result',
      commandId: command.commandId,
      taskId: command.taskId,
      documentSessionId: command.documentSessionId,
      ok: true,
      result,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: 'command-result',
      commandId: command?.commandId || '',
      taskId: command?.taskId || '',
      documentSessionId: command?.documentSessionId || documentSessionId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
