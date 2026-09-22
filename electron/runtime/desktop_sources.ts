import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, extname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { DesktopRecord, Rect } from './desktop';
import { rectIntersection, type FrozenFrame } from './desktop_perception';

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
    const image = await sharp(frame.localArtifact.path).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const origin = frame.surfaceBoundsPx;
    const pixel = (x: number, y: number) => { const px = Math.round(x - origin[0]), py = Math.round(y - origin[1]); if (px < 0 || py < 0 || px >= image.info.width || py >= image.info.height) return undefined; const offset = (py * image.info.width + px) * image.info.channels; return [image.data[offset], image.data[offset + 1], image.data[offset + 2]]; };
    const highlighted = (x: number, y: number) => { const c = pixel(x, y); return !!c && c[2] > c[0] + 12 && c[2] > c[1] + 3 && c[2] > 100; };
    const visual: Rect[] = [];
    for (const row of data.rectangles as Rect[]) {
      const y = row[1] + row[3] * 0.65; const leftLimit = Math.max(pageRect[0], origin[0]), rightLimit = Math.min(pageRect[0] + pageRect[2], origin[2]);
      let first = -1, last = -1;
      for (let x = Math.max(leftLimit, row[0]); x < Math.min(rightLimit, row[0] + row[2]); x++) if (highlighted(x, y)) { if (first < 0) first = x; last = x; }
      if (first < 0) continue;
      let gap = 0; for (let x = first - 1; x >= leftLimit; x--) { if (highlighted(x, y)) { first = x; gap = 0; } else if (++gap > 3) break; }
      gap = 0; for (let x = last + 1; x < rightLimit; x++) { if (highlighted(x, y)) { last = x; gap = 0; } else if (++gap > 3) break; }
      visual.push([first, row[1], last - first + 1, row[3]]);
    }
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
    const text = selected.join('').trim(); const normalized = (value: string) => value.replace(/\s+/g, '').toLowerCase(); const original = normalized(String(data.text || ''));
    if (!text || original && !normalized(text).includes(original) && !original.includes(normalized(text))) return { ok: false, error: 'pdf_selection_uia_disagreement' };
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
