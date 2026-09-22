
from __future__ import annotations

import time
import os
from pathlib import Path
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.agent_runtime.errors import ActionFailure, FailureType
from app.context_pack.source_scope import AccessRequest
from app.context_pack.sources import Coverage, FragmentLocator, SourceRef

from .look_tool import VisionTimeout, VisionUnavailable
from app.governance.cancellation import CancelledError


def _check_cancelled(scope: object) -> None:
    checker = getattr(scope, "raise_if_cancelled", None) or getattr(getattr(scope, "token", None), "raise_if_cancelled", None)
    if callable(checker):
        checker()


def validate_live_source(source: SourceRef, window: dict[str, Any], *, surface_registry: Any = None, adapter_registry: Any = None) -> None:
    identity = source.identity
    if source.kind == "capture":
        return
    if identity.get("conversationIdentity"):
        from app.surface_adapter.registry import get_surface_registry
        from app.context_pack.chat_reader import _same_conversation

        expected = dict(identity["conversationIdentity"])
        if not expected.get("nativeConversationId") and expected.get("keyProvenance") == "window-surface":
            raise ActionFailure(FailureType.STALE_SNAPSHOT, "conversation identity_unavailable; rebind the current surface")
        result = (surface_registry or get_surface_registry()).try_resolve(window, None, None)
        conversation = next((obj for obj in getattr(result, "objects", ()) if obj.kind == "conversation"), None)
        actual = dict(conversation.fields.get("conversationIdentity") or {}) if conversation else {}
        if not actual or not _same_conversation(expected, actual):
            raise ActionFailure(FailureType.STALE_SNAPSHOT, "conversation identity changed; rebind the current surface")
        return
    from app.adapters.registry import default_adapter_registry

    registry = adapter_registry or default_adapter_registry()
    bounds = window.get("rect") or window.get("bbox") or [0, 0, 1, 1]
    point = {"x": (int(bounds[0]) + int(bounds[2])) // 2, "y": (int(bounds[1]) + int(bounds[3])) // 2}
    context = registry.read_first_context([window], target_point=point) if identity.get("targetId") else registry.read_first_context([window])
    artifacts = dict(getattr(context, "artifacts", {}) or {})
    if identity.get("targetId"):
        browser = dict(artifacts.get("browser_context") or {})
        actual = dict(browser.get("provenance") or {})
        if any(not identity.get(key) or str(actual.get(key) or "") != str(identity[key]) for key in ("browserInstanceId", "targetId", "documentEpoch")):
            raise ActionFailure(FailureType.STALE_SNAPSHOT, "browser identity changed or unavailable; rebind the current tab")
    elif identity.get("absolutePath"):
        actual = str(dict(artifacts.get("source_identity") or {}).get("absolutePath") or artifacts.get("pdf_document_path") or "")
        if not actual or os.path.normcase(str(Path(actual).resolve())) != os.path.normcase(str(Path(identity["absolutePath"]).resolve())):
            raise ActionFailure(FailureType.STALE_SNAPSHOT, "document identity changed or unavailable; rebind the current document")
    else:
        raise ActionFailure(FailureType.STALE_SNAPSHOT, "source identity_unavailable; bind the current window as a capture source")


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
        _check_cancelled(scope)
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
        _check_cancelled(scope)
        if not state:
            raise ActionFailure(FailureType.TOOL_ERROR, "live surface state is unavailable")
        capture = self._capture(source, state, parsed_locator)
        _check_cancelled(scope)
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
                    **({"scope": scope} if scope is not None else {}),
                ) or {})
                _check_cancelled(scope)
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
            except CancelledError:
                raise
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
            extent="selection" if parsed_locator is not None else "neighborhood",
            read_ranges=(parsed_locator.to_dict(),) if parsed_locator is not None else ({},),
            total_units=None,
            complete=False,
            next_cursor=None,
            missing_reason=missing_reason or "viewport_only",
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
