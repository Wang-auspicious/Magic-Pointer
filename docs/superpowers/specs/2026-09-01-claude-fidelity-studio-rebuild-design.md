# Claude-Fidelity Studio Rebuild Design

> **Status:** Approved by the user on 2026-09-01. The user explicitly authorised
> both visual and behavioural replacement where Claude Desktop's interaction is
> better, and instructed implementation to begin without another approval gate
> after this document is written and self-reviewed.

## 1. Outcome

Rebuild Magic Pointer Studio as a quiet, precise desktop Agent workbench using
the supplied Claude Desktop light work-state and dark landing-state screenshots
as the visual standard and the locally installed Claude Desktop 1.37937.3
renderer as a measured implementation reference.

This is not a skin. The old Studio visual system and any inferior interaction
may be replaced. Magic Pointer retains ownership of its Runtime, deterministic
state, evidence, permissions, desktop actions, session truth, and product
identity. Claude patterns are adopted only after a Reuse Gate decision that they
fit Magic Pointer's stronger harness semantics.

## 2. Scope

### Included

- Studio window chrome, route history, sidebar, global search, landing page,
  project/session navigation, conversation stream, activity/tool rendering,
  shared composer, permissions and ask-user surfaces, Inspector, Customize,
  Design entry, light/dark themes, narrow-window behaviour, keyboard behaviour,
  update status, and local user/provider footer.
- Behaviour changes needed to make those surfaces coherent, including removing
  the mandatory-project gate and adding real landing statistics.
- Retiring the generated eight-layer Studio stylesheet and its Studio-only
  legacy source styles after the replacement reaches computed-style and
  behaviour parity for supported states.

### Excluded

- Stage overlay, gesture capture visuals, Companion, onboarding, Gallery, Lab,
  and Panel visual redesign. Their shared data may be consumed, but their
  surfaces remain unchanged.
- Replacing MPAgentRuntime, EventSession, ConversationStore, FrameLease,
  ActionLease, tool contracts, or permission invariants.
- Copying Claude branding, user-facing product claims, private service logic,
  proprietary font binaries, or the Anthropicons font into the Magic Pointer
  installer.

## 3. Reference facts

| Reference | Physical image | CSS viewport at DPR 2 | State |
|---|---:|---:|---|
| `0901-181514-1whiin.png` | 3120×1984 | 1560×992 | light conversation + File Inspector |
| `0901-181609-rq7zxt.png` | 2398×1600 | 1199×800 | dark landing, no Inspector |

Measured source facts from Claude Desktop 1.37937.3:

- Window chrome `36px`.
- Sidebar `288px`.
- Default transcript/composer content `768px` plus responsive gutters.
- Landing statistics card `480px` wide; measured reference `299px` high.
- Compact/relaxed sidebar rows `26px/32px`.
- Icon glyph `16px`, standard stroke `1.5px`.
- Base title/body/caption sizes `22px/13px/11px`.
- Token radii and micro-spacing `0,2,3,4,5,6,8,10,12px`.
- Fast/structural durations `120ms/300ms` and
  `cubic-bezier(.32,.72,0,1)`.

Screenshot pixel clusters confirm the canonical surface values recorded in the
root [`design.md`](../../../design.md). The implementation uses those values
directly; converted approximations are not canonical.

## 4. Reuse Gate

