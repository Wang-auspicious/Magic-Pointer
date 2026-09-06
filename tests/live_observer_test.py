from __future__ import annotations

from pathlib import Path

import pytest

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.live_observer import LiveObserver, SurfaceCapture
from app.agent_runtime.look_tool import LookTool
from app.agent_runtime.vision_backend import FileVisionBackend
from app.context_pack.sources import FragmentLocator, SourceRef


class _Vision:
    def __init__(self, text: str) -> None:
        self.text = text
        self.calls: list[tuple[bytes, str, int]] = []

    def describe(self, image_bytes: bytes, prompt: str, timeout_ms: int) -> dict:
        self.calls.append((image_bytes, prompt, timeout_ms))
        return {"text": self.text, "latency_ms": 7.5, "backend": "vision.fake"}


def _source() -> SourceRef:
    return SourceRef(
        source_id="source:surface",
        task_id="task:observe",
        kind="capture",
        title="Current document window",
        identity={"hwnd": 42},
        revision={"capturedAtMs": 1_000},
        capabilities=("read",),
        origin="user-pointed",
        parent_source_id=None,
    )


def test_look_keeps_old_frame_while_observe_sends_new_pixels_to_vision() -> None:
    historical_vision = _Vision("old frozen content")
    look = LookTool(
        historical_vision,
        capture=lambda _box: b"old-frame-bytes",
        captured_at="2026-09-05T01:02:03Z",
    )
    old = look.look("bbox:0,0,100,100", prompt="what was pointed at?")

    live_vision = _Vision("new current content")
    state_calls: list[str] = []
    capture_calls: list[str] = []

    def read_state(source: SourceRef, _locator: FragmentLocator | None) -> dict:
        state_calls.append(source.source_id)
        return {
            "snapshot_id": "live-snapshot-2",
            "windows": [{"hwnd": 42, "rect": [10, 20, 210, 120]}],
            "elements": [{"index": 1, "role": "Text", "name": "new current content"}],
            "used_backend": "uia.live",
        }

    def capture(source: SourceRef, state: dict, _locator: FragmentLocator | None) -> SurfaceCapture:
        capture_calls.append(f"{source.source_id}:{state['snapshot_id']}")
        return SurfaceCapture(b"new-frame-bytes", "gdi.test")

    observer = LiveObserver(
        source_resolver=lambda source_id: _source() if source_id == "source:surface" else None,
        state_reader=read_state,
        capture=capture,
        vision_backend=live_vision,
        now_ms=lambda: 2_000,
    )
    locator = FragmentLocator("visual-region", {"bbox": [0, 0, 100, 100]})
    current = observer.observe("source:surface", "what is visible now?", locator.to_dict())

    assert historical_vision.calls == [(b"old-frame-bytes", "what was pointed at?", 30_000)]
    assert "2026-09-05T01:02:03Z" in (old.value or "")
    assert old.captured_at_utc == "2026-09-05T01:02:03Z"
    assert live_vision.calls == [(b"new-frame-bytes", "what is visible now?", 30_000)]
    assert state_calls == ["source:surface"]
    assert capture_calls == ["source:surface:live-snapshot-2"]
    assert current["sourceId"] == "source:surface"
    assert current["snapshotId"] == "live-snapshot-2"
    assert current["observedAtMs"] == 2_000
    assert current["locator"] == locator.to_dict()
    assert current["vision"]["text"] == "new current content"
    assert current["coverage"]["complete"] is True
    assert current["evidenceStatus"] == "ok"
    assert current["usedBackend"] == "uia.live+gdi.test+vision.fake"


def test_unknown_or_unbound_source_fails_before_state_or_capture() -> None:
    calls: list[str] = []
    observer = LiveObserver(
        source_resolver=lambda _source_id: None,
        state_reader=lambda *_args: calls.append("state") or {},
        capture=lambda *_args: calls.append("capture") or SurfaceCapture(b"pixels", "fake"),
        vision_backend=_Vision("unused"),
    )

    with pytest.raises(ActionFailure) as caught:
        observer.observe("source:not-in-task", "look")

    assert caught.value.failure_type is FailureType.PERMISSION_DENIED
    assert calls == []


def test_file_vision_backend_forwards_timeout_and_removes_transient_file(tmp_path: Path) -> None:
    observed: dict[str, object] = {}

    def ask(path: Path, prompt: str, *, timeout_s: float, attempts: int) -> str:
        observed.update({
            "path": path,
            "existsDuringCall": path.exists(),
            "bytes": path.read_bytes(),
            "prompt": prompt,
            "timeoutS": timeout_s,
            "attempts": attempts,
        })
        return "vision answer"

    backend = FileVisionBackend(ask=ask, temporary_directory=tmp_path, backend_name="vision.test")
    result = backend.describe(b"png bytes", "inspect this", 12_500)

    assert result["text"] == "vision answer"
    assert result["backend"] == "vision.test"
    assert observed["existsDuringCall"] is True
    assert observed["bytes"] == b"png bytes"
    assert observed["prompt"] == "inspect this"
    assert observed["timeoutS"] == 12.5
    assert observed["attempts"] == 1
    assert not Path(observed["path"]).exists()
