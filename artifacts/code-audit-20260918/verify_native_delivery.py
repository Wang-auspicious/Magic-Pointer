"""Read back a long value through production UIA on a disposable Win32 Edit."""

import argparse
import json
import sys
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--app-root", type=Path, required=True)
parser.add_argument("--workspace", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
app_root = args.app_root.resolve()
sys.path.insert(0, str(app_root))

import win32con
import win32gui

import app.desktop_actions.session as session_module
from app.desktop_actions.session import DesktopActionSession, _live_elements, _live_uia, _live_windows
from app.system_context import enable_dpi_awareness

assert Path(session_module.__file__).resolve().is_relative_to(app_root)


class NoPhysicalInput:
    def __getattr__(self, name):
        raise AssertionError(f"Native acceptance must not use physical input: {name}")


def verify_native():
    enable_dpi_awareness()
    ready = threading.Event()
    state = {}

    def window_thread():
        def on_message(hwnd, message, wparam, lparam):
            if message == win32con.WM_DESTROY:
                win32gui.PostQuitMessage(0)
                return 0
            return win32gui.DefWindowProc(hwnd, message, wparam, lparam)

        cls = win32gui.WNDCLASS()
        cls.lpszClassName = f"MPCodeAudit{time.time_ns()}"
        cls.lpfnWndProc = on_message
        atom = win32gui.RegisterClass(cls)
        hwnd = win32gui.CreateWindow(
            atom, "MP code audit verification (temporary)", win32con.WS_OVERLAPPEDWINDOW,
            80, 80, 460, 180, 0, 0, 0, None,
        )
        win32gui.CreateWindow(
            "EDIT", "before audit verification",
            win32con.WS_CHILD | win32con.WS_VISIBLE | win32con.WS_BORDER | win32con.ES_MULTILINE,
            20, 25, 390, 65, hwnd, 101, 0, None,
        )
        state["hwnd"] = hwnd
        win32gui.ShowWindow(hwnd, win32con.SW_SHOWNOACTIVATE)
        ready.set()
        win32gui.PumpMessages()

    thread = threading.Thread(target=window_thread, daemon=True)
    thread.start()
    if not ready.wait(10):
        raise RuntimeError("Native fixture window did not start")
    session = DesktopActionSession(
        driver=NoPhysicalInput(), windows_probe=_live_windows, elements_probe=_live_elements,
        launcher=lambda _: {}, uia_act=_live_uia, session_id="audit-native-readback",
        origin_window_hwnd=state["hwnd"],
    )
    text = "Retain the entire editable value. " * 8 + "AUDIT-END-OF-LONG-VALUE"
    try:
        started = time.perf_counter()
        observed = json.loads(session.observe_ui())
        editor = next(item for item in observed["outline"] if str(item["role"]).casefold() == "edit")
        result = json.loads(session.act_ui(
            observed["state_id"], [{"action": "setText", "ref": editor["ref"], "text": text}],
            expect={"value": text, "timeout_ms": 2000},
        ))
        assert result["verification"]["found"] is True, result
        assert result["verification"]["matched"] is True, result
        assert result["state_id"] == result["verification"]["state_id"]
        readback = json.loads(session.read_text(result["state_id"], editor["ref"]))
        assert text in readback["text"], readback
        return {"ok": True, "backend": "production UIA / native Win32 Edit",
                "valueChars": len(text), "fullValueReadBack": True,
                "conditionMatched": True, "physicalInputUsed": False,
                "elapsedMs": round((time.perf_counter() - started) * 1000, 2)}
    finally:
        session.turn_ended()
        win32gui.PostMessage(state["hwnd"], win32con.WM_CLOSE, 0, 0)
        thread.join(5)


checked = []
production = [
    "app/context_pack/selection_reader.py", "app/context_pack/document_reader.py",
    "app/context_pack/chat_reader.py", "app/context_pack/tools.py",
    "app/agent_runtime/turn_verification.py", "app/agent_runtime/loop.py",
    "app/agent_runtime/session.py", "app/agent_runtime/tool_registry.py", "app/agent_runtime/wait_tool.py",
    "app/perception/fusion.py", "app/perception/pixel_ocr.py", "app/perception/providers.py",
    "app/input_artifact/schema.py", "app/desktop_actions/session.py", "app/desktop_actions/uia.py",
    "app/models/profiles.py", "app/fabric/settings.py",
    "scripts/selection_bridge.py", "scripts/conversation_bridge.py",
    "build/electron/main.js", "build/electron/conversation_store.js",
    "build/electron/settings_store.js", "build/electron/renderer/studio.js",
    "build/electron/renderer/dsh_chat.js",
]
for relative in production:
    assert (args.workspace / relative).read_bytes() == (app_root / relative).read_bytes(), relative
    checked.append(relative)
version = json.loads((app_root / "package.json").read_text(encoding="utf-8"))["version"]
assert version == json.loads((args.workspace / "package.json").read_text(encoding="utf-8"))["version"]
report = {"version": version,
          "python": sys.executable, "module": session_module.__file__,
          "byteIdenticalFiles": checked, "native": verify_native()}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
