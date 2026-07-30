from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

_scripts_dir = str(Path(__file__).resolve().parent)
if _scripts_dir not in sys.path:
    sys.path.insert(0, _scripts_dir)

from _bridge_common import ensure_root_on_path, force_utf8_stdio, read_json_line, write_json  # noqa: E402

ensure_root_on_path()

from app.fabric.agents import AgentConnectorRegistry, AgentRequest
from app.fabric.providers import AgentProviderDiscovery
from app.fabric.task_store import AgentTaskStore

force_utf8_stdio()


def main() -> int:
    try:
        payload = read_json_line()
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
        write_json(result)
        return 0
    except Exception as exc:
        write_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
