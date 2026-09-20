"""Shared runtime progress and trajectory projection for desktop surfaces."""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from scripts.bridge_progress import PhaseClock


def _trajectory_text(value: Any) -> str:
    """Serialize structured runtime facts as the JSON DSH's tool rows display."""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value or "")


def completed_trajectory(
    mapped: dict[str, Any],
    trajectory: list[dict[str, Any]],
    *,
    question: str = "",
    used_backend: str = "",
) -> list[dict[str, Any]]:
    """Finish the same trace for either surface, using actual runtime receipts."""
    answer = str(mapped.get("answer") or "")
    used_backend = str(mapped.get("usedBackend") or used_backend)
    records = [dict(record) for record in trajectory]
    if question:
        records = [{
            "seq": 1,
            "kind": "user",
            "turn": 1,
            "state": "done",
            "text": question,
            "startedAt": 0.0,
        }] + [{**record, "seq": int(record.get("seq", 0) or 0) + 1} for record in records]
    messages = [record for record in records if record.get("kind") == "message"]
    if messages:
        last_message = messages[-1]
        if not str(last_message.get("text") or "").strip():
            last_message["text"] = answer
        last_message["usedBackend"] = used_backend
        # 输入侧和缓存侧也要一起带上：卡片要按类别分段着色，只有输出这一项
        # 就画不出「上下文花在哪」。缺的键保持缺失（不补 0），渲染层才知道
        # 该不该画那一段。
        # Turn totals already live in mapped.modelUsage. Per-request usage
        # belongs to the original message and must not be overwritten here.
    receipts_by_id = {
        str(receipt.get("toolCallId") or ""): receipt
        for receipt in mapped.get("loopReceipts") or []
        if isinstance(receipt, dict)
    }
    for record in records:
        if record.get("kind") != "tool":
            continue
        receipt = receipts_by_id.get(str(record.get("callId") or ""))
        if receipt is None:
            continue
        record["text"] = _trajectory_text(receipt.get("arguments") or record.get("text") or "")
        record["result"] = _trajectory_text(record.get("result") or receipt.get("valuePreview") or "")
        record["usedBackend"] = str(receipt.get("usedBackend") or record.get("usedBackend") or "")
        if isinstance(receipt.get("latencyMs"), (int, float)):
            record["latencyMs"] = receipt["latencyMs"]
    return records


