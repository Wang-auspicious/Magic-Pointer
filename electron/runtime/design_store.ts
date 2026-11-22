import {createHash} from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import {extname, join, resolve, sep} from 'node:path';
import AdmZip from 'adm-zip';
import {PDFDocument, StandardFonts, rgb} from 'pdf-lib';
import {
  DESIGN_BOARD_MAX_PX,
  DESIGN_BOARD_MIN_PX,
  DESIGN_CANVAS_VERSION,
  DESIGN_MAX_ASSET_BYTES,
  DESIGN_PAPER_DIMENSIONS,
  DESIGN_SEGMENT_REGEX,
  type DesignAssetImportResult,
  type DesignBoardEntry,
  type DesignCanvasJson,
  type DesignCanvasSnapshot,
  type DesignHandoffManifest,
  type DesignLaunchConfig,
  type DesignPageEntry,
  type DesignPaperFormat,
  type DesignWorkspaceSummary,
} from './design_types';

const ASSET_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const CANVAS_FILE = 'canvas.json';
const ASSETS_DIR = 'assets';
const DESIGNS_DIR = 'designs';

export class DesignConflictError extends Error {
  constructor(
    public readonly expectedContentHash: string,
    public readonly actualContentHash: string,
  ) {
    super(
      `Canvas revision conflict: expected ${expectedContentHash.slice(0, 12)}, got ${actualContentHash.slice(0, 12)}`,
    );
    this.name = 'DesignConflictError';
  }
}

export function validateDesignSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed || !DESIGN_SEGMENT_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid design canvas slug "${slug}": must match ${DESIGN_SEGMENT_REGEX.source}`,
    );
  }
  return trimmed;
}

export function validateDesignRelativePath(relPath: string): string {
  const normalized = relPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) {
    throw new Error(`Invalid relative design path "${relPath}"`);
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!DESIGN_SEGMENT_REGEX.test(segment)) {
      throw new Error(
        `Invalid path segment "${segment}" in "${relPath}": must match ${DESIGN_SEGMENT_REGEX.source}`,
      );
    }
  }
  return segments.join('/');
}

function resolveInside(baseDir: string, relPath: string): string {
  const root = resolve(baseDir);
  const target = resolve(root, ...relPath.split('/'));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Path "${relPath}" escapes canvas directory`);
  }
  return target;
}

function validateBoardEntry(board: DesignBoardEntry, file: string): void {
  if (!Number.isFinite(board.x) || !Number.isFinite(board.y)) {
    throw new Error(`Board "${file}" x and y must be finite numbers`);
  }
  if (
    !Number.isFinite(board.w) ||
    !Number.isFinite(board.h) ||
    board.w < DESIGN_BOARD_MIN_PX ||
    board.w > DESIGN_BOARD_MAX_PX ||
    board.h < DESIGN_BOARD_MIN_PX ||
    board.h > DESIGN_BOARD_MAX_PX
  ) {
    throw new Error(
      `Board "${file}" w and h must be between ${DESIGN_BOARD_MIN_PX} and ${DESIGN_BOARD_MAX_PX}`,
    );
  }
}

function computeCanvasContentHash(
  canvasRaw: string,
  boardsContent: Record<string, string>,
): string {
  const hash = createHash('sha256');
  hash.update(canvasRaw);
  const keys = Object.keys(boardsContent).sort();
  for (const key of keys) {
    hash.update('\0');
    hash.update(key);
    hash.update('\0');
    hash.update(boardsContent[key] ?? '');
  }
  return hash.digest('hex');
}

