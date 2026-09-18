"""Desktop action session: snapshot, ownership, and the 13 Kimi CU tools."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

KIMI_WINDOWS_TOOLS = (
    "list_apps",
    "launch_app",
    "activate_window",
    "get_app_state",
    "click",
    "type_text",
    "press_key",
    "scroll",
    "set_value",
    "perform_secondary_action",
    "select_text",
    "drag",
    "turn_ended",
)

_EMPTY_SCHEMA = {"type": "object", "properties": {}, "required": []}
_WIN_TOKENS = frozenset({"win", "meta", "super", "lwin", "rwin", "lmeta", "rmeta"})
_REAL_INPUT_LOCK: InputOwnershipLock | None = None


class InputOwnershipLock:
    """One session may hold real mouse/keyboard/clipboard at a time."""

    def __init__(self) -> None:
        self._holder: str | None = None
        self._guard = threading.Lock()

    @property
    def holder(self) -> str | None:
        return self._holder

    def acquire(self, session_id: str, action: str | None = None) -> bool:
        del action
        with self._guard:
            if self._holder is None or self._holder == session_id:
                self._holder = session_id
                return True
            return False

    def release(self, session_id: str | None = None) -> None:
        with self._guard:
            if session_id is None or self._holder == session_id:
                self._holder = None


def process_input_lock() -> InputOwnershipLock:
    global _REAL_INPUT_LOCK
    if _REAL_INPUT_LOCK is None:
        _REAL_INPUT_LOCK = InputOwnershipLock()
    return _REAL_INPUT_LOCK


@dataclass
class _Snapshot:
    snapshot_id: str
    window: dict[str, Any]
    windows: list[dict[str, Any]]
    elements: list[dict[str, Any]]
    mode: str
    root_ref: str = ""


class DesktopActionSession:
    """Observe-then-act binding for one loop session.

    Drivers are injected. Tests pass fakes; production uses Win32 + window
    enumeration. Nothing here guesses a live desktop if a probe is missing.
    """

    def __init__(
        self,
        *,
        driver: Any,
        windows_probe: Callable[[], list[dict[str, Any]]],
        elements_probe: Callable[[int], list[dict[str, Any]]],
        launcher: Callable[[str], dict[str, Any]],
        uia_act: Callable[..., dict[str, Any]],
        session_id: str,
        ownership: InputOwnershipLock | None = None,
        origin_window_hwnd: int | None = None,
    ) -> None:
        self.driver = driver
        self.windows_probe = windows_probe
        self.elements_probe = elements_probe
        self.launcher = launcher
        self.uia_act = uia_act
        self.session_id = session_id
        self.ownership = ownership or InputOwnershipLock()
        # 这一轮是围绕哪个窗口发生的。用户划线圈的是终端里的一行，那么
        # 「不带参数地观察一下」就必须是观察那个终端——而不是此刻碰巧在前台
        # 的东西。真机 9·3：气泡弹出后终端失去前台，Observe 拿到了桌面，
        # 回答里于是出现了桌面上那四个快捷方式。
        self.origin_window_hwnd = int(origin_window_hwnd or 0) or None
        self._snapshots: dict[str, _Snapshot] = {}
        self._root_refs: dict[str, str] = {}
        self._root_by_ref: dict[str, str] = {}

    def _default_window(self, windows: list[dict[str, Any]]) -> dict[str, Any] | None:
        """The marked window, while it still exists."""
        if not self.origin_window_hwnd:
            return None
        for item in windows:
            if int(item.get("hwnd") or 0) == self.origin_window_hwnd:
                return item
        return None

    def list_apps(self, **_: Any) -> str:
        apps = [_public_window(item) for item in self._windows()]
        return _dump({"apps": apps})

    # ------------------------------------------------------------------
    # Pi computer-use parity surface.
    #
    # These methods deliberately sit on the existing DesktopActionSession:
    # they reuse its window admission, UIA normalization, snapshot staleness
    # checks, and input ownership instead of creating a second desktop truth.
    # A state id is the existing snapshot id; @r/@e refs are model-facing
    # projections over the same bounded snapshot.
    # ------------------------------------------------------------------

    def find_roots(
        self,
        text: str | None = None,
        app: str | None = None,
        pid: int | None = None,
        kind: str | None = None,
        **_: Any,
    ) -> str:
        roots: list[dict[str, Any]] = []
        query = str(text or "").strip().casefold()
        app_query = str(app or "").strip().casefold().removesuffix(".exe")
        for row in self._windows():
            title = str(row.get("title") or row.get("window_title") or "")
            process = str(row.get("process_name") or row.get("app") or "")
            row_pid = int(row.get("pid") or 0)
            hwnd = int(row.get("hwnd") or 0)
            if pid is not None and row_pid != int(pid):
                continue
            if query and query not in f"{title} {process}".casefold():
                continue
            if app_query and app_query not in process.casefold().removesuffix(".exe") and app_query not in title.casefold():
                continue
            root_kind = str(row.get("kind") or "window")
            if kind and root_kind != str(kind):
                continue
            root_ref = self._root_refs.setdefault(str(hwnd), f"@r{len(self._root_refs) + 1}")
            self._root_by_ref[root_ref] = str(hwnd)
            roots.append({
                "root_ref": root_ref,
                "kind": root_kind,
                "hwnd": hwnd,
                "window_id": _window_id(row),
                "pid": row_pid,
                "app": process or str(row.get("app") or "Unknown"),
                "title": title,
                "rect": row.get("rect") or row.get("bbox"),
                "focused": bool(row.get("focused") or row.get("is_focused")),
            })
        roots.sort(key=lambda item: (0 if item["focused"] else 1, str(item["title"])))
        return _dump({"roots": roots[:32], "total": len(roots)})

    def observe_ui(self, root: str | None = None, mode: str = "fused", **_: Any) -> str:
        target_window_id = None
        if root:
            hwnd = self._root_by_ref.get(str(root).strip())
            if hwnd is None:
                # Be forgiving for a restored/hand-written @r reference: root
                # discovery is cheap metadata and does not activate windows.
                self.find_roots()
                hwnd = self._root_by_ref.get(str(root).strip())
            if hwnd is None:
                raise ActionFailure(FailureType.STALE_SNAPSHOT, "root_ref is stale", recovery_hint="call find_roots again")
            target_window_id = f"w-{hwnd}"
        payload = json.loads(self.get_app_state(window_id=target_window_id, mode="ax" if mode != "visual" else "full"))
        snapshot_id = str(payload["snapshot_id"])
        snap = self._snapshots[snapshot_id]
        payload["state_id"] = snapshot_id
        payload["root_ref"] = snap.root_ref
        payload["mode"] = str(mode or "fused")
        payload["outline"] = [self._outline_node(item) for item in snap.elements]
        payload.pop("elements", None)
        return _dump(payload)

    def search_ui(
        self,
        state_id: str,
        text: str | None = None,
        role: str | None = None,
        capability: str | None = None,
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(state_id)
        query = str(text or "").strip().casefold()
        role_query = str(role or "").strip().casefold()
        cap_query = str(capability or "").strip().casefold()
        ranked: list[tuple[int, dict[str, Any]]] = []
        for item in snap.elements:
            label = " ".join(str(item.get(key) or "") for key in ("name", "value", "role"))
            haystack = label.casefold()
            if role_query and str(item.get("role") or "").casefold() != role_query:
                continue
            patterns = [str(value).casefold() for value in item.get("patterns") or []]
            if cap_query and not any(cap_query in value for value in patterns):
                continue
            if query:
                if haystack == query:
                    score = 0
                elif any(token.startswith(query) for token in haystack.split()):
                    score = 1
                elif query in haystack:
                    score = 2
                else:
                    continue
            else:
                score = 3
            ranked.append((score, item))
        ranked.sort(key=lambda pair: (pair[0], int(pair[1].get("index") or 0)))
        matches = [{"ref": self._element_ref(item), **self._outline_node(item)} for _, item in ranked[:32]]
        return _dump({"state_id": snap.snapshot_id, "matches": matches, "total_matches": len(ranked), "returned": len(matches)})

    def expand_ui(self, state_id: str, ref: str, depth: int = 3, **_: Any) -> str:
        snap = self._require_snapshot(state_id)
        item = self._element_for_ref(snap, ref)
        index = snap.elements.index(item)
        radius = max(0, min(8, int(depth or 3)))
        start = max(0, index - radius)
        end = min(len(snap.elements), index + radius + 1)
        return _dump({"state_id": snap.snapshot_id, "target": {"ref": self._element_ref(item), **self._outline_node(item)}, "outline": [self._outline_node(row, ref=self._element_ref(row)) for row in snap.elements[start:end]]})

    def inspect_ui(self, state_id: str, ref: str, **_: Any) -> str:
        snap = self._require_snapshot(state_id)
        item = self._element_for_ref(snap, ref)
        return _dump({"state_id": snap.snapshot_id, "target": {"ref": self._element_ref(item), **self._outline_node(item)}, "evidence": {"window_id": _window_id(snap.window), "hwnd": int(snap.window.get("hwnd") or 0), "mode": snap.mode}})

    def read_text(self, state_id: str, ref: str, **_: Any) -> str:
        snap = self._require_snapshot(state_id)
        item = self._element_for_ref(snap, ref)
        text = str(item.get("value") or item.get("name") or "")
        return _dump({"state_id": snap.snapshot_id, "ref": self._element_ref(item), "text": text, "used_backend": "uia.snapshot"})

    def wait_for(
        self,
        state_id: str,
        text: str | None = None,
        role: str | None = None,
        value: str | None = None,
        until: str = "present",
        timeout_ms: int = 10_000,
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(state_id)
        deadline = time.monotonic() + max(0.1, min(60.0, int(timeout_ms or 10_000) / 1000.0))
        target_window_id = _window_id(snap.window)
        found = False
        latest = snap
        while True:
            payload = json.loads(self.get_app_state(window_id=target_window_id, mode="ax"))
            latest = self._snapshots[str(payload["snapshot_id"])]
            found = self._condition_matches(latest.elements, text=text, role=role, value=value)
            if str(until or "present") == "absent":
                found = not found
            if found or time.monotonic() >= deadline:
                break
            time.sleep(min(0.15, max(0.0, deadline - time.monotonic())))
        return _dump({"state_id": latest.snapshot_id, "base_state_id": snap.snapshot_id, "found": found, "timed_out": not found, "text": text, "role": role, "value": value})

    def act_ui(self, state_id: str, actions: list[dict[str, Any]], expect: dict[str, Any] | None = None, **_: Any) -> str:
        snap = self._require_snapshot(state_id)
        if not isinstance(actions, list) or not actions or len(actions) > 20:
            raise ActionFailure(FailureType.TOOL_ERROR, "act_ui.actions must contain 1..20 actions")
        executed: list[dict[str, Any]] = []
        for action in actions:
            op = str(action.get("action") or "")
            ref = action.get("ref")
            index = self._index_for_ref(snap, str(ref)) if ref else None
            if op in {"click", "press"}:
                self.click(snapshot_id=snap.snapshot_id, index=index, x=action.get("x"), y=action.get("y"), button=str(action.get("button") or "left"), count=int(action.get("click_count") or 1))
            elif op == "setText":
                if index is None:
                    raise ActionFailure(FailureType.TOOL_ERROR, "setText requires ref")
                self.set_value(snapshot_id=snap.snapshot_id, index=index, value=str(action.get("text") or ""))
            elif op == "typeText":
                self.type_text(snapshot_id=snap.snapshot_id, text=str(action.get("text") or ""), index=index)
            elif op == "keypress":
                self.press_key(snapshot_id=snap.snapshot_id, keys="+".join(str(key) for key in action.get("keys") or []))
            elif op == "scroll":
                self.scroll(snapshot_id=snap.snapshot_id, index=index, x=action.get("x"), y=action.get("y"), dx=int(action.get("scroll_x") or 0), dy=int(action.get("scroll_y") or 0))
            elif op == "drag":
                path = action.get("path") or []
                if len(path) < 2:
                    raise ActionFailure(FailureType.TOOL_ERROR, "drag.path must contain 2 points")
                self.drag(snapshot_id=snap.snapshot_id, x=path[0].get("x"), y=path[0].get("y"), to_x=path[-1].get("x"), to_y=path[-1].get("y"))
            else:
                raise ActionFailure(FailureType.TOOL_ERROR, f"unsupported act_ui action {op!r}")
            executed.append({"action": op, "ref": ref})
        condition = dict(expect or {})
        if condition:
            post = json.loads(self.wait_for(snap.snapshot_id, timeout_ms=int(condition.get("timeout_ms") or 100), text=condition.get("text"), role=condition.get("role"), value=condition.get("value"), until=str(condition.get("until") or "present")))
            successor_snap = self._snapshots[str(post["state_id"])]
        else:
            successor = json.loads(self.get_app_state(window_id=_window_id(snap.window), mode="ax"))
            successor_snap = self._snapshots[str(successor["snapshot_id"])]
            post = {"status": "unavailable", "matched": False,
                    "state_id": successor_snap.snapshot_id, "reason": "no postcondition supplied"}
        changes = _snapshot_changes(snap.elements, successor_snap.elements)
        result = {"state_id": successor_snap.snapshot_id, "base_state_id": snap.snapshot_id, "view": "diff" if changes else "full", "changes": changes[:32], "executed": executed, "verification": post}
        if not changes:
            result["outline"] = [self._outline_node(item) for item in successor_snap.elements]
        return _dump(result)

    def _outline_node(self, item: dict[str, Any], *, ref: str | None = None) -> dict[str, Any]:
        return {"ref": ref or self._element_ref(item), "index": int(item.get("index") or 0), "role": str(item.get("role") or ""), "name": str(item.get("name") or ""), "value": str(item.get("value") or ""), "rect": item.get("rect"), "patterns": list(item.get("patterns") or [])}

    def _element_ref(self, item: dict[str, Any]) -> str:
        return f"@e{int(item.get('index') or 0)}"

    def _element_for_ref(self, snap: _Snapshot, ref: str) -> dict[str, Any]:
        clean = str(ref or "").strip()
        if clean.startswith("@e"):
            try:
                index = int(clean[2:])
            except ValueError:
                index = -1
        else:
            index = int(clean) if clean.isdigit() else -1
        for item in snap.elements:
            if int(item.get("index") or 0) == index:
                return item
        raise ActionFailure(FailureType.STALE_SNAPSHOT, f"element ref {ref!r} is stale", recovery_hint="call observe_ui again")

    def _index_for_ref(self, snap: _Snapshot, ref: str) -> int:
        return int(self._element_for_ref(snap, ref).get("index") or 0)

    @staticmethod
    def _condition_matches(rows: list[dict[str, Any]], *, text: str | None, role: str | None, value: str | None) -> bool:
        query = str(text or "").casefold()
        wanted_role = str(role or "").casefold()
        wanted_value = None if value is None else str(value)
        for row in rows:
            if query and query not in f"{row.get('name') or ''} {row.get('value') or ''}".casefold():
                continue
            if wanted_role and str(row.get("role") or "").casefold() != wanted_role:
                continue
            if wanted_value is not None and str(row.get("value") or "") != wanted_value:
                continue
            return True
        return False

    def launch_app(self, app: str = "", **_: Any) -> str:
        name = str(app or "").strip()
        if not _known_app(name):
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                f"unknown app {name!r}",
                recovery_hint="pass an .exe name or an existing path; unknown names must not open Explorer",
            )
        result = self.launcher(name)
        payload = dict(result) if isinstance(result, dict) else {"ok": True, "app": name}
        payload.setdefault("ok", True)
        payload.setdefault("app", name)
        return _dump(payload)

    def activate_window(self, window_id: str | None = None, **_: Any) -> str:
        self._require_input()
        target = _select_window(self._windows(), window_id=window_id)
        if target is None:
            raise ActionFailure(FailureType.TOOL_ERROR, "window not found")
        hwnd = int(target.get("hwnd") or 0)
        activate = getattr(self.driver, "activate", None)
        if callable(activate):
            activate(hwnd)
        return _dump({"ok": True, "hwnd": hwnd, "window_id": _window_id(target)})

    def get_app_state(
        self,
        window_id: str | None = None,
        pid: int | None = None,
        app: str | None = None,
        mode: str = "ax",
        ax_filter: str | None = None,
        **_: Any,
    ) -> str:
        del ax_filter
        resolved = str(mode or "ax")
        if resolved == "all":
            raise ActionFailure(FailureType.TOOL_ERROR, "mode 'all' is illegal")
        windows = self._windows()
        asked = bool(window_id or pid is not None or app)
        target = None
        if not asked:
            target = self._default_window(windows)
        if target is None:
            target = _select_window(windows, window_id=window_id, pid=pid, app=app)
        if target is None:
            raise ActionFailure(FailureType.TOOL_ERROR, "window not found")
        hwnd = int(target.get("hwnd") or 0)
        raw_elements: list[dict[str, Any]] = []
        if resolved in {"ax", "full", "text"}:
            raw_elements = list(self.elements_probe(hwnd) or [])
        elements, truncated = _compress_elements(raw_elements)
        snapshot_id = uuid.uuid4().hex
        root_ref = self._root_refs.setdefault(str(hwnd), f"@r{len(self._root_refs) + 1}")
        self._root_by_ref[root_ref] = str(hwnd)
        self._snapshots[snapshot_id] = _Snapshot(
            snapshot_id=snapshot_id,
            window=dict(target),
            windows=list(windows),
            elements=elements,
            mode=resolved,
            root_ref=root_ref,
        )
        payload: dict[str, Any] = {
            "snapshot_id": snapshot_id,
            "root_ref": root_ref,
            "windows": [target],
            "elements": elements,
            "mode": resolved,
        }
        # 说清楚这次读的是不是「用户圈的那个窗口」。读了别的窗口而不说，
        # 就是把另一块屏幕的内容当成用户问的那件事回答出去。
        if self.origin_window_hwnd:
            payload["is_origin_window"] = hwnd == self.origin_window_hwnd
            if not asked and hwnd != self.origin_window_hwnd:
                payload["origin_window_gone"] = True
        if truncated:
            payload["elements_truncated"] = truncated
        return _dump(payload)

    def click(
        self,
        snapshot_id: str | None = None,
        index: int | None = None,
        x: float | None = None,
        y: float | None = None,
        button: str = "left",
        count: int = 1,
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(snapshot_id, index=index)
        self._require_input()
        point, _element = self._target_point(snap, index=index, x=x, y=y)
        self.driver.click(point, button=button or "left", count=int(count or 1))
        result = _acted("foreground_click", matched=True, point=list(point))
        return self._with_changes_after(snap, result)

    def type_text(
        self,
        snapshot_id: str | None = None,
        text: str = "",
        index: int | None = None,
        x: float | None = None,
        y: float | None = None,
        clear: bool = False,
        submit: bool = False,
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(snapshot_id, index=index)
        self._require_input()
        element = None
        if index is not None or x is not None or y is not None:
            point, element = self._target_point(snap, index=index, x=x, y=y)
            self.driver.click(point, button="left", count=1)
        if clear:
            self._chord(("ctrl", "a"))
            self._tap("backspace")
        self.driver.type_text(str(text))
        verification = _unavailable()
        if element is not None:
            confirm = self.uia_act("read_value", element)
            if confirm.get("ok") and str(confirm.get("value") or "") == str(text):
                verification = _matched()
        submitted = False
        submit_skip_reason = None
        if submit:
            if verification["matched"]:
                self._tap("enter")
                submitted = True
            else:
                submit_skip_reason = "verification_unavailable"
        return _dump({
            "used_backend": "foreground_clipboard_paste",
            "verification": verification,
            "submitted": submitted,
            "submit_skip_reason": submit_skip_reason,
        })

    def press_key(self, snapshot_id: str | None = None, keys: str = "", **_: Any) -> str:
        self._require_snapshot(snapshot_id)
        self._require_input()
        tokens = _split_keys(keys)
        if any(_is_win_token(token) for token in tokens):
            raise ActionFailure(
                FailureType.PERMISSION_DENIED,
                "Win/Meta/Super chords are rejected",
                recovery_hint="use app-level shortcuts without the Win key",
            )
        self._chord(tokens)
        return _acted("foreground_key", matched=True, keys=keys)

    def scroll(
        self,
        snapshot_id: str | None = None,
        index: int | None = None,
        x: float | None = None,
        y: float | None = None,
        dx: int = 0,
        dy: int = 0,
        **_: Any,
    ) -> str:
        del dx
        snap = self._require_snapshot(snapshot_id, index=index)
        self._require_input()
        point, _element = self._target_point(snap, index=index, x=x, y=y)
        self.driver.scroll(point, delta=int(dy or 0))
        return _acted("foreground_wheel", matched=True, point=list(point), dy=int(dy or 0))

    def set_value(
        self,
        snapshot_id: str | None = None,
        index: int | None = None,
        value: str = "",
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(snapshot_id, index=index)
        self._require_input()
        element = _element_by_index(snap.elements, index)
        result = self.uia_act("value", element, str(value))
        if not result or not result.get("ok"):
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                "UIA Value pattern unsupported",
                recovery_hint="do not fake a click; use type_text if the field accepts keystrokes",
            )
        backend = str(result.get("backend") or "uia_value")
        return _acted(backend, matched=True)

    def perform_secondary_action(
        self,
        snapshot_id: str | None = None,
        index: int | None = None,
        action: str = "invoke",
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(snapshot_id, index=index)
        self._require_input()
        element = _element_by_index(snap.elements, index)
        name = str(action or "invoke")
        result = self.uia_act(name, element, None)
        if not result or not result.get("ok"):
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                f"unsupported secondary action {name!r}",
                recovery_hint="fall back to click/scroll/press_key only after this tool says unsupported",
            )
        backend = str(result.get("backend") or f"uia_{name}")
        return _acted(backend, matched=True)

    def select_text(
        self,
        snapshot_id: str | None = None,
        index: int | None = None,
        x: float | None = None,
        y: float | None = None,
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(snapshot_id, index=index)
        self._require_input()
        point, element = self._target_point(snap, index=index, x=x, y=y)
        if element is not None:
            result = self.uia_act("select", element, None)
            if result.get("ok"):
                return _acted(str(result.get("backend") or "uia_text"), matched=True)
        self.driver.click(point, button="left", count=1)
        self._chord(("ctrl", "a"))
        return _acted("foreground_ctrl_a", matched=True)

    def drag(
        self,
        snapshot_id: str | None = None,
        index: int | None = None,
        x: float | None = None,
        y: float | None = None,
        to_index: int | None = None,
        to_x: float | None = None,
        to_y: float | None = None,
        duration_ms: int = 0,
        **_: Any,
    ) -> str:
        snap = self._require_snapshot(
            snapshot_id,
            indexes=[i for i in (index, to_index) if i is not None],
        )
        self._require_input()
        start, _ = self._target_point(snap, index=index, x=x, y=y)
        end, _ = self._target_point(snap, index=to_index, x=to_x, y=to_y)
        self.driver.drag(start, end, duration_ms=int(duration_ms or 0))
        return _acted("foreground_drag", matched=True, start=list(start), end=list(end))

    def turn_ended(self, **_: Any) -> str:
        self.ownership.release(self.session_id)
        return _dump({"ok": True, "released": True})

    def _windows(self) -> list[dict[str, Any]]:
        return list(self.windows_probe() or [])

    def _require_input(self) -> None:
        if not self.ownership.acquire(self.session_id, "input"):
            raise ActionFailure(
                FailureType.COMPUTER_USE_BUSY,
                "computer_use_busy: another session holds real input",
                recovery_hint="retry after the other session calls turn_ended; do not bypass with shell",
            )

    def _require_snapshot(
        self,
        snapshot_id: str | None,
        *,
        index: int | None = None,
        indexes: Sequence[int] = (),
    ) -> _Snapshot:
        if not snapshot_id or snapshot_id not in self._snapshots:
            raise ActionFailure(
                FailureType.STALE_SNAPSHOT,
                "snapshot_id is required and must be current",
                recovery_hint="call Observe again",
            )
        snap = self._snapshots[snapshot_id]
        live = _select_window(self._windows(), window_id=_window_id(snap.window))
        if live is None or _identity(live) != _identity(snap.window):
            raise ActionFailure(
                FailureType.STALE_SNAPSHOT,
                "window moved, resized, or changed process",
                recovery_hint="call Observe again",
            )
        targets = tuple(indexes) if indexes else ((index,) if index is not None else ())
        if targets and snap.elements:
            for target_index in targets:
                self._require_unchanged_element(snap, live, int(target_index))
        return snap

    def _require_unchanged_element(
        self,
        snap: _Snapshot,
        live_window: dict[str, Any],
        index: int,
    ) -> None:
        """Re-probe the element an index action targets before acting.

        Window geometry alone does not prove the tree still matches: a list
        that replaced row 5 leaves hwnd/pid/rect untouched while ``index=5``
        now points at a different control. Kimi's snapshot contract binds an
        action to the observed element, so the element at that index must
        still carry the same role, name and rect; anything else is a new
        state and the caller must re-observe.
        """
        snapshotted = next(
            (
                item
                for item in snap.elements
                if int(item.get("index") or 0) == index
            ),
            None,
        )
        if snapshotted is None:
            return
        try:
            hwnd = int(live_window.get("hwnd") or 0)
            live_elements = list(self.elements_probe(hwnd) or [])
        except Exception as exc:
            raise ActionFailure(
                FailureType.STALE_SNAPSHOT,
                "element tree could not be re-read before acting",
                recovery_hint="call Observe again",
            ) from exc
        current = next(
            (
                item
                for item in live_elements
                if int(item.get("index") or 0) == index
            ),
            None,
        )
        # 指纹比较用同一视图：快照侧存的是压缩元素（长文本截断），live 侧
        # 不过同一把压缩就会在截断差异上报假 stale。
        current_view = _compress_elements([current])[0] if current else []
        if (
            current is None
            or not current_view
            or _element_fingerprint(current_view[0]) != _element_fingerprint(snapshotted)
        ):
            raise ActionFailure(
                FailureType.STALE_SNAPSHOT,
                f"element at index {index} changed since the snapshot was taken",
                recovery_hint="call Observe again",
            )

    def _target_point(
        self,
        snap: _Snapshot,
        *,
        index: int | None,
        x: float | None,
        y: float | None,
    ) -> tuple[tuple[int, int], dict[str, Any] | None]:
        has_index = index is not None
        has_xy = x is not None or y is not None
        if has_index and has_xy:
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                "pass exactly one of index or x/y coordinates",
            )
        if has_index:
            element = _element_by_index(snap.elements, index)
            return _rect_center(element["rect"]), element
        if x is None or y is None:
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                "pass index or both x and y",
            )
        return (int(x), int(y)), None

    def _with_changes_after(self, snap: _Snapshot, result: str) -> str:
        """点完必须再观察：click 直接带回元素变化摘要（省一轮 Observe）。

        UIA 树重探失败时静默省略——变化摘要是增益，不是新增失败面。
        """
        try:
            changes = self._changes_after(snap)
        except Exception:  # noqa: BLE001
            return result
        if not changes:
            return result
        try:
            payload = json.loads(result)
        except ValueError:
            return result
        payload["changes_after"] = changes
        return _dump(payload)

    def _changes_after(
        self, snap: _Snapshot, *, settle_s: float = 0.15, limit: int = 3
    ) -> list[dict[str, Any]]:
        time.sleep(settle_s)
        hwnd = int(snap.window.get("hwnd") or 0)
        live_raw = list(self.elements_probe(hwnd) or [])
        live, _truncated = _compress_elements(live_raw)

        def view(rows: list[dict[str, Any]]) -> dict[int, tuple[str, str]]:
            return {
                int(row.get("index") or 0): (str(row.get("role")), str(row.get("name")))
                for row in rows
            }

        before = view(snap.elements)
        after = view(live)
        changes: list[dict[str, Any]] = []
        for index in sorted(set(before) | set(after)):
            was = before.get(index)
            now = after.get(index)
            if was == now:
                continue
            changes.append({
                "index": index,
                "role": now[0] if now else "(gone)",
                "name": (now[1] if now else (was[1] if was else ""))[:60],
            })
            if len(changes) >= limit:
                break
        return changes

    def _chord(self, keys: tuple[str, ...] | list[str]) -> None:
        tokens = [str(key) for key in keys if str(key).strip()]
        for token in tokens:
            self.driver.key_down(token)
        for token in reversed(tokens):
            self.driver.key_up(token)

    def _tap(self, key: str) -> None:
        self.driver.key_down(key)
        self.driver.key_up(key)


def register_desktop_action_tools(
    registry: ToolRegistry,
    session: DesktopActionSession,
    *,
    observe_execute: Callable[..., Any] | None = None,
    observe_access_for: Callable[[dict[str, Any]], Any] | None = None,
) -> None:
    """Register Kimi's 13 Windows tools in whitelist order."""
    specs = (
        ToolSpec(
            name="find_roots",
            description="发现可操作的桌面窗口根节点，返回稳定 root_ref；不激活窗口。",
            input_schema={"type": "object", "properties": {"text": {"type": "string"}, "app": {"type": "string"}, "pid": {"type": "integer"}, "kind": {"type": "string"}}, "required": []},
            execute=session.find_roots,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="desktop",
        ),
        ToolSpec(
            name="observe_ui",
            description="对一个 root 建立不可变 state_id 和有界 UIA outline；后续查询/动作必须带同一状态。",
            input_schema={"type": "object", "properties": {"root": {"type": "string"}, "mode": {"type": "string"}}, "required": []},
            execute=session.observe_ui,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="uia.snapshot",
        ),
        ToolSpec(
            name="search_ui",
            description="在指定 state_id 的完整缓存树中按文字、role 或 capability 搜索，不重新抓屏。",
            input_schema={"type": "object", "properties": {"state_id": {"type": "string"}, "text": {"type": "string"}, "role": {"type": "string"}, "capability": {"type": "string"}}, "required": ["state_id"]},
            execute=session.search_ui,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="uia.snapshot",
        ),
        ToolSpec(
            name="expand_ui",
            description="展开 state_id 中一个 @e 元素的局部上下文。",
            input_schema={"type": "object", "properties": {"state_id": {"type": "string"}, "ref": {"type": "string"}, "depth": {"type": "integer"}}, "required": ["state_id", "ref"]},
            execute=session.expand_ui,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="uia.snapshot",
        ),
        ToolSpec(
            name="inspect_ui",
            description="检查一个 @e 的字段、几何、patterns 和来源证据。",
            input_schema={"type": "object", "properties": {"state_id": {"type": "string"}, "ref": {"type": "string"}}, "required": ["state_id", "ref"]},
            execute=session.inspect_ui,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="uia.snapshot",
        ),
        ToolSpec(
            name="read_text",
            description="读取 state_id 绑定的 @e 文本或值，不改变窗口。",
            input_schema={"type": "object", "properties": {"state_id": {"type": "string"}, "ref": {"type": "string"}}, "required": ["state_id", "ref"]},
            execute=session.read_text,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="uia.snapshot",
        ),
        ToolSpec(
            name="wait_for",
            description="等待有界 UI 条件出现/消失，使用 UIA 重读而不是盲目截图轮询。",
            input_schema={"type": "object", "properties": {"state_id": {"type": "string"}, "text": {"type": "string"}, "role": {"type": "string"}, "value": {"type": "string"}, "until": {"type": "string"}, "timeout_ms": {"type": "integer"}}, "required": ["state_id"]},
            execute=session.wait_for,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="uia.wait",
        ),
        ToolSpec(
            name="act_ui",
            description="基于一个 state_id 执行 1–20 个同一资源动作并返回 successor state/diff；过期状态拒绝执行。",
            input_schema={"type": "object", "properties": {"state_id": {"type": "string"}, "actions": {"type": "array"}, "expect": {"type": "object"}}, "required": ["state_id", "actions"]},
            execute=session.act_ui,
            effect=Effect.REVERSIBLE_WRITE,
            resource_keys=("real_input",),
            used_backend="desktop.transaction",
        ),
        ToolSpec(
            name="ListApps",
            description="列出当前可见窗口（id/标题/pid）。只观察，不激活。列表空就说明没有可操作窗口。",
            input_schema=_EMPTY_SCHEMA,
            execute=session.list_apps,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="desktop",
        ),
        ToolSpec(
            name="Launch",
            description="按已知 exe 名启动应用。未知名字直接失败，下一步换正确进程名；禁止打开资源管理器。",
            input_schema={
                "type": "object",
                "properties": {"app": {"type": "string"}},
                "required": ["app"],
            },
            execute=session.launch_app,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="desktop",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Focus",
            description="把已有窗口提到前台。需要 window_id。失败则先 ListApps 核对窗口是否还在。",
            input_schema={
                "type": "object",
                "properties": {"window_id": {"type": "string"}},
                "required": ["window_id"],
            },
            execute=session.activate_window,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="desktop",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Observe",
            description=(
                "实时观察窗口（live，当前状态），发 snapshot_id 和元素树，不激活。"
                "不带 window_id/pid/app 时观察的是本轮圈选所在的那个窗口，"
                "不是此刻恰好在前台的窗口；要看别的窗口必须显式指定。"
                "它与 look/read_around 的冻结帧证据（手势时刻的历史画面）不同。"
                "要用当前像素回答问题时传当前任务已绑定的 source_id 与 question；"
                "没有已绑定来源不会抓取屏幕。"
                "写操作必须带这个 id。窗口移动、目标元素变化或 stale_snapshot 时重跑这一步。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "window_id": {"type": "string"},
                    "pid": {"type": "integer"},
                    "app": {"type": "string"},
                    "mode": {"type": "string", "description": "full | image | ax | text"},
                    "ax_filter": {"type": "string"},
                    "source_id": {"type": "string", "description": "当前任务中已绑定的表面来源"},
                    "question": {"type": "string", "description": "要用新像素回答的问题"},
                    "locator": {"type": "object", "description": "可选的来源局部定位"},
                },
                "required": [],
            },
            execute=observe_execute or session.get_app_state,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="live_surface" if observe_execute is not None else "desktop",
            access_for=observe_access_for,
        ),
        ToolSpec(
            name="Click",
            description="按 index 或 x/y 点击（不可混传）。点成功不等于任务完成，必须再 get_app_state。snapshot 过期就重观察。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "index": {"type": "integer"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "button": {"type": "string"},
                    "count": {"type": "integer"},
                },
                "required": ["snapshot_id"],
            },
            execute=session.click,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="foreground_click",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Type",
            description="点中后输入文字，用当前值读回，匹配才 matched。读不回是 unavailable。写完必须再 get_app_state。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "text": {"type": "string"},
                    "index": {"type": "integer"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "clear": {"type": "boolean"},
                    "submit": {"type": "boolean"},
                },
                "required": ["snapshot_id", "text"],
            },
            execute=session.type_text,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="foreground_clipboard_paste",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Key",
            description="真实按键。禁止 Win/Meta/Super。失败则换应用内快捷键；按完再观察。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "keys": {"type": "string"},
                },
                "required": ["snapshot_id", "keys"],
            },
            execute=session.press_key,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="foreground_key",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Scroll",
            description="在 index 或坐标处滚动。dy>0 上、dy<0 下。滚完再 get_app_state。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "index": {"type": "integer"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "dx": {"type": "integer"},
                    "dy": {"type": "integer"},
                },
                "required": ["snapshot_id"],
            },
            execute=session.scroll,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="foreground_wheel",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="SetValue",
            description="原生 Value/RangeValue 写入。没有 pattern 就诚实失败，不要改成点击。成功仍要再观察。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "index": {"type": "integer"},
                    "value": {"type": "string"},
                },
                "required": ["snapshot_id", "index", "value"],
            },
            execute=session.set_value,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="uia_value",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Act",
            description="原生 invoke/expand/collapse/toggle/select。不支持就说不支持，下一步换观察或问用户。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "index": {"type": "integer"},
                    "action": {"type": "string"},
                },
                "required": ["snapshot_id", "index", "action"],
            },
            execute=session.perform_secondary_action,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="uia_invoke",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Select",
            description="优先用 TextPattern 选中文字，否则聚焦后 Ctrl+A。选完再观察。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "index": {"type": "integer"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                },
                "required": ["snapshot_id"],
            },
            execute=session.select_text,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="foreground_ctrl_a",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="Drag",
            description="两点之间拖拽，最后手段。拖完必须再 get_app_state。",
            input_schema={
                "type": "object",
                "properties": {
                    "snapshot_id": {"type": "string"},
                    "index": {"type": "integer"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "to_index": {"type": "integer"},
                    "to_x": {"type": "number"},
                    "to_y": {"type": "number"},
                    "duration_ms": {"type": "integer"},
                },
                "required": ["snapshot_id"],
            },
            execute=session.drag,
            effect=Effect.REVERSIBLE_WRITE,
            used_backend="foreground_drag",
            resource_keys=("real_input",),
        ),
        ToolSpec(
            name="turn_ended",
            description="回合结束释放真实输入锁。忙了或做完都要调，否则后续写入会 COMPUTER_USE_BUSY。",
            input_schema=_EMPTY_SCHEMA,
            execute=session.turn_ended,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="desktop",
        ),
    )
    for spec in specs:
        # Observation starts without a discovery round. Specialized actions
        # keep their complete contracts, loaded together when needed.
        registry.register(replace(spec, deferred=spec.name not in {"ListApps", "Observe"}))
    # 旧名别名（一个版本）：历史授权/旧调用仍路由到规范工具；别名不进 schema。
    registry.register_alias("list_apps", "ListApps")
    registry.register_alias("launch_app", "Launch")
    registry.register_alias("activate_window", "Focus")
    registry.register_alias("get_app_state", "Observe")
    registry.register_alias("click", "Click")
    registry.register_alias("type_text", "Type")
    registry.register_alias("press_key", "Key")
    registry.register_alias("scroll", "Scroll")
    registry.register_alias("set_value", "SetValue")
    registry.register_alias("perform_secondary_action", "Act")
    registry.register_alias("select_text", "Select")
    registry.register_alias("drag", "Drag")
    # loop 终态自动归还输入锁（COMPLETED/INTERRUPT/CRASH 都算）——模型
    # 忘调 turn_ended 不再卡死下一个会话。turn_ended 工具保留为"提前让锁"。
    try:
        registry.add_session_end_listener(session.turn_ended)
    except Exception:  # noqa: BLE001 - 钩子失败不拦工具注册
        pass


