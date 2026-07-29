from __future__ import annotations

import numpy as np

from scripts.local_voice_bridge import SAMPLE_RATE, VoiceActivity, transcribe


SEED = 20260728
BLOCK_SAMPLES = SAMPLE_RATE // 10


def _blocks(audio: np.ndarray) -> list[np.ndarray]:
    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    assert values.size % BLOCK_SAMPLES == 0
    return [values[index : index + BLOCK_SAMPLES] for index in range(0, values.size, BLOCK_SAMPLES)]


def _run_vad(audio: np.ndarray) -> tuple[list[str], VoiceActivity]:
    detector = VoiceActivity(
        silence_ms=1_250,
        wait_ms=800,
        max_ms=4_000,
        minimum_speech_ms=420,
    )
    states: list[str] = []
    for block in _blocks(audio):
        state = detector.push(block)
        states.append(state)
        if state in {"timeout", "final"}:
            break
    return states, detector


def _assert_never_submittable(audio: np.ndarray) -> None:
    states, detector = _run_vad(audio)
    assert "final" not in states, states
    assert detector.speech_samples < detector.sample_rate * detector.minimum_speech_ms / 1000


def _silence(duration_ms: int) -> np.ndarray:
    return np.zeros(SAMPLE_RATE * duration_ms // 1000, dtype=np.float32)


def test_vad_benchmark_rejects_pure_silence() -> None:
    _assert_never_submittable(_silence(4_000))


def test_vad_benchmark_rejects_low_amplitude_white_noise() -> None:
    rng = np.random.default_rng(SEED)
    noise = rng.normal(0.0, 0.0015, SAMPLE_RATE * 4).astype(np.float32)
    _assert_never_submittable(noise)


def test_vad_benchmark_rejects_50hz_hum() -> None:
    samples = np.arange(SAMPLE_RATE * 4, dtype=np.float32)
    hum = 0.03 * np.sin(2 * np.pi * 50 * samples / SAMPLE_RATE)
    _assert_never_submittable(hum.astype(np.float32))


def test_vad_benchmark_rejects_short_keyboard_click() -> None:
    click = np.zeros(BLOCK_SAMPLES, dtype=np.float32)
    click[: BLOCK_SAMPLES // 8] = 0.8
    _assert_never_submittable(np.concatenate([click, _silence(3_900)]))


def test_vad_maximum_duration_times_out_when_speech_is_too_short() -> None:
    detector = VoiceActivity(
        sample_rate=1_000,
        wait_ms=10_000,
        max_ms=400,
        minimum_speech_ms=420,
    )
    speech = np.full(100, 0.08, dtype=np.float32)
    silence = np.zeros(100, dtype=np.float32)

    assert detector.push(speech) == "speech"
    assert detector.push(silence) == "silence"
    assert detector.push(silence) == "silence"
    assert detector.push(silence) == "timeout"


def test_vad_benchmark_accepts_speech_envelope_then_silence() -> None:
    speech_samples = np.arange(SAMPLE_RATE * 600 // 1000, dtype=np.float32)
    envelope = 0.045 + 0.03 * np.sin(np.pi * speech_samples / speech_samples.size) ** 2
    speech = envelope * np.sin(2 * np.pi * 180 * speech_samples / SAMPLE_RATE)
    states, detector = _run_vad(np.concatenate([speech.astype(np.float32), _silence(1_300)]))

    assert "speech" in states
    assert states[-1] == "final"
    assert detector.speech_samples >= detector.sample_rate * detector.minimum_speech_ms / 1000


class _FakeModel:
    def __init__(self, result: dict[str, object]) -> None:
        self.result = result
        self.calls = 0

    def transcribe(self, _audio: np.ndarray, **_options: object) -> dict[str, object]:
        self.calls += 1
        return self.result


def test_no_speech_probability_gate_suppresses_only_high_probability_text() -> None:
    audio = np.full(SAMPLE_RATE, 0.04, dtype=np.float32)
    high_no_speech = _FakeModel({
        "text": "hallucinated transcript",
        "segments": [{"no_speech_prob": 0.97}],
    })
    normal_speech = _FakeModel({
        "text": "real transcript",
        "segments": [{"no_speech_prob": 0.08}],
    })

    assert transcribe(high_no_speech, audio, language="en") == ""
    assert high_no_speech.calls == 1
    assert transcribe(normal_speech, audio, language="en") == "real transcript"
    assert normal_speech.calls == 1
