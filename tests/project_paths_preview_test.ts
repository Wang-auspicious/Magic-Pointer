import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {parseGitEnvironment} from '../electron/project_environment';
import {
  readProjectPreview,
  readProjectText,
} from '../electron/project_inspector';
test('project paths and bounded text previews retain their original contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-project-preview-'));
  try {
    execFileSync('git', ['init', '--quiet'], {cwd: root});
    fs.writeFileSync(path.join(root, '报告.md'), 'report');
    const branchOutput = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--branch', '-z'],
      {cwd: root, encoding: 'utf8'},
    );
    const parsed = parseGitEnvironment({root, branchOutput});
    assert.equal(
      parsed.fileChanges[0]?.path,
      '报告.md',
      'NUL status records preserve real non-ASCII paths',
    );
    assert.equal(
      fs.existsSync(path.join(root, parsed.fileChanges[0].path)),
      true,
    );
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024));
    const originalRead = fs.readFileSync;
    (fs as any).readFileSync = (target: any, ...args: any[]) => {
      assert.notEqual(
        target,
        path.join(root, 'large.txt'),
        'preview must not load a whole potentially huge file',
      );
      return (originalRead as any)(target, ...args);
    };
    try {
      const preview = readProjectText(root, 'large.txt', 32);
      assert.deepEqual(preview, {text: 'x'.repeat(32), truncated: true});
    } finally {
      fs.readFileSync = originalRead;
    }
    console.log('project_paths_preview_test: passed');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('uploaded image and PDF materials open as media instead of binary text', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-project-media-'));
  try {
    fs.writeFileSync(
      path.join(folder, '图片.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    fs.writeFileSync(
      path.join(folder, '报告.pdf'),
      Buffer.from('%PDF-1.7\n%\0binary-stream\n%%EOF'),
    );
    const previews = await Promise.allSettled(
      ['图片.png', '报告.pdf'].map(file => readProjectPreview(folder, file)),
    );
    assert.deepEqual(
      previews.map(result =>
        result.status === 'fulfilled'
          ? result.value.kind
          : result.reason.message,
      ),
      ['image', 'pdf'],
    );
  } finally {
    fs.rmSync(folder, {recursive: true, force: true});
  }
});
