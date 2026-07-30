from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket
from PIL import ImageChops, ImageDraw, ImageGrab

from onboarding_fixture import write_ready_onboarding_marker
ROOT = Path(__file__).resolve().parents[1]
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
ELECTRON = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
FIXTURE = ROOT / "tests" / "fixtures" / "stage_sweep_visual.html"
EVIDENCE_DIR = ROOT / "data" / "runtime" / "stage-sweep-20260728"
PORT = 9342
WINDOW_TITLE = "Magic Pointer Sweep Visual Fixture"


def enable_dpi_awareness() -> None:
    user32 = ctypes.windll.user32
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            user32.SetProcessDPIAware()


def visible_windows() -> list[dict]:
    user32 = ctypes.windll.user32
    windows: list[dict] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def callback(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        rect = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            windows.append({
                "hwnd": int(hwnd),
                "title": buffer.value,
                "bbox": [rect.left, rect.top, rect.right, rect.bottom],
            })
        return True

    user32.EnumWindows(callback, 0)
    return windows


def wait_for_page(timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=1) as response:
                pages = json.loads(response.read().decode("utf-8"))
            page = next((item for item in pages if WINDOW_TITLE in str(item.get("title"))), None)
            if page:
                return page
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("edge_fixture_page_unavailable")


def evaluate(websocket_url: str, expression: str):
    connection = websocket.create_connection(websocket_url, timeout=5, origin="http://127.0.0.1")
    try:
        connection.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "returnByValue": True},
        }))
        while True:
            payload = json.loads(connection.recv())
            if payload.get("id") == 1:
                return payload.get("result", {}).get("result", {}).get("value")
    finally:
        connection.close()


def wait_for_window(timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for window in visible_windows():
            if WINDOW_TITLE in str(window.get("title") or ""):
                return window
        time.sleep(0.25)
    raise RuntimeError("edge_fixture_window_unavailable")


def physical_target(window: dict, geometry: dict) -> dict[str, int]:
    left, top, right, bottom = [float(value) for value in window["bbox"]]
    side_chrome = max(0.0, (float(geometry["outerWidth"]) - float(geometry["innerWidth"])) / 2.0)
    top_chrome = max(
        0.0,
        float(geometry["outerHeight"]) - float(geometry["innerHeight"]) - side_chrome,
    )
    scale_x = (right - left) / max(1.0, float(geometry["outerWidth"]))
    scale_y = (bottom - top) / max(1.0, float(geometry["outerHeight"]))
    target = geometry["target"]
    return {
        "x": round(left + (side_chrome + float(target["x"]) + float(target["width"]) * 0.92) * scale_x),
        "y": round(top + (top_chrome + float(target["y"]) + float(target["height"]) / 2) * scale_y),
    }


def physical_element_rect(window: dict, geometry: dict, key: str) -> dict[str, int]:
    left, top, right, bottom = [float(value) for value in window["bbox"]]
    side_chrome = max(0.0, (float(geometry["outerWidth"]) - float(geometry["innerWidth"])) / 2.0)
    top_chrome = max(
        0.0,
        float(geometry["outerHeight"]) - float(geometry["innerHeight"]) - side_chrome,
    )
    scale_x = (right - left) / max(1.0, float(geometry["outerWidth"]))
    scale_y = (bottom - top) / max(1.0, float(geometry["outerHeight"]))
    target = geometry[key]
    return {
        "x": round(left + (side_chrome + float(target["x"])) * scale_x),
        "y": round(top + (top_chrome + float(target["y"])) * scale_y),
        "width": max(1, round(float(target["width"]) * scale_x)),
        "height": max(1, round(float(target["height"]) * scale_y)),
    }


def click_at(x: int, y: int) -> None:
    user32 = ctypes.windll.user32
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.08)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    user32.mouse_event(0x0004, 0, 0, 0, 0)


def press_escape() -> None:
    user32 = ctypes.windll.user32
    user32.keybd_event(0x1B, 0, 0, 0)
    time.sleep(0.06)
    user32.keybd_event(0x1B, 0, 0x0002, 0)


def press_activation_hotkey() -> None:
    user32 = ctypes.windll.user32
    key_up = 0x0002
    keys = [0x11, 0x12, 0x10, 0x7A]  # Control + Alt + Shift + F11
    for key in keys:
        user32.keybd_event(key, 0, 0, 0)
    time.sleep(0.08)
    for key in reversed(keys):
        user32.keybd_event(key, 0, key_up, 0)


