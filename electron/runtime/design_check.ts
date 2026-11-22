import {lstat, readdir, readFile} from 'node:fs/promises';
import {basename, extname, join} from 'node:path';
import {
  DESIGN_BLOB_ID_REGEX,
  DESIGN_BOARD_MAX_PX,
  DESIGN_BOARD_MIN_PX,
  DESIGN_CANVAS_VERSION,
  DESIGN_DS_FOLDER_REGEX,
  DESIGN_ID_REGEX,
  DESIGN_MAX_BOARD_BYTES,
  DESIGN_MAX_DESIGN_SYSTEMS,
  DESIGN_MAX_FILES,
  DESIGN_MAX_GUIDES,
  DESIGN_MAX_NOTES,
  DESIGN_MAX_PAGES,
  DESIGN_MAX_TOTAL_BYTES,
  DESIGN_SEGMENT_REGEX,
  type DesignCheckIssue,
  type DesignCheckReport,
  type DesignLintFinding,
} from './design_types';

const CANVAS_FILE = 'canvas.json';
const ASSETS_DIR = 'assets';
const DESIGN_SYSTEMS_DIR = 'ds';
const BOARD_SUFFIX = '.dc.html';
const SUPPORT_LINE = '<script src="./support.js"></script>';
const MAX_SCAN_ENTRIES = 20_000;
const TEXT_EXTENSIONS = new Set([
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.svg',
  '.md',
  '.txt',
]);

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const PROP_EDITORS = new Set([
  'text',
  'color',
  'int',
  'float',
  'range',
  'boolean',
  'enum',
]);
const GUIDE_KINDS = new Set(['columns', 'rows', 'grid']);
const NOTE_KINDS = new Set([
  'title1',
  'rect',
  'oval',
  'pen',
  'line',
  'arrow',
  'image',
  'link',
]);
const HOLE_REGEX =
  /^\s*(?:[A-Za-z_$][\w$]*(?:\.[\w$]+)*|true|false|null|-?\d+(?:\.\d+)?|"[^"{}]*"|'[^'{}]*')\s*$/;
const ATTRS_REGEX = String.raw`((?:[^>"']|"[^"]*"|'[^']*')*)`;
const TAG_REGEX = new RegExp(
  String.raw`<(\/?)([A-Za-z][A-Za-z0-9:-]*)` + ATTRS_REGEX + '>',
  'g',
);

const PURPLE_HEXES = [
  '#a855f7',
  '#9333ea',
  '#7c3aed',
  '#6d28d9',
  '#581c87',
  '#8b5cf6',
  '#a78bfa',
  '#c4b5fd',
  '#ddd6fe',
  '#ede9fe',
  '#6366f1',
  '#4f46e5',
  '#4338ca',
  '#3730a3',
  '#312e81',
  '#818cf8',
  '#a5b4fc',
  '#c7d2fe',
  '#e0e7ff',
  '#eef2ff',
];
const TRUST_BLUE_HEXES = [
  '#3b82f6',
  '#2563eb',
  '#1d4ed8',
  '#1e40af',
  '#1e3a8a',
  '#60a5fa',
  '#93c5fd',
  '#bfdbfe',
  '#0ea5e9',
  '#0284c7',
  '#0369a1',
  '#38bdf8',
  '#7dd3fc',
];
const TRUST_CYAN_HEXES = [
  '#06b6d4',
  '#0891b2',
  '#0e7490',
  '#155e75',
  '#164e63',
  '#22d3ee',
  '#67e8f9',
  '#a5f3fc',
];
const AI_DEFAULT_INDIGO = [
  '#6366f1',
  '#4f46e5',
  '#4338ca',
  '#3730a3',
  '#8b5cf6',
  '#7c3aed',
  '#a855f7',
];
const SLOP_EMOJI = [
  '✨',
  '🚀',
  '🎯',
  '⚡',
  '🔥',
  '💡',
  '📈',
  '🎨',
  '🛡️',
  '🌟',
  '💪',
  '🎉',
  '👋',
  '🙌',
  '✅',
  '⭐',
  '🏆',
];
const INVENTED_METRIC_PATTERNS = [
  /\b10[×x]\s+(?:faster|better|easier)\b/i,
  /\b100[×x]\s+(?:faster|better)\b/i,
  /\b99\.\d+%\s+uptime\b/i,
  /\bzero[- ]downtime\b/i,
  /\b3[×x]\s+more\s+(?:productive|efficient)\b/i,
];
const FILLER_PATTERNS = [
  /\bfeature\s+(?:one|two|three|1|2|3)\b/i,
  /\blorem\s+ipsum\b/i,
  /\bdolor\s+sit\s+amet\b/i,
  /\bplaceholder\s+text\b/i,
  /\bsample\s+content\b/i,
];

interface CanvasTree {
  files: Map<string, number>;
  assets: Set<string>;
  totalBytes: number;
  truncated: boolean;
}

interface BoardSize {
  w: number;
  h: number;
}

interface BoardContext {
  file: string;
  size: BoardSize | null;
  tree: CanvasTree;
  stems: ReadonlyMap<string, string>;
  issues: DesignCheckIssue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clip = (s: string, max = 120): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

const isRemote = (url: string): boolean =>
  /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url.trim()) &&
  !/^data:/i.test(url.trim());

const isGoogleFonts = (url: string): boolean =>
  /^(?:https?:)?\/\/fonts\.googleapis\.com\//i.test(url.trim());

