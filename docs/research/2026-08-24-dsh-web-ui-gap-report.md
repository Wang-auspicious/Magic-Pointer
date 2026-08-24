# DSH Web Chat UI vs Magic Pointer Renderer — Gap Report

READ-ONLY research. DSH source: `C:\Users\zjz65\Documents\Default Project\deepseek-harness` (web UI lives in `packages/client/ui-*`, bootstrapped by `apps/web/src/main.ts`). MP renderer: `D:\Desktop\Magic Pointer\electron\renderer\`. Each finding cites both sides + one-line consequence. P0 = glaring user-visible gap.

**Bridge context that caps several gaps:** `conversations:send` is a one-shot Python subprocess (`electron/main.ts:1231-1302`, `timeoutMs: 120_000`) whose progress channel carries phase records only (`{phase, fields}` via `conversations:progress`, `main.ts:1270`; payload shape `scripts/conversation_bridge.py:775-779`). There is **no token-delta streaming, no cancel IPC, and no queue API** in `electron/preload.ts:192-220`. Several P0s are therefore GUI+bridge joint gaps, flagged as such.

---

## 1. Markdown rendering

Parity first: MP renders headings, hr, blockquote, tables, ordered/unordered lists with task checkboxes, links (http/mailto only), bold/em/strike, inline code — `dsh_markdown.ts:96-230`. Safe (no raw HTML). That surface is fine.

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P0-1 | **Code block has no language banner, no copy button, no syntax highlighting** — DSH fences render through `CodeBlock` with info-string label + copy button + shiki tokens; MP emits bare `pre>code.language-*`. | `ui-primitives/src/markdown/CodeBlock.tsx:20-74`, `highlight.ts` | `dsh_markdown.ts:128-138` | Every answer's code must be hand-selected to copy; long code reads as an undifferentiated wall of text. |
| P0-2 | **No KaTeX math** (`math`/`inlineMath` node kinds) — LaTeX from models renders as literal `\frac...` junk in MP. | `render.tsx:266-268`, `katex.tsx`, `MarkdownText.tsx` (imports katex css) | absent in `dsh_markdown.ts` | Any math-heavy answer is visibly broken. |
| P1-3 | **Images never render** — DSH renders absolute http(s) images inline; MP markdown has no image node at all. | `render.tsx:281-283`, `safeHref` allowlist `render.tsx:40-42` | absent in `dsh_markdown.ts` | Model-authored image links show as raw text. |
| P1-4 | **Footnotes, reference-style links, autolinks unsupported** — DSH resolves definitions + appends footnote section; MP drops them to literal text. | `render.tsx:279,285-288`, `renderFootnoteSection` `MarkdownText.tsx:14-29` | absent in `dsh_markdown.ts` | GFM-heavy replies lose their citation/footnote structure. |
| P1-5 | **File-mention linking**: DSH turns inline-code tokens recognized as real files into openable links. | `MarkdownText.tsx:103-106` (`fileMentions` gate) | absent | Paths in answers aren't clickable in MP. |
| P2-6 | CJK-friendly strong emphasis handling. | `cjkFriendlyStrong.ts:1-83` | absent | Minor typographic fidelity for CJK text. |

## 2. Message-level actions

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P1-7 | **Branch/fork a conversation from any message** — branch icon on every message row wired to `forkAt(seq)`; also session-level fork in sidebar menu. | `MessageIconActions.tsx:27,119-133`; `ui-conversation/src/client/apply.ts:417`; `ui-workspace/src/client/rows/Rows.tsx:388-391` | `dsh_chat.ts:415-433` (`messageActions` = clock + copy only) | Users cannot explore alternatives from a midpoint; one linear thread only. |
| P1-8 | **Auto-retry visibility**: DSH renders a retry-chain card with countdown, attempt count, delay & failure detail while the model retries. | `ui-conversation/src/client/chat/MessageItem.tsx:41-108` | nothing — failed send just swaps in `turnErrorNode` (`dsh_chat.ts:474-492`, `studio.ts:1518-1522`) | In MP a flaky backend looks like a dead stop instead of "retrying in 4s". |
| P2-9 | Turn-tail notices: max-output-token notice distinct from errors. | `MessageItem.tsx:132-143` (`TurnMaxTokensItem`) | absent | Truncated answers look like ordinary completions. |
| — | Edit-and-resend sent user message / regenerate button: **not found in DSH either** (only queued-message editing, see §5). Not a gap. | — | — | — |
| — | Copy-with-check feedback: parity (`dsh_chat.ts:606-633` ≈ `MessageIconActions.tsx:62-84`). | | | |

## 3. Streaming UX

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P0-10 | **Answer text does not stream at all in MP** — bridge returns the answer once at completion; DSH streams with an incremental parser that freezes settled blocks and re-parses only the tail per chunk. Joint GUI+bridge gap. | `MarkdownText.tsx:1-30,64-140` (`IncrementalMarkdownParser`); `ChatView.tsx:16-23` (per-row seat updates) | `main.ts:1271-1299` (single `onComplete`); `studio.ts:1459` (`await Data.sendConversation` then full re-render) | User stares at activity rows for the whole generation, then the full answer pops in at once — the single biggest feel difference. |
| P1-11 | **No scroll-to-bottom pill; follow-scroll is unconditional** — MP force-scrolls to bottom on every progress record even if the reader scrolled up; DSH tracks at-bottom with threshold, shows a chevron pill, preserves position across paging/prepends. | `ChatView.tsx:100-140,318-346,366-380` (`FOLLOW_THRESHOLD=24`, `toBottomSlot` pill) | `studio.ts` `renderConversationProgress`: `.scrollTo({ top: 1_000_000 })` (~line 1396); none else | Reading earlier turns mid-run is impossible in MP — view yanks to bottom each record. |
| P2-12 | Running-turn status has no elapsed clock — DSH shows "Deep diving…" plus run time after 15s anchored to turn start; MP prints static "Thinking". | `ChatView.tsx:104-140` (`TurnStatus`) | `dsh_chat.ts:468-472` (`turnStatusNode('Thinking')`) | Long waits look frozen; no sense of progress. |
| P2-13 | History paging ("load older" button with anchor-preserving prepend + loading hint). | `ChatView.tsx:382-392`, `hasMore/loadingOlder` | absent; `openConversation` renders whole transcript (`studio.ts:365-395`) | Long threads load fully or not at all; fine today, missing ceiling later. |
| — | Streaming cursor/carousel: DSH relies on tail re-parse, no caret glyph; MP n/a. Not a gap. | | | |

## 4. Tool rows

Parity: variant classification, IN/OUT card, four-state dot, running sweep (`dsh_chat.css:314`), error-first-line summary, keyboard toggling — good port (`dsh_chat.ts:250-412`).

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P1-14 | **No specialized cards: diff for file edits, terminal w/ ANSI, read w/ line numbers, search results, web citations** — DSH swaps the IN/OUT text for typed cards; every MP tool body is plain JSON/text. | `ui-tool/src/client/tool/components/ToolRow.tsx:26-45,246-280`; `DiffBlock.tsx`, `TerminalBlock`, `ReadBlock`, `SearchBlock`, `WebBlock` | `dsh_chat.ts:340-368` (ioCard text only); only the separate background-task card path has a diff (`card_render.ts:362-365`), unused for chat tools | An `edit` call shows JSON soup instead of a red/green diff — the highest-value tool visualization missing. |
| P2-15 | **Expand/collapse state is destroyed on every update** — MP rebuilds the whole pending body on each progress record (`replaceChildren`) and the whole flow on turn completion; DSH keeps expansion as component-local state updated per-row. | `ToolRow.tsx:11-13` (comment: local view state), `ChatView.tsx:19-23` | `studio.ts:1385-1397` (`records` → `replaceChildren`), `studio.ts:365-395` (`stream.replaceChildren(flow)`) | A tool row the user opened snaps shut seconds later when the next record lands. |
| P2-16 | File-path summary is a clickable link that opens the file in OS default app; plus "Inspect" pill jumping to trajectory view. | `ToolRow.tsx:47-52,222-240,282-290` | `deriveFilePath` computed (`dsh_chat.ts:225-232`) but rendered as plain text; no inspect jump | Can't open the edited file or cross-navigate to trajectory from a row. |

## 5. Composer

Parity: multi-line growth capped 14 lines (`studio.ts` `fitComposer` 336px ≈ DSH css.scroll 14-line cap), Enter/Shift+Enter, basic IME guard, model selector with real catalog, permission preset chip incl. Full-access confirmation gate, workspace chip, plan card, slash directory via `+`.

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P0-17 | **Cannot queue follow-ups while busy; no queue UI** — MP disables submit while `studioComposerBusy`; DSH accepts queued messages with a dock: per-row preview, edit, remove, steer-now, collapse count header, Ctrl+Enter steer-all gesture. Joint gap (no queue wire). | `InputBar.tsx:110-115` (`canSteerQueue`), `QueueDock.tsx:56-200` | `studio.ts:1470-1473` (`if (!textarea || !question || studioComposerBusy) return`), submit disabled `studio.ts:1477-1479` | During a 1-2min turn the user's next thought can only wait in their head; DSH users keep typing. |
| P0-18 | **No stop button during streaming** — DSH swaps Send→Stop (rect icon) whenever running; MP has no cancel path at all for `conversations:send` and just disables the button. Joint gap (no IPC). | `InputBar.tsx:555-571` (interruptible stop), `primaryStops` 543-554 | `preload.ts:196` (no cancel verb), `main.ts:1231-1302`, `studio.ts:1477` (submit.disabled=true) | A runaway/wrong turn runs to its 120s cap with no user exit. |
| P1-19 | **No image/file intake in the studio composer** — DSH supports paste-images, whole-window drag&drop with overlay, intake pre-checks against limits, attachment rail with lightbox + remove. Studio's `#composer-form` textarea has zero paste/drag handlers and no attachment UI (the standalone `Composer` module has a file picker but no paste, and isn't mounted here). | `InputBar.tsx:331-395` (`onPaste`, `intakeImages`), `400-452` (document drag listeners), AttachmentRail/ImageLightbox imports | grep `paste|drop` in `studio.ts` → none; `composer.ts:117-127` (file-picker only, other surfaces) | "Look at this screenshot" requires leaving the chat flow; gestures exist elsewhere in MP but not where conversations happen. |
| P1-20 | **Context/token usage ring is a dead element** — MP ships the ring markup with hardcoded title "暂无数据" and no JS ever touches it; DSH feeds it from `contextPressure` projection with click-open breakdown panel (system/tools/messages). | `ContextMeter.tsx:66-153` | `studio.html:185-190`; grep `composer-context` in `studio.ts` → 0 hits | User has no idea how close they are to context limits before a turn degrades. |
| P1-21 | **Slash menu doesn't trigger inline and has no keyboard navigation** — DSH opens on typing `/` (token claim highlight + ghost hint + chip placeholders + arrows/enter/undo machine); MP menu opens only by clicking `+`, no ArrowUp/Down, no decorations. | `ui-input-trigger/src/core/detect.ts`, `InputBar.tsx:155-260` (arbitrate/undo/chips/hint) | `studio.ts:802-905` (`openSlashMenu` bound to `#composer-add` click only; keydown handles Escape only) | Discoverability + speed loss; mouse required for commands. |
| P2-22 | IME robustness: DSH additionally guards legacy keyCode 229 and defers composition-end clearing (Safari quirk); MP checks only `isComposing`. Low risk inside Electron/Chromium. | `InputBar.tsx:126-136,243-245` | `studio.ts:1421-1427` | Edge-case premature send; minor on Electron. |
| P2-23 | Draft persistence + undo/redo owned by a state machine (survives session switch); MP draft lives in the DOM textarea only. | `InputBar.tsx:216-235` | `studio.ts` textarea value only | Switching sessions mid-thought loses the draft in MP. |
| — | Permission selector / model selector / workspace pick: parity (see above). Reply-style chip is MP-only extra, not a DSH feature. | | | |

