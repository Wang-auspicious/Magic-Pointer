/* exported ChatHighlight */

type ChatTokenName =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'command'
  | 'variable'
  | 'comment'
  | 'operator'
  | 'function'
  | 'type'
  | 'decorator'
  | 'property';

interface ChatSpan {
  text: string;
  token: ChatTokenName;
}

type ChatLanguage =
  | 'powershell'
  | 'shell'
  | 'json'
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'css'
  | 'html'
  | 'rust'
  | 'go'
  | 'c'
  | 'java'
  | 'sql'
  | 'yaml'
  | 'markdown'
  | 'plain';

interface ChatLanguageMeta {
  lang: ChatLanguage;
  label: string;
  accent: string;
}

const ChatHighlight = (() => {
  const TAB = 9;
  const CR = 13;
  const SPACE = 32;
  const DQUOTE = 34;
  const HASH = 35;
  const DOLLAR = 36;
  const AMP = 38;
  const SQUOTE = 39;
  const LPAREN = 40;
  const RPAREN = 41;
  const STAR = 42;
  const PLUS = 43;
  const COMMA = 44;
  const DASH = 45;
  const DOT = 46;
  const SLASH = 47;
  const COLON = 58;
  const SEMI = 59;
  const LT = 60;
  const EQ = 61;
  const GT = 62;
  const QUESTION = 63;
  const BANG = 33;
  const BACKSLASH = 92;
  const UNDERSCORE = 95;
  const BACKTICK = 96;
  const LBRACE = 123;
  const PIPE = 124;
  const RBRACE = 125;
  const LBRACKET = 91;
  const RBRACKET = 93;
  const ZERO = 48;
  const NINE = 57;
  const LOWER_X = 120;
  const UPPER_X = 88;

  const PWSH_KEYWORDS = new Set([
    'function',
    'filter',
    'param',
    'begin',
    'process',
    'end',
    'if',
    'elseif',
    'else',
    'try',
    'catch',
    'finally',
    'throw',
    'return',
    'foreach',
    'for',
    'while',
    'do',
    'until',
    'switch',
    'break',
    'continue',
    'trap',
    'class',
    'enum',
  ]);

  const SHELL_KEYWORDS = new Set([
    'if',
    'then',
    'else',
    'elif',
    'fi',
    'for',
    'while',
    'do',
    'done',
    'case',
    'esac',
    'function',
    'return',
    'export',
    'local',
  ]);
  const SHELL_COMMAND_KEYWORDS = new Set(['export', 'local']);
  const SHELL_CONTINUATION = new Set(['then', 'do', 'else']);

  const OPERATORS = new Set([
    EQ,
    PLUS,
    DASH,
    STAR,
    SLASH,
    PIPE,
    GT,
    LT,
    BANG,
    QUESTION,
    COLON,
    COMMA,
    SEMI,
    LPAREN,
    RPAREN,
    LBRACE,
    RBRACE,
    LBRACKET,
    RBRACKET,
  ]);

  const PWSH_MARKERS = [
    'Invoke-WebRequest',
    'Write-Host',
    'Get-',
    'Set-',
    '-ErrorAction',
  ];

  const isSpaceCode = (code: number): boolean =>
    code === SPACE || code === TAB || code === CR;
  const isDigit = (code: number): boolean => code >= ZERO && code <= NINE;
  const isLetter = (code: number): boolean =>
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  const isNameCode = (code: number): boolean =>
    isLetter(code) || isDigit(code) || code === UNDERSCORE || code >= 128;
  const isHex = (code: number): boolean =>
    isDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
  const isWordLead = (code: number): boolean =>
    isLetter(code) || code === UNDERSCORE || code >= 128;
  const isPathLead = (code: number): boolean =>
    code === DOT || code === SLASH || code === BACKSLASH;
  const isSeparator = (code: number): boolean =>
    isSpaceCode(code) ||
    code === SEMI ||
    code === PIPE ||
    code === AMP ||
    code === LT ||
    code === GT ||
    code === RPAREN;
  const isSpecialParam = (code: number): boolean =>
    code === QUESTION ||
    code === BANG ||
    code === HASH ||
    code === 64 ||
    code === STAR ||
    code === DOLLAR ||
    code === DASH ||
    isDigit(code);

  function wordEnd(line: string, start: number, length: number): number {
    let index = start + 1;
    while (index < length) {
      const code = line.charCodeAt(index);
      if (isNameCode(code)) {
        index += 1;
        continue;
      }
      if (
        (code === DASH ||
          code === DOT ||
          code === SLASH ||
          code === BACKSLASH ||
          code === COLON) &&
        index + 1 < length &&
        isNameCode(line.charCodeAt(index + 1))
      ) {
        index += 1;
        continue;
      }
      break;
    }
    return index;
  }

  function isAssignmentName(line: string, start: number, end: number): boolean {
    if (end <= start) {
      return false;
    }
    for (let index = start; index < end; index += 1) {
      const code = line.charCodeAt(index);
      if (!isNameCode(code) || (isDigit(code) && index === start)) {
        return false;
      }
    }
    return true;
  }

  function followedByParameter(
    line: string,
    from: number,
    length: number,
  ): boolean {
    let index = from;
    while (index < length && isSpaceCode(line.charCodeAt(index))) {
      index += 1;
    }
    if (index >= length || line.charCodeAt(index) !== DASH) {
      return false;
    }
    index += 1;
    if (index < length && line.charCodeAt(index) === DASH) {
      index += 1;
    }
    return index < length && isLetter(line.charCodeAt(index));
  }

  function looksLikeCmdlet(word: string): boolean {
    const dash = word.indexOf('-');
    if (dash < 1 || dash + 1 >= word.length) {
      return false;
    }
    if (!isLetter(word.charCodeAt(0))) {
      return false;
    }
    return isLetter(word.charCodeAt(dash + 1));
  }

  function classifyPowerShellWord(
    line: string,
    start: number,
    end: number,
    atStart: boolean,
  ): ChatTokenName {
    const word = line.slice(start, end);
    if (PWSH_KEYWORDS.has(word.toLowerCase())) {
      return 'keyword';
    }
    if (
      atStart ||
      followedByParameter(line, end, line.length) ||
      looksLikeCmdlet(word)
    ) {
      return 'command';
    }
    return 'plain';
  }

  function classifyShellWord(
    line: string,
    start: number,
    end: number,
    atStart: boolean,
  ): {token: ChatTokenName; keepsStart: boolean} {
    const word = line.slice(start, end);
    if (atStart) {
      if (SHELL_KEYWORDS.has(word) && !SHELL_COMMAND_KEYWORDS.has(word)) {
        return {token: 'keyword', keepsStart: SHELL_CONTINUATION.has(word)};
      }
      return {token: 'command', keepsStart: false};
    }
    return {token: 'plain', keepsStart: false};
  }

  function scanLine(line: string, lang: ChatLanguage): ChatSpan[] {
    const length = line.length;
    const spans: ChatSpan[] = [];
    let atStart = true;
    let index = 0;

    while (index < length) {
      const code = line.charCodeAt(index);

      if (isSpaceCode(code)) {
        const start = index;
        while (index < length && isSpaceCode(line.charCodeAt(index))) {
          index += 1;
        }
        spans.push({text: line.slice(start, index), token: 'plain'});
        continue;
      }

      if (code === SQUOTE || code === DQUOTE) {
        const start = index;
        index += 1;
        while (index < length) {
          const inner = line.charCodeAt(index);
          if (
            inner === BACKSLASH ||
            (inner === BACKTICK && lang === 'powershell')
          ) {
            index += 2;
            continue;
          }
          index += 1;
          if (inner === code) {
            break;
          }
        }
        spans.push({text: line.slice(start, index), token: 'string'});
        atStart = false;
        continue;
      }

      if (
        code === HASH &&
        (lang === 'powershell' ||
          index === 0 ||
          isSpaceCode(line.charCodeAt(index - 1)))
      ) {
        spans.push({text: line.slice(index), token: 'comment'});
        break;
      }

      if (code === DOLLAR) {
        const start = index;
        index += 1;
        if (index < length && line.charCodeAt(index) === LBRACE) {
          index += 1;
          while (index < length && line.charCodeAt(index) !== RBRACE) {
            index += 1;
          }
          if (index < length) {
            index += 1;
          }
        } else {
          const nameStart = index;
          while (index < length && isNameCode(line.charCodeAt(index))) {
            index += 1;
          }
          if (
            index > nameStart &&
            index < length &&
            line.charCodeAt(index) === COLON
          ) {
            const after = index + 1;
            if (after < length && isNameCode(line.charCodeAt(after))) {
              index = after;
              while (index < length && isNameCode(line.charCodeAt(index))) {
                index += 1;
              }
            }
          }
          if (
            index === nameStart &&
            index < length &&
            isSpecialParam(line.charCodeAt(index))
          ) {
            index += 1;
          }
        }
        spans.push({
          text: line.slice(start, index),
          token: index > start + 1 ? 'variable' : 'plain',
        });
        atStart = false;
        continue;
      }

      if (
        isDigit(code) ||
        (code === DOT &&
          index + 1 < length &&
          isDigit(line.charCodeAt(index + 1)))
      ) {
        const start = index;
        if (code === ZERO && index + 2 < length) {
          const marker = line.charCodeAt(index + 1);
          if (
            (marker === LOWER_X || marker === UPPER_X) &&
            isHex(line.charCodeAt(index + 2))
          ) {
            index += 2;
            while (index < length && isHex(line.charCodeAt(index))) {
              index += 1;
            }
          }
        }
        if (index === start) {
          while (index < length && isDigit(line.charCodeAt(index))) {
            index += 1;
          }
          if (
            index + 1 < length &&
            line.charCodeAt(index) === DOT &&
            isDigit(line.charCodeAt(index + 1))
          ) {
            index += 1;
            while (index < length && isDigit(line.charCodeAt(index))) {
              index += 1;
            }
          }
        }
        spans.push({text: line.slice(start, index), token: 'number'});
        atStart = false;
        continue;
      }

      if (code === DASH) {
        let cursor = index + 1;
        if (cursor < length && line.charCodeAt(cursor) === DASH) {
          cursor += 1;
        }
        if (cursor < length && isLetter(line.charCodeAt(cursor))) {
          const start = index;
          index = cursor;
          while (index < length && isNameCode(line.charCodeAt(index))) {
            index += 1;
          }
          spans.push({text: line.slice(start, index), token: 'command'});
          atStart = false;
          continue;
        }
      }

      if (
        isWordLead(code) ||
        (isPathLead(code) &&
          index + 1 < length &&
          (isNameCode(line.charCodeAt(index + 1)) ||
            isPathLead(line.charCodeAt(index + 1))))
      ) {
        const start = index;
        const end = wordEnd(line, start, length);
        if (
          lang === 'shell' &&
          atStart &&
          end < length &&
          line.charCodeAt(end) === EQ &&
          isAssignmentName(line, start, end)
        ) {
          let cursor = end + 1;
          while (cursor < length && !isSeparator(line.charCodeAt(cursor))) {
            cursor += 1;
          }
          spans.push({text: line.slice(start, cursor), token: 'plain'});
          index = cursor;
          continue;
        }
        const decision: {token: ChatTokenName; keepsStart: boolean} =
          lang === 'powershell'
            ? {
                token: classifyPowerShellWord(line, start, end, atStart),
                keepsStart: false,
              }
            : classifyShellWord(line, start, end, atStart);
        spans.push({text: line.slice(start, end), token: decision.token});
        atStart = decision.keepsStart;
        index = end;
        continue;
      }

      if (OPERATORS.has(code)) {
        spans.push({text: line[index], token: 'operator'});
        index += 1;
        if (
          code === SEMI ||
          code === PIPE ||
          code === LBRACE ||
          code === RBRACE ||
          code === LPAREN
        ) {
          atStart = true;
        } else if (code === EQ && lang === 'powershell') {
          atStart = true;
        } else if (code !== EQ) {
          atStart = false;
        }
        continue;
      }

      if (code === AMP) {
        const start = index;
        while (index < length && line.charCodeAt(index) === AMP) {
          index += 1;
        }
        spans.push({text: line.slice(start, index), token: 'plain'});
        atStart = true;
        continue;
      }
      spans.push({text: line[index], token: 'plain'});
      index += 1;
      atStart = false;
    }

    if (spans.length === 0) {
      spans.push({text: '', token: 'plain'});
    }
    return merge(spans);
  }

  function scanJsonLine(line: string): ChatSpan[] {
    const spans: ChatSpan[] = [];
    let index = 0;
    while (index < line.length) {
      const code = line.charCodeAt(index);
      if (isSpaceCode(code)) {
        const start = index;
        while (index < line.length && isSpaceCode(line.charCodeAt(index))) {
          index += 1;
        }
        spans.push({text: line.slice(start, index), token: 'plain'});
        continue;
      }
      if (code === DQUOTE) {
        const start = index;
        index += 1;
        while (index < line.length) {
          const current = line.charCodeAt(index);
          if (current === BACKSLASH) {
            index += Math.min(2, line.length - index);
            continue;
          }
          index += 1;
          if (current === DQUOTE) {
            break;
          }
        }
        let next = index;
        while (next < line.length && isSpaceCode(line.charCodeAt(next))) {
          next += 1;
        }
        spans.push({
          text: line.slice(start, index),
          token: line.charCodeAt(next) === COLON ? 'command' : 'string',
        });
        continue;
      }
      if ((code >= ZERO && code <= NINE) || code === DASH || code === DOT) {
        const start = index;
        index += 1;
        while (index < line.length && /[0-9eE+.-]/u.test(line[index])) {
          index += 1;
        }
        spans.push({text: line.slice(start, index), token: 'number'});
        continue;
      }
      const wordStart = index;
      while (index < line.length && /[A-Za-z]/u.test(line[index])) {
        index += 1;
      }
      if (index > wordStart) {
        const word = line.slice(wordStart, index);
        spans.push({
          text: word,
          token:
            word === 'true' || word === 'false' || word === 'null'
              ? 'keyword'
              : 'plain',
        });
        continue;
      }
      spans.push({
        text: line[index],
        token: '{}[],:'.includes(line[index]) ? 'operator' : 'plain',
      });
      index += 1;
    }
    return spans.length ? merge(spans) : [{text: '', token: 'plain'}];
  }

  function merge(spans: ChatSpan[]): ChatSpan[] {
    const merged: ChatSpan[] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && last.token === span.token) {
        last.text += span.text;
      } else {
        merged.push({text: span.text, token: span.token});
      }
    }
    return merged;
  }

  function plainLines(lines: string[]): ChatSpan[][] {
    return lines.map(raw => {
      const line =
        raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      return [{text: line, token: 'plain' as ChatTokenName}];
    });
  }

  const PY_KEYWORDS = new Set([
    'False',
    'None',
    'True',
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'match',
    'case',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'try',
    'while',
    'with',
    'yield',
  ]);

  const PY_BUILTINS = new Set([
    'int',
    'str',
    'float',
    'bool',
    'list',
    'dict',
    'set',
    'tuple',
    'bytes',
    'object',
    'type',
    'self',
    'cls',
    'super',
    'print',
    'len',
    'range',
    'enumerate',
    'zip',
    'map',
    'filter',
    'sorted',
    'min',
    'max',
    'sum',
    'any',
    'all',
    'isinstance',
    'issubclass',
    'getattr',
    'setattr',
    'hasattr',
    'open',
    'Exception',
    'ValueError',
    'TypeError',
    'KeyError',
    'OSError',
    'RuntimeError',
    'Path',
  ]);

  const TS_KEYWORDS = new Set([
    'abstract',
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'from',
    'function',
    'get',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'is',
    'keyof',
    'let',
    'module',
    'namespace',
    'new',
    'null',
    'of',
    'override',
    'package',
    'private',
    'protected',
    'public',
    'readonly',
    'return',
    'satisfies',
    'set',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'var',
    'void',
    'while',
    'with',
    'yield',
  ]);

  const TS_TYPES = new Set([
    'string',
    'number',
    'boolean',
    'unknown',
    'any',
    'never',
    'object',
    'symbol',
    'bigint',
    'Promise',
    'Record',
    'Partial',
    'Required',
    'Readonly',
    'ReadonlyArray',
    'ReadonlySet',
    'ReadonlyMap',
    'Array',
    'Map',
    'Set',
    'Date',
    'Error',
    'RegExp',
    'HTMLElement',
    'Element',
    'Node',
    'Document',
    'Window',
  ]);

  const RUST_KEYWORDS = new Set([
    'as',
    'async',
    'await',
    'break',
    'const',
    'continue',
    'crate',
    'dyn',
    'else',
    'enum',
    'extern',
    'false',
    'fn',
    'for',
    'if',
    'impl',
    'in',
    'let',
    'loop',
    'match',
    'mod',
    'move',
    'mut',
    'pub',
    'ref',
    'return',
    'self',
    'Self',
    'static',
    'struct',
    'super',
    'trait',
    'true',
    'type',
    'unsafe',
    'use',
    'where',
    'while',
  ]);

  const GO_KEYWORDS = new Set([
    'break',
    'case',
    'chan',
    'const',
    'continue',
    'default',
    'defer',
    'else',
    'fallthrough',
    'false',
    'for',
    'func',
    'go',
    'goto',
    'if',
    'import',
    'interface',
    'iota',
    'map',
    'nil',
    'package',
    'range',
    'return',
    'select',
    'struct',
    'switch',
    'true',
    'type',
    'var',
  ]);

  const C_JAVA_KEYWORDS = new Set([
    'abstract',
    'auto',
    'bool',
    'boolean',
    'break',
    'byte',
    'case',
    'catch',
    'char',
    'class',
    'const',
    'constexpr',
    'continue',
    'default',
    'delete',
    'do',
    'double',
    'else',
    'enum',
    'explicit',
    'extends',
    'extern',
    'false',
    'final',
    'finally',
    'float',
    'for',
    'friend',
    'goto',
    'if',
    'implements',
    'import',
    'inline',
    'int',
    'interface',
    'long',
    'namespace',
    'new',
    'noexcept',
    'null',
    'nullptr',
    'operator',
    'override',
    'package',
    'private',
    'protected',
    'public',
    'record',
    'return',
    'short',
    'signed',
    'sizeof',
    'static',
    'struct',
    'super',
    'switch',
    'template',
    'this',
    'throw',
    'throws',
    'true',
    'try',
    'typedef',
    'typename',
    'union',
    'unsigned',
    'using',
    'virtual',
    'void',
    'volatile',
    'while',
  ]);

  const SQL_KEYWORDS = new Set([
    'select',
    'from',
    'where',
    'join',
    'inner',
    'left',
    'right',
    'outer',
    'full',
    'on',
    'as',
    'and',
    'or',
    'not',
    'in',
    'is',
    'null',
    'true',
    'false',
    'like',
    'ilike',
    'between',
    'order',
    'by',
    'group',
    'having',
    'limit',
    'offset',
    'insert',
    'into',
    'values',
    'update',
    'set',
    'delete',
    'create',
    'alter',
    'drop',
    'table',
    'index',
    'view',
    'with',
    'union',
    'all',
    'distinct',
    'case',
    'when',
    'then',
    'else',
    'end',
    'count',
    'sum',
    'avg',
    'min',
    'max',
    'primary',
    'key',
    'foreign',
    'references',
    'default',
    'exists',
  ]);

  function isIdentStart(code: number): boolean {
    return isLetter(code) || code === UNDERSCORE || code === DOLLAR || code >= 128;
  }

  function isIdentPart(code: number): boolean {
    return isIdentStart(code) || isDigit(code);
  }

  function isPascalCase(word: string): boolean {
    return (
      word.length >= 2 &&
      word.charCodeAt(0) >= 65 &&
      word.charCodeAt(0) <= 90 &&
      /[a-z]/.test(word)
    );
  }

  function nextNonSpaceChar(line: string, from: number): number {
    let i = from;
    while (i < line.length && isSpaceCode(line.charCodeAt(i))) {
      i += 1;
    }
    return i < line.length ? line.charCodeAt(i) : -1;
  }

  function scanNumber(line: string, start: number): number {
    let i = start;
    const len = line.length;
    if (
      line.charCodeAt(i) === ZERO &&
      i + 1 < len &&
      (line.charCodeAt(i + 1) === LOWER_X ||
        line.charCodeAt(i + 1) === UPPER_X ||
        line[i + 1] === 'b' ||
        line[i + 1] === 'B' ||
        line[i + 1] === 'o' ||
        line[i + 1] === 'O')
    ) {
      i += 2;
      while (i < len && (isHex(line.charCodeAt(i)) || line.charCodeAt(i) === UNDERSCORE)) {
        i += 1;
      }
      return i;
    }
    while (i < len && (isDigit(line.charCodeAt(i)) || line.charCodeAt(i) === UNDERSCORE)) {
      i += 1;
    }
    if (i < len && line.charCodeAt(i) === DOT && i + 1 < len && isDigit(line.charCodeAt(i + 1))) {
      i += 1;
      while (i < len && (isDigit(line.charCodeAt(i)) || line.charCodeAt(i) === UNDERSCORE)) {
        i += 1;
      }
    }
    if (i < len && (line[i] === 'e' || line[i] === 'E')) {
      let j = i + 1;
      if (j < len && (line[j] === '+' || line[j] === '-')) {
        j += 1;
      }
      if (j < len && isDigit(line.charCodeAt(j))) {
        i = j + 1;
        while (i < len && isDigit(line.charCodeAt(i))) {
          i += 1;
        }
      }
    }
    while (i < len && isLetter(line.charCodeAt(i))) {
      i += 1;
    }
    return i;
  }

  function highlightPython(lines: string[]): ChatSpan[][] {
    let tripleQuote: string | null = null;
    return lines.map(raw => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      const spans: ChatSpan[] = [];
      const len = line.length;
      let i = 0;
      let expectDecl: 'def' | 'class' | null = null;
      let afterDot = false;

      if (tripleQuote !== null) {
        const closeIdx = line.indexOf(tripleQuote);
        if (closeIdx === -1) {
          return [{text: line, token: 'string'}];
        }
        spans.push({text: line.slice(0, closeIdx + 3), token: 'string'});
        i = closeIdx + 3;
        tripleQuote = null;
      }

      while (i < len) {
        const ch = line.charCodeAt(i);
        if (isSpaceCode(ch)) {
          const start = i;
          while (i < len && isSpaceCode(line.charCodeAt(i))) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'plain'});
          continue;
        }
        if (ch === HASH) {
          spans.push({text: line.slice(i), token: 'comment'});
          break;
        }
        // Decorator @foo.bar
        if (ch === 64 && spans.every(s => s.token === 'plain' && !s.text.trim())) {
          const start = i;
          i += 1;
          while (i < len && (isIdentPart(line.charCodeAt(i)) || line.charCodeAt(i) === DOT)) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'decorator'});
          continue;
        }
        // String prefixes r/f/b/u + quotes
        const strStart = i;
        let quoteIdx = i;
        if (isLetter(ch)) {
          let p = i;
          while (p < len && p - i < 2 && 'rfbuRFBU'.includes(line[p])) {
            p += 1;
          }
          if (p > i && p < len && (line.charCodeAt(p) === SQUOTE || line.charCodeAt(p) === DQUOTE)) {
            quoteIdx = p;
          }
        }
        if (line.charCodeAt(quoteIdx) === SQUOTE || line.charCodeAt(quoteIdx) === DQUOTE) {
          const qChar = line[quoteIdx];
          const triple = qChar + qChar + qChar;
          if (line.startsWith(triple, quoteIdx)) {
            const closeIdx = line.indexOf(triple, quoteIdx + 3);
            if (closeIdx === -1) {
              tripleQuote = triple;
              spans.push({text: line.slice(strStart), token: 'string'});
              break;
            }
            spans.push({text: line.slice(strStart, closeIdx + 3), token: 'string'});
            i = closeIdx + 3;
            afterDot = false;
            continue;
          }
          let j = quoteIdx + 1;
          while (j < len) {
            if (line.charCodeAt(j) === BACKSLASH) {
              j += 2;
              continue;
            }
            if (line[j] === qChar) {
              j += 1;
              break;
            }
            j += 1;
          }
          spans.push({text: line.slice(strStart, j), token: 'string'});
          i = j;
          afterDot = false;
          continue;
        }
        if (isDigit(ch)) {
          const end = scanNumber(line, i);
          spans.push({text: line.slice(i, end), token: 'number'});
          i = end;
          afterDot = false;
          continue;
        }
        if (isIdentStart(ch)) {
          const start = i;
          i += 1;
          while (i < len && isIdentPart(line.charCodeAt(i))) {
            i += 1;
          }
          const word = line.slice(start, i);
          let token: ChatTokenName = 'plain';
          if (expectDecl === 'def') {
            token = 'function';
            expectDecl = null;
          } else if (expectDecl === 'class') {
            token = 'type';
            expectDecl = null;
          } else if (PY_KEYWORDS.has(word)) {
            token = 'keyword';
            if (word === 'def') {
              expectDecl = 'def';
            } else if (word === 'class') {
              expectDecl = 'class';
            }
          } else if (afterDot) {
            token = nextNonSpaceChar(line, i) === LPAREN ? 'function' : 'property';
          } else if (nextNonSpaceChar(line, i) === LPAREN) {
            token = isPascalCase(word) ? 'type' : 'function';
          } else if (PY_BUILTINS.has(word) || isPascalCase(word)) {
            token = word === 'self' || word === 'cls' ? 'variable' : 'type';
          } else if (/^[A-Z][A-Z0-9_]{1,}$/.test(word)) {
            token = 'number';
          }
          spans.push({text: word, token});
          afterDot = false;
          continue;
        }
        if (ch === DOT) {
          spans.push({text: '.', token: 'operator'});
          afterDot = true;
          i += 1;
          continue;
        }
        if (OPERATORS.has(ch) || ch === 37 || ch === 94 || ch === 126 || ch === 64) {
          spans.push({text: line[i], token: 'operator'});
          afterDot = false;
          i += 1;
          continue;
        }
        spans.push({text: line[i], token: 'plain'});
        afterDot = false;
        i += 1;
      }
      return spans.length ? merge(spans) : [{text: '', token: 'plain'}];
    });
  }

  function highlightCLike(
    lines: string[],
    lang: 'typescript' | 'javascript' | 'rust' | 'go' | 'c' | 'java',
  ): ChatSpan[][] {
    const keywords =
      lang === 'rust'
        ? RUST_KEYWORDS
        : lang === 'go'
          ? GO_KEYWORDS
          : lang === 'c' || lang === 'java'
            ? C_JAVA_KEYWORDS
            : TS_KEYWORDS;
    let inBlockComment = false;
    return lines.map(raw => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      const spans: ChatSpan[] = [];
      const len = line.length;
      let i = 0;
      let afterDot = false;
      let expectDecl: 'fn' | 'type' | null = null;

      if (inBlockComment) {
        const end = line.indexOf('*/');
        if (end === -1) {
          return [{text: line, token: 'comment'}];
        }
        spans.push({text: line.slice(0, end + 2), token: 'comment'});
        i = end + 2;
        inBlockComment = false;
      }

      while (i < len) {
        const ch = line.charCodeAt(i);
        if (isSpaceCode(ch)) {
          const start = i;
          while (i < len && isSpaceCode(line.charCodeAt(i))) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'plain'});
          continue;
        }
        if (ch === SLASH && i + 1 < len && line.charCodeAt(i + 1) === SLASH) {
          spans.push({text: line.slice(i), token: 'comment'});
          break;
        }
        if (ch === SLASH && i + 1 < len && line.charCodeAt(i + 1) === STAR) {
          const end = line.indexOf('*/', i + 2);
          if (end === -1) {
            inBlockComment = true;
            spans.push({text: line.slice(i), token: 'comment'});
            break;
          }
          spans.push({text: line.slice(i, end + 2), token: 'comment'});
          i = end + 2;
          continue;
        }
        // Preprocessor / decorator / Rust attribute
        if (
          (ch === 64 && (lang === 'typescript' || lang === 'javascript' || lang === 'java')) ||
          (ch === HASH && (lang === 'c' || lang === 'rust'))
        ) {
          const start = i;
          i += 1;
          if (ch === HASH && lang === 'rust' && i < len && line.charCodeAt(i) === LBRACKET) {
            const close = line.indexOf(']', i);
            i = close === -1 ? len : close + 1;
          } else {
            while (i < len && isIdentPart(line.charCodeAt(i))) {
              i += 1;
            }
          }
          spans.push({text: line.slice(start, i), token: 'decorator'});
          continue;
        }
        if (ch === DQUOTE || ch === SQUOTE || ch === BACKTICK) {
          // Rust lifetime 'a should not be treated as unterminated string
          if (lang === 'rust' && ch === SQUOTE && i + 1 < len && isLetter(line.charCodeAt(i + 1)) && (i + 2 >= len || line.charCodeAt(i + 2) !== SQUOTE)) {
            const start = i;
            i += 1;
            while (i < len && isIdentPart(line.charCodeAt(i))) {
              i += 1;
            }
            spans.push({text: line.slice(start, i), token: 'decorator'});
            continue;
          }
          const quote = ch;
          const start = i;
          i += 1;
          while (i < len) {
            if (line.charCodeAt(i) === BACKSLASH) {
              i += 2;
              continue;
            }
            if (line.charCodeAt(i) === quote) {
              i += 1;
              break;
            }
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'string'});
          afterDot = false;
          continue;
        }
        if (isDigit(ch)) {
          const end = scanNumber(line, i);
          spans.push({text: line.slice(i, end), token: 'number'});
          i = end;
          afterDot = false;
          continue;
        }
        if (isIdentStart(ch)) {
          const start = i;
          i += 1;
          while (i < len && isIdentPart(line.charCodeAt(i))) {
            i += 1;
          }
          const word = line.slice(start, i);
          let token: ChatTokenName = 'plain';
          if (expectDecl === 'fn') {
            token = 'function';
            expectDecl = null;
          } else if (expectDecl === 'type') {
            token = 'type';
            expectDecl = null;
          } else if (keywords.has(word)) {
            token = 'keyword';
            if (word === 'function' || word === 'fn' || word === 'func') {
              expectDecl = 'fn';
            } else if (
              word === 'class' ||
              word === 'interface' ||
              word === 'type' ||
              word === 'enum' ||
              word === 'struct' ||
              word === 'trait'
            ) {
              expectDecl = 'type';
            }
          } else if (afterDot) {
            token = nextNonSpaceChar(line, i) === LPAREN ? 'function' : 'property';
          } else if (nextNonSpaceChar(line, i) === LPAREN) {
            token = isPascalCase(word) ? 'type' : 'function';
          } else if (
            ((lang === 'typescript' || lang === 'javascript') && TS_TYPES.has(word)) ||
            isPascalCase(word)
          ) {
            token = 'type';
          } else if (nextNonSpaceChar(line, i) === COLON && !afterDot) {
            token = 'property';
          }
          spans.push({text: word, token});
          afterDot = false;
          continue;
        }
        if (ch === DOT) {
          spans.push({text: '.', token: 'operator'});
          afterDot = true;
          i += 1;
          continue;
        }
        if (OPERATORS.has(ch) || ch === AMP || ch === 37 || ch === 94 || ch === 126) {
          spans.push({text: line[i], token: 'operator'});
          afterDot = false;
          i += 1;
          continue;
        }
        spans.push({text: line[i], token: 'plain'});
        afterDot = false;
        i += 1;
      }
      return spans.length ? merge(spans) : [{text: '', token: 'plain'}];
    });
  }

  function highlightCss(lines: string[]): ChatSpan[][] {
    let inComment = false;
    return lines.map(raw => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      const spans: ChatSpan[] = [];
      const len = line.length;
      let i = 0;
      if (inComment) {
        const end = line.indexOf('*/');
        if (end === -1) {
          return [{text: line, token: 'comment'}];
        }
        spans.push({text: line.slice(0, end + 2), token: 'comment'});
        i = end + 2;
        inComment = false;
      }
      while (i < len) {
        const ch = line.charCodeAt(i);
        if (isSpaceCode(ch)) {
          const start = i;
          while (i < len && isSpaceCode(line.charCodeAt(i))) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'plain'});
          continue;
        }
        if (ch === SLASH && i + 1 < len && line.charCodeAt(i + 1) === STAR) {
          const end = line.indexOf('*/', i + 2);
          if (end === -1) {
            inComment = true;
            spans.push({text: line.slice(i), token: 'comment'});
            break;
          }
          spans.push({text: line.slice(i, end + 2), token: 'comment'});
          i = end + 2;
          continue;
        }
        if (ch === DQUOTE || ch === SQUOTE) {
          const start = i;
          i += 1;
          while (i < len && line.charCodeAt(i) !== ch) {
            if (line.charCodeAt(i) === BACKSLASH) {
              i += 2;
              continue;
            }
            i += 1;
          }
          if (i < len) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'string'});
          continue;
        }
        if (ch === 64) {
          const start = i;
          i += 1;
          while (i < len && (isLetter(line.charCodeAt(i)) || line.charCodeAt(i) === DASH)) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'keyword'});
          continue;
        }
        if (ch === DASH && i + 1 < len && line.charCodeAt(i + 1) === DASH) {
          const start = i;
          i += 2;
          while (i < len && (isNameCode(line.charCodeAt(i)) || line.charCodeAt(i) === DASH)) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'variable'});
          continue;
        }
        if (ch === HASH) {
          const start = i;
          i += 1;
          while (i < len && (isNameCode(line.charCodeAt(i)) || line.charCodeAt(i) === DASH)) {
            i += 1;
          }
          const slice = line.slice(start, i);
          spans.push({
            text: slice,
            token: /^#[0-9a-fA-F]{3,8}$/.test(slice) ? 'number' : 'type',
          });
          continue;
        }
        if (isDigit(ch)) {
          const end = scanNumber(line, i);
          let u = end;
          if (u < len && line[u] === '%') {
            u += 1;
          }
          spans.push({text: line.slice(i, u), token: 'number'});
          i = u;
          continue;
        }
        if (isLetter(ch) || ch === DOT) {
          const start = i;
          i += 1;
          while (i < len && (isNameCode(line.charCodeAt(i)) || line.charCodeAt(i) === DASH)) {
            i += 1;
          }
          const word = line.slice(start, i);
          let token: ChatTokenName = 'plain';
          if (word.startsWith('.')) {
            token = 'type';
          } else if (nextNonSpaceChar(line, i) === COLON) {
            token = 'property';
          } else if (nextNonSpaceChar(line, i) === LPAREN) {
            token = 'function';
          }
          spans.push({text: word, token});
          continue;
        }
        spans.push({text: line[i], token: OPERATORS.has(ch) ? 'operator' : 'plain'});
        i += 1;
      }
      return spans.length ? merge(spans) : [{text: '', token: 'plain'}];
    });
  }

  function highlightHtml(lines: string[]): ChatSpan[][] {
    let inComment = false;
    return lines.map(raw => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      const spans: ChatSpan[] = [];
      const len = line.length;
      let i = 0;
      if (inComment) {
        const end = line.indexOf('-->');
        if (end === -1) {
          return [{text: line, token: 'comment'}];
        }
        spans.push({text: line.slice(0, end + 3), token: 'comment'});
        i = end + 3;
        inComment = false;
      }
      while (i < len) {
        if (line.startsWith('<!--', i)) {
          const end = line.indexOf('-->', i + 4);
          if (end === -1) {
            inComment = true;
            spans.push({text: line.slice(i), token: 'comment'});
            break;
          }
          spans.push({text: line.slice(i, end + 3), token: 'comment'});
          i = end + 3;
          continue;
        }
        if (line.charCodeAt(i) === LT) {
          const closeTag = line.indexOf('>', i);
          const end = closeTag === -1 ? len : closeTag + 1;
          let j = i;
          spans.push({text: '<', token: 'operator'});
          j += 1;
          if (j < end && (line[j] === '/' || line[j] === '!')) {
            spans.push({text: line[j], token: 'operator'});
            j += 1;
          }
          const tagStart = j;
          while (j < end && /[A-Za-z0-9:_-]/.test(line[j])) {
            j += 1;
          }
          if (j > tagStart) {
            spans.push({text: line.slice(tagStart, j), token: 'keyword'});
          }
          while (j < end) {
            const c = line.charCodeAt(j);
            if (isSpaceCode(c)) {
              const s = j;
              while (j < end && isSpaceCode(line.charCodeAt(j))) {
                j += 1;
              }
              spans.push({text: line.slice(s, j), token: 'plain'});
              continue;
            }
            if (c === DQUOTE || c === SQUOTE) {
              const s = j;
              j += 1;
              while (j < end && line.charCodeAt(j) !== c) {
                j += 1;
              }
              if (j < end) {
                j += 1;
              }
              spans.push({text: line.slice(s, j), token: 'string'});
              continue;
            }
            if (c === GT || c === SLASH || c === EQ) {
              spans.push({text: line[j], token: 'operator'});
              j += 1;
              continue;
            }
            const aStart = j;
            while (j < end && /[A-Za-z0-9:_-]/.test(line[j])) {
              j += 1;
            }
            if (j > aStart) {
              spans.push({text: line.slice(aStart, j), token: 'property'});
            } else {
              spans.push({text: line[j], token: 'plain'});
              j += 1;
            }
          }
          i = end;
          continue;
        }
        const nextTag = line.indexOf('<', i);
        const end = nextTag === -1 ? len : nextTag;
        spans.push({text: line.slice(i, end), token: 'plain'});
        i = end;
      }
      return spans.length ? merge(spans) : [{text: '', token: 'plain'}];
    });
  }

  function highlightSql(lines: string[]): ChatSpan[][] {
    return lines.map(raw => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      const spans: ChatSpan[] = [];
      const len = line.length;
      let i = 0;
      while (i < len) {
        const ch = line.charCodeAt(i);
        if (ch === DASH && i + 1 < len && line.charCodeAt(i + 1) === DASH) {
          spans.push({text: line.slice(i), token: 'comment'});
          break;
        }
        if (ch === SQUOTE || ch === DQUOTE) {
          const start = i;
          i += 1;
          while (i < len && line.charCodeAt(i) !== ch) {
            i += 1;
          }
          if (i < len) {
            i += 1;
          }
          spans.push({text: line.slice(start, i), token: 'string'});
          continue;
        }
        if (isDigit(ch)) {
          const end = scanNumber(line, i);
          spans.push({text: line.slice(i, end), token: 'number'});
          i = end;
          continue;
        }
        if (isIdentStart(ch)) {
          const start = i;
          i += 1;
          while (i < len && isIdentPart(line.charCodeAt(i))) {
            i += 1;
          }
          const word = line.slice(start, i);
          spans.push({
            text: word,
            token: SQL_KEYWORDS.has(word.toLowerCase()) ? 'keyword' : 'plain',
          });
          continue;
        }
        spans.push({text: line[i], token: OPERATORS.has(ch) ? 'operator' : 'plain'});
        i += 1;
      }
      return spans.length ? merge(spans) : [{text: '', token: 'plain'}];
    });
  }

  function highlightYaml(lines: string[]): ChatSpan[][] {
    return lines.map(raw => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#')) {
        return [{text: line, token: 'comment'}];
      }
      const match = /^(\s*(?:-\s+)?)([\w./-]+)(\s*:\s*)(.*)$/.exec(line);
      if (match) {
        const spans: ChatSpan[] = [];
        if (match[1]) {
          spans.push({text: match[1], token: 'operator'});
        }
        spans.push({text: match[2], token: 'property'});
        spans.push({text: match[3], token: 'operator'});
        const rest = match[4];
        if (rest) {
          const valTrim = rest.trim();
          if (valTrim.startsWith('#')) {
            spans.push({text: rest, token: 'comment'});
          } else if (valTrim === 'true' || valTrim === 'false' || valTrim === 'null') {
            spans.push({text: rest, token: 'keyword'});
          } else if (/^-?\d+(?:\.\d+)?$/.test(valTrim)) {
            spans.push({text: rest, token: 'number'});
          } else {
            spans.push({text: rest, token: 'string'});
          }
        }
        return merge(spans);
      }
      return [{text: line, token: 'plain'}];
    });
  }

  function highlightMarkdown(lines: string[]): ChatSpan[][] {
    let inFence = false;
    return lines.map(raw => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return [{text: line, token: 'decorator'}];
      }
      if (inFence) {
        return [{text: line, token: 'string'}];
      }
      if (/^\s*#{1,6}\s/.test(line)) {
        return [{text: line, token: 'keyword'}];
      }
      if (/^\s*>\s?/.test(line)) {
        return [{text: line, token: 'comment'}];
      }
      return [{text: line, token: 'plain'}];
    });
  }

  const LANGUAGE_ALIASES: Record<string, ChatLanguage> = {
    powershell: 'powershell',
    pwsh: 'powershell',
    ps1: 'powershell',
    psm1: 'powershell',
    shell: 'shell',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    json: 'json',
    jsonl: 'json',
    jsonc: 'json',
    py: 'python',
    python: 'python',
    pyw: 'python',
    pyi: 'python',
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    typescript: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    javascript: 'javascript',
    css: 'css',
    scss: 'css',
    less: 'css',
    html: 'html',
    htm: 'html',
    xml: 'html',
    svg: 'html',
    rs: 'rust',
    rust: 'rust',
    go: 'go',
    golang: 'go',
    c: 'c',
    h: 'c',
    cpp: 'c',
    cc: 'c',
    cxx: 'c',
    hpp: 'c',
    cs: 'java',
    csharp: 'java',
    java: 'java',
    kt: 'java',
    kotlin: 'java',
    swift: 'java',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'yaml',
    ini: 'yaml',
    cfg: 'yaml',
    env: 'yaml',
    md: 'markdown',
    mdx: 'markdown',
    markdown: 'markdown',
  };

  const LANGUAGE_META: Record<ChatLanguage, {label: string; accent: string}> = {
    python: {label: 'Python', accent: '#3572A5'},
    typescript: {label: 'TypeScript', accent: '#3178C6'},
    javascript: {label: 'JavaScript', accent: '#D4A72C'},
    json: {label: 'JSON', accent: '#1E9E3C'},
    css: {label: 'CSS', accent: '#7C3AED'},
    html: {label: 'HTML', accent: '#D97757'},
    rust: {label: 'Rust', accent: '#C85A32'},
    go: {label: 'Go', accent: '#00ADD8'},
    c: {label: 'C / C++', accent: '#64748B'},
    java: {label: 'Java', accent: '#B07219'},
    sql: {label: 'SQL', accent: '#0F766E'},
    yaml: {label: 'YAML', accent: '#C05621'},
    markdown: {label: 'Markdown', accent: '#6B7280'},
    powershell: {label: 'PowerShell', accent: '#2566D0'},
    shell: {label: 'Shell', accent: '#2E7D4F'},
    plain: {label: 'Plain text', accent: '#8E8D88'},
  };

  function languageOf(lang: string): ChatLanguage {
    const name = typeof lang === 'string' ? lang.trim().toLowerCase() : '';
    return LANGUAGE_ALIASES[name] || 'plain';
  }

  function langForPath(filePath: string): ChatLanguageMeta {
    const clean = String(filePath || '')
      .trim()
      .split(/[\\/]/)
      .pop() || '';
    const dot = clean.lastIndexOf('.');
    const ext = dot >= 0 ? clean.slice(dot + 1).toLowerCase() : clean.toLowerCase();
    const lang = LANGUAGE_ALIASES[ext] || 'plain';
    const meta = LANGUAGE_META[lang];
    return {lang, label: meta.label, accent: meta.accent};
  }

  function highlight(code: string, lang: string): ChatSpan[][] {
    const source = typeof code === 'string' ? code : String(code ?? '');
    const lines = source.split('\n');
    const language = languageOf(lang);
    if (language === 'plain') {
      return plainLines(lines);
    }
    try {
      switch (language) {
        case 'json':
          return lines.map(raw => {
            const line =
              raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
            return scanJsonLine(line);
          });
        case 'powershell':
        case 'shell':
          return lines.map(raw => {
            const line =
              raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
            return scanLine(line, language);
          });
        case 'python':
          return highlightPython(lines);
        case 'typescript':
        case 'javascript':
        case 'rust':
        case 'go':
        case 'c':
        case 'java':
          return highlightCLike(lines, language);
        case 'css':
          return highlightCss(lines);
        case 'html':
          return highlightHtml(lines);
        case 'sql':
          return highlightSql(lines);
        case 'yaml':
          return highlightYaml(lines);
        case 'markdown':
          return highlightMarkdown(lines);
        default:
          return plainLines(lines);
      }
    } catch {
      return plainLines(lines);
    }
  }

  function langFor(toolName: string, command: string): ChatLanguage {
    const tool =
      typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
    const text = typeof command === 'string' ? command : '';
    if (tool === 'pwsh' || tool === 'powershell') {
      return 'powershell';
    }
    for (const marker of PWSH_MARKERS) {
      if (text.includes(marker)) {
        return 'powershell';
      }
    }
    if (/\$env:/i.test(text)) {
      return 'powershell';
    }
    if (tool === 'bash' || tool === 'sh' || tool === 'shell') {
      return 'shell';
    }
    return 'plain';
  }

  return {highlight, langFor, langForPath, languageOf};
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatHighlight;
}
if (typeof globalThis !== 'undefined') {
  (
    globalThis as typeof globalThis & {ChatHighlight?: typeof ChatHighlight}
  ).ChatHighlight = ChatHighlight;
}
