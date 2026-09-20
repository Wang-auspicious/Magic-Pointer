import json
from types import SimpleNamespace

import pytest
from PIL import Image

from app.agent_runtime.live_observer import LiveObserver, SurfaceCapture
from app.agent_runtime.vision_backend import FileVisionBackend
from app.context_pack.sources import SourceRef
from app.governance.cancellation import CancelledError


def source(kind="capture", **identity):
    return SourceRef("source", "task", kind, "Window", {"hwnd": 42, **identity}, {}, ("read",), "user-pointed", None)


def test_live_viewport_never_claims_document_complete():
    observer = LiveObserver(source_resolver=lambda _: source(), state_reader=lambda *a: {"snapshot_id": "s"}, capture=lambda *a: SurfaceCapture(b"pixels", "fake"), vision_backend=SimpleNamespace(describe=lambda *a, **k: {"text": "visible text"}))
    result = observer.observe("source", "read")
    assert result["coverage"]["extent"] == "neighborhood"
    assert result["coverage"]["complete"] is False
    assert result["coverage"]["missingReason"] == "viewport_only"


def test_live_cancellation_is_forwarded_and_not_turned_into_visual_error(tmp_path):
    scope = SimpleNamespace(raise_if_cancelled=lambda: None)
    def ask(*args, **kwargs):
        assert kwargs["cancellation_scope"] is scope
        raise CancelledError("stopped")
    observer = LiveObserver(source_resolver=lambda _: source(), state_reader=lambda *a: {"snapshot_id": "s"}, capture=lambda *a: SurfaceCapture(b"pixels", "fake"), vision_backend=FileVisionBackend(ask=ask, temporary_directory=tmp_path))
    with pytest.raises(CancelledError, match="stopped"): observer.observe("source", "read", scope=scope)
    assert not list(tmp_path.iterdir())


def test_window_capture_uses_bound_hwnd_not_screen_bbox(monkeypatch):
    from app import capture
    calls = []
    monkeypatch.setattr("PIL.ImageGrab.grab", lambda **kwargs: calls.append(kwargs) or Image.new("RGB", (100, 100), "white"))
    capture.capture_window(42)
    assert calls == [{"window": 42}]


def test_supported_pillow_version_has_windows_window_capture():
    import re
    from pathlib import Path
    requirement = next(line for line in Path("requirements.txt").read_text().splitlines() if line.lower().startswith("pillow"))
    minimum = tuple(int(value) for value in re.search(r">=([0-9.]+)", requirement).group(1).split("."))
    assert minimum >= (11, 2, 1)


def test_live_source_identity_compares_adapter_conversation_before_capture():
    from app.agent_runtime.live_observer import validate_live_source
    expected = {"adapterId": "chat", "nativeConversationId": "group-a", "conversationKey": "group-a", "windowHwnd": 42}
    actual = {**expected, "nativeConversationId": "group-b", "conversationKey": "group-b"}
    surface = SimpleNamespace(try_resolve=lambda *a, **k: SimpleNamespace(objects=[SimpleNamespace(kind="conversation", fields={"conversationIdentity": actual})]))
    with pytest.raises(Exception, match="identity"):
        validate_live_source(source("chat", conversationIdentity=expected), {"hwnd": 42}, surface_registry=surface)


def test_bound_ax_observe_does_not_capture_or_call_vision(monkeypatch):
    from app.harness import builtin_bundle
    from app.desktop_actions.session import DesktopActionSession
    from app.agent_runtime.tool_registry import ToolRegistry
    registry = ToolRegistry()
    window = {"hwnd": 42, "pid": 7, "rect": [0, 0, 100, 100], "title": "Window"}
    desktop = DesktopActionSession(driver=SimpleNamespace(), windows_probe=lambda: [window], elements_probe=lambda _: [], launcher=lambda _: {}, uia_act=lambda *a: {}, session_id="fake", surface_probe=lambda _: pytest.fail("ax must not capture"))
    monkeypatch.setattr(builtin_bundle, "default_session", lambda **kwargs: desktop)
    monkeypatch.setattr("app.context_pack.source_store.resolve_source", lambda *a: source())
    monkeypatch.setattr("app.capture.capture_window", lambda *a: pytest.fail("ax must not capture"))
    monkeypatch.setattr("app.capture.provider_for", lambda *a: SimpleNamespace(available=lambda: True, source="fake", capture=lambda *a: pytest.fail("ax must not capture")))
    fork = SimpleNamespace(get=lambda key: {"tools": registry, "vision": SimpleNamespace(describe=lambda *a, **k: pytest.fail("ax must not invoke vision"))}[key])
    builtin_bundle._apply_desktop_action_tools(fork, {"source_session_getter": lambda: SimpleNamespace(events=()), "origin_window_hwnd": 42})
    result = registry.execute_tool("Observe", {"source_id": "source", "mode": "ax", "ax_filter": "edit"})
    assert not result.is_error
    payload = json.loads(result.value) if isinstance(result.value, str) else result.value
    assert payload["mode"] == "ax"


def test_vision_stop_closes_inflight_http_request(tmp_path, monkeypatch):
    import threading
    from app import ai_client
    from app.governance.cancellation import CancellationToken
    token = CancellationToken()
    entered, closed = threading.Event(), threading.Event()
    class Client:
        def __enter__(self): return self
        def __exit__(self, *args): self.close()
        def close(self): closed.set()
        def post(self, *args, **kwargs):
            entered.set()
            closed.wait(2)
            raise OSError("closed")
    monkeypatch.setattr(ai_client, "get_ai_config", lambda: ("fake", "https://example.test/v1", "vision"))
    monkeypatch.setattr(ai_client, "get_ai_api_mode", lambda *a: "chat")
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda *a: None)
    monkeypatch.setattr(ai_client, "_httpx_client", lambda *a, **k: Client())
    image = tmp_path / "image.png"
    Image.new("RGB", (5, 5)).save(image)
    def cancel():
        assert entered.wait(1)
        token.cancel()
    thread = threading.Thread(target=cancel)
    thread.start()
    import time
    started = time.monotonic()
    with pytest.raises(CancelledError): ai_client.ask_vision_model(image, "test", cancellation_scope=token)
    thread.join()
    assert closed.is_set() and time.monotonic() - started < 1
