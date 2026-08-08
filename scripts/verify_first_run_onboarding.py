"""Real Electron acceptance for first-run initialization and cheap relaunch."""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import websocket

ROOT = Path(__file__).resolve().parents[1]
ELECTRON = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
EVIDENCE_ROOT = ROOT / "data" / "runtime" / "first-run-onboarding-20260730"
PORT = 9374


def wait_for_page(port: int, page_name: str, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1) as response:
                targets = json.load(response)
            for target in targets:
                if target.get("type") == "page" and page_name in target.get("url", ""):
                    return target
        except Exception:
            pass
        time.sleep(0.15)
    raise RuntimeError(f"page_not_available:{page_name}")


def cdp_call(ws: websocket.WebSocket, serial: int, method: str, params: dict | None = None) -> dict:
    ws.send(json.dumps({"id": serial, "method": method, "params": params or {}}))
    while True:
        message = json.loads(ws.recv())
        if message.get("id") == serial:
            if "error" in message:
                raise RuntimeError(f"cdp_error:{message['error']}")
            return message.get("result", {})


def wait_for_marker(marker_path: Path, timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            if marker.get("schemaVersion") == 2 and marker.get("status") == "ready":
                return marker
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.2)
    raise RuntimeError("onboarding_marker_not_ready")


def evaluate(ws: websocket.WebSocket, serial: int, expression: str) -> object:
    return cdp_call(ws, serial, "Runtime.evaluate", {
        "expression": expression,
        "returnByValue": True,
        "awaitPromise": True,
    })["result"].get("value")


