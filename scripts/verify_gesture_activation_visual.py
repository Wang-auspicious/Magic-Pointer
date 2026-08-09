from __future__ import annotations

import ctypes
import json
import os
import subprocess
import tempfile
import time
from ctypes import wintypes
from datetime import datetime
from pathlib import Path

from PIL import ImageChops, ImageGrab

from onboarding_fixture import write_ready_onboarding_marker
from verify_stage_selection_visual import (
    EDGE,
    ELECTRON,
    FIXTURE,
    PORT,
    ROOT,
    enable_dpi_awareness,
    evaluate,
    physical_element_rect,
    stop_process_tree,
    wait_for_log,
    wait_for_page,
    wait_for_window,
)

ACTIVATION_MODE = os.environ.get("MAGIC_POINTER_VERIFY_ACTIVATION", "hotkey").strip().lower()
if ACTIVATION_MODE not in {"hotkey", "wiggle"}:
    raise RuntimeError("unsupported_activation_mode")
INPUT_MODE = os.environ.get("MAGIC_POINTER_VERIFY_INPUT_MODE", "text").strip().lower()
if INPUT_MODE not in {"text", "voice"}:
    raise RuntimeError("unsupported_input_mode")
EARLY_DRAG = os.environ.get("MAGIC_POINTER_VERIFY_EARLY_DRAG", "0").strip() == "1"
SOURCE_ENTRY = os.environ.get("MAGIC_POINTER_VERIFY_SOURCE_ENTRY", "0").strip() == "1"
EARLY_SUFFIX = "-early-hold" if EARLY_DRAG else ""
EVIDENCE_DIR = ROOT / "data" / "runtime" / (
    f"gesture-activation-{ACTIVATION_MODE}-{INPUT_MODE}{EARLY_SUFFIX}-20260729"
)


