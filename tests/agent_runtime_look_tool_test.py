"""Tests for the agent-runtime look tool (harness-gap L2: perception as a tool).

Covers the VisionBackend contract and LookTool behaviour:
- the crop box is decided by the anchor (``bbox:`` / ``element:`` forms), never
  the full screen; the backend receives exactly the crop for the passed box
- box size clamping (min/max side) -> ``box_out_of_bounds``, no upscale
- three-state failure mapping (VisionUnavailable / VisionTimeout / other ->
  unsupported / timeout / error) and the honest ``vision_not_configured`` path
  when no backend exists (zero backend calls)
- describe_capabilities: trajectory hints take priority, output stays 3-8
- registration: look is read / not concurrency-safe, describe_capabilities is
  read / concurrency-safe; schema export; execution through the registry

All backends are fakes; no real vision model, screen or network is touched.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.look_tool import (  # noqa: E402
    LookTool,
    VisionTimeout,
    VisionUnavailable,
)
from app.agent_runtime.tool_registry import (  # noqa: E402
    Effect,
    ToolRegistry,
)
from app.evidence.contract import EvidenceSource, EvidenceStatus  # noqa: E402

FULL_SCREEN_BYTES = b"crop:0,0,1920,1080"


def crop_bytes(box: tuple[int, int, int, int]) -> bytes:
    return b"crop:%d,%d,%d,%d" % box


class FakeVisionBackend:
    """Records every describe call; returns a canned result or raises."""

    def __init__(
        self,
        text: str = "a dialog with an OK button",
        latency_ms: float = 42.0,
        backend: str = "fake-vision",
        exc: Exception | None = None,
    ) -> None:
        self.text = text
        self.latency_ms = latency_ms
        self.backend = backend
        self.exc = exc
        self.calls: list[dict] = []

    def describe(self, image_bytes: bytes, prompt: str, timeout_ms: int) -> dict:
        self.calls.append(
            {"image_bytes": image_bytes, "prompt": prompt, "timeout_ms": timeout_ms}
        )
        if self.exc is not None:
            raise self.exc
        return {
            "text": self.text,
            "latency_ms": self.latency_ms,
            "backend": self.backend,
        }


# --- look: success path -------------------------------------------------------


def test_look_success_passes_exact_crop_to_backend():
    backend = FakeVisionBackend()
    tool = LookTool(backend)
    box = (10, 20, 110, 220)
    ev = tool.look(anchor="bbox:10,20,110,220", box_ltrb=box, prompt="what is this")

    assert ev.status is EvidenceStatus.OK
    assert "a dialog with an OK button" in (ev.value or "")
    assert "historical" in (ev.value or "").casefold()
    assert ev.source is EvidenceSource.VISION
    assert ev.latency_ms == 42.0
    assert "fake-vision" in (ev.note or "")
    assert "frame=historical" in (ev.note or "")
    assert "10,20,110,220" in (ev.note or "")

    assert len(backend.calls) == 1
    call = backend.calls[0]
    assert call["image_bytes"] == crop_bytes(box)
    assert call["prompt"] == "what is this"
    assert call["timeout_ms"] == 30000


def test_look_bbox_anchor_decides_crop_and_is_not_fullscreen():
    backend = FakeVisionBackend()
    tool = LookTool(backend)
    ev = tool.look(anchor="bbox:10,20,110,220")

    assert ev.status is EvidenceStatus.OK
    assert len(backend.calls) == 1
    assert backend.calls[0]["image_bytes"] == b"crop:10,20,110,220"
    assert backend.calls[0]["image_bytes"] != FULL_SCREEN_BYTES


def test_look_element_anchor_resolves_via_resolver():
    backend = FakeVisionBackend()
    tool = LookTool(backend)
    ev = tool.look(
        anchor="element:abc",
        resolver=lambda a: (10, 20, 110, 220) if a == "element:abc" else None,
    )

    assert ev.status is EvidenceStatus.OK
    assert backend.calls[0]["image_bytes"] == b"crop:10,20,110,220"


# --- look: honest failure paths -----------------------------------------------


def test_look_resolver_miss_is_honest_error():
    backend = FakeVisionBackend()
    tool = LookTool(backend)
    ev = tool.look(anchor="element:ghost", resolver=lambda a: None)

    assert ev.status is EvidenceStatus.ERROR
    assert "anchor_resolve_failed" in (ev.note or "")
    assert backend.calls == []


def test_look_no_box_and_no_bbox_anchor_fails_honestly():
    backend = FakeVisionBackend()
    tool = LookTool(backend)
    ev = tool.look(anchor="element:abc")

    assert ev.status is EvidenceStatus.ERROR
    assert "anchor_resolve_failed" in (ev.note or "")
    assert backend.calls == []


def test_look_malformed_bbox_anchor_fails():
    backend = FakeVisionBackend()
    tool = LookTool(backend)
    ev = tool.look(anchor="bbox:1,2,3")

    assert ev.status is EvidenceStatus.ERROR
    assert "invalid_anchor_format" in (ev.note or "")
    assert backend.calls == []


def test_look_box_too_small_rejected_no_upscale():
    backend = FakeVisionBackend()
    tool = LookTool(backend, min_box_side=32)
    ev = tool.look(anchor="bbox:0,0,100,100", box_ltrb=(0, 0, 10, 10))

    assert ev.status is EvidenceStatus.ERROR
    assert "box_out_of_bounds" in (ev.note or "")
    assert backend.calls == []


def test_look_box_too_large_rejected():
    backend = FakeVisionBackend()
    tool = LookTool(backend, max_box_side=4096)
    ev = tool.look(anchor="bbox:0,0,100,100", box_ltrb=(0, 0, 5000, 5000))

    assert ev.status is EvidenceStatus.ERROR
    assert "box_out_of_bounds" in (ev.note or "")
    assert backend.calls == []


def test_look_small_valid_box_accepted():
    backend = FakeVisionBackend()
    tool = LookTool(backend, min_box_side=32, max_box_side=4096)
    ev = tool.look(anchor="bbox:0,0,100,100", box_ltrb=(0, 0, 100, 100))

    assert ev.status is EvidenceStatus.OK
    assert backend.calls[0]["image_bytes"] == b"crop:0,0,100,100"


# --- look: three-state failure mapping ----------------------------------------


def test_look_vision_unavailable_maps_to_unsupported():
    backend = FakeVisionBackend(exc=VisionUnavailable("no model loaded"))
    tool = LookTool(backend)
    ev = tool.look(anchor="bbox:0,0,100,100")

    assert ev.status is EvidenceStatus.UNSUPPORTED
    assert "vision_unavailable" in (ev.note or "")


def test_look_vision_timeout_maps_to_timeout():
    backend = FakeVisionBackend(exc=VisionTimeout("model too slow"))
    tool = LookTool(backend)
    ev = tool.look(anchor="bbox:0,0,100,100")

    assert ev.status is EvidenceStatus.TIMEOUT
    assert "vision_timeout" in (ev.note or "")


def test_look_vision_other_error_maps_to_error():
    backend = FakeVisionBackend(exc=RuntimeError("connection reset"))
    tool = LookTool(backend)
    ev = tool.look(anchor="bbox:0,0,100,100")

    assert ev.status is EvidenceStatus.ERROR
    assert "vision_error" in (ev.note or "")


def test_look_no_backend_unsupported_and_zero_calls():
    backend = FakeVisionBackend()
    tool = LookTool(None)
    ev = tool.look(anchor="bbox:0,0,100,100")

    assert ev.status is EvidenceStatus.UNSUPPORTED
    assert "vision_not_configured" in (ev.note or "")
    assert backend.calls == []


# --- describe_capabilities ----------------------------------------------------


def test_capabilities_hints_take_priority():
    tool = LookTool(FakeVisionBackend())
    ev = tool.describe_capabilities(
        "element:abc", trajectory_hints=["expand", "translate", "explain"]
    )

    assert ev.status is EvidenceStatus.OK
    assert json.loads(ev.value) == ["expand", "translate", "explain"]


def test_capabilities_default_list_when_no_hints():
    tool = LookTool(FakeVisionBackend())
    ev = tool.describe_capabilities("element:abc")

    assert ev.status is EvidenceStatus.OK
    assert json.loads(ev.value) == [
        "translate",
        "explain",
        "expand",
        "summarize",
        "ocr_copy",
    ]


def test_capabilities_stays_within_3_to_8():
    tool = LookTool(FakeVisionBackend())
    many = [f"hint_{i}" for i in range(10)]
    ev_many = tool.describe_capabilities("element:abc", trajectory_hints=many)
    got_many = json.loads(ev_many.value)
    assert len(got_many) == 8
    assert got_many == many[:8]

    ev_one = tool.describe_capabilities("element:abc", trajectory_hints=["only_one"])
    got_one = json.loads(ev_one.value)
    assert len(got_one) == 3
    assert got_one[0] == "only_one"


# --- registration + registry execution ----------------------------------------


def test_register_exports_look_and_capabilities_specs():
    registry = ToolRegistry()
    tool = LookTool(FakeVisionBackend())
    tool.register(registry)

    look = registry.get("look")
    caps = registry.get("describe_capabilities")
    assert "frozen" in look.description.casefold()
    assert "get_app_state" in look.description
    assert look.effect is Effect.READ
    assert look.is_concurrency_safe is False
    assert caps.effect is Effect.READ
    assert caps.is_concurrency_safe is True
    assert [s.name for s in registry.list()] == ["look", "describe_capabilities"]

    schemas = registry.schemas_for_model()
    look_params = next(s["parameters"] for s in schemas if s["name"] == "look")
    assert "anchor" in look_params["required"]

    parallel, sequential = registry.concurrency_partition(
        ["look", "describe_capabilities", "look"]
    )
    assert parallel == ["describe_capabilities"]
    assert sequential == ["look", "look"]


def test_registry_execute_look_returns_tool_result():
    registry = ToolRegistry()
    tool = LookTool(FakeVisionBackend())
    tool.register(registry)

    res = registry.execute_tool("look", {"anchor": "bbox:0,0,100,100"})
    assert res.is_error is False
    assert "a dialog with an OK button" in res.value.value
    assert "historical" in res.value.value.casefold()
    assert res.value.status is EvidenceStatus.OK
    assert res.used_backend == "vision"
    assert res.latency_ms is not None

    res_box = registry.execute_tool(
        "look", {"anchor": "bbox:0,0,50,50", "box": [10, 20, 110, 220]}
    )
    assert res_box.is_error is False
    assert res_box.used_backend == "vision"

    res_caps = registry.execute_tool("describe_capabilities", {"anchor": "element:x"})
    assert res_caps.is_error is False
    assert len(json.loads(res_caps.value.value)) == 5


def test_look_quota_is_honest_about_exhaustion():
    """Each look is a real vision call (seconds + money). A model that spams
    it must get an honest unsupported receipt, not an infinite budget."""
    backend = FakeVisionBackend()
    tool = LookTool(backend, max_calls=2)
    assert tool.look(anchor="bbox:0,0,100,100").status is EvidenceStatus.OK
    assert tool.look(anchor="bbox:0,0,100,100").status is EvidenceStatus.OK
    third = tool.look(anchor="bbox:0,0,100,100")
    assert third.status is EvidenceStatus.UNSUPPORTED
    assert "look_quota_exhausted" in (third.note or "")
    assert len(backend.calls) == 2, "配额耗尽后不得再打视觉后端"
