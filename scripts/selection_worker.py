"""Resident JSONL worker for selection requests and the Agent harness."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.harness.builtin_bundle import LoopHarnessHost  # noqa: E402
from scripts import selection_bridge  # noqa: E402

_MAX_LINE_CHARS = 8 * 1024 * 1024


class _PayloadStdin:
    def __init__(self, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.buffer = io.BytesIO(raw)

    def read(self, *args, **kwargs):
        return self.buffer.read(*args, **kwargs)

    def readline(self, *args, **kwargs):
        return self.buffer.readline(*args, **kwargs)


def _run_selection(payload: dict[str, Any]) -> dict[str, Any]:
    captured = io.StringIO()
    previous_stdin = sys.stdin
    previous_stdout = sys.stdout
    try:
        sys.stdin = _PayloadStdin(payload)  # type: ignore[assignment]
        sys.stdout = captured
        selection_bridge.main()
    finally:
        sys.stdin = previous_stdin
        sys.stdout = previous_stdout
    lines = [line for line in captured.getvalue().splitlines() if line.strip()]
    if not lines:
        return {"ok": False, "error": "selection_worker_empty_result"}
    try:
        value = json.loads(lines[-1])
    except json.JSONDecodeError:
        return {"ok": False, "error": "selection_worker_invalid_result"}
    return value if isinstance(value, dict) else {
        "ok": False,
        "error": "selection_worker_invalid_result",
    }


def _write(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    host_id = uuid.uuid4().hex
    host: LoopHarnessHost | None = None
    try:
        for raw_line in sys.stdin:
            if len(raw_line) > _MAX_LINE_CHARS:
                _write({"id": None, "result": {"ok": False, "error": "payload_too_large"}})
                continue
            try:
                request = json.loads(raw_line)
            except json.JSONDecodeError:
                _write({"id": None, "result": {"ok": False, "error": "invalid_json"}})
                continue
            request_id = str(request.get("id") or "") if isinstance(request, dict) else ""
            operation = str(request.get("op") or "run") if isinstance(request, dict) else ""
            if operation == "ping":
                _write({
                    "id": request_id,
                    "result": {"ok": True, "pid": os.getpid(), "hostId": host_id},
                })
                continue
            if operation == "shutdown":
                _write({"id": request_id, "result": {"ok": True}})
                return 0
            payload = request.get("payload") if isinstance(request, dict) else None
            if operation != "run" or not isinstance(payload, dict) or not request_id:
                _write({
                    "id": request_id or None,
                    "result": {"ok": False, "error": "invalid_request"},
                })
                continue
            if host is None:
                host = LoopHarnessHost(root=ROOT)
                selection_bridge.set_loop_harness_host(host)
            try:
                result = _run_selection(payload)
            except Exception as exc:  # noqa: BLE001 - worker stays available
                result = {
                    "ok": False,
                    "error": "selection_worker_request_failed",
                    "detail": f"{type(exc).__name__}: {exc}"[:500],
                }
            _write({"id": request_id, "result": result})
    finally:
        selection_bridge.set_loop_harness_host(None)
        if host is not None:
            with contextlib.suppress(Exception):
                host.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
