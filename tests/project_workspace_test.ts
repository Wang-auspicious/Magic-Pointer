import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  listProjectWorktrees,
  prepareProjectWorkspace,
} from '../electron/project_workspace';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-workspace-'));
  const root = path.join(directory, 'project 视元');
  fs.mkdirSync(root);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.name', 'MP Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(root, 'marker.txt'), 'main content');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'main fixture']);
  git(['checkout', '--quiet', '-b', 'feature/environment']);
  fs.writeFileSync(path.join(root, 'marker.txt'), 'feature content');
  git(['commit', '--quiet', '-am', 'feature fixture']);
  git(['checkout', '--quiet', 'main']);
  return {
    directory,
    root,
    git,
    cleanup() {
      assert.equal(path.dirname(directory), os.tmpdir());
      fs.rmSync(directory, {recursive: true, force: true});
    },
  };
}

test('a task worktree starts from its selected branch, keeps edits and survives deletion of its base ref', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'local.txt'), 'base edit');
    const request = {
      projectRoot: f.root,
      dataDir: path.join(f.directory, 'data 资料'),
      conversationId: 'task-a',
      branch: 'feature/environment',
      worktree: true,
    };
    const first = await prepareProjectWorkspace(request);
    assert.ok(first.ok, !first.ok ? first.error : '');
    assert.notEqual(first.path, f.root);
    assert.equal(
      fs.readFileSync(path.join(first.path, 'marker.txt'), 'utf8'),
      'feature content',
    );
    assert.equal(f.git(['branch', '--show-current']), 'main');
    assert.equal(
      fs.readFileSync(path.join(f.root, 'local.txt'), 'utf8'),
      'base edit',
    );
    const entry = (await listProjectWorktrees(f.root)).find(
      item => item.branch === first.branch,
    );
    assert.equal(path.resolve(entry!.path), path.resolve(first.path));
    fs.writeFileSync(path.join(first.path, 'task-edit.txt'), 'task edit');
    const adopted = await prepareProjectWorkspace({
      ...request,
      conversationId: 'accepted-a',
      existingPath: first.path,
    });
    assert.ok(adopted.ok);
    assert.equal(
      adopted.path,
      first.path,
      'accepting a conversation identity keeps the original task checkout',
    );
    f.git(['branch', '-D', 'feature/environment']);
    const second = await prepareProjectWorkspace(request);
    assert.ok(second.ok);
    assert.equal(second.path, first.path);
    assert.equal(
      fs.readFileSync(path.join(second.path, 'task-edit.txt'), 'utf8'),
      'task edit',
    );
  } finally {
    f.cleanup();
  }
});

test('a non-isolated selection really switches branches and refuses to overwrite conflicting edits', async () => {
  const f = fixture();
  try {
    const request = {
      projectRoot: f.root,
      dataDir: f.directory,
      conversationId: 'task-a',
      branch: 'feature/environment',
      worktree: false,
    };
    const selected = await prepareProjectWorkspace(request);
    assert.ok(selected.ok);
    assert.equal(selected.path, f.root);
    assert.equal(f.git(['branch', '--show-current']), 'feature/environment');
    fs.writeFileSync(path.join(f.root, 'marker.txt'), 'unsaved edit');
    const refused = await prepareProjectWorkspace({...request, branch: 'main'});
    assert.equal(refused.ok, false);
    assert.equal(f.git(['branch', '--show-current']), 'feature/environment');
    assert.equal(
      fs.readFileSync(path.join(f.root, 'marker.txt'), 'utf8'),
      'unsaved edit',
    );
  } finally {
    f.cleanup();
  }
});

test('ordinary folders need no Git setup when no branch or isolation is requested', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-workspace-'));
  try {
    const result = await prepareProjectWorkspace({
      projectRoot: directory,
      dataDir: directory,
      conversationId: 'task-a',
      worktree: false,
    });
    assert.deepEqual(result, {ok: true, path: directory, branch: ''});
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
