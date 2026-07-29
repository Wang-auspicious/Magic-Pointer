# Magic Pointer Grounded Desktop Product Design

Date: 2026-07-29  
Status: approved by the user's continuation instructions; implementation may proceed without another direction gate

## 1. Product decision

Magic Pointer is a Windows-first, macOS-ready desktop product that lets a user point at a real on-screen object, speak or type a short instruction, and receive a verified result without leaving the current application.

The product loop is fixed:

```text
Invoke -> Point -> Freeze a real object -> Speak/Type -> Plan -> Confirm when needed
       -> Execute through a constrained adapter -> Read back -> Receipt -> Undo/Recover
```

The product is not defined by the number of recipes, Dashboard pages, models, or agents. Its value is the reliability of this loop. A feature is not available merely because code for it exists; it is available only when the current machine can execute it and verify its result.

## 2. User constraints recovered from the two complete conversation logs

The following requirements are binding:

- Build a clickable Windows desktop application, not a standalone web mockup.
- Keep `main` as the working and delivery branch; preserve existing uncommitted work and push verified milestones promptly.
- Treat the complete 64-requirement product surface and G01-G20 workflows as the scope. Do not promote N06, N20, Dashboard, or any other single item into the entire product.
- Match the interaction quality and product completeness of Hermes, Codex, Claude Code, Obsidian, Apple system settings, and Google's public Magic Pointer demonstrations, while being honest about details Google has not published.
- Prefer existing, license-compatible source and platform primitives over new one-off implementations. Hermes is MIT and may be adapted with attribution. OpenHuman is GPL and is pattern-only. OfficeCLI is Apache-2.0 and may be bundled only through a constrained adapter with notices and supply-chain controls.
- Optimize non-model latency aggressively. Cold Python process creation, unconditional Git inspection, polling storms, and repeated probes are product defects.
- Fail closed on grounding, coordinates, model readiness, target drift, permissions, execution, and readback. Never use model prose as proof that a side effect succeeded.
- The current large blue target box and the mismatch between the displayed selection and the object actually read are release-blocking defects.
- Default target feedback is a Google-demo-inspired gradient sweep band. Outline and soft glow remain user-selectable alternatives.
- Dashboard is a dense configuration, health, storage, permissions, and diagnostics center. It is not the primary work surface.
- English UI typography uses Times New Roman. Chinese UI typography uses bundled Source Han Serif SC / Noto Serif SC, with 700-900 weight for titles and important status. Paths, code, IDs, logs, and metrics remain monospaced.
- Settings must cover wake modes, custom shortcuts, voice behavior, per-application capture, permissions, agents, models, storage, audit, privacy, appearance, accessibility, diagnostics, updates, and extensions.
- Office document actions must preserve native selection identity, preview changes, verify the persisted result, and support exact recovery.
- The future extension ecosystem must be safer than Obsidian's same-process plugin model: signed manifest, declared capabilities, explicit scope, out-of-process execution, time/resource limits, crash isolation, audit, disable, and safe mode.

## 3. Evidence-based diagnosis

### 3.1 Target geometry is currently overloaded

The visual fallback captures a bounded 640 x 420 pixel image around the pointer. That crop is evidence for perception, not the user's selected object. The current snapshot places the crop rectangle into `selection_bbox` and `selection_rectangles`; the Stage then renders it as if it were the grounded target. At high DPI, the fallback rectangle also lacks an explicit physical-pixel coordinate declaration, so Electron may treat physical pixels as DIPs.

This creates both reported defects:

- an oversized blue/gradient rectangle;
- a visible target that can be displaced from the pixels or object used by the bridge.

The fix is not a CSS adjustment. The data model must distinguish capture evidence from target feedback.

### 3.2 Runtime truth is fragmented

The Dashboard issues many independent Fabric requests at startup and polls activity repeatedly. Each request can cold-start Python. Recipe execution also gathers Git workspace state even for operations that do not need it. The result is avoidable latency and a UI that can show configured capabilities rather than executable capabilities.

The product needs two deep modules:

1. `GroundingGeometry`: one interface that validates and converts pointer, target, capture, window, monitor, and Stage rectangles.
2. `RuntimeSnapshot`: one interface that returns readiness, executable capabilities, worker/model state, permissions, repairs, and the evidence timestamp.

