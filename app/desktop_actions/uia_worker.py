from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from app.agent_runtime.errors import ActionFailure, FailureType


def request(payload: dict[str, Any], *, timeout_s: float = 5.0, scope: object = None) -> Any:
    checker = getattr(scope, "raise_if_cancelled", None) or getattr(getattr(scope, "token", None), "raise_if_cancelled", None)
    if callable(checker):
        checker()
    child = subprocess.Popen(
        [sys.executable, "-m", "app.desktop_actions.uia_worker"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", cwd=Path(__file__).resolve().parents[2],
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    deadline = time.monotonic() + max(0.01, float(timeout_s))
    data = json.dumps(payload, ensure_ascii=False)
    try:
        while True:
            if callable(checker):
                checker()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ActionFailure(FailureType.TIMEOUT, "UIA provider timed out; isolated worker terminated")
            try:
                output, error = child.communicate(input=data, timeout=min(0.05, remaining))
                break
            except subprocess.TimeoutExpired:
                data = None
        if child.returncode:
            raise ActionFailure(FailureType.TOOL_ERROR, f"UIA worker failed: {error[-1000:]}")
        result = json.loads(output)
        if result.get("error"):
            raise ActionFailure(FailureType.TOOL_ERROR, str(result["error"]))
        return result["result"]
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate()


def main() -> int:
    from app.desktop_actions.uia import UiaBridge

    try:
        payload = json.load(sys.stdin)
        bridge = UiaBridge()
        if payload["operation"] == "tree":
            result = bridge.list_elements(int(payload["hwnd"]))
        else:
            result = bridge.act(str(payload["action"]), dict(payload["element"]), payload.get("value"))
        response = {"result": result}
    except Exception as exc:
        response = {"error": f"{type(exc).__name__}: {exc}"}
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
