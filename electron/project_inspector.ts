'use strict';

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {XMLParser} from 'fast-xml-parser';

type ProjectEntryKind = 'directory' | 'file';

interface ProjectEntry {
  name: string;
  path: string;
  kind: ProjectEntryKind;
}

interface ProjectTextPreview {
  kind: 'text';
  text: string;
  truncated: boolean;
}

interface ProjectDocumentPreview {
  kind: 'document';
  blocks: Array<
    | {
        kind: 'paragraph';
        text: string;
        style?: 'heading' | 'title';
        runs?: Array<{
          text: string;
          bold: boolean;
          italic: boolean;
          underline: boolean;
        }>;
      }
    | {kind: 'table'; rows: string[][]}
  >;
  truncated: boolean;
}

interface ProjectSpreadsheetPreview {
  kind: 'spreadsheet';
  sheets: Array<{name: string; rows: string[][]; truncated: boolean}>;
  truncated: boolean;
}

type ProjectFilePreview =
  ProjectTextPreview | ProjectDocumentPreview | ProjectSpreadsheetPreview;

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  trimValues: false,
});
type XmlPart = Record<string, unknown>;

function childParts(part: XmlPart, name: string): XmlPart[] {
  return Array.isArray(part[name]) ? (part[name] as XmlPart[]) : [];
}

function partsNamed(parts: XmlPart[], name: string): XmlPart[] {
  return parts.filter(part => Object.hasOwn(part, name));
}

function officeText(parts: XmlPart[]): string {
  return parts
    .map(part => {
      if ('#text' in part) {
        return String(part['#text'] ?? '');
      }
      if ('w:tab' in part) {
        return '\t';
      }
      if ('w:br' in part) {
        return '\n';
      }
      return Object.keys(part)
        .filter(key => key !== ':@')
        .map(key => officeText(childParts(part, key)))
        .join('');
    })
    .join('');
}

function wordRuns(
  parts: XmlPart[],
): Array<{text: string; bold: boolean; italic: boolean; underline: boolean}> {
  return parts.flatMap(part => {
    if ('w:r' in part) {
      const children = childParts(part, 'w:r');
      const properties = partsNamed(children, 'w:rPr').flatMap(item =>
        childParts(item, 'w:rPr'),
      );
      const text = officeText(children.filter(item => !('w:rPr' in item)));
      return text
        ? [
            {
              text,
              bold: properties.some(item => 'w:b' in item),
              italic: properties.some(item => 'w:i' in item),
              underline: properties.some(item => 'w:u' in item),
            },
          ]
        : [];
    }
    return Object.keys(part)
      .filter(key => key !== ':@')
      .flatMap(key => wordRuns(childParts(part, key)));
  });
}

function wordParagraph(
  parts: XmlPart[],
): Extract<ProjectDocumentPreview['blocks'][number], {kind: 'paragraph'}> {
  const runs = wordRuns(parts);
  const paragraphProperties = partsNamed(parts, 'w:pPr').flatMap(item =>
    childParts(item, 'w:pPr'),
  );
  const styleNode = partsNamed(paragraphProperties, 'w:pStyle')[0];
  const styleName = String(
    (styleNode?.[':@'] as Record<string, unknown> | undefined)?.['w:val'] ?? '',
  );
  const style = /^title$/i.test(styleName)
    ? 'title'
    : /^(heading|标题)/i.test(styleName)
      ? 'heading'
      : undefined;
  return {
    kind: 'paragraph',
    text: runs.map(run => run.text).join(''),
    runs,
    ...(style ? {style} : {}),
  };
}

function readWordPreview(filePath: string): ProjectDocumentPreview {
  const zip = new AdmZip(filePath);
  const document = zip.getEntry('word/document.xml');
  if (!document) {
    throw new Error('Word 文档正文不可读。');
  }
  const root = xmlParser.parse(
    document.getData().toString('utf8'),
  ) as XmlPart[];
  const body = partsNamed(
    partsNamed(root, 'w:document').flatMap(part =>
      childParts(part, 'w:document'),
    ),
    'w:body',
  ).flatMap(part => childParts(part, 'w:body'));
  const blocks: ProjectDocumentPreview['blocks'] = [];
  let truncated = false;
  for (const item of body) {
    if (blocks.length >= 500) {
      truncated = true;
      break;
    }
    if ('w:p' in item) {
      blocks.push(wordParagraph(childParts(item, 'w:p')));
    } else if ('w:tbl' in item) {
      const rows = partsNamed(childParts(item, 'w:tbl'), 'w:tr')
        .slice(0, 200)
        .map(row =>
          partsNamed(childParts(row, 'w:tr'), 'w:tc')
            .slice(0, 60)
            .map(cell =>
              partsNamed(childParts(cell, 'w:tc'), 'w:p')
                .map(paragraph => officeText(childParts(paragraph, 'w:p')))
                .join('\n'),
            ),
        );
      blocks.push({kind: 'table', rows});
      if (partsNamed(childParts(item, 'w:tbl'), 'w:tr').length > rows.length) {
        truncated = true;
      }
    }
  }
  return {kind: 'document', blocks, truncated};
}

