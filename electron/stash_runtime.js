'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./stash_store');

// 收藏箱的 IO 层：轮询剪贴板、落盘、把路径写回剪贴板、维护索引。
// 纯逻辑全在 stash_store.js，这里只做外部世界打交道的部分。

const POLL_MS = 700;          // 剪贴板没有变更事件，只能轮询；700ms 用户感觉是即时的
const SAMPLE = 16;            // 指纹用 16×16 缩略图，别对全图算哈希

function createStashRuntime(options = {}) {
  const {
    clipboard,
    nativeImage,
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
  let busy = false;

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

  async function ingest(image, kind = 'shot') {
    const bitmap = sampleImage(image);
    if (!bitmap) return null;

    const fingerprint = store.fingerprint(bitmap);
    if (fingerprint === lastFingerprint) return null;   // 剪贴板没变，直接退

    const focus = await focusProbe().catch(() => ({}));
    const previous = entries.length ? entries[entries.length - 1] : null;
    const result = store.buildEntry(
      {
        capturedAt: Date.now(),
        fingerprint,
        bitmap,
        kind,
        app: focus.app || '',
        windowTitle: focus.windowTitle || '',
        elementName: focus.elementName || '',
        elementPath: focus.elementPath || '',
        text: focus.selectionText || '',
      },
      previous,
      {
        burstWindowMs: settings()?.stash?.burst_window_ms,
        dedupeWindowMs: settings()?.stash?.dedupe_window_ms,
      },
    );

    lastFingerprint = fingerprint;
    if (result.skipped) {
      log(`stash skip ${result.reason}`);
      return null;
    }

    const abs = path.join(baseDir, result.entry.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, image.toPNG());

    entries.push(result.entry);
    persist();

    // 关键的一步：把本地路径写回剪贴板，同时保留位图。
    // 终端不收位图，Ctrl+V 拿到的就是路径；图片编辑器里粘贴仍然是图。
    if (settings()?.stash?.clipboard !== false) {
      const payload = store.clipboardPayload(abs);
      try {
        clipboard.write(payload.keepImage ? { image, text: payload.text } : { text: payload.text });
        lastFingerprint = fingerprint;   // 我们自己写回的，别当成新内容再收一遍
      } catch (error) {
        log(`stash clipboard write failed ${error.name}`);
      }
    }

    log(`stash + ${result.entry.kind} ${result.entry.relPath}`);
    onEntry(result.entry);
    return result.entry;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!clipboard.availableFormats().some((f) => f.startsWith('image/'))) return;
      const image = clipboard.readImage();
      if (image.isEmpty()) return;
      await ingest(image, 'shot');
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
    list() {
      if (!entries.length) load();
      return store.groupIntoBursts(entries).map((b) => ({
        ...b,
        items: b.items.map((e) => ({ ...e, absPath: path.join(baseDir, e.relPath) })),
      }));
    },
    ingest,
    baseDir,
  };
}

module.exports = { createStashRuntime, POLL_MS };
