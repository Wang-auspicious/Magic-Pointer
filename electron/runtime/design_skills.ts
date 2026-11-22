import type {DesignAnnotation, DesignViewContext} from './design_types';

export type CraftRuleSlug =
  | 'typography'
  | 'color'
  | 'anti-ai-slop'
  | 'state-coverage'
  | 'laws-of-ux'
  | 'animation-discipline';

export interface DesignDirection {
  id: string;
  name: string;
  palette: {
    bg: string;
    surface: string;
    fg: string;
    muted: string;
    border: string;
    accent: string;
  };
  displayFont: string;
  bodyFont: string;
  posture: string;
}

export const DESIGN_DIRECTIONS: readonly DesignDirection[] = [
  {
    id: 'editorial-monocle',
    name: 'Editorial Monocle',
    palette: {
      bg: 'oklch(0.98 0.006 85)',
      surface: 'oklch(0.96 0.008 85)',
      fg: 'oklch(0.18 0.01 85)',
      muted: 'oklch(0.48 0.01 85)',
      border: 'oklch(0.86 0.01 85)',
      accent: 'oklch(0.52 0.16 28)',
    },
    displayFont: '"Newsreader", Georgia, serif',
    bodyFont: '"Inter", system-ui, sans-serif',
    posture:
      'Crisp 1px hairline borders, generous whitespace, zero drop shadows, editorial serif display headings.',
  },
  {
    id: 'swiss-grid',
    name: 'Swiss Precision Grid',
    palette: {
      bg: 'oklch(0.99 0 0)',
      surface: 'oklch(0.96 0 0)',
      fg: 'oklch(0.14 0 0)',
      muted: 'oklch(0.46 0 0)',
      border: 'oklch(0.84 0 0)',
      accent: 'oklch(0.55 0.22 26)',
    },
    displayFont: '"Helvetica Neue", Arial, sans-serif',
    bodyFont: '"Helvetica Neue", Arial, sans-serif',
    posture:
      'Strict 12-column alignment, tabular numerals, high-contrast black-on-white hierarchy, single vermilion accent.',
  },
  {
    id: 'warm-atelier',
    name: 'Warm Atelier',
    palette: {
      bg: 'oklch(0.96 0.014 75)',
      surface: 'oklch(0.93 0.016 75)',
      fg: 'oklch(0.21 0.02 60)',
      muted: 'oklch(0.46 0.02 60)',
      border: 'oklch(0.84 0.02 70)',
      accent: 'oklch(0.49 0.12 155)',
    },
    displayFont: '"Instrument Serif", Georgia, serif',
    bodyFont: '"Plus Jakarta Sans", system-ui, sans-serif',
    posture:
      'Tactile warm paper tone, restrained botanical green accent, subtle 8px radii, calm hierarchy.',
  },
  {
    id: 'technical-blueprint',
    name: 'Technical Blueprint',
    palette: {
      bg: 'oklch(0.16 0.015 250)',
      surface: 'oklch(0.21 0.018 250)',
      fg: 'oklch(0.94 0.008 250)',
      muted: 'oklch(0.66 0.015 250)',
      border: 'oklch(0.32 0.02 250)',
      accent: 'oklch(0.72 0.14 210)',
    },
    displayFont: '"Space Grotesk", system-ui, sans-serif',
    bodyFont: '"Inter", system-ui, sans-serif',
    posture:
      'Dark slate instrumentation, monospace metrics, 1px crisp borders, cyan-steel highlight reserved for active state.',
  },
];

