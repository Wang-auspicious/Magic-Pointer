import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readBrowser, readChat, readOffice, FigmaClient } from './desktop_adapters';
import { executeDesktopAction } from './desktop';
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
export class ChatReader implements SourceReader {
  constructor(private userDataDir?: string) {}
  private children = new Map<string, SourceRef[]>();
  private results = new Map<string, ReadResult>();
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
    let previous: Json[] = [],
      nativeCursor: unknown = options.cursor,
      complete = false;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      options.signal?.throwIfAborted();
      const response = await readChat(
          { ...window, hwnd: identity.windowHwnd ?? window.hwnd, cursor: nativeCursor },
          adapter,
          options.signal,
        ),
        actual = record(response.conversationIdentity);
      if (!sameConversation(identity, actual)) {
        missing.push('chat-conversation-changed');
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
            previous.slice(-size).map(messageKey),
            raw.slice(0, size).map(messageKey),
          )
        ) {
          overlap = size;
          break;
        }
      let accepted = 0;
      for (const [index, message] of raw.entries()) {
        if (
          index < overlap ||
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
              sequenceIndex: fragments.length,
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
        fragments.push(entry);
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
      pageRanges.push({
        pageIndex,
        cursor: nativeCursor ?? null,
        observed: raw.length,
        overlap,
        accepted,
      });
      previous = raw;
      missing.push(...array<string>(response.limitations));
      if (response.complete === true) {
        complete = true;
        break;
      }
      if (!options.query || !response.nextCursor) {
        if (!response.nextCursor) missing.push('visible-chat-viewport-only');
        nativeCursor = response.nextCursor;
        break;
      }
      if (!identity.nativeConversationId && !identity.accountId) {
        missing.push('ambiguous-conversation-cannot-navigate');
        break;
      }
      const verified = await readChat(
        { ...window, hwnd: identity.windowHwnd ?? window.hwnd },
        adapter,
        options.signal,
      );
      if (!sameConversation(identity, record(verified.conversationIdentity))) {
        missing.push('chat-conversation-changed');
        break;
      }
      if (response.navigation)
        await executeDesktopAction(
          'scroll',
          { ...record(response.navigation), hwnd: identity.windowHwnd ?? window.hwnd },
          options.signal,
        );
      nativeCursor = response.nextCursor;
    }
    const selected = options.query
      ? fragments.filter((item) =>
          `${item.text} ${JSON.stringify(item.metadata)}`
            .toLowerCase()
            .includes(options.query!.toLowerCase()),
        )
      : fragments;
    const result = material(source, selected, 'chat.surface', started, {
      complete,
      nextCursor: typeof nativeCursor === 'string' ? nativeCursor : null,
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