| Existing area | Verdict | New decision |
|---|---|---|
| `MPAgentRuntime`, EventSession, receipts, evidence | Reuse | They are product truth and are stronger than the reference client surface. |
| ConversationStore thread/workspace binding | Refactor and reuse | Preserve per-thread binding, but allow a thread with no folder. |
| `studio.ts` event/IPC wiring | Refactor and split | Preserve proven data flows; move touched navigation, home, search, and workspace policies into focused modules. |
| `dsh_chat.ts` semantic rendering | Refactor and reuse | Keep truthful grouping, streaming, reasoning, receipts, and diff logic; replace its visual vocabulary completely. |
| mandatory project gate | Delete | It blocks supported non-project tasks and conflicts with MP's product boundary. |
| File/Edit/View/Help title menu | Replace | One application menu plus search, sidebar, back, and forward is clearer and matches the reference. |
| Work/Design dropdown | Replace | Use a persistent two-segment switch in the sidebar. |
| permanent Pull Requests/Sites/Scheduled/Plugins sidebar rows | Relocate | Move to global search, Customize, Inspector, and attention surfaces. |
| Design marketing hero and bento cards | Replace | Use the same workbench grammar as the rest of Studio. |
| Inspector capabilities | Refactor and reuse | Preserve Files/Browser/Terminal/Changes/Tasks, but adopt Claude File-panel hierarchy, resizing, maximise, and state retention. |
| permission presets | Refactor and reuse | Primary UI becomes Plan / Accept edits / Full access; Read-only remains in more options. Runtime mappings remain deterministic. |
| per-turn model switching | Reuse | MP can safely do more than Claude's fixed-session model behaviour. |
| generated `studio_system.css` cascade | Delete after replacement | It is the source of cross-generation visual leakage. |
| old spring/bento Studio motion | Delete after replacement | Claude reference uses restrained non-overshooting motion. |

## 5. Architecture

### 5.1 Truth layers

```text
EventSession / ConversationStore / project registry / settings / updater
                              ↓
        focused renderer projections and pure policies
                              ↓
     one Studio shell + one sidebar + one composer + Inspector
                              ↓
        Claude-fidelity tokens and stateful components
```

The renderer may derive layout and presentation state. It may not create a
second durable session store, infer success from prose, manufacture usage
statistics, or change workspace identity without an explicit user action.

### 5.2 Module boundaries

- `studio.ts` remains the integration root but stops owning every pure decision.
- A home projection module computes attention items and statistics from bounded
  conversation data.
- A search module merges bounded results from conversations, projects, file
  names already loaded, Slash/Skill directory entries, and known destinations.
- A workspace policy module decides whether a tool surface is available with an
  optional folder; it never invents a fallback folder.
- The chat renderer continues to own message/activity semantics.
- CSS is split into locked tokens, shell/panels, and chat/composer. Studio does
  not load the old generated cascade underneath them.

## 6. Exact shell geometry

### 6.1 Window chrome

- Height `36px`, draggable except for controls.
- Left sequence: application menu, sidebar toggle, global search, back, forward.
- Controls use `28px` hit boxes with centred `16px` glyphs.
- Native Windows caption controls remain at the right and receive transparent
  overlay colour plus theme-correct symbol colour.
- The existing 500ms titlebar screenshot sampler is removed: Studio no longer
  renders an arbitrary video/image beneath caption buttons, so deterministic
  theme tokens are the correct source and avoid persistent capture work.

### 6.2 Sidebar

- Expanded width `288px`; collapsed rail `44px`.
- Begins below the 36px chrome and reaches the window bottom.
- Main row height `26px`; section/relaxed row `32px`.
- Horizontal content inset `8px`; selected rows use `6px` radius.
- Work/Design segmented control is `28px` high.
- Update and user/provider surfaces are anchored at the bottom and do not scroll
  with sessions.

### 6.3 Primary pane

- Fills the remainder after sidebar and optional Inspector.
- Landing and transcript content use a maximum `768px` content width.
- Normal gutters are `32px`; compressed gutters are `20px`; below `720px`
  primary-pane width they become `16px`.
- Assistant transcript lines use the content column; user pills align to its
  right edge.

### 6.4 Inspector

- Inset `8px` from top after chrome, right, and bottom.
- Radius `8px`; one hairline border; no decorative shadow in the light theme.
- Default width is 46 percent of the post-sidebar window, clamped to
  `420–760px`.
- Drag resize clamps both Inspector and primary pane; primary pane never drops
  below `420px` while Inspector is docked.
- Maximise temporarily occupies the post-sidebar area and Restore returns the
  exact previous width and tab.

## 7. Visual system

### 7.1 Surfaces

- Light page `#FCFCFB`, sidebar `#FBFBF9`, panel `#FDFDFC`, selected
  `#EDECE8`, secondary fills `#F3F3F2`.
