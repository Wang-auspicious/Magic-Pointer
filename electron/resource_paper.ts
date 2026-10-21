import {PDFDocument} from 'pdf-lib';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function fetchLinkedPaper(
  text: string,
  directory: string,
  fetcher: (url: string) => Promise<Response>,
): Promise<{path: string; coverage: string} | null> {
  const identifiers = [
    ...new Set(
      [
        ...text.matchAll(
          /https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/g,
        ),
      ].map(match => match[1]),
    ),
  ];
  if (identifiers.length !== 1) {
    return null;
  }
  const url = `https://arxiv.org/pdf/${identifiers[0]}`;
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Paper download failed: HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Paper download returned no PDF.');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.length;
      if (size > 32 * 1024 * 1024) {
        throw new Error(
          'PDF exceeds 32 MB. Download it manually and add the file.',
        );
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('The paper address did not return a PDF.');
  }
  const document = await PDFDocument.load(bytes);
  if (!document.getPageCount()) {
    throw new Error('The PDF has no pages.');
  }
  await mkdir(directory, {recursive: true});
  const file = join(directory, `${randomUUID()}.pdf`);
  await writeFile(file, bytes, {flag: 'wx'});
  return {
    path: file,
    coverage: `Downloaded ${url}; parsed ${document.getPageCount()} PDF pages. Download verification is not evidence that all pages were read.`,
  };
}
