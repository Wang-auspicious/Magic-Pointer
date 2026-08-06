from __future__ import annotations

"""Real, isolated desktop acceptance evidence for N20 resident local voice.

This is deliberately an external acceptance harness.  It neither injects a
renderer nor calls the worker directly: every dictation is started through the
configured global hotkey and is observed through the app's own audit/log files.
"""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket
from PIL import ImageGrab

from onboarding_fixture import write_ready_onboarding_marker

ROOT = Path(__file__).resolve().parents[1]
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
ELECTRON = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
FIXTURE = ROOT / "tests" / "fixtures" / "stage_sweep_visual.html"
EVIDENCE_DIR = ROOT / "data" / "runtime" / "n20-resident-20260728"
PORT = 9362
WINDOW_TITLE = "Magic Pointer Sweep Visual Fixture"
HOTKEY = "Control+Alt+Shift+F11"
RESULT_KEYS = {
    "schemaVersion", "passedFunctional", "passedPerformance", "rounds",
    "reusedCount", "workerLifecycleCount", "latencyMs", "latencyP50Ms",
    "memoryMb", "idleUnloadObserved", "reloadObserved", "auditPrivacyPassed",
    "screenshots", "failureCodes",
}


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
        text = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, text, length + 1)
        rect = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            windows.append({"hwnd": int(hwnd), "title": text.value,
                            "bbox": [rect.left, rect.top, rect.right, rect.bottom]})
        return True

    user32.EnumWindows(callback, 0)
    return windows


def wait_until(label: str, predicate, timeout: float) -> object:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception as exc:  # an external process can be in transition
            last_error = exc
        time.sleep(0.18)
    suffix = f":{type(last_error).__name__}" if last_error else ""
    raise RuntimeError(f"deadline:{label}{suffix}")


def cdp_page() -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=1) as response:
        pages = json.loads(response.read().decode("utf-8"))
    return next(item for item in pages if WINDOW_TITLE in str(item.get("title") or ""))


def cdp_value(websocket_url: str, expression: str):
    conn = websocket.create_connection(websocket_url, timeout=4, origin="http://127.0.0.1")
    try:
        conn.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                              "params": {"expression": expression, "returnByValue": True}}))
        while True:
            response = json.loads(conn.recv())
            if response.get("id") == 1:
                return response.get("result", {}).get("result", {}).get("value")
    finally:
        conn.close()


def fixture_geometry(page: dict) -> dict:
    # Read-only CDP: never changes selection, focus, click counters, or Stage.
    return cdp_value(page["webSocketDebuggerUrl"], """(() => {
      const node = document.getElementById('target');
      const r = node.getBoundingClientRect();
      return { outerWidth: window.outerWidth, outerHeight: window.outerHeight,
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        target: {x:r.x,y:r.y,width:r.width,height:r.height} };
    })()""")


def find_fixture_window() -> dict | None:
    return next((item for item in visible_windows() if WINDOW_TITLE in item["title"]), None)


def physical_target(window: dict, geometry: dict) -> tuple[int, int]:
    left, top, right, bottom = [float(x) for x in window["bbox"]]
    side = max(0.0, (float(geometry["outerWidth"]) - float(geometry["innerWidth"])) / 2)
    chrome_top = max(0.0, float(geometry["outerHeight"]) - float(geometry["innerHeight"]) - side)
    scale_x = (right - left) / max(1.0, float(geometry["outerWidth"]))
    scale_y = (bottom - top) / max(1.0, float(geometry["outerHeight"]))
    target = geometry["target"]
    return (
        round(left + (side + float(target["x"]) + float(target["width"]) * .90) * scale_x),
        round(top + (chrome_top + float(target["y"]) + float(target["height"]) / 2) * scale_y),
    )


def wait_for_real_paint(window: dict, point: tuple[int, int]) -> None:
    left, top, right, bottom = [int(x) for x in window["bbox"]]
    def painted():
        image = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        px = image.getpixel((max(0, point[0] - left), max(0, point[1] - top)))[:3]
        return sum(px) / 3 >= 90
    wait_until("edge_first_compositor_frame", painted, 8)


def key_press(vk: int, up: bool = False) -> None:
    ctypes.windll.user32.keybd_event(vk, 0, 0x0002 if up else 0, 0)


def press_hotkey() -> None:
    keys = [0x11, 0x12, 0x10, 0x7A]  # Ctrl + Alt + Shift + F11
    for key in keys:
        key_press(key)
    time.sleep(.08)
    for key in reversed(keys):
        key_press(key, True)


