from pathlib import Path

import pytest

from scripts.local_voice_bridge import cached_model_path


def test_local_whisper_model_name_cannot_escape_the_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WHISPER_CACHE_DIR", str(tmp_path))
    assert cached_model_path("tiny") == tmp_path / "tiny.pt"
    for invalid in ("../outside", r"..\outside", "/absolute", r"C:\absolute", "..", ".hidden"):
        with pytest.raises(ValueError, match="model name"):
            cached_model_path(invalid)
