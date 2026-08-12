"""Perception as a tool: the model-visible ``look`` escape hatch.

Implements harness-gap-review L2 (docs/harness-gap-review-20260812.md): vision
is an explicit, model-callable tool instead of an implicit cascade fallback.
The crop box is decided by the anchor (``bbox:l,t,r,b`` or ``element:<id>``
resolved through an injected resolver), never the full screen, and every result
is an :class:`Evidence` with honest status, latency and backend attribution.

The vision model itself is an injected :class:`VisionBackend` (Protocol); this
module performs no network or screen I/O and is fully testable with fakes.
"""

from __future__ import annotations

import json
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
DEFAULT_CAPABILITIES = ("translate", "explain", "expand", "summarize", "ocr_copy")
MIN_CAPABILITIES = 3
MAX_CAPABILITIES = 8


class VisionUnavailable(Exception):
    """The vision backend cannot serve requests at all (no model, no service)."""


class VisionTimeout(Exception):
    """The vision backend did not answer within the deadline."""


@runtime_checkable
class VisionBackend(Protocol):
    """Injected vision model contract.

    ``describe`` receives the already-cropped region bytes, the prompt and the
    deadline in ms, and returns ``{"text", "latency_ms", "backend"}``. It may
    raise :class:`VisionUnavailable` (-> Evidence unsupported),
    :class:`VisionTimeout` (-> Evidence timeout) or any other exception
    (-> Evidence error).
    """

    def describe(self, image_bytes: bytes, prompt: str, timeout_ms: int) -> dict[str, Any]:
        ...


