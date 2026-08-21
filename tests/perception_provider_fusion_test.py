"""Provider protocol + fusion: the seam that lets a second evidence class in.

The structured broker already fans out. What it could not do was let a pixel
provider join the same read on the same frozen frame, which is why a UIA
container name used to be replaced wholesale by an OCR context in a different
process — with nobody able to see that two sources had spoken.
"""

from __future__ import annotations

import threading

from app.adapters.base import AdapterReadContext
from app.evidence.contract import EvidenceStatus
from app.perception.broker import PerceptionBroker
from app.perception.fusion import fuse_observations, texts_agree
from app.perception.providers import (
    TIER_PIXEL,
    TIER_STRUCTURED,
    PerceptionObservation,
    PerceptionRequest,
    ProviderDescriptor,
    ProviderResult,
)

WINDOW = {
    "hwnd": 4242,
    "title": "PowerShell",
    "process_name": "powershell.exe",
    "class_name": "ConsoleWindowClass",
    "bbox": [0, 0, 1000, 800],
}
MARK = (100, 400, 300, 20)
CONTAINER_RECT = [0, 0, 1000, 760]
LINE_RECT = [100, 400, 300, 20]
# What UIA actually returned for a stroke across one console line on
# 2026-08-04: the container telling us its own name.
CONSOLE_EXE_PATH = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"


def _context(
    adapter: str,
    content: str,
    *,
    rects: list[list[int]] | None = None,
    error: str | None = None,
) -> AdapterReadContext:
    return AdapterReadContext(
        adapter=adapter,
        app="test",
        window=dict(WINDOW),
        content=content,
        label=adapter,
        method=f"synthetic:{adapter}",
        artifacts={"selection_rectangles": list(rects or [])},
        error=error,
    )


class _FakeProvider:
    def __init__(
        self,
        descriptor: ProviderDescriptor,
        result: ProviderResult,
        *,
        calls: list[str] | None = None,
        stall: threading.Event | None = None,
    ) -> None:
        self.descriptor = descriptor
        self._result = result
        self.calls = calls if calls is not None else []
        self._stall = stall

    def read(self, request: PerceptionRequest) -> ProviderResult:
        self.calls.append(self.descriptor.id)
        if self._stall is not None:
            self._stall.wait(timeout=5.0)
        return self._result


def _structured(
    provider_id: str,
    content: str,
    *,
    rects: list[list[int]] | None = None,
    layer: str = "uia",
    priority: int = 30,
    error: str | None = None,
    status: EvidenceStatus | None = None,
    reason: str = "",
    calls: list[str] | None = None,
) -> _FakeProvider:
    return _FakeProvider(
        ProviderDescriptor(
            id=provider_id,
            layer=layer,
            tier=TIER_STRUCTURED,
            priority=priority,
        ),
        ProviderResult(
            context=_context(provider_id, content, rects=rects, error=error),
            status=status,
            reason=reason,
        ),
        calls=calls,
    )


def _pixel(
    provider_id: str,
    content: str,
    *,
    rects: list[list[int]] | None = None,
    calls: list[str] | None = None,
) -> _FakeProvider:
    return _FakeProvider(
        ProviderDescriptor(
            id=provider_id,
            layer="ocr",
            tier=TIER_PIXEL,
            priority=40,
            requires_frozen_pixels=True,
        ),
        ProviderResult(context=_context(provider_id, content, rects=rects)),
        calls=calls,
    )


def _request(**overrides: object) -> PerceptionRequest:
    values: dict[str, object] = {
        "window": dict(WINDOW),
        "mark_bbox": MARK,
        "frame_lease_id": "frame_test",
        "frozen_artifact_path": "C:/frozen/frame.png",
    }
    values.update(overrides)
    return PerceptionRequest(**values)  # type: ignore[arg-type]


