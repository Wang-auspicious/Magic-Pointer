import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, {mock} from 'node:test';
import vm from 'node:vm';
import sharp from 'sharp';
import ts from 'typescript';
import {
  ACTIVITY_EXCLUDED_DIRECTORIES,
  PersonalActivityStore,
} from '../electron/personal_activity';
import {PersonalScreenCapture} from '../electron/personal_screen_capture';
import {ResourceCollectionService} from '../electron/resource_collection_service';

const {createStashRuntime} = require('../electron/stash_runtime');

const ROOT = path.resolve(__dirname, '..');

function loadStudioLibraries(): {
  artifactPreviewMarkup: (entry: Record<string, unknown>, content?: string) => string;
} {
  const cells = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    module: {exports: {}},
    localStorage: {
      getItem: (key: string) => cells.get(key) ?? null,
      setItem: (key: string, value: string) => cells.set(key, value),
    },
    CdsIcons: {html: (name: string) => `<i>${name}</i>`},
  };
  for (const name of [
    'project_scope',
    'conversation_state',
    'studio_libraries',
  ]) {
    vm.runInNewContext(
      ts.transpileModule(
        fs.readFileSync(
          path.join(ROOT, 'electron', 'renderer', `${name}.ts`),
          'utf8',
        ),
        {compilerOptions: {target: ts.ScriptTarget.ES2022}},
      ).outputText,
      sandbox,
    );
  }
  return (sandbox.module as {exports: {
    artifactPreviewMarkup: (entry: Record<string, unknown>, content?: string) => string;
  }}).exports;
}

test('pointer_input_state.ps1 avoids per-mousemove PtrToStructure GC, prioritizes hook thread, runs compiled C# loop, and passes SelfTest', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'scripts', 'pointer_input_state.ps1'),
    'utf8',
  );
  assert.ok(
    !/Marshal\.PtrToStructure\s*\(\s*lParam/.test(src),
    'HookCallback must not allocate MSLLHOOKSTRUCT via PtrToStructure on mouse moves',
  );
  assert.match(
    src,
    /if\s*\(\s*message\s*==\s*WM_MOUSEMOVE\s*\)/,
    'HookCallback must fast-path WM_MOUSEMOVE before dereferencing lParam',
  );
  assert.match(
    src,
    /hookThread\.Priority\s*=\s*ThreadPriority\.Highest/,
    'Hook thread must run at Highest priority so OS cursor movement never stalls',
  );
  assert.match(
    src,
    /public\s+static\s+void\s+RunLoop\s*\(/,
    'Polling loop must run inside compiled C# RunLoop instead of a 60 Hz PowerShell script loop',
  );
  assert.match(
    src,
    /\$CACHE_VERSION\s*=\s*"4"/,
    'CACHE_VERSION must be bumped to 4 after C# host changes',
  );

  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(ROOT, 'scripts', 'pointer_input_state.ps1'),
        '-SelfTest',
      ],
      {encoding: 'utf8', timeout: 20000},
    );
    const parsed = JSON.parse(out.trim()) as {
      ok?: boolean;
      hook?: string;
      gate?: string;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.hook, 'WH_MOUSE_LL');
    assert.equal(parsed.gate, 'fail-open');
  }
});

