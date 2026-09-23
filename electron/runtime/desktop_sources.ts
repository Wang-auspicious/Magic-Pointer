import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, extname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { DesktopRecord, Rect } from './desktop';
import { rectIntersection, type FrozenFrame } from './desktop_perception';

type Color = [number, number, number];

function visibleHighlightRectangles(image: { data: Buffer; width: number; height: number; channels: number }, origin: Rect, rectangles: Rect[], page: Rect): Rect[] {
  const pixel = (x: number, y: number): Color | null => {
    const px = Math.floor(x - origin[0]), py = Math.floor(y - origin[1]);
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) return null;
    const at = (py * image.width + px) * image.channels;
    return [image.data[at], image.data[at + 1], image.data[at + 2]];
  };
  const candidates: { area: number; color: Color }[] = [];
  for (const [x, y, width, height] of rectangles) {
    const left = Math.max(0, Math.floor(x - origin[0])), top = Math.max(0, Math.floor(y - origin[1]));
    const right = Math.min(image.width, Math.ceil(x + width - origin[0])), bottom = Math.min(image.height, Math.ceil(y + height - origin[1]));
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (!area) continue;
    const counts = new Map<string, number>(), step = Math.max(1, Math.floor(area / 12000));
    let sampled = 0;
    for (let index = 0; index < area; index += step) {
      const px = left + index % (right - left), py = top + Math.floor(index / (right - left));
      const at = (py * image.width + px) * image.channels;
      const key = [image.data[at], image.data[at + 1], image.data[at + 2]].map(value => Math.floor(value / 8) * 8).join(',');
      counts.set(key, (counts.get(key) || 0) + 1); sampled++;
    }
    const dominant = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (!dominant || dominant[1] < Math.max(8, sampled * 0.18)) continue;
    const color = dominant[0].split(',').map(Number) as Color;
    if (Math.max(...color) >= 248 && Math.min(...color) >= 240) continue;
    candidates.push({ area: width * height, color });
  }
  if (!candidates.length) return [];
  const color = candidates.sort((a, b) => b.area - a.area)[0].color;
  const matches = (sample: Color | null) => !!sample && sample.every((value, index) => Math.abs(value - color[index]) <= 24);
  const left = Math.floor(Math.min(...rectangles.map(row => row[0]))), right = Math.ceil(Math.max(...rectangles.map(row => row[0] + row[2])));
  const top = Math.floor(Math.min(...rectangles.map(row => row[1]))), bottom = Math.ceil(Math.max(...rectangles.map(row => row[1] + row[3])));
  const sampleStep = Math.max(1, Math.floor((right - left) / 240));
  const rowCoverage = (y: number) => { let hits = 0, total = 0; for (let x = left; x < right; x += sampleStep) { total++; if (matches(pixel(x, y))) hits++; } return hits / Math.max(1, total); };
  if (Math.max(...[2, 3, 4, 5, 6].flatMap(offset => [rowCoverage(top - offset), rowCoverage(bottom + offset)])) >= 0.20) return [];
  const columnCoverage = (x: number, row: Rect) => {
    const rowTop = Math.max(Math.floor(row[1]), origin[1]), rowBottom = Math.min(Math.ceil(row[1] + row[3]), origin[3]);
    const inset = Math.max(2, Math.min(6, Math.floor((rowBottom - rowTop) / 10)));
    const start = rowTop + inset < rowBottom - inset ? rowTop + inset : rowTop;
    const end = rowTop + inset < rowBottom - inset ? rowBottom - inset : rowBottom;
    let hits = 0; for (let y = start; y < end; y++) if (matches(pixel(x, y))) hits++;
    return hits / Math.max(1, end - start);
  };
  const visual: Rect[] = [];
  for (const row of rectangles) {
    const runs: [number, number][] = []; let start = -1, last = -1, gap = 0;
    for (let x = Math.floor(page[0]); x < Math.ceil(page[0] + page[2]); x++) {
      if (columnCoverage(x, row) >= 0.20) { if (start < 0) start = x; last = x; gap = 0; }
      else if (start >= 0 && ++gap > 2) { runs.push([start, last + 1]); start = -1; last = -1; gap = 0; }
    }
    if (start >= 0) runs.push([start, last + 1]);
    const overlapping = runs.map(([runLeft, runRight]) => ({ left: runLeft, right: runRight, overlap: Math.max(0, Math.min(row[0] + row[2], runRight) - Math.max(row[0], runLeft)) }))
      .filter(run => run.overlap >= Math.max(2, Math.min(row[2], run.right - run.left) * 0.25))
      .sort((a, b) => b.overlap - a.overlap || (b.right - b.left) - (a.right - a.left));
    if (overlapping.length) visual.push([overlapping[0].left, row[1], overlapping[0].right - overlapping[0].left, row[3]]);
  }
  return visual;
}

