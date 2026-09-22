import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createOfficeFile, DocumentOperationBackend } from '../electron/runtime/actions';
import { DocumentReader } from '../electron/runtime/context_documents';
import {
  fileSource,
  registerSource,
  authorizeAccess,
  scopeFromEvents,
  updateContext,
  resolveSource,
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
