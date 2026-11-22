import type {
  DashboardCellTrace,
  DashboardSourceData,
  TableCell,
  TableRow,
} from './dashboard';

export type DashboardLoadErrorCode = 'load_source_failed' | 'load_calc_failed';

export interface DashboardActiveFilter {
  field: string;
  op: 'eq' | 'in' | 'gte' | 'lte';
  values: Array<string | number>;
  sourceId?: string;
}

export type DashboardSqlRow = Record<string, TableCell | DashboardCellTrace> & {
  __trace: DashboardCellTrace;
};

export interface DashboardSqlResult {
  columns: string[];
  rows: DashboardSqlRow[];
  formula: string;
  warnings: string[];
}

/** Structured error distinguishing upstream source failures from query/calculation errors. */
export class DashboardSqlError extends Error {
  readonly code: DashboardLoadErrorCode;

  constructor(code: DashboardLoadErrorCode, message: string) {
    super(message);
    this.name = 'DashboardSqlError';
    this.code = code;
  }
}

type TokenKind =
  | 'ident'
  | 'number'
  | 'string'
  | 'op'
  | 'punct'
  | 'param'
  | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  upper: string;
}

const FORBIDDEN_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'REPLACE',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'EXEC',
  'EXECUTE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'VACUUM',
]);

function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      let text = '';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          text += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          text += sql[i];
          i += 1;
        }
      }
      tokens.push({kind: 'string', value: text, upper: text});
      continue;
    }
    if (ch === '"' || ch === '`') {
      const quote = ch;
      let ident = '';
      i += 1;
      while (i < sql.length && sql[i] !== quote) {
        ident += sql[i];
        i += 1;
      }
      i += 1;
      tokens.push({kind: 'ident', value: ident, upper: ident.toUpperCase()});
      continue;
    }
    if (ch === '$') {
      let name = '$';
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) {
        name += sql[i];
        i += 1;
      }
      tokens.push({kind: 'param', value: name, upper: name.toUpperCase()});
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let num = '';
      while (i < sql.length && /[0-9.]/.test(sql[i])) {
        num += sql[i];
        i += 1;
      }
      tokens.push({kind: 'number', value: num, upper: num});
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let word = '';
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) {
        word += sql[i];
        i += 1;
      }
      tokens.push({kind: 'ident', value: word, upper: word.toUpperCase()});
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      tokens.push({kind: 'op', value: two, upper: two});
      i += 2;
      continue;
    }
    if ('=<>+-*/%'.includes(ch)) {
      tokens.push({kind: 'op', value: ch, upper: ch});
      i += 1;
      continue;
    }
    if ('(),.;'.includes(ch)) {
      tokens.push({kind: 'punct', value: ch, upper: ch});
      i += 1;
      continue;
    }
    throw new DashboardSqlError('load_calc_failed', `Unexpected character in SQL: ${ch}`);
  }
  tokens.push({kind: 'eof', value: '', upper: ''});
  return tokens;
}

/** Validates that a SQL string is a single read-only SELECT/WITH query. */
export function validateReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new DashboardSqlError('load_calc_failed', 'SQL query is empty.');
  }
  const tokens = tokenizeSql(trimmed);
  let seenSemi = false;
  for (const tok of tokens) {
    if (tok.kind === 'eof') {
      break;
    }
    if (seenSemi) {
      throw new DashboardSqlError(
        'load_calc_failed',
        'Multiple SQL statements are not allowed.',
      );
    }
    if (tok.kind === 'punct' && tok.value === ';') {
      seenSemi = true;
      continue;
    }
    if (tok.kind === 'ident' && FORBIDDEN_KEYWORDS.has(tok.upper)) {
      throw new DashboardSqlError(
        'load_calc_failed',
        `Read-only SQL engine rejected forbidden keyword: ${tok.upper}`,
      );
    }
  }
  const first = tokens[0];
  if (!first || (first.upper !== 'SELECT' && first.upper !== 'WITH')) {
    throw new DashboardSqlError(
      'load_calc_failed',
      'Only SELECT or WITH CTE read-only queries are supported.',
    );
  }
}

