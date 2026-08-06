# External Component Candidates

Date: 2026-07-07

Purpose: mature open-source projects to reuse or study for Magic Pointer after switching the visual layer from Tk to Electron.

## Cloned successfully

### 1. OmniParser

- Local: `external/omniparser`
- Repo: https://github.com/microsoft/OmniParser
- Use: screen parsing / UI element detection / object grounding.
- Why relevant: turns UI screenshots into structured screen elements for GUI agents.
- Integration priority: high for THIS/THAT/object detection.

### 2. nut.js

- Local: `external/nut.js`
- Repo: https://github.com/nut-tree/nut.js
- Use: cross-platform mouse/keyboard automation and image matching from Node/Electron.
- Why relevant: Electron overlay can call this for click/type/move actions.
- Integration priority: high for action execution.

### 3. whisper.cpp

- Local: `external/whisper.cpp`
- Repo: https://github.com/ggml-org/whisper.cpp
- Use: local/offline speech-to-text.
- Why relevant: replaces Windows Win+H dictation so Magic Pointer can own the voice UI.
- Integration priority: high for built-in speech.

## Located but git clone timed out / incomplete locally

These are large monorepos or large source trees. The current directories are incomplete because git checkout was interrupted. Prefer manual Download ZIP if we need the code now.

### 4. UI-TARS Desktop

- Partial local dir: `external/ui-tars-desktop` (do not rely on it yet)
- Repo: https://github.com/bytedance/UI-TARS-desktop
- ZIP: https://github.com/bytedance/UI-TARS-desktop/archive/refs/heads/main.zip
- Use: complete multimodal desktop GUI agent stack.
- Why relevant: architecture reference for local/remote computer operators, agent UI, GUI action loop.
- Integration priority: medium-high as architecture reference; too large to directly embed.

### 5. Microsoft UFO

- Partial local dir: `external/ufo` (do not rely on it yet)
- Repo: https://github.com/microsoft/UFO
- ZIP: https://github.com/microsoft/UFO/archive/refs/heads/main.zip
- Use: Windows GUI/API hybrid desktop automation agent.
- Why relevant: good reference for UIA + vision + API actions, but Windows-specific.
- Integration priority: medium; useful for Windows backend design.

### 6. screenpipe

- Partial local dir: `external/screenpipe` (do not rely on it yet)
- Repo: https://github.com/screenpipe/screenpipe
- ZIP: https://github.com/screenpipe/screenpipe/archive/refs/heads/main.zip
- Use: local screen/audio capture, search, activity memory, privacy controls.
- Why relevant: session/history/context design; can inspire local-first memory layer.
- Integration priority: medium; maybe too heavy to embed directly.

## Recommended next integration order

1. Keep Electron overlay as the main UI layer.
2. Use `nut.js` first for cross-platform action execution from Electron.
3. Add `whisper.cpp` or a simpler temporary cloud STT path for built-in voice.
4. Use OmniParser for object grounding after basic overlay + speech feels right.
5. Study UI-TARS/UFO/screenpipe architecture, but do not vendor them directly unless a narrow component is identified.

## Manual ZIP instruction

If git clone is slow, download the ZIP from the links above and extract to:

```text
external_zip/ui-tars-desktop
external_zip/ufo
external_zip/screenpipe
```

Do not overwrite the partial `external/*` folders until we decide whether to remove or replace them.


## Language / stack audit after ZIP extraction

### OmniParser

- Local: `external/omniparser`
- Main language: Python.
- Role: screenshot -> structured UI elements / icon boxes / interactable regions.
- Direct-use risk: requires model weights and a separate Python environment; not lightweight enough for immediate default install.
- Practical path: add an optional `omniparser` backend later, not part of the first launch flow.

### nut.js

- Local: `external/nut.js`
- Main language: TypeScript / Node native providers.
- Role: cross-platform mouse/keyboard/image automation from Electron/Node.
- Practical path: use as the Electron action-execution layer after the overlay/AI bridge is stable.

### whisper.cpp

- Local: `external/whisper.cpp`
- Main language: C/C++.
- Role: local/offline STT.
- Practical path: either build `whisper-cli` and call it from Electron/Python, or use its npm/package bindings later. This is the right replacement for Windows Win+H.

### UI-TARS Desktop

- Local ZIP: `external_zip/UI-TARS-desktop-main`
- Main language: TypeScript monorepo, Electron-style desktop agent architecture.
- Role: architecture reference for GUI-agent event loop, model/runtime adapters, visualizer, and desktop app organization.
- Practical path: study architecture, do not vendor directly.

### screenpipe

- Local ZIP: `external_zip/screenpipe-main`
- Main language: Rust + TypeScript.
- Role: local screen/audio capture, memory, API/server, desktop app.
- Practical path: architecture reference for session/history/local memory. Too heavy to embed now.

### Microsoft UFO

- Clone was incomplete; ZIP not available locally.
- Main expected stack: Python-centric Windows GUI automation / agent framework.
- Role: Windows-specific architecture reference for UI Automation + vision + action execution.
- Practical path: skip until downloaded; our cross-platform route should not depend on UFO.

## Integration actually started

Implemented bridge:

```text
Electron overlay gesture/action
  -> electron/main.js ipcMain overlay:done
  -> spawn Python scripts/electron_bridge.py
  -> Python captures bbox, registers PointerObject, updates TaskContext, calls existing vision model
  -> JSON result sent back to Electron renderer
  -> Electron shows a local result card near the pointer
```

