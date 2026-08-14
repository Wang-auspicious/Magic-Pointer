/* exported renderSettings */
/* ============================================================
   设置
   ------------------------------------------------------------
   2026-08-13 全部重接：面板只保留有真实消费方的选项，每条都
   读写 fabric-settings.json（通过主进程 getFabricSettings /
   saveFabricSettings），启动时从磁盘回填真实值——不再有写死的
   假开关。
   ============================================================ */

/* 装机上真实存在的应用由主进程给；浏览器里预览时用这份兜底。 */
const APPS = [
  { id: 'chrome.exe',            name: 'Chrome',        icon: 'ic-window' },
  { id: 'Code.exe',              name: 'VS Code',       icon: 'ic-code' },
  { id: 'WeChat.exe',            name: '微信',          icon: 'ic-window' },
  { id: 'WindowsTerminal.exe',   name: 'Windows 终端',  icon: 'ic-term' },
  { id: 'EXCEL.EXE',             name: 'Excel',         icon: 'ic-file' },
  { id: 'Obsidian.exe',          name: 'Obsidian',      icon: 'ic-docs' },
  { id: '1Password.exe',         name: '1Password',     icon: 'ic-shield' },
  { id: 'Figma.exe',             name: 'Figma',         icon: 'ic-img' },
];

interface SettingsRow {
  k?: string;
  t?: string;
  v?: any;
  label?: string;
  desc?: string;
  btn?: string;
  action?: string;
  danger?: boolean;
  value?: string;
  tone?: string;
  opts?: string[];
  listOf?: 'apps' | 'captureModes' | 'glossary' | 'grants' | 'ports';
  [key: string]: any;
}
interface SettingsSection {
  title?: string;
  action?: { label?: string };
  rows: SettingsRow[];
}
interface SettingsPage {
  id: string;
  icon: string;
  name: string;
  desc: string;
  custom?: string;
  sections: SettingsSection[];
}
interface SettingsGroup {
  group: string;
  pages: SettingsPage[];
}

const READ_MODES = [
  ['follow_global',   '自动',        '先试结构层，读不到再用画面'],
  ['structured_only', '只用结构层', '拿不到就放弃，绝不猜'],
  ['local_screenshot', '只看画面',  '结构层读不出来的应用用这个'],
  ['deny',            '完全不读',   '这个应用里它什么都看不到'],
];