- Dark page `#151515`, sidebar `#111111`, panel `#1E1E1E`, selected `#292929`,
  secondary fills `#303030`, composer `#20201F`.
- Static hierarchy uses surface tone and `rgba(...,.10)` hairlines.
- Shadows are allowed only for floating menus, popovers, dialogs, and detached
  sheets. Cards embedded in the page do not float.

### 7.2 Typography

- UI is system-native and optimised for Chinese: Segoe UI Variable Text,
  Microsoft YaHei UI, then system fallbacks.
- Assistant prose uses `13px/1.55`; ordinary chrome uses `13px/18px`.
- Landing title is `22px/28px` weight 500.
- Group labels and metadata use `12px` or `11px`; tool payload and paths use
  Cascadia Mono at `12px/17px`.
- No italic headings, fake editorial eyebrow labels, or excessive bold text.

### 7.3 Icons

- Reuse redistributable SVG paths already in Magic Pointer or Lucide-derived
  assets registered in `THIRD_PARTY_NOTICES.md`.
- Standard icon viewport `24`, rendered `16px`, stroke `1.5px`, round caps and
  joins. File-type exceptions may use filled 1px pixel pictograms.
- Magic Pointer keeps its own mark; the Claude starburst is not copied.

### 7.4 Motion

- Hover/press `120ms`; menus `180ms`; sidebar/Inspector structural change
  `300ms`; message insertion `180ms` opacity plus at most 4px translation.
- Focus rings do not animate.
- Tool rows do not replay entry animation when their data signature is
  unchanged.
- Reduced-motion mode removes translation, resizing travel, and pulse.

## 8. Surfaces and behaviour

### 8.1 Landing

- A direct greeting and Magic Pointer mark appear above the action centre.
- Attention order: awaiting approval, running, ready for review, resumable,
  unread completed.
- When no attention rows exist, the landing does not reserve blank cards.
- Real stats include sessions, messages, input+output tokens, active days,
  current/longest streak, peak hour, favourite model, and a 26-week heatmap.
- Missing historical usage yields an em dash for that metric, not zero unless
  zero is known.
- The shared composer remains anchored near the bottom.

### 8.2 Optional workspace

- Renderer and main process no longer reject a send without `workspaceRoot`.
- The bridge receives no workspace when neither the thread nor the current chip
  provides one. It does not silently adopt the profile default for that thread.
- Runtime boots ordinary Agent, desktop, MCP, attachment, memory, and Skill
  surfaces without coding tools.
- When a workspace-bound capability is requested, the model receives a truthful
  unavailable result and the UI offers `选择文件夹…`.
- Selecting a folder binds only the current thread and registers that project.

### 8.3 Sidebar and navigation

- Work/Design segmented switch replaces the dropdown.
- New creates an unbound draft immediately.
- Customize opens the continuous customization sheet.
- Project groups contain their threads; unbound threads appear in a local group.
- Global search ranks exact title/path/command matches before substring matches.
- Back/forward replays routes without creating duplicate history entries.
- Low-frequency product surfaces are destinations, not permanent sidebar rows.

### 8.4 Conversation

- User message pills align right; assistant responses are unboxed.
- Consecutive tool calls group under a truthful summary and preserve individual
  input/output/error/usedBackend disclosures.
- Real reasoning is separately labelled and initially collapsed.
- Plans render from real todo state; completion checkboxes cannot be toggled by
  the renderer unless the Runtime reports the change.
- Permission and ask-user surfaces attach above the composer and reconstruct
  from the latest unconsumed pending input after restart.
- Streaming, queue/steer, graceful stop, scroll-follow, and branch behaviour
  keep their proven data paths.
- Real reasoning follows Claude Code Desktop's timeline grammar: a quiet
  Extended-Thinking row, a one-line collapsed recap, and an expanded body that
  shows the actual stored reasoning text. Completed long reasoning is capped at
  200px with a bottom fade and explicit Show more/Show less; streaming reasoning
  remains uncapped. The UI never invents hidden reasoning.
