# Magic Pointer Harness Reconstruction Design

**Date:** 2026-08-14

**Status:** Corrected backend reconstruction contract; implementation in progress

**Primary product source of truth:** `docs/design/MAGIC_POINTER_HARNESS_20260811.md`

## 1. Outcome

Magic Pointer remains a short-task desktop interaction compiler: the user points at a real surface, gives a short instruction, and receives an editable, verifiable result. The foreground must stay simple while the background agent reaches the reliability and breadth of the strongest local harness references.

The finished system must have five properties:

1. **Evidence is truthful.** Pixels, accessibility structure, DOM, COM, OCR, and target identity cannot be described as one surface unless their binding is validated. Contradictions fail closed and remain visible in the run ledger.
2. **The agent behaves like a normal agent.** Simple work usually settles in two or three model calls because the model reaches an answer, not because a recipe expires. Provider failure, malformed output, and repeated tool calls have their own bounded recovery paths; a small global turn counter is not a substitute for them.
3. **The runtime is replayable.** Model-visible history is derived from an append-only recorded event stream. Compaction changes the model surface, not the historical record.
4. **Extensions are real seams.** Surface adapters, tools, model providers, hooks, context engines, external agents, and renderers have distinct contracts, lifetimes, trust rules, and unload behavior. A wrapper around one implementation is not called a plugin seam.
5. **Learning is useful, visible, and reversible.** A restricted background reviewer can improve agent-managed skills from real trajectories and user corrections without gaining action authority. Every change has provenance and rollback.

## 2. Constraints

- Pointer completion freezes historical pixels before any Magic Pointer UI, UIA/DOM/COM/OCR read, or model call can alter the observed scene.
- Full local target-surface evidence is retained. A gesture crop is an index into that surface, not the only visual evidence.
- Perception is concurrent evidence fusion, not serial first-nonempty fallback.
- Deterministic state, coordinates, permissions, action leases, execution, and verification stay outside the model.
- The resident process is idle/event-driven. Expensive reads start only after an explicit gesture, wake, or task.
- The foreground product stays suitable for a few-turn, few-minute daily task. Project-scale coding continues in Claude Code, Codex, Pi, Kimi, Hermes, or another external agent through an explicit handoff.
- Existing dirty work belongs to the user or earlier agents. Reconstruction replaces modules only behind contract tests and does not reset the worktree.
- Intermediate milestones do not bump the app version or replace the installed application. Delivery happens once after the backend is accepted as a whole.

## 3. Reference Reuse Ledger

### 3.1 Hermes Agent — MIT, primary product benchmark

Hermes is the first comparison for backend breadth, operational comfort, and self-evolution. Reuse or port its contracts rather than making a thinner Magic Pointer-specific substitute:

- a natural tool loop with a large emergency limit, while retry classes and repeated-tool loops have their own guardrails;
- plugin discovery by source and kind, lazy loading, trust-aware override rules, hook isolation, and sanitized observer payloads;
- READY handshake, health probes, Windows process-tree termination, retries, dead-target caching, and durable execution receipts;
- hard suspension versus soft resume-pending session states;
- background review of recent trajectories with a restricted memory/skill tool set, protected skill sources, visible changes, and rollback-capable learned skills.

Hermes's monolithic files are not a target module shape. Their externally useful behavior and failure semantics are.

### 3.2 DeepSeek Harness — MIT, plugin/session/scheduler reference

Reuse directly where the language and surrounding contracts permit; otherwise port faithfully with attribution in the repository notes:

- append-only session events and the invariant that model-visible input is derivable from recorded state;
- surface replacement for compaction while retaining historical provenance;
- bounded rolling tool pool, exclusive barriers, model-order result commit, and synthetic results for calls skipped by abort;
- steer/follow-up/inject wake semantics;
- scoped registration in which visibility and lifetime have the same owner, exact idempotent disposers, ancestor overlays, and quiescent teardown;
- the agent loop as a replaceable runtime contribution rather than an irreplaceable application singleton;
- fail-closed process and sandbox behavior.

Do not transplant the whole Cordis graph. Magic Pointer inherits the scoped registry and reversible-lifecycle mechanisms, not DSH's developer-preview complexity or its programmer-facing configuration product.

### 3.3 Kimi Code — MIT

Use Kimi's separation of responsibilities:

- a stateless turn runner;
- a single-provider step separated from tool-call batch execution;
- recorded events separated from live-only UI events;
- the host owns sessions, permissions, compaction policy, protocol bridges, and UI;
- every dispatched tool call is paired with a recorded result unless interruption occurred before dispatch.

### 3.4 Pi — MIT

Reuse Pi's small, deep interfaces:

- the main agent loop runs naturally until a final answer, error/abort, tool termination, steering, or follow-up condition; it has no small global turn limit;
- provider request retries live below the agent loop and use retryability, bounded attempts, interruptible backoff, and `Retry-After`;
- append-tree session navigation and context derivation;
- repository/store separation;
- compact steering and follow-up queues.

