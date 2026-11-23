import {readFile, mkdir, writeFile, access} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {ToolRegistry} from './tools';

export interface PdfFigureBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropPdfFigureArgs {
  path: string;
  page?: number;
  bbox?: PdfFigureBbox;
  figureLabel?: string;
  caption?: string;
  scale?: number;
}

export interface CropPdfFigureResult {
  ok: true;
  imagePath: string;
  fileUrl: string;
  markdown: string;
  page: number;
  width: number;
  height: number;
  caption: string;
  usedBackend: 'pdfjs+napi-canvas+sharp';
}

function clamp01(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, num));
}

function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || 'figure';
}

function resolveStandardFontDataUrl(): string | undefined {
  try {
    const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const fontsDir = path.join(pkgDir, 'standard_fonts');
    if (existsSync(fontsDir)) {
      const url = pathToFileURL(fontsDir).href;
      return url.endsWith('/') ? url : `${url}/`;
    }
  } catch {
    // Ignore when standard_fonts is omitted in slim builds.
  }
  return undefined;
}

async function detectFigureBboxFromLabel(
  pdfPage: {
    getTextContent: () => Promise<{items: Array<Record<string, unknown>>}>;
  },
  viewport: {width: number; height: number; transform: number[]},
  pdfjsUtil: {
    transform: (m1: number[], m2: number[]) => number[];
  },
  label: string,
): Promise<PdfFigureBbox | null> {
  const target = label.trim().toLowerCase();
  if (!target || viewport.width <= 0 || viewport.height <= 0) {
    return null;
  }
  const content = await pdfPage.getTextContent();
  for (const item of content.items || []) {
    const str = String(item?.str || '').trim();
    if (!str || !str.toLowerCase().includes(target)) {
      continue;
    }
    const rawTransform = Array.isArray(item.transform)
      ? (item.transform as number[])
      : null;
    if (!rawTransform || rawTransform.length < 6) {
      continue;
    }
    const mapped = pdfjsUtil.transform(viewport.transform, rawTransform);
    const captionY = clamp01((mapped[5] ?? 0) / viewport.height, 0.6);
    const top = Math.max(0.03, captionY - 0.44);
    const bottom = Math.min(0.97, captionY + 0.05);
    return {
      x: 0.04,
      y: top,
      width: 0.92,
      height: Math.max(0.18, bottom - top),
    };
  }
  return null;
}

/**
 * Render one page of a local PDF file and optionally crop a figure region to a
 * persistent PNG under `dataDir/runtime/pdf-figures` for inline Markdown display.
 */
