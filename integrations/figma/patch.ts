export interface FigmaFontName {
  family: string;
  style: string;
}

export interface FigmaNodeLike {
  id: string;
  type: string;
  name?: string;
  locked?: boolean;
  visible?: boolean;
  characters?: string;
  fontName?: FigmaFontName | symbol;
  fills?: unknown;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  parent?: { layoutMode?: string } | null;
  getStyledTextSegments?: (
    fields: Array<'fontName'>,
    start?: number,
    end?: number,
  ) => Array<{ start: number; end: number; fontName: FigmaFontName }>;
  deleteCharacters?: (start: number, end: number) => void;
  insertCharacters?: (start: number, characters: string, useStyle?: 'BEFORE' | 'AFTER') => void;
  resize?: (width: number, height: number) => void;
  [key: string]: unknown;
}

export interface FigmaPatchContext {
  documentSessionId: string;
  getNodeById(nodeId: string): Promise<FigmaNodeLike | null>;
  loadFont(font: FigmaFontName): Promise<void>;
}

export type FigmaPatchOperation =
  | {
    op: 'replace_text';
    nodeId: string;
    start: number;
    end: number;
    before: string;
    after: string;
  }
  | {
    op: 'set_fill';
    nodeId: string;
    before: unknown;
    after: { r: number; g: number; b: number; a?: number };
  }
  | {
    op: 'set_spacing';
    nodeId: string;
    property: 'itemSpacing' | 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft';
    before: number;
    after: number;
  }
  | {
    op: 'resize';
    nodeId: string;
    before: { width: number; height: number };
    after: { width: number; height: number };
  }
  | {
    op: 'move';
    nodeId: string;
    before: { x: number; y: number };
    after: { x: number; y: number };
  };

export interface FigmaPatchRequest {
  taskId: string;
  documentSessionId: string;
  operations: FigmaPatchOperation[];
}

export interface FigmaNodeReadback {
  id: string;
  type: string;
  name: string;
  characters?: string;
  fills?: unknown;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
}

interface PreparedChange {
  node: FigmaNodeLike;
  apply(): void;
  revert(): void;
  fonts: FigmaFontName[];
}

const SPACING_PROPERTIES = new Set([
  'itemSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
]);

