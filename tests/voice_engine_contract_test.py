from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import local_voice_worker
from scripts.local_voice_worker import LocalVoiceWorker
from scripts.voice_engine import (
    SENSE_VOICE,
    WHISPER,
    VoiceEngineBundle,
    resolve_engine,
    sense_voice_available,
    whisper_bundle,
)

ROOT = Path(__file__).resolve().parents[1]


def test_resolve_whisper_bundle() -> None:
    bundle = resolve_engine("whisper", "tiny")
    assert bundle.engine == WHISPER
    assert bundle.engine_name == "whisper-tiny-local"
    assert callable(bundle.loader)
    assert callable(bundle.transcriber)
    assert callable(bundle.pcm_loader)
    assert callable(bundle.profile_loader)
    assert bundle.microphone_runner is not None


def test_resolve_sense_voice_bundle() -> None:
    bundle = resolve_engine("sense_voice", "tiny")
    assert bundle.engine == SENSE_VOICE
    assert bundle.engine_name == "sense-voice-small-local"
    assert bundle.microphone_runner is not None


def test_resolve_invalid_engine_raises() -> None:
    with pytest.raises(ValueError, match="invalid voice engine"):
        resolve_engine("bogus", "tiny")


def test_resolve_auto_prefers_sense_when_available(monkeypatch) -> None:
    import scripts.voice_engine as ve

    monkeypatch.setattr(ve, "sense_voice_available", lambda: True)
    assert ve.resolve_engine("auto", "tiny").engine == SENSE_VOICE

    monkeypatch.setattr(ve, "sense_voice_available", lambda: False)
    assert ve.resolve_engine("auto", "tiny").engine == WHISPER


def test_sense_voice_available_false_for_missing_model_dir(monkeypatch) -> None:
    monkeypatch.setenv("MAGIC_POINTER_SENSE_VOICE_DIR", str(ROOT / ".tmp" / "no-such-sense-model"))
    assert sense_voice_available() is False


def test_worker_engine_property_follows_bundle() -> None:
    worker = LocalVoiceWorker(model_name="tiny", engine="sense_voice")
    assert worker.engine == "sense-voice-small-local"
    whisper_worker = LocalVoiceWorker(model_name="tiny", engine="whisper")
    assert whisper_worker.engine == "whisper-tiny-local"


def test_sense_voice_falls_back_to_whisper_after_two_load_failures(monkeypatch) -> None:
    sense_load_attempts = {"count": 0}

    def failing_sense_loader(_model_name: str):
        sense_load_attempts["count"] += 1
        raise RuntimeError("sense backend crashed")

    fake_whisper = VoiceEngineBundle(
        engine=WHISPER,
        engine_name="whisper-tiny-local",
        loader=lambda _name: (_ for _ in ()).throw(FileNotFoundError("whisper model missing")),
        pcm_loader=whisper_bundle("tiny").pcm_loader,
        profile_loader=whisper_bundle("tiny").profile_loader,
        transcriber=whisper_bundle("tiny").transcriber,
        microphone_runner=None,
    )
    monkeypatch.setattr(local_voice_worker, "whisper_bundle", lambda _name: fake_whisper)

    worker = LocalVoiceWorker(model_name="tiny", engine="sense_voice")
    monkeypatch.setattr(worker, "_model_loader", failing_sense_loader)

    first = worker.handle({"command": "load"})
    assert first[-1]["code"] == "load_failed"
    assert worker.engine == "sense-voice-small-local"
    assert worker._engine_fallback_reason is None

    second = worker.handle({"command": "load"})
    assert worker.engine == "whisper-tiny-local"
    assert worker._engine_fallback_reason == "sense_voice_unavailable_after_2_load_failures"
    assert second[-1]["code"] == "model_missing"
    assert second[-1]["engine"] == "whisper-tiny-local"
    assert sense_load_attempts["count"] == 2

    status = worker.handle({"command": "status"})[0]
    assert status["engine"] == "whisper-tiny-local"
    assert status["engineFallback"] == "sense_voice_unavailable_after_2_load_failures"


def test_single_sense_load_failure_does_not_fall_back(monkeypatch) -> None:
    worker = LocalVoiceWorker(model_name="tiny", engine="sense_voice")

    def flaky_loader(_name):
        raise RuntimeError("flaky")

    monkeypatch.setattr(worker, "_model_loader", flaky_loader)
    result = worker.handle({"command": "load"})
    assert result[-1]["code"] == "load_failed"
    assert worker.engine == "sense-voice-small-local"
    assert worker._engine_fallback_reason is None


def test_cli_accepts_engine_and_rejects_unknown() -> None:
    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-u", "scripts/local_voice_worker.py", *args],
            input='{"command":"status"}\n{"command":"shutdown"}\n',
            text=True,
            encoding="utf-8",
            capture_output=True,
            cwd=ROOT,
            timeout=20,
            check=False,
        )

    ok = run("--engine", "whisper")
    assert ok.returncode == 0, ok.stderr
    responses = [json.loads(line) for line in ok.stdout.splitlines()]
    assert [item["type"] for item in responses] == ["status", "shutdown"]
    assert responses[0]["engine"] == "whisper-tiny-local"

    bad = run("--engine", "bogus")
    assert bad.returncode == 2
    parsed = json.loads(bad.stdout.strip().splitlines()[-1])
    assert parsed["code"] == "invalid_configuration"
