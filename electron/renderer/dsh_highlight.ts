/* exported DshHighlight */

/**
 * Command tokenizer for the command shown inside an expanded Studio tool card.
 *
 * The reference surface colourises that command; this module is only the
 * tokenizer.  There is no DOM, no CSS and no rendering here — a caller maps
 * `token` to a class name.
 *
 * Invariant: concatenating the `text` of every span of a line reproduces that
 * line character for character.  tests/dsh_highlight_test.js asserts it on
 * every case it exercises.
 *
 * Scope: a reading aid, not a compiler.  Deliberately not implemented —
 * heredocs and here-strings, `&&`/`;` chaining beyond "a statement starts
 * here", PowerShell comparison operators (`-eq`, `-gt`) as `operator` (the
 * spec routes a bare `-Flag` to `command`), and anything that would need a
 * real grammar.  The scanner is single pass and never backtracks, so a long
 * line stays linear.
 */

type DshTokenName =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'command'
  | 'variable'
  | 'comment'
  | 'operator';

interface DshSpan {
  text: string;
  token: DshTokenName;
}

type DshLanguage = 'powershell' | 'shell' | 'plain';

const DshHighlight = (() => {
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

  // PowerShell statement-leading keywords.
  const PWSH_KEYWORDS = new Set([
    'function', 'filter', 'param', 'begin', 'process', 'end', 'if', 'elseif', 'else',
    'try', 'catch', 'finally', 'throw', 'return', 'foreach', 'for', 'while', 'do',
    'until', 'switch', 'break', 'continue', 'trap', 'class', 'enum',
  ]);

  // Shell keywords.  `export` and `local` are also commands: in command
  // position they are classified by that role (see SHELL_COMMAND_KEYWORDS),
  // which is what "decide by role, not by the word alone" asks for.
  const SHELL_KEYWORDS = new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac',
    'function', 'return', 'export', 'local',
  ]);
  const SHELL_COMMAND_KEYWORDS = new Set(['export', 'local']);
  // A word that continues a compound command leaves the next word in command
  // position (`... ; then echo ok`), a word that opens one does not.
  const SHELL_CONTINUATION = new Set(['then', 'do', 'else']);

  const OPERATORS = new Set([
    EQ, PLUS, DASH, STAR, SLASH, PIPE, GT, LT, BANG, QUESTION, COLON, COMMA, SEMI,
    LPAREN, RPAREN, LBRACE, RBRACE, LBRACKET, RBRACKET,
  ]);

  const PWSH_MARKERS = ['Invoke-WebRequest', 'Write-Host', 'Get-', 'Set-', '-ErrorAction'];

  const isSpaceCode = (code: number): boolean => code === SPACE || code === TAB || code === CR;
  const isDigit = (code: number): boolean => code >= ZERO && code <= NINE;
  const isLetter = (code: number): boolean =>
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  // Non-ASCII is a word character so Chinese comments and paths stay in one
  // span instead of being chopped per code unit.
  const isNameCode = (code: number): boolean =>
    isLetter(code) || isDigit(code) || code === UNDERSCORE || code >= 128;
  const isHex = (code: number): boolean =>
    isDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
  const isWordLead = (code: number): boolean =>
    isLetter(code) || code === UNDERSCORE || code >= 128;
  const isPathLead = (code: number): boolean =>
    code === DOT || code === SLASH || code === BACKSLASH;
  const isSeparator = (code: number): boolean =>
    isSpaceCode(code) || code === SEMI || code === PIPE || code === AMP ||
    code === LT || code === GT || code === RPAREN;
  const isSpecialParam = (code: number): boolean =>
    code === QUESTION || code === BANG || code === HASH || code === 64 ||
    code === STAR || code === DOLLAR || code === DASH || isDigit(code);

  /** End of the word that starts at `start`; never returns less than start + 1. */
  function wordEnd(line: string, start: number, length: number): number {
    let index = start + 1;
    while (index < length) {
      const code = line.charCodeAt(index);
      if (isNameCode(code)) {
        index += 1;
        continue;
      }
      // `-`, `.`, `/`, `\` and `:` join a word only when a name character
      // follows, so `Get-ChildItem`, `./run.sh`, `C:\tmp` stay whole while
      // `40 - 3` keeps its operator.
      if (
        (code === DASH || code === DOT || code === SLASH || code === BACKSLASH || code === COLON) &&
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
    if (end <= start) return false;
    for (let index = start; index < end; index += 1) {
      const code = line.charCodeAt(index);
      if (!isNameCode(code) || (isDigit(code) && index === start)) return false;
    }
    return true;
  }

  /** True when only whitespace separates `from` from a `-Flag` parameter. */
  function followedByParameter(line: string, from: number, length: number): boolean {
    let index = from;
    while (index < length && isSpaceCode(line.charCodeAt(index))) index += 1;
    if (index >= length || line.charCodeAt(index) !== DASH) return false;
    index += 1;
    if (index < length && line.charCodeAt(index) === DASH) index += 1;
    return index < length && isLetter(line.charCodeAt(index));
  }

  /** `Verb-Noun` cmdlet shape, which stays a command even mid-expression. */
  function looksLikeCmdlet(word: string): boolean {
    const dash = word.indexOf('-');
    if (dash < 1 || dash + 1 >= word.length) return false;
    if (!isLetter(word.charCodeAt(0))) return false;
    return isLetter(word.charCodeAt(dash + 1));
  }

  function classifyPowerShellWord(
    line: string,
    start: number,
    end: number,
    atStart: boolean,
  ): DshTokenName {
    const word = line.slice(start, end);
    if (PWSH_KEYWORDS.has(word.toLowerCase())) return 'keyword';
    if (atStart || followedByParameter(line, end, line.length) || looksLikeCmdlet(word)) {
      return 'command';
    }
    return 'plain';
  }

  function classifyShellWord(
    line: string,
    start: number,
    end: number,
    atStart: boolean,
  ): { token: DshTokenName; keepsStart: boolean } {
    const word = line.slice(start, end);
    if (atStart) {
      if (SHELL_KEYWORDS.has(word) && !SHELL_COMMAND_KEYWORDS.has(word)) {
        return { token: 'keyword', keepsStart: SHELL_CONTINUATION.has(word) };
      }
      return { token: 'command', keepsStart: false };
    }
    return { token: 'plain', keepsStart: false };
  }

  function scanLine(line: string, lang: DshLanguage): DshSpan[] {
    const length = line.length;
    const spans: DshSpan[] = [];
    let atStart = true;
    let index = 0;

    while (index < length) {
      const code = line.charCodeAt(index);

      if (isSpaceCode(code)) {
        const start = index;
        while (index < length && isSpaceCode(line.charCodeAt(index))) index += 1;
        spans.push({ text: line.slice(start, index), token: 'plain' });
        continue;
      }

      if (code === SQUOTE || code === DQUOTE) {
        const start = index;
        index += 1;
        while (index < length) {
          const inner = line.charCodeAt(index);
          if (inner === BACKSLASH || (inner === BACKTICK && lang === 'powershell')) {
            index += 2;
            continue;
          }
          index += 1;
          if (inner === code) break;
        }
        spans.push({ text: line.slice(start, index), token: 'string' });
        atStart = false;
        continue;
      }

      if (code === HASH && (lang === 'powershell' || index === 0 || isSpaceCode(line.charCodeAt(index - 1)))) {
        spans.push({ text: line.slice(index), token: 'comment' });
        break;
      }

      if (code === DOLLAR) {
        const start = index;
        index += 1;
        if (index < length && line.charCodeAt(index) === LBRACE) {
          index += 1;
          while (index < length && line.charCodeAt(index) !== RBRACE) index += 1;
          if (index < length) index += 1;
        } else {
          const nameStart = index;
          while (index < length && isNameCode(line.charCodeAt(index))) index += 1;
          if (index > nameStart && index < length && line.charCodeAt(index) === COLON) {
            const after = index + 1;
            if (after < length && isNameCode(line.charCodeAt(after))) {
              index = after;
              while (index < length && isNameCode(line.charCodeAt(index))) index += 1;
            }
          }
          if (index === nameStart && index < length && isSpecialParam(line.charCodeAt(index))) {
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

      if (isDigit(code) || (code === DOT && index + 1 < length && isDigit(line.charCodeAt(index + 1)))) {
        const start = index;
        if (code === ZERO && index + 2 < length) {
          const marker = line.charCodeAt(index + 1);
          if ((marker === LOWER_X || marker === UPPER_X) && isHex(line.charCodeAt(index + 2))) {
            index += 2;
            while (index < length && isHex(line.charCodeAt(index))) index += 1;
          }
        }
        if (index === start) {
          while (index < length && isDigit(line.charCodeAt(index))) index += 1;
          if (
            index + 1 < length &&
            line.charCodeAt(index) === DOT &&
            isDigit(line.charCodeAt(index + 1))
          ) {
            index += 1;
            while (index < length && isDigit(line.charCodeAt(index))) index += 1;
          }
        }
        spans.push({ text: line.slice(start, index), token: 'number' });
        atStart = false;
        continue;
      }

      // `-Flag`, `--flag`: a reading aid colours the switch itself, so this is
      // checked before `-` falls through to the operator table.
      if (code === DASH) {
        let cursor = index + 1;
        if (cursor < length && line.charCodeAt(cursor) === DASH) cursor += 1;
        if (cursor < length && isLetter(line.charCodeAt(cursor))) {
          const start = index;
          index = cursor;
          while (index < length && isNameCode(line.charCodeAt(index))) index += 1;
          spans.push({ text: line.slice(start, index), token: 'command' });
          atStart = false;
          continue;
        }
      }

      if (isWordLead(code) || (isPathLead(code) && index + 1 < length && (isNameCode(line.charCodeAt(index + 1)) || isPathLead(line.charCodeAt(index + 1))))) {
        const start = index;
        const end = wordEnd(line, start, length);
        // `NAME=value` in command position is an environment prefix, not a
        // command, and the real command still follows it.
        if (lang === 'shell' && atStart && end < length && line.charCodeAt(end) === EQ && isAssignmentName(line, start, end)) {
          let cursor = end + 1;
          while (cursor < length && !isSeparator(line.charCodeAt(cursor))) cursor += 1;
          spans.push({ text: line.slice(start, cursor), token: 'plain' });
          index = cursor;
          continue;
        }
        const decision: { token: DshTokenName; keepsStart: boolean } =
          lang === 'powershell'
            ? { token: classifyPowerShellWord(line, start, end, atStart), keepsStart: false }
            : classifyShellWord(line, start, end, atStart);
        spans.push({ text: line.slice(start, end), token: decision.token });
        atStart = decision.keepsStart;
        index = end;
        continue;
      }

      if (OPERATORS.has(code)) {
        spans.push({ text: line[index], token: 'operator' });
        index += 1;
        if (code === SEMI || code === PIPE || code === LBRACE || code === RBRACE || code === LPAREN) {
          atStart = true;
        } else if (code === EQ && lang === 'powershell') {
          atStart = true;
        } else if (code !== EQ) {
          atStart = false;
        }
        continue;
      }

      // `&`, `~`, `%`, `^`, a lone `.` … anything the tables above do not
      // claim is still emitted so the line round-trips.
      if (code === AMP) {
        const start = index;
        while (index < length && line.charCodeAt(index) === AMP) index += 1;
        spans.push({ text: line.slice(start, index), token: 'plain' });
        atStart = true;
        continue;
      }
      spans.push({ text: line[index], token: 'plain' });
      index += 1;
      atStart = false;
    }

    if (spans.length === 0) spans.push({ text: '', token: 'plain' });
    return merge(spans);
  }

  function merge(spans: DshSpan[]): DshSpan[] {
    const merged: DshSpan[] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && last.token === span.token) last.text += span.text;
      else merged.push({ text: span.text, token: span.token });
    }
    return merged;
  }

  function plainLines(lines: string[]): DshSpan[][] {
    return lines.map((raw) => {
      const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
      return [{ text: line, token: 'plain' as DshTokenName }];
    });
  }

  function languageOf(lang: string): DshLanguage {
    const name = typeof lang === 'string' ? lang.trim().toLowerCase() : '';
    if (name === 'powershell' || name === 'shell') return name;
    return 'plain';
  }

  function highlight(code: string, lang: string): DshSpan[][] {
    const source = typeof code === 'string' ? code : String(code ?? '');
    const lines = source.split('\n');
    const language = languageOf(lang);
    if (language === 'plain') return plainLines(lines);
    try {
      return lines.map((raw) => {
        const line = raw.charCodeAt(raw.length - 1) === CR ? raw.slice(0, -1) : raw;
        return scanLine(line, language);
      });
    } catch {
      return plainLines(lines);
    }
  }

  function langFor(toolName: string, command: string): DshLanguage {
    const tool = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
    const text = typeof command === 'string' ? command : '';
    if (tool === 'pwsh' || tool === 'powershell') return 'powershell';
    for (const marker of PWSH_MARKERS) {
      if (text.includes(marker)) return 'powershell';
    }
    // `$env:` is the one PowerShell marker that is not case sensitive.
    if (/\$env:/i.test(text)) return 'powershell';
    if (tool === 'bash' || tool === 'sh' || tool === 'shell') return 'shell';
    return 'plain';
  }

  return { highlight, langFor };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DshHighlight;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { DshHighlight?: typeof DshHighlight }).DshHighlight = DshHighlight;
}
