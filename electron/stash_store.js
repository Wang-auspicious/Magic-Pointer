'use strict';

// 收藏箱的纯逻辑：指纹、去重、成簇、归类、落点。
// 这里不碰 clipboard、不碰 fs——IO 在 stash_runtime.js 里，方便单测。

const BURST_WINDOW_MS = 2 * 60 * 1000;   // 这个时间内、同一来源进来的算一簇
const DEDUPE_WINDOW_MS = 5 * 1000;       // 同一张图 5 秒内重复不再收
const MAX_DESC = 40;

// ---------------------------------------------------------------------------
// 指纹：不做全图哈希（很贵）。尺寸 + 16×16 缩略图的亮度采样就够区分了。
// 调用方给 { width, height, samples }，samples 是 0-255 的数组。
// ---------------------------------------------------------------------------
function fingerprint(bitmap) {
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

// ---------------------------------------------------------------------------
// 归类。判据按「证据强度」排序：结构化线索 > 来源应用 > 内容形态。
// 只在拿不到更强线索时才看文本。
// ---------------------------------------------------------------------------
const RECEIPT_RE = /(¥|\$|€|￥)\s?\d|订单号|流水号|发票|收据|报销|到期|有效期|\b\d{4}-\d{2}-\d{2}\b/;
const HANDOFF_APPS = /terminal|cmd|powershell|wezterm|alacritty|code\.exe|cursor|idea|pycharm|claude|codex/i;
const HANDOFF_RE = /Traceback|Error:|error\[|at .+\(.+:\d+\)|交接|handoff|\$ |PS [A-Z]:\\/;

function classify(input = {}) {
  const app = String(input.app || '');
  const text = String(input.text || '');
  const hasText = text.trim().length > 0;

  if (RECEIPT_RE.test(text)) return '凭证';
  if (HANDOFF_APPS.test(app) || HANDOFF_RE.test(text)) return '交接';
  if (input.kind === 'clip') return '片段';
  // 阈值按中文定：一个汉字的信息量抵好几个字母，12 太高会把「看这个卡的做法」误判成素材。
  if (!hasText || text.trim().length < 6) return '素材';
  return '灵感';
}

// 一句话描述。有 UIA 元素名就用它——比 OCR 猜准，也比截图文件名有意义。
function describe(input = {}) {
  const raw = (input.elementName || input.text || input.windowTitle || '').replace(/\s+/g, ' ').trim();
  if (!raw) return input.app ? `来自 ${input.app} 的一张图` : '一张图';
  return raw.length > MAX_DESC ? `${raw.slice(0, MAX_DESC - 1)}…` : raw;
}

// ---------------------------------------------------------------------------
// 成簇：与上一条时间差在窗口内、且来源应用相同，就归进同一簇。
// 「一起进来的放一起」= 一次连拍、一次连续复制。
// ---------------------------------------------------------------------------
function assignBurst(previous, entry, windowMs = BURST_WINDOW_MS) {
  if (!previous) return { burstId: `b${entry.capturedAt}`, isNew: true };
  const sameSource = (previous.app || '') === (entry.app || '');
  const withinWindow = entry.capturedAt - previous.capturedAt <= windowMs;
  if (sameSource && withinWindow) return { burstId: previous.burstId, isNew: false };
  return { burstId: `b${entry.capturedAt}`, isNew: true };
}

function shouldDedupe(previous, entry, windowMs = DEDUPE_WINDOW_MS) {
  if (!previous || !entry.fingerprint) return false;
  return previous.fingerprint === entry.fingerprint
    && entry.capturedAt - previous.capturedAt <= windowMs;
}

// ---------------------------------------------------------------------------
// 落点。按月分目录，文件名带时间戳与指纹短码——重名不可能，排序即时间序。
// ---------------------------------------------------------------------------
function relativePath(entry) {
  const d = new Date(entry.capturedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const short = (entry.fingerprint || 'x').split('-').pop().slice(0, 6);
  const ext = entry.kind === 'clip' ? 'gif' : 'png';
  return `${month}/${stamp}-${short}.${ext}`;
}

// ---------------------------------------------------------------------------
// 一条采集从原始输入到可落盘记录的全部推导。
// ---------------------------------------------------------------------------
function buildEntry(input, previous, options = {}) {
  const capturedAt = input.capturedAt;
  const fp = input.fingerprint || fingerprint(input.bitmap);
  const draft = { ...input, capturedAt, fingerprint: fp };

  if (shouldDedupe(previous, draft, options.dedupeWindowMs)) {
    return { skipped: true, reason: 'duplicate' };
  }

  const burst = assignBurst(previous, draft, options.burstWindowMs);
  const kind = input.kind === 'clip' ? '片段' : classify(input);

  return {
    skipped: false,
    entry: {
      id: `s${capturedAt}-${(fp || 'x').split('-').pop().slice(0, 4)}`,
      capturedAt,
      fingerprint: fp,
      burstId: burst.burstId,
      burstIsNew: burst.isNew,
      kind,
      desc: describe(input),
      app: input.app || '',
      windowTitle: input.windowTitle || '',
      elementPath: input.elementPath || '',
      text: input.text || '',
      width: input.bitmap?.width || 0,
      height: input.bitmap?.height || 0,
      relPath: relativePath({ capturedAt, fingerprint: fp, kind: input.kind }),
    },
  };
}

// ---------------------------------------------------------------------------
// 剪贴板回写：落盘后剪贴板里同时放「图」和「本地路径」。
// 终端里 Ctrl+V 拿到的是路径（终端不收位图），图片编辑器里粘贴仍是图。
// 这是这个功能真正省事的地方，别漏。
// ---------------------------------------------------------------------------
function clipboardPayload(absolutePath, options = {}) {
  const quote = options.quotePaths !== false && /\s/.test(absolutePath);
  return {
    text: quote ? `"${absolutePath}"` : absolutePath,
    keepImage: options.keepImage !== false,
  };
}

// 把平铺的条目折成画布用的簇。
function groupIntoBursts(entries = []) {
  const order = [];
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.burstId)) {
      map.set(e.burstId, { id: e.burstId, app: e.app, kind: e.kind, capturedAt: e.capturedAt, items: [] });
      order.push(e.burstId);
    }
    map.get(e.burstId).items.push(e);
  }
  return order.map((id) => map.get(id));
}

module.exports = {
  BURST_WINDOW_MS,
  DEDUPE_WINDOW_MS,
  fingerprint,
  classify,
  describe,
  assignBurst,
  shouldDedupe,
  relativePath,
  buildEntry,
  clipboardPayload,
  groupIntoBursts,
};
