'use strict';

// 渲染层造节点、不拼串——文本一律走 createTextNode，转义是结构性的。
// 这份测试的头等大事就是钉住那一条：哪天有人图省事改回拼串，这里会红。

const assert = require('node:assert');
const fs = require('node:fs');
const cards = require('../electron/cards');
const cardRender = require('../electron/renderer/card_render');
const { esc, safeSrc } = cardRender;
const cardsCss = fs.readFileSync('electron/renderer/cards.css', 'utf8');
globalThis.CardModel = cards; // 渲染层 classic script 里它就是全局；测试里同样要挂上

// renderCard 造节点不拼串——舞台不许出现 innerHTML（tests/stage_static_test.js）。
// 这两个薄封装只为断言方便：把节点序列化回字符串。
const renderCard = (card, opts) => {
  const node = cardRender.renderCard(card, opts);
  return node ? node.outerHTML : '';
};
const markdown = (text) => cardRender.markdown(text).map((n) => n.outerHTML).join('');

// ---------------------------------------------------------------------------
// markdown 的极小子集：和 stage.js 原来那份 DOM 版本必须是同一套规则
// ---------------------------------------------------------------------------
assert.strictEqual(markdown('一段话'), '<p>一段话</p>');
assert.strictEqual(markdown('**重点**在这'), '<p><strong>重点</strong>在这</p>');
assert.strictEqual(markdown('看 `PROBE_MS`'), '<p>看 <code>PROBE_MS</code></p>');
assert.strictEqual(markdown('- 一\n- 二'), '<ul><li>一</li><li>二</li></ul>');
assert.strictEqual(markdown('1. 一\n2. 二'), '<ol><li>一</li><li>二</li></ol>');
assert.strictEqual(markdown('### 标题'), '<h3>标题</h3>');
assert.ok(markdown('```\nx = 1\n```').startsWith('<pre><code>'));
// markdown 里出现标签是常事，一样要挡住
assert.ok(!markdown('**<script>alert(1)</script>**').includes('<script>'));
assert.ok(!markdown('- <img src=x onerror=y>').includes('<img src=x'));
assert.ok(markdown('```\n<script>x</script>\n```').includes('&lt;script&gt;'));

// 正文里的图。一次问答的结果本来就可能是一张图，而上一版的子集里没有它——
// 那行 markdown 被当成普通文字原样印出来，用户看到的是 `![图](https://…)`
// 这几个字符。
assert.ok(markdown('看这个 ![截图](https://example.com/a.png)').includes('<img'),
  'markdown 子集必须认得图，否则图会以源码形式印在回答里');
assert.ok(markdown('![截图](https://example.com/a.png)').includes('src="https://example.com/a.png"'));
assert.ok(markdown('![截图](https://example.com/a.png)').includes('alt="截图"'));
assert.ok(markdown('![本地](file:///C:/tmp/a.png)').includes('<img'), '本地文件也要能渲染');
assert.ok(markdown('![内嵌](data:image/png;base64,iVBOR)').includes('<img'));
// 地址一律过 safeSrc：模型给一个 javascript: 就能在渲染进程里执行脚本。
// 挡下来之后必须说出来，不能静默变成一段空白。
const blocked = markdown('![坏](javascript:alert(1))');
assert.ok(!blocked.includes('<img'), 'javascript: 地址绝不能变成一个 img');
assert.ok(blocked.includes('没有加载'), '挡下来的图必须说出来，不能静默留白');
assert.ok(!markdown('![x](vbscript:msgbox)').includes('<img'));
assert.ok(!markdown('![x](data:text/html,<script>1</script>)').includes('<img'),
  'data:text/html 不是图，它是一段能执行的文档');

// ---------------------------------------------------------------------------
// 转义：模型的输出和窗口标题都会走进这段 HTML
// ---------------------------------------------------------------------------
const XSS = '<img src=x onerror=alert(1)>';
const poisoned = renderCard(cards.normalizeCard({
  kind: 'prose',
  title: XSS,
  answer: XSS,
  subtitle: XSS,
  source: { app: XSS, label: XSS },
  actions: [{ id: XSS, label: XSS }],
}));
assert.ok(!poisoned.includes('<img src=x'), '标题/正文/来源/动作里的标签必须被转义');
assert.ok(poisoned.includes('&lt;img src=x'), '转义之后仍要看得见原文');
assert.strictEqual(esc('a&b<c>'), 'a&amp;b&lt;c&gt;');