def wait_for_log(path: Path, pattern: str, timeout: float = 20.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        if pattern in text:
            return text
        time.sleep(0.03)
    raise RuntimeError(f"electron_log_missing:{pattern}")


def wait_for_log_occurrences(path: Path, pattern: str, minimum: int, timeout: float = 20.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        if text.count(pattern) >= minimum:
            return text
        time.sleep(0.25)
    raise RuntimeError(f"electron_log_missing_occurrences:{pattern}:{minimum}")


def wait_for_outside_click(websocket_url: str, minimum: int, timeout: float = 8.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        count = int(evaluate(websocket_url, "window.__outsideClicks") or 0)
        if count >= minimum:
            return count
        time.sleep(0.15)
    return int(evaluate(websocket_url, "window.__outsideClicks") or 0)


def wait_for_sweep_click(websocket_url: str, minimum: int, timeout: float = 3.0) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        count = int(evaluate(websocket_url, "window.__sweepClicks") or 0)
        if count >= minimum:
            return count
        time.sleep(0.12)
    return int(evaluate(websocket_url, "window.__sweepClicks") or 0)


def stop_process_tree(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    subprocess.run(
        ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
        capture_output=True,
        check=False,
    )


def main() -> int:
    if not EDGE.exists():
        raise RuntimeError("microsoft_edge_not_found")
    if not ELECTRON.exists():
        raise RuntimeError("electron_runtime_not_found")
    enable_dpi_awareness()
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

    safe_temp_root = Path(tempfile.gettempdir()).resolve()
    run_root = Path(tempfile.mkdtemp(prefix="magic-pointer-stage-sweep-")).resolve()
    if run_root.parent != safe_temp_root or not run_root.name.startswith("magic-pointer-stage-sweep-"):
        raise RuntimeError("unsafe_temp_root")
    profile = run_root / "edge-profile"
    runtime = run_root / "runtime"
    profile.mkdir()
    runtime.mkdir()
    write_ready_onboarding_marker(runtime)
    (runtime / "fabric-settings.json").write_text(json.dumps({
        "schema_version": 1,
        "activation": {
            "wake_mode": "hotkey",
            "fallback_hotkey": "Control+Alt+Shift+F11",
        },
        "shortcuts": {"wake": "Control+Alt+Shift+F11"},
        "interaction": {"default_input_mode": "text"},
        "appearance": {"selection_visual": "sweep_band"},
        "connections": {
            "browser_devtools_enabled": True,
            "browser_devtools_endpoints": [f"http://127.0.0.1:{PORT}"],
        },
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    edge: subprocess.Popen | None = None
    electron: subprocess.Popen | None = None
    electron_trace = None
    try:
        edge = subprocess.Popen([
            str(EDGE),
            f"--remote-debugging-port={PORT}",
            "--remote-allow-origins=*",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--disable-features=msEdgeTranslate,Translate",
            "--window-position=120,80",
            "--window-size=1100,880",
            FIXTURE.resolve().as_uri(),
        ])
        page = wait_for_page()
        window = wait_for_window()
        geometry = evaluate(page["webSocketDebuggerUrl"], """(() => {
          const target = document.getElementById('target');
          const outside = document.getElementById('outside-target');
          window.getSelection().removeAllRanges();
          target.focus?.();
          const rect = target.getBoundingClientRect();
          const outsideRect = outside.getBoundingClientRect();
          return {
            outerWidth: window.outerWidth, outerHeight: window.outerHeight,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            outside: {
              x: outsideRect.x, y: outsideRect.y,
              width: outsideRect.width, height: outsideRect.height
            }
          };
        })()""")
        target_point = physical_target(window, geometry)
        target_rect = physical_element_rect(window, geometry, "target")
        outside_rect = physical_element_rect(window, geometry, "outside")
        outside_point = {
            "x": outside_rect["x"] + outside_rect["width"] // 2,
            "y": outside_rect["y"] + outside_rect["height"] // 2,
        }
        sweep_click_point = {
            "x": target_rect["x"] + target_rect["width"] // 5,
            "y": target_rect["y"] + target_rect["height"] // 2,
        }
        ctypes.windll.user32.SetCursorPos(target_point["x"], target_point["y"])
        left, top, right, bottom = [int(value) for value in window["bbox"]]
        local_target_for_ready = (
            max(0, target_rect["x"] - left),
            max(0, target_rect["y"] - top),
            min(right - left, target_rect["x"] - left + target_rect["width"]),
            min(bottom - top, target_rect["y"] - top + target_rect["height"]),
        )
        # CDP can expose the page before Edge's first compositor frame reaches
        # the desktop. Do not treat the transient dark backing surface as the
        # visual baseline.
        paint_deadline = time.time() + 6
        before = None
        candidate = None
        ready_pixel = None
        while time.time() < paint_deadline:
            candidate = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
            ready_pixel = candidate.crop(local_target_for_ready).resize((1, 1)).convert("RGB").getpixel((0, 0))
            if sum(ready_pixel) / 3 >= 100:
                before = candidate
                break
            time.sleep(0.2)
        if before is None:
            if candidate is not None:
                candidate.save(EVIDENCE_DIR / "not-ready.png")
            (EVIDENCE_DIR / "not-ready.json").write_text(
                json.dumps({
                    "window": window,
                    "geometry": geometry,
                    "targetPointPhysical": target_point,
                    "targetRectPhysical": target_rect,
                    "localTargetCrop": local_target_for_ready,
                    "readyPixel": ready_pixel,
                }, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            raise RuntimeError("edge_fixture_not_visually_ready")
        before_path = EVIDENCE_DIR / "before.png"
        before.save(before_path)

        env = os.environ.copy()
        env["MAGIC_POINTER_USER_DATA_DIR"] = str(runtime)
        env["ELECTRON_ENABLE_LOGGING"] = "1"
        electron_trace = (runtime / "electron-renderer.log").open("w", encoding="utf-8")
        electron = subprocess.Popen(
            [str(ELECTRON), str(ROOT), "--background"],
            cwd=ROOT,
            env=env,
            stdout=electron_trace,
            stderr=subprocess.STDOUT,
        )
        wait_for_log(
            runtime / "electron.log",
            "register configurable hotkey name=wake accelerator=Control+Alt+Shift+F11 ok=true",
            timeout=20,
        )
        ctypes.windll.user32.SetForegroundWindow(int(window["hwnd"]))
        ctypes.windll.user32.SetCursorPos(target_point["x"], target_point["y"])
        time.sleep(0.4)
        press_activation_hotkey()
        log_text = wait_for_log(runtime / "electron.log", "stage renderer state=capsule-text", timeout=30)
        local_target = {
            "x": target_rect["x"] - left,
            "y": target_rect["y"] - top,
            "width": target_rect["width"],
            "height": target_rect["height"],
        }
        sequence_dir = EVIDENCE_DIR / "sequence"
        sequence_dir.mkdir(parents=True, exist_ok=True)
        sequence = []
        sequence_started = time.perf_counter()
        for index in range(20):
            due = sequence_started + (index / 24.0)
            remaining = due - time.perf_counter()
            if remaining > 0:
                time.sleep(remaining)
            frame = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
            frame_path = sequence_dir / f"frame-{index:03d}.png"
            frame.save(frame_path)
            sequence.append((index, frame, frame_path))

        after = sequence[-1][1]
        capsule_path = EVIDENCE_DIR / "capsule-live.png"
        after.save(capsule_path)
        crop_box = (
            max(0, local_target["x"] - 36),
            max(0, local_target["y"] - 44),
            min(after.width, local_target["x"] + local_target["width"] + 52),
            min(after.height, local_target["y"] + local_target["height"] + 44),
        )
        before_crop = before.crop(crop_box).convert("RGB")
        area = max(1, before_crop.width * before_crop.height)
        frame_metrics = []
        for index, frame, frame_path in sequence:
            frame_crop = frame.crop(crop_box).convert("RGB")
            diff = ImageChops.difference(before_crop, frame_crop)
            changed = 0
            blue = 0
            for (dr, dg, db), (r, g, b) in zip(diff.getdata(), frame_crop.getdata()):
                if max(dr, dg, db) >= 12:
                    changed += 1
                if b >= r + 18 and b >= g + 4 and b >= 120:
                    blue += 1

            body_box = (
                max(0, local_target["x"] + 10),
                max(0, local_target["y"] - 24),
                min(frame.width, local_target["x"] + local_target["width"] - 100),
                min(frame.height, local_target["y"] + local_target["height"] + 24),
            )
            body = frame.crop(body_box).convert("RGB")
            active_rows = []
            for y in range(body.height):
                row_blue = 0
                for r, g, b in (body.getpixel((x, y)) for x in range(body.width)):
                    if b >= r + 18 and b >= g + 4 and b >= 120:
                        row_blue += 1
                if row_blue >= 12:
                    active_rows.append(y)
            body_blue_height = (max(active_rows) - min(active_rows) + 1) if active_rows else 0
            frame_metrics.append({
                "index": index,
                "path": str(frame_path),
                "changedRatio": changed / area,
                "blueRatio": blue / area,
                "bodyBlueHeightPhysical": body_blue_height,
            })

        best_metric = max(frame_metrics, key=lambda item: item["blueRatio"])
        band_frame = sequence[best_metric["index"]][1]
        after_path = EVIDENCE_DIR / "sweep-band-live.png"
        band_frame.save(after_path)
        annotated = band_frame.copy()
        draw = ImageDraw.Draw(annotated)
        draw.rectangle(
            (
                local_target["x"] - 2,
                local_target["y"] - 2,
                local_target["x"] + local_target["width"] + 2,
                local_target["y"] + local_target["height"] + 2,
            ),
            outline="#ff3b30",
            width=2,
        )
        annotated_path = EVIDENCE_DIR / "sweep-band-annotated.png"
        annotated.save(annotated_path)

        changed_ratio = best_metric["changedRatio"]
        blue_ratio = best_metric["blueRatio"]
        thickness_limit = max(12, round(target_rect["height"] * 0.56))
        thickness_passed = (
            best_metric["bodyBlueHeightPhysical"] > 0
            and best_metric["bodyBlueHeightPhysical"] <= thickness_limit
        )
        visual_passed = changed_ratio >= 0.008 and blue_ratio >= 0.005 and thickness_passed

        # The non-interactive sweep itself must not become a transparent click
        # blocker merely because the nearby text capsule is interactive.
        click_at(sweep_click_point["x"], sweep_click_point["y"])
        sweep_clicks = wait_for_sweep_click(page["webSocketDebuggerUrl"], 1)
        sweep_click_through_passed = sweep_clicks == 1

        # A point outside the Stage's native shaped regions must also click
        # through to the browser while the temporary surface remains available.
        dismiss_before = log_text.count("dismissTemporarySurfaces")
        click_at(outside_point["x"], outside_point["y"])
        outside_clicks = wait_for_outside_click(page["webSocketDebuggerUrl"], 1)
        click_through_passed = outside_clicks == 1

        # The click gives focus back to the browser. Escape still has to dismiss
        # globally, which is the accidental-activation escape hatch.
        dismiss_before_escape = dismiss_before
        press_escape()
        escape_log = wait_for_log_occurrences(
            runtime / "electron.log",
            "dismissTemporarySurfaces",
            dismiss_before_escape + 1,
            timeout=8,
        )
        time.sleep(0.35)
        after_escape = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        escape_path = EVIDENCE_DIR / "after-escape.png"
        after_escape.save(escape_path)
        escaped_crop = after_escape.crop(crop_box).convert("RGB")
        escape_diff = ImageChops.difference(before_crop, escaped_crop)
        escape_changed = sum(
            1 for pixel in escape_diff.getdata() if max(pixel) >= 12
        )
        escape_changed_ratio = escape_changed / area
        escape_dismiss_passed = escape_changed_ratio < 0.08
        passed = (
            visual_passed
            and sweep_click_through_passed
            and click_through_passed
            and escape_dismiss_passed
        )

        evidence = {
            "schemaVersion": 1,
            "passed": passed,
            "fixture": str(FIXTURE),
            "selectionVisual": "sweep_band",
            "targetPointPhysical": target_point,
            "targetRectPhysical": target_rect,
            "window": window,
            "changedRatioNearTarget": round(changed_ratio, 6),
            "blueRatioNearTarget": round(blue_ratio, 6),
            "bestSweepFrameIndex": best_metric["index"],
            "sweepBodyBlueHeightPhysical": best_metric["bodyBlueHeightPhysical"],
            "sweepBodyHeightLimitPhysical": thickness_limit,
            "sweepThicknessPassed": thickness_passed,
            "visualPassed": visual_passed,
            "sweepClickPointPhysical": sweep_click_point,
            "sweepClicksObserved": sweep_clicks,
            "sweepClickThroughPassed": sweep_click_through_passed,
            "outsidePointPhysical": outside_point,
            "outsideClicksObserved": outside_clicks,
            "clickThroughPassed": click_through_passed,
            "escapeChangedRatioNearTarget": round(escape_changed_ratio, 6),
            "escapeDismissPassed": escape_dismiss_passed,
            "before": str(before_path),
            "screenshot": str(after_path),
            "capsuleScreenshot": str(capsule_path),
            "sequenceFrames": [metric["path"] for metric in frame_metrics],
            "sequenceMetrics": [
                {
                    **metric,
                    "changedRatio": round(metric["changedRatio"], 6),
                    "blueRatio": round(metric["blueRatio"], 6),
                }
                for metric in frame_metrics
            ],
            "annotatedScreenshot": str(annotated_path),
            "afterEscapeScreenshot": str(escape_path),
            "runtimeLogEvidence": [
                line for line in escape_log.splitlines()
                if "selection session capture done" in line or "stage renderer state=" in line
                or "dismissTemporarySurfaces" in line
            ][-8:],
        }
        evidence_path = EVIDENCE_DIR / "evidence.json"
        evidence_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(evidence, ensure_ascii=True))
        return 0 if passed else 1
    finally:
        stop_process_tree(electron)
        if electron_trace is not None:
            electron_trace.close()
        stop_process_tree(edge)


if __name__ == "__main__":
    raise SystemExit(main())