const SETTINGS: SettingsGroup[] = [
  { group: '常用', pages: [

    { id: 'general', icon: 'ic-window', name: '通用',
      desc: '开机、后台与更新。',
      sections: [
        { title: '运行', rows: [
          { k: 'general.autostart', t: 'toggle', label: '开机时启动',
            desc: '登录后静默驻留，不弹任何窗口。' },
          { k: 'general.keep_running', t: 'toggle', label: '关闭窗口后继续运行',
            desc: '关掉这个窗口不等于退出。它还在托盘里，划线和晃动照常可用。' },
        ]},
        { title: '通知', rows: [
          { k: 'general.notify_done', t: 'toggle', label: '长任务完成时通知我',
            desc: '只在你已经切走、且任务超过 20 秒时才推。' },
          { k: 'general.notify_fail', t: 'toggle', label: '失败时一定通知',
            desc: '这一条建议别关——静默失败比失败更糟。' },
        ]},
        { title: '更新', rows: [
          { k: 'general.channel', t: 'select', opts: ['稳定', '预览'],
            label: '更新通道', desc: '预览通道更早拿到修复，也更容易坏。' },
        ]},
      ]},

    { id: 'appearance', icon: 'ic-img', name: '外观',
      desc: '主题与舞台动效。',
      sections: [
        { title: '主题', rows: [
          { k: 'appearance.theme', t: 'segment', opts: ['浅色', '深色', '跟随系统'], label: '主题' },
          { k: 'appearance.material', t: 'select', opts: ['Mica', '不透明'],
            label: '窗口材质', desc: '持久窗口用 Mica；真模糊只留给指针旁那个临时浮层。' },
        ]},
        { title: '舞台', rows: [
          { k: 'appearance.sweep_height', t: 'slider', v: 52, label: '扫线高度',
            desc: '划线时高亮带的高度（窗口高度的比例）。' },
        ]},
      ]},

    { id: 'shortcuts', icon: 'ic-inject', name: '键盘快捷键',
      desc: '全局快捷键。',
      sections: [
        { title: '唤起', rows: [
          { k: 'sc.stage', t: 'hotkey', opts: ['Control+Alt+M', 'Control+Alt+Space', 'Control+Shift+Space'],
            label: '叫出指针旁的胶囊' },
        ]},
      ]},
  ]},

  { group: '唤起', pages: [

    { id: 'activation', icon: 'ic-shake', name: '唤醒与指向',
      desc: '平时它完全不可见。这里决定什么动作会把它叫出来。',
      sections: [
        { title: '入口', rows: [
          { k: 'act.wiggle', t: 'toggle', label: '晃动鼠标唤醒',
            desc: '快速来回晃两下，胶囊出现在指针旁边。' },
          { k: 'act.wiggle_sens', t: 'slider', v: 55, label: '晃动灵敏度',
            desc: '往左更不容易误触，往右更容易叫出来。' },
          { k: 'act.hold', t: 'select', opts: ['180 ms', '240 ms', '320 ms'],
            label: '按多久算长按', desc: '短于这个时长按普通点击处理，不打扰你。' },
        ]},
        { title: '出现之后', rows: [
          { k: 'act.drift', t: 'toggle', label: '目标窗口被切走时暂停',
            desc: '长任务绑着当初那个窗口。窗口没了就停下来问你，绝不改到当前这个。' },
        ]},
        { title: '不打扰', rows: [
          { k: 'act.mute_apps', t: 'applist', listOf: 'apps', label: '这些应用里不出现',
            desc: '点 + 添加应用；点 × 移除。', v: [] },
        ]},
      ]},

    { id: 'voice', icon: 'ic-mic', name: '语音',
      desc: '转写在本机完成。说出来的内容不会因为开了语音就多传一份。',
      sections: [
        { title: '输入方式', rows: [
          { k: 'voice.enabled', t: 'toggle', label: '划完线先开语音输入',
            desc: '关掉就是默认打字。' },
        ]},
        { title: '快慢取舍', rows: [
          { k: 'voice.resident', t: 'toggle', label: '让模型常驻',
            desc: '不常驻的话每次都要重新加载，实测第一句要等 4 秒多。常驻大约多占 700MB 内存。' },
        ]},
        { title: '它总是听错的词', action: { label: '+ 添加' }, rows: [
          { k: 'voice.glossary', t: 'termlist', listOf: 'glossary', label: '',
            desc: '写进来之后，它在对应的地方会优先按这个来。', v: [] },
        ]},
      ]},
  ]},

  { group: '感知', pages: [

    { id: 'capture', icon: 'ic-eye', name: '感知',
      desc: '它靠两条路看屏幕：一条是读窗口的结构，一条是看画面。结构层准，画面是兜底。',
      sections: [
        { title: '默认怎么读', rows: [
          { k: 'cap.mode', t: 'select', opts: READ_MODES.map((m) => m[1]),
            label: '读取方式', desc: '自动 = 先试结构层，读不到再看画面。看画面得到的结果会标出来。' },
          { k: 'cap.upload', t: 'toggle', label: '允许把画面发给模型',
            desc: '关掉之后画面只在本机处理。当前配的模型本来也读不了图。' },
        ]},
        { title: '这些应用单独设', action: { label: '+ 添加应用' }, rows: [
          { k: 'cap.per_app', t: 'applist2', listOf: 'captureModes', label: '',
            desc: '有些应用天生读不出结构（比如微信），给它单独指一条路更省事。', v: [] },
        ]},
      ]},

    { id: 'privacy', icon: 'ic-shield', name: '隐私',
      desc: '这些应用一进来就该被抹掉。',
      sections: [
        { title: '这些应用完全不看', action: { label: '+ 添加应用' }, rows: [
          { k: 'pv.apps', t: 'applist', listOf: 'apps', label: '',
            desc: '在这些应用里，它不读、不截、也不记。', v: [] },
        ]},
      ]},
  ]},

  { group: '行动', pages: [

    { id: 'permissions', icon: 'ic-shield', name: '权限',
      desc: '按后果分四档。越往下越不可逆，默认也越保守。',
      sections: [
        { title: '默认怎么办', rows: [
          { k: 'perm.read', t: 'select', opts: ['直接做', '每次问我'],
            label: '读东西', desc: '看窗口内容、读选中的文字。' },
          { k: 'perm.write', t: 'select', opts: ['直接做', '每次问我'],
            label: '写东西', desc: '填进输入框、放进剪贴板。' },
          { k: 'perm.send', t: 'select', opts: ['每次问我', '一律不许'],
            label: '往外发', desc: '发邮件、发消息、提交表单。' },
          { k: 'perm.irrev', t: 'select', opts: ['问两次', '一律不许'],
            label: '收不回来的事', desc: '删除、覆盖、直接改别人窗口里的内容。', danger: true },
        ]},
        { title: '已经给出去的授权', action: { label: '+ 添加' }, rows: [
          { k: 'perm.grants', t: 'grantlist', listOf: 'grants', label: '',
            desc: '授权不跨应用、不跨项目、也不跨时间。到期自动收回。', v: [] },
        ]},
      ]},

    { id: 'capabilities', icon: 'ic-spark', name: '能力',
      desc: '它会做的那些事。',
      sections: [
        { title: '内置', rows: [
          { k: '_recipes', t: 'status', label: '内置动作', desc: '改写、翻译、汇总、加进日历、写回原处…',
            value: '39 条', tone: 'teal' },
        ]},
      ]},

    { id: 'connections', icon: 'ic-plug', name: '连接',
      desc: '外部的东西。每一个都要单独授权，也可以随时断开。',
      sections: [
        { title: '浏览器', rows: [
          { k: 'conn.devtools', t: 'toggle', label: '读浏览器里正在看的页面',
            desc: '只连你明确填的本机端口。页面地址和内容不会出现在任何状态摘要里。' },
          { k: 'conn.ports', t: 'portlist', listOf: 'ports', label: '', desc: '只接受本机地址。',
            v: ['9222'] },
        ]},
      ]},
  ]},

  { group: '归档', pages: [

    { id: 'stash', icon: 'ic-stash', name: '收藏箱',
      desc: '截图、复制的图落盘到哪里。',
      sections: [
        { title: '落盘', rows: [
          { k: 'stash.dir', t: 'path', label: '保存到' },
          { k: 'stash.clipboard', t: 'toggle', label: '同时把路径放进剪贴板',
            desc: '图还在剪贴板里，路径也在。终端里粘出来是路径，图片软件里粘出来是图。' },
          { k: 'stash.burst', t: 'select', opts: ['30 秒', '2 分钟', '10 分钟'],
            label: '多久算「一起进来的」', desc: '这个时间内连着存的东西，在画布上会被圈成一堆。' },
        ]},
      ]},

    { id: 'storage', icon: 'ic-docs', name: '存储',
      desc: '本地留多久。',
      sections: [
        { title: '保留', rows: [
          { k: 'st.timeline', t: 'select', opts: ['7 天', '30 天', '永久'],
            label: '时间线', desc: '会话与划线记录。' },
          { k: 'st.stash', t: 'select', opts: ['90 天', '永久'],
            label: '收藏箱', desc: '过期只清索引，文件本身留在磁盘上。' },
          { k: 'st.artifacts', t: 'select', opts: ['30 天', '永久'],
            label: '产物', desc: '生成的草稿与导出文件。' },
        ]},
      ]},
  ]},
];

