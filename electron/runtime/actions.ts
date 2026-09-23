import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, rename, writeFile, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import AdmZip from 'adm-zip';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFNumber,
  PDFRawStream,
  PDFStream,
} from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { POWERPOINT_NATIVE_WINDOW_SCRIPT } from './desktop_scripts';
import { POWERPOINT_TEXT_STYLE_SCRIPT } from './powerpoint_text_styles';
import { FigmaClient } from './desktop_adapters';
import { array, record, sourceRef, insidePath, type Json, type SourceRef } from './context';
import {
  cellAddress,
  cellRange,
  cellValue,
  columnName,
  DocumentReader,
  sharedStrings,
  sourcePath,
  workbookSheets,
  xmlAttrs,
  xmlBuild,
  xmlChildren,
  xmlFind,
  xmlName,
  xmlText,
  zipXml,
  type XmlNode,
} from './context_documents';
import { runPowerShellJson } from './desktop';
import type {
  OperationBackend,
  OperationReadResult,
  OperationWriteResult,
  PatchOperation,
} from './artifacts';

export function minimalTextChange(
  before: string,
  after: string,
): { start: number; length: number; replacement: string } {
  let start = 0,
    suffix = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  return {
    start,
    length: before.length - start - suffix,
    replacement: after.slice(start, after.length - suffix),
  };
}
const textState = (value: unknown): string => {
  const text = typeof value === 'string' ? value : record(value).text;
  if (typeof text !== 'string') throw new Error('Operation requires text');
  return text;
};
const wrapText = (operation: PatchOperation, text: string): unknown =>
  typeof operation.before === 'string' ? text : { text };
