
from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, Protocol, runtime_checkable

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.evidence.contract import (
    Evidence,
    EvidenceSource,
    EvidenceStatus,
    failed_evidence,
    ok_evidence,
)

DEFAULT_PROMPT = "Describe the contents of this image region."
class VisionUnavailable(Exception):
    pass


class VisionTimeout(Exception):
    pass


@runtime_checkable
class VisionBackend(Protocol):

    def describe(self, image_bytes: bytes, prompt: str, timeout_ms: int) -> dict[str, Any]:
        ...


def _box_bytes(box: tuple[int, int, int, int]) -> bytes:
    return b"crop:%d,%d,%d,%d" % box


def _normalize_box(box: Sequence[int]) -> tuple[int, int, int, int]:
    if not isinstance(box, (tuple, list)) or len(box) != 4:
        raise ValueError("invalid_box")
    vals: list[int] = []
    for value in box:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("invalid_box")
        vals.append(value)
    return (vals[0], vals[1], vals[2], vals[3])


class LookTool:

    def __init__(
        self,
        backend: VisionBackend | None,
        max_box_side: int = 4096,
        min_box_side: int = 32,
        timeout_ms: int = 30000,
        capture: Callable[[tuple[int, int, int, int]], bytes] | None = None,
        max_calls: int | None = 12,
        captured_at: str | None = None,
        resolver: Callable[[str], Sequence[int] | None] | None = None,
    ) -> None:
        self._backend = backend
        self._max_box_side = max_box_side
        self._min_box_side = min_box_side
        self._timeout_ms = timeout_ms
        self._capture = capture if capture is not None else _box_bytes
        self._max_calls = max_calls
        self._calls_used = 0
        self._captured_at = str(captured_at or "gesture time")
        self._resolver = resolver


    def look(
        self,
        anchor: str,
        box_ltrb: Sequence[int] | None = None,
        prompt: str | None = None,
        resolver: Callable[[str], Sequence[int] | None] | None = None,
    ) -> Evidence:
        if self._backend is None:
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.UNSUPPORTED,
                "vision_not_configured",
            )
        if self._max_calls is not None and self._calls_used >= self._max_calls:
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.UNSUPPORTED,
                f"look_quota_exhausted: {self._max_calls} vision calls used this run",
            )

        if box_ltrb is None:
            try:
                box = self._anchor_box(anchor, resolver or self._resolver)
            except ValueError as exc:
                return failed_evidence(
                    EvidenceSource.VISION, EvidenceStatus.ERROR, str(exc)
                )
        else:
            try:
                box = _normalize_box(box_ltrb)
            except ValueError as exc:
                return failed_evidence(
                    EvidenceSource.VISION, EvidenceStatus.ERROR, str(exc)
                )

        width = box[2] - box[0]
        height = box[3] - box[1]
        if (
            width < self._min_box_side
            or height < self._min_box_side
            or width > self._max_box_side
            or height > self._max_box_side
        ):
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.ERROR,
                "box_out_of_bounds",
            )

        image_bytes = self._capture(box)
        if not image_bytes:
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.UNSUPPORTED,
                "frozen_frame_crop_unavailable",
            )
        self._calls_used += 1
        text_prompt = prompt if prompt is not None else DEFAULT_PROMPT
        try:
            result = self._backend.describe(image_bytes, text_prompt, self._timeout_ms)
        except VisionUnavailable as exc:
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.UNSUPPORTED,
                f"vision_unavailable: {exc}" if str(exc) else "vision_unavailable",
            )
        except VisionTimeout:
            return failed_evidence(
                EvidenceSource.VISION, EvidenceStatus.TIMEOUT, "vision_timeout"
            )
        except Exception as exc:
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.ERROR,
                f"vision_error: {exc!r}",
            )

        text = result.get("text", "")
        latency = result.get("latency_ms")
        backend_name = result.get("backend", "unknown")
        note = (
            f"backend={backend_name}; box={box[0]},{box[1]},{box[2]},{box[3]}"
            "; frame=historical"
        )
        value = f"[historical frozen frame captured at {self._captured_at}]\n{text}"
        return ok_evidence(
            value,
            EvidenceSource.VISION,
            latency_ms=latency,
            captured_at_utc=(
                self._captured_at if self._captured_at != "gesture time" else None
            ),
            note=note,
        )

    @staticmethod
    def _anchor_box(
        anchor: str,
        resolver: Callable[[str], Sequence[int] | None] | None,
    ) -> tuple[int, int, int, int]:
        if anchor.startswith("bbox:"):
            parts = anchor[len("bbox:"):].split(",")
            if len(parts) != 4:
                raise ValueError("invalid_anchor_format")
            try:
                return tuple(int(part) for part in parts)  # type: ignore[return-value]
            except ValueError:
                raise ValueError("invalid_anchor_format") from None
        if anchor.startswith(("element:", "reference:")):
            if len(anchor) == len("element:"):
                raise ValueError("invalid_anchor_format")
            if resolver is None or not callable(resolver):
                raise ValueError("anchor_resolve_failed")
            box = resolver(anchor)
            if box is None:
                raise ValueError("anchor_resolve_failed")
            return _normalize_box(box)
        raise ValueError("invalid_anchor_format")


    def _execute_look(
        self,
        anchor: str,
        box: Sequence[int] | None = None,
        prompt: str | None = None,
        scope: object = None,
    ) -> Evidence:
        return self.look(anchor, box_ltrb=box, prompt=prompt)

    def register(self, registry: ToolRegistry) -> None:
        registry.register_alias("look", "Look")
        registry.register(
            ToolSpec(
                name="Look",
                description=(
                    "Describe a region of the frozen frame captured at gesture "
                    "time (vision escape hatch; historical pixels, not the live "
                    "screen — do not act or click based on it; for the current "
                    "UI state call Observe). The crop box is decided by "
                    "the anchor, never the full screen."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "anchor": {
                            "type": "string",
                            "description": (
                                "An exact referenceId from InputArtifact/Context.list "
                                "(reference:<snapshotId>:<index>), an element handle from "
                                "the element_handles fact (element:<ref>), or an explicit "
                                "'bbox:l,t,r,b' in physical screen pixels. Prefer a "
                                "reference or a handle: both come from what was actually "
                                "read, while a bbox is a coordinate you wrote down."
                            ),
                        },
                        "box": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "optional explicit crop box l,t,r,b",
                        },
                        "prompt": {"type": "string"},
                    },
                    "required": ["anchor"],
                },
                execute=self._execute_look,
                effect=Effect.READ,
                is_concurrency_safe=False,
                used_backend="vision",
                timeout_ms=self._timeout_ms,
            )
        )
