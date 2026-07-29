"""Contract tests for the deterministic, local voice-text normalization layer."""

import pytest

from app.voice.text_normalization import (
    MAX_VOICE_TEXT_LENGTH,
    OPENCC_AVAILABLE,
    VoiceTextPreferences,
    normalize_voice_text,
)


def test_smart_zh_converts_common_spoken_punctuation_words() -> None:
    prefs = VoiceTextPreferences(punctuation="smart_zh")

    assert normalize_voice_text("你好 逗号 世界 句号 换行 下一行 问号", prefs) == "你好，世界。\n下一行？"


def test_verbatim_punctuation_leaves_spoken_words_unchanged() -> None:
    prefs = VoiceTextPreferences(punctuation="verbatim")

    assert normalize_voice_text("你好逗号世界句号", prefs) == "你好逗号世界句号"


def test_english_text_is_not_treated_as_chinese_spoken_punctuation() -> None:
    prefs = VoiceTextPreferences(punctuation="smart_zh")

    assert normalize_voice_text("Use comma and period in this sentence.", prefs) == "Use comma and period in this sentence."


def test_compact_cjk_removes_only_spaces_at_cjk_mixed_script_boundaries() -> None:
    prefs = VoiceTextPreferences(mixed_spacing="compact_cjk")

    assert normalize_voice_text("用 Python 3 写一个 API", prefs) == "用Python 3写一个API"


def test_preserve_mixed_spacing_keeps_cjk_and_latin_separated() -> None:
    prefs = VoiceTextPreferences(mixed_spacing="preserve")

    assert normalize_voice_text("用 Python 3 写一个 API", prefs) == "用 Python 3 写一个 API"


def test_opencc_or_bounded_fallback_is_explicitly_advertised() -> None:
    simplified = VoiceTextPreferences(script="simplified")
    traditional = VoiceTextPreferences(script="traditional")

    assert simplified.limitedCoverage is (not OPENCC_AVAILABLE)
    assert traditional.limitedCoverage is (not OPENCC_AVAILABLE)
    expected_simplified = "繁体软件后台网络" if OPENCC_AVAILABLE else "繁体软体后台网路"
    assert normalize_voice_text("繁體軟體後臺網路", simplified) == expected_simplified
    assert normalize_voice_text("简体软件后台网络", traditional) == "簡體軟件後臺網絡"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"punctuation": "smart_en"},
        {"script": "opencc"},
        {"mixed_spacing": "wide"},
    ],
)
def test_preferences_reject_unsupported_modes(kwargs: dict[str, str]) -> None:
    with pytest.raises(ValueError):
        VoiceTextPreferences(**kwargs)


def test_normalization_is_idempotent() -> None:
    prefs = VoiceTextPreferences(
        punctuation="smart_zh", script="traditional", mixed_spacing="compact_cjk"
    )
    first = normalize_voice_text("用 Python 逗号 軟體後臺 句号", prefs)

    assert normalize_voice_text(first, prefs) == first


def test_normalization_rejects_invalid_input_and_oversized_text() -> None:
    prefs = VoiceTextPreferences()

    with pytest.raises(TypeError):
        normalize_voice_text(None, prefs)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        normalize_voice_text("valid", object())  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="maximum"):
        normalize_voice_text("x" * (MAX_VOICE_TEXT_LENGTH + 1), prefs)
