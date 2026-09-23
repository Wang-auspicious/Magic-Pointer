import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream, StandardFonts } from 'pdf-lib';
import { createOfficeFile, DocumentOperationBackend } from '../electron/runtime/actions';
import { DocumentReader, xmlChildren, xmlFind, xmlText, zipXml } from '../electron/runtime/context_documents';
import { ExcelLiveReader } from '../electron/runtime/context_excel_live';
import { PowerPointLiveReader } from '../electron/runtime/context_powerpoint_live';
import {
  fileSource,
  registerSource,
  authorizeAccess,
  scopeFromEvents,
  updateContext,
  resolveSource,
  type ReadResult,
} from '../electron/runtime/context';
import {
  createArtifact,
  patchArtifact,
  handleArtifact,
  type PatchOperation,
} from '../electron/runtime/artifacts';
import { EventSession } from '../electron/runtime/session';
import { SkillCandidateStore } from '../electron/runtime/context_skill_candidates';
import { ContextSessionStore, compileContextPrompt } from '../electron/runtime/context_sessions';
import { AgentContextHandoffStore } from '../electron/runtime/context_handoff';
import { ScreenMemory, ClipboardHistory } from '../electron/runtime/context_memory';
import { FrozenSelectionReader } from '../electron/runtime/context';
import { registerMemoryTools } from '../electron/runtime/agent_services';
import { ToolRegistry } from '../electron/runtime/tools';
import { prepareTaskContext } from '../electron/runtime/context_prepare';
import { WordLiveReader } from '../electron/runtime/context_surfaces';

test('Recall searches retained screen evidence alongside session history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-recall-'));
  const memory = new ScreenMemory(join(root, 'screen-memory.json'), true);
  await memory.record({ excerpt: 'Observed material', sourceId: 'source', locator: { kind: 'text', value: {} } });
  const history = await EventSession.open(root, 'recall-history');
  await history.append('observation', { text: 'Observed material in session' });
  const session = await EventSession.open(root, 'recall-current');
  const registry = new ToolRegistry();
  registerMemoryTools(registry, root, session);
  const args = { query: 'Observed material' };
  const denied = await registry.execute({ id: 'unapproved-recall', name: 'Recall', arguments: args });
  assert.equal(denied.failure_type, 'permission_denied');
  const requestId = 'recall-approval';
  await session.append('permission/requested', { requestId, pendingInput: {
    requestId, kind: 'permission', tool: 'Recall', harnessPermission: true,
    action: { tool: 'Recall', arguments: args },
  } });
  await session.answer(requestId, { decision: 'once' });
  await session.append('operation/prepared', {
    operationId: 'recall-approved', callId: `approval-${requestId}`, name: 'Recall',
    arguments: args, effect: 'read', dispatched: true,
  });
  const result = await registry.execute({ id: `approval-${requestId}`, name: 'Recall', arguments: args });
  assert.equal(result.is_error, false, result.error_message);
  assert.ok((result.value as { matches: { sessionId: string }[] }).matches.some(item => item.sessionId === 'recall-history'));
  assert.ok((result.value as { screenEvidence: { excerpt: string }[] }).screenEvidence.some(item => item.excerpt === 'Observed material'));
});

test('pointing at a window grants actions to that window only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-pointed-window-'));
  const session = await EventSession.open(root, 'pointed-window');
  await prepareTaskContext(session, { selectionSnapshot: { snapshot_id: 'pointed', context: { app: 'notepad', content: 'Selected text', window: { hwnd: 42, pid: 7, title: 'Notes', process_name: 'notepad' } } } },
    { root, userDataDir: root, registry: new ToolRegistry() });
  const scope = scopeFromEvents(session.events, session.id);
  assert.equal(authorizeAccess(scope, { action: 'patch', windowIds: ['w-42'] }).allowed, true);
  assert.equal(authorizeAccess(scope, { action: 'patch', windowIds: ['w-43'] }).allowed, false);
});

test('Knowledge tools stay within attached saved material and current folder grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-knowledge-scope-'));
  const stash = join(root, 'stash'), otherFolder = join(root, 'other'), liveFolder = join(root, 'live');
  await Promise.all([mkdir(stash), mkdir(otherFolder), mkdir(liveFolder)]);
  const retained = join(stash, 'selected.txt'), live = join(liveFolder, 'selected.txt'), other = join(otherFolder, 'private.txt');
  await Promise.all([
    writeFile(retained, 'Saved selected material'),
    writeFile(live, 'Changed live material outside this task'),
    writeFile(other, 'Unselected private material'),
  ]);
  await writeFile(join(stash, 'index.json'), JSON.stringify([
    { id: 'selected', sourceId: 'history-selected', desc: 'Selected note', summary: 'Saved selected material', originalArtifactPath: live, relPath: 'selected.txt' },
    { id: 'other', sourceId: 'history-other', desc: 'Private note', summary: 'Unselected private material', originalArtifactPath: other },
  ]));
  const session = await EventSession.open(root, 'knowledge-scope'), registry = new ToolRegistry();
  await prepareTaskContext(session, { attachments: [retained] }, { root, userDataDir: root, registry });
  const search = await registry.execute({ id: 'search', name: 'Knowledge.search', arguments: { query: '' } });
  assert.equal(search.is_error, false, search.error_message);
  assert.deepEqual((search.value as { entryId: string }[]).map(item => item.entryId), ['selected']);
  const denied = await registry.execute({ id: 'denied', name: 'Knowledge.read', arguments: { entry_id: 'other' } });
  assert.equal(denied.failure_type, 'permission_denied');
  const selected = await registry.execute({ id: 'selected', name: 'Knowledge.read', arguments: { entry_id: 'selected' } });
  assert.equal(selected.is_error, false, selected.error_message);
  const selectedSource = (selected.value as { source: { sourceId: string; origin: string; identity: { absolutePath: string } } }).source;
  assert.equal(selectedSource.identity.absolutePath, retained);
  assert.equal(selectedSource.origin, 'task-discovered');
  const selectedRead = await registry.execute({ id: 'selected-read', name: 'Context.read', arguments: { source_id: selectedSource.sourceId } });
  assert.equal(selectedRead.is_error, false, selectedRead.error_message);
  assert.match(JSON.stringify(selectedRead.value), /Saved selected material/);
  assert.doesNotMatch(JSON.stringify(selectedRead.value), /Changed live material/);

  await updateContext(session, { scopeGrants: [{
    grantId: 'current-folder-read', taskId: session.id, sourceIds: [], folderRoots: [otherFolder],
    windowIds: [], recipients: [], actions: ['read'], expiresAtMs: null,
  }] });
  const grantedSearch = await registry.execute({ id: 'granted-search', name: 'Knowledge.search', arguments: { query: '' } });
  assert.equal(grantedSearch.is_error, false, grantedSearch.error_message);
  assert.deepEqual((grantedSearch.value as { entryId: string }[]).map(item => item.entryId), ['selected', 'other']);
  const granted = await registry.execute({ id: 'granted', name: 'Knowledge.read', arguments: { entry_id: 'other' } });
  assert.equal(granted.is_error, false, granted.error_message);
  const grantedSourceId = (granted.value as { source: { sourceId: string } }).source.sourceId;
  const grantedRead = await registry.execute({ id: 'granted-read', name: 'Context.read', arguments: { source_id: grantedSourceId } });
  assert.equal(grantedRead.is_error, false, grantedRead.error_message);
  assert.match(JSON.stringify(grantedRead.value), /Unselected private material/);
  await updateContext(session, { scopeRevocations: ['current-folder-read'] });
  const revoked = await registry.execute({ id: 'revoked', name: 'Context.read', arguments: { source_id: grantedSourceId } });
  assert.equal(revoked.failure_type, 'permission_denied');
});

