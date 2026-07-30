from __future__ import annotations

"""Real Windows acceptance for N19 mouse-driven voice start strategies.

The harness uses a physical Windows cursor/button transition and the shipped
native pointer stream (stage:pointer-input).  CDP is read-only and is used only
to locate the real Stage capsule for the hover scenario.
"""

import ctypes
from datetime import datetime, timezone
import argparse
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket
from PIL import ImageGrab

from verify_stage_selection_visual import (
    EDGE,
    ELECTRON,
    FIXTURE,
    WINDOW_TITLE,
    enable_dpi_awareness,
    physical_element_rect,
    stop_process_tree,
    visible_windows,
)


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / "data" / "runtime" / "n19-voice-triggers-20260730"
EDGE_PORT = 9372
STAGE_PORTS = {"push_to_talk": 9373, "hover": 9374}
HOTKEY = "Control+Alt+Shift+F11"
STAGE_TITLE = "Magic Pointer Stage"
STRATEGIES = ("push_to_talk", "hover")


def wait_until(label: str, predicate, timeout: float, interval: float = 0.12):
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception as exc:
            last_error = exc
        time.sleep(interval)
    suffix = f":{type(last_error).__name__}" if last_error else ""
    raise RuntimeError(f"deadline:{label}{suffix}")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def cdp_pages(port: int) -> list[dict]:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_page(port: int, title: str, timeout: float = 20) -> dict:
    return wait_until(
        f"cdp_page:{title}",
        lambda: next(
            (page for page in cdp_pages(port) if title in str(page.get("title") or "")),
            None,
        ),
        timeout,
        0.2,
    )


def evaluate(websocket_url: str, expression: str):
    connection = websocket.create_connection(
        websocket_url,
        timeout=5,
        origin="http://127.0.0.1",
    )
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


def find_window(title: str) -> dict | None:
    return next(
        (window for window in visible_windows() if title in str(window.get("title") or "")),
        None,
    )


def force_foreground_window(hwnd: int) -> None:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.ShowWindow(int(hwnd), 9)
    user32.SetWindowPos(int(hwnd), -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
    current = int(user32.GetForegroundWindow() or 0)
    current_thread = int(kernel32.GetCurrentThreadId())
    foreground_thread = int(user32.GetWindowThreadProcessId(current, None) or 0)
    target_thread = int(user32.GetWindowThreadProcessId(int(hwnd), None) or 0)
    attached: list[int] = []
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
    time.sleep(0.18)


def press_activation_hotkey() -> None:
    user32 = ctypes.windll.user32
    keys = [0x11, 0x12, 0x10, 0x7A]
    for key in keys:
        user32.keybd_event(key, 0, 0, 0)
    time.sleep(0.08)
    for key in reversed(keys):
        user32.keybd_event(key, 0, 0x0002, 0)


def set_cursor(point: tuple[int, int]) -> None:
    ctypes.windll.user32.SetCursorPos(int(point[0]), int(point[1]))


def primary_button(down: bool) -> None:
    ctypes.windll.user32.mouse_event(0x0002 if down else 0x0004, 0, 0, 0, 0)


def draw_selection(end: tuple[int, int]) -> None:
    start = (end[0] - 260, end[1] - 2)
    set_cursor(start)
    time.sleep(0.08)
    primary_button(True)
    try:
        for index in range(1, 17):
            ratio = index / 16
            set_cursor((
                round(start[0] + (end[0] - start[0]) * ratio),
                round(start[1] + (end[1] - start[1]) * ratio),
            ))
            time.sleep(0.018)
    finally:
        primary_button(False)


def default_settings() -> dict:
    source = (
        "const s=require('./electron/settings_store').defaultSettings();"
        "process.stdout.write(JSON.stringify(s));"
    )
    completed = subprocess.run(
        ["node", "-e", source],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        check=True,
        timeout=15,
    )
    return json.loads(completed.stdout)


def write_settings(runtime: Path, strategy: str) -> None:
    settings = default_settings()
    settings["activation"].update({
        "wake_mode": "hotkey",
        "wiggle_enabled": False,
        "fallback_hotkey_enabled": True,
        "fallback_hotkey": HOTKEY,
    })
    settings["shortcuts"]["wake"] = HOTKEY
    settings["interaction"].update({
        "default_input_mode": "voice",
        "voice_start_strategy": strategy,
        "voice_auto_submit": True,
        "voice_resident_enabled": True,
        "voice_memory_limit_mb": 1024,
        "voice_idle_unload_ms": 300000,
    })
    settings["connections"].update({
        "browser_devtools_enabled": True,
        "browser_devtools_endpoints": [f"http://127.0.0.1:{EDGE_PORT}"],
    })
    candidate = runtime / "fabric-settings.json"
    candidate.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    source = (
        "const S=require('./electron/settings_store').ElectronSettingsStore;"
        "new S(process.argv[1]).load();"
    )
    subprocess.run(
        ["node", "-e", source, str(candidate)],
        cwd=ROOT,
        check=True,
        timeout=15,
    )
    (runtime / "onboarding.json").write_text(
        json.dumps({"schemaVersion": 1, "status": "ready"}) + "\n",
        encoding="utf-8",
    )


def synthesize_wav(path: Path) -> None:
    escaped_path = str(path).replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"$s.SetOutputToWaveFile('{escaped_path}');"
        "$s.Speak('Magic Pointer local voice test');"
        "$s.Dispose()"
    )
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command", script],
        check=True,
        timeout=30,
    )
    if not path.is_file() or path.stat().st_size < 1000:
        raise RuntimeError("synthesized_wav_invalid")


