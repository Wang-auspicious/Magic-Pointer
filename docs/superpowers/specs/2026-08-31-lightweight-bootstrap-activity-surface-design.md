# Lightweight Bootstrap and Activity Surface Design

## Goal

Make the GitHub installer contain only the desktop shell and bootstrap assets;
install a small managed Python core plus explicitly chosen capability packs on
first launch. At the same time, keep the pointer surface compact and visibly
alive, and make existing UIA/Clicky feedback reachable from production data.

## Non-goals

- Do not replace Electron in this phase.
- Do not create a general package manager, plugin installer, migration framework,
  or a second perception engine.
- Do not copy Everywhere's BSL implementation or shader code.
- Do not install local voice unless the user enables it.
- Do not show raw installer logs, UIA names, backend ids, timings, or model rounds
  in the primary progress surface.

## Acceptance

1. The GitHub Windows installer contains no `resources/python-runtime` tree.
2. First launch can complete from a clean Windows user profile without a system
   Python installation.
3. Install progress is driven by real stage and byte events, is cancellable, and
   resumes completed stages without repeating downloads.
4. The managed runtime is installed under user data through staging + validation
   + atomic publish; a partial download is never selected as the runtime.
5. Baseline chat, structured UIA reading, and deterministic tools work with the
   core pack. OCR/PDF and local voice fail honestly when their pack is absent.
6. Local voice remains absent until explicitly enabled.
7. The pointer work surface remains 440×300 DIP and scrolls long output internally.
8. Snapshot completion immediately scans the most relevant UIA element; location
   questions can make the existing Clicky pointer fly without marker syntax leaking
   into copied text.

## Source decisions

Hermes Agent's useful boundary is its stage protocol, not its entire installer:

- `apps/desktop/electron/bootstrap-runner.ts` obtains a dynamic manifest, invokes
  each stage independently, streams `manifest/stage/log/complete/failed` events,
  supports cancellation, and writes one completion marker only after every stage.
- `scripts/install.ps1` keeps the manifest as the single source of truth and makes
  workers idempotent. Optional Node/browser stages return `skipped` instead of
  pretending success.
- `desktop-install-overlay.tsx` renders real stage state, keeps logs collapsed until
  failure, and stops its timer when bootstrap is inactive.

Magic Pointer already has the matching foundation:

- `electron/bootstrap_runner.ts`: weighted async stages, cancellation, marker, events.
- `electron/preflight_checks.ts`: runtime/permissions/pointer/agents/model/privacy/e2e
  checks.
- `electron/renderer/onboarding.ts`: stage list, progress, retry, cancel.

Therefore the implementation extends these modules. It does not add a Hermes-like
parallel bootstrap subsystem.

## Fixed component set

Only three managed components exist in v1:

### core

Blocking. Contains relocatable CPython and packages needed by the normal Runtime:
OpenAI client, Pillow, pyperclip, and the small text-normalization dependencies
that are imported on normal startup. The exact lock is generated and verified in
CI; no package is included because it happens to be installed on the build machine.

### perception

Recommended and selected by default on first launch. Contains PyMuPDF, RapidOCR,
ONNX Runtime, OpenCV/Numpy and their required data. Structured UIA/DOM/COM remains
usable without it; pixel/PDF providers return `component_not_installed` and offer
the install action rather than returning empty evidence.

### voice

Optional and off by default. Contains sherpa-onnx, sounddevice and the SenseVoice
model. OpenAI Whisper/Torch is removed from the standard runtime. A future Whisper
pack is possible only if a real user need justifies its separate download.

## Release artifact contract

Each tagged release publishes the normal Electron installer plus component zip
assets. A small manifest ships inside the app:

```json
{
  "schemaVersion": 1,
  "version": "1.0.x",
  "platform": "win32-x64",
  "components": [
    {
      "id": "core",
      "asset": "Magic-Pointer-core-1.0.x-win-x64.zip",
      "bytes": 0,
      "sha256": "...",
      "required": true,
      "imports": ["openai", "PIL", "pyperclip"]
    }
  ]
}
```

The digest changes the next decision: invalid assets are not published or selected.
No per-file checksum tree is created.

## Bootstrap flow