def test_pixel_provider_is_never_started_when_structured_covers_the_mark() -> None:
    """A clean structured read must not spend OCR CPU on the frozen frame.

    Concurrency is not "always launch every source" (blueprint §7.3): the
    expensive tier is planned, and a Notepad read that already has exact text
    has nothing to gain from recognising its own pixels.
    """
    calls: list[str] = []
    structured = _structured(
        "uia-line",
        "Get-ChildItem failed because the path does not exist",
        rects=[LINE_RECT],
        calls=calls,
    )
    pixels = _pixel("frozen-ocr", "should not run", rects=[LINE_RECT], calls=calls)

    result = PerceptionBroker().resolve(_request(), [structured, pixels])

    assert calls == ["uia-line"]
    assert result.selected is not None
    assert result.selected.provider_id == "uia-line"
    assert result.trace["pixelFallbackUsed"] is False
    assert [item["providerId"] for item in result.trace["observations"]] == ["uia-line"]


def test_container_only_structured_read_is_superseded_but_never_erased() -> None:
    """The 2026-08-04 failure, expressed as evidence instead of replacement.

    UIA answered with the console's own executable path. Today that content is
    thrown away and an OCR context takes its place in another process. It must
    instead lose on merit and stay visible as a container observation.

    The supersession is a note, not a conflict: the two sources do not disagree
    about content, one of them answered about the surface. Filing it as a
    conflict would put a confirmation prompt in front of every pixel-only app.
    """
    container = _structured("uia-container", CONSOLE_EXE_PATH, rects=[CONTAINER_RECT])
    body = _pixel(
        "frozen-ocr",
        "Get-ChildItem failed because the path does not exist",
        rects=[LINE_RECT],
    )

    result = PerceptionBroker().resolve(_request(), [container, body])

    assert result.selected is not None
    assert result.selected.provider_id == "frozen-ocr"
    assert result.context is not None
    assert result.context.content.startswith("Get-ChildItem failed")
    by_provider = {item.provider_id: item for item in result.observations}
    assert set(by_provider) == {"uia-container", "frozen-ocr"}
    assert by_provider["uia-container"].container_hint is True
    assert by_provider["uia-container"].covers_mark is False
    assert by_provider["uia-container"].coverage_reason == "identity_only"
    assert result.trace["pixelFallbackUsed"] is True
    assert result.trace["fallbackReason"] == "structured_container_only"
    assert result.trace["conflicts"] == []
    assert result.trace["notes"] == [{
        "kind": "structured_superseded",
        "sources": ["uia-container"],
        "reason": "identity_only",
    }]


def test_agreeing_cross_tier_reads_are_corroboration_not_disagreement() -> None:
    """OCR noise is not disagreement; a different number is."""
    structured = _structured(
        "uia-line",
        "Get-ChildItem failed because the path does not exist",
        rects=[LINE_RECT],
    )
    observations = (
        _observation(structured, index=0),
        _observation(
            _pixel(
                "frozen-ocr",
                "Get-Childltem failed because the path does not exist",
                rects=[LINE_RECT],
            ),
            index=1,
        ),
    )

    fused = fuse_observations(observations)

    assert fused.conflicts == ()
    assert [item["kind"] for item in fused.corroborations] == ["content_agreement"]
    assert fused.corroborations[0]["sources"] == ["uia-line", "frozen-ocr"]
    assert fused.selected is not None
    assert fused.selected.provider_id == "uia-line"


def test_same_shape_different_numbers_stay_a_conflict() -> None:
    assert texts_agree("Invoice total: 120", "Invoice total: 120") is True
    assert texts_agree("Invoice total: 120", "invoice  total:  120") is True
    assert texts_agree("Invoice total: 120", "Invoice total: 210") is False
    assert texts_agree(
        "Get-ChildItem failed because the path does not exist",
        "Get-Childltem failed because the path does not exist",
    ) is True


def test_unread_structured_sources_start_the_pixel_tier_without_faking_empty() -> None:
    calls: list[str] = []
    timed_out = _structured(
        "uia-line",
        "",
        error="UIA probe timed out",
        calls=calls,
    )
    body = _pixel("frozen-ocr", "the underlined line", rects=[LINE_RECT], calls=calls)

    result = PerceptionBroker().resolve(_request(), [timed_out, body])

    assert calls == ["uia-line", "frozen-ocr"]
    by_provider = {item.provider_id: item for item in result.observations}
    assert by_provider["uia-line"].status is EvidenceStatus.TIMEOUT
    assert result.selected is not None
    assert result.selected.provider_id == "frozen-ocr"
    assert result.trace["readState"] == "resolved"