def default_session(
    *,
    session_id: str = "loop",
    origin_window_hwnd: int | None = None,
) -> DesktopActionSession:
    """Production session: live window list, COM UIA tree/act, Win32 driver."""
    return DesktopActionSession(
        driver=_live_driver(),
        windows_probe=_live_windows,
        elements_probe=_live_elements,
        launcher=_live_launch,
        uia_act=_live_uia,
        session_id=session_id,
        ownership=process_input_lock(),
        origin_window_hwnd=origin_window_hwnd,
    )


class _UnavailableDriver:
    def click(self, *args: Any, **kwargs: Any) -> None:
        raise ActionFailure(FailureType.TOOL_ERROR, "windows_input_unavailable")

    def drag(self, *args: Any, **kwargs: Any) -> None:
        raise ActionFailure(FailureType.TOOL_ERROR, "windows_input_unavailable")

    def scroll(self, *args: Any, **kwargs: Any) -> None:
        raise ActionFailure(FailureType.TOOL_ERROR, "windows_input_unavailable")

    def type_text(self, *args: Any, **kwargs: Any) -> None:
        raise ActionFailure(FailureType.TOOL_ERROR, "windows_input_unavailable")

    def key_down(self, *args: Any, **kwargs: Any) -> None:
        raise ActionFailure(FailureType.TOOL_ERROR, "windows_input_unavailable")

    def key_up(self, *args: Any, **kwargs: Any) -> None:
        raise ActionFailure(FailureType.TOOL_ERROR, "windows_input_unavailable")

    def activate(self, *args: Any, **kwargs: Any) -> None:
        raise ActionFailure(FailureType.TOOL_ERROR, "windows_input_unavailable")