type Expr =
  | {type: 'literal'; value: TableCell}
  | {type: 'column'; table?: string; name: string}
  | {type: 'star'; table?: string}
  | {type: 'param'; name: string}
  | {type: 'unary'; op: 'NOT' | '-'; expr: Expr}
  | {type: 'binary'; op: string; left: Expr; right: Expr}
  | {type: 'is_null'; expr: Expr; negated: boolean}
  | {type: 'in'; expr: Expr; values: Expr[]; negated: boolean}
  | {type: 'between'; expr: Expr; low: Expr; high: Expr; negated: boolean}
  | {type: 'case'; base?: Expr; whens: Array<{cond: Expr; then: Expr}>; elseExpr?: Expr}
  | {type: 'func'; name: string; args: Expr[]; distinct: boolean};

interface SelectItem {
  expr: Expr;
  alias?: string;
}

interface TableRef {
  table: string;
  alias: string;
}

interface JoinRef {
  kind: 'INNER' | 'LEFT';
  table: string;
  alias: string;
  on: Expr;
}

interface SelectNode {
  distinct: boolean;
  items: SelectItem[];
  from: TableRef;
  joins: JoinRef[];
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: Array<{expr: Expr; desc: boolean}>;
  limit?: number;
  offset?: number;
}

interface QueryNode {
  ctes: Array<{name: string; query: SelectNode}>;
  select: SelectNode;
}

