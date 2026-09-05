# Studio Claude Interaction Correction Design

## Context

The installed 1.0.33 Studio resembles the Claude Desktop reference in broad
geometry, but several highlighted controls are either static decoration or use
the wrong product contract. The correction is judged by observable behaviour,
not by source-string presence.

The local Claude Desktop bundle is the reference for labels, ordering,
descriptions, popup geometry and interaction semantics. Magic Pointer remains
its own harness: we reproduce the measured behaviour with owned code and keep
only actions that Magic Pointer can truthfully perform.

## Approved interaction contract

### Composer controls

- Permission is a compact popup anchored above its trigger, 200–360 px wide.
- The supported Magic Pointer rows appear in this order:
  `Plan`, `Accept edits`, `Bypass permissions`, `Manual`.
- `Auto` is capability-conditioned in Claude. Magic Pointer does not yet have a
  distinct automatic permission-decision engine, so it is not shown as a fake
  alias for `Accept edits`.
- The existing internal presets remain the execution truth:
  `plan`, `workspace-write`, `danger-full-access`, `read-only`.
- The destructive/full-access confirmation remains in force.
- The reasoning-effort trigger directly shows its current value. Its rows are
  exactly `Low`, `Medium`, `High`, `Extra`, `Max`, mapped to
  `low`, `medium`, `high`, `xhigh`, `max`.
- Voice is a separate microphone button. Reply-style/Caveman choices are not
  part of the composer effort control.
- Permission, model and effort popups are mutually exclusive; Escape and an
  outside click close them. Popup placement is calculated from the trigger and
  clamped to the viewport rather than relying on one shared hard-coded offset.

### Effort semantics

Effort is not a writing tone. It travels as one canonical field from renderer
to Electron to the Python Runtime and is included in the system-prompt context.
The Runtime gives every provider a deterministic semantic fallback so the
choice still changes how much analysis, verification and persistence the Agent
uses. OpenAI-compatible model requests additionally receive
`reasoning_effort`; if a gateway rejects that optional field, the existing
single compatibility retry removes only that field and keeps the semantic
prompt fallback. Messages-mode requests retain their current safe thinking
contract unless the configured provider exposes a native effort capability.

The five fallback directives are deliberately about work depth:

- Low: answer direct simple work quickly; avoid optional exploration.
- Medium: perform light analysis and the checks needed for confidence.
- High: balance depth, verification and speed for everyday work.
- Extra: investigate complex work thoroughly and verify important conclusions.
- Max: use the deepest available analysis and exhaustive relevant verification,
  while still stopping when the task is complete.

### Home statistics

- `Overview` and `Models` are real tab buttons.
- `All`, `30d` and `7d` are real range buttons.
- The bounded stats projection returns a complete aggregate for each range plus
  per-model input/output/token totals and daily model series. It never sends
  full session logs to the renderer.
- Overview shows the eight existing metrics and the activity heatmap for the
  selected range.
- Models shows daily token bars and per-model input/output totals and shares.
- Heatmap cells expose a delayed custom tooltip on hover and the same content on
  keyboard focus or click; they do not pretend to navigate anywhere.

### Account and update surfaces

- The account footer opens a compact top-aligned popup with real actions:
  Settings, Models & runtime, Check for updates, View changelog, Keyboard
  shortcuts and About.
- View changelog opens the project's real Releases page through the existing
  main-process external-navigation boundary.
- Automatic `checking`, automatic `current`, and automatic `error` states do
  not create a persistent sidebar card.
- The update card appears only for `available`, `downloading`, and `downloaded`.
  A manual failed/current check continues to use the existing one-shot native
  dialog.

## Verification contract

Source-presence tests are insufficient. The batch must include:

- pure projection tests for ranges and model usage;
- renderer contracts for exact effort and permission labels;
- end-to-end bridge tests proving effort reaches Runtime/model payloads;
- an offscreen Electron probe that uses real input coordinates to click every
  highlighted control and records popup bounds, selected state and console
  errors;
- focused tests, full Node/Python/typecheck/lint/build gates, and `git diff
  --check`.

Per the user's explicit instruction, this batch keeps package version 1.0.33
and does not run the version bump step. The final verified changes are committed.

