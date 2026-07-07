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
