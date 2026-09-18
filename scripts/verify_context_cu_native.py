"""Explicit Windows UIA acceptance on a temporary native Edit control.

No fake UIA tree, no model, no physical input, and no user's document changed.
The temporary window is shown without activating it and closed in finally.
"""

import json
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import win32con
import win32gui

from app.desktop_actions.session import DesktopActionSession, _live_elements, _live_uia, _live_windows
from app.system_context import enable_dpi_awareness


class NoPhysicalInput:
    def __getattr__(self, name):
        raise AssertionError(f"native SetValue acceptance must not use physical input: {name}")


def main():
    # Match MP's native capture/probe bridges before creating the fixture window.
    # Changing process DPI awareness after CreateWindow resizes our own window
    # at 200% scaling and correctly invalidates the preceding observation.
    enable_dpi_awareness()
    ready = threading.Event()
    state = {}

    def run_window():
        def window_proc(hwnd, message, wparam, lparam):
            if message == win32con.WM_DESTROY:
                win32gui.PostQuitMessage(0)
                return 0
            return win32gui.DefWindowProc(hwnd, message, wparam, lparam)

        cls = win32gui.WNDCLASS()
        cls.lpszClassName = f"MPBackendAcceptance{time.time_ns()}"
        cls.lpfnWndProc = window_proc
        atom = win32gui.RegisterClass(cls)
        hwnd = win32gui.CreateWindow(atom, "MP backend verification (temporary)",
            win32con.WS_OVERLAPPEDWINDOW, 80, 80, 460, 180, 0, 0, 0, None)
        win32gui.CreateWindow("EDIT", "before native verification",
            win32con.WS_CHILD | win32con.WS_VISIBLE | win32con.WS_BORDER | win32con.ES_MULTILINE,
            20, 25, 390, 65, hwnd, 101, 0, None)
        state["hwnd"] = hwnd
        win32gui.ShowWindow(hwnd, win32con.SW_SHOWNOACTIVATE)
        ready.set()
        win32gui.PumpMessages()

    thread = threading.Thread(target=run_window, daemon=True)
    thread.start()
    if not ready.wait(10):
        raise RuntimeError("native fixture window did not start")
    probes = []

    def read_elements(hwnd):
        started = time.perf_counter()
        result = _live_elements(hwnd)
        probes.append(round((time.perf_counter() - started) * 1000, 2))
        return result

    session = DesktopActionSession(driver=NoPhysicalInput(), windows_probe=_live_windows,
        elements_probe=read_elements, launcher=lambda app: {}, uia_act=_live_uia,
        session_id="native-backend-acceptance", origin_window_hwnd=state["hwnd"])
    try:
        started = time.perf_counter()
        observed = json.loads(session.observe_ui())
        editor = next(item for item in observed["outline"] if str(item["role"]).casefold() == "edit")
        result = json.loads(session.act_ui(observed["state_id"],
            [{"action": "setText", "ref": editor["ref"], "text": "MP native verification passed"}],
            expect={"value": "MP native verification passed", "timeout_ms": 2000}))
        assert result["verification"]["found"] is True
        assert result["state_id"] == result["verification"]["state_id"]
        checked = json.loads(session.read_text(result["state_id"], editor["ref"]))
        assert "MP native verification passed" in checked["text"]
        report = {"ok": True, "method": "real Win32 Edit + production UIA probe/SetValue + readback",
                  "usedBackend": "uia_value", "physicalInputUsed": False,
                  "elapsedMs": round((time.perf_counter() - started) * 1000),
                  "probeTimesMs": probes, "matchingSuccessorState": True}
        output = ROOT / "data/backend-20260918/native-cu.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))
    finally:
        session.turn_ended()
        win32gui.PostMessage(state["hwnd"], win32con.WM_CLOSE, 0, 0)
        thread.join(5)


if __name__ == "__main__":
    main()
