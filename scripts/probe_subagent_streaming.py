"""Opt-in live gateway acceptance using MP's parent and child runtime kernels."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    from app.agent_runtime.activity_projection import RuntimeActivitySink
    from app.agent_runtime.subagent import register_delegate_tool
    from app.agent_runtime.tool_registry import ToolRegistry, Effect
    from app.ai_client import get_ai_config, request_ai_config
    from app.fabric.engine import run_agent_turn
    from app.harness.builtin_bundle import _MessagesLlmProvider
    from scripts.bridge_progress import PhaseClock
    from app.governance import BudgetPolicy, Stage, TimeoutAction

    output = ROOT / "data/runtime/subagent-streaming-20260920/live"
    output.mkdir(parents=True, exist_ok=True)
    workspace = output / "workspace"
    workspace.mkdir(exist_ok=True)
    (workspace / "runtime.txt").write_text("Runtime verdict: parent identity is deterministic.\n", encoding="utf-8")
    (workspace / "renderer.txt").write_text("Renderer verdict: token updates preserve DOM identity.\n", encoding="utf-8")
    started = time.perf_counter()
    snapshots = []
    provider = _MessagesLlmProvider(streaming=True)
    with request_ai_config({"effort": "low"}, session_id="mp-subagent-streaming-acceptance-20260920"):
        _, _, model = get_ai_config()
        with (output / "progress.log").open("w", encoding="utf-8") as progress:
            sink = RuntimeActivitySink(PhaseClock("subagent-acceptance", stream=progress))

            def child(payload):
                snapshots.append({"observedMs": round((time.perf_counter() - started) * 1000), **payload})
                sink.subagent_progress(payload)

            registry = ToolRegistry()
            register_delegate_tool(registry, llm_provider=provider, workspace_root=workspace,
                                   max_tool_calls=4, max_tokens=1024, subagent_event_sink=child)
            client = provider.create_client(system_prompt="You are testing Magic Pointer. Follow the user's exact delegation request. Use readonly Agent tools. Do not make changes. Keep the final response under 80 words.", max_tokens=1024, effort="low")
            terminal = run_agent_turn(
                f"Call two readonly Agent tools in the same response, with independent self-contained tasks. First child: use Read to read {workspace / 'runtime.txt'} and report its one-line verdict. Second child: use Read to read {workspace / 'renderer.txt'} and report its one-line verdict. Then summarize both results. Do not do the work yourself.",
                registry=registry, client=client, allowed_effects=(Effect.READ,), permission_mode="bypass",
                emergency_turn_fuse=4, event_sink=sink,
                budgets={Stage.FULL_ANSWER: BudgetPolicy(stage=Stage.FULL_ANSWER, budget_ms=120_000, on_timeout=TimeoutAction.STASH_BACKGROUND)},
            )
        children = {}
        for snapshot in snapshots:
            children[snapshot["id"]] = snapshot
        witness = {"model": model, "usedBackend": provider.used_backend,
                   "elapsedMs": round((time.perf_counter() - started) * 1000),
                   "terminal": terminal.reason.value, "answer": terminal.message,
                   "snapshotCount": len(snapshots), "children": list(children.values()),
                   "trajectory": sink.trajectory}
        (output / "result.json").write_text(json.dumps(witness, ensure_ascii=False, indent=2), encoding="utf-8")
        (output / "children.jsonl").write_text("".join(json.dumps(p, ensure_ascii=False) + "\n" for p in snapshots), encoding="utf-8")
        ok = terminal.reason.value == "completed" and len(children) == 2 and all(
            child.get("parentCallId") and child.get("status") == "completed" and child.get("stepCount", 0) > 0
            for child in children.values())
        print(json.dumps({key: witness[key] for key in ("model", "usedBackend", "elapsedMs", "terminal", "snapshotCount")}
                         | {"childCount": len(children), "ok": ok}, ensure_ascii=False))
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
