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
// 文本指纹。图片走 sampleImage，文本没有像素可采，直接对内容做 FNV。
// 前缀带长度，这样不同长度的文本永远不会撞（也方便一眼看出是文本条目）。
// ---------------------------------------------------------------------------
function textFingerprint(text) {
  const value = String(text || '');
  if (!value) return null;
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return `t${value.length}-${(h >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// 归类。判据按「证据强度」排序：结构化线索 > 来源应用 > 内容形态。
// 只在拿不到更强线索时才看文本。
// ---------------------------------------------------------------------------
const RECEIPT_RE = /(¥|\$|€|￥)\s?\d|订单号|流水号|发票|收据|报销|到期|有效期|\b\d{4}-\d{2}-\d{2}\b/;
// 前台探针给的是进程名，不带 .exe（`Code`、`WindowsTerminal`、`Weixin`）。
// 原来写成 `code\.exe` 时它永远匹配不上真实输入——这条判据一直是死的。
const HANDOFF_APPS = /terminal|conhost|\bcmd\b|powershell|pwsh|wezterm|alacritty|kitty|\bcode\b|codium|cursor|idea|pycharm|goland|webstorm|claude|codex/i;
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

// ---------------------------------------------------------------------------
// 来源应用。前台探针给的是「此刻」的前台进程，而截图工具、我们自己的浮层
// 都会在用户按下快捷键的那一瞬间抢走前台——照抄就会把每一张截图的来源
// 都记成 ScreenClippingHost。这些外壳一律不算来源：宁可留空，也不能记错。
// ---------------------------------------------------------------------------
const TRANSIENT_SHELLS = /^(screenclippinghost|snippingtool|screensketch|magic ?pointer|electron|shellexperiencehost|searchhost|startmenuexperiencehost|textinputhost|lockapp|applicationframehost|dwm|explorer)$/i;

function isTransientShell(processName) {
  const name = String(processName || '').trim().replace(/\.exe$/i, '');
  if (!name) return true;
  return TRANSIENT_SHELLS.test(name);
}

// ---------------------------------------------------------------------------
// 文本准入。图片是用户明确截下来的，文本不是——每一次 Ctrl+C 都会经过这里，
// 包括密码管理器里复制出来的那一次。所以文本要过一道明确的门槛，
// 而不是照单全收。判据只看内容形态，不做熵估计（会误伤正常的长 token）。
// ---------------------------------------------------------------------------
const SECRET_RE = new RegExp([
  '-----BEGIN [A-Z ]*PRIVATE KEY',
  '\\bsk-[A-Za-z0-9_-]{16,}',
  '\\bgh[pousr]_[A-Za-z0-9]{16,}',
  '\\bAKIA[0-9A-Z]{12,}',
  '\\bxox[baprs]-[A-Za-z0-9-]{10,}',
  '\\bey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.',      // JWT
  '(password|passwd|密码|口令|verification code|验证码)\\s*[:：=]',
].join('|'), 'i');

function looksLikeSecret(text) {
  return SECRET_RE.test(String(text || ''));
}

// 一行 40 个字符以内、没有空格的东西大概率是一个 token 或一次性口令，
// 用户复制它是为了立刻粘贴，不是为了收藏。路径和网址不算——它们同样没有
// 空格，但明显是内容。
function looksLikeOneShotToken(text) {
  const t = String(text || '').trim();
  if (/[\\/]/.test(t)) return false;
  return t.length <= 40 && !/\s/.test(t) && /[0-9]/.test(t) && /[A-Za-z]/.test(t);
}

function shouldStashText(text, options = {}) {
  const value = String(text || '');
  const trimmed = value.trim();
  const minChars = Number.isFinite(options.minChars) ? options.minChars : 12;
  if (!trimmed) return { ok: false, reason: 'empty' };
  // 机密判据必须排在长度之前。一个六位验证码本来就很短，靠「太短」把它挡下来
  // 是运气不是规则——哪天把门槛调低，它就直接落盘了。
  if (looksLikeSecret(trimmed)) return { ok: false, reason: 'secret' };
  // 我们自己刚写回剪贴板的那条路径，不能再当成一条新采集收进来。
  // 这是一次等值判断，排在所有启发式之前，理由才不会被猜出来的那条盖掉。
  if (options.ownPaths && options.ownPaths.some((p) => trimmed === p || trimmed === `"${p}"`)) {
    return { ok: false, reason: 'own_writeback' };
  }
  if (trimmed.length < minChars) return { ok: false, reason: 'too_short' };
  if (looksLikeOneShotToken(trimmed)) return { ok: false, reason: 'one_shot_token' };
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------
// 回写剪贴板只对位图成立。对文本回写会覆盖用户刚复制的那段字，
// 让接下来的 Ctrl+V 粘出一个文件路径——那是在毁掉他正要做的事。
// ---------------------------------------------------------------------------
function writeBackAllowed(media) {
  return media !== 'text';
}

// ---------------------------------------------------------------------------
// 一句话描述。有 UIA 元素名就用它——比 OCR 猜准，也比截图文件名有意义。
// ---------------------------------------------------------------------------
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
// 后缀跟着载体走：文本发 .png 会得到一个打不开的文件。
// ---------------------------------------------------------------------------
const EXT_BY_MEDIA = { clip: 'gif', text: 'txt', image: 'png' };

function mediaOf(kind) {
  if (kind === 'clip') return 'clip';
  if (kind === 'text') return 'text';
  return 'image';
}

function relativePath(entry) {
  const d = new Date(entry.capturedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const short = (entry.fingerprint || 'x').split('-').pop().slice(0, 6);
  const ext = EXT_BY_MEDIA[entry.media || mediaOf(entry.kind)] || 'png';
  return `${month}/${stamp}-${short}.${ext}`;
}

// ---------------------------------------------------------------------------
// 一条采集从原始输入到可落盘记录的全部推导。
// input.kind 是载体（shot / clip / text），entry.kind 是归类（灵感 / 凭证 …）。
// 两者不是一回事，别混。
// ---------------------------------------------------------------------------
function buildEntry(input, previous, options = {}) {
  const capturedAt = input.capturedAt;
  const media = mediaOf(input.kind);
  const fp = input.fingerprint
    || (media === 'text' ? textFingerprint(input.text) : fingerprint(input.bitmap));
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
      media,
      kind,
      desc: describe(input),
      app: input.app || '',
      windowTitle: input.windowTitle || '',
      elementPath: input.elementPath || '',
      text: input.text || '',
      width: input.bitmap?.width || 0,
      height: input.bitmap?.height || 0,
      relPath: relativePath({ capturedAt, fingerprint: fp, media }),
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
  textFingerprint,
  classify,
  describe,
  assignBurst,
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
