"""N22 contract coverage from persisted Dashboard voice settings to final text."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.voice.text_normalization import (
    MAX_VOICE_TEXT_LENGTH,
    VoiceTextPreferences,
    normalize_voice_text,
)
from scripts.local_voice_bridge import SAMPLE_RATE, load_voice_profile, transcribe


class _FakeModel:
    def __init__(self, text: str) -> None:
        self.text = text

    def transcribe(self, _audio: np.ndarray, **_kwargs: object) -> dict[str, object]:
        return {
            "text": self.text,
            "segments": [{"no_speech_prob": 0.01, "avg_logprob": -0.1}],
        }


def _speech_audio() -> np.ndarray:
    return np.full(SAMPLE_RATE, 0.03, dtype=np.float32)


def test_persisted_n22_preferences_flow_to_bridge_and_final_transcript(tmp_path: Path) -> None:
    """The selected Dashboard values must affect the bridge's final transcript."""

    settings_path = tmp_path / "fabric-settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "interaction": {
                    "voice_punctuation": " SMART_ZH ",
                    "voice_script": "traditional",
                    "voice_mixed_spacing": "compact_cjk",
                }
            }
        ),
        encoding="utf-8",
    )

    profile = load_voice_profile(settings_path=settings_path)
    assert (profile.punctuation, profile.script, profile.mixed_spacing) == (
        "smart_zh",
        "traditional",
        "compact_cjk",
    )

    first = transcribe(
        _FakeModel("你好 逗号 Python 3 简体软件后台网络 句号"),
        _speech_audio(),
        language=profile.language,
        punctuation=profile.punctuation,
        script=profile.script,
        mixed_spacing=profile.mixed_spacing,
        hallucination_guard=profile.hallucination_guard,
    )
    assert first == "你好，Python 3簡體軟件後臺網絡。"
    assert normalize_voice_text(
        first,
        prefs=VoiceTextPreferences(
            punctuation=profile.punctuation,
            script=profile.script,
            mixed_spacing=profile.mixed_spacing,
        ),
    ) == first


def test_invalid_or_missing_persisted_n22_values_fail_closed_to_defaults(tmp_path: Path) -> None:
    settings_path = tmp_path / "fabric-settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "interaction": {
                    "voice_punctuation": "smart_en",
                    "voice_script": "opencc",
                    "voice_mixed_spacing": "wide",
                }
            }
        ),
        encoding="utf-8",
    )

    invalid = load_voice_profile(settings_path=settings_path)
    missing = load_voice_profile(settings_path=tmp_path / "does-not-exist.json")
    expected = ("verbatim", "unchanged", "preserve")
    assert (invalid.punctuation, invalid.script, invalid.mixed_spacing) == expected
    assert (missing.punctuation, missing.script, missing.mixed_spacing) == expected

    untouched = transcribe(
        _FakeModel("你好 逗号 简体软件后台网络"),
        _speech_audio(),
        language=invalid.language,
        punctuation=invalid.punctuation,
        script=invalid.script,
        mixed_spacing=invalid.mixed_spacing,
        hallucination_guard=invalid.hallucination_guard,
    )
    assert untouched == "你好 逗号 简体软件后台网络"


def test_voice_text_length_boundary_is_enforced_through_transcription_path() -> None:
    accepted = transcribe(
        _FakeModel("x" * MAX_VOICE_TEXT_LENGTH),
        _speech_audio(),
        language=None,
    )
    assert accepted == "x" * MAX_VOICE_TEXT_LENGTH

    with pytest.raises(ValueError, match="maximum length"):
        transcribe(
            _FakeModel("x" * (MAX_VOICE_TEXT_LENGTH + 1)),
            _speech_audio(),
            language=None,
        )
