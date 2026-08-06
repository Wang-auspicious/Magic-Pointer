# Community-Demand Object Bridge Design

**Date:** 2026-07-26
**Status:** approved for inline implementation by the user's standing instruction to continue autonomously
**Evidence base:** `COMMUNITY_DEMAND_AND_BUILD_LOG_20260726.md`

## 1. Outcome

Turn the current PointerStage and 30-Recipe shell into an Agent-neutral object bridge whose value comes from context and trustworthy execution, not another chat surface.

The first implementation wave must make one end-to-end claim true:

> After a user wiggles, points and speaks, Magic Pointer can bind the exact source object, apply an app-specific capture boundary, assemble a compact repo/runtime-aware packet, select only relevant capabilities, hand it to an existing Agent session or task, and refuse a stale side effect.

This wave is the reusable substrate for N01–N16, N49–N60 and part of N61–N64. The 64 community needs remain the product backlog; they are not rendered as 64 buttons.

## 2. Product invariants

1. PointerStage remains the only temporary interaction surface.
2. Voice mode remains a growing capsule with no chips, model picker or Recipe menu.
3. Dashboard owns persistent defaults and policies.
4. Screenshot capture and screenshot upload are separate permissions.
5. `accepted` never means completed; `succeeded` requires relevant read-back verification.
6. A signed plan cannot be changed between preview and execution.
7. A side effect tied to a live window is refused when its target lease no longer matches.
8. Hook, session and structured CLI integrations are primary. MCP remains a compatibility gateway.
9. Capability discovery returns 3–8 bounded contracts rather than dumping all Recipe definitions into model context.
10. Unsupported external providers stay visibly unavailable.

## 3. Data flow

`Wiggle → Freeze Target → Target Lease → Capture Decision → Context Packet v2 → Capability Search → Signed Plan → Confirm → Lease Recheck → Execute → Read-back → Audit/Undo`

### 3.1 Target Lease

A Target Lease is an optimistic lock over the user-designated desktop source:

```json
{
  "schemaVersion": 1,
  "leaseId": "uuid",
  "selectionSessionId": "session-id",
  "createdAt": "ISO-8601 UTC",
  "expiresAt": "ISO-8601 UTC",
  "window": {
    "hwnd": 123,
    "processId": 456,
    "app": "code.exe",
    "title": "Magic Pointer - Visual Studio Code"
  },
  "objectIds": ["screen-1"],
  "objectFingerprint": "sha256",
  "captureFingerprint": "sha256-or-empty",
  "requiresLiveValidation": true
}
```

Fingerprint inputs are bounded and deterministic: object id/kind/bbox/content hash plus source app/window/path/url/page and capture file hash when locally readable. Raw content is not persisted inside the lease.

Before a window-bound side effect, the runtime checks expiry and finds the same `hwnd + processId`. Native writers continue their stronger selection/range hash checks. If a production action requires live validation but the probe is unavailable, execution fails closed.

### 3.2 Capture Policy

Dashboard settings add:

```json
{
  "privacy": {
    "upload_screenshots": false,
    "default_capture_mode": "follow_global",
    "app_capture_modes": {
      "1password": "deny",
      "bank": "structured_only",
      "figma": "upload_screenshot"
    }
  }
}
```

Allowed modes:

- `follow_global`: local screenshot; upload only when the existing global upload switch is enabled.
- `structured_only`: UIA/AX/DOM/text metadata only.
- `local_ocr`: local pixels and OCR, never an Agent attachment.
- `local_screenshot`: retain local pixels, never upload.
- `upload_screenshot`: upload only when the global switch is also enabled.
- `deny`: do not expose the object to the requested capability.

Sensitive-app patterns override `follow_global` to `structured_only`. An explicit `deny` always wins. Each plan exposes the resolved per-object decisions and the exact allowlisted visual attachment paths.

### 3.3 Context Packet v2

The Agent handoff packet is JSON and is also saved as a local artifact:

```json
{
  "schemaVersion": 2,
  "packetId": "uuid",
  "intent": {"command": "...", "recipeId": "agent.handoff"},
  "targetLease": {},
  "objects": [],
  "workspace": {
    "cwd": "D:/repo",
    "repoRoot": "D:/repo",
    "branch": "codex/...",
    "changedFiles": [],
    "diffStat": "..."
  },
  "runtime": {"terminalExcerpt": ""},
  "capabilities": [],
  "artifacts": [],
  "privacy": {}
}
```