test('createStashRuntime.batchPersist coalesces index.json disk writes across batch operations', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mp-stash-batch-'));
  try {
    let writeCount = 0;
    const origRename = fs.renameSync;
    const runtime = createStashRuntime({
      baseDir: tmpDir,
      clipboard: {
        availableFormats: () => [],
        readImage: () => ({isEmpty: () => true}),
        readText: () => '',
      },
    });
    assert.equal(
      typeof runtime.batchPersist,
      'function',
      'stash runtime must expose batchPersist',
    );
    fs.renameSync = ((src: fs.PathLike, dest: fs.PathLike) => {
      if (String(dest).endsWith('index.json')) {
        writeCount++;
      }
      return origRename(src, dest);
    }) as typeof fs.renameSync;

    try {
      await runtime.batchPersist(async () => {
        const a = await runtime.addText('first batch entry with enough length');
        const b = await runtime.addText('second batch entry with enough length');
        assert.ok(a?.id && b?.id);
        runtime.updateResource(a.id, {title: 'updated-a'});
        runtime.updateResource(b.id, {title: 'updated-b'});
        assert.equal(
          writeCount,
          0,
          'index.json must not be rewritten repeatedly while inside batchPersist',
        );
      });
      assert.equal(
        writeCount,
        1,
        'index.json must flush once when outermost batchPersist completes',
      );

      await runtime.addText('outside batch entry');
      assert.equal(
        writeCount,
        2,
        'writes outside batchPersist must still persist immediately',
      );
    } finally {
      fs.renameSync = origRename;
    }
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test('PersonalScreenCapture skips self-capture when foreground pid matches ignorePid', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mp-ignore-pid-'));
  try {
    const png = await sharp({
      create: {width: 64, height: 32, channels: 3, background: '#ffffff'},
    })
      .png()
      .toBuffer();
    let captures = 0;
    const recorder = new PersonalScreenCapture(dir, {
      ignorePid: 4242,
      foreground: async () => 100,
      capture: async () => {
        captures++;
        return {
          bytes: png,
          source: 'test-window',
          capturedAtUtc: new Date(100000).toISOString(),
        };
      },
      recognize: async () => ({text: 'hello', usedBackend: 'test-ocr'}),
      save: async () => true,
      minimumIntervalMs: 0,
    });
    await recorder.observe({
      at: 100000,
      foreground: {
        hwnd: 100,
        pid: 4242,
        appId: 'app.exe',
        label: 'Self App',
        title: 'Magic Pointer',
        bounds: [0, 0, 64, 32],
      },
      idle: false,
      locked: false,
    });
    assert.equal(captures, 0, 'ignorePid must suppress self-capture');

    await recorder.observe({
      at: 105000,
      foreground: {
        hwnd: 100,
        pid: 9999,
        appId: 'editor.exe',
        label: 'Editor',
        title: 'Notes',
        bounds: [0, 0, 64, 32],
      },
      idle: false,
      locked: false,
    });
    assert.equal(captures, 1, 'other PIDs should still capture normally');
    await recorder.stop();
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('Artifacts and Projects UI avoid eager iframes, list-mode preview work, and forced live model fetches', () => {
  const libs = loadStudioLibraries();
  const iframeMarkup = libs.artifactPreviewMarkup(
    {name: 'demo.html', kind: 'html'},
    '<html><body><h1>Hi</h1></body></html>',
  );
  assert.match(
    iframeMarkup,
    /<iframe[^>]*\bloading="lazy"/,
    'artifactPreviewMarkup must mark preview iframes loading="lazy"',
  );

  const studioSrc = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'studio.ts'),
    'utf8',
  );
  assert.match(
    studioSrc,
    /artifactLayout\s*===\s*'grid'\s*\?\s*studioLibraries\.artifactPreviewMarkup/,
    'studio.ts must skip artifactPreviewMarkup in list layout',
  );

  const libSrc = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'studio_libraries.ts'),
    'utf8',
  );
  assert.ok(
    !/mountProjectDetail[\s\S]{0,1200}options\.data\.models\(\s*true\s*\)/.test(
      libSrc,
    ),
    'mountProjectDetail must use cached models(false) instead of forcing live network /models on every project open',
  );
});