const shapeStyleFields = [
  'bold', 'italic', 'underline', 'fontName', 'fontSize', 'colorRgb',
] as const;
function hasShapeStyleSpans(value: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(record(value), 'styleSpans');
}
function validateShapeTextState(value: unknown): void {
  const state = record(value), text = textState(value), spans = state.styleSpans;
  if (!Array.isArray(spans)) throw new Error('PowerPoint text styleSpans must be an array');
  let offset = 0;
  let previous: Json | null = null;
  for (const raw of spans) {
    const span = record(raw);
    if (
      Object.keys(span).sort().join(',') !==
        ['start', 'length', ...shapeStyleFields].sort().join(',') ||
      !Number.isInteger(span.start) || span.start !== offset ||
      !Number.isInteger(span.length) || Number(span.length) <= 0 ||
      !['bold', 'italic', 'underline'].every((key) => typeof span[key] === 'boolean') ||
      typeof span.fontName !== 'string' || !span.fontName ||
      typeof span.fontSize !== 'number' || !Number.isFinite(span.fontSize) || span.fontSize <= 0 ||
      !Number.isInteger(span.colorRgb) || Number(span.colorRgb) < 0 || Number(span.colorRgb) > 0xffffff ||
      (previous !== null && shapeStyleFields.every((key) => previous![key] === span[key]))
    ) throw new Error('Invalid or unmerged PowerPoint text styleSpans');
    offset += Number(span.length);
    previous = span;
  }
  if (offset !== text.length) throw new Error('PowerPoint text styleSpans must cover TextRange.Text');
}
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function atomicWrite(path: string, data: Buffer | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
function replaceRunText(paragraph: XmlNode, tag: string, before: string, after: string): void {
  const change = minimalTextChange(before, after),
    nodes = xmlFind(xmlChildren(paragraph), tag);
  if (!nodes.length) {
    xmlChildren(paragraph).push({
      [tag === 'w:t' ? 'w:r' : 'a:r']: [{ [tag]: [{ '#text': after }] }],
    });
    return;
  }
  let cursor = 0,
    inserted = false;
  const end = change.start + change.length;
  for (const node of nodes) {
    const text = xmlText(xmlChildren(node)),
      start = cursor;
    cursor += text.length;
    if (cursor < change.start || start > end || (inserted && start >= end)) continue;
    const prefix = text.slice(0, Math.max(0, change.start - start)),
      suffix = text.slice(Math.max(0, end - start));
    node[tag] = [{ '#text': prefix + (inserted ? '' : change.replacement) + suffix }];
    node[':@'] = { ...xmlAttrs(node), 'xml:space': 'preserve' };
    inserted = true;
  }
}
function wordParagraph(
  zip: AdmZip,
  operation: PatchOperation,
): { tree: XmlNode[]; part: string; paragraph: XmlNode } {
  const locator = operation.locator.value,
    part = String(locator.part ?? 'word/document.xml'),
    tree = zipXml(zip, part),
    body = xmlFind(tree, 'w:body')[0];
  let paragraphs: XmlNode[];
  if (operation.locator.kind === 'table-cell' || operation.locator.kind === 'table') {
    const bodyItems = body ? xmlChildren(body).filter((node) => ['w:p', 'w:tbl'].includes(xmlName(node))) : [],
      table = bodyItems.filter((node) => xmlName(node) === 'w:tbl')[Number(locator.tableIndex)],
      row = xmlChildren(table ?? {}).filter((node) => xmlName(node) === 'w:tr')[Number(locator.rowIndex)],
      cell = xmlChildren(row ?? {}).filter((node) => xmlName(node) === 'w:tc')[
        Number(locator.columnIndex)
      ];
    if (!table || bodyItems[Number(locator.bodyIndex)] !== table || !cell)
      throw new Error('Word table cell no longer exists at the bound location');
    paragraphs = xmlChildren(cell).filter((node) => xmlName(node) === 'w:p');
  } else
    paragraphs = body
      ? xmlChildren(body).filter((node) => xmlName(node) === 'w:p')
      : xmlFind(tree, 'w:p');
  const paragraph = paragraphs[Number(locator.paragraphIndex ?? 0)];
  if (!paragraph) throw new Error('Word paragraph no longer exists');
  return { tree, part, paragraph };
}
function excelTarget(zip: AdmZip, operation: PatchOperation) {
  const locator = operation.locator.value,
    sheet = workbookSheets(zip).find(
      (sheet) => sheet.name === (locator.sheet ?? locator.worksheet),
    );
  if (!sheet) throw new Error('Excel worksheet no longer exists');
  const range = cellRange(String(locator.range ?? locator.address)),
    tree = zipXml(zip, sheet.path),
    strings = sharedStrings(zip);
  return { sheet, range, tree, strings };
}
function excelMatrix(zip: AdmZip, operation: PatchOperation): unknown[][] {
  const {
      range: [x1, y1, x2, y2],
      tree,
      strings,
    } = excelTarget(zip, operation),
    cells = new Map(xmlFind(tree, 'c').map((node) => [String(xmlAttrs(node).r), node]));
  return Array.from({ length: y2 - y1 + 1 }, (_, row) =>
    Array.from({ length: x2 - x1 + 1 }, (_, column) => {
      const cell = cells.get(`${columnName(x1 + column)}${y1 + row}`);
      return cell ? cellValue(cell, strings) : null;
    }),
  );
}
function writeExcel(zip: AdmZip, operation: PatchOperation): void {
  const {
      sheet,
      range: [x1, y1, x2, y2],
      tree,
    } = excelTarget(zip, operation),
    values = array<unknown[]>(operation.after);
  if (
    values.length !== y2 - y1 + 1 ||
    values.some((row) => !Array.isArray(row) || row.length !== x2 - x1 + 1)
  )
    throw new Error('Excel matrix does not match target range');
  const merges = xmlFind(tree, 'mergeCell').map((node) => cellRange(String(xmlAttrs(node).ref))),
    data = xmlFind(tree, 'sheetData')[0];
  if (!data) throw new Error('Missing worksheet data');
  for (let r = y1; r <= y2; r++)
    for (let c = x1; c <= x2; c++) {
      if (
        merges.some(([a, b, x, y]) => c >= a && c <= x && r >= b && r <= y && (c !== a || r !== b))
      )
        throw new Error('Cannot write a non-anchor merged cell');
    }
  for (let r = y1; r <= y2; r++) {
    let row = xmlChildren(data).find(
      (node) => xmlName(node) === 'row' && Number(xmlAttrs(node).r) === r,
    );
    if (!row) {
      row = { row: [], ':@': { r: String(r) } };
      xmlChildren(data).push(row);
      xmlChildren(data).sort((a, b) => Number(xmlAttrs(a).r) - Number(xmlAttrs(b).r));
    }
    for (let c = x1; c <= x2; c++) {
      const address = `${columnName(c)}${r}`,
        value = values[r - y1]![c - x1];
      let cell = xmlChildren(row).find((node) => xmlAttrs(node).r === address);
      if (!cell) {
        cell = { c: [], ':@': { r: address } };
        xmlChildren(row).push(cell);
        xmlChildren(row).sort(
          (a, b) => cellAddress(String(xmlAttrs(a).r))[0] - cellAddress(String(xmlAttrs(b).r))[0],
        );
      }
      const attrs = { ...xmlAttrs(cell) };
      delete attrs.t;
      cell[':@'] = attrs;
      if (value === null || value === undefined) cell.c = [];
      else if (typeof value === 'string' && value.startsWith('='))
        cell.c = [{ f: [{ '#text': value.slice(1) }] }];
      else if (typeof value === 'number') cell.c = [{ v: [{ '#text': String(value) }] }];
      else if (typeof value === 'boolean') {
        attrs.t = 'b';
        cell.c = [{ v: [{ '#text': value ? '1' : '0' }] }];
      } else {
        attrs.t = 'inlineStr';
        cell.c = [{ is: [{ t: [{ '#text': String(value) }], ':@': { 'xml:space': 'preserve' } }] }];
      }
    }
  }
  zip.updateFile(sheet.path, Buffer.from(xmlBuild(tree)));
}
const wordBind = String.raw`
$window = $null
foreach ($candidate in @($application.Windows)) {
 if ([int64]$candidate.Hwnd -eq [int64]$p.hwnd -and [string]::Equals([string]$candidate.Document.FullName,[string]$p.path,[StringComparison]::OrdinalIgnoreCase)) { $window=$candidate; break }
}
if ($null -eq $window) { throw "bound_word_document_not_found" }
$document=$window.Document
`;
const wordTargetRange = String.raw`
$story=[string]$p.story
if(-not $story -or $story -eq 'body'){
 $range=$document.Range([int]$p.start,[int]$p.end)
} elseif($story -eq 'header' -or $story -eq 'footer'){
 $section=$document.Sections.Item([int]$p.sectionIndex+1)
 if($story -eq 'header'){$part=$section.Headers.Item([int]$p.variantIndex)}
 else {$part=$section.Footers.Item([int]$p.variantIndex)}
 $paragraph=$part.Range.Paragraphs.Item([int]$p.paragraphIndex+1)
 $range=$paragraph.Range.Duplicate
 if([int]$p.start -lt [int]$range.Start -or [int]$p.end -gt [int]$range.End){throw 'live_word_range_changed'}
 $range.SetRange([int]$p.start,[int]$p.end)
} else {throw 'unsupported_word_story'}
`;
const excelBind = String.raw`
$window=$null; $workbook=$null
foreach ($book in @($application.Workbooks)) {
 if (-not [string]::Equals([string]$book.FullName,[string]$p.path,[StringComparison]::OrdinalIgnoreCase)) { continue }
 foreach ($candidate in @($book.Windows)) { if ([int64]$candidate.HWND -eq [int64]$p.hwnd) { $window=$candidate; $workbook=$book; break } }
 if ($null -ne $window) { break }
}
if ($null -eq $window) { throw "bound_excel_workbook_not_found" }
$worksheet=$workbook.Worksheets.Item([string]$p.sheet)
$range=$worksheet.Range([string]$p.address)
`;
async function officeCom(
  host: 'Word' | 'Excel',
  body: string,
  payload: Json,
  signal?: AbortSignal,
): Promise<Json> {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return runPowerShellJson(
    `$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n$result=[ordered]@{ok=$false;wrote=$false;error=$null;value=$null}\ntry { $application=[Runtime.InteropServices.Marshal]::GetActiveObject('${host}.Application')\n${host === 'Word' ? wordBind : excelBind}\n${body}\n} catch {$result.error=[string]$_.Exception.Message}\n$result|ConvertTo-Json -Depth 30 -Compress`,
    signal,
    15000,
  );
}
const excelRead = String.raw`
$rows=@()
for ($r=1;$r -le [int]$range.Rows.Count;$r++) {
 $row=@()
 for ($c=1;$c -le [int]$range.Columns.Count;$c++) { $cell=$range.Cells.Item($r,$c); $formula=[string]$cell.Formula; $row += $(if ($formula.StartsWith('=')) {$formula} else {$cell.Value2}) }
 $rows += ,$row
}
$result.value=$rows; $result.ok=$true
`;
export class DocumentOperationBackend implements OperationBackend {
  private sources: Map<string, SourceRef>;
  private changed = new Set<string>();
  constructor(
    sources: SourceRef[],
    private figmaConnections: Json[] = [],
    private signal?: AbortSignal,
  ) {
    this.sources = new Map(sources.map((source) => [source.sourceId, sourceRef(source)]));
  }
  private source(operation: PatchOperation): SourceRef {
    const source = this.sources.get(operation.sourceId);
    if (!source || !(source.capabilities.includes('patch') ||
      operation.operation === 'move_file' && source.capabilities.includes('move_file')))
      throw new Error('Document source does not allow patch');
    return source;
  }
  async readCurrent(operation: PatchOperation): Promise<OperationReadResult> {
    let backend = 'document.operations';
    try {
      const source = this.source(operation);
      backend = this.backend(source, operation);
      const value = await this.read(source, operation);
      return { ok: true, value, usedBackend: backend };
    } catch (error) {
      return { ok: false, usedBackend: backend, error: String(error) };
    }
  }
  async execute(operation: PatchOperation): Promise<OperationWriteResult> {
    let backend = 'document.operations',
      wrote = false;
    try {
      const source = this.source(operation);
      backend = this.backend(source, operation);
      const before = await this.read(source, operation);
      if (!isDeepStrictEqual(before, operation.before)) throw new Error('base_mismatch');
      await this.write(source, operation);
      wrote = true;
      this.changed.add(operation.operationId);
      const after = await this.read(source, operation);
      if (!isDeepStrictEqual(after, operation.after))
        return { ok: false, wrote, usedBackend: backend, error: 'write_readback_mismatch' };
      return { ok: true, wrote, usedBackend: backend };
    } catch (error) {
      return {
        ok: false,
        wrote: wrote || record(error).wrote === true,
        usedBackend: backend,
        error: String(error),
      };
    }
  }
  private backend(source: SourceRef, operation: PatchOperation): string {
    return operation.locator.kind === 'figma-node'
      ? 'figma.plugin'
      : source.identity.hwnd
        ? 'office.com.powershell'
        : operation.operation === 'add_pdf_annotation'
          ? 'pdf.pdf-lib'
          : ['create_file', 'move_file'].includes(operation.operation)
            ? 'document.files'
            : 'office.ooxml';
  }
  private async read(source: SourceRef, operation: PatchOperation): Promise<unknown> {
    this.signal?.throwIfAborted();
    if (operation.locator.kind === 'figma-node') return this.figma(source, operation, false);
    if (operation.operation === 'create_file') {
      const state = record(operation.after),
        path = String(state.path);
      if (!(await exists(path))) return operation.before;
      const parsed = await new DocumentReader().parse({
        ...source,
        identity: { absolutePath: path },
        revision: {},
      });
      if (!parsed.units.length || parsed.structure.kind !== state.format)
        return { ...state, conflict: 'output_content_mismatch' };
      const content = record(state.content),
        actual = parsed.units.map((unit) => unit.text).join('\n'),
        expected = [content.title, ...array(content.paragraphs)].filter(
          (value) => typeof value === 'string',
        );
      if (expected.some((value) => !actual.includes(String(value))))
        return { ...state, conflict: 'output_content_mismatch' };
      if (state.format === 'xlsx') {
        const specs = array<Json>(content.sheets),
          sheets = array<Json>(parsed.structure.sheets);
        for (const [index, spec] of specs.entries())
          for (const [rowIndex, row] of array<unknown[]>(spec.rows).entries())
            for (const [columnIndex, value] of row.entries()) {
              if (value === null || value === undefined || value === '') continue;
              const cell = parsed.units.find(
                (unit) =>
                  unit.metadata.sheet === sheets[index]?.name &&
                  unit.metadata.address === `${columnName(columnIndex + 1)}${rowIndex + 1}`,
              );
              const expectedValue =
                typeof value === 'object' && record(value).formula
                  ? `=${String(record(value).formula).replace(/^=/, '')}`
                  : value;
              if (!cell || !isDeepStrictEqual(cell.metadata.value, expectedValue))
                return { ...state, conflict: 'output_cell_mismatch' };
            }
      }
      const expectedTables = array<Json>(content.tables)
        .flatMap((table) => array<unknown[]>(table.rows).flat())
        .concat(
          array<Json>(content.slides).flatMap((slide) => [
            slide.title,
            ...array(slide.paragraphs),
            ...array<Json>(slide.tables).flatMap((table) => array<unknown[]>(table.rows).flat()),
          ]),
        )
        .filter((value) => typeof value === 'string' || typeof value === 'number');
      if (expectedTables.some((value) => !actual.includes(String(value))))
        return { ...state, conflict: 'output_content_mismatch' };
      if (state.format === 'docx') {
        const wanted = array<Json>(content.tables).flatMap((table, tableIndex) =>
          array<unknown[]>(table.rows).map((row, rowIndex) => ({
            tableIndex,
            rowIndex,
            cells: row.map((value) => String(value ?? '')),
          })),
        );
        const observed = parsed.units
          .filter((unit) => unit.locator.kind === 'table')
          .map((unit) => ({
            tableIndex: unit.metadata.tableIndex,
            rowIndex: unit.metadata.rowIndex,
            cells: unit.metadata.cells,
          }));
        if (!isDeepStrictEqual(observed, wanted))
          return { ...state, conflict: 'output_table_mismatch' };
      }
      if (state.format === 'pptx') {
        const wanted: { slideIndex: number; tableRowIndex: number; cells: string[] }[] = [];
        let slideIndex = 0;
        for (const slide of array<Json>(content.slides)) {
          slideIndex++;
          for (const table of array<Json>(slide.tables)) {
            const rows = array<unknown[]>(table.rows);
            for (let offset = 0; offset < rows.length; offset += 10) {
              rows.slice(offset, offset + 10).forEach((row, tableRowIndex) =>
                wanted.push({
                  slideIndex,
                  tableRowIndex,
                  cells: row.map((value) => String(value ?? '').replace(/\s+/g, ' ').trim()),
                }),
              );
              slideIndex++;
            }
          }
          slideIndex += array(slide.images).length;
        }
        const observed = parsed.units
          .filter((unit) => unit.metadata.contentKind === 'table')
          .map((unit) => ({
            slideIndex: unit.metadata.slideIndex,
            tableRowIndex: unit.metadata.tableRowIndex,
            cells: unit.metadata.cells,
          }));
        if (!isDeepStrictEqual(observed, wanted))
          return { ...state, conflict: 'output_table_mismatch' };
      }
      return operation.after;
    }
    if (operation.operation === 'move_file') {
      const before = record(operation.before),
        after = record(operation.after);
      if ((await exists(String(before.path))) && !(await exists(String(after.path)))) return before;
      if (!(await exists(String(before.path))) && (await exists(String(after.path)))) return after;
      return { conflict: 'move_paths_ambiguous' };
    }
    if (operation.operation === 'add_pdf_annotation') return this.pdf(source, operation, false);
    if (operation.operation.startsWith('set_shape_'))
      return this.powerpoint(source, operation, false);
    const path = source.identity.hwnd && (source.identity.documentPath || source.identity.workbookPath)
        ? String(source.identity.documentPath ?? source.identity.workbookPath) : sourcePath(source),
      hwnd = Number(source.identity.hwnd),
      locator = operation.locator.value;
    if (hwnd > 0 && operation.operation === 'replace_text') {
      const start = Number(locator.start),
        before = textState(operation.before),
        after = textState(operation.after);
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(locator.end))
        throw new Error('Live Word needs exact start and end');
      const end = this.changed.has(operation.operationId)
          ? start + after.length
          : Number(locator.end),
        target = { path, hwnd, story: locator.story ?? 'body', start, end,
          sectionIndex: locator.sectionIndex, variantIndex: locator.variantIndex,
          paragraphIndex: locator.paragraphIndex },
        data = await officeCom(
          'Word',
          `${wordTargetRange}\n$result.value=[string]$range.Text; $result.ok=$true`,
          target,
          this.signal,
        );
      if (!data.ok)
        throw Object.assign(new Error(String(data.error)), { wrote: data.wrote === true });
      const text = String(data.value ?? '');
      if (
        text !== before &&
        !this.changed.has(operation.operationId) &&
        after.length !== before.length
      ) {
        const fresh = await officeCom(
          'Word',
          `${wordTargetRange}\n$result.value=[string]$range.Text; $result.ok=$true`,
          { ...target, end: start + after.length },
          this.signal,
        );
        if (fresh.ok && fresh.value === after) return wrapText(operation, after);
      }
      return wrapText(operation, text);
    }
    if (hwnd > 0 && operation.operation === 'set_cell_values') {
      const data = await officeCom(
        'Excel',
        excelRead,
        {
          path,
          hwnd,
          sheet: locator.sheet ?? locator.worksheet,
          address: locator.range ?? locator.address,
        },
        this.signal,
      );
      if (!data.ok) throw new Error(String(data.error));
      return data.value;
    }
    const zip = new AdmZip(await readFile(path));
    if (operation.operation === 'replace_text' && extname(path).toLowerCase() === '.docx')
      return wrapText(
        operation,
        xmlText(xmlChildren(wordParagraph(zip, operation).paragraph), 'w:t'),
      );
    if (operation.operation === 'set_cell_values' && extname(path).toLowerCase() === '.xlsx')
      return excelMatrix(zip, operation);
    throw new Error(`Unsupported document operation ${operation.operation}`);
  }
  private async write(source: SourceRef, operation: PatchOperation): Promise<void> {
    if (operation.locator.kind === 'figma-node') {
      await this.figma(source, operation, true);
      return;
    }
    if (operation.operation === 'create_file') {
      await createOfficeFile(operation);
      return;
    }
    if (operation.operation === 'move_file') {
      const oldPath = resolve(String(record(operation.before).path)),
        newPath = resolve(String(record(operation.after).path)),
        sourcePath = String(source.identity.absolutePath ?? source.identity.path ?? '');
      if (!sourcePath) throw new Error('Move source path missing');
      const root = source.identity.moveRoot
        ? String(source.identity.moveRoot)
        : (await stat(sourcePath).catch(() => null))?.isDirectory() ? sourcePath : dirname(sourcePath);
      if (!insidePath(oldPath, root) || !insidePath(newPath, root))
        throw new Error('Move outside source scope');
      if (await exists(newPath)) throw new Error('Move destination already exists');
      await mkdir(dirname(newPath), { recursive: true });
      await rename(oldPath, newPath);
      return;
    }
    if (operation.operation === 'add_pdf_annotation') {
      await this.pdf(source, operation, true);
      return;
    }
    if (operation.operation.startsWith('set_shape_')) {
      await this.powerpoint(source, operation, true);
      return;
    }
    const path = source.identity.hwnd && (source.identity.documentPath || source.identity.workbookPath)
        ? String(source.identity.documentPath ?? source.identity.workbookPath) : sourcePath(source),
      hwnd = Number(source.identity.hwnd),
      locator = operation.locator.value;
    if (hwnd > 0 && operation.operation === 'replace_text') {
      const change = minimalTextChange(textState(operation.before), textState(operation.after)),
        start = Number(locator.start),
        data = await officeCom(
          'Word',
          `${wordTargetRange}\n` + String.raw`
if (-not [string]::Equals([string]$range.Text,[string]$p.expected,[StringComparison]::Ordinal)) {throw 'base_mismatch'}
$change=$range.Duplicate
$change.SetRange([int]$p.changeStart,[int]$p.changeEnd)
$change.Text=[string]$p.replacement
$result.ok=$true;$result.wrote=$true`,
          {
            path,
            hwnd,
            story: locator.story ?? 'body',
            sectionIndex: locator.sectionIndex,
            variantIndex: locator.variantIndex,
            paragraphIndex: locator.paragraphIndex,
            start,
            end: locator.end,
            expected: textState(operation.before),
            changeStart: start + change.start,
            changeEnd: start + change.start + change.length,
            replacement: change.replacement,
          },
          this.signal,
        );
      if (!data.ok) throw new Error(String(data.error));
      return;
    }
    if (hwnd > 0 && operation.operation === 'set_cell_values') {
      const after = array<unknown[]>(operation.after),
        before = array<unknown[]>(operation.before),
        [x1, y1, x2, y2] = cellRange(String(locator.range ?? locator.address));
      if (
        [before, after].some(
          (matrix) =>
            matrix.length !== y2 - y1 + 1 ||
            matrix.some((row) => !Array.isArray(row) || row.length !== x2 - x1 + 1),
        )
      )
        throw new Error('Excel matrix shape mismatch');
      const data = await officeCom(
        'Excel',
        excelRead +
          String.raw`
$result.ok=$false
if (($rows | ConvertTo-Json -Depth 16 -Compress) -cne ($p.expected | ConvertTo-Json -Depth 16 -Compress)) { throw 'base_mismatch' }
for ($r=1;$r -le [int]$range.Rows.Count;$r++) {
 for ($c=1;$c -le [int]$range.Columns.Count;$c++) {
  $next=$p.after[$r-1][$c-1]
  $cell=$range.Cells.Item($r,$c)
  if ($next -is [string]) {
   if ($next.StartsWith('=')) { $cell.Formula=[string]$next }
   else { $cell.Value2=[string]$next }
  } else { $cell.Value2=$next }
  $result.wrote=$true
 }
}
$result.ok=$true`,
        {
          path,
          hwnd,
          sheet: locator.sheet ?? locator.worksheet,
          address: locator.range ?? locator.address,
          expected: before,
          after,
        },
        this.signal,
      );
      if (!data.ok)
        throw Object.assign(new Error(String(data.error)), { wrote: data.wrote === true });
      return;
    }
    const zip = new AdmZip(await readFile(path));
    if (operation.operation === 'replace_text') {
      const { paragraph, tree, part } = wordParagraph(zip, operation);
      replaceRunText(paragraph, 'w:t', textState(operation.before), textState(operation.after));
      zip.updateFile(part, Buffer.from(xmlBuild(tree)));
    } else if (operation.operation === 'set_cell_values') writeExcel(zip, operation);
    else throw new Error('Unsupported Office operation');
    await atomicWrite(path, zip.toBuffer());
  }
  private async powerpoint(
    source: SourceRef,
    operation: PatchOperation,
    write: boolean,
  ): Promise<unknown> {
    const locator = operation.locator.value,
      path = source.identity.host === 'powerpoint' && source.revision.authority === 'live'
        ? String(source.identity.presentationPath ?? '') : sourcePath(source),
      hwnd = Number(source.identity.hwnd);
    if (!path || !(hwnd > 0) || !Number.isInteger(locator.slideId) || !Number.isInteger(locator.shapeId))
      throw new Error('PowerPoint requires native window, slideId and shapeId');
    const before = record(operation.before),
      after = record(operation.after);
    if (operation.operation === 'set_shape_style')
      for (const value of [before, after])
        for (const [key, item] of Object.entries(value))
          if (
            !['fillRgb', 'lineRgb'].includes(key) ||
            (item !== null &&
              (!Number.isInteger(item) || Number(item) < 0 || Number(item) > 0xffffff))
          )
            throw new Error('Invalid shape style');
    if (operation.operation === 'set_shape_geometry')
      for (const value of [before, after])
        for (const [key, item] of Object.entries(value))
          if (
            !['left', 'top', 'width', 'height'].includes(key) ||
            typeof item !== 'number' ||
            !Number.isFinite(item) ||
            (['width', 'height'].includes(key) && item <= 0)
          )
            throw new Error('Invalid shape geometry');
    const styled = operation.operation === 'set_shape_text' && hasShapeStyleSpans(operation.before);
    if (operation.operation === 'set_shape_text') {
      if (hasShapeStyleSpans(operation.before) !== hasShapeStyleSpans(operation.after))
        throw new Error('PowerPoint text before/after styleSpans must match');
      if ((typeof operation.before === 'string') !== (typeof operation.after === 'string'))
        throw new Error('PowerPoint text before/after shape must match');
      if (styled) {
        validateShapeTextState(operation.before);
        validateShapeTextState(operation.after);
      }
    }
    const change = operation.operation === 'set_shape_text'
      ? minimalTextChange(textState(operation.before), textState(operation.after))
      : null;
    const payload = {
      path,
      hwnd,
      slideId: locator.slideId,
      shapeId: locator.shapeId,
      before: operation.before,
      after: operation.after,
      operation: operation.operation,
      write,
      change,
      styled,
    };
    const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__'))|ConvertFrom-Json
__NATIVE__
${POWERPOINT_TEXT_STYLE_SCRIPT}
function Find-Shape($shapes,$id) { for($i=1;$i -le $shapes.Count;$i++) { $shape=$shapes.Item($i); if($shape.Id -eq $id){return $shape}; if($shape.Type -eq 6){$nested=Find-Shape $shape.GroupItems $id;if($null -ne $nested){return $nested}} }; return $null }
function Same-MpFont($a,$b) {
 return ([bool]$a.bold -eq [bool]$b.bold -and [bool]$a.italic -eq [bool]$b.italic -and
  [bool]$a.underline -eq [bool]$b.underline -and
  [string]::Equals([string]$a.fontName,[string]$b.fontName,[StringComparison]::Ordinal) -and
  [double]$a.fontSize -eq [double]$b.fontSize -and [int64]$a.colorRgb -eq [int64]$b.colorRgb)
}
function Same-MpTextStyles($actual,$expected) {
 $left=@($actual);$right=@($expected)
 if($left.Count -ne $right.Count){return $false}
 for($i=0;$i -lt $left.Count;$i++){
  $a=$left[$i];$b=$right[$i]
  if([int]$a.start -ne [int]$b.start -or [int]$a.length -ne [int]$b.length -or
     -not (Same-MpFont $a $b)){return $false}
 }
 return $true
}
$result=[ordered]@{ok=$false;wrote=$false;value=$null;error=$null}
try {
 $window=[MpPowerPointWindow]::FromHandle([int64]$p.hwnd)
 $presentation=$window.Presentation
 if($null -eq $presentation -or -not [string]::Equals([string]$presentation.FullName,[string]$p.path,[StringComparison]::OrdinalIgnoreCase)){throw 'bound_presentation_not_found'}
 $slide=$presentation.Slides.FindBySlideID([int]$p.slideId);$shape=Find-Shape $slide.Shapes ([int]$p.shapeId)
 if($null -eq $shape){throw 'bound_shape_not_found'}
  if($p.operation -eq 'set_shape_text') {
   $range=$shape.TextFrame.TextRange
   $value=[string]$range.Text
   if($p.styled){$value=[ordered]@{text=$value;styleSpans=@(Read-MpTextStyles $range)}}
   elseif($p.before -isnot [string]){$value=@{text=$value}}
  }
 elseif($p.operation -eq 'set_shape_geometry') {$value=[ordered]@{};foreach($prop in $p.after.PSObject.Properties){$value[$prop.Name]=[double]$shape.($prop.Name)}}
 else {$value=[ordered]@{};foreach($prop in $p.after.PSObject.Properties){$native=if($prop.Name -eq 'fillRgb'){$shape.Fill}else{$shape.Line};$value[$prop.Name]=$(if([int]$native.Visible -eq -1){[int64]$native.ForeColor.RGB}else{$null})}}
 if($p.write){
  if([int]$shape.Locked -eq -1){throw 'shape_locked'}
   if($p.operation -ne 'set_shape_text') {foreach($prop in $p.before.PSObject.Properties){if($p.before -isnot [string] -and $prop.Name -notin @('Length')){if($value.($prop.Name) -cne $prop.Value){throw 'base_mismatch'}}}}
   if($p.operation -eq 'set_shape_text'){
    $expected=if($p.before -is [string]){$p.before}else{$p.before.text}
    $range=$shape.TextFrame.TextRange;if(-not [string]::Equals([string]$range.Text,[string]$expected,[StringComparison]::Ordinal)){throw 'base_mismatch'}
    $styles=@(Read-MpTextStyles $range)
    if($p.styled -and -not (Same-MpTextStyles $styles $p.before.styleSpans)){throw 'base_mismatch'}
    $start=[int]$p.change.start;$removed=[int]$p.change.length;$replacement=[string]$p.change.replacement
    if(-not $p.styled){
     $affected=0
     foreach($span in $styles){if([int]$span.start -lt ($start+$removed) -and ([int]$span.start+[int]$span.length) -gt $start){$affected++}}
     if($affected -gt 1 -or ($removed -eq 0 -and $replacement.Length -gt 0 -and $start -gt 0 -and $start -lt [int]$range.Length -and @($styles | Where-Object {[int]$_.start -eq $start}).Count -gt 0)){throw 'style_mapping_required'}
    }
    if($removed -gt 0){$range.Characters(($start+1),$removed).Text=$replacement;$result.wrote=$true}
    elseif($replacement.Length -gt 0){if($start -ge [int]$range.Length){$range.InsertAfter($replacement)|Out-Null}else{$range.Characters(($start+1),1).InsertBefore($replacement)|Out-Null};$result.wrote=$true}
    if($p.styled){
     $range=$shape.TextFrame.TextRange
     if(-not [string]::Equals([string]$range.Text,[string]$p.after.text,[StringComparison]::Ordinal)){throw 'text_write_readback_mismatch'}
     $currentStyles=@(Read-MpTextStyles $range)
     foreach($span in $p.after.styleSpans){
      foreach($current in $currentStyles){
       $left=[Math]::Max([int]$span.start,[int]$current.start)
       $right=[Math]::Min(([int]$span.start+[int]$span.length),([int]$current.start+[int]$current.length))
       if($right -le $left -or (Same-MpFont $current $span)){continue}
       $font=$range.Characters(($left+1),($right-$left)).Font
       $result.wrote=$true
       $font.Name=[string]$span.fontName;$font.Size=[double]$span.fontSize
       $font.Color.RGB=[int64]$span.colorRgb
       $font.Bold=$(if([bool]$span.bold){-1}else{0})
       $font.Italic=$(if([bool]$span.italic){-1}else{0})
       $font.Underline=$(if([bool]$span.underline){-1}else{0})
      }
     }
    }
   }elseif($p.operation -eq 'set_shape_geometry'){foreach($prop in $p.after.PSObject.Properties){$shape.($prop.Name)=[double]$prop.Value}}
   else{foreach($prop in $p.after.PSObject.Properties){$native=if($prop.Name -eq 'fillRgb'){$shape.Fill}else{$shape.Line};if($null -eq $prop.Value){$native.Visible=0}else{$native.ForeColor.RGB=[int64]$prop.Value;$native.Visible=-1}}}
   if($p.operation -ne 'set_shape_text'){$result.wrote=$true}
 }
 $result.value=$value;$result.ok=$true
}catch{$result.error=[string]$_.Exception.Message}
$result|ConvertTo-Json -Depth 20 -Compress
`
      .replace('__PAYLOAD__', Buffer.from(JSON.stringify(payload)).toString('base64'))
      .replace('__NATIVE__', POWERPOINT_NATIVE_WINDOW_SCRIPT);
    const result = await runPowerShellJson(script, this.signal, 15000);
    if (!result.ok)
      throw Object.assign(new Error(String(result.error)), { wrote: result.wrote === true });
    return result.value;
  }
  private async figma(
    source: SourceRef,
    operation: PatchOperation,
    write: boolean,
  ): Promise<unknown> {
    const connection = this.figmaConnections.find(
      (item) =>
        item.taskId === source.taskId &&
        item.documentSessionId === source.identity.documentSessionId,
    );
    if (!connection) throw new Error('figma-current-document-connection-required');
    const nodeId = String(operation.locator.value.nodeId),
      client = new FigmaClient(connection);
    const request = (command: string, argumentsValue: Json) =>
      client.request(command, argumentsValue, this.signal);
    const data = await request('read_nodes', { nodeIds: [nodeId] }),
      node = array<Json>(data.nodes).find((item) => item.id === nodeId);
    if (!node) throw new Error('figma-node-not-found');
    let value: unknown, plugin: Json;
    const after = record(operation.after),
      before = record(operation.before),
      locator = operation.locator.value;
    if (operation.operation === 'replace_text') {
      const text = String(node.characters ?? ''),
        start = Number(locator.textStart ?? 0),
        end = this.changed.has(operation.operationId)
          ? start + textState(operation.after).length
          : Number(locator.textEnd ?? text.length);
      value = text.slice(start, end);
      plugin = {
        op: 'replace_text',
        nodeId,
        start,
        end,
        before: operation.before,
        after: operation.after,
      };
    } else if (operation.operation === 'set_figma_fill') {
      const fill = array<Json>(node.fills)[0] ?? {},
        color = record(fill.color);
      value = { r: color.r, g: color.g, b: color.b, a: fill.opacity ?? 1 };
      plugin = { op: 'set_fill', nodeId, before: node.fills, after: operation.after };
    } else if (operation.operation === 'set_figma_spacing') {
      if (before.property !== after.property)
        throw new Error('Figma spacing property cannot change');
      value = { property: after.property, value: node[String(after.property)] };
      plugin = {
        op: 'set_spacing',
        nodeId,
        property: after.property,
        before: before.value,
        after: after.value,
      };
    } else if (operation.operation === 'set_figma_size') {
      value = { width: node.width, height: node.height };
      plugin = { op: 'resize', nodeId, before: operation.before, after: operation.after };
    } else if (operation.operation === 'set_figma_position') {
      value = { x: node.x, y: node.y };
      plugin = { op: 'move', nodeId, before: operation.before, after: operation.after };
    } else throw new Error('Unsupported Figma operation');
    if (write) {
      if (!isDeepStrictEqual(value, operation.before)) throw new Error('base_mismatch');
      await request('apply_patch', { operations: [plugin] });
    }
    return value;
  }
  private async pdf(
    source: SourceRef,
    operation: PatchOperation,
    write: boolean,
  ): Promise<unknown> {
    const original = sourcePath(source),
      before = record(operation.before),
      after = record(operation.after),
      output = resolve(String(after.outputPath)),
      locator = operation.locator.value;
    if (output.toLowerCase() === original.toLowerCase())
      throw new Error('PDF annotation requires an output copy');
    if (
      before.annotationId !== after.annotationId ||
      before.present === after.present ||
      !['highlight', 'text-note', 'visual-overlay'].includes(String(after.kind))
    )
      throw new Error('Invalid annotation transition');
    const outputExists = await exists(output),
      binding = JSON.stringify([source.taskId, source.sourceId, original]);
    if (!outputExists && !write) return before.present ? after : before;
    const document = await PDFDocument.load(await readFile(outputExists ? output : original)),
      key = PDFName.of('MagicPointerSource'),
      bound = document.catalog.get(key);
    if (
      outputExists &&
      (!(bound instanceof PDFString || bound instanceof PDFHexString) ||
        bound.decodeText() !== binding)
    )
      throw new Error('PDF output already exists and is not bound to this source');
    const page = document.getPages()[Number(locator.pageIndex)];
    if (!page) throw new Error('PDF page no longer exists');
    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      annots = document.context.obj([]);
      page.node.set(PDFName.of('Annots'), annots);
    }
    const id = `Magic Pointer ${after.annotationId}`;
    let found: PDFDict | undefined,
      foundIndex = -1;
    for (let index = 0; index < annots.size(); index++) {
      const dict = annots.lookup(index, PDFDict),
        subject = dict.get(PDFName.of('Subj'));
      if (
        (subject instanceof PDFString || subject instanceof PDFHexString) &&
        subject.decodeText() === id
      ) {
        found = dict;
        foundIndex = index;
        break;
      }
    }
    if (!write) {
      if (!found) return before.present ? after : before;
      const contentsObject = found.get(PDFName.of('Contents'));
      const contents =
          contentsObject instanceof PDFString || contentsObject instanceof PDFHexString
            ? contentsObject.decodeText()
            : '',
        observed: Json = { ...after, present: true };
      if ('text' in after || contents) observed.text = contents;
      const subtype = found.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
      observed.kind =
        subtype === '/Highlight'
          ? 'highlight'
          : subtype === '/Text'
            ? 'text-note'
            : 'visual-overlay';
      if (observed.kind === 'visual-overlay') {
        const appearance = found.lookupMaybe(PDFName.of('AP'), PDFDict)
          ?.lookupMaybe(PDFName.of('N'), PDFStream) as PDFRawStream | undefined;
        const appearanceContent = appearance
          ?.getContentsString() ?? '';
        const color = (operator: 'rg' | 'RG'): number[] | null => {
          const match = new RegExp(`([0-9.]+) ([0-9.]+) ([0-9.]+) ${operator}\\b`).exec(appearanceContent);
          return match ? match.slice(1, 4).map(Number) : null;
        };
        const fill = color('rg'),
          stroke = color('RG'),
          savedFill = found.lookupMaybe(PDFName.of('C'), PDFArray),
          catalogFill = savedFill?.size() === 3
            ? [0, 1, 2].map((index) => savedFill.lookup(index, PDFNumber).asNumber())
            : null;
        if ('fillColor' in after) observed.fillColor = fill;
        if ('strokeColor' in after) observed.strokeColor = stroke;
        if (!fill || !stroke || !isDeepStrictEqual(fill, catalogFill))
          observed.conflict = 'annotation_appearance_changed';
      }
      const rect = array<number>(locator.rectPt),
        height = page.getHeight(),
        width = page.getWidth(),
        rotation = page.getRotation().angle;
      const point = (x: number, y: number): [number, number] =>
        locator.coordinateSpace !== 'rotated-page-points'
          ? [x, height - y]
          : rotation === 90
            ? [y, x]
            : rotation === 180
              ? [width - x, y]
              : rotation === 270
                ? [width - y, height - x]
                : [x, height - y];
      const corners = [
          point(rect[0]!, rect[1]!),
          point(rect[2]!, rect[1]!),
          point(rect[0]!, rect[3]!),
          point(rect[2]!, rect[3]!),
        ],
        expectedRect = [
          Math.min(...corners.map((p) => p[0])),
          Math.min(...corners.map((p) => p[1])),
          Math.max(...corners.map((p) => p[0])),
          Math.max(...corners.map((p) => p[1])),
        ],
        storedRect = found.lookupMaybe(PDFName.of('Rect'), PDFArray);
      if (
        !storedRect ||
        expectedRect.some(
          (value, index) =>
            Math.abs(storedRect.lookup(index, PDFNumber).asNumber() - value) > 0.001,
        )
      )
        observed.conflict = 'annotation_geometry_changed';
      return observed;
    }
    if (!after.present) {
      if (foundIndex < 0) throw new Error('Annotation missing before undo');
      annots.remove(foundIndex);
    } else {
      if (found) throw new Error('Annotation already exists');
      const rect = array<number>(locator.rectPt);
      if (
        rect.length !== 4 ||
        rect.some((value) => !Number.isFinite(value)) ||
        rect[2]! <= rect[0]! ||
        rect[3]! <= rect[1]!
      )
        throw new Error('Invalid PDF rectangle');
      const height = page.getHeight(),
        width = page.getWidth(),
        rotation = page.getRotation().angle;
      const point = (x: number, y: number): [number, number] =>
        locator.coordinateSpace !== 'rotated-page-points'
          ? [x, height - y]
          : rotation === 90
            ? [y, x]
            : rotation === 180
              ? [width - x, y]
              : rotation === 270
                ? [width - y, height - x]
                : [x, height - y];
      const points = [
          point(rect[0]!, rect[1]!),
          point(rect[2]!, rect[1]!),
          point(rect[0]!, rect[3]!),
          point(rect[2]!, rect[3]!),
        ],
        xs = points.map((p) => p[0]),
        ys = points.map((p) => p[1]),
        pdfRect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        subtype =
          after.kind === 'highlight'
            ? 'Highlight'
            : after.kind === 'text-note'
              ? 'Text'
              : 'FreeText';
      let appearanceRef;
      let fillColor = [1, 1, 1];
      if (after.kind === 'visual-overlay') {
        const rgb = (value: unknown, fallback: number[]): number[] => {
          if (value === undefined || value === null) return fallback;
          if (!Array.isArray(value) || value.length !== 3 ||
              value.some((channel) => typeof channel !== 'number' ||
                !Number.isFinite(channel) || channel < 0 || channel > 1))
            throw new Error('PDF annotation color must be three numbers from 0 to 1');
          return value;
        };
        fillColor = rgb(after.fillColor, [1, 1, 1]);
        const strokeColor = rgb(after.strokeColor, [0.8, 0.2, 0.2]),
          fontSize = Number(after.fontSize ?? 10),
          width = pdfRect[2]! - pdfRect[0]!,
          height = pdfRect[3]! - pdfRect[1]!;
        if (!Number.isFinite(fontSize) || fontSize <= 0)
          throw new Error('PDF annotation font size must be positive');
        const escaped = (value: string) => value.replace(/[&<>"']/g, (character) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
        })[character]!);
        const scale = 2;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width * scale)}" height="${Math.ceil(height * scale)}">${String(after.text ?? '').split(/\r?\n/).map((line, index) =>
          `<text x="${4 * scale}" y="${(4 + fontSize * (index + 1) * 1.2) * scale}" font-family="Arial, Microsoft YaHei, sans-serif" font-size="${fontSize * scale}" fill="black">${escaped(line)}</text>`,
        ).join('')}</svg>`;
        const image = await document.embedPng(await sharp(Buffer.from(svg)).png().toBuffer());
        const appearance = document.context.stream(
          `q\n${fillColor.join(' ')} rg\n0 0 ${width} ${height} re f\n${strokeColor.join(' ')} RG\n1 w\n0.5 0.5 ${Math.max(0, width - 1)} ${Math.max(0, height - 1)} re S\nq\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\nQ\n`,
          {
            Type: 'XObject', Subtype: 'Form', FormType: 1,
            BBox: [0, 0, width, height],
            Resources: { XObject: { Im0: image.ref } },
          },
        );
        appearanceRef = document.context.register(appearance);
      }
      const annotation = document.context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: pdfRect,
        T: PDFHexString.fromText('Magic Pointer'),
        Subj: PDFHexString.fromText(id),
        Contents: PDFHexString.fromText(String(after.text ?? '')),
        F: 4,
        C: after.kind === 'highlight' ? [1, 1, 0] : after.kind === 'visual-overlay' ? fillColor : [0.8, 0.2, 0.2],
        ...(after.kind === 'highlight'
          ? {
              QuadPoints: [
                pdfRect[0],
                pdfRect[3],
                pdfRect[2],
                pdfRect[3],
                pdfRect[0],
                pdfRect[1],
                pdfRect[2],
                pdfRect[1],
              ],
            }
          : {}),
        ...(after.kind === 'visual-overlay'
          ? {
              DA: PDFString.of(`/Helv ${Number(after.fontSize ?? 10)} Tf 0 g`),
              AP: { N: appearanceRef },
            }
          : {}),
      });
      annots.push(document.context.register(annotation));
    }
    document.catalog.set(key, PDFHexString.fromText(binding));
    await atomicWrite(output, await document.save());
    return null;
  }
}

