# Pointer Action Fabric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Magic Pointer into a wiggle-first, cross-application action fabric with 30 useful Recipes, direct local Agent connectors, MCP access, settings/audit control plane, and honest capability reporting.

**Architecture:** Keep the proven selection, grounding, action-token and verification code. Add a platform-neutral `app/fabric` domain that owns Recipe contracts, intent routing, provider capability discovery, Agent task lifecycle and settings. Electron becomes a thin host: a tested wiggle detector starts a normal SelectionSession, the compact rail routes through the fabric bridge, and Dashboard edits settings rather than acting as a shopping-list demo.

**Tech Stack:** Electron/CommonJS, Python 3.12 dataclasses and subprocesses, JSON/JSONL bridges, Windows UIA/COM, macOS Accessibility host contract, MCP stdio, Node and pytest tests.

---

### Task 1: Freeze the product contract and repository boundary

**Files:**
- Create: `PRODUCT_BLUEPRINT_20260726.md`
- Create: `docs/superpowers/plans/2026-07-26-pointer-action-fabric.md`
- Modify: `EXTERNAL_COMPONENTS.md`

- [ ] Record official Google/Microsoft facts separately from community anecdotes and product inference.
- [ ] Define at least 20 concrete Recipes with input object, real output, audience and competitor alignment.
- [ ] Record the cloned Pi commit and license; mark Screenpipe and OmniParser license boundaries.
- [ ] Verify no `TBD`, fake release promise or unsupported cross-platform claim exists.

### Task 2: Build the Recipe and capability domain with TDD

**Files:**
- Create: `tests/fabric_recipe_catalog_test.py`
- Create: `tests/fabric_router_test.py`
- Create: `app/fabric/__init__.py`
- Create: `app/fabric/schema.py`
- Create: `app/fabric/catalog.py`
- Create: `app/fabric/router.py`

- [ ] Write a failing test requiring 30 unique Recipes, concrete input/output contracts, provider strategy, risk and verification mode.
- [ ] Run `python -m pytest tests/fabric_recipe_catalog_test.py -q --basetemp .pytest-red-catalog`; expect import failure.
- [ ] Implement immutable Recipe/Capability/Plan/Receipt schemas and the 30-entry catalog.
- [ ] Run the catalog test; expect pass.
- [ ] Write failing routing tests for Chinese/English short commands, entity hints, `THIS/THAT/THESE/HERE`, ambiguity and unsupported capability.
- [ ] Run `python -m pytest tests/fabric_router_test.py -q --basetemp .pytest-red-router`; expect missing router failure.
- [ ] Implement deterministic routing with explicit confidence and no model hallucination.
- [ ] Run both tests; expect pass.

### Task 3: Build settings, audit and provider discovery with TDD

**Files:**
- Create: `tests/fabric_settings_test.py`
- Create: `tests/fabric_providers_test.py`
- Create: `app/fabric/settings.py`
- Create: `app/fabric/audit.py`
- Create: `app/fabric/providers.py`

- [ ] Write failing tests for atomic UTF-8 settings, schema version, default wiggle-on, disabled-app rules, permission tiers and corruption fail-closed.
- [ ] Run the settings test and confirm the expected import failure.
- [ ] Implement local settings and append-only redacted audit events.
- [ ] Write failing provider tests for installed/uninstalled Codex, Pi, Claude, Gemini, Cursor, OpenCode, Aider and Generic profiles.
- [ ] Implement executable discovery, version probe, platform capabilities and missing-provider reasons.
- [ ] Run both tests; expect pass.

### Task 4: Build real Agent connectors and background task lifecycle with TDD

**Files:**
- Create: `tests/agent_connector_test.py`
- Create: `tests/agent_task_store_test.py`
- Create: `app/fabric/agents.py`
- Create: `app/fabric/task_store.py`
- Create: `scripts/agent_worker.py`
- Create: `scripts/agent_bridge.py`

- [ ] Write failing tests for exact safe command construction for Codex app-server/exec, Pi RPC/JSON, Claude stream-json, Gemini JSON, Cursor stream-json, OpenCode server, Aider message-file and Generic stdin.
- [ ] Assert write flags are absent unless the plan permission is `write`; never interpolate prompt text into a shell.
- [ ] Implement connector discovery and argv/stdin builders.
- [ ] Write failing task tests for start/status/steer/cancel, atomic status, bounded logs and stale PID detection.
- [ ] Implement a detached Python worker and persistent task receipts; the worker writes terminal success/failure itself.
- [ ] Run connector and task tests; expect pass.

### Task 5: Build the Recipe executor and bridge with TDD

**Files:**
- Create: `tests/fabric_engine_test.py`
- Create: `tests/fabric_bridge_test.py`
- Create: `app/fabric/engine.py`
- Create: `app/fabric/executors.py`
- Create: `scripts/fabric_bridge.py`
- Modify: `app/actions/executor.py`
- Modify: `app/actions/policy.py`
- Modify: `electron/main.js`
- Modify: `scripts/selection_bridge.py`

- [ ] Write failing tests for plan-only, preview, commit, verify and undo paths.
- [ ] Implement local deterministic executors: clipboard/text normalization, CSV/LaTeX/artifact output, maps/calendar/mail deep links, local task/note records and Agent task dispatch.
- [ ] Implement provider-backed executors for rewrite/translate/summary/vision/image/canvas actions; return `capability_unavailable` when not configured.
- [ ] Add one `fabric_recipe_execute` action type to the existing token/policy/executor boundary.
- [ ] Route selection commands through `fabric_bridge.py` before legacy lab branches.
- [ ] Verify legacy action tests stay green and new bridge tests pass.

