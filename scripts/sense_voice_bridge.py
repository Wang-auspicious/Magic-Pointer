"""SenseVoice Small ASR bridge via sherpa-onnx.

Drop-in replacement for local_voice_bridge.py. Exposes the same interface
(load_model / transcribe / run_microphone_with_model / load_voice_profile)
so the LocalVoiceWorker can swap backends without code changes.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_DIR = ROOT / "data" / "models" / "sense-voice-small"
SAMPLE_RATE = 16000

# ---------------------------------------------------------------------------
# Voice profile — same shape as local_voice_bridge.VoiceProfile
# ---------------------------------------------------------------------------


@dataclass
class VoiceProfile:
    language: str = "zh"
    glossary: tuple[str, ...] = ()
    output_mode: str = "plain"
    punctuation: bool = True
    script: str = ""
    mixed_spacing: bool = True
    hallucination_guard: str = "off"
    scope: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "glossary": list(self.glossary),
            "outputMode": self.output_mode,
            "punctuation": self.punctuation,
            "script": self.script,
            "mixedSpacing": self.mixed_spacing,
            "hallucinationGuard": self.hallucination_guard,
            "scope": self.scope,
        }


def load_voice_profile(context_path: str | None = None) -> VoiceProfile:
    """Load voice profile from context path (same protocol as Whisper bridge)."""
    profile = VoiceProfile()
    if context_path:
        config_file = Path(context_path) / "voice-profile.json"
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                profile.language = str(data.get("language") or profile.language)
                profile.output_mode = str(data.get("outputMode") or profile.output_mode)
                profile.punctuation = data.get("punctuation") is not False
        except (OSError, json.JSONDecodeError):
            pass
    return profile


def validated_model_name(value: object) -> str:
    name = str(value or "sense-voice-small").strip()
    if name not in {"sense-voice-small", "sense-voice-small-int8"}:
        raise ValueError(f"unsupported SenseVoice model: {name}")
    return name


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

_model_cache: dict[str, Any] = {}


def _resolve_model_dir() -> Path:
    env = os.environ.get("MAGIC_POINTER_SENSE_VOICE_DIR")
    if env:
        return Path(env)
    return DEFAULT_MODEL_DIR


def load_model(model_name: str = "sense-voice-small") -> Any:
    """Load SenseVoice Small ONNX model via sherpa-onnx. Cached per process."""
    name = validated_model_name(model_name)
    if name in _model_cache:
        return _model_cache[name]

    model_dir = _resolve_model_dir()
    model_path = model_dir / "model.int8.onnx"
    tokens_path = model_dir / "tokens.txt"

    if not model_path.is_file():
        raise FileNotFoundError(
            f"SenseVoice model not found at {model_path}. "
            f"Run: python scripts/sense_voice_setup.py"
        )

    import sherpa_onnx  # type: ignore[import-untyped]

    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model_path),
        tokens=str(tokens_path),
        language="zh",
        use_itn=True,
        num_threads=4,
    )
    _model_cache[name] = recognizer
    return recognizer


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------


def transcribe(
    model: Any,
    audio: np.ndarray,
    *,
    language: str = "zh",
    glossary: tuple[str, ...] = (),
    output_mode: str = "plain",
    punctuation: bool = True,
    script: str = "",
    mixed_spacing: bool = True,
    hallucination_guard: str = "off",
) -> str:
    """Transcribe a NumPy audio array (float32, 16kHz mono) to text."""
    if audio.size == 0:
        return ""

    # Ensure float32, 16kHz mono
    if audio.dtype != np.float32:
        audio = audio.astype(np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    stream = model.create_stream()
    stream.accept_waveform(SAMPLE_RATE, audio)
    model.decode_stream(stream)
    text = (stream.result.text or "").strip()

    # Strip SenseVoice emotion/language tags like "<|zh|><|HAPPY|>内容"
    import re
    text = re.sub(r"<\|[^|]+\|>", "", text).strip()

    return text


# ---------------------------------------------------------------------------
# Microphone VAD + ASR
# ---------------------------------------------------------------------------


class VoiceActivity:
    """Tracks per-sample loudness for VAD decisions — same API as Whisper bridge."""

    def __init__(self) -> None:
        self.current_prob: float = 0.0
        self.speech_detected: bool = False
        self.silence_since: float | None = None


def _create_vad() -> Any:
    import sherpa_onnx  # type: ignore[import-untyped]
    vad_config = sherpa_onnx.VadModelConfig()
    vad_config.sample_rate = SAMPLE_RATE
    return sherpa_onnx.VoiceActivityDetector(
        vad_config,
        buffer_size_in_seconds=30.0,
    )


def run_microphone_with_model(
    model: Any,
    model_name: str,
    profile: VoiceProfile,
    silence_ms: int,
    stop_state: Callable[[VoiceActivity], str | None],
    event_sink: Callable[[str, dict[str, Any]], None],
) -> None:
    """Run microphone VAD loop with SenseVoice ASR.

    Follows the same callback protocol as local_voice_bridge.run_microphone_with_model.
    """
    try:
        import sounddevice as sd
    except ImportError:
        event_sink("error", {"code": "sounddevice_missing", "error": "sounddevice not installed"})
        return

    vad = _create_vad()
    activity = VoiceActivity()
    buffer: list[np.ndarray] = []
    buffer_samples = 0
    chunk_samples = int(SAMPLE_RATE * 0.3)  # 300ms chunks
    speech_started = False

    def _reset_buffer() -> np.ndarray:
        nonlocal buffer, buffer_samples, speech_started
        if not buffer:
            return np.array([], dtype=np.float32)
        audio = np.concatenate(buffer)
        buffer = []
        buffer_samples = 0
        speech_started = False
        return audio

    def _process_audio(audio: np.ndarray) -> None:
        nonlocal speech_started, buffer, buffer_samples

        if audio.size == 0:
            return
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        # Simple energy-based VAD in addition to sherpa-onnx VAD
        rms = float(np.sqrt(np.mean(audio ** 2)))
        activity.current_prob = rms
        is_speech = rms > 0.005  # adjustable threshold

        if is_speech:
            activity.speech_detected = True
            activity.silence_since = None
            if not speech_started:
                speech_started = True
                event_sink("partial", {"transcript": ""})
            buffer.append(audio)
            buffer_samples += audio.size
        elif speech_started:
            activity.silence_since = (activity.silence_since or 0) + (audio.size / SAMPLE_RATE)
            buffer.append(audio)
            buffer_samples += audio.size

            silence_sec = activity.silence_since
            if silence_ms > 0 and silence_sec >= silence_ms / 1000.0:
                # End of utterance — transcribe
                combined = _reset_buffer()
                if combined.size > 0:
                    try:
                        text = transcribe(model, combined, language=profile.language)
                    except Exception as exc:
                        event_sink("error", {"code": "transcribe_failed", "error": str(exc)})
                        return
                    if text:
                        event_sink("final", {"transcript": text})
                    else:
                        event_sink("error", {"code": "no_speech", "error": "No speech recognized"})
                activity.speech_detected = False
                activity.silence_since = None
        else:
            # No speech yet, just track ambient noise
            activity.silence_since = (activity.silence_since or 0) + (audio.size / SAMPLE_RATE)

        # Check stop condition
        stop_reason = stop_state(activity)
        if stop_reason:
            if speech_started and buffer:
                combined = _reset_buffer()
                if combined.size > 0:
                    try:
                        text = transcribe(model, combined, language=profile.language)
                    except Exception as exc:
                        event_sink("error", {"code": "transcribe_failed", "error": str(exc)})
                        return
                    if text:
                        event_sink("final", {"transcript": text})

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype=np.float32,
            blocksize=chunk_samples,
            callback=lambda indata, _frames, _time, _status: _process_audio(indata.copy()),
        ):
            # Block until stop_state returns non-None
            while stop_state(activity) is None:
                time.sleep(0.05)
    except sd.PortAudioError as exc:
        event_sink("error", {"code": "microphone_error", "error": str(exc)})
    except Exception as exc:
        event_sink("error", {"code": "microphone_runner_failed", "error": f"{type(exc).__name__}: {exc}"})


# ---------------------------------------------------------------------------
# CLI entry point — same protocol as local_voice_bridge.py
# ---------------------------------------------------------------------------


def _stop_capture_state(stop_file: Path | str | None, activity: VoiceActivity) -> str | None:
    if stop_file is not None and Path(stop_file).exists():
        return "stop_file"
    return None


def _emit(kind: str, **payload: Any) -> None:
    record: dict[str, Any] = {"type": kind, **payload}
    print(json.dumps(record, ensure_ascii=False), flush=True)


def run_microphone(
    *,
    model_name: str = "sense-voice-small",
    profile: VoiceProfile | None = None,
    silence_ms: int = 1600,
    stop_file: Path | str | None = None,
) -> int:
    _emit("loading", engine=f"sense-voice-{model_name}")
    model = load_model(model_name)
    _emit("ready", engine=f"sense-voice-{model_name}")
    run_microphone_with_model(
        model=model,
        model_name=model_name,
        profile=profile or VoiceProfile(),
        silence_ms=silence_ms,
        stop_state=lambda activity: _stop_capture_state(stop_file, activity),
        event_sink=_emit,
    )
    return 0


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="SenseVoice Small ASR bridge for Magic Pointer.")
    parser.add_argument("--model", default=os.environ.get("MAGIC_POINTER_VOICE_ENGINE_MODEL") or "sense-voice-small")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--silence-ms", type=int, default=1600)
    parser.add_argument("--input-wav", type=Path)
    parser.add_argument("--stop-file", type=Path)
    args = parser.parse_args()

    profile = load_voice_profile()
    if args.language:
        profile.language = str(args.language)

    if args.input_wav:
        import wave
        wf = wave.open(str(args.input_wav), "rb")
        frames = wf.readframes(wf.getnframes())
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        wf.close()
        model = load_model(args.model)
        text = transcribe(model, audio)
        _emit("final", transcript=text, engine="sense-voice")
        return 0

    return run_microphone(
        model_name=args.model,
        profile=profile,
        silence_ms=args.silence_ms,
        stop_file=args.stop_file,
    )


if __name__ == "__main__":
    raise SystemExit(main())