## 6. Sidebar / session list

Parity: grouping by thread workspace with expand/collapse (`sidebar_groups.ts:48-79`, `studio.ts:283-320`), relative times, search box with clear/Esc, new-chat.

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P1-24 | **Row action menu is a dead button; rename/fork/archive/delete missing** — DSH ellipsis opens Menu with rename/fork/archive (+ dialogs, delete-confirm for workspaces); MP renders an `ellipsis` button with no handler whatsoever. | `Rows.tsx:388-430` (`sessionMenuItems`, dialogs), `WorkspaceBrowser.tsx:750,916,1257` | `studio.ts:330-350` (`ellipsis` appended; no listener anywhere) | Sessions can never be renamed, forked, archived, or deleted — list grows forever with fixed titles. |
| P1-25 | **No live/pending status on session rows** — DSH derives per-session StateDot: warning for pendingInteraction (waiting approval / plan review / question), ongoing for running (+subagent counts), done-unviewed reminder cleared on open — this *is* the "continue" affordance; MP's `side-dot` is unconditioned decoration. | `Rows.tsx:219-259` (`sessionStatuses`), `SessionNodeItem` 355-430 | `studio.ts:333-336` (dot with no state attr) | User can't tell which session is still working or waiting on them without opening each one. |
| P2-26 | Search covers conversation **content** with excerpt snippets + pending state (server-side `session.search`); MP filters titles/subtitles locally only. | `WorkspaceBrowser.tsx:34-41,697-725`; `Rows.tsx:321-366` | `sidebar_groups.ts:37-45` | "Which chat mentioned X?" is unanswerable in MP. |
| P3-27 | Group-by toggle (workspace vs flat) + manual ordering + drag-to-reorder rows + hover cards with full title/status/copy. | `WorkspaceBrowser.tsx:146-170,210-330`; `Rows.tsx:398-420` | fixed workspace grouping only | Power-user organization missing; cosmetic tier. |
| P3-28 | Sidebar collapse to icon rail with slide/fade animation. | `SidebarRoot.tsx:44-135` | absent (`studio.html` has no collapse control) | Screen-space nicety only. |

