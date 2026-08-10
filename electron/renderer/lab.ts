/* 交互实验页。每一段都是真的组件，不是示意图——所以这一页看到什么，
   产品里就是什么。 */

/* ---- 1. 胶囊三态 ---- */
const capsuleHost = document.getElementById('capsules')!;

const idle = Composer.create({
  placeholder: '这一屏里，问点什么？',
  onScissor: () => {},
  onSubmit: () => {},
});
capsuleHost.appendChild(idle.el);

const gap = () => {
  const s = document.createElement('div');
  s.style.height = '22px';
  return s;
};

capsuleHost.appendChild(gap());
const busy = Composer.create({ placeholder: '正在想…', onScissor: () => {} });
busy.el.querySelector<HTMLTextAreaElement>('.mcomp-input')!.value = '把这张图的背景去掉，边缘按头发丝细化';
busy.running(true);
capsuleHost.appendChild(busy.el);

capsuleHost.appendChild(gap());
const withFiles = Composer.create({ placeholder: '继续问…', onScissor: () => {} });
withFiles.setAttachments([
  {
    name: '截图 07:41',
    src: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90">
      <defs><linearGradient id="a" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#F3D9A8"/><stop offset="1" stop-color="#A8CBB4"/></linearGradient></defs>
      <rect width="120" height="90" fill="url(#a)"/></svg>`),
  },
  {
    name: '2026Q3.xlsx',
    icon: 'ic-file',
  },
]);
capsuleHost.appendChild(withFiles.el);

/* ---- 2. 荧光笔 ---- */
const hiCard = CardModel.normalizeCard({
  kind: 'prose',
  title: '给 Daniel 的回复',
  source: { app: 'Slack', label: '#a1-marketing' },
  answer: '设计进度按计划走：==12/16 屏已定稿==，移动端交接还没开始。\n\n'
    + '风险在这一周新加进来的 ==3 个额外的引导流程==，以及 ==API 审批== 还没下来——'
    + '这两件不解决，周五的发布日期我不敢保证。',
  actions: [{ id: 'edit', label: '改一下' }, { id: 'insert', label: '填进 Slack' }],
});
document.getElementById('hi-stage')!.appendChild(renderCard(hiCard, { density: 'full' }));

/* ---- 3. MCP 挂进来的界面 ---- */
const slotDemo = `<!DOCTYPE html><meta charset="utf-8">
<style>
  body{margin:0;font:13px/1.5 -apple-system,"Segoe UI",sans-serif;color:#17170F;padding:14px}
  h3{margin:0 0 10px;font-size:14px}
  .r{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid rgba(23,23,15,.08)}
  .r:first-of-type{border-top:0}
  .d{width:7px;height:7px;border-radius:50%;background:#3D8B5F;flex:none}
  .d.w{background:#B4690E}
  .n{flex:1}
  b{font-variant-numeric:tabular-nums}
</style>
<h3>magic-pointer · 最近 3 个 PR</h3>
<div class="r"><span class="d"></span><span class="n">卡片契约与共享渲染器</span><b>+1284</b></div>
<div class="r"><span class="d w"></span><span class="n">后台任务观察器</span><b>+417</b></div>
<div class="r"><span class="d"></span><span class="n">收藏箱五个缺口</span><b>+236</b></div>`;

const slots = document.getElementById('slots')!;
for (const card of [
  { kind: 'slot', server: 'github-mcp', html: slotDemo, height: 210,
    title: '仓库最近的动静' },
  { kind: 'slot', server: 'unknown-mcp', url: 'http://evil.example/panel',
    title: '挡下来的那种' },
]) {
  const wrap = document.createElement('div');
  wrap.className = 'card-slot';
  wrap.appendChild(renderCard(CardModel.normalizeCard(card), { density: 'full' }));
  slots.appendChild(wrap);
}
