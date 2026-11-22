/* Magic Pointer Learn Kit Runtime: window.FK (Figure Kit) + window.XRAY (Reader Kit) */
(function () {
  'use strict';

  /* ==================== FIGURE KIT (window.FK) ==================== */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const S = {
    h: 60,
    gap: 15,
    gapDot: 18,
    rx: 4.6,
    add: 8.2,
    dot: 2.4,
    aL: 6,
    aW: 5.2,
    fs: 13,
    lh: 15.6,
    fsSmall: 12,
    fsIO: 15,
    lift: 60.8,
    stackPadX: 9.2,
    stackPadY: 78,
    pe: 13.2,
  };
  const W = { s: 33, m: 60, ffn: 73, l: 91, xl: 85 };
  const GREEK = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
    eta: 'η', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π',
    sigma: 'σ', tau: 'τ', phi: 'φ', psi: 'ψ', omega: 'ω',
    Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Phi: 'Φ',
    in: '∈', times: '×', cdot: '·', to: '→', mapsto: '↦', top: '⊤',
    sum: 'Σ', le: '≤', ge: '≥', approx: '≈', infty: '∞',
    odot: '⊙', oplus: '⊕', ldots: '…', partial: '∂', nabla: '∇',
  };
  const BB = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', E: '𝔼', C: 'ℂ', Q: 'ℚ' };
  const WORDS = /^(softmax|Attn|LN|exp|log|max|min|sin|cos|tanh|ReLU|GELU|Linear|Sublayer|MLP|FFN|concat|diag|Var|argmax|sigmoid|Norm|RMSNorm|LayerNorm|Conv|Dropout|KL|CE|Loss|Attention)/;
  const LOWER_GREEK_ITALIC = 'alphabetagammadeltaepsilonetathetalambdamupisigmatauphipsiomega';

  function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k in attrs) {
        if (attrs[k] !== undefined && attrs[k] !== null) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    if (parent) {
      parent.appendChild(node);
    }
    return node;
  }

  function resolveHost(host) {
    return typeof host === 'string' ? document.querySelector(host) : host;
  }

  // TeX subset -> tspans: ^ _ {} \role{r}{..} \htmlClass{r-x}{..} \mathbf \mathrm \text \texttt \mathbb greek
  function rich(t, src, fs) {
    let i = 0;
    let base = 0;
    let curSrc = String(src || '');

    function grp() {
      if (curSrc[i] === '{') {
        let d = 1;
        const j = ++i;
        while (i < curSrc.length && d > 0) {
          if (curSrc[i] === '{') {
            d++;
          } else if (curSrc[i] === '}') {
            d--;
          }
          i++;
        }
        return curSrc.slice(j, i - 1);
      }
      if (curSrc[i] === '\\') {
        const m = /^\\[A-Za-z]+/.exec(curSrc.slice(i));
        if (m) {
          i += m[0].length;
          return m[0];
        }
      }
      return curSrc[i++];
    }

    function emit(txt, cls, shift, size) {
      if (!txt) {
        return;
      }
      const attrs = { class: cls || null };
      const dy = shift - base;
      if (dy) {
        attrs.dy = dy.toFixed(2);
      }
      base = shift;
      if (size) {
        attrs['font-size'] = size;
      }
      svgEl('tspan', attrs, t).textContent = txt;
    }

    function clsName(ctx, font) {
      return [font === 'rm' ? '' : font, ctx.role || ''].join(' ').trim() || null;
    }

    function run(s, ctx) {
      let k = 0;
      while (k < s.length) {
        const c = s[k];
        if (c === '\\') {
          const m = /^\\([A-Za-z]+|.)/.exec(s.slice(k));
          k += m[0].length;
          const cmd = m[1];
          const take = function () {
            curSrc = s;
            i = k;
            const g = grp();
            k = i;
            return g;
          };
          if (cmd === 'role' || cmd === 'htmlClass') {
            const r = take().replace(/^r-/, '');
            run(take(), Object.assign({}, ctx, { role: 'r-' + r }));
          } else if (cmd === 'mathbf' || cmd === 'bm') {
            run(take(), Object.assign({}, ctx, { font: 'bf' }));
          } else if (cmd === 'mathrm' || cmd === 'text' || cmd === 'operatorname') {
            run(take(), Object.assign({}, ctx, { font: 'rm' }));
          } else if (cmd === 'texttt' || cmd === 'mathtt') {
            run(take(), Object.assign({}, ctx, { font: 'tt' }));
          } else if (cmd === 'mathbb') {
            const b = take();
            emit(BB[b] || b, clsName(ctx, 'rm'), ctx.shift, ctx.size);
          } else if (cmd === 'sqrt') {
            emit('√', clsName(ctx, 'rm'), ctx.shift, ctx.size);
            run(take(), ctx);
          } else if (cmd === ',' || cmd === ';' || cmd === ' ' || cmd === 'quad') {
            emit(cmd === 'quad' ? '\u2003' : '\u2009', null, ctx.shift, ctx.size);
          } else if (cmd === '{' || cmd === '}') {
            emit(cmd, clsName(ctx, 'rm'), ctx.shift, ctx.size);
          } else if (GREEK[cmd]) {
            const useItalic = /^[a-z]/.test(cmd) && cmd.length > 2 && LOWER_GREEK_ITALIC.indexOf(cmd) >= 0;
            emit(GREEK[cmd], clsName(ctx, useItalic ? 'mi' : 'rm'), ctx.shift, ctx.size);
          } else {
            emit(cmd, clsName(ctx, 'rm'), ctx.shift, ctx.size);
          }
        } else if (c === '^' || c === '_') {
          k++;
          curSrc = s;
          i = k;
          const g = grp();
          k = i;
          const sz = (ctx.size || fs) * 0.72;
          const sh = (ctx.shift || 0) + (c === '^' ? -0.38 : 0.24) * (ctx.size || fs);
          run(g, Object.assign({}, ctx, { shift: sh, size: sz.toFixed(2) }));
        } else if (c === '{') {
          curSrc = s;
          i = k;
          const gg = grp();
          k = i;
          run(gg, ctx);
        } else if (c === ' ') {
          emit('\u2005', null, ctx.shift, ctx.size);
          k++;
        } else if (/[A-Za-z]/.test(c)) {
          const w = WORDS.exec(s.slice(k));
          if (w && ctx.font === 'mi') {
            emit(w[0], clsName(ctx, 'rm'), ctx.shift, ctx.size);
            k += w[0].length;
          } else {
            emit(c, clsName(ctx, ctx.font), ctx.shift, ctx.size);
            k++;
          }
        } else {
          emit(c, clsName(ctx, 'rm'), ctx.shift, ctx.size);
          k++;
        }
      }
    }

    run(curSrc, { font: 'mi', shift: 0, size: null, role: null });
    if (base) {
      svgEl('tspan', { dy: (-base).toFixed(2) }, t).textContent = '\u200B';
    }
    return t;
  }

  function Fig(host, w, h, label) {
    const resolved = resolveHost(host);
    this.w = w;
    this.h = h;
    this.at = {};
    this.svg = svgEl(
      'svg',
      {
        class: 'fk',
        viewBox: '0 0 ' + w + ' ' + h,
        role: 'img',
        'aria-label': label || '',
      },
      resolved,
    );
    this.svg.style.minWidth = Math.round(w * 0.82) + 'px';
    this.svg.style.maxWidth = Math.round(w * 1.1) + 'px';
    this.gS = svgEl('g', {}, this.svg);
    this.gW = svgEl('g', {}, this.svg);
    this.gB = svgEl('g', {}, this.svg);
    this.gT = svgEl('g', {}, this.svg);
  }

  const P = Fig.prototype;

  P.p = function (ref) {
    if (Array.isArray(ref)) {
      return ref;
    }
    const parts = String(ref).split('.');
    const a = this.at[parts[0]];
    if (!a) {
      throw new Error('FK: unknown id ' + parts[0]);
    }
    const side = parts[1] || 'c';
    if (side === 'l') {
      return [a.x - a.w / 2, a.y];
    }
    if (side === 'r') {
      return [a.x + a.w / 2, a.y];
    }
    if (side === 't') {
      return [a.x, a.y - a.h / 2];
    }
    if (side === 'b') {
      return [a.x, a.y + a.h / 2];
    }
    return [a.x, a.y];
  };

  P.label = function (txt, x, y, o) {
    const opts = o || {};
    const t = svgEl(
      'text',
      {
        x: x,
        y: y,
        'text-anchor': opts.anchor || 'middle',
        'font-size': opts.size || S.fs,
        class: opts.cls || null,
      },
      opts.parent || this.gT,
    );
    rich(t, txt, opts.size || S.fs);
    return t;
  };

  P.box = function (id, o) {
    const w = typeof o.w === 'number' ? o.w : (W[o.w] || W.m);
    const h = o.h || S.h;
    const g = svgEl('g', { class: 'blk r-' + (o.role || 'op'), 'data-id': id }, this.gB);
    svgEl('rect', { x: o.x - w / 2, y: o.y - h / 2, width: w, height: h, rx: S.rx }, g);
    const lines = String(o.text).split('\n');
    const y0 = o.y - ((lines.length - 1) * S.lh) / 2;
    lines.forEach(function (ln, k) {
      svgEl('text', { x: o.x, y: y0 + k * S.lh, 'text-anchor': 'middle', 'font-size': S.fs }, g).textContent = ln;
    });
    if (o.param) {
      this.label(o.param, o.x, o.y + h / 2 + 12, { size: S.fsSmall, cls: 'param' });
    }
    this.at[id] = { x: o.x, y: o.y, w: w, h: h, kind: 'box', g: g };
    return g;
  };

  P.add = function (id, o) {
    const g = svgEl('g', { class: 'add', 'data-id': id }, this.gB);
    const r = S.add;
    const a = r * 0.5;
    svgEl('circle', { cx: o.x, cy: o.y, r: r }, g);
    svgEl('path', { d: 'M' + (o.x - a) + ' ' + o.y + 'H' + (o.x + a) + 'M' + o.x + ' ' + (o.y - a) + 'V' + (o.y + a) }, g);
    this.at[id] = { x: o.x, y: o.y, w: 2 * r, h: 2 * r, kind: 'add', g: g };
  };

  P.dot = function (id, o) {
    svgEl('circle', { class: 'dot', cx: o.x, cy: o.y, r: S.dot }, this.gB);
    this.at[id] = { x: o.x, y: o.y, w: 0, h: 0, kind: 'dot' };
  };

  P.wire = function (pts, o) {
    const opts = o || {};
    const self = this;
    const resolvedPts = pts.map(function (q) { return self.p(q); });
    const n = resolvedPts.length;
    const a = resolvedPts[n - 2];
    const b = resolvedPts[n - 1];
    const arrow = opts.arrow !== false;
    const dx = Math.sign(b[0] - a[0]);
    const dy = Math.sign(b[1] - a[1]);
    const end = arrow ? [b[0] - dx * S.aL * 0.8, b[1] - dy * S.aL * 0.8] : b;
    const d = 'M' + resolvedPts.slice(0, n - 1).map(function (q) { return q[0] + ' ' + q[1]; }).join('L') + 'L' + end[0] + ' ' + end[1];
    const role = opts.role ? ' r-' + opts.role : '';
    const path = svgEl(
      'path',
      {
        d: d,
        class: 'wire' + role + (opts.cls ? ' ' + opts.cls : ''),
        'data-pts': JSON.stringify(resolvedPts),
      },
      this.gW,
    );
    if (arrow) {
      const px = -dy;
      const py = dx;
      const L = S.aL;
      const Wd = S.aW / 2;
      svgEl(
        'path',
        {
          class: 'head' + role,
          d:
            'M' + b[0] + ' ' + b[1] +
            'L' + (b[0] - dx * L + px * Wd) + ' ' + (b[1] - dy * L + py * Wd) +
            'L' + (b[0] - dx * L - px * Wd) + ' ' + (b[1] - dy * L - py * Wd) + 'Z',
        },
        this.gW,
      );
    }
    return path;
  };

  P.row = function (y, x0, items) {
    let x = x0;
    let prev = null;
    const self = this;
    items.forEach(function (it, k) {
      const kind = it.add ? 'add' : it.dot ? 'dot' : 'box';
      const w = kind === 'add' ? 2 * S.add : kind === 'dot' ? 0 : (typeof it.w === 'number' ? it.w : (W[it.w] || W.m));
      if (k) {
        x += it.gap !== undefined ? it.gap : (kind === 'dot' || (prev && prev.kind === 'dot')) ? S.gapDot : S.gap;
      }
      const cx = x + w / 2;
      if (kind === 'box') {
        self.box(it.id, { x: cx, y: y, w: w, role: it.role, text: it.box, param: it.param });
      } else if (kind === 'add') {
        self.add(it.id, { x: cx, y: y });
      } else {
        self.dot(it.id, { x: cx, y: y });
      }
      if (prev && it.link !== false) {
        self.wire([[prev.r, y], [x, y]], { arrow: kind !== 'dot' });
      }
      x += w;
      prev = { kind: kind, r: x };
    });
    return x;
  };

  P.skip = function (from, to, side) {
    const a = this.p(from);
    const b = this.p(to);
    const up = side !== 'bottom';
    const yy = a[1] + (up ? -S.lift : S.lift);
    this.wire([a, [a[0], yy], [b[0], yy], [b[0], b[1] + (up ? -S.add : S.add)]]);
  };

  P.stack = function (from, to, o) {
    const opts = o || {};
    const a = this.p(from + '.l');
    const b = this.p(to + '.r');
    const x0 = a[0] - S.stackPadX;
    const x1 = b[0] + S.stackPadX;
    const y0 = a[1] - S.stackPadY;
    const y1 = a[1] + S.stackPadY;
    svgEl('rect', { class: 'stack', x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 11.5 }, this.gS);
    if (opts.label) {
      this.label(opts.label, (x0 + x1) / 2, opts.side === 'bottom' ? y1 + 14 : y0 - 13, { size: 13.5, cls: 'note' });
    }
  };

  P.pe = function (addId, side) {
    const a = this.p(addId);
    const up = side !== 'bottom';
    const cy = a[1] + (up ? -65.4 : 65.4);
    const r = S.pe;
    const g = svgEl('g', { class: 'pe' }, this.gB);
    svgEl('circle', { cx: a[0], cy: cy, r: r }, g);
    svgEl(
      'path',
      {
        d:
          'M' + (a[0] - r * 0.62) + ' ' + cy +
          'C' + (a[0] - r * 0.35) + ' ' + (cy - r * 1.05) + ' ' + (a[0] - r * 0.1) + ' ' + (cy - r * 0.8) + ' ' + a[0] + ' ' + cy +
          'S' + (a[0] + r * 0.35) + ' ' + (cy + r * 1.05) + ' ' + (a[0] + r * 0.62) + ' ' + cy,
      },
      g,
    );
    this.wire([[a[0], cy + (up ? r : -r)], [a[0], a[1] + (up ? -S.add : S.add)]]);
    this.label('PE', a[0] - r - 6, cy, { anchor: 'end', size: 12, cls: 'note' });
  };

  P.io = function (txt, o) {
    const len = o.len || 26.8;
    const lines = String(txt).split('\n');
    let x;
    let y;
    let anchor;
    if (o.to) {
      const b = this.p(o.to + '.l');
      this.wire([[b[0] - len, b[1]], b], { role: o.role });
      x = b[0] - len - 8;
      y = b[1];
      anchor = 'end';
    } else {
      const a = this.p(o.from + '.r');
      this.wire([a, [a[0] + len, a[1]]], { role: o.role });
      x = a[0] + len + 8;
      y = a[1];
      anchor = 'start';
    }
    const self = this;
    const y0 = y - ((lines.length - 1) * 17) / 2 - (o.sub ? 7 : 0);
    lines.forEach(function (ln, k) {
      self.label('\\text{' + ln + '}', x, y0 + k * 17, { anchor: anchor, size: S.fsIO, cls: 'r-' + o.role });
    });
    if (o.sub) {
      this.label('\\text{' + o.sub + '}', x, y0 + lines.length * 17 - 2, { anchor: anchor, size: 12, cls: 'r-' + o.role });
    }
  };

  P.zoom = function (id, o) {
    const a = this.at[id];
    const hd = 30;
    const g = svgEl('g', { class: 'zoom' }, this.zl || this.svg);
    const b = { x0: a.x - a.w / 2, y0: a.y - a.h / 2, x1: a.x + a.w / 2, y1: a.y + a.h / 2 };
    const q = { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
    let poly;
    if (q.x0 >= b.x1) {
      poly = [[b.x1, b.y0], [q.x0, q.y0], [q.x0, q.y1], [b.x1, b.y1]];
    } else if (q.x1 <= b.x0) {
      poly = [[b.x0, b.y0], [q.x1, q.y0], [q.x1, q.y1], [b.x0, b.y1]];
    } else if (q.y1 <= b.y0) {
      poly = [[b.x0, b.y0], [q.x0, q.y1], [q.x1, q.y1], [b.x1, b.y0]];
    } else {
      poly = [[b.x0, b.y1], [q.x0, q.y0], [q.x1, q.y0], [b.x1, b.y1]];
    }
    const wg = svgEl('g', { class: 'zoom' }, this.gS);
    svgEl('path', { class: 'zwedge', d: 'M' + poly.map(function (pt) { return pt.join(' '); }).join('L') + 'Z' }, wg);
    svgEl('path', { class: 'zedge', d: 'M' + poly[0].join(' ') + 'L' + poly[1].join(' ') + 'M' + poly[3].join(' ') + 'L' + poly[2].join(' ') }, wg);
    svgEl('rect', { class: 'zframe', x: q.x0, y: q.y0, width: o.w, height: o.h, rx: 3 }, g);
    svgEl('rect', { class: 'zhead', x: q.x0 + 1.1, y: q.y0 + 1.1, width: o.w - 2.2, height: hd }, g);
    const z = Object.create(P);
    const body = svgEl('g', { transform: 'translate(' + q.x0 + ',' + (q.y0 + hd) + ')' }, g);
    z.svg = this.svg;
    z.w = o.w;
    z.h = o.h - hd;
    z.at = {};
    z.gS = svgEl('g', {}, body);
    z.gW = svgEl('g', {}, body);
    z.gB = svgEl('g', {}, body);
    z.gT = svgEl('g', {}, body);
    z.zl = body;
    this.label('\\text{' + o.title + '}', q.x0 + o.w / 2, q.y0 + hd / 2 + 1, { size: 15, cls: 'ztitle', parent: g });
    if (o.build) {
      o.build(z);
    }
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    g.style.transformBox = 'view-box';
    g.style.transformOrigin = cx + 'px ' + cy + 'px';
    function setOpen(open) {
      g.classList.toggle('off', !open);
      wg.classList.toggle('off', !open);
      g.style.transform = open ? '' : 'scale(.2)';
      a.g.classList.toggle('zopen', open);
    }
    a.g.classList.add('zsrc');
    a.g.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setOpen(g.classList.contains('off'));
    });
    setOpen(!o.closed);
    return z;
  };

  P.note = function (txt, x, y, anchor) {
    return this.label(txt, x, y, { anchor: anchor || 'middle', size: S.fsSmall, cls: 'note' });
  };

  P.math = function (src, x, y, anchor) {
    return this.label(src, x, y, { anchor: anchor || 'middle', size: 14 });
  };

  P.light = function (ids) {
    const self = this;
    Object.keys(this.at).forEach(function (k) {
      const a = self.at[k];
      if (a.g) {
        a.g.classList.toggle('on', ids.indexOf(k) >= 0);
      }
    });
  };

  function heatGlow(v) {
    const a = Math.round(v * 78);
    const b = Math.round(v * 34);
    return v < 0.02
      ? 'none'
      : 'radial-gradient(closest-side, color-mix(in srgb, var(--k) ' + a + '%, transparent), color-mix(in srgb, var(--k) ' + b + '%, transparent) 62%, transparent)';
  }

  function heat(host, o) {
    const resolved = resolveHost(host);
    resolved.innerHTML = '';
    const n = o.tokens.length;
    const mode = o.mode || 'ladder';
    const root = document.createElement('div');
    root.className = 'fk-heat ' + mode + (o.frame === false ? '' : mode === 'ladder' ? ' box' : '');
    root.style.setProperty('--k', 'var(--' + (o.role || 'in') + ')');
    root.style.setProperty('--q', 'var(--' + (o.qrole || 'loss') + ')');
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', o.label || 'attention over tokens');
    resolved.appendChild(root);

    function norm(row, i) {
      let m = 0;
      row.forEach(function (v, j) {
        if (j !== i) {
          m = Math.max(m, v);
        }
      });
      return row.map(function (v) { return m ? v / m : 0; });
    }

    function paint(row, i, spans) {
      const w = norm(row, i);
      spans.forEach(function (sp, j) {
        sp.className = 'tk' + (j === i ? ' q' : '');
        sp.style.background = j === i ? 'none' : heatGlow(w[j]);
      });
    }

    if (mode === 'ladder') {
      for (let i = 0; i < n; i++) {
        const r = document.createElement('div');
        r.className = 'row';
        root.appendChild(r);
        const spans = o.tokens.map(function (t) {
          const sp = document.createElement('span');
          sp.textContent = t;
          r.appendChild(sp);
          return sp;
        });
        const row = o.w[i].map(function (v, j) { return j < i ? v : 0; });
        paint(row, i, spans);
        spans.forEach(function (sp, j) {
          if (j > i) {
            sp.className = 'tk later';
          }
        });
      }
      return { root: root };
    }

    const r2 = document.createElement('div');
    r2.className = 'row';
    root.appendChild(r2);
    root.tabIndex = 0;
    const sp2 = o.tokens.map(function (t) {
      const sp = document.createElement('span');
      sp.textContent = t;
      r2.appendChild(sp);
      return sp;
    });
    const ctl = o.ctl ? resolveHost(o.ctl) : null;
    let cur = o.start || 0;

    function pick(i) {
      cur = i;
      const row = o.causal ? o.w[i].map(function (v, j) { return j < i ? v : 0; }) : o.w[i];
      paint(row, i, sp2);
      let bj = -1;
      let bv = -1;
      row.forEach(function (v, j) {
        if (j !== i && v > bv) {
          bv = v;
          bj = j;
        }
      });
      if (ctl) {
        ctl.innerHTML = o.say
          ? o.say(i, bj, bv)
          : '<span class="say">' + escHtml(o.tokens[i]) + ' → ' + (bj >= 0 && bv > 0 ? escHtml(o.tokens[bj]) + ' ' + bv.toFixed(2) : '·') + '</span>';
      }
    }

    sp2.forEach(function (sp, j) {
      sp.addEventListener('mouseenter', function () { pick(j); });
      sp.addEventListener('click', function () { pick(j); });
    });
    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowRight') {
        pick(Math.min(n - 1, cur + 1));
      }
      if (ev.key === 'ArrowLeft') {
        pick(Math.max(0, cur - 1));
      }
    });
    pick(cur);
    return { root: root, pick: pick };
  }

  function iso(host, o) {
    const resolved = resolveHost(host);
    resolved.innerHTML = '';
    const Lr = o.layers;
    const n = Lr.length;
    const W0 = o.w || 150;
    const D0 = o.d || 100;
    const T = o.t || 7;
    const R = o.r || 9;
    const open = o.open || 34;
    const gap = o.gap || 16;
    const rest = Lr.map(function (_item, i) { return i * gap + i * i * 1.6; });
    const svg = svgEl('svg', { class: 'fk-iso', viewBox: '0 0 400 320', role: 'img', 'aria-label': o.label || 'layers' }, resolved);
    const ctl = o.ctl ? resolveHost(o.ctl) : null;
    const c30 = Math.cos(Math.PI / 6);
    const s30 = 0.5;
    const ztop = rest[n - 1] + open;
    const zbot = T + 10;
    const scaleFactor = o.scale || Math.min(1.6, 290 / ((W0 + D0) * s30 + ztop + zbot), 370 / ((W0 + D0) * c30));
    const cyOff = 160 + ((ztop - zbot) * scaleFactor) / 2;

    function proj(x, y, z) {
      return [200 + (x - y) * c30 * scaleFactor, cyOff + (x + y) * s30 * scaleFactor - z * scaleFactor];
    }

    function ring(z) {
      const pts = [];
      const cs = [
        [W0 / 2 - R, D0 / 2 - R, 0],
        [-W0 / 2 + R, D0 / 2 - R, 90],
        [-W0 / 2 + R, -D0 / 2 + R, 180],
        [W0 / 2 - R, -D0 / 2 + R, 270],
      ];
      cs.forEach(function (c) {
        for (let k = 0; k <= 6; k++) {
          const t = ((c[2] + k * 15) * Math.PI) / 180;
          pts.push(proj(c[0] + R * Math.cos(t), c[1] + R * Math.sin(t), z));
        }
      });
      return pts;
    }

    function hull(ptsInput) {
      const p = ptsInput.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      function cr(o2, a, b) { return (a[0] - o2[0]) * (b[1] - o2[1]) - (a[1] - o2[1]) * (b[0] - o2[0]); }
      const lo = [];
      const up = [];
      p.forEach(function (q) {
        while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) {
          lo.pop();
        }
        lo.push(q);
      });
      p.slice().reverse().forEach(function (q) {
        while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) {
          up.pop();
        }
        up.push(q);
      });
      return lo.slice(0, -1).concat(up.slice(0, -1));
    }

    function pathD(pts, close) {
      return 'M' + pts.map(function (q) { return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L') + (close ? 'Z' : '');
    }

    svgEl('path', { class: 'ground', d: pathD(ring(-T - 10), true) }, svg);
    const plates = Lr.map(function (ly) {
      const g = svgEl('g', { class: 'r-' + (ly.role || 'op') }, svg);
      return {
        g: g,
        fill: svgEl('path', { class: 'fill' }, g),
        crease: svgEl('path', { class: 'crease' }, g),
        sil: svgEl('path', { class: 'sil' }, g),
        z: 0,
        v: 0,
        t: 0,
        last: null,
      };
    });

    function draw(p, z) {
      if (p.last !== null && Math.abs(p.last - z) < 0.01) {
        return;
      }
      p.last = z;
      const a = ring(z);
      const b = ring(z - T);
      const h = pathD(hull(a.concat(b)), true);
      p.fill.setAttribute('d', h);
      p.sil.setAttribute('d', h);
      p.crease.setAttribute('d', pathD(a, true));
    }

    const home = o.start === undefined ? n - 1 : o.start;
    let sel = -2;
    let raf = 0;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function target(k) {
      plates.forEach(function (p, i) {
        p.t = rest[i] + (k >= 0 && i > k ? open : 0);
      });
    }

    function light(k, say) {
      plates.forEach(function (p, i) { p.sil.classList.toggle('hi', i === k); });
      if (ctl) {
        ctl.innerHTML = '<span class="say">' + escHtml(say) + '</span>';
      }
    }

    function tick() {
      let moving = false;
      plates.forEach(function (p) {
        if (reduce) {
          p.z = p.t;
          p.v = 0;
        } else {
          for (let s = 0; s < 2; s++) {
            const f = -100 * (p.z - p.t) - 18 * p.v;
            p.v += f / 120;
            p.z += p.v / 120;
          }
        }
        if (Math.abs(p.z - p.t) > 0.02 || Math.abs(p.v) > 0.02) {
          moving = true;
        } else {
          p.z = p.t;
          p.v = 0;
        }
        draw(p, p.z);
      });
      raf = moving ? window.requestAnimationFrame(tick) : 0;
    }

    function wake() {
      if (!raf) {
        raf = window.requestAnimationFrame(tick);
      }
    }

    function choose(k) {
      if (k === sel) {
        return;
      }
      sel = k;
      target(k);
      light(k, (k + 1) + ' / ' + n + ' · ' + Lr[k].name);
      wake();
    }

    function rest0() {
      sel = -2;
      target(-1);
      light(home, o.restSay || Lr[home].name);
      wake();
    }

    const mids = plates.map(function (_p, i) { return proj(0, 0, rest[i] - T / 2)[1]; });
    svg.addEventListener('pointermove', function (ev) {
      const r = svg.getBoundingClientRect();
      const y = ((ev.clientY - r.top) / (r.height || 1)) * 320;
      let best = 0;
      let bd = 1e9;
      mids.forEach(function (m, i) {
        const dd = Math.abs(m - y);
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      });
      choose(best);
    });
    svg.addEventListener('pointerleave', rest0);
    svg.tabIndex = 0;
    svg.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowUp') {
        choose(Math.min(n - 1, Math.max(sel, 0) + 1));
      }
      if (ev.key === 'ArrowDown') {
        choose(Math.max(0, (sel < 0 ? n : sel) - 1));
      }
      if (ev.key === 'Escape') {
        rest0();
      }
    });

    target(-1);
    plates.forEach(function (p) {
      p.z = p.t;
      draw(p, p.z);
    });
    light(home, o.restSay || Lr[home].name);
    const atMatch = /[?&]at=iso(\d+)/.exec(window.location.search);
    if (atMatch) {
      choose(Number(atMatch[1]));
    }
    return { choose: choose, rest: rest0 };
  }

  function plot(host, o) {
    const resolved = resolveHost(host);
    resolved.innerHTML = '';
    const f = new Fig(resolved, o.w || 1000, o.h || 420, o.label);
    const m = Object.assign({ l: 76, r: 34, t: 30, b: 56 }, o.pad || {});
    const X0 = m.l;
    const X1 = f.w - m.r;
    const Y0 = f.h - m.b;
    const Y1 = m.t;

    function axis(a, p0, p1) {
      const lg = Boolean(a.log);
      const lo = lg ? Math.log10(a.min) : a.min;
      const hi = lg ? Math.log10(a.max) : a.max;
      return function (v) {
        const t = ((lg ? Math.log10(Math.max(v, 1e-300)) : v) - lo) / (hi - lo);
        return p0 + t * (p1 - p0);
      };
    }

    const X = axis(o.x, X0, X1);
    const Y = axis(o.y, Y0, Y1);
    const gA = svgEl('g', {}, f.gS);
    const items = {};
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function ticks(a) {
      if (a.ticks) {
        return a.ticks;
      }
      const t = [];
      if (a.log) {
        for (let k = Math.ceil(Math.log10(a.min) - 1e-9); k <= Math.floor(Math.log10(a.max) + 1e-9); k++) {
          t.push(Math.pow(10, k));
        }
        const s = Math.max(1, Math.ceil(t.length / 8));
        return t.filter(function (_val, i) { return i % s === 0; });
      }
      const span = a.max - a.min;
      let st = Math.pow(10, Math.floor(Math.log10(span / 5)));
      if (span / st > 10) {
        st *= 2;
      }
      if (span / st > 10) {
        st *= 2.5;
      }
      for (let v = Math.ceil(a.min / st - 1e-9) * st; v <= a.max + 1e-9; v += st) {
        t.push(Number(v.toPrecision(12)));
      }
      return t;
    }

    function fmt(a, v) {
      if (a.fmt) {
        return a.fmt(v);
      }
      if (a.log) {
        return '10^{' + Math.round(Math.log10(v)) + '}';
      }
      return String(Number(v.toPrecision(6)));
    }

    if (!o.x.hide) {
      svgEl('path', { class: 'axis', d: 'M' + X0 + ' ' + Y0 + 'H' + X1 }, gA);
      ticks(o.x).forEach(function (v) {
        const x = X(v);
        svgEl('path', { class: 'tick', d: 'M' + x + ' ' + Y0 + 'v5' }, gA);
        f.label(fmt(o.x, v), x, Y0 + 17, { size: 12, cls: 'note' });
      });
      if (o.x.label) {
        f.label(o.x.label, X1, Y0 + 40, { anchor: 'end', size: 14 });
      }
    }
    if (!o.y.hide) {
      svgEl('path', { class: 'axis', d: 'M' + X0 + ' ' + Y0 + 'V' + Y1 }, gA);
      ticks(o.y).forEach(function (v) {
        const y = Y(v);
        svgEl('path', { class: 'tick', d: 'M' + X0 + ' ' + y + 'h-5' }, gA);
        f.label(fmt(o.y, v), X0 - 9, y, { anchor: 'end', size: 12, cls: 'note' });
      });
      if (o.y.label) {
        f.label(o.y.label, X0 - 9, Y1 - 16, { anchor: 'start', size: 14 });
      }
    }

    function cls(base, q) {
      return base + (q.role ? ' r-' + q.role : '') + (q.cls ? ' ' + q.cls : '');
    }

    function inY(v) {
      const lo = Math.min(o.y.min, o.y.max);
      const hi = Math.max(o.y.min, o.y.max);
      const e = (hi - lo) * 1e-6;
      return isFinite(v) && v >= lo - e && v <= hi + e;
    }

    function pathStr(pts) {
      let s = '';
      let pen = false;
      pts.forEach(function (p) {
        if (!inY(p[1])) {
          pen = false;
          return;
        }
        s += (pen ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1);
        pen = true;
      });
      return s || 'M0 0';
    }

    let raf = 0;
    let tw = [];
    function step(nowMs) {
      tw = tw.filter(function (t) {
        const k = Math.min(1, (nowMs - t.t0) / 450);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        t.n.setAttribute('d', pathStr(t.a.map(function (p, i) {
          return [p[0] + (t.b[i][0] - p[0]) * e, p[1] + (t.b[i][1] - p[1]) * e];
        })));
        return k < 1;
      });
      raf = tw.length ? window.requestAnimationFrame(step) : 0;
    }

    const api = { f: f, X: X, Y: Y, box: { x0: X0, x1: X1, y0: Y1, y1: Y0 } };

    api.line = function (id, pts, q) {
      const opts = q || {};
      let it = items[id];
      if (!it) {
        it = items[id] = { n: svgEl('path', { class: cls('curve', opts) }, opts.under ? f.gS : f.gW), pts: null };
      } else {
        it.n.setAttribute('class', cls('curve', opts));
      }
      if (opts.tween && it.pts && it.pts.length === pts.length && !reduce) {
        tw = tw.filter(function (t) { return t.n !== it.n; });
        tw.push({ n: it.n, a: it.pts, b: pts, t0: window.performance.now() });
        if (!raf) {
          raf = window.requestAnimationFrame(step);
        }
      } else {
        it.n.setAttribute('d', pathStr(pts));
      }
      it.pts = pts;
      return it.n;
    };

    api.dot = function (id, p, q) {
      const opts = q || {};
      const it = items[id] || (items[id] = { n: svgEl('circle', {}, f.gB) });
      it.n.setAttribute('class', cls('pt', opts));
      it.n.setAttribute('cx', String(X(p[0])));
      it.n.setAttribute('cy', String(Y(p[1])));
      it.n.setAttribute('r', String(opts.r || 4.6));
      return it.n;
    };

    api.text = function (id, txt, p, q) {
      const opts = q || {};
      if (items[id]) {
        items[id].n.remove();
      }
      const n = f.label(txt, X(p[0]) + (opts.dx || 0), Y(p[1]) + (opts.dy || 0), {
        anchor: opts.anchor || 'start',
        size: opts.size || 13,
        cls: opts.role ? 'r-' + opts.role : (opts.cls || null),
      });
      items[id] = { n: n };
      return n;
    };

    api.rect = function (id, a, b, q) {
      const opts = q || {};
      const it = items[id] || (items[id] = { n: svgEl('rect', {}, f.gB) });
      const x0 = Math.min(X(a[0]), X(b[0]));
      const x1 = Math.max(X(a[0]), X(b[0]));
      const y0 = Math.min(Y(a[1]), Y(b[1]));
      const y1 = Math.max(Y(a[1]), Y(b[1]));
      it.n.setAttribute('class', cls('bar', opts));
      it.n.setAttribute('x', String(x0));
      it.n.setAttribute('y', String(y0));
      it.n.setAttribute('width', String(Math.max(0, x1 - x0)));
      it.n.setAttribute('height', String(Math.max(0, y1 - y0)));
      it.n.setAttribute('rx', String(opts.rx === undefined ? 2 : opts.rx));
      return it.n;
    };

    api.vline = function (id, x, q) {
      const opts = q || {};
      const it = items[id] || (items[id] = { n: svgEl('path', {}, f.gW) });
      it.n.setAttribute('class', cls('ref', opts));
      it.n.setAttribute('d', 'M' + X(x) + ' ' + Y(opts.y0 === undefined ? o.y.min : opts.y0) + 'V' + Y(opts.y1 === undefined ? o.y.max : opts.y1));
      return it.n;
    };

    api.hline = function (id, y, q) {
      const opts = q || {};
      const it = items[id] || (items[id] = { n: svgEl('path', {}, f.gW) });
      it.n.setAttribute('class', cls('ref', opts));
      it.n.setAttribute('d', 'M' + X(opts.x0 === undefined ? o.x.min : opts.x0) + ' ' + Y(y) + 'H' + X(opts.x1 === undefined ? o.x.max : opts.x1));
      return it.n;
    };

    api.remove = function (id) {
      if (items[id]) {
        items[id].n.remove();
        delete items[id];
      }
    };

    api.has = function (id) {
      return Boolean(items[id]);
    };

    return api;
  }

  function tokens(host, o) {
    const resolved = resolveHost(host);
    resolved.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'fk-toks';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', (o && o.label) || 'tokens');
    resolved.appendChild(root);

    function set(lines) {
      root.innerHTML = '';
      lines.forEach(function (ln) {
        if (ln.label) {
          const l = document.createElement('div');
          l.className = 'lab';
          l.textContent = ln.label;
          root.appendChild(l);
        }
        const r = document.createElement('div');
        r.className = 'row';
        root.appendChild(r);
        ln.toks.forEach(function (t, i) {
          const s = document.createElement('span');
          s.className = 'tk' + (i % 2 ? ' b' : '');
          if (typeof t === 'object' && t !== null) {
            s.className += ' raw';
            s.textContent = t.raw;
          } else {
            let txt = String(t);
            const m = /^( +)/.exec(txt);
            if (m) {
              const sp = document.createElement('span');
              sp.className = 'sp';
              sp.textContent = m[1].replace(/ /g, '·');
              s.appendChild(sp);
              txt = txt.slice(m[1].length);
            }
            s.appendChild(document.createTextNode(txt));
          }
          r.appendChild(s);
        });
      });
    }

    if (o && o.lines) {
      set(o.lines);
    }
    return { root: root, set: set };
  }

  function safeBBox(node) {
    try {
      return node.getBBox();
    } catch {
      return null;
    }
  }

  function lintFigures(scopeRoot, opts) {
    const scope = scopeRoot ? resolveHost(scopeRoot) : document;
    const silent = Boolean(opts && opts.silent);
    const out = [];
    if (!scope) {
      return out;
    }
    scope.querySelectorAll('svg.fk').forEach(function (svg, si) {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      const texts = [].slice.call(svg.querySelectorAll('text')).filter(function (t) {
        return t.textContent && t.textContent.trim();
      });
      if (vb && vb.width > 1260) {
        out.push('fig' + si + ': viewBox width ' + vb.width + ' > 1260');
      }
      function off(n) {
        let x = 0;
        let y = 0;
        for (let cur = n; cur && cur !== svg; cur = cur.parentNode) {
          const tr = cur.getAttribute ? cur.getAttribute('transform') || '' : '';
          const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(tr);
          if (m) {
            x += Number(m[1]);
            y += Number(m[2]);
          }
        }
        return [x, y];
      }
      const boxes = [];
      texts.forEach(function (t) {
        const b = safeBBox(t);
        if (!b) {
          return;
        }
        const o = off(t);
        boxes.push({
          t: t,
          x0: b.x + o[0],
          y0: b.y + o[1],
          x1: b.x + o[0] + b.width,
          y1: b.y + o[1] + b.height,
        });
      });
      boxes.forEach(function (b) {
        const fs = parseFloat(window.getComputedStyle(b.t).fontSize);
        if (isFinite(fs) && fs < 11) {
          out.push('fig' + si + ': text too small ' + fs.toFixed(1) + ' "' + b.t.textContent + '"');
        }
        if (vb && vb.width > 0 && vb.height > 0) {
          if (b.x0 < vb.x - 1 || b.y0 < vb.y - 1 || b.x1 > vb.x + vb.width + 1 || b.y1 > vb.y + vb.height + 1) {
            out.push('fig' + si + ': out of bounds "' + b.t.textContent + '"');
          }
        }
      });
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const c = boxes[j];
          if (a.x0 < c.x1 - 1 && c.x0 < a.x1 - 1 && a.y0 < c.y1 - 2 && c.y0 < a.y1 - 2) {
            out.push('fig' + si + ': text overlap "' + a.t.textContent + '" × "' + c.t.textContent + '"');
          }
        }
      }
      svg.querySelectorAll('.blk').forEach(function (g) {
        const rect = g.querySelector('rect');
        const r = rect ? safeBBox(rect) : null;
        if (r) {
          g.querySelectorAll('text').forEach(function (t) {
            const b = safeBBox(t);
            if (b && (b.x < r.x + 3 || b.x + b.width > r.x + r.width - 3)) {
              out.push('fig' + si + ': label overflows box "' + t.textContent + '"');
            }
          });
        }
        if (g.querySelectorAll('text').length > 3) {
          out.push('fig' + si + ': more than 3 lines in a box');
        }
      });
      svg.querySelectorAll('.wire[data-pts]').forEach(function (p) {
        let parsed;
        try {
          parsed = JSON.parse(p.getAttribute('data-pts') || '[]');
        } catch {
          return;
        }
        const po = off(p);
        const pts = parsed.map(function (q) { return [q[0] + po[0], q[1] + po[1]]; });
        boxes.forEach(function (b) {
          if (b.t.closest('.blk')) {
            return;
          }
          for (let k = 1; k < pts.length; k++) {
            const x0 = Math.min(pts[k - 1][0], pts[k][0]);
            const x1 = Math.max(pts[k - 1][0], pts[k][0]);
            const y0 = Math.min(pts[k - 1][1], pts[k][1]);
            const y1 = Math.max(pts[k - 1][1], pts[k][1]);
            if (x0 < b.x1 - 1 && b.x0 + 1 < x1 + 0.01 && y0 < b.y1 - 1 && b.y0 + 1 < y1 + 0.01) {
              out.push('fig' + si + ': text on a wire "' + b.t.textContent + '"');
              break;
            }
          }
        });
      });
      if (svg.querySelector('[filter],filter')) {
        out.push('fig' + si + ': uses filter (glow/shadow): remove');
      }
    });
    if (!silent) {
      out.forEach(function (msg) { console.warn('[FK.lint] ' + msg); });
      if (!out.length) {
        console.log('[FK.lint] ok');
      }
    }
    if (/[?&]lint/.test(window.location.search) && document.body) {
      const pre = document.createElement('pre');
      pre.id = 'fk-lint';
      pre.textContent = out.length ? out.join('\n') : 'FK.lint ok';
      document.body.prepend(pre);
    }
    return out;
  }

  const FK = {
    fig: function (h, w, hh, l) {
      const hs = resolveHost(h);
      if (hs) {
        hs.innerHTML = '';
      }
      return new Fig(hs, w, hh, l);
    },
    heat: heat,
    iso: iso,
    plot: plot,
    tokens: tokens,
    S: S,
    W: W,
    lint: lintFigures,
    rich: rich,
  };

  /* ==================== READER KIT + STUDY-DOC (window.XRAY) ==================== */
  const EN = !/^zh/i.test(document.documentElement.lang || 'zh');
  const L = EN
    ? {
        hl: 'Highlight',
        note: 'Note',
        ask: 'Ask',
        fb: 'Feedback',
        confused: 'Lost',
        verbose: 'Too long',
        known: 'Got it',
        undo: 'Undo',
        got: 'Feedback received',
        saved: 'Saved',
        ph: 'Write a note or a question',
        toc: 'Contents',
        theme: 'Theme',
        pen: 'Annotate',
        save: 'Save annotations',
        fold: 'Fold section',
        submitted: 'Recorded',
      }
    : {
        hl: '划线',
        note: '笔记',
        ask: '追问',
        fb: '反馈',
        confused: '不懂',
        verbose: '啰嗦',
        known: '已懂',
        undo: '撤销',
        got: '已收到反馈',
        saved: '已保存',
        ph: '写笔记或问题',
        toc: '目录',
        theme: '明暗',
        pen: '标注',
        save: '保存标注',
        fold: '收起本节',
        submitted: '已记录',
      };

  const SKIP_TEXT = 'script,style,svg,.katex-mathml,.xr-ui,.xr-card,.xr-margin,textarea,button,.fk-ctl,.toc';
  const SKIP_MATH = 'script,style,pre,code,svg,textarea,.katex,.katex-mathml,.xr-ui,.xr-card,.xr-margin';
  const MATH_DELIMS = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '$', right: '$', display: false },
    { left: '\\(', right: '\\)', display: false },
  ];

  let queue = [];
  let state = { v: 1, marks: [], folds: [] };
  let activeRoot = null;
  let activeMain = null;
  let activeMode = 'widget';
  let activeWidgetId = '';
  let penOn = false;
  let marginEl = null;
  let barEl = null;
  let menuEl = null;
  let toastEl = null;
  let progressEl = null;
  let progressTimer = null;
  let listenersBound = false;

  function escHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function postParent(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch {
      /* ignore cross-frame post failures */
    }
  }

  /* ---------- KaTeX Auto-Render (local katex.renderToString, zero CDN) ---------- */
  function findEndOfMath(delimiter, text, startIndex) {
    let idx = startIndex;
    let braceLevel = 0;
    const delimLen = delimiter.length;
    while (idx < text.length) {
      const ch = text[idx];
      if (braceLevel <= 0 && text.slice(idx, idx + delimLen) === delimiter) {
        return idx;
      }
      if (ch === '\\') {
        idx++;
      } else if (ch === '{') {
        braceLevel++;
      } else if (ch === '}') {
        braceLevel--;
      }
      idx++;
    }
    return -1;
  }

  function findNextDelimiter(text, fromIndex) {
    let bestIdx = -1;
    let bestDelim = null;
    for (let d = 0; d < MATH_DELIMS.length; d++) {
      const delim = MATH_DELIMS[d];
      let searchFrom = fromIndex;
      while (searchFrom < text.length) {
        const idx = text.indexOf(delim.left, searchFrom);
        if (idx === -1) {
          break;
        }
        // Ignore escaped \$ when scanning for single-$ delimiter
        if (delim.left === '$') {
          let backslashes = 0;
          while (idx - 1 - backslashes >= 0 && text[idx - 1 - backslashes] === '\\') {
            backslashes++;
          }
          if (backslashes % 2 === 1) {
            searchFrom = idx + 1;
            continue;
          }
        }
        if (bestIdx === -1 || idx < bestIdx || (idx === bestIdx && delim.left.length > bestDelim.left.length)) {
          bestIdx = idx;
          bestDelim = delim;
        }
        break;
      }
    }
    return bestIdx === -1 ? null : { index: bestIdx, delim: bestDelim };
  }

  function splitAtDelimiters(text) {
    const out = [];
    let cursor = 0;
    while (cursor < text.length) {
      const hit = findNextDelimiter(text, cursor);
      if (!hit) {
        break;
      }
      if (hit.index > cursor) {
        out.push({ type: 'text', data: text.slice(cursor, hit.index) });
      }
      const startMath = hit.index + hit.delim.left.length;
      const endIdx = findEndOfMath(hit.delim.right, text, startMath);
      if (endIdx === -1) {
        // Unclosed delimiter: emit left delimiter as text and keep scanning
        out.push({ type: 'text', data: hit.delim.left });
        cursor = startMath;
        continue;
      }
      const raw = text.slice(hit.index, endIdx + hit.delim.right.length);
      const mathBody = text.slice(startMath, endIdx);
      out.push({
        type: 'math',
        data: mathBody,
        raw: raw,
        display: hit.delim.display,
      });
      cursor = endIdx + hit.delim.right.length;
    }
    if (cursor < text.length) {
      out.push({ type: 'text', data: text.slice(cursor) });
    }
    return out;
  }

  function resolveKatexApi() {
    const k = window.katex;
    if (!k) {
      return null;
    }
    if (typeof k.renderToString === 'function') {
      return k;
    }
    if (k.default && typeof k.default.renderToString === 'function') {
      return k.default;
    }
    return null;
  }

  function renderMath(root) {
    const katexApi = resolveKatexApi();
    if (!root || !katexApi) {
      return;
    }
    if (typeof root.normalize === 'function') {
      root.normalize();
    }
    const textNodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.data || (node.data.indexOf('$') === -1 && node.data.indexOf('\\(') === -1 && node.data.indexOf('\\[') === -1)) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentNode;
        if (parent && parent.closest && parent.closest(SKIP_MATH)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }
    const macros = { '\\role': '\\htmlClass{r-#1}{#2}' };
    textNodes.forEach(function (node) {
      const parts = splitAtDelimiters(node.data);
      if (!parts.some(function (p) { return p.type === 'math'; })) {
        return;
      }
      const frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        if (part.type === 'text') {
          frag.appendChild(document.createTextNode(part.data));
          return;
        }
        try {
          const html = katexApi.renderToString(part.data, {
            displayMode: part.display,
            throwOnError: false,
            trust: true,
            strict: false,
            macros: macros,
          });
          const tpl = document.createElement('template');
          tpl.innerHTML = html;
          frag.appendChild(tpl.content);
        } catch {
          frag.appendChild(document.createTextNode(part.raw));
        }
      });
      if (node.parentNode) {
        node.parentNode.replaceChild(frag, node);
      }
    });
  }

  /* ---------- Text Indexing & Marks ---------- */
  function textNodes() {
    if (!activeMain) {
      return [];
    }
    const out = [];
    const w = document.createTreeWalker(activeMain, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.parentNode && n.parentNode.closest && n.parentNode.closest(SKIP_TEXT)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (w.nextNode()) {
      out.push(w.currentNode);
    }
    return out;
  }

  function textIndex() {
    const ns = textNodes();
    const starts = [];
    let s = 0;
    let txt = '';
    ns.forEach(function (n) {
      starts.push(s);
      s += n.data.length;
      txt += n.data;
    });
    return { ns: ns, starts: starts, txt: txt };
  }

  function rangeOffsets(r, ix) {
    let a = -1;
    let b = -1;
    ix.ns.forEach(function (n, k) {
      if (!r.intersectsNode(n)) {
        return;
      }
      const lo = n === r.startContainer ? r.startOffset : 0;
      const hi = n === r.endContainer ? r.endOffset : n.data.length;
      if (hi <= lo) {
        return;
      }
      if (a < 0) {
        a = ix.starts[k] + lo;
      }
      b = ix.starts[k] + hi;
    });
    return a < 0 ? null : [a, b];
  }

  function wrapRange(a, b, m) {
    const ix = textIndex();
    let first = null;
    ix.ns.forEach(function (n, k) {
      const s = ix.starts[k];
      const e = s + n.data.length;
      const lo = Math.max(a, s) - s;
      const hi = Math.min(b, e) - s;
      if (hi <= lo) {
        return;
      }
      const mid = n.splitText(lo);
      mid.splitText(hi - lo);
      const markEl = document.createElement('mark');
      markEl.className = 'xr-m xr-' + m.type;
      markEl.setAttribute('data-id', m.id);
      if (m.fb) {
        markEl.setAttribute('data-fb', m.fb);
      }
      markEl.title = m.type === 'fb' ? (L[m.fb] || m.fb) : '';
      mid.parentNode.replaceChild(markEl, mid);
      markEl.appendChild(mid);
      if (!first) {
        first = markEl;
      }
    });
    return first;
  }

  function anchorMark(m) {
    if (!m || !m.quote) {
      return null;
    }
    const prefix = m.prefix || '';
    const suffix = m.suffix || '';
    const ix = textIndex();
    let best = -1;
    let score = -1;
    let i = ix.txt.indexOf(m.quote);
    while (i >= 0) {
      const p = ix.txt.slice(Math.max(0, i - prefix.length), i);
      const q = ix.txt.slice(i + m.quote.length, i + m.quote.length + suffix.length);
      let sc = 0;
      for (let k = 1; k <= p.length && p[p.length - k] === prefix[prefix.length - k]; k++) {
        sc++;
      }
      for (let k = 0; k < q.length && q[k] === suffix[k]; k++) {
        sc++;
      }
      if (sc > score) {
        score = sc;
        best = i;
      }
      i = ix.txt.indexOf(m.quote, i + 1);
    }
    return best < 0 ? null : wrapRange(best, best + m.quote.length, m);
  }

  function sectionOf(el) {
    if (!activeMain) {
      return '';
    }
    let h = null;
    let n = el;
    while (n && n !== activeMain) {
      let p = n.previousElementSibling;
      while (p) {
        if (/^H[23]$/.test(p.tagName)) {
          h = p;
          break;
        }
        if (p.classList && p.classList.contains('xr-sec')) {
          const hh = [].slice.call(p.querySelectorAll('h2, h3')).pop();
          if (hh) {
            h = hh;
            break;
          }
        }
        p = p.previousElementSibling;
      }
      if (h) {
        break;
      }
      n = n.parentNode;
    }
    return h ? h.textContent.replace(/^[▾▸]\s*/, '').trim() : '';
  }

  /* ---------- Margin Cards ---------- */
  function renderCards() {
    if (!activeMain || activeMode !== 'study-doc') {
      return;
    }
    [].slice.call(activeMain.querySelectorAll('.xr-card')).forEach(function (c) { c.remove(); });
    if (!marginEl || !marginEl.parentNode) {
      marginEl = document.createElement('div');
      marginEl.className = 'xr-margin';
      activeMain.appendChild(marginEl);
    }
    const notes = state.marks.some(function (m) { return m.type === 'note'; });
    const mr = activeMain.getBoundingClientRect();
    const mw = mr.width;
    const wide = notes && mw >= 960;
    activeMain.style.setProperty('--measure', wide ? 'min(88ch, ' + (mw - 330) + 'px)' : '88ch');
    const probe = activeMain.querySelector('p, .xr-sec > p, ul, ol, h2') || activeMain;
    const right = Math.min(probe.getBoundingClientRect().right - mr.left, mr.width);
    marginEl.style.display = wide ? 'block' : 'none';
    marginEl.style.left = (right + 30) + 'px';
    marginEl.style.width = Math.max(200, Math.min(300, mr.width - right - 36)) + 'px';
    let y = 0;

    state.marks
      .filter(function (m) { return m.type === 'note'; })
      .map(function (m) { return { m: m, el: activeMain.querySelector('mark.xr-m[data-id="' + m.id + '"]') }; })
      .filter(function (x) { return x.el && !x.el.closest('.xr-sec.closed'); })
      .sort(function (a, b) { return a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top; })
      .forEach(function (x) {
        const m = x.m;
        const markNode = x.el;
        const c = document.createElement('div');
        c.className = 'xr-card' + (wide ? '' : ' inline');
        c.setAttribute('data-id', m.id);
        c.innerHTML = '<div class="q">' + escHtml(m.quote) + '</div><textarea rows="1" placeholder="' + escHtml(L.ph) + '"></textarea>';
        const ta = c.querySelector('textarea');
        ta.value = m.note || '';
        const fit = function () {
          ta.style.height = 'auto';
          ta.style.height = ta.scrollHeight + 'px';
        };
        ta.addEventListener('input', function () {
          m.note = ta.value;
          fit();
        });
        ta.addEventListener('change', function () {
          m.note = ta.value;
          postParent({
            type: 'mp-xray-annotation',
            id: activeWidgetId,
            mark: Object.assign({}, m),
            updated: true,
          });
        });
        c.addEventListener('mouseenter', function () {
          [].slice.call(activeMain.querySelectorAll('mark[data-id="' + m.id + '"]')).forEach(function (item) {
            item.classList.add('flash');
          });
        });
        c.addEventListener('mouseleave', function () {
          [].slice.call(activeMain.querySelectorAll('mark[data-id="' + m.id + '"]')).forEach(function (item) {
            item.classList.remove('flash');
          });
        });
        if (wide) {
          let top = markNode.getBoundingClientRect().top - mr.top - 8;
          top = Math.max(top, y);
          c.style.top = top + 'px';
          marginEl.appendChild(c);
          fit();
          y = top + c.offsetHeight + 10;
        } else {
          const blk = markNode.closest('p,li,td,blockquote,div') || markNode;
          blk.parentNode.insertBefore(c, blk.nextSibling);
          fit();
        }
      });
  }

  /* ---------- Floating Selection Bar, Menu & Toast ---------- */
  function hideBar() {
    if (!barEl) {
      return;
    }
    barEl.style.display = 'none';
    barEl.classList.remove('fbopen');
  }

  function showToast(msg) {
    if (!toastEl) {
      return;
    }
    toastEl.innerHTML = '<i>✓</i>' + escHtml(msg);
    toastEl.style.display = 'block';
    window.requestAnimationFrame(function () {
      if (toastEl) {
        toastEl.classList.add('show');
      }
    });
    window.clearTimeout(toastEl._t);
    toastEl._t = window.setTimeout(function () {
      if (!toastEl) {
        return;
      }
      toastEl.classList.remove('show');
      window.setTimeout(function () {
        if (toastEl) {
          toastEl.style.display = 'none';
        }
      }, 300);
    }, 1500);
  }

  function addMark(type, fb) {
    if (!activeMain) {
      return;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      return;
    }
    const r = sel.getRangeAt(0);
    const ix = textIndex();
    const off = rangeOffsets(r, ix);
    if (!off) {
      return;
    }
    const m = {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type: type,
      kind: type,
      quote: ix.txt.slice(off[0], off[1]),
      prefix: ix.txt.slice(Math.max(0, off[0] - 32), off[0]),
      suffix: ix.txt.slice(off[1], off[1] + 32),
      t: nowIso(),
    };
    if (fb) {
      m.fb = fb;
    }
    if (type === 'note') {
      m.note = '';
    }
    const firstMark = wrapRange(off[0], off[1], m);
    if (!firstMark) {
      return;
    }
    m.sec = sectionOf(firstMark);
    state.marks.push(m);
    sel.removeAllRanges();
    hideBar();
    if (type === 'note') {
      renderCards();
      const ta = activeMain.querySelector('.xr-card[data-id="' + m.id + '"] textarea');
      if (ta) {
        ta.focus();
      }
    }
    if (type === 'fb') {
      showToast(L.got + ' · ' + (L[fb] || fb));
    }
    postParent({
      type: 'mp-xray-annotation',
      id: activeWidgetId,
      mark: Object.assign({}, m),
    });
  }

  function removeMark(id) {
    if (!activeMain) {
      return;
    }
    [].slice.call(activeMain.querySelectorAll('mark.xr-m[data-id="' + id + '"]')).forEach(function (el) {
      const p = el.parentNode;
      while (el.firstChild) {
        p.insertBefore(el.firstChild, el);
      }
      p.removeChild(el);
      p.normalize();
    });
    state.marks = state.marks.filter(function (m) { return m.id !== id; });
    renderCards();
    postParent({
      type: 'mp-xray-annotation-remove',
      id: activeWidgetId,
      markId: id,
    });
  }

  function askSelection() {
    if (!activeMain) {
      return;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) {
      return;
    }
    const r = sel.getRangeAt(0);
    const quote = sel.toString().trim();
    if (!quote) {
      return;
    }
    let anchorNode = r.commonAncestorContainer;
    anchorNode = anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentNode;
    const sec = anchorNode ? sectionOf(anchorNode) : '';
    postParent({
      type: 'mp-xray-sidechat',
      id: activeWidgetId,
      quote: quote,
      section: sec,
    });
    sel.removeAllRanges();
    hideBar();
  }

  function ensureFloatingUi() {
    if (!barEl) {
      barEl = document.createElement('div');
      barEl.className = 'xr-ui xr-bar';
      barEl.innerHTML =
        '<button type="button" data-a="hl">' + escHtml(L.hl) + '</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-a="note">' + escHtml(L.note) + '</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-a="ask">' + escHtml(L.ask) + '</button>' +
        '<span class="sep"></span>' +
        '<button type="button" class="fbbtn" data-a="fbopen">' + escHtml(L.fb) + ' ›</button>' +
        '<button type="button" class="fb" data-a="confused">' + escHtml(L.confused) + '</button>' +
        '<button type="button" class="fb" data-a="verbose">' + escHtml(L.verbose) + '</button>' +
        '<button type="button" class="fb" data-a="known">' + escHtml(L.known) + '</button>';
      barEl.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
      });
      barEl.addEventListener('click', function (ev) {
        const targetBtn = ev.target && ev.target.closest ? ev.target.closest('button[data-a]') : null;
        const action = targetBtn ? targetBtn.getAttribute('data-a') : null;
        if (!action) {
          return;
        }
        if (action === 'fbopen') {
          barEl.classList.add('fbopen');
          return;
        }
        if (action === 'ask') {
          askSelection();
          return;
        }
        if (action === 'hl' || action === 'note') {
          addMark(action);
        } else {
          addMark('fb', action);
        }
      });
      document.body.appendChild(barEl);
    }
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.className = 'xr-ui xr-menu';
      menuEl.innerHTML = '<button type="button">' + escHtml(L.undo) + '</button>';
      document.body.appendChild(menuEl);
    }
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'xr-ui xr-toast';
      document.body.appendChild(toastEl);
    }
  }

  function showBar() {
    if (!barEl || activeMode !== 'study-doc' || !activeMain) {
      hideBar();
      return;
    }
    if (!document.body.classList.contains('xr-annot')) {
      hideBar();
      return;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) {
      hideBar();
      return;
    }
    const r = sel.getRangeAt(0);
    let c = r.commonAncestorContainer;
    c = c.nodeType === 1 ? c : c.parentNode;
    if (!c || !activeMain.contains(c) || (c.closest && c.closest(SKIP_TEXT)) || !sel.toString().trim()) {
      hideBar();
      return;
    }
    const b = r.getBoundingClientRect();
    barEl.style.display = 'block';
    barEl.style.left = Math.max(8, Math.min(window.innerWidth - barEl.offsetWidth - 8, b.left + b.width / 2 - barEl.offsetWidth / 2)) + 'px';
    barEl.style.top = (b.top > 52 ? b.top - barEl.offsetHeight - 8 : b.bottom + 8) + 'px';
  }

  /* ---------- Sections & TOC ---------- */
  function slugHeading(s, i) {
    return 's' + i + '-' + String(s || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').slice(0, 40);
  }

  function foldSection(h, on) {
    h.classList.toggle('folded', on);
    const box = h.nextElementSibling;
    if (box && box.classList.contains('xr-sec')) {
      box.classList.toggle('closed', on);
    }
    state.folds = state.folds.filter(function (x) { return x !== h.id; });
    if (on && h.id) {
      state.folds.push(h.id);
    }
    if (marginEl) {
      renderCards();
    }
  }

  function directHeadings(container) {
    return [].slice.call(container.children).filter(function (node) {
      return /^H[23]$/.test(node.tagName);
    });
  }

  function wrapSections(root) {
    if (!activeMain) {
      return;
    }
    const hs = directHeadings(activeMain);
    hs.forEach(function (h, i) {
      if (!h.id) {
        h.id = slugHeading(h.textContent, i);
      }
    });

    ['H2', 'H3'].forEach(function (lv) {
      const targets = lv === 'H2'
        ? [].slice.call(activeMain.children).filter(function (el) { return el.tagName === 'H2'; })
        : [].slice.call(activeMain.querySelectorAll('h3')).filter(function (el) {
            return el.parentNode === activeMain || (el.parentNode && el.parentNode.classList && el.parentNode.classList.contains('xr-sec'));
          });
      targets.forEach(function (h) {
        if (!h.querySelector('.xr-fold')) {
          let box = h.nextElementSibling;
          if (!box || !box.classList.contains('xr-sec')) {
            box = document.createElement('div');
            box.className = 'xr-sec';
            let n = h.nextSibling;
            while (n) {
              if (
                n.nodeType === 1 &&
                (
                  /^H[12]$/.test(n.tagName) ||
                  (lv === 'H3' && n.tagName === 'H3') ||
                  (n.classList && (n.classList.contains('xr-margin') || n.classList.contains('xr-sec')))
                )
              ) {
                break;
              }
              const nx = n.nextSibling;
              box.appendChild(n);
              n = nx;
            }
            h.parentNode.insertBefore(box, h.nextSibling);
          }
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'xr-fold';
          btn.textContent = '▾';
          btn.title = L.fold;
          h.insertBefore(btn, h.firstChild);
          btn.addEventListener('click', function () {
            foldSection(h, !h.classList.contains('folded'));
          });
        }
      });
    });

    state.folds.forEach(function (id) {
      const h = document.getElementById(id);
      if (h) {
        foldSection(h, true);
      }
    });

    const toc = root.querySelector('#xr-toc') || root.querySelector('.toc');
    if (toc) {
      toc.classList.add('toc');
      toc.innerHTML = '';
      const allHs = [].slice.call(activeMain.querySelectorAll('h2, h3'));
      allHs.forEach(function (h, i) {
        if (!h.id) {
          h.id = slugHeading(h.textContent, i);
        }
        const a = document.createElement('a');
        a.href = '#' + h.id;
        a.className = h.tagName.toLowerCase();
        a.textContent = h.textContent.replace(/^[▾▸]\s*/, '').trim();
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          document.body.classList.remove('nav-open');
          const sec = h.closest('.xr-sec.closed');
          if (sec && sec.previousElementSibling) {
            foldSection(sec.previousElementSibling, false);
          }
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        toc.appendChild(a);
      });
    }
  }

  function tocTrack() {
    if (!activeRoot || activeMode !== 'study-doc') {
      return;
    }
    const toc = activeRoot.querySelector('#xr-toc') || activeRoot.querySelector('.toc');
    if (!toc) {
      return;
    }
    const links = [].slice.call(toc.querySelectorAll('a'));
    const hs = links.map(function (a) {
      const href = a.getAttribute('href') || '';
      return href.startsWith('#') ? document.getElementById(href.slice(1)) : null;
    });
    let cur = 0;
    hs.forEach(function (h, i) {
      if (h && h.offsetParent && h.getBoundingClientRect().top < 120) {
        cur = i;
      }
    });
    links.forEach(function (a, i) {
      a.classList.toggle('cur', i === cur);
    });
  }

  /* ---------- Inline Check-In Hydration ---------- */
  function hydrateCheckins(root) {
    if (!root) {
      return;
    }
    const cardsList = [].slice.call(root.querySelectorAll('.mp-inline-checkin'));
    cardsList.forEach(function (card, cardIndex) {
      if (card.dataset.checkinHydrated === 'true') {
        return;
      }
      card.dataset.checkinHydrated = 'true';

      const submitBtn = card.querySelector('.mp-checkin-submit, [data-checkin-submit], button[type="submit"]');
      const optionEls = [].slice
        .call(card.querySelectorAll('.mp-checkin-option, [data-checkin-option], [data-option], [data-choice], .mp-checkin-options > button, .mp-checkin-options > label'))
        .filter(function (el) { return el !== submitBtn; });
      const textarea = card.querySelector('textarea');

      let selectedOpt = optionEls.find(function (el) {
        const radio = el.querySelector('input[type="radio"]');
        return el.classList.contains('is-selected') || el.getAttribute('aria-pressed') === 'true' || (radio && radio.checked);
      }) || null;

      function syncSelectionVisual() {
        optionEls.forEach(function (opt) {
          const isSel = opt === selectedOpt;
          opt.classList.toggle('is-selected', isSel);
          opt.setAttribute('aria-pressed', isSel ? 'true' : 'false');
          const radio = opt.querySelector('input[type="radio"]');
          if (radio) {
            radio.checked = isSel;
          }
        });
      }

      function selectOption(opt) {
        if (card.dataset.submitted === 'true') {
          return;
        }
        selectedOpt = opt;
        syncSelectionVisual();
      }

      optionEls.forEach(function (opt) {
        opt.addEventListener('click', function () {
          selectOption(opt);
        });
      });

      card.addEventListener('keydown', function (ev) {
        if (card.dataset.submitted === 'true') {
          return;
        }
        if (ev.target && (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT')) {
          if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && submitBtn) {
            ev.preventDefault();
            submitBtn.click();
          }
          return;
        }
        if (/^[1-4]$/.test(ev.key)) {
          const idx = Number(ev.key) - 1;
          if (optionEls[idx]) {
            ev.preventDefault();
            selectOption(optionEls[idx]);
          }
        }
      });

      function doSubmit() {
        if (card.dataset.submitted === 'true') {
          return;
        }
        const noteText = textarea ? textarea.value.trim() : '';
        if (!selectedOpt && !noteText) {
          if (textarea) {
            textarea.focus();
          } else if (optionEls[0]) {
            optionEls[0].focus();
          }
          return;
        }
        const selIdx = selectedOpt ? optionEls.indexOf(selectedOpt) : -1;
        const keyNode = selectedOpt ? selectedOpt.querySelector('.mp-checkin-key') : null;
        const labelNode = selectedOpt ? selectedOpt.querySelector('.mp-checkin-label') : null;
        const selectedKey = selectedOpt
          ? String(selectedOpt.getAttribute('data-key') || (keyNode ? keyNode.textContent : '') || (selIdx >= 0 ? String(selIdx + 1) : '')).trim()
          : '';
        const selectedValue = selectedOpt
          ? String(selectedOpt.getAttribute('data-value') || selectedOpt.getAttribute('data-option') || selectedOpt.getAttribute('data-choice') || selectedKey).trim()
          : '';
        const selectedLabel = selectedOpt
          ? String(labelNode ? labelNode.textContent : selectedOpt.textContent || '').trim()
          : '';
        const isUnsure = Boolean(
          selectedOpt &&
          (selectedOpt.classList.contains('is-unsure') || selectedValue === 'unsure' || /不确定/.test(selectedLabel)),
        );
        const promptNode = card.querySelector('.mp-checkin-prompt, .mp-checkin-question, h3, h4, p');
        const promptText = promptNode ? promptNode.textContent.trim() : '';
        const checkinId = card.getAttribute('data-checkin-id') || card.getAttribute('data-id') || ('checkin-' + (cardIndex + 1));

        const payload = {
          id: checkinId,
          checkinId: checkinId,
          prompt: promptText,
          question: promptText,
          selectedIndex: selIdx >= 0 ? selIdx : null,
          selectedKey: selectedKey,
          selectedValue: selectedValue,
          selectedLabel: selectedLabel,
          unsure: isUnsure,
          reasoningNote: noteText,
          note: noteText,
          section: sectionOf(card),
        };

        postParent({
          type: 'mp-xray-checkin-submit',
          id: activeWidgetId,
          payload: payload,
        });

        card.dataset.submitted = 'true';
        card.classList.add('is-submitted');
        optionEls.forEach(function (opt) {
          if (opt.tagName === 'BUTTON') {
            opt.disabled = true;
          }
          const radio = opt.querySelector('input[type="radio"]');
          if (radio) {
            radio.disabled = true;
          }
        });
        if (textarea) {
          textarea.readOnly = true;
          textarea.disabled = true;
        }
        const actionsRow = card.querySelector('.mp-checkin-actions');
        if (actionsRow) {
          actionsRow.style.display = 'none';
        } else if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.style.display = 'none';
        }
        if (!card.querySelector('.mp-checkin-receipt')) {
          const receipt = document.createElement('div');
          receipt.className = 'mp-checkin-receipt';
          const summaryParts = [L.submitted];
          if (selectedLabel) {
            summaryParts.push(selectedLabel);
          }
          const head = document.createElement('div');
          head.className = 'mp-checkin-receipt-head';
          head.textContent = '✓ ' + summaryParts.join(' · ');
          receipt.appendChild(head);
          if (noteText) {
            const noteEl = document.createElement('div');
            noteEl.className = 'mp-checkin-receipt-note';
            noteEl.textContent = noteText;
            receipt.appendChild(noteEl);
          }
          card.appendChild(receipt);
        }
      }

      if (submitBtn) {
        submitBtn.addEventListener('click', function (ev) {
          ev.preventDefault();
          doSubmit();
        });
      }
      syncSelectionVisual();
    });
  }

  /* ---------- Global Listeners (bound once) ---------- */
  function bindDocumentListeners() {
    if (listenersBound) {
      return;
    }
    listenersBound = true;

    document.addEventListener('mouseup', function () {
      window.setTimeout(showBar, 0);
    });
    document.addEventListener('keyup', function (ev) {
      if (ev.shiftKey) {
        showBar();
      }
      if (ev.key === 'Escape') {
        hideBar();
        if (menuEl) {
          menuEl.style.display = 'none';
        }
      }
    });
    document.addEventListener('mousedown', function (ev) {
      if (barEl && !barEl.contains(ev.target)) {
        hideBar();
      }
      if (menuEl && !menuEl.contains(ev.target)) {
        menuEl.style.display = 'none';
      }
    });
    document.addEventListener('contextmenu', function (ev) {
      if (activeMode !== 'study-doc' || !menuEl || !ev.target || !ev.target.closest) {
        return;
      }
      const t = ev.target.closest('mark.xr-m, .xr-card');
      if (!t) {
        return;
      }
      ev.preventDefault();
      const id = t.getAttribute('data-id');
      menuEl.style.display = 'block';
      menuEl.style.left = Math.min(ev.clientX, window.innerWidth - 90) + 'px';
      menuEl.style.top = ev.clientY + 'px';
      const btn = menuEl.querySelector('button');
      if (btn) {
        btn.onclick = function () {
          menuEl.style.display = 'none';
          if (id) {
            removeMark(id);
          }
        };
      }
    });
    window.addEventListener(
      'scroll',
      function () {
        if (activeMode !== 'study-doc') {
          return;
        }
        if (progressEl) {
          const h = document.documentElement.scrollHeight - window.innerHeight;
          progressEl.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + '%';
          progressEl.style.opacity = '0.28';
          window.clearTimeout(progressTimer);
          progressTimer = window.setTimeout(function () {
            if (progressEl) {
              progressEl.style.opacity = '0';
            }
          }, 1200);
        }
        tocTrack();
        hideBar();
      },
      { passive: true },
    );
    window.addEventListener('resize', function () {
      if (activeMode === 'study-doc') {
        renderCards();
      }
    });
  }

  /* ---------- Public XRAY API ---------- */
  function setPen(on) {
    penOn = Boolean(on);
    document.body.classList.toggle('xr-annot', penOn);
    const penBtn = activeRoot ? activeRoot.querySelector('#xrPen') : document.getElementById('xrPen');
    if (penBtn) {
      penBtn.classList.toggle('on', penOn);
    }
    if (!penOn) {
      hideBar();
    }
  }

  function toggleTheme(theme) {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = theme === 'dark' || theme === 'light' ? theme : cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    return next;
  }

  function lintXray(root) {
    const scope = root ? resolveHost(root) : (activeMain || document.querySelector('main') || document.getElementById('mp-iui-root') || document.body);
    const out = [];
    if (!scope) {
      return out;
    }
    const Q = EN ? /\?|^(what|why|how|which|when|where)\b/i : /[？?]|什么|为什么|怎么|怎样|如何|哪|吗|呢/;
    [].slice.call(scope.querySelectorAll('h1, h2, h3')).forEach(function (h) {
      const t = h.textContent.replace(/^[▾▸]\s*/, '');
      if (Q.test(t)) {
        out.push('heading reads as a question: ' + t);
      }
    });
    const prevMain = activeMain;
    activeMain = scope;
    const txt = textIndex().txt;
    activeMain = prevMain;
    const dash = (txt.match(/——|—/g) || []).length;
    const quotes = (txt.match(EN ? /[“”]/g : /[“”「」]/g) || []).length;
    if (dash > 3) {
      out.push('dashes in prose: ' + dash + ' (bold instead)');
    }
    if (quotes > 6) {
      out.push('quotation marks in prose: ' + quotes + ' (bold instead)');
    }
    const md = [].slice.call(scope.querySelectorAll('p, li, td, th'))
      .map(function (el) { return el.textContent; })
      .join('\n')
      .match(/\*\*[^*\n]+\*\*|(^|\n)#{1,4} /g);
    if (md) {
      out.push('markdown left in HTML (use <b>): ' + md.slice(0, 3).join(' | '));
    }
    [].slice.call(scope.querySelectorAll('.fk-fig')).forEach(function (h) {
      if (!h.children.length) {
        out.push('empty figure host #' + h.id);
      }
    });
    const notesBlock = scope.querySelector('#xray-notes') || document.getElementById('xray-notes');
    if (notesBlock) {
      try {
        const d = JSON.parse(notesBlock.textContent || '{}').doc || {};
        if (!d.title || !d.made) {
          out.push('#xray-notes doc.title / doc.made empty');
        }
      } catch {
        out.push('#xray-notes is not JSON');
      }
    }
    if (/[?&]lint/.test(window.location.search) && document.body) {
      const pre = document.createElement('pre');
      pre.id = 'xr-lint';
      pre.textContent = out.length ? out.join('\n') : 'XRAY.lint ok';
      document.body.appendChild(pre);
    }
    out.forEach(function (msg) { console.warn('[XRAY.lint] ' + msg); });
    return out;
  }

  function reset() {
    queue = [];
    state = { v: 1, marks: [], folds: [] };
    marginEl = null;
    activeMain = null;
    activeRoot = null;
    hideBar();
    if (menuEl) {
      menuEl.style.display = 'none';
    }
  }

  function hydrate(root, options) {
    const opts = options || {};
    activeRoot = resolveHost(root) || document.getElementById('mp-iui-root') || document.body;
    activeMode = opts.mode === 'study-doc' ? 'study-doc' : 'widget';
    activeWidgetId = String(opts.widgetId || '');

    const callbacks = queue.slice();
    queue = [];
    callbacks.forEach(function (fn) {
      try {
        if (typeof fn === 'function') {
          fn();
        }
      } catch (err) {
        console.error('[XRAY.ready]', err);
      }
    });

    renderMath(activeRoot);
    hydrateCheckins(activeRoot);

    if (activeMode === 'study-doc') {
      activeMain = activeRoot.querySelector('main') || activeRoot;
      let embedded = {};
      const embEl = activeRoot.querySelector('#xray-notes') || document.getElementById('xray-notes');
      if (embEl) {
        try {
          embedded = JSON.parse(embEl.textContent || '{}') || {};
        } catch {
          embedded = {};
        }
      }
      const rawMarks = Array.isArray(opts.initialMarks)
        ? opts.initialMarks
        : Array.isArray(embedded.marks)
          ? embedded.marks
          : [];
      const initMarks = rawMarks.map(function (raw) {
        const m = Object.assign({}, raw);
        const inferredType =
          m.type ||
          m.kind ||
          (m.fb ? 'fb' : m.note !== undefined || m.comment !== undefined ? 'note' : 'hl');
        m.type = inferredType;
        m.kind = inferredType;
        m.quote = m.quote || m.text || '';
        if (inferredType === 'note' && m.note === undefined) {
          m.note = m.comment || '';
        }
        return m;
      });
      state = {
        v: 1,
        marks: initMarks,
        folds: Array.isArray(embedded.folds) ? embedded.folds.slice() : [],
      };

      progressEl = activeRoot.querySelector('#progress') || document.getElementById('progress');
      if (!progressEl && document.body) {
        progressEl = document.createElement('div');
        progressEl.id = 'progress';
        document.body.prepend(progressEl);
      }

      wrapSections(activeRoot);
      ensureFloatingUi();
      state.marks.forEach(anchorMark);
      renderCards();

      const navBtn = activeRoot.querySelector('#xrNav');
      if (navBtn) {
        navBtn.title = L.toc;
        navBtn.onclick = function () {
          document.body.classList.toggle(window.innerWidth <= 1100 ? 'nav-open' : 'nav-hidden');
          window.setTimeout(renderCards, 50);
        };
      }
      const themeBtn = activeRoot.querySelector('#xrTheme');
      if (themeBtn) {
        themeBtn.title = L.theme;
        themeBtn.onclick = function () {
          toggleTheme();
        };
      }
      const penBtn = activeRoot.querySelector('#xrPen');
      if (penBtn) {
        penBtn.title = L.pen;
        penBtn.onclick = function () {
          setPen(!penOn);
        };
      }
      const saveBtn = activeRoot.querySelector('#xrSave');
      if (saveBtn) {
        saveBtn.title = L.save;
        saveBtn.onclick = function () {
          postParent({ type: 'mp-xray-save', id: activeWidgetId, state: state });
          showToast(L.saved);
        };
      }

      setPen(Boolean(opts.penActive));
      bindDocumentListeners();
      tocTrack();

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () {
          if (activeMode === 'study-doc') {
            renderCards();
          }
        });
      }
    } else {
      activeMain = null;
      setPen(false);
    }
  }

  window.FK = FK;
  window.XRAY = {
    ready: function (fn) { queue.push(fn); },
    hydrate: hydrate,
    reset: reset,
    setPen: setPen,
    lint: lintXray,
    toggleTheme: toggleTheme,
    add: addMark,
    remove: removeMark,
    state: function () { return state; },
  };
})();
