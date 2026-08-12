# Vida-inspired Stage surfaces

> Superseded for Stream Panel geometry, streaming behavior, phase transitions,
> and completion-card separation by
> `docs/superpowers/specs/2026-08-13-vida-fixed-stream-shell-design.md`.
> The newer specification records the user's correction after direct
> PromptRescue frame review. Unaffected capsule, safety, and accessibility
> constraints in this document still apply.

## Scope

Rework only Magic Pointer's transient interaction surfaces:

1. the command capsule;
2. the running/context panel;
3. the `TASK FINISHED` approval/result card;
4. small proposal/file preview tiles rendered inside those surfaces.

Vida's home page, logo, promotional end cards, and video-editing transitions are not product UI and are out of scope. Magic Pointer keeps its own product identity and behavior.

## Reference findings

All 8,667 frames of the five 1920×1080/60fps reference videos were scanned. The stable product patterns are:

- A white 40–44 DIP command capsule with a black circular submit/stop control.
- A narrow context sheet of roughly 406 DIP on the free side of the active application.
- A content-sized completion card. Short operations remain compact; substantial drafts can expand to roughly 834×304 DIP.
- Completion cards use a monospaced, letter-spaced status eyebrow, plain high-contrast body copy, a hairline footer, a retry control on the left, and outline/solid decisions on the right.
- The shell settles before its content. Shell motion lasts about 220–300ms; text and controls appear 40–120ms later.
- Vida's whole-screen zoom blur is a promotional edit. It must not be reproduced inside the transparent Electron overlay.

## Visual direction

The aesthetic is precise, neutral, and task-oriented: warm-white paper, near-black ink, graphite controls, one restrained green success signal, and fine gray rules. Blue remains available for grounding evidence but is not the dominant card color.

The current rainbow processing sweep is removed. Unknown progress is represented by one graphite activity dot plus a soft neutral ink wash. Known progress continues to use a determinate rail. No percentage is invented.

## Surface behavior

### Command capsule

- Height: 42 DIP; black 30 DIP action button; 1px neutral border; no shadow on the transparent overlay.
- Empty voice state remains a compact circle. Text expands only horizontally.
- Processing keeps the same geometry. The input text becomes a truthful phase label such as `正在读取…` or `正在生成…`; a single neutral wash moves slowly behind it.
- Spawn: 80ms scale settle followed by 125ms horizontal expansion. No blur and no layout-driven animation.

### Adaptive context panel

The panel is not inherently right-sided. Placement follows available space:

1. If the source application leaves enough exterior space on either side, dock into the larger fitting gutter with an 8 DIP gap from the application edge.
2. If both sides fit, keep the previous side for the current session; otherwise prefer the larger gutter.
3. If the application is fullscreen or neither exterior gutter fits, dock 8 DIP from the screen edge on the side farther from the selected/focused rectangle.
4. Clamp vertically to an 8 DIP work-area margin. Keep the chosen side stable while streamed content changes the panel height.
5. A user drag always overrides automatic placement for the remainder of the session.

The panel is 360–420 DIP wide and at most the work area minus 16 DIP. It slides 16 DIP from its chosen edge while scaling from 0.985 to 1 over 220ms. It must not cover the selection when the opposite edge is available.

### Completion/approval card

- Use `TASK FINISHED` as the machine-state eyebrow; the task itself remains the title.
- Width is content-adaptive: 360 DIP minimum, 560 DIP normal, up to 840 DIP for long deliverable drafts when screen space permits.
- Inspect results retain the follow-up composer.
- Deliver/proposal results present the final draft and an integrated decision footer. The footer contains retry on the left and `拒绝` / `同意` on the right. Existing confirmation and write-back logic remains fail-closed.
- Transition from processing to completion uses the capsule/panel edge as `transform-origin`: shell expansion 260ms, eyebrow at +40ms, body at +70ms, footer at +110ms.

### Small preview tiles

Folder/file proposal previews use a responsive grid capped at three columns. Each tile has a warm-white or light-gray surface, a hairline border, a single icon/thumbnail, a compact label, and a 34ms stagger. Nine items form a 3×3 grid; fewer items do not leave empty placeholders.

## Accessibility and safety

- Respect `prefers-reduced-motion`; all transforms become immediate and the processing state remains visible without animation.
- Animate only `transform` and `opacity` for panel/card transitions. Avoid canvas shadows and backdrop blur on transparent Windows surfaces.
- Preserve keyboard focus, drag behavior, hit regions, content protection, answer-shape policy, confirmation semantics, and source-entry compatibility.
- No new remote assets, runtime dependencies, background services, or audio cues.

## Acceptance

- Pure placement tests cover right gutter, left gutter, both-fit stability, fullscreen left/right avoidance, clamping, and oversized surfaces.
- Static tests reject the rainbow gradient and require the neutral processing indicator, adaptive placement policy, edge datasets, and reduced-motion fallback.
- Visual fixtures capture capsule input, neutral processing, dock-left, dock-right, fullscreen fallback, compact approval, wide approval, and 3×3 preview grid.
- Existing Node, Python, lint, strict typecheck, build, package-copy, source-entry, gesture, and focus verification remain green.
