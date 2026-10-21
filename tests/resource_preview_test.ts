import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ResourceCollectionService} from '../electron/resource_collection_service';
import {resourceThumbnailUrl} from '../electron/resource_preview';
const {createStashRuntime} = require('../electron/stash_runtime');
const clipboard = {
  availableFormats: () => [],
  readText: () => '',
  readImage: () => ({isEmpty: () => true}),
};

function fixture() {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-preview-'));
  const stash = createStashRuntime({
    baseDir: join(baseDir, 'stash'),
    clipboard,
  });
  const service = new ResourceCollectionService({
    stash: () => stash,
    projects: () => [],
    attach() {},
    analyze: async () => {
      throw new Error('Reading an original must not call a model');
    },
  });
  return {baseDir, stash, service};
}

test('resource preview reads its retained text, even when the original file changes', async () => {
  const {baseDir, stash, service} = fixture();
  const original = join(baseDir, 'note.txt');
  writeFileSync(original, 'Saved reference text <script>data only</script>');
  const entry = await stash.addFile(original);
  writeFileSync(original, 'Changed outside the collection');
  const preview = await service.preview(entry.id);
  assert.equal(preview.kind, 'text');
  assert.ok(preview.kind === 'text');
  assert.equal(preview.text, 'Saved reference text <script>data only</script>');
});

test('collected file previews classify images, PDFs, audio and video by retained extension', async () => {
  const {baseDir, stash, service} = fixture();
  for (const [extension, kind] of [
    ['png', 'image'],
    ['pdf', 'pdf'],
    ['mp4', 'video'],
    ['mp3', 'audio'],
  ]) {
    const original = join(baseDir, 'reference.' + extension);
    writeFileSync(original, Buffer.from([0, 1, 2, 3]));
    const entry = await stash.addFile(original);
    const preview = await service.preview(entry.id);
    assert.equal(preview.kind, kind);
    assert.ok('url' in preview);
    assert.equal(
      fileURLToPath(preview.url),
      join(stash.baseDir, entry.relPath),
    );
    assert.notEqual(fileURLToPath(preview.url), original);
    assert.equal(
      Boolean(resourceThumbnailUrl(stash.baseDir, entry)),
      kind === 'image',
    );
  }
});

test('missing, binary and oversized text originals produce honest preview results', async () => {
  const {baseDir, stash, service} = fixture();
  await assert.rejects(service.preview('missing'), /not_found/);
  const text = await service.add({text: 'A'.repeat(400000)});
  const preview = await service.preview(text.id);
  assert.equal(preview.kind, 'text');
  assert.equal(preview.truncated, true);
  const original = join(baseDir, 'reference.bin');
  writeFileSync(original, Buffer.from([0, 1, 2, 3]));
  const binary = await stash.addFile(original);
  await assert.rejects(service.preview(binary.id), /binary/);
});

test('a downloaded paper has its own retained preview instead of reopening its saved link', async () => {
  const {stash, service} = fixture();
  const entry = await service.add({text: 'Saved arXiv link'});
  const paperPath = join(stash.baseDir, 'paper.pdf');
  writeFileSync(paperPath, '%PDF-1.7');
  stash.updateResource(entry.id, {paperPath});
  const paper = await service.preview(entry.id, 'paper');
  assert.equal(paper.kind, 'pdf');
  assert.ok('url' in paper);
  assert.equal(fileURLToPath(paper.url), paperPath);
  assert.equal((await service.preview(entry.id)).kind, 'text');
});
