# Settings Truth and Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every visible setting map to a real runtime field, give voice a real master switch, and make saves acknowledged, serialized, and visibly reversible.

**Architecture:** Add a pure settings UI model/controller that owns key translation and canonical rollback. Replace the event-only save IPC with an invoke handler returning the final post-runtime settings. Keep RFC 7396 merge semantics and the existing validated store.

**Tech Stack:** Electron IPC, TypeScript, classic renderer scripts, Node assert tests, Python settings bridge.

---

## File map

- `electron/settings_store.ts`: add and validate `interaction.voice_enabled`; normalize text mode/residency when disabled.
- `electron/settings_save_policy.ts`: pure patch classification and runtime-impact calculation.
- `electron/preload.ts`: Promise-based `saveFabricSettings` bridge.
- `electron/main.ts`: invoke-based acknowledged save path with scoped runtime application and canonical response.
- `electron/renderer/settings_model.ts`: page definitions, key translations, patch builder and canonical projection.
- `electron/renderer/settings.ts`: DOM rendering, serialized save state, success hydration and failure rollback.
- `electron/renderer/studio.html`: settings status/live region.
- `electron/renderer/studio.css`: Oreo settings navigation, rows and save feedback.
- `tests/settings_ui_model_test.ts`: mapping and information-architecture tests.
- `tests/settings_save_contract_test.ts`: IPC and rollback contract.

### Task 1: Add a real voice master switch

- [ ] Add failing assertions to `tests/settings_store_test.js` proving the default is disabled and disabling voice forces `default_input_mode='text'` plus `voice_resident_enabled=false`.
- [ ] Run `node tests/settings_store_test.js`; expect the new assertions to fail.
- [ ] Add `voice_enabled: false` to defaults and normalize the dependent fields in `validate()`.
- [ ] Run the focused test and typecheck; expect pass.

### Task 2: Make save impact explicit

- [ ] Create `tests/settings_save_contract_test.ts` with cases for voice-only, shortcut-only, gesture-only and cosmetic patches.
- [ ] Run `npx tsx tests/settings_save_contract_test.ts`; expect module-not-found failure.
- [ ] Create `electron/settings_save_policy.ts` exporting `settingsSaveImpact(previous,next)` with `{ voice, hotkeys, gesture, appearance, login, update }` booleans.
- [ ] Run the focused test; expect pass.

### Task 3: Replace fire-and-forget save with acknowledged IPC

- [ ] Extend the focused test to require `ipcRenderer.invoke('dashboard:settings:save', { settings })` and `ipcMain.handle('dashboard:settings:save', ...)`.
- [ ] Run the test; expect failure on the old `send` contract.
- [ ] Change preload to return the invoke Promise. Move settings save orchestration into a shared async main-process function returning `{ ok, settings, error }`; only reconfigure subsystems selected by `settingsSaveImpact`.
- [ ] Keep `dashboard:fabric-request/settings.save` temporarily routed through the same function for compatibility, but do not use it from the settings UI.
- [ ] Run contract tests, `npm run typecheck`, and build.

### Task 4: Build the canonical settings UI model

- [ ] Create failing `tests/settings_ui_model_test.ts` asserting the eight approved pages, one-to-one retention mappings, and absence of capability/diagnostic pseudo-settings.
- [ ] Run it; expect module-not-found failure.
- [ ] Create `electron/renderer/settings_model.ts` with typed page definitions, `patchForSetting(key,value)`, `valueForSetting(key,settings)` and dependent voice normalization.
- [ ] Include all keys named in the approved design; no placeholder rows.
- [ ] Run focused tests and typecheck.

### Task 5: Rebuild settings rendering and save feedback

- [ ] Update static tests to require a settings save live region, per-row pending/error state, and no inline KEYMAP in `settings.ts`.
- [ ] Run focused tests; expect failure.
- [ ] Rewrite `settings.ts` to render from `SettingsModel`, serialize save requests, mark pending controls, hydrate from returned canonical settings, and revert on error.
- [ ] Update `studio.html` and `studio.css` with the approved settings shell.
- [ ] Run focused tests, all Node tests, typecheck and lint.

### Task 6: Commit and ledger

- [ ] Commit only the settings files and tests with `fix: make settings truthful and acknowledged`.
- [ ] Record the verified behavior in the canonical design progress ledger.

