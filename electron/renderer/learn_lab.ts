'use strict';

declare global {
  interface LearnLabParam {
    name: string;
    label: string;
    min: number;
    max: number;
    step?: number;
    value: number;
  }

  interface LearnLabCurve {
    label: string;
    expr: string;
    color?: 'clay' | 'ink' | 'sage' | 'amber';
  }

  interface LearnLabMarker {
    x?: number;
    y?: number;
    label?: string;
  }

  interface LearnLabSpec {
    title?: string;
    caption?: string;
    xLabel?: string;
    yLabel?: string;
    xRange?: [number, number];
    yRange?: [number, number];
    params?: LearnLabParam[];
    curves?: LearnLabCurve[];
    markers?: LearnLabMarker[];
  }

  interface LearnLabController {
    evaluateExpression(expr: string, vars: Record<string, number>): number;
    renderSvgMarkup(
      spec: LearnLabSpec,
      paramValues?: Record<string, number>,
    ): string;
    hydrate(container: Element): void;
    applyFadeMode(
      container: Element,
      enabled: boolean,
      onGrade?: (info: {
        blockIndex?: number;
        label: string;
        status: 'verified' | 'gap';
      }) => void,
    ): void;
  }

  var LearnLab: LearnLabController | undefined;
}

(() => {
  type TokenKind = 'num' | 'id' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

  interface Token {
    kind: TokenKind;
    value: string;
  }

  const CONSTANTS: Readonly<Record<string, number>> = {
    pi: Math.PI,
    PI: Math.PI,
    e: Math.E,
    E: Math.E,
  };

  const FUNCTIONS: Readonly<Record<string, (...args: number[]) => number>> = {
    sin: x => Math.sin(x),
    cos: x => Math.cos(x),
    tan: x => Math.tan(x),
    exp: x => Math.exp(Math.min(50, Math.max(-50, x))),
    log: x => (x > 0 ? Math.log(x) : Number.NaN),
    ln: x => (x > 0 ? Math.log(x) : Number.NaN),
    log10: x => (x > 0 ? Math.log10(x) : Number.NaN),
    sqrt: x => (x >= 0 ? Math.sqrt(x) : Number.NaN),
    abs: x => Math.abs(x),
    floor: x => Math.floor(x),
    ceil: x => Math.ceil(x),
    sigmoid: x => 1 / (1 + Math.exp(-Math.min(40, Math.max(-40, x)))),
    tanh: x => Math.tanh(x),
    min: (...args) => Math.min(...args),
    max: (...args) => Math.max(...args),
    pow: (a, b) => Math.pow(a, b),
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  };

  function tokenize(expr: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i]!;
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (/[0-9.]/.test(ch)) {
        const start = i;
        while (i < expr.length && /[0-9.eE]/.test(expr[i]!)) {
          if (
            (expr[i] === 'e' || expr[i] === 'E') &&
            (expr[i + 1] === '+' || expr[i + 1] === '-')
          ) {
            i += 2;
            continue;
          }
          i++;
        }
        out.push({kind: 'num', value: expr.slice(start, i)});
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const start = i;
        i++;
        while (i < expr.length && /[A-Za-z0-9_]/.test(expr[i]!)) {
          i++;
        }
        out.push({kind: 'id', value: expr.slice(start, i)});
        continue;
      }
      if (ch === '(') {
        out.push({kind: 'lparen', value: '('});
        i++;
        continue;
      }
      if (ch === ')') {
        out.push({kind: 'rparen', value: ')'});
        i++;
        continue;
      }
      if (ch === ',') {
        out.push({kind: 'comma', value: ','});
        i++;
        continue;
      }
      if ('+-*/^'.includes(ch)) {
        out.push({kind: 'op', value: ch});
        i++;
        continue;
      }
      throw new Error(`Unexpected math token: ${ch}`);
    }
    out.push({kind: 'eof', value: ''});
    return out;
  }

  function evaluateExpression(
    expr: string,
    vars: Record<string, number>,
  ): number {
    const tokens = tokenize(String(expr || ''));
    let pos = 0;
    const peek = (): Token => tokens[pos] || {kind: 'eof', value: ''};
    const next = (): Token => tokens[pos++] || {kind: 'eof', value: ''};

    const parseExpr = (): number => {
      let left = parseTerm();
      while (peek().kind === 'op' && (peek().value === '+' || peek().value === '-')) {
        const op = next().value;
        const right = parseTerm();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };

    const parseTerm = (): number => {
      let left = parsePower();
      while (peek().kind === 'op' && (peek().value === '*' || peek().value === '/')) {
        const op = next().value;
        const right = parsePower();
        left = op === '*' ? left * right : right === 0 ? Number.NaN : left / right;
      }
      return left;
    };

    const parsePower = (): number => {
      const base = parseUnary();
      if (peek().kind === 'op' && peek().value === '^') {
        next();
        const exponent = parsePower();
        return Math.pow(base, exponent);
      }
      return base;
    };

    const parseUnary = (): number => {
      if (peek().kind === 'op' && (peek().value === '+' || peek().value === '-')) {
        const op = next().value;
        const val = parseUnary();
        return op === '-' ? -val : val;
      }
      return parsePrimary();
    };

    const parsePrimary = (): number => {
      const tok = peek();
      if (tok.kind === 'num') {
        next();
        const n = Number(tok.value);
        if (!Number.isFinite(n)) {
          throw new Error(`Invalid number literal: ${tok.value}`);
        }
        return n;
      }
      if (tok.kind === 'lparen') {
        next();
        const val = parseExpr();
        if (peek().kind !== 'rparen') {
          throw new Error('Unmatched parenthesis');
        }
        next();
        return val;
      }
      if (tok.kind === 'id') {
        next();
        const name = tok.value;
        if (peek().kind === 'lparen') {
          const fn = FUNCTIONS[name];
          if (!fn) {
            throw new Error(`Unknown math function: ${name}`);
          }
          next();
          const args: number[] = [];
          if (peek().kind !== 'rparen') {
            args.push(parseExpr());
            while (peek().kind === 'comma') {
              next();
              args.push(parseExpr());
            }
          }
          if (peek().kind !== 'rparen') {
            throw new Error(`Unclosed call arguments for ${name}`);
          }
          next();
          return fn(...args);
        }
        if (Object.prototype.hasOwnProperty.call(vars, name)) {
          return Number(vars[name]);
        }
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) {
          return CONSTANTS[name]!;
        }
        throw new Error(`Unknown variable: ${name}`);
      }
      throw new Error(`Unexpected token in math expression: ${tok.value || tok.kind}`);
    };

    const result = parseExpr();
    if (peek().kind !== 'eof') {
      throw new Error(`Trailing math token: ${peek().value}`);
    }
    return result;
  }

  function escapeXml(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function curveStrokeColor(color?: string): string {
    if (color === 'clay') {
      return '#d97757';
    }
    if (color === 'sage') {
      return '#3b8264';
    }
    if (color === 'amber') {
      return '#c48322';
    }
    return 'var(--mp-ink, #1c1b18)';
  }

  function defaultParamValues(spec: LearnLabSpec): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of spec.params || []) {
      if (p?.name) {
        out[p.name] = Number.isFinite(Number(p.value)) ? Number(p.value) : 1;
      }
    }
    return out;
  }

  function renderSvgMarkup(
    spec: LearnLabSpec,
    paramValues?: Record<string, number>,
  ): string {
    const width = 460;
    const height = 190;
    const padL = 42;
    const padR = 16;
    const padT = 16;
    const padB = 28;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const xMin = Number.isFinite(Number(spec.xRange?.[0]))
      ? Number(spec.xRange![0])
      : -3;
    const xMax =
      Number.isFinite(Number(spec.xRange?.[1])) && Number(spec.xRange![1]) > xMin
        ? Number(spec.xRange![1])
        : xMin + 6;
    const vars = {...defaultParamValues(spec), ...(paramValues || {})};
    const curves = Array.isArray(spec.curves) ? spec.curves : [];
    const samplesCount = 120;

    const sampledCurves: Array<{
      curve: LearnLabCurve;
      points: Array<{x: number; y: number}>;
    }> = [];
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;

    for (const curve of curves) {
      const points: Array<{x: number; y: number}> = [];
      for (let s = 0; s <= samplesCount; s++) {
        const x = xMin + ((xMax - xMin) * s) / samplesCount;
        let y = Number.NaN;
        try {
          y = evaluateExpression(curve.expr, {...vars, x});
        } catch {
          y = Number.NaN;
        }
        if (Number.isFinite(y) && Math.abs(y) < 1e6) {
          points.push({x, y});
          if (y < yMin) {
            yMin = y;
          }
          if (y > yMax) {
            yMax = y;
          }
        }
      }
      sampledCurves.push({curve, points});
    }

    if (
      Array.isArray(spec.yRange) &&
      Number.isFinite(Number(spec.yRange[0])) &&
      Number.isFinite(Number(spec.yRange[1])) &&
      Number(spec.yRange[1]) > Number(spec.yRange[0])
    ) {
      yMin = Number(spec.yRange[0]);
      yMax = Number(spec.yRange[1]);
    } else if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = -1;
      yMax = 1;
    } else if (Math.abs(yMax - yMin) < 1e-6) {
      yMin -= 1;
      yMax += 1;
    } else {
      const margin = (yMax - yMin) * 0.12;
      yMin -= margin;
      yMax += margin;
    }

    const toSvgX = (x: number): number =>
      padL + ((x - xMin) / (xMax - xMin)) * plotW;
    const toSvgY = (y: number): number =>
      padT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;

    const gridLines: string[] = [];
    for (let i = 0; i <= 4; i++) {
      const gy = padT + (plotH * i) / 4;
      const yTick = yMax - ((yMax - yMin) * i) / 4;
      gridLines.push(
        `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${width - padR}" y2="${gy.toFixed(1)}" stroke="currentColor" stroke-opacity="0.09" stroke-width="1"/>`,
        `<text x="${padL - 6}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end" fill="currentColor" fill-opacity="0.52" font-size="9.5" font-family="monospace">${escapeXml(yTick.toFixed(1))}</text>`,
      );
    }
    for (let i = 0; i <= 4; i++) {
      const gx = padL + (plotW * i) / 4;
      const xTick = xMin + ((xMax - xMin) * i) / 4;
      gridLines.push(
        `<line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${padT + plotH}" stroke="currentColor" stroke-opacity="0.06" stroke-width="1"/>`,
        `<text x="${gx.toFixed(1)}" y="${height - 8}" text-anchor="middle" fill="currentColor" fill-opacity="0.52" font-size="9.5" font-family="monospace">${escapeXml(xTick.toFixed(1))}</text>`,
      );
    }

    if (yMin <= 0 && yMax >= 0) {
      const yZero = toSvgY(0);
      gridLines.push(
        `<line x1="${padL}" y1="${yZero.toFixed(1)}" x2="${width - padR}" y2="${yZero.toFixed(1)}" stroke="currentColor" stroke-opacity="0.22" stroke-width="1"/>`,
      );
    }
    if (xMin <= 0 && xMax >= 0) {
      const xZero = toSvgX(0);
      gridLines.push(
        `<line x1="${xZero.toFixed(1)}" y1="${padT}" x2="${xZero.toFixed(1)}" y2="${padT + plotH}" stroke="currentColor" stroke-opacity="0.22" stroke-width="1"/>`,
      );
    }

    const paths = sampledCurves.map(({curve, points}, idx) => {
      if (points.length < 2) {
        return '';
      }
      const d = points
        .map(
          (pt, ptIdx) =>
            `${ptIdx === 0 ? 'M' : 'L'}${toSvgX(pt.x).toFixed(2)} ${toSvgY(pt.y).toFixed(2)}`,
        )
        .join(' ');
      const stroke = curveStrokeColor(
        curve.color || (idx === 0 ? 'clay' : idx === 1 ? 'ink' : 'sage'),
      );
      return `<path class="mp-learn-lab-curve" d="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    });

    const markers = (spec.markers || [])
      .map(marker => {
        const parts: string[] = [];
        if (Number.isFinite(Number(marker.x))) {
          const sx = toSvgX(Number(marker.x));
          if (sx >= padL && sx <= width - padR) {
            parts.push(
              `<line x1="${sx.toFixed(1)}" y1="${padT}" x2="${sx.toFixed(1)}" y2="${padT + plotH}" stroke="#d97757" stroke-dasharray="4 3" stroke-width="1.25"/>`,
            );
          }
        }
        if (Number.isFinite(Number(marker.y))) {
          const sy = toSvgY(Number(marker.y));
          if (sy >= padT && sy <= padT + plotH) {
            parts.push(
              `<line x1="${padL}" y1="${sy.toFixed(1)}" x2="${width - padR}" y2="${sy.toFixed(1)}" stroke="#3b8264" stroke-dasharray="4 3" stroke-width="1.25"/>`,
            );
          }
        }
        return parts.join('');
      })
      .join('');

    return [
      `<svg viewBox="0 0 ${width} ${height}" class="mp-learn-lab-svg" role="img" aria-label="${escapeXml(spec.title || 'Interactive parameter plot')}">`,
      gridLines.join(''),
      markers,
      paths.join(''),
      '</svg>',
    ].join('');
  }

  function hydrateSingleLab(host: HTMLElement): void {
    const complete = host.getAttribute('data-learn-lab-complete') === 'true';
    const rawSpec = host.getAttribute('data-learn-lab-spec') || '';
    if (host.dataset.learnLabMounted === rawSpec) {
      return;
    }
    host.dataset.learnLabMounted = rawSpec;
    host.innerHTML = '';

    if (!complete) {
      const loading = document.createElement('div');
      loading.className = 'mp-learn-lab-loading';
      loading.textContent = '正在准备交互实验参数…';
      host.appendChild(loading);
      return;
    }

    let spec: LearnLabSpec | null = null;
    try {
      spec = JSON.parse(rawSpec) as LearnLabSpec;
    } catch {
      spec = null;
    }
    if (!spec || !Array.isArray(spec.curves) || spec.curves.length === 0) {
      const fallback = document.createElement('div');
      fallback.className = 'mp-learn-lab-loading';
      fallback.textContent = rawSpec.slice(0, 180) || '实验参数解析不可用';
      host.appendChild(fallback);
      return;
    }

    const activeSpec = spec;
    const values = defaultParamValues(activeSpec);

    const header = document.createElement('header');
    header.className = 'mp-learn-lab-head';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'mp-learn-lab-title-wrap';
    const badge = document.createElement('span');
    badge.className = 'mp-learn-card-tag';
    badge.textContent = 'EXPLORABLE LAB';
    titleWrap.appendChild(badge);
    if (activeSpec.title) {
      const titleEl = document.createElement('strong');
      titleEl.className = 'mp-learn-lab-title';
      titleEl.textContent = activeSpec.title;
      titleWrap.appendChild(titleEl);
    }
    header.appendChild(titleWrap);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mp-learn-lab-reset';
    resetBtn.textContent = '重置参数';
    header.appendChild(resetBtn);
    host.appendChild(header);

    if (activeSpec.caption) {
      const cap = document.createElement('p');
      cap.className = 'mp-learn-lab-caption';
      cap.textContent = activeSpec.caption;
      host.appendChild(cap);
    }

    const svgWrap = document.createElement('div');
    svgWrap.className = 'mp-learn-lab-plot';
    host.appendChild(svgWrap);

    const legend = document.createElement('div');
    legend.className = 'mp-learn-lab-legend';
    (activeSpec.curves || []).forEach((curve, idx) => {
      const item = document.createElement('span');
      item.className = 'mp-learn-lab-legend-item';
      const swatch = document.createElement('i');
      swatch.style.backgroundColor = curveStrokeColor(
        curve.color || (idx === 0 ? 'clay' : idx === 1 ? 'ink' : 'sage'),
      );
      item.appendChild(swatch);
      const txt = document.createElement('span');
      txt.textContent = `${curve.label} = ${curve.expr}`;
      item.appendChild(txt);
      legend.appendChild(item);
    });
    host.appendChild(legend);

    const controls = document.createElement('div');
    controls.className = 'mp-learn-lab-controls';
    const sliders: Array<{
      param: LearnLabParam;
      input: HTMLInputElement;
      readout: HTMLElement;
    }> = [];

    const repaint = (): void => {
      svgWrap.innerHTML = renderSvgMarkup(activeSpec, values);
    };

    for (const param of activeSpec.params || []) {
      if (!param?.name) {
        continue;
      }
      const row = document.createElement('label');
      row.className = 'mp-learn-lab-slider-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'mp-learn-lab-param-label';
      nameEl.textContent = param.label || param.name;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(param.min);
      input.max = String(param.max);
      input.step = String(
        param.step || Math.max(0.01, (param.max - param.min) / 40),
      );
      input.value = String(values[param.name]);

      const readout = document.createElement('code');
      readout.className = 'mp-learn-lab-param-val';
      readout.textContent = String(values[param.name]);

      input.addEventListener('input', () => {
        const nextVal = Number(input.value);
        values[param.name] = nextVal;
        readout.textContent = Number.isInteger(nextVal)
          ? String(nextVal)
          : nextVal.toFixed(2);
        repaint();
      });

      row.append(nameEl, input, readout);
      controls.appendChild(row);
      sliders.push({param, input, readout});
    }

    resetBtn.addEventListener('click', () => {
      const defaults = defaultParamValues(activeSpec);
      for (const item of sliders) {
        const dv = defaults[item.param.name];
        values[item.param.name] = dv;
        item.input.value = String(dv);
        item.readout.textContent = String(dv);
      }
      repaint();
    });

    if (sliders.length > 0) {
      host.appendChild(controls);
    }
    repaint();
  }

  function hydrate(container: Element): void {
    if (!container || typeof container.querySelectorAll !== 'function') {
      return;
    }
    container
      .querySelectorAll<HTMLElement>('.mp-learn-lab-host')
      .forEach(host => hydrateSingleLab(host));
  }

  function applyFadeMode(
    container: Element,
    enabled: boolean,
    onGrade?: (info: {
      blockIndex?: number;
      label: string;
      status: 'verified' | 'gap';
    }) => void,
  ): void {
    if (!container || typeof container.querySelectorAll !== 'function') {
      return;
    }
    const targets = container.querySelectorAll<HTMLElement>(
      '[data-fade-target="true"], .mp-learn-term',
    );
    targets.forEach(node => {
      if (!enabled) {
        node.classList.remove('is-learn-faded', 'is-fade-revealed');
        node.removeAttribute('data-fade-revealed');
        const checkBar = node.querySelector('.mp-learn-fade-check');
        if (checkBar) {
          checkBar.remove();
        }
        return;
      }
      if (node.dataset.fadeWired !== 'true') {
        node.dataset.fadeWired = 'true';
        node.addEventListener('click', ev => {
          if (!node.classList.contains('is-learn-faded')) {
            return;
          }
          if (!node.classList.contains('is-fade-revealed')) {
            ev.stopPropagation();
            node.classList.add('is-fade-revealed');
            node.setAttribute('data-fade-revealed', 'true');
            if (onGrade && !node.querySelector('.mp-learn-fade-check')) {
              const bar = document.createElement('span');
              bar.className = 'mp-learn-fade-check';
              const blockEl = node.closest('[data-block-index]');
              const blockIndex = blockEl
                ? Number((blockEl as HTMLElement).dataset.blockIndex)
                : undefined;
              const label = (node.textContent || '').trim().slice(0, 60);
              const okBtn = document.createElement('button');
              okBtn.type = 'button';
              okBtn.className = 'mp-learn-fade-grade is-ok';
              okBtn.textContent = '记住了';
              okBtn.addEventListener('click', gradeEv => {
                gradeEv.stopPropagation();
                onGrade({blockIndex, label, status: 'verified'});
                bar.textContent = '已巩固 ✓';
              });
              const gapBtn = document.createElement('button');
              gapBtn.type = 'button';
              gapBtn.className = 'mp-learn-fade-grade is-gap';
              gapBtn.textContent = '需强化';
              gapBtn.addEventListener('click', gradeEv => {
                gradeEv.stopPropagation();
                onGrade({blockIndex, label, status: 'gap'});
                bar.textContent = '已标待强化';
              });
              bar.append(okBtn, gapBtn);
              node.appendChild(bar);
            }
          }
        });
      }
      if (!node.classList.contains('is-fade-revealed')) {
        node.classList.add('is-learn-faded');
      }
    });
  }

  const LearnLabApi: LearnLabController = {
    evaluateExpression,
    renderSvgMarkup,
    hydrate,
    applyFadeMode,
  };

  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {LearnLab?: LearnLabController}
    ).LearnLab = LearnLabApi;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = LearnLabApi;
  }
})();
