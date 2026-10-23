import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {GitFilePreviews} from '../electron/git_file_previews';
import {readProjectPreview} from '../electron/project_inspector';

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=MP Preview',
      '-c',
      'user.email=preview@localhost',
      ...args,
    ],
    {cwd: root, windowsHide: true, encoding: 'utf8'},
  );
}

test('Git deletion snapshots distinguish index and HEAD, preserve old versions and clean only their owned cache', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-git-file-preview-'));
  const root = path.join(base, 'repo');
  const cache = path.join(base, 'cache');
  const previews = new GitFilePreviews(cache);
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'keep.txt'), 'unrelated cache file');
    git(root, 'init', '--quiet');
    const sub = path.join(root, 'sub folder');
    fs.mkdirSync(sub);
    const target = path.join(sub, '报告.txt');
    fs.writeFileSync(target, '\ncommitted\r\n\r\n');
    git(root, 'add', '--', 'sub folder/报告.txt');
    git(root, 'commit', '-qm', 'baseline');
    fs.writeFileSync(target, '\nstaged version\r\n\r\n');
    git(root, 'add', '--', 'sub folder/报告.txt');
    fs.unlinkSync(target);
    const [index, duplicate] = await Promise.all([
      previews.prepare(sub, '报告.txt', 'index'),
      previews.prepare(sub, '报告.txt', 'index'),
    ]);
    assert.equal(index, duplicate);
    assert.equal(fs.readFileSync(index, 'utf8'), '\nstaged version\r\n\r\n');
    const head = await previews.prepare(sub, '报告.txt', 'head');
    assert.equal(fs.readFileSync(head, 'utf8'), '\ncommitted\r\n\r\n');
    assert.notEqual(head, index);
    fs.utimesSync(index, new Date(1000), new Date(1000));
    assert.equal(await previews.prepare(sub, '报告.txt', 'index'), index);
    assert.equal(
      fs.statSync(index).mtimeMs,
      1000,
      'repeat clicks do not rewrite cached bytes',
    );
    fs.writeFileSync(target, 'next staged version\n');
    git(root, 'add', '--', 'sub folder/报告.txt');
    fs.unlinkSync(target);
    const next = await previews.prepare(sub, '报告.txt', 'index');
    assert.notEqual(next, index);
    assert.equal(fs.readFileSync(next, 'utf8'), 'next staged version\n');
    assert.equal(fs.readFileSync(index, 'utf8'), '\nstaged version\r\n\r\n');
    assert.equal(fs.existsSync(target), false);
    previews.dispose();
    assert.deepEqual(fs.readdirSync(cache), ['keep.txt']);
  } finally {
    previews.dispose();
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('staged deleted PNG and PDF blobs retain formats for the existing preview readers', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-git-media-preview-'));
  const root = path.join(base, 'repo');
  const previews = new GitFilePreviews(path.join(base, 'cache'));
  try {
    fs.mkdirSync(root);
    git(root, 'init', '--quiet');
    const png = await require('sharp')({
      create: {width: 1, height: 1, channels: 4, background: '#315a89'},
    })
      .png()
      .toBuffer();
    const {PDFDocument} = require('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const inputs = [
      {name: 'image.png', bytes: png, kind: 'image'},
      {name: 'document.pdf', bytes: Buffer.from(await pdf.save()), kind: 'pdf'},
    ];
    for (const item of inputs) {
      fs.writeFileSync(path.join(root, item.name), item.bytes);
    }
    git(root, 'add', '--', 'image.png', 'document.pdf');
    git(root, 'commit', '-qm', 'media baseline');
    git(root, 'rm', '--quiet', '--', 'image.png', 'document.pdf');
    for (const item of inputs) {
      const snapshot = await previews.prepare(root, item.name, 'head');
      assert.deepEqual(fs.readFileSync(snapshot), item.bytes);
      const preview = await readProjectPreview(
        path.dirname(snapshot),
        path.basename(snapshot),
      );
      assert.equal(preview.kind, item.kind);
      assert.equal(fs.existsSync(path.join(root, item.name)), false);
    }
  } finally {
    previews.dispose();
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('new staged files deleted before the first commit use the index without requiring HEAD', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-git-unborn-preview-'));
  const root = path.join(base, 'repo');
  const previews = new GitFilePreviews(path.join(base, 'cache'));
  try {
    fs.mkdirSync(root);
    git(root, 'init', '--quiet');
    fs.writeFileSync(
      path.join(root, 'new.txt'),
      'staged before first commit\n',
    );
    git(root, 'add', '--', 'new.txt');
    fs.unlinkSync(path.join(root, 'new.txt'));
    const snapshot = await previews.prepare(root, 'new.txt', 'index');
    assert.equal(
      fs.readFileSync(snapshot, 'utf8'),
      'staged before first commit\n',
    );
    await assert.rejects(previews.prepare(root, 'new.txt', 'head'));
  } finally {
    previews.dispose();
    fs.rmSync(base, {recursive: true, force: true});
  }
});