- `Agent`/legacy `delegate_task` calls use Claude's subagent row grammar: Agent
  glyph, real task description, running/completed state, step count, and a
  disclosure containing child tool activity that the Runtime actually emitted.

### 8.5 Composer

- Landing and conversation share the same form and state controller.
- Default/hover/focus/active/disabled/running/error/success states use the locked
  token system.
- Environment/folder chips sit above the composer.
- Primary permission choices are Plan, Accept edits, and Full access; Read-only
  lives in more options.
- Attachments, mention, Slash/Skill, model, context usage, voice capability, and
  send/stop remain real controls.
- Running + non-empty submit = steer. Running + empty submit or stop button =
  graceful stop. Failed steer preserves the draft.

### 8.6 Inspector

- Header: panel name, maximise/restore, close.
- Context row: file/path, code view, search, system open, copy.
- Content types: Files, Browser, Terminal, Changes/Review, Tasks.
- The currently selected path, tab, scroll, expanded tree nodes, browser URL,
  and terminal output survive message rerenders and width changes.
- BrowserView bounds update after resize and close; it never coverlays Studio
  controls after the Inspector changes state.
- Tasks is the Claude-style compact task lane. It projects real parent and
  subagent activity, orders running work before finished work, and exposes each
  task's description, current tool, step count, status, and final summary.
  Opening an Agent row focuses the matching task. No real task means an honest
  empty lane, not fixture activity.

### 8.7 Customize

- Categories: General, Appearance, Models/Providers, Permissions, Skills,
  Plugins, MCP/Connectors, Memory/Context, Perception/Privacy, Voice, Shortcuts,
  Updates, Diagnostics/About.
- Search indexes category, title, description, model, Skill, plugin, connector,
  and shortcut text.
- Settings remain bound to the existing save/apply/rollback chain.
- Content is a continuous sheet with hairline rows, not nested cards.
- Claude Code Desktop's information architecture is adopted where MP has a
  real equivalent: model/effort and thinking display, default permissions,
  Skills, plugins, MCP/connectors, workspace memory, hooks/automation entry
  points, terminal/environment, updates, diagnostics, and managed/local
  configuration visibility. Unsupported Claude-only account controls are not
  copied as dead toggles.

### 8.8 Design

- Design remains a first-class segment because it is an MP product capability.
- It uses the same landing/workbench grammar instead of a separate marketing
  hero and bento language.
- Canvas, asset list, project files, and generated artifacts become plain action
  rows and contextual Inspector destinations.

## 9. State matrix

| Surface | Required states |
|---|---|
| Shell | light, dark, sidebar expanded/collapsed, Inspector closed/docked/maximised, narrow |
| Landing | no history, stats only, attention items, stats loading, stats partial, stats error |
| Conversation | draft, streaming, tool running, awaiting permission, awaiting answer, queued steer, stopped, completed, failed, resumable |
| Composer | empty, text, multiline, attachments, focus, disabled, running/stop, steer pending, error, permission attached |
| Sidebar row | idle, hover, selected, running, awaiting, review, unread, error, archived |
| Inspector | empty, loading, content, filtered, read error, browser loading/error, terminal running, maximised |
| Customize | loading, filtered, dirty, saving, saved, failed/rolled back |
| Update card | absent, checking, downloading, ready/relaunch, failed |

## 10. Data flow

### 10.1 Boot

1. Theme boot applies the saved/system theme before first paint.
2. Renderer loads bounded conversations, projects, settings, model catalogue,
   Slash directory, updater state, and existing route.
3. Pure projections derive sidebar groups, attention rows, and statistics.
4. The shell renders once; late sources patch only their owned region.

### 10.2 Send without folder

```text
composer snapshot
  → renderer send payload (workspaceRoot omitted)
  → main authorises sender and opens/continues thread
  → conversation bridge boots without coding workspace
  → Runtime exposes non-workspace capabilities
  → stream/progress/session events
  → ConversationStore persists the same unbound thread
```

### 10.3 Bind folder

```text
folder picker
  → validated existing directory
  → current draft/thread workspaceRoot update
  → project registry update
  → project-scoped tools become available next turn
```

