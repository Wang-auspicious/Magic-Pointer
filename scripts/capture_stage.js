// Temporary: render stage.html in its result state and screenshot it.
//   npx electron scripts/capture_stage.js <out.png>
// 它只碰 DOM——不假装有主进程，也不 mock 桥。要看的是版式，不是数据流。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv[2] || path.join(ROOT, 'data', 'runtime', 'stage.png');

app.setPath('userData', path.join(ROOT, 'data', 'runtime', 'capture-stage-profile'));
app.disableHardwareAcceleration();

const SCENE = `(() => { try {
  const root = document.getElementById('stage');
  root.hidden = false;
  root.dataset.state = 'result';
  document.body.style.background = '#e8e6e1';

  // 输入条：文字模式、有内容、正在跑（所以彩带在扫、提交键是方块）
  const capsule = document.getElementById('capsule');
  capsule.hidden = false;
  capsule.dataset.mode = 'text';
  capsule.dataset.phase = 'processing';
  capsule.dataset.empty = 'false';
  capsule.style.left = '60px';
  capsule.style.top = '54px';
  capsule.style.setProperty('--capsule-width', '360px');
  document.getElementById('capsule-input').value = '这个是干嘛的';
  document.getElementById('processing-shimmer').hidden = false;

  // 结果面板
  const panel = document.getElementById('stage-thread');
  panel.hidden = false;
  panel.style.left = '60px';
  panel.style.top = '112px';
  document.getElementById('thread-title').textContent = 'CHANGELOG.md 是干嘛的';

  const result = document.getElementById('stage-result');
  const tpl = document.getElementById('tpl-thread-turn');
  const mk = (ask, card, hideAsk) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.status = 'done';
    const askEl = node.querySelector('.turn-ask');
    askEl.textContent = ask;
    askEl.hidden = Boolean(hideAsk);
    node.querySelector('.turn-answer').appendChild(
      CardRender.renderCard(card, { density: 'capsule' }));
    return node;
  };
  result.appendChild(mk('这个是干嘛的', {
    kind: 'prose', state: 'done', eyebrow: '回答',
    answer: '根据屏幕区域识别，你选中的内容是 \`CHANGELOG.md\`，这通常是一个软件的'
      + '变更日志文件名。它按版本倒序记录每次发布改了什么，==给人读，不给机器读==。',
    steps: [
      { label: '读窗口里的文字', note: 'UIA', ms: 212, state: 'done' },
      { label: '交给模型', note: 'L0', ms: 1840, state: 'done' },
    ],
  }, true));
  result.appendChild(mk('那它一般怎么写', {
    kind: 'prose', state: 'done', eyebrow: '回答',
    answer: '按 Keep a Changelog 的惯例：每个版本一节，节里按 **Added / Changed / '
      + 'Fixed / Removed** 分组，每条一句话说清对使用者的影响。',
  }));
  document.getElementById('thread-count').textContent = '2 轮';
  document.getElementById('thread-count').hidden = false;
  document.getElementById('thread-followup').placeholder = '继续问关于「CHANGELOG.md 是干嘛的」的';
  document.getElementById('thread-send').dataset.ready = 'false';

  // 选中一段 → 那个就地展开的小按钮
  const walker = document.createTreeWalker(
    result.querySelector('.mcard-prose'), NodeFilter.SHOW_TEXT);
  let longest = null;
  while (walker.nextNode()) {
    if (!longest || walker.currentNode.length > longest.length) longest = walker.currentNode;
  }
  const range = document.createRange();
  range.setStart(longest, 0);
  range.setEnd(longest, Math.min(24, longest.length));
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const r = range.getBoundingClientRect();
  const btn = document.getElementById('passage-expand');
  btn.hidden = false;
  btn.style.left = r.left + 'px';
  btn.style.top = (r.bottom + 6) + 'px';
  return 'ok';
} catch (error) { return 'ERR ' + error.message; }
})()`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 760,
    height: 620,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'stage.html'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const verdict = await window.webContents.executeJavaScript(SCENE);
    process.stdout.write(`scene: ${verdict}
`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(outArg, image.toPNG());
    process.stdout.write(`${outArg}\n`);
  } catch (error) {
    process.stderr.write(`capture failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
