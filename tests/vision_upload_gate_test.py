"""截图上传开关必须真的管住截图。

`privacy.upload_screenshots` 以前只管 fabric 那条中继：`Look` 和 `Observe` 共用
`runtime["vision_backend"]`，而那个后端是无条件构造的，所以开关写着关，冻结帧照样
发给模型。开关写着关而图还是出去了，比没有这个开关更糟——用户以为自己关掉了。

闸门只有一个：`selection_bridge` 按快照里的 `capture_policy.allowUpload` 决定注入
哪个后端。堵在这里，Look 和 Observe 一起堵住。
"""

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
    """`vision_not_configured` 会把人引去查模型配置；真正的原因是隐私开关。"""
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
    """自动 look_once 不走模型的判断，所以它得看同一个闸门，不能自己另判一次。"""
    assert "has_vision=vision_upload_allowed," in BRIDGE
    assert "has_vision=runtime.get(\"vision_backend\") is not None" not in BRIDGE


def test_the_gate_is_the_only_place_a_backend_is_built() -> None:
    """再造一个 FileVisionBackend 就等于在闸门旁边开了个洞。"""
    assert BRIDGE.count("FileVisionBackend()") == 1
