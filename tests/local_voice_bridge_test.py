from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from scripts.local_voice_bridge import SAMPLE_RATE, VoiceActivity, load_pcm_wav, normalized_rms


def test_voice_activity_waits_for_speech_then_finishes_after_silence() -> None:
    detector = VoiceActivity(
        sample_rate=1_000,
        silence_ms=300,
        wait_ms=1_000,
        minimum_speech_ms=200,
    )
    silence = np.zeros(100, dtype=np.float32)
    speech = np.full(100, 0.08, dtype=np.float32)

    assert detector.push(silence) == "waiting"
    assert detector.push(speech) == "speech"
    assert detector.push(speech) == "speech"
    assert detector.push(silence) == "silence"
    assert detector.push(silence) == "silence"
    assert detector.push(silence) == "final"


def test_voice_activity_times_out_without_audio() -> None:
    detector = VoiceActivity(sample_rate=1_000, wait_ms=300)
    silence = np.zeros(100, dtype=np.float32)
    assert detector.push(silence) == "waiting"
    assert detector.push(silence) == "waiting"
    assert detector.push(silence) == "timeout"


def test_pcm_wav_is_normalized_mono_and_resampled(tmp_path: Path) -> None:
    path = tmp_path / "voice.wav"
    source_rate = 8_000
    left = (np.sin(np.linspace(0, 6, source_rate)) * 12_000).astype(np.int16)
    stereo = np.column_stack([left, left]).reshape(-1)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(source_rate)
        handle.writeframes(stereo.tobytes())

    audio = load_pcm_wav(path)
    assert audio.dtype == np.float32
    assert abs(audio.size - SAMPLE_RATE) <= 1
    assert 0.1 < normalized_rms(audio) < 0.5
