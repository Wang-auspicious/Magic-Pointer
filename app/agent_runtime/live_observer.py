"""Task-scoped live surface observation.

``Look`` remains bound to the immutable gesture frame. ``LiveObserver``
re-resolves an authorized SourceRef, obtains a fresh structural snapshot and
fresh pixels, then asks the configured vision backend the caller's question.
Raw pixels never enter the model-visible result.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.agent_runtime.errors import ActionFailure, FailureType
from app.context_pack.source_scope import AccessRequest
from app.context_pack.sources import Coverage, FragmentLocator, SourceRef

from .look_tool import VisionTimeout, VisionUnavailable


@dataclass(frozen=True, slots=True)
class SurfaceCapture:
    image_bytes: bytes
    used_backend: str


class LiveObserver:
    def __init__(
        self,
        *,
        source_resolver: Callable[[str], SourceRef | None],
        state_reader: Callable[[SourceRef, FragmentLocator | None], dict[str, Any]],
        capture: Callable[[SourceRef, dict[str, Any], FragmentLocator | None], SurfaceCapture],
        vision_backend: Any,
        timeout_ms: int = 30_000,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        self._source_resolver = source_resolver
        self._state_reader = state_reader
        self._capture = capture
        self._vision_backend = vision_backend
        self._timeout_ms = max(1, int(timeout_ms))
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))

    def access_for(self, args: dict[str, object]) -> AccessRequest:
        return AccessRequest(
            action="read",
            source_ids=(str(args.get("source_id") or ""),),
        )

    def observe(
        self,
        source_id: str,
        question: str,
        locator: dict[str, Any] | None = None,
        scope: object = None,
    ) -> dict[str, Any]:
        del scope
        started = time.perf_counter()
        key = str(source_id or "").strip()
        try:
            source = self._source_resolver(key)
        except (KeyError, ValueError):
            source = None
        if source is None or "read" not in source.capabilities:
            raise ActionFailure(
                FailureType.PERMISSION_DENIED,
                f"source is not bound to this task: {key or '<empty>'}",
            )
        parsed_locator = FragmentLocator.from_dict(locator) if locator is not None else None
        state = dict(self._state_reader(source, parsed_locator) or {})
        if not state:
            raise ActionFailure(FailureType.TOOL_ERROR, "live surface state is unavailable")
        capture = self._capture(source, state, parsed_locator)
        if not capture.image_bytes:
            raise ActionFailure(FailureType.TOOL_ERROR, "live surface capture is empty")

        observed_at_ms = int(self._now_ms())
        observed_at_utc = datetime.fromtimestamp(
            observed_at_ms / 1000.0,
            tz=UTC,
        ).isoformat(timespec="milliseconds")
        missing_reason: str | None = None
        evidence_status = "ok"
        vision: dict[str, Any]
        vision_backend_name = ""
        if self._vision_backend is None:
            evidence_status = "degraded"
            missing_reason = "vision_not_configured"
            vision = {"status": "unsupported", "text": "", "error": missing_reason}
        else:
            try:
                raw_vision = dict(self._vision_backend.describe(
                    capture.image_bytes,
                    str(question or "Describe the current surface state."),
                    self._timeout_ms,
                ) or {})
                vision_backend_name = str(raw_vision.get("backend") or "vision")
                vision = {
                    "status": "ok",
                    "text": str(raw_vision.get("text") or ""),
                    "latencyMs": raw_vision.get("latency_ms"),
                    "backend": vision_backend_name,
                }
                if not vision["text"].strip():
                    evidence_status = "degraded"
                    missing_reason = "vision_returned_empty"
                    vision["status"] = "empty_confirmed"
            except VisionUnavailable:
                evidence_status = "degraded"
                missing_reason = "vision_unavailable"
                vision = {"status": "unsupported", "text": "", "error": missing_reason}
            except VisionTimeout:
                evidence_status = "degraded"
                missing_reason = "vision_timeout"
                vision = {"status": "timeout", "text": "", "error": missing_reason}
            except Exception as exc:
                evidence_status = "degraded"
                missing_reason = f"vision_error:{type(exc).__name__}"
                vision = {"status": "error", "text": "", "error": missing_reason}

        structure_backend = str(state.get("used_backend") or "uia.live")
        used_backends = [structure_backend, str(capture.used_backend)]
        if vision_backend_name:
            used_backends.append(vision_backend_name)
        used_backend = "+".join(dict.fromkeys(item for item in used_backends if item))
        coverage = Coverage(
            extent="selection" if parsed_locator is not None else "document",
            read_ranges=(parsed_locator.to_dict(),) if parsed_locator is not None else ({},),
            total_units=1,
            complete=missing_reason is None,
            next_cursor=None,
            missing_reason=missing_reason,
        )
        return {
            "sourceId": source.source_id,
            "snapshotId": str(state.get("snapshot_id") or ""),
            "observedAtMs": observed_at_ms,
            "observedAtUtc": observed_at_utc,
            "locator": parsed_locator.to_dict() if parsed_locator is not None else None,
            "structure": state,
            "vision": vision,
            "coverage": coverage.to_dict(),
            "evidenceStatus": evidence_status,
            "usedBackend": used_backend,
            "latencyMs": (time.perf_counter() - started) * 1000.0,
        }


__all__ = ["LiveObserver", "SurfaceCapture"]