/* ============================================================
   键名翻译：界面键 <-> 桥端 schema 键 + 值双向翻译。
   这里只有真实存在的设置键；没有消费方的行已经从面板里删掉了。
   ============================================================ */
const KEYMAP: Record<string, [string, (v: unknown) => unknown, (disk: unknown) => unknown]> = {
  'general.autostart': ['general.launch_at_login', identity, identity],
  'general.keep_running': ['general.keep_running', identity, identity],
  'general.channel': ['general.update_channel', (v) => (v === '预览' ? 'preview' : 'stable'), (d) => (d === 'preview' ? '预览' : '稳定')],
  'general.notify_done': ['notifications.completion', identity, identity],
  'general.notify_fail': ['notifications.failure', identity, identity],
  'appearance.theme': ['appearance.theme', (v) => ({ 浅色: 'light', 深色: 'dark', '跟随系统': 'system' }[String(v)] || 'system'), (d) => ({ light: '浅色', dark: '深色', system: '跟随系统' }[String(d)] || '跟随系统')],
  'appearance.material': ['appearance.material', (v) => (v === '不透明' ? 'solid' : 'translucent'), (d) => (d === 'solid' ? '不透明' : 'Mica')],
  'appearance.sweep_height': ['appearance.sweep_height_ratio', (v) => Math.max(0.15, Math.min(1.5, Number(v) / 100)), (d) => Math.round(Number(d || 0.52) * 100)],
  'sc.stage': ['shortcuts.wake', identity, identity],
  'act.wiggle': ['activation.wake_mode', (v) => (v ? 'wiggle_hotkey' : 'hotkey'), (d) => d !== 'hotkey'],
  'act.wiggle_sens': ['activation.sensitivity', (v) => Math.max(0, Math.min(1, Number(v) / 100)), (d) => Math.round(Number(d || 0.55) * 100)],
  'act.hold': ['activation.gesture_arm_delay_ms', (v) => Number(String(v).match(/\d+/)?.[0] || 240), (d) => `${d} ms`],
  'act.drift': ['activation.keep_current_app_focus', identity, identity],
  'act.mute_apps': ['activation.disabled_apps', identity, identity],
  'voice.enabled': ['interaction.default_input_mode', (v) => (v ? 'voice' : 'text'), (d) => d === 'voice'],
  'voice.resident': ['interaction.voice_resident_enabled', identity, identity],
  'voice.glossary': ['interaction.voice_glossaries', glossaryToDisk, glossaryFromDisk],
  'cap.mode': ['privacy.default_capture_mode', (v) => (READ_MODES.find((m) => m[1] === v) || READ_MODES[0])[0], (d) => (READ_MODES.find((m) => m[0] === d) || READ_MODES[0])[1]],
  'cap.upload': ['privacy.upload_screenshots', identity, identity],
  'cap.per_app': ['privacy.app_capture_modes', captureModesToDisk, captureModesFromDisk],
  'pv.apps': ['privacy.sensitive_apps', identity, identity],
  'perm.read': ['permissions.default_read', (v) => (v === '直接做' ? 'allow' : 'confirm'), (d) => (d === 'allow' ? '直接做' : '每次问我')],
  'perm.write': ['permissions.default_write', (v) => (v === '直接做' ? 'allow' : 'confirm'), (d) => (d === 'allow' ? '直接做' : '每次问我')],
  'perm.send': ['permissions.default_send', (v) => (v === '一律不许' ? 'deny' : 'confirm'), (d) => (d === 'deny' ? '一律不许' : '每次问我')],
  'perm.irrev': ['permissions.default_destructive', (v) => (v === '一律不许' ? 'deny' : 'confirm'), (d) => (d === 'deny' ? '一律不许' : '问两次')],
  'perm.grants': ['permissions.scoped_grants', grantsToDisk, grantsFromDisk],
  'conn.devtools': ['connections.browser_devtools_enabled', identity, identity],
  'conn.ports': ['connections.browser_devtools_endpoints', (v) => (v as any[]).map((p) => `http://127.0.0.1:${String(p).replace(/[^\d]/g, '')}`).filter((p: string) => p.length > 17), (d) => (d as any[]).map((u) => String(u).split(':').pop())],
  'stash.dir': ['stash.dir', identity, identity],
  'stash.clipboard': ['stash.clipboard', identity, identity],
  'stash.burst': ['stash.burst_window_ms', (v) => (v === '10 分钟' ? 600000 : v === '30 秒' ? 30000 : 120000), (d) => ({ 30000: '30 秒', 600000: '10 分钟' }[Number(d)] || '2 分钟')],
  'st.timeline': ['privacy.retain_captures_days', (v) => (v === '永久' ? 0 : parseInt(String(v), 10)), (d) => (Number(d) <= 0 ? '永久' : `${d} 天`)],
  'st.stash': ['privacy.retain_artifacts_days', (v) => (v === '永久' ? 0 : parseInt(String(v), 10)), (d) => (Number(d) <= 0 ? '永久' : `${d} 天`)],
  'st.artifacts': ['privacy.retain_audit_days', (v) => (v === '永久' ? 3650 : parseInt(String(v), 10)), (d) => (Number(d) >= 3650 ? '永久' : `${d} 天`)],
};

