# DSH Studio source-faithful transplant plan

> Execute the already-approved DSH transplant without another design round.

1. Preserve the dirty tree, inspect the rejected 1.0.7 shell and trace the
   assistant-answer and runtime-event paths end to end.
2. Pin the desired behavior with failing tests for safe structural Markdown,
   progress IPC/correlation, persisted activity and metrics, DSH workspace and
   header hierarchy, trajectory projection, and the removal of the custom
   five-destination sidebar.
3. Transplant the DSH macro shell: WorkspaceBrowser grouping, exact header/tabs,
   source tag, Session log control, centered chat column, task/goal strips,
   composer and stats placement. Retain only Magic Pointer branding/content.
4. Add a safe Markdown renderer and feed it to settled assistant messages.
5. Wire the agent runtime event sink through `conversation_bridge.py`, main,
   preload and Studio; show live model/tool rows, persist completed activities,
   and render only real tool events.
6. Implement the DSH trajectory projection, real stats groups and JSON session
   log export.
7. Build a capture-only fidelity fixture, capture normal/narrow/settings and the
   installed real-data view, compare against the supplied DSH references and
   correct visible mismatches.
8. Run fresh full Python, Node, TypeScript and lint verification; bump 1.0.7 to
   1.0.8, update the canonical progress ledger and `docs/STATUS.md`, run
   `npm run sync`, and confirm the installed package version.
