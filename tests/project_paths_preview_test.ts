import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseGitEnvironment } from '../electron/project_environment';
import { readProjectText } from '../electron/project_inspector';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-project-preview-'));
try {
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  fs.writeFileSync(path.join(root, '报告.md'), 'report');
  const branchOutput = execFileSync('git', ['status', '--porcelain=v1', '--branch', '-z'], { cwd: root, encoding: 'utf8' });
  const parsed = parseGitEnvironment({ root, branchOutput });
  assert.equal(parsed.fileChanges[0]?.path, '报告.md', 'NUL status records preserve real non-ASCII paths');
  assert.equal(fs.existsSync(path.join(root, parsed.fileChanges[0].path)), true);
  fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024));
  const originalRead = fs.readFileSync;
  (fs as any).readFileSync = (target: any, ...args: any[]) => {
    assert.notEqual(target, path.join(root, 'large.txt'), 'preview must not load a whole potentially huge file');
    return (originalRead as any)(target, ...args);
  };
  try {
    const preview = readProjectText(root, 'large.txt', 32);
    assert.deepEqual(preview, { text: 'x'.repeat(32), truncated: true });
  } finally { fs.readFileSync = originalRead; }
  console.log('project_paths_preview_test: passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