test('DailyWrap reads only the exact user-approved history range and conversation set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-daily-wrap-scope-'));
  await mkdir(join(root, 'history'));
  await writeFile(join(root, 'history', 'conversations.json'), JSON.stringify([
    { id: 'selected', title: 'Selected task', turns: [{ id: 'selected-turn', startedAt: 1500, completedAt: 1600, question: 'Selected question', answer: 'Selected answer' }] },
    { id: 'private', title: 'Private task', turns: [{ id: 'private-turn', startedAt: 1500, completedAt: 1600, question: 'Private question', answer: 'Private answer' }] },
  ]));
  const session = await EventSession.open(root, 'daily-wrap-scope'), registry = new ToolRegistry();
  await prepareTaskContext(session, {}, { root, userDataDir: root, registry });
  const args = { from_ms: 1000, to_ms: 2000, conversation_ids: ['selected'] };
  const requestedArgs = { from_ms: 0, to_ms: 3000, conversation_ids: [] as string[] };
  const direct = await registry.execute({ id: 'unapproved', name: 'DailyWrap.read', arguments: args });
  assert.equal(direct.failure_type, 'permission_denied');
  const requestId = 'daily-wrap-approval';
  await session.append('permission/requested', { requestId, pendingInput: {
    requestId, kind: 'permission', tool: 'DailyWrap.read', question: 'Allow DailyWrap.read?',
    harnessPermission: true, action: { tool: 'DailyWrap.read', arguments: requestedArgs },
  } });
  await session.answer(requestId, { decision: 'once', actionArguments: args });
  const callId = `approval-${requestId}`;
  assert.deepEqual(session.approvedCalls().map(call => call.arguments), [args]);
  const beforeDispatch = await registry.execute({ id: callId, name: 'DailyWrap.read', arguments: args });
  assert.equal(beforeDispatch.failure_type, 'permission_denied');
  await session.append('operation/prepared', { operationId: 'daily-wrap-read', callId, name: 'DailyWrap.read', arguments: args, effect: 'read', dispatched: true });
  const originalScope = await registry.execute({ id: callId, name: 'DailyWrap.read', arguments: requestedArgs });
  assert.equal(originalScope.failure_type, 'permission_denied');
  const changedTarget = await registry.execute({ id: callId, name: 'DailyWrap.read', arguments: { ...args, conversation_ids: ['private'] } });
  assert.equal(changedTarget.failure_type, 'permission_denied');
  const approved = await registry.execute({ id: callId, name: 'DailyWrap.read', arguments: args });
  assert.equal(approved.is_error, false, approved.error_message);
  const values = approved.value as { events: { conversationId: string; answer: string }[] };
  assert.deepEqual(values.events.map(event => event.conversationId), ['selected']);
  assert.equal(values.events[0]?.answer, 'Selected answer');
  await session.append('operation/settled', { operationId: 'daily-wrap-read', outcome: 'succeeded', message: {
    role: 'tool', tool_call_id: callId, name: 'DailyWrap.read', content: JSON.stringify(approved.value), origin: 'data',
  } });
  const replay = await registry.execute({ id: callId, name: 'DailyWrap.read', arguments: args });
  assert.equal(replay.failure_type, 'permission_denied');
});

test('an attached folder searches nested Office content and follows the actual child source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-nested-material-search-'));
  const materials = join(root, 'materials');
  const nested = join(materials, '2026', 'contracts');
  await mkdir(nested, { recursive: true });
  const documentPath = join(nested, 'agreement.docx');
  await createOfficeFile({
    operationId: 'create-nested-agreement', operation: 'create_file',
    sourceId: 'directory', referenceId: 'reference',
    locator: { kind: 'directory', value: { path: nested } },
    before: { path: documentPath, exists: false },
    after: { path: documentPath, exists: true, format: 'docx', content: { paragraphs: ['Nimbus renewal value is 731.'] } },
  });
  await writeFile(join(nested, 'supplement.txt'), 'Nimbus renewal appendix.');
  await writeFile(join(root, 'private.txt'), 'Nimbus renewal value is 731.');
  const session = await EventSession.open(root, 'nested-material-search');
  const registry = new ToolRegistry();
  await prepareTaskContext(session, { attachments: [materials] }, { root, userDataDir: root, registry });
  const search = await registry.execute({ id: 'nested-search', name: 'Context.search', arguments: { query: 'Nimbus renewal', limit: 10 } });
  assert.equal(search.is_error, false, search.error_message);
  const result = search.value as { results: { source: { sourceId: string }; fragments: { fragmentId: string; text: string; metadata: { relativePath?: string } }[]; coverage: { complete: boolean } }[] };
  const folderResult = result.results.find(item => item.fragments.some(fragment => fragment.text.includes('Nimbus renewal')))!;
  const hit = folderResult.fragments.find(fragment => fragment.metadata.relativePath === join('2026', 'contracts', 'agreement.docx'))!;
  assert.ok(hit, JSON.stringify(result));
  assert.equal(folderResult.coverage.complete, false);
  assert.match(String((folderResult.coverage as { missingReason?: string }).missingReason), /child-evidence-incomplete/);
  assert.equal(JSON.stringify(result).includes('private.txt'), false);
  const firstPage = await registry.execute({ id: 'nested-page-1', name: 'Context.search', arguments: { source_id: folderResult.source.sourceId, query: 'Nimbus renewal', limit: 1 } });
  assert.equal(firstPage.is_error, false, firstPage.error_message);
  const firstResult = (firstPage.value as typeof result).results[0]!;
  assert.equal(firstResult.fragments.length, 1);
  const cursor = (firstResult.coverage as { nextCursor?: string }).nextCursor;
  assert.ok(cursor);
  const secondPage = await registry.execute({ id: 'nested-page-2', name: 'Context.search', arguments: { source_id: folderResult.source.sourceId, query: 'Nimbus renewal', cursor, limit: 1 } });
  assert.equal(secondPage.is_error, false, secondPage.error_message);
  const secondResult = (secondPage.value as typeof result).results[0]!;
  assert.equal(secondResult.fragments[0]?.metadata.relativePath, join('2026', 'contracts', 'supplement.txt'));
  assert.equal(secondResult.coverage.complete, true);
  const follow = await registry.execute({ id: 'nested-follow', name: 'Context.follow', arguments: { source_id: folderResult.source.sourceId, fragment_id: hit.fragmentId } });
  assert.equal(follow.is_error, false, follow.error_message);
  const child = (follow.value as { sources: { sourceId: string; identity: { absolutePath: string } }[] }).sources[0]!;
  assert.equal(child.identity.absolutePath, documentPath);
  const read = await registry.execute({ id: 'nested-read', name: 'Context.read', arguments: { source_id: child.sourceId } });
  assert.equal(read.is_error, false, read.error_message);
  assert.ok((read.value as { fragments: { text: string }[] }).fragments.some(fragment => fragment.text.includes('Nimbus renewal value is 731.')));
});

test('Office selection keeps frozen text first and exposes saved document continuation as a separate revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-office-selection-continuation-'));
  const path = join(root, 'notes.docx');
  await createOfficeFile({
    operationId: 'create-selection-document', operation: 'create_file',
    sourceId: 'directory', referenceId: 'reference',
    locator: { kind: 'directory', value: { path: root } },
    before: { path, exists: false },
    after: { path, exists: true, format: 'docx', content: {
      paragraphs: ['Saved heading', 'Saved neighbor'],
      tables: [{ rows: [['Saved cell', 'Other cell']] }],
    } },
  });
  const session = await EventSession.open(root, 'office-selection-continuation');
  const prepared = await prepareTaskContext(session, {
    selectionSnapshot: {
      snapshot_id: 'word-selection',
      context: {
        app: 'word',
        content: 'Unsaved selected cell',
        artifacts: { document: path },
        window: { hwnd: 42, pid: 7, title: 'Notes', process_name: 'WINWORD.EXE' },
      },
    },
  }, { root, userDataDir: root, registry: new ToolRegistry() });
  const source = prepared.taskContext.sources.find(item => item.sourceId === 'source:selection:word-selection')!;
  const reader = prepared.readers.get(source);
  const frozen = await reader.read(source);
  assert.equal(frozen.fragments[0]?.text, 'Unsaved selected cell');
  assert.equal(frozen.fragments[0]?.metadata.historical, true);
  assert.equal(frozen.coverage.complete, false);
  assert.equal(frozen.coverage.nextCursor, 'frozen-selection:remainder');
  const saved = await reader.read(source, { cursor: frozen.coverage.nextCursor });
  assert.ok(saved.fragments.some(item => item.text === 'Saved neighbor'));
  assert.ok(saved.fragments.some(item => item.text.includes('Other cell')));
  assert.equal((saved.fragments[0]?.metadata.sourceRevision as { authority?: string })?.authority, 'disk');
  assert.equal(saved.structure?.readFrom, 'disk');
  assert.equal(source.revision.authority, 'historical');

  const emptySession = await EventSession.open(root, 'office-empty-selection');
  const emptyPrepared = await prepareTaskContext(emptySession, {
    selectionSnapshot: {
      snapshot_id: 'word-empty-selection',
      context: {
        app: 'word', content: '', artifacts: { document: path },
        window: { hwnd: 42, pid: 7, title: 'Notes', process_name: 'WINWORD.EXE' },
      },
    },
  }, { root, userDataDir: root, registry: new ToolRegistry() });
  const emptySource = emptyPrepared.taskContext.sources.find(item => item.sourceId === 'source:selection:word-empty-selection')!;
  const noFrozenText = await emptyPrepared.readers.get(emptySource).read(emptySource);
  assert.ok(noFrozenText.fragments.some(item => item.text === 'Saved neighbor'));
  assert.equal(noFrozenText.structure?.readFrom, 'disk');
  assert.equal(noFrozenText.structure?.historicalSelectionTextUnavailable, true);
  assert.equal(noFrozenText.coverage.complete, false);
});

