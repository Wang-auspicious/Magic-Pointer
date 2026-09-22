'use strict';


const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStashRuntime } = require('../electron/stash_runtime');

function fakeImage(seed, w = 800, h = 600) {
  const bitmap = Buffer.alloc(16 * 16 * 4, seed);
  return {
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: () => ({ toBitmap: () => bitmap }),
    toBitmap: () => bitmap,
    toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, seed]),
  };
}

function makeClipboard({ exposePng = true } = {}) {
  const state = {
    formats: [],
    image: null,
    text: '',
    writes: [],
    readImageCalls: 0,
    readBufferCalls: 0,
  };
  const clipboard = {
    state,
    availableFormats: () => state.formats.slice(),
    readImage: () => { state.readImageCalls += 1; return state.image || { isEmpty: () => true }; },
    readText: () => state.text,
    write: (payload) => {
      state.writes.push(payload);
      if (payload.text !== undefined) state.text = payload.text;
      if (payload.image !== undefined) state.image = payload.image;
    },
    putImage: (img) => { state.formats = ['image/png']; state.image = img; state.text = ''; },
  };
  if (exposePng) {
    clipboard.readBuffer = (format) => {
      state.readBufferCalls += 1;
      if (format !== 'image/png' || !state.image) return Buffer.alloc(0);
      return state.image.toPNG();
    };
  }
  return clipboard;
}

function runtimeWith(clipboard, baseDir) {
  return createStashRuntime({
    clipboard,
    baseDir,
    settings: () => ({ stash: { clipboard: true } }),
    focusProbe: async () => ({ app: 'Weixin', windowTitle: '微信', elementName: '' }),
  });
}

const POLL_WINDOW_MS = 2200;    

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-stash-detect-'));
}

function imagesCollected(rt) {
  return rt.list().flatMap((b) => b.items).filter((e) => e.media === 'image');
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  {
    const clip = makeClipboard();
    const rt = runtimeWith(clip, freshDir());
    rt.start();
    clip.putImage(fakeImage(41));
    await wait(POLL_WINDOW_MS);
    rt.stop();

    assert.strictEqual(imagesCollected(rt).length, 1, 'the bitmap must be collected exactly once');
    assert.ok(
      clip.state.readImageCalls <= 3,
      `an unchanged clipboard image must not be decoded per poll (readImage x${clip.state.readImageCalls})`,
    );
    assert.ok(
      clip.state.readBufferCalls > clip.state.readImageCalls,
      'the cheap signal must be consulted on every poll',
    );
  }

  {
    const clip = makeClipboard();
    const rt = runtimeWith(clip, freshDir());
    rt.start();
    clip.putImage(fakeImage(42));
    await wait(1200);
    clip.putImage(fakeImage(43));
    await wait(1500);
    rt.stop();

    assert.strictEqual(
      imagesCollected(rt).length,
      2,
      'a new bitmap must be collected even though the format list is identical',
    );
  }

  {
    const clip = makeClipboard({ exposePng: false });
    const rt = runtimeWith(clip, freshDir());
    rt.start();
    clip.putImage(fakeImage(44));
    await wait(1200);
    clip.putImage(fakeImage(45));
    await wait(1500);
    rt.stop();

    assert.strictEqual(
      imagesCollected(rt).length,
      2,
      'without the cheap signal the previous path must still collect both',
    );
    assert.ok(clip.state.readImageCalls >= 2, 'the fallback path still reads the image');
  }

  console.log('stash_clipboard_change_detector_test ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
