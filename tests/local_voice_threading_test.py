from __future__ import annotations

import pytest

from scripts import local_voice_bridge
from scripts.local_voice_bridge import select_whisper_cpu_threads


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
