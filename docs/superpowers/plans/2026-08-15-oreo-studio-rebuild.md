# Oreo Studio Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Studio into one coherent Oreo workspace whose chat, timeline, stash, memory, artifacts, and settings share the same navigation and component grammar.

**Architecture:** Keep the existing Data and card-render contracts, but replace the hand-authored marketing shell with a semantic workspace shell. Centralize view metadata and eliminate decorative orb/gradient code that has no product function.

**Tech Stack:** Static HTML, TypeScript classic renderer, CSS, existing CardModel/CardRender, Node static tests.

---

## File map

- `electron/renderer/studio_shell.ts`: view metadata, navigation state and shared page-header rendering.
- `electron/renderer/studio.html`: semantic shell and page landmarks.
- `electron/renderer/studio.ts`: data rendering and interactions only.
- `electron/renderer/studio.css`: Oreo layout/tokens/responsive behavior.
- `electron/renderer/settings.ts`: mounts inside the shared shell.
- `tests/studio_shell_test.ts`: pure navigation/view metadata.
- `tests/studio_visual_contract_test.js`: static layout and anti-regression rules.
- `tests/composer_surface_test.js`: updated stable composer contract.

### Task 1: Extract a pure Studio shell model

- [ ] Write a failing test for the six real views, unique navigation ids, titles, descriptions and allowed detail-panel behavior.
- [ ] Run and observe module-not-found.
- [ ] Implement `studio_shell.ts` with `STUDIO_VIEWS`, `normalizeView()` and `shellState()`.
- [ ] Run focused test and typecheck.

### Task 2: Replace the marketing hero and duplicate navigation

- [ ] Update static tests to require one sidebar, one workspace header and one stable prompt composer; reject orb generation, hero marketing copy and duplicate top navigation.
- [ ] Run and observe failure.
- [ ] Rewrite `studio.html` landmarks and adapt `studio.ts` navigation to `StudioShell`.
- [ ] Preserve chat/stash/timeline/memory/artifact data ids used by existing renderers.
- [ ] Run focused tests.

### Task 3: Unify component grammar

- [ ] Add CSS contract assertions for paper canvas, 1px borders, 12–20px radii, black primary action, mono eyebrow, muted tags and fixed composer height.
- [ ] Run and observe failure.
- [ ] Rewrite `studio.css`; remove moving orb/marketing gradient rules and textarea content-driven outer growth.
- [ ] Reuse existing icon sprite and cards without external assets.
- [ ] Run focused tests, typecheck, lint and build.

### Task 4: Integrate the rebuilt settings pages

- [ ] Mount the eight-page settings model within the Studio workspace and require the shared header/card primitives.
- [ ] Run settings and Studio tests.
- [ ] Correct responsive behavior at 1366×768 and high DPI through CSS constraints without content-driven window resizing.
- [ ] Run the complete Node suite.

### Task 5: Full delivery

- [ ] Run full Python, Node, typecheck, lint and build verification.
- [ ] Update `package.json` to the next patch version and update `docs/STATUS.md`.
- [ ] Run `npm run sync`, verify installed `package.json` version, and record the delivery.
- [ ] Commit Studio and delivery files with `feat: rebuild Studio with the Oreo workspace system`.