def set_agent_cursor_sink(sink: Any) -> None:
    """Point the twin cursor at ``sink`` (anything with ``mark(phase, **fields)``).

    The storage lives in :mod:`app.computer_operator.agent_cursor_channel`
    because the visual computer-use backend builds its own driver and needs the
    same sink; this is a thin alias so the bridges have one obvious name to
    call.
    """
    from app.computer_operator.agent_cursor_channel import set_agent_cursor_sink as _set

    _set(sink)


def _live_driver() -> Any:
    if os.name != "nt":
        return _UnavailableDriver()
    try:
        from app.computer_operator.agent_cursor_channel import agent_cursor_observer
        from app.computer_operator.windows import Win32InputDriver

        # The observer is always attached and resolves the sink lazily.
        #
        # It used to be attached only when a sink was already set — but this
        # driver is constructed while the plugin tree boots, and the bridge sets
        # the sink hundreds of lines later, after it knows which clock it is
        # reporting on. So the check was always false and the cursor was
        # silently never announced from production, while the test (which set
        # the sink first) passed. A lazy lookup removes the ordering dependency
        # rather than depending on it.
        return Win32InputDriver(approach_observer=agent_cursor_observer())
    except Exception:
        return _UnavailableDriver()


def _live_windows() -> list[dict[str, Any]]:
    if os.name != "nt":
        return []
    from app.system_context import list_visible_windows

    rows = []
    for item in list_visible_windows():
        hwnd = int(item.get("hwnd") or 0)
        bounds = item.get("bbox") or item.get("rect") or (0, 0, 0, 0)
        rows.append({
            **item,
            "window_id": f"w-{hwnd}",
            "rect": [int(bounds[0]), int(bounds[1]), int(bounds[2]), int(bounds[3])],
        })
    return rows