function identity(v: unknown) { return v; }

function glossaryToDisk(v: unknown) {
  const out: Record<string, string[]> = {};
  for (const [term, scope] of (v as any[]) || []) {
    if (!term) continue;
    const key = scope === '所有地方' ? 'global' : String(scope || 'global');
    (out[key] = out[key] || []).push(String(term));
  }
  return out;
}
function glossaryFromDisk(d: unknown) {
  const entries = Object.entries((d as Record<string, string[]>) || {});
  return entries.flatMap(([scope, terms]) =>
    (terms || []).map((term) => [term, scope === 'global' ? '所有地方' : scope]));
}
function captureModesToDisk(v: unknown) {
  const out: Record<string, string> = {};
  for (const [app, mode] of (v as any[]) || []) {
    out[String(app)] = mode === 'pixel' ? 'local_screenshot' : 'structured_only';
  }
  return out;
}
function captureModesFromDisk(d: unknown) {
  return Object.entries((d as Record<string, string>) || {}).map(([app, mode]) => [
    app, mode === 'local_screenshot' ? 'pixel' : 'struct',
  ]);
}
function grantsToDisk(v: unknown) {
  return (v as any[]).map(([risk, app, proj, ttl]) => {
    const days = parseInt(String(ttl || '7 天').match(/\d+/)?.[0] || '7', 10);
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    return { id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, decision: 'allow', risk, app, project: proj, expires_at: expires };
  });
}
function grantsFromDisk(d: unknown) {
  return (d as any[]).map((g) => {
    const risk = String(g.risk || 'send');
    const ttl = g.expires_at ? Math.max(0, Math.ceil((Date.parse(g.expires_at) - Date.now()) / 86400000)) : 7;
    return [risk, String(g.app || ''), String(g.project || ''), `${ttl} 天`];
  });
}

function translateToDisk(key: string, value: unknown): { key: string; value: unknown } | null {
  const mapped = KEYMAP[key];
  if (!mapped) return null;
  const translated = mapped[1](value);
  if (translated === undefined) return null;
  return { key: mapped[0], value: translated };
}

function valueFromDisk(key: string, disk: Record<string, unknown>): unknown {
  const mapped = KEYMAP[key];
  if (!mapped) return undefined;
  const parts = mapped[0].split('.');
  let node: any = disk;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  if (node === undefined || node === null) return undefined;
  return mapped[2](node);
}

function writeSetting(key: string, value: unknown) {
  const api = window.magicPointerDashboard;
  if (!api?.saveFabricSettings) return;
  const translated = translateToDisk(key, value);
  if (!translated) return;
  const patch: Record<string, unknown> = {};
  translated.key.split('.').reduce((o: Record<string, unknown>, part: string, i: number, arr: string[]) => {
    o[part] = i === arr.length - 1 ? translated.value : {};
    return o;
  }, patch);
  api.saveFabricSettings(patch);
}

/* 面板回填：从磁盘真实设置取值，覆盖 SETTINGS 里写死的 v:。 */
function hydrateSettings(): void {
  const api = window.magicPointerDashboard;
  if (!api?.getFabricSettings) return;
  api.getFabricSettings().then((response: any) => {
    const disk = response?.ok ? (response.settings || {}) : {};
    if (!disk || typeof disk !== 'object') return;
    const rows: SettingsRow[] = [];
    for (const group of SETTINGS) {
      for (const page of group.pages) {
        for (const section of page.sections) {
          rows.push(...section.rows);
        }
      }
    }
    for (const row of rows) {
      if (!row.k || row.k.startsWith('_')) continue;
      const value = valueFromDisk(row.k, disk as Record<string, unknown>);
      if (value !== undefined) row.v = value;
    }
    renderSettings();
  }).catch(() => { /* 主进程未就绪时保留写死的默认展示 */ });
}

