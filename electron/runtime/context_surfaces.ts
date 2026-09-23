import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readBrowser, readChat, readOffice, FigmaClient } from './desktop_adapters';
import { delay, executeDesktopAction, listWindows, runPowerShellJson } from './desktop';
import {
  array,
  emptyRead,
  record,
  type FragmentLocator,
  type Json,
  type ReadFragment,
  type ReadOptions,
  type ReadResult,
  type SourceReader,
  type SourceRef,
} from './context';

function material(
  source: SourceRef,
  fragments: ReadFragment[],
  backend: string,
  started: number,
  options: {
    complete?: boolean;
    nextCursor?: string | null;
    missing?: string[];
    total?: number | null;
    extent?: string;
  } = {},
): ReadResult {
  const missing = options.missing?.filter(Boolean) ?? [];
  return {
    sourceId: source.sourceId,
    fragments,
    coverage: {
      extent: options.extent ?? 'document',
      readRanges: fragments.map((item) => item.locator),
      totalUnits: options.total ?? null,
      complete: options.complete === true && !missing.length && !options.nextCursor,
      nextCursor: options.nextCursor ?? null,
      missingReason: missing.join(';') || null,
    },
    evidenceStatus: missing.length ? 'degraded' : fragments.length ? 'ok' : 'empty_confirmed',
    usedBackend: backend,
    latencyMs: performance.now() - started,
  };
}
function fragment(
  source: SourceRef,
  id: string,
  locator: FragmentLocator,
  text: string,
  metadata: Json,
): ReadFragment {
  return {
    fragmentId: `fragment:${source.sourceId}:${id}`,
    locator,
    text,
    metadata: { ...metadata, sourceRevision: source.revision },
    citations: [{ sourceId: source.sourceId, locator }],
  };
}
export class BrowserContextReader implements SourceReader {
  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const started = performance.now(),
      identity = source.identity,
      epoch = String(identity.documentEpoch ?? source.revision.documentEpoch ?? '');
    if (!identity.browserInstanceId || !identity.targetId || !epoch)
      return emptyRead(
        source,
        'cdp.dom.document',
        'Browser source requires exact instance, target and document epoch',
        started,
      );
    for (const key of ['browserInstanceId', 'targetId', 'documentEpoch'])
      if (
        options.locator?.value[key] !== undefined &&
        options.locator.value[key] !== (key === 'documentEpoch' ? epoch : identity[key])
      )
        return emptyRead(source, 'cdp.dom.document', 'browser-locator-identity-mismatch', started);
    const response = await readBrowser(
      {
        ...identity,
        documentEpoch: epoch,
        locator: options.locator,
        query: options.query,
        cursor: options.cursor,
        limit: Math.min(options.limit ?? 20, 200),
      },
      options.signal,
    );
    if (
      response.browserInstanceId !== identity.browserInstanceId ||
      response.targetId !== identity.targetId ||
      response.documentEpoch !== epoch
    )
      return emptyRead(
        source,
        String(response.usedBackend),
        'browser-document-identity-changed',
        started,
      );
    const fragments = array<Json>(response.nodes).map((node, index) =>
      fragment(
        source,
        `dom:${node.nodeId ?? index}`,
        {
          kind: 'dom-node',
          value: {
            browserInstanceId: identity.browserInstanceId,
            targetId: identity.targetId,
            documentEpoch: epoch,
            nodeId: node.nodeId,
            selector: node.selector,
            ...('characterStart' in node
              ? { characterStart: node.characterStart, characterEnd: node.characterEnd }
              : {}),
          },
        },
        String(node.text ?? ''),
        { ...node, pageTitle: response.title, pageUrl: response.url },
      ),
    );
    return material(
      source,
      fragments,
      String(response.usedBackend ?? 'cdp.dom.document'),
      started,
      {
        complete: response.complete === true,
        nextCursor: response.nextCursor ?? null,
        missing: array<string>(response.limitations),
        total: Number(response.totalUnits) || null,
        extent: options.query ? 'query-results' : 'document',
      },
    );
  }
}
const identityFields = [
  'adapterId',
  'accountId',
  'accountKey',
  'nativeConversationId',
  'conversationKey',
  'windowHwnd',
  'processId',
  'title',
  'type',
];
function sameConversation(expected: Json, current: Json): boolean {
  return identityFields.every(
    (key) =>
      expected[key] === undefined ||
      expected[key] === null ||
      expected[key] === '' ||
      String(expected[key]) === String(current[key]),
  );
}
function messageKey(message: Json): unknown {
  return message.nativeMessageId
    ? ['native', message.nativeMessageId]
    : [
        message.speaker ?? '',
        message.time ?? '',
        message.text ?? '',
        message.replyTo ?? '',
        array<Json>(message.attachments).map(
          (attachment) =>
            attachment.nativeAttachmentId ?? [
              attachment.name,
              attachment.versionLabel,
              attachment.absolutePath,
              attachment.url,
              attachment.size,
            ],
        ),
      ];
}
interface ChatHistoryIO {
  readPage(window: Json, adapter: string, signal?: AbortSignal): Promise<Json>;
  navigate(window: Json, identity: Json, cursor: string, signal?: AbortSignal): Promise<Json>;
}
async function navigateChatHistory(window: Json, identity: Json, _cursor: string, signal?: AbortSignal): Promise<Json> {
  const hwnd = Number(identity.windowHwnd);
  if (!identity.nativeConversationId || !Number.isSafeInteger(hwnd) || hwnd <= 0 || hwnd !== Number(window.hwnd))
    return { ok: false, error: 'bound-chat-window-identity-mismatch' };
  const sessionId = 'chat-history';
  try {
    const activated = await executeDesktopAction('activate_window', { window_id: `w-${hwnd}`, sessionId }, signal);
    if (activated.ok !== true) return { ok: false, error: 'bound-chat-window-not-active', receipt: activated };
    const state = await executeDesktopAction('get_app_state', { window_id: `w-${hwnd}`, mode: 'full', sessionId }, signal);
    const live = record(state.window), bounds = array<number>(live.bbox);
    if (Number(live.hwnd) !== hwnd ||
      (identity.processId && Number(live.pid) !== Number(identity.processId)) ||
      (identity.title && String(live.title) !== String(identity.title)))
      return { ok: false, error: 'bound-chat-window-changed' };
    if (bounds.length !== 4 || bounds[2]! <= bounds[0]! || bounds[3]! <= bounds[1]!)
      return { ok: false, error: 'bound-chat-window-bounds-unavailable' };
    const receipt = await executeDesktopAction('scroll', {
      sessionId, snapshot_id: state.snapshot_id,
      x: Math.floor((bounds[0]! + bounds[2]!) / 2), y: Math.floor((bounds[1]! + bounds[3]!) / 2),
      dx: 0, dy: 720,
    }, signal);
    if (receipt.ok !== true) return { ok: false, error: 'chat-scroll-not-acknowledged', receipt };
    await delay(120, signal);
    return { ok: true, receipt, usedBackend: receipt.usedBackend ?? 'native_desktop.scroll' };
  } catch (error) {
    signal?.throwIfAborted();
    return { ok: false, error: `chat-scroll-failed:${error instanceof Error ? error.message : String(error)}` };
  }
}
export class ChatReader implements SourceReader {
  constructor(private userDataDir?: string, private io: ChatHistoryIO = { readPage: readChat, navigate: navigateChatHistory }) {}
  private children = new Map<string, SourceRef[]>();
  private results = new Map<string, ReadResult>();
  private continuationPages = new Map<string, Json[]>();
  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const started = performance.now(),
      identity = record(source.identity.conversationIdentity),
      window = record(source.identity.window),
      adapter = String(identity.adapterId ?? '');
    if (!adapter || (!identity.conversationKey && !identity.nativeConversationId))
      return emptyRead(source, 'chat.surface', 'chat-conversation-identity-required', started);
    const cursor = /^chat-results:([^:]+):(\d+)$/.exec(options.cursor ?? '');
    if (cursor) {
      const result = this.results.get(cursor[1]!);
      if (!result || result.sourceId !== source.sourceId)
        throw new Error('Chat continuation expired');
      return this.page(result, cursor[1]!, Number(cursor[2]), options.limit ?? 20);
    }
    const fragments: ReadFragment[] = [],
      seen = new Set<string>(),
      pageRanges: Json[] = [],
      missing: string[] = [];
    let previous: Json[] = options.cursor ? this.continuationPages.get(`${source.sourceId}:${options.cursor}`) ?? [] : [],
      nativeCursor = options.cursor ?? null,
      nextCursor: string | null = null,
      complete = false;
    if (nativeCursor && !/^older:[1-9]\d*$/.test(nativeCursor)) throw new Error('Invalid chat history cursor');
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      options.signal?.throwIfAborted();
      const boundWindow = { ...window, hwnd: identity.windowHwnd ?? window.hwnd,
        nativeConversationId: identity.nativeConversationId ?? window.nativeConversationId,
        accountKey: identity.accountKey ?? window.accountKey };
      let navigationReceipt: Json | null = null;
      if (nativeCursor) {
        if (!identity.nativeConversationId) {
          missing.push('ambiguous-conversation-cannot-navigate');
          break;
        }
        const verified = await this.io.readPage(boundWindow, adapter, options.signal);
        if (!sameConversation(identity, record(verified.conversationIdentity))) {
          missing.push('chat-conversation-changed');
          break;
        }
        if (typeof verified.nextCursor !== 'string') {
          missing.push('ambiguous-conversation-cannot-navigate');
          break;
        }
        const visible = array<Json>(verified.messages).map(message => ({ ...message, ...record(message.fields) }));
        if (previous.length && !isDeepStrictEqual(previous.map(messageKey), visible.map(messageKey))) {
          missing.push('chat-history-cursor-stale');
          break;
        }
        const navigation = await this.io.navigate(boundWindow, identity, nativeCursor, options.signal);
        if (navigation.ok !== true || record(navigation.receipt).ok !== true) {
          missing.push(String(navigation.error ?? 'chat-scroll-not-acknowledged'));
          nextCursor = nativeCursor;
          break;
        }
        navigationReceipt = record(navigation.receipt);
      }
      const response = await this.io.readPage(
          { ...boundWindow, cursor: nativeCursor }, adapter, options.signal,
        ),
        actual = record(response.conversationIdentity);
      if (!sameConversation(identity, actual)) {
        missing.push('chat-conversation-changed');
        nextCursor = null;
        break;
      }
      const messages = array<Json>(response.messages).map((message) => ({
          ...message,
          ...record(message.fields),
        })),
        raw = messages.length
          ? messages
          : array<Json>(response.objects)
              .filter(
                (item) =>
                  ['message', 'chat_message'].includes(String(item.kind)) ||
                  item.objectType === 'message',
              )
              .map((message) => ({ ...message, ...record(message.fields) }));
      let overlap = 0;
      for (let size = Math.min(previous.length, raw.length); size > 0; size--)
        if (
          isDeepStrictEqual(
            raw.slice(-size).map(messageKey),
            previous.slice(0, size).map(messageKey),
          )
        ) {
          overlap = size;
          break;
      }
      if (previous.length && raw.length && overlap === raw.length) {
        pageRanges.push({ pageIndex, cursor: nativeCursor, observed: raw.length, overlap, accepted: 0,
          usedBackend: response.usedBackend ?? 'chat.surface', navigationReceipt });
        missing.push('history-boundary-uncertain-identical-page');
        nextCursor = null;
        break;
      }
      let accepted = 0;
      const pageFragments: ReadFragment[] = [];
      for (const [index, message] of raw.entries()) {
        if (
          index >= raw.length - overlap ||
          (message.nativeMessageId && seen.has(String(message.nativeMessageId)))
        )
          continue;
        if (message.nativeMessageId) seen.add(String(message.nativeMessageId));
        accepted++;
        const token = String(
            message.nativeMessageId ?? message.visibleObjectId ?? `${pageIndex}-${index}`,
          ),
          locator: FragmentLocator = {
            kind: 'message',
            value: {
              adapterId: adapter,
              conversationKey: identity.conversationKey,
              nativeMessageId: message.nativeMessageId ?? null,
              sequenceIndex: 0,
              pageIndex,
              visibleObjectId: message.visibleObjectId ?? null,
            },
          },
          entry = fragment(
            source,
            `message:${token}`,
            locator,
            String(message.text ?? message.content ?? ''),
            { ...message, messageIdProvenance: message.nativeMessageId ? 'native' : 'unavailable' },
          );
        pageFragments.push(entry);
        const rawAttachments = array<Json>(message.attachments);
        if (this.userDataDir)
          for (const attachment of rawAttachments)
            if (!attachment.absolutePath && attachment.name) {
              const { locateChatFile } = require('./context_chat_files') as typeof import('./context_chat_files');
              attachment.localCandidates = await locateChatFile(
                String(window.process_name ?? window.processName ?? adapter),
                String(attachment.name),
                this.userDataDir,
              );
              attachment.localCandidateProvenance = 'filename-match-unverified';
            }
        const attachments = rawAttachments.map((attachment, ordinal): SourceRef => ({
          sourceId: `source:chat-attachment:${source.sourceId}:${token}:${attachment.nativeAttachmentId ?? ordinal}`,
          taskId: source.taskId,
          kind: 'file',
          title: String(attachment.name ?? 'Attachment'),
          identity: {
            ...attachment,
            chatSourceId: source.sourceId,
            messageFragmentId: entry.fragmentId,
            attachmentOrdinal: ordinal,
            ...(!attachment.absolutePath && attachment.url
              ? { downloadState: 'requires-download' }
              : {}),
          },
          revision: { versionLabel: attachment.versionLabel, size: attachment.size },
          capabilities: attachment.absolutePath ? ['read', 'search', 'follow'] : ['follow'],
          origin: 'task-discovered',
          parentSourceId: source.sourceId,
        }));
        this.children.set(entry.fragmentId, attachments);
      }
      if (pageIndex === 0) fragments.push(...pageFragments);
      else fragments.unshift(...pageFragments);
      pageRanges.push({
        pageIndex,
        cursor: nativeCursor ?? null,
        observed: raw.length,
        overlap,
        accepted,
        usedBackend: response.usedBackend ?? 'chat.surface',
        ...(navigationReceipt ? { navigationReceipt } : {}),
      });
      previous = raw;
      missing.push(...array<string>(response.limitations));
      nextCursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
      if (nextCursor) {
        this.continuationPages.set(`${source.sourceId}:${nextCursor}`, raw);
        if (this.continuationPages.size > 32) this.continuationPages.delete(this.continuationPages.keys().next().value!);
      }
      if (response.complete === true) {
        complete = true;
        nextCursor = null;
        break;
      }
      if (!nextCursor) {
        missing.push('visible-chat-viewport-only');
        break;
      }
      if (!identity.nativeConversationId) {
        missing.push('ambiguous-conversation-cannot-navigate');
        nextCursor = null;
        break;
      }
      if (!options.query) break;
      nativeCursor = nextCursor;
      if (pageIndex === 99) missing.push('chat-history-page-limit');
    }
    fragments.forEach((item, index) => { item.locator.value.sequenceIndex = index; });
    const selected = options.query
      ? fragments.filter((item) =>
          `${item.text} ${JSON.stringify(item.metadata)}`
            .toLowerCase()
            .includes(options.query!.toLowerCase()),
        )
      : fragments;
    const backends = [...new Set(pageRanges.flatMap(page => [page.usedBackend, record(page.navigationReceipt).usedBackend])
      .filter(value => typeof value === 'string' && value))];
    const result = material(source, selected, backends.join('+') || 'chat.surface', started, {
      complete,
      nextCursor,
      missing: [...new Set(missing)],
      total: complete ? fragments.length : null,
      extent: options.query ? 'query-results' : 'document',
    });
    result.structure = { pages: pageRanges };
    const key = randomUUID();
    this.results.set(key, result);
    if (this.results.size > 8) this.results.delete(this.results.keys().next().value!);
    return this.page(result, key, 0, options.limit ?? 20);
  }
  private page(result: ReadResult, key: string, offset: number, limit: number): ReadResult {
    const end = Math.min(result.fragments.length, offset + Math.max(1, limit)),
      more = end < result.fragments.length;
    return {
      ...result,
      fragments: result.fragments.slice(offset, end),
      coverage: {
        ...result.coverage,
        complete: result.coverage.complete && !more,
        nextCursor: more ? `chat-results:${key}:${end}` : result.coverage.nextCursor,
      },
    };
  }
  async follow(source: SourceRef, fragmentId: string): Promise<SourceRef[]> {
    return (this.children.get(fragmentId) ?? []).filter(
      (child) => child.parentSourceId === source.sourceId,
    );
  }
}
export class FigmaReader implements SourceReader {
  constructor(private connections: Json[]) {}
  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const started = performance.now(),
      connection = this.connections.find(
        (item) =>
          item.taskId === source.taskId &&
          item.documentSessionId === source.identity.documentSessionId,
      );
    if (!connection)
      return emptyRead(
        source,
        'figma.plugin',
        'figma-current-document-connection-required',
        started,
      );
    const client = new FigmaClient(connection),
      nodeId = options.locator?.value.nodeId ?? source.identity.nodeId,
      response = await client.request(
        nodeId ? 'read_nodes' : 'read_selection',
        nodeId ? { nodeIds: [nodeId] } : {},
        options.signal,
      ),
      fragments = array<Json>(response.nodes)
        .filter(
          (node) =>
            !options.query ||
            JSON.stringify(node).toLowerCase().includes(options.query.toLowerCase()),
        )
        .map((node) =>
          fragment(
            source,
            `figma:${node.id}`,
            {
              kind: 'figma-node',
              value: { nodeId: node.id, documentSessionId: source.identity.documentSessionId },
            },
            String(node.characters ?? node.name ?? ''),
            node,
          ),
        );
    return material(source, fragments, 'figma.plugin', started, {
      complete: response.complete === true,
      missing: array<string>(response.limitations),
      total: fragments.length,
    });
  }
}
export async function readLiveOffice(
  source: SourceRef,
  options: ReadOptions,
): Promise<ReadResult | null> {
  if (!source.identity.hwnd) return null;
  const started = performance.now(),
    window = {
      ...record(source.identity.window),
      hwnd: source.identity.hwnd,
      process_name: source.identity.processName ?? source.identity.process_name,
      title: source.title,
    };
  const response = await readOffice(window, { signal: options.signal });
  if (!response.content || response.error) return null;
  const identity = record(response.artifacts.source_identity),
    expected = String(source.identity.absolutePath ?? source.identity.path ?? '').toLowerCase();
  if (
    expected &&
    String(identity.absolutePath ?? response.artifacts.document ?? '').toLowerCase() !== expected
  )
    return emptyRead(source, response.method, 'live-office-document-identity-changed', started);
  if (options.locator) return null;
  const locator = array<FragmentLocator>(response.artifacts.locators)[0] ?? {
      kind: 'text',
      value: { story: 'selection', hwnd: source.identity.hwnd },
    },
    selected =
      !options.query || response.content.toLowerCase().includes(options.query.toLowerCase());
  return material(
    source,
    selected
      ? [
          fragment(source, 'live-selection', locator, response.content, {
            ...response.artifacts,
            live: true,
          }),
        ]
      : [],
    response.method,
    started,
    {
      complete: false,
      extent: 'selection',
      missing: ['live-selection-only; disk-document-is-a-separate-revision'],
    },
  );
}

