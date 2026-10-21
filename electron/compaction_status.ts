export type CompactionRow = Record<string, unknown>;

declare global {
  var CompactionStatus: {
    updateCompaction: typeof updateCompaction;
    settleCompactions: typeof settleCompactions;
    compactionLabel: typeof compactionLabel;
  };
}

export function compactionLabel(row: CompactionRow, language = 'en'): string {
  const zh = language.startsWith('zh');
  const label =
    row.state === 'running'
      ? Number(row.pass) > 0
        ? zh
          ? '正在归并上下文摘要'
          : 'Consolidating context summary'
        : zh
          ? '正在压缩上下文'
          : 'Compacting context'
      : row.state === 'done'
        ? zh
          ? '上下文已压缩'
          : 'Context compacted'
        : row.state === 'error'
          ? zh
            ? '上下文压缩失败'
            : 'Context compaction failed'
          : row.state === 'cancelled'
            ? zh
              ? '上下文压缩已中断'
              : 'Context compaction interrupted'
            : row.status === 'history_changed'
              ? zh
                ? '已保留新指令，跳过本次压缩'
                : 'Compaction skipped · new input preserved'
              : zh
                ? '保留原上下文'
                : 'Original context kept';
  if (row.state === 'running' && Number(row.chunks) > 1) {
    return `${label} · ${row.chunk}/${row.chunks}`;
  }
  if (
    row.state === 'done' &&
    Number(row.beforeTokens) > 0 &&
    Number(row.afterTokens) > 0
  ) {
    return `${label} · ≈${Number(row.beforeTokens).toLocaleString(language)} → ${Number(row.afterTokens).toLocaleString(language)} tokens`;
  }
  return label;
}

export function updateCompaction(
  rows: unknown[],
  fields: CompactionRow,
  at: number,
  origin?: number,
): CompactionRow | null {
  const id = String(fields.compactionId || '');
  if (!id) {
    return null;
  }
  const states: Record<string, string> = {
    request: 'running',
    streaming: 'running',
    summarized: 'running',
    done: 'done',
    failed: 'error',
    cancelled: 'cancelled',
    history_changed: 'skipped',
    not_reduced: 'skipped',
  };
  const status = String(fields.status || '');
  if (!states[status]) {
    return null;
  }
  let row = rows.find(
    value =>
      value &&
      typeof value === 'object' &&
      (value as CompactionRow).noticeType === 'compaction' &&
      (value as CompactionRow).compactionId === id,
  ) as CompactionRow | undefined;
  if (!row) {
    row = {
      kind: 'notice',
      noticeType: 'compaction',
      compactionId: id,
      seq: rows.length + 1,
      startedAt: at,
      ...(origin === undefined ? {} : {timeOriginMs: origin}),
    };
    rows.push(row);
  }
  Object.assign(row, {status, state: states[status], updatedAt: at});
  for (const key of [
    'pass',
    'chunk',
    'chunks',
    'error',
    'beforeTokens',
    'afterTokens',
  ]) {
    if (fields[key] !== undefined) {
      row[key] = fields[key];
    }
  }
  if (row.state !== 'running') {
    row.completedAt = at;
  }
  row.text = compactionLabel(row);
  return row;
}

export function settleCompactions(
  rows: unknown[],
  status: 'failed' | 'cancelled',
  at: number,
  error = '',
): CompactionRow[] {
  const pending = rows.filter(
    value =>
      value &&
      typeof value === 'object' &&
      (value as CompactionRow).noticeType === 'compaction' &&
      (value as CompactionRow).state === 'running',
  ) as CompactionRow[];
  for (const row of pending) {
    const relativeAt = row.timeOriginMs
      ? Math.max(Number(row.startedAt) || 0, at - Number(row.timeOriginMs))
      : at;
    updateCompaction(
      rows,
      {compactionId: row.compactionId, status, ...(error ? {error} : {})},
      relativeAt,
    );
  }
  return pending;
}