The profile default is unchanged unless `/cwd` explicitly changes it.

### 10.4 Statistics

- The main process projects bounded aggregate data from ConversationStore turns.
- Token totals include only finite stored usage fields.
- Day and streak calculations use local calendar days.
- Heatmap covers the most recent 182 days ending on the current week.
- The renderer receives aggregates, not full EventSession logs.

### 10.5 Global search

- Immediate local results: routes, conversations, projects, loaded Skills and
  commands.
- File results use the active project's already-loaded tree first; a deliberate
  expanded search may request a bounded project search.
- Selecting a result routes through the same navigation controller, so
  back/forward remains correct.

## 11. Error semantics

- Bridge failure preserves the Composer draft and shows the exact error code,
  exit code, usedBackend, and timing in an expandable inline surface.
- Missing folder is a capability state, not a failed conversation.
- Missing or deleted bound folder marks the environment chip and offers a
  replacement; it does not silently use another path.
- Stats source failure hides no conversation data and does not block sending.
- Inspector read errors stay inside the Inspector and preserve its prior path.
- Permission/ask-user failure remains actionable and can be retried.
- Stale progress from another request/session is ignored by request id and may
  not mutate the active transcript.
- Update failure is shown only in the update card and diagnostics; it does not
  block Studio.

## 12. Accessibility and keyboard behaviour

- Every icon-only button has an accessible name and tooltip.
- Focus-visible rings are immediate and at least 3:1 against the adjacent
  surface.
- Main controls remain keyboard reachable in visual order.
- Escape closes the nearest open menu/search/sheet first, then performs the
  existing graceful-stop behaviour only when no local overlay consumed it.
- Ctrl+K opens global search; Ctrl+N opens a draft; Ctrl+O selects a folder;
  Ctrl+B toggles the sidebar; Ctrl+Shift+B toggles Inspector; Ctrl+, opens
  Customize; existing slash and composer shortcuts remain.
- Text zoom and Windows scaling do not create horizontal scrolling in the shell.

## 13. Performance

- Idle Studio performs no screen capture, UIA scanning, or periodic titlebar
  screenshot sampling.
- Sidebar/home aggregates operate on bounded stored summaries.
- Inspector tree children load lazily.
- BrowserView resize is animation-frame coalesced.
- Rerenders are keyed by content signatures so streaming does not rebuild
  unchanged tool rows, menus, or Inspector state.

## 14. File-level implementation plan

### Create

- `electron/renderer/claude_tokens.css` — locked light/dark tokens and base reset.
- `electron/renderer/claude_shell.css` — chrome, sidebar, landing, Inspector,
  Customize, Design, menus, window responsiveness.
- `electron/renderer/claude_chat.css` — transcript, activities, composer,
  pending-input and permission surfaces.
- `electron/studio_home_stats.ts` — bounded real statistics projection.
- `electron/renderer/studio_home.ts` — landing and attention rendering.
- `electron/renderer/studio_search.ts` — pure search indexing/ranking and overlay.
- `electron/renderer/studio_workspace_policy.ts` — optional workspace UI policy.
- Behaviour tests for statistics, optional workspace, navigation/search,
  Inspector state, composer state, and the new visual contracts.

### Modify

- `electron/renderer/studio.html` — new shell structure and stylesheet entry.
- `electron/renderer/studio.ts` — integration wiring and extraction to focused
  modules.
- `electron/renderer/dsh_chat.ts` — semantic class/output adjustments only where
  the new component contract requires them.
- `electron/renderer/sidebar_groups.ts` — include unbound local sessions and
  attention ordering.
- `electron/renderer/permission_presets.ts` — Claude-shaped primary choices with
  existing deterministic mappings.
- `electron/renderer/data.ts`, `electron/preload.ts`, `electron/main.ts` — stats,
  search/update data where required and removal of mandatory-project rejection.
- `electron/conversation_store.ts` — preserve an explicitly unbound thread and
  expose bounded aggregates without adding a second store.
- `electron/titlebar_contrast.ts` tests/callers — remove the obsolete periodic
  titlebar sampler from Studio while retaining any unrelated utility users.
