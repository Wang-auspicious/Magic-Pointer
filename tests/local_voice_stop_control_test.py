from __future__ import annotations

import numpy as np
from pathlib import Path

from scripts.local_voice_bridge import SAMPLE_RATE, VoiceActivity, stop_capture_state


def _speech_detector(duration_ms: int) -> VoiceActivity:
    detector = VoiceActivity(minimum_speech_ms=420)
    block = np.full(SAMPLE_RATE // 10, 0.08, dtype=np.float32)
    for _ in range(duration_ms // 100):
        detector.push(block)
    return detector


STOP_FILE = Path(__file__)


def test_stop_file_finalizes_only_after_minimum_speech() -> None:
    stop_file = STOP_FILE

    assert stop_capture_state(stop_file, _speech_detector(500)) == "final"
    assert stop_file.is_file()


def test_stop_file_rejects_insufficient_speech_without_removing_request() -> None:
    stop_file = STOP_FILE

    assert stop_capture_state(stop_file, _speech_detector(100)) == "error"
    assert stop_file.is_file()
