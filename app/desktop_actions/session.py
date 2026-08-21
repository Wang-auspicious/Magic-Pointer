"""Desktop action session: snapshot, ownership, and the 13 Kimi CU tools."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
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
    ) -> None:
        self.driver = driver
        self.windows_probe = windows_probe
        self.elements_probe = elements_probe
        self.launcher = launcher
        self.uia_act = uia_act
        self.session_id = session_id
        self.ownership = ownership or InputOwnershipLock()
        self._snapshots: dict[str, _Snapshot] = {}

    def list_apps(self, **_: Any) -> str:
        apps = [_public_window(item) for item in self._windows()]
        return _dump({"apps": apps})

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
        target = _select_window(windows, window_id=window_id, pid=pid, app=app)
        if target is None:
            raise ActionFailure(FailureType.TOOL_ERROR, "window not found")
        hwnd = int(target.get("hwnd") or 0)
        elements: list[dict[str, Any]] = []
        if resolved in {"ax", "full", "text"}:
            elements = list(self.elements_probe(hwnd) or [])
        snapshot_id = uuid.uuid4().hex
        self._snapshots[snapshot_id] = _Snapshot(
            snapshot_id=snapshot_id,
            window=dict(target),
            windows=list(windows),
            elements=elements,
            mode=resolved,
        )
        return _dump({
            "snapshot_id": snapshot_id,
            "windows": [target],
            "elements": elements,
            "mode": resolved,
        })

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
        snap = self._require_snapshot(snapshot_id)
        self._require_input()
        point, _element = self._target_point(snap, index=index, x=x, y=y)
        self.driver.click(point, button=button or "left", count=int(count or 1))
        return _acted("foreground_click", matched=True, point=list(point))

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
        snap = self._require_snapshot(snapshot_id)
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
        snap = self._require_snapshot(snapshot_id)
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
        snap = self._require_snapshot(snapshot_id)
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
        snap = self._require_snapshot(snapshot_id)
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
        snap = self._require_snapshot(snapshot_id)
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
        snap = self._require_snapshot(snapshot_id)
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

    def _require_snapshot(self, snapshot_id: str | None) -> _Snapshot:
        if not snapshot_id or snapshot_id not in self._snapshots:
            raise ActionFailure(
                FailureType.STALE_SNAPSHOT,
                "snapshot_id is required and must be current",
                recovery_hint="call get_app_state again",
            )
        snap = self._snapshots[snapshot_id]
        live = _select_window(self._windows(), window_id=_window_id(snap.window))
        if live is None or _identity(live) != _identity(snap.window):
            raise ActionFailure(
                FailureType.STALE_SNAPSHOT,
                "window moved, resized, or changed process",
                recovery_hint="call get_app_state again",
            )
        return snap

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
) -> None:
    """Register Kimi's 13 Windows tools in whitelist order."""
    specs = (
        ToolSpec(
            name="list_apps",
            description="列出当前可见窗口（id/标题/pid）。只观察，不激活。列表空就说明没有可操作窗口。",
            input_schema=_EMPTY_SCHEMA,
            execute=session.list_apps,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="desktop",
        ),
        ToolSpec(
            name="launch_app",
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
            name="activate_window",
            description="把已有窗口提到前台。需要 window_id。失败则先 list_apps 核对窗口是否还在。",
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
            name="get_app_state",
            description=(
                "观察窗口、发 snapshot_id 和元素树，不激活。"
                "写操作必须带这个 id。窗口移动或 stale_snapshot 时重跑这一步。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "window_id": {"type": "string"},
                    "pid": {"type": "integer"},
                    "app": {"type": "string"},
                    "mode": {"type": "string", "description": "full | image | ax | text"},
                    "ax_filter": {"type": "string"},
                },
                "required": [],
            },
            execute=session.get_app_state,
            effect=Effect.READ,
            is_concurrency_safe=True,
            used_backend="desktop",
        ),
        ToolSpec(
            name="click",
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
            name="type_text",
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
            name="press_key",
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
            name="scroll",
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
            name="set_value",
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
            name="perform_secondary_action",
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
            name="select_text",
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
            name="drag",
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
        registry.register(spec)


def default_session(*, session_id: str = "loop") -> DesktopActionSession:
    """Production session: live window list, COM UIA tree/act, Win32 driver."""
    return DesktopActionSession(
        driver=_live_driver(),
        windows_probe=_live_windows,
        elements_probe=_live_elements,
        launcher=_live_launch,
        uia_act=_live_uia,
        session_id=session_id,
        ownership=process_input_lock(),
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


def _live_driver() -> Any:
    if os.name != "nt":
        return _UnavailableDriver()
    try:
        from app.computer_operator.windows import Win32InputDriver

        return Win32InputDriver()
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
        needle = str(app).casefold()
        for item in windows:
            process = str(item.get("process_name") or "").casefold()
            title = str(item.get("title") or "").casefold()
            if process == needle or title == needle:
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
