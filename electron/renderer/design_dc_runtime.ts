'use strict';

declare global {
  interface DesignTweakDef {
    key: string;
    kind:
      | 'text'
      | 'color'
      | 'int'
      | 'float'
      | 'range'
      | 'boolean'
      | 'enum'
      | 'null';
    label: string;
    value: unknown;
    defaultValue: unknown;
    options?: Array<string | {value: string; label: string}>;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    section?: string;
    tsType?: string;
  }

  interface DesignPropsSchema {
    preview?: {width: number; height: number};
    props: DesignTweakDef[];
    rawMap: Record<string, unknown>;
  }

  interface DesignOutlineNode {
    tid: number;
    path: string;
    tag: string;
    id?: string;
    className?: string;
    selector: string;
    text: string;
    htmlHint: string;
    rect?: {x: number; y: number; w: number; h: number};
    children: DesignOutlineNode[];
  }

  interface DesignAnchorInput {
    file: string;
    tid: number;
    path: string;
    selector?: string;
    htmlHint?: string;
    text?: string;
    version: number;
    lastGoodPosition?: {x: number; y: number};
    rect?: {x: number; y: number; w: number; h: number};
  }

  interface DesignAnchorResolution {
    state: 'anchored' | 'reanchored' | 'stale' | 'lost';
    tid?: number;
    path?: string;
    selector?: string;
    score?: number;
    lastGoodPosition?: {x: number; y: number};
  }

  interface DesignDcRenderResult {
    isDc: boolean;
    renderedHtml: string;
    helmetHtml: string;
    errors: string[];
    propsMeta: DesignTweakDef[];
    preview?: {width: number; height: number};
  }

  interface DesignDcRuntimeApi {
    isDcDocument(html: string): boolean;
    parseDataPropsSchema(raw: string): DesignPropsSchema;
    renderDcDocument(
      html: string,
      overrides?: Record<string, unknown>,
      options?: {streaming?: boolean},
    ): DesignDcRenderResult;
    updateDataPropsInHtml(html: string, key: string, value: unknown): string;
    buildOutlineTree(html: string): DesignOutlineNode[];
    flattenOutline(nodes: DesignOutlineNode[]): DesignOutlineNode[];
    formatAnchorId(file: string, tid: number, pathStr: string): string;
    parseAnchorId(
      anchor: string,
    ): {file: string; tid: number; path: string} | null;
    resolveAnchorDrift(
      anchor: DesignAnchorInput,
      outline: Array<{
        tid: number;
        path: string;
        tag: string;
        text: string;
        htmlHint: string;
        selector?: string;
        rect?: {x: number; y: number; w: number; h: number};
      }>,
      currentVersion: number,
    ): DesignAnchorResolution;
  }

  var DesignDcRuntime: DesignDcRuntimeApi | undefined;
}

