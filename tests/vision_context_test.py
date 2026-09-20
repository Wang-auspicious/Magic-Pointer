from __future__ import annotations

import io
from types import SimpleNamespace
from pathlib import Path

import pytest
from PIL import Image

from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.vision_backend import FileVisionBackend
from app.context_pack.source_store import register_source
from app.context_pack.sources import SourceRef
from app.harness.builtin_bundle import LoopHarnessHost, boot_loop_context


def _png(color: str, size: tuple[int, int]) -> bytes:
    encoded = io.BytesIO()
    Image.new("RGB", size, color).save(encoded, format="PNG")
    return encoded.getvalue()


@pytest.mark.parametrize("resident", [False, True])
def test_frozen_look_gets_detail_and_labeled_full_context_but_observe_only_new_pixels(
    tmp_path: Path, monkeypatch, resident: bool,
) -> None:
    import app.agent_runtime.vision_backend as vision
    import app.capture as capture
    import app.desktop_actions.session as desktop

    full_bytes = _png("red", (400, 200))
    crop_bytes = _png("blue", (100, 80))
    live_image = Image.new("RGB", (400, 200), "green")
    frozen = tmp_path / "historical.png"
    frozen.write_bytes(full_bytes)
    requests = []

    def ask(path, prompt, **kwargs):
        extras = kwargs.get("labeled_extra_images") or []
        requests.append({
            "primary": path.read_bytes(), "temporary": path,
            "prompt": prompt, "system": kwargs.get("system_prompt", ""),
            "extras": [(label, extra, extra.read_bytes()) for label, extra in extras],
            "timeout": kwargs["timeout_s"], "attempts": kwargs["attempts"],
        })
        return "observed the requested surface"

    monkeypatch.setattr(vision, "ask_vision_model", ask)
    monkeypatch.setattr(desktop, "_live_driver", lambda: SimpleNamespace())
    monkeypatch.setattr(desktop, "_live_windows", lambda: [{"hwnd": 42, "rect": [0, 0, 400, 200]}])
    monkeypatch.setattr(desktop, "_live_elements", lambda _hwnd: [])
    def capture_bound_window(hwnd):
        assert hwnd == 42
        return live_image.copy()
    monkeypatch.setattr(capture, "capture_window", capture_bound_window)
    session = FileSessionStore(tmp_path / "sessions").create("context-isolation")
    register_source(session, SourceRef(
        source_id="source:surface", task_id=session.id, kind="capture", title="Editor",
        identity={"hwnd": 42}, revision={"capturedAtMs": 1000},
        capabilities=("read",), origin="user-pointed", parent_source_id=None,
    ))
    backend = FileVisionBackend(temporary_directory=tmp_path)
    runtime = {
        "vision_backend": backend, "frame_crop": lambda _box: crop_bytes,
        "capture_path": str(frozen), "frame_captured_at": "2026-09-17T15:12:07Z",
        "source_session_getter": lambda: session,
        "target_window": {"hwnd": 42}, "command": "what is this?",
    }
    host = LoopHarnessHost(root=tmp_path, plugin_dir=tmp_path / "plugins") if resident else None
    scope = host.open(runtime) if host else None
    report = None if scope else boot_loop_context(runtime, root=tmp_path)
    ctx = scope.ctx if scope else report.ctx
    try:
        registry = ctx.get("tools")
        registry.get("Look").execute(anchor="bbox:100,40,200,120", prompt="explain this control")
        registry.get("Observe").execute(source_id="source:surface", question="what is visible now?")
        assert len(requests) == 2
        look, observe = requests
        assert look["primary"] == crop_bytes
        assert len(look["extras"]) == 1, "Look lost the original full-frame visual context"
        label, path, contents = look["extras"][0]
        assert path == frozen and contents == full_bytes
        assert "FROZEN_FRAME_CONTEXT" in label
        assert "2026-09-17T15:12:07Z" in label
        assert "not another target" in label
        assert "IMAGE A" in look["system"] and "not THAT" in look["system"]
        assert "explain this control" in look["prompt"]
        assert look["timeout"] == 30.0 and look["attempts"] == 1
        assert observe["extras"] == [], "live Observe must never attach the historical frame"
        with Image.open(io.BytesIO(observe["primary"])) as current:
            assert current.getpixel((0, 0)) == (0, 128, 0)
        assert ctx.get("vision") is backend
        assert all(not request["temporary"].exists() for request in requests)
        assert frozen.read_bytes() == full_bytes
    finally:
        if scope:
            scope.close()
            host.close()
        else:
            report.ctx.unload()
