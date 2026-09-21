import json
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
from scripts import selection_bridge as bridge
from app.adapters.base import AdapterReadContext
from app.grounding.explorer_adapter import ExplorerFileGrounder
from app.context_pack.sources import SourceReaderRegistry
from app.context_pack.document_reader import DocumentReader

started = time.monotonic()
window = {"hwnd": 7277804, "title": "微信", "process_name": "Weixin.exe", "bbox": [1454, 129, 2950, 1901]}
snapshot = {"snapshot_id": "acceptance-real-materials", "capture_path": str(root / "data/runtime/frame-leases/frame-b26c8a995dff44a1.png"),
            "capture_bbox": [0, 0, 3120, 2080]}
materials = []
for label, rect in [("A", [2136, 1373, 611, 32]), ("B", [2314, 486, 408, 205])]:
    x, y, w, h = rect
    points = [{"x": x, "y": y}, {"x": x+w, "y": y}, {"x": x+w, "y": y+h}, {"x": x, "y": y+h}, {"x": x, "y": y}]
    child = {**snapshot, "selection_bbox": rect, "selection_gesture": {"bbox": dict(zip(("x", "y", "width", "height"), rect)), "strokes": [{"points": points}]}}
    ctx, trace = bridge._fuse_pixel_tier(window, None, child)
    materials.append({"label": label, "content": ctx.content if ctx else None, "usedBackend": ctx.method if ctx else None, "trace": trace})
    print(json.dumps(materials[-1], ensure_ascii=False), flush=True)
items, trace = ExplorerFileGrounder()._read_desktop_shell_items()
pdf = next(item for item in items if item.name == "CVPR 2027 选题核验.pdf")
context = AdapterReadContext(adapter="explorer_file", app="explorer", window={}, content=pdf.name, label=pdf.name,
                             method=pdf.source, artifacts={"local_file": {"path": pdf.path}})
sources, refs, _, _ = bridge._initial_task_context("acceptance-pdf", "汇总", "s", None, context, snapshot)
reader = DocumentReader()
cursor = None
fragments = []
calls = 0
while True:
    result = reader.read(sources[0], None, cursor, 100)
    assert result.evidence_status == "ok", result.to_dict()
    fragments.extend(fragment.text for fragment in result.fragments)
    cursor = result.coverage.next_cursor
    calls += 1
    if not cursor:
        break
report = {"materials": materials, "pdf": {"path": pdf.path, "groundingBackend": pdf.source, "readBackend": result.used_backend,
          "chars": sum(map(len, fragments)), "fragments": len(fragments), "calls": calls, "pages": result.coverage.total_units},
          "elapsedMs": round((time.monotonic()-started)*1000), "errors": []}
(Path(__file__).parent / "materials-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"pdf": report["pdf"], "elapsedMs": report["elapsedMs"]}, ensure_ascii=False), flush=True)
