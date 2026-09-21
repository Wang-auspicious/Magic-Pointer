"""Single read-only production replay of the persisted historical selection."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import sys
import time
import traceback
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["MAGIC_POINTER_PERMISSION_MODE"] = "plan"
os.environ["MAGIC_POINTER_INLOOP_REVERSIBLE"] = "0"

from scripts import selection_bridge as bridge

bridge._configure_stdio()
stem = ROOT / "artifacts" / "selection-sovereign-replay-20260918-after"
baseline_path = ROOT / "artifacts" / "selection-sovereign-replay-20260918.json"
original_session = ROOT / "data/runtime/agent-sessions/agent-a3618dc7-e244-4894-b2a6-2157f77a05d9.jsonl"
baseline = json.loads(baseline_path.read_text(encoding="utf-8-sig"))
original_stat = original_session.stat()
snapshot = copy.deepcopy(baseline["snapshot"])
context = copy.deepcopy(baseline["perceptionContext"])
snapshot["context"] = context
snapshot["source_window"] = copy.deepcopy(context["window"])
frame = Path(baseline["sourceFrame"])
if not frame.is_file():
    raise FileNotFoundError(frame)
session_id = str(uuid.uuid4())
payload = {
    "command": baseline["command"],
    "selectionSessionId": session_id,
    "selectionSnapshot": snapshot,
}
target, app_ctx, restored_snapshot, snapshot_error = bridge._context_from_snapshot(payload)
if snapshot_error:
    raise ValueError(snapshot_error)
report = {
    "validation": "one production frozen-selection _loop_router replay after evidence temporal-boundary and Look error transparency fixes",
    "baselineReport": str(baseline_path),
    "sourceSession": str(original_session),
    "limitation": baseline["limitation"],
    "inputMethod": "existing frozen PNG, persisted OCR context and reconstructed closed polygon from baseline report; no expected answer added; original session history not seeded",
    "permissionMode": "plan",
    "inloopReversible": False,
    "provider": "unchanged configured default",
    "selectionSessionId": session_id,
    "command": payload["command"],
    "sourceFrame": str(frame),
    "sourceSizePx": baseline["sourceSizePx"],
    "regionXYWH": baseline["regionXYWH"],
    "snapshot": snapshot,
    "perceptionContext": context,
}
started = time.perf_counter()
with stem.with_suffix(".progress.log").open("w", encoding="utf-8") as progress:
    clock = bridge.PhaseClock("selection-acceptance-replay-after", stream=progress)
    clock.mark("replay_prepared", session=session_id)
    try:
        routing_settings = bridge._capture_settings()
        report["result"] = bridge._loop_router(
            payload["command"],
            bridge._fabric_objects(payload, target, app_ctx, restored_snapshot),
            target,
            app_ctx,
            restored_snapshot,
            dict(getattr(routing_settings, "recipe_enabled", None) or {}),
            session_id,
            str(snapshot.get("snapshot_id") or "") or None,
            clock=clock,
        )
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
    finally:
        report["timingMs"] = round((time.perf_counter() - started) * 1000, 2)
        after_stat = original_session.stat()
        report["originalSessionUnchanged"] = (
            after_stat.st_size == original_stat.st_size
            and after_stat.st_mtime_ns == original_stat.st_mtime_ns
        )
        stem.with_suffix(".json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        clock.mark("replay_saved", ok=bool((report.get("result") or {}).get("ok")))
print(json.dumps({
    "report": str(stem.with_suffix(".json")),
    "progress": str(stem.with_suffix(".progress.log")),
    "selectionSessionId": session_id,
    "timingMs": report["timingMs"],
    "error": report.get("error"),
    "result": report.get("result"),
}, ensure_ascii=False))
