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
const composerSource = read('composer.ts');

// --- 组件本身导得出来，接口没被改瘦 ---
const Composer = require('../electron/renderer/composer.ts');
assert.strictEqual(typeof Composer.create, 'function');
assert.strictEqual(typeof Composer.safeThumb, 'function');
assert.strictEqual(typeof Composer.decideSubmission, 'function');
assert.strictEqual(typeof Composer.shouldRestoreFocus, 'function');
assert.strictEqual(typeof Composer.isTextAttachmentName, 'function');
assert.strictEqual(typeof Composer.textAttachmentWithinLimit, 'function');
assert.strictEqual(typeof Composer.createInFlightGate, 'function');
assert.strictEqual(typeof Composer.callAcknowledged, 'function');
assert.strictEqual(typeof Composer.attachmentSubmissionSnapshot, 'function');
assert.strictEqual(typeof Composer.pendingReadsThrough, 'function');
assert.strictEqual(typeof Composer.remainingAttachmentEntries, 'function');

// 运行中仍是同一根可编辑输入条：有字是 steer，留空才是 stop；
// 空闲态把文本与附件作为同一份 submit payload 交给外层。
{
  const attachment = { name: 'notes.txt', text: 'context' };
  assert.deepStrictEqual(
    Composer.decideSubmission('running', '  再检查一次  ', []),
    { action: 'steer', text: '再检查一次' },
  );
  assert.deepStrictEqual(
    Composer.decideSubmission('running', '   ', [attachment]),
    { action: 'stop' },
  );
  assert.deepStrictEqual(
    Composer.decideSubmission('idle', '  请总结  ', [attachment]),
    { action: 'submit', payload: { text: '请总结', attachments: [attachment] } },
  );
}

// 回合结束恢复输入焦点，但不能把用户正在另一个输入框里打的字抢走。
{
  const composerInput = { tagName: 'TEXTAREA' };
  assert.strictEqual(Composer.shouldRestoreFocus({ tagName: 'INPUT' }, composerInput), false);
  assert.strictEqual(Composer.shouldRestoreFocus({ tagName: 'textarea' }, composerInput), false);
  assert.strictEqual(Composer.shouldRestoreFocus(composerInput, composerInput), true);
  assert.strictEqual(Composer.shouldRestoreFocus({ tagName: 'BUTTON' }, composerInput), true);
  assert.strictEqual(Composer.shouldRestoreFocus(null, composerInput), true);
}
assert.match(composerSource,
  /next === 'idle' && shouldRestoreFocus\(document\.activeElement, input\)[\s\S]*input\.focus\(\)/,
  'shared Composer idle transition must use the guarded focus policy');
assert(!/input\.disabled\s*=\s*next === 'running'/.test(composerSource),
  'running state must never disable the shared textarea');
assert.match(composerSource, /input\.placeholder = next === 'running' \? '插一句（下一轮生效）…'/,
  'running state must explain that typed text will steer the next round');
assert.match(composerSource, /input\.value\.trim\(\) \? '插话' : '停止'/,
  'running submit affordance must distinguish steer from empty stop');

// 图片维持 data URL；这组文本附件走 readAsText，且 200 KiB 是明确硬边界。
for (const ext of ['txt', 'md', 'log', 'csv', 'json', 'py', 'ts', 'js']) {
  assert.strictEqual(Composer.isTextAttachmentName(`notes.${ext}`), true, `.${ext} 应作为文本附件`);
}
assert.strictEqual(Composer.isTextAttachmentName('NOTES.TS'), true, '文本扩展名应大小写不敏感');
assert.strictEqual(Composer.isTextAttachmentName('archive.zip'), false);
assert.strictEqual(Composer.isTextAttachmentName('photo.png'), false);
assert.strictEqual(Composer.textAttachmentWithinLimit(200 * 1024), true);
assert.strictEqual(Composer.textAttachmentWithinLimit(200 * 1024 + 1), false);
assert.match(composerSource, /readAsText\(f\)/, '文本附件必须用 readAsText，不能 base64 膨胀');
assert.match(composerSource, /readAsDataURL\(f\)/, '图片附件仍应保留 data URL 预览');
assert.match(composerSource, /class: 'mcomp-error'/, '超限文本必须有组件内可见错误');
assert.match(composerSource, /accept: 'image\/\*,\.txt,\.md,\.log,\.csv,\.json,\.py,\.ts,\.js'/,
  'file picker must expose the bounded image + text extension set');
