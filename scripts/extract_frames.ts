// Temporary: extract frames from a video for design reference.
//   npx electron build/scripts/extract_frames.js <video.mp4> <outDir> [count]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const videoPath = process.argv[2];
const outDir = process.argv[3];
const count = Number(process.argv[4] || 24);

app.setPath('userData', path.join(__dirname, '..', 'data', 'runtime', 'extract-frames-profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: false },
  });
  const shellPath = path.join(outDir, '_shell.html');
  fs.writeFileSync(shellPath, '<!doctype html><body style="margin:0;background:#000"><video id="v"></video></body>');
  await window.loadFile(shellPath);
  const fileUrl = 'file:///' + videoPath.replace(/\\/g, '/');

  const meta = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const v = document.getElementById('v');
    v.src = ${JSON.stringify(fileUrl)};
    v.muted = true;
    v.onloadedmetadata = () => resolve({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
    v.onerror = () => reject(new Error('video load failed: ' + (v.error && v.error.code)));
    setTimeout(() => reject(new Error('timeout')), 15000);
  })`);
  process.stdout.write(`duration=${meta.duration} ${meta.w}x${meta.h}\n`);

  for (let i = 0; i < count; i += 1) {
    const t = (meta.duration * (i + 0.5)) / count;
    const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const v = document.getElementById('v');
      const onSeek = () => {
        v.removeEventListener('seeked', onSeek);
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      v.addEventListener('seeked', onSeek);
      v.currentTime = ${t};
      setTimeout(() => reject(new Error('seek timeout')), 10000);
    })`);
    const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
    const name = `f${String(i).padStart(2, '0')}_${t.toFixed(1)}s.jpg`;
    fs.writeFileSync(path.join(outDir, name), buffer);
    process.stdout.write(`${name}\n`);
  }
  app.quit();
}).catch((error: unknown) => {
  process.stderr.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  app.quit();
});