export const CRAFT_RULES: Record<CraftRuleSlug, string> = {
  typography: [
    '### Typography Craft',
    '- Pair a distinctive display face (`var(--font-display)`) with a clean body face (`var(--font-body)`).',
    '- Any `text-transform: uppercase` eyebrow or label MUST include `letter-spacing: 0.06em` or greater.',
    '- Use `tabular-nums` on metrics, tables, and counters; keep measure 55–72ch for body prose.',
  ].join('\n'),
  color: [
    '### Color Craft',
    '- Declare semantic tokens in `:root` (`--bg`, `--surface`, `--fg`, `--muted`, `--border`, `--accent`) and reference them via `var(...)`.',
    '- Reserve `var(--accent)` for at most 2 focal elements per screen; never flood cards or badges with accent fills.',
  ].join('\n'),
  'anti-ai-slop': [
    '### Anti-AI-Slop Invariants',
    '- NEVER use purple/violet gradients, blue-to-cyan trust gradients, or default Tailwind indigo (`#6366f1`, `#4f46e5`).',
    '- NEVER use emojis (`✨`, `🚀`, `⚡`, `🎯`, etc.) as UI/feature icons; use clean monoline inline SVGs (`stroke="currentColor"`).',
    '- NEVER build rounded cards with thick colored `border-left` stripes.',
    '- NEVER emit `lorem ipsum`, `Feature One`, or invented metrics like `10× faster` or `99.9% uptime`.',
  ].join('\n'),
  'state-coverage': [
    '### State Coverage',
    '- Interactive screens must account for default, hover/focus-visible, empty, loading, and error states.',
    '- Include `data-mp-id` anchors on major `<section>` and interactive containers so spatial comments stay anchored.',
  ].join('\n'),
  'laws-of-ux': [
    '### Laws of UX',
    '- Group related controls by proximity; limit primary choices per view (Hick’s Law) and keep primary actions prominent (Fitts’s Law).',
    '- Present scannable visual hierarchy: clear primary focal point, secondary metadata, and quiet chrome.',
  ].join('\n'),
  'animation-discipline': [
    '### Animation Discipline',
    '- Prefer subtle CSS transitions (`150ms–240ms cubic-bezier(0.2, 0.8, 0.2, 1)`) on `transform` and `opacity` only.',
    '- Respect `@media (prefers-reduced-motion: reduce)` and avoid continuous distracting loops.',
  ].join('\n'),
};

export const DC_HTML_AUTHORING_GUIDE = [
  '### `.dc.html` Artboard Contract',
  '- `<head>` MUST include `<script src="./support.js"></script>` verbatim.',
  '- Wrap all rendered markup inside `<x-dc>...</x-dc>` using lowercase HTML tags and closed non-void elements.',
  '- Include exactly one `<script type="text/x-dc" data-dc-script data-props=\'{"$preview":{"width":W,"height":H}}\'>` defining `class Component extends DCLogic { renderVals() { return {...}; } }`.',
  '- `{{path}}` holes support dotted property lookup or literals ONLY (never JS expressions like `{{a + b}}`).',
  '- Use `<sc-for list="{{items}}" as="item">` and `<sc-if value="{{cond}}">` for loops/conditionals; mount sibling boards via `<dc-import name="Card"></dc-import>`.',
  '- Local images/fonts MUST be imported via `Design.import_asset` and referenced as `/_blob/<32-hex>` (never `data:` URIs or remote placeholder CDNs).',
].join('\n');

export const SLIDES_AUTHORING_GUIDE = [
  '### Slides Authoring Contract',
  '- Fixed `1920 × 1080` canvas per slide (`<section>` root) with generous margins (`>= 80px`) and high legibility.',
  '- One key idea per slide; keep body copy concise and pair data visuals with clear takeaway headlines.',
  '- Use `paper: "letter"` (`816×1056`) or `paper: "a4"` (`794×1123`) with `print: "flow"` for multi-page print documents.',
].join('\n');

/** Formats `<design_view_context>` metadata for MPAgentRuntime prompt injection. */
export function formatDesignViewContext(ctx: DesignViewContext): string {
  const lines = [
    `<design_view_context canvas="${ctx.canvasSlug}" mode="${ctx.mode}" dirty="${String(ctx.dirty)}" edits="${ctx.edits}">`,
  ];
  if (ctx.page) {
    lines.push(
      `  <page id="${ctx.page}"${ctx.pageName ? ` name="${ctx.pageName}"` : ''} />`,
    );
  }
  if (ctx.visibleArtboards.length > 0) {
    lines.push(
      `  <visible_artboards>${ctx.visibleArtboards.join(', ')}</visible_artboards>`,
    );
  }
  if (ctx.selectedArtboards.length > 0) {
    lines.push(
      `  <selected_artboards>${ctx.selectedArtboards.join(', ')}</selected_artboards>`,
    );
  }
  if (ctx.selected && ctx.selected.length > 0) {
    for (const sel of ctx.selected) {
      const anchor =
        sel.tid !== undefined && sel.path
          ? `${sel.file}#${sel.tid}:${sel.path}`
          : sel.file;
      lines.push(
        `  <selected_element anchor="${anchor}"${sel.selector ? ` selector="${sel.selector}"` : ''} />`,
      );
    }
  }
  if (ctx.erroredArtboards.length > 0) {
    for (const err of ctx.erroredArtboards) {
      lines.push(
        `  <errored_artboard file="${err.file}">${err.message.slice(0, 600)}</errored_artboard>`,
      );
    }
  }
  if (ctx.dirty) {
    lines.push(
      '  <notice>Canvas has unsaved or recent user edits; re-read before patching.</notice>',
    );
  }
  lines.push('</design_view_context>');
  return lines.join('\n');
}

