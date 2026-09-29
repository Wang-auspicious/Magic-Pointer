import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PersonalScreenCapture } from '../electron/personal_screen_capture';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mp-personal-screen-'));
  try {
    const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    let captures = 0, reads = 0;
    const samples: Array<Record<string, any>> = [];
    const recorder = new PersonalScreenCapture(directory, {
      capture: async () => { captures++; return { bytes: png, source: 'test-window', capturedAtUtc: new Date(100000).toISOString() }; },
      recognize: async () => { reads++; return { text: '报价 120 元', usedBackend: 'test-ocr' }; },
      save: async sample => { samples.push(sample); },
      foreground: async () => 42,
      minimumIntervalMs: 10000,
    });
    const foreground = { hwnd: 42, pid: 7, appId: 'editor.exe', label: 'Editor', title: '报价', bounds: [0, 0, 80, 40] as [number, number, number, number] };
    await recorder.observe({ at: 100000, foreground, idle: true, locked: false });
    assert.equal(captures, 0, 'idle computers must not keep taking screenshots');
    await recorder.observe({ at: 100000, foreground, idle: false, locked: false });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].text, '报价 120 元');
    assert.equal(samples[0].title, '报价');
    assert.equal(reads, 1);
    await recorder.observe({ at: 101000, foreground, idle: false, locked: false });
    assert.equal(captures, 1, 'burst activity must not trigger repeated captures');
    await recorder.observe({ at: 120000, foreground, idle: false, locked: false });
    assert.equal(reads, 1, 'unchanged pixels reuse existing searchable evidence instead of OCR');
    assert.equal(samples.length, 1);
    await recorder.observe({ at: 140000, foreground, idle: false, locked: true });
    assert.equal(captures, 2, 'locked sessions must not be captured');
    assert.equal((await readdir(directory)).length, 1);
    await recorder.stop();
    let front = 42;
    const switched = new PersonalScreenCapture(directory, {
      capture: async () => { front = 99; return { bytes: png, source: 'gdi-fallback', capturedAtUtc: new Date(180000).toISOString() }; },
      recognize: async () => { assert.fail('pixels from another foreground window must never be recognized as the old app'); },
      foreground: async () => front,
      save: async () => { assert.fail('a foreground switch must not enter personal memory'); },
    });
    await switched.observe({ at: 180000, foreground, idle: false, locked: false });
    await switched.stop();
    const declined = new PersonalScreenCapture(directory, {
      foreground: async () => 42,
      capture: async () => ({ bytes: png, source: 'test-window', capturedAtUtc: new Date(200000).toISOString() }),
      recognize: async () => ({ text: 'late recognition', usedBackend: 'test-ocr' }),
      save: async () => false,
    });
    await declined.observe({ at: 200000, foreground, idle: false, locked: false });
    assert.equal((await readdir(directory)).length, 1, 'turning off storage while OCR finishes must not leave an unindexed screenshot');
    await declined.stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
  console.log('personal screen capture behavior passed');
}
void main();
