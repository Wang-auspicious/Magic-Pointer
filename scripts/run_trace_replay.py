"""Replay driver: trace -> snapshot payload -> selection_bridge -> expectation.

Offline end-to-end over the replay fixtures (L12 base): the frozen frame
and UIA tree come from the trace, nothing touches the live desktop, and the
result is compared against the trace's ground_truth replay_expectation.

Usage: python scripts/run_trace_replay.py data/replay_traces/fixtures/notepad-document-fallback.trace.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.replay.perception_replay import (  # noqa: E402
    expected_from_trace,
    load_trace,
    trace_to_snapshot_payload,
)


def _run_selection_bridge(payload: dict) -> dict:
    """Drive selection_bridge.main in-process with the replay payload.

    The bridge writes its result to stdout; replay captures it. In-process
    import keeps the replay fast and testable (the same main() the Electron
    runner executes via stdio).
    """
    import io
    import json as _json
    import contextlib

    from scripts import selection_bridge

    captured = io.StringIO()
    stdin_backup = sys.stdin
    stdout_backup = sys.stdout
    try:
        payload_bytes = _json.dumps(payload, ensure_ascii=False).encode("utf-8")
        sys.stdin = _FakeStdin(payload_bytes)
        sys.stdout = captured
        selection_bridge.main()
    finally:
        sys.stdin = stdin_backup
        sys.stdout = stdout_backup
    raw = captured.getvalue().strip()
    try:
        return _json.loads(raw)
    except ValueError:
        return {"ok": False, "error": "unparseable_bridge_output", "raw": raw[:400]}


class _FakeStdin:
    def __init__(self, payload: bytes) -> None:
        import io

        self._buffer = io.BytesIO(payload)

    @property
    def buffer(self):
        return self._buffer

    def read(self, *args, **kwargs):
        return self._buffer.read(*args, **kwargs)

    def readline(self, *args, **kwargs):
        return self._buffer.readline(*args, **kwargs)

    def fileno(self):
        import io

        raise io.UnsupportedOperation("replay stdin")


def _expectation_met(result: dict, expectation: dict) -> tuple[bool, str]:
    """Honest, narrow checks: the fixture asserts only its own contract."""
    answer = str(result.get("answer") or "")
    proposals = list(result.get("actionProposals") or [])
    checks: list[tuple[bool, str]] = []
    if "answer_contains" in expectation:
        needle = str(expectation["answer_contains"] or "")
        checks.append((needle in answer, f"answer_contains {needle!r}"))
    if "proposal_count" in expectation:
        checks.append((
            len(proposals) == int(expectation["proposal_count"]),
            f"proposal_count=={expectation['proposal_count']} (got {len(proposals)})",
        ))
    if "proposal_recipe" in expectation:
        hits = [
            proposal for proposal in proposals
            if str(proposal.get("recipeId") or "") == str(expectation["proposal_recipe"])
        ]
        checks.append((bool(hits), f"proposal_recipe {expectation['proposal_recipe']!r}"))
    failed = [reason for ok, reason in checks if not ok]
    return (not failed, "; ".join(failed) if failed else "ok")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: run_trace_replay.py <trace.json> [...]")
        return 2
    for arg in sys.argv[1:]:
        path = Path(arg)
        trace = load_trace(path)
        expectation = expected_from_trace(trace)
        payload = trace_to_snapshot_payload(trace)
        if not payload["command"]:
            print(f"{path.name}: SKIP (no command in trace)")
            continue
        try:
            result = _run_selection_bridge(payload)
        except Exception as exc:  # noqa: BLE001 - one trace failing must not kill the run
            print(f"{path.name}: ERROR {type(exc).__name__}: {exc}")
            continue
        ok, reason = _expectation_met(result, expectation)
        print(f"{path.name}: {'PASS' if ok else 'FAIL'} ({reason})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
