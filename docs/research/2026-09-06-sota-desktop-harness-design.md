# Desktop Office SOTA Harness Design

## Objective

Make Magic Pointer's primary product a reliable Windows desktop task harness.
The first acceptance surface is Word, Excel, PowerPoint, PDF, browser, and
WeChat/DingTalk. Figma remains a protocol adapter until a real Design Mode
installation and acceptance run exists.

The success measure is verified task completion on real installed
applications, including interruption and recovery. A protocol test, fake
preload, or mock bridge is evidence for a contract only; it is not evidence
that the desktop workflow is complete.

## Source findings

### VIDA / OpenChronicle

- Active capture is an event-driven ETL pipeline, not an always-running model.
- Debounce, deduplication, minimum capture gap, and content identity are
  separate controls. Focus changes bypass same-window deduplication.
- Sessions close from the timestamp of the last event. A reducer emits
  periodic checkpoints and a final summary, with retry backoff and a
  heuristic fallback so a failed summarizer never silently loses a session.
- Compressed memory keeps a breadcrumb to raw captures. The summary is not
  treated as the complete truth.
- MP should add this distinction to SurfaceMemory: raw evidence, normalized
  facts, and summaries must be separately addressable.

### Clicky

- The useful primitive is a stationary full-screen transparent overlay. It
  avoids window movement and makes screen coordinates stable across pointer
  animation and multi-monitor layouts.
- Universal pointing uses a coarse grid followed by a cropped fine grid, so a
  non-Claude vision model can still locate a target without pretending it has
  exact computer-use coordinates.
- Buddy, selection hooks, and gesture drawing share an input ownership state
  machine. They do not independently show and hide windows.
- MP should keep semantic UIA/DOM/COM resolution first, and use the grid
  locator only as an explicit pixel fallback with a `usedBackend` receipt.

### Pi

- The harness, not the model loop alone, owns steering, follow-up queues,
  abort state, pending session writes, and save points.
- Messages are persisted on `message_end`; extension/session mutations made
  while busy are queued and flushed at deterministic save points.
- Abort clears queued steer/follow-up messages and emits an explicit abort
  event. It is not equivalent to killing the process.
- MP should expose these semantics through its own durable session bridge,
  rather than adding another external agent client.

### Hermes

- Oversized tool results are persisted and replaced in context by a preview,
  a stable path, and an instruction for bounded rereading.
- Aggregate turn budgets are enforced after individual result caps, because
  many medium-sized results can exceed the context window together.
- Long tasks use transcript replay and explicit recovery semantics instead of
  pretending to resume a hidden program counter.
- MP already has pieces of this design; the remaining work is to ensure every
  bypass path (skipped calls, cancellation, withheld results, and recovery)
  records the same operation/effect state.

### Everywhere

- The reusable lesson is the native capture host and surface lifecycle:
  capture is a resident capability with explicit activation and cleanup, not
  a Python screenshot subprocess on every gesture.
- MP must keep full local target-surface evidence, then derive semantic and
  model views from the same frozen frame.

## MP architecture to implement

### 1. DesktopTaskRuntime

One production task entry point. It owns the durable session, event stream,
steer/follow-up queues, cancellation, recovery, and task status. The legacy
Fabric execution path may remain as an internal compatibility implementation,
but GUI and selection bridges must not create a parallel runtime with its own
policy and receipt semantics.

### 2. SurfaceMemory

An event-driven, low-power observation module. It consumes UIA/DOM/COM and
application events when available, applies content identity/debounce rules,
stores raw evidence references, and exposes summary plus raw-capture
breadcrumbs. It never turns a summary into authoritative source data.

### 3. PointerSurface

A deterministic multi-monitor overlay and input-ownership module. It owns
gesture capture, Clicky-style pointer presentation, coordinate transforms,
and the transition between selection, buddy, and task states. It submits a
FrameLease before any asynchronous semantic reads.

### 4. EvidenceBroker

Concurrent providers produce historical-frame and live-state observations.
The broker fuses them while preserving source, freshness, coverage, and
conflict information. The model receives explicit historical/live labels and
cannot use a frozen visual anchor as a live click target.

### 5. ActionBroker

All writes, sends, deletes, and external requests pass through one deep
module:

```text
policy -> approval/egress -> target lease -> prepared effect
-> physical action -> stabilization -> readback verification -> receipt/undo
```

Existing `ActionApproval`, `EgressGate`, `UndoLog`, blacklist, and budget
modules become implementation details of this seam, not optional utilities
that callers may forget to invoke.

## Delivery order

1. Unify task/runtime and action governance seams without changing existing
   tool names or user-facing affordances.
2. Move Electron bridges from request/response subprocesses to a resident
   task event stream with explicit cancellation and recovery.
3. Finish SurfaceMemory and PointerSurface, including the Chromium cold-tree
   retry and native UIA host path.
4. Migrate Office and browser adapters to the same observe/lease/act/verify
   receipt contract; then add WeChat/DingTalk as SurfaceAdapters.
5. Add real acceptance scenarios: precise Office edits, browser workflows,
   chat extraction/send, interruption, process restart, and stale-target
   rejection.
6. Only after those scenarios pass, expand secondary integrations.

## Acceptance rule

Every milestone reports the application, version, backend, latency, target
identity, operation, readback result, and failure state. A green protocol or
contract suite cannot promote an adapter to “supported” without a real
installed-application result.