async function probeCurrentWord(source: SourceRef, signal?: AbortSignal): Promise<Json> {
  const hwnd = Number(source.identity.hwnd),
    pid = Number(source.identity.pid),
    document = String(source.identity.documentPath ?? source.identity.absolutePath ?? '');
  const window = (await listWindows(signal)).find((item) => Number(item.hwnd) === hwnd);
  if (!window || Number(window.pid) !== pid)
    return { ok: false, error: 'word-window-identity-changed' };
  const encoded = Buffer.from(JSON.stringify({ hwnd, document })).toString('base64');
  return runPowerShellJson(String.raw`
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
$win=@($app.Windows) | Where-Object { [int64]$_.Hwnd -eq [int64]$p.hwnd } | Select-Object -First 1
if($null -eq $win){throw 'bound_word_window_not_found'}
$doc=$win.Document
if(-not [string]::Equals([string]$doc.FullName,[string]$p.document,[StringComparison]::OrdinalIgnoreCase)){throw 'bound_word_document_changed'}
$items=New-Object 'System.Collections.Generic.List[object]'
$cellParagraphs=@{}
$bodyIndex=0; $tableIndex=-1; $lastTableStart=-1; $tableBodyIndex=-1; $tableCells=@()
$paragraphs=$doc.Content.Paragraphs
for($i=1;$i -le [int]$paragraphs.Count;$i++){
 $paragraph=$paragraphs.Item($i); $range=$paragraph.Range
 $text=([string]$range.Text).TrimEnd([char[]]@(13,7))
 $start=[int]$range.Start; $end=$start+$text.Length
 if([int]$range.Tables.Count -gt 0){
  $table=$range.Tables.Item(1); $tableStart=[int]$table.Range.Start
  if($tableStart -ne $lastTableStart){
   $tableIndex++;$tableBodyIndex=$bodyIndex;$bodyIndex++;$lastTableStart=$tableStart
   $tableCells=@()
   for($c=1;$c -le [int]$table.Range.Cells.Count;$c++){
    $candidate=$table.Range.Cells.Item($c)
    $tableCells+=@{start=[int]$candidate.Range.Start;end=[int]$candidate.Range.End;rowIndex=([int]$candidate.RowIndex-1);columnIndex=([int]$candidate.ColumnIndex-1)}
   }
  }
  $cell=$null
  foreach($candidate in $tableCells){if($start -ge $candidate.start -and [int]$range.End -le $candidate.end){$cell=$candidate;break}}
  if($null -eq $cell){if($text){throw 'word_table_paragraph_cell_unresolved'};continue}
  $cellKey=[string]$cell.start
  $cellParagraphIndex=[int]$cellParagraphs[$cellKey];$cellParagraphs[$cellKey]=$cellParagraphIndex+1
  if($text){[void]$items.Add(@{text=$text;start=$start;end=$end;bodyIndex=$tableBodyIndex;tableIndex=$tableIndex;rowIndex=$cell.rowIndex;columnIndex=$cell.columnIndex;paragraphIndex=$cellParagraphIndex})}
 } else {
  $lastTableStart=-1
  if($text){[void]$items.Add(@{text=$text;start=$start;end=$end;bodyIndex=$bodyIndex})}
  $bodyIndex++
 }
}
for($sectionIndex=1;$sectionIndex -le [int]$doc.Sections.Count;$sectionIndex++){
 $section=$doc.Sections.Item($sectionIndex)
 foreach($story in @('header','footer')){
  for($variantIndex=1;$variantIndex -le 3;$variantIndex++){
   if($story -eq 'header'){$part=$section.Headers.Item($variantIndex)}
   else {$part=$section.Footers.Item($variantIndex)}
   if(-not [bool]$part.Exists){continue}
   $storyParagraphs=$part.Range.Paragraphs
   for($paragraphIndex=1;$paragraphIndex -le [int]$storyParagraphs.Count;$paragraphIndex++){
    $storyRange=$storyParagraphs.Item($paragraphIndex).Range
    $storyText=([string]$storyRange.Text).TrimEnd([char[]]@(13,7))
    if($storyText){[void]$items.Add(@{text=$storyText;start=[int]$storyRange.Start;end=([int]$storyRange.Start+$storyText.Length);story=$story;sectionIndex=($sectionIndex-1);variantIndex=$variantIndex;paragraphIndex=($paragraphIndex-1)})}
   }
  }
 }
}
@{ok=$true;hwnd=[int64]$win.Hwnd;pid=${pid};document=[string]$doc.FullName;documentSaved=[bool]$doc.Saved;paragraphs=@($items.ToArray());bodyItems=$bodyIndex} | ConvertTo-Json -Depth 16 -Compress`, signal, 60000);
}

