
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed: unknown) { let s = hash(String(seed)) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function makeOrb(seed: unknown, size = 64) {
  const r = rng(seed);
  const h1 = 68 + Math.floor(r() * 32);             
  const h3 = 178 + Math.floor(r() * 38);            
  const h2 = Math.round((h1 + h3) / 2);             
  const A = `hsl(${h1} 62% 68%)`;
  const M = `hsl(${h2} 56% 66%)`;
  const B = `hsl(${h3} 60% 66%)`;
  const id = 'o' + hash(seed as string).toString(36);
  const dur = (7 + r() * 5).toFixed(1);             

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


let currentId: string | null = null;
let currentWorkspaceRoot = '';

function setTitle(text: string, seed?: unknown) {
  const title = document.getElementById('cp-title');
  if (title) title.textContent = text;
  const orb = document.getElementById('cp-orb');
  if (orb) orb.replaceChildren();
  if (orb) orb.insertAdjacentHTML('afterbegin', makeOrb(seed || text || 'mp', 64));
}

function showEmpty(on: boolean) {
  const empty = document.getElementById('cp-empty');
  const stream = document.getElementById('cp-stream');
  if (empty) empty.hidden = !on;
  if (stream) stream.hidden = on;
}

function turnCards(turn: MagicPointerTurn, conversation: MagicPointerConversation | null) {
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
  for (const [i, art] of (turn.artifacts || []).entries()) {
    cards.push(CardModel.normalizeCard(art.kind === 'image'
      ? { id: `${turn.at || 0}-i${i}`, kind: 'image', src: art.src, caption: art.name, w: art.w, h: art.h }
      : { id: `${turn.at || 0}-r${i}`, kind: 'prose', eyebrow: '产物', title: art.name,
        answer: art.summary || '', actions: [{ id: `open:${art.name}`, label: '打开' }] }));
  }
  return cards;
}

async function renderConversation(id: string | null) {
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
  currentWorkspaceRoot = String(target.workspaceRoot || '');
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

let cpComposer: MagicPointerComposerInstance | null = null;
let cpRequestId: string | null = null;
let cpAgentSessionId: string | null = null;
const cpStopGate = Composer.createInFlightGate();

async function submitCompanionTurn(payload: { text: string; attachments: MagicPointerAttachment[] }) {
  const text = String(payload.text || '').trim();
  if (!text || cpRequestId || !currentWorkspaceRoot) return false;
  if (payload.attachments.length) return false;
  const requestId = globalThis.crypto?.randomUUID?.() || `companion-${Date.now()}`;
  cpRequestId = requestId;
  cpAgentSessionId = null;
  cpComposer?.running(true);
  try {
    const response = await Data.sendConversation(
      currentId,
      text,
      'workspace-write',
      requestId,
      currentWorkspaceRoot,
    );
    if (response?.ok && response.conversationId) {
      currentId = String(response.conversationId);
      try { await renderConversation(currentId); } catch { /* turn already persisted; keep the ack */ }
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    cpRequestId = null;
    cpAgentSessionId = null;
    cpComposer?.running(false);
  }
}

async function steerCompanionTurn(text: string) {
  if (!cpAgentSessionId) return false;
  const response = await Data.steerConversation(cpAgentSessionId, text);
  return response?.ok === true;
}

async function stopCompanionTurn() {
  if (!cpRequestId || !cpStopGate.tryEnter()) return false;
  const requestId = cpRequestId;
  try {
    return await Composer.callAcknowledged(async () => {
      const response = await Data.stopConversation(requestId);
      return response?.ok === true;
    });
  } finally {
    cpStopGate.leave();
  }
}

function mountCompanionComposer() {
  const host = document.getElementById('cp-composer');
  if (!host || typeof Composer === 'undefined') return;
  cpComposer = Composer.create({
    placeholder: '继续问…',
    density: 'capsule',
    allowAttachments: false,
    onSubmit: (payload) => submitCompanionTurn(payload),
    onSteer: (text) => steerCompanionTurn(text),
    onStop: () => stopCompanionTurn(),
  });
  host.replaceChildren(cpComposer.el);
}
mountCompanionComposer();

function bindComposerToObject(object: MagicPointerObject | null | undefined) {
  if (!cpComposer) return;
  const name = object && (object.label || object.windowTitle || object.app);
  cpComposer.setPlaceholder(name ? `关于「${String(name).slice(0, 22)}」再问…` : '继续问…');
}

document.addEventListener('click', (e) => {
  const pin = (e.target as Element).closest('[title="固定"]');
  if (pin) {
    const pinned = !pin.classList.contains('is-on');
    pin.classList.toggle('is-on', pinned);
    window.magicPointerCompanion?.pin?.(pinned);
    return;
  }
  if ((e.target as Element).closest('[title="展开到工作室"]')) {
    window.magicPointerCompanion?.expand?.();
    return;
  }
  if ((e.target as Element).closest('[title="关闭"]')) {
    window.magicPointerCompanion?.hide?.();
    return;
  }
});

Data.onChange(() => renderConversation(currentId));
Data.onConversationProgress((payload) => {
  if (!cpRequestId || payload.requestId !== cpRequestId || !payload.record) return;
  const fields = payload.record.fields && typeof payload.record.fields === 'object'
    ? payload.record.fields as Record<string, unknown> : {};
  if (String(payload.record.phase || '') === 'session_ready') {
    cpAgentSessionId = String(fields.sid || '') || null;
  }
});

if (new URLSearchParams(location.search).has('empty')) {
  showEmpty(true);
  setTitle('未命名对话', 'mp');
} else {
  renderConversation(null);
}

const cpBridge = window.magicPointerCompanion || window.magicPointerDashboard;
if (cpBridge?.onCardPatch) {
  cpBridge.onCardPatch((payload: MagicPointerCardPatchPayload) => {
    if (payload?.cardId) LiveCards.patch(payload.cardId, payload.patch || {});
  });
}