assert.match(composerSource, /item:[\s\S]*\{ name: f\.name, text:/,
  'text attachments must be stored as {name,text}');
assert.match(composerSource, /await Promise\.all\(pendingReadsThrough\(/,
  'submit must wait for FileReaders selected before its cutoff');
assert.match(composerSource, /attachmentEntries = remainingAttachmentEntries\(/,
  'successful submit must remove only its attachment snapshot');
assert.match(composerSource, /steerGate\.tryEnter\(\)/,
  'in-flight steer must be guarded before calling the durable inbox');

// 附件提交以点击发送时的 cutoff 为界；晚到附件留给下一稿，成功后只移除
// 本次 snapshot。pending FileReader 也只等待 cutoff 以内的读取。
{
  const early = { id: 1, item: { name: 'early.txt', text: 'a' } };
  const late = { id: 2, item: { name: 'late.txt', text: 'b' } };
  assert.deepStrictEqual(Composer.attachmentSubmissionSnapshot([early, late], 1), [early]);
  assert.deepStrictEqual(Composer.remainingAttachmentEntries([early, late], [early]), [late]);
  const firstRead = Promise.resolve();
  const secondRead = Promise.resolve();
  assert.deepStrictEqual(
    Composer.pendingReadsThrough(new Map([[1, firstRead], [2, secondRead]]), 1),
    [firstRead],
  );
}

// 同一时刻只能有一个 steer/stop 在途；release 后才允许重试。
{
  const gate = Composer.createInFlightGate();
  assert.strictEqual(gate.tryEnter(), true);
  assert.strictEqual(gate.tryEnter(), false);
  assert.strictEqual(gate.active(), true);
  gate.leave();
  assert.strictEqual(gate.active(), false);
  assert.strictEqual(gate.tryEnter(), true);
  gate.leave();
}

// 附件缩略图那道闸：和卡片里 safeSrc 同一条规矩。
// 放行一个 javascript: 就等于让别人在渲染进程里执行脚本。
assert.strictEqual(Composer.safeThumb('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
assert.strictEqual(Composer.safeThumb('C:\\Users\\me\\a.png'), 'file:///C:/Users/me/a.png');
assert.strictEqual(Composer.safeThumb('javascript:alert(1)'), '');
assert.strictEqual(Composer.safeThumb('http://evil.example/a.png'), '');
assert.strictEqual(Composer.safeThumb('data:text/html,<script>'), '');

// 没有语音能力就不画麦克风。可见但点不动的按钮比没有按钮更坏。
assert.match(composerSource, /const mic = onVoice\s*\?/,
  'Composer 必须按 onVoice 能力条件创建麦克风');
assert.match(composerSource, /mic\.addEventListener\('click'/,
  '传入 onVoice 后麦克风必须绑定真实点击回调');

// --- 三个界面确实把该 link 的都 link 了 ---
// Studio 使用固定 Oreo 工作区输入面；Companion 继续复用 composer.js；
// Stage 使用独立的固定 Stage Composer。
for (const [page, needs] of Object.entries({
  'studio.html': ['claude_tokens.css', 'claude_shell.css', 'claude_chat.css', 'card_render.js', 'cards.js', 'live_cards.js'],
  'companion.html': ['composer.js', 'composer.css', 'beam.css', 'card_render.js'],
  'stage.html': ['beam.css', 'card_render.js'],
})) {
  const html = read(page);
  for (const asset of needs) {
    assert.ok(html.includes(asset), `${page} 没有 link ${asset}——组件在仓库里，界面上却看不到`);
  }
}

// --- 工作室只有一个输入面：稳定行为骨架 + Oreo/Claude 产品外观 ---
{
  const html = read('studio.html');
  assert.ok(!/hero-composer/.test(html), 'Studio 不得保留第二根营销 Hero 输入条');
  assert.ok(/<form class="[^"]*dshw-input-form[^"]*"/.test(html), 'Studio 必须只有一张真实输入卡');
  assert.ok(/class="dshw-primary"/.test(html), '发送键必须是紧凑主动作');
  assert.ok(!html.includes('composer.js'), 'studio 不该再 link 共用 composer.js');
}
// 随行窗没有手写条残留（它走共用 composer.js）
assert.ok(
  !/<form class="composer"/.test(read('companion.html')) && !/<form class="hero-composer"/.test(read('companion.html')),
  'companion 里还留着手写的输入条',
);

// 挂载点必须在，否则 mountComposer 静默什么也不做
assert.ok(read('companion.html').includes('id="cp-composer"'));
const companionSource = read('companion.ts');
assert.ok(!/onSubmit:\s*\(\)\s*=>\s*\{\}/.test(companionSource),
  'Companion 不能把可见输入条接到 no-op submit');
assert.match(companionSource, /onSteer:\s*\(text\)/,
  'Companion 运行中输入必须接真实 steer 回调');
assert.match(companionSource, /Data\.sendConversation\(/,
  'Companion 的共享输入条必须走真实 conversation send 链');
assert.match(companionSource, /Data\.steerConversation\(/,
  'Companion 必须把 running 文本写进 durable steer 通道');
assert.match(companionSource, /fields\.sid/,
  'Companion 必须读取 session_ready 协议真实字段 sid');
assert.match(companionSource, /Data\.stopConversation\(/,
  'Companion 空输入停止必须走真实 stop 通道');
assert.match(companionSource, /allowAttachments: false/,
  'Companion must hide attachments until its IPC can actually deliver them');
assert.match(companionSource, /if \(payload\.attachments\.length\) return false;/,
  'Companion must reject programmatic attachments rather than discard them');
assert.match(companionSource, /onSubmit: \(payload\) => submitCompanionTurn\(payload\)/,
  'Companion submit must return the delivery acknowledgement to Composer');
assert.match(companionSource, /cpStopGate\.tryEnter\(\)/,
  'Companion stop must reject duplicate in-flight IPC calls');
assert.match(companionSource, /cpStopGate\.leave\(\)/,
  'Companion stop must become retryable after IPC settles');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.ts'), 'utf8');
const sendHandler = mainSource.slice(
  mainSource.indexOf("ipcMain.handle('conversations:send'"),
  mainSource.indexOf("ipcMain.handle('conversations:stop'"),
);
const stopHandler = mainSource.slice(
  mainSource.indexOf("ipcMain.handle('conversations:stop'"),
  mainSource.indexOf("ipcMain.handle('conversations:steer'"),
);
const steerHandler = mainSource.slice(
  mainSource.indexOf("ipcMain.handle('conversations:steer'"),
  mainSource.indexOf("ipcMain.handle('conversations:timeline'"),
);
for (const [name, handler] of [['send', sendHandler], ['stop', stopHandler], ['steer', steerHandler]]) {
  assert.match(handler, /isConversationSender\(event, dashboardWindow, companionWindow\)/,
    `conversation ${name} IPC must authorize exactly Studio or Companion`);
}
assert.match(sendHandler, /notifyConversationChanged\(conversation\.id\)/,
  'a Companion-submitted turn must notify both conversation views when it settles');

async function verifyAcknowledgedCallbacks() {
  assert.strictEqual(await Composer.callAcknowledged(() => undefined), true);
  assert.strictEqual(await Composer.callAcknowledged(() => Promise.resolve(true)), true);
  assert.strictEqual(await Composer.callAcknowledged(() => Promise.resolve(false)), false);
  assert.strictEqual(await Composer.callAcknowledged(() => { throw new Error('ipc failed'); }), false);
}
assert.match(companionSource, /if \(!cpAgentSessionId\) return false;/,
  'Companion 在 durable session 就绪前必须明确拒绝而不是 no-op');

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

verifyAcknowledgedCallbacks().then(
  () => console.log('composer surface test ok'),
  (error) => { console.error(error); process.exitCode = 1; },
);
