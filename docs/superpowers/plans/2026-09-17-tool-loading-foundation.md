# Tool loading foundation

**Goal:** Finish the interrupted tool-loading work using the real registry, remove obsolete recipe wrappers, and reduce repeated schemas without losing executable tools or their permission checks.

**Architecture:** Keep common file/web/planning tools and desktop observation directly callable. Generate a compact directory from the remaining registered tools in the always-present `Tools` description. Exact batched selection loads their full schemas for the next request. Restore loaded names from successful discovery/execution `operation/settled` receipts; do not introduce another store or infer intent from keywords. Historical eager schemas in `model/request` are not evidence of actual use.

**Tech stack:** Python ToolRegistry/MPAgentRuntime/EventSession, existing Electron bridges.

## Evidence and scope

- Pi sessions `01a0a92c…` and `01a0ace2…` cover the UI implementation and Claude asset extraction. DeepSeek v4.1 continued in Claude session `0a5d3c1b-3c3e-4a6e-8705-90099b610000`; entries 7266–7309 stop at tool loading, with no implementation.
- The final user request removes redundant translation/table/canvas recipe tools and asks for a name/description directory plus targeted loading. The previous reply incorrectly grouped real perception and MCP tools with those wrappers.
- Reuse decision: retain ToolRegistry validation, scheduler, permissions and EventSession; extend discovery/selection. Delete the model-facing recipe wrapper module and its obsolete tests. Keep explicit application actions and document tools.
- Preserve pre-existing dirty changes in ai_client.py, subagent.py, icons.ts and their tests.

## Steps

- [x] Add `tests/tool_loading_test.py`: production boot excludes old wrappers; deferred tools have a compact visible directory; exact multi-name discovery does not match siblings; `Tools` survives a small limit; real loop loads schemas before execution; a reopened durable session retains the loaded schema after compaction.
- [x] Run `python -m pytest tests/tool_loading_test.py -q`. Observed failures: wrappers present, desktop schemas eager, exact `names` rejected, directory absent, resumed schema absent. Each failure maps directly to the production change below.
- [x] Move discovery to `app/agent_runtime/tool_discovery.py`, remove `app/fabric/capability_tools.py`, and replace the obsolete bundle row with `tool-discovery`. Return loaded names without repeating full parameter schemas in tool-result history.
- [x] Mark specialized desktop/local tools deferred; retain ListApps/Observe and ordinary code/web/plan tools. Build the directory from actual declarations in loop schema selection, pin Tools, prioritize exact name matches, and restore loaded names from existing successful operation receipts.
- [x] Run the focused discovery, registry, loop, bundle, permission, desktop and bridge tests. Replace obsolete recipe-wrapper wiring tests with coverage of retained execution boundaries. Initial expanded run: 359 passed.
- [x] Measure before/after schema plus directory tokens and local selection time; run a real read-only provider roundtrip to check that batched discovery leads to an executable tool and a visible answer. Report extra model rounds and actual timing separately from token estimates. 4995→3794 estimated tool tokens; real batch discovery→desktop find_roots→answer completed in 18.08s inside the bridge (3 model requests). The first attempt timed out after the tools had succeeded; see the handoff report.
- [x] Run fresh lint/typecheck/Node/Python verification. Update the canonical progress ledger and STATUS with verified scope; follow the current repository delivery rule for version and local sync. `npm run sync` exited 0: Node 217 files, Python 2129 passed, lint/typecheck clean; installed 1.0.46 and restarted. Independently compared 11 installed files, ran discovery with the bundled Python, and verified installed process paths. Removed the retired installed module left by overwrite-only copying.