test('current Word source reads unsaved body and a gesture binds only an observed live cell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-word-current-context-'));
  const path = join(root, 'decision.docx');
  await createOfficeFile({
    operationId: 'saved-word', operation: 'create_file', sourceId: 'directory', referenceId: 'seed',
    locator: { kind: 'directory', value: { path: root } }, before: { path, exists: false },
    after: { path, exists: true, format: 'docx', content: { paragraphs: ['Saved condition'] } },
  });
  let currentPath = path;
  const live = new WordLiveReader(async () => ({
    ok: true, hwnd: 42, pid: 7, document: currentPath, documentSaved: false,
    paragraphs: [
      { text: 'Unsaved condition', start: 0, end: 17, bodyIndex: 0 },
      { text: 'Only this cell', start: 40, end: 54, bodyIndex: 1,
        tableIndex: 0, rowIndex: 0, columnIndex: 1, paragraphIndex: 0 },
      { text: 'Unsaved consequence', start: 60, end: 79, bodyIndex: 2 },
      { text: 'Current header condition', start: 0, end: 24,
        story: 'header', sectionIndex: 0, variantIndex: 1, paragraphIndex: 0 },
      { text: 'Current footer detail', start: 0, end: 21,
        story: 'footer', sectionIndex: 0, variantIndex: 1, paragraphIndex: 0 },
    ],
  }));
  const selectedSession = await EventSession.open(root, 'word-current-selection');
  const selectedRegistry = new ToolRegistry();
  const selected = await prepareTaskContext(selectedSession, { selectionSnapshot: {
    snapshot_id: 'selected-word', context: {
      app: 'word', content: 'Frozen selected cell', artifacts: { document: path },
      window: { hwnd: 42, pid: 7, title: 'Decision', process_name: 'WINWORD.EXE' },
    },
  } }, { root, userDataDir: root, registry: selectedRegistry, wordLiveReader: live });
  const historical = selected.taskContext.sources.find(item => item.sourceId === 'source:selection:selected-word')!;
  const current = selected.taskContext.sources.find(item => item.parentSourceId === historical.sourceId && item.revision.authority === 'live')!;
  assert.ok(current, 'pointed Word source should expose a separate current document');
  assert.ok(current.capabilities.includes('patch'));
  const read = await selectedRegistry.execute({ id: 'read-unsaved-word', name: 'Context.read', arguments: { source_id: current.sourceId } });
  assert.equal(read.is_error, false, read.error_message);
  const result = read.value as { fragments: { text: string; locator: { kind: string; value: Record<string, unknown> } }[];
    coverage: { complete: boolean }; usedBackend: string };
  assert.deepEqual(result.fragments.map(item => item.text), [
    'Unsaved condition', 'Only this cell', 'Unsaved consequence',
    'Current header condition', 'Current footer detail',
  ]);
  assert.equal(result.fragments[1]?.locator.kind, 'table-cell');
  assert.equal(result.fragments[1]?.locator.value.start, 40);
  assert.deepEqual(result.fragments[3]?.locator.value, { story: 'header', start: 0, end: 24,
    sectionIndex: 0, variantIndex: 1, paragraphIndex: 0 });
  assert.deepEqual(result.fragments[4]?.locator.value, { story: 'footer', start: 0, end: 21,
    sectionIndex: 0, variantIndex: 1, paragraphIndex: 0 });
  assert.equal(result.coverage.complete, true);
  assert.equal(result.usedBackend, 'office.com.word.current');
  assert.equal(result.fragments.some(item => item.text.includes('Saved condition')), false);
  const footerSearch = await selectedRegistry.execute({ id: 'search-live-footer', name: 'Context.search',
    arguments: { source_id: current.sourceId, query: 'footer detail' } });
  assert.equal(footerSearch.is_error, false, footerSearch.error_message);
  assert.deepEqual((footerSearch.value as { results: ReadResult[] }).results[0]?.fragments.map(item => item.text),
    ['Current footer detail']);
  currentPath = join(root, 'other.docx');
  const changed = await selectedRegistry.execute({ id: 'read-changed-word', name: 'Context.read', arguments: { source_id: current.sourceId } });
  assert.equal(changed.is_error, false, changed.error_message);
  assert.equal((changed.value as { fragments: unknown[] }).fragments.length, 0, 'identity mismatch must not fall back to disk');

  currentPath = path;
  const gestureSession = await EventSession.open(root, 'word-current-gesture');
  const gestureRegistry = new ToolRegistry();
  const gesture = await prepareTaskContext(gestureSession, { selectionSnapshot: {
    snapshot_id: 'gesture-word', context: {
      app: 'ocr', content: 'Frozen marked text',
      window: { hwnd: 42, pid: 7, title: 'Decision', process_name: 'WINWORD.EXE' },
    },
    office_document_sources: [{ app: 'word', document: path, document_saved: false,
      hwnd: 42, pid: 7, process_name: 'WINWORD.EXE' }],
  } }, { root, userDataDir: root, registry: gestureRegistry, wordLiveReader: live });
  const gestureCurrent = gesture.taskContext.sources.find(item => item.revision.authority === 'live')!;
  assert.ok(gestureCurrent);
  assert.ok(gestureCurrent.capabilities.includes('patch'), 'a bound live cell can be proposed after observation');
  assert.equal(gesture.taskContext.references.some(item => item.sourceId === gestureCurrent.sourceId), false,
    'the gesture itself does not choose a Word cell');
  const gestureRead = await gestureRegistry.execute({ id: 'read-gesture-word', name: 'Context.read', arguments: { source_id: gestureCurrent.sourceId } });
  assert.equal(gestureRead.is_error, false, gestureRead.error_message);
  const gestureFragments = (gestureRead.value as { fragments: { text: string; locator: { kind: string; value: Record<string, unknown> } }[] }).fragments;
  assert.equal(gestureFragments[0]?.text, 'Unsaved condition');
  const targetCell = gestureFragments.find(item => item.locator.kind === 'table-cell')!;
  const bound = await gestureRegistry.execute({ id: 'bind-gesture-word-cell', name: 'Context.bind', arguments: {
    source_id: gestureCurrent.sourceId, locator: targetCell.locator, role: 'target',
  } });
  assert.equal(bound.is_error, false, bound.error_message);
  const referenceId = (bound.value as { binding: { referenceId: string } }).binding.referenceId;
  const proposed = await gestureRegistry.execute({ id: 'propose-gesture-word-cell', name: 'Document.propose_patch', arguments: {
    summary: 'Change the observed cell', operations: [{
      operationId: 'change-gesture-word-cell', operation: 'replace_text', sourceId: gestureCurrent.sourceId,
      referenceId, locator: targetCell.locator, before: 'Only this cell', after: 'Only that cell',
    }],
  } });
  assert.equal(proposed.is_error, false, proposed.error_message);
  const accepted = await handleArtifact({ sessionId: gestureSession.id,
    artifactId: (proposed.value as { artifactId: string }).artifactId, action: 'accept', revision: 1 }, root);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  for (const [suffix, content] of [['text', 'Unsaved selected text'], ['empty', '']] as const) {
    const unsavedSession = await EventSession.open(root, `word-new-${suffix}`);
    const unsavedRegistry = new ToolRegistry();
    const unsaved = await prepareTaskContext(unsavedSession, { selectionSnapshot: {
      snapshot_id: `word-new-${suffix}`, context: {
        app: 'word', content, artifacts: {
          document: 'Document1', source_identity: { absolutePath: 'Document1', hwnd: 42, host: 'microsoft_word' },
        }, window: { hwnd: 42, pid: 7, title: 'Document1', process_name: 'WINWORD.EXE' },
      },
    } }, { root, userDataDir: root, registry: unsavedRegistry });
    const frozen = unsaved.taskContext.sources.find(item => item.sourceId === `source:selection:word-new-${suffix}`)!;
    assert.equal(frozen.identity.absolutePath, undefined, 'an unsaved native name is not a disk path');
    assert.equal(frozen.capabilities.includes('patch'), false);
    const observed = await unsavedRegistry.execute({ id: `read-word-new-${suffix}`, name: 'Context.read',
      arguments: { source_id: frozen.sourceId } });
    assert.equal(observed.is_error, false, observed.error_message);
    const value = observed.value as ReadResult;
    assert.equal(value.coverage.nextCursor, null, 'a new unsaved document has no disk continuation');
    assert.equal(value.usedBackend, 'frozen.selection');
  }
});

