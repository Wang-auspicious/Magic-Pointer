from __future__ import annotations

import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts import selection_snapshot_bridge as capture  # noqa: E402


def main():
    out = ROOT / "data/runtime/selection-multisource-20260919"
    out.mkdir(parents=True, exist_ok=True)
    frame = ROOT / "data/runtime/frame-leases/frame-2dc5410ab4c44c55.png"
    strokes = [
        {"points": [{"x": x, "y": y} for x, y in [(1795, 1290), (2120, 1293), (2470, 1300)]]},
        {"points": [{"x": x, "y": y} for x, y in [(2255, 460), (2110, 500), (2105, 540), (2235, 583), (2330, 570), (2395, 500), (2310, 453), (2255, 460)]]},
        {"points": [{"x": x, "y": y} for x, y in [(390, 1310), (358, 1340), (358, 1385), (413, 1400), (449, 1358), (420, 1310), (390, 1310)]]},
    ]
    gesture = capture._normalized_gesture({"schemaVersion": 2, "coordinateSpace": "physical_screen_pixels", "strokes": strokes})
    windows = capture.list_visible_windows()
    target = next((w for w in windows if str(w.get("process_name", "")).lower() == "weixin.exe"), None)
    if target is None:
        raise RuntimeError("WeChat window is no longer at the frozen location; do not attest live structure to this frame")
    if list(target["bbox"]) != [1130, 188, 2626, 1960]:
        raise RuntimeError("WeChat geometry changed since the historical frame")
    windows = [target, capture._desktop_window()]
    lease = {
        "schemaVersion": 1, "frameLeaseId": "selection-replay-20260919", "epochId": "selection-replay",
        "capturedAtMonotonicMs": 1, "capturedAtUtc": "2026-09-19T05:32:08.000Z", "source": "gdi-fallback",
        "targetWindow": {"hwnd": target["hwnd"], "processId": target["pid"], "title": target["title"], "processName": target["process_name"]},
        "surfaceBoundsPx": [0, 0, 3120, 2080], "displayId": "historical-display", "scaleFactor": 2,
        "gesture": gesture, "localArtifact": {"path": str(frame), "mimeType": "image/png", "width": 3120, "height": 2080},
        "contentHash": "sha256:" + hashlib.sha256(frame.read_bytes()).hexdigest(), "overlayExcluded": True, "captureLatencyMs": 0,
    }
    started = time.perf_counter()
    result = capture.capture_snapshot(windows, gesture=gesture, target_hwnd=target["hwnd"], target_point=gesture["releasePoint"],
                                      frame_lease=lease, foreground_app="Weixin", default_capture_mode="local_screenshot")
    snapshot = result["selectionSnapshot"]
    snapshot["expires_at"] = "2099-01-01T00:00:00+00:00"
    payload = {"command": "基于这些信息，总结200字讲清楚你推荐的最合适选题。", "selectionSnapshot": snapshot,
               "selectionSessionId": "selection-acceptance-20260919", "requestMode": "auto", "workspaceRoot": str(ROOT),
               "replyStyle": "normal"}
    (out / "request.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf8")
    witness = {"capturedAt": datetime.now(timezone.utc).isoformat(), "snapshotMs": (time.perf_counter()-started)*1000,
               "requestBytes": len(json.dumps(payload, ensure_ascii=False).encode("utf8")), "materials": [{
                   "window": m.get("source_window"), "content": (m.get("context") or {}).get("content"),
                   "localFile": ((m.get("context") or {}).get("artifacts") or {}).get("local_file"),
                   "trace": m.get("perception_trace"),
               } for m in snapshot.get("selection_materials", [])]}
    (out / "capture-witness.json").write_text(json.dumps(witness, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps({**witness, "materials": [{k:v for k,v in m.items() if k!='trace'} for m in witness['materials']]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
