"""Provider-neutral computer-operation values.

The model may propose an intent, but only Magic Pointer creates a
``ComputerAction`` with an effect classification and a scoped ``SurfaceGrant``.
That keeps coordinates, permissions and verification outside the model.
"""

from __future__ import annotations

import enum
import math
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.agent_runtime.tool_registry import Effect


class ComputerActionKind(enum.StrEnum):
    CLICK = "click"
    DOUBLE_CLICK = "double_click"
    RIGHT_CLICK = "right_click"
    HOVER = "hover"
    DRAG = "drag"
    SCROLL = "scroll"
    TYPE_TEXT = "type_text"
    HOTKEY = "hotkey"
    KEY_DOWN = "key_down"
    KEY_UP = "key_up"
    WAIT = "wait"
    FINISH = "finish"
    REQUEST_USER = "request_user"


_POINT_KINDS = {
    ComputerActionKind.CLICK,
    ComputerActionKind.DOUBLE_CLICK,
    ComputerActionKind.RIGHT_CLICK,
    ComputerActionKind.HOVER,
}
_CONTROL_KINDS = {
    ComputerActionKind.FINISH,
    ComputerActionKind.REQUEST_USER,
}
_INPUT_KINDS = set(ComputerActionKind) - _CONTROL_KINDS - {ComputerActionKind.WAIT}


def _normalized_point(value: tuple[float, float] | None, *, field_name: str) -> None:
    if value is None:
        return
    if len(value) != 2:
        raise ValueError(f"{field_name} must contain x and y")
    if any(not math.isfinite(float(item)) or not 0.0 <= float(item) <= 1.0 for item in value):
        raise ValueError(f"{field_name} must use normalized coordinates in [0, 1]")


