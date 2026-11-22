import {
  compileBrandSystem,
  installBrandSystemToCanvas,
} from './design_brand_engine';
import {checkDesignCanvas} from './design_check';
import {DesignStore} from './design_store';
import type {
  DesignBoardEntry,
  DesignExportFormat,
  DesignLaunchConfig,
  DesignPageEntry,
  DesignPaperFormat,
  SeedToken,
} from './design_types';
import type {ToolSpec} from './tools';

export interface CreateDesignToolsOptions {
  rootDir: string;
  store?: DesignStore;
}

/**
 * Creates the Design.* ToolSpec suite for MPAgentRuntime.
 */
export function createDesignTools(
  options: CreateDesignToolsOptions,
): ToolSpec[] {
  const store = options.store ?? new DesignStore(options.rootDir);

  const initCanvas: ToolSpec = {
    name: 'Design.init_canvas',
    description:
      'Initialize a local Design Canvas workspace under designs/<slug>/ with canvas.json v3.',
    effect: 'reversible_write',
    used_backend: 'design-store',
    input_schema: {
      type: 'object',
      properties: {
        slug: {type: 'string', description: 'URL-safe canvas directory slug.'},
        title: {type: 'string', description: 'Human-readable canvas title.'},
        pages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {type: 'string'},
              name: {type: 'string'},
            },
            required: ['id', 'name'],
          },
        },
        launch: {type: 'object'},
        overwrite: {type: 'boolean'},
      },
      required: ['slug', 'title'],
    },
    async execute(args) {
      const snapshot = await store.initCanvas({
        slug: String(args.slug),
        title: String(args.title),
        pages: args.pages as DesignPageEntry[] | undefined,
        launch: args.launch as DesignLaunchConfig | undefined,
        overwrite: Boolean(args.overwrite),
      });
      return {
        slug: snapshot.slug,
        dir: snapshot.dir,
        contentHash: snapshot.contentHash,
        canvas: snapshot.canvas,
      };
    },
  };

  const upsertBoard: ToolSpec = {
    name: 'Design.upsert_board',
    description:
      'Create or update a .dc.html/.html artboard and register it in canvas.json.',
    effect: 'reversible_write',
    used_backend: 'design-store',
    input_schema: {
      type: 'object',
      properties: {
        slug: {type: 'string'},
        file: {type: 'string', description: 'Artboard path, e.g. Main.dc.html.'},
        html: {type: 'string', description: 'Full HTML/.dc.html content.'},
        board: {
          type: 'object',
          properties: {
            x: {type: 'number'},
            y: {type: 'number'},
            w: {type: 'number'},
            h: {type: 'number'},
            title: {type: 'string'},
            page: {type: 'string'},
            expand: {type: 'string', enum: ['fill']},
            print: {type: 'string', enum: ['fixed', 'flow']},
            paper: {type: 'string', enum: ['letter', 'a4']},
            is_interactive: {type: 'boolean'},
            frameless: {type: 'boolean'},
            radius: {type: 'number'},
          },
          required: ['x', 'y', 'w', 'h'],
        },
        expectedContentHash: {type: 'string'},
      },
      required: ['slug', 'file', 'html', 'board'],
    },
    async execute(args) {
      const snapshot = await store.upsertBoard({
        slug: String(args.slug),
        file: String(args.file),
        html: String(args.html),
        board: args.board as DesignBoardEntry,
        expectedContentHash:
          typeof args.expectedContentHash === 'string'
            ? args.expectedContentHash
            : undefined,
      });
      return {
        slug: snapshot.slug,
        file: String(args.file),
        contentHash: snapshot.contentHash,
        order: snapshot.canvas.order,
      };
    },
  };

  const readCanvas: ToolSpec = {
    name: 'Design.read_canvas',
    description: 'Read canvas.json, board contents, and current contentHash.',
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'design-store',
    input_schema: {
      type: 'object',
      properties: {
        slug: {type: 'string'},
      },
      required: ['slug'],
    },
    async execute(args) {
      const snapshot = await store.readCanvas(String(args.slug));
      return {
        slug: snapshot.slug,
        dir: snapshot.dir,
        contentHash: snapshot.contentHash,
        revision: snapshot.revision,
        canvas: snapshot.canvas,
        boardsContent: snapshot.boardsContent,
      };
    },
  };

  const listCanvases: ToolSpec = {
    name: 'Design.list_canvases',
    description: 'List all local Design Canvas workspaces.',
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'design-store',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute() {
      const canvases = await store.listCanvases();
      return {canvases};
    },
  };

  const importAsset: ToolSpec = {
    name: 'Design.import_asset',
    description:
      'Import an image or font file (<= 20 MB) into assets/ by SHA-256 content hash and return /_blob/<id>.',
    effect: 'reversible_write',
    used_backend: 'design-store',
    input_schema: {
      type: 'object',
      properties: {
        slug: {type: 'string'},
        sourcePath: {type: 'string'},
        filename: {type: 'string'},
      },
      required: ['slug', 'sourcePath'],
    },
    async execute(args) {
      return store.importAsset({
        slug: String(args.slug),
        sourcePath: String(args.sourcePath),
        filename:
          typeof args.filename === 'string' ? args.filename : undefined,
      });
    },
  };

  const checkCanvasTool: ToolSpec = {
    name: 'Design.check',
    description:
      'Run deterministic canvas.json v3, .dc.html syntax, /_blob/ asset, and anti-AI-slop craft checks.',
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'design-check',
    input_schema: {
      type: 'object',
      properties: {
        slug: {type: 'string'},
      },
      required: ['slug'],
    },
    async execute(args) {
      const dir = store.getCanvasDir(String(args.slug));
      return checkDesignCanvas(dir);
    },
  };

  const generateBrandSystem: ToolSpec = {
    name: 'Design.generate_brand_system',
    description:
      'Deterministically compile a ~20-field SeedToken into 10-step color scales, tokens.css, tokens.json, DESIGN.md, and design-system.json.',
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'design-brand-engine',
    input_schema: {
      type: 'object',
      properties: {
        name: {type: 'string'},
        namespace: {type: 'string'},
        colorPrimary: {type: 'string'},
        colorBgBase: {type: 'string'},
        colorTextBase: {type: 'string'},
        fontDisplay: {type: 'string'},
        fontBody: {type: 'string'},
        borderRadius: {type: 'number'},
        density: {type: 'string', enum: ['default', 'compact']},
        motion: {type: 'boolean'},
      },
      required: [],
    },
    execute(args) {
      return compileBrandSystem(
        args as Partial<SeedToken> & {name?: string; namespace?: string},
      );
    },
  };

  const installDesignSystem: ToolSpec = {
    name: 'Design.install_design_system',
    description:
      'Compile and install a Brand Design System into <canvas>/ds/<namespace>/ and register it in canvas.json.',
    effect: 'reversible_write',
    used_backend: 'design-brand-engine',
    input_schema: {
      type: 'object',
      properties: {
        slug: {type: 'string'},
        name: {type: 'string'},
        namespace: {type: 'string'},
        colorPrimary: {type: 'string'},
        colorBgBase: {type: 'string'},
        colorTextBase: {type: 'string'},
        fontDisplay: {type: 'string'},
        fontBody: {type: 'string'},
        borderRadius: {type: 'number'},
        density: {type: 'string', enum: ['default', 'compact']},
        motion: {type: 'boolean'},
      },
      required: ['slug'],
    },
    async execute(args) {
      const slug = String(args.slug);
      const snap = await store.readCanvas(slug);
      const compiled = compileBrandSystem(
        args as Partial<SeedToken> & {name?: string; namespace?: string},
      );
      const nextCanvas = await installBrandSystemToCanvas(
        snap.dir,
        compiled,
        snap.canvas,
      );
      const updated = await store.writeCanvasJson(
        slug,
        nextCanvas,
        snap.contentHash,
      );
      return {
        installed: true,
        slug: updated.slug,
        namespace: compiled.namespace,
        contentHash: updated.contentHash,
        designSystems: updated.canvas.designSystems ?? [],
      };
    },
  };

  const exportDesign: ToolSpec = {
    name: 'Design.export',
    description:
      'Export a Design Canvas as self-contained HTML, Engineering Handoff ZIP, or normalized multi-page PDF.',
    effect_for: args =>
      typeof args.outputPath === 'string' && args.outputPath.length > 0
        ? 'reversible_write'
        : 'read',
    used_backend: 'design-store',
    input_schema: {
      type: 'object',
      properties: {
        slug: {type: 'string'},
        format: {type: 'string', enum: ['html', 'zip', 'pdf']},
        paper: {type: 'string', enum: ['letter', 'a4']},
        boardFile: {type: 'string'},
        outputPath: {type: 'string'},
      },
      required: ['slug', 'format'],
    },
    async execute(args) {
      const slug = String(args.slug);
      const format = String(args.format) as DesignExportFormat;
      const outputPath =
        typeof args.outputPath === 'string' ? args.outputPath : undefined;

      if (format === 'html') {
        const res = await store.exportStandaloneHtml(slug, {
          boardFile:
            typeof args.boardFile === 'string' ? args.boardFile : undefined,
        });
        return {
          format,
          bytes: res.bytes,
          boardCount: res.boardCount,
          html: res.html,
        };
      }
      if (format === 'zip') {
        const res = await store.exportHandoffZip(slug, {outputPath});
        return {
          format,
          bytes: res.buffer.byteLength,
          manifest: res.manifest,
          outputPath: outputPath ?? null,
        };
      }
      if (format === 'pdf') {
        const res = await store.exportPdf(slug, {
          paper: (args.paper as DesignPaperFormat | undefined) ?? 'letter',
          outputPath,
        });
        return {
          format,
          bytes: res.bytes.byteLength,
          pageCount: res.pageCount,
          paper: res.paper,
          outputPath: outputPath ?? null,
        };
      }
      throw new Error(`Unsupported export format "${format}"`);
    },
  };

  return [
    initCanvas,
    upsertBoard,
    readCanvas,
    listCanvases,
    importAsset,
    checkCanvasTool,
    generateBrandSystem,
    installDesignSystem,
    exportDesign,
  ];
}
