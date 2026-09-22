'use strict';

type StashMedia = 'clip' | 'text' | 'image' | 'file';

interface BitmapSample {
  width: number;
  height: number;
  samples?: number[];
}

interface StashInput {
  app?: string;
  bitmap?: BitmapSample | null;
  capturedAt?: number;
  elementName?: string;
  elementPath?: string;
  fingerprint?: string | null;
  fileExtension?: string;
  kind?: string;
  locator?: Record<string, unknown> | null;
  media?: StashMedia;
  originalArtifactPath?: string;
  samples?: number[];
  sourceId?: string;
  sourceTimeMs?: number;
  summary?: string;
  text?: string;
  userCategory?: string;
  windowTitle?: string;
}

interface StashEntry extends StashInput {
  app: string;
  burstId: string;
  burstIsNew?: boolean;
  capturedAt: number;
  desc?: string;
  fingerprint: string | null;
  height?: number;
  id?: string;
  kind: string;
  media: StashMedia;
  relPath: string;
  samples: number[];
  text: string;
  width?: number;
}

interface StashBuildOptions {
  burstWindowMs?: number;
  dedupeWindowMs?: number;
}


const BURST_WINDOW_MS = 2 * 60 * 1000;    
const DEDUPE_WINDOW_MS = 5 * 1000;        
const MAX_DESC = 40;

function fingerprint(bitmap: BitmapSample | null | undefined): string | null {
  if (!bitmap || !bitmap.width || !bitmap.height) return null;
  const samples = Array.isArray(bitmap.samples) ? bitmap.samples : [];
  let h = 2166136261;
  h = Math.imul(h ^ bitmap.width, 16777619);
  h = Math.imul(h ^ bitmap.height, 16777619);
  for (let i = 0; i < samples.length; i += 1) {
    h = Math.imul(h ^ (samples[i] & 0xff), 16777619);
  }
  return `${bitmap.width}x${bitmap.height}-${(h >>> 0).toString(36)}`;
}

function textFingerprint(text: unknown): string | null {
  const value = String(text || '');
  if (!value) return null;
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return `t${value.length}-${(h >>> 0).toString(36)}`;
}

