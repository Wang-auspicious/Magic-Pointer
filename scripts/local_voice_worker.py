from __future__ import annotations

"""UI-free, JSONL local Whisper worker.

This process intentionally has no model download path.  Its default loader is
``local_voice_bridge.load_model``, which only accepts a model already present in
the local Whisper cache.
"""

import argparse
import ctypes
import gc
import json
import os
import sys
import time
from pathlib import Path
from threading import Event, Lock, RLock, Thread
from typing import Any, Callable, Iterable, TextIO

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.local_voice_bridge import (
    VoiceProfile,
    requested_stop_state,
    run_microphone_with_model,
)
from scripts.voice_engine import (
    DEFAULT_ENGINE,
    SENSE_VOICE,
    custom_bundle,
    resolve_engine,
    whisper_bundle,
)


MAX_COMMAND_BYTES = 64 * 1024
MAX_PATH_CHARS = 4_096
MAX_REQUEST_ID_CHARS = 160
DEFAULT_ESTIMATED_MEMORY_MB = {
    "tiny": 128,
    "base": 256,
    "small": 768,
    "medium": 1_536,
    "large": 3_072,
}.get

MicrophoneRunner = Callable[[Any, VoiceProfile, str, int, Callable[[dict[str, Any]], None], Event], None]


def resident_microphone_runner(
    model: Any,
    profile: VoiceProfile,
    request_id: str,
    silence_ms: int,
    publish: Callable[[dict[str, Any]], None],
    stop_event: Event,
) -> None:
    """Run the real local microphone/VAD path against the resident model."""
    del request_id
    run_microphone_with_model(
        model=model,
        model_name="resident",
        profile=profile,
        silence_ms=silence_ms,
        stop_state=lambda activity: requested_stop_state(stop_event.is_set(), activity),
        event_sink=lambda kind, payload: publish({"type": kind, **payload}),
    )


def _enable_crash_traceback() -> None:
    """Dump a native stack to stderr on hard crashes (segfaults in sherpa/
    torch/sounddevice are the prime suspects for the -1 worker exits).
    The Electron client forwards stderr into the crash report."""
    import faulthandler

    faulthandler.enable()

def _configure_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


def _process_memory_bytes() -> int:
    """Return the current working set without introducing a psutil dependency."""
    if os.name == "nt":
        from ctypes import wintypes

        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("page_fault_count", wintypes.DWORD),
                ("peak_working_set_size", ctypes.c_size_t),
                ("working_set_size", ctypes.c_size_t),
                ("quota_peak_paged_pool_usage", ctypes.c_size_t),
                ("quota_paged_pool_usage", ctypes.c_size_t),
                ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
                ("quota_non_paged_pool_usage", ctypes.c_size_t),
                ("pagefile_usage", ctypes.c_size_t),
                ("peak_pagefile_usage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        get_process_memory_info = psapi.GetProcessMemoryInfo
        get_process_memory_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
        get_process_memory_info.restype = wintypes.BOOL
        get_current_process = kernel32.GetCurrentProcess
        get_current_process.argtypes = []
        get_current_process.restype = wintypes.HANDLE
        ok = get_process_memory_info(
            get_current_process(),
            ctypes.byref(counters),
            counters.cb,
        )
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())
        return int(counters.working_set_size)

    import resource

    value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return value if sys.platform == "darwin" else value * 1024


class _ModelRWLock:
    """Reader-writer lock guarding the in-memory Whisper model.

    Multiple concurrent transcriptions share a read lock.  ``unload()``
    acquires the write lock, which blocks until every in-flight
    ``model.transcribe()`` call has returned — preventing the segfault
    that occurs when a C++ inference thread is still running after
    ``self._model = None`` + ``gc.collect()``.
    """

    def __init__(self) -> None:
        self._readers = 0
        self._readers_guard = Lock()
        self._write_gate = Lock()

    def acquire_read(self) -> None:
        with self._readers_guard:
            self._readers += 1
            if self._readers == 1:
                self._write_gate.acquire()

    def release_read(self) -> None:
        with self._readers_guard:
            self._readers -= 1
            if self._readers == 0:
                self._write_gate.release()

    def acquire_write(self) -> None:
        self._write_gate.acquire()

    def release_write(self) -> None:
        self._write_gate.release()