export async function cropPdfFigure(
  args: CropPdfFigureArgs,
  options: {dataDir: string},
): Promise<CropPdfFigureResult> {
  const pdfPath = path.resolve(String(args.path || '').trim());
  if (!pdfPath) {
    throw new Error('path is required');
  }
  await access(pdfPath);
  const pageNum = Math.max(1, Math.floor(Number(args.page || 1)));
  const scale = Math.max(
    1,
    Math.min(3, Number.isFinite(Number(args.scale)) ? Number(args.scale) : 2),
  );

  const bytes = await readFile(pdfPath);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = resolveStandardFontDataUrl();
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    disableFontFace: true,
    ...(standardFontDataUrl ? {standardFontDataUrl} : {}),
  });
  const pdfDoc = await loading.promise;
  try {
    if (pageNum > pdfDoc.numPages) {
      throw new Error(
        `Requested page ${pageNum} exceeds PDF page count (${pdfDoc.numPages})`,
      );
    }
    const pdfPage = await pdfDoc.getPage(pageNum);
    const viewport = pdfPage.getViewport({scale});
    const canvasMod = require('@napi-rs/canvas') as {
      createCanvas: (w: number, h: number) => {
        getContext: (kind: '2d') => unknown;
        toBuffer: (mime: 'image/png') => Buffer;
      };
    };
    const canvasWidth = Math.max(1, Math.ceil(viewport.width));
    const canvasHeight = Math.max(1, Math.ceil(viewport.height));
    const canvas = canvasMod.createCanvas(canvasWidth, canvasHeight);
    const canvasContext = canvas.getContext('2d');
    await pdfPage.render({
      canvasContext: canvasContext as never,
      canvas: canvas as never,
      viewport,
    }).promise;

    const fullPng = canvas.toBuffer('image/png');
    let cropBox: PdfFigureBbox | null = null;
    if (
      args.bbox &&
      Number(args.bbox.width) > 0.01 &&
      Number(args.bbox.height) > 0.01
    ) {
      const x = clamp01(args.bbox.x, 0);
      const y = clamp01(args.bbox.y, 0);
      cropBox = {
        x,
        y,
        width: Math.max(0.02, Math.min(1 - x, clamp01(args.bbox.width, 1))),
        height: Math.max(0.02, Math.min(1 - y, clamp01(args.bbox.height, 1))),
      };
    } else if (args.figureLabel?.trim()) {
      cropBox = await detectFigureBboxFromLabel(
        pdfPage as unknown as {
          getTextContent: () => Promise<{items: Array<Record<string, unknown>>}>;
        },
        viewport,
        pdfjs.Util,
        args.figureLabel,
      );
    }

    let outputPng: Buffer = fullPng;
    if (cropBox) {
      const left = Math.max(
        0,
        Math.min(canvasWidth - 2, Math.floor(cropBox.x * canvasWidth)),
      );
      const top = Math.max(
        0,
        Math.min(canvasHeight - 2, Math.floor(cropBox.y * canvasHeight)),
      );
      const extractWidth = Math.max(
        2,
        Math.min(canvasWidth - left, Math.round(cropBox.width * canvasWidth)),
      );
      const extractHeight = Math.max(
        2,
        Math.min(
          canvasHeight - top,
          Math.round(cropBox.height * canvasHeight),
        ),
      );
      outputPng = await sharp(fullPng)
        .extract({left, top, width: extractWidth, height: extractHeight})
        .png()
        .toBuffer();
    }

    const meta = await sharp(outputPng).metadata();
    const outDir = path.join(options.dataDir, 'runtime', 'pdf-figures');
    await mkdir(outDir, {recursive: true});
    const baseName = sanitizeSlug(path.basename(pdfPath, path.extname(pdfPath)));
    const cropTag = cropBox
      ? `${Math.round(cropBox.x * 1000)}_${Math.round(cropBox.y * 1000)}_${Math.round(cropBox.width * 1000)}x${Math.round(cropBox.height * 1000)}`
      : 'full';
    const imagePath = path.join(outDir, `${baseName}-p${pageNum}-${cropTag}.png`);
    await writeFile(imagePath, outputPng);

    const fileUrl = pathToFileURL(imagePath).href;
    const label =
      String(args.caption || args.figureLabel || '').trim() ||
      `${path.basename(pdfPath)} · p.${pageNum}`;
    const sourceLabel = `${path.basename(pdfPath)} p.${pageNum}`;
    return {
      ok: true,
      imagePath,
      fileUrl,
      markdown: `![${label} | ${sourceLabel}](${fileUrl})`,
      page: pageNum,
      width: meta.width || canvasWidth,
      height: meta.height || canvasHeight,
      caption: label,
      usedBackend: 'pdfjs+napi-canvas+sharp',
    };
  } finally {
    const closable = pdfDoc as unknown as {
      destroy?: () => Promise<void> | void;
      cleanup?: () => Promise<void> | void;
    };
    if (typeof closable.destroy === 'function') {
      await closable.destroy();
    } else if (typeof closable.cleanup === 'function') {
      await closable.cleanup();
    }
    if (typeof (loading as {destroy?: () => Promise<void>}).destroy === 'function') {
      await (loading as {destroy: () => Promise<void>}).destroy();
    }
  }
}

/** Register PDF figure rendering and cropping tools into the runtime registry. */
export function registerPdfFigureTools(
  registry: ToolRegistry,
  options: {dataDir: string},
): void {
  registry.register({
    name: 'Document.crop_pdf_figure',
    description:
      'Render a page from a local PDF file (papers, slides, textbooks) and crop a specific figure or region to a persistent PNG so you can embed it directly inside the chat reply as ![caption | source](fileUrl) or inside :::gallery.',
    deferred: true,
    is_concurrency_safe: true,
    timeout_ms: 45000,
    used_backend: 'pdfjs+napi-canvas+sharp',
    input_schema: {
      type: 'object',
      properties: {
        path: {type: 'string', description: 'Absolute path to the local .pdf file.'},
        page: {type: 'integer', description: '1-based page number to render.'},
        bbox: {
          type: 'object',
          description:
            'Normalized 0..1 bounding box {x, y, width, height} measured from top-left.',
          properties: {
            x: {type: 'number'},
            y: {type: 'number'},
            width: {type: 'number'},
            height: {type: 'number'},
          },
        },
        figureLabel: {
          type: 'string',
          description:
            'Optional caption prefix like "Figure 2" or "Fig. 1" to locate and crop automatically when bbox is omitted.',
        },
        caption: {
          type: 'string',
          description: 'Optional display caption for the cropped figure.',
        },
        scale: {
          type: 'number',
          description: 'Render scale factor between 1.0 and 3.0 (default 2.0).',
        },
      },
      required: ['path', 'page'],
    },
    execute: async rawArgs =>
      cropPdfFigure(
        {
          path: String(rawArgs.path || ''),
          page: Number(rawArgs.page || 1),
          ...(rawArgs.bbox && typeof rawArgs.bbox === 'object'
            ? {bbox: rawArgs.bbox as PdfFigureBbox}
            : {}),
          ...(rawArgs.figureLabel
            ? {figureLabel: String(rawArgs.figureLabel)}
            : {}),
          ...(rawArgs.caption ? {caption: String(rawArgs.caption)} : {}),
          ...(rawArgs.scale !== undefined ? {scale: Number(rawArgs.scale)} : {}),
        },
        options,
      ),
  });
  registry.alias('crop_pdf_figure', 'Document.crop_pdf_figure');
  registry.alias('Pdf.crop_figure', 'Document.crop_pdf_figure');
}
