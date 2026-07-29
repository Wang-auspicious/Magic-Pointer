from __future__ import annotations

import argparse
import json
import math
import os
import queue
import re
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np

from app.voice.text_normalization import VoiceTextPreferences, normalize_voice_text


SAMPLE_RATE = 16_000
BLOCK_MS = 100
WHISPER_THREAD_OVERRIDE_ENV = "MAGIC_POINTER_WHISPER_THREADS"
WHISPER_THREAD_FALLBACK = 4
WHISPER_THREAD_MAXIMUM = 12


def _configure_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


def emit(kind: str, **payload: Any) -> None:
    print(json.dumps({"type": kind, **payload}, ensure_ascii=False), flush=True)


def normalized_rms(audio: np.ndarray) -> float:
    values = np.asarray(audio, dtype=np.float32).reshape(-1)
    if values.size == 0:
        return 0.0
    return float(math.sqrt(float(np.mean(np.square(values)))))


@dataclass
class VoiceActivity:
    sample_rate: int = SAMPLE_RATE
    silence_ms: int = 1_250
    wait_ms: int = 8_000
    max_ms: int = 20_000
    minimum_speech_ms: int = 420
    noise_floor: float = 0.003
    speech_started: bool = False
    total_samples: int = 0
    speech_samples: int = 0
    silent_samples: int = 0

    @property
    def threshold(self) -> float:
        return max(0.009, self.noise_floor * 3.2)

    def _is_speech_like(self, values: np.ndarray, level: float) -> bool:
        """Reject steady mains hum and brief impulses before starting capture."""
        if level < self.threshold or values.size < 2:
            return False
        magnitude = np.abs(values)
        peak = float(np.max(magnitude))
        active_fraction = float(np.mean(magnitude >= max(level * 0.35, self.threshold * 0.5)))
        if active_fraction < 0.55 and peak >= level * 2.2:
            return False

        positive_fraction = float(np.mean(values > self.threshold * 0.1))
        negative_fraction = float(np.mean(values < -self.threshold * 0.1))
        if min(positive_fraction, negative_fraction) >= 0.10:
            nonzero = values[magnitude >= self.threshold * 0.1]
            if nonzero.size >= 2:
                zero_crossing_rate = float(np.mean(nonzero[1:] * nonzero[:-1] < 0.0))
                if zero_crossing_rate < 0.008:
                    return False
        return True

    def push(self, block: np.ndarray) -> str:
        values = np.asarray(block, dtype=np.float32).reshape(-1)
        count = int(values.size)
        self.total_samples += count
        level = normalized_rms(values)
        is_speech = self._is_speech_like(values, level)
        if not self.speech_started:
            if is_speech:
                self.speech_started = True
                self.speech_samples += count
                self.silent_samples = 0
                return "speech"
            self.noise_floor = 0.92 * self.noise_floor + 0.08 * level
            if self.total_samples >= self.sample_rate * self.wait_ms / 1000:
                return "timeout"
            return "waiting"

        if is_speech:
            self.speech_samples += count
            self.silent_samples = 0
            return "speech"
        self.silent_samples += count
        speech_long_enough = self.speech_samples >= self.sample_rate * self.minimum_speech_ms / 1000
        if speech_long_enough and self.silent_samples >= self.sample_rate * self.silence_ms / 1000:
            return "final"
        if self.total_samples >= self.sample_rate * self.max_ms / 1000:
            return "final" if speech_long_enough else "timeout"
        return "silence"


def stop_capture_state(stop_file: Path | str | None, activity: VoiceActivity) -> str | None:
    """Return a capture outcome for an existing stop file without mutating it."""
    if stop_file is None:
        return None
    try:
        requested = Path(stop_file).is_file()
    except OSError:
        return None
    if not requested:
        return None
    minimum_samples = activity.sample_rate * activity.minimum_speech_ms / 1000
    return "final" if activity.speech_samples >= minimum_samples else "error"


def requested_stop_state(requested: bool, activity: VoiceActivity) -> str | None:
    """Convert a cooperative in-memory stop signal into the same VAD outcome."""
    if not requested:
        return None
    minimum_samples = activity.sample_rate * activity.minimum_speech_ms / 1000
    return "final" if activity.speech_samples >= minimum_samples else "error"


@dataclass(frozen=True)
class VoiceProfile:
    language: str | None = None
    output_mode: str = "verbatim"
    punctuation: str = "verbatim"
    script: str = "unchanged"
    mixed_spacing: str = "preserve"
    hallucination_guard: bool = True
    glossary: tuple[str, ...] = ()


def _normalized_scope_path(value: Path | str | None) -> str:
    return str(value or "").strip().replace("/", "\\").rstrip("\\").casefold()