class LocalVoiceWorker:
    """Owns at most one in-memory local Whisper model and no request data."""

    def __init__(
        self,
        *,
        model_name: str = "tiny",
        profile: VoiceProfile | None = None,
        model_loader: Callable[[str], Any] | None = None,
        pcm_loader: Callable[[Path], Any] | None = None,
        transcriber: Callable[..., str] | None = None,
        memory_limit_mb: int | None = None,
        memory_probe: Callable[[], int] = _process_memory_bytes,
        idle_unload_ms: int | None = None,
        clock: Callable[[], float] = time.monotonic,
        microphone_runner: MicrophoneRunner | None = None,
        profile_loader: Callable[..., VoiceProfile] | None = None,
        event_sink: Callable[[dict[str, Any]], None] | None = None,
        engine: str = DEFAULT_ENGINE,
    ) -> None:
        self.model_name = str(model_name or "tiny").strip() or "tiny"
        self.profile = profile or VoiceProfile()
        explicit_parts = any(part is not None for part in (
            model_loader, pcm_loader, transcriber, microphone_runner, profile_loader,
        ))
        self._bundle = (
            custom_bundle(
                self.model_name,
                loader=model_loader,
                pcm_loader=pcm_loader,
                profile_loader=profile_loader,
                transcriber=transcriber,
                microphone_runner=microphone_runner,
            )
            if explicit_parts
            else resolve_engine(engine, self.model_name)
        )
        self._model_loader = self._bundle.loader
        self._pcm_loader = self._bundle.pcm_loader
        self._transcriber = self._bundle.transcriber
        self._engine_failures = 0
        self._engine_fallback_reason: str | None = None
        self._memory_limit_bytes = self._validate_limit(memory_limit_mb, "memory_limit_mb")
        self._idle_unload_ms = self._validate_limit(idle_unload_ms, "idle_unload_ms")
        if self._idle_unload_ms == 0:
            # 0 = keep the model resident; never idle-unload it. A cold
            # reload costs 4-11s of user-visible wait, so the default desktop
            # config pins the model in memory for the whole app session.
            self._idle_unload_ms = None
        self._memory_probe = memory_probe
        self._clock = clock
        self._model: Any | None = None
        self._last_used: float | None = None
        self._actual_memory_bytes: int | None = None
        self._profile_loader = self._bundle.profile_loader
        self._microphone_runner = self._bundle.microphone_runner
        self._model_access = _ModelRWLock()
        self._event_sink = event_sink
        self._microphone_lock = RLock()
        self._microphone_request_id: str | None = None
        self._microphone_state = "idle"
        self._microphone_stop: Event | None = None
        self._microphone_thread: Thread | None = None
        self._idle_watch_stop = Event()
        self._idle_watch_thread: Thread | None = None
        self.shutdown_requested = False

    @staticmethod
    def _validate_limit(value: int | None, name: str) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{name} must be a non-negative integer")
        return value

    @property
    def engine(self) -> str:
        return self._bundle.engine_name

    @property
    def _memory_limit_in_bytes(self) -> int | None:
        if self._memory_limit_bytes is None:
            return None
        return self._memory_limit_bytes * 1024 * 1024

    def _touch(self) -> None:
        if self._model is not None:
            self._last_used = self._clock()

    def _switch_to_whisper_fallback(self) -> None:
        """Drop SenseVoice and rebind every bridge callable to Whisper."""
        bundle = whisper_bundle(self.model_name)
        self._bundle = bundle
        self._model_loader = bundle.loader
        self._pcm_loader = bundle.pcm_loader
        self._transcriber = bundle.transcriber
        self._profile_loader = bundle.profile_loader
        self._microphone_runner = bundle.microphone_runner

    def _maybe_fallback_after_load_failure(self) -> bool:
        """Return True when the worker switched from SenseVoice to Whisper.

        A single flaky load (e.g. one corrupted download) must not punish the
        default engine; two consecutive failures are treated as unavailable.
        """
        if self._bundle.engine != SENSE_VOICE:
            return False
        self._engine_failures += 1
        if self._engine_failures < 2:
            return False
        self._switch_to_whisper_fallback()
        self._engine_failures = 0
        self._engine_fallback_reason = "sense_voice_unavailable_after_2_load_failures"
        return True

    def unload(self) -> None:
        self._model_access.acquire_write()
        try:
            with self._microphone_lock:
                self._model = None
                self._last_used = None
                self._actual_memory_bytes = None
                gc.collect()
                try:
                    torch = sys.modules.get("torch")
                    if torch is not None and torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    # CUDA is optional; an unavailable cleanup hook must not keep the
                    # resident model alive or turn an otherwise valid unload into an error.
                    pass
        finally:
            self._model_access.release_write()

    def _unload_if_idle(self) -> bool:
        with self._microphone_lock:
            if self._model is None or self._idle_unload_ms is None or self._last_used is None:
                return False
            if self._microphone_request_id is not None:
                return False
            elapsed_ms = (self._clock() - self._last_used) * 1000
            if elapsed_ms >= self._idle_unload_ms:
                self.unload()
                return True
            return False

    def start_idle_watchdog(
        self,
        event_sink: Callable[[dict[str, Any]], None],
        *,
        interval_seconds: float = 0.1,
    ) -> None:
        """Unload at the real deadline even when stdin remains silent."""
        if self._idle_watch_thread is not None and self._idle_watch_thread.is_alive():
            return
        if self._idle_unload_ms is None:
            return  # resident mode: no deadline, no watchdog thread needed
        if not callable(event_sink) or interval_seconds <= 0:
            raise ValueError("event_sink and a positive interval_seconds are required")
        self._idle_watch_stop.clear()

        def watch() -> None:
            while not self._idle_watch_stop.wait(interval_seconds):
                if self._unload_if_idle():
                    event_sink({
                        "type": "status",
                        "state": "unloaded",
                        "reason": "idle_timeout",
                        "engine": self.engine,
                    })

        self._idle_watch_thread = Thread(target=watch, name="magic-pointer-idle-unload", daemon=True)
        self._idle_watch_thread.start()

    def shutdown_idle_watchdog(self) -> None:
        self._idle_watch_stop.set()
        thread = self._idle_watch_thread
        if thread is not None and thread is not __import__("threading").current_thread():
            thread.join(timeout=1)
        self._idle_watch_thread = None

    @staticmethod
    def _request_id(command: dict[str, Any]) -> str | None:
        value = command.get("requestId")
        if not isinstance(value, str) or not value or value != value.strip() or len(value) > MAX_REQUEST_ID_CHARS:
            return None
        return value

    def _microphone_is_active(self) -> bool:
        with self._microphone_lock:
            return self._microphone_request_id is not None

    def _refresh_profile(self, command: dict[str, Any]) -> dict[str, Any] | None:
        raw_context_path = command.get("contextPath")
        if raw_context_path is None:
            raw_context_path = ""
        if not isinstance(raw_context_path, str) or len(raw_context_path) > MAX_PATH_CHARS or "\x00" in raw_context_path:
            return self._error("invalid_context_path", "contextPath must be a bounded local path string.", engine=self.engine)
        try:
            self.profile = self._profile_loader(context_path=raw_context_path or None)
        except Exception as exc:
            return self._error("profile_load_failed", f"{type(exc).__name__}: {exc}", engine=self.engine)
        return None

    def _publish_microphone_event(self, request_id: str, payload: dict[str, Any]) -> None:
        kind = payload.get("type")
        if kind not in {"partial", "final", "error", "warning"}:
            kind = "error"
            payload = {"error": "Microphone runner emitted an unsupported event type.", "code": "microphone_runner_protocol"}
        if kind in {"partial", "final"}:
            transcript = payload.get("transcript")
            # SenseVoice emits an empty partial once VAD first sees activity.
            # It is a non-terminal lifecycle signal, not malformed text and
            # must not stop the microphone session before speech is decoded.
            if kind == "partial" and transcript == "":
                return
            if not isinstance(transcript, str) or not transcript or len(transcript) > MAX_COMMAND_BYTES:
                kind = "error"
                payload = {"error": "Microphone runner emitted an invalid transcript.", "code": "microphone_runner_protocol"}
        event: dict[str, Any] = {"type": kind, "requestId": request_id, "engine": self.engine}
        if kind in {"partial", "final"}:
            event["transcript"] = payload["transcript"]
        elif kind == "warning":
            event["warning"] = str(payload.get("warning") or "Microphone runner warning.")[:MAX_COMMAND_BYTES]
        else:
            event["code"] = str(payload.get("code") or "microphone_runner_failed")[:120]
            event["error"] = str(payload.get("error") or "Microphone runner failed.")[:MAX_COMMAND_BYTES]
        sink: Callable[[dict[str, Any]], None] | None = None
        with self._microphone_lock:
            if self._microphone_request_id != request_id:
                return
            stop_event = self._microphone_stop
            if kind == "partial" and stop_event is not None and stop_event.is_set():
                return
            if kind in {"final", "error"} and stop_event is not None:
                stop_event.set()
            sink = self._event_sink
        # Pipe writes may block under backpressure. Never hold the microphone
        # state lock while delivering a pushed event.
        if sink is not None:
            try:
                sink(event)
            except Exception:
                pass

    def _run_microphone_session(
        self,
        model: Any,
        profile: VoiceProfile,
        request_id: str,
        silence_ms: int,
        stop_event: Event,
    ) -> None:
        try:
            assert self._microphone_runner is not None
            self._model_access.acquire_read()
            try:
                self._microphone_runner(
                    model,
                    profile,
                    request_id,
                    silence_ms,
                    lambda payload: self._publish_microphone_event(request_id, payload),
                    stop_event,
                )
            finally:
                self._model_access.release_read()
        except Exception as exc:
            self._publish_microphone_event(
                request_id,
                {"type": "error", "code": "microphone_runner_failed", "error": f"{type(exc).__name__}: {exc}"},
            )
        finally:
            sink: Callable[[dict[str, Any]], None] | None = None
            stopped_event: dict[str, Any] | None = None
            with self._microphone_lock:
                if self._microphone_request_id != request_id:
                    return
                self._touch()
                self._microphone_request_id = None
                self._microphone_state = "idle"
                self._microphone_stop = None
                self._microphone_thread = None
                stopped_event = {
                    "type": "microphone_stopped",
                    "requestId": request_id,
                    "engine": self.engine,
                    "state": "idle",
                }
                sink = self._event_sink
            if sink is not None and stopped_event is not None:
                try:
                    sink(stopped_event)
                except Exception:
                    pass

    def _start_microphone(self, command: dict[str, Any]) -> list[dict[str, Any]]:
        request_id = self._request_id(command)
        if request_id is None:
            return [self._error("invalid_request_id", f"requestId must be a non-empty string no longer than {MAX_REQUEST_ID_CHARS} characters")]
        if self._microphone_runner is None:
            return [self._error("microphone_unavailable", "No local microphone runner is configured.", engine=self.engine)]
        profile_error = self._refresh_profile(command)
        if profile_error is not None:
            return [profile_error]
        raw_silence_ms = command.get("silenceMs", 1600)
        if isinstance(raw_silence_ms, bool) or not isinstance(raw_silence_ms, int) or not 600 <= raw_silence_ms <= 5000:
            return [self._error("invalid_silence", "silenceMs must be an integer from 600 to 5000.", engine=self.engine)]
        with self._microphone_lock:
            if self._microphone_request_id is not None:
                return [self._error("microphone_busy", "A microphone session is already active.", engine=self.engine)]
            responses = self._load(command)
            if responses[-1]["type"] == "error":
                return responses
            stop_event = Event()
            self._microphone_request_id = request_id
            self._microphone_state = "recording"
            self._microphone_stop = stop_event
            thread = Thread(
                target=self._run_microphone_session,
                args=(self._model, self.profile, request_id, raw_silence_ms, stop_event),
                name="magic-pointer-microphone",
                daemon=True,
            )
            self._microphone_thread = thread
            try:
                thread.start()
            except RuntimeError as exc:
                self._microphone_request_id = None
                self._microphone_state = "idle"
                self._microphone_stop = None
                self._microphone_thread = None
                return responses + [self._error("microphone_start_failed", f"{type(exc).__name__}: {exc}", engine=self.engine)]
        return responses + [{"type": "microphone_started", "requestId": request_id, "state": "recording", "engine": self.engine}]

    def _stop_microphone(self, command: dict[str, Any]) -> list[dict[str, Any]]:
        request_id = self._request_id(command)
        if request_id is None:
            return [self._error("invalid_request_id", f"requestId must be a non-empty string no longer than {MAX_REQUEST_ID_CHARS} characters")]
        with self._microphone_lock:
            if self._microphone_request_id is None:
                return [self._error("no_active_microphone", "No microphone session is active.", engine=self.engine)]
            if self._microphone_request_id != request_id:
                return [self._error("microphone_request_mismatch", "requestId does not own the active microphone session.", engine=self.engine)]
            assert self._microphone_stop is not None
            self._microphone_stop.set()
            self._microphone_state = "stopping"
        return [{"type": "microphone_stopping", "requestId": request_id, "state": "stopping", "engine": self.engine}]

    @staticmethod
    def _error(code: str, error: str, *, engine: str | None = None) -> dict[str, Any]:
        response: dict[str, Any] = {"type": "error", "code": code, "error": error}
        if engine:
            response["engine"] = engine
        return response

    def _estimated_memory_mb(self, command: dict[str, Any]) -> int | None:
        value = command.get("estimated_memory_mb")
        if value is None:
            return DEFAULT_ESTIMATED_MEMORY_MB(self.model_name.casefold(), 512)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 65_536:
            return None
        return value

    def _load(self, command: dict[str, Any]) -> list[dict[str, Any]]:
        with self._microphone_lock:
            if self._model is not None:
                self._touch()
                return [{"type": "ready", "engine": self.engine, "reused": True}]

            estimated_mb = self._estimated_memory_mb(command)
            if estimated_mb is None:
                return [self._error("invalid_estimate", "estimated_memory_mb must be an integer from 0 to 65536")]
            limit = self._memory_limit_in_bytes
            if limit is not None and estimated_mb * 1024 * 1024 > limit:
                return [self._error("memory_limit_exceeded", "Estimated model memory exceeds memory_limit_mb.", engine=self.engine)]

            responses = [{"type": "loading", "engine": self.engine, "estimated_memory_mb": estimated_mb}]
            model: Any | None = None
            while True:
                try:
                    model = self._model_loader(self.model_name)
                    break
                except FileNotFoundError as exc:
                    if not self._maybe_fallback_after_load_failure():
                        return responses + [self._error("model_missing", f"Local model is unavailable: {exc}", engine=self.engine)]
                except Exception as exc:
                    if not self._maybe_fallback_after_load_failure():
                        return responses + [self._error("load_failed", f"{type(exc).__name__}: {exc}", engine=self.engine)]

            assert model is not None
            self._model = model
            if limit is not None:
                try:
                    actual = self._memory_probe()
                    if isinstance(actual, bool) or not isinstance(actual, int) or actual < 0:
                        raise ValueError("memory probe did not return a non-negative byte count")
                except Exception as exc:
                    self.unload()
                    return responses + [self._error("memory_probe_failed", f"Cannot verify memory limit: {exc}", engine=self.engine)]
                if actual > limit:
                    self.unload()
                    return responses + [self._error("memory_limit_exceeded", "Measured process memory exceeds memory_limit_mb.", engine=self.engine)]
                self._actual_memory_bytes = actual
            self._touch()
            ready: dict[str, Any] = {"type": "ready", "engine": self.engine, "reused": False}
            if self._engine_fallback_reason:
                ready["fallbackReason"] = self._engine_fallback_reason
            if self._actual_memory_bytes is not None:
                ready["memory_mb"] = round(self._actual_memory_bytes / (1024 * 1024), 2)
            return responses + [ready]

    @staticmethod
    def _validated_wav_path(command: dict[str, Any]) -> Path | str:
        value = command.get("path")
        if not isinstance(value, str) or not value.strip() or len(value) > MAX_PATH_CHARS:
            return "path must be a non-empty absolute WAV path no longer than 4096 characters"
        path = Path(value)
        if not path.is_absolute() or path.suffix.casefold() != ".wav":
            return "path must be an absolute .wav file"
        try:
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError):
            return "path does not resolve to a readable file"
        if not resolved.is_file():
            return "path must resolve to a regular file"
        return resolved

    def _transcribe_wav(self, command: dict[str, Any]) -> list[dict[str, Any]]:
        path = self._validated_wav_path(command)
        if isinstance(path, str):
            return [self._error("invalid_path", path)]
        profile_error = self._refresh_profile(command)
        if profile_error is not None:
            return [profile_error]
        with self._microphone_lock:
            if self._microphone_request_id is not None:
                return [self._error(
                    "microphone_active",
                    "Stop the active microphone session before transcribing a WAV file.",
                    engine=self.engine,
                )]
            reused = self._model is not None
            if self._model is None:
                responses = self._load(command)
                if responses[-1]["type"] == "error":
                    return responses
            else:
                responses = []
            try:
                audio = self._pcm_loader(path)
                self._model_access.acquire_read()
                try:
                    text = self._transcriber(
                        self._model,
                        audio,
                        language=self.profile.language,
                        glossary=self.profile.glossary,
                        output_mode=self.profile.output_mode,
                        punctuation=self.profile.punctuation,
                        script=self.profile.script,
                        mixed_spacing=self.profile.mixed_spacing,
                        hallucination_guard=self.profile.hallucination_guard,
                    )
                finally:
                    self._model_access.release_read()
            except Exception as exc:
                return responses + [self._error("transcribe_failed", f"{type(exc).__name__}: {exc}", engine=self.engine)]
            self._touch()
            if not text:
                return responses + [self._error("no_speech", "No speech was recognized.", engine=self.engine)]
            return responses + [{
                "type": "final",
                "transcript": str(text),
                "engine": self.engine,
                "reused": reused,
            }]

    def _status(self) -> dict[str, Any]:
        with self._microphone_lock:
            microphone_state = self._microphone_state
        response: dict[str, Any] = {
            "type": "status",
            "state": "ready" if self._model is not None else "unloaded",
            "engine": self.engine,
            "microphone_state": microphone_state,
        }
        if self._engine_fallback_reason:
            response["engineFallback"] = self._engine_fallback_reason
        if self._actual_memory_bytes is not None:
            response["memory_mb"] = round(self._actual_memory_bytes / (1024 * 1024), 2)
        return response

    @staticmethod
    def _command_size_ok(command: Any) -> bool:
        try:
            encoded = json.dumps(command, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError, OverflowError, RecursionError):
            return False
        return len(encoded) <= MAX_COMMAND_BYTES

    def handle(self, command: Any) -> list[dict[str, Any]]:
        self._unload_if_idle()
        if not self._command_size_ok(command):
            return [self._error("command_too_large", f"Command must not exceed {MAX_COMMAND_BYTES} UTF-8 bytes")]
        if not isinstance(command, dict):
            return [self._error("invalid_command", "Command must be a JSON object")]
        if self.shutdown_requested:
            return [self._error("shutdown", "Worker has already shut down")]
        name = command.get("command")
        if not isinstance(name, str) or not name:
            return [self._error("invalid_command", "command must be a non-empty string")]
        if name == "status":
            return [self._status()]
        if name == "load":
            return self._load(command)
        if name == "transcribe_wav":
            return self._transcribe_wav(command)
        if name == "start_microphone":
            return self._start_microphone(command)
        if name == "stop_microphone":
            return self._stop_microphone(command)
        if name == "unload":
            if self._microphone_is_active():
                return [self._error("microphone_active", "Stop the active microphone session before unloading the model.", engine=self.engine)]
            self.unload()
            return [{"type": "status", "state": "unloaded", "engine": self.engine}]
        if name == "shutdown":
            if self._microphone_is_active():
                return [self._error("microphone_active", "Stop the active microphone session before shutting down.", engine=self.engine)]
            self.unload()
            self.shutdown_requested = True
            return [{"type": "shutdown", "state": "shutdown"}]
        return [self._error("unknown_command", f"Unknown command: {name}")]