/* ============================================================
   控件
   ============================================================ */

const TONE: Record<string, string> = { green: 'pill-green', amber: 'pill-amber', teal: 'pill-teal', muted: '' };
const appById = (id: string) => APPS.find((a) => a.id === id) || { id, name: id, icon: 'ic-window' };

function icon(id: string, cls = '') { return `<svg class="${cls}"><use href="#${id}"/></svg>`; }

function pickerApp(id: string) {
  const a = appById(id);
  return `<button class="picker" data-picker="app" data-value="${id}">${icon(a.icon)}${a.name}${icon('ic-chev', 'caret')}</button>`;
}
function pickerFrom(list: string[][], value: string) {
  const hit = list.find((o) => o[0] === value) || list[0];
  return `<button class="picker" data-picker="mode" data-value="${hit[0]}">${hit[1]}${icon('ic-chev', 'caret')}</button>`;
}

function ctrl(r: SettingsRow): string {
  switch (r.t) {
    case 'toggle':
      return `<button class="sw${r.v ? ' is-on' : ''}" role="switch" aria-checked="${!!r.v}" data-k="${r.k}"><span></span></button>`;
    case 'select':
      return `<button class="sel" data-k="${r.k}">${r.v || r.opts?.[0]}${icon('ic-chev')}</button>`;
    case 'segment':
      return `<span class="seg-toggle sm">${(r.opts as any[]).map((o) => `<button class="${o === r.v ? 'is-on' : ''}">${o}</button>`).join('')}</span>`;
    case 'hotkey':
      return `<button class="sel" data-k="${r.k}">${r.v || r.opts?.[0]}${icon('ic-chev')}</button>`;
    case 'slider':
      return '';   // 刻度条要占满一行，单独渲染
    case 'status':
      return `${r.value ? `<span class="pill ${(r.tone && TONE[r.tone]) || ''}">${r.value}</span>` : ''}`;
    case 'path':
      return `<input class="lin lin-path" data-k="${r.k}" value="${String(r.v || '').replace(/"/g, '&quot;')}" spellcheck="false">`;
    default:
      return '';
  }
}

/* ---- 列表型：一律可增删，绝不让人手写 ---- */
function listRows(r: SettingsRow): string | null {
  const values = (r.v || []) as any[];
  switch (r.t) {
    case 'applist':
      return values.map((id) => `<div class="lrow">${pickerApp(id)}<span class="lgrow"></span>
        <button class="lx" title="移除">${icon('ic-x')}</button></div>`).join('');
    case 'applist2':
      return values.map(([id, mode]) => {
        const m = READ_MODES.find((x) => x[1] === mode || x[0] === mode) || READ_MODES[0];
        return `<div class="lrow">${pickerApp(id)}<span class="lsep">用</span>${pickerFrom(READ_MODES, m[0])}
          <small class="lhint">${m[2]}</small><span class="lgrow"></span>
          <button class="lx" title="移除">${icon('ic-x')}</button></div>`;
      }).join('');
    case 'termlist':
      return values.map(([term, scope]) => `<div class="lrow">
        <input class="lin" value="${String(term).replace(/"/g, '&quot;')}" spellcheck="false">
        <span class="lsep">用在</span>
        <button class="picker" data-picker="scope">${scope}${icon('ic-chev', 'caret')}</button>
        <span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`).join('');
    case 'grantlist':
      return values.map(([risk, app, proj, ttl]) => {
        const label = (RISK.find((x) => x[0] === risk) || RISK[0])[1];
        return `<div class="lrow">
          <button class="picker" data-picker="risk" data-value="${risk}">${label}${icon('ic-chev', 'caret')}</button>
          <span class="lsep">在</span>${pickerApp(app)}
          <span class="lsep">的</span><button class="picker">${proj}${icon('ic-chev', 'caret')}</button>
          <span class="lgrow"></span>
          <span class="lttl">${ttl}后到期</span>
          <button class="lx">${icon('ic-x')}</button></div>`;
      }).join('');
    case 'portlist':
      return values.map((port) => `<div class="lrow">
        <span class="lfix">127.0.0.1 :</span><input class="lin lin-sm" value="${port}" inputmode="numeric">
        <span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`).join('');
    default: return null;
  }
}

const RISK = [
  ['read',  '读取'],
  ['write', '写入'],
  ['send',  '对外发送'],
  ['irrev', '不可逆操作'],
];

/* 扩展页：内置动作目录（只读展示）。 */
const EXT_TABS: [string, string, number][] = [
  ['builtin', '内置动作', 39],
  ['apps',    '已接入的应用', 4],
];