(() => {
  const VOID_TAGS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);

  function unescapeHtmlEntities(input: string): string {
    return input
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function escapeHtml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttrSingleQuote(json: string): string {
    return json.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  }

  function isDcDocument(html: string): boolean {
    if (!html || typeof html !== 'string') {
      return false;
    }
    return /<x-dc\b/i.test(html) || /<script\b[^>]*\bdata-dc-script\b/i.test(html);
  }

  function inferKindFromValue(val: unknown): DesignTweakDef['kind'] {
    if (val === null) {
      return 'null';
    }
    if (typeof val === 'boolean') {
      return 'boolean';
    }
    if (typeof val === 'number') {
      return Number.isInteger(val) ? 'int' : 'float';
    }
    if (typeof val === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(val.trim())) {
      return 'color';
    }
    return 'text';
  }

  function parseSinglePropDef(key: string, rawVal: unknown): DesignTweakDef {
    if (rawVal === null) {
      return {
        key,
        kind: 'null',
        label: key,
        value: null,
        defaultValue: null,
      };
    }
    if (typeof rawVal === 'object' && !Array.isArray(rawVal)) {
      const rec = rawVal as Record<string, unknown>;
      const rawType = typeof rec.type === 'string' ? rec.type.toLowerCase() : '';
      const defVal = 'default' in rec ? rec.default : rec.value;
      let kind: DesignTweakDef['kind'] = 'text';
      if (
        rawType === 'text' ||
        rawType === 'color' ||
        rawType === 'int' ||
        rawType === 'float' ||
        rawType === 'range' ||
        rawType === 'boolean' ||
        rawType === 'enum'
      ) {
        kind = rawType;
      } else {
        kind = inferKindFromValue(defVal);
      }
      return {
        key,
        kind,
        label: typeof rec.label === 'string' ? rec.label : key,
        value: defVal,
        defaultValue: defVal,
        options: Array.isArray(rec.options)
          ? (rec.options as DesignTweakDef['options'])
          : undefined,
        min: typeof rec.min === 'number' ? rec.min : undefined,
        max: typeof rec.max === 'number' ? rec.max : undefined,
        step: typeof rec.step === 'number' ? rec.step : undefined,
        unit: typeof rec.unit === 'string' ? rec.unit : undefined,
        section: typeof rec.section === 'string' ? rec.section : undefined,
        tsType: typeof rec.tsType === 'string' ? rec.tsType : undefined,
      };
    }
    return {
      key,
      kind: inferKindFromValue(rawVal),
      label: key,
      value: rawVal,
      defaultValue: rawVal,
    };
  }

  function parseDataPropsSchema(raw: string): DesignPropsSchema {
    const trimmed = unescapeHtmlEntities(String(raw || '')).trim();
    if (!trimmed) {
      return {props: [], rawMap: {}};
    }
    let parsed: Record<string, unknown>;
    try {
      const val = JSON.parse(trimmed);
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        return {props: [], rawMap: {}};
      }
      parsed = val as Record<string, unknown>;
    } catch {
      return {props: [], rawMap: {}};
    }

    let preview: {width: number; height: number} | undefined;
    const rawPreview = parsed.$preview;
    if (rawPreview && typeof rawPreview === 'object' && !Array.isArray(rawPreview)) {
      const p = rawPreview as Record<string, unknown>;
      if (typeof p.width === 'number' && typeof p.height === 'number') {
        preview = {width: p.width, height: p.height};
      }
    }

    const props: DesignTweakDef[] = [];
    for (const [key, val] of Object.entries(parsed)) {
      if (key === '$preview') {
        continue;
      }
      props.push(parseSinglePropDef(key, val));
    }

    return {preview, props, rawMap: parsed};
  }

  function extractDcScriptMatch(
    html: string,
  ): {fullMatch: string; attrs: string; rawProps: string; code: string} | null {
    const scriptRe =
      /<script\b([^>]*\bdata-dc-script\b[^>]*)>([\s\S]*?)<\/script>/i;
    const match = scriptRe.exec(html);
    if (!match) {
      return null;
    }
    const attrs = match[1] || '';
    const singleProps = /\bdata-props\s*=\s*'([\s\S]*?)'/i.exec(attrs);
    const doubleProps = /\bdata-props\s*=\s*"([\s\S]*?)"/i.exec(attrs);
    const rawProps = singleProps ? singleProps[1] : doubleProps ? doubleProps[1] : '';
    return {
      fullMatch: match[0],
      attrs,
      rawProps,
      code: match[2] || '',
    };
  }

  function lookupPath(scope: Record<string, unknown>, expr: string): unknown {
    const trimmed = expr.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed === 'true') {
      return true;
    }
    if (trimmed === 'false') {
      return false;
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    // Dotted property lookup only; expressions/function calls fail safely.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(trimmed)) {
      return undefined;
    }
    const parts = trimmed.split('.');
    let cur: unknown = scope;
    for (const part of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  function interpolateHoles(
    template: string,
    scope: Record<string, unknown>,
    rawText = false,
  ): string {
    return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => {
      const val = lookupPath(scope, expr);
      if (val === undefined || val === null) {
        return '';
      }
      const str = String(val);
      return rawText ? str : escapeHtml(str);
    });
  }

  function parseHtmlAttrs(attrText: string): Record<string, string> {
    const out: Record<string, string> = {};
    const attrRe = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrText)) !== null) {
      const key = m[1];
      const val = m[2] ?? m[3] ?? m[4] ?? '';
      out[key] = val;
    }
    return out;
  }

  function kebabToCamel(name: string): string {
    return name.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase());
  }

  function findBalancedTagClose(
    html: string,
    startIdx: number,
    tagName: string,
  ): {openEnd: number; closeStart: number; closeEnd: number} | null {
    const openEnd = html.indexOf('>', startIdx);
    if (openEnd === -1) {
      return null;
    }
    let depth = 1;
    let pos = openEnd + 1;
    const tagLower = tagName.toLowerCase();
    const re = new RegExp(`<(/?)${tagLower}\\b[^>]*>`, 'gi');
    re.lastIndex = pos;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (m[1] === '/') {
        depth -= 1;
        if (depth === 0) {
          return {
            openEnd,
            closeStart: m.index,
            closeEnd: m.index + m[0].length,
          };
        }
      } else if (!m[0].endsWith('/>')) {
        depth += 1;
      }
      pos = re.lastIndex;
    }
    return null;
  }

  function expandTemplate(
    template: string,
    scope: Record<string, unknown>,
    streaming: boolean,
  ): string {
    let out = template;

    // 1. Expand <sc-for list="..." as="...">
    for (let guard = 0; guard < 100; guard++) {
      const forMatch = /<sc-for\b([^>]*)>/i.exec(out);
      if (!forMatch) {
        break;
      }
      const balanced = findBalancedTagClose(out, forMatch.index, 'sc-for');
      if (!balanced) {
        break;
      }
      const attrs = parseHtmlAttrs(forMatch[1] || '');
      const listExpr = (attrs.list || '').replace(/^\{\{|\}\}$/g, '').trim();
      const alias = attrs.as || 'item';
      const hintCount = Number(attrs['hint-placeholder-count'] || '0');
      const inner = out.slice(balanced.openEnd + 1, balanced.closeStart);
      const rawList = lookupPath(scope, listExpr);
      let items: unknown[] = Array.isArray(rawList) ? rawList : [];
      if (streaming && items.length === 0 && hintCount > 0) {
        items = Array.from({length: hintCount}, () => ({}));
      }
      const renderedItems = items
        .map((item, idx) => {
          const childScope: Record<string, unknown> = {
            ...scope,
            [alias]: item,
            $index: idx,
          };
          return expandTemplate(inner, childScope, streaming);
        })
        .join('');
      out =
        out.slice(0, forMatch.index) +
        renderedItems +
        out.slice(balanced.closeEnd);
    }

    // 2. Expand <sc-if value="...">
    for (let guard = 0; guard < 100; guard++) {
      const ifMatch = /<sc-if\b([^>]*)>/i.exec(out);
      if (!ifMatch) {
        break;
      }
      const balanced = findBalancedTagClose(out, ifMatch.index, 'sc-if');
      if (!balanced) {
        break;
      }
      const attrs = parseHtmlAttrs(ifMatch[1] || '');
      const valExpr = (attrs.value || '').replace(/^\{\{|\}\}$/g, '').trim();
      const inner = out.slice(balanced.openEnd + 1, balanced.closeStart);
      let cond = Boolean(lookupPath(scope, valExpr));
      if (streaming && attrs['hint-placeholder-val']) {
        const hintExpr = attrs['hint-placeholder-val']
          .replace(/^\{\{|\}\}$/g, '')
          .trim();
        cond = Boolean(lookupPath(scope, hintExpr));
      }
      const replacement = cond ? expandTemplate(inner, scope, streaming) : '';
      out = out.slice(0, ifMatch.index) + replacement + out.slice(balanced.closeEnd);
    }

    // 3. Expand <dc-import ...></dc-import>
    out = out.replace(
      /<dc-import\b([^>]*?)(?:\/>|><\/dc-import>)/gi,
      (_m, attrText: string) => {
        const attrs = parseHtmlAttrs(attrText);
        const name = attrs.name || 'Component';
        const styleAttr = attrs.style
          ? ` style="${escapeHtml(interpolateHoles(attrs.style, scope, true))}"`
          : '';
        const childProps: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'name' || k === 'style' || k === 'hint-size') {
            continue;
          }
          const holeMatch = /^\{\{([\s\S]*?)\}\}$/.exec(v.trim());
          childProps[kebabToCamel(k)] = holeMatch
            ? lookupPath(scope, holeMatch[1])
            : interpolateHoles(v, scope, true);
        }
        return `<div class="mp-dc-import" data-dc-import="${escapeHtml(name)}" data-dc-props='${escapeAttrSingleQuote(JSON.stringify(childProps))}'${styleAttr}></div>`;
      },
    );

    // 4. Expand <x-import ...></x-import>
    out = out.replace(
      /<x-import\b([^>]*?)(?:\/>|><\/x-import>)/gi,
      (_m, attrText: string) => {
        const attrs = parseHtmlAttrs(attrText);
        const comp = attrs['component-from-global-scope'] || '';
        const childProps: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(attrs)) {
          if (k === 'component-from-global-scope') {
            continue;
          }
          const holeMatch = /^\{\{([\s\S]*?)\}\}$/.exec(v.trim());
          childProps[kebabToCamel(k)] = holeMatch
            ? lookupPath(scope, holeMatch[1])
            : interpolateHoles(v, scope, true);
        }
        return `<div class="mp-x-import" data-x-import="${escapeHtml(comp)}" data-x-props='${escapeAttrSingleQuote(JSON.stringify(childProps))}'></div>`;
      },
    );

    // 5. Interpolate remaining {{ path }} holes
    return interpolateHoles(out, scope, false);
  }

  class BaseDcLogic {
    props: Record<string, unknown>;
    state: Record<string, unknown>;

    constructor(props: Record<string, unknown> = {}) {
      this.props = props;
      this.state = {};
    }

    setState(
      next:
        | Record<string, unknown>
        | ((prev: Record<string, unknown>) => Record<string, unknown>),
    ): void {
      const patch = typeof next === 'function' ? next(this.state) : next;
      this.state = {...this.state, ...patch};
    }

    forceUpdate(): void {
      // No-op in static/sync compilation pass
    }

    renderVals(): Record<string, unknown> {
      return {};
    }
  }

  function evaluateDcLogic(
    code: string,
    props: Record<string, unknown>,
  ): {vals: Record<string, unknown>; errors: string[]} {
    if (!code.trim()) {
      return {vals: {...props}, errors: []};
    }
    try {
      const factory = new Function(
        'DCLogic',
        'StreamableLogic',
        `${code}\n;return typeof Component !== "undefined" ? Component : null;`,
      ) as (
        dc: typeof BaseDcLogic,
        sl: typeof BaseDcLogic,
      ) => (new (p: Record<string, unknown>) => BaseDcLogic) | null;
      const Cls = factory(BaseDcLogic, BaseDcLogic);
      if (!Cls) {
        return {vals: {...props}, errors: ['Missing Component class extending DCLogic']};
      }
      const instance = new Cls(props);
      const vals = instance.renderVals();
      return {
        vals: vals && typeof vals === 'object' ? vals : {},
        errors: [],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {vals: {...props}, errors: [msg]};
    }
  }

  function renderDcDocument(
    html: string,
    overrides?: Record<string, unknown>,
    options?: {streaming?: boolean},
  ): DesignDcRenderResult {
    if (!isDcDocument(html)) {
      return {
        isDc: false,
        renderedHtml: html,
        helmetHtml: '',
        errors: [],
        propsMeta: [],
      };
    }

    const scriptInfo = extractDcScriptMatch(html);
    const schema = parseDataPropsSchema(scriptInfo?.rawProps || '');
    const mergedProps: Record<string, unknown> = {};
    for (const def of schema.props) {
      mergedProps[def.key] = def.value;
    }
    if (overrides) {
      for (const [k, v] of Object.entries(overrides)) {
        mergedProps[k] = v;
      }
    }

    const updatedPropsMeta = schema.props.map(def =>
      overrides && kInRecord(def.key, overrides)
        ? {...def, value: overrides[def.key]}
        : def,
    );

    const {vals, errors} = evaluateDcLogic(scriptInfo?.code || '', mergedProps);
    const scope: Record<string, unknown> = {...mergedProps, ...vals};
    const streaming = Boolean(options?.streaming);

    const xdcMatch = /<x-dc\b[^>]*>([\s\S]*?)<\/x-dc>/i.exec(html);
    let innerTemplate = xdcMatch ? xdcMatch[1] : '';

    // Extract & interpolate <helmet> blocks
    const helmetParts: string[] = [];
    innerTemplate = innerTemplate.replace(
      /<helmet\b[^>]*>([\s\S]*?)<\/helmet>/gi,
      (_m, content: string) => {
        helmetParts.push(interpolateHoles(content, scope, true));
        return '';
      },
    );

    const bodyHtml = expandTemplate(innerTemplate, scope, streaming);
    const helmetHtml = helmetParts.join('\n');

    let renderedHtml = html;
    if (xdcMatch) {
      renderedHtml =
        renderedHtml.slice(0, xdcMatch.index) +
        `<div class="mp-dc-root">${bodyHtml}</div>` +
        renderedHtml.slice(xdcMatch.index + xdcMatch[0].length);
    }
    if (scriptInfo) {
      renderedHtml = renderedHtml.replace(scriptInfo.fullMatch, '');
    }
    if (helmetHtml) {
      if (/<\/head>/i.test(renderedHtml)) {
        renderedHtml = renderedHtml.replace(/<\/head>/i, `${helmetHtml}\n</head>`);
      } else {
        renderedHtml = `${helmetHtml}\n${renderedHtml}`;
      }
    }

    return {
      isDc: true,
      renderedHtml,
      helmetHtml,
      errors,
      propsMeta: updatedPropsMeta,
      preview: schema.preview,
    };
  }

  function kInRecord(key: string, rec: Record<string, unknown>): boolean {
    return Object.prototype.hasOwnProperty.call(rec, key);
  }

  function updateDataPropsInHtml(html: string, key: string, value: unknown): string {
    const scriptInfo = extractDcScriptMatch(html);
    if (!scriptInfo) {
      return html;
    }
    const schema = parseDataPropsSchema(scriptInfo.rawProps);
    const nextMap: Record<string, unknown> = {...schema.rawMap};
    const existing = nextMap[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      ('default' in existing || 'type' in existing)
    ) {
      nextMap[key] = {...(existing as Record<string, unknown>), default: value};
    } else {
      nextMap[key] = value;
    }
    const serialized = escapeAttrSingleQuote(JSON.stringify(nextMap));
    const nextAttrs = /\bdata-props\s*=\s*(?:'[\s\S]*?'|"[\s\S]*?")/i.test(
      scriptInfo.attrs,
    )
      ? scriptInfo.attrs.replace(
          /\bdata-props\s*=\s*(?:'[\s\S]*?'|"[\s\S]*?")/i,
          `data-props='${serialized}'`,
        )
      : `${scriptInfo.attrs} data-props='${serialized}'`;
    const replacement = `<script${nextAttrs}>${scriptInfo.code}</script>`;
    return html.replace(scriptInfo.fullMatch, replacement);
  }

  function buildOutlineTree(html: string): DesignOutlineNode[] {
    const xdcMatch = /<x-dc\b[^>]*>([\s\S]*?)<\/x-dc>/i.exec(html);
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    const content = xdcMatch ? xdcMatch[1] : bodyMatch ? bodyMatch[1] : html;

    const roots: DesignOutlineNode[] = [];
    const stack: DesignOutlineNode[] = [];
    let tidCounter = 0;

    const tokenRe = /<!--[\s\S]*?-->|<\/([A-Za-z0-9-]+)\s*>|<([A-Za-z0-9-]+)([^>]*)>|([^<]+)/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(content)) !== null) {
      if (m[1]) {
        const closeTag = m[1].toLowerCase();
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === closeTag) {
            stack.length = i;
            break;
          }
        }
      } else if (m[2]) {
        const tag = m[2].toLowerCase();
        const attrRaw = m[3] || '';
        const selfClosing = attrRaw.trim().endsWith('/') || VOID_TAGS.has(tag);
        const attrs = parseHtmlAttrs(attrRaw);
        const parent = stack.length > 0 ? stack[stack.length - 1] : null;
        const childIdx = parent ? parent.children.length : roots.length;
        const pathStr = parent ? `${parent.path}/${childIdx}` : String(childIdx);
        const id = attrs.id || undefined;
        const className = attrs.class || undefined;
        const selector = id
          ? `#${id}`
          : className
            ? `${tag}.${className.trim().split(/\s+/)[0]}`
            : tag;
        const node: DesignOutlineNode = {
          tid: tidCounter++,
          path: pathStr,
          tag,
          id,
          className,
          selector,
          text: '',
          htmlHint: `<${tag}${attrRaw.trim() ? ' ' + attrRaw.trim() : ''}>`,
          children: [],
        };
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
        if (!selfClosing) {
          stack.push(node);
        }
      } else if (m[4]) {
        const text = m[4].replace(/\s+/g, ' ').trim();
        if (text && stack.length > 0) {
          const top = stack[stack.length - 1];
          top.text = top.text ? `${top.text} ${text}` : text;
        }
      }
    }
    return roots;
  }

  function flattenOutline(nodes: DesignOutlineNode[]): DesignOutlineNode[] {
    const out: DesignOutlineNode[] = [];
    const walk = (list: DesignOutlineNode[]) => {
      for (const node of list) {
        out.push(node);
        if (node.children.length > 0) {
          walk(node.children);
        }
      }
    };
    walk(nodes);
    return out;
  }

  function formatAnchorId(file: string, tid: number, pathStr: string): string {
    return `${file}#${tid}:${pathStr}`;
  }

  function parseAnchorId(
    anchor: string,
  ): {file: string; tid: number; path: string} | null {
    const m = /^(.+?)#(\d+):(\d+(?:\/\d+)*)$/.exec(anchor.trim());
    if (!m) {
      return null;
    }
    return {file: m[1], tid: Number(m[2]), path: m[3]};
  }

  function resolveAnchorDrift(
    anchor: DesignAnchorInput,
    outline: Array<{
      tid: number;
      path: string;
      tag: string;
      text: string;
      htmlHint: string;
      selector?: string;
      rect?: {x: number; y: number; w: number; h: number};
    }>,
    currentVersion: number,
  ): DesignAnchorResolution {
    const exact = outline.find(
      item =>
        item.tid === anchor.tid &&
        item.path === anchor.path &&
        (!anchor.htmlHint ||
          item.htmlHint === anchor.htmlHint ||
          item.selector === anchor.selector),
    );
    if (exact) {
      return {
        state: anchor.version === currentVersion ? 'anchored' : 'reanchored',
        tid: exact.tid,
        path: exact.path,
        selector: exact.selector,
      };
    }

    let bestScore = 0;
    let bestCandidate: (typeof outline)[number] | undefined;

    for (const item of outline) {
      let score = 0;
      if (anchor.selector && item.selector && anchor.selector === item.selector) {
        score += 4;
      }
      if (anchor.htmlHint && item.htmlHint && anchor.htmlHint === item.htmlHint) {
        score += 3;
      }
      if (anchor.text && item.text && anchor.text === item.text) {
        score += 2;
      }
      if (anchor.lastGoodPosition && item.rect) {
        const dx = item.rect.x - anchor.lastGoodPosition.x;
        const dy = item.rect.y - anchor.lastGoodPosition.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= 400) {
          score += 1 - dist / 400;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = item;
      }
    }

    if (bestCandidate && bestScore >= 2) {
      return {
        state: 'stale',
        tid: bestCandidate.tid,
        path: bestCandidate.path,
        selector: bestCandidate.selector,
        score: Math.round(bestScore * 100) / 100,
      };
    }

    return {
      state: 'lost',
      lastGoodPosition: anchor.lastGoodPosition,
    };
  }

  const api: DesignDcRuntimeApi = {
    isDcDocument,
    parseDataPropsSchema,
    renderDcDocument,
    updateDataPropsInHtml,
    buildOutlineTree,
    flattenOutline,
    formatAnchorId,
    parseAnchorId,
    resolveAnchorDrift,
  };

  globalThis.DesignDcRuntime = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
