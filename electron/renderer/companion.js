/* 随行窗 —— 与工作室共用会话，这里只管本窗的渲染与交互 */

/* 头像/球：与 studio.js 同一套；装了 @oreo-design/avatar 后统一换掉 */
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function rng(seed){let s=hash(String(seed))||1;return()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
const PALETTES=[['#F6C9B0','#E8A0A8','#B98BC9'],['#F3D9A8','#EFB183','#D98A6A'],['#CFE0CE','#A8CBB4','#7FB6A6'],
                ['#D9DCF2','#B6BEEA','#8E9BDD'],['#F5DCC2','#DFC0A6','#B99C86'],['#E7D3EE','#C9AEDD','#A487C6']];
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

const orb = document.getElementById('cp-orb');
if (orb) orb.innerHTML = makeOrb(document.getElementById('cp-title')?.textContent || 'mp', 64);

/* 输入框随内容长高 */
document.addEventListener('input', e => {
  const ta = e.target.closest('textarea');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
});

/* pin 切换 */
document.addEventListener('click', e => {
  const pin = e.target.closest('[title="固定"]');
  if (pin) pin.classList.toggle('is-on');
});

/* ?empty=1 看空态 */
if (new URLSearchParams(location.search).has('empty')) {
  document.getElementById('cp-empty').hidden = false;
  document.getElementById('cp-stream').hidden = true;
  document.getElementById('cp-title').textContent = '未命名对话';
}
