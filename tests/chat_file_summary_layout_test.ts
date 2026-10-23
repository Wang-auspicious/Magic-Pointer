import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {buildSync} from 'esbuild';
import ts from 'typescript';

const chat = require('../electron/renderer/chat_view');
function nodes(root: any, className: string): any[] {
  if (typeof root?.getAttribute !== 'function') return [];
  return [
    ...(root.getAttribute('class')?.split(' ').includes(className)
      ? [root]
      : []),
    ...root.children.flatMap((child: any) => nodes(child, className)),
  ];
}
function card(
  files: Array<{path: string; stat?: {added: number; removed: number}}>,
  artifacts: any[] = [],
) {
  const root = chat.assistantTurnNode({
    answer: 'Saved.',
    conversationId: 'layout',
    artifacts,
    trajectory: [
      {kind: 'tool', name: 'Read', text: '{}', result: 'Read context.'},
      ...files.map(file => ({
        kind: 'tool',
        name: 'Write',
        text: JSON.stringify({path: file.path, content: 'actual\n'}),
        result: JSON.stringify({
          path: file.path,
          absolutePath:
            file.path.startsWith('C:') || file.path.startsWith('D:')
              ? file.path
              : `D:/work/${file.path}`,
          created: true,
          turnDiffStat: file.stat ?? null,
        }),
      })),
    ],
  })[0];
  return nodes(root, 'mp-chat-files')[0];
}

test('normal single-file footer is one list row with trailing statistics outside its opener', () => {
  const root = card([{path: 'src/main.ts', stat: {added: 2, removed: 0}}]);
  assert.equal(nodes(root, 'mp-chat-files-head').length, 0);
  assert.equal(
    nodes(root, 'mp-chat-files-list')[0].getAttribute('role'),
    'list',
  );
  const item = nodes(root, 'mp-chat-file-item')[0];
  const opener = nodes(item, 'mp-chat-file-row')[0];
  assert.equal(opener.getAttribute('data-file-change'), 'created');
  assert.equal(nodes(opener, 'mp-chat-diff-stat').length, 0);
  assert.equal(nodes(item, 'mp-chat-diff-add')[0].children.join(''), '+2');
  assert.equal(nodes(item, 'mp-chat-diff-del')[0].children.join(''), '−0');
  assert.equal(
    nodes(item, 'mp-chat-file-chev')[0].getAttribute('data-glyph'),
    '\ue02a',
  );
});

test('multiple files use the original generic edited summary and only known total counts', () => {
  const root = card([
    {path: 'a.ts', stat: {added: 6, removed: 1}},
    {path: 'b.ts', stat: {added: 1, removed: 2}},
  ]);
  const head = nodes(root, 'mp-chat-files-head')[0];
  assert.equal(
    nodes(head, 'mp-chat-files-title')[0].children.join(''),
    'Edited 2 files',
  );
  assert.equal(nodes(head, 'mp-chat-diff-add')[0].children.join(''), '+7');
  assert.equal(nodes(head, 'mp-chat-diff-del')[0].children.join(''), '−3');
  const unknown = card([
    {path: 'a.ts', stat: {added: 0, removed: 0}},
    {path: 'b.ts'},
  ]);
  assert.equal(
    nodes(nodes(unknown, 'mp-chat-files-head')[0], 'mp-chat-diff-stat').length,
    0,
  );
  assert.equal(nodes(unknown, 'mp-chat-diff-stat').length, 1);
});

test('same basenames get the shortest useful folder hint without changing actual targets', () => {
  const root = card([
    {path: 'src/client/index.ts'},
    {path: 'src/server/index.ts'},
    {path: 'C:/project/config.json'},
    {path: 'D:/project/config.json'},
  ]);
  const rows = nodes(root, 'mp-chat-file-row');
  assert.deepEqual(
    rows.map(row =>
      nodes(row, 'mp-chat-file-folder-hint')[0]?.children.join(''),
    ),
    ['client', 'server', 'C:/project', 'D:/project'],
  );
  assert.equal(
    rows[0].getAttribute('data-file-absolute-path'),
    'D:/work/src/client/index.ts',
  );
  assert.equal(rows[0].getAttribute('aria-label'), 'index.ts, client');
  assert.equal(
    rows[3].getAttribute('data-file-absolute-path'),
    'D:/project/config.json',
  );
});

test('artifact row uses its title and Open action instead of a fabricated Published header', () => {
  const root = card(
    [{path: 'report.md'}],
    [{artifactId: 'draft', title: 'Result', path: 'report.md'}],
  );
  assert.equal(nodes(root, 'mp-chat-files-head').length, 0);
  const opener = nodes(root, 'mp-chat-file-row')[0];
  assert.equal(
    nodes(opener, 'mp-chat-file-name')[0].children.join(''),
    'Result',
  );
  const open = nodes(root, 'mp-chat-files-open')[0];
  assert.equal(open.getAttribute('data-artifact-id'), 'draft');
  assert.equal(open.getAttribute('aria-label'), 'Open artifact Result');
  assert.equal(open.getAttribute('data-mp-chat-act'), 'open-artifact');
  assert.equal(nodes(root, 'mp-chat-file-row').length, 1);
});

