"""Conservative, deterministic normalization for locally transcribed voice text.

The bundled simplified/traditional character maps intentionally cover only a
small, explicit set of common characters.  They are not a replacement for
OpenCC or a complete script-conversion implementation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
import re
from typing import Literal

try:
    from opencc import OpenCC as _OpenCC
except (ImportError, OSError):  # Packaged fallback remains explicit and bounded.
    _OpenCC = None


MAX_VOICE_TEXT_LENGTH = 16_384
OPENCC_AVAILABLE = _OpenCC is not None
LIMITED_COVERAGE = not OPENCC_AVAILABLE

_PUNCTUATION_MODES = frozenset({"verbatim", "smart_zh"})
_SCRIPT_MODES = frozenset({"unchanged", "simplified", "traditional"})
_MIXED_SPACING_MODES = frozenset({"preserve", "compact_cjk"})

# This intentionally small map is only the fail-closed fallback used when the
# declared OpenCC runtime dependency is missing.
_TRADITIONAL_TO_SIMPLIFIED = str.maketrans(
    {
        "體": "体",
        "簡": "简",
        "軟": "软",
        "後": "后",
        "臺": "台",
        "網": "网",
        "絡": "络",
        "頁": "页",
        "檔": "档",
        "案": "案",
        "開": "开",
        "關": "关",
        "鍵": "键",
        "點": "点",
        "擊": "击",
        "聲": "声",
        "畫": "画",
        "面": "面",
        "電": "电",
        "腦": "脑",
        "與": "与",
        "為": "为",
        "這": "这",
        "個": "个",
        "請": "请",
        "問": "问",
        "號": "号",
        "線": "线",
        "訊": "讯",
        "雲": "云",
        "端": "端",
    }
)
_SIMPLIFIED_TO_TRADITIONAL = str.maketrans(
    {
        simplified: traditional
        for traditional, simplified in {
            "體": "体",
            "簡": "简",
            "軟": "软",
            "後": "后",
            "臺": "台",
            "網": "网",
            "絡": "络",
            "頁": "页",
            "檔": "档",
            "案": "案",
            "開": "开",
            "關": "关",
            "鍵": "键",
            "點": "点",
            "擊": "击",
            "聲": "声",
            "畫": "画",
            "面": "面",
            "電": "电",
            "腦": "脑",
            "與": "与",
            "為": "为",
            "這": "这",
            "個": "个",
            "請": "请",
            "問": "问",
            "號": "号",
            "線": "线",
            "訊": "讯",
            "雲": "云",
            "端": "端",
        }.items()
    }
)

_SPOKEN_PUNCTUATION = (("逗号", "，"), ("句号", "。"), ("问号", "？"), ("換行", "\n"), ("换行", "\n"))
_CJK = r"\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
_CJK_TO_LATIN_SPACE = re.compile(rf"(?<=[{_CJK}])[ \t]+(?=[A-Za-z0-9])")
_LATIN_TO_CJK_SPACE = re.compile(rf"(?<=[A-Za-z0-9])[ \t]+(?=[{_CJK}])")


@dataclass(frozen=True, slots=True)
class VoiceTextPreferences:
    """User-selectable, bounded normalization settings.

    ``limitedCoverage`` is always true because the script maps are deliberately
    incomplete and should never be represented as full OpenCC conversion.
    """

    punctuation: Literal["verbatim", "smart_zh"] = "verbatim"
    script: Literal["unchanged", "simplified", "traditional"] = "unchanged"
    mixed_spacing: Literal["preserve", "compact_cjk"] = "preserve"
    limitedCoverage: bool = field(default=LIMITED_COVERAGE, init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        _validate_mode("punctuation", self.punctuation, _PUNCTUATION_MODES)
        _validate_mode("script", self.script, _SCRIPT_MODES)
        _validate_mode("mixed_spacing", self.mixed_spacing, _MIXED_SPACING_MODES)


def normalize_voice_text(text: str, prefs: VoiceTextPreferences) -> str:
    """Normalize a bounded transcription with only local, idempotent rules."""

    if not isinstance(text, str):
        raise TypeError("text must be a str")
    if len(text) > MAX_VOICE_TEXT_LENGTH:
        raise ValueError(f"text exceeds maximum length of {MAX_VOICE_TEXT_LENGTH}")
    if not isinstance(prefs, VoiceTextPreferences):
        raise TypeError("prefs must be a VoiceTextPreferences instance")

    normalized = text
    if prefs.punctuation == "smart_zh":
        normalized = _normalize_spoken_punctuation(normalized)
    if prefs.script == "simplified":
        normalized = _convert_script(normalized, "t2s.json", _TRADITIONAL_TO_SIMPLIFIED)
    elif prefs.script == "traditional":
        normalized = _convert_script(normalized, "s2t.json", _SIMPLIFIED_TO_TRADITIONAL)
    if prefs.mixed_spacing == "compact_cjk":
        normalized = _CJK_TO_LATIN_SPACE.sub("", normalized)
        normalized = _LATIN_TO_CJK_SPACE.sub("", normalized)
    return normalized


def _validate_mode(name: str, value: object, allowed: frozenset[str]) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a str")
    if value not in allowed:
        choices = ", ".join(sorted(allowed))
        raise ValueError(f"{name} must be one of: {choices}")


def _normalize_spoken_punctuation(text: str) -> str:
    for spoken, replacement in _SPOKEN_PUNCTUATION:
        text = re.sub(rf"[ \t]*{spoken}[ \t]*", replacement, text)
    return text


@lru_cache(maxsize=2)
def _opencc_converter(config: str):
    if _OpenCC is None:
        return None
    return _OpenCC(config)


def _convert_script(text: str, config: str, fallback_map: dict[int, str]) -> str:
    converter = _opencc_converter(config)
    if converter is None:
        return text.translate(fallback_map)
    return str(converter.convert(text))