### 3.3 Desktop lifecycle is not yet release truth

The existing NSIS, tray, single-instance, voice worker, runtime preparation, and tests are substantial. They are not a release claim until a clean Windows install proves install, launch, first action, tray exit, worker cleanup, uninstall, and reinstall with no developer Python/Node/model cache assumptions.

## 4. Architecture

### 4.1 GroundingGeometry module

External interface:

```javascript
normalizeGroundingGeometry({
  pointer,
  pointerSpace,
  targetRects,
  targetSpace,
  captureRect,
  captureSpace,
  displays,
  stageBounds,
}) -> {
  state: 'resolved' | 'pointer_only' | 'invalid',
  pointerPhysical,
  targetPhysicalRects,
  targetDipRects,
  capturePhysicalRect,
  stageTarget,
  displayId,
  evidence,
  error,
}
```

Interface invariants:

- Canonical storage is virtual-desktop physical pixels.
- Every point and rectangle declares its coordinate space.
- Capture evidence is never promoted to target geometry.
- `pointer_only` is internal evidence only and renders no target feedback. The full-display Stage stays transparent and click-through until an exact target resolves.
- A transform records source space, destination space, display ID, scale factor, and input/output rectangles.
- Invalid, cross-display, stale, or non-finite geometry fails closed.
- Stage receives only Electron DIP coordinates relative to its current display window.

Internal adapters:

- Windows UIA physical rectangles.
- Browser DOM/CDP rectangles converted to physical screen pixels.
- Office COM/UIA rectangles.
- Local visual/OCR candidate rectangles.
- Pointer-only fallback.
- macOS AX adapter later, against the same interface.

### 4.2 RuntimeSnapshot module

External interface:

```text
getRuntimeSnapshot(force = false) -> {
  schemaVersion,
  capturedAt,
  readiness,
  workers,
  models,
  permissions,
  capabilities,
  repairs,
  diagnostics,
}
```

Interface invariants:

- One bootstrap call supplies the initial Dashboard truth.
- Expensive probes are cached with explicit TTL and invalidated by settings, process, display, permission, and model changes.
- Concurrent callers share one in-flight probe.
- A generation token prevents a stale response from overwriting a new configuration.
- `configured`, `warming`, `ready`, `degraded`, `blocked`, and `unavailable` remain distinct.
- A capability appears as executable only when its adapter, dependencies, permissions, and verification path are ready.
- Repairs are typed actions, not prose-only troubleshooting.

### 4.3 FabricRuntime module

The existing Python Fabric bridge becomes a managed resident runtime behind a narrow JSONL request/response interface. The interface hides interpreter discovery, start, ready handshake, request correlation, cancellation, timeout, crash recovery, log retention, and process-tree shutdown.

Git workspace evidence is requested only by recipes that declare `needsWorkspaceEvidence`. OCR, local text actions, settings, health, and capability discovery must not run Git status/diff.

### 4.4 Dashboard information architecture

The Dashboard uses six stable top-level domains as **non-collapsing sidebar group labels** while preserving all sixteen detailed destinations as direct, always-visible rows and search/deep-link targets. The grouping must behave like the supplied Codex settings reference: headings organize the rail but never hide useful destinations behind an extra click.

1. Home & Health
2. Input & Activation
3. Actions & Applications
4. Models, Agents & Extensions
5. Data, Privacy & Permissions
6. System & Diagnostics

The sixteen detailed destinations remain: General, Activation, Voice, Shortcuts, Models, Agents, Capabilities, Apps, Actions, Connections, Storage, Activity, Privacy, Appearance, Accessibility, Diagnostics. Extensions is a direct destination within `Models, Agents & Extensions`, not a modal or a submenu.

Rules:

- Search indexes fields, descriptions, aliases, current effective value, scope, and risk tags.
- Deep links address a field, not just a page.
- Each field shows saving/validation/error state and the source of its effective value.
- Low-risk preferences may save immediately. Permissions, extension enablement, destructive reset, migration, and update application require explicit confirmation.
- Unavailable functionality is labeled with the exact missing dependency and repair action.
- The Stage remains the ephemeral work surface; Dashboard never becomes an alternative chat/workspace.

