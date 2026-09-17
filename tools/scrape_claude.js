// 通道 A：Claude Desktop 自带 CDP（首选）。本机当前未安装 Desktop，此脚本留待装后使用。
// 用法：先 `Claude.exe --remote-debugging-port=9222`，再
//   node tools/scrape_claude.js <webSocketDebuggerUrl> <outDir> <part> [selector]
// part 同 tools/scrape_extract.js 的 EXTRACT 分派。截图：part=screenshot。
const fs = require('fs');
const path = require('path');

const EXTRACT_SOURCE = fs.readFileSync(path.join(__dirname, 'scrape_extract.js'), 'utf8');

async function main() {
  const [wsUrl, outDir, part, a, b] = process.argv.slice(2);
  if (!wsUrl || !outDir || !part) {
    console.error('usage: node scrape_claude.js <wsUrl> <outDir> <part> [a] [b]');
    process.exit(2);
  }
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  if (part === 'screenshot') {
    await call('Page.enable');
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${a || 'shot'}.png`), Buffer.from(data, 'base64'));
    console.log('screenshot saved');
  } else {
    const expr = `${EXTRACT_SOURCE}\nEXTRACT(${JSON.stringify(part)}, ${JSON.stringify(a)}, ${JSON.stringify(b)})`;
    const result = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 2000));
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${part}${a ? '-' + String(a).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) : ''}.json`);
    fs.writeFileSync(file, JSON.stringify(result.result.value, null, 2));
    console.log('saved', file);
  }
  ws.close();
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
