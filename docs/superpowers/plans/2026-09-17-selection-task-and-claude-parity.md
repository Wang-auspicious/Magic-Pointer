# Selection task continuity and Claude reference parity

User priority: fix the demonstrated selection/Stage/Studio failure first, then inspect every original and added Claude reference and correct the interface, including Artifacts and hover motion.

## Observed production evidence

- Stash `0917-231927-4diaw8.png`: Studio shows the question but no answer. The matching persisted turn `c1789657940597` already contains the 552-character answer.
- Stash `0917-231945-11x8h8.png` and frozen frame `frame-77cd6b736b74471b.png`: the selected object is Codex's Environment sidebar, not conversation prose.
- Agent session `agent-a3618dc7-e244-4894-b2a6-2157f77a05d9`: Look reported HTTP 429 text as successful vision evidence; Observe used half-scale UIA bounds next to physical window bounds. The model then answered from unrelated conversation context.
- Studio onChange refreshes lists but omits the open transcript. Stage progress rebuilds its card for each patch. Dismiss invalidates the selection and cancels its child. Stage contract strips most runtime metadata.

## Implementation and verification

- [x] Add failing tests for vision failure evidence, pointed-region geometry/context, shared progress metadata, stable transcript updates and dismiss-without-cancel.
- [x] Fix evidence generation at its source: errors remain errors, coordinates are physical, contextual files cannot substitute for the pointed UI. Replay the supplied frozen frame through the real configured provider; retain the partial transcription/live-fallback limits in the delivery report.
- [x] Give the running task one persistent conversation and progress projection. Stage and Studio render the same agent turn; dismiss detaches only the small window, Stop cancels the task. Preserve streamed and final messages/events, and prevent late output from reopening a dismissed window.
- [x] Verify actual Stage/Studio rendering and close-during-execution using controlled local app verification. Preserve the existing user conversation; repair stale display without inventing content.
- [x] View every image in `参考claude设计` and `more` individually; record differences and exact source values. Inspect the scraped CSS/font/icon files and hover states, and acquire missing authorized reference data when accessible.
- [x] Correct Artifacts, navigation, composer, menus, spacing, typography, icons and hover behavior against references; verify source component dimensions and actual Chromium screenshots/interaction. All 47 references were inspected; unavailable pixel-pet assets and Claude-only service states are explicitly recorded rather than claimed as exact parity. Final library acceptance: 24189ms, no failures or console errors.
- [x] Fresh full verification and local sync completed for 1.0.47: lint/typecheck, 228 Node test files, 2164 Python tests; 308 shipped files match byte-for-byte, bundled installed Python smoke passes, five app processes run from the installation. STATUS and canonical ledger record the actual delivery and unresolved external-model/reference-state limits. Pre-existing dirty model/subagent/icon work is preserved.

Use the existing ToolRegistry, durable sessions, conversation store, renderer and surface contracts. Do not add a second agent executor or redesign the reference.
