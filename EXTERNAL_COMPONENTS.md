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
