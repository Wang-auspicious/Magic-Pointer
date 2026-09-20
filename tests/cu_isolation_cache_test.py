import subprocess
import sys
import time
from types import SimpleNamespace

import pytest
from PIL import Image


def test_visual_cache_reuses_ocr_only_when_current_pixels_match(tmp_path, monkeypatch):
    from scripts import element_probe_bridge as bridge
    from app.vision import visual_element_cache
    monkeypatch.setattr(visual_element_cache, "_cache_path", lambda: tmp_path / "cache.json")
    pixels = Image.new("RGB", (400, 300), "white")
    calls = []
    monkeypatch.setattr(bridge, "_capture_visual_image", lambda window: pixels.copy(), raising=False)
    def ocr(window, **kwargs):
        calls.append(1)
        return [{"text": "old" if len(calls) == 1 else "new", "rect": [20, 20, 100, 30]}]
    monkeypatch.setattr(bridge, "_ocr_window_blocks", ocr)
    window = {"hwnd": 42, "bbox": [0, 0, 400, 300]}
    assert bridge._visual_element_at(window, 30, 30)["label"] == "old"
    assert bridge._visual_element_at(window, 30, 30)["label"] == "old"
    assert len(calls) == 1
    pixels.putpixel((30, 30), (0, 0, 0))
    assert bridge._visual_element_at(window, 30, 30)["label"] == "new"
    assert len(calls) == 2


def test_hung_uia_worker_is_terminated_at_deadline(monkeypatch):
    from app.desktop_actions import uia_worker
    from app.agent_runtime.errors import ActionFailure, FailureType
    real_popen = subprocess.Popen
    children = []
    def launch(*args, **kwargs):
        child = real_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(uia_worker.subprocess, "Popen", launch)
    started = time.monotonic()
    with pytest.raises(ActionFailure) as failure:
        uia_worker.request({"operation": "tree", "hwnd": 42}, timeout_s=0.15)
    assert failure.value.failure_type == FailureType.TIMEOUT
    assert time.monotonic() - started < 3
    assert children[0].poll() is not None


def test_default_uia_tree_and_act_use_isolated_request(monkeypatch):
    from app.desktop_actions import session, uia_worker
    calls = []
    monkeypatch.setattr(uia_worker, "request", lambda payload, **kwargs: calls.append(payload) or ([] if payload["operation"] == "tree" else {"ok": True}))
    assert session._live_elements(42) == []
    assert session._live_uia("read_value", {"hwnd": 42}, None) == {"ok": True}
    assert [call["operation"] for call in calls] == ["tree", "act"]
