/* EXTRACT_SOURCE — 在 claude.ai Code 视图页面里执行（browser_evaluate_script 或 CDP Runtime.evaluate）。
 * 用法：EXTRACT('tokens') / EXTRACT('cssCount') / EXTRACT('css', s, e) /
 *       EXTRACT('computed', selector) / EXTRACT('iconsMeta') / EXTRACT('icon', i) /
 *       EXTRACT('domLen') / EXTRACT('dom', s, e) / EXTRACT('meta')
 * 返回都是 JSON 可序列化。DOM 是脱敏后的（文本节点→«text»，身份属性值清空）。
 */
function EXTRACT(part, a, b) {
  if (part === 'meta') {
    return {
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      userAgent: navigator.userAgent,
      svgCount: document.querySelectorAll('svg').length,
      sheetCount: document.styleSheets.length,
      adoptedCount: (document.adoptedStyleSheets || []).length,
      styleTagCount: document.querySelectorAll('style').length,
    };
  }
  if (part === 'tokens') {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const k of cs) if (k.startsWith('--')) out[k] = cs.getPropertyValue(k);
    return out;
  }
  if (part === 'cssCount') {
    let n = 0, inline = 0;
    for (const s of document.styleSheets) { try { n += s.cssRules.length; } catch (e) {} }
    for (const s of (document.adoptedStyleSheets || [])) { try { n += s.cssRules.length; } catch (e) {} }
    for (const el of document.querySelectorAll('style')) inline += (el.textContent || '').length;
    return { ruleCount: n, inlineChars: inline };
  }
  if (part === 'css') {
    const all = [];
    for (const s of document.styleSheets) { try { for (const r of s.cssRules) all.push(r.cssText); } catch (e) {} }
    for (const s of (document.adoptedStyleSheets || [])) { try { for (const r of s.cssRules) all.push(r.cssText); } catch (e) {} }
    return { total: all.length, slice: all.slice(a || 0, b || all.length) };
  }
  if (part === 'computed') {
    const el = document.querySelector(a);
    if (!el) return null;
    const style = getComputedStyle(el);
    const out = {};
    for (const key of style) out[key] = style.getPropertyValue(key);
    try { out.__rect = el.getBoundingClientRect().toJSON(); } catch (e) {}
    return out;
  }
  if (part === 'iconsMeta') {
    return [...document.querySelectorAll('svg')].map((svg) => {
      let r = {};
      try { r = svg.getBoundingClientRect().toJSON(); } catch (e) {}
      return {
        label: (svg.closest('button') && svg.closest('button').getAttribute('aria-label')) || svg.getAttribute('aria-label') || '',
        testid: (svg.closest('[data-testid]') && svg.closest('[data-testid]').dataset.testid) || '',
        text: ((svg.closest('button') || svg).textContent || '').trim().slice(0, 40),
        htmlLen: (svg.outerHTML || '').length,
        rect: r,
      };
    });
  }
  if (part === 'icon') {
    const svg = [...document.querySelectorAll('svg')][a];
    return svg ? svg.outerHTML : null;
  }
  if (part === 'symbols') {
    return [...document.querySelectorAll('symbol')].map((s) => s.outerHTML).slice(a || 0, b);
  }
  function sanitizedHTML() {
    const clone = document.documentElement.cloneNode(true);
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const t of texts) {
      if (t.parentElement && /^(SCRIPT|STYLE)$/.test(t.parentElement.tagName)) t.textContent = '';
      else if ((t.textContent || '').trim()) t.textContent = '«text»';
      else t.textContent = '';
    }
    const els = clone.querySelectorAll('*');
    for (const el of els) {
      for (const attr of [...el.attributes]) {
        if (/(token|convers|org|user|session|email|phone|account|profile|avatar|id$|href|src$|data-email)/i.test(attr.name)) {
          el.setAttribute(attr.name, '«redacted»');
        }
      }
      if (/^(SCRIPT)$/.test(el.tagName)) el.textContent = '';
    }
    return clone.outerHTML;
  }
  if (part === 'domLen') return { len: sanitizedHTML().length };
  if (part === 'dom') { const h = sanitizedHTML(); return { total: h.length, slice: h.slice(a || 0, b) }; }
  return { error: 'unknown part' };
}
