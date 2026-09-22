
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import ai_client, model_health  # noqa: E402


def test_failure_on_endpoint_a_does_not_block_endpoint_b(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    for _ in range(2):
        model_health.record_failure(
            status=500,
            detail="boom",
            model="m",
            base_url="https://endpoint-a.example/v1",
        )

    assert model_health.short_circuit_message("https://endpoint-a.example/v1") is not None
    assert model_health.short_circuit_message("https://endpoint-b.example/v1") is None
    assert model_health.read_health("https://endpoint-a.example/v1").circuit_open is True
    assert model_health.read_health("https://endpoint-b.example/v1").circuit_open is False


def test_success_clears_only_own_endpoint(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    for _ in range(2):
        model_health.record_failure(
            status=500,
            detail="boom",
            model="m",
            base_url="https://endpoint-a.example/v1",
        )
    model_health.record_success(model="m", base_url="https://endpoint-b.example/v1")

    assert model_health.read_health("https://endpoint-a.example/v1").circuit_open is True
    assert model_health.read_health("https://endpoint-b.example/v1").state == "ok"
    assert model_health.short_circuit_message("https://endpoint-b.example/v1") is None


def test_legacy_single_object_file_is_migrated(monkeypatch, tmp_path: Path) -> None:
    import time as _time

    path = tmp_path / "health.json"
    now = _time.time()
    path.write_text(
        '{"state": "payment_required", "http_status": 402, "detail": "", '
        f'"checked_at": {now}, "open_until": {now + 240.0}, '
        '"model": "m", "base_url": "https://legacy.example/v1"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(model_health, "_state_path", lambda: path)

    assert model_health.read_health("https://legacy.example/v1").state == "payment_required"
    assert model_health.read_health("https://legacy.example/v1").circuit_open is True
    assert model_health.short_circuit_message("https://legacy.example/v1") is not None


def test_read_health_no_arg_prefers_configured_text_endpoint(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://text-endpoint.example/v1", "text-model"),
    )
    model_health.record_failure(
        status=500,
        detail="vision down",
        model="v",
        base_url="https://vision-endpoint.example/v1",
    )
    model_health.record_success(model="m", base_url="https://text-endpoint.example/v1")

    assert model_health.read_health().state == "ok"
    assert model_health.read_health().circuit_open is False
    assert model_health.short_circuit_message() is None


def test_single_transient_failure_does_not_open_the_circuit(monkeypatch, tmp_path):
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    model_health.record_failure(
        status=None,
        exception_name="SSLError",
        detail="EOF occurred in violation of protocol",
        model="m",
        base_url="https://endpoint-a.example/v1",
    )
    assert model_health.read_health("https://endpoint-a.example/v1").circuit_open is False
    assert model_health.short_circuit_message("https://endpoint-a.example/v1") is None


def test_two_consecutive_transient_failures_open_the_circuit(monkeypatch, tmp_path):
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    base = "https://endpoint-a.example/v1"
    for _ in range(2):
        model_health.record_failure(
            status=None,
            exception_name="SSLError",
            model="m",
            base_url=base,
        )
    assert model_health.read_health(base).circuit_open is True
    assert model_health.short_circuit_message(base) is not None


def test_success_between_failures_resets_the_transient_count(monkeypatch, tmp_path):
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    base = "https://endpoint-a.example/v1"
    model_health.record_failure(status=500, model="m", base_url=base)
    model_health.record_success(model="m", base_url=base)
    model_health.record_failure(status=500, model="m", base_url=base)
    assert model_health.read_health(base).circuit_open is False


def test_open_circuit_message_carries_retry_horizon(monkeypatch, tmp_path: Path) -> None:
    import time

    from app.model_health import (
        DEFAULT_COOLDOWN_S,
        GatewayHealth,
    )

    now = time.time()
    health = GatewayHealth(
        state="rate_limited",
        checked_at=now,
        open_until=now + DEFAULT_COOLDOWN_S,
        detail="",
    )
    assert health.circuit_open is True
    assert "秒后可重试" in health.message
    remaining = int(DEFAULT_COOLDOWN_S)
    assert f"约 {remaining} 秒后可重试" in health.message

    relaxed = GatewayHealth(state="ok", open_until=0.0, checked_at=now)
    assert "秒后可重试" not in relaxed.message


def test_hard_failures_still_open_immediately(monkeypatch, tmp_path):
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
    base = "https://endpoint-a.example/v1"
    model_health.record_failure(status=401, model="m", base_url=base)
    assert model_health.read_health(base).circuit_open is True
