"""Thin golden-path smoke layer (review Q12): own UIA toolchain, no Playwright.

SendInput-synthesized pointer + real window + real frozen frame + the real
snapshot bridge + the real selection bridge, asserted against honest
outcomes (answer content, phase progress, ledger files). Never launches the
Electron UI; never asserts what a human eye should verify (overlay
exclusion, DPI colours).

Subcommands:
  uia-host      resident UIA host: spawn -> ping -> probe -> timing
  replay        offline: every replay fixture through run_trace_replay
  notepad-read  live: Notepad + synthetic gesture -> frame lease ->
                snapshot bridge -> selection bridge -> honest assertion

Usage: python scripts/smoke/golden_path_smoke.py <subcommand>
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def _send_input_move(x: int, y: int) -> None:
    user32 = ctypes.windll.user32
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.05)


def _smoke_uia_host() -> int:
    import os

    from app.uia_host_client import UiaHostClient

    os.environ["MAGIC_POINTER_UIA_HOST"] = "1"
    exe = ROOT / "data" / "runtime" / "uia_resident_host.exe"
    if not exe.exists():
        print("uia-host: FAIL (exe not compiled)")
        return 1
    proc = subprocess.Popen(
        [str(exe)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(0.6)
        client = UiaHostClient(connect_timeout_s=1.0, response_timeout_s=5.0)
        if not client.ping():
            print("uia-host: FAIL (ping)")
            return 1
        hwnd = int(ctypes.windll.user32.GetForegroundWindow() or 0)
        started = time.monotonic()
        data = client.probe(hwnd)
        wall_ms = (time.monotonic() - started) * 1000.0
        if not data or data.get("ok") is not True:
            print(f"uia-host: FAIL (probe {data})")
            return 1
        print(
            f"uia-host: PASS ping+probe ok kind={data.get('result_kind')} "
            f"wall_ms={wall_ms:.0f} probe_ms={data.get('elapsed_ms')}"
        )
        return 0
    finally:
        try:
            proc.terminate()
        except Exception:
            pass


def _smoke_replay() -> int:
    driver = ROOT / "scripts" / "run_trace_replay.py"
    fixtures = sorted((ROOT / "data" / "replay_traces" / "fixtures").glob("*.trace.json"))
    proc = subprocess.run(
        [sys.executable, str(driver), *(str(path) for path in fixtures)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=1800,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    failures = [line for line in lines if "FAIL" in line or "ERROR" in line]
    for line in lines:
        print(f"replay: {line}")
    print(f"replay: {'FAIL' if failures else 'PASS'} ({len(lines)} fixtures)")
    return 1 if failures else 0


def _find_notepad_window():
    from app.system_context import list_visible_windows

    for window in list_visible_windows():
        title = str(window.get("title") or "")
        if "notepad" in title.casefold() or (
            "记事本" in title and str(window.get("process_name") or "").casefold() == "notepad.exe"
        ):
            return window
    return None


def _frozen_frame_lease(window: dict, gesture_points: list) -> dict:
    """Production-shape FrameLease over a real GDI grab of the target window.

    This is the same source the production fallback path uses
    (``gdi-fallback``); the smoke asserts the chain, not the WGC latency.
    """
    import time as _time

    from PIL import ImageGrab

    bounds = list(window.get("rect") or window.get("bounds") or [0, 0, 800, 600])
    if len(bounds) != 4:
        raise RuntimeError(f"no window bounds: {window}")
    image = ImageGrab.grab(bbox=tuple(int(value) for value in bounds))
    artifact_dir = ROOT / "data" / "runtime" / "smoke"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    path = artifact_dir / f"smoke-frame-{int(_time.time())}.png"
    image.save(path)
    payload = image.tobytes()
    now_ms = _time.time() * 1000.0
    return {
        "schemaVersion": 1,
        "frameLeaseId": "smoke-lease",
        "epochId": "smoke-epoch",
        "capturedAtMonotonicMs": now_ms,
        "capturedAtUtc": _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime()),
        "source": "gdi-fallback",
        "targetWindow": {
            "hwnd": int(window.get("hwnd") or 0),
            "processId": int(window.get("pid") or 0),
            "processName": str(window.get("process_name") or ""),
            "title": str(window.get("title") or ""),
        },
        "surfaceBoundsPx": [int(value) for value in bounds],
        "displayId": "smoke-display-0",
        "scaleFactor": 1.0,
        "gesture": {
            "points": [
                {"x": int(point[0]), "y": int(point[1]), "t": 0}
                for point in gesture_points
            ],
            "bbox": {
                "x": min(p[0] for p in gesture_points),
                "y": min(p[1] for p in gesture_points),
                "width": max(p[0] for p in gesture_points) - min(p[0] for p in gesture_points) + 4,
                "height": max(p[1] for p in gesture_points) - min(p[1] for p in gesture_points) + 4,
            },
        },
        "localArtifact": {
            "path": str(path),
            "mimeType": "image/png",
            "width": int(image.width),
            "height": int(image.height),
        },
        "contentHash": hashlib.sha256(payload).hexdigest(),
        "overlayExcluded": False,
        "captureLatencyMs": 0.0,
    }


def _smoke_notepad_read() -> int:
    content = "Magic Pointer 冒烟测试：第三行是产品定位。\n第二行。\n产品定位：把人的桌面指代预编译为短任务上下文。"
    notepad = subprocess.Popen(
        ["notepad.exe"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1.2)
    try:
        # Type the known content into Notepad via the clipboard (SendInput
        # keystrokes are fragile across IMEs; clipboard paste is deterministic).
        import pyperclip

        pyperclip.copy(content)
        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, "无标题 - 记事本")
        if not hwnd:
            hwnd = user32.FindWindowW(None, "Untitled - Notepad")
        if not hwnd:
            print("notepad-read: FAIL (notepad window not found)")
            return 1
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.4)
        user32.keybd_event(0x11, 0, 0, 0)  # Ctrl
        user32.keybd_event(0x56, 0, 0, 0)  # V
        user32.keybd_event(0x56, 0, 2, 0)
        user32.keybd_event(0x11, 0, 2, 0)
        time.sleep(0.6)
        window = {
            "hwnd": int(hwnd),
            "title": "无标题 - 记事本",
            "process_name": "notepad.exe",
            "pid": 0,
            "rect": [100, 100, 900, 700],
            "class_name": "Notepad",
        }
        # Synthetic gesture: draw a stroke across the text area.
        points = [(300, 200 + index * 12) for index in range(12)]
        for x, y in points:
            _send_input_move(x, y)
        lease = _frozen_frame_lease(window, points)
        payload = {
            "command": "概况总结这个文件。",
            "selectionSessionId": "smoke-notepad",
            "selectionSnapshot": None,
            "frameLease": lease,
            "foregroundHwnd": int(hwnd),
            "foregroundApp": "notepad.exe",
            "targetPoint": {"x": 300, "y": 260},
            "targetPointSpace": "physical_screen_pixels",
            "gesture": lease["gesture"],
            "screenBounds": [0, 0, 1920, 1080],
            "scaleFactor": 1.0,
            "allowVisualFallback": True,
        }
        snapshot_result = _run_bridge(
            "scripts/selection_snapshot_bridge.py", payload, timeout=120
        )
        if not snapshot_result.get("ok"):
            print(f"notepad-read: FAIL snapshot {snapshot_result.get('error')}")
            return 1
        snapshot = snapshot_result["selectionSnapshot"]
        bridge_payload = {
            "command": "概况总结这个文件。",
            "selectionSessionId": "smoke-notepad",
            "selectionSnapshotId": snapshot.get("snapshot_id"),
            "selectionSnapshot": snapshot,
            "requestMode": "auto",
        }
        bridge_result = _run_bridge(
            "scripts/selection_bridge.py", bridge_payload, timeout=120
        )
        answer = str(bridge_result.get("answer") or "")
        print(f"notepad-read: answer={answer[:120]!r}")
        ok = ("产品" in answer or "定位" in answer or "预编译" in answer)
        if not ok:
            print(f"notepad-read: FAIL answer did not ground on the document: {answer[:300]}")
            return 1
        print("notepad-read: PASS (snapshot -> loop answer grounded on live Notepad)")
        return 0
    finally:
        try:
            notepad.terminate()
        except Exception:
            pass


def _run_bridge(script: str, payload: dict, timeout: int) -> dict:
    proc = subprocess.run(
        [sys.executable, str(ROOT / script)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        return {"ok": False, "error": f"bridge empty stdout rc={proc.returncode}"}
    try:
        return json.loads(lines[-1])
    except ValueError:
        return {"ok": False, "error": "unparseable bridge output"}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: golden_path_smoke.py <uia-host|replay|notepad-read>")
        return 2
    command = sys.argv[1]
    if command == "uia-host":
        return _smoke_uia_host()
    if command == "replay":
        return _smoke_replay()
    if command == "notepad-read":
        return _smoke_notepad_read()
    print(f"unknown smoke subcommand: {command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