const EXT_ITEMS: Record<string, [string, string, string, number, string][]> = {
  builtin: [
    ['ic-pen',     '改写这段',   '按你给的方向重写选中的文字', 1, 'read'],
    ['ic-docs',    '压成三句',   '把一屏内容缩到能一眼看完', 1, 'read'],
    ['ic-inject',  '写回原处',   '把结果送回你划线的那个位置', 1, 'write'],
    ['ic-file',    '加进日历',   '识别时间和地点，先在本地生成草稿', 1, 'write'],
    ['ic-search',  '找出处',     '沿来源链一路回溯到最初那个对象', 1, 'read'],
    ['ic-handoff', '交给 Agent', '把现场原样交给 Claude Code 或 Codex', 1, 'send'],
  ],
  apps: [
    ['ic-code',   'VS Code',      '读文件、光标位置和选区', 1, 'read'],
    ['ic-term',   'Windows 终端', '读当前输出；写回走剪贴板', 1, 'write'],
    ['ic-window', 'Chrome',       '读页面结构，只连本机回环端口', 1, 'read'],
    ['ic-window', '微信',         '结构读不出来时走 SurfaceAdapter + 画面', 1, 'read'],
  ],
};

const RISK_TAG: Record<string, string[]> = {
  read:  ['pill-indigo', '读取'],
  write: ['pill-amber', '写入'],
  send:  ['pill-terracotta', '对外发送'],
};

function renderExtensions(tab = 'builtin'): string {
  const list = EXT_ITEMS[tab] || [];
  const tabs = `<div class="ext-tabs">${EXT_TABS.map(([id, name, n]) =>
      `<button class="tab${id === tab ? ' is-on' : ''}" data-ext="${id}">${name} <em>${n}</em></button>`).join('')}
      <span class="lgrow"></span>
      <span class="set-search sm">${icon('ic-search')}<input placeholder="搜索…"></span>
    </div>`;
  const body = list.length
    ? `<div class="card ext-list">${list.map(([ic, name, desc, on, risk]) => {
        const [cls, label] = RISK_TAG[risk];
        return `<div class="ext-row">
          <span class="ext-ic">${icon(ic)}</span>
          <span class="ext-txt"><b>${name}</b><small>${desc}</small></span>
          <span class="pill ${cls} xs">${label}</span>
          <button class="sw${on ? ' is-on' : ''}" role="switch" aria-checked="${!!on}" disabled><span></span></button>
        </div>`;
      }).join('')}</div>`
    : `<div class="card ext-empty">${icon('ic-plug')}
        <b>还没有连接任何外部能力</b>
        <small>外部连接在「连接」页配置。</small></div>`;
  return tabs + body;
}

/* ============================================================
   渲染
   ============================================================ */

// classic-script 全局 API（studio/dashboard 等文件直接调用 renderSettings）。
function renderSettings() {
  const nav = document.getElementById('set-nav') as HTMLElement;
  const body = document.getElementById('set-body') as HTMLElement;
  if (!nav || !body) return;

  const pages = SETTINGS.flatMap((g) => g.pages);

  nav.innerHTML = `<div class="set-search">${icon('ic-search')}<input placeholder="搜索设置…" id="set-q"></div>`
    + SETTINGS.map((g) => `<div class="set-group">${g.group}</div>`
      + g.pages.map((p) => `<button class="set-navitem${p === pages[0] ? ' is-on' : ''}" data-page="${p.id}">
          ${icon(p.icon)}<span>${p.name}</span></button>`).join('')).join('');

  body.innerHTML = pages.map((p, pi) => `<div class="set-page" data-page="${p.id}"${pi ? ' hidden' : ''}>
    <header class="set-head">
      <div><h1>${p.name}</h1>${p.desc ? `<p>${p.desc}</p>` : ''}</div>
    </header>
    ${p.custom === 'ext' ? renderExtensions() : ''}
    ${p.sections.map((sec) => {
      const plain = sec.rows.filter((r) => !listRows(r));
      const lists = sec.rows.filter((r) => listRows(r));
      return `<section class="set-section">
        ${sec.title || sec.action ? `<div class="set-sechead">
          <h2>${sec.title || ''}</h2>
          ${sec.action ? `<button class="btn btn-quiet sm" data-list-add="${lists[0]?.k || ''}">${sec.action.label}</button>` : ''}
        </div>` : ''}
        ${plain.filter((r) => r.t !== 'slider').length ? `<div class="card set-rows">${plain.filter((r) => r.t !== 'slider').map((r) => `
          <div class="set-row${r.danger ? ' is-danger' : ''}">
            <span class="set-label"><b>${r.label}</b>${r.desc ? `<small>${r.desc}</small>` : ''}</span>
            <span class="set-ctrl">${ctrl(r)}</span>
          </div>`).join('')}</div>` : ''}
        ${sec.rows.filter((r) => r.t === 'slider').map((r) => `<div class="set-slider">
          <div class="set-label"><b>${r.label}</b>${r.desc ? `<small>${r.desc}</small>` : ''}</div>
          <div class="tick" data-k="${r.k}" data-v="${r.v}"></div>
        </div>`).join('')}
        ${lists.map((r) => `<div class="card set-list">
          ${listRows(r)}
          ${(r.v || []).length ? '' : '<div class="lempty">还没有添加任何一条</div>'}
        </div>${r.desc ? `<p class="set-note">${r.desc}</p>` : ''}`).join('')}
      </section>`;
    }).join('')}
  </div>`).join('');
  initTicks();
}