def set_cursor(point: tuple[int, int]) -> None:
    ctypes.windll.user32.SetCursorPos(int(point[0]), int(point[1]))


def primary_button(down: bool) -> None:
    ctypes.windll.user32.mouse_event(0x0002 if down else 0x0004, 0, 0, 0, 0)


def draw_selection(end: tuple[int, int]) -> None:
    """Drive the same freehand primary-button gesture used by the product."""
    start = (end[0] - 260, end[1] - 2)
    set_cursor(start)
    time.sleep(.08)
    primary_button(True)
    try:
        for index in range(1, 17):
            ratio = index / 16
            set_cursor((
                round(start[0] + (end[0] - start[0]) * ratio),
                round(start[1] + (end[1] - start[1]) * ratio),
            ))
            time.sleep(.018)
    finally:
        primary_button(False)


def press_escape() -> None:
    key_press(0x1B)
    time.sleep(.05)
    key_press(0x1B, True)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def audit_rows(path: Path) -> list[dict]:
    rows = []
    for raw in read_text(path).splitlines():
        try:
            item = json.loads(raw)
            if item.get("type") == "voice.residency" and isinstance(item.get("data"), dict):
                rows.append(item["data"])
        except json.JSONDecodeError:
            continue
    return rows


def rows_for(rows: list[dict], event_type: str) -> list[dict]:
    return [row for row in rows if row.get("eventType") == event_type]


def stop_own_tree(process: subprocess.Popen | None) -> None:
    if process is not None and process.poll() is None:
        subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                       capture_output=True, check=False)


def default_settings() -> dict:
    source = "const s=require('./electron/settings_store').defaultSettings();process.stdout.write(JSON.stringify(s));"
    completed = subprocess.run(["node", "-e", source], cwd=ROOT, capture_output=True,
                               text=True, encoding="utf-8", errors="strict",
                               check=True, timeout=15)
    return json.loads(completed.stdout)


def write_isolated_settings(runtime: Path) -> None:
    settings = default_settings()
    settings["activation"].update({
        "wake_mode": "hotkey",
        "wiggle_enabled": False,
        "fallback_hotkey_enabled": True,
        "fallback_hotkey": HOTKEY,
    })
    settings["interaction"].update({
        "default_input_mode": "voice", "voice_start_strategy": "auto",
        "voice_auto_submit": False, "voice_resident_enabled": True,
        "voice_memory_limit_mb": 1024, "voice_idle_unload_ms": 10000,
    })
    settings["appearance"]["selection_visual"] = "sweep_band"
    settings["shortcuts"]["wake"] = HOTKEY
    # Preserve the generated complete schema and validate it using production's
    # public store before Electron sees the isolated directory.
    candidate = runtime / "fabric-settings.json"
    candidate.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    source = "const S=require('./electron/settings_store').ElectronSettingsStore;new S(process.argv[1]).load();"
    subprocess.run(["node", "-e", source, str(candidate)], cwd=ROOT, check=True, timeout=15)
    write_ready_onboarding_marker(runtime)


def synthesize_wav(path: Path) -> None:
    # This does not access a microphone.  The text is intentionally never
    # copied into any evidence JSON or audit excerpt.
    escaped_path = str(path).replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"$s.SetOutputToWaveFile('{escaped_path}');"
        "$s.Speak('Magic Pointer local voice test');$s.Dispose()"
    )
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], check=True, timeout=30)
    if not path.is_file() or path.stat().st_size < 1000:
        raise RuntimeError("synthesized_wav_invalid")


def wait_log(path: Path, marker: str, after: int = 0, timeout: float = 25) -> str:
    def check():
        text = read_text(path)
        return text if text.count(marker) > after else None
    return wait_until(f"log:{marker}", check, timeout)


def wait_stage_text(log_path: Path, prior_count: int, timeout: float = 45) -> None:
    wait_log(log_path, "stage renderer state=capsule-text", prior_count, timeout)


def start_voice_selection(log_path: Path, point: tuple[int, int]) -> None:
    """Wake, draw and release before the auto voice strategy is expected to run."""
    ready_count = read_text(log_path).count("gesture-ready OK")
    completed_count = read_text(log_path).count("selection gesture completed")
    voice_count = read_text(log_path).count("stage renderer state=capsule-voice")
    capture_count = read_text(log_path).count("selection session capture done")
    press_hotkey()
    wait_log(log_path, "gesture-ready OK", ready_count, 15)
    draw_selection(point)
    wait_log(log_path, "selection gesture completed", completed_count, 15)
    wait_log(log_path, "stage renderer state=capsule-voice", voice_count, 20)
    wait_log(log_path, "selection session capture done", capture_count, 45)


