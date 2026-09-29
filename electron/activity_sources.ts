import type {
  FileActivityChange,
  PersonalActivityDay,
  PersonalActivityStatus,
  ScreenActivitySample,
} from './personal_activity';

export type ActivitySourceRef =
  | {kind: 'screen' | 'file'; date: string; index: number}
  | {kind: 'external'; provider: 'screenpipe'; frameId: number; at: string};

export interface ActivityEvidence {
  at: string;
  source: 'magic-pointer-screen' | 'magic-pointer-file' | 'screenpipe-ocr';
  app: string;
  title: string;
  text: string;
  refs: ActivitySourceRef[];
  usedBackend: string;
}

export interface ActivityEpisode {
  app: string;
  title: string;
  from: string;
  to: string;
  evidenceCount: number;
  excerpts: string[];
  refs: ActivitySourceRef[];
  signalKinds: Array<ActivitySignal['kind']>;
}

export interface ActivitySignal {
  kind: 'possible-request' | 'possible-commitment' | 'possible-deadline';
  status: 'needs-review';
  at: string;
  app: string;
  title: string;
  excerpt: string;
  reason: string;
  refs: ActivitySourceRef[];
}

export interface ActivitySourceView {
  date: string;
  segments: ActivitySegment[];
  workItems: ActivityWorkItem[];
  brief: ActivityBrief;
  evidence: ActivityEvidence[];
  episodes: ActivityEpisode[];
  signals: ActivitySignal[];
  repeatedLinks: Array<{
    url: string;
    appearances: number;
    refs: ActivitySourceRef[];
  }>;
  coverage: PersonalActivityDay['coverage'];
  detailsCleared: boolean;
}

export interface ActivityLocalEvidenceRef {
  kind: 'screen' | 'file';
  index: number;
  at: string;
}

export interface ActivitySegment {
  id: string;
  from: string;
  to: string;
  appId: string;
  label: string;
  windowTitle?: string;
  activeMs?: number;
  evidence: ActivityLocalEvidenceRef[];
  coverage: 'observed' | 'partial';
}

export interface ActivityWorkItem {
  path: string;
  kind: FileActivityChange['kind'];
  at: string;
  previousPath?: string;
  evidence: ActivityLocalEvidenceRef[];
}

export interface ActivityBrief {
  generatedAt: string;
  observations: Array<{
    text: string;
    evidence: ActivityLocalEvidenceRef[];
    segmentId?: string;
  }>;
  openThreads: Array<{
    text: string;
    conversationId?: string;
    path?: string;
    evidence: ActivityLocalEvidenceRef[];
  }>;
  coverageNote: string;
}

export interface ScreenpipeConnection {
  state:
    | 'disabled'
    | 'not-recording'
    | 'details-cleared'
    | 'no-anchor'
    | 'unavailable'
    | 'connected'
    | 'error';
  usedBackend: 'screenpipe.local-http' | 'none';
  queriedWindows: number;
  acceptedRows: number;
  omittedWindows: number;
  error?: string;
}

export interface ActivitySourcesResult {
  view: ActivitySourceView;
  screenpipe: ScreenpipeConnection;
}

export interface ScreenpipeOptions {
  enabled: boolean;
  port?: number;
  apiKey?: string;
}

interface ScreenpipeOcrRow {
  type: 'OCR';
  content: {
    frame_id: number;
    text: string;
    timestamp: string;
    app_name: string;
    window_name: string;
    text_source?: string;
  };
}

const REQUEST =
  /(?:请.{0,24}(?:发|给|确认|回复|提供|看看)|麻烦.{0,24}(?:发|给|确认|回复|提供|看看)|能否.{0,24}(?:发|给|确认|提供)|please.{0,24}(?:send|confirm|reply|provide))/i;
