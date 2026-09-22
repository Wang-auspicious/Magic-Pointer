
import json
import os
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["MAGIC_POINTER_PERMISSION_MODE"] = "plan"
os.environ["MAGIC_POINTER_INLOOP_REVERSIBLE"] = "0"

from app.adapters.base import AdapterReadContext
from scripts import selection_bridge as bridge


def main():
    fixture_dir = ROOT / "data/acceptance-20260918"
    output = ROOT / "data/backend-20260918"
    output.mkdir(parents=True, exist_ok=True)
    evidence = json.loads((fixture_dir / "materials-verification.json").read_text(encoding="utf-8"))
    window = {"title": "微信", "process_name": "Weixin.exe", "hwnd": 7277804,
              "bbox": [1454, 129, 2950, 1901]}
    snapshot = {"snapshot_id": f"benchmark-{uuid.uuid4().hex}",
                "capture_path": str(ROOT / "data/runtime/frame-leases/frame-b26c8a995dff44a1.png"),
                "capture_bbox": [0, 0, 3120, 2080], "selection_materials": []}
    rects = [[2136, 1373, 611, 32], [2314, 486, 408, 205], [361, 1351, 149, 76]]
    for index, item in enumerate(evidence["materials"]):
        context = AdapterReadContext(adapter="local_ocr", app="wechat", window=window,
            label=f"微信选区 {index + 1}", content=item["content"], method=item["usedBackend"])
        snapshot["selection_materials"].append({"source_window": window, "context": context.to_dict(),
                                                "selection_bbox": rects[index]})
    desktop = {"title": "Program Manager", "class_name": "Progman", "process_name": "explorer.exe"}
    context = AdapterReadContext(adapter="explorer_file", app="explorer", window=desktop,
        label="CVPR 2027 选题核验.pdf", content=evidence["pdf"]["path"],
        method=evidence["pdf"]["groundingBackend"], artifacts={"local_file": {"path": evidence["pdf"]["path"]}})
    command = "基于这些信息，总结200字讲清楚你推荐的最合适选题。"
    started = time.monotonic()
    context = bridge._enrich_local_file_context(command, context, snapshot)
    preparation_ms = round((time.monotonic() - started) * 1000)
    snapshot["selection_materials"].append({"source_window": desktop, "context": context.to_dict(),
                                            "selection_bbox": rects[2]})
    main_context = AdapterReadContext.from_dict(snapshot["selection_materials"][0]["context"])
    started = time.monotonic()
    with (output / "runtime-progress.log").open("w", encoding="utf-8") as stream:
        result = bridge._loop_router(command, [], window, main_context, snapshot, None,
            str(uuid.uuid4()), snapshot["snapshot_id"],
            clock=bridge.PhaseClock("backend-real-runtime", stream=stream))
    report = {"method": "production Runtime/provider on original frozen OCR plus native desktop PDF",
              "limitations": ["WeChat HTML body is absent; only its attachment card was captured",
                              "model/provider timings vary; single replay is not a latency distribution"],
              "preparationMs": preparation_ms, "elapsedMs": round((time.monotonic() - started) * 1000),
              "result": result}
    (output / "runtime-replay.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("preparationMs", "elapsedMs")}, ensure_ascii=False))
    print(json.dumps({key: result.get(key) for key in ("ok", "answer", "usedBackend", "modelUsage", "agentSessionId")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