Pi is the complexity check: if a Magic Pointer interface cannot be explained as simply as Pi's equivalent, the design must justify why.

### 3.5 Claude Code — clean-room behavioral reference

Claude Code's local snapshot has no usable open-source license. Magic Pointer may reproduce observable behavior, state machines, module responsibilities, tool-use semantics, hook semantics, permission UX, recovery behavior, and interoperability. It must not reproduce proprietary source text or perform a line-for-line translation. This boundary does not require a conservative product: behavior can be matched aggressively through independently written implementations and contract tests.

## 4. Target Architecture

```text
Gesture / Wake
    -> CaptureCore commits FrameLease
    -> EvidenceBinding validates immutable surface + target identity
    -> PerceptionBroker concurrently gathers structured and pixel evidence
    -> ContextCompiler emits a sealed ContextPacket
    -> RunHost appends run.started and invokes StatelessTurnEngine
    -> TurnEngine derives ModelSurface from RunJournal
    -> ToolScheduler dispatches through CapabilityBroker + ActionBroker
    -> verified tool results are appended in model order
    -> DraftArtifact / answer / proposal is emitted as recorded output
    -> RunObserver records outcome for diagnostics and learning
```

### 4.1 EvidenceBinding

`EvidenceBinding` is the deep boundary between capture and perception. Its public result is either a validated immutable binding or a structured rejection. It owns:

- FrameLease schema, artifact existence, size, hash, timestamp, coordinate space, and gesture containment;
- binding between lease target identity and the source window used by structured reads;
- capture kind (`display`, `window`, or explicit fallback) so a display image is never described as a window image;
- pre/post structured-read identity attestation;
- contradiction detection between independently collected evidence;
- fail-closed reason codes and timing records.

It does not perform OCR, UIA, DOM, or model reasoning.

### 4.2 PerceptionBroker

The broker starts permitted evidence providers concurrently and waits within explicit per-provider budgets. Results retain source, method, timing, confidence, gesture coverage, and errors. Fusion prefers evidence that covers the mark and agrees with the immutable target binding. Empty UIA container text cannot suppress pixel evidence.

### 4.3 RunJournal and ModelSurface

Each run has an append-only journal. Recorded events include:

- run/session lifecycle;
- user instructions and steering;
- immutable context-packet references;
- model request headers and model output;
- tool call prepared/dispatched/result/skipped events;
- permission requests and decisions;
- compaction surface replacements;
- draft/artifact versions and user edits;
- cancellation, suspension, failure, and completion.

Live-only events such as token animation, hover state, or transient progress text are never used to reconstruct model history. Before every model call, the runtime derives the exact request from the recorded journal and asserts that the dispatched request matches that derivation.

### 4.4 StatelessTurnEngine

One invocation consumes a `ModelSurface`, available tool descriptors, the current task policy, and queued steering. It produces recorded model events and either:

- a final response/draft;
- a tool-call batch;
- a permission or user-input suspension;
- a structured provider failure;
- a compaction request.

It does not own persistent session state, UI, plugin discovery, or process lifetime.

### 4.5 Normal agent loop and targeted recovery

The current `LoopParams.max_turns = 6` and recipe limits of 3/4 are removed from normal execution. The default loop is deliberately ordinary:

```text
request model
  final answer             -> complete
  tool calls               -> execute, record results, request model again
  needs permission/input   -> suspend
  cancelled                -> cancel
  provider failure         -> provider recovery policy, then fail visibly
```

The provider adapter owns retryability, bounded attempts, `Retry-After`, backoff, credential refresh, and provider fallback. A provider failure is never appended as a fake user instruction and sent through another agent iteration. Non-retryable failures fail immediately; exhausted transient recovery terminates as `provider_unavailable` with the original cause.

Output-limit recovery is separate from provider retry. Incomplete tool arguments never execute. The runtime may compact or request one recorded continuation, then returns an honest partial/resource failure if recovery is exhausted.

Tool-loop protection is separate again. The runtime fingerprints tool name plus canonical arguments and the resulting observation. It warns the model when an identical failed call or idempotent no-change result repeats; continued repetition is blocked and terminates as `stalled` unless the model changes strategy. Mutating tools are never automatically replayed merely because a response was lost.

Wall time, context/token capacity, cost, cancellation, and action limits remain resource safeguards. A generous configurable emergency fuse may exist to catch a broken invariant, but it is not recipe logic, is not set to a normal task length, and terminates as `invariant_failed`, never `completed` or `max_turns`.

The terminal reasons are `completed`, `needs_user`, `permission_required`, `suspended`, `cancelled`, `resource_exhausted`, `stalled`, `provider_unavailable`, and `invariant_failed`. The UI must never translate one of these into a fake completed answer.