test('Word body order and a bound table cell survive an exact document patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-word-table-cell-'));
  const path = join(root, 'decision.docx');
  const document = new Document({ sections: [{ children: [
    new Paragraph('Condition must remain'),
    new Table({ rows: [new TableRow({ children: [
      new TableCell({ children: [new Paragraph('Other decision')] }),
      new TableCell({ children: [new Paragraph({ children: [
        new TextRun('Only '), new TextRun({ text: 'this cell', bold: true }),
      ] })] }),
    ] })] }),
    new Paragraph('After table remains'),
  ] }] });
  await writeFile(path, await Packer.toBuffer(document));
  const session = await EventSession.open(root, 'word-table-cell');
  const registry = new ToolRegistry();
  const prepared = await prepareTaskContext(session, { attachments: [path] }, { root, userDataDir: root, registry });
  const source = prepared.taskContext.sources.find(item => item.identity.absolutePath === path)!;
  const read = await registry.execute({ id: 'read-word-cell', name: 'Context.read', arguments: { source_id: source.sourceId } });
  assert.equal(read.is_error, false, read.error_message);
  const fragments = (read.value as { fragments: { text: string; locator: { kind: string; value: Record<string, unknown> } }[] }).fragments;
  const cell = fragments.find(item => item.locator.kind === 'table-cell' && item.text === 'Only this cell');
  assert.ok(cell, 'table cell needs its own observed locator for Context.bind');
  assert.deepEqual(cell.locator.value, { story: 'body', bodyIndex: 1, tableIndex: 0, rowIndex: 0, columnIndex: 1, paragraphIndex: 0, revision: source.revision });
  assert.deepEqual(fragments.map(item => item.text), [
    'Condition must remain', 'Other decision\tOnly this cell',
    'Other decision', 'Only this cell', 'After table remains',
  ]);
  const bound = await registry.execute({ id: 'bind-word-cell', name: 'Context.bind', arguments: {
    source_id: source.sourceId, locator: cell.locator, role: 'target',
  } });
  assert.equal(bound.is_error, false, bound.error_message);
  const referenceId = (bound.value as { binding: { referenceId: string } }).binding.referenceId;
  const proposed = await registry.execute({ id: 'propose-word-cell', name: 'Document.propose_patch', arguments: {
    summary: 'Change only the decision cell', operations: [{
      operationId: 'change-word-cell', operation: 'replace_text', sourceId: source.sourceId,
      referenceId, locator: cell.locator, before: 'Only this cell', after: 'Only that cell',
    }],
  } });
  assert.equal(proposed.is_error, false, proposed.error_message);
  const artifactId = (proposed.value as { artifactId: string }).artifactId;
  assert.equal((await handleArtifact({ sessionId: session.id, artifactId, action: 'accept', revision: 1 }, root)).ok, true);
  const applied = await handleArtifact({ sessionId: session.id, artifactId, action: 'apply', revision: 1 }, root);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const changed = await new DocumentReader().read(source);
  assert.deepEqual(changed.fragments.map(item => item.text), [
    'Condition must remain', 'Other decision\tOnly that cell',
    'Other decision', 'Only that cell', 'After table remains',
  ]);
  const runs = xmlFind(zipXml(new AdmZip(await readFile(path)), 'word/document.xml'), 'w:r');
  const boldRun = runs.find(run => xmlText(xmlChildren(run), 'w:t') === 'that cell');
  assert.ok(boldRun && xmlFind(xmlChildren(boldRun), 'w:b').length, 'edited words keep their bold run');
});

test('PowerPoint selection exposes exact live text styles to Context.read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-powerpoint-selection-styles-'));
  const session = await EventSession.open(root, 'powerpoint-selection-styles');
  const registry = new ToolRegistry();
  const styleSpans = [
    { start: 0, length: 5, bold: false, italic: false, underline: false, fontName: 'Arial', fontSize: 18, colorRgb: 0 },
    { start: 5, length: 3, bold: true, italic: true, underline: true, fontName: 'Calibri', fontSize: 22, colorRgb: 255 },
  ];
  const shapes = [{ shape_id: 2, text: 'Keep 10%', styleSpans }];
  const prepared = await prepareTaskContext(session, {
    selectionSnapshot: {
      snapshot_id: 'powerpoint-selection',
      context: {
        app: 'powerpoint', content: 'Keep 10%',
        artifacts: { presentation: join(root, 'unsaved.pptx'), shapes },
        window: { hwnd: 42, pid: 7, title: 'Presentation', process_name: 'POWERPNT.EXE' },
      },
    },
  }, { root, userDataDir: root, registry });
  const source = prepared.taskContext.sources.find(item => item.sourceId === 'source:selection:powerpoint-selection')!;
  const result = await registry.execute({ id: 'read-powerpoint', name: 'Context.read', arguments: { source_id: source.sourceId } });
  assert.equal(result.is_error, false, result.error_message);
  const frozen = result.value as { fragments: { metadata: { officeShapes?: unknown } }[]; usedBackend: string };
  assert.deepEqual(frozen.fragments[0]?.metadata.officeShapes, shapes);
  assert.equal(frozen.usedBackend, 'frozen.selection');
});

test('current PowerPoint source reads unsaved slides separately from frozen selection and disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-powerpoint-current-context-'));
  const path = join(root, 'planning.pptx');
  const currentPath = join(root, 'current-copy.pptx');
  const make = async (output: string, title: string) => createOfficeFile({
    operationId: `create-${title}`, operation: 'create_file', sourceId: 'directory', referenceId: 'seed',
    locator: { kind: 'directory', value: { path: root } }, before: { path: output, exists: false },
    after: { path: output, exists: true, format: 'pptx', content: { slides: [{ title, paragraphs: ['Next milestone'] }] } },
  });
  await make(path, 'Saved plan');
  await make(currentPath, 'Unsaved plan');
  const copies: string[] = [];
  let presentedPath = path;
  const live = new PowerPointLiveReader(async (_source, copyPath) => {
    copies.push(copyPath);
    await writeFile(copyPath, await readFile(currentPath));
    return { ok: true, hwnd: 42, pid: 7, presentation: presentedPath, presentationSaved: false };
  });
  const session = await EventSession.open(root, 'powerpoint-current');
  const registry = new ToolRegistry();
  const prepared = await prepareTaskContext(session, { selectionSnapshot: {
    snapshot_id: 'ppt-current-gesture', frame_lease: { frameLeaseId: 'ppt-current-frame' },
    context: { app: 'ocr', content: 'Frozen marked caption',
      window: { hwnd: 42, pid: 7, title: 'Planning', process_name: 'POWERPNT.EXE' } },
    office_document_sources: [{ app: 'powerpoint', document: path, document_saved: false,
      hwnd: 42, pid: 7, process_name: 'POWERPNT.EXE' }],
    selection_gesture: { strokes: [{ points: [{ x: 10, y: 10 }, { x: 50, y: 10 }] }] },
  } }, { root, userDataDir: root, registry, powerpointLiveReader: live });
  const historical = prepared.taskContext.sources.find(item => item.sourceId === 'source:selection:ppt-current-gesture')!;
  const current = prepared.taskContext.sources.find(item => item.identity.host === 'powerpoint' && item.revision.authority === 'live');
  assert.ok(current, 'pointed PowerPoint needs an independent current presentation source');
  assert.equal(current.parentSourceId, historical.sourceId);
  assert.equal(prepared.taskContext.references.some(item => item.sourceId === current.sourceId), false,
    'the mark does not select a slide shape without covering structural evidence');
  const read = await registry.execute({ id: 'read-current-ppt', name: 'Context.read', arguments: { source_id: current.sourceId } });
  assert.equal(read.is_error, false, read.error_message);
  const result = read.value as ReadResult;
  assert.ok(result.fragments.some(item => item.text.includes('Unsaved plan')), JSON.stringify(result));
  assert.equal(result.fragments.some(item => item.text.includes('Saved plan')), false);
  assert.equal(result.usedBackend, 'office.com.powerpoint.savecopyas+document.pptx.ooxml');
  assert.equal(result.structure?.readFrom, 'live');
  const title = result.fragments.find(item => item.text.includes('Unsaved plan'))!;
  assert.equal(title.locator.kind, 'slide-shape');
  assert.deepEqual(title.metadata.sourceRevision, { authority: 'live' });
  const bound = await registry.execute({ id: 'bind-current-ppt', name: 'Context.bind', arguments: {
    source_id: current.sourceId, locator: title.locator, role: 'target',
  } });
  assert.equal(bound.is_error, false, bound.error_message);
  await assert.rejects(() => stat(copies[0]!), { code: 'ENOENT' });

  presentedPath = join(root, 'other.pptx');
  const changed = await live.read(current);
  assert.equal(changed.fragments.length, 0, 'identity mismatch must not fall back to disk');
  assert.match(String(changed.coverage.missingReason), /identity-changed/);
  await assert.rejects(() => stat(copies.at(-1)!), { code: 'ENOENT' });

  const newSession = await EventSession.open(root, 'powerpoint-new');
  const newPrepared = await prepareTaskContext(newSession, { selectionSnapshot: {
    snapshot_id: 'new-powerpoint', context: { app: 'powerpoint', content: 'Current title',
      artifacts: { presentation: 'Presentation1' },
      window: { hwnd: 43, pid: 7, title: 'Presentation1', process_name: 'POWERPNT.EXE' } },
  } }, { root, userDataDir: root, registry: new ToolRegistry() });
  const newHistorical = newPrepared.taskContext.sources.find(item => item.sourceId === 'source:selection:new-powerpoint')!;
  assert.equal(newHistorical.identity.absolutePath, undefined);
  assert.equal(newHistorical.capabilities.includes('patch'), false);
  assert.equal(newPrepared.taskContext.sources.find(item => item.identity.host === 'powerpoint')?.identity.presentationPath,
    'Presentation1');
});

