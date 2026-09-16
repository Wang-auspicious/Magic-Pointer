"""Streaming answer deltas on the ``@@mp`` progress channel.

The bug this covers: ``electron/main.ts`` has always reacted to
``phase=answer_chunk`` by calling ``appendStageLiveAnswer``, and
``conversation_bridge`` has always emitted it — but ``selection_bridge``, which
drives the primary circle-and-point surface, never did. The result was that the
same model turn streamed text into the Studio view and appeared all at once on
the selection view. These tests pin the shared buffer and the wiring on both
bridges so the two cannot silently diverge again.
"""

import base64
import io

import pytest

from scripts.bridge_progress import PhaseClock, StreamChunkBuffer


def _chunks(stream: io.StringIO) -> list[str]:
    """Decoded ``answer_chunk`` payloads, in order."""
    out = []
    for line in stream.getvalue().splitlines():
        fields = {}
        for token in line.split(" ")[1:]:
            key, _, value = token.partition("=")
            fields[key] = value
        if fields.get("phase") == "answer_chunk":
            out.append(base64.b64decode(fields.get("b64", "")).decode("utf-8"))
    return out


def _clock(stream: io.StringIO) -> PhaseClock:
    return PhaseClock("test", stream=stream)


class TestStreamChunkBuffer:
    def test_flush_is_noop_when_nothing_was_appended(self) -> None:
        stream = io.StringIO()
        StreamChunkBuffer(_clock(stream), "answer_chunk").flush()
        assert stream.getvalue() == ""

    def test_flush_emits_a_decodable_row(self) -> None:
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk")
        buffer.append("你好")
        buffer.flush()
        assert _chunks(stream) == ["你好"]

    def test_first_delta_is_never_withheld(self) -> None:
        # The first token must paint immediately — time-to-first-token is what
        # the user feels, and a throttle window in front of it is pure added
        # latency. Only the deltas after it are coalesced.
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk", interval_s=60.0)
        buffer.append("first")
        assert _chunks(stream) == ["first"]

    def test_flush_clears_the_buffer(self) -> None:
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk", interval_s=60.0)
        buffer.append("one")
        buffer.flush()
        buffer.flush()
        assert _chunks(stream) == ["one"]

    def test_append_throttles_after_the_first(self) -> None:
        # One row per token would flood the stderr line protocol.
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk", interval_s=60.0)
        buffer.append("a")
        buffer.append("b")
        buffer.append("c")
        assert _chunks(stream) == ["a"]
        buffer.flush()
        assert _chunks(stream) == ["a", "bc"]

    def test_append_flushes_once_the_interval_elapses(self) -> None:
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk", interval_s=0.0)
        buffer.append("a")
        assert _chunks(stream) == ["a"]

    def test_empty_text_is_ignored(self) -> None:
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk", interval_s=0.0)
        buffer.append("")
        assert _chunks(stream) == []

    def test_none_clock_accumulates_nothing(self) -> None:
        # A bridge run without progress reporting must not hold text forever.
        buffer = StreamChunkBuffer(None, "answer_chunk", interval_s=0.0)
        buffer.append("dropped")
        buffer.flush()
        assert buffer._pending == []

    def test_phase_is_configurable(self) -> None:
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "reasoning_chunk", interval_s=0.0)
        buffer.append("thinking")
        assert "phase=reasoning_chunk" in stream.getvalue()

    def test_non_ascii_survives_the_round_trip(self) -> None:
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk", interval_s=0.0)
        buffer.append("中文 🎯 ünïcödé")
        assert _chunks(stream) == ["中文 🎯 ünïcödé"]

    def test_blob_contains_no_whitespace(self) -> None:
        # mark_blob promises a whitespace-free token; a base64 payload
        # containing a space would break the line parser.
        stream = io.StringIO()
        buffer = StreamChunkBuffer(_clock(stream), "answer_chunk", interval_s=0.0)
        buffer.append("a b c\nd\te")
        for line in stream.getvalue().splitlines():
            blob = line.split("b64=", 1)[1]
            assert " " not in blob and "\t" not in blob

    def test_mark_failure_does_not_propagate(self) -> None:
        class Exploding:
            def mark_blob(self, phase, blob):
                raise RuntimeError("stderr closed")

        buffer = StreamChunkBuffer(Exploding(), "answer_chunk", interval_s=0.0)
        buffer.append("text")  # must not raise
        assert buffer._pending == []


class TestBothBridgesPublishStreamingAnswer:
    """Contract: the two loop-driven bridges must both feed this channel.

    Checked statically because the sinks are closures inside multi-thousand
    line functions and cannot be instantiated in isolation. It is not a
    substitute for the behavioural tests above — it is a tripwire for the
    specific regression where one bridge has the wiring and the other does
    not, which is exactly what happened.
    """

    @pytest.mark.parametrize(
        "path",
        ["scripts/selection_bridge.py", "scripts/conversation_bridge.py"],
    )
    def test_bridge_emits_answer_chunks(self, path: str) -> None:
        source = open(path, encoding="utf-8").read()
        assert "answer_chunk" in source, f"{path} never publishes the streaming answer"