def audit_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    for raw in read_text(path).splitlines():
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if item.get("type") == "voice.residency" and isinstance(item.get("data"), dict):
            rows.append(item["data"])
    return rows


def rows_for(path: Path, event_type: str) -> list[dict]:
    return [row for row in audit_rows(path) if row.get("eventType") == event_type]


def wait_log(path: Path, marker: str, timeout: float = 25) -> str:
    return wait_until(
        f"log:{marker}",
        lambda: (text if marker in (text := read_text(path)) else None),
        timeout,
        0.08,
    )


def wait_new_audit(path: Path, event_type: str, prior: int, timeout: float = 60) -> dict:
    return wait_until(
        f"audit:{event_type}",
        lambda: (
            rows[-1]
            if len(rows := rows_for(path, event_type)) > prior
            else None
        ),
        timeout,
        0.1,
    )


def capsule_geometry(stage_page: dict) -> dict:
    return evaluate(stage_page["webSocketDebuggerUrl"], """(() => {
      const capsule = document.getElementById('capsule');
      const rect = capsule.getBoundingClientRect();
      return {
        hidden: capsule.hidden,
        mode: capsule.dataset.mode,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        capsule: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
      };
    })()""")


def iso_timestamp_ms(row: dict) -> float | None:
    raw = str(row.get("timestamp") or "")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp() * 1000
    except ValueError:
        return None