test('actual filename icon selection uses the retained type-specific SVG resource', () => {
  const root = card([
    {path: 'view.tsx'},
    {path: 'tool.py'},
    {path: '.gitignore'},
  ]);
  const icons = nodes(root, 'mp-chat-file-type-icon');
  assert.deepEqual(
    icons.map(icon => icon.getAttribute('data-file-type-icon')),
    ['react', 'python', 'git'],
  );
  assert.ok(icons.every(icon => icon.getAttribute('viewBox') === '0 0 16 16'));
  assert.notEqual(icons[0].outerHTML, icons[1].outerHTML);
});

test('ordinary extensionless filenames do not resolve inherited icon-map properties', () => {
  const root = card([{path: 'constructor'}, {path: '__proto__'}]);
  assert.deepEqual(
    nodes(root, 'mp-chat-file-type-icon').map(icon =>
      icon.getAttribute('data-file-type-icon'),
    ),
    ['default', 'default'],
  );
});

test('files without dedicated SVGs use the original category glyph instead of the default page', () => {
  const root = card([
    {path: 'data.parquet'},
    {path: 'deck.pptx'},
    {path: 'diagram.mmd'},
    {path: 'app.cs'},
    {path: 'rules.skill'},
    {path: 'bundle.plugin'},
  ]);
  const icons = nodes(root, 'mp-chat-file-type-icon');
  assert.deepEqual(
    icons.map(icon => icon.getAttribute('data-file-type-icon')),
    ['Database', 'Slides', 'Image', 'Code', 'Scroll', 'Scroll'],
  );
  assert.deepEqual(
    icons.map(icon => icon.getAttribute('data-glyph')),
    [57436, 57570, 57484, 57416, 57554, 57554].map(code =>
      String.fromCodePoint(code),
    ),
  );
  assert.ok(icons.every(icon => icon.tagName === 'span'));
  assert.ok(icons.every(icon => icon.getAttribute('aria-hidden') === 'true'));
  assert.equal(
    nodes(root, 'mp-chat-file-row')[0].getAttribute('data-file-absolute-path'),
    'D:/work/data.parquet',
  );
});

test('dedicated compound/name icons precede category glyphs and unknown files keep the retained default SVG', () => {
  const {fileIconFor} = require('../electron/renderer/chat_file_icons');
  for (const [name, expected] of [
    ['SKILL.md', 'markdown'],
    ['config.JSONL', 'json'],
    ['view.xhtml', 'html'],
    ['archive.tar.gz', 'zip'],
    ['schema.d.ts', 'typescript'],
    ['ordinary.unknown', 'default'],
    ['constructor', 'default'],
  ]) {
    const selected = fileIconFor(name);
    assert.equal(selected.id, expected);
    assert.ok(selected.nodes.length > 0);
    assert.equal(selected.glyph, undefined);
  }
});

test('both product surfaces load the real icon entry with bundled data and no browser fetch', () => {
  const ast = ts.createSourceFile(
    'scripts/build-electron.ts',
    fs.readFileSync('scripts/build-electron.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const entry = ast.statements.find(
    node =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'buildSync' &&
      node.getText(ast).includes("'chat_file_icons.ts'"),
  );
  assert.ok(entry);
  let output = '';
  vm.runInNewContext(entry.getText(ast), {
    path,
    sourceRoot: path.resolve('electron'),
    outputRoot: path.resolve('data/runtime/file-summary-layout-39/not-written'),
    buildSync: (options: any) => {
      output = buildSync({...options, write: false, sourcemap: false})
        .outputFiles![0].text;
    },
  });
  const browser = vm.createContext({});
  vm.runInContext(output, browser);
  assert.equal(
    vm.runInContext("ChatFileIcons.fileIconFor('view.tsx').id", browser),
    'react',
  );
  assert.equal(
    vm.runInContext("ChatFileIcons.fileIconFor('.GITIGNORE').id", browser),
    'git',
  );
  assert.equal(
    vm.runInContext(
      "ChatFileIcons.fileIconFor('unknown.extension').id",
      browser,
    ),
    'default',
  );
  assert.ok(output.includes('Pierre Computer Company'));
  for (const surface of ['studio', 'stage']) {
    const html = fs.readFileSync(`electron/renderer/${surface}.html`, 'utf8');
    const position = html.indexOf('src="chat_file_icons.js"');
    assert.ok(position > 0 && position < html.indexOf('src="chat_view.js'));
  }
});
