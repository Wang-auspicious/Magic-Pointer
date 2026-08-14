# Magic Pointer Harness Reconstruction Design

**Date:** 2026-08-14

**Status:** Approved direction; implementation is phased

**Primary product source of truth:** `docs/design/MAGIC_POINTER_HARNESS_20260811.md`

## 1. Outcome

Magic Pointer remains a short-task desktop interaction compiler: the user points at a real surface, gives a short instruction, and receives an editable, verifiable result. The reconstruction must make the agent behind that interaction as dependable as the strongest local harness references without importing their product complexity into the foreground experience.

The finished system must have five properties:

1. **Evidence is truthful.** A run cannot claim that pixels, accessibility structure, DOM, COM, OCR, or a target lease refer to the same surface unless the binding is validated. Contradictory evidence fails closed and is visible in the run ledger.
2. **The agent can continue while it is making progress.** There is no user-visible six-turn cliff. Completion, cancellation, resource exhaustion, permission boundaries, or repeated lack of progress end a run; an arbitrary small model-call count does not.
3. **The runtime is replayable.** Model-visible history is derived from an append-only recorded event stream. Compaction changes the model surface, not the historical record.
4. **Extensions are real seams.** Surface adapters, tools, model providers, hooks, context engines, and external agents have distinct contracts, lifetimes, trust rules, and unload behavior. A wrapper around one implementation is not called a plugin seam.
5. **Learning is verified and reversible.** Repeated successful trajectories may become disabled skill candidates. Promotion requires replay evidence and human review; enabled skills retain provenance, can be shadow-evaluated, and can be rolled back.

## 2. Constraints

- Pointer completion freezes historical pixels before any Magic Pointer UI, UIA/DOM/COM/OCR read, or model call can alter the observed scene.
- Full local target-surface evidence is retained. A gesture crop is an index into that surface, not the only visual evidence.
- Perception is concurrent evidence fusion. It is not a serial first-nonempty fallback.
- Deterministic state, coordinates, permissions, action leases, execution, and verification stay outside the model.
- The resident process is idle/event-driven. Expensive reads start only after an explicit gesture, wake, or task.
- The foreground product stays suitable for a few-turn, few-minute daily task. Project-scale coding continues in Claude Code, Codex, Pi, Kimi, or another external agent through an explicit handoff.
- Existing dirty work belongs to the user or earlier agents. Reconstruction replaces modules only behind contract tests and does not reset the worktree.

## 3. Reference Reuse Ledger

### 3.1 DeepSeek Harness — MIT

Reuse directly where the language and surrounding contracts permit; otherwise port faithfully with attribution in the repository notes:

- append-only session events and the invariant that model-visible input is derivable from recorded state;
- surface replacement for compaction while retaining historical provenance;
- bounded rolling tool pool, exclusive barriers, model-order result commit, and synthetic results for calls skipped by abort;
- steer/follow-up/inject wake semantics;
- fail-closed process and sandbox behavior.

Do not transplant the whole Cordis graph. Magic Pointer needs the invariants, not DSH's developer-preview complexity.

### 3.2 Kimi Code — MIT

Use as the primary turn-engine shape:

- a stateless turn runner;
- a single-provider step separated from tool-call batch execution;
- recorded events separated from live-only UI events;
- the host owns sessions, permissions, compaction policy, protocol bridges, and UI;
- every dispatched tool call is paired with a recorded result unless interruption occurred before dispatch.

### 3.3 Pi — MIT

Reuse its small, deep interfaces:

- append-tree session navigation and context derivation;
- repository/store separation;
- compact steering and follow-up queues;
- direct, inspectable agent-loop boundaries.

Pi is the complexity check: if a Magic Pointer interface cannot be explained as simply as Pi's equivalent, the design must justify why.

### 3.4 Hermes Agent — MIT

Hermes is the operational and self-evolution benchmark:

- plugin discovery by source and kind, lazy loading, trust-aware override rules, hook isolation, and sanitized observer payloads;
- READY handshake, health probes, Windows process-tree termination, retries, dead-target caching, and durable execution receipts;
- hard suspension versus soft resume-pending session states;
- middleware/trajectory observation that can produce reviewed, reusable behavior.

Magic Pointer must not copy Hermes's monolithic conversation loop. It must copy the operational contracts and the learning lifecycle.

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

The broker starts permitted evidence providers concurrently and waits within explicit per-provider budgets. Results retain source, method, timing, confidence, coverage of the gesture, and errors. Fusion prefers evidence that covers the mark and agrees with the immutable target binding. Empty UIA container text cannot suppress pixel evidence.

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

One invocation consumes a `ModelSurface`, available tool descriptors, current continuation lease, and queued steering. It produces recorded model events and either:

- a final response/draft;
- a tool-call batch;
- a permission or user-input suspension;
- a structured provider failure;
- a compaction request.

It does not own persistent session state, UI, plugin discovery, or process lifetime.

### 4.5 Progress-aware continuation

The current `max_turns = 6` and recipe limits of 3–4 are removed as normal termination rules. A run instead owns a `ContinuationLease` with:

- wall-clock, token/cost, and tool-execution budgets appropriate to the task class;
- consecutive no-progress count;
- retry budgets by failure class;
- current permission/user-input suspension state;
- last verified progress marker;
- a high invariant fuse used only to stop a broken loop, never reported as normal completion.

