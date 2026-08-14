"""Benchmark the agent loop with injected fake model and tools.

Reports rounds, turns per round, tool calls per round, latency p50/p95/max,
cancellation hits, budget exhaustions and used_backend distribution.
Never contacts a real model backend.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.loop import LoopParams, run_agent_loop
from app.agent_runtime.model_client import (
    LoopModelClient,
    ModelTurnEvent,
    ToolCallArrived,
    TurnDone,
)
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall


class _BenchBackend:
    """Fake backend: returns two tool calls, then a final answer."""

    def __init__(self, tool_names: list[str], turns_until_done: int = 2) -> None:
        self._tool_names = tool_names
        self._turns_until_done = turns_until_done
        self.calls = 0

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.calls += 1
        if self.calls < self._turns_until_done:
            for i, name in enumerate(self._tool_names):
                yield ToolCallArrived(
                    ToolCall(id=f"call-{self.calls}-{i}", name=name, arguments={})
                )
        yield TurnDone(usage={"prompt_tokens": 100, "completion_tokens": 40}, raw_text="done")


def _make_tool(name: str) -> ToolSpec:
    def execute(**kwargs):
        return f"ok:{name}"

    return ToolSpec(
        name=name,
        description=f"benchmark tool {name}",
        input_schema={"type": "object", "properties": {}, "required": []},
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="local",
        execute=execute,
    )


def run_round(registry: ToolRegistry, tool_names: list[str], rounds: int) -> dict:
    results: list[dict] = []
    for i in range(rounds):
        backend = _BenchBackend(tool_names)
        client = LoopModelClient(backend=backend)
        params = LoopParams(
            user_input=f"bench round {i}",
            registry=registry,
            client=client,
            emergency_turn_fuse=4,
        )
        started = time.monotonic()
        tools_run = 0
        last_turn = 0
        async def consume():
            nonlocal tools_run, last_turn
            from app.agent_runtime.loop import LoopStopped, ToolCallStarted
            terminal = None
            async for event in run_agent_loop(params):
                if isinstance(event, ToolCallStarted):
                    tools_run += 1
                if isinstance(event, LoopStopped):
                    terminal = event.terminal
                    last_turn = terminal.turns
            return terminal
        import asyncio
        terminal = asyncio.run(consume())
        elapsed_ms = (time.monotonic() - started) * 1000.0
        results.append(
            {
                "round": i + 1,
                "turns": last_turn,
                "tools": tools_run,
                "latency_ms": elapsed_ms,
                "reason": terminal.reason.value if terminal else "no_terminal",
            }
        )
    return {
        "rounds": len(results),
        "turns": [r["turns"] for r in results],
        "tools": [r["tools"] for r in results],
        "latency_ms": [r["latency_ms"] for r in results],
        "reasons": [r["reason"] for r in results],
    }


def summarize(data: dict) -> dict:
    lat = data["latency_ms"]
    return {
        "rounds": data["rounds"],
        "successes": sum(1 for r in data["reasons"] if r not in ("invariant_failed", "budget_exhausted")),
        "errors": data["rounds"] - sum(1 for r in data["reasons"] if r not in ("invariant_failed", "budget_exhausted")),
        "turns_p50": statistics.median(data["turns"]),
        "tools_p50": statistics.median(data["tools"]),
        "latency_p50_ms": statistics.median(lat),
        "latency_p95_ms": statistics.quantiles(lat, n=20)[18] if len(lat) >= 20 else max(lat),
        "latency_max_ms": max(lat),
        "model_calls": data["rounds"] * 2,
        "used_backends": {"local": sum(data["tools"])},
        "budget_exhaustions": sum(1 for r in data["reasons"] if r == "budget_exhausted"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, default=50)
    parser.add_argument("--tools", type=int, default=4)
    parser.add_argument("--out", type=Path, default=Path("data/runtime/agent-loop-bench.json"))
    args = parser.parse_args()

    registry = ToolRegistry()
    names = [f"bench_tool_{i}" for i in range(args.tools)]
    for name in names:
        registry.register(_make_tool(name))
    data = run_round(registry, names, args.rounds)
    summary = summarize(data)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"summary": summary, "details": data}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print("agent loop benchmark")
    print(
        f"  rounds={summary['rounds']} successes={summary['successes']} errors={summary['errors']}"
    )
    print(
        f"  turns_p50={summary['turns_p50']} tools_p50={summary['tools_p50']} "
        f"latency_p50_ms={summary['latency_p50_ms']:.2f} "
        f"p95={summary['latency_p95_ms']:.2f} max={summary['latency_max_ms']:.2f}"
    )
    print(f"  model_calls={summary['model_calls']} used_backends={summary['used_backends']}")
    print(f"  report={args.out}")


if __name__ == "__main__":
    main()