## 7. Empty / error / loading states

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P2-29 | Hero empty state: fish logo headline + glow backdrop + workspace chip CTA centered over the resident composer. MP blank state is two lines of plain text. | `EmptyHero.tsx:88-137` | `studio.ts:1544-1553` (`dshw-blank`) | First-run experience feels unfinished rather than branded. |
| P2-30 | Loading/error chrome for opening a session (`chat.loadingHistory` hint, `loadError` with message+code) and transient Toast banners (prompt failures, image rejections) anchored to the composer. MP has no loading indicator (blank until data arrives) and errors only appear as a turn-error row. | `ChatView.tsx:376-381`; `Toast.tsx:26-59`; `InputBar.tsx:97-121` | `openConversation` awaits silently (`studio.ts:301`); no toast system (grep `toast` → 0) | Slow loads look like hangs; recoverable failures give no feedback channel. |

## 8. Anything else

| # | Finding | DSH | MP | Consequence |
|---|---------|-----|----|-------------|
| P2-31 | **Steering bubbles**: messages sent mid-turn appear immediately as pending user bubbles in the flow (host-authoritative pre-admission), then reconcile into the transcript. MP has no steering concept. | `ChatView.tsx:394-398`; `MessageItem.tsx:213-238` | absent | Mid-run corrections are invisible until the whole turn ends. |
| P3-32 | Assistant/user clock extras: "Ran for 13s · TTFT 1.2s · 34 tok/s" appended under each message. | `MessageIconActions.tsx:86-113` | clock HH:MM only (`dsh_chat.ts:407-413`); aggregates exist separately in StatsLine (ported, `studio.ts:376-404`) | Per-turn latency story less legible; partially compensated. |
| P3-33 | `/@name` reference chips decorate sent user bubbles. | `MessageItem.tsx:152-180` (`projectUserText`) | absent | Sent mentions read as plain text. |
| P3-34 | Tooltips on every icon control (500ms delay) throughout DSH chrome; MP uses native `title` on some controls only. | `Tooltip.tsx` usages passim | scattered `title` attrs | Consistency polish. |