```text
app starts
  -> resolve managed core under user data
  -> if absent, show onboarding before Python-dependent workers start
  -> manifest stage: inspect prior component markers and disk space
  -> core: download to <component>.partial with byte progress
  -> extract to a unique staging directory
  -> run the staged python with -I and the component import probe
  -> atomically publish staging as runtime/<version>/core
  -> perception: install or explicitly skip according to the onboarding choice
  -> agents: reuse the existing provider discovery stage
  -> model/privacy/pointer/e2e checks
  -> write the existing onboarding marker
  -> start OCR/model-health/voice only when their component and setting require it
```

Completed component markers include component id, version and manifest digest.
Retry reuses a validated completed component and resumes a `.partial` download only
when the server and local metadata agree. There is no database or migration layer.

## Runtime resolution

Production resolution order becomes:

1. validated managed runtime selected by the current component manifest;
2. bundled runtime, when present in a developer or transitional build;
3. explicitly configured Python only in non-packaged development.

An incomplete managed directory is never selected. Python-dependent background
services are gated behind `runtimeReady`; the Electron UI and downloader do not
depend on Python.

## Primary installation UI

The installer surface uses the same visual language as the pointer activity spine:

- pending: quiet hollow point;
- running: one rotating broken ring;
- succeeded/skipped: the ring settles into a check;
- a short hairline connects the current row to the next;
- byte progress may appear as a quiet number on the active row;
- raw command output stays behind one disclosure and opens automatically on failure.

The UI never displays internal descriptions such as pip command lines, wheel names,
UIA backend ids, or elapsed milliseconds on every completed row.

## Pointer surface and perception bridge

The current batch deliberately reuses existing paths:

- `element_handles` already cross the snapshot boundary. The overlay now selects
  the handle that contains the gesture point, prefers actionable roles, and scans
  only that rectangle with one perimeter light. Full-tree pink labels are removed.
- `screenPoints` and the Clicky Bezier triangle already exist. A dynamic Pointing
  prompt section is injected only for explicit location questions, so normal turns
  pay no token cost and copied answers never contain `[POINT ...]`.
- Card phases already arrive as progress events. Capsule rendering hides plumbing
  phases and facts, synthesizes one active pending row, and connects rows with a
  short activity line.

## Failure semantics

- Network unavailable: keep the shell open, show the failed component and retry;
  do not mark onboarding complete.
- Cancellation: terminate the current downloader/extractor, retain only resumable
  `.partial` data, and leave all published components untouched.
- Core validation failure: discard only the unique staging directory; the previous
  validated runtime remains selected.
- Optional pack failure: continue only after the UI clearly marks the capability as
  unavailable; do not silently downgrade busy/error into empty evidence.
- Insufficient disk: fail before download with required and available bytes.

## Minimal next-batch file map

- Modify `electron/python_runtime.ts`: managed runtime resolution and `runtimeReady`.
- Modify `electron/bootstrap_runner.ts`: allow a check to emit bounded stage byte
  progress through the existing event sink.
- Modify `electron/preflight_checks.ts`: fixed component install stages and existing
  agent/model/privacy checks.
- Create `electron/runtime_component_installer.ts`: download, staging extraction,
  import validation and atomic publish. One module, one interface.
- Add `data/runtime_components.v1.json`.
- Split the current lock into core/perception/voice input+lock files using the same
  existing runtime builder; remove Whisper/Torch from standard production assets.
- Modify `electron-builder.yml` and `.github/workflows/release.yml`: omit bundled
  runtime from the app and upload component assets.
- Modify `scripts/verify_windows_package.ps1`: verify the shell has the manifest and
  no bundled runtime; verify component archives separately.
- Reuse `electron/renderer/onboarding.ts`; only adapt row rendering and optional pack
  choice, no new onboarding application.

## Verification

- Component installer unit: cancelled download, invalid digest, invalid import,
  atomic publish, existing valid component reuse.
- Runtime resolver: clean profile, managed runtime, incomplete staging, development
  override.
- Headless first-run integration using a local HTTP fixture and tiny fake runtime
  archive; no live GitHub dependency in tests.
- Package assertion: Windows installer has no `resources/python-runtime`.
- Measure and report both GitHub installer bytes and the bytes downloaded by each
  selected component; do not collapse them into one marketing number.