class SqlParser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private next(): Token {
    const tok = this.peek();
    this.pos += 1;
    return tok;
  }

  private matchKeyword(kw: string): boolean {
    if (this.peek().kind === 'ident' && this.peek().upper === kw) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectKeyword(kw: string): void {
    if (!this.matchKeyword(kw)) {
      throw new DashboardSqlError(
        'load_calc_failed',
        `Expected ${kw}, got "${this.peek().value || 'EOF'}"`,
      );
    }
  }

  private matchPunct(p: string): boolean {
    if (this.peek().kind === 'punct' && this.peek().value === p) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectPunct(p: string): void {
    if (!this.matchPunct(p)) {
      throw new DashboardSqlError(
        'load_calc_failed',
        `Expected "${p}", got "${this.peek().value || 'EOF'}"`,
      );
    }
  }

  parseQuery(): QueryNode {
    const ctes: Array<{name: string; query: SelectNode}> = [];
    if (this.matchKeyword('WITH')) {
      do {
        const name = this.next();
        if (name.kind !== 'ident') {
          throw new DashboardSqlError('load_calc_failed', 'Invalid CTE name.');
        }
        this.expectKeyword('AS');
        this.expectPunct('(');
        const query = this.parseSelect();
        this.expectPunct(')');
        ctes.push({name: name.value, query});
      } while (this.matchPunct(','));
    }
    const select = this.parseSelect();
    this.matchPunct(';');
    if (this.peek().kind !== 'eof') {
      throw new DashboardSqlError(
        'load_calc_failed',
        `Unexpected trailing token: ${this.peek().value}`,
      );
    }
    return {ctes, select};
  }

  private parseSelect(): SelectNode {
    this.expectKeyword('SELECT');
    const distinct = this.matchKeyword('DISTINCT');
    const items: SelectItem[] = [];
    do {
      const expr = this.parseExpr();
      let alias: string | undefined;
      if (this.matchKeyword('AS')) {
        alias = this.next().value;
      } else if (
        this.peek().kind === 'ident' &&
        !['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET'].includes(
          this.peek().upper,
        )
      ) {
        alias = this.next().value;
      }
      items.push({expr, alias});
    } while (this.matchPunct(','));

    this.expectKeyword('FROM');
    const fromTable = this.next().value;
    const fromAlias = this.parseOptionalAlias([
      'INNER',
      'LEFT',
      'JOIN',
      'WHERE',
      'GROUP',
      'HAVING',
      'ORDER',
      'LIMIT',
      'OFFSET',
    ]);
    const from: TableRef = {table: fromTable, alias: fromAlias ?? fromTable};

    const joins: JoinRef[] = [];
    while (true) {
      let kind: 'INNER' | 'LEFT' | null = null;
      if (this.matchKeyword('INNER')) {
        this.expectKeyword('JOIN');
        kind = 'INNER';
      } else if (this.matchKeyword('LEFT')) {
        this.matchKeyword('OUTER');
        this.expectKeyword('JOIN');
        kind = 'LEFT';
      } else if (this.matchKeyword('JOIN')) {
        kind = 'INNER';
      }
      if (!kind) {
        break;
      }
      const table = this.next().value;
      const alias =
        this.parseOptionalAlias(['ON', 'WHERE', 'INNER', 'LEFT', 'JOIN']) ??
        table;
      this.expectKeyword('ON');
      const on = this.parseExpr();
      joins.push({kind, table, alias, on});
    }

    const where = this.matchKeyword('WHERE') ? this.parseExpr() : undefined;
    const groupBy: Expr[] = [];
    if (this.matchKeyword('GROUP')) {
      this.expectKeyword('BY');
      do {
        groupBy.push(this.parseExpr());
      } while (this.matchPunct(','));
    }
    const having = this.matchKeyword('HAVING') ? this.parseExpr() : undefined;

    const orderBy: Array<{expr: Expr; desc: boolean}> = [];
    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY');
      do {
        const expr = this.parseExpr();
        let desc = false;
        if (this.matchKeyword('DESC')) {
          desc = true;
        } else {
          this.matchKeyword('ASC');
        }
        orderBy.push({expr, desc});
      } while (this.matchPunct(','));
    }

    let limit: number | undefined;
    if (this.matchKeyword('LIMIT')) {
      const tok = this.next();
      limit = Number(tok.value);
      if (!Number.isInteger(limit) || limit < 0) {
        throw new DashboardSqlError('load_calc_failed', 'Invalid LIMIT value.');
      }
    }
    let offset: number | undefined;
    if (this.matchKeyword('OFFSET')) {
      const tok = this.next();
      offset = Number(tok.value);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new DashboardSqlError('load_calc_failed', 'Invalid OFFSET value.');
      }
    }
    return {distinct, items, from, joins, where, groupBy, having, orderBy, limit, offset};
  }

  private parseOptionalAlias(stopKeywords: string[]): string | undefined {
    if (this.matchKeyword('AS')) {
      return this.next().value;
    }
    const next = this.peek();
    if (
      next.kind === 'ident' &&
      !stopKeywords.includes(next.upper)
    ) {
      return this.next().value;
    }
    return undefined;
  }

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchKeyword('OR')) {
      left = {type: 'binary', op: 'OR', left, right: this.parseAnd()};
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.matchKeyword('AND')) {
      left = {type: 'binary', op: 'AND', left, right: this.parseNot()};
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.matchKeyword('NOT')) {
      return {type: 'unary', op: 'NOT', expr: this.parseNot()};
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    if (this.matchKeyword('IS')) {
      const negated = this.matchKeyword('NOT');
      this.expectKeyword('NULL');
      return {type: 'is_null', expr: left, negated};
    }
    const negated = this.matchKeyword('NOT');
    if (this.matchKeyword('IN')) {
      this.expectPunct('(');
      const values: Expr[] = [];
      if (!this.matchPunct(')')) {
        do {
          values.push(this.parseExpr());
        } while (this.matchPunct(','));
        this.expectPunct(')');
      }
      return {type: 'in', expr: left, values, negated};
    }
    if (this.matchKeyword('BETWEEN')) {
      const low = this.parseAdditive();
      this.expectKeyword('AND');
      const high = this.parseAdditive();
      return {type: 'between', expr: left, low, high, negated};
    }
    if (this.matchKeyword('LIKE')) {
      return {
        type: 'binary',
        op: negated ? 'NOT LIKE' : 'LIKE',
        left,
        right: this.parseAdditive(),
      };
    }
    if (negated) {
      throw new DashboardSqlError('load_calc_failed', 'Unexpected NOT in expression.');
    }
    const tok = this.peek();
    if (tok.kind === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(tok.value)) {
      this.next();
      return {
        type: 'binary',
        op: tok.value === '<>' ? '!=' : tok.value,
        left,
        right: this.parseAdditive(),
      };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek().kind === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      left = {type: 'binary', op, left, right: this.parseMultiplicative()};
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePrimary();
    while (
      this.peek().kind === 'op' &&
      (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === '%')
    ) {
      const op = this.next().value;
      left = {type: 'binary', op, left, right: this.parsePrimary()};
    }
    return left;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    if (tok.kind === 'op' && tok.value === '-') {
      this.next();
      return {type: 'unary', op: '-', expr: this.parsePrimary()};
    }
    if (tok.kind === 'op' && tok.value === '*') {
      this.next();
      return {type: 'star'};
    }
    if (this.matchPunct('(')) {
      const inner = this.parseExpr();
      this.expectPunct(')');
      return inner;
    }
    if (tok.kind === 'param') {
      this.next();
      return {type: 'param', name: tok.value};
    }
    if (tok.kind === 'number') {
      this.next();
      return {type: 'literal', value: Number(tok.value)};
    }
    if (tok.kind === 'string') {
      this.next();
      return {type: 'literal', value: tok.value};
    }
    if (tok.kind === 'ident') {
      if (tok.upper === 'NULL') {
        this.next();
        return {type: 'literal', value: null};
      }
      if (tok.upper === 'TRUE' || tok.upper === 'FALSE') {
        this.next();
        return {type: 'literal', value: tok.upper === 'TRUE'};
      }
      if (tok.upper === 'CASE') {
        this.next();
        let base: Expr | undefined;
        if (!this.matchKeyword('WHEN')) {
          base = this.parseExpr();
        } else {
          this.pos -= 1;
        }
        const whens: Array<{cond: Expr; then: Expr}> = [];
        while (this.matchKeyword('WHEN')) {
          const cond = this.parseExpr();
          this.expectKeyword('THEN');
          const then = this.parseExpr();
          whens.push({cond, then});
        }
        const elseExpr = this.matchKeyword('ELSE') ? this.parseExpr() : undefined;
        this.expectKeyword('END');
        return {type: 'case', base, whens, elseExpr};
      }
      this.next();
      if (this.matchPunct('(')) {
        const distinct = this.matchKeyword('DISTINCT');
        const args: Expr[] = [];
        if (!this.matchPunct(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.matchPunct(','));
          this.expectPunct(')');
        }
        return {type: 'func', name: tok.upper, args, distinct};
      }
      if (this.matchPunct('.')) {
        if (this.peek().kind === 'op' && this.peek().value === '*') {
          this.next();
          return {type: 'star', table: tok.value};
        }
        const col = this.next();
        return {type: 'column', table: tok.value, name: col.value};
      }
      return {type: 'column', name: tok.value};
    }
    throw new DashboardSqlError(
      'load_calc_failed',
      `Unexpected token in SQL expression: ${tok.value || 'EOF'}`,
    );
  }
}

