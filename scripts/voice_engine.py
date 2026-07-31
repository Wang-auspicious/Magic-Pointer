"""Voice engine contract: Whisper (openai-whisper) and SenseVoice (sherpa-onnx).

Both bridges expose the same interface (``load_model`` / ``transcribe`` /
``run_microphone_with_model`` / ``load_voice_profile``) so the worker can swap
backends without code changes.  The worker defaults to SenseVoice when it is
available and fails back to Whisper after repeated load failures (see
``LocalVoiceWorker._maybe_fallback_after_load_failure``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from scripts.local_voice_bridge import (
    VoiceProfile as WhisperVoiceProfile,
    load_model as whisper_load_model,
    load_pcm_wav,
    load_voice_profile as whisper_load_voice_profile,
    requested_stop_state,
    run_microphone_with_model as whisper_run_microphone,
    transcribe as whisper_transcribe,
)
from scripts.sense_voice_bridge import (
    load_model as sense_load_model,
    load_voice_profile as sense_load_voice_profile,
    run_microphone_with_model as sense_run_microphone,
    transcribe as sense_transcribe,
)

WHISPER = "whisper"
SENSE_VOICE = "sense_voice"
VALID_ENGINES = (WHISPER, SENSE_VOICE, "auto", "custom")
DEFAULT_ENGINE = "auto"

SENSE_MODEL_DIR_ENV = "MAGIC_POINTER_SENSE_VOICE_DIR"
SENSE_ENGINE_NAME = "sense-voice-small-local"

MicrophoneRunner = Callable[[Any, Any, str, int, Callable[[dict[str, Any]], None], Any], None]


@dataclass(frozen=True)
class VoiceEngineBundle:
    """All bridge callables the worker needs, resolved for one engine."""

    engine: str
    engine_name: str
    loader: Callable[[str], Any]
    pcm_loader: Callable[[Path], Any]
    profile_loader: Callable[..., Any]
    transcriber: Callable[..., str]
    microphone_runner: MicrophoneRunner | None


def _whisper_stop_state(stop_event: Any) -> Callable[[Any], str | None]:
    return lambda activity: requested_stop_state(stop_event.is_set(), activity)


def _sense_stop_state(stop_event: Any) -> Callable[[Any], str | None]:
    # The SenseVoice loop already flushes buffered speech to a final event when
    # stop_state returns truthy, so the worker only needs the cooperative flag.
    return lambda _activity: "final" if stop_event.is_set() else None


def make_resident_runner(
    run_microphone: Callable[..., None],
    stop_state_factory: Callable[[Any], Callable[[Any], str | None]],
) -> MicrophoneRunner:
    """Build a worker-compatible microphone runner for a bridge."""

    def runner(
        model: Any,
        profile: Any,
        request_id: str,
        silence_ms: int,
        publish: Callable[[dict[str, Any]], None],
        stop_event: Any,
    ) -> None:
        del request_id
        run_microphone(
            model=model,
            model_name="resident",
            profile=profile,
            silence_ms=silence_ms,
            stop_state=stop_state_factory(stop_event),
            event_sink=lambda kind, payload: publish({"type": kind, **payload}),
        )

    return runner


def whisper_bundle(model_name: str) -> VoiceEngineBundle:
    return VoiceEngineBundle(
        engine=WHISPER,
        engine_name=f"whisper-{model_name}-local",
        loader=whisper_load_model,
        pcm_loader=load_pcm_wav,
        profile_loader=whisper_load_voice_profile,
        transcriber=whisper_transcribe,
        microphone_runner=make_resident_runner(whisper_run_microphone, _whisper_stop_state),
    )


def _sense_model_dir() -> Path:
    env = os.environ.get(SENSE_MODEL_DIR_ENV)
    if env:
        return Path(env)
    from scripts.sense_voice_bridge import DEFAULT_MODEL_DIR

    return DEFAULT_MODEL_DIR


def sense_voice_available() -> bool:
    """True when the SenseVoice ONNX model files and sherpa-onnx are present."""
    model_dir = _sense_model_dir()
    if not (model_dir / "model.int8.onnx").is_file() or not (model_dir / "tokens.txt").is_file():
        return False
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return False
    return True


def sense_voice_bundle() -> VoiceEngineBundle:
    return VoiceEngineBundle(
        engine=SENSE_VOICE,
        engine_name=SENSE_ENGINE_NAME,
        # The worker passes its model_name (e.g. "tiny"); SenseVoice has a fixed
        # model name, so the bundle loader pins it.
        loader=lambda _model_name: sense_load_model("sense-voice-small"),
        pcm_loader=load_pcm_wav,
        profile_loader=sense_load_voice_profile,
        transcriber=sense_transcribe,
        microphone_runner=make_resident_runner(sense_run_microphone, _sense_stop_state),
    )


def resolve_engine(requested: str, model_name: str) -> VoiceEngineBundle:
    """Map a requested engine name (whisper | sense_voice | auto) to a bundle."""
    value = str(requested or DEFAULT_ENGINE).strip().casefold() or DEFAULT_ENGINE
    if value == WHISPER:
        return whisper_bundle(model_name)
    if value == SENSE_VOICE:
        return sense_voice_bundle()
    if value == "auto":
        return sense_voice_bundle() if sense_voice_available() else whisper_bundle(model_name)
    raise ValueError(
        f"invalid voice engine {requested!r}: expected one of {VALID_ENGINES}"
    )


def custom_bundle(
    model_name: str,
    *,
    loader: Callable[[str], Any] | None = None,
    pcm_loader: Callable[[Path], Any] | None = None,
    profile_loader: Callable[..., Any] | None = None,
    transcriber: Callable[..., str] | None = None,
    microphone_runner: MicrophoneRunner | None = None,
) -> VoiceEngineBundle:
    """Bundle for tests/explicit injection; missing parts default to Whisper."""
    base = whisper_bundle(model_name)
    return VoiceEngineBundle(
        engine="custom",
        engine_name=f"whisper-{model_name}-local",
        loader=loader if loader is not None else base.loader,
        pcm_loader=pcm_loader if pcm_loader is not None else base.pcm_loader,
        profile_loader=profile_loader if profile_loader is not None else base.profile_loader,
        transcriber=transcriber if transcriber is not None else base.transcriber,
        microphone_runner=microphone_runner if microphone_runner is not None else base.microphone_runner,
    )