def wait_for_screen(ws: websocket.WebSocket, screen_name: str, timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    serial = 100
    while time.monotonic() < deadline:
        state = evaluate(ws, serial, """(() => {
          const screen = document.documentElement.dataset.screen || '';
          const active = document.querySelector(`.onboarding-screen[data-screen="${screen}"]`);
          const rect = active?.getBoundingClientRect();
          const cancel = document.getElementById('onboarding-cancel');
          const cancelRect = cancel?.getBoundingClientRect();
          const cancelTextRange = cancel ? document.createRange() : null;
          if (cancelTextRange) cancelTextRange.selectNodeContents(cancel);
          const cancelTextRect = cancelTextRange?.getBoundingClientRect();
          return {
            screen,
            percent: document.querySelector('.progress-track')?.getAttribute('aria-valuenow') || '',
            current: document.getElementById('onboarding-current-stage')?.textContent || '',
            stepCount: document.getElementById('onboarding-step-count')?.textContent || '',
            rows: document.querySelectorAll('.onboarding-stage').length,
            activeHidden: active?.hidden ?? true,
            activeDisplay: active ? getComputedStyle(active).display : '',
            activeVisibility: active ? getComputedStyle(active).visibility : '',
            activeOpacity: active ? getComputedStyle(active).opacity : '',
            activeRect: rect ? [rect.x, rect.y, rect.width, rect.height] : [],
            cancelRect: cancelRect ? [cancelRect.x, cancelRect.y, cancelRect.width, cancelRect.height] : [],
            cancelTextRect: cancelTextRect ? [cancelTextRect.x, cancelTextRect.y, cancelTextRect.width, cancelTextRect.height] : [],
            screens: [...document.querySelectorAll('.onboarding-screen[data-screen]')].map((node) => ({
              name: node.dataset.screen,
              className: node.className,
              display: getComputedStyle(node).display,
              ariaHidden: node.getAttribute('aria-hidden')
            }))
          };
        })()""")
        serial += 1
        if isinstance(state, dict) and state.get("screen") == screen_name:
            return state
        time.sleep(0.12)
    raise RuntimeError(f"onboarding_screen_not_reached:{screen_name}")


def capture_screenshot(ws: websocket.WebSocket, serial: int, target: Path) -> None:
    capture = cdp_call(ws, serial + 1000, "Page.captureScreenshot", {"format": "png", "fromSurface": True})
    target.write_bytes(base64.b64decode(capture["data"]))


def stop_process_tree(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def start_app(runtime: Path, port: int, background: bool = False) -> subprocess.Popen:
    env = os.environ.copy()
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(runtime)
    env["MAGIC_POINTER_ENABLE_MOUSE_SHAKE"] = "0"
    args = [str(ELECTRON), str(ROOT), f"--remote-debugging-port={port}"]
    if background:
        args.append("--background")
    return subprocess.Popen(
        args,
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def wait_for_log(log_path: Path, needle: str, start: int = 0, timeout: float = 20.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        segment = text[start:]
        if needle in segment:
            return segment
        time.sleep(0.15)
    raise RuntimeError(f"log_not_found:{needle}")


def verify(output_root: Path) -> Path:
    safe_parent = (ROOT / "data" / "runtime").resolve()
    try:
        output_root.resolve().relative_to(safe_parent)
    except ValueError as error:
        raise RuntimeError("output_must_be_inside_data_runtime") from error
    if output_root.resolve() == safe_parent:
        raise RuntimeError("refusing_to_replace_runtime_root")
    if output_root.exists():
        shutil.rmtree(output_root)
    runtime = output_root / "runtime"
    output_root.mkdir(parents=True)
    runtime.mkdir()
    marker_path = runtime / "onboarding.json"
    log_path = runtime / "electron.log"
    welcome_screenshot = output_root / "onboarding-welcome.png"
    progress_screenshot = output_root / "onboarding-progress.png"
    complete_screenshot = output_root / "onboarding-complete.png"

    cancel_runtime = output_root / "cancel-runtime"
    cancel_runtime.mkdir()
    cancel_process = start_app(cancel_runtime, PORT - 1)
    try:
        cancel_target = wait_for_page(PORT - 1, "onboarding.html")
        cancel_ws = websocket.create_connection(
            cancel_target["webSocketDebuggerUrl"],
            timeout=5,
            suppress_origin=True,
        )
        try:
            wait_for_screen(cancel_ws, "welcome")
            evaluate(cancel_ws, 1, "document.getElementById('onboarding-start').click()")
            wait_for_screen(cancel_ws, "progress")
            evaluate(cancel_ws, 2, "document.getElementById('onboarding-cancel').click()")
        finally:
            cancel_ws.close()
        cancel_process.wait(timeout=10)
        if cancel_process.returncode not in (0, None):
            raise RuntimeError(f"onboarding_cancel_exit_failed:{cancel_process.returncode}")
        if cancel_runtime.joinpath("onboarding.json").exists():
            raise RuntimeError("onboarding_cancel_wrote_ready_marker")
    finally:
        stop_process_tree(cancel_process)

    first = start_app(runtime, PORT)
    try:
        target = wait_for_page(PORT, "onboarding.html")
        ws = websocket.create_connection(
            target["webSocketDebuggerUrl"],
            timeout=5,
            suppress_origin=True,
        )
        try:
            welcome_state = wait_for_screen(ws, "welcome")
            capture_screenshot(ws, 1, welcome_screenshot)
            evaluate(ws, 2, "document.getElementById('onboarding-start').click()")
            progress_state = wait_for_screen(ws, "progress")
            deadline = time.monotonic() + 10
            while progress_state["rows"] < 9 and time.monotonic() < deadline:
                time.sleep(0.1)
                progress_state = wait_for_screen(ws, "progress", timeout=2)
            capture_screenshot(ws, 3, progress_screenshot)
            marker = wait_for_marker(marker_path)
            complete_state = wait_for_screen(ws, "success")
            capture_screenshot(ws, 4, complete_screenshot)
            evaluate(ws, 5, "document.getElementById('onboarding-continue').click()")
        finally:
            ws.close()
        wait_for_page(PORT, "studio.html")
        first_log = wait_for_log(log_path, "preflight complete ready=true")
        if welcome_state["screen"] != "welcome" or progress_state["rows"] != 9:
            raise RuntimeError(f"first_run_surface_incomplete:{welcome_state}:{progress_state}")
        if complete_state["percent"] != "100" or complete_state["screen"] != "success":
            raise RuntimeError(f"first_run_progress_incomplete:{complete_state}")
        marker_mtime = marker_path.stat().st_mtime_ns
    finally:
        stop_process_tree(first)

    before_second = len(log_path.read_text(encoding="utf-8", errors="replace"))
    second = start_app(runtime, PORT + 1, background=True)
    try:
        second_log = wait_for_log(
            log_path,
            "onboarding readiness ready=true reason=ready",
            start=before_second,
        )
        time.sleep(1.5)
        second_log = log_path.read_text(encoding="utf-8", errors="replace")[before_second:]
        if "preflight start" in second_log:
            raise RuntimeError("preflight_repeated_on_second_launch")
        if marker_path.stat().st_mtime_ns != marker_mtime:
            raise RuntimeError("onboarding_marker_rewritten_on_second_launch")
    finally:
        stop_process_tree(second)

    evidence = {
        "schemaVersion": 1,
        "capturedAt": datetime.now(UTC).isoformat(),
        "cancellation": {
            "processExited": cancel_process.poll() is not None,
            "readyMarkerWritten": False,
        },
        "firstRun": {
            "userStarted": "preflight start source=onboarding" in first_log,
            "welcome": welcome_state,
            "progress": progress_state,
            "complete": complete_state,
            "marker": marker,
            "screenshots": {
                "welcome": str(welcome_screenshot),
                "progress": str(progress_screenshot),
                "complete": str(complete_screenshot),
            },
        },
        "secondRun": {
            "cheapReadinessPassed": "onboarding readiness ready=true reason=ready" in second_log,
            "preflightRepeated": False,
            "markerRewritten": False,
        },
    }
    evidence_path = output_root / "evidence.json"
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return evidence_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=EVIDENCE_ROOT)
    arguments = parser.parse_args()
    result = verify(arguments.output.resolve())
    print(result)