const COMMITMENT =
  /(?:我(?:会|来|明天|稍后).{0,32}(?:发|给|回复|提供|整理|确认)|(?:i will|i'll).{0,32}(?:send|reply|share|confirm))/i;
const DEADLINE =
  /(?:截止|截至|最晚|明天.{0,12}(?:前|交)|deadline|due by|by (?:monday|tuesday|wednesday|thursday|friday))/i;
const LINK = /https?:\/\/[^\s<>"'，。；）]+/gi;

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function sourceKey(ref: ActivitySourceRef): string {
  return ref.kind === 'external'
    ? `${ref.provider}:${ref.frameId}`
    : `${ref.kind}:${ref.date}:${ref.index}`;
}

function appKey(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function excerptFor(text: string, pattern: RegExp): string {
  const line = text
    .split(/\r?\n/)
    .map(compact)
    .find(part => pattern.test(part));
  return (line || compact(text)).slice(0, 220);
}

function matchedSampleIndex(
  row: ScreenpipeOcrRow['content'],
  samples: ScreenActivitySample[],
): number {
  const when = Date.parse(row.timestamp);
  if (!Number.isFinite(when)) {
    return -1;
  }
  const externalApp = appKey(row.app_name);
  const externalTitle = compact(row.window_name).toLocaleLowerCase();
  return samples.findIndex(sample => {
    if (Math.abs(Date.parse(sample.at) - when) > 90_000) {
      return false;
    }
    const nativeApp = appKey(sample.appId);
    const nativeTitle = compact(sample.title).toLocaleLowerCase();
    return Boolean(
      (externalApp && nativeApp && externalApp === nativeApp) ||
      (externalTitle && nativeTitle && externalTitle === nativeTitle),
    );
  });
}

function localRefs(
  day: PersonalActivityDay,
  refs: ActivitySourceRef[],
): ActivityLocalEvidenceRef[] {
  return refs.flatMap(ref =>
    ref.kind === 'external'
      ? []
      : [
          {
            kind: ref.kind,
            index: ref.index,
            at:
              ref.kind === 'screen'
                ? day.screens[ref.index]?.at || ''
                : day.files[ref.index]?.at || '',
          },
        ],
  );
}

function buildSegments(day: PersonalActivityDay): ActivitySegment[] {
  if (day.detailsCleared) {
    return [];
  }
  type Interval = {
    from: string;
    to: string;
    appId: string;
    label: string;
    windowTitle?: string;
    activeMs: number;
  };
  const intervals =
    (day as PersonalActivityDay & {intervals?: Interval[]}).intervals || [];
  const segments: ActivitySegment[] = [];
  for (const interval of [...intervals].sort((left, right) =>
    left.from.localeCompare(right.from),
  )) {
    const previous = segments.at(-1);
    if (
      previous &&
      previous.to === interval.from &&
      previous.appId === interval.appId &&
      previous.windowTitle === interval.windowTitle
    ) {
      previous.to = interval.to;
      previous.activeMs = (previous.activeMs || 0) + interval.activeMs;
      continue;
    }
    segments.push({
      id: `interval:${segments.length}:${interval.from}`,
      from: interval.from,
      to: interval.to,
      appId: interval.appId,
      label: interval.label,
      ...(interval.windowTitle ? {windowTitle: interval.windowTitle} : {}),
      activeMs: interval.activeMs,
      evidence: [],
      coverage: 'observed',
    });
  }
  day.screens.forEach((sample, index) => {
    const ref: ActivityLocalEvidenceRef = {
      kind: 'screen',
      index,
      at: sample.at,
    };
    const owner = segments.find(
      segment =>
        sample.at >= segment.from &&
        sample.at <= segment.to &&
        appKey(segment.appId) === appKey(sample.appId),
    );
    if (owner) {
      owner.evidence.push(ref);
    } else {
      segments.push({
        id: `screen:${index}:${sample.at}`,
        from: sample.at,
        to: sample.at,
        appId: sample.appId,
        label: sample.appId,
        windowTitle: sample.title,
        evidence: [ref],
        coverage: 'partial',
      });
    }
  });
  return segments.sort((left, right) => left.from.localeCompare(right.from));
}

function buildWorkItems(day: PersonalActivityDay): ActivityWorkItem[] {
  const items = new Map<string, ActivityWorkItem>();
  if (day.detailsCleared) {
    return [];
  }
  day.files.forEach((file, index) => {
    const ref: ActivityLocalEvidenceRef = {kind: 'file', index, at: file.at};
    const prior = items.get(file.path);
    if (prior) {
      prior.kind = file.kind;
      prior.at = file.at;
      prior.previousPath = file.previousPath || prior.previousPath;
      prior.evidence.push(ref);
    } else {
      items.set(file.path, {
        path: file.path,
        kind: file.kind,
        at: file.at,
        ...(file.previousPath ? {previousPath: file.previousPath} : {}),
        evidence: [ref],
      });
    }
  });
  return [...items.values()].sort((left, right) =>
    right.at.localeCompare(left.at),
  );
}

function buildBrief(
  day: PersonalActivityDay,
  segments: ActivitySegment[],
  workItems: ActivityWorkItem[],
  signals: ActivitySignal[],
  episodes: ActivityEpisode[],
  generatedAt: string,
): ActivityBrief {
  const observations: ActivityBrief['observations'] = [];
  for (const signal of signals.slice(0, 3)) {
    const evidence = localRefs(day, signal.refs);
    if (evidence.length) {
      observations.push({text: `待核查线索：${signal.excerpt}`, evidence});
    }
  }
  for (const episode of episodes) {
    if (observations.length >= 6) {
      break;
    }
    const excerpt = episode.excerpts.find(text => text.length >= 24);
    const evidence = localRefs(day, episode.refs);
    if (excerpt && evidence.length) {
      observations.push({
        text: `${episode.app} · ${episode.title}：${excerpt.slice(0, 120)}`,
        evidence,
      });
    }
  }
  for (const item of workItems.slice(0, Math.max(0, 8 - observations.length))) {
    const action = {
      created: '新增',
      modified: '修改',
      deleted: '删除',
      renamed: '重命名',
    }[item.kind];
    observations.push({
      text: `${action}文件：${item.path}`,
      evidence: item.evidence,
    });
  }
  if (!observations.length) {
    for (const segment of segments
      .filter(item => item.coverage === 'observed' && item.activeMs)
      .slice(0, 2)) {
      const label = segment.windowTitle
        ? `${segment.label} · ${segment.windowTitle}`
        : segment.label;
      observations.push({
        text: `${label} 在 ${segment.from} 至 ${segment.to} 处于前台。`,
        evidence: segment.evidence,
        segmentId: segment.id,
      });
    }
  }
  const coverageNote = day.detailsCleared
    ? '该日详细记录已删除，只保留汇总。'
    : segments.some(item => item.coverage === 'observed')
      ? '前台区间来自实际记录；屏幕文字只覆盖采样时刻，待办线索须回看原文。'
      : day.screens.length
        ? '只有零散屏幕采样，无法推断连续使用时长或完整对话。'
        : '当天没有可回看的屏幕样本；无法据此推断具体工作内容。';
  return {generatedAt, observations, openThreads: [], coverageNote};
}

function screenEvidence(day: PersonalActivityDay): ActivityEvidence[] {
  return day.screens
    .filter(sample => sample.text.trim())
    .map(sample => {
      const index = day.screens.indexOf(sample);
      return {
        at: sample.at,
        source: 'magic-pointer-screen' as const,
        app: sample.appId,
        title: sample.title,
        text: sample.text,
        refs: [{kind: 'screen' as const, date: day.date, index}],
        usedBackend: sample.usedBackend,
      };
    });
}

function fileEvidence(day: PersonalActivityDay): ActivityEvidence[] {
  return day.files.map((file, index) => ({
    at: file.at,
    source: 'magic-pointer-file' as const,
    app: 'Files',
    title: file.path,
    text: `${file.kind}: ${file.path}`,
    refs: [{kind: 'file' as const, date: day.date, index}],
    usedBackend: 'magic-pointer.fs-watch',
  }));
}

function deduplicate(evidence: ActivityEvidence[]): ActivityEvidence[] {
  const result: ActivityEvidence[] = [];
  const seen = new Map<string, ActivityEvidence>();
  for (const item of evidence.sort((left, right) =>
    left.at.localeCompare(right.at),
  )) {
    const bucket = Math.floor(Date.parse(item.at) / 600_000);
    const key = `${bucket}\u0000${appKey(item.app)}\u0000${compact(item.title).toLocaleLowerCase()}\u0000${compact(item.text).toLocaleLowerCase()}`;
    const existing = seen.get(key);
    if (existing) {
      const keys = new Set(existing.refs.map(sourceKey));
      for (const ref of item.refs) {
        if (!keys.has(sourceKey(ref))) {
          existing.refs.push(ref);
          keys.add(sourceKey(ref));
        }
      }
      if (!existing.usedBackend.includes(item.usedBackend)) {
        existing.usedBackend += ` + ${item.usedBackend}`;
      }
      continue;
    }
    const copy = {...item, refs: [...item.refs]};
    seen.set(key, copy);
    result.push(copy);
  }
  return result;
}

function classify(item: ActivityEvidence): ActivitySignal[] {
  if (item.source === 'magic-pointer-file') {
    return [];
  }
  const signals: ActivitySignal[] = [];
  for (const [kind, pattern, reason] of [
    [
      'possible-request',
      REQUEST,
      '画面中出现请求措辞；需核对发送人和后续回复。',
    ],
    [
      'possible-commitment',
      COMMITMENT,
      '画面中出现承诺措辞；需核对是谁承诺及是否已完成。',
    ],
    [
      'possible-deadline',
      DEADLINE,
      '画面中出现期限措辞；需核对具体日期和事项。',
    ],
  ] as const) {
    if (!pattern.test(item.text)) {
      continue;
    }
    signals.push({
      kind,
      status: 'needs-review',
      at: item.at,
      app: item.app,
      title: item.title,
      excerpt: excerptFor(item.text, pattern),
      reason,
      refs: [...item.refs],
    });
  }
  return signals;
}

export function organizeActivityEvidence(
  day: PersonalActivityDay,
  externalRows: ScreenpipeOcrRow[] = [],
  generatedAt = new Date().toISOString(),
): ActivitySourceView {
  const externalEvidence: ActivityEvidence[] = externalRows
    .filter(
      row =>
        row.type === 'OCR' && matchedSampleIndex(row.content, day.screens) >= 0,
    )
    .map(row => ({
      at: row.content.timestamp,
      source: 'screenpipe-ocr',
      app: row.content.app_name,
      title: row.content.window_name,
      text: row.content.text,
      refs: [
        {
          kind: 'screen',
          date: day.date,
          index: matchedSampleIndex(row.content, day.screens),
        },
        {
          kind: 'external',
          provider: 'screenpipe',
          frameId: row.content.frame_id,
          at: row.content.timestamp,
        },
      ],
      usedBackend: `screenpipe.${row.content.text_source || 'ocr'}`,
    }));
  const evidence = day.detailsCleared
    ? []
    : deduplicate([
        ...screenEvidence(day),
        ...fileEvidence(day),
        ...externalEvidence,
      ]);
  const signals = evidence.flatMap(classify);
  const segments = buildSegments(day);
  const workItems = buildWorkItems(day);
  const episodes: ActivityEpisode[] = [];
  for (const item of evidence.filter(
    row => row.source !== 'magic-pointer-file',
  )) {
    const previous = episodes.at(-1);
    const sameWindow =
      previous &&
      appKey(previous.app) === appKey(item.app) &&
      compact(previous.title) === compact(item.title);
    if (
      sameWindow &&
      Date.parse(item.at) - Date.parse(previous.to) <= 15 * 60_000
    ) {
      previous.to = item.at;
      previous.evidenceCount++;
      previous.refs.push(...item.refs);
      if (previous.excerpts.length < 3) {
        previous.excerpts.push(compact(item.text).slice(0, 160));
      }
    } else {
      episodes.push({
        app: item.app,
        title: item.title,
        from: item.at,
        to: item.at,
        evidenceCount: 1,
        excerpts: [compact(item.text).slice(0, 160)],
        refs: [...item.refs],
        signalKinds: [],
      });
    }
  }
  for (const episode of episodes) {
    episode.signalKinds = [
      ...new Set(
        signals
          .filter(
            signal =>
              signal.at >= episode.from &&
              signal.at <= episode.to &&
              appKey(signal.app) === appKey(episode.app),
          )
          .map(signal => signal.kind),
      ),
    ];
  }
  episodes.sort(
    (left, right) =>
      right.signalKinds.length - left.signalKinds.length ||
      right.to.localeCompare(left.to),
  );

  const links = new Map<
    string,
    {url: string; appearances: number; refs: ActivitySourceRef[]}
  >();
  for (const item of evidence.filter(
    row => row.source !== 'magic-pointer-file',
  )) {
    for (const url of new Set(item.text.match(LINK) || [])) {
      const found = links.get(url) || {url, appearances: 0, refs: []};
      found.appearances++;
      found.refs.push(...item.refs);
      links.set(url, found);
    }
  }
  return {
    date: day.date,
    segments,
    workItems,
    brief: buildBrief(day, segments, workItems, signals, episodes, generatedAt),
    evidence,
    episodes,
    signals,
    repeatedLinks: [...links.values()]
      .filter(link => link.appearances > 1)
      .sort((left, right) => right.appearances - left.appearances),
    coverage: day.coverage,
    detailsCleared: day.detailsCleared === true,
  };
}

function decodeScreenpipeRows(value: unknown): ScreenpipeOcrRow[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('data' in value) ||
    !Array.isArray(value.data)
  ) {
    throw new Error('Screenpipe search response has no data array.');
  }
  return value.data.filter((row: unknown): row is ScreenpipeOcrRow => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('type' in row) ||
      row.type !== 'OCR' ||
      !('content' in row) ||
      !row.content ||
      typeof row.content !== 'object'
    ) {
      return false;
    }
    const content = row.content as Record<string, unknown>;
    return (
      typeof content.frame_id === 'number' &&
      typeof content.text === 'string' &&
      typeof content.timestamp === 'string' &&
      typeof content.app_name === 'string' &&
      typeof content.window_name === 'string'
    );
  });
}

export async function readActivitySources(options: {
  day: PersonalActivityDay;
  status: PersonalActivityStatus;
  screenpipe?: ScreenpipeOptions;
}): Promise<ActivitySourcesResult> {
  const {day, status, screenpipe} = options;
  const empty = organizeActivityEvidence(day);
  if (!screenpipe?.enabled) {
    return {
      view: empty,
      screenpipe: {
        state: 'disabled',
        usedBackend: 'none',
        queriedWindows: 0,
        acceptedRows: 0,
        omittedWindows: 0,
      },
    };
  }
  if (day.detailsCleared) {
    return {
      view: empty,
      screenpipe: {
        state: 'details-cleared',
        usedBackend: 'none',
        queriedWindows: 0,
        acceptedRows: 0,
        omittedWindows: 0,
      },
    };
  }
  if (!status.recording || !status.screenEnabled) {
    return {
      view: empty,
      screenpipe: {
        state: 'not-recording',
        usedBackend: 'none',
        queriedWindows: 0,
        acceptedRows: 0,
        omittedWindows: 0,
      },
    };
  }
  const port = screenpipe.port ?? 3030;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      view: empty,
      screenpipe: {
        state: 'error',
        usedBackend: 'none',
        queriedWindows: 0,
        acceptedRows: 0,
        omittedWindows: 0,
        error: 'Invalid Screenpipe port.',
      },
    };
  }
  const origin = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = screenpipe.apiKey
    ? {Authorization: `Bearer ${screenpipe.apiKey}`}
    : {};
  const samples = [...day.screens].sort((left, right) =>
    right.at.localeCompare(left.at),
  );
  const selected = samples.slice(0, 12);
  if (!selected.length) {
    return {
      view: empty,
      screenpipe: {
        state: 'no-anchor',
        usedBackend: 'none',
        queriedWindows: 0,
        acceptedRows: 0,
        omittedWindows: 0,
      },
    };
  }
  try {
    const health = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!health.ok) {
      throw new Error(`Screenpipe health HTTP ${health.status}`);
    }
    const windows: Array<{from: number; to: number; anchors: number}> = [];
    for (const sample of [...selected].reverse()) {
      const at = Date.parse(sample.at);
      if (!Number.isFinite(at)) {
        continue;
      }
      const previous = windows.at(-1);
      if (previous && at - 90_000 <= previous.to) {
        previous.to = Math.max(previous.to, at + 90_000);
        previous.anchors++;
      } else {
        windows.push({from: at - 90_000, to: at + 90_000, anchors: 1});
      }
    }
    const queried = windows.slice(-4);
    const responses = await Promise.all(
      queried.map(async window => {
        const params = new URLSearchParams({
          content_type: 'ocr',
          include_frames: 'false',
          include_cloud: 'false',
          limit: '30',
          start_time: new Date(window.from).toISOString(),
          end_time: new Date(window.to).toISOString(),
        });
        const response = await fetch(`${origin}/search?${params}`, {
          headers,
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) {
          throw new Error(`Screenpipe search HTTP ${response.status}`);
        }
        return decodeScreenpipeRows(await response.json());
      }),
    );
    const rows = responses.flat();
    const accepted = rows.filter(
      row => matchedSampleIndex(row.content, day.screens) >= 0,
    );
    const view = organizeActivityEvidence(day, accepted);
    return {
      view,
      screenpipe: {
        state: 'connected',
        usedBackend: 'screenpipe.local-http',
        queriedWindows: queried.length,
        acceptedRows: accepted.length,
        omittedWindows: Math.max(
          0,
          samples.length -
            queried.reduce((total, window) => total + window.anchors, 0),
        ),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      view: empty,
      screenpipe: {
        state: /fetch failed|ECONNREFUSED|ENOENT/i.test(message)
          ? 'unavailable'
          : 'error',
        usedBackend: 'screenpipe.local-http',
        queriedWindows: 0,
        acceptedRows: 0,
        omittedWindows: Math.max(0, samples.length - selected.length),
        error: message,
      },
    };
  }
}
