# Oreo / Vida Faithful UI Rebuild Implementation Plan

> **Execution note:** Work directly in the existing branch. Preserve the user's dirty research and status documents. Do not package, sync, or bump the application version in this batch.

**Goal:** Rebuild Magic Pointer's Studio, settings, library pages, and PointerStage surfaces to match the supplied Oreo / Vida references: one meaningful surface at a time, flat information hierarchy, compact typography, stable geometry, and no decorative card nesting.

**Source of truth:** `参考/52dbd316df08845a35aa169af5ad0dc8.png`, `参考/08b2dc005da935615c0a7c15796d7144.png`, `参考/cf03c4d470e608922884634a6c8b6131.png`, `参考/66687890da5401054b03aa7f6e09eb4b.png`, `参考/0023ea1eb99b9c6de61d364d7e8b4b2b.jpg`, `参考/配置页参考/`, and the five videos in `参考/Vida/`.

**Visual contract:** Neutral off-white canvas; near-black text; compact system sans; normal weights; 1 px dividers; no rounded outer workspace; 6–10 px control radii; 14–18 px radius only at the edge of an actual floating composer, Stage window, dialog, or document. User messages may use one shallow filled surface; assistant answers remain open text. Geometry must not grow or jump when an answer arrives.

---

### Task 1: Lock the visual and interaction contracts

**Files:**
- Modify: `tests/studio_visual_contract_test.js`
- Modify: `tests/settings_surface_contract_test.js`
- Modify: `tests/stage_fixed_surface_contract_test.js`
- Modify: `tests/stage_delivery_ready_test.js`

1. Add failing assertions that reject the old outer `workspace-card` wrappers and nested settings page icon/card treatment.
2. Add assertions for the flat Studio shell, open assistant transcript, compact fixed composer, flat settings rows, and single-surface Stage structure.
3. Add an interaction assertion that every visible settings input is schema-backed and every visible page control has a handler or native form behavior.
4. Run the four tests and confirm the new assertions fail before production edits.

### Task 2: Rebuild the Studio shell and chat surface

**Files:**
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.css`
- Modify: `electron/renderer/studio.ts`
- Test: `tests/studio_visual_contract_test.js`
- Test: `tests/studio_shell_test.ts`

1. Remove the giant rounded work-area wrappers and oversized product header treatment.
2. Build the compact sidebar and flat header shown by the supplied native-client references.
3. Render assistant answers as open document text, not boxed cards; retain one shallow user-message surface.
4. Keep the composer at a fixed height and position, with the reference's single border, restrained radius, compact context controls, and stable answer-state geometry.
5. Keep all existing chat/history/source-preview actions functional and remove any decorative control without behavior.

### Task 3: Rebuild settings around the real settings schema

**Files:**
- Modify: `electron/renderer/settings_model.ts`
- Modify: `electron/renderer/settings.ts`
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.css`
- Test: `tests/settings_ui_model_test.ts`
- Test: `tests/settings_surface_contract_test.js`
- Test: `tests/settings_save_contract_test.ts`
- Test: `tests/voice_text_settings_static_test.js`

1. Keep only settings that are loaded from and saved to the canonical Fabric settings object.
2. Organize the left navigation by actual product domains, with a search field and compact native-client density.
3. Render each section as one restrained grouping; use dividers between rows and put the real control at the right edge.
4. Preserve the hard voice-off invariant: disabling voice also selects keyboard input and unloads resident voice.
5. Show model status and the developer terminal command as read-only facts, not fake buttons.
6. Verify toggle, select, slider, text, tag, navigation, search, save, rollback, and error states.

### Task 4: Flatten stash, timeline, memory, and artifacts

**Files:**
- Modify: `electron/renderer/studio.html`
- Modify: `electron/renderer/studio.css`
- Modify: `electron/renderer/studio.ts`
- Test: `tests/studio_visual_contract_test.js`
- Test: `tests/studio_shell_test.ts`

1. Replace rounded toolbar and page wrappers with open page structure and thin separators.
2. Keep the stash canvas where it provides real spatial value, but remove decorative cluster containers and excessive node rounding.
3. Render list, timeline, memory, and artifact entries as flat rows with clear hierarchy and real click targets.
4. Keep filters, canvas navigation, zoom, preview, conversation opening, and copy actions working.

### Task 5: Rebuild PointerStage to the Vida single-surface model

**Files:**
- Modify: `electron/renderer/stage.html`
- Modify: `electron/renderer/stage.css`
- Modify: `electron/renderer/stage.ts`
- Modify if required: `electron/renderer/cards.css`
- Modify if required: `electron/renderer/card_render.ts`
- Test: `tests/stage_fixed_surface_contract_test.js`
- Test: `tests/stage_contract_test.js`
- Test: `tests/stage_delivery_ready_test.js`
- Test: `tests/stage_state_test.ts`

1. Preserve the existing state machine and IPC contracts.
2. Restyle text input and answer states as one stable Vida panel: title/action strip, open answer body, one divider, fixed bottom input row.
3. Remove nested answer cards and pills unless they encode an actual status, object, or action.
4. Use the separate task-finished document surface only for structured result/approval flows.
5. Keep approve, reject, retry, close, copy, send, structured actions, and editable draft controls functional.

### Task 6: Visual evidence and full verification

**Files:**
- Add only ignored evidence under: `.tmp/visual-verification/`

1. Build the renderer and capture the Studio chat, settings, stash, and Stage states offscreen.
2. Compare spacing, geometry, typography, radii, color, and information hierarchy against the local references; fix visible drift.
3. Run targeted tests after each page batch.
4. Run fresh full verification: Python tests, Node tests, TypeScript checks, lint, and renderer build.
5. Commit only this implementation and its plan/tests. Leave the user's existing dirty documentation and research files untouched. Do not package or sync.