test('PersonalActivityStore bounds baseline scan by file count, depth, and excludes .tmp/venv while keeping live watch', async () => {
  assert.ok(
    ACTIVITY_EXCLUDED_DIRECTORIES.includes('.tmp') &&
      ACTIVITY_EXCLUDED_DIRECTORIES.includes('venv'),
    'ACTIVITY_EXCLUDED_DIRECTORIES must exclude .tmp and venv',
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-activity-bound-'));
  const observed = path.join(root, 'observed');
  const data = path.join(root, 'data');
  try {
    await mkdir(path.join(observed, '.tmp'), {recursive: true});
    await mkdir(path.join(observed, 'venv'), {recursive: true});
    await mkdir(path.join(observed, 'deep', 'l1', 'l2', 'l3'), {recursive: true});
    await mkdir(path.join(observed, 'flat'), {recursive: true});
    const topFile = path.join(observed, 'top.txt');
    await writeFile(topFile, 'top');
    await writeFile(path.join(observed, '.tmp', 'ignored.txt'), 'tmp');
    await writeFile(path.join(observed, 'venv', 'ignored2.txt'), 'venv');
    await writeFile(
      path.join(observed, 'deep', 'l1', 'l2', 'l3', 'too_deep.txt'),
      'deep',
    );
    await Promise.all(
      Array.from({length: 50}, (_, i) =>
        writeFile(path.join(observed, 'flat', `f-${i}.txt`), 'x'),
      ),
    );

    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const origLstat = fsp.lstat;
    const probedTxt: string[] = [];
    const lstatSpy = mock.method(fsp, 'lstat', (p: unknown, ...args: unknown[]) => {
      const s = String(p);
      if (s.startsWith(observed) && s.endsWith('.txt')) {
        probedTxt.push(s);
      }
      return Reflect.apply(origLstat, fsp, [p, ...args]);
    });

    const store = new (PersonalActivityStore as unknown as new (
      dir: string,
      opts: Record<string, unknown>,
    ) => PersonalActivityStore)(data, {
      enabled: true,
      maxBaselineFiles: 20,
      maxBaselineDepth: 2,
      maxBaselineMs: 5000,
    });
    try {
      await store.startFileWatching([observed]);
      assert.ok(
        probedTxt.every(
          p =>
            !p.includes(`${path.sep}.tmp${path.sep}`) &&
            !p.includes(`${path.sep}venv${path.sep}`) &&
            !p.endsWith('too_deep.txt'),
        ),
        `baseline scan should skip excluded dirs and depth > 2, saw: ${probedTxt.filter(p => p.includes('.tmp') || p.includes('venv') || p.endsWith('too_deep.txt')).join(', ')}`,
      );
      assert.ok(
        probedTxt.length <= 28,
        `baseline scan must respect maxBaselineFiles=20 cap, saw ${probedTxt.length} file stats`,
      );

      lstatSpy.mock.restore();
      await appendFile(topFile, '\nchanged');
      const deadline = Date.now() + 3000;
      let sawModified = false;
      while (Date.now() < deadline) {
        const day = await store.getDay();
        if (
          day?.files.some(
            file => file.path === topFile && file.kind === 'modified',
          )
        ) {
          sawModified = true;
          break;
        }
        await new Promise(r => setTimeout(r, 30));
      }
      assert.equal(sawModified, true, 'fs.watch must still observe live edits');
    } finally {
      lstatSpy.mock.restore();
      await store.close();
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('main.ts resources() and startup avoid eager drainCaptures and bookmarkSync crawl while ResourceCollectionService honors capturePaceMs', async () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.ts'), 'utf8');
  const fnMatch = mainSrc.match(
    /function resources\(\): ResourceCollectionService \{[\s\S]*?\n\}/,
  );
  assert.ok(fnMatch, 'function resources() must exist in electron/main.ts');
  assert.ok(
    !fnMatch[0].includes('drainCaptures()'),
    'resources() singleton initializer must recover() without launching an eager 300-item background drainCaptures crawl',
  );
  const bmMatch = mainSrc.match(
    /function bookmarkSync\(\): ResourceBookmarkSync \{[\s\S]*?\n\}/,
  );
  assert.ok(bmMatch, 'function bookmarkSync() must exist in electron/main.ts');
  assert.ok(
    !bmMatch[0].includes('drainCaptures()'),
    'bookmarkSync() sync must not trigger background 300-item drainCaptures crawl',
  );
  assert.ok(
    !/bookmarkSyncStartTimer\s*=[\s\S]{0,400}bookmarkSync\(\)\.start\(\)/.test(
      mainSrc,
    ),
    'startup must not eagerly launch bookmarkSync().start() in background; initialize lazily on Resources view',
  );

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mp-capture-pace-'));
  try {
    const stash = createStashRuntime({
      baseDir: path.join(tmpDir, 'stash'),
      clipboard: {
        availableFormats: () => [],
        readImage: () => ({isEmpty: () => true}),
        readText: () => '',
      },
    });
    const service = new ResourceCollectionService({
      stash: () => stash,
      projects: () => [],
      attach: () => {},
      analyze: async () => ({ok: true}),
      capturePaceMs: 80,
      capturePost: async url => ({
        platform: 'web',
        url,
        id: url.split('/').pop() || 'id',
        author: {name: 'Author', id: 'a1'},
        title: 'Post',
        text: 'Content',
        media: [],
        coverage: 'complete',
      }),
    } as ConstructorParameters<typeof ResourceCollectionService>[0]);
    await service.addBatch({
      text: 'https://example.com/p/1\nhttps://example.com/p/2',
    });
    const started = performance.now();
    await service.drainCaptures();
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed >= 70,
      `drainCaptures with capturePaceMs=80 should pace between captures (${Math.round(elapsed)}ms)`,
    );
    service.stop();
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});
