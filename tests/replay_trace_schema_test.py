from __future__ import annotations

import pytest

from app.replay.trace_schema import (
    SCHEMA_VERSION,
    CdpSnapshot,
    DesktopTrace,
    FocusEvent,
    PointerSample,
    TraceFrame,
    UiaSnapshot,
)


def _sample_frame(frame_id: str = "frame-1") -> TraceFrame:
    return TraceFrame(
        frame_id=frame_id,
        png_path="frames/frame-1.png",
        captured_at_utc="2026-08-12T10:00:00.000000Z",
        display_bounds_ltrb=(0, 0, 1920, 1080),
        dpi=192.0,
        scale_factor=2.0,
    )


def _sample_pointer() -> PointerSample:
    return PointerSample(t_utc="2026-08-12T10:00:01.000000Z", x=120, y=340, phase="down", buttons=1)


def _sample_uia() -> UiaSnapshot:
    return UiaSnapshot(
        snapshot_id="uia-1",
        tree_text=None,
        tree_path="uia/uia-1.txt",
        captured_at_utc="2026-08-12T10:00:02.000000Z",
        window_hwnd=98765,
        pid=1234,
        note="notepad main window",
    )


def _sample_trace() -> DesktopTrace:
    return DesktopTrace(
        trace_id="trace-demo-1",
        recorded_at_utc="2026-08-12T10:00:00.000000Z",
        frames=[_sample_frame(), _sample_frame("frame-2")],
        uia_snapshots=[_sample_uia()],
        pointer_trace=[_sample_pointer()],
        cdp_snapshots=[
            CdpSnapshot(
                snapshot_id="cdp-1",
                url="https://example.com/",
                text_dump="Example Domain",
                captured_at_utc="2026-08-12T10:00:03.000000Z",
            )
        ],
        focus_events=[
            FocusEvent(
                t_utc="2026-08-12T10:00:00.500000Z",
                hwnd=98765,
                title="Untitled - Notepad",
                process_name="notepad.exe",
            )
        ],
        display_config={"monitors": [{"device": "\\\\.\\DISPLAY1", "bounds_ltrb": [0, 0, 1920, 1080]}]},
        ground_truth={
            "user_intent": "圈中记事本里的第二行",
            "expected_anchor": {"window_title": "Untitled - Notepad", "line_index": 2},
            "expected_result": "Hello world",
        },
    )


def test_schema_version_is_one() -> None:
    assert SCHEMA_VERSION == 1
    assert _sample_trace().schema_version == 1


def test_full_round_trip_is_stable() -> None:
    trace = _sample_trace()
    restored = DesktopTrace.from_dict(trace.to_dict())
    assert restored == trace


def test_minimal_trace_round_trip() -> None:
    trace = DesktopTrace(trace_id="empty", recorded_at_utc="2026-08-12T10:00:00.000000Z")
    restored = DesktopTrace.from_dict(trace.to_dict())
    assert restored == trace
    assert restored.frames == []
    assert restored.uia_snapshots == []
    assert restored.pointer_trace == []
    assert restored.cdp_snapshots == []
    assert restored.focus_events == []
    assert restored.display_config == {}
    assert restored.ground_truth is None


def test_round_trip_serializes_as_plain_json_types() -> None:
    import json

    payload = _sample_trace().to_dict()
    json.dumps(payload)
    assert isinstance(payload["display_bounds_ltrb"] if False else payload["frames"][0]["display_bounds_ltrb"], list)


def test_unknown_top_level_field_rejected() -> None:
    payload = _sample_trace().to_dict()
    payload["surprise"] = 1
    with pytest.raises(ValueError, match="surprise"):
        DesktopTrace.from_dict(payload)


def test_unknown_nested_field_rejected() -> None:
    payload = _sample_trace().to_dict()
    payload["frames"][0]["opacity"] = 0.5
    with pytest.raises(ValueError, match="opacity"):
        DesktopTrace.from_dict(payload)


def test_missing_required_field_rejected() -> None:
    payload = _sample_trace().to_dict()
    del payload["trace_id"]
    with pytest.raises(ValueError, match="trace_id"):
        DesktopTrace.from_dict(payload)


def test_unsupported_schema_version_rejected() -> None:
    payload = _sample_trace().to_dict()
    payload["schema_version"] = 2
    with pytest.raises(ValueError, match="schema_version"):
        DesktopTrace.from_dict(payload)


def test_invalid_pointer_phase_rejected() -> None:
    payload = _sample_trace().to_dict()
    payload["pointer_trace"][0]["phase"] = "click"
    with pytest.raises(ValueError, match="phase"):
        DesktopTrace.from_dict(payload)


def test_invalid_pointer_buttons_rejected() -> None:
    payload = _sample_trace().to_dict()
    payload["pointer_trace"][0]["buttons"] = -1
    with pytest.raises(ValueError, match="buttons"):
        DesktopTrace.from_dict(payload)


def test_bbox_must_have_four_ints() -> None:
    payload = _sample_trace().to_dict()
    payload["frames"][0]["display_bounds_ltrb"] = [0, 0, 1920]
    with pytest.raises(ValueError, match="display_bounds_ltrb"):
        DesktopTrace.from_dict(payload)


def test_uia_snapshot_requires_text_or_path() -> None:
    payload = _sample_trace().to_dict()
    payload["uia_snapshots"][0]["tree_text"] = None
    payload["uia_snapshots"][0]["tree_path"] = None
    with pytest.raises(ValueError, match="tree_text|tree_path"):
        DesktopTrace.from_dict(payload)


def test_uia_snapshot_inline_text_round_trip() -> None:
    snapshot = UiaSnapshot(
        snapshot_id="uia-2",
        tree_text="Window 'Untitled - Notepad'\n  Edit ''",
        captured_at_utc="2026-08-12T10:00:04.000000Z",
        window_hwnd=98765,
        pid=1234,
        note=None,
    )
    assert UiaSnapshot.from_dict(snapshot.to_dict()) == snapshot
    assert snapshot.to_dict()["tree_path"] is None


def test_ground_truth_none_and_dict_round_trip() -> None:
    assert DesktopTrace.from_dict(_sample_trace().to_dict()).ground_truth == _sample_trace().ground_truth
    none_trace = DesktopTrace(trace_id="t", recorded_at_utc="2026-08-12T10:00:00.000000Z", ground_truth=None)
    assert DesktopTrace.from_dict(none_trace.to_dict()).ground_truth is None


def test_display_config_must_be_dict() -> None:
    payload = _sample_trace().to_dict()
    payload["display_config"] = [1, 2]
    with pytest.raises(ValueError, match="display_config"):
        DesktopTrace.from_dict(payload)
