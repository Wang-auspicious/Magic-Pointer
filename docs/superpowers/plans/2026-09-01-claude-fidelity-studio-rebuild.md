# Claude-Fidelity Studio Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Magic Pointer Studio's legacy visual/interaction stack with the approved Claude-fidelity workbench, including optional-workspace conversations, real landing statistics, global search, shared composer, and a stateful Inspector, then deliver the verified installed application.

**Architecture:** EventSession, ConversationStore, Runtime, receipts, evidence, and permission invariants remain the truth. Focused pure modules project optional workspace, home statistics, search, sidebar grouping, navigation, and Inspector state into one Studio shell. Studio loads three new locked CSS files and no legacy generated cascade; Stage/Companion retain their existing shared styles.

**Tech Stack:** Electron 43, TypeScript 6, classic renderer scripts compiled by the existing build, Node `assert` tests via `tsx/cjs`, Python 3.12/pytest, CSS custom properties, BrowserWindow titleBarOverlay, WebContentsView Inspector browser, NSIS local sync installer.

**Approved specification:** `docs/superpowers/specs/2026-09-01-claude-fidelity-studio-rebuild-design.md`

---

## File structure

### New production files

- `electron/conversation_workspace_policy.ts` — main/renderer-safe optional workspace resolution.
- `electron/studio_home_stats.ts` — bounded deterministic aggregate projection.
- `electron/renderer/studio_home.ts` — landing/attention/statistics DOM renderer.
- `electron/renderer/studio_search.ts` — pure search index/ranking plus overlay controller.
- `electron/renderer/studio_workspace_policy.ts` — environment-chip presentation and capability state.
- `electron/renderer/studio_inspector_state.ts` — resize/maximise/restore state policy.
- `electron/renderer/claude_tokens.css` — locked tokens and base rules.
- `electron/renderer/claude_shell.css` — chrome, sidebar, landing, Inspector, Customize, Design, responsiveness.
- `electron/renderer/claude_chat.css` — transcript, activities, composer, permission/ask-user surfaces.

### Modified production files

- `electron/main.ts`, `electron/preload.ts`, `electron/conversation_store.ts`.
- `app/agent_runtime/skill_catalog.py`, `scripts/conversation_bridge.py`.
- `electron/renderer/studio.html`, `studio.ts`, `data.ts`, `sidebar_groups.ts`, `permission_presets.ts`, `dsh_chat.ts`.
- `electron/main.ts` titlebar setup removes idle pixel sampling for Studio.

### Retired after zero-consumer checks

- `electron/renderer/studio_system.css`.
- `scripts/consolidate_studio_css.ts`.
- `tests/studio_css_consolidation_test.js`.
- Studio-only old CSS and SV motion listed in the approved spec, but only when `rg` proves no Stage/Companion/Gallery/Lab consumer.

---

### Task 1: Make workspace optional without inventing a fallback

**Files:**
- Create: `electron/conversation_workspace_policy.ts`
- Test: `tests/conversation_workspace_policy_test.ts`
- Modify: `tests/studio_project_gate_contract_test.js`
- Modify: `electron/main.ts`
- Modify: `app/agent_runtime/skill_catalog.py`
- Modify: `scripts/conversation_bridge.py`
- Modify: `tests/conversation_bridge_test.py`

- [x] **Step 1: Write the failing TypeScript policy test**

```ts
const assert = require('node:assert');
const {
  resolveConversationWorkspace,
  workspaceCapabilityState,
} = require('../electron/conversation_workspace_policy');

assert.strictEqual(resolveConversationWorkspace('', ''), null);
assert.strictEqual(resolveConversationWorkspace(' D:/picked ', 'C:/old'), 'D:/picked');
assert.strictEqual(resolveConversationWorkspace('', ' C:/thread '), 'C:/thread');
assert.deepStrictEqual(workspaceCapabilityState(null), {
  bound: false,
  codingTools: false,
  label: '选择文件夹…',
});
assert.deepStrictEqual(workspaceCapabilityState('C:/repo'), {
  bound: true,
  codingTools: true,
  label: 'repo',
});
console.log('conversation workspace policy test ok');
```

- [x] **Step 2: Flip the old project-gate contract to the new product boundary**

Replace the old assertions with:

```js
assert(html.includes('id="composer-workspace"'), 'Composer exposes the optional folder chip');
assert(html.includes('id="composer-workspace-label"'));
assert(!html.includes('id="project-gate"'), 'the mandatory project gate is deleted');
assert(!main.includes("if (!effectiveWorkspaceRoot) return { ok: false, error: '请先打开项目。' }"));
assert(main.includes('resolveConversationWorkspace'));
```

- [x] **Step 3: Add failing Python tests for no implicit profile workspace**