def _live_elements(hwnd: int) -> list[dict[str, Any]]:
    from app.desktop_actions.uia import UiaBridge

    return UiaBridge().list_elements(int(hwnd or 0))


def _live_launch(app: str) -> dict[str, Any]:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.Popen([app], creationflags=flags)
    return {"ok": True, "app": app}


def _live_uia(action: str, element: dict[str, Any], value: str | None = None) -> dict[str, Any]:
    from app.desktop_actions.uia import UiaBridge

    return UiaBridge().act(action, element, value)


def _known_app(name: str) -> bool:
    if not name:
        return False
    path = Path(name)
    if path.suffix.lower() == ".exe":
        return True
    return path.is_file()


def _window_id(window: dict[str, Any]) -> str:
    explicit = window.get("window_id")
    if explicit:
        return str(explicit)
    return f"w-{int(window.get('hwnd') or 0)}"


def _public_window(window: dict[str, Any]) -> dict[str, Any]:
    return {
        "window_id": _window_id(window),
        "hwnd": window.get("hwnd"),
        "title": window.get("title"),
        "pid": window.get("pid"),
        "process_name": window.get("process_name"),
        "rect": _bounds(window),
    }


def _select_window(
    windows: list[dict[str, Any]],
    *,
    window_id: str | None = None,
    pid: int | None = None,
    app: str | None = None,
) -> dict[str, Any] | None:
    if window_id:
        wanted = str(window_id)
        hwnd_token = wanted[2:] if wanted.startswith("w-") else wanted
        for item in windows:
            if _window_id(item) == wanted or str(item.get("hwnd")) == hwnd_token:
                return item
        return None
    if pid is not None:
        wanted_pid = int(pid)
        for item in windows:
            if int(item.get("pid") or 0) == wanted_pid:
                return item
        return None
    if app:
        needle = str(app).casefold().strip()
        needle_exe = needle[:-4] if needle.endswith(".exe") else needle
        # 1) Exact process or title match.
        for item in windows:
            process = str(item.get("process_name") or "").casefold()
            title = str(item.get("title") or "").casefold()
            if process and process in (needle, needle_exe):
                return item
            if title == needle:
                return item
        # 2) Window class match. Win11 Notepad exposes an EMPTY
        # process_name with class "Notepad" — the real-machine turn-3 run
        # had app=Notepad/app=Notepad.exe fail as window-not-found while
        # the target sat right there.
        for item in windows:
            class_name = str(item.get("class_name") or "").casefold()
            if class_name and class_name in (needle, needle_exe):
                return item
        # 3) Title contains the app name (last resort; most ambiguous).
        for item in windows:
            title = str(item.get("title") or "").casefold()
            if needle_exe and needle_exe in title:
                return item
        return None
    return windows[0] if windows else None