def _scope_matches(scope: str, context_path: Path | str | None) -> bool:
    if scope == "*":
        return True
    expected = _normalized_scope_path(scope)
    current = _normalized_scope_path(context_path)
    return bool(
        expected
        and current
        and (current == expected or current.startswith(expected + "\\"))
    )


def load_voice_profile(
    *,
    settings_path: Path | str | None = None,
    context_path: Path | str | None = None,
) -> VoiceProfile:
    raw_settings_path = settings_path or os.environ.get("MAGIC_POINTER_VOICE_SETTINGS_FILE")
    raw_context_path = context_path or os.environ.get("MAGIC_POINTER_VOICE_CONTEXT_PATH")
    if not raw_settings_path:
        return VoiceProfile()
    try:
        value = json.loads(Path(raw_settings_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return VoiceProfile()
    interaction = value.get("interaction")
    interaction = dict(interaction) if isinstance(interaction, dict) else {}
    language_value = str(interaction.get("voice_language") or "auto").strip().casefold()
    language = (
        None
        if language_value == "auto"
        else language_value
        if language_value in {"zh", "en", "ja", "ko", "fr", "de", "es", "ru"}
        else None
    )
    output_mode = str(interaction.get("voice_output_mode") or "verbatim").strip().casefold()
    if output_mode not in {"verbatim", "clean_spacing"}:
        output_mode = "verbatim"
    punctuation = str(interaction.get("voice_punctuation") or "verbatim").strip().casefold()
    if punctuation not in {"verbatim", "smart_zh"}:
        punctuation = "verbatim"
    script = str(interaction.get("voice_script") or "unchanged").strip().casefold()
    if script not in {"unchanged", "simplified", "traditional"}:
        script = "unchanged"
    mixed_spacing = str(interaction.get("voice_mixed_spacing") or "preserve").strip().casefold()
    if mixed_spacing not in {"preserve", "compact_cjk"}:
        mixed_spacing = "preserve"
    glossaries = interaction.get("voice_glossaries")
    glossaries = dict(glossaries) if isinstance(glossaries, dict) else {}
    matching_scopes = sorted(
        (
            (0 if str(scope) == "*" else len(_normalized_scope_path(scope)), str(scope), terms)
            for scope, terms in glossaries.items()
            if _scope_matches(str(scope), raw_context_path) and isinstance(terms, list)
        ),
        key=lambda item: item[0],
    )
    glossary: list[str] = []
    seen: set[str] = set()
    for _specificity, _scope, terms in matching_scopes:
        for raw_term in terms:
            term = str(raw_term or "").strip()
            folded = term.casefold()
            if not term or folded in seen:
                continue
            seen.add(folded)
            glossary.append(term[:120])
            if len(glossary) >= 64:
                break
        if len(glossary) >= 64:
            break
    return VoiceProfile(
        language=language,
        output_mode=output_mode,
        punctuation=punctuation,
        script=script,
        mixed_spacing=mixed_spacing,
        hallucination_guard=interaction.get("voice_hallucination_guard") is not False,
        glossary=tuple(glossary),
    )


def load_pcm_wav(path: Path, *, target_rate: int = SAMPLE_RATE) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        source_rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError("voice bridge expects 16-bit PCM WAV")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if source_rate != target_rate and audio.size:
        duration = audio.size / float(source_rate)
        target_count = max(1, round(duration * target_rate))
        source_x = np.linspace(0.0, duration, audio.size, endpoint=False)
        target_x = np.linspace(0.0, duration, target_count, endpoint=False)
        audio = np.interp(target_x, source_x, audio).astype(np.float32)
    return audio.astype(np.float32, copy=False)


def validated_model_name(value: object) -> str:
    model_name = str(value or "").strip()
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", model_name)
        or ".." in model_name
    ):
        raise ValueError("local Whisper model name is invalid")
    return model_name


def cached_model_path(model_name: str) -> Path:
    validated_name = validated_model_name(model_name)
    cache_root = Path(
        os.environ.get("WHISPER_CACHE_DIR") or Path.home() / ".cache" / "whisper"
    ).expanduser().resolve()
    return cache_root / f"{validated_name}.pt"


def available_logical_cpu_count() -> int | None:
    """Return the CPU capacity available to this process when it is known."""
    process_cpu_count = getattr(os, "process_cpu_count", None)
    for counter in (process_cpu_count, os.cpu_count):
        if not callable(counter):
            continue
        try:
            count = counter()
        except OSError:
            continue
        if isinstance(count, int) and not isinstance(count, bool) and count > 0:
            return count
    return None


def select_whisper_cpu_threads(
    *,
    logical_cpu_count: int | None = None,
    environment: dict[str, str] | None = None,
) -> int:
    """Choose a bounded CPU thread count, with a strict desktop-test override."""
    detected_count = available_logical_cpu_count() if logical_cpu_count is None else logical_cpu_count
    if (
        not isinstance(detected_count, int)
        or isinstance(detected_count, bool)
        or detected_count < 1
    ):
        detected_count = WHISPER_THREAD_FALLBACK
    safe_maximum = min(detected_count, WHISPER_THREAD_MAXIMUM)
    default_threads = safe_maximum

    source = os.environ if environment is None else environment
    override = source.get(WHISPER_THREAD_OVERRIDE_ENV)
    if not isinstance(override, str) or not re.fullmatch(r"[1-9][0-9]*", override):
        return default_threads
    requested_threads = int(override)
    if requested_threads > safe_maximum:
        return default_threads
    return requested_threads


def load_model(model_name: str):
    import torch
    import whisper

    model_path = cached_model_path(model_name)
    if not model_path.is_file():
        raise FileNotFoundError(
            f"local Whisper model is not installed: {model_path}. "
            f"Place {model_name}.pt in the Whisper cache before enabling voice mode."
        )
    torch.set_num_threads(select_whisper_cpu_threads())
    return whisper.load_model(str(model_path), device="cpu")


def _normalize_transcript(text: str, output_mode: str) -> str:
    value = str(text or "").strip()
    if output_mode == "clean_spacing":
        return re.sub(r"\s+", " ", value)
    return value


def _high_no_speech_probability(result: dict[str, Any]) -> bool:
    segments = [
        dict(item)
        for item in result.get("segments") or []
        if isinstance(item, dict)
    ]
    if not segments:
        return False
    probabilities: list[float] = []
    for segment in segments:
        try:
            probabilities.append(float(segment.get("no_speech_prob")))
        except (TypeError, ValueError):
            return False
    return bool(probabilities) and all(value >= 0.75 for value in probabilities)


def transcribe(
    model,
    audio: np.ndarray,
    *,
    language: str | None,
    glossary: tuple[str, ...] = (),
    output_mode: str = "verbatim",
    punctuation: str = "verbatim",
    script: str = "unchanged",
    mixed_spacing: str = "preserve",
    hallucination_guard: bool = True,
) -> str:
    if audio.size < SAMPLE_RATE // 3:
        return ""
    options: dict[str, Any] = {
        "language": language,
        "fp16": False,
        "temperature": 0,
        "condition_on_previous_text": False,
        "no_speech_threshold": 0.6,
        "logprob_threshold": -1.0,
    }
    if glossary:
        options["initial_prompt"] = ", ".join(glossary[:64])[:4000]
    result = model.transcribe(
        audio.astype(np.float32, copy=False),
        **options,
    )
    if hallucination_guard and _high_no_speech_probability(dict(result or {})):
        return ""
    normalized = _normalize_transcript(
        str((result or {}).get("text") or ""),
        output_mode,
    )
    return normalize_voice_text(
        normalized,
        VoiceTextPreferences(
            punctuation=punctuation,
            script=script,
            mixed_spacing=mixed_spacing,
        ),
    )


def run_wav(path: Path, *, model_name: str, profile: VoiceProfile) -> int:
    emit("loading", engine=f"whisper-{model_name}-local")
    model = load_model(model_name)
    audio = load_pcm_wav(path)
    emit("ready", engine=f"whisper-{model_name}-local")
    text = transcribe(
        model,
        audio,
        language=profile.language,
        glossary=profile.glossary,
        output_mode=profile.output_mode,
        punctuation=profile.punctuation,
        script=profile.script,
        mixed_spacing=profile.mixed_spacing,
        hallucination_guard=profile.hallucination_guard,
    )
    if not text:
        emit("error", error="No speech was recognized.", engine=f"whisper-{model_name}-local")
        return 2
    emit("final", transcript=text, engine=f"whisper-{model_name}-local")
    return 0


def run_microphone_with_model(
    *,
    model,
    model_name: str,
    profile: VoiceProfile,
    silence_ms: int,
    stop_state: Callable[[VoiceActivity], str | None] | None = None,
    event_sink: Callable[[str, dict[str, Any]], None] | None = None,
    input_stream_factory: Callable[..., Any] | None = None,
) -> int:
    def send(kind: str, **payload: Any) -> None:
        if event_sink is None:
            emit(kind, **payload)
        else:
            event_sink(kind, payload)

    if input_stream_factory is None:
        import sounddevice as sd
        input_stream_factory = sd.InputStream
    blocks: queue.Queue[np.ndarray] = queue.Queue(maxsize=240)

    def callback(indata, _frames, _time_info, status) -> None:
        if status:
            send("warning", warning=str(status))
        try:
            blocks.put_nowait(np.asarray(indata[:, 0], dtype=np.float32).copy())
        except queue.Full:
            pass

    activity = VoiceActivity(silence_ms=silence_ms)
    audio_parts: list[np.ndarray] = []
    pre_roll: list[np.ndarray] = []
    last_partial_samples = 0
    partial_every_samples = int(SAMPLE_RATE * 1.25)
    last_text = ""

    with input_stream_factory(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        blocksize=int(SAMPLE_RATE * BLOCK_MS / 1000),
        callback=callback,
    ):
        while True:
            block = blocks.get(timeout=2.0)
            state = activity.push(block)
            if not activity.speech_started:
                pre_roll.append(block)
                pre_roll = pre_roll[-3:]
            else:
                if pre_roll:
                    audio_parts.extend(pre_roll)
                    pre_roll.clear()
                audio_parts.append(block)
            requested_stop = stop_state(activity) if stop_state is not None else None
            if requested_stop == "error":
                send(
                    "error",
                    error="Stop requested before minimum speech was captured.",
                    engine=f"whisper-{model_name}-local",
                )
                return 2
            if state == "timeout":
                send("error", error="No speech detected before timeout.", engine=f"whisper-{model_name}-local")
                return 2
            sample_count = sum(part.size for part in audio_parts)
            if (
                activity.speech_started
                and state == "speech"
                and sample_count - last_partial_samples >= partial_every_samples
            ):
                text = transcribe(
                    model,
                    np.concatenate(audio_parts),
                    language=profile.language,
                    glossary=profile.glossary,
                    output_mode=profile.output_mode,
                    punctuation=profile.punctuation,
                    script=profile.script,
                    mixed_spacing=profile.mixed_spacing,
                    hallucination_guard=profile.hallucination_guard,
                )
                last_partial_samples = sample_count
                if text and text != last_text:
                    last_text = text
                    send("partial", transcript=text, engine=f"whisper-{model_name}-local")
            if state == "final" or requested_stop == "final":
                break

    audio = np.concatenate(audio_parts) if audio_parts else np.empty((0,), dtype=np.float32)
    final_text = transcribe(
        model,
        audio,
        language=profile.language,
        glossary=profile.glossary,
        output_mode=profile.output_mode,
        punctuation=profile.punctuation,
        script=profile.script,
        mixed_spacing=profile.mixed_spacing,
        hallucination_guard=profile.hallucination_guard,
    )
    if not final_text:
        send("error", error="No speech was recognized.", engine=f"whisper-{model_name}-local")
        return 2
    send("final", transcript=final_text, engine=f"whisper-{model_name}-local")
    return 0


def run_microphone(
    *,
    model_name: str,
    profile: VoiceProfile,
    silence_ms: int,
    stop_file: Path | str | None = None,
) -> int:
    emit("loading", engine=f"whisper-{model_name}-local")
    model = load_model(model_name)
    emit("ready", engine=f"whisper-{model_name}-local")
    return run_microphone_with_model(
        model=model,
        model_name=model_name,
        profile=profile,
        silence_ms=silence_ms,
        stop_state=lambda activity: stop_capture_state(stop_file, activity),
    )


def main() -> int:
    _configure_stdio()
    parser = argparse.ArgumentParser(description="Local, UI-free Whisper bridge for Magic Pointer.")
    parser.add_argument("--model", default=os.environ.get("MAGIC_POINTER_WHISPER_MODEL") or "tiny")
    parser.add_argument("--language", default=os.environ.get("MAGIC_POINTER_VOICE_LANGUAGE") or "")
    parser.add_argument("--silence-ms", type=int, default=1250)
    parser.add_argument("--input-wav", type=Path)
    parser.add_argument("--stop-file", type=Path)
    args = parser.parse_args()
    profile = load_voice_profile()
    if args.language:
        profile = VoiceProfile(
            language=None if args.language == "auto" else args.language,
            output_mode=profile.output_mode,
            punctuation=profile.punctuation,
            script=profile.script,
            mixed_spacing=profile.mixed_spacing,
            hallucination_guard=profile.hallucination_guard,
            glossary=profile.glossary,
        )
    try:
        if args.input_wav:
            return run_wav(args.input_wav, model_name=args.model, profile=profile)
        return run_microphone(
            model_name=args.model,
            profile=profile,
            silence_ms=max(600, min(5000, args.silence_ms)),
            stop_file=args.stop_file,
        )
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        emit("error", error=f"{type(exc).__name__}: {exc}", engine=f"whisper-{args.model}-local")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
