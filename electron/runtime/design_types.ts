export const DESIGN_CANVAS_VERSION = 3;
export const DESIGN_MAX_PAGES = 40;
export const DESIGN_MAX_NOTES = 200;
export const DESIGN_MAX_GUIDES = 6;
export const DESIGN_MAX_DESIGN_SYSTEMS = 4;
export const DESIGN_BOARD_MIN_PX = 40;
export const DESIGN_BOARD_MAX_PX = 8000;
export const DESIGN_MAX_FILES = 512;
export const DESIGN_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const DESIGN_MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const DESIGN_MAX_BOARD_BYTES = 8 * 1024 * 1024;

export const DESIGN_SEGMENT_REGEX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
export const DESIGN_ID_REGEX = /^[A-Za-z0-9_-]{1,40}$/;
export const DESIGN_BLOB_ID_REGEX = /^[0-9a-f]{32}$/;
export const DESIGN_DS_FOLDER_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const DESIGN_PAPER_DIMENSIONS = {
  letter: {width: 816, height: 1056},
  a4: {width: 794, height: 1123},
} as const;

export type DesignPaperFormat = keyof typeof DESIGN_PAPER_DIMENSIONS;
export type DesignPrintMode = 'fixed' | 'flow';
export type DesignGuideKind = 'columns' | 'rows' | 'grid';

export interface DesignGuide {
  kind: DesignGuideKind;
  count?: number | 'auto';
  gutter?: number;
  margin?: number;
  size?: number;
  align?: 'stretch' | 'min' | 'center' | 'max';
  color?: string;
  hidden?: boolean;
}

export interface DesignBoardEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  page?: string;
  expand?: 'fill';
  print?: DesignPrintMode;
  paper?: DesignPaperFormat;
  is_interactive?: boolean;
  frameless?: boolean;
  radius?: number;
  guides?: DesignGuide[];
}

export interface DesignPageEntry {
  id: string;
  name: string;
}

export type DesignNoteColor =
  | 'gray'
  | 'red'
  | 'orange'
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'pink';

export type DesignNoteKind =
  | 'title1'
  | 'rect'
  | 'oval'
  | 'pen'
  | 'line'
  | 'arrow'
  | 'image'
  | 'link';

export interface DesignNoteEntry {
  kind?: DesignNoteKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text: string;
  fill?: DesignNoteColor | string;
  size?: 's' | 'm' | 'l' | 'xl';
  bold?: boolean;
  maxW?: number;
  page?: string;
  href?: string;
  title?: string;
  linkKind?: string;
}

export interface DesignSystemRef {
  title: string;
  namespace: string;
  artifact: string;
  version: string | null;
  copiedAt: string;
}

export type DesignLaunchConfig =
  | {view: 'canvas'; page?: string}
  | {view: 'focused'; file: string};

export interface DesignCanvasJson {
  v: 3;
  createdOnFiles?: {v: 1; at: string};
  title: string;
  launch?: DesignLaunchConfig;
  pages?: DesignPageEntry[];
  boards: Record<string, DesignBoardEntry>;
  order: string[];
  notes?: Record<string, DesignNoteEntry>;
  designSystems?: DesignSystemRef[];
}

export type DesignAnnotationAnchorStatus =
  | 'anchored'
  | 'reanchored'
  | 'stale'
  | 'lost';

export type DesignAnnotationSelectionKind =
  | 'element'
  | 'area'
  | 'canvas'
  | 'pod';

export interface DesignAnnotation {
  id: string;
  pinNumber: number;
  file?: string;
  tid?: number;
  path?: string;
  selector?: string;
  selectionKind: DesignAnnotationSelectionKind;
  status: DesignAnnotationAnchorStatus;
  text: string;
  author?: string;
  createdAt: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  lastGoodPosition?: {x: number; y: number; width?: number; height?: number};
  htmlHint?: string;
  currentText?: string;
  resolved?: boolean;
}

export interface DesignViewContext {
  canvasSlug: string;
  mode: 'canvas' | 'focused';
  page?: string;
  pageName?: string;
  visibleArtboards: string[];
  selectedArtboards: string[];
  erroredArtboards: Array<{file: string; message: string}>;
  firstError?: string;
  dirty: boolean;
  selected?: Array<{
    file: string;
    tid?: number;
    path?: string;
    selector?: string;
  }>;
  edits: number;
  contentHash?: string;
}

export type DesignDensity = 'default' | 'compact';

export interface SeedToken {
  colorPrimary: string;
  colorSuccess: string;
  colorWarning: string;
  colorError: string;
  colorInfo: string;
  colorLink: string;
  colorTextBase: string;
  colorBgBase: string;
  fontDisplay: string;
  fontBody: string;
  fontFamilyCode: string;
  fontSize: number;
  borderRadius: number;
  sizeUnit: number;
  sizeStep: number;
  controlHeight: number;
  lineWidth: number;
  density: DesignDensity;
  motionUnit: number;
  motionBase: number;
  motion: boolean;
  wireframe: boolean;
}

export type DesignLintSeverity = 'P0' | 'P1' | 'P2';

export interface DesignLintFinding {
  file: string;
  severity: DesignLintSeverity;
  id: string;
  message: string;
  fix?: string;
  snippet?: string;
}

export interface DesignCheckIssue {
  file: string;
  message: string;
}

export interface DesignCheckReport {
  ok: boolean;
  title: string;
  boardCount: number;
  issues: DesignCheckIssue[];
  lintFindings: DesignLintFinding[];
  p0Count: number;
  p1Count: number;
  p2Count: number;
}

export type DesignExportFormat = 'html' | 'zip' | 'pdf' | 'png';

export interface DesignWorkspaceSummary {
  slug: string;
  title: string;
  dir: string;
  boardCount: number;
  pageCount: number;
  designSystemCount: number;
  contentHash: string;
  updatedAt: string;
}

export interface DesignCanvasSnapshot {
  slug: string;
  dir: string;
  canvas: DesignCanvasJson;
  boardsContent: Record<string, string>;
  contentHash: string;
  revision: number;
}

export interface DesignAssetImportResult {
  id: string;
  blobUrl: string;
  relativePath: string;
  bytes: number;
  mimeType: string;
}

export interface DesignHandoffManifest {
  v: 1;
  slug: string;
  title: string;
  exportedAt: string;
  screens: Array<{
    file: string;
    title: string;
    width: number;
    height: number;
    role: 'interactive' | 'flow-document' | 'artboard';
    page?: string;
  }>;
  designSystems: DesignSystemRef[];
  assets: string[];
}