/* ============================================================
   交互：所有控件写真实设置
   ============================================================ */

function setTheme(theme: string) {
  document.documentElement.dataset.theme =
    theme === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
  writeSetting('appearance.theme', theme);
  window.magicPointerDashboard?.setTheme?.(theme);
}

/* 从 DOM 读一个列表控件的当前值 */
function readListValue(listKey: string): unknown {
  const card = document.querySelector(`[data-list-add="${listKey}"]`)?.parentElement?.nextElementSibling as HTMLElement | null;
  const container = card && card.classList.contains('set-list') ? card : document.querySelector('.set-list') as HTMLElement | null;
  if (!container) return undefined;
  const rows = Array.from(container.querySelectorAll(':scope > .lrow'));
  const rowFor = KEYMAP[listKey];
  if (!rowFor) return undefined;
  switch (rowFor[0]) {
    case 'activation.disabled_apps':
    case 'privacy.sensitive_apps':
      return rows.map((row) => (row.querySelector('[data-picker="app"]') as HTMLElement)?.dataset.value || '');
    case 'privacy.app_capture_modes':
      return rows.map((row) => [
        (row.querySelector('[data-picker="app"]') as HTMLElement)?.dataset.value || '',
        row.querySelector('.lhint') ? (row.querySelector('[data-picker="mode"]')?.textContent?.includes('画面') ? 'pixel' : 'struct') : 'struct',
      ]);
    case 'interaction.voice_glossaries':
      return rows.map((row) => [
        (row.querySelector('input') as HTMLInputElement)?.value || '',
        (row.querySelector('[data-picker="scope"]') as HTMLElement)?.textContent?.trim() || '所有地方',
      ]);
    case 'connections.browser_devtools_endpoints':
      return rows.map((row) => (row.querySelector('input') as HTMLInputElement)?.value || '');
    case 'permissions.scoped_grants':
      return rows.map((row) => [
        (row.querySelector('[data-picker="risk"]') as HTMLElement)?.dataset.value || 'send',
        (row.querySelector('[data-picker="app"]') as HTMLElement)?.dataset.value || '',
        row.querySelectorAll('.picker')[1]?.textContent?.trim() || '',
        (row.querySelector('.lttl') as HTMLElement)?.textContent?.replace('后到期', '') || '7 天',
      ]);
    default:
      return undefined;
  }
}

/* 列表加一条默认项 */
function addListEntry(listKey: string): void {
  const card = document.querySelector('[data-list-add]')?.parentElement?.nextElementSibling as HTMLElement | null;
  const container = card && card.classList.contains('set-list') ? card : document.querySelector('.set-list') as HTMLElement | null;
  if (!container) return;
  const rowFor = KEYMAP[listKey];
  if (!rowFor) return;
  const listKeyName = listKey;
  if (listKeyName === 'conn.ports') {
    container.insertAdjacentHTML('beforeend', `<div class="lrow"><span class="lfix">127.0.0.1 :</span><input class="lin lin-sm" value="9222" inputmode="numeric"><span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`);
  } else if (listKeyName === 'voice.glossary') {
    container.insertAdjacentHTML('beforeend', `<div class="lrow"><input class="lin" placeholder="词" spellcheck="false"><span class="lsep">用在</span><button class="picker" data-picker="scope">所有地方${icon('ic-chev', 'caret')}</button><span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`);
  } else if (listKeyName === 'cap.per_app') {
    container.insertAdjacentHTML('beforeend', `<div class="lrow">${pickerApp('WeChat.exe')}<span class="lsep">用</span>${pickerFrom(READ_MODES, 'local_screenshot')}<small class="lhint">只看画面</small><span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`);
  } else if (listKeyName === 'perm.grants') {
    container.insertAdjacentHTML('beforeend', `<div class="lrow"><button class="picker" data-picker="risk" data-value="send">对外发送${icon('ic-chev', 'caret')}</button><span class="lsep">在</span>${pickerApp('Code.exe')}<span class="lsep">的</span><button class="picker">所有项目</button><span class="lgrow"></span><span class="lttl">7 天后到期</span><button class="lx">${icon('ic-x')}</button></div>`);
  } else {
    container.insertAdjacentHTML('beforeend', `<div class="lrow">${pickerApp('chrome.exe')}<span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`);
  }
  container.querySelector('.lempty')?.remove();
  writeSetting(listKey, readListValue(listKey));
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const nav = target.closest('.set-navitem') as HTMLElement | null;
  if (nav) {
    document.querySelectorAll('.set-navitem').forEach((n) => n.classList.remove('is-on'));
    nav.classList.add('is-on');
    document.querySelectorAll<HTMLElement>('.set-page').forEach((p) => { p.hidden = p.dataset.page !== nav.dataset.page; });
    document.getElementById('set-body')!.scrollTop = 0;
    return;
  }
  const sw = target.closest('.sw') as HTMLElement | null;
  if (sw) {
    const on = !sw.classList.contains('is-on');
    sw.classList.toggle('is-on', on);
    sw.setAttribute('aria-checked', String(on));
    writeSetting(sw.dataset.k as string, on);
    return;
  }
  const sel = target.closest('.sel') as HTMLElement | null;
  if (sel) {
    const key = sel.dataset.k as string;
    const row = SETTINGS.flatMap((g) => g.pages).flatMap((p) => p.sections).flatMap((s) => s.rows).find((r) => r.k === key);
    const opts = row?.opts || [];
    if (!opts.length) return;
    const current = sel.textContent?.trim();
    const index = opts.indexOf(current || '');
    const next = opts[(index + 1) % opts.length];
    sel.textContent = next + icon('ic-chev');
    row!.v = next;
    writeSetting(key, next);
    return;
  }
  const seg = target.closest('.seg-toggle.sm button') as HTMLElement | null;
  if (seg) {
    const parent = seg.parentElement as HTMLElement;
    parent.querySelectorAll('button').forEach((b) => b.classList.remove('is-on'));
    seg.classList.add('is-on');
    const value = seg.textContent || '';
    if (value === '深色') setTheme('dark');
    else if (value === '浅色') setTheme('light');
    else if (value === '跟随系统') setTheme('system');
    return;
  }
  const addBtn = target.closest('[data-list-add]') as HTMLElement | null;
  if (addBtn) {
    addListEntry(addBtn.dataset.listAdd as string);
    return;
  }
  const lx = target.closest('.lx') as HTMLElement | null;
  if (lx) {
    const card = lx.closest('.set-list') as HTMLElement | null;
    (lx.closest('.lrow') as HTMLElement).remove();
    const addBtnHost = card?.previousElementSibling as HTMLElement | null;
    const listKey = addBtnHost?.querySelector('[data-list-add]')?.getAttribute('data-list-add');
    if (listKey) writeSetting(listKey, readListValue(listKey));
    return;
  }
  const ext = target.closest('[data-ext]') as HTMLElement | null;
  if (ext) {
    const page = ext.closest('.set-page') as HTMLElement;
    page.querySelector('.ext-tabs')!.remove();
    page.querySelector('.ext-list, .ext-empty')?.remove();
    page.querySelector('.set-head')!.insertAdjacentHTML('afterend', renderExtensions(ext.dataset.ext));
    return;
  }
});

