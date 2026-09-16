'use strict';

// C-073 / audit F26.
//
// The stash poll runs every 700 ms and is gated on `stash.clipboard`. The real
// defect is narrower than "it polls": the fingerprint check happened *after*
// `clipboard.readImage()` and `sampleImage()`'s native resize, so an unchanged
// clipboard image was fully decoded — a 4K screenshot is ~33 MB of raw bitmap
// plus a native resample — ~1.4 times a second, forever. The app itself writes
// the bitmap back on every capture, so the clipboard holds an image from the
// first screenshot onwards.
//
// The detector added before the decode is the PNG bytes on the clipboard
// (`clipboard.readBuffer('image/png')`, hashed). These assertions pin:
//   1. an unchanged clipboard image is read for a fingerprint exactly once;
//   2. a genuinely changed image is still detected and still ingested;
//   3. a clipboard without that format degrades to the old path (no reordering
//      of correctness, just no optimisation).

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

/**
 * A clipboard whose encoded PNG bytes are distinct per image, with counters on
 * the two expensive calls.
 */
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

const POLL_WINDOW_MS = 2200;   // 3+ polls at the 700 ms cadence

// Each case gets its own stash directory: `list()` reads the index that the
// previous case wrote otherwise.
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-stash-detect-'));
}

// `start()` deliberately snapshots whatever is already on the clipboard so a
// copy made before launch is not collected. Every case below therefore starts
// with an empty clipboard and puts the image in afterwards.
function imagesCollected(rt) {
  return rt.list().flatMap((b) => b.items).filter((e) => e.media === 'image');
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  // ---- 1. an unchanged clipboard image is not decoded again ----------------
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

  // ---- 2. a genuinely different image is still noticed ---------------------
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

  // ---- 3. no PNG format on the clipboard: old behaviour, not wrong behaviour
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
