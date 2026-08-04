"""End-to-end: underline a line in a live window, ask a question, print the answer.

The unit tests prove the gate opens. This proves the user gets the sentence. It
runs the same two bridges the app runs, in the same order, with the same payload
shape, against a real window on this machine.

    python scripts/verify_marked_line_answer.py --title-contains "Windows PowerShell" --command "这是什么"
"""

from __future__ import annotations

import argparse
import ctypes
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.system_context import list_visible_windows  # noqa: E402


def run_bridge(script: str, payload: dict) -> dict:
    process = subprocess.run(
        [sys.executable, script],
        cwd=ROOT,
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
    )
    if process.returncode != 0:
        raise SystemExit(f"{script} exited {process.returncode}\n{process.stderr[-2000:]}")
    line = [item for item in process.stdout.splitlines() if item.strip().startswith("{")]
    if not line:
        raise SystemExit(f"{script} printed no JSON\n{process.stdout[-2000:]}\n{process.stderr[-2000:]}")
    return json.loads(line[-1])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title-contains", required=True)
    parser.add_argument("--command", default="这是什么")
    parser.add_argument("--line", type=int, default=3)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--index", type=int, default=0, help="which matching window, by z-order")
    parser.add_argument("--y", type=int, default=0, help="exact screen row to underline (overrides --line)")
    args = parser.parse_args()

    needle = args.title_contains.casefold()
    matches = [w for w in list_visible_windows() if needle in str(w.get("title") or "").casefold()]
    if len(matches) <= args.index:
        print(f"only {len(matches)} window(s) matched")
        return 2
    target = matches[args.index]
    left, top, right, bottom = target["bbox"]
    row_height = max(1, (bottom - top) // max(1, args.rows))
    y = args.y if args.y else top + row_height * args.line + row_height // 2
    x0 = left + int((right - left) * 0.10)
    x1 = left + int((right - left) * 0.60)
    hwnd = int(target.get("hwnd") or 0)
    ctypes.windll.user32.ShowWindow(hwnd, 9)
    ctypes.windll.user32.SetForegroundWindow(hwnd)
    time.sleep(0.6)
    print("target             :", repr(target.get("title")), target["bbox"])
    print("foregrounded       :", ctypes.windll.user32.GetForegroundWindow() == hwnd)
    print("mark               :", [x0, y - row_height // 2, x1 - x0, row_height])

    gesture = {
        "schemaVersion": 2,
        "coordinateSpace": "physical_screen_pixels",
        "releasePoint": {"x": x1, "y": y},
        "bbox": {"x": x0, "y": y - row_height // 2, "width": x1 - x0, "height": row_height},
        "strokes": [{"points": [
            {"x": x, "y": y} for x in range(x0, x1, max(1, (x1 - x0) // 12))
        ]}],
    }
    snapshot_result = run_bridge("scripts/selection_snapshot_bridge.py", {
        "cursor": {"x": (x0 + x1) // 2, "y": y},
        "cursorSpace": "physical_screen_pixels",
        "gesture": gesture,
        "foregroundHwnd": hwnd,
        "foregroundApp": str(target.get("title") or ""),
    })
    snapshot = snapshot_result["selectionSnapshot"]
    print("source_kind        :", snapshot.get("source_kind"))
    print("covers_mark        :", snapshot.get("structured_covers_mark"))
    print("gap_reason         :", snapshot.get("structured_gap_reason"))
    print("selection_bbox     :", snapshot.get("selection_bbox"))
    print("capture_path       :", snapshot.get("capture_path"))
    print("perception attempts:", json.dumps(
        [f"{a.get('adapter')}/{a.get('status')}/{a.get('reason')}"
         for a in (snapshot.get("perception_trace") or {}).get("attempts") or []],
        ensure_ascii=False,
    ))
    context_content = str(((snapshot.get("context") or {}).get("content")) or "")
    print("structured content :", repr(context_content)[:200])

    answer = run_bridge("scripts/selection_bridge.py", {
        "command": args.command,
        "selectionSessionId": "verify-session",
        "selectionSnapshot": snapshot,
        "requestId": "verify-1",
        "source": "pointer_stage",
        "requestMode": "auto",
        "targetPoint": snapshot.get("target_point"),
        "targetPointSpace": snapshot.get("target_point_space"),
        "workspaceRoot": str(ROOT),
    })
    print("\n--- answer ---")
    print(str(answer.get("answer") or "")[:1500])
    print("\nkind:", answer.get("kind"), "| tier:", answer.get("routeTier") or answer.get("tier"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
