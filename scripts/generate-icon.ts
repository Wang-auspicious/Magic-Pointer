import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const sizes = [16, 24, 32, 48, 64, 128, 256];
const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 256 256"><defs><linearGradient id="pointer" x1="0" y1="44" x2="0" y2="188" gradientUnits="userSpaceOnUse"><stop stop-color="#39b8ff"/><stop offset="1" stop-color="#b144f4"/></linearGradient></defs><path d="M37 190C56 159 78 136 109 116" fill="none" stroke="#6366f1" stroke-opacity=".529" stroke-width="15"/><path d="M37 190C56 159 78 136 109 116" fill="none" stroke="#2ed7ff" stroke-opacity=".588" stroke-width="8"/><circle cx="36" cy="191" r="8" fill="#2ed7ff" fill-opacity=".478"/><circle cx="63" cy="157" r="7" fill="#55a6ff" fill-opacity=".722"/><circle cx="91" cy="132" r="6" fill="#7b6df4" fill-opacity=".922"/><path d="M76 44L195 98L139 120L117 188Z" fill="url(#pointer)" stroke="#eef7ff" stroke-width="8" stroke-linejoin="round"/><path d="M119 111L144 137" stroke="#eef7ff" stroke-opacity=".851" stroke-width="7"/></svg>`;

export async function generateIcon(output: string): Promise<void> {
  const frames: Buffer[] = [];
  for (const size of sizes) {
    const rgba = await sharp(Buffer.from(drawing)).resize(size, size).ensureAlpha().raw().toBuffer(), pixels = Buffer.alloc(size * size * 4), mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size), header = Buffer.alloc(40);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const from = (y * size + x) * 4, to = ((size - 1 - y) * size + x) * 4; pixels[to] = rgba[from + 2]; pixels[to + 1] = rgba[from + 1]; pixels[to + 2] = rgba[from]; pixels[to + 3] = rgba[from + 3]; }
    header.writeUInt32LE(40); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14); header.writeUInt32LE(pixels.length + mask.length, 20); frames.push(Buffer.concat([header, pixels, mask]));
  }
  const directory = Buffer.alloc(6 + frames.length * 16); directory.writeUInt16LE(1, 2); directory.writeUInt16LE(frames.length, 4); let offset = directory.length;
  for (const [index, frame] of frames.entries()) { const entry = 6 + index * 16; directory[entry] = directory[entry + 1] = sizes[index] === 256 ? 0 : sizes[index]; directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6); directory.writeUInt32LE(frame.length, entry + 8); directory.writeUInt32LE(offset, entry + 12); offset += frame.length; }
  await writeFile(output, Buffer.concat([directory, ...frames]));
}
if (require.main === module) generateIcon(path.resolve(process.argv[2] || 'assets/app/icon.ico')).catch(error => { console.error(error); process.exitCode = 1; });