New file:

```text
scripts/electron_bridge.py
```

Updated files:

```text
electron/main.js
electron/preload.js
electron/renderer/index.html
electron/renderer/overlay.js
electron/renderer/styles.css
```

This is the first real stitching point. It keeps Electron responsible for feel/visuals and Python responsible for AI/backend state.

## 2026-07-26 integration and license update

### Hermes Desktop design contract and Tabler icons

- Local reference: `D:\AI_Agents\HermesAgent\apps\desktop`
- Upstream: https://github.com/NousResearch/hermes-agent
- Hermes license: MIT, Copyright (c) 2025 Nous Research.
- Reused design contracts: hidden native title bar, flat list rows, master-detail settings layout,
  tokens over literals, immediate direct-manipulation feedback, and one-layer Escape cancellation.
- No Hermes React component or business logic is copied into Magic Pointer.
- Icon source: Tabler Icons outline SVG paths from Hermes' pinned `@tabler/icons` dependency.
- Tabler upstream: https://github.com/tabler/tabler-icons
- Tabler license: MIT.
- Magic Pointer integration: the curated inline symbol sprite in
  `electron/renderer/dashboard.html`.

The icons keep the same outline vocabulary as Hermes while the desktop shell, information architecture,
copy, state handling, and Electron/DOM implementation remain Magic Pointer-owned.

### Pi coding agent

- Local: `external/pi`
- Upstream: https://github.com/badlogic/pi-mono
- Pinned checkout: `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`
- Root license: MIT.
- Directly used contracts: JSON print mode, JSONL RPC mode, extension API and CLI tool allowlist.
- Magic Pointer integration: `app/fabric/agents.py`,
  `integrations/pi/magic_pointer_extension.ts`, and background task worker.

Pi is the default open-source Agent fallback, not the pointer grounder. The object/permission/receipt
contract remains Magic Pointer-owned so Codex, Claude, Gemini and other Agents can be substituted.

### RapidOCR

- Local: `external/rapidocr`
- Upstream: https://github.com/RapidAI/RapidOCR
- Pinned checkout: `095232a4c94f7f0e6600ba5bba1177010ad696d4`
- License: Apache-2.0; upstream notes that OCR model copyright remains with Baidu.
- Installed runtime: `rapidocr==3.8.1` with ONNX Runtime.
- Role: bounded pointer screenshot -> local ordered OCR text; Tesseract remains the offline fallback.
- Verified locally on 2026-07-26 against a real 640×420 Magic Pointer screen-region capture.

RapidOCR is the default OCR provider because its ONNX deployment is materially easier to ship across
ordinary Windows/macOS CPUs than a full PaddlePaddle environment. PaddleOCR/PP-OCRv5 remains the
optional high-accuracy document backend.

### OpenAI Whisper

- Local: `external/openai-whisper`
- Upstream: https://github.com/openai/whisper
- Pinned checkout: `04f449b8a437f1bbd3dba5c9f826aca972e7709a`
- License: MIT.
- Installed runtime: `openai-whisper==20250625` and `sounddevice==0.5.5`.
- Role: local microphone capture, VAD-driven partial transcription and final command emission without
  invoking the Windows `Win+H` dictation surface.
- Magic Pointer integration: `scripts/local_voice_bridge.py`, Electron `dictation:start` IPC, and the
  progressively growing single command capsule.
- Verified locally on 2026-07-26 with an offline synthesized WAV; the final transcript was exactly
  `Book this table here tomorrow.`

The bridge never downloads a model silently. It only uses a model already present in the user's
Whisper cache and emits a visible local error otherwise. The old system-dictation script remains a
manual compatibility artifact, not the default path.

### OpenCC

- Upstream: https://github.com/BYVoid/OpenCC
- Runtime dependency: `opencc>=1.4.1,<2.0.0`.
- License: Apache-2.0.
- Role: local phrase-aware simplified/traditional Chinese conversion for fixed voice-output preferences.
- Magic Pointer integration: `app/voice/text_normalization.py`; `t2s.json` and `s2t.json` are selected
  explicitly. If the packaged dependency is missing, the UI/runtime reports limited coverage and uses
  only the small audited fallback map rather than claiming complete conversion.

### License boundaries

- Do not describe every folder under `external/` as freely vendorable.
- `external/omniparser` has separate code/model and CC attribution obligations; confirm the exact
  artifact license before distributing weights or copied assets.
- The locally inspected `screenpipe` source/ZIP is an architecture reference; its current root
  licensing is not treated as a blanket permission to vendor the product.
- nut.js and whisper.cpp may be integrated only after recording the exact revision and license
  notices in the release manifest. OpenAI Whisper is the current verified speech implementation;
  whisper.cpp remains a possible packaged-runtime replacement.
- UI-TARS and Microsoft UFO remain architecture references unless an explicit vendoring review is
  completed.

### Current architecture

```text
native pointer host
  -> WiggleDetector
  -> frozen GroundedObject / InteractionEpisode
  -> RecipeRouter + signed OperationPlan
  -> native connector | deterministic artifact | Agent fallback
  -> verified ExecutionReceipt + optional undo

external Agent
  -> Pi/Claude/Gemini hook | native session protocol | MCP fallback
  -> current object + Recipe plan
  -> same permission and signed execution path
```