def _discard_line_remainder(input_stream: TextIO) -> None:
    """Discard bounded chunks until the current JSONL record terminates."""
    while True:
        remainder = input_stream.readline(MAX_COMMAND_BYTES + 1)
        if not remainder or remainder.endswith(("\n", "\r")):
            return


def serve(worker: LocalVoiceWorker, input_stream: TextIO, output_stream: TextIO) -> int:
    """Process one bounded JSON object per line until EOF or shutdown."""
    output_lock = Lock()

    def emit(response: dict[str, Any]) -> None:
        with output_lock:
            output_stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            output_stream.flush()

    worker._event_sink = emit
    worker.start_idle_watchdog(emit)
    try:
        while not worker.shutdown_requested:
            raw_line = input_stream.readline(MAX_COMMAND_BYTES + 1)
            if not raw_line:
                break
            if len(raw_line.encode("utf-8")) > MAX_COMMAND_BYTES:
                if not raw_line.endswith(("\n", "\r")):
                    _discard_line_remainder(input_stream)
                responses: Iterable[dict[str, Any]] = [
                    LocalVoiceWorker._error("command_too_large", f"Command must not exceed {MAX_COMMAND_BYTES} UTF-8 bytes")
                ]
            else:
                try:
                    command = json.loads(raw_line)
                except (json.JSONDecodeError, RecursionError) as exc:
                    responses = [LocalVoiceWorker._error("invalid_json", f"Invalid JSON: {exc.msg}")]
                else:
                    responses = worker.handle(command)
            for response in responses:
                emit(response)
    finally:
        worker.shutdown_idle_watchdog()
    return 0


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    _enable_crash_traceback()
    parser = argparse.ArgumentParser(description="UI-free local voice JSONL worker (whisper / sense_voice).")
    parser.add_argument("--model", default=os.environ.get("MAGIC_POINTER_WHISPER_MODEL") or "tiny")
    parser.add_argument("--engine", default=os.environ.get("MAGIC_POINTER_VOICE_ENGINE") or DEFAULT_ENGINE)
    parser.add_argument("--memory-limit-mb", type=int)
    parser.add_argument("--idle-unload-ms", type=int)
    args = parser.parse_args(argv)
    try:
        bundle = resolve_engine(args.engine, args.model)
        worker = LocalVoiceWorker(
            model_name=args.model,
            profile=bundle.profile_loader(),
            memory_limit_mb=args.memory_limit_mb,
            idle_unload_ms=args.idle_unload_ms,
            engine=args.engine,
        )
    except ValueError as exc:
        print(json.dumps(LocalVoiceWorker._error("invalid_configuration", str(exc)), ensure_ascii=False), flush=True)
        return 2
    return serve(worker, sys.stdin, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