The prompt contains a short human-readable summary plus the packet artifact path. Visual paths appear only when capture policy explicitly allowlists them. Text and arrays are bounded; large output remains in artifacts.

### 3.4 Capability Search

`CapabilityRegistry.search()` scores Recipe contracts using:

- explicit Recipe id;
- command phrase/keyword overlap;
- current object kinds;
- current platform;
- actual provider availability;
- risk and capture boundary.

It returns at least 3 and at most 8 descriptors when candidates exist. The selected Recipe is pinned first. The bridge exposes `capabilities.search`; MCP exposes one compatibility tool with the same contract. Full `list_recipes` remains for Dashboard and explicit inspection, not automatic prompt injection.

### 3.5 Task truth

Background task state remains durable. This wave adds:

- list/recovery of persisted tasks after UI restart;
- explicit cancellation states;
- termination verification before `cancelled`;
- retry/resume only for an interrupted or failed task and with a new attempt record;
- event log entries for start, steer, cancel request, cancel outcome and resume.

No percentage progress is synthesized from process lifetime.

## 4. Interfaces and ownership

| File | Responsibility |
|---|---|
| `app/fabric/target_lease.py` | Fingerprints, lease creation, live-window validation |
| `app/fabric/capture_policy.py` | Per-app policy resolution and visual attachment allowlist |
| `app/fabric/context_packet.py` | Bounded Packet v2, workspace probe, prompt/artifact writer |
| `app/fabric/capabilities.py` | Bounded deterministic capability search |
| `app/fabric/engine.py` | Compose the four contracts into signed plans and enforce lease before execution |
| `app/fabric/executors.py` | Deliver Packet v2 and only allowlisted attachments |
| `app/fabric/task_store.py` | Durable list/recover/cancel/resume truth |
| `scripts/fabric_bridge.py` | Public bridge operations for capability search and task control |
| `app/fabric/mcp.py` | Compatibility exposure of bounded search/task operations |
| `electron/renderer/dashboard.*` | Persistent capture defaults and per-app rule editor |

## 5. Failure behavior

| Condition | Required result |
|---|---|
| Lease expired | `status=failed`, `error=target_lease_expired` |
| Window identity changed or disappeared | `status=failed`, `error=stale_target_window` |
| Required production probe unavailable | `status=failed`, `error=target_lease_probe_unavailable` |
| Screenshot not allowlisted | Omit path and attachment; retain a counted privacy notice |
| App policy `deny` | Planning fails with `capture_policy_denied` |
| Git unavailable/not a repo | Packet keeps cwd and empty repo fields; handoff continues |
| Capability query ambiguous | Return bounded ranked alternatives; do not invent a provider |
| Termination still alive | Keep `status=cancelling`; do not report `cancelled` |
| Resume terminal-success task | Reject with `task_not_resumable` |

## 6. Verification

Automated acceptance:

1. Target fingerprints are stable under dictionary ordering and change with content/source/capture changes.
2. Live-window identity mismatch blocks signed write/send plans.
3. Sensitive apps never emit an uploadable visual path.
4. Context Packet includes repo/cwd/branch/changed files and omits disallowed screenshots.
5. Capability results contain 3–8 entries and pin the routed Recipe.
6. Agent executor persists Packet v2 and submits with `submit=false`.
7. Cancellation is not terminal until process probes confirm termination.
8. Existing Node suite and all Python tests remain green.

Real-desktop acceptance:

1. Point at a live editor/terminal issue, say “让 Codex 修这个”, and inspect the generated packet artifact.
2. Close the target window before confirming; the action must refuse execution.
3. Mark the app `structured_only`; repeat and verify no screenshot path reaches the Agent payload.
4. Open Dashboard, save capture policy rules, restart, and confirm they persist.

## 7. Explicit boundary

This design does not pretend to ship real Figma, CRM, email, cloud calendar, image-generation, chart-digitizer or macOS providers. It makes those providers safer and cheaper to add by giving them a shared target, privacy, capability, task and verification contract. Provider-specific completion remains a later evidence-backed wave.
