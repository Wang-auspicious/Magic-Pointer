import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function loadBuiltScript<T>(relBuiltPath: string, globalName: string): T {
  const fullPath = path.join(ROOT, relBuiltPath);
  const loaded = require(fullPath) as Record<string, unknown>;
  if (loaded && typeof loaded === 'object' && Object.keys(loaded).length > 0) {
    return loaded as unknown as T;
  }
  const code = readRepo(relBuiltPath);
  const sandbox: Record<string, unknown> = {
    console,
    URL,
    RegExp,
    require,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nglobalThis.${globalName} = ${globalName};`, sandbox, {
    filename: relBuiltPath,
  });
  return sandbox[globalName] as T;
}

test('Phase 1.1: light & dark surface tokens match Claude Desktop 4.23118', () => {
  const tokens = readRepo('electron/renderer/theme_tokens.css');
  assert.match(
    tokens,
    /--mp-page:\s*#FFFFFF/i,
    'light main chat canvas must be pure white (#FFFFFF / --cds-gray-0)',
  );
  assert.match(
    tokens,
    /--mp-sidebar:\s*#F9F9F7/i,
    'light sidebar must be warm stone (#F9F9F7 / --cds-gray-20)',
  );
  assert.doesNotMatch(
    tokens,
    /--mp-user-bubble:\s*#F0F4F8/i,
    'user bubble must not use cold baby-blue #F0F4F8',
  );
  assert.match(
    tokens,
    /--mp-prose-code-color:\s*#8E2626/i,
    'light inline prose code ink must match --cds-red-600 (#8E2626)',
  );
  assert.match(
    tokens,
    /--mp-file-link:\s*#184F95/i,
    'light clickable file-path pill ink must match --cds-blue-600 (#184F95)',
  );
  assert.match(
    tokens,
    /--mp-prose-code-color:\s*#EC7E7E/i,
    'dark inline prose code ink must match --cds-red-300 (#EC7E7E)',
  );
});

test('Phase 1.2: composer clutter cleanup and overflow protection', () => {
  const styles = readRepo('electron/renderer/chat_styles.css');
  const html = readRepo('electron/renderer/studio.html');
  assert.doesNotMatch(
    styles,
    /\.mpw-input-form\[data-state="success"\]\s*\.mpw-scroll\s*\{[^}]*--mp-success/,
    'composer must not flash a green success border after replies',
  );
  assert.match(
    styles,
    /#view-chat\[data-has-messages="true"\]\s+\.mp-composer-context-row\s*\{[^}]*display:\s*none/,
    'active chat turns must hide the redundant Local/Folder/Branch/Worktree context row',
  );
  assert.match(
    styles,
    /\.mpw-stream\s*\{[^}]*overflow-x:\s*hidden/,
    'main chat stream must prevent horizontal scrollbars',
  );
  assert.match(
    html,
    /id="composer-perception-toggle"/,
    'desktop perception must be tucked behind a compact composer toolbar icon toggle',
  );
});

test('Phase 1.3: inline code pills, clickable file-path pills, and rounded horizontal-only tables', () => {
  const styles = readRepo('electron/renderer/chat_styles.css');
  assert.match(
    styles,
    /\.mp-chat-markdown\s+:not\(pre\)\s*>\s*code[\s\S]*?color:\s*var\(--mp-prose-code-color/,
    'inline code must use --mp-prose-code-color',
  );
  assert.match(
    styles,
    /\.mp-chat-file-pill[\s\S]*?color:\s*var\(--mp-file-link/,
    'file-path pill must use --mp-file-link blue ink',
  );
  assert.match(
    styles,
    /\.mp-chat-markdown\s+table[\s\S]*?border-collapse:\s*separate/,
    'markdown table must use Claude Desktop border-collapse: separate rounded card styling',
  );

  const md = loadBuiltScript<{render(src: string): {outerHTML: string}}>(
    'build/electron/renderer/chat_markdown.js',
    'ChatMarkdown',
  );
  const rendered = md.render(
    '看 `app/agent_runtime/subagent.py:189` 把 `tool_limit=max_tool_calls` 混在一起。\n\n| 段 | 耗时 |\n|---|---|\n| turn1 | 5.9s |',
  ).outerHTML;
  assert.match(
    rendered,
    /class="[^"]*mp-chat-file-pill[^"]*"[^>]*data-mp-file-ref="app\/agent_runtime\/subagent\.py:189"/,
    'file path inline code must render as clickable .mp-chat-file-pill',
  );
  assert.match(
    rendered,
    /<code>tool_limit=max_tool_calls<\/code>/,
    'regular inline code must remain plain <code> without file-pill class',
  );
  assert.match(
    rendered,
    /class="mp-chat-table-scroll"[\s\S]*?<table>/,
    'markdown table must be wrapped inside .mp-chat-table-scroll',
  );
});

test('Phase 1.4: Windows path shortening, Skill row formatting, and full-title error coloring', () => {
  const styles = readRepo('electron/renderer/chat_styles.css');
  assert.doesNotMatch(
    styles,
    /\.mp-chat-tool\[data-state='error'\]:not\(\[data-error-title='true'\]\)\s*>\s*\.mp-chat-disclosure\s*>\s*\.mp-chat-row\s*:is\(\.mp-chat-summary,\s*\.mp-chat-tool-file\)\s*\{\s*color:\s*var\(--mp-text\)/,
    'errored tool row must not split red verb + black summary (half-red Ran Bash bug)',
  );

  const chatViewSrc = readRepo('electron/renderer/chat_view.ts');
  assert.match(
    chatViewSrc,
    /function shortenPath[\s\S]*?split\(\/\[\\\\\/\]\+\/\)/,
    'shortenPath must split both Windows backslashes and POSIX slashes',
  );
});
