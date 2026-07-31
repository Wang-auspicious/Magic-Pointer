from __future__ import annotations

import json
from pathlib import Path

from scripts.benchmark_voice_engines import character_error_rate, _load_references


def test_cer_perfect_and_garbled() -> None:
    assert character_error_rate("今天天气很好", "今天天气很好") == 0.0
    assert character_error_rate("今天天气很好", "昨天天气很好") == 1 / 6
    assert character_error_rate("", "") == 0.0
    assert character_error_rate("", "abc") == 1.0


def test_cer_ignores_spacing() -> None:
    assert character_error_rate("订单号 138 0013 8000", "订单号13800138000") == 0.0


def test_load_references_accepts_valid_json(tmp_path: Path) -> None:
    refs = tmp_path / "refs.json"
    refs.write_text(json.dumps({"a.wav": {"text": "你好", "intent": "text.ocr_copy"}}), encoding="utf-8")
    loaded = _load_references(refs)
    assert loaded["a.wav"]["text"] == "你好"
    assert loaded["a.wav"]["intent"] == "text.ocr_copy"


def test_load_references_handles_missing_file(tmp_path: Path) -> None:
    assert _load_references(tmp_path / "nope.json") == {}