test('XLSX reads package-root worksheet relationships and reports a missing referenced sheet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-xlsx-relationship-'));
  const path = join(root, 'root-relative.xlsx');
  await createOfficeFile({
    operationId: 'create-xlsx-relationship', operation: 'create_file',
    sourceId: 'directory', referenceId: 'reference',
    locator: { kind: 'directory', value: { path: root } },
    before: { path, exists: false },
    after: { path, exists: true, format: 'xlsx', content: { sheets: [{ name: 'Forecast', rows: [['Amount'], [42]] }] } },
  });
  const zip = new AdmZip(await readFile(path));
  const relationshipPath = 'xl/_rels/workbook.xml.rels';
  const relationships = zip.readAsText(relationshipPath);
  const rootRelative = relationships.replace(/Target="[^"]*worksheets\/sheet1\.xml"/, 'Target="/xl/worksheets/sheet1.xml"');
  assert.match(rootRelative, /Target="\/xl\/worksheets\/sheet1\.xml"/);
  zip.updateFile(relationshipPath, Buffer.from(rootRelative));
  zip.writeZip(path);

  const reader = new DocumentReader();
  const result = await reader.read(fileSource('xlsx-relationship', path));
  assert.ok(result.fragments.some(fragment => fragment.metadata.value === 42), JSON.stringify(result));

  zip.deleteFile('xl/worksheets/sheet1.xml');
  const missingPath = join(root, 'missing-sheet.xlsx');
  zip.writeZip(missingPath);
  await assert.rejects(() => reader.read(fileSource('xlsx-relationship', missingPath)), /worksheet|part|missing/i);
});

test('XLSX dates and merged numeric headings retain displayed meaning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-xlsx-date-'));
  const reader = new DocumentReader();
  for (const date1904 of [false, true]) {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = date1904;
    const sheet = workbook.addWorksheet('Schedule');
    sheet.getCell('A1').value = 'Due date';
    sheet.getCell('A2').value = new Date('2026-09-23T00:00:00.000Z');
    sheet.getCell('A2').numFmt = 'yyyy-mm-dd';
    sheet.getCell('B2').value = 46000;
    sheet.getCell('C2').value = { formula: 'A2+1', result: new Date('2026-09-24T00:00:00.000Z') };
    sheet.getCell('C2').numFmt = 'yyyy-mm-dd';
    const file = join(root, date1904 ? 'date-1904.xlsx' : 'date-1900.xlsx');
    await workbook.xlsx.writeFile(file);
    const result = await reader.read(fileSource('xlsx-date', file));
    const due = result.fragments.find(fragment => fragment.metadata.address === 'A2');
    const plain = result.fragments.find(fragment => fragment.metadata.address === 'B2');
    const formula = result.fragments.find(fragment => fragment.metadata.address === 'C2');
    assert.equal(due?.metadata.value, '2026-09-23');
    assert.equal(typeof due?.metadata.rawValue, 'number');
    assert.match(due?.text ?? '', /2026-09-23/);
    assert.equal(plain?.metadata.value, 46000);
    assert.equal(plain?.metadata.rawValue, undefined);
    assert.equal(formula?.metadata.formula, '=A2+1');
    assert.equal(formula?.metadata.cachedValue, '2026-09-24');
    assert.equal(typeof formula?.metadata.rawCachedValue, 'number');
    assert.match(formula?.text ?? '', /cachedValue=2026-09-24/);
  }
  const headed = new ExcelJS.Workbook();
  const sheet = headed.addWorksheet('Forecast');
  sheet.mergeCells('A1:D1');
  sheet.getCell('A1').value = 2026;
  sheet.mergeCells('B2:D2');
  sheet.getCell('B2').value = '收入（万元）';
  sheet.addRow(['部门', '计划', '实际', '差额']);
  sheet.addRow(['北区', 150, 120, { formula: 'C4-B4' }]);
  const headedFile = join(root, 'merged-numeric-heading.xlsx');
  await headed.xlsx.writeFile(headedFile);
  const headedRead = await reader.read(fileSource('xlsx-heading', headedFile));
  const plan = headedRead.fragments.find(fragment => fragment.metadata.address === 'B4');
  const actual = headedRead.fragments.find(fragment => fragment.metadata.address === 'C4');
  const formula = headedRead.fragments.find(fragment => fragment.metadata.address === 'D4');
  assert.ok((plan?.metadata.headers as string[]).includes('收入（万元）'));
  assert.equal(plan?.metadata.unit, '万元');
  assert.deepEqual(actual?.metadata.rowHeaders, ['北区']);
  assert.deepEqual(formula?.metadata.rowHeaders, ['北区']);
  assert.equal(formula?.metadata.cachedValueKnown, false);
});

