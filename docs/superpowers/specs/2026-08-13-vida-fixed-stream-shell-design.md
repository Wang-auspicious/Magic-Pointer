# Vida fixed StreamShell and separate result surfaces

> Status: approved by the user on 2026-08-13 after direct review of
> `参考/Vida/PromptRescue.mp4`.
>
> This specification supersedes the content-adaptive Stream Panel geometry and
> running-to-finished shell morph in
> `2026-08-09-vida-stage-surfaces-design.md`. It does not supersede deterministic
> targeting, write-back verification, reduced-motion, or safety requirements.

## Goal

Reproduce the physical behavior and visual hierarchy of the PromptRescue flow:

- the process panel attaches once beside the target application and does not
  move, resize, or change sides while content arrives;
- streamed output moves inside a fixed body viewport;
- Project Memory and Fresh Verification are separate body pages inside one
  persistent shell;
- the delivery receipt and proactive proposal are separate surfaces, not
  reskinned states of the process panel;
- the UI is quiet, sparse, and document-like instead of a stack of nested AI
  status cards.

The user explicitly does not require Vida's blue/green/pink generating band.
Magic Pointer keeps a neutral processing treatment.

## Evidence from PromptRescue

The 15.50-21.50 second interval was reviewed at 250 ms increments.

- Around 15.75 seconds the right-side shell enters.
- From its settled state through 20.50 seconds, the shell remains attached to
  the same edge with the same outer geometry.
- Project Memory content grows inside the shell.
- Around 17.75 seconds the body clears while the shell remains present.
- Around 18.25 seconds Fresh Verification begins in the same body viewport.
- Evidence rows stream into that viewport; overflow is handled inside the body.
- Around 20.47 seconds the Stream Panel exits.
- Around 21.22 seconds a separate horizontal `TASK FINISHED` prompt receipt
  enters. The Stream Panel does not stretch or morph into it.

The durable visual evidence is the source video. Temporary review frames live
under `.tmp/vida/prompt-timeline-20260813/` and are not product fixtures.

## Diagnosed causes in the current implementation

The current renderer violates the reference in four connected ways:

1. `renderThread()` changes `data-width-tier` from the pending `context` tier to
   `compact`, `normal`, or `wide` based on result length and kind.
2. Every render calls `placeThreadSurface()`, which measures the new content box
   and calculates another anchor. A larger width can change placement mode from
   an outside gutter to a screen-edge fallback.
3. `data-phase='finished'` applies a scale/translate animation to the whole
   shell, producing another visible size change.
4. `.stage-result` has only a maximum height. The outer shell therefore grows
   with content until the maximum is reached, then starts scrolling.

The result is the reported bouncing, enlarging, shrinking, and side movement.
Preserving only the side is insufficient; the entire outer rectangle must be
stable.

## Architecture

### 1. Immutable PanelPlacement

The first process-panel paint creates a deterministic placement record:

```ts
interface PanelPlacement {
  sessionToken: string;
  side: 'left' | 'right';
  mode: 'outside' | 'screen-edge';
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}
```

Placement is calculated from the target-window rectangle, focus rectangle, and
work-area viewport before the panel becomes visible. Width and height are based
on available space and the Stream Panel role, never on answer length.

For the remainder of the session:

- content updates reuse the same `PanelPlacement` verbatim;
- phase updates reuse it verbatim;
- no content measurement can change it;
- a user drag replaces it once with a new frozen rectangle;
- a new session computes a new placement.

If no exterior gutter fits, the shell docks to the screen edge farther from the
focus rectangle. It still receives one fixed rectangle for the session.

### 2. Fixed StreamShell

The process surface has three physical regions:

```text
StreamShell (fixed x/y/width/height)
├── StreamHeader (fixed)
├── StreamViewport (flex: 1; min-height: 0; overflow: hidden)
│   └── StreamScroller (height: 100%; overflow-y: auto)
└── ContextComposer (fixed)
```

The shell owns the rounded background, border, shadow, and placement. Header
and composer never move when body content changes. Only `StreamScroller`
scrolls.

Long text, many evidence rows, and slow streaming must not change the shell's
bounding rectangle. New rows scroll into view inside `StreamScroller`; they do
not call DOM `scrollIntoView()` in a way that can scroll an outer ancestor.

### 3. Body pages, not an accumulating transcript

The PromptRescue process uses explicit body pages:

```text
PROJECT_MEMORY
  -> REFRESHING
  -> FRESH_VERIFICATION
  -> VERIFIED
```

- `PROJECT_MEMORY` shows grouped historical context.
- `REFRESHING` fades the old body out, clears only the body, and briefly leaves
  the fixed viewport empty.
- `FRESH_VERIFICATION` installs a new page and streams evidence rows into it.
- `VERIFIED` adds the green completion row inside the current page.

The shell, placement, header controls, and bottom composer survive every body
page change.

### 4. Internal streaming motion

Streaming motion is local to the body:

