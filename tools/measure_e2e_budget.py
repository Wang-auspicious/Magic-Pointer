"""Where a real task's wall-clock actually goes, measured through a real bridge.

Every acceptance round so far was verified with headless unit tests, and every
one of them was surprised on a real machine. The gap is not rigour, it is
altitude: a unit test can prove a function returns the right dict, and cannot
answer the only two questions a user has — *did it finish*, and *how long did I
wait*.

This runs the production bridge over its production protocol (one JSON line in,
one JSON line out) N times, aggregates the ``@@mp`` phase lines it already
emits, and prints the split. Nothing is stubbed, nothing is armed ahead of
time: it measures whatever the machine and the gateway are actually doing right
now.

What it measured on 2026-09-16 (mimo-v2.5 on opencode.ai/zen, "list the open
windows", 1 tool call, 2 model rounds)::

    runtime_boot        239 ms
    turn 1 first token 5932 ms   <- waiting for the model
    ListApps              4.7 ms <- the tool
    turn 2 first token 5633 ms   <- waiting for the model
    streaming out      1381 ms
    total             13654 ms

85% of the wall clock is time-to-first-token, and the tool the whole task
exists to run costs five milliseconds. That ratio is the product's latency
story, and it is not visible from inside any unit test.

Usage::

    python tools/measure_e2e_budget.py --runs 5
    python tools/measure_e2e_budget.py --runs 3 --task "总结当前窗口" --json out.json
    python tools/measure_e2e_budget.py --runs 10 --min-success 0.9   # CI gate

Exit code is 1 when the success rate falls below ``--min-success`` (default 1.0),
so this can stand as a gate rather than only as a report.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

#: The bridge behind the Studio conversation surface. It speaks the same
#: protocol Electron speaks to it: one JSON request line on stdin, one JSON
#: result line on stdout, phase timings on stderr.
BRIDGE = "scripts/conversation_bridge.py"

DEFAULT_TASK = "列出当前打开的所有窗口标题，然后告诉我一共几个。必须调用工具获取。"

_PHASE_LINE = re.compile(r"^@@mp\s+(.*)$")


def _parse_fields(rest: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for token in rest.split():
        key, _, value = token.partition("=")
        if key:
            fields[key] = value
    return fields


def _phases(stderr_text: str) -> list[dict[str, str]]:
    """Every ``@@mp`` line, in order, as field dicts."""
    rows: list[dict[str, str]] = []
    for line in stderr_text.splitlines():
        match = _PHASE_LINE.match(line.strip())
        if match:
            rows.append(_parse_fields(match.group(1)))
    return rows


def _ms(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


class RunOutcome:
    """One bridge invocation, reduced to the numbers worth comparing."""

    def __init__(self, *, ok: bool, wall_ms: float, error: str = "") -> None:
        self.ok = ok
        self.wall_ms = wall_ms
        self.error = error
        self.total_ms: float | None = None
        self.boot_ms: float | None = None
        #: Time from each ``model_request`` to the first chunk that answered it.
        self.ttft_ms: list[float] = []
        #: Executed tool latencies, as the tools themselves reported them.
        self.tool_ms: list[float] = []
        self.tool_names: list[str] = []
        self.turns = 0

    @property
    def model_wait_ms(self) -> float:
        return sum(self.ttft_ms)

    @property
    def tool_total_ms(self) -> float:
        return sum(self.tool_ms)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "error": self.error,
            "wallMs": round(self.wall_ms, 1),
            "totalMs": round(self.total_ms, 1) if self.total_ms is not None else None,
            "bootMs": round(self.boot_ms, 1) if self.boot_ms is not None else None,
            "turns": self.turns,
            "ttftMs": [round(value, 1) for value in self.ttft_ms],
            "toolMs": [round(value, 3) for value in self.tool_ms],
            "toolNames": self.tool_names,
        }


def _reduce(rows: list[dict[str, str]], outcome: RunOutcome) -> None:
    """Fold the phase stream into per-round waits and per-tool latencies."""
    pending_request_ms: float | None = None
    for row in rows:
        phase = row.get("phase", "")
        at_ms = _ms(row.get("ms"))
        if phase == "runtime_ready":
            outcome.boot_ms = at_ms
        elif phase == "total":
            outcome.total_ms = at_ms
        elif phase.startswith("agent_turn_turn="):
            outcome.turns += 1
        elif phase == "model_request":
            pending_request_ms = at_ms
        elif phase in {"reasoning_chunk", "answer_chunk", "model_first_chunk", "tool_call"}:
            # The first thing to come back after a request closes that round's
            # wait, whatever kind of chunk it happens to be. Reasoning counts:
            # the user is still staring at nothing while the model thinks.
            if pending_request_ms is not None and at_ms is not None:
                outcome.ttft_ms.append(at_ms - pending_request_ms)
                pending_request_ms = None
        elif phase == "tool_result":
            latency = _ms(row.get("latency_ms"))
            if latency is not None:
                outcome.tool_ms.append(latency)
            name = row.get("name")
            if name:
                outcome.tool_names.append(name)


def run_once(task: str, *, preset: str, timeout_s: float, index: int) -> RunOutcome:
    payload = {
        "question": task,
        "turns": [],
        "object": {},
        "permissionPreset": preset,
        "effort": "high",
        "conversationId": f"measure-e2e-{index}",
        "agentSessionId": f"measure-e2e-{index}",
    }
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            [sys.executable, "-u", BRIDGE],
            input=json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(ROOT),
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return RunOutcome(
            ok=False,
            wall_ms=(time.perf_counter() - started) * 1000.0,
            error=f"timeout>{timeout_s:g}s",
        )
    wall_ms = (time.perf_counter() - started) * 1000.0

    answer_ok = False
    error = ""
    last_line = (proc.stdout or "").strip().splitlines()
    if last_line:
        try:
            result = json.loads(last_line[-1])
            answer_ok = bool(result.get("ok")) and bool(str(result.get("answer") or "").strip())
            if not answer_ok:
                error = str(result.get("error") or "empty answer")[:200]
        except json.JSONDecodeError as exc:
            error = f"unparseable stdout: {exc}"
    else:
        error = f"no stdout (rc={proc.returncode})"

    outcome = RunOutcome(ok=answer_ok, wall_ms=wall_ms, error=error)
    _reduce(_phases(proc.stderr or ""), outcome)
    return outcome


def _pct(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return ordered[index]


def _fmt(value: float | None, unit: str = "ms") -> str:
    return "—" if value is None else f"{value:,.0f}{unit}"


def report(outcomes: list[RunOutcome], task: str) -> dict[str, Any]:
    ok = [item for item in outcomes if item.ok]
    success_rate = len(ok) / len(outcomes) if outcomes else 0.0

    walls = [item.wall_ms for item in ok]
    waits = [item.model_wait_ms for item in ok]
    tools = [item.tool_total_ms for item in ok]
    every_ttft = [value for item in ok for value in item.ttft_ms]
    every_tool = [value for item in ok for value in item.tool_ms]

    wall_p50 = _pct(walls, 0.5)
    wait_p50 = _pct(waits, 0.5)
    share = (wait_p50 / wall_p50 * 100.0) if wall_p50 and wait_p50 else None

    print(f"\n  task: {task}")
    print(f"  runs: {len(outcomes)}   success: {len(ok)}/{len(outcomes)} ({success_rate:.0%})")
    if not ok:
        for index, item in enumerate(outcomes):
            print(f"    run{index}: FAILED {item.error}")
        return {
            "task": task,
            "runs": len(outcomes),
            "successRate": success_rate,
            "outcomes": [item.to_dict() for item in outcomes],
        }

    print("\n  wall clock       p50 / p95 / max")
    print(f"    total          {_fmt(wall_p50)} / {_fmt(_pct(walls, 0.95))} / {_fmt(max(walls))}")
    print(f"    model wait     {_fmt(wait_p50)} / {_fmt(_pct(waits, 0.95))} / {_fmt(max(waits))}")
    print(f"    tool execution {_fmt(_pct(tools, 0.5))} / {_fmt(_pct(tools, 0.95))} / {_fmt(max(tools))}")
    if share is not None:
        print(f"\n    -> {share:.0f}% of a median task is waiting for the model's first token")

    if every_ttft:
        print(
            f"\n  per model round, time to first token: "
            f"p50 {_fmt(_pct(every_ttft, 0.5))}  p95 {_fmt(_pct(every_ttft, 0.95))}  "
            f"max {_fmt(max(every_ttft))}  (n={len(every_ttft)})"
        )
    if every_tool:
        print(
            f"  per tool call, execution: "
            f"p50 {_pct(every_tool, 0.5):.1f}ms  max {max(every_tool):.1f}ms  (n={len(every_tool)})"
        )
    rounds = [item.turns for item in ok]
    if rounds:
        print(f"  model rounds per task: median {statistics.median(rounds):.0f}  max {max(rounds)}")

    failures = [item for item in outcomes if not item.ok]
    if failures:
        print("\n  failures:")
        for item in failures:
            print(f"    - {item.error}  (after {item.wall_ms:,.0f}ms)")

    return {
        "task": task,
        "runs": len(outcomes),
        "successRate": success_rate,
        "wallMsP50": wall_p50,
        "modelWaitMsP50": wait_p50,
        "modelWaitShare": share,
        "ttftMsP50": _pct(every_ttft, 0.5),
        "toolMsP50": _pct(every_tool, 0.5),
        "outcomes": [item.to_dict() for item in outcomes],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=3, help="how many real bridge invocations (default 3)")
    parser.add_argument("--task", default=DEFAULT_TASK, help="the request to send")
    parser.add_argument("--preset", default="read-only", help="permission preset (default read-only)")
    parser.add_argument("--timeout", type=float, default=180.0, help="per-run timeout in seconds")
    parser.add_argument(
        "--min-success",
        type=float,
        default=1.0,
        help="exit 1 below this success rate (default 1.0, i.e. every run must answer)",
    )
    parser.add_argument("--json", type=Path, default=None, help="also write the full report here")
    args = parser.parse_args(argv)

    print(f"measuring {args.runs} real runs through {BRIDGE} ...")
    outcomes: list[RunOutcome] = []
    for index in range(max(1, args.runs)):
        outcome = run_once(args.task, preset=args.preset, timeout_s=args.timeout, index=index)
        outcomes.append(outcome)
        state = "ok" if outcome.ok else f"FAIL ({outcome.error})"
        print(
            f"  run{index}: {state} wall={outcome.wall_ms:,.0f}ms "
            f"rounds={outcome.turns} model_wait={outcome.model_wait_ms:,.0f}ms "
            f"tools={outcome.tool_total_ms:.1f}ms",
            flush=True,
        )

    summary = report(outcomes, args.task)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n  report written to {args.json}")

    if summary["successRate"] < args.min_success:
        print(
            f"\nFAIL: success rate {summary['successRate']:.0%} is below "
            f"--min-success {args.min_success:.0%}"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
