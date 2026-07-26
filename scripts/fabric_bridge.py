from __future__ import annotations

import json
import os
import sys
import webbrowser
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.fabric.catalog import public_recipe_catalog
from app.fabric.engine import FabricEngine
from app.fabric.mcp import CurrentObjectStore
from app.fabric.providers import AgentProviderDiscovery
from app.fabric.router import RecipeRouter
from app.fabric.settings import FabricSettings, SettingsStore
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


def _clipboard_writer(value: str) -> None:
    import pyperclip

    pyperclip.copy(value)


def _clipboard_reader() -> str:
    import pyperclip

    return str(pyperclip.paste() or "")


def map_execute_result(planned: dict[str, Any], receipt: dict[str, Any]) -> dict[str, Any]:
    """Map an execution receipt onto an honest bridge result.

    - verified local synchronous action -> ok:true, state "completed"
    - queued/running agent task -> ok:true, state "accepted" (explicitly not finished)
    - anything else -> ok:false with the receipt status preserved
    """
    status = str(receipt.get("status") or "")
    base = {"match": planned.get("match"), "plan": planned.get("plan"), "receipt": receipt}
    if status == "succeeded":
        return {"ok": True, "state": "completed", **base}
    if status == "accepted":
        task = receipt.get("output") if isinstance(receipt.get("output"), dict) else {}
        task_id = str(task.get("taskId") or "")
        plan = planned.get("plan") if isinstance(planned.get("plan"), dict) else {}
        parameters = plan.get("parameters") if isinstance(plan.get("parameters"), dict) else {}
        provider = str(task.get("provider") or parameters.get("agent") or "Agent")
        return {
            "ok": True,
            "state": "accepted",
            "provider": provider,
            "taskId": task_id,
            "message": f"已交给 {provider}，任务 {task_id} 正在运行，尚未完成。",
            **base,
        }
    result: dict[str, Any] = {"ok": False, "state": status or "failed", **base}
    if receipt.get("error"):
        result["error"] = str(receipt["error"])
    return result


def main() -> int:
    try:
        payload = _read()
        operation = str(payload.get("operation") or "catalog")
        user_root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
        store = SettingsStore(user_root / "fabric-settings.json")
        if operation == "catalog":
            result = {"ok": True, "recipes": public_recipe_catalog()}
        elif operation == "providers":
            result = {"ok": True, "providers": [item.to_dict() for item in AgentProviderDiscovery().discover_all()]}
        elif operation == "settings.get":
            result = {"ok": True, "settings": store.load().to_dict()}
        elif operation == "settings.save":
            settings = FabricSettings.from_dict(dict(payload.get("settings") or {}))
            store.save(settings)
            result = {"ok": True, "settings": settings.to_dict()}
        elif operation == "audit.tail":
            engine = FabricEngine(root=user_root, settings=store.load())
            result = {"ok": True, "events": engine.audit.tail(int(payload.get("limit") or 100))}
        elif operation == "current_object":
            episode = CurrentObjectStore(user_root / "current-object.json").read()
            result = (
                {"ok": False, "error": "no_frozen_object"}
                if episode is None
                else {"ok": True, "episode": episode}
            )
        elif operation.startswith("task."):
            tasks = AgentTaskStore(user_root / "agent-tasks")
            task_id = str(payload.get("taskId") or "")
            if operation == "task.status":
                task = tasks.status(task_id)
            elif operation == "task.cancel":
                task = tasks.cancel(task_id)
            elif operation == "task.steer":
                task = tasks.steer(task_id, str(payload.get("message") or ""))
            else:
                raise ValueError(f"unknown operation: {operation}")
            result = {"ok": True, "task": task}
        else:
            objects = [dict(item) for item in payload.get("objects") or [] if isinstance(item, dict)]
            command = str(payload.get("command") or "")
            if operation == "route":
                result = {"ok": True, "match": RecipeRouter().route(command, object_count=len(objects)).to_dict()}
            elif operation in {"plan", "execute"}:
                engine = FabricEngine(
                    root=user_root,
                    settings=store.load(),
                    clipboard_writer=_clipboard_writer,
                    clipboard_reader=_clipboard_reader,
                    url_opener=webbrowser.open,
                )
                planned = engine.plan(command, objects=objects, parameters=dict(payload.get("parameters") or {}))
                if operation == "plan" or planned.get("ok") is not True:
                    result = planned
                else:
                    receipt = engine.execute(dict(planned["plan"]), confirmed=payload.get("confirmed") is True)
                    result = map_execute_result(planned, receipt)
            else:
                raise ValueError(f"unknown operation: {operation}")
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") is not False else 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
