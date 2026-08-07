/* 随行窗 —— 与工作室共用会话，这里只管本窗的渲染与交互 */

/* 头像/球：与 studio.js 同一套；装了 @oreo-design/avatar 后统一换掉 */
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function rng(seed){let s=hash(String(seed))||1;return()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
function makeOrb(seed, size = 64) {
  const r = rng(seed);
  // 色相对：黄绿 ↔ 青蓝 那一段最耐看；由种子在这个区间里取一对，
  // 中间再插一个过渡色，所以三段之间没有硬边。
  const h1 = 68 + Math.floor(r() * 32);            // 68–100  黄绿
  const h3 = 178 + Math.floor(r() * 38);           // 178–216 青蓝
  const h2 = Math.round((h1 + h3) / 2);            // 中间色
  const A = `hsl(${h1} 62% 68%)`;
  const M = `hsl(${h2} 56% 66%)`;
  const B = `hsl(${h3} 60% 66%)`;
  const id = 'o' + hash(seed).toString(36);
  const dur = (7 + r() * 5).toFixed(1);            // 7–12s，一屏里不齐步走

  // 渐变轴：从右下角指向左上角，色带因此平行于反对角线。
  // 跨度取两倍并让色序首尾同色，平移整整一个周期就能无缝循环。
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${id}g" x1="1.5" y1="1.5" x2="-0.5" y2="-0.5">
        <stop offset="0"    stop-color="${A}"/>
        <stop offset="0.17" stop-color="${M}"/>
        <stop offset="0.33" stop-color="${B}"/>
        <stop offset="0.50" stop-color="${M}"/>
        <stop offset="0.67" stop-color="${A}"/>
        <stop offset="0.83" stop-color="${M}"/>
        <stop offset="1"    stop-color="${B}"/>
        <animateTransform attributeName="gradientTransform" type="translate"
          values="0 0; -0.667 -0.667" dur="${dur}s" repeatCount="indefinite"/>
      </linearGradient>
      <radialGradient id="${id}s" cx="50%" cy="50%" r="52%">
        <stop offset="0"   stop-color="#fff" stop-opacity=".34"/>
        <stop offset="0.55" stop-color="#fff" stop-opacity=".10"/>
        <stop offset="1"   stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="32" cy="32" r="32" fill="url(#${id}g)"/>
    <circle cx="32" cy="32" r="32" fill="url(#${id}s)"/>
  </svg>`;
}

/* ============================================================
   内容
   ------------------------------------------------------------
   随行窗和工作室是同一次会话的两个视图，所以它们读同一份 Data、
   渲染同一批 renderCard。上一版随行窗是一屏写死的样例，于是用户在
   小窗看到的和主窗看到的对不上——「他们俩应该是完全同步的才对」。
   ============================================================ */

let currentId = null;

function setTitle(text, seed) {
  const title = document.getElementById('cp-title');
  if (title) title.textContent = text;
  const orb = document.getElementById('cp-orb');
  if (orb) orb.replaceChildren();
  if (orb) orb.insertAdjacentHTML('afterbegin', makeOrb(seed || text || 'mp', 64));
}

function showEmpty(on) {
  const empty = document.getElementById('cp-empty');
  const stream = document.getElementById('cp-stream');
  if (empty) empty.hidden = !on;
  if (stream) stream.hidden = on;
}

/* 一轮问答摊成若干张卡。与 studio.js 的 turnCards 是同一套映射。 */
function turnCards(turn, conversation) {
  const object = conversation && conversation.object ? conversation.object : null;
  const cards = [CardModel.normalizeCard({
    id: `${turn.at || 0}-a`,
    kind: 'prose',
    state: turn.failed ? 'failed' : 'done',
    answer: turn.answer || '',
    error: turn.failed ? (turn.answer || '这次没能完成。') : '',
    steps: (turn.trace || []).map((x) => (typeof x === 'string'
      ? { label: x, state: 'done' }
      : { label: x.label, note: x.note || '', state: 'done' })),
    source: object ? { app: object.app, label: object.label || object.windowTitle } : null,
  })];
  if ((turn.facts || []).length) {
    cards.push(CardModel.normalizeCard({ id: `${turn.at || 0}-f`, kind: 'facts', rows: turn.facts }));
  }
  return cards;
}

async function renderConversation(id) {
  const stream = document.getElementById('cp-stream');
  if (!stream) return;
  const list = await Data.conversations();
  const target = id ? await Data.conversation(id) : list[0];
  if (!target) {
    showEmpty(true);
    setTitle('未命名对话', 'mp');
    return;
  }
  currentId = target.id;
  setTitle(target.title || '未命名对话', target.objectKey || target.id);
  bindComposerToObject(target.object);
  const turns = target.turns || [];
  if (!turns.length) {
    showEmpty(true);
    return;
  }
  showEmpty(false);
  LiveCards.reset();
  stream.replaceChildren(...turns.flatMap((t) => {
    const nodes = [];
    if (t.question) {
      const ask = document.createElement('div');
      ask.className = 'msg-user enter';
      ask.textContent = t.question;
      nodes.push(ask);
    }
    const wrap = document.createElement('div');
    wrap.className = 'turn enter';
    for (const card of turnCards(t, target)) {
      wrap.appendChild(renderCard(LiveCards.track(card), { density: 'companion' }));
    }
    nodes.push(wrap);
    return nodes;
  }));
  stream.scrollTop = stream.scrollHeight;
}

/* ============================================================
   输入条
   ------------------------------------------------------------
   和工作室同一个组件（composer.js），只是密度不同。上一版这里是一段
   手写的 <form>，跟工作室那段各写各的——同一个产品里两根条两个样。

   placeholder 跟着当前对象走（Vida 的 `Ask Vida anything about this page…`）：
   小窗是贴着屏幕上那个东西的，问的就是它，写死「继续问…」等于把这层
   上下文藏起来。
   ============================================================ */
let cpComposer = null;

function mountCompanionComposer() {
  const host = document.getElementById('cp-composer');
  if (!host || typeof Composer === 'undefined') return;
  cpComposer = Composer.create({
    placeholder: '继续问…',
    density: 'capsule',
    onSubmit: () => {},
  });
  host.replaceChildren(cpComposer.el);
}
mountCompanionComposer();

function bindComposerToObject(object) {
  if (!cpComposer) return;
  const name = object && (object.label || object.windowTitle || object.app);
  cpComposer.setPlaceholder(name ? `关于「${String(name).slice(0, 22)}」再问…` : '继续问…');
}

/* pin 切换 */
document.addEventListener('click', (e) => {
  const pin = e.target.closest('[title="固定"]');
  if (pin) pin.classList.toggle('is-on');
});

/* 有新一轮就重画。桥推的是「哪条对话动了」，不是整份数据。 */
Data.onChange(() => renderConversation(currentId));

/* ?empty=1 看空态 */
if (new URLSearchParams(location.search).has('empty')) {
  showEmpty(true);
  setTitle('未命名对话', 'mp');
} else {
  renderConversation(null);
}

/* 后台任务的进度，和工作室收的是同一份补丁 */
const cpBridge = window.magicPointerCompanion || window.magicPointerDashboard;
if (cpBridge?.onCardPatch) {
  cpBridge.onCardPatch((payload) => {
    if (payload?.cardId) LiveCards.patch(payload.cardId, payload.patch || {});
  });
}