### 4.4.1 Codex-reference visual contract

The two user-provided Codex screenshots define the Dashboard shell and settings-page reference:

- A persistent Windows title/menu strip sits above the app content. The application sidebar begins below it and is visually distinct from the content canvas.
- The left rail is approximately 17-18% of a wide window, has a fixed search field near the top, compact monochrome 16-18 px navigation icons, direct destinations, and muted group headings.
- The selected destination uses one restrained full-row rounded highlight. Unselected destinations have no individual card surface.
- Main content is a centered, bounded column with generous outer whitespace; it does not stretch cards edge-to-edge across an ultrawide window.
- Page title and optional one-line subtitle precede content. Section labels sit outside their row group.
- Ordinary settings use dense horizontal rows: left-aligned label plus restrained description, right-aligned switch/select/segmented value, subtle separators, and one shared rounded group surface. Avoid nested cards.
- Dark mode uses near-black content, a slightly lighter rail, low-contrast hairlines, and solid readable controls. Mica/translucency belongs to window/navigation chrome only; configuration rows remain solid.
- The Extensions page uses second-level tabs in one row: `Extensions / Applications / MCP / Skills`, followed by a right-aligned search field. Each installed item is one list row with identity icon, name, description, readiness/permission metadata, and a right-aligned enable control.
- Core navigation icons use one monochrome SVG family. Provider/application/extension identity may use restrained branded icons. Emoji are forbidden.
- Pointer-down feedback is immediate; page transitions and switch motion are short, interruptible, and critically damped. Reduced-motion mode uses opacity/state changes without sweep or spring travel.

Magic Pointer adds truth that Codex's visual example does not need to show: each extension/capability row may expose `ready / needs setup / needs agent / experimental / blocked / unavailable`, requested capability scope, last probe time, and a typed repair action. This information must fit the row hierarchy instead of creating a card grid.

### 4.5 OfficeCLI adapter

OfficeCLI is a true external dependency behind a typed adapter. The adapter accepts only typed read or change requests and returns a normalized receipt. It never accepts a model-generated command string.

Execution stages:

```text
DISCOVER -> SNAPSHOT -> RESOLVE -> PLAN -> EXECUTE -> VERIFY -> COMMIT -> RECOVER
```

The bundled binary is version/hash/signature pinned, self-update is disabled, user PATH is ignored, arbitrary plugin discovery is disabled, and every write runs against a working copy with a preimage. Live Word/Excel/PowerPoint selection continues to come from COM/UIA.

### 4.6 Extension host

The extension seam is introduced only after two first-party adapters use it, initially OfficeCLI plus a second non-Office connector. The host supports three extension kinds:

- declarative Recipe/Skill package;
- out-of-process connector;
- declarative UI card.

No extension may import code into Electron main or inject arbitrary Dashboard DOM. Manifest capabilities are deny-by-default, scope-bound, expiring, auditable, and revocable. A crashing extension cannot crash the app or block pointer input.

## 5. User-visible state model

### 5.1 Targeting

```text
idle -> invoking -> targeting -> frozen -> input -> processing
     -> result | needs_confirmation | failed -> dismissing -> idle
```

- `targeting`: invisible while grounding is unresolved; no pointer box, dot, or guessed band.
- `frozen`: exact grounded object rectangle(s), or no target feedback when only pointer/capture evidence exists.
- `input`: same object remains visually stable while voice/text input opens.
- `processing`: target remains stable; progress reflects real events only.
- `result`: success language requires a verified receipt.

### 5.2 Capability truth

```text
ready            executable now and verification available
needs_setup      local repair or model install is available
needs_agent      requires a connected external Agent
experimental     enabled only through an explicit experimental setting
blocked          permission, policy, platform, or packaging prevents use
unavailable      no implementation for this machine
```

Ambiguous commands return abstention rather than an alphabetical/default recipe guess.

### 5.3 Runtime health

```text
unloaded -> probing -> warming -> ready
                       |          |
                       v          v
                    degraded <- restarting
                       |
                       v
                     blocked
```

Every transition has timestamp, evidence, retry policy, and a user-facing repair action. A spawned process is not ready until it emits the protocol-level ready event.