function pdfSelectionAgrees(uiaText: string, recoveredText: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const left = [...normalize(uiaText)], right = [...normalize(recoveredText)];
  if (!left.length || !right.length) return false;
  if (left.join('') === right.join('')) return true;
  const states: { length: number; link: number; next: Map<string, number> }[] = [{ length: 0, link: -1, next: new Map() }];
  let last = 0;
  for (const char of left) {
    const current = states.length; states.push({ length: states[last].length + 1, link: 0, next: new Map() });
    let parent = last;
    while (parent >= 0 && !states[parent].next.has(char)) { states[parent].next.set(char, current); parent = states[parent].link; }
    if (parent < 0) states[current].link = 0;
    else {
      const next = states[parent].next.get(char)!;
      if (states[parent].length + 1 === states[next].length) states[current].link = next;
      else {
        const clone = states.length; states.push({ length: states[parent].length + 1, link: states[next].link, next: new Map(states[next].next) });
        while (parent >= 0 && states[parent].next.get(char) === next) { states[parent].next.set(char, clone); parent = states[parent].link; }
        states[next].link = clone; states[current].link = clone;
      }
    }
    last = current;
  }
  let state = 0, length = 0, longest = 0;
  for (const char of right) {
    while (state && !states[state].next.has(char)) { state = states[state].link; length = states[state].length; }
    const next = states[state].next.get(char);
    if (next === undefined) { state = 0; length = 0; }
    else { state = next; length++; longest = Math.max(longest, length); }
  }
  const maximum = Math.max(left.length, right.length);
  return longest >= 8 && longest / maximum >= 0.85 && left.length + right.length - 2 * longest <= Math.max(4, Math.ceil(maximum * 0.10));
}