### 4.6 ToolScheduler

The scheduler follows DSH's stronger semantics:

- bounded rolling pool rather than submitting every parallel-safe call at once;
- resource/conflict keys plus exclusive barriers;
- preparation and durable dispatch before execution;
- physical concurrency with model-order result commit;
- calls that never started after abort receive a synthetic skipped result so replay remains structurally valid;
- every started call is drained or explicitly marked interrupted;
- action tools execute only through ActionLease revalidation and result verification.

### 4.7 Typed extension contracts

There is no universal eight-row plugin tree. Extension kinds have different contracts:

- `SurfaceAdapter`: claim/read/act capabilities for one surface family;
- `ToolProvider`: descriptors, executors, effects, and resource keys;
- `ModelProvider`: streaming generation, health, cancellation, retry classification, and usage;
- `ContextEngine`: model-surface derivation and compaction policy;
- `AgentRuntimeProvider`: the natural turn loop implementation;
- `RunHook`: isolated lifecycle observation with sanitized payloads;
- `ExternalAgentProvider`: READY/health/dispatch/status/cancel/resume;
- `RendererSlotProvider`: sandboxed MCP/application UI.

Built-in trusted extensions and third-party extensions have different override rules. Expensive extensions load lazily. Every registration returns a disposer; unloading restores the previous registry state. A seam is real only after two implementations or one implementation plus an explicit external compatibility contract.

#### 4.7.1 DSH plugin inheritance decision

| Decision | Mechanism | Magic Pointer rule |
|---|---|---|
| Inherit | registration scope owns visibility and lifetime | A process host owns built-ins; each session/run/agent receives a child scope. A registration made through a scope is visible through that scope and is removed by that same scope's disposer. |
| Inherit | exact, idempotent, quiescent disposal | Unload stops new work, cancels owned work, waits for settlement, then removes registrations in reverse order. Concurrent disposal shares one completion. |
| Inherit | global layer plus ancestor-to-child overlays | Built-ins are global; user/project/run contributions may shadow only where trust and extension-kind rules allow. Reads do not create layers. |
| Inherit | dependency-declared activation and layered configuration | Required services gate activation. Defaults, user config, project config, and explicit run overrides have deterministic precedence and an inspectable resolved view. |
| Inherit | replaceable agent-loop provider | The normal built-in turn engine is registered behind `AgentRuntimeProvider`; tests and external runtimes may replace it within an allowed scope. |
| Combine with Hermes | source/kind/trust discovery | Sources are bundled, user, project, and installed entry points. Kinds have separate contracts; bundled code is trusted, user/project code is opt-in, expensive platform integrations are lazy. |
| Combine with Hermes | hook isolation and diagnostics | A broken observer/hook is recorded and isolated. Inventory reports source, trust, state, dependencies, resolved config, errors, and owning scope without exposing sensitive payloads. |
| Do not inherit | whole Cordis product/configuration surface | No profile/bundle/include expression language, web plugin debugger, or universal service graph is exposed to normal users. |
| Do not inherit | pluginizing every helper | Pure functions and internal implementation details remain ordinary modules. Only replaceable capabilities and lifecycle-bearing components are extensions. |
| Do not inherit | scope as authority | Scope routes visibility and teardown only. Permissions, ActionLease, filesystem/network policy, and process sandboxing remain explicit security boundaries. |
| Delete after replacement | per-turn eight-row `builtin_bundle` boot | Built-ins mount once at process lifetime. A run creates only a cheap child scope and contributes run data; it does not rediscover/import/rebuild every plugin on every gesture. |
| Delete after replacement | duplicate registries and wrapper-only seams | `app.harness`, Fabric capability registration, model setup, prompt setup, and tool setup converge on one typed extension host. Compatibility adapters are removed once replay proves coverage. |

This inherits DSH's strongest plugin mechanism without importing DSH's user-facing complexity. Hermes supplies the practical discovery/trust policy that DSH's mechanism alone does not settle.

### 4.8 External agent supervision

Every external agent runs behind the same supervisor:

- start hidden with a bounded READY deadline;
- probe health before dispatch;
- bind a task/session ID before accepting work;
- retain durable status and artifact receipts;
- distinguish `accepted`, `running`, `suspended`, and terminal states;
- cancel the full Windows process tree;
- cache dead endpoints briefly to avoid repeated startup storms;
- never claim completion from process exit alone.

### 4.9 Hermes-style self-evolution

Self-evolution is a background review fork over the recorded trajectory, not silent mutation of the main prompt:

1. A completed, failed, corrected, or visibly frustrating run may enqueue a background review. User corrections and repeated friction are first-class signals, not just successful repetition.
2. The reviewer receives a bounded recent trajectory and runs with the current model or a configured auxiliary model. It has only memory/skill inspection and management tools: no desktop action, shell, browser, external-agent dispatch, send, delete, or permission escalation.
3. It first patches the skill that was actually loaded for the task; otherwise it updates an existing class-level umbrella skill; only then may it create a reusable class-level skill. One-session facts and overly narrow recipes are rejected.
4. Bundled and hub/installed skills are protected. Only user-managed or agent-managed skills can change. Every write records the source run, authoring model, diff, previous version, and rollback pointer.
5. A background change is reported visibly to the user. Agent-managed skills may become active after validation; user-owned skill changes remain editable and may require confirmation according to their configured ownership policy. Learned behavior never gains new tool permissions.
6. Replay fixtures and later outcomes continuously evaluate the learned version. Regression, user rollback, or repeated correction quarantines it and restores the previous version.

Raw screen text, secrets, and unrelated user data are not copied into learned instructions. Protected local evidence may be referenced by receipt for replay without being embedded in the skill.

The existing `SkillCandidateStore` survives only if it is reshaped behind this lifecycle. Its current two-handoff-recipe and threshold-only drafting behavior is not self-evolution.

## 5. Reconstruction Order

### Phase 0 — Repository truth and test visibility

- Preserve the dirty worktree and inventory deleted/modified/untracked contracts.
- Keep historical test deletions visible; do not use the smaller green suite as proof of compatibility.
- Establish reproducible commands with a project-local pytest base temp.

### Phase 1 — Evidence truth foundation

- Repair real-machine harness DPI awareness, foreground verification, screen metrics, and safe input.
- Validate FrameLease artifact and target binding before perception.
- Prove production pointerup capture on the actual 200% DPI desktop with screenshots and trace evidence.
- Fix the confirmed single-instance readiness leak and renderer CSP violation.
- Treat this as an internal reconstruction milestone; do not version or sync it separately.

No later runtime may use unbound current-screen evidence.

### Phase 2 — Recorded run foundation

- Introduce `RunJournal`, recorded/live event separation, deterministic folding, and model-surface derivation.
- Make current answers and tool execution observable through the journal while retaining the old runtime behind an adapter.
- Add crash recovery and replay verification.

### Phase 3 — Stateless turn engine and normal loop

- Replace the 3/4/6-turn logic with the stateless engine and natural tool loop.
- Move provider retry out of conversation history; add class-specific recovery and repeated-tool stall guards.
- Preserve steering, follow-up, compaction, and explicit suspension states.

### Phase 4 — Ordered bounded tool scheduling

- Port DSH scheduling semantics and Kimi resource-conflict declarations.
- Route permissioned actions through ActionBroker and verify all receipts.

### Phase 5 — Real plugin/runtime seams

- Replace per-turn `builtin_bundle` bootstrapping with typed registries and process/application lifetime scopes.
- Add Hermes-style sources, kinds, trust boundaries, lazy loading, disposers, re-entry safety, and override rules.

### Phase 6 — External agent parity

- Standardize Claude Code, Codex, Pi, Kimi, Hermes, and ACP handoffs behind the supervisor contract.
- Verify start, resume, status, cancellation, crash, and process-tree cleanup on Windows.

### Phase 7 — Self-evolution and evaluation

- Implement the restricted Hermes-style background reviewer and versioned skill store.
- Expose provenance, changes, status, and rollback without allowing learned privilege escalation.

### Phase 8 — Legacy removal and product hardening

- Remove obsolete bridges, duplicate routers, per-turn plugin boot, recipe turn limits, and compatibility paths only after recorded replay proves behavior coverage.
- Complete high-DPI, multi-display, failure, latency, and installed-version acceptance.

## 6. Acceptance Gates

Each phase is an internal verified milestone and must pass:

- focused red/green contract tests for every behavior change;
- full Python, Node, and TypeScript verification with zero unexpected failures;
- replay of retained scenario evidence;
- source-tree and controlled real-desktop verification for behavior changes;
- honest `usedBackend`, timings, errors, terminal reasons, and receipts;
- a progress-ledger update with retained evidence.

There is one delivery gate after the complete backend reconstruction: fresh full verification, one patch-version bump if behavior changed, one `npm run sync`, installed-version comparison, and installed-app acceptance. Intermediate phases do not consume versions or overwrite the user's installed application.

The evidence phase additionally requires a controlled Notepad scenario on the current 200% DPI desktop where frozen pixels, target identity, structured evidence, OCR evidence, and answer all refer to the same surface. A deliberately mismatched lease must fail closed without recapturing the current screen.

## 7. Definition of Done

The reconstruction is not done when tests are green or when a new plugin directory exists. It is done when the installed application can complete representative short desktop tasks with truthful grounding, normal agent execution, deterministic replay, verified actions, resilient external-agent supervision, and Hermes-class self-evolution—and when the superseded paths have been removed rather than left in parallel.