test('current Excel source reads unsaved merged headings and values without falling back to disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-excel-current-context-'));
  const path = join(root, 'comparison.xlsx');
  const workbook = (amount: number) => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Budget');
    sheet.mergeCells('A1:D1');
    sheet.getCell('A1').value = 2026;
    sheet.mergeCells('B2:D2');
    sheet.getCell('B2').value = '收入（万元）';
    sheet.addRow(['部门', '计划', '实际', '差额']);
    sheet.addRow(['北区', amount, 120, { formula: 'C4-B4' }]);
    return book;
  };
  await workbook(150).xlsx.writeFile(path);
  const current = workbook(180);
  const copies: string[] = [];
  let currentPath = path;
  const reader = new ExcelLiveReader(async (_source, copyPath) => {
    copies.push(copyPath);
    await current.xlsx.writeFile(copyPath);
    return { ok: true, hwnd: 42, pid: 7, workbook: currentPath, workbookSaved: false };
  });
  const source = {
    ...fileSource('excel-current', path),
    sourceId: 'source:excel-live:42',
    kind: 'document',
    identity: { host: 'excel', hwnd: 42, pid: 7, workbookPath: path, absolutePath: path },
    revision: { authority: 'live' },
  };
  const result = await reader.read(source);
  const plan = result.fragments.find(item => item.metadata.address === 'B4');
  const formula = result.fragments.find(item => item.metadata.address === 'D4');
  assert.equal(plan?.metadata.value, 180, JSON.stringify(result));
  assert.ok((plan?.metadata.headers as string[]).includes('收入（万元）'));
  assert.equal(plan?.metadata.unit, '万元');
  assert.equal(formula?.metadata.formula, '=C4-B4');
  assert.equal(formula?.metadata.cachedValueKnown, false);
  assert.equal(result.usedBackend, 'office.com.excel.savecopyas+document.xlsx.ooxml');
  assert.equal(result.structure?.readFrom, 'live');
  assert.deepEqual(plan?.metadata.sourceRevision, { authority: 'live' });
  assert.equal(result.fragments.some(item => item.metadata.value === 150), false);
  await assert.rejects(() => stat(copies[0]!), { code: 'ENOENT' });

  const session = await EventSession.open(root, 'excel-live-context');
  const registry = new ToolRegistry();
  const prepared = await prepareTaskContext(session, { selectionSnapshot: {
    snapshot_id: 'excel-selection',
    frame_lease: { frameLeaseId: 'frame-excel-selection' },
    context: { app: 'excel', content: '北区\t180\t120',
      artifacts: { workbook: path, worksheet: 'Budget', address: 'A4:C4' },
      window: { hwnd: 42, pid: 7, title: 'Budget', process_name: 'EXCEL.EXE' } },
    selection_gesture: { strokes: [{ points: [{ x: 10, y: 10 }, { x: 50, y: 10 }] }] },
  } }, { root, userDataDir: root, registry, excelLiveReader: reader });
  const liveSource = prepared.taskContext.sources.find(item => item.revision.authority === 'live' && item.identity.host === 'excel');
  assert.ok(liveSource, 'selected Excel workbook needs a current source separate from frozen selection and disk');
  const liveRead = await registry.execute({ id: 'read-current-excel', name: 'Context.read',
    arguments: { source_id: liveSource.sourceId } });
  assert.equal(liveRead.is_error, false, liveRead.error_message);
  const liveFragments = (liveRead.value as ReadResult).fragments;
  assert.equal(liveFragments.find(item => item.metadata.address === 'B4')?.metadata.value, 180);
  assert.deepEqual(liveFragments.find(item => item.metadata.address === 'B4')?.metadata.sourceRevision, { authority: 'live' });

  const unsavedSession = await EventSession.open(root, 'excel-new-workbook');
  const unsavedPrepared = await prepareTaskContext(unsavedSession, { selectionSnapshot: {
    snapshot_id: 'excel-new',
    context: { app: 'excel', content: '北区', artifacts: { workbook: '工作簿1' },
      window: { hwnd: 43, pid: 7, title: '工作簿1', process_name: 'EXCEL.EXE' } },
  } }, { root, userDataDir: root, registry: new ToolRegistry() });
  const unsavedSelection = unsavedPrepared.taskContext.sources.find(item => item.sourceId === 'source:selection:excel-new')!;
  assert.equal(unsavedSelection.identity.absolutePath, undefined,
    'an unsaved workbook name must not be presented as a disk path');
  assert.equal(unsavedSelection.capabilities.includes('patch'), false);
  assert.equal(unsavedPrepared.taskContext.sources.find(item => item.identity.host === 'excel')?.identity.workbookPath, '工作簿1');

  currentPath = join(root, 'other.xlsx');
  const changed = await reader.read(source);
  assert.equal(changed.fragments.length, 0);
  assert.match(String(changed.coverage.missingReason), /identity-changed/);
  assert.equal(changed.usedBackend, 'office.com.excel.savecopyas');
  await assert.rejects(() => stat(copies.at(-1)!), { code: 'ENOENT' });
});

test('TypeScript readers create and read real Office and PDF files; exact document patches survive session reload and undo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-ts-context-')),
    reader = new DocumentReader(),
    session = await EventSession.open(root, 'migration-test');
  const contents = {
    docx: {
      title: 'Report',
      paragraphs: ['Original paragraph', 'Keep untouched'],
      tables: [
        {
          rows: [
            ['Name', 'Value'],
            ['A', 42],
          ],
        },
      ],
    },
    xlsx: {
      sheets: [
        {
          name: 'Data',
          rows: [
            ['Name', 'Value'],
            ['A', 42],
            ['Formula', { formula: 'B2*2' }],
          ],
        },
      ],
    },
    pptx: {
      slides: [
        {
          title: 'Overview',
          paragraphs: ['Actual slide content'],
          tables: [
            {
              rows: [
                ['A', 'B'],
                [1, 2],
              ],
            },
          ],
        },
      ],
    },
  };
  for (const [format, content] of Object.entries(contents)) {
    const path = join(root, `source.${format}`),
      operation: PatchOperation = {
        operationId: `create-${format}`,
        operation: 'create_file',
        sourceId: 'directory',
        referenceId: 'reference',
        locator: { kind: 'directory', value: { path: root } },
        before: { path, exists: false },
        after: { path, exists: true, format, content },
      };
    await createOfficeFile(operation);
    const parsed = await reader.parse(fileSource(session.id, path));
    assert.equal(parsed.structure.kind, format);
    assert.ok(parsed.units.length);
    const backend = new DocumentOperationBackend([
      { ...fileSource(session.id, root), sourceId: 'directory' },
    ]);
    assert.deepEqual((await backend.readCurrent(operation)).value, operation.after);
  }
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([400, 400]);
  page.drawText('Real PDF content', { x: 30, y: 340, font });
  const pdfPath = join(root, 'source.pdf');
  await writeFile(pdfPath, await pdf.save());
  assert.match(
    (await reader.read(fileSource(session.id, pdfPath))).fragments
      .map((item) => item.text)
      .join(' '),
    /Real PDF content/,
  );
  const path = join(root, 'source.docx'),
    source = fileSource(session.id, path);
  await registerSource(session, source);
  const initial = await reader.read(source),
    target = initial.fragments.find((item) => item.text === 'Original paragraph')!;
  assert.ok(target);
  const binding = {
    referenceId: 'target-reference',
    label: 'A',
    sourceId: source.sourceId,
    locator: target.locator,
    role: 'target',
    frameLeaseId: null,
    capturedAtMs: Date.now(),
    ordinal: 1,
    active: true,
  };
  await updateContext(session, { referenceUpdates: [{ operation: 'add', binding }] });
  assert.equal(resolveSource(session.events, 'A').sourceId, source.sourceId);
  assert.equal(
    authorizeAccess(scopeFromEvents(session.events, session.id), {
      action: 'patch',
      sourceIds: [source.sourceId],
    }).allowed,
    false,
  );
  const operation: PatchOperation = {
      operationId: 'replace-paragraph',
      operation: 'replace_text',
      sourceId: source.sourceId,
      referenceId: binding.referenceId,
      locator: target.locator,
      before: 'Original paragraph',
      after: 'Changed paragraph',
    },
    draft = await createArtifact(session, 'Replace one paragraph', 'Exact edit', 'document_patch', {
      patchId: 'patch',
      references: [binding],
      operations: [operation],
    });
  assert.equal(
    (
      await handleArtifact(
        { sessionId: session.id, artifactId: draft.artifactId, action: 'apply', revision: 1 },
        root,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await handleArtifact(
        { sessionId: session.id, artifactId: draft.artifactId, action: 'accept', revision: 1 },
        root,
      )
    ).ok,
    true,
  );
  const applied = await handleArtifact(
    { sessionId: session.id, artifactId: draft.artifactId, action: 'apply', revision: 1 },
    root,
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const changed = await reader.read(source);
  assert.ok(changed.fragments.some((item) => item.text === 'Changed paragraph'));
  assert.ok(changed.fragments.some((item) => item.text === 'Keep untouched'));
  const undone = await handleArtifact(
    {
      sessionId: session.id,
      artifactId: draft.artifactId,
      action: 'undo',
      revision: 1,
      confirmed: true,
    },
    root,
  );
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.ok(
    (await reader.read(source)).fragments.some((item) => item.text === 'Original paragraph'),
  );
  const current = await EventSession.open(root, session.id, false),
    text = await createArtifact(current, 'First', 'Draft', 'text');
  await patchArtifact(current, text.artifactId, 1, 'User text', { author: 'user' });
  await assert.rejects(
    () => patchArtifact(current, text.artifactId, 1, 'Stale model text'),
    /revision|stale/i,
  );
  const sheet = fileSource(session.id, join(root, 'source.xlsx')),
    cells = await reader.read(sheet);
  assert.ok(cells.fragments.some((item) => item.metadata.formula === '=B2*2'));
  const excel = new DocumentOperationBackend([sheet]),
    cellOp: PatchOperation = {
      operationId: 'cell',
      operation: 'set_cell_values',
      referenceId: 'cell-ref',
      sourceId: sheet.sourceId,
      locator: { kind: 'cell-range', value: { sheet: 'Data', range: 'B2' } },
      before: [[42]],
      after: [[43]],
    };
  const excelResult = await excel.execute(cellOp);
  assert.equal(excelResult.ok, true, JSON.stringify(excelResult));
  assert.deepEqual((await excel.readCurrent(cellOp)).value, [[43]]);
  assert.ok((await reader.read(sheet)).fragments.some((item) => item.metadata.formula === '=B2*2'));
  const pdfSource = fileSource(session.id, pdfPath),
    pdfBackend = new DocumentOperationBackend([pdfSource]),
    outputPath = join(root, 'annotated.pdf'),
    annotation = { annotationId: 'note', outputPath, kind: 'text-note', text: 'Review this' },
    pdfOp: PatchOperation = {
      operationId: 'annotation',
      operation: 'add_pdf_annotation',
      sourceId: pdfSource.sourceId,
      referenceId: 'pdf-ref',
      locator: { kind: 'pdf-region', value: { pageIndex: 0, rectPt: [20, 20, 160, 70] } },
      before: { ...annotation, present: false },
      after: { ...annotation, present: true },
    };
  const originalBytes = await readFile(pdfPath);
  const pdfResult = await pdfBackend.execute(pdfOp);
  assert.equal(pdfResult.ok, true, JSON.stringify(pdfResult));
  assert.equal(
    (
      await pdfBackend.execute({
        ...pdfOp,
        operationId: 'undo-note',
        before: pdfOp.after,
        after: pdfOp.before,
      })
    ).ok,
    true,
  );
  assert.deepEqual(await readFile(pdfPath), originalBytes);
});

