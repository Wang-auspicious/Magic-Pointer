# Design — Magic Pointer Studio

This is the locked design system for Magic Pointer's Studio window. Every Studio
surface reads this file before changing layout, typography, colour, spacing,
motion, or component behaviour. The complete approved product specification is
[`docs/superpowers/specs/2026-09-01-claude-fidelity-studio-rebuild-design.md`](docs/superpowers/specs/2026-09-01-claude-fidelity-studio-rebuild-design.md).

## Provenance

- User references:
  - `0901-181514-1whiin.png`, 3120×1984 physical pixels, DPR 2.
  - `0901-181609-rq7zxt.png`, 2398×1600 physical pixels, DPR 2.
- Measured implementation reference: locally installed Claude Desktop
  1.37937.3, including its readable `ion-dist` CSS, component bundles, design
  tokens, and public UI strings.
- The reference is used to reproduce geometry, rhythm, state design, and
  interaction quality. Magic Pointer keeps its own name, product semantics,
  Runtime, data, and identity.
- Anthropic font and icon-font binaries are not redistributed because the
  installed package exposes no licence permitting reuse in Magic Pointer's MIT
  installer. The implementation uses metric-compatible system CJK typography
  and redistributable SVG icons with matching geometry and stroke.

## Genre and macrostructure

- Genre: quiet modern-minimal desktop workbench.
- App macrostructure: 36px window chrome + 288px work sidebar + flexible primary
  pane + optional inset Inspector.
- Content structure: action-centre landing, narrow conversation transcript,
  anchored composer, contextual Inspector, continuous Customize sheet.
- No marketing hero, ornamental bento dashboard, nested cards, glass gradients,
  or decorative motion in Studio.

## Canonical geometry

- Window chrome: `36px`.
- Expanded sidebar: `288px`; collapsed rail: `44px`.
- Primary transcript/composer content: `min(768px, available width)` with `32px`
  gutters where space allows and `20px` gutters when the Inspector compresses
  the centre pane.
- Landing statistics card: `480px` wide; its measured 1199×800 reference height
  is `299px`.
- Inspector: inset `8px` from top/bottom/right after the window chrome, radius
  `8px`, width clamped to `420–760px`, user-resizable.
- Compact rows: `26px`; relaxed rows: `32px`; icon glyphs: `16px`; standard
  icon stroke: `1.5px`.

## Colour tokens

Pixel-reference values are canonical. Do not convert them through another colour
space during rendering.

| Token | Light | Dark |
|---|---:|---:|
| `--mp-page` | `#FCFCFB` | `#151515` |
| `--mp-sidebar` | `#FBFBF9` | `#111111` |
| `--mp-panel` | `#FDFDFC` | `#1E1E1E` |
| `--mp-panel-subtle` | `#F3F3F2` | `#303030` |
| `--mp-composer` | `#FCFCFB` | `#20201F` |
| `--mp-selected` | `#EDECE8` | `#292929` |
| `--mp-text` | `#0B0B0B` | `#F0EFEC` |
| `--mp-text-secondary` | `#52514E` | `#C3C2B7` |
| `--mp-text-muted` | `#898781` | `#898781` |
| `--mp-rule` | `rgba(11,11,11,.10)` | `rgba(255,255,255,.10)` |
| `--mp-clay` | `#D97757` | `#D97757` |
| `--mp-activity-blue` | `#86ACEA` | `#86ACEA` |

Chromatic colour remains below five percent of a normal viewport. Clay identifies
Magic Pointer and active status; blue is reserved for activity density and
evidence, not generic buttons.

## Typography

- UI/body: `"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
  "Microsoft YaHei", system-ui, sans-serif`.
- Reading/assistant prose: the same system stack for Chinese; Latin may use the
  closest redistributable face only after metric comparison.
- Mono: `"Cascadia Mono", "SFMono-Regular", Consolas, monospace`.
- Body: `13px/18px`, weight `400`.
- Footnote: `12px/16px`, weight `400`.
- Caption: `11px/14px`, weight `400`.
- Heading: `14px/20px`, weight `580`.
- Landing title: `22px/28px`, weight `500`.
- Strong text uses weight `580`; controls use `500`; weight `700` is not used in
  ordinary Studio chrome.

## Spacing and radii

- Micro spacing: `0, 2, 3, 4, 5, 6, 8, 10, 12px`.
- Layout spacing extends with `16, 20, 24, 32, 40, 56px`.
- Radii: `0, 2, 3, 4, 5, 6, 8, 10, 12px`.
- Composer radius: `12px`; sheet radius: `16px`; pill radius is used only for
  user messages, status chips, and segmented controls.
- Shadows are reserved for floating menus and detached sheets. Static content
  hierarchy uses tone and hairlines, not elevation.

## Motion

- `--mp-dur-fast: 120ms`.
- `--mp-dur-normal: 180ms`.
- `--mp-dur-structure: 300ms`.
- `--mp-ease-out: cubic-bezier(.32,.72,0,1)`.
- Animate only `transform`, `opacity`, and deliberate cross-fades. Width changes
  use grid/flex interpolation only for sidebar and Inspector structure.
- No bounce, spring overshoot, shimmer decoration, or perpetual ambient motion.
- Reduced motion removes spatial travel and caps opacity changes at `120ms`.

## Behavioural system

- A folder is optional for a conversation. Workspace-bound tools remain absent
  until a folder is bound; ordinary Agent, desktop, attachment, MCP, and Skill
  work remains available.
- The top bar owns application menu, sidebar, global search, and route history.
- The sidebar owns Work/Design, New, Customize, project/session navigation,
  update status, and the local user/provider footer.
- Landing prioritises sessions needing attention, then real local usage stats.
- Conversation content is unboxed; user messages are compact pills; tool calls
  group into truthful expandable activity rows.
- Composer is shared by landing and conversation surfaces. Non-empty input while
  running steers; empty submit while running stops.
- Inspector owns Files, Browser, Terminal, Changes/Review, and Tasks. It can
  resize, maximise, restore, and close without resetting its internal state.
- Customize owns settings, models, permissions, Skills, plugins, connectors,
  memory, perception/privacy, voice, shortcuts, updates, and diagnostics.

## Component state discipline

Every interactive control implements default, hover, focus-visible, active,
disabled, busy, error, and success/selected states when those states are
semantically reachable. Focus rings appear instantly and remain visible at 3:1
contrast. Success is silent unless the user needs a durable receipt.

## What every Studio surface must share

- The geometry, colour, type, spacing, radius, icon, and motion tokens above.
- One titlebar, one sidebar, one composer, one permission surface, one menu
  language, and one error language.
- EventSession and ConversationStore remain the data truth; visual state never
  invents completion, token usage, project identity, or tool outcomes.

## What may vary

- Home, conversation, Design, Customize, and Inspector may vary content density.
- Inspector content types may use their native editor/terminal typography.
- Stage and Companion remain separate product surfaces governed by VIDA and are
  not restyled by this Studio design system in this phase.