// 图片来源要过白名单：一个 javascript: 就能在渲染进程里执行脚本
assert.strictEqual(safeSrc('file:///C:/x/out.png'), 'file:///C:/x/out.png');
assert.strictEqual(safeSrc('https://example.com/a.png'), 'https://example.com/a.png');
assert.strictEqual(safeSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
assert.strictEqual(safeSrc('javascript:alert(1)'), '', 'javascript: 必须被挡掉');
assert.strictEqual(safeSrc('data:text/html,<script>x</script>'), '', 'data:text/html 必须被挡掉');
const evil = renderCard(cards.normalizeCard({ kind: 'image', state: 'done', src: 'javascript:alert(1)' }));
assert.ok(!evil.includes('javascript:'));

// ---------------------------------------------------------------------------
// 运行态：进度是一根条子的时代结束了。Vida §0.3/§5.3——进度就是逐行展开的
// 证据流本身，百分比条、不定量条、百分数一个都不许出现在运行卡上。
// ---------------------------------------------------------------------------
const unknown = renderCard(cards.normalizeCard({ kind: 'image', state: 'running' }));
assert.ok(!unknown.includes('mbar') && !unknown.includes('progressbar'),
  '运行卡不得出现任何进度条：证据行就是进度');
assert.ok(!/aria-valuenow/.test(unknown), '不知道进度就不要报一个 aria 数值出去');

const known = renderCard(cards.applyPatch(
  cards.normalizeCard({ kind: 'image', state: 'running', id: 'a' }),
  { progress: 0.4 },
));
assert.ok(!known.includes('<progress') && !known.includes('%'),
  '已知进度也不画百分比：数字条不能回来');
assert.ok(!known.includes('mcard-rail'), '进度条容器一并删除，不留死结构');

// ---------------------------------------------------------------------------
// 「进度条走到 100% 然后就地变成图」——同一张卡，同一个 id，形状从第一帧就对
// ---------------------------------------------------------------------------
let card = cards.normalizeCard({ kind: 'image', state: 'running', id: 'gen1', w: 1024, h: 512 });
const early = renderCard(card);
assert.ok(early.includes('data-kind="image"'), '还没出图时就要知道等来的是一张图');
assert.ok(early.includes('is-waiting'), '等待时先占好位');
assert.ok(early.includes('viewBox="0 0 1024 512"'),
  '已知比例要用 SVG 固有尺寸占位，图落下来时卡不该跳一下');
assert.ok(early.includes('data-card-id="gen1"'));

card = cards.applyPatch(card, { state: 'done', src: 'file:///out.png', caption: '去掉了背景' });
const late = renderCard(card);
assert.ok(late.includes('data-card-id="gen1"'), '还是同一张卡，不是新建一张');
assert.ok(late.includes('src="file:///out.png"'));
assert.ok(!late.includes('is-waiting'));
assert.ok(!late.includes('mcard-rail'), '出了结果就不该还挂着进度条');
assert.ok(late.includes('去掉了背景'));
assert.ok(!early.includes('style=') && !late.includes('style='),
  '共享卡片不能生成违反 renderer CSP 的内联 style');

// ---------------------------------------------------------------------------
// 每种 kind 都要有身子，认不出来的退成一段话——绝不留白卡
// ---------------------------------------------------------------------------
for (const kind of cards.KINDS) {
  const html = renderCard(cards.normalizeCard({ kind, state: 'running' }));
  assert.ok(html.includes(`data-kind="${kind}"`), `${kind} 应当渲染出自己的形状`);
  assert.ok(!html.includes('mcard-rail'), `${kind} 运行中也不许出现进度条容器`);
}
const weird = renderCard(cards.normalizeCard({ kind: '还没做的新卡', answer: '先当一段话' }));
assert.ok(weird.includes('data-kind="prose"'));
assert.ok(weird.includes('先当一段话'));
assert.strictEqual(cardRender.renderCard(null), null);

// ---------------------------------------------------------------------------
// 步骤：✓ 是动作，后面跟着的是从这个动作里读到的事实。
// 照 PromptRescue 逐帧复刻：✓ 行是黑色无衬线动作，事实是它下面独立的
// → 等宽灰行；舞台那张窄卡运行中就是证据流本体，不再藏步骤。
// ---------------------------------------------------------------------------
const withSteps = renderCard(cards.applyPatch(
  cards.normalizeCard({ kind: 'prose', state: 'running', id: 's1' }),
  { steps: [cards.phaseStep({ phase: 'pixels_frozen', ms: 412, fields: { w: '2950', h: '1200' } })] },
));
assert.ok(withSteps.includes('冻住了这块画面'));
assert.ok(withSteps.includes('2950×1200'), '读到的事实要跟着动作一起显示');
assert.ok(!/d+ms</.test(withSteps), '毫秒不上屏：那是机器的账，不是人要读的字');
assert.ok(withSteps.includes('准备阶段 · 1 步'), '感知流水账收进折叠组，一行带过');
assert.ok(withSteps.includes('mcard-steps-plumbing'), '准备组是 details 折叠');
const mixed = renderCard(cards.applyPatch(
  cards.normalizeCard({ kind: 'prose', state: 'running', id: 's3' }),
  { steps: [
    cards.phaseStep({ phase: 'pixels_frozen', fields: { w: '1', h: '1' } }),
    cards.phaseStep({ phase: 'model_request', fields: { turn: '2' } }),
  ] },
));
assert.ok(mixed.includes('准备阶段 · 1 步'), '准备组折叠出现');
assert.ok(mixed.includes('交给模型'), '动作行保持展开');
assert.ok(withSteps.includes('mstep-row'), '✓ 动作是独立的一行');
assert.ok(withSteps.includes('mstep-fact'), '事实是 ✓ 行下面独立的 → 行，不是标签行内的尾巴');
assert.ok(withSteps.includes('→'), '事实行以 → 开头（§5.3 版式即语义）');
assert.ok(!withSteps.includes('mstep-note'), '旧的行内尾巴结构必须删掉');

const toolLimitNotice = cards.phaseStep({
  phase: 'tools_truncated',
  fields: { count: '130', limit: '128', dropped: '2', names: 'mcp_alpha,mcp_beta' },
});
const toolLimitHtml = renderCard(cards.applyPatch(
  cards.normalizeCard({ kind: 'prose', state: 'running', id: 'tools-limit' }),
  { steps: [toolLimitNotice] },
));
assert.ok(toolLimitHtml.includes('工具太多，本轮只加载一部分'),
  'Stage 必须把 ToolsTruncated 画成中文可见通知');
assert.ok(toolLimitHtml.includes('130 个 · 上限 128 · mcp_alpha,mcp_beta'),
  '截断通知必须说明总数、上限和有界的未加载工具名');

// 舞台（capsule 密度）运行中必须铺证据流——那正是参考卡的全部内容
const capsule = renderCard(cards.applyPatch(
  cards.normalizeCard({ kind: 'prose', state: 'running', id: 's2' }),
  { steps: [cards.phaseStep({ phase: 'structured_read' })] },
), { density: 'capsule' });
assert.ok(capsule.includes('mcard-steps'), '舞台窄卡运行中就是逐行展开的证据流，不许藏');
assert.ok(!capsule.includes('准备阶段'), '舞台不报告冻结/枚举/凑上下文等内部流水账');
assert.ok(!capsule.includes('mstep-fact'), '舞台不倾倒 UIA/L0/毫秒等内部说明');
assert.ok(capsule.includes('data-state="pending"'), '已完成步骤下面必须有持续运动的当前活动');
assert.ok(capsule.includes('data-elapsed'), '当前活动保留真实等待秒数，但不另占一行');

// ---------------------------------------------------------------------------
// 提案：预览要长得像结果，而不是像一条命令
// ---------------------------------------------------------------------------
const proposal = renderCard(cards.normalizeCard({
  kind: 'proposal',
  summary: '找到 8 个文件，要归到三个文件夹里吗？',
  preview: { kind: 'folders', items: [{ name: '地图类' }, { name: '产品文档' }] },
  irreversible: true,
  actions: [{ id: 'reject', label: '不用' }, { id: 'approve', label: '就这么办', tone: 'solid' }],
}));
assert.ok(proposal.includes('mprev-folders'));
assert.ok(proposal.includes('地图类'));
assert.ok(proposal.includes('撤不回来'), '不可逆的事要在点头之前说，不是做完才说');
assert.ok(proposal.includes('data-action-id="approve"'));

const filePreview = renderCard(cards.normalizeCard({
  kind: 'proposal',
  preview: {
    kind: 'files',
    items: Array.from({ length: 12 }, (_, index) => ({ name: `文件 ${index + 1}` })),
  },
}));
assert.strictEqual((filePreview.match(/class="mfile"/g) || []).length, 12,
  'a visual reference collage must never truncate real proposal data');
assert.ok(filePreview.includes('文件 12'));
assert.ok(!filePreview.includes('data-tile-index'),
  'reference-board tile choreography is not a product file-preview contract');
assert.ok(cardsCss.includes('flex-wrap: wrap'),
  'real proposal items keep their existing responsive flow layout');
assert.ok(!cardsCss.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'),
  'the supplied 3×3 reference collage must not become a product grid');
// 证据流排版契约（PromptRescue 逐帧 + VIDA_UI_SPEC §5.3）
assert.ok(!cardsCss.includes('.mbar'), '百分比条的样式必须连同结构一起删干净');
const factCss = cardsCss.slice(cardsCss.indexOf('.mstep-fact'), cardsCss.indexOf('.mstep-fact') + 420);
assert.ok(cardsCss.includes('.mstep-fact'), '事实行要有自己的样式块');
assert.ok(factCss.includes('var(--font-mono)'), '→ 事实行是等宽字（§5.3 版式即语义）');
assert.ok(cardsCss.includes('cubic-bezier(0.32, 0.72, 0, 1)'),
  '全套动效统一用实测减速曲线（§6.3，起步快收尾长无过冲）');
assert.ok(/animation: mstep-in 360ms/.test(cardsCss), '单行入场约 360ms（逐帧实测 350-400ms）');
assert.ok(cardsCss.includes('.mcard-steps li:not(:last-child)::after'),
  '相邻活动必须由一段短竖线连接，而不是互不相关的图标列表');
assert.ok(/@keyframes mstep-spin/.test(cardsCss), '当前活动的小点必须持续运动，避免卡死感');
assert.ok(/@keyframes mstep-check/.test(cardsCss), '完成时转成对号要有克制的落定转场');
assert.ok(/@keyframes mstep-in \{[^}]*blur\(/.test(cardsCss),
  '入场带雾化淡入（视频里逐行 blur→clear）');
assert.ok(/prefers-reduced-motion[\s\S]*mcard-steps li[^{]*\{[^}]*animation: none/.test(cardsCss),
  'reduced motion 必须关掉逐行入场');

// ---------------------------------------------------------------------------
// 失败：要说出哪里断了，并且停在断掉的地方
// ---------------------------------------------------------------------------
const failed = renderCard(cards.applyPatch(
  cards.applyPatch(cards.normalizeCard({ kind: 'image', state: 'running', id: 'f' }), { progress: 0.6 }),
  { state: 'failed', error: '模型没返回' },
));
assert.ok(failed.includes('模型没返回'));
assert.ok(failed.includes('没能完成'));
assert.ok(!failed.includes('mcard-rail'), '失败之后不该还挂着一条在走的进度条');

// ---------------------------------------------------------------------------
// 数据卡：大数字压住整张卡
// ---------------------------------------------------------------------------
const metric = renderCard(cards.normalizeCard({
  kind: 'metric', value: '175', unit: 'ms', delta: '+340%', deltaTone: 'terracotta',
  caption: '探针冷启动，n=20 的 p50',
  foot: [{ value: '0/5', label: '记事本' }, { value: '2/5', label: '终端' }],
}));
assert.ok(metric.includes('mmetric-value'));
assert.ok(metric.includes('175'));
assert.ok(metric.includes('is-terracotta'));
assert.ok(metric.includes('记事本'));

console.log('card render test ok');

// ---------------------------------------------------------------------------
// 全局作用域：渲染层是一串共用同一个全局的 classic script。
// studio.js 和 settings.js 各有一个返回 HTML 字符串的 icon()，后加载的会把
// card_render 里那个造节点的顶掉——卡片的眉毛行里就会出现
// `<SVG CLASS="">…</SVG>` 的字面文本（真的发生过，截图里看见的）。
// 所以这两份共享模块必须各自只暴露一个名字。
// ---------------------------------------------------------------------------
for (const [file, allowed] of [
  ['electron/renderer/card_render.ts', ['CardRender', 'renderCard', 'cardElapsedText', 'renderFoldedProcess']],
  ['electron/cards.ts', ['CardModel']],
  ['electron/renderer/live_cards.ts', ['LiveCards']],
]) {
  const source = fs.readFileSync(file, 'utf8');
  const leaked = [...source.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1])
    .filter((name) => !allowed.includes(name));
  assert.deepStrictEqual(leaked, [],
    `${file} 的顶层只能有 ${allowed.join(' / ')}；泄出去的名字会和别的渲染脚本互相顶`);
}

console.log('card render scope test ok');

// ---------------------------------------------------------------------------
// MCP 挂进来的界面：那是别人的代码，安全边界不能靠记性
// ---------------------------------------------------------------------------
const slotHtml = renderCard(cards.normalizeCard({
  kind: 'slot', server: 'github-mcp', html: '<h1>PR #482</h1>', height: 240,
}));
assert.ok(slotHtml.includes('mcard-slot'));
assert.ok(slotHtml.includes('github-mcp'), '必须写清是哪个 server 提供的');
assert.ok(slotHtml.includes('工具界面'), '眉毛行要说明这是一块工具界面，不是我们的回答');
assert.ok(slotHtml.includes('工具提供的界面'), '用户要能分清「它说的」和「我们说的」');
assert.ok(/sandbox="allow-scripts allow-forms"/.test(slotHtml));
assert.ok(!/allow-same-origin/.test(slotHtml),
  'allow-same-origin 会让那块界面拿到我们的 DOM 和 preload 桥——等于把渲染进程交出去');

// 非 https 的外链一律挡下，并且要说出来，不能静默留白
const slotHttp = renderCard(cards.normalizeCard({ kind: 'slot', server: 'x', url: 'http://evil/x' }));
assert.ok(!slotHttp.includes('<iframe'), 'http 不能加载');
assert.ok(slotHttp.includes('已挡下'));
const slotEmpty = renderCard(cards.normalizeCard({ kind: 'slot', server: 'x' }));
assert.ok(slotEmpty.includes('没有返回可渲染的界面'), '拿不到内容要说清楚，不留白');

// iframe 高度要有上限：一块工具界面不能把整条流顶穿
const slotTall = renderCard(cards.normalizeCard({
  kind: 'slot', server: 'x', html: '<p>a</p>', height: 99999,
}));
assert.ok(/height="520"/.test(slotTall));
assert.ok(!/<iframe[^>]+style=/.test(slotTall),
  'stage CSP forbids iframe inline style attributes');
assert.ok(!/<iframe[^>]+style=/.test(slotHtml));

console.log('card render slot test ok');

// ---- 荧光笔：改了哪里就标哪里，不用写一段解释 ----
assert.strictEqual(markdown('==3 additional onboarding== steps'),
  '<p><mark class="mhi">3 additional onboarding</mark> steps</p>');
assert.ok(!markdown('==<script>x</script>==').includes('<script>'), '荧光笔里的内容也要转义');

console.log('card render highlight test ok');
