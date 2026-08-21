"""Harness perception-as-tools namespace (gap review L2 / L6).

The model pulls perception on demand instead of the harness pushing a
fixed packet: ``read_around`` / ``dump_subtree`` / ``find_in_window`` /
``list_windows`` / ``get_focused`` mirror the gap-review L2 tool list.

Every tool returns an :class:`Evidence` (L6 contract), never a bare value:

- backend raises :class:`BackendBusy` -> ``busy_evidence`` (did not read)
- backend returns ``None``/empty -> ``empty_confirmed`` (confirmed empty)
- backend success -> ``ok_evidence`` (or ``empty_confirmed`` when nothing
  readable); the container heuristic (L6) degrades values that merely
  repeat a container/control-type name
- backend timeouts raise :class:`ActionFailure` (TIMEOUT); any other
  backend failure is re-raised as ``ActionFailure`` (TOOL_ERROR). The
  registry layer wraps those into structured ToolResults.

The backend is injected (``PerceptionBackend`` protocol); this module is
pure Python and never touches the real desktop.
"""

from __future__ import annotations

import json
from typing import Any, Protocol, runtime_checkable

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.evidence.contract import (
    Evidence,
    EvidenceSource,
    apply_container_heuristic,
    busy_evidence,
    empty_confirmed,
    ok_evidence,
)

RADIUS_MIN = 1
RADIUS_MAX = 10
DEPTH_MIN = 1
DEPTH_MAX = 8

CONTAINER_LIKE_TEXTS = frozenset(
    {"Window", "Pane", "List", "Group", "Tree", "Tab", "Menu", "ScrollBar", "Edit"}
)
"""L6 anti-container heuristic set: control/container type names that must
never count as evidence content."""


class BackendBusy(Exception):
    """Backend perception worker is occupied; nothing was read."""


@runtime_checkable
class PerceptionBackend(Protocol):
    """Injected perception backend (fake in tests, real UIA/CDP host later)."""

    def read_around(self, anchor: str, radius: int) -> list[dict]:
        """Read text items around ``anchor`` (text/source/bbox_ltrb/confidence)."""
        ...

    def dump_subtree(self, anchor: str, depth: int) -> dict | None:
        """Structured accessibility subtree rooted at ``anchor``."""
        ...

    def find_in_window(self, pattern: str) -> list[dict]:
        """Text matches in the current window (text/bbox_ltrb)."""
        ...

    def list_windows(self) -> list[dict]:
        """Window table (hwnd/title/process_name/pid)."""
        ...

    def get_focused(self) -> dict | None:
        """Focused window descriptor, or None when nothing is focused."""
        ...


