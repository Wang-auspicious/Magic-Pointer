# Magic Pointer Studio — DSH source-faithful transplant

Date: 2026-08-17

## Decision

The approved implementation is a direct structural transplant from the local
MIT-licensed `deepseek-harness` client at commit
`47f943859bef60e4160492346772ded9b24f765a`. DSH owns the visual grammar,
geometry, density, interaction states and component hierarchy. Magic Pointer
keeps its own name, mark, settings content, runtime contracts and truthful
conversation data.

This replaces the rejected 1.0.7 implementation, which only approximated DSH
with a custom five-destination sidebar, a sparse header, plain-text assistant
answers and a hard-coded `Thinking` placeholder.

## Exact shell contract

- Sidebar: 280px DSH `SidebarRoot` geometry; 60px Magic Pointer brand row;
  38px new-chat control; `WorkspaceBrowser` section header labelled `工作区`
  with inline search, filter and add controls; grouped 34px project rows and
  32px session rows; only the settings action in the footer.
- Conversation: DSH `ConversationRoot` hierarchy with a 20/28px header, a
  shrinkable title, a compact Magic Pointer preset label, `对话` / `轨迹` tabs,
  a right-aligned source tag inspired by the supplied ZCode reference, and the
  DSH 32px `Session log` pill. Header controls must never overlap the title.
- Content: centered 748px chat column, 780px composer maximum, 16px side
  clearance, DSH message spacing, disclosure rows and assistant typography.
- Composer: sticky DSH `InputBar` card, 22px radius, real permission/model
  controls, send state, task/goal strips and a real statistics line below the
  card.
- Auxiliary Magic Pointer destinations remain available from the compact
  product/source menu in the conversation header. They do not occupy permanent
  rows in the DSH workspace sidebar.
- Settings stays a DSH-shaped modal while preserving Magic Pointer's own
  controls and persistence semantics.

## Rendering and data contract

### Markdown

Assistant text is parsed into structural, safe Markdown DOM. The supported
surface includes headings, paragraphs, strong/emphasis/strikethrough, ordered
and unordered lists, task items, blockquotes, horizontal rules, fenced and
inline code, links and tables. Raw HTML is text, unsafe URL schemes never become
links, and rendering never concatenates user/model text into `innerHTML`.

### Process rows

The conversation bridge forwards the agent runtime event sink through the
existing structured progress protocol. The renderer correlates progress by a
request id and shows DSH `Think` lifecycle rows and real tool disclosures while
the turn is running. A completed turn stores and re-renders its real lifecycle,
tool receipts, backend, latency and model usage.

`Pwsh`, `Edit`, `Read`, `Grep` and other DSH variants are visual variants, not
fabricated capabilities. They appear only when the runtime actually reports
those tool names. Magic Pointer perception/action tools map to the closest DSH
visual variant while retaining their true names, arguments, results and error
states.

### Trajectory and statistics

The trajectory tab is projected from stored user/model/tool activity. It uses
DSH turn headers, 38px cells, input/output/think/time columns and real metrics.
The stats strip reports only derivable values: turns, steps, model/tool time,
TTFT when available, tokens and throughput when available. Unknown values are
omitted, never estimated.

`Session log` exports the active conversation as JSON through a user-initiated
save dialog.

## Theme and fidelity boundary

The Studio opens in the DSH dark presentation used by all supplied DSH
references, unless the user subsequently selects another theme in Magic
Pointer settings. Both token sets remain complete; no fake native title bar or
bright strip may appear in the dark presentation.

The copied DSH source/shape remains MIT-attributed. Magic Pointer branding,
Chinese copy, capabilities and settings content are not replaced with DSH
product identity.

## Verification

1. Red tests prove the current build lacks structural Markdown, progress IPC,
   DSH workspace grouping/header controls, trajectory projection and persisted
   metrics.
2. Focused unit/contract tests cover safe Markdown, event mapping, persistence,
   live correlation and DSH macro geometry.
3. A deterministic fixture containing Markdown plus truthful synthetic
   model/tool events is captured at normal and narrow sizes. The fixture is
   capture-only and never written into user history.
4. The installed application is captured with real user data to verify shell,
   dark chrome and non-overlap.
5. Full Python, Node, TypeScript and lint verification passes before version
   bump and `npm run sync`; the installed package version is then read back.
