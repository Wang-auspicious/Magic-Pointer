// Render deterministic stage scenes for visual regression review.
//   npx electron build/scripts/capture_stage.js <out.png> [finished|processing-right|processing-left]
// It only touches DOM: layout evidence, not a mocked product workflow.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv[2] || path.join(ROOT, 'data', 'runtime', 'stage.png');
const sceneArg = process.argv[3] || 'finished';
const PANEL_ANCHOR = Object.freeze({ x: 672, y: 108 });

app.setPath('userData', path.join(
  ROOT,
  'data',
  'runtime',
  `capture-stage-profile-${sceneArg.replace(/[^a-z0-9-]/gi, '-')}`,
));
app.disableHardwareAcceleration();

const SCENE = `(() => { try {
  const scene = ${JSON.stringify(sceneArg)};
  const panelAnchor = ${JSON.stringify(PANEL_ANCHOR)};
  const root = document.getElementById('stage');
  const panel = document.getElementById('stage-thread');
  const result = document.getElementById('stage-result');
  const tpl = document.getElementById('tpl-thread-turn');
  root.hidden = false;
  root.dataset.state = scene.startsWith('processing') ? 'processing' : 'result';
  document.body.style.background = '#e8e6e1';

  const sourceWindow = ({ x, y, width, height, fullscreen = false }) => {
    const node = document.createElement('section');
    node.style.cssText = 'position:fixed;overflow:hidden;border:1px solid rgba(14,17,22,.12);'
      + 'border-radius:' + (fullscreen ? '0' : '14px') + ';background:#f7f6f3;'
      + 'box-shadow:0 18px 50px rgba(14,17,22,.12);color:#80848d;font:13px system-ui;'
      + 'left:' + x + 'px;top:' + y + 'px;width:' + width + 'px;height:' + height + 'px;';
    const bar = document.createElement('div');
    bar.style.cssText = 'height:38px;border-bottom:1px solid rgba(14,17,22,.08);background:#fff;'
      + 'display:flex;align-items:center;padding:0 14px;gap:7px;';
    for (let index = 0; index < 3; index += 1) {
      const dot = document.createElement('i');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#d3d1cc;';
      bar.appendChild(dot);
    }
    const canvas = document.createElement('div');
    canvas.style.cssText = 'padding:38px 46px;display:grid;gap:14px;';
    ['当前应用里的内容', '这里代表用户正在处理的文档或网页', '面板选择有空位的一侧'].forEach((label, index) => {
      const line = document.createElement(index === 0 ? 'b' : 'span');
      line.textContent = label;
      line.style.cssText = index === 0 ? 'font-size:22px;color:#363940;' : 'height:10px;color:#92959c;';
      canvas.appendChild(line);
    });
    node.append(bar, canvas);
    document.body.prepend(node);
    return node;
  };

  const makeTurn = (card, ask = '', hideAsk = true, status = 'done') => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.status = status;
    const askEl = node.querySelector('.turn-ask');
    askEl.textContent = ask;
    askEl.hidden = hideAsk;
    node.querySelector('.turn-answer').appendChild(
      CardRender.renderCard(CardModel.normalizeCard(card), { density: 'capsule' }));
    return node;
  };

  const showPanel = ({ x, y, side, phase, title, eyebrow }) => {
    panel.hidden = false;
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.dataset.side = side;
    panel.style.setProperty('--stage-work-panel-width', '560px');
    panel.style.setProperty('--stage-work-panel-height', '520px');
    panel.dataset.phase = phase;
    panel.dataset.turnCount = '1';
    document.getElementById('thread-title').textContent = title;
    const eyebrowNode = document.getElementById('thread-eyebrow');
    eyebrowNode.dataset.state = phase === 'running' ? 'running' : 'done';
    eyebrowNode.querySelector('use').setAttribute('href', phase === 'running' ? '#ic-circle' : '#ic-check');
    document.getElementById('thread-eyebrow-text').textContent = eyebrow;
  };

  if (scene === 'processing-right' || scene === 'processing-left') {
    const isRight = scene === 'processing-right';
    sourceWindow(isRight
      ? { x: 40, y: 42, width: 620, height: 690 }
      : { x: 580, y: 42, width: 620, height: 690 });
    showPanel({
      x: isRight ? panelAnchor.x : 12,
      y: panelAnchor.y,
      side: isRight ? 'right' : 'left',
      phase: 'running',
      title: '整理这组材料',
      eyebrow: 'WORKING',
    });
    result.appendChild(makeTurn({
      kind: 'prose', state: 'running', runningLabel: '正在理解选中内容',
    }, '', true, 'pending'));
    document.getElementById('thread-followup').placeholder = '任务完成后可以继续追问';
    return 'ok ' + scene;
  }

  sourceWindow({ x: 40, y: 42, width: 620, height: 690 });
  showPanel({
    x: panelAnchor.x, y: panelAnchor.y, side: 'right', phase: 'finished',
    title: '整理选中内容', eyebrow: 'TASK FINISHED',
  });
  result.appendChild(makeTurn({
    kind: 'prose', state: 'done',
    answer: '这是只用于检查版式、间距和动效的示例文本，不代表一次真实读取或模型回答。',
    steps: [
      { label: '读窗口里的文字', note: 'UIA', ms: 212, state: 'done' },
      { label: '交给模型', note: 'L0', ms: 1840, state: 'done' },
    ],
  }));
  document.getElementById('thread-followup').placeholder = '继续追问选中内容';
  return 'ok finished';
} catch (error) { return 'ERR ' + error.stack; }
})()`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await window.loadFile(path.join(ROOT, 'electron', 'renderer', 'stage.html'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const verdict = await window.webContents.executeJavaScript(SCENE);
    process.stdout.write(`scene: ${verdict}\n`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(outArg, image.toPNG());
    process.stdout.write(`${outArg}\n`);
  } catch (error) {
    process.stderr.write(`capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
