import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {
  DesignCanvasJson,
  DesignDensity,
  DesignSystemRef,
  SeedToken,
} from './design_types';

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export interface DerivedThemeTokens {
  algorithm: 'light' | 'dark' | 'compact';
  colorPrimary: string;
  colorPrimaryScale: string[];
  colorSuccess: string;
  colorWarning: string;
  colorError: string;
  colorInfo: string;
  colorLink: string;
  colorBgBase: string;
  colorBgSurface: string;
  colorBgElevated: string;
  colorTextBase: string;
  colorTextSecondary: string;
  colorTextMuted: string;
  colorBorder: string;
  fontDisplay: string;
  fontBody: string;
  fontCode: string;
  fontSize: number;
  borderRadius: number;
  borderRadiusSm: number;
  borderRadiusLg: number;
  spacingUnit: number;
  spacingSm: number;
  spacingMd: number;
  spacingLg: number;
  controlHeight: number;
  lineWidth: number;
  motionDurationFast: string;
  motionDurationMid: string;
}

export interface DesignTokensJson {
  color: {
    tokens: Array<{name: string; value: string; role: string}>;
  };
  type: {
    families: {display: string; body: string; code: string};
    baseSize: number;
  };
  spacing: {
    tokens: Array<{name: string; value: string}>;
  };
  radius: {
    tokens: Array<{name: string; value: string}>;
  };
  shadow: {
    tokens: Array<{name: string; value: string}>;
  };
}

export interface DesignSystemManifestJson {
  v: 3;
  layout: 'files';
  title: string;
  namespace: string;
  seed: SeedToken;
  files: string[];
}

export interface DesignBrandSystemOutput {
  title: string;
  namespace: string;
  seed: SeedToken;
  themes: {
    light: DerivedThemeTokens;
    dark: DerivedThemeTokens;
    compact: DerivedThemeTokens;
  };
  tokensCss: string;
  tokensJson: DesignTokensJson;
  designMd: string;
  designSystemJson: DesignSystemManifestJson;
}

const DEFAULT_DISPLAY_FONT =
  '"Newsreader", Georgia, "Times New Roman", serif';
const DEFAULT_BODY_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const DEFAULT_CODE_FONT =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

const HUE_STEP = 2;
const SATURATION_STEP_LIGHT = 0.16;
const SATURATION_STEP_DARK = 0.05;
const BRIGHTNESS_STEP_LIGHT = 0.05;
const BRIGHTNESS_STEP_DARK = 0.15;
const LIGHT_COLOR_COUNT = 5;
const DARK_COLOR_COUNT = 4;

const DARK_BLEND_MAP: ReadonlyArray<{index: number; opacity: number}> = [
  {index: 7, opacity: 0.15},
  {index: 6, opacity: 0.25},
  {index: 5, opacity: 0.3},
  {index: 5, opacity: 0.45},
  {index: 5, opacity: 0.65},
  {index: 5, opacity: 0.85},
  {index: 4, opacity: 0.9},
  {index: 3, opacity: 0.95},
  {index: 2, opacity: 0.97},
  {index: 1, opacity: 0.98},
];

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function normalizeHex(raw: string, fallback = '#1677ff'): string {
  const trimmed = raw.trim().toLowerCase();
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(trimmed);
  if (!match) {
    return fallback;
  }
  const hex = match[1];
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return `#${hex}`;
}

