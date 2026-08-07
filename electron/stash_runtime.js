'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('./stash_store');

const ROOT = path.resolve(__dirname, '..');

// 收藏箱的 IO 层：轮询剪贴板、落盘、把路径写回剪贴板、维护索引。
// 纯逻辑全在 stash_store.js，这里只做外部世界打交道的部分。

const POLL_MS = 700;          // 剪贴板没有变更事件，只能轮询；700ms 用户感觉是即时的
const SAMPLE = 16;            // 指纹用 16×16 缩略图，别对全图算哈希

function createStashRuntime(options = {}) {
  const {
    clipboard,
    baseDir,
    log = () => {},
    onEntry = () => {},
    focusProbe = async () => ({}),   // 由主进程给：当前前台窗口的进程名/标题/UIA 元素
    settings = () => ({}),
  } = options;

  const indexPath = path.join(baseDir, 'index.json');
  let entries = [];
  let timer = null;
  let lastFingerprint = null;
  let lastTextFingerprint = null;
  // 我们自己回写进剪贴板的路径。下一轮轮询会原样读到它们，
  // 不记住就会把每一次回写都当成一条新的文本采集收进来。
  const ownPaths = [];
  let busy = false;

  function rememberOwnPath(absolutePath) {
    ownPaths.push(absolutePath);
    if (ownPaths.length > 8) ownPaths.shift();
  }

  function load() {
    try {
      entries = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!Array.isArray(entries)) entries = [];
    } catch (_) {
      entries = [];
    }
    lastFingerprint = entries.length ? entries[entries.length - 1].fingerprint : null;
  }

  function persist() {
    fs.mkdirSync(baseDir, { recursive: true });
    // 先写临时文件再改名：轮询中途崩掉不会留下半截 JSON
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 0), 'utf8');
    fs.renameSync(tmp, indexPath);
  }

  // 便宜的指纹：缩到 16×16 再取每个像素的一个通道
  function sampleImage(image) {
    const size = image.getSize();
    if (!size.width || !size.height) return null;
    const small = image.resize({ width: SAMPLE, height: SAMPLE, quality: 'good' });
    const buf = small.toBitmap();
    const samples = [];
    for (let i = 0; i < buf.length; i += 4) samples.push(buf[i]);
    return { width: size.width, height: size.height, samples };
  }

  // 图和文本共用这一段：拿来源、建条目、落盘、更新索引。
  // 差别只有两处——写什么字节，以及要不要回写剪贴板。
  async function commit(input, writeBytes) {
    const focus = await focusProbe().catch(() => ({}));
    const previous = entries.length ? entries[entries.length - 1] : null;
    const result = store.buildEntry(
      {
        ...input,
        app: input.app || focus.app || '',
        windowTitle: focus.windowTitle || '',
        elementName: focus.elementName || '',
        elementPath: focus.elementPath || '',
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

    // 截图入库即自动出简介（不等待 hover）：后台调视觉模型给 3-4 句，
    // 写回条目并通知界面。失败不影响入库——条目没有简介也能看缩略图。
    if (result.entry.media === 'image') {
      autoDescribeEntry(result.entry, abs);
    }

    return { entry: result.entry, abs };
  }

  // 入库后异步生成图片简介，写回条目并推送界面更新。
  // 队列串行：一次收十几张图时不会同时打十几个模型请求。
  let describeQueue = Promise.resolve();
  function describeImage(absPath) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'stash_describe_bridge.py')], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
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
      child.stdin.end(JSON.stringify({ imagePath: absPath }));
    });
  }
  function autoDescribeEntry(entry, abs) {
    const run = () => describeImage(abs).then((summary) => {
      if (!summary) return;
      entry.summary = summary;
      persist();
      onEntry({ ...entry });
    }).catch(() => { /* 简介失败不影响收藏 */ });
    describeQueue = describeQueue.then(run);
  }

  async function ingest(image, kind = 'shot') {
    const bitmap = sampleImage(image);
    if (!bitmap) return null;

    const fingerprint = store.fingerprint(bitmap);
    if (fingerprint === lastFingerprint) return null;   // 剪贴板没变，直接退
    lastFingerprint = fingerprint;

    const committed = await commit(
      { capturedAt: Date.now(), fingerprint, bitmap, kind },
      (abs) => fs.writeFileSync(abs, image.toPNG()),
    );
    if (!committed) return null;

    // 关键的一步：把本地路径写回剪贴板，同时保留位图。
    // 终端不收位图，Ctrl+V 拿到的就是路径；图片编辑器里粘贴仍然是图。
    // 只对位图这么做——对文本回写会盖掉用户刚复制的那段字。
    if (settings()?.stash?.clipboard !== false && store.writeBackAllowed(committed.entry.media)) {
      const payload = store.clipboardPayload(committed.abs);
      try {
        clipboard.write(payload.keepImage ? { image, text: payload.text } : { text: payload.text });
        lastFingerprint = fingerprint;   // 我们自己写回的，别当成新内容再收一遍
        rememberOwnPath(committed.abs);
        lastTextFingerprint = store.textFingerprint(payload.text);
      } catch (error) {
        log(`stash clipboard write failed ${error.name}`);
      }
    }

    return committed.entry;
  }

  // 文本采集。默认关——图片是用户明确截下来的，文本不是：
  // 每一次 Ctrl+C 都会经过这里，包括密码管理器里的那一次。
  async function ingestText(text) {
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
      (abs) => fs.writeFileSync(abs, text, 'utf8'),
    );
    return committed ? committed.entry : null;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const formats = clipboard.availableFormats();
      // 位图优先：我们自己回写之后剪贴板里图和文本同时存在，
      // 先看图才不会把那条路径当成一段值得收藏的文字。
      if (formats.some((f) => f.startsWith('image/'))) {
        const image = clipboard.readImage();
        if (!image.isEmpty()) {
          await ingest(image, 'shot');
          return;
        }
      }
      if (settings()?.stash?.text === true && formats.some((f) => f.startsWith('text/'))) {
        await ingestText(clipboard.readText());
      }
    } catch (error) {
      log(`stash poll error ${error.name}`);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      load();
      // 启动时先记下当前剪贴板，避免把用户开机前复制的东西当成新采集
      try {
        const image = clipboard.readImage();
        if (!image.isEmpty()) lastFingerprint = store.fingerprint(sampleImage(image));
        lastTextFingerprint = store.textFingerprint(clipboard.readText());
      } catch (_) {}
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
      if (!entries.length) load();
      return store.groupIntoBursts(entries).map((b) => ({
        ...b,
        items: b.items.map((e) => ({ ...e, absPath: path.join(baseDir, e.relPath) })),
      }));
    },
    ingest,
    ingestText,
    baseDir,
  };
}

module.exports = { createStashRuntime, POLL_MS };