export async function recoverPdfSelection(data: DesktopRecord, frame: FrozenFrame): Promise<DesktopRecord> {
  const location = String(data.document_location || '');
  let path: string; try { path = location.startsWith('file:') ? fileURLToPath(location) : resolve(location); } catch { return { ok: false, error: 'pdf_location_invalid' }; }
  const pageNumber = Number(data.page_ancestor_number || data.page_number); const pageRect = data.page_rect as Rect;
  if (!location || !existsSync(path) || !/\.pdf$/i.test(path)) return { ok: false, error: 'pdf_location_not_local' };
  if (!pageNumber || !Array.isArray(pageRect) || !data.rectangles?.length || data.truncated || data.rectangles_truncated || Number(data.range_count || 1) !== 1) return { ok: false, error: 'pdf_selection_geometry_incomplete' };
  if (data.page_selector_number && data.page_ancestor_number && data.page_selector_number !== data.page_ancestor_number) return { ok: false, error: 'pdf_page_identity_conflict' };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const loading = pdfjs.getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true }); const document = await loading.promise;
  try {
    const page = await document.getPage(pageNumber); if (page.rotate % 360 !== 0) return { ok: false, error: 'pdf_rotated_selection_unsupported' };
    const viewport = page.getViewport({ scale: 1 }); const sx = pageRect[2] / viewport.width, sy = pageRect[3] / viewport.height;
    if (!(sx > 0 && sy > 0) || Math.abs(sx - sy) > Math.max(sx, sy) * 0.04) return { ok: false, error: 'pdf_scale_inconsistent' };
    const image = await sharp(frame.localArtifact.path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const visual = visibleHighlightRectangles({ data: image.data, width: image.info.width, height: image.info.height, channels: image.info.channels }, frame.surfaceBoundsPx, data.rectangles as Rect[], pageRect);
    if (!visual.length) return { ok: false, error: 'pdf_visible_highlight_unmeasurable' };
    const content = await page.getTextContent(), operators = await page.getOperatorList(); const selected: string[] = []; const context: string[] = [];
    const glyphs: { text: string; width: number }[] = [];
    for (let index = 0; index < operators.fnArray.length; index++) {
      if (operators.fnArray[index] !== pdfjs.OPS.showText) continue;
      for (const glyph of operators.argsArray[index]?.[0] || []) {
        if (typeof glyph === 'number') { if (glyphs.length) glyphs[glyphs.length - 1].width = Math.max(0, glyphs.at(-1)!.width - glyph); continue; }
        const chars = [...String(glyph.unicode || '')]; for (const char of chars) glyphs.push({ text: char, width: Number(glyph.width || 0) / Math.max(1, chars.length) });
      }
    }
    const compact = glyphs.filter(glyph => !/\s/.test(glyph.text)); const compactText = compact.map(glyph => glyph.text).join(''); let glyphOffset = 0, estimated = false;
    for (const raw of content.items) {
      if (!('str' in raw) || !raw.str) continue;
      const transform = pdfjs.Util.transform(viewport.transform, raw.transform); const x = pageRect[0] + transform[4] * sx, height = Math.max(1, Math.hypot(transform[2], transform[3]) * sy), y = pageRect[1] + transform[5] * sy - height, width = raw.width * sx;
      context.push(raw.str + (raw.hasEOL ? '\n' : ' '));
      const box: Rect = [x, y, x + width, y + height]; const hits = visual.filter(rect => rectIntersection(box, [rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]]));
      if (!hits.length) continue;
      const chars = [...raw.str], needle = chars.filter(char => !/\s/.test(char)).join(''), at = compactText.indexOf(needle, glyphOffset);
      const metrics = at >= 0 ? compact.slice(at, at + [...needle].length) : []; if (at >= 0) glyphOffset = at + [...needle].length;
      let measuredIndex = 0; const nonSpace = metrics.map(glyph => glyph.width).filter(value => value > 0), average = nonSpace.length ? nonSpace.reduce((sum, value) => sum + value, 0) / nonSpace.length : 1;
      const advances = chars.map(char => /\s/.test(char) ? average * 0.4 : metrics[measuredIndex++]?.width || 0), total = advances.reduce((sum, value) => sum + value, 0);
      const measured = metrics.length === [...needle].length && total > 0 && advances.every(value => value > 0); if (!measured) estimated = true;
      let offset = 0;
      const value = chars.filter((_, i) => { const step = measured ? width * advances[i] / total : width / Math.max(1, chars.length), center = x + offset + step / 2; offset += step; return hits.some(rect => center >= rect[0] && center <= rect[0] + rect[2]); }).join('');
      if (value) selected.push(value + (raw.hasEOL ? '\n' : ' '));
    }
    const text = selected.join('').trim();
    if (!pdfSelectionAgrees(String(data.text || ''), text)) return { ok: false, error: 'pdf_selection_uia_disagreement' };
    return { ok: true, text, context: context.join('').trim(), rectangles: visual, document_path: path, page_number: pageNumber, uia_matching_core: data.text || '', dropped_uia_rectangle_count: data.rectangles.length - visual.length, usedBackend: 'pdfjs+frozen-highlight', characterGeometry: estimated ? 'pdf-glyph-widths-with-proportional-fallback' : 'pdf-glyph-widths', limitations: estimated ? ['some-partial-text-run-character-boundaries-are-estimated'] : [] };
  } finally { await loading.destroy(); }
}