async function readExcelPreview(
  filePath: string,
): Promise<ProjectSpreadsheetPreview> {
  const {default: ExcelJS} = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheets: ProjectSpreadsheetPreview['sheets'] = [];
  let truncated = workbook.worksheets.length > 12;
  for (const sheet of workbook.worksheets.slice(0, 12)) {
    const rows: string[][] = [];
    const lastRow = Math.min(sheet.rowCount, 500);
    const lastColumn = Math.min(sheet.columnCount, 80);
    for (let index = 1; index <= lastRow; index += 1) {
      const row = sheet.getRow(index);
      rows.push(
        Array.from(
          {length: lastColumn},
          (_, column) => row.getCell(column + 1).text,
        ),
      );
    }
    const sheetTruncated =
      sheet.rowCount > lastRow || sheet.columnCount > lastColumn;
    truncated ||= sheetTruncated;
    sheets.push({name: sheet.name, rows, truncated: sheetTruncated});
  }
  return {kind: 'spreadsheet', sheets, truncated};
}

function readPowerPointPreview(filePath: string): ProjectDocumentPreview {
  const zip = new AdmZip(filePath);
  const slides = zip
    .getEntries()
    .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .sort(
      (left, right) =>
        Number(/slide(\d+)/.exec(left.entryName)?.[1]) -
        Number(/slide(\d+)/.exec(right.entryName)?.[1]),
    );
  const blocks = slides.slice(0, 100).map((entry, index) => ({
    kind: 'paragraph' as const,
    text: `第 ${index + 1} 页\n${officeText(xmlParser.parse(entry.getData().toString('utf8')) as XmlPart[])}`,
  }));
  return {kind: 'document', blocks, truncated: slides.length > blocks.length};
}

async function readProjectPreview(
  root: string,
  relativePath: string,
): Promise<ProjectFilePreview> {
  const filePath = projectPath(root, relativePath);
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.docx') {
    return readWordPreview(filePath);
  }
  if (extension === '.xlsx') {
    return readExcelPreview(filePath);
  }
  if (extension === '.pptx') {
    return readPowerPointPreview(filePath);
  }
  return {kind: 'text', ...readProjectText(root, relativePath)};
}

const HIDDEN_DIRECTORIES = new Set([
  '.git',
  '.idea',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function projectPath(root: string, relativePath = ''): string {
  const resolvedRoot = path.resolve(String(root || ''));
  const resolved = path.resolve(resolvedRoot, String(relativePath || ''));
  const relation = path.relative(resolvedRoot, resolved);
  if (
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error('invalid_project_path');
  }
  return resolved;
}

function portableRelative(root: string, absolutePath: string): string {
  return path
    .relative(path.resolve(root), absolutePath)
    .split(path.sep)
    .join('/');
}

function listProjectDirectory(root: string, relativePath = ''): ProjectEntry[] {
  const directory = projectPath(root, relativePath);
  return fs
    .readdirSync(directory, {withFileTypes: true})
    .filter(
      entry =>
        (entry.isDirectory() || entry.isFile()) &&
        !(entry.isDirectory() && HIDDEN_DIRECTORIES.has(entry.name)),
    )
    .map(entry => ({
      name: entry.name,
      path: portableRelative(root, path.join(directory, entry.name)),
      kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
}

function readProjectText(
  root: string,
  relativePath: string,
  maxBytes = 384 * 1024,
): {
  text: string;
  truncated: boolean;
} {
  const filePath = projectPath(root, relativePath);
  const descriptor = fs.openSync(filePath, 'r');
  let data: Buffer;
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.floor(maxBytes)) + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    data = buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  if (data.subarray(0, Math.min(data.length, 8192)).includes(0)) {
    throw new Error('binary_project_file');
  }
  const truncated = data.length > maxBytes;
  return {
    text: data.subarray(0, maxBytes).toString('utf8'),
    truncated,
  };
}

export {listProjectDirectory, projectPath, readProjectPreview, readProjectText};
export type {ProjectEntry, ProjectFilePreview};