export async function createOfficeFile(operation: PatchOperation): Promise<void> {
  const before = record(operation.before),
    after = record(operation.after),
    output = resolve(String(after.path)),
    format = String(after.format),
    content = record(after.content),
    references = array<Json>(after.references);
  if (
    before.exists !== false ||
    after.exists !== true ||
    resolve(String(before.path)) !== output ||
    extname(output).toLowerCase() !== `.${format}`
  )
    throw new Error('Invalid output file contract');
  if (await exists(output)) throw new Error('Output file already exists');
  await mkdir(dirname(output), { recursive: true });
  if (format === 'docx') {
    const { Document, Packer, Paragraph, Table, TableRow, TableCell, HeadingLevel } =
      await import('docx');
    const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
    if (content.title)
      children.push(new Paragraph({ text: String(content.title), heading: HeadingLevel.TITLE }));
    for (const text of array(content.paragraphs)) children.push(new Paragraph(String(text)));
    for (const table of array<Json>(content.tables))
      children.push(
        new Table({
          rows: array<unknown[]>(table.rows).map(
            (row) =>
              new TableRow({
                children: row.map(
                  (value) => new TableCell({ children: [new Paragraph(String(value ?? ''))] }),
                ),
              }),
          ),
        }),
      );
    if (references.length) {
      children.push(new Paragraph({ text: 'Sources', heading: HeadingLevel.HEADING_1 }));
      for (const source of references)
        children.push(
          new Paragraph(
            `${source.label ?? source.sourceId ?? 'Source'} — ${source.sourceId ?? ''}`,
          ),
        );
    }
    await writeFile(output, await Packer.toBuffer(new Document({ sections: [{ children }] })), {
      flag: 'wx',
    });
  } else if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook(),
      specs = array<Json>(content.sheets);
    if (!specs.length) throw new Error('Workbook requires sheets');
    for (const [index, spec] of specs.entries()) {
      const base = String(spec.name ?? `Sheet${index + 1}`)
        .replace(/[\\/*?:[\]]/g, '_')
        .slice(0, 31);
      let name = base,
        suffix = 1;
      while (
        workbook.worksheets.some((sheet) => sheet.name.toLowerCase() === name.toLowerCase()) ||
        (references.length && name.toLowerCase() === '_sources')
      )
        name = `${base.slice(0, 25)} (${suffix++})`;
      const sheet = workbook.addWorksheet(name);
      for (const row of array<unknown[]>(spec.rows))
        sheet.addRow(
          row.map((value) =>
            typeof value === 'string' && value.startsWith('=')
              ? { formula: value.slice(1) }
              : value,
          ),
        );
    }
    if (references.length) {
      const sheet = workbook.addWorksheet('_Sources');
      sheet.addRow(['Label', 'Source ID']);
      for (const source of references)
        sheet.addRow([source.label ?? source.sourceId, source.sourceId]);
    }
    await writeFile(output, Buffer.from(await workbook.xlsx.writeBuffer()), { flag: 'wx' });
  } else if (format === 'pptx') {
    const presentation = new PptxGenJS();
    presentation.layout = 'LAYOUT_WIDE';
    const specs = array<Json>(content.slides);
    if (!specs.length) throw new Error('Presentation requires slides');
    for (const spec of specs) {
      const slide = presentation.addSlide();
      slide.addText(String(spec.title ?? ''), {
        x: 0.6,
        y: 0.4,
        w: 12,
        h: 0.7,
        fontSize: 28,
        bold: true,
      });
      slide.addText(
        [String(spec.body ?? ''), ...array(spec.paragraphs).map(String)].filter(Boolean).join('\n'),
        {
          x: 0.6,
          y: 1.4,
          w: 12,
          h: 5.4,
          fontSize: 18,
          breakLine: false,
        },
      );
      for (const table of array<Json>(spec.tables)) {
        const rows = array<unknown[]>(table.rows);
        for (let offset = 0; offset < rows.length; offset += 10) {
          const tableSlide = presentation.addSlide();
          tableSlide.addText(String(spec.title ?? ''), {
            x: 0.5,
            y: 0.3,
            w: 12,
            h: 0.7,
            fontSize: 24,
          });
          tableSlide.addTable(
            rows
              .slice(offset, offset + 10)
              .map((row) => row.map((value) => ({ text: String(value ?? '') }))),
            { x: 0.5, y: 1.2, w: 12.2, fontSize: 16, border: { pt: 1, color: 'CCCCCC' } },
          );
        }
      }
      for (const image of array<Json>(spec.images)) {
        const imageSlide = presentation.addSlide();
        imageSlide.addText(String(spec.title ?? ''), {
          x: 0.5,
          y: 0.3,
          w: 12,
          h: 0.7,
          fontSize: 24,
        });
        const imagePath = String(image.path ?? image.absolutePath), metadata = await sharp(imagePath).metadata(), left = Number(image.leftIn ?? 0.7), top = Number(image.topIn ?? 1.7);
        let width = Number(image.widthIn ?? 3), height = width * Number(metadata.height) / Number(metadata.width);
        if (!Number.isFinite(height) || height <= 0 || width <= 0) throw new Error('Invalid presentation image dimensions');
        const available = 7.5 - top - 0.5;
        if (image.widthIn === undefined && height > available && available > 0) { width *= available / height; height = available; }
        imageSlide.addImage({ path: imagePath, x: left, y: top, w: width, h: height });
      }
    }
    if (references.length) {
      const slide = presentation.addSlide();
      slide.addText('Sources', { x: 0.6, y: 0.4, w: 12, h: 0.7, fontSize: 28 });
      slide.addText(
        references
          .map((source) => `${source.label ?? source.sourceId} — ${source.sourceId ?? ''}`)
          .join('\n'),
        { x: 0.6, y: 1.4, w: 12, h: 5.4, fontSize: 16 },
      );
    }
    const buffer = await presentation.write({ outputType: 'nodebuffer' });
    await writeFile(output, buffer as Buffer, { flag: 'wx' });
  } else throw new Error(`Unsupported output format ${format}`);
}