def _box_bytes(box: tuple[int, int, int, int]) -> bytes:
    """Deterministic crop encoding for the harness phase.

    Real screen-region capture is a later phase; until then the crop bytes are
    derived from the box so the contract (backend receives exactly the box the
    anchor decided) is testable end to end.
    """
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
    """Model-callable vision: crop by anchor, honest Evidence out.

    ``look`` never guesses: a missing box with an anchor that cannot be
    resolved, or a box outside the configured size bounds, fails as
    ``Evidence(error)`` before any backend request. With ``backend=None`` the
    honest path is ``Evidence(unsupported, note='vision_not_configured')``
    without a single backend call.
    """

    def __init__(
        self,
        backend: VisionBackend | None,
        max_box_side: int = 4096,
        min_box_side: int = 32,
        timeout_ms: int = 30000,
        capture: Callable[[tuple[int, int, int, int]], bytes] | None = None,
    ) -> None:
        self._backend = backend
        self._max_box_side = max_box_side
        self._min_box_side = min_box_side
        self._timeout_ms = timeout_ms
        self._capture = capture if capture is not None else _box_bytes

    # -- look ----------------------------------------------------------------

    def look(
        self,
        anchor: str,
        box_ltrb: Sequence[int] | None = None,
        prompt: str | None = None,
        resolver: Callable[[str], Sequence[int] | None] | None = None,
    ) -> Evidence:
        """Describe the region the anchor decides; never the full screen.

        The explicit ``box_ltrb`` wins when given; otherwise the box comes from
        the anchor (``bbox:l,t,r,b`` parsed directly, ``element:<id>`` through
        the injected resolver). A box that cannot be produced or is outside
        ``[min_box_side, max_box_side]`` fails as error before any backend
        call — no guessing, no upscale-to-fullscreen.
        """
        if self._backend is None:
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.UNSUPPORTED,
                "vision_not_configured",
            )

        if box_ltrb is None:
            try:
                box = self._anchor_box(anchor, resolver)
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
        text_prompt = prompt if prompt is not None else DEFAULT_PROMPT
        try:
            result = self._backend.describe(image_bytes, text_prompt, self._timeout_ms)
        except VisionUnavailable:
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.UNSUPPORTED,
                "vision_unavailable",
            )
        except VisionTimeout:
            return failed_evidence(
                EvidenceSource.VISION, EvidenceStatus.TIMEOUT, "vision_timeout"
            )
        except Exception as exc:  # honest: any other backend failure is an error
            return failed_evidence(
                EvidenceSource.VISION,
                EvidenceStatus.ERROR,
                f"vision_error: {exc!r}",
            )

        text = result.get("text", "")
        latency = result.get("latency_ms")
        backend_name = result.get("backend", "unknown")
        note = f"backend={backend_name}; box={box[0]},{box[1]},{box[2]},{box[3]}"
        return ok_evidence(
            text,
            EvidenceSource.VISION,
            latency_ms=latency,
            note=note,
        )

    @staticmethod
    def _anchor_box(
        anchor: str,
        resolver: Callable[[str], Sequence[int] | None] | None,
    ) -> tuple[int, int, int, int]:
        """Turn an anchor into a crop box; raises ValueError with a note."""
        if anchor.startswith("bbox:"):
            parts = anchor[len("bbox:"):].split(",")
            if len(parts) != 4:
                raise ValueError("invalid_anchor_format")
            try:
                return tuple(int(part) for part in parts)  # type: ignore[return-value]
            except ValueError:
                raise ValueError("invalid_anchor_format") from None
        if anchor.startswith("element:"):
            if len(anchor) == len("element:"):
                raise ValueError("invalid_anchor_format")
            if resolver is None or not callable(resolver):
                raise ValueError("anchor_resolve_failed")
            box = resolver(anchor)
            if box is None:
                raise ValueError("anchor_resolve_failed")
            return _normalize_box(box)
        raise ValueError("invalid_anchor_format")

    # -- describe_capabilities ------------------------------------------------

    def describe_capabilities(
        self,
        anchor: str,
        trajectory_hints: Sequence[str] = (),
    ) -> Evidence:
        """List the actions available for the anchor's target.

        Trajectory hints take priority but the output stays within 3-8 entries
        (short hint lists are padded from the default catalog); with no hints
        the default catalog is returned.
        """
        chosen = self._chosen_capabilities(trajectory_hints)
        return ok_evidence(
            json.dumps(chosen),
            EvidenceSource.CACHE,
            note=f"capability-catalog; anchor={anchor}",
        )

    @staticmethod
    def _chosen_capabilities(hints: Sequence[str]) -> list[str]:
        chosen: list[str] = []
        for hint in hints:
            if hint not in chosen:
                chosen.append(hint)
        chosen = chosen[:MAX_CAPABILITIES]
        if not chosen:
            chosen = list(DEFAULT_CAPABILITIES)
        else:
            for candidate in DEFAULT_CAPABILITIES:
                if len(chosen) >= MIN_CAPABILITIES:
                    break
                if candidate not in chosen:
                    chosen.append(candidate)
        return chosen

    # -- registration ----------------------------------------------------------

    def _execute_look(
        self,
        anchor: str,
        box: Sequence[int] | None = None,
        prompt: str | None = None,
    ) -> Evidence:
        """Strict registry-facing adapter: schema field ``box`` maps to the
        public API parameter ``box_ltrb``. Unknown kwargs raise TypeError,
        which the registry wraps as tool_error (no silent drops)."""
        return self.look(anchor, box_ltrb=box, prompt=prompt)

    def register(self, registry: ToolRegistry) -> None:
        """Register ``look`` (read, not concurrency-safe: vision is slow and
        shares one backend, so no concurrent storm) and
        ``describe_capabilities`` (read, concurrency-safe)."""
        registry.register(
            ToolSpec(
                name="look",
                description=(
                    "Describe the screen region identified by an anchor (vision "
                    "escape hatch; the crop box is decided by the anchor, never "
                    "the full screen)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "anchor": {
                            "type": "string",
                            "description": "'bbox:l,t,r,b' or 'element:<id>'",
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
        registry.register(
            ToolSpec(
                name="describe_capabilities",
                description=(
                    "List the actions available for the target identified by "
                    "the anchor."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "anchor": {"type": "string"},
                        "trajectory_hints": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["anchor"],
                },
                execute=self.describe_capabilities,
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="local",
                timeout_ms=5000,
            )
        )