class RuntimeActivitySink:
    """Project loop events into honest desktop lifecycle rows and phase marks."""

    #: 流式正文增量的节流窗口：太密会淹没 stderr，太久会让用户看着空屏。
    CHUNK_FLUSH_INTERVAL_S = 0.12

    def __init__(
        self,
        clock: PhaseClock,
        request_header: Mapping[str, Any] | None = None,
    ) -> None:
        self.clock = clock
        raw_header = request_header if isinstance(request_header, Mapping) else {}
        try:
            max_tokens = max(0, int(raw_header.get("maxTokens") or 0))
        except (TypeError, ValueError):
            max_tokens = 0
        self._request_header = {
            "promptCache": bool(raw_header.get("promptCache")),
            **(
                {"usedBackend": str(raw_header.get("usedBackend") or "")[:160]}
                if str(raw_header.get("usedBackend") or "").strip()
                else {}
            ),
            **({"maxTokens": max_tokens} if max_tokens else {}),
        }
        self.activities: list[dict[str, Any]] = []
        self.trajectory: list[dict[str, Any]] = []
        self._active_model: dict[str, Any] | None = None
        self._active_message: dict[str, Any] | None = None
        self._tools: dict[str, dict[str, Any]] = {}
        self._trajectory_tools: dict[str, dict[str, Any]] = {}
        self._first_chunk_seen = False
        self._pending_chunk_text: list[str] = []
        self._last_chunk_flush = 0.0
        # 思考流（reasoning）：trajectory message record 逐轮累计 + 进度行
        # 边想边画；turn_reasoning 供终态载荷的 thinking 字段（Think 行）。
        self._pending_reasoning_text: list[str] = []
        self._last_reasoning_flush = 0.0
        self.turn_reasoning: list[str] = []

    def _flush_answer_chunks(self) -> None:
        if not self._pending_chunk_text:
            return
        text = "".join(self._pending_chunk_text)
        self._pending_chunk_text.clear()
        blob = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self._last_chunk_flush = time.perf_counter()
        try:
            self.clock.mark_blob("answer_chunk", blob)
        except Exception:  # noqa: BLE001 - 流式展示永远不能弄坏回合本身
            self._pending_chunk_text.clear()

    def _flush_reasoning_chunks(self) -> None:
        if not self._pending_reasoning_text:
            return
        text = "".join(self._pending_reasoning_text)
        self._pending_reasoning_text.clear()
        blob = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self._last_reasoning_flush = time.perf_counter()
        try:
            self.clock.mark_blob("reasoning_chunk", blob)
        except Exception:  # noqa: BLE001 - 流式展示永远不能弄坏回合本身
            self._pending_reasoning_text.clear()

    def _append_record(self, record: dict[str, Any]) -> dict[str, Any]:
        record["seq"] = len(self.trajectory) + 1
        self.trajectory.append(record)
        return record

    def __call__(self, event: Any) -> None:
        kind = str(getattr(event, "kind", ""))
        if kind == "loop_stopped":
            self._flush_answer_chunks()
            self._flush_reasoning_chunks()
            return
        if kind == "loop_start":
            self.clock.mark("agent_start")
            return
        if kind == "tools_truncated":
            dropped = tuple(str(name) for name in getattr(event, "dropped", ()) if str(name))
            limit = int(getattr(event, "limit", 0) or 0)
            self._append_record({
                "kind": "notice",
                "state": "done",
                "text": (
                    f"已注册 {limit + len(dropped)} 个工具，超过本轮上限 {limit}；"
                    "本轮未暴露："
                    + "、".join(dropped)
                    + "。需要时可用 Tools 搜索加载。"
                ),
            })
            return
        if kind == "turn_started":
            self._flush_answer_chunks()
            self._flush_reasoning_chunks()
            self.turn_reasoning.clear()
            turn = int(getattr(event, "turn", 0) or 0)
            started_ms = self.clock.mark("model_request", turn=turn)
            self._append_record({
                "kind": "request-header",
                "turn": turn,
                "step": turn,
                "startedAt": started_ms,
                **self._request_header,
            })
            self._active_message = self._append_record({
                "kind": "message",
                "turn": turn,
                "step": turn,
                "state": "running",
                "text": "",
                "startedAt": started_ms,
            })
            self._active_model = {
                "kind": "model",
                "turn": turn,
                "state": "running",
                "startedMs": started_ms,
            }
            self.activities.append(self._active_model)
            self._first_chunk_seen = False
            return
        if kind == "model_usage":
            usage = dict(getattr(event, "usage", {}) or {})
            blob = base64.b64encode(json.dumps(usage).encode("utf-8")).decode("ascii")
            at_ms = self.clock.mark_blob("model_usage", blob)
            if self._active_message is not None:
                self._active_message["modelUsage"] = usage
                if usage.get("contextEstimated") == 0:
                    for source, target in (
                        ("contextTokens", "inputTokens"), ("lastOutputTokens", "outputTokens"),
                        ("lastCacheReadTokens", "cacheReadTokens"), ("lastCacheWriteTokens", "cacheWriteTokens"),
                    ):
                        if source in usage:
                            self._active_message[target] = usage[source]
                    self._active_message["completedAt"] = at_ms
                    if self._active_model is not None:
                        self._active_model["state"] = "done"
                        self._active_model["latencyMs"] = max(0.0, at_ms - float(self._active_model.get("startedMs", at_ms)))
            return
        if kind == "model_chunk":
            text = str(getattr(event, "text", "") or "")
            if self._active_message is not None and text:
                self._active_message["text"] = str(self._active_message.get("text") or "") + text
            if not self._first_chunk_seen:
                self._first_chunk_seen = True
                at_ms = self.clock.mark("model_first_chunk")
                if self._active_model is not None:
                    self._active_model["firstTokenMs"] = max(
                        0.0, at_ms - float(self._active_model.get("startedMs") or 0.0)
                    )
                if self._active_message is not None:
                    self._active_message["firstTokenAt"] = at_ms
            if text:
                # Studio 流式正文：增量 base64 上线，渲染层边收边画。
                self._pending_chunk_text.append(text)
                if time.perf_counter() - self._last_chunk_flush >= self.CHUNK_FLUSH_INTERVAL_S:
                    self._flush_answer_chunks()
            return
        if kind == "reasoning_chunk":
            # 思考流：记进 message record（正式渲染）+ 进度行（边想边画）。
            text = str(getattr(event, "text", "") or "")
            if not text:
                return
            self.turn_reasoning.append(text)
            if self._active_message is not None:
                self._active_message["reasoning"] = (
                    str(self._active_message.get("reasoning") or "") + text
                )
            self._pending_reasoning_text.append(text)
            if time.perf_counter() - self._last_reasoning_flush >= self.CHUNK_FLUSH_INTERVAL_S:
                self._flush_reasoning_chunks()
            return
        if kind == "tool_call_started":
            # 工具边界前把持有的正文尾巴冲出去：模型先说话再调工具时，
            # 文本必须落在工具行之前，不能被节流窗口吞到下一轮。
            self._flush_answer_chunks()
            self._flush_reasoning_chunks()
            call_id = str(getattr(event, "id", ""))
            name = str(getattr(event, "name", "") or "tool")
            arguments = _trajectory_text(getattr(event, "arguments", {}))
            blob = base64.b64encode(json.dumps({"id": call_id, "name": name, "args": arguments}).encode("utf-8")).decode("ascii")
            started_ms = self.clock.mark_blob("tool_call", blob)
            activity = {
                "kind": "tool",
                "id": call_id,
                "name": name,
                "state": "running",
            }
            self.activities.append(activity)
            self._tools[call_id] = activity
            record = self._append_record({
                "kind": "tool",
                "turn": int(self._active_message.get("turn", 0)) if self._active_message else 0,
                "callId": call_id,
                "name": name,
                "state": "running",
                "text": arguments,
                "startedAt": started_ms,
            })
            self._trajectory_tools[call_id] = record
            return
        if kind == "tool_call_finished":
            result = getattr(event, "result", None)
            call_id = str(getattr(result, "tool_call_id", ""))
            name = str(getattr(result, "tool_name", "") or "tool")
            failed = bool(getattr(result, "is_error", False))
            backend = str(getattr(result, "used_backend", "") or "")
            latency = float(getattr(result, "latency_ms", 0.0) or 0.0)
            # Arguments and output are runtime evidence. A single blob preserves
            # complete tool rows for both surfaces without the phase-token cap.
            payload = {
                "id": call_id, "name": name,
                "state": "error" if failed else "done", "backend": backend or "-",
                "latency_ms": latency,
                "args": _trajectory_text(getattr(result, "arguments", "")),
                "result": _trajectory_text(getattr(result, "value", "")),
            }
            blob = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
            completed_ms = self.clock.mark_blob(
                "tool_result", blob,
            )
            activity = self._tools.get(call_id)
            if activity is None:
                activity = {"kind": "tool", "id": call_id, "name": name}
                self.activities.append(activity)
            activity.update({
                "state": "error" if failed else "done",
                "latencyMs": latency,
                "usedBackend": backend,
            })
            record = self._trajectory_tools.get(call_id)
            if record is None:
                record = self._append_record({
                    "kind": "tool",
                    "turn": int(self._active_message.get("turn", 0)) if self._active_message else 0,
                    "callId": call_id,
                    "name": name,
                    "startedAt": max(0.0, completed_ms - latency),
                })
            record.update({
                "state": "error" if failed else "done",
                "completedAt": completed_ms,
                "latencyMs": latency,
                "usedBackend": backend,
                "text": _trajectory_text(getattr(result, "arguments", "")),
                "result": _trajectory_text(getattr(result, "value", "")),
                "isError": failed,
            })
            return
        if kind == "turn_finished":
            # 回合正文结束：把节流窗口里持有的尾巴全部冲出去，不能丢字。
            self._flush_answer_chunks()
            self._flush_reasoning_chunks()
            state = getattr(event, "state", None)
            transition = getattr(state, "transition", None)
            state_value = str(
                getattr(transition, "value", None)
                or getattr(state, "value", None)
                or "done"
            )
            at_ms = self.clock.mark("model_response", state=state_value)
            if self._active_model is not None:
                if "latencyMs" not in self._active_model:
                    self._active_model["state"] = (
                        "error" if state_value not in {"done", "completed", "tool_result"} else "done"
                    )
                self._active_model.setdefault("latencyMs", max(
                    0.0, at_ms - float(self._active_model.pop("startedMs", at_ms))
                ))
            if self._active_message is not None:
                self._active_message["state"] = (
                    "error" if state_value not in {"done", "completed", "tool_result"} else "done"
                )
                self._active_message.setdefault("completedAt", at_ms)
            return
        if kind == "budget_renewed":
            self.clock.mark(
                "budget_renewed",
                turn=getattr(event, "turn", 0),
                renewals=getattr(event, "renewals_used", 0),
            )