def take_screenshot(window: dict, target: Path) -> None:
    left, top, right, bottom = [int(x) for x in window["bbox"]]
    ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True).save(target)


def privacy_ok(audit_path: Path, wav: Path) -> bool:
    raw = read_text(audit_path)
    prohibited = [
        "Magic Pointer local voice test", str(wav), "contextPath", WINDOW_TITLE,
        str(Path(r"C:\Users\zjz65\.cache\whisper\tiny.pt")), "tiny.pt",
    ]
    return audit_path.exists() and not any(token in raw for token in prohibited)


def evidence_payload(**updates) -> dict:
    value = {
        "schemaVersion": 1, "passedFunctional": False, "passedPerformance": False,
        "rounds": 0, "reusedCount": 0, "workerLifecycleCount": 0, "latencyMs": [],
        "latencyP50Ms": None, "memoryMb": None, "idleUnloadObserved": False,
        "reloadObserved": False, "auditPrivacyPassed": False, "screenshots": [],
        "failureCodes": [],
    }
    value.update(updates)
    if set(value) != RESULT_KEYS:
        raise RuntimeError("evidence_schema_violation")
    return value


def run_worker_only() -> int:
    # Explicitly non-acceptance diagnostic: retained only to make local Whisper
    # startup diagnosis possible without touching the user's microphone.
    wav = EVIDENCE_DIR / "worker-only.wav"
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    synthesize_wav(wav)
    return subprocess.run([sys.executable, "scripts/local_voice_worker.py", "--model", "tiny",
                           "--memory-limit-mb", "1024", "--idle-unload-ms", "10000"],
                          cwd=ROOT, timeout=3).returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker-only", action="store_true")
    args = parser.parse_args()
    if args.worker_only:
        return run_worker_only()

    failures: list[str] = []
    screenshot_names: list[str] = []
    runtime = EVIDENCE_DIR / "isolated-user-data"
    edge_profile = EVIDENCE_DIR / "isolated-edge-profile"
    wav = EVIDENCE_DIR / "synthesized-input.wav"
    evidence_path = EVIDENCE_DIR / "evidence.json"
    edge: subprocess.Popen | None = None
    electron: subprocess.Popen | None = None
    trace = None
    metrics = evidence_payload()
    try:
        if not EDGE.is_file():
            raise RuntimeError("edge_missing")
        if not ELECTRON.is_file():
            raise RuntimeError("electron_missing")
        enable_dpi_awareness()
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        # These paths are wholly inside the explicitly sanctioned evidence root.
        shutil.rmtree(runtime, ignore_errors=True)
        shutil.rmtree(edge_profile, ignore_errors=True)
        runtime.mkdir()
        edge_profile.mkdir()
        write_isolated_settings(runtime)
        synthesize_wav(wav)

        edge = subprocess.Popen([
            str(EDGE), f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
            "--force-device-scale-factor=2", f"--user-data-dir={edge_profile}",
            "--no-first-run", "--no-default-browser-check", "--disable-sync",
            "--window-position=120,80", "--window-size=1100,880", FIXTURE.resolve().as_uri(),
        ])
        page = wait_until("edge_fixture_cdp", cdp_page, 20)
        window = wait_until("edge_fixture_hwnd", find_fixture_window, 20)
        point = physical_target(window, fixture_geometry(page))
        wait_for_real_paint(window, point)

        env = os.environ.copy()
        env.update({
            "MAGIC_POINTER_USER_DATA_DIR": str(runtime),
            "MAGIC_POINTER_VOICE_INPUT_WAV": str(wav),
            "ELECTRON_ENABLE_LOGGING": "1",
        })
        trace = (runtime / "electron-stdio.log").open("w", encoding="utf-8")
        electron = subprocess.Popen([str(ELECTRON), str(ROOT), "--background"], cwd=ROOT,
                                    env=env, stdout=trace, stderr=subprocess.STDOUT)
        log_path = runtime / "electron.log"
        audit_path = runtime / "fabric-audit.jsonl"
        # Worker readiness, not merely app readiness, is the precondition.
        wait_until("resident_worker_ready", lambda: bool(rows_for(audit_rows(audit_path), "voice.ready")), 90)

        finals_before = 0
        for round_index in range(1, 6):
            ctypes.windll.user32.SetForegroundWindow(int(window["hwnd"]))
            ctypes.windll.user32.SetCursorPos(*point)
            time.sleep(.35)
            text_count = read_text(log_path).count("stage renderer state=capsule-text")
            start_voice_selection(log_path, point)
            wait_stage_text(log_path, text_count, 55)
            rows = audit_rows(audit_path)
            finals = rows_for(rows, "voice.final")
            wait_until(f"voice_final_round_{round_index}",
                       lambda: len(rows_for(audit_rows(audit_path), "voice.final")) > finals_before, 8)
            finals_before += 1
            if round_index in (1, 2):
                name = f"round-{round_index}.png"
                take_screenshot(window, EVIDENCE_DIR / name)
                screenshot_names.append(name)
            press_escape()
            time.sleep(.55)

        rows = audit_rows(audit_path)
        finals = rows_for(rows, "voice.final")
        latencies = [int(row["latencyMs"]) for row in finals[:5]
                     if isinstance(row.get("latencyMs"), (int, float))]
        if len(latencies) != 5:
            failures.append("missing_five_final_latencies")
        initial_reused = sum(row.get("reused") is True for row in finals[:5])
        ready_false = [row for row in rows_for(rows, "voice.ready") if row.get("reused") is False]
        memory_values = [row.get("measuredMemoryMb") for row in rows
                         if isinstance(row.get("measuredMemoryMb"), (int, float))]
        p50 = statistics.median(latencies) if len(latencies) == 5 else None

        # No status command is sent in this idle interval.  Its only observed
        # signal is the resident worker's own idle-timeout audit event.
        press_escape()
        wait_until("idle_timeout_unloaded", lambda: any(
            row.get("eventType") == "voice.idle_timeout" and row.get("outcome") == "completed"
            for row in audit_rows(audit_path)), 16)
        idle_observed = True

        ctypes.windll.user32.SetForegroundWindow(int(window["hwnd"]))
        ctypes.windll.user32.SetCursorPos(*point)
        time.sleep(.35)
        text_count = read_text(log_path).count("stage renderer state=capsule-text")
        before_reload_final = len(rows_for(audit_rows(audit_path), "voice.final"))
        start_voice_selection(log_path, point)
        wait_stage_text(log_path, text_count, 55)
        wait_until("reload_final", lambda: len(rows_for(audit_rows(audit_path), "voice.final")) > before_reload_final, 8)
        press_escape()
        time.sleep(.4)

        rows = audit_rows(audit_path)
        finals = rows_for(rows, "voice.final")
        reload_final = finals[-1] if len(finals) >= 6 else {}
        lifecycle = len([row for row in rows_for(rows, "voice.ready") if row.get("reused") is False])
        reload_observed = reload_final.get("reused") is False and lifecycle >= 2
        if initial_reused < 4:
            failures.append("resident_reuse_not_observed")
        if not reload_observed:
            failures.append("resident_reload_not_observed")
        audit_private = privacy_ok(audit_path, wav)
        if not audit_private:
            failures.append("audit_privacy_violation")
        if p50 is None:
            failures.append("latency_p50_unavailable")
        elif p50 >= 800:
            failures.append("performance_p50_ge_800ms")
        functional = (len(finals) >= 6 and initial_reused >= 4 and idle_observed
                      and reload_observed and audit_private and not any(
                          code in failures for code in ("missing_five_final_latencies", "resident_reuse_not_observed",
                                                        "resident_reload_not_observed", "audit_privacy_violation")))
        metrics = evidence_payload(
            passedFunctional=functional,
            passedPerformance=bool(p50 is not None and p50 < 800),
            rounds=5,
            reusedCount=initial_reused,
            workerLifecycleCount=lifecycle,
            latencyMs=latencies,
            latencyP50Ms=p50,
            memoryMb=max(memory_values) if memory_values else None,
            idleUnloadObserved=idle_observed,
            reloadObserved=reload_observed,
            auditPrivacyPassed=audit_private,
            screenshots=screenshot_names,
            failureCodes=failures,
        )
    except Exception as exc:
        code = str(exc).replace("\n", " ")[:160]
        failures.append(code)
        metrics = evidence_payload(**{**metrics, "failureCodes": failures,
                                      "screenshots": screenshot_names})
    finally:
        # Evidence is emitted even on failures and cleanup is restricted to the
        # two roots launched above, never a global browser/application kill.
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
        if trace is not None:
            trace.close()
        stop_own_tree(electron)
        stop_own_tree(edge)
    print(json.dumps(metrics, ensure_ascii=True))
    return 0 if metrics["passedFunctional"] and metrics["passedPerformance"] and metrics["auditPrivacyPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
