'use strict';

// 一根条，三个界面
// ---------------------------------------------------------------------------
// 上一版工作室、随行窗各写各的 <form class="composer">，同一个产品里两根条
// 两个样，而且工作室那根根本没绑提交。改成共用 composer.js 之后，唯一会
// 悄悄失效的方式是「组件在，但页面没把它 link 进来」——就像 6c7e7c6 里那
// 两个被用了却从来没 require 的模块。这份测试就钉这一条。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'electron', 'renderer');
const read = (name) => fs.readFileSync(path.join(R, name), 'utf8');

// --- 组件本身导得出来，接口没被改瘦 ---
const Composer = require('../electron/renderer/composer.ts');
assert.strictEqual(typeof Composer.create, 'function');
assert.strictEqual(typeof Composer.safeThumb, 'function');

// 附件缩略图那道闸：和卡片里 safeSrc 同一条规矩。
// 放行一个 javascript: 就等于让别人在渲染进程里执行脚本。
assert.strictEqual(Composer.safeThumb('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
assert.strictEqual(Composer.safeThumb('C:\\Users\\me\\a.png'), 'file:///C:/Users/me/a.png');
assert.strictEqual(Composer.safeThumb('javascript:alert(1)'), '');
assert.strictEqual(Composer.safeThumb('http://evil.example/a.png'), '');
assert.strictEqual(Composer.safeThumb('data:text/html,<script>'), '');

// --- 三个界面确实把该 link 的都 link 了 ---
// Studio 使用固定 Oreo 工作区输入面；Companion 继续复用 composer.js；
// Stage 使用独立的固定 Stage Composer。
for (const [page, needs] of Object.entries({
  'studio.html': ['cards.css', 'card_render.js', 'cards.js', 'live_cards.js'],
  'companion.html': ['composer.js', 'composer.css', 'beam.css', 'card_render.js'],
  'stage.html': ['beam.css', 'card_render.js'],
})) {
  const html = read(page);
  for (const asset of needs) {
    assert.ok(html.includes(asset), `${page} 没有 link ${asset}——组件在仓库里，界面上却看不到`);
  }
}

// --- 工作室只有一个输入面：DSH InputBar（deepseek-harness 100% 移植） ---
{
  const html = read('studio.html');
  assert.ok(!/hero-composer/.test(html), 'Studio 不得保留第二根营销 Hero 输入条');
  assert.ok(/<form class="dshw-input-form"/.test(html), 'Studio 工作区必须用 DSH 输入卡');
  assert.ok(/class="dshw-primary"/.test(html), '发送键必须是 DSH 蓝圆主按钮');
  assert.ok(!html.includes('composer.js'), 'studio 不该再 link 共用 composer.js');
}
// 随行窗没有手写条残留（它走共用 composer.js）
assert.ok(
  !/<form class="composer"/.test(read('companion.html')) && !/<form class="hero-composer"/.test(read('companion.html')),
  'companion 里还留着手写的输入条',
);

// 挂载点必须在，否则 mountComposer 静默什么也不做
assert.ok(read('companion.html').includes('id="cp-composer"'));

// --- 荧光笔不能靠 <mark> 的 UA 底色 ---
// UA 默认 background-color: mark（刺眼纯黄）+ color: marktext（强制黑字）。
// 不显式清掉，暖色盘里那支笔一辈子看不见，深色模式下还会黑字压深底。
const beam = read('beam.css');
const mhi = beam.slice(beam.indexOf('.mhi {'), beam.indexOf('@keyframes mhi-sweep'));
assert.ok(/background-color:\s*transparent/.test(mhi), '.mhi 没清掉 <mark> 的 UA 底色');
assert.ok(/color:\s*inherit/.test(mhi), '.mhi 没清掉 <mark> 的 UA 字色');

// --- 工具界面那一圈必须是真 border ---
// inset box-shadow 画在自己的背景层上，而 iframe 是不透明替换元素，会整片
// 盖住它——只剩四个角上两道小刺，别人家的界面就跟我们自己的卡糊成一片了。
const slot = beam.slice(beam.indexOf('.mcard-slot {'), beam.indexOf('.mslot-top {'));
assert.ok(/border:\s*1px solid/.test(slot), '.mcard-slot 的框被 iframe 盖掉了');
assert.ok(!/box-shadow:\s*inset/.test(slot), '.mcard-slot 又用回了 inset 阴影');

console.log('composer surface test ok');