interface EvalRow {
  values: Record<string, TableCell>;
  qualified: Record<string, Record<string, TableCell>>;
  trace: DashboardCellTrace;
}

const AGGREGATE_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN']);

function hasAggregate(expr: Expr): boolean {
  switch (expr.type) {
    case 'func':
      return AGGREGATE_FUNCS.has(expr.name) || expr.args.some(hasAggregate);
    case 'unary':
      return hasAggregate(expr.expr);
    case 'binary':
      return hasAggregate(expr.left) || hasAggregate(expr.right);
    case 'is_null':
      return hasAggregate(expr.expr);
    case 'in':
      return hasAggregate(expr.expr) || expr.values.some(hasAggregate);
    case 'between':
      return (
        hasAggregate(expr.expr) ||
        hasAggregate(expr.low) ||
        hasAggregate(expr.high)
      );
    case 'case':
      return (
        (expr.base ? hasAggregate(expr.base) : false) ||
        expr.whens.some(w => hasAggregate(w.cond) || hasAggregate(w.then)) ||
        (expr.elseExpr ? hasAggregate(expr.elseExpr) : false)
      );
    default:
      return false;
  }
}

function toNumber(val: TableCell): number | null {
  if (val === null || val === undefined || typeof val === 'boolean') {
    return null;
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  const s = String(val).trim();
  if (!s) {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function compareCells(a: TableCell, b: TableCell): number {
  if (a === b) {
    return 0;
  }
  if (a === null || a === undefined) {
    return -1;
  }
  if (b === null || b === undefined) {
    return 1;
  }
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) {
    return na - nb;
  }
  return String(a).localeCompare(String(b));
}

function matchLike(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function dateTrunc(unit: string, raw: TableCell): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const text = String(raw).trim();
  const d = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (unit.toLowerCase()) {
    case 'year':
      return `${y}-01-01`;
    case 'month':
      return `${y}-${pad(m + 1)}-01`;
    case 'week': {
      const dow = (d.getUTCDay() + 6) % 7;
      const monday = new Date(Date.UTC(y, m, day - dow));
      return monday.toISOString().slice(0, 10);
    }
    case 'day':
    default:
      return `${y}-${pad(m + 1)}-${pad(day)}`;
  }
}

function matchActiveFilters(
  row: EvalRow,
  filters: DashboardActiveFilter[],
): boolean {
  for (const filter of filters) {
    if (!filter.values.length) {
      continue;
    }
    const actual = row.values[filter.field];
    if (actual === undefined || actual === null) {
      return false;
    }
    if (filter.op === 'eq' || filter.op === 'in') {
      if (!filter.values.some(v => String(actual) === String(v))) {
        return false;
      }
    } else if (filter.op === 'gte') {
      if (compareCells(actual, filter.values[0]) < 0) {
        return false;
      }
    } else if (filter.op === 'lte') {
      if (compareCells(actual, filter.values[0]) > 0) {
        return false;
      }
    }
  }
  return true;
}

function evalExpr(
  expr: Expr,
  row: EvalRow,
  groupRows: EvalRow[] | null,
  filters: DashboardActiveFilter[],
): TableCell {
  switch (expr.type) {
    case 'literal':
      return expr.value;
    case 'param':
      if (expr.name.toUpperCase() === '$FILTERS') {
        return matchActiveFilters(row, filters);
      }
      throw new DashboardSqlError('load_calc_failed', `Unknown parameter: ${expr.name}`);
    case 'column': {
      if (expr.table) {
        const tbl = row.qualified[expr.table];
        if (!tbl) {
          throw new DashboardSqlError(
            'load_calc_failed',
            `Unknown table alias "${expr.table}"`,
          );
        }
        return tbl[expr.name] ?? null;
      }
      return row.values[expr.name] ?? null;
    }
    case 'unary': {
      const val = evalExpr(expr.expr, row, groupRows, filters);
      if (expr.op === 'NOT') {
        return !val;
      }
      const n = toNumber(val);
      return n === null ? null : -n;
    }
    case 'is_null': {
      const val = evalExpr(expr.expr, row, groupRows, filters);
      const isNull = val === null || val === undefined || val === '';
      return expr.negated ? !isNull : isNull;
    }
    case 'in': {
      const target = evalExpr(expr.expr, row, groupRows, filters);
      if (target === null || target === undefined) {
        return false;
      }
      const matched = expr.values.some(
        v => compareCells(target, evalExpr(v, row, groupRows, filters)) === 0,
      );
      return expr.negated ? !matched : matched;
    }
    case 'between': {
      const target = evalExpr(expr.expr, row, groupRows, filters);
      if (target === null || target === undefined) {
        return false;
      }
      const lo = evalExpr(expr.low, row, groupRows, filters);
      const hi = evalExpr(expr.high, row, groupRows, filters);
      const inside =
        compareCells(target, lo) >= 0 && compareCells(target, hi) <= 0;
      return expr.negated ? !inside : inside;
    }
    case 'binary': {
      if (expr.op === 'AND') {
        return (
          Boolean(evalExpr(expr.left, row, groupRows, filters)) &&
          Boolean(evalExpr(expr.right, row, groupRows, filters))
        );
      }
      if (expr.op === 'OR') {
        return (
          Boolean(evalExpr(expr.left, row, groupRows, filters)) ||
          Boolean(evalExpr(expr.right, row, groupRows, filters))
        );
      }
      const l = evalExpr(expr.left, row, groupRows, filters);
      const r = evalExpr(expr.right, row, groupRows, filters);
      if (expr.op === 'LIKE' || expr.op === 'NOT LIKE') {
        if (l === null || r === null) {
          return false;
        }
        const ok = matchLike(String(l), String(r));
        return expr.op === 'NOT LIKE' ? !ok : ok;
      }
      if (expr.op === '=') {
        return l !== null && r !== null && compareCells(l, r) === 0;
      }
      if (expr.op === '!=') {
        return l !== null && r !== null && compareCells(l, r) !== 0;
      }
      if (['<', '<=', '>', '>='].includes(expr.op)) {
        if (l === null || r === null) {
          return false;
        }
        const cmp = compareCells(l, r);
        if (expr.op === '<') {
          return cmp < 0;
        }
        if (expr.op === '<=') {
          return cmp <= 0;
        }
        if (expr.op === '>') {
          return cmp > 0;
        }
        return cmp >= 0;
      }
      const nl = toNumber(l);
      const nr = toNumber(r);
      if (nl === null || nr === null) {
        return null;
      }
      if (expr.op === '+') {
        return nl + nr;
      }
      if (expr.op === '-') {
        return nl - nr;
      }
      if (expr.op === '*') {
        return nl * nr;
      }
      if (expr.op === '/') {
        return nr === 0 ? null : nl / nr;
      }
      if (expr.op === '%') {
        return nr === 0 ? null : nl % nr;
      }
      return null;
    }
    case 'case': {
      const baseVal = expr.base
        ? evalExpr(expr.base, row, groupRows, filters)
        : undefined;
      for (const branch of expr.whens) {
        const condVal = evalExpr(branch.cond, row, groupRows, filters);
        const hit = expr.base
          ? compareCells(baseVal ?? null, condVal) === 0
          : Boolean(condVal);
        if (hit) {
          return evalExpr(branch.then, row, groupRows, filters);
        }
      }
      return expr.elseExpr
        ? evalExpr(expr.elseExpr, row, groupRows, filters)
        : null;
    }
    case 'func': {
      if (AGGREGATE_FUNCS.has(expr.name)) {
        const rows = groupRows ?? [row];
        if (expr.name === 'COUNT') {
          const arg = expr.args[0];
          if (!arg || arg.type === 'star') {
            return rows.length;
          }
          const vals = rows
            .map(r => evalExpr(arg, r, null, filters))
            .filter(v => v !== null && v !== undefined && String(v).trim() !== '');
          if (expr.distinct) {
            return new Set(vals.map(v => String(v))).size;
          }
          return vals.length;
        }
        const nums = rows
          .map(r => toNumber(evalExpr(expr.args[0], r, null, filters)))
          .filter((n): n is number => n !== null);
        if (!nums.length) {
          return null;
        }
        if (expr.name === 'SUM') {
          return nums.reduce((acc, n) => acc + n, 0);
        }
        if (expr.name === 'AVG') {
          return nums.reduce((acc, n) => acc + n, 0) / nums.length;
        }
        if (expr.name === 'MIN') {
          return Math.min(...nums);
        }
        if (expr.name === 'MAX') {
          return Math.max(...nums);
        }
        if (expr.name === 'MEDIAN') {
          const sorted = [...nums].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
        }
      }
      const args = expr.args.map(a => evalExpr(a, row, groupRows, filters));
      switch (expr.name) {
        case 'DATE_TRUNC':
          return dateTrunc(String(args[0] ?? 'day'), args[1] ?? null);
        case 'COALESCE':
          return args.find(v => v !== null && v !== undefined && v !== '') ?? null;
        case 'NULLIF':
          return compareCells(args[0] ?? null, args[1] ?? null) === 0
            ? null
            : (args[0] ?? null);
        case 'ROUND': {
          const n = toNumber(args[0] ?? null);
          const digits = toNumber(args[1] ?? 0) ?? 0;
          if (n === null) {
            return null;
          }
          const factor = 10 ** digits;
          return Math.round(n * factor) / factor;
        }
        case 'ABS': {
          const n = toNumber(args[0] ?? null);
          return n === null ? null : Math.abs(n);
        }
        case 'LOWER':
          return args[0] === null ? null : String(args[0]).toLowerCase();
        case 'UPPER':
          return args[0] === null ? null : String(args[0]).toUpperCase();
        default:
          throw new DashboardSqlError(
            'load_calc_failed',
            `Unsupported SQL function: ${expr.name}`,
          );
      }
    }
    default:
      return null;
  }
}

function inferColumnName(item: SelectItem, index: number): string {
  if (item.alias) {
    return item.alias;
  }
  if (item.expr.type === 'column') {
    return item.expr.name;
  }
  if (item.expr.type === 'func') {
    return item.expr.name.toLowerCase();
  }
  return `col_${index + 1}`;
}

function exprKey(expr: Expr): string {
  return JSON.stringify(expr);
}

function resolveTable(
  name: string,
  tables: Map<string, DashboardSourceData>,
): DashboardSourceData {
  const found = tables.get(name);
  if (!found) {
    throw new DashboardSqlError(
      'load_source_failed',
      `SQL source table not found: "${name}"`,
    );
  }
  if (found.error) {
    throw new DashboardSqlError('load_source_failed', found.error);
  }
  return found;
}

function executeSelect(
  node: SelectNode,
  tables: Map<string, DashboardSourceData>,
  filters: DashboardActiveFilter[],
  formula: string,
): {columns: string[]; rows: DashboardSqlRow[]; sourceData: DashboardSourceData} {
  const baseData = resolveTable(node.from.table, tables);
  let working: EvalRow[] = baseData.rows.map((raw, idx) => ({
    values: {...raw},
    qualified: {[node.from.alias]: {...raw}},
    trace: {
      sourceId: baseData.source.sourceId,
      rowIndexes: [idx],
      rowNumbers: [baseData.rowNumbers[idx] ?? idx + 1],
      formula,
      excludedCount: 0,
    },
  }));

  for (const join of node.joins) {
    const rightData = resolveTable(join.table, tables);
    const nextRows: EvalRow[] = [];
    for (const leftRow of working) {
      let matched = false;
      for (const rightRaw of rightData.rows) {
        const merged: EvalRow = {
          values: {...leftRow.values, ...rightRaw},
          qualified: {...leftRow.qualified, [join.alias]: {...rightRaw}},
          trace: leftRow.trace,
        };
        if (evalExpr(join.on, merged, null, filters)) {
          matched = true;
          nextRows.push(merged);
        }
      }
      if (!matched && join.kind === 'LEFT') {
        const emptyRight = Object.fromEntries(
          rightData.columns.map(col => [col, null]),
        );
        nextRows.push({
          values: {...leftRow.values, ...emptyRight},
          qualified: {...leftRow.qualified, [join.alias]: emptyRight},
          trace: leftRow.trace,
        });
      }
    }
    working = nextRows;
  }

  if (node.where) {
    working = working.filter(row => Boolean(evalExpr(node.where!, row, null, filters)));
  }

  const isAggregateQuery =
    node.groupBy.length > 0 || node.items.some(item => hasAggregate(item.expr));

  interface GroupEntry {
    rep: EvalRow;
    members: EvalRow[];
    trace: DashboardCellTrace;
  }

  let groups: GroupEntry[];
  if (isAggregateQuery) {
    const map = new Map<string, GroupEntry>();
    for (const row of working) {
      const keyParts = node.groupBy.map(g => evalExpr(g, row, null, filters));
      const key = JSON.stringify(keyParts);
      const existing = map.get(key);
      if (existing) {
        existing.members.push(row);
        existing.trace.rowIndexes.push(...row.trace.rowIndexes);
        existing.trace.rowNumbers.push(...row.trace.rowNumbers);
      } else {
        map.set(key, {
          rep: row,
          members: [row],
          trace: {
            sourceId: row.trace.sourceId,
            rowIndexes: [...row.trace.rowIndexes],
            rowNumbers: [...row.trace.rowNumbers],
            formula,
            excludedCount: 0,
          },
        });
      }
    }
    groups = [...map.values()];
    if (!groups.length && node.groupBy.length === 0) {
      groups = [
        {
          rep: {
            values: {},
            qualified: {},
            trace: {
              sourceId: baseData.source.sourceId,
              rowIndexes: [],
              rowNumbers: [],
              formula,
              excludedCount: 0,
            },
          },
          members: [],
          trace: {
            sourceId: baseData.source.sourceId,
            rowIndexes: [],
            rowNumbers: [],
            formula,
            excludedCount: 0,
          },
        },
      ];
    }
    if (node.having) {
      groups = groups.filter(g =>
        Boolean(evalExpr(node.having!, g.rep, g.members, filters)),
      );
    }
  } else {
    groups = working.map(row => ({
      rep: row,
      members: [row],
      trace: row.trace,
    }));
  }

  // Deduplicate rowIndexes/rowNumbers in each group trace
  for (const g of groups) {
    const seen = new Set<number>();
    const idxs: number[] = [];
    const nums: number[] = [];
    for (let i = 0; i < g.trace.rowIndexes.length; i += 1) {
      const idx = g.trace.rowIndexes[i];
      if (!seen.has(idx)) {
        seen.add(idx);
        idxs.push(idx);
        nums.push(g.trace.rowNumbers[i]);
      }
    }
    g.trace.rowIndexes = idxs;
    g.trace.rowNumbers = nums;
  }

  const columns: string[] = [];
  const projectedRows: Array<{row: DashboardSqlRow; entry: GroupEntry}> = groups.map(
    entry => {
      const out: Record<string, TableCell> = {};
      node.items.forEach((item, idx) => {
        if (item.expr.type === 'star') {
          const sourceObj = item.expr.table
            ? (entry.rep.qualified[item.expr.table] ?? {})
            : entry.rep.values;
          for (const [k, v] of Object.entries(sourceObj)) {
            if (!columns.includes(k)) {
              columns.push(k);
            }
            out[k] = v;
          }
          return;
        }
        const colName = inferColumnName(item, idx);
        if (!columns.includes(colName)) {
          columns.push(colName);
        }
        out[colName] = evalExpr(
          item.expr,
          entry.rep,
          isAggregateQuery ? entry.members : null,
          filters,
        );
      });
      return {
        entry,
        row: {
          ...out,
          __trace: entry.trace,
        } as DashboardSqlRow,
      };
    },
  );

  if (node.orderBy.length) {
    projectedRows.sort((a, b) => {
      for (const ord of node.orderBy) {
        let va: TableCell;
        let vb: TableCell;
        if (ord.expr.type === 'column' && !ord.expr.table && ord.expr.name in a.row) {
          va = a.row[ord.expr.name] as TableCell;
          vb = b.row[ord.expr.name] as TableCell;
        } else if (ord.expr.type === 'literal' && typeof ord.expr.value === 'number') {
          const col = columns[ord.expr.value - 1];
          va = col ? (a.row[col] as TableCell) : null;
          vb = col ? (b.row[col] as TableCell) : null;
        } else {
          const matchedItem = node.items.find(
            it => exprKey(it.expr) === exprKey(ord.expr),
          );
          if (matchedItem?.alias && matchedItem.alias in a.row) {
            va = a.row[matchedItem.alias] as TableCell;
            vb = b.row[matchedItem.alias] as TableCell;
          } else {
            va = evalExpr(
              ord.expr,
              a.entry.rep,
              isAggregateQuery ? a.entry.members : null,
              filters,
            );
            vb = evalExpr(
              ord.expr,
              b.entry.rep,
              isAggregateQuery ? b.entry.members : null,
              filters,
            );
          }
        }
        const cmp = compareCells(va, vb);
        if (cmp !== 0) {
          return ord.desc ? -cmp : cmp;
        }
      }
      return 0;
    });
  }

  let finalRows = projectedRows.map(p => p.row);
  if (node.distinct) {
    const seen = new Set<string>();
    finalRows = finalRows.filter(r => {
      const key = JSON.stringify(columns.map(c => r[c]));
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  const offset = node.offset ?? 0;
  if (offset > 0 || node.limit !== undefined) {
    finalRows = finalRows.slice(
      offset,
      node.limit !== undefined ? offset + node.limit : undefined,
    );
  }
  return {columns, rows: finalRows, sourceData: baseData};
}

/**
 * Executes a read-only SQL query (SELECT / WITH CTEs / JOINs / aggregates)
 * against registered DashboardSourceData tables while preserving row-number lineage.
 */
export function executeDashboardSql(
  sql: string,
  sources: Map<string, DashboardSourceData>,
  options: {filters?: DashboardActiveFilter[]; generatedAt?: string} = {},
): DashboardSqlResult {
  validateReadOnlySql(sql);
  const tokens = tokenizeSql(sql);
  const ast = new SqlParser(tokens).parseQuery();
  const scopeTables = new Map(sources);
  const filters = options.filters ?? [];

  for (const cte of ast.ctes) {
    const res = executeSelect(cte.query, scopeTables, filters, sql.trim());
    scopeTables.set(cte.name, {
      source: {sourceId: res.sourceData.source.sourceId, kind: res.sourceData.source.kind},
      columns: res.columns,
      rows: res.rows.map(r => {
        const {__trace: _trace, ...rest} = r;
        return rest as TableRow;
      }),
      rowNumbers: res.rows.map(r => r.__trace.rowNumbers[0] ?? 1),
      warnings: [],
    });
  }

  const final = executeSelect(ast.select, scopeTables, filters, sql.trim());
  return {
    columns: final.columns,
    rows: final.rows,
    formula: sql.trim(),
    warnings: [],
  };
}
