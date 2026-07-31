from __future__ import annotations

import queue
import threading

import numpy as np
import pytest

from scripts import local_voice_bridge
from scripts.local_voice_bridge import (
    SAMPLE_RATE,
    VoiceProfile,
    run_microphone_with_model,
    select_whisper_cpu_threads,
)


class _NoopInputStream:
    def __init__(self, **_kwargs: object) -> None:
        pass

    def __enter__(self) -> _NoopInputStream:
        return self

    def __exit__(self, *_args: object) -> None:
        pass


class _ScriptedBlocks:
    def __init__(self, items: list[np.ndarray | BaseException]) -> None:
        self._items = list(items)
        self.get_count = 0
        self.pump_advanced = threading.Event()

    def get(self, *, timeout: float) -> np.ndarray:
        assert timeout == 2.0
        self.get_count += 1
        if self.get_count >= 14:
            self.pump_advanced.set()
        item = self._items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    def put_nowait(self, _block: np.ndarray) -> None:
        raise AssertionError("the no-op input stream must not invoke its callback")


def _speech_block() -> np.ndarray:
    return np.full(SAMPLE_RATE // 10, 0.08, dtype=np.float32)


def _run_scripted_microphone(
    monkeypatch: pytest.MonkeyPatch,
    *,
    blocks: _ScriptedBlocks,
    model: object,
    events: list[tuple[str, dict[str, object]]],
) -> int:
    monkeypatch.setattr(local_voice_bridge.queue, "Queue", lambda maxsize: blocks)
    return run_microphone_with_model(
        model=model,
        model_name="fake",
        profile=VoiceProfile(language="en"),
        silence_ms=5_000,
        stop_state=lambda _activity: "final" if blocks.get_count >= 14 else None,
        event_sink=lambda kind, payload: events.append((kind, payload)),
        input_stream_factory=_NoopInputStream,
    )


def test_default_whisper_threads_use_available_logical_cpu_capacity() -> None:
    assert select_whisper_cpu_threads(logical_cpu_count=1, environment={}) == 1
    assert select_whisper_cpu_threads(logical_cpu_count=8, environment={}) == 8
    assert select_whisper_cpu_threads(logical_cpu_count=16, environment={}) == 12


def test_whisper_thread_override_accepts_only_the_safe_range() -> None:
    environment = {"MAGIC_POINTER_WHISPER_THREADS": "8"}
    assert select_whisper_cpu_threads(logical_cpu_count=16, environment=environment) == 8

    assert select_whisper_cpu_threads(
        logical_cpu_count=4,
        environment={"MAGIC_POINTER_WHISPER_THREADS": "5"},
    ) == 4
    assert select_whisper_cpu_threads(
        logical_cpu_count=16,
        environment={"MAGIC_POINTER_WHISPER_THREADS": "13"},
    ) == 12


@pytest.mark.parametrize("value", ("0", "-1", " 8", "8.0", "eight", ""))
def test_invalid_whisper_thread_override_falls_back_to_safe_default(value: str) -> None:
    assert select_whisper_cpu_threads(
        logical_cpu_count=16,
        environment={"MAGIC_POINTER_WHISPER_THREADS": value},
    ) == 12


def test_whisper_thread_selection_has_a_safe_cpu_detection_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(local_voice_bridge, "available_logical_cpu_count", lambda: None)
    assert select_whisper_cpu_threads(logical_cpu_count=None, environment={}) == 4
    assert select_whisper_cpu_threads(logical_cpu_count=0, environment={}) == 4


def test_microphone_capture_recovers_when_the_audio_queue_is_temporarily_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Model:
        def transcribe(self, _audio: np.ndarray, **_options: object) -> dict[str, object]:
            return {"text": "finished", "segments": []}

    blocks = _ScriptedBlocks([queue.Empty(), *[_speech_block() for _ in range(14)]])
    events: list[tuple[str, dict[str, object]]] = []

    result = _run_scripted_microphone(
        monkeypatch,
        blocks=blocks,
        model=Model(),
        events=events,
    )

    assert result == 0
    assert events[-1] == (
        "final",
        {"transcript": "finished", "engine": "whisper-fake-local"},
    )


def test_partial_transcription_does_not_block_capture_and_finishes_before_final(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    partial_started = threading.Event()
    release_partial = threading.Event()

    class Model:
        def __init__(self) -> None:
            self.calls = 0
            self.active = 0
            self.max_active = 0
            self.lock = threading.Lock()

        def transcribe(self, _audio: np.ndarray, **_options: object) -> dict[str, object]:
            with self.lock:
                self.calls += 1
                call_number = self.calls
                self.active += 1
                self.max_active = max(self.max_active, self.active)
            try:
                if call_number == 1:
                    partial_started.set()
                    assert release_partial.wait(2)
                    return {"text": "partial", "segments": []}
                return {"text": "final", "segments": []}
            finally:
                with self.lock:
                    self.active -= 1

    model = Model()
    blocks = _ScriptedBlocks([_speech_block() for _ in range(14)])
    events: list[tuple[str, dict[str, object]]] = []
    result: list[int] = []
    errors: list[BaseException] = []

    def run() -> None:
        try:
            result.append(
                _run_scripted_microphone(
                    monkeypatch,
                    blocks=blocks,
                    model=model,
                    events=events,
                )
            )
        except BaseException as exc:
            errors.append(exc)

    runner = threading.Thread(target=run)
    runner.start()
    assert partial_started.wait(1)
    pump_advanced_while_partial_was_running = blocks.pump_advanced.wait(0.4)
    assert not any(kind == "final" for kind, _payload in events)
    release_partial.set()
    runner.join(2)

    assert pump_advanced_while_partial_was_running
    assert not runner.is_alive()
    assert errors == []
    assert result == [0]
    assert model.max_active == 1
    assert model.active == 0
    assert events[-1] == (
        "final",
        {"transcript": "final", "engine": "whisper-fake-local"},
    )


def test_partial_transcription_failure_warns_and_final_still_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Model:
        def __init__(self) -> None:
            self.calls = 0

        def transcribe(self, _audio: np.ndarray, **_options: object) -> dict[str, object]:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("partial failed")
            return {"text": "recovered final", "segments": []}

    model = Model()
    blocks = _ScriptedBlocks([_speech_block() for _ in range(14)])
    events: list[tuple[str, dict[str, object]]] = []

    result = _run_scripted_microphone(
        monkeypatch,
        blocks=blocks,
        model=model,
        events=events,
    )

    assert result == 0
    assert [kind for kind, _payload in events] == ["warning", "final"]
    assert "Partial transcription failed" in events[0][1]["warning"]
    assert events[-1] == (
        "final",
        {"transcript": "recovered final", "engine": "whisper-fake-local"},
    )
