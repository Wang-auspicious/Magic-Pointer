from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from scripts.local_voice_bridge import (
    SAMPLE_RATE,
    VoiceActivity,
    load_pcm_wav,
    load_voice_profile,
    normalized_rms,
    transcribe,
)


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


def test_voice_profile_combines_global_and_matching_project_terms(tmp_path: Path) -> None:
    import json

    settings_path = tmp_path / "fabric-settings.json"
    project = tmp_path / "repo"
    context_file = project / "app.py"
    project.mkdir()
    context_file.write_text("pass\n", encoding="utf-8")
    settings_path.write_text(
        json.dumps({
            "interaction": {
                "voice_language": "zh",
                "voice_output_mode": "clean_spacing",
                "voice_hallucination_guard": True,
                "voice_glossaries": {
                    "*": ["Magic Pointer"],
                    str(project): ["Context Packet", "TargetLease"],
                    str(tmp_path / "other"): ["WrongProject"],
                },
            },
        }),
        encoding="utf-8",
    )
    profile = load_voice_profile(settings_path=settings_path, context_path=context_file)
    assert profile.language == "zh"
    assert profile.output_mode == "clean_spacing"
    assert profile.glossary == ("Magic Pointer", "Context Packet", "TargetLease")


def test_transcribe_passes_glossary_and_rejects_high_no_speech_hallucination() -> None:
    class FakeModel:
        def __init__(self, result: dict) -> None:
            self.result = result
            self.kwargs: dict = {}

        def transcribe(self, _audio, **kwargs):
            self.kwargs = kwargs
            return self.result

    audio = np.full(SAMPLE_RATE, 0.03, dtype=np.float32)
    recognized = FakeModel({
        "text": " Magic Pointer   修这个 ",
        "segments": [{"no_speech_prob": 0.02, "avg_logprob": -0.1}],
    })
    assert transcribe(
        recognized,
        audio,
        language="zh",
        glossary=("Magic Pointer", "Context Packet"),
        output_mode="clean_spacing",
    ) == "Magic Pointer 修这个"
    assert recognized.kwargs["initial_prompt"] == "Magic Pointer, Context Packet"

    hallucination = FakeModel({
        "text": "谢谢观看",
        "segments": [{"no_speech_prob": 0.96, "avg_logprob": -1.4}],
    })
    assert transcribe(
        hallucination,
        audio,
        language="zh",
        hallucination_guard=True,
    ) == ""