const RECEIPT_RE = /(¥|\$|€|￥)\s?\d|订单号|流水号|发票|收据|报销|到期|有效期|\b\d{4}-\d{2}-\d{2}\b/;
const HANDOFF_APPS = /terminal|conhost|\bcmd\b|powershell|pwsh|wezterm|alacritty|kitty|\bcode\b|codium|cursor|idea|pycharm|goland|webstorm|claude|codex/i;
const HANDOFF_RE = /Traceback|Error:|error\[|at .+\(.+:\d+\)|交接|handoff|\$ |PS [A-Z]:\\/;

function classify(input: StashInput = {}): string {
  const app = String(input.app || '');
  const text = String(input.text || '');
  const label = String(input.elementName || input.windowTitle || '');
  const combined = `${text}\n${label}`;
  const hasText = text.trim().length > 0;

  if (RECEIPT_RE.test(combined)) return '凭证';
  if (HANDOFF_APPS.test(app) || HANDOFF_RE.test(combined)) return '交接';
  if (input.kind === 'clip') return '片段';
  if (!hasText && !label.trim()) return '素材';
  if (!hasText) return '灵感';
  if (text.trim().length < 6) return '素材';
  return '灵感';
}

const TRANSIENT_SHELLS = /^(screenclippinghost|snippingtool|screensketch|magic ?pointer|electron|shellexperiencehost|searchhost|startmenuexperiencehost|textinputhost|lockapp|applicationframehost|dwm|explorer)$/i;

function isTransientShell(processName: unknown): boolean {
  const name = String(processName || '').trim().replace(/\.exe$/i, '');
  if (!name) return true;
  return TRANSIENT_SHELLS.test(name);
}

const SECRET_RE = new RegExp([
  '-----BEGIN [A-Z ]*PRIVATE KEY',
  '\\bsk-[A-Za-z0-9_-]{16,}',
  '\\bgh[pousr]_[A-Za-z0-9]{16,}',
  '\\bAKIA[0-9A-Z]{12,}',
  '\\bxox[baprs]-[A-Za-z0-9-]{10,}',
  '\\bey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.',       
  '(password|passwd|密码|口令|verification code|验证码)\\s*[:：=]',
].join('|'), 'i');

function looksLikeSecret(text: unknown): boolean {
  return SECRET_RE.test(String(text || ''));
}

function looksLikeOneShotToken(text: unknown): boolean {
  const t = String(text || '').trim();
  if (/[\\/]/.test(t)) return false;
  return t.length <= 40 && !/\s/.test(t) && /[0-9]/.test(t) && /[A-Za-z]/.test(t);
}

function shouldStashText(text: unknown, options: { minChars?: number; ownPaths?: string[] } = {}) {
  const value = String(text || '');
  const trimmed = value.trim();
  const minChars = typeof options.minChars === 'number' && Number.isFinite(options.minChars)
    ? options.minChars
    : 12;
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (looksLikeSecret(trimmed)) return { ok: false, reason: 'secret' };
  if (options.ownPaths && options.ownPaths.some((p) => trimmed === p || trimmed === `"${p}"`)) {
    return { ok: false, reason: 'own_writeback' };
  }
  if (trimmed.length < minChars) return { ok: false, reason: 'too_short' };
  if (looksLikeOneShotToken(trimmed)) return { ok: false, reason: 'one_shot_token' };
  return { ok: true, reason: '' };
}

function writeBackAllowed(media: unknown): boolean {
  return media !== 'text';
}

function describe(input: StashInput = {}): string {
  const raw = (input.elementName || input.text || input.windowTitle || '').replace(/\s+/g, ' ').trim();
  if (!raw) return input.app ? `来自 ${input.app} 的一张图` : '一张图';
  return raw.length > MAX_DESC ? `${raw.slice(0, MAX_DESC - 1)}…` : raw;
}

function assignBurst(
  previous: StashEntry | null,
  entry: StashInput & { capturedAt: number },
  windowMs = BURST_WINDOW_MS,
  _similarity = 0.72,
): { burstId: string; isNew: boolean } {
  if (!previous) return { burstId: `b${entry.capturedAt}`, isNew: true };
  const sameSource = (previous.app || '') === (entry.app || '');
  if (!sameSource) return { burstId: `b${entry.capturedAt}`, isNew: true };

  const withinWindow = entry.capturedAt - previous.capturedAt <= windowMs;
  if (withinWindow) return { burstId: previous.burstId, isNew: false };

  const gapMinutes = (entry.capturedAt - previous.capturedAt) / 60000;
  const base = (previous.media || mediaOf(previous.kind || '')) === 'text' ? 0.5 : 0.72;
  const threshold = Math.min(0.95, base + gapMinutes * 0.02);
  if (contentSimilarity(previous, entry) >= threshold) {
    return { burstId: previous.burstId, isNew: false };
  }
  return { burstId: `b${entry.capturedAt}`, isNew: true };
}

function contentSimilarity(a: StashInput | null, b: StashInput | null): number {
  if (!a || !b) return 0;
  const mediaA = a.media || mediaOf(a.kind || '');
  const mediaB = b.media || mediaOf(b.kind || '');
  if (mediaA !== mediaB) return 0;

  if (mediaA === 'text') {
    const ta = String(a.text || '');
    const tb = String(b.text || '');
    if (!ta || !tb) return 0;
    const wa = new Set(ta.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const wb = new Set(tb.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    if (!wa.size || !wb.size) return 0;
    let overlap = 0;
    for (const w of wa) if (wb.has(w)) overlap += 1;
    return overlap / Math.min(wa.size, wb.size);
  }

  const sa = a.samples;
  const sb = b.samples;
  if (!sa || !sb || !sa.length || !sb.length) return 0;
  if (sa.length !== sb.length) return 0;
  let diff = 0;
  for (let i = 0; i < sa.length; i += 1) {
    diff += Math.abs(sa[i] - sb[i]);
  }
  const avgDiff = diff / sa.length / 255;
  return Math.max(0, 1 - avgDiff);
}

function shouldDedupe(
  previous: Pick<StashEntry, 'capturedAt' | 'fingerprint'> | null,
  entry: StashInput & { capturedAt: number },
  windowMs = DEDUPE_WINDOW_MS,
): boolean {
  if (!previous || !entry.fingerprint) return false;
  return previous.fingerprint === entry.fingerprint
    && entry.capturedAt - previous.capturedAt <= windowMs;
}

const EXT_BY_MEDIA = { clip: 'gif', text: 'txt', image: 'png', file: 'bin' };

function mediaOf(kind: string): StashMedia {
  if (kind === 'clip') return 'clip';
  if (kind === 'text') return 'text';
  if (kind === 'file') return 'file';
  return 'image';
}

function relativePath(entry: { capturedAt: number; fingerprint?: string | null; kind?: string; media?: StashMedia; fileExtension?: string }): string {
  const d = new Date(entry.capturedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const short = (entry.fingerprint || 'x').split('-').pop()!.slice(0, 6);
  const requestedExtension = String(entry.fileExtension || '').trim().replace(/^\./, '').toLowerCase();
  const safeExtension = /^[a-z0-9]{1,12}$/.test(requestedExtension) ? requestedExtension : '';
  const ext = entry.media === 'file' && safeExtension
    ? safeExtension
    : EXT_BY_MEDIA[entry.media || mediaOf(entry.kind || '')] || 'png';
  return `${month}/${stamp}-${short}.${ext}`;
}

function buildEntry(
  input: StashInput & { capturedAt: number },
  previous: StashEntry | null,
  options: StashBuildOptions = {},
): { skipped: true; reason: string } | { skipped: false; entry: StashEntry } {
  const capturedAt = input.capturedAt;
  const media = input.media || mediaOf(input.kind || '');
  const fp = input.fingerprint
    || (media === 'text' ? textFingerprint(input.text) : fingerprint(input.bitmap));
  const draft = { ...input, capturedAt, fingerprint: fp };

  if (shouldDedupe(previous, draft, options.dedupeWindowMs)) {
    return { skipped: true, reason: 'duplicate' };
  }

  const burst = assignBurst(previous, draft, options.burstWindowMs);
  const userCategory = String(input.userCategory || '').trim().slice(0, 80);
  const kind = userCategory || (input.kind === 'clip' ? '片段' : classify(input));

  return {
    skipped: false,
    entry: {
      id: `s${capturedAt}-${(fp || 'x').split('-').pop()!.slice(0, 4)}`,
      capturedAt,
      fingerprint: fp,
      burstId: burst.burstId,
      burstIsNew: burst.isNew,
      media,
      kind,
      locator: input.locator && typeof input.locator === 'object'
        ? structuredClone(input.locator)
        : null,
      originalArtifactPath: String(input.originalArtifactPath || ''),
      sourceId: String(input.sourceId || ''),
      sourceTimeMs: Number.isFinite(Number(input.sourceTimeMs))
        ? Number(input.sourceTimeMs)
        : capturedAt,
      summary: String(input.summary || '').trim().slice(0, 2000),
      userCategory,
      desc: describe(input),
      app: input.app || '',
      windowTitle: input.windowTitle || '',
      elementPath: input.elementPath || '',
      text: input.text || '',
      width: input.bitmap?.width || 0,
      height: input.bitmap?.height || 0,
      samples: Array.isArray(input.samples) ? input.samples.slice(0, 512) : [],
      relPath: relativePath({
        capturedAt,
        fingerprint: fp,
        media,
        fileExtension: input.fileExtension,
      }),
    },
  };
}

function clipboardPayload(
  absolutePath: string,
  options: { keepImage?: boolean; quotePaths?: boolean } = {},
): { text: string; keepImage: boolean } {
  const quote = options.quotePaths !== false && /\s/.test(absolutePath);
  return {
    text: quote ? `"${absolutePath}"` : absolutePath,
    keepImage: options.keepImage !== false,
  };
}

function groupIntoBursts(entries: StashEntry[] = []) {
  const order: string[] = [];
  const map = new Map<string, { id: string; app: string; kind: string; capturedAt: number; items: StashEntry[] }>();
  for (const e of entries) {
    if (!map.has(e.burstId)) {
      map.set(e.burstId, { id: e.burstId, app: e.app, kind: e.kind, capturedAt: e.capturedAt, items: [] });
      order.push(e.burstId);
    }
    map.get(e.burstId)!.items.push(e);
  }
  return order.map((id) => map.get(id)!);
}

module.exports = {
  BURST_WINDOW_MS,
  DEDUPE_WINDOW_MS,
  fingerprint,
  textFingerprint,
  classify,
  describe,
  assignBurst,
  contentSimilarity,
  shouldDedupe,
  relativePath,
  mediaOf,
  buildEntry,
  clipboardPayload,
  writeBackAllowed,
  isTransientShell,
  looksLikeSecret,
  shouldStashText,
  groupIntoBursts,
};