export async function resolveComponentSource(workspace: string, browser: DesktopRecord | null, objects: DesktopRecord[] = []): Promise<DesktopRecord> {
  const root = resolve(workspace); const base = { schemaVersion: 1, state: 'unavailable', method: 'runtime-source+bounded-repository-signals', candidates: [] as DesktopRecord[], autoModificationAllowed: false, policy: 'candidate_only_inspect_before_edit', reason: 'workspace_unavailable' };
  if (!existsSync(root)) return base;
  const suffixes = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.html', '.htm', '.ts', '.js', '.mjs', '.cjs', '.css', '.scss', '.sass', '.less']);
  const inside = (path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !/^\w:/.test(rel); };
  const candidate = (path: string, confidence: number, evidence: string[], line?: number, name?: string) => ({ path, relativePath: relative(root, path).replaceAll('\\', '/'), line: line || null, componentName: name || basename(path, extname(path)), kind: /\.(css|scss|sass|less)$/i.test(path) ? 'stylesheet' : 'component', confidence, confidenceBand: confidence >= 0.9 ? 'high' : confidence >= 0.5 ? 'medium' : 'low', evidence });
  const owners = (browser?.componentHints?.owners || []) as DesktopRecord[];
  for (const owner of owners.slice(0, 12)) {
    const source = String(owner.source?.file || ''); let path: string;
    try { const url = new URL(source); if (url.protocol === 'file:') path = fileURLToPath(url); else { const value = decodeURIComponent(url.pathname).replace(/^\/+/, ''); const marker = /(src|app|packages|components)\//.exec(value); path = resolve(root, marker ? value.slice(marker.index) : value); } } catch { path = resolve(root, source.split(/[?#]/)[0]); }
    if (source && inside(path) && existsSync(path) && suffixes.has(extname(path).toLowerCase())) base.candidates.push(candidate(path, 0.98, ['runtime_component_source'], owner.source?.line, owner.name));
  }
  if (base.candidates.length) return { ...base, state: 'resolved', reason: '', candidates: base.candidates.slice(0, 8) };
  const node = browser?.node || {}, attributes = node.attributes || {};
  const signals: [string, number][] = [[attributes['data-testid'], 0.34], [attributes['data-test'], 0.32], [node.id || attributes.id, 0.30], [node.accessibleName || attributes['aria-label'], 0.24], [node.text, 0.16], ...owners.map(owner => [owner.name, 0.34] as [string, number]), ...objects.flatMap(row => [[row.label, 0.22], [row.content, 0.18]] as [string, number][])].filter(row => typeof row[0] === 'string' && row[0].length >= 3 && row[0].length <= 240) as [string, number][];
  if (!signals.length) return { ...base, reason: 'component_link_not_applicable' };
  const ignored = new Set(['.git', '.hg', '.svn', '.idea', '.vscode', '.tmp', 'node_modules', '.agents', '.claude', '.codex', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', 'vendor', 'external', 'release', '__pycache__', 'data', 'artifacts']);
  const queue = [root]; let count = 0;
  while (queue.length && count < 2500) {
    const directory = queue.shift()!; let rows; try { rows = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const row of rows) {
      const path = join(directory, row.name); if (row.isDirectory()) { if (!ignored.has(row.name.toLowerCase()) && !/^\.tmp[-_]|^\.pytest[-_]/.test(row.name) && !existsSync(join(path, 'Local State'))) queue.push(path); continue; }
      if (!row.isFile() || !suffixes.has(extname(path).toLowerCase()) || ++count > 2500 || (await stat(path)).size > 512000) continue;
      const content = await readFile(path, 'utf8'), lower = content.toLowerCase(); const hits = signals.filter(([signal]) => lower.includes(signal.toLowerCase()));
      if (hits.length) { const first = lower.indexOf(hits[0][0].toLowerCase()); base.candidates.push(candidate(path, Math.min(0.89, hits.reduce((sum, row) => sum + row[1], 0)), hits.map(row => `literal:${row[0]}`), content.slice(0, first).split('\n').length)); }
    }
  }
  base.candidates.sort((a, b) => b.confidence - a.confidence);
  return { ...base, candidates: base.candidates.slice(0, 8), state: base.candidates.length ? 'candidates' : 'unavailable', reason: base.candidates.length ? 'inspect_candidates_before_edit' : 'no_source_match' };
}
