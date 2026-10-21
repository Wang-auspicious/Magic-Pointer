import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fetchLinkedPaper} from '../electron/resource_paper';

test('an exact arXiv reference downloads a parsed PDF; an ambiguous mention does not guess', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const bytes = await doc.save();
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    return new Response(Buffer.from(bytes), {status: 200});
  };
  const folder = mkdtempSync(join(tmpdir(), 'mp-paper-'));
  const result = await fetchLinkedPaper(
    'See https://arxiv.org/abs/1706.03762v7',
    folder,
    fetcher,
  );
  assert.equal(requested[0], 'https://arxiv.org/pdf/1706.03762v7');
  assert.equal(
    (await PDFDocument.load(readFileSync(result!.path))).getPageCount(),
    1,
  );
  assert.equal(
    await fetchLinkedPaper('Some attention paper', folder, fetcher),
    null,
  );
  assert.equal(
    await fetchLinkedPaper(
      'https://arxiv.org/abs/1706.03762 https://arxiv.org/abs/1810.04805',
      folder,
      fetcher,
    ),
    null,
  );
  await assert.rejects(
    fetchLinkedPaper(
      'https://arxiv.org/abs/1810.04805',
      folder,
      async () => new Response('<html>Login</html>'),
    ),
    /PDF/,
  );
});