export class WordLiveReader implements SourceReader {
  constructor(private probe: (source: SourceRef, signal?: AbortSignal) => Promise<Json> = probeCurrentWord) {}
  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const started = performance.now(),
      backend = 'office.com.word.current',
      expectedHwnd = Number(source.identity.hwnd),
      expectedPid = Number(source.identity.pid),
      expectedDocument = String(source.identity.documentPath ?? source.identity.absolutePath ?? '');
    if (!Number.isSafeInteger(expectedHwnd) || expectedHwnd <= 0 ||
      !Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !expectedDocument)
      return emptyRead(source, backend, 'word-live-source-identity-incomplete', started);
    let response: Json;
    try {
      response = await this.probe(source, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      return emptyRead(source, backend, `word-live-read-failed:${String(error)}`, started);
    }
    if (response.ok !== true) return emptyRead(source, backend, String(response.error ?? 'word-live-read-failed'), started);
    if (Number(response.hwnd) !== expectedHwnd || Number(response.pid) !== expectedPid ||
      String(response.document ?? '').toLowerCase() !== expectedDocument.toLowerCase())
      return emptyRead(source, backend, 'word-live-document-identity-changed', started);
    const all = array<Json>(response.paragraphs).map((item, index) => {
      const story = item.story === 'header' || item.story === 'footer' ? item.story : 'body',
        table = story === 'body' && Number.isInteger(item.tableIndex) &&
          Number.isInteger(item.rowIndex) && Number.isInteger(item.columnIndex),
        locator: FragmentLocator = { kind: table ? 'table-cell' : 'text', value: story === 'body' ? {
          story, start: Number(item.start), end: Number(item.end), bodyIndex: Number(item.bodyIndex),
          ...(table ? { tableIndex: Number(item.tableIndex), rowIndex: Number(item.rowIndex),
            columnIndex: Number(item.columnIndex), paragraphIndex: Number(item.paragraphIndex) } : {}),
        } : {
          story, start: Number(item.start), end: Number(item.end),
          sectionIndex: Number(item.sectionIndex), variantIndex: Number(item.variantIndex),
          paragraphIndex: Number(item.paragraphIndex),
        } };
      return fragment(source, `word:${index}`, locator, String(item.text ?? ''), {
        live: true, documentSaved: response.documentSaved === true,
        ...locator.value,
      });
    });
    let units = all;
    if (options.query) units = units.filter((item) => item.text.toLowerCase().includes(options.query!.toLowerCase()));
    else if (options.locator) {
      const match = all.findIndex((item) => isDeepStrictEqual(item.locator, options.locator));
      if (match < 0) return emptyRead(source, backend, 'word-live-locator-stale', started);
      units = all.slice(Math.max(0, match - 1), match + 2);
    }
    const prefix = options.query ? 'word-match' : options.locator ? 'word-neighborhood' : 'word-unit';
    const cursor = options.cursor ? new RegExp(`^${prefix}:(\\d+)$`).exec(options.cursor) : null;
    if (options.cursor && !cursor) throw new Error('Invalid Word document cursor');
    const offset = Number(cursor?.[1] ?? 0),
      selected: ReadFragment[] = [];
    let size = 0;
    for (const item of units.slice(offset, offset + Math.max(1, Math.min(options.limit ?? 20, 1000)))) {
      if (size && size + item.text.length > 48000) break;
      size += item.text.length;
      selected.push(item);
    }
    const end = offset + selected.length,
      nextCursor = end < units.length ? `${prefix}:${end}` : null;
    const result = material(source, selected, backend, started, {
      complete: true, nextCursor, total: all.length,
      extent: options.query ? 'query-results' : options.locator ? 'neighborhood' : 'document',
    });
    result.structure = { kind: 'docx', readFrom: 'live', document: expectedDocument,
      documentSaved: response.documentSaved === true, bodyItems: Number(response.bodyItems) || null };
    return result;
  }
}
