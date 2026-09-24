import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { DesktopActionSession, markedObservationImage, patchesDiffer, type DesktopElement, type DesktopWindow } from '../electron/runtime/desktop';

const window: DesktopWindow = { hwnd: 7, pid: 3, title: 'Big', bbox: [100, 50, 3300, 1850], process_name: 'app.exe' };
const element = (index: number, rect: [number, number, number, number], role = 'button', patterns = ['Invoke']): DesktopElement => ({ index, hwnd: 7, name: `E${index}`, role, rect, runtime_id: [index], patterns });

test('large surfaces are downscaled and interactive elements are marked with their refs', async () => {
  const surface = await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const marked = await markedObservationImage(surface, window, [element(1, [100, 50, 3300, 1850], 'window', []), element(2, [300, 250, 500, 300]), element(3, [600, 250, 700, 300], 'text', [])]);
  const meta = await sharp(marked.bytes).metadata();
  assert.equal(meta.width, 1600);
  assert.equal(marked.scale, 0.5);
  assert.deepEqual(marked.marks.map(mark => mark.ref), ['@e2'], 'only actionable, non-root elements are drawn');
  assert.deepEqual(marked.marks[0].imageRect, [100, 100, 200, 125]);
});

test('image coordinates map back to physical screen pixels', async () => {
  const session = new DesktopActionSession('image-space');
  const surface = await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#ffffff' } }).png().toBuffer();
  Object.assign(session.observation, { windows: async () => [window], elements: async () => [] });
  const snapshot = await session.observe({ hwnd: 7, mode: 'ax' }, undefined, undefined, async () => ({ bytes: surface, width: 3200, height: 1800, source: 'test', capturedAtUtc: '' }));
  assert.ok(snapshot.surface, 'a window with no UIA elements is observed with pixels');
  assert.equal(snapshot.imageScale, 0.5);
  assert.deepEqual(session.toScreen(snapshot, { x: 800, y: 400, coordinate_space: 'image' }), { x: 1700, y: 850 });
  assert.deepEqual(session.toScreen(snapshot, { x: 800, y: 400 }), { x: 800, y: 400 });
});

test('a blinking caret does not make a click target stale, a changed region does', async () => {
  const base = Buffer.alloc(65 * 65 * 3, 255);
  const caret = Buffer.from(base); for (let y = 10; y < 30; y++) caret.fill(0, (y * 65 + 30) * 3, (y * 65 + 31) * 3);
  const dialog = Buffer.alloc(65 * 65 * 3, 40);
  assert.equal(patchesDiffer(base, caret, 3), false);
  assert.equal(patchesDiffer(base, dialog, 3), true);
});