/** Formats `<design_annotations>` spatial comments with a hard scope guard. */
export function formatDesignAnnotations(
  annotations: readonly DesignAnnotation[],
  canvasSlug?: string,
): string {
  const open = annotations.filter(a => !a.resolved);
  if (open.length === 0) {
    return '';
  }

  const headerAttr = canvasSlug ? ` canvas="${canvasSlug}"` : '';
  const lines = [
    `<design_annotations${headerAttr}>`,
    '  <hard_scope>Only modify the anchored elements/artboards referenced below; do not alter unrelated artboards or global tokens unless explicitly requested.</hard_scope>',
  ];

  for (const ann of open) {
    const anchor =
      ann.file && ann.tid !== undefined && ann.path
        ? `${ann.file}#${ann.tid}:${ann.path}`
        : ann.file
          ? ann.file
          : ann.x !== undefined && ann.y !== undefined
            ? `canvas ${ann.x},${ann.y}`
            : 'canvas';
    lines.push(
      `  <annotation pin="${ann.pinNumber}" kind="${ann.selectionKind}" status="${ann.status}" anchor="${anchor}">`,
    );
    if (ann.currentText) {
      lines.push(`    <current_text>${ann.currentText.slice(0, 240)}</current_text>`);
    }
    lines.push(`    <comment>${ann.text}</comment>`);
    lines.push('  </annotation>');
  }

  lines.push('</design_annotations>');
  return lines.join('\n');
}

/**
 * Builds the modular Design Studio system prompt for MPAgentRuntime,
 * combining visual direction, selected craft rules, .dc.html/Slides guides,
 * and optional live view context + spatial annotations.
 */
export function buildDesignSystemPrompt(options?: {
  direction?: string;
  craft?: CraftRuleSlug[];
  includeSlides?: boolean;
  viewContext?: DesignViewContext;
  annotations?: readonly DesignAnnotation[];
}): string {
  const sections: string[] = [
    '## Magic Pointer Design Studio',
    'You are authoring local-first multi-artboard designs in Magic Pointer Design mode.',
    'Always validate with `Design.check` after writing or updating boards.',
  ];

  const direction = options?.direction
    ? DESIGN_DIRECTIONS.find(d => d.id === options.direction)
    : DESIGN_DIRECTIONS[0];
  if (direction) {
    sections.push(
      [
        `### Visual Direction: ${direction.name} (\`${direction.id}\`)`,
        `- Palette (OKLch): bg \`${direction.palette.bg}\`, surface \`${direction.palette.surface}\`, fg \`${direction.palette.fg}\`, muted \`${direction.palette.muted}\`, border \`${direction.palette.border}\`, accent \`${direction.palette.accent}\``,
        `- Display: ${direction.displayFont} | Body: ${direction.bodyFont}`,
        `- Posture: ${direction.posture}`,
      ].join('\n'),
    );
  }

  const craftSlugs: CraftRuleSlug[] = options?.craft ?? [
    'typography',
    'color',
    'anti-ai-slop',
    'state-coverage',
  ];
  const seen = new Set<CraftRuleSlug>();
  for (const slug of craftSlugs) {
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const rule = CRAFT_RULES[slug];
    if (rule) {
      sections.push(rule);
    }
  }

  sections.push(DC_HTML_AUTHORING_GUIDE);
  if (options?.includeSlides) {
    sections.push(SLIDES_AUTHORING_GUIDE);
  }

  if (options?.viewContext) {
    sections.push(formatDesignViewContext(options.viewContext));
  }
  if (options?.annotations && options.annotations.length > 0) {
    const annBlock = formatDesignAnnotations(
      options.annotations,
      options.viewContext?.canvasSlug,
    );
    if (annBlock) {
      sections.push(annBlock);
    }
  }

  return sections.join('\n\n');
}
