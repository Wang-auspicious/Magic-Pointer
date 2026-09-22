'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const store = require('./stash_store');
const { projectRoot } = require('./runtime_paths');

const ROOT = projectRoot(__dirname);

interface NativeImageLike {
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
  resize(options: { width: number; height: number; quality: string }): { toBitmap(): Buffer };
  toPNG(): Buffer;
}

interface ClipboardLike {
  availableFormats(): string[];
  readImage(): NativeImageLike;
  readText(): string;
  write(payload: { image?: NativeImageLike; text?: string }): void;
  readBuffer?(format: string): Buffer | null | undefined;
}

interface StashSettings {
  stash?: {
    burst_window_ms?: number;
    clipboard?: boolean;
    dedupe_window_ms?: number;
    text?: boolean;
    text_min_chars?: number;
  };
}

interface FocusInfo {
  app?: string;
  elementName?: string;
  elementPath?: string;
  selectionText?: string;
  windowTitle?: string;
}

interface RuntimeEntry {
  app: string;
  burstId: string;
  capturedAt: number;
  fingerprint: string | null;
  kind: string;
  locator?: Record<string, unknown> | null;
  media: 'clip' | 'text' | 'image' | 'file';
  originalArtifactPath?: string;
  relPath: string;
  sourceId?: string;
  sourceTimeMs?: number;
  summary?: string;
  userCategory?: string;
  [key: string]: unknown;
}

interface RuntimeBurst {
  [key: string]: unknown;
  items: RuntimeEntry[];
}

interface StashRuntimeOptions {
  baseDir: string;
  clipboard: ClipboardLike;
  focusProbe?: () => Promise<FocusInfo>;
  log?: (message: string) => void;
  onEntry?: (entry: RuntimeEntry) => void;
  runtimeExecutable?: string;
  userDataDir?: string;
  settings?: () => StashSettings;
}


const POLL_MS = 700;           
const SAMPLE = 16;             