async function collectFilesRecursive(
  baseDir: string,
  relPrefix = '',
): Promise<string[]> {
  const fullDir = relPrefix ? join(baseDir, ...relPrefix.split('/')) : baseDir;
  const entries = await readdir(fullDir, {withFileTypes: true}).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...(await collectFilesRecursive(baseDir, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

export class DesignStore {
  private readonly designsRoot: string;

  constructor(rootDir: string) {
    this.designsRoot = resolve(rootDir, DESIGNS_DIR);
  }

  getCanvasDir(slug: string): string {
    const safeSlug = validateDesignSlug(slug);
    return resolveInside(this.designsRoot, safeSlug);
  }

  async initCanvas(options: {
    slug: string;
    title: string;
    launch?: DesignLaunchConfig;
    pages?: DesignPageEntry[];
    overwrite?: boolean;
  }): Promise<DesignCanvasSnapshot> {
    const safeSlug = validateDesignSlug(options.slug);
    const dir = this.getCanvasDir(safeSlug);
    const indexPath = join(dir, CANVAS_FILE);

    if (!options.overwrite) {
      const existing = await lstat(indexPath).catch(() => null);
      if (existing) {
        return this.readCanvas(safeSlug);
      }
    }

    await mkdir(join(dir, ASSETS_DIR), {recursive: true});

    const canvas: DesignCanvasJson = {
      v: DESIGN_CANVAS_VERSION,
      createdOnFiles: {v: 1, at: new Date().toISOString()},
      title: options.title.trim() || safeSlug,
      launch: options.launch ?? {view: 'canvas'},
      pages: options.pages,
      boards: {},
      order: [],
    };
    const raw = JSON.stringify(canvas, null, 2);
    await writeFile(indexPath, raw, 'utf8');

    return {
      slug: safeSlug,
      dir,
      canvas,
      boardsContent: {},
      contentHash: computeCanvasContentHash(raw, {}),
      revision: 1,
    };
  }

  async readCanvas(slug: string): Promise<DesignCanvasSnapshot> {
    const safeSlug = validateDesignSlug(slug);
    const dir = this.getCanvasDir(safeSlug);
    const indexPath = join(dir, CANVAS_FILE);
    const raw = await readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as DesignCanvasJson;
    if (!parsed || parsed.v !== DESIGN_CANVAS_VERSION || !parsed.boards) {
      throw new Error(`Invalid canvas.json in "${safeSlug}"`);
    }

    const boardsContent: Record<string, string> = {};
    for (const boardPath of Object.keys(parsed.boards)) {
      const safeRel = validateDesignRelativePath(boardPath);
      const fullPath = resolveInside(dir, safeRel);
      const text = await readFile(fullPath, 'utf8').catch(() => '');
      boardsContent[safeRel] = text;
    }

    const contentHash = computeCanvasContentHash(raw, boardsContent);
    const revision = Math.max(1, (parsed.order?.length ?? 0) + 1);
    return {
      slug: safeSlug,
      dir,
      canvas: parsed,
      boardsContent,
      contentHash,
      revision,
    };
  }

  async writeCanvasJson(
    slug: string,
    canvas: DesignCanvasJson,
    expectedContentHash?: string,
  ): Promise<DesignCanvasSnapshot> {
    const current = await this.readCanvas(slug);
    if (
      expectedContentHash !== undefined &&
      expectedContentHash !== current.contentHash
    ) {
      throw new DesignConflictError(expectedContentHash, current.contentHash);
    }
    const raw = JSON.stringify(canvas, null, 2);
    await writeFile(join(current.dir, CANVAS_FILE), raw, 'utf8');
    return this.readCanvas(slug);
  }

  async listCanvases(): Promise<DesignWorkspaceSummary[]> {
    const entries = await readdir(this.designsRoot, {
      withFileTypes: true,
    }).catch(() => []);
    const summaries: DesignWorkspaceSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !DESIGN_SEGMENT_REGEX.test(entry.name)) {
        continue;
      }
      const indexPath = join(this.designsRoot, entry.name, CANVAS_FILE);
      const st = await stat(indexPath).catch(() => null);
      if (!st || !st.isFile()) {
        continue;
      }
      try {
        const snap = await this.readCanvas(entry.name);
        summaries.push({
          slug: snap.slug,
          title: snap.canvas.title,
          dir: snap.dir,
          boardCount: Object.keys(snap.canvas.boards).length,
          pageCount: snap.canvas.pages?.length ?? 0,
          designSystemCount: snap.canvas.designSystems?.length ?? 0,
          contentHash: snap.contentHash,
          updatedAt: st.mtime.toISOString(),
        });
      } catch {
        // Ignore malformed workspace directories in listing.
      }
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  async upsertBoard(options: {
    slug: string;
    file: string;
    html: string;
    board: DesignBoardEntry;
    expectedContentHash?: string;
  }): Promise<DesignCanvasSnapshot> {
    const current = await this.readCanvas(options.slug);
    if (
      options.expectedContentHash !== undefined &&
      options.expectedContentHash !== current.contentHash
    ) {
      throw new DesignConflictError(
        options.expectedContentHash,
        current.contentHash,
      );
    }

    const relFile = validateDesignRelativePath(options.file);
    if (!relFile.endsWith('.dc.html') && !relFile.endsWith('.html')) {
      throw new Error(`Board file "${relFile}" must end with .dc.html or .html`);
    }
    validateBoardEntry(options.board, relFile);

    const targetPath = resolveInside(current.dir, relFile);
    await mkdir(resolve(targetPath, '..'), {recursive: true});
    await writeFile(targetPath, options.html, 'utf8');

    const nextBoards = {
      ...current.canvas.boards,
      [relFile]: options.board,
    };
    const nextOrder = current.canvas.order.includes(relFile)
      ? [...current.canvas.order]
      : [...current.canvas.order, relFile];

    const nextCanvas: DesignCanvasJson = {
      ...current.canvas,
      boards: nextBoards,
      order: nextOrder,
    };
    await writeFile(
      join(current.dir, CANVAS_FILE),
      JSON.stringify(nextCanvas, null, 2),
      'utf8',
    );
    return this.readCanvas(options.slug);
  }

  async importAsset(options: {
    slug: string;
    sourcePath?: string;
    bytes?: Buffer | Uint8Array;
    filename?: string;
  }): Promise<DesignAssetImportResult> {
    const snap = await this.readCanvas(options.slug);
    let data: Buffer;
    let nameForExt: string;

    if (options.bytes !== undefined) {
      data = Buffer.from(options.bytes);
      nameForExt = options.filename ?? '';
    } else if (options.sourcePath) {
      data = await readFile(options.sourcePath);
      nameForExt = options.filename ?? options.sourcePath;
    } else {
      throw new Error('importAsset requires either sourcePath or bytes');
    }

    const ext = extname(nameForExt).toLowerCase();
    const mimeType = ASSET_MIME_BY_EXT[ext];
    if (!mimeType) {
      throw new Error(
        `Unsupported asset extension "${ext || '(none)'}": allowed PNG, JPG, GIF, WEBP, AVIF, SVG, WOFF2, WOFF, TTF, OTF`,
      );
    }
    if (data.byteLength > DESIGN_MAX_ASSET_BYTES) {
      throw new Error(
        `Asset exceeds 20 MB limit (${data.byteLength} bytes > ${DESIGN_MAX_ASSET_BYTES})`,
      );
    }

    const id = createHash('sha256').update(data).digest('hex').slice(0, 32);
    const relativePath = `${ASSETS_DIR}/${id}${ext}`;
    const destPath = resolveInside(snap.dir, relativePath);
    await mkdir(join(snap.dir, ASSETS_DIR), {recursive: true});
    await writeFile(destPath, data);

    return {
      id,
      blobUrl: `/_blob/${id}`,
      relativePath,
      bytes: data.byteLength,
      mimeType,
    };
  }

  private async loadAssetDataUris(
    canvasDir: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const assetsPath = join(canvasDir, ASSETS_DIR);
    const entries = await readdir(assetsPath, {withFileTypes: true}).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      const mime = ASSET_MIME_BY_EXT[ext];
      if (!mime) {
        continue;
      }
      const id = entry.name.slice(0, -ext.length);
      const raw = await readFile(join(assetsPath, entry.name)).catch(() => null);
      if (raw) {
        map.set(id, `data:${mime};base64,${raw.toString('base64')}`);
      }
    }
    return map;
  }

  async exportStandaloneHtml(
    slug: string,
    options?: {boardFile?: string},
  ): Promise<{html: string; bytes: number; boardCount: number}> {
    const snap = await this.readCanvas(slug);
    const assets = await this.loadAssetDataUris(snap.dir);

    const targetBoards = options?.boardFile
      ? [options.boardFile]
      : snap.canvas.order.filter(
          file => snap.canvas.boards[file]?.frameless !== true,
        );

    const replaceBlobs = (input: string): string =>
      input.replace(/\/_blob\/([0-9a-f]{32})/g, (whole, id: string) => {
        return assets.get(id) ?? whole;
      });

    const boardSections: string[] = [];
    for (const file of targetBoards) {
      const board = snap.canvas.boards[file];
      const rawHtml = snap.boardsContent[file] ?? '';
      if (!board || !rawHtml) {
        continue;
      }
      const inlined = replaceBlobs(rawHtml);
      const styleMatches = [...inlined.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
        .map(m => m[1] ?? '')
        .join('\n');
      const xdcMatch = /<x-dc[^>]*>([\s\S]*?)<\/x-dc>/i.exec(inlined);
      const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(inlined);
      const content = xdcMatch?.[1] ?? bodyMatch?.[1] ?? inlined;
      boardSections.push(
        [
          `<section class="mp-export-board" data-board="${file}" style="width:${board.w}px;min-height:${board.h}px;margin:0 auto 48px;background:#fff;border:1px solid #e5e7eb;overflow:hidden;">`,
          styleMatches ? `<style>${styleMatches}</style>` : '',
          content,
          '</section>',
        ].join('\n'),
      );
    }

    const html = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8">',
      `  <title>${snap.canvas.title}</title>`,
      '  <style>body{margin:0;padding:32px;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}</style>',
      '</head>',
      '<body>',
      ...boardSections,
      '</body>',
      '</html>',
    ].join('\n');

    return {
      html,
      bytes: Buffer.byteLength(html, 'utf8'),
      boardCount: boardSections.length,
    };
  }

  async exportHandoffZip(
    slug: string,
    options?: {outputPath?: string},
  ): Promise<{
    buffer: Buffer;
    manifest: DesignHandoffManifest;
    handoffMarkdown: string;
  }> {
    const snap = await this.readCanvas(slug);
    const files = await collectFilesRecursive(snap.dir);
    const assets = files.filter(f => f.startsWith(`${ASSETS_DIR}/`));

    const manifest: DesignHandoffManifest = {
      v: 1,
      slug: snap.slug,
      title: snap.canvas.title,
      exportedAt: new Date().toISOString(),
      screens: snap.canvas.order
        .map(file => {
          const entry = snap.canvas.boards[file];
          if (!entry) {
            return null;
          }
          const role: DesignHandoffManifest['screens'][number]['role'] =
            entry.is_interactive
              ? 'interactive'
              : entry.print === 'flow'
                ? 'flow-document'
                : 'artboard';
          return {
            file,
            title: entry.title ?? file,
            width: entry.w,
            height: entry.h,
            role,
            page: entry.page,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null),
      designSystems: snap.canvas.designSystems ?? [],
      assets,
    };

    const handoffMarkdown = [
      `# Design Handoff: ${snap.canvas.title}`,
      '',
      `- **Slug**: \`${snap.slug}\``,
      `- **Exported At**: ${manifest.exportedAt}`,
      `- **Screens (${manifest.screens.length})**:`,
      ...manifest.screens.map(
        s => `  - \`${s.file}\` (${s.width}×${s.height}, ${s.role})`,
      ),
      '',
      '## Design Systems',
      ...(manifest.designSystems.length > 0
        ? manifest.designSystems.map(
            ds => `- **${ds.title}** (\`ds/${ds.namespace}/\`)`,
          )
        : ['- None installed']),
      '',
      '## Assets',
      ...(assets.length > 0 ? assets.map(a => `- \`${a}\``) : ['- None']),
      '',
    ].join('\n');

    const zip = new AdmZip();
    for (const rel of files) {
      const fullPath = resolveInside(snap.dir, rel);
      const data = await readFile(fullPath);
      zip.addFile(rel, data);
    }
    zip.addFile(
      'DESIGN-MANIFEST.json',
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    );
    zip.addFile('DESIGN-HANDOFF.md', Buffer.from(handoffMarkdown, 'utf8'));

    const buffer = zip.toBuffer();
    if (options?.outputPath) {
      await writeFile(options.outputPath, buffer);
    }
    return {buffer, manifest, handoffMarkdown};
  }

  async exportPdf(
    slug: string,
    options?: {
      paper?: DesignPaperFormat;
      boards?: string[];
      outputPath?: string;
    },
  ): Promise<{bytes: Uint8Array; pageCount: number; paper: DesignPaperFormat}> {
    const snap = await this.readCanvas(slug);
    const defaultPaper: DesignPaperFormat = options?.paper ?? 'letter';
    const selectedSet = options?.boards ? new Set(options.boards) : null;

    const targetFiles = snap.canvas.order.filter(file => {
      if (selectedSet && !selectedSet.has(file)) {
        return false;
      }
      const board = snap.canvas.boards[file];
      return Boolean(board && board.frameless !== true);
    });

    const pdf = await PDFDocument.create();
    pdf.setTitle(snap.canvas.title);
    pdf.setCreator('Magic Pointer Design Studio');
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

    const pxToPt = (px: number): number => (px * 72) / 96;

    for (const file of targetFiles) {
      const board = snap.canvas.boards[file];
      if (!board) {
        continue;
      }
      const paperKey = board.paper ?? defaultPaper;
      const paperPx = DESIGN_PAPER_DIMENSIONS[paperKey];
      const pageWidthPt =
        board.print === 'flow' ? pxToPt(paperPx.width) : pxToPt(board.w);
      const pageHeightPt =
        board.print === 'flow' ? pxToPt(paperPx.height) : pxToPt(board.h);
      const pagesNeeded =
        board.print === 'flow'
          ? Math.max(1, Math.ceil(board.h / paperPx.height))
          : 1;

      const rawHtml = snap.boardsContent[file] ?? '';
      const plainSummary = rawHtml
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);

      for (let pageIdx = 0; pageIdx < pagesNeeded; pageIdx++) {
        const page = pdf.addPage([pageWidthPt, pageHeightPt]);
        const titleText = board.title ? `${board.title} (${file})` : file;
        page.drawText(titleText, {
          x: 36,
          y: pageHeightPt - 48,
          size: 14,
          font: boldFont,
          color: rgb(0.1, 0.1, 0.1),
        });
        page.drawText(
          `Artboard ${board.w}x${board.h}px | Page ${pageIdx + 1}/${pagesNeeded}`,
          {
            x: 36,
            y: pageHeightPt - 68,
            size: 10,
            font,
            color: rgb(0.4, 0.4, 0.4),
          },
        );
        if (plainSummary) {
          page.drawText(plainSummary, {
            x: 36,
            y: pageHeightPt - 96,
            size: 10,
            font,
            color: rgb(0.2, 0.2, 0.2),
            maxWidth: Math.max(120, pageWidthPt - 72),
          });
        }
      }
    }

    if (pdf.getPageCount() === 0) {
      const paperPx = DESIGN_PAPER_DIMENSIONS[defaultPaper];
      pdf.addPage([pxToPt(paperPx.width), pxToPt(paperPx.height)]);
    }

    const bytes = await pdf.save();
    if (options?.outputPath) {
      await writeFile(options.outputPath, bytes);
    }
    return {
      bytes,
      pageCount: pdf.getPageCount(),
      paper: defaultPaper,
    };
  }
}
