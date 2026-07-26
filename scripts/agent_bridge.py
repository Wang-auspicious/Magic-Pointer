from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.fabric.agents import AgentConnectorRegistry, AgentRequest
from app.fabric.providers import AgentProviderDiscovery
from app.fabric.task_store import AgentTaskStore


if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _read() -> dict[str, Any]:
    value = json.loads(sys.stdin.read() or "{}")
    if not isinstance(value, dict):
        raise ValueError("payload must be an object")
    return value


def main() -> int:
    try:
        payload = _read()
        operation = str(payload.get("operation") or "providers")
        if operation == "providers":
            result = {"ok": True, "providers": [item.to_dict() for item in AgentProviderDiscovery().discover_all()]}
        else:
            store = AgentTaskStore()
            if operation == "status":
                result = {"ok": True, "task": store.status(str(payload.get("taskId") or ""))}
            elif operation == "cancel":
                result = {"ok": True, "task": store.cancel(str(payload.get("taskId") or ""))}
            elif operation == "steer":
                result = {"ok": True, "task": store.steer(str(payload.get("taskId") or ""), str(payload.get("message") or ""))}
            elif operation == "start":
                request = AgentRequest.from_dict(dict(payload.get("request") or {}))
                executable = str(payload.get("executable") or shutil.which(request.provider if request.provider != "cursor" else "cursor-agent") or "")
                invocation = AgentConnectorRegistry().build(
                    request,
                    executable=executable,
                    profile=dict(payload.get("profile") or {}),
                )
                result = {"ok": True, "task": store.start(request, invocation)}
            else:
                raise ValueError(f"unknown operation: {operation}")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