/* 列表输入与路径输入：失焦/回车时写设置 */
document.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const card = input.closest('.set-list');
  if (card) {
    const addBtnHost = card.previousElementSibling as HTMLElement | null;
    const listKey = addBtnHost?.querySelector('[data-list-add]')?.getAttribute('data-list-add');
    if (listKey) writeSetting(listKey, readListValue(listKey));
    return;
  }
  if (input.classList.contains('lin-path')) {
    writeSetting(input.dataset.k as string, input.value);
    return;
  }
});

/* 搜索：只过滤左栏，不重排右边——省得你一边打字一边页面在跳 */
document.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).id !== 'set-q') return;
  const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>('.set-navitem').forEach((n) => {
    n.hidden = q ? !n.textContent.toLowerCase().includes(q) : false;
  });
  document.querySelectorAll<HTMLElement>('.set-group').forEach((g) => {
    let sib = g.nextElementSibling, any = false;
    while (sib && sib.classList.contains('set-navitem')) {
      if (!(sib as HTMLElement).hidden) any = true;
      sib = sib.nextElementSibling;
    }
    g.hidden = !any;
  });
});

/* ============================================================
   刻度滑杆
   ============================================================ */

const TICKS = 40;

function paintTick(el: HTMLElement, value: number) {
  const bars = el.querySelectorAll<HTMLElement>('i');
  const at = (value / 100) * (TICKS - 1);
  bars.forEach((b, i) => {
    const d = Math.abs(i - at) / TICKS;
    const fall = Math.min(1, d * 5.2);
    b.style.height = (5 + fall * 29).toFixed(1) + 'px';
    b.style.opacity = (0.12 + fall * 0.72).toFixed(3);
  });
  const knob = el.querySelector('.tick-knob') as HTMLElement | null;
  if (knob) {
    knob.style.left = (14 + (el.clientWidth - 28) * (value / 100)).toFixed(1) + 'px';
    knob.firstChild!.nodeValue = String(Math.round(value));
  }
  el.dataset.v = String(Math.round(value));
}

function initTicks() {
  document.querySelectorAll<HTMLElement>('.tick').forEach((el) => {
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    el.innerHTML = Array.from({ length: TICKS }, () => '<i></i>').join('')
      + '<span class="tick-knob">' + el.dataset.v + '<em>灵敏度</em></span>';
    paintTick(el, Number(el.dataset.v));
    new ResizeObserver(() => paintTick(el, Number(el.dataset.v))).observe(el);

    const toValue = (clientX: number) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((clientX - r.left - 14) / (r.width - 28)) * 100));
    };
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.classList.add('is-grab');
      el.setPointerCapture(e.pointerId);
      paintTick(el, toValue(e.clientX));
    });
    el.addEventListener('pointermove', (e) => { if (dragging) paintTick(el, toValue(e.clientX)); });
    el.addEventListener('pointerup', () => {
      dragging = false;
      el.classList.remove('is-grab');
      writeSetting(el.dataset.k as string, Number(el.dataset.v));
    });
  });
}

/* 面板打开时回填真实值 */
hydrateSettings();