```py
def test_resolve_workspace_allows_unbound_conversation(tmp_path) -> None:
    assert conversation_bridge._resolve_workspace_root("") is None


def test_resolve_workspace_accepts_explicit_existing_directory(tmp_path) -> None:
    assert conversation_bridge._resolve_workspace_root(str(tmp_path)) == tmp_path.resolve()


def test_skill_catalog_can_scan_user_roots_without_project_root(tmp_path) -> None:
    from app.agent_runtime.skill_catalog import SkillCatalog

    user_skill = tmp_path / ".agents" / "skills" / "demo"
    user_skill.mkdir(parents=True)
    (user_skill / "SKILL.md").write_text(
        "---\nname: demo\ndescription: user skill\n---\nbody",
        encoding="utf-8",
    )
    catalog = SkillCatalog(project_root=None, user_home=tmp_path, include_project=False)
    assert [row["name"] for row in catalog.list_skills()] == ["demo"]
```

- [x] **Step 4: Run RED tests**

Run:

```powershell
node --require tsx/cjs tests/conversation_workspace_policy_test.ts
node tests/studio_project_gate_contract_test.js
python -m pytest tests/conversation_bridge_test.py -q --basetemp=data/runtime/pytest-tmp-claude-studio
```

Expected: missing module, old hard-gate assertions, and missing Python helper/argument failures.

- [x] **Step 5: Implement the pure workspace policy**

```ts
import path from 'node:path';

export function resolveConversationWorkspace(
  explicitRoot: unknown,
  threadRoot: unknown,
): string | null {
  const explicit = String(explicitRoot ?? '').trim();
  if (explicit) return explicit;
  const existing = String(threadRoot ?? '').trim();
  return existing || null;
}

export function workspaceCapabilityState(root: unknown) {
  const value = String(root ?? '').trim();
  return value
    ? { bound: true, codingTools: true, label: path.basename(path.normalize(value)) || value }
    : { bound: false, codingTools: false, label: '选择文件夹…' };
}
```

- [x] **Step 6: Use the policy in `conversations:send`**

Import the helper and replace the hard gate with:

```ts
const effectiveWorkspaceRoot = resolveConversationWorkspace(
  workspaceRoot,
  existing?.workspaceRoot,
);
```

Only add `workspaceRoot` to the bridge/store payload when non-null.

- [x] **Step 7: Make project Skill roots explicitly optional**

Add `include_project: bool = True` to `skill_roots` and `SkillCatalog`, and build roots as:

```py
roots: list[_Root] = []
if include_project:
    project = _Path(project_root) if project_root is not None else _Path.cwd()
    roots.extend([
        _Root(project / ".dsh" / "skills", "project-dsh"),
        _Root(project / ".agents" / "skills", "project-agents"),
    ])
roots.extend([
    _Root(home / ".dsh" / "skills", "user-dsh"),
    _Root(home / ".agents" / "skills", "user-agents"),
])
return roots
```

- [x] **Step 8: Make the bridge boot with no coding workspace**

Add:

```py
def _resolve_workspace_root(explicit_workspace: str) -> Path | None:
    raw = str(explicit_workspace or "").strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_dir():
        raise ValueError(f"工作区目录不存在：{raw}")
    return candidate.resolve()
```

Use it in `answer_conversation`; pass an empty runtime workspace for an unbound thread, use `SkillCatalog(..., include_project=False)`, and set `tool_result_dir=None` unless a real root exists. Do not call `read_workspace(ROOT)` in this path.

- [x] **Step 9: Run GREEN and adjacent regressions**

Run the three RED commands plus:

```powershell
python -m pytest tests/harness_builtin_bundle_test.py tests/skill_catalog_test.py -q --basetemp=data/runtime/pytest-tmp-claude-studio-adjacent
```

Expected: all pass; unbound Runtime has no coding/delegate tools while desktop and ordinary model tools remain.

- [x] **Step 10: Commit**

```powershell
git add electron/conversation_workspace_policy.ts electron/main.ts app/agent_runtime/skill_catalog.py scripts/conversation_bridge.py tests/conversation_workspace_policy_test.ts tests/studio_project_gate_contract_test.js tests/conversation_bridge_test.py
git commit -m "feat: allow folderless Studio conversations"
```

---

### Task 2: Add real bounded landing statistics

**Files:**
- Create: `electron/studio_home_stats.ts`
- Test: `tests/studio_home_stats_test.ts`
- Modify: `electron/conversation_store.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/renderer/data.ts`

- [x] **Step 1: Write the failing projection test**

```ts
const assert = require('node:assert');
const { projectStudioHomeStats } = require('../electron/studio_home_stats');

const now = new Date('2026-09-01T12:00:00+08:00').getTime();
const day = 86_400_000;
const stats = projectStudioHomeStats([
  {
    id: 'a', createdAt: now - day, updatedAt: now,
    turns: [
      { question: 'q1', answer: 'a1', at: now - day, modelUsage: { inputTokens: 10, outputTokens: 5 }, modelId: 'm1' },
      { question: 'q2', answer: 'a2', at: now, modelUsage: { totalTokens: 20 }, modelId: 'm1' },
    ],
  },
  {
    id: 'b', createdAt: now, updatedAt: now,
    turns: [{ question: 'q3', answer: 'a3', at: now, modelUsage: { totalTokens: 'bad' }, modelId: 'm2' }],
  },
], now);

assert.strictEqual(stats.sessions, 2);
assert.strictEqual(stats.messages, 6);
assert.strictEqual(stats.totalTokens, 35);
assert.strictEqual(stats.activeDays, 2);
assert.strictEqual(stats.currentStreak, 2);
assert.strictEqual(stats.longestStreak, 2);
assert.strictEqual(stats.favoriteModel, 'm1');
assert.strictEqual(stats.heatmap.length, 182);
assert.strictEqual(stats.heatmap.find(day => day.date === '2026-09-01').messages, 4);
assert.strictEqual(stats.heatmap.at(-1).future, true);
console.log('studio home stats test ok');
```