function parseHex(input: string): RgbColor {
  const normalized = normalizeHex(input, '#000000').slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(rgb: RgbColor): string {
  const part = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function rgbToHsv(rgb: RgbColor): HsvColor {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = (g - b) / delta + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h *= 60;
  }
  return {h, s: max === 0 ? 0 : delta / max, v: max};
}

function hsvToRgb(hsv: HsvColor): RgbColor {
  const hh = (hsv.h / 360) * 6;
  const sector = Math.floor(hh);
  const frac = hh - sector;
  const p = hsv.v * (1 - hsv.s);
  const q = hsv.v * (1 - frac * hsv.s);
  const t = hsv.v * (1 - (1 - frac) * hsv.s);
  const mod = ((sector % 6) + 6) % 6;
  const r = [hsv.v, q, p, p, t, hsv.v][mod] ?? 0;
  const g = [t, hsv.v, hsv.v, q, p, p][mod] ?? 0;
  const b = [p, p, t, hsv.v, hsv.v, q][mod] ?? 0;
  return {r: r * 255, g: g * 255, b: b * 255};
}

function mixRgb(back: RgbColor, front: RgbColor, amount: number): RgbColor {
  return {
    r: front.r * amount + back.r * (1 - amount),
    g: front.g * amount + back.g * (1 - amount),
    b: front.b * amount + back.b * (1 - amount),
  };
}

function stepHue(hsv: HsvColor, index: number, light: boolean): number {
  let hue: number;
  if (hsv.h >= 60 && hsv.h <= 240) {
    hue = light ? hsv.h - HUE_STEP * index : hsv.h + HUE_STEP * index;
  } else {
    hue = light ? hsv.h + HUE_STEP * index : hsv.h - HUE_STEP * index;
  }
  if (hue < 0) {
    return hue + 360;
  }
  if (hue >= 360) {
    return hue - 360;
  }
  return hue;
}

function stepSaturation(hsv: HsvColor, index: number, light: boolean): number {
  if (hsv.h === 0 && hsv.s === 0) {
    return hsv.s;
  }
  let sat: number;
  if (light) {
    sat = hsv.s - SATURATION_STEP_LIGHT * index;
  } else if (index === DARK_COLOR_COUNT) {
    sat = hsv.s + SATURATION_STEP_LIGHT;
  } else {
    sat = hsv.s + SATURATION_STEP_DARK * index;
  }
  if (sat > 1) {
    sat = 1;
  }
  if (light && index === LIGHT_COLOR_COUNT && sat > 0.1) {
    sat = 0.1;
  }
  if (sat < 0.06) {
    sat = 0.06;
  }
  return Number(sat.toFixed(2));
}

function stepValue(hsv: HsvColor, index: number, light: boolean): number {
  let val = light
    ? hsv.v + BRIGHTNESS_STEP_LIGHT * index
    : hsv.v - BRIGHTNESS_STEP_DARK * index;
  if (val > 1) {
    val = 1;
  }
  if (val < 0) {
    val = 0;
  }
  return Number(val.toFixed(2));
}

/**
 * Generates a deterministic 10-step tonal color ladder from a base hex color.
 * Index 5 corresponds to the base color; indices 0..4 are lighter tints and 6..9 are darker shades.
 */
export function generateColorScale(
  baseHex: string,
  options?: {theme?: 'light' | 'dark'; backgroundColor?: string},
): string[] {
  const normalized = normalizeHex(baseHex);
  const baseHsv = rgbToHsv(parseHex(normalized));
  const lightScale: string[] = [];

  for (let i = LIGHT_COLOR_COUNT; i >= 1; i--) {
    lightScale.push(
      rgbToHex(
        hsvToRgb({
          h: stepHue(baseHsv, i, true),
          s: stepSaturation(baseHsv, i, true),
          v: stepValue(baseHsv, i, true),
        }),
      ),
    );
  }
  lightScale.push(normalized);
  for (let i = 1; i <= DARK_COLOR_COUNT; i++) {
    lightScale.push(
      rgbToHex(
        hsvToRgb({
          h: stepHue(baseHsv, i, false),
          s: stepSaturation(baseHsv, i, false),
          v: stepValue(baseHsv, i, false),
        }),
      ),
    );
  }

  if (options?.theme !== 'dark') {
    return lightScale;
  }

  const bgRgb = parseHex(options.backgroundColor ?? '#141414');
  return DARK_BLEND_MAP.map(entry => {
    const sourceHex = lightScale[entry.index] ?? normalized;
    return rgbToHex(mixRgb(bgRgb, parseHex(sourceHex), entry.opacity));
  });
}

/** Returns a complete 22-field SeedToken with deterministic defaults. */
export function defaultSeedToken(overrides?: Partial<SeedToken>): SeedToken {
  const colorPrimary = normalizeHex(overrides?.colorPrimary ?? '#1677ff');
  const density: DesignDensity =
    overrides?.density === 'compact' ? 'compact' : 'default';
  return {
    colorPrimary,
    colorSuccess: normalizeHex(overrides?.colorSuccess ?? '#52c41a'),
    colorWarning: normalizeHex(overrides?.colorWarning ?? '#faad14'),
    colorError: normalizeHex(overrides?.colorError ?? '#ff4d4f'),
    colorInfo: normalizeHex(overrides?.colorInfo ?? colorPrimary),
    colorLink: normalizeHex(overrides?.colorLink || colorPrimary),
    colorTextBase: normalizeHex(overrides?.colorTextBase ?? '#111827'),
    colorBgBase: normalizeHex(overrides?.colorBgBase ?? '#ffffff'),
    fontDisplay: overrides?.fontDisplay?.trim() || DEFAULT_DISPLAY_FONT,
    fontBody: overrides?.fontBody?.trim() || DEFAULT_BODY_FONT,
    fontFamilyCode: overrides?.fontFamilyCode?.trim() || DEFAULT_CODE_FONT,
    fontSize: overrides?.fontSize ?? 14,
    borderRadius: overrides?.borderRadius ?? 6,
    sizeUnit: overrides?.sizeUnit ?? 4,
    sizeStep: overrides?.sizeStep ?? 4,
    controlHeight:
      overrides?.controlHeight ?? (density === 'compact' ? 28 : 32),
    lineWidth: overrides?.lineWidth ?? 1,
    density,
    motionUnit: overrides?.motionUnit ?? 0.1,
    motionBase: overrides?.motionBase ?? 0,
    motion: overrides?.motion ?? true,
    wireframe: overrides?.wireframe ?? false,
  };
}

function deriveTheme(
  seed: SeedToken,
  algorithm: 'light' | 'dark' | 'compact',
): DerivedThemeTokens {
  const isDark = algorithm === 'dark';
  const isCompact = algorithm === 'compact';

  const bgBase = isDark ? '#141414' : seed.colorBgBase;
  const textBase = isDark ? '#f5f5f5' : seed.colorTextBase;
  const bgRgb = parseHex(bgBase);
  const textRgb = parseHex(textBase);

  const primaryScale = generateColorScale(seed.colorPrimary, {
    theme: isDark ? 'dark' : 'light',
    backgroundColor: bgBase,
  });

  const surface = isDark
    ? rgbToHex(mixRgb(bgRgb, {r: 255, g: 255, b: 255}, 0.04))
    : rgbToHex(mixRgb(bgRgb, textRgb, 0.02));
  const elevated = isDark
    ? rgbToHex(mixRgb(bgRgb, {r: 255, g: 255, b: 255}, 0.08))
    : '#ffffff';
  const textSecondary = rgbToHex(mixRgb(bgRgb, textRgb, isDark ? 0.68 : 0.65));
  const textMuted = rgbToHex(mixRgb(bgRgb, textRgb, isDark ? 0.45 : 0.45));
  const border = rgbToHex(mixRgb(bgRgb, textRgb, isDark ? 0.16 : 0.12));

  const unit = isCompact ? Math.max(2, seed.sizeUnit - 1) : seed.sizeUnit;
  const fontSize = isCompact ? Math.max(12, seed.fontSize - 1) : seed.fontSize;
  const radius = isCompact
    ? Math.max(2, seed.borderRadius - 2)
    : seed.borderRadius;
  const controlHeight = isCompact
    ? Math.max(24, seed.controlHeight - 4)
    : seed.controlHeight;

  const fastMs = seed.motion
    ? `${Math.round((seed.motionBase + seed.motionUnit) * 1000)}ms`
    : '0ms';
  const midMs = seed.motion
    ? `${Math.round((seed.motionBase + seed.motionUnit * 2) * 1000)}ms`
    : '0ms';

  return {
    algorithm,
    colorPrimary: primaryScale[5] ?? seed.colorPrimary,
    colorPrimaryScale: primaryScale,
    colorSuccess: seed.colorSuccess,
    colorWarning: seed.colorWarning,
    colorError: seed.colorError,
    colorInfo: seed.colorInfo,
    colorLink: seed.colorLink,
    colorBgBase: bgBase,
    colorBgSurface: surface,
    colorBgElevated: elevated,
    colorTextBase: textBase,
    colorTextSecondary: textSecondary,
    colorTextMuted: textMuted,
    colorBorder: border,
    fontDisplay: seed.fontDisplay,
    fontBody: seed.fontBody,
    fontCode: seed.fontFamilyCode,
    fontSize,
    borderRadius: radius,
    borderRadiusSm: Math.max(0, Math.round(radius * 0.66)),
    borderRadiusLg: Math.round(radius * 1.5),
    spacingUnit: unit,
    spacingSm: unit * 2,
    spacingMd: unit * 4,
    spacingLg: unit * 6,
    controlHeight,
    lineWidth: seed.lineWidth,
    motionDurationFast: fastMs,
    motionDurationMid: midMs,
  };
}

function renderCssVarBlock(
  selector: string,
  theme: DerivedThemeTokens,
): string {
  const lines = [
    `${selector} {`,
    `  --bg: ${theme.colorBgBase};`,
    `  --surface: ${theme.colorBgSurface};`,
    `  --surface-elevated: ${theme.colorBgElevated};`,
    `  --fg: ${theme.colorTextBase};`,
    `  --fg-secondary: ${theme.colorTextSecondary};`,
    `  --muted: ${theme.colorTextMuted};`,
    `  --border: ${theme.colorBorder};`,
    `  --accent: ${theme.colorPrimary};`,
    ...theme.colorPrimaryScale.map((hex, i) => `  --accent-${i + 1}: ${hex};`),
    `  --success: ${theme.colorSuccess};`,
    `  --warning: ${theme.colorWarning};`,
    `  --error: ${theme.colorError};`,
    `  --info: ${theme.colorInfo};`,
    `  --font-display: ${theme.fontDisplay};`,
    `  --font-body: ${theme.fontBody};`,
    `  --font-code: ${theme.fontCode};`,
    `  --font-size-base: ${theme.fontSize}px;`,
    `  --radius-sm: ${theme.borderRadiusSm}px;`,
    `  --radius-md: ${theme.borderRadius}px;`,
    `  --radius-lg: ${theme.borderRadiusLg}px;`,
    `  --space-unit: ${theme.spacingUnit}px;`,
    `  --space-sm: ${theme.spacingSm}px;`,
    `  --space-md: ${theme.spacingMd}px;`,
    `  --space-lg: ${theme.spacingLg}px;`,
    `  --control-height: ${theme.controlHeight}px;`,
    `  --line-width: ${theme.lineWidth}px;`,
    `  --motion-fast: ${theme.motionDurationFast};`,
    `  --motion-mid: ${theme.motionDurationMid};`,
    '}',
  ];
  return lines.join('\n');
}

function sanitizeNamespace(raw: string | undefined): string {
  const cleaned = (raw ?? 'brand')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  return (cleaned || 'brand').slice(0, 64);
}

/**
 * Deterministically compiles a ~20-field SeedToken into light/dark/compact themes,
 * tokens.css, flat tokens.json, DESIGN.md, and v3 design-system.json with zero LLM calls.
 */
export function compileBrandSystem(
  seedInput: Partial<SeedToken> & {name?: string; namespace?: string},
): DesignBrandSystemOutput {
  const seed = defaultSeedToken(seedInput);
  const title = seedInput.name?.trim() || 'Brand Design System';
  const namespace = sanitizeNamespace(seedInput.namespace ?? title);

  const light = deriveTheme(seed, 'light');
  const dark = deriveTheme(seed, 'dark');
  const compact = deriveTheme(seed, 'compact');
  const defaultTheme = seed.density === 'compact' ? compact : light;

  const tokensCss = [
    `/* Generated deterministically by Magic Pointer Brand Engine (${title}) */`,
    renderCssVarBlock(':root', defaultTheme),
    '',
    renderCssVarBlock('[data-theme="dark"]', dark),
    '',
    renderCssVarBlock('[data-density="compact"]', compact),
    '',
  ].join('\n');

  const tokensJson: DesignTokensJson = {
    color: {
      tokens: [
        {name: 'bg', value: defaultTheme.colorBgBase, role: 'background'},
        {name: 'surface', value: defaultTheme.colorBgSurface, role: 'surface'},
        {name: 'fg', value: defaultTheme.colorTextBase, role: 'foreground'},
        {name: 'muted', value: defaultTheme.colorTextMuted, role: 'muted'},
        {name: 'border', value: defaultTheme.colorBorder, role: 'border'},
        {name: 'accent', value: defaultTheme.colorPrimary, role: 'accent'},
        {name: 'success', value: defaultTheme.colorSuccess, role: 'status'},
        {name: 'warning', value: defaultTheme.colorWarning, role: 'status'},
        {name: 'error', value: defaultTheme.colorError, role: 'status'},
        ...defaultTheme.colorPrimaryScale.map((hex, i) => ({
          name: `accent-${i + 1}`,
          value: hex,
          role: 'scale',
        })),
      ],
    },
    type: {
      families: {
        display: defaultTheme.fontDisplay,
        body: defaultTheme.fontBody,
        code: defaultTheme.fontCode,
      },
      baseSize: defaultTheme.fontSize,
    },
    spacing: {
      tokens: [
        {name: 'space-unit', value: `${defaultTheme.spacingUnit}px`},
        {name: 'space-sm', value: `${defaultTheme.spacingSm}px`},
        {name: 'space-md', value: `${defaultTheme.spacingMd}px`},
        {name: 'space-lg', value: `${defaultTheme.spacingLg}px`},
      ],
    },
    radius: {
      tokens: [
        {name: 'radius-sm', value: `${defaultTheme.borderRadiusSm}px`},
        {name: 'radius-md', value: `${defaultTheme.borderRadius}px`},
        {name: 'radius-lg', value: `${defaultTheme.borderRadiusLg}px`},
      ],
    },
    shadow: {
      tokens: [
        {
          name: 'shadow-sm',
          value: seed.wireframe ? 'none' : '0 1px 2px rgba(0, 0, 0, 0.06)',
        },
        {
          name: 'shadow-md',
          value: seed.wireframe ? 'none' : '0 4px 12px rgba(0, 0, 0, 0.08)',
        },
      ],
    },
  };

  const designMd = [
    `# ${title}`,
    '',
    '## Overview',
    `- **Namespace**: \`${namespace}\``,
    `- **Default Density**: \`${seed.density}\``,
    `- **Wireframe Mode**: \`${String(seed.wireframe)}\``,
    '',
    '## Color Palette',
    `- \`--bg\`: \`${defaultTheme.colorBgBase}\``,
    `- \`--surface\`: \`${defaultTheme.colorBgSurface}\``,
    `- \`--fg\`: \`${defaultTheme.colorTextBase}\``,
    `- \`--muted\`: \`${defaultTheme.colorTextMuted}\``,
    `- \`--border\`: \`${defaultTheme.colorBorder}\``,
    `- \`--accent\`: \`${defaultTheme.colorPrimary}\``,
    `- **10-Step Accent Scale**: ${defaultTheme.colorPrimaryScale.map(c => `\`${c}\``).join(', ')}`,
    '',
    '## Typography',
    `- **Display**: ${defaultTheme.fontDisplay}`,
    `- **Body**: ${defaultTheme.fontBody}`,
    `- **Code**: ${defaultTheme.fontCode}`,
    `- **Base Size**: \`${defaultTheme.fontSize}px\``,
    '',
    '## Spacing & Radius',
    `- **Unit**: \`${defaultTheme.spacingUnit}px\` (sm \`${defaultTheme.spacingSm}px\`, md \`${defaultTheme.spacingMd}px\`, lg \`${defaultTheme.spacingLg}px\`)`,
    `- **Radius**: sm \`${defaultTheme.borderRadiusSm}px\`, md \`${defaultTheme.borderRadius}px\`, lg \`${defaultTheme.borderRadiusLg}px\``,
    `- **Control Height**: \`${defaultTheme.controlHeight}px\``,
    '',
    '## Density & Motion',
    `- **Fast Motion**: \`${defaultTheme.motionDurationFast}\``,
    `- **Mid Motion**: \`${defaultTheme.motionDurationMid}\``,
    '',
    '## Usage Rules',
    '- Reference semantic tokens via CSS custom properties (`var(--bg)`, `var(--surface)`, `var(--fg)`, `var(--accent)`) instead of raw hex literals.',
    '- Cap `var(--accent)` usage to primary actions and key focal points per screen.',
    '',
  ].join('\n');

  const designSystemJson: DesignSystemManifestJson = {
    v: 3,
    layout: 'files',
    title,
    namespace,
    seed,
    files: ['design-system.json', 'tokens.css', 'tokens.json', 'DESIGN.md'],
  };

  return {
    title,
    namespace,
    seed,
    themes: {light, dark, compact},
    tokensCss,
    tokensJson,
    designMd,
    designSystemJson,
  };
}

