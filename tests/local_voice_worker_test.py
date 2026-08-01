from __future__ import annotations

import tempfile
import threading
import time
import unittest
import wave
import subprocess
from io import StringIO
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.local_voice_bridge import VoiceProfile
from scripts.local_voice_worker import (
    MAX_COMMAND_BYTES,
    LocalVoiceWorker,
    serve,
)


def write_wav(path: Path) -> None:
    samples = (np.ones(8_000, dtype=np.float32) * 0.25 * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes(samples.tobytes())


class FakeModel:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, _audio, **_options):
        self.calls += 1
        return {"text": f"heard-{self.calls}", "segments": []}


class LocalVoiceWorkerTests(unittest.TestCase):
    def make_worker(self, *, memory_limit_mb: int | None = None, idle_unload_ms: int | None = None, now=None, probe=None):
        self.load_calls = 0
        self.model = FakeModel()

        def loader(_model_name: str):
            self.load_calls += 1
            return self.model

        return LocalVoiceWorker(
            model_name="fake",
            profile=VoiceProfile(language="en"),
            model_loader=loader,
            memory_limit_mb=memory_limit_mb,
            idle_unload_ms=idle_unload_ms,
            memory_probe=probe or (lambda: 8 * 1024 * 1024),
            clock=now or (lambda: 0.0),
            profile_loader=lambda **_kwargs: VoiceProfile(language="en"),
        )

    def test_load_once_reuses_model_for_multiple_wav_transcriptions(self):
        worker = self.make_worker()
        with tempfile.TemporaryDirectory() as directory:
            wav_path = Path(directory) / "speech.wav"
            write_wav(wav_path)
            first = worker.handle({"command": "transcribe_wav", "path": str(wav_path)})
            second = worker.handle({"command": "transcribe_wav", "path": str(wav_path)})

        self.assertEqual(self.load_calls, 1)
        self.assertEqual([item["type"] for item in first], ["loading", "ready", "final"])
        self.assertEqual([item["transcript"] for item in first if item["type"] == "final"], ["heard-1"])
        self.assertIs(first[-1]["reused"], False)
        self.assertEqual([item["type"] for item in second], ["final"])
        self.assertEqual([item["transcript"] for item in second], ["heard-2"])
        self.assertIs(second[-1]["reused"], True)

    def test_transcription_forwards_all_n22_voice_profile_preferences(self):
        captured: dict[str, object] = {}

        def transcriber(
            _model,
            _audio,
            *,
            language,
            glossary,
            output_mode,
            punctuation,
            script,
            mixed_spacing,
            hallucination_guard,
        ):
            captured.update(
                language=language,
                glossary=glossary,
                output_mode=output_mode,
                punctuation=punctuation,
                script=script,
                mixed_spacing=mixed_spacing,
                hallucination_guard=hallucination_guard,
            )
            return "已转写"

        worker = LocalVoiceWorker(
            model_name="fake",
            profile=VoiceProfile(
                language="zh",
                output_mode="clean_spacing",
                punctuation="smart_zh",
                script="traditional",
                mixed_spacing="compact_cjk",
                hallucination_guard=False,
                glossary=("Magic Pointer",),
            ),
            model_loader=lambda _model_name: FakeModel(),
            transcriber=transcriber,
            profile_loader=lambda **_kwargs: VoiceProfile(
                language="zh",
                output_mode="clean_spacing",
                punctuation="smart_zh",
                script="traditional",
                mixed_spacing="compact_cjk",
                hallucination_guard=False,
                glossary=("Magic Pointer",),
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            wav_path = Path(directory) / "speech.wav"
            write_wav(wav_path)
            response = worker.handle({"command": "transcribe_wav", "path": str(wav_path)})

        self.assertEqual(response[-1]["type"], "final")
        self.assertEqual(
            captured,
            {
                "language": "zh",
                "glossary": ("Magic Pointer",),
                "output_mode": "clean_spacing",
                "punctuation": "smart_zh",
                "script": "traditional",
                "mixed_spacing": "compact_cjk",
                "hallucination_guard": False,
            },
        )

    def test_each_request_refreshes_project_scoped_profile_without_reloading_model(self):
        contexts: list[str | None] = []

        def profile_loader(*, context_path=None, **_kwargs):
            contexts.append(context_path)
            return VoiceProfile(glossary=(str(context_path),))

        captured_glossaries: list[tuple[str, ...]] = []

        def transcriber(_model, _audio, **options):
            captured_glossaries.append(options["glossary"])
            return "ok"

        worker = LocalVoiceWorker(
            model_name="fake",
            model_loader=lambda _name: FakeModel(),
            transcriber=transcriber,
            profile_loader=profile_loader,
        )
        with tempfile.TemporaryDirectory() as directory:
            wav_path = Path(directory) / "speech.wav"
            write_wav(wav_path)
            worker.handle({"command": "transcribe_wav", "path": str(wav_path), "contextPath": r"D:\\one"})
            worker.handle({"command": "transcribe_wav", "path": str(wav_path), "contextPath": r"D:\\two"})

        self.assertEqual(contexts, [r"D:\\one", r"D:\\two"])
        self.assertEqual(captured_glossaries, [(r"D:\\one",), (r"D:\\two",)])

    def test_idle_timeout_unloads_before_the_next_command(self):
        now = [0.0]
        worker = self.make_worker(now=lambda: now[0], idle_unload_ms=1_000)
        worker.handle({"command": "load"})
        now[0] = 2.0

        response = worker.handle({"command": "status"})

        self.assertEqual(response[0]["type"], "status")
        self.assertEqual(response[0]["state"], "unloaded")

    def test_idle_timeout_unloads_without_a_followup_stdin_command(self):
        now = [0.0]
        worker = self.make_worker(now=lambda: now[0], idle_unload_ms=1_000)
        events: list[dict[str, object]] = []
        worker.start_idle_watchdog(events.append, interval_seconds=0.001)
        try:
            worker.handle({"command": "load"})
            now[0] = 2.0
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline and not events:
                time.sleep(0.005)
        finally:
            worker.shutdown_idle_watchdog()

        self.assertEqual(worker.handle({"command": "status"})[0]["state"], "unloaded")
        self.assertEqual(events, [{"type": "status", "state": "unloaded", "reason": "idle_timeout", "engine": "whisper-fake-local"}])

    def test_status_does_not_extend_the_idle_deadline(self):
        now = [0.0]
        worker = self.make_worker(now=lambda: now[0], idle_unload_ms=1_000)
        worker.handle({"command": "load"})
        now[0] = 0.9
        self.assertEqual(worker.handle({"command": "status"})[0]["state"], "ready")
        now[0] = 1.0
        self.assertEqual(worker.handle({"command": "status"})[0]["state"], "unloaded")

    def test_memory_limit_unloads_and_fails_closed(self):
        worker = self.make_worker(memory_limit_mb=16, probe=lambda: 32 * 1024 * 1024)

        response = worker.handle({"command": "load", "estimated_memory_mb": 8})

        self.assertEqual([item["type"] for item in response], ["loading", "error"])
        self.assertEqual(response[0]["estimated_memory_mb"], 8)
        self.assertEqual(response[-1]["code"], "memory_limit_exceeded")
        self.assertEqual(worker.handle({"command": "status"})[0]["state"], "unloaded")

    def test_unknown_command_is_an_error(self):
        response = self.make_worker().handle({"command": "not_a_command"})
        self.assertEqual(response, [{"type": "error", "code": "unknown_command", "error": "Unknown command: not_a_command"}])

    def test_missing_local_model_is_an_explicit_error(self):
        def missing_loader(_model_name: str):
            raise FileNotFoundError("fake.pt")

        worker = LocalVoiceWorker(model_name="fake", model_loader=missing_loader)
        response = worker.handle({"command": "load"})

        self.assertEqual([item["type"] for item in response], ["loading", "error"])
        self.assertEqual(response[-1]["code"], "model_missing")

    def test_rejects_relative_wav_path_without_loading_a_model(self):
        worker = self.make_worker()
        response = worker.handle({"command": "transcribe_wav", "path": "speech.wav"})

        self.assertEqual(response[0]["code"], "invalid_path")
        self.assertEqual(self.load_calls, 0)

    def test_rejects_oversized_command_before_running_it(self):
        worker = self.make_worker()
        response = worker.handle({"command": "status", "padding": "x" * MAX_COMMAND_BYTES})

        self.assertEqual(response[0]["code"], "command_too_large")

    def test_jsonl_server_writes_one_response_per_protocol_event(self):
        worker = self.make_worker()
        incoming = StringIO('{"command":"status"}\n{"command":"shutdown"}\n')
        outgoing = StringIO()

        self.assertEqual(serve(worker, incoming, outgoing), 0)
        responses = [__import__("json").loads(line) for line in outgoing.getvalue().splitlines()]
        self.assertEqual([item["type"] for item in responses], ["status", "shutdown"])

    def test_worker_starts_from_the_same_script_invocation_used_by_electron(self):
        root = Path(__file__).resolve().parents[1]
        completed = subprocess.run(
            [sys.executable, "-u", "scripts/local_voice_worker.py"],
            input='{"command":"status"}\n{"command":"shutdown"}\n',
            text=True,
            encoding="utf-8",
            capture_output=True,
            cwd=root,
            timeout=15,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        responses = [__import__("json").loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([item["type"] for item in responses], ["status", "shutdown"])

    def test_jsonl_server_discards_the_remainder_of_an_oversized_line(self):
        worker = self.make_worker()
        incoming = StringIO('{"command":"status","padding":"' + "x" * MAX_COMMAND_BYTES + '"}\n{"command":"shutdown"}\n')
        outgoing = StringIO()

        self.assertEqual(serve(worker, incoming, outgoing), 0)

        responses = [__import__("json").loads(line) for line in outgoing.getvalue().splitlines()]
        self.assertEqual([item["type"] for item in responses], ["error", "shutdown"])
        self.assertEqual(responses[0]["code"], "command_too_large")

    def test_microphone_session_is_singleton_and_scoped_to_its_request_id(self):
        runner_started = threading.Event()
        events: list[dict[str, object]] = []

        def microphone_runner(_model, _profile, _request_id, _silence_ms, emit, stop_event):
            runner_started.set()
            stop_event.wait(1)
            if stop_event.is_set():
                emit({"type": "final", "transcript": "stopped speech"})

        self.load_calls = 0

        def loader(_model_name: str):
            self.load_calls += 1
            return FakeModel()

        worker = LocalVoiceWorker(
            model_name="fake",
            model_loader=loader,
            microphone_runner=microphone_runner,
            event_sink=events.append,
        )

        started = worker.handle({"command": "start_microphone", "requestId": "voice-1"})

        self.assertEqual([item["type"] for item in started], ["loading", "ready", "microphone_started"])
        self.assertTrue(runner_started.wait(1))
        self.assertEqual(worker.handle({"command": "start_microphone", "requestId": "voice-2"})[0]["code"], "microphone_busy")
        self.assertEqual(worker.handle({"command": "stop_microphone", "requestId": "voice-2"})[0]["code"], "microphone_request_mismatch")
        self.assertEqual(worker.handle({"command": "stop_microphone", "requestId": "voice-1"})[0]["type"], "microphone_stopping")

        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            event_types = [item["type"] for item in events]
            if "final" in event_types and "microphone_stopped" in event_types:
                break
            time.sleep(0.01)

        self.assertIn("final", [item["type"] for item in events])
        self.assertIn("microphone_stopped", [item["type"] for item in events])
        self.assertTrue(all(item["requestId"] == "voice-1" for item in events))
        self.assertEqual(worker.handle({"command": "status"})[0]["microphone_state"], "idle")

    def test_empty_partial_is_a_non_terminal_voice_activity_signal(self):
        activity_emitted = threading.Event()
        allow_final = threading.Event()
        events: list[dict[str, object]] = []

        def microphone_runner(_model, _profile, _request_id, _silence_ms, emit, _stop_event):
            emit({"type": "partial", "transcript": ""})
            activity_emitted.set()
            allow_final.wait(1)
            emit({"type": "final", "transcript": "真实语音"})

        worker = LocalVoiceWorker(
            model_name="fake",
            model_loader=lambda _model_name: FakeModel(),
            microphone_runner=microphone_runner,
            event_sink=events.append,
        )

        worker.handle({"command": "start_microphone", "requestId": "voice-activity"})
        self.assertTrue(activity_emitted.wait(1))
        self.assertNotIn("error", [event["type"] for event in events])
        self.assertEqual(worker.handle({"command": "status"})[0]["microphone_state"], "recording")

        allow_final.set()
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and "final" not in [event["type"] for event in events]:
            time.sleep(0.01)

        self.assertEqual(
            [event["transcript"] for event in events if event["type"] == "final"],
            ["真实语音"],
        )
        self.assertNotIn("error", [event["type"] for event in events])

    def test_wav_transcription_fails_closed_while_microphone_owns_the_model(self):
        runner_started = threading.Event()
        release_runner = threading.Event()

        def microphone_runner(_model, _profile, _request_id, _silence_ms, _emit, _stop_event):
            runner_started.set()
            release_runner.wait(1)

        worker = LocalVoiceWorker(
            model_name="fake",
            model_loader=lambda _model_name: FakeModel(),
            microphone_runner=microphone_runner,
        )
        with tempfile.TemporaryDirectory() as directory:
            wav_path = Path(directory) / "speech.wav"
            write_wav(wav_path)
            worker.handle({"command": "start_microphone", "requestId": "voice-exclusive"})
            self.assertTrue(runner_started.wait(1))

            response = worker.handle({"command": "transcribe_wav", "path": str(wav_path)})

        release_runner.set()
        self.assertEqual(response[0]["code"], "microphone_active")

    def test_push_mode_does_not_stop_after_the_removed_poll_buffer_limit(self):
        # The old poll-mode path buffered at most MAX_MICROPHONE_EVENTS=64
        # events and force-stopped the session when the buffer overflowed.
        # Push mode removed both the buffer and the cap; emitting well past the
        # old limit must not set the cooperative stop flag or drop any event.
        old_poll_buffer_limit = 64
        push_event_count = old_poll_buffer_limit + 1
        runner_done = threading.Event()
        forced_stop: list[bool] = []
        events: list[dict[str, object]] = []

        def microphone_runner(_model, _profile, _request_id, _silence_ms, emit, stop_event):
            for index in range(push_event_count):
                emit({"type": "partial", "transcript": f"partial-{index}"})
            forced_stop.append(stop_event.is_set())
            runner_done.set()

        worker = LocalVoiceWorker(
            model_name="fake",
            model_loader=lambda _model_name: FakeModel(),
            microphone_runner=microphone_runner,
            event_sink=events.append,
        )

        worker.handle({"command": "start_microphone", "requestId": "voice-push"})

        self.assertTrue(runner_done.wait(1))
        self.assertEqual(forced_stop, [False])
        self.assertEqual(
            len([event for event in events if event["type"] == "partial"]),
            push_event_count,
        )



    def test_completed_microphone_sessions_reuse_the_loaded_model(self):
        completed = threading.Event()
        self.load_calls = 0

        def microphone_runner(_model, _profile, _request_id, _silence_ms, emit, _stop_event):
            emit({"type": "final", "transcript": "done"})
            completed.set()

        def loader(_model_name: str):
            self.load_calls += 1
            return FakeModel()

        worker = LocalVoiceWorker(model_name="fake", model_loader=loader, microphone_runner=microphone_runner)
        first = worker.handle({"command": "start_microphone", "requestId": "voice-1"})
        self.assertTrue(completed.wait(1))
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and worker.handle({"command": "status"})[0]["microphone_state"] != "idle":
            time.sleep(0.01)

        second = worker.handle({"command": "start_microphone", "requestId": "voice-2"})

        self.assertEqual(self.load_calls, 1)
        self.assertEqual(first[-1]["type"], "microphone_started")
        self.assertEqual(second[0], {"type": "ready", "engine": "whisper-fake-local", "reused": True})

    def test_idle_watchdog_cannot_unload_between_model_reuse_and_microphone_reservation(self):
        now = [0.0]
        runner_models: list[object] = []
        runner_done = threading.Event()

        def microphone_runner(model, _profile, _request_id, _silence_ms, _emit, _stop_event):
            runner_models.append(model)
            runner_done.set()

        worker = self.make_worker(now=lambda: now[0], idle_unload_ms=1_000)
        worker._microphone_runner = microphone_runner
        worker.handle({"command": "load"})
        original_load = worker._load
        model_reused = threading.Event()
        allow_start = threading.Event()

        def delayed_load(command):
            response = original_load(command)
            model_reused.set()
            allow_start.wait(1)
            return response

        worker._load = delayed_load
        start_thread = threading.Thread(
            target=lambda: worker.handle({"command": "start_microphone", "requestId": "race"}),
        )
        start_thread.start()
        self.assertTrue(model_reused.wait(1))
        now[0] = 2.0
        unload_result: list[bool] = []
        unload_thread = threading.Thread(target=lambda: unload_result.append(worker._unload_if_idle()))
        unload_thread.start()
        time.sleep(0.02)
        allow_start.set()
        start_thread.join(1)
        unload_thread.join(1)

        self.assertEqual(unload_result, [False])
        self.assertTrue(runner_done.wait(1))
        self.assertIsNotNone(runner_models[0])

    def test_microphone_completion_refreshes_idle_deadline_before_releasing_reservation(self):
        now = [0.0]
        finish_runner = threading.Event()
        runner_finished = threading.Event()

        def microphone_runner(_model, _profile, _request_id, _silence_ms, _emit, _stop_event):
            finish_runner.wait(1)
            runner_finished.set()

        worker = self.make_worker(now=lambda: now[0], idle_unload_ms=1_000)
        worker._microphone_runner = microphone_runner
        worker.handle({"command": "start_microphone", "requestId": "completion-race"})
        now[0] = 2.0
        original_touch = worker._touch
        touch_entered = threading.Event()
        allow_touch = threading.Event()

        def delayed_touch():
            touch_entered.set()
            allow_touch.wait(1)
            original_touch()

        worker._touch = delayed_touch
        finish_runner.set()
        self.assertTrue(runner_finished.wait(1))
        self.assertTrue(touch_entered.wait(1))
        unload_result: list[bool] = []
        unload_thread = threading.Thread(target=lambda: unload_result.append(worker._unload_if_idle()))
        unload_thread.start()
        time.sleep(0.02)
        allow_touch.set()
        unload_thread.join(1)

        self.assertEqual(unload_result, [False])
        self.assertEqual(worker.handle({"command": "status"})[0]["state"], "ready")

    def test_shutdown_unloads_and_stops_worker(self):
        worker = self.make_worker()
        worker.handle({"command": "load"})

        response = worker.handle({"command": "shutdown"})

        self.assertEqual(response, [{"type": "shutdown", "state": "shutdown"}])
        self.assertTrue(worker.shutdown_requested)
        self.assertEqual(worker.handle({"command": "status"})[0]["code"], "shutdown")


if __name__ == "__main__":
    unittest.main()

    def test_microphone_start_cannot_overlap_inflight_wav_transcription(self):
        # Regression: _transcribe_wav must hold _microphone_lock across the
        # whole model call. If it released the lock between the "microphone
        # idle" check and the inference, a concurrent start_microphone could
        # hand the same Whisper model to two inference callers at once.
        transcribe_entered = threading.Event()
        allow_transcribe = threading.Event()
        runner_started = threading.Event()

        def transcriber(_model, _audio, **_options):
            transcribe_entered.set()
            allow_transcribe.wait(1)
            return "done"

        def microphone_runner(_model, _profile, _request_id, _silence_ms, _emit, _stop_event):
            runner_started.set()

        worker = LocalVoiceWorker(
            model_name="fake",
            model_loader=lambda _model_name: FakeModel(),
            transcriber=transcriber,
            microphone_runner=microphone_runner,
        )

        with tempfile.TemporaryDirectory() as directory:
            wav_path = Path(directory) / "speech.wav"
            write_wav(wav_path)

            wav_results: list[list[dict[str, object]]] = []
            wav_thread = threading.Thread(
                target=lambda: wav_results.append(
                    worker.handle({"command": "transcribe_wav", "path": str(wav_path)})
                ),
            )
            wav_thread.start()
            self.assertTrue(transcribe_entered.wait(1))

            mic_results: list[list[dict[str, object]]] = []
            mic_thread = threading.Thread(
                target=lambda: mic_results.append(
                    worker.handle({"command": "start_microphone", "requestId": "voice-race"})
                ),
            )
            mic_thread.start()
            time.sleep(0.05)
            self.assertFalse(runner_started.is_set())

            allow_transcribe.set()
            wav_thread.join(1)
            mic_thread.join(1)

        self.assertEqual(wav_results[0][-1]["transcript"], "done")
        self.assertTrue(runner_started.wait(1))
        self.assertEqual(mic_results[0][-1]["type"], "microphone_started")