test('created Office tables are read back at the same row and column when values repeat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-created-table-readback-'));
  const backend = new DocumentOperationBackend([
    { ...fileSource('created-table-readback', root), sourceId: 'directory' },
  ]);
  for (const format of ['docx', 'pptx']) {
    const path = join(root, `repeated.${format}`);
    const content = format === 'docx'
      ? { tables: [{ rows: [['Repeated'], ['Repeated']] }] }
      : { slides: [{ title: 'Results', tables: [{ rows: [['Repeated'], ['Repeated']] }] }] };
    const operation: PatchOperation = {
      operationId: `create-repeated-${format}`, operation: 'create_file',
      sourceId: 'directory', referenceId: 'reference',
      locator: { kind: 'directory', value: { path: root } },
      before: { path, exists: false },
      after: { path, exists: true, format, content },
    };
    await createOfficeFile(operation);
    assert.deepEqual((await backend.readCurrent(operation)).value, operation.after);
    const zip = new AdmZip(await readFile(path));
    const part = format === 'docx' ? 'word/document.xml' : 'ppt/slides/slide2.xml';
    const xml = zip.readAsText(part);
    let occurrence = 0;
    const changed = xml.replace(/Repeated/g, text => (++occurrence === 2 ? 'Changed' : text));
    assert.equal(occurrence, 2, `${format} fixture should contain two equal table cells`);
    zip.updateFile(part, Buffer.from(changed));
    zip.writeZip(path);
    assert.notDeepEqual((await backend.readCurrent(operation)).value, operation.after,
      `${format} must detect a changed second table cell even when the first still matches`);
  }
});

test('PDF visual overlay preserves requested colors and reads actual annotation colors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-pdf-overlay-color-'));
  const path = join(root, 'source.pdf');
  const outputPath = join(root, 'annotated.pdf');
  const pdf = await PDFDocument.create();
  pdf.addPage([240, 160]);
  await writeFile(path, await pdf.save());
  const source = fileSource('pdf-overlay-color', path);
  const backend = new DocumentOperationBackend([source]);
  const state = {
    annotationId: 'overlay', outputPath, kind: 'visual-overlay', text: '修订 Corrected',
    strokeColor: [0, 0, 1], fillColor: [1, 1, 0], fontSize: 12,
  };
  const operation: PatchOperation = {
    operationId: 'overlay-color', operation: 'add_pdf_annotation',
    sourceId: source.sourceId, referenceId: 'overlay-reference',
    locator: { kind: 'pdf-region', value: { pageIndex: 0, rectPt: [20, 20, 160, 70] } },
    before: { ...state, present: false }, after: { ...state, present: true },
  };
  assert.equal((await backend.execute(operation)).ok, true);
  const saved = await PDFDocument.load(await readFile(outputPath));
  const annots = saved.getPages()[0]!.node.lookup(PDFName.of('Annots'), PDFArray);
  const annotation = annots.lookup(0, PDFDict);
  const color = (name: string) => {
    const values = annotation.lookup(PDFName.of(name), PDFArray);
    return [0, 1, 2].map(index => values.lookup(index, PDFNumber).asNumber());
  };
  assert.deepEqual(color('C'), state.fillColor);
  const appearance = annotation.lookup(PDFName.of('AP'), PDFDict)
    .lookup(PDFName.of('N'), PDFStream) as PDFRawStream;
  const appearanceContent = appearance.getContentsString();
  assert.match(appearanceContent, /1 1 0 rg/);
  assert.match(appearanceContent, /0 0 1 RG/);
  annotation.set(PDFName.of('C'), saved.context.obj([1, 0, 0]));
  await writeFile(outputPath, await saved.save());
  assert.notDeepEqual((await backend.readCurrent(operation)).value, operation.after,
    'a color changed outside Magic Pointer must not be reported as the requested overlay');
});

test('Skill candidates require verified repeated results and a reviewed confirmation before disabled installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-skills-')),
    store = new SkillCandidateStore(root);
  for (let i = 0; i < 3; i++)
    await store.observeExecution(
      {
        id: `plan-${i}`,
        recipeId: 'agent.handoff',
        risk: 'read',
        provider: 'test',
        parameters: { objects: [{ kind: 'document' }] },
      },
      { id: `receipt-${i}`, status: 'succeeded', verified: true },
    );
  const candidates = await store.list();
  assert.equal(candidates.length, 1);
  const id = String(candidates[0]!.candidateId),
    review = await store.draft(id);
  await assert.rejects(() => store.install(id, true, review.reviewToken), /confirmation/);
  assert.equal(
    (await store.install(id, false, review.reviewToken)).status,
    'confirmation_required',
  );
  const installed = await store.install(id, true, review.reviewToken);
  assert.equal(installed.status, 'installed_disabled');
  assert.equal(installed.candidate.enabled, false);
  await assert.rejects(() => store.install(id, true, review.reviewToken), /review/);
});

test('Context stores retain evidence across reloads and keep historical content distinct from current disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-context-stores-')), store = new ContextSessionStore(root), capture = { snapshot_id: 'snapshot', context: { content: 'Historical observation', app: 'word', artifacts: { document: join(root, 'document.txt') } } };
  const recorded = await store.record(capture, 'Use this paragraph', 'context_pack', true), active = await new ContextSessionStore(root).active(); assert.equal(active!.item_count, 1); assert.equal((await store.record(capture, 'Use this paragraph', 'context_pack', true)).recorded, false);
  const prompt = compileContextPrompt(active!, { task_instruction: 'Improve it' }); assert.match(prompt, /Historical observation/);
  await store.saveCompilation({ expected_session_id: active!.session_id, expected_revision: active!.store_revision, task_instruction: 'Improve it', prompt, prompt_artifact: 'artifact.md' }); await assert.rejects(() => store.saveCompilation({ expected_session_id: active!.session_id, expected_revision: active!.store_revision, prompt: 'stale' }), /changed/);
  assert.equal((await store.finish(recorded.session.session_id))!.status, 'finished'); assert.equal(await store.active(), null);
  const memory = new ScreenMemory(join(root, 'screen-memory.json'), true); await memory.record({ excerpt: 'Observed material', sourceId: 'source', locator: { kind: 'text', value: {} } }); assert.equal((await memory.recall('material')).length, 1); assert.equal((await new ScreenMemory(memory.path, false).record({ excerpt: 'Do not retain' })), null);
  const clipboard = new ClipboardHistory(join(root, 'clipboard-history.json')); await clipboard.record('Saved text'); await clipboard.record('Saved text'); assert.equal((await clipboard.recent()).length, 1); assert.equal(await clipboard.record('secret', { secret: true }), null);
  const path = join(root, 'document.txt'); await writeFile(path, 'Current disk content'); const source = fileSource('context-test', path); source.identity.content = 'Historical observation'; source.identity.locators = [{ kind: 'text', value: { start: 0, end: 22 } }]; const reader = new FrozenSelectionReader(new DocumentReader()); assert.equal((await reader.read(source)).fragments[0]!.text, 'Historical observation'); assert.ok((await reader.read(source, { query: 'disk' })).fragments.some(fragment => fragment.text.includes('Current disk')));
  const handoff = new AgentContextHandoffStore(join(root, 'agent-contexts')), packet = { schemaVersion: 2, packetId: 'packet', objects: [], workspace: { cwd: root }, intent: { recipeId: 'agent.handoff' } }, sealed = await handoff.seal(packet, { prompt: 'Use collected evidence', attachments: [], permission: 'write', privacy: {} }); assert.equal((await handoff.seal(packet, { prompt: 'Use collected evidence', attachments: [], permission: 'write', privacy: {} })).reused, true); await assert.rejects(() => handoff.seal({ ...packet, objects: [{}] }, { prompt: 'Use collected evidence', attachments: [], permission: 'write', privacy: {} }), /collision/);
  let starts = 0; const starter = async () => { starts++; return { taskId: 'task', status: 'queued' }; }; assert.equal((await handoff.dispatch(sealed.contextId, { provider: 'codex', starter })).accepted, true); assert.equal((await handoff.dispatch(sealed.contextId, { provider: 'codex', starter })).reused, true); assert.equal(starts, 1);
});