- [x] **Step 2: Run RED**

```powershell
node --require tsx/cjs tests/studio_home_stats_test.ts
```

Expected: module not found.

- [x] **Step 3: Implement the projection**

Implement exported types and `projectStudioHomeStats(conversations, now)` with these exact rules:

```ts
const DAYS = 182;
const DAY_MS = 86_400_000;
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const localDateKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
```

Count one message for each non-empty stored question and answer. Prefer finite `totalTokens`; otherwise sum finite input/output/cache-write fields without double-counting cache-read tokens. Persist the request model id on new turns and count models by summed tokens, then turn count, then lexical id; never use `usedBackend` as a model name. Compute peak local hour by turn count. Fill all 182 heatmap days, including zero days.

- [x] **Step 4: Expose one bounded stats IPC**

Add `conversationStore.stats()` returning the projection of loaded summaries, `ipcMain.handle('conversations:stats')`, preload `stats()`, and renderer `Data.conversationStats()` types. Do not send full EventSession logs.

- [x] **Step 5: Run GREEN and store regressions**

```powershell
node --require tsx/cjs tests/studio_home_stats_test.ts
node --require tsx/cjs tests/conversation_store_lifecycle_test.ts
node tests/conversation_store_test.js
```

- [x] **Step 6: Commit**

```powershell
git add electron/studio_home_stats.ts electron/conversation_store.ts electron/main.ts electron/preload.ts electron/renderer/data.ts tests/studio_home_stats_test.ts
git commit -m "feat: project real Studio home statistics"
```

---

### Task 3: Replace sidebar grouping and add global search

**Files:**
- Modify: `electron/renderer/sidebar_groups.ts`
- Modify: `tests/sidebar_groups_test.js`
- Create: `electron/renderer/studio_search.ts`
- Test: `tests/studio_search_test.ts`

- [x] **Step 1: Write failing local-session grouping assertions**

Change the expected workspace groups to:

```js
assert.deepStrictEqual(wsGroups.map(g => g.label), ['alpha', 'beta', '本机会话']);
assert.deepStrictEqual(wsGroups.at(-1).items.map(i => i.id), ['w4']);
assert.strictEqual(wsGroups.at(-1).key, '__local__');
assert.strictEqual(wsGroups.at(-1).workspaceRoot, '');
```

- [x] **Step 2: Write the failing search test**

```ts
const assert = require('node:assert');
const { buildStudioSearchIndex, searchStudioIndex } = require('../electron/renderer/studio_search');

const index = buildStudioSearchIndex({
  conversations: [{ id: 'c1', title: 'Claude 界面', subtitle: 'Studio', workspaceRoot: 'D:/Magic' }],
  projects: [{ root: 'D:/Magic', name: 'Magic Pointer' }],
  commands: [{ name: 'compact', description: '压缩上下文' }],
  skills: [{ name: 'pdf', description: '处理 PDF' }],
  routes: [{ id: 'customize', label: '自定义', keywords: ['设置', '插件'] }],
});

assert.deepStrictEqual(searchStudioIndex(index, 'Claude').map(x => x.key), ['conversation:c1']);
assert.strictEqual(searchStudioIndex(index, 'Magic')[0].key, 'project:D:/Magic');
assert.strictEqual(searchStudioIndex(index, '设置')[0].key, 'route:customize');
assert.strictEqual(searchStudioIndex(index, 'pdf')[0].key, 'skill:pdf');
assert.deepStrictEqual(searchStudioIndex(index, '', 8), []);
console.log('studio search test ok');
```

- [x] **Step 3: Run RED**

```powershell
node tests/sidebar_groups_test.js
node --require tsx/cjs tests/studio_search_test.ts
```

- [x] **Step 4: Implement truthful local grouping**

Keep workspace groups in recency order and append one group:

```ts
if (localItems.length) {
  result.push({ key: '__local__', label: '本机会话', workspaceRoot: '', items: localItems });
}
```

- [x] **Step 5: Implement bounded search**

Use a discriminated `StudioSearchItem` with `kind`, `key`, `label`, `detail`, `keywords`, and `target`. Normalise with trim/lowercase. Ranking is exact label 0, label prefix 1, token prefix 2, substring 3; then recency, then label. Cap the index at 500 conversations, 100 projects, 200 commands/skills, and the fixed route list. Cap results at 20.