def _bounds(window: dict[str, Any]) -> list[int]:
    raw = window.get("rect") or window.get("bbox") or (0, 0, 0, 0)
    return [int(raw[0]), int(raw[1]), int(raw[2]), int(raw[3])]


def _identity(window: dict[str, Any]) -> tuple[int, int, tuple[int, int, int, int]]:
    bounds = _bounds(window)
    return (
        int(window.get("hwnd") or 0),
        int(window.get("pid") or 0),
        (bounds[0], bounds[1], bounds[2], bounds[3]),
    )


def _element_by_index(elements: list[dict[str, Any]], index: int | None) -> dict[str, Any]:
    if index is None:
        raise ActionFailure(FailureType.TOOL_ERROR, "index is required")
    for item in elements:
        if int(item.get("index") or 0) == int(index):
            return item
    raise ActionFailure(FailureType.TOOL_ERROR, f"unknown index {index}")


def _element_fingerprint(element: dict[str, Any]) -> tuple[str, str, tuple[int, ...]]:
    """Semantic identity of one observed element (P4): role + name + rect.

    A replaced element at the same index (list refresh, renamed button)
    changes at least one of these; geometry-only identity cannot see it.
    """
    raw_rect = element.get("rect") or element.get("bbox") or (0, 0, 0, 0)
    try:
        rect = tuple(int(value) for value in raw_rect)
    except (TypeError, ValueError):
        rect = (0, 0, 0, 0)
    return (
        str(element.get("role") or element.get("type") or ""),
        str(element.get("name") or ""),
        rect,
    )