function fail(reason: string, nodeId?: string): never {
  throw new Error(nodeId ? `${reason}:${nodeId}` : reason);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fontKey(font: FigmaFontName): string {
  return `${font.family}/${font.style}`;
}

function fontsForRange(node: FigmaNodeLike, start: number, end: number): FigmaFontName[] {
  if (node.getStyledTextSegments) {
    const segments = node.getStyledTextSegments(['fontName'], start, end);
    const fonts = segments
      .map((segment) => segment.fontName)
      .filter((font): font is FigmaFontName => Boolean(font?.family && font?.style));
    if (fonts.length) return fonts;
  }
  const font = node.fontName;
  if (font && typeof font === 'object' && 'family' in font && 'style' in font) {
    return [font as FigmaFontName];
  }
  return [];
}

function readback(node: FigmaNodeLike): FigmaNodeReadback {
  const value: FigmaNodeReadback = {
    id: node.id,
    type: node.type,
    name: String(node.name || ''),
  };
  const properties: Array<keyof FigmaNodeReadback> = [
    'characters',
    'fills',
    'x',
    'y',
    'width',
    'height',
    'layoutMode',
    'itemSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
  ];
  for (const property of properties) {
    const raw = node[property];
    if (raw !== undefined && typeof raw !== 'function' && typeof raw !== 'symbol') {
      (value as unknown as Record<string, unknown>)[property] = raw;
    }
  }
  return value;
}

function prepareText(
  node: FigmaNodeLike,
  operation: Extract<FigmaPatchOperation, { op: 'replace_text' }>,
): PreparedChange {
  if (node.type !== 'TEXT' || typeof node.characters !== 'string') {
    fail('node_is_not_text', node.id);
  }
  if (
    !Number.isInteger(operation.start)
    || !Number.isInteger(operation.end)
    || operation.start < 0
    || operation.end < operation.start
    || operation.end > node.characters.length
  ) {
    fail('text_range_invalid', node.id);
  }
  if (node.characters.slice(operation.start, operation.end) !== operation.before) {
    fail('base_changed', node.id);
  }
  if (!node.deleteCharacters || !node.insertCharacters) {
    fail('text_range_write_unsupported', node.id);
  }
  let fontStart = operation.start;
  let fontEnd = operation.end;
  if (fontStart === fontEnd && node.characters.length) {
    if (fontStart === node.characters.length) {
      fontStart -= 1;
    } else {
      fontEnd += 1;
    }
  }
  const fonts = fontsForRange(node, fontStart, fontEnd);
  if (!fonts.length && operation.after) fail('font_identity_unavailable', node.id);
  return {
    node,
    fonts,
    apply() {
      node.deleteCharacters?.(operation.start, operation.end);
      if (operation.after) node.insertCharacters?.(operation.start, operation.after, 'BEFORE');
    },
    revert() {
      node.deleteCharacters?.(operation.start, operation.start + operation.after.length);
      if (operation.before) node.insertCharacters?.(operation.start, operation.before, 'BEFORE');
    },
  };
}

function prepareFill(
  node: FigmaNodeLike,
  operation: Extract<FigmaPatchOperation, { op: 'set_fill' }>,
): PreparedChange {
  if (!('fills' in node) || typeof node.fills === 'symbol') fail('fill_write_unsupported', node.id);
  if (!same(node.fills, operation.before)) fail('base_changed', node.id);
  const { r, g, b, a = 1 } = operation.after;
  if (![r, g, b, a].every(finite) || [r, g, b, a].some((value) => value < 0 || value > 1)) {
    fail('fill_color_invalid', node.id);
  }
  const previous = node.fills;
  const replacement = [{ type: 'SOLID', color: { r, g, b }, opacity: a }];
  return {
    node,
    fonts: [],
    apply() { node.fills = replacement; },
    revert() { node.fills = previous; },
  };
}

function prepareSpacing(
  node: FigmaNodeLike,
  operation: Extract<FigmaPatchOperation, { op: 'set_spacing' }>,
): PreparedChange {
  if (!SPACING_PROPERTIES.has(operation.property) || node.layoutMode === undefined) {
    fail('spacing_write_unsupported', node.id);
  }
  if (!finite(operation.before) || node[operation.property] !== operation.before) {
    fail('base_changed', node.id);
  }
  if (!finite(operation.after) || operation.after < 0) fail('spacing_value_invalid', node.id);
  return {
    node,
    fonts: [],
    apply() { node[operation.property] = operation.after; },
    revert() { node[operation.property] = operation.before; },
  };
}

function prepareResize(
  node: FigmaNodeLike,
  operation: Extract<FigmaPatchOperation, { op: 'resize' }>,
): PreparedChange {
  if (!node.resize || !finite(node.width) || !finite(node.height)) {
    fail('resize_unsupported', node.id);
  }
  if (node.width !== operation.before.width || node.height !== operation.before.height) {
    fail('base_changed', node.id);
  }
  if (
    !finite(operation.after.width)
    || !finite(operation.after.height)
    || operation.after.width <= 0
    || operation.after.height <= 0
  ) {
    fail('resize_value_invalid', node.id);
  }
  return {
    node,
    fonts: [],
    apply() { node.resize?.(operation.after.width, operation.after.height); },
    revert() { node.resize?.(operation.before.width, operation.before.height); },
  };
}

function prepareMove(
  node: FigmaNodeLike,
  operation: Extract<FigmaPatchOperation, { op: 'move' }>,
): PreparedChange {
  if (!finite(node.x) || !finite(node.y)) fail('move_unsupported', node.id);
  if (node.parent?.layoutMode && node.parent.layoutMode !== 'NONE') {
    fail('move_controlled_by_auto_layout', node.id);
  }
  if (node.x !== operation.before.x || node.y !== operation.before.y) {
    fail('base_changed', node.id);
  }
  if (!finite(operation.after.x) || !finite(operation.after.y)) fail('move_value_invalid', node.id);
  return {
    node,
    fonts: [],
    apply() {
      node.x = operation.after.x;
      node.y = operation.after.y;
    },
    revert() {
      node.x = operation.before.x;
      node.y = operation.before.y;
    },
  };
}

async function prepare(
  context: FigmaPatchContext,
  operation: FigmaPatchOperation,
): Promise<PreparedChange> {
  const node = await context.getNodeById(operation.nodeId);
  if (!node) fail('node_not_found', operation.nodeId);
  if (node.locked) fail('node_locked', node.id);
  switch (operation.op) {
    case 'replace_text': return prepareText(node, operation);
    case 'set_fill': return prepareFill(node, operation);
    case 'set_spacing': return prepareSpacing(node, operation);
    case 'resize': return prepareResize(node, operation);
    case 'move': return prepareMove(node, operation);
    default: return fail('figma_patch_operation_not_allowed');
  }
}

export async function applyFigmaNodePatch(
  context: FigmaPatchContext,
  request: FigmaPatchRequest,
): Promise<{ appliedCount: number; nodes: FigmaNodeReadback[] }> {
  if (!request.taskId.trim()) fail('task_identity_required');
  if (request.documentSessionId !== context.documentSessionId) {
    fail('document_identity_mismatch');
  }
  if (!Array.isArray(request.operations) || !request.operations.length) {
    fail('figma_patch_operations_required');
  }

  const prepared: PreparedChange[] = [];
  for (const operation of request.operations) prepared.push(await prepare(context, operation));

  const uniqueFonts = new Map<string, { font: FigmaFontName; nodeId: string }>();
  for (const change of prepared) {
    for (const font of change.fonts) uniqueFonts.set(fontKey(font), { font, nodeId: change.node.id });
  }
  for (const { font, nodeId } of uniqueFonts.values()) {
    try {
      await context.loadFont(font);
    } catch {
      fail(`font_unavailable:${nodeId}:${fontKey(font)}`);
    }
  }

  const applied: PreparedChange[] = [];
  try {
    for (const change of prepared) {
      change.apply();
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      try { change.revert(); } catch { /* retain the original write error */ }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`figma_patch_apply_failed:${message}`);
  }

  const nodes = [...new Map(prepared.map((change) => [change.node.id, change.node])).values()];
  return { appliedCount: prepared.length, nodes: nodes.map(readback) };
}
