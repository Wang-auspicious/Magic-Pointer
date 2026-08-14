"""Model health per-endpoint isolation (review P0.4 regression suite).

Before the fix, one health JSON file held a single verdict: a vision-endpoint
failure (or a local vision-model classification refusal) opened the circuit
for *every* endpoint, so text answers were short-circuited with "cannot reach
the gateway" even though the text gateway was healthy. The fix stores one
verdict per base_url and the vision capability refusal writes no health at all.

Tests:
1. A failure recorded for endpoint A blocks A only; endpoint B is untouched.
2. record_success on B clears B's circuit without clearing A's.
3. Legacy single-object health files (v1) are migrated to the per-endpoint map.
4. read_health() with no argument prefers the currently configured text
   endpoint when several endpoints have entries.
5. ask_vision_model on a classified text-only model refuses honestly and
   writes nothing into the health store.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import ai_client, model_health  # noqa: E402
from app.ai_client import ask_vision_model  # noqa: E402


def test_failure_on_endpoint_a_does_not_block_endpoint_b(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(model_health, "_state_path", lambda: tmp_path / "health.json")
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


def test_vision_classification_refusal_writes_no_health(monkeypatch) -> None:
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", None, "deepseek-v4-flash"),
    )
    monkeypatch.setenv("MAGIC_POINTER_VISION_MODEL", "deepseek-v4-flash")
    monkeypatch.setattr(
        model_health,
        "record_failure",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("vision classification refusal must not write health")
        ),
    )
    monkeypatch.setattr(
        model_health,
        "record_unconfigured",
        lambda: (_ for _ in ()).throw(
            AssertionError("vision classification refusal must not mark unconfigured")
        ),
    )

    answer = ask_vision_model(Path("does-not-exist.png"), "这是什么")

    assert "纯文本模型" in answer
