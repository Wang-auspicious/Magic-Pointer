// Render deterministic stage scenes for visual regression review.
//   npx electron scripts/capture_stage.js <out.png> [finished|processing-right|processing-left|approval-grid]
// It only touches DOM: layout evidence, not a mocked product workflow.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const outArg = process.argv[2] || path.join(ROOT, 'data', 'runtime', 'stage.png');
const sceneArg = process.argv[3] || 'finished';

app.setPath('userData', path.join(
  ROOT,
  'data',
  'runtime',
  `capture-stage-profile-${sceneArg.replace(/[^a-z0-9-]/gi, '-')}`,
));
app.disableHardwareAcceleration();

const SCENE = `(() => { try {
  const scene = ${JSON.stringify(sceneArg)};
  const root = document.getElementById('stage');
  const capsule = document.getElementById('capsule');
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

  const showCapsule = ({ x, y, width = 340, processing = false, text = '问点什么…' }) => {
    capsule.hidden = false;
    capsule.dataset.mode = 'text';
    capsule.dataset.phase = processing ? 'processing' : 'input';
    capsule.dataset.empty = 'false';
    capsule.style.left = x + 'px';
    capsule.style.top = y + 'px';
    capsule.style.setProperty('--capsule-width', width + 'px');
    document.getElementById('capsule-input').value = text;
    document.getElementById('processing-shimmer').hidden = !processing;
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

  const showPanel = ({ x, y, side, tier, phase, title, eyebrow }) => {
    panel.hidden = false;
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.dataset.side = side;
    panel.dataset.widthTier = tier;
    panel.dataset.phase = phase;
    document.getElementById('thread-title').textContent = title;
    const eyebrowNode = document.getElementById('thread-eyebrow');
    eyebrowNode.dataset.state = phase === 'running' ? 'running' : 'done';
    eyebrowNode.querySelector('use').setAttribute('href', phase === 'running' ? '#ic-circle' : '#ic-check');
    document.getElementById('thread-eyebrow-text').textContent = eyebrow;
  };

  if (scene === 'processing-right' || scene === 'processing-left') {
    const isRight = scene === 'processing-right';
    sourceWindow(isRight
      ? { x: 48, y: 58, width: 720, height: 650 }
      : { x: 470, y: 58, width: 720, height: 650 });
    showCapsule({
      x: isRight ? 520 : 590,
      y: 108,
      processing: true,
      text: '把这组材料整理成提纲',
    });
    showPanel({
      x: isRight ? 776 : 56,
      y: 164,
      side: isRight ? 'right' : 'left',
      tier: 'context',
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

  if (scene === 'approval-grid') {
    sourceWindow({ x: 0, y: 0, width: 1240, height: 820, fullscreen: true });
    const focus = document.createElement('div');
    focus.style.cssText = 'position:fixed;left:110px;top:220px;width:210px;height:150px;'
      + 'border:2px solid #246fd0;border-radius:8px;background:rgba(36,111,208,.05);';
    document.body.appendChild(focus);
    showCapsule({ x: 72, y: 410, width: 310, text: '把这些文件归类' });
    showPanel({
      x: 392,
      y: 76,
      side: 'right',
      tier: 'wide',
      phase: 'finished',
      title: '整理下载目录里的文件',
      eyebrow: 'TASK FINISHED',
    });
    panel.dataset.consent = 'true';
    result.appendChild(makeTurn({
      kind: 'proposal', state: 'done',
      summary: '已按内容分成九组。确认后才会写回原目录，你仍可以先检查每一项。',
      preview: {
        kind: 'folders',
        items: ['设计稿', '合同', '截图', '表格', '演示文稿', '研究资料', '发票', '安装包', '待确认']
          .map((name) => ({ name })),
      },
    }));
    const consent = document.getElementById('capsule-consent');
    consent.hidden = false;
    document.getElementById('consent-target').textContent = '写回 文件资源管理器';
    return 'ok ' + scene;
  }

  sourceWindow({ x: 40, y: 42, width: 760, height: 690 });
  showCapsule({ x: 70, y: 72, width: 360, processing: false, text: '这个文件是干嘛的' });
  showPanel({
    x: 70, y: 132, side: 'right', tier: 'normal', phase: 'finished',
    title: 'CHANGELOG.md 是干嘛的', eyebrow: 'TASK FINISHED',
  });
  result.appendChild(makeTurn({
    kind: 'prose', state: 'done',
    answer: 'CHANGELOG.md 是软件的变更日志。它按版本记录新增、修改、修复和移除的内容，'
      + '让使用者快速知道这次升级会影响什么。',
    steps: [
      { label: '读窗口里的文字', note: 'UIA', ms: 212, state: 'done' },
      { label: '交给模型', note: 'L0', ms: 1840, state: 'done' },
    ],
  }));
  document.getElementById('thread-followup').placeholder = '继续问关于「CHANGELOG.md」的内容';
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
    process.stderr.write(`capture failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