- [x] **Step 6: Run GREEN and commit**

```powershell
node tests/sidebar_groups_test.js
node --require tsx/cjs tests/studio_search_test.ts
git add electron/renderer/sidebar_groups.ts electron/renderer/studio_search.ts tests/sidebar_groups_test.js tests/studio_search_test.ts
git commit -m "feat: add local sessions and global Studio search"
```

---

### Task 4: Lock the Claude-fidelity stylesheet entry and shell contract

**Files:**
- Create: `tests/studio_claude_fidelity_contract_test.js`
- Create: `electron/renderer/claude_tokens.css`
- Create: `electron/renderer/claude_shell.css`
- Create: `electron/renderer/claude_chat.css`
- Modify: `electron/renderer/studio.html`
- Modify: `electron/main.ts`

- [x] **Step 1: Write the failing visual contract**

```js
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const tokens = fs.readFileSync('electron/renderer/claude_tokens.css', 'utf8');
const shell = fs.readFileSync('electron/renderer/claude_shell.css', 'utf8');
const chat = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');

for (const href of ['claude_tokens.css', 'claude_shell.css', 'claude_chat.css']) {
  assert(html.includes(`href="${href}`), `missing ${href}`);
}
assert(!html.includes('studio_system.css'));
assert(!html.includes('mp-window-menu-bar'));
assert(html.includes('id="app-menu"'));
assert(html.includes('id="global-search-toggle"'));
assert(html.includes('id="mode-work"') && html.includes('id="mode-design"'));
assert(html.includes('id="studio-home"'));
assert(html.includes('id="composer-workspace"'));
assert.match(tokens, /--mp-window-bar:\s*36px/);
assert.match(tokens, /--mp-sidebar-width:\s*288px/);
assert.match(tokens, /--mp-content-width:\s*768px/);
assert.match(tokens, /--mp-page:\s*#FCFCFB/);
assert.match(tokens, /--mp-page:\s*#151515/);
assert.match(tokens, /--mp-ease-out:\s*cubic-bezier\(\.32,\.72,0,1\)/);
assert.match(shell, /grid-template-rows:\s*var\(--mp-window-bar\) minmax\(0,1fr\)/);
assert.match(shell, /\.mp-inspector\s*\{[^}]*inset:\s*8px 8px 8px auto/s);
assert.match(chat, /max-width:\s*var\(--mp-content-width\)/);
console.log('studio Claude fidelity contract ok');
```

- [x] **Step 2: Run RED**

```powershell
node tests/studio_claude_fidelity_contract_test.js
```

Expected: missing new CSS files.

- [x] **Step 3: Create the complete token foundation**

Start `claude_tokens.css` with the Hallmark app stamp and the exact token block:

```css
/* Hallmark · genre: modern-minimal · macrostructure: Workbench · design-system: design.md · designed-as-app */
:root {
  color-scheme: light;
  --mp-window-bar: 36px;
  --mp-sidebar-width: 288px;
  --mp-sidebar-collapsed: 44px;
  --mp-content-width: 768px;
  --mp-inspector-min: 420px;
  --mp-inspector-max: 760px;
  --mp-page: #FCFCFB;
  --mp-sidebar: #FBFBF9;
  --mp-panel: #FDFDFC;
  --mp-panel-subtle: #F3F3F2;
  --mp-composer: #FCFCFB;
  --mp-selected: #EDECE8;
  --mp-text: #0B0B0B;
  --mp-text-secondary: #52514E;
  --mp-text-muted: #898781;
  --mp-rule: rgba(11,11,11,.10);
  --mp-clay: #D97757;
  --mp-activity-blue: #86ACEA;
  --mp-font-ui: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  --mp-font-mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  --mp-ease-out: cubic-bezier(.32,.72,0,1);
  --mp-dur-fast: 120ms;
  --mp-dur-normal: 180ms;
  --mp-dur-structure: 300ms;
}
body[data-ds-dark-theme] {
  color-scheme: dark;
  --mp-page: #151515;
  --mp-sidebar: #111111;
  --mp-panel: #1E1E1E;
  --mp-panel-subtle: #303030;
  --mp-composer: #20201F;
  --mp-selected: #292929;
  --mp-text: #F0EFEC;
  --mp-text-secondary: #C3C2B7;
  --mp-text-muted: #898781;
  --mp-rule: rgba(255,255,255,.10);
}
```

Add the base reset, typography, focus-visible, reduced-motion, and form-control inheritance from `design.md` without importing an old stylesheet.

- [x] **Step 4: Rebuild the HTML shell while preserving required IDs**

Use this top-level structure:

```html
<div class="mp-shell" id="shell" data-view="chat" data-sidebar="expanded">
  <header class="mp-window-bar" id="window-titlebar">…</header>
  <div class="mp-app-body">
    <aside class="mp-sidebar">…</aside>
    <main class="mp-primary">…</main>
    <aside class="mp-inspector" id="project-inspector" hidden>…</aside>
  </div>
</div>
```

Keep IDs consumed by `studio.ts`; remove the old File/Edit/View/Help buttons, mandatory project gate, permanent low-frequency nav, mode dropdown, and bento-only wrapper. Add the app menu/search/mode segment/home/workspace chip IDs from the test.

- [x] **Step 5: Implement shell/chat base CSS**

Implement every selector used by the new structure. The non-negotiable geometry is:

```css
.mp-shell { display:grid; grid-template-rows:var(--mp-window-bar) minmax(0,1fr); height:100vh; background:var(--mp-page); color:var(--mp-text); }
.mp-window-bar { grid-row:1; display:flex; align-items:center; height:var(--mp-window-bar); -webkit-app-region:drag; }
.mp-window-bar button { -webkit-app-region:no-drag; }
.mp-app-body { grid-row:2; display:flex; min-width:0; min-height:0; }
.mp-sidebar { flex:0 0 var(--mp-sidebar-width); width:var(--mp-sidebar-width); background:var(--mp-sidebar); border-right:1px solid var(--mp-rule); }
.mp-primary { flex:1 1 auto; min-width:0; min-height:0; background:var(--mp-page); }
.mp-inspector { position:relative; flex:0 0 clamp(var(--mp-inspector-min),46vw,var(--mp-inspector-max)); margin:8px 8px 8px 0; border:1px solid var(--mp-rule); border-radius:8px; background:var(--mp-panel); overflow:hidden; }
.mp-transcript-width,.mp-composer-width { width:100%; max-width:calc(var(--mp-content-width) + 64px); margin-inline:auto; padding-inline:32px; }
```

Complete all reachable states before moving on; no empty legacy class may determine layout.

- [x] **Step 6: Change the native titlebar overlay to 36px and stop sampling pixels**

Set overlay height to 36 and use deterministic theme symbol colours. Remove `startTitleBarSampling()`/timer invocation for dashboard Studio and its capture loop; retain unrelated pure contrast utilities until zero-consumer cleanup.

- [x] **Step 7: Run GREEN plus typecheck**

```powershell
node tests/studio_claude_fidelity_contract_test.js
npm run typecheck
```

- [x] **Step 8: Commit**

```powershell
git add electron/renderer/claude_tokens.css electron/renderer/claude_shell.css electron/renderer/claude_chat.css electron/renderer/studio.html electron/main.ts tests/studio_claude_fidelity_contract_test.js
git commit -m "feat: rebuild Studio shell with Claude geometry"
```

---

### Task 5: Build the landing action centre and shared composer

**Files:**
- Create: `electron/renderer/studio_home.ts`
- Test: `tests/studio_home_render_test.ts`
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/renderer/data.ts`

- [x] **Step 1: Write a failing pure render test**

Use a minimal fake DOM or exported string render helpers to assert:

```ts
const assert = require('node:assert');
const { renderStatsCard, selectAttentionItems } = require('../electron/renderer/studio_home');

const attention = selectAttentionItems([
  { id: 'done', updatedAt: 2, state: 'ready' },
  { id: 'ask', updatedAt: 1, state: 'awaiting' },
  { id: 'run', updatedAt: 3, state: 'running' },
]);
assert.deepStrictEqual(attention.map(x => x.id), ['ask', 'run', 'done']);
const html = renderStatsCard({ sessions: 2, messages: 4, totalTokens: 10, activeDays: 1, currentStreak: 1, longestStreak: 1, peakHour: 16, favoriteModel: 'm1', heatmap: [] });
assert(html.includes('会话') && html.includes('消息') && html.includes('10'));
assert(!html.includes('undefined') && !html.includes('NaN'));
```

- [x] **Step 2: Run RED, implement, and run GREEN**

```powershell
node --require tsx/cjs tests/studio_home_render_test.ts
```

The module must escape all user/store strings, order attention as awaiting → running → review/resumable → unread ready, and render missing metrics as `—`.

- [x] **Step 3: Wire one shared composer**

The home and transcript toggle content, not forms. Keep one `#composer-form`; move it into a shared anchored region. `startNewChat()` shows `#studio-home`, clears active conversation, keeps the draft, and does not require a project. Opening a conversation hides home and renders stream.

- [x] **Step 4: Add environment chips and real stats loading states**

Wire `#composer-environment` and `#composer-workspace`; update their labels from the pure policy. Load `Data.conversationStats()` in parallel with conversations. Stats failure renders a muted inline error but leaves composer active.

- [x] **Step 5: Run contracts and interaction probes**

```powershell
node --require tsx/cjs tests/studio_home_render_test.ts
node tests/studio_claude_fidelity_contract_test.js
node tests/studio_composer_contract_test.js
```

- [x] **Step 6: Commit**

```powershell
git add electron/renderer/studio_home.ts electron/renderer/studio.html electron/renderer/studio.ts electron/renderer/data.ts tests/studio_home_render_test.ts
git commit -m "feat: add Studio action centre and shared composer"
```

---

### Task 6: Wire global search, app menu, mode segments, and new sidebar

**Files:**
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/renderer/claude_shell.css`
- Test: `tests/studio_navigation_interaction_test.js`
- Modify: `tests/studio_codex_chrome_contract_test.js`

- [x] **Step 1: Write failing structure/interaction assertions**

Assert Ctrl+K opens search, Escape closes it before stop, selecting a conversation/project/route calls the common navigation function, segmented Work/Design buttons have radio semantics, and the sidebar renders `本机会话` for unbound rows. Rewrite `studio_codex_shell_interaction_test.js` so the removed permanent Pull Requests/Sites/Scheduled/Plugins rows are forbidden and their destinations are reachable through search/Customize/Inspector instead.

- [x] **Step 2: Run RED**

```powershell
node tests/studio_navigation_interaction_test.js
node tests/studio_codex_chrome_contract_test.js
```

- [x] **Step 3: Implement the application menu and global search overlay**

The app menu owns existing commands. Search builds its bounded index after conversations/projects/directory load, renders at most 20 results, and routes each selection through `show`, `openConversation`, project binding, or command insertion. Keep a single document-level Escape handler with this order: active menu → search → local popover → settings/directory → sidebar search → graceful stop.

- [x] **Step 4: Replace mode dropdown and permanent nav**

Use `role="tablist"`/`role="tab"` for Work/Design. Remove permanent Pull Requests/Sites/Scheduled/Plugins rows. Expose those destinations in search/Customize/Inspector and attention rows.

- [x] **Step 5: Run GREEN and commit**

```powershell
node tests/studio_navigation_interaction_test.js
node tests/studio_codex_chrome_contract_test.js
node tests/sidebar_groups_test.js
git add electron/renderer/studio.html electron/renderer/studio.ts electron/renderer/claude_shell.css tests/studio_navigation_interaction_test.js tests/studio_codex_chrome_contract_test.js
git commit -m "feat: adopt Claude Studio navigation and search"
```

---

### Task 7: Restyle and simplify conversation, permissions, and composer states

**Files:**
- Modify: `electron/renderer/dsh_chat.ts`
- Modify: `electron/renderer/permission_presets.ts`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/renderer/claude_chat.css`
- Modify: `tests/studio_dsh_chat_contract_test.js`
- Modify: `tests/permission_presets_render_test.js`
- Create: `tests/studio_composer_states_test.js`

- [x] **Step 1: Write RED tests for the approved message grammar**

Assert user messages use one right-aligned pill; assistant text has no outer card; contiguous tools share one group; real reasoning is collapsed; errors retain full disclosure; unchanged activity signatures are not rebuilt; pending input is immediately above composer.

- [x] **Step 2: Flip permission presentation tests**

Keep runtime values but assert primary order/presentation:

```js
assert.deepStrictEqual(PRIMARY_PRESETS.map(x => x.value), ['plan', 'workspace-write', 'danger-full-access']);
assert.strictEqual(optionOf('workspace-write').label, '接受编辑');
assert.strictEqual(optionOf('read-only').primary, false);
```

- [x] **Step 3: Run RED**

```powershell
node tests/studio_dsh_chat_contract_test.js
node tests/permission_presets_render_test.js
node tests/studio_composer_states_test.js
```

- [x] **Step 4: Implement semantic adjustments and complete CSS states**

Preserve existing escaping/markdown/diff/tool summary functions. Change only wrappers/classes needed by the new contract. Implement default, hover, focus-visible, active, disabled, running, error, selected/success states for inputs, buttons, segmented controls, permission rows, message actions, and activity disclosures. Running + non-empty submit remains steer; running + empty submit remains stop; failed steer preserves text.

- [x] **Step 5: Run GREEN and adjacent stream tests**

```powershell
node tests/studio_dsh_chat_contract_test.js
node tests/studio_composer_states_test.js
node tests/studio_live_status_contract_test.js
node tests/studio_markdown_render_test.js
python -m pytest tests/conversation_stream_progress_test.py -q --basetemp=data/runtime/pytest-tmp-claude-stream
```

- [x] **Step 6: Commit**

```powershell
git add electron/renderer/dsh_chat.ts electron/renderer/permission_presets.ts electron/renderer/studio.ts electron/renderer/claude_chat.css tests/studio_dsh_chat_contract_test.js tests/permission_presets_render_test.js tests/studio_composer_states_test.js
git commit -m "feat: adopt Claude conversation and composer grammar"
```

---

### Task 8: Add a resizable, maximisable, state-retaining Inspector

**Files:**
- Create: `electron/renderer/studio_inspector_state.ts`
- Test: `tests/studio_inspector_state_test.ts`
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/renderer/claude_shell.css`

- [x] **Step 1: Write the failing state policy test**

```ts
const assert = require('node:assert');
const { clampInspectorWidth, reduceInspectorState } = require('../electron/renderer/studio_inspector_state');

assert.strictEqual(clampInspectorWidth(300, 1200), 420);
assert.strictEqual(clampInspectorWidth(900, 1600), 760);
assert.strictEqual(clampInspectorWidth(700, 1000), 572, 'leave a 420px primary pane plus 8px gap');
let state = { open: false, maximized: false, width: 560, previousWidth: 560, tab: 'files' };
state = reduceInspectorState(state, { type: 'open', tab: 'terminal' });
state = reduceInspectorState(state, { type: 'maximize' });
state = reduceInspectorState(state, { type: 'restore' });
assert.deepStrictEqual(state, { open: true, maximized: false, width: 560, previousWidth: 560, tab: 'terminal' });
```

- [x] **Step 2: Run RED, implement pure reducer, run GREEN**

```powershell
node --require tsx/cjs tests/studio_inspector_state_test.ts
```

- [x] **Step 3: Add resize/maximise controls**

Add an 8px drag handle, `inspector-maximize`, `inspector-close`, and header/context row. Persist width/tab/maximise in renderer storage. Keep expanded tree paths, selected file, browser URL, terminal output, and scroll in their current owning variables; do not reinitialise them on layout actions.

- [x] **Step 4: Coalesce BrowserView resize**

Schedule at most one `resizeProjectBrowser()` per animation frame during drag. Close/hide the BrowserView before the Inspector becomes hidden; reopen at the new bounds after restore.

- [x] **Step 5: Run GREEN and browser/file regressions**

```powershell
node --require tsx/cjs tests/studio_inspector_state_test.ts
node tests/studio_codex_chrome_contract_test.js
node tests/studio_file_tree_motion_test.js
```

- [x] **Step 6: Commit**

```powershell
git add electron/renderer/studio_inspector_state.ts electron/renderer/studio.html electron/renderer/studio.ts electron/renderer/claude_shell.css tests/studio_inspector_state_test.ts
git commit -m "feat: rebuild Studio Inspector interactions"
```

---

### Task 9: Consolidate Customize and replace the Design bento

**Files:**
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.ts`
- Modify: `electron/renderer/settings.ts`
- Modify: `electron/renderer/settings_model.ts`
- Modify: `electron/renderer/claude_shell.css`
- Modify: `tests/settings_surface_contract_test.js`
- Modify: `tests/studio_bento_contract_test.js`
- Modify: `tests/studio_plugin_directory_contract_test.js`

- [ ] **Step 1: Write RED contracts**

Assert Customize contains General/Appearance/Models/Permissions/Skills/Plugins/Connectors/Memory/Privacy/Voice/Shortcuts/Updates/Diagnostics, uses a continuous row sheet, and search covers directory entries. Assert Design no longer contains `.mp-design-bento` or marketing eyebrow/hero; it exposes Canvas/Assets/Files/Artifacts as workbench rows.

- [ ] **Step 2: Run RED**

```powershell
node tests/settings_surface_contract_test.js
node tests/studio_bento_contract_test.js
node tests/studio_plugin_directory_contract_test.js
```

- [ ] **Step 3: Implement Customize composition**

Keep the existing settings save/apply/rollback functions. Compose Skills/plugins/commands into the same sheet instead of a separate visual language. Search filters both settings and directory rows; selecting a command still inserts it into composer through the existing path.

- [ ] **Step 4: Implement Design workbench rows**

Replace bento markup with four quiet action rows. Each row routes to the existing canvas, list, file Inspector, or artifacts behaviour. No action is removed.

- [ ] **Step 5: Run GREEN and commit**

```powershell
node tests/settings_surface_contract_test.js
node tests/studio_bento_contract_test.js
node tests/studio_plugin_directory_contract_test.js
git add electron/renderer/studio.html electron/renderer/studio.ts electron/renderer/settings.ts electron/renderer/settings_model.ts electron/renderer/claude_shell.css tests/settings_surface_contract_test.js tests/studio_bento_contract_test.js tests/studio_plugin_directory_contract_test.js
git commit -m "feat: unify Studio Customize and Design workbench"
```

---

### Task 10: Remove the retired Studio visual stack

**Files:**
- Delete: `electron/renderer/studio_system.css`
- Delete: `scripts/consolidate_studio_css.ts`
- Delete: `tests/studio_css_consolidation_test.js`
- Delete zero-consumer Studio-only legacy CSS/SV files from the approved spec
- Modify tests that read retired CSS directly
- Modify packaging/build references if any

- [ ] **Step 1: Prove exact consumers before deletion**

Run:

```powershell
rg -n --fixed-strings "studio_system.css" electron scripts tests
rg -n --fixed-strings "dsh_chat.css" electron scripts tests
rg -n --fixed-strings "sv_motion.js" electron scripts tests
rg -n --fixed-strings "cards.css" electron/renderer/*.html
```

Expected decision: `cards.css` and `oreo_tokens.css` remain for Stage/Companion/Gallery/Lab. Delete only files whose remaining hits are their own parity tests or the retired consolidator.

- [ ] **Step 2: Write the failing no-legacy contract**

Extend `studio_claude_fidelity_contract_test.js` to assert the retired files do not exist and Studio HTML has no legacy href/script.

- [ ] **Step 3: Run RED**

```powershell
node tests/studio_claude_fidelity_contract_test.js
```

- [ ] **Step 4: Delete verified zero-consumer files and obsolete tests**

Use `apply_patch` deletions. Update semantic renderer tests to inspect the new CSS rather than pinning old DSH/SV source parity.

- [ ] **Step 5: Run GREEN, build, and commit**

```powershell
node tests/studio_claude_fidelity_contract_test.js
npm run typecheck
npm run build:electron
git add -A
git commit -m "refactor: retire the legacy Studio visual stack"
```

---

### Task 11: Render and tune every approved state against the references

**Files:**
- Create/modify: `scripts/probe_studio_claude.ts`
- Modify: new Studio CSS/HTML/renderer files as measurements require
- Test: `tests/studio_render_probe_contract_test.js`

- [ ] **Step 1: Write a deterministic probe contract**

The probe accepts `--width`, `--height`, `--scale-factor`, `--theme`, `--state`, and `--output`. It loads built `studio.html` with a fake preload before boot, injects bounded fixture data, waits for two animation frames, records console errors, and captures PNG.

- [ ] **Step 2: Run RED**

```powershell
node tests/studio_render_probe_contract_test.js
```

- [ ] **Step 3: Implement the probe and capture the matrix**

```powershell
npm run build:electron
npx --no-install tsx scripts/probe_studio_claude.ts --width 1560 --height 992 --scale-factor 2 --theme light --state conversation-inspector --output data/runtime/claude-studio-light.png
npx --no-install tsx scripts/probe_studio_claude.ts --width 1199 --height 800 --scale-factor 2 --theme dark --state landing --output data/runtime/claude-studio-dark.png
```

Also capture running, awaiting permission, error, Inspector maximised, Customize, Design, and minimum 1020×700 in both themes.

- [ ] **Step 4: Measure concrete reference failures and tune**

For each reference state, inspect:

- 36px chrome and 288px sidebar boundaries.
- 768px content centring and 480px stats card.
- Inspector 8px insets/radius and compressed centre gutters.
- Exact canonical surface pixels.
- Text baseline, row height, icon alignment, border alpha, composer anchoring.
- No unexpected horizontal scrolling or console errors.

Change CSS/markup only when the measured mismatch changes a concrete reference or state requirement.

- [ ] **Step 5: Run the Hallmark slop test at handoff time, fix actual failures, and commit**

Load `references/slop-test.md` only now. Fix any applicable desktop-app gate failure. Commit the verified render probe and tuning.

---

### Task 12: Fresh verification, review, version, ledger, and installed delivery

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `docs/design/MAGIC_POINTER_HARNESS_20260811.md`
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Run fresh fast gates**

```powershell
npm run typecheck
npm test
npm run lint
git diff --check
```

Expected: five TypeScript configurations pass; Node suite passes with the new source/test counts; ESLint and diff check are clean.

- [ ] **Step 2: Run fresh full Python suite**

```powershell
python -m pytest tests -q --basetemp=data/runtime/pytest-tmp-claude-studio-full
```

Expected: all tests pass; only already-documented non-failing warnings may remain.

- [ ] **Step 3: Run focused code review**

Review the complete diff against the approved spec on two axes: product behaviour and visual/state contract. Fix concrete findings and rerun affected tests. Do not add defensive scaffolding or score settled decisions.

- [ ] **Step 4: Bump patch version**

Use npm's non-tagging version command so package and lock agree:

```powershell
npm version patch --no-git-tag-version
```

Expected: `1.0.32` becomes `1.0.33` unless a newer patch version already exists when this step runs.

- [ ] **Step 5: Update progress truth**

Add one completed-phase entry to the canonical progress ledger and one concise delivery paragraph to `docs/STATUS.md`, including exact fresh counts, render evidence paths, version, known manual boundaries, and honest `usedBackend`/timing where exercised.

- [ ] **Step 6: Commit the verified source before sync**

```powershell
git add -A
git commit -m "feat: deliver Claude-fidelity Studio workbench"
```

- [ ] **Step 7: Run mandatory local sync**

```powershell
npm run sync
```

This reruns validation, builds NSIS, stops installed instances, installs silently, and restarts Magic Pointer.

- [ ] **Step 8: Verify installed truth**

```powershell
$dev = (Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json).version
$installedPath = Join-Path $env:LOCALAPPDATA 'Programs\Magic Pointer\resources\app\package.json'
$installed = (Get-Content -Raw -LiteralPath $installedPath | ConvertFrom-Json).version
if ($dev -ne $installed) { throw "version mismatch dev=$dev installed=$installed" }
Get-Process -Name 'Magic Pointer' -ErrorAction SilentlyContinue | Select-Object Id,Path
```

Expected: versions match and running processes point to `%LOCALAPPDATA%\Programs\Magic Pointer\Magic Pointer.exe`.

---

## Inline execution choice

The user explicitly instructed the agent not to pause for another choice after
the approved design. Execute this plan in the current session with
`superpowers:executing-plans`; do not dispatch subagents because the active
workspace instructions do not authorise subagent delegation for this task.