def _rect_center(rect: Any) -> tuple[int, int]:
    left, top, right, bottom = (int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3]))
    return ((left + right) // 2, (top + bottom) // 2)


def _split_keys(keys: str) -> list[str]:
    raw = str(keys or "").strip()
    if not raw:
        return []
    if "+" in raw or "-" in raw:
        return [part.strip() for part in raw.replace("-", "+").split("+") if part.strip()]
    return [raw]


def _is_win_token(token: str) -> bool:
    clean = token.strip().casefold()
    return clean in _WIN_TOKENS or clean.startswith("win")


_COMPRESS_TEXT_CAP = 80
_COMPRESS_MAX_ELEMENTS = 100


def _compress_elements(
    elements: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    """观察压缩（对照 Kimi/Anthropic computer-use 的 token 预算实践）：
    零面积剔除、同形状去重、长文本截断、100 上限。保留探针原 index——
    动作绑定与失效校验都按它对齐。"""
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, tuple[int, ...]]] = set()
    for item in elements:
        rect = item.get("rect")
        try:
            quad = tuple(int(v) for v in (rect or [0, 0, 0, 0]))
        except (TypeError, ValueError):
            quad = (0, 0, 0, 0)
        if len(quad) == 4 and (quad[2] - quad[0]) <= 1 and (quad[3] - quad[1]) <= 1:
            continue
        role = str(item.get("role") or "")
        name = str(item.get("name") or "")
        key = (role, name, quad)
        if key in seen:
            continue
        seen.add(key)
        slim = dict(item)
        if len(name) > _COMPRESS_TEXT_CAP:
            slim["name"] = name[:_COMPRESS_TEXT_CAP] + "…"
        value = slim.get("value")
        if isinstance(value, str) and len(value) > _COMPRESS_TEXT_CAP:
            slim["value"] = value[:_COMPRESS_TEXT_CAP] + "…"
        out.append(slim)
    truncated = 0
    if len(out) > _COMPRESS_MAX_ELEMENTS:
        truncated = len(out) - _COMPRESS_MAX_ELEMENTS
        out = out[:_COMPRESS_MAX_ELEMENTS]
    return out, truncated