def run_strategy(
    strategy: str,
    fixture_window: dict,
    fixture_point: tuple[int, int],
    wav: Path,
) -> dict:
    run_root = Path(tempfile.mkdtemp(prefix=f"magic-pointer-n19-{strategy}-")).resolve()
    safe_temp_root = Path(tempfile.gettempdir()).resolve()
    if run_root.parent != safe_temp_root or not run_root.name.startswith("magic-pointer-n19-"):
        raise RuntimeError("unsafe_temp_root")
    runtime = run_root / "runtime"
    runtime.mkdir()
    write_settings(runtime, strategy)
    port = STAGE_PORTS[strategy]
    trace_path = EVIDENCE_DIR / f"{strategy}-electron-stdio.log"
    trace = trace_path.open("w", encoding="utf-8")
    electron: subprocess.Popen | None = None
    button_down = False
    try:
        env = os.environ.copy()
        env.update({
            "MAGIC_POINTER_USER_DATA_DIR": str(runtime),
            "MAGIC_POINTER_VOICE_INPUT_WAV": str(wav),
            "ELECTRON_ENABLE_LOGGING": "1",
        })
        electron = subprocess.Popen(
            [
                str(ELECTRON),
                f"--remote-debugging-port={port}",
                "--remote-allow-origins=*",
                str(ROOT),
                "--background",
            ],
            cwd=ROOT,
            env=env,
            stdout=trace,
            stderr=subprocess.STDOUT,
        )
        log_path = runtime / "electron.log"
        audit_path = runtime / "fabric-audit.jsonl"
        polling_log = wait_log(
            log_path,
            "pointer activation polling=true wiggle=false mouseButton=false wakeMode=hotkey",
            30,
        )
        wait_log(log_path, "stage renderer ready", 30)
        wait_log(log_path, "overlay renderer ready", 30)
        wait_log(
            log_path,
            f"register configurable hotkey name=wake accelerator={HOTKEY} ok=true",
            20,
        )
        wait_until(
            "resident_voice_ready",
            lambda: bool(rows_for(audit_path, "voice.ready")),
            100,
            0.2,
        )
        stage_page = wait_page(port, STAGE_TITLE, 30)

        force_foreground_window(int(fixture_window["hwnd"]))
        foreground_before = int(ctypes.windll.user32.GetForegroundWindow() or 0)
        if foreground_before != int(fixture_window["hwnd"]):
            raise RuntimeError("fixture_foreground_lock_failed")
        set_cursor(fixture_point)
        time.sleep(0.28)
        press_activation_hotkey()
        wait_log(log_path, "selection gesture ready", 15)
        draw_selection(fixture_point)
        wait_log(log_path, "selection gesture completed", 15)
        wait_log(log_path, "stage renderer state=capsule-voice", 20)
        wait_log(log_path, "selection session capture done", 45)
        geometry = wait_until(
            "visible_voice_capsule",
            lambda: (
                value
                if not (value := capsule_geometry(stage_page)).get("hidden")
                and value.get("mode") == "voice"
                else None
            ),
            15,
            0.1,
        )
        stage_window = wait_until(
            "stage_window",
            lambda: find_window(STAGE_TITLE),
            10,
            0.1,
        )
        capsule_rect = physical_element_rect(stage_window, geometry, "capsule")
        capsule_center = (
            capsule_rect["x"] + capsule_rect["width"] // 2,
            capsule_rect["y"] + capsule_rect["height"] // 2,
        )
        voice_start_before = len(rows_for(audit_path, "voice.start"))
        voice_final_before = len(rows_for(audit_path, "voice.final"))
        trigger_started_at = time.monotonic()

        if strategy == "push_to_talk":
            set_cursor(fixture_point)
            time.sleep(0.18)
            primary_button(True)
            button_down = True
            start_row = wait_new_audit(audit_path, "voice.start", voice_start_before, 5)
            foreground_during_trigger = int(ctypes.windll.user32.GetForegroundWindow() or 0)
            time.sleep(0.16)
            primary_button(False)
            button_down = False
            expected_stage_state = "stage renderer state=processing"
        else:
            outside = (
                max(int(fixture_window["bbox"][0]) + 30, capsule_rect["x"] - 180),
                max(int(fixture_window["bbox"][1]) + 90, capsule_rect["y"] - 120),
            )
            set_cursor(outside)
            time.sleep(0.32)
            set_cursor(capsule_center)
            start_row = wait_new_audit(audit_path, "voice.start", voice_start_before, 5)
            foreground_during_trigger = int(ctypes.windll.user32.GetForegroundWindow() or 0)
            expected_stage_state = "stage renderer state=processing"

        trigger_to_start_ms = round((time.monotonic() - trigger_started_at) * 1000, 1)
        final_row = wait_new_audit(audit_path, "voice.final", voice_final_before, 60)
        final_log = wait_log(log_path, expected_stage_state, 35)
        time.sleep(0.35)
        foreground_after = int(ctypes.windll.user32.GetForegroundWindow() or 0)
        foreground_invariant = (
            foreground_before == int(fixture_window["hwnd"])
            and foreground_during_trigger == int(fixture_window["hwnd"])
            and foreground_after == int(fixture_window["hwnd"])
        )
        screenshot_path = EVIDENCE_DIR / f"{strategy}-after.png"
        left, top, right, bottom = [int(value) for value in fixture_window["bbox"]]
        ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True).save(screenshot_path)
        log_text = read_text(log_path)
        pointer_polling_enabled = "pointer activation polling=true" in polling_log
        wiggle_stayed_disabled = (
            "wiggle=false" in polling_log
            and "wiggle accepted metrics=" not in log_text
        )
        start_ms = iso_timestamp_ms(start_row)
        final_ms = iso_timestamp_ms(final_row)
        final_latency_ms = (
            round(final_ms - start_ms, 1)
            if start_ms is not None and final_ms is not None
            else None
        )
        passed = (
            pointer_polling_enabled
            and wiggle_stayed_disabled
            and foreground_invariant
            and start_row.get("outcome") == "requested"
            and final_row.get("outcome") == "accepted"
            and expected_stage_state in final_log
        )
        return {
            "strategy": strategy,
            "passed": passed,
            "pointerPollingEnabled": pointer_polling_enabled,
            "wiggleStayedDisabled": wiggle_stayed_disabled,
            "voiceStartObserved": start_row.get("eventType") == "voice.start",
            "voiceFinalObserved": final_row.get("eventType") == "voice.final",
            "triggerToStartMs": trigger_to_start_ms,
            "startToFinalMs": final_latency_ms,
            "foregroundInvariant": foreground_invariant,
            "foregroundHwndBefore": foreground_before,
            "foregroundHwndDuringTrigger": foreground_during_trigger,
            "foregroundHwndAfter": foreground_after,
            "capsuleRectPhysical": capsule_rect,
            "triggerPointPhysical": {
                "x": fixture_point[0] if strategy == "push_to_talk" else capsule_center[0],
                "y": fixture_point[1] if strategy == "push_to_talk" else capsule_center[1],
            },
            "expectedStageState": expected_stage_state.split("=", 1)[1],
            "screenshot": str(screenshot_path),
        }
    finally:
        if button_down:
            primary_button(False)
        stop_process_tree(electron)
        trace.close()
        for name in ("electron.log", "fabric-audit.jsonl"):
            source = runtime / name
            if source.is_file():
                shutil.copy2(source, EVIDENCE_DIR / f"{strategy}-{name}")
        shutil.rmtree(run_root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strategy", choices=STRATEGIES)
    args = parser.parse_args()
    selected_strategies = (args.strategy,) if args.strategy else STRATEGIES
    if os.name != "nt":
        raise RuntimeError("windows_required")
    if not EDGE.is_file():
        raise RuntimeError("microsoft_edge_not_found")
    if not ELECTRON.is_file():
        raise RuntimeError("electron_runtime_not_found")
    enable_dpi_awareness()
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    wav = EVIDENCE_DIR / "synthesized-input.wav"
    synthesize_wav(wav)
    edge_root = Path(tempfile.mkdtemp(prefix="magic-pointer-n19-edge-")).resolve()
    safe_temp_root = Path(tempfile.gettempdir()).resolve()
    if edge_root.parent != safe_temp_root or not edge_root.name.startswith("magic-pointer-n19-edge-"):
        raise RuntimeError("unsafe_edge_temp_root")
    profile = edge_root / "profile"
    profile.mkdir()
    edge: subprocess.Popen | None = None
    results: list[dict] = []
    failures: list[str] = []
    try:
        edge = subprocess.Popen([
            str(EDGE),
            f"--remote-debugging-port={EDGE_PORT}",
            "--remote-allow-origins=*",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--window-position=120,80",
            "--window-size=1100,880",
            f"--app={FIXTURE.resolve().as_uri()}",
        ])
        fixture_page = wait_page(EDGE_PORT, WINDOW_TITLE, 20)
        fixture_window = wait_until(
            "fixture_window",
            lambda: find_window(WINDOW_TITLE),
            20,
            0.2,
        )
        geometry = evaluate(fixture_page["webSocketDebuggerUrl"], """(() => {
          const rect = document.getElementById('target').getBoundingClientRect();
          return {
            outerWidth: window.outerWidth, outerHeight: window.outerHeight,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            target: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
          };
        })()""")
        target = physical_element_rect(fixture_window, geometry, "target")
        fixture_point = (
            target["x"] + target["width"] * 3 // 4,
            target["y"] + target["height"] // 2,
        )
        for strategy in selected_strategies:
            try:
                results.append(run_strategy(strategy, fixture_window, fixture_point, wav))
            except Exception as exc:
                failures.append(f"{strategy}:{type(exc).__name__}:{exc}")
                results.append({
                    "strategy": strategy,
                    "passed": False,
                    "pointerPollingEnabled": False,
                    "wiggleStayedDisabled": False,
                    "voiceStartObserved": False,
                    "voiceFinalObserved": False,
                    "foregroundInvariant": False,
                    "error": f"{type(exc).__name__}:{exc}",
                })
        passed = (
            not failures
            and len(results) == len(selected_strategies)
            and all(item.get("passed") for item in results)
        )
        evidence = {
            "schemaVersion": 1,
            "passed": passed,
            "inputSource": "synthesized_wav_through_product_voice_runtime",
            "physicalWindowsPointerUsed": True,
            "rendererEventInjectionUsed": False,
            "strategies": results,
            "failureCodes": failures,
        }
        evidence_path = EVIDENCE_DIR / "evidence.json"
        evidence_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(evidence, ensure_ascii=True))
        return 0 if passed else 1
    finally:
        stop_process_tree(edge)
        shutil.rmtree(edge_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