function createStashRuntime(options: StashRuntimeOptions) {
  const {
    clipboard,
    baseDir,
    log = () => {},
    onEntry = () => {},
    focusProbe = async (): Promise<FocusInfo> => ({}),    
    settings = (): StashSettings => ({}),
    runtimeExecutable = process.execPath,
    userDataDir,
  } = options;

  const indexPath = path.join(baseDir, 'index.json');
  let entries: RuntimeEntry[] = [];
  let loaded = false;
  let timer: NodeJS.Timeout | null = null;
  let lastFingerprint: string | null = null;
  let lastTextFingerprint: string | null = null;
  let lastClipboardImageDigest: string | null = null;
  const ownPaths: string[] = [];
  let busy = false;

  function rememberOwnPath(absolutePath: string): void {
    ownPaths.push(absolutePath);
    if (ownPaths.length > 8) ownPaths.shift();
  }

  function load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      entries = Array.isArray(parsed) ? parsed as RuntimeEntry[] : [];
    } catch (_) {
      entries = [];
    }
    loaded = true;
    lastFingerprint = entries.length ? entries[entries.length - 1].fingerprint : null;
  }

  function ensureLoaded(): void {
    if (!loaded) load();
  }

  function persist(): void {
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 0), 'utf8');
    fs.renameSync(tmp, indexPath);
  }

  function clipboardImageDigest(): string | null {
    if (typeof clipboard.readBuffer !== 'function') return null;
    try {
      const buffer = clipboard.readBuffer('image/png');
      if (!buffer || !buffer.length) return null;
      return crypto.createHash('sha1').update(buffer).digest('hex');
    } catch (_) {
      return null;
    }
  }

  function sampleImage(image: NativeImageLike): { width: number; height: number; samples: number[] } | null {
    const size = image.getSize();
    if (!size.width || !size.height) return null;
    const small = image.resize({ width: SAMPLE, height: SAMPLE, quality: 'good' });
    const buf = small.toBitmap();
    const samples: number[] = [];
    for (let i = 0; i < buf.length; i += 4) samples.push(buf[i]);
    return { width: size.width, height: size.height, samples };
  }

  async function commit(
    input: Record<string, unknown> & { capturedAt: number },
    writeBytes: (absolutePath: string) => void,
  ): Promise<{ entry: RuntimeEntry; abs: string } | null> {
    ensureLoaded();
    const focus = await focusProbe().catch((): FocusInfo => ({}));
    const previous = entries.length ? entries[entries.length - 1] : null;
    const result = store.buildEntry(
      {
        ...input,
        app: input.app || focus.app || '',
        windowTitle: input.windowTitle || focus.windowTitle || '',
        elementName: input.elementName || focus.elementName || '',
        elementPath: input.elementPath || focus.elementPath || '',
        text: input.text || focus.selectionText || '',
      },
      previous,
      {
        burstWindowMs: settings()?.stash?.burst_window_ms,
        dedupeWindowMs: settings()?.stash?.dedupe_window_ms,
      },
    );

    if (result.skipped) {
      log(`stash skip ${result.reason}`);
      return null;
    }

    const abs = path.join(baseDir, result.entry.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeBytes(abs);

    entries.push(result.entry);
    persist();

    log(`stash + ${result.entry.media} ${result.entry.kind} ${result.entry.relPath} app=${result.entry.app || '—'}`);
    onEntry(result.entry);

    if (result.entry.media === 'image') {
      autoDescribeEntry(result.entry, abs);
    }

    return { entry: result.entry, abs };
  }

  let describeQueue: Promise<unknown> = Promise.resolve();
  function describeImage(absPath: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const child = spawn(runtimeExecutable, [path.join(ROOT, 'build', 'electron', 'runtime', 'worker.js'), 'stash_describe'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(userDataDir ? { MAGIC_POINTER_USER_DATA_DIR: userDataDir } : {}) },
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.stderr.on('data', () => {});
      child.on('error', () => resolve(null));
      child.on('close', () => {
        try {
          const parsed = JSON.parse(out);
          resolve(parsed?.ok ? parsed.summary : null);
        } catch (_) {
          resolve(null);
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ imagePath: absPath }));
    });
  }
  function autoDescribeEntry(entry: RuntimeEntry, abs: string): void {
    const run = () => describeImage(abs).then((summary) => {
      if (!summary) return;
      entry.summary = summary;
      persist();
      onEntry({ ...entry });
    }).catch(() => { /* 简介失败不影响收藏 */ });
    describeQueue = describeQueue.then(run);
  }

  async function ingest(
    image: NativeImageLike,
    kind = 'shot',
    metadata: Record<string, unknown> = {},
  ): Promise<RuntimeEntry | null> {
    const bitmap = sampleImage(image);
    if (!bitmap) return null;

    const fingerprint = store.fingerprint(bitmap);
    if (fingerprint === lastFingerprint) return null;    
    lastFingerprint = fingerprint;

    const committed = await commit(
      { ...metadata, capturedAt: Date.now(), fingerprint, bitmap, kind },
      (abs: string) => fs.writeFileSync(abs, image.toPNG()),
    );
    if (!committed) return null;

    if (settings()?.stash?.clipboard === true && store.writeBackAllowed(committed.entry.media)) {
      const payload = store.clipboardPayload(committed.abs);
      try {
        clipboard.write(payload.keepImage ? { image, text: payload.text } : { text: payload.text });
        lastFingerprint = fingerprint;    
        rememberOwnPath(committed.abs);
        lastTextFingerprint = store.textFingerprint(payload.text);
      } catch (error) {
        log(`stash clipboard write failed ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }

    return committed.entry;
  }

  async function ingestText(text: string): Promise<RuntimeEntry | null> {
    const fingerprint = store.textFingerprint(text);
    if (!fingerprint || fingerprint === lastTextFingerprint) return null;
    lastTextFingerprint = fingerprint;

    const verdict = store.shouldStashText(text, {
      minChars: settings()?.stash?.text_min_chars,
      ownPaths,
    });
    if (!verdict.ok) {
      log(`stash skip text ${verdict.reason}`);
      return null;
    }

    const committed = await commit(
      { capturedAt: Date.now(), fingerprint, kind: 'text', text },
      (abs: string) => fs.writeFileSync(abs, text, 'utf8'),
    );
    return committed ? committed.entry : null;
  }

  async function addText(input: string | Record<string, unknown>): Promise<RuntimeEntry | null> {
    const metadata = typeof input === 'string' ? {} : { ...input };
    const text = typeof input === 'string' ? input : String(input.text || '');
    if (!text.trim()) return null;
    const committed = await commit(
      {
        ...metadata,
        capturedAt: Number.isFinite(Number(metadata.capturedAt))
          ? Number(metadata.capturedAt)
          : Date.now(),
        fingerprint: store.textFingerprint(text),
        kind: 'text',
        media: 'text',
        text,
      },
      (abs: string) => fs.writeFileSync(abs, text, 'utf8'),
    );
    return committed ? committed.entry : null;
  }

  async function addFile(
    sourcePath: string,
    metadata: Record<string, unknown> = {},
  ): Promise<RuntimeEntry | null> {
    const originalArtifactPath = path.resolve(String(sourcePath || ''));
    let stats: { isFile(): boolean; size: number; mtimeMs: number };
    try {
      stats = fs.statSync(originalArtifactPath);
    } catch (_) {
      return null;
    }
    if (!stats.isFile()) return null;
    const extension = path.extname(originalArtifactPath).replace(/^\./, '').toLowerCase();
    const fingerprint = store.textFingerprint(
      `${originalArtifactPath}:${stats.size}:${Math.trunc(stats.mtimeMs)}`,
    );
    const committed = await commit(
      {
        ...metadata,
        capturedAt: Number.isFinite(Number(metadata.capturedAt))
          ? Number(metadata.capturedAt)
          : Date.now(),
        elementName: metadata.elementName || path.basename(originalArtifactPath),
        fileExtension: extension,
        fingerprint,
        kind: 'file',
        media: 'file',
        originalArtifactPath,
        sourceTimeMs: Number.isFinite(Number(metadata.sourceTimeMs))
          ? Number(metadata.sourceTimeMs)
          : Math.trunc(stats.mtimeMs),
      },
      (abs: string) => fs.copyFileSync(originalArtifactPath, abs),
    );
    return committed ? committed.entry : null;
  }

  function get(id: unknown): RuntimeEntry | null {
    ensureLoaded();
    const key = String(id || '').trim();
    const entry = entries.find((item) => item.id === key);
    return entry ? { ...entry } : null;
  }

  function search(
    query: unknown = '',
    searchOptions: { category?: unknown; limit?: unknown } = {},
  ): RuntimeEntry[] {
    ensureLoaded();
    const needle = String(query || '').trim().toLocaleLowerCase();
    const category = String(searchOptions.category || '').trim();
    const limit = Math.max(0, Math.min(200, Number(searchOptions.limit) || 50));
    return entries
      .filter((entry) => !category || entry.userCategory === category || entry.kind === category)
      .filter((entry) => {
        if (!needle) return true;
        return [
          entry.desc,
          entry.text,
          entry.summary,
          entry.userCategory,
          entry.app,
          entry.originalArtifactPath,
        ].some((value) => String(value || '').toLocaleLowerCase().includes(needle));
      })
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  function updateCategory(id: unknown, category: unknown): RuntimeEntry | null {
    ensureLoaded();
    const entry = entries.find((item) => item.id === String(id || '').trim());
    const value = String(category || '').trim().slice(0, 80);
    if (!entry || !value) return null;
    entry.userCategory = value;
    entry.kind = value;
    persist();
    onEntry({ ...entry });
    return { ...entry };
  }

  function remove(id: unknown): { ok: boolean; entry?: RuntimeEntry } {
    ensureLoaded();
    const index = entries.findIndex((item) => item.id === String(id || '').trim());
    if (index < 0) return { ok: false };
    const [entry] = entries.splice(index, 1);
    const root = path.resolve(baseDir);
    const artifactPath = path.resolve(baseDir, entry.relPath);
    if (artifactPath !== root && artifactPath.startsWith(root + path.sep)) {
      try {
        if (fs.statSync(artifactPath).isFile()) fs.unlinkSync(artifactPath);
      } catch (_) {
        // A missing derived artifact does not resurrect its index row.
      }
    }
    persist();
    return { ok: true, entry: { ...entry } };
  }

  async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const formats = clipboard.availableFormats();
      if (settings()?.stash?.clipboard === true && formats.some((f: string) => f.startsWith('image/'))) {
        const digest = clipboardImageDigest();
        if (digest !== null && digest === lastClipboardImageDigest) return;
        const image = clipboard.readImage();
        if (!image.isEmpty()) {
          await ingest(image, 'shot');
          lastClipboardImageDigest = clipboardImageDigest();
          return;
        }
      }
      if (settings()?.stash?.text === true && formats.some((f: string) => f.startsWith('text/'))) {
        await ingestText(clipboard.readText());
      }
    } catch (error) {
      log(`stash poll error ${error instanceof Error ? error.name : 'unknown'}`);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      load();
      try {
        const image = clipboard.readImage();
        if (!image.isEmpty()) lastFingerprint = store.fingerprint(sampleImage(image));
        lastTextFingerprint = store.textFingerprint(clipboard.readText());
        lastClipboardImageDigest = clipboardImageDigest();
      } catch (_) {
        // Clipboard access can fail while another application owns it; polling will retry.
      }
      timer = setInterval(tick, POLL_MS);
      if (timer.unref) timer.unref();
      log(`stash runtime started at ${baseDir}`);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    running() {
      return Boolean(timer);
    },
    list() {
      ensureLoaded();
      return store.groupIntoBursts(entries).map((b: RuntimeBurst) => ({
        ...b,
        items: b.items.map((e: RuntimeEntry) => ({ ...e, absPath: path.join(baseDir, e.relPath) })),
      }));
    },
    ingest,
    ingestText,
    addText,
    addFile,
    get,
    search,
    updateCategory,
    remove,
    baseDir,
  };
}

module.exports = { createStashRuntime, POLL_MS };
