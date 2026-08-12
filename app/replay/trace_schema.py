"""DesktopTrace fixture schema (L12 of docs/harness-gap-review-20260812.md).

One trace records one real desktop interaction so the perception layer can run
fully offline against it: frames (PNG paths relative to the trace root), UIA
tree dumps, pointer samples, CDP dumps, focus events, display config and the
user's ground truth.

``from_dict`` is strict: required fields must exist, unknown fields are
rejected (ValueError), and ``schema_version`` must match SCHEMA_VERSION.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

SCHEMA_VERSION = 1

JsonDict = dict[str, Any]

POINTER_PHASES = frozenset({"down", "move", "up"})

_LTRB = tuple[int, int, int, int]


def _require(data: JsonDict, key: str, expected: type) -> Any:
    if key not in data:
        raise ValueError(f"missing required field: {key}")
    value = data[key]
    if value is not None and not isinstance(value, expected):
        raise ValueError(f"field {key!r} must be {expected.__name__}, got {type(value).__name__}")
    return value


def _reject_unknown(data: JsonDict, allowed: frozenset[str], where: str) -> None:
    unknown = [key for key in data if key not in allowed]
    if unknown:
        raise ValueError(f"unknown field(s) in {where}: {', '.join(sorted(unknown))}")


def _ltrb_from_json(value: Any, field_name: str) -> _LTRB:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError(f"{field_name} must contain exactly 4 integers")
    try:
        return tuple(int(item) for item in value)  # type: ignore[return-value]
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must contain exactly 4 integers") from None


def _ltrb_to_json(value: _LTRB) -> list[int]:
    return list(value)


def _optional_int(value: Any, field_name: str) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be an integer") from None


def _required_int(value: Any, field_name: str) -> int:
    if value is None:
        raise ValueError(f"missing required field: {field_name}")
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be an integer") from None


def _optional_float(value: Any, field_name: str) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be a number") from None


@dataclass(frozen=True)
class TraceFrame:
    """One frozen screen capture; png_path is relative to the trace root."""

    frame_id: str
    png_path: str
    captured_at_utc: str
    display_bounds_ltrb: _LTRB
    dpi: float | None = None
    scale_factor: float | None = None

    _FIELDS = frozenset(
        {"frame_id", "png_path", "captured_at_utc", "display_bounds_ltrb", "dpi", "scale_factor"}
    )

    def to_dict(self) -> JsonDict:
        return {
            "frame_id": self.frame_id,
            "png_path": self.png_path,
            "captured_at_utc": self.captured_at_utc,
            "display_bounds_ltrb": _ltrb_to_json(self.display_bounds_ltrb),
            "dpi": self.dpi,
            "scale_factor": self.scale_factor,
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "TraceFrame":
        _reject_unknown(data, cls._FIELDS, "TraceFrame")
        return cls(
            frame_id=str(_require(data, "frame_id", str)),
            png_path=str(_require(data, "png_path", str)),
            captured_at_utc=str(_require(data, "captured_at_utc", str)),
            display_bounds_ltrb=_ltrb_from_json(data["display_bounds_ltrb"], "display_bounds_ltrb"),
            dpi=_optional_float(data.get("dpi"), "dpi"),
            scale_factor=_optional_float(data.get("scale_factor"), "scale_factor"),
        )


@dataclass(frozen=True)
class PointerSample:
    """One raw pointer event at a physical screen coordinate."""

    t_utc: str
    x: int
    y: int
    phase: str
    buttons: int

    _FIELDS = frozenset({"t_utc", "x", "y", "phase", "buttons"})

    def to_dict(self) -> JsonDict:
        return {
            "t_utc": self.t_utc,
            "x": self.x,
            "y": self.y,
            "phase": self.phase,
            "buttons": self.buttons,
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "PointerSample":
        _reject_unknown(data, cls._FIELDS, "PointerSample")
        phase = str(_require(data, "phase", str))
        if phase not in POINTER_PHASES:
            raise ValueError(f"phase must be one of {sorted(POINTER_PHASES)}, got {phase!r}")
        buttons = _required_int(_require(data, "buttons", int), "buttons")
        if buttons < 0:
            raise ValueError("buttons must be a non-negative integer")
        return cls(
            t_utc=str(_require(data, "t_utc", str)),
            x=_required_int(_require(data, "x", int), "x"),
            y=_required_int(_require(data, "y", int), "y"),
            phase=phase,
            buttons=buttons,
        )


@dataclass(frozen=True)
class UiaSnapshot:
    """One UIA tree dump; tree_text inline or tree_path relative to trace root."""

    snapshot_id: str
    captured_at_utc: str
    tree_text: str | None = None
    tree_path: str | None = None
    window_hwnd: int | None = None
    pid: int | None = None
    note: str | None = None

    _FIELDS = frozenset(
        {"snapshot_id", "tree_text", "tree_path", "captured_at_utc", "window_hwnd", "pid", "note"}
    )

    def to_dict(self) -> JsonDict:
        return {
            "snapshot_id": self.snapshot_id,
            "tree_text": self.tree_text,
            "tree_path": self.tree_path,
            "captured_at_utc": self.captured_at_utc,
            "window_hwnd": self.window_hwnd,
            "pid": self.pid,
            "note": self.note,
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "UiaSnapshot":
        _reject_unknown(data, cls._FIELDS, "UiaSnapshot")
        tree_text = data.get("tree_text")
        tree_path = data.get("tree_path")
        if tree_text is None and tree_path is None:
            raise ValueError("UiaSnapshot requires either tree_text or tree_path")
        return cls(
            snapshot_id=str(_require(data, "snapshot_id", str)),
            tree_text=None if tree_text is None else str(tree_text),
            tree_path=None if tree_path is None else str(tree_path),
            captured_at_utc=str(_require(data, "captured_at_utc", str)),
            window_hwnd=_optional_int(data.get("window_hwnd"), "window_hwnd"),
            pid=_optional_int(data.get("pid"), "pid"),
            note=None if data.get("note") is None else str(data.get("note")),
        )


@dataclass(frozen=True)
class CdpSnapshot:
    """One Chrome DevTools Protocol text dump of the page under the gesture."""

    snapshot_id: str
    url: str
    text_dump: str
    captured_at_utc: str

    _FIELDS = frozenset({"snapshot_id", "url", "text_dump", "captured_at_utc"})

    def to_dict(self) -> JsonDict:
        return {
            "snapshot_id": self.snapshot_id,
            "url": self.url,
            "text_dump": self.text_dump,
            "captured_at_utc": self.captured_at_utc,
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "CdpSnapshot":
        _reject_unknown(data, cls._FIELDS, "CdpSnapshot")
        return cls(
            snapshot_id=str(_require(data, "snapshot_id", str)),
            url=str(_require(data, "url", str)),
            text_dump=str(_require(data, "text_dump", str)),
            captured_at_utc=str(_require(data, "captured_at_utc", str)),
        )


@dataclass(frozen=True)
class FocusEvent:
    """A window focus change observed while recording."""

    t_utc: str
    hwnd: int
    title: str
    process_name: str

    _FIELDS = frozenset({"t_utc", "hwnd", "title", "process_name"})

    def to_dict(self) -> JsonDict:
        return {
            "t_utc": self.t_utc,
            "hwnd": self.hwnd,
            "title": self.title,
            "process_name": self.process_name,
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "FocusEvent":
        _reject_unknown(data, cls._FIELDS, "FocusEvent")
        return cls(
            t_utc=str(_require(data, "t_utc", str)),
            hwnd=_required_int(_require(data, "hwnd", int), "hwnd"),
            title=str(_require(data, "title", str)),
            process_name=str(_require(data, "process_name", str)),
        )


@dataclass(frozen=True)
class DesktopTrace:
    """One replayable desktop interaction fixture (see L12 of the gap review)."""

    trace_id: str
    recorded_at_utc: str
    frames: list[TraceFrame] = field(default_factory=list)
    uia_snapshots: list[UiaSnapshot] = field(default_factory=list)
    pointer_trace: list[PointerSample] = field(default_factory=list)
    cdp_snapshots: list[CdpSnapshot] = field(default_factory=list)
    focus_events: list[FocusEvent] = field(default_factory=list)
    display_config: JsonDict = field(default_factory=dict)
    ground_truth: JsonDict | None = None
    schema_version: int = SCHEMA_VERSION

    _FIELDS = frozenset(
        {
            "schema_version",
            "trace_id",
            "recorded_at_utc",
            "frames",
            "uia_snapshots",
            "pointer_trace",
            "cdp_snapshots",
            "focus_events",
            "display_config",
            "ground_truth",
        }
    )

    def to_dict(self) -> JsonDict:
        return {
            "schema_version": self.schema_version,
            "trace_id": self.trace_id,
            "recorded_at_utc": self.recorded_at_utc,
            "frames": [frame.to_dict() for frame in self.frames],
            "uia_snapshots": [snapshot.to_dict() for snapshot in self.uia_snapshots],
            "pointer_trace": [sample.to_dict() for sample in self.pointer_trace],
            "cdp_snapshots": [snapshot.to_dict() for snapshot in self.cdp_snapshots],
            "focus_events": [event.to_dict() for event in self.focus_events],
            "display_config": dict(self.display_config),
            "ground_truth": None if self.ground_truth is None else dict(self.ground_truth),
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "DesktopTrace":
        _reject_unknown(data, cls._FIELDS, "DesktopTrace")
        version = data.get("schema_version", SCHEMA_VERSION)
        if version != SCHEMA_VERSION:
            raise ValueError(f"unsupported schema_version {version!r}, expected {SCHEMA_VERSION}")
        display_config = data.get("display_config")
        if display_config is None:
            display_config = {}
        if not isinstance(display_config, dict):
            raise ValueError(f"display_config must be a dict, got {type(display_config).__name__}")
        ground_truth = data.get("ground_truth")
        if ground_truth is not None and not isinstance(ground_truth, dict):
            raise ValueError(f"ground_truth must be a dict or null, got {type(ground_truth).__name__}")
        return cls(
            schema_version=int(version),
            trace_id=str(_require(data, "trace_id", str)),
            recorded_at_utc=str(_require(data, "recorded_at_utc", str)),
            frames=[TraceFrame.from_dict(item) for item in _require(data, "frames", list) or []],
            uia_snapshots=[
                UiaSnapshot.from_dict(item) for item in _require(data, "uia_snapshots", list) or []
            ],
            pointer_trace=[
                PointerSample.from_dict(item) for item in _require(data, "pointer_trace", list) or []
            ],
            cdp_snapshots=[
                CdpSnapshot.from_dict(item) for item in _require(data, "cdp_snapshots", list) or []
            ],
            focus_events=[FocusEvent.from_dict(item) for item in _require(data, "focus_events", list) or []],
            display_config=display_config,
            ground_truth=ground_truth,
        )
