
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.agent_runtime.look_tool import LookTool, VisionUnavailable  # noqa: E402
from app.agent_runtime.vision_backend import UploadDeniedVisionBackend  # noqa: E402

BRIDGE = (
    Path(__file__).resolve().parents[1] / "scripts" / "selection_bridge.py"
).read_text(encoding="utf-8")


def _denied() -> UploadDeniedVisionBackend:
    return UploadDeniedVisionBackend()


def test_the_denied_backend_refuses_any_image() -> None:
    with pytest.raises(VisionUnavailable) as raised:
        _denied().describe(b"png", "describe this", 1000)
    assert "screenshot_upload_disabled" in str(raised.value)


def test_the_refusal_says_privacy_not_misconfiguration() -> None:
    evidence = LookTool(backend=_denied()).look("bbox:0,0,400,300")
    assert evidence.status.value == "unsupported"
    note = str(evidence.note or "")
    assert "screenshot_upload_disabled" in note
    assert "vision_not_configured" not in note


def test_the_backend_is_decided_by_the_capture_policy() -> None:
    assert "capture_policy.get(\"allowUpload\")" in BRIDGE
    assert "FileVisionBackend() if vision_upload_allowed" in BRIDGE
    assert "else UploadDeniedVisionBackend()" in BRIDGE


def test_the_gate_covers_the_automatic_look_too() -> None:
    assert "has_vision=vision_upload_allowed," in BRIDGE
    assert "has_vision=runtime.get(\"vision_backend\") is not None" not in BRIDGE


def test_the_gate_is_the_only_place_a_backend_is_built() -> None:
    assert BRIDGE.count("FileVisionBackend()") == 1