## 6. Reuse decisions

Use or adapt:

- Electron for Stage, Dashboard, tray, single instance, IPC isolation, and packaging.
- Windows UIA and existing C# probe for structured desktop grounding.
- CDP/DOM and the existing browser adapter for web grounding.
- Hermes MIT patterns for ready handshake, backend probes, process-tree shutdown, settings migration, deep links, plugin lifecycle, receipts, and diagnostics.
- OfficeCLI Apache-2.0 as a constrained Office transformation engine after binary trust controls exist.
- UI-TARS/OmniParser/OS-Atlas only as feature-flagged visual grounding candidates or offline evaluation sources after license review.
- OSWorld/WinAppDriver concepts only for isolated regression infrastructure.

Do not use:

- OpenHuman GPL code or tests in the product.
- arbitrary OfficeCLI MCP command forwarding;
- OfficeCLI automatic updates or automatic plugin discovery;
- unrestricted computer-use agents as the trusted execution layer;
- capture crop rectangles as UI target rectangles;
- renderer-owned permission or success decisions.

## 7. Delivery sequence

1. Correct target/capture geometry and prove mixed-DPI visual alignment.
2. Establish one runtime/capability health snapshot and eliminate Dashboard process storms.
3. Make worker lifecycle and model readiness honest, recoverable, and cleanly stoppable.
4. Reorganize Dashboard into six domains while retaining all detailed settings and adding field search/deep links.
5. Complete the Windows package and clean-machine first-success gate.
6. Add OfficeCLI read-only adapter, then limited verified write recipes.
7. Extract an extension seam only after two first-party adapters demonstrate it.
8. Add macOS AX adapter and run real macOS evidence; until then macOS remains explicitly blocked.

## 8. No-ship gates

Do not ship if any of the following is true:

- Stage displays the capture crop as the selected object.
- Displayed target and adapter-read object disagree in the mixed-DPI matrix.
- A target rectangle lacks a coordinate-space declaration.
- A stale target, changed display topology, changed foreground window, or expired lease can still execute.
- Dashboard says ready when the model, worker, permission, adapter, or verification path is absent.
- Dashboard bootstrap creates independent Python processes per card/section.
- A local non-workspace recipe performs Git status/diff.
- Ambiguous input silently selects a recipe.
- Model or Agent acceptance is displayed as completed execution.
- The packaged app needs a developer Python, Node installation, or pre-existing model cache without saying so.
- Exit/uninstall leaves managed workers running.
- Source Han Serif/Noto Serif is referenced but not bundled with its license.
- OfficeCLI is resolved from PATH, self-updates, discovers arbitrary plugins, modifies an active original file directly, or lacks a preimage/verified receipt.
- Third-party code runs in Electron main/renderer with inherited application authority.
- Windows evidence is represented as macOS completion.

## 9. Success metrics

- Time to first verified local action on a clean supported Windows machine: <= 3 minutes.
- Non-model invocation-to-frozen-target P50 <= 120 ms, P95 <= 250 ms on the reference machine.
- Warm runtime request overhead excluding model inference P50 <= 80 ms, P95 <= 180 ms.
- Displayed-target versus evidence-target edge error: <= 2 DIP for structured sources at 100/125/150/200% DPI.
- False success rate in the golden workflows: 0.
- Managed child processes remaining 5 seconds after app exit/uninstall: 0.
- Capability cards without executable/readback evidence: 0.
- Dashboard bootstrap Fabric child-process count: <= 1.

## 10. Verification strategy

Automated tests cover module interfaces, not implementation strings alone. Static contract tests remain supplemental. Real evidence must include:

- browser selection at 100/125/150/200% scale;
- mixed-DPI dual monitor including negative virtual coordinates;
- UIA text range, Office selection, DOM selection, pointer-only visual fallback;
- display topology change, target drift, foreground-window change, lease expiry;
- worker cold start, crash, restart backoff, settings generation change, app exit;
- Dashboard boot request count and Python child-process count;
- clean NSIS install/launch/first action/tray exit/uninstall/reinstall;
- Office working-copy write, validation, readback, preimage restore, lock conflict;
- extension timeout, crash, over-permission request, disable, removal, and safe mode.