---

## Ranked top findings (P0/P1 first)

1. **P0** No answer streaming — full reply arrives once at end (`studio.ts:1459`, `main.ts:1271-1299` vs `MarkdownText.tsx:1-30`). Biggest felt difference.
2. **P0** No stop/cancel during a running turn (`studio.ts:1477`, `preload.ts:192-220` vs `InputBar.tsx:543-571`).
3. **P0** Cannot queue follow-ups while busy; no queue dock (`studio.ts:1470-1479` vs `QueueDock.tsx:56-200`).
4. **P0** Code blocks lack language label, copy button, highlighting (`dsh_markdown.ts:128-138` vs `CodeBlock.tsx:20-74`).
5. **P0** No KaTeX math rendering (`render.tsx:266-268` vs absent).
6. **P1** Session row menu dead — no rename/fork/archive/delete (`studio.ts:330-350` vs `Rows.tsx:388-430`).
7. **P1** No per-session pending/running status badge = no "continue" affordance (`studio.ts:333-336` vs `Rows.tsx:219-259`).
8. **P1** Force-follow scrolling, no at-bottom detection, no scroll pill (`studio.ts` ~1396 vs `ChatView.tsx:100-140,366-380`).
9. **P1** Tool rows: no diff/terminal/read/search/web cards (`dsh_chat.ts:340-368` vs `ToolRow.tsx:246-280`).
10. **P1** Branch/fork from any message missing (`MessageIconActions.tsx:119-133` vs `messageActions` `dsh_chat.ts:415-433`).
11. **P1** Composer: no paste/drag image intake in studio chat (`InputBar.tsx:331-452` vs none in `studio.ts`).
12. **P1** Context-usage ring is dead markup, no data feed (`studio.html:185-190` vs `ContextMeter.tsx:66-153`).
13. **P1** Slash menu not inline-triggered, no keyboard nav (`studio.ts:802-905` vs `ui-input-trigger/core/detect.ts`).
14. **P1** Markdown images/footnotes/reference links unsupported (`render.tsx:281-288` vs absent).
15. **P1** Auto-retry countdown invisible on failures (`MessageItem.tsx:41-108` vs `turnErrorNode` only).
16. **P2** Tool-row expand state collapses on every progress record / turn settle (`studio.ts:1385-1397,365-395` vs `ToolRow.tsx:11-13`).
17. **P2** Sidebar search is title-only; no content search with excerpts (`sidebar_groups.ts:37-45` vs `WorkspaceBrowser.tsx:697-725`).
18. **P2** No steering bubbles for mid-turn messages (`ChatView.tsx:394-398` vs absent).
19. **P2** Static "Thinking" label, no elapsed clock; no max-tokens notice (`dsh_chat.ts:468-472` vs `ChatView.tsx:104-140`, `MessageItem.tsx:132-143`).
20. **P2** No hero empty state / loading-history hint / toast banners (`EmptyHero.tsx:88-137`, `ChatView.tsx:376-381`, `Toast.tsx` vs plain blanks, silent awaits).

Items 1-3 and 11-12 are joint GUI+bridge gaps: fixing them in the renderer alone is impossible without adding wire surface (`conversations:` deltas/cancel/queue/context APIs in `preload.ts`/`main.ts`/bridge stdout contract).