def _snapshot_changes(before: list[dict[str, Any]], after: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Small deterministic successor diff for state-scoped act_ui results."""
    def view(rows: list[dict[str, Any]]) -> dict[int, tuple[str, str, str]]:
        return {
            int(row.get("index") or 0): (
                str(row.get("role") or ""),
                str(row.get("name") or ""),
                str(row.get("value") or ""),
            )
            for row in rows
            if int(row.get("index") or 0) > 0
        }
    old = view(before)
    new = view(after)
    changes: list[dict[str, Any]] = []
    for index in sorted(set(old) | set(new)):
        if old.get(index) == new.get(index):
            continue
        row = new.get(index) or old.get(index) or ("", "", "")
        changes.append({
            "ref": f"@e{index}",
            "index": index,
            "change": "added" if index not in old else "removed" if index not in new else "updated",
            "role": row[0],
            "name": row[1][:120],
            "value": row[2][:120],
        })
    return changes


def _dump(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _matched() -> dict[str, Any]:
    return {"matched": True, "status": "matched"}


def _unavailable() -> dict[str, Any]:
    return {"matched": False, "status": "unavailable"}


def _acted(backend: str, *, matched: bool, **extra: Any) -> str:
    payload = {
        "used_backend": backend,
        "verification": _matched() if matched else _unavailable(),
        **extra,
    }
    return _dump(payload)