/**
 * Installs a compiled Brand Design System into `<canvasDir>/ds/<namespace>/`
 * and returns an updated `canvas.json` with `designSystems[]` registered.
 */
export async function installBrandSystemToCanvas(
  canvasDir: string,
  system: DesignBrandSystemOutput,
  canvasJson: DesignCanvasJson,
  artifactSource = 'local:brand-engine',
): Promise<DesignCanvasJson> {
  const dsDir = join(canvasDir, 'ds', system.namespace);
  await mkdir(dsDir, {recursive: true});

  await Promise.all([
    writeFile(
      join(dsDir, 'design-system.json'),
      JSON.stringify(system.designSystemJson, null, 2),
      'utf8',
    ),
    writeFile(join(dsDir, 'tokens.css'), system.tokensCss, 'utf8'),
    writeFile(
      join(dsDir, 'tokens.json'),
      JSON.stringify(system.tokensJson, null, 2),
      'utf8',
    ),
    writeFile(join(dsDir, 'DESIGN.md'), system.designMd, 'utf8'),
  ]);

  const existing = canvasJson.designSystems ?? [];
  const nextRef: DesignSystemRef = {
    title: system.title,
    namespace: system.namespace,
    artifact: artifactSource,
    version: '1',
    copiedAt: new Date().toISOString(),
  };

  const filtered = existing.filter(ref => ref.namespace !== system.namespace);
  if (filtered.length >= 4) {
    throw new Error('A design canvas supports at most 4 installed design systems');
  }

  return {
    ...canvasJson,
    designSystems: [...filtered, nextRef],
  };
}