- Existing Studio contract tests — replace old CSS-generation assumptions with
  exact geometry, colour, state, and behaviour contracts.
- `docs/design/MAGIC_POINTER_HARNESS_20260811.md` and `docs/STATUS.md` after the
  phase is implemented and verified.
- `package.json` patch version after all behaviour and visual verification pass.

### Delete after zero-consumer verification

- `electron/renderer/studio_system.css`.
- `scripts/consolidate_studio_css.ts`.
- `tests/studio_css_consolidation_test.js`.
- Studio-only legacy source styles that have no remaining HTML or test consumer:
  `electron/renderer/oreo.css`, `electron/renderer/dsh_tokens.css`,
  `electron/renderer/dsh_chat.css`, `electron/renderer/studio.css`,
  `electron/renderer/dsh_web.css`, and `electron/renderer/magic_studio.css`.
- `electron/renderer/sv.css` and `electron/renderer/sv_motion.ts` only after the
  new restrained state transitions replace their remaining Studio consumers.
- Tests whose only purpose is to pin retired DSH/SV visual source parity.

`oreo_tokens.css` and `cards.css` remain because Stage, Companion, Gallery, or
Lab still consume them. No shared file is deleted merely because Studio stops
using it.

## 15. Test-first and verification design

Every production behaviour or refactor begins with an observed failing test.

### Behaviour tests

- Main process accepts a conversation with no workspace.
- Bridge boot omits coding tools for an unbound thread and does not read the
  profile default implicitly.
- Selecting a folder binds only the current thread.
- Unbound conversations appear in the sidebar.
- Statistics ignore malformed usage, group local calendar days correctly, and
  compute streak/peak/favourite-model deterministically.
- Global search ranks and routes each result type.
- Escape priority, back/forward history, sidebar state, Inspector state, and
  Composer steer/stop retain their contracts.

### Visual contract tests

- Titlebar 36px, sidebar 288px, collapsed rail 44px, content max 768px,
  Inspector inset/radius/clamps, statistics width 480px.
- Canonical light/dark colour tokens equal the measured values.
- Icon size/stroke, row heights, type sizes, radii, durations, and easing equal
  the locked system.
- Studio HTML loads only the new Studio token/shell/chat styles plus explicitly
  retained shared functional assets.
- No old generated Studio stylesheet or legacy Studio-only source remains in
  the packaged renderer after deletion.

### Render probes

- DPR 2 screenshots at 1560×992 CSS and 1199×800 CSS.
- Light conversation with File Inspector and long mixed Chinese/English content.
- Dark landing with no project, real/fixture stats, sidebar empty state, and
  composer.
- Both themes for running, awaiting permission, error, Inspector maximised,
  Customize, Design, and narrow minimum window.
- Direct pixel sampling verifies surface colours and major rectangles; human
  inspection verifies typography rhythm, icon alignment, and absence of
  plastic elevation.

### Full gates and delivery

1. Targeted RED/GREEN tests throughout implementation.
2. Fresh five-configuration TypeScript check.
3. Fresh Node suite.
4. ESLint with zero warnings.
5. Fresh full Python suite.
6. Electron build and headless render probes with zero console errors.
7. Patch version bump.
8. Progress ledger and `docs/STATUS.md` delivery line.
9. `npm run sync` to validate, build NSIS, install, and restart.
10. Confirm the installed `resources/app/package.json` version equals the
    development tree and the running processes use the installed application.

## 16. Acceptance conditions

- At both supplied viewport sizes and DPR 2, shell geometry and canonical
  surfaces match the references at measured boundaries.
- The interface feels light because hierarchy is carried by spacing, type, tone,
  and hairlines rather than nested rounded cards or heavy shadows.
- A user can start useful work without choosing a folder.
- No MP-exclusive Runtime capability is lost.
- No inferior old Studio behaviour is kept merely because it already exists.
- Every visible statistic, state, progress item, permission, error, and result is
  derived from real product data.
- The installed local application, not only the development tree, contains the
  verified result.