- a new action row enters with opacity `0 -> 1` and `translateY(6px) -> 0`;
- its fact rows follow with a restrained stagger;
- when content exceeds the viewport, only the internal scroller advances;
- replacing a page uses a short opacity/translate transition on the body page;
- reduced-motion mode renders immediately and scrolls without animation.

No body update animates the shell's transform, width, height, left, or top.

### 5. Separate DeliveryReceipt

The final deliverable is rendered by a sibling surface, not by changing the
StreamShell's phase or width tier.

```text
StreamShell exit (fast)
  -> DeliveryReceipt enter
```

`DeliveryReceipt` selects its rectangle once from `outputKind` and available
space before first paint. Prompt write-back uses the wide horizontal receipt
seen in PromptRescue. File-plan, text-writeback, and file-artifact renderers may
use different initial rectangles, but a visible receipt never resizes in
response to streamed content.

The receipt contains only the final artifact, retry, reject, and approve. It
does not repeat project memory or evidence logs.

### 6. Separate ProactiveCard

The black proactive proposal is another sibling surface. It does not reuse the
white StreamShell or DeliveryReceipt.

It follows the reference hierarchy:

- black rounded shell;
- white title ending in a colon;
- dark inset context statement;
- equal-width pill actions;
- dark Deny and green Approve.

Runtime trigger policy remains outside the renderer. The renderer accepts an
explicit proposal payload and exposes no model-controlled geometry.

## Visual system

The Stage adopts the reference's quiet document character:

- warm translucent white surfaces with a high-opacity fallback;
- thin gray dividers and restrained shadow depth;
- near-black sans-serif titles and action rows;
- gray monospaced facts and machine-state metadata;
- green only for verified completion and proactive approval;
- black primary actions;
- generous whitespace;
- no nested cards for ordinary evidence;
- no backend badges, timer chips, orbit indicators, or dashboard-like chrome in
  the main evidence flow.

Evidence grammar is structural:

```text
✓ Action performed                 sans, near-black
  → Fact observed                  mono, gray
  → Implication or missing item    mono, gray
```

Source identity still comes from trusted capture data. Visual simplification
must not turn model-generated source names into facts.

The existing neutral processing capsule remains. The blue/green/pink sweep is
out of scope by explicit user direction.

## Data flow

```text
session starts
  -> compute and freeze PanelPlacement
  -> mount fixed StreamShell
  -> render PROJECT_MEMORY page
  -> clear only StreamViewport
  -> render FRESH_VERIFICATION page
  -> append and internally scroll evidence rows
  -> render VERIFIED completion row
  -> unmount StreamShell
  -> mount separate DeliveryReceipt
```

Generic short questions may use a compact answer surface, but they must not
reuse the PromptRescue StreamShell in a way that reintroduces content-driven
movement.

## Failure handling

- Invalid target-window geometry falls back to a frozen screen-edge placement.
- A viewport resize clamps the existing rectangle without switching sides; it
  does not recompute from content.
- Content overflow stays scrollable and must never expand the shell.
- A body-page rendering failure leaves the shell stable and shows an inline
  error in the viewport.
- A delivery failure keeps the editable receipt and reports the failed write or
  verification state without returning to a moving process card.
- Reduced-motion preserves all state distinctions without transforms.

## Testing

Implementation is test-first.

### Pure geometry tests

- pending, memory, fresh, verified, and long-content states produce the same
  `PanelPlacement` rectangle;
- both outside-gutter and screen-edge modes remain stable;
- a user drag freezes a replacement rectangle;
- a new session gets a new placement;
- viewport shrink clamps without content-based re-anchoring.

### Renderer behavior tests

- streamed rows change only `StreamScroller` content and scroll position;
- header and composer nodes remain mounted across body-page changes;
- Project Memory is removed before Fresh Verification appears;
- the shell rectangle is unchanged across every phase;
- final receipt is a different DOM surface;
- proactive proposal is a different DOM surface;
- ordinary evidence uses action/fact rows rather than nested badges and cards;
- reduced-motion removes local entrance and smooth-scroll animation.

### Static regression tests

- StreamShell does not call the old content-based `completionWidthTier()`;
- body rendering does not call outer-surface placement;
- running-to-finished does not animate the StreamShell transform;
- the neutral processing treatment remains and no rainbow requirement is
  introduced.

### Visual verification

Add deterministic scenes for:

1. Project Memory with a partially filled fixed viewport;
2. Refreshing with an empty body and unchanged shell;
3. Fresh Verification with enough rows to scroll internally;
4. Verified with the completion row;
5. the separate wide prompt receipt;
6. the separate black proactive proposal.

For scenes 1-4, automated measurement must assert an identical outer bounding
rectangle. Screenshots are layout evidence only and do not replace real
write-back or target-reacquisition verification.

## Non-goals

- Reintroducing the blue/green/pink generating band.
- Changing FrameLease, ActionLease, write-back approval, or verification
  semantics.
- Inventing a background proactive trigger runtime in the renderer.
- Replacing the user's current bottom-layer work.
- Copying promotional whole-screen zooms or camera motion from the reference
  video.
