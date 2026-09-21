import json
import os
import sys
import time
import uuid
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
os.environ["MAGIC_POINTER_PERMISSION_MODE"] = "plan"
os.environ["MAGIC_POINTER_INLOOP_REVERSIBLE"] = "0"
from scripts import selection_bridge as bridge
from app.adapters.base import AdapterReadContext

directory = Path(__file__).parent
evidence = json.loads((directory / "materials-verification.json").read_text(encoding="utf-8"))
window = {"title": "微信", "process_name": "Weixin.exe", "hwnd": 7277804, "bbox": [1454, 129, 2950, 1901]}
snapshot = {"snapshot_id": f"acceptance-{uuid.uuid4().hex}", "capture_path": str(root / "data/runtime/frame-leases/frame-b26c8a995dff44a1.png"),
            "capture_bbox": [0, 0, 3120, 2080], "selection_materials": []}
rects = [[2136, 1373, 611, 32], [2314, 486, 408, 205], [361, 1351, 149, 76]]
for index, item in enumerate(evidence["materials"]):
    ctx = AdapterReadContext(adapter="local_ocr", app="wechat", window=window, label=f"微信选区 {index+1}",
                             content=item["content"], method=item["usedBackend"])
    snapshot["selection_materials"].append({"source_window": window, "context": ctx.to_dict(), "selection_bbox": rects[index]})
desktop = {"title": "Program Manager", "class_name": "Progman", "process_name": "explorer.exe"}
ctx = AdapterReadContext(adapter="explorer_file", app="explorer", window=desktop, label="CVPR 2027 选题核验.pdf",
                         content=evidence["pdf"]["path"], method=evidence["pdf"]["groundingBackend"],
                         artifacts={"local_file": {"path": evidence["pdf"]["path"]}})
command = "基于这些信息，总结200字讲清楚你推荐的最合适选题。"
ctx = bridge._enrich_local_file_context(command, ctx, snapshot)
snapshot["selection_materials"].append({"source_window": desktop, "context": ctx.to_dict(), "selection_bbox": rects[2]})
main_ctx = AdapterReadContext.from_dict(snapshot["selection_materials"][0]["context"])
started = time.monotonic()
with (directory / "runtime-progress.log").open("w", encoding="utf-8") as stream:
    result = bridge._loop_router(command, [], window, main_ctx, snapshot, None, str(uuid.uuid4()), snapshot["snapshot_id"],
                                 clock=bridge.PhaseClock("materials-real-runtime", stream=stream))
report = {"method": "production Runtime on original frozen OCR selections plus native desktop PDF source; no expected answer supplied",
          "limitations": ["WeChat attachment body was not acquired; card text only", "gesture rectangles reconstructed from original persisted references"],
          "elapsedMs": round((time.monotonic()-started)*1000), "result": result}
(directory / "runtime-replay.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"elapsedMs": report["elapsedMs"], "answer": result.get("answer"), "ok": result.get("ok"),
                  "error": result.get("error"), "usedBackend": result.get("usedBackend")}, ensure_ascii=False))
