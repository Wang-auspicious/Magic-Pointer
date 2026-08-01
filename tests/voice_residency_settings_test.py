from __future__ import annotations

import pytest

from app.fabric.settings import InteractionSettings


def test_voice_residency_defaults_and_valid_limits() -> None:
    defaults = InteractionSettings()
    assert defaults.voice_resident_enabled is True
    assert defaults.voice_memory_limit_mb == 1024
    assert defaults.voice_idle_unload_ms == 0

    configured = InteractionSettings(
        voice_resident_enabled=False,
        voice_memory_limit_mb=2048,
        voice_idle_unload_ms=60_000,
    )
    assert configured.voice_resident_enabled is False


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("voice_memory_limit_mb", 127),
        ("voice_memory_limit_mb", 16_385),
        ("voice_memory_limit_mb", True),
        ("voice_idle_unload_ms", -1),
        ("voice_idle_unload_ms", 3_600_001),
        ("voice_idle_unload_ms", False),
    ],
)
def test_voice_residency_invalid_limits_fail_closed(field: str, value: object) -> None:
    with pytest.raises(ValueError, match=field):
        InteractionSettings(**{field: value})