class PerceptionTools:
    """Evidence-returning facade over one injected :class:`PerceptionBackend`."""

    def __init__(self, backend: PerceptionBackend) -> None:
        self._backend = backend
        self.source = EvidenceSource.UIA

    # -- tools -------------------------------------------------------------

    def read_around(self, anchor: str, radius: int = 3, scope: object = None) -> Evidence:
        radius = _clamp_int(radius, RADIUS_MIN, RADIUS_MAX)
        try:
            items = self._backend.read_around(anchor=anchor, radius=radius)
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"read_around timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"read_around failed: {exc}") from exc
        if not items:
            return empty_confirmed(self.source)
        texts = [item.get("text") for item in items if isinstance(item, dict)]
        texts = [t for t in texts if isinstance(t, str) and t]
        joined = "\n".join(texts)
        if not joined.strip():
            return empty_confirmed(self.source)
        sources = {item.get("source") for item in items if isinstance(item, dict) and item.get("source")}
        note = f"{len(texts)} items from {len(sources)} source(s)"
        evidence = ok_evidence(joined, self.source, note=note)
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def dump_subtree(self, anchor: str, depth: int = 4, scope: object = None) -> Evidence:
        depth = _clamp_int(depth, DEPTH_MIN, DEPTH_MAX)
        try:
            tree = self._backend.dump_subtree(anchor=anchor, depth=depth)
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"dump_subtree timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"dump_subtree failed: {exc}") from exc
        if tree is None:
            return empty_confirmed(self.source)
        value, cycle, depth_capped = _serialize_tree(tree, depth)
        notes = []
        if cycle:
            notes.append("cycle detected, truncated")
        if depth_capped:
            notes.append(f"capped at depth {depth}")
        note = "; ".join(notes) if notes else None
        evidence = ok_evidence(value, self.source, note=note)
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def find_in_window(self, pattern: str, scope: object = None) -> Evidence:
        try:
            hits = self._backend.find_in_window(pattern=pattern)
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"find_in_window timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"find_in_window failed: {exc}") from exc
        if not hits:
            return empty_confirmed(self.source)
        rows = [
            {"text": hit.get("text"), "bbox_ltrb": hit.get("bbox_ltrb")}
            for hit in hits
            if isinstance(hit, dict) and hit.get("text")
        ]
        if not rows:
            return empty_confirmed(self.source)
        value = json.dumps(rows, ensure_ascii=False)
        evidence = ok_evidence(
            value, self.source, note=f"{len(rows)} match(es) for {pattern!r}"
        )
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def list_windows(self, scope: object = None) -> Evidence:
        try:
            windows = self._backend.list_windows()
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"list_windows timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"list_windows failed: {exc}") from exc
        if not windows:
            return empty_confirmed(self.source)
        value = json.dumps(windows, ensure_ascii=False)
        evidence = ok_evidence(
            value, self.source, note=f"{len(windows)} window(s)"
        )
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def get_focused(self, scope: object = None) -> Evidence:
        try:
            focused = self._backend.get_focused()
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"get_focused timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"get_focused failed: {exc}") from exc
        if focused is None:
            return empty_confirmed(self.source)
        value = json.dumps(focused, ensure_ascii=False)
        evidence = ok_evidence(value, self.source, note="focused window")
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    # -- registration ------------------------------------------------------

    def register_all(self, registry: ToolRegistry) -> None:
        """Register all five perception tools as model-usable ToolSpecs."""
        registry.register(
            ToolSpec(
                name="read_around",
                description=(
                    "Read text around an anchor point in the frozen snapshot "
                    "captured for this turn (historical state, not the live "
                    "screen — for the current state call get_app_state). "
                    "anchor is a stable element/anchor identifier; radius "
                    "controls how many surrounding items to include (1..10). "
                    "Returns the concatenated text of the read items."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "anchor": {"type": "string", "description": "stable anchor identifier"},
                        "radius": {"type": "integer", "description": "read radius, clamped to 1..10"},
                    },
                    "required": ["anchor"],
                },
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.read_around,
            )
        )
        registry.register(
            ToolSpec(
                name="dump_subtree",
                description=(
                    "Dump the structured accessibility subtree rooted at an "
                    "anchor in the frozen snapshot captured for this turn "
                    "(historical state — for the live UI call get_app_state). "
                    "depth controls how many levels to descend (clamped to "
                    "1..8). Cyclic data is truncated and noted."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "anchor": {"type": "string", "description": "stable anchor identifier"},
                        "depth": {"type": "integer", "description": "subtree depth, clamped to 1..8"},
                    },
                    "required": ["anchor"],
                },
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.dump_subtree,
            )
        )
        registry.register(
            ToolSpec(
                name="find_in_window",
                description=(
                    "Find text matching a pattern inside the frozen snapshot "
                    "captured for this turn (historical state — for the live "
                    "UI call get_app_state). Returns the matched texts with "
                    "their bounding boxes."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "text or regex pattern to find"},
                    },
                    "required": ["pattern"],
                },
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.find_in_window,
            )
        )
        registry.register(
            ToolSpec(
                name="list_windows",
                description=(
                    "List all top-level windows (hwnd, title, process_name, "
                    "pid) as a JSON table."
                ),
                input_schema={"type": "object", "properties": {}, "required": []},
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.list_windows,
            )
        )
        registry.register(
            ToolSpec(
                name="get_focused",
                description=(
                    "Return the currently focused window descriptor "
                    "(hwnd, title, process_name, pid) or empty when nothing "
                    "is focused."
                ),
                input_schema={"type": "object", "properties": {}, "required": []},
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.get_focused,
            )
        )


def evidence_to_text(evidence: Evidence) -> str:
    """Serialize an Evidence into model-readable tool-message text.

    The loop's message boundary calls this so the model reads
    ``{status, confidence, value, note}`` JSON instead of a dataclass repr.
    The Evidence object itself is untouched at the registry layer (full
    target-surface evidence is retained for fusion/decisions).
    """
    return json.dumps(
        {
            "status": evidence.status.value,
            "confidence": evidence.confidence,
            "value": evidence.value,
            "note": evidence.note,
        },
        ensure_ascii=False,
    )


def _clamp_int(value: object, lo: int, hi: int) -> int:
    """Clamp a caller-supplied integer into ``lo..hi`` (non-int -> lo)."""
    if not isinstance(value, int) or isinstance(value, bool):
        return lo
    return max(lo, min(hi, value))


def _serialize_tree(
    node: Any, depth_remaining: int, visited: set[int] | None = None
) -> tuple[str, bool, bool]:
    """Serialize a tree to compact JSON with depth cap and cycle truncation.

    Returns ``(value, cycle_detected, depth_capped)``. Cycles are detected by
    object identity of dict nodes; a repeated node is replaced by
    ``"[cycle]"``. Deeper levels are replaced by ``"[max_depth]"``.
    """
    if visited is None:
        visited = set()
    root = node
    cycle = False
    capped = False

    def walk(item: Any, level: int) -> Any:
        nonlocal cycle, capped
        if level > depth_remaining:
            capped = True
            return "[max_depth]"
        if isinstance(item, dict):
            ident = id(item)
            if ident in visited:
                cycle = True
                return "[cycle]"
            visited.add(ident)
            out = {k: walk(v, level + 1) for k, v in item.items()}
            visited.remove(ident)
            return out
        if isinstance(item, (list, tuple)):
            return [walk(v, level) for v in item]
        if item is None or isinstance(item, (str, int, float, bool)):
            return item
        return str(item)

    return json.dumps(walk(root, 1), ensure_ascii=False, sort_keys=True), cycle, capped
