import { readFile, stat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import {
  array,
  record,
  fileSource,
  type Json,
  type FragmentLocator,
  type ReadOptions,
  type ReadResult,
  type SourceReader,
  type SourceRef,
} from './context';

export type XmlNode = Record<string, unknown>;
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});
const builder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  suppressEmptyNode: true,
});
export function xmlParse(xml: string): XmlNode[] {
  return parser.parse(xml) as XmlNode[];
}
export function xmlBuild(nodes: XmlNode[]): string {
  return builder.build(nodes);
}
export function xmlName(node: XmlNode): string {
  return Object.keys(node).find((key) => key !== ':@') ?? '';
}
export function xmlChildren(node: XmlNode): XmlNode[] {
  return array<XmlNode>(node[xmlName(node)]);
}
export function xmlAttrs(node: XmlNode): Json {
  return record(node[':@']);
}
export function xmlFind(nodes: XmlNode[], name: string): XmlNode[] {
  return nodes.flatMap((node) => [
    ...(xmlName(node) === name ? [node] : []),
    ...xmlFind(xmlChildren(node), name),
  ]);
}
export function xmlText(nodes: XmlNode[], tag?: string): string {
  if (tag)
    return xmlFind(nodes, tag)
      .map((node) => xmlText(xmlChildren(node)))
      .join('');
  return nodes
    .map((node) => ('#text' in node ? String(node['#text'] ?? '') : xmlText(xmlChildren(node))))
    .join('');
}
export function zipXml(zip: AdmZip, path: string): XmlNode[] {
  return xmlParse(zip.readAsText(path));
}
export function relationships(zip: AdmZip, path: string): Map<string, string> {
  const folder = posix.dirname(path),
    relpath = posix.join(folder, '_rels', `${posix.basename(path)}.rels`);
  return new Map(
    xmlFind(zipXml(zip, relpath), 'Relationship').map((node) => {
      const attrs = xmlAttrs(node);
      const target = String(attrs.Target);
      return [String(attrs.Id), posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(folder, target))];
    }),
  );
}
export function sourcePath(source: SourceRef): string {
  const value =
    source.identity.absolutePath ?? source.identity.path ?? source.identity.documentPath;
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Source has no local document path');
  return resolve(value);
}
export function cellAddress(address: string): [number, number] {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(address);
  if (!match) throw new Error(`Invalid cell address: ${address}`);
  return [
    match[1]!
      .toUpperCase()
      .split('')
      .reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0),
    Number(match[2]),
  ];
}
export function columnName(number: number): string {
  let result = '';
  while (number > 0) {
    number--;
    result = String.fromCharCode(65 + (number % 26)) + result;
    number = Math.floor(number / 26);
  }
  return result;
}
export function cellRange(range: string): [number, number, number, number] {
  const parts = range.split(':');
  return [...cellAddress(parts[0]!), ...cellAddress(parts[1] ?? parts[0]!)] as [
    number,
    number,
    number,
    number,
  ];
}
export function workbookSheets(zip: AdmZip): { name: string; state: string; path: string }[] {
  const rels = relationships(zip, 'xl/workbook.xml');
  return xmlFind(zipXml(zip, 'xl/workbook.xml'), 'sheet').map((node) => {
    const attrs = xmlAttrs(node);
    return {
      name: String(attrs.name),
      state: String(attrs.state ?? 'visible'),
      path: rels.get(String(attrs['r:id']))!,
    };
  });
}
export function sharedStrings(zip: AdmZip): string[] {
  return xmlFind(zipXml(zip, 'xl/sharedStrings.xml'), 'si').map((node) =>
    xmlText(xmlChildren(node), 't'),
  );
}
export function cellValue(node: XmlNode, strings: string[], cached = false): unknown {
  const attrs = xmlAttrs(node),
    children = xmlChildren(node),
    formula = xmlFind(children, 'f')[0],
    value = xmlFind(children, 'v')[0];
  if (formula && !cached) return `=${xmlText(xmlChildren(formula))}`;
  if (attrs.t === 'inlineStr') return xmlText(children, 't');
  if (!value) return null;
  const text = xmlText(xmlChildren(value));
  return attrs.t === 's'
    ? (strings[Number(text)] ?? '')
    : attrs.t === 'b'
      ? text === '1'
      : attrs.t === 'str' || attrs.t === 'e'
        ? text
        : text.trim() && Number.isFinite(Number(text))
          ? Number(text)
          : text;
}
function workbookDateStyles(zip: AdmZip): { date1904: boolean; formatByStyle: Map<number, 'date' | 'time' | 'datetime'> } {
  const workbook = zipXml(zip, 'xl/workbook.xml');
  const epoch = String(xmlAttrs(xmlFind(workbook, 'workbookPr')[0] ?? {}).date1904 ?? '');
  const formatByStyle = new Map<number, 'date' | 'time' | 'datetime'>();
  if (!zip.getEntry('xl/styles.xml')) return { date1904: epoch === '1' || epoch === 'true', formatByStyle };
  const styles = zipXml(zip, 'xl/styles.xml');
  const custom = new Map(xmlFind(styles, 'numFmt').map(node => {
    const attrs = xmlAttrs(node);
    return [Number(attrs.numFmtId), String(attrs.formatCode ?? '')] as const;
  }));
  const builtinDate = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  const builtinTime = new Set([18, 19, 20, 21, 45, 46, 47]);
  const cellXfs = xmlChildren(xmlFind(styles, 'cellXfs')[0] ?? {}).filter(node => xmlName(node) === 'xf');
  cellXfs.forEach((node, index) => {
    const id = Number(xmlAttrs(node).numFmtId);
    if (builtinDate.has(id)) { formatByStyle.set(index, id === 22 ? 'datetime' : 'date'); return; }
    if (builtinTime.has(id)) { formatByStyle.set(index, 'time'); return; }
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\\.|_.|\*./g, '').replace(/\[[^\]]*\]/g, '');
    const date = /[yd]/i.test(code) || /m{2,}/i.test(code) && !/[#0?]/.test(code);
    const time = /[hs]/i.test(code);
    if (date || time) formatByStyle.set(index, date && time ? 'datetime' : date ? 'date' : 'time');
  });
  return { date1904: epoch === '1' || epoch === 'true', formatByStyle };
}
function displayedXlsxValue(node: XmlNode, raw: unknown, styles: ReturnType<typeof workbookDateStyles>): unknown {
  if (typeof raw !== 'number') return raw;
  const kind = styles.formatByStyle.get(Number(xmlAttrs(node).s ?? 0));
  if (!kind) return raw;
  const date = new Date(Date.UTC(styles.date1904 ? 1904 : 1899, styles.date1904 ? 0 : 11, styles.date1904 ? 1 : 30) + raw * 86400000);
  if (!Number.isFinite(date.getTime())) return raw;
  const iso = date.toISOString();
  return kind === 'date' ? iso.slice(0, 10) : kind === 'time' ? iso.slice(11, 19) : iso.slice(0, 19).replace('T', ' ');
}
interface Unit {
  locator: FragmentLocator;
  text: string;
  metadata: Json;
}
interface Parsed {
  units: Unit[];
  backend: string;
  structure: Json;
  total: number;
  missing: string | null;
}
function pdfPageUnits(items: Unit[]): Unit[] {
  const units: Unit[] = [];
  let pageIndex = -1,
    chunkIndex = 0,
    text = '',
    firstBlock = 0,
    lastBlock = 0,
    metadata: Json = {},
    bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const flush = () => {
    if (!text) return;
    units.push({
      locator: {
        kind: 'pdf-region',
        value: { pageIndex, readAggregate: 'pdf-page', chunkIndex: chunkIndex++, blockStart: firstBlock,
          blockEnd: lastBlock, ...(Number.isFinite(bounds[0]) ? { rectPt: bounds } : {}) },
      },
      text,
      metadata: { ...metadata, pageIndex, chunkIndex: chunkIndex - 1, blockStart: firstBlock, blockEnd: lastBlock },
    });
    text = '';
    bounds = [Infinity, Infinity, -Infinity, -Infinity];
  };
  for (const item of items) {
    const index = Number(item.locator.value.pageIndex);
    if (index !== pageIndex) {
      flush();
      pageIndex = index;
      chunkIndex = 0;
    }
    const block = Number(item.locator.value.blockIndex);
    for (const part of item.text.match(/[\s\S]{1,16000}/g) ?? []) {
      if (text && text.length + part.length + 1 > 16000) flush();
      if (!text) { firstBlock = block; metadata = item.metadata; }
      text += `${text ? '\n' : ''}${part}`;
      lastBlock = block;
      const rect = array<number>(item.locator.value.rectPt);
      if (rect.length === 4) {
        bounds[0] = Math.min(bounds[0]!, rect[0]!);
        bounds[1] = Math.min(bounds[1]!, rect[1]!);
        bounds[2] = Math.max(bounds[2]!, rect[2]!);
        bounds[3] = Math.max(bounds[3]!, rect[3]!);
      }
      if (part.length === 16000) flush();
    }
  }
  flush();
  return units;
}
interface DirectoryFrame {
  relativePath: string;
  index: number;
}
export class DocumentReader implements SourceReader {
  private cache = new Map<string, { version: string; document: Parsed }>();
  constructor(
    private liveReader?: (source: SourceRef, options: ReadOptions) => Promise<ReadResult | null>,
  ) {}
  async parse(source: SourceRef): Promise<Parsed> {
    const path = sourcePath(source),
      info = await stat(path),
      version = `${info.mtimeMs}:${info.size}:${JSON.stringify(source.revision)}`;
    if (!info.isDirectory() && this.cache.get(path)?.version === version)
      return this.cache.get(path)!.document;
    let document: Parsed;
    if (info.isDirectory()) {
      const entries = (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
      document = {
        units: await Promise.all(
          entries.map(async (entry, index) => {
            const absolutePath = join(path, entry.name),
              child = await stat(absolutePath);
            return {
              locator: { kind: 'text', value: { entryIndex: index, relativePath: entry.name } },
              text: `[${entry.isDirectory() ? 'directory' : 'file'}] ${entry.name}`,
              metadata: {
                relativePath: entry.name,
                absolutePath,
                isDirectory: entry.isDirectory(),
                size: child.size,
                mtimeMs: child.mtimeMs,
              },
            };
          }),
        ),
        backend: 'document.directory',
        structure: { kind: 'directory', entryCount: entries.length },
        total: entries.length,
        missing: null,
      };
    } else {
      const extension = extname(path).toLowerCase();
      if (extension === '.pdf') document = await this.pdf(path);
      else if (['.docx', '.pptx', '.xlsx'].includes(extension)) {
        const zip = new AdmZip(await readFile(path));
        document =
          extension === '.docx'
            ? this.word(zip, source)
            : extension === '.pptx'
              ? this.slides(zip)
              : this.sheets(zip);
      } else if (
        /^\.(txt|md|markdown|rst|py|js|ts|tsx|jsx|json|yaml|yml|toml|ini|cfg|csv|tsv|log|bat|ps1|html?|css|xml|svg)$/i.test(
          extension,
        )
      ) {
        const raw = await readFile(path);
        let text: string,
          encoding = 'utf-8';
        try {
          text = new TextDecoder(encoding, { fatal: true }).decode(raw);
        } catch {
          encoding = raw[0] === 255 && raw[1] === 254 ? 'utf-16le' : 'gb18030';
          text = new TextDecoder(encoding).decode(raw);
        }
        const lines = text.split(/\r?\n/);
        document = {
          units: lines.map((line, index) => ({
            locator: { kind: 'text', value: { lineStart: index + 1, lineEnd: index + 1 } },
            text: line,
            metadata: { encoding },
          })),
          backend: `document.text.${encoding}`,
          structure: { kind: 'text', lineCount: lines.length, encoding },
          total: lines.length,
          missing: null,
        };
      } else
        document = {
          units: [],
          backend: 'document.unsupported',
          structure: { kind: 'unsupported', extension },
          total: 0,
          missing: `unsupported-file-type:${extension}`,
        };
    }
    if (!info.isDirectory()) {
      this.cache.delete(path);
      this.cache.set(path, { version, document });
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    }
    return document;
  }
  private async pdf(path: string): Promise<Parsed> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await readFile(path)),
      useSystemFonts: true,
    });
    const pdf = await loading.promise;
    const units: Unit[] = [],
      pages: Json[] = [],
      scanned: number[] = [];
    try {
      for (let index = 0; index < pdf.numPages; index++) {
        const page = await pdf.getPage(index + 1),
          viewport = page.getViewport({ scale: 1 }),
          content = await page.getTextContent();
        pages.push({
          pageIndex: index,
          sizePt: [viewport.width, viewport.height],
          rotation: page.rotate,
        });
        let count = 0;
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          const transform = item.transform,
            x = Number(transform[4]),
            y = Number(transform[5]),
            height = item.height || Math.abs(Number(transform[3]));
          const locator = {
            kind: 'pdf-region',
            value: {
              pageIndex: index,
              blockIndex: count++,
              rectPt: [x, page.view[3]! - y - height, x + item.width, page.view[3]! - y],
            },
          };
          units.push({
            locator,
            text: item.str,
            metadata: {
              pageIndex: index,
              rotation: page.rotate,
              sizePt: [viewport.width, viewport.height],
            },
          });
        }
        if (!count) scanned.push(index);
      }
      return {
        units,
        backend: 'document.pdf.pdfjs',
        structure: { kind: 'pdf', pageCount: pdf.numPages, pages, toc: await pdf.getOutline() },
        total: pdf.numPages,
        missing: scanned.length ? `scanned-pages-require-ocr:pages=${scanned.join(',')}` : null,
      };
    } finally {
      await loading.destroy();
    }
  }
  private word(zip: AdmZip, source: SourceRef): Parsed {
    const units: Unit[] = [],
      body = xmlFind(zipXml(zip, 'word/document.xml'), 'w:body')[0];
    let paragraphIndex = 0,
      tableIndex = 0,
      bodyIndex = 0;
    for (const child of body ? xmlChildren(body) : []) {
      if (xmlName(child) === 'w:p') {
        const text = xmlText(xmlChildren(child), 'w:t'),
          style = String(xmlAttrs(xmlFind(xmlChildren(child), 'w:pStyle')[0] ?? {})['w:val'] ?? '');
        if (text)
          units.push({
            locator: {
              kind: 'text',
              value: { story: 'body', bodyIndex, paragraphIndex, revision: source.revision },
            },
            text,
            metadata: {
              story: 'body',
              bodyIndex,
              paragraphIndex,
              style,
              headingLevel: Number(/heading\s*(\d+)/i.exec(style)?.[1]) || null,
            },
          });
        paragraphIndex++;
        bodyIndex++;
      } else if (xmlName(child) === 'w:tbl') {
        xmlChildren(child).filter((node) => xmlName(node) === 'w:tr').forEach((row, rowIndex) => {
          const cellNodes = xmlChildren(row).filter((node) => xmlName(node) === 'w:tc');
          const cells = cellNodes.map((node) => xmlText(xmlChildren(node), 'w:t'));
          units.push({
            locator: { kind: 'table', value: { story: 'body', bodyIndex, tableIndex, rowIndex } },
            text: cells.join('\t'),
            metadata: { cells, tableIndex, rowIndex },
          });
          cellNodes.forEach((cell, columnIndex) => {
            xmlChildren(cell).filter((node) => xmlName(node) === 'w:p').forEach((paragraph, paragraphIndex) => {
              const text = xmlText(xmlChildren(paragraph), 'w:t');
              if (!text) return;
              units.push({
                locator: { kind: 'table-cell', value: {
                  story: 'body', bodyIndex, tableIndex, rowIndex, columnIndex,
                  paragraphIndex, revision: source.revision,
                } },
                text,
                metadata: { story: 'body', bodyIndex, tableIndex, rowIndex, columnIndex,
                  paragraphIndex, cells },
              });
            });
          });
        });
        tableIndex++;
        bodyIndex++;
      }
    }
    for (const entry of zip
      .getEntries()
      .filter((entry) => /^word\/(header|footer)\d+\.xml$/.test(entry.entryName))) {
      const story = entry.entryName.includes('header') ? 'header' : 'footer';
      xmlFind(zipXml(zip, entry.entryName), 'w:p').forEach((node, index) => {
        const text = xmlText(xmlChildren(node), 'w:t');
        if (text)
          units.push({
            locator: {
              kind: 'text',
              value: { story, part: entry.entryName, paragraphIndex: index },
            },
            text,
            metadata: { story },
          });
      });
    }
    return {
      units,
      backend: 'document.docx.ooxml',
      structure: {
        kind: 'docx',
        bodyItems: bodyIndex,
        paragraphs: paragraphIndex,
        tables: tableIndex,
      },
      total: units.length,
      missing: 'floating-objects-and-revisions-not-expanded',
    };
  }
  private slides(zip: AdmZip): Parsed {
    const presentation = zipXml(zip, 'ppt/presentation.xml'),
      rels = relationships(zip, 'ppt/presentation.xml'),
      slides = xmlFind(presentation, 'p:sldId'),
      size = xmlAttrs(xmlFind(presentation, 'p:sldSz')[0] ?? {}),
      units: Unit[] = [];
    for (const [slideIndex, slide] of slides.entries()) {
      const slideId = Number(xmlAttrs(slide).id),
        path = rels.get(String(xmlAttrs(slide)['r:id']));
      if (!path) continue;
      const visit = (nodes: XmlNode[], parentShapeId: number | null) => {
        for (const shape of nodes) {
          if (!['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp'].includes(xmlName(shape)))
            continue;
          const children = xmlChildren(shape),
            id = xmlAttrs(xmlFind(children, 'p:cNvPr')[0] ?? {}),
            shapeId = Number(id.id),
            offset = xmlAttrs(xmlFind(children, 'a:off')[0] ?? {}),
            extent = xmlAttrs(xmlFind(children, 'a:ext')[0] ?? {}),
            value = {
              slideId,
              shapeId,
              parentShapeId,
              shapeName: String(id.name ?? ''),
              bboxPt: [
                Number(offset.x ?? 0) / 12700,
                Number(offset.y ?? 0) / 12700,
                Number(extent.cx ?? 0) / 12700,
                Number(extent.cy ?? 0) / 12700,
              ],
            };
          if (xmlName(shape) === 'p:grpSp') {
            visit(children, shapeId);
            continue;
          }
          const table = xmlFind(children, 'a:tbl')[0];
          if (table) {
            xmlFind(xmlChildren(table), 'a:tr').forEach((row, tableRowIndex) => {
              const cells = xmlChildren(row)
                .filter((cell) => xmlName(cell) === 'a:tc')
                .map((cell) => xmlText(xmlChildren(cell), 'a:t').replace(/\s+/g, ' ').trim());
              units.push({
                locator: { kind: 'slide-shape', value: { ...value, tableRowIndex } },
                text: cells.join('\t'),
                metadata: { ...value, slideIndex, contentKind: 'table', tableRowIndex, cells },
              });
            });
            continue;
          }
          const paragraphs = xmlFind(children, 'a:p'),
            text = paragraphs
              .map((node) => xmlText(xmlChildren(node), 'a:t'))
              .filter(Boolean)
              .join('\n');
          units.push({
            locator: { kind: 'slide-shape', value },
            text: text || `[shape] ${value.shapeName}`,
            metadata: {
              ...value,
              slideIndex,
              contentKind: text ? 'text' : 'image-or-graphic',
              runs: xmlFind(children, 'a:r').map((node) => ({
                text: xmlText(xmlChildren(node), 'a:t'),
                ...xmlAttrs(xmlFind(xmlChildren(node), 'a:rPr')[0] ?? {}),
              })),
            },
          });
        }
      };
      const tree = xmlFind(zipXml(zip, path), 'p:spTree')[0];
      if (tree) visit(xmlChildren(tree), null);
      for (const notes of relationships(zip, path).values())
        if (/notesSlides\/notesSlide/.test(notes)) {
          const text = xmlFind(zipXml(zip, notes), 'a:p')
            .map((node) => xmlText(xmlChildren(node), 'a:t'))
            .filter(Boolean)
            .join('\n');
          if (text)
            units.push({
              locator: { kind: 'text', value: { story: 'notes', slideId } },
              text,
              metadata: { story: 'notes', slideIndex },
            });
        }
    }
    return {
      units,
      backend: 'document.pptx.ooxml',
      structure: {
        kind: 'pptx',
        slideCount: slides.length,
        slideIds: slides.map((node) => Number(xmlAttrs(node).id)),
        slideSizePt: [Number(size.cx) / 12700, Number(size.cy) / 12700],
      },
      total: slides.length,
      missing: null,
    };
  }
  private sheets(zip: AdmZip): Parsed {
    const sheets = workbookSheets(zip),
      strings = sharedStrings(zip),
      dateStyles = workbookDateStyles(zip),
      units: Unit[] = [],
      structures: Json[] = [];
    for (const sheet of sheets) {
      if (!zip.getEntry(sheet.path)) throw new Error(`Referenced worksheet part is missing: ${sheet.path}`);
      const tree = zipXml(zip, sheet.path),
        cells = xmlFind(tree, 'c'),
        merged = xmlFind(tree, 'mergeCell').map((node) => String(xmlAttrs(node).ref)),
        byAddress = new Map(cells.map((node) => [String(xmlAttrs(node).r), node])),
        rows = new Map(
          xmlFind(tree, 'row').map((node) => [Number(xmlAttrs(node).r), xmlAttrs(node)]),
        ),
        columns = xmlFind(tree, 'col').map(xmlAttrs),
        values = cells.map((node) => {
          const rawValue = cellValue(node, strings);
          return { node, address: String(xmlAttrs(node).r), rawValue,
            value: displayedXlsxValue(node, rawValue, dateStyles) };
        });
      const numeric = values.filter((cell) => typeof cell.rawValue === 'number' || String(cell.value).startsWith('='));
      const unmerged = numeric.filter(cell => !merged.some(range => {
        const [x1, y1, x2, y2] = cellRange(range);
        const [column, row] = cellAddress(cell.address);
        return column >= x1 && column <= x2 && row >= y1 && row <= y2;
      }));
      const dataStart = Math.min(Infinity, ...(unmerged.length ? unmerged : numeric).map(cell => cellAddress(cell.address)[1]));
      const mergedValue = (column: number, row: number) => {
        const merge = merged
          .map(cellRange)
          .find(([x1, y1, x2, y2]) => column >= x1 && column <= x2 && row >= y1 && row <= y2);
        const key = merge ? `${columnName(merge[0])}${merge[1]}` : `${columnName(column)}${row}`;
        const node = byAddress.get(key);
        return node ? displayedXlsxValue(node, cellValue(node, strings), dateStyles) : null;
      };
      for (const cell of values) {
        if (cell.value === null) continue;
        const [column, row] = cellAddress(cell.address),
          headers: string[] = [],
          rowHeaders: string[] = [];
        for (let r = 1; r < Math.min(row, dataStart); r++) {
          const value = mergedValue(column, r);
          if (value !== null && !headers.includes(String(value))) headers.push(String(value));
        }
        for (let c = 1; c < column; c++) {
          const merge = merged.map(cellRange).find(([x1, y1, x2, y2]) =>
            c >= x1 && c <= x2 && row >= y1 && row <= y2);
          const labelAddress = merge ? `${columnName(merge[0])}${merge[1]}` : `${columnName(c)}${row}`;
          const labelNode = byAddress.get(labelAddress);
          const rawLabel = labelNode ? cellValue(labelNode, strings) : null;
          if (rawLabel === null || typeof rawLabel === 'string' && rawLabel.startsWith('=') ||
            !merge && typeof rawLabel !== 'string') continue;
          const value = mergedValue(c, row);
          if (value !== null && !rowHeaders.includes(String(value))) rowHeaders.push(String(value));
        }
        const formula =
            typeof cell.value === 'string' && cell.value.startsWith('=') ? cell.value : null,
          rawCachedValue = cellValue(cell.node, strings, true),
          cachedValue = displayedXlsxValue(cell.node, rawCachedValue, dateStyles),
          unit =
            /[（(]\s*([^（）()]{1,12})\s*[）)]/.exec([...headers, ...rowHeaders].join(' '))?.[1] ??
            null,
          mergedRange =
            merged.find((range) => {
              const [x1, y1, x2, y2] = cellRange(range);
              return column >= x1 && column <= x2 && row >= y1 && row <= y2;
            }) ?? null;
        const metadata = {
          sheet: sheet.name,
          address: cell.address,
          headers,
          rowHeaders,
          unit,
          formula,
          value: cell.value,
          ...(cell.value !== cell.rawValue ? { rawValue: cell.rawValue } : {}),
          cachedValue,
          ...(formula && cachedValue !== rawCachedValue ? { rawCachedValue } : {}),
          cachedValueKnown: !formula || cachedValue !== null,
          mergedRange,
          sheetHidden: sheet.state !== 'visible',
          rowHidden: rows.get(row)?.hidden === '1',
          columnHidden: columns.some(
            (attrs) =>
              Number(attrs.min) <= column && column <= Number(attrs.max) && attrs.hidden === '1',
          ),
        };
        units.push({
          locator: { kind: 'cell-range', value: { sheet: sheet.name, range: cell.address } },
          text: `${sheet.name}!${cell.address} | ${headers.join(' > ')} | ${rowHeaders.join(' > ')} | ${formula ? `formula=${formula} | cachedValue=${cachedValue ?? 'unknown'}` : `value=${cell.value}`}`,
          metadata,
        });
      }
      structures.push({ name: sheet.name, state: sheet.state, mergedRanges: merged });
    }
    return {
      units,
      backend: 'document.xlsx.ooxml',
      structure: { kind: 'xlsx', sheetCount: sheets.length, sheets: structures },
      total: sheets.length,
      missing: null,
    };
  }
  private async searchDirectory(
    source: SourceRef,
    options: ReadOptions,
    started: number,
  ): Promise<ReadResult> {
    const root = sourcePath(source);
    const query = String(options.query ?? '').toLowerCase();
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const matches = (text: string) =>
      text.toLowerCase().includes(query) ||
      (terms.length > 1 && terms.every(term => text.toLowerCase().includes(term)));
    const withinRoot = (candidate: string) => {
      const rest = relative(root, candidate);
      return rest && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
    };
    let frames: DirectoryFrame[] = [{ relativePath: '', index: 0 }];
    if (options.cursor) {
      try {
        const encoded = /^directory:([A-Za-z0-9_-]+)$/.exec(options.cursor)?.[1];
        const state = encoded && JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (state?.query !== query || !Array.isArray(state.frames) || !state.frames.length)
          throw new Error('Invalid directory cursor');
        frames = state.frames;
        for (const frame of frames) {
          if (typeof frame.relativePath !== 'string' || !Number.isSafeInteger(frame.index) || frame.index < 0 ||
            frame.relativePath && !withinRoot(resolve(root, frame.relativePath)))
            throw new Error('Invalid directory cursor');
        }
      } catch { throw new Error('Invalid directory cursor'); }
    }
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const fragments: ReadResult['fragments'] = [];
    const listings = new Map<string, Dirent[]>();
    const entriesFor = async (relativePath: string): Promise<Dirent[]> => {
      let entries = listings.get(relativePath);
      if (!entries) {
        entries = (await readdir(resolve(root, relativePath), { withFileTypes: true }))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        listings.set(relativePath, entries);
      }
      return entries;
    };
    let scanned = 0, contentReads = 0, unreadable = 0, incompleteChild = 0;
    while (frames.length && scanned < 100 && contentReads < 25 && fragments.length < limit) {
      options.signal?.throwIfAborted();
      const frame = frames.at(-1)!;
      const entries = await entriesFor(frame.relativePath);
      if (frame.index >= entries.length) { frames.pop(); continue; }
      const entry = entries[frame.index++]!;
      scanned++;
      const relativePath = join(frame.relativePath, entry.name);
      const absolutePath = resolve(root, relativePath);
      if (!withinRoot(absolutePath)) continue;
      if (entry.isDirectory()) frames.push({ relativePath, index: 0 });
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const nameMatches = matches(relativePath);
      let excerpts: string[] = [];
      if (entry.isFile() && !nameMatches) {
        contentReads++;
        try {
          const child = fileSource(source.taskId, absolutePath, source.sourceId);
          const result = await this.read(child, { query, limit: 10, signal: options.signal });
          excerpts = result.fragments.map(fragment => fragment.text);
          if (excerpts.length && !result.coverage.complete) incompleteChild++;
        } catch { options.signal?.throwIfAborted(); unreadable++; }
      }
      if (!nameMatches && !excerpts.length) continue;
      const locator: FragmentLocator = { kind: 'text', value: { relativePath } };
      fragments.push({
        fragmentId: `fragment:${source.sourceId}:entry:${Buffer.from(relativePath).toString('base64url')}`,
        locator,
        text: (excerpts.length ? excerpts.join('\n') : `[${entry.isDirectory() ? 'directory' : 'file'}] ${relativePath}`).slice(0, 16000),
        metadata: { relativePath, absolutePath, isDirectory: entry.isDirectory(), matches: excerpts.length ? 'content' : 'name', sourceRevision: source.revision },
        citations: [{ sourceId: source.sourceId, locator }],
      });
    }
    while (frames.length && frames.at(-1)!.index >= (await entriesFor(frames.at(-1)!.relativePath)).length)
      frames.pop();
    const nextCursor = frames.length
      ? `directory:${Buffer.from(JSON.stringify({ query, frames })).toString('base64url')}`
      : null;
    const missingReason = [unreadable ? `unreadable-files:${unreadable}` : null, incompleteChild ? `child-evidence-incomplete:${incompleteChild}` : null]
      .filter(Boolean).join(';') || null;
    return {
      sourceId: source.sourceId,
      fragments,
      coverage: { extent: 'query-results', readRanges: fragments.map(fragment => fragment.locator), totalUnits: null,
        complete: !nextCursor && !missingReason, nextCursor, missingReason },
      evidenceStatus: missingReason || nextCursor ? 'degraded' : fragments.length ? 'ok' : 'empty_confirmed',
      usedBackend: 'document.directory+nested',
      latencyMs: performance.now() - started,
      structure: { kind: 'directory', searchedEntries: scanned },
    };
  }
  async read(source: SourceRef, options: ReadOptions = {}): Promise<ReadResult> {
    const started = performance.now();
    options.signal?.throwIfAborted();
    if (this.liveReader && source.identity.hwnd) {
      const live = await this.liveReader(source, options);
      if (live) return live;
    }
    if (options.query !== undefined && (await stat(sourcePath(source))).isDirectory())
      return this.searchDirectory(source, options, started);
    const document = await this.parse(source);
    let units = document.units.map((unit, index) => ({ unit, index })),
      prefix = 'unit';
    if (document.structure.kind === 'pdf' && !options.query &&
      (!options.locator || ['readAggregate', 'searchAggregate'].some((key) =>
        options.locator?.value[key] === 'pdf-page'))) {
      units = pdfPageUnits(document.units).map((unit, index) => ({ unit, index }));
      prefix = 'page';
    }
    if (options.query) {
      prefix = 'match';
      const query = options.query.toLowerCase(),
        terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      const matches = (text: string) =>
        text.toLowerCase().includes(query) ||
        (terms.length > 1 && terms.every((term) => text.toLowerCase().includes(term)));
      {
        const exact = units.filter((item) => item.unit.text.toLowerCase().includes(query));
        if (exact.length) units = exact;
        else if (document.structure.kind === 'pdf' && terms.length > 1) {
          const pages = new Map<number, typeof units>();
          for (const item of units) {
            const pageIndex = Number(item.unit.locator.value.pageIndex);
            if (!Number.isInteger(pageIndex)) continue;
            const members = pages.get(pageIndex) ?? [];
            members.push(item);
            pages.set(pageIndex, members);
          }
          const ranked: Array<{ item: (typeof units)[number]; score: number }> = [];
          for (const [pageIndex, members] of pages) {
            const text = members.map((item) => item.unit.text).join('\n');
            const matchedTerms = terms.filter((term) => text.toLowerCase().includes(term));
            if (!matchedTerms.length) continue;
            const bounds = [Infinity, Infinity, -Infinity, -Infinity];
            for (const item of members) {
              const rect = array<number>(item.unit.locator.value.rectPt);
              if (rect.length !== 4) continue;
              bounds[0] = Math.min(bounds[0]!, rect[0]!);
              bounds[1] = Math.min(bounds[1]!, rect[1]!);
              bounds[2] = Math.max(bounds[2]!, rect[2]!);
              bounds[3] = Math.max(bounds[3]!, rect[3]!);
            }
            ranked.push({ score: matchedTerms.length, item: {
              index: members[0]!.index,
              unit: {
                locator: {
                  kind: 'pdf-region',
                  value: {
                    pageIndex,
                    searchAggregate: 'pdf-page',
                    ...(Number.isFinite(bounds[0]) ? { rectPt: bounds } : {}),
                  },
                },
                text,
                metadata: {
                  ...members[0]!.unit.metadata,
                  searchAggregate: 'pdf-page',
                  matchedTerms,
                  blockIndices: members.map((item) => item.unit.locator.value.blockIndex),
                },
              },
            } });
          }
          const hasCompletePage = ranked.some(({ score }) => score === terms.length);
          units = ranked
            .filter(({ score }) => !hasCompletePage || score === terms.length)
            .sort((left, right) => right.score - left.score || left.item.index - right.item.index)
            .map(({ item }) => item);
        } else
          units = units.filter((item) =>
            matches(`${item.unit.text} ${JSON.stringify(item.unit.metadata)}`),
          );
      }
    } else if (options.locator) {
      prefix = 'neighborhood';
      const target = options.locator,
        matching = units.find(
          (item) =>
            item.unit.locator.kind === target.kind &&
            (target.kind === 'pdf-region' && target.value.searchAggregate === 'pdf-page'
              ? item.unit.locator.value.pageIndex === target.value.pageIndex
              : Object.entries(target.value).every(
                  ([key, value]) =>
                    key === 'revision' ||
                    JSON.stringify(item.unit.locator.value[key]) === JSON.stringify(value),
                )),
        );
      const nearby = matching
        ? units.filter(
              (item) =>
                item !== matching &&
                (target.kind === 'slide-shape'
                  ? item.unit.locator.value.slideId === target.value.slideId
                  : target.kind === 'pdf-region'
                    ? Math.abs(
                        Number(item.unit.locator.value.pageIndex) - Number(target.value.pageIndex),
                      ) <= 1
                    : Math.abs(item.index - matching.index) <= 1),
            )
        : [];
      units = matching
        ? [matching, ...(target.kind === 'pdf-region'
          ? [0, 1, -1].flatMap((offset) => nearby.filter((item) =>
            Number(item.unit.locator.value.pageIndex) === Number(target.value.pageIndex) + offset))
          : nearby)]
        : [];
    }
    const cursorMatch = options.cursor
      ? new RegExp(`^${prefix}:(\\d+)$`).exec(options.cursor)
      : null;
    if (options.cursor && !cursorMatch) throw new Error('Invalid document cursor');
    const offset = Number(cursorMatch?.[1] ?? 0),
      selected: typeof units = [];
    let size = 0;
    for (const item of units.slice(
      offset,
      offset + Math.max(1, Math.min(options.limit ?? 20, 1000)),
    )) {
      if (size && size + item.unit.text.length > 48000) break;
      size += item.unit.text.length;
      selected.push(item);
    }
    const end = offset + selected.length,
      nextCursor = end < units.length ? `${prefix}:${end}` : null;
    const fragments = selected.map(({ unit, index }) => ({
      fragmentId: `fragment:${source.sourceId}:unit:${index}`,
      locator: unit.locator,
      text: unit.text.slice(0, 16000),
      metadata: { ...unit.metadata, sourceRevision: source.revision },
      citations: [{ sourceId: source.sourceId, locator: unit.locator }],
    }));
    const truncated = selected.some((item) => item.unit.text.length > 16000),
      missingReason =
        [document.missing, truncated ? 'fragment-text-truncated' : null]
          .filter(Boolean)
          .join(';') || null;
    return {
      sourceId: source.sourceId,
      fragments,
      coverage: {
        extent: options.query ? 'query-results' : options.locator ? 'neighborhood' : 'document',
        readRanges: fragments.map((item) => item.locator),
        totalUnits: document.total,
        complete: !nextCursor && !missingReason,
        nextCursor,
        missingReason,
      },
      evidenceStatus: missingReason ? 'degraded' : fragments.length ? 'ok' : 'empty_confirmed',
      usedBackend: document.backend,
      latencyMs: performance.now() - started,
      structure: document.structure,
    };
  }
  async follow(source: SourceRef, fragmentId: string): Promise<SourceRef[]> {
    const nestedPrefix = `fragment:${source.sourceId}:entry:`;
    if (fragmentId.startsWith(nestedPrefix)) {
      const root = sourcePath(source);
      if (!(await stat(root)).isDirectory()) return [];
      const encoded = fragmentId.slice(nestedPrefix.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return [];
      const relativePath = Buffer.from(encoded, 'base64url').toString('utf8');
      const absolutePath = resolve(root, relativePath);
      const rest = relative(root, absolutePath);
      if (!rest || rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) return [];
      await stat(absolutePath);
      return [fileSource(source.taskId, absolutePath, source.sourceId)];
    }
    const parsed = await this.parse(source),
      prefix = `fragment:${source.sourceId}:unit:`;
    if (!fragmentId.startsWith(prefix)) return [];
    const unit = parsed.units[Number(fragmentId.slice(prefix.length))],
      path = unit?.metadata.absolutePath;
    return typeof path === 'string' ? [fileSource(source.taskId, path, source.sourceId)] : [];
  }
}