def _parse_utc(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise ValueError("timestamp must be ISO-8601") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must include a UTC offset")
    return parsed.astimezone(UTC)


def _sha256(value: str, *, field_name: str) -> None:
    clean = str(value or "")
    if len(clean) != 64 or any(char not in "0123456789abcdefABCDEF" for char in clean):
        raise ValueError(f"{field_name} must be a SHA-256 hex digest")


@dataclass(frozen=True, slots=True)
class ComputerAction:
    action_id: str
    kind: ComputerActionKind
    effect: Effect
    source_observation_id: str
    source_image_sha256: str
    start: tuple[float, float] | None = None
    end: tuple[float, float] | None = None
    text: str | None = None
    keys: tuple[str, ...] = ()
    scroll_delta: int = 0
    duration_ms: int = 0
    rationale: str = ""

    def __post_init__(self) -> None:
        if not str(self.action_id or "").strip():
            raise ValueError("action_id is required")
        if len(str(self.action_id)) > 240:
            raise ValueError("action_id exceeds 240 characters")
        if not str(self.source_observation_id or "").strip():
            raise ValueError("source_observation_id is required")
        if len(str(self.source_observation_id)) > 240:
            raise ValueError("source_observation_id exceeds 240 characters")
        _sha256(self.source_image_sha256, field_name="source_image_sha256")
        if not isinstance(self.kind, ComputerActionKind):
            raise TypeError("kind must be ComputerActionKind")
        if not isinstance(self.effect, Effect):
            raise TypeError("effect must be assigned by the core policy")
        if self.kind in _CONTROL_KINDS:
            raise ValueError(f"{self.kind.value} is a control intent, not an executable action")
        if self.kind in _INPUT_KINDS and self.effect is Effect.READ:
            raise ValueError(f"{self.kind.value} cannot be classified as read")
        _normalized_point(self.start, field_name="start")
        _normalized_point(self.end, field_name="end")
        if self.kind in _POINT_KINDS and self.start is None:
            raise ValueError(f"{self.kind.value} requires a start coordinate")
        if self.kind is ComputerActionKind.DRAG and (self.start is None or self.end is None):
            raise ValueError("drag requires start and end coordinates")
        if self.kind is ComputerActionKind.TYPE_TEXT and not str(self.text or ""):
            raise ValueError("text is required for type_text")
        if self.text is not None and len(str(self.text)) > 20_000:
            raise ValueError("text exceeds 20000 characters")
        if not isinstance(self.keys, tuple):
            raise TypeError("keys must be a tuple")
        if len(self.keys) > 8:
            raise ValueError("keys may contain at most 8 entries")
        if self.kind in {
            ComputerActionKind.HOTKEY,
            ComputerActionKind.KEY_DOWN,
            ComputerActionKind.KEY_UP,
        } and not self.keys:
            raise ValueError(f"keys are required for {self.kind.value}")
        if any(
            not isinstance(key, str)
            or not key.strip()
            or len(key) > 32
            for key in self.keys
        ):
            raise ValueError("keys must contain non-empty strings of at most 32 characters")
        if self.kind is ComputerActionKind.SCROLL and self.scroll_delta == 0:
            raise ValueError("scroll_delta must be non-zero for scroll")
        if self.kind is ComputerActionKind.SCROLL and self.start is None:
            raise ValueError("scroll requires a start coordinate")
        if not isinstance(self.scroll_delta, int) or isinstance(self.scroll_delta, bool):
            raise TypeError("scroll_delta must be an integer")
        if abs(self.scroll_delta) > 100:
            raise ValueError("scroll_delta must be between -100 and 100")
        if not isinstance(self.duration_ms, int) or isinstance(self.duration_ms, bool):
            raise TypeError("duration_ms must be an integer")
        if not 0 <= self.duration_ms <= 30_000:
            raise ValueError("duration_ms must be between 0 and 30000")
        if self.kind is ComputerActionKind.WAIT and not 1 <= int(self.duration_ms) <= 30_000:
            raise ValueError("wait duration_ms must be between 1 and 30000")
        if len(str(self.rationale or "")) > 4_000:
            raise ValueError("rationale exceeds 4000 characters")


@dataclass(frozen=True, slots=True)
class SurfaceGrant:
    """A bounded authority to operate one target surface, never the desktop."""

    grant_id: str
    surface_id: str
    source_frame_id: str
    source_frame_sha256: str
    bounds_ltrb: tuple[int, int, int, int]
    target_lease: dict[str, Any]
    allowed_effects: tuple[Effect, ...]
    expires_at: str

    @classmethod
    def from_leases(
        cls,
        frame_lease: dict[str, Any],
        target_lease: dict[str, Any],
        *,
        allowed_effects: tuple[Effect, ...],
    ) -> SurfaceGrant:
        """Compile one operator authority from matching frozen/live leases."""
        if frame_lease.get("schemaVersion") != 1:
            raise ValueError("invalid frame lease")
        if target_lease.get("schemaVersion") != 1:
            raise ValueError("invalid target lease")
        frame_window = frame_lease.get("targetWindow")
        target_window = target_lease.get("window")
        if not isinstance(target_window, dict) or not target_window:
            windows = target_lease.get("windows")
            target_window = (
                windows[0]
                if isinstance(windows, list) and windows and isinstance(windows[0], dict)
                else None
            )
        if not isinstance(frame_window, dict) or not isinstance(target_window, dict):
            raise ValueError("frame and target window identity are required")
        try:
            frame_identity = (
                int(frame_window.get("hwnd") or 0),
                int(frame_window.get("processId") or 0),
            )
            target_identity = (
                int(target_window.get("hwnd") or 0),
                int(target_window.get("processId") or 0),
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("frame and target window identity are invalid") from exc
        if (
            0 in frame_identity
            or 0 in target_identity
            or frame_identity != target_identity
        ):
            raise ValueError("frame and target window identity mismatch")
        raw_hash = str(frame_lease.get("contentHash") or "").strip()
        digest = raw_hash.removeprefix("sha256:")
        _sha256(digest, field_name="frame_lease.contentHash")
        bounds = frame_lease.get("surfaceBoundsPx")
        if not isinstance(bounds, (list, tuple)) or len(bounds) != 4:
            raise ValueError("frame lease surface bounds are invalid")
        frame_id = str(frame_lease.get("frameLeaseId") or "").strip()
        if not frame_id:
            raise ValueError("frame lease identity is required")
        expires_at = str(target_lease.get("expiresAt") or "").strip()
        if not expires_at:
            raise ValueError("target lease expiry is required")
        hwnd, process_id = frame_identity
        return cls(
            grant_id=str(uuid.uuid4()),
            surface_id=f"window:{hwnd}:{process_id}",
            source_frame_id=frame_id,
            source_frame_sha256=digest,
            bounds_ltrb=tuple(int(item) for item in bounds),
            target_lease=dict(target_lease),
            allowed_effects=tuple(allowed_effects),
            expires_at=expires_at,
        )

    def __post_init__(self) -> None:
        if not all(str(item or "").strip() for item in (
            self.grant_id,
            self.surface_id,
            self.source_frame_id,
        )):
            raise ValueError("grant, surface and source frame identities are required")
        _sha256(self.source_frame_sha256, field_name="source_frame_sha256")
        if len(self.bounds_ltrb) != 4:
            raise ValueError("bounds_ltrb must contain left, top, right and bottom")
        left, top, right, bottom = (int(item) for item in self.bounds_ltrb)
        if right <= left or bottom <= top:
            raise ValueError("surface bounds must have positive area")
        if not isinstance(self.target_lease, dict) or not self.target_lease:
            raise ValueError("target_lease is required")
        if not self.allowed_effects or any(not isinstance(item, Effect) for item in self.allowed_effects):
            raise ValueError("allowed_effects must contain core Effect values")
        _parse_utc(self.expires_at)

    def expired(self, *, now: datetime | None = None) -> bool:
        moment = (now or datetime.now(UTC)).astimezone(UTC)
        return moment >= _parse_utc(self.expires_at)


@dataclass(frozen=True, slots=True)
class OperatorObservation:
    observation_id: str
    surface_id: str
    image_ref: str
    image_sha256: str
    width: int
    height: int
    captured_at: str
    used_backend: str

    def __post_init__(self) -> None:
        if not all(str(item or "").strip() for item in (
            self.observation_id,
            self.surface_id,
            self.image_ref,
            self.used_backend,
        )):
            raise ValueError("observation identity, surface, image ref and backend are required")
        _sha256(self.image_sha256, field_name="image_sha256")
        if int(self.width) <= 0 or int(self.height) <= 0:
            raise ValueError("observation dimensions must be positive")
        _parse_utc(self.captured_at)


@dataclass(frozen=True, slots=True)
class OperatorBackendResult:
    """Untrusted provider result; the core adds post-action verification."""

    executed: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass(frozen=True, slots=True)
class OperatorActionReceipt:
    action_id: str
    grant_id: str
    executed: bool
    verified: bool
    used_backend: str
    latency_ms: float
    before: OperatorObservation | None = None
    after: OperatorObservation | None = None
    backend_data: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