Verified progress includes new grounded evidence, a successful non-duplicate tool result, a verified artifact/action, a meaningful draft version, or a resolved dependency. Repeating the same tool call, receiving the same error, emitting only meta-commentary, or cycling between equivalent states is not progress.

The terminal reasons are `completed`, `needs_user`, `permission_required`, `suspended`, `cancelled`, `resource_exhausted`, `no_progress`, `provider_unavailable`, and `invariant_failed`. The UI must never translate one of these into a fake completed answer.

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
- `ToolProvider`: descriptors plus executors and resource keys;
- `ModelProvider`: streaming generation, health, cancellation, and usage;
- `ContextEngine`: model-surface derivation/compaction policy;
- `RunHook`: isolated lifecycle observation with sanitized payloads;
- `ExternalAgentProvider`: READY/health/dispatch/status/cancel/resume;
- `RendererSlotProvider`: sandboxed MCP/application UI.

Built-in trusted extensions and third-party extensions have different override rules. Expensive extensions load lazily. Every registration returns a disposer; unloading restores the previous registry state. A seam is considered real only after two implementations or one implementation plus an explicit external compatibility contract.

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

### 4.9 Self-evolution

Self-evolution is a governed data loop, not prompt mutation:

1. `RunObserver` derives privacy-bounded semantic observations from completed, verified runs.
2. Repeated successful patterns create a disabled `SkillCandidate` with source run/receipt provenance.
3. The candidate is replayed against retained fixtures and shadow-evaluated on future matching runs.
4. Promotion requires minimum evidence thresholds, no safety regression, stable or improved success/latency, and explicit human review.
5. The installed skill is versioned, disabled by default unless explicitly enabled, and retains a rollback pointer.
6. Failures, user corrections, and manual rollback lower confidence and may automatically quarantine the version.

Raw screen text, secrets, paths, and user prompts are not copied into learning records by default. Learning stores semantic action/evidence shapes and references to protected local artifacts.

The existing `SkillCandidateStore` is retained only if it passes this contract. Its current restriction to two handoff recipes and threshold-only draft generation is not sufficient.

## 5. Phased Reconstruction

### Phase 0 — Repository truth and test visibility

- Preserve the dirty worktree and inventory deleted/modified/untracked contracts.
- Keep historical test deletions visible in the handoff; do not use the smaller green suite as proof of compatibility.
- Establish reproducible commands with a project-local pytest base temp.

### Phase 1 — Evidence truth foundation

- Repair real-machine harness DPI awareness, foreground verification, screen metrics, and safe input.
- Validate FrameLease artifact and target binding before perception.
- Prove production pointerup capture on the actual 200% DPI desktop with screenshots and trace evidence.
- Fix the confirmed single-instance readiness leak and renderer CSP violation.
- Ship the batch to the installed application.

No Agent Runtime replacement begins until this phase passes.

### Phase 2 — Recorded run foundation

- Introduce `RunJournal`, recorded/live event separation, deterministic folding, and model-surface derivation.
- Make current answers and tool execution observable through the journal while retaining the old runtime behind an adapter.
- Add crash recovery and replay verification.

### Phase 3 — Stateless turn engine and continuation lease

- Replace the six-turn loop with the stateless engine and progress-aware continuation.
- Preserve steering, follow-up, compaction, provider recovery, and explicit suspension states.

### Phase 4 — Ordered bounded tool scheduling

- Port DSH scheduling semantics and Kimi resource-conflict declarations.
- Route permissioned actions through ActionBroker and verify all receipts.

### Phase 5 — Real plugin/runtime seams

- Replace per-turn `builtin_bundle` bootstrapping with typed registries and process/application lifetime scopes.
- Add lazy loading, trust boundaries, disposers, re-entry safety, and third-party override rules.

### Phase 6 — External agent parity

- Standardize Claude Code, Codex, Pi, Kimi, Hermes, and ACP handoffs behind the supervisor contract.
- Verify start, resume, status, cancellation, crash, and process-tree cleanup on Windows.

### Phase 7 — Self-evolution and evaluation

- Replace threshold-only skill drafting with observed trajectory scoring, replay, shadow evaluation, review, promotion, quarantine, and rollback.
- Expose candidate evidence and version history in the studio without allowing automatic privilege escalation.

### Phase 8 — Legacy removal and product hardening

- Remove obsolete bridges, duplicate routers, and compatibility paths only after recorded replay proves behavior coverage.
- Complete high-DPI, multi-display, failure, latency, and installed-version acceptance.

## 6. Acceptance Gates

Each phase ships working software and must pass:

- focused red/green contract tests for every behavior change;
- full Python, Node, and TypeScript verification with zero unexpected warnings/errors;
- replay of retained scenario evidence;
- installed-app verification for user-visible changes;
- honest `usedBackend`, timings, errors, terminal reasons, and receipts;
- version bump, `npm run sync`, installed-version comparison, and `docs/STATUS.md` ledger update when behavior changes.

Phase 1 additionally requires a controlled Notepad scenario on the current 200% DPI desktop where the frozen pixels, target identity, structured evidence, OCR evidence, and answer all refer to the same surface. A deliberately mismatched lease must fail closed without recapturing the current screen.

## 7. Definition of Done

The reconstruction is not done when tests are green or when a new plugin directory exists. It is done when the installed application can complete representative short desktop tasks with truthful grounding, progress-aware agent execution, deterministic replay, verified actions, resilient external-agent supervision, and governed self-evolution—and when the superseded paths have been removed rather than left in parallel.