test('attached files can be moved within their source directory and restored through an accepted patch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mp-attached-file-move-'));
  for (const extension of ['txt', 'docx']) await t.test(extension, async () => {
    const original = join(root, `notes.${extension}`), destination = join(root, 'Sorted', `notes.${extension}`);
    if (extension === 'txt') await writeFile(original, 'Keep this file intact');
    else await createOfficeFile({
      operationId: 'seed-docx', operation: 'create_file', sourceId: 'directory', referenceId: 'seed',
      locator: { kind: 'directory', value: { path: root } }, before: { path: original, exists: false },
      after: { path: original, exists: true, format: 'docx', content: { paragraphs: ['Keep this document intact'] } },
    });
    const initialBytes = await readFile(original);
    const session = await EventSession.open(root, `attached-move-${extension}`), registry = new ToolRegistry();
    const prepared = await prepareTaskContext(session, { attachments: [original] }, { root, userDataDir: root, registry });
    const source = prepared.taskContext.sources.find(item => item.identity.absolutePath === original)!;
    assert.ok(source);
    const attachedStat = await stat(original);
    await utimes(original, attachedStat.atime, new Date(attachedStat.mtimeMs + 60_000));
    if (extension === 'txt') {
      assert.ok(source.capabilities.includes('move_file'));
      assert.equal(source.capabilities.includes('patch'), false);
    }
    const read = await registry.execute({ id: `read-${extension}`, name: 'Context.read', arguments: { source_id: source.sourceId } });
    assert.equal(read.is_error, false, read.error_message);
    const locator = (read.value as { fragments: { locator: { kind: string; value: Record<string, unknown> } }[] }).fragments[0]!.locator;
    const bound = await registry.execute({ id: `bind-${extension}`, name: 'Context.bind', arguments: { source_id: source.sourceId, locator, role: 'target' } });
    assert.equal(bound.is_error, false, bound.error_message);
    const referenceId = ((bound.value as { binding: { referenceId: string } }).binding).referenceId;
    const proposal = await registry.execute({ id: `propose-${extension}`, name: 'Document.propose_patch', arguments: {
      summary: `Move ${extension} file into Sorted`, operations: [{
        operationId: `move-${extension}`, operation: 'move_file', sourceId: source.sourceId, referenceId, locator,
        before: { path: original }, after: { path: destination },
      }],
    } });
    assert.equal(proposal.is_error, false, proposal.error_message);
    const artifactId = (proposal.value as { artifactId: string }).artifactId;
    const preview = await handleArtifact({ sessionId: session.id, artifactId, action: 'read' }, root);
    assert.equal((preview.artifact as { patchPayload: { operations: { after: { path: string } }[] } }).patchPayload.operations[0]!.after.path, destination);
    const accepted = await handleArtifact({ sessionId: session.id, artifactId, action: 'accept', revision: 1 }, root);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const applied = await handleArtifact({ sessionId: session.id, artifactId, action: 'apply', revision: 1 }, root);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.deepEqual(await readFile(destination), initialBytes);
    await assert.rejects(readFile(original), { code: 'ENOENT' });
    await session.refresh();
    const movedSource = resolveSource(session.events, source.sourceId);
    const movedStat = await stat(destination);
    assert.deepEqual(movedSource.revision, { mtimeMs: movedStat.mtimeMs, size: movedStat.size, authority: 'disk' });
    const movedRead = await registry.execute({ id: `moved-read-${extension}`, name: 'Context.read', arguments: { source_id: source.sourceId } });
    assert.equal(movedRead.is_error, false, movedRead.error_message);
    assert.ok((movedRead.value as { fragments: { text: string }[] }).fragments.some(item => item.text.includes('Keep this')));
    const undone = await handleArtifact({ sessionId: session.id, artifactId, action: 'undo', revision: 1, confirmed: true }, root);
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.deepEqual(await readFile(original), initialBytes);
    await assert.rejects(readFile(destination), { code: 'ENOENT' });
    await session.refresh();
    const restoredSource = resolveSource(session.events, source.sourceId);
    const restoredStat = await stat(original);
    assert.deepEqual(restoredSource.revision, { mtimeMs: restoredStat.mtimeMs, size: restoredStat.size, authority: 'disk' });
    const restoredRead = await registry.execute({ id: `restored-read-${extension}`, name: 'Context.read', arguments: { source_id: source.sourceId } });
    assert.equal(restoredRead.is_error, false, restoredRead.error_message);
    assert.ok((restoredRead.value as { fragments: { text: string }[] }).fragments.some(item => item.text.includes('Keep this')));
    if (extension === 'txt') {
      const unsupported = await new DocumentOperationBackend([source]).readCurrent({
        operationId: 'unrelated-text-write', operation: 'replace_text', sourceId: source.sourceId, referenceId,
        locator, before: 'Keep this file intact', after: 'Changed text',
      });
      assert.equal(unsupported.ok, false);
    }
  });
  await t.test('partial batch keeps the file source at the last verified move', async () => {
    const original = join(root, 'partial.txt'), moved = join(root, 'partial-stage.txt'), occupied = join(root, 'partial-final.txt');
    await writeFile(original, 'partial source');
    await writeFile(occupied, 'existing destination');
    const session = await EventSession.open(root, 'partial-file-move'), source = fileSource('partial-file-move', original);
    source.capabilities = ['read', 'search', 'follow', 'move_file'];
    await registerSource(session, source);
    const locator = { kind: 'text', value: { lineStart: 1, lineEnd: 1 } };
    const binding = { referenceId: 'partial-target', label: 'A', sourceId: source.sourceId, locator, role: 'target', frameLeaseId: null, capturedAtMs: Date.now(), ordinal: 1, active: true };
    await updateContext(session, { referenceUpdates: [{ operation: 'add', binding }] });
    const draft = await createArtifact(session, 'Move in two steps', 'Moves', 'document_patch', {
      patchId: 'partial-move', references: [binding], operations: [
        { operationId: 'move-first', operation: 'move_file', sourceId: source.sourceId, referenceId: binding.referenceId, locator, before: { path: original }, after: { path: moved } },
        { operationId: 'move-second', operation: 'move_file', sourceId: source.sourceId, referenceId: binding.referenceId, locator, before: { path: moved }, after: { path: occupied } },
      ],
    });
    assert.equal((await handleArtifact({ sessionId: session.id, artifactId: draft.artifactId, action: 'accept', revision: 1 }, root)).ok, true);
    const partial = await handleArtifact({ sessionId: session.id, artifactId: draft.artifactId, action: 'apply', revision: 1 }, root);
    assert.equal((partial.result as { status: string }).status, 'partial', JSON.stringify(partial));
    await session.refresh();
    assert.equal(resolveSource(session.events, source.sourceId).identity.absolutePath, moved);
    assert.equal((await readFile(moved)).toString(), 'partial source');
    assert.equal((await readFile(occupied)).toString(), 'existing destination');
    const undone = await handleArtifact({ sessionId: session.id, artifactId: draft.artifactId, action: 'undo', revision: 1, confirmed: true }, root);
    assert.equal(undone.ok, true, JSON.stringify(undone));
    await session.refresh();
    assert.equal(resolveSource(session.events, source.sourceId).identity.absolutePath, original);
  });
  const directory = await mkdtemp(join(root, 'selected-directory-')), inside = join(directory, 'inside.txt');
  await writeFile(inside, 'stay');
  const directorySource = fileSource('directory-scope', directory), outside = join(root, 'outside.txt');
  const escaped = await new DocumentOperationBackend([directorySource]).execute({
    operationId: 'outside-directory', operation: 'move_file', sourceId: directorySource.sourceId,
    referenceId: 'directory-target', locator: { kind: 'directory', value: {} },
    before: { path: inside }, after: { path: outside },
  });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error || '', /Move outside source scope/);
  assert.equal((await readFile(inside)).toString(), 'stay');
});