class CursorPoint(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class CursorInfo(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("hCursor", wintypes.HANDLE),
        ("ptScreenPos", CursorPoint),
    ]


def cursor_handle() -> int:
    info = CursorInfo(cbSize=ctypes.sizeof(CursorInfo))
    if not ctypes.windll.user32.GetCursorInfo(ctypes.byref(info)):
        raise ctypes.WinError()
    return int(info.hCursor or 0)


def press_activation_hotkey() -> None:
    user32 = ctypes.windll.user32
    keys = [0x11, 0x12, 0x10, 0x7A]  # Control + Alt + Shift + F11
    for key in keys:
        user32.keybd_event(key, 0, 0, 0)
    time.sleep(0.08)
    for key in reversed(keys):
        user32.keybd_event(key, 0, 0x0002, 0)


def perform_three_stroke_wiggle(origin: tuple[int, int]) -> None:
    user32 = ctypes.windll.user32
    x, y = origin
    anchors = [(x - 72, y - 22), (x + 72, y + 24), (x - 72, y - 18)]
    current = origin
    for target in anchors:
        for index in range(1, 5):
            ratio = index / 4
            user32.SetCursorPos(
                round(current[0] + (target[0] - current[0]) * ratio),
                round(current[1] + (target[1] - current[1]) * ratio),
            )
            time.sleep(0.018)
        current = target


def force_foreground_window(hwnd: int) -> None:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.ShowWindow(int(hwnd), 9)  # SW_RESTORE
    # Foreground-lock rules can reject SetForegroundWindow in unattended
    # runs. Keep the disposable fixture topmost for the short verification so
    # unrelated user windows cannot invalidate the before/after evidence.
    user32.SetWindowPos(int(hwnd), -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
    current_foreground = int(user32.GetForegroundWindow() or 0)
    current_thread = int(kernel32.GetCurrentThreadId())
    foreground_thread = int(user32.GetWindowThreadProcessId(current_foreground, None) or 0)
    target_thread = int(user32.GetWindowThreadProcessId(int(hwnd), None) or 0)
    attached = []
    for thread_id in {foreground_thread, target_thread}:
        if thread_id and thread_id != current_thread:
            if user32.AttachThreadInput(current_thread, thread_id, True):
                attached.append(thread_id)
    try:
        user32.BringWindowToTop(int(hwnd))
        user32.SetForegroundWindow(int(hwnd))
        user32.SetFocus(int(hwnd))
    finally:
        for thread_id in attached:
            user32.AttachThreadInput(current_thread, thread_id, False)
    time.sleep(0.16)


def changed_ratio(before, after, bbox=None) -> float:
    left = before.crop(bbox) if bbox else before
    right = after.crop(bbox) if bbox else after
    gray = ImageChops.difference(left.convert("RGB"), right.convert("RGB")).convert("L")
    changed = sum(1 for value in gray.getdata() if value >= 10)
    return changed / max(1, gray.width * gray.height)


def blue_ratio(image, bbox) -> float:
    crop = image.crop(bbox).convert("RGB")
    blue = sum(
        1 for red, green, value in crop.getdata()
        if value >= 125 and value >= red + 14 and value >= green + 4
    )
    return blue / max(1, crop.width * crop.height)


def log_time_ms(log_text: str, marker: str) -> float | None:
    line = next((item for item in log_text.splitlines() if marker in item), None)
    if not line:
        return None
    try:
        return datetime.fromisoformat(line.split(" ", 1)[0].replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def drag_and_capture(start, end, capture_bbox, steps=20):
    user32 = ctypes.windll.user32
    foreground_samples = []
    cursor_samples = []
    user32.SetCursorPos(int(start[0]), int(start[1]))
    time.sleep(0.08)
    cursor_samples.append({"phase": "before_pointer_down", "handle": cursor_handle()})
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.04)
    foreground_samples.append({
        "phase": "pointer_down",
        "hwnd": int(user32.GetForegroundWindow() or 0),
    })
    cursor_samples.append({"phase": "pointer_down", "handle": cursor_handle()})
    middle = None
    for index in range(1, steps + 1):
        ratio = index / steps
        x = round(start[0] + (end[0] - start[0]) * ratio)
        y = round(start[1] + (end[1] - start[1]) * ratio)
        user32.SetCursorPos(x, y)
        time.sleep(0.018)
        if index == steps // 2:
            # Let Electron consume the native mousemove queue and paint the
            # next animation frame before sampling the transparent overlay.
            time.sleep(0.08)
            middle = ImageGrab.grab(bbox=capture_bbox, all_screens=True)
            foreground_samples.append({
                "phase": "drawing",
                "hwnd": int(user32.GetForegroundWindow() or 0),
            })
            cursor_samples.append({"phase": "drawing", "handle": cursor_handle()})
    foreground_samples.append({
        "phase": "before_release",
        "hwnd": int(user32.GetForegroundWindow() or 0),
    })
    cursor_samples.append({"phase": "before_release", "handle": cursor_handle()})
    user32.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(0.08)
    foreground_samples.append({
        "phase": "after_release",
        "hwnd": int(user32.GetForegroundWindow() or 0),
    })
    cursor_samples.append({"phase": "after_release", "handle": cursor_handle()})
    return middle, foreground_samples, cursor_samples


def main() -> int:
    enable_dpi_awareness()
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    safe_temp_root = Path(tempfile.gettempdir()).resolve()
    run_root = Path(tempfile.mkdtemp(prefix="magic-pointer-gesture-")).resolve()
    if run_root.parent != safe_temp_root or not run_root.name.startswith("magic-pointer-gesture-"):
        raise RuntimeError("unsafe_temp_root")
    profile = run_root / "edge-profile"
    runtime = run_root / "runtime"
    profile.mkdir()
    runtime.mkdir()
    write_ready_onboarding_marker(runtime)
    (runtime / "fabric-settings.json").write_text(json.dumps({
        "schema_version": 1,
        "activation": {
            "wake_mode": "wiggle" if ACTIVATION_MODE == "wiggle" else "hotkey",
            "wiggle_enabled": ACTIVATION_MODE == "wiggle",
            "fallback_hotkey_enabled": ACTIVATION_MODE == "hotkey",
            "fallback_hotkey": "Control+Alt+Shift+F11",
            "gesture_arm_delay_ms": 180,
            "gesture_timeout_ms": 5000,
        },
        "shortcuts": {"wake": "Control+Alt+Shift+F11"},
        "interaction": {"default_input_mode": INPUT_MODE},
        "appearance": {
            "selection_visual": "sweep_band",
            "gesture_line_style": "demo6_band",
            "gesture_line_width_dip": 22,
        },
        "connections": {
            "browser_devtools_enabled": True,
            "browser_devtools_endpoints": [f"http://127.0.0.1:{PORT}"],
        },
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    edge = None
    electron = None
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
            "--window-position=120,80",
            "--window-size=1100,880",
            f"--app={FIXTURE.resolve().as_uri()}",
        ])
        page = wait_for_page()
        window = wait_for_window()
        geometry = evaluate(page["webSocketDebuggerUrl"], """(() => {
          const rect = document.getElementById('target').getBoundingClientRect();
          return {
            outerWidth: window.outerWidth, outerHeight: window.outerHeight,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        })()""")
        target = physical_element_rect(window, geometry, "target")
        left, top, right, bottom = [int(value) for value in window["bbox"]]
        capture_bbox = (left, top, right, bottom)
        target_local = (
            target["x"] - left,
            target["y"] - top,
            target["x"] - left + target["width"],
            target["y"] - top + target["height"],
        )
        start = (target["x"] + 24, target["y"] + target["height"] // 2)
        end = (target["x"] + target["width"] - 24, target["y"] + target["height"] // 2 + 4)

        env = os.environ.copy()
        env["MAGIC_POINTER_USER_DATA_DIR"] = str(runtime)
        if ACTIVATION_MODE == "wiggle":
            env["MAGIC_POINTER_WIGGLE_TRACE"] = "1"
        electron_trace = (runtime / "electron-renderer.log").open("w", encoding="utf-8")
        electron = subprocess.Popen(
            [
                str(ELECTRON),
                str(ROOT / "electron" / "main.js") if SOURCE_ENTRY else str(ROOT),
                "--background",
            ],
            cwd=ROOT,
            env=env,
            stdout=electron_trace,
            stderr=subprocess.STDOUT,
        )
        startup_pattern = (
            "pointer activation polling=true wiggle=true"
            if ACTIVATION_MODE == "wiggle"
            else "accelerator=Control+Alt+Shift+F11 ok=true"
        )
        wait_for_log(runtime / "electron.log", startup_pattern, 20)
        # The native gesture is intentionally brief. Do not fire it while the
        # disposable Electron process is still cold-loading both renderers;
        # the production app prewarms these surfaces before user interaction.
        wait_for_log(runtime / "electron.log", "stage renderer ready", 20)
        wait_for_log(runtime / "electron.log", "overlay renderer ready", 20)
        force_foreground_window(int(window["hwnd"]))
        if int(ctypes.windll.user32.GetForegroundWindow() or 0) != int(window["hwnd"]):
            raise RuntimeError("fixture_foreground_lock_failed")
        ctypes.windll.user32.SetCursorPos(*start)
        time.sleep(0.35)
        before = ImageGrab.grab(bbox=capture_bbox, all_screens=True)
        before.save(EVIDENCE_DIR / "before.png")
        if ACTIVATION_MODE == "wiggle":
            perform_three_stroke_wiggle(start)
            wait_for_log(runtime / "electron.log", "wiggle accepted metrics=", 10)
        else:
            press_activation_hotkey()
        if EARLY_DRAG:
            # Regression: a user may press and hold immediately after the wake
            # gesture, before the configured arm grace elapses. The stroke
            # must not disappear merely because its pointerdown was early.
            armed = ImageGrab.grab(bbox=capture_bbox, all_screens=True)
            armed.save(EVIDENCE_DIR / "armed-invisible.png")
            drawing, foreground_samples, cursor_samples = drag_and_capture(
                start, end, capture_bbox, steps=28,
            )
        ready_log = wait_for_log(runtime / "electron.log", "gesture-ready OK", 10)

        if not EARLY_DRAG:
            armed = ImageGrab.grab(bbox=capture_bbox, all_screens=True)
            armed.save(EVIDENCE_DIR / "armed-invisible.png")
            drawing, foreground_samples, cursor_samples = drag_and_capture(start, end, capture_bbox)
        if drawing is None:
            raise RuntimeError("drawing_frame_missing")
        drawing.save(EVIDENCE_DIR / "drawing.png")
        completed_log = wait_for_log(runtime / "electron.log", "selection gesture completed", 10)
        capsule_state = f"stage renderer state=capsule-{INPUT_MODE}"
        capsule_log = wait_for_log(runtime / "electron.log", capsule_state, 30)
        # The state transition starts the configured spawn animation at
        # opacity zero. Sample after it has visibly settled.
        time.sleep(0.82)
        capsule = ImageGrab.grab(bbox=capture_bbox, all_screens=True)
        capsule.save(EVIDENCE_DIR / "capsule-after-release.png")
        grounding_log = wait_for_log(runtime / "electron.log", "selection session capture done", 30)
        expired_error_absent = "当前 THIS 已过期" not in grounding_log

        top_left = (0, 0, min(360, before.width), min(120, before.height))
        release_local_x = end[0] - left
        release_local_y = end[1] - top
        capsule_near = (
            max(0, release_local_x - 280),
            max(0, release_local_y - 130),
            min(before.width, release_local_x + 320),
            min(before.height, release_local_y + 160),
        )
        armed_change = changed_ratio(before, armed)
        ghost_change = changed_ratio(before, armed, top_left)
        drawing_blue = blue_ratio(drawing, target_local)
        capsule_blue = blue_ratio(capsule, capsule_near)
        before_capsule_state = "stage renderer state=" in ready_log
        ordered = [
            grounding_log.find("gesture-ready OK"),
            grounding_log.find("selection gesture lease"),
            grounding_log.find("selection gesture stroke committed"),
            grounding_log.find("selection gesture completed"),
            grounding_log.find("selection session capture start"),
            grounding_log.find(capsule_state),
        ]
        order_passed = all(value >= 0 for value in ordered) and ordered == sorted(ordered)
        release_at = log_time_ms(grounding_log, "selection gesture completed")
        capsule_at = log_time_ms(grounding_log, capsule_state)
        release_to_capsule_ms = None if release_at is None or capsule_at is None else capsule_at - release_at
        grounding_source_passed = (
            "selection session capture done" in grounding_log
            and "app=" in grounding_log
            and "app=none" not in grounding_log
        )
        foreground_samples.extend([
            {
                "phase": "capsule",
                "hwnd": int(ctypes.windll.user32.GetForegroundWindow() or 0),
            },
        ])
        foreground_invariant = all(
            sample["hwnd"] == int(window["hwnd"])
            for sample in foreground_samples
            if sample["phase"] != "capsule"
        )
        captured_cursor_handles = {
            sample["handle"]
            for sample in cursor_samples
            if sample["phase"] != "after_release"
        }
        cursor_handle_invariant = len(captured_cursor_handles) == 1 and 0 not in captured_cursor_handles
        passed = (
            armed_change <= 0.002
            and ghost_change <= 0.002
            and not before_capsule_state
            and drawing_blue >= 0.004
            and capsule_blue >= 0.002
            and order_passed
            and release_to_capsule_ms is not None
            and release_to_capsule_ms <= 450
            and grounding_source_passed
            and expired_error_absent
            and foreground_invariant
            and cursor_handle_invariant
        )
        evidence = {
            "schemaVersion": 1,
            "activationMode": ACTIVATION_MODE,
            "inputMode": INPUT_MODE,
            "sourceEntry": SOURCE_ENTRY,
            "passed": passed,
            "armedChangedRatio": round(armed_change, 6),
            "topLeftGhostChangedRatio": round(ghost_change, 6),
            "stageVisibleBeforeDrawing": before_capsule_state,
            "drawingBlueRatio": round(drawing_blue, 6),
            "capsuleNearReleaseBlueRatio": round(capsule_blue, 6),
            "eventOrderPassed": order_passed,
            "releaseToCapsuleMs": round(release_to_capsule_ms, 1) if release_to_capsule_ms is not None else None,
            "groundingSourcePassed": grounding_source_passed,
            "expiredErrorAbsent": expired_error_absent,
            "foregroundInvariant": foreground_invariant,
            "foregroundSamples": foreground_samples,
            "cursorHandleInvariant": cursor_handle_invariant,
            "cursorSamples": cursor_samples,
            "releasePointPhysical": {"x": end[0], "y": end[1]},
            "targetRectPhysical": target,
            "fixtureWindow": window,
            "screenshots": {
                "before": str(EVIDENCE_DIR / "before.png"),
                "armed": str(EVIDENCE_DIR / "armed-invisible.png"),
                "drawing": str(EVIDENCE_DIR / "drawing.png"),
                "capsule": str(EVIDENCE_DIR / "capsule-after-release.png"),
            },
            "runtimeLogEvidence": [
                line for line in grounding_log.splitlines()
                if "selection gesture" in line or "selection session capture" in line
                or "stage renderer state=" in line
            ][-12:],
        }
        (EVIDENCE_DIR / "evidence.json").write_text(
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
