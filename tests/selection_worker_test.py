"""Resident selection worker JSONL transport smoke tests."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_worker_reuses_one_process_for_multiple_requests() -> None:
    process = subprocess.Popen(
        [sys.executable, "-u", str(ROOT / "scripts" / "selection_worker.py")],
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdin is not None
    assert process.stdout is not None
    try:
        process.stdin.write(json.dumps({"id": "one", "op": "ping"}) + "\n")
        process.stdin.flush()
        first = json.loads(process.stdout.readline())
        process.stdin.write(json.dumps({"id": "two", "op": "ping"}) + "\n")
        process.stdin.flush()
        second = json.loads(process.stdout.readline())

        assert first["id"] == "one"
        assert second["id"] == "two"
        assert first["result"]["pid"] == second["result"]["pid"]
        assert first["result"]["hostId"] == second["result"]["hostId"]

        process.stdin.write(json.dumps({"id": "stop", "op": "shutdown"}) + "\n")
        process.stdin.flush()
        stopped = json.loads(process.stdout.readline())
        assert stopped["result"]["ok"] is True
        assert process.wait(timeout=10) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