def test_every_source_unread_is_reported_unread_not_empty_confirmed() -> None:
    result = PerceptionBroker().resolve(
        _request(),
        [
            _structured("uia-line", "", error="UIA probe timed out"),
            _FakeProvider(
                ProviderDescriptor(
                    id="frozen-ocr",
                    layer="ocr",
                    tier=TIER_PIXEL,
                    priority=40,
                    requires_frozen_pixels=True,
                ),
                ProviderResult(
                    context=None,
                    status=EvidenceStatus.BUSY,
                    reason="ocr_worker_busy",
                ),
            ),
        ],
    )

    assert result.selected is None
    assert result.trace["readState"] == "unread"
    assert [item.status.value for item in result.observations] == ["timeout", "busy"]


def test_pixel_provider_without_a_frozen_frame_is_unsupported_not_live_capture() -> None:
    """No lease means no pixels. Grabbing the live screen here would certify a
    post-gesture frame as the moment the user pointed at."""
    calls: list[str] = []
    pixels = _pixel("frozen-ocr", "live screen text", rects=[LINE_RECT], calls=calls)

    result = PerceptionBroker().resolve(
        _request(frame_lease_id=None, frozen_artifact_path=None),
        [_structured("uia-line", "", error="probe timeout", calls=calls), pixels],
    )

    assert calls == ["uia-line"]
    by_provider = {item.provider_id: item for item in result.observations}
    assert by_provider["frozen-ocr"].status is EvidenceStatus.UNSUPPORTED
    assert by_provider["frozen-ocr"].reason == "frozen_pixels_unavailable"
    assert result.selected is None


def test_a_stalled_provider_cannot_hold_the_verdict_past_its_deadline() -> None:
    release = threading.Event()
    stalled = _FakeProvider(
        ProviderDescriptor(id="native-stalled", layer="native_app", priority=10),
        ProviderResult(context=_context("native-stalled", "never arrives")),
        stall=release,
    )
    responsive = _structured("uia-line", "真实内容", rects=[LINE_RECT])
    try:
        result = PerceptionBroker().resolve(
            _request(),
            [stalled, responsive],
            deadline_ms=120,
        )
        by_provider = {item.provider_id: item for item in result.observations}
        assert by_provider["native-stalled"].status is EvidenceStatus.TIMEOUT
        assert by_provider["native-stalled"].reason == "deadline_exceeded"
        assert result.selected is not None
        assert result.selected.provider_id == "uia-line"
    finally:
        release.set()


def test_observations_survive_a_trace_round_trip_and_fuse_the_same_way() -> None:
    """The plan spans two processes; the verdict must not.

    The snapshot bridge owns the frozen frame and the structured tier; the
    answer bridge adds the pixel tier. Both must reach the same verdict from
    the same fusion, or "one perception truth" is a slogan.
    """
    container = _observation(
        _structured("uia-container", CONSOLE_EXE_PATH, rects=[CONTAINER_RECT]),
        index=0,
    )
    rehydrated = PerceptionObservation.from_trace_dict(container.to_trace_dict())

    assert rehydrated.provider_id == "uia-container"
    assert rehydrated.container_hint is True
    assert rehydrated.covers_mark is False
    assert rehydrated.context is None

    body = _observation(
        _pixel(
            "frozen-ocr",
            "Get-ChildItem failed because the path does not exist",
            rects=[LINE_RECT],
        ),
        index=1,
    )
    fused = fuse_observations((rehydrated, body))

    assert fused.selected is not None
    assert fused.selected.provider_id == "frozen-ocr"
    assert fused.conflicts == ()
    assert [item["kind"] for item in fused.notes] == ["structured_superseded"]
    assert fused.trace["fallbackReason"] == "structured_container_only"


def _observation(provider: _FakeProvider, *, index: int) -> PerceptionObservation:
    return PerceptionBroker().observe(provider, _request(), index=index)