const isBlobUrl = (url: string): boolean =>
  /^(?:\.{1,2}\/)*\/?_blob\//.test(url.trim());

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt);/gi,
    (whole, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      }
      if (lower.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      }
      const named: Record<string, string> = {
        amp: '&',
        apos: "'",
        quot: '"',
        lt: '<',
        gt: '>',
      };
      return named[lower] ?? whole;
    },
  );
}

function attr(
  attrs: string,
  name: string,
): {value: string; quote: "'" | '"' | ''} | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:'([^']*)'|"([^"]*)"|([^\\s>]+))`,
    'i',
  ).exec(attrs);
  if (!match) {
    return null;
  }
  if (match[1] !== undefined) {
    return {value: match[1], quote: "'"};
  }
  if (match[2] !== undefined) {
    return {value: match[2], quote: '"'};
  }
  return {value: match[3] ?? '', quote: ''};
}

function attrList(
  attrs: string,
): Array<{name: string; value: string | null; quoted: boolean}> {
  const list: Array<{name: string; value: string | null; quoted: boolean}> = [];
  for (const match of attrs.matchAll(
    /([^\s=/"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g,
  )) {
    const raw = match[2];
    if (raw === undefined) {
      list.push({name: match[1] ?? '', value: null, quoted: false});
    } else {
      const quoted = raw.startsWith('"') || raw.startsWith("'");
      list.push({
        name: match[1] ?? '',
        value: quoted ? raw.slice(1, -1) : raw,
        quoted,
      });
    }
  }
  return list;
}

function resolveRelative(file: string, ref: string): string | null {
  const clean = ref.split(/[?#]/)[0] ?? '';
  const parts = clean.startsWith('/') ? [] : file.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

async function scanAssets(dir: string, tree: CanvasTree): Promise<void> {
  const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) {
      continue;
    }
    const id = entry.name.split('.')[0] ?? '';
    if (DESIGN_BLOB_ID_REGEX.test(id)) {
      tree.assets.add(id);
    }
    const st = await lstat(join(dir, entry.name)).catch(() => null);
    tree.totalBytes += st?.size ?? 0;
  }
}

async function scanTree(
  dir: string,
  issues: DesignCheckIssue[],
): Promise<CanvasTree> {
  const tree: CanvasTree = {
    files: new Map(),
    assets: new Set(),
    totalBytes: 0,
    truncated: false,
  };
  let seen = 0;

  const visit = async (rel: string): Promise<void> => {
    const full = rel === '' ? dir : join(dir, ...rel.split('/'));
    const entries = await readdir(full, {withFileTypes: true}).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (++seen > MAX_SCAN_ENTRIES) {
        tree.truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) {
        continue;
      }
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (rel === '' && entry.name === ASSETS_DIR && entry.isDirectory()) {
        await scanAssets(join(dir, ASSETS_DIR), tree);
        continue;
      }
      if (entry.isSymbolicLink()) {
        issues.push({
          file: child,
          message: 'Symbolic links are not supported in a design canvas.',
        });
        continue;
      }
      if (!DESIGN_SEGMENT_REGEX.test(entry.name)) {
        issues.push({
          file: child,
          message: `"${entry.name}" is not a valid path segment (must match ${DESIGN_SEGMENT_REGEX.source}).`,
        });
        continue;
      }
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        const st = await lstat(join(full, entry.name)).catch(() => null);
        const size = st?.size ?? 0;
        tree.files.set(child, size);
        tree.totalBytes += size;
      }
    }
  };

  await visit('');
  return tree;
}

function checkBlobRefs(
  file: string,
  text: string,
  assets: ReadonlySet<string>,
  issues: DesignCheckIssue[],
): void {
  const reported = new Set<string>();
  for (const match of text.matchAll(/\/_blob\/([^\s"'()<>?#]*)/g)) {
    const id = match[1] ?? '';
    if (reported.has(id)) {
      continue;
    }
    reported.add(id);
    if (!DESIGN_BLOB_ID_REGEX.test(id)) {
      issues.push({
        file,
        message: `/_blob/${id} is not a valid asset reference (expected 32 lowercase hex digits).`,
      });
    } else if (!assets.has(id)) {
      issues.push({
        file,
        message: `/_blob/${id} is not in assets/: import the asset with Design.import_asset first.`,
      });
    }
  }
}

function checkCssImports(
  file: string,
  css: string,
  issues: DesignCheckIssue[],
): void {
  for (const match of css.matchAll(
    /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi,
  )) {
    const url = match[1] ?? '';
    if (isRemote(url) && !isGoogleFonts(url)) {
      issues.push({
        file,
        message: `@import ${url} loads a remote stylesheet; only Google Fonts is allowed.`,
      });
    }
  }
}

function checkAssetUrl(ctx: BoardContext, url: string, where: string): void {
  const value = url.trim();
  if (
    value === '' ||
    value.startsWith('#') ||
    /^\{\{[\s\S]*\}\}$/.test(value) ||
    isBlobUrl(value)
  ) {
    return;
  }
  const add = (message: string) => ctx.issues.push({file: ctx.file, message});
  if (/^data:/i.test(value)) {
    add(
      `${where} uses a data: URI; import the file with Design.import_asset and use /_blob/<id>.`,
    );
  } else if (/^blob:/i.test(value)) {
    add(
      `${where} uses a blob: URL; import the file with Design.import_asset.`,
    );
  } else if (isRemote(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!/^(?:https?:)?\/\/fonts\.gstatic\.com\//i.test(value)) {
      add(
        `${where} loads ${value} from the network; import with Design.import_asset and use /_blob/<id>.`,
      );
    }
  } else {
    add(
      `${where} references "${value}"; import with Design.import_asset and use /_blob/<id>.`,
    );
  }
}

function checkStyle(ctx: BoardContext, css: string): void {
  checkCssImports(ctx.file, css, ctx.issues);
  for (const match of css.matchAll(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
  )) {
    const url = match[1] ?? match[2] ?? match[3] ?? '';
    if (/^(?:https?:)?\/\/fonts\.googleapis\.com\//i.test(url.trim())) {
      continue;
    }
    checkAssetUrl(ctx, url, 'url(…)');
  }
}

function checkMarkup(ctx: BoardContext, markup: string): void {
  const add = (message: string) => ctx.issues.push({file: ctx.file, message});
  const text = markup.replace(/<!--[\s\S]*?-->/g, comment =>
    ' '.repeat(comment.length),
  );
  const stack: string[] = [];
  const once = new Set<string>();
  const addOnce = (key: string, message: string) => {
    if (once.has(key)) {
      return;
    }
    once.add(key);
    add(message);
  };

  let svgDepth = 0;
  TAG_REGEX.lastIndex = 0;
  for (let match = TAG_REGEX.exec(text); match; match = TAG_REGEX.exec(text)) {
    const closing = match[1] === '/';
    const name = match[2] ?? '';
    const lower = name.toLowerCase();
    const attrs = match[3] ?? '';

    if (closing) {
      const at = stack.lastIndexOf(lower);
      if (at < 0) {
        addOnce(`stray:${lower}`, `</${name}> has no matching <${name}>`);
        continue;
      }
      for (const unclosed of stack.splice(at).slice(1).reverse()) {
        addOnce(
          `open:${unclosed}`,
          `<${unclosed}> is not closed before </${name}>`,
        );
      }
      if (lower === 'svg') {
        svgDepth = Math.max(0, svgDepth - 1);
      }
      continue;
    }

    if (svgDepth === 0 && /[A-Z]/.test(name)) {
      addOnce(
        `case:${name}`,
        `<${name}>: tag names must be lowercase; mount another artboard with <dc-import name="${name}"></dc-import>`,
      );
    }

    const list = attrList(attrs.replace(/\/\s*$/, ''));
    for (const item of list) {
      if (item.value !== null && !item.quoted) {
        addOnce(
          `quote:${item.name}`,
          `Attribute ${item.name}=${item.value} must be quoted`,
        );
      }
      if (item.value !== null && /\{\{/.test(item.value)) {
        for (const hole of item.value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
          const inner = hole[1] ?? '';
          if (!HOLE_REGEX.test(inner)) {
            addOnce(
              `hole:${inner}`,
              `{{${inner}}} is an expression; holes must be dotted lookups or literals only`,
            );
          }
        }
      }
    }

    const style =
      list.find(item => item.name.toLowerCase() === 'style')?.value ?? '';
    if (/url\(/i.test(style)) {
      addOnce(
        'inline-url',
        'url(…) in inline style="…"; place it in <helmet><style> instead',
      );
    }
    if (lower === 'img' || (lower === 'source' && svgDepth === 0)) {
      const src = list.find(item => item.name.toLowerCase() === 'src')?.value;
      if (src !== undefined && src !== null) {
        checkAssetUrl(ctx, src, `<${lower} src>`);
      }
    }
    if (lower === 'dc-import') {
      const ref =
        list.find(item => item.name.toLowerCase() === 'name')?.value ??
        list.find(item => item.name.toLowerCase() === 'component')?.value;
      if (!ref) {
        add('<dc-import> requires name="<artboard stem>"');
      } else if (
        !/\{\{/.test(ref) &&
        !ctx.stems.has(ref) &&
        !ctx.tree.files.has(
          resolveRelative(ctx.file, `${ref}${BOARD_SUFFIX}`) ?? '',
        )
      ) {
        add(`<dc-import name="${ref}"> has no ${ref}${BOARD_SUFFIX} to mount`);
      }
    }
    if (lower === 'a') {
      const href = list.find(item => item.name.toLowerCase() === 'href')?.value;
      if (
        href &&
        !/\{\{/.test(href) &&
        !isRemote(href) &&
        !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
        (href.split(/[?#]/)[0] ?? '').endsWith(BOARD_SUFFIX)
      ) {
        const target = resolveRelative(ctx.file, href);
        if (target === null || !ctx.tree.files.has(target)) {
          add(`<a href="${href}"> targets an artboard that does not exist`);
        }
      }
    }

    const selfClosed = /\/\s*$/.test(attrs);
    if (RAW_TEXT.has(lower) && !selfClosed) {
      const end = new RegExp(`</${lower}\\s*>`, 'ig');
      end.lastIndex = TAG_REGEX.lastIndex;
      const found = end.exec(text);
      if (!found) {
        addOnce(`open:${lower}`, `<${lower}> is never closed`);
        return;
      }
      if (lower === 'style') {
        checkStyle(ctx, text.slice(TAG_REGEX.lastIndex, found.index));
      }
      TAG_REGEX.lastIndex = end.lastIndex;
      continue;
    }

    if (VOID_ELEMENTS.has(lower)) {
      continue;
    }
    if (selfClosed) {
      if (svgDepth === 0) {
        addOnce(
          `self:${lower}`,
          `<${name} /> is self-closed; write <${name}></${name}>`,
        );
      }
      continue;
    }
    stack.push(lower);
    if (lower === 'svg') {
      svgDepth += 1;
    }
  }

  for (const unclosed of stack.reverse()) {
    addOnce(`open:${unclosed}`, `<${unclosed}> is never closed`);
  }

  for (const hole of text
    .replace(/<[^>]*>/g, ' ')
    .matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const inner = hole[1] ?? '';
    if (!HOLE_REGEX.test(inner)) {
      addOnce(
        `hole:${inner}`,
        `{{${inner}}} is an expression; holes must be dotted lookups or literals only`,
      );
    }
  }
}

function checkScript(ctx: BoardContext, code: string, logic: boolean): void {
  const add = (message: string) => ctx.issues.push({file: ctx.file, message});
  if (logic) {
    if (!/\bclass\s+Component\s+extends\s+DCLogic\b/.test(code)) {
      add('data-dc-script block must define class Component extends DCLogic');
    }
    if (/^\s*(?:import|export)\b/m.test(code)) {
      add('data-dc-script block is classic JS: no import or export');
    }
  }
  if (
    /\.(?:inner|outer)HTML\s*=(?!=)|\binsertAdjacentHTML\s*\(|\.appendChild\s*\(|\bdocument\.write(?:ln)?\s*\(/.test(
      code,
    )
  ) {
    add(
      'Builds UI from script (innerHTML/appendChild/document.write); all UI must live in <x-dc>',
    );
  }
  if (/\bwindow\.[A-Za-z_$][\w$]*\s*=(?!=)/.test(code)) {
    add('Sets a window.X global; keep state in the component');
  }
  if (
    /\b(?:window|document|globalThis)\s*\.\s*(?:addEventListener\s*\(\s*['"`]key(?:down|up|press)['"`]|onkey(?:down|up|press)\s*=)/.test(
      code,
    )
  ) {
    add('Installs a global keyboard handler on window/document');
  }
  for (const match of code.matchAll(/\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (isRemote(match[1] ?? '')) {
      add(
        `fetch("${match[1]}") accesses the network; import data with Design.import_asset`,
      );
    }
  }
  if (/\bnew\s+(?:WebSocket|EventSource)\s*\(|\bXMLHttpRequest\b/.test(code)) {
    add('Opens a network connection; artboards must stay offline');
  }
}

function checkRelativeFile(
  ctx: BoardContext,
  ref: string,
  where: string,
): void {
  const target = resolveRelative(ctx.file, ref);
  if (target === null || target === '' || !ctx.tree.files.has(target)) {
    ctx.issues.push({
      file: ctx.file,
      message: `${where} "${ref}" is not a file in this design canvas.`,
    });
  }
}

function checkBoardFile(ctx: BoardContext, html: string): void {
  const {file, size} = ctx;
  const add = (message: string) => ctx.issues.push({file, message});

  const supportIdx = html.indexOf(SUPPORT_LINE);
  const headEnd = html.search(/<\/head\s*>/i);
  if (supportIdx < 0) {
    add(`<head> must contain the exact line ${SUPPORT_LINE}`);
  } else if (headEnd >= 0 && supportIdx > headEnd) {
    add(`${SUPPORT_LINE} must be inside <head>`);
  }

  const open = /<x-dc\s*>/i.exec(html);
  const close = /<\/x-dc\s*>/i.exec(html);
  if (!open || !close || close.index < open.index) {
    add('Markup must be wrapped in <x-dc>…</x-dc>');
  } else {
    checkMarkup(ctx, html.slice(open.index + open[0].length, close.index));
  }

  const scripts = [
    ...html.matchAll(
      new RegExp(
        String.raw`<script\b` + ATTRS_REGEX + String.raw`>([\s\S]*?)<\/script\s*>`,
        'gi',
      ),
    ),
  ];
  const blocks = scripts.filter(m =>
    attrList(m[1] ?? '').some(a => a.name.toLowerCase() === 'data-dc-script'),
  );
  if (blocks.length === 0) {
    add(
      'Missing <script type="text/x-dc" data-dc-script data-props=\'…\'> block',
    );
  } else if (blocks.length > 1) {
    add(`Has ${blocks.length} data-dc-script blocks; expected exactly one`);
  }

  const block = blocks[0];
  if (block) {
    const attrs = block[1] ?? '';
    if (attr(attrs, 'type')?.value.toLowerCase() !== 'text/x-dc') {
      add('data-dc-script block must have type="text/x-dc"');
    }
    const props = attr(attrs, 'data-props');
    if (props === null) {
      add(
        'data-dc-script block needs data-props=\'{"$preview":{"width":…,"height":…}}\'',
      );
    } else if (props.quote !== "'") {
      add("data-props must be single-quoted: data-props='{…}'");
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeEntities(props.value));
      } catch (error) {
        add(
          `data-props is not valid JSON (${(error as Error).message})`,
        );
      }
      if (parsed !== undefined) {
        const preview = isRecord(parsed) ? parsed.$preview : undefined;
        if (
          !isRecord(preview) ||
          !isFiniteNumber(preview.width) ||
          !isFiniteNumber(preview.height)
        ) {
          add(
            'data-props needs "$preview": {"width": <number>, "height": <number>}',
          );
        } else if (
          size &&
          (preview.width !== size.w || preview.height !== size.h)
        ) {
          add(
            `$preview is ${preview.width}×${preview.height} but canvas.json boards gives ${size.w}×${size.h}`,
          );
        }
        if (isRecord(parsed)) {
          for (const [key, spec] of Object.entries(parsed)) {
            if (key === '$preview' || !isRecord(spec) || !('editor' in spec)) {
              continue;
            }
            if (
              spec.editor !== null &&
              !(
                typeof spec.editor === 'string' &&
                PROP_EDITORS.has(spec.editor)
              )
            ) {
              add(
                `data-props "${key}": editor must be text, color, int, float, range, boolean, enum or null`,
              );
            }
          }
        }
      }
    }
    checkScript(ctx, block[2] ?? '', true);
  }

  for (const script of scripts) {
    if (script === block) {
      continue;
    }
    const list = attrList(script[1] ?? '');
    const src = list.find(a => a.name.toLowerCase() === 'src')?.value;
    if (typeof src === 'string') {
      if (src === './support.js') {
        continue;
      }
      if (isRemote(src)) {
        add(`<script src="${src}"> loads a remote script`);
      } else if (!isBlobUrl(src)) {
        checkRelativeFile(ctx, src, '<script src>');
      }
    } else {
      checkScript(ctx, script[2] ?? '', false);
    }
  }

  const embedded = new Set(
    [...html.matchAll(/<(iframe|object|embed)\b/gi)].map(m =>
      (m[1] ?? '').toLowerCase(),
    ),
  );
  for (const tag of embedded) {
    add(`<${tag}> is not allowed in an artboard`);
  }

  for (const match of html.matchAll(
    new RegExp(String.raw`<link\b` + ATTRS_REGEX + '>', 'gi'),
  )) {
    const list = attrList(match[1] ?? '');
    const rel =
      list.find(a => a.name.toLowerCase() === 'rel')?.value?.toLowerCase() ??
      '';
    const href = list.find(a => a.name.toLowerCase() === 'href')?.value;
    if (
      typeof href !== 'string' ||
      !rel
        .split(/\s+/)
        .some(
          r => r === 'stylesheet' || r === 'preload' || r === 'modulepreload',
        )
    ) {
      continue;
    }
    if (isRemote(href)) {
      if (!isGoogleFonts(href)) {
        add(
          `<link href="${href}"> loads from the network; only Google Fonts is allowed`,
        );
      }
    } else if (!isBlobUrl(href)) {
      checkRelativeFile(ctx, href, '<link href>');
    }
  }

  checkBlobRefs(file, html, ctx.tree.assets, ctx.issues);
}

function checkDesignSystems(
  value: unknown,
  tree: CanvasTree,
  add: (message: string) => void,
): void {
  const folders = new Set<string>();
  for (const file of tree.files.keys()) {
    const parts = file.split('/');
    if (parts[0] === DESIGN_SYSTEMS_DIR && parts.length > 2 && parts[1]) {
      folders.add(parts[1]);
    } else if (parts[0] === DESIGN_SYSTEMS_DIR && parts.length === 2) {
      add(
        `${file}: files under ${DESIGN_SYSTEMS_DIR}/ belong in ${DESIGN_SYSTEMS_DIR}/<folder>/`,
      );
    }
  }
  for (const folder of folders) {
    if (!DESIGN_DS_FOLDER_REGEX.test(folder)) {
      add(
        `${DESIGN_SYSTEMS_DIR}/${folder}/: folder must match ${DESIGN_DS_FOLDER_REGEX.source}`,
      );
    }
  }
  const recorded = new Set<string>();
  if (value !== undefined) {
    if (!Array.isArray(value)) {
      add('designSystems must be an array');
    } else {
      if (value.length > DESIGN_MAX_DESIGN_SYSTEMS) {
        add(
          `designSystems has ${value.length} entries; max is ${DESIGN_MAX_DESIGN_SYSTEMS}`,
        );
      }
      value.forEach((rec, i) => {
        if (
          !isRecord(rec) ||
          typeof rec.title !== 'string' ||
          typeof rec.namespace !== 'string' ||
          typeof rec.artifact !== 'string' ||
          !(rec.version === null || typeof rec.version === 'string') ||
          typeof rec.copiedAt !== 'string'
        ) {
          add(`designSystems[${i}] has invalid shape`);
          return;
        }
        if (recorded.has(rec.namespace)) {
          add(`designSystems[${i}] duplicates namespace "${rec.namespace}"`);
        }
        recorded.add(rec.namespace);
      });
    }
  }
  for (const folder of folders) {
    if (!recorded.has(folder)) {
      add(`${DESIGN_SYSTEMS_DIR}/${folder}/ has no record in designSystems`);
    }
  }
}

function checkIndex(
  canvas: Record<string, unknown> & {boards: Record<string, unknown>},
  tree: CanvasTree,
  issues: DesignCheckIssue[],
): Map<string, BoardSize | null> {
  const add = (message: string) => issues.push({file: CANVAS_FILE, message});
  if (canvas.title !== undefined && typeof canvas.title !== 'string') {
    add('title must be a string');
  }
  checkDesignSystems(canvas.designSystems, tree, add);

  const pageIds = new Set<string>();
  if (canvas.pages !== undefined) {
    if (!Array.isArray(canvas.pages)) {
      add('pages must be an array');
    } else {
      if (canvas.pages.length > DESIGN_MAX_PAGES) {
        add(`pages has ${canvas.pages.length} entries; max is ${DESIGN_MAX_PAGES}`);
      }
      canvas.pages.forEach((page, i) => {
        if (
          !isRecord(page) ||
          typeof page.id !== 'string' ||
          !DESIGN_ID_REGEX.test(page.id) ||
          typeof page.name !== 'string'
        ) {
          add(`pages[${i}] must have valid id and name`);
          return;
        }
        if (pageIds.has(page.id)) {
          add(`pages has duplicate id "${page.id}"`);
        }
        pageIds.add(page.id);
      });
    }
  }

  const boards = new Map<string, BoardSize | null>();
  for (const [key, value] of Object.entries(canvas.boards)) {
    const where = `boards["${key}"]`;
    if (
      !key.endsWith(BOARD_SUFFIX) ||
      key.split('/')[0] === DESIGN_SYSTEMS_DIR
    ) {
      add(`${where}: key must end with ${BOARD_SUFFIX} outside ds/`);
    } else if (!tree.files.has(key)) {
      add(`${where}: file ${key} does not exist`);
    }
    if (!isRecord(value)) {
      add(`${where} must be an object with x, y, w, h`);
      boards.set(key, null);
      continue;
    }
    if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
      add(`${where}: x and y must be numbers`);
    }
    const sizeOk = (n: unknown): n is number =>
      isFiniteNumber(n) && n >= DESIGN_BOARD_MIN_PX && n <= DESIGN_BOARD_MAX_PX;
    if (!sizeOk(value.w) || !sizeOk(value.h)) {
      add(
        `${where}: w and h must be between ${DESIGN_BOARD_MIN_PX} and ${DESIGN_BOARD_MAX_PX}`,
      );
    }
    boards.set(
      key,
      sizeOk(value.w) && sizeOk(value.h) ? {w: value.w, h: value.h} : null,
    );
    if (value.title !== undefined && typeof value.title !== 'string') {
      add(`${where}: title must be a string`);
    }
    if (
      value.page !== undefined &&
      (typeof value.page !== 'string' || !pageIds.has(value.page))
    ) {
      add(`${where}: page must reference an id in pages`);
    }
    if (value.expand !== undefined && value.expand !== 'fill') {
      add(`${where}: expand can only be "fill"`);
    }
    if (
      value.print !== undefined &&
      value.print !== 'flow' &&
      value.print !== 'fixed'
    ) {
      add(`${where}: print must be "fixed" or "flow"`);
    }
    if (
      value.paper !== undefined &&
      value.paper !== 'letter' &&
      value.paper !== 'a4'
    ) {
      add(`${where}: paper must be "letter" or "a4"`);
    }
    if (
      value.is_interactive !== undefined &&
      typeof value.is_interactive !== 'boolean'
    ) {
      add(`${where}: is_interactive must be boolean`);
    }
    if (value.frameless !== undefined && typeof value.frameless !== 'boolean') {
      add(`${where}: frameless must be boolean`);
    }
    if (
      value.radius !== undefined &&
      !(isFiniteNumber(value.radius) && value.radius >= 0)
    ) {
      add(`${where}: radius must be >= 0`);
    }
    if (value.guides !== undefined) {
      if (!Array.isArray(value.guides) || !value.guides.every(isRecord)) {
        add(`${where}: guides must be an array`);
      } else {
        if (value.guides.length > DESIGN_MAX_GUIDES) {
          add(`${where}: guides max is ${DESIGN_MAX_GUIDES}`);
        }
        value.guides.forEach((guide, i) => {
          if (!GUIDE_KINDS.has(String(guide.kind))) {
            add(`${where}: guides[${i}].kind must be columns, rows, or grid`);
          }
        });
      }
    }
  }

  if (!Array.isArray(canvas.order)) {
    add('order must be an array');
  } else {
    const listed = new Set<string>();
    canvas.order.forEach((item, i) => {
      if (typeof item !== 'string' || !boards.has(item)) {
        add(`order[${i}] is not a key of boards`);
        return;
      }
      if (listed.has(item)) {
        add(`order duplicates ${item}`);
      }
      listed.add(item);
    });
    for (const key of boards.keys()) {
      if (!listed.has(key)) {
        add(`${key} is in boards but missing from order`);
      }
    }
  }

  if (canvas.notes !== undefined) {
    if (!isRecord(canvas.notes)) {
      add('notes must be an object');
    } else {
      const entries = Object.entries(canvas.notes);
      if (entries.length > DESIGN_MAX_NOTES) {
        add(`notes has ${entries.length} entries; max is ${DESIGN_MAX_NOTES}`);
      }
      for (const [id, note] of entries) {
        if (!DESIGN_ID_REGEX.test(id)) {
          add(`notes["${id}"] id must match ${DESIGN_ID_REGEX.source}`);
        }
        if (
          !isRecord(note) ||
          !isFiniteNumber(note.x) ||
          !isFiniteNumber(note.y) ||
          typeof note.text !== 'string'
        ) {
          add(`notes["${id}"] needs numeric x/y and string text`);
          continue;
        }
        if (note.kind !== undefined && !NOTE_KINDS.has(String(note.kind))) {
          add(`notes["${id}"].kind is invalid`);
        }
        if (
          note.page !== undefined &&
          (typeof note.page !== 'string' || !pageIds.has(note.page))
        ) {
          add(`notes["${id}"].page must reference pages`);
        }
      }
    }
  }

  return boards;
}

function stripTokenBlocks(html: string): string {
  return html.replace(
    /(?:^|[\s,{])(?::root|html|\[data-theme\s*=\s*["'][^"']*["']\])\s*\{[^}]*\}/gi,
    ' ',
  );
}

function detectBlueCyanTrustGradient(html: string): string | null {
  for (const m of html.matchAll(/linear-gradient\(([^)]*)\)/gi)) {
    const inside = (m[1] ?? '').toLowerCase();
    const hasBlue =
      /\bblue\b/.test(inside) ||
      TRUST_BLUE_HEXES.some(h => inside.includes(h));
    const hasCyan =
      /\bcyan\b/.test(inside) ||
      TRUST_CYAN_HEXES.some(h => inside.includes(h));
    if (hasBlue && hasCyan) {
      return m[0];
    }
  }
  return null;
}

/**
 * Deterministic OpenDesign-inspired P0/P1/P2 anti-AI-slop craft linter.
 */
export function lintDesignMarkup(
  rawHtml: string,
  file = 'Main.dc.html',
): DesignLintFinding[] {
  const out: DesignLintFinding[] = [];
  if (!rawHtml) {
    return out;
  }
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '');

  // P0-1: purple gradient
  for (const hex of PURPLE_HEXES) {
    const m = new RegExp(
      `linear-gradient\\([^)]*${escapeRe(hex)}[^)]*\\)`,
      'i',
    ).exec(html);
    if (m) {
      out.push({
        file,
        severity: 'P0',
        id: 'purple-gradient',
        message: `Found a violet/purple gradient using ${hex}.`,
        fix: 'Replace with a flat token surface (var(--bg) or var(--surface)).',
        snippet: clip(m[0]),
      });
      break;
    }
  }
  if (!out.some(f => f.id === 'purple-gradient')) {
    const m = /linear-gradient\([^)]*\b(purple|violet)\b[^)]*\)/i.exec(html);
    if (m) {
      out.push({
        file,
        severity: 'P0',
        id: 'purple-gradient',
        message: `Found "${m[1]}" keyword in linear-gradient.`,
        fix: 'Replace with a flat design-token color.',
        snippet: clip(m[0]),
      });
    }
  }

  // P0-1b: blue->cyan trust gradient
  if (!out.some(f => f.id === 'purple-gradient')) {
    const tg = detectBlueCyanTrustGradient(html);
    if (tg) {
      out.push({
        file,
        severity: 'P0',
        id: 'trust-gradient',
        message: 'Found a blue->cyan two-stop trust gradient.',
        fix: 'Use a flat surface or single design token.',
        snippet: clip(tg),
      });
    }
  }

  // P0-1c: AI default indigo outside :root
  if (!out.some(f => f.id === 'purple-gradient')) {
    const stripped = stripTokenBlocks(html);
    for (const hex of AI_DEFAULT_INDIGO) {
      const m = new RegExp(escapeRe(hex), 'i').exec(stripped);
      if (m) {
        out.push({
          file,
          severity: 'P0',
          id: 'ai-default-indigo',
          message: `Found default AI indigo (${hex}) outside :root tokens.`,
          fix: 'Use var(--accent) from the active design system.',
          snippet: clip(m[0]),
        });
        break;
      }
    }
  }

  // P0-2: emoji icons in headings/buttons/lists/icon spans
  for (const emoji of SLOP_EMOJI) {
    if (!html.includes(emoji)) {
      continue;
    }
    const m = new RegExp(
      `<(?:h[1-6]|button|li|span\\s+class="[^"]*icon[^"]*")[^>]*>[^<]*${escapeRe(emoji)}`,
      'i',
    ).exec(html);
    if (m) {
      out.push({
        file,
        severity: 'P0',
        id: 'emoji-icon',
        message: `Emoji "${emoji}" used as a UI icon.`,
        fix: 'Use a monoline inline SVG icon with stroke="currentColor".',
        snippet: clip(m[0]),
      });
      break;
    }
  }

  // P0-3: left-accent rounded card
  const leftAccentMatch =
    /\.[a-z0-9_-]+\s*\{[^}]*border-left\s*:\s*\d+px\s+solid\s+[^;]+;[^}]*border-radius\s*:\s*[1-9]/i.exec(
      html,
    );
  if (leftAccentMatch) {
    out.push({
      file,
      severity: 'P0',
      id: 'left-accent-card',
      message: 'Rounded card with colored border-left stripe.',
      fix: 'Use uniform hairline borders around the card instead.',
      snippet: clip(leftAccentMatch[0]),
    });
  }

  // P0-4: invented metrics
  for (const re of INVENTED_METRIC_PATTERNS) {
    const m = re.exec(html);
    if (m) {
      out.push({
        file,
        severity: 'P0',
        id: 'invented-metric',
        message: `Suspected invented metric "${m[0]}".`,
        fix: 'Replace with real user-provided data or an explicit stub.',
        snippet: clip(m[0]),
      });
      break;
    }
  }

  // P0-5: filler / lorem ipsum
  for (const re of FILLER_PATTERNS) {
    const m = re.exec(html);
    if (m) {
      out.push({
        file,
        severity: 'P0',
        id: 'filler-copy',
        message: `Filler copy detected: "${m[0]}".`,
        fix: 'Replace with real brief-specific copy.',
        snippet: clip(m[0]),
      });
      break;
    }
  }

  // P1-0: ALL-CAPS without letter-spacing
  for (const styleBlock of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = (styleBlock[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const upperRe =
      /([^{}]*)\{([^{}]*text-transform\s*:\s*uppercase[^{}]*)\}/gi;
    const m = upperRe.exec(css);
    if (m) {
      const body = m[2] ?? '';
      if (!/letter-spacing\s*:/i.test(body)) {
        out.push({
          file,
          severity: 'P1',
          id: 'all-caps-no-tracking',
          message:
            'text-transform: uppercase used without letter-spacing (>= 0.06em).',
          fix: 'Add letter-spacing: 0.08em to uppercase rules.',
          snippet: clip(`${(m[1] ?? '').trim()} { ${body.trim()} }`),
        });
        break;
      }
    }
  }

  // P1-1: >12 raw hexes outside :root
  const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html);
  if (styleMatch) {
    const cssWithoutRoot = (styleMatch[1] ?? '').replace(
      /:root\s*\{[^}]*\}/g,
      '',
    );
    const hexes = cssWithoutRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    if (hexes.length > 12) {
      out.push({
        file,
        severity: 'P1',
        id: 'raw-hex',
        message: `${hexes.length} raw hex values found outside :root.`,
        fix: 'Consolidate palette colors into :root CSS variables.',
        snippet: hexes.slice(0, 6).join(' '),
      });
    }
  }

  // P1-2: var(--accent) overuse (>6 in body)
  const bodyOnly = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  const accentCount = (bodyOnly.match(/var\(--accent\)/g) ?? []).length;
  if (accentCount > 6) {
    out.push({
      file,
      severity: 'P1',
      id: 'accent-overuse',
      message: `var(--accent) used ${accentCount} times in markup (max 6).`,
      fix: 'Reserve var(--accent) for primary focal points only.',
    });
  }

  // P2: missing spatial comment anchor on <section>
  const sections = [...bodyOnly.matchAll(/<section\b([^>]*)>/gi)];
  if (
    sections.some(
      s =>
        !/data-(?:mp-id|od-id|screen-label)\s*=/i.test(s[1] ?? ''),
    )
  ) {
    out.push({
      file,
      severity: 'P2',
      id: 'missing-anchor',
      message: 'A <section> is missing data-mp-id for spatial comment anchoring.',
      fix: 'Add data-mp-id="..." to major <section> containers.',
    });
  }

  return out;
}

/**
 * Runs deterministic structural validation and anti-AI-slop craft linting
 * across an entire Design Canvas directory.
 */
export async function checkDesignCanvas(
  dir: string,
): Promise<DesignCheckReport> {
  const issues: DesignCheckIssue[] = [];
  const lintFindings: DesignLintFinding[] = [];
  const tree = await scanTree(dir, issues);

  if (tree.truncated || tree.files.size > DESIGN_MAX_FILES) {
    issues.push({
      file: '.',
      message: `Canvas exceeds maximum file limit of ${DESIGN_MAX_FILES}.`,
    });
  }
  if (tree.totalBytes > DESIGN_MAX_TOTAL_BYTES) {
    issues.push({
      file: '.',
      message: `Canvas exceeds maximum total size of ${DESIGN_MAX_TOTAL_BYTES} bytes.`,
    });
  }

  const indexFile = join(dir, CANVAS_FILE);
  const indexStat = await lstat(indexFile).catch(() => null);
  let raw: string | null = null;
  if (indexStat?.isFile()) {
    raw = await readFile(indexFile, 'utf8').catch(() => null);
  }

  let parsed: unknown;
  if (raw === null) {
    issues.push({
      file: CANVAS_FILE,
      message: 'Missing canvas.json with "v": 3 and "boards".',
    });
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      issues.push({
        file: CANVAS_FILE,
        message: `Invalid JSON: ${(error as Error).message}`,
      });
    }
  }

  const isValidCanvas =
    isRecord(parsed) &&
    parsed.v === DESIGN_CANVAS_VERSION &&
    isRecord(parsed.boards);
  if (raw !== null && parsed !== undefined && !isValidCanvas) {
    issues.push({
      file: CANVAS_FILE,
      message: 'canvas.json must be an object with "v": 3 and "boards".',
    });
  }

  const canvas = isValidCanvas
    ? (parsed as Record<string, unknown> & {boards: Record<string, unknown>})
    : null;
  const boards = canvas
    ? checkIndex(canvas, tree, issues)
    : new Map<string, BoardSize | null>();

  const stems = new Map<string, string>();
  for (const file of tree.files.keys()) {
    if (
      !file.endsWith(BOARD_SUFFIX) ||
      file.split('/')[0] === DESIGN_SYSTEMS_DIR
    ) {
      continue;
    }
    const stem = basename(file).slice(0, -BOARD_SUFFIX.length);
    const other = stems.get(stem);
    if (other !== undefined) {
      issues.push({
        file,
        message: `Duplicate artboard stem "${stem}" (conflicts with ${other}).`,
      });
    } else {
      stems.set(stem, file);
    }
  }

  for (const [file, bytes] of tree.files) {
    const ext = extname(file).toLowerCase();
    const isBoard =
      file.endsWith(BOARD_SUFFIX) && file.split('/')[0] !== DESIGN_SYSTEMS_DIR;
    if (file.split('/')[0] === DESIGN_SYSTEMS_DIR) {
      continue;
    }
    if (isBoard && canvas && !boards.has(file)) {
      issues.push({
        file,
        message: `Artboard ${file} is not registered in canvas.json boards/order.`,
      });
    }
    if (!isBoard && !TEXT_EXTENSIONS.has(ext)) {
      continue;
    }
    if (bytes > DESIGN_MAX_BOARD_BYTES) {
      if (isBoard) {
        issues.push({
          file,
          message: `Board exceeds ${DESIGN_MAX_BOARD_BYTES} bytes.`,
        });
      }
      continue;
    }
    const text = await readFile(join(dir, ...file.split('/')), 'utf8').catch(
      () => null,
    );
    if (text === null) {
      continue;
    }
    if (isBoard) {
      checkBoardFile(
        {file, size: boards.get(file) ?? null, tree, stems, issues},
        text,
      );
      lintFindings.push(...lintDesignMarkup(text, file));
    } else {
      checkBlobRefs(file, text, tree.assets, issues);
      if (ext === '.css') {
        checkCssImports(file, text, issues);
      }
    }
  }

  const p0Count = lintFindings.filter(f => f.severity === 'P0').length;
  const p1Count = lintFindings.filter(f => f.severity === 'P1').length;
  const p2Count = lintFindings.filter(f => f.severity === 'P2').length;
  const title =
    canvas && typeof canvas.title === 'string' && canvas.title.trim()
      ? canvas.title.trim()
      : basename(dir);

  return {
    ok: issues.length === 0 && p0Count === 0,
    title,
    boardCount: canvas ? Object.keys(canvas.boards).length : 0,
    issues,
    lintFindings,
    p0Count,
    p1Count,
    p2Count,
  };
}
