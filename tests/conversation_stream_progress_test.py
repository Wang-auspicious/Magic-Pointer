"""Studio 流式正文 / 停止 / 插话的桥端协议。

三个用户可见行为的契约（GUI 侧消费同一协议）：
- answer_chunk：model_chunk 的正文增量以 base64 走 @@mp 进度行，节流合并，
  尾巴在 turn 边界前必须冲出去；
- session_ready：携带 sid=，渲染层由此拿到 durable session id 用于停止/插话；
- plan 推送走 mark_blob，不受 _token 120 字符截断（多步计划此前必然被截断，
  decodePlanToken 静默失败，计划卡消失）。
"""

from __future__ import annotations

import base64
import io
import json
from types import SimpleNamespace

from scripts.bridge_progress import PhaseClock, PROGRESS_PREFIX
from scripts import conversation_bridge


def _clock_with_stream() -> tuple[PhaseClock, io.StringIO]:
    stream = io.StringIO()
    return PhaseClock("conversation", stream=stream), stream


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _answer_chunks(stream: io.StringIO) -> list[str]:
    blobs: list[str] = []
    for line in stream.getvalue().splitlines():
        if not line.startswith(PROGRESS_PREFIX):
            continue
        fields = dict(
            token.split("=", 1) for token in line[len(PROGRESS_PREFIX):].split() if "=" in token
        )
        if fields.get("phase") == "answer_chunk":
            blobs.append(fields["b64"])
    return blobs


def _phase_chunks(stream: io.StringIO, phase: str) -> list[str]:
    blobs: list[str] = []
    for line in stream.getvalue().splitlines():
        if not line.startswith(PROGRESS_PREFIX):
            continue
        fields = dict(
            token.split("=", 1)
            for token in line[len(PROGRESS_PREFIX):].split()
            if "=" in token
        )
        if fields.get("phase") == phase:
            blobs.append(fields["b64"])
    return blobs


def test_mark_blob_writes_verbatim_token_beyond_token_cap():
    clock, stream = _clock_with_stream()
    blob = "A" * 500  # 远超 _token 的 120 字符截断
    clock.mark_blob("plan", blob)
    line = [l for l in stream.getvalue().splitlines() if "phase=plan" in l][0]
    assert f"b64={blob}" in line, "mark_blob must carry the full payload verbatim"


def test_plan_snapshot_roundtrips_through_mark_blob():
    clock, stream = _clock_with_stream()
    steps = [{"content": f"第{i}步：" + "细节" * 30, "status": "pending"} for i in range(6)]
    conversation_bridge.emit_plan_snapshot(clock, steps)
    line = [l for l in stream.getvalue().splitlines() if "phase=plan" in l][0]
    b64_value = [t for t in line.split() if t.startswith("b64=")][0][len("b64="):]
    decoded = json.loads(base64.b64decode(b64_value).decode("utf-8"))
    assert decoded["steps"] == steps, "plan push must survive the wire verbatim"


def test_activity_sink_emits_answer_chunk_lines_decodable():
    clock, stream = _clock_with_stream()
    sink = conversation_bridge._ConversationActivitySink(clock)
    sink(SimpleNamespace(kind="turn_started", turn=1))
    for text in ("你好", "，世界", "！"):
        sink(SimpleNamespace(kind="model_chunk", text=text))
    sink(SimpleNamespace(kind="turn_finished", state=SimpleNamespace(value="done")))
    blobs = _answer_chunks(stream)
    assert blobs, "model chunks must be streamed to the progress channel"
    joined = "".join(base64.b64decode(b).decode("utf-8") for b in blobs)
    assert joined == "你好，世界！"


def test_activity_sink_flushes_tail_before_turn_boundary():
    import time

    clock, stream = _clock_with_stream()
    sink = conversation_bridge._ConversationActivitySink(clock)
    sink(SimpleNamespace(kind="turn_started", turn=1))
    sink._last_chunk_flush = time.perf_counter()  # 刚冲过，节流窗口内
    sink(SimpleNamespace(kind="model_chunk", text="尾巴"))
    assert not _answer_chunks(stream), "throttled chunk must not emit immediately"
    sink(SimpleNamespace(kind="tool_call_started", id="c1", name="run_command"))
    blobs = _answer_chunks(stream)
    assert "".join(base64.b64decode(b).decode("utf-8") for b in blobs) == "尾巴", (
        "turn boundary must flush the held-back tail so it is never lost"
    )


def test_batched_ascii_deltas_are_encoded_once_without_padding_loss():
    import time

    clock, stream = _clock_with_stream()
    sink = conversation_bridge._ConversationActivitySink(clock)
    sink(SimpleNamespace(kind="turn_started", turn=1))
    sink._last_chunk_flush = time.perf_counter()
    sink._last_reasoning_flush = time.perf_counter()
    for text in ("a", "b", "c"):
        sink(SimpleNamespace(kind="model_chunk", text=text))
    for text in ("x", "y", "z"):
        sink(SimpleNamespace(kind="reasoning_chunk", text=text))
    sink(SimpleNamespace(kind="turn_finished", state=SimpleNamespace(value="done")))

    answers = _phase_chunks(stream, "answer_chunk")
    reasoning = _phase_chunks(stream, "reasoning_chunk")
    assert "".join(base64.b64decode(blob).decode("utf-8") for blob in answers) == "abc"
    assert "".join(base64.b64decode(blob).decode("utf-8") for blob in reasoning) == "xyz"


def test_session_ready_mark_carries_sid():
    clock, stream = _clock_with_stream()
    session_id = "agent-studio-new-" + "a" * 32
    conversation_bridge.emit_session_ready(clock, session_id)
    line = [l for l in stream.getvalue().splitlines() if "phase=session_ready" in l][0]
    assert f"sid={session_id}" in line


def test_empty_chunk_never_emits_answer_chunk_line():
    clock, stream = _clock_with_stream()
    sink = conversation_bridge._ConversationActivitySink(clock)
    sink(SimpleNamespace(kind="turn_started", turn=1))
    sink(SimpleNamespace(kind="model_chunk", text=""))
    sink(SimpleNamespace(kind="tool_call_finished", result=SimpleNamespace(
        tool_call_id="c1", tool_name="ls", is_error=False, used_backend="x", latency_ms=1.0)))
    assert not _answer_chunks(stream)


def test_tool_truncation_is_projected_as_a_visible_notice() -> None:
    clock, _stream = _clock_with_stream()
    sink = conversation_bridge._ConversationActivitySink(clock)
    sink(SimpleNamespace(
        kind="tools_truncated",
        dropped=("mcp_alpha", "mcp_beta"),
        limit=3,
    ))

    notices = [record for record in sink.trajectory if record.get("kind") == "notice"]
    assert len(notices) == 1
    assert "已注册 5 个工具" in notices[0]["text"]
    assert "超过本轮上限 3" in notices[0]["text"]
    assert "mcp_alpha" in notices[0]["text"]