### Task 6: Replace shortcut-first activation with tested wiggle-first activation

**Files:**
- Create: `tests/wiggle_detector_test.js`
- Create: `electron/wiggle_detector.js`
- Create: `tests/settings_store_test.js`
- Create: `electron/settings_store.js`
- Modify: `electron/main.js`
- Modify: `package.json`

- [ ] Write failing trace tests: intentional short horizontal wiggle triggers; normal travel, diagonal motion, drag, scroll, window move, drawing pattern and cooldown do not.
- [ ] Implement a 250–600 ms feature-based detector with reason/metrics output and adaptive threshold hooks.
- [ ] Make wiggle enabled by default from settings; environment variables may override for diagnostics only.
- [ ] On trigger call `beginSelectionSession('wiggle')`, not a timed observer demo.
- [ ] Retain one configurable accessibility fallback shortcut without advertising it as primary.
- [ ] Run all Node tests; expect pass.

### Task 7: Expose MCP and external-Agent integration

**Files:**
- Create: `tests/mcp_server_test.py`
- Create: `scripts/magic_pointer_mcp.py`
- Create: `integrations/codex/config.example.toml`
- Create: `integrations/claude/.mcp.example.json`
- Create: `integrations/cursor/mcp.example.json`
- Create: `integrations/pi/magic_pointer_extension.ts`

- [ ] Write failing JSONL protocol tests for initialize, tools/list and tools/call.
- [ ] Implement `current_object`, `list_recipes`, `plan_recipe`, `execute_recipe`, `agent_task_status` and `agent_task_cancel`.
- [ ] Keep execution permission-bound; MCP cannot bypass confirmation or sensitive-app rules.
- [ ] Add ready-to-copy integration manifests and a Pi extension that calls the same tool contract.
- [ ] Run the MCP protocol tests; expect pass.

### Task 8: Rebuild Dashboard as control plane and compact the rail

**Files:**
- Modify: `electron/renderer/dashboard.html`
- Modify: `electron/renderer/dashboard.css`
- Modify: `electron/renderer/dashboard.js`
- Modify: `electron/renderer/panel.html`
- Modify: `electron/renderer/panel.css`
- Modify: `electron/renderer/panel.js`
- Modify: `electron/preload.js`
- Modify: `electron/main.js`
- Create: `tests/fabric_dashboard_static_test.js`
- Create: `tests/fabric_panel_static_test.js`

- [ ] Write failing static tests for Activation, Agents, Recipes, Connections, Privacy, Activity and Diagnostics views.
- [ ] Replace shopping/calendar/route homepage with a graphite, cold-white, electric-blue settings console.
- [ ] Display real provider availability and Recipe capability, not fake charts.
- [ ] Keep the pointer rail to object label, up to three recommended actions, voice button and short input.
- [ ] Add keyboard accessibility and reduced-motion behavior.
- [ ] Run static and full Node tests; expect pass.

### Task 9: Documentation, real smoke and cross-platform boundary

**Files:**
- Rewrite: `README.md`
- Modify: `EXTERNAL_COMPONENTS.md`
- Create: `docs/USER_WORKFLOWS.md`
- Create: `native/macos/README.md`
- Create: `native/macos/MagicPointerHost.swift`
- Create: `scripts/smoke_fabric.py`

- [ ] Rewrite README as valid UTF-8 with wiggle-first startup, permissions, exact commands and no alpha-demo fiction.
- [ ] Document four real workflows: screen OCR to ticket, poster to calendar, selected UI bug to Agent, research evidence to notes.
- [ ] Implement the macOS Accessibility/ScreenCapture/CGEvent host protocol source and permission state contract; label macOS runtime verification pending until built on macOS.
- [ ] Smoke `list_recipes`, provider discovery, plan/commit of safe local Recipe, Agent dry-run, MCP tools/list and Electron launch.
- [ ] Run `npm test`.
- [ ] Run `python -m pytest -q --basetemp .pytest-final-fabric`.
- [ ] Inspect fresh logs and screenshots; record exact unverified surfaces.

### Task 10: Terra-high usefulness and boundary audit

**Files:**
- Create: `TERRA_REVIEW_20260726.md`
- Modify: files identified by the review

- [ ] Spawn exactly one `gpt-5.6-terra` reviewer at high reasoning with the full user objection, blueprint, diff, tests and real smoke evidence.
- [ ] Require severity-ranked findings for usefulness, false-success risk, safety, activation, Agent integration, cross-platform honesty and missing high-frequency workflows.
- [ ] Independently verify every finding against code.
- [ ] Fix all valid P0/P1 findings with failing tests first.
- [ ] Re-run full verification and record the final boundary honestly.

## Self-review

- Spec coverage: 30 Recipes, wiggle-first activation, Google/Microsoft alignment, Windows/macOS contracts, Agent direct integration, MCP, dashboard and audit each map to an implementation task.
- Placeholder scan: no `TBD` or feature placeholder is accepted; provider absence must be a typed runtime state.
- Type consistency: Recipe execution always travels through `OperationPlan`; Agent execution always returns an `AgentTaskReceipt`; external execution cannot bypass the existing action token and permission policy.
- Execution mode: the user explicitly requested uninterrupted inline execution and prohibited normal subagent use, so this session uses `executing-plans`; only Task 10 may spawn one Terra-high reviewer.